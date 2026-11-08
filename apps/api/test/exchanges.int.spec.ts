/**
 * Enter an Exchange (docs/erp-exchange): the container over a customer
 * return and a replacement sales order. Covers the uneven happy path
 * (credit nets against the replacement through the store-credit
 * ledger), the restocking fee (percent + sticky override), the E1
 * approval hold, the financed-original even-exchange rule, Split
 * Exchange restoring plain-refund behavior, cancel, the no-original
 * (pre-cutover) path, and the same-customer guard.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.EXCHANGES_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_exchanges';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'Exchange!2026x';

let app: INestApplication;
let businessId = '';
let locationId = '';
let warehouseId = '';
let customerId = '';
let otherCustomerId = '';
let v1Id = ''; // original product
let v2Id = ''; // replacement product
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

async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
  try {
    return await fn(drizzle(sql2));
  } finally {
    await sql2.end({ timeout: 5 });
  }
}

async function seed() {
  await withDb(async (db) => {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'exchange-test', name: 'Exchange Test Co', status: 'active' })
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
      .values({ email: 'owner@exchange-test.local', emailVerified: true, name: 'Owner' })
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
      .values({ businessId, name: 'Store', timezone: 'America/Los_Angeles', taxRateBps: 0 })
      .returning();
    locationId = loc!.id;
    const [wh] = await db
      .insert(schema.locations)
      .values({
        businessId,
        name: 'Warehouse',
        timezone: 'America/Los_Angeles',
        taxRateBps: 0,
        locationType: 'warehouse',
      })
      .returning();
    warehouseId = wh!.id;

    const [cust] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Casey', lastName: 'Swap', email: 'casey@example.test' })
      .returning();
    customerId = cust!.id;
    const [cust2] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Alex', lastName: 'Other' })
      .returning();
    otherCustomerId = cust2!.id;

    const [p1] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'FIRM', name: 'Firm Queen' })
      .returning();
    const [va] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p1!.id,
        sku: 'FIRM-Q',
        priceCents: 50_000,
        costCents: 20_000,
      })
      .returning();
    v1Id = va!.id;
    const [p2] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'PLUSH', name: 'Plush Queen' })
      .returning();
    const [vb] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p2!.id,
        sku: 'PLUSH-Q',
        priceCents: 60_000,
        costCents: 25_000,
      })
      .returning();
    v2Id = vb!.id;

    await db.insert(schema.inventoryLevels).values([
      { businessId, variantId: v1Id, locationId, onHand: 20, reserved: 0 },
      { businessId, variantId: v2Id, locationId, onHand: 20, reserved: 0 },
      { businessId, variantId: v1Id, locationId: warehouseId, onHand: 10, reserved: 0 },
      { businessId, variantId: v2Id, locationId: warehouseId, onHand: 10, reserved: 0 },
    ]);
  });
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

function owner() {
  const base = (method: 'get' | 'post' | 'patch') => (url: string) =>
    request(app.getHttpServer())
      [method](url)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
  return { get: base('get'), post: base('post'), patch: base('patch') };
}

/** Original sold + paid (cash) + fulfilled, ready to exchange. */
async function soldOriginal(
  variantId: string,
  priceCents: number,
): Promise<{
  orderId: string;
  lineId: string;
}> {
  const created = await owner()
    .post('/v1/orders')
    .send({ locationId, customerId, confirm: true, lines: [{ variantId, quantity: 1 }] });
  expect(created.status).toBe(201);
  await owner()
    .post(`/v1/orders/${created.body.id}/payments`)
    .send({ method: 'cash', amountCents: priceCents, kind: 'deposit' })
    .expect(201);
  const fulfilled = await owner().post(`/v1/orders/${created.body.id}/fulfill`).send({});
  expect(fulfilled.status).toBe(201);
  return { orderId: created.body.id, lineId: created.body.lines[0].id };
}

/** Replacement order written against the original + an authorized pickup return. */
async function legsFor(
  originalOrderId: string,
  originalLineId: string,
  replacementVariantId: string,
): Promise<{ saleOrderId: string; returnId: string }> {
  const replacement = await owner()
    .post(`/v1/orders/${originalOrderId}/exchange`)
    .send({ locationId, confirm: true, lines: [{ variantId: replacementVariantId, quantity: 1 }] });
  expect(replacement.status).toBe(201);
  const authorized = await owner()
    .post(`/v1/orders/${originalOrderId}/return`)
    .send({ lines: [{ lineId: originalLineId, quantity: 1 }], fulfillment: 'pickup' });
  expect(authorized.status).toBe(201);
  const returns = await owner().get(
    `/v1/order-returns?orderId=${originalOrderId}&status=authorized`,
  );
  expect(returns.body.data).toHaveLength(1);
  return { saleOrderId: replacement.body.id, returnId: returns.body.data[0].id };
}

