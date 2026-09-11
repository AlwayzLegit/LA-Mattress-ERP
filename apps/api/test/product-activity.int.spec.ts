/**
 * Amendment A21 — View Product Activity. The STORIS tabs as reads under
 * `/v1/products/:id/activity/*` (ATP, purchase orders, open orders, sales
 * history, transfers, general cost info, serials, as-is, summary), the
 * on-order-reserved column on the location grid, the Search-for-a-Product
 * criteria on `GET /v1/products`, and the two General Information fields.
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
  process.env.PRODUCT_ACTIVITY_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_product_activity';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'ActivityPass!2026';

let app: INestApplication;
let businessId = '';
let ownerCookie = '';
let cashierCookie = '';
let warehouseId = '';
let storeId = '';
let productId = '';
let variantId = '';
let otherProductId = '';
let brandId = '';
let reasonCodeId = '';
let openOrderId = '';
let quoteOrderId = '';
let transferId = '';
let poId = '';

const now = new Date();
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
/** A moment inside this month (after its start, before now). */
const thisMonth = new Date(Math.max(monthStart.getTime() + 60_000, now.getTime() - 60_000));
/** A moment inside last month. */
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
const inTenDays = new Date(now.getTime() + 10 * 86_400_000);
const inTwentyDays = new Date(now.getTime() + 20 * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

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
      .values({ slug: 'activity-test', name: 'Activity Test Co', status: 'active' })
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
    await makeUser('owner@activity-test.local', 'Owner');
    await makeUser('cashier@activity-test.local', 'Cashier');

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
      .values({
        businessId,
        name: 'BIA',
        landedCostJson: {
          freight: { active: true, type: 'percent', percent: 10, cents: null, label: null },
          importFee: { active: true, type: 'dollar', percent: null, cents: 500, label: null },
          miscFee: { active: false, type: 'percent', percent: 5, cents: null, label: null },
          custom: [],
        },
      })
      .returning({ id: schema.vendors.id });
    const [brand] = await db
      .insert(schema.brands)
      .values({ businessId, name: 'EASTMAN' })
      .returning({ id: schema.brands.id });
    brandId = brand!.id;
    const [product] = await db
      .insert(schema.products)
      .values({
        businessId,
        sku: '7703-5/0',
        name: 'QUEEN MICAH FIRM',
        brandId,
        serialTracked: true,
      })
      .returning({ id: schema.products.id });
    productId = product!.id;
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId,
        sku: '7703-5/0',
        priceCents: 89900,
        costCents: 46800,
        vendorSku: 'MICAH-Q-F',
        preferredVendorId: vendor!.id,
        attributesJson: { group: 'QUEEN' },
      })
      .returning({ id: schema.productVariants.id });
    variantId = variant!.id;
    const [other] = await db
      .insert(schema.products)
      .values({
        businessId,
        sku: '38G',
        name: 'T/F METAL FRAME W/GLIDES',
        purchaseStatus: 'closeout',
      })
      .returning({ id: schema.products.id });
    otherProductId = other!.id;
    await db.insert(schema.productVariants).values({
      businessId,
      productId: otherProductId,
      sku: '38G',
      priceCents: 9900,
      attributesJson: { group: 'FRAME' },
    });

    // Stock: 4 on hand at the warehouse (1 reserved), 1 at the store, in a bin.
    const [bin] = await db
      .insert(schema.storageBins)
      .values({ businessId, locationId: warehouseId, code: 'DOCK' })
      .returning({ id: schema.storageBins.id });
    await db.insert(schema.inventoryLevels).values([
      {
        businessId,
        variantId,
        locationId: warehouseId,
        onHand: 4,
        reserved: 1,
        floorSample: 0,
        storageBinId: bin!.id,
      },
      { businessId, variantId, locationId: storeId, onHand: 1, reserved: 0, floorSample: 0 },
    ]);
    // Movements this month at the warehouse: +3 received on a PO, −1 sold,
    // −1 transferred out, a delta-0 reservation (counts nowhere).
    await db.insert(schema.inventoryMovements).values([
      {
        businessId,
        variantId,
        locationId: warehouseId,
        delta: 3,
        reason: 'receive_po',
        createdAt: thisMonth,
      },
      {
        businessId,
        variantId,
        locationId: warehouseId,
        delta: -1,
        reason: 'order_fulfill',
        createdAt: new Date(thisMonth.getTime() + 1000),
      },
      {
        businessId,
        variantId,
        locationId: warehouseId,
        delta: -1,
        reason: 'transfer_out',
        createdAt: new Date(thisMonth.getTime() + 2000),
      },
      {
        businessId,
        variantId,
        locationId: warehouseId,
        delta: 0,
        reason: 'order_reserve',
        createdAt: thisMonth,
      },
      {
        businessId,
        variantId,
        locationId: warehouseId,
        delta: 9,
        reason: 'receive_po',
        createdAt: lastMonth,
      },
    ]);

    // Customer + orders: one open (delivery scheduled), one quote, one completed this month.
    const [customer] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Anna Rose', lastName: 'Baltazar' })
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
    openOrderId = await order('SO-OPEN', 'open', {
      deliveryStatus: 'scheduled',
      requestedDate: ymd(inTenDays),
    });
    const [openLine] = await db
      .insert(schema.orderLines)
      .values({
        businessId,
        orderId: openOrderId,
        variantId,
        description: 'QUEEN MICAH FIRM',
        quantity: 2,
        qtyReserved: 1,
        unitPriceCents: 89900,
        totalCents: 179800,
      })
      .returning({ id: schema.orderLines.id });
    const [delivery] = await db
      .insert(schema.deliveries)
      .values({
        businessId,
        locationId: warehouseId,
        orderId: openOrderId,
        scheduledDate: ymd(inTenDays),
        status: 'scheduled',
      })
      .returning({ id: schema.deliveries.id });
    await db.insert(schema.deliveryLines).values({
      businessId,
      deliveryId: delivery!.id,
      orderLineId: openLine!.id,
      quantity: 2,
    });
    quoteOrderId = await order('Q-1', 'quote');
    await db.insert(schema.orderLines).values({
      businessId,
      orderId: quoteOrderId,
      variantId,
      description: 'QUEEN MICAH FIRM',
      quantity: 1,
      unitPriceCents: 89900,
      totalCents: 89900,
    });
    const completedId = await order('SO-DONE', 'completed', { completedAt: thisMonth });
    await db.insert(schema.orderLines).values({
      businessId,
      orderId: completedId,
      variantId,
      description: 'QUEEN MICAH FIRM',
      quantity: 1,
      qtyFulfilled: 1,
      unitPriceCents: 89900,
      taxCents: 8000,
      totalCents: 97900,
    });

    // Register sale last month (2 units) with one unit refunded last month.
    const [sale] = await db
      .insert(schema.sales)
      .values({
        businessId,
        locationId: storeId,
        number: 'S-1',
        status: 'partially_refunded',
        subtotalCents: 160000,
        totalCents: 160000,
        completedAt: lastMonth,
      })
      .returning({ id: schema.sales.id });
    const [saleLine] = await db
      .insert(schema.saleLines)
      .values({
        businessId,
        saleId: sale!.id,
        variantId,
        description: 'QUEEN MICAH FIRM',
        quantity: 2,
        unitPriceCents: 80000,
        totalCents: 160000,
      })
      .returning({ id: schema.saleLines.id });
    const [refund] = await db
      .insert(schema.refunds)
      .values({ businessId, saleId: sale!.id, amountCents: 80000, createdAt: lastMonth })
      .returning({ id: schema.refunds.id });
    await db.insert(schema.refundLines).values({
      businessId,
      refundId: refund!.id,
      saleLineId: saleLine!.id,
      variantId,
      quantity: 1,
      amountCents: 80000,
    });

    // Purchase orders: a placed one owing 5 (1 allocated to the open order
    // line), due in 20 days, and a direct-ship draft.
    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        businessId,
        vendorId: vendor!.id,
        locationId: warehouseId,
        number: 'PO-21048',
        status: 'ordered',
        placedAt: thisMonth,
        expectedAt: inTwentyDays,
      })
      .returning({ id: schema.purchaseOrders.id });
    poId = po!.id;
    const [poLine] = await db
      .insert(schema.purchaseOrderLines)
      .values({
        businessId,
        purchaseOrderId: poId,
        variantId,
        quantityOrdered: 6,
        quantityReceived: 2,
        quantityInspected: 1,
        quantityAccepted: 1,
        unitCostCents: 46800,
        lineTotalCents: 46800 * 6,
      })
      .returning({ id: schema.purchaseOrderLines.id });
    await db.insert(schema.poLineAllocations).values({
      businessId,
      poLineId: poLine!.id,
      orderLineId: openLine!.id,
      quantity: 1,
      status: 'ordered',
    });
    // The +3 receipt this month came off this PO (ledger reference).
    await db
      .update(schema.inventoryMovements)
      .set({ referenceType: 'purchase_order', referenceId: poId })
      .where(
        and(
          eq(schema.inventoryMovements.variantId, variantId),
          eq(schema.inventoryMovements.reason, 'receive_po'),
          eq(schema.inventoryMovements.delta, 3),
        ),
      );
    const [ds] = await db
      .insert(schema.purchaseOrders)
      .values({
        businessId,
        vendorId: vendor!.id,
        locationId: warehouseId,
        number: 'PO-DS',
        status: 'draft',
        directShip: true,
      })
      .returning({ id: schema.purchaseOrders.id });
    await db.insert(schema.purchaseOrderLines).values({
      businessId,
      purchaseOrderId: ds!.id,
      variantId,
      quantityOrdered: 2,
      unitCostCents: 46800,
      lineTotalCents: 93600,
    });

    // A transfer in transit warehouse → store carrying the open order.
    const [xfer] = await db
      .insert(schema.stockTransfers)
      .values({
        businessId,
        fromLocationId: warehouseId,
        toLocationId: storeId,
        number: 'XFR-1',
        status: 'in_transit',
        transferType: 'customer',
        scheduledFor: ymd(inTenDays),
        orderId: openOrderId,
        shippedAt: thisMonth,
      })
      .returning({ id: schema.stockTransfers.id });
    transferId = xfer!.id;
    await db.insert(schema.stockTransferLines).values({
      businessId,
      transferId,
      variantId,
      quantityShipped: 1,
      quantityOrdered: 1,
    });

    // As-is: one piece in review (parts-only) under a reason code, one scrapped.
    const [reason] = await db
      .insert(schema.reasonCodes)
      .values({ businessId, code: 'MAN', description: 'Manufacturer defect', usageClass: 'as_is' })
      .returning({ id: schema.reasonCodes.id });
    reasonCodeId = reason!.id;
    await db.insert(schema.asIsItems).values([
      {
        businessId,
        variantId,
        locationId: warehouseId,
        quantity: 1,
        condition: 'parts',
        pieceNumber: '348',
        asIsPriceCents: 89900,
        storageLocation: 'DOCK',
        reasonCodeId,
        notes: 'As-Is RTN ON 02107843e',
        createdAt: thisMonth,
      },
      {
        businessId,
        variantId,
        locationId: warehouseId,
        quantity: 1,
        status: 'scrapped',
        createdAt: thisMonth,
        reviewedAt: thisMonth,
      },
    ]);

    // Serial units: two unassigned, one committed to the open order, one sold.
    await db.insert(schema.serialUnits).values([
      { businessId, variantId, locationId: warehouseId, serial: '373', status: 'in_stock' },
      { businessId, variantId, locationId: warehouseId, serial: '377', status: 'in_stock' },
      {
        businessId,
        variantId,
        locationId: warehouseId,
        serial: '380',
        status: 'committed',
        orderLineId: openLine!.id,
      },
      { businessId, variantId, locationId: storeId, serial: '300', status: 'sold' },
    ]);

    // FIFO layers: 2 @ $400 and 2 @ $500 remaining → average $450.
    await db.insert(schema.costLayers).values([
      {
        businessId,
        variantId,
        locationId: warehouseId,
        sourceType: 'purchase_order',
        unitCostCents: 40000,
        quantityReceived: 2,
        quantityRemaining: 2,
      },
      {
        businessId,
        variantId,
        locationId: warehouseId,
        sourceType: 'purchase_order',
        unitCostCents: 50000,
        quantityReceived: 2,
        quantityRemaining: 2,
      },
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

const as = (cookie: string) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', cookie).set('X-Business-Id', businessId),
  patch: (url: string) =>
    request(app.getHttpServer()).patch(url).set('Cookie', cookie).set('X-Business-Id', businessId),
});
const activity = (section: string, qs = '') =>
  `/v1/products/${productId}/activity/${section}${qs ? `?${qs}` : ''}`;

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'activity-test-secret-activity-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();
  ownerCookie = await captureCookie('owner@activity-test.local');
  cashierCookie = await captureCookie('cashier@activity-test.local');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('Location Availability ATP (A21 D2, D3)', () => {
  it('answers a desired quantity from stock, then from the open PO, then not at all', async () => {
    // Available: warehouse 4 − 1 reserved = 3, store 1 → 4.
    const one = await as(ownerCookie).get(activity('atp', 'quantity=1')).expect(200);
    expect(one.body.total).toEqual({ atpQuantity: 4, atpDate: one.body.asOf });
    // 4 available + 5 still due on PO-21048 (6 − 1 accepted) covers 8; the
    // warehouse alone (3 + 5) does too, the store (1, no PO) never.
    const eight = await as(ownerCookie).get(activity('atp', 'quantity=8')).expect(200);
    expect(eight.body.total).toEqual({ atpQuantity: 4, atpDate: ymd(inTwentyDays) });
    const wh = eight.body.byLocation.find(
      (l: { locationId: string }) => l.locationId === warehouseId,
    );
    expect(wh).toMatchObject({
      locationName: 'Warehouse',
      atpQuantity: 3,
      atpDate: ymd(inTwentyDays),
    });
    const store = eight.body.byLocation.find(
      (l: { locationId: string }) => l.locationId === storeId,
    );
    expect(store).toMatchObject({ atpQuantity: 1, atpDate: null });
    const ten = await as(ownerCookie).get(activity('atp', 'quantity=10')).expect(200);
    expect(ten.body.total.atpDate).toBeNull();
    await as(ownerCookie).get(activity('atp', 'quantity=0')).expect(400);
  });

  it('puts on-order reserved and total PO on the location grid', async () => {
    const res = await as(ownerCookie).get(`/v1/products/${productId}`).expect(200);
    const wh = res.body.stock.byLocation.find(
      (r: { locationId: string }) => r.locationId === warehouseId,
    );
    expect(wh).toMatchObject({ onHand: 4, netOnPo: 5, totalPo: 6, onOrderReserved: 1 });
    expect(res.body.stock.totals).toMatchObject({ onOrderReserved: 1, netOnPo: 5 });
  });
});

