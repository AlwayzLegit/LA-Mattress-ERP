/**
 * Recently opened records (owner 2026-10-02): the search window opens on
 * the last few customers, orders, products, POs… this person opened.
 * Kept per signed-in user in this browser as `kind:id` refs; the API
 * (`/v1/search/recent`) resolves current names and drops anything gone
 * or outside the member's access, so nothing stale or private shows.
 */

export type RecentKind =
  | 'order'
  | 'customer'
  | 'product'
  | 'po'
  | 'sale'
  | 'service'
  | 'vendor'
  | 'delivery';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTES: [RegExp, RecentKind][] = [
  [new RegExp(`^/orders/(${UUID})(?:/|$)`, 'i'), 'order'],
  [new RegExp(`^/customers/(${UUID})(?:/|$)`, 'i'), 'customer'],
  [new RegExp(`^/products/(${UUID})(?:/|$)`, 'i'), 'product'],
  [new RegExp(`^/purchase-orders/(${UUID})(?:/|$)`, 'i'), 'po'],
  [new RegExp(`^/sales/(${UUID})(?:/|$)`, 'i'), 'sale'],
  [new RegExp(`^/service/(${UUID})(?:/|$)`, 'i'), 'service'],
  [new RegExp(`^/vendors/(${UUID})(?:/|$)`, 'i'), 'vendor'],
  [new RegExp(`^/deliveries/(${UUID})(?:/|$)`, 'i'), 'delivery'],
];

export const RECENT_LIMIT = 8;

/** The `kind:id` ref for a record page, or null for any other page. */
export function refFromPath(pathname: string): string | null {
  for (const [re, kind] of ROUTES) {
    const m = re.exec(pathname);
    if (m) return `${kind}:${m[1]!.toLowerCase()}`;
  }
  return null;
}

/** Newest first, de-duplicated, capped. */
export function pushRef(list: string[], ref: string, limit = RECENT_LIMIT): string[] {
  return [ref, ...list.filter((r) => r !== ref)].slice(0, limit);
}

const key = (userId: string) => `jetnine.recent.${userId}`;

export function readRecent(userId: string | undefined): string[] {
  if (!userId) return [];
  try {
    const raw = window.localStorage.getItem(key(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberRecent(userId: string | undefined, ref: string): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(pushRef(readRecent(userId), ref)));
  } catch {
    // storage blocked — recents are a convenience
  }
}
