/**
 * Listing crosswalk (owner ask 2026-09-06): pair a Shopify-shaped product
 * name ("California King Helix Twilight 11.5\" Firm Hybrid Mattress") with
 * the STORIS listing it should have been ("CAKING TWILIGHT-ELITE FIRM",
 * group CAKING, brand HELIX). Pure functions — no database — so the
 * scoring can be unit-tested and tuned without fixtures.
 *
 * A match needs the same size (a Queen never maps to a King), then is
 * scored by how many of the Shopify model words appear in the STORIS
 * name / brand / SKU, with small nudges for firmness and brand. A
 * case-insensitive SKU equality is a certain match.
 */

import {
  SIZE_ALIAS_KEYS,
  firmnessFromText,
  normalizeSize,
  sizeFromGroupCode,
  sizeFromText as sharedSizeFromText,
  type Firmness,
  type MattressSize,
} from '@jetnine/shared';

export type { Firmness, MattressSize };

export interface ParsedListing {
  size: MattressSize | null;
  firmness: Firmness | null;
  /** Upper-cased model words with size / firmness / filler removed (name + brand + SKU fragments). */
  tokens: Set<string>;
  /** The subset that came from the product / variant name alone. */
  nameTokens: Set<string>;
  /** Brand words — evidence of the maker, never of the model. */
  brandTokens: Set<string>;
}

/** Words that say nothing about which model it is. */
const FILLER = new Set([
  'MATTRESS',
  'MATTRESSES',
  'HYBRID',
  'BED',
  'SET',
  'THE',
  'AND',
  'WITH',
  'ONLY',
  'SIZE',
  'INCH',
  'IN',
  'OF',
  'A',
  'FOR',
  'MODEL',
  'NEW',
  'FOUNDATION',
  'SPLIT',
  'CAL',
  'CALIFORNIA',
  'KING',
  'QUEEN',
  'FULL',
  'DOUBLE',
  'TWIN',
  'XL',
  'TXL',
  'FIRM',
  'MEDIUM',
  'MED',
  'PLUSH',
  'SOFT',
  'EXTRA',
  'ULTRA',
  'LUXURY',
  'CUSHION',
  'X',
  'FP',
  'AS',
  ...SIZE_ALIAS_KEYS,
]);

function sizeFromGroup(group: string | null | undefined): MattressSize | null {
  return sizeFromGroupCode(group);
}

