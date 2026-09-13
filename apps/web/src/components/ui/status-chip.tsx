import { STATUSES, type StatusKey } from '@/lib/design-tokens';
import { cx } from './cx';

/**
 * Status chips (canvas 2d/2e): glyph + word + colour, always together,
 * tinted fill with a 1px border of the same hue, 600-weight word. The
 * glyph carries the state for anyone who cannot see the hue; Cancelled
 * is struck, never hidden.
 */

const BY_KEY = Object.fromEntries(STATUSES.map((s) => [s.key, s])) as Record<
  StatusKey,
  (typeof STATUSES)[number]
>;

export function StatusChip({
  status,
  label,
  className,
  ...rest
}: {
  status: StatusKey;
  /** Override the word (e.g. "Waiting on PO-4471"); the glyph and colour stay. */
  label?: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const s = BY_KEY[status];
  return (
    <span {...rest} className={cx('chip', `chip-${s.key}`, s.strike && 'chip-strike', className)}>
      <span className="chip-glyph" aria-hidden>
        {s.glyph}
      </span>
      <span className="chip-word">{label ?? s.label}</span>
    </span>
  );
}

/**
 * Lifecycle strings from the API (orders, POs, payments, service, tasks…)
 * mapped onto a tone. Rendered with the same chip anatomy: `.badge` gets
 * its glyph from the tone class in CSS so the word stays the only text.
 */
const STATUS_TONES: Record<string, string> = {
  // documents
  quote: 'warning',
  draft: 'neutral',
  open: 'info',
  confirmed: 'info',
  ordered: 'info',
  partially_fulfilled: 'brand',
  partially_received: 'brand',
  partially_refunded: 'warning',
  fulfilled: 'success',
  received: 'success',
  completed: 'success',
  delivered: 'success',
  paid: 'success',
  active: 'success',
  succeeded: 'success',
  blocked: 'danger',
  partial: 'warning',
  valid: 'success',
  committed: 'success',
  scheduled: 'info',
  out_for_delivery: 'brand',
  in_service: 'info',
  awaiting_parts: 'warning',
  intake: 'warning',
  ready: 'success',
  pending: 'neutral',
  due: 'neutral',
  invalid: 'danger',
  overdue: 'danger',
  failed: 'danger',
  cancelled: 'danger',
  canceled: 'danger',
  refunded: 'danger',
  disabled: 'danger',
  suspended: 'danger',
};

const STRUCK = new Set(['cancelled', 'canceled', 'Cancelled']);

/** Chip for any document/lifecycle status string. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  return (
    <span className={cx('badge', `badge-${tone}`, STRUCK.has(status) && 'chip-strike', className)}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * P-013 (S01 audit): the ONE owner-facing order-status vocabulary —
 * list badges, the detail page, and the filter all use these words.
 */
export const DISPLAY_STATUS_TONES: Record<string, string> = {
  Draft: 'neutral',
  Pending: 'neutral',
  'On PO': 'info',
  Reserved: 'brand',
  Scheduled: 'info',
  'Out for Delivery': 'brand',
  Delivered: 'success',
  Quote: 'warning',
  Layaway: 'warning',
  Cancelled: 'danger',
  'Awaiting Return Pickup': 'warning',
  Returned: 'neutral',
  Exchanged: 'neutral',
};

export function DisplayStatusBadge({
  displayStatus,
  poNumber,
  className,
}: {
  displayStatus: string;
  poNumber?: string | null;
  className?: string;
}) {
  const tone = DISPLAY_STATUS_TONES[displayStatus] ?? 'neutral';
  return (
    <span
      className={cx(
        'badge',
        `badge-${tone}`,
        STRUCK.has(displayStatus) && 'chip-strike',
        className,
      )}
    >
      {displayStatus}
      {poNumber ? ` (${poNumber})` : ''}
    </span>
  );
}