describe('Purchase Orders tab (A21 D7)', () => {
  it('lists POs still owing units, direct ship typed', async () => {
    const res = await as(ownerCookie).get(activity('purchase-orders')).expect(200);
    expect(res.body.strip).toMatchObject({ onHand: 5, netOnPo: 5 });
    const rows = res.body.rows as { number: string }[];
    expect(rows.map((r) => r.number)).toEqual(['PO-21048', 'PO-DS']);
    expect(rows[0]).toMatchObject({
      vendorName: 'BIA',
      receivingLocationName: 'Warehouse',
      quantityOrdered: 6,
      quantityDue: 5,
      expectedAt: inTwentyDays.toISOString(),
      status: 'ordered',
      transactionType: 'merchandise',
      // A22: allocated to the open order's line; 2 received − 1 accepted at the dock.
      purchaseOrderType: 'special_order',
      atDock: true,
      quantityAtDock: 1,
    });
    expect(rows[1]).toMatchObject({
      quantityDue: 2,
      status: 'draft',
      transactionType: 'direct_ship',
      purchaseOrderType: 'direct_ship',
      atDock: false,
    });
  });
});

describe('Open Orders tab (A21 D6)', () => {
  it('lists open lines with the delivery status and ship-from, quotes only when asked', async () => {
    const res = await as(ownerCookie).get(activity('open-orders')).expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      orderNumber: 'SO-OPEN',
      orderType: 'sales_order',
      sellingLocationName: 'Koreatown',
      fulfillmentDate: ymd(inTenDays),
      orderQuantity: 2,
      reservedQuantity: 1,
      fulfillmentType: 'delivery',
      fulfillmentStatus: 'scheduled',
      shipFromLocationName: 'Warehouse',
      customerName: 'Anna Rose Baltazar',
      // A22: the customer transfer carrying it and the PO line allocated to it.
      linkedTransferId: transferId,
      linkedTransferNumber: 'XFR-1',
      linkedTransferQuantity: 1,
      linkedPurchaseOrderId: poId,
      linkedPurchaseOrderNumber: 'PO-21048',
      linkedPurchaseOrderQuantity: 1,
    });
    const quotes = await as(ownerCookie)
      .get(activity('open-orders', 'orderType=quote'))
      .expect(200);
    expect(quotes.body.rows.map((r: { orderNumber: string }) => r.orderNumber)).toEqual(['Q-1']);
    expect(quotes.body.rows[0].orderType).toBe('quote');
  });

  it('matches the location against the fulfillment and / or selling store', async () => {
    const selling = await as(ownerCookie)
      .get(activity('open-orders', `locationId=${storeId}&useFulfillment=0&useSelling=1`))
      .expect(200);
    expect(selling.body.rows).toHaveLength(1);
    const fulfillment = await as(ownerCookie)
      .get(activity('open-orders', `locationId=${storeId}&useFulfillment=1&useSelling=0`))
      .expect(200);
    expect(fulfillment.body.rows).toHaveLength(0);
    await as(ownerCookie)
      .get(activity('open-orders', `locationId=${storeId}&useFulfillment=0&useSelling=0`))
      .expect(400);
    await as(ownerCookie).get(activity('open-orders', 'orderType=bogus')).expect(400);
  });
});

