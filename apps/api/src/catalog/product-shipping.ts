/**
 * A21 (PLAN-POS-OPERATIONS §12.17 D9): the STORIS Shipping Information
 * block on View Product Activity → General Information. Stored as one
 * jsonb document on the product; every field is a plain number or null.
 * Display and print only — delivery capacity keeps using the variant's
 * capacity units.
 */
export const SHIPPING_KEYS = [
  'weightLb',
  'heightIn',
  'widthIn',
  'depthIn',
  'shippingVolume',
  'deliveryVolume',
] as const;
export type ShippingKey = (typeof SHIPPING_KEYS)[number];
export type ProductShipping = Record<ShippingKey, number | null>;

export function emptyShipping(): ProductShipping {
  return {
    weightLb: null,
    heightIn: null,
    widthIn: null,
    depthIn: null,
    shippingVolume: null,
    deliveryVolume: null,
  };
}

/** Read the stored document; anything missing or malformed is null. */
export function parseShipping(raw: unknown): ProductShipping {
  const out = emptyShipping();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of SHIPPING_KEYS) {
    const v = r[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  }
  return out;
}

/**
 * Merge a PATCH body over the current document. Returns null when the
 * body is not an object; throws (via the caller) on a bad value.
 */
export function mergeShipping(
  current: ProductShipping,
  body: unknown,
): { next: ProductShipping; bad: string | null } {
  const next = { ...current };
  if (!body || typeof body !== 'object') return { next, bad: 'shipping must be an object' };
  const r = body as Record<string, unknown>;
  for (const k of SHIPPING_KEYS) {
    if (!(k in r)) continue;
    const v = r[k];
    if (v === null || v === '') {
      next[k] = null;
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      next[k] = v;
    } else {
      return { next: current, bad: `${k} must be a number of 0 or more, or null` };
    }
  }
  return { next, bad: null };
}