async function ledgerBalance(custId: string): Promise<number> {
  return withDb(async (db) => {
    const [row] = await db
      .select({ sum: dsql<number>`coalesce(sum(${schema.storeCreditEntries.deltaCents}), 0)::int` })
      .from(schema.storeCreditEntries)
      .where(eq(schema.storeCreditEntries.customerId, custId));
    return row?.sum ?? 0;
  });
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'exchange-test-secret-exchange-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RESEND_API_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();
  ownerCookie = await captureCookie('owner@exchange-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Enter an Exchange — container over a return and a replacement order', () => {
  it('uneven exchange: return credit nets against the replacement through the ledger', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);

    const bound = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(bound.status).toBe(201);
    expect(bound.body.number).toMatch(/^EX-\d{4}-\d{6}$/);
    expect(bound.body.status).toBe('open');
    expect(bound.body.settlement.returnCents).toBe(50_000);
    expect(bound.body.settlement.creditCents).toBe(50_000);
    expect(bound.body.settlement.saleTotalCents).toBe(60_000);

    // The pair is spoken for.
    const dup = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(dup.status).toBe(409);

    // Goods come back → settlement fires against the replacement.
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);

    const detail = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(detail.body.settlement.salePaidCents).toBe(50_000);
    expect(detail.body.settlement.saleBalanceDueCents).toBe(10_000);

    await withDb(async (db) => {
      // Credit landed on the replacement as a store-credit tender…
      const salePayments = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, saleOrderId));
      expect(salePayments).toHaveLength(1);
      expect(salePayments[0]!.method).toBe('store_credit');
      expect(salePayments[0]!.amountCents).toBe(50_000);
      // …no cash refund on the original…
      const origPayments = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, orig.orderId));
      expect(origPayments.filter((p) => p.amountCents < 0)).toHaveLength(0);
      // …the goods staged in As-Is review…
      const pieces = await db
        .select()
        .from(schema.asIsItems)
        .where(
          and(
            eq(schema.asIsItems.referenceType, 'order'),
            eq(schema.asIsItems.referenceId, orig.orderId),
          ),
        );
      expect(pieces).toHaveLength(1);
    });
    // …and the ledger nets to zero (issue then redeem).
    expect(await ledgerBalance(customerId)).toBe(0);
  });

  it('restocking fee: percent of the credit, sticky override, both audited', async () => {
    await owner()
      .patch('/v1/business/settings')
      .send({ ops: { restockingFeePercent: 10 } })
      .expect(200);

    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);

    // Overriding away from the calculated 5,000 needs the permission
    // (the owner has it) and marks the fee sticky.
    const bound = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId, returnId, restockingFeeCents: 2_000 });
    expect(bound.status).toBe(201);
    expect(bound.body.restockingFeeCents).toBe(2_000);
    expect(bound.body.restockingFeeOverridden).toBe(true);
    expect(bound.body.settlement.creditCents).toBe(48_000);

    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    const detail = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(detail.body.settlement.salePaidCents).toBe(48_000);
    expect(detail.body.settlement.saleBalanceDueCents).toBe(12_000);
    expect(await ledgerBalance(customerId)).toBe(0);

    await withDb(async (db) => {
      const [auditRow] = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'exchange.restocking_fee.override'))
        .limit(1);
      expect(auditRow).toBeTruthy();
    });

    await owner()
      .patch('/v1/business/settings')
      .send({ ops: { restockingFeePercent: null } })
      .expect(200);
  });

  it('E1 hold: a held exchange refuses settlement until approved', async () => {
    await owner()
      .patch('/v1/business/settings')
      .send({ ops: { exchangeHoldAtEntry: true } })
      .expect(200);

    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    const bound = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(bound.status).toBe(201);
    expect(bound.body.status).toBe('on_hold');

    const blocked = await owner().post(`/v1/order-returns/${returnId}/receive`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/held for approval/);

    const approved = await owner().post(`/v1/exchanges/${bound.body.id}/approve`).send({});
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('open');
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);

    await owner()
      .patch('/v1/business/settings')
      .send({ ops: { exchangeHoldAtEntry: false } })
      .expect(200);
  });

  it('financed original: only a like-for-like even exchange binds', async () => {
    const created = await owner()
      .post('/v1/orders')
      .send({ locationId, customerId, confirm: true, lines: [{ variantId: v1Id, quantity: 1 }] });
    expect(created.status).toBe(201);
    await withDb(async (db) => {
      await db.insert(schema.payments).values({
        businessId,
        saleId: null,
        orderId: created.body.id,
        kind: 'deposit',
        method: 'financing',
        amountCents: 50_000,
        status: 'succeeded',
        financingProvider: 'Acima',
        financingRef: 'FIN-1',
      });
    });
    await owner().post(`/v1/orders/${created.body.id}/fulfill`).send({}).expect(201);

    const { saleOrderId, returnId } = await legsFor(
      created.body.id,
      created.body.lines[0].id,
      v2Id,
    );
    const uneven = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(uneven.status).toBe(400);
    expect(uneven.body.message).toMatch(/financed/);

    const mismatched = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId, returnId, evenExchange: true });
    expect(mismatched.status).toBe(400);
    expect(mismatched.body.message).toMatch(/like-for-like/);

    // A same-variant replacement qualifies.
    const even = await owner()
      .post(`/v1/orders/${created.body.id}/exchange`)
      .send({ locationId, confirm: true, lines: [{ variantId: v1Id, quantity: 1 }] });
    expect(even.status).toBe(201);
    const ok = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId: even.body.id, returnId, evenExchange: true });
    expect(ok.status).toBe(201);
    expect(ok.body.evenExchange).toBe(true);
  });

  it('split dissolves the container — the return refunds plainly again', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    const bound = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(bound.status).toBe(201);

    const split = await owner().post(`/v1/exchanges/${bound.body.id}/split`).send({});
    expect(split.status).toBe(201);
    expect(split.body.status).toBe('split');

    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    await withDb(async (db) => {
      // Plain refund path: negative tender back on the ORIGINAL order…
      const origPayments = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, orig.orderId));
      expect(origPayments.filter((p) => p.amountCents < 0)).toHaveLength(1);
      // …and nothing landed on the replacement.
      const salePayments = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, saleOrderId));
      expect(salePayments).toHaveLength(0);
    });
  });

  it('cancel voids the container and the return authorization together', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    const bound = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(bound.status).toBe(201);

    const cancelled = await owner()
      .post(`/v1/exchanges/${bound.body.id}/cancel`)
      .send({ reason: 'Customer changed their mind' });
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.status).toBe('cancelled');

    const returns = await owner().get(`/v1/order-returns?orderId=${orig.orderId}`);
    expect(returns.body.data[0].status).toBe('cancelled');
  });

  it('no-original (pre-cutover) exchange applies the banked credit at bind', async () => {
    const noOrig = await owner()
      .post('/v1/order-returns/no-original')
      .send({
        customerId,
        locationId,
        referencedOrderNumber: 'STORIS-445566',
        lines: [{ variantId: v1Id, quantity: 1, unitRefundCents: 30_000 }],
      });
    expect(noOrig.status).toBe(201);
    expect(await ledgerBalance(customerId)).toBe(30_000);

    const replacement = await owner()
      .post('/v1/orders')
      .send({ locationId, customerId, confirm: true, lines: [{ variantId: v2Id, quantity: 1 }] });
    expect(replacement.status).toBe(201);

    const bound = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId: replacement.body.id, returnId: noOrig.body.id });
    expect(bound.status).toBe(201);
    expect(bound.body.referencedOrderNumber).toBe('STORIS-445566');
    expect(bound.body.settlement.salePaidCents).toBe(30_000);
    expect(bound.body.settlement.saleBalanceDueCents).toBe(30_000);
    expect(await ledgerBalance(customerId)).toBe(0);
  });

  it('pre-cutover exchange with a truck pickup: authorized no-original return, stop on the replacement, settles when the goods come back (dispatcher 2026-11-06)', async () => {
    const ledgerBefore = await ledgerBalance(customerId);
    const pending = await owner()
      .post('/v1/order-returns/no-original')
      .send({
        customerId,
        locationId,
        referencedOrderNumber: '03108303',
        reason: 'comfort exchange, STORIS invoice',
        fulfillment: 'pickup',
        pickupDate: '2026-11-08',
        lines: [{ variantId: v1Id, quantity: 1, unitRefundCents: 64_000 }],
      });
    expect(pending.status).toBe(201);
    expect(pending.body.status).toBe('authorized');
    expect(pending.body.fulfillment).toBe('pickup');
    expect(pending.body.pickupDate).toBe('2026-11-08');
    expect(pending.body.pickupDeliveryId).toBeNull();
    // Goods are still at the customer's: no credit, no As-Is piece yet.
    expect(await ledgerBalance(customerId)).toBe(ledgerBefore);
    await withDb(async (db) => {
      const pieces = await db
        .select()
        .from(schema.asIsItems)
        .where(eq(schema.asIsItems.referenceId, pending.body.id));
      expect(pieces).toHaveLength(0);
    });

    // Replacement: $740 delivered, the customer pays the $100 difference up front.
    const replacement = await owner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId,
        orderKind: 'exchange',
        fulfillmentType: 'delivery',
        confirm: true,
        lines: [{ variantId: v2Id, quantity: 1, unitPriceCents: 64_000 }],
        deliveryFeeCents: 10_000,
      });
    expect(replacement.status).toBe(201);
    expect(replacement.body.totalCents).toBe(74_000);

    // Leftover credit must stay as store credit — there is no original tender.
    const cashBack = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId: replacement.body.id, returnId: pending.body.id, refundTender: 'cash' });
    expect(cashBack.status).toBe(400);
    expect(cashBack.body.message).toMatch(/store credit/);

    const bound = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId: replacement.body.id, returnId: pending.body.id });
    expect(bound.status).toBe(201);
    expect(bound.body.referencedOrderNumber).toBe('03108303');
    expect(bound.body.originalOrderId).toBeNull();
    expect(bound.body.fulfillment).toBe('pickup');
    expect(bound.body.returnStatus).toBe('authorized');
    // Nothing settled yet — the ticket nets the credit, the order does not.
    expect(bound.body.settlement.creditCents).toBe(64_000);
    expect(bound.body.settlement.salePaidCents).toBe(0);
    expect(bound.body.settlement.saleBalanceDueCents).toBe(74_000);

    // The pickup is a stop on the replacement order (the truck already goes there).
    const retDetail = await owner().get(`/v1/order-returns/${pending.body.id}`);
    expect(retDetail.status).toBe(200);
    expect(retDetail.body.pickupDeliveryId).toBeTruthy();
    expect(retDetail.body.pickup.scheduledDate).toBe('2026-11-08');
    expect(retDetail.body.pickup.status).toBe('scheduled');
    const stops = await owner().get(`/v1/deliveries?orderId=${replacement.body.id}`);
    expect(stops.status).toBe(200);
    const stop = (stops.body as { id: string; kind: string; returnId: string | null }[]).find(
      (d) => d.kind === 'return_pickup',
    );
    expect(stop?.id).toBe(retDetail.body.pickupDeliveryId);
    expect(stop?.returnId).toBe(pending.body.id);

    await owner()
      .post(`/v1/orders/${replacement.body.id}/payments`)
      .send({ method: 'cash', amountCents: 10_000, kind: 'deposit' })
      .expect(201);

    // The truck brings the goods back: the stop completes, the return is
    // received, the credit is minted and applied — $0 left on the replacement.
    const picked = await owner().post(`/v1/deliveries/${stop!.id}/complete`).send({});
    expect(picked.status).toBe(201);
    expect(picked.body.status).toBe('delivered');
    const settled = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(settled.body.returnStatus).toBe('completed');
    expect(settled.body.settlement.salePaidCents).toBe(74_000);
    expect(settled.body.settlement.saleBalanceDueCents).toBe(0);
    expect(await ledgerBalance(customerId)).toBe(ledgerBefore);
    await withDb(async (db) => {
      const pieces = await db
        .select()
        .from(schema.asIsItems)
        .where(
          and(
            eq(schema.asIsItems.referenceType, 'order_return'),
            eq(schema.asIsItems.referenceId, pending.body.id),
          ),
        );
      expect(pieces).toHaveLength(1);
      expect(pieces[0]!.variantId).toBe(v1Id);
    });
  });

  it('cancelling a pre-cutover pickup exchange cancels the truck stop with the return', async () => {
    const pending = await owner()
      .post('/v1/order-returns/no-original')
      .send({
        customerId,
        locationId,
        referencedOrderNumber: '03100001',
        fulfillment: 'pickup',
        pickupDate: '2026-11-09',
        lines: [{ variantId: v1Id, quantity: 1, unitRefundCents: 10_000 }],
      });
    expect(pending.status).toBe(201);
    const replacement = await owner()
      .post('/v1/orders')
      .send({ locationId, customerId, confirm: true, lines: [{ variantId: v2Id, quantity: 1 }] });
    const bound = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId: replacement.body.id, returnId: pending.body.id });
    expect(bound.status).toBe(201);
    const cancelled = await owner()
      .post(`/v1/exchanges/${bound.body.id}/cancel`)
      .send({ reason: 'customer kept the mattress' });
    expect(cancelled.status).toBe(201);
    const retDetail = await owner().get(`/v1/order-returns/${pending.body.id}`);
    expect(retDetail.body.status).toBe('cancelled');
    expect(retDetail.body.pickup.status).toBe('cancelled');
  });

  it('the replacement must bill the return customer', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const authorized = await owner()
      .post(`/v1/orders/${orig.orderId}/return`)
      .send({ lines: [{ lineId: orig.lineId, quantity: 1 }], fulfillment: 'pickup' });
    expect(authorized.status).toBe(201);
    const returns = await owner().get(
      `/v1/order-returns?orderId=${orig.orderId}&status=authorized`,
    );
    const strangerOrder = await owner()
      .post('/v1/orders')
      .send({
        locationId,
        customerId: otherCustomerId,
        confirm: true,
        lines: [{ variantId: v2Id, quantity: 1 }],
      });
    expect(strangerOrder.status).toBe(201);
    const bound = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId: strangerOrder.body.id, returnId: returns.body.data[0].id });
    expect(bound.status).toBe(400);
    expect(bound.body.message).toMatch(/same customer/);
  });
});