describe('Sales History tab (A21 D5)', () => {
  it('buckets register sales, completed orders and returns by month, newest first', async () => {
    const res = await as(ownerCookie).get(activity('sales-history')).expect(200);
    const periods = res.body.periods as { period: string; shipped: number }[];
    expect(periods).toHaveLength(14);
    expect(periods[0]!.period).toBe(monthStart.toISOString().slice(0, 7));
    expect(periods[0]).toMatchObject({
      shipped: 1,
      returned: 0,
      net: 1,
      salesCents: 89900,
      costCents: 46800,
      profitPercent: 47.94,
    });
    expect(periods[1]).toMatchObject({
      period: lastMonth.toISOString().slice(0, 7),
      shipped: 2,
      returned: 1,
      net: 1,
      salesCents: 160000,
      costCents: 93600,
      profitPercent: 41.5,
    });
    expect(periods[2]).toMatchObject({ shipped: 0, salesCents: 0, profitPercent: null });
    // Only the store sold at the register.
    const store = await as(ownerCookie)
      .get(activity('sales-history', `locationId=${storeId}`))
      .expect(200);
    expect(store.body.periods[0]).toMatchObject({ shipped: 1 });
    expect(store.body.periods[1]).toMatchObject({ shipped: 2 });
    const wh = await as(ownerCookie)
      .get(activity('sales-history', `locationId=${warehouseId}`))
      .expect(200);
    expect(wh.body.periods[1]).toMatchObject({ shipped: 0 });
  });

  it('hides cost and profit without products.cost.view', async () => {
    const res = await as(cashierCookie).get(activity('sales-history')).expect(200);
    expect(res.body.periods[1]).toMatchObject({
      salesCents: 160000,
      costCents: null,
      profitPercent: null,
    });
  });
});

