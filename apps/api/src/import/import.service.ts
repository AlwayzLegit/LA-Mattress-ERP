import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { LEGACY_CATEGORY_NAMES } from './legacy-categories';
import { DRIZZLE } from '../database/database.module';
import {
  defaultMapping,
  entitySpec,
  legacyIdFor,
  normalizeRow,
  parseCsv,
  type RowError,
} from './import-spec';

/** What `commit({ replaceCatalog: true })` retired; the SKU lists land in the audit row. */
export interface ReplaceCatalogResult {
  kept: number;
  deleted: number;
  deactivated: number;
  deletedSkus: string[];
  deactivatedSkus: string[];
}

interface StageInput {
  entity: string;
  filename?: string;
  csv: string;
}

interface RowErrorReport {
  row: number;
  legacyId: string | null;
  errors: RowError[];
}

/** Preloaded lookup tables shared by validate and commit. */
interface Lookups {
  customerRefs: Map<string, string>;
  orderRefs: Map<string, string>;
  saleRefs: Map<string, string>;
  locations: Map<string, string>;
  /** Every location, for tolerant matching (name, order prefix, contains). */
  locationList: { id: string; name: string; prefix: string | null }[];
  variants: Map<string, { variantId: string; productId: string; costCents: number | null }>;
}

/**
 * STORIS store names rarely match the ERP's letter for letter ("201
 * WESTERN" vs "201 Western", "WEST LA MATTRESS STOR" vs "West LA"). Exact
 * name first, then the order prefix, then a unique contains-match on the
 * letters and digits alone.
 */
export function resolveLocation(lookups: Lookups, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const exact = lookups.locations.get(raw.trim().toLowerCase());
  if (exact) return exact;
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = norm(raw);
  if (!key) return null;
  const hits = lookups.locationList.filter((l) => {
    const n = norm(l.name);
    const pfx = l.prefix ? norm(l.prefix) : '';
    return n === key || (pfx !== '' && pfx === key) || n.includes(key) || key.includes(n);
  });
  return hits.length === 1 ? hits[0]!.id : null;
}

const MAX_ROWS = 100_000;

/** STORIS tender words → our payment methods; anything else is 'legacy'. */
function mapTender(raw: string | undefined): string {
  const w = (raw ?? '').trim().toUpperCase();
  if (w === 'CASH') return 'cash';
  if (['CARD', 'CREDIT', 'CREDIT_CARD', 'VISA', 'MC', 'MASTERCARD', 'AMEX', 'DISCOVER'].includes(w))
    return 'card';
  if (['CHECK', 'CHEQUE'].includes(w)) return 'check';
  if (['FINANCING', 'FINANCE', 'FINANCED'].includes(w)) return 'financing';
  return 'legacy';
}

/**
 * The STORIS import pipeline (§7): stage a CSV → map columns → validate
 * → commit as idempotent upserts through `legacy_refs` (D7) → reconcile.
 * Everything committed here carries `imported_at` where the schema has
 * it, so drawer, commissions, webhooks, and emails ignore it (D8).
 */
