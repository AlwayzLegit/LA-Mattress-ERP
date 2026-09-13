'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useDashboardFilters } from '@/lib/dashboard-filters';
import { presetLabel } from '@/lib/date-range';
import { ChangesCard } from '../shared/changes-card';
import { StaffSchedule } from '../shared/staff-schedule';
import { StoresSection } from '../shared/stores-section';
import { MorningBriefCard, type MorningBrief } from './morning-brief';
import { CardHandle, Panel, pctDelta, shortDay, usdWhole } from './owner-kit';
import { WrittenBusinessChart, type TrendPoint } from './written-business';

/**
 * The owner home (redesign Phase 9, README §3.5, canvas 8): one
 * headline — company written today with the same weekday last week and
 * the same day last month beside it — two side tiles (Month to date,
 * Open exceptions), six small figures each with a baseline, the cash
 * pickups queue, one card per store, then Written business and the
 * Morning brief side by side, the Changes log and the Staff schedule.
 * Every card the previous home shipped is still here; the chart and the
 * cards still follow the topbar's store scope, the chart its period.
 * Cards can be reordered / hidden per browser ("Customize").
 */
interface OwnerData {
  date: string;
  range: { start: string; end: string };
  compare: 'none' | 'prior' | 'year';
  compareRange: { start: string; end: string } | null;
  kpis: {
    writtenCents: number;
    writtenCount: number;
    registerCents: number;
    ticketCount: number;
    refundsCents: number;
    refundCount: number;
    openOrders: number;
    openBalanceCents: number;
    receivablesCents: number | null;
    receivableAccounts: number | null;
    trucksToday: { booked: number; cap: number; byStatus: Record<string, number> };
  };
  previous: { writtenCents: number; registerCents: number; refundsCents: number } | null;
  trend: TrendPoint[];
  compareTrend: TrendPoint[];
  today: {
    date: string;
    writtenCents: number;
    ticketCount: number;
    storeCount: number;
    avgTicketCents: number;
    lastWeek: { date: string; writtenCents: number };
    yesterdayWrittenCents: number;
    lastMonth: { date: string; writtenCents: number };
    collectedCents: number;
    collectedLastWeekCents: number;
    balanceDueCents: number;
    refundsCents: number;
    refundsLastWeekCents: number;
    cancellations: number;
    cancellationsLastWeek: number;
    deliveries: { booked: number; cap: number };
  };
  monthToDate: {
    range: { start: string; end: string };
    writtenCents: number;
    prior: { start: string; end: string };
    priorCents: number;
  };
  exceptions: { open: number; critical: number };
}

type CardId = 'pickups' | 'stores' | 'revenue' | 'brief' | 'changes' | 'schedule';
const CARD_IDS: CardId[] = ['pickups', 'stores', 'revenue', 'brief', 'changes', 'schedule'];
const LAYOUT_KEY = 'jetnine.dashboard.layout.v2';
interface Layout {
  order: CardId[];
  hidden: Partial<Record<CardId, boolean>>;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}
function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
}
function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

