'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Select, Button } from '@/components/ui';
import { api } from '@/lib/api';
import {
  EmptyRow,
  KpiStrip,
  Panel,
  ShimmerRows,
  StatusPill,
  shortDay,
  usdWhole,
  type KpiTile,
  type Tone,
} from './owner/owner-kit';
import { StaffSchedule } from './shared/staff-schedule';
import { TimeClockStrip } from './shared/time-clock-strip';

/**
 * The Warehouse home (owner 2026-09-01, §12.2; Claude Design hand-off
 * 2026-09-04): a day in the building, top to bottom — the trucks on the
 * road, what to pull for tomorrow, what's arriving, then every "goods
 * are here, close the loop" queue. Pinned to one location (warehouse-type
 * lead the picker); no money-in tiles, no selling — that's other homes.
 */

interface Summary {
  date: string;
  location: { id: string; name: string; timezone: string };
  locations: { id: string; name: string; locationType: string }[];
  inbound: {
    id: string;
    number: string;
    vendorName: string | null;
    locationName: string | null;
    expectedAt: string | null;
    orderedUnits: number;
    receivedUnits: number;
    overdue: boolean;
  }[];
  dock: {
    id: string;
    number: string;
    vendorName: string | null;
    locationName: string | null;
    unitsInProgress: number;
    lastActivityAt: string;
  }[];
  pickups: {
    orderId: string;
    number: string;
    customerName: string | null;
    locationName: string | null;
    ageDays: number;
    ready: boolean;
  }[];
  arrived: {
    orderId: string;
    orderNumber: string;
    customerName: string | null;
    locationName: string | null;
    description: string;
    quantity: number;
    arrivedAt: string;
  }[];
  transfers: {
    rows: {
      id: string;
      number: string;
      direction: 'inbound' | 'outbound' | 'internal';
      fromName: string | null;
      toName: string | null;
      status: string;
      units: number;
      days: number | null;
      awaitingTicket: boolean;
    }[];
    closedShort30d: number;
  };
  asIs: {
    count: number;
    costCents: number;
    oldestAt: string | null;
    rows: {
      id: string;
      productName: string;
      locationName: string | null;
      quantity: number;
      condition: string | null;
      createdAt: string;
    }[];
  };
  counts: {
    open: { id: string; countDate: string; status: string; locationName: string | null }[];
    lastPostedDate: string | null;
    negative: {
      variantId: string;
      productName: string;
      sku: string | null;
      locationName: string | null;
      onHand: number;
    }[];
  };
}

interface Loadout {
  date: string;
  /** Null in the combined view — the stop cap is a per-location knob. */
  cap: number | null;
  stops: number;
  pieces: number;
  rows: {
    deliveryId: string;
    orderId: string;
    orderNumber: string;
    customerName: string | null;
    locationName: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    route: string | null;
    driverName: string | null;
    status: string;
    pieces: number;
    serialShort: boolean;
  }[];
}

interface Picklist {
  date: string;
  rows: {
    variantId: string;
    locationId: string;
    locationName: string | null;
    productName: string;
    variantName: string | null;
    sku: string | null;
    bin: string | null;
    quantity: number;
    onHand: number;
    short: boolean;
    serialShort: boolean;
  }[];
}

type LoadoutRow = Loadout['rows'][number];

/** One card per truck: the loadout grouped by route, falling back to driver. */
interface Truck {
  key: string;
  name: string;
  driver: string | null;
  rows: LoadoutRow[];
  done: number;
  status: { label: string; tone: Tone };
}

const DONE_STATUSES = new Set(['delivered', 'completed']);

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  return `${days}d`;
}

