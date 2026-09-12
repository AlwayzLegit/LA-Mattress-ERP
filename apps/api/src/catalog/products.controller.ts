import {
  BadRequestException,
  ForbiddenException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import {
  FIRMNESS_LEVELS,
  firmnessFromText,
  MATTRESS_SIZES,
  normalizeFirmness,
  normalizeSize,
  PRODUCT_PURCHASE_STATUSES,
  sizeFromText,
  type ProductPurchaseStatus,
} from '@jetnine/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import {
  buildPage,
  clampLimit as clampPageLimit,
  encodeCursor,
  decodeCursor,
  type PageResponse,
} from '../common/pagination';
import { vendorMatchFor } from '../common/vendor-match';
import { DRIZZLE } from '../database/database.module';
import { mergeShipping, parseShipping, type ProductShipping } from './product-shipping';
import {
  loadProductStockByLocation,
  loadProductStockTotals,
  type LocationStockRow,
  type StockTotals,
  loadProductStoreCells,
  type StoreCell,
} from './product-stock';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import { loadCategoryIndex } from './category-tree';
import type { RequestTenantContext } from '../tenancy/request-context';

/** Connector syncs write import batches under their provider name. */
const CONNECTOR_SOURCES = new Set(['shopify', 'woocommerce', 'wix']);
function isFileImport(source: string | null): boolean {
  return source != null && !CONNECTOR_SOURCES.has(source.toLowerCase());
}

interface VariantInput {
  sku?: string | null;
  name?: string | null;
  priceCents: number;
  costCents?: number | null;
  barcode?: string | null;
  attributesJson?: Record<string, unknown> | null;
  /** A22.2: canonical size / firmness; absent → read off the attributes and names. */
  size?: string | null;
  firmness?: string | null;
}

/**
 * A22.2: the size and firmness a new variant carries — what the caller
 * says (validated), else what its attributes and names state.
 */
export function deriveVariantSizing(
  v: {
    size?: string | null;
    firmness?: string | null;
    attributesJson?: Record<string, unknown> | null;
    name?: string | null;
  },
  productName: string,
): { size: string | null; firmness: string | null } {
  const attrs = v.attributesJson ?? {};
  const attrSize = typeof attrs.size === 'string' ? attrs.size : null;
  const attrFirmness = typeof attrs.firmness === 'string' ? attrs.firmness : null;
  const hay = `${productName} ${v.name ?? ''}`;
  if (v.size && !normalizeSize(v.size)) {
    throw new BadRequestException(`size must be one of: ${MATTRESS_SIZES.join(', ')}`);
  }
  if (v.firmness && !normalizeFirmness(v.firmness)) {
    throw new BadRequestException(`firmness must be one of: ${FIRMNESS_LEVELS.join(', ')}`);
  }
  return {
    size:
      v.size === null
        ? null
        : (normalizeSize(v.size) ?? normalizeSize(attrSize) ?? sizeFromText(hay)),
    firmness:
      v.firmness === null
        ? null
        : (normalizeFirmness(v.firmness) ??
          normalizeFirmness(attrFirmness) ??
          firmnessFromText(hay)),
  };
}

interface CreateProductBody {
  sku?: string | null;
  name?: string;
  description?: string | null;
  categoryId?: string | null;
  taxClassId?: string | null;
  brandId?: string | null;
  collectionId?: string | null;
  variants?: VariantInput[];
}

interface UpdateProductBody {
  sku?: string | null;
  name?: string;
  description?: string | null;
  categoryId?: string | null;
  taxClassId?: string | null;
  brandId?: string | null;
  collectionId?: string | null;
  isActive?: boolean;
  /** G7: variants of a serial-tracked product carry serial_units rows. */
  serialTracked?: boolean;
  // STORIS Advanced Product Settings (A19).
  secondDescription?: string | null;
  purchaseStatus?: ProductPurchaseStatus;
  boxesPerProduct?: number;
  logisticalCartonQty?: number;
  purchaseCartonQty?: number;
  logisticalCartonTransfers?: boolean;
  // A21 General Information (D9).
  suggestedRetailCents?: number | null;
  shipping?: Partial<Record<keyof ProductShipping, number | null>> | null;
}

/** One row of the STORIS-shaped product list (A19). */
interface ProductListRow {
  id: string;
  sku: string | null;
  name: string;
  isActive: boolean;
  purchaseStatus: string;
  brandName: string | null;
  /** A21 addendum: STORIS Search for a Product leads with the category and ends with the collection. */
  categoryName: string | null;
  /** A22.1: the full nested name, "Mattresses › Hybrid". */
  categoryPath: string | null;
  collectionName: string | null;
  /** A22.2: the primary variant's canonical size and firmness. */
  size: string | null;
  firmness: string | null;
  vendorName: string | null;
  vendorModel: string | null;
  group: string | null;
  priceCents: number | null;
  /** Sales margin cost — null when the viewer lacks products.cost.view. */
  costCents: number | null;
  onHand: number;
  available: number;
  netOnPo: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
  /** Redesign Phase 7: reserved across locations and one cell per store. */
  reserved: number;
  stockByLocation: Record<string, StoreCell>;
}

interface VariantOut {
  id: string;
  sku: string | null;
  name: string | null;
  barcode: string | null;
  priceCents: number;
  costCents: number | null;
  attributesJson: unknown;
  size: string | null;
  firmness: string | null;
  isActive: boolean;
  reorderPoint: number | null;
  reorderQty: number | null;
  preferredVendorId: string | null;
  vendorSku: string | null;
}

interface ProductOut {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  categoryId: string | null;
  taxClassId: string | null;
  brandId: string | null;
  collectionId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  variants: VariantOut[];
  images: { id: string; storageKey: string; altText: string | null; position: number }[];
  // STORIS screens (A19): names next to the ids, the descriptive /
  // purchase-status / packing fields, and stock by location.
  serialTracked: boolean;
  secondDescription: string | null;
  purchaseStatus: string;
  boxesPerProduct: number;
  logisticalCartonQty: number;
  purchaseCartonQty: number;
  logisticalCartonTransfers: boolean;
  /** A21 D9: STORIS Suggested Retail Price and the Shipping Information block. */
  suggestedRetailCents: number | null;
  shipping: ProductShipping;
  brandName: string | null;
  categoryName: string | null;
  /** A22.1: the full nested name, "Mattresses › Hybrid". */
  categoryPath: string | null;
  collectionName: string | null;
  /** A22.2: the primary variant's canonical size and firmness. */
  size: string | null;
  firmness: string | null;
  vendorName: string | null;
  vendorModel: string | null;
  group: string | null;
  stock: { totals: StockTotals; byLocation: LocationStockRow[] };
}

