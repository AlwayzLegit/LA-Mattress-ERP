import { CATEGORY_PATH_SEPARATOR } from '../catalog/category-tree';

/**
 * G6 (§5): which order lines carry the CA mattress recycling fee. The
 * catalog category decides (A22.1 tree, `docs/imports/2026-09-11/
 * product-categories.csv`): anything filed under Mattresses, Foundations &
 * Box Springs, or Adjustable Bases qualifies, except the remotes, legs and
 * brackets under "Base Accessories & Parts". A line without a category
 * (legacy or free-typed) falls back to its description, as before.
 * Mirrors the register's add-on chip rule (`apps/web/src/lib/pos-addons.ts`).
 */
const RECYCLING_ROOTS = /^(mattresses|adjustable bases|foundations & box springs)$/i;
const NOT_RECYCLING_LEAVES = /accessor|part/i;
const RECYCLING_KEYWORDS = /mattress|foundation|adjustable base|box spring/i;

export function qualifiesForRecyclingFee(line: {
  categoryPath?: string | null;
  description: string;
  lineType?: string | null;
}): boolean {
  if (line.lineType === 'custom') return false;
  if (line.categoryPath) {
    const segments = line.categoryPath.split(CATEGORY_PATH_SEPARATOR).map((s) => s.trim());
    const root = segments[0] ?? '';
    const leaf = segments[segments.length - 1] ?? '';
    if (!RECYCLING_ROOTS.test(root)) return false;
    return segments.length === 1 || !NOT_RECYCLING_LEAVES.test(leaf);
  }
  return RECYCLING_KEYWORDS.test(line.description);
}
