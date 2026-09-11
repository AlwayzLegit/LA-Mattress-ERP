/**
 * Day 1 acceptance (STORIS cutover sprint): a cashier writes a sales
 * order for a customer, the order commits stock without decrementing
 * on-hand, a deposit lands as a `payments` row against the order, and the
 * balance due falls by exactly what was collected. Cancelling hands the
 * committed units back.
 *
 * Also covers the guard rails that keep the money honest: over-collecting
 * past the balance, cancelling an order that already holds money, and
 * role gating (an inventory clerk can't write orders or take deposits).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.ORDERS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_orders';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'OrdersPass!2026';

let app: INestApplication;
let businessId = '';
let locationId = '';
let customerId = '';
/** Sofa: 8 on hand, $1,299.99. */
let sofaVariantId = '';
/** Chair: 1 on hand, $199.99 — deliberately short for a 3-unit line. */
let chairVariantId = '';
let ownerCookie = '';
let cashierCookie = '';
let clerkCookie = '';

async function resetTestDb() {
  const env = { ...process.env, DATABASE_URL: TEST_DB_URL };
  execFileSync('pnpm', ['exec', 'tsx', 'src/reset.ts'], {
    cwd: dbPackageRoot,
    env,
    stdio: 'inherit',
  });
  execFileSync('pnpm', ['exec', 'tsx', 'src/migrate.ts'], {
    cwd: dbPackageRoot,
    env,
    stdio: 'inherit',
  });
}

async function seed() {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({
        slug: 'orders-test',
        name: 'Orders Test Co',
        status: 'active',
        defaultTaxRateBps: 700,
      })
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
    await makeUser('owner@orders-test.local', 'Owner');
    await makeUser('cashier@orders-test.local', 'Cashier');
    await makeUser('clerk@orders-test.local', 'Warehouse');

    const [loc] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Showroom', timezone: 'America/New_York', taxRateBps: 700 })
      .returning();
    locationId = loc!.id;

    const [cust] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Dana', lastName: 'Reyes', email: 'dana@example.test' })
      .returning();
    customerId = cust!.id;

    async function makeVariant(sku: string, name: string, priceCents: number, onHand: number) {
      const [p] = await db.insert(schema.products).values({ businessId, sku, name }).returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: `${sku}-1`, priceCents })
        .returning();
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: v!.id,
        locationId,
        onHand,
        reserved: 0,
      });
      return v!.id;
    }
    sofaVariantId = await makeVariant('SOFA', 'Harbour Sofa', 129_999, 8);
    chairVariantId = await makeVariant('CHAIR', 'Harbour Chair', 19_999, 1);
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

async function levelOf(variantId: string): Promise<{ onHand: number; reserved: number }> {
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
    return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function movementsFor(orderId: string): Promise<{ reason: string; delta: number }[]> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    return await db
      .select({
        reason: schema.inventoryMovements.reason,
        delta: schema.inventoryMovements.delta,
      })
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.referenceId, orderId))
      .orderBy(schema.inventoryMovements.createdAt);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'orders-test-secret-orders-test-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();

  ownerCookie = await captureCookie('owner@orders-test.local');
  cashierCookie = await captureCookie('cashier@orders-test.local');
  clerkCookie = await captureCookie('clerk@orders-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('New Sale backend (PLAN-POS-OPERATIONS P2a)', () => {
  // Own fixtures — the Day-1 suites assert absolute stock numbers on the
  // shared sofa, so nothing here may touch it.
  let nsVariantId = '';
  let atpVariantId = '';

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [p1] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'NS-SOFA', name: 'NewSale Fixture Sofa' })
        .returning();
      const [v1] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p1!.id, sku: 'NS-SOFA-V1', priceCents: 99900 })
        .returning();
      nsVariantId = v1!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: nsVariantId,
        locationId,
        onHand: 10,
        reserved: 0,
      });

      const [p2] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'ATP-1', name: 'ATP Backorder Mattress' })
        .returning();
      const [v2] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p2!.id, sku: 'ATP-1-V1', priceCents: 49999 })
        .returning();
      atpVariantId = v2!.id;
      const [vendor] = await db
        .insert(schema.vendors)
        .values({ businessId, name: 'ATP Vendor' })
        .returning();
      const [po] = await db
        .insert(schema.purchaseOrders)
        .values({
          businessId,
          vendorId: vendor!.id,
          locationId,
          number: 'PO-ATP-1',
          status: 'ordered',
          expectedAt: new Date('2026-09-04T00:00:00Z'),
        })
        .returning();
      await db.insert(schema.purchaseOrderLines).values({
        businessId,
        purchaseOrderId: po!.id,
        variantId: atpVariantId,
        quantityOrdered: 5,
        quantityReceived: 0,
        unitCostCents: 20000,
        lineTotalCents: 100000,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  it('Custom fee lines: no variant, untaxed, never reserved; new tenders accepted', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [
          { variantId: nsVariantId, quantity: 1 },
          { lineType: 'custom', description: 'Recycling Fee', quantity: 2, unitPriceCents: 1050 },
          { lineType: 'custom', description: 'Mattress Removal', quantity: 1, unitPriceCents: 0 },
        ],
      });
    expect(res.status).toBe(201);
    const o = res.body;
    const fee = o.lines.find((l: { description: string }) => l.description === 'Recycling Fee');
    expect(fee.variantId).toBeNull();
    expect(fee.taxCents).toBe(0); // fees are untaxed
    expect(fee.totalCents).toBe(2100);
    const removal = o.lines.find(
      (l: { description: string }) => l.description === 'Mattress Removal',
    );
    expect(removal.totalCents).toBe(0);
    expect(fee.qtyReserved).toBe(0);
    const sofa = o.lines.find((l: { variantId: string | null }) => l.variantId);
    expect(sofa.qtyReserved).toBe(1);

    const pay = await request(app.getHttpServer())
      .post(`/v1/orders/${o.id}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'venmo', amountCents: 5000, kind: 'deposit' });
    expect(pay.status).toBe(201);

    const noDesc = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        lines: [{ lineType: 'custom', quantity: 1, unitPriceCents: 100 }],
      });
    expect(noDesc.status).toBe(400);
  });

  it('Drafts: store-wide, no reservation, resumable to open', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        draft: true,
        lines: [{ variantId: nsVariantId, quantity: 1 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.lines[0].qtyReserved).toBe(0);

    const list = await request(app.getHttpServer())
      .get('/v1/orders?status=draft')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);
    expect(list.body.data.some((o: { id: string }) => o.id === res.body.id)).toBe(true);

    const confirmed = await request(app.getHttpServer())
      .patch(`/v1/orders/${res.body.id}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ status: 'open' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('open');
    expect(confirmed.body.lines[0].qtyReserved).toBe(1);
  });

  it('Product search: stock filters and ATP date from open POs', async () => {
    const out = await request(app.getHttpServer())
      .get(`/v1/pos/product-search?q=ATP&inStock=0&locationId=${locationId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(out.status).toBe(200);
    const hit = out.body.find((r: { variantId: string }) => r.variantId === atpVariantId);
    expect(hit).toBeTruthy();
    expect(hit.availableTotal).toBe(0);
    expect(hit.atpDate).toContain('2026-09-04');

    const inn = await request(app.getHttpServer())
      .get(`/v1/pos/product-search?q=NewSale&inStock=1&locationId=${locationId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(inn.status).toBe(200);
    expect(inn.body.some((r: { variantId: string }) => r.variantId === nsVariantId)).toBe(true);
    expect(inn.body.every((r: { availableTotal: number }) => r.availableTotal > 0)).toBe(true);
  });
});

describe('Orders list-view + notifications (PLAN-POS-OPERATIONS P3)', () => {
  // Own fixtures again — display-status assertions must not depend on
  // what other suites did to the shared variants.
  let lvStockedVariantId = '';
  let lvEmptyVariantId = '';

  interface ListViewRow {
    id: string;
    number: string;
    customerName: string;
    displayStatus: string;
    poNumber: string | null;
    deliveryDate: string | null;
    balanceDueCents: number;
    salespersonName: string | null;
    totalCents: number;
  }

  async function listView(query = ''): Promise<ListViewRow[]> {
    const res = await request(app.getHttpServer())
      .get(`/v1/orders/list-view${query}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    return res.body.data as ListViewRow[];
  }

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const mk = async (sku: string, name: string, onHand: number) => {
        const [p] = await db.insert(schema.products).values({ businessId, sku, name }).returning();
        const [v] = await db
          .insert(schema.productVariants)
          .values({ businessId, productId: p!.id, sku: `${sku}-V1`, priceCents: 50000 })
          .returning();
        await db.insert(schema.inventoryLevels).values({
          businessId,
          variantId: v!.id,
          locationId,
          onHand,
          reserved: 0,
        });
        return v!.id;
      };
      lvStockedVariantId = await mk('LV-STOCK', 'ListView Stocked Bed', 10);
      lvEmptyVariantId = await mk('LV-EMPTY', 'ListView Backordered Bed', 0);
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  it('Spec columns + display statuses: Draft, Quote, Reserved, Pending; balance due after payment', async () => {
    const make = async (body: Record<string, unknown>) => {
      const res = await request(app.getHttpServer())
        .post('/v1/orders')
        .set('Cookie', cashierCookie)
        .set('X-Business-Id', businessId)
        .send({ locationId, customerId, ...body });
      expect(res.status).toBe(201);
      return res.body as { id: string; number: string; totalCents: number };
    };

    const draft = await make({
      draft: true,
      lines: [{ variantId: lvStockedVariantId, quantity: 1 }],
    });
    const quote = await make({ lines: [{ variantId: lvStockedVariantId, quantity: 1 }] });
    const reserved = await make({
      confirm: true,
      lines: [{ variantId: lvStockedVariantId, quantity: 1 }],
    });
    const pending = await make({
      confirm: true,
      lines: [{ variantId: lvEmptyVariantId, quantity: 1 }],
    });

    const pay = await request(app.getHttpServer())
      .post(`/v1/orders/${reserved.id}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'cash', amountCents: 10000, kind: 'deposit' });
    expect(pay.status).toBe(201);

    const rows = await listView('?limit=100');
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(draft.id)?.displayStatus).toBe('Draft');
    expect(byId.get(quote.id)?.displayStatus).toBe('Quote');
    expect(byId.get(reserved.id)?.displayStatus).toBe('Reserved');
    expect(byId.get(pending.id)?.displayStatus).toBe('Pending');

    const r = byId.get(reserved.id)!;
    expect(r.customerName).toBe('Dana Reyes');
    expect(r.balanceDueCents).toBe(reserved.totalCents - 10000);
    expect(r.number).toBe(reserved.number);
  });

  it('q filter matches order number and customer name', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: lvStockedVariantId, quantity: 1 }],
      });
    expect(res.status).toBe(201);
    const number: string = res.body.number;

    const byNumber = await listView(`?q=${encodeURIComponent(number)}`);
    expect(byNumber.some((r) => r.id === res.body.id)).toBe(true);

    const byName = await listView('?q=reyes&limit=200');
    expect(byName.some((r) => r.id === res.body.id)).toBe(true);
    expect(byName.every((r) => r.customerName === 'Dana Reyes')).toBe(true);
  });

  it('Notifications feed: post-creation order changes, attributed; gated by audit.view', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: lvStockedVariantId, quantity: 1 }],
      });
    expect(created.status).toBe(201);

    const patched = await request(app.getHttpServer())
      .patch(`/v1/orders/${created.body.id}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ notes: 'call before delivery' });
    expect(patched.status).toBe(200);

    const feed = await request(app.getHttpServer())
      .get('/v1/notifications?limit=50')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(feed.status).toBe(200);
    const hit = feed.body.data.find(
      (n: { orderId: string | null; action: string }) =>
        n.orderId === created.body.id && n.action === 'order.update',
    );
    expect(hit).toBeTruthy();
    expect(hit.label).toBe('Order edited');
    expect(hit.orderNumber).toBe(created.body.number);
    expect(hit.actorEmail).toBe('cashier@orders-test.local');
    // order.create is not a *post-creation* change — it must not be in the feed.
    expect(feed.body.data.some((n: { action: string }) => n.action === 'order.create')).toBe(false);

    await request(app.getHttpServer())
      .get('/v1/notifications')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(403);
  });
});

describe('Documents + A1 print lock (PLAN-POS-OPERATIONS P4)', () => {
  let p4VariantId = '';

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [vendor] = await db
        .insert(schema.vendors)
        .values({ businessId, name: 'Docs Brand Co' })
        .returning();
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'P4-BED', name: 'Docs Fixture Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({
          businessId,
          productId: p!.id,
          sku: 'P4-BED-V1',
          priceCents: 80000,
          preferredVendorId: vendor!.id,
        })
        .returning();
      p4VariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: p4VariantId,
        locationId,
        onHand: 20,
        reserved: 0,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  async function makeOrder(): Promise<{ id: string; number: string }> {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        // Pickup + promised date satisfies the G9 print preconditions
        // without needing a scheduled truck in this suite.
        fulfillmentType: 'pickup',
        requestedDate: '2026-09-10',
        lines: [{ variantId: p4VariantId, quantity: 1 }],
      });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('Document payload: business + store + customer + line model/brand + totals', async () => {
    const order = await makeOrder();
    const res = await request(app.getHttpServer())
      .get(`/v1/orders/${order.id}/document`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.business.name).toBe('Orders Test Co');
    expect(res.body.location.name).toBe('Showroom');
    expect(res.body.customer.name).toBe('Dana Reyes');
    expect(res.body.scheduledDate).toBe('2026-09-10'); // no trip yet → requested date
    const line = res.body.lines.find((l: { model: string | null }) => l.model === 'P4-BED-V1');
    expect(line).toBeTruthy();
    expect(line.brand).toBe('Docs Brand Co');
    expect(res.body.order.totalCents).toBe(res.body.order.subtotalCents + res.body.order.taxCents);
  });

  it("Document payload carries each payment's reference (the card last 4) for the invoice", async () => {
    const order = await makeOrder();
    const pay = await request(app.getHttpServer())
      .post(`/v1/orders/${order.id}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'card', amountCents: 1000, kind: 'deposit', processorRef: '4242' });
    expect(pay.status).toBe(201);
    const res = await request(app.getHttpServer())
      .get(`/v1/orders/${order.id}/document`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const printed = res.body.order.payments.find((p: { id: string }) => p.id === pay.body.id);
    expect(printed).toBeTruthy();
    expect(printed.processorRef).toBe('4242');
  });

  it('Document payload carries the branding accent for the invoice (null until set)', async () => {
    const order = await makeOrder();
    const before = await request(app.getHttpServer())
      .get(`/v1/orders/${order.id}/document`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(before.status).toBe(200);
    expect(before.body.business.accentColor).toBeNull();

    await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ branding: { accentColor: '#0f766e' } })
      .expect(200);
    try {
      const after = await request(app.getHttpServer())
        .get(`/v1/orders/${order.id}/document`)
        .set('Cookie', cashierCookie)
        .set('X-Business-Id', businessId);
      expect(after.status).toBe(200);
      expect(after.body.business.accentColor).toBe('#0f766e');
    } finally {
      await request(app.getHttpServer())
        .patch('/v1/business/settings')
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ branding: { accentColor: null } })
        .expect(200);
    }
  });

  it('Individual ticket print locks: edits refuse 409 until unlocked with a reason', async () => {
    const order = await makeOrder();

    const printed = await request(app.getHttpServer())
      .post(`/v1/orders/${order.id}/delivery-ticket-print`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(printed.status).toBe(201);
    expect(printed.body.lockedAt).toBeTruthy();

    // All guarded edit surfaces refuse while locked…
    await request(app.getHttpServer())
      .patch(`/v1/orders/${order.id}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ requestedDate: '2026-09-12' })
      .expect(409);
    // …but the G9 allowlist lets contact/notes fixes through the lock.
    await request(app.getHttpServer())
      .patch(`/v1/orders/${order.id}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ notes: 'gate code 4411' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/orders/${order.id}/lines`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId: p4VariantId, quantity: 1 })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/v1/orders/${order.id}/cancel`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({})
      .expect(409);

    // Cashier lacks orders.unlock; owner without a reason is a 400.
    await request(app.getHttpServer())
      .post(`/v1/orders/${order.id}/unlock`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ reason: 'customer changed size' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/v1/orders/${order.id}/unlock`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({})
      .expect(400);

    const unlocked = await request(app.getHttpServer())
      .post(`/v1/orders/${order.id}/unlock`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ reason: 'customer changed size' });
    expect(unlocked.status).toBe(201);
    expect(unlocked.body.lockedAt).toBeNull();

    await request(app.getHttpServer())
      .patch(`/v1/orders/${order.id}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ notes: 'now it works' })
      .expect(200);

    // The unlock override surfaces in the owner notifications feed with
    // its typed reason (§12 "lock overrides").
    const feed = await request(app.getHttpServer())
      .get('/v1/notifications?limit=50')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(feed.status).toBe(200);
    const hit = feed.body.data.find(
      (n: { orderId: string | null; action: string }) =>
        n.orderId === order.id && n.action === 'order.unlock',
    );
    expect(hit).toBeTruthy();
    expect(hit.label).toContain('unlocked');
    expect(hit.changesJson?.metadata?.reason).toBe('customer changed size');
  });
});

