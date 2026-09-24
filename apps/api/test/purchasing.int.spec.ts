/**
 * Phase 2.3 acceptance: a clerk creates a vendor, opens a PO with two
 * lines, receives one line in full + the other partially, then closes
 * the PO with a final receipt that flips it to 'received'. Inventory
 * levels track every receipt; the audit trail captures each
 * transition.
 *
 * Also covers role-gated access (cashier can't create POs), the
 * vendor delete-with-PO refusal, and partial-receipt validation.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';
import { JOB_REGISTRY } from '../src/jobs/jobs.service';
import { GlDerivationService } from '../src/gl/gl-derivation.service';

const TEST_DB_URL =
  process.env.PURCHASING_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_purchasing';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'PurchPass!2026';

let app: INestApplication;
let businessId = '';
let locationId = '';
let variantAId = '';
let variantBId = '';
let clerkCookie = '';
let cashierCookie = '';
let managerCookie = '';
let ownerCookie = '';

async function resetTestDb() {
  const env = { ...process.env, DATABASE_URL: TEST_DB_URL };
  execFileSync(
    process.execPath,
    [join(dbPackageRoot, 'node_modules/tsx/dist/cli.mjs'), 'src/reset.ts'],
    {
      cwd: dbPackageRoot,
      env,
      stdio: 'inherit',
    },
  );
  execFileSync(
    process.execPath,
    [join(dbPackageRoot, 'node_modules/tsx/dist/cli.mjs'), 'src/migrate.ts'],
    {
      cwd: dbPackageRoot,
      env,
      stdio: 'inherit',
    },
  );
}

async function seed() {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'purch-test', name: 'Purchasing Test Co', status: 'active' })
      .returning();
    businessId = biz!.id;

    const roles = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      const [r] = await db
        .insert(schema.roles)
        .values({ businessId, name: role.name, description: role.description, isSystem: true })
        .returning();
      roles.set(role.name, r!.id);
      if (role.permissions.length > 0) {
        await db
          .insert(schema.rolePermissions)
          .values(role.permissions.map((permission) => ({ roleId: r!.id, permission })));
      }
    }
    async function makeUser(email: string, role: string): Promise<void> {
      const [u] = await db
        .insert(schema.users)
        .values({ email, emailVerified: true, name: role })
        .returning();
      await db.insert(schema.accounts).values({
        accountId: u!.id,
        providerId: 'credential',
        userId: u!.id,
        password: passwordHash,
      });
      await db.insert(schema.memberships).values({
        businessId,
        userId: u!.id,
        roleId: roles.get(role)!,
        status: 'active',
        acceptedAt: new Date(),
      });
    }
    await makeUser('owner@purch-test.local', 'Owner');
    await makeUser('clerk@purch-test.local', 'Warehouse');
    await makeUser('cashier@purch-test.local', 'Cashier');
    await makeUser('manager@purch-test.local', 'Manager');

    const [loc] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Main', timezone: 'America/New_York' })
      .returning();
    locationId = loc!.id;
    const [pA] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'WIDGET', name: 'Widget' })
      .returning();
    const [vA] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: pA!.id, sku: 'WIDGET-1', priceCents: 1000 })
      .returning();
    variantAId = vA!.id;
    const [pB] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'GADGET', name: 'Gadget' })
      .returning();
    const [vB] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: pB!.id, sku: 'GADGET-1', priceCents: 500 })
      .returning();
    variantBId = vB!.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function captureCookie(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .send({ email, password: PASSWORD })
    .expect(200);
  const cookies = res.get('Set-Cookie') ?? [];
  const sessionCookie = cookies
    .map((c) => c.split(';')[0])
    .filter((c): c is string => Boolean(c?.startsWith('jetnine.session_token=')))
    .find((c) => !c.endsWith('='));
  if (!sessionCookie) throw new Error(`no session cookie for ${email}`);
  return sessionCookie;
}

async function levelOf(variantId: string): Promise<number> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const [row] = await db
      .select()
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, variantId),
          eq(schema.inventoryLevels.locationId, locationId),
        ),
      );
    return row?.onHand ?? 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'purch-test-secret-purch-test-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();

  ownerCookie = await captureCookie('owner@purch-test.local');
  clerkCookie = await captureCookie('clerk@purch-test.local');
  cashierCookie = await captureCookie('cashier@purch-test.local');
  managerCookie = await captureCookie('manager@purch-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Phase 2.3 — Vendors & Purchase Orders', () => {
  let vendorId = '';
  it('Clerk creates a vendor', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/vendors')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'ACME Supply', email: 'sales@acme.example', phone: '555-0100' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('ACME Supply');
    vendorId = res.body.id;
  });

  it('Duplicate vendor name returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/vendors')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'ACME Supply' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already exists/);
  });

  it('Cashier (no purchase_orders.create) is denied PO creation', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/purchase-orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        vendorId,
        locationId,
        lines: [{ variantId: variantAId, quantity: 1, unitCostCents: 100 }],
      });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/purchase_orders\.create/);
  });

  let poId = '';
  let widgetLineId = '';
  let gadgetLineId = '';
  it('Clerk creates a PO with two lines (10 widgets + 4 gadgets)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/purchase-orders')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        vendorId,
        locationId,
        notes: 'Initial restock',
        lines: [
          { variantId: variantAId, quantity: 10, unitCostCents: 400 },
          { variantId: variantBId, quantity: 4, unitCostCents: 200 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ordered');
    expect(res.body.subtotalCents).toBe(10 * 400 + 4 * 200);
    expect(res.body.number).toMatch(/^PO-\d{4}-\d{6}$/);
    expect(res.body.lines).toHaveLength(2);
    poId = res.body.id;
    widgetLineId = res.body.lines.find((l: { variantId: string }) => l.variantId === variantAId).id;
    gadgetLineId = res.body.lines.find((l: { variantId: string }) => l.variantId === variantBId).id;
  });

  it('Receive 6 widgets — PO becomes partially_received and inventory grows', async () => {
    const before = await levelOf(variantAId);
    const res = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: widgetLineId, quantity: 6 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('partially_received');
    const widgetLine = res.body.lines.find((l: { id: string }) => l.id === widgetLineId);
    expect(widgetLine.quantityReceived).toBe(6);
    expect(await levelOf(variantAId)).toBe(before + 6);
  });

  it('Cannot over-receive a line (10 ordered, 6 already received → 5 more is too many)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: widgetLineId, quantity: 5 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only 4 remaining/);
  });

  it('Receive remaining 4 widgets + all 4 gadgets — PO flips to received', async () => {
    const widgetBefore = await levelOf(variantAId);
    const gadgetBefore = await levelOf(variantBId);
    const res = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        lines: [
          { lineId: widgetLineId, quantity: 4 },
          { lineId: gadgetLineId, quantity: 4 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');
    expect(res.body.closedAt).toBeTruthy();
    expect(await levelOf(variantAId)).toBe(widgetBefore + 4);
    expect(await levelOf(variantBId)).toBe(gadgetBefore + 4);
  });

  it('Inventory ledger has receive_po movements pointing at the PO', async () => {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    try {
      const movements = await db
        .select()
        .from(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.referenceId, poId));
      expect(movements.length).toBe(3); // 6 widgets + 4 widgets + 4 gadgets
      expect(movements.every((m) => m.reason === 'receive_po')).toBe(true);
      expect(movements.every((m) => m.referenceType === 'purchase_order')).toBe(true);
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  it('Receiving against a fully-received PO is forbidden', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: widgetLineId, quantity: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Cannot receive against a received/);
  });

  it('Owner cancels a different draft PO; cancel sets status=canceled', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/purchase-orders')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        vendorId,
        locationId,
        place: false,
        lines: [{ variantId: variantAId, quantity: 1, unitCostCents: 400 }],
      });
    expect(created.body.status).toBe('draft');

    const res = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${created.body.id}/cancel`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('canceled');
  });

  it('Vendor delete is refused while a PO references it', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/v1/vendors/${vendorId}`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/existing purchase orders/);
  });
});

describe('Reorder automation', () => {
  let restockVendorId = '';
  let lowVariantId = '';

  it('Setup: vendor + a managed variant with zero stock', async () => {
    const vendor = await request(app.getHttpServer())
      .post('/v1/vendors')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Restock Co' });
    expect(vendor.status).toBe(201);
    restockVendorId = vendor.body.id;

    const product = await request(app.getHttpServer())
      .post('/v1/products')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        name: 'Managed Pillow',
        sku: 'PILLOW',
        variants: [{ sku: 'PILLOW-1', priceCents: 4900, costCents: 1500 }],
      });
    expect(product.status).toBe(201);
    lowVariantId = product.body.variants[0].id;

    const patch = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${lowVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ reorderPoint: 5, reorderQty: 12, preferredVendorId: restockVendorId });
    expect(patch.status).toBe(200);
    expect(patch.body.reorderPoint).toBe(5);
    expect(patch.body.reorderQty).toBe(12);
    expect(patch.body.preferredVendorId).toBe(restockVendorId);
  });

  it('Zero stock at point 5 → suggested under its vendor with reorderQty', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/purchase-orders/reorder-suggestions')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const group = res.body.vendors.find(
      (g: { vendorId: string | null }) => g.vendorId === restockVendorId,
    );
    expect(group).toBeTruthy();
    const line = group.lines.find((l: { variantId: string }) => l.variantId === lowVariantId);
    expect(line).toBeTruthy();
    expect(line.available).toBe(0);
    expect(line.reorderPoint).toBe(5);
    expect(line.suggestedQty).toBe(12); // explicit reorderQty wins
    expect(line.unitCostCents).toBe(1500);
  });

  it('A new PO line starts at the catalog cost (unit-costs lookup)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/purchase-orders/unit-costs?variantIds=${lowVariantId},${lowVariantId}`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(res.body).toEqual([{ variantId: lowVariantId, unitCostCents: 1500 }]);
    await request(app.getHttpServer())
      .get('/v1/purchase-orders/unit-costs?variantIds=not-a-uuid')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .expect(400);
    // Cost is purchasing data: a cashier without purchase_orders.create is refused.
    await request(app.getHttpServer())
      .get(`/v1/purchase-orders/unit-costs?variantIds=${lowVariantId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(403);
  });

  it('Without an explicit qty, suggestion tops up to 2× the point', async () => {
    const patch = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${lowVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ reorderQty: null });
    expect(patch.status).toBe(200);

    const res = await request(app.getHttpServer())
      .get('/v1/purchase-orders/reorder-suggestions')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId);
    const group = res.body.vendors.find(
      (g: { vendorId: string | null }) => g.vendorId === restockVendorId,
    );
    const line = group.lines.find((l: { variantId: string }) => l.variantId === lowVariantId);
    expect(line.suggestedQty).toBe(10); // 2×5 − 0
  });

  it('Clearing the reorder point removes the variant from suggestions', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/products/variants/${lowVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ reorderPoint: null })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/v1/purchase-orders/reorder-suggestions')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId);
    const all = res.body.vendors.flatMap((g: { lines: { variantId: string }[] }) => g.lines);
    expect(all.find((l: { variantId: string }) => l.variantId === lowVariantId)).toBeUndefined();
  });

  it('Rejects negative points and unknown vendors', async () => {
    const neg = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${lowVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ reorderPoint: -1 });
    expect(neg.status).toBe(400);

    const badVendor = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${lowVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ preferredVendorId: '00000000-0000-4000-8000-000000000000' });
    expect(badVendor.status).toBe(404);
  });

  it('Vendor SKU: saved (trimmed), surfaces in suggestions and PO lines, clears with null', async () => {
    // The vendor's part number differs from our Shopify-style SKU.
    const patch = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${lowVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ reorderPoint: 5, vendorSku: '  RC-PLW-0099  ' });
    expect(patch.status).toBe(200);
    expect(patch.body.vendorSku).toBe('RC-PLW-0099');

    const suggestions = await request(app.getHttpServer())
      .get('/v1/purchase-orders/reorder-suggestions')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId);
    const line = suggestions.body.vendors
      .flatMap((g: { lines: { variantId: string; vendorSku: string | null }[] }) => g.lines)
      .find((l: { variantId: string }) => l.variantId === lowVariantId);
    expect(line.vendorSku).toBe('RC-PLW-0099');

    // A PO for this variant carries the vendor part number on its lines.
    const po = await request(app.getHttpServer())
      .post('/v1/purchase-orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        vendorId: restockVendorId,
        locationId,
        lines: [{ variantId: lowVariantId, quantity: 3, unitCostCents: 1500 }],
      });
    expect(po.status).toBe(201);
    const detail = await request(app.getHttpServer())
      .get(`/v1/purchase-orders/${po.body.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(detail.status).toBe(200);
    expect(detail.body.lines[0].vendorSku).toBe('RC-PLW-0099');
    expect(detail.body.lines[0].sku).toBe('PILLOW-1');
    // The printable vendor document's header block.
    expect(detail.body.vendorName).toBe('Restock Co');
    expect(detail.body.locationName).toBeTruthy();
    expect(detail.body).toHaveProperty('vendorEmail');
    expect(detail.body).toHaveProperty('vendorPhone');

    // Explicit null clears it; empty/oversized strings are rejected.
    const cleared = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${lowVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ vendorSku: null, reorderPoint: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.vendorSku).toBeNull();

    const blank = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${lowVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ vendorSku: '   ' });
    expect(blank.status).toBe(400);
  });
});

describe('Receiving stages + PO email + invoice matching (PLAN-POS-OPERATIONS P6)', () => {
  let vendorId = '';
  let poId = '';
  let poNumber = '';
  let lineId = '';

  function owner() {
    return {
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
      patch: (url: string) =>
        request(app.getHttpServer())
          .patch(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
    };
  }

  it('sets the stage: vendor with email, a placed 5-unit PO', async () => {
    const vendor = await owner()
      .post('/v1/vendors')
      .send({ name: 'Stage Vendor', email: 'orders@stagevendor.test' });
    expect(vendor.status).toBe(201);
    vendorId = vendor.body.id;

    const po = await owner()
      .post('/v1/purchase-orders')
      .send({
        vendorId,
        locationId,
        lines: [{ variantId: variantAId, quantity: 5, unitCostCents: 1000 }],
      });
    expect(po.status).toBe(201);
    poId = po.body.id;
    poNumber = po.body.number;
    lineId = po.body.lines[0].id;
    expect(po.body.lines[0].quantityInspected).toBe(0);
    expect(po.body.lines[0].quantityAccepted).toBe(0);
  });

  it('dock receipt and inspection move no stock; acceptance does', async () => {
    const before = await levelOf(variantAId);

    const dock = await owner()
      .post(`/v1/purchase-orders/${poId}/receiving`)
      .send({ lines: [{ lineId, received: 3 }] });
    expect(dock.status).toBe(201);
    expect(dock.body.status).toBe('partially_received');
    expect(dock.body.lines[0].quantityReceived).toBe(3);
    expect(await levelOf(variantAId)).toBe(before); // nothing sellable yet

    const inspected = await owner()
      .post(`/v1/purchase-orders/${poId}/receiving`)
      .send({ lines: [{ lineId, inspected: 3, accepted: 2 }] });
    expect(inspected.status).toBe(201);
    expect(inspected.body.lines[0].quantityInspected).toBe(3);
    expect(inspected.body.lines[0].quantityAccepted).toBe(2);
    expect(await levelOf(variantAId)).toBe(before + 2); // accepted units only
  });

  it('stage invariants hold: no accepting past inspected, no receiving past ordered', async () => {
    const overAccept = await owner()
      .post(`/v1/purchase-orders/${poId}/receiving`)
      .send({ lines: [{ lineId, accepted: 2 }] }); // accepted would be 4 > inspected 3
    expect(overAccept.status).toBe(400);
    expect(overAccept.body.message).toMatch(/more units than have been inspected/);

    const overReceive = await owner()
      .post(`/v1/purchase-orders/${poId}/receiving`)
      .send({ lines: [{ lineId, received: 3 }] }); // received would be 6 > ordered 5
    expect(overReceive.status).toBe(400);
    expect(overReceive.body.message).toMatch(/remaining/);
  });

  it('PO auto-completes only when every unit is accepted', async () => {
    const finish = await owner()
      .post(`/v1/purchase-orders/${poId}/receiving`)
      .send({ lines: [{ lineId, received: 2, inspected: 2, accepted: 3 }] });
    expect(finish.status).toBe(201);
    expect(finish.body.status).toBe('received');
    expect(finish.body.closedAt).toBeTruthy();
    expect(finish.body.lines[0].quantityAccepted).toBe(5);
  });

  it('emails the PO to the vendor with the admin reply-to', async () => {
    const ops = await owner()
      .patch('/v1/business/settings')
      .send({ ops: { poReplyTo: 'purchasing@lamattress.test' } });
    expect(ops.status).toBe(200);

    const sent = await owner().post(`/v1/purchase-orders/${poId}/email`).send({});
    expect(sent.status).toBe(201);
    expect(sent.body.to).toBe('orders@stagevendor.test');

    const captured = await request(app.getHttpServer())
      .get('/v1/dev/email/last?to=orders@stagevendor.test')
      .expect(200);
    expect(captured.body.subject).toContain(poNumber);
    expect(captured.body.replyTo).toBe('purchasing@lamattress.test');
    expect(captured.body.html).toContain(poNumber);
  });

  it('vendor invoice: auto-match by PO #, variance, approve; clerk 403', async () => {
    await request(app.getHttpServer())
      .post('/v1/vendor-invoices')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ vendorId, number: 'SV-100', totalCents: 5000 })
      .expect(403);

    const recorded = await owner()
      .post('/v1/vendor-invoices')
      .send({ vendorId, number: 'SV-100', totalCents: 5200, poNumber });
    expect(recorded.status).toBe(201);
    expect(recorded.body.status).toBe('matched');
    expect(recorded.body.poNumber).toBe(poNumber);
    expect(recorded.body.varianceCents).toBe(5200 - 5000);

    const dup = await owner()
      .post('/v1/vendor-invoices')
      .send({ vendorId, number: 'SV-100', totalCents: 5200, poNumber });
    expect(dup.status).toBe(409);

    const listed = await owner().get(`/v1/vendor-invoices?purchaseOrderId=${poId}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);

    // G11 SoD: the recorder can't self-approve — the manager signs off.
    const approved = await request(app.getHttpServer())
      .post(`/v1/vendor-invoices/${recorded.body.id}/approve`)
      .set('Cookie', managerCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('approved');

    const again = await owner().post(`/v1/vendor-invoices/${recorded.body.id}/approve`).send({});
    expect(again.status).toBe(400);
  });

  it('an invoice with no matching PO stays unmatched and cannot be approved', async () => {
    const res = await owner()
      .post('/v1/vendor-invoices')
      .send({ vendorId, number: 'SV-999', totalCents: 123_45 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('unmatched');
    expect(res.body.varianceCents).toBeNull();

    const approve = await owner().post(`/v1/vendor-invoices/${res.body.id}/approve`).send({});
    expect(approve.status).toBe(400);
    expect(approve.body.message).toMatch(/Match the invoice/);
  });
});

describe('Purchasing controls: reject bucket, SoD, auto-clear, remit-to alert (PLAN-STORIS-GAP G11)', () => {
  function as(cookie: string) {
    return {
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
      patch: (url: string) =>
        request(app.getHttpServer())
          .patch(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
    };
  }

  let g11VendorId = '';

  it('rejected units go to As-Is review as pieces; the PO still completes', async () => {
    const vendor = await as(ownerCookie)
      .post('/v1/vendors')
      .send({ name: 'G11 Vendor', email: 'ap@g11vendor.test' });
    expect(vendor.status).toBe(201);
    g11VendorId = vendor.body.id;

    const po = await as(ownerCookie)
      .post('/v1/purchase-orders')
      .send({
        vendorId: g11VendorId,
        locationId,
        lines: [{ variantId: variantAId, quantity: 5, unitCostCents: 1000 }],
      });
    expect(po.status).toBe(201);
    const lineId = po.body.lines[0].id as string;
    const stockBefore = await levelOf(variantAId);

    // Received 5, inspected 5 — 3 good, 2 damaged.
    const staged = await as(clerkCookie)
      .post(`/v1/purchase-orders/${po.body.id}/receiving`)
      .send({ lines: [{ lineId, received: 5, inspected: 5, accepted: 3, rejected: 2 }] });
    expect(staged.status).toBe(201);
    expect(staged.body.status).toBe('received'); // fully dispositioned
    expect(staged.body.lines[0].quantityAccepted).toBe(3);
    expect(staged.body.lines[0].quantityRejected).toBe(2);

    // Only accepted units became stock; the rejects are As-Is pieces.
    expect(await levelOf(variantAId)).toBe(stockBefore + 3);
    const queue = await as(ownerCookie).get('/v1/as-is?status=pending_review');
    const pieces = queue.body.data.filter(
      (r: { referenceId: string | null; referenceType: string | null }) =>
        r.referenceType === 'purchase_order' && r.referenceId === po.body.id,
    );
    expect(pieces).toHaveLength(2);
    expect(pieces[0].quantity).toBe(1);
    const exceptions = await as(ownerCookie).get('/v1/exceptions?type=po_reject');
    expect(
      exceptions.body.data.some((e: { entityId: string | null }) => e.entityId === po.body.id),
    ).toBe(true);

    // Over-disposition is refused: nothing remains to accept.
    await as(clerkCookie)
      .post(`/v1/purchase-orders/${po.body.id}/receiving`)
      .send({ lines: [{ lineId, accepted: 1 }] })
      .expect(403); // status is 'received' — receiving is closed
  });

  it('a matched invoice inside the tolerance auto-clears; outside it needs a second signer', async () => {
    await as(ownerCookie)
      .patch('/v1/business/settings')
      .send({ ops: { invoiceVarianceToleranceCents: 500 } })
      .expect(200);
    try {
      const po = await as(ownerCookie)
        .post('/v1/purchase-orders')
        .send({
          vendorId: g11VendorId,
          locationId,
          lines: [{ variantId: variantAId, quantity: 2, unitCostCents: 10_000 }],
        });
      expect(po.status).toBe(201); // subtotal 20_000

      // $3 variance ≤ $5 tolerance → auto-approved on record.
      const auto = await as(ownerCookie).post('/v1/vendor-invoices').send({
        vendorId: g11VendorId,
        number: 'G11-AUTO-1',
        totalCents: 20_300,
        poNumber: po.body.number,
      });
      expect(auto.status).toBe(201);
      expect(auto.body.status).toBe('approved');

      // $50 variance → stays matched; the recorder cannot self-approve.
      const po2 = await as(ownerCookie)
        .post('/v1/purchase-orders')
        .send({
          vendorId: g11VendorId,
          locationId,
          lines: [{ variantId: variantAId, quantity: 1, unitCostCents: 10_000 }],
        });
      const manual = await as(ownerCookie).post('/v1/vendor-invoices').send({
        vendorId: g11VendorId,
        number: 'G11-MAN-1',
        totalCents: 15_000,
        poNumber: po2.body.number,
      });
      expect(manual.status).toBe(201);
      expect(manual.body.status).toBe('matched');

      const selfApprove = await as(ownerCookie)
        .post(`/v1/vendor-invoices/${manual.body.id}/approve`)
        .send({});
      expect(selfApprove.status).toBe(403);
      expect(selfApprove.body.code).toBe('OVERRIDE_REQUIRED');

      // A different authorized user signs off through the override.
      const signed = await as(ownerCookie)
        .post(`/v1/vendor-invoices/${manual.body.id}/approve`)
        .send({
          override: {
            email: 'manager@purch-test.local',
            password: PASSWORD,
            reason: 'checked against packing slip',
          },
        });
      expect(signed.status).toBe(201);
      expect(signed.body.status).toBe('approved');
    } finally {
      await as(ownerCookie)
        .patch('/v1/business/settings')
        .send({ ops: { invoiceVarianceToleranceCents: null } })
        .expect(200);
    }
  });

  it('changing a vendor remit-to raises a critical owner alert', async () => {
    const changed = await as(ownerCookie)
      .patch(`/v1/vendors/${g11VendorId}`)
      .send({ remitTo: 'PO Box 999, Reno NV — Acct 12345' });
    expect(changed.status).toBe(200);
    expect(changed.body.remitTo).toMatch(/Reno/);
    const exceptions = await as(ownerCookie).get(
      '/v1/exceptions?type=vendor_remit_change&severity=critical',
    );
    expect(
      exceptions.body.data.some((e: { entityId: string | null }) => e.entityId === g11VendorId),
    ).toBe(true);
  });
});

describe('PO lifecycle corrections — place / edit / un-receive', () => {
  let vendorId = '';
  let poId = '';
  let lineAId = '';
  let lineBId = '';

  async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      return await fn(drizzle(sql));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it('setup: vendor + a draft PO (place:false)', async () => {
    const vendor = await request(app.getHttpServer())
      .post('/v1/vendors')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Corrections Vendor Co' });
    expect(vendor.status).toBe(201);
    vendorId = vendor.body.id;

    const res = await request(app.getHttpServer())
      .post('/v1/purchase-orders')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        vendorId,
        locationId,
        place: false,
        lines: [{ variantId: variantAId, quantity: 2, unitCostCents: 300 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.placedAt).toBeNull();
    poId = res.body.id;
    lineAId = res.body.lines[0].id;
  });

  it('a draft cannot be received against; Place flips it to ordered exactly once', async () => {
    const recv = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: lineAId, quantity: 1 }] });
    expect(recv.status).toBe(403);

    const placed = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/place`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(placed.status).toBe(201);
    expect(placed.body.status).toBe('ordered');
    expect(placed.body.placedAt).not.toBeNull();

    const again = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/place`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(again.status).toBe(403);
  });

  it('edit: quantity, cost, expected date, added line — subtotal recomputes', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/purchase-orders/${poId}`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        expectedAt: '2026-09-15',
        notes: 'rev 2',
        lines: [
          { lineId: lineAId, quantity: 5, unitCostCents: 350 },
          { variantId: variantBId, quantity: 2, unitCostCents: 100 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.subtotalCents).toBe(5 * 350 + 2 * 100);
    expect(res.body.notes).toBe('rev 2');
    expect(res.body.expectedAt).not.toBeNull();
    lineBId = res.body.lines.find((l: { variantId: string }) => l.variantId === variantBId).id;
  });

  it('edit guards: cashier 403, no shrinking below received, no removing a received line', async () => {
    const forbidden = await request(app.getHttpServer())
      .patch(`/v1/purchase-orders/${poId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ notes: 'nope' });
    expect(forbidden.status).toBe(403);

    const recv = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: lineAId, quantity: 3 }] });
    expect(recv.status).toBe(201);
    expect(recv.body.status).toBe('partially_received');

    const shrink = await request(app.getHttpServer())
      .patch(`/v1/purchase-orders/${poId}`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: lineAId, quantity: 2 }] });
    expect(shrink.status).toBe(400);
    expect(shrink.body.message).toMatch(/already received/);

    const remove = await request(app.getHttpServer())
      .patch(`/v1/purchase-orders/${poId}`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: lineAId, remove: true }] });
    expect(remove.status).toBe(400);
    expect(remove.body.message).toMatch(/un-receive/);
  });

  it('a received PO is immutable via PATCH', async () => {
    const finish = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        lines: [
          { lineId: lineAId, quantity: 2 },
          { lineId: lineBId, quantity: 2 },
        ],
      });
    expect(finish.status).toBe(201);
    expect(finish.body.status).toBe('received');
    expect(finish.body.closedAt).not.toBeNull();

    const patch = await request(app.getHttpServer())
      .patch(`/v1/purchase-orders/${poId}`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ notes: 'too late' });
    expect(patch.status).toBe(403);
    expect(patch.body.message).toMatch(/received/);
  });

  it('un-receive backs units out of stock, writes an unreceive_po movement, reopens the PO', async () => {
    const before = await levelOf(variantAId);
    const res = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/unreceive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ notes: 'keyed 5, only 3 arrived', lines: [{ lineId: lineAId, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('partially_received');
    expect(res.body.closedAt).toBeNull();
    const lineA = res.body.lines.find((l: { id: string }) => l.id === lineAId);
    expect(lineA.quantityAccepted).toBe(3);
    expect(lineA.quantityReceived).toBe(3);

    expect(await levelOf(variantAId)).toBe(before - 2);

    await withDb(async (db) => {
      const movements = await db
        .select()
        .from(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.reason, 'unreceive_po'));
      expect(movements).toHaveLength(1);
      expect(movements[0]!.delta).toBe(-2);
      expect(movements[0]!.referenceId).toBe(poId);
    });
  });

  it('un-receive guards: over-accepted refused; reserved stock never cut into', async () => {
    const over = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/unreceive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: lineAId, quantity: 4 }] });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/only 3 accepted/);

    const onHand = await levelOf(variantAId);
    await withDb(async (db) => {
      await db
        .update(schema.inventoryLevels)
        .set({ reserved: onHand })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantAId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
    });
    const blocked = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/unreceive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: lineAId, quantity: 1 }] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/free \(unreserved\)/);
    await withDb(async (db) => {
      await db
        .update(schema.inventoryLevels)
        .set({ reserved: 0 })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantAId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
    });
  });
});

describe('FIFO costing — PO receipts create layers, un-receive backs them out', () => {
  let vendorId = '';
  let poId = '';
  let lineId = '';
  let costVariantId = '';

  async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      return await fn(drizzle(sql));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it('receiving a PO writes a cost layer at the PO line cost', async () => {
    costVariantId = await withDb(async (db) => {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'FIFO-P', name: 'FIFO Fixture' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'FIFO-P-V1', priceCents: 90000 })
        .returning();
      return v!.id;
    });
    const vendor = await request(app.getHttpServer())
      .post('/v1/vendors')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'FIFO Vendor Co' });
    vendorId = vendor.body.id;

    const po = await request(app.getHttpServer())
      .post('/v1/purchase-orders')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        vendorId,
        locationId,
        lines: [{ variantId: costVariantId, quantity: 3, unitCostCents: 500 }],
      });
    expect(po.status).toBe(201);
    poId = po.body.id;
    lineId = po.body.lines[0].id;

    const recv = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId, quantity: 3 }] });
    expect(recv.status).toBe(201);

    await withDb(async (db) => {
      const layers = await db
        .select()
        .from(schema.costLayers)
        .where(eq(schema.costLayers.variantId, costVariantId));
      expect(layers).toHaveLength(1);
      expect(layers[0]!.sourceType).toBe('po_receive');
      expect(layers[0]!.referenceId).toBe(poId);
      expect(layers[0]!.unitCostCents).toBe(500);
      expect(layers[0]!.quantityReceived).toBe(3);
      expect(layers[0]!.quantityRemaining).toBe(3);
    });
  });

  it("un-receive consumes this PO's own layer and records the consumption", async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${poId}/unreceive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId, quantity: 1 }] });
    expect(res.status).toBe(201);

    await withDb(async (db) => {
      const layers = await db
        .select()
        .from(schema.costLayers)
        .where(eq(schema.costLayers.variantId, costVariantId));
      expect(layers).toHaveLength(1);
      expect(layers[0]!.quantityRemaining).toBe(2);

      const consumptions = await db
        .select()
        .from(schema.costConsumptions)
        .where(eq(schema.costConsumptions.layerId, layers[0]!.id));
      expect(consumptions).toHaveLength(1);
      expect(consumptions[0]!.quantity).toBe(1);
      expect(consumptions[0]!.unitCostCents).toBe(500);
      expect(consumptions[0]!.referenceType).toBe('po_unreceive');
    });
  });
});

describe('Landed cost lean (run-02 Q1) — PO freight spreads into layer cost at receipt', () => {
  let vendorId = '';
  let poId = '';
  let lineAId = '';
  let lineBId = '';
  let varAId = '';
  let varBId = '';

  async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      return await fn(drizzle(sql));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  function asClerk() {
    return {
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
      patch: (url: string) =>
        request(app.getHttpServer())
          .patch(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
    };
  }

  it('freight is validated at create; every ordered unit carries the same share', async () => {
    [varAId, varBId] = await withDb(async (db) => {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'LCL-P', name: 'Landed Cost Fixture' })
        .returning();
      const rows = await db
        .insert(schema.productVariants)
        .values([
          { businessId, productId: p!.id, sku: 'LCL-A', priceCents: 40000 },
          { businessId, productId: p!.id, sku: 'LCL-B', priceCents: 60000 },
        ])
        .returning();
      return rows.map((r) => r.id) as [string, string];
    });
    const vendor = await asClerk().post('/v1/vendors').send({ name: 'Landed Cost Vendor' });
    vendorId = vendor.body.id;

    const bad = await asClerk()
      .post('/v1/purchase-orders')
      .send({
        vendorId,
        locationId,
        freightCents: -5,
        lines: [{ variantId: varAId, quantity: 1, unitCostCents: 1000 }],
      });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('freightCents');

    // Freight $10.00 over 5 ordered units = 200¢ per unit on every line.
    const po = await asClerk()
      .post('/v1/purchase-orders')
      .send({
        vendorId,
        locationId,
        freightCents: 1000,
        lines: [
          { variantId: varAId, quantity: 2, unitCostCents: 1000 },
          { variantId: varBId, quantity: 3, unitCostCents: 2000 },
        ],
      });
    expect(po.status).toBe(201);
    expect(po.body.freightCents).toBe(1000);
    poId = po.body.id;
    lineAId = po.body.lines.find((l: { variantId: string }) => l.variantId === varAId).id;
    lineBId = po.body.lines.find((l: { variantId: string }) => l.variantId === varBId).id;

    const recvA = await asClerk()
      .post(`/v1/purchase-orders/${poId}/receive`)
      .send({ lines: [{ lineId: lineAId, quantity: 2 }] });
    expect(recvA.status).toBe(201);
    // Partial receipt on B layers the identical share — the divisor is
    // the ordered total, not what happens to arrive first.
    const recvB = await asClerk()
      .post(`/v1/purchase-orders/${poId}/receive`)
      .send({ lines: [{ lineId: lineBId, quantity: 1 }] });
    expect(recvB.status).toBe(201);

    await withDb(async (db) => {
      const layerA = await db
        .select()
        .from(schema.costLayers)
        .where(eq(schema.costLayers.variantId, varAId));
      expect(layerA).toHaveLength(1);
      expect(layerA[0]!.unitCostCents).toBe(1200);
      expect(layerA[0]!.quantityReceived).toBe(2);
      const layerB = await db
        .select()
        .from(schema.costLayers)
        .where(eq(schema.costLayers.variantId, varBId));
      expect(layerB).toHaveLength(1);
      expect(layerB[0]!.unitCostCents).toBe(2200);
      expect(layerB[0]!.quantityReceived).toBe(1);
    });
  });

  it('freight is frozen once anything has been received; free to edit before', async () => {
    const blocked = await asClerk()
      .patch(`/v1/purchase-orders/${poId}`)
      .send({ freightCents: 2000 });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain('Cannot change freight after units have been received');

    const fresh = await asClerk()
      .post('/v1/purchase-orders')
      .send({
        vendorId,
        locationId,
        freightCents: 500,
        place: false,
        lines: [{ variantId: varAId, quantity: 1, unitCostCents: 1000 }],
      });
    expect(fresh.status).toBe(201);
    const edited = await asClerk()
      .patch(`/v1/purchase-orders/${fresh.body.id}`)
      .send({ freightCents: 700 });
    expect(edited.status).toBe(200);
    expect(edited.body.freightCents).toBe(700);
  });
});

describe('Nightly batch runner (EOD-001 / JOB-002)', () => {
  let nightlyVendorId = '';
  let managedVariantId = '';
  let overduePoId = '';
  const businessDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  function asOwner() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
      patch: (url: string) =>
        request(app.getHttpServer())
          .patch(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
    };
  }

  it('the step list is declared, ordered, and nothing is destructive', async () => {
    const res = await asOwner().get('/v1/jobs');
    expect(res.status).toBe(200);
    const jobs = res.body as { id: string; order: number; destructive: boolean }[];
    expect(jobs.map((j) => j.id)).toEqual([
      'po_overdue_sweep',
      'auto_replenishment',
      'sales_rate_replenishment',
      'transfer_aging',
      'task_overdue_reminders',
      'report_builder_schedule',
      'gl_derivation',
    ]);
    expect(jobs.every((j) => j.destructive === false)).toBe(true);
  });

  it('a run drafts replenishment POs, flags overdue POs, and is idempotent per business date', async () => {
    // Fixtures: a managed variant at zero stock + an overdue open PO.
    const vendor = await asOwner().post('/v1/vendors').send({ name: 'Nightly Vendor Co' });
    nightlyVendorId = vendor.body.id;
    const product = await asOwner()
      .post('/v1/products')
      .send({
        name: 'Nightly Mattress',
        sku: 'NIGHTLY',
        variants: [{ sku: 'NIGHTLY-1', priceCents: 79900, costCents: 25000 }],
      });
    managedVariantId = product.body.variants[0].id;
    await asOwner()
      .patch(`/v1/products/variants/${managedVariantId}/reorder`)
      .send({ reorderPoint: 4, reorderQty: 6, preferredVendorId: nightlyVendorId })
      .expect(200);

    const overdue = await asOwner()
      .post('/v1/purchase-orders')
      .send({
        vendorId: nightlyVendorId,
        locationId,
        expectedAt: '2026-08-01',
        lines: [{ variantId: variantAId, quantity: 2, unitCostCents: 100 }],
      });
    expect(overdue.status).toBe(201);
    overduePoId = overdue.body.id;

    await asOwner()
      .patch('/v1/business/settings')
      .send({ ops: { autoReplenishmentEnabled: true } })
      .expect(200);

    const run = await asOwner().post('/v1/jobs/run').send({ businessDate });
    expect(run.status).toBe(201);
    expect(run.body.businessDate).toBe(businessDate);
    const statuses = Object.fromEntries(
      (run.body.results as { jobId: string; status: string }[]).map((r) => [r.jobId, r.status]),
    );
    expect(statuses.po_overdue_sweep).toBe('succeeded');
    expect(statuses.auto_replenishment).toBe('succeeded');
    expect(statuses.transfer_aging).toBe('succeeded');

    // The replenishment draft exists for our vendor with the netted line.
    const pos = await asOwner().get('/v1/purchase-orders?status=draft');
    const drafts = (pos.body.data as { id: string; vendorId: string; status: string }[]).filter(
      (p) => p.vendorId === nightlyVendorId,
    );
    expect(drafts).toHaveLength(1);
    const detail = await asOwner().get(`/v1/purchase-orders/${drafts[0]!.id}`);
    const line = detail.body.lines.find(
      (l: { variantId: string }) => l.variantId === managedVariantId,
    );
    expect(line).toBeTruthy();
    expect(line.quantityOrdered).toBe(6);
    expect(line.unitCostCents).toBe(25000);
    expect(detail.body.notes).toMatch(/Auto-replenishment/);

    // The overdue PO landed on the exception register.
    const exceptions = await asOwner().get('/v1/exceptions?type=po_overdue');
    expect(
      (exceptions.body.data as { entityId: string | null }[]).some(
        (e) => e.entityId === overduePoId,
      ),
    ).toBe(true);

    // Second run for the same date: every step reports already_ran and
    // no second draft appears — re-running is always safe.
    const again = await asOwner().post('/v1/jobs/run').send({ businessDate });
    expect(
      (again.body.results as { status: string }[]).every((r) => r.status === 'already_ran'),
    ).toBe(true);
    const pos2 = await asOwner().get('/v1/purchase-orders?status=draft');
    expect(
      (pos2.body.data as { vendorId: string }[]).filter((p) => p.vendorId === nightlyVendorId),
    ).toHaveLength(1);

    // The run report shows every step with duration and records.
    const runs = await asOwner().get(`/v1/jobs/runs?date=${businessDate}`);
    expect(runs.status).toBe(200);
    expect((runs.body as { jobId: string }[]).map((row) => row.jobId).sort()).toEqual(
      JOB_REGISTRY.map((job) => job.id).sort(),
    );
  });

  it('resumes legacy GL successes with unresolved groups, then skips the completed date', async () => {
    const retryDate = '2040-02-01';
    const connection = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      await drizzle(connection)
        .insert(schema.jobRuns)
        .values(
          JOB_REGISTRY.map((job) => ({
            businessId,
            jobId: job.id,
            businessDate: retryDate,
            status: 'succeeded',
            detailJson: JSON.stringify(
              job.id === 'gl_derivation'
                ? {
                    posted: [{ family: 'pos_sales', batchNumber: 'TEST-ALREADY', debitCents: 100 }],
                    skipped: [
                      { family: 'order_money_in', reason: 'unmapped system key(s): cash_bank' },
                    ],
                  }
                : {},
            ),
          })),
        );
    } finally {
      await connection.end({ timeout: 5 });
    }
    const before = await asOwner().get(`/v1/jobs/runs?date=${retryDate}`);
    expect(
      before.body.find((row: { jobId: string }) => row.jobId === 'gl_derivation'),
    ).toMatchObject({
      status: 'partial',
      retryable: true,
      actionHref: '/gl',
    });
    // Accounting derivation has its own tests. This exercises persistence,
    // legacy status interpretation, and dispatch/retry through the HTTP API.
    const derive = vi.spyOn(app.get(GlDerivationService), 'derive').mockResolvedValue({
      posted: [{ family: 'order_money_in', batchNumber: 'TEST-RESUMED', debitCents: 200 }],
      skipped: [{ family: 'pos_sales', reason: 'already derived for this date' }],
    });
    try {
      const resumed = await asOwner()
        .post('/v1/jobs/run')
        .send({ businessDate: retryDate })
        .expect(201);
      expect(
        resumed.body.results.find((row: { jobId: string }) => row.jobId === 'gl_derivation')
          ?.status,
      ).toBe('succeeded');
      const again = await asOwner()
        .post('/v1/jobs/run')
        .send({ businessDate: retryDate })
        .expect(201);
      expect(
        again.body.results.every((row: { status: string }) => row.status === 'already_ran'),
      ).toBe(true);
      expect(derive).toHaveBeenCalledTimes(1);
      const after = await asOwner().get(`/v1/jobs/runs?date=${retryDate}`);
      expect(
        after.body.find((row: { jobId: string }) => row.jobId === 'gl_derivation'),
      ).toMatchObject({
        status: 'succeeded',
        retryable: false,
      });
    } finally {
      derive.mockRestore();
    }
  });

  it('a deleted draft does not suppress automatic replenishment', async () => {
    const vendor = await asOwner()
      .post('/v1/vendors')
      .send({ name: 'Deleted Draft Vendor' })
      .expect(201);
    const product = await asOwner()
      .post('/v1/products')
      .send({
        name: 'Deleted Draft Mattress',
        sku: 'DELETED-DRAFT',
        variants: [{ sku: 'DELETED-DRAFT-1', priceCents: 79900, costCents: 25000 }],
      })
      .expect(201);
    const variantId = product.body.variants[0].id;
    await asOwner()
      .patch(`/v1/products/variants/${variantId}/reorder`)
      .send({
        reorderPoint: 4,
        reorderQty: 6,
        preferredVendorId: vendor.body.id,
      })
      .expect(200);
    const oldDraft = await asOwner()
      .post('/v1/purchase-orders')
      .send({
        vendorId: vendor.body.id,
        locationId,
        place: false,
        lines: [{ variantId, quantity: 6, unitCostCents: 25000 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .delete(`/v1/purchase-orders/${oldDraft.body.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    await asOwner().post('/v1/jobs/run').send({ businessDate: '2040-02-02' }).expect(201);
    const pos = await asOwner().get('/v1/purchase-orders?status=draft');
    const drafts = (pos.body.data as { id: string; vendorId: string }[]).filter(
      (po) => po.vendorId === vendor.body.id,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.id).not.toBe(oldDraft.body.id);
  });

  it('with the gate off, auto_replenishment reports disabled', async () => {
    await asOwner()
      .patch('/v1/business/settings')
      .send({ ops: { autoReplenishmentEnabled: null } })
      .expect(200);
    const priorDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const run = await asOwner().post('/v1/jobs/run').send({ businessDate: priorDate });
    const repl = (run.body.results as { jobId: string; status: string }[]).find(
      (r) => r.jobId === 'auto_replenishment',
    );
    expect(repl?.status).toBe('disabled');
    const pos = await asOwner().get('/v1/purchase-orders?status=draft');
    expect(
      (pos.body.data as { vendorId: string }[]).filter((p) => p.vendorId === nightlyVendorId),
    ).toHaveLength(1); // still just the one from the earlier run
  });
});

describe('Sales-rate PO replenishment — run modes over live data (T-28/T-29/T-31/T-32)', () => {
  let srrVendorId = '';
  let srrVariantId = '';

  function asOwner() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
      patch: (url: string) =>
        request(app.getHttpServer())
          .patch(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
    };
  }

  beforeAll(async () => {
    const vendor = await asOwner().post('/v1/vendors').send({ name: 'SRR Vendor Co' });
    srrVendorId = vendor.body.id;
    const product = await asOwner()
      .post('/v1/products')
      .send({
        name: 'SRR Hybrid Queen',
        sku: 'SRR-HYB',
        variants: [{ sku: 'SRR-HYB-Q', priceCents: 99900, costCents: 30000 }],
      });
    srrVariantId = product.body.variants[0].id;

    // Fixtures the API has no writer for: preferred vendor, the §8
    // baseline sales history (80 sold / 8 weeks) and stock (45 on hand,
    // 15 committed) — inserted directly, mirroring T-01.
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    try {
      await db
        .update(schema.productVariants)
        .set({ preferredVendorId: srrVendorId })
        .where(eq(schema.productVariants.id, srrVariantId));
      const [cust] = await db
        .insert(schema.customers)
        .values({ businessId, firstName: 'Replen', lastName: 'Fixture' })
        .returning();
      // Written 10 days back so both the interactive window ([now−8w,
      // now]) and the EOD pass for an earlier business date contain it.
      const writtenAt = new Date(Date.now() - 10 * 86_400_000);
      const [order] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId,
          number: 'SRR-SOLD-1',
          status: 'completed',
          customerId: cust!.id,
          createdAt: writtenAt,
        })
        .returning();
      await db.insert(schema.orderLines).values({
        businessId,
        orderId: order!.id,
        variantId: srrVariantId,
        description: 'SRR Hybrid Queen',
        quantity: 80,
        qtyReserved: 0,
        qtyFulfilled: 80,
        unitPriceCents: 99900,
        totalCents: 80 * 99900,
        createdAt: writtenAt,
      });
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: srrVariantId,
        locationId,
        onHand: 45,
        reserved: 15,
      });
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    await asOwner()
      .patch(`/v1/purchasing/replenishment/vendors/${srrVendorId}/settings`)
      .send({
        generateAutomaticPos: true,
        automaticallyHoldPos: true,
        weeklySalesRateWeeks: 8,
        minimumStockDays: 14,
        leadDays: 21,
        variancePercent: 100,
        minimumSalesRate: 0,
        buildDays: [0, 1, 2, 3, 4, 5, 6],
      })
      .expect(200);
  });

  it('vendor settings round-trip; invalid combinations are refused', async () => {
    const got = await asOwner().get(`/v1/purchasing/replenishment/vendors/${srrVendorId}/settings`);
    expect(got.status).toBe(200);
    expect(got.body.settings.weeklySalesRateWeeks).toBe(8);
    expect(got.body.settings.automaticallyHoldPos).toBe(true);

    await asOwner()
      .patch(`/v1/purchasing/replenishment/vendors/${srrVendorId}/settings`)
      .send({ variancePercent: 1500 })
      .expect(400);
    // T-17 at the settings layer: the combination can never be stored.
    await asOwner()
      .patch(`/v1/purchasing/replenishment/vendors/${srrVendorId}/settings`)
      .send({ includeAllBackOrders: true, daysForReplenishment: 30 })
      .expect(400);
  });

  it('the interactive run reproduces the §8 baseline from live data', async () => {
    const res = await asOwner()
      .post('/v1/purchasing/replenishment/run')
      .send({ vendorId: srrVendorId, locationId });
    expect(res.status).toBe(201);
    const row = (res.body.rows as { variantId: string }[]).find(
      (r) => r.variantId === srrVariantId,
    ) as {
      required: number;
      additional: number;
      available: number;
      netPo: number;
      orderQty: number;
      sku: string | null;
      costCents: number | null;
    };
    expect(row).toBeTruthy();
    expect(row.required).toBe(20); // (14/7) * 10
    expect(row.additional).toBe(30); // (21/7) * 10
    expect(row.available).toBe(30); // 45 − 15
    expect(row.netPo).toBe(0);
    expect(row.orderQty).toBe(20);
    expect(row.sku).toBe('SRR-HYB-Q');
    expect(row.costCents).toBe(30000);
  });

  it('T-31/T-28/T-29: the EOD mode writes the identical quantity, held, dated by lead days', async () => {
    const businessDate = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const run = await asOwner().post('/v1/jobs/run').send({ businessDate });
    expect(run.status).toBe(201);
    const step = (run.body.results as { jobId: string; status: string }[]).find(
      (r) => r.jobId === 'sales_rate_replenishment',
    );
    expect(step?.status, JSON.stringify(step)).toBe('succeeded');

    const pos = await asOwner().get('/v1/purchase-orders?status=draft');
    const drafts = (pos.body.data as { id: string; vendorId: string }[]).filter(
      (p) => p.vendorId === srrVendorId,
    );
    expect(drafts).toHaveLength(1); // T-28: held = draft, never auto-placed
    const detail = await asOwner().get(`/v1/purchase-orders/${drafts[0]!.id}`);
    const line = detail.body.lines.find((l: { variantId: string }) => l.variantId === srrVariantId);
    // T-31: same engine, same data path — same quantity as the run above.
    expect(line.quantityOrdered).toBe(20);
    expect(line.unitCostCents).toBe(30000);
    expect(detail.body.notes).toMatch(/held for review/);
    // T-29: header expected date = furthest lead-day date (21 days out
    // from the business date the EOD pass ran for).
    const expected = new Date(new Date(`${businessDate}T12:00:00Z`).getTime() + 21 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(String(detail.body.expectedAt).slice(0, 10)).toBe(expected);
  });

  it('open supply feeds back: the next run shows nothing to order; overrides still create (T-32)', async () => {
    const res = await asOwner()
      .post('/v1/purchasing/replenishment/run')
      .send({ vendorId: srrVendorId, locationId });
    expect(
      (res.body.rows as { variantId: string }[]).find((r) => r.variantId === srrVariantId),
    ).toBeUndefined(); // orderQty 0 → suppressed without Include Overstocks

    await asOwner()
      .post('/v1/purchasing/replenishment/purchase-order')
      .send({ vendorId: srrVendorId, locationId })
      .expect(400); // nothing with quantity to order

    const created = await asOwner()
      .post('/v1/purchasing/replenishment/purchase-order')
      .send({
        vendorId: srrVendorId,
        locationId,
        includeOverstocks: true,
        overrides: [{ variantId: srrVariantId, orderQty: 5 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    const detail = await asOwner().get(`/v1/purchase-orders/${created.body.poId}`);
    const line = detail.body.lines.find((l: { variantId: string }) => l.variantId === srrVariantId);
    expect(line.quantityOrdered).toBe(5); // the buyer override, only qty > 0 written
  });
});

/**
 * CR 2026-08-31 — "Let draft purchase orders be deleted".
 *
 * A draft had no exit: retiring one meant placing it (recording a vendor
 * commitment that never existed) and cancelling, or leaving a $0.00
 * shell on the list forever. What this proves:
 *
 * - Draft-only, soft, and reversible; the number is never reused.
 * - Each of the four refusal conditions blocks with its own message.
 * - A draft sourced from the special-orders queue returns its lines to
 *   the queue as un-sourced.
 * - The permission is separate from `purchase_orders.create`, so the
 *   clerk who can raise a PO cannot delete one.
 */
