/**
 * Epic 1.6 acceptance: a business owner invites a cashier, the cashier
 * accepts the invitation, and lands logged in with cashier permissions
 * only — i.e. they CAN view products (cashier holds products.view) but
 * CAN'T edit prices (no products.update) and CAN'T see audit logs (no
 * audit.view).
 *
 * Also exercises the rest of the Epic 1.6 surface: settings GET/PATCH,
 * locations CRUD, custom roles + permission editing.
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
  process.env.BUSINESS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_business';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const OWNER_PASSWORD = 'OwnerPass!2026Test';
const CASHIER_PASSWORD = 'CashierPass!2026Test';
const CASHIER_EMAIL = `cashier+${Date.now()}@business-test.local`;

let app: INestApplication;
let businessId: string;
let ownerUserId: string;
let ownerCookie = '';
let cashierUserId = '';
let cashierMembershipId = '';
let inviteToken = '';
let cashierCookie = '';

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
    const passwordHash = await hashPassword(OWNER_PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'biz-test', name: 'Biz Test Co', status: 'active' })
      .returning();
    if (!biz) throw new Error('biz insert failed');
    businessId = biz.id;

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
      if (!r) throw new Error(`role ${role.name} insert failed`);
      roleIds.set(role.name, r.id);
      if (role.permissions.length > 0) {
        await db
          .insert(schema.rolePermissions)
          .values(role.permissions.map((permission) => ({ roleId: r.id, permission })));
      }
    }

    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'owner@business-test.local', emailVerified: true, name: 'Owner' })
      .returning();
    if (!owner) throw new Error('owner insert failed');
    ownerUserId = owner.id;
    await db.insert(schema.accounts).values({
      accountId: owner.id,
      providerId: 'credential',
      userId: owner.id,
      password: passwordHash,
    });
    await db.insert(schema.memberships).values({
      businessId: biz.id,
      userId: owner.id,
      roleId: roleIds.get('Owner')!,
      status: 'active',
      acceptedAt: new Date(),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function captureCookie(email: string, password: string): Promise<string> {
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

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'business-test-secret-business-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();

  ownerCookie = await captureCookie('owner@business-test.local', OWNER_PASSWORD);
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Epic 1.6 — Business admin console', () => {
  it('Owner can read business settings (defaults)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.currencyCode).toBe('USD');
    expect(res.body.defaultTaxRateBps).toBe(0);
    expect(res.body.receiptHeader).toBeNull();
  });

  it('Owner can update business settings; audit captures the diff', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ defaultTaxRateBps: 825, receiptHeader: 'Biz Test Co — Main Receipt' });
    expect(res.status).toBe(200);
    expect(res.body.defaultTaxRateBps).toBe(825);
    expect(res.body.receiptHeader).toBe('Biz Test Co — Main Receipt');

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const rows = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'business.settings.update'));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.at(-1)!.changesJson).toMatchObject({
        before: { defaultTaxRateBps: 0 },
        after: { defaultTaxRateBps: 825 },
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('Owner creates a location; tax override is recorded', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/business/locations')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Main Store', timezone: 'America/New_York', taxRateBps: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.taxRateBps).toBe(1000);
    // Q2: type defaults to store.
    expect(res.body.locationType).toBe('store');
  });

  it('Q2: locationType is store/warehouse only, settable at create and PATCH', async () => {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/v1/business/locations')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        name: 'Distribution Center',
        timezone: 'America/Los_Angeles',
        locationType: 'warehouse',
      });
    expect(created.status).toBe(201);
    expect(created.body.locationType).toBe('warehouse');

    const bad = await request(server)
      .post('/v1/business/locations')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Bad Type', timezone: 'America/Los_Angeles', locationType: 'outlet' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("locationType must be 'store' or 'warehouse'");

    const flipped = await request(server)
      .patch(`/v1/business/locations/${created.body.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ locationType: 'store' });
    expect(flipped.status).toBe(200);
    expect(flipped.body.locationType).toBe('store');
  });

  it('Location timezone must be a real IANA name (create and update)', async () => {
    const bad = await request(app.getHttpServer())
      .post('/v1/business/locations')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Broken TZ Store', timezone: '\\' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('invalid timezone');

    const ok = await request(app.getHttpServer())
      .post('/v1/business/locations')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'TZ Store', timezone: 'America/Los_Angeles' });
    expect(ok.status).toBe(201);

    const badUpdate = await request(app.getHttpServer())
      .patch(`/v1/business/locations/${ok.body.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ timezone: 'Not/A_Zone' });
    expect(badUpdate.status).toBe(400);
    expect(badUpdate.body.message).toContain('invalid timezone');
  });

  it('Per-store order numbering: prefixed locations use their own counter', async () => {
    const server = app.getHttpServer();
    const mkLoc = async (name: string, orderPrefix: string) => {
      const res = await request(server)
        .post('/v1/business/locations')
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ name, timezone: 'America/Los_Angeles', orderPrefix });
      expect(res.status).toBe(201);
      expect(res.body.orderPrefix).toBe(orderPrefix.toUpperCase());
      return res.body.id as string;
    };
    const wl = await mkLoc('Numbering West LA', 'wl');
    const k = await mkLoc('Numbering Koreatown', 'K');

    // Prefix collisions are rejected by the unique index.
    const dup = await request(server)
      .post('/v1/business/locations')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Dup Prefix', timezone: 'America/Los_Angeles', orderPrefix: 'WL' });
    expect(dup.status).toBeGreaterThanOrEqual(400);

    let custId: string;
    let variantId: string;
    {
      const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
      const db = drizzle(sql);
      try {
        const [c] = await db
          .insert(schema.customers)
          .values({ businessId, firstName: 'Num', lastName: 'Bering' })
          .returning();
        custId = c!.id;
        const [pr] = await db
          .insert(schema.products)
          .values({ businessId, sku: 'NUMBERING-1', name: 'Numbering Product' })
          .returning();
        const [v] = await db
          .insert(schema.productVariants)
          .values({ businessId, productId: pr!.id, sku: 'NUMBERING-1-V1', priceCents: 5000 })
          .returning();
        variantId = v!.id;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    const mkOrder = async (locationId: string) => {
      const res = await request(server)
        .post('/v1/orders')
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ locationId, customerId: custId, lines: [{ variantId, quantity: 1 }] });
      expect(res.status).toBe(201);
      return res.body.number as string;
    };
    expect(await mkOrder(wl)).toBe('WL-10001');
    expect(await mkOrder(wl)).toBe('WL-10002');
    // A different store runs its own counter from the start.
    expect(await mkOrder(k)).toBe('K-10001');
  });

  it('Location delete: active blocked, referenced blocked, clean inactive deleted', async () => {
    const server = app.getHttpServer();
    const mk = async (name: string) => {
      const res = await request(server)
        .post('/v1/business/locations')
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ name, timezone: 'America/Los_Angeles' });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const deactivate = (id: string) =>
      request(server)
        .patch(`/v1/business/locations/${id}`)
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ isActive: false });

    // Still active → 400.
    const activeId = await mk('Delete Guard Active');
    const activeDel = await request(server)
      .delete(`/v1/business/locations/${activeId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(activeDel.status).toBe(400);
    expect(activeDel.body.message).toContain('Deactivate');

    // Referenced (an inventory movement via receive) → 409, and the
    // cascade-linked rows survive.
    const referencedId = await mk('Delete Guard Referenced');
    let refVariantId: string;
    {
      const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
      const db = drizzle(sql);
      try {
        const [p] = await db
          .insert(schema.products)
          .values({ businessId, sku: 'DELGUARD-1', name: 'Delete Guard Product' })
          .returning();
        const [v] = await db
          .insert(schema.productVariants)
          .values({ businessId, productId: p!.id, sku: 'DELGUARD-1-V1', priceCents: 1000 })
          .returning();
        refVariantId = v!.id;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    const receive = await request(server)
      .post('/v1/inventory/receive')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ locationId: referencedId, lines: [{ variantId: refVariantId, quantity: 1 }] });
    expect(receive.status).toBe(201);
    await deactivate(referencedId).expect(200);
    const refDel = await request(server)
      .delete(`/v1/business/locations/${referencedId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(refDel.status).toBe(409);
    expect(refDel.body.message).toContain('inventory');

    // Clean + inactive → deleted and gone from the list.
    const cleanId = await mk('Delete Guard Clean');
    await deactivate(cleanId).expect(200);
    const cleanDel = await request(server)
      .delete(`/v1/business/locations/${cleanId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(cleanDel.status).toBe(200);
    expect(cleanDel.body.deleted).toBe(true);
    const list = await request(server)
      .get('/v1/business/locations')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const names = (list.body as { name: string }[]).map((l) => l.name);
    expect(names).not.toContain('Delete Guard Clean');
    expect(names).toContain('Delete Guard Referenced');
  });

  it('Owner invites a cashier — invite captured by memory transport', async () => {
    const inviteRes = await request(app.getHttpServer())
      .post('/v1/business/members/invite')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ email: CASHIER_EMAIL, name: 'Cashier', roleName: 'Cashier' });
    expect(inviteRes.status).toBe(201);
    cashierUserId = inviteRes.body.userId as string;
    cashierMembershipId = inviteRes.body.membershipId as string;
    expect(inviteRes.body.alreadyMember).toBe(false);
    // No mail transport is configured under test, so the API has to hand
    // the inviter the link instead of claiming it was emailed — otherwise
    // the invitee never hears about the invitation at all.
    expect(inviteRes.body.inviteLink, 'invite link returned when email cannot deliver').toContain(
      '/accept-invite?token=',
    );

    const emailRes = await request(app.getHttpServer())
      .get(`/v1/dev/email/last?to=${encodeURIComponent(CASHIER_EMAIL)}`)
      .expect(200);
    expect(emailRes.body.subject).toContain('invited');
    const html = emailRes.body.html as string;
    const match = html.match(/accept-invite\?token=([^"&]+)/);
    expect(match, 'invite token in email').toBeTruthy();
    inviteToken = decodeURIComponent(match![1]!);
    // The link handed back is the same one the email carries — not a
    // second, divergent token.
    expect(inviteRes.body.inviteLink).toContain(encodeURIComponent(inviteToken));
  });

  it('Cashier accepts the invite and signs in; membership flips active', async () => {
    const acceptRes = await request(app.getHttpServer())
      .post('/v1/auth/accept-invite')
      .send({ token: inviteToken, password: CASHIER_PASSWORD });
    expect(acceptRes.status).toBe(201);
    expect(acceptRes.body.userId).toBe(cashierUserId);

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const memberships = await db
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.businessId, businessId),
            eq(schema.memberships.userId, cashierUserId),
          ),
        );
      expect(memberships).toHaveLength(1);
      expect(memberships[0]!.status).toBe('active');
    } finally {
      await sql.end({ timeout: 5 });
    }

    cashierCookie = await captureCookie(CASHIER_EMAIL, CASHIER_PASSWORD);
  });

  it('Per-user permission overrides adjust role defaults both directions', async () => {
    const server = app.getHttpServer();
    const probe = () =>
      request(server)
        .get('/v1/products')
        .set('Cookie', cashierCookie)
        .set('X-Business-Id', businessId);

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      // Grant: an explicit allowed=true override wins regardless of what
      // earlier tests did to the cashier's role.
      await db.insert(schema.membershipPermissionOverrides).values({
        businessId,
        membershipId: cashierMembershipId,
        permission: 'products.view',
        allowed: true,
      });
      expect((await probe()).status).toBe(200);

      // Revoke: flipping the same override takes the permission away even
      // though a role may grant it.
      await db
        .update(schema.membershipPermissionOverrides)
        .set({ allowed: false })
        .where(eq(schema.membershipPermissionOverrides.membershipId, cashierMembershipId));
      expect((await probe()).status).toBe(403);
    } finally {
      await db
        .delete(schema.membershipPermissionOverrides)
        .where(eq(schema.membershipPermissionOverrides.businessId, businessId));
      await sql.end({ timeout: 5 });
    }
  });

  it('Every member can read POS settings; the recycling fee reaches the register', async () => {
    // Owner sets the CA recycling fee to $18.00.
    const set = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ ops: { recyclingFeeCents: 1800, poReplyTo: 'po@biz-test.local' } });
    expect(set.status).toBe(200);
    expect(set.body.ops.recyclingFeeCents).toBe(1800);

    // Full settings stay Owner/Manager-only …
    const full = await request(app.getHttpServer())
      .get('/v1/business/settings')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(full.status).toBe(403);

    // … but the register-facing subset is readable by any member, and
    // carries the fee (not the contact plumbing).
    const pos = await request(app.getHttpServer())
      .get('/v1/business/settings/pos')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(pos.status).toBe(200);
    expect(pos.body.ops.recyclingFeeCents).toBe(1800);
    expect(pos.body.ops.poReplyTo).toBeUndefined();
    expect(pos.body.currencyCode).toBe('USD');
    expect(pos.body.receiptHeader).toBe('Biz Test Co — Main Receipt');
    expect(pos.body.status).toBeUndefined();
  });

  it('Cashier has cashier permissions only', async () => {
    // products.view → 200
    const list = await request(app.getHttpServer())
      .get('/v1/products')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);

    // products.update missing → 403 trying to PATCH variant price.
    // Seed a variant first (as owner).
    let variantId: string;
    {
      const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
      const db = drizzle(sql);
      try {
        const [p] = await db
          .insert(schema.products)
          .values({ businessId, sku: 'VARIANT-1', name: 'Test Product' })
          .returning();
        const [v] = await db
          .insert(schema.productVariants)
          .values({ businessId, productId: p!.id, sku: 'VARIANT-1-V1', priceCents: 1234 })
          .returning();
        variantId = v!.id;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    const patch = await request(app.getHttpServer())
      .patch(`/v1/products/variants/${variantId}/price`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ priceCents: 9999 });
    expect(patch.status).toBe(403);
    expect(patch.body.message).toMatch(/products\.update/);

    // audit.view missing → 403 on the audit log endpoint.
    const audit = await request(app.getHttpServer())
      .get('/v1/audit-logs')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(audit.status).toBe(403);

    // Super-admin endpoints rejected entirely.
    const adminMetrics = await request(app.getHttpServer())
      .get('/v1/admin/metrics')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(adminMetrics.status).toBe(403);
  });

  it('Owner clones the Cashier role and adds products.update', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/business/roles')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);
    const cashierRole = (
      list.body as Array<{ name: string; id: string; permissions: string[] }>
    ).find((r) => r.name === 'Cashier');
    expect(cashierRole).toBeDefined();

    const create = await request(app.getHttpServer())
      .post('/v1/business/roles')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Senior Cashier', basedOnRoleId: cashierRole!.id });
    expect(create.status).toBe(201);
    expect(create.body.permissions).toEqual(expect.arrayContaining(cashierRole!.permissions));
    expect(create.body.isSystem).toBe(false);

    // Add products.update to the cloned role.
    const update = await request(app.getHttpServer())
      .patch(`/v1/business/roles/${create.body.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ permissions: [...cashierRole!.permissions, 'products.update'] });
    expect(update.status).toBe(200);
    expect(update.body.permissions).toContain('products.update');
  });

  it('System roles cannot be edited or deleted', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/business/roles')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const ownerRole = (list.body as Array<{ name: string; id: string; isSystem: boolean }>).find(
      (r) => r.name === 'Owner',
    );
    expect(ownerRole?.isSystem).toBe(true);

    const editAttempt = await request(app.getHttpServer())
      .patch(`/v1/business/roles/${ownerRole!.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Big Boss' });
    expect(editAttempt.status).toBe(403);

    const deleteAttempt = await request(app.getHttpServer())
      .delete(`/v1/business/roles/${ownerRole!.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(deleteAttempt.status).toBe(403);
  });

  it('Member access sheet: GET effective, PUT stores diffs only, guard honors them', async () => {
    const server = app.getHttpServer();
    const get = () =>
      request(server)
        .get(`/v1/business/members/${cashierMembershipId}/permissions`)
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId);
    const put = (overrides: unknown) =>
      request(server)
        .put(`/v1/business/members/${cashierMembershipId}/permissions`)
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ overrides });
    const probe = () =>
      request(server)
        .get('/v1/products')
        .set('Cookie', cashierCookie)
        .set('X-Business-Id', businessId);

    // Clean slate: effective access is exactly the role's.
    const initial = await get();
    expect(initial.status).toBe(200);
    expect(initial.body.roleName).toBe('Cashier');
    expect(initial.body.overrides).toEqual([]);
    expect(initial.body.effective).toEqual(initial.body.rolePermissions);
    expect(initial.body.rolePermissions).toContain('products.view');

    // Stage one revoke (role has it), one extra grant (role lacks it),
    // and one no-op deny (role lacks it already) — the no-op must be
    // normalized away so only real diffs are stored.
    const saved = await put([
      { permission: 'products.view', allowed: false },
      { permission: 'products.update', allowed: true },
      { permission: 'audit.view', allowed: false },
    ]);
    expect(saved.status).toBe(200);
    expect(saved.body.overrides).toEqual([
      { permission: 'products.update', allowed: true },
      { permission: 'products.view', allowed: false },
    ]);
    expect(saved.body.effective).toContain('products.update');
    expect(saved.body.effective).not.toContain('products.view');

    // The guard enforces the revoke immediately.
    expect((await probe()).status).toBe(403);

    // Validation: unknown keys, the super-admin surface, and duplicates
    // are all rejected outright.
    expect((await put([{ permission: 'not.a.permission', allowed: true }])).status).toBe(400);
    expect((await put([{ permission: 'platform.templates.manage', allowed: true }])).status).toBe(
      400,
    );
    expect(
      (
        await put([
          { permission: 'products.view', allowed: false },
          { permission: 'products.view', allowed: true },
        ])
      ).status,
    ).toBe(400);

    // Failed PUTs must not have clobbered the stored overrides.
    const still = await get();
    expect(still.body.overrides).toHaveLength(2);

    // Reset to role defaults: empty set clears everything.
    const cleared = await put([]);
    expect(cleared.status).toBe(200);
    expect(cleared.body.overrides).toEqual([]);
    expect((await probe()).status).toBe(200);
  });

  it('Disabling a member sets status=disabled; audit captures it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/business/members/${cashierMembershipId}/disable`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(201);

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [m] = await db
        .select()
        .from(schema.memberships)
        .where(eq(schema.memberships.id, cashierMembershipId));
      expect(m!.status).toBe('disabled');
      const rows = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'membership.disable'));
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('Permission catalog is publicly listable', async () => {
    const res = await request(app.getHttpServer()).get('/v1/permissions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(20);
    const sample = (res.body as Array<{ key: string; description: string }>).find(
      (p) => p.key === 'products.view',
    );
    expect(sample).toBeDefined();
    void ownerUserId; // referenced for completeness.
  });

  it('Phase 2.19: owner can switch currency to a supported code', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ currencyCode: 'EUR' });
    expect(res.status).toBe(200);
    expect(res.body.currencyCode).toBe('EUR');
  });

  it('Phase 2.19: lowercase + JPY both accepted; round-trip persists', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ currencyCode: 'jpy' });
    expect(res.status).toBe(200);
    expect(res.body.currencyCode).toBe('JPY');

    const reread = await request(app.getHttpServer())
      .get('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(reread.body.currencyCode).toBe('JPY');
  });

  it('Phase 2.19: unsupported currency is rejected 400', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ currencyCode: 'XYZ' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/currencyCode must be one of/);
  });

  it('Phase 2.19: restore USD so other tests in the file see the default', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ currencyCode: 'USD' });
    expect(res.status).toBe(200);
    expect(res.body.currencyCode).toBe('USD');
  });
});

describe('White-label branding + agency overview', () => {
  it('Owner sets branding; GET roundtrips it', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        branding: {
          accentColor: '#0ea5e9',
          logoUrl: 'https://example.com/logo.png',
          publicName: 'Sleepy Co',
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.branding).toEqual({
      accentColor: '#0ea5e9',
      logoUrl: 'https://example.com/logo.png',
      publicName: 'Sleepy Co',
    });

    const reread = await request(app.getHttpServer())
      .get('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(reread.body.branding.accentColor).toBe('#0ea5e9');
  });

  it('Branding PATCH merges field-by-field instead of replacing', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ branding: { publicName: 'Sleepy Mattress Co' } });
    expect(res.status).toBe(200);
    // Accent + logo survive a publicName-only patch.
    expect(res.body.branding.accentColor).toBe('#0ea5e9');
    expect(res.body.branding.logoUrl).toBe('https://example.com/logo.png');
    expect(res.body.branding.publicName).toBe('Sleepy Mattress Co');
  });

  it('Rejects bad accent colors and non-https logos', async () => {
    const badColor = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ branding: { accentColor: 'red' } });
    expect(badColor.status).toBe(400);

    const badLogo = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ branding: { logoUrl: 'http://example.com/logo.png' } });
    expect(badLogo.status).toBe(400);
  });

  it('Explicit nulls clear branding fields', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/business/settings')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ branding: { logoUrl: null } });
    expect(res.status).toBe(200);
    expect(res.body.branding.logoUrl).toBeUndefined();
    expect(res.body.branding.accentColor).toBe('#0ea5e9');
  });

  it('Agency overview lists every membership; owner of two businesses sees both with money', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/onboarding/business')
      .set('Cookie', ownerCookie)
      .send({ name: 'Second Store', slug: 'second-store', currencyCode: 'USD' });
    expect(created.status).toBe(201);

    const res = await request(app.getHttpServer())
      .get('/v1/agency/overview')
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.businesses.length).toBeGreaterThanOrEqual(2);
    const second = res.body.businesses.find(
      (b: { businessSlug: string }) => b.businessSlug === 'second-store',
    );
    expect(second).toBeTruthy();
    expect(second.roleName).toBe('Owner');
    // Owner can see money → numeric zeros, not null.
    expect(second.todaySalesCents).toBe(0);
    expect(second.openOrdersCount).toBe(0);
    // Branding rides along for the card accent.
    const first = res.body.businesses.find(
      (b: { businessId: string }) => b.businessId === businessId,
    );
    expect(first.branding.accentColor).toBe('#0ea5e9');
  });

  it('Roles without reports.sales.view get the card but null money', async () => {
    // The suite disabled the cashier's original membership above, so give
    // them a fresh Cashier membership in the second business — a role
    // that has no reports.sales.view grant.
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [second] = await db
        .select({ id: schema.businesses.id })
        .from(schema.businesses)
        .where(eq(schema.businesses.slug, 'second-store'));
      const [cashierRole] = await db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(eq(schema.roles.businessId, second!.id), eq(schema.roles.name, 'Cashier')));
      await db.insert(schema.memberships).values({
        businessId: second!.id,
        userId: cashierUserId,
        roleId: cashierRole!.id,
        status: 'active',
        acceptedAt: new Date(),
      });
    } finally {
      await sql.end({ timeout: 5 });
    }

    const res = await request(app.getHttpServer())
      .get('/v1/agency/overview')
      .set('Cookie', cashierCookie);
    expect(res.status).toBe(200);
    const second = res.body.businesses.find(
      (b: { businessSlug: string }) => b.businessSlug === 'second-store',
    );
    expect(second).toBeTruthy();
    expect(second.todaySalesCents).toBeNull();
    expect(second.openOrdersCount).toBeNull();
    // The disabled membership in the first business stays hidden.
    expect(
      res.body.businesses.find((b: { businessId: string }) => b.businessId === businessId),
    ).toBeUndefined();
  });
});

describe('Deleting a member (owner 2026-09-02)', () => {
  async function makeMember(email: string, roleName: string): Promise<string> {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [role] = await db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(eq(schema.roles.businessId, businessId), eq(schema.roles.name, roleName)))
        .limit(1);
      const [u] = await db
        .insert(schema.users)
        .values({ email, emailVerified: true, name: email.split('@')[0] })
        .returning();
      const [m] = await db
        .insert(schema.memberships)
        .values({
          businessId,
          userId: u!.id,
          roleId: role!.id,
          status: 'active',
          acceptedAt: new Date(),
        })
        .returning();
      return m!.id;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const del = (id: string, cookie = ownerCookie) =>
    request(app.getHttpServer())
      .delete(`/v1/business/members/${id}`)
      .set('Cookie', cookie)
      .set('x-business-id', businessId);

  it('refuses your own membership and the last active Owner', async () => {
    const me = await request(app.getHttpServer())
      .get('/v1/business/members/me')
      .set('Cookie', ownerCookie)
      .set('x-business-id', businessId)
      .expect(200);
    expect(me.body.canDeleteMembers).toBe(true);
    expect(me.body.canSeeCost).toBe(true);
    await del(me.body.membershipId).expect(400);
  });

  it('deletes a seat nothing refers to, archives one with history, and hides both from the roster', async () => {
    const clean = await makeMember('fresh@business-test.local', 'Cashier');
    const veteran = await makeMember('veteran@business-test.local', 'Cashier');
    // The veteran has left a note on an order — that must survive.
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [cust] = await db
        .insert(schema.customers)
        .values({ businessId, firstName: 'Del', lastName: 'Eted' })
        .returning();
      const [loc] = await db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.businessId, businessId))
        .limit(1);
      const [order] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: loc!.id,
          number: 'SO-DEL-1',
          status: 'open',
          customerId: cust!.id,
          subtotalCents: 1000,
          totalCents: 1000,
        })
        .returning();
      await db.insert(schema.orderNotes).values({
        businessId,
        orderId: order!.id,
        authorMembershipId: veteran,
        body: 'call before delivery',
      });
    } finally {
      await sql.end({ timeout: 5 });
    }

    const a = await del(clean).expect(200);
    expect(a.body).toEqual({ removed: true, mode: 'deleted' });
    const b = await del(veteran).expect(200);
    expect(b.body).toEqual({ removed: true, mode: 'archived' });

    const list = await request(app.getHttpServer())
      .get('/v1/business/members')
      .set('Cookie', ownerCookie)
      .set('x-business-id', businessId)
      .expect(200);
    const ids = list.body.map((m: { membershipId: string }) => m.membershipId);
    expect(ids).not.toContain(clean);
    expect(ids).not.toContain(veteran);

    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db2 = drizzle(sql2);
    try {
      const rows = await db2
        .select({ id: schema.memberships.id, status: schema.memberships.status })
        .from(schema.memberships)
        .where(eq(schema.memberships.businessId, businessId));
      expect(rows.find((r) => r.id === clean)).toBeUndefined();
      expect(rows.find((r) => r.id === veteran)?.status).toBe('removed');
      // The note still names its author.
      const [note] = await db2
        .select({ author: schema.orderNotes.authorMembershipId })
        .from(schema.orderNotes)
        .where(eq(schema.orderNotes.body, 'call before delivery'));
      expect(note?.author).toBe(veteran);
      const audits = await db2
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.businessId, businessId),
            eq(schema.auditLogs.targetType, 'membership'),
          ),
        );
      const actions = audits.map((r) => r.action);
      expect(actions).toContain('membership.delete');
      expect(actions).toContain('membership.remove');
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  it('is not a Manager or Cashier call', async () => {
    const target = await makeMember('target@business-test.local', 'Cashier');
    const managerId = await makeMember('mgr@business-test.local', 'Manager');
    void managerId;
    await del(target, cashierCookie).expect(403);
  });
});