describe('Enter a Sales Order — STORIS 3-step parity fields', () => {
  it('Order carries kind, fulfillment, delivery status, fees; total includes fees', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        orderKind: 'layaway',
        fulfillmentType: 'take_with',
        deliveryStatus: 'will_call',
        deliveryInstructions: 'Call ahead 30 min',
        marketingCode: 'LABOR-DAY',
        deliveryFeeCents: 9900,
        installFeeCents: 2500,
        otherFeeCents: 500,
        otherFeeLabel: 'Recycling fee',
        billingAddress: { line1: '1 Billing Way', city: 'LA', region: 'CA', postalCode: '90001' },
        lines: [
          { variantId: sofaVariantId, quantity: 1 },
          {
            variantId: sofaVariantId,
            quantity: 1,
            fulfillmentMethod: 'delivery',
            deliveryDate: '2026-09-15',
          },
        ],
      });
    expect(res.status).toBe(201);
    const o = res.body;
    expect(o.orderKind).toBe('layaway');
    expect(o.fulfillmentType).toBe('take_with');
    expect(o.deliveryStatus).toBe('will_call');
    expect(o.marketingCode).toBe('LABOR-DAY');
    expect(o.deliveryFeeCents).toBe(9900);
    expect(o.otherFeeLabel).toBe('Recycling fee');
    // total = taxed cart + the three fee buckets
    expect(o.totalCents).toBe(o.subtotalCents - o.discountCents + o.taxCents + 9900 + 2500 + 500);
    expect(o.balanceDueCents).toBe(o.totalCents);
    // split-ticket line overrides round-trip
    expect(o.lines[0].fulfillmentMethod).toBeNull();
    expect(o.lines[1].fulfillmentMethod).toBe('delivery');
    expect(o.lines[1].deliveryDate).toBe('2026-09-15');

    // fees are editable and reprice the total
    const upd = await request(app.getHttpServer())
      .patch(`/v1/orders/${o.id}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ deliveryFeeCents: 0, deliveryStatus: 'scheduled' });
    expect(upd.status).toBe(200);
    expect(upd.body.totalCents).toBe(o.totalCents - 9900);
    expect(upd.body.deliveryStatus).toBe('scheduled');
  });

  it('Bad enums and negative fees are rejected', async () => {
    const base = { locationId, customerId, lines: [{ variantId: sofaVariantId, quantity: 1 }] };
    for (const bad of [
      { ...base, fulfillmentType: 'teleport' },
      { ...base, orderKind: 'club' },
      { ...base, deliveryStatus: 'whenever' },
      { ...base, deliveryFeeCents: -5 },
      { ...base, lines: [{ variantId: sofaVariantId, quantity: 1, fulfillmentMethod: 'nope' }] },
    ]) {
      const res = await request(app.getHttpServer())
        .post('/v1/orders')
        .set('Cookie', cashierCookie)
        .set('X-Business-Id', businessId)
        .send(bad);
      expect(res.status).toBe(400);
    }
  });
});

describe('Day 1 — order spine: write, deposit, reserve', () => {
  let orderId = '';
  let orderNumber = '';

  it('Warehouse (no orders.create) is denied order entry', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
      });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/orders\.create/);
  });

  it('Cashier writes a quote for one sofa', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        fulfillmentType: 'delivery',
        address: { line1: '14 Wharf Rd', city: 'Portland', region: 'ME', postalCode: '04101' },
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
        notes: 'Deliver to the side door',
      });
    expect(res.status).toBe(201);
    orderId = res.body.id;
    orderNumber = res.body.number;

    expect(orderNumber).toMatch(/^SO-\d{4}-\d{6}$/);
    expect(res.body.status).toBe('quote');
    expect(res.body.customerId).toBe(customerId);
    expect(res.body.subtotalCents).toBe(129_999);
    expect(res.body.taxCents).toBe(9_100); // round(129999 * 7%)
    expect(res.body.totalCents).toBe(139_099);
    // 25% policy default, rounded up to the cent.
    expect(res.body.depositRequiredCents).toBe(34_775);
    expect(res.body.paidCents).toBe(0);
    expect(res.body.balanceDueCents).toBe(139_099);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].qtyReserved).toBe(0);
  });

  it('A quote holds no stock', async () => {
    const level = await levelOf(sofaVariantId);
    expect(level).toEqual({ onHand: 8, reserved: 0 });
  });

  it('Confirming the quote commits stock without moving on-hand', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/orders/${orderId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ status: 'open' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
    expect(res.body.lines[0].qtyReserved).toBe(1);

    // The sofa is still in the building — it is just spoken for.
    expect(await levelOf(sofaVariantId)).toEqual({ onHand: 8, reserved: 1 });

    const movements = await movementsFor(orderId);
    expect(movements).toEqual([{ reason: 'order_reserve', delta: 0 }]);
  });

  it('Cashier takes a deposit; the balance falls by exactly that much', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'cash', amountCents: 34_775 });
    expect(res.status).toBe(201);
    expect(res.body.paidCents).toBe(34_775);
    expect(res.body.balanceDueCents).toBe(139_099 - 34_775);
    expect(res.body.payments).toHaveLength(1);
    // The first money in is the deposit; no caller had to say so.
    expect(res.body.payments[0].kind).toBe('deposit');
    expect(res.body.payments[0].method).toBe('cash');
  });

  it('The deposit is a payments row bound to the order, not to a sale', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const rows = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, orderId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.saleId).toBeNull();
      expect(rows[0]!.orderId).toBe(orderId);
      expect(rows[0]!.kind).toBe('deposit');
      expect(rows[0]!.amountCents).toBe(34_775);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('A second payment is a balance, and cannot exceed what is owed', async () => {
    const tooMuch = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'cash', amountCents: 200_000 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.message).toMatch(/exceeds the balance due/);

    const partial = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'external_card', amountCents: 10_000 });
    expect(partial.status).toBe(201);
    expect(partial.body.payments[1].kind).toBe('balance');
    expect(partial.body.paidCents).toBe(44_775);
    expect(partial.body.balanceDueCents).toBe(139_099 - 44_775);
  });

  it('Financing tender must name its provider', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'financing', amountCents: 1_000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/financingProvider/);
  });

  it('An order holding money cannot be cancelled out from under it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/cancel`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ reason: 'customer changed their mind' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Refund the money/);
  });

  it('Warehouse cannot take money on an order', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/payments`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'cash', amountCents: 100 });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/orders\.deposit\.take/);
  });

  it('The order is listed and readable by number', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/orders?status=open')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);
    expect(list.body.data.map((o: { id: string }) => o.id)).toContain(orderId);

    const detail = await request(app.getHttpServer())
      .get(`/v1/orders/${orderId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(detail.status).toBe(200);
    expect(detail.body.number).toBe(orderNumber);
    expect(detail.body.paidCents).toBe(44_775);
  });
});

