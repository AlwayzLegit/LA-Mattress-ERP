/**
 * Ops CLI: load one STORIS catalog file (products or inventory on hand)
 * through the import pipeline against whatever DATABASE_URL points at,
 * with the production gates of docs/HANDOFF-catalog-source-lockdown.md §3
 * (C4 / C5) enforced by the script rather than by a human reading JSON.
 *
 * On production this runs as a Render one-off job inside the API service
 * (same build, same env), dispatched by .github/workflows/ops-catalog-import.yml:
 *
 *   node apps/api/dist/ops/catalog-import.js --business la-mattress \
 *     --entity product --file docs/imports/2026-09-03/products.csv \
 *     --mode validate --expect-rows 1948
 *   node apps/api/dist/ops/catalog-import.js --business la-mattress \
 *     --entity product --file docs/imports/2026-09-03/products.csv \
 *     --mode commit --expect-rows 1948 --replace-catalog
 *   node apps/api/dist/ops/catalog-import.js --business la-mattress \
 *     --entity inventory --file docs/imports/2026-09-03/inventory.csv \
 *     --mode commit --expect-rows 3246
 *
 * Gates (any failure exits non-zero and leaves the staged batch in place
 * for inspection via GET /v1/import/batches/:id?rows=invalid):
 *   - the business exists; no connector sync is running
 *   - every required column auto-mapped
 *   - validate: 0 invalid rows, valid = rowCount = --expect-rows
 *   - commit: 0 failed rows, committed = rowCount
 *   - --replace-catalog: the replace ran and kept exactly rowCount products
 *   - post-commit, scoped to this batch: every committed product row is an
 *     active product; every inventory row is a level, and the levels hold
 *     exactly the units the file carries (the cumulative §7 recon gates are
 *     printed for the record, not gated — see the inventory branch)
 * `--mode validate` stops after validation. A commit writes the same
 * `import.commit` audit row the wizard writes, with actor_type 'system'.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from '@jetnine/db';
import { ImportService } from '../import/import.service';

export type CatalogImportEntity = 'product' | 'inventory';
export type CatalogImportMode = 'validate' | 'commit';

export interface CatalogImportOptions {
  databaseUrl: string;
  businessSlug: string;
  entity: CatalogImportEntity;
  /** Absolute, or relative to the repo root / current directory. */
  file: string;
  mode: CatalogImportMode;
  replaceCatalog?: boolean;
  expectRows?: number;
  log?: (line: string) => void;
}

export interface CatalogImportSummary {
  businessId: string;
  batchId: string;
  rowCount: number;
  valid: number;
  invalid: number;
  committed: number;
  failed: number;
  replaced: {
    kept: number;
    deleted: number;
    deactivated: number;
    deletedSkus: string[];
    deactivatedSkus: string[];
  } | null;
  recon: Record<string, unknown> | null;
}

/** A gate failed: the message says which. */
export class CatalogImportGateError extends Error {
  constructor(
    message: string,
    readonly batchId: string | null,
  ) {
    super(message);
    this.name = 'CatalogImportGateError';
  }
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

export function resolveImportFile(file: string): string {
  const candidates = [resolve(file), resolve(REPO_ROOT, file)];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`File not found: ${file} (tried ${candidates.join(', ')})`);
  return found;
}

