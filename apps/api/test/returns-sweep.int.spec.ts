/**
 * Amendment A22 slice 6 — STORIS Enter a Return (return salesperson,
 * store, fees, pickup on the delivery calendar, return ticket), Enter an
 * Exchange (fulfillment, refund tender, ticket) and Update a Customer
 * Address (customer number, business / contact name, name parts,
 * alternate contact, delivery instructions).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.RETURNS_SWEEP_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_returns_sweep';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'ReturnPass!2026';

let app: INestApplication;
let businessId = '';
let ownerCookie = '';
let ownerMembershipId = '';
let warehouseId = '';
let storeId = '';
let customerId = '';
let variantId = '';
let order1Id = '';
let line1Id = '';
let order2Id = '';
let line2Id = '';
let order3Id = '';
let line3Id = '';

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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

async function seed(): Promise<void> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'returns-test', name: 'Returns Test Co', status: 'active' })
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
      .values({ email: 'owner@returns-test.local', emailVerified: true, name: 'Olive Owner' })
      .returning();
    await db.insert(schema.accounts).values({
      accountId: u!.id,
      providerId: 'credential',
      userId: u!.id,
      password: passwordHash,
    });
    const [m] = await db
      .insert(schema.memberships)
      .values({
        businessId,
        userId: u!.id,
        roleId: roles.get('Owner')!,
        status: 'active',
        acceptedAt: new Date(),
      })
      .returning({ id: schema.memberships.id });
    ownerMembershipId = m!.id;

    const loc = async (name: string, locationType: string) => {
      const [l] = await db
        .insert(schema.locations)
        .values({ businessId, name, timezone: 'America/Los_Angeles', locationType })
        .returning({ id: schema.locations.id });
      return l!.id;
    };
    warehouseId = await loc('Warehouse', 'warehouse');
    storeId = await loc('Culver City', 'store');

    const [product] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'KING-SET', name: 'KING SET' })
      .returning({ id: schema.products.id });
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: product!.id,
        sku: 'KING-SET',
        priceCents: 50000,
        costCents: 20000,
      })
      .returning({ id: schema.productVariants.id });
    variantId = variant!.id;
    await db.insert(schema.inventoryLevels).values({
      businessId,
      variantId,
      locationId: warehouseId,
      onHand: 5,
    });

    const [customer] = await db
      .insert(schema.customers)
      .values({
        businessId,
        firstName: 'Jane',
        lastName: 'Doe',
        phone: '310-555-0100',
        // The migration numbers existing customers in creation order.
        customerNumber: 'C-000001',
      })
      .returning({ id: schema.customers.id });
    customerId = customer!.id;

    // Three delivered orders, fully paid, ready to return against.
    const order = async (number: string) => {
      const [o] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: storeId,
          stockLocationId: warehouseId,
          number,
          status: 'fulfilled',
          customerId,
          totalCents: 100000,
          addressCity: 'Culver City',
          addressPostalCode: '90230',
          completedAt: new Date(),
        })
        .returning({ id: schema.orders.id });
      const [l] = await db
        .insert(schema.orderLines)
        .values({
          businessId,
          orderId: o!.id,
          variantId,
          description: 'KING SET',
          quantity: 2,
          qtyFulfilled: 2,
          unitPriceCents: 50000,
          totalCents: 100000,
        })
        .returning({ id: schema.orderLines.id });
      await db.insert(schema.payments).values({
        businessId,
        orderId: o!.id,
        method: 'card',
        amountCents: 100000,
        status: 'succeeded',
      });
      return { orderId: o!.id, lineId: l!.id };
    };
    ({ orderId: order1Id, lineId: line1Id } = await order('SO-1'));
    ({ orderId: order2Id, lineId: line2Id } = await order('SO-2'));
    ({ orderId: order3Id, lineId: line3Id } = await order('SO-3'));
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

async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  try {
    return await fn(drizzle(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const as = (cookie: string) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', cookie).set('X-Business-Id', businessId),
  post: (url: string) =>
    request(app.getHttpServer()).post(url).set('Cookie', cookie).set('X-Business-Id', businessId),
  patch: (url: string) =>
    request(app.getHttpServer()).patch(url).set('Cookie', cookie).set('X-Business-Id', businessId),
});

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'returns-test-secret-returns-test-secret-!!';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();
  ownerCookie = await captureCookie('owner@returns-test.local');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('Enter a Return — salesperson, store, fees, pickup on the calendar, ticket', () => {
  let returnId = '';
  let pickupId = '';

  it('authorizes a truck pickup with fees withheld and puts the stop on the calendar', async () => {
    await as(ownerCookie)
      .post(`/v1/orders/${order1Id}/return`)
      .send({
        lines: [{ lineId: line1Id, quantity: 1 }],
        fulfillment: 'pickup',
        refundMethod: 'original',
        salespersonMembershipId: ownerMembershipId,
        locationId: storeId,
        restockingFeeCents: 5000,
        pickupFeeCents: 2500,
        pickupDate: day(2),
        pickupWindowStart: '13:00',
        pickupWindowEnd: '16:00',
        reason: 'too firm',
      })
      .expect(201);
    const list = await as(ownerCookie)
      .get(`/v1/order-returns?orderId=${order1Id}&status=authorized`)
      .expect(200);
    const ret = list.body.data[0];
    returnId = ret.id;
    // 1 × $500 − $50 − $25.
    expect(ret).toMatchObject({
      amountCents: 42500,
      restockingFeeCents: 5000,
      pickupFeeCents: 2500,
      pickupDate: day(2),
      salespersonMembershipId: ownerMembershipId,
      locationId: storeId,
    });
    expect(ret.pickupDeliveryId).toBeTruthy();
    pickupId = ret.pickupDeliveryId;

    const stop = await as(ownerCookie).get(`/v1/deliveries/${pickupId}`).expect(200);
    expect(stop.body).toMatchObject({
      kind: 'return_pickup',
      returnId,
      rmaNumber: ret.rmaNumber,
      scheduledDate: day(2),
      windowStart: '13:00:00',
      status: 'scheduled',
      orderNumber: 'SO-1',
    });
    expect(stop.body.lines).toHaveLength(1);
    const calendar = await as(ownerCookie)
      .get(`/v1/deliveries?from=${day(2)}&to=${day(2)}`)
      .expect(200);
    expect(calendar.body.map((d: { id: string }) => d.id)).toContain(pickupId);
  });

  it('the return detail names the store, the salesperson and the pickup; the ticket print counts', async () => {
    const detail = await as(ownerCookie).get(`/v1/order-returns/${returnId}`).expect(200);
    expect(detail.body).toMatchObject({
      orderNumber: 'SO-1',
      customerName: 'Jane Doe',
      customerPhone: '310-555-0100',
      locationName: 'Culver City',
      salespersonName: 'Olive Owner',
      linesTotalCents: 50000,
      amountCents: 42500,
      pickup: { deliveryId: pickupId, scheduledDate: day(2), windowStart: '13:00:00' },
      ticketPrintCount: 0,
    });
    const print = await as(ownerCookie)
      .post(`/v1/order-returns/${returnId}/ticket-print`)
      .expect(201);
    expect(print.body.ticketPrintCount).toBe(1);
  });

  it('completing the pickup stop receives the return: refund fires, stock never drops', async () => {
    await as(ownerCookie).post(`/v1/deliveries/${pickupId}/complete`).send({}).expect(201);
    const detail = await as(ownerCookie).get(`/v1/order-returns/${returnId}`).expect(200);
    expect(detail.body.status).toBe('completed');
    expect(detail.body.pickup.status).toBe('delivered');
    await withDb(async (db) => {
      const [level] = await db
        .select({ onHand: schema.inventoryLevels.onHand })
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantId),
            eq(schema.inventoryLevels.locationId, warehouseId),
          ),
        );
      expect(level!.onHand).toBe(5);
      const [line] = await db
        .select({ qtyReturned: schema.orderLines.qtyReturned })
        .from(schema.orderLines)
        .where(eq(schema.orderLines.id, line1Id));
      expect(line!.qtyReturned).toBe(1);
      const refunds = await db
        .select({ amountCents: schema.payments.amountCents })
        .from(schema.payments)
        .where(and(eq(schema.payments.orderId, order1Id), eq(schema.payments.kind, 'refund')));
      expect(refunds.map((r) => r.amountCents)).toEqual([-42500]);
    });
  });

  it('guards: fees above the line value, a pickup date on a drop-off, an unknown salesperson', async () => {
    await as(ownerCookie)
      .post(`/v1/orders/${order2Id}/return`)
      .send({ lines: [{ lineId: line2Id, quantity: 1 }], restockingFeeCents: 60000 })
      .expect(400);
    await as(ownerCookie)
      .post(`/v1/orders/${order2Id}/return`)
      .send({
        lines: [{ lineId: line2Id, quantity: 1 }],
        fulfillment: 'drop_off',
        pickupDate: day(1),
      })
      .expect(400);
    await as(ownerCookie)
      .post(`/v1/orders/${order2Id}/return`)
      .send({
        lines: [{ lineId: line2Id, quantity: 1 }],
        salespersonMembershipId: '00000000-0000-0000-0000-000000000000',
      })
      .expect(404);
  });
});

describe('Enter an Exchange — fulfillment, refund tender, ticket', () => {
  it('records the return salesperson, fulfillment and refund tender, and pays excess credit by that tender', async () => {
    // Return both units of SO-2 ($1,000) into an exchange for one unit ($500):
    // the customer is owed $500 back by card (original tender).
    await as(ownerCookie)
      .post(`/v1/orders/${order2Id}/return`)
      .send({
        lines: [{ lineId: line2Id, quantity: 2 }],
        fulfillment: 'pickup',
        refundMethod: 'store_credit',
      })
      .expect(201);
    const returns = await as(ownerCookie)
      .get(`/v1/order-returns?orderId=${order2Id}&status=authorized`)
      .expect(200);
    const returnId = returns.body.data[0].id as string;
    const replacement = await as(ownerCookie)
      .post(`/v1/orders/${order2Id}/exchange`)
      .send({
        locationId: storeId,
        confirm: true,
        lines: [{ variantId, quantity: 1, unitPriceCents: 50000 }],
      })
      .expect(201);
    const bound = await as(ownerCookie)
      .post('/v1/exchanges')
      .send({
        saleOrderId: replacement.body.id,
        returnId,
        returnSalespersonMembershipId: ownerMembershipId,
        fulfillment: 'drop_off',
        refundTender: 'original',
      })
      .expect(201);
    expect(bound.body).toMatchObject({
      returnSalespersonName: 'Olive Owner',
      fulfillment: 'drop_off',
      refundTender: 'original',
      ticketPrintCount: 0,
    });
    await as(ownerCookie)
      .post('/v1/exchanges')
      .send({ saleOrderId: replacement.body.id, returnId, refundTender: 'bitcoin' })
      .expect(400);

    await as(ownerCookie).post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    const settled = await as(ownerCookie).get(`/v1/exchanges/${bound.body.id}`).expect(200);
    expect(settled.body.settlement.saleBalanceDueCents).toBe(0);
    await withDb(async (db) => {
      const refunds = await db
        .select({ amountCents: schema.payments.amountCents, method: schema.payments.method })
        .from(schema.payments)
        .where(and(eq(schema.payments.orderId, order2Id), eq(schema.payments.kind, 'refund')));
      // $1,000 credit − the $500 (+ tax-free) replacement → $500 back by card.
      const total = refunds.reduce((s, r) => s + r.amountCents, 0);
      expect(total).toBe(-(100000 - settled.body.settlement.saleTotalCents));
      expect(refunds.every((r) => r.method === 'card')).toBe(true);
    });
    const print = await as(ownerCookie)
      .post(`/v1/exchanges/${bound.body.id}/ticket-print`)
      .expect(201);
    expect(print.body.ticketPrintCount).toBe(1);
  });

  it('store credit (the default) leaves the excess on the ledger', async () => {
    await as(ownerCookie)
      .post(`/v1/orders/${order3Id}/return`)
      .send({
        lines: [{ lineId: line3Id, quantity: 2 }],
        fulfillment: 'pickup',
        refundMethod: 'store_credit',
      })
      .expect(201);
    const returns = await as(ownerCookie)
      .get(`/v1/order-returns?orderId=${order3Id}&status=authorized`)
      .expect(200);
    const returnId = returns.body.data[0].id as string;
    const replacement = await as(ownerCookie)
      .post(`/v1/orders/${order3Id}/exchange`)
      .send({
        locationId: storeId,
        confirm: true,
        lines: [{ variantId, quantity: 1, unitPriceCents: 50000 }],
      })
      .expect(201);
    const bound = await as(ownerCookie)
      .post('/v1/exchanges')
      .send({ saleOrderId: replacement.body.id, returnId })
      .expect(201);
    expect(bound.body.refundTender).toBe('store_credit');
    await as(ownerCookie).post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    await withDb(async (db) => {
      const refunds = await db
        .select({ id: schema.payments.id })
        .from(schema.payments)
        .where(and(eq(schema.payments.orderId, order3Id), eq(schema.payments.kind, 'refund')));
      expect(refunds).toHaveLength(0);
    });
    await withDb(async (db) => {
      const entries = await db
        .select({ deltaCents: schema.storeCreditEntries.deltaCents })
        .from(schema.storeCreditEntries)
        .where(eq(schema.storeCreditEntries.customerId, customerId));
      // The $1,000 credit less the replacement stays spendable on the ledger.
      expect(entries.reduce((t, e) => t + e.deltaCents, 0)).toBeGreaterThan(0);
    });
  });
});

describe('Update a Customer Address — number, names, alternate contact, instructions', () => {
  it('assigns customer numbers, stores the name parts and finds customers by them', async () => {
    const created = await as(ownerCookie)
      .post('/v1/customers')
      .send({
        firstName: 'Robert',
        middleName: 'James',
        lastName: 'Roe',
        prefix: 'Dr.',
        suffix: 'Jr.',
        businessName: 'Roe Interiors LLC',
        contactName: 'Bobby',
        alternateName: 'Maria Roe',
        alternateRelationship: 'spouse',
        deliveryInstructions: 'Gate code 4411, back door',
        phone: '626-555-0300',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      customerNumber: 'C-000002',
      businessName: 'Roe Interiors LLC',
      prefix: 'Dr.',
      middleName: 'James',
      suffix: 'Jr.',
      alternateName: 'Maria Roe',
      alternateRelationship: 'spouse',
      deliveryInstructions: 'Gate code 4411, back door',
    });
    const jane = await as(ownerCookie).get(`/v1/customers/${customerId}`).expect(200);
    expect(jane.body.customerNumber).toBe('C-000001');

    for (const q of ['Interiors', 'Maria', 'C-000002', 'James']) {
      const hits = await as(ownerCookie)
        .get(`/v1/customers?q=${encodeURIComponent(q)}`)
        .expect(200);
      expect(hits.body.data.map((c: { id: string }) => c.id)).toContain(created.body.id);
    }

    const patched = await as(ownerCookie)
      .patch(`/v1/customers/${created.body.id}`)
      .send({ alternateRelationship: 'partner', deliveryInstructions: null })
      .expect(200);
    expect(patched.body).toMatchObject({
      alternateRelationship: 'partner',
      deliveryInstructions: null,
    });
  });

  it("the order's customer panel carries the number, trade names and instructions", async () => {
    await as(ownerCookie)
      .patch(`/v1/customers/${customerId}`)
      .send({ businessName: 'Doe & Co', deliveryInstructions: 'Leave with concierge' })
      .expect(200);
    const order = await as(ownerCookie).get(`/v1/orders/${order1Id}/document`).expect(200);
    expect(order.body.customer).toMatchObject({
      customerNumber: 'C-000001',
      businessName: 'Doe & Co',
      deliveryInstructions: 'Leave with concierge',
    });
  });
});