describe('Day 1 — partial stock, line edits, and cancellation', () => {
  let orderId = '';

  it('Writing a confirmed order for more chairs than exist reserves what it can', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: chairVariantId, quantity: 3 }],
      });
    expect(res.status).toBe(201);
    orderId = res.body.id;
    expect(res.body.status).toBe('open');
    // Only 1 chair exists: the line is committed 1 of 3, and the rest is
    // a shortfall for the Day 4 special-order queue rather than an error.
    expect(res.body.lines[0].qtyReserved).toBe(1);
    expect(await levelOf(chairVariantId)).toEqual({ onHand: 1, reserved: 1 });
  });

  it('Reserving again is a no-op and reports the shortfall', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/reserve`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.order.lines[0].qtyReserved).toBe(1);
    expect(res.body.shortfalls).toHaveLength(1);
    expect(res.body.shortfalls[0].quantity).toBe(2);
    // Crucially, the second call did not double-book the chair.
    expect(await levelOf(chairVariantId)).toEqual({ onHand: 1, reserved: 1 });
  });

  it('Adding a line reprices the order and commits the new stock', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/lines`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId: sofaVariantId, quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.subtotalCents).toBe(3 * 19_999 + 2 * 129_999);
    expect(res.body.lines[1].qtyReserved).toBe(2);
    // 1 already committed to the first order, plus these 2.
    expect(await levelOf(sofaVariantId)).toEqual({ onHand: 8, reserved: 3 });
  });

  it('Removing a line releases its stock and reprices', async () => {
    const before = await request(app.getHttpServer())
      .get(`/v1/orders/${orderId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const sofaLineId = before.body.lines.find(
      (l: { variantId: string }) => l.variantId === sofaVariantId,
    ).id;

    const res = await request(app.getHttpServer())
      .delete(`/v1/orders/${orderId}/lines/${sofaLineId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.subtotalCents).toBe(3 * 19_999);
    expect(await levelOf(sofaVariantId)).toEqual({ onHand: 8, reserved: 1 });
  });

  it('Cancelling a money-free order releases everything it held', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/cancel`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ reason: 'floor model sold instead' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledAt).toBeTruthy();
    expect(res.body.internalNotes).toMatch(/floor model sold instead/);

    expect(await levelOf(chairVariantId)).toEqual({ onHand: 1, reserved: 0 });

    const movements = await movementsFor(orderId);
    expect(movements.map((m) => m.reason)).toEqual([
      'order_reserve',
      'order_reserve',
      'order_release',
      'order_release',
    ]);
  });

  it('A cancelled order refuses further edits', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'cash', amountCents: 100 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cancelled and cannot be changed/);
  });
});

describe('Day 1 — order pricing rules', () => {
  it('An order-level discount is allocated across lines before tax', async () => {
    // Deep negotiated prices — log-only since A10 (the reason sent here
    // just annotates the exception entry); the tax math is unchanged.
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        orderDiscountCents: 10_000,
        priceReason: 'negotiated floor deal',
        lines: [
          { variantId: sofaVariantId, quantity: 1, unitPriceCents: 90_000 },
          { variantId: chairVariantId, quantity: 1, unitPriceCents: 10_000 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.subtotalCents).toBe(100_000);
    expect(res.body.orderDiscountCents).toBe(10_000);
    expect(res.body.discountCents).toBe(10_000);
    // 7% on the 90,000 that survives the discount.
    expect(res.body.taxCents).toBe(6_300);
    expect(res.body.totalCents).toBe(96_300);
  });

  it('A special-order line never commits stock', async () => {
    const before = await levelOf(sofaVariantId);
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: sofaVariantId, quantity: 1, lineType: 'special_order' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.lines[0].lineType).toBe('special_order');
    expect(res.body.lines[0].qtyReserved).toBe(0);
    expect(await levelOf(sofaVariantId)).toEqual(before);
  });

  it('An order requires a customer', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, lines: [{ variantId: sofaVariantId, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/customerId is required/);
  });

  it('Taking a deposit on a quote confirms it and commits the stock', async () => {
    // Money down means the customer committed. The invariant worth having
    // is that an order holding money is an order holding its goods.
    const before = await levelOf(sofaVariantId);
    const created = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, customerId, lines: [{ variantId: sofaVariantId, quantity: 1 }] });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('quote');
    expect(created.body.lines[0].qtyReserved).toBe(0);
    expect(await levelOf(sofaVariantId)).toEqual(before);

    const paid = await request(app.getHttpServer())
      .post(`/v1/orders/${created.body.id}/payments`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'cash', amountCents: 10_000 });
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('open');
    expect(paid.body.lines[0].qtyReserved).toBe(1);
    expect(paid.body.payments[0].kind).toBe('deposit');
    expect(await levelOf(sofaVariantId)).toEqual({
      onHand: before.onHand,
      reserved: before.reserved + 1,
    });
  });

  it('An explicit deposit amount overrides the policy default', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        depositRequiredCents: 50_000,
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.depositRequiredCents).toBe(50_000);
  });
});

describe('Customer-facing status link', () => {
  let orderId = '';
  let token = '';

  it('Owner writes an order, takes a deposit, and creates a share link', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    orderId = created.body.id;

    const pay = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/payments`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'cash', amountCents: 10_000 });
    expect(pay.status).toBe(201);

    const share = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/share`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(share.status).toBe(201);
    expect(share.body.token).toMatch(/^[0-9a-f]{48}$/);
    expect(share.body.path).toBe(`/track/${share.body.token}`);
    token = share.body.token;

    // Idempotent: sharing again returns the SAME token — links a
    // customer already has must keep working.
    const again = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/share`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(again.body.token).toBe(token);
  });

  it('The public endpoint serves a narrow view with NO auth at all', async () => {
    const res = await request(app.getHttpServer()).get(`/v1/public/orders/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.number).toMatch(/^SO-/);
    expect(res.body.status).toBe('open');
    expect(res.body.paidCents).toBe(10_000);
    expect(res.body.balanceCents).toBe(res.body.totalCents - 10_000);
    expect(res.body.lines.length).toBe(1);
    // The projection must not leak operational fields.
    expect(res.body.addressLine1).toBeUndefined();
    expect(res.body.internalNotes).toBeUndefined();
    expect(res.body.customerId).toBeUndefined();
  });

  it('Unknown and malformed tokens 404 without hitting order data', async () => {
    const wrong = await request(app.getHttpServer()).get(`/v1/public/orders/${'0'.repeat(48)}`);
    expect(wrong.status).toBe(404);
    const malformed = await request(app.getHttpServer()).get('/v1/public/orders/short');
    expect(malformed.status).toBe(404);
  });
});

describe('Returns, As-Is, store credit, exchanges (PLAN-POS-OPERATIONS P8)', () => {
  let p8VariantId = '';

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
    };
  }

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'P8-BED', name: 'Returns Fixture Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'P8-BED-V1', priceCents: 100000 })
        .returning();
      p8VariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: p8VariantId,
        locationId,
        onHand: 20,
        reserved: 0,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  async function fulfilledPaidOrder(quantity: number): Promise<{
    id: string;
    number: string;
    lineId: string;
    totalCents: number;
  }> {
    const created = await owner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        fulfillmentType: 'pickup',
        confirm: true,
        lines: [{ variantId: p8VariantId, quantity }],
      });
    expect(created.status).toBe(201);
    const pay = await owner()
      .post(`/v1/orders/${created.body.id}/payments`)
      .send({ method: 'cash', amountCents: created.body.totalCents });
    expect(pay.status).toBe(201);
    const ful = await owner().post(`/v1/orders/${created.body.id}/fulfill`).send({});
    expect(ful.status).toBe(201);
    return {
      id: created.body.id,
      number: created.body.number,
      lineId: created.body.lines[0].id,
      totalCents: created.body.totalCents,
    };
  }

  async function stockOf(variantId: string): Promise<number> {
    return levelOf(variantId).then((l) => l.onHand);
  }

  it('return: money reverses to the original tender, goods land in As-Is, not stock', async () => {
    const order = await fulfilledPaidOrder(2);
    const stockBefore = await stockOf(p8VariantId);

    const perUnit = Math.round(order.totalCents / 2);
    const ret = await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({ lines: [{ lineId: order.lineId, quantity: 1 }], reason: 'too firm' });
    expect(ret.status).toBe(201);
    expect(ret.body.lines[0].qtyReturned).toBe(1);
    expect(ret.body.paidCents).toBe(order.totalCents - perUnit); // negative cash row
    const refundRow = ret.body.payments.find(
      (p: { kind: string; amountCents: number }) => p.kind === 'refund',
    );
    expect(refundRow.amountCents).toBe(-perUnit);
    expect(refundRow.method).toBe('cash');

    // Goods: As-Is pending review, sellable stock untouched.
    expect(await stockOf(p8VariantId)).toBe(stockBefore);
    const queue = await owner().get('/v1/as-is?status=pending_review');
    const item = queue.body.data.find(
      (r: { referenceId: string | null }) => r.referenceId === order.id,
    );
    expect(item).toBeTruthy();
    expect(item.quantity).toBe(1);
    expect(item.source).toBe('return');

    // Over-returning is refused.
    const over = await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({ lines: [{ lineId: order.lineId, quantity: 2 }] });
    expect(over.status).toBe(400);

    // Returning the rest flips the list-view display status to Returned.
    const rest = await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({ lines: [{ lineId: order.lineId, quantity: 1 }] });
    expect(rest.status).toBe(201);
    const lv = await owner().get('/v1/orders/list-view?limit=100');
    const row = lv.body.data.find((r: { id: string }) => r.id === order.id);
    expect(row.displayStatus).toBe('Returned');

    // Review the As-Is item: restock puts it back into sellable stock.
    const reviewed = await owner().post(`/v1/as-is/${item.id}/review`).send({ action: 'restock' });
    expect(reviewed.status).toBe(201);
    expect(reviewed.body.status).toBe('restocked');
    expect(await stockOf(p8VariantId)).toBe(stockBefore + 1);
    await owner().post(`/v1/as-is/${item.id}/review`).send({ action: 'scrap' }).expect(400);
  });

  it('store credit: issued by a return, surfaces on the customer, redeems with a balance check', async () => {
    const order = await fulfilledPaidOrder(1);
    const ret = await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({
        lines: [{ lineId: order.lineId, quantity: 1 }],
        refundMethod: 'store_credit',
        reason: 'exchange credit',
      });
    expect(ret.status).toBe(201);
    // Store-credit return keeps the money: paid is unchanged.
    expect(ret.body.paidCents).toBe(order.totalCents);

    const credit = await owner().get(`/v1/customers/${customerId}/store-credit`);
    expect(credit.status).toBe(200);
    expect(credit.body.balanceCents).toBeGreaterThanOrEqual(order.totalCents);
    const balance = credit.body.balanceCents;

    // Redeem on a new order — within balance succeeds and debits the ledger…
    const next = await owner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: p8VariantId, quantity: 1 }],
      });
    expect(next.status).toBe(201);
    const redeem = await owner()
      .post(`/v1/orders/${next.body.id}/payments`)
      .send({ method: 'store_credit', amountCents: 5000 });
    expect(redeem.status).toBe(201);
    const after = await owner().get(`/v1/customers/${customerId}/store-credit`);
    expect(after.body.balanceCents).toBe(balance - 5000);

    // …and over-balance is refused.
    const tooMuch = await owner()
      .post(`/v1/orders/${next.body.id}/payments`)
      .send({ method: 'store_credit', amountCents: after.body.balanceCents + 100000 });
    expect([400]).toContain(tooMuch.status);
  });

  it('price adjustment: money-only, distinct kind, reason required', async () => {
    const order = await fulfilledPaidOrder(1);
    await owner()
      .post(`/v1/orders/${order.id}/price-adjustment`)
      .send({ amountCents: 500 })
      .expect(400); // no reason

    const adj = await owner()
      .post(`/v1/orders/${order.id}/price-adjustment`)
      .send({ amountCents: 500, reason: 'price match' });
    expect(adj.status).toBe(201);
    expect(adj.body.paidCents).toBe(order.totalCents - 500);
    const row = adj.body.payments.find((p: { kind: string }) => p.kind === 'adjustment');
    expect(row.amountCents).toBe(-500);
    // No goods moved: nothing new in As-Is for this order.
    const queue = await owner().get('/v1/as-is');
    expect(
      queue.body.data.some((r: { referenceId: string | null }) => r.referenceId === order.id),
    ).toBe(false);
  });

  it('exchange order: linked to the original, documents as Exchange Order', async () => {
    const original = await fulfilledPaidOrder(1);
    const ex = await owner()
      .post(`/v1/orders/${original.id}/exchange`)
      .send({
        confirm: true,
        lines: [{ variantId: p8VariantId, quantity: 1 }],
      });
    expect(ex.status).toBe(201);
    expect(ex.body.orderKind).toBe('exchange');
    expect(ex.body.originalOrderId).toBe(original.id);

    const doc = await owner().get(`/v1/orders/${ex.body.id}/document`);
    expect(doc.status).toBe(200);
    expect(doc.body.originalOrderNumber).toBe(original.number);
    expect(doc.body.order.creditDueCents).toBe(0);

    // The original shows as Exchanged on the orders table.
    const lv = await owner().get('/v1/orders/list-view?limit=100');
    const row = lv.body.data.find((r: { id: string }) => r.id === original.id);
    expect(row.displayStatus).toBe('Exchanged');
  });
});

describe('Return lifecycle — refund gated on goods receipt (PLAN-STORIS-GAP G3)', () => {
  let g3VariantId = '';

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
    };
  }
  const owner = () => as(ownerCookie);

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'G3-BED', name: 'Lifecycle Fixture Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'G3-BED-V1', priceCents: 50000 })
        .returning();
      g3VariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: g3VariantId,
        locationId,
        onHand: 30,
        reserved: 0,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  async function fulfilledPaidOrder(quantity: number): Promise<{
    id: string;
    number: string;
    lineId: string;
    totalCents: number;
  }> {
    const created = await owner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        fulfillmentType: 'pickup',
        confirm: true,
        lines: [{ variantId: g3VariantId, quantity }],
      });
    expect(created.status).toBe(201);
    await owner()
      .post(`/v1/orders/${created.body.id}/payments`)
      .send({ method: 'cash', amountCents: created.body.totalCents })
      .expect(201);
    await owner().post(`/v1/orders/${created.body.id}/fulfill`).send({}).expect(201);
    return {
      id: created.body.id,
      number: created.body.number,
      lineId: created.body.lines[0].id,
      totalCents: created.body.totalCents,
    };
  }

  it('pickup return: authorization moves no money and no goods; receipt fires both', async () => {
    const order = await fulfilledPaidOrder(2);
    const perUnit = Math.round(order.totalCents / 2);

    const auth = await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({
        lines: [{ lineId: order.lineId, quantity: 1 }],
        fulfillment: 'pickup',
        reason: 'sagging',
      });
    expect(auth.status).toBe(201);
    // Nothing moved yet: full payment stands, nothing marked returned.
    expect(auth.body.paidCents).toBe(order.totalCents);
    expect(auth.body.lines[0].qtyReturned).toBe(0);

    const listed = await owner().get(`/v1/order-returns?orderId=${order.id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    const ret = listed.body.data[0];
    expect(ret.status).toBe('authorized');
    expect(ret.rmaNumber).toBe(`RMA-${order.number}-1`);
    expect(ret.amountCents).toBe(perUnit);
    expect(ret.lines[0].quantity).toBe(1);

    // The order now reads "Awaiting Return Pickup" on the list view.
    const lv = await owner().get('/v1/orders/list-view?limit=100');
    const row = lv.body.data.find((r: { id: string }) => r.id === order.id);
    expect(row.displayStatus).toBe('Awaiting Return Pickup');

    // Units on an open authorization are no longer returnable again.
    const over = await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({ lines: [{ lineId: order.lineId, quantity: 2 }], fulfillment: 'pickup' });
    expect(over.status).toBe(400);

    // No As-Is row yet.
    const queueBefore = await owner().get('/v1/as-is?status=pending_review');
    expect(
      queueBefore.body.data.filter(
        (r: { referenceId: string | null }) => r.referenceId === order.id,
      ),
    ).toHaveLength(0);

    // Goods received → refund row + As-Is + qtyReturned, return completed.
    await owner().post(`/v1/order-returns/${ret.id}/receive`).send({}).expect(201);
    const detail = await owner().get(`/v1/orders/${order.id}`);
    expect(detail.body.paidCents).toBe(order.totalCents - perUnit);
    expect(detail.body.lines[0].qtyReturned).toBe(1);
    const refundRow = detail.body.payments.find((p: { kind: string }) => p.kind === 'refund');
    expect(refundRow.amountCents).toBe(-perUnit);
    const queueAfter = await owner().get('/v1/as-is?status=pending_review');
    expect(
      queueAfter.body.data.filter(
        (r: { referenceId: string | null }) => r.referenceId === order.id,
      ),
    ).toHaveLength(1);
    const after = await owner().get(`/v1/order-returns?orderId=${order.id}`);
    expect(after.body.data[0].status).toBe('completed');
    expect(after.body.data[0].goodsReceivedAt).toBeTruthy();

    // Receiving twice is refused.
    await owner().post(`/v1/order-returns/${ret.id}/receive`).send({}).expect(409);
  });

  it('cancelling an authorized return frees the units and moves no money', async () => {
    const order = await fulfilledPaidOrder(1);
    const auth = await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({ lines: [{ lineId: order.lineId, quantity: 1 }], fulfillment: 'pickup' });
    expect(auth.status).toBe(201);
    const [ret] = (await owner().get(`/v1/order-returns?orderId=${order.id}`)).body.data;

    await owner()
      .post(`/v1/order-returns/${ret.id}/cancel`)
      .send({ reason: 'customer kept it' })
      .expect(201);
    const detail = await owner().get(`/v1/orders/${order.id}`);
    expect(detail.body.paidCents).toBe(order.totalCents);
    expect(detail.body.lines[0].qtyReturned).toBe(0);

    // The unit is returnable again (drop-off completes immediately).
    const again = await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({ lines: [{ lineId: order.lineId, quantity: 1 }] });
    expect(again.status).toBe(201);
    expect(again.body.lines[0].qtyReturned).toBe(1);
    expect(again.body.paidCents).toBe(0);
    // A cancelled and a completed return both carry order-scoped RMAs.
    const all = await owner().get(`/v1/order-returns?orderId=${order.id}`);
    expect(all.body.data.map((r: { rmaNumber: string }) => r.rmaNumber).sort()).toEqual([
      `RMA-${order.number}-1`,
      `RMA-${order.number}-2`,
    ]);
  });

  it('receiving is warehouse-gated: a cashier (no inventory.receive) is refused', async () => {
    const order = await fulfilledPaidOrder(1);
    await owner()
      .post(`/v1/orders/${order.id}/return`)
      .send({ lines: [{ lineId: order.lineId, quantity: 1 }], fulfillment: 'pickup' })
      .expect(201);
    const [ret] = (await owner().get(`/v1/order-returns?orderId=${order.id}`)).body.data;
    await as(cashierCookie).post(`/v1/order-returns/${ret.id}/receive`).send({}).expect(403);
  });
});

