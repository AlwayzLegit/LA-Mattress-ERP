/**
 * The catalog category tree as every picker and column reads it (A22.1,
 * `docs/imports/2026-09-11/product-categories.csv`): two levels, joined
 * with " › ", e.g. "Mattresses › Hybrid". `GET /v1/categories` returns
 * `{ flat, tree }`; older stubs return the flat list bare.
 */
export const CATEGORY_PATH_SEPARATOR = ' › ';

export interface CategoryFlat {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
}

export interface CategoryOption {
  id: string;
  /** The full path, "Mattresses › Hybrid". */
  name: string;
  depth: number;
}

/** Accepts either response shape. */
export function categoryList(res: CategoryFlat[] | { flat: CategoryFlat[] }): CategoryFlat[] {
  return Array.isArray(res) ? res : (res.flat ?? []);
}

/** Options in tree order, each labelled with its full path. */
export function categoryOptions(flat: CategoryFlat[]): CategoryOption[] {
  const byParent = new Map<string | null, CategoryFlat[]>();
  for (const c of flat) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const out: CategoryOption[] = [];
  const walk = (parentId: string | null, prefix: string, depth: number) => {
    const kids = [...(byParent.get(parentId) ?? [])].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    for (const c of kids) {
      const label = prefix ? `${prefix}${CATEGORY_PATH_SEPARATOR}${c.name}` : c.name;
      out.push({ id: c.id, name: label, depth });
      walk(c.id, label, depth + 1);
    }
  };
  walk(null, '', 0);
  return out;
}