@Injectable()
export class ImportService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  // --- Staging ---

  async stage(businessId: string, userId: string | undefined, input: StageInput) {
    const spec = entitySpec(input.entity);
    if (!spec) throw new BadRequestException(`Unknown entity "${input.entity}"`);
    const { headers, rows } = parseCsv(input.csv);
    if (headers.length === 0 || rows.length === 0) {
      throw new BadRequestException('The file has no data rows');
    }
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(`Too many rows (${rows.length}); split the file`);
    }
    const mapping = defaultMapping(input.entity, headers);
    const [batch] = await this.db
      .insert(schema.importBatches)
      .values({
        businessId,
        entity: input.entity,
        filename: input.filename ?? null,
        status: 'mapped',
        mappingJson: { columns: mapping, headers },
        rowCount: rows.length,
        uploadedByUserId: userId ?? null,
      })
      .returning();
    for (let i = 0; i < rows.length; i += 500) {
      await this.db.insert(schema.importRows).values(
        rows.slice(i, i + 500).map((raw, j) => ({
          businessId,
          batchId: batch!.id,
          rowNumber: i + j + 1,
          rawJson: raw,
        })),
      );
    }
    const unmappedRequired = spec.fields
      .filter((f) => f.required && mapping[f.name] === undefined)
      .map((f) => f.name);
    return { ...batch, unmappedRequired };
  }

  /**
   * Stage rows a platform connector already fetched and normalized —
   * same batch/row layout as a CSV upload, but the "headers" are the
   * entity's own field names, so the identity mapping applies and
   * validate/commit run unchanged. `source` (e.g. 'shopify') is stamped
   * on the batch and flows into `legacy_refs.source`, keeping each
   * platform's identity space separate from the STORIS one.
   */
  async stageStructured(
    businessId: string,
    userId: string | undefined,
    input: { entity: string; source: string; filename?: string; rows: Record<string, string>[] },
  ) {
    const spec = entitySpec(input.entity);
    if (!spec) throw new BadRequestException(`Unknown entity "${input.entity}"`);
    if (input.rows.length === 0) throw new BadRequestException('No rows to stage');
    if (input.rows.length > MAX_ROWS) {
      throw new BadRequestException(`Too many rows (${input.rows.length})`);
    }
    const headers = [...new Set(input.rows.flatMap((r) => Object.keys(r)))];
    const mapping = defaultMapping(input.entity, headers);
    const [batch] = await this.db
      .insert(schema.importBatches)
      .values({
        businessId,
        entity: input.entity,
        source: input.source,
        filename: input.filename ?? null,
        status: 'mapped',
        mappingJson: { columns: mapping, headers },
        rowCount: input.rows.length,
        uploadedByUserId: userId ?? null,
      })
      .returning();
    for (let i = 0; i < input.rows.length; i += 500) {
      await this.db.insert(schema.importRows).values(
        input.rows.slice(i, i + 500).map((raw, j) => ({
          businessId,
          batchId: batch!.id,
          rowNumber: i + j + 1,
          rawJson: raw,
        })),
      );
    }
    return batch!;
  }

  async setMapping(batchId: string, columns: Record<string, string>) {
    const batch = await this.getBatch(batchId);
    if (batch.status === 'committed') {
      throw new BadRequestException('Batch is already committed');
    }
    const prior = (batch.mappingJson ?? {}) as { headers?: string[] };
    const [updated] = await this.db
      .update(schema.importBatches)
      .set({
        mappingJson: { columns, headers: prior.headers ?? [] },
        status: 'mapped',
        updatedAt: new Date(),
      })
      .where(eq(schema.importBatches.id, batchId))
      .returning();
    return updated;
  }

  // --- Validation ---

  async validate(businessId: string, batchId: string) {
    const batch = await this.getBatch(batchId);
    const spec = entitySpec(batch.entity);
    if (!spec) throw new BadRequestException(`Unknown entity "${batch.entity}"`);
    const mapping =
      ((batch.mappingJson ?? {}) as { columns?: Record<string, string> }).columns ?? {};
    const rows = await this.db
      .select()
      .from(schema.importRows)
      .where(eq(schema.importRows.batchId, batchId))
      .orderBy(schema.importRows.rowNumber);
    const lookups = await this.loadLookups(businessId, batch.entity);

    const seen = new Map<string, number>();
    let valid = 0;
    let invalid = 0;
    const reports: RowErrorReport[] = [];
    const byMessage = new Map<string, number>();

    for (const row of rows) {
      const { normalized, errors } = normalizeRow(
        batch.entity,
        row.rawJson as Record<string, string>,
        mapping,
      );
      const legacyId = legacyIdFor(batch.entity, normalized);
      if (legacyId === null && errors.length === 0) {
        errors.push({ field: spec.legacyIdField, message: 'could not derive a legacy id' });
      }
      if (legacyId !== null) {
        const first = seen.get(legacyId);
        if (first !== undefined) {
          errors.push({
            field: spec.legacyIdField,
            message: `duplicate legacy id "${legacyId}" (first at row ${first})`,
          });
        } else {
          seen.set(legacyId, row.rowNumber);
        }
      }
      errors.push(...this.checkReferences(batch.entity, normalized, lookups));

      const ok = errors.length === 0;
      if (ok) valid++;
      else {
        invalid++;
        if (reports.length < 200) reports.push({ row: row.rowNumber, legacyId, errors });
        for (const e of errors) {
          byMessage.set(e.message, (byMessage.get(e.message) ?? 0) + 1);
        }
      }
      await this.db
        .update(schema.importRows)
        .set({
          legacyId,
          normalizedJson: normalized,
          status: ok ? 'valid' : 'invalid',
          errorsJson: ok ? null : errors,
        })
        .where(eq(schema.importRows.id, row.id));
    }

    const validationJson = {
      checkedAt: new Date().toISOString(),
      rowCount: rows.length,
      valid,
      invalid,
      errors: reports,
      byMessage: Object.fromEntries(
        [...byMessage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50),
      ),
    };
    const [updated] = await this.db
      .update(schema.importBatches)
      .set({
        status: 'validated',
        validationJson,
        validRowCount: valid,
        invalidRowCount: invalid,
        validatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.importBatches.id, batchId))
      .returning();
    return updated;
  }

  private checkReferences(
    entity: string,
    n: Record<string, unknown>,
    lookups: Lookups,
  ): RowError[] {
    const errors: RowError[] = [];
    const locKey = typeof n.location === 'string' ? n.location.toLowerCase() : null;
    if (
      ['inventory', 'order', 'sale'].includes(entity) &&
      locKey &&
      !resolveLocation(lookups, n.location)
    ) {
      errors.push({ field: 'location', message: `unknown location "${String(n.location)}"` });
    }
    if (['inventory', 'order_line'].includes(entity) && typeof n.sku === 'string') {
      if (!lookups.variants.has(n.sku.toLowerCase())) {
        errors.push({ field: 'sku', message: `unknown SKU "${n.sku}" — import products first` });
      }
    }
    if (entity === 'order' && typeof n.customerAccountNo === 'string') {
      if (!lookups.customerRefs.has(n.customerAccountNo)) {
        errors.push({
          field: 'customerAccountNo',
          message: `unknown customer "${n.customerAccountNo}" — import customers first`,
        });
      }
    }
    if (entity === 'sale' && typeof n.customerAccountNo === 'string') {
      if (!lookups.customerRefs.has(n.customerAccountNo)) {
        errors.push({
          field: 'customerAccountNo',
          message: `unknown customer "${n.customerAccountNo}" — import customers first`,
        });
      }
    }
    if (entity === 'order_line' && typeof n.orderNo === 'string') {
      if (!lookups.orderRefs.has(n.orderNo)) {
        errors.push({
          field: 'orderNo',
          message: `unknown order "${n.orderNo}" — commit order headers first`,
        });
      }
    }
    if (entity === 'sale_line') {
      if (typeof n.invoiceNo === 'string' && !lookups.saleRefs.has(n.invoiceNo)) {
        errors.push({
          field: 'invoiceNo',
          message: `unknown invoice "${n.invoiceNo}" — commit sale headers first`,
        });
      }
      // Unknown SKUs stay importable — the description is the record —
      // but a line with neither is unprintable.
      if (!n.sku && !n.description) {
        errors.push({ field: 'sku', message: 'a line needs a SKU or a description' });
      }
    }
    return errors;
  }

  private async loadLookups(businessId: string, entity: string): Promise<Lookups> {
    const lookups: Lookups = {
      customerRefs: new Map(),
      orderRefs: new Map(),
      saleRefs: new Map(),
      locations: new Map(),
      locationList: [],
      variants: new Map(),
    };
    const wantCustomers = ['order', 'sale'].includes(entity);
    const wantOrders = entity === 'order_line';
    const wantSales = entity === 'sale_line';
    const wantLocations = ['inventory', 'order', 'sale'].includes(entity);
    const wantVariants = ['inventory', 'order_line', 'sale_line'].includes(entity);

    if (wantSales) {
      const refs = await this.db
        .select({
          legacyId: schema.legacyRefs.legacyId,
          jetnineId: schema.legacyRefs.jetnineId,
        })
        .from(schema.legacyRefs)
        .where(
          and(eq(schema.legacyRefs.businessId, businessId), eq(schema.legacyRefs.entity, 'sale')),
        );
      for (const r of refs) lookups.saleRefs.set(r.legacyId, r.jetnineId);
    }
    if (wantCustomers || wantOrders) {
      const refs = await this.db
        .select({
          entity: schema.legacyRefs.entity,
          legacyId: schema.legacyRefs.legacyId,
          jetnineId: schema.legacyRefs.jetnineId,
        })
        .from(schema.legacyRefs)
        .where(
          and(
            eq(schema.legacyRefs.businessId, businessId),
            inArray(schema.legacyRefs.entity, ['customer', 'order']),
          ),
        );
      for (const r of refs) {
        if (r.entity === 'customer') lookups.customerRefs.set(r.legacyId, r.jetnineId);
        else lookups.orderRefs.set(r.legacyId, r.jetnineId);
      }
    }
    if (wantLocations) {
      const locs = await this.db
        .select({
          id: schema.locations.id,
          name: schema.locations.name,
          prefix: schema.locations.orderPrefix,
        })
        .from(schema.locations)
        .where(eq(schema.locations.businessId, businessId));
      for (const l of locs) lookups.locations.set(l.name.toLowerCase(), l.id);
      lookups.locationList = locs.map((l) => ({ id: l.id, name: l.name, prefix: l.prefix }));
    }
    if (wantVariants) {
      const variants = await this.db
        .select({
          variantId: schema.productVariants.id,
          productId: schema.productVariants.productId,
          sku: schema.productVariants.sku,
          costCents: schema.productVariants.costCents,
        })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.businessId, businessId));
      for (const v of variants) {
        if (v.sku) {
          lookups.variants.set(v.sku.toLowerCase(), {
            variantId: v.variantId,
            productId: v.productId,
            costCents: v.costCents,
          });
        }
      }
    }
    return lookups;
  }

  // --- Commit ---

  async commit(businessId: string, batchId: string, options: { replaceCatalog?: boolean } = {}) {
    const batch = await this.getBatch(batchId);
    if (!['validated', 'committed'].includes(batch.status)) {
      throw new BadRequestException('Validate the batch before committing');
    }
    const replacing = options.replaceCatalog === true && batch.entity === 'product';
    if (replacing) {
      // A count in progress froze on-hand snapshots of variants this run
      // may retire; posting it afterwards would write to rows that no
      // longer exist. Refuse before a single row commits.
      const [openCount] = await this.db
        .select({ id: schema.physicalCounts.id, status: schema.physicalCounts.status })
        .from(schema.physicalCounts)
        .where(
          and(
            eq(schema.physicalCounts.businessId, businessId),
            inArray(schema.physicalCounts.status, ['open', 'counting']),
          ),
        )
        .limit(1);
      if (openCount) {
        throw new BadRequestException(
          `A physical count is ${openCount.status}; post or cancel it before replacing the catalog`,
        );
      }
    }
    const rows = await this.db
      .select()
      .from(schema.importRows)
      .where(
        and(
          eq(schema.importRows.batchId, batchId),
          inArray(schema.importRows.status, ['valid', 'committed']),
        ),
      )
      .orderBy(schema.importRows.rowNumber);
    const lookups = await this.loadLookups(businessId, batch.entity);
    const categoryCache = new Map<string, string>();
    const brandCache = new Map<string, string>();

    let committed = 0;
    let failed = 0;
    for (const row of rows) {
      const n = (row.normalizedJson ?? {}) as Record<string, unknown>;
      try {
        const jetnineId = await this.commitRow(businessId, batch, row.legacyId!, n, {
          lookups,
          categoryCache,
          brandCache,
        });
        await this.db
          .update(schema.importRows)
          .set({ status: 'committed', jetnineId, errorsJson: null })
          .where(eq(schema.importRows.id, row.id));
        committed++;
      } catch (e) {
        failed++;
        await this.db
          .update(schema.importRows)
          .set({
            status: 'invalid',
            errorsJson: [{ field: '*', message: e instanceof Error ? e.message : String(e) }],
          })
          .where(eq(schema.importRows.id, row.id));
      }
    }
    const [updated] = await this.db
      .update(schema.importBatches)
      .set({
        status: 'committed',
        committedRowCount: committed,
        invalidRowCount: batch.invalidRowCount + failed,
        validRowCount: batch.validRowCount - failed,
        committedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.importBatches.id, batchId))
      .returning();
    // Owner 2026-09-03 catalog load: this file IS the catalog. Everything
    // it did not touch goes — deleted where nothing references it,
    // deactivated where sales, purchasing or returns history does. Only a
    // file that landed whole may retire anything: a row that failed is a
    // SKU that would otherwise vanish because of a typo in its own line.
    let replaced: ReplaceCatalogResult | null = null;
    let replaceSkipped: string | null = null;
    if (replacing) {
      if (failed > 0 || committed !== batch.rowCount) {
        replaceSkipped = `${failed} row(s) failed and ${committed} of ${batch.rowCount} committed — nothing was retired`;
      } else {
        replaced = await this.replaceCatalog(businessId, batchId);
      }
    }
    return { batch: updated, committed, failed, replaced, replaceSkipped };
  }

  /**
   * Delete or deactivate every product of the business that this batch
   * did not commit. A product is deletable only when no row outside the
   * stock ledger points at it or its variants — order / sale / PO /
   * service lines, returns, as-is pieces, write-offs, serials, counts,
   * transfers all count as history and flip it to inactive instead. The
   * foreign keys are read live from the catalog so a new table can never
   * be forgotten.
   */
  async replaceCatalog(businessId: string, batchId: string): Promise<ReplaceCatalogResult> {
    const keptRows = await this.db
      .select({ id: schema.importRows.jetnineId })
      .from(schema.importRows)
      .where(
        and(eq(schema.importRows.batchId, batchId), eq(schema.importRows.status, 'committed')),
      );
    const keep = new Set(keptRows.map((r) => r.id).filter((id): id is string => Boolean(id)));
    const candidates = await this.db
      .select({
        productId: schema.products.id,
        productSku: schema.products.sku,
        variantId: schema.productVariants.id,
        isActive: schema.products.isActive,
      })
      .from(schema.products)
      .leftJoin(schema.productVariants, eq(schema.productVariants.productId, schema.products.id))
      .where(eq(schema.products.businessId, businessId));
    const byProduct = new Map<string, string[]>();
    const skuOf = new Map<string, string>();
    const wasActive = new Set<string>();
    for (const c of candidates) {
      if (keep.has(c.productId)) continue;
      const arr = byProduct.get(c.productId) ?? [];
      if (c.variantId) arr.push(c.variantId);
      byProduct.set(c.productId, arr);
      skuOf.set(c.productId, c.productSku ?? c.productId);
      if (c.isActive) wasActive.add(c.productId);
    }
    if (byProduct.size === 0) {
      return { kept: keep.size, deleted: 0, deactivated: 0, deletedSkus: [], deactivatedSkus: [] };
    }

    // Stock ledger tables follow the product out; everything else is history.
    const ledger = new Set([
      'product_variants',
      'inventory_levels',
      'inventory_movements',
      'cost_layers',
      'cost_consumptions',
    ]);
    // pg_catalog, not information_schema: the latter hides constraints on
    // tables the request role does not own (the app role owns none).
    const fks = (await this.db.execute(sql`
      SELECT c.conrelid::regclass::text AS table_name,
             a.attname AS column_name,
             c.confrelid::regclass::text AS target
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f'
         AND c.confrelid IN ('products'::regclass, 'product_variants'::regclass)`)) as unknown as {
      table_name: string;
      column_name: string;
      target: string;
    }[];
    const productIds = [...byProduct.keys()];
    const variantIds = [...byProduct.values()].flat();
    const variantToProduct = new Map<string, string>();
    for (const [pid, vids] of byProduct) for (const v of vids) variantToProduct.set(v, pid);
    const blocked = new Set<string>();
    for (const fk of fks) {
      if (ledger.has(fk.table_name)) continue;
      const ids = fk.target === 'products' ? productIds : variantIds;
      if (ids.length === 0) continue;
      const refs = (await this.db.execute(
        sql`SELECT DISTINCT ${sql.identifier(fk.column_name)} AS id FROM ${sql.identifier(fk.table_name)} WHERE ${sql.identifier(fk.column_name)} = ANY(${sql`ARRAY[${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`,
      )) as unknown as { id: string }[];
      for (const r of refs) {
        blocked.add(fk.target === 'products' ? r.id : (variantToProduct.get(r.id) ?? r.id));
      }
    }
    // Stock is history too: a variant with units on hand, reserved or on
    // the floor keeps its ledger (movements, cost layers) by being retired
    // instead of deleted, so nothing is cascaded away that a count or a
    // valuation report could still need.
    if (variantIds.length > 0) {
      const stocked = await this.db
        .select({ variantId: schema.inventoryLevels.variantId })
        .from(schema.inventoryLevels)
        .where(
          and(
            inArray(schema.inventoryLevels.variantId, variantIds),
            sql`(${schema.inventoryLevels.onHand} <> 0 OR ${schema.inventoryLevels.reserved} <> 0 OR ${schema.inventoryLevels.floorSample} <> 0)`,
          ),
        );
      for (const r of stocked) blocked.add(variantToProduct.get(r.variantId) ?? r.variantId);
    }
    const toDelete = productIds.filter((id) => !blocked.has(id));
    const toDeactivate = productIds.filter((id) => blocked.has(id));
    if (toDelete.length > 0) {
      const deletedVariantIds = toDelete.flatMap((id) => byProduct.get(id) ?? []);
      await this.db
        .delete(schema.legacyRefs)
        .where(
          and(
            eq(schema.legacyRefs.businessId, businessId),
            inArray(schema.legacyRefs.entity, ['product', 'inventory']),
            inArray(schema.legacyRefs.jetnineId, [...toDelete, ...deletedVariantIds]),
          ),
        );
      await this.db.delete(schema.products).where(inArray(schema.products.id, toDelete));
    }
    if (toDeactivate.length > 0) {
      await this.db
        .update(schema.products)
        .set({ isActive: false, updatedAt: new Date() })
        .where(inArray(schema.products.id, toDeactivate));
      await this.db
        .update(schema.productVariants)
        .set({ isActive: false })
        .where(inArray(schema.productVariants.productId, toDeactivate));
    }
    // Re-running the same file is a no-op: only newly retired products count.
    const newlyDeactivated = toDeactivate.filter((id) => wasActive.has(id));
    const skus = (ids: string[]) => ids.map((id) => skuOf.get(id) ?? id).sort();
    return {
      kept: keep.size,
      deleted: toDelete.length,
      deactivated: newlyDeactivated.length,
      deletedSkus: skus(toDelete),
      deactivatedSkus: skus(newlyDeactivated),
    };
  }

  private async commitRow(
    businessId: string,
    batch: { id: string; entity: string },
    legacyId: string,
    n: Record<string, unknown>,
    ctx: { lookups: Lookups; categoryCache: Map<string, string>; brandCache: Map<string, string> },
  ): Promise<string> {
    switch (batch.entity) {
      case 'customer':
        return this.commitCustomer(businessId, batch.id, legacyId, n);
      case 'vendor':
        return this.commitVendor(businessId, batch.id, legacyId, n);
      case 'product':
        return this.commitProduct(
          businessId,
          batch.id,
          legacyId,
          n,
          ctx.categoryCache,
          ctx.brandCache,
        );
      case 'inventory':
        return this.commitInventory(businessId, batch.id, legacyId, n, ctx.lookups);
      case 'order':
        return this.commitOrder(businessId, batch.id, legacyId, n, ctx.lookups);
      case 'order_line':
        return this.commitOrderLine(businessId, batch.id, legacyId, n, ctx.lookups);
      case 'sale':
        return this.commitSale(businessId, batch.id, legacyId, n, ctx.lookups);
      case 'sale_line':
        return this.commitSaleLine(businessId, batch.id, legacyId, n, ctx.lookups);
      default:
        throw new BadRequestException(`Unknown entity "${batch.entity}"`);
    }
  }

  /** True when `id` sits anywhere below `ancestorId` in the category tree. */
  private async isCategoryUnder(id: string, ancestorId: string): Promise<boolean> {
    let cursor: string | null = id;
    for (let hops = 0; cursor && hops < 8; hops += 1) {
      const rows: { parentId: string | null }[] = await this.db
        .select({ parentId: schema.categories.parentId })
        .from(schema.categories)
        .where(eq(schema.categories.id, cursor))
        .limit(1);
      const parentId: string | null = rows[0]?.parentId ?? null;
      if (parentId === ancestorId) return true;
      cursor = parentId;
    }
    return false;
  }

  private async refFor(businessId: string, entity: string, legacyId: string) {
    const [ref] = await this.db
      .select({ jetnineId: schema.legacyRefs.jetnineId })
      .from(schema.legacyRefs)
      .where(
        and(
          eq(schema.legacyRefs.businessId, businessId),
          eq(schema.legacyRefs.entity, entity),
          eq(schema.legacyRefs.legacyId, legacyId),
        ),
      )
      .limit(1);
    return ref?.jetnineId ?? null;
  }

  private async upsertRef(
    businessId: string,
    entity: string,
    legacyId: string,
    jetnineId: string,
    batchId: string,
  ) {
    await this.db
      .insert(schema.legacyRefs)
      .values({ businessId, entity, legacyId, jetnineId, importBatchId: batchId })
      .onConflictDoUpdate({
        target: [
          schema.legacyRefs.businessId,
          schema.legacyRefs.entity,
          schema.legacyRefs.legacyId,
        ],
        set: { jetnineId, importBatchId: batchId, updatedAt: new Date() },
      });
  }

  private async commitCustomer(
    businessId: string,
    batchId: string,
    legacyId: string,
    n: Record<string, unknown>,
  ): Promise<string> {
    const address =
      n.addressLine1 || n.city || n.postalCode
        ? [
            {
              line1: (n.addressLine1 as string) ?? null,
              line2: (n.addressLine2 as string) ?? null,
              city: (n.city as string) ?? null,
              region: (n.region as string) ?? null,
              postalCode: (n.postalCode as string) ?? null,
            },
          ]
        : null;
    const values = {
      firstName: (n.firstName as string) ?? null,
      lastName: (n.lastName as string) ?? null,
      email: (n.email as string) ?? null,
      phone: (n.phone as string) ?? null,
      notes: (n.notes as string) ?? null,
      addressesJson: address,
      updatedAt: new Date(),
    };
    const existing = await this.refFor(businessId, 'customer', legacyId);
    let id: string;
    if (existing) {
      await this.db.update(schema.customers).set(values).where(eq(schema.customers.id, existing));
      id = existing;
    } else {
      const [created] = await this.db
        .insert(schema.customers)
        .values({ businessId, ...values })
        .returning({ id: schema.customers.id });
      id = created!.id;
    }
    await this.upsertRef(businessId, 'customer', legacyId, id, batchId);
    return id;
  }

  private async commitVendor(
    businessId: string,
    batchId: string,
    legacyId: string,
    n: Record<string, unknown>,
  ): Promise<string> {
    const values = {
      name: n.name as string,
      contactName: (n.contactName as string) ?? null,
      email: (n.email as string) ?? null,
      phone: (n.phone as string) ?? null,
      updatedAt: new Date(),
    };
    let id = await this.refFor(businessId, 'vendor', legacyId);
    if (!id) {
      // Adopt an existing vendor with the same (unique) name rather than
      // colliding with it.
      const [byName] = await this.db
        .select({ id: schema.vendors.id })
        .from(schema.vendors)
        .where(and(eq(schema.vendors.businessId, businessId), eq(schema.vendors.name, values.name)))
        .limit(1);
      id = byName?.id ?? null;
    }
    if (id) {
      await this.db.update(schema.vendors).set(values).where(eq(schema.vendors.id, id));
    } else {
      const [created] = await this.db
        .insert(schema.vendors)
        .values({ businessId, ...values })
        .returning({ id: schema.vendors.id });
      id = created!.id;
    }
    await this.upsertRef(businessId, 'vendor', legacyId, id, batchId);
    return id;
  }

  private async commitProduct(
    businessId: string,
    batchId: string,
    legacyId: string,
    n: Record<string, unknown>,
    categoryCache: Map<string, string>,
    brandCache: Map<string, string> = new Map(),
  ): Promise<string> {
    const sku = n.sku as string;
    // Brand (owner 2026-09-03): find-or-create by name, case-insensitive;
    // only touched when the file carries a BRAND column.
    let brandId: string | null | undefined;
    if (typeof n.brand === 'string' && n.brand.trim() !== '') {
      const key = n.brand.trim().toLowerCase();
      if (!brandCache.has(key)) {
        const [existing] = await this.db
          .select({ id: schema.brands.id })
          .from(schema.brands)
          .where(
            and(
              eq(schema.brands.businessId, businessId),
              sql`lower(${schema.brands.name}) = ${key}`,
            ),
          )
          .limit(1);
        if (existing) brandCache.set(key, existing.id);
        else {
          const [created] = await this.db
            .insert(schema.brands)
            .values({ businessId, name: n.brand.trim() })
            .returning({ id: schema.brands.id });
          brandCache.set(key, created!.id);
        }
      }
      brandId = brandCache.get(key)!;
    }
    let categoryId: string | null = null;
    if (typeof n.category === 'string' && n.category !== '') {
      const key = n.category.toLowerCase();
      if (!categoryCache.has(key)) {
        const [existing] = await this.db
          .select({ id: schema.categories.id })
          .from(schema.categories)
          .where(
            and(
              eq(schema.categories.businessId, businessId),
              sql`lower(${schema.categories.name}) = ${key}`,
            ),
          )
          .limit(1);
        if (existing) categoryCache.set(key, existing.id);
        else {
          // A22.1: the STORIS CATG codes were renamed to their retail names
          // by the categorize-products run; a code with no category of its
          // own name lands on that root instead of re-creating "MATT".
          const alias = LEGACY_CATEGORY_NAMES[n.category.toUpperCase()];
          const [aliased] = alias
            ? await this.db
                .select({ id: schema.categories.id })
                .from(schema.categories)
                .where(
                  and(
                    eq(schema.categories.businessId, businessId),
                    isNull(schema.categories.parentId),
                    sql`lower(${schema.categories.name}) = ${alias.toLowerCase()}`,
                  ),
                )
                .limit(1)
            : [];
          if (aliased) categoryCache.set(key, aliased.id);
          else {
            const [created] = await this.db
              .insert(schema.categories)
              .values({ businessId, name: n.category })
              .returning({ id: schema.categories.id });
            categoryCache.set(key, created!.id);
          }
        }
      }
      categoryId = categoryCache.get(key)!;
    }

    let productId = await this.refFor(businessId, 'product', legacyId);
    if (!productId) {
      // Adopt a catalog row that already carries this SKU (unique per business).
      const [bySku] = await this.db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(and(eq(schema.products.businessId, businessId), eq(schema.products.sku, sku)))
        .limit(1);
      productId = bySku?.id ?? null;
    }
    // A22.1: an import never coarsens a category. A product already filed
    // under a subcategory of the one the file names (Mattresses › Hybrid
    // when the file says MATT) keeps the finer one.
    if (productId && categoryId) {
      const [current] = await this.db
        .select({ categoryId: schema.products.categoryId })
        .from(schema.products)
        .where(eq(schema.products.id, productId))
        .limit(1);
      const cur = current?.categoryId ?? null;
      if (cur && cur !== categoryId && (await this.isCategoryUnder(cur, categoryId))) {
        categoryId = cur;
      }
    }
    const productValues = {
      sku,
      name: n.name as string,
      description: (n.description as string) ?? null,
      categoryId,
      serialTracked: n.serialTracked === true,
      updatedAt: new Date(),
      ...(brandId !== undefined ? { brandId } : {}),
      // A replaced catalog row is live again even if it was retired before.
      isActive: true,
    };
    if (productId) {
      await this.db
        .update(schema.products)
        .set(productValues)
        .where(eq(schema.products.id, productId));
    } else {
      const [created] = await this.db
        .insert(schema.products)
        .values({ businessId, ...productValues })
        .returning({ id: schema.products.id });
      productId = created!.id;
    }

    const variantValues: Partial<typeof schema.productVariants.$inferInsert> = {
      costCents: (n.costCents as number) ?? null,
      barcode: (n.barcode as string) ?? null,
    };
    // Price only when the file carries one (D12): an import without a
    // RETAIL column never clobbers an existing price (e.g. from Shopify).
    if (typeof n.priceCents === 'number') {
      variantValues.priceCents = n.priceCents;
    }
    // Purchasing enrichment — only touch these when the file supplies
    // them, so a re-import without the columns never wipes merchant edits.
    if (typeof n.vendorSku === 'string' && n.vendorSku.trim().length > 0) {
      variantValues.vendorSku = n.vendorSku.trim();
    }
    if (typeof n.reorderPoint === 'number' && Number.isInteger(n.reorderPoint)) {
      variantValues.reorderPoint = n.reorderPoint;
    }
    if (typeof n.vendorName === 'string' && n.vendorName.trim().length > 0) {
      variantValues.preferredVendorId = await this.vendorIdByName(businessId, n.vendorName.trim());
    }
    const [variant] = await this.db
      .select({
        id: schema.productVariants.id,
        attributesJson: schema.productVariants.attributesJson,
      })
      .from(schema.productVariants)
      .where(
        and(eq(schema.productVariants.productId, productId), eq(schema.productVariants.sku, sku)),
      )
      .limit(1);
    // STORIS Group (QUEEN, CAKING, QUFND, …) rides on the variant's
    // attributes; other attributes are kept.
    if (typeof n.group === 'string' && n.group.trim() !== '') {
      const prior =
        variant?.attributesJson && typeof variant.attributesJson === 'object'
          ? (variant.attributesJson as Record<string, unknown>)
          : {};
      variantValues.attributesJson = { ...prior, group: n.group.trim() } as never;
    }
    variantValues.isActive = true;
    if (variant) {
      await this.db
        .update(schema.productVariants)
        .set(variantValues)
        .where(eq(schema.productVariants.id, variant.id));
    } else {
      await this.db.insert(schema.productVariants).values({
        businessId,
        productId,
        sku,
        ...variantValues,
        priceCents: typeof n.priceCents === 'number' ? n.priceCents : 0,
      });
    }
    await this.upsertRef(businessId, 'product', legacyId, productId, batchId);
    return productId;
  }

  /**
   * Find-or-create a vendor by (case-insensitive) name for product-import
   * enrichment. Cached per service call-site via the DB itself — imports
   * repeat the same few vendor names thousands of times, but the lookup
   * is an indexed single-row select.
   */
  private async vendorIdByName(businessId: string, name: string): Promise<string> {
    const [existing] = await this.db
      .select({ id: schema.vendors.id })
      .from(schema.vendors)
      .where(
        and(
          eq(schema.vendors.businessId, businessId),
          sql`lower(${schema.vendors.name}) = ${name.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (existing) return existing.id;
    const [created] = await this.db
      .insert(schema.vendors)
      .values({ businessId, name })
      .returning({ id: schema.vendors.id });
    return created!.id;
  }

  private async commitInventory(
    businessId: string,
    batchId: string,
    legacyId: string,
    n: Record<string, unknown>,
    lookups: Lookups,
  ): Promise<string> {
    const variant = lookups.variants.get((n.sku as string).toLowerCase());
    if (!variant) throw new BadRequestException(`unknown SKU "${String(n.sku)}"`);
    const locationId = resolveLocation(lookups, n.location);
    if (!locationId) throw new BadRequestException(`unknown location "${String(n.location)}"`);
    const onHand = n.onHand as number;

    // STORIS quoted average cost; keep it unless the product import
    // already set one.
    if (typeof n.unitCostCents === 'number' && variant.costCents == null) {
      await this.db
        .update(schema.productVariants)
        .set({ costCents: n.unitCostCents })
        .where(eq(schema.productVariants.id, variant.variantId));
      variant.costCents = n.unitCostCents;
    }

    const reorderPoint =
      typeof n.reorderPoint === 'number' && Number.isInteger(n.reorderPoint)
        ? n.reorderPoint
        : undefined;
    const [level] = await this.db
      .select({
        id: schema.inventoryLevels.id,
        onHand: schema.inventoryLevels.onHand,
        reorderPoint: schema.inventoryLevels.reorderPoint,
      })
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, variant.variantId),
          eq(schema.inventoryLevels.locationId, locationId),
        ),
      )
      .limit(1);
    let levelId: string;
    let delta: number;
    if (level) {
      delta = onHand - level.onHand;
      levelId = level.id;
      if (delta !== 0 || (reorderPoint !== undefined && reorderPoint !== level.reorderPoint)) {
        await this.db
          .update(schema.inventoryLevels)
          .set({
            onHand,
            ...(reorderPoint !== undefined ? { reorderPoint } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.inventoryLevels.id, level.id));
      }
    } else {
      delta = onHand;
      const [created] = await this.db
        .insert(schema.inventoryLevels)
        .values({
          businessId,
          variantId: variant.variantId,
          locationId,
          onHand,
          reserved: 0,
          reorderPoint: reorderPoint ?? null,
        })
        .returning({ id: schema.inventoryLevels.id });
      levelId = created!.id;
    }
    // Per-store minimum stock rolls up into the variant's reorder point
    // (REPL-040 sums availability across locations, so the sum matches).
    if (reorderPoint !== undefined) {
      await this.db
        .update(schema.productVariants)
        .set({
          reorderPoint: sql`(SELECT COALESCE(SUM(${schema.inventoryLevels.reorderPoint}), 0)::int FROM ${schema.inventoryLevels} WHERE ${schema.inventoryLevels.variantId} = ${variant.variantId})`,
        })
        .where(eq(schema.productVariants.id, variant.variantId));
    }
    // As-is pieces (owner 2026-09-03): the file's as-is count at this
    // store becomes that many import-sourced as-is rows, reconciled on
    // re-import (added or removed while still pending review). ON_HAND
    // already includes them.
    if (typeof n.asIsQty === 'number' && Number.isInteger(n.asIsQty) && n.asIsQty >= 0) {
      const existing = await this.db
        .select({ id: schema.asIsItems.id })
        .from(schema.asIsItems)
        .where(
          and(
            eq(schema.asIsItems.variantId, variant.variantId),
            eq(schema.asIsItems.locationId, locationId),
            eq(schema.asIsItems.referenceType, 'import_batch'),
            eq(schema.asIsItems.status, 'pending_review'),
          ),
        )
        .orderBy(desc(schema.asIsItems.createdAt));
      const want = n.asIsQty;
      if (want > existing.length) {
        await this.db.insert(schema.asIsItems).values(
          Array.from({ length: want - existing.length }, () => ({
            businessId,
            variantId: variant.variantId,
            locationId,
            quantity: 1,
            source: 'import',
            referenceType: 'import_batch',
            referenceId: batchId,
            notes: 'STORIS as-is snapshot',
          })),
        );
      } else if (want < existing.length) {
        await this.db.delete(schema.asIsItems).where(
          inArray(
            schema.asIsItems.id,
            existing.slice(0, existing.length - want).map((r) => r.id),
          ),
        );
      }
    }
    // The movement keeps the on-hand ledger honest (D3): the snapshot
    // change is visible as an explicit legacy-import correction.
    if (delta !== 0) {
      await this.db.insert(schema.inventoryMovements).values({
        businessId,
        variantId: variant.variantId,
        locationId,
        delta,
        reason: 'import',
        referenceType: 'import_batch',
        referenceId: batchId,
        notes: `STORIS import set on-hand to ${onHand}`,
      });
    }
    await this.upsertRef(businessId, 'inventory', legacyId, levelId, batchId);
    return levelId;
  }

  private async commitOrder(
    businessId: string,
    batchId: string,
    legacyId: string,
    n: Record<string, unknown>,
    lookups: Lookups,
  ): Promise<string> {
    const customerId = lookups.customerRefs.get(n.customerAccountNo as string);
    if (!customerId)
      throw new BadRequestException(`unknown customer "${String(n.customerAccountNo)}"`);
    const locationId = resolveLocation(lookups, n.location);
    if (!locationId) throw new BadRequestException(`unknown location "${String(n.location)}"`);

    const totalCents = n.totalCents as number;
    const taxCents = (n.taxCents as number) ?? 0;
    const statusWord = typeof n.status === 'string' ? n.status.toLowerCase() : '';
    const status = statusWord.includes('quote') ? 'quote' : 'open';
    const orderDate = typeof n.orderDate === 'string' ? new Date(n.orderDate) : null;
    const promised = typeof n.promisedDate === 'string' ? n.promisedDate.slice(0, 10) : null;

    const values = {
      locationId,
      customerId,
      status,
      subtotalCents: totalCents - taxCents,
      taxCents,
      totalCents,
      requestedDate: promised,
      notes: (n.notes as string) ?? null,
      legacyNumber: legacyId,
      updatedAt: new Date(),
      ...(orderDate ? { createdAt: orderDate } : {}),
    };
    let orderId = await this.refFor(businessId, 'order', legacyId);
    if (orderId) {
      await this.db.update(schema.orders).set(values).where(eq(schema.orders.id, orderId));
    } else {
      const [created] = await this.db
        .insert(schema.orders)
        .values({
          businessId,
          number: legacyId,
          importedAt: new Date(),
          ...values,
        })
        .returning({ id: schema.orders.id });
      orderId = created!.id;
      lookups.orderRefs.set(legacyId, orderId);
    }
    await this.upsertRef(businessId, 'order', legacyId, orderId, batchId);

    // Deposits held: one payment row keeps the balance math identical to
    // native orders (D2). Idempotent through its own ref entity.
    const depositCents = (n.depositCents as number) ?? 0;
    const depositRef = await this.refFor(businessId, 'order_deposit', legacyId);
    if (depositRef) {
      await this.db
        .update(schema.payments)
        .set({ amountCents: depositCents })
        .where(eq(schema.payments.id, depositRef));
    } else if (depositCents > 0) {
      const [payment] = await this.db
        .insert(schema.payments)
        .values({
          businessId,
          orderId,
          kind: 'deposit',
          method: 'legacy',
          amountCents: depositCents,
          status: 'succeeded',
          ...(orderDate ? { createdAt: orderDate } : {}),
        })
        .returning({ id: schema.payments.id });
      await this.upsertRef(businessId, 'order_deposit', legacyId, payment!.id, batchId);
    }
    return orderId;
  }

  private async commitOrderLine(
    businessId: string,
    batchId: string,
    legacyId: string,
    n: Record<string, unknown>,
    lookups: Lookups,
  ): Promise<string> {
    const orderId = lookups.orderRefs.get(n.orderNo as string);
    if (!orderId) throw new BadRequestException(`unknown order "${String(n.orderNo)}"`);
    const variant = lookups.variants.get((n.sku as string).toLowerCase());
    if (!variant) throw new BadRequestException(`unknown SKU "${String(n.sku)}"`);

    const quantity = n.quantity as number;
    const unitPriceCents = n.unitPriceCents as number;
    const values = {
      variantId: variant.variantId,
      description: (n.description as string) ?? (n.sku as string),
      quantity,
      unitPriceCents,
      totalCents: (n.totalCents as number) ?? quantity * unitPriceCents,
      lineType: 'stock' as const,
    };
    const existing = await this.refFor(businessId, 'order_line', legacyId);
    let id: string;
    if (existing) {
      await this.db.update(schema.orderLines).set(values).where(eq(schema.orderLines.id, existing));
      id = existing;
    } else {
      const [created] = await this.db
        .insert(schema.orderLines)
        .values({ businessId, orderId, ...values })
        .returning({ id: schema.orderLines.id });
      id = created!.id;
    }
    await this.upsertRef(businessId, 'order_line', legacyId, id, batchId);
    return id;
  }

  private async commitSale(
    businessId: string,
    batchId: string,
    legacyId: string,
    n: Record<string, unknown>,
    lookups: Lookups,
  ): Promise<string> {
    const locationId = resolveLocation(lookups, n.location);
    if (!locationId) throw new BadRequestException(`unknown location "${String(n.location)}"`);
    const customerId =
      typeof n.customerAccountNo === 'string'
        ? (lookups.customerRefs.get(n.customerAccountNo) ?? null)
        : null;
    const totalCents = n.totalCents as number;
    const taxCents = (n.taxCents as number) ?? 0;
    const saleDate = new Date(n.saleDate as string);

    const values = {
      locationId,
      customerId,
      status: 'completed',
      subtotalCents: totalCents - taxCents,
      taxCents,
      totalCents,
      completedAt: saleDate,
      createdAt: saleDate,
    };
    let saleId = await this.refFor(businessId, 'sale', legacyId);
    if (saleId) {
      await this.db.update(schema.sales).set(values).where(eq(schema.sales.id, saleId));
    } else {
      const [created] = await this.db
        .insert(schema.sales)
        .values({ businessId, number: legacyId, importedAt: new Date(), ...values })
        .returning({ id: schema.sales.id });
      saleId = created!.id;
    }
    await this.upsertRef(businessId, 'sale', legacyId, saleId, batchId);

    const paymentRef = await this.refFor(businessId, 'sale_payment', legacyId);
    const method = mapTender(n.method as string | undefined);
    if (paymentRef) {
      await this.db
        .update(schema.payments)
        .set({ amountCents: totalCents, method })
        .where(eq(schema.payments.id, paymentRef));
    } else if (totalCents !== 0) {
      const [payment] = await this.db
        .insert(schema.payments)
        .values({
          businessId,
          saleId,
          kind: 'sale',
          method,
          amountCents: totalCents,
          status: 'succeeded',
          createdAt: saleDate,
        })
        .returning({ id: schema.payments.id });
      await this.upsertRef(businessId, 'sale_payment', legacyId, payment!.id, batchId);
    }
    return saleId;
  }

  /**
   * Owner 2026-08-31: attach the per-item lines to imported sale
   * headers — receipts imported header-only showed nothing but money.
   * A SKU that matches the catalog binds the variant; one that doesn't
   * still imports with its description (D8: imported rows never touch
   * stock, drawer, or commissions, so no inventory moves here).
   */
  private async commitSaleLine(
    businessId: string,
    batchId: string,
    legacyId: string,
    n: Record<string, unknown>,
    lookups: Lookups,
  ): Promise<string> {
    const saleId = lookups.saleRefs.get(n.invoiceNo as string);
    if (!saleId) throw new BadRequestException(`unknown invoice "${String(n.invoiceNo)}"`);
    const variant =
      typeof n.sku === 'string' ? lookups.variants.get(n.sku.toLowerCase()) : undefined;
    const description = ((n.description as string) || (n.sku as string) || '').trim();
    if (!description) throw new BadRequestException('a line needs a SKU or a description');

    const quantity = n.quantity as number;
    const unitPriceCents = n.unitPriceCents as number;
    const values = {
      variantId: variant?.variantId ?? null,
      description,
      quantity,
      unitPriceCents,
      totalCents: (n.totalCents as number) ?? quantity * unitPriceCents,
    };
    const existing = await this.refFor(businessId, 'sale_line', legacyId);
    let id: string;
    if (existing) {
      await this.db.update(schema.saleLines).set(values).where(eq(schema.saleLines.id, existing));
      id = existing;
    } else {
      const [created] = await this.db
        .insert(schema.saleLines)
        .values({ businessId, saleId, ...values })
        .returning({ id: schema.saleLines.id });
      id = created!.id;
    }
    await this.upsertRef(businessId, 'sale_line', legacyId, id, batchId);
    return id;
  }

  // --- Reads ---

  async getBatch(batchId: string) {
    const [batch] = await this.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, batchId))
      .limit(1);
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  async listBatches(entity?: string) {
    return this.db
      .select()
      .from(schema.importBatches)
      .where(entity ? eq(schema.importBatches.entity, entity) : undefined)
      .orderBy(desc(schema.importBatches.createdAt))
      .limit(100);
  }

  async batchRows(batchId: string, onlyInvalid: boolean) {
    return this.db
      .select()
      .from(schema.importRows)
      .where(
        and(
          eq(schema.importRows.batchId, batchId),
          onlyInvalid ? eq(schema.importRows.status, 'invalid') : undefined,
        ),
      )
      .orderBy(schema.importRows.rowNumber)
      .limit(200);
  }

  // --- Reconciliation (§7 gates 1–4; gate 5 is the human spot-check) ---

  async recon(businessId: string) {
    // Latest committed source row per legacy id, per entity.
    const committedRows = await this.db
      .select({
        entity: schema.importBatches.entity,
        legacyId: schema.importRows.legacyId,
        normalizedJson: schema.importRows.normalizedJson,
        committedAt: schema.importBatches.committedAt,
      })
      .from(schema.importRows)
      .innerJoin(schema.importBatches, eq(schema.importRows.batchId, schema.importBatches.id))
      .where(
        and(
          eq(schema.importRows.businessId, businessId),
          eq(schema.importRows.status, 'committed'),
        ),
      );
    const latest = new Map<string, Map<string, Record<string, unknown>>>();
    const at = new Map<string, number>();
    for (const r of committedRows) {
      if (!r.legacyId) continue;
      const key = `${r.entity}:${r.legacyId}`;
      const t = r.committedAt ? new Date(r.committedAt).getTime() : 0;
      if ((at.get(key) ?? -1) <= t) {
        at.set(key, t);
        if (!latest.has(r.entity)) latest.set(r.entity, new Map());
        latest.get(r.entity)!.set(r.legacyId, (r.normalizedJson ?? {}) as Record<string, unknown>);
      }
    }
    const sourceCount = (entity: string) => latest.get(entity)?.size ?? 0;

    // Gate 1 — row counts per entity vs identity-map rows.
    const refCounts = await this.db
      .select({ entity: schema.legacyRefs.entity, count: sql<number>`count(*)::int` })
      .from(schema.legacyRefs)
      .where(eq(schema.legacyRefs.businessId, businessId))
      .groupBy(schema.legacyRefs.entity);
    const refCount = new Map(refCounts.map((r) => [r.entity, r.count]));
    const entities = [
      'customer',
      'vendor',
      'product',
      'inventory',
      'order',
      'order_line',
      'sale',
      'sale_line',
    ].map((entity) => ({
      entity,
      source: sourceCount(entity),
      db: refCount.get(entity) ?? 0,
      match: sourceCount(entity) === (refCount.get(entity) ?? 0),
    }));

    // Gate 2 — units on hand + valuation at cost.
    const invSource = latest.get('inventory') ?? new Map();
    let srcUnits = 0;
    let srcValuation = 0;
    for (const n of invSource.values()) {
      const qty = (n.onHand as number) ?? 0;
      srcUnits += qty;
      srcValuation += qty * ((n.unitCostCents as number) ?? 0);
    }
    const [dbInv] = await this.db
      .select({
        units: sql<number>`coalesce(sum(${schema.inventoryLevels.onHand}), 0)::int`,
        valuation: sql<number>`coalesce(sum(${schema.inventoryLevels.onHand} * coalesce(${schema.productVariants.costCents}, 0)), 0)::bigint`,
      })
      .from(schema.inventoryLevels)
      .innerJoin(
        schema.productVariants,
        eq(schema.inventoryLevels.variantId, schema.productVariants.id),
      )
      .innerJoin(
        schema.legacyRefs,
        and(
          eq(schema.legacyRefs.jetnineId, schema.inventoryLevels.id),
          eq(schema.legacyRefs.entity, 'inventory'),
          eq(schema.legacyRefs.businessId, businessId),
        ),
      );

    // Gate 3 — Σ deposits held on imported open orders.
    let srcDeposits = 0;
    let srcAr = 0;
    for (const n of (latest.get('order') ?? new Map()).values()) {
      const dep = (n.depositCents as number) ?? 0;
      srcDeposits += dep;
      srcAr += ((n.totalCents as number) ?? 0) - dep;
    }
    const [dbDeposits] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)::bigint`,
      })
      .from(schema.payments)
      .innerJoin(schema.orders, eq(schema.payments.orderId, schema.orders.id))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          isNotNull(schema.orders.importedAt),
          eq(schema.payments.kind, 'deposit'),
          eq(schema.payments.status, 'succeeded'),
        ),
      );

    // Gate 4 — Σ open AR (imported order totals minus everything paid).
    const [dbAr] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${schema.orders.totalCents}), 0)::bigint - coalesce((
          select sum(p.amount_cents) from payments p
          join orders o2 on o2.id = p.order_id
          where o2.business_id = ${businessId}
            and o2.imported_at is not null and p.status = 'succeeded'
            and o2.status not in ('quote', 'cancelled', 'completed')
        ), 0)::bigint`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          isNotNull(schema.orders.importedAt),
          sql`${schema.orders.status} not in ('quote', 'cancelled', 'completed')`,
        ),
      );

    const gate = (source: number, db: number) => ({
      source,
      db: Number(db),
      match: source === Number(db),
    });
    return {
      generatedAt: new Date().toISOString(),
      gate1_rowCounts: entities,
      gate2_inventory: {
        units: gate(srcUnits, dbInv?.units ?? 0),
        valuationCents: gate(srcValuation, dbInv?.valuation ?? 0),
      },
      gate3_depositsHeldCents: gate(srcDeposits, dbDeposits?.total ?? 0),
      gate4_openArCents: gate(srcAr, dbAr?.total ?? 0),
      gate5: 'human spot-check — compare 20 random customers side-by-side with STORIS',
    };
  }
}
