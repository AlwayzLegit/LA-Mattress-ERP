import type { StatusKey } from '@/lib/design-tokens';

/**
 * Orders (redesign Phase 6, README §3.2): the server's owner-facing
 * display vocabulary (P-013) rendered with the six Phase 2 status tones.
 * The word stays the STORIS ladder; the glyph and hue carry the state.
 */
export function chipFor(
  displayStatus: string,
  opts: { deliveryDate?: string | null; today?: string } = {},
): { status: StatusKey; label: string } {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const open = ['Pending', 'On PO', 'Reserved', 'Scheduled'].includes(displayStatus);
  if (open && opts.deliveryDate && opts.deliveryDate < today) {
    return { status: 'risk', label: 'Past due' };
  }
  switch (displayStatus) {
    case 'Draft':
      return { status: 'draft', label: 'Draft' };
    case 'Quote':
      return { status: 'draft', label: 'Quote' };
    case 'Pending':
      return { status: 'waiting', label: 'Pending' };
    case 'On PO':
      return { status: 'waiting', label: 'On PO' };
    case 'Layaway':
      return { status: 'waiting', label: 'Layaway' };
    case 'Awaiting Return Pickup':
      return { status: 'waiting', label: 'Awaiting return pickup' };
    case 'Reserved':
      return { status: 'scheduled', label: 'Reserved' };
    case 'Scheduled':
      return { status: 'scheduled', label: 'Scheduled' };
    case 'Out for Delivery':
      return { status: 'scheduled', label: 'Out for delivery' };
    case 'Delivered':
      return { status: 'fulfilled', label: 'Delivered' };
    case 'Returned':
      return { status: 'fulfilled', label: 'Returned' };
    case 'Exchanged':
      return { status: 'fulfilled', label: 'Exchanged' };
    case 'Cancelled':
      return { status: 'cancelled', label: 'Cancelled' };
    default:
      return { status: 'draft', label: displayStatus || 'Draft' };
  }
}

/** Status filter options: the display ladder plus the Past-due saved view. */
export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any' },
  { value: 'Draft', label: 'Draft' },
  { value: 'Quote', label: 'Quote' },
  { value: 'Pending', label: 'Pending' },
  { value: 'On PO', label: 'On PO' },
  { value: 'Reserved', label: 'Reserved' },
  { value: 'Scheduled', label: 'Scheduled' },
  { value: 'Out for Delivery', label: 'Out for delivery' },
  { value: 'past_due', label: 'Past due' },
  { value: 'Delivered', label: 'Delivered' },
  { value: 'Layaway', label: 'Layaway' },
  { value: 'Awaiting Return Pickup', label: 'Awaiting return pickup' },
  { value: 'Returned', label: 'Returned' },
  { value: 'Exchanged', label: 'Exchanged' },
  { value: 'Cancelled', label: 'Cancelled' },
];

export const FULFILLMENT_LABEL: Record<string, string> = {
  delivery: 'Delivery',
  pickup: 'Pickup',
  take_with: 'Take with',
  direct_ship: 'Direct ship',
};

export const METHOD_LABEL: Record<string, string> = {
  card: 'Card',
  cash: 'Cash',
  check: 'Check',
  paypal: 'PayPal',
  venmo: 'Venmo',
  zelle: 'Zelle',
  synchrony: 'Synchrony',
  acima: 'Acima',
  store_credit: 'Store credit',
  gift_card: 'Gift card',
  financing: 'Financing',
  external_card: 'Card (external)',
};

/** "Sep 14" — a day string (YYYY-MM-DD) or ISO timestamp. */
export function fmtDay(value: string | null | undefined): string {
  if (!value) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Sep 4 · 8:12 AM" */
export function fmtWhen(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(
    'en-US',
    { hour: 'numeric', minute: '2-digit' },
  )}`;
}

/** "today" / "yesterday" / "3d ago" — for the sheet's meta line. */
export function relativeDay(value: string, now = new Date()): string {
  const d = new Date(value);
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] || '—';
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