describe('Inbound / Outbound Transfers tabs (A21 D8)', () => {
  it('shows the in-transit transfer inbound to the store and outbound from the warehouse', async () => {
    const inbound = await as(ownerCookie)
      .get(activity('transfers', `direction=in&locationId=${storeId}`))
      .expect(200);
    expect(inbound.body.quantity).toBe(1);
    expect(inbound.body.rows[0]).toMatchObject({
      number: 'XFR-1',
      fromLocationName: 'Warehouse',
      toLocationName: 'Koreatown',
      quantity: 1,
      reservedQuantity: 1,
      orderNumber: 'SO-OPEN',
      scheduledFor: ymd(inTenDays),
      customerName: 'Anna Rose Baltazar',
      transferType: 'customer',
    });
    const none = await as(ownerCookie)
      .get(activity('transfers', `direction=in&locationId=${warehouseId}`))
      .expect(200);
    expect(none.body.rows).toHaveLength(0);
    const outbound = await as(ownerCookie)
      .get(activity('transfers', `direction=out&locationId=${warehouseId}`))
      .expect(200);
    expect(outbound.body.rows.map((r: { transferId: string }) => r.transferId)).toEqual([
      transferId,
    ]);
    await as(ownerCookie).get(activity('transfers')).expect(400);
  });
});

