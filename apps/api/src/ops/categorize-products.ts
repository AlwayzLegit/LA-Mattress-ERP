/**
 * Ops: apply the product category mapping to a business.
 *
 * Reads docs/imports/<date>/product-categories.csv (SKU, CATEGORY,
 * SUBCATEGORY, …) and, for the business named by --business:
 *
 *   1. renames the legacy STORIS code categories the catalog import created
 *      (MATT, ADJUST, FOUND, …) to their retail names in place, so every
 *      product, report and template that points at them keeps pointing at
 *      the same row;
 *   2. creates the missing top-level categories and subcategories;
 *   3. moves each product whose SKU is in the file onto its subcategory
 *      (or the top-level category when the file leaves SUBCATEGORY empty);
 *   4. deletes a legacy code category that ends up with no products and no
 *      children (RF folds into Services & Fees), and writes one audit row.
 *
 * Idempotent: a second run reports 0 changes. `--mode validate` runs the
 * whole plan inside a transaction and rolls it back, so the numbers it
 * prints are exactly what commit will do. SKUs the business does not carry
 * are reported and skipped; products the file does not name are left as
 * they are and counted.
 *
 * Run as a Render one-off job by .github/workflows/ops-categorize-products.yml:
 *   node apps/api/dist/ops/categorize-products.js --business la-mattress \
 *     --file docs/imports/2026-09-11/product-categories.csv \
 *     --mode validate --expect-rows 1948
 */
import { readFileSync } from 'node:fs';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from '@jetnine/db';
import { LEGACY_CATEGORY_NAMES } from '../import/legacy-categories';
import { resolveImportFile } from './catalog-import';

export { LEGACY_CATEGORY_NAMES } from '../import/legacy-categories';

export interface CategorizeOptions {
  databaseUrl: string;
  businessSlug: string;
  file: string;
  mode: 'validate' | 'commit';
  /** Exact data-row count the file must have; a mismatch fails before any read of the database. */
  expectRows?: number;
  log?: (line: string) => void;
}

export interface CategorizeSummary {
  mode: 'validate' | 'commit';
  rowCount: number;
  /** File rows whose SKU the business carries. */
  matched: number;
  /** File SKUs the business does not carry (skipped). */
  unmatchedSkus: string[];
  /** Business products the file does not name (left alone). */
  unlistedSkus: string[];
  renamed: { from: string; to: string }[];
  created: string[];
  assigned: number;
  unchanged: number;
  deletedLegacy: string[];
}

export class CategorizeGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategorizeGateError';
  }
}

interface MappingRow {
  sku: string;
  category: string;
  subcategory: string | null;
}

/** Minimal CSV reader: handles quoted fields with commas and doubled quotes. */
export function parseMappingCsv(text: string): MappingRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new CategorizeGateError('The file is empty');
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]!).map((h) => h.trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const iSku = col('SKU');
  const iCat = col('CATEGORY');
  const iSub = col('SUBCATEGORY');
  if (iSku < 0 || iCat < 0) {
    throw new CategorizeGateError('The file needs SKU and CATEGORY columns (SUBCATEGORY optional)');
  }
  const rows: MappingRow[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const sku = (cells[iSku] ?? '').trim();
    const category = (cells[iCat] ?? '').trim();
    const subcategory = iSub >= 0 ? (cells[iSub] ?? '').trim() : '';
    if (!sku) throw new CategorizeGateError(`Row ${rows.length + 2}: empty SKU`);
    if (!category) throw new CategorizeGateError(`Row ${rows.length + 2} (${sku}): empty CATEGORY`);
    if (seen.has(sku)) throw new CategorizeGateError(`Duplicate SKU in file: ${sku}`);
    seen.add(sku);
    rows.push({ sku, category, subcategory: subcategory || null });
  }
  return rows;
}

class Rollback extends Error {
  constructor(readonly summary: CategorizeSummary) {
    super('rollback');
  }
}

