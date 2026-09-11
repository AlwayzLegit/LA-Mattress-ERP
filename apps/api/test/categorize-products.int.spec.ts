/**
 * A22.1 — the categorize-products ops run on the real files: the STORIS
 * products export lands through the catalog import (which creates the
 * MATT / ADJUST / … code categories), then product-categories.csv renames
 * those codes in place, builds the subcategories and files every SKU.
 *
 * Database: CATEGORIZE_TEST_DATABASE_URL (jetnine_categorize).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@jetnine/db';
import { buildCategoryIndex } from '../src/catalog/category-tree';
import { resolveImportFile, runCatalogImport } from '../src/ops/catalog-import';
import {
  CategorizeGateError,
  LEGACY_CATEGORY_NAMES,
  parseMappingCsv,
  runCategorizeProducts,
} from '../src/ops/categorize-products';

const TEST_DB_URL =
  process.env.CATEGORIZE_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_categorize';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PRODUCTS = 'docs/imports/2026-09-03/products.csv';
const MAPPING = 'docs/imports/2026-09-11/product-categories.csv';
const SLUG = 'la-mattress-categorize';
const ROWS = 1948;

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
let businessId = '';
const log = () => {};

async function categories() {
  return db
    .select({
      id: schema.categories.id,
      parentId: schema.categories.parentId,
      name: schema.categories.name,
    })
    .from(schema.categories)
    .where(eq(schema.categories.businessId, businessId));
}

async function root(name: string) {
  const rows = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.businessId, businessId),
        isNull(schema.categories.parentId),
        eq(schema.categories.name, name),
      ),
    );
  return rows[0]?.id ?? null;
}

async function pathOf(sku: string): Promise<string | null> {
  const [p] = await db
    .select({ categoryId: schema.products.categoryId })
    .from(schema.products)
    .where(and(eq(schema.products.businessId, businessId), eq(schema.products.sku, sku)))
    .limit(1);
  return buildCategoryIndex(await categories()).pathOf(p?.categoryId ?? null);
}

async function importProducts() {
  return runCatalogImport({
    databaseUrl: TEST_DB_URL,
    businessSlug: SLUG,
    entity: 'product',
    file: PRODUCTS,
    mode: 'commit',
    expectRows: ROWS,
    replaceCatalog: false,
    log,
  });
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
    .values({ slug: SLUG, name: 'LA Mattress (categorize)', status: 'active' })
    .returning();
  businessId = biz!.id;
  const summary = await importProducts();
  expect(summary.committed).toBe(ROWS);
}, 300_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe('product-categories.csv (A22.1)', () => {
  it('names every SKU of the products export exactly once, with a category', () => {
    const mapping = parseMappingCsv(readFileSync(resolveImportFile(MAPPING), 'utf8'));
    const exportSkus = readFileSync(resolveImportFile(PRODUCTS), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(',')[0]!);
    expect(mapping).toHaveLength(ROWS);
    expect(new Set(mapping.map((r) => r.sku))).toEqual(new Set(exportSkus));
    expect(mapping.every((r) => r.category.length > 0)).toBe(true);
  });

  it('validate plans the whole run and writes nothing', async () => {
    const before = await categories();
    expect(before.map((c) => c.name)).toContain('MATT');
    const s = await runCategorizeProducts({
      databaseUrl: TEST_DB_URL,
      businessSlug: SLUG,
      file: MAPPING,
      mode: 'validate',
      expectRows: ROWS,
      log,
    });
    expect(s.matched).toBe(ROWS);
    expect(s.unmatchedSkus).toEqual([]);
    expect(s.unlistedSkus).toEqual([]);
    // NONINV and RF both map to Services & Fees: NONINV is renamed, RF
    // empties into it and goes.
    expect(s.renamed).toHaveLength(10);
    expect(s.deletedLegacy).toEqual(['RF']);
    expect(s.created.length).toBeGreaterThan(30);
    expect(s.assigned + s.unchanged).toBe(ROWS);
    // Rolled back: the code categories are still there, nothing new.
    const after = await categories();
    expect(after.map((c) => c.name).sort()).toEqual(before.map((c) => c.name).sort());
    const audits = await db
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          eq(schema.auditLogs.action, 'products.categorize'),
        ),
      );
    expect(audits).toHaveLength(0);
  }, 60_000);

  it('commit renames the code categories in place, builds the tree and files every SKU', async () => {
    const mattId = await root('MATT');
    expect(mattId).not.toBeNull();
    const s = await runCategorizeProducts({
      databaseUrl: TEST_DB_URL,
      businessSlug: SLUG,
      file: MAPPING,
      mode: 'commit',
      expectRows: ROWS,
      log,
    });
    expect(s.matched).toBe(ROWS);
    expect(s.assigned + s.unchanged).toBe(ROWS);
    // The MATT row became Mattresses — same id, so nothing that pointed at
    // it is orphaned.
    expect(await root('Mattresses')).toBe(mattId);
    for (const code of Object.keys(LEGACY_CATEGORY_NAMES)) expect(await root(code)).toBeNull();
    for (const name of new Set(Object.values(LEGACY_CATEGORY_NAMES))) {
      expect(await root(name)).not.toBeNull();
    }
    const all = await categories();
    const mattressKids = all
      .filter((c) => c.parentId === mattId)
      .map((c) => c.name)
      .sort();
    expect(mattressKids).toEqual(['Hybrid', 'Innerspring', 'Latex', 'Memory Foam']);

    expect(await pathOf('7703-6/6')).toBe('Mattresses › Innerspring'); // Eastman House Micah Firm
    expect(await pathOf('10746131')).toBe('Mattresses › Hybrid'); // TEMPUR-Adapt 2.0 Medium Hybrid
    expect(await pathOf('10745130')).toBe('Mattresses › Memory Foam'); // TEMPUR-Adapt 2.0 Medium
    expect(await pathOf('LOLUFM-1010')).toBe('Mattresses › Latex'); // Diamond Lucille Latex Firm
    expect(await pathOf('KEYA')).toBe('Mattresses'); // placeholder stays on the parent
    expect(await pathOf('25554132')).toBe('Adjustable Bases › Adjustable Bed Bases');
    expect(await pathOf('HDBB-1')).toBe('Adjustable Bases › Base Accessories & Parts');
    expect(await pathOf('8245-3/3')).toBe('Foundations & Box Springs › Bunkie Board (2")');
    expect(await pathOf('I227-451N')).toBe('Bedroom Furniture › Nightstands');
    expect(await pathOf('SMROYPALPT46')).toBe('Mattresses › Innerspring'); // mis-coded FURN row
    expect(await pathOf('RECYCLINGFEE')).toBe('Services & Fees › Fees'); // RF folded in
    expect(await pathOf('BLACKTONER')).toBe(
      'Store Supplies & Equipment › Office & Cleaning Supplies',
    );

    const uncategorized = await db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.businessId, businessId), isNull(schema.products.categoryId)));
    expect(uncategorized).toHaveLength(0);
    const audits = await db
      .select({ changes: schema.auditLogs.changesJson })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          eq(schema.auditLogs.action, 'products.categorize'),
        ),
      );
    expect(audits).toHaveLength(1);
    expect((audits[0]!.changes as { matched: number }).matched).toBe(ROWS);
  }, 60_000);

  it('a second commit is a no-op', async () => {
    const s = await runCategorizeProducts({
      databaseUrl: TEST_DB_URL,
      businessSlug: SLUG,
      file: MAPPING,
      mode: 'commit',
      expectRows: ROWS,
      log,
    });
    expect(s.assigned).toBe(0);
    expect(s.unchanged).toBe(ROWS);
    expect(s.created).toEqual([]);
    expect(s.renamed).toEqual([]);
    expect(s.deletedLegacy).toEqual([]);
  }, 60_000);

  it('re-importing products.csv keeps the finer categories and creates no code category', async () => {
    const summary = await importProducts();
    expect(summary.committed).toBe(ROWS);
    expect(await pathOf('7703-6/6')).toBe('Mattresses › Innerspring');
    expect(await pathOf('RECYCLINGFEE')).toBe('Services & Fees › Fees');
    expect(await root('MATT')).toBeNull();
    expect(await root('RF')).toBeNull();
    const all = await categories();
    expect(all.filter((c) => c.name.toUpperCase() in LEGACY_CATEGORY_NAMES)).toHaveLength(0);
  }, 300_000);

  it('gates: row count, unknown business, malformed file', async () => {
    await expect(
      runCategorizeProducts({
        databaseUrl: TEST_DB_URL,
        businessSlug: SLUG,
        file: MAPPING,
        mode: 'validate',
        expectRows: ROWS - 1,
        log,
      }),
    ).rejects.toBeInstanceOf(CategorizeGateError);
    await expect(
      runCategorizeProducts({
        databaseUrl: TEST_DB_URL,
        businessSlug: 'nobody-here',
        file: MAPPING,
        mode: 'validate',
        log,
      }),
    ).rejects.toBeInstanceOf(CategorizeGateError);
    const dir = mkdtempSync(join(tmpdir(), 'categorize-'));
    const dup = join(dir, 'dup.csv');
    writeFileSync(dup, 'SKU,CATEGORY,SUBCATEGORY\nA,Mattresses,Hybrid\nA,Mattresses,Latex\n');
    await expect(
      runCategorizeProducts({
        databaseUrl: TEST_DB_URL,
        businessSlug: SLUG,
        file: dup,
        mode: 'validate',
        log,
      }),
    ).rejects.toThrow(/Duplicate SKU/);
    const noCat = join(dir, 'nocat.csv');
    writeFileSync(noCat, 'SKU,NAME\nA,x\n');
    await expect(
      runCategorizeProducts({
        databaseUrl: TEST_DB_URL,
        businessSlug: SLUG,
        file: noCat,
        mode: 'validate',
        log,
      }),
    ).rejects.toThrow(/CATEGORY/);
  });

  it('a file naming SKUs the business does not carry reports and skips them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'categorize-'));
    const file = join(dir, 'partial.csv');
    writeFileSync(
      file,
      'SKU,CATEGORY,SUBCATEGORY\n7703-6/6,Mattresses,Innerspring\nNOT-A-SKU,Mattresses,Hybrid\n',
    );
    const s = await runCategorizeProducts({
      databaseUrl: TEST_DB_URL,
      businessSlug: SLUG,
      file,
      mode: 'validate',
      log,
    });
    expect(s.matched).toBe(1);
    expect(s.unmatchedSkus).toEqual(['NOT-A-SKU']);
    expect(s.unlistedSkus).toHaveLength(ROWS - 1);
    expect(s.unchanged).toBe(1);
  });
});
