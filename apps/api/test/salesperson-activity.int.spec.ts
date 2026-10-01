/**
 * View Salesperson Activity (owner 2026-09-02): one read feeds the eight
 * STORIS-style views for a member. Seeds one salesperson with an open
 * delivery order (deposit taken, on a truck), a shared order where they are
 * the second salesperson, a completed order this month, a canceled order,
 * a layaway, a cart, a quote, and a lead — plus another member's order
 * that must not leak in.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
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
  process.env.SALESPERSON_ACTIVITY_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_salesperson_activity';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'SpActivityPass!2026';

let app: INestApplication;
let businessId = '';
let cookie = '';
const ids = { elyse: '', other: '', open: '', shared: '', done: '', quote: '', cart: '', lead: '' };

const TODAY = new Date().toISOString().slice(0, 10);
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
const LAST_YEAR = new Date(Date.UTC(new Date().getUTCFullYear() - 1, 2, 3));

function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  return fn(db).finally(() => sql.end({ timeout: 5 }));
}

async function resetTestDb() {
  const env = { ...process.env, DATABASE_URL: TEST_DB_URL };
  for (const script of ['src/reset.ts', 'src/migrate.ts']) {
    execFileSync('pnpm', ['exec', 'tsx', script], { cwd: dbPackageRoot, env, stdio: 'inherit' });
  }
}

async function seed() {
  await withDb(async (db) => {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'spa-test', name: 'SP Activity Test Co', status: 'active' })
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
    async function member(email: string, name: string, role: string) {
      const [u] = await db
        .insert(schema.users)
        .values({ email, emailVerified: true, name })
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
          sellingScope: role === 'Cashier' ? 'approved' : 'all',
        })
        .returning();
      return m!.id;
    }
    await member('mgr@spa-test.local', 'Manager Person', 'Manager');
    ids.elyse = await member('em@spa-test.local', 'Elyse Morris', 'Cashier');
    ids.other = await member('jd@spa-test.local', 'Jo Doe', 'Cashier');

    const [store] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'North Hollywood', timezone: 'America/Los_Angeles' })
      .returning();
    await db
      .insert(schema.membershipLocationScopes)
      .values({ businessId, membershipId: ids.elyse, locationId: store!.id });
    const [p] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'SPA-MAT', name: 'Queen Mattress' })
      .returning();
    const [v] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p!.id,
        sku: 'SPA-MAT-Q',
        priceCents: 100_000,
        costCents: 40_000,
      })
      .returning();
    async function customer(first: string, last: string) {
      const [c] = await db
        .insert(schema.customers)
        .values({ businessId, firstName: first, lastName: last, phone: '3105550100' })
        .returning();
      return c!.id;
    }
    const cShay = await customer('Lily', 'Shay');
    const cMarquis = await customer('Tyler', 'Marquis');
    const cLead = await customer('Pat', 'Prospect');
    ids.lead = cLead;

    type OrderSeed = {
      number: string;
      status: string;
      customerId: string;
      sp?: string;
      sp2?: string;
      orderKind?: string;
      fulfillmentType?: string;
      subtotal: number;
      tax?: number;
      createdAt?: Date;
      completedAt?: Date;
      cancelledAt?: Date;
      paid?: number;
    };
    async function order(o: OrderSeed) {
      const tax = o.tax ?? 0;
      const [row] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: store!.id,
          number: o.number,
          status: o.status,
          customerId: o.customerId,
          salespersonMembershipId: o.sp ?? ids.elyse,
          secondSalespersonMembershipId: o.sp2 ?? null,
          orderKind: o.orderKind ?? 'sales_order',
          fulfillmentType: o.fulfillmentType ?? 'delivery',
          subtotalCents: o.subtotal,
          taxCents: tax,
          totalCents: o.subtotal + tax,
          createdAt: o.createdAt ?? new Date(),
          completedAt: o.completedAt ?? null,
          cancelledAt: o.cancelledAt ?? null,
        })
        .returning();
      await db.insert(schema.orderLines).values({
        businessId,
        orderId: row!.id,
        variantId: v!.id,
        description: 'Queen Mattress',
        quantity: 1,
        qtyReserved: o.status === 'draft' || o.status === 'quote' ? 0 : 1,
        qtyFulfilled: o.status === 'completed' ? 1 : 0,
        unitPriceCents: o.subtotal,
        totalCents: o.subtotal,
      });
      if (o.paid) {
        await db.insert(schema.payments).values({
          businessId,
          orderId: row!.id,
          kind: 'deposit',
          method: 'card',
          amountCents: o.paid,
          status: 'succeeded',
        });
      }
      return row!.id;
    }

    // Open delivery order, scheduled on a truck, deposit taken (written today).
    ids.open = await order({
      number: 'SO-SPA-100',
      status: 'open',
      customerId: cShay,
      subtotal: 40_000,
      tax: 3_900,
      paid: 12_225,
    });
    await db.insert(schema.deliveries).values({
      businessId,
      locationId: store!.id,
      orderId: ids.open,
      scheduledDate: '2026-09-15',
      status: 'scheduled',
    });
    // Shared order: Jo wrote it, Elyse is the second salesperson (written last year).
    ids.shared = await order({
      number: 'SO-SPA-101',
      status: 'open',
      customerId: cMarquis,
      sp: ids.other,
      sp2: ids.elyse,
      subtotal: 80_000,
      createdAt: LAST_YEAR,
      paid: 80_000,
    });
    // Completed this month, paid in full.
    ids.done = await order({
      number: 'SO-SPA-090',
      status: 'completed',
      customerId: cMarquis,
      subtotal: 71_800,
      tax: 6_825,
      paid: 78_625,
      createdAt: new Date(`${MONTH_START}T12:00:00Z`),
      completedAt: new Date(`${TODAY}T15:00:00Z`),
    });
    // Completed last year — outside the default window.
    await order({
      number: 'SO-SPA-010',
      status: 'completed',
      customerId: cShay,
      subtotal: 10_000,
      paid: 10_000,
      createdAt: LAST_YEAR,
      completedAt: LAST_YEAR,
    });
    // Canceled today.
    await order({
      number: 'SO-SPA-095',
      status: 'cancelled',
      customerId: cShay,
      subtotal: 5_000,
      cancelledAt: new Date(`${TODAY}T16:00:00Z`),
    });
    // Layaway, cart, quote.
    await order({
      number: 'SO-SPA-120',
      status: 'open',
      customerId: cShay,
      orderKind: 'layaway',
      fulfillmentType: 'pickup',
      subtotal: 30_000,
      paid: 10_000,
    });
    ids.cart = await order({
      number: 'SO-SPA-130',
      status: 'draft',
      customerId: cLead,
      subtotal: 25_000,
    });
    ids.quote = await order({
      number: 'SO-SPA-140',
      status: 'quote',
      customerId: cShay,
      subtotal: 60_000,
    });
    // Jo's own order: must not appear for Elyse.
    await order({
      number: 'SO-SPA-999',
      status: 'open',
      customerId: cShay,
      sp: ids.other,
      subtotal: 1_000,
    });
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

function getActivity(membershipId = ids.elyse, qs = `today=${TODAY}`) {
  return request(app.getHttpServer())
    .get(`/v1/salespeople/${membershipId}/activity?${qs}`)
    .set('Cookie', cookie)
    .set('x-business-id', businessId);
}

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'spa-test-secret-spa-test-secret-xxxx';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();
  cookie = await captureCookie('mgr@spa-test.local');
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('View Salesperson Activity', () => {
  it('header: code, name, email, selling location; general totals', async () => {
    const res = await getActivity().expect(200);
    expect(res.body.salesperson).toMatchObject({
      membershipId: ids.elyse,
      code: 'EM',
      name: 'Elyse Morris',
      email: 'em@spa-test.local',
      sellingLocations: ['North Hollywood'],
      status: 'active',
    });
    expect(res.body.range.today).toBe(TODAY);
    const g = res.body.general;
    // Open orders: SO-SPA-100 (43,900) + shared SO-SPA-101 (80,000). Layaway 30,000. Quote 60,000. Cart 25,000.
    expect(g).toMatchObject({
      ordersCents: 43_900 + 80_000,
      ordersCount: 2,
      layawaysCents: 30_000,
      layawaysCount: 1,
      quotesCents: 60_000,
      quotesCount: 1,
      cartsCents: 25_000,
      cartsCount: 1,
    });
    // Written today: open 43,900 + canceled excluded + layaway 30,000 written today.
    // On the 1st, the order "written on the 1st" was written today as well.
    expect(g.writtenTodayCents).toBe(43_900 + 30_000 + (TODAY === MONTH_START ? 78_625 : 0));
    // MTD adds the completed order written on the 1st (78,625).
    expect(g.writtenMtdCents).toBe(43_900 + 30_000 + 78_625);
    expect(g.deliveredTodayCents).toBe(78_625);
    expect(g.deliveredMtdCents).toBe(78_625);
  });

  it('open orders: own and shared, with status, money split and salespeople count', async () => {
    const res = await getActivity().expect(200);
    const rows = res.body.openOrders;
    expect(rows.map((r: { number: string }) => r.number).sort()).toEqual([
      'SO-SPA-100',
      'SO-SPA-101',
    ]);
    expect(rows.find((r: { number: string }) => r.number === 'SO-SPA-100')).toMatchObject({
      customerName: 'Shay, Lily',
      orderType: 'Sales Order',
      fulfillmentType: 'Delivery',
      fulfillmentStatus: 'Scheduled',
      fulfillmentDate: '2026-09-15',
      merchandiseCents: 40_000,
      totalCents: 43_900,
      amountPaidCents: 12_225,
      balanceCents: 31_675,
      salespeople: 1,
    });
    expect(rows.find((r: { number: string }) => r.number === 'SO-SPA-101')).toMatchObject({
      customerName: 'Marquis, Tyler',
      fulfillmentStatus: 'Reserved',
      amountPaidCents: 80_000,
      balanceCents: 0,
      salespeople: 2,
    });
    expect(JSON.stringify(res.body)).not.toContain('SO-SPA-999');
  });

  it('completed and canceled orders honor the date window', async () => {
    const res = await getActivity().expect(200);
    expect(res.body.completedOrders).toEqual([
      expect.objectContaining({
        number: 'SO-SPA-090',
        completedDate: TODAY,
        merchandiseCents: 71_800,
        totalCents: 78_625,
        amountPaidCents: 78_625,
        balanceCents: 0,
      }),
    ]);
    expect(res.body.canceledOrders).toEqual([
      expect.objectContaining({ number: 'SO-SPA-095', cancelledDate: TODAY, totalCents: 5_000 }),
    ]);
    // Widen the window to last year: the old completed order appears.
    const wide = await getActivity(ids.elyse, `today=${TODAY}&from=2000-01-01&to=${TODAY}`).expect(
      200,
    );
    expect(wide.body.completedOrders.map((r: { number: string }) => r.number).sort()).toEqual([
      'SO-SPA-010',
      'SO-SPA-090',
    ]);
    expect(wide.body.range).toMatchObject({ from: '2000-01-01', to: TODAY });
  });

  it('layaways, carts, quotes and leads', async () => {
    const res = await getActivity().expect(200);
    expect(res.body.layaways).toEqual([
      expect.objectContaining({
        number: 'SO-SPA-120',
        orderType: 'Layaway',
        fulfillmentType: 'Take With',
        balanceCents: 20_000,
      }),
    ]);
    expect(res.body.carts).toEqual([expect.objectContaining({ id: ids.cart, orderType: 'Cart' })]);
    expect(res.body.quotes).toEqual([
      expect.objectContaining({ id: ids.quote, orderType: 'Quote' }),
    ]);
    // Lily Shay has real orders, so only Pat Prospect (cart only) is a lead.
    expect(res.body.leads).toEqual([
      expect.objectContaining({
        customerId: ids.lead,
        name: 'Pat Prospect',
        source: 'Cart',
        documentNumber: 'SO-SPA-130',
      }),
    ]);
  });

  it('the other salesperson sees only their own; unknown membership is 404', async () => {
    const res = await getActivity(ids.other).expect(200);
    expect(res.body.openOrders.map((r: { number: string }) => r.number).sort()).toEqual([
      'SO-SPA-101',
      'SO-SPA-999',
    ]);
    expect(res.body.salesperson.sellingLocations).toEqual([]);
    await getActivity('00000000-0000-0000-0000-000000000000').expect(404);
  });
});