describe('Hardening — review findings', () => {
  it('credit is capped at what the customer actually paid on the original', async () => {
    // Delivered but only half-paid: $200 collected on a $500 sale.
    const created = await owner()
      .post('/v1/orders')
      .send({ locationId, customerId, confirm: true, lines: [{ variantId: v1Id, quantity: 1 }] });
    expect(created.status).toBe(201);
    await owner()
      .post(`/v1/orders/${created.body.id}/payments`)
      .send({ method: 'cash', amountCents: 20_000, kind: 'deposit' })
      .expect(201);
    await owner().post(`/v1/orders/${created.body.id}/fulfill`).send({}).expect(201);

    // Exchange legs authorize as store_credit (like the writer does) —
    // the plain path's cash-refund cap would otherwise block a
    // half-paid original at authorization time.
    const replacement = await owner()
      .post(`/v1/orders/${created.body.id}/exchange`)
      .send({ locationId, confirm: true, lines: [{ variantId: v2Id, quantity: 1 }] });
    expect(replacement.status).toBe(201);
    const saleOrderId = replacement.body.id;
    await owner()
      .post(`/v1/orders/${created.body.id}/return`)
      .send({
        lines: [{ lineId: created.body.lines[0].id, quantity: 1 }],
        fulfillment: 'pickup',
        refundMethod: 'store_credit',
      })
      .expect(201);
    const rets = await owner().get(
      `/v1/order-returns?orderId=${created.body.id}&status=authorized`,
    );
    const returnId = rets.body.data[0].id as string;
    await owner().post('/v1/exchanges').send({ saleOrderId, returnId }).expect(201);
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);

    await withDb(async (db) => {
      const salePayments = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, saleOrderId));
      expect(salePayments).toHaveLength(1);
      expect(salePayments[0]!.amountCents).toBe(20_000); // not the $500 face value
      const [capAudit] = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'exchange.credit_capped'))
        .limit(1);
      expect(capAudit).toBeTruthy();
    });
    expect(await ledgerBalance(customerId)).toBe(0);
  });

  it('a cancelled exchange releases its legs — the same order re-binds cleanly', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    const first = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(first.status).toBe(201);
    await owner()
      .post(`/v1/exchanges/${first.body.id}/cancel`)
      .send({ reason: 'Bound the wrong return' })
      .expect(201);

    // Re-authorize (the cancel voided the first RMA) and bind the SAME
    // replacement order again — the dead container must not block it.
    const reauth = await owner()
      .post(`/v1/orders/${orig.orderId}/return`)
      .send({ lines: [{ lineId: orig.lineId, quantity: 1 }], fulfillment: 'pickup' });
    expect(reauth.status).toBe(201);
    const returns = await owner().get(
      `/v1/order-returns?orderId=${orig.orderId}&status=authorized`,
    );
    const rebound = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId, returnId: returns.body.data[0].id });
    expect(rebound.status).toBe(201);
    expect(rebound.body.id).not.toBe(first.body.id);
  });
});

