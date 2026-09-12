/**
 * Catalog vocab shared by the API and the web app (amendment A19).
 */

/** STORIS Purchase Status: may the buyer still order this product? */
export const PRODUCT_PURCHASE_STATUSES = [
  'active',
  'discontinued',
  'special_order',
  'closeout',
] as const;
export type ProductPurchaseStatus = (typeof PRODUCT_PURCHASE_STATUSES)[number];

export const PRODUCT_PURCHASE_STATUS_LABELS: Record<ProductPurchaseStatus, string> = {
  active: 'Active',
  discontinued: 'Discontinued',
  special_order: 'Special order only',
  closeout: 'Closeout',
};

/*
 * Size and firmness (amendment A22.2, owner 2026-09-12): one vocabulary
 * for the register popup, the product browser, the variant editors and
 * the catalog import. Sizes are the US bedding sizes a mattress store
 * sells; every variant carries at most one. Items that fit several sizes
 * (a T/F/Q/K frame, a Full/Queen headboard) carry none.
 */

export const MATTRESS_SIZES = [
  'Twin',
  'Twin XL',
  'Full',
  'Full XL',
  'Queen',
  'Olympic Queen',
  'King',
  'Cal King',
  'Split Queen',
  'Split King',
  'Split Cal King',
  'Custom',
] as const;
export type MattressSize = (typeof MATTRESS_SIZES)[number];

/** Ordered soft → hard, the way a floor sells them. */
export const FIRMNESS_LEVELS = ['Plush', 'Medium', 'Medium Firm', 'Firm', 'Extra Firm'] as const;
export type Firmness = (typeof FIRMNESS_LEVELS)[number];

/**
 * Every spelling a size arrives as — the labels, the STORIS group codes
 * (QUEEN, CAKING, SPLCAK, TXL…), the abbreviations inside SKUs and
 * descriptions (EK, CK, QN, FXL…) and the long forms (California King,
 * Eastern King). Keys are upper-cased with everything but letters and
 * digits removed.
 */
const SIZE_ALIASES: Record<string, MattressSize> = {
  TWIN: 'Twin',
  TW: 'Twin',
  TN: 'Twin',
  TWINXL: 'Twin XL',
  TXL: 'Twin XL',
  TWXL: 'Twin XL',
  TWLXL: 'Twin XL',
  XL: 'Twin XL',
  TWINEXTRALONG: 'Twin XL',
  FULL: 'Full',
  FL: 'Full',
  FU: 'Full',
  DBL: 'Full',
  DOUBLE: 'Full',
  FULLXL: 'Full XL',
  FXL: 'Full XL',
  FULLEXTRALONG: 'Full XL',
  QUEEN: 'Queen',
  QU: 'Queen',
  QN: 'Queen',
  OLYMPICQUEEN: 'Olympic Queen',
  OLYMPICQU: 'Olympic Queen',
  OQ: 'Olympic Queen',
  KING: 'King',
  EK: 'King',
  EKING: 'King',
  EASTERNKING: 'King',
  STANDARDKING: 'King',
  CAKING: 'Cal King',
  CALKING: 'Cal King',
  CALIFORNIAKING: 'Cal King',
  CKING: 'Cal King',
  CK: 'Cal King',
  CALK: 'Cal King',
  CAK: 'Cal King',
  WESTERNKING: 'Cal King',
  SPLITQUEEN: 'Split Queen',
  SPLQUE: 'Split Queen',
  SPLITQU: 'Split Queen',
  SPQ: 'Split Queen',
  SQ: 'Split Queen',
  SPLITKING: 'Split King',
  SPKING: 'Split King',
  SPK: 'Split King',
  SK: 'Split King',
  SPLITEKING: 'Split King',
  SPLITEASTERNKING: 'Split King',
  SPLITCALKING: 'Split Cal King',
  SPLITCAKING: 'Split Cal King',
  SPLITCALIFORNIAKING: 'Split Cal King',
  SPLITCK: 'Split Cal King',
  SPLCAK: 'Split Cal King',
  SCAK: 'Split Cal King',
  SCK: 'Split Cal King',
  SPCK: 'Split Cal King',
  SPCAKING: 'Split Cal King',
  CUSTOM: 'Custom',
};

/** The alias keys — the listing matcher strips them from model words. */
export const SIZE_ALIAS_KEYS: readonly string[] = Object.keys(SIZE_ALIASES);

const aliasKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * A size as typed or imported → the canonical label, or null. Accepts the
 * label in any case ("cal king"), the long forms ("California King") and
 * the STORIS / SKU abbreviations ("CAKING", "CK").
 */
export function normalizeSize(input: string | null | undefined): MattressSize | null {
  if (!input) return null;
  const key = aliasKey(input);
  if (!key) return null;
  return SIZE_ALIASES[key] ?? null;
}

/** A firmness as typed or imported → the canonical label, or null. */
export function normalizeFirmness(input: string | null | undefined): Firmness | null {
  if (!input) return null;
  const key = input
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  const hit = FIRMNESS_LEVELS.find((f) => f.toLowerCase() === key);
  if (hit) return hit;
  return firmnessFromText(input);
}

