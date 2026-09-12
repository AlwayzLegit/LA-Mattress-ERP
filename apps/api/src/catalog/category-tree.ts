import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';

/**
 * One read of a business's categories, answering the two questions the
 * product browser asks now that categories nest (A22.1): the full path of
 * a category ("Mattresses › Hybrid") and every id under a category, so
 * filtering by "Mattresses" returns the hybrids too.
 */
export interface CategoryIndex {
  pathOf(id: string | null | undefined): string | null;
  /** The category itself plus every descendant. */
  treeIds(id: string): string[];
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
  return {
    pathOf(id) {
      if (!id) return null;
      const names: string[] = [];
      let cursor: string | null | undefined = id;
      let hops = 0;
      while (cursor && hops < 8) {
        const row = byId.get(cursor);
        if (!row) break;
        names.unshift(row.name);
        cursor = row.parentId;
        hops += 1;
      }
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
  };
}
