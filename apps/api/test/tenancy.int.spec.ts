/**
 * Epic 1.3 acceptance: a handler decorated with @RequirePermission returns
 * 403 when the user's role lacks the permission, and 200 when it has it.
 *
 * Boots the full NestJS app against a dedicated test database, seeds two
 * users with different roles via the same paths the seed script uses, signs
 * each user in via better-auth's HTTP flow, and exercises /v1/products.
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
  process.env.TENANCY_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_tenancy';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');

const PASSWORD = 'TestPassword!2026';

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

let app: INestApplication;
let businessId: string;
let owner: TestUser;
let bookkeeper: TestUser;
let twoBiz: TestUser;

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

async function seedFixtures() {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const passwordHash = await hashPassword(PASSWORD);

    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'tenancy-test', name: 'Tenancy Test Co', status: 'active' })
      .returning();
    if (!biz) throw new Error('biz insert failed');
    businessId = biz.id;

    // Seed all 5 system roles for this business so we can attach the right
    // role to each user.
    const roleIds = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      const [r] = await db
        .insert(schema.roles)
        .values({
          businessId: biz.id,
          name: role.name,
          description: role.description,
          isSystem: true,
        })
        .returning();
      if (!r) throw new Error(`role insert failed: ${role.name}`);
      roleIds.set(role.name, r.id);
      if (role.permissions.length > 0) {
        await db
          .insert(schema.rolePermissions)
          .values(role.permissions.map((permission) => ({ roleId: r.id, permission })));
      }
    }

    async function makeUser(email: string, name: string, roleName: string): Promise<TestUser> {
      const [u] = await db
        .insert(schema.users)
        .values({ email, emailVerified: true, name })
        .returning();
      if (!u) throw new Error(`user insert failed: ${email}`);
      await db.insert(schema.accounts).values({
        accountId: u.id,
        providerId: 'credential',
        userId: u.id,
        password: passwordHash,
      });
      const roleId = roleIds.get(roleName);
      if (!roleId) throw new Error(`unknown role: ${roleName}`);
      await db.insert(schema.memberships).values({
        businessId: biz.id,
        userId: u.id,
        roleId,
        status: 'active',
        acceptedAt: new Date(),
      });
      return { id: u.id, email, cookie: '' };
    }

    owner = await makeUser('owner@tenancy-test.local', 'Owner', 'Owner');
    bookkeeper = await makeUser('bookkeeper@tenancy-test.local', 'Bookkeeper', 'Bookkeeper');
    // A member of two businesses still has to pick one.
    twoBiz = await makeUser('two@tenancy-test.local', 'Two Biz', 'Owner');
    const [other] = await db
      .insert(schema.businesses)
      .values({ slug: 'tenancy-test-2', name: 'Second Co', status: 'active' })
      .returning();
    const [otherRole] = await db
      .insert(schema.roles)
      .values({ businessId: other!.id, name: 'Owner', description: 'Owner', isSystem: true })
      .returning();
    await db.insert(schema.memberships).values({
      businessId: other!.id,
      userId: twoBiz.id,
      roleId: otherRole!.id,
      status: 'active',
      acceptedAt: new Date(),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function captureCookie(user: TestUser): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .send({ email: user.email, password: PASSWORD })
    .expect(200);
  const cookies = res.get('Set-Cookie') ?? [];
  const sessionCookie = cookies
    .map((c) => c.split(';')[0])
    .filter((c): c is string => Boolean(c?.startsWith('jetnine.session_token=')))
    .find((c) => !c.endsWith('='));
  if (!sessionCookie) throw new Error(`no session cookie returned for ${user.email}`);
  return sessionCookie;
}

beforeAll(async () => {
  await resetTestDb();
  await seedFixtures();

  // Stamp env before AppModule boots so AuthModule picks up our config.
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'tenancy-test-secret-tenancy-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();

  owner.cookie = await captureCookie(owner);
  bookkeeper.cookie = await captureCookie(bookkeeper);
  twoBiz.cookie = await captureCookie(twoBiz);
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Epic 1.3 — @RequirePermission gating', () => {
  it('Owner has products.view → 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products')
      .set('Cookie', owner.cookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('Bookkeeper lacks products.view → 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products')
      .set('Cookie', bookkeeper.cookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/products\.view/);
  });

  it('No active business, one membership → that business, and the cookie comes back', async () => {
    // Owner 2026-09-28: the 30-day cookie had expired under a live session.
    const res = await request(app.getHttpServer()).get('/v1/products').set('Cookie', owner.cookie);
    expect(res.status).toBe(200);
    const set = (res.get('Set-Cookie') ?? []).find((c) =>
      c.startsWith('jetnine.active_business_id='),
    );
    expect(set).toContain(businessId);
  });

  it('No active business, several memberships → 412 so the client shows the picker', async () => {
    const res = await request(app.getHttpServer()).get('/v1/products').set('Cookie', twoBiz.cookie);
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('BUSINESS_NOT_SELECTED');
  });

  it('No session → 401 Unauthorized', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products')
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(401);
  });

  it('Wrong tenant (user has no membership) → 403', async () => {
    const fakeBusinessId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app.getHttpServer())
      .get('/v1/products')
      .set('Cookie', bookkeeper.cookie)
      .set('X-Business-Id', fakeBusinessId);
    expect(res.status).toBe(403);
  });
});

describe('active-business cookie', () => {
  /**
   * The offline POS layer reads this cookie from `document.cookie`
   * (`readActiveBusinessId()` in apps/web/src/lib/offline.ts) to partition
   * the IndexedDB sale queue and variant cache by tenant. It was set
   * `httpOnly`, which made it invisible to the browser — `businessId` was
   * always null, so offline sales were never queued, variants were never
   * cached, and the reconnect sync never ran. Nothing failed loudly; the
   * register just quietly stopped working whenever it lost connectivity.
   *
   * This pins the attribute so a future "harden the cookies" pass has to
   * fail a test rather than silently disable offline POS again.
   */
  it('is readable from JavaScript, or offline POS silently dies', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/active-business')
      .set('Cookie', owner.cookie)
      .send({ businessId });
    expect(res.status).toBe(201);

    const setCookie = (res.get('Set-Cookie') ?? []).find((c) =>
      c.startsWith('jetnine.active_business_id='),
    );
    expect(setCookie).toBeTruthy();
    expect(setCookie!.toLowerCase()).not.toContain('httponly');
  });

  it('still gates on membership before setting anything', async () => {
    // Readable does not mean unguarded: the endpoint proves membership
    // first, and TenancyGuard re-resolves it on every later request.
    const res = await request(app.getHttpServer())
      .post('/v1/auth/active-business')
      .set('Cookie', owner.cookie)
      .send({ businessId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(403);
    expect(res.get('Set-Cookie') ?? []).toHaveLength(0);
  });
});

