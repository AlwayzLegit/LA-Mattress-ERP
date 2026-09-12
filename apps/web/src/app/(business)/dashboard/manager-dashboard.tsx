'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import { Alert, LinkButton, Select } from '@/components/ui';
import { api } from '@/lib/api';
import {
  EmptyRow,
  Panel,
  ShimmerRows,
  StatusPill,
  orderStatusMeta,
  pctDelta,
  shortDay,
  usdShort,
  usdWhole,
  type Tone,
} from './owner/owner-kit';
import { StaffSchedule } from './shared/staff-schedule';
import { StoresSection } from './shared/stores-section';
import { TimeClockStrip } from './shared/time-clock-strip';

interface QueueRow {
  id: string;
  number: string;
  status: string;
  deliveryStatus: string | null;
  requestedDate: string | null;
  totalCents: number;
  balanceDueCents: number;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  salespersonName: string | null;
  salespersonMembershipId: string | null;
  secondSalespersonMembershipId: string | null;
  createdAt: string;
  shortUnits: number;
}

type DeliveryRow = QueueRow & {
  deliveryId: string;
  deliveryState: string;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  driverName: string | null;
};

interface ManagerDashboard {
  date: string;
  location: { id: string; name: string; timezone: string };
  locations: { id: string; name: string }[];
  membershipId: string;
  kpis: {
    mine: {
      writtenCents: number;
      writtenCount: number;
      collectedCents: number;
      openCount: number;
      openBalanceCents: number;
      closed7dCount: number;
      closed7dCents: number;
      monthWrittenCents: number;
      monthlyGoalCents: number | null;
      commissionPeriodCents: number;
    };
    store: {
      writtenCents: number;
      writtenCount: number;
      collectedCents: number;
      tenderMix: { method: string; cents: number }[];
    };
    exceptionsOpen: number;
    pastDuePromises: number;
    unpaidAging: number;
  };
  drawer: { shiftOpen: boolean; closedToday: boolean; suspended: boolean };
  salesByDay: { day: string; mineCents: number; storeCents: number }[];
  leaderboardWeek: { name: string; cents: number }[];
  pipeline: { key: string; count: number; cents: number }[];
  queues: {
    myOpen: QueueRow[];
    storeOpen: QueueRow[];
    recentlyClosed: QueueRow[];
    todaysDeliveries: DeliveryRow[];
    backorders: QueueRow[];
    staleCarts: QueueRow[];
  };
  returnsInFlight: {
    id: string;
    rmaNumber: string;
    status: string;
    createdAt: string;
    orderId: string | null;
    orderNumber: string | null;
    customerName: string | null;
    salespersonMembershipId: string | null;
    salespersonName: string | null;
  }[];
  incoming: {
    kind: 'transfer' | 'po';
    id: string;
    number: string;
    status: string;
    expected: string | null;
  }[];
  lowStock: {
    variantId: string;
    productName: string;
    variantName: string | null;
    sku: string | null;
    available: number;
  }[];
  creditHolders: {
    customerId: string;
    customerName: string | null;
    phone: string | null;
    balanceCents: number;
    salespersonMembershipId: string | null;
    salespersonName: string | null;
  }[];
  activity: {
    orderId: string;
    orderNumber: string;
    latestAt: string;
    events: { action: string; actorName: string | null; createdAt: string }[];
  }[];
  headline: {
    writtenCents: number;
    ticketCount: number;
    avgTicketCents: number;
    lastWeek: { date: string; writtenCents: number };
    lastMonth: { date: string; writtenCents: number };
    topRep: { name: string; count: number } | null;
  };
  needsCall: { total: number; atRisk: number; waitingOnStock: number };
  lastClose: {
    status: 'clean' | 'short' | 'over' | 'open' | 'suspended' | 'none';
    varianceCents: number | null;
    closedAt: string | null;
    byName: string | null;
    closeDay: string | null;
  };
}

const PIPELINE_LABELS: Record<string, string> = {
  draft: 'Drafts',
  quote: 'Quotes',
  open: 'Open, unscheduled',
  scheduled: 'Scheduled',
};
/** Design tokens for each pipeline stage's bar segment + legend swatch. */
const PIPELINE_COLORS: Record<string, string> = {
  draft: 'var(--border2)',
  quote: 'var(--warn)',
  open: 'var(--info)',
  scheduled: 'var(--accent)',
};
const PIPELINE_DEFAULT_COLOR = 'var(--accent)';

