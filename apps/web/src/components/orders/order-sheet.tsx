'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { formatMoney } from '@jetnine/shared';
import { ApiError, api } from '@/lib/api';
import {
  Alert,
  Button,
  ErrorState,
  Field,
  Input,
  LinkButton,
  LoadingRows,
  Select,
  SlideOver,
  StatusChip,
} from '@/components/ui';
import { Money } from '@/components/money';
import { SecurityOverrideDialog } from '@/components/security-override-dialog';
import { CancelOrderDialog } from './cancel-order-dialog';
import {
  FULFILLMENT_LABEL,
  METHOD_LABEL,
  chipFor,
  firstName,
  fmtDay,
  fmtWhen,
  pluralize,
  relativeDay,
} from './order-format';

/**
 * Order slide-over (redesign Phase 6, README §3.2, canvas 5b/5c): the
 * quick answer to "where is this order, and can I still change it?".
 * 640px over the book, URL-addressable at `/orders/[id]`. Title = number
 * in mono + status chip + meta; lock banner when a delivery ticket has
 * printed; one action row with Cancel alone at the right; summary,
 * lines, payments, change history. Everything that edits the order in
 * depth lives on the full page (`/orders/[id]/full`).
 */

interface OrderLine {
  id: string;
  description: string;
  quantity: number;
  qtyReserved: number;
  qtyFulfilled: number;
  lineType: string;
  fulfillmentMethod: string | null;
  sourceLocationId: string | null;
  totalCents: number;
}
interface OrderPayment {
  id: string;
  kind: string;
  method: string;
  amountCents: number;
  status: string;
  processorRef: string | null;
  createdAt: string;
}
interface OrderDetail {
  id: string;
  number: string;
  status: string;
  displayStatus?: string;
  customerId: string;
  locationId: string;
  stockLocationId: string | null;
  fulfillmentType: string;
  requestedDate: string | null;
  totalCents: number;
  paidCents: number;
  balanceDueCents: number;
  creditDueCents: number;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  deliveryInstructions?: string | null;
  deliveryStatus?: string | null;
  salespersonMembershipId?: string | null;
  lockedAt: string | null;
  onOpenRun: { runId: string; runDate: string } | null;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  lines: OrderLine[];
  payments: OrderPayment[];
}
interface CustomerRow {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
}
interface LocationRow {
  id: string;
  name: string;
}
interface MemberRow {
  membershipId: string;
  name: string | null;
}
interface DeliveryRow {
  id: string;
  status: string;
  scheduledDate: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}
interface AuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  createdAt: string;
  changesJson: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } | null;
}

const TENDERS = ['card', 'cash', 'check', 'paypal', 'venmo', 'zelle', 'synchrony', 'acima'];

