/**
 * Epic 1.8 acceptance: receiving 10 units of variant X at location Y
 * increases inventory_levels.on_hand by 10 and writes a single
 * inventory_movements row.
 *
 * Also exercises manual adjust with reason validation, levels view,
 * permissions (cashier inventory.view only), and the audit log.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.INVENTORY_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_inventory';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'InvPass!2026';

let app: INestApplication;
let businessId = '';
let locationId = '';
let variantId = '';
let inventoryClerkCookie = '';
let cashierCookie = '';
let ownerCookie = '';

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
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'inv-test', name: 'Inventory Test Co', status: 'active' })
      .returning();
    businessId = biz!.id;

    const roles = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      const [r] = await db
        .insert(schema.roles)
        .values({
          businessId,
          name: role.name,
          description: role.description,
          isSystem: true,
        })
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
    await makeUser('owner@inv-test.local', 'Owner');
    await makeUser('clerk@inv-test.local', 'Warehouse');
    await makeUser('cashier@inv-test.local', 'Cashier');

    const [loc] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Main Store', timezone: 'America/New_York' })
      .returning();
    locationId = loc!.id;

    // The count sheet carries the brand and the group (owner 2026-11-04).
    const [brand] = await db
      .insert(schema.brands)
      .values({ businessId, name: 'Xbrand' })
      .returning();
    const [group] = await db
      .insert(schema.categories)
      .values({ businessId, name: 'Xgroup' })
      .returning();
    const [product] = await db
      .insert(schema.products)
      .values({
        businessId,
        sku: 'X-001',
        name: 'Variant X',
        brandId: brand!.id,
        categoryId: group!.id,
      })
      .returning();
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: product!.id,
        sku: 'X-001-V1',
        priceCents: 1000,
      })
      .returning();
    variantId = variant!.id;
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
  process.env.BETTER_AUTH_SECRET ??= 'inventory-test-secret-inventory-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();

  ownerCookie = await captureCookie('owner@inv-test.local');
  inventoryClerkCookie = await captureCookie('clerk@inv-test.local');
  cashierCookie = await captureCookie('cashier@inv-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

async function lookupLevel(): Promise<{
  onHand: number;
  reserved: number;
  movementCount: number;
}> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const [level] = await db
      .select()
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, variantId),
          eq(schema.inventoryLevels.locationId, locationId),
        ),
      );
    const movements = await db
      .select()
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.variantId, variantId));
    return {
      onHand: level?.onHand ?? 0,
      reserved: level?.reserved ?? 0,
      movementCount: movements.length,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe('Epic 1.8 — Inventory', () => {
  it('Initial level is empty', async () => {
    const before = await lookupLevel();
    expect(before.onHand).toBe(0);
    expect(before.movementCount).toBe(0);
  });

  it('Receiving 10 units increases on_hand by 10 + writes one movement row', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/inventory/receive')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        notes: 'Initial PO',
        lines: [{ variantId, quantity: 10 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].onHand).toBe(10);

    const after = await lookupLevel();
    expect(after.onHand).toBe(10);
    expect(after.movementCount).toBe(1);

    // Movement row carries reason='receive' and the actor.
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    try {
      const [m] = await db
        .select()
        .from(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.variantId, variantId));
      expect(m!.reason).toBe('receive');
      expect(m!.delta).toBe(10);
      expect(m!.notes).toBe('Initial PO');
      expect(m!.actorUserId).toBeTruthy();
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  it('Receiving another 5 stacks on top + writes a second movement', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/inventory/receive')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, lines: [{ variantId, quantity: 5 }] });
    expect(res.status).toBe(201);
    const after = await lookupLevel();
    expect(after.onHand).toBe(15);
    expect(after.movementCount).toBe(2);
  });

  it('Manual adjust with reason "damage" subtracts and audit-logs', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/inventory/adjust')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId, locationId, delta: -3, reason: 'damage', notes: '3 units broken' });
    expect(res.status).toBe(201);
    expect(res.body.onHand).toBe(12);

    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    try {
      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'inventory.adjust'));
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const last = audits.at(-1)!;
      expect(last.changesJson).toMatchObject({
        metadata: { delta: -3, reason: 'damage', locationId },
      });
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  it('Adjust with an invalid reason returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/inventory/adjust')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId, locationId, delta: 1, reason: 'lol' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/count_correction/);
  });

  it('Adjust below zero clamps on_hand to 0 (sanity / count correction)', async () => {
    // Current on_hand is 12; subtract 1000 to test the GREATEST(0, …) floor.
    const res = await request(app.getHttpServer())
      .post('/v1/inventory/adjust')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId, locationId, delta: -1000, reason: 'count_correction' });
    expect(res.status).toBe(201);
    expect(res.body.onHand).toBe(0);
  });

  it('Levels endpoint returns joined product + variant info', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/inventory/levels?locationId=${locationId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    expect(row.variantId).toBe(variantId);
    expect(row.locationId).toBe(locationId);
    expect(row.productName).toBe('Variant X');
    expect(row.variantSku).toBe('X-001-V1');
    expect(row.onHand).toBe(0);
    expect(row.available).toBe(0);
  });

  it('Cashier (inventory.view only) can list but cannot adjust or receive', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/inventory/levels')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);

    const adjust = await request(app.getHttpServer())
      .post('/v1/inventory/adjust')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId, locationId, delta: 1, reason: 'count_correction' });
    expect(adjust.status).toBe(403);
    expect(adjust.body.message).toMatch(/inventory\.adjust/);

    const receive = await request(app.getHttpServer())
      .post('/v1/inventory/receive')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, lines: [{ variantId, quantity: 1 }] });
    expect(receive.status).toBe(403);
    expect(receive.body.message).toMatch(/inventory\.receive/);
  });

  it('Movements endpoint returns the ledger newest-first with the actor email', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/inventory/movements?variantId=${variantId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(4); // 2 receives + 2 adjusts
    const reasons = (res.body.data as Array<{ reason: string }>).map((m) => m.reason);
    expect(reasons).toContain('receive');
    expect(reasons).toContain('damage');
    expect(reasons).toContain('count_correction');
    const first = res.body.data[0];
    expect(first.actorEmail).toBe('clerk@inv-test.local');
  });
});

describe('Storage bins', () => {
  let binId = '';

  it('Clerk creates a bin; duplicate code at same location 409s', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/inventory/bins')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, code: 'a-14', description: 'Aisle A shelf 14' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('A-14'); // normalized upper-case
    binId = res.body.id as string;

    const dup = await request(app.getHttpServer())
      .post('/v1/inventory/bins')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, code: 'A-14' });
    expect(dup.status).toBe(409);
  });

  it('Cashier (no inventory.adjust) cannot create bins', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/inventory/bins')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, code: 'NOPE' });
    expect(res.status).toBe(403);
  });

  it('Assign a bin to a stock level; levels list carries the code', async () => {
    const assign = await request(app.getHttpServer())
      .post('/v1/inventory/levels/assign-bin')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId, locationId, storageBinId: binId });
    expect(assign.status).toBe(201);

    const levels = await request(app.getHttpServer())
      .get(`/v1/inventory/levels?locationId=${locationId}`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    expect(levels.status).toBe(200);
    const row = (
      levels.body as {
        variantId: string;
        storageBinId: string | null;
        storageBinCode: string | null;
      }[]
    ).find((l) => l.variantId === variantId);
    expect(row?.storageBinId).toBe(binId);
    expect(row?.storageBinCode).toBe('A-14');
  });

  it('Bin must belong to the level location; inactive bins refused; unbin works', async () => {
    const [other] = await request(app.getHttpServer())
      .post('/v1/inventory/bins')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, code: 'DOCK' })
      .then((r) => [r.body as { id: string }]);

    // Deactivate DOCK, then try to assign it.
    const off = await request(app.getHttpServer())
      .patch(`/v1/inventory/bins/${other.id}`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ isActive: false });
    expect(off.status).toBe(200);
    const inactive = await request(app.getHttpServer())
      .post('/v1/inventory/levels/assign-bin')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId, locationId, storageBinId: other.id });
    expect(inactive.status).toBe(400);

    // Clear the assignment.
    const clear = await request(app.getHttpServer())
      .post('/v1/inventory/levels/assign-bin')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId, locationId, storageBinId: null });
    expect(clear.status).toBe(201);
    const levels = await request(app.getHttpServer())
      .get(`/v1/inventory/levels?locationId=${locationId}`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    const row = (levels.body as { variantId: string; storageBinId: string | null }[]).find(
      (l) => l.variantId === variantId,
    );
    expect(row?.storageBinId).toBeNull();
  });
});

describe('Inventory search — GET /v1/inventory/levels?q=', () => {
  it('Filters levels by product text and returns nothing for a non-match', async () => {
    const all = await request(app.getHttpServer())
      .get(`/v1/inventory/levels?locationId=${locationId}`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    expect(all.status).toBe(200);
    expect((all.body as unknown[]).length).toBeGreaterThan(0);
    const first = (all.body as { variantSku: string | null; productName: string }[])[0]!;
    const needle = first.variantSku ?? first.productName;

    const hit = await request(app.getHttpServer())
      .get(`/v1/inventory/levels?locationId=${locationId}&q=${encodeURIComponent(needle)}`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    expect(hit.status).toBe(200);
    expect((hit.body as unknown[]).length).toBeGreaterThan(0);

    const miss = await request(app.getHttpServer())
      .get(`/v1/inventory/levels?locationId=${locationId}&q=zzz-no-such-sku`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    expect(miss.status).toBe(200);
    expect(miss.body).toHaveLength(0);
  });
});

describe('Physical counts — soft-freeze lifecycle', () => {
  let countId = '';
  let reasonCodeId = '';
  let variantYId = '';

  async function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      return await fn(drizzle(sql));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it('Cashier cannot start a count; a stockless location refuses to freeze', async () => {
    const forbidden = await request(app.getHttpServer())
      .post('/v1/inventory/counts')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId });
    expect(forbidden.status).toBe(403);

    // Everything was adjusted back to zero earlier in this spec.
    const empty = await request(app.getHttpServer())
      .post('/v1/inventory/counts')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toMatch(/No stock to count/);
  });

  it('Freeze snapshots the levels and blocks a second concurrent count', async () => {
    await request(app.getHttpServer())
      .post('/v1/inventory/receive')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, lines: [{ variantId, quantity: 8 }] })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post('/v1/inventory/counts')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId, notes: 'August count' });
    expect(created.status).toBe(201);
    expect(created.body.lineCount).toBe(1);
    countId = created.body.id as string;

    const dup = await request(app.getHttpServer())
      .post('/v1/inventory/counts')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId });
    expect(dup.status).toBe(409);

    const detail = await request(app.getHttpServer())
      .get(`/v1/inventory/counts/${countId}`)
      .set('Cookie', cashierCookie) // inventory.view is enough to look
      .set('X-Business-Id', businessId);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('open');
    expect(detail.body.lines).toHaveLength(1);
    expect(detail.body.lines[0].frozenQty).toBe(8);
    expect(detail.body.lines[0].countedQty).toBeNull();
    expect(detail.body.lines[0].brandName).toBe('Xbrand');
    expect(detail.body.lines[0].groupName).toBe('Xgroup');
  });

  it('A mid-count sale is netted out: variance = counted − (frozen + delta)', async () => {
    // The store keeps selling during the count: 2 units leave the ledger.
    await request(app.getHttpServer())
      .post('/v1/inventory/adjust')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ variantId, locationId, delta: -2, reason: 'damage' })
      .expect(201);

    const premature = await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${countId}/post`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(premature.status).toBe(400);
    expect(premature.body.message).toMatch(/uncounted/);

    const entered = await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${countId}/lines`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ entries: [{ variantId, countedQty: 5 }] });
    expect(entered.status).toBe(201);
    expect(entered.body.updated).toBe(1);

    const detail = await request(app.getHttpServer())
      .get(`/v1/inventory/counts/${countId}`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    expect(detail.body.status).toBe('counting');
    const line = detail.body.lines[0];
    expect(line.postFreezeDelta).toBe(-2);
    // Expected on the floor is 8 − 2 = 6; counted 5 → one unit short.
    expect(line.variance).toBe(-1);
  });

  it('Posting requires a coded reason once the class has codes, then flips the level', async () => {
    const code = await request(app.getHttpServer())
      .post('/v1/reason-codes')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ code: 'SHRINK', description: 'Shrinkage', usageClass: 'physical_variance' });
    expect(code.status).toBe(201);
    reasonCodeId = code.body.id as string;

    const uncoded = await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${countId}/post`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(uncoded.status).toBe(400);
    expect(uncoded.body.message).toMatch(/reason code is required/);

    const posted = await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${countId}/post`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ reasonCodeId });
    expect(posted.status).toBe(201);
    expect(posted.body).toEqual({ posted: 1, skipped: 0, varianceUnits: 1 });

    const level = await lookupLevel();
    expect(level.onHand).toBe(5);

    await withDb(async (db) => {
      const movements = await db
        .select()
        .from(schema.inventoryMovements)
        .where(eq(schema.inventoryMovements.reason, 'physical_count'));
      expect(movements).toHaveLength(1);
      expect(movements[0]!.delta).toBe(-1);
      expect(movements[0]!.referenceId).toBe(countId);
    });

    const detail = await request(app.getHttpServer())
      .get(`/v1/inventory/counts/${countId}`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    expect(detail.body.status).toBe('posted');
    expect(detail.body.lines[0].postedVariance).toBe(-1);
  });

  it('Found stock gets a zero-frozen line; uncounted lines can be skipped unchanged', async () => {
    variantYId = await withDb(async (db) => {
      const [x] = await db
        .select({ productId: schema.productVariants.productId })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, variantId));
      const [y] = await db
        .insert(schema.productVariants)
        .values({ businessId, productId: x!.productId, sku: 'X-001-V2', priceCents: 2000 })
        .returning();
      return y!.id;
    });

    const created = await request(app.getHttpServer())
      .post('/v1/inventory/counts')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId });
    expect(created.status).toBe(201);
    expect(created.body.lineCount).toBe(1); // only variant X has stock
    const secondCountId = created.body.id as string;

    // Variant Y turns up on the floor even though it was never in the snapshot.
    await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${secondCountId}/lines`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ entries: [{ variantId: variantYId, countedQty: 3 }] })
      .expect(201);

    const posted = await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${secondCountId}/post`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ reasonCodeId, skipUncounted: true });
    expect(posted.status).toBe(201);
    expect(posted.body).toEqual({ posted: 1, skipped: 1, varianceUnits: 3 });

    await withDb(async (db) => {
      const [levelY] = await db
        .select()
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantYId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
      expect(levelY?.onHand).toBe(3);
    });
    // Skipped variant X is untouched.
    expect((await lookupLevel()).onHand).toBe(5);
  });

  it('A shortage below reservations records a critical exception, reservations intact', async () => {
    await withDb(async (db) => {
      await db
        .update(schema.inventoryLevels)
        .set({ reserved: 4 })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
    });

    const created = await request(app.getHttpServer())
      .post('/v1/inventory/counts')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId });
    expect(created.status).toBe(201);
    const shortCountId = created.body.id as string;

    await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${shortCountId}/lines`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ entries: [{ variantId, countedQty: 2 }] })
      .expect(201);

    const posted = await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${shortCountId}/post`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ reasonCodeId, skipUncounted: true });
    expect(posted.status).toBe(201);

    await withDb(async (db) => {
      const [level] = await db
        .select()
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
      expect(level?.onHand).toBe(2);
      expect(level?.reserved).toBe(4); // never touched by the count

      const events = await db
        .select()
        .from(schema.exceptionEvents)
        .where(eq(schema.exceptionEvents.type, 'physical_commitment'));
      expect(events).toHaveLength(1);
      expect(events[0]!.severity).toBe('critical');
      expect(events[0]!.entityId).toBe(shortCountId);

      // Clean up the artificial reservation for any later specs.
      await db
        .update(schema.inventoryLevels)
        .set({ reserved: 0 })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, variantId),
            eq(schema.inventoryLevels.locationId, locationId),
          ),
        );
    });
  });

  it('Cancel releases the location without touching stock', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/inventory/counts')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId });
    expect(created.status).toBe(201);
    const cancelId = created.body.id as string;

    const cancelled = await request(app.getHttpServer())
      .post(`/v1/inventory/counts/${cancelId}/cancel`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId)
      .send({});
    expect(cancelled.status).toBe(201);

    const detail = await request(app.getHttpServer())
      .get(`/v1/inventory/counts/${cancelId}`)
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    expect(detail.body.status).toBe('cancelled');
    expect((await lookupLevel()).onHand).toBe(2);

    const list = await request(app.getHttpServer())
      .get('/v1/inventory/counts')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);
    expect((list.body.data as { status: string }[]).length).toBe(4);
    expect(list.body.nextCursor).toBeNull();
  });
});