/** Delivery windows are Postgres `time` values ("14:00:00"); timestamps also pass. */
function clock(value: string | null): string {
  if (!value) return '—';
  const tod = /^(\d{1,2}):(\d{2})/.exec(value);
  if (tod && !value.includes('T')) {
    const h = Number(tod[1]);
    const m = tod[2];
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m === '00' ? `${h12} ${h < 12 ? 'AM' : 'PM'}` : `${h12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  }
  return new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function calDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Thursday, Sep 4" from a YYYY-MM-DD business date. */
function longDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function deliveryMeta(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'scheduled':
      return { label: 'Scheduled', tone: 'muted' };
    case 'loaded':
      return { label: 'Loaded', tone: 'info' };
    case 'out_for_delivery':
      return { label: 'On route', tone: 'info' };
    case 'delivered':
    case 'completed':
      return { label: 'Delivered', tone: 'ok' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'danger' };
    default:
      return { label: status.replace(/_/g, ' '), tone: 'muted' };
  }
}

function groupTrucks(rows: LoadoutRow[]): Truck[] {
  const byKey = new Map<string, Truck>();
  for (const r of rows) {
    const key = r.route ?? (r.driverName ? `driver:${r.driverName}` : 'unassigned');
    let t = byKey.get(key);
    if (!t) {
      t = {
        key,
        name: r.route ?? (r.driverName ? `${r.driverName}'s truck` : 'Unassigned'),
        driver: r.driverName,
        rows: [],
        done: 0,
        status: { label: 'Scheduled', tone: 'muted' },
      };
      byKey.set(key, t);
    }
    t.rows.push(r);
    if (DONE_STATUSES.has(r.status)) t.done += 1;
  }
  for (const t of byKey.values()) {
    t.rows.sort((a, b) => (a.windowStart ?? '').localeCompare(b.windowStart ?? ''));
    const open = t.rows.filter((r) => !DONE_STATUSES.has(r.status));
    if (open.length === 0) t.status = { label: 'Done', tone: 'ok' };
    else if (open.some((r) => r.status === 'failed'))
      t.status = { label: 'Attention', tone: 'danger' };
    else if (open.some((r) => r.status === 'out_for_delivery'))
      t.status = { label: 'On route', tone: 'info' };
    else if (open.some((r) => r.status === 'loaded')) t.status = { label: 'Loaded', tone: 'info' };
  }
  return [...byKey.values()];
}

/** The location line under a number — only in the combined view. */
function LocationSub({ show, name }: { show: boolean; name: string | null }) {
  if (!show || !name) return null;
  return <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{name}</div>;
}

function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}
    >
      <div>
        <h1 className="page-title">{title}</h1>
        <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3 }}>{sub}</div>
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} data-noprint="true">
          {actions}
        </div>
      )}
    </div>
  );
}