export async function runCategorizeProducts(opts: CategorizeOptions): Promise<CategorizeSummary> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const path = resolveImportFile(opts.file);
  const rows = parseMappingCsv(readFileSync(path, 'utf8'));
  if (opts.expectRows !== undefined && rows.length !== opts.expectRows) {
    throw new CategorizeGateError(
      `${opts.file} has ${rows.length} data rows, --expect-rows says ${opts.expectRows}`,
    );
  }
  log(`File: ${opts.file} (${rows.length} rows, mode ${opts.mode})`);

  const pg = postgres(opts.databaseUrl, { max: 1, prepare: false });
  const db = drizzle(pg);
  try {
    const [biz] = await db
      .select({ id: schema.businesses.id, name: schema.businesses.name })
      .from(schema.businesses)
      .where(eq(schema.businesses.slug, opts.businessSlug))
      .limit(1);
    if (!biz) throw new CategorizeGateError(`No business with slug "${opts.businessSlug}"`);
    log(`Business: ${biz.name} (${opts.businessSlug}, ${biz.id})`);

    try {
      return await db.transaction(async (tx) => {
        const summary = await apply(tx, biz.id, rows, opts.mode, log);
        if (opts.mode === 'validate') throw new Rollback(summary);
        return summary;
      });
    } catch (err) {
      if (err instanceof Rollback) {
        log('Validate mode: rolled back, nothing written.');
        return err.summary;
      }
      throw err;
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

async function apply(
  tx: Tx,
  businessId: string,
  rows: MappingRow[],
  mode: 'validate' | 'commit',
  log: (line: string) => void,
): Promise<CategorizeSummary> {
  const summary: CategorizeSummary = {
    mode,
    rowCount: rows.length,
    matched: 0,
    unmatchedSkus: [],
    unlistedSkus: [],
    renamed: [],
    created: [],
    assigned: 0,
    unchanged: 0,
    deletedLegacy: [],
  };

  // --- products by SKU -------------------------------------------------
  const products = await tx
    .select({
      id: schema.products.id,
      sku: schema.products.sku,
      categoryId: schema.products.categoryId,
    })
    .from(schema.products)
    .where(eq(schema.products.businessId, businessId));
  const bySku = new Map<string, { id: string; categoryId: string | null }>();
  for (const p of products) if (p.sku) bySku.set(p.sku, { id: p.id, categoryId: p.categoryId });
  const fileSkus = new Set(rows.map((r) => r.sku));
  summary.unmatchedSkus = rows.filter((r) => !bySku.has(r.sku)).map((r) => r.sku);
  summary.unlistedSkus = products.filter((p) => p.sku && !fileSkus.has(p.sku)).map((p) => p.sku!);
  summary.matched = rows.length - summary.unmatchedSkus.length;
  log(`Products: ${products.length} in the business, ${summary.matched} named by the file`);
  logSkus(log, 'File SKUs the business does not carry (skipped)', summary.unmatchedSkus);
  logSkus(log, 'Products the file does not name (left alone)', summary.unlistedSkus);

  // --- categories ------------------------------------------------------
  const all = await tx
    .select({
      id: schema.categories.id,
      parentId: schema.categories.parentId,
      name: schema.categories.name,
    })
    .from(schema.categories)
    .where(eq(schema.categories.businessId, businessId));
  const norm = (s: string) => s.trim().toLowerCase();
  const roots = new Map<string, { id: string; name: string }>();
  const children = new Map<string, Map<string, { id: string; name: string }>>();
  for (const c of all) {
    if (c.parentId === null) roots.set(norm(c.name), { id: c.id, name: c.name });
    else {
      if (!children.has(c.parentId)) children.set(c.parentId, new Map());
      children.get(c.parentId)!.set(norm(c.name), { id: c.id, name: c.name });
    }
  }

  // 1. Rename the legacy code categories whose retail name is not taken yet.
  const legacyRoots: string[] = [];
  for (const [code, target] of Object.entries(LEGACY_CATEGORY_NAMES)) {
    const legacy = roots.get(norm(code));
    if (!legacy) continue;
    legacyRoots.push(legacy.id);
    if (roots.has(norm(target))) continue; // both exist: products move, the code row empties and goes
    await tx
      .update(schema.categories)
      .set({ name: target })
      .where(eq(schema.categories.id, legacy.id));
    roots.delete(norm(code));
    roots.set(norm(target), { id: legacy.id, name: target });
    summary.renamed.push({ from: legacy.name, to: target });
    log(`Renamed category "${legacy.name}" -> "${target}"`);
  }

  // 2. Create what is missing, positioned in file order.
  const topOrder: string[] = [];
  for (const r of rows) if (!topOrder.includes(r.category)) topOrder.push(r.category);
  const ensureRoot = async (name: string): Promise<string> => {
    const hit = roots.get(norm(name));
    if (hit) return hit.id;
    const [row] = await tx
      .insert(schema.categories)
      .values({ businessId, name, parentId: null, position: topOrder.indexOf(name) })
      .returning({ id: schema.categories.id });
    roots.set(norm(name), { id: row!.id, name });
    summary.created.push(name);
    log(`Created category "${name}"`);
    return row!.id;
  };
  const subOrder = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.subcategory) continue;
    const list = subOrder.get(r.category) ?? [];
    if (!list.includes(r.subcategory)) list.push(r.subcategory);
    subOrder.set(r.category, list);
  }
  const ensureChild = async (
    parentId: string,
    parentName: string,
    name: string,
  ): Promise<string> => {
    const kids = children.get(parentId) ?? new Map<string, { id: string; name: string }>();
    children.set(parentId, kids);
    const hit = kids.get(norm(name));
    if (hit) return hit.id;
    const [row] = await tx
      .insert(schema.categories)
      .values({
        businessId,
        name,
        parentId,
        position: (subOrder.get(parentName) ?? []).indexOf(name),
      })
      .returning({ id: schema.categories.id });
    kids.set(norm(name), { id: row!.id, name });
    summary.created.push(`${parentName} / ${name}`);
    log(`Created category "${parentName} / ${name}"`);
    return row!.id;
  };
  const targetFor = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.category} ${r.subcategory ?? ''}`;
    if (targetFor.has(key)) continue;
    const rootId = await ensureRoot(r.category);
    targetFor.set(
      key,
      r.subcategory ? await ensureChild(rootId, r.category, r.subcategory) : rootId,
    );
  }

  // 3. Move the products.
  const moves = new Map<string, string[]>(); // categoryId -> product ids
  for (const r of rows) {
    const p = bySku.get(r.sku);
    if (!p) continue;
    const target = targetFor.get(`${r.category} ${r.subcategory ?? ''}`)!;
    if (p.categoryId === target) {
      summary.unchanged += 1;
      continue;
    }
    const list = moves.get(target) ?? [];
    list.push(p.id);
    moves.set(target, list);
    summary.assigned += 1;
  }
  for (const [categoryId, ids] of moves) {
    for (let i = 0; i < ids.length; i += 500) {
      await tx
        .update(schema.products)
        .set({ categoryId, updatedAt: new Date() })
        .where(inArray(schema.products.id, ids.slice(i, i + 500)));
    }
  }
  log(`Assigned ${summary.assigned} products, ${summary.unchanged} already in place`);

  // 4. Drop legacy code categories that are now empty leaves.
  for (const id of legacyRoots) {
    const [row] = await tx
      .select({ name: schema.categories.name })
      .from(schema.categories)
      .where(eq(schema.categories.id, id))
      .limit(1);
    if (!row || !(row.name.toUpperCase() in LEGACY_CATEGORY_NAMES)) continue;
    const [productCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.products)
      .where(eq(schema.products.categoryId, id));
    const [childCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.categories)
      .where(eq(schema.categories.parentId, id));
    if ((productCount?.n ?? 0) === 0 && (childCount?.n ?? 0) === 0) {
      await tx
        .delete(schema.categories)
        .where(and(eq(schema.categories.id, id), isNull(schema.categories.parentId)));
      summary.deletedLegacy.push(row.name);
      log(`Deleted empty legacy category "${row.name}"`);
    }
  }

  await tx.insert(schema.auditLogs).values({
    businessId,
    actorType: 'system',
    action: 'products.categorize',
    targetType: 'business',
    targetId: businessId,
    changesJson: {
      mode,
      rowCount: summary.rowCount,
      matched: summary.matched,
      unmatched: summary.unmatchedSkus.length,
      unlisted: summary.unlistedSkus.length,
      renamed: summary.renamed,
      created: summary.created,
      assigned: summary.assigned,
      unchanged: summary.unchanged,
      deletedLegacy: summary.deletedLegacy,
    },
  });
  return summary;
}

function logSkus(log: (line: string) => void, label: string, skus: string[]) {
  if (skus.length === 0) {
    log(`${label}: none`);
    return;
  }
  log(`${label} (${skus.length}):`);
  for (let i = 0; i < skus.length; i += 40) log(`  ${skus.slice(i, i + 40).join(', ')}`);
}

// --- CLI ---

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): never {
  console.error(
    'Usage: categorize-products --business <slug> --file <csv> --mode validate|commit [--expect-rows N]',
  );
  process.exit(2);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const businessSlug = arg('--business');
  const file = arg('--file');
  const mode = arg('--mode');
  const expectRaw = arg('--expect-rows');
  if (!businessSlug || !file) usage();
  if (mode !== 'validate' && mode !== 'commit') usage();
  let expectRows: number | undefined;
  if (expectRaw !== undefined) {
    if (!/^\d+$/.test(expectRaw)) usage();
    expectRows = Number(expectRaw);
  }
  try {
    const s = await runCategorizeProducts({
      databaseUrl,
      businessSlug: businessSlug!,
      file: file!,
      mode,
      expectRows,
    });
    process.stdout.write(
      `Summary: ${s.matched}/${s.rowCount} matched, ${s.assigned} assigned, ${s.unchanged} unchanged, ` +
        `${s.renamed.length} renamed, ${s.created.length} created, ${s.deletedLegacy.length} legacy removed, ` +
        `${s.unmatchedSkus.length} file SKUs not carried, ${s.unlistedSkus.length} products not in file\n`,
    );
  } catch (err) {
    if (err instanceof CategorizeGateError) {
      console.error(`GATE FAILED: ${err.message}`);
      process.exit(4);
    }
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