/**
 * New Exchange stress test — twelve scenarios walking the writer's flow
 * (replacement order → return authorization → bind → settle) through
 * its failure modes: the coded-reason gate the owner hit in production,
 * the retry-binds-the-same-documents promise, quantity and status
 * guards, fee-override edges (including the 1-cent override from the
 * bug report), downgrade credit, deferred settlement, and double
 * receive.
 */
describe('New Exchange stress test', () => {
  /** Activate a reason code for the scenario, hand it to fn, then deactivate. */
  async function withReasonCode<T>(
    usageClass: string,
    code: string,
    fn: (id: string) => Promise<T>,
  ): Promise<T> {
    const id = await withDb(async (db) => {
      const [row] = await db
        .insert(schema.reasonCodes)
        .values({ businessId, code, description: `${code} (stress)`, usageClass, active: true })
        .returning();
      return row!.id;
    });
    try {
      return await fn(id);
    } finally {
      await withDb(async (db) => {
        await db
          .update(schema.reasonCodes)
          .set({ active: false })
          .where(eq(schema.reasonCodes.id, id));
      });
    }
  }

  it('S1 — owner amendment 2026-08-30: a typed reason suffices even when return codes exist; a code still binds when given', async () => {
    await withReasonCode('return', 'DEFECT', async (codeId) => {
      const orig = await soldOriginal(v1Id, 50_000);
      // Step 1 of the writer: the replacement order lands.
      const replacement = await owner()
        .post(`/v1/orders/${orig.orderId}/exchange`)
        .send({ locationId, confirm: true, lines: [{ variantId: v2Id, quantity: 1 }] });
      expect(replacement.status).toBe(201);
      // Step 2 with only the typed reason — this used to 400 demanding a
      // coded reason; the owner killed the picker.
      const freeText = await owner()
        .post(`/v1/orders/${orig.orderId}/return`)
        .send({
          fulfillment: 'pickup',
          refundMethod: 'store_credit',
          reason: 'Customer changed mind',
          lines: [{ lineId: orig.lineId, quantity: 1 }],
        });
      expect(freeText.status).toBe(201);
      const rets = await owner().get(`/v1/order-returns?orderId=${orig.orderId}&status=authorized`);
      expect(rets.body.data).toHaveLength(1);
      const bound = await owner()
        .post('/v1/exchanges')
        .send({ saleOrderId: replacement.body.id, returnId: rets.body.data[0].id });
      expect(bound.status).toBe(201);
      // The line carries the typed reason, no code.
      await withDb(async (db) => {
        const rows = await db
          .select()
          .from(schema.orderReturnLines)
          .where(eq(schema.orderReturnLines.returnId, rets.body.data[0].id));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reasonCodeId).toBeNull();
      });

      // A code, when the writer does pass one, still binds to the line.
      const orig2 = await soldOriginal(v1Id, 50_000);
      await owner()
        .post(`/v1/orders/${orig2.orderId}/return`)
        .send({
          fulfillment: 'pickup',
          refundMethod: 'store_credit',
          lines: [{ lineId: orig2.lineId, quantity: 1, reasonCodeId: codeId }],
        })
        .expect(201);
      const rets2 = await owner().get(
        `/v1/order-returns?orderId=${orig2.orderId}&status=authorized`,
      );
      await withDb(async (db) => {
        const rows = await db
          .select()
          .from(schema.orderReturnLines)
          .where(eq(schema.orderReturnLines.returnId, rets2.body.data[0].id));
        expect(rows[0]!.reasonCodeId).toBe(codeId);
      });
    });
  });

  it('S2 — the reason-code list the page renders: active return codes only, with id/code/description', async () => {
    await withReasonCode('return', 'COMFORT', async (codeId) => {
      const list = await owner().get('/v1/reason-codes?usageClass=return');
      expect(list.status).toBe(200);
      const hit = list.body.find((c: { id: string }) => c.id === codeId);
      expect(hit).toBeTruthy();
      expect(hit.code).toBe('COMFORT');
      expect(hit.active).toBe(true);
    });
    // Deactivated → gone from the picker, and the gate lifts again.
    const after = await owner().get('/v1/reason-codes?usageClass=return');
    expect(after.body.every((c: { code: string }) => c.code !== 'COMFORT')).toBe(true);
  });

  it('S3 — a code of the wrong class is rejected by the return', async () => {
    await withReasonCode('adjustment', 'PRICE-ADJ', async (wrongClassId) => {
      const orig = await soldOriginal(v1Id, 50_000);
      const res = await owner()
        .post(`/v1/orders/${orig.orderId}/return`)
        .send({
          fulfillment: 'pickup',
          refundMethod: 'store_credit',
          lines: [{ lineId: orig.lineId, quantity: 1, reasonCodeId: wrongClassId }],
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/class "return"/);
    });
  });

  it('S4 — return quantity above what was delivered is refused', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const res = await owner()
      .post(`/v1/orders/${orig.orderId}/return`)
      .send({ fulfillment: 'pickup', lines: [{ lineId: orig.lineId, quantity: 2 }] });
    expect(res.status).toBe(400);
  });

  it('S5 — an unfulfilled original has nothing returnable', async () => {
    const created = await owner()
      .post('/v1/orders')
      .send({ locationId, customerId, confirm: true, lines: [{ variantId: v1Id, quantity: 1 }] });
    expect(created.status).toBe(201);
    const res = await owner()
      .post(`/v1/orders/${created.body.id}/return`)
      .send({ fulfillment: 'pickup', lines: [{ lineId: created.body.lines[0].id, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('S6 — a cancelled original refuses an exchange order outright', async () => {
    const created = await owner()
      .post('/v1/orders')
      .send({ locationId, customerId, confirm: true, lines: [{ variantId: v1Id, quantity: 1 }] });
    expect(created.status).toBe(201);
    await owner().post(`/v1/orders/${created.body.id}/cancel`).send({}).expect(201);
    const res = await owner()
      .post(`/v1/orders/${created.body.id}/exchange`)
      .send({ locationId, confirm: true, lines: [{ variantId: v2Id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cancelled/);
  });

  it('S7 — the 1-cent fee override from the bug report binds and nets to the penny', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    const bound = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId, returnId, restockingFeeCents: 1 });
    expect(bound.status).toBe(201);
    expect(bound.body.restockingFeeCents).toBe(1);
    expect(bound.body.settlement.creditCents).toBe(49_999);
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    const detail = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(detail.body.settlement.salePaidCents).toBe(49_999);
    expect(detail.body.settlement.saleBalanceDueCents).toBe(10_001);
    expect(await ledgerBalance(customerId)).toBe(0);
  });

  it('S8 — a fee override above the return amount is refused', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    const res = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId, returnId, restockingFeeCents: 50_001 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/between 0 and the return amount/);
  });

  it('S9 — downgrade: the replacement costs less, the customer keeps the difference as store credit', async () => {
    const orig = await soldOriginal(v2Id, 60_000); // $600 original
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v1Id); // $500 replacement
    const bound = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(bound.status).toBe(201);
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    const detail = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(detail.body.settlement.salePaidCents).toBe(50_000);
    expect(detail.body.settlement.saleBalanceDueCents).toBe(0);
    expect(await ledgerBalance(customerId)).toBe(10_000);
    // Burn the residual so later ledger assertions stay clean.
    await withDb(async (db) => {
      await db.insert(schema.storeCreditEntries).values({
        businessId,
        customerId,
        deltaCents: -10_000,
        reason: 'stress-test cleanup',
      });
    });
  });

  it('S10 — multi-quantity original: a partial return credits only what came back and leaves the rest returnable', async () => {
    const created = await owner()
      .post('/v1/orders')
      .send({ locationId, customerId, confirm: true, lines: [{ variantId: v1Id, quantity: 2 }] });
    expect(created.status).toBe(201);
    await owner()
      .post(`/v1/orders/${created.body.id}/payments`)
      .send({ method: 'cash', amountCents: 100_000, kind: 'deposit' })
      .expect(201);
    await owner().post(`/v1/orders/${created.body.id}/fulfill`).send({}).expect(201);
    const lineId = created.body.lines[0].id as string;

    const { saleOrderId, returnId } = await (async () => {
      const replacement = await owner()
        .post(`/v1/orders/${created.body.id}/exchange`)
        .send({ locationId, confirm: true, lines: [{ variantId: v2Id, quantity: 1 }] });
      expect(replacement.status).toBe(201);
      await owner()
        .post(`/v1/orders/${created.body.id}/return`)
        .send({
          fulfillment: 'pickup',
          refundMethod: 'store_credit',
          lines: [{ lineId, quantity: 1 }],
        })
        .expect(201);
      const rets = await owner().get(
        `/v1/order-returns?orderId=${created.body.id}&status=authorized`,
      );
      return {
        saleOrderId: replacement.body.id as string,
        returnId: rets.body.data[0].id as string,
      };
    })();

    const bound = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(bound.status).toBe(201);
    expect(bound.body.settlement.returnCents).toBe(50_000); // one unit, not two
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    const detail = await owner().get(`/v1/orders/${created.body.id}`);
    expect(detail.body.lines[0].qtyReturned).toBe(1);
    // The second unit can still come back later.
    const again = await owner()
      .post(`/v1/orders/${created.body.id}/return`)
      .send({ fulfillment: 'pickup', lines: [{ lineId, quantity: 1 }] });
    expect(again.status).toBe(201);
  });

  it('S11 — goods not in hand: the bound exchange waits, then settles on receive', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    const bound = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(bound.status).toBe(201);
    // No receive yet — nothing has moved.
    const waiting = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(waiting.body.settlement.salePaidCents).toBe(0);
    expect(await ledgerBalance(customerId)).toBe(0);
    // The truck brings it back → settlement fires.
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    const settled = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(settled.body.settlement.salePaidCents).toBe(50_000);
    expect(await ledgerBalance(customerId)).toBe(0);
  });

  it('S12 — receiving the return twice cannot double the credit', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    await owner().post('/v1/exchanges').send({ saleOrderId, returnId }).expect(201);
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
    const second = await owner().post(`/v1/order-returns/${returnId}/receive`).send({});
    expect(second.status).toBeGreaterThanOrEqual(400);
    await withDb(async (db) => {
      const salePayments = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, saleOrderId));
      expect(salePayments).toHaveLength(1);
      expect(salePayments[0]!.amountCents).toBe(50_000);
    });
    expect(await ledgerBalance(customerId)).toBe(0);
  });
});