describe('General Information (A21 D9)', () => {
  it('computes average, PO replacement and landed cost with the vendor lines', async () => {
    const res = await as(ownerCookie).get(activity('general')).expect(200);
    expect(res.body.cost).toMatchObject({
      averageCents: 45000,
      poReplacementCents: 46800,
      // 45000 + 10% freight (4500) + $5 import fee; the inactive misc line is skipped.
      averageLandedCents: 50000,
      freightPerUnitCents: 4500,
      freightPercent: 10,
      layerUnits: 4,
      vendorName: 'BIA',
    });
    const cashier = await as(cashierCookie).get(activity('general')).expect(200);
    expect(cashier.body.cost.averageCents).toBeNull();
    expect(cashier.body.cost.poReplacementCents).toBeNull();
  });

  it('stores suggested retail and shipping on the product', async () => {
    const res = await as(ownerCookie)
      .patch(`/v1/products/${productId}`)
      .send({ suggestedRetailCents: 129900, shipping: { weightLb: 72.5, heightIn: 12 } })
      .expect(200);
    expect(res.body.suggestedRetailCents).toBe(129900);
    expect(res.body.shipping).toEqual({
      weightLb: 72.5,
      heightIn: 12,
      widthIn: null,
      depthIn: null,
      shippingVolume: null,
      deliveryVolume: null,
    });
    expect(res.body.collectionName).toBeNull();
    const again = await as(ownerCookie)
      .patch(`/v1/products/${productId}`)
      .send({ shipping: { widthIn: 60, heightIn: null } })
      .expect(200);
    expect(again.body.shipping).toMatchObject({ weightLb: 72.5, heightIn: null, widthIn: 60 });
    await as(ownerCookie)
      .patch(`/v1/products/${productId}`)
      .send({ shipping: { widthIn: -1 } })
      .expect(400);
    await as(ownerCookie)
      .patch(`/v1/products/${productId}`)
      .send({ suggestedRetailCents: 12.5 })
      .expect(400);
  });
});

