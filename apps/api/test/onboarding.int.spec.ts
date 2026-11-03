/**
 * Self-service onboarding: a fresh signup creates their first
 * business, becomes its Owner, and sees a "next steps" checklist
 * that ticks off as they configure the rest of the platform.
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
import { DEFAULT_AS_IS_REASON_CODES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.ONBOARDING_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_onboarding';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'OnboardPass!2026';

let app: INestApplication;
let cookie = '';
let businessId = '';

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

async function seedUser() {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const passwordHash = await hashPassword(PASSWORD);
    const [u] = await db
      .insert(schema.users)
      .values({ email: 'fresh@onboard.local', emailVerified: true, name: 'Fresh User' })
      .returning();
    await db.insert(schema.accounts).values({
      accountId: u!.id,
      providerId: 'credential',
      userId: u!.id,
      password: passwordHash,
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

beforeAll(async () => {
  await resetTestDb();
  await seedUser();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'onboard-test-secret-onboard-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();

  cookie = await captureCookie('fresh@onboard.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Self-service onboarding', () => {
  it('checklist returns null when the user has no memberships', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/onboarding/checklist')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('POST /v1/onboarding/business creates a business + Owner membership', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/onboarding/business')
      .set('Cookie', cookie)
      .send({
        name: 'Fresh Co',
        slug: 'fresh-co',
        currencyCode: 'EUR',
        defaultTaxRateBps: 875,
      });
    expect(res.status).toBe(201);
    expect(res.body.businessId).toMatch(/[0-9a-f-]{36}/);
    businessId = res.body.businessId;

    // Verify side-effects directly: Owner membership, currency,
    // trial subscription, system roles all in place.
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const [biz] = await sql<{ currency_code: string; status: string }[]>`
        SELECT currency_code, status FROM businesses WHERE id = ${businessId}
      `;
      expect(biz.currency_code).toBe('EUR');
      expect(biz.status).toBe('trial');

      const memberships = await sql<{ role_name: string; status: string }[]>`
        SELECT r.name AS role_name, m.status FROM memberships m
        JOIN roles r ON r.id = m.role_id
        WHERE m.business_id = ${businessId}
      `;
      expect(memberships).toHaveLength(1);
      expect(memberships[0]!.role_name).toBe('Owner');
      expect(memberships[0]!.status).toBe('active');

      const roles = await sql`SELECT name FROM roles WHERE business_id = ${businessId}`;
      expect(roles.length).toBeGreaterThanOrEqual(5); // Owner, Manager, Cashier, etc.

      // Owner 2026-11-02: the standard As-Is reasons come with the business.
      const asIs = await sql<{ code: string; active: boolean }[]>`
        SELECT code, active FROM reason_codes
        WHERE business_id = ${businessId} AND usage_class = 'as_is' ORDER BY code
      `;
      expect(asIs.map((r) => r.code)).toEqual(
        [...DEFAULT_AS_IS_REASON_CODES].map((c) => c.code).sort(),
      );
      expect(asIs.every((r) => r.active)).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('checklist now reports business.created done; the rest pending', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/onboarding/checklist')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.businessId).toBe(businessId);
    expect(res.body.complete).toBe(false);
    const byKey = Object.fromEntries(
      (res.body.steps as { key: string; done: boolean }[]).map((s) => [s.key, s.done]),
    );
    expect(byKey['business.created']).toBe(true);
    expect(byKey['location.added']).toBe(false);
    expect(byKey['product.added']).toBe(false);
    expect(byKey['team.invited']).toBe(false);
    expect(byKey['stripe.connected']).toBe(false);
  });

  it('adding a location ticks the location step', async () => {
    await request(app.getHttpServer())
      .post('/v1/business/locations')
      .set('Cookie', cookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Main', timezone: 'America/New_York' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/onboarding/checklist')
      .set('Cookie', cookie);
    const byKey = Object.fromEntries(
      (res.body.steps as { key: string; done: boolean }[]).map((s) => [s.key, s.done]),
    );
    expect(byKey['location.added']).toBe(true);
  });

  it('duplicate slug → 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/onboarding/business')
      .set('Cookie', cookie)
      .send({ name: 'Another', slug: 'fresh-co' });
    expect(res.status).toBe(409);
  });

  it('invalid slug → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/onboarding/business')
      .set('Cookie', cookie)
      .send({ name: 'Bad', slug: 'Has Spaces' });
    expect(res.status).toBe(400);
  });

  it('unsupported currencyCode → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/onboarding/business')
      .set('Cookie', cookie)
      .send({ name: 'Bad Currency', slug: 'bad-currency', currencyCode: 'XYZ' });
    expect(res.status).toBe(400);
  });

  it('5-business cap is enforced; the 6th request is forbidden', async () => {
    // The user already created 1 ('fresh-co'). Create 4 more.
    for (let i = 2; i <= 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/v1/onboarding/business')
        .set('Cookie', cookie)
        .send({ name: `Biz ${i}`, slug: `biz-${i}` });
      expect(res.status).toBe(201);
    }
    // 6th should be rejected.
    const sixth = await request(app.getHttpServer())
      .post('/v1/onboarding/business')
      .set('Cookie', cookie)
      .send({ name: 'Biz 6', slug: 'biz-6' });
    expect(sixth.status).toBe(403);
    expect(sixth.body.message).toMatch(/capped/);
  });
});
