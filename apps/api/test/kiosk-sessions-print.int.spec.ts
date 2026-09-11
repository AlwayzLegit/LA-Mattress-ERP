/**
 * Amendment A22 slice 7 — STORIS Access Time Clock (shared-terminal
 * kiosk punch with credential re-auth), Recover STORIS Licenses
 * (Settings → Active sessions, tenant-wide, sign out) and Print a
 * Purchase Order (print tracking + batch-print list filters).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
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
  process.env.KIOSK_SESSIONS_PRINT_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_kiosk_sessions_print';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'KioskPass!2026';
const OTHER_PASSWORD = 'OtherPass!2026';

let app: INestApplication;
let businessId = '';
let otherBusinessId = '';
let ownerCookie = '';
let cashierCookie = '';
let bookkeeperCookie = '';
let outsiderCookie = '';
let warehouseMembershipId = '';
let warehouseId = '';
let storeId = '';
let vendorId = '';
let variantId = '';
let poOrderedId = '';
let poDirectId = '';

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
    const otherHash = await hashPassword(OTHER_PASSWORD);
    const makeBusiness = async (slug: string, name: string) => {
      const [biz] = await db
        .insert(schema.businesses)
        .values({ slug, name, status: 'active' })
        .returning();
      const roles = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const [r] = await db
          .insert(schema.roles)
          .values({
            businessId: biz!.id,
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
      return { id: biz!.id, roles };
    };
    const main = await makeBusiness('kiosk-test', 'Kiosk Test Co');
    businessId = main.id;
    const other = await makeBusiness('other-co', 'Other Co');
    otherBusinessId = other.id;

    async function makeUser(
      email: string,
      biz: { id: string; roles: Map<string, string> },
      role: string,
      name: string,
      hash = passwordHash,
    ) {
      const [u] = await db
        .insert(schema.users)
        .values({ email, emailVerified: true, name })
        .returning();
      await db.insert(schema.accounts).values({
        accountId: u!.id,
        providerId: 'credential',
        userId: u!.id,
        password: hash,
      });
      const [m] = await db
        .insert(schema.memberships)
        .values({
          businessId: biz.id,
          userId: u!.id,
          roleId: biz.roles.get(role)!,
          status: 'active',
          acceptedAt: new Date(),
        })
        .returning({ id: schema.memberships.id });
      return m!.id;
    }
    await makeUser('owner@kiosk-test.local', main, 'Owner', 'Olive Owner');
    await makeUser('cashier@kiosk-test.local', main, 'Cashier', 'Casey Cashier');
    warehouseMembershipId = await makeUser(
      'wally@kiosk-test.local',
      main,
      'Warehouse',
      'Wally Warehouse',
      otherHash,
    );
    await makeUser('books@kiosk-test.local', main, 'Bookkeeper', 'Bea Books');
    await makeUser('outsider@other-co.local', other, 'Owner', 'Oscar Outsider');

    const loc = async (name: string, locationType: string) => {
      const [l] = await db
        .insert(schema.locations)
        .values({ businessId, name, timezone: 'America/Los_Angeles', locationType })
        .returning({ id: schema.locations.id });
      return l!.id;
    };
    warehouseId = await loc('Warehouse', 'warehouse');
    storeId = await loc('Culver City', 'store');

    const [vendor] = await db
      .insert(schema.vendors)
      .values({ businessId, name: 'Helix' })
      .returning({ id: schema.vendors.id });
    vendorId = vendor!.id;
    const [product] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'KING-SET', name: 'KING SET' })
      .returning({ id: schema.products.id });
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: product!.id,
        sku: 'KING-SET',
        priceCents: 50000,
        costCents: 20000,
      })
      .returning({ id: schema.productVariants.id });
    variantId = variant!.id;
    const po = async (number: string, locationId: string, directShip: boolean) => {
      const [row] = await db
        .insert(schema.purchaseOrders)
        .values({
          businessId,
          vendorId,
          locationId,
          number,
          status: 'ordered',
          placedAt: new Date(),
          directShip,
          subtotalCents: 20000,
        })
        .returning({ id: schema.purchaseOrders.id });
      await db.insert(schema.purchaseOrderLines).values({
        businessId,
        purchaseOrderId: row!.id,
        variantId,
        quantityOrdered: 1,
        unitCostCents: 20000,
        lineTotalCents: 20000,
      });
      return row!.id;
    };
    poOrderedId = await po('PO-A', warehouseId, false);
    poDirectId = await po('PO-B', storeId, true);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function captureCookie(email: string, password = PASSWORD): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .send({ email, password })
    .expect(200);
  const cookies = res.get('Set-Cookie') ?? [];
  const sessionCookie = cookies
    .map((c) => c.split(';')[0])
    .filter((c): c is string => Boolean(c?.startsWith('jetnine.session_token=')))
    .find((c) => !c.endsWith('='));
  if (!sessionCookie) throw new Error(`no session cookie for ${email}`);
  return sessionCookie;
}

const as = (cookie: string, biz = businessId) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', cookie).set('X-Business-Id', biz),
  post: (url: string) =>
    request(app.getHttpServer()).post(url).set('Cookie', cookie).set('X-Business-Id', biz),
  delete: (url: string) =>
    request(app.getHttpServer()).delete(url).set('Cookie', cookie).set('X-Business-Id', biz),
});

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'kiosk-test-secret-kiosk-test-secret-!!';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();
  ownerCookie = await captureCookie('owner@kiosk-test.local');
  cashierCookie = await captureCookie('cashier@kiosk-test.local');
  bookkeeperCookie = await captureCookie('books@kiosk-test.local');
  outsiderCookie = await captureCookie('outsider@other-co.local');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('Time clock kiosk', () => {
  it('punches for the member whose credentials are given, never for the terminal', async () => {
    const res = await as(cashierCookie)
      .post('/v1/timeclock/kiosk-punch')
      .send({ email: 'Wally@kiosk-test.local', password: OTHER_PASSWORD, type: 'clock_in' })
      .expect(201);
    expect(res.body.member).toMatchObject({
      membershipId: warehouseMembershipId,
      name: 'Wally Warehouse',
    });
    expect(res.body.status).toBe('in');
    expect(res.body.punched.type).toBe('clock_in');
    // The terminal's own clock is untouched.
    const terminal = await as(cashierCookie).get('/v1/timeclock/me').expect(200);
    expect(terminal.body.status).toBe('out');
    // A second clock-in is refused like any punch that does not move the status.
    await as(cashierCookie)
      .post('/v1/timeclock/kiosk-punch')
      .send({ email: 'wally@kiosk-test.local', password: OTHER_PASSWORD, type: 'clock_in' })
      .expect(400);
    const out = await as(cashierCookie)
      .post('/v1/timeclock/kiosk-punch')
      .send({ email: 'wally@kiosk-test.local', password: OTHER_PASSWORD, type: 'clock_out' })
      .expect(201);
    expect(out.body.status).toBe('out');
    expect(out.body.punchesToday).toHaveLength(2);
  });

  it('refuses bad credentials, members of another business and members who cannot punch', async () => {
    const bad = await as(cashierCookie)
      .post('/v1/timeclock/kiosk-punch')
      .send({ email: 'wally@kiosk-test.local', password: 'nope', type: 'clock_in' })
      .expect(403);
    expect(bad.body.code).toBe('KIOSK_DENIED');
    await as(cashierCookie)
      .post('/v1/timeclock/kiosk-punch')
      .send({ email: 'outsider@other-co.local', password: PASSWORD, type: 'clock_in' })
      .expect(403);
    await as(cashierCookie)
      .post('/v1/timeclock/kiosk-punch')
      .send({ email: 'wally@kiosk-test.local', password: OTHER_PASSWORD, type: 'lunch' })
      .expect(400);
    await as(cashierCookie)
      .post('/v1/timeclock/kiosk-punch')
      .send({ type: 'clock_in' })
      .expect(400);
  });
});

describe('Active sessions', () => {
  it("lists this business's members' sessions and signs one out", async () => {
    const list = await as(ownerCookie).get('/v1/business/sessions').expect(200);
    const rows = list.body as {
      id: string;
      email: string;
      current: boolean;
      roleName: string | null;
    }[];
    const emails = new Set(rows.map((r) => r.email));
    expect(emails.has('owner@kiosk-test.local')).toBe(true);
    expect(emails.has('cashier@kiosk-test.local')).toBe(true);
    expect(emails.has('outsider@other-co.local')).toBe(false);
    expect(rows.find((r) => r.email === 'owner@kiosk-test.local')).toMatchObject({
      current: true,
      roleName: 'Owner',
    });
    const cashierSession = rows.find((r) => r.email === 'cashier@kiosk-test.local')!;

    await as(ownerCookie).delete(`/v1/business/sessions/${cashierSession.id}`).expect(200);
    // The cashier's cookie no longer works.
    await as(cashierCookie).get('/v1/timeclock/me').expect(401);
    const after = await as(ownerCookie).get('/v1/business/sessions').expect(200);
    expect(
      (after.body as { email: string }[]).some((r) => r.email === 'cashier@kiosk-test.local'),
    ).toBe(false);
  });

  it("cannot touch another business's session, and needs sessions.manage", async () => {
    await withDbCheck(async (db) => {
      const [outsider] = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
        .where(eq(schema.users.email, 'outsider@other-co.local'));
      await as(ownerCookie).delete(`/v1/business/sessions/${outsider!.id}`).expect(403);
    });
    await as(bookkeeperCookie).get('/v1/business/sessions').expect(403);
    await as(outsiderCookie, otherBusinessId).get('/v1/business/sessions').expect(200);
    const theirs = await as(outsiderCookie, otherBusinessId)
      .get('/v1/business/sessions')
      .expect(200);
    expect(
      (theirs.body as { email: string }[]).every((r) => r.email === 'outsider@other-co.local'),
    ).toBe(true);
  });
});

async function withDbCheck<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  try {
    return await fn(drizzle(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe('Print a Purchase Order', () => {
  it('records prints, flags reprints, and the list filters pick the batch', async () => {
    const first = await as(ownerCookie)
      .post(`/v1/purchase-orders/${poOrderedId}/print`)
      .expect(201);
    expect(first.body).toMatchObject({ printCount: 1, reprint: false });
    const second = await as(ownerCookie)
      .post(`/v1/purchase-orders/${poOrderedId}/print`)
      .expect(201);
    expect(second.body).toMatchObject({ printCount: 2, reprint: true });
    const detail = await as(ownerCookie).get(`/v1/purchase-orders/${poOrderedId}`).expect(200);
    expect(detail.body.printCount).toBe(2);
    expect(detail.body.lastPrintedAt).toBeTruthy();

    const unprinted = await as(ownerCookie)
      .get('/v1/purchase-orders?status=ordered&printed=0')
      .expect(200);
    expect(unprinted.body.data.map((p: { number: string }) => p.number)).toEqual(['PO-B']);
    const noDirect = await as(ownerCookie)
      .get('/v1/purchase-orders?status=ordered&directShip=0')
      .expect(200);
    expect(noDirect.body.data.map((p: { number: string }) => p.number)).toEqual(['PO-A']);
    const atStore = await as(ownerCookie)
      .get(`/v1/purchase-orders?locationId=${storeId}`)
      .expect(200);
    expect(atStore.body.data.map((p: { number: string }) => p.number)).toEqual(['PO-B']);
    const byNumber = await as(ownerCookie).get('/v1/purchase-orders?number=po-b').expect(200);
    expect(byNumber.body.data.map((p: { id: string }) => p.id)).toEqual([poDirectId]);
    expect(byNumber.body.data[0]).toMatchObject({ directShip: true, printCount: 0 });
  });
});
