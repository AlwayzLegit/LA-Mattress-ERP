/**
 * Amendment A22 slice 2 — STORIS "Enter a Transfer" fields (reason code,
 * delivery information, complete-on-create, several destinations) and
 * "Report Transfers by Location" (json / csv / txt / Basic PDF).
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
  process.env.TRANSFERS_SWEEP_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_transfers_sweep';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'SweepPass!2026';

let app: INestApplication;
let businessId = '';
let ownerCookie = '';
let cashierCookie = '';
let warehouseId = '';
let storeAId = '';
let storeBId = '';
let variantAId = '';
let variantBId = '';
let serialId = '';
let transferReasonId = '';
let asIsReasonId = '';
const today = new Date().toISOString().slice(0, 10);

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
      .values({ slug: 'sweep-test', name: 'Sweep Test Co', status: 'active' })
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
    await makeUser('owner@sweep-test.local', 'Owner');
    await makeUser('cashier@sweep-test.local', 'Cashier');

    const loc = async (name: string, locationType: string) => {
      const [l] = await db
        .insert(schema.locations)
        .values({ businessId, name, timezone: 'America/Los_Angeles', locationType })
        .returning({ id: schema.locations.id });
      return l!.id;
    };
    warehouseId = await loc('Warehouse', 'warehouse');
    storeAId = await loc('Culver City', 'store');
    storeBId = await loc('Pasadena', 'store');

    const [brand] = await db
      .insert(schema.brands)
      .values({ businessId, name: 'HELIX' })
      .returning({ id: schema.brands.id });
    const [pA] = await db
      .insert(schema.products)
      .values({
        businessId,
        sku: 'HEXMIC_FP-7680',
        name: 'E KING MIDNIGHT-LUXE',
        brandId: brand!.id,
      })
      .returning({ id: schema.products.id });
    const [vA] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: pA!.id,
        sku: 'HEXMIC_FP-7680',
        vendorSku: 'HEXMIC_FP-7680',
        priceCents: 274900,
        costCents: 80300,
      })
      .returning({ id: schema.productVariants.id });
    variantAId = vA!.id;
    const [pB] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'BT2000LP-QN', name: 'QUEEN ADJUST BASE', serialTracked: true })
      .returning({ id: schema.products.id });
    const [vB] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: pB!.id, sku: 'BT2000LP-QN', priceCents: 99900 })
      .returning({ id: schema.productVariants.id });
    variantBId = vB!.id;
    await db.insert(schema.inventoryLevels).values([
      { businessId, variantId: variantAId, locationId: warehouseId, onHand: 40 },
      { businessId, variantId: variantBId, locationId: warehouseId, onHand: 5 },
    ]);
    const [su] = await db
      .insert(schema.serialUnits)
      .values({ businessId, variantId: variantBId, locationId: warehouseId, serial: 'S-1' })
      .returning({ id: schema.serialUnits.id });
    serialId = su!.id;
    const [rc] = await db
      .insert(schema.reasonCodes)
      .values({ businessId, code: 'RESTOCK', description: 'Store restock', usageClass: 'transfer' })
      .returning({ id: schema.reasonCodes.id });
    transferReasonId = rc!.id;
    const [rc2] = await db
      .insert(schema.reasonCodes)
      .values({ businessId, code: 'MAN', description: 'Manufacturer defect', usageClass: 'as_is' })
      .returning({ id: schema.reasonCodes.id });
    asIsReasonId = rc2!.id;
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

async function onHand(variantId: string, locationId: string): Promise<number> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const [row] = await db
      .select({ onHand: schema.inventoryLevels.onHand })
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, variantId),
          eq(schema.inventoryLevels.locationId, locationId),
        ),
      );
    return row?.onHand ?? 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const as = (cookie: string) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', cookie).set('X-Business-Id', businessId),
  post: (url: string) =>
    request(app.getHttpServer()).post(url).set('Cookie', cookie).set('X-Business-Id', businessId),
});

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'sweep-test-secret-sweep-test-secret-!!';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();
  ownerCookie = await captureCookie('owner@sweep-test.local');
  cashierCookie = await captureCookie('cashier@sweep-test.local');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

const line = (variantId: string, quantity: number, quantityOrdered?: number) => ({
  variantId,
  quantity,
  ...(quantityOrdered ? { quantityOrdered } : {}),
});

describe('Enter a Transfer — A22 fields', () => {
  it('stores the reason code and delivery information and echoes them on the detail', async () => {
    const res = await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationId: storeAId,
        transferType: 'replenishment',
        reasonCodeId: transferReasonId,
        scheduledFor: '2026-09-20',
        route: 'Westside AM',
        shipDirect: true,
        fulfillmentInstructions: 'Call ahead; back door.',
        lines: [line(variantAId, 2, 4)],
      })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'draft',
      reasonCode: { code: 'RESTOCK', description: 'Store restock' },
      scheduledFor: '2026-09-20',
      route: 'Westside AM',
      shipDirect: true,
      fulfillmentInstructions: 'Call ahead; back door.',
    });
    expect(res.body.createdTransfers).toBeUndefined();
    const again = await as(ownerCookie).get(`/v1/stock-transfers/${res.body.id}`).expect(200);
    expect(again.body.reasonCode.code).toBe('RESTOCK');
    expect(again.body.lines[0]).toMatchObject({ quantityShipped: 2, quantityHeld: 2 });
  });

  it('rejects a reason code of another class and a malformed date', async () => {
    await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationId: storeAId,
        reasonCodeId: asIsReasonId,
        lines: [line(variantAId, 1)],
      })
      .expect(400);
    await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationId: storeAId,
        scheduledFor: '20-09-2026',
        lines: [line(variantAId, 1)],
      })
      .expect(400);
  });

  it('fans out to several destinations, splitting or duplicating the lines', async () => {
    const split = await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationIds: [storeAId, storeBId],
        distributeQuantities: true,
        lines: [line(variantAId, 5, 7)],
      })
      .expect(201);
    expect(split.body.createdTransfers).toHaveLength(2);
    const [first, second] = split.body.createdTransfers as { id: string; toLocationId: string }[];
    expect(first!.toLocationId).toBe(storeAId);
    expect(second!.toLocationId).toBe(storeBId);
    const a = await as(ownerCookie).get(`/v1/stock-transfers/${first!.id}`).expect(200);
    const b = await as(ownerCookie).get(`/v1/stock-transfers/${second!.id}`).expect(200);
    // 5 → 3 + 2; 7 ordered → 4 + 3.
    expect(a.body.lines[0]).toMatchObject({ quantityShipped: 3, quantityOrdered: 4 });
    expect(b.body.lines[0]).toMatchObject({ quantityShipped: 2, quantityOrdered: 3 });

    const dup = await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationIds: [storeAId, storeBId],
        lines: [line(variantAId, 4)],
      })
      .expect(201);
    for (const t of dup.body.createdTransfers as { id: string }[]) {
      const d = await as(ownerCookie).get(`/v1/stock-transfers/${t.id}`).expect(200);
      expect(d.body.lines[0].quantityShipped).toBe(4);
    }
    // One unit cannot be split two ways; serial picks cannot fan out.
    await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationIds: [storeAId, storeBId],
        distributeQuantities: true,
        lines: [line(variantAId, 1)],
      })
      .expect(400);
    await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationIds: [storeAId, storeBId],
        lines: [{ variantId: variantBId, quantity: 1, serialIds: [serialId] }],
      })
      .expect(400);
  });

  it('completes a transfer in one step — shipped and received — even with the ticket gate on', async () => {
    // The default gate still blocks a plain create + ship.
    await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationId: storeBId,
        ship: true,
        lines: [line(variantAId, 1)],
      })
      .expect(400);
    const before = await onHand(variantAId, storeBId);
    const res = await as(ownerCookie)
      .post('/v1/stock-transfers')
      .send({
        fromLocationId: warehouseId,
        toLocationId: storeBId,
        complete: true,
        notes: 'Already moved on the van',
        lines: [line(variantAId, 3)],
      })
      .expect(201);
    expect(res.body.status).toBe('received');
    expect(res.body.shippedAt).toBeTruthy();
    expect(res.body.receivedAt).toBeTruthy();
    expect(res.body.lines[0]).toMatchObject({ quantityShipped: 3, quantityReceived: 3 });
    expect(await onHand(variantAId, storeBId)).toBe(before + 3);
  });
});

describe('Report Transfers by Location (A22 slice 2)', () => {
  it('groups transfer lines by receiving store with order / reserved / held quantities', async () => {
    const res = await as(ownerCookie).get('/v1/reports/transfers-by-location').expect(200);
    const groups = res.body.groups as {
      locationName: string;
      transfers: { number: string; transferFor: string; lines: { heldQty: number }[] }[];
      totals: { transfers: number; heldQty: number };
    }[];
    expect(groups.map((g) => g.locationName)).toEqual(['Culver City', 'Pasadena']);
    const culver = groups[0]!;
    // Draft (2 of 4) + split (3 of 4) + duplicate (4): held 2 + 1 + 0.
    expect(culver.totals).toMatchObject({ transfers: 3, heldQty: 3 });
    expect(culver.transfers[0]).toMatchObject({ transferFor: 'STOCK' });
    expect(res.body.totals.transfers).toBe(6);
    expect(res.body.filters).toMatchObject({ reserveLevel: 'all', includeInstructions: false });
  });

  it('filters by reserve level, location and date', async () => {
    const partial = await as(ownerCookie)
      .get('/v1/reports/transfers-by-location?reserveLevel=partial')
      .expect(200);
    expect(partial.body.totals.transfers).toBe(3);
    expect(partial.body.totals.heldQty).toBe(4);
    const full = await as(ownerCookie)
      .get('/v1/reports/transfers-by-location?reserveLevel=full')
      .expect(200);
    expect(full.body.totals.transfers).toBe(3);
    expect(full.body.totals.heldQty).toBe(0);
    const pasadena = await as(ownerCookie)
      .get(`/v1/reports/transfers-by-location?toLocationId=${storeBId}`)
      .expect(200);
    expect(pasadena.body.groups).toHaveLength(1);
    expect(pasadena.body.groups[0].locationName).toBe('Pasadena');
    const none = await as(ownerCookie)
      .get(`/v1/reports/transfers-by-location?fromLocationId=${storeAId}`)
      .expect(200);
    expect(none.body.groups).toHaveLength(0);
    const dated = await as(ownerCookie)
      .get(`/v1/reports/transfers-by-location?start=${today}&end=${today}`)
      .expect(200);
    expect(dated.body.totals.transfers).toBe(6);
    const past = await as(ownerCookie)
      .get('/v1/reports/transfers-by-location?start=2020-01-01&end=2020-01-31')
      .expect(200);
    expect(past.body.groups).toHaveLength(0);
    await as(ownerCookie).get('/v1/reports/transfers-by-location?reserveLevel=bogus').expect(400);
    await as(ownerCookie).get('/v1/reports/transfers-by-location?start=2026-1-1').expect(400);
    await as(cashierCookie).get('/v1/reports/transfers-by-location').expect(403);
  });

  it('spools csv, text and the Basic PDF', async () => {
    const csv = await as(ownerCookie)
      .get('/v1/reports/transfers-by-location?format=csv&includeInstructions=1')
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const rows = csv.text.trim().split('\n');
    expect(rows[0]).toContain('receiving_location,transfer_number');
    expect(rows[0]).toContain('instructions,notes');
    expect(rows).toHaveLength(7);
    const txt = await as(ownerCookie)
      .get('/v1/reports/transfers-by-location?format=txt&includeInstructions=1')
      .expect(200);
    expect(txt.headers['content-type']).toContain('text/plain');
    expect(txt.text).toContain('Reference: TE.324.RPT');
    expect(txt.text).toContain('Report Transfers by Location');
    expect(txt.text).toContain('Receiving Store:  CULVER CITY');
    expect(txt.text).toContain('Vendor Model: HEXMIC_FP-7680');
    expect(txt.text).toContain('Instructions: Call ahead; back door.');
    expect(txt.text).toContain('Grand Total:');
    const pdf = await as(ownerCookie)
      .get('/v1/reports/transfers-by-location?format=pdf')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    await as(ownerCookie).get('/v1/reports/transfers-by-location?format=xlsx').expect(400);
  });
});