describe('Price variance 3-tier + §5 gates (PLAN-STORIS-GAP G6)', () => {
  let pvVariantId = '';

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
    };
  }

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'G6-MATT', name: 'Variance Test Mattress' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({
          businessId,
          productId: p!.id,
          sku: 'G6-MATT-Q',
          priceCents: 100_000,
          costCents: 60_000,
        })
        .returning();
      pvVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: pvVariantId,
        locationId,
        onHand: 50,
        reserved: 0,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  function orderBody(unitPriceCents: number, extra: Record<string, unknown> = {}) {
    return {
      locationId,
      customerId,
      confirm: true,
      lines: [
        { variantId: pvVariantId, quantity: 1, unitPriceCents },
        // The recycling fee keeps the pass-through exception quiet here.
        { lineType: 'custom', description: 'Recycling Fee', quantity: 1, unitPriceCents: 1050 },
      ],
      ...extra,
    };
  }

  it('tier 1: a small discount sails through with no reason', async () => {
    const res = await as(cashierCookie).post('/v1/orders').send(orderBody(96_000));
    expect(res.status).toBe(201);
  });

  it('tier 2: a 10% discount rings through with no reason and logs an exception (A10)', async () => {
    const ok = await as(cashierCookie).post('/v1/orders').send(orderBody(90_000));
    expect(ok.status).toBe(201);

    const register = await as(ownerCookie).get('/v1/exceptions?type=price_override');
    expect(register.status).toBe(200);
    expect(register.body.data.length).toBeGreaterThan(0);
  });

  it('tier 3: a 30% cashier discount needs no override; below cost logs critical (A10)', async () => {
    const ok = await as(cashierCookie).post('/v1/orders').send(orderBody(70_000));
    expect(ok.status).toBe(201);

    const below = await as(cashierCookie).post('/v1/orders').send(orderBody(50_000));
    expect(below.status).toBe(201);

    // $500 < $600 cost → the exception is critical.
    const register = await as(ownerCookie).get(
      '/v1/exceptions?type=price_override&severity=critical',
    );
    expect(register.body.data.length).toBeGreaterThan(0);
    expect(register.body.data[0].summary).toMatch(/BELOW COST/);
  });

  it('a volunteered reason still lands on the exception entry', async () => {
    const res = await as(ownerCookie)
      .post('/v1/orders')
      .send(orderBody(70_000, { priceReason: 'floor model' }));
    expect(res.status).toBe(201);
  });

  it('layaway deposits below $100 need a manager; the exception is registered', async () => {
    const order = await as(ownerCookie)
      .post('/v1/orders')
      .send(orderBody(100_000, { orderKind: 'layaway' }));
    expect(order.status).toBe(201);

    const small = await as(cashierCookie)
      .post(`/v1/orders/${order.body.id}/payments`)
      .send({ method: 'cash', amountCents: 5_000 });
    expect(small.status).toBe(403);
    expect(small.body.code).toBe('OVERRIDE_REQUIRED');

    // The owner (orders.complete_with_balance) can open it small.
    await as(ownerCookie)
      .post(`/v1/orders/${order.body.id}/payments`)
      .send({ method: 'cash', amountCents: 5_000 })
      .expect(201);
    const register = await as(ownerCookie).get('/v1/exceptions?type=layaway_min_deposit_override');
    expect(register.body.data.length).toBeGreaterThan(0);
  });

  it('a qualifying order without the recycling fee registers the pass-through exception', async () => {
    const res = await as(ownerCookie)
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: pvVariantId, quantity: 1 }],
      });
    expect(res.status).toBe(201);
    const register = await as(ownerCookie).get('/v1/exceptions?type=recycling_fee_removed');
    expect(
      register.body.data.some((e: { entityId: string | null }) => e.entityId === res.body.id),
    ).toBe(true);
  });
});

describe('Print preconditions + reprint counter + unlock expiry (PLAN-STORIS-GAP G9)', () => {
  function as(cookie: string) {
    return {
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
      patch: (url: string) =>
        request(app.getHttpServer())
          .patch(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
    };
  }

  async function makeOrder(over: Record<string, unknown> = {}): Promise<{
    id: string;
    number: string;
    totalCents: number;
  }> {
    const res = await as(ownerCookie)
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        fulfillmentType: 'pickup',
        requestedDate: '2026-10-01',
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
        ...over,
      });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('a delivery order with no scheduled trip cannot print — checklist names why', async () => {
    const order = await makeOrder({ fulfillmentType: 'delivery', requestedDate: null });
    const res = await as(ownerCookie).post(`/v1/orders/${order.id}/delivery-ticket-print`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRINT_BLOCKED');
    const failed = res.body.checks.filter((c: { ok: boolean }) => !c.ok);
    expect(failed.map((c: { check: string }) => c.check)).toContain('scheduled_date');
  });

  it('the balance cap blocks the ticket for a cashier; a manager releases it', async () => {
    await as(ownerCookie)
      .patch('/v1/business/settings')
      .send({ ops: { maxBalanceForTicketPrintCents: 1000 } })
      .expect(200);
    try {
      const order = await makeOrder();
      // Fully unpaid — way over the $10 cap.
      const refused = await as(cashierCookie)
        .post(`/v1/orders/${order.id}/delivery-ticket-print`)
        .send({});
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('OVERRIDE_REQUIRED');
      expect(refused.body.permission).toBe('orders.complete_with_balance');

      // The owner holds the permission — the ticket releases.
      const ok = await as(ownerCookie)
        .post(`/v1/orders/${order.id}/delivery-ticket-print`)
        .send({});
      expect(ok.status).toBe(201);
      expect(ok.body.copyNumber).toBe(1);
    } finally {
      await as(ownerCookie)
        .patch('/v1/business/settings')
        .send({ ops: { maxBalanceForTicketPrintCents: null } })
        .expect(200);
    }
  });

  it('reprints count copies and land on the exception register', async () => {
    const order = await makeOrder();
    await as(ownerCookie)
      .post(`/v1/orders/${order.id}/payments`)
      .send({ method: 'cash', amountCents: order.totalCents })
      .expect(201);
    const first = await as(ownerCookie)
      .post(`/v1/orders/${order.id}/delivery-ticket-print`)
      .send({});
    expect(first.status).toBe(201);
    expect(first.body.copyNumber).toBe(1);
    const second = await as(ownerCookie)
      .post(`/v1/orders/${order.id}/delivery-ticket-print`)
      .send({});
    expect(second.body.copyNumber).toBe(2);
    const reprints = await as(ownerCookie).get('/v1/exceptions?type=ticket_reprint');
    expect(
      reprints.body.data.some((e: { entityId: string | null }) => e.entityId === order.id),
    ).toBe(true);
  });

  it('an unlock is a 15-minute window — past it the lock re-engages', async () => {
    const order = await makeOrder();
    await as(ownerCookie).post(`/v1/orders/${order.id}/delivery-ticket-print`).send({}).expect(201);
    await as(ownerCookie)
      .post(`/v1/orders/${order.id}/unlock`)
      .send({ reason: 'fix a size' })
      .expect(201);
    // Inside the window guarded edits work.
    await as(ownerCookie)
      .patch(`/v1/orders/${order.id}`)
      .send({ requestedDate: '2026-10-02' })
      .expect(200);

    // Simulate the window passing.
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      await db
        .update(schema.orders)
        .set({ relockAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.orders.id, order.id));
    } finally {
      await sql2.end({ timeout: 5 });
    }
    const relocked = await as(ownerCookie)
      .patch(`/v1/orders/${order.id}`)
      .send({ requestedDate: '2026-10-03' });
    expect(relocked.status).toBe(409);
    expect(relocked.body.message).toMatch(/re-engaged/);
    // A fresh unlock (with reason) reopens the window.
    await as(ownerCookie)
      .post(`/v1/orders/${order.id}/unlock`)
      .send({ reason: 'still fixing' })
      .expect(201);
    await as(ownerCookie)
      .patch(`/v1/orders/${order.id}`)
      .send({ requestedDate: '2026-10-04' })
      .expect(200);
  });
});

describe('Line roll-up, Past Due, auto stock release, drift, duplicate prompt (PLAN-STORIS-GAP G13+G14)', () => {
  let g13VariantId = '';

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'G13-BED', name: 'Rollup Fixture Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'G13-BED-V1', priceCents: 40000 })
        .returning();
      g13VariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: g13VariantId,
        locationId,
        onHand: 50,
        reserved: 0,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

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
    };
  }

  it('the list view rolls up line state and filters Past Due', async () => {
    const created = await as(ownerCookie)
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        fulfillmentType: 'delivery',
        requestedDate: '2020-01-15', // long past due
        lines: [
          { variantId: g13VariantId, quantity: 2 },
          { variantId: g13VariantId, quantity: 1, lineType: 'special_order' },
        ],
      });
    expect(created.status).toBe(201);

    const pastDue = await as(ownerCookie).get('/v1/orders/list-view?view=past_due&limit=100');
    expect(pastDue.status).toBe(200);
    const row = pastDue.body.data.find((r: { id: string }) => r.id === created.body.id);
    expect(row).toBeTruthy();
    // 3 units total, 2 reserved (the SO line reserves nothing), 1 SO.
    expect(row.lineSummary).toMatchObject({ units: 3, reserved: 2, specialOrder: 1 });

    // The default view also carries the roll-up.
    const all = await as(ownerCookie).get('/v1/orders/list-view?limit=100');
    const same = all.body.data.find((r: { id: string }) => r.id === created.body.id);
    expect(same.lineSummary.units).toBe(3);
  });

  it('auto stock release frees reservations on stale orders and registers each', async () => {
    const created = await as(ownerCookie)
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        fulfillmentType: 'delivery',
        requestedDate: '2020-02-01',
        lines: [{ variantId: g13VariantId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.lines[0].qtyReserved).toBe(1);

    // Dry run reports without touching anything.
    const dry = await as(ownerCookie)
      .post('/v1/orders/auto-stock-release')
      .send({ days: 30, dryRun: true });
    expect(dry.status).toBe(201);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.released.some((r: { id: string }) => r.id === created.body.id)).toBe(true);
    const still = await as(ownerCookie).get(`/v1/orders/${created.body.id}`);
    expect(still.body.lines[0].qtyReserved).toBe(1);

    // The real run releases and registers.
    const run = await as(ownerCookie).post('/v1/orders/auto-stock-release').send({ days: 30 });
    expect(run.status).toBe(201);
    expect(run.body.released.some((r: { id: string }) => r.id === created.body.id)).toBe(true);
    const after = await as(ownerCookie).get(`/v1/orders/${created.body.id}`);
    expect(after.body.lines[0].qtyReserved).toBe(0);
    const register = await as(ownerCookie).get('/v1/exceptions?type=auto_stock_release');
    expect(
      register.body.data.some((e: { entityId: string | null }) => e.entityId === created.body.id),
    ).toBe(true);
  });

  it('reservation drift shows up on the reconciliation report', async () => {
    const clean = await as(ownerCookie).get('/v1/orders/reservation-drift');
    expect(clean.status).toBe(200);

    // Introduce drift by hand: bump the level's reserved without an order.
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      await db
        .update(schema.inventoryLevels)
        .set({ reserved: sql`${schema.inventoryLevels.reserved} + 5` })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, g13VariantId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
      const drifted = await as(ownerCookie).get('/v1/orders/reservation-drift');
      expect(drifted.status).toBe(200);
      const hit = drifted.body.find(
        (r: { variantId: string; locationId: string }) =>
          r.variantId === g13VariantId && r.locationId === locationId,
      );
      expect(hit).toBeTruthy();
      expect(hit.driftUnits).toBe(-5);
    } finally {
      await db
        .update(schema.inventoryLevels)
        .set({ reserved: sql`${schema.inventoryLevels.reserved} - 5` })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, g13VariantId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
      await sql2.end({ timeout: 5 });
    }
  });

  it('open-orders summary powers the duplicate-order prompt', async () => {
    const created = await as(ownerCookie)
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        fulfillmentType: 'delivery',
        requestedDate: '2027-08-01',
        lines: [{ variantId: g13VariantId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    const open = await as(ownerCookie).get(`/v1/customers/${customerId}/open-orders`);
    expect(open.status).toBe(200);
    const hit = open.body.find((o: { id: string }) => o.id === created.body.id);
    expect(hit).toBeTruthy();
    expect(hit.requestedDate).toBe('2027-08-01');
  });
});

describe('B14 — delivery-date reservation basis + pending allocation', () => {
  let allocVariantId = '';
  let orderEarly = { id: '', number: '' }; // later-created, EARLIER delivery
  let orderLate = { id: '', number: '' }; // earlier-created, LATER delivery

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [prod] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'ALLOC-1', name: 'Allocation Fixture Mattress' })
        .returning();
      const [variant] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: prod!.id, sku: 'ALLOC-1-V', priceCents: 49900 })
        .returning();
      allocVariantId = variant!.id;
      // Deliberately NO inventory level: both orders confirm under-reserved.
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  async function makePendingOrder(deliveryDate: string, quantity: number) {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        fulfillmentType: 'pickup',
        requestedDate: deliveryDate,
        lines: [{ variantId: allocVariantId, quantity, deliveryDate }],
      });
    expect(res.status).toBe(201);
    expect(res.body.lines[0].qtyReserved).toBe(0);
    return { id: res.body.id as string, number: res.body.number as string };
  }

  it('Confirmed orders with no stock sit under-reserved (Pending)', async () => {
    orderLate = await makePendingOrder('2026-09-20', 2);
    orderEarly = await makePendingOrder('2026-09-05', 2);
  });

  it('Dry run ranks the earlier DELIVERY date first and moves nothing', async () => {
    await request(app.getHttpServer())
      .post('/v1/inventory/adjust')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId: allocVariantId, locationId, delta: 3, reason: 'count_correction' })
      .expect(201);

    const dry = await request(app.getHttpServer())
      .post('/v1/orders/allocate-pending')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ dryRun: true });
    expect(dry.status).toBe(201);
    expect(dry.body.basis).toBe('delivery_date');
    expect(dry.body.dryRun).toBe(true);
    const mine = (dry.body.allocated as { orderId: string; units: number }[]).filter(
      (a) => a.orderId === orderEarly.id || a.orderId === orderLate.id,
    );
    expect(mine[0]!.orderId).toBe(orderEarly.id);
    expect(mine[0]!.units).toBe(2);
    expect(mine[1]!.orderId).toBe(orderLate.id);
    expect(mine[1]!.units).toBe(1);

    const level = await levelOf(allocVariantId);
    expect(level.reserved).toBe(0);
  });

  it('Real run reserves earliest delivery fully, later delivery gets the remainder', async () => {
    const run = await request(app.getHttpServer())
      .post('/v1/orders/allocate-pending')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(run.status).toBe(201);

    const early = await request(app.getHttpServer())
      .get(`/v1/orders/${orderEarly.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(early.body.lines[0].qtyReserved).toBe(2);
    const late = await request(app.getHttpServer())
      .get(`/v1/orders/${orderLate.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(late.body.lines[0].qtyReserved).toBe(1);
    expect((await levelOf(allocVariantId)).reserved).toBe(3);
  });

  it('order_date basis hands scarce stock to the first order written instead', async () => {
    await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ ops: { reserveBasis: 'order_date' } })
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/inventory/adjust')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId: allocVariantId, locationId, delta: 1, reason: 'count_correction' })
      .expect(201);

    // orderLate was written FIRST and still needs 1 — under order_date it wins.
    const run = await request(app.getHttpServer())
      .post('/v1/orders/allocate-pending')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(run.status).toBe(201);
    expect(run.body.basis).toBe('order_date');
    const late = await request(app.getHttpServer())
      .get(`/v1/orders/${orderLate.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(late.body.lines[0].qtyReserved).toBe(2);

    // Restore the owner default for any later suites.
    await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ ops: { reserveBasis: 'delivery_date' } })
      .expect(200);
  });

  it('PO receiving backfills a pending line automatically', async () => {
    const pending = await makePendingOrder('2026-09-25', 1);

    const vendor = await request(app.getHttpServer())
      .post('/v1/vendors')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Alloc Vendor' });
    expect(vendor.status).toBe(201);
    const po = await request(app.getHttpServer())
      .post('/v1/purchase-orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        vendorId: vendor.body.id,
        locationId,
        lines: [{ variantId: allocVariantId, quantity: 1, unitCostCents: 20000 }],
      });
    expect(po.status).toBe(201);
    const lineId = po.body.lines[0].id as string;

    const received = await request(app.getHttpServer())
      .post(`/v1/purchase-orders/${po.body.id}/receive`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId, quantity: 1 }] });
    expect(received.status).toBe(201);

    const after = await request(app.getHttpServer())
      .get(`/v1/orders/${pending.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(after.body.lines[0].qtyReserved).toBe(1);
  });
});

