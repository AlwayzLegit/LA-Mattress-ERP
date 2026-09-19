/**
 * Epic 1.9 acceptance: a cashier can create a customer mid-sale (the
 * "modal" referenced in PLAN.md is just the POST /v1/customers call;
 * Epic 1.10 wires the modal up to the POS register UI). Search hits
 * by partial name, email, and phone.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.CUSTOMERS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_customers';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'CustPass!2026';

let app: INestApplication;
let businessId = '';
let cashierCookie = '';
let ownerCookie = '';
let bookkeeperCookie = '';

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
      .values({ slug: 'cust-test', name: 'Customers Test Co', status: 'active' })
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
    await makeUser('owner@cust-test.local', 'Owner');
    await makeUser('cashier@cust-test.local', 'Cashier');
    await makeUser('bookkeeper@cust-test.local', 'Bookkeeper');
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
  process.env.BETTER_AUTH_SECRET ??= 'customers-test-secret-customers-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();

  ownerCookie = await captureCookie('owner@cust-test.local');
  cashierCookie = await captureCookie('cashier@cust-test.local');
  bookkeeperCookie = await captureCookie('bookkeeper@cust-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Epic 1.9 — Customer records', () => {
  let aliceId = '';

  it('Cashier creates a customer (the "create mid-sale" path)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        firstName: 'Alice',
        lastName: 'Adams',
        email: 'alice@example.com',
        phone: '+15551234567',
        notes: 'Walked in 2026-05-07',
      });
    expect(res.status).toBe(201);
    expect(res.body.firstName).toBe('Alice');
    expect(res.body.email).toBe('alice@example.com');
    aliceId = res.body.id as string;
  });

  it('Empty body (no identity fields) returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ notes: 'Anonymous walk-in' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/firstName.*lastName.*email.*phone/);
  });

  it('Search by partial first name finds the customer', async () => {
    // Add a couple more so we know the search filtered.
    await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Bob', lastName: 'Brown', email: 'bob@example.com' });
    await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Charlie', lastName: 'Cohen', phone: '+15559999999' });

    const res = await request(app.getHttpServer())
      .get('/v1/customers?q=Alice')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(aliceId);
    expect(ids.length).toBe(1);
  });

  it('Search by partial email finds the customer', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/customers?q=bob@example')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const emails = (res.body.data as { email: string | null }[]).map((c) => c.email);
    expect(emails).toContain('bob@example.com');
  });

  it('Search by partial phone digits finds the customer', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/customers?q=+15559999999')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const names = (res.body.data as { firstName: string | null }[]).map((c) => c.firstName);
    expect(names).toContain('Charlie');
  });

  it('Phone search matches digits to digits however either side was typed', async () => {
    const made = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Dash', lastName: 'Dialer', phone: '818-800-5678' });
    expect(made.status).toBe(201);
    expect(made.body.phone).toBe('818-800-5678');
    for (const typed of [
      '8188005678',
      '818-800-5678',
      '(818) 800-5678',
      '800-5678',
      '+1 818 800 5678',
    ]) {
      const res = await request(app.getHttpServer())
        .get(`/v1/customers?q=${encodeURIComponent(typed)}`)
        .set('Cookie', cashierCookie)
        .set('X-Business-Id', businessId);
      expect(res.status).toBe(200);
      const ids = (res.body.data as { id: string }[]).map((c) => c.id);
      expect(ids, typed).toContain(made.body.id);
    }
    const miss = await request(app.getHttpServer())
      .get('/v1/customers?q=818-800-9999')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect((miss.body.data as { id: string }[]).map((c) => c.id)).not.toContain(made.body.id);
  });

  it('Customer detail includes empty recentSales (Epic 1.10 will fill it)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/customers/${aliceId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(aliceId);
    expect(res.body.recentSales).toEqual([]);
  });

  it('Owner edits the customer + audit captures the diff', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/customers/${aliceId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ phone: '+15550000111' });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('+15550000111');

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const rows = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'customer.update'));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const last = rows.at(-1)!;
      expect(last.changesJson).toMatchObject({
        before: { phone: '+15551234567' },
        after: { phone: '+15550000111' },
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('Cashier (no customers.delete) cannot delete', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/v1/customers/${aliceId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/customers\.delete/);
  });

  it('Bookkeeper (no customers.view) cannot list', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/customers')
      .set('Cookie', bookkeeperCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/customers\.view/);
  });

  it('Owner can delete; sale references would survive via SET NULL', async () => {
    // Add a temp customer just for this test.
    const c = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Temp', lastName: 'User' });
    expect(c.status).toBe(201);
    const id = c.body.id as string;

    const del = await request(app.getHttpServer())
      .delete(`/v1/customers/${id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const after = await request(app.getHttpServer())
      .get(`/v1/customers/${id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(after.status).toBe(404);
  });
});

describe('Counter capture — addresses and referral source in one create', () => {
  it('creates with delivery + billing addresses and a referral source; patch updates them', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        firstName: 'Dana',
        lastName: 'Doorstep',
        phone: '+15559876543',
        referralSource: 'Google search',
        addressesJson: [
          {
            label: 'delivery',
            line1: '123 Mattress Ln',
            line2: null,
            city: 'Los Angeles',
            region: 'CA',
            postalCode: '90001',
          },
          {
            label: 'billing',
            line1: 'PO Box 99',
            line2: null,
            city: 'Los Angeles',
            region: 'CA',
            postalCode: '90002',
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.referralSource).toBe('Google search');
    expect(res.body.addressesJson).toHaveLength(2);
    expect(res.body.addressesJson[0].label).toBe('delivery');
    expect(res.body.addressesJson[0].line1).toBe('123 Mattress Ln');
    expect(res.body.addressesJson[1].label).toBe('billing');

    const detail = await request(app.getHttpServer())
      .get(`/v1/customers/${res.body.id}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(detail.status).toBe(200);
    expect(detail.body.referralSource).toBe('Google search');
    expect(detail.body.addressesJson[1].postalCode).toBe('90002');

    const patched = await request(app.getHttpServer())
      .patch(`/v1/customers/${res.body.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ referralSource: 'Repeat customer' });
    expect(patched.status).toBe(200);
    expect(patched.body.referralSource).toBe('Repeat customer');
    // Addresses untouched by a patch that does not name them.
    expect(patched.body.addressesJson).toHaveLength(2);
  });
});

describe('Duplicates + merge (handoff G4, owner-picked warn-and-merge)', () => {
  let keeperId = '';
  let dupeId = '';
  let locId = '';

  it('lists possible duplicates by phone digits, email, and exact name', async () => {
    const keeper = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Arman', lastName: 'Doubled', phone: '(310) 555-2001' })
      .expect(201);
    keeperId = keeper.body.id;
    const dupe = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        firstName: 'Arman',
        lastName: 'Doubled',
        phone: '310.555.2001',
        email: 'arman.d@example.test',
        notes: 'prefers morning delivery',
      })
      .expect(201);
    dupeId = dupe.body.id;
    // A third record sharing only the name still surfaces, marked so.
    await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Arman', lastName: 'Doubled' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/v1/customers/${keeperId}/duplicates`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const phoneMatch = res.body.find((d: { id: string }) => d.id === dupeId);
    expect(phoneMatch).toBeTruthy();
    expect(phoneMatch.matchedBy).toBe('phone');
    expect(res.body.some((d: { matchedBy: string }) => d.matchedBy === 'name')).toBe(true);
    // The list never includes the customer themselves.
    expect(res.body.map((d: { id: string }) => d.id)).not.toContain(keeperId);
  });

  it('merging re-homes documents and credit, backfills blanks, deletes the duplicate', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const [loc] = await sql`
        INSERT INTO locations (business_id, name, timezone)
        VALUES (${businessId}, 'Merge Test Store', 'America/Los_Angeles') RETURNING id`;
      locId = loc!.id;
      await sql`
        INSERT INTO orders (business_id, location_id, customer_id, number, status,
                            subtotal_cents, total_cents)
        VALUES (${businessId}, ${locId}, ${dupeId}, 'MRG-ORD-1', 'open', 5000, 5000)`;
      await sql`
        INSERT INTO sales (business_id, location_id, customer_id, number, status,
                           subtotal_cents, total_cents)
        VALUES (${businessId}, ${locId}, ${dupeId}, 'MRG-SALE-1', 'completed', 3000, 3000)`;
      await sql`
        INSERT INTO store_credit_entries (business_id, customer_id, delta_cents, reason)
        VALUES (${businessId}, ${dupeId}, 2500, 'merge test credit')`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const merged = await request(app.getHttpServer())
      .post(`/v1/customers/${keeperId}/merge`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ sourceCustomerId: dupeId });
    expect(merged.status).toBe(201);
    // Blank fields on the keeper backfilled from the duplicate.
    expect(merged.body.email).toBe('arman.d@example.test');
    // The keeper's own phone was NOT overwritten.
    expect(merged.body.phone).toBe('(310) 555-2001');

    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const [gone] = await sql2`SELECT count(*)::int AS n FROM customers WHERE id = ${dupeId}`;
      expect(gone!.n).toBe(0);
      const [ord] = await sql2`
        SELECT customer_id FROM orders WHERE number = 'MRG-ORD-1'`;
      expect(ord!.customer_id).toBe(keeperId);
      const [sale] = await sql2`
        SELECT customer_id FROM sales WHERE number = 'MRG-SALE-1'`;
      expect(sale!.customer_id).toBe(keeperId);
      const [credit] = await sql2`
        SELECT COALESCE(SUM(delta_cents), 0)::int AS bal FROM store_credit_entries
        WHERE customer_id = ${keeperId}`;
      expect(credit!.bal).toBe(2500);
    } finally {
      await sql2.end({ timeout: 5 });
    }

    // The customer 360 now shows the moved history.
    const history = await request(app.getHttpServer())
      .get(`/v1/customers/${keeperId}/order-history`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const numbers = history.body.map((h: { number: string }) => h.number);
    expect(numbers).toContain('MRG-ORD-1');
    expect(numbers).toContain('MRG-SALE-1');
  });

  it('refuses a self-merge and an unknown duplicate', async () => {
    const self = await request(app.getHttpServer())
      .post(`/v1/customers/${keeperId}/merge`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ sourceCustomerId: keeperId });
    expect(self.status).toBe(400);
    expect(self.body.message).toMatch(/themselves/);

    const missing = await request(app.getHttpServer())
      .post(`/v1/customers/${keeperId}/merge`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ sourceCustomerId: '00000000-0000-4000-8000-0000000000ff' });
    expect(missing.status).toBe(404);
  });
});

/**
 * Owner 2026-08-31: an optional secondary phone on the customer record.
 * It rides create/update, and both numbers count for the dedupe check.
 */
describe('Secondary phone (phone2)', () => {
  it('round-trips through create and update', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        firstName: 'Two',
        lastName: 'Phones',
        phone: '(213) 555-9001',
        phone2: '(213) 555-9002',
      })
      .expect(201);
    expect(created.body.phone2).toBe('(213) 555-9002');

    const patched = await request(app.getHttpServer())
      .patch(`/v1/customers/${created.body.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ phone2: '213-555-9003' })
      .expect(200);
    expect(patched.body.phone2).toBe('213-555-9003');
  });

  it('a duplicate is caught when its main number is my SECOND number', async () => {
    const keeper = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        firstName: 'Second',
        lastName: 'Line',
        phone: '(213) 555-9100',
        phone2: '(213) 555-9101',
      })
      .expect(201);
    const other = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Spouse', lastName: 'Line', phone: '213.555.9101' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/v1/customers/${keeper.body.id}/duplicates`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const hit = res.body.find((d: { id: string }) => d.id === other.body.id);
    expect(hit).toBeTruthy();
    expect(hit.matchedBy).toBe('phone');
  });
});