/** Audit actions → what the timeline says, and the dot's tone. */
function describe(row: AuditRow): { what: string; tone: string; detail: string } {
  const a = row.changesJson?.after ?? {};
  const b = row.changesJson?.before ?? {};
  const money = (v: unknown) => (typeof v === 'number' ? formatMoney(v) : String(v ?? ''));
  switch (row.action) {
    case 'order.create':
      return { what: 'Order written', tone: 'accent', detail: '' };
    case 'order.payment.take':
      return {
        what: 'Payment recorded',
        tone: 'fulfilled',
        detail: [
          METHOD_LABEL[String(a.method ?? '')] ?? String(a.method ?? ''),
          a.processorRef ? `••${String(a.processorRef).slice(-4)}` : '',
          typeof a.amountCents === 'number' ? money(a.amountCents) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'order.lock':
      return {
        what: 'Delivery ticket printed — order locked',
        tone: 'scheduled',
        detail: 'Unlock requires owner or store manager.',
      };
    case 'order.unlock':
      return {
        what: 'Order unlocked',
        tone: 'scheduled',
        detail: String(a.reason ?? a.reasonText ?? ''),
      };
    case 'order.cancel':
      return {
        what: 'Order cancelled',
        tone: 'muted',
        detail: [
          a.reason ? String(a.reason) : '',
          typeof a.depositCents === 'number' && a.depositCents > 0
            ? `${money(a.depositCents)} deposit → ${a.depositTo === 'store_credit' ? 'store credit' : 'refund'}`
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'order.reserve':
      return { what: 'Stock reserved', tone: 'scheduled', detail: '' };
    case 'order.release':
    case 'order.auto_stock_release':
      return { what: 'Reservation released', tone: 'waiting', detail: '' };
    case 'order.allocate_pending':
      return { what: 'Line short at source', tone: 'waiting', detail: '' };
    case 'order.price_adjustment':
      return {
        what: 'Price adjusted',
        tone: 'waiting',
        detail: typeof a.amountCents === 'number' ? money(a.amountCents) : '',
      };
    case 'order.note.add':
      return { what: 'Note added', tone: 'accent', detail: '' };
    default: {
      const fields = Object.keys({ ...b, ...a })
        .filter((k) => k !== 'status' || b.status !== a.status)
        .slice(0, 3)
        .map((k) => {
          const from = b[k];
          const to = a[k];
          const fmt = (v: unknown) =>
            v == null || v === '' ? '—' : /cents$/i.test(k) ? money(v) : String(v);
          return from === undefined ? `${k}: ${fmt(to)}` : `${k}: ${fmt(from)} → ${fmt(to)}`;
        });
      const word = row.action.replace(/^order\./, '').replace(/[._]/g, ' ');
      return {
        what: word.charAt(0).toUpperCase() + word.slice(1),
        tone: 'accent',
        detail: fields.join(' · '),
      };
    }
  }
}

export function OrderSheet({ id }: { id: string }) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [history, setHistory] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payMethod, setPayMethod] = useState('card');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    router.push(`/orders${typeof window !== 'undefined' ? window.location.search : ''}`);
  }, [router]);

  const load = useCallback(async () => {
    try {
      const o = await api<OrderDetail>(`/v1/orders/${id}`);
      setOrder(o);
      setError(null);
      void api<CustomerRow>(`/v1/customers/${o.customerId}`)
        .then(setCustomer)
        .catch(() => setCustomer(null));
      void api<DeliveryRow[]>(`/v1/deliveries?orderId=${o.id}`)
        .then((d) => setDeliveries(Array.isArray(d) ? d : []))
        .catch(() => setDeliveries([]));
      void api<{ data: AuditRow[] }>(`/v1/audit-logs?targetType=order&targetId=${o.id}&limit=50`)
        .then((r) => setHistory(r.data))
        .catch(() => setHistory([]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    setOrder(null);
    setHistory(null);
    setPaying(false);
    setScheduling(false);
    setActionError(null);
    void load();
  }, [load]);

  useEffect(() => {
    void api<LocationRow[]>('/v1/business/locations')
      .then(setLocations)
      .catch(() => setLocations([]));
    void api<MemberRow[]>('/v1/business/members')
      .then(setMembers)
      .catch(() => setMembers([]));
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [moreOpen]);

  useEffect(() => {
    if (paying) {
      amountRef.current?.focus();
      amountRef.current?.select();
    }
  }, [paying]);

  const changed = () => {
    window.dispatchEvent(new CustomEvent('erp:orders-changed'));
  };

  async function recordPayment() {
    if (!order) return;
    const dollars = payAmount.trim() ? Number(payAmount) : order.balanceDueCents / 100;
    const cents = Math.round(dollars * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setActionError('Enter an amount.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const next = await api<OrderDetail>(`/v1/orders/${order.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          method: payMethod,
          amountCents: cents,
          processorRef: payRef.trim() || undefined,
        }),
      });
      setOrder(next);
      setPayAmount('');
      setPayRef('');
      toast.success(`${formatMoney(cents)} recorded on ${order.number}`);
      changed();
      void load();
      if (next.balanceDueCents <= 0) setPaying(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function schedule(confirmOverCapacity = false) {
    if (!order || !scheduleDate) return;
    setBusy(true);
    setActionError(null);
    try {
      await api(`/v1/orders/${order.id}/deliveries`, {
        method: 'POST',
        body: JSON.stringify({ scheduledDate: scheduleDate, confirmOverCapacity }),
      });
      toast.success(`${order.number} scheduled for ${fmtDay(scheduleDate)}`);
      setScheduling(false);
      changed();
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OVER_CAPACITY' && !confirmOverCapacity) {
        if (window.confirm(`${e.message}\n\nBook it anyway?`)) {
          setBusy(false);
          return schedule(true);
        }
      } else {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const printUrl = (kind: 'invoice' | 'delivery-ticket' | 'pick-list', scope?: string) =>
    `/print/orders/${id}/${kind}${scope ? `?scope=${scope}` : ''}`;

  // ---------------------------------------------------------------- render

  if (error && !order) {
    return (
      <SlideOver title="Order" onClose={close} testId="order-sheet">
        <ErrorState title="The order could not be loaded">
          {error}
          <div className="error-state-actions">
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </ErrorState>
      </SlideOver>
    );
  }
  if (!order) {
    return (
      <SlideOver title="…" mono onClose={close} testId="order-sheet">
        <LoadingRows rows={8} height={32} what="The order" />
      </SlideOver>
    );
  }

  const live = !order.completedAt && !order.cancelledAt;
  const locked = !!order.lockedAt || !!order.onOpenRun;
  const cancelled = !!order.cancelledAt || order.status === 'cancelled';
  const chip = chipFor(order.displayStatus ?? order.status, {
    deliveryDate: order.requestedDate,
  });
  const storeName = locations.find((l) => l.id === order.locationId)?.name ?? null;
  const rep = members.find((m) => m.membershipId === order.salespersonMembershipId)?.name ?? null;
  const customerName = customer
    ? [customer.firstName, customer.lastName].filter(Boolean).join(' ')
    : '…';
  const liveDelivery = deliveries.find((d) =>
    ['scheduled', 'loaded', 'out_for_delivery'].includes(d.status),
  );
  const promised = liveDelivery?.scheduledDate ?? order.requestedDate;
  const address = [
    order.addressLine1,
    order.addressLine2,
    [order.addressCity, order.addressRegion].filter(Boolean).join(', '),
    order.addressPostalCode,
  ]
    .filter(Boolean)
    .join(', ');
  const stockLines = order.lines.filter((l) => l.lineType !== 'custom');
  const reservedLines = stockLines.filter(
    (l) => l.qtyReserved + l.qtyFulfilled >= l.quantity,
  ).length;
  const succeeded = order.payments.filter((p) => p.status === 'succeeded');
  const meta = [
    customerName,
    storeName,
    `written ${relativeDay(order.createdAt)}${rep ? ` by ${firstName(rep)}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const balanceLine = cancelled
    ? order.paidCents > 0
      ? 'Deposit returned'
      : 'Cancelled'
    : order.balanceDueCents > 0
      ? `${formatMoney(order.balanceDueCents)} balance due`
      : order.creditDueCents > 0
        ? `${formatMoney(order.creditDueCents)} credit due`
        : 'Paid in full';

  return (
    <SlideOver
      title={<span data-testid="order-number">{order.number}</span>}
      mono
      meta={
        <>
          <StatusChip status={chip.status} label={chip.label} data-testid="order-status" />
          <span className="osh-meta">{meta}</span>
        </>
      }
      onClose={close}
      testId="order-sheet"
      className="osh"
    >
      {order.onOpenRun && (
        <div className="osh-lock is-run" data-testid="run-locked-banner">
          <span className="osh-lock-glyph" aria-hidden>
            ◷
          </span>
          <div>
            <strong>On the {fmtDay(order.onOpenRun.runDate)} delivery run.</strong> The goods are
            manifested against a truck, so nothing changes until the run closes out or the stop is
            pulled off it in Dispatch.
          </div>
        </div>
      )}
      {order.lockedAt && !order.onOpenRun && (
        <div className="osh-lock" data-testid="locked-banner">
          <span className="osh-lock-glyph" aria-hidden>
            ◷
          </span>
          <div>
            <strong>Locked — delivery ticket printed {fmtWhen(order.lockedAt)}.</strong> Lines,
            prices and addresses cannot change.{' '}
            <button
              type="button"
              className="osh-link"
              onClick={() => setUnlockOpen(true)}
              data-testid="unlock-order"
            >
              Unlock
            </button>{' '}
            (owner and store manager only; written to history).
          </div>
        </div>
      )}

      <div className="osh-actions" role="toolbar" aria-label="Order actions">
        <Button
          variant="primary"
          size="sm"
          disabled={!live || order.balanceDueCents <= 0}
          onClick={() => setPaying((v) => !v)}
          data-testid="sheet-take-payment"
          aria-expanded={paying}
        >
          Take payment
        </Button>
        {live && !locked ? (
          <LinkButton href={`/orders/${id}/full`} size="sm" data-testid="edit-lines">
            Edit lines
          </LinkButton>
        ) : (
          <Button size="sm" disabled data-testid="edit-lines">
            Edit lines
          </Button>
        )}
        {live && order.fulfillmentType === 'delivery' && (
          <Button
            size="sm"
            onClick={() => setScheduling((v) => !v)}
            data-testid="sheet-schedule-delivery"
            aria-expanded={scheduling}
          >
            {liveDelivery ? 'Reschedule delivery' : 'Schedule delivery'}
          </Button>
        )}
        <Button
          size="sm"
          onClick={() => window.open(printUrl('invoice'), '_blank', 'noopener')}
          data-testid="sheet-print"
        >
          Print
        </Button>
        <div className="osh-more" ref={moreRef}>
          <Button
            size="sm"
            onClick={() => setMoreOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            data-testid="sheet-more"
          >
            More ▾
          </Button>
          {moreOpen && (
            <div role="menu" className="menu osh-menu" aria-label="More">
              <LinkButton
                href={`/orders/${id}/full`}
                variant="ghost"
                className="menu-item"
                role="menuitem"
                data-testid="open-full-order"
              >
                Open full order page
              </LinkButton>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => window.open(printUrl('invoice', 'order'), '_blank', 'noopener')}
              >
                Invoice (this order only)
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => window.open(printUrl('delivery-ticket'), '_blank', 'noopener')}
              >
                Delivery ticket
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => window.open(printUrl('pick-list'), '_blank', 'noopener')}
              >
                Pick list
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={async () => {
                  setMoreOpen(false);
                  try {
                    const r = await api<{ path: string }>(`/v1/orders/${id}/share`, {
                      method: 'POST',
                      body: '{}',
                    });
                    await navigator.clipboard.writeText(`${window.location.origin}${r.path}`);
                    toast.success('Status link copied');
                  } catch (e) {
                    setActionError(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                Share status link
              </button>
            </div>
          )}
        </div>
        <Button
          variant="destructive"
          size="sm"
          className="osh-cancel"
          disabled={!live || locked}
          onClick={() => setCancelOpen(true)}
          data-testid="cancel-order"
        >
          Cancel order
        </Button>
      </div>

      {actionError && (
        <div className="osh-alert">
          <Alert tone="error">{actionError}</Alert>
        </div>
      )}

      {paying && live && (
        <form
          className="osh-pay"
          data-testid="sheet-pay-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void recordPayment();
          }}
        >
          <div className="osh-pay-grid">
            <Field label="Method">
              <Select
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value)}
                data-testid="sheet-pay-method"
              >
                {TENDERS.map((t) => (
                  <option key={t} value={t}>
                    {METHOD_LABEL[t] ?? t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount">
              <Input
                ref={amountRef}
                type="number"
                step="0.01"
                min={0}
                value={payAmount}
                placeholder={(order.balanceDueCents / 100).toFixed(2)}
                onChange={(e) => setPayAmount(e.target.value)}
                className="input-num reg-cell-input"
                data-testid="sheet-pay-amount"
              />
            </Field>
            <Field label={payMethod === 'card' ? 'Card last 4' : 'Reference'}>
              <Input
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                className="input-mono"
                data-testid="sheet-pay-ref"
              />
            </Field>
          </div>
          <div className="osh-pay-actions">
            <Button
              size="sm"
              onClick={() => setPayAmount((order.balanceDueCents / 100).toFixed(2))}
            >
              Pay in full
            </Button>
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={busy}
              data-testid="sheet-record-payment"
            >
              Record
              {payAmount.trim() && Number(payAmount) > 0
                ? ` ${formatMoney(Math.round(Number(payAmount) * 100))}`
                : ''}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPaying(false)}>
              Done
            </Button>
          </div>
        </form>
      )}

      {scheduling && live && (
        <form
          className="osh-pay"
          data-testid="sheet-schedule-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void schedule();
          }}
        >
          <div className="osh-pay-grid">
            <Field label={liveDelivery ? 'New delivery date' : 'Delivery date'}>
              <Input
                type="date"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                data-testid="sheet-delivery-date"
              />
            </Field>
          </div>
          <div className="osh-pay-actions">
            <Button size="sm" variant="primary" type="submit" disabled={busy || !scheduleDate}>
              {liveDelivery ? 'Move it' : 'Book it'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setScheduling(false)}>
              Done
            </Button>
          </div>
          {liveDelivery && (
            <div className="osh-hint">
              Currently {fmtDay(liveDelivery.scheduledDate)}. Moving it books a new trip and cancels
              this one.
            </div>
          )}
        </form>
      )}

      <div className="osh-summary">
        <div>
          <div className="t-label">Customer</div>
          <div className="osh-strong">{customerName}</div>
          {customer?.phone && <div className="osh-mono osh-muted">{customer.phone}</div>}
          <div className="osh-muted">{address || 'No delivery address'}</div>
        </div>
        <div>
          <div className="t-label">Fulfillment</div>
          <div className="osh-strong">
            {FULFILLMENT_LABEL[order.fulfillmentType] ?? order.fulfillmentType}
          </div>
          <div className="osh-muted">
            Promised <span className="osh-mono">{fmtDay(promised)}</span>
          </div>
          {liveDelivery?.windowStart && (
            <div className="osh-muted">
              Window {liveDelivery.windowStart}
              {liveDelivery.windowEnd ? `–${liveDelivery.windowEnd}` : ''}
            </div>
          )}
          {order.deliveryInstructions && (
            <div className="osh-muted">{order.deliveryInstructions}</div>
          )}
        </div>
        <div>
          <div className="t-label">Money</div>
          <div className="osh-total">
            <Money cents={order.totalCents} />
          </div>
          <div
            className={`osh-balance${!cancelled && order.balanceDueCents > 0 ? ' is-due' : ' is-ok'}`}
            data-testid="balance-due"
          >
            {balanceLine}
          </div>
        </div>
      </div>

      <section className="osh-section" aria-label="Lines">
        <div className="osh-section-head">
          <h3>Lines</h3>
          <span className="osh-muted">
            {stockLines.length > 0
              ? `${reservedLines} of ${pluralize(stockLines.length, 'line')} reserved`
              : 'No stock lines'}
          </span>
        </div>
        <table className="osh-table" data-testid="sheet-lines">
          <thead>
            <tr>
              <th>Item</th>
              <th>Fulfillment · from</th>
              <th className="num">Reserved</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l) => {
              const ff = FULFILLMENT_LABEL[l.fulfillmentMethod ?? order.fulfillmentType] ?? '';
              const from =
                locations.find((x) => x.id === (l.sourceLocationId ?? order.stockLocationId))
                  ?.name ?? '';
              const done = l.qtyReserved + l.qtyFulfilled;
              const ok = done >= l.quantity;
              return (
                <tr key={l.id} data-testid="sheet-line">
                  <td>
                    <span className="osh-strong-500">{l.description}</span>
                    {l.quantity > 1 && <span className="osh-mono osh-muted"> ×{l.quantity}</span>}
                  </td>
                  <td className="osh-muted">
                    {l.lineType === 'custom' ? '—' : [ff, from].filter(Boolean).join(' · ')}
                  </td>
                  <td
                    className={`num osh-mono${l.lineType === 'custom' ? '' : ok ? ' is-ok' : ' is-short'}`}
                  >
                    {l.lineType === 'custom' ? '—' : `${done} / ${l.quantity}`}
                  </td>
                  <td className="num osh-mono">
                    <Money cents={l.totalCents} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="osh-section" aria-label="Payments">
        <div className="osh-section-head">
          <h3>Payments</h3>
        </div>
        {succeeded.length === 0 ? (
          <div className="osh-muted osh-empty">No payments yet.</div>
        ) : (
          <div className="osh-payments" data-testid="sheet-payments">
            {succeeded.map((p) => (
              <div key={p.id} className="osh-payment">
                <span>
                  {METHOD_LABEL[p.method] ?? p.method}
                  {p.processorRef ? (
                    <span className="osh-mono"> ••{p.processorRef.slice(-4)}</span>
                  ) : null}
                  <span className="osh-muted">
                    {' '}
                    · {p.kind} · {fmtWhen(p.createdAt)}
                  </span>
                </span>
                <span className={`osh-mono${p.amountCents < 0 ? ' osh-muted' : ''}`}>
                  {p.amountCents < 0 ? '−' : ''}
                  <Money cents={Math.abs(p.amountCents)} />
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="osh-section" aria-label="Change history">
        <div className="osh-section-head">
          <h3>Change history</h3>
        </div>
        {history === null ? (
          <LoadingRows rows={3} height={28} what="History" />
        ) : history.length === 0 ? (
          <div className="osh-muted osh-empty">No events recorded.</div>
        ) : (
          <ol className="osh-timeline" data-testid="order-timeline">
            {history.map((h) => {
              const d = describe(h);
              return (
                <li key={h.id} className="osh-event">
                  <div className="osh-event-rail">
                    <span className={`osh-dot is-${d.tone}`} aria-hidden />
                    <span className="osh-line" aria-hidden />
                  </div>
                  <div className="osh-event-body">
                    <div>
                      <span className="osh-strong">{d.what}</span>
                      <span className="osh-muted"> · {h.actorEmail ?? 'System'}</span>
                    </div>
                    {d.detail && <div className="osh-muted">{d.detail}</div>}
                    <div className="osh-mono osh-when">{fmtWhen(h.createdAt)}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <SecurityOverrideDialog
        open={unlockOpen}
        title={`Unlock order ${order.number}`}
        usageClass="exception"
        submitLabel="Unlock order"
        perform={async (payload) => {
          await api(`/v1/orders/${order.id}/unlock`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }}
        onClose={() => setUnlockOpen(false)}
        onSuccess={() => {
          setUnlockOpen(false);
          toast.success(`${order.number} unlocked for 15 minutes`);
          changed();
          void load();
        }}
      />

      {cancelOpen && (
        <CancelOrderDialog
          order={order}
          customerName={customerName}
          deliveryDate={liveDelivery?.scheduledDate ?? null}
          onClose={() => setCancelOpen(false)}
          onDone={() => {
            setCancelOpen(false);
            toast.success(`${order.number} cancelled`);
            changed();
            void load();
          }}
        />
      )}
    </SlideOver>
  );
}
