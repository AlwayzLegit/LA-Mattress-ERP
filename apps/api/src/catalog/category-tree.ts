import { eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';

/**
 * One read of a business's categories, answering the questions every
 * surface asks now that categories nest (A22.1, `docs/imports/2026-09-11/
 * product-categories.csv`): the full path of a category ("Mattresses ›
 * Hybrid"), every id under a category (so filtering by "Mattresses"
 * returns the hybrids too), and the ids from a category up to its root
 * (so a rule set on "Mattresses" applies to the hybrids too).
 */
export interface CategoryIndex {
  pathOf(id: string | null | undefined): string | null;
  /** The category itself plus every descendant. */
  treeIds(id: string): string[];
  /** The category itself first, then its parent, then the root. */
  lineageOf(id: string | null | undefined): string[];
  /** The top-level ancestor's name ("Mattresses" for "Mattresses › Hybrid"). */
  rootNameOf(id: string | null | undefined): string | null;
}

export const CATEGORY_PATH_SEPARATOR = ' › ';

export async function loadCategoryIndex(
  db: PostgresJsDatabase,
  businessId: string,
): Promise<CategoryIndex> {
  const rows = await db
    .select({
      id: schema.categories.id,
      parentId: schema.categories.parentId,
      name: schema.categories.name,
    })
    .from(schema.categories)
    .where(eq(schema.categories.businessId, businessId));
  return buildCategoryIndex(rows);
}

export function buildCategoryIndex(
  rows: { id: string; parentId: string | null; name: string }[],
): CategoryIndex {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const list = childrenOf.get(r.parentId) ?? [];
    list.push(r.id);
    childrenOf.set(r.parentId, list);
  }
  const chain = (id: string | null | undefined) => {
    const out: { id: string; name: string }[] = [];
    let cursor: string | null | undefined = id;
    let hops = 0;
    while (cursor && hops < 8) {
      const row = byId.get(cursor);
      if (!row) break;
      out.push({ id: row.id, name: row.name });
      cursor = row.parentId;
      hops += 1;
    }
    return out; // leaf first
  };
  return {
    pathOf(id) {
      const names = chain(id)
        .map((c) => c.name)
        .reverse();
      return names.length > 0 ? names.join(CATEGORY_PATH_SEPARATOR) : null;
    },
    treeIds(id) {
      const out: string[] = [];
      const stack = [id];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        out.push(cur);
        for (const child of childrenOf.get(cur) ?? []) stack.push(child);
      }
      return out;
    },
    lineageOf(id) {
      return chain(id).map((c) => c.id);
    },
    rootNameOf(id) {
      const c = chain(id);
      return c.length > 0 ? c[c.length - 1]!.name : null;
    },
  };
}

/**
 * The same path computed in SQL, for list queries that sort or group by
 * category and for the report builder. Join with `joinCategoryPath` (the
 * query must already left-join `schema.categories` on the product's
 * `category_id`) and select `categoryPathSql`. Categories nest at
 * most three deep (`categories.controller.ts`), so two self-joins cover
 * every ancestor.
 */
export const categoryParent = alias(schema.categories, 'category_parent');
export const categoryGrandparent = alias(schema.categories, 'category_grandparent');

export const categoryPathSql: SQL<string | null> = sql<
  string | null
>`NULLIF(CONCAT_WS(${CATEGORY_PATH_SEPARATOR}, ${categoryGrandparent.name}, ${categoryParent.name}, ${schema.categories.name}), '')`;

/** The top-level ancestor's name in SQL (the root of the path). */
export const categoryRootNameSql: SQL<string | null> = sql<
  string | null
>`COALESCE(${categoryGrandparent.name}, ${categoryParent.name}, ${schema.categories.name})`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function joinCategoryPath<Q extends { leftJoin: (...args: any[]) => any }>(q: Q): Q {
  return q
    .leftJoin(categoryParent, eq(categoryParent.id, schema.categories.parentId))
    .leftJoin(categoryGrandparent, eq(categoryGrandparent.id, categoryParent.parentId)) as Q;
}
