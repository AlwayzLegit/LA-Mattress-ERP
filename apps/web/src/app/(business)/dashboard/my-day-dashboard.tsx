'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Card,
  KeyValue,
  LinkButton,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  StatGrid,
  StatTile,
  StatusBadge,
  TableWrap,
  Button,
} from '@/components/ui';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { TableCard, usd as fmtUsd } from './dashboard-kit';

/**
 * The Cashier home — "My Day" (owner 2026-09-01, §12.3). Ten cards for
 * the person at the register: how am I doing today, is my drawer right,
 * who do I call back, whose delivery is today, who still owes, who is
 * here to pick up, what have I earned, what can I offer, what did I
 * start that isn't finished, and how the store looks. New Sale stays
 * one click away at the top — the dashboard serves selling, never
 * replaces it.
 */

interface DayStats {
  writtenCents: number;
  documents: number;
  collectedCents: number;
  avgTicketCents: number;
}

interface Summary {
  date: string;
  location: { id: string; name: string; timezone: string };
  locations: { id: string; name: string; locationType: string }[];
  myDay: { today: DayStats; lastWeek: DayStats };
  drawer: {
    shift: {
      id: string;
      locationId: string;
      locationName: string | null;
      openedAt: string;
      hoursOpen: number;
      openingFloatCents: number;
      cashInCents: number;
      expectedCashCents: number;
      suspended: boolean;
      stale: boolean;
    } | null;
    lastClose: { closedAt: string; varianceCents: number | null } | null;
  };
  callbacks: {
    orderId: string;
    number: string;
    status: string;
    customerName: string | null;
    phone: string | null;
    totalCents: number;
    createdAt: string;
    ageDays: number;
  }[];
  myDeliveries: {
    deliveryId: string;
    orderId: string;
    orderNumber: string;
    customerName: string | null;
    phone: string | null;
    scheduledDate: string;
    windowStart: string | null;
    windowEnd: string | null;
    status: string;
    driverName: string | null;
    when: 'today' | 'tomorrow';
  }[];
  balanceDue: {
    totalCents: number;
    rows: {
      orderId: string;
      number: string;
      status: string;
      customerName: string | null;
      phone: string | null;
      fulfillmentType: string | null;
      requestedDate: string | null;
      totalCents: number;
      paidCents: number;
      balanceCents: number;
      dueNow: boolean;
    }[];
  };
  pickups: {
    orderId: string;
    number: string;
    customerName: string | null;
    phone: string | null;
    ageDays: number;
    ready: boolean;
    mine: boolean;
  }[];
  commission: {
    period: string;
    accruedCents: number;
    pendingCents: number;
    approvedCents: number;
    paidCents: number;
    lastPaid: { period: string; cents: number } | null;
  };
  promos: {
    codes: {
      id: string;
      code: string;
      kind: string;
      value: number;
      description: string | null;
      minSubtotalCents: number | null;
      endsAt: string | null;
      remainingUses: number | null;
    }[];
    priceVariance: { tier1Pct: number; tier1MaxCents: number; tier2Pct: number };
  };
  myReturns: {
    id: string;
    kind: 'return' | 'exchange';
    number: string;
    status: string;
    orderId: string | null;
    orderNumber: string | null;
    customerName: string | null;
    amountCents: number | null;
    createdAt: string;
  }[];
  scoreboard: {
    storeTodayCents: number;
    storeTodayDocuments: number;
    myShareCents: number;
    week: { rank: number | null; sellers: number; myCents: number; leaderCents: number };
  };
}

function tickets(n: number): string {
  return `${n} ticket${n === 1 ? '' : 's'}`;
}