/**
 * STORIS "Group" codes carry the size for sized lines with a per-line
 * suffix — QUEEN / QUFND / QUADJ / QUPRO / QUSHEE / QUPCAS are all Queen,
 * SCKFND and SPLCAK are Split Cal King, TXLSHE is Twin XL. Unsized groups
 * (FRAMES, HBOARD, PILLOW, TOPPER, SUPPLY, ADJBAS…) return null.
 */
const GROUP_SUFFIXES = ['PCAS', 'SHEE', 'SHE', 'FND', 'ADJ', 'PRO', 'MATT'];

export function sizeFromGroupCode(code: string | null | undefined): MattressSize | null {
  if (!code) return null;
  const key = aliasKey(code);
  if (!key) return null;
  const direct = SIZE_ALIASES[key];
  if (direct) return direct;
  for (const suffix of GROUP_SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const stem = SIZE_ALIASES[key.slice(0, -suffix.length)];
      if (stem) return stem;
    }
  }
  return null;
}

/**
 * Whole-word patterns, most specific first. Each one consumes what it
 * matched so "Split Cal King" is not also a "King". Case-insensitive.
 */
const SIZE_PATTERNS: [RegExp, MattressSize][] = [
  [
    /\bsplit[\s-]*cal(ifornia)?\.?[\s-]*king\b|\bsplit[\s-]*ca[\s-]*king\b|\bsplitck\b|\bspl[\s-]*cak\b|\bscak\b|\bsck\b/gi,
    'Split Cal King',
  ],
  [/\bsplit[\s-]*(e[\s-]*|eastern[\s-]*)?king\b|\bsp[\s-]*king\b|\bspk\b/gi, 'Split King'],
  [/\bsplit[\s-]*qu(een)?\.?\b|\bsplque\b|\bspq\b/gi, 'Split Queen'],
  [/\bolympic[\s-]*qu(een)?\.?\b/gi, 'Olympic Queen'],
  [/\bcal(ifornia)?\.?[\s-]*king\b|\bca[\s-]*king\b|\bcaking\b|\bcking\b|\bck\b/gi, 'Cal King'],
  [/\b(e|eastern|east)[\s-]*king\b|\beking\b|\bek\b|\bking\b/gi, 'King'],
  [/\bqueen\b|\bqn\b|\bqu\b/gi, 'Queen'],
  [/\btwin[\s-]*x-?l\b|\btxl\b|\btwin[\s-]*extra[\s-]*long\b/gi, 'Twin XL'],
  [/\bfull[\s-]*x-?l\b|\bf-?xl\b|\bfull[\s-]*extra[\s-]*long\b/gi, 'Full XL'],
  [/\btwin\b/gi, 'Twin'],
  [/\bfull\b|\bdouble\b/gi, 'Full'],
];

/**
 * The one size a product / variant name names, or null when it names
 * none or several (a "TWIN/FULL FRAME" fits both, so it has no size).
 */
export function sizeFromText(text: string | null | undefined): MattressSize | null {
  if (!text) return null;
  // A slash or hyphen list of sizes ("T/F/Q/K/CK", "EK/CK/QN", "KING-Q",
  // "Twin/Full") is a multi-size item, whatever the abbreviations are:
  // three or more size tokens, or two with at least one spelled-out code.
  // A run that is itself one size ("F-XL", "E-KING", "TWIN-XL") is not.
  for (const run of text.match(/\b[A-Za-z]{1,6}(?:[/-][A-Za-z]{1,6})+\b/g) ?? []) {
    if (SIZE_ALIASES[aliasKey(run)] !== undefined) continue;
    const segments = run.split(/[/-]/);
    const aliases = segments.filter((seg) => SIZE_ALIASES[aliasKey(seg)] !== undefined);
    const letters = segments.filter(
      (seg) => SIZE_ALIASES[aliasKey(seg)] === undefined && /^[TFQKCE]$/i.test(seg),
    );
    const sized = aliases.length + letters.length;
    if (sized >= 3 || (sized >= 2 && aliases.length >= 1)) return null;
  }
  let rest = text;
  const found = new Set<MattressSize>();
  for (const [re, size] of SIZE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(rest)) {
      found.add(size);
      re.lastIndex = 0;
      rest = rest.replace(re, ' ');
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** Most specific phrase first; the first hit wins. */
const FIRMNESS_PATTERNS: [RegExp, Firmness][] = [
  [
    /\b(extra|ultra|x)[\s-]*firm\b|\bxfirm\b|\bxf\b|\b(ultra|ultr)[\s-]*fm\b|\bx-?firm\b/i,
    'Extra Firm',
  ],
  [
    /\b(medium|med\.?|luxury|lux|cushion|plush)[\s-]*firm\b|\blux[\s-]*fm\b|\bmed[\s-]*fm\b/i,
    'Medium Firm',
  ],
  [/\bfirm\b|\bfm\b/i, 'Firm'],
  [/\b(medium|med\.?)[\s-]*(soft|plush)\b|\bultra[\s-]*plush\b|\bplush\b|\bsoft\b/i, 'Plush'],
  [/\bmedium\b|\bmed\.?\b/i, 'Medium'],
];

/** The firmness a name states, or null. Firm-vs-medium phrases resolve most specific first. */
export function firmnessFromText(text: string | null | undefined): Firmness | null {
  if (!text) return null;
  for (const [re, f] of FIRMNESS_PATTERNS) if (re.test(text)) return f;
  return null;
}