function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}
function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
}

function ageDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "08:00–11:00" from the delivery window, or null when unscheduled. */
function windowOf(r: DeliveryRow): string | null {
  return r.windowStart ? `${r.windowStart.slice(0, 5)}–${(r.windowEnd ?? '').slice(0, 5)}` : null;
}

const MONO_500: CSSProperties = { fontWeight: 500 };
const SWATCH = (color: string): CSSProperties => ({
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: 2,
  background: color,
  marginRight: 5,
  verticalAlign: 'middle',
});

/**
 * The store-manager home (owner decisions 2026-08-30, Claude Design
 * hand-off 2026-09-04, reworked 2026-09-10): everything scoped to ONE
 * store picked from the member's approved list, "today" in that store's
 * local time, written business leading. The store's own card
 * (salespeople, money received, cash awaiting pickup) leads, then this
 * week's board + open pipeline, the open-sales queue (mine / whole
 * store), the store-operations grid (deliveries, backorders, aging
 * carts, returns, incoming stock, drawer & tenders, activity) and the
 * "my day" section (call-backs, deliveries, wins, follow-up money).
 */
export default function ManagerDashboardView({ userName }: { userName: string }) {
  const router = useRouter();
  const [data, setData] = useState<ManagerDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [queueTab, setQueueTab] = useState<'mine' | 'store'>('mine');

  useEffect(() => {
    let initial: string | null = null;
    try {
      const raw = sessionStorage.getItem('jetnine.sellingStore');
      if (raw) initial = (JSON.parse(raw) as { id?: string }).id ?? null;
    } catch {
      initial = null;
    }
    setLocationId(initial);
    void load(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(loc: string | null) {
    setError(null);
    try {
      const qs = loc ? `?locationId=${loc}` : '';
      const d = await api<ManagerDashboard>(`/v1/dashboard/manager${qs}`);
      setData(d);
      setLocationId(d.location.id);
    } catch (err) {
      if (loc) {
        void load(null);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const firstName = userName.split(' ')[0] || userName;
  const header = (
    <div
      style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}
    >
      <div>
        <h1 className="page-title">{data ? data.location.name : `Hi, ${firstName}`}</h1>
        <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3 }}>
          {data ? (
            <>
              Acting for <strong style={{ fontWeight: 600 }}>{data.location.name}</strong> ·{' '}
              {longDate(data.date)} · {firstName}
            </>
          ) : (
            'Loading your store…'
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} data-noprint="true">
        {data && data.locations.length > 1 && (
          <Select
            aria-label="Store"
            data-testid="manager-store-picker"
            className="select-sm"
            value={locationId ?? ''}
            onChange={(e) => {
              setData(null);
              void load(e.target.value);
            }}
          >
            {data.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        <LinkButton variant="primary" size="sm" href="/orders/new">
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
  if (!data) {
    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
        data-testid="manager-dashboard"
      >
        <TimeClockStrip />
        {header}
        <section className="panel">
          <ShimmerRows rows={4} />
        </section>
        <Panel title="This week's board">
          <ShimmerRows rows={4} />
        </Panel>
        <Panel title="Open sales">
          <ShimmerRows rows={6} />
        </Panel>
      </div>
    );
  }

  const { kpis, queues } = data;
  const store = data.location.name;
  const mineOf = (r: {
    salespersonMembershipId: string | null;
    secondSalespersonMembershipId?: string | null;
  }) =>
    r.salespersonMembershipId === data.membershipId ||
    r.secondSalespersonMembershipId === data.membershipId;

  const queueRows = queueTab === 'mine' ? queues.myOpen : queues.storeOpen;
  const myCallbacks = queues.staleCarts.filter(mineOf);
  const myDeliveries = queues.todaysDeliveries.filter(mineOf);
  const myWins = queues.recentlyClosed.filter(mineOf);
  const myReturns = data.returnsInFlight.filter(mineOf);
  const myCredit = data.creditHolders.filter(mineOf);
  const openOrder = (id: string) => router.push(`/orders/${id}`);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
      data-testid="manager-dashboard"
    >
      <TimeClockStrip />
      {header}

      <div className="dh-head" data-testid="dh-head">
        <section className="panel dh-headline" data-testid="dh-headline">
          <div className="dh-label">{store} written today</div>
          <div className="dh-value" data-testid="dh-written">
            {usdWhole(data.headline.writtenCents)}
          </div>
          <div className="dh-baselines">
            <div>
              <strong
                className={`mono ${data.headline.writtenCents >= data.headline.lastWeek.writtenCents ? 'is-up' : 'is-down'}`}
              >
                {pctDelta(data.headline.writtenCents, data.headline.lastWeek.writtenCents) ?? '—'}
              </strong>{' '}
              vs same day last week{' '}
              <span className="mono dh-base">
                {usdWhole(data.headline.lastWeek.writtenCents)} last{' '}
                {weekdayOf(data.headline.lastWeek.date)}
              </span>
            </div>
            <div>
              <strong
                className={`mono ${data.headline.writtenCents >= data.headline.lastMonth.writtenCents ? 'is-up' : 'is-down'}`}
              >
                {pctDelta(data.headline.writtenCents, data.headline.lastMonth.writtenCents) ?? '—'}
              </strong>{' '}
              vs same day last month{' '}
              <span className="mono dh-base">
                {usdWhole(data.headline.lastMonth.writtenCents)}{' '}
                {shortDay(data.headline.lastMonth.date)}
              </span>
            </div>
          </div>
          <div className="dh-sub">
            {data.headline.ticketCount} ticket{data.headline.ticketCount === 1 ? '' : 's'}
            {data.headline.topRep
              ? ` · ${data.headline.topRep.count} by ${data.headline.topRep.name.split(' ')[0]}`
              : ''}
            {data.headline.ticketCount ? ` · avg ${usdWhole(data.headline.avgTicketCents)}` : ''}
          </div>
        </section>

        <Link href="/jeopardy" className="panel dh-side" data-testid="dh-needs-call">
          <div className="dh-label">Needs a call today</div>
          <div
            className="dh-side-value mono"
            style={{ color: data.needsCall.total > 0 ? 'var(--status-risk-fg)' : undefined }}
          >
            {data.needsCall.total}
          </div>
          <div className="dh-side-delta">
            {data.needsCall.total > 0 ? (
              <strong className="mono is-down">
                {[
                  data.needsCall.atRisk ? `${data.needsCall.atRisk} at risk` : null,
                  data.needsCall.waitingOnStock
                    ? `${data.needsCall.waitingOnStock} waiting on stock`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </strong>
            ) : (
              <span className="dh-base">Nothing to call about today.</span>
            )}
          </div>
          <span className="dh-side-link">Open the queue →</span>
        </Link>

        <Link
          href={
            data.lastClose.closeDay
              ? `/shifts/close/${data.lastClose.closeDay}?locationId=${encodeURIComponent(data.location.id)}`
              : `/shifts/close/${data.date}?locationId=${encodeURIComponent(data.location.id)}`
          }
          className="panel dh-side"
          data-testid="dh-last-close"
        >
          <div className="dh-label">Last night&apos;s close</div>
          <div
            className="dh-side-value"
            style={{
              color:
                data.lastClose.status === 'clean'
                  ? 'var(--status-fulfilled-fg)'
                  : data.lastClose.status === 'short' || data.lastClose.status === 'suspended'
                    ? 'var(--status-risk-fg)'
                    : data.lastClose.status === 'over'
                      ? 'var(--status-waiting-fg)'
                      : undefined,
            }}
          >
            {
              {
                clean: 'Clean',
                short: 'Short',
                over: 'Over',
                open: 'Open',
                suspended: 'Suspended',
                none: '—',
              }[data.lastClose.status]
            }
          </div>
          <div className="dh-side-delta">
            <strong
              className={`mono ${data.lastClose.status === 'clean' ? 'is-up' : data.lastClose.status === 'none' ? '' : 'is-down'}`}
            >
              {data.lastClose.status === 'clean'
                ? 'balanced'
                : data.lastClose.varianceCents
                  ? `${data.lastClose.varianceCents > 0 ? '+' : '−'}${usdWhole(Math.abs(data.lastClose.varianceCents))}`
                  : data.lastClose.status === 'none'
                    ? 'no drawer closed yet'
                    : ''}
            </strong>{' '}
            <span className="dh-base">
              {data.lastClose.byName
                ? `· ${data.lastClose.closeDay ? shortDay(data.lastClose.closeDay) : ''} · ${data.lastClose.byName}`
                : ''}
            </span>
          </div>
          <span className="dh-side-link">Z-report →</span>
        </Link>
      </div>

      <StoresSection locationIds={[data.location.id]} single actorName={userName} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 18 }}>
        <Panel title="This week's board" sub={store}>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {data.leaderboardWeek.length === 0 ? (
              <EmptyRow>Nothing written at this store this week yet.</EmptyRow>
            ) : (
              <Leaderboard rows={data.leaderboardWeek} highlight={userName} />
            )}
          </div>
          <div style={{ padding: '0 var(--pad) var(--pad)' }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Open pipeline
            </div>
            <PipelineBar segments={data.pipeline} />
          </div>
        </Panel>
      </div>

      <Panel
        title="Open sales"
        actions={
          <>
            <div className="seg" style={{ marginLeft: 6 }}>
              <button
                type="button"
                className={`seg-btn${queueTab === 'mine' ? ' is-active' : ''}`}
                aria-pressed={queueTab === 'mine'}
                onClick={() => setQueueTab('mine')}
                data-testid="queue-tab-mine"
              >
                Mine <TabCount n={queues.myOpen.length} />
              </button>
              <button
                type="button"
                className={`seg-btn${queueTab === 'store' ? ' is-active' : ''}`}
                aria-pressed={queueTab === 'store'}
                onClick={() => setQueueTab('store')}
                data-testid="queue-tab-store"
              >
                Whole store <TabCount n={queues.storeOpen.length} />
              </button>
            </div>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
              Click a row for details
            </span>
          </>
        }
      >
        <QueueTable
          rows={queueRows}
          testid="open-queue"
          today={data.date}
          actions
          empty="No open sales — write one!"
          onOpen={openOrder}
        />
      </Panel>

      <SectionRow title="Store operations" sub={`${store} · today`} />
      <div className="dh-three">
        <Panel
          title="Incoming stock"
          sub={<span className="count-chip">{data.incoming.length}</span>}
          actions={
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
              <Link href="/transfers" className="panel-link" style={{ marginLeft: 0 }}>
                Transfers →
              </Link>
              <Link href="/purchase-orders" className="panel-link" style={{ marginLeft: 0 }}>
                Purchasing →
              </Link>
            </span>
          }
        >
          <table className="dt dt-static" data-testid="incoming-stock">
            <tbody>
              {data.incoming.length === 0 ? (
                <EmptyRow colSpan={4}>Nothing on a truck or on order for this store.</EmptyRow>
              ) : (
                data.incoming.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td className="first mono" style={MONO_500}>
                      {r.number}
                    </td>
                    <td style={{ width: '100%' }}>
                      {r.kind === 'transfer' ? 'Transfer' : 'Purchase order'}
                    </td>
                    <td>
                      <StatusPill tone={incomingTone(r.status)}>
                        {r.status.replace(/_/g, ' ')}
                      </StatusPill>
                    </td>
                    <td className="last mono" style={{ ...MONO_500, textAlign: 'right' }}>
                      {r.expected ? shortDay(r.expected) : 'no date'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>

        <Panel title="Drawer & tenders" sub="today" link={{ href: '/cash', label: 'Cash' }}>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p data-testid="drawer-status" style={{ margin: 0, fontSize: 12.5 }}>
              {data.drawer.suspended ? (
                <strong style={{ fontWeight: 600, color: 'var(--danger)' }}>
                  Drawer suspended — needs a manager close.
                </strong>
              ) : data.drawer.shiftOpen ? (
                <>
                  Drawer is <strong style={{ fontWeight: 600 }}>open</strong> — remember the blind
                  count at close.
                </>
              ) : data.drawer.closedToday ? (
                <>
                  Drawer{' '}
                  <strong style={{ fontWeight: 600, color: 'var(--accent-ink)' }}>
                    balanced and closed
                  </strong>{' '}
                  for today.
                </>
              ) : (
                <>No drawer session today yet.</>
              )}
            </p>
            <div className="eyebrow">Tender mix</div>
            {kpis.store.tenderMix.length === 0 ? (
              <EmptyRow>No money taken yet today.</EmptyRow>
            ) : (
              <BarList
                testid="tender-mix"
                rows={kpis.store.tenderMix.map((t) => ({
                  label: t.method.replace(/_/g, ' '),
                  cents: t.cents,
                }))}
                capitalize
              />
            )}
          </div>
        </Panel>

        <Panel title="Store activity" sub="grouped by order">
          {data.activity.length === 0 ? (
            <EmptyRow>No order changes recorded at this store yet.</EmptyRow>
          ) : (
            <div
              className="panel-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}
              data-testid="store-activity"
            >
              {data.activity.map((g) => (
                <details key={g.orderId}>
                  <summary style={{ cursor: 'pointer' }}>
                    <Link href={`/orders/${g.orderId}`} className="mono" style={MONO_500}>
                      {g.orderNumber}
                    </Link>{' '}
                    <span style={{ color: 'var(--muted)' }}>
                      {g.events.length} change{g.events.length === 1 ? '' : 's'} · latest{' '}
                      <span className="mono">{timeOf(g.latestAt)}</span>
                    </span>
                  </summary>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20, color: 'var(--muted)' }}>
                    {g.events.map((e, i) => (
                      <li key={i}>
                        {e.action.replace(/[._]/g, ' ')} · {e.actorName ?? 'system'} ·{' '}
                        <span className="mono">{timeOf(e.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 18 }}>
        <OpsPanel
          title="Deliveries"
          count={queues.todaysDeliveries.length}
          link={{ href: `/deliveries/day/${data.date}`, label: 'Dispatch' }}
          testid="today-deliveries"
          empty="No deliveries scheduled from this store today or tomorrow."
          rows={queues.todaysDeliveries.map((r) => ({
            key: r.deliveryId,
            href: `/orders/${r.id}`,
            a: r.number,
            b: customerLine(r),
            c: [
              r.scheduledDate === data.date ? 'Today' : 'Tomorrow',
              windowOf(r),
              r.driverName ?? 'no driver',
            ]
              .filter(Boolean)
              .join(' · '),
            title: `${r.deliveryState.replace(/_/g, ' ')}${r.driverName ? ` · driver ${r.driverName}` : ''}`,
            d: r.balanceDueCents > 0 ? usdWhole(r.balanceDueCents) : '—',
            dColor: r.balanceDueCents > 0 ? 'var(--danger)' : 'var(--faint)',
          }))}
        />

        <OpsPanel
          title="Backorder watch"
          count={queues.backorders.length}
          link={{ href: '/jeopardy', label: 'At risk' }}
          testid="backorders"
          empty="Every promised order has its stock reserved."
          rows={queues.backorders.map((r) => ({
            key: r.id,
            href: `/orders/${r.id}`,
            a: r.number,
            b: customerLine(r),
            c: r.requestedDate ? `promised ${shortDay(r.requestedDate)}` : 'no promise date',
            cColor: r.requestedDate && r.requestedDate < data.date ? 'var(--danger)' : undefined,
            title: r.salespersonName ? `rep ${r.salespersonName}` : undefined,
            d: `${r.shortUnits} short`,
            dColor: 'var(--danger)',
          }))}
        />

        <OpsPanel
          title="Aging carts"
          count={queues.staleCarts.length}
          link={{ href: '/orders', label: 'Orders' }}
          testid="stale-carts"
          empty="No parked drafts or quotes. Clean register!"
          rows={queues.staleCarts.map((r) => ({
            key: r.id,
            href: `/orders/${r.id}`,
            a: r.number,
            b: customerLine(r),
            c: `${orderStatusMeta(r.status).label} · ${ageDays(r.createdAt)}d`,
            title: r.salespersonName ? `rep ${r.salespersonName}` : undefined,
            d: usdWhole(r.totalCents),
          }))}
        />

        <OpsPanel
          title="Returns & exchanges"
          count={data.returnsInFlight.length}
          link={{ href: '/returns', label: 'Returns' }}
          testid="returns-in-flight"
          empty="Nothing awaiting goods or a refund."
          rows={data.returnsInFlight.map((r) => ({
            key: r.id,
            href: r.orderId ? `/orders/${r.orderId}` : '/returns',
            a: r.rmaNumber,
            b: [r.orderNumber, r.customerName].filter(Boolean).join(' · ') || '—',
            c: r.status.replace(/_/g, ' '),
            d: `${ageDays(r.createdAt)}d`,
          }))}
        />
      </div>

      <SectionRow title="My day" sub={`${firstName} · ${store}`} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 18 }}>
        <OpsPanel
          title="My call-backs"
          count={myCallbacks.length}
          link={{ href: '/orders?mine=1', label: 'My orders' }}
          testid="my-callbacks"
          empty="No parked quotes of yours are waiting on a decision."
          rows={myCallbacks.map((r) => ({
            key: r.id,
            href: `/orders/${r.id}`,
            a: r.number,
            b: customerLine(r),
            c: `${orderStatusMeta(r.status).label} · ${ageDays(r.createdAt)}d`,
            d: usdWhole(r.totalCents),
          }))}
        />

        <OpsPanel
          title="My deliveries"
          count={myDeliveries.length}
          link={{ href: `/deliveries/day/${data.date}`, label: 'Dispatch' }}
          testid="my-deliveries"
          empty="None of your sales are on a truck today or tomorrow."
          rows={myDeliveries.map((r) => ({
            key: r.deliveryId,
            href: `/orders/${r.id}`,
            a: r.number,
            b: customerLine(r),
            c: [r.scheduledDate === data.date ? 'Today' : 'Tomorrow', windowOf(r)]
              .filter(Boolean)
              .join(' · '),
            d: r.balanceDueCents > 0 ? usdWhole(r.balanceDueCents) : '—',
            dColor: r.balanceDueCents > 0 ? 'var(--danger)' : 'var(--faint)',
          }))}
        />

        <Panel
          title="My wins"
          sub="closed last 7 days"
          style={{ gridColumn: 'span 2' }}
          link={{ href: '/orders?mine=1', label: 'My orders' }}
        >
          <QueueTable
            rows={myWins}
            testid="my-wins"
            today={data.date}
            empty="Nothing delivered this week yet — go get one."
            onOpen={openOrder}
          />
        </Panel>

        <Panel title="My follow-up money" sub="store credit & returns on my sales">
          <div style={{ padding: '10px var(--pad) 0' }} className="eyebrow">
            Customers holding store credit
          </div>
          <table className="dt dt-static">
            <tbody>
              {myCredit.length === 0 ? (
                <EmptyRow colSpan={2}>None of your customers are sitting on credit.</EmptyRow>
              ) : (
                myCredit.map((c) => (
                  <tr key={c.customerId}>
                    <td className="first" style={{ width: '100%' }}>
                      <Link href={`/customers/${c.customerId}`} style={{ fontWeight: 500 }}>
                        {c.customerName ?? 'customer'}
                      </Link>
                      {c.phone && (
                        <span className="sub" style={{ marginLeft: 6 }}>
                          {c.phone}
                        </span>
                      )}
                    </td>
                    <td className="last num" style={MONO_500}>
                      {usdWhole(c.balanceCents)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div style={{ padding: '12px var(--pad) 0' }} className="eyebrow">
            My returns in flight
          </div>
          <table className="dt dt-static">
            <tbody>
              {myReturns.length === 0 ? (
                <EmptyRow colSpan={3}>No open returns on your sales.</EmptyRow>
              ) : (
                myReturns.map((r) => (
                  <tr key={r.id}>
                    <td className="first mono" style={{ ...MONO_500, width: '100%' }}>
                      {r.orderId ? (
                        <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>
                      ) : (
                        r.rmaNumber
                      )}
                    </td>
                    <td>
                      <StatusPill tone="warn">{r.status.replace(/_/g, ' ')}</StatusPill>
                    </td>
                    <td className="last num">{ageDays(r.createdAt)}d</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      </div>

      <StaffSchedule lockedLocationId={data.location.id} readOnly />
    </div>
  );
}

function customerLine(r: { customerName: string | null; customerPhone: string | null }): string {
  return [r.customerName ?? '—', r.customerPhone].filter(Boolean).join(' · ');
}

function incomingTone(status: string): Tone {
  if (/received|closed|complete/.test(status)) return 'ok';
  if (/transit|shipped|sent/.test(status)) return 'info';
  if (/cancel/.test(status)) return 'danger';
  return 'muted';
}

/** The count next to a queue tab label. */
function TabCount({ n }: { n: number }) {
  return (
    <span className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>
      {n}
    </span>
  );
}

/** "Store operations" / "My day" — a section title with a muted scope note. */
function SectionRow({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '-.01em' }}>{title}</h2>
      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{sub}</span>
    </div>
  );
}

interface OpsRow {
  key: string;
  href: string;
  /** Mono identifier — order number, SKU, RMA. */
  a: string;
  /** Free text — customer · phone, product name. */
  b: string;
  /** Muted qualifier — window, promise date, status · age. */
  c: string;
  cColor?: string;
  /** Mono figure at the right — balance, short units, value, availability. */
  d: string;
  dColor?: string;
  title?: string;
}

/**
 * One of the small store-operations panels: title, count chip, a link to
 * the full screen, then rows of `a · b · c · d`. The `data-testid` stays on
 * the table so the queue can be found the same way as before.
 */
function OpsPanel({
  title,
  count,
  link,
  testid,
  empty,
  rows,
}: {
  title: string;
  count: number;
  link: { href: string; label: string };
  testid: string;
  empty: string;
  rows: OpsRow[];
}) {
  const router = useRouter();
  return (
    <Panel title={title} sub={<span className="count-chip">{count}</span>} link={link}>
      <table className="dt dt-static" data-testid={testid}>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={4}>{empty}</EmptyRow>
          ) : (
            rows.map((r) => (
              <tr
                key={r.key}
                className="is-clickable"
                title={r.title}
                onClick={(e) => rowClick(e, () => router.push(r.href))}
              >
                <td className="first mono" style={{ ...MONO_500, width: 78 }}>
                  <Link href={r.href} style={{ color: 'inherit', textDecoration: 'none' }}>
                    {r.a}
                  </Link>
                </td>
                <td
                  style={{
                    width: '100%',
                    maxWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.b}
                </td>
                <td style={{ fontSize: 12, color: r.cColor ?? 'var(--muted)' }}>{r.c}</td>
                <td
                  className="last mono"
                  style={{ ...MONO_500, minWidth: 64, textAlign: 'right', color: r.dColor }}
                >
                  {r.d}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Panel>
  );
}

/** Row-level navigation that lets the links inside the row keep their own href. */
function rowClick(e: MouseEvent<HTMLTableRowElement>, go: () => void) {
  if ((e.target as HTMLElement).closest('a')) return;
  go();
}

/** Rank / name / bar / amount — this week's board; the signed-in member is lifted. */
function Leaderboard({
  rows,
  highlight,
}: {
  rows: { name: string; cents: number }[];
  highlight: string;
}) {
  const max = rows[0]?.cents || 1;
  return (
    <div data-testid="leaderboard" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map((r, i) => {
        const me = r.name === highlight;
        return (
          <div
            key={`${r.name}-${i}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '18px 110px 1fr 70px',
              alignItems: 'center',
              gap: 10,
              fontSize: 12.5,
            }}
          >
            <span className="mono" style={{ color: 'var(--faint)', fontSize: 11 }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <span
              style={{
                fontWeight: me ? 600 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.name}
            </span>
            <div style={{ height: 10, borderRadius: 2, background: 'var(--surface2)' }}>
              <div
                title={usdWhole(r.cents)}
                style={{
                  height: '100%',
                  borderRadius: 2,
                  background: me ? 'var(--accent)' : 'var(--border2)',
                  width: `${Math.max(3, Math.round((r.cents / max) * 100))}%`,
                }}
              />
            </div>
            <span className="mono" style={{ textAlign: 'right' }}>
              {usdShort(r.cents)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Label / bar / amount rows — the tender mix. */
function BarList({
  rows,
  testid,
  capitalize,
}: {
  rows: { label: string; cents: number }[];
  testid: string;
  capitalize?: boolean;
}) {
  const max = rows[0]?.cents || 1;
  return (
    <div data-testid={testid} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map((row) => (
        <div
          key={row.label}
          style={{
            display: 'grid',
            gridTemplateColumns: '110px 1fr 70px',
            alignItems: 'center',
            gap: 10,
            fontSize: 12.5,
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textTransform: capitalize ? 'capitalize' : undefined,
            }}
          >
            {row.label}
          </span>
          <div style={{ height: 10, borderRadius: 2, background: 'var(--surface2)' }}>
            <div
              title={usdWhole(row.cents)}
              style={{
                height: '100%',
                borderRadius: 2,
                background: 'var(--accent)',
                width: `${Math.max(3, Math.round((row.cents / max) * 100))}%`,
              }}
            />
          </div>
          <span className="mono" style={{ textAlign: 'right' }}>
            {usdShort(row.cents)}
          </span>
        </div>
      ))}
    </div>
  );
}

function nextAction(r: QueueRow): string | null {
  if (r.shortUnits > 0) return `${r.shortUnits} short`;
  if (r.status === 'draft' || r.status === 'quote') return 'confirm the sale';
  if (r.balanceDueCents > 0 && !r.deliveryStatus) return 'collect & schedule';
  if (!r.deliveryStatus) return 'schedule delivery';
  if (r.balanceDueCents > 0) return 'collect balance';
  return null;
}

/** The open-sales / my-wins queue: the design's order table, rows click through to the order. */
function QueueTable({
  rows,
  testid,
  today,
  actions,
  empty,
  onOpen,
}: {
  rows: QueueRow[];
  testid: string;
  today: string;
  actions?: boolean;
  empty: string;
  onOpen: (id: string) => void;
}) {
  const cols = actions ? 8 : 7;
  return (
    <table className="dt dt-static" data-testid={testid}>
      <thead>
        <tr>
          <th className="first">Order</th>
          <th>Customer</th>
          <th>Status</th>
          <th>Promised</th>
          <th className="num">Total</th>
          <th className="num">Balance</th>
          <th className={actions ? undefined : 'last'}>Rep</th>
          {actions && <th className="last">Next action</th>}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyRow colSpan={cols}>{empty}</EmptyRow>
        ) : (
          rows.map((r) => {
            const meta = orderStatusMeta(r.status);
            const late = !!r.requestedDate && r.requestedDate < today;
            return (
              <tr
                key={r.id}
                className="is-clickable"
                onClick={(e) => rowClick(e, () => onOpen(r.id))}
              >
                <td className="first mono" style={MONO_500}>
                  <Link
                    href={`/orders/${r.id}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {r.number}
                  </Link>
                </td>
                <td>
                  <div style={{ fontWeight: 500 }}>
                    {r.customerId ? (
                      <Link
                        href={`/customers/${r.customerId}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                      >
                        {r.customerName ?? 'customer'}
                      </Link>
                    ) : (
                      (r.customerName ?? '—')
                    )}
                  </div>
                  {r.customerPhone && <div className="sub">{r.customerPhone}</div>}
                </td>
                <td>
                  <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                </td>
                <td className="mono" style={{ color: late ? 'var(--danger)' : undefined }}>
                  {r.requestedDate ? shortDay(r.requestedDate) : '—'}
                </td>
                <td className="num">{usdWhole(r.totalCents)}</td>
                <td
                  className="num"
                  style={{
                    fontWeight: r.balanceDueCents > 0 ? 600 : 400,
                    color: r.balanceDueCents > 0 ? 'var(--text)' : 'var(--faint)',
                  }}
                >
                  {r.balanceDueCents > 0 ? usdWhole(r.balanceDueCents) : '—'}
                </td>
                <td className={actions ? undefined : 'last'} style={{ color: 'var(--text2)' }}>
                  {r.salespersonName ?? '—'}
                </td>
                {actions && (
                  <td className="last" style={{ color: 'var(--muted)' }}>
                    {nextAction(r) ?? '—'}
                  </td>
                )}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

/** Stacked open-pipeline bar with a legend of count · amount per stage. */
function PipelineBar({ segments }: { segments: { key: string; count: number; cents: number }[] }) {
  const total = segments.reduce((s, x) => s + x.cents, 0);
  if (total === 0) return <EmptyRow>No open pipeline at this store.</EmptyRow>;
  const colorOf = (key: string) => PIPELINE_COLORS[key] ?? PIPELINE_DEFAULT_COLOR;
  const labelOf = (key: string) => PIPELINE_LABELS[key] ?? key;
  return (
    <div data-testid="pipeline-bar">
      <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', gap: 2 }}>
        {segments.map((s) => (
          <div
            key={s.key}
            title={`${labelOf(s.key)}: ${s.count} · ${usdWhole(s.cents)}`}
            style={{
              background: colorOf(s.key),
              width: `${Math.max(2, Math.round((s.cents / total) * 100))}%`,
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginTop: 8,
          fontSize: 12,
          color: 'var(--muted)',
          flexWrap: 'wrap',
        }}
      >
        {segments.map((s) => (
          <span key={s.key}>
            <span style={SWATCH(colorOf(s.key))} />
            {labelOf(s.key)}{' '}
            <span className="mono" style={{ color: 'var(--text)' }}>
              {s.count} · {usdShort(s.cents)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
