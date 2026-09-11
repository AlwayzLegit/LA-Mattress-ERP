/**
 * Epic 1.7 acceptance: a user creates a product with 3 variants, uploads
 * (registers) an image, and finds the product by partial SKU and by barcode.
 *
 * Also exercises the rest of the catalog: categories tree depth limit,
 * cost redaction without products.cost.view, image cap of 4, and CSV
 * import preview + commit.
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
  process.env.CATALOG_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_catalog';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'CatalogPass!2026';

let app: INestApplication;
let businessId: string;
let ownerCookie = '';
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
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'catalog-test', name: 'Catalog Test Co', status: 'active' })
      .returning();
    businessId = biz!.id;

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
        businessId: biz!.id,
        userId: u!.id,
        roleId: roles.get(role)!,
        status: 'active',
        acceptedAt: new Date(),
      });
    }
    await makeUser('owner@catalog-test.local', 'Owner');
    await makeUser('cashier@catalog-test.local', 'Cashier');
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
  process.env.BETTER_AUTH_SECRET ??= 'catalog-test-secret-catalog-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();

  ownerCookie = await captureCookie('owner@catalog-test.local');
  cashierCookie = await captureCookie('cashier@catalog-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Epic 1.7 — Product catalog', () => {
  let categoryId = '';
  let productId = '';

  it('Owner creates a category', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/categories')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Furniture' });
    expect(res.status).toBe(201);
    categoryId = res.body.id as string;
  });

  it('Categories enforce a 3-level depth limit', async () => {
    const child = await request(app.getHttpServer())
      .post('/v1/categories')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Sofas', parentId: categoryId });
    expect(child.status).toBe(201);
    const grand = await request(app.getHttpServer())
      .post('/v1/categories')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Sectionals', parentId: child.body.id });
    expect(grand.status).toBe(201);
    const tooDeep = await request(app.getHttpServer())
      .post('/v1/categories')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'L-Shaped', parentId: grand.body.id });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body.message).toMatch(/3 levels/i);
  });

  it('Owner creates a product with 3 variants', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/products')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        sku: 'WIDGET-001',
        name: 'Premium Widget',
        description: 'A widget that searches well',
        categoryId,
        variants: [
          {
            sku: 'WIDGET-001-SM',
            name: 'Small',
            priceCents: 1999,
            costCents: 800,
            barcode: '0123456789012',
          },
          {
            sku: 'WIDGET-001-MD',
            name: 'Medium',
            priceCents: 2999,
            costCents: 1100,
            barcode: '0123456789013',
          },
          {
            sku: 'WIDGET-001-LG',
            name: 'Large',
            priceCents: 3999,
            costCents: 1400,
            barcode: '0123456789014',
          },
        ],
      });
    expect(res.status).toBe(201);
    productId = res.body.id as string;
    expect(res.body.variants).toHaveLength(3);
    // Owner has products.cost.view (Owner role has all permissions),
    // so costCents survives the response shaping.
    expect(res.body.variants[0].costCents).toBe(800);
  });

  it('Find by partial SKU returns the product', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products?q=WIDGET-001-MD')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string; name: string }[]).map((p) => p.id);
    expect(ids).toContain(productId);
  });

  it('Find by barcode returns the product', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products?q=0123456789013')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(productId);
  });

  it('Find by free-text name matches', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products?q=Premium')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(productId);
  });

  it('Browser sorts by any column and pages by offset (owner 2026-09-11)', async () => {
    // Two more products around the widget: a cheap one first by name, a
    // dear one last by name.
    for (const [sku, name, priceCents] of [
      ['AARD-1', 'Aardvark Base', 999],
      ['ZEPH-1', 'Zephyr Pillow', 5999],
    ] as const) {
      await request(app.getHttpServer())
        .post('/v1/products')
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ sku, name, variants: [{ sku: `${sku}-A`, name: 'Std', priceCents }] })
        .expect(201);
    }
    const byPrice = await request(app.getHttpServer())
      .get('/v1/products?sort=priceCents&dir=desc')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const prices = (byPrice.body.data as { priceCents: number | null }[]).map((p) => p.priceCents);
    expect(prices[0]).toBe(5999);
    for (let i = 1; i < prices.length; i++) {
      // Descending, blanks (null) last.
      if (prices[i] != null) expect(prices[i]!).toBeLessThanOrEqual(prices[i - 1] ?? Infinity);
    }

    // Offset paging follows the sort: one row per page, names ascending.
    const first = await request(app.getHttpServer())
      .get('/v1/products?sort=name&dir=asc&limit=1')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0].name).toBe('Aardvark Base');
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app.getHttpServer())
      .get(`/v1/products?sort=name&dir=asc&limit=1&cursor=${first.body.nextCursor}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(
      String(second.body.data[0].name).localeCompare('Aardvark Base', undefined, {
        sensitivity: 'base',
      }),
    ).toBeGreaterThan(0);

    // Search results sort too; a made-up column is refused.
    const searched = await request(app.getHttpServer())
      .get('/v1/products?q=Widget&sort=priceCents&dir=asc')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(searched.body.nextCursor).toBeNull();
    await request(app.getHttpServer())
      .get('/v1/products?sort=bogus')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(400);
  });

  it('Cashier (products.view but not products.cost.view) sees prices but not costs', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/products/${productId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.variants[0].priceCents).toBe(1999);
    expect(res.body.variants[0].costCents).toBeNull();
  });

  it('Owner registers up to 4 product images; the 5th is rejected', async () => {
    for (let i = 0; i < 4; i++) {
      const url = await request(app.getHttpServer())
        .post(`/v1/products/${productId}/images/upload-url`)
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ contentType: 'image/png', filename: `img${i}.png` });
      expect(url.status).toBe(201);
      const reg = await request(app.getHttpServer())
        .post(`/v1/products/${productId}/images`)
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ storageKey: url.body.storageKey, position: i });
      expect(reg.status).toBe(201);
    }
    const fifth = await request(app.getHttpServer())
      .post(`/v1/products/${productId}/images/upload-url`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ contentType: 'image/png' });
    expect(fifth.status).toBe(409);
  });

  it('Product detail includes the 4 registered images', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/products/${productId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(4);
    expect(res.body.images[0].storageKey).toContain(`businesses/${businessId}/products/`);
  });

  it('CSV import preview parses rows, then commit creates products', async () => {
    const csv = [
      'name,sku,price,barcode',
      'Widget A,WGT-A,12.50,A0001',
      'Widget B,WGT-B,5.00,A0002',
      'Widget C,WGT-C,99,', // no barcode
    ].join('\n');

    const preview = await request(app.getHttpServer())
      .post('/v1/products/import/preview')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ csv });
    expect(preview.status).toBe(201);
    expect(preview.body.rows).toHaveLength(3);
    expect(preview.body.errors).toHaveLength(0);
    expect(preview.body.conflicts).toHaveLength(0);
    expect(preview.body.rows[0].priceCents).toBe(1250);

    const commit = await request(app.getHttpServer())
      .post('/v1/products/import/commit')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ csv });
    expect(commit.status).toBe(201);
    expect(commit.body.inserted).toBe(3);
    expect(commit.body.productIds).toHaveLength(3);

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const variants = await db
        .select()
        .from(schema.productVariants)
        .where(eq(schema.productVariants.sku, 'WGT-A'));
      expect(variants).toHaveLength(1);
      expect(variants[0]!.priceCents).toBe(1250);
      expect(variants[0]!.barcode).toBe('A0001');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('Bulk price entry (pricing work-list + bulk-price)', () => {
  let unpricedIds: string[] = [];

  it('Owner creates a product whose variants land at $0 (the STORIS import shape)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/products')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        sku: 'STORIS-Q1',
        name: 'Imported Queen Mattress',
        variants: [
          { sku: 'STORIS-Q1-A', name: 'Firm', priceCents: 0, costCents: 50000 },
          { sku: 'STORIS-Q1-B', name: 'Plush', priceCents: 0, costCents: 52000 },
        ],
      });
    expect(res.status).toBe(201);
    unpricedIds = (res.body.variants as { id: string }[]).map((v) => v.id);
    expect(unpricedIds).toHaveLength(2);
  });

  it('Pricing list with unpricedOnly returns only the $0 variants and counts them', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products/variants/pricing?unpricedOnly=1')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const skus = (res.body.data as { sku: string | null; priceCents: number }[]).map((r) => r.sku);
    expect(skus).toContain('STORIS-Q1-A');
    expect(skus).toContain('STORIS-Q1-B');
    for (const row of res.body.data as { priceCents: number }[]) {
      expect(row.priceCents).toBe(0);
    }
    expect(res.body.unpricedCount).toBe(2);
    // Owner holds products.cost.view — cost survives the projection.
    const rowA = (res.body.data as { sku: string | null; costCents: number | null }[]).find(
      (r) => r.sku === 'STORIS-Q1-A',
    );
    expect(rowA?.costCents).toBe(50000);
  });

  it('Cashier sees the work-list but never a cost', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products/variants/pricing?unpricedOnly=1')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    for (const row of res.body.data as { costCents: number | null }[]) {
      expect(row.costCents).toBeNull();
    }
  });

  it('Cashier (no products.update) cannot bulk-write prices', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/products/variants/bulk-price')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ updates: [{ id: unpricedIds[0], priceCents: 99900 }] });
    expect(res.status).toBe(403);
  });

  it('Bulk-price rejects malformed updates', async () => {
    const bad = await request(app.getHttpServer())
      .post('/v1/products/variants/bulk-price')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ updates: [{ id: unpricedIds[0], priceCents: 12.5 }] });
    expect(bad.status).toBe(400);
    const empty = await request(app.getHttpServer())
      .post('/v1/products/variants/bulk-price')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ updates: [] });
    expect(empty.status).toBe(400);
    const unknown = await request(app.getHttpServer())
      .post('/v1/products/variants/bulk-price')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        updates: [{ id: '00000000-0000-4000-8000-000000000000', priceCents: 1000 }],
      });
    expect(unknown.status).toBe(404);
  });

  it('Owner bulk-writes prices; unchanged rows are skipped and audited rows change', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/products/variants/bulk-price')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        updates: [
          { id: unpricedIds[0], priceCents: 129900 },
          { id: unpricedIds[1], priceCents: 0 }, // unchanged — stays $0
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.updated).toBe(1);
    expect(res.body.unchanged).toBe(1);

    const after = await request(app.getHttpServer())
      .get('/v1/products/variants/pricing?unpricedOnly=1')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(after.status).toBe(200);
    expect(after.body.unpricedCount).toBe(1);
    const skus = (after.body.data as { sku: string | null }[]).map((r) => r.sku);
    expect(skus).not.toContain('STORIS-Q1-A');
    expect(skus).toContain('STORIS-Q1-B');

    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql);
    try {
      const [v] = await db
        .select()
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, unpricedIds[0]!));
      expect(v!.priceCents).toBe(129900);
      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.targetId, unpricedIds[0]!));
      const priceAudit = audits.find((a) => a.action === 'product.variant.price.update');
      expect(priceAudit).toBeDefined();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('Brand & Collection reference data', () => {
  let brandId = '';
  let collectionId = '';
  let brandedProductId = '';

  it('Owner creates a brand and a collection; duplicates 409', async () => {
    const brand = await request(app.getHttpServer())
      .post('/v1/brands')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Tempur-Pedic' });
    expect(brand.status).toBe(201);
    brandId = brand.body.id as string;

    const dup = await request(app.getHttpServer())
      .post('/v1/brands')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Tempur-Pedic' });
    expect(dup.status).toBe(409);

    const collection = await request(app.getHttpServer())
      .post('/v1/collections')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'ProAdapt' });
    expect(collection.status).toBe(201);
    collectionId = collection.body.id as string;

    const badVendor = await request(app.getHttpServer())
      .post('/v1/collections')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Ghost', vendorId: '00000000-0000-4000-8000-000000000000' });
    expect(badVendor.status).toBe(400);
  });

  it('Cashier can list but not create', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/brands')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);
    expect((list.body as { name: string }[]).map((b) => b.name)).toContain('Tempur-Pedic');

    const create = await request(app.getHttpServer())
      .post('/v1/brands')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Nope' });
    expect(create.status).toBe(403);
  });

  it('Product carries brandId/collectionId through create, PATCH, and detail', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/products')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        sku: 'TP-PROADAPT-Q',
        name: 'ProAdapt Queen',
        brandId,
        variants: [{ sku: 'TP-PROADAPT-Q-M', priceCents: 299900 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.brandId).toBe(brandId);
    expect(created.body.collectionId).toBeNull();
    brandedProductId = created.body.id as string;

    const patched = await request(app.getHttpServer())
      .patch(`/v1/products/${brandedProductId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ collectionId });
    expect(patched.status).toBe(200);
    expect(patched.body.brandId).toBe(brandId);
    expect(patched.body.collectionId).toBe(collectionId);

    const cleared = await request(app.getHttpServer())
      .patch(`/v1/products/${brandedProductId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ brandId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.brandId).toBeNull();
  });

  it('Deactivated brand disappears from nothing — rename and deactivate audit-logged', async () => {
    const upd = await request(app.getHttpServer())
      .patch(`/v1/brands/${brandId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ isActive: false });
    expect(upd.status).toBe(200);
    const list = await request(app.getHttpServer())
      .get('/v1/brands')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const row = (list.body as { id: string; isActive: boolean }[]).find((b) => b.id === brandId);
    expect(row?.isActive).toBe(false);
  });
});

/**
 * Owner ask 2026-08-30: "I need to be able to delete a product
 * completely." Hard delete goes through only for a product with zero
 * stock and no document history; anything else is refused with the
 * reason and steered to Deactivate.
 */
