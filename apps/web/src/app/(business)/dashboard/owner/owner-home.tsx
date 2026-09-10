'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useDashboardFilters } from '@/lib/dashboard-filters';
import { presetLabel } from '@/lib/date-range';
import { ChangesCard } from '../shared/changes-card';
import { StoresSection } from '../shared/stores-section';
import { MorningBriefCard, type MorningBrief } from './morning-brief';
import {
  CardHandle,
  KpiStrip,
  Panel,
  pctDelta,
  usdShort,
  usdWhole,
  type KpiTile,
} from './owner-kit';
import { WrittenBusinessChart, type TrendPoint } from './written-business';

/**
 * The owner home (Claude Design hand-off 2026-09-04, reworked 2026-09-10):
 * KPI strip, written-business chart and morning brief following the
 * topbar's period, store scope and compare-to; then one card per store
 * (salespeople, money received, cash pickup ticks) and the full-width
 * Changes log — both scoped to the topbar's stores, with their own
 * month-to-date / today toggle. Cards can be reordered / hidden per
 * browser ("Customize").
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
}

type CardId = 'revenue' | 'brief' | 'stores' | 'changes';
const CARD_IDS: CardId[] = ['revenue', 'brief', 'stores', 'changes'];
const LAYOUT_KEY = 'jetnine.dashboard.layout';
interface Layout {
  order: CardId[];
  hidden: Partial<Record<CardId, boolean>>;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
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
  const vs = compareLabel
    ? `vs ${compareLabel.toLowerCase()}`
    : presetLabel(f.range.preset).toLowerCase();

  const tiles = useMemo<KpiTile[]>(() => {
    const k = data?.kpis;
    const p = data?.previous ?? null;
    const dash = (v: string) => (k ? v : '—');
    return [
      {
        key: 'written',
        label: 'Written',
        value: dash(k ? usdWhole(k.writtenCents) : ''),
        delta: k && p ? pctDelta(k.writtenCents, p.writtenCents) : null,
        deltaTone: k && p && k.writtenCents < p.writtenCents ? 'down' : 'up',
        sub: k
          ? `${k.writtenCount} order${k.writtenCount === 1 ? '' : 's'} · ${vs}`
          : 'unavailable',
        href: '/orders',
        testid: 'kpi-written',
      },
      {
        key: 'register',
        label: 'Register',
        value: dash(k ? usdWhole(k.registerCents) : ''),
        delta: k && p ? pctDelta(k.registerCents, p.registerCents) : null,
        deltaTone: k && p && k.registerCents < p.registerCents ? 'down' : 'up',
        sub: k ? `${k.ticketCount} ticket${k.ticketCount === 1 ? '' : 's'}` : 'unavailable',
        href: '/sales',
      },
      {
        key: 'refunds',
        label: 'Refunds',
        value: dash(k ? usdWhole(k.refundsCents) : ''),
        delta: k && p ? pctDelta(k.refundsCents, p.refundsCents) : null,
        deltaTone: k && p && k.refundsCents > p.refundsCents ? 'down' : 'up',
        sub: k ? `${k.refundCount} refund${k.refundCount === 1 ? '' : 's'}` : 'unavailable',
        href: '/returns',
        tone: k && k.refundsCents > 0 ? 'danger' : undefined,
      },
      {
        key: 'open',
        label: 'Open orders',
        value: dash(k ? String(k.openOrders) : ''),
        sub: k ? `${usdShort(k.openBalanceCents)} balance outstanding` : '',
        href: '/orders?status=open',
      },
      {
        key: 'ar',
        label: 'Receivables',
        value: k?.receivablesCents != null ? usdWhole(k.receivablesCents) : '—',
        sub:
          k?.receivableAccounts != null
            ? `${k.receivableAccounts} account${k.receivableAccounts === 1 ? '' : 's'} owing`
            : 'financial reports only',
        href: '/reports',
      },
      {
        key: 'trucks',
        label: 'Trucks today',
        value: k ? `${k.trucksToday.booked} / ${k.trucksToday.cap}` : '—',
        sub: k
          ? Object.entries(k.trucksToday.byStatus)
              .map(([s, n]) => `${n} ${s.replace(/_/g, ' ')}`)
              .join(' · ') || 'nothing booked'
          : '',
        href: '/deliveries/dispatch',
        tone: k && k.trucksToday.booked > k.trucksToday.cap ? 'danger' : undefined,
      },
    ];
  }, [data, vs]);

  const card = (id: CardId) => {
    const i = layout.order.indexOf(id);
    const hidden = !!layout.hidden[id];
    return {
      style: {
        order: i + 1,
        display: hidden && !customize ? 'none' : 'flex',
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

  const today = new Date();
  const storeCount = f.storeIds?.length ?? f.stores.length;
  const sub = `${today.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} · ${storeCount} store${storeCount === 1 ? '' : 's'} · ${presetLabel(f.range.preset).toLowerCase()}`;
  const trendEmpty = !!data && data.trend.every((p) => p.orderCents + p.registerCents === 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="owner-home">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div>
          <h1 className="page-title">
            {greeting()}, {userName.split(' ')[0]}
          </h1>
          <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3 }}>
            {sub}
            <span data-testid="dashboard-email" style={{ marginLeft: 8, color: 'var(--faint)' }}>
              · {email}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} data-noprint="true">
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
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            border: '1px solid var(--danger)',
            borderRadius: 8,
            background: 'var(--danger-soft)',
            fontSize: 12.5,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--danger)',
              flex: 'none',
            }}
          />
          <span style={{ flex: 1 }}>
            <strong style={{ fontWeight: 600 }}>Couldn&apos;t reach the sales service.</strong>{' '}
            Written, register and refund figures are unavailable; inventory and delivery data are
            live.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            style={{
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              background: 'var(--surface)',
            }}
            onClick={load}
          >
            Retry
          </button>
        </div>
      )}
      {customize && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            border: '1px dashed var(--accent)',
            borderRadius: 8,
            background: 'var(--accent-soft)',
            fontSize: 12.5,
          }}
        >
          <span style={{ flex: 1 }}>
            <strong style={{ fontWeight: 600 }}>Customizing your home.</strong> Use ▲ ▼ to reorder
            cards and ⊘ to hide them. Saved to this browser.
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

      {!denied && <KpiStrip tiles={tiles} loading={loading && !data} />}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          gap: 18,
          gridAutoFlow: 'dense',
        }}
      >
        {!denied && (
          <Panel
            title="Written business"
            sub={`${presetLabel(f.range.preset)} · ${f.storeLabel}`}
            style={{ gridColumn: 'span 4', ...card('revenue').style }}
            clip={false}
            actions={
              <>
                <div
                  style={{
                    marginLeft: 'auto',
                    display: 'flex',
                    gap: 14,
                    fontSize: 12,
                    color: 'var(--muted)',
                  }}
                >
                  <span>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: 'var(--accent)',
                        marginRight: 5,
                        verticalAlign: 'middle',
                      }}
                    />
                    Orders
                  </span>
                  <span>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: 'var(--border2)',
                        marginRight: 5,
                        verticalAlign: 'middle',
                      }}
                    />
                    Register
                  </span>
                  {cmpFull && data && data.compareTrend.length > 0 && (
                    <span>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          borderTop: '2px dashed var(--warn)',
                          marginRight: 5,
                          verticalAlign: 'middle',
                        }}
                      />
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

        <div style={{ gridColumn: 'span 2', ...card('brief').style, flexDirection: 'column' }}>
          <MorningBriefCard
            brief={brief}
            loading={briefLoading}
            storeIds={f.storeIds}
            handle={card('brief').handle}
          />
        </div>

        <StoresSection
          locationIds={f.storeIds}
          handle={card('stores').handle}
          style={{ gridColumn: 'span 6', ...card('stores').style }}
        />

        <ChangesCard
          locationIds={f.storeIds}
          handle={card('changes').handle}
          style={{ gridColumn: 'span 6', ...card('changes').style }}
        />
      </div>
    </div>
  );
}