export async function runCatalogImport(opts: CatalogImportOptions): Promise<CatalogImportSummary> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const path = resolveImportFile(opts.file);
  const csv = readFileSync(path, 'utf8');

  const pg = postgres(opts.databaseUrl, { max: 1, prepare: false });
  const db = drizzle(pg);
  const service = new ImportService(db);
  let batchId: string | null = null;
  try {
    const [biz] = await db
      .select({ id: schema.businesses.id, name: schema.businesses.name })
      .from(schema.businesses)
      .where(eq(schema.businesses.slug, opts.businessSlug))
      .limit(1);
    if (!biz)
      throw new CatalogImportGateError(`No business with slug "${opts.businessSlug}"`, null);
    log(`Business: ${biz.name} (${opts.businessSlug}, ${biz.id})`);

    const connectors = await db
      .select({
        provider: schema.integrations.provider,
        status: schema.integrations.status,
        syncStatus: schema.integrations.syncStatus,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.businessId, biz.id));
    for (const c of connectors) {
      log(`Connector: ${c.provider} status=${c.status} sync=${c.syncStatus}`);
    }
    const running = connectors.filter((c) => c.syncStatus === 'running');
    if (running.length > 0) {
      throw new CatalogImportGateError(
        `A connector sync is running (${running.map((c) => c.provider).join(', ')}); wait for it`,
        null,
      );
    }
    if (opts.entity === 'inventory') {
      const locs = await db
        .select({ name: schema.locations.name })
        .from(schema.locations)
        .where(eq(schema.locations.businessId, biz.id));
      log(`Locations: ${locs.map((l) => l.name).join(' | ')}`);
    }

    // --- stage ---
    const staged = await service.stage(biz.id, undefined, {
      entity: opts.entity,
      filename: path.split('/').pop() ?? opts.file,
      csv,
    });
    if (!staged.id || typeof staged.rowCount !== 'number') {
      throw new Error('Staging returned no batch');
    }
    batchId = staged.id;
    const rowCount = staged.rowCount;
    const mapping = (staged.mappingJson as { columns?: Record<string, string> }).columns ?? {};
    log(`Batch ${batchId}: ${rowCount} rows staged from ${path} (${elapsed()})`);
    log(
      `Mapping: ${Object.entries(mapping)
        .map(([field, header]) => `${field}←${header}`)
        .join(', ')}`,
    );
    if (staged.unmappedRequired.length > 0) {
      throw new CatalogImportGateError(
        `Required columns not found in the file: ${staged.unmappedRequired.join(', ')}`,
        batchId,
      );
    }
    if (opts.expectRows !== undefined && rowCount !== opts.expectRows) {
      throw new CatalogImportGateError(
        `Expected ${opts.expectRows} rows, the file has ${rowCount}`,
        batchId,
      );
    }

    // --- validate ---
    const validated = await service.validate(biz.id, batchId);
    if (!validated) throw new Error('Validation returned no batch');
    const report = validated.validationJson as {
      valid: number;
      invalid: number;
      byMessage: Record<string, number>;
      errors: {
        row: number;
        legacyId: string | null;
        errors: { field: string; message: string }[];
      }[];
    };
    log(`Validated: ${report.valid} valid, ${report.invalid} invalid (${elapsed()})`);
    for (const [message, count] of Object.entries(report.byMessage)) {
      log(`  ${count} × ${message}`);
    }
    for (const e of report.errors.slice(0, 20)) {
      log(
        `  row ${e.row} (${e.legacyId ?? '?'}): ${e.errors.map((x) => `${x.field}: ${x.message}`).join('; ')}`,
      );
    }
    if (report.invalid !== 0 || report.valid !== rowCount) {
      throw new CatalogImportGateError(
        `Validation gate failed: ${report.invalid} invalid, ${report.valid} of ${rowCount} valid`,
        batchId,
      );
    }

    const summary: CatalogImportSummary = {
      businessId: biz.id,
      batchId,
      rowCount,
      valid: report.valid,
      invalid: report.invalid,
      committed: 0,
      failed: 0,
      replaced: null,
      recon: null,
    };
    if (opts.mode === 'validate') {
      log(`Validate-only run: batch ${batchId} is validated and NOT committed.`);
      return summary;
    }

    // --- commit ---
    const result = await service.commit(biz.id, batchId, {
      replaceCatalog: opts.replaceCatalog === true && opts.entity === 'product',
    });
    summary.committed = result.committed;
    summary.failed = result.failed;
    summary.replaced = result.replaced;
    log(`Committed: ${result.committed} rows, ${result.failed} failed (${elapsed()})`);
    if (result.replaceSkipped) log(`Replace skipped: ${result.replaceSkipped}`);
    if (result.replaced) {
      log(
        `Replaced catalog: kept ${result.replaced.kept}, deleted ${result.replaced.deleted}, deactivated ${result.replaced.deactivated}`,
      );
      logSkus(log, 'Deleted SKUs', result.replaced.deletedSkus);
      logSkus(log, 'Deactivated SKUs', result.replaced.deactivatedSkus);
    }

    await db.insert(schema.auditLogs).values({
      businessId: biz.id,
      actorType: 'system',
      action: 'import.commit',
      targetType: 'import_batch',
      targetId: batchId,
      changesJson: {
        metadata: {
          entity: opts.entity,
          committed: result.committed,
          failed: result.failed,
          ...(result.replaced ? { replaced: result.replaced } : {}),
          ...(result.replaceSkipped ? { replaceSkipped: result.replaceSkipped } : {}),
          via: 'catalog-import.ts',
          file: opts.file,
        },
      },
    });

    if (result.failed !== 0 || result.committed !== rowCount) {
      throw new CatalogImportGateError(
        `Commit gate failed: ${result.failed} failed, ${result.committed} of ${rowCount} committed`,
        batchId,
      );
    }
    if (opts.replaceCatalog && opts.entity === 'product') {
      if (!result.replaced) {
        throw new CatalogImportGateError(
          `Replace gate failed: ${result.replaceSkipped ?? 'replace did not run'}`,
          batchId,
        );
      }
      if (result.replaced.kept !== rowCount) {
        throw new CatalogImportGateError(
          `Replace gate failed: kept ${result.replaced.kept}, expected ${rowCount}`,
          batchId,
        );
      }
    }

    // --- post-commit check, scoped to this batch ---
    // Deterministic: what this file's rows point at must be there, whole.
    const landedRows = await db
      .select({
        jetnineId: schema.importRows.jetnineId,
        normalized: schema.importRows.normalizedJson,
      })
      .from(schema.importRows)
      .where(
        and(eq(schema.importRows.batchId, batchId), eq(schema.importRows.status, 'committed')),
      );
    const landedIds = landedRows
      .map((r) => r.jetnineId)
      .filter((id): id is string => typeof id === 'string');
    if (opts.entity === 'product') {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.products)
        .where(and(inArray(schema.products.id, landedIds), eq(schema.products.isActive, true)));
      const count = row?.count ?? 0;
      log(`Landed: ${count} active products for ${rowCount} rows`);
      if (count !== rowCount) {
        throw new CatalogImportGateError(
          `Post-commit gate failed: ${count} active products for ${rowCount} committed rows (data is committed — investigate before running anything else)`,
          batchId,
        );
      }
    } else {
      const fileUnits = landedRows.reduce((sum, r) => {
        const onHand = (r.normalized as { onHand?: unknown } | null)?.onHand;
        return sum + (typeof onHand === 'number' ? onHand : 0);
      }, 0);
      const [row] = await db
        .select({
          count: sql<number>`count(*)::int`,
          units: sql<number>`coalesce(sum(${schema.inventoryLevels.onHand}), 0)::int`,
        })
        .from(schema.inventoryLevels)
        .where(inArray(schema.inventoryLevels.id, landedIds));
      const count = row?.count ?? 0;
      const units = Number(row?.units ?? 0);
      log(
        `Landed: ${count} levels holding ${units} units for ${rowCount} rows carrying ${fileUnits} units`,
      );
      if (count !== rowCount || units !== fileUnits) {
        throw new CatalogImportGateError(
          `Post-commit gate failed: ${count} levels / ${units} units for ${rowCount} rows / ${fileUnits} units (data is committed — investigate before running anything else)`,
          batchId,
        );
      }
      // The §7 recon gates span every import committed to date for this
      // business, so stale rows from earlier files can legitimately differ
      // from today's ledger; reported, not gated.
      const recon = await service.recon(biz.id);
      summary.recon = recon as unknown as Record<string, unknown>;
      const gate1 = recon.gate1_rowCounts.filter(
        (g) => g.entity === 'product' || g.entity === 'inventory',
      );
      for (const g of gate1) {
        log(
          `Recon (all imports to date) gate 1 ${g.entity}: source ${g.source} db ${g.db} ${g.match ? 'OK' : 'MISMATCH'}`,
        );
      }
      const u = recon.gate2_inventory.units;
      const v = recon.gate2_inventory.valuationCents;
      log(
        `Recon (all imports to date) gate 2 units: source ${u.source} db ${u.db} ${u.match ? 'OK' : 'MISMATCH'}`,
      );
      log(
        `Recon (all imports to date) gate 2 valuation (cents): source ${v.source} db ${v.db} ${v.match ? 'OK' : 'MISMATCH'}`,
      );
    }
    log(`Done in ${elapsed()}.`);
    return summary;
  } finally {
    await pg.end({ timeout: 5 });
  }
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
    'Usage: catalog-import --business <slug> --entity product|inventory --file <csv> ' +
      '--mode validate|commit [--expect-rows N] [--replace-catalog]',
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
  const entity = arg('--entity');
  const file = arg('--file');
  const mode = arg('--mode');
  const expectRaw = arg('--expect-rows');
  const replaceCatalog = process.argv.includes('--replace-catalog');
  if (!businessSlug || !file) usage();
  if (entity !== 'product' && entity !== 'inventory') usage();
  if (mode !== 'validate' && mode !== 'commit') usage();
  if (replaceCatalog && entity !== 'product') usage();
  let expectRows: number | undefined;
  if (expectRaw !== undefined) {
    if (!/^\d+$/.test(expectRaw)) usage();
    expectRows = Number(expectRaw);
  }
  try {
    await runCatalogImport({
      databaseUrl,
      businessSlug: businessSlug!,
      entity,
      file: file!,
      mode,
      replaceCatalog,
      expectRows,
    });
  } catch (err) {
    if (err instanceof CatalogImportGateError) {
      console.error(`GATE FAILED: ${err.message}`);
      if (err.batchId) {
        console.error(
          `Batch ${err.batchId} left in place — GET /v1/import/batches/${err.batchId}?rows=invalid`,
        );
      }
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