export default function OwnerHome({ userName, email }: { userName: string; email: string }) {
  const f = useDashboardFilters();
  const [data, setData] = useState<OwnerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState(false);
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(true);
  const [customize, setCustomize] = useState(false);
  const [layout, setLayout] = useState<Layout>({ order: CARD_IDS, hidden: {} });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const l = JSON.parse(raw) as Layout;
        const order = l.order.filter((id) => CARD_IDS.includes(id));
        for (const id of CARD_IDS) if (!order.includes(id)) order.push(id);
        setLayout({ order, hidden: l.hidden ?? {} });
      }
    } catch {
      // ignore
    }
  }, []);
  const saveLayout = (next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const load = useCallback(() => {
    if (!f.rangeReady) return;
    setLoading(true);
    setError(false);
    void api<OwnerData>(`/v1/dashboard/owner?${f.query}`)
      .then((d) => {
        setData(d);
        setDenied(false);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) setDenied(true);
        else setError(true);
      })
      .finally(() => setLoading(false));
  }, [f.query, f.rangeReady]);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setBriefLoading(true);
    void api<MorningBrief>('/v1/dashboard/morning')
      .then(setBrief)
      .catch(() => setBrief(null))
      .finally(() => setBriefLoading(false));
  }, []);

  const compareLabel = f.compare === 'year' ? 'Last year' : f.compare === 'prior' ? 'Prior' : null;
  const cmpFull =
    f.compare === 'year' ? 'Same period last year' : f.compare === 'prior' ? 'Prior period' : null;

  const card = (id: CardId) => {
    const i = layout.order.indexOf(id);
    const hidden = !!layout.hidden[id];
    return {
      style: {
        order: i + 1,
        display: hidden && !customize ? 'none' : undefined,
        opacity: hidden ? 0.45 : 1,
      } as React.CSSProperties,
      handle: customize ? (
        <CardHandle
          hidden={hidden}
          onUp={() => {
            if (i > 0) {
              const o = [...layout.order];
              [o[i - 1], o[i]] = [o[i]!, o[i - 1]!];
              saveLayout({ ...layout, order: o });
            }
          }}
          onDown={() => {
            if (i < CARD_IDS.length - 1) {
              const o = [...layout.order];
              [o[i + 1], o[i]] = [o[i]!, o[i + 1]!];
              saveLayout({ ...layout, order: o });
            }
          }}
          onHide={() => saveLayout({ ...layout, hidden: { ...layout.hidden, [id]: !hidden } })}
        />
      ) : undefined,
    };
  };

  const t = data?.today;
  const storeCount =
    f.storeIds?.length ?? f.stores.filter((s) => s.locationType !== 'warehouse').length;
  const scopeWord = f.storeIds ? f.storeLabel : 'every store';
  const trendEmpty = !!data && data.trend.every((p) => p.orderCents + p.registerCents === 0);
  const wk = t ? pctDelta(t.writtenCents, t.lastWeek.writtenCents) : null;
  const mo = t ? pctDelta(t.writtenCents, t.lastMonth.writtenCents) : null;
  const mtdDelta = data
    ? pctDelta(data.monthToDate.writtenCents, data.monthToDate.priorCents)
    : null;
  const up = (now: number, base: number) => now >= base;
  const delta = (now: number, base: number, invert = false) => {
    const p = pctDelta(now, base);
    if (!p) return { text: null as string | null, tone: 'muted' as const };
    const good = invert ? now <= base : now >= base;
    return { text: p, tone: good ? ('ok' as const) : ('bad' as const) };
  };

  const figures = t
    ? [
        {
          key: 'collected',
          label: 'Collected',
          value: usdWhole(t.collectedCents),
          ...delta(t.collectedCents, t.collectedLastWeekCents),
          href: '/reports',
        },
        {
          key: 'balance',
          label: 'Balance due',
          value: usdWhole(t.balanceDueCents),
          text: `${data!.kpis.openOrders} open`,
          tone: 'muted' as const,
          href: '/orders?balanceDue=1',
        },
        {
          key: 'refunds',
          label: 'Refunds',
          value: usdWhole(t.refundsCents),
          text:
            t.refundsCents - t.refundsLastWeekCents === 0
              ? 'same as last week'
              : `${t.refundsCents > t.refundsLastWeekCents ? '+' : '−'}${usdWhole(Math.abs(t.refundsCents - t.refundsLastWeekCents))}`,
          tone: t.refundsCents > t.refundsLastWeekCents ? ('bad' as const) : ('muted' as const),
          danger: t.refundsCents > 0,
          href: '/returns',
        },
        {
          key: 'cancels',
          label: 'Cancellations',
          value: String(t.cancellations),
          text:
            t.cancellations - t.cancellationsLastWeek === 0
              ? 'same as last week'
              : `${t.cancellations > t.cancellationsLastWeek ? '+' : '−'}${Math.abs(t.cancellations - t.cancellationsLastWeek)}`,
          tone: t.cancellations > t.cancellationsLastWeek ? ('bad' as const) : ('muted' as const),
          href: '/orders?status=Cancelled',
        },
        {
          key: 'avg',
          label: 'Avg ticket',
          value: t.ticketCount ? usdWhole(t.avgTicketCents) : '—',
          ...(t.lastWeek.writtenCents
            ? { text: `${t.ticketCount} today`, tone: 'muted' as const }
            : { text: null, tone: 'muted' as const }),
          href: '/reports',
        },
        {
          key: 'deliveries',
          label: 'Deliveries today',
          value: String(t.deliveries.booked),
          text: `/ ${t.deliveries.cap}`,
          tone: t.deliveries.booked > t.deliveries.cap ? ('bad' as const) : ('muted' as const),
          href: `/deliveries`,
        },
      ]
    : [];

  return (
    <div className="dh" data-testid="owner-home">
      <div className="dh-top">
        <div>
          <div className="dh-eyebrow">
            {t ? longDate(t.date) : '…'} · {scopeWord}
            <span data-testid="dashboard-email" className="dh-email">
              · {email}
            </span>
          </div>
        </div>
        <div className="dh-top-actions" data-noprint="true">
          <button
            type="button"
            className={`btn btn-sm ${customize ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setCustomize((v) => !v)}
          >
            {customize ? 'Done' : 'Customize'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="dh-alert is-error">
          <span style={{ flex: 1 }}>
            <strong>Couldn&apos;t reach the sales service.</strong> Written, collected and refund
            figures are unavailable; stores, deliveries and the schedule are live.
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {customize && (
        <div className="dh-alert is-note">
          <span style={{ flex: 1 }}>
            <strong>Customizing your home.</strong> Use ▲ ▼ to reorder cards and ⊘ to hide them.
            Saved to this browser.
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              saveLayout({ order: CARD_IDS, hidden: {} });
              try {
                localStorage.removeItem(LAYOUT_KEY);
              } catch {
                // ignore
              }
            }}
          >
            Reset
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCustomize(false)}
          >
            Done
          </button>
        </div>
      )}

      {!denied && (
        <div className="dh-head" data-testid="dh-head">
          <section className="panel dh-headline" data-testid="dh-headline">
            <div className="dh-label">Company written today{t ? ` · ${longDate(t.date)}` : ''}</div>
            {loading && !data ? (
              <div className="shimmer" style={{ height: 56, width: 260, margin: '6px 0' }} />
            ) : (
              <div className="dh-value" data-testid="dh-written">
                {t ? usdWhole(t.writtenCents) : '—'}
              </div>
            )}
            {t && t.writtenCents === 0 && !loading && (
              <div className="dh-base" data-testid="dh-written-empty">
                Nothing written yet today. Yesterday: {usdWhole(t.yesterdayWrittenCents)}.
              </div>
            )}
            <div className="dh-baselines">
              <div>
                <strong
                  className={`mono ${t && up(t.writtenCents, t.lastWeek.writtenCents) ? 'is-up' : 'is-down'}`}
                >
                  {wk ?? '—'}
                </strong>{' '}
                vs same day last week{' '}
                <span className="mono dh-base">
                  {t
                    ? `${usdWhole(t.lastWeek.writtenCents)} last ${weekdayOf(t.lastWeek.date)}`
                    : ''}
                </span>
              </div>
              <div>
                <strong
                  className={`mono ${t && up(t.writtenCents, t.lastMonth.writtenCents) ? 'is-up' : 'is-down'}`}
                >
                  {mo ?? '—'}
                </strong>{' '}
                vs same day last month{' '}
                <span className="mono dh-base">
                  {t ? `${usdWhole(t.lastMonth.writtenCents)} ${shortDay(t.lastMonth.date)}` : ''}
                </span>
              </div>
            </div>
            <div className="dh-sub">
              {t
                ? `${t.ticketCount} ticket${t.ticketCount === 1 ? '' : 's'} across ${countWord(storeCount || t.storeCount)} store${(storeCount || t.storeCount) === 1 ? '' : 's'}${t.ticketCount ? ` · avg ${usdWhole(t.avgTicketCents)}` : ''}`
                : ' '}
            </div>
          </section>

          <Link href="/reports" className="panel dh-side" data-testid="dh-mtd">
            <div className="dh-label">Month to date</div>
            <div className="dh-side-value mono">
              {data ? usdWhole(data.monthToDate.writtenCents) : '—'}
            </div>
            <div className="dh-side-delta">
              {mtdDelta && (
                <strong
                  className={`mono ${data && up(data.monthToDate.writtenCents, data.monthToDate.priorCents) ? 'is-up' : 'is-down'}`}
                >
                  {mtdDelta}
                </strong>
              )}{' '}
              <span className="dh-base">
                {data
                  ? `vs ${shortDay(data.monthToDate.prior.start)}–${shortDay(data.monthToDate.prior.end).replace(/^\w+ /, '')}`
                  : ''}
              </span>
            </div>
            <span className="dh-side-link">Written business →</span>
          </Link>

          <Link href="/exceptions" className="panel dh-side" data-testid="dh-exceptions">
            <div className="dh-label">Open exceptions</div>
            <div
              className="dh-side-value mono"
              style={{
                color: data && data.exceptions.open > 0 ? 'var(--status-risk-fg)' : undefined,
              }}
            >
              {data ? data.exceptions.open : '—'}
            </div>
            <div className="dh-side-delta">
              {data && data.exceptions.critical > 0 && (
                <strong className="mono is-down">{data.exceptions.critical} critical</strong>
              )}{' '}
              <span className="dh-base">· from the 10pm close</span>
            </div>
            <span className="dh-side-link">Review →</span>
          </Link>
        </div>
      )}

      {!denied && (
        <div className="dh-figs" data-testid="kpi-row">
          {(figures.length
            ? figures
            : Array.from({ length: 6 }, (_, i) => ({ key: String(i) }))
          ).map((g) => {
            const fig = g as (typeof figures)[number];
            return (
              <Link
                key={fig.key}
                href={fig.href ?? '#'}
                className="dh-fig"
                data-testid={`kpi-${fig.key}`}
              >
                <div className="dh-fig-label">{fig.label ?? ''}</div>
                <div className="dh-fig-row">
                  {fig.value == null ? (
                    <div className="shimmer" style={{ height: 18, width: 70 }} />
                  ) : (
                    <span
                      className="dh-fig-value mono"
                      style={{ color: fig.danger ? 'var(--status-risk-fg)' : undefined }}
                    >
                      {fig.value}
                    </span>
                  )}
                  {fig.text && (
                    <span className={`dh-fig-delta mono is-${fig.tone}`}>{fig.text}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <div className="dh-grid">
        <StoresSection
          locationIds={f.storeIds}
          showQueue
          actorName={userName}
          handle={card('stores').handle}
          queueHandle={card('pickups').handle}
          style={{ gridColumn: 'span 2', ...card('stores').style }}
          queueStyle={{ gridColumn: 'span 2', ...card('pickups').style }}
        />

        {!denied && (
          <Panel
            title="Written business"
            sub={`${presetLabel(f.range.preset).toLowerCase()} · ${scopeWord}`}
            link={{ href: '/reports', label: 'Reports' }}
            style={card('revenue').style}
            clip={false}
            actions={
              <>
                <div className="dh-legend">
                  <span>
                    <i style={{ background: 'var(--accent)' }} />
                    Orders
                  </span>
                  <span>
                    <i style={{ background: 'var(--border2)' }} />
                    Register
                  </span>
                  {cmpFull && data && data.compareTrend.length > 0 && (
                    <span>
                      <i className="is-dashed" />
                      {cmpFull}
                    </span>
                  )}
                </div>
                {card('revenue').handle}
              </>
            }
          >
            <WrittenBusinessChart
              points={data?.trend ?? []}
              compare={data?.compareTrend ?? []}
              compareLabel={compareLabel}
              loading={loading && !data}
              error={error && !data}
              empty={trendEmpty}
            />
          </Panel>
        )}

        <div
          style={{ display: 'flex', flexDirection: 'column', minWidth: 0, ...card('brief').style }}
        >
          <MorningBriefCard
            brief={brief}
            loading={briefLoading}
            storeIds={f.storeIds}
            handle={card('brief').handle}
          />
        </div>

        <ChangesCard
          locationIds={f.storeIds}
          handle={card('changes').handle}
          style={{ gridColumn: 'span 2', ...card('changes').style }}
        />

        <StaffSchedule
          handle={card('schedule').handle}
          style={{ gridColumn: 'span 2', ...card('schedule').style }}
        />
      </div>
    </div>
  );
}