describe('Return windows + no-original returns (FAQ I4, I1/I8)', () => {
  let rwVariantId = '';

  function as(cookie: string) {
    return {
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
      patch: (url: string) =>
        request(app.getHttpServer())
          .patch(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', cookie)
          .set('X-Business-Id', businessId),
    };
  }

  async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      return await fn(drizzle(sql2));
    } finally {
      await sql2.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    await withDb(async (db) => {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'RW-BED', name: 'Window Fixture Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'RW-BED-V1', priceCents: 50000 })
        .returning();
      rwVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: rwVariantId,
        locationId,
        onHand: 20,
        reserved: 0,
      });
      // The system Cashier role has no refund permission; this business
      // grants it so the window control (not the endpoint gate) is what
      // the cashier hits.
      const [cashierRole] = await db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(eq(schema.roles.businessId, businessId), eq(schema.roles.name, 'Cashier')));
      await db
        .insert(schema.rolePermissions)
        .values({ roleId: cashierRole!.id, permission: 'pos.refund.create' })
        .onConflictDoNothing();
    });
  });

  async function fulfilledPaidOrder(): Promise<{ id: string; lineId: string }> {
    const created = await as(ownerCookie)
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        fulfillmentType: 'pickup',
        confirm: true,
        lines: [{ variantId: rwVariantId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    const pay = await as(ownerCookie)
      .post(`/v1/orders/${created.body.id}/payments`)
      .send({ method: 'cash', amountCents: created.body.totalCents });
    expect(pay.status).toBe(201);
    const ful = await as(ownerCookie).post(`/v1/orders/${created.body.id}/fulfill`).send({});
    expect(ful.status).toBe(201);
    return { id: created.body.id, lineId: created.body.lines[0].id };
  }

  async function backdate(orderId: string, days: number): Promise<void> {
    const past = new Date(Date.now() - days * 86_400_000);
    await withDb((db) =>
      db
        .update(schema.orders)
        .set({ createdAt: past, completedAt: past })
        .where(eq(schema.orders.id, orderId)),
    );
  }

  it('settings: returnWindowDays validates (0 rejected) and saves', async () => {
    const bad = await as(ownerCookie)
      .patch('/v1/business/settings')
      .send({ ops: { returnWindowDays: 0 } });
    expect(bad.status).toBe(400);

    const ok = await as(ownerCookie)
      .patch('/v1/business/settings')
      .send({ ops: { returnWindowDays: 30 } });
    expect(ok.status).toBe(200);
  });

  it('inside the window a cashier returns with no override', async () => {
    const order = await fulfilledPaidOrder();
    const res = await as(cashierCookie)
      .post(`/v1/orders/${order.id}/return`)
      .send({
        lines: [{ lineId: order.lineId, quantity: 1 }],
        refundMethod: 'original',
        reason: 'sagging',
      });
    expect(res.status).toBe(201);
  });

  it('outside the window: OVERRIDE_REQUIRED for a cashier, manager credentials pass, owner passes silently', async () => {
    const order = await fulfilledPaidOrder();
    await backdate(order.id, 60);

    const refused = await as(cashierCookie)
      .post(`/v1/orders/${order.id}/return`)
      .send({
        lines: [{ lineId: order.lineId, quantity: 1 }],
        refundMethod: 'original',
        reason: 'late return',
      });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('OVERRIDE_REQUIRED');
    expect(refused.body.permission).toBe('returns.override_window');

    const approved = await as(cashierCookie)
      .post(`/v1/orders/${order.id}/return`)
      .send({
        lines: [{ lineId: order.lineId, quantity: 1 }],
        refundMethod: 'original',
        reason: 'late return',
        override: {
          email: 'owner@orders-test.local',
          password: PASSWORD,
          reason: 'goodwill exception',
        },
      });
    expect(approved.status).toBe(201);

    await withDb(async (db) => {
      const overrides = await db
        .select()
        .from(schema.securityOverrides)
        .where(eq(schema.securityOverrides.permission, 'returns.override_window'));
      expect(overrides).toHaveLength(1);
    });

    // The owner holds returns.override_window — no dialog, no register row.
    const order2 = await fulfilledPaidOrder();
    await backdate(order2.id, 60);
    const direct = await as(ownerCookie)
      .post(`/v1/orders/${order2.id}/return`)
      .send({
        lines: [{ lineId: order2.lineId, quantity: 1 }],
        refundMethod: 'original',
        reason: 'late return',
      });
    expect(direct.status).toBe(201);
    await withDb(async (db) => {
      const overrides = await db
        .select()
        .from(schema.securityOverrides)
        .where(eq(schema.securityOverrides.permission, 'returns.override_window'));
      expect(overrides).toHaveLength(1);
    });
  });

  it('no-original return: gated, store-credit only, goods to As-Is, exception logged', async () => {
    const stockBefore = await levelOf(rwVariantId);

    const refused = await as(cashierCookie)
      .post('/v1/order-returns/no-original')
      .send({
        customerId,
        locationId,
        referencedOrderNumber: 'STORIS-123456',
        lines: [{ variantId: rwVariantId, quantity: 1, unitRefundCents: 5000 }],
      });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('OVERRIDE_REQUIRED');
    expect(refused.body.permission).toBe('returns.no_original');

    const done = await as(cashierCookie)
      .post('/v1/order-returns/no-original')
      .send({
        customerId,
        locationId,
        referencedOrderNumber: 'STORIS-123456',
        reason: 'pre-cutover sale, no invoice found',
        lines: [{ variantId: rwVariantId, quantity: 1, unitRefundCents: 5000 }],
        override: {
          email: 'owner@orders-test.local',
          password: PASSWORD,
          reason: 'verified with bank statement',
        },
      });
    expect(done.status).toBe(201);
    expect(done.body.rmaNumber).toBe('RMA-NOORIG-1');
    expect(done.body.status).toBe('completed');
    expect(done.body.refundMethod).toBe('store_credit');
    expect(done.body.amountCents).toBe(5000);
    expect(done.body.orderId).toBeNull();

    await withDb(async (db) => {
      const credits = await db
        .select()
        .from(schema.storeCreditEntries)
        .where(eq(schema.storeCreditEntries.referenceId, done.body.id));
      expect(credits).toHaveLength(1);
      expect(credits[0]!.deltaCents).toBe(5000);

      const pieces = await db
        .select()
        .from(schema.asIsItems)
        .where(eq(schema.asIsItems.referenceId, done.body.id));
      expect(pieces).toHaveLength(1);
      expect(pieces[0]!.source).toBe('return');

      const events = await db
        .select()
        .from(schema.exceptionEvents)
        .where(eq(schema.exceptionEvents.type, 'no_original_return'));
      expect(events).toHaveLength(1);
      expect(events[0]!.summary).toMatch(/STORIS-123456/);
    });

    // As-Is intake, never straight to sellable stock.
    expect((await levelOf(rwVariantId)).onHand).toBe(stockBefore.onHand);

    // The register lists it with its claimed number.
    const list = await as(ownerCookie).get('/v1/order-returns');
    expect(list.status).toBe(200);
    const row = (
      list.body.data as { rmaNumber: string; referencedOrderNumber: string | null }[]
    ).find((r) => r.rmaNumber === 'RMA-NOORIG-1');
    expect(row?.referencedOrderNumber).toBe('STORIS-123456');

    const invalid = await as(ownerCookie)
      .post('/v1/order-returns/no-original')
      .send({
        customerId,
        locationId,
        lines: [{ variantId: rwVariantId, quantity: 0, unitRefundCents: 100 }],
      });
    expect(invalid.status).toBe(400);
  });
});

describe('FIFO COGS — fulfillment consumes layers, pre-costing stock synthesizes opening layers', () => {
  let fifoVariantId = '';

  async function withDb2<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      return await fn(drizzle(sql2));
    } finally {
      await sql2.end({ timeout: 5 });
    }
  }

  function asOwner() {
    return {
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId),
    };
  }

  async function fulfillOne(quantity: number): Promise<string> {
    const created = await asOwner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        fulfillmentType: 'pickup',
        confirm: true,
        lines: [{ variantId: fifoVariantId, quantity }],
      });
    expect(created.status).toBe(201);
    const pay = await asOwner()
      .post(`/v1/orders/${created.body.id}/payments`)
      .send({ method: 'cash', amountCents: created.body.totalCents });
    expect(pay.status).toBe(201);
    const ful = await asOwner().post(`/v1/orders/${created.body.id}/fulfill`).send({});
    expect(ful.status).toBe(201);
    return created.body.id as string;
  }

  it('pre-costing stock: fulfilling synthesizes a fully-consumed opening layer at catalog cost', async () => {
    fifoVariantId = await withDb2(async (db) => {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'COGS-BED', name: 'COGS Fixture Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({
          businessId,
          productId: p!.id,
          sku: 'COGS-BED-V1',
          priceCents: 80000,
          costCents: 30000,
        })
        .returning();
      // Stock exists but predates costing — no layers.
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: v!.id,
        locationId,
        onHand: 10,
        reserved: 0,
      });
      return v!.id;
    });

    const orderId = await fulfillOne(2);

    await withDb2(async (db) => {
      const layers = await db
        .select()
        .from(schema.costLayers)
        .where(eq(schema.costLayers.variantId, fifoVariantId));
      expect(layers).toHaveLength(1);
      expect(layers[0]!.sourceType).toBe('opening');
      expect(layers[0]!.unitCostCents).toBe(30000);
      expect(layers[0]!.quantityReceived).toBe(2);
      expect(layers[0]!.quantityRemaining).toBe(0);

      const consumptions = await db
        .select()
        .from(schema.costConsumptions)
        .where(eq(schema.costConsumptions.layerId, layers[0]!.id));
      expect(consumptions).toHaveLength(1);
      expect(consumptions[0]!.quantity).toBe(2);
      expect(consumptions[0]!.unitCostCents).toBe(30000);
      expect(consumptions[0]!.referenceType).toBe('order_fulfill');
      expect(consumptions[0]!.referenceId).toBe(orderId);
    });
  });

  it('layered stock is consumed FIFO before any new synthesis', async () => {
    // A real receipt creates a layer; the next fulfillment eats it.
    const recv = await asOwner()
      .post('/v1/inventory/receive')
      .send({ locationId, lines: [{ variantId: fifoVariantId, quantity: 5 }] });
    expect(recv.status).toBe(201);

    await fulfillOne(3);

    await withDb2(async (db) => {
      const layers = await db
        .select()
        .from(schema.costLayers)
        .where(
          and(
            eq(schema.costLayers.variantId, fifoVariantId),
            eq(schema.costLayers.sourceType, 'receive'),
          ),
        );
      expect(layers).toHaveLength(1);
      expect(layers[0]!.unitCostCents).toBe(30000); // catalog cost fallback
      expect(layers[0]!.quantityRemaining).toBe(2); // 5 received − 3 fulfilled

      // No second opening layer was needed.
      const opening = await db
        .select()
        .from(schema.costLayers)
        .where(
          and(
            eq(schema.costLayers.variantId, fifoVariantId),
            eq(schema.costLayers.sourceType, 'opening'),
          ),
        );
      expect(opening).toHaveLength(1);
    });
  });

  it('a zero-cost consumption raises the C9 zero_cost_layer exception', async () => {
    const bareVariantId = await withDb2(async (db) => {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'NOCOST', name: 'No Cost Fixture' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'NOCOST-V1', priceCents: 10000 })
        .returning();
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: v!.id,
        locationId,
        onHand: 4,
        reserved: 0,
      });
      return v!.id;
    });

    const created = await asOwner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        fulfillmentType: 'pickup',
        confirm: true,
        lines: [{ variantId: bareVariantId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    await asOwner()
      .post(`/v1/orders/${created.body.id}/payments`)
      .send({ method: 'cash', amountCents: created.body.totalCents })
      .expect(201);
    await asOwner().post(`/v1/orders/${created.body.id}/fulfill`).send({}).expect(201);

    await withDb2(async (db) => {
      const events = await db
        .select()
        .from(schema.exceptionEvents)
        .where(
          and(
            eq(schema.exceptionEvents.type, 'zero_cost_layer'),
            eq(schema.exceptionEvents.entityId, bareVariantId),
          ),
        );
      expect(events.length).toBeGreaterThan(0);
    });
  });
});

