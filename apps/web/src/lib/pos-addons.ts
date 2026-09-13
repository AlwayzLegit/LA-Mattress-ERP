/**
 * Which register lines get the Removal / Recycling / Declined foundation
 * chips (README §3.1: "toggles on mattress/base lines").
 *
 * Owner 2026-09-12: the chips never showed on real products. STORIS names
 * read "E KING MICAH FIRM" or "QUEEN PROADAPT 2.0 MEDIUM" — no "mattress"
 * in them — so a name regex missed every one. The catalog's category is
 * the truth (A22.1 tree); the name is only a fallback for lines that have
 * no category, such as custom lines or drafts written before this.
 */
const ADDON_CATEGORIES = /^(mattresses|adjustable bases|foundations & box springs)$/i;
const ADDON_NAMES =
  /mattress|foundation|box ?spring|adjustable|\bbase\b|hybrid|posturepedic|tempur/i;
/** Names that match the fallback but are accessories, never a sleep surface. */
const NOT_ADDON_NAMES = /protector|encasement|cover|pad|topper|pillow|sheet|frame/i;

export function lineHasAddons(line: {
  categoryName?: string | null;
  description: string;
  lineType?: string;
}): boolean {
  if (line.lineType === 'custom') return false;
  if (line.categoryName) return ADDON_CATEGORIES.test(line.categoryName.trim());
  return ADDON_NAMES.test(line.description) && !NOT_ADDON_NAMES.test(line.description);
}
