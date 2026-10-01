/**
 * Which register lines get the Removal / Recycling / Declined foundation
 * chips (README §3.1: "toggles on mattress/base lines").
 *
 * Owner 2026-09-12: the chips never showed on real products. STORIS names
 * read "E KING MICAH FIRM" or "QUEEN PROADAPT 2.0 MEDIUM" — no "mattress"
 * in them — so a name regex missed every one. The catalog's category is
 * the truth; the name is only a fallback for lines that have no category,
 * such as custom lines or drafts written before this.
 *
 * Owner 2026-09-13: the A22.1 tree files almost every sleep surface on a
 * subcategory ("Mattresses › Hybrid", "Adjustable Bases › Adjustable Bed
 * Bases", "Foundations & Box Springs › Low Profile (4–5")"), so the rule
 * reads the path's root, not the leaf. Base accessories and parts (remotes,
 * legs) sit under Adjustable Bases but are not a base — no chips.
 *
 * Owner 2026-10-01: the X-Plat needs a recycling fee. Platform bed bases
 * ("Bed Frames › Platform & Folding Frames" — X-Plat, Highrise, hotel bed
 * base) stand in for a foundation, so they get the chips too; ordinary
 * metal frames and frame parts do not.
 */
export const CATEGORY_PATH_SEPARATOR = ' › ';
const ADDON_ROOTS = /^(mattresses|adjustable bases|foundations & box springs)$/i;
const NOT_ADDON_LEAVES = /accessor|part/i;
const PLATFORM_ROOT = /^bed frames$/i;
const PLATFORM_LEAF = /platform/i;
/** Uncategorized platform bases, named like "QUEEN X-PLAT BED FRAME". */
const PLATFORM_NAMES = /x-?plat|platform|bed base/i;
const ADDON_NAMES =
  /mattress|foundation|box ?spring|adjustable|\bbase\b|hybrid|posturepedic|tempur/i;
/** Names that match the fallback but are accessories, never a sleep surface. */
const NOT_ADDON_NAMES = /protector|encasement|cover|pad|topper|pillow|sheet|frame/i;

export function lineHasAddons(line: {
  /** Catalog category path ("Mattresses › Hybrid"); a bare name is a root. */
  categoryPath?: string | null;
  description: string;
  lineType?: string;
}): boolean {
  if (line.lineType === 'custom') return false;
  if (line.categoryPath) {
    const segments = line.categoryPath.split(CATEGORY_PATH_SEPARATOR).map((s) => s.trim());
    const root = segments[0] ?? '';
    const leaf = segments[segments.length - 1] ?? '';
    if (PLATFORM_ROOT.test(root)) return segments.length > 1 && PLATFORM_LEAF.test(leaf);
    if (!ADDON_ROOTS.test(root)) return false;
    return segments.length === 1 || !NOT_ADDON_LEAVES.test(leaf);
  }
  if (PLATFORM_NAMES.test(line.description)) return true;
  return ADDON_NAMES.test(line.description) && !NOT_ADDON_NAMES.test(line.description);
}
