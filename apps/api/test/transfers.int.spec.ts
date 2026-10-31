/**
 * Phase 2.4 acceptance: a clerk creates a stock transfer between two
 * locations, ships it (origin loses inventory), receives it partially
 * then in full at the destination (destination gains inventory), and
 * the audit trail reflects every step.
 *
 * Also covers ship-time stock validation, the same-location refusal,
 * cancel from draft only, and the role gate.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.TRANSFERS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_transfers';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'TransPass!2026';

let app: INestApplication;
let businessId = '';
let mainLocationId = '';
let warehouseLocationId = '';
let variantAId = '';
let variantBId = '';
let clerkCookie = '';
let cashierCookie = '';
let managerCookie = '';

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
        slug: 'trans-test',
        name: 'Transfer Test Co',
        status: 'active',
        // Q3 default is print-before-ship ON; the legacy flow tests here
        // predate the gate, so the fixture switches it off. Dedicated
        // gate tests flip it back on.
        opsSettingsJson: { transfers: { requireTicketBeforeShip: false } },
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
    await makeUser('clerk@trans-test.local', 'Warehouse');
    await makeUser('cashier@trans-test.local', 'Cashier');
    await makeUser('manager@trans-test.local', 'Manager');

    const [main] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Main Store', timezone: 'America/New_York' })
      .returning();
    mainLocationId = main!.id;
    const [warehouse] = await db
      .insert(schema.locations)
      .values({
        businessId,
        name: 'Warehouse',
        timezone: 'America/New_York',
        locationType: 'warehouse',
      })
      .returning();
    warehouseLocationId = warehouse!.id;

    const [pA] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'WIDGET', name: 'Widget' })
      .returning();
    const [vA] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: pA!.id, sku: 'WIDGET-1', priceCents: 1000, costCents: 600 })
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

    // Stock starts at the warehouse: 20 widgets + 10 gadgets. Main is empty.
    await db.insert(schema.inventoryLevels).values([
      { businessId, variantId: variantAId, locationId: warehouseLocationId, onHand: 20 },
      { businessId, variantId: variantBId, locationId: warehouseLocationId, onHand: 10 },
    ]);
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

async function levelAt(variantId: string, locationId: string): Promise<number> {
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
  process.env.BETTER_AUTH_SECRET ??= 'trans-test-secret-trans-test-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();

  clerkCookie = await captureCookie('clerk@trans-test.local');
  cashierCookie = await captureCookie('cashier@trans-test.local');
  managerCookie = await captureCookie('manager@trans-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Phase 2.4 — Stock transfers', () => {
  it('Cashier (no inventory.transfer) is denied transfer creation', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/stock-transfers')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: variantAId, quantity: 1 }],
      });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/inventory\.transfer/);
  });

  it('Same-location transfer is rejected', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/stock-transfers')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: warehouseLocationId,
        lines: [{ variantId: variantAId, quantity: 1 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must differ/);
  });

  let transferId = '';
  let widgetLineId = '';
  let gadgetLineId = '';
  it('Clerk creates a draft transfer (8 widgets + 4 gadgets warehouse → main)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/stock-transfers')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        notes: 'Restock Main Store',
        lines: [
          { variantId: variantAId, quantity: 8 },
          { variantId: variantBId, quantity: 4 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.number).toMatch(/^ST-\d{4}-\d{6}$/);
    expect(res.body.fromLocationName).toBe('Warehouse');
    expect(res.body.toLocationName).toBe('Main Store');
    transferId = res.body.id;
    widgetLineId = res.body.lines.find((l: { variantId: string }) => l.variantId === variantAId).id;
    gadgetLineId = res.body.lines.find((l: { variantId: string }) => l.variantId === variantBId).id;
    // Owner 2026-10-30: each line says what the origin holds right now.
    const widget = res.body.lines.find((l: { variantId: string }) => l.variantId === variantAId);
    expect(widget).toMatchObject({ onHandAtFrom: 20, reservedAtFrom: 0, availableAtFrom: 20 });
  });

  it('Cannot ship a quantity exceeding origin on-hand', async () => {
    // Try to make a second transfer for 100 widgets from the warehouse —
    // origin only has 20.
    const created = await request(app.getHttpServer())
      .post('/v1/stock-transfers')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: variantAId, quantity: 100 }],
      });
    expect(created.status).toBe(201);

    const ship = await request(app.getHttpServer())
      .post(`/v1/stock-transfers/${created.body.id}/ship`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(ship.status).toBe(400);
    expect(ship.body.message).toMatch(/Insufficient stock/);

    // Cancel that bad draft so it doesn't pollute later tests.
    await request(app.getHttpServer())
      .post(`/v1/stock-transfers/${created.body.id}/cancel`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId);
  });

  it('Ship: warehouse drops by 8 widgets + 4 gadgets, status flips to in_transit', async () => {
    const wh1 = await levelAt(variantAId, warehouseLocationId);
    const wg1 = await levelAt(variantBId, warehouseLocationId);
    const main1 = await levelAt(variantAId, mainLocationId);

    const res = await request(app.getHttpServer())
      .post(`/v1/stock-transfers/${transferId}/ship`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('in_transit');
    expect(res.body.shippedAt).toBeTruthy();

    expect(await levelAt(variantAId, warehouseLocationId)).toBe(wh1 - 8);
    expect(await levelAt(variantBId, warehouseLocationId)).toBe(wg1 - 4);
    // Destination not yet credited.
    expect(await levelAt(variantAId, mainLocationId)).toBe(main1);
  });

  it('Cannot cancel an in-transit transfer', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/stock-transfers/${transferId}/cancel`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Only draft/);
  });

  it('Receive 5 widgets first — main gets +5, transfer stays in_transit', async () => {
    const before = await levelAt(variantAId, mainLocationId);
    const res = await request(app.getHttpServer())
      .post(`/v1/stock-transfers/${transferId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: widgetLineId, quantity: 5 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('in_transit');
    expect(await levelAt(variantAId, mainLocationId)).toBe(before + 5);
  });

  it('Cannot over-receive (3 widgets remaining, 5 too many)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/stock-transfers/${transferId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: widgetLineId, quantity: 5 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only 3 remaining/);
  });

  it('Receive remaining 3 widgets + all 4 gadgets — flips to received, levels even out', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/stock-transfers/${transferId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        lines: [
          { lineId: widgetLineId, quantity: 3 },
          { lineId: gadgetLineId, quantity: 4 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');
    expect(res.body.receivedAt).toBeTruthy();

    // Net effect: warehouse -8 widgets / -4 gadgets, main +8 widgets / +4 gadgets.
    expect(await levelAt(variantAId, warehouseLocationId)).toBe(20 - 8);
    expect(await levelAt(variantBId, warehouseLocationId)).toBe(10 - 4);
    expect(await levelAt(variantAId, mainLocationId)).toBe(8);
    expect(await levelAt(variantBId, mainLocationId)).toBe(4);
  });

  it('Receiving a received transfer is forbidden', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/stock-transfers/${transferId}/receive`)
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ lineId: widgetLineId, quantity: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Cannot receive a received/);
  });

  it('Inventory ledger has matched transfer_out + transfer_in pairs', async () => {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    try {
      const movements = await db
        .select()
        .from(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.referenceId, transferId));
      const outs = movements.filter((m) => m.reason === 'transfer_out');
      const ins = movements.filter((m) => m.reason === 'transfer_in');
      expect(outs.length).toBe(2); // one per line at ship-time
      expect(ins.length).toBe(3); // 5 widgets + 3 widgets + 4 gadgets across two receipts
      const outSum = outs.reduce((s, m) => s + m.delta, 0);
      const inSum = ins.reduce((s, m) => s + m.delta, 0);
      expect(outSum).toBe(-12); // -8 widgets - 4 gadgets
      expect(inSum).toBe(12);
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  it('Create-and-ship in one shot via {ship: true} writes both ledger sides immediately', async () => {
    const before = await levelAt(variantAId, warehouseLocationId);
    const res = await request(app.getHttpServer())
      .post('/v1/stock-transfers')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        ship: true,
        lines: [{ variantId: variantAId, quantity: 2 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('in_transit');
    expect(await levelAt(variantAId, warehouseLocationId)).toBe(before - 2);
  });
});

describe('Transfer ticket data (PLAN-POS-OPERATIONS P7)', () => {
  it('detail carries the from/to store blocks and letterhead the printed ticket needs', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/stock-transfers')
      .set('Cookie', clerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: variantAId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.businessName).toBe('Transfer Test Co');
    expect(created.body.fromLocationName).toBe('Warehouse');
    expect(created.body.toLocationName).toBe('Main Store');
    // Address blocks round-trip (null when the location has none on file).
    expect(created.body).toHaveProperty('fromLocationAddressJson');
    expect(created.body).toHaveProperty('toLocationAddressJson');
  });
});

describe('Transfer variance + aging + types (PLAN-STORIS-GAP G8)', () => {
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

  it('a short transfer cannot be dismissed: close-short needs write-off authority + reason, values shrink at cost', async () => {
    // Ship 4 widgets, receive 3 — one walked off the truck.
    const created = await as(clerkCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        transferType: 'floor_sample',
        lines: [{ variantId: variantAId, quantity: 4 }],
        ship: true,
      });
    expect(created.status).toBe(201);
    expect(created.body.transferType).toBe('floor_sample');
    const transferId = created.body.id as string;
    const lineId = created.body.lines[0].id as string;

    await as(clerkCookie)
      .post(`/v1/stock-transfers/${transferId}/receive`)
      .send({ lines: [{ lineId, quantity: 3 }] })
      .expect(201);

    // The clerk lacks inventory.write_off → override required.
    const blocked = await as(clerkCookie)
      .post(`/v1/stock-transfers/${transferId}/close-short`)
      .send({ reason: 'lost in transit' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('OVERRIDE_REQUIRED');
    expect(blocked.body.permission).toBe('inventory.write_off');

    const closed = await as(clerkCookie)
      .post(`/v1/stock-transfers/${transferId}/close-short`)
      .send({
        override: {
          email: 'manager@trans-test.local',
          password: PASSWORD,
          reason: 'lost in transit',
        },
      });
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('closed_short');

    // The missing unit is shrink: on the write-off register at cost.
    const register = await as(managerCookie).get('/v1/write-offs?days=7');
    const row = register.body.rows.find((r: { reason: string | null }) =>
      r.reason?.includes(closed.body.number),
    );
    expect(row).toBeTruthy();
    expect(row.quantity).toBe(1);
    expect(row.totalCostCents).toBe(600);

    const exceptions = await as(managerCookie).get('/v1/exceptions?type=transfer_variance');
    expect(
      exceptions.body.data.some((e: { entityId: string | null }) => e.entityId === transferId),
    ).toBe(true);

    // A fully-received transfer refuses a short close.
    const clean = await as(clerkCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: variantBId, quantity: 1 }],
        ship: true,
      });
    const cleanLine = clean.body.lines[0].id as string;
    await as(clerkCookie)
      .post(`/v1/stock-transfers/${clean.body.id}/receive`)
      .send({ lines: [{ lineId: cleanLine, quantity: 1 }] })
      .expect(201);
    await as(clerkCookie)
      .post(`/v1/stock-transfers/${clean.body.id}/close-short`)
      .send({ reason: 'nope' })
      .expect(403); // received → ForbiddenException before anything else
  });

  it('aging surfaces transfers stuck in transit', async () => {
    const created = await as(clerkCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: variantAId, quantity: 1 }],
        ship: true,
      });
    expect(created.status).toBe(201);

    // Backdate the shipment a week.
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      await db
        .update(schema.stockTransfers)
        .set({ shippedAt: new Date(Date.now() - 7 * 86_400_000) })
        .where(eq(schema.stockTransfers.id, created.body.id));
    } finally {
      await sql2.end({ timeout: 5 });
    }

    const aging = await as(clerkCookie).get('/v1/stock-transfers/aging?days=3');
    expect(aging.status).toBe(200);
    const hit = aging.body.find((t: { id: string }) => t.id === created.body.id);
    expect(hit).toBeTruthy();
    expect(hit.daysInTransit).toBeGreaterThanOrEqual(6);
  });
});

describe('Auto transfers (FAQ J4/J5 — XFR-051/052/053)', () => {
  let atVariantId = '';
  let customerId = '';

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

  async function autoTransfersFor(orderId: string) {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      return await db
        .select()
        .from(schema.stockTransfers)
        .where(eq(schema.stockTransfers.orderId, orderId));
    } finally {
      await sql2.end({ timeout: 5 });
    }
  }

  async function shortOrder(quantity: number): Promise<{ id: string }> {
    const res = await as(managerCookie)
      .post('/v1/orders')
      .send({
        locationId: mainLocationId,
        customerId,
        fulfillmentType: 'pickup',
        confirm: true,
        lines: [{ variantId: atVariantId, quantity }],
      });
    expect(res.status).toBe(201);
    return { id: res.body.id };
  }

  it('setup: fixture variant stocked only at the warehouse; schedule days = 2', async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'AT-BED', name: 'Auto Transfer Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'AT-BED-V1', priceCents: 40000 })
        .returning();
      atVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: atVariantId,
        locationId: warehouseLocationId,
        onHand: 10,
        reserved: 0,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }

    const customer = await as(managerCookie)
      .post('/v1/customers')
      .send({ firstName: 'Auto', lastName: 'Transfer' });
    expect(customer.status).toBe(201);
    customerId = customer.body.id;

    const settings = await as(managerCookie)
      .patch('/v1/business/settings')
      .send({ ops: { autoScheduleDays: 2 } });
    expect(settings.status).toBe(200);
  });

  it('a confirmed short order writes ONE draft auto transfer from the stocked store', async () => {
    const order = await shortOrder(3);

    const transfers = await autoTransfersFor(order.id);
    expect(transfers).toHaveLength(1);
    const t = transfers[0]!;
    expect(t.transferType).toBe('auto');
    expect(t.status).toBe('draft');
    expect(t.fromLocationId).toBe(warehouseLocationId);
    expect(t.toLocationId).toBe(mainLocationId);

    // XFR-053: scheduled = today + 2 + 1, every weekday allowed.
    const expected = new Date();
    expected.setHours(12, 0, 0, 0);
    expected.setDate(expected.getDate() + 3);
    expect(t.scheduledFor).toBe(expected.toISOString().slice(0, 10));

    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const lines = await db
        .select()
        .from(schema.stockTransferLines)
        .where(eq(schema.stockTransferLines.transferId, t.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.variantId).toBe(atVariantId);
      expect(lines[0]!.quantityShipped).toBe(3);
    } finally {
      await sql2.end({ timeout: 5 });
    }

    // Re-running the reservation must not double-generate (dedupe against
    // the open auto transfer).
    const again = await as(managerCookie).post(`/v1/orders/${order.id}/reserve`).send({});
    expect(again.status).toBe(201);
    expect(await autoTransfersFor(order.id)).toHaveLength(1);
  });

  it('blank Auto Schedule Days disables the feature entirely (XFR-052)', async () => {
    await as(managerCookie)
      .patch('/v1/business/settings')
      .send({ ops: { autoScheduleDays: null } })
      .expect(200);
    const order = await shortOrder(2);
    expect(await autoTransfersFor(order.id)).toHaveLength(0);
  });

  it('a destination with no replenishment days checked skips with a warning, never loops', async () => {
    await as(managerCookie)
      .patch('/v1/business/settings')
      .send({ ops: { autoScheduleDays: 1 } })
      .expect(200);
    await as(managerCookie)
      .patch(`/v1/business/locations/${mainLocationId}`)
      .send({ replenishmentDays: [] })
      .expect(200);

    const order = await shortOrder(1);
    expect(await autoTransfersFor(order.id)).toHaveLength(0);

    const exceptions = await as(managerCookie).get('/v1/exceptions?type=auto_transfer_skipped');
    expect(exceptions.status).toBe(200);
    expect(exceptions.body.data.length).toBeGreaterThan(0);

    // Restore: all days again.
    await as(managerCookie)
      .patch(`/v1/business/locations/${mainLocationId}`)
      .send({ replenishmentDays: null })
      .expect(200);
  });
});

describe('J2/J3 — floor samples + serial pieces on transfers', () => {
  let serVariantId = '';
  let serial1 = '';
  let serial2 = '';

  function asManager() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', managerCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', managerCookie)
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

  it('setup: serial-tracked fixture with two pieces at the warehouse', async () => {
    await withDb(async (db) => {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'SER-BED', name: 'Serial Fixture Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'SER-BED-V1', priceCents: 60000 })
        .returning();
      serVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: serVariantId,
        locationId: warehouseLocationId,
        onHand: 3,
        reserved: 0,
      });
      const rows = await db
        .insert(schema.serialUnits)
        .values([
          {
            businessId,
            variantId: serVariantId,
            locationId: warehouseLocationId,
            serial: 'SN-001',
          },
          {
            businessId,
            variantId: serVariantId,
            locationId: warehouseLocationId,
            serial: 'SN-002',
          },
        ])
        .returning({ id: schema.serialUnits.id });
      serial1 = rows[0]!.id;
      serial2 = rows[1]!.id;
    });
  });

  it('a named piece rides the transfer: ship flags in_transit, receive re-homes it', async () => {
    const created = await asManager()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        ship: true,
        lines: [{ variantId: serVariantId, quantity: 1, serialIds: [serial1] }],
      });
    expect(created.status).toBe(201);

    await withDb(async (db) => {
      const [su] = await db
        .select()
        .from(schema.serialUnits)
        .where(eq(schema.serialUnits.id, serial1));
      expect(su!.status).toBe('in_transit');
    });

    const lineId = created.body.lines[0].id;
    const received = await asManager()
      .post(`/v1/stock-transfers/${created.body.id}/receive`)
      .send({ lines: [{ lineId, quantity: 1 }] });
    expect(received.status).toBe(201);

    await withDb(async (db) => {
      const [su] = await db
        .select()
        .from(schema.serialUnits)
        .where(eq(schema.serialUnits.id, serial1));
      expect(su!.status).toBe('in_stock');
      expect(su!.locationId).toBe(mainLocationId);
    });
  });

  it('serial validation refuses wrong-location and over-quantity picks', async () => {
    // serial1 now lives at main — naming it on a warehouse-origin line fails.
    const wrongLoc = await asManager()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: serVariantId, quantity: 1, serialIds: [serial1] }],
      });
    expect(wrongLoc.status).toBe(400);
    expect(wrongLoc.body.message).toMatch(/not at the origin/);

    const tooMany = await asManager()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: serVariantId, quantity: 1, serialIds: [serial2, serial2] }],
      });
    expect(tooMany.status).toBe(400);
  });

  it('a floor_sample transfer nails the piece down and removes it from available', async () => {
    const created = await asManager()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        transferType: 'floor_sample',
        ship: true,
        lines: [{ variantId: serVariantId, quantity: 1, serialIds: [serial2] }],
      });
    expect(created.status).toBe(201);
    await asManager()
      .post(`/v1/stock-transfers/${created.body.id}/receive`)
      .send({ lines: [{ lineId: created.body.lines[0].id, quantity: 1 }] })
      .expect(201);

    await withDb(async (db) => {
      const [su] = await db
        .select()
        .from(schema.serialUnits)
        .where(eq(schema.serialUnits.id, serial2));
      expect(su!.status).toBe('floor_sample');
      expect(su!.locationId).toBe(mainLocationId);
    });

    const levels = await asManager().get(`/v1/inventory/levels?locationId=${mainLocationId}`);
    const row = (
      levels.body as {
        variantId: string;
        onHand: number;
        floorSample: number;
        available: number;
      }[]
    ).find((l) => l.variantId === serVariantId);
    expect(row).toBeTruthy();
    expect(row!.onHand).toBe(2); // both pieces arrived at main
    expect(row!.floorSample).toBe(1); // the nailed-down one
    expect(row!.available).toBe(1); // only the sellable piece
  });

  it('the manual floor-sample hold clamps to on-hand and is reversible', async () => {
    const set = await asManager()
      .post('/v1/inventory/levels/floor-sample')
      .send({ variantId: serVariantId, locationId: mainLocationId, quantity: 999 });
    expect(set.status).toBe(201);
    expect(set.body.floorSample).toBe(2); // clamped to on-hand

    const back = await asManager()
      .post('/v1/inventory/levels/floor-sample')
      .send({ variantId: serVariantId, locationId: mainLocationId, quantity: 1 });
    expect(back.status).toBe(201);
    expect(back.body.floorSample).toBe(1);
  });
});

describe('As-Is consolidation intake + H2 RTV unwind', () => {
  let asVariantId = '';
  let asSerialId = '';
  let transferId = '';
  let pieceIds: string[] = [];

  function asManager() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', managerCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', managerCookie)
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

  it('setup: damaged-goods fixture with two units + a serial at the warehouse', async () => {
    await withDb(async (db) => {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'ASIS-BED', name: 'As-Is Fixture Bed' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'ASIS-BED-V1', priceCents: 50000 })
        .returning();
      asVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: asVariantId,
        locationId: warehouseLocationId,
        onHand: 2,
        reserved: 0,
      });
      const [su] = await db
        .insert(schema.serialUnits)
        .values({
          businessId,
          variantId: asVariantId,
          locationId: warehouseLocationId,
          serial: 'SN-ASIS-1',
        })
        .returning({ id: schema.serialUnits.id });
      asSerialId = su!.id;
    });
  });

  it('an as_is transfer stages received units in review, not sellable stock', async () => {
    const created = await asManager()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        transferType: 'as_is',
        ship: true,
        lines: [{ variantId: asVariantId, quantity: 2, serialIds: [asSerialId] }],
      });
    expect(created.status).toBe(201);
    transferId = created.body.id;

    const received = await asManager()
      .post(`/v1/stock-transfers/${transferId}/receive`)
      .send({ lines: [{ lineId: created.body.lines[0].id, quantity: 2 }] });
    expect(received.status).toBe(201);
    expect(received.body.status).toBe('received');

    // Nothing sellable landed at the destination…
    const levels = await asManager().get(`/v1/inventory/levels?locationId=${mainLocationId}`);
    const row = (levels.body as { variantId: string; onHand: number }[]).find(
      (l) => l.variantId === asVariantId,
    );
    expect(row?.onHand ?? 0).toBe(0);

    // …the origin still shows the outflow…
    const origin = await asManager().get(`/v1/inventory/levels?locationId=${warehouseLocationId}`);
    const orow = (origin.body as { variantId: string; onHand: number }[]).find(
      (l) => l.variantId === asVariantId,
    );
    expect(orow?.onHand ?? 0).toBe(0);

    // …and the units wait in the as-is review queue, one piece each.
    const queue = await asManager().get('/v1/as-is?status=pending_review');
    const pieces = (
      queue.body.data as {
        id: string;
        variantId: string;
        referenceType: string | null;
        referenceId: string | null;
        pieceNumber: string | null;
        source: string;
        locationId: string;
      }[]
    ).filter((r) => r.referenceType === 'stock_transfer' && r.referenceId === transferId);
    expect(pieces).toHaveLength(2);
    pieceIds = pieces.map((r) => r.id);
    for (const piece of pieces) {
      expect(piece.variantId).toBe(asVariantId);
      expect(piece.source).toBe('transfer');
      expect(piece.locationId).toBe(mainLocationId);
      expect(piece.pieceNumber).toMatch(/^AS-/);
    }

    await withDb(async (db) => {
      // The named serial is staged, not sellable.
      const [su] = await db
        .select()
        .from(schema.serialUnits)
        .where(eq(schema.serialUnits.id, asSerialId));
      expect(su!.status).toBe('returned');
      expect(su!.locationId).toBe(mainLocationId);
      // No transfer_in ledger entry was written for an as_is receive.
      const movements = await db
        .select()
        .from(schema.inventoryMovements)
        .where(
          and(
            eq(schema.inventoryMovements.referenceId, transferId),
            eq(schema.inventoryMovements.reason, 'transfer_in'),
          ),
        );
      expect(movements).toHaveLength(0);
    });
  });

  it('a staged piece restocks through the normal as-is review', async () => {
    const reviewed = await asManager()
      .post(`/v1/as-is/${pieceIds[0]}/review`)
      .send({ action: 'restock' });
    expect(reviewed.status).toBe(201);
    expect(reviewed.body.status).toBe('restocked');

    const levels = await asManager().get(`/v1/inventory/levels?locationId=${mainLocationId}`);
    const row = (levels.body as { variantId: string; onHand: number }[]).find(
      (l) => l.variantId === asVariantId,
    );
    expect(row?.onHand).toBe(1);
  });

  it('H2: a wrong-vendor RTV unwinds — piece back to review, credit voided', async () => {
    const sent = await asManager()
      .post(`/v1/as-is/${pieceIds[1]}/review`)
      .send({ action: 'vendor_return', raNumber: 'RA-WRONG-1', expectedCreditCents: 12500 });
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('vendor_return');
    expect(sent.body.vendorCreditStatus).toBe('open');

    const reopened = await asManager().post(`/v1/as-is/${pieceIds[1]}/reopen`).send({
      notes: 'Sent to the wrong vendor — pulling it back',
    });
    expect(reopened.status).toBe(201);
    expect(reopened.body.status).toBe('pending_review');
    expect(reopened.body.vendorRaNumber).toBeNull();
    expect(reopened.body.vendorCreditCents).toBeNull();
    expect(reopened.body.vendorCreditStatus).toBeNull();

    // Reopening a piece that is not a vendor_return is refused.
    const again = await asManager().post(`/v1/as-is/${pieceIds[1]}/reopen`).send({});
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/vendor_return/);
  });

  it('H2: a received credit blocks the unwind — reverse with the vendor first', async () => {
    const resent = await asManager()
      .post(`/v1/as-is/${pieceIds[1]}/review`)
      .send({ action: 'vendor_return', raNumber: 'RA-RIGHT-1', expectedCreditCents: 12500 });
    expect(resent.status).toBe(201);
    await withDb(async (db) => {
      await db
        .update(schema.asIsItems)
        .set({ vendorCreditStatus: 'received' })
        .where(eq(schema.asIsItems.id, pieceIds[1]!));
    });
    const blocked = await asManager().post(`/v1/as-is/${pieceIds[1]}/reopen`).send({});
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/received/);
  });
});

describe('Transfers pack quick wins — hold/scheduled quantity (D18/D19) + excess inquiry', () => {
  function asClerk() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
    };
  }

  let holdTransferId = '';
  let holdLineId = '';

  beforeAll(async () => {
    // Top the warehouse back up so earlier suites cannot starve these
    // tests: 30 widgets available at the origin.
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    try {
      await db
        .update(schema.inventoryLevels)
        .set({ onHand: 30, reserved: 0, floorSample: 0 })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantAId),
            eq(schema.inventoryLevels.locationId, warehouseLocationId),
          ),
        );
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  it('D18: ordered 10 / scheduled 4 → 6 held, and only 4 ship', async () => {
    const bad = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: variantAId, quantity: 4, quantityOrdered: 2 }],
      });
    expect(bad.status).toBe(400); // ordered below scheduled is nonsense

    const res = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: variantAId, quantity: 4, quantityOrdered: 10 }],
      });
    expect(res.status).toBe(201);
    holdTransferId = res.body.id;
    holdLineId = res.body.lines[0].id;
    expect(res.body.lines[0].quantityOrdered).toBe(10);
    expect(res.body.lines[0].quantityHeld).toBe(6);
    expect(res.body.lines[0].quantityShipped).toBe(4);

    const originBefore = await levelAt(variantAId, warehouseLocationId);
    const shipped = await asClerk().post(`/v1/stock-transfers/${holdTransferId}/ship`).send({});
    expect(shipped.status).toBe(201);
    // Only the scheduled 4 leave the origin — held units never move.
    expect(await levelAt(variantAId, warehouseLocationId)).toBe(originBefore - 4);
  });

  it('D19: full receipt completes the transfer and rolls the held 6 into a fresh draft', async () => {
    const received = await asClerk()
      .post(`/v1/stock-transfers/${holdTransferId}/receive`)
      .send({ lines: [{ lineId: holdLineId, quantity: 4 }] });
    expect(received.status).toBe(201);
    expect(received.body.status).toBe('received');

    const list = await asClerk().get('/v1/stock-transfers?status=draft');
    const rollover = (list.body.data as { id: string; number: string; status: string }[]).filter(
      (t) => t.id !== holdTransferId,
    );
    const detailed = await Promise.all(
      rollover.map(async (t) => (await asClerk().get(`/v1/stock-transfers/${t.id}`)).body),
    );
    const draft = detailed.find(
      (d: { notes?: string | null }) => d.notes?.includes('rolled over') ?? false,
    ) as { notes: string; lines: { variantId: string; quantityShipped: number }[] } | undefined;
    expect(draft).toBeTruthy();
    expect(draft!.notes).toContain('D19');
    const line = draft!.lines.find((l) => l.variantId === variantAId);
    expect(line?.quantityShipped).toBe(6); // schedulable again, nothing lost
  });

  it('excess inquiry lists variants whose stock exceeds their largest single move', async () => {
    // Self-contained fixture: 50 in stock, largest single move is 2.
    let excessVariantId = '';
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    try {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'EXCESS', name: 'Excess Widget' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'EXCESS-1', priceCents: 100 })
        .returning();
      excessVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: excessVariantId,
        locationId: warehouseLocationId,
        onHand: 50,
      });
    } finally {
      await sqlc.end({ timeout: 5 });
    }
    const moved = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId: excessVariantId, quantity: 2 }],
      });
    expect(moved.status).toBe(201);

    const res = await asClerk().get('/v1/stock-transfers/excess');
    expect(res.status).toBe(200);
    const row = (
      res.body.rows as { variantId: string; totalQuantity: number; maxTransferQuantity: number }[]
    ).find((r) => r.variantId === excessVariantId);
    expect(row).toBeTruthy();
    expect(row!.totalQuantity).toBe(50);
    expect(row!.maxTransferQuantity).toBe(2);

    // The widget from earlier suites has a 100-unit line on record —
    // larger than its whole stock — so it must NOT appear (that is the
    // point of the report: only genuinely excess stock shows).
    expect(
      (res.body.rows as { variantId: string }[]).find((r) => r.variantId === variantAId),
    ).toBeUndefined();
  });
});

describe('Transfers pack Q2/Q3 — location types + ship gates (owner 2026-08-28)', () => {
  let secondStoreId = '';
  let gateVariantId = '';

  function asClerk() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
    };
  }

  /** Whole-object overwrite is fine here — this suite owns the fixture. */
  async function setTransferOps(ops: Record<string, unknown>): Promise<void> {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      await drizzle(sqlc)
        .update(schema.businesses)
        .set({ opsSettingsJson: { transfers: ops } })
        .where(eq(schema.businesses.id, businessId));
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const db = drizzle(sqlc);
      const [store] = await db
        .insert(schema.locations)
        .values({ businessId, name: 'Second Store', timezone: 'America/New_York' })
        .returning();
      secondStoreId = store!.id;
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'GATE-1', name: 'Gate Widget' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({
          businessId,
          productId: p!.id,
          sku: 'GATE-1-V',
          priceCents: 5000,
          costCents: 2500,
        })
        .returning();
      gateVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values([
        { businessId, locationId: mainLocationId, variantId: gateVariantId, onHand: 20 },
        { businessId, locationId: warehouseLocationId, variantId: gateVariantId, onHand: 20 },
      ]);
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  afterAll(async () => {
    // Back to the legacy-flow fixture the earlier suites rely on.
    await setTransferOps({ requireTicketBeforeShip: false });
  });

  it('Q3: ship is blocked until the ticket prints; printing unlocks it and reprints bump the count', async () => {
    await setTransferOps({}); // defaults: gate ON
    const created = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: mainLocationId,
        toLocationId: secondStoreId,
        lines: [{ variantId: gateVariantId, quantity: 3 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.ticketPrintedAt).toBeNull();
    expect(created.body.ticketPrintCount).toBe(0);
    const id = created.body.id as string;

    const blocked = await asClerk().post(`/v1/stock-transfers/${id}/ship`).send({});
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain('Print the transfer ticket before shipping');

    const printed = await asClerk().post(`/v1/stock-transfers/${id}/ticket-printed`).send({});
    expect(printed.status).toBe(201);
    expect(printed.body.ticketPrintCount).toBe(1);

    const detail = await asClerk().get(`/v1/stock-transfers/${id}`);
    expect(detail.body.ticketPrintedAt).not.toBeNull();
    expect(detail.body.ticketPrintCount).toBe(1);

    const shipped = await asClerk().post(`/v1/stock-transfers/${id}/ship`).send({});
    expect(shipped.status).toBe(201);
    expect(shipped.body.status).toBe('in_transit');

    // Reprint after ship stays legal and only bumps the count.
    const reprint = await asClerk().post(`/v1/stock-transfers/${id}/ticket-printed`).send({});
    expect(reprint.status).toBe(201);
    expect(reprint.body.ticketPrintCount).toBe(2);
  });

  it('Q3: create with {ship: true} is rejected while the gate is on', async () => {
    await setTransferOps({});
    const res = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: mainLocationId,
        toLocationId: secondStoreId,
        ship: true,
        lines: [{ variantId: gateVariantId, quantity: 1 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('printed transfer ticket is required');
  });

  it('Q2/E20: store→store is rejected when the gate is off; a warehouse origin still passes', async () => {
    await setTransferOps({ storeToStore: false, requireTicketBeforeShip: false });
    const rejected = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: mainLocationId,
        toLocationId: secondStoreId,
        lines: [{ variantId: gateVariantId, quantity: 1 }],
      });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toContain('Store-to-store transfers are disabled');

    const viaWarehouse = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: secondStoreId,
        lines: [{ variantId: gateVariantId, quantity: 1 }],
      });
    expect(viaWarehouse.status).toBe(201);
  });

  it('Q3: a canceled transfer cannot print a ticket', async () => {
    await setTransferOps({ requireTicketBeforeShip: false });
    const created = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: mainLocationId,
        toLocationId: secondStoreId,
        lines: [{ variantId: gateVariantId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    const canceled = await asClerk().post(`/v1/stock-transfers/${created.body.id}/cancel`).send({});
    expect(canceled.status).toBe(201);
    const res = await asClerk()
      .post(`/v1/stock-transfers/${created.body.id}/ticket-printed`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('canceled');
  });
});

describe('Q1 manifests — build, load numbers, complete ships the truck (owner 2026-08-28)', () => {
  let laneFromId = ''; // warehouse
  let laneToId = ''; // a store
  let manifVariantId = '';
  let manifestId = '';

  function asClerk() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
    };
  }
  async function setTransferOps(ops: Record<string, unknown>): Promise<void> {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      await drizzle(sqlc)
        .update(schema.businesses)
        .set({ opsSettingsJson: { transfers: ops } })
        .where(eq(schema.businesses.id, businessId));
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  }
  async function makeDraft(quantity: number): Promise<{ id: string; number: string }> {
    const res = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: laneFromId,
        toLocationId: laneToId,
        lines: [{ variantId: manifVariantId, quantity }],
      });
    expect(res.status).toBe(201);
    return { id: res.body.id, number: res.body.number };
  }

  beforeAll(async () => {
    laneFromId = warehouseLocationId;
    await setTransferOps({ requireTicketBeforeShip: false });
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const db = drizzle(sqlc);
      const [store] = await db
        .insert(schema.locations)
        .values({ businessId, name: 'Manifest Store', timezone: 'America/New_York' })
        .returning();
      laneToId = store!.id;
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'MANIF-1', name: 'Manifest Widget' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({
          businessId,
          productId: p!.id,
          sku: 'MANIF-1-V',
          priceCents: 2000,
          costCents: 900,
        })
        .returning();
      manifVariantId = v!.id;
      await db
        .insert(schema.inventoryLevels)
        .values([{ businessId, locationId: laneFromId, variantId: manifVariantId, onHand: 60 }]);
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  afterAll(async () => {
    await setTransferOps({ requireTicketBeforeShip: false });
  });

  it('build creates on a new key, appends on the same open key, and hands out load numbers', async () => {
    const a = await makeDraft(2);
    const b = await makeDraft(3);
    const built = await asClerk()
      .post('/v1/stock-manifests')
      .send({
        fromLocationId: laneFromId,
        toLocationId: laneToId,
        manifestDate: '2026-09-01',
        routeName: 'Truck 1',
        transferIds: [a.id, b.id],
      });
    expect(built.status).toBe(201);
    expect(built.body.number).toMatch(/^MAN-\d{4}-\d{4}$/);
    expect(built.body.status).toBe('open');
    expect(built.body.transferCount).toBe(2);
    manifestId = built.body.id;

    // Same open key appends with an explicit later load.
    const c = await makeDraft(1);
    const appended = await asClerk()
      .post('/v1/stock-manifests')
      .send({
        fromLocationId: laneFromId,
        toLocationId: laneToId,
        manifestDate: '2026-09-01',
        routeName: 'Truck 1',
        transferIds: [c.id],
        loadNumber: 2,
      });
    expect(appended.status).toBe(201);
    expect(appended.body.id).toBe(manifestId);
    expect(appended.body.transferCount).toBe(3);
    const loads = (appended.body.transfers as { loadNumber: number | null }[]).map(
      (t) => t.loadNumber,
    );
    expect(loads.sort()).toEqual([1, 1, 2]);

    // A different date is a different truck run.
    const d = await makeDraft(1);
    const other = await asClerk()
      .post('/v1/stock-manifests')
      .send({
        fromLocationId: laneFromId,
        toLocationId: laneToId,
        manifestDate: '2026-09-02',
        routeName: 'Truck 1',
        transferIds: [d.id],
      });
    expect(other.status).toBe(201);
    expect(other.body.id).not.toBe(manifestId);
    // Clean up the second manifest so the lane's drafts stay predictable.
    await asClerk().post(`/v1/stock-manifests/${other.body.id}/cancel`).send({});
  });

  it('a manifested transfer cannot ship or cancel directly, and cannot join twice', async () => {
    const detail = await asClerk().get(`/v1/stock-manifests/${manifestId}`);
    const first = detail.body.transfers[0] as { id: string };

    const ship = await asClerk().post(`/v1/stock-transfers/${first.id}/ship`).send({});
    expect(ship.status).toBe(400);
    expect(ship.body.message).toContain('on a manifest');

    const cancel = await asClerk().post(`/v1/stock-transfers/${first.id}/cancel`).send({});
    expect(cancel.status).toBe(400);
    expect(cancel.body.message).toContain('remove it from the manifest');

    const again = await asClerk()
      .post('/v1/stock-manifests')
      .send({
        fromLocationId: laneFromId,
        toLocationId: laneToId,
        manifestDate: '2026-09-03',
        transferIds: [first.id],
      });
    expect(again.status).toBe(400);
    expect(again.body.message).toContain('already on a manifest');
  });

  it('remove-transfer frees the draft (F178: audited exception) and it ships normally again', async () => {
    const detail = await asClerk().get(`/v1/stock-manifests/${manifestId}`);
    const victim = (detail.body.transfers as { id: string; loadNumber: number | null }[]).find(
      (t) => t.loadNumber === 2,
    )!;
    const removed = await asClerk()
      .post(`/v1/stock-manifests/${manifestId}/remove-transfer`)
      .send({ transferId: victim.id, reason: 'missed the truck' });
    expect(removed.status).toBe(201);
    expect(removed.body.transferCount).toBe(2);

    const ship = await asClerk().post(`/v1/stock-transfers/${victim.id}/ship`).send({});
    expect(ship.status).toBe(201);
    expect(ship.body.status).toBe('in_transit');
  });

  it('complete respects the print gate, then ships every draft on the truck', async () => {
    await setTransferOps({}); // Q3 gate ON
    const blocked = await asClerk().post(`/v1/stock-manifests/${manifestId}/complete`).send({});
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain('Print the transfer ticket');

    const detail = await asClerk().get(`/v1/stock-manifests/${manifestId}`);
    for (const t of detail.body.transfers as { id: string }[]) {
      await asClerk().post(`/v1/stock-transfers/${t.id}/ticket-printed`).send({}).expect(201);
    }
    const done = await asClerk().post(`/v1/stock-manifests/${manifestId}/complete`).send({});
    expect(done.status).toBe(201);
    expect(done.body.status).toBe('completed');
    for (const t of done.body.transfers as { status: string }[]) {
      expect(t.status).toBe('in_transit');
    }
    // 2 + 3 units left the warehouse on this truck (the removed transfer
    // shipped separately, and the second manifest was canceled unshipped).
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const [lvl] = await drizzle(sqlc)
        .select({ onHand: schema.inventoryLevels.onHand })
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.locationId, laneFromId),
            eq(schema.inventoryLevels.variantId, manifVariantId),
          ),
        );
      expect(lvl!.onHand).toBe(60 - 2 - 3 - 1);
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    const reComplete = await asClerk().post(`/v1/stock-manifests/${manifestId}/complete`).send({});
    expect(reComplete.status).toBe(403);
  });
});

