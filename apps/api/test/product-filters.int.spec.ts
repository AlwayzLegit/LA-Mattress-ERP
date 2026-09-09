/**
 * Add Product popup filters (owner ask 2026-09-01): vendor, size,
 * firmness and in-stock on /v1/pos/product-search. Size and firmness are
 * read off the catalog — attributes first, then the product and variant
 * names — so Shopify-shaped names like "Queen Helix Dusk 12" Medium Firm
 * Hybrid Mattress" classify without anyone tagging them. Vendor matches
 * the variant's preferred vendor, the product's brand, or a name that
 * starts with the vendor's name.
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
  process.env.PRODUCT_FILTERS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_product_filters';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'FilterPass!2026x';

let app: INestApplication;
let businessId = '';
let locationId = '';
let helixVendorId = '';
let purpleVendorId = '';
let poId = '';
let cookie = '';
let managerCookie = '';
const bySku = new Map<string, string>();

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

const CATALOG: {
  sku: string;
  name: string;
  variantName?: string;
  attributes?: Record<string, string>;
  brand?: string;
  preferredVendor?: 'helix' | 'purple';
  onHand?: number;
  taxClass?: 'untaxed' | 'override';
}[] = [
  // Shopify-shaped Helix names: size first, firmness inside, no vendor link.
  { sku: 'HX-TW-DUSK', name: 'Twin Helix Dusk 12" Medium Firm Hybrid Mattress', onHand: 3 },
  { sku: 'HX-TXL-DUSK', name: 'Twin XL Helix Dusk 12" Medium Firm Hybrid Mattress' },
  { sku: 'HX-Q-TWI', name: 'Queen Helix Twilight 11.5" Firm Hybrid Mattress', onHand: 1 },
  { sku: 'HX-CK-MID', name: 'Cal King Helix Midnight 12" Medium Hybrid Mattress' },
  { sku: 'HX-SK-SUN', name: 'Split King Helix Sunset Luxe 13.5" Plush Hybrid Mattress' },
  // Hand-built product: firmness/size in the variant attributes, brand set.
  {
    sku: 'PR-Q-REST',
    name: 'Purple Restore',
    variantName: 'Queen / Soft',
    attributes: { size: 'Queen', firmness: 'Plush' },
    brand: 'Purple',
    onHand: 2,
  },
  // Preferred-vendor link only, nothing in the name.
  { sku: 'BASE-K', name: 'Adjustable Base', variantName: 'King', preferredVendor: 'helix' },
  // An Extra Firm King with a Purple preferred vendor.
  { sku: 'PR-K-XF', name: 'Purple Extra Firm King Mattress', preferredVendor: 'purple' },
  // A second import of the Queen Twilight: same name, different SKU, no stock.
  { sku: 'HELIX-SLEEP-TWILIGHT-Q-3DA9', name: 'Queen Helix Twilight 11.5" Firm Hybrid Mattress' },
  // Services are untaxed (owner 2026-09-06): a 0% tax class on the product.
  { sku: 'SVC-PB-INSTALL', name: 'POWER BASE INSTALLATION', taxClass: 'untaxed' },
  // A product on a class with a per-store override (no size / vendor / stock, so the other filters ignore it).
  { sku: 'ACC-PROTECTOR', name: 'MATTRESS PROTECTOR', taxClass: 'override' },
];

async function seed() {
  await withDb(async (db) => {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'filters-test', name: 'Filters Test Co', status: 'active' })
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
    const [u] = await db
      .insert(schema.users)
      .values({ email: 'cashier@filters-test.local', emailVerified: true, name: 'Cashier' })
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
      roleId: roles.get('Cashier')!,
      status: 'active',
      acceptedAt: new Date(),
    });
    const [m] = await db
      .insert(schema.users)
      .values({ email: 'manager@filters-test.local', emailVerified: true, name: 'Manager' })
      .returning();
    await db.insert(schema.accounts).values({
      accountId: m!.id,
      providerId: 'credential',
      userId: m!.id,
      password: passwordHash,
    });
    await db.insert(schema.memberships).values({
      businessId,
      userId: m!.id,
      roleId: roles.get('Manager')!,
      status: 'active',
      acceptedAt: new Date(),
    });
    const [loc] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Main', timezone: 'America/Los_Angeles' })
      .returning();
    locationId = loc!.id;
    const vendors = await db
      .insert(schema.vendors)
      .values([
        { businessId, name: 'Helix' },
        { businessId, name: 'Purple' },
      ])
      .returning();
    helixVendorId = vendors[0]!.id;
    purpleVendorId = vendors[1]!.id;
    // An open Helix PO: 5 ordered, 2 received → 3 still to come.
    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        businessId,
        vendorId: helixVendorId,
        locationId,
        number: 'PO-VF-001',
        status: 'partially_received',
        subtotalCents: 0,
      })
      .returning();
    poId = po!.id;
    const [purpleBrand] = await db
      .insert(schema.brands)
      .values({ businessId, name: 'Purple' })
      .returning();
    const [untaxed, overridden] = await db
      .insert(schema.taxClasses)
      .values([
        { businessId, name: 'Non-taxable', rateBps: 0 },
        { businessId, name: 'Furniture', rateBps: 875 },
      ])
      .returning();
    await db.insert(schema.taxClassRates).values({
      businessId,
      taxClassId: overridden!.id,
      locationId,
      rateBps: 950,
    });
    const taxClassIds = { untaxed: untaxed!.id, override: overridden!.id };

    for (const item of CATALOG) {
      const [p] = await db
        .insert(schema.products)
        .values({
          businessId,
          sku: item.sku,
          name: item.name,
          brandId: item.brand === 'Purple' ? purpleBrand!.id : null,
          taxClassId: item.taxClass ? taxClassIds[item.taxClass] : null,
        })
        .returning();
      const [v] = await db
        .insert(schema.productVariants)
        .values({
          businessId,
          productId: p!.id,
          sku: `${item.sku}-V`,
          name: item.variantName ?? null,
          attributesJson: (item.attributes ?? null) as never,
          priceCents: 100_000,
          preferredVendorId:
            item.preferredVendor === 'helix'
              ? helixVendorId
              : item.preferredVendor === 'purple'
                ? purpleVendorId
                : null,
        })
        .returning();
      bySku.set(item.sku, v!.id);
      // Provenance: the Queen Twilight pair is one STORIS import + one Shopify sync.
      const batchSource =
        item.sku === 'HX-Q-TWI'
          ? 'storis'
          : item.sku === 'HELIX-SLEEP-TWILIGHT-Q-3DA9'
            ? 'shopify'
            : null;
      if (batchSource) {
        const [batch] = await db
          .insert(schema.importBatches)
          .values({ businessId, entity: 'product', source: batchSource, status: 'committed' })
          .returning();
        await db.insert(schema.legacyRefs).values({
          businessId,
          entity: 'product',
          legacyId: item.sku,
          jetnineId: p!.id,
          source: batchSource,
          importBatchId: batch!.id,
        });
      }
      if (item.sku === 'HX-TW-DUSK') {
        await db.insert(schema.purchaseOrderLines).values({
          businessId,
          purchaseOrderId: poId,
          variantId: v!.id,
          quantityOrdered: 5,
          quantityReceived: 2,
          unitCostCents: 40_000,
          lineTotalCents: 200_000,
        });
      }
      if (item.onHand) {
        await db.insert(schema.inventoryLevels).values({
          businessId,
          variantId: v!.id,
          locationId,
          onHand: item.onHand,
        });
      }
    }
  });
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

async function search(params: Record<string, string>) {
  const qs = new URLSearchParams({ locationId, limit: '50', ...params }).toString();
  const res = await request(app.getHttpServer())
    .get(`/v1/pos/product-search?${qs}`)
    .set('Cookie', cookie)
    .set('x-business-id', businessId)
    .expect(200);
  return res.body as {
    sku: string;
    size: string | null;
    firmness: string | null;
    taxRateBps: number | null;
  }[];
}
const skus = (rows: { sku: string }[]) => rows.map((r) => r.sku.replace(/-V$/, '')).sort();

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'filters-test-secret-filters-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();
  cookie = await captureCookie('cashier@filters-test.local');
  managerCookie = await captureCookie('manager@filters-test.local');
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('Add Product filters', () => {
  it('classifies size and firmness off names and attributes', async () => {
    const rows = await search({});
    const by = new Map(rows.map((r) => [r.sku.replace(/-V$/, ''), r]));
    expect(by.get('HX-TW-DUSK')).toMatchObject({ size: 'Twin', firmness: 'Medium Firm' });
    expect(by.get('HX-TXL-DUSK')).toMatchObject({ size: 'Twin XL', firmness: 'Medium Firm' });
    expect(by.get('HX-Q-TWI')).toMatchObject({ size: 'Queen', firmness: 'Firm' });
    expect(by.get('HX-CK-MID')).toMatchObject({ size: 'Cal King', firmness: 'Medium' });
    expect(by.get('HX-SK-SUN')).toMatchObject({ size: 'Split King', firmness: 'Plush' });
    expect(by.get('PR-Q-REST')).toMatchObject({ size: 'Queen', firmness: 'Plush' });
    expect(by.get('BASE-K')).toMatchObject({ size: 'King', firmness: null });
    expect(by.get('PR-K-XF')).toMatchObject({ size: 'King', firmness: 'Extra Firm' });
  });

  it('filters by size', async () => {
    expect(skus(await search({ size: 'Queen' }))).toEqual([
      'HELIX-SLEEP-TWILIGHT-Q-3DA9',
      'HX-Q-TWI',
      'PR-Q-REST',
    ]);
    expect(skus(await search({ size: 'Twin' }))).toEqual(['HX-TW-DUSK']);
    expect(skus(await search({ size: 'King' }))).toEqual(['BASE-K', 'PR-K-XF']);
    expect(skus(await search({ size: 'cal king' }))).toEqual(['HX-CK-MID']);
  });

  it('filters by firmness', async () => {
    expect(skus(await search({ firmness: 'Medium Firm' }))).toEqual(['HX-TW-DUSK', 'HX-TXL-DUSK']);
    expect(skus(await search({ firmness: 'Firm' }))).toEqual([
      'HELIX-SLEEP-TWILIGHT-Q-3DA9',
      'HX-Q-TWI',
    ]);
    expect(skus(await search({ firmness: 'Plush' }))).toEqual(['HX-SK-SUN', 'PR-Q-REST']);
  });

  it('filters by vendor through the preferred vendor, the brand, or the name', async () => {
    // Helix: five named products + the base linked by preferred vendor.
    expect(skus(await search({ vendorId: helixVendorId }))).toEqual([
      'BASE-K',
      'HELIX-SLEEP-TWILIGHT-Q-3DA9',
      'HX-CK-MID',
      'HX-Q-TWI',
      'HX-SK-SUN',
      'HX-TW-DUSK',
      'HX-TXL-DUSK',
    ]);
    // Purple: brand link, name, and preferred vendor.
    expect(skus(await search({ vendorId: purpleVendorId }))).toEqual(['PR-K-XF', 'PR-Q-REST']);
  });

  it('combines with in-stock and with each other', async () => {
    expect(skus(await search({ inStock: '1' }))).toEqual(['HX-Q-TWI', 'HX-TW-DUSK', 'PR-Q-REST']);
    expect(skus(await search({ size: 'Queen', inStock: '1', vendorId: helixVendorId }))).toEqual([
      'HX-Q-TWI',
    ]);
    expect(skus(await search({ size: 'Queen', firmness: 'Plush' }))).toEqual(['PR-Q-REST']);
    expect(skus(await search({ size: 'Queen', firmness: 'Firm', inStock: '1' }))).toEqual([
      'HX-Q-TWI',
    ]);
    expect(await search({ size: 'Twin XL', inStock: '1' })).toEqual([]);
  });

  it("carries each product's own tax rate so the register can preview an untaxed service", async () => {
    const rows = await search({});
    const by = new Map(rows.map((r) => [r.sku.replace(/-V$/, ''), r]));
    // 0% class → untaxed; class with a store override → the override; no class → null (store rate).
    expect(by.get('SVC-PB-INSTALL')).toMatchObject({ taxRateBps: 0 });
    expect(by.get('ACC-PROTECTOR')).toMatchObject({ taxRateBps: 950 });
    expect(by.get('HX-Q-TWI')).toMatchObject({ taxRateBps: null });
    // Without a location the override cannot apply: the class fallback shows.
    const qs = new URLSearchParams({ limit: '50', q: 'PROTECTOR' }).toString();
    const res = await request(app.getHttpServer())
      .get(`/v1/pos/product-search?${qs}`)
      .set('Cookie', cookie)
      .set('x-business-id', businessId)
      .expect(200);
    expect(res.body[0]).toMatchObject({ sku: 'ACC-PROTECTOR-V', taxRateBps: 875 });
  });

  it('rejects an unknown size or firmness', async () => {
    const qs = new URLSearchParams({ locationId, size: 'Enormous' }).toString();
    await request(app.getHttpServer())
      .get(`/v1/pos/product-search?${qs}`)
      .set('Cookie', cookie)
      .set('x-business-id', businessId)
      .expect(400);
  });
});

describe('duplicate products', () => {
  it('groups active products by name with what retiring each would touch', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/products/duplicates')
      .set('Cookie', cookie)
      .set('x-business-id', businessId)
      .expect(200);
    expect(res.body.productCount).toBe(2);
    expect(res.body.groups).toHaveLength(1);
    const [group] = res.body.groups;
    expect(group.name).toBe('Queen Helix Twilight 11.5" Firm Hybrid Mattress');
    const bySku = new Map(group.products.map((p: { sku: string }) => [p.sku, p]));
    expect(bySku.get('HX-Q-TWI')).toMatchObject({
      onHand: 1,
      documents: 0,
      deletable: false,
      source: 'storis',
      imported: true,
    });
    expect(bySku.get('HELIX-SLEEP-TWILIGHT-Q-3DA9')).toMatchObject({
      onHand: 0,
      documents: 0,
      deletable: true,
      priceCents: 100_000,
      source: 'shopify',
      imported: false,
    });
  });

  it('"keep imported" needs products.update and deactivates the non-import copy', async () => {
    await request(app.getHttpServer())
      .post('/v1/products/duplicates/keep-imported')
      .set('Cookie', cookie)
      .set('x-business-id', businessId)
      .send({})
      .expect(403);
    const res = await request(app.getHttpServer())
      .post('/v1/products/duplicates/keep-imported')
      .set('Cookie', managerCookie)
      .set('x-business-id', businessId)
      .send({ names: ['Queen Helix Twilight 11.5" Firm Hybrid Mattress'] })
      .expect(201);
    expect(res.body.kept).toBe(1);
    expect(res.body.deactivated.map((d: { sku: string }) => d.sku)).toEqual([
      'HELIX-SLEEP-TWILIGHT-Q-3DA9',
    ]);
    // Running it again finds nothing left to do.
    const again = await request(app.getHttpServer())
      .post('/v1/products/duplicates/keep-imported')
      .set('Cookie', managerCookie)
      .set('x-business-id', businessId)
      .send({})
      .expect(201);
    expect(again.body.deactivated).toEqual([]);
  });

  it('drops a group once one of the pair is deactivated', async () => {
    // A manager retires the second import (products.update — not a
    // cashier's call, so straight to the row here).
    const productId = await productIdForVariant(bySku.get('HELIX-SLEEP-TWILIGHT-Q-3DA9')!);
    await withDb((db) =>
      db.update(schema.products).set({ isActive: false }).where(eq(schema.products.id, productId)),
    );
    const res = await request(app.getHttpServer())
      .get('/v1/products/duplicates')
      .set('Cookie', cookie)
      .set('x-business-id', businessId)
      .expect(200);
    expect(res.body.groups).toEqual([]);
    // And the register no longer offers it.
    expect(skus(await search({ size: 'Queen', firmness: 'Firm' }))).toEqual(['HX-Q-TWI']);
  });
});

async function productIdForVariant(variantId: string): Promise<string> {
  return withDb(async (db) => {
    const [v] = await db
      .select({ productId: schema.productVariants.productId })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId))
      .limit(1);
    return v!.productId;
  });
}

describe('vendor counts and doors', () => {
  const get = (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Cookie', managerCookie)
      .set('x-business-id', businessId);

  it('counts what we carry, what is in stock, and what is on PO per vendor', async () => {
    const res = await get('/v1/vendors').expect(200);
    const byName = new Map(res.body.map((v: { name: string }) => [v.name, v]));
    // Helix: the five named mattresses + the base (preferred vendor); one of
    // the six is the Twilight duplicate deactivated by keep-imported above.
    expect((byName.get('Helix') as { stats: unknown }).stats).toEqual({
      productsCarried: 6,
      inStockProducts: 2,
      inStockUnits: 4,
      onPoUnits: 3,
      openPos: 1,
    });
    expect((byName.get('Purple') as { stats: unknown }).stats).toEqual({
      productsCarried: 2,
      inStockProducts: 1,
      inStockUnits: 2,
      onPoUnits: 0,
      openPos: 0,
    });
  });

  it('the inventory and products pages take the same vendor filter', async () => {
    const inv = await get(`/v1/inventory/levels?vendorId=${helixVendorId}`).expect(200);
    expect(inv.body.map((r: { variantSku: string }) => r.variantSku).sort()).toEqual([
      'HX-Q-TWI-V',
      'HX-TW-DUSK-V',
    ]);
    const prods = await get(`/v1/products?vendorId=${purpleVendorId}&limit=50`).expect(200);
    expect(prods.body.data.map((r: { sku: string }) => r.sku).sort()).toEqual([
      'PR-K-XF',
      'PR-Q-REST',
    ]);
  });
});
