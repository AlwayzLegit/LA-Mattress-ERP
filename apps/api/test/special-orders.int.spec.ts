/**
 * G3 + G7 acceptance (STORIS cutover): a special-order line lands in the
 * to-order queue, generate-PO turns it into a vendor PO with per-line
 * allocations, and receiving the PO commits the arrived units to the
 * waiting customer and emails "your item is in". Serials: register at
 * the dock, pick for the line, sold on fulfillment with the customer
 * stamped.
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
  process.env.SPECIALS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_specials';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'Specials!2026x';

let app: INestApplication;
let businessId = '';
let locationId = '';
let customerId = '';
let vendorId = '';
/** Adjustable base: serial-tracked, 0 on hand — it has to be bought. */
let baseVariantId = '';
let ownerCookie = '';

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
      .values({ slug: 'specials-test', name: 'Specials Test Co', status: 'active' })
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
    const [u] = await db
      .insert(schema.users)
      .values({ email: 'owner@specials-test.local', emailVerified: true, name: 'Owner' })
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
      roleId: roles.get('Owner')!,
      status: 'active',
      acceptedAt: new Date(),
    });

    const [loc] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Dock', timezone: 'America/Los_Angeles', taxRateBps: 0 })
      .returning();
    locationId = loc!.id;

    const [cust] = await db
      .insert(schema.customers)
      .values({
        businessId,
        firstName: 'Sam',
        lastName: 'Waits',
        email: 'sam.waits@example.test',
      })
      .returning();
    customerId = cust!.id;

    const [vend] = await db
      .insert(schema.vendors)
      .values({ businessId, name: 'Adjustable Co', email: 'orders@adjustable.test' })
      .returning();
    vendorId = vend!.id;

    const [p] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'ADJ', name: 'Adjustable Base', serialTracked: true })
      .returning();
    const [v] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: p!.id, sku: 'ADJ-Q', priceCents: 80_000, costCents: 40_000 })
      .returning();
    baseVariantId = v!.id;
    // No inventory row on purpose: nothing on hand, nothing reserved.
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

function ownerReq() {
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

async function level(): Promise<{ onHand: number; reserved: number }> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const [row] = await db
      .select()
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, baseVariantId),
          eq(schema.inventoryLevels.locationId, locationId),
        ),
      );
    return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'specials-test-secret-specials-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RESEND_API_KEY; // memory transport → /v1/dev/email/last

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();
  ownerCookie = await captureCookie('owner@specials-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('G3 — special orders: queue → PO → receive → customer', () => {
  let orderId = '';
  let orderLineId = '';
  let poId = '';
  let poNumber = '';

  it('a confirmed special-order line reserves nothing (there is nothing to reserve)', async () => {
    const res = await ownerReq()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        lines: [{ variantId: baseVariantId, quantity: 2, lineType: 'special_order' }],
        confirm: true,
      });
    expect(res.status).toBe(201);
    orderId = res.body.id;
    orderLineId = res.body.lines[0].id;
    expect(res.body.lines[0].lineType).toBe('special_order');
    // Special-order lines never draw from the shared pool (Day 1 rule).
    expect(res.body.lines[0].qtyReserved).toBe(0);
    expect(await level()).toEqual({ onHand: 0, reserved: 0 });
  });

  it('the to-order queue shows the line with its customer', async () => {
    const res = await ownerReq().get('/v1/special-orders/queue');
    expect(res.status).toBe(200);
    const row = res.body.find((r: { orderLineId: string }) => r.orderLineId === orderLineId);
    expect(row).toBeTruthy();
    expect(row.toOrder).toBe(2);
    expect(row.customerName).toBe('Sam Waits');
    expect(row.sku).toBe('ADJ-Q');
  });

  it('generate-PO creates a vendor PO and allocates every unit', async () => {
    const res = await ownerReq()
      .post('/v1/special-orders/generate-po')
      .send({ vendorId, lines: [{ orderLineId, quantity: 2 }] });
    expect(res.status).toBe(201);
    poId = res.body.purchaseOrderId;
    poNumber = res.body.number;
    expect(poNumber).toMatch(/^PO-\d{4}-\d{6}$/);

    // Queue is now clear — everything is on order.
    const queue = await ownerReq().get('/v1/special-orders/queue');
    expect(
      queue.body.find((r: { orderLineId: string }) => r.orderLineId === orderLineId),
    ).toBeUndefined();

    // Cost fell back to the variant's recorded cost.
    const po = await ownerReq().get(`/v1/purchase-orders/${poId}`);
    expect(po.status).toBe(200);
    expect(po.body.lines[0].unitCostCents).toBe(40_000);
    expect(po.body.lines[0].quantityOrdered).toBe(2);
  });

  it('receiving commits the units to the customer and emails them', async () => {
    const po = await ownerReq().get(`/v1/purchase-orders/${poId}`);
    const poLineId = po.body.lines[0].id;

    const res = await ownerReq()
      .post(`/v1/purchase-orders/${poId}/receive`)
      .send({ lines: [{ lineId: poLineId, quantity: 2 }] });
    expect(res.status).toBe(201);

    // Stock arrived AND is committed to Sam — the shared pool never saw it.
    expect(await level()).toEqual({ onHand: 2, reserved: 2 });
    const order = await ownerReq().get(`/v1/orders/${orderId}`);
    expect(order.body.lines[0].qtyReserved).toBe(2);

    // The arrival email went to the customer via the captured transport.
    const mail = await request(app.getHttpServer())
      .get('/v1/dev/email/last')
      .query({ to: 'sam.waits@example.test' });
    expect(mail.status).toBe(200);
    expect(mail.body.subject).toMatch(/arrived/);
    expect(mail.body.subject).toContain(order.body.number);
  });

  it('serials: register at the dock, pick for the line, sold on fulfillment', async () => {
    const reg = await ownerReq()
      .post('/v1/serials/register')
      .send({ variantId: baseVariantId, locationId, serials: ['SN-001', 'SN-002'] });
    expect(reg.status).toBe(201);
    expect(reg.body).toHaveLength(2);
    const ids = reg.body.map((r: { id: string }) => r.id);

    const assign = await ownerReq()
      .post(`/v1/serials/assign/${orderLineId}`)
      .send({ serialUnitIds: ids });
    expect(assign.status).toBe(201);
    expect(assign.body.every((r: { status: string }) => r.status === 'committed')).toBe(true);

    // A third serial can't over-pick the 2-unit line.
    const extra = await ownerReq()
      .post('/v1/serials/register')
      .send({ variantId: baseVariantId, locationId, serials: ['SN-003'] });
    const over = await ownerReq()
      .post(`/v1/serials/assign/${orderLineId}`)
      .send({ serialUnitIds: [extra.body[0].id] });
    expect(over.status).toBe(400);

    // Fulfill (pickup path) → serials sold, customer stamped.
    const ful = await ownerReq().post(`/v1/orders/${orderId}/fulfill`).send({});
    expect(ful.status).toBe(201);
    expect(ful.body.status).toBe('fulfilled');

    const sold = await ownerReq().get(`/v1/serials?orderLineId=${orderLineId}`);
    expect(sold.body).toHaveLength(2);
    expect(sold.body.every((r: { status: string }) => r.status === 'sold')).toBe(true);
    expect(sold.body.every((r: { customerId: string }) => r.customerId === customerId)).toBe(true);

    expect(await level()).toEqual({ onHand: 0, reserved: 0 });
  });
});