/**
 * Exchange money-and-goods routing: collecting the balance the customer
 * owes after the credit applies, receiving the returned goods at a
 * chosen location (warehouse vs. store), and pulling the replacement's
 * inventory from a chosen source location.
 */
describe('Exchange — pay the difference and route the goods', () => {
  it('collects the exact remaining balance on the replacement after settlement', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    const bound = await owner().post('/v1/exchanges').send({ saleOrderId, returnId });
    expect(bound.status).toBe(201);
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);

    // The page reads the settled balance and charges exactly that.
    const settled = await owner().get(`/v1/exchanges/${bound.body.id}`);
    const due = settled.body.settlement.saleBalanceDueCents as number;
    expect(due).toBe(10_000);
    await owner()
      .post(`/v1/orders/${saleOrderId}/payments`)
      .send({ method: 'card', amountCents: due, kind: 'balance' })
      .expect(201);

    const after = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(after.body.settlement.saleBalanceDueCents).toBe(0);
    expect(after.body.settlement.salePaidCents).toBe(60_000);
  });

  it('receives the returned goods at a chosen location — As-Is pieces land at the warehouse', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    await owner().post('/v1/exchanges').send({ saleOrderId, returnId }).expect(201);
    await owner()
      .post(`/v1/order-returns/${returnId}/receive`)
      .send({ locationId: warehouseId })
      .expect(201);
    await withDb(async (db) => {
      const pieces = await db
        .select()
        .from(schema.asIsItems)
        .where(
          and(
            eq(schema.asIsItems.referenceType, 'order'),
            eq(schema.asIsItems.referenceId, orig.orderId),
          ),
        );
      expect(pieces).toHaveLength(1);
      expect(pieces[0]!.locationId).toBe(warehouseId);
    });
  });

  it('a bogus receive location is refused and the return stays authorized', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const { saleOrderId, returnId } = await legsFor(orig.orderId, orig.lineId, v2Id);
    await owner().post('/v1/exchanges').send({ saleOrderId, returnId }).expect(201);
    const bad = await owner()
      .post(`/v1/order-returns/${returnId}/receive`)
      .send({ locationId: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/location/i);
    // Untouched: the correct receive still works.
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);
  });

  it('replacement lines can pull from the warehouse — reservation and consumption land there', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    const replacement = await owner()
      .post(`/v1/orders/${orig.orderId}/exchange`)
      .send({
        locationId,
        confirm: true,
        lines: [{ variantId: v2Id, quantity: 1, sourceLocationId: warehouseId }],
      });
    expect(replacement.status).toBe(201);
    expect(replacement.body.lines[0].sourceLocationId).toBe(warehouseId);
    await withDb(async (db) => {
      const [wh] = await db
        .select()
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, v2Id),
            eq(schema.inventoryLevels.locationId, warehouseId),
          ),
        );
      expect(wh!.reserved).toBe(1);
    });
  });

  it('drop-off returns route the goods too — returnToLocationId on the plain return', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    await owner()
      .post(`/v1/orders/${orig.orderId}/return`)
      .send({
        fulfillment: 'drop_off',
        refundMethod: 'store_credit',
        returnToLocationId: warehouseId,
        lines: [{ lineId: orig.lineId, quantity: 1 }],
      })
      .expect(201);
    await withDb(async (db) => {
      const pieces = await db
        .select()
        .from(schema.asIsItems)
        .where(
          and(
            eq(schema.asIsItems.referenceType, 'order'),
            eq(schema.asIsItems.referenceId, orig.orderId),
          ),
        );
      expect(pieces).toHaveLength(1);
      expect(pieces[0]!.locationId).toBe(warehouseId);
    });
    // Burn the plain-return store credit so later ledger checks stay clean.
    await withDb(async (db) => {
      await db.insert(schema.storeCreditEntries).values({
        businessId,
        customerId,
        deltaCents: -50_000,
        reason: 'routing-test cleanup',
      });
    });
  });
});

