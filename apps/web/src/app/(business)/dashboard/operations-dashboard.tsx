'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Alert, LinkButton } from '@/components/ui';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import { ConfirmDialog } from '@/components/shell/confirm-dialog';
import { api } from '@/lib/api';
import { formatRange, presetLabel, type DateRange } from '@/lib/date-range';
import { usd } from './dashboard-kit';
import { EmptyRow, Panel, ShimmerRows, usdWhole } from './owner/owner-kit';
import { StaffSchedule } from './shared/staff-schedule';
import { StoresSection } from './shared/stores-section';
import { TimeClockStrip } from './shared/time-clock-strip';

/**
 * The Operations home (owner 2026-08-31; Claude Design hand-off 2026-09-04).
 *
 * Exception-first, not selling-first: the page opens on what needs a
 * person today, and the numbers sit underneath. Every store, always —
 * there is no store picker, because the whole point of the role is
 * watching all of them at once. No goal or commission tiles: this
 * member sells occasionally and carries neither.
 *
 * Layout (reworked 2026-09-10): one card per store — salespeople, money
 * received by tender, cash awaiting pickup with the tick that says the
 * cash was handed over — then the feed panel (its border turns danger
 * while a critical row is on it). The tender split, the 14-day chart,
 * the salesperson table, the by-person digest and the store activity
 * log sit below as panels. Discount rows stay off this feed (owner
 * 2026-09-10); the threshold still lives under Settings → Operations.
 *
 * Each card fetches on its own and hides itself on a 403, so a member
 * with a narrower grant sees a smaller page rather than an error.
 */

type Severity = 'critical' | 'warning' | 'info';

interface FeedRow {
  subjectType: string;
  subjectId: string;
  severity: Severity;
  kind: string;
  summary: string;
  amountCents: number | null;
  actorUserId: string | null;
  actorName: string | null;
  locationId: string | null;
  locationName: string | null;
  href: string | null;
  occurredAt: string;
  clearVia: 'exception' | 'review';
}

interface Thresholds {
  refundCents: number;
  discountPct: number;
  overrideCents: number;
  drawerVarianceCents: number;
  inventoryAdjustUnits: number;
  takeWithOpenHours: number;
  lookbackDays: number;
}

interface StoreDocument {
  id: string;
  kind: 'order' | 'sale';
  number: string;
  customerName: string | null;
  writtenCents: number;
  merchandiseCents: number;
  costCents: number;
  profitCents: number;
}
interface StoreRow {
  locationId: string;
  locationName: string;
  writtenCents: number;
  writtenCount: number;
  collectedCents: number;
  refundedCents: number;
  costCents: number;
  profitCents: number;
  documents: StoreDocument[];
}

interface RitualRow {
  locationId: string;
  locationName: string;
  date: string;
  drawerOpen: boolean;
  drawerClosed: boolean;
  drawerSuspended: boolean;
  varianceCents: number | null;
  closeoutRan: boolean;
  closeoutExceptions: number;
}

interface Summary {
  date: string;
  /** The window the money block and byStore were scoped to (echoed by the API). */
  range: { start: string; end: string };
  stores: { id: string; name: string; timezone: string }[];
  money: {
    inCents: number;
    outCents: number;
    netCents: number;
    byTender: { method: string; cents: number; count: number }[];
    out: { refundsCents: number; returnsCents: number; writeOffsCents: number };
    exchanges: { count: number; restockingFeeCents: number };
  };
  salesByDay: { day: string; writtenCents: number }[];
  byStore: StoreRow[];
  ritual: RitualRow[];
}

interface SalespersonRow {
  key: string;
  name: string;
  writtenCents: number;
  writtenCount: number;
  collectedCents: number;
  refundedCents: number;
  discountCents: number;
  discountPct: number;
}

interface DigestRow {
  actorUserId: string | null;
  actorName: string | null;
  total: number;
  amountCents: number;
  byKind: Record<string, number>;
  worstSeverity: Severity;
}

interface ActivityGroup {
  orderId: string;
  orderNumber: string;
  latestAt: string;
  events: { action: string; actorName: string | null; createdAt: string }[];
}

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'var(--danger)',
  warning: 'var(--warn)',
  info: 'var(--muted)',
};

