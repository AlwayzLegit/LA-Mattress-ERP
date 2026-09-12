'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Field, StatusChip } from '@/components/ui';
import type { StatusKey } from '@/lib/design-tokens';
import { api } from '@/lib/api';
import { usdWhole } from '../owner/owner-kit';
import { dayShort, plural, stamp } from './kit';
import type { CashPickupQueue, CashPickupStore, PickupStatus, PostPickupResult } from './types';

/**
 * Cash pickups (redesign Phase 9, README §3.5, canvas 8). Every store
 * holds the cash it took until somebody carries it out. The queue at the
 * top of the owner and Operations homes says how much each store has on
 * hand since its last pickup and whether a pickup is due (> $1,500 on
 * hand, or any cash payment older than 3 days); the panel on each store
 * card lists the payments, lets the poster tick the ones they are taking
 * (none ticked = all), and runs Record → Counted / Slip # / variance →
 * Post. Posting stamps every payment with who and when, issues PU-nnnn,
 * and any variance lands on the 10pm exception register.
 */

export const PICKUP_CHIP: Record<PickupStatus, { status: StatusKey; label: string }> = {
  collected: { status: 'fulfilled', label: 'Collected' },
  due: { status: 'risk', label: 'Pickup due' },
  holding: { status: 'waiting', label: 'Holding' },
  none: { status: 'draft', label: 'No cash' },
};

export function PickupChip({ status }: { status: PickupStatus }) {
  const c = PICKUP_CHIP[status];
  return <StatusChip status={c.status} label={c.label} data-testid="pickup-chip" />;
}

/** "$1,234.56" with cents, for counts and slips. */
export function usdCents(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "+$12.00" / "−$84.50" / "balanced". */
export function varianceLabel(cents: number): string {
  if (cents === 0) return 'balanced';
  return `${cents > 0 ? '+' : '−'}${usdCents(cents)}`;
}

/** Parse a typed dollar amount ("1,240.17") into cents; null when not a number. */
export function parseDollars(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

interface RecordState {
  counted: string;
  slip: string;
}

/**
 * One source of truth for the queue, the ticks, and the recording
 * forms across every store card on a page. `locationIds` narrows the
 * stores (null = every store the member may see).
 */
export function useCashPickups(locationIds: string[] | null) {
  const [queue, setQueue] = useState<CashPickupQueue | null | undefined>(undefined);
  const [ticks, setTicks] = useState<Record<string, Set<string>>>({});
  const [recording, setRecording] = useState<Record<string, RecordState | undefined>>({});
  const [posting, setPosting] = useState<string | null>(null);
  const scopeKey = locationIds ? locationIds.join(',') : '';

  const load = useCallback(() => {
    const qs = scopeKey ? `?locationIds=${encodeURIComponent(scopeKey)}` : '';
    return api<CashPickupQueue>(`/v1/dashboard/cash-pickups/queue${qs}`)
      .then(setQueue)
      .catch(() => setQueue((q) => (q === undefined ? null : q)));
  }, [scopeKey]);
  useEffect(() => {
    void load();
  }, [load]);

  const storeOf = useCallback(
    (locationId: string): CashPickupStore | null =>
      queue?.stores.find((s) => s.locationId === locationId) ?? null,
    [queue],
  );

  const ticked = useCallback(
    (locationId: string): Set<string> => ticks[locationId] ?? new Set<string>(),
    [ticks],
  );

  /** The payments a Record would count: the ticked ones, or all when none are ticked. */
  const toPick = useCallback(
    (locationId: string) => {
      const store = storeOf(locationId);
      if (!store) return [];
      const t = ticked(locationId);
      const chosen = store.payments.filter((p) => t.has(p.paymentId));
      return chosen.length > 0 ? chosen : store.payments;
    },
    [storeOf, ticked],
  );

  const tick = (locationId: string, paymentId: string) =>
    setTicks((prev) => {
      const next = new Set(prev[locationId] ?? []);
      if (next.has(paymentId)) next.delete(paymentId);
      else next.add(paymentId);
      return { ...prev, [locationId]: next };
    });

  const tickAll = (locationId: string) =>
    setTicks((prev) => {
      const store = storeOf(locationId);
      if (!store) return prev;
      const all = store.payments.every((p) => prev[locationId]?.has(p.paymentId));
      return {
        ...prev,
        [locationId]: all ? new Set() : new Set(store.payments.map((p) => p.paymentId)),
      };
    });

  const startRecord = (locationId: string) => {
    const store = storeOf(locationId);
    if (!store || store.payments.length === 0) return;
    const expected = toPick(locationId).reduce((n, p) => n + p.amountCents, 0);
    setRecording((r) => ({
      ...r,
      [locationId]: { counted: (expected / 100).toFixed(2), slip: '' },
    }));
  };
  const cancelRecord = (locationId: string) =>
    setRecording((r) => ({ ...r, [locationId]: undefined }));
  const setCounted = (locationId: string, counted: string) =>
    setRecording((r) => ({
      ...r,
      [locationId]: { counted, slip: r[locationId]?.slip ?? '' },
    }));
  const setSlip = (locationId: string, slip: string) =>
    setRecording((r) => ({
      ...r,
      [locationId]: { counted: r[locationId]?.counted ?? '', slip },
    }));

  const post = async (locationId: string): Promise<PostPickupResult | null> => {
    const store = storeOf(locationId);
    const form = recording[locationId];
    if (!store || !form) return null;
    const counted = parseDollars(form.counted);
    if (counted == null) {
      toast.error('Enter the amount you counted');
      return null;
    }
    const chosen = toPick(locationId);
    const allChosen = chosen.length === store.payments.length;
    setPosting(locationId);
    try {
      const r = await api<PostPickupResult>('/v1/dashboard/cash-pickups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId,
          paymentIds: allChosen ? [] : chosen.map((p) => p.paymentId),
          countedCents: counted,
          slip: form.slip.trim() || undefined,
        }),
      });
      setQueue((q) =>
        q
          ? {
              ...q,
              stores: q.stores.map((s) => (s.locationId === locationId ? r.store : s)),
              totals: {
                ...q.totals,
                pendingCents: q.stores.reduce(
                  (n, s) => n + (s.locationId === locationId ? r.store : s).pendingCents,
                  0,
                ),
                dueCount: q.stores.filter(
                  (s) => (s.locationId === locationId ? r.store : s).status === 'due',
                ).length,
                holdingCount: q.stores.filter(
                  (s) => (s.locationId === locationId ? r.store : s).status === 'holding',
                ).length,
              },
            }
          : q,
      );
      setTicks((t) => ({ ...t, [locationId]: new Set() }));
      setRecording((f) => ({ ...f, [locationId]: undefined }));
      const v = r.pickup.varianceCents;
      toast.success(
        `${r.pickup.number} · ${usdCents(r.pickup.countedCents)} picked up from ${store.name} by ${r.pickup.byName}${v ? ` · variance ${varianceLabel(v)} flagged` : ' · balanced'}`,
      );
      return r;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setPosting(null);
    }
  };

  return {
    queue,
    reload: load,
    storeOf,
    ticked,
    toPick,
    tick,
    tickAll,
    recording,
    startRecord,
    cancelRecord,
    setCounted,
    setSlip,
    post,
    posting,
  };
}

