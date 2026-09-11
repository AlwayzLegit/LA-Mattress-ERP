/**
 * Amendment A22 slice 3 — STORIS "Enter a Stock Adjustment" (stock card,
 * quantity with reason code + unit cost, write-off from stock, Move to
 * As-Is that decrements stock, As-Is void, serial rename) and "Reassign
 * a Sales Reservation" (board + reserve / back order moves).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { and, desc, eq } from 'drizzle-orm';
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
  process.env.STOCK_ADJUSTMENT_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_stock_adjustment';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'AdjustPass!2026';

let app: INestApplication;
let businessId = '';
let ownerCookie = '';
let warehouseCookie = '';
let cashierCookie = '';
let warehouseId = '';
let storeId = '';
let variantAId = '';
let asIsVariantId = '';
let variantBId = '';
let serial1Id = '';
let serial3Id = '';
let adjustReasonId = '';
let writeOffReasonId = '';
let asIsReasonId = '';
let line1Id = '';
let line2Id = '';
let doneLineId = '';

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
      .values({ slug: 'adjust-test', name: 'Adjust Test Co', status: 'active' })
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
    await makeUser('owner@adjust-test.local', 'Owner');
    await makeUser('warehouse@adjust-test.local', 'Warehouse');
    await makeUser('cashier@adjust-test.local', 'Cashier');

    const loc = async (name: string, locationType: string) => {
      const [l] = await db
        .insert(schema.locations)
        .values({ businessId, name, timezone: 'America/Los_Angeles', locationType })
        .returning({ id: schema.locations.id });
      return l!.id;
    };
    warehouseId = await loc('Warehouse', 'warehouse');
    storeId = await loc('Culver City', 'store');

    const [pA] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'HEXMIC_FP-7680', name: 'E KING MIDNIGHT-LUXE' })
      .returning({ id: schema.products.id });
    const [vA] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: pA!.id,
        sku: 'HEXMIC_FP-7680',
        priceCents: 274900,
        costCents: 80300,
      })
      .returning({ id: schema.productVariants.id });
    variantAId = vA!.id;
    const [vAs] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: pA!.id,
        sku: 'HEXMIC_FP-7680-AS',
        name: 'As-Is',
        priceCents: 149900,
        costCents: 80300,
      })
      .returning({ id: schema.productVariants.id });
    asIsVariantId = vAs!.id;
    const [pB] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'BT2000LP-QN', name: 'QUEEN ADJUST BASE', serialTracked: true })
      .returning({ id: schema.products.id });
    const [vB] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: pB!.id, sku: 'BT2000LP-QN', priceCents: 99900 })
      .returning({ id: schema.productVariants.id });
    variantBId = vB!.id;

    await db.insert(schema.storageBins).values([
      { businessId, locationId: warehouseId, code: 'A-1' },
      { businessId, locationId: warehouseId, code: 'A-2' },
    ]);

    // 10 on hand, 3 reserved by two orders (2 + 1); a completed order too.
    await db.insert(schema.inventoryLevels).values([
      { businessId, variantId: variantAId, locationId: warehouseId, onHand: 10, reserved: 3 },
      { businessId, variantId: variantBId, locationId: warehouseId, onHand: 2 },
    ]);
    await db.insert(schema.costLayers).values({
      businessId,
      variantId: variantAId,
      locationId: warehouseId,
      sourceType: 'receive',
      quantityReceived: 10,
      quantityRemaining: 10,
      unitCostCents: 80300,
    });
    const serials = await db
      .insert(schema.serialUnits)
      .values([
        { businessId, variantId: variantBId, locationId: warehouseId, serial: 'S-1' },
        { businessId, variantId: variantBId, locationId: warehouseId, serial: 'S-2' },
        {
          businessId,
          variantId: variantBId,
          locationId: warehouseId,
          serial: 'S-3',
          status: 'sold',
        },
      ])
      .returning({ id: schema.serialUnits.id, serial: schema.serialUnits.serial });
    serial1Id = serials.find((s) => s.serial === 'S-1')!.id;
    serial3Id = serials.find((s) => s.serial === 'S-3')!.id;

    const codes = await db
      .insert(schema.reasonCodes)
      .values([
        { businessId, code: 'CNT', description: 'Cycle count', usageClass: 'inventory_adjustment' },
        { businessId, code: 'DMG', description: 'Damaged beyond sale', usageClass: 'write_off' },
        { businessId, code: 'MAN', description: 'Manufacturer defect', usageClass: 'as_is' },
      ])
      .returning({ id: schema.reasonCodes.id, code: schema.reasonCodes.code });
    adjustReasonId = codes.find((c) => c.code === 'CNT')!.id;
    writeOffReasonId = codes.find((c) => c.code === 'DMG')!.id;
    asIsReasonId = codes.find((c) => c.code === 'MAN')!.id;

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
    const line = async (orderId: string, quantity: number, qtyReserved: number, extra = {}) => {
      const [l] = await db
        .insert(schema.orderLines)
        .values({
          businessId,
          orderId,
          variantId: variantAId,
          description: 'E KING MIDNIGHT-LUXE',
          quantity,
          qtyReserved,
          unitPriceCents: 274900,
          totalCents: 274900 * quantity,
          ...extra,
        })
        .returning({ id: schema.orderLines.id });
      return l!.id;
    };
    line1Id = await line(await order('SO-1', 'open', { requestedDate: '2026-09-20' }), 2, 2);
    line2Id = await line(await order('SO-2', 'open', { requestedDate: '2026-09-15' }), 3, 1, {
      deliveryDate: '2026-09-14',
    });
    const doneId = await order('SO-DONE', 'completed', { completedAt: new Date() });
    doneLineId = await line(doneId, 1, 0, { qtyFulfilled: 1 });
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

async function level(variantId: string, locationId: string) {
  return withDb(async (db) => {
    const [row] = await db
      .select({
        onHand: schema.inventoryLevels.onHand,
        reserved: schema.inventoryLevels.reserved,
      })
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, variantId),
          eq(schema.inventoryLevels.locationId, locationId),
        ),
      );
    return row ?? { onHand: 0, reserved: 0 };
  });
}

async function lineReserved(lineId: string): Promise<number> {
  return withDb(async (db) => {
    const [row] = await db
      .select({ qtyReserved: schema.orderLines.qtyReserved })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, lineId));
    return row!.qtyReserved;
  });
}

const as = (cookie: string) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', cookie).set('X-Business-Id', businessId),
  post: (url: string) =>
    request(app.getHttpServer()).post(url).set('Cookie', cookie).set('X-Business-Id', businessId),
  patch: (url: string) =>
    request(app.getHttpServer()).patch(url).set('Cookie', cookie).set('X-Business-Id', businessId),
});

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'adjust-test-secret-adjust-test-secret-!!';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();
  ownerCookie = await captureCookie('owner@adjust-test.local');
  warehouseCookie = await captureCookie('warehouse@adjust-test.local');
  cashierCookie = await captureCookie('cashier@adjust-test.local');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('Stock card', () => {
  it('returns the header strip, the As-Is sibling, serials and bins for one variant at one location', async () => {
    const res = await as(ownerCookie)
      .get(`/v1/inventory/stock-card?variantId=${variantAId}&locationId=${warehouseId}`)
      .expect(200);
    expect(res.body).toMatchObject({
      sku: 'HEXMIC_FP-7680',
      locationName: 'Warehouse',
      onHand: 10,
      reserved: 3,
      floorSample: 0,
      available: 7,
      asIsOnHand: 0,
      costCents: 80300,
      serialTracked: false,
      asIsVariantId,
      asIsPieces: [],
      serials: [],
    });
    expect(res.body.bins.map((b: { code: string }) => b.code)).toEqual(['A-1', 'A-2']);

    const serialCard = await as(ownerCookie)
      .get(`/v1/inventory/stock-card?variantId=${variantBId}&locationId=${warehouseId}`)
      .expect(200);
    expect(serialCard.body.serialTracked).toBe(true);
    // The sold unit is not in the building any more.
    expect(serialCard.body.serials.map((s: { serial: string }) => s.serial)).toEqual([
      'S-1',
      'S-2',
    ]);
    await as(ownerCookie).get('/v1/inventory/stock-card').expect(400);
  });
});

describe('Quantity adjustment with reason code and unit cost', () => {
  it('layers an upward adjustment at the entered cost and stamps the reason code on the movement', async () => {
    const res = await as(warehouseCookie)
      .post('/v1/inventory/adjust')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        delta: 2,
        reason: 'count_correction',
        reasonCodeId: adjustReasonId,
        unitCostCents: 50000,
        notes: 'found two on the dock',
      })
      .expect(201);
    expect(res.body.onHand).toBe(12);
    await withDb(async (db) => {
      const [movement] = await db
        .select({ reasonCodeId: schema.inventoryMovements.reasonCodeId })
        .from(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.id, res.body.movementId));
      expect(movement!.reasonCodeId).toBe(adjustReasonId);
      const [layer] = await db
        .select({ unitCostCents: schema.costLayers.unitCostCents })
        .from(schema.costLayers)
        .where(
          and(
            eq(schema.costLayers.variantId, variantAId),
            eq(schema.costLayers.sourceType, 'adjustment'),
          ),
        )
        .orderBy(desc(schema.costLayers.receivedAt))
        .limit(1);
      expect(layer!.unitCostCents).toBe(50000);
    });
  });

  it('rejects a reason code of another class and a unit cost on a downward adjustment', async () => {
    await as(warehouseCookie)
      .post('/v1/inventory/adjust')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        delta: 1,
        reason: 'other',
        reasonCodeId: writeOffReasonId,
      })
      .expect(400);
    await as(warehouseCookie)
      .post('/v1/inventory/adjust')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        delta: -1,
        reason: 'damage',
        unitCostCents: 100,
      })
      .expect(400);
    expect((await level(variantAId, warehouseId)).onHand).toBe(12);
  });
});

describe('Write-off from stock', () => {
  it('needs the write-off permission: the warehouse role gets an override challenge', async () => {
    const res = await as(warehouseCookie)
      .post('/v1/inventory/write-off')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 1,
        reasonCodeId: writeOffReasonId,
      })
      .expect(403);
    expect(res.body.code).toBe('OVERRIDE_REQUIRED');
    expect((await level(variantAId, warehouseId)).onHand).toBe(12);
  });

  it('with the owner approving it: drops on hand, values the register at cost, files an exception', async () => {
    const res = await as(warehouseCookie)
      .post('/v1/inventory/write-off')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 2,
        reasonCodeId: writeOffReasonId,
        notes: 'forklift',
        override: { email: 'owner@adjust-test.local', password: PASSWORD },
      })
      .expect(201);
    expect(res.body).toMatchObject({ onHand: 10, totalCostCents: 160600 });
    const register = await as(ownerCookie).get('/v1/write-offs').expect(200);
    const rows = (register.body.items ?? register.body.rows ?? register.body) as {
      quantity: number;
      totalCostCents: number;
    }[];
    expect(rows.some((r) => r.quantity === 2 && r.totalCostCents === 160600)).toBe(true);
    await withDb(async (db) => {
      const [movement] = await db
        .select({
          reason: schema.inventoryMovements.reason,
          delta: schema.inventoryMovements.delta,
          reasonCodeId: schema.inventoryMovements.reasonCodeId,
        })
        .from(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.id, res.body.movementId));
      expect(movement).toMatchObject({
        reason: 'write_off',
        delta: -2,
        reasonCodeId: writeOffReasonId,
      });
      const exceptions = await db
        .select({ summary: schema.exceptionEvents.summary })
        .from(schema.exceptionEvents)
        .where(
          and(
            eq(schema.exceptionEvents.entityId, variantAId),
            eq(schema.exceptionEvents.type, 'write_off'),
          ),
        );
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0]!.summary).toMatch(
        /2 unit\(s\) written off from stock at cost \$1606.00/,
      );
    });
  });

  it('never takes reserved units: only the available count can go', async () => {
    // 10 on hand, 3 reserved → 7 available.
    const res = await as(ownerCookie)
      .post('/v1/inventory/write-off')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 8,
        reasonCodeId: writeOffReasonId,
      })
      .expect(400);
    expect(res.body.message).toMatch(/7 available/);
  });
});

describe('Move to As-Is from stock, As-Is adjustment (void), Move from As-Is', () => {
  let pieceIds: string[] = [];

  it('intake with fromStock decrements on hand and records the move on the ledger', async () => {
    const res = await as(warehouseCookie)
      .post('/v1/as-is')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 2,
        source: 'stock',
        fromStock: true,
        condition: 'light_wear',
        storageLocation: 'Rack B3',
        reasonCodeId: asIsReasonId,
      })
      .expect(201);
    expect(res.body).toMatchObject({ source: 'stock', status: 'pending_review', quantity: 1 });
    expect((await level(variantAId, warehouseId)).onHand).toBe(8);
    const card = await as(ownerCookie)
      .get(`/v1/inventory/stock-card?variantId=${variantAId}&locationId=${warehouseId}`)
      .expect(200);
    expect(card.body.asIsOnHand).toBe(2);
    expect(card.body.asIsPieces).toHaveLength(2);
    pieceIds = card.body.asIsPieces.map((p: { id: string }) => p.id);
    await withDb(async (db) => {
      const [movement] = await db
        .select({ delta: schema.inventoryMovements.delta })
        .from(schema.inventoryMovements)
        .where(
          and(
            eq(schema.inventoryMovements.variantId, variantAId),
            eq(schema.inventoryMovements.reason, 'as_is_intake'),
          ),
        );
      expect(movement!.delta).toBe(-2);
    });
  });

  it('refuses to move more than is available, and the walk-in intake still leaves stock alone', async () => {
    // 8 on hand, 3 reserved → 5 available.
    await as(warehouseCookie)
      .post('/v1/as-is')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 6,
        fromStock: true,
        reasonCodeId: asIsReasonId,
      })
      .expect(400);
    await as(warehouseCookie)
      .post('/v1/as-is')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 1,
        source: 'warranty',
        reasonCodeId: asIsReasonId,
      })
      .expect(201);
    expect((await level(variantAId, warehouseId)).onHand).toBe(8);
  });

  it('voids a piece back to stock, restocks another into the -AS variant, and refuses a second void', async () => {
    const voided = await as(warehouseCookie)
      .post(`/v1/as-is/${pieceIds[0]}/void`)
      .send({ reason: 'counted twice', returnToStock: true })
      .expect(201);
    expect(voided.body.status).toBe('voided');
    expect((await level(variantAId, warehouseId)).onHand).toBe(9);
    await as(warehouseCookie)
      .post(`/v1/as-is/${pieceIds[0]}/void`)
      .send({ reason: 'again' })
      .expect(400);
    await as(warehouseCookie).post(`/v1/as-is/${pieceIds[1]}/void`).send({}).expect(400);

    await as(warehouseCookie)
      .post(`/v1/as-is/${pieceIds[1]}/review`)
      .send({ action: 'restock', targetVariantId: asIsVariantId })
      .expect(201);
    expect((await level(asIsVariantId, warehouseId)).onHand).toBe(1);
    expect((await level(variantAId, warehouseId)).onHand).toBe(9);
  });
});

describe('Change serial', () => {
  it('renames an in-stock unit, refuses a duplicate and a sold unit', async () => {
    const res = await as(warehouseCookie)
      .patch(`/v1/serials/${serial1Id}`)
      .send({ serial: 'S-1B' })
      .expect(200);
    expect(res.body.serial).toBe('S-1B');
    await as(warehouseCookie).patch(`/v1/serials/${serial1Id}`).send({ serial: 'S-2' }).expect(409);
    await as(warehouseCookie).patch(`/v1/serials/${serial3Id}`).send({ serial: 'S-9' }).expect(400);
    await as(cashierCookie).patch(`/v1/serials/${serial1Id}`).send({ serial: 'S-1C' }).expect(403);
  });
});

describe('Reassign reservation', () => {
  it('lists the open lines wanting the item here with what each still lacks', async () => {
    const res = await as(cashierCookie)
      .get(`/v1/inventory/reservation-board?variantId=${variantAId}&locationId=${warehouseId}`)
      .expect(200);
    expect(res.body.strip).toEqual({ onHand: 9, reserved: 3, floorSample: 0, available: 6 });
    const rows = res.body.rows as {
      orderNumber: string;
      qtyReserved: number;
      shortfall: number;
      fillBy: string | null;
    }[];
    expect(rows.map((r) => r.orderNumber)).toEqual(['SO-1', 'SO-2']);
    expect(rows[0]).toMatchObject({ qtyReserved: 2, shortfall: 0, fillBy: '2026-09-20' });
    // The line's own delivery date beats the order's requested date.
    expect(rows[1]).toMatchObject({ qtyReserved: 1, shortfall: 2, fillBy: '2026-09-14' });
  });

  it('back-orders units off one line and reserves them on another, with the guards', async () => {
    const back = await as(cashierCookie)
      .post('/v1/inventory/reservations/move')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 1,
        action: 'back_order',
        fromLineId: line1Id,
      })
      .expect(201);
    expect(back.body.strip).toMatchObject({ reserved: 2, available: 7 });
    expect(await lineReserved(line1Id)).toBe(1);

    // More than the line holds.
    await as(cashierCookie)
      .post('/v1/inventory/reservations/move')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 5,
        action: 'back_order',
        fromLineId: line1Id,
      })
      .expect(400);
    // More than the target line lacks (SO-2 lacks 2).
    await as(cashierCookie)
      .post('/v1/inventory/reservations/move')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 3,
        action: 'reserve',
        toLineId: line2Id,
      })
      .expect(400);
    // A completed order cannot take units.
    await as(cashierCookie)
      .post('/v1/inventory/reservations/move')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 1,
        action: 'reserve',
        toLineId: doneLineId,
      })
      .expect(400);

    const reserve = await as(cashierCookie)
      .post('/v1/inventory/reservations/move')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 2,
        action: 'reserve',
        toLineId: line2Id,
      })
      .expect(201);
    expect(reserve.body.strip).toMatchObject({ reserved: 4, available: 5 });
    expect(await lineReserved(line2Id)).toBe(3);
    expect((await level(variantAId, warehouseId)).reserved).toBe(4);
  });

  it('moves units between orders in one request even when nothing is free', async () => {
    // Nail everything down: 9 on hand, 4 reserved → 5 free; take the free
    // units out with a floor hold so the move has to come from SO-2.
    await as(ownerCookie)
      .post('/v1/inventory/levels/floor-sample')
      .send({ variantId: variantAId, locationId: warehouseId, quantity: 5 })
      .expect(201);
    await as(cashierCookie)
      .post('/v1/inventory/reservations/move')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 1,
        action: 'reserve',
        toLineId: line1Id,
      })
      .expect(400);
    const moved = await as(cashierCookie)
      .post('/v1/inventory/reservations/move')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 1,
        action: 'reserve',
        toLineId: line1Id,
        fromLineId: line2Id,
      })
      .expect(201);
    expect(moved.body.strip).toMatchObject({ reserved: 4, floorSample: 5, available: 0 });
    expect(await lineReserved(line1Id)).toBe(2);
    expect(await lineReserved(line2Id)).toBe(2);
    // The warehouse role cannot touch orders.
    await as(warehouseCookie)
      .post('/v1/inventory/reservations/move')
      .send({
        variantId: variantAId,
        locationId: warehouseId,
        quantity: 1,
        action: 'back_order',
        fromLineId: line1Id,
      })
      .expect(403);
  });
});