/** The STORIS browser columns a click can sort by (owner 2026-09-11). */
export const PRODUCT_SORT_KEYS = [
  'sku',
  'vendorModel',
  'vendorName',
  'name',
  'onHand',
  'available',
  'netOnPo',
  'costCents',
  'asIsOnHand',
  'asIsAvailable',
  'priceCents',
  'purchaseStatus',
  'asIsNonSellable',
  'group',
  'size',
  'firmness',
  'brandName',
  'categoryName',
  'collectionName',
] as const;
export type ProductSortKey = (typeof PRODUCT_SORT_KEYS)[number];

/** A sorted browse materialises at most this many products (by name). */
const SORTED_BROWSE_CAP = 5000;
const OFFSET_CURSOR_ID = 'offset';

function offsetFromCursor(raw: string | undefined): number {
  const c = decodeCursor(raw);
  if (!c) return 0;
  if (c.id !== OFFSET_CURSOR_ID || typeof c.v !== 'number' || c.v < 0) {
    throw new BadRequestException('Invalid cursor');
  }
  return Math.floor(c.v);
}

/**
 * Stable sort of finished rows: text columns case-insensitively with
 * blanks last in either direction, numbers numerically (a hidden cost
 * counts as blank), name + id as the tiebreaker so pages never repeat.
 */
