/**
 * Sales competitions (redesign Phase 11, owner amendment 2026-09-13):
 * only people compete, and every member whose role can log a lead is on
 * every card from day one — sales or not. The ranked rows come first,
 * then the unranked with no number.
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
import type { CompetitionBoard, RaceCard } from '../src/competitions/competitions.service';

const TEST_DB_URL =
  process.env.COMPETITIONS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_competitions';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'CompetePass!2026x';
const TZ = 'America/Los_Angeles';

let app: INestApplication;
let businessId = '';
let storeId = '';
const members = {
  owner: '',
  ops: '',
  manager: '',
  rep: '',
};
const cookies: Record<keyof typeof members, string> = { owner: '', ops: '', manager: '', rep: '' };

function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  return fn(db).finally(() => sql.end({ timeout: 5 }));
}

async function resetTestDb() {
  const env = { ...process.env, DATABASE_URL: TEST_DB_URL };
  for (const script of ['src/reset.ts', 'src/migrate.ts']) {
    execFileSync('pnpm', ['exec', 'tsx', script], { cwd: dbPackageRoot, env, stdio: 'inherit' });
  }
}

async function seed() {
  await withDb(async (db) => {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'competitions-test', name: 'Competitions Test Co', status: 'active' })
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

    const [store] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Main Store', timezone: TZ })
      .returning();
    storeId = store!.id;

    async function makeUser(key: keyof typeof members, name: string, role: string) {
      const [u] = await db
        .insert(schema.users)
        .values({ email: `${key}@competitions.local`, emailVerified: true, name })
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
      members[key] = m!.id;
    }
    await makeUser('owner', 'Olive Owner', 'Owner');
    await makeUser('ops', 'Dana Whitmore', 'Operations');
    await makeUser('manager', 'Maya Torres', 'Manager');
    await makeUser('rep', 'Priya Nair', 'Cashier');
    await db.insert(schema.membershipLocationScopes).values({
      businessId,
      membershipId: members.manager,
      locationId: storeId,
    });

    const [p] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'CP-MAT', name: 'Compete Mattress' })
      .returning();
    const [v] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: p!.id, sku: 'CP-MAT-Q', name: 'Queen', priceCents: 120_000 })
      .returning();
    const [cust] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Noah', lastName: 'Feldman', phone: '3105550100' })
      .returning();

    // One completed order this month, by the rep. Nobody else has sold.
    const [order] = await db
      .insert(schema.orders)
      .values({
        businessId,
        locationId: storeId,
        number: 'SO-CP-001',
        status: 'completed',
        customerId: cust!.id,
        salespersonMembershipId: members.rep,
        subtotalCents: 120_000,
        totalCents: 120_000,
        completedAt: new Date(),
      })
      .returning();
    await db.insert(schema.orderLines).values({
      businessId,
      orderId: order!.id,
      variantId: v!.id,
      description: 'Compete Mattress — Queen',
      quantity: 1,
      unitPriceCents: 120_000,
      totalCents: 120_000,
      lineType: 'stock',
    });
  });
}

async function captureCookie(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .send({ email, password: PASSWORD })
    .expect(200);
  const found = (res.get('Set-Cookie') ?? [])
    .map((c) => c.split(';')[0])
    .filter((c): c is string => Boolean(c?.startsWith('jetnine.session_token=')))
    .find((c) => !c.endsWith('='));
  if (!found) throw new Error(`no session cookie for ${email}`);
  return found;
}

const as = (who: keyof typeof members) => ({
  get: (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Cookie', cookies[who])
      .set('x-business-id', businessId),
});

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'competitions-secret-competitions-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();

  for (const who of ['owner', 'manager'] as const) {
    cookies[who] = await captureCookie(`${who}@competitions.local`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
});

const card = (board: CompetitionBoard, key: RaceCard['key']) =>
  board.cards.find((c) => c.key === key)!;
const names = (c: RaceCard) => c.rows.map((r) => r.name);

describe('GET /v1/competitions/current', () => {
  it('lists everyone whose role can log a lead on every card, sales or not', async () => {
    const res = await as('owner').get('/v1/competitions/current').expect(200);
    const board = res.body as CompetitionBoard;
    for (const c of board.cards) {
      expect(names(c)).toEqual(
        expect.arrayContaining(['Priya Nair', 'Maya Torres', 'Olive Owner']),
      );
      // Operations cannot log a lead, so Dana does not compete.
      expect(names(c)).not.toContain('Dana Whitmore');
      // Ranked rows first, then the unranked — never interleaved.
      const firstUnranked = c.rows.findIndex((r) => r.rank === null);
      if (firstUnranked >= 0) {
        expect(c.rows.slice(firstUnranked).every((r) => r.rank === null)).toBe(true);
      }
      expect(c.top.every((r) => r.rank !== null)).toBe(true);
    }
  });

  it('ranks the one seller first and leaves the zero-sales people under them', async () => {
    const res = await as('owner').get('/v1/competitions/current').expect(200);
    const board = res.body as CompetitionBoard;

    const sales = card(board, 'sales');
    expect(sales.rows[0]).toMatchObject({ name: 'Priya Nair', rank: 1, value: 1, valueLabel: '1' });
    // A count race can rank a zero: everyone else shares the value 0.
    const maya = sales.rows.find((r) => r.name === 'Maya Torres')!;
    expect(maya.value).toBe(0);
    expect(maya.rank).not.toBeNull();
    expect(maya.rank).toBeGreaterThan(1);
    expect(sales.top.map((r) => r.name)[0]).toBe('Priya Nair');

    // A $ race cannot rank someone with no sales: no number, a dash, "no sales yet".
    const avg = card(board, 'avg');
    expect(avg.rows[0]).toMatchObject({ name: 'Priya Nair', rank: 1, valueLabel: '$1,200' });
    const mayaAvg = avg.rows.find((r) => r.name === 'Maya Torres')!;
    expect(mayaAvg).toMatchObject({ rank: null, valueLabel: '—', detail: 'no sales yet' });
    expect(avg.top).toHaveLength(1);

    // Least Exchanges: zero sales is not ranked (the locked rule copy).
    const ex = card(board, 'ex');
    expect(ex.rows.find((r) => r.name === 'Maya Torres')!.rank).toBeNull();
    expect(ex.rows[0]).toMatchObject({ name: 'Priya Nair', rank: 1 });
  });

  it('is a people race only — no scopes, no store prizes', async () => {
    const res = await as('manager').get('/v1/competitions/current?scope=stores').expect(200);
    const board = res.body as unknown as Record<string, unknown>;
    expect(board).not.toHaveProperty('scopes');
    expect(board).not.toHaveProperty('scope');
    expect(board.viewer as Record<string, unknown>).not.toHaveProperty('defaultScope');
    const you = card(res.body as CompetitionBoard, 'sales').you!;
    // Maya has no sale; her pinned row says so with the leader's gap.
    expect(you.gap).toMatch(/behind Priya/);
  });

  it('prints a people-only winners sheet, and an empty past month crowns nobody', async () => {
    const res = await as('owner').get('/v1/competitions/sheet').expect(200);
    expect(res.body).not.toHaveProperty('stores');
    expect(res.body).not.toHaveProperty('storesLine');
    // Last month had no orders: today's roster must not be seeded into it
    // and frozen as zero-sale winners.
    const winners = res.body.winners as { race: string; name: string | null }[];
    expect(winners).toHaveLength(6);
    expect(winners.every((w) => w.name === null)).toBe(true);
    const history = await as('owner').get('/v1/competitions/history').expect(200);
    expect(history.body).toEqual([]);
  });
});