describe('CR — deleting a draft purchase order', () => {
  let vendorId = '';
  let customerId = '';

  function as(cookie: string) {
    const req = () => request(app.getHttpServer());
    const wrap = (r: request.Test) => r.set('Cookie', cookie).set('X-Business-Id', businessId);
    return {
      get: (url: string) => wrap(req().get(url)),
      post: (url: string) => wrap(req().post(url)),
      patch: (url: string) => wrap(req().patch(url)),
      delete: (url: string) => wrap(req().delete(url)),
    };
  }

  async function makeDraft(
    lines?: { variantId: string; quantity: number; unitCostCents: number; orderLineId?: string }[],
  ): Promise<{ id: string; number: string }> {
    const res = await as(ownerCookie)
      .post('/v1/purchase-orders')
      .send({
        vendorId,
        locationId,
        place: false,
        lines: lines ?? [{ variantId: variantAId, quantity: 3, unitCostCents: 10_000 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    return { id: res.body.id, number: res.body.number };
  }

  beforeAll(async () => {
    const res = await as(ownerCookie)
      .post('/v1/vendors')
      .send({ name: 'Delete-CR Supply', email: 'del@example.test' });
    expect(res.status).toBe(201);
    vendorId = res.body.id;

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [cust] = await db
        .insert(schema.customers)
        .values({ businessId, firstName: 'Del', lastName: 'Etee' })
        .returning();
      customerId = cust!.id;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('deletes a draft, hides it from the default list, and keeps it under Show deleted', async () => {
    const draft = await makeDraft();

    const deleted = await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedAt).not.toBeNull();
    expect(deleted.body.deletedByEmail).toBe('owner@purch-test.local');

    const def = await as(ownerCookie).get('/v1/purchase-orders?limit=100');
    expect((def.body.data as { id: string }[]).some((r) => r.id === draft.id)).toBe(false);

    const withDeleted = await as(ownerCookie).get('/v1/purchase-orders?includeDeleted=1&limit=100');
    const row = (withDeleted.body.data as { id: string; deletedAt: string | null }[]).find(
      (r) => r.id === draft.id,
    );
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();

    // The detail page still opens it — that is where Restore lives.
    const detail = await as(ownerCookie).get(`/v1/purchase-orders/${draft.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.number).toBe(draft.number);
  });

  it('restores a deleted draft with its number, lines and subtotal intact', async () => {
    const draft = await makeDraft();
    await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(200);

    const restored = await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/restore`);
    expect(restored.status).toBe(201);
    expect(restored.body.deletedAt).toBeNull();
    expect(restored.body.number).toBe(draft.number);
    expect(restored.body.status).toBe('draft');
    expect(restored.body.lines).toHaveLength(1);
    expect(restored.body.subtotalCents).toBe(30_000);

    const def = await as(ownerCookie).get('/v1/purchase-orders?limit=100');
    expect((def.body.data as { id: string }[]).some((r) => r.id === draft.id)).toBe(true);
  });

  it('never hands a deleted PO number to the next purchase order', async () => {
    const doomed = await makeDraft();
    await as(ownerCookie).delete(`/v1/purchase-orders/${doomed.id}`).expect(200);

    const next = await makeDraft();
    expect(next.number).not.toBe(doomed.number);

    // The retired row keeps the number, which is what stops the reuse.
    const all = await as(ownerCookie).get('/v1/purchase-orders?includeDeleted=1&limit=100');
    const numbers = (all.body.data as { number: string }[]).map((r) => r.number);
    expect(numbers).toContain(doomed.number);
    expect(numbers.filter((n) => n === doomed.number)).toHaveLength(1);
  });

  it('refuses a placed PO, pointing at cancel instead', async () => {
    const draft = await makeDraft();
    await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/place`).expect(201);

    const res = await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Only drafts can be deleted. Cancel this PO instead.');
    expect(res.body.code).toBe('NOT_DRAFT');
  });

  it('refuses a cancelled PO too — delete is not a tidier cancel', async () => {
    const draft = await makeDraft();
    await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/place`).expect(201);
    await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/cancel`).expect(201);

    const res = await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_DRAFT');
  });

  it('refuses a draft carrying received units', async () => {
    const draft = await makeDraft();
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      // Units at the dock on a PO still marked draft: the shape the
      // guard exists for, even though the normal path places first.
      await db
        .update(schema.purchaseOrderLines)
        .set({ quantityReceived: 1 })
        .where(eq(schema.purchaseOrderLines.purchaseOrderId, draft.id));
    } finally {
      await sql.end({ timeout: 5 });
    }

    const res = await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This PO has received units. Un-receive them first.');
    expect(res.body.code).toBe('HAS_RECEIPTS');
  });

  it('refuses while a vendor invoice is matched to it', async () => {
    const draft = await makeDraft();
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      await db.insert(schema.vendorInvoices).values({
        businessId,
        vendorId,
        purchaseOrderId: draft.id,
        number: 'INV-CR-1',
        totalCents: 30_000,
        status: 'matched',
      });
    } finally {
      await sql.end({ timeout: 5 });
    }

    const res = await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A vendor invoice is matched to this PO. Unmatch it first.');
    expect(res.body.code).toBe('INVOICE_MATCHED');
  });

  it('refuses when a sales order sourced from it is already fulfilled, and names it', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    let orderLineId = '';
    let orderNumber = '';
    try {
      const [order] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId,
          number: 'SO-CR-FULFILLED',
          status: 'partially_fulfilled',
          customerId,
          totalCents: 50_000,
          subtotalCents: 50_000,
        })
        .returning();
      orderNumber = order!.number;
      const [line] = await db
        .insert(schema.orderLines)
        .values({
          businessId,
          orderId: order!.id,
          variantId: variantAId,
          description: 'Special-order bed',
          quantity: 1,
          qtyFulfilled: 1,
          lineType: 'special_order',
          unitPriceCents: 50_000,
          totalCents: 50_000,
        })
        .returning();
      orderLineId = line!.id;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const draft = await makeDraft([
      { variantId: variantAId, quantity: 1, unitCostCents: 10_000, orderLineId },
    ]);

    const res = await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_FULFILLED');
    expect(res.body.message).toBe(`${orderNumber} is sourced from this PO and already fulfilled.`);
  });

  it('returns an unfulfilled special-order line to the queue as un-sourced', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    let orderLineId = '';
    try {
      const [order] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId,
          number: 'SO-CR-QUEUED',
          status: 'open',
          customerId,
          totalCents: 50_000,
          subtotalCents: 50_000,
        })
        .returning();
      const [line] = await db
        .insert(schema.orderLines)
        .values({
          businessId,
          orderId: order!.id,
          variantId: variantAId,
          description: 'Special-order bed',
          quantity: 1,
          lineType: 'special_order',
          unitPriceCents: 50_000,
          totalCents: 50_000,
        })
        .returning();
      orderLineId = line!.id;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const queueBefore = await as(ownerCookie).get('/v1/special-orders/queue');
    const before = (queueBefore.body as { orderLineId: string; allocated: number }[]).find(
      (r) => r.orderLineId === orderLineId,
    );
    expect(before?.allocated ?? 0).toBe(0);

    const draft = await makeDraft([
      { variantId: variantAId, quantity: 1, unitCostCents: 10_000, orderLineId },
    ]);

    // Fully sourced, so it leaves the queue entirely — the queue lists
    // what still needs buying (`toOrder > 0`), not what was bought.
    const sourced = await as(ownerCookie).get('/v1/special-orders/queue');
    expect(
      (sourced.body as { orderLineId: string }[]).some((r) => r.orderLineId === orderLineId),
    ).toBe(false);

    await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(200);

    // Deleting the draft puts it back in front of a buyer.
    const after = await as(ownerCookie).get('/v1/special-orders/queue');
    const row = (after.body as { orderLineId: string; allocated: number; toOrder: number }[]).find(
      (r) => r.orderLineId === orderLineId,
    );
    expect(row).toBeDefined();
    expect(row!.allocated).toBe(0);
    expect(row!.toOrder).toBe(1);
  });

  it('does not re-claim those lines on restore — they may have been sourced elsewhere', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    let orderLineId = '';
    try {
      const [order] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId,
          number: 'SO-CR-RESTORE',
          status: 'open',
          customerId,
          totalCents: 50_000,
          subtotalCents: 50_000,
        })
        .returning();
      const [line] = await db
        .insert(schema.orderLines)
        .values({
          businessId,
          orderId: order!.id,
          variantId: variantAId,
          description: 'Special-order bed',
          quantity: 1,
          lineType: 'special_order',
          unitPriceCents: 50_000,
          totalCents: 50_000,
        })
        .returning();
      orderLineId = line!.id;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const draft = await makeDraft([
      { variantId: variantAId, quantity: 1, unitCostCents: 10_000, orderLineId },
    ]);
    await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(200);
    await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/restore`).expect(201);

    const queue = await as(ownerCookie).get('/v1/special-orders/queue');
    const row = (queue.body as { orderLineId: string; allocated: number }[]).find(
      (r) => r.orderLineId === orderLineId,
    );
    expect(row!.allocated).toBe(0);
  });

  it('a deleted draft accepts exactly one verb — restore', async () => {
    // Review finding: a deleted draft keeps status 'draft', so the
    // status checks alone would let it be placed — a vendor commitment
    // from a row that is invisible in the list and unrestorable after.
    const draft = await makeDraft();
    await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(200);

    const placed = await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/place`);
    expect(placed.status).toBe(409);
    expect(placed.body.code).toBe('ALREADY_DELETED');

    const edited = await as(ownerCookie)
      .patch(`/v1/purchase-orders/${draft.id}`)
      .send({ notes: 'sneaky edit' });
    expect(edited.status).toBe(409);
    expect(edited.body.code).toBe('ALREADY_DELETED');

    const cancelled = await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/cancel`);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('ALREADY_DELETED');

    // Still a draft, still restorable — the row was never mutated.
    const restored = await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/restore`);
    expect(restored.status).toBe(201);
    expect(restored.body.status).toBe('draft');
    expect(restored.body.placedAt).toBeNull();
  });

  it('refuses a second delete and a restore of a live PO', async () => {
    const draft = await makeDraft();
    await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(200);

    const twice = await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`);
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('ALREADY_DELETED');

    const live = await makeDraft();
    const restoreLive = await as(ownerCookie).post(`/v1/purchase-orders/${live.id}/restore`);
    expect(restoreLive.status).toBe(409);
    expect(restoreLive.body.code).toBe('ALREADY_DELETED');
  });

  it('keeps the delete away from the roles that raise POs', async () => {
    const draft = await makeDraft();
    // The clerk holds purchase_orders.create and .receive — deleting is
    // a separate grant, and the shared POS account must not have it.
    await as(clerkCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(403);
    await as(cashierCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(403);
    await as(clerkCookie).post(`/v1/purchase-orders/${draft.id}/restore`).expect(403);
    // A manager can.
    await as(managerCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(200);
  });

  it('writes a visible audit entry the PO change-history reads', async () => {
    const draft = await makeDraft();
    await as(ownerCookie).delete(`/v1/purchase-orders/${draft.id}`).expect(200);
    await as(ownerCookie).post(`/v1/purchase-orders/${draft.id}/restore`).expect(201);

    const res = await as(ownerCookie).get(
      `/v1/audit-logs?targetType=purchase_order&targetId=${draft.id}&limit=50`,
    );
    expect(res.status).toBe(200);
    const actions = (res.body.data as { action: string }[]).map((r) => r.action);
    expect(actions).toContain('purchase_order.delete');
    expect(actions).toContain('purchase_order.restore');
  });
});