describe('PO builder pre-load: sold-not-in-stock lines carry the SO # (P6)', () => {
  it('a PO created with orderLineId writes the allocation and shows the linked order', async () => {
    // Fresh special-order line for one unit.
    const order = await ownerReq()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        lines: [{ variantId: baseVariantId, quantity: 1, lineType: 'special_order' }],
        confirm: true,
      });
    expect(order.status).toBe(201);
    const orderLineId = order.body.lines[0].id;

    // The queue exposes the variant's preferred vendor for the builder filter.
    const setVendor = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${baseVariantId}/reorder`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ preferredVendorId: vendorId });
    expect(setVendor.status).toBe(200);

    const queue = await ownerReq().get('/v1/special-orders/queue');
    const row = queue.body.find((r: { orderLineId: string }) => r.orderLineId === orderLineId);
    expect(row).toBeTruthy();
    expect(row.preferredVendorId).toBe(vendorId);

    // The generic PO create accepts the orderLineId and links the sale.
    const po = await ownerReq()
      .post('/v1/purchase-orders')
      .send({
        vendorId,
        locationId,
        lines: [{ variantId: baseVariantId, quantity: 1, unitCostCents: 30000, orderLineId }],
      });
    expect(po.status).toBe(201);
    expect(po.body.lines[0].linkedOrders).toEqual([
      { orderId: order.body.id, orderNumber: order.body.number, quantity: 1 },
    ]);

    // Accepting the unit commits it to the customer (allocation flips).
    const received = await ownerReq()
      .post(`/v1/purchase-orders/${po.body.id}/receiving`)
      .send({ lines: [{ lineId: po.body.lines[0].id, received: 1, inspected: 1, accepted: 1 }] });
    expect(received.status).toBe(201);
    expect(received.body.status).toBe('received');

    const after = await ownerReq().get(`/v1/orders/${order.body.id}`);
    expect(after.status).toBe(200);
    expect(after.body.lines[0].qtyReserved).toBe(1);
  });
});

describe('Receipt reservations stop at what the line still needs (owner 2026-10-28)', () => {
  it('a line already reserved from stock is not reserved again when its PO lands', async () => {
    // One unit in free stock → the stock line reserves it at confirm.
    const before = await level();
    const adj = await ownerReq()
      .post('/v1/inventory/adjust')
      .send({ variantId: baseVariantId, locationId, delta: 1, reason: 'count_correction' });
    expect(adj.status).toBe(201);
    const order = await ownerReq()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        lines: [{ variantId: baseVariantId, quantity: 1 }],
        confirm: true,
      });
    expect(order.status).toBe(201);
    expect(order.body.lines[0].qtyReserved).toBe(1);
    expect(await level()).toEqual({ onHand: before.onHand + 1, reserved: before.reserved + 1 });

    // A PO was raised for the same line anyway (KO-10069: the count
    // correction and the PO both covered the one sale).
    const po = await ownerReq()
      .post('/v1/purchase-orders')
      .send({
        vendorId,
        locationId,
        lines: [
          {
            variantId: baseVariantId,
            quantity: 1,
            unitCostCents: 30000,
            orderLineId: order.body.lines[0].id,
          },
        ],
      });
    expect(po.status).toBe(201);
    const received = await ownerReq()
      .post(`/v1/purchase-orders/${po.body.id}/receiving`)
      .send({ lines: [{ lineId: po.body.lines[0].id, received: 1, inspected: 1, accepted: 1 }] });
    expect(received.status).toBe(201);

    // The unit entered stock, free: the line still holds exactly one.
    const after = await ownerReq().get(`/v1/orders/${order.body.id}`);
    expect(after.body.lines[0].qtyReserved).toBe(1);
    expect(await level()).toEqual({ onHand: before.onHand + 2, reserved: before.reserved + 1 });
    const drift = await ownerReq().get('/v1/orders/reservation-drift');
    expect(
      drift.body.find((r: { variantId: string }) => r.variantId === baseVariantId),
    ).toBeUndefined();
  });
});

describe('PO-060 (I7) — direct ship: vendor ships to the customer, stock never moves', () => {
  let dsVariantId = '';
  let orderId = '';
  let orderLineId = '';
  let poId = '';
  let poLineId = '';

  async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      return await fn(drizzle(sql2));
    } finally {
      await sql2.end({ timeout: 5 });
    }
  }

  async function dsLevel(): Promise<{ onHand: number; reserved: number }> {
    return withDb(async (db) => {
      const [row] = await db
        .select()
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, dsVariantId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
      return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 };
    });
  }

  it('setup: stocked variant + a customer address on file', async () => {
    await withDb(async (db) => {
      const [p] = await db
        .insert(schema.products)
        .values({ businessId, sku: 'DS-SOFA', name: 'Drop-Ship Sofa' })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({
          businessId,
          productId: p!.id,
          sku: 'DS-SOFA-1',
          priceCents: 90_000,
          costCents: 45_000,
        })
        .returning();
      dsVariantId = v!.id;
      await db.insert(schema.inventoryLevels).values({
        businessId,
        variantId: dsVariantId,
        locationId,
        onHand: 3,
        reserved: 0,
      });
      await db
        .update(schema.customers)
        .set({ addressesJson: [{ line1: '1 Main St', city: 'Los Angeles', zip: '90001' }] })
        .where(eq(schema.customers.id, customerId));
    });
  });

  it('a stock line on an open order flips to direct_ship and releases its reservation', async () => {
    const res = await ownerReq()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        lines: [{ variantId: dsVariantId, quantity: 2 }],
        confirm: true,
      });
    expect(res.status).toBe(201);
    orderId = res.body.id;
    orderLineId = res.body.lines[0].id;
    expect(res.body.lines[0].qtyReserved).toBe(2);
    expect(await dsLevel()).toEqual({ onHand: 3, reserved: 2 });

    const flipped = await request(app.getHttpServer())
      .patch(`/v1/orders/${orderId}/lines/${orderLineId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ lineType: 'direct_ship' });
    expect(flipped.status).toBe(200);
    const line = flipped.body.lines.find((l: { id: string }) => l.id === orderLineId);
    expect(line.lineType).toBe('direct_ship');
    expect(line.qtyReserved).toBe(0);
    expect(await dsLevel()).toEqual({ onHand: 3, reserved: 0 });
  });

  it('the queue flags it direct_ship; generate-PO snapshots the customer ship-to', async () => {
    const queue = await ownerReq().get('/v1/special-orders/queue');
    const row = queue.body.find((r: { orderLineId: string }) => r.orderLineId === orderLineId);
    expect(row).toBeTruthy();
    expect(row.lineType).toBe('direct_ship');
    expect(row.toOrder).toBe(2);

    const gen = await ownerReq()
      .post('/v1/special-orders/generate-po')
      .send({ vendorId, lines: [{ orderLineId, quantity: 2 }] });
    expect(gen.status).toBe(201);
    poId = gen.body.purchaseOrderId;

    const po = await ownerReq().get(`/v1/purchase-orders/${poId}`);
    expect(po.status).toBe(200);
    expect(po.body.directShip).toBe(true);
    expect(po.body.shipToJson.name).toBe('Sam Waits');
    expect(po.body.shipToJson.address[0].line1).toBe('1 Main St');
    poLineId = po.body.lines[0].id;
  });

  it('a direct-ship PO cannot mix with stock-bound special-order lines', async () => {
    const other = await ownerReq()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        lines: [{ variantId: baseVariantId, quantity: 1, lineType: 'special_order' }],
        confirm: true,
      });
    expect(other.status).toBe(201);
    const mixed = await ownerReq()
      .post('/v1/special-orders/generate-po')
      .send({
        vendorId,
        lines: [
          { orderLineId, quantity: 1 },
          { orderLineId: other.body.lines[0].id, quantity: 1 },
        ],
      });
    expect(mixed.status).toBe(400);
    expect(mixed.body.message).toMatch(/[Dd]irect-ship/);
  });

  it('receiving fulfills the line with zero stock impact, posts COGS, and emails the customer', async () => {
    const before = await dsLevel();
    const res = await ownerReq()
      .post(`/v1/purchase-orders/${poId}/receive`)
      .send({ lines: [{ lineId: poLineId, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');

    // Stock did not move — no on-hand, no reservation, no movement row.
    expect(await dsLevel()).toEqual(before);
    await withDb(async (db) => {
      const movements = await db
        .select()
        .from(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.referenceId, poId));
      expect(movements).toHaveLength(0);
      // COGS: the PO's cost layer exists but is fully consumed by a
      // direct_ship consumption at the PO cost.
      const layers = await db
        .select()
        .from(schema.costLayers)
        .where(eq(schema.costLayers.referenceId, poId));
      expect(layers).toHaveLength(1);
      expect(layers[0]!.quantityRemaining).toBe(0);
      const consumptions = await db
        .select()
        .from(schema.costConsumptions)
        .where(eq(schema.costConsumptions.layerId, layers[0]!.id));
      expect(consumptions).toHaveLength(1);
      expect(consumptions[0]!.referenceType).toBe('direct_ship');
      expect(consumptions[0]!.quantity).toBe(2);
      expect(consumptions[0]!.unitCostCents).toBe(45_000);
    });

    // The customer's line is FULFILLED (not reserved) and the order follows.
    const order = await ownerReq().get(`/v1/orders/${orderId}`);
    const line = order.body.lines.find((l: { id: string }) => l.id === orderLineId);
    expect(line.qtyFulfilled).toBe(2);
    expect(line.qtyReserved).toBe(0);
    expect(order.body.status).toBe('fulfilled');

    const mail = await request(app.getHttpServer())
      .get('/v1/dev/email/last')
      .query({ to: 'sam.waits@example.test' });
    expect(mail.status).toBe(200);
    expect(mail.body.subject).toMatch(/on its way/);
  });

  it('un-receive and dock rejects are refused on a direct-ship PO', async () => {
    const unrec = await ownerReq()
      .post(`/v1/purchase-orders/${poId}/unreceive`)
      .send({ lines: [{ lineId: poLineId, quantity: 1 }] });
    expect(unrec.status).toBe(400);
    expect(unrec.body.message).toMatch(/direct-ship/);

    // A second direct-ship order + PO to probe the reject guard.
    const order2 = await ownerReq()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        lines: [{ variantId: dsVariantId, quantity: 1, lineType: 'direct_ship' }],
        confirm: true,
      });
    expect(order2.status).toBe(201);
    const line2 = order2.body.lines[0].id;
    const gen2 = await ownerReq()
      .post('/v1/special-orders/generate-po')
      .send({ vendorId, lines: [{ orderLineId: line2, quantity: 1 }] });
    expect(gen2.status).toBe(201);
    const po2 = await ownerReq().get(`/v1/purchase-orders/${gen2.body.purchaseOrderId}`);
    const rejected = await ownerReq()
      .post(`/v1/purchase-orders/${gen2.body.purchaseOrderId}/receiving`)
      .send({
        lines: [{ lineId: po2.body.lines[0].id, received: 1, inspected: 1, rejected: 1 }],
      });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toMatch(/return/);

    // And the line type is now locked behind its PO.
    const relock = await request(app.getHttpServer())
      .patch(`/v1/orders/${order2.body.id}/lines/${line2}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ lineType: 'stock' });
    expect(relock.status).toBe(400);
    expect(relock.body.message).toMatch(/purchase order/i);
  });

  it('line-type change is refused once units are fulfilled', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/orders/${orderId}/lines/${orderLineId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ lineType: 'stock' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/fulfilled/);
  });
});
