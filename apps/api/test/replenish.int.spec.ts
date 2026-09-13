/**
 * Amendment A22 slice 4 — STORIS "Replenish Inventory": Allocated order
 * and Stock level replenishment across every vendor, the options
 * (fulfillment statuses, floor samples, returns, carton rounding) and
 * Create purchase orders (one PO per vendor + location, special-order
 * allocations).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { eq, inArray } from 'drizzle-orm';
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
  process.env.REPLENISH_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_replenish';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'ReplenPass!2026';

let app: INestApplication;
let businessId = '';
let ownerCookie = '';
let cashierCookie = '';
let warehouseId = '';
let storeId = '';
let helixId = '';
let tempurId = '';
let variantAId = '';
let mattressesId = '';
let variantBId = '';
let variantCId = '';
let so1LineId = '';
let so2LineId = '';

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
      .values({ slug: 'replen-test', name: 'Replen Test Co', status: 'active' })
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
    async function makeUser(email: string, role: string) {
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
    await makeUser('owner@replen-test.local', 'Owner');
    await makeUser('cashier@replen-test.local', 'Cashier');

    const loc = async (name: string, locationType: string) => {
      const [l] = await db
        .insert(schema.locations)
        .values({ businessId, name, timezone: 'America/Los_Angeles', locationType })
        .returning({ id: schema.locations.id });
      return l!.id;
    };
    warehouseId = await loc('Warehouse', 'warehouse');
    storeId = await loc('Culver City', 'store');

    const vendors = await db
      .insert(schema.vendors)
      .values([
        { businessId, name: 'Helix' },
        { businessId, name: 'Tempur' },
      ])
      .returning({ id: schema.vendors.id, name: schema.vendors.name });
    helixId = vendors.find((v) => v.name === 'Helix')!.id;
    tempurId = vendors.find((v) => v.name === 'Tempur')!.id;
    const [brand] = await db
      .insert(schema.brands)
      .values({ businessId, name: 'TEMPUR' })
      .returning({ id: schema.brands.id });
    const [collection] = await db
      .insert(schema.collections)
      .values({ businessId, name: 'Dusk', vendorId: helixId })
      .returning({ id: schema.collections.id });

    // A: Helix by preferred vendor; B: Tempur by brand name, carton of 6,
    // safety 20 / pack 12; C: no vendor anywhere.
    // A22.1 tree: A is filed on "Mattresses › Hybrid", B on "Pillows".
    const [mattresses] = await db
      .insert(schema.categories)
      .values({ businessId, name: 'Mattresses', position: 0 })
      .returning({ id: schema.categories.id });
    mattressesId = mattresses!.id;
    const [hybrid] = await db
      .insert(schema.categories)
      .values({ businessId, name: 'Hybrid', parentId: mattressesId, position: 1 })
      .returning({ id: schema.categories.id });
    const [pillows] = await db
      .insert(schema.categories)
      .values({ businessId, name: 'Pillows', position: 1 })
      .returning({ id: schema.categories.id });
    const [pA] = await db
      .insert(schema.products)
      .values({
        businessId,
        sku: 'HEXMIC_FP-7680',
        name: 'E KING MIDNIGHT-LUXE',
        collectionId: collection!.id,
        categoryId: hybrid!.id,
      })
      .returning({ id: schema.products.id });
    const [vA] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: pA!.id,
        sku: 'HEXMIC_FP-7680',
        priceCents: 274900,
        costCents: 80300,
        preferredVendorId: helixId,
      })
      .returning({ id: schema.productVariants.id });
    variantAId = vA!.id;
    const [pB] = await db
      .insert(schema.products)
      .values({
        businessId,
        sku: 'TP-PILLOW',
        name: 'QUEEN CLOUD PILLOW',
        brandId: brand!.id,
        categoryId: pillows!.id,
        purchaseCartonQty: 6,
      })
      .returning({ id: schema.products.id });
    const [vB] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: pB!.id,
        sku: 'TP-PILLOW',
        priceCents: 9900,
        costCents: 2500,
        reorderPoint: 20,
        reorderQty: 12,
      })
      .returning({ id: schema.productVariants.id });
    variantBId = vB!.id;
    const [pC] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'ORPHAN', name: 'ORPHAN FRAME' })
      .returning({ id: schema.products.id });
    const [vC] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: pC!.id, sku: 'ORPHAN', priceCents: 5000, costCents: 1000 })
      .returning({ id: schema.productVariants.id });
    variantCId = vC!.id;

    await db.insert(schema.inventoryLevels).values([
      {
        businessId,
        variantId: variantAId,
        locationId: warehouseId,
        onHand: 3,
        reserved: 3,
        floorSample: 1,
      },
      { businessId, variantId: variantBId, locationId: warehouseId, onHand: 5, reorderPoint: 10 },
      { businessId, variantId: variantBId, locationId: storeId, onHand: 2, reorderPoint: 4 },
      { businessId, variantId: variantCId, locationId: warehouseId, onHand: 0 },
    ]);
    await db.insert(schema.asIsItems).values([
      { businessId, variantId: variantAId, locationId: warehouseId, quantity: 1, source: 'return' },
      { businessId, variantId: variantAId, locationId: warehouseId, quantity: 1, source: 'return' },
    ]);

    const [customer] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Jane', lastName: 'Doe' })
      .returning({ id: schema.customers.id });
    const order = async (
      number: string,
      status: string,
      extra: Partial<typeof schema.orders.$inferInsert> = {},
    ) => {
      const [o] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: storeId,
          stockLocationId: warehouseId,
          number,
          status,
          customerId: customer!.id,
          ...extra,
        })
        .returning({ id: schema.orders.id });
      return o!.id;
    };
    const line = async (
      orderId: string,
      variantId: string,
      quantity: number,
      extra: Partial<typeof schema.orderLines.$inferInsert> = {},
    ) => {
      const [l] = await db
        .insert(schema.orderLines)
        .values({
          businessId,
          orderId,
          variantId,
          description: 'line',
          quantity,
          unitPriceCents: 1000,
          totalCents: 1000 * quantity,
          ...extra,
        })
        .returning({ id: schema.orderLines.id });
      return l!.id;
    };
    const so1 = await order('SO-1', 'open', {
      deliveryStatus: 'scheduled',
      requestedDate: '2026-09-20',
    });
    so1LineId = await line(so1, variantAId, 5);
    const so2 = await order('SO-2', 'open', { requestedDate: '2026-09-15' });
    so2LineId = await line(so2, variantAId, 2);
    await line(so2, variantCId, 1);
    const so3 = await order('SO-3', 'open', { stockLocationId: null });
    await line(so3, variantBId, 4);
    const done = await order('SO-DONE', 'completed', { completedAt: new Date() });
    await line(done, variantAId, 1, { qtyFulfilled: 1 });

    // An open Helix PO for A: 4 ordered, 2 already allocated to SO-1.
    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        businessId,
        vendorId: helixId,
        locationId: warehouseId,
        number: 'PO-EXIST',
        status: 'ordered',
        placedAt: new Date(),
        subtotalCents: 321200,
      })
      .returning({ id: schema.purchaseOrders.id });
    const [poLine] = await db
      .insert(schema.purchaseOrderLines)
      .values({
        businessId,
        purchaseOrderId: po!.id,
        variantId: variantAId,
        quantityOrdered: 4,
        unitCostCents: 80300,
        lineTotalCents: 321200,
      })
      .returning({ id: schema.purchaseOrderLines.id });
    await db.insert(schema.poLineAllocations).values({
      businessId,
      poLineId: poLine!.id,
      orderLineId: so1LineId,
      quantity: 2,
      status: 'ordered',
    });
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
  post: (url: string) =>
    request(app.getHttpServer()).post(url).set('Cookie', cookie).set('X-Business-Id', businessId),
});

interface Line {
  variantId: string;
  locationId: string | null;
  locationName: string | null;
  available: number;
  netOnPo: number;
  demand: number;
  orderQty: number;
  cartonQty: number;
  cartons: number;
  totalQty: number;
  orders: { orderNumber: string; shortfall: number }[];
}
interface Group {
  vendorId: string | null;
  vendorName: string | null;
  lines: Line[];
  totals: { lines: number; totalQty: number; costCents: number };
}
interface Result {
  groups: Group[];
  totals: { lines: number; totalQty: number; costCents: number };
}

async function run(body: Record<string, unknown>): Promise<Result> {
  const res = await as(ownerCookie).post('/v1/purchasing/replenish/run').send(body).expect(201);
  return res.body as Result;
}
const lineOf = (r: Result, vendorName: string | null, variantId: string, locationId?: string) =>
  r.groups
    .find((g) => g.vendorName === vendorName)
    ?.lines.find(
      (l) => l.variantId === variantId && (locationId === undefined || l.locationId === locationId),
    );

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'replen-test-secret-replen-test-secret-!!';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();
  ownerCookie = await captureCookie('owner@replen-test.local');
  cashierCookie = await captureCookie('cashier@replen-test.local');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('Allocated order replenishment', () => {
  it('nets the uncovered order shortfall against free stock and open POs, grouped by vendor', async () => {
    const r = await run({ mode: 'allocated_order' });
    expect(r.groups.map((g) => g.vendorName)).toEqual(['Helix', 'Tempur', null]);
    // A @ warehouse: SO-1 lacks 3 (5 − 2 allocated), SO-2 lacks 2; stock
    // 3 − 3 reserved − 1 floor = −1 → 0; PO-EXIST has 2 unallocated.
    const a = lineOf(r, 'Helix', variantAId)!;
    expect(a).toMatchObject({
      locationName: 'Warehouse',
      available: -1,
      netOnPo: 2,
      demand: 5,
      orderQty: 3,
      cartonQty: 1,
      totalQty: 3,
    });
    expect(a.orders.map((o) => [o.orderNumber, o.shortfall])).toEqual([
      ['SO-2', 2],
      ['SO-1', 3],
    ]);
    // B @ store (the order has no stock location): lacks 4, 2 free → 2;
    // Tempur resolved from the brand name.
    const b = lineOf(r, 'Tempur', variantBId)!;
    expect(b).toMatchObject({
      locationName: 'Culver City',
      demand: 4,
      available: 2,
      orderQty: 2,
      totalQty: 2,
      cartonQty: 6,
      cartons: 1,
    });
    // C has no vendor at all.
    expect(lineOf(r, null, variantCId)).toMatchObject({ demand: 1, orderQty: 1 });
    expect(r.totals).toEqual({ lines: 3, totalQty: 6, costCents: 3 * 80300 + 2 * 2500 + 1000 });
  });

  it('options: floor samples and returns count as stock, cartons round up', async () => {
    const floor = await run({ mode: 'allocated_order', includeFloorSamples: true });
    expect(lineOf(floor, 'Helix', variantAId)).toMatchObject({ available: 0, orderQty: 3 });
    const returns = await run({ mode: 'allocated_order', includeReturns: true });
    expect(lineOf(returns, 'Helix', variantAId)).toMatchObject({ available: 1, orderQty: 2 });
    const carton = await run({ mode: 'allocated_order', roundToCarton: true });
    expect(lineOf(carton, 'Tempur', variantBId)).toMatchObject({
      orderQty: 2,
      cartons: 1,
      totalQty: 6,
    });
  });

  it('filters: fulfillment status, location, vendor, text', async () => {
    const scheduled = await run({ mode: 'allocated_order', deliveryStatuses: ['scheduled'] });
    expect(scheduled.groups.map((g) => g.vendorName)).toEqual(['Helix']);
    expect(lineOf(scheduled, 'Helix', variantAId)).toMatchObject({ demand: 3, orderQty: 1 });
    // Only SO-2 counts: A lacks 2, which PO-EXIST already covers — the
    // row stays only when zero positions are asked for.
    const none = await run({ mode: 'allocated_order', deliveryStatuses: ['none'] });
    expect(none.groups.map((g) => g.vendorName)).toEqual(['Tempur', null]);
    const zero = await run({
      mode: 'allocated_order',
      deliveryStatuses: ['none'],
      includeZero: true,
    });
    expect(lineOf(zero, 'Helix', variantAId)).toMatchObject({ demand: 2, orderQty: 0 });
    const store = await run({ mode: 'allocated_order', locationId: storeId });
    expect(store.groups.map((g) => g.vendorName)).toEqual(['Tempur']);
    const tempur = await run({ mode: 'allocated_order', vendorId: tempurId });
    expect(tempur.groups.map((g) => g.vendorName)).toEqual(['Tempur']);
    const text = await run({ mode: 'allocated_order', q: 'orphan' });
    expect(text.groups.map((g) => g.vendorName)).toEqual([null]);
    // A22.1: the root category keeps the products filed on its
    // subcategories, and every line reads its full path.
    const byRoot = await run({ mode: 'allocated_order', categoryId: mattressesId });
    expect(byRoot.groups.map((g) => g.vendorName)).toEqual(['Helix']);
    expect(lineOf(byRoot, 'Helix', variantAId)).toMatchObject({
      categoryName: 'Hybrid',
      categoryPath: 'Mattresses › Hybrid',
    });
    await as(ownerCookie)
      .post('/v1/purchasing/replenish/run')
      .send({ mode: 'allocated_order', deliveryStatuses: ['bogus'] })
      .expect(400);
    await as(cashierCookie).post('/v1/purchasing/replenish/run').send({}).expect(403);
  });
});

describe('Stock level replenishment', () => {
  it('minimum: every store position below its Min Stock, at least the reorder pack', async () => {
    const r = await run({ mode: 'stock_level', stockLevelBasis: 'minimum' });
    expect(r.groups.map((g) => g.vendorName)).toEqual(['Tempur']);
    expect(lineOf(r, 'Tempur', variantBId, warehouseId)).toMatchObject({
      demand: 10,
      available: 5,
      orderQty: 12,
      cartons: 2,
      totalQty: 12,
    });
    expect(lineOf(r, 'Tempur', variantBId, storeId)).toMatchObject({
      demand: 4,
      available: 2,
      orderQty: 12,
    });
    const one = await run({
      mode: 'stock_level',
      stockLevelBasis: 'minimum',
      locationId: warehouseId,
    });
    expect(one.totals.lines).toBe(1);
  });

  it('safety: the business-wide reorder point against stock everywhere', async () => {
    const r = await run({ mode: 'stock_level', stockLevelBasis: 'safety', roundToCarton: true });
    const b = lineOf(r, 'Tempur', variantBId)!;
    expect(b).toMatchObject({
      locationId: null,
      demand: 20,
      available: 7,
      orderQty: 13,
      cartons: 3,
      totalQty: 18,
    });
    // Safety rows have no location — the PO needs one.
    await as(ownerCookie)
      .post('/v1/purchasing/replenish/purchase-orders')
      .send({ mode: 'stock_level', stockLevelBasis: 'safety' })
      .expect(400);
  });
});

describe('Create purchase orders', () => {
  it('writes one PO per vendor with special-order allocations, skips the vendor-less group, honours overrides', async () => {
    const res = await as(ownerCookie)
      .post('/v1/purchasing/replenish/purchase-orders')
      .send({
        mode: 'allocated_order',
        roundToCarton: true,
        place: false,
        overrides: [{ variantId: variantAId, locationId: warehouseId, totalQty: 4 }],
      })
      .expect(201);
    const pos = res.body.purchaseOrders as {
      vendorName: string;
      locationId: string;
      poId: string;
      status: string;
      lineCount: number;
      totalQty: number;
    }[];
    expect(pos.map((p) => [p.vendorName, p.status, p.lineCount, p.totalQty])).toEqual([
      ['Helix', 'draft', 1, 4],
      ['Tempur', 'draft', 1, 6],
    ]);
    expect(pos.find((p) => p.vendorName === 'Tempur')!.locationId).toBe(storeId);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toMatch(/no vendor/);

    await withDb(async (db) => {
      const helixPo = pos.find((p) => p.vendorName === 'Helix')!;
      const [po] = await db
        .select({
          notes: schema.purchaseOrders.notes,
          expectedAt: schema.purchaseOrders.expectedAt,
        })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.id, helixPo.poId));
      expect(po!.notes).toMatch(/allocated orders/);
      expect(po!.expectedAt).toBeNull();
      const lines = await db
        .select({
          id: schema.purchaseOrderLines.id,
          qty: schema.purchaseOrderLines.quantityOrdered,
        })
        .from(schema.purchaseOrderLines)
        .where(eq(schema.purchaseOrderLines.purchaseOrderId, helixPo.poId));
      expect(lines.map((l) => l.qty)).toEqual([4]);
      // Earliest fill-by first: SO-2 (2) then SO-1 (the remaining 2 of its 3).
      const allocations = await db
        .select({
          orderLineId: schema.poLineAllocations.orderLineId,
          quantity: schema.poLineAllocations.quantity,
        })
        .from(schema.poLineAllocations)
        .where(
          inArray(
            schema.poLineAllocations.poLineId,
            lines.map((l) => l.id),
          ),
        );
      expect(
        allocations.map((a) => [
          a.orderLineId === so2LineId ? 'SO-2' : a.orderLineId === so1LineId ? 'SO-1' : '?',
          a.quantity,
        ]),
      ).toEqual([
        ['SO-2', 2],
        ['SO-1', 2],
      ]);
    });

    // The new POs now cover the demand: only the vendor-less line is left.
    const again = await run({ mode: 'allocated_order' });
    expect(again.groups.map((g) => g.vendorName)).toEqual([null]);
    expect(lineOf(again, null, variantCId)).toMatchObject({ orderQty: 1 });
  });

  it('nothing left to order is a 400, and vendorIds narrows the run', async () => {
    await as(ownerCookie)
      .post('/v1/purchasing/replenish/purchase-orders')
      .send({ mode: 'allocated_order', vendorIds: [helixId] })
      .expect(400);
    const res = await as(ownerCookie)
      .post('/v1/purchasing/replenish/purchase-orders')
      .send({
        mode: 'stock_level',
        stockLevelBasis: 'minimum',
        vendorIds: [tempurId],
        locationId: warehouseId,
      })
      .expect(201);
    expect(res.body.purchaseOrders).toHaveLength(1);
    expect(res.body.purchaseOrders[0]).toMatchObject({
      vendorName: 'Tempur',
      status: 'ordered',
      totalQty: 12,
    });
    await as(cashierCookie)
      .post('/v1/purchasing/replenish/purchase-orders')
      .send({ mode: 'allocated_order' })
      .expect(403);
  });
});