describe('Product delete (owner ask 2026-08-30)', () => {
  let locationId = '';

  async function makeProduct(sku: string): Promise<{ id: string; variantId: string }> {
    const res = await request(app.getHttpServer())
      .post('/v1/products')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ sku, name: `Deletable ${sku}`, variants: [{ sku: `${sku}-V`, priceCents: 9_900 }] });
    expect(res.status).toBe(201);
    return { id: res.body.id, variantId: res.body.variants[0].id };
  }

  beforeAll(async () => {
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      const [loc] = await db
        .insert(schema.locations)
        .values({ businessId, name: 'Delete Test Store', timezone: 'America/Los_Angeles' })
        .returning();
      locationId = loc!.id;
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  it('deletes an unused product completely', async () => {
    const p = await makeProduct('DEL-CLEAN');
    const del = await request(app.getHttpServer())
      .delete(`/v1/products/${p.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const gone = await request(app.getHttpServer())
      .get(`/v1/products/${p.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(gone.status).toBe(404);
  });

  it('refuses while stock remains, then deletes once zeroed', async () => {
    const p = await makeProduct('DEL-STOCK');
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      await db
        .insert(schema.inventoryLevels)
        .values({ businessId, variantId: p.variantId, locationId, onHand: 3, reserved: 0 });

      const refused = await request(app.getHttpServer())
        .delete(`/v1/products/${p.id}`)
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toMatch(/3 on hand/);

      await db
        .update(schema.inventoryLevels)
        .set({ onHand: 0 })
        .where(eq(schema.inventoryLevels.variantId, p.variantId));
    } finally {
      await sql2.end({ timeout: 5 });
    }

    const ok = await request(app.getHttpServer())
      .delete(`/v1/products/${p.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(ok.status).toBe(200);
  });

  it('refuses a product that appears on documents, steering to Deactivate', async () => {
    const p = await makeProduct('DEL-DOCS');
    const sql2 = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sql2);
    try {
      await db
        .insert(schema.asIsItems)
        .values({ businessId, variantId: p.variantId, locationId, quantity: 1 });
    } finally {
      await sql2.end({ timeout: 5 });
    }

    const refused = await request(app.getHttpServer())
      .delete(`/v1/products/${p.id}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/1 as-is pieces/);
    expect(refused.body.message).toMatch(/Deactivate it instead/);
  });

  it('a cashier cannot delete products', async () => {
    const p = await makeProduct('DEL-PERM');
    const res = await request(app.getHttpServer())
      .delete(`/v1/products/${p.id}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(403);
  });
});

describe('Nested categories in the browser (A22.1)', () => {
  it('filtering by a parent category returns the subcategory products, each with its path', async () => {
    const parent = await request(app.getHttpServer())
      .post('/v1/categories')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Mattresses (tree test)' })
      .expect(201);
    const parentId = parent.body.id as string;
    const child = await request(app.getHttpServer())
      .post('/v1/categories')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ name: 'Hybrid', parentId })
      .expect(201);
    const childId = child.body.id as string;
    const mk = async (sku: string, categoryId: string) => {
      const res = await request(app.getHttpServer())
        .post('/v1/products')
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId)
        .send({ sku, name: sku, categoryId, variants: [{ sku, name: 'Queen', priceCents: 1 }] })
        .expect(201);
      return res.body.id as string;
    };
    const onParent = await mk('TREE-PARENT', parentId);
    const onChild = await mk('TREE-CHILD', childId);

    const byParent = await request(app.getHttpServer())
      .get(`/v1/products?categoryId=${parentId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    const rows = byParent.body.data as { id: string; categoryPath: string | null }[];
    expect(rows.map((r) => r.id).sort()).toEqual([onChild, onParent].sort());
    expect(rows.find((r) => r.id === onChild)?.categoryPath).toBe(
      'Mattresses (tree test) › Hybrid',
    );
    expect(rows.find((r) => r.id === onParent)?.categoryPath).toBe('Mattresses (tree test)');

    const byChild = await request(app.getHttpServer())
      .get(`/v1/products?categoryId=${childId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect((byChild.body.data as { id: string }[]).map((r) => r.id)).toEqual([onChild]);

    const detail = await request(app.getHttpServer())
      .get(`/v1/products/${onChild}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .expect(200);
    expect(detail.body.categoryName).toBe('Hybrid');
    expect(detail.body.categoryPath).toBe('Mattresses (tree test) › Hybrid');
  });
});
