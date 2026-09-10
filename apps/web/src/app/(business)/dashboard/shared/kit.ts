import type { StorePeriod } from './types';

/**
 * Formatting shared by the store cards, the payment list and the
 * Changes card (hand-off 2026-09-10). Money stays whole dollars with a
 * real minus sign; times render in the store's own timezone so the
 * owner reading from elsewhere sees the drawer's clock, not theirs.
 */

/** "−$345" / "+$900" / "$0". */
export function usdSigned(cents: number): string {
  const whole = `$${Math.round(Math.abs(cents) / 100).toLocaleString('en-US')}`;
  if (cents < 0) return `−${whole}`;
  if (cents > 0) return `+${whole}`;
  return whole;
}

/** "9m" · "4h" · "2d" — how long ago. */
export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "12:16 PM" in the store's timezone. */
export function clockTime(iso: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  });
}

/** "Sep 3" in the store's timezone. */
export function dayShort(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
}

/** "Sep 3, 12:16 PM". */
export function dayAndTime(iso: string, tz?: string): string {
  return `${dayShort(iso, tz)}, ${clockTime(iso, tz)}`;
}

/** "Sep 3 2:14 PM" — the acknowledgement / receipt stamp style. */
export function stamp(iso: string, tz?: string): string {
  return `${dayShort(iso, tz)} ${clockTime(iso, tz)}`;
}

/** A `YYYY-MM-DD` day as "Sep 1". */
export function ymdShort(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Sep 1 – 10" for a window; "Sep 10" when it is one day. */
export function rangeLabel(range: { start: string; end: string }): string {
  if (range.start === range.end) return ymdShort(range.start);
  return `${ymdShort(range.start)} – ${ymdShort(range.end)}`;
}

export function periodWord(period: StorePeriod): string {
  return period === 'today' ? 'today' : 'month to date';
}

/** Tender rows: the live methods, their labels and swatch colours. */
export const TENDER_META: Record<string, { label: string; swatch: string }> = {
  cash: { label: 'Cash', swatch: 'var(--accent)' },
  card: { label: 'Card', swatch: 'var(--info)' },
  external_card: { label: 'External card', swatch: 'var(--text2)' },
  check: { label: 'Check', swatch: 'var(--warn)' },
  financing: { label: 'Financing', swatch: 'var(--muted)' },
  gift_card: { label: 'Gift card', swatch: 'var(--faint)' },
  store_credit: { label: 'Store credit', swatch: 'var(--border2)' },
};

export function tenderMeta(method: string): { label: string; swatch: string } {
  return (
    TENDER_META[method] ?? {
      label: method.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      swatch: 'var(--faint)',
    }
  );
}

/** Where a payment's document lives. */
export function docHref(kind: 'order' | 'sale' | 'service', id: string): string {
  if (kind === 'order') return `/orders/${id}`;
  if (kind === 'sale') return `/sales/${id}`;
  return `/service/${id}`;
}

export function plural(n: number, word: string, words = `${word}s`): string {
  return `${n} ${n === 1 ? word : words}`;
}

/** Per-viewer UI state in this browser; every read tolerates a missing store. */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable — the choice just won't stick.
  }
}