export function sortProductRows(
  rows: ProductListRow[],
  key: ProductSortKey,
  dir: 'asc' | 'desc',
): ProductListRow[] {
  const sign = dir === 'desc' ? -1 : 1;
  const cmp = (a: ProductListRow, b: ProductListRow): number => {
    const av = a[key];
    const bv = b[key];
    const aBlank = av == null || av === '';
    const bBlank = bv == null || bv === '';
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv);
    if (typeof av === 'boolean' && typeof bv === 'boolean') return sign * (Number(av) - Number(bv));
    return sign * String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
  };
  return [...rows].sort(
    (a, b) => cmp(a, b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

@TenantScoped()
@Controller('v1/products')
export class CatalogProductsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * List products. Query params:
   *   q         — full-text search across products + variants (tsvector)
   *   categoryId — restrict to a category
   *   locationId — narrow every stock column to one store
   *   includeInactive — '1' to include deactivated products; by default the
   *                     browser lists only what is still sellable (owner
   *                     2026-09-10: the catalog replace retired 733 listings
   *                     and they crowded out the live ones)
   *   limit      — 1..200, default 50
   *   sort / dir — owner 2026-09-11: click a browser column to sort by it.
   *                Any of the STORIS columns (PRODUCT_SORT_KEYS); dir asc|desc.
   *                Every column but the name is derived per row (primary
   *                variant, stock summed across stores), so a sorted browse
   *                materialises the matching products (first 5,000 by name),
   *                sorts the finished rows and pages by offset — the cursor
   *                is then an offset, not a keyset. Unsorted browsing is the
   *                keyset path it always was.
   */
  @Get()
  @RequirePermission('products.view')
  async list(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('vendorId') vendorId?: string,
    @Query('locationId') locationId?: string,
    @Query('includeInactive') includeInactiveStr?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
    @Query('sort') sortRaw?: string,
    @Query('dir') dirRaw?: string,
    // A21 D13 — the STORIS "Search for a Product" criteria.
    @Query('sku') skuQ?: string,
    @Query('name') nameQ?: string,
    @Query('brandId') brandId?: string,
    @Query('vendorModel') vendorModelQ?: string,
    @Query('collectionId') collectionId?: string,
    @Query('group') groupQ?: string,
    @Query('size') sizeQ?: string,
    @Query('firmness') firmnessQ?: string,
    @Query('purchaseStatus') purchaseStatusQ?: string,
    @Query('asIsReasonCodeId') asIsReasonCodeId?: string,
    // Redesign Phase 7 (README §3.3): the stock filter and the price /
    // cost ranges of Advanced search; `sort=available:<locationId>` sorts
    // one store's column.
    @Query('stock') stockQ?: string,
    @Query('priceMin') priceMinQ?: string,
    @Query('priceMax') priceMaxQ?: string,
    @Query('costMin') costMinQ?: string,
    @Query('costMax') costMaxQ?: string,
  ): Promise<PageResponse<ProductListRow>> {
    const limit = clampPageLimit(limitStr);
    const includeInactive = includeInactiveStr === '1' || includeInactiveStr === 'true';
    const storeSort = /^available:([0-9a-f-]{36})$/i.exec(sortRaw ?? '')?.[1] ?? null;
    const sortKey = (PRODUCT_SORT_KEYS as readonly string[]).includes(sortRaw ?? '')
      ? (sortRaw as ProductSortKey)
      : null;
    if (sortRaw && !sortKey && !storeSort) {
      throw new BadRequestException(
        `sort must be one of ${PRODUCT_SORT_KEYS.join(', ')} or available:<locationId>`,
      );
    }
    const dir: 'asc' | 'desc' = dirRaw === 'desc' ? 'desc' : 'asc';
    const sortRows = (rows: ProductListRow[]): ProductListRow[] => {
      if (storeSort) {
        const sign = dir === 'desc' ? -1 : 1;
        return [...rows].sort(
          (a, b) =>
            sign *
              ((a.stockByLocation[storeSort]?.available ?? 0) -
                (b.stockByLocation[storeSort]?.available ?? 0)) || a.name.localeCompare(b.name),
        );
      }
      return sortKey ? sortProductRows(rows, sortKey, dir) : rows;
    };
    const filters: ReturnType<typeof and>[] = [];
    if (!includeInactive) filters.push(eq(schema.products.isActive, true));
    const availAt = sql`(il.on_hand - il.reserved - il.floor_sample)`;
    const levelsOf = sql`FROM inventory_levels il INNER JOIN product_variants v ON v.id = il.variant_id WHERE v.product_id = ${schema.products.id}`;
    if (stockQ === 'anywhere') {
      filters.push(sql`EXISTS (SELECT 1 ${levelsOf} AND ${availAt} > 0)`);
    } else if (stockQ === 'out') {
      filters.push(sql`NOT EXISTS (SELECT 1 ${levelsOf} AND ${availAt} > 0)`);
    } else if (stockQ === 'short') {
      // Short somewhere: a store at zero with units reserved or waiting on
      // an open order, or a store under its own minimum.
      filters.push(
        sql`(EXISTS (SELECT 1 ${levelsOf} AND ((${availAt} <= 0 AND il.reserved > 0) OR (il.reorder_point IS NOT NULL AND ${availAt} < il.reorder_point)))
          OR EXISTS (SELECT 1 FROM order_lines ol INNER JOIN orders o ON o.id = ol.order_id INNER JOIN product_variants v2 ON v2.id = ol.variant_id
            WHERE v2.product_id = ${schema.products.id} AND o.status IN ('open','partially_fulfilled') AND ol.line_type = 'stock'
              AND ol.quantity - ol.qty_reserved - ol.qty_fulfilled > 0))`,
      );
    } else if (stockQ) {
      throw new BadRequestException('stock must be one of anywhere, short, out');
    }
    const cents = (raw: string | undefined, name: string): number | null => {
      if (raw == null || raw === '') return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0)
        throw new BadRequestException(`${name} must be a non-negative integer of cents`);
      return n;
    };
    const priceMin = cents(priceMinQ, 'priceMin');
    const priceMax = cents(priceMaxQ, 'priceMax');
    if (priceMin != null || priceMax != null) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.priceCents} >= ${priceMin ?? 0} AND ${schema.productVariants.priceCents} <= ${priceMax ?? 2_147_483_647})`,
      );
    }
    const costMin = cents(costMinQ, 'costMin');
    const costMax = cents(costMaxQ, 'costMax');
    if (costMin != null || costMax != null) {
      if (!(tenant.isSuperAdmin || tenant.permissions.has('products.cost.view'))) {
        throw new ForbiddenException('Filtering by cost needs product cost access');
      }
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.costCents} IS NOT NULL AND ${schema.productVariants.costCents} >= ${costMin ?? 0} AND ${schema.productVariants.costCents} <= ${costMax ?? 2_147_483_647})`,
      );
    }
    if (categoryId) {
      // A22.1: categories nest — picking "Mattresses" returns the hybrids too.
      const categoryIndex = await loadCategoryIndex(this.db, tenant.businessId!);
      filters.push(inArray(schema.products.categoryId, categoryIndex.treeIds(categoryId)));
    }
    // Vendor (owner 2026-09-02): the vendors page's "products we carry"
    // count opens here. Same rule as the Add Product popup.
    if (vendorId) {
      const match = await vendorMatchFor(this.db, tenant.businessId!, vendorId);
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${schema.productVariants} LEFT JOIN ${schema.brands} ON ${schema.brands.id} = ${schema.products.brandId} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${match})`,
      );
    }
    // A21 D13: each criterion narrows every browse mode below.
    const contains = (v: string) => `%${v.trim()}%`;
    if (skuQ?.trim()) {
      filters.push(
        sql`(${schema.products.sku} ILIKE ${contains(skuQ)} OR EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.sku} ILIKE ${contains(skuQ)}))`,
      );
    }
    if (nameQ?.trim()) {
      filters.push(
        sql`(${schema.products.name} ILIKE ${contains(nameQ)} OR ${schema.products.secondDescription} ILIKE ${contains(nameQ)})`,
      );
    }
    if (brandId) filters.push(eq(schema.products.brandId, brandId));
    if (collectionId) filters.push(eq(schema.products.collectionId, collectionId));
    if (vendorModelQ?.trim()) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.vendorSku} ILIKE ${contains(vendorModelQ)})`,
      );
    }
    if (groupQ?.trim()) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND lower(${schema.productVariants.attributesJson} ->> 'group') = lower(${groupQ.trim()}))`,
      );
    }
    // A22.2: size and firmness are variant columns now — any spelling
    // ("cal king", "California King", "CK") resolves to the canonical one.
    if (sizeQ?.trim()) {
      const size = normalizeSize(sizeQ);
      if (!size) throw new BadRequestException(`size must be one of: ${MATTRESS_SIZES.join(', ')}`);
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.size} = ${size})`,
      );
    }
    if (firmnessQ?.trim()) {
      const firmness = normalizeFirmness(firmnessQ);
      if (!firmness) {
        throw new BadRequestException(`firmness must be one of: ${FIRMNESS_LEVELS.join(', ')}`);
      }
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.firmness} = ${firmness})`,
      );
    }
    if (purchaseStatusQ) {
      if (!(PRODUCT_PURCHASE_STATUSES as readonly string[]).includes(purchaseStatusQ)) {
        throw new BadRequestException(
          `purchaseStatus must be one of ${PRODUCT_PURCHASE_STATUSES.join(', ')}`,
        );
      }
      filters.push(eq(schema.products.purchaseStatus, purchaseStatusQ));
    }
    if (asIsReasonCodeId) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${schema.asIsItems} INNER JOIN ${schema.productVariants} ON ${schema.productVariants.id} = ${schema.asIsItems.variantId} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.asIsItems.status} = 'pending_review' AND ${schema.asIsItems.reasonCodeId} = ${asIsReasonCodeId})`,
      );
    }

    if (q && q.trim().length > 0) {
      // Search returns ts_rank-ordered results — single page, no cursor.
      const tsq = sql`websearch_to_tsquery('simple', ${q})`;
      const data = await this.db
        .select({
          id: schema.products.id,
          sku: schema.products.sku,
          name: schema.products.name,
          isActive: schema.products.isActive,
        })
        .from(schema.products)
        .where(
          and(
            ...filters,
            // Parenthesised: without the brackets the OR binds looser than
            // the AND `and()` puts between the filters, so a variant match
            // would smuggle a row past the active / vendor / category ones.
            // A22.2: the product's words and a variant's words (size,
            // firmness, SKU, barcode) count together, so "queen bamboo
            // sheets" finds the Queen variant of "BAMBOO SHEETS WHITE".
            sql`(${schema.products.searchTsv} @@ ${tsq}
                OR EXISTS (
                  SELECT 1 FROM ${schema.productVariants} v
                  WHERE v.product_id = ${schema.products.id}
                    AND (${schema.products.searchTsv} || v.search_tsv) @@ ${tsq}
                ))`,
          ),
        )
        .orderBy(desc(sql`ts_rank(${schema.products.searchTsv}, ${tsq})`))
        .limit(limit);
      const found = await this.listRows(tenant, data, locationId);
      return { data: sortRows(found), nextCursor: null };
    }

    if (sortKey || storeSort) {
      // Sorted browse: materialise, sort the finished rows, page by offset.
      const offset = offsetFromCursor(cursorStr);
      const all = await this.db
        .select({
          id: schema.products.id,
          sku: schema.products.sku,
          name: schema.products.name,
          isActive: schema.products.isActive,
        })
        .from(schema.products)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(schema.products.name), asc(schema.products.id))
        .limit(SORTED_BROWSE_CAP);
      const sorted = sortRows(await this.listRows(tenant, all, locationId));
      const data = sorted.slice(offset, offset + limit);
      const next = offset + limit;
      return {
        data,
        nextCursor: next < sorted.length ? encodeCursor(next, OFFSET_CURSOR_ID) : null,
      };
    }

    // Default browse: alphabetical by name, with id as the tiebreaker.
    const cursor = decodeCursor(cursorStr);
    if (cursor) {
      filters.push(
        or(
          gt(schema.products.name, cursor.v as string),
          and(eq(schema.products.name, cursor.v as string), gt(schema.products.id, cursor.id)),
        )!,
      );
    }
    const rows = await this.db
      .select({
        id: schema.products.id,
        sku: schema.products.sku,
        name: schema.products.name,
        isActive: schema.products.isActive,
      })
      .from(schema.products)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(schema.products.name), asc(schema.products.id))
      .limit(limit + 1);
    const page = buildPage(rows, limit, (r) => r.name);
    return { ...page, data: await this.listRows(tenant, page.data, locationId) };
  }

  /**
   * The STORIS "Products" columns for a page of products (A19): the
   * primary variant's vendor model / price / cost / group, the brand and
   * vendor names, and stock summed across locations (or one store when
   * `locationId` is given).
   */
  private async listRows(
    tenant: RequestTenantContext,
    rows: { id: string; sku: string | null; name: string; isActive: boolean }[],
    locationId?: string,
  ): Promise<ProductListRow[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const canSeeCost = tenant.isSuperAdmin || tenant.permissions.has('products.cost.view');
    const products = await this.db
      .select({
        id: schema.products.id,
        purchaseStatus: schema.products.purchaseStatus,
        categoryId: schema.products.categoryId,
        brandName: schema.brands.name,
        categoryName: schema.categories.name,
        collectionName: schema.collections.name,
      })
      .from(schema.products)
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
      .leftJoin(schema.collections, eq(schema.collections.id, schema.products.collectionId))
      .where(inArray(schema.products.id, ids));
    const variants = await this.db
      .select({
        productId: schema.productVariants.productId,
        sku: schema.productVariants.sku,
        vendorSku: schema.productVariants.vendorSku,
        priceCents: schema.productVariants.priceCents,
        costCents: schema.productVariants.costCents,
        group: sql<string | null>`${schema.productVariants.attributesJson} ->> 'group'`,
        size: schema.productVariants.size,
        firmness: schema.productVariants.firmness,
        vendorName: schema.vendors.name,
        isActive: schema.productVariants.isActive,
      })
      .from(schema.productVariants)
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.productVariants.preferredVendorId))
      .where(inArray(schema.productVariants.productId, ids))
      .orderBy(asc(schema.productVariants.createdAt));
    const primary = new Map<string, (typeof variants)[number]>();
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const v of variants) {
      const cur = primary.get(v.productId);
      // The variant that carries the product's own SKU wins; else the
      // first active one; else the first.
      const row = rowById.get(v.productId);
      if (!cur || (v.sku && v.sku === row?.sku) || (!cur.isActive && v.isActive)) {
        if (!cur || !(cur.sku && cur.sku === row?.sku)) primary.set(v.productId, v);
      }
    }
    const extra = new Map(products.map((p) => [p.id, p]));
    const categoryIndex = await loadCategoryIndex(this.db, tenant.businessId!);
    const totals = await loadProductStockTotals(this.db, tenant.businessId!, ids, locationId);
    const cells = await loadProductStoreCells(this.db, tenant.businessId!, ids);
    return rows.map((r) => {
      const p = extra.get(r.id);
      const v = primary.get(r.id);
      const t = totals.get(r.id);
      return {
        id: r.id,
        sku: r.sku,
        name: r.name,
        isActive: r.isActive,
        purchaseStatus: p?.purchaseStatus ?? 'active',
        brandName: p?.brandName ?? null,
        categoryName: p?.categoryName ?? null,
        categoryPath: categoryIndex.pathOf(p?.categoryId),
        collectionName: p?.collectionName ?? null,
        vendorName: v?.vendorName ?? null,
        vendorModel: v?.vendorSku ?? null,
        group: v?.group ?? null,
        size: v?.size ?? null,
        firmness: v?.firmness ?? null,
        priceCents: v?.priceCents ?? null,
        costCents: canSeeCost ? (v?.costCents ?? null) : null,
        onHand: t?.onHand ?? 0,
        available: t?.available ?? 0,
        netOnPo: t?.netOnPo ?? 0,
        asIsOnHand: t?.asIsOnHand ?? 0,
        asIsAvailable: t?.asIsAvailable ?? 0,
        asIsNonSellable: t?.asIsNonSellable ?? 0,
        reserved: t?.reserved ?? 0,
        stockByLocation: cells.get(r.id) ?? {},
      };
    });
  }

  /**
   * Same-name products (owner ask 2026-09-02): imports from two systems
   * — and Shopify variants collapsed to one name — leave the register
   * showing the same mattress two or three times. Groups active products
   * by their name and, for each, says what would be lost by retiring it
   * (stock, documents), so the keeper is obvious.
   */
  @Get('duplicates')
  @RequirePermission('products.view')
  async duplicates(@CurrentTenant() tenant: RequestTenantContext): Promise<{
    groups: {
      name: string;
      products: {
        id: string;
        sku: string | null;
        name: string;
        isActive: boolean;
        createdAt: Date;
        priceCents: number | null;
        variants: number;
        onHand: number;
        reserved: number;
        documents: number;
        /** Nothing references it — the DELETE endpoint would accept it. */
        deletable: boolean;
        /** Import batch source that created it ('storis', 'shopify', …); null when built in the app. */
        source: string | null;
        /** Came from a file import (STORIS / CSV) rather than a connector sync or the app. */
        imported: boolean;
      }[];
    }[];
    productCount: number;
  }> {
    const businessId = tenant.businessId!;
    const key = sql`lower(btrim(${schema.products.name}))`;
    const dupNames = await this.db
      .select({ key, n: sql<number>`count(*)::int` })
      .from(schema.products)
      .where(and(eq(schema.products.businessId, businessId), eq(schema.products.isActive, true)))
      .groupBy(key)
      .having(sql`count(*) > 1`)
      .orderBy(desc(sql`count(*)`), key)
      .limit(200);
    if (dupNames.length === 0) return { groups: [], productCount: 0 };
    const keys = dupNames.map((r) => r.key as string);

    const rows = await this.db
      .select({
        id: schema.products.id,
        sku: schema.products.sku,
        name: schema.products.name,
        isActive: schema.products.isActive,
        createdAt: schema.products.createdAt,
        key,
        priceCents: sql<number | null>`min(${schema.productVariants.priceCents})`,
        variants: sql<number>`count(DISTINCT ${schema.productVariants.id})::int`,
        source: sql<
          string | null
        >`(SELECT coalesce(b.source, r.source) FROM legacy_refs r LEFT JOIN import_batches b ON b.id = r.import_batch_id WHERE r.entity = 'product' AND r.jetnine_id = ${schema.products.id} ORDER BY r.created_at ASC LIMIT 1)`,
        onHand: sql<number>`coalesce((SELECT sum(il.on_hand) FROM inventory_levels il JOIN product_variants pv ON pv.id = il.variant_id WHERE pv.product_id = ${schema.products.id}), 0)::int`,
        reserved: sql<number>`coalesce((SELECT sum(il.reserved) FROM inventory_levels il JOIN product_variants pv ON pv.id = il.variant_id WHERE pv.product_id = ${schema.products.id}), 0)::int`,
        documents: sql<number>`(
          (SELECT count(*) FROM order_lines ol JOIN product_variants pv ON pv.id = ol.variant_id WHERE pv.product_id = ${schema.products.id})
          + (SELECT count(*) FROM sale_lines sl JOIN product_variants pv ON pv.id = sl.variant_id WHERE pv.product_id = ${schema.products.id})
          + (SELECT count(*) FROM purchase_order_lines pl JOIN product_variants pv ON pv.id = pl.variant_id WHERE pv.product_id = ${schema.products.id})
          + (SELECT count(*) FROM stock_transfer_lines tl JOIN product_variants pv ON pv.id = tl.variant_id WHERE pv.product_id = ${schema.products.id})
        )::int`,
      })
      .from(schema.products)
      .leftJoin(schema.productVariants, eq(schema.productVariants.productId, schema.products.id))
      .where(
        and(
          eq(schema.products.businessId, businessId),
          eq(schema.products.isActive, true),
          inArray(key, keys),
        ),
      )
      .groupBy(schema.products.id)
      .orderBy(asc(schema.products.createdAt));

    const byKey = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byKey.get(r.key as string) ?? [];
      list.push(r);
      byKey.set(r.key as string, list);
    }
    const groups = keys
      .map((k) => byKey.get(k) ?? [])
      .filter((list) => list.length > 1)
      .map((list) => ({
        name: list[0]!.name,
        products: list.map((r) => ({
          id: r.id,
          sku: r.sku,
          name: r.name,
          isActive: r.isActive,
          createdAt: r.createdAt,
          priceCents: r.priceCents,
          variants: r.variants,
          onHand: r.onHand,
          reserved: r.reserved,
          documents: r.documents,
          deletable: r.onHand === 0 && r.reserved === 0 && r.documents === 0,
          source: r.source,
          imported: isFileImport(r.source),
        })),
      }));
    return { groups, productCount: groups.reduce((n, g) => n + g.products.length, 0) };
  }

  /**
   * "Use the one from the import" (owner 2026-09-02): in every duplicate
   * group that has a file-imported copy (STORIS / CSV), deactivate the
   * copies that came from a connector sync or were built in the app.
   * Deactivate, never delete — history stays and a wrong call is one
   * toggle away from undone. Groups with no imported copy, or with only
   * imported copies, are left alone and reported as skipped.
   */
  @Post('duplicates/keep-imported')
  @RequirePermission('products.update')
  async keepImported(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { names?: string[] },
  ): Promise<{
    deactivated: { id: string; sku: string | null; name: string; source: string | null }[];
    kept: number;
    skippedGroups: number;
  }> {
    const { groups } = await this.duplicates(tenant);
    const wanted = body?.names?.length
      ? new Set(body.names.map((n) => n.trim().toLowerCase()))
      : null;
    const deactivated: { id: string; sku: string | null; name: string; source: string | null }[] =
      [];
    let kept = 0;
    let skippedGroups = 0;
    for (const g of groups) {
      if (wanted && !wanted.has(g.name.trim().toLowerCase())) continue;
      const keepers = g.products.filter((x) => x.imported);
      const others = g.products.filter((x) => !x.imported);
      if (keepers.length === 0 || others.length === 0) {
        skippedGroups += 1;
        continue;
      }
      kept += keepers.length;
      for (const x of others) {
        await this.db
          .update(schema.products)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(eq(schema.products.businessId, tenant.businessId!), eq(schema.products.id, x.id)),
          );
        await this.audit.log({
          action: 'product.update',
          targetType: 'product',
          targetId: x.id,
          before: { isActive: true },
          after: {
            isActive: false,
            reason: 'duplicate — kept the imported copy',
            keptSkus: keepers.map((k) => k.sku),
          },
        });
        deactivated.push({ id: x.id, sku: x.sku, name: x.name, source: x.source });
      }
    }
    return { deactivated, kept, skippedGroups };
  }

  /**
   * A22.2: the values the pickers offer — every STORIS group code, size
   * and firmness this business's variants carry, with counts.
   */
  @Get('facets')
  @RequirePermission('products.view')
  async facets(@CurrentTenant() tenant: RequestTenantContext): Promise<{
    groups: { value: string; count: number }[];
    sizes: { value: string; count: number }[];
    firmness: { value: string; count: number }[];
  }> {
    const businessId = tenant.businessId!;
    const count = sql<number>`count(*)::int`;
    const groupExpr = sql<string>`${schema.productVariants.attributesJson} ->> 'group'`;
    const groups = await this.db
      .select({ value: groupExpr, count })
      .from(schema.productVariants)
      .where(and(eq(schema.productVariants.businessId, businessId), sql`${groupExpr} IS NOT NULL`))
      .groupBy(groupExpr)
      .orderBy(groupExpr);
    const sizes = await this.db
      .select({ value: schema.productVariants.size, count })
      .from(schema.productVariants)
      .where(
        and(
          eq(schema.productVariants.businessId, businessId),
          isNotNull(schema.productVariants.size),
        ),
      )
      .groupBy(schema.productVariants.size);
    const firmness = await this.db
      .select({ value: schema.productVariants.firmness, count })
      .from(schema.productVariants)
      .where(
        and(
          eq(schema.productVariants.businessId, businessId),
          isNotNull(schema.productVariants.firmness),
        ),
      )
      .groupBy(schema.productVariants.firmness);
    const order = (list: readonly string[]) => (a: { value: string }, b: { value: string }) =>
      list.indexOf(a.value) - list.indexOf(b.value);
    return {
      groups: groups.map((g) => ({ value: g.value, count: g.count })),
      sizes: sizes.map((r) => ({ value: r.value!, count: r.count })).sort(order(MATTRESS_SIZES)),
      firmness: firmness
        .map((r) => ({ value: r.value!, count: r.count }))
        .sort(order(FIRMNESS_LEVELS)),
    };
  }

  @Get(':id')
  @RequirePermission('products.view')
  async get(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<ProductOut> {
    const [p] = await this.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .limit(1);
    if (!p) throw new NotFoundException('Product not found');

    const variants = await this.db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.productId, id))
      .orderBy(asc(schema.productVariants.createdAt));
    const images = await this.db
      .select()
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, id))
      .orderBy(asc(schema.productImages.position));

    const canSeeCost = tenant.isSuperAdmin || tenant.permissions.has('products.cost.view');

    const [brand] = p.brandId
      ? await this.db
          .select({ name: schema.brands.name })
          .from(schema.brands)
          .where(eq(schema.brands.id, p.brandId))
          .limit(1)
      : [];
    const [category] = p.categoryId
      ? await this.db
          .select({ name: schema.categories.name })
          .from(schema.categories)
          .where(eq(schema.categories.id, p.categoryId))
          .limit(1)
      : [];
    const [collection] = p.collectionId
      ? await this.db
          .select({ name: schema.collections.name })
          .from(schema.collections)
          .where(eq(schema.collections.id, p.collectionId))
          .limit(1)
      : [];
    const primary =
      variants.find((v) => v.sku && v.sku === p.sku) ??
      variants.find((v) => v.isActive) ??
      variants[0];
    const [vendor] = primary?.preferredVendorId
      ? await this.db
          .select({ name: schema.vendors.name })
          .from(schema.vendors)
          .where(eq(schema.vendors.id, primary.preferredVendorId))
          .limit(1)
      : [];
    const group =
      primary?.attributesJson && typeof primary.attributesJson === 'object'
        ? ((primary.attributesJson as Record<string, unknown>).group ?? null)
        : null;
    const stock = await loadProductStockByLocation(this.db, tenant.businessId!, id);

    return {
      id: p.id,
      sku: p.sku ?? null,
      name: p.name,
      description: p.description ?? null,
      categoryId: p.categoryId ?? null,
      taxClassId: p.taxClassId ?? null,
      brandId: p.brandId ?? null,
      collectionId: p.collectionId ?? null,
      isActive: p.isActive,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      variants: variants.map((v) => ({
        id: v.id,
        sku: v.sku ?? null,
        name: v.name ?? null,
        barcode: v.barcode ?? null,
        priceCents: v.priceCents,
        costCents: canSeeCost ? (v.costCents ?? null) : null,
        attributesJson: v.attributesJson,
        size: v.size ?? null,
        firmness: v.firmness ?? null,
        isActive: v.isActive,
        reorderPoint: v.reorderPoint ?? null,
        reorderQty: v.reorderQty ?? null,
        preferredVendorId: v.preferredVendorId ?? null,
        vendorSku: v.vendorSku ?? null,
      })),
      images: images.map((i) => ({
        id: i.id,
        storageKey: i.storageKey,
        altText: i.altText ?? null,
        position: i.position,
      })),
      serialTracked: p.serialTracked,
      secondDescription: p.secondDescription ?? null,
      purchaseStatus: p.purchaseStatus,
      boxesPerProduct: p.boxesPerProduct,
      logisticalCartonQty: p.logisticalCartonQty,
      purchaseCartonQty: p.purchaseCartonQty,
      logisticalCartonTransfers: p.logisticalCartonTransfers,
      suggestedRetailCents: p.suggestedRetailCents ?? null,
      shipping: parseShipping(p.shippingJson),
      brandName: brand?.name ?? null,
      categoryName: category?.name ?? null,
      categoryPath: p.categoryId
        ? (await loadCategoryIndex(this.db, tenant.businessId!)).pathOf(p.categoryId)
        : null,
      collectionName: collection?.name ?? null,
      vendorName: vendor?.name ?? null,
      vendorModel: primary?.vendorSku ?? null,
      group: typeof group === 'string' ? group : null,
      size: primary?.size ?? null,
      firmness: primary?.firmness ?? null,
      stock,
    };
  }

  @Post()
  @RequirePermission('products.create')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: CreateProductBody,
  ): Promise<ProductOut> {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('name is required');

    const [p] = await this.db
      .insert(schema.products)
      .values({
        businessId: tenant.businessId!,
        name,
        sku: body.sku ?? null,
        description: body.description ?? null,
        categoryId: body.categoryId ?? null,
        taxClassId: body.taxClassId ?? null,
        brandId: body.brandId ?? null,
        collectionId: body.collectionId ?? null,
      })
      .returning()
      .catch((err) => {
        if (err instanceof Error && err.message.includes('products_business_sku_uniq')) {
          throw new ConflictException(`SKU "${body.sku}" already exists in this business`);
        }
        throw err;
      });
    if (!p) throw new BadRequestException('failed to create product');

    if (body.variants && body.variants.length > 0) {
      validateVariants(body.variants);
      await this.db.insert(schema.productVariants).values(
        body.variants.map((v) => ({
          businessId: tenant.businessId!,
          productId: p.id,
          sku: v.sku ?? null,
          name: v.name ?? null,
          priceCents: v.priceCents,
          costCents: v.costCents ?? null,
          barcode: v.barcode ?? null,
          attributesJson: (v.attributesJson ?? null) as never,
          ...deriveVariantSizing(v, p.name),
        })),
      );
    }

    await this.audit.log({
      action: 'product.create',
      targetType: 'product',
      targetId: p.id,
      after: {
        name: p.name,
        sku: p.sku,
        variantCount: body.variants?.length ?? 0,
      },
    });

    return this.get(tenant, p.id);
  }

  @Patch(':id')
  @RequirePermission('products.update')
  async update(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: UpdateProductBody,
  ): Promise<ProductOut> {
    const [existing] = await this.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Product not found');

    const update: Partial<typeof schema.products.$inferInsert> = { updatedAt: new Date() };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (body.name !== undefined && body.name.trim() !== existing.name) {
      update.name = body.name.trim();
      before.name = existing.name;
      after.name = update.name;
    }
    if (body.sku !== undefined && body.sku !== existing.sku) {
      update.sku = body.sku;
      before.sku = existing.sku;
      after.sku = body.sku;
    }
    if (body.description !== undefined && body.description !== existing.description) {
      update.description = body.description;
      before.description = existing.description;
      after.description = body.description;
    }
    if (body.categoryId !== undefined && body.categoryId !== existing.categoryId) {
      update.categoryId = body.categoryId;
      before.categoryId = existing.categoryId;
      after.categoryId = body.categoryId;
    }
    if (body.taxClassId !== undefined && body.taxClassId !== existing.taxClassId) {
      update.taxClassId = body.taxClassId;
      before.taxClassId = existing.taxClassId;
      after.taxClassId = body.taxClassId;
    }
    if (body.brandId !== undefined && body.brandId !== existing.brandId) {
      update.brandId = body.brandId;
      before.brandId = existing.brandId;
      after.brandId = body.brandId;
    }
    if (body.collectionId !== undefined && body.collectionId !== existing.collectionId) {
      update.collectionId = body.collectionId;
      before.collectionId = existing.collectionId;
      after.collectionId = body.collectionId;
    }
    if (body.serialTracked !== undefined && body.serialTracked !== existing.serialTracked) {
      update.serialTracked = body.serialTracked;
      before.serialTracked = existing.serialTracked;
      after.serialTracked = body.serialTracked;
    }
    if (body.isActive !== undefined && body.isActive !== existing.isActive) {
      update.isActive = body.isActive;
      before.isActive = existing.isActive;
      after.isActive = body.isActive;
    }
    // STORIS Advanced Product Settings (A19).
    if (body.secondDescription !== undefined) {
      const next = body.secondDescription?.trim() || null;
      if (next !== existing.secondDescription) {
        update.secondDescription = next;
        before.secondDescription = existing.secondDescription;
        after.secondDescription = next;
      }
    }
    if (body.purchaseStatus !== undefined && body.purchaseStatus !== existing.purchaseStatus) {
      if (!PRODUCT_PURCHASE_STATUSES.includes(body.purchaseStatus)) {
        throw new BadRequestException(
          `purchaseStatus must be one of ${PRODUCT_PURCHASE_STATUSES.join(', ')}`,
        );
      }
      update.purchaseStatus = body.purchaseStatus;
      before.purchaseStatus = existing.purchaseStatus;
      after.purchaseStatus = body.purchaseStatus;
    }
    for (const key of ['boxesPerProduct', 'logisticalCartonQty', 'purchaseCartonQty'] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1) {
        throw new BadRequestException(`${key} must be a whole number of 1 or more`);
      }
      if (value !== existing[key]) {
        update[key] = value;
        before[key] = existing[key];
        after[key] = value;
      }
    }
    if (
      body.logisticalCartonTransfers !== undefined &&
      body.logisticalCartonTransfers !== existing.logisticalCartonTransfers
    ) {
      update.logisticalCartonTransfers = body.logisticalCartonTransfers;
      before.logisticalCartonTransfers = existing.logisticalCartonTransfers;
      after.logisticalCartonTransfers = body.logisticalCartonTransfers;
    }
    // A21 General Information (D9).
    if (body.suggestedRetailCents !== undefined) {
      const next = body.suggestedRetailCents;
      if (next !== null && (!Number.isInteger(next) || next < 0)) {
        throw new BadRequestException('suggestedRetailCents must be a whole number of cents ≥ 0');
      }
      if (next !== (existing.suggestedRetailCents ?? null)) {
        update.suggestedRetailCents = next;
        before.suggestedRetailCents = existing.suggestedRetailCents ?? null;
        after.suggestedRetailCents = next;
      }
    }
    if (body.shipping !== undefined) {
      const current = parseShipping(existing.shippingJson);
      const { next, bad } = mergeShipping(current, body.shipping);
      if (bad) throw new BadRequestException(bad);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        update.shippingJson = next;
        before.shipping = current;
        after.shipping = next;
      }
    }

    if (Object.keys(after).length > 0) {
      await this.db.update(schema.products).set(update).where(eq(schema.products.id, id));
      await this.audit.log({
        action: 'product.update',
        targetType: 'product',
        targetId: id,
        before,
        after,
      });
    }

    return this.get(tenant, id);
  }

  /**
   * Hard-delete a product and all its variants (owner ask 2026-08-30:
   * "I need to be able to delete a product completely"). Only a product
   * with zero stock and no document history qualifies — one that has
   * sold, been ordered or transferred, been written off, or sits in
   * as-is review is refused with the reason, because deleting it would
   * gut those documents; deactivating hides it from selling while the
   * paperwork keeps its meaning. Inventory levels, cost layers, serial
   * rows, physical-inventory rows, and images ride the FK cascades.
   */
  @Delete(':id')
  @RequirePermission('products.delete')
  async remove(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ deleted: true }> {
    const [product] = await this.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .limit(1);
    if (!product) throw new NotFoundException('Product not found');

    const variantRows = await this.db
      .select({ id: schema.productVariants.id })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.productId, id));
    const variantIds = variantRows.map((v) => v.id);

    if (variantIds.length > 0) {
      const [stock] = await this.db
        .select({
          onHand: sql<number>`coalesce(sum(${schema.inventoryLevels.onHand}), 0)::int`,
          reserved: sql<number>`coalesce(sum(${schema.inventoryLevels.reserved}), 0)::int`,
        })
        .from(schema.inventoryLevels)
        .where(inArray(schema.inventoryLevels.variantId, variantIds));
      if ((stock?.onHand ?? 0) !== 0 || (stock?.reserved ?? 0) !== 0) {
        throw new BadRequestException(
          `Cannot delete "${product.name}" — it still has ${stock!.onHand} on hand and ` +
            `${stock!.reserved} reserved. Zero the stock out first (adjust or transfer it), ` +
            'or deactivate the product instead.',
        );
      }

      const refTables = [
        ['order lines', schema.orderLines.variantId, schema.orderLines],
        ['sales receipt lines', schema.saleLines.variantId, schema.saleLines],
        ['purchase order lines', schema.purchaseOrderLines.variantId, schema.purchaseOrderLines],
        ['transfer lines', schema.stockTransferLines.variantId, schema.stockTransferLines],
        ['as-is pieces', schema.asIsItems.variantId, schema.asIsItems],
        ['write-offs', schema.writeOffs.variantId, schema.writeOffs],
      ] as const;
      const blockers: string[] = [];
      for (const [label, column, table] of refTables) {
        const [row] = await this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(table)
          .where(inArray(column, variantIds));
        if ((row?.n ?? 0) > 0) blockers.push(`${row!.n} ${label}`);
      }
      if (blockers.length > 0) {
        throw new BadRequestException(
          `Cannot delete "${product.name}" — it appears on ${blockers.join(', ')}. ` +
            'Deactivate it instead so those documents keep their history.',
        );
      }
    }

    await this.db.delete(schema.products).where(eq(schema.products.id, id));
    await this.audit.log({
      action: 'product.delete',
      targetType: 'product',
      targetId: id,
      before: { name: product.name, sku: product.sku, variantCount: variantIds.length },
      after: null,
    });
    return { deleted: true };
  }

  /**
   * Reorder automation settings for one variant. Explicit null clears a
   * field; a variant with a null reorderPoint is not managed.
   */
  @Patch('variants/:variantId/reorder')
  @RequirePermission('products.update')
  async updateReorder(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('variantId') variantId: string,
    @Body()
    body: {
      reorderPoint?: number | null;
      reorderQty?: number | null;
      preferredVendorId?: string | null;
      vendorSku?: string | null;
    },
  ): Promise<{
    id: string;
    reorderPoint: number | null;
    reorderQty: number | null;
    preferredVendorId: string | null;
    vendorSku: string | null;
  }> {
    const [variant] = await this.db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId))
      .limit(1);
    if (!variant) throw new NotFoundException('Variant not found');

    const update: Partial<typeof schema.productVariants.$inferInsert> = {};
    for (const key of ['reorderPoint', 'reorderQty'] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (value !== null && (!Number.isInteger(value) || value < 0)) {
        throw new BadRequestException(`${key} must be a non-negative integer or null`);
      }
      update[key] = value;
    }
    if (body.preferredVendorId !== undefined) {
      if (body.preferredVendorId !== null) {
        const [vendor] = await this.db
          .select({ id: schema.vendors.id })
          .from(schema.vendors)
          .where(eq(schema.vendors.id, body.preferredVendorId))
          .limit(1);
        if (!vendor) throw new NotFoundException('Vendor not found');
      }
      update.preferredVendorId = body.preferredVendorId;
    }
    if (body.vendorSku !== undefined) {
      if (body.vendorSku !== null) {
        const trimmed = body.vendorSku.trim();
        if (trimmed.length === 0 || trimmed.length > 100) {
          throw new BadRequestException('vendorSku must be 1–100 characters or null');
        }
        update.vendorSku = trimmed;
      } else {
        update.vendorSku = null;
      }
    }
    if (Object.keys(update).length > 0) {
      await this.db
        .update(schema.productVariants)
        .set(update)
        .where(eq(schema.productVariants.id, variantId));
      await this.audit.log({
        action: 'product.variant.reorder_settings',
        targetType: 'product_variant',
        targetId: variantId,
        before: {
          reorderPoint: variant.reorderPoint,
          reorderQty: variant.reorderQty,
          preferredVendorId: variant.preferredVendorId,
          vendorSku: variant.vendorSku,
        },
        after: update,
      });
    }
    const [updated] = await this.db
      .select({
        id: schema.productVariants.id,
        reorderPoint: schema.productVariants.reorderPoint,
        reorderQty: schema.productVariants.reorderQty,
        preferredVendorId: schema.productVariants.preferredVendorId,
        vendorSku: schema.productVariants.vendorSku,
      })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId))
      .limit(1);
    return updated!;
  }

  @Delete(':id')
  @RequirePermission('products.delete')
  async delete(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ deactivated: true }> {
    const [existing] = await this.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Product not found');
    if (!existing.isActive) return { deactivated: true };
    await this.db
      .update(schema.products)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(schema.products.id, id));
    await this.audit.log({
      action: 'product.deactivate',
      targetType: 'product',
      targetId: id,
      before: { isActive: true },
      after: { isActive: false },
    });
    return { deactivated: true };
  }
}

export function validateVariants(variants: VariantInput[]): void {
  for (const v of variants) {
    if (!Number.isInteger(v.priceCents) || v.priceCents < 0) {
      throw new BadRequestException('variants[].priceCents must be a non-negative integer');
    }
    if (v.costCents != null && (!Number.isInteger(v.costCents) || v.costCents < 0)) {
      throw new BadRequestException('variants[].costCents must be a non-negative integer or null');
    }
  }
}