export type CashPickupsApi = ReturnType<typeof useCashPickups>;

/**
 * The cross-store queue (owner and Operations): every store, due first,
 * with cash on hand, payment count, oldest note, last pickup and status.
 * "Record pickup" opens that store's card and starts the recording form.
 */
export function CashPickupsQueue({
  cp,
  onRecord,
  handle,
  style,
}: {
  cp: CashPickupsApi;
  /** Open the store card and start recording (the section scrolls to it). */
  onRecord: (locationId: string) => void;
  handle?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const q = cp.queue;
  const rows = useMemo(
    () =>
      [...(q?.stores ?? [])].sort(
        (a, b) =>
          Number(b.status === 'due') - Number(a.status === 'due') ||
          b.pendingCents - a.pendingCents ||
          a.name.localeCompare(b.name),
      ),
    [q],
  );
  if (q === null) return null;
  const due = q?.totals.dueCount ?? 0;
  const tone = due > 0 ? 'is-due' : (q?.totals.pendingCents ?? 0) > 0 ? 'is-holding' : 'is-ok';
  return (
    <section
      className={`panel panel-clip cq ${tone}`}
      style={style}
      data-testid="cash-pickups-queue"
    >
      <div className="panel-head">
        <h2>Cash pickups</h2>
        <span className="panel-sub">
          {q ? (due > 0 ? plural(due, 'pickup') + ' due' : 'nothing due') : '…'}
        </span>
        <span className="cq-total">
          <span className="cq-total-amt mono" data-testid="cq-total">
            {q ? usdWhole(q.totals.pendingCents) : '—'}
          </span>
          <span className="panel-sub">
            on hand across {q ? plural(q.totals.storeCount, 'store') : '…'}
          </span>
        </span>
        {handle}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="cq-table" data-testid="cq-table">
          <thead>
            <tr>
              <th>Store</th>
              <th className="num">Cash on hand</th>
              <th className="num">Payments</th>
              <th>Oldest</th>
              <th>Last pickup</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q === undefined && (
              <tr>
                <td colSpan={7}>
                  <div className="shimmer" style={{ height: 14, width: '60%' }} />
                </td>
              </tr>
            )}
            {q && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="cq-empty">
                  No selling stores in scope.
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <tr
                key={s.locationId}
                className={s.status === 'due' ? 'is-due' : undefined}
                data-testid="cq-row"
                data-status={s.status}
              >
                <td style={{ fontWeight: 500 }}>{s.name}</td>
                <td
                  className="num"
                  style={{
                    fontWeight: 600,
                    color:
                      s.status === 'due'
                        ? 'var(--status-risk-fg)'
                        : s.pendingCents
                          ? 'var(--text)'
                          : 'var(--faint)',
                  }}
                >
                  {usdWhole(s.pendingCents)}
                </td>
                <td className="num" style={{ color: 'var(--text2)' }}>
                  {s.pendingCount}
                </td>
                <td className="mono" style={{ color: 'var(--text2)' }}>
                  {s.pendingCount === 0 ? '—' : s.oldestDays ? `${s.oldestDays}d` : 'today'}
                </td>
                <td style={{ color: 'var(--text2)' }}>
                  {s.lastPickup
                    ? `${dayShort(s.lastPickup.recordedAt, s.timezone)} · ${s.lastPickup.number}`
                    : 'never'}
                </td>
                <td>
                  <PickupChip status={s.status} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${s.pendingCents ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => onRecord(s.locationId)}
                    disabled={s.pendingCents > 0 && !s.canRecord}
                    title={
                      s.pendingCents > 0 && !s.canRecord
                        ? 'Only the owner, Operations or this store’s manager records a pickup'
                        : undefined
                    }
                    data-testid="cq-record"
                  >
                    {s.pendingCents ? 'Record pickup' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-foot cq-rule">
        Pickup is <strong>due</strong> when a store holds more than{' '}
        <span className="mono">{usdWhole(q?.rule.dueCents ?? 150_000)}</span> or any cash payment is
        older than {q?.rule.dueDays ?? 3} days. Recording a pickup counts the drawer against the
        ticked payments and writes a slip; any variance goes to the 10pm exceptions.
      </div>
    </section>
  );
}

/**
 * The store card's cash column: amount + status chip, the last-pickup
 * line, one tick row per cash payment waiting, then Record pickup /
 * Tick all — or the recording form with Counted, Slip # and the variance.
 */
export function CashOnHandPanel({
  cp,
  locationId,
  actorName,
}: {
  cp: CashPickupsApi;
  locationId: string;
  /** Who will be stamped on the pickup ("by Maya Torres"). */
  actorName?: string | null;
}) {
  const store = cp.storeOf(locationId);
  const form = cp.recording[locationId];
  const countedRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (form) countedRef.current?.focus();
  }, [form]);

  if (cp.queue === undefined) {
    return (
      <div className="coh" data-testid="cash-pickup">
        <div className="shimmer" style={{ height: 14, width: '70%' }} />
      </div>
    );
  }
  if (!store) {
    return (
      <div className="coh" data-testid="cash-pickup">
        <div className="eyebrow">Cash on hand</div>
        <div className="coh-empty">Cash on hand is unavailable right now.</div>
      </div>
    );
  }

  const t = cp.ticked(locationId);
  const chosen = cp.toPick(locationId);
  const expected = chosen.reduce((n, p) => n + p.amountCents, 0);
  const allTicked = store.payments.length > 0 && store.payments.every((p) => t.has(p.paymentId));
  const counted = form ? parseDollars(form.counted) : null;
  const variance = form && counted != null ? counted - expected : null;
  const lp = store.lastPickup;
  const amountColor =
    store.status === 'due'
      ? 'var(--status-risk-fg)'
      : store.status === 'holding'
        ? 'var(--status-waiting-fg)'
        : 'var(--status-fulfilled-fg)';

  return (
    <div
      className={`coh is-${store.status}`}
      data-testid="cash-pickup"
      data-status={store.status}
      data-location-id={locationId}
    >
      <div className="coh-head">
        <span className="eyebrow">Cash on hand</span>
        <span className="coh-amt mono" style={{ color: amountColor }} data-testid="coh-amount">
          {usdWhole(store.pendingCents)}
        </span>
        <PickupChip status={store.status} />
      </div>
      <div className="coh-last" data-testid="coh-last">
        {lp
          ? `Last pickup ${dayShort(lp.recordedAt, store.timezone)} · ${lp.byName} · ${usdCents(lp.countedCents)}${lp.slip ? ` · slip ${lp.slip}` : ''}${lp.varianceCents ? ` · variance ${varianceLabel(lp.varianceCents)}` : ''}`
          : 'No pickup recorded yet'}
        {store.pendingCount > 0
          ? ` · ${plural(store.pendingCount, 'cash payment')} since${
              store.oldestDays && store.oldestDays > 0 ? ` · oldest ${store.oldestDays}d` : ''
            }`
          : ''}
      </div>

      {store.payments.length === 0 ? (
        <div className="coh-empty">No cash in the drawer since the last pickup.</div>
      ) : (
        <div className="coh-list">
          {store.payments.map((p) => {
            const on = t.has(p.paymentId);
            return (
              <label
                key={p.paymentId}
                className={`coh-row${on ? ' is-ticked' : ''}`}
                data-testid="cash-pickup-row"
                style={{ cursor: store.canRecord ? 'pointer' : 'default' }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!store.canRecord || !!form}
                  onChange={() => cp.tick(locationId, p.paymentId)}
                  style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
                  aria-label={`Tick ${p.docNumber} cash ${usdCents(p.amountCents)}`}
                />
                <span className="coh-row-main">
                  <span className="mono">{p.docNumber}</span>
                  <span className="coh-row-meta">
                    {' '}
                    · {p.customerName ??
                      (p.docKind === 'sale' ? 'Register sale' : 'Walk-in')} ·{' '}
                    {dayShort(p.paidAt, store.timezone)} ·{' '}
                    {p.ageDays > 3 ? (
                      <span style={{ color: 'var(--status-risk-fg)' }}>{p.ageDays}d old</span>
                    ) : (
                      'in drawer'
                    )}
                  </span>
                </span>
                <span className="mono coh-row-amt">{usdWhole(p.amountCents)}</span>
              </label>
            );
          })}
        </div>
      )}

      {store.canRecord && store.payments.length > 0 && !form && (
        <div className="coh-actions" data-noprint="true">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => cp.startRecord(locationId)}
            data-testid="coh-record"
          >
            {t.size > 0 && t.size < store.payments.length
              ? `Record pickup · ${t.size} ticked`
              : 'Record pickup'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => cp.tickAll(locationId)}
            data-testid="coh-tick-all"
          >
            {allTicked ? 'Clear ticks' : 'Tick all'}
          </button>
        </div>
      )}

      {form && (
        <div className="coh-form" data-testid="coh-form">
          <div className="coh-form-line">
            Picking up <strong className="mono">{usdCents(expected)}</strong> from{' '}
            {plural(chosen.length, 'payment')}
            {actorName ? ` · by ${actorName}` : ''}
          </div>
          <div className="coh-form-grid">
            <Field label="Counted">
              <input
                ref={countedRef}
                className="input mono"
                inputMode="decimal"
                value={form.counted}
                onChange={(e) => cp.setCounted(locationId, e.target.value)}
                style={{ textAlign: 'right' }}
                aria-label="Counted"
                data-testid="coh-counted"
              />
            </Field>
            <Field label="Slip #">
              <input
                className="input"
                value={form.slip}
                onChange={(e) => cp.setSlip(locationId, e.target.value)}
                placeholder="bank bag / envelope"
                maxLength={40}
                aria-label="Slip number"
                data-testid="coh-slip"
              />
            </Field>
          </div>
          {variance != null && variance !== 0 && (
            <div className="coh-variance" role="status" data-testid="coh-variance">
              ▲ Variance {varianceLabel(variance)} — will be flagged to the 10pm exceptions with
              your name.
            </div>
          )}
          {counted == null && (
            <div className="coh-variance" role="status">
              Enter the amount you counted.
            </div>
          )}
          <div className="coh-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={counted == null || cp.posting === locationId}
              onClick={() => void cp.post(locationId)}
              data-testid="coh-post"
            >
              Post pickup
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => cp.cancelRecord(locationId)}
              data-testid="coh-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {lp && store.payments.length === 0 && (
        <div className="coh-history">
          {plural(lp.paymentCount, 'payment')} picked up {stamp(lp.recordedAt, store.timezone)}
        </div>
      )}
    </div>
  );
}