function pctDelta(now: number, then: number): string | null {
  if (then <= 0) return now > 0 ? 'new vs last week' : null;
  const pct = Math.round(((now - then) / then) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}% vs last ${new Date().toLocaleDateString(undefined, { weekday: 'long' })}`;
}

function window(start: string | null, end: string | null): string {
  const fmt = (t: string) => t.slice(0, 5);
  if (start && end) return `${fmt(start)}–${fmt(end)}`;
  if (start) return `from ${fmt(start)}`;
  return 'window TBD';
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** A phone number as a tap-to-call line under a customer name. */
function Phone({ phone }: { phone: string | null }) {
  if (!phone) return null;
  return (
    <div>
      <a href={`tel:${phone}`} className="muted">
        {phone}
      </a>
    </div>
  );
}

export default function MyDayDashboardView({ userName }: { userName: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);

  const load = useCallback(async (loc: string | null) => {
    setError(null);
    try {
      const qs = loc ? `?locationId=${loc}` : '';
      const s = await api<Summary>(`/v1/dashboard/my-day${qs}`);
      setSummary(s);
      setLocationId(s.location.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const title = `My Day — ${userName}`;

  if (error) {
    return (
      <>
        <PageHeader title={title} />
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
      </>
    );
  }
  if (!summary) {
    return (
      <>
        <PageHeader title={title} />
        <LoadingRows />
      </>
    );
  }

  const { myDay, drawer, scoreboard, commission } = summary;
  const delta = pctDelta(myDay.today.writtenCents, myDay.lastWeek.writtenCents);
  const dueNow = summary.balanceDue.rows.filter((r) => r.dueNow).length;
  const readyPickups = summary.pickups.filter((p) => p.ready).length;
  const todayDeliveries = summary.myDeliveries.filter((d) => d.when === 'today').length;

  return (
    <div data-testid="my-day-dashboard">
      <PageHeader
        title={title}
        sub={
          <>
            {summary.date} · <strong>{summary.location.name}</strong>
          </>
        }
        actions={
          <>
            {summary.locations.length > 1 && (
              <Select
                aria-label="Store"
                data-testid="my-day-location-picker"
                value={locationId ?? ''}
                onChange={(e) => {
                  setSummary(null);
                  void load(e.target.value);
                }}
              >
                {summary.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
            <LinkButton variant="primary" href="/pos" data-testid="my-day-new-sale">
              New Sale
            </LinkButton>
          </>
        }
      />

      <Stack>
        {/* Card 1 + the headline numbers from cards 2, 5, 6, 7 */}
        <StatGrid cols={5}>
          <StatTile
            label="Written today"
            data-testid="md-kpi-written"
            value={<Money cents={myDay.today.writtenCents} />}
            sub={`${tickets(myDay.today.documents)} · ${delta ?? 'nothing last week'}`}
          />
          <StatTile
            label="Collected today"
            data-testid="md-kpi-collected"
            value={<Money cents={myDay.today.collectedCents} />}
            sub={
              myDay.today.documents > 0
                ? `avg ticket ${fmtUsd(myDay.today.avgTicketCents)}`
                : 'no tickets yet'
            }
          />
          <StatTile
            label="My drawer"
            data-testid="md-kpi-drawer"
            tone={drawer.shift?.stale || drawer.shift?.suspended ? 'danger' : undefined}
            value={drawer.shift ? <Money cents={drawer.shift.expectedCashCents} /> : 'closed'}
            sub={
              drawer.shift
                ? drawer.shift.suspended
                  ? 'suspended — finish the close'
                  : drawer.shift.stale
                    ? `open ${drawer.shift.hoursOpen}h — close it`
                    : `open ${drawer.shift.hoursOpen}h · ${drawer.shift.locationName ?? ''}`
                : 'no shift open'
            }
          />
          <StatTile
            label="Balance due"
            data-testid="md-kpi-balance"
            tone={dueNow > 0 ? 'danger' : undefined}
            value={<Money cents={summary.balanceDue.totalCents} />}
            sub={
              dueNow > 0
                ? `${dueNow} due now`
                : `${summary.balanceDue.rows.length} order${summary.balanceDue.rows.length === 1 ? '' : 's'} owing`
            }
          />
          <StatTile
            label={`Commission · ${commission.period}`}
            data-testid="md-kpi-commission"
            value={<Money cents={commission.accruedCents} />}
            sub={
              commission.paidCents > 0
                ? `${fmtUsd(commission.paidCents)} paid`
                : commission.approvedCents > 0
                  ? `${fmtUsd(commission.approvedCents)} approved`
                  : `${fmtUsd(commission.pendingCents)} pending`
            }
          />
        </StatGrid>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Card 3 */}
          <TableCard
            title="Call-backs — my quotes and drafts"
            data-testid="md-callbacks"
            actions={
              <Link href="/orders?mine=1&status=quote" className="btn-link">
                All quotes →
              </Link>
            }
            isEmpty={summary.callbacks.length === 0}
            empty="No open quotes or drafts. Every lead is either sold or closed."
          >
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th className="num">Value</th>
                  <th className="num">Age</th>
                </tr>
              </thead>
              <tbody>
                {summary.callbacks.map((r) => (
                  <tr key={r.orderId}>
                    <td className="nowrap">
                      <Link href={`/orders/${r.orderId}`}>{r.number}</Link>
                      <div>
                        <StatusBadge status={r.status} />
                      </div>
                    </td>
                    <td>
                      {r.customerName ?? '—'}
                      <Phone phone={r.phone} />
                    </td>
                    <td className="num nowrap">
                      <Money cents={r.totalCents} />
                    </td>
                    <td
                      className="num nowrap"
                      style={{ color: r.ageDays >= 3 ? 'var(--danger)' : 'var(--text-muted)' }}
                    >
                      {r.ageDays === 0 ? 'today' : `${r.ageDays}d`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>

          {/* Card 4 */}
          <TableCard
            title={`My deliveries — today${todayDeliveries > 0 ? ` (${todayDeliveries})` : ''} and tomorrow`}
            data-testid="md-deliveries"
            actions={
              <Link href={`/deliveries/day/${summary.date}`} className="btn-link">
                Day sheet →
              </Link>
            }
            isEmpty={summary.myDeliveries.length === 0}
            empty="None of your customers are on the truck today or tomorrow."
          >
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Order</th>
                  <th>Driver</th>
                  <th className="actions">Status</th>
                </tr>
              </thead>
              <tbody>
                {summary.myDeliveries.map((d) => (
                  <tr key={d.deliveryId}>
                    <td className="nowrap">
                      <strong>{d.when}</strong>
                      <div className="muted">{window(d.windowStart, d.windowEnd)}</div>
                    </td>
                    <td>
                      <Link href={`/orders/${d.orderId}`}>{d.orderNumber}</Link>
                      <div className="muted">
                        {d.customerName ?? '—'}
                        {d.phone ? ` · ${d.phone}` : ''}
                      </div>
                    </td>
                    <td className="muted">{d.driverName ?? 'no driver'}</td>
                    <td className="actions">
                      <StatusBadge status={d.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Card 5 */}
          <TableCard
            title="Balance due — my open orders"
            data-testid="md-balance"
            actions={
              <span className="muted">
                <Money cents={summary.balanceDue.totalCents} /> open
              </span>
            }
            isEmpty={summary.balanceDue.rows.length === 0}
            empty="Every open order of yours is paid in full."
          >
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {summary.balanceDue.rows.map((r) => (
                  <tr key={r.orderId}>
                    <td className="nowrap">
                      <Link href={`/orders/${r.orderId}`}>{r.number}</Link>
                      <div className="muted">
                        {r.fulfillmentType?.replace(/_/g, ' ') ?? '—'}
                        {r.requestedDate ? ` · ${r.requestedDate}` : ''}
                      </div>
                    </td>
                    <td>
                      {r.customerName ?? '—'}
                      <Phone phone={r.phone} />
                    </td>
                    <td className="num nowrap">
                      <strong style={{ color: r.dueNow ? 'var(--danger)' : undefined }}>
                        <Money cents={r.balanceCents} />
                      </strong>
                      <div className="muted">
                        of <Money cents={r.totalCents} />
                        {r.dueNow ? ' · due now' : ''}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>

          {/* Card 6 */}
          <TableCard
            title={`Pickups waiting at ${summary.location.name}`}
            data-testid="md-pickups"
            actions={<span className="muted">{readyPickups} ready</span>}
            isEmpty={summary.pickups.length === 0}
            empty="No pickup orders waiting here."
          >
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th className="num">Stock</th>
                </tr>
              </thead>
              <tbody>
                {summary.pickups.map((p) => (
                  <tr key={p.orderId}>
                    <td className="nowrap">
                      <Link href={`/orders/${p.orderId}`}>{p.number}</Link>
                      {p.mine && <div className="muted">mine</div>}
                    </td>
                    <td>
                      {p.customerName ?? '—'}
                      {p.phone ? <span className="muted"> · {p.phone}</span> : null}
                    </td>
                    <td className="num nowrap">
                      <span style={{ color: p.ready ? 'var(--success)' : 'var(--text-muted)' }}>
                        {p.ready ? 'ready' : 'not all in stock'}
                      </span>
                      <div className="muted">
                        waiting {p.ageDays === 0 ? 'since today' : `${p.ageDays}d`}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {/* Card 7 */}
          <Card title={`Commission — ${commission.period}`} data-testid="md-commission">
            <KeyValue
              rows={[
                { label: 'Accrued this period', value: <Money cents={commission.accruedCents} /> },
                { label: 'Pending review', value: <Money cents={commission.pendingCents} /> },
                { label: 'Approved', value: <Money cents={commission.approvedCents} /> },
                { label: 'Paid', value: <Money cents={commission.paidCents} /> },
                {
                  label: 'Last payout',
                  value: commission.lastPaid ? (
                    <>
                      <Money cents={commission.lastPaid.cents} />
                      <span className="muted"> · {commission.lastPaid.period}</span>
                    </>
                  ) : (
                    '—'
                  ),
                },
              ]}
            />
          </Card>

          {/* Card 8 */}
          <Card
            title="What I can offer"
            description={
              <>
                Discount without a manager: up to{' '}
                <strong>{summary.promos.priceVariance.tier1Pct}%</strong> or{' '}
                <strong>{fmtUsd(summary.promos.priceVariance.tier1MaxCents)}</strong> per ticket.
                Manager approval up to <strong>{summary.promos.priceVariance.tier2Pct}%</strong>.
              </>
            }
            data-testid="md-promos"
          >
            {summary.promos.codes.length === 0 ? (
              <p className="muted">No promo codes running.</p>
            ) : (
              <TableWrap>
                <table className="table table-dense">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Offer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.promos.codes.map((c) => (
                      <tr key={c.id}>
                        <td className="nowrap">
                          <code>{c.code}</code>
                        </td>
                        <td>
                          <strong>
                            {c.kind === 'percent' ? `${c.value}% off` : `${fmtUsd(c.value)} off`}
                          </strong>
                          {c.minSubtotalCents ? (
                            <span className="muted"> · min {fmtUsd(c.minSubtotalCents)}</span>
                          ) : null}
                          {c.endsAt ? (
                            <span className="muted"> · ends {c.endsAt.slice(0, 10)}</span>
                          ) : null}
                          {c.remainingUses != null ? (
                            <span className="muted"> · {c.remainingUses} left</span>
                          ) : null}
                          {c.description && <div className="muted">{c.description}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          {/* Card 10 */}
          <Card title={`${summary.location.name} today`} data-testid="md-scoreboard">
            <KeyValue
              rows={[
                {
                  label: 'Store written',
                  value: (
                    <>
                      <Money cents={scoreboard.storeTodayCents} />
                      <span className="muted"> · {scoreboard.storeTodayDocuments} tickets</span>
                    </>
                  ),
                },
                { label: 'My share', value: <Money cents={scoreboard.myShareCents} /> },
                {
                  label: 'This week',
                  value:
                    scoreboard.week.rank != null ? (
                      <>
                        <strong>{ordinal(scoreboard.week.rank)}</strong> of{' '}
                        {scoreboard.week.sellers} · <Money cents={scoreboard.week.myCents} />
                        {scoreboard.week.rank > 1 && (
                          <span className="muted">
                            {' '}
                            · leader <Money cents={scoreboard.week.leaderCents} />
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">nothing written yet this week</span>
                    ),
                },
              ]}
            />
          </Card>
        </div>

        {/* Card 9 */}
        <TableCard
          title="My returns and exchanges in progress"
          data-testid="md-returns"
          isEmpty={summary.myReturns.length === 0}
          empty="Nothing you started is waiting on goods or a refund."
        >
          <table className="table table-dense">
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th className="num">Amount</th>
                <th className="actions">Status</th>
              </tr>
            </thead>
            <tbody>
              {summary.myReturns.map((r) => (
                <tr key={`${r.kind}-${r.id}`}>
                  <td className="nowrap">
                    <Link href={r.kind === 'return' ? `/returns/${r.id}` : `/exchanges/${r.id}`}>
                      {r.number}
                    </Link>
                    <div className="muted">{r.kind}</div>
                  </td>
                  <td>
                    {r.customerName ?? '—'}
                    {r.orderId && r.orderNumber && (
                      <div className="muted">
                        on <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>
                      </div>
                    )}
                  </td>
                  <td className="num nowrap">
                    {r.amountCents != null ? <Money cents={r.amountCents} /> : '—'}
                  </td>
                  <td className="actions">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>

        {drawer.lastClose && (
          <p className="muted">
            Last drawer close at {summary.location.name}:{' '}
            {new Date(drawer.lastClose.closedAt).toLocaleString()}
            {drawer.lastClose.varianceCents != null && drawer.lastClose.varianceCents !== 0 ? (
              <>
                {' '}
                · variance <Money cents={drawer.lastClose.varianceCents} />
              </>
            ) : (
              ' · balanced'
            )}
          </p>
        )}
      </Stack>
    </div>
  );
}
