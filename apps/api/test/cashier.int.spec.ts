/**
 * Cashier "My Day" dashboard acceptance (owner 2026-09-01, §12.3) and
 * the ZIP → city/state lookup that customer entry autofills from.
 *
 * - The Cashier role carries `cashier.dashboard.view`; /members/me
 *   reports `cashierDashboard` so /dashboard swaps to My Day; a role
 *   without the permission is refused.
 * - Every card is proven from real rows: today's written/collected
 *   against the same weekday last week, my open drawer with the close
 *   ritual's cash math, quotes to call back, my customers' deliveries,
 *   balances computed from the ledger, pickups waiting at the store,
 *   commission by status with the last payout, live promo codes plus the
 *   discount tiers, my unfinished returns/exchanges, and the store
 *   scoreboard with my weekly rank.
 * - "Mine" never leaks: another seller's quote, delivery, and balance
 *   stay out of my cards while still counting toward the store.
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
  process.env.CASHIER_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_cashier';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'MyDayPass!2026x';
const TZ = 'America/Los_Angeles';

let app: INestApplication;
let businessId = '';
let storeLocId = '';
let otherStoreLocId = '';
let customerId = '';
let variantId = '';
let cashierUserId = '';
let cashierMembershipId = '';
let rivalUserId = '';
let rivalMembershipId = '';
let cashierCookie = '';
let warehouseCookie = '';

const fx = {
  depositOrderId: '',
  paidOrderId: '',
  lastWeekOrderId: '',
  quoteOrderId: '',
  rivalDraftId: '',
  rivalOrderId: '',
  todayDeliveryId: '',
  pickupReadyId: '',
  pickupMineId: '',
  returnId: '',
  exchangeId: '',
  shiftId: '',
};

const localDay = (plusDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
    new Date(Date.now() + plusDays * 86_400_000),
  );
const currentPeriod = () => localDay(0).slice(0, 7);
const previousPeriod = () => {
  const [y, m] = localDay(0).split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

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
        slug: 'myday-test',
        name: 'My Day Test Co',
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
    async function makeUser(
      email: string,
      role: string,
    ): Promise<{ userId: string; membershipId: string }> {
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
      const [m] = await db
        .insert(schema.memberships)
        .values({
          businessId,
          userId: u!.id,
          roleId: roles.get(role)!,
          status: 'active',
          acceptedAt: new Date(),
        })
        .returning();
      return { userId: u!.id, membershipId: m!.id };
    }
    const cashier = await makeUser('cashier@myday-test.local', 'Cashier');
    cashierUserId = cashier.userId;
    cashierMembershipId = cashier.membershipId;
    const rival = await makeUser('rival@myday-test.local', 'Cashier');
    rivalUserId = rival.userId;
    rivalMembershipId = rival.membershipId;
    await makeUser('wh@myday-test.local', 'Warehouse');

    const locs = await db
      .insert(schema.locations)
      .values([
        { businessId, name: 'A Store', timezone: TZ },
        { businessId, name: 'B Store', timezone: TZ },
        { businessId, name: 'Main Warehouse', timezone: TZ, locationType: 'warehouse' },
      ])
      .returning();
    storeLocId = locs[0]!.id;
    otherStoreLocId = locs[1]!.id;

    const [p] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'MD-MAT', name: 'My Day Mattress' })
      .returning();
    const [v] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p!.id,
        sku: 'MD-MAT-Q',
        priceCents: 100_000,
        costCents: 50_000,
      })
      .returning();
    variantId = v!.id;

    const [cust] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Dana', lastName: 'Register', phone: '3105550100' })
      .returning();
    customerId = cust!.id;
  });
}

async function seedSignals() {
  await withDb(async (db) => {
    let n = 0;
    const mkOrder = async (
      over: Partial<typeof schema.orders.$inferInsert>,
      line?: Partial<typeof schema.orderLines.$inferInsert>,
    ) => {
      const [order] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: storeLocId,
          number: `SO-MD-${String(++n).padStart(3, '0')}`,
          status: 'open',
          customerId,
          salespersonMembershipId: cashierMembershipId,
          subtotalCents: 100_000,
          totalCents: 100_000,
          ...over,
        })
        .returning();
      await db.insert(schema.orderLines).values({
        businessId,
        orderId: order!.id,
        variantId,
        description: 'My Day Mattress',
        quantity: 1,
        unitPriceCents: order!.totalCents,
        totalCents: order!.totalCents,
        lineType: 'stock',
        ...line,
      });
      return order!;
    };
    const pay = (over: Partial<typeof schema.payments.$inferInsert>) =>
      db.insert(schema.payments).values({
        businessId,
        method: 'card',
        status: 'succeeded',
        amountCents: 0,
        ...over,
      });

    // Card 1/5: today's order, $1,000, $300 card deposit → $700 balance,
    // delivery requested today → due now.
    const deposit = await mkOrder({ requestedDate: localDay(0), fulfillmentType: 'delivery' });
    fx.depositOrderId = deposit.id;
    await pay({ orderId: deposit.id, kind: 'deposit', amountCents: 30_000 });

    // Paid in full — never a balance row.
    const paid = await mkOrder({ totalCents: 10_000, subtotalCents: 10_000 });
    fx.paidOrderId = paid.id;
    await pay({ orderId: paid.id, kind: 'deposit', amountCents: 10_000 });

    // Same weekday last week: $500 (the comparison baseline).
    const lastWeek = await mkOrder({
      totalCents: 50_000,
      subtotalCents: 50_000,
      createdAt: new Date(Date.now() - 7 * 86_400_000),
    });
    fx.lastWeekOrderId = lastWeek.id;

    // Card 3: my 5-day-old quote; the rival's draft must not show.
    const quote = await mkOrder({
      status: 'quote',
      totalCents: 80_000,
      subtotalCents: 80_000,
      createdAt: new Date(Date.now() - 5 * 86_400_000),
    });
    fx.quoteOrderId = quote.id;
    const rivalDraft = await mkOrder({
      status: 'draft',
      salespersonMembershipId: rivalMembershipId,
    });
    fx.rivalDraftId = rivalDraft.id;

    // Rival's big ticket today: in the store total and ahead of me this
    // week, but not in my numbers. Half paid → a balance that is not mine.
    const rivalOrder = await mkOrder({
      salespersonMembershipId: rivalMembershipId,
      totalCents: 999_900,
      subtotalCents: 999_900,
      requestedDate: localDay(1),
    });
    fx.rivalOrderId = rivalOrder.id;
    await pay({ orderId: rivalOrder.id, kind: 'deposit', amountCents: 100_000 });

    // Card 1/2: a $200 cash register sale by me, completed after my shift opened.
    const shiftOpenedAt = new Date(Date.now() - 3_600_000);
    const [sale] = await db
      .insert(schema.sales)
      .values({
        businessId,
        locationId: storeLocId,
        number: 'S-MD-001',
        status: 'completed',
        customerId,
        associateUserId: cashierUserId,
        subtotalCents: 20_000,
        totalCents: 20_000,
        completedAt: new Date(),
      })
      .returning();
    await pay({ saleId: sale!.id, method: 'cash', amountCents: 20_000 });

    // Card 2: my open shift with a $150 float at A Store.
    const [shift] = await db
      .insert(schema.cashShifts)
      .values({
        businessId,
        locationId: storeLocId,
        openedByUserId: cashierUserId,
        openedAt: shiftOpenedAt,
        openingFloatCents: 15_000,
      })
      .returning();
    fx.shiftId = shift!.id;
    // Yesterday's close at the store, $5 short.
    await db.insert(schema.cashShifts).values({
      businessId,
      locationId: storeLocId,
      openedByUserId: rivalUserId,
      openedAt: new Date(Date.now() - 30 * 3_600_000),
      closedAt: new Date(Date.now() - 20 * 3_600_000),
      openingFloatCents: 15_000,
      expectedCashCents: 15_000,
      countedCashCents: 14_500,
      varianceCents: -500,
    });

    // Card 4: my customer's delivery today 9–12; the rival's tomorrow.
    const [todayDelivery] = await db
      .insert(schema.deliveries)
      .values({
        businessId,
        locationId: storeLocId,
        orderId: deposit.id,
        scheduledDate: localDay(0),
        windowStart: '09:00',
        windowEnd: '12:00',
        status: 'scheduled',
      })
      .returning();
    fx.todayDeliveryId = todayDelivery!.id;
    await db.insert(schema.deliveries).values({
      businessId,
      locationId: storeLocId,
      orderId: rivalOrder.id,
      scheduledDate: localDay(1),
      status: 'scheduled',
    });

    // Card 6: pickups at A Store — the rival's, fully reserved (ready);
    // mine, unreserved (not ready); one at B Store that must not show.
    const pickupReady = await mkOrder(
      {
        fulfillmentType: 'pickup',
        salespersonMembershipId: rivalMembershipId,
        totalCents: 40_000,
        subtotalCents: 40_000,
      },
      { qtyReserved: 1 },
    );
    await pay({ orderId: pickupReady.id, amountCents: 40_000 });
    fx.pickupReadyId = pickupReady.id;
    const pickupMine = await mkOrder(
      {
        fulfillmentType: 'pickup',
        totalCents: 30_000,
        subtotalCents: 30_000,
        createdAt: new Date(Date.now() - 9 * 86_400_000),
      },
      { qtyReserved: 0 },
    );
    await pay({ orderId: pickupMine.id, amountCents: 30_000 });
    fx.pickupMineId = pickupMine.id;
    const elsewhere = await mkOrder({ fulfillmentType: 'pickup', locationId: otherStoreLocId });
    await pay({ orderId: elsewhere.id, amountCents: 100_000 });

    // Card 7: this period $15 + $25 pending, $10 approved; last month $90 paid.
    const entry = (over: Partial<typeof schema.commissionEntries.$inferInsert>) => ({
      businessId,
      membershipId: cashierMembershipId,
      basisCents: 100_000,
      rateBps: 500,
      amountCents: 0,
      period: currentPeriod(),
      ...over,
    });
    await db
      .insert(schema.commissionEntries)
      .values([
        entry({ amountCents: 1_500, status: 'pending', orderId: deposit.id }),
        entry({ amountCents: 2_500, status: 'pending', orderId: paid.id }),
        entry({ amountCents: 1_000, status: 'approved', orderId: lastWeek.id }),
        entry({ amountCents: 9_000, status: 'paid', period: previousPeriod() }),
        entry({ amountCents: 4_000, status: 'paid', period: '2025-12' }),
        entry({ amountCents: 7_700, status: 'pending', membershipId: rivalMembershipId }),
      ]);

    // Card 8: a live code, an expired one, an exhausted one.
    await db.insert(schema.discountCodes).values([
      {
        businessId,
        code: 'FALL10',
        kind: 'percent',
        value: 10,
        description: 'Fall event',
        minSubtotalCents: 50_000,
        usageLimit: 100,
        usageCount: 40,
      },
      {
        businessId,
        code: 'GONE',
        kind: 'fixed',
        value: 5_000,
        endsAt: new Date(Date.now() - 86_400_000),
      },
      { businessId, code: 'USEDUP', kind: 'fixed', value: 5_000, usageLimit: 3, usageCount: 3 },
    ]);

    // Card 9: my authorized return, my open exchange, my completed return
    // (done — not shown), the rival's return (not mine).
    const [ret] = await db
      .insert(schema.orderReturns)
      .values({
        businessId,
        orderId: paid.id,
        customerId,
        rmaNumber: 'RMA-MD-001',
        status: 'authorized',
        amountCents: 10_000,
        createdByUserId: cashierUserId,
      })
      .returning();
    fx.returnId = ret!.id;
    await db.insert(schema.orderReturns).values([
      {
        businessId,
        orderId: paid.id,
        customerId,
        rmaNumber: 'RMA-MD-002',
        status: 'completed',
        amountCents: 1_000,
        createdByUserId: cashierUserId,
      },
      {
        businessId,
        orderId: rivalOrder.id,
        customerId,
        rmaNumber: 'RMA-MD-003',
        status: 'authorized',
        amountCents: 1_000,
        createdByUserId: rivalUserId,
      },
    ]);
    const [xch] = await db
      .insert(schema.exchanges)
      .values({
        businessId,
        number: 'EX-MD-001',
        returnId: ret!.id,
        saleOrderId: lastWeek.id,
        originalOrderId: paid.id,
        status: 'open',
        createdByUserId: cashierUserId,
      })
      .returning();
    fx.exchangeId = xch!.id;
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

function asCashier(path: string) {
  return request(app.getHttpServer())
    .get(path)
    .set('Cookie', cashierCookie)
    .set('x-business-id', businessId);
}

beforeAll(async () => {
  await resetTestDb();
  await seed();
  await seedSignals();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'myday-test-secret-myday-test-secret-xx';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();

  cashierCookie = await captureCookie('cashier@myday-test.local');
  warehouseCookie = await captureCookie('wh@myday-test.local');
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('the Cashier role', () => {
  it('holds the dashboard permission in the catalog', () => {
    const cashier = SYSTEM_ROLES.find((r) => r.name === 'Cashier')!;
    expect(cashier.permissions).toContain('cashier.dashboard.view');
    const wh = SYSTEM_ROLES.find((r) => r.name === 'Warehouse')!;
    expect(wh.permissions).not.toContain('cashier.dashboard.view');
  });

  it('reports itself so /dashboard swaps to My Day', async () => {
    const me = await asCashier('/v1/business/members/me').expect(200);
    expect(me.body.cashierDashboard).toBe(true);
    expect(me.body.warehouseDashboard).toBe(false);
    // The product screens read this to say "hidden" (no cost access)
    // rather than "—" (no cost on file).
    expect(me.body.canSeeCost).toBe(false);
    const wh = await request(app.getHttpServer())
      .get('/v1/business/members/me')
      .set('Cookie', warehouseCookie)
      .set('x-business-id', businessId)
      .expect(200);
    expect(wh.body.cashierDashboard).toBe(false);
  });

  it('refuses My Day to a role without the permission', async () => {
    await request(app.getHttpServer())
      .get('/v1/dashboard/my-day')
      .set('Cookie', warehouseCookie)
      .set('x-business-id', businessId)
      .expect(403);
  });
});

describe('My Day', () => {
  // The JSON body as the browser sees it — dates are strings here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: Record<string, any>;
  beforeAll(async () => {
    const res = await asCashier('/v1/dashboard/my-day').expect(200);
    body = res.body;
  });

  it('lands on the first store (never the warehouse) with the picker listing every store', () => {
    expect(body.location.name).toBe('A Store');
    expect(body.location.timezone).toBe(TZ);
    expect(body.locations.map((l: { name: string }) => l.name)).toEqual([
      'A Store',
      'B Store',
      'Main Warehouse',
    ]);
    expect(body.date).toBe(localDay(0));
  });

  it('card 1 — my written and collected today against the same weekday last week', () => {
    // Mine today, any store: $1,000 deposit order + $100 paid order at
    // A Store, the $1,000 pickup at B Store, and the $200 register sale.
    // The $300 pickup was written 9 days ago; the rival's tickets are
    // not mine.
    expect(body.myDay.today.writtenCents).toBe(100_000 + 10_000 + 100_000 + 20_000);
    expect(body.myDay.today.documents).toBe(4);
    // Money that landed today on documents I wrote, whenever written:
    // $300 deposit, $100 in full, $200 cash, $300 on the old pickup, $1,000 at B.
    expect(body.myDay.today.collectedCents).toBe(30_000 + 10_000 + 20_000 + 30_000 + 100_000);
    expect(body.myDay.today.avgTicketCents).toBe(Math.round(230_000 / 4));
    expect(body.myDay.lastWeek.writtenCents).toBe(50_000);
    expect(body.myDay.lastWeek.documents).toBe(1);
  });

  it('card 2 — my open drawer with the close ritual’s expected cash', () => {
    expect(body.drawer.shift.id).toBe(fx.shiftId);
    expect(body.drawer.shift.locationName).toBe('A Store');
    expect(body.drawer.shift.openingFloatCents).toBe(15_000);
    // Only cash counts: the $200 cash sale, not the card deposits.
    expect(body.drawer.shift.cashInCents).toBe(20_000);
    expect(body.drawer.shift.expectedCashCents).toBe(35_000);
    expect(body.drawer.shift.stale).toBe(false);
    expect(body.drawer.shift.suspended).toBe(false);
    expect(body.drawer.lastClose.varianceCents).toBe(-500);
  });

  it('card 3 — my quotes and drafts, oldest first, never the rival’s', () => {
    const ids = body.callbacks.map((r: { orderId: string }) => r.orderId);
    expect(ids).toEqual([fx.quoteOrderId]);
    expect(body.callbacks[0].ageDays).toBe(5);
    expect(body.callbacks[0].phone).toBe('3105550100');
    expect(body.callbacks[0].status).toBe('quote');
  });

  it('card 4 — my customer’s delivery today; the rival’s tomorrow stays out', () => {
    expect(body.myDeliveries).toHaveLength(1);
    expect(body.myDeliveries[0].deliveryId).toBe(fx.todayDeliveryId);
    expect(body.myDeliveries[0].when).toBe('today');
    expect(body.myDeliveries[0].windowStart).toBe('09:00:00');
    expect(body.myDeliveries[0].customerName).toBe('Dana Register');
  });

  it('card 5 — balance due computed from the ledger, due-now first', () => {
    // Today's $1,000 order ($300 down, due today) leads; last week's
    // $500 order with nothing paid follows (no date). Paid-in-full
    // orders, the quote, and the rival's half-paid ticket stay out.
    expect(body.balanceDue.rows.map((r: { orderId: string }) => r.orderId)).toEqual([
      fx.depositOrderId,
      fx.lastWeekOrderId,
    ]);
    const row = body.balanceDue.rows[0];
    expect(row.paidCents).toBe(30_000);
    expect(row.balanceCents).toBe(70_000);
    expect(row.dueNow).toBe(true);
    expect(body.balanceDue.rows[1].balanceCents).toBe(50_000);
    expect(body.balanceDue.rows[1].dueNow).toBe(false);
    expect(body.balanceDue.totalCents).toBe(120_000);
  });

  it('card 6 — pickups waiting at this store with readiness and ownership', () => {
    const byId = new Map(body.pickups.map((p: { orderId: string }) => [p.orderId, p]));
    expect(byId.size).toBe(2);
    const ready = byId.get(fx.pickupReadyId) as { ready: boolean; mine: boolean };
    expect(ready.ready).toBe(true);
    expect(ready.mine).toBe(false);
    const mine = byId.get(fx.pickupMineId) as { ready: boolean; mine: boolean; ageDays: number };
    expect(mine.ready).toBe(false);
    expect(mine.mine).toBe(true);
    expect(mine.ageDays).toBe(9);
  });

  it('card 7 — commission by status for the period, with the last payout', () => {
    expect(body.commission.period).toBe(currentPeriod());
    expect(body.commission.accruedCents).toBe(5_000);
    expect(body.commission.pendingCents).toBe(4_000);
    expect(body.commission.approvedCents).toBe(1_000);
    expect(body.commission.paidCents).toBe(0);
    expect(body.commission.lastPaid).toEqual({ period: previousPeriod(), cents: 9_000 });
  });

  it('card 8 — live promo codes and the discount tiers from settings', () => {
    expect(body.promos.codes.map((c: { code: string }) => c.code)).toEqual(['FALL10']);
    expect(body.promos.codes[0].remainingUses).toBe(60);
    expect(body.promos.codes[0].minSubtotalCents).toBe(50_000);
    expect(body.promos.priceVariance).toEqual({ tier1Pct: 7, tier1MaxCents: 7500, tier2Pct: 20 });
  });

  it('card 9 — my unfinished return and exchange, not the finished or the rival’s', () => {
    const keys = body.myReturns.map((r: { kind: string; id: string }) => `${r.kind}:${r.id}`);
    expect(keys).toHaveLength(2);
    expect(keys).toContain(`return:${fx.returnId}`);
    expect(keys).toContain(`exchange:${fx.exchangeId}`);
    const ret = body.myReturns.find((r: { kind: string }) => r.kind === 'return');
    expect(ret.number).toBe('RMA-MD-001');
    expect(ret.amountCents).toBe(10_000);
  });

  it('card 10 — the store today and my rank this week', () => {
    // Store today: mine $1,000 + $100, rival $9,999 + $400 pickup, register $200.
    expect(body.scoreboard.storeTodayCents).toBe(100_000 + 10_000 + 999_900 + 40_000 + 20_000);
    expect(body.scoreboard.storeTodayDocuments).toBe(5);
    expect(body.scoreboard.myShareCents).toBe(130_000);
    expect(body.scoreboard.week.sellers).toBe(2);
    expect(body.scoreboard.week.rank).toBe(2);
    expect(body.scoreboard.week.leaderCents).toBe(999_900 + 40_000);
  });

  it('follows the picker to another store', async () => {
    const res = await asCashier(`/v1/dashboard/my-day?locationId=${otherStoreLocId}`).expect(200);
    expect(res.body.location.name).toBe('B Store');
    expect(res.body.pickups).toHaveLength(1);
    expect(res.body.scoreboard.storeTodayCents).toBe(100_000);
    // "Mine" cards do not move with the store.
    expect(res.body.callbacks).toHaveLength(1);
    expect(res.body.drawer.shift.id).toBe(fx.shiftId);
  });
});

describe('ZIP lookup for address entry', () => {
  it('resolves a US ZIP to its city and state', async () => {
    const res = await asCashier('/v1/geo/zip/90036').expect(200);
    expect(res.body).toMatchObject({ zip: '90036', city: 'Los Angeles', state: 'CA' });
  });

  it('tolerates ZIP+4 and rejects garbage', async () => {
    const res = await asCashier('/v1/geo/zip/90036-1234').expect(200);
    expect(res.body.city).toBe('Los Angeles');
    await asCashier('/v1/geo/zip/abc').expect(400);
    await asCashier('/v1/geo/zip/00000').expect(404);
  });

  it('needs a signed-in member', async () => {
    await request(app.getHttpServer())
      .get('/v1/geo/zip/90036')
      .set('x-business-id', businessId)
      .expect(401);
  });
});

// Keep drizzle's eq import used for symmetry with sibling specs.
void eq;
