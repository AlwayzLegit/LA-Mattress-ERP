/**
 * STORIS CATG code → the retail category it was renamed to by the
 * categorize-products ops run (docs/imports/2026-09-11/product-categories.md).
 *
 * The catalog import resolves a CATG value through this map when no
 * category carries the code name any more, so re-importing products.csv
 * lands rows on "Mattresses" instead of re-creating "MATT".
 */
export const LEGACY_CATEGORY_NAMES: Record<string, string> = {
  MATT: 'Mattresses',
  ADJUST: 'Adjustable Bases',
  FOUND: 'Foundations & Box Springs',
  BED: 'Bed Frames',
  FURN: 'Bedroom Furniture',
  PROT: 'Mattress Protection',
  TOPBED: 'Bedding',
  PILLOW: 'Pillows',
  SUPPLY: 'Store Supplies & Equipment',
  NONINV: 'Services & Fees',
  RF: 'Services & Fees',
};
