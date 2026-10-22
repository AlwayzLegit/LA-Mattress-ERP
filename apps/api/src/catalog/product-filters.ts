import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import {
  FIRMNESS_LEVELS,
  MATTRESS_SIZES,
  normalizeFirmness,
  normalizeSize,
  PRODUCT_PURCHASE_STATUSES,
} from '@jetnine/shared';
import { vendorMatchFor } from '../common/vendor-match';
import type { RequestTenantContext } from '../tenancy/request-context';
import { loadCategoryIndex } from './category-tree';

/**
 * The Products browser's filter set (A21 D13 criteria, the Phase 7 stock
 * filter and price / cost ranges), as query-string values. Shared by the
 * products list and Stock by location (owner 2026-10-21: "the same
 * search filters on Stock by Location that are on the Products tab"), so
 * a filter means one thing on both screens.
 */
export interface ProductFilterQuery {
  includeInactive?: string;
  categoryId?: string;
  vendorId?: string;
  sku?: string;
  name?: string;
  brandId?: string;
  vendorModel?: string;
  collectionId?: string;
  group?: string;
  size?: string;
  firmness?: string;
  purchaseStatus?: string;
  asIsReasonCodeId?: string;
  /** anywhere | short | out */
  stock?: string;
  priceMin?: string;
  priceMax?: string;
  costMin?: string;
  costMax?: string;
}