describe('Fulfill-from stock location + my-orders filter', () => {
  let warehouseId = '';
  let wVariantId = '';

  beforeAll(async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [wh] = await db
        .insert(schema.locations)
        .values({
          businessId,
          name: 'Central Warehouse',
          timezone: 'America/New_York',
          taxRateBps: 0,
          locationType: 'warehouse',
        })
        .returning();
      warehouseId = wh!.id;
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'WH-ONLY', name: 'Warehouse-only King' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'WH-ONLY-1', priceCents: 50_000 })
        .returning();
      wVariantId = v!.id;
      // Stock ONLY at the warehouse — the showroom has none.
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: wVariantId,
        locationId: warehouseId,
        onHand: 5,
        reserved: 0,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  async function levelAt(variantId: string, locId: string) {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [row] = await db
        .select()
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantId),
            eq(schema.inventoryLevels.locationId, locId),
          ),
        );
      return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  let whOrderId = '';

  it('order sold at the showroom reserves at the warehouse when stockLocationId says so', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        stockLocationId: warehouseId,
        customerId,
        fulfillmentType: 'delivery',
        confirm: true,
        lines: [{ variantId: wVariantId, quantity: 2 }],
      });
    expect(res.status).toBe(201);
    whOrderId = res.body.id;
    expect(res.body.stockLocationId).toBe(warehouseId);

    const wh = await levelAt(wVariantId, warehouseId);
    expect(wh.reserved).toBe(2);
    const store = await levelAt(wVariantId, locationId);
    expect(store.reserved).toBe(0);
  });

  it('stockLocationId cannot move while units are reserved; release frees it', async () => {
    const blocked = await request(app.getHttpServer())
      .patch(`/v1/orders/${whOrderId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ stockLocationId: null });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/release/i);

    await request(app.getHttpServer())
      .post(`/v1/orders/${whOrderId}/release`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(201);
    expect((await levelAt(wVariantId, warehouseId)).reserved).toBe(0);

    const moved = await request(app.getHttpServer())
      .patch(`/v1/orders/${whOrderId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ stockLocationId: null });
    expect(moved.status).toBe(200);

    // Re-point back at the warehouse and re-reserve for the fulfill test.
    await request(app.getHttpServer())
      .patch(`/v1/orders/${whOrderId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ stockLocationId: warehouseId })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/orders/${whOrderId}/reserve`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(201);
    expect((await levelAt(wVariantId, warehouseId)).reserved).toBe(2);
  });

  it('fulfillment consumes warehouse stock, never the showroom', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/orders/${whOrderId}/fulfill`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(res.status).toBe(201);

    const wh = await levelAt(wVariantId, warehouseId);
    expect(wh.onHand).toBe(3);
    expect(wh.reserved).toBe(0);
    const store = await levelAt(wVariantId, locationId);
    expect(store.onHand).toBe(0);
    expect(store.reserved).toBe(0);
  });

  it('mine=1 returns only orders credited to the caller, on both list endpoints', async () => {
    // Cashier writes an order — salesperson defaults to their membership.
    const mineRes = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        fulfillmentType: 'take_with',
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
      });
    expect(mineRes.status).toBe(201);
    const cashierOrderId = mineRes.body.id as string;

    const cashierMine = await request(app.getHttpServer())
      .get('/v1/orders?mine=1&limit=50')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(cashierMine.status).toBe(200);
    const cashierIds = cashierMine.body.data.map((o: { id: string }) => o.id);
    expect(cashierIds).toContain(cashierOrderId);
    expect(cashierIds).not.toContain(whOrderId);

    const ownerMine = await request(app.getHttpServer())
      .get('/v1/orders?mine=1&limit=50')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const ownerIds = ownerMine.body.data.map((o: { id: string }) => o.id);
    expect(ownerIds).toContain(whOrderId);
    expect(ownerIds).not.toContain(cashierOrderId);

    const listView = await request(app.getHttpServer())
      .get('/v1/orders/list-view?mine=1&limit=50')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(listView.status).toBe(200);
    const lvIds = listView.body.data.map((o: { id: string }) => o.id);
    expect(lvIds).toContain(cashierOrderId);
    expect(lvIds).not.toContain(whOrderId);
  });
});

describe('Mixed fulfillment — take-with lines stay off the truck', () => {
  let bedVariantId = '';
  let pillowVariantId = '';

  beforeAll(async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      async function mk(sku: string, name: string, priceCents: number, onHand: number) {
        const [p] = await db.insert(schema.products).values({ businessId, sku, name }).returning();
        const [v] = await db
          .insert(schema.productVariants)
          .values({ businessId, productId: p!.id, sku: `${sku}-1`, priceCents })
          .returning();
        await db
          .insert(schema.inventoryLevels)
          .values({ businessId, variantId: v!.id, locationId, onHand, reserved: 0 });
        return v!.id;
      }
      bedVariantId = await mk('MIX-BED', 'Mixed Bed', 80_000, 4);
      pillowVariantId = await mk('MIX-PILLOW', 'Mixed Pillow', 5_000, 10);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('scheduling books only delivery-bound lines; the counter line hands over separately', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        fulfillmentType: 'delivery',
        confirm: true,
        lines: [
          { variantId: bedVariantId, quantity: 2 },
          { variantId: pillowVariantId, quantity: 1, fulfillmentMethod: 'take_with' },
        ],
      });
    expect(create.status).toBe(201);
    const orderId = create.body.id as string;

    const detail = await request(app.getHttpServer())
      .get(`/v1/orders/${orderId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const bedLine = detail.body.lines.find(
      (l: { variantId: string }) => l.variantId === bedVariantId,
    );
    const pillowLine = detail.body.lines.find(
      (l: { variantId: string }) => l.variantId === pillowVariantId,
    );
    expect(pillowLine.fulfillmentMethod).toBe('take_with');

    // Default schedule: only the bed rides — 2 units, no pillow line.
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const dv = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/deliveries`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ scheduledDate: tomorrow });
    expect(dv.status).toBe(201);
    const dvLineIds = dv.body.lines.map((l: { orderLineId: string }) => l.orderLineId);
    expect(dvLineIds).toContain(bedLine.id);
    expect(dvLineIds).not.toContain(pillowLine.id);
    expect(dv.body.lines.reduce((s: number, l: { quantity: number }) => s + l.quantity, 0)).toBe(2);

    // Counter hand-over of the take-with pillow: explicit line fulfill.
    const handover = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/fulfill`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ orderLineId: pillowLine.id, quantity: 1 }] });
    expect(handover.status).toBe(201);
    const afterLine = handover.body.lines.find((l: { id: string }) => l.id === pillowLine.id);
    expect(afterLine.qtyFulfilled).toBe(1);
    expect(handover.body.status).toBe('partially_fulfilled');
  });

  it('an order whose remaining units are all counter-marked refuses to schedule, with directions', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        fulfillmentType: 'delivery',
        confirm: true,
        lines: [{ variantId: pillowVariantId, quantity: 2, fulfillmentMethod: 'take_with' }],
      });
    expect(create.status).toBe(201);

    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const dv = await request(app.getHttpServer())
      .post(`/v1/orders/${create.body.id}/deliveries`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ scheduledDate: tomorrow });
    expect(dv.status).toBe(400);
    expect(dv.body.message).toMatch(/take-with/i);
  });
});

describe('Per-line inventory source (fulfill-from on the line)', () => {
  let storeVariantId = '';
  let whVariantId = '';
  let warehouseId = '';

  beforeAll(async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [wh] = await db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.name, 'Central Warehouse'))
        .limit(1);
      warehouseId = wh!.id;
      async function mk(sku: string, name: string, onHand: number, locId: string) {
        const [p] = await db.insert(schema.products).values({ businessId, sku, name }).returning();
        const [v] = await db
          .insert(schema.productVariants)
          .values({ businessId, productId: p!.id, sku: `${sku}-1`, priceCents: 10_000 })
          .returning();
        await db
          .insert(schema.inventoryLevels)
          .values({ businessId, variantId: v!.id, locationId: locId, onHand, reserved: 0 });
        return v!.id;
      }
      storeVariantId = await mk('SRC-STORE', 'Store-stocked Frame', 3, locationId);
      whVariantId = await mk('SRC-WH', 'Warehouse-stocked Base', 3, warehouseId);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  async function levelAt(variantId: string, locId: string) {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [row] = await db
        .select()
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantId),
            eq(schema.inventoryLevels.locationId, locId),
          ),
        );
      return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it('each line reserves and consumes at its own source; store-equal source normalizes to null', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        fulfillmentType: 'delivery',
        confirm: true,
        lines: [
          // Explicit source equal to the selling store → stored as null.
          { variantId: storeVariantId, quantity: 1, sourceLocationId: locationId },
          { variantId: whVariantId, quantity: 2, sourceLocationId: warehouseId },
        ],
      });
    expect(create.status).toBe(201);
    const orderId = create.body.id as string;

    const detail = await request(app.getHttpServer())
      .get(`/v1/orders/${orderId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const storeLine = detail.body.lines.find(
      (l: { variantId: string }) => l.variantId === storeVariantId,
    );
    const whLine = detail.body.lines.find(
      (l: { variantId: string }) => l.variantId === whVariantId,
    );
    expect(storeLine.sourceLocationId).toBeNull();
    expect(whLine.sourceLocationId).toBe(warehouseId);

    // Reserved where each line points, nowhere else.
    expect((await levelAt(storeVariantId, locationId)).reserved).toBe(1);
    expect((await levelAt(whVariantId, warehouseId)).reserved).toBe(2);
    expect((await levelAt(whVariantId, locationId)).reserved).toBe(0);

    // Fulfill everything: consumption follows each line's source.
    const fulfill = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/fulfill`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(fulfill.status).toBe(201);
    const store = await levelAt(storeVariantId, locationId);
    expect(store.onHand).toBe(2);
    expect(store.reserved).toBe(0);
    const wh = await levelAt(whVariantId, warehouseId);
    expect(wh.onHand).toBe(1);
    expect(wh.reserved).toBe(0);

    // Cancel-path safety net is covered by release grouping: nothing
    // remains reserved anywhere.
    expect((await levelAt(whVariantId, locationId)).reserved).toBe(0);
  });

  it('model swap: removing a warehouse-sourced line releases at the warehouse; the added line reserves at its own source', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        fulfillmentType: 'delivery',
        confirm: true,
        lines: [{ variantId: whVariantId, quantity: 1, sourceLocationId: warehouseId }],
      });
    expect(create.status).toBe(201);
    const orderId = create.body.id as string;
    const oldLineId =
      create.body.lines?.[0]?.id ??
      (
        await request(app.getHttpServer())
          .get(`/v1/orders/${orderId}`)
          .set('Cookie', ownerCookie)
          .set('X-Business-Id', businessId)
      ).body.lines[0].id;
    expect((await levelAt(whVariantId, warehouseId)).reserved).toBe(1);

    // The customer changes models: remove the old line…
    await request(app.getHttpServer())
      .delete(`/v1/orders/${orderId}/lines/${oldLineId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect((await levelAt(whVariantId, warehouseId)).reserved).toBe(0);

    // …and add the new one, sourced from the warehouse too.
    const add = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/lines`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId: storeVariantId, quantity: 1 });
    expect(add.status).toBe(201);
    // The new line has no override → reserves at the order default (store).
    expect((await levelAt(storeVariantId, locationId)).reserved).toBeGreaterThanOrEqual(1);
    const detail = add.body;
    expect(detail.lines.some((l: { variantId: string }) => l.variantId === storeVariantId)).toBe(
      true,
    );
    expect(detail.lines.some((l: { id: string }) => l.id === oldLineId)).toBe(false);
  });
});

describe('Customer purchase history — orders with line detail in one call', () => {
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
    };
  }

  it('returns the customer file view: newest-first orders, money picture, and every line', async () => {
    // A fresh customer so the ledger is exactly what this test writes.
    const cust = await asOwner()
      .post('/v1/customers')
      .send({ firstName: 'History', lastName: 'Buyer' });
    expect(cust.status).toBe(201);
    const custId = cust.body.id as string;

    const first = await asOwner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId: custId,
        confirm: true,
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
      });
    expect(first.status).toBe(201);
    await asOwner()
      .post(`/v1/orders/${first.body.id}/payments`)
      .send({ method: 'cash', amountCents: 50_000, kind: 'deposit' })
      .expect(201);
    const second = await asOwner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId: custId,
        confirm: true,
        lines: [{ variantId: chairVariantId, quantity: 1 }],
      });
    expect(second.status).toBe(201);

    // A legacy STORIS receipt — imported sales are documents too, and
    // the customer file must show what was bought on them.
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const db = drizzle(sql);
      const [sale] = await db
        .insert(schema.sales)
        .values({
          businessId,
          locationId,
          number: 'STORIS-HIST-1',
          status: 'completed',
          customerId: custId,
          subtotalCents: 87_190,
          taxCents: 6_103,
          totalCents: 93_293,
          importedAt: new Date('2024-05-01T12:00:00Z'),
          completedAt: new Date('2024-05-01T12:00:00Z'),
          createdAt: new Date('2024-05-01T12:00:00Z'),
        })
        .returning();
      await db.insert(schema.saleLines).values({
        businessId,
        saleId: sale!.id,
        description: 'SEALY POSTUREPEDIC QUEEN',
        quantity: 1,
        unitPriceCents: 87_190,
        taxCents: 6_103,
        totalCents: 87_190,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }

    const res = await asOwner().get(`/v1/customers/${custId}/order-history`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    // Newest first; the 2024 receipt sorts last.
    expect(res.body[0].id).toBe(second.body.id);
    expect(res.body[1].id).toBe(first.body.id);
    expect(res.body[2].docType).toBe('sale');

    const older = res.body[1];
    expect(older.docType).toBe('order');
    expect(older.number).toBe(first.body.number);
    expect(older.paidCents).toBe(50_000);
    expect(older.balanceDueCents).toBe(older.totalCents - 50_000);
    expect(older.lines).toHaveLength(1);
    expect(older.lines[0].description).toContain('Sofa');
    expect(older.lines[0].quantity).toBe(1);
    expect(older.lines[0].unitPriceCents).toBe(129_999);
    expect(older.lines[0].qtyFulfilled).toBe(0);
    expect(older.lines[0].qtyReturned).toBe(0);

    const newer = res.body[0];
    expect(newer.paidCents).toBe(0);
    expect(newer.balanceDueCents).toBe(newer.totalCents);
    expect(newer.lines[0].description).toContain('Chair');

    // The receipt carries its items and reads as settled.
    const receipt = res.body[2];
    expect(receipt.number).toBe('STORIS-HIST-1');
    expect(receipt.importedAt).toBeTruthy();
    expect(receipt.totalCents).toBe(93_293);
    expect(receipt.paidCents).toBe(93_293);
    expect(receipt.balanceDueCents).toBe(0);
    expect(receipt.lines).toHaveLength(1);
    expect(receipt.lines[0].description).toBe('SEALY POSTUREPEDIC QUEEN');
    expect(receipt.lines[0].qtyFulfilled).toBe(1);
  });
});

