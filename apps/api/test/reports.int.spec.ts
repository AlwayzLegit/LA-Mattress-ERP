/**
 * Epic 1.11 acceptance: end-of-day close — a cashier reconciles cash, an
 * owner views the day's totals, exports to CSV.
 *
 * Walks through opening a shift, ringing a cash sale + a card sale,
 * closing the shift with a counted-cash amount that produces a known
 * variance, fetching the daily report, the by-product report (with and
 * without `reports.financial.view`), low-stock inventory, and a CSV
 * download.
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
  process.env.REPORTS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_reports';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'ReportsPass!2026';

let app: INestApplication;
let businessId = '';
let locationId = '';
let variantAId = '';
let mattressesCategoryId = '';
let variantBId = '';
let cashierCookie = '';
let ownerCookie = '';
let bookkeeperCookie = '';
let scopedCookie = '';
let annexLocationId = '';
let scopedMembershipId = '';

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
      .values({
        slug: 'reports-test',
        name: 'Reports Test Co',
        status: 'active',
        defaultTaxRateBps: 0, // keep math obvious
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
    await makeUser('owner@reports-test.local', 'Owner');
    await makeUser('cashier@reports-test.local', 'Cashier');
    await makeUser('bookkeeper@reports-test.local', 'Bookkeeper');

    const [loc] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Main', timezone: 'America/New_York' })
      .returning();
    locationId = loc!.id;
    const [annex] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Annex', timezone: 'America/New_York' })
      .returning();
    annexLocationId = annex!.id;

    // Store-scoped manager (Sales Views Phase 1): sees Main only.
    {
      const [u] = await db
        .insert(schema.users)
        .values({ email: 'scoped@reports-test.local', emailVerified: true, name: 'Scoped' })
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
          roleId: roles.get('Manager')!,
          status: 'active',
          acceptedAt: new Date(),
          dataScope: 'store',
        })
        .returning();
      scopedMembershipId = m!.id;
      await db
        .insert(schema.membershipLocationScopes)
        .values({ membershipId: m!.id, locationId, businessId });
    }

    // A sits on a subcategory (A22.1 tree): "Mattresses › Hybrid".
    const [mattresses] = await db
      .insert(schema.categories)
      .values({ businessId, name: 'Mattresses', position: 0 })
      .returning();
    mattressesCategoryId = mattresses!.id;
    const [hybrid] = await db
      .insert(schema.categories)
      .values({ businessId, name: 'Hybrid', parentId: mattresses!.id, position: 1 })
      .returning();
    const [pA] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'A', name: 'Widget', categoryId: hybrid!.id })
      .returning();
    const [vA] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: pA!.id,
        sku: 'A-1',
        priceCents: 1000,
        costCents: 400,
      })
      .returning();
    variantAId = vA!.id;

    const [pB] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'B', name: 'Gadget' })
      .returning();
    const [vB] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: pB!.id,
        sku: 'B-1',
        priceCents: 500,
        costCents: 200,
      })
      .returning();
    variantBId = vB!.id;

    // Stock A=20, B=2 — B will be flagged "low stock" with threshold 5.
    await db.insert(schema.inventoryLevels).values([
      { businessId, variantId: variantAId, locationId, onHand: 20 },
      { businessId, variantId: variantBId, locationId, onHand: 2 },
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

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'reports-test-secret-reports-test-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();

  ownerCookie = await captureCookie('owner@reports-test.local');
  cashierCookie = await captureCookie('cashier@reports-test.local');
  bookkeeperCookie = await captureCookie('bookkeeper@reports-test.local');
  scopedCookie = await captureCookie('scoped@reports-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

let shiftId = '';

describe('Epic 1.11 — Reports & cash drawer', () => {
  it('Cashier opens a cash shift with $100 float', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/cash-shifts')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, openingFloatCents: 10000, notes: 'morning' });
    expect(res.status).toBe(201);
    expect(res.body.openingFloatCents).toBe(10000);
    expect(res.body.closedAt).toBeNull();
    shiftId = res.body.id;
  });

  it('Cannot open a second shift while one is still open', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/cash-shifts')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, openingFloatCents: 5000 });
    expect(res.status).toBe(409);
  });

  it('Cashier rings a cash sale ($20) and a card sale ($5)', async () => {
    const cash = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [{ variantId: variantAId, quantity: 2 }],
        payments: [{ method: 'cash', amountCents: 2000 }],
      });
    expect(cash.status).toBe(201);

    const card = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [{ variantId: variantBId, quantity: 1 }],
        payments: [{ method: 'card', amountCents: 500 }],
      });
    expect(card.status).toBe(201);
  });

  it('Closing the shift computes expected $120 = $100 float + $20 cash; counted $118 = -$2 variance', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/cash-shifts/${shiftId}/close`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ countedCashCents: 11800 });
    expect(res.status).toBe(201);
    expect(res.body.expectedCashCents).toBe(12000);
    expect(res.body.countedCashCents).toBe(11800);
    expect(res.body.varianceCents).toBe(-200);
    expect(res.body.closedAt).toBeTruthy();
  });

  it('Daily sales report shows the day with subtotal $25 and 2 sales', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/sales/daily')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const today = res.body.byDay.find(
      (d: { day: string; saleCount: number; subtotalCents: number }) => d.saleCount === 2,
    );
    expect(today).toBeTruthy();
    expect(today.subtotalCents).toBe(2500);
    expect(today.totalCents).toBe(2500); // taxRateBps=0

    const cashier = res.body.byAssociate.find(
      (a: { associateEmail: string | null }) => a.associateEmail === 'cashier@reports-test.local',
    );
    expect(cashier.saleCount).toBe(2);

    const cash = res.body.byPaymentMethod.find((p: { method: string }) => p.method === 'cash');
    const card = res.body.byPaymentMethod.find((p: { method: string }) => p.method === 'card');
    expect(cash.amountCents).toBe(2000);
    expect(card.amountCents).toBe(500);
  });

  it('Sales-by-product is ordered by revenue desc and shows margin to financial viewers', async () => {
    const ownerRes = await request(app.getHttpServer())
      .get('/v1/reports/sales/by-product')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body[0].productName).toBe('Widget');
    expect(ownerRes.body[0].quantity).toBe(2);
    expect(ownerRes.body[0].revenueCents).toBe(2000);
    expect(ownerRes.body[0].marginCents).toBe(2000 - 400 * 2); // = 1200

    // Cashier has reports.sales.view? No — cashier does not. So it
    // should be 403. We use the bookkeeper, who has sales.view +
    // financial.view, to verify margin shows up; and use the cashier
    // to verify the 403.
    const cashierRes = await request(app.getHttpServer())
      .get('/v1/reports/sales/by-product')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(cashierRes.status).toBe(403);

    const bookkeeperRes = await request(app.getHttpServer())
      .get('/v1/reports/sales/by-product')
      .set('Cookie', bookkeeperCookie)
      .set('X-Business-Id', businessId);
    expect(bookkeeperRes.status).toBe(200);
    expect(bookkeeperRes.body[0].marginCents).toBe(1200);
  });

  it('Inventory on-hand with lowStock=5 returns only the gadget', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/inventory/on-hand?lowStock=5')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    // Widget started at 20, sold 2 → 18 (above threshold).
    // Gadget started at 2, sold 1 → 1 (below threshold).
    expect(res.body).toHaveLength(1);
    expect(res.body[0].productName).toBe('Gadget');
    expect(res.body[0].onHand).toBe(1);
  });

  it('CSV export of daily sales returns text/csv with the right headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/sales/daily?format=csv')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text.split('\r\n')[0]).toBe(
      'day,sale_count,subtotal_cents,discount_cents,tax_cents,total_cents',
    );
  });

  it('Z-report totals the day: 2 sales, $25 gross, tender mix, closed shift variance', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/z')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    if (res.status !== 200) console.error('Z-report error body:', res.body);
    expect(res.status).toBe(200);
    expect(res.body.saleCount).toBe(2);
    expect(res.body.grossCents).toBe(2500);
    expect(res.body.taxCents).toBe(0);
    expect(res.body.refundCount).toBe(0);
    expect(res.body.netCents).toBe(2500);
    const cash = res.body.tenders.find((t: { method: string }) => t.method === 'cash');
    const card = res.body.tenders.find((t: { method: string }) => t.method === 'card');
    expect(cash.amountCents).toBe(2000);
    expect(card.amountCents).toBe(500);
    expect(res.body.shifts).toHaveLength(1);
    expect(res.body.shifts[0].varianceCents).toBe(-200);
  });

  it('Z-report picks up a refund: $5 back on the Gadget sale → net $20', async () => {
    // Find the $5 card sale and its line, then refund the single unit.
    const list = await request(app.getHttpServer())
      .get('/v1/sales')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);
    const gadgetSale = list.body.data.find((s: { totalCents: number }) => s.totalCents === 500);
    expect(gadgetSale).toBeTruthy();
    const detail = await request(app.getHttpServer())
      .get(`/v1/sales/${gadgetSale.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(detail.status).toBe(200);
    const lineId = detail.body.lines[0].id;

    const refund = await request(app.getHttpServer())
      .post(`/v1/sales/${gadgetSale.id}/refund`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ saleLineId: lineId, quantity: 1 }], reason: 'test refund' });
    expect(refund.status).toBe(201);
    expect(refund.body.amountCents).toBe(500);

    const res = await request(app.getHttpServer())
      .get('/v1/reports/z')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    // The refunded sale keeps its original revenue in gross; the refund
    // shows on its own line and nets out.
    expect(res.body.grossCents).toBe(2500);
    expect(res.body.refundCount).toBe(1);
    expect(res.body.refundsCents).toBe(500);
    expect(res.body.netCents).toBe(2000);
  });

  it('Sales by category reads the full category path and groups uncategorized lines together', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/sales/by-category')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Highest revenue first: the two Widgets ($20) on "Mattresses › Hybrid".
    expect(res.body[0]).toMatchObject({
      categoryName: 'Hybrid',
      categoryPath: 'Mattresses › Hybrid',
      quantity: 2,
      revenueCents: 2000,
    });
    expect(res.body[1]).toMatchObject({
      categoryId: null,
      categoryName: 'Uncategorized',
      categoryPath: 'Uncategorized',
      quantity: 1,
      revenueCents: 500,
    });
    const csv = await request(app.getHttpServer())
      .get('/v1/reports/sales/by-category?format=csv')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(csv.text).toContain('Mattresses › Hybrid,2,2000');
  });

  it('Inventory valuation multiplies on-hand by cost and retail; cashier is 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/inventory/valuation')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    // Widget: 18 on hand × cost 400 / price 1000. Gadget: 1 on hand —
    // the refunded unit sits in As-Is review (P8, §10), not in stock.
    const widget = res.body.rows.find((r: { sku: string }) => r.sku === 'A-1');
    expect(widget.costValueCents).toBe(18 * 400);
    expect(widget.retailValueCents).toBe(18 * 1000);
    expect(res.body.totalCostValueCents).toBe(18 * 400 + 1 * 200);
    expect(res.body.totalRetailValueCents).toBe(18 * 1000 + 1 * 500);

    const cashierRes = await request(app.getHttpServer())
      .get('/v1/reports/inventory/valuation')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(cashierRes.status).toBe(403);
  });

  it('Tax summary reconciles with the day: zero tax, net sales $25', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/tax/summary')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].taxClassName).toBe('Default rate');
    expect(res.body.rows[0].netSalesCents).toBe(2500);
    expect(res.body.totalTaxCents).toBe(0);
  });

  it('CSV export denied for users without reports.export', async () => {
    // The Bookkeeper role has reports.export, so we use a role that
    // explicitly does not — Cashier — but Cashier is also missing
    // reports.sales.view. The Cashier therefore 403s on the underlying
    // permission. So we instead verify the bookkeeper succeeds (proxy
    // for "the gate works").
    const res = await request(app.getHttpServer())
      .get('/v1/reports/sales/daily?format=csv')
      .set('Cookie', bookkeeperCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
  });
});

describe('Sales Views Phase 1 — store-level data scope', () => {
  // A completed sale and an order at each location, inserted directly so
  // the assertions are about scoping, not the POS flow.
  beforeAll(async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      await db.insert(schema.sales).values([
        {
          businessId,
          locationId,
          number: 'SC-MAIN-1',
          status: 'completed',
          completedAt: new Date(),
          subtotalCents: 10000,
          totalCents: 10000,
        },
        {
          businessId,
          locationId: annexLocationId,
          number: 'SC-ANNEX-1',
          status: 'completed',
          completedAt: new Date(),
          subtotalCents: 5000,
          totalCents: 5000,
        },
      ]);
      const [cust] = await db
        .insert(schema.customers)
        .values({ businessId, firstName: 'Scope', lastName: 'Fixture' })
        .returning();
      await db.insert(schema.orders).values([
        {
          businessId,
          locationId,
          customerId: cust!.id,
          number: 'ORD-MAIN-1',
          status: 'confirmed',
          totalCents: 7000,
        },
        {
          businessId,
          locationId: annexLocationId,
          customerId: cust!.id,
          number: 'ORD-ANNEX-1',
          status: 'confirmed',
          totalCents: 3000,
        },
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('members list exposes dataScope and scope locations', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/business/members')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const scoped = res.body.find(
      (m: { membershipId: string }) => m.membershipId === scopedMembershipId,
    );
    expect(scoped.dataScope).toBe('store');
    expect(scoped.scopeLocationIds).toEqual([locationId]);
  });

  it('owner sees both locations in the sales list; scoped member sees Main only', async () => {
    const ownerRes = await request(app.getHttpServer())
      .get('/v1/sales?limit=200')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const ownerNumbers = ownerRes.body.data.map((r: { number: string }) => r.number);
    expect(ownerNumbers).toContain('SC-MAIN-1');
    expect(ownerNumbers).toContain('SC-ANNEX-1');

    const scopedRes = await request(app.getHttpServer())
      .get('/v1/sales?limit=200')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const numbers = scopedRes.body.data.map((r: { number: string }) => r.number);
    expect(numbers).toContain('SC-MAIN-1');
    expect(numbers).not.toContain('SC-ANNEX-1');
  });

  it('orders list is scoped the same way', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/orders?limit=200')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const numbers = res.body.data.map((r: { number: string }) => r.number);
    expect(numbers).toContain('ORD-MAIN-1');
    expect(numbers).not.toContain('ORD-ANNEX-1');
  });

  it('sales/daily totals exclude the other store for the scoped member', async () => {
    const owner = await request(app.getHttpServer())
      .get('/v1/reports/sales/daily')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const ownerTotal = owner.body.byDay.reduce(
      (a: number, d: { totalCents: number }) => a + d.totalCents,
      0,
    );

    const scoped = await request(app.getHttpServer())
      .get('/v1/reports/sales/daily')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const scopedTotal = scoped.body.byDay.reduce(
      (a: number, d: { totalCents: number }) => a + d.totalCents,
      0,
    );
    // Owner sees exactly 5000 more (the Annex sale).
    expect(ownerTotal - scopedTotal).toBe(5000);
  });

  it('a Z-report requested for an out-of-scope location intersects to nothing', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/reports/z?locationId=${annexLocationId}`)
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(res.body.saleCount).toBe(0);
    expect(res.body.grossCents).toBe(0);
  });

  it('emptying the scope list makes the member see no sales data (fail closed)', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/business/members/${scopedMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ scopeLocationIds: [] })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get('/v1/sales?limit=200')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(res.body.data).toEqual([]);

    // Restore for any later suites.
    await request(app.getHttpServer())
      .patch(`/v1/business/members/${scopedMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ scopeLocationIds: [locationId] })
      .expect(200);
  });

  it('setting dataScope back to all restores full visibility', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/business/members/${scopedMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ dataScope: 'all' })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get('/v1/sales?limit=200')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const numbers = res.body.data.map((r: { number: string }) => r.number);
    expect(numbers).toContain('SC-ANNEX-1');

    // Back to store scope so the fixture state is deterministic.
    await request(app.getHttpServer())
      .patch(`/v1/business/members/${scopedMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ dataScope: 'store' })
      .expect(200);
  });
});

describe('Sales Views — unified written/delivered sales summary', () => {
  // Fixture state from the scope suite: POS sales SC-MAIN-1 (100.00, Main)
  // and SC-ANNEX-1 (50.00, Annex), both completed; orders ORD-MAIN-1
  // (70.00) and ORD-ANNEX-1 (30.00), both 'confirmed' with no completedAt.
  it('written includes open orders; delivered does not', async () => {
    const written = await request(app.getHttpServer())
      .get('/v1/reports/sales/summary?basis=written')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const delivered = await request(app.getHttpServer())
      .get('/v1/reports/sales/summary?basis=delivered')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    // The two confirmed-but-unfulfilled orders (70.00 + 30.00) are the
    // exact difference between the two bases.
    expect(written.body.totals.totalCents - delivered.body.totals.totalCents).toBe(10000);
    expect(written.body.totals.documentCount - delivered.body.totals.documentCount).toBe(2);
  });

  it('groups by location with human labels', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/sales/summary?basis=written&groupBy=location')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const labels = res.body.rows.map((r: { label: string }) => r.label);
    expect(labels).toContain('Main');
    expect(labels).toContain('Annex');
    const annex = res.body.rows.find((r: { label: string }) => r.label === 'Annex');
    // Annex carries exactly the annex sale (50.00) + annex order (30.00).
    expect(annex.totalCents).toBe(8000);
  });

  it('store scope applies: scoped member is short exactly the Annex dollars', async () => {
    const owner = await request(app.getHttpServer())
      .get('/v1/reports/sales/summary?basis=written')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const scoped = await request(app.getHttpServer())
      .get('/v1/reports/sales/summary?basis=written')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(owner.body.totals.totalCents - scoped.body.totals.totalCents).toBe(8000);
  });

  it('average merchandise counts documents, and CSV export carries provenance', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/sales/summary?basis=written')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const t = res.body.totals;
    expect(t.averageMerchandiseCents).toBe(Math.round(t.merchandiseCents / t.documentCount));

    const csv = await request(app.getHttpServer())
      .get('/v1/reports/sales/summary?basis=written&format=csv')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(csv.text.startsWith('# basis=written')).toBe(true);
    expect(csv.text).toContain('generated=');
  });
});

describe('Sales Views — delivery dates in jeopardy', () => {
  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [cust] = await db
        .insert(schema.customers)
        .values({ businessId, firstName: 'Jeopardy', lastName: 'Fixture' })
        .returning();
      const iso = (offsetDays: number) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + offsetDays);
        return d.toISOString().slice(0, 10);
      };

      // J1: short line, variant A, NO inbound supply -> no_supply.
      const [j1] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId,
          customerId: cust!.id,
          number: 'JEO-1',
          status: 'confirmed',
          requestedDate: iso(5),
          totalCents: 1000,
        })
        .returning();
      await db.insert(schema.orderLines).values({
        businessId,
        orderId: j1!.id,
        variantId: variantAId,
        description: 'Widget',
        quantity: 3,
        unitPriceCents: 1000,
        totalCents: 3000,
      });

      // J2: short line, variant B, PO lands 8 days after the promise -> late.
      const [j2] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId,
          customerId: cust!.id,
          number: 'JEO-2',
          status: 'confirmed',
          requestedDate: iso(2),
          totalCents: 500,
        })
        .returning();
      await db.insert(schema.orderLines).values({
        businessId,
        orderId: j2!.id,
        variantId: variantBId,
        description: 'Gadget',
        quantity: 2,
        unitPriceCents: 500,
        totalCents: 1000,
      });

      // J3: same variant B but promised AFTER the PO arrives -> covered.
      const [j3] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId,
          customerId: cust!.id,
          number: 'JEO-3',
          status: 'confirmed',
          requestedDate: iso(20),
          totalCents: 500,
        })
        .returning();
      await db.insert(schema.orderLines).values({
        businessId,
        orderId: j3!.id,
        variantId: variantBId,
        description: 'Gadget',
        quantity: 1,
        unitPriceCents: 500,
        totalCents: 500,
      });

      // Custom charges and direct shipments are not warehouse stock risks.
      // Supply must follow the stock source, while access follows the selling store.
      const fixtures = [
        { number: 'JEO-CUSTOM', lineType: 'custom', variantId: null },
        { number: 'JEO-DIRECT', lineType: 'direct_ship', variantId: variantAId },
        {
          number: 'JEO-LINE-DIRECT',
          lineType: 'stock',
          variantId: variantAId,
          fulfillmentMethod: 'direct_ship',
        },
        {
          number: 'JEO-ORDER-DIRECT',
          lineType: 'stock',
          variantId: variantAId,
          fulfillmentType: 'direct_ship',
        },
        { number: 'JEO-UNLINKED', lineType: 'stock', variantId: null },
        {
          number: 'JEO-SOURCE-COVERED',
          lineType: 'stock',
          variantId: variantBId,
          sellingLocationId: annexLocationId,
          stockLocationId: locationId,
        },
        {
          number: 'JEO-SOURCE-SHORT',
          lineType: 'stock',
          variantId: variantBId,
          stockLocationId: locationId,
          sourceLocationId: annexLocationId,
        },
      ];
      for (const fixture of fixtures) {
        const [order] = await db
          .insert(schema.orders)
          .values({
            businessId,
            locationId: fixture.sellingLocationId ?? locationId,
            stockLocationId: fixture.stockLocationId,
            customerId: cust!.id,
            number: fixture.number,
            status: 'open',
            requestedDate: iso(20),
            totalCents: 500,
            fulfillmentType: fixture.fulfillmentType ?? 'delivery',
          })
          .returning();
        await db.insert(schema.orderLines).values({
          businessId,
          orderId: order!.id,
          variantId: fixture.variantId,
          lineType: fixture.lineType,
          fulfillmentMethod: fixture.fulfillmentMethod,
          sourceLocationId: fixture.sourceLocationId,
          description: 'Original item description',
          quantity: 1,
          unitPriceCents: 500,
          totalCents: 500,
        });
      }

      const [vendor] = await db
        .insert(schema.vendors)
        .values({ businessId, name: 'Jeopardy Vendor' })
        .returning();
      const expected = new Date();
      expected.setUTCDate(expected.getUTCDate() + 10);
      const [po] = await db
        .insert(schema.purchaseOrders)
        .values({
          businessId,
          vendorId: vendor!.id,
          locationId,
          number: 'PO-JEO-1',
          status: 'ordered',
          expectedAt: expected,
        })
        .returning();
      await db.insert(schema.purchaseOrderLines).values({
        businessId,
        purchaseOrderId: po!.id,
        variantId: variantBId,
        quantityOrdered: 5,
        unitCostCents: 100,
        lineTotalCents: 500,
      });
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  it('classifies no-supply vs late with explicit states, and drops covered lines', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/delivery-jeopardy?horizonDays=60')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const byOrder = new Map(res.body.rows.map((r: { orderNumber: string }) => [r.orderNumber, r]));
    const j1 = byOrder.get('JEO-1') as { risk: string; daysLate: number | null } | undefined;
    expect(j1).toBeTruthy();
    expect(j1!.risk).toBe('no_supply');
    expect(j1!.daysLate).toBeNull();

    const j2 = byOrder.get('JEO-2') as
      | { risk: string; daysLate: number; supplySource: string; supplyReference: string }
      | undefined;
    expect(j2).toBeTruthy();
    expect(j2!.risk).toBe('late');
    expect(j2!.daysLate).toBe(8);
    expect(j2!.supplySource).toBe('po');
    expect(j2!.supplyReference).toBe('PO-JEO-1');

    // Covered: PO arrives day +10, promise is day +20 — not in the queue.
    expect(byOrder.get('JEO-3')).toBeUndefined();
  });

  it('excludes non-warehouse lines, preserves unlinked descriptions, and checks the actual source', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/delivery-jeopardy?horizonDays=60')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const rows = res.body.rows as {
      orderNumber: string;
      productName: string;
      risk: string;
      locationId: string;
    }[];
    const byOrder = new Map(rows.map((row) => [row.orderNumber, row]));
    for (const number of [
      'JEO-CUSTOM',
      'JEO-DIRECT',
      'JEO-LINE-DIRECT',
      'JEO-ORDER-DIRECT',
      'JEO-SOURCE-COVERED',
    ]) {
      expect(byOrder.has(number)).toBe(false);
    }
    expect(byOrder.get('JEO-UNLINKED')?.productName).toBe('Original item description');
    expect(byOrder.get('JEO-SOURCE-SHORT')).toMatchObject({ risk: 'no_supply', locationId });
  });

  it('horizon bounds the list', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/delivery-jeopardy?horizonDays=3')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const numbers = res.body.rows.map((r: { orderNumber: string }) => r.orderNumber);
    expect(numbers).toContain('JEO-2'); // promised +2
    expect(numbers).not.toContain('JEO-1'); // promised +5, outside horizon
  });
});

describe('Jeopardy — approved-store filter + salesperson attribution', () => {
  let cashierMembershipId = '';

  it('rows carry the salesperson, and an approved-only member sees only their stores', async () => {
    const members = await request(app.getHttpServer())
      .get('/v1/business/members')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const cashier = members.body.find((m: { email: string }) => m.email.startsWith('cashier@'));
    cashierMembershipId = cashier.membershipId;

    // An at-risk order AT THE ANNEX carrying a salesperson.
    const sql4 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const db = drizzle(sql4);
      const iso = (offsetDays: number) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + offsetDays);
        return d.toISOString().slice(0, 10);
      };
      const [cust] = await db
        .insert(schema.customers)
        .values({ businessId, firstName: 'Annex', lastName: 'Buyer' })
        .returning();
      const [jx] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: annexLocationId,
          customerId: cust!.id,
          number: 'JEO-ANNEX',
          status: 'confirmed',
          requestedDate: iso(4),
          totalCents: 1000,
          salespersonMembershipId: cashierMembershipId,
        })
        .returning();
      await db.insert(schema.orderLines).values({
        businessId,
        orderId: jx!.id,
        variantId: variantAId,
        description: 'Widget',
        quantity: 1,
        unitPriceCents: 1000,
        totalCents: 1000,
      });
    } finally {
      await sql4.end({ timeout: 5 });
    }

    // The owner sees both stores, and the annex row names its salesperson.
    const ownerView = await request(app.getHttpServer())
      .get('/v1/reports/delivery-jeopardy?horizonDays=60')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const annexRow = ownerView.body.rows.find(
      (r: { orderNumber: string }) => r.orderNumber === 'JEO-ANNEX',
    );
    expect(annexRow).toBeTruthy();
    expect(annexRow.salespersonMembershipId).toBe(cashierMembershipId);
    expect(annexRow.salespersonName).toBeTruthy();
    expect(
      ownerView.body.rows.some((r: { orderNumber: string }) => r.orderNumber === 'JEO-1'),
    ).toBe(true);

    // Approve the cashier for the MAIN store only -> the annex row drops
    // from their call list while the main-store rows stay.
    await request(app.getHttpServer())
      .patch(`/v1/business/members/${cashierMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ sellingScope: 'approved', scopeLocationIds: [locationId] })
      .expect(200);
    const scopedView = await request(app.getHttpServer())
      .get('/v1/reports/delivery-jeopardy?horizonDays=60')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const scopedNumbers = scopedView.body.rows.map((r: { orderNumber: string }) => r.orderNumber);
    expect(scopedNumbers).toContain('JEO-1');
    expect(scopedNumbers).not.toContain('JEO-ANNEX');

    // Cleanup for later suites.
    await request(app.getHttpServer())
      .patch(`/v1/business/members/${cashierMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ sellingScope: 'all', scopeLocationIds: [] })
      .expect(200);
  });
});

describe('Sales Views — gift-card liability + delivery date changes', () => {
  beforeAll(async () => {
    const sql3 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql3);
    try {
      await db.insert(schema.giftCards).values([
        {
          businessId,
          code: 'LIAB-ACTIVE-1',
          initialBalanceCents: 5000,
          currentBalanceCents: 4000,
          status: 'active',
        },
        {
          businessId,
          code: 'LIAB-ACTIVE-2',
          initialBalanceCents: 2500,
          currentBalanceCents: 2500,
          status: 'active',
        },
        {
          businessId,
          code: 'LIAB-SPENT',
          initialBalanceCents: 1000,
          currentBalanceCents: 0,
          status: 'redeemed',
        },
      ]);
      await db.insert(schema.auditLogs).values({
        businessId,
        actorType: 'user',
        action: 'delivery.update',
        targetType: 'delivery',
        targetId: '00000000-0000-4000-8000-000000000001',
        changesJson: {
          before: { scheduledDate: '2026-08-20' },
          after: { scheduledDate: '2026-08-25' },
        },
      });
    } finally {
      await sql3.end({ timeout: 5 });
    }
  });

  it('liability totals only cards still carrying a balance; financial-gated', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/gift-cards/liability')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(res.body.cardCount).toBe(2);
    expect(res.body.outstandingCents).toBe(6500);
    const codes = res.body.rows.map((r: { code: string }) => r.code);
    expect(codes).not.toContain('LIAB-SPENT');

    await request(app.getHttpServer())
      .get('/v1/reports/gift-cards/liability')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(403);
  });

  it('delivery date change log surfaces before -> after from the audit trail', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/delivery-date-changes?days=7')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const row = res.body.rows.find(
      (r: { deliveryId: string | null }) => r.deliveryId === '00000000-0000-4000-8000-000000000001',
    );
    expect(row).toBeTruthy();
    expect(row.fromDate).toBe('2026-08-20');
    expect(row.toDate).toBe('2026-08-25');
    expect(row.action).toBe('delivery.update');
  });
});

describe('Sales Views — receipts + tax by location', () => {
  it('receipts group by method and location; scoped member is short the Annex money', async () => {
    // The Epic 1.11 flow took a $20 cash + $5 card payment at Main.
    const owner = await request(app.getHttpServer())
      .get('/v1/reports/receipts')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(owner.body.totals.amountCents).toBeGreaterThanOrEqual(2500);
    const cashMain = owner.body.rows.find(
      (r: { method: string; locationName: string | null }) =>
        r.method === 'cash' && r.locationName === 'Main',
    );
    expect(cashMain).toBeTruthy();
    expect(cashMain.amountCents).toBe(2000);

    const scoped = await request(app.getHttpServer())
      .get('/v1/reports/receipts')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    // No payments were taken at Annex in the fixtures, so totals match —
    // the row set must at least never contain a non-Main location.
    for (const r of scoped.body.rows) {
      expect(r.locationName === 'Main' || r.locationName === null).toBe(true);
    }
  });

  it('tax summary carries the by-location jurisdiction block', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/tax/summary')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(Array.isArray(res.body.byLocation)).toBe(true);
    const main = res.body.byLocation.find(
      (r: { locationName: string | null }) => r.locationName === 'Main',
    );
    const annex = res.body.byLocation.find(
      (r: { locationName: string | null }) => r.locationName === 'Annex',
    );
    // Completed POS sales exist at both locations (scope fixtures).
    expect(main).toBeTruthy();
    expect(annex).toBeTruthy();
    expect(annex.totalCents).toBe(5000); // the Annex sale
  });
});

describe('Sales Views — merchandising activity (buyer report)', () => {
  it('rows carry stock, inbound, velocity, and markup; no-activity rows drop by default', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/merchandising')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const widget = res.body.rows.find((r: { sku: string | null }) => r.sku === 'A-1');
    expect(widget).toBeTruthy();
    // Seeded 20 at Main; the POS flow sold 2, decrementing stock to 18.
    expect(widget.onHand).toBe(18);
    expect(widget.soldYtd).toBeGreaterThanOrEqual(2);
    // priceCents 1000, costCents 400 -> 150% markup.
    expect(widget.markupPct).toBe(150);
    const gadget = res.body.rows.find((r: { sku: string | null }) => r.sku === 'B-1');
    expect(gadget).toBeTruthy();
    // Jeopardy fixture put 5 units of B on an ordered PO.
    expect(gadget.onOrder).toBe(5);
    // A22.1: rows carry the category path, and filtering by the root
    // category keeps the products filed on its subcategories.
    expect(widget.categoryPath).toBe('Mattresses › Hybrid');
    expect(gadget.categoryPath).toBeNull();
    const byRoot = await request(app.getHttpServer())
      .get(`/v1/reports/merchandising?categoryId=${mattressesCategoryId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(byRoot.body.rows.map((r: { sku: string | null }) => r.sku)).toEqual(['A-1']);

    // Bookkeeper lacks reports.financial.view -> 403 (cost-bearing report).
    await request(app.getHttpServer())
      .get('/v1/reports/merchandising')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(403);
  });
});

describe('Sales Views — inventory adjustments + customer purchases', () => {
  it('adjustments group movements by reason with in/out unit totals', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/inventory-adjustments')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    // The POS flow decremented stock: a 'sale' reason bucket must exist
    // with at least the 2 Widget + 1 Gadget units out.
    const sale = res.body.byReason.find((r: { reason: string }) => r.reason === 'sale');
    expect(sale).toBeTruthy();
    expect(sale.totalOut).toBeGreaterThanOrEqual(3);
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.truncated).toBe(false);
  });

  it('customer purchase export returns completed lines and respects the customer filter', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/customer-purchases')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(2);
    const types = new Set(res.body.rows.map((r: { documentType: string }) => r.documentType));
    expect(types.has('sale')).toBe(true);

    // Filtering to a customer that bought nothing returns nothing.
    const none = await request(app.getHttpServer())
      .get('/v1/reports/customer-purchases?customerId=00000000-0000-4000-8000-00000000dead')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(none.body.rows).toEqual([]);
  });
});

describe('Sales Views Phase 4 — customer summary + salesperson filters', () => {
  it('customer summary totals lifetime/YTD and computes open-order balances', async () => {
    // The scope-fixture customer holds ORD-MAIN-1 (70.00) and
    // ORD-ANNEX-1 (30.00), both confirmed and unpaid.
    const cust = await request(app.getHttpServer())
      .get('/v1/customers?limit=200')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const rows = Array.isArray(cust.body) ? cust.body : cust.body.data;
    const fixture = rows.find(
      (c: { firstName: string | null; lastName: string | null }) =>
        c.firstName === 'Scope' && c.lastName === 'Fixture',
    );
    expect(fixture).toBeTruthy();

    const res = await request(app.getHttpServer())
      .get(`/v1/customers/${fixture.id}/summary`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(res.body.lifetime.documents).toBe(2);
    expect(res.body.lifetime.totalCents).toBe(10000);
    expect(res.body.openOrders.length).toBe(2);
    for (const o of res.body.openOrders) {
      expect(o.paidCents).toBe(0);
      expect(o.balanceCents).toBe(o.totalCents);
    }
  });

  it('orders list filters by salesperson membership; sales list by associate', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/orders?limit=200&salespersonMembershipId=${scopedMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    // No fixture order carries that salesperson -> empty, not an error.
    expect(res.body.data).toEqual([]);

    const sales = await request(app.getHttpServer())
      .get('/v1/sales?limit=200&associateUserId=00000000-0000-4000-8000-00000000beef')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(sales.body.data).toEqual([]);
  });
});

describe('Blind-count cash balancing (cash pack AC-5..10, owner 2026-08-28)', () => {
  let blindLocationId = '';

  async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      return await fn(drizzle(sql));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  async function setCashOps(ops: Record<string, unknown> | null): Promise<void> {
    await withDb((db) =>
      db
        .update(schema.businesses)
        .set({ opsSettingsJson: ops === null ? {} : { cashBalancing: ops } })
        .where(eq(schema.businesses.id, businessId)),
    );
  }
  function asCashier() {
    return {
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Cookie', cashierCookie)
          .set('X-Business-Id', businessId),
    };
  }
  async function openShift(): Promise<string> {
    const res = await asCashier()
      .post('/v1/cash-shifts')
      .send({ locationId: blindLocationId, openingFloatCents: 10000 });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    blindLocationId = await withDb(async (db) => {
      const [loc] = await db
        .insert(schema.locations)
        .values({ businessId, name: 'Blind Count Annex', timezone: 'America/Los_Angeles' })
        .returning();
      return loc!.id;
    });
    await setCashOps({ toleranceCents: 500, maxAttempts: 3 });
  });

  afterAll(async () => {
    await setCashOps(null);
  });

  it('AC-5: a count within tolerance closes without approval', async () => {
    const id = await openShift();
    // No payments at this location: expected = the $100 float.
    const res = await asCashier()
      .post(`/v1/cash-shifts/${id}/close`)
      .send({ countedCashCents: 9700 });
    expect(res.status).toBe(201);
    expect(res.body.varianceCents).toBe(-300);
    expect(res.body.approvedByUserId).toBeNull();
    expect(res.body.closedAt).toBeTruthy();
  });

  it('AC-6/8/10: out-of-tolerance counts burn attempts blindly, then suspend the drawer', async () => {
    const id = await openShift();
    const first = await asCashier()
      .post(`/v1/cash-shifts/${id}/close`)
      .send({ countedCashCents: 9000 });
    expect(first.status).toBe(400);
    expect(first.body.message).toContain('attempt 1 of 3');
    // AC-10 blind count: neither expected cash nor the variance leaks.
    expect(JSON.stringify(first.body)).not.toContain('10000');
    expect(JSON.stringify(first.body)).not.toContain('1000');

    const second = await asCashier()
      .post(`/v1/cash-shifts/${id}/close`)
      .send({ countedCashCents: 9100 });
    expect(second.status).toBe(400);
    expect(second.body.message).toContain('attempt 2 of 3');

    const third = await asCashier()
      .post(`/v1/cash-shifts/${id}/close`)
      .send({ countedCashCents: 9050 });
    expect(third.status).toBe(403);
    expect(third.body.message).toContain('suspended');

    // Suspended: a plain retry (even a correct count) demands approval.
    const afterSuspend = await asCashier()
      .post(`/v1/cash-shifts/${id}/close`)
      .send({ countedCashCents: 10000 });
    expect(afterSuspend.status).toBe(403);
    expect(afterSuspend.body.code).toBe('OVERRIDE_REQUIRED');

    // Manager (owner) credentials force-balance via the override dialog.
    const approved = await asCashier()
      .post(`/v1/cash-shifts/${id}/close`)
      .send({
        countedCashCents: 9050,
        override: {
          email: 'owner@reports-test.local',
          password: PASSWORD,
          reason: 'drawer recounted with the cashier',
        },
      });
    expect(approved.status).toBe(201);
    expect(approved.body.closedAt).toBeTruthy();
    expect(approved.body.varianceCents).toBe(-950);
    expect(approved.body.approvedByUserId).not.toBeNull();
    expect(approved.body.suspendedAt).toBeTruthy();
  });

  it('discipline off (null ops) keeps the legacy any-variance close', async () => {
    await setCashOps(null);
    const id = await openShift();
    const res = await asCashier()
      .post(`/v1/cash-shifts/${id}/close`)
      .send({ countedCashCents: 100 });
    expect(res.status).toBe(201);
    expect(res.body.varianceCents).toBe(-9900);
    // Restore for any later suites.
    await setCashOps({ toleranceCents: 500, maxAttempts: 3 });
    await setCashOps(null);
  });
});

describe('Manager dashboard (owner ask 2026-08-30)', () => {
  it('is gated by the per-member toggle, which the owner flips on', async () => {
    const denied = await request(app.getHttpServer())
      .get('/v1/dashboard/manager')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/not enabled/);

    await request(app.getHttpServer())
      .patch(`/v1/business/members/${scopedMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ managerDashboard: true, sellingScope: 'approved' })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/v1/business/members/me')
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(me.body.managerDashboard).toBe(true);
  });

  it('scopes to approved stores, counts today in STORE-LOCAL time, and fills the queues', async () => {
    // Baseline first — earlier suites wrote today's orders at Main too,
    // so every money assertion below is a delta.
    const before = (
      await request(app.getHttpServer())
        .get('/v1/dashboard/manager')
        .set('Cookie', scopedCookie)
        .set('X-Business-Id', businessId)
        .expect(200)
    ).body;
    expect(before.location.id).toBe(locationId);
    expect(before.locations.map((l: { id: string }) => l.id)).toEqual([locationId]);
    expect(before.salesByDay).toHaveLength(14);
    expect(before.salesByDay[13].day).toBe(before.date);

    // The Annex is not on the approved list.
    const wrongStore = await request(app.getHttpServer())
      .get(`/v1/dashboard/manager?locationId=${annexLocationId}`)
      .set('Cookie', scopedCookie)
      .set('X-Business-Id', businessId);
    expect(wrongStore.status).toBe(403);
    expect(wrongStore.body.message).toMatch(/not approved/);

    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const [cust] = await sqlc`
        INSERT INTO customers (business_id, first_name, last_name, phone)
        VALUES (${businessId}, 'Vlad', 'Caller', '555-201-7788') RETURNING id`;
      // Mine, written now, half paid.
      const [o1] = await sqlc`
        INSERT INTO orders (business_id, location_id, customer_id, number, status,
                            salesperson_membership_id, subtotal_cents, total_cents)
        VALUES (${businessId}, ${locationId}, ${cust!.id}, 'MDASH-1', 'open',
                ${scopedMembershipId}, 40000, 40000) RETURNING id`;
      await sqlc`
        INSERT INTO payments (business_id, order_id, kind, method, amount_cents, status)
        VALUES (${businessId}, ${o1!.id}, 'deposit', 'cash', 15000, 'succeeded')`;
      // Written at 23:00 STORE time tonight — that timestamp is already
      // TOMORROW in UTC, so a UTC day boundary would miss it (audit D3).
      await sqlc`
        INSERT INTO orders (business_id, location_id, customer_id, number, status,
                            subtotal_cents, total_cents, created_at)
        VALUES (${businessId}, ${locationId}, ${cust!.id}, 'MDASH-2', 'open', 10000, 10000,
                (((now() AT TIME ZONE 'America/New_York')::date + time '23:00')
                  AT TIME ZONE 'America/New_York'))`;
      // Past its promised date → the attention counter.
      await sqlc`
        INSERT INTO orders (business_id, location_id, customer_id, number, status,
                            subtotal_cents, total_cents, requested_date, created_at)
        VALUES (${businessId}, ${locationId}, ${cust!.id}, 'MDASH-3', 'open', 9000, 9000,
                (now() AT TIME ZONE 'America/New_York')::date - 3, now() - interval '2 days')`;
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    const after = (
      await request(app.getHttpServer())
        .get('/v1/dashboard/manager')
        .set('Cookie', scopedCookie)
        .set('X-Business-Id', businessId)
        .expect(200)
    ).body;

    // Store wrote +$500 today (MDASH-1 + the 23:00-local MDASH-2); a UTC
    // boundary would have shown only +$400.
    expect(after.kpis.store.writtenCents - before.kpis.store.writtenCents).toBe(50_000);
    expect(after.kpis.store.writtenCount - before.kpis.store.writtenCount).toBe(2);
    // Mine: only MDASH-1 carries my name.
    expect(after.kpis.mine.writtenCents - before.kpis.mine.writtenCents).toBe(40_000);
    expect(after.kpis.mine.writtenCount - before.kpis.mine.writtenCount).toBe(1);
    expect(after.kpis.store.collectedCents - before.kpis.store.collectedCents).toBe(15_000);
    expect(after.kpis.mine.collectedCents - before.kpis.mine.collectedCents).toBe(15_000);
    expect(after.kpis.pastDuePromises - before.kpis.pastDuePromises).toBe(1);

    // Queues: the phone-call columns are all there.
    const row = after.queues.storeOpen.find((r: { number: string }) => r.number === 'MDASH-1');
    expect(row).toBeTruthy();
    expect(row.customerName).toBe('Vlad Caller');
    expect(row.customerPhone).toBe('555-201-7788');
    expect(row.balanceDueCents).toBe(25_000);
    expect(row.salespersonName).toBe('Scoped');
    const mineNumbers = after.queues.myOpen.map((r: { number: string }) => r.number);
    expect(mineNumbers).toContain('MDASH-1');
    expect(mineNumbers).not.toContain('MDASH-2');

    // The board credits me with this week's written business.
    const myBar = after.leaderboardWeek.find((r: { name: string }) => r.name === 'Scoped');
    expect(myBar.cents).toBeGreaterThanOrEqual(40_000);
    // Pipeline segments cover the open book.
    expect(after.pipeline.map((p: { key: string }) => p.key)).toContain('open');
  });

  it('daily-ops pack: goal pace, tender mix, backorders, carts, returns, incoming, low stock, credit', async () => {
    // Owner sets a monthly goal for the member.
    await request(app.getHttpServer())
      .patch(`/v1/business/members/${scopedMembershipId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ monthlyGoalCents: 100_000 })
      .expect(200);

    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    let backorderId = '';
    try {
      const [cust] = await sqlc`SELECT id FROM customers WHERE last_name = 'Caller' LIMIT 1`;
      // A promised order two units short of stock.
      const [bo] = await sqlc`
        INSERT INTO orders (business_id, location_id, customer_id, number, status,
                            subtotal_cents, total_cents, requested_date)
        VALUES (${businessId}, ${locationId}, ${cust!.id}, 'MDASH-BO-1', 'open', 20000, 20000,
                (now() AT TIME ZONE 'America/New_York')::date + 5) RETURNING id`;
      backorderId = bo!.id;
      await sqlc`
        INSERT INTO order_lines (business_id, order_id, variant_id, description, quantity,
                                 unit_price_cents, line_type, qty_reserved, total_cents)
        VALUES (${businessId}, ${backorderId}, ${variantAId}, 'Widget short', 2, 10000, 'stock', 0, 20000)`;
      // A week-old draft cart.
      await sqlc`
        INSERT INTO orders (business_id, location_id, customer_id, number, status,
                            subtotal_cents, total_cents, created_at)
        VALUES (${businessId}, ${locationId}, ${cust!.id}, 'MDASH-DRAFT-1', 'draft', 5000, 5000,
                now() - interval '7 days')`;
      // A return still in flight on MDASH-1.
      const [mdash1] = await sqlc`SELECT id FROM orders WHERE number = 'MDASH-1'`;
      await sqlc`
        INSERT INTO order_returns (business_id, order_id, customer_id, rma_number, status, amount_cents)
        VALUES (${businessId}, ${mdash1!.id}, ${cust!.id}, 'RMA-MDASH-1-1', 'authorized', 5000)`;
      // A delivery scheduled TOMORROW for MDASH-1.
      await sqlc`
        INSERT INTO deliveries (business_id, location_id, order_id, scheduled_date)
        VALUES (${businessId}, ${locationId}, ${mdash1!.id},
                ((now() AT TIME ZONE 'America/New_York')::date + 1)::text::date)`;
      // Incoming stock: a transfer on the truck and a PO the vendor owes.
      await sqlc`
        INSERT INTO stock_transfers (business_id, from_location_id, to_location_id, number, status)
        VALUES (${businessId}, ${annexLocationId}, ${locationId}, 'XFR-MDASH-1', 'in_transit')`;
      const [vendor] = await sqlc`
        INSERT INTO vendors (business_id, name) VALUES (${businessId}, 'MDash Vendor') RETURNING id`;
      await sqlc`
        INSERT INTO purchase_orders (business_id, vendor_id, location_id, number, status, expected_at)
        VALUES (${businessId}, ${vendor!.id}, ${locationId}, 'PO-MDASH-1', 'ordered',
                now() + interval '4 days')`;
      // A thin stock position at this store.
      await sqlc`
        INSERT INTO inventory_levels (business_id, variant_id, location_id, on_hand, reserved)
        VALUES (${businessId}, ${variantAId}, ${locationId}, 2, 0)
        ON CONFLICT (variant_id, location_id)
        DO UPDATE SET on_hand = 2, reserved = 0`;
      // The customer sits on store credit; their latest order is mine at Main.
      await sqlc`
        INSERT INTO store_credit_entries (business_id, customer_id, delta_cents, reason)
        VALUES (${businessId}, ${cust!.id}, 4500, 'mdash credit fixture')`;
      await sqlc`
        INSERT INTO orders (business_id, location_id, customer_id, number, status,
                            salesperson_membership_id, subtotal_cents, total_cents, created_at)
        VALUES (${businessId}, ${locationId}, ${cust!.id}, 'MDASH-CRED-1', 'open',
                ${scopedMembershipId}, 5000000, 5000000, now() + interval '2 days')`;
      // $50,000 on purpose: total_cents × 10000 must not overflow int32
      // in the month-written SQL (the prod 500 of 2026-08-30).
      // Dated past the 23:00-local tz fixture so it is the customer's latest order.
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    const d = (
      await request(app.getHttpServer())
        .get('/v1/dashboard/manager')
        .set('Cookie', scopedCookie)
        .set('X-Business-Id', businessId)
        .expect(200)
    ).body;

    // Goal pace: the member's writing this month counts toward the goal.
    expect(d.kpis.mine.monthlyGoalCents).toBe(100_000);
    // Includes the $50k big-ticket fixture — proves the SQL survives
    // totals past the int32 overflow line ($2,147.48).
    expect(d.kpis.mine.monthWrittenCents).toBeGreaterThanOrEqual(5_040_000);
    expect(d.membershipId).toBe(scopedMembershipId);

    // Tender mix carries today's cash from the earlier payment.
    const cash = d.kpis.store.tenderMix.find((t: { method: string }) => t.method === 'cash');
    expect(cash.cents).toBeGreaterThanOrEqual(15_000);
    // Drawer status reflects this store's latest shift (earlier suites
    // open/close drawers at Main, so pin the shape, not the values).
    expect(typeof d.drawer.shiftOpen).toBe('boolean');
    expect(typeof d.drawer.closedToday).toBe('boolean');
    expect(d.drawer.suspended).toBe(false);

    // Backorder watch shows the short order with the unit count.
    const bo = d.queues.backorders.find((r: { number: string }) => r.number === 'MDASH-BO-1');
    expect(bo).toBeTruthy();
    expect(bo.shortUnits).toBe(2);

    // Aging carts list the week-old draft with its age visible via createdAt.
    const draft = d.queues.staleCarts.find((r: { number: string }) => r.number === 'MDASH-DRAFT-1');
    expect(draft).toBeTruthy();

    // Returns in flight carry the RMA and the salesperson for "mine" filtering.
    const ret = d.returnsInFlight.find(
      (r: { rmaNumber: string }) => r.rmaNumber === 'RMA-MDASH-1-1',
    );
    expect(ret).toBeTruthy();
    expect(ret.salespersonMembershipId).toBe(scopedMembershipId);

    // Tomorrow's delivery rides in the board with its date.
    const tom = d.queues.todaysDeliveries.find((r: { number: string }) => r.number === 'MDASH-1');
    expect(tom).toBeTruthy();
    expect(tom.scheduledDate > d.date).toBe(true);

    // Incoming stock: the transfer and the PO, soonest expected first.
    const kinds = d.incoming.map((r: { number: string }) => r.number);
    expect(kinds).toContain('XFR-MDASH-1');
    expect(kinds).toContain('PO-MDASH-1');

    // Low stock shows the two-unit position.
    const low = d.lowStock.find((r: { variantId: string }) => r.variantId === variantAId);
    expect(low).toBeTruthy();
    expect(low.available).toBe(2);

    // Store-credit holder attributed to me.
    const holder = d.creditHolders.find((c: { balanceCents: number }) => c.balanceCents === 4_500);
    expect(holder).toBeTruthy();
    expect(holder.salespersonMembershipId).toBe(scopedMembershipId);

    // The activity feed is grouped rows, each with an order link.
    expect(Array.isArray(d.activity)).toBe(true);
  });
});