describe('Serial / Reference and As-Is tabs (A21 D10, D11)', () => {
  it('lists numbered pieces with their bin and holding order, sold ones excluded', async () => {
    const res = await as(ownerCookie).get(activity('serials')).expect(200);
    expect(res.body.serialTracked).toBe(true);
    const rows = res.body.rows as { serial: string; status: string }[];
    expect(rows.map((r) => r.serial).sort()).toEqual(['373', '377', '380']);
    const committed = rows.find((r) => r.serial === '380');
    expect(committed).toMatchObject({
      status: 'committed',
      storageBinCode: 'DOCK',
      orderNumber: 'SO-OPEN',
      customerName: 'Anna Rose Baltazar',
      locationName: 'Warehouse',
    });
    const store = await as(ownerCookie)
      .get(activity('serials', `locationId=${storeId}`))
      .expect(200);
    expect(store.body.rows).toHaveLength(0);
  });

  it('lists as-is pieces in review with reason code and sellability', async () => {
    const res = await as(ownerCookie).get(activity('as-is')).expect(200);
    expect(res.body.strip).toMatchObject({ asIsOnHand: 1, asIsNonSellable: 1 });
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      pieceNumber: '348',
      condition: 'parts',
      sellable: false,
      reasonCode: { code: 'MAN', description: 'Manufacturer defect' },
      asIsPriceCents: 89900,
      storageLocation: 'DOCK',
      notes: 'As-Is RTN ON 02107843e',
      source: 'return',
    });
  });
});

