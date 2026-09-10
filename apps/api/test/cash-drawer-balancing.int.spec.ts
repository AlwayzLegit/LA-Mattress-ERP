/**
 * Report Cash Drawer Balancing Totals (STORIS AR.317, owner 2026-09-02).
 *
 * Every tender in the balance-date window lands under its store /
 * operator / drawer, then pay class and payment type, with the register
 * columns STORIS prints (customer code + name, reference, tender ref,
 * amount, reference subtotal, time, drawer, operator initials), the
 * grand total and the Cash Drawer Reconciliation (cash + check =
 * deposit). Starting/ending time, store, operator, drawer and the
 * balanced/unbalanced drawer reference all narrow the register; imported
 * and pending money never appears; CSV export mirrors the JSON.
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
import type {
  BalanceGroup,
  CashDrawerBalancingReport,
} from '../src/reports/cash-drawer-balancing.controller';

const TEST_DB_URL =
  process.env.CASH_DRAWER_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_cash_drawer';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'DrawerPass!2026x';
const TZ = 'America/Los_Angeles';

let app: INestApplication;
let businessId = '';
let aStoreId = '';
let bStoreId = '';
let erinUserId = '';
let gusUserId = '';
let gusMembershipId = '';
let ownerCookie = '';
let cashierCookie = '';
let saleNumber = '';
let orderNumber = '';
let shift1Id = '';
let shift2Id = '';
let day = '';

const localDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

/** The UTC instant of `hm` on `day` in the store's timezone. */
function atLocal(dayStr: string, hm: string): Date {
  const [y, m, d] = dayStr.split('-').map(Number) as [number, number, number];
  const [h, mi] = hm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const localMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
  );
  return new Date(guess - (localMs - guess));
}

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
  day = localDay();
  await withDb(async (db) => {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({
        slug: 'drawer-test',
        name: 'Drawer Test Co',
        status: 'active',
        opsSettingsJson: { cashBalancing: { toleranceCents: 500, maxAttempts: 3 } },
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
    async function makeUser(email: string, name: string, role: string) {
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
        })
        .returning();
      return { userId: u!.id, membershipId: m!.id };
    }
    await makeUser('owner@drawer-test.local', 'Olive Owner', 'Owner');
    const erin = await makeUser('erin@drawer-test.local', 'Erin Miller', 'Cashier');
    erinUserId = erin.userId;
    const gus = await makeUser('gus@drawer-test.local', 'Gus Park', 'Cashier');
    gusUserId = gus.userId;
    gusMembershipId = gus.membershipId;

    const locs = await db
      .insert(schema.locations)
      .values([
        { businessId, name: 'A Store', timezone: TZ, orderPrefix: '02' },
        { businessId, name: 'B Store', timezone: TZ, orderPrefix: '05' },
      ])
      .returning();
    aStoreId = locs[0]!.id;
    bStoreId = locs[1]!.id;

    const [p] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'DR-MAT', name: 'Drawer Mattress' })
      .returning();
    const [v] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p!.id,
        sku: 'DR-MAT-Q',
        priceCents: 50_000,
        costCents: 20_000,
      })
      .returning();
    const [cust] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Abe', lastName: 'Clements', phone: '3105550100' })
      .returning();
    // Abe came over from STORIS as customer 02108572 (D7 identity map).
    await db.insert(schema.legacyRefs).values({
      businessId,
      entity: 'customer',
      legacyId: '02108572',
      jetnineId: cust!.id,
    });

    // Drawer 1: Erin at A Store, balanced (closed) at 17:00, on the money.
    const [s1] = await db
      .insert(schema.cashShifts)
      .values({
        businessId,
        locationId: aStoreId,
        openedByUserId: erinUserId,
        openedAt: atLocal(day, '09:00'),
        closedAt: atLocal(day, '17:00'),
        openingFloatCents: 15_000,
        expectedCashCents: 35_000,
        countedCashCents: 35_000,
        varianceCents: 0,
      })
      .returning();
    shift1Id = s1!.id;
    // Drawer 2: Gus at B Store, still open.
    const [s2] = await db
      .insert(schema.cashShifts)
      .values({
        businessId,
        locationId: bStoreId,
        openedByUserId: gusUserId,
        openedAt: atLocal(day, '09:30'),
        openingFloatCents: 10_000,
      })
      .returning();
    shift2Id = s2!.id;

    const pay = (over: Partial<typeof schema.payments.$inferInsert>) =>
      db.insert(schema.payments).values({
        businessId,
        method: 'card',
        status: 'succeeded',
        amountCents: 0,
        ...over,
      });

    // Register sale at A Store by Erin: $200 cash + $300 card.
    const [sale] = await db
      .insert(schema.sales)
      .values({
        businessId,
        locationId: aStoreId,
        number: 'S-DR-001',
        status: 'completed',
        customerId: cust!.id,
        associateUserId: erinUserId,
        subtotalCents: 50_000,
        totalCents: 50_000,
        completedAt: atLocal(day, '10:30'),
        createdAt: atLocal(day, '10:30'),
      })
      .returning();
    saleNumber = sale!.number;
    await db.insert(schema.saleLines).values({
      businessId,
      saleId: sale!.id,
      variantId: v!.id,
      description: 'Drawer Mattress',
      quantity: 1,
      unitPriceCents: 50_000,
      totalCents: 50_000,
    });
    await pay({
      saleId: sale!.id,
      method: 'cash',
      amountCents: 20_000,
      createdAt: atLocal(day, '10:30'),
    });
    await pay({
      saleId: sale!.id,
      method: 'card',
      processor: 'stripe',
      processorRef: 'ch_123',
      amountCents: 30_000,
      createdAt: atLocal(day, '10:31'),
    });

    // Order at B Store by Gus: $150 check deposit + $500 financing.
    const [order] = await db
      .insert(schema.orders)
      .values({
        businessId,
        locationId: bStoreId,
        number: 'SO-DR-001',
        status: 'open',
        customerId: cust!.id,
        salespersonMembershipId: gusMembershipId,
        subtotalCents: 65_000,
        totalCents: 65_000,
        createdAt: atLocal(day, '14:00'),
      })
      .returning();
    orderNumber = order!.number;
    await pay({
      orderId: order!.id,
      kind: 'deposit',
      method: 'check',
      processorRef: 'CHK 1042',
      amountCents: 15_000,
      createdAt: atLocal(day, '14:05'),
    });
    await pay({
      orderId: order!.id,
      kind: 'deposit',
      method: 'financing',
      financingProvider: 'synchrony',
      financingRef: 'SYN-9',
      amountCents: 50_000,
      createdAt: atLocal(day, '14:06'),
    });
    // Pending money never balances a drawer.
    await pay({ orderId: order!.id, kind: 'deposit', status: 'pending', amountCents: 12_345 });

    // D8: an imported legacy order's cash never touched this drawer.
    const [legacy] = await db
      .insert(schema.orders)
      .values({
        businessId,
        locationId: aStoreId,
        number: 'SO-LEGACY-1',
        status: 'open',
        customerId: cust!.id,
        subtotalCents: 99_900,
        totalCents: 99_900,
        importedAt: new Date(),
        createdAt: atLocal(day, '11:00'),
      })
      .returning();
    await pay({
      orderId: legacy!.id,
      method: 'cash',
      amountCents: 99_900,
      createdAt: atLocal(day, '11:00'),
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

function get(query: Record<string, string> = {}, cookie = ownerCookie) {
  return request(app.getHttpServer())
    .get('/v1/reports/cash-drawer-balancing')
    .query({ start: day, end: day, ...query })
    .set('Cookie', cookie)
    .set('x-business-id', businessId);
}

function group(report: CashDrawerBalancingReport, label: string): BalanceGroup {
  const g = report.groups.find((x) => x.label === label);
  if (!g) throw new Error(`no group ${label}: ${report.groups.map((x) => x.label).join(', ')}`);
  return g;
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'drawer-test-secret-drawer-test-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  ownerCookie = await captureCookie('owner@drawer-test.local');
  cashierCookie = await captureCookie('erin@drawer-test.local');
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('Report Cash Drawer Balancing Totals', () => {
  it('needs reports.sales.view', async () => {
    await get({}, cashierCookie).expect(403);
  });

  it('balances by store: pay classes, payment types, register columns, reconciliation', async () => {
    const res = await get().expect(200);
    const report = res.body as CashDrawerBalancingReport;
    expect(report.balanceBy).toBe('store');
    expect(report.range).toEqual({ start: day, end: day, startTime: '00:00', endTime: '23:59' });
    expect(report.toleranceCents).toBe(500);
    expect(report.groups.map((g) => g.label)).toEqual(['A Store', 'B Store']);
    expect(report.count).toBe(4);
    expect(report.amountCents).toBe(115_000);
    expect(report.reconciliation).toEqual({
      cashCents: 20_000,
      checkCents: 15_000,
      depositCents: 35_000,
    });

    const a = group(report, 'A Store');
    expect(a.amountCents).toBe(50_000);
    expect(a.payClasses.map((c) => `${c.code} - ${c.label}`)).toEqual(['1 - CASH', '3 - CREDIT']);
    const credit = a.payClasses[1]!;
    expect(credit.paymentTypes).toHaveLength(1);
    const card = credit.paymentTypes[0]!;
    expect(card.label).toBe('CARD - STRIPE');
    expect(card.amountCents).toBe(30_000);
    const line = card.lines[0]!;
    expect(line).toMatchObject({
      documentType: 'sale',
      reference: saleNumber,
      customerName: 'CLEMENTS ABE',
      tenderRef: 'ch_123',
      amountCents: 30_000,
      referenceSubtotalCents: 50_000,
      day,
      time: '10:31',
      drawerId: shift1Id,
      drawerNumber: shift1Id.slice(0, 8).toUpperCase(),
      operatorId: erinUserId,
      operatorInitials: 'EM',
    });
    expect(line.customerCode).toHaveLength(8);
    expect(a.reconciliation).toEqual({ cashCents: 20_000, checkCents: 0, depositCents: 20_000 });
    expect(a.drawers).toHaveLength(1);
    expect(a.drawers[0]).toMatchObject({
      id: shift1Id,
      status: 'balanced',
      operatorName: 'Erin Miller',
      openingFloatCents: 15_000,
      expectedCashCents: 35_000,
      countedCashCents: 35_000,
      varianceCents: 0,
      inTolerance: true,
    });

    const b = group(report, 'B Store');
    expect(b.amountCents).toBe(65_000);
    expect(b.payClasses.map((c) => c.label)).toEqual(['CHECK', 'FINANCING']);
    const check = b.payClasses[0]!.paymentTypes[0]!.lines[0]!;
    expect(check).toMatchObject({
      documentType: 'order',
      reference: orderNumber,
      tenderRef: 'CHK 1042',
      time: '14:05',
      drawerId: shift2Id,
      operatorInitials: 'GP',
      referenceSubtotalCents: 65_000,
    });
    expect(b.payClasses[1]!.paymentTypes[0]!.label).toBe('FINANCING - SYNCHRONY');
    expect(b.reconciliation).toEqual({ cashCents: 0, checkCents: 15_000, depositCents: 15_000 });
    expect(b.drawers).toHaveLength(1);
    expect(b.drawers[0]).toMatchObject({ id: shift2Id, status: 'open', inTolerance: null });
  });

  it('balances by operator and by drawer', async () => {
    const byOp = (await get({ balanceBy: 'operator' }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(byOp.groups.map((g) => [g.label, g.sublabel, g.amountCents])).toEqual([
      ['Erin Miller', 'EM', 50_000],
      ['Gus Park', 'GP', 65_000],
    ]);
    expect(group(byOp, 'Erin Miller').drawers.map((d) => d.id)).toEqual([shift1Id]);

    const byDrawer = (await get({ balanceBy: 'drawer' }).expect(200))
      .body as CashDrawerBalancingReport;
    const d1 = byDrawer.groups.find((g) => g.key === shift1Id)!;
    const d2 = byDrawer.groups.find((g) => g.key === shift2Id)!;
    expect(d1.label).toBe(`Drawer ${shift1Id.slice(0, 8).toUpperCase()}`);
    expect(d1.sublabel).toBe('A Store');
    expect(d1.amountCents).toBe(50_000);
    expect(d2.amountCents).toBe(65_000);
    expect(d1.drawers.map((d) => d.id)).toEqual([shift1Id]);
  });

  it('narrows by balanced / unbalanced drawer reference, store, operator and drawer', async () => {
    const balanced = (await get({ drawerState: 'balanced' }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(balanced.amountCents).toBe(50_000);
    expect(balanced.groups.map((g) => g.label)).toEqual(['A Store']);

    const unbalanced = (await get({ drawerState: 'unbalanced' }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(unbalanced.amountCents).toBe(65_000);

    const store = (await get({ locationId: bStoreId }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(store.amountCents).toBe(65_000);
    expect(store.filters.locationId).toBe(bStoreId);

    const operator = (await get({ operatorId: erinUserId }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(operator.amountCents).toBe(50_000);

    const drawer = (await get({ drawerId: shift1Id.slice(0, 8) }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(drawer.amountCents).toBe(50_000);
    expect(drawer.filters.drawerId).toBe(shift1Id.slice(0, 8));
  });

  it('applies starting and ending time in the store timezone (ending time inclusive)', async () => {
    const mid = (await get({ startTime: '10:31', endTime: '14:05' }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(mid.amountCents).toBe(45_000);
    expect(mid.range.startTime).toBe('10:31');

    const early = (await get({ endTime: '10:30' }).expect(200)).body as CashDrawerBalancingReport;
    expect(early.amountCents).toBe(20_000);

    const bad = (await get({ startTime: '25:99', start: 'nope', end: 'x' }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(bad.range.startTime).toBe('00:00');
    expect(bad.range.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('exports the register as CSV', async () => {
    const res = await get({ format: 'csv' }).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(
      `cash-drawer-balancing-${day}-to-${day}.csv`,
    );
    const text = res.text;
    expect(text).toContain('Group,Pay class,Payment type,Customer code');
    expect(text).toContain('CLEMENTS ABE');
    expect(text).toContain('3 - CREDIT,CARD - STRIPE');
    expect(text).toContain('Total deposit,,,,,,,350.00');
    expect(text).not.toContain('SO-LEGACY-1');
  });

  it('prints the STORIS customer number and store code', async () => {
    const report = (await get({ locationId: aStoreId }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(report.filters.locationCode).toBe('02');
    expect(report.filters.locationName).toBe('A Store');
    const a = group(report, 'A Store');
    expect(a.code).toBe('02');
    const line = a.payClasses.flatMap((pc) => pc.paymentTypes).flatMap((pt) => pt.lines)[0]!;
    expect(line.customerCode).toBe('02108572');
    const byOp = (await get({ balanceBy: 'operator', operatorId: erinUserId }).expect(200))
      .body as CashDrawerBalancingReport;
    expect(byOp.filters.operatorName).toBe('Erin Miller');
    expect(byOp.groups.map((g) => g.code)).toEqual(['EM']);
  });

  it('spools the STORIS Basic PDF and the same pages as text', async () => {
    const pdf = await get({ format: 'pdf', locationId: aStoreId })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(
      `cash-drawer-balancing-${day}-to-${day}.pdf`,
    );
    const raw = (pdf.body as Buffer).toString('latin1');
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw).toContain('/BaseFont /Courier');
    expect(raw).toContain('(Reference: AR.317.RPT');
    expect(raw).toContain('Total For Store 02:');

    const txt = await get({ format: 'txt', locationId: aStoreId }).expect(200);
    expect(txt.headers['content-type']).toContain('text/plain');
    const text = txt.text;
    const lines = text.split('\n');
    expect(lines[0]!.startsWith('Reference: AR.317.RPT')).toBe(true);
    expect(lines[0]!).toContain('-=- Drawer Test Co -=-');
    expect(lines[1]!).toContain('Report Cash Drawer Balancing Totals');
    expect(lines[1]!.endsWith('Page: 1')).toBe(true);
    expect(text).toContain('Store 02 - A STORE');
    expect(text).toContain('Pay Class 3 - CREDIT');
    expect(text).toContain('Payment Type CARD - STRIPE');
    expect(text).toMatch(/^02108572 {5}CLEMENTS ABE {17}/m);
    expect(text).toContain('Total For Payment Type CARD:');
    expect(text).toContain('Total For Pay Class 3:');
    expect(text).toContain('Total For Store 02:');
    expect(text).toContain('Grand Total  :');
    expect(text).toContain('Cash Drawer Reconciliation:');
    expect(text).toContain('Total Deposit');
    // The parameter page closes the spool.
    expect(text).toContain('\f');
    expect(text).toContain('   Balance By: S');
    expect(text).toContain('   Store: 02');
    expect(text).toContain('   Bal Drawer Ref: All');
    expect(text).not.toContain('SO-LEGACY-1');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(132);
  });
});