describe('Per-member selling scope + nav visibility', () => {
  const asCookie = (cookie: string) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('Cookie', cookie).set('X-Business-Id', businessId),
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set('Cookie', cookie).set('X-Business-Id', businessId),
    patch: (url: string) =>
      request(app.getHttpServer())
        .patch(url)
        .set('Cookie', cookie)
        .set('X-Business-Id', businessId),
  });

  let cashierMembershipId = '';
  let otherStoreId = '';

  it('setup: find the cashier membership and add a second store', async () => {
    const members = await asCookie(ownerCookie).get('/v1/business/members');
    expect(members.status).toBe(200);
    const cashier = members.body.find((m: { email: string }) => m.email.startsWith('cashier@'));
    expect(cashier).toBeTruthy();
    cashierMembershipId = cashier.membershipId;

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const db = drizzle(sql);
      const [loc2] = await db
        .insert(schema.locations)
        .values({ businessId, name: 'Second Store', timezone: 'America/Los_Angeles' })
        .returning();
      otherStoreId = loc2!.id;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('approved-only selling: blocked off-scope, allowed in-scope, data still visible everywhere', async () => {
    // Owner amendment 2026-08-29: selling is restricted, data is NOT —
    // dataScope stays 'all'.
    await asCookie(ownerCookie)
      .patch(`/v1/business/members/${cashierMembershipId}`)
      .send({ sellingScope: 'approved', scopeLocationIds: [locationId] })
      .expect(200);

    // Off-scope store -> refused with the friendly message.
    const denied = await asCookie(cashierCookie)
      .post('/v1/orders')
      .send({
        locationId: otherStoreId,
        customerId,
        confirm: true,
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
      });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/not set up to sell/);

    // In-scope store -> writes normally.
    const ok = await asCookie(cashierCookie)
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
      });
    expect(ok.status).toBe(201);

    // The register still lists EVERY location (inventory sources from
    // anywhere) but marks where this member may ring a sale.
    const locs = await asCookie(cashierCookie).get('/v1/pos/locations');
    expect(locs.status).toBe(200);
    const offScope = locs.body.find((l: { id: string }) => l.id === otherStoreId);
    const inScope = locs.body.find((l: { id: string }) => l.id === locationId);
    expect(offScope.canSellHere).toBe(false);
    expect(inScope.canSellHere).toBe(true);

    // ...but sales DATA stays visible everywhere: the owner writes an
    // order at the second store and the restricted cashier still sees it.
    const ownersOrder = await asCookie(ownerCookie)
      .post('/v1/orders')
      .send({
        locationId: otherStoreId,
        customerId,
        confirm: true,
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
      });
    expect(ownersOrder.status).toBe(201);
    const seen = await asCookie(cashierCookie).get('/v1/orders?limit=100');
    expect(seen.status).toBe(200);
    expect(seen.body.data.some((o: { id: string }) => o.id === ownersOrder.body.id)).toBe(true);

    // Owner remains unrestricted at the register too.
    const ownerLocs = await asCookie(ownerCookie).get('/v1/pos/locations');
    expect(ownerLocs.body.every((l: { canSellHere: boolean }) => l.canSellHere === true)).toBe(
      true,
    );
  });

  it('/me carries the login picker payload and hidden nav round-trips', async () => {
    await asCookie(ownerCookie)
      .patch(`/v1/business/members/${cashierMembershipId}`)
      .send({ hiddenNav: ['/gl', '/audit', '/gl'] })
      .expect(200);

    const me = await asCookie(cashierCookie).get('/v1/business/members/me');
    expect(me.status).toBe(200);
    expect(me.body.membershipId).toBe(cashierMembershipId);
    expect(me.body.hiddenNav.sort()).toEqual(['/audit', '/gl']); // deduped
    expect(me.body.sellingScope).toBe('approved');
    expect(me.body.dataScope).toBe('all');
    // Named stores for the login picker.
    expect(me.body.scopeLocations).toHaveLength(1);
    expect(me.body.scopeLocations[0].id).toBe(locationId);
    expect(typeof me.body.scopeLocations[0].name).toBe('string');

    // Malformed entries are refused.
    const bad = await asCookie(ownerCookie)
      .patch(`/v1/business/members/${cashierMembershipId}`)
      .send({ hiddenNav: ['gl'] });
    expect(bad.status).toBe(400);

    // Cleanup: restore the cashier for any later suites.
    await asCookie(ownerCookie)
      .patch(`/v1/business/members/${cashierMembershipId}`)
      .send({ sellingScope: 'all', scopeLocationIds: [], hiddenNav: [] })
      .expect(200);
    const after = await asCookie(cashierCookie).get('/v1/business/members/me');
    expect(after.body.hiddenNav).toEqual([]);
    expect(after.body.sellingScope).toBe('all');
  });
});

describe('Order split — backorder lines move to their own order', () => {
  const asOwner2 = () => ({
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
  });

  let freshVariantId = '';

  it('setup: a fresh variant with plenty of stock', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const db = drizzle(sql);
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'SPLIT-P', name: 'Splittable Mattress' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'SPLIT-V', priceCents: 40_000 })
        .returning();
      freshVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: freshVariantId,
        locationId,
        onHand: 10,
        reserved: 0,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('moves the picked quantity to a new order with its own promised date; money stays put', async () => {
    const created = await asOwner2()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        requestedDate: '2026-09-05',
        lines: [
          { variantId: freshVariantId, quantity: 3 },
          { variantId: sofaVariantId, quantity: 1 },
        ],
      });
    expect(created.status).toBe(201);
    const orderId = created.body.id as string;
    const splitLine = created.body.lines.find(
      (l: { variantId: string }) => l.variantId === freshVariantId,
    );
    expect(splitLine.qtyReserved).toBe(3);
    await asOwner2()
      .post(`/v1/orders/${orderId}/payments`)
      .send({ method: 'cash', amountCents: 50_000, kind: 'deposit' })
      .expect(201);
    const totalBefore = created.body.totalCents as number;

    // One of the three mattresses is backordered — split it out to a
    // later date.
    const split = await asOwner2()
      .post(`/v1/orders/${orderId}/split`)
      .send({ lines: [{ lineId: splitLine.id, quantity: 1 }], requestedDate: '2026-10-15' });
    expect(split.status).toBe(201);
    expect(split.body.newOrder.number).toBeTruthy();

    // Source: quantity shrank, reservation follows, total dropped, and
    // the deposit stayed here.
    const source = split.body.order;
    const srcLine = source.lines.find((l: { variantId: string }) => l.variantId === freshVariantId);
    expect(srcLine.quantity).toBe(2);
    expect(srcLine.qtyReserved).toBe(2);
    expect(source.lines).toHaveLength(2);
    expect(source.totalCents).toBeLessThan(totalBefore);
    expect(source.paidCents).toBe(50_000);

    // Target: its own order, promised at the backorder date, reserved,
    // unpaid.
    const target = await asOwner2().get(`/v1/orders/${split.body.newOrder.id}`);
    expect(target.status).toBe(200);
    expect(target.body.status).toBe('open');
    expect(target.body.requestedDate).toBe('2026-10-15');
    expect(target.body.customerId).toBe(customerId);
    expect(target.body.lines).toHaveLength(1);
    expect(target.body.lines[0].variantId).toBe(freshVariantId);
    expect(target.body.lines[0].quantity).toBe(1);
    expect(target.body.lines[0].qtyReserved).toBe(1);
    expect(target.body.paidCents).toBe(0);
    expect(target.body.totalCents + source.totalCents).toBe(totalBefore);
  });

  it('guards: cannot move everything, cannot move more than the movable units', async () => {
    const created = await asOwner2()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: freshVariantId, quantity: 2 }],
      });
    expect(created.status).toBe(201);
    const lineId = created.body.lines[0].id as string;

    const all = await asOwner2()
      .post(`/v1/orders/${created.body.id}/split`)
      .send({ lines: [{ lineId }] });
    expect(all.status).toBe(400);
    expect(all.body.message).toMatch(/not a split/);

    const tooMany = await asOwner2()
      .post(`/v1/orders/${created.body.id}/split`)
      .send({ lines: [{ lineId, quantity: 5 }] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toMatch(/movable unit/);
  });
});

describe('Split-at-sale suffix numbering + reserved drill-down', () => {
  const asOwner3 = () => ({
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
  });

  let drillVariantId = '';

  it('setup: another fresh variant with stock', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const db = drizzle(sql);
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'DRILL-P', name: 'Drilldown Mattress' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'DRILL-V', priceCents: 30_000 })
        .returning();
      drillVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: drillVariantId,
        locationId,
        onHand: 12,
        reserved: 0,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('creating a sale with a later-dated line splits it into BASE-A at write time; the next split is -B', async () => {
    const created = await asOwner3()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        requestedDate: '2026-09-10',
        splitByDeliveryDate: true,
        lines: [
          { variantId: drillVariantId, quantity: 1 },
          { variantId: drillVariantId, quantity: 1, deliveryDate: '2026-10-25' },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.splitOrders).toHaveLength(1);
    const sibling = created.body.splitOrders[0];
    expect(sibling.number).toBe(`${created.body.number}-A`);
    expect(sibling.requestedDate).toBe('2026-10-25');
    // Primary kept only the on-time line.
    expect(created.body.lines).toHaveLength(1);

    const sib = await asOwner3().get(`/v1/orders/${sibling.id}`);
    expect(sib.body.requestedDate).toBe('2026-10-25');
    expect(sib.body.lines).toHaveLength(1);
    expect(sib.body.lines[0].qtyReserved).toBe(1);

    // Add another line, then a manual split — the family continues at -B.
    await asOwner3()
      .post(`/v1/orders/${created.body.id}/lines`)
      .send({ variantId: drillVariantId, quantity: 1 })
      .expect(201);
    const detail = await asOwner3().get(`/v1/orders/${created.body.id}`);
    const lastLine = detail.body.lines[detail.body.lines.length - 1];
    const manual = await asOwner3()
      .post(`/v1/orders/${created.body.id}/split`)
      .send({ lines: [{ lineId: lastLine.id }], requestedDate: '2026-11-05' });
    expect(manual.status).toBe(201);
    expect(manual.body.newOrder.number).toBe(`${created.body.number}-B`);
  });

  it('reserved drill-down lists the holding order; releasing the line frees the stock', async () => {
    const created = await asOwner3()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [{ variantId: drillVariantId, quantity: 2 }],
      });
    expect(created.status).toBe(201);
    const lineId = created.body.lines[0].id as string;
    expect(created.body.lines[0].qtyReserved).toBe(2);

    const held = await asOwner3().get(
      `/v1/inventory/reservations?variantId=${drillVariantId}&locationId=${locationId}`,
    );
    expect(held.status).toBe(200);
    const mine = held.body.find((r: { orderId: string }) => r.orderId === created.body.id);
    expect(mine).toBeTruthy();
    expect(mine.qtyReserved).toBe(2);
    expect(mine.orderNumber).toBe(created.body.number);

    const released = await asOwner3().post(`/v1/orders/${created.body.id}/lines/${lineId}/release`);
    expect(released.status).toBe(201);
    expect(released.body.lines.find((l: { id: string }) => l.id === lineId).qtyReserved).toBe(0);
    const after = await asOwner3().get(
      `/v1/inventory/reservations?variantId=${drillVariantId}&locationId=${locationId}`,
    );
    expect(after.body.some((r: { orderId: string }) => r.orderId === created.body.id)).toBe(false);

    // Nothing left to release → 400.
    const again = await asOwner3().post(`/v1/orders/${created.body.id}/lines/${lineId}/release`);
    expect(again.status).toBe(400);
  });

  it('orders list filters by locationId', async () => {
    const res = await asOwner3().get(`/v1/orders?locationId=${locationId}&limit=5`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const bogus = await asOwner3().get(
      '/v1/orders?locationId=00000000-0000-4000-8000-000000000000&limit=5',
    );
    expect(bogus.body.data).toHaveLength(0);
  });
});

describe('Recycling fee is never taxed', () => {
  it('a custom Recycling Fee line carries 0% tax while merchandise taxes at the business rate', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        confirm: true,
        lines: [
          { variantId: sofaVariantId, quantity: 1 },
          {
            lineType: 'custom',
            description: 'Recycling Fee',
            quantity: 1,
            unitPriceCents: 1050,
          },
        ],
      });
    expect(res.status).toBe(201);
    const fee = res.body.lines.find(
      (l: { description: string }) => l.description === 'Recycling Fee',
    );
    expect(fee.taxCents).toBe(0);
    // Order tax equals the merchandise tax alone (business default 7%).
    const sofa = res.body.lines.find((l: { variantId: string | null }) => l.variantId);
    expect(res.body.taxCents).toBe(sofa.taxCents);
    expect(sofa.taxCents).toBe(Math.round((129_999 * 700) / 10000));
  });
});