describe('Summary tab (A21 D12)', () => {
  it('derives beginning balances from the ledger and buckets the month to date', async () => {
    const res = await as(ownerCookie)
      .get(activity('summary', `locationId=${warehouseId}`))
      .expect(200);
    expect(res.body).toMatchObject({
      locationId: warehouseId,
      // 4 on hand − (3 − 1 − 1) this month
      beginningBalance: 3,
      // 1 in review − 2 added this month + 1 scrapped this month
      beginningAsIsBalance: 0,
      regular: { received: 3, adjustments: 0, transferredIn: 0, transferredOut: 1, sales: 1 },
      asIs: { transferredIn: 0, transferredOut: 0, added: 2, removed: 1 },
    });
    const all = await as(ownerCookie).get(activity('summary')).expect(200);
    expect(all.body).toMatchObject({ locationId: null, beginningBalance: 4 });
  });
});

describe('Regular / As-Is Inventory Detail (A22 D17)', () => {
  it('walks the movement ledger with a running balance and resolves references', async () => {
    const res = await as(ownerCookie)
      .get(activity('ledger', `kind=regular&locationId=${warehouseId}`))
      .expect(200);
    expect(res.body).toMatchObject({
      kind: 'regular',
      start: monthStart.toISOString().slice(0, 10),
      // 4 on hand now − (+3 −1 −1) this month
      openingBalance: 3,
      endingBalance: 4,
      onHandNow: 4,
    });
    const rows = res.body.rows as { quantity: number; balance: number; memo: string }[];
    expect(rows.map((r) => [r.quantity, r.balance])).toEqual([
      [3, 6],
      [-1, 5],
      [-1, 4],
    ]);
    expect(rows[0]).toMatchObject({ memo: 'PO receipt', referenceNumber: 'PO# PO-21048' });
    expect(rows[1]).toMatchObject({ memo: 'Order / invoice' });
    expect(rows[2]).toMatchObject({ memo: 'Transfer out', locationName: 'Warehouse' });
    // Last month only: the +9 receipt, ending where this month started.
    const lm = lastMonth.toISOString().slice(0, 10);
    const prior = await as(ownerCookie)
      .get(activity('ledger', `kind=regular&locationId=${warehouseId}&start=${lm}&end=${lm}`))
      .expect(200);
    expect(prior.body).toMatchObject({ openingBalance: -6, endingBalance: 3 });
    expect(prior.body.rows).toHaveLength(1);
    await as(ownerCookie).get(activity('ledger', 'kind=bogus')).expect(400);
    await as(ownerCookie).get(activity('ledger', 'start=2026-13-01')).expect(400);
    await as(ownerCookie).get(activity('ledger', 'start=2026-09-10&end=2026-09-01')).expect(400);
  });

  it('lists as-is pieces entered and reviewed out with the as-is balance', async () => {
    const res = await as(ownerCookie)
      .get(activity('ledger', `kind=as_is&locationId=${warehouseId}`))
      .expect(200);
    // 1 in review now; 2 entered and 1 scrapped this month.
    expect(res.body).toMatchObject({
      kind: 'as_is',
      openingBalance: 0,
      endingBalance: 1,
      onHandNow: 1,
    });
    const rows = res.body.rows as { quantity: number; balance: number; memo: string }[];
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.quantity > 0)).toHaveLength(2);
    expect(rows.find((r) => r.quantity < 0)).toMatchObject({ memo: 'Scrapped' });
    expect(rows[rows.length - 1]!.balance).toBe(1);
  });
});

