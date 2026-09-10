'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ShimmerRows, usdWhole } from '../owner/owner-kit';
import { periodWord, plural, rangeLabel, readLocal, writeLocal } from './kit';
import { PaymentListDialog } from './payment-list-dialog';
import { StoreCard } from './store-card';
import type { StoreCardData, StorePeriod, StoresResponse } from './types';

/**
 * The "Stores" block (hand-off 2026-09-10): header row with the period
 * toggle and the cash-awaiting-pickup total, one card per store in
 * scope, and the roll-up footer. Owner and Operations render every
 * store; Manager renders their own. Cash pickup ticks are server state
 * shared with Operations — the owner sees who ticked.
 */
const PERIOD_KEY = 'jetnine.dashboard.storePeriod';
const OPEN_KEY = 'jetnine.dashboard.openStores';

export function StoresSection({
  locationIds,
  single = false,
  handle,
  style,
}: {
  /** null = every store the member may see. */
  locationIds: string[] | null;
  /** One store only (manager home): shorter header copy, no store count. */
  single?: boolean;
  /** The owner home's customize handle. */
  handle?: ReactNode;
  style?: React.CSSProperties;
}) {
  const [period, setPeriodState] = useState<StorePeriod>('mtd');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [data, setData] = useState<StoresResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [payModal, setPayModal] = useState<{ store: StoreCardData; method: string } | null>(null);

  useEffect(() => {
    const p = readLocal<string>(PERIOD_KEY, 'mtd');
    setPeriodState(p === 'today' ? 'today' : 'mtd');
    setClosed(readLocal<Record<string, boolean>>(OPEN_KEY, {}));
  }, []);
  const setPeriod = (p: StorePeriod) => {
    setPeriodState(p);
    writeLocal(PERIOD_KEY, p);
  };
  const toggle = (id: string) => {
    const next = { ...closed, [id]: !closed[id] };
    setClosed(next);
    writeLocal(OPEN_KEY, next);
  };

  const scopeKey = locationIds ? locationIds.join(',') : '';
  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setLoading(true);
      setError(false);
      const qs = new URLSearchParams({ period });
      if (scopeKey) qs.set('locationIds', scopeKey);
      return api<StoresResponse>(`/v1/dashboard/stores?${qs.toString()}`)
        .then(setData)
        .catch(() => setError(true))
        .finally(() => setLoading(false));
    },
    [period, scopeKey],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const mark = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const tick = async (store: StoreCardData, paymentId: string, received: boolean) => {
    const row = store.cashPayments.find((p) => p.paymentId === paymentId);
    mark(paymentId, true);
    try {
      if (received) {
        const r = await api<{ receipt: { byName: string } }>(
          `/v1/dashboard/cash-pickups/${paymentId}`,
          { method: 'PUT' },
        );
        toast.success(
          `${usdWhole(row?.amountCents ?? 0)} cash from ${row?.docNumber ?? 'the order'} marked received by ${r.receipt.byName}`,
        );
      } else {
        await api(`/v1/dashboard/cash-pickups/${paymentId}`, { method: 'DELETE' });
        toast(`${row?.docNumber ?? 'Order'} cash pickup cleared`);
      }
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      mark(paymentId, false);
    }
  };

  const bulk = async (store: StoreCardData, received: boolean) => {
    const ids = store.cashPayments
      .filter((p) => (received ? !p.receipt : !!p.receipt))
      .map((p) => p.paymentId);
    if (ids.length === 0) return;
    ids.forEach((id) => mark(id, true));
    try {
      await api('/v1/dashboard/cash-pickups/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIds: ids, received }),
      });
      toast.success(
        received
          ? `${plural(ids.length, 'cash payment')} at ${store.name} marked received`
          : `${plural(ids.length, 'tick')} cleared at ${store.name}`,
      );
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      ids.forEach((id) => mark(id, false));
    }
  };

  const stores = data?.stores ?? [];
  const totals = data?.totals;
  const storeWord = useMemo(
    () =>
      single || !totals
        ? '1 store'
        : `${totals.storeCount === 1 ? '1 store' : `All ${totals.storeCount} stores`}`,
    [single, totals],
  );
  const outstanding = (totals?.cashPendingCents ?? 0) > 0;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, ...style }}
      data-testid="stores-section"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {single ? 'My store' : 'Stores'}
        </h2>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {data ? `${rangeLabel(data.range)} · ${periodWord(period)}` : '…'} · salespeople, money
          received and cash pickup
        </span>
        <div className="seg" data-noprint="true">
          <button
            type="button"
            className={`seg-btn${period === 'mtd' ? ' is-active' : ''}`}
            onClick={() => setPeriod('mtd')}
            data-testid="store-period-mtd"
          >
            Month to date
          </button>
          <button
            type="button"
            className={`seg-btn${period === 'today' ? ' is-active' : ''}`}
            onClick={() => setPeriod('today')}
            data-testid="store-period-today"
          >
            Today
          </button>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 10px',
            border: `1px solid ${outstanding ? 'var(--warn)' : 'var(--border)'}`,
            borderRadius: 7,
            background: 'var(--surface)',
            fontSize: 12,
          }}
          data-testid="cash-awaiting-total"
        >
          <span style={{ color: 'var(--muted)' }}>Cash awaiting pickup</span>
          <span
            className="mono"
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: outstanding ? 'var(--warn)' : 'var(--accent-ink)',
            }}
          >
            {totals ? usdWhole(totals.cashPendingCents) : '—'}
          </span>
          {!single && totals && (
            <span style={{ color: 'var(--muted)' }}>
              across {plural(totals.storeCount, 'store')}
            </span>
          )}
        </div>
        {handle}
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
          <span style={{ flex: 1 }}>The store cards could not be loaded.</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {loading && !data && (
        <section className="panel">
          <ShimmerRows rows={4} />
        </section>
      )}

      {data && stores.length === 0 && !error && (
        <section className="panel">
          <div
            style={{
              padding: '28px var(--pad)',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 12.5,
            }}
          >
            No selling stores in scope.
          </div>
        </section>
      )}

      {stores.map((s) => (
        <StoreCard
          key={s.locationId}
          card={s}
          period={period}
          open={!closed[s.locationId]}
          onToggle={() => toggle(s.locationId)}
          canTick={data?.viewer.canConfirmCashPickup ?? false}
          busy={busy}
          onTick={(paymentId, received) => void tick(s, paymentId, received)}
          onBulk={(received) => void bulk(s, received)}
          onOpenPayments={(method) => setPayModal({ store: s, method })}
        />
      ))}

      {totals && stores.length > 0 && (
        <div className="stores-foot" data-testid="stores-footer">
          <span style={{ fontWeight: 600 }}>{storeWord}</span>
          <span style={{ flex: 1 }} />
          <FootCell cap="Written" val={usdWhole(totals.writtenCents)} />
          <FootCell cap="Delivered" val={usdWhole(totals.deliveredCents)} />
          <FootCell cap="Orders" val={String(totals.writtenCount)} />
          <FootCell cap="Received" val={usdWhole(totals.receivedCents)} />
          <FootCell
            cap="Cash out"
            val={usdWhole(totals.cashPendingCents)}
            color={outstanding ? 'var(--warn)' : undefined}
          />
        </div>
      )}

      {payModal && (
        <PaymentListDialog
          locationId={payModal.store.locationId}
          locationName={payModal.store.name}
          timezone={payModal.store.timezone}
          method={payModal.method}
          period={period}
          onClose={() => setPayModal(null)}
        />
      )}
    </div>
  );
}

function FootCell({ cap, val, color }: { cap: string; val: string; color?: string }) {
  return (
    <div className="stores-foot-cell">
      <div className="cap">{cap}</div>
      <div className="val" style={{ color }}>
        {val}
      </div>
    </div>
  );
}