function TruckCard({ truck, allMode }: { truck: Truck; allMode: boolean }) {
  const stops = truck.rows.length;
  const pct = stops === 0 ? 0 : Math.round((truck.done / stops) * 100);
  const open = truck.rows.filter((r) => !DONE_STATUSES.has(r.status));
  const lastWindow = open.reduce<string | null>(
    (acc, r) => (r.windowEnd && (!acc || r.windowEnd > acc) ? r.windowEnd : acc),
    null,
  );
  return (
    <section className="panel panel-clip">
      <div className="panel-head" style={{ flexWrap: 'nowrap' }}>
        <h3>{truck.name}</h3>
        {truck.driver && truck.name !== `${truck.driver}'s truck` && (
          <span className="panel-sub">{truck.driver}</span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <StatusPill tone={truck.status.tone}>{truck.status.label}</StatusPill>
        </span>
      </div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <span>
            <span className="mono">{truck.done}</span> of <span className="mono">{stops}</span>{' '}
            stops
          </span>
          <span className="mono">{lastWindow ? `by ${clock(lastWindow)}` : '—'}</span>
        </div>
        <div
          className="meter"
          style={{ height: 6, borderRadius: 3, background: 'var(--surface2)' }}
        >
          <span style={{ width: `${pct}%`, borderRadius: 3 }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
          {truck.rows.map((r) => {
            const done = DONE_STATUSES.has(r.status);
            const meta = deliveryMeta(r.status);
            return (
              <div
                key={r.deliveryId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '52px minmax(0, 1fr) auto auto',
                  gap: 8,
                  alignItems: 'center',
                  fontSize: 12,
                  color: done ? 'var(--faint)' : undefined,
                }}
              >
                <span className="mono" style={{ color: 'var(--muted)' }}>
                  {clock(r.windowStart)}
                </span>
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  <Link href={`/orders/${r.orderId}`} className="mono">
                    {r.orderNumber}
                  </Link>{' '}
                  {r.customerName ?? '—'}
                  {allMode && r.locationName ? ` · ${r.locationName}` : ''}
                  {r.serialShort && (
                    <strong style={{ color: 'var(--danger)' }}> · serials unpicked</strong>
                  )}
                </span>
                <span className="mono" style={{ color: 'var(--muted)' }}>
                  {r.pieces} pc
                </span>
                <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default function WarehouseDashboardView({ userName }: { userName: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [loadout, setLoadout] = useState<Loadout | null>(null);
  const [picklist, setPicklist] = useState<Picklist | null>(null);

  const load = useCallback(async (loc: string | null) => {
    setError(null);
    try {
      // No selection = the combined view; the server defaults the same way.
      const qs = loc ? `?locationId=${loc}` : '?locationId=all';
      const s = await api<Summary>(`/v1/dashboard/warehouse${qs}`);
      setSummary(s);
      setLocationId(s.location.id);
      const locQs = `?locationId=${s.location.id}`;
      void api<Loadout>(`/v1/dashboard/warehouse/loadout${locQs}`)
        .then(setLoadout)
        .catch(() => setLoadout(null));
      void api<Picklist>(`/v1/dashboard/warehouse/picklist${locQs}`)
        .then(setPicklist)
        .catch(() => setPicklist(null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const who = <span style={{ marginLeft: 8, color: 'var(--faint)' }}>· {userName}</span>;

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <TimeClockStrip />
        <PageHead title="Warehouse" sub={who} />
        <Alert
          tone="error"
          action={
            <Button size="sm" onClick={() => void load(null)}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      </div>
    );
  }
  if (!summary) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <TimeClockStrip />
        <PageHead title="Warehouse" sub={who} />
        <KpiStrip
          loading
          tiles={['inbound', 'dock', 'loadout', 'pick', 'pickups', 'arrived'].map((key) => ({
            key,
            label: ' ',
            value: '',
            sub: ' ',
            href: '/warehouse',
          }))}
        />
        <div className="panel">
          <ShimmerRows rows={6} />
        </div>
      </div>
    );
  }

  const allMode = summary.location.id === 'all';
  const overdueCount = summary.inbound.filter((r) => r.overdue).length;
  const dockUnits = summary.dock.reduce((s, r) => s + r.unitsInProgress, 0);
  const stalePickups = summary.pickups.filter((p) => p.ageDays >= 7).length;

  const trucks = loadout ? groupTrucks(loadout.rows) : [];
  const trucksOut = trucks.filter((t) =>
    t.rows.some((r) => r.status === 'out_for_delivery'),
  ).length;
  const stopsOpen = loadout ? loadout.rows.filter((r) => !DONE_STATUSES.has(r.status)).length : 0;
  const pickShort = picklist ? picklist.rows.filter((r) => r.short || r.serialShort).length : 0;
  const pickPieces = picklist ? picklist.rows.reduce((s, r) => s + r.quantity, 0) : 0;

  const locationLabel = allMode
    ? `All locations (${summary.locations.length})`
    : summary.location.name;
  const daySheetHref = `/deliveries/day/${summary.date}`;
  const tomorrowHref = `/deliveries/day/${picklist?.date ?? summary.date}`;

  // Six KPIs at full size (canvas 8e): value, a red qualifier when something
  // is wrong, and what the number counts.
  const tiles: KpiTile[] = [
    {
      key: 'inbound',
      label: 'Receiving',
      value: String(summary.inbound.length),
      delta: overdueCount > 0 ? `${overdueCount} overdue` : 'none overdue',
      deltaTone: overdueCount > 0 ? 'down' : 'up',
      sub: 'POs due',
      href: '/purchase-orders',
      testid: 'wh-kpi-inbound',
    },
    {
      key: 'dock',
      label: 'On the dock',
      value: String(dockUnits),
      delta: dockUnits > 0 ? 'not accepted' : 'clear',
      deltaTone: dockUnits > 0 ? 'down' : 'up',
      sub: 'units received',
      tone: dockUnits > 0 ? 'danger' : undefined,
      href: '/purchase-orders',
      testid: 'wh-kpi-dock',
    },
    {
      key: 'loadout',
      label: 'Trucks out',
      value: loadout ? String(trucksOut) : '—',
      delta: loadout
        ? `${loadout.stops}${loadout.cap != null ? ` of ${loadout.cap}` : ''} stops · ${stopsOpen} open`
        : null,
      deltaTone: 'up',
      sub: 'today',
      href: daySheetHref,
      testid: 'wh-kpi-loadout',
    },
    {
      key: 'pick',
      label: 'To pick',
      value: picklist ? String(picklist.rows.length) : '—',
      delta: picklist
        ? pickShort > 0
          ? `${pickShort} short for promise`
          : plural(pickPieces, 'piece')
        : null,
      deltaTone: pickShort > 0 ? 'down' : 'up',
      sub: 'for tomorrow',
      tone: pickShort > 0 ? 'danger' : undefined,
      href: tomorrowHref,
      testid: 'wh-kpi-pick',
    },
    {
      key: 'pickups',
      label: 'Pickups waiting',
      value: String(summary.pickups.length),
      delta: stalePickups > 0 ? `${stalePickups} waiting 7d+` : 'all fresh',
      deltaTone: stalePickups > 0 ? 'down' : 'up',
      sub: 'customers',
      tone: stalePickups > 0 ? 'danger' : undefined,
      href: '/orders?fulfillment=pickup',
      testid: 'wh-kpi-pickups',
    },
    {
      key: 'arrived',
      label: 'Arrived, unscheduled',
      value: String(summary.arrived.length),
      delta: 'special orders',
      deltaTone: summary.arrived.length > 0 ? 'down' : 'up',
      sub: 'to book',
      tone: summary.arrived.length > 0 ? 'danger' : undefined,
      href: '/special-orders',
      testid: 'wh-kpi-arrived',
    },
  ];

  const inboundMeta = (r: Summary['inbound'][number]): { label: string; tone: Tone } => {
    if (r.overdue) return { label: 'Overdue', tone: 'danger' };
    if (r.expectedAt && r.expectedAt.slice(0, 10) === summary.date)
      return { label: 'Arriving', tone: 'info' };
    if (r.receivedUnits > 0) return { label: 'Partial', tone: 'info' };
    return { label: 'Expected', tone: 'muted' };
  };

  return (
    <div className="dh" data-testid="warehouse-dashboard">
      <TimeClockStrip />
      <PageHead
        title={locationLabel}
        sub={
          <>
            Acting for <strong style={{ fontWeight: 600 }}>{locationLabel}</strong> ·{' '}
            {longDay(summary.date)} · {loadout ? plural(trucksOut, 'truck') : '— trucks'} out ·{' '}
            {picklist ? picklist.rows.length : '—'} to pick for tomorrow
            {who}
          </>
        }
        actions={
          <>
            {summary.locations.length > 1 && (
              <Select
                aria-label="Location"
                className="select-sm"
                data-testid="warehouse-location-picker"
                value={locationId ?? 'all'}
                onChange={(e) => {
                  setSummary(null);
                  setLoadout(null);
                  setPicklist(null);
                  void load(e.target.value);
                }}
              >
                <option value="all">All locations</option>
                {summary.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.locationType === 'warehouse' ? ' (warehouse)' : ''}
                  </option>
                ))}
              </Select>
            )}
            <Link href={daySheetHref} className="btn btn-secondary btn-sm">
              Day sheet
            </Link>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => window.print()}
            >
              Print
            </button>
          </>
        }
      />

      <div className="wh-figs" data-testid="wh-kpis">
        {tiles.map((t) => (
          <Link key={t.key} href={t.href} className="wh-fig" data-testid={t.testid}>
            <div className="wh-fig-label">{t.label}</div>
            <div className="wh-fig-row">
              <span
                className="wh-fig-value mono"
                style={{ color: t.tone === 'danger' ? 'var(--status-risk-fg)' : undefined }}
              >
                {t.value}
              </span>
              {t.delta && (
                <span
                  className="wh-fig-delta mono"
                  style={{
                    color: t.deltaTone === 'down' ? 'var(--status-risk-fg)' : 'var(--muted)',
                  }}
                >
                  {t.delta}
                </span>
              )}
            </div>
            <div className="wh-fig-sub">{t.sub}</div>
          </Link>
        ))}
      </div>

      {/* ── Trucks: one card per route/driver from today's loadout ── */}
      <div data-testid="wh-loadout">
        {loadout == null ? (
          <Panel title="Today's trucks" sub="loading…">
            <ShimmerRows rows={4} />
          </Panel>
        ) : trucks.length === 0 ? (
          <Panel
            title="Today's trucks"
            sub={longDay(loadout.date)}
            link={{ href: daySheetHref, label: 'Day sheet' }}
          >
            <EmptyRow>No deliveries scheduled from here today.</EmptyRow>
          </Panel>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(3, trucks.length)}, minmax(0, 1fr))`,
              gap: 14,
            }}
          >
            {trucks.map((t) => (
              <TruckCard key={t.key} truck={t} allMode={allMode} />
            ))}
          </div>
        )}
      </div>

      {/* ── Receiving beside the Pick list (canvas 8e) ── */}
      <div className="dh-grid">
        <Panel
          title="Receiving"
          sub={overdueCount > 0 ? `${overdueCount} overdue` : 'due and on the way'}
          testid="wh-inbound"
          link={{ href: '/purchase-orders', label: 'All POs' }}
        >
          {summary.inbound.length === 0 ? (
            <EmptyRow>Nothing on the way to this location.</EmptyRow>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {summary.inbound.map((r) => {
                const meta = inboundMeta(r);
                return (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      gap: 8,
                      padding: 'var(--rowy) var(--pad)',
                      borderBottom: '1px solid var(--border)',
                      fontSize: 12.5,
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div>
                        <Link
                          href={`/purchase-orders/${r.id}`}
                          className="mono"
                          style={{ fontWeight: 500 }}
                        >
                          {r.number}
                        </Link>{' '}
                        <span style={{ color: 'var(--text2)' }}>{r.vendorName ?? '—'}</span>
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: r.overdue ? 'var(--danger)' : 'var(--muted)',
                          fontWeight: r.overdue ? 600 : undefined,
                        }}
                      >
                        <span className="mono">
                          {r.receivedUnits}/{r.orderedUnits}
                        </span>{' '}
                        units ·{' '}
                        {r.expectedAt
                          ? `${r.overdue ? 'overdue · ' : ''}${calDay(r.expectedAt)}`
                          : 'no date'}
                      </div>
                      <LocationSub show={allMode} name={r.locationName} />
                    </div>
                    <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
        <Panel
          title="Pick list"
          sub={picklist ? `tomorrow, ${shortDay(picklist.date)} · by bin` : 'tomorrow'}
          testid="wh-picklist"
          actions={
            picklist && picklist.rows.length > 0 ? (
              <Link
                href={`/print/deliveries?date=${picklist.date}`}
                target="_blank"
                rel="noopener"
                className="btn btn-secondary btn-sm"
                style={{ marginLeft: 'auto' }}
                data-noprint="true"
                data-testid="wh-print-tickets"
              >
                Print tickets
              </Link>
            ) : undefined
          }
        >
          <table className="dt dt-static">
            <thead>
              <tr>
                <th className="first">Item</th>
                <th className="num">Pull</th>
                <th>Bin</th>
                <th className="num">On hand</th>
                <th className="last">Status</th>
              </tr>
            </thead>
            <tbody>
              {picklist == null ? (
                <ShimmerRows rows={5} colSpan={5} />
              ) : picklist.rows.length === 0 ? (
                <EmptyRow colSpan={5}>Nothing scheduled to pull for tomorrow yet.</EmptyRow>
              ) : (
                picklist.rows.map((r) => (
                  <tr key={`${r.variantId}:${r.locationId}`}>
                    <td className="first" style={{ whiteSpace: 'normal' }}>
                      {r.productName}
                      {r.variantName ? ` — ${r.variantName}` : ''}
                      {r.sku && <div className="sub">{r.sku}</div>}
                      <LocationSub show={allMode} name={r.locationName} />
                    </td>
                    <td className="num">
                      <strong>{r.quantity}</strong>
                    </td>
                    <td className="mono" style={{ color: 'var(--muted)' }}>
                      {r.bin ?? 'unbinned'}
                    </td>
                    <td
                      className="num"
                      style={{ color: r.short ? 'var(--danger)' : 'var(--muted)' }}
                    >
                      {r.onHand}
                    </td>
                    <td className="last">
                      {r.short ? (
                        <StatusPill tone="danger">Short · only {r.onHand} on hand</StatusPill>
                      ) : r.serialShort ? (
                        <StatusPill tone="danger">Serials unpicked</StatusPill>
                      ) : (
                        <StatusPill tone="muted">Queued</StatusPill>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      </div>

      {/* ── The rest of the building: every close-the-loop queue ── */}
      <div className="dh-grid">
        {/* Arrived first — the highest-value queue, shown even when empty. */}
        <Panel
          title="Arrived — book the delivery or call the customer"
          sub={plural(summary.arrived.length, 'special order')}
          link={{ href: '/special-orders', label: 'Special orders' }}
          style={{ gridColumn: 'span 2' }}
        >
          <table className="dt dt-static" data-testid="wh-arrived">
            <thead>
              <tr>
                <th className="first">Order</th>
                <th>Customer</th>
                <th>Goods</th>
                <th className="num last">Arrived</th>
              </tr>
            </thead>
            <tbody>
              {summary.arrived.length === 0 ? (
                <EmptyRow colSpan={4}>
                  Nothing has arrived that still needs a delivery booked.
                </EmptyRow>
              ) : (
                summary.arrived.map((r) => (
                  <tr key={`${r.orderId}-${r.description}`}>
                    <td className="first">
                      <Link href={`/orders/${r.orderId}`} className="mono">
                        {r.orderNumber}
                      </Link>
                      <LocationSub show={allMode} name={r.locationName} />
                    </td>
                    <td>{r.customerName ?? '—'}</td>
                    <td style={{ color: 'var(--text2)', whiteSpace: 'normal' }}>
                      <span className="mono">{r.quantity}</span> × {r.description}
                    </td>
                    <td className="num last" style={{ color: 'var(--muted)' }}>
                      {ago(r.arrivedAt) === 'today' ? 'today' : `${ago(r.arrivedAt)} ago`}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>

        <Panel
          title="Dock in progress"
          sub="received, not accepted"
          testid="wh-dock"
          link={{ href: '/purchase-orders', label: 'Receiving' }}
        >
          <table className="dt dt-static">
            <thead>
              <tr>
                <th className="first">PO</th>
                <th>Vendor</th>
                <th className="num">Open</th>
                <th className="num last">Idle</th>
              </tr>
            </thead>
            <tbody>
              {summary.dock.length === 0 ? (
                <EmptyRow colSpan={4}>
                  The dock is clear — everything received has been dispositioned.
                </EmptyRow>
              ) : (
                summary.dock.map((r) => (
                  <tr key={r.id}>
                    <td className="first">
                      <Link href={`/purchase-orders/${r.id}`} className="mono">
                        {r.number}
                      </Link>
                      <LocationSub show={allMode} name={r.locationName} />
                    </td>
                    <td>{r.vendorName ?? '—'}</td>
                    <td className="num" style={{ color: 'var(--danger)', fontWeight: 600 }}>
                      {r.unitsInProgress} units
                    </td>
                    <td className="num last" style={{ color: 'var(--muted)' }}>
                      idle {ago(r.lastActivityAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>

        <Panel
          title="Customer pickups"
          sub={stalePickups > 0 ? `${stalePickups} waiting 7d+` : 'waiting to be staged'}
          testid="wh-pickups"
        >
          <table className="dt dt-static">
            <thead>
              <tr>
                <th className="first">Order</th>
                <th>Customer</th>
                <th>Stock</th>
                <th className="num last">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {summary.pickups.length === 0 ? (
                <EmptyRow colSpan={4}>No pickup orders waiting.</EmptyRow>
              ) : (
                summary.pickups.map((r) => (
                  <tr key={r.orderId}>
                    <td className="first">
                      <Link href={`/orders/${r.orderId}`} className="mono">
                        {r.number}
                      </Link>
                      <LocationSub show={allMode} name={r.locationName} />
                    </td>
                    <td>{r.customerName ?? '—'}</td>
                    <td>
                      {r.ready ? (
                        <StatusPill tone="ok">Ready to stage</StatusPill>
                      ) : (
                        <StatusPill tone="danger">Stock short</StatusPill>
                      )}
                    </td>
                    <td
                      className="num last"
                      style={{
                        color: r.ageDays >= 7 ? 'var(--danger)' : 'var(--muted)',
                        fontWeight: r.ageDays >= 7 ? 600 : undefined,
                      }}
                    >
                      waiting {r.ageDays}d
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>

        <Panel
          title="Transfers in motion"
          sub={
            summary.transfers.closedShort30d > 0
              ? `${summary.transfers.closedShort30d} closed short (30d)`
              : undefined
          }
          testid="wh-transfers"
          link={{ href: '/transfers', label: 'All transfers' }}
        >
          <table className="dt dt-static">
            <thead>
              <tr>
                <th className="first">Transfer</th>
                <th>Route</th>
                <th className="num">Units</th>
                <th className="last">Status</th>
              </tr>
            </thead>
            <tbody>
              {summary.transfers.rows.length === 0 ? (
                <EmptyRow colSpan={4}>No transfers touching this location.</EmptyRow>
              ) : (
                summary.transfers.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="first">
                      <Link href="/transfers" className="mono">
                        {r.number}
                      </Link>
                    </td>
                    <td style={{ whiteSpace: 'normal' }}>
                      {r.fromName ?? '—'} → {r.toName ?? '—'}
                    </td>
                    <td className="num" style={{ color: 'var(--muted)' }}>
                      {r.units}
                    </td>
                    <td className="last">
                      {r.awaitingTicket ? (
                        <StatusPill tone="danger">Awaiting ticket</StatusPill>
                      ) : r.days != null && r.days >= 3 ? (
                        <StatusPill tone="danger">In transit {r.days}d</StatusPill>
                      ) : (
                        <StatusPill tone="muted">{r.status.replace(/_/g, ' ')}</StatusPill>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>

        <Panel
          title="As-is review"
          sub={
            <>
              <span className="mono">{summary.asIs.count}</span> pc ·{' '}
              <span className="mono">{usdWhole(summary.asIs.costCents)}</span> at cost
            </>
          }
          testid="wh-asis"
          link={{ href: '/as-is', label: 'Open the review queue' }}
        >
          <table className="dt dt-static">
            <thead>
              <tr>
                <th className="first">Item</th>
                <th>Condition</th>
                <th className="num last">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {summary.asIs.rows.length === 0 ? (
                <EmptyRow colSpan={3}>Nothing waiting for disposition.</EmptyRow>
              ) : (
                summary.asIs.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="first" style={{ whiteSpace: 'normal' }}>
                      <span className="mono">{r.quantity}</span> × {r.productName}
                    </td>
                    <td style={{ color: 'var(--text2)' }}>
                      {r.condition ?? '—'}
                      {allMode && r.locationName ? ` · ${r.locationName}` : ''}
                    </td>
                    <td className="num last" style={{ color: 'var(--muted)' }}>
                      waiting {ago(r.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>

        <Panel
          title="Counts & stock health"
          sub={
            summary.counts.lastPostedDate
              ? `last posted ${calDay(summary.counts.lastPostedDate)}`
              : 'no count posted yet'
          }
          testid="wh-counts"
          link={{ href: '/products/counts', label: 'Counts' }}
          style={{ gridColumn: 'span 2' }}
        >
          <ul className="dh-list">
            <li className={summary.counts.open.length > 0 ? 'is-warn' : 'is-ok'}>
              <span className="dh-list-glyph" aria-hidden>
                {summary.counts.open.length > 0 ? '◔' : '✓'}
              </span>
              <span>
                {summary.counts.open.length > 0 ? (
                  <>
                    {plural(summary.counts.open.length, 'count')} open
                    {summary.counts.open[0]?.locationName
                      ? ` (${summary.counts.open
                          .map((c) => c.locationName)
                          .filter(Boolean)
                          .join(', ')})`
                      : ''}{' '}
                    — <Link href="/products/counts">continue counting</Link>.
                  </>
                ) : (
                  'No counts in progress.'
                )}
              </span>
            </li>
            <li
              className={summary.counts.negative.length > 0 ? 'is-risk' : 'is-ok'}
              data-testid="wh-negative"
            >
              <span className="dh-list-glyph" aria-hidden>
                {summary.counts.negative.length > 0 ? '▲' : '✓'}
              </span>
              <span>
                {summary.counts.negative.length > 0 ? (
                  <>
                    <strong>Negative on-hand:</strong>{' '}
                    {summary.counts.negative.map((n, i) => (
                      <span key={`${n.variantId}:${n.locationName ?? ''}`}>
                        {i > 0 ? ' · ' : ''}
                        {n.productName}
                        {n.sku ? ` (${n.sku})` : ''} <span className="mono">{n.onHand}</span>
                        {allMode && n.locationName ? ` — ${n.locationName}` : ''}
                      </span>
                    ))}{' '}
                    — count these first.
                  </>
                ) : (
                  'No negative on-hand here.'
                )}
              </span>
            </li>
            <li className="is-ok">
              <span className="dh-list-glyph" aria-hidden>
                ✓
              </span>
              <span>
                {summary.counts.lastPostedDate
                  ? `Last count posted ${calDay(summary.counts.lastPostedDate)}.`
                  : 'No count has been posted yet.'}
              </span>
            </li>
          </ul>
        </Panel>
      </div>

      {/* ---- Staff schedule (step 2): read-only, this location ---- */}
      <StaffSchedule lockedLocationId={allMode ? null : summary.location.id} readOnly />
    </div>
  );
}