describe('Search for a Product criteria (A21 D13)', () => {
  const ids = (body: { data: { id: string }[] }) => body.data.map((r) => r.id);

  it('narrows the browse by each criterion', async () => {
    const sku = await as(ownerCookie).get('/v1/products?sku=7703').expect(200);
    expect(ids(sku.body)).toEqual([productId]);
    const name = await as(ownerCookie).get('/v1/products?name=metal%20frame').expect(200);
    expect(ids(name.body)).toEqual([otherProductId]);
    const brand = await as(ownerCookie).get(`/v1/products?brandId=${brandId}`).expect(200);
    expect(ids(brand.body)).toEqual([productId]);
    const model = await as(ownerCookie).get('/v1/products?vendorModel=micah-q').expect(200);
    expect(ids(model.body)).toEqual([productId]);
    const group = await as(ownerCookie).get('/v1/products?group=frame').expect(200);
    expect(ids(group.body)).toEqual([otherProductId]);
    const status = await as(ownerCookie).get('/v1/products?purchaseStatus=closeout').expect(200);
    expect(ids(status.body)).toEqual([otherProductId]);
    const reason = await as(ownerCookie)
      .get(`/v1/products?asIsReasonCodeId=${reasonCodeId}`)
      .expect(200);
    expect(ids(reason.body)).toEqual([productId]);
    // Criteria stack with the search box and the sort.
    const combined = await as(ownerCookie)
      .get('/v1/products?q=queen&group=queen&sort=name&dir=desc')
      .expect(200);
    expect(ids(combined.body)).toEqual([productId]);
    const nothing = await as(ownerCookie).get('/v1/products?q=queen&group=frame').expect(200);
    expect(ids(nothing.body)).toEqual([]);
    await as(ownerCookie).get('/v1/products?purchaseStatus=bogus').expect(400);
  });

  it('carries the category and primary collection columns and sorts by them (A22 D14)', async () => {
    const res = await as(ownerCookie).get('/v1/products?sort=collectionName&dir=asc').expect(200);
    const row = res.body.data.find((r: { id: string }) => r.id === productId);
    expect(row).toMatchObject({ categoryName: null, collectionName: null, brandName: 'EASTMAN' });
    await as(ownerCookie).get('/v1/products?sort=categoryName').expect(200);
  });
});

describe('Access', () => {
  it('needs products.view and a product of this business', async () => {
    await as(cashierCookie).get(activity('summary')).expect(200);
    await as(ownerCookie)
      .get(`/v1/products/00000000-0000-0000-0000-000000000000/activity/summary`)
      .expect(404);
    expect(poId).toBeTruthy();
    expect(openOrderId).toBeTruthy();
    expect(quoteOrderId).toBeTruthy();
  });
});
