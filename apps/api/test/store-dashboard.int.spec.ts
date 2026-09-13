/**
 * Store cards + Changes card (owner hand-off 2026-09-10).
 *
 * - One card per selling store (never the warehouse), month-to-date by
 *   default or today: written / delivered / avg ticket / money received
 *   by live tender / cash awaiting pickup, the salespeople with the
 *   store manager badged (manager-dashboard toggle + store access), and
 *   one row per cash payment.
 * - Ticking a cash payment stamps the acting member's name and role;
 *   the owner then sees Operations' name on their own card. Only Owner
 *   and Operations may tick; a cashier is refused. Ticks are audited.
 * - The tender row's payment list carries order, payment date, sale
 *   date, salesperson, type and amount.
 * - The Changes card is derived from the audit log: discount, line
 *   added/removed, deposit collected, cancellation; money rows carry a
 *   per-member seen tick that never moves anyone else's.
 * - Legacy-imported documents never reach either card (D8).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.STORE_DASHBOARD_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_store_dashboard';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'StoreCards!2026x';
const TZ = 'America/Los_Angeles';

let app: INestApplication;
let businessId = '';
let aStoreId = '';
let bStoreId = '';
let variantId = '';
let customerId = '';
const cookies: Record<'owner' | 'ops' | 'manager' | 'rep', string> = {
  owner: '',
  ops: '',
  manager: '',
  rep: '',
};
const members: Record<
  'owner' | 'ops' | 'manager' | 'rep',
  { userId: string; membershipId: string }
> = {
  owner: { userId: '', membershipId: '' },
  ops: { userId: '', membershipId: '' },
  manager: { userId: '', membershipId: '' },
  rep: { userId: '', membershipId: '' },
};

const fx = {
  o1: '', // rep, today, $1,000: $300 cash deposit + $700 card balance
  o2: '', // manager, today, $2,000: $2,000 check
  o6: '', // rep, 40 days ago, $700, delivered today
  o7: '', // rep, today, $400, unpaid — cancelled through the API
  oB: '', // rep at B Store, today, $500 cash
  cashDepositPaymentId: '',
  saleCashPaymentId: '',
  cardPaymentId: '',
};

const localDay = (plusDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
    new Date(Date.now() + plusDays * 86_400_000),
  );

function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  return fn(db).finally(() => sql.end({ timeout: 5 }));
}

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
  await withDb(async (db) => {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({
        slug: 'store-cards-test',
        name: 'Store Cards Test Co',
        status: 'active',
        opsSettingsJson: { priceVariance: { tier1Pct: 7, tier1MaxCents: 7500, tier2Pct: 20 } },
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

    const locs = await db
      .insert(schema.locations)
      .values([
        { businessId, name: 'A Store', timezone: TZ },
        { businessId, name: 'B Store', timezone: TZ },
        { businessId, name: 'Main Warehouse', timezone: TZ, locationType: 'warehouse' },
      ])
      .returning();
    aStoreId = locs[0]!.id;
    bStoreId = locs[1]!.id;

    async function makeUser(
      key: keyof typeof members,
      name: string,
      role: string,
      over: Partial<typeof schema.memberships.$inferInsert> = {},
    ) {
      const [u] = await db
        .insert(schema.users)
        .values({ email: `${key}@store-cards.local`, emailVerified: true, name })
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
          roleId: roles.get(role)!,
          status: 'active',
          acceptedAt: new Date(),
          ...over,
        })
        .returning();
      members[key] = { userId: u!.id, membershipId: m!.id };
    }
    await makeUser('owner', 'Olive Owner', 'Owner');
    await makeUser('ops', 'Dana Whitmore', 'Operations');
    // Store manager of A Store: manager dashboard on + A Store access.
    await makeUser('manager', 'Maya Torres', 'Manager', {
      managerDashboard: true,
      sellingScope: 'approved',
    });
    await db.insert(schema.membershipLocationScopes).values({
      businessId,
      membershipId: members.manager.membershipId,
      locationId: aStoreId,
    });
    await makeUser('rep', 'Priya Nair', 'Cashier');

    const [p] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'SC-MAT', name: 'Store Card Mattress' })
      .returning();
    const [v] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p!.id,
        sku: 'SC-MAT-Q',
        name: 'Queen',
        priceCents: 100_000,
        costCents: 50_000,
      })
      .returning();
    variantId = v!.id;
    await db.insert(schema.inventoryLevels).values([
      { businessId, variantId, locationId: aStoreId, onHand: 50, reserved: 0 },
      { businessId, variantId, locationId: bStoreId, onHand: 50, reserved: 0 },
    ]);

    const [cust] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Noah', lastName: 'Feldman', phone: '3105550100' })
      .returning();
    customerId = cust!.id;

    let n = 0;
    const mkOrder = async (
      over: Partial<typeof schema.orders.$inferInsert>,
      lineOver: Partial<typeof schema.orderLines.$inferInsert> = {},
    ) => {
      const totalCents = over.totalCents ?? 100_000;
      const [order] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: aStoreId,
          number: `SO-SC-${String(++n).padStart(3, '0')}`,
          status: 'open',
          customerId,
          salespersonMembershipId: members.rep.membershipId,
          subtotalCents: totalCents,
          totalCents,
          ...over,
        })
        .returning();
      await db.insert(schema.orderLines).values({
        businessId,
        orderId: order!.id,
        variantId,
        description: 'Store Card Mattress — Queen',
        quantity: 1,
        unitPriceCents: totalCents,
        totalCents,
        lineType: 'stock',
        ...lineOver,
      });
      return order!;
    };
    const pay = async (over: Partial<typeof schema.payments.$inferInsert>) => {
      const [row] = await db
        .insert(schema.payments)
        .values({ businessId, method: 'card', status: 'succeeded', amountCents: 0, ...over })
        .returning();
      return row!;
    };

    const o1 = await mkOrder({});
    fx.o1 = o1.id;
    fx.cashDepositPaymentId = (
      await pay({ orderId: o1.id, kind: 'deposit', method: 'cash', amountCents: 30_000 })
    ).id;
    fx.cardPaymentId = (
      await pay({ orderId: o1.id, kind: 'balance', method: 'card', amountCents: 70_000 })
    ).id;
    // A $100 cash refund on O1, the way the return flow records it: a
    // negative payment row. Money out — never money received, never cash
    // awaiting pickup.
    await pay({ orderId: o1.id, kind: 'refund', method: 'cash', amountCents: -10_000 });

    const o2 = await mkOrder({
      salespersonMembershipId: members.manager.membershipId,
      totalCents: 200_000,
    });
    fx.o2 = o2.id;
    await pay({ orderId: o2.id, kind: 'deposit', method: 'check', amountCents: 200_000 });

    // Written 40 days ago (outside every window), delivered today.
    const o6 = await mkOrder({
      totalCents: 70_000,
      createdAt: new Date(Date.now() - 40 * 86_400_000),
    });
    fx.o6 = o6.id;
    await db.insert(schema.deliveries).values({
      businessId,
      locationId: aStoreId,
      orderId: o6.id,
      scheduledDate: localDay(0),
      status: 'delivered',
      completedAt: new Date(),
    });

    const o7 = await mkOrder({ totalCents: 40_000 });
    fx.o7 = o7.id;

    // Noise that must stay out: a draft, a cancelled order, an imported
    // order with a cash payment.
    await mkOrder({ status: 'draft', totalCents: 999_999 });
    await mkOrder({ status: 'cancelled', totalCents: 888_888 });
    const legacy = await mkOrder({ totalCents: 55_000, importedAt: new Date() });
    await pay({ orderId: legacy.id, kind: 'deposit', method: 'cash', amountCents: 55_000 });

    // B Store: one cash order by the rep.
    const oB = await mkOrder({ locationId: bStoreId, totalCents: 50_000 });
    fx.oB = oB.id;
    await pay({ orderId: oB.id, kind: 'deposit', method: 'cash', amountCents: 50_000 });

    // A $200 cash register sale at A Store by the rep.
    const [sale] = await db
      .insert(schema.sales)
      .values({
        businessId,
        locationId: aStoreId,
        number: 'S-SC-001',
        status: 'completed',
        customerId,
        associateUserId: members.rep.userId,
        subtotalCents: 20_000,
        totalCents: 20_000,
        completedAt: new Date(),
      })
      .returning();
    fx.saleCashPaymentId = (
      await pay({ saleId: sale!.id, method: 'cash', amountCents: 20_000 })
    ).id;
  });
}

async function captureCookie(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .send({ email, password: PASSWORD })
    .expect(200);
  const found = (res.get('Set-Cookie') ?? [])
    .map((c) => c.split(';')[0])
    .filter((c): c is string => Boolean(c?.startsWith('jetnine.session_token=')))
    .find((c) => !c.endsWith('='));
  if (!found) throw new Error(`no session cookie for ${email}`);
  return found;
}

type Who = keyof typeof cookies;
const as = (who: Who) => ({
  get: (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Cookie', cookies[who])
      .set('x-business-id', businessId),
  put: (path: string) =>
    request(app.getHttpServer())
      .put(path)
      .set('Cookie', cookies[who])
      .set('x-business-id', businessId),
  post: (path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Cookie', cookies[who])
      .set('x-business-id', businessId),
  patch: (path: string) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Cookie', cookies[who])
      .set('x-business-id', businessId),
  delete: (path: string) =>
    request(app.getHttpServer())
      .delete(path)
      .set('Cookie', cookies[who])
      .set('x-business-id', businessId),
});

interface Card {
  locationId: string;
  name: string;
  manager: { membershipId: string; name: string } | null;
  sellingCount: number;
  writtenCents: number;
  writtenCount: number;
  deliveredCents: number;
  deliveredCount: number;
  avgTicketCents: number;
  receivedCents: number;
  receivedCount: number;
  cashTotalCents: number;
  cashPendingCents: number;
  cashPaymentCount: number;
  cashReceivedCount: number;
  salespeople: {
    membershipId: string;
    name: string;
    isManager: boolean;
    writtenCents: number;
    deliveredCents: number;
    orders: number;
    collectedCents: number;
    lastWriteUpAt: string | null;
  }[];
  tenders: { method: string; cents: number; count: number }[];
  cashPayments: {
    paymentId: string;
    docNumber: string;
    kind: string;
    amountCents: number;
    customerName: string | null;
    receipt: { byName: string; byRole: string | null; receivedAt: string } | null;
  }[];
}

async function aStoreCard(who: Who = 'owner', qs = ''): Promise<Card> {
  const res = await as(who).get(`/v1/dashboard/stores${qs}`).expect(200);
  const card = (res.body.stores as Card[]).find((s) => s.locationId === aStoreId);
  if (!card) throw new Error('A Store card missing');
  return card;
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'store-cards-secret-store-cards-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();

  for (const who of ['owner', 'ops', 'manager', 'rep'] as const) {
    cookies[who] = await captureCookie(`${who}@store-cards.local`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('the pickup permission', () => {
  it('sits with Owner and Operations, not the Manager or Cashier', () => {
    const has = (name: string) =>
      SYSTEM_ROLES.find((r) => r.name === name)!.permissions.includes('pos.cash.pickup_confirm');
    expect(has('Owner')).toBe(true);
    expect(has('Operations')).toBe(true);
    expect(has('Manager')).toBe(false);
    expect(has('Cashier')).toBe(false);
  });
});

describe('GET /v1/dashboard/stores', () => {
  it('lists the selling stores month-to-date with the numbers the card shows', async () => {
    const res = await as('owner').get('/v1/dashboard/stores').expect(200);
    expect(res.body.period).toBe('mtd');
    expect(res.body.range.end).toBe(localDay(0));
    expect(res.body.range.start).toBe(`${localDay(0).slice(0, 7)}-01`);
    expect(res.body.viewer.canConfirmCashPickup).toBe(true);
    const names = (res.body.stores as Card[]).map((s) => s.name);
    expect(names).toEqual(['A Store', 'B Store']);

    const a = (res.body.stores as Card[]).find((s) => s.name === 'A Store')!;
    // Written: O1 $1,000 + O2 $2,000 + O7 $400 (not the draft, cancelled,
    // imported or 40-day-old orders).
    expect(a.writtenCents).toBe(340_000);
    expect(a.writtenCount).toBe(3);
    expect(a.avgTicketCents).toBe(Math.round(340_000 / 3));
    // Delivered: O6 reached delivered today at its $700 total.
    expect(a.deliveredCents).toBe(70_000);
    expect(a.deliveredCount).toBe(1);
    // Money received: $300 cash + $700 card + $2,000 check + $200 register cash.
    expect(a.receivedCents).toBe(320_000);
    expect(a.receivedCount).toBe(4);
    const tender = (m: string) => a.tenders.find((t) => t.method === m)!;
    expect(a.tenders.map((t) => t.method)).toEqual([
      'cash',
      'card',
      'external_card',
      'check',
      'financing',
      'gift_card',
      'store_credit',
    ]);
    expect(tender('cash')).toMatchObject({ cents: 50_000, count: 2 });
    expect(tender('card')).toMatchObject({ cents: 70_000, count: 1 });
    expect(tender('check')).toMatchObject({ cents: 200_000, count: 1 });
    expect(tender('financing')).toMatchObject({ cents: 0, count: 0 });
    // The refund shows only as money out.
    expect(a.refundsCents).toBe(10_000);
    // Cash awaiting pickup: both cash payments, nothing ticked yet.
    expect(a.cashTotalCents).toBe(50_000);
    expect(a.cashPendingCents).toBe(50_000);
    expect(a.cashPaymentCount).toBe(2);
    expect(a.cashReceivedCount).toBe(0);
    expect(a.cashPayments.map((p) => p.docNumber)).toEqual(['SO-SC-001', 'S-SC-001']);
    expect(a.cashPayments[0]).toMatchObject({ kind: 'deposit', customerName: 'Noah Feldman' });
    expect(a.cashPayments[1]).toMatchObject({ kind: 'paid in full', amountCents: 20_000 });

    // Footer totals across both cards.
    expect(res.body.totals).toMatchObject({
      storeCount: 2,
      writtenCents: 390_000,
      writtenCount: 4,
      receivedCents: 370_000,
      cashPendingCents: 100_000,
    });
  });

  it('badges the store manager and lists each salesperson once', async () => {
    const a = await aStoreCard();
    expect(a.manager).toMatchObject({
      membershipId: members.manager.membershipId,
      name: 'Maya Torres',
    });
    expect(a.sellingCount).toBe(2);
    const rep = a.salespeople.find((s) => s.membershipId === members.rep.membershipId)!;
    const mgr = a.salespeople.find((s) => s.membershipId === members.manager.membershipId)!;
    expect(rep).toMatchObject({
      name: 'Priya Nair',
      isManager: false,
      writtenCents: 140_000,
      orders: 2,
      deliveredCents: 70_000,
      collectedCents: 100_000,
    });
    expect(rep.lastWriteUpAt).not.toBeNull();
    expect(mgr).toMatchObject({
      name: 'Maya Torres',
      isManager: true,
      writtenCents: 200_000,
      orders: 1,
      collectedCents: 200_000,
    });
    // B Store has no manager flagged.
    const res = await as('owner').get('/v1/dashboard/stores').expect(200);
    const b = (res.body.stores as Card[]).find((s) => s.name === 'B Store')!;
    expect(b.manager).toBeNull();
    expect(b.cashPendingCents).toBe(50_000);
  });

  it('narrows to today and to a requested store', async () => {
    const today = await as('owner').get('/v1/dashboard/stores?period=today').expect(200);
    expect(today.body.period).toBe('today');
    expect(today.body.range).toEqual({ start: localDay(0), end: localDay(0) });
    const a = (today.body.stores as Card[]).find((s) => s.name === 'A Store')!;
    expect(a.writtenCents).toBe(340_000);
    expect(a.deliveredCents).toBe(70_000);

    const one = await as('owner').get(`/v1/dashboard/stores?locationId=${aStoreId}`).expect(200);
    expect((one.body.stores as Card[]).map((s) => s.name)).toEqual(['A Store']);
    expect(one.body.totals.storeCount).toBe(1);

    const csv = await as('owner')
      .get(`/v1/dashboard/stores?locationIds=${bStoreId},${aStoreId}`)
      .expect(200);
    expect((csv.body.stores as Card[]).map((s) => s.name)).toEqual(['A Store', 'B Store']);
  });

  it('tells a cashier they cannot tick', async () => {
    const res = await as('rep').get('/v1/dashboard/stores').expect(200);
    expect(res.body.viewer.canConfirmCashPickup).toBe(false);
    const ops = await as('ops').get('/v1/dashboard/stores').expect(200);
    expect(ops.body.viewer.canConfirmCashPickup).toBe(true);
  });
});

describe('GET /v1/dashboard/stores/:id/payments', () => {
  it('lists every payment of one tender at the store', async () => {
    const res = await as('owner')
      .get(`/v1/dashboard/stores/${aStoreId}/payments?method=cash`)
      .expect(200);
    expect(res.body.location.name).toBe('A Store');
    expect(res.body.count).toBe(2);
    expect(res.body.totalCents).toBe(50_000);
    const order = res.body.rows.find((r: { docNumber: string }) => r.docNumber === 'SO-SC-001');
    expect(order).toMatchObject({
      docKind: 'order',
      kind: 'deposit',
      amountCents: 30_000,
      salespersonName: 'Priya Nair',
      customerName: 'Noah Feldman',
      receipt: null,
    });
    expect(order.paidAt).toBeTruthy();
    expect(order.soldAt).toBeTruthy();
    const sale = res.body.rows.find((r: { docNumber: string }) => r.docNumber === 'S-SC-001');
    expect(sale).toMatchObject({
      docKind: 'sale',
      kind: 'paid in full',
      salespersonName: 'Priya Nair',
    });

    const card = await as('owner')
      .get(`/v1/dashboard/stores/${aStoreId}/payments?method=card`)
      .expect(200);
    expect(card.body.count).toBe(1);
    expect(card.body.rows[0].kind).toBe('balance on delivery');
  });

  it('needs a method and a real store', async () => {
    await as('owner').get(`/v1/dashboard/stores/${aStoreId}/payments`).expect(400);
    await as('owner')
      .get('/v1/dashboard/stores/00000000-0000-4000-8000-000000000000/payments?method=cash')
      .expect(404);
  });
});

describe('cash pickup ticks', () => {
  it('stamp the acting member, which the owner then sees on their card', async () => {
    const tick = await as('ops')
      .put(`/v1/dashboard/cash-pickups/${fx.cashDepositPaymentId}`)
      .expect(200);
    expect(tick.body.receipt).toMatchObject({ byName: 'Dana Whitmore', byRole: 'Operations' });
    expect(tick.body.receipt.receivedAt).toBeTruthy();

    const a = await aStoreCard('owner');
    expect(a.cashPendingCents).toBe(20_000);
    expect(a.cashReceivedCount).toBe(1);
    const row = a.cashPayments.find((p) => p.paymentId === fx.cashDepositPaymentId)!;
    expect(row.receipt).toMatchObject({ byName: 'Dana Whitmore', byRole: 'Operations' });

    // Ticking again is idempotent — the original stamp stands.
    const again = await as('owner')
      .put(`/v1/dashboard/cash-pickups/${fx.cashDepositPaymentId}`)
      .expect(200);
    expect(again.body.receipt.byName).toBe('Dana Whitmore');

    const audits = await withDb((db) =>
      db
        .select({ action: schema.auditLogs.action, targetId: schema.auditLogs.targetId })
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'cash_pickup.confirm')),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.targetId).toBe(fx.cashDepositPaymentId);
  });

  it('are undoable', async () => {
    const res = await as('ops')
      .delete(`/v1/dashboard/cash-pickups/${fx.cashDepositPaymentId}`)
      .expect(200);
    expect(res.body.receipt).toBeNull();
    const a = await aStoreCard('owner');
    expect(a.cashPendingCents).toBe(50_000);
    expect(a.cashReceivedCount).toBe(0);
  });

  it('are refused to a cashier and to a manager', async () => {
    await as('rep').put(`/v1/dashboard/cash-pickups/${fx.cashDepositPaymentId}`).expect(403);
    await as('manager').put(`/v1/dashboard/cash-pickups/${fx.cashDepositPaymentId}`).expect(403);
  });

  it('only apply to cash', async () => {
    await as('owner').put(`/v1/dashboard/cash-pickups/${fx.cardPaymentId}`).expect(400);
    await as('owner')
      .put('/v1/dashboard/cash-pickups/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('mark or clear a whole card at once', async () => {
    const ids = [fx.cashDepositPaymentId, fx.saleCashPaymentId];
    const marked = await as('owner')
      .post('/v1/dashboard/cash-pickups/bulk')
      .send({ paymentIds: ids, received: true })
      .expect(201);
    expect(marked.body.updated).toBe(2);
    let a = await aStoreCard('owner');
    expect(a.cashPendingCents).toBe(0);
    expect(a.cashReceivedCount).toBe(2);
    expect(a.cashPayments.every((p) => p.receipt?.byName === 'Olive Owner')).toBe(true);

    await as('owner')
      .post('/v1/dashboard/cash-pickups/bulk')
      .send({ paymentIds: ids, received: false })
      .expect(201);
    a = await aStoreCard('owner');
    expect(a.cashPendingCents).toBe(50_000);
    await as('owner')
      .post('/v1/dashboard/cash-pickups/bulk')
      .send({ paymentIds: [], received: true })
      .expect(400);
  });
});

describe('GET /v1/dashboard/changes', () => {
  interface Row {
    id: string;
    type: string;
    label: string;
    tone: string;
    moneyRelated: boolean;
    was: string | null;
    now: string | null;
    reason: string | null;
    impactCents: number | null;
    orderNumber: string;
    locationName: string;
    authorName: string;
    approval: string;
    seenAt: string | null;
  }
  let rows: Row[] = [];

  it('reads the order edits back out of the audit log', async () => {
    // Drive real changes through the order endpoints as the owner.
    await as('owner').patch(`/v1/orders/${fx.o1}`).send({ orderDiscountCents: 5_000 }).expect(200);
    const added = await as('owner')
      .post(`/v1/orders/${fx.o1}/lines`)
      .send({ variantId, quantity: 1 })
      .expect(201);
    const lineId = (added.body.lines as { id: string; variantId: string }[]).find(
      (l) => l.variantId === variantId && l.id !== undefined,
    )!.id;
    await as('owner').patch(`/v1/orders/${fx.o1}`).send({ notes: 'gate code 4411' }).expect(200);
    // O6 still owes its $700, so a $100 deposit lands as a real payment.
    await as('owner')
      .post(`/v1/orders/${fx.o6}/payments`)
      .send({ method: 'check', amountCents: 10_000, kind: 'deposit' })
      .expect(201);
    await as('owner').delete(`/v1/orders/${fx.o1}/lines/${lineId}`).expect(200);
    await as('owner')
      .post(`/v1/orders/${fx.o7}/cancel`)
      .send({ reason: 'customer changed mind' })
      .expect(201);

    const res = await as('owner').get('/v1/dashboard/changes').expect(200);
    rows = res.body.rows as Row[];
    const byType = (t: string) => rows.filter((r) => r.type === t);

    const discount = byType('discount_added')[0]!;
    expect(discount).toMatchObject({
      label: 'Discount added',
      tone: 'warn',
      moneyRelated: true,
      now: '$50 order discount',
      orderNumber: 'SO-SC-001',
      locationName: 'A Store',
      authorName: 'Olive Owner',
      approval: 'no approval needed',
      seenAt: null,
    });

    const lineAdded = byType('line_added')[0]!;
    expect(lineAdded).toMatchObject({ tone: 'info', moneyRelated: true });
    expect(lineAdded.now).toContain('Store Card Mattress — Queen ×1 added');

    const lineRemoved = byType('line_removed')[0]!;
    expect(lineRemoved).toMatchObject({
      tone: 'warn',
      moneyRelated: true,
      was: 'Store Card Mattress — Queen ×1',
      now: 'removed from the order',
      impactCents: null,
    });

    const deposit = byType('deposit_collected')[0]!;
    expect(deposit).toMatchObject({
      label: 'Deposit collected',
      tone: 'ok',
      moneyRelated: true,
      now: '$100 check deposit',
      impactCents: 10_000,
      orderNumber: 'SO-SC-003',
    });

    const cancelled = byType('order_cancelled')[0]!;
    expect(cancelled).toMatchObject({
      tone: 'danger',
      moneyRelated: true,
      was: 'open',
      now: 'cancelled',
      reason: 'customer changed mind',
      orderNumber: 'SO-SC-004',
    });

    const edited = byType('order_edited')[0]!;
    expect(edited).toMatchObject({ moneyRelated: false, impactCents: null });

    // Newest first.
    expect(rows[0]!.type).toBe('order_cancelled');
    expect(res.body.counts.all).toBe(rows.length);
    expect(res.body.counts.money).toBe(rows.filter((r) => r.moneyRelated).length);
    expect(res.body.counts.unseen).toBe(res.body.counts.money);
  });

  it('filters to money and to unseen, and by store', async () => {
    const money = await as('owner').get('/v1/dashboard/changes?filter=money').expect(200);
    expect((money.body.rows as Row[]).every((r) => r.moneyRelated)).toBe(true);
    expect((money.body.rows as Row[]).some((r) => r.type === 'order_edited')).toBe(false);

    const bOnly = await as('owner')
      .get(`/v1/dashboard/changes?locationIds=${bStoreId}`)
      .expect(200);
    expect(bOnly.body.rows).toEqual([]);
    const aOnly = await as('owner')
      .get(`/v1/dashboard/changes?locationIds=${aStoreId}`)
      .expect(200);
    expect(aOnly.body.counts.all).toBe(rows.length);
  });

  it('keeps each member’s seen ticks their own', async () => {
    const target = rows.find((r) => r.type === 'discount_added')!;
    const seen = await as('owner').put(`/v1/dashboard/changes/${target.id}/seen`).expect(200);
    expect(seen.body.seenAt).toBeTruthy();

    const mine = await as('owner').get('/v1/dashboard/changes?filter=unseen').expect(200);
    expect((mine.body.rows as Row[]).some((r) => r.id === target.id)).toBe(false);
    const all = await as('owner').get('/v1/dashboard/changes').expect(200);
    expect((all.body.rows as Row[]).find((r) => r.id === target.id)!.seenAt).toBeTruthy();

    // Operations has their own ticks — the owner's does not move theirs.
    const theirs = await as('ops').get('/v1/dashboard/changes?filter=unseen').expect(200);
    expect((theirs.body.rows as Row[]).some((r) => r.id === target.id)).toBe(true);

    await as('owner').delete(`/v1/dashboard/changes/${target.id}/seen`).expect(200);
    const back = await as('owner').get('/v1/dashboard/changes?filter=unseen').expect(200);
    expect((back.body.rows as Row[]).some((r) => r.id === target.id)).toBe(true);
  });

  it('marks everything seen at once', async () => {
    const ids = rows.filter((r) => r.moneyRelated).map((r) => r.id);
    const res = await as('owner').post('/v1/dashboard/changes/seen-all').send({ ids }).expect(201);
    expect(res.body.updated).toBe(ids.length);
    const after = await as('owner').get('/v1/dashboard/changes').expect(200);
    expect(after.body.counts.unseen).toBe(0);
    await as('owner').post('/v1/dashboard/changes/seen-all').send({ ids: [] }).expect(400);
  });

  it('refuses a role without audit access', async () => {
    await as('rep').get('/v1/dashboard/changes').expect(403);
  });
});

describe('GET /v1/dashboard/cash-pickups/queue', () => {
  it('lists each store’s pending cash for the owner', async () => {
    // 2026-09-12: this 500ed in production for every owner load — the
    // 60-day floor went to postgres-js as a raw Date, which the driver
    // refuses (ERR_INVALID_ARG_TYPE). Nothing here exercised the queue.
    const res = await as('owner').get('/v1/dashboard/cash-pickups/queue').expect(200);
    expect(res.body.viewer.canRecord).toBe(true);
    expect(res.body.rule).toEqual({ dueCents: 150_000, dueDays: 3 });
    const stores = res.body.stores as {
      locationId: string;
      status: string;
      pendingCents: number;
      payments: { paymentId: string; amountCents: number }[];
    }[];
    expect(stores.length).toBeGreaterThan(0);
    const pending = stores.flatMap((s) => s.payments);
    const deposit = pending.find((p) => p.paymentId === fx.cashDepositPaymentId);
    expect(deposit).toBeTruthy();
    expect(deposit!.amountCents).toBeGreaterThan(0);
    expect(stores.find((s) => s.payments.includes(deposit!))?.pendingCents).toBeGreaterThanOrEqual(
      deposit!.amountCents,
    );
  });

  it('narrows to the stores asked for', async () => {
    const all = await as('owner').get('/v1/dashboard/cash-pickups/queue').expect(200);
    const first = (all.body.stores as { locationId: string }[])[0]!.locationId;
    const one = await as('owner')
      .get(`/v1/dashboard/cash-pickups/queue?locationIds=${first}`)
      .expect(200);
    expect((one.body.stores as { locationId: string }[]).map((s) => s.locationId)).toEqual([first]);
  });
});
