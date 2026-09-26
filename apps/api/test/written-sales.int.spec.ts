/**
 * Report Written Sales Dollars (STORIS TE.320, owner 2026-09-02).
 *
 * Location → type → order → line, with merchandise, cost, gross profit and
 * profit %, then charges / misc fee / sales tax /
 * total order, totalled per order, type, location and grand. Order Type
 * both / orders / adjustments, Report Type detail / summary, the three
 * include flags, the store filter, profit masking without
 * reports.financial.view, and CSV export.
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
  WrittenLocationGroup,
  WrittenSalesReport,
  WrittenTypeGroup,
} from '../src/reports/written-sales.controller';

const TEST_DB_URL =
  process.env.WRITTEN_SALES_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_written_sales';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'WrittenPass!2026x';
const TZ = 'America/Los_Angeles';

let app: INestApplication;
let businessId = '';
let aStoreId = '';
let bStoreId = '';
let ownerCookie = '';
let analystCookie = '';
let cashierCookie = '';
let day = '';
let earlier = '';

const localDay = (minusDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
    new Date(Date.now() - minusDays * 86_400_000),
  );

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
  day = localDay(0);
  earlier = localDay(10);
  await withDb(async (db) => {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'written-test', name: 'Written Test Co', status: 'active' })
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
    // A sales-only analyst: sees the report, never the cost side.
    const [analystRole] = await db
      .insert(schema.roles)
      .values({ businessId, name: 'Analyst', description: 'Sales reports only' })
      .returning();
    roles.set('Analyst', analystRole!.id);
    await db
      .insert(schema.rolePermissions)
      .values([{ roleId: analystRole!.id, permission: 'reports.sales.view' }]);

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
    await makeUser('owner@written-test.local', 'Olive Owner', 'Owner');
    await makeUser('analyst@written-test.local', 'Ana Lyst', 'Analyst');
    const bf = await makeUser('bf@written-test.local', 'Ben Franklin', 'Cashier');
    const gc = await makeUser('gc@written-test.local', 'Grace Chen', 'Cashier');

    const locs = await db
      .insert(schema.locations)
      .values([
        { businessId, name: '201 Western', timezone: TZ },
        { businessId, name: 'Hancock Park', timezone: TZ },
      ])
      .returning();
    aStoreId = locs[0]!.id;
    bStoreId = locs[1]!.id;

    const [p] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'BBAUR13F', name: 'E King Aurora' })
      .returning();
    const [king] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p!.id,
        sku: 'BBAUR13F_FP-7680',
        priceCents: 170_000,
        costCents: 64_000,
      })
      .returning();
    const [fee] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p!.id,
        sku: 'RECYCLINGFEE',
        priceCents: 1_800,
        costCents: 650,
      })
      .returning();

    const [abe] = await db
      .insert(schema.customers)
      .values({
        businessId,
        firstName: 'Abe',
        lastName: 'Clements',
        phone: '323-555-0198',
        addressesJson: [
          { line1: '644 N. Gramercy Pl.', city: 'Los Angeles', region: 'CA', postalCode: '90004' },
        ],
      })
      .returning();

    type OrderOver = Partial<typeof schema.orders.$inferInsert>;
    const mkOrder = async (
      over: OrderOver,
      lines: {
        variantId: string;
        description: string;
        quantity: number;
        totalCents: number;
        taxCents?: number;
        createdAt?: Date;
      }[],
    ) => {
      const [o] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: aStoreId,
          number: `SO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          status: 'open',
          customerId: abe!.id,
          salespersonMembershipId: bf.membershipId,
          subtotalCents: lines.reduce((s, l) => s + l.totalCents, 0),
          totalCents: lines.reduce((s, l) => s + l.totalCents + (l.taxCents ?? 0), 0),
          taxCents: lines.reduce((s, l) => s + (l.taxCents ?? 0), 0),
          ...over,
        })
        .returning();
      for (const l of lines) {
        await db.insert(schema.orderLines).values({
          businessId,
          orderId: o!.id,
          variantId: l.variantId,
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: Math.round(l.totalCents / Math.max(l.quantity, 1)),
          totalCents: l.totalCents,
          taxCents: l.taxCents ?? 0,
          lineType: 'stock',
          createdAt: l.createdAt ?? o!.createdAt,
        });
      }
      return o!;
    };

    // O1: today at 201 Western, two lines, $165.75 tax, second salesperson.
    await mkOrder(
      {
        number: '01108587',
        createdAt: atLocal(day, '11:09'),
        secondSalespersonMembershipId: gc.membershipId,
        marketingCode: 'LABOR-DAY-TV',
        addressLine1: '644 N. Gramercy Pl.',
        addressCity: 'Los Angeles',
        addressRegion: 'CA',
        addressPostalCode: '90004',
        notes: 'Leave at side door',
        deliveryFeeCents: 0,
      },
      [
        {
          variantId: king!.id,
          description: 'E KING AURO',
          quantity: 1,
          totalCents: 170_000,
          taxCents: 16_575,
        },
        { variantId: fee!.id, description: 'RECYCLING F', quantity: 1, totalCents: 1_800 },
      ],
    );
    // O2: layaway today at Hancock Park with a delivery fee and order discount.
    await mkOrder(
      {
        number: '03108590',
        locationId: bStoreId,
        orderKind: 'layaway',
        createdAt: atLocal(day, '12:35'),
        deliveryFeeCents: 9_900,
        orderDiscountCents: 5_000,
        totalCents: 100_000 + 9_900 - 5_000,
        subtotalCents: 100_000,
      },
      [{ variantId: king!.id, description: 'FULL COBALT', quantity: 1, totalCents: 100_000 }],
    );
    // O3: written 10 days ago at 201 Western; $200 price adjustment today.
    const o3 = await mkOrder({ number: '01108500', createdAt: atLocal(earlier, '10:00') }, [
      { variantId: king!.id, description: 'E KING AURO', quantity: 1, totalCents: 170_000 },
    ]);
    await db.insert(schema.auditLogs).values({
      businessId,
      actorType: 'user',
      action: 'order.price_adjustment',
      targetType: 'order',
      targetId: o3.id,
      changesJson: {
        after: { amountCents: 20_000, refundMethod: 'original', reason: 'Price match' },
      },
      createdAt: atLocal(day, '15:00'),
    });
    // O3 also gets a line added today (an add-on after the write).
    await db.insert(schema.orderLines).values({
      businessId,
      orderId: o3.id,
      variantId: fee!.id,
      description: 'RECYCLING F',
      quantity: 2,
      unitPriceCents: 1_800,
      totalCents: 3_600,
      lineType: 'stock',
      createdAt: atLocal(day, '15:30'),
    });
    // O4: written 10 days ago at Hancock Park, cancelled today.
    await mkOrder(
      {
        number: '03108400',
        locationId: bStoreId,
        status: 'cancelled',
        createdAt: atLocal(earlier, '09:00'),
        cancelledAt: atLocal(day, '16:00'),
      },
      [
        {
          variantId: king!.id,
          description: 'FULL SMOKEY',
          quantity: 1,
          totalCents: 50_000,
          taxCents: 4_875,
        },
      ],
    );
    // D-1: a draft written 10 days ago, retired today when the register
    // re-saved it (cancel audit keeps before.status = draft). Never a
    // written sale, so its cancellation takes nothing back.
    const d1 = await mkOrder(
      {
        number: 'D-1',
        locationId: bStoreId,
        status: 'cancelled',
        createdAt: atLocal(earlier, '09:15'),
        cancelledAt: atLocal(day, '16:30'),
      },
      [{ variantId: king!.id, description: 'DRAFT COPY', quantity: 1, totalCents: 183_400 }],
    );
    await db.insert(schema.auditLogs).values({
      businessId,
      actorType: 'user',
      action: 'order.cancel',
      targetType: 'order',
      targetId: d1.id,
      changesJson: {
        before: { status: 'draft' },
        after: { status: 'cancelled', reason: 'superseded by completed New Sale' },
      },
      createdAt: atLocal(day, '16:30'),
    });
    // Quote and imported orders are never written sales.
    await mkOrder({ number: 'Q-1', status: 'quote', createdAt: atLocal(day, '09:00') }, [
      { variantId: king!.id, description: 'QUOTE', quantity: 1, totalCents: 999_999 },
    ]);
    await mkOrder(
      { number: 'LEGACY-1', importedAt: new Date(), createdAt: atLocal(day, '09:30') },
      [{ variantId: king!.id, description: 'LEGACY', quantity: 1, totalCents: 888_888 }],
    );
    // A register sale today at 201 Western by Grace.
    const [sale] = await db
      .insert(schema.sales)
      .values({
        businessId,
        locationId: aStoreId,
        number: 'S-0001',
        status: 'completed',
        customerId: abe!.id,
        associateUserId: gc.userId,
        subtotalCents: 1_800,
        taxCents: 175,
        totalCents: 1_975,
        completedAt: atLocal(day, '13:05'),
        createdAt: atLocal(day, '13:05'),
      })
      .returning();
    await db.insert(schema.saleLines).values({
      businessId,
      saleId: sale!.id,
      variantId: fee!.id,
      description: 'RECYCLING F',
      quantity: 1,
      unitPriceCents: 1_800,
      totalCents: 1_800,
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
    .get('/v1/reports/written-sales')
    .query({ start: day, end: day, ...query })
    .set('Cookie', cookie)
    .set('x-business-id', businessId);
}

function loc(r: WrittenSalesReport, name: string): WrittenLocationGroup {
  const g = r.locations.find((l) => l.locationName === name);
  if (!g) throw new Error(`no location ${name}: ${r.locations.map((l) => l.locationName)}`);
  return g;
}
function type(l: WrittenLocationGroup, key: WrittenTypeGroup['key']): WrittenTypeGroup {
  const t = l.types.find((x) => x.key === key);
  if (!t) throw new Error(`no type ${key} in ${l.locationName}: ${l.types.map((x) => x.key)}`);
  return t;
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'written-test-secret-written-test-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  ownerCookie = await captureCookie('owner@written-test.local');
  analystCookie = await captureCookie('analyst@written-test.local');
  cashierCookie = await captureCookie('bf@written-test.local');
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('Report Written Sales Dollars', () => {
  it('needs reports.sales.view', async () => {
    await get({}, cashierCookie).expect(403);
  });

  it('lists locations → types → orders → lines with the STORIS columns and totals', async () => {
    const r = (await get().expect(200)).body as WrittenSalesReport;
    expect(r.reportType).toBe('detail');
    expect(r.orderType).toBe('both');
    expect(r.canSeeProfit).toBe(true);
    expect(r.locations.map((l) => l.locationName)).toEqual(['201 Western', 'Hancock Park']);

    const western = loc(r, '201 Western');
    expect(western.types.map((t) => t.key)).toEqual(['orders', 'register', 'adjustments']);
    const orders = type(western, 'orders');
    expect(orders.label).toBe('New Transactions excluding Layaway');
    expect(orders.documents).toHaveLength(1);
    const o1 = orders.documents[0]!;
    expect(o1).toMatchObject({
      documentType: 'order',
      number: '01108587',
      date: day,
      time: '11:09',
      customerName: 'CLEMENTS ABE',
      customerPhone: '323-555-0198',
      salespeople: ['Ben Franklin', 'Grace Chen'],
      marketingCode: 'LABOR-DAY-TV',
      address: '644 N. GRAMERCY PL., LOS ANGELES, CA 90004',
      comments: [],
    });
    expect(o1.lines.map((l) => [l.quantity, l.productNumber, l.merchCents, l.profitCents])).toEqual(
      [
        [1, 'BBAUR13F_FP-7680', 170_000, 106_000],
        [1, 'RECYCLINGFEE', 1_800, 1_150],
      ],
    );
    expect(o1.lines[0]!.profitPct).toBe(62.4);
    expect(o1.lines[0]!.enteredBy).toBe('BF');
    expect(o1.totals).toEqual({
      merchCents: 171_800,
      profitCents: 107_150,
      profitPct: 62.4,
      chargesCents: 0,
      discountCents: 0,
      miscFeeCents: 0,
      taxCents: 16_575,
      totalCents: 188_375,
      documents: 1,
    });
    expect(orders.totals.totalCents).toBe(188_375);
    // No quote, no imported order.
    expect(orders.documents.map((d) => d.number)).not.toContain('Q-1');
    expect(JSON.stringify(r)).not.toContain('LEGACY-1');

    const register = type(western, 'register');
    expect(register.documents[0]).toMatchObject({
      documentType: 'sale',
      number: 'S-0001',
      time: '13:05',
      salespeople: ['Grace Chen'],
    });
    expect(register.totals).toMatchObject({ merchCents: 1_800, taxCents: 175, totalCents: 1_975 });

    const hancock = loc(r, 'Hancock Park');
    const layaway = type(hancock, 'layaway');
    expect(layaway.documents[0]!.number).toBe('03108590');
    expect(layaway.totals).toMatchObject({
      merchCents: 100_000,
      chargesCents: 9_900,
      discountCents: 5_000,
      totalCents: 104_900,
    });

    // Location and grand totals roll up every type.
    expect(western.totals.merchCents).toBe(171_800 + 1_800 - 20_000 + 3_600);
    expect(r.totals.documents).toBe(6);
    expect(r.totals.totalCents).toBe(188_375 + 1_975 - 20_000 + 3_600 + 104_900 - (50_000 + 4_875));
  });

  it('reports adjustments: price adjustments, lines added later, cancellations', async () => {
    const r = (await get({ orderType: 'adjustments' }).expect(200)).body as WrittenSalesReport;
    const western = loc(r, '201 Western');
    expect(western.types.map((t) => t.key)).toEqual(['adjustments']);
    const adj = type(western, 'adjustments');
    expect(adj.label).toBe('ADJUSTMENT');
    const kinds = adj.documents.map((d) => [d.number, d.adjustmentKind, d.totals.merchCents]);
    expect(kinds).toEqual([
      ['01108500', 'price_adjustment', -20_000],
      ['01108500', 'lines_added', 3_600],
    ]);
    expect(adj.documents[0]!.adjustmentReason).toBe('Price match');
    expect(adj.documents[0]!.time).toBe('15:00');
    expect(adj.documents[1]!.lines[0]).toMatchObject({
      quantity: 2,
      productNumber: 'RECYCLINGFEE',
    });
    expect(adj.totals.merchCents).toBe(-16_400);

    const hancock = loc(r, 'Hancock Park');
    // Only the written order's cancellation; the retired draft D-1 is absent.
    expect(type(hancock, 'adjustments').documents.map((d) => d.number)).toEqual(['03108400']);
    const cancel = type(hancock, 'adjustments').documents[0]!;
    expect(cancel).toMatchObject({
      number: '03108400',
      adjustmentKind: 'cancellation',
      time: '16:00',
    });
    expect(cancel.totals).toMatchObject({
      merchCents: -50_000,
      profitCents: -(50_000 - 64_000),
      taxCents: -4_875,
      totalCents: -54_875,
    });

    const ordersOnly = (await get({ orderType: 'orders' }).expect(200)).body as WrittenSalesReport;
    expect(ordersOnly.locations.flatMap((l) => l.types.map((t) => t.key))).not.toContain(
      'adjustments',
    );
  });

  it('summary drops the rows but keeps every total; filters and flags apply', async () => {
    const s = (await get({ reportType: 'summary' }).expect(200)).body as WrittenSalesReport;
    expect(s.reportType).toBe('summary');
    for (const l of s.locations) for (const t of l.types) expect(t.documents).toEqual([]);
    expect(s.totals.documents).toBe(6);
    expect(loc(s, '201 Western').totals.merchCents).toBe(171_800 + 1_800 - 20_000 + 3_600);

    const one = (await get({ locationId: bStoreId }).expect(200)).body as WrittenSalesReport;
    expect(one.locations.map((l) => l.locationName)).toEqual(['Hancock Park']);
    const both = (await get({ locationId: `${aStoreId},${bStoreId}` }).expect(200))
      .body as WrittenSalesReport;
    expect(both.locations).toHaveLength(2);

    const flags = (
      await get({
        includeAuditComments: 'true',
        includeAllSalespeople: 'false',
        includeAddress: 'false',
      }).expect(200)
    ).body as WrittenSalesReport;
    const o1 = type(loc(flags, '201 Western'), 'orders').documents[0]!;
    expect(o1.salespeople).toEqual(['Ben Franklin']);
    expect(o1.address).toBeNull();
    expect(o1.comments).toEqual(['Note: Leave at side door']);

    // Nothing written in a window before the fixtures.
    const empty = (await get({ start: '2020-01-01', end: '2020-01-02' }).expect(200))
      .body as WrittenSalesReport;
    expect(empty.locations).toEqual([]);
    expect(empty.totals.totalCents).toBe(0);
  });

  it('masks profit without reports.financial.view', async () => {
    const r = (await get({}, analystCookie).expect(200)).body as WrittenSalesReport;
    expect(r.canSeeProfit).toBe(false);
    const o1 = type(loc(r, '201 Western'), 'orders').documents[0]!;
    expect(o1.lines[0]!.profitCents).toBeNull();
    expect(o1.lines[0]!.profitPct).toBeNull();
    expect(o1.totals.profitCents).toBeNull();
    expect(o1.totals.merchCents).toBe(171_800);
    expect(r.totals.profitCents).toBeNull();
    const csv = await get({ format: 'csv' }, analystCookie).expect(200);
    expect(csv.text).toContain('E KING AURO,1700.00,,,,');
    expect(csv.text).not.toContain('1700.00,640.00');
  });

  it('exports CSV', async () => {
    const res = await get({ format: 'csv' }).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(`written-sales-${day}-to-${day}.csv`);
    expect(res.text).toContain('Location,Type,Order number,Order date');
    expect(res.text).toContain('Merch amount,Cost,Gross profit,Profit pct,Charges,Misc fee');
    expect(res.text).not.toContain('Customer discount');
    expect(res.text).toContain('E KING AURO,1700.00,640.00,1060.00,62.4');
    expect(res.text).toContain('RECYCLING F,36.00,13.00,23.00');
    expect(res.text).toContain('Order cancelled,-500.00,-640.00,140.00');
    expect(res.text).toContain('Price adjustment — Price match,-200.00,0.00,-200.00');
    expect(res.text).toContain('201 Western,New Transactions excluding Layaway,01108587');
    expect(res.text).toContain('Total for order 01108587');
    expect(res.text).toContain('Grand total');
    const grand = res.text.split('\r\n').find((row: string) => row.startsWith('Grand total,'))!;
    expect(res.text).toContain('Customer name,Customer phone,Salespeople');
    expect(res.text).toContain('CLEMENTS ABE,323-555-0198,"Ben Franklin, Grace Chen"');
    expect(grand.split(',').slice(14, 17)).toEqual(['2072.00', '666.00', '1406.00']);
    const summary = await get({ format: 'csv', reportType: 'summary' }).expect(200);
    expect(summary.text).toContain(grand);
  });
});