/**
 * Owner 2026-10-30: moving an As-Is piece by the piece. A draft line
 * names one piece in the origin's As-Is queue; shipping puts it on the
 * truck and receiving lands it in the destination's queue. The stock
 * levels on both ends never move.
 */
describe('As-Is pieces on transfer lines (owner 2026-10-30)', () => {
  let variantId = '';
  let pieceId = '';
  let transferId = '';
  function asClerk() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', clerkCookie)
          .set('X-Business-Id', businessId),
    };
  }
  function asManager() {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Cookie', managerCookie)
          .set('X-Business-Id', businessId),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', managerCookie)
          .set('X-Business-Id', businessId),
    };
  }
  async function piece(): Promise<{
    status: string;
    locationId: string;
    transferLineId: string | null;
  }> {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const [row] = await drizzle(sqlc)
        .select({
          status: schema.asIsItems.status,
          locationId: schema.asIsItems.locationId,
          transferLineId: schema.asIsItems.transferLineId,
        })
        .from(schema.asIsItems)
        .where(eq(schema.asIsItems.id, pieceId));
      return row!;
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  }
  async function level(locationId: string): Promise<number | null> {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const [row] = await drizzle(sqlc)
        .select({ onHand: schema.inventoryLevels.onHand })
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
      return row?.onHand ?? null;
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  }

  it('setup: an item with one piece in the warehouse As-Is queue and no stock anywhere', async () => {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const db = drizzle(sqlc);
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'ASIS-MOVE', name: 'As-Is Mover Twin' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: p!.id, sku: 'ASIS-MOVE-1', priceCents: 30_000 })
        .returning();
      variantId = v!.id;
    } finally {
      await sqlc.end({ timeout: 5 });
    }
    const intake = await asManager().post('/v1/as-is').send({
      variantId,
      locationId: warehouseLocationId,
      quantity: 1,
      source: 'warranty',
      condition: 'light_wear',
    });
    expect(intake.status).toBe(201);
    pieceId = (Array.isArray(intake.body) ? intake.body[0] : intake.body).id;
  });

  it('a draft line naming the piece holds it; stock ships normally alongside', async () => {
    const res = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId, quantity: 1, asIsItemId: pieceId }],
      });
    expect(res.status).toBe(201);
    transferId = res.body.id;
    const line = res.body.lines[0];
    expect(line).toMatchObject({
      asIsItemId: pieceId,
      quantityShipped: 1,
      availableAtFrom: 0,
      asIs: { status: 'committed', locationId: warehouseLocationId },
    });
    expect(await piece()).toMatchObject({ status: 'committed', transferLineId: line.id });

    // The same piece cannot ride a second draft; a wrong-store piece is refused.
    const dup = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseLocationId,
        toLocationId: mainLocationId,
        lines: [{ variantId, quantity: 1, asIsItemId: pieceId }],
      });
    expect(dup.status).toBe(400);
    const wrongStore = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: mainLocationId,
        toLocationId: warehouseLocationId,
        lines: [{ variantId, quantity: 1, asIsItemId: pieceId }],
      });
    expect(wrongStore.status).toBe(400);
  });

  it('shipping puts the piece on the truck without touching the origin level', async () => {
    await asClerk().post(`/v1/stock-transfers/${transferId}/ticket-printed`).send({});
    const ship = await asClerk().post(`/v1/stock-transfers/${transferId}/ship`).send({});
    expect(ship.status).toBe(201);
    expect(ship.body.status).toBe('in_transit');
    expect((await piece()).status).toBe('in_transit');
    expect(await level(warehouseLocationId)).toBeNull();
  });

  it('receiving lands the piece in the destination queue, still as-is', async () => {
    const detail = await asClerk().get(`/v1/stock-transfers/${transferId}`);
    const lineId = detail.body.lines[0].id;
    const recv = await asClerk()
      .post(`/v1/stock-transfers/${transferId}/receive`)
      .send({ lines: [{ lineId, quantity: 1 }] });
    expect(recv.status).toBe(201);
    expect(recv.body.status).toBe('received');
    expect(await piece()).toEqual({
      status: 'pending_review',
      locationId: mainLocationId,
      transferLineId: null,
    });
    expect(await level(mainLocationId)).toBeNull();
    const queue = await asManager().get('/v1/as-is?status=pending_review');
    const row = queue.body.data.find((r: { id: string }) => r.id === pieceId);
    expect(row.locationName).toBe('Main Store');
    expect(row.holder).toBeNull();
  });

  it('canceling a draft that holds a piece hands it back', async () => {
    const draft = await asClerk()
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: mainLocationId,
        toLocationId: warehouseLocationId,
        lines: [{ variantId, quantity: 1, asIsItemId: pieceId }],
      });
    expect(draft.status).toBe(201);
    expect((await piece()).status).toBe('committed');
    const cancel = await asClerk().post(`/v1/stock-transfers/${draft.body.id}/cancel`).send({});
    expect(cancel.status).toBe(201);
    expect(await piece()).toMatchObject({ status: 'pending_review', transferLineId: null });
  });
});
