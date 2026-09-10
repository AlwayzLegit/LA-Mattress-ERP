/**
 * Amendment A19 — Products absorbs Inventory. The STORIS-shaped product
 * list (vendor model / vendor / on hand / available / net on PO / as-is /
 * price / status / group / brand), the product page's stock block and
 * per-location grid, and the Advanced Product Settings fields (second
 * description, purchase status, packing) on PATCH.
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
  process.env.PRODUCT_STOCK_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_product_stock';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'StockPass!2026';

let app: INestApplication;
let businessId = '';
let ownerCookie = '';
let cashierCookie = '';
let warehouseId = '';
let storeId = '';
let productId = '';
let variantId = '';
let bareProductId = '';

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
      .values({ slug: 'stock-test', name: 'Stock Test Co', status: 'active' })
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
    await makeUser('owner@stock-test.local', 'Owner');
    await makeUser('cashier@stock-test.local', 'Cashier');

    const [wh] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Warehouse', timezone: 'America/Los_Angeles', taxRateBps: 0 })
      .returning({ id: schema.locations.id });
    const [st] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Koreatown', timezone: 'America/Los_Angeles', taxRateBps: 0 })
      .returning({ id: schema.locations.id });
    warehouseId = wh!.id;
    storeId = st!.id;

    const [vendor] = await db
      .insert(schema.vendors)
      .values({ businessId, name: 'BIA' })
      .returning({ id: schema.vendors.id });
    const [brand] = await db
      .insert(schema.brands)
      .values({ businessId, name: 'EASTMAN' })
      .returning({ id: schema.brands.id });
    const [product] = await db
      .insert(schema.products)
      .values({ businessId, sku: '7705-5/0', name: 'QUEEN MICAH E/T', brandId: brand!.id })
      .returning({ id: schema.products.id });
    productId = product!.id;
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId,
        sku: '7705-5/0',
        priceCents: 0,
        costCents: 46800,
        vendorSku: 'MICAH-Q-ET',
        preferredVendorId: vendor!.id,
        attributesJson: { group: 'QUEEN' },
      })
      .returning({ id: schema.productVariants.id });
    variantId = variant!.id;
    const [bare] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'BARE-1', name: 'BARE PRODUCT' })
      .returning({ id: schema.products.id });
    bareProductId = bare!.id;
    await db.insert(schema.productVariants).values({
      businessId,
      productId: bareProductId,
      sku: 'BARE-1',
      priceCents: 9900,
    });

    // Stock: 5 on hand at the warehouse (2 reserved, 1 floor sample), 1 at the store.
    await db.insert(schema.inventoryLevels).values([
      { businessId, variantId, locationId: warehouseId, onHand: 5, reserved: 2, floorSample: 1 },
      { businessId, variantId, locationId: storeId, onHand: 1, reserved: 0, floorSample: 0 },
    ]);
    // Purchase orders: one placed (4 ordered, 1 accepted), one draft (ignored),
    // one direct-ship (ignored).
    const po = async (status: string, directShip: boolean, ordered: number, accepted: number) => {
      const [h] = await db
        .insert(schema.purchaseOrders)
        .values({
          businessId,
          vendorId: vendor!.id,
          locationId: warehouseId,
          number: `PO-${status}-${directShip ? 'ds' : 'wh'}`,
          status,
          directShip,
        })
        .returning({ id: schema.purchaseOrders.id });
      await db.insert(schema.purchaseOrderLines).values({
        businessId,
        purchaseOrderId: h!.id,
        variantId,
        quantityOrdered: ordered,
        quantityReceived: accepted,
        quantityInspected: accepted,
        quantityAccepted: accepted,
        unitCostCents: 46800,
        lineTotalCents: 46800 * ordered,
      });
    };
    await po('partially_received', false, 4, 1);
    await po('draft', false, 10, 0);
    await po('ordered', true, 7, 0);
    // As-is pieces in review at the store: 3 total, one of them parts-only.
    await db.insert(schema.asIsItems).values([
      { businessId, variantId, locationId: storeId, quantity: 2, condition: 'light_wear' },
      { businessId, variantId, locationId: storeId, quantity: 1, condition: 'parts' },
      { businessId, variantId, locationId: storeId, quantity: 4, status: 'scrapped' },
    ]);
    // A layaway holding 1 of the warehouse's 2 reserved units.
    const [customer] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Lay', lastName: 'Away' })
      .returning({ id: schema.customers.id });
    const [order] = await db
      .insert(schema.orders)
      .values({
        businessId,
        locationId: storeId,
        stockLocationId: warehouseId,
        number: 'SO-1',
        status: 'open',
        orderKind: 'layaway',
        customerId: customer!.id,
      })
      .returning({ id: schema.orders.id });
    await db.insert(schema.orderLines).values({
      businessId,
      orderId: order!.id,
      variantId,
      description: 'QUEEN MICAH E/T',
      quantity: 1,
      qtyReserved: 1,
      unitPriceCents: 0,
      totalCents: 0,
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

const as = (cookie: string) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', cookie).set('X-Business-Id', businessId),
  patch: (url: string) =>
    request(app.getHttpServer()).patch(url).set('Cookie', cookie).set('X-Business-Id', businessId),
});

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'stock-test-secret-stock-test-secret-!!';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();
  ownerCookie = await captureCookie('owner@stock-test.local');
  cashierCookie = await captureCookie('cashier@stock-test.local');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('GET /v1/products — STORIS columns (A19)', () => {
  it('sums stock, open PO units and as-is pieces across locations', async () => {
    const res = await as(ownerCookie).get('/v1/products').expect(200);
    const row = res.body.data.find((r: { id: string }) => r.id === productId);
    expect(row).toMatchObject({
      sku: '7705-5/0',
      name: 'QUEEN MICAH E/T',
      isActive: true,
      purchaseStatus: 'active',
      brandName: 'EASTMAN',
      vendorName: 'BIA',
      vendorModel: 'MICAH-Q-ET',
      group: 'QUEEN',
      priceCents: 0,
      costCents: 46800,
      onHand: 6,
      // warehouse 5 − 2 reserved − 1 floor = 2, store 1
      available: 3,
      // 4 ordered − 1 accepted on the placed PO; draft and direct-ship ignored
      netOnPo: 3,
      asIsOnHand: 3,
      asIsAvailable: 2,
      asIsNonSellable: 1,
    });
    const bare = res.body.data.find((r: { id: string }) => r.id === bareProductId);
    expect(bare).toMatchObject({
      vendorName: null,
      vendorModel: null,
      group: null,
      priceCents: 9900,
      onHand: 0,
      available: 0,
      netOnPo: 0,
      asIsOnHand: 0,
    });
  });

  it('narrows every column to one store with locationId', async () => {
    const res = await as(ownerCookie).get(`/v1/products?locationId=${storeId}`).expect(200);
    const row = res.body.data.find((r: { id: string }) => r.id === productId);
    expect(row).toMatchObject({ onHand: 1, available: 1, netOnPo: 0, asIsOnHand: 3 });
    const wh = await as(ownerCookie).get(`/v1/products?locationId=${warehouseId}`).expect(200);
    expect(wh.body.data.find((r: { id: string }) => r.id === productId)).toMatchObject({
      onHand: 5,
      available: 2,
      netOnPo: 3,
      asIsOnHand: 0,
    });
  });

  it('search results carry the same columns; cost is hidden without products.cost.view', async () => {
    const res = await as(cashierCookie).get('/v1/products?q=MICAH').expect(200);
    const row = res.body.data.find((r: { id: string }) => r.id === productId);
    expect(row).toMatchObject({ onHand: 6, available: 3, costCents: null, priceCents: 0 });
  });
});

describe('GET /v1/products/:id — stock block and STORIS fields', () => {
  it('returns totals, one grid row per active location, names and the new fields', async () => {
    const res = await as(ownerCookie).get(`/v1/products/${productId}`).expect(200);
    expect(res.body).toMatchObject({
      brandName: 'EASTMAN',
      vendorName: 'BIA',
      vendorModel: 'MICAH-Q-ET',
      group: 'QUEEN',
      categoryName: null,
      secondDescription: null,
      purchaseStatus: 'active',
      boxesPerProduct: 1,
      logisticalCartonQty: 1,
      purchaseCartonQty: 1,
      logisticalCartonTransfers: false,
      serialTracked: false,
    });
    expect(res.body.stock.totals).toEqual({
      onHand: 6,
      reserved: 2,
      floorSample: 1,
      available: 3,
      netOnPo: 3,
      totalPo: 4,
      asIsOnHand: 3,
      asIsAvailable: 2,
      asIsNonSellable: 1,
      layawayReserved: 1,
    });
    const grid = res.body.stock.byLocation as { locationName: string }[];
    expect(grid.map((r) => r.locationName)).toEqual(['Koreatown', 'Warehouse']);
    expect(grid[1]).toMatchObject({
      variantId,
      variantSku: '7705-5/0',
      locationId: warehouseId,
      onHand: 5,
      reserved: 2,
      floorSample: 1,
      available: 2,
      netOnPo: 3,
      totalPo: 4,
      asIsOnHand: 0,
      layawayReserved: 1,
      storageBinCode: null,
    });
    expect(grid[0]).toMatchObject({
      locationId: storeId,
      onHand: 1,
      available: 1,
      netOnPo: 0,
      asIsOnHand: 3,
      asIsAvailable: 2,
      asIsNonSellable: 1,
      layawayReserved: 0,
    });
  });

  it('a product with no stock still lists every location at zero', async () => {
    const res = await as(ownerCookie).get(`/v1/products/${bareProductId}`).expect(200);
    expect(res.body.stock.totals.onHand).toBe(0);
    expect(res.body.stock.byLocation).toHaveLength(2);
    expect(res.body.stock.byLocation.every((r: { onHand: number }) => r.onHand === 0)).toBe(true);
  });
});

describe('PATCH /v1/products/:id — Advanced Product Settings fields', () => {
  it('saves second description, purchase status and packing, and audits them', async () => {
    const res = await as(ownerCookie)
      .patch(`/v1/products/${productId}`)
      .send({
        secondDescription: '  EURO-TOP  ',
        purchaseStatus: 'discontinued',
        boxesPerProduct: 2,
        logisticalCartonQty: 3,
        purchaseCartonQty: 6,
        logisticalCartonTransfers: true,
      })
      .expect(200);
    expect(res.body).toMatchObject({
      secondDescription: 'EURO-TOP',
      purchaseStatus: 'discontinued',
      boxesPerProduct: 2,
      logisticalCartonQty: 3,
      purchaseCartonQty: 6,
      logisticalCartonTransfers: true,
    });
    const list = await as(ownerCookie).get('/v1/products?q=MICAH').expect(200);
    expect(list.body.data[0].purchaseStatus).toBe('discontinued');
  });

  it('rejects an unknown purchase status and a zero carton quantity', async () => {
    await as(ownerCookie)
      .patch(`/v1/products/${productId}`)
      .send({ purchaseStatus: 'retired' })
      .expect(400);
    await as(ownerCookie)
      .patch(`/v1/products/${productId}`)
      .send({ purchaseCartonQty: 0 })
      .expect(400);
    const res = await as(ownerCookie).get(`/v1/products/${productId}`).expect(200);
    expect(res.body.purchaseCartonQty).toBe(6);
  });

  it('a cashier cannot edit the product', async () => {
    await as(cashierCookie)
      .patch(`/v1/products/${productId}`)
      .send({ purchaseStatus: 'active' })
      .expect(403);
  });
});