function sizeFromText(text: string): MattressSize | null {
  const hit = sharedSizeFromText(text);
  if (hit) return hit;
  // STORIS names lead with the group code: "CAKING TWILIGHT-ELITE FIRM".
  const lead = text.trim().split(/[\s/-]+/)[0] ?? '';
  return normalizeSize(lead);
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (!raw || raw.length < 2) continue;
    if (/^\d+(\.\d+)?$/.test(raw)) continue; // heights like 11.5, 12
    if (FILLER.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function parseListing(input: {
  name: string;
  variantName?: string | null;
  attributes?: Record<string, unknown> | null;
  brand?: string | null;
  sku?: string | null;
}): ParsedListing {
  const attrs = input.attributes ?? {};
  const attrSize = typeof attrs.size === 'string' ? attrs.size : null;
  const group = typeof attrs.group === 'string' ? attrs.group : null;
  const attrFirmness = typeof attrs.firmness === 'string' ? attrs.firmness : null;
  const hay = [attrSize, attrFirmness, input.name, input.variantName].filter(Boolean).join(' ');

  const size = sizeFromGroup(group) ?? sizeFromText(hay);
  const firmness = firmnessFromText(hay);

  const nameTokens = tokenize([input.name, input.variantName ?? ''].join(' '));
  const tokens = new Set(nameTokens);
  const brandTokens = input.brand ? tokenize(input.brand) : new Set<string>();
  for (const t of brandTokens) tokens.add(t);
  // SKU fragments help STORIS side ("HEXELITETW-FP-7284" → HEXELITETW):
  // the model word often sits inside the first fragment.
  if (input.sku) {
    for (const frag of input.sku.toUpperCase().split(/[^A-Z0-9]+/)) {
      if (frag.length >= 4 && !/^\d+$/.test(frag)) tokens.add(frag);
    }
  }
  return { size, firmness, tokens, nameTokens, brandTokens };
}

export interface ScoreDetail {
  score: number;
  sizeMatch: boolean | null;
  firmnessMatch: boolean | null;
  matchedTokens: string[];
}

/**
 * 0 when the sizes are known and differ; otherwise the share of the
 * Shopify model words found on the STORIS side (a word counts when it
 * equals a STORIS token or is contained in one — "TWILIGHT" inside
 * "HEXTWILIGHT"), plus firmness / brand nudges. Capped to 1.
 */
export function scoreListing(
  from: ParsedListing,
  to: ParsedListing,
  opts: { fromSku?: string | null; toSku?: string | null } = {},
): ScoreDetail {
  if (
    opts.fromSku &&
    opts.toSku &&
    opts.fromSku.trim().toLowerCase() === opts.toSku.trim().toLowerCase()
  ) {
    return { score: 1, sizeMatch: true, firmnessMatch: true, matchedTokens: ['SKU'] };
  }
  const sizeMatch = from.size && to.size ? from.size === to.size : null;
  if (sizeMatch === false) return { score: 0, sizeMatch, firmnessMatch: null, matchedTokens: [] };

  // Model words only: the brand ("Helix") says who made it, not which
  // mattress it is, so a shared brand never carries a match on its own.
  const model = [...from.nameTokens].filter(
    (t) => !to.brandTokens.has(t) && !from.brandTokens.has(t),
  );
  if (model.length === 0) {
    return { score: 0, sizeMatch, firmnessMatch: null, matchedTokens: [] };
  }
  const toTokens = [...to.tokens];
  const matched: string[] = [];
  for (const t of model) {
    if (
      to.tokens.has(t) ||
      toTokens.some((x) => x.length >= 4 && (x.includes(t) || t.includes(x)))
    ) {
      matched.push(t);
    }
  }
  // Recall over the Shopify model words, with a little precision so
  // "MIDNIGHT" outranks "MIDNIGHT-LUXE" for a plain Midnight.
  const recall = matched.length / model.length;
  const precision = matched.length / Math.max(1, to.nameTokens.size);
  let score = 0.8 * recall + 0.2 * Math.min(1, precision);
  const firmnessMatch = from.firmness && to.firmness ? from.firmness === to.firmness : null;
  if (firmnessMatch === true) score += 0.15;
  if (firmnessMatch === false) score -= 0.3;
  if (sizeMatch === true) score += 0.1;
  if (sizeMatch === null) score -= 0.1; // one side has no size → less certain
  if ([...from.nameTokens].some((t) => to.brandTokens.has(t))) score += 0.05;
  score = Math.max(0, Math.min(1, score));
  return { score: Math.round(score * 100) / 100, sizeMatch, firmnessMatch, matchedTokens: matched };
}

export interface Candidate<T> {
  item: T;
  parsed: ParsedListing;
  sku: string | null;
}

/** Best `limit` targets for one source listing, highest score first. */
export function rankCandidates<T>(
  from: ParsedListing,
  fromSku: string | null,
  pool: readonly Candidate<T>[],
  limit = 3,
  minScore = 0.3,
): { item: T; detail: ScoreDetail }[] {
  const scored: { item: T; detail: ScoreDetail }[] = [];
  for (const c of pool) {
    const detail = scoreListing(from, c.parsed, { fromSku, toSku: c.sku });
    if (detail.score >= minScore) scored.push({ item: c.item, detail });
  }
  scored.sort((a, b) => b.detail.score - a.detail.score);
  return scored.slice(0, limit);
}

/** The owner's rule: Shopify listings are the ones with lowercase letters in the name. */
export function hasLowercase(name: string): boolean {
  return /[a-z]/.test(name);
}

/** A proposal is confident enough to pre-fill the sheet at this score. */
export const PROPOSAL_MIN_SCORE = 0.5;
