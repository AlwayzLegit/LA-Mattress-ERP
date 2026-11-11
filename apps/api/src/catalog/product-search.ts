import { sql, type SQL } from 'drizzle-orm';
import { schema } from '@jetnine/db';

/**
 * Catalog text search (owner 2026-11-10): a partly typed word or SKU must
 * find the product — "univer" finds UNIVERSAL, "tempur" finds TEMPURPEDIC,
 * "8246" finds 8246-3/3. `websearch_to_tsquery` matched whole tokens only,
 * so a word was found exactly when it was finished.
 *
 * Two predicates, OR-ed:
 *  - every word of the query as a prefix of some token in the product's (or
 *    a variant's) search vector — `to_tsquery('simple', 'univer:* & blk:*')`;
 *  - the query as a plain substring of the SKUs, barcode and vendor model,
 *    so a run of digits inside a punctuated SKU ("246-3") still hits.
 */

/** Lower-cased runs of letters and digits, at most eight. */
export function searchWords(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
}

/** `to_tsquery('simple', 'a:* & b:*')`, or null when the query has no words. */
export function prefixTsQuery(q: string): SQL | null {
  const words = searchWords(q);
  if (words.length === 0) return null;
  return sql`to_tsquery('simple', ${words.map((w) => `${w}:*`).join(' & ')})`;
}

/** `%q%` with the LIKE wildcards escaped, for a substring match. */
export function likePattern(q: string): string {
  return `%${q.trim().replace(/[\%_]/g, '\$&')}%`;
}

/**
 * Match on the `products` table: the product's own words, or the product's
 * and one variant's words together (A22.2: "queen bamboo sheets" finds the
 * Queen variant of BAMBOO SHEETS WHITE), or a SKU / barcode / vendor model
 * containing the query. Parenthesised so it ANDs cleanly with other filters.
 */
export function productSearchCond(q: string): SQL {
  const tsq = prefixTsQuery(q);
  const like = likePattern(q);
  const p = schema.products;
  const tsPart = tsq
    ? sql`${p.searchTsv} @@ ${tsq}
        OR EXISTS (
          SELECT 1 FROM ${schema.productVariants} v
          WHERE v.product_id = ${p.id}
            AND (${p.searchTsv} || v.search_tsv) @@ ${tsq}
        )`
    : sql`false`;
  return sql`(${tsPart}
      OR ${p.sku} ILIKE ${like}
      OR EXISTS (
        SELECT 1 FROM ${schema.productVariants} v
        WHERE v.product_id = ${p.id}
          AND (v.sku ILIKE ${like} OR v.barcode ILIKE ${like} OR v.vendor_sku ILIKE ${like})
      ))`;
}

/**
 * Match for a query joined to `product_variants` and `products`: the row's
 * own variant counts with its product, not any sibling.
 */
export function variantSearchCond(q: string): SQL {
  const tsq = prefixTsQuery(q);
  const like = likePattern(q);
  const p = schema.products;
  const v = schema.productVariants;
  const tsPart = tsq
    ? sql`(coalesce(${p.searchTsv}, ''::tsvector) || coalesce(${v.searchTsv}, ''::tsvector)) @@ ${tsq}`
    : sql`false`;
  return sql`(${tsPart}
      OR ${p.sku} ILIKE ${like}
      OR ${v.sku} ILIKE ${like}
      OR ${v.barcode} ILIKE ${like}
      OR ${v.vendorSku} ILIKE ${like})`;
}