function subjectKey(r: { subjectType: string; subjectId: string }): string {
  return `${r.subjectType}:${r.subjectId}`;
}

/** "today" / "last 7 days" / "Aug 4 – Sep 2, 2026" — for use inside a heading. */
function windowLabel(range: DateRange): string {
  if (range.preset === 'today') return 'today';
  const label = presetLabel(range.preset);
  return label === 'Custom' ? formatRange(range) : label.toLowerCase();
}

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "−$84.50" / "$12.00" — a signed exact amount for variances. */
/** The severity dot: colour is the data. */
function SeverityDot({ severity }: { severity: Severity }) {
  return (
    <span
      title={severity}
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: SEVERITY_COLOR[severity],
        flex: 'none',
        verticalAlign: 'middle',
      }}
    />
  );
}

const MUTED_CELL: CSSProperties = { color: 'var(--text2)' };

export default function OperationsDashboardView({ userName }: { userName: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedRow[] | null>(null);
  const [feedTotal, setFeedTotal] = useState(0);
  // Thresholds ride on the /feed response — the summary stays cheap.
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [salespeople, setSalespeople] = useState<SalespersonRow[] | null>(null);
  const [digest, setDigest] = useState<DigestRow[] | null>(null);
  const [activity, setActivity] = useState<ActivityGroup[] | null>(null);
  // Page window (owner 2026-09-02): scopes the money block and "By store";
  // the salesperson card carries its own window. Both live in the URL.
  const [range, setRange, rangeReady] = useUrlDateRange('today');
  const [spRange, setSpRange, spReady] = useUrlDateRange('last30', { key: 'salespeople' });
  const summarySeq = useRef(0);
  const spSeq = useRef(0);

  const loadFeed = useCallback(async () => {
    try {
      const r = await api<{ rows: FeedRow[]; total: number; thresholds: Thresholds }>(
        '/v1/dashboard/operations/feed?limit=100',
      );
      // Owner 2026-09-10: "Discount over N%" rows come off this home. The
      // API still emits them for Settings and the exceptions page.
      const rows = r.rows.filter((row) => row.subjectType !== 'discount');
      setFeed(rows);
      setFeedTotal(Math.max(0, r.total - (r.rows.length - rows.length)));
      setThresholds(r.thresholds);
    } catch {
      setFeed([]);
      setFeedTotal(0);
    }
  }, []);

  // Summary follows the page window; a sequence counter drops a stale
  // response that resolves after a newer window's.
  useEffect(() => {
    if (!rangeReady) return;
    const seq = ++summarySeq.current;
    void api<Summary>(`/v1/dashboard/operations?start=${range.start}&end=${range.end}`)
      .then((s) => {
        if (summarySeq.current !== seq) return;
        setSummary(s);
      })
      .catch((err: unknown) => {
        if (summarySeq.current !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [rangeReady, range.start, range.end]);

  useEffect(() => {
    if (!spReady) return;
    const seq = ++spSeq.current;
    setSalespeople(null);
    void api<SalespersonRow[]>(
      `/v1/dashboard/operations/salespeople?start=${spRange.start}&end=${spRange.end}`,
    )
      .then((rows) => {
        if (spSeq.current !== seq) return;
        setSalespeople(rows);
      })
      .catch(() => {
        if (spSeq.current !== seq) return;
        setSalespeople(null);
      });
  }, [spReady, spRange.start, spRange.end]);

  useEffect(() => {
    void loadFeed();
    void api<DigestRow[]>('/v1/dashboard/operations/digest')
      .then(setDigest)
      .catch(() => setDigest(null));
    void api<ActivityGroup[]>('/v1/dashboard/operations/activity?limit=60')
      .then(setActivity)
      .catch(() => setActivity(null));
  }, [loadFeed]);

  async function clearSelected() {
    if (!feed || selected.size === 0) return;
    setClearing(true);
    setClearError(null);
    const subjects = feed
      .filter((r) => selected.has(subjectKey(r)))
      .map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId }));
    try {
      await api('/v1/ops-reviews/bulk', {
        method: 'POST',
        body: JSON.stringify({ subjects }),
      });
      setSelected(new Set());
      setConfirmClear(false);
      await loadFeed();
    } catch (err) {
      setConfirmClear(false);
      setClearError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }

  const loading = !summary;
  const money = summary?.money;

  const critical = (feed ?? []).filter((r) => r.severity === 'critical').length;
  const hasCritical = critical > 0;
  const feedTitle =
    feedTotal === 0
      ? 'Nothing needs you today'
      : `${feedTotal} thing${feedTotal === 1 ? '' : 's'} need${feedTotal === 1 ? 's' : ''} you today`;

  const pageSub = `${summary?.date ?? '—'} · every store · exception-first`;

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h1 className="page-title">Operations</h1>
        <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3 }}>
          {pageSub}
          <span style={{ marginLeft: 8, color: 'var(--faint)' }}>· {userName}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} data-noprint="true">
        <DateRangePicker value={range} onChange={setRange} align="right" testid="ops-range" />
        <LinkButton variant="primary" href="/orders/new">
          New Sale
        </LinkButton>
      </div>
    </div>
  );

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <TimeClockStrip />
        {header}
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
      data-testid="operations-dashboard"
    >
      <TimeClockStrip />
      {header}

      {/* ---- Store cards (hand-off 2026-09-10): every store, month to date or today ---- */}
      <StoresSection locationIds={null} />

      {/* ---- The feed. Everything else on this page is context for it. ---- */}
      <Panel
        title={feedTitle}
        sub={`refunds, overrides, adjustments and drawer counts in the last ${thresholds?.lookbackDays ?? 7} days`}
        style={hasCritical ? { borderColor: 'var(--danger)' } : undefined}
        testid="ops-feed"
        actions={
          feed && feed.length > 0 ? (
            <>
              <label
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12.5,
                  color: 'var(--text2)',
                }}
              >
                <input
                  type="checkbox"
                  data-testid="ops-feed-select-all"
                  style={{ accentColor: 'var(--accent)' }}
                  checked={selected.size === feed.length && feed.length > 0}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(feed.map(subjectKey)) : new Set())
                  }
                />
                Select all
              </label>
              <button
                type="button"
                className="topbar-btn"
                data-testid="ops-feed-clear"
                disabled={selected.size === 0 || clearing}
                style={{ opacity: selected.size === 0 ? 0.5 : 1 }}
                onClick={() => setConfirmClear(true)}
              >
                {clearing ? 'Clearing…' : 'Clear selected'}{' '}
                <span className="mono" style={{ color: 'var(--muted)' }}>
                  {selected.size}
                </span>
              </button>
            </>
          ) : undefined
        }
      >
        {feed == null ? (
          <ShimmerRows rows={4} />
        ) : feed.length === 0 ? (
          <EmptyRow>
            Every refund, override, adjustment and drawer count in the last{' '}
            {thresholds?.lookbackDays ?? 7} days has been reviewed.
          </EmptyRow>
        ) : (
          <>
            {clearError && (
              <div style={{ padding: '8px var(--pad) 0' }}>
                <Alert tone="error">{clearError}</Alert>
              </div>
            )}
            <div style={{ maxHeight: 380, overflow: 'auto' }}>
              <table className="dt">
                <thead>
                  <tr>
                    <th className="first" style={{ width: 34, top: 0 }} aria-label="Select" />
                    <th style={{ top: 0 }}>What</th>
                    <th style={{ top: 0 }}>Who</th>
                    <th style={{ top: 0 }}>Store</th>
                    <th className="num" style={{ top: 0 }}>
                      Amount
                    </th>
                    <th style={{ top: 0 }}>When</th>
                    <th className="last" style={{ top: 0 }} aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {feed.map((r) => {
                    const key = subjectKey(r);
                    const checked = selected.has(key);
                    return (
                      <tr
                        key={key}
                        data-testid="ops-feed-row"
                        className={checked ? 'is-checked' : undefined}
                      >
                        <td className="first">
                          <input
                            type="checkbox"
                            aria-label={`Clear ${r.kind}`}
                            style={{ accentColor: 'var(--accent)' }}
                            checked={checked}
                            onChange={(e) =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(key);
                                else next.delete(key);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td style={{ whiteSpace: 'normal' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            <SeverityDot severity={r.severity} />
                            <span style={{ fontWeight: 500 }}>{r.kind}</span>
                          </div>
                          <div style={{ color: 'var(--muted)', fontSize: 12, paddingLeft: 14 }}>
                            {r.summary}
                          </div>
                        </td>
                        <td style={MUTED_CELL}>{r.actorName ?? '—'}</td>
                        <td style={MUTED_CELL}>{r.locationName ?? '—'}</td>
                        <td
                          className="num"
                          style={{
                            color: (r.amountCents ?? 0) < 0 ? 'var(--danger)' : 'var(--text)',
                          }}
                        >
                          {r.amountCents == null ? '' : usd(r.amountCents)}
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                          {ago(r.occurredAt)}
                        </td>
                        <td className="last" style={{ textAlign: 'right' }}>
                          {r.href && (
                            <Link
                              href={r.href}
                              className="topbar-btn"
                              style={{ padding: '3px 9px', fontSize: 12, fontWeight: 400 }}
                            >
                              Open
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="panel-foot" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {feedTotal > feed.length && (
                <span>
                  Showing {feed.length} of {feedTotal}. Clear some to see the rest.
                </span>
              )}
              <span style={{ marginLeft: 'auto' }}>
                Clearing records your name and the time — it does not approve anything.
              </span>
            </div>
          </>
        )}
      </Panel>

      {/* ---- Tender split beside the 14-day written chart ---- */}
      <div
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}
        className="ops-grid"
      >
        <Panel title="Money in by tender" sub={`${windowLabel(range)} · every store`}>
          {loading ? (
            <ShimmerRows rows={3} />
          ) : money && money.byTender.length === 0 ? (
            <EmptyRow>
              {range.preset === 'today'
                ? 'Nothing collected yet today.'
                : 'Nothing collected in the window.'}
            </EmptyRow>
          ) : (
            <table className="dt dt-static">
              <thead>
                <tr>
                  <th className="first">Tender</th>
                  <th className="num">Count</th>
                  <th className="num last">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(money?.byTender ?? []).map((t) => (
                  <tr key={t.method}>
                    <td className="first" style={{ textTransform: 'capitalize' }}>
                      {t.method.replace(/_/g, ' ')}
                    </td>
                    <td className="num" style={{ color: 'var(--muted)' }}>
                      ×{t.count}
                    </td>
                    <td className="num last">{usd(t.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Written business" sub="14 days · every store" clip={false}>
          <div className="panel-body">
            {loading ? (
              <div className="shimmer" style={{ height: 110 }} />
            ) : (
              <SalesByDayChart points={summary.salesByDay} />
            )}
          </div>
        </Panel>
      </div>

      {/* ---- Every salesperson ---- */}
      <Panel
        title="By salesperson"
        sub={windowLabel(spRange)}
        actions={
          <div style={{ marginLeft: 'auto' }} data-noprint="true">
            <DateRangePicker
              compact
              align="right"
              value={spRange}
              onChange={setSpRange}
              testid="ops-salespeople-range"
            />
          </div>
        }
      >
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {salespeople == null ? (
            <ShimmerRows rows={4} />
          ) : (
            <ScrollTable
              head={['Salesperson', 'Written', 'Sales', 'Collected', 'Refunded', 'Discount']}
              align={['left', 'right', 'right', 'right', 'right', 'right']}
              rows={salespeople.map((s) => [
                s.name,
                usd(s.writtenCents),
                String(s.writtenCount),
                usd(s.collectedCents),
                s.refundedCents > 0 ? usd(s.refundedCents) : '—',
                `${s.discountPct}%`,
              ])}
              empty="Nobody has written business in the window."
              testid="ops-by-salesperson"
            />
          )}
        </div>
      </Panel>

      {/* ---- Who is generating the exceptions, and what changed on orders ---- */}
      <div
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}
        className="ops-grid"
      >
        <Panel
          title="Flagged activity by person"
          sub={`last ${thresholds?.lookbackDays ?? 7} days`}
        >
          {digest == null ? (
            <ShimmerRows rows={3} />
          ) : digest.length === 0 ? (
            <EmptyRow>Nobody has tripped a threshold in the window.</EmptyRow>
          ) : (
            <table className="dt dt-static">
              <thead>
                <tr>
                  <th className="first">Who</th>
                  <th>Flags</th>
                  <th className="num last">Amount</th>
                </tr>
              </thead>
              <tbody>
                {digest.map((d) => (
                  <tr key={d.actorUserId ?? 'system'}>
                    <td className="first">
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <SeverityDot severity={d.worstSeverity} />
                        <span style={{ fontWeight: 500 }}>{d.actorName ?? 'System'}</span>
                      </span>
                    </td>
                    <td style={{ color: 'var(--muted)', whiteSpace: 'normal' }}>
                      {Object.entries(d.byKind)
                        .map(([kind, n]) => `${n} × ${kind.toLowerCase()}`)
                        .join(' · ')}
                    </td>
                    <td className="num last">{d.amountCents > 0 ? usd(d.amountCents) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Store activity"
          sub="grouped by order"
          link={{ href: '/audit', label: 'Audit log' }}
        >
          {activity == null ? (
            <ShimmerRows rows={4} />
          ) : activity.length === 0 ? (
            <EmptyRow>No order changes recorded yet.</EmptyRow>
          ) : (
            <div style={{ maxHeight: 340, overflow: 'auto' }}>
              <table className="dt dt-static">
                <thead>
                  <tr>
                    <th className="first">Order</th>
                    <th>Changes</th>
                    <th className="num last">Latest</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((g) => (
                    <tr key={g.orderId}>
                      <td className="first mono">
                        <Link href={`/orders/${g.orderId}`}>{g.orderNumber}</Link>
                      </td>
                      <td style={{ color: 'var(--muted)', whiteSpace: 'normal' }}>
                        {g.events
                          .slice(0, 4)
                          .map((e) => `${e.action}${e.actorName ? ` (${e.actorName})` : ''}`)
                          .join(' · ')}
                        {g.events.length > 4 ? ` +${g.events.length - 4} more` : ''}
                      </td>
                      <td className="num last" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                        {ago(g.latestAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* ---- Staff schedule (step 2): every location, editable ---- */}
      <StaffSchedule />

      {confirmClear && (
        <ConfirmDialog
          title={`Clear ${selected.size} flagged item${selected.size === 1 ? '' : 's'}?`}
          confirmLabel="Clear items"
          busy={clearing}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void clearSelected()}
          testid="ops-feed-clear-confirm"
        >
          <p style={{ margin: 0 }}>
            Clearing records your name and the time. It does not approve or reverse anything.
          </p>
        </ConfirmDialog>
      )}

      <style>{`@media (max-width: 1000px) { .ops-grid { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
    </div>
  );
}

/** A plain header + string-cell table; empty rows keep the header. */
function ScrollTable({
  head,
  align,
  rows,
  empty,
  testid,
}: {
  head: string[];
  align: ('left' | 'right')[];
  rows: string[][];
  empty: string;
  testid: string;
}) {
  const last = head.length - 1;
  const cls = (i: number) =>
    [align[i] === 'right' ? 'num' : '', i === 0 ? 'first' : '', i === last ? 'last' : '']
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <table className="dt dt-static" data-testid={testid}>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} className={cls(i)}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <EmptyRow colSpan={head.length}>{empty}</EmptyRow>}
        {rows.map((r) => (
          <tr key={r.join('|')}>
            {r.map((cell, i) => (
              <td key={head[i] ?? String(i)} className={cls(i)}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SalesByDayChart({ points }: { points: { day: string; writtenCents: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.writtenCents));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 110 }}>
      {points.map((p) => (
        <div
          key={p.day}
          title={`${p.day}: ${usd(p.writtenCents)}`}
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            justifyContent: 'flex-end',
            height: '100%',
          }}
        >
          <div
            style={{
              height: `${Math.round((p.writtenCents / max) * 100)}%`,
              minHeight: p.writtenCents > 0 ? 2 : 0,
              background: 'var(--accent)',
              borderRadius: '3px 3px 0 0',
            }}
          />
        </div>
      ))}
    </div>
  );
}