describe('RLS actually applies to handler queries (cross-tenant leak regression)', () => {
  // A second business this user is NOT a member of, holding rows that the
  // queries under test would leak if they ran on the unscoped root
  // connection (the pre-fix behavior: SET LOCAL ROLE app_user only ever
  // ran on the interceptor's transaction, not on the pool the handlers
  // used, so any query relying on RLS instead of an explicit business_id
  // filter read across tenants).
  it('search, lists, and boards never see the other business', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [other] = await db
        .insert(schema.businesses)
        .values({ slug: 'other-tenant', name: 'Other Tenant Co', status: 'active' })
        .returning();
      const [otherLoc] = await db
        .insert(schema.locations)
        .values({ businessId: other!.id, name: 'Other Store', timezone: 'UTC' })
        .returning();
      const [otherCust] = await db
        .insert(schema.customers)
        .values({
          businessId: other!.id,
          firstName: 'Zebulon',
          lastName: 'Leakcheck',
          email: 'zebulon@other-tenant.test',
        })
        .returning();
      await db.insert(schema.serviceOrders).values({
        businessId: other!.id,
        locationId: otherLoc!.id,
        number: 'SV-9999-000001',
        customerId: otherCust!.id,
        issue: 'Should be invisible',
      });
      await db
        .insert(schema.customerTags)
        .values({ businessId: other!.id, name: 'other-tenant-tag' });
    } finally {
      await sql.end({ timeout: 5 });
    }

    // Full-text customer search — the query that exposed the leak.
    const search = await request(app.getHttpServer())
      .get('/v1/customers?q=Zebulon')
      .set('Cookie', owner.cookie)
      .set('X-Business-Id', businessId);
    expect(search.status).toBe(200);
    expect(search.body.data).toHaveLength(0);

    // Unfiltered cursor list.
    const list = await request(app.getHttpServer())
      .get('/v1/customers')
      .set('Cookie', owner.cookie)
      .set('X-Business-Id', businessId);
    const emails = (list.body.data as { email: string | null }[]).map((c) => c.email);
    expect(emails).not.toContain('zebulon@other-tenant.test');

    // Service board.
    const board = await request(app.getHttpServer())
      .get('/v1/service-orders')
      .set('Cookie', owner.cookie)
      .set('X-Business-Id', businessId);
    expect(board.status).toBe(200);
    expect((board.body.data as { number: string }[]).map((t) => t.number)).not.toContain(
      'SV-9999-000001',
    );

    // CRM tag list.
    const tags = await request(app.getHttpServer())
      .get('/v1/customer-tags')
      .set('Cookie', owner.cookie)
      .set('X-Business-Id', businessId);
    expect(tags.status).toBe(200);
    expect((tags.body as { name: string }[]).map((t) => t.name)).not.toContain('other-tenant-tag');

    // Direct id fetch of a foreign customer must 404, not leak.
    const direct = await request(app.getHttpServer())
      .get(`/v1/customers/00000000-0000-0000-0000-000000000001`)
      .set('Cookie', owner.cookie)
      .set('X-Business-Id', businessId);
    expect([404, 403]).toContain(direct.status);
  });
});
