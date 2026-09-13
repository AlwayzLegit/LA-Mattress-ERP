/**
 * Where a product filed under a category the mapping file does not name
 * belongs in the A22.1 tree (docs/imports/2026-09-11/product-categories.csv).
 *
 * Production accumulated two kinds of stray category: one per STORIS GROUP
 * code from the pre-#134 import (the code named the size or the product
 * group — QUFND, HBOARD, CKPRO, …) and the product types a connector sync
 * wrote ("Hybrid Mattress", "Foundations"). The products still in them are
 * the ones the STORIS export never listed (connector SKUs, later
 * additions). Each code resolves to the branch the export's own SKUs in
 * that group landed on (`build-product-categories.py`; every rule here was
 * read off that join and holds for ≥ 85% of the group, the rest on the
 * root), refined by the same description words the build script reads
 * (HYBRID, LATEX, BB / LP / 9", ENCASEMENT, …).
 */
const MATTRESSES = 'Mattresses';
const FOUNDATIONS = 'Foundations & Box Springs';
const PROTECTION = 'Mattress Protection';

export interface StrayTarget {
  category: string;
  subcategory: string | null;
}

/** Stray category name (case-insensitive) → where its products go. */
const STRAY_TARGETS: Record<string, StrayTarget> = {
  // STORIS GROUP codes — sizes are mattress sizes.
  TWIN: { category: MATTRESSES, subcategory: null },
  TWINXL: { category: MATTRESSES, subcategory: null },
  FULL: { category: MATTRESSES, subcategory: null },
  FULLXL: { category: MATTRESSES, subcategory: null },
  QUEEN: { category: MATTRESSES, subcategory: null },
  KING: { category: MATTRESSES, subcategory: null },
  CAKING: { category: MATTRESSES, subcategory: null },
  SPLCAK: { category: MATTRESSES, subcategory: null },
  SPLQUE: { category: MATTRESSES, subcategory: null },
  SPLKNG: { category: MATTRESSES, subcategory: null },
  TWADJ: { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  TXLADJ: { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  FUADJ: { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  FXLADJ: { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  QUADJ: { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  EKADJ: { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  CKADJ: { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  ADJBAS: { category: 'Adjustable Bases', subcategory: 'Base Accessories & Parts' },
  TWFND: { category: FOUNDATIONS, subcategory: null },
  TXLFND: { category: FOUNDATIONS, subcategory: null },
  FUFND: { category: FOUNDATIONS, subcategory: null },
  FXLFND: { category: FOUNDATIONS, subcategory: null },
  QUFND: { category: FOUNDATIONS, subcategory: null },
  EKFND: { category: FOUNDATIONS, subcategory: null },
  CKFND: { category: FOUNDATIONS, subcategory: null },
  SCKFND: { category: FOUNDATIONS, subcategory: null },
  FRAMES: { category: 'Bed Frames', subcategory: null },
  BEDFRA: { category: 'Bed Frames', subcategory: 'Platform & Folding Frames' },
  RAILS: { category: 'Bed Frames', subcategory: 'Frame Parts & Hardware' },
  HBOARD: { category: 'Bedroom Furniture', subcategory: 'Headboards' },
  DAYBED: { category: 'Bedroom Furniture', subcategory: 'Daybeds & Sofa Beds' },
  FUTON: { category: 'Bedroom Furniture', subcategory: 'Daybeds & Sofa Beds' },
  LIVING: { category: 'Bedroom Furniture', subcategory: 'Living Room & Decor' },
  RUGS: { category: 'Bedroom Furniture', subcategory: 'Living Room & Decor' },
  DINE: { category: 'Bedroom Furniture', subcategory: 'Living Room & Decor' },
  TWPRO: { category: PROTECTION, subcategory: null },
  TXLPRO: { category: PROTECTION, subcategory: null },
  FUPRO: { category: PROTECTION, subcategory: null },
  FXLPRO: { category: PROTECTION, subcategory: null },
  QUPRO: { category: PROTECTION, subcategory: null },
  EKPRO: { category: PROTECTION, subcategory: null },
  CKPRO: { category: PROTECTION, subcategory: null },
  SCKPRO: { category: PROTECTION, subcategory: null },
  PILPRO: { category: PROTECTION, subcategory: 'Pillow Protectors' },
  TWSHEE: { category: 'Bedding', subcategory: 'Sheet Sets' },
  TXLSHE: { category: 'Bedding', subcategory: 'Sheet Sets' },
  FUSHEE: { category: 'Bedding', subcategory: 'Sheet Sets' },
  QUSHEE: { category: 'Bedding', subcategory: 'Sheet Sets' },
  EKSHEE: { category: 'Bedding', subcategory: 'Sheet Sets' },
  CKSHEE: { category: 'Bedding', subcategory: 'Sheet Sets' },
  SPKSHE: { category: 'Bedding', subcategory: 'Sheet Sets' },
  QUPCAS: { category: 'Bedding', subcategory: 'Pillowcases' },
  KPICAS: { category: 'Bedding', subcategory: 'Pillowcases' },
  TOPPER: { category: 'Bedding', subcategory: 'Toppers & Mattress Pads' },
  PILLOW: { category: 'Pillows', subcategory: null },
  VDSDEL: { category: 'Services & Fees', subcategory: 'Delivery & Installation' },
  // Connector product types.
  MATTRESS: { category: MATTRESSES, subcategory: null },
  'BED IN A BOX': { category: MATTRESSES, subcategory: null },
  'HYBRID MATTRESS': { category: MATTRESSES, subcategory: 'Hybrid' },
  'INNERSPRING MATTRESS': { category: MATTRESSES, subcategory: 'Innerspring' },
  'LATEX MATTRESS': { category: MATTRESSES, subcategory: 'Latex' },
  'MEMORY FOAM MATTRESS': { category: MATTRESSES, subcategory: 'Memory Foam' },
  FOUNDATIONS: { category: FOUNDATIONS, subcategory: null },
  FOUNDATION: { category: FOUNDATIONS, subcategory: null },
  'BOX SPRING': { category: FOUNDATIONS, subcategory: null },
  'ADJUSTABLE BASE': { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  'ADJUSTABLE BEDS': { category: 'Adjustable Bases', subcategory: 'Adjustable Bed Bases' },
  'PLATFORM BASE': { category: 'Bed Frames', subcategory: 'Platform & Folding Frames' },
  'MATTRESS PROTECTOR': { category: PROTECTION, subcategory: 'Mattress Protectors' },
  'MATTRESS TOPPERS': { category: 'Bedding', subcategory: 'Toppers & Mattress Pads' },
  COMFORTERS: { category: 'Bedding', subcategory: 'Comforters & Duvets' },
  MWS_FEE_GENERATED: { category: 'Services & Fees', subcategory: 'Fees' },
};

/** The description words the build script keys on, applied under a root. */
function refine(target: StrayTarget, description: string): StrayTarget {
  if (target.subcategory) return target;
  const d = description.toUpperCase();
  if (target.category === MATTRESSES) {
    if (/HYBRID|\bHYBR?\b/.test(d)) return { category: MATTRESSES, subcategory: 'Hybrid' };
    if (/LATEX|TALALAY|DUNLOP/.test(d)) return { category: MATTRESSES, subcategory: 'Latex' };
    if (/MEMORY|ALL-FOAM|GEL FOAM|TEMPUR/.test(d))
      return { category: MATTRESSES, subcategory: 'Memory Foam' };
    return target;
  }
  if (target.category === FOUNDATIONS) {
    if (/\bBB\b|\b2"|BUNKIE/.test(d))
      return { category: FOUNDATIONS, subcategory: 'Bunkie Board (2")' };
    if (/\bLP\b|\b[45]"|LOW PRO/.test(d))
      return { category: FOUNDATIONS, subcategory: 'Low Profile (4–5")' };
    if (/\b[89]"|STANDARD PRO|\bSTD\b/.test(d))
      return { category: FOUNDATIONS, subcategory: 'Standard Profile (8–9")' };
    return target;
  }
  if (target.category === PROTECTION) {
    if (/PILLOW|PILL\b/.test(d)) return { category: PROTECTION, subcategory: 'Pillow Protectors' };
    if (/ENCASE|ZIP|COVER|INVISACASE/.test(d))
      return { category: PROTECTION, subcategory: 'Encasements & Covers' };
    return { category: PROTECTION, subcategory: 'Mattress Protectors' };
  }
  if (target.category === 'Pillows') {
    if (/LATEX|TALALAY/.test(d)) return { category: 'Pillows', subcategory: 'Latex Pillows' };
    if (/DOWN|MICROFIBER/.test(d))
      return { category: 'Pillows', subcategory: 'Down & Down-Alternative Pillows' };
    if (/BODY PILLOW|\bCUB\b|KIDS?\b/.test(d))
      return { category: 'Pillows', subcategory: 'Specialty & Kids Pillows' };
    if (/MEMORY|FOAM|TEMPUR/.test(d))
      return { category: 'Pillows', subcategory: 'Memory Foam Pillows' };
    return target;
  }
  if (target.category === 'Bed Frames') {
    if (/WHEEL|BEDBEAM|LAZARBEAM|BOLT-IN|BRKT|BRACKET|RAIL/.test(d) && !/BED FRAME/.test(d))
      return { category: 'Bed Frames', subcategory: 'Frame Parts & Hardware' };
    if (/PLATFORM|FOLDING|BED BASE/.test(d))
      return { category: 'Bed Frames', subcategory: 'Platform & Folding Frames' };
    return { category: 'Bed Frames', subcategory: 'Metal Bed Frames' };
  }
  return target;
}

/**
 * Where a product sitting in a stray category belongs, or null when the
 * category name says nothing the tree knows (left for the next mapping).
 */
export function classifyStray(categoryName: string, description: string): StrayTarget | null {
  const target = STRAY_TARGETS[categoryName.trim().toUpperCase()];
  return target ? refine(target, description) : null;
}