export function parseIncludeInactive(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * WHERE fragments on `products` for one filter set. Every fragment is an
 * expression on the products row (variant criteria go through EXISTS), so
 * any query that selects from or joins `products` can AND them in.
 */
export async function productFilters(
  db: PostgresJsDatabase,
  tenant: RequestTenantContext,
  q: ProductFilterQuery,
): Promise<SQL[]> {
  const filters: SQL[] = [];
  if (!parseIncludeInactive(q.includeInactive)) filters.push(eq(schema.products.isActive, true));
  const availAt = sql`(il.on_hand - il.reserved - il.floor_sample)`;
  const levelsOf = sql`FROM inventory_levels il INNER JOIN product_variants v ON v.id = il.variant_id WHERE v.product_id = ${schema.products.id}`;
  if (q.stock === 'anywhere') {
    filters.push(sql`EXISTS (SELECT 1 ${levelsOf} AND ${availAt} > 0)`);
  } else if (q.stock === 'out') {
    filters.push(sql`NOT EXISTS (SELECT 1 ${levelsOf} AND ${availAt} > 0)`);
  } else if (q.stock === 'short') {
    // Short somewhere: a store at zero with units reserved or waiting on
    // an open order, or a store under its own minimum.
    filters.push(
      sql`(EXISTS (SELECT 1 ${levelsOf} AND ((${availAt} <= 0 AND il.reserved > 0) OR (il.reorder_point IS NOT NULL AND ${availAt} < il.reorder_point)))
        OR EXISTS (SELECT 1 FROM order_lines ol INNER JOIN orders o ON o.id = ol.order_id INNER JOIN product_variants v2 ON v2.id = ol.variant_id
          WHERE v2.product_id = ${schema.products.id} AND o.status IN ('open','partially_fulfilled') AND ol.line_type = 'stock'
            AND ol.quantity - ol.qty_reserved - ol.qty_fulfilled > 0))`,
    );
  } else if (q.stock) {
    throw new BadRequestException('stock must be one of anywhere, short, out');
  }
  const cents = (raw: string | undefined, name: string): number | null => {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0)
      throw new BadRequestException(`${name} must be a non-negative integer of cents`);
    return n;
  };
  const priceMin = cents(q.priceMin, 'priceMin');
  const priceMax = cents(q.priceMax, 'priceMax');
  if (priceMin != null || priceMax != null) {
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.priceCents} >= ${priceMin ?? 0} AND ${schema.productVariants.priceCents} <= ${priceMax ?? 2_147_483_647})`,
    );
  }
  const costMin = cents(q.costMin, 'costMin');
  const costMax = cents(q.costMax, 'costMax');
  if (costMin != null || costMax != null) {
    if (!(tenant.isSuperAdmin || tenant.permissions.has('products.cost.view'))) {
      throw new ForbiddenException('Filtering by cost needs product cost access');
    }
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.costCents} IS NOT NULL AND ${schema.productVariants.costCents} >= ${costMin ?? 0} AND ${schema.productVariants.costCents} <= ${costMax ?? 2_147_483_647})`,
    );
  }
  if (q.categoryId) {
    // A22.1: categories nest — picking "Mattresses" returns the hybrids too.
    const categoryIndex = await loadCategoryIndex(db, tenant.businessId!);
    filters.push(inArray(schema.products.categoryId, categoryIndex.treeIds(q.categoryId)));
  }
  // Vendor (owner 2026-09-02): the vendors page's "products we carry"
  // count opens here. Same rule as the Add Product popup.
  if (q.vendorId) {
    const match = await vendorMatchFor(db, tenant.businessId!, q.vendorId);
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${schema.productVariants} LEFT JOIN ${schema.brands} ON ${schema.brands.id} = ${schema.products.brandId} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${match})`,
    );
  }
  // A21 D13: each criterion narrows every browse mode.
  const contains = (v: string) => `%${v.trim()}%`;
  if (q.sku?.trim()) {
    filters.push(
      sql`(${schema.products.sku} ILIKE ${contains(q.sku)} OR EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.sku} ILIKE ${contains(q.sku)}))`,
    );
  }
  if (q.name?.trim()) {
    filters.push(
      sql`(${schema.products.name} ILIKE ${contains(q.name)} OR ${schema.products.secondDescription} ILIKE ${contains(q.name)})`,
    );
  }
  if (q.brandId) filters.push(eq(schema.products.brandId, q.brandId));
  if (q.collectionId) filters.push(eq(schema.products.collectionId, q.collectionId));
  if (q.vendorModel?.trim()) {
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.vendorSku} ILIKE ${contains(q.vendorModel)})`,
    );
  }
  if (q.group?.trim()) {
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND lower(${schema.productVariants.attributesJson} ->> 'group') = lower(${q.group.trim()}))`,
    );
  }
  // A22.2: size and firmness are variant columns — any spelling ("cal
  // king", "California King", "CK") resolves to the canonical one.
  if (q.size?.trim()) {
    const size = normalizeSize(q.size);
    if (!size) throw new BadRequestException(`size must be one of: ${MATTRESS_SIZES.join(', ')}`);
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.size} = ${size})`,
    );
  }
  if (q.firmness?.trim()) {
    const firmness = normalizeFirmness(q.firmness);
    if (!firmness) {
      throw new BadRequestException(`firmness must be one of: ${FIRMNESS_LEVELS.join(', ')}`);
    }
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${schema.productVariants} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.productVariants.firmness} = ${firmness})`,
    );
  }
  if (q.purchaseStatus) {
    if (!(PRODUCT_PURCHASE_STATUSES as readonly string[]).includes(q.purchaseStatus)) {
      throw new BadRequestException(
        `purchaseStatus must be one of ${PRODUCT_PURCHASE_STATUSES.join(', ')}`,
      );
    }
    filters.push(eq(schema.products.purchaseStatus, q.purchaseStatus));
  }
  if (q.asIsReasonCodeId) {
    filters.push(
      sql`EXISTS (SELECT 1 FROM ${schema.asIsItems} INNER JOIN ${schema.productVariants} ON ${schema.productVariants.id} = ${schema.asIsItems.variantId} WHERE ${schema.productVariants.productId} = ${schema.products.id} AND ${schema.asIsItems.status} = 'pending_review' AND ${schema.asIsItems.reasonCodeId} = ${q.asIsReasonCodeId})`,
    );
  }
  return filters;
}