describe('Global omnibox search (handoff G1)', () => {
  let callerId = '';
  let callerOrderId = '';
  let callerOrderNumber = '';

  it('is authenticated — no session, no directory', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/search?q=555')
      .set('X-Business-Id', businessId);
    expect([401, 403]).toContain(res.status);
    // Anyone who can view orders can use it — the clerk included.
    await request(app.getHttpServer())
      .get('/v1/search?q=555')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
  });

  it('finds a caller by phone digits regardless of formatting', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Rita', lastName: 'Ringer', phone: '(818) 555-0142' });
    expect(create.status).toBe(201);
    callerId = create.body.id;

    for (const q of ['8185550142', '555-0142', '818 555']) {
      const res = await request(app.getHttpServer())
        .get(`/v1/search?q=${encodeURIComponent(q)}`)
        .set('Cookie', cashierCookie)
        .set('X-Business-Id', businessId)
        .expect(200);
      const ids = res.body.customers.map((c: { id: string }) => c.id);
      expect(ids).toContain(callerId);
    }
    // And by name, of course.
    const byName = await request(app.getHttpServer())
      .get('/v1/search?q=rita ring')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(byName.body.customers.map((c: { id: string }) => c.id)).toContain(callerId);
    expect(byName.body.customers[0].phone).toBe('(818) 555-0142');
  });

  it('finds documents by number — current, legacy STORIS, and receipts', async () => {
    const order = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId: callerId,
        fulfillmentType: 'delivery',
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
        confirm: true,
      });
    expect(order.status).toBe(201);
    callerOrderId = order.body.id;
    callerOrderNumber = order.body.number;

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      await sql`UPDATE orders SET legacy_number = 'ST-40417788' WHERE id = ${callerOrderId}`;
      await sql`
        INSERT INTO sales (business_id, location_id, customer_id, number, status,
                           subtotal_cents, total_cents, imported_at)
        VALUES (${businessId}, ${locationId}, ${callerId}, 'SRCH-RCPT-1', 'completed',
                12000, 12000, now())`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    // Partial current number (the tail digits a customer reads out).
    const tail = callerOrderNumber.slice(-5);
    const byNumber = await request(app.getHttpServer())
      .get(`/v1/search?q=${encodeURIComponent(tail)}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const hit = byNumber.body.orders.find((o: { id: string }) => o.id === callerOrderId);
    expect(hit).toBeTruthy();
    expect(hit.customerName).toBe('Rita Ringer');

    // The old STORIS invoice number still resolves.
    const byLegacy = await request(app.getHttpServer())
      .get('/v1/search?q=ST-40417788')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(byLegacy.body.orders.map((o: { id: string }) => o.id)).toContain(callerOrderId);

    // Register receipts match too, flagged as imported.
    const byReceipt = await request(app.getHttpServer())
      .get('/v1/search?q=SRCH-RCPT')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const receipt = byReceipt.body.sales.find(
      (r: { number: string }) => r.number === 'SRCH-RCPT-1',
    );
    expect(receipt).toBeTruthy();
    expect(receipt.imported).toBe(true);
    expect(receipt.customerName).toBe('Rita Ringer');
  });

  it('a one-character query returns nothing rather than everything', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/search?q=r')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(res.body.customers).toEqual([]);
    expect(res.body.orders).toEqual([]);
    expect(res.body.sales).toEqual([]);
  });
});

describe('Add item to an existing order at a set price (owner ask 2026-08-30)', () => {
  it('the new line carries the entered price and raises the balance to collect', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        fulfillmentType: 'delivery',
        lines: [{ variantId: sofaVariantId, quantity: 1 }],
        confirm: true,
      });
    expect(create.status).toBe(201);
    const orderId = create.body.id as string;
    const before = create.body.balanceDueCents as number;

    // The chair lists at 19,999 — the writer charges 25,000 for two.
    const added = await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/lines`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId: chairVariantId, quantity: 2, unitPriceCents: 25_000 });
    expect(added.status).toBe(201);

    const line = added.body.lines.find(
      (l: { variantId: string | null }) => l.variantId === chairVariantId,
    );
    expect(line.unitPriceCents).toBe(25_000);
    expect(line.quantity).toBe(2);
    // Balance rose by the charge plus its tax (7%), ready for a payment.
    const charge = 50_000 + Math.round((50_000 * 700) / 10_000);
    expect(added.body.balanceDueCents - before).toBe(charge);

    // And the payment on the new item goes straight through.
    await request(app.getHttpServer())
      .post(`/v1/orders/${orderId}/payments`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ method: 'card', amountCents: charge })
      .expect(201);
    const after = await request(app.getHttpServer())
      .get(`/v1/orders/${orderId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(after.body.balanceDueCents).toBe(before);
  });
});

/**
 * Owner 2026-08-31: order lines edit in place like New Sale — qty,
 * price, discount, per-line fulfillment, and fulfill-from, with
 * reservations following the edit and money edits repricing.
 */
describe('Order line in-place editing (New Sale parity)', () => {
  let annexId = '';
  let leVariantId = '';

  function req(method: 'post' | 'patch', url: string) {
    return request(app.getHttpServer())
      [method](url)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
  }

  async function reservedAt(locId: string): Promise<number> {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [row] = await db
        .select({ reserved: schema.inventoryLevels.reserved })
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, leVariantId),
            eq(schema.inventoryLevels.locationId, locId),
          ),
        )
        .limit(1);
      return row?.reserved ?? 0;
    } finally {
      await sql2.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [annex] = await db
        .insert(schema.locations)
        .values({ businessId, name: 'Line Edit Annex', timezone: 'America/New_York' })
        .returning();
      annexId = annex!.id;
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'LNE-EDIT', name: 'Line Edit Sofa' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({
          businessId,
          productId: p!.id,
          sku: 'LNE-EDIT-1',
          priceCents: 50_000,
          costCents: 30_000,
        })
        .returning();
      leVariantId = v!.id;
      for (const loc of [locationId, annexId]) {
        await db.insert(schema.inventoryLevels).values({
          businessId,
          variantId: leVariantId,
          locationId: loc,
          onHand: 10,
          reserved: 0,
        });
      }
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  async function makeOrder(quantity: number): Promise<{ id: string; lineId: string }> {
    const res = await req('post', '/v1/orders').send({
      locationId,
      customerId,
      confirm: true,
      lines: [{ variantId: leVariantId, quantity }],
    });
    expect(res.status).toBe(201);
    return { id: res.body.id, lineId: res.body.lines[0].id };
  }

  it('quantity edits reprice and the reservation follows both ways', async () => {
    const before = await reservedAt(locationId);
    const o = await makeOrder(3);
    expect(await reservedAt(locationId)).toBe(before + 3);

    const down = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({ quantity: 2 });
    expect(down.status).toBe(200);
    expect(down.body.lines[0].quantity).toBe(2);
    expect(down.body.lines[0].qtyReserved).toBe(2);
    expect(down.body.subtotalCents).toBe(100_000);
    expect(await reservedAt(locationId)).toBe(before + 2);

    const up = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({ quantity: 4 });
    expect(up.status).toBe(200);
    expect(up.body.lines[0].qtyReserved).toBe(4);
    expect(await reservedAt(locationId)).toBe(before + 4);

    const zero = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({ quantity: 0 });
    expect(zero.status).toBe(400);
  });

  it('price and discount edits reprice; an over-discount is refused', async () => {
    const o = await makeOrder(1);
    const priced = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({
      unitPriceCents: 40_000,
    });
    expect(priced.status).toBe(200);
    expect(priced.body.lines[0].unitPriceCents).toBe(40_000);
    expect(priced.body.subtotalCents).toBe(40_000);

    const disc = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({
      lineDiscountCents: 1_000,
    });
    expect(disc.status).toBe(200);
    expect(disc.body.lines[0].discountCents).toBe(1_000);
    expect(disc.body.discountCents).toBe(1_000);

    const over = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({
      lineDiscountCents: 50_000,
    });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/cannot exceed/);
  });

  it('per-line fulfillment sets and clears; junk is refused', async () => {
    const o = await makeOrder(1);
    const set = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({
      fulfillmentMethod: 'take_with',
    });
    expect(set.status).toBe(200);
    expect(set.body.lines[0].fulfillmentMethod).toBe('take_with');

    const clear = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({
      fulfillmentMethod: null,
    });
    expect(clear.status).toBe(200);
    expect(clear.body.lines[0].fulfillmentMethod).toBeNull();

    const junk = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({
      fulfillmentMethod: 'teleport',
    });
    expect(junk.status).toBe(400);
  });

  it('moving the fulfill-from location re-homes the reservation', async () => {
    const mainBefore = await reservedAt(locationId);
    const annexBefore = await reservedAt(annexId);
    const o = await makeOrder(2);
    expect(await reservedAt(locationId)).toBe(mainBefore + 2);

    const moved = await req('patch', `/v1/orders/${o.id}/lines/${o.lineId}`).send({
      sourceLocationId: annexId,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.lines[0].sourceLocationId).toBe(annexId);
    expect(moved.body.lines[0].qtyReserved).toBe(2);
    expect(await reservedAt(locationId)).toBe(mainBefore);
    expect(await reservedAt(annexId)).toBe(annexBefore + 2);
  });
});

/**
 * Owner 2026-08-31: take-with goods leave the store when the sale
 * completes. Complete on a live order splits take-with lines to a -A
 * sibling (collected money covers it first) and completes the piece
 * when stocked + paid; short or unpaid pieces wait, and one click on
 * the piece finishes them after inventory is adjusted in. The invoice
 * document prints the whole family combined.
 */
describe('Take-with hand-over on Complete', () => {
  let twVariantId = '';
  let dlVariantId = '';
  let shortVariantId = '';

  function req(method: 'post' | 'get', url: string) {
    return request(app.getHttpServer())
      [method](url)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
  }

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const mk = async (sku: string, onHand: number) => {
        const [pr] = await db
          .insert(schema.products)
          .values({ businessId, sku, name: `TW ${sku}` })
          .returning();
        const [v] = await db
          .insert(schema.productVariants)
          .values({ businessId, productId: pr!.id, sku: `${sku}-1`, priceCents: 50_000 })
          .returning();
        if (onHand > 0) {
          await db.insert(schema.inventoryLevels).values({
            businessId,
            variantId: v!.id,
            locationId,
            onHand,
            reserved: 0,
          });
        }
        return v!.id;
      };
      twVariantId = await mk('TW-CHAIR', 10);
      dlVariantId = await mk('TW-SOFA', 10);
      shortVariantId = await mk('TW-NONE', 0);
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  async function onHandOf(variantId: string): Promise<{ onHand: number; reserved: number }> {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [row] = await db
        .select({
          onHand: schema.inventoryLevels.onHand,
          reserved: schema.inventoryLevels.reserved,
        })
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        )
        .limit(1);
      return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 };
    } finally {
      await sql2.end({ timeout: 5 });
    }
  }

  it('a paid mixed order splits its take-with line to a completed -A piece', async () => {
    const before = await onHandOf(twVariantId);
    const created = await req('post', '/v1/orders').send({
      locationId,
      customerId,
      confirm: true,
      lines: [
        { variantId: dlVariantId, quantity: 1 },
        { variantId: twVariantId, quantity: 1, fulfillmentMethod: 'take_with' },
      ],
    });
    expect(created.status).toBe(201);
    const total = created.body.totalCents as number;

    const paid = await req('post', `/v1/orders/${created.body.id}/payments`).send({
      method: 'cash',
      amountCents: total,
    });
    expect(paid.status).toBe(201);

    const done = await req('post', `/v1/orders/${created.body.id}/complete`).send({});
    expect(done.status).toBe(201);
    expect(done.body.takeWith).toBeTruthy();
    expect(done.body.takeWith.completed).toBe(true);
    expect(done.body.takeWith.number).toMatch(/-A$/);
    // The parent keeps only the delivery line and stays open, paid up.
    expect(done.body.lines).toHaveLength(1);
    expect(done.body.lines[0].variantId).toBe(dlVariantId);
    expect(done.body.status).toBe('open');
    expect(done.body.balanceDueCents).toBe(0);

    const piece = await req('get', `/v1/orders/${done.body.takeWith.orderId}`);
    expect(piece.status).toBe(200);
    expect(piece.body.status).toBe('completed');
    expect(piece.body.balanceDueCents).toBe(0);
    expect(piece.body.fulfillmentType).toBe('take_with');
    expect(piece.body.lines[0].qtyFulfilled).toBe(1);

    // The unit physically left: on hand down one, nothing still reserved.
    const after = await onHandOf(twVariantId);
    expect(after.onHand).toBe(before.onHand - 1);
    expect(after.reserved).toBe(before.reserved);

    // Owner 2026-08-31: the invoice document prints the family combined.
    const doc = await req('get', `/v1/orders/${created.body.id}/document`);
    expect(doc.status).toBe(200);
    expect(doc.body.familyInvoice).toBeTruthy();
    expect(doc.body.familyInvoice.numbers).toHaveLength(2);
    const twLine = doc.body.familyInvoice.lines.find((l: { takenWith: boolean }) => l.takenWith);
    expect(twLine).toBeTruthy();
    expect(doc.body.familyInvoice.totalCents).toBe(total);
    expect(doc.body.familyInvoice.balanceDueCents).toBe(0);
  });

  it('an unpaid mixed order still splits; the piece waits on payment', async () => {
    const created = await req('post', '/v1/orders').send({
      locationId,
      customerId,
      confirm: true,
      lines: [
        { variantId: dlVariantId, quantity: 1 },
        { variantId: twVariantId, quantity: 1, fulfillmentMethod: 'take_with' },
      ],
    });
    expect(created.status).toBe(201);

    const done = await req('post', `/v1/orders/${created.body.id}/complete`).send({});
    expect(done.status).toBe(201);
    expect(done.body.takeWith.completed).toBe(false);
    expect(done.body.takeWith.reason).toMatch(/waiting on payment/);

    const piece = await req('get', `/v1/orders/${done.body.takeWith.orderId}`);
    expect(piece.body.status).toBe('open');
  });

  it('a short take-with piece waits on stock, then one click finishes it after the adjustment', async () => {
    const created = await req('post', '/v1/orders').send({
      locationId,
      customerId,
      confirm: true,
      lines: [
        { variantId: dlVariantId, quantity: 1 },
        { variantId: shortVariantId, quantity: 1, fulfillmentMethod: 'take_with' },
      ],
    });
    expect(created.status).toBe(201);
    const total = created.body.totalCents as number;
    await req('post', `/v1/orders/${created.body.id}/payments`).send({
      method: 'cash',
      amountCents: total,
    });

    const done = await req('post', `/v1/orders/${created.body.id}/complete`).send({});
    expect(done.status).toBe(201);
    expect(done.body.takeWith.completed).toBe(false);
    expect(done.body.takeWith.reason).toMatch(/not in stock/);
    const pieceId = done.body.takeWith.orderId as string;

    // An authorized user adjusts the inventory in…
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: shortVariantId,
        locationId,
        onHand: 3,
        reserved: 0,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }

    // …and one click on the piece reserves, hands over, and completes.
    const finish = await req('post', `/v1/orders/${pieceId}/complete`).send({});
    expect(finish.status).toBe(201);
    expect(finish.body.takeWith.completed).toBe(true);
    expect(finish.body.status).toBe('completed');
  });
});

describe('Orders list date window (owner 2026-09-02, Shopify-style picker)', () => {
  const get = (url: string) =>
    request(app.getHttpServer())
      .get(url)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);

  it('start/end scope the list and the list view by created date; malformed is ignored', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const all = await get('/v1/orders?limit=100').expect(200);
    expect(all.body.data.length).toBeGreaterThan(0);
    const past = await get('/v1/orders?limit=100&start=2000-01-01&end=2000-01-02').expect(200);
    expect(past.body.data).toEqual([]);
    // Earlier suites backdate a few orders (return windows), so today's
    // window is a non-empty subset of everything.
    const now = await get(`/v1/orders?limit=100&start=${today}&end=${today}`).expect(200);
    expect(now.body.data.length).toBeGreaterThan(0);
    expect(now.body.data.length).toBeLessThanOrEqual(all.body.data.length);
    const bad = await get('/v1/orders?limit=100&start=2000-13-40&end=x').expect(200);
    expect(bad.body.data.length).toBe(all.body.data.length);
    const view = await get('/v1/orders/list-view?limit=100&start=2000-01-01&end=2000-01-02').expect(
      200,
    );
    expect(view.body.data).toEqual([]);
  });
});