describe('Exchange — replacement priced on screen', () => {
  it('an edited unit price flows through to the replacement order and the balance due', async () => {
    const orig = await soldOriginal(v1Id, 50_000);
    // The writer edited the price up to $650 (list is $600) — what the
    // screen shows is what the order bills.
    const replacement = await owner()
      .post(`/v1/orders/${orig.orderId}/exchange`)
      .send({
        locationId,
        confirm: true,
        lines: [{ variantId: v2Id, quantity: 1, unitPriceCents: 65_000 }],
      });
    expect(replacement.status).toBe(201);
    expect(replacement.body.lines[0].unitPriceCents).toBe(65_000);
    expect(replacement.body.totalCents).toBe(65_000);

    await owner()
      .post(`/v1/orders/${orig.orderId}/return`)
      .send({
        fulfillment: 'pickup',
        refundMethod: 'store_credit',
        lines: [{ lineId: orig.lineId, quantity: 1 }],
      })
      .expect(201);
    const rets = await owner().get(`/v1/order-returns?orderId=${orig.orderId}&status=authorized`);
    const returnId = rets.body.data[0].id as string;
    const bound = await owner()
      .post('/v1/exchanges')
      .send({ saleOrderId: replacement.body.id, returnId });
    expect(bound.status).toBe(201);
    await owner().post(`/v1/order-returns/${returnId}/receive`).send({}).expect(201);

    // $500 credit against the $650 replacement → the customer owes $150.
    const settled = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(settled.body.settlement.saleBalanceDueCents).toBe(15_000);
    await owner()
      .post(`/v1/orders/${replacement.body.id}/payments`)
      .send({ method: 'card', amountCents: 15_000, kind: 'balance' })
      .expect(201);
    const after = await owner().get(`/v1/exchanges/${bound.body.id}`);
    expect(after.body.settlement.saleBalanceDueCents).toBe(0);
  });
});
