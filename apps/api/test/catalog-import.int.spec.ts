/**
 * The production catalog load, rehearsed on the real 2026-09-03 STORIS
 * files: apps/api/src/ops/catalog-import.ts (the Render one-off job that
 * .github/workflows/ops-catalog-import.yml dispatches) runs products.csv
 * and inventory.csv through the pipeline against a tenant that carries
 * the five LA Mattress locations plus the kind of catalog noise the
 * replace has to deal with — a Shopify-created listing holding stock and
 * a stale SKU with no history. Every gate the script enforces is
 * exercised here, so a file or a code change that would fail in
 * production fails in CI first.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@jetnine/db';
import {
  CatalogImportGateError,
  resolveImportFile,
  runCatalogImport,
} from '../src/ops/catalog-import';

const TEST_DB_URL =
  process.env.CATALOG_IMPORT_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_catalog_import';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PRODUCTS = 'docs/imports/2026-09-03/products.csv';
const INVENTORY = 'docs/imports/2026-09-03/inventory.csv';
const SLUG = 'la-mattress-rehearsal';
// The ERP store names (owner 2026-09-10: STORIS "201 Western" is Koreatown,
// "Hancock Park" is La Brea); the converted file carries these.
const LOCATIONS = ['Koreatown', 'La Brea', 'Studio City', 'Warehouse', 'West LA'];

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
let businessId = '';
let logLines: string[] = [];
const log = (line: string) => {
  logLines.push(line);
};

function dataRows(file: string): string[][] {
  return readFileSync(resolveImportFile(file), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','));
}

beforeAll(async () => {
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
  sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  db = drizzle(sql);
  const [biz] = await db
    .insert(schema.businesses)
    .values({ slug: SLUG, name: 'LA Mattress (rehearsal)', status: 'active' })
    .returning();
  businessId = biz!.id;
  await db.insert(schema.locations).values(
    LOCATIONS.map((name) => ({
      businessId,
      name,
      timezone: 'America/Los_Angeles',
      taxRateBps: 0,
    })),
  );
  const [warehouse] = await db
    .select({ id: schema.locations.id })
    .from(schema.locations)
    .where(
      and(eq(schema.locations.businessId, businessId), eq(schema.locations.name, 'Warehouse')),
    );
  // Catalog noise the replace must handle: a Shopify-created listing that
  // still holds units, and a stale STORIS SKU nothing references.
  for (const [sku, name, onHand] of [
    ['shp-4411', 'helix midnight queen', 2],
    ['OLD-GONE', 'DISCONTINUED TWIN', 0],
  ] as const) {
    const [p] = await db
      .insert(schema.products)
      .values({ businessId, sku, name })
      .returning({ id: schema.products.id });
    const [v] = await db
      .insert(schema.productVariants)
      .values({ businessId, productId: p!.id, sku, priceCents: 129900 })
      .returning({ id: schema.productVariants.id });
    await db.insert(schema.inventoryLevels).values({
      businessId,
      variantId: v!.id,
      locationId: warehouse!.id,
      onHand,
      reserved: 0,
    });
  }
  // Another tenant's committed import rows share legacy ids with ours;
  // the recon for our business must not read them.
  const [other] = await db
    .insert(schema.businesses)
    .values({ slug: 'other-tenant', name: 'Other Tenant', status: 'active' })
    .returning({ id: schema.businesses.id });
  const [noise] = await db
    .insert(schema.importBatches)
    .values({
      businessId: other!.id,
      entity: 'inventory',
      status: 'committed',
      rowCount: 1,
      committedRowCount: 1,
      committedAt: new Date(),
    })
    .returning({ id: schema.importBatches.id });
  await db.insert(schema.importRows).values({
    businessId: other!.id,
    batchId: noise!.id,
    rowNumber: 1,
    rawJson: { SKU: '7703-6/6', LOCATION: 'Warehouse', ON_HAND: '999' },
    normalizedJson: { sku: '7703-6/6', location: 'Warehouse', onHand: 999, unitCostCents: 1 },
    legacyId: '7703-6/6@Warehouse',
    status: 'committed',
  });
}, 120_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe('catalog-import ops script on the 2026-09-03 files', () => {
  it('refuses a wrong --expect-rows before validating', async () => {
    await expect(
      runCatalogImport({
        databaseUrl: TEST_DB_URL,
        businessSlug: SLUG,
        entity: 'product',
        file: PRODUCTS,
        mode: 'validate',
        expectRows: 1,
        log,
      }),
    ).rejects.toBeInstanceOf(CatalogImportGateError);
    await expect(
      runCatalogImport({
        databaseUrl: TEST_DB_URL,
        businessSlug: 'nobody',
        entity: 'product',
        file: PRODUCTS,
        mode: 'validate',
        log,
      }),
    ).rejects.toThrow(/No business/);
  });

  it('validate mode: products.csv maps and validates whole, and commits nothing', async () => {
    logLines = [];
    const summary = await runCatalogImport({
      databaseUrl: TEST_DB_URL,
      businessSlug: SLUG,
      entity: 'product',
      file: PRODUCTS,
      mode: 'validate',
      expectRows: 1948,
      log,
    });
    expect(summary.rowCount).toBe(1948);
    expect(summary.valid).toBe(1948);
    expect(summary.invalid).toBe(0);
    expect(summary.committed).toBe(0);
    expect(logLines.some((l) => l.startsWith('Mapping: sku←SKU, name←DESCRIPTION'))).toBe(true);
    const [batch] = await db
      .select({ status: schema.importBatches.status })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, summary.batchId));
    expect(batch?.status).toBe('validated');
    const products = await db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(eq(schema.products.businessId, businessId));
    expect(products).toHaveLength(2);
  }, 300_000);

  it('commit + replace: 1948 products land, the stale SKU goes, the stocked listing is retired', async () => {
    logLines = [];
    const summary = await runCatalogImport({
      databaseUrl: TEST_DB_URL,
      businessSlug: SLUG,
      entity: 'product',
      file: PRODUCTS,
      mode: 'commit',
      replaceCatalog: true,
      expectRows: 1948,
      log,
    });
    expect(summary.committed).toBe(1948);
    expect(summary.failed).toBe(0);
    expect(logLines).toContain('Landed: 1948 active products for 1948 rows');
    expect(summary.replaced).toEqual({
      kept: 1948,
      deleted: 1,
      deactivated: 1,
      deletedSkus: ['OLD-GONE'],
      deactivatedSkus: ['shp-4411'],
    });
    expect(logLines).toContain('Deleted SKUs (1):');
    expect(logLines).toContain('  OLD-GONE');

    const rows = await db
      .select({
        sku: schema.productVariants.sku,
        name: schema.products.name,
        active: schema.products.isActive,
        price: schema.productVariants.priceCents,
        cost: schema.productVariants.costCents,
        attrs: schema.productVariants.attributesJson,
        brand: schema.brands.name,
        vendor: schema.vendors.name,
        category: schema.categories.name,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.productVariants.preferredVendorId))
      .where(eq(schema.productVariants.businessId, businessId));
    expect(rows).toHaveLength(1949);
    expect(rows.filter((r) => r.active)).toHaveLength(1948);
    const first = rows.find((r) => r.sku === '7703-6/6');
    expect(first).toMatchObject({
      name: 'E KING MICAH FIRM',
      active: true,
      price: 0,
      cost: 46800,
      attrs: { group: 'KING' },
      brand: 'EASTMAN',
      vendor: 'BIA',
      category: 'MATT',
    });
    const retired = rows.find((r) => r.sku === 'shp-4411');
    expect(retired?.active).toBe(false);
    expect(retired?.price).toBe(129900);

    const audit = await db
      .select({ actorType: schema.auditLogs.actorType, changes: schema.auditLogs.changesJson })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          eq(schema.auditLogs.action, 'import.commit'),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe('system');
    expect(audit[0]!.changes).toMatchObject({
      metadata: {
        entity: 'product',
        committed: 1948,
        replaced: { kept: 1948, deletedSkus: ['OLD-GONE'] },
      },
    });
  }, 600_000);

  it('inventory commit: 3246 levels land and the recon gates match the file', async () => {
    logLines = [];
    const summary = await runCatalogImport({
      databaseUrl: TEST_DB_URL,
      businessSlug: SLUG,
      entity: 'inventory',
      file: INVENTORY,
      mode: 'commit',
      expectRows: 3246,
      log,
    });
    expect(summary.committed).toBe(3246);
    expect(summary.failed).toBe(0);
    const recon = summary.recon as {
      gate1_rowCounts: { entity: string; source: number; db: number; match: boolean }[];
      gate2_inventory: {
        units: { source: number; db: number; match: boolean };
        valuationCents: { source: number; db: number; match: boolean };
      };
    };
    expect(recon.gate1_rowCounts.find((g) => g.entity === 'product')).toMatchObject({
      source: 1948,
      db: 1948,
      match: true,
    });
    expect(recon.gate1_rowCounts.find((g) => g.entity === 'inventory')).toMatchObject({
      source: 3246,
      db: 3246,
      match: true,
    });
    const fileUnits = dataRows(INVENTORY).reduce((sum, r) => sum + Number(r[2]), 0);
    expect(recon.gate2_inventory.units).toEqual({ source: fileUnits, db: fileUnits, match: true });
    expect(logLines).toContain(
      `Landed: 3246 levels holding ${fileUnits} units for 3246 rows carrying ${fileUnits} units`,
    );
    expect(logLines).toContain(
      `Recon (all imports to date) gate 2 units: source ${fileUnits} db ${fileUnits} OK`,
    );
    expect(recon.gate2_inventory.valuationCents.match).toBe(true);

    // Spot check: 7703-6/6 has 2 on hand at the Warehouse, one of them as-is.
    const [variant] = await db
      .select({ id: schema.productVariants.id })
      .from(schema.productVariants)
      .where(
        and(
          eq(schema.productVariants.businessId, businessId),
          eq(schema.productVariants.sku, '7703-6/6'),
        ),
      );
    const levels = await db
      .select({ location: schema.locations.name, onHand: schema.inventoryLevels.onHand })
      .from(schema.inventoryLevels)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
      .where(eq(schema.inventoryLevels.variantId, variant!.id));
    expect(levels.find((l) => l.location === 'Warehouse')?.onHand).toBe(2);
    const asIs = await db
      .select({ id: schema.asIsItems.id })
      .from(schema.asIsItems)
      .where(eq(schema.asIsItems.variantId, variant!.id));
    expect(asIs).toHaveLength(1);
  }, 600_000);
});
