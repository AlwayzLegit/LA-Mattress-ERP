'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { ShimmerRows, usdWhole } from '../owner/owner-kit';
import { CashPickupsQueue, useCashPickups } from './cash-pickups';
import { periodWord, plural, rangeLabel, readLocal, writeLocal } from './kit';
import { PaymentListDialog } from './payment-list-dialog';
import { StoreCard } from './store-card';
import type { StoreCardData, StorePeriod, StoresResponse } from './types';

/**
 * The "Stores" block (redesign Phase 9): the cross-store cash pickups
 * queue (owner and Operations), the section header with the period
 * toggle, one card per store in scope, and the roll-up footer. Owner
 * and Operations render every store; the Manager renders their own as
 * "My store". Cash on hand is server state shared with everyone who can
 * see the store — a posted pickup names who carried the money out.
 */
const PERIOD_KEY = 'jetnine.dashboard.storePeriod';
const OPEN_KEY = 'jetnine.dashboard.openStores';

export function StoresSection({
  locationIds,
  single = false,
  showQueue = false,
  actorName,
  handle,
  queueHandle,
  style,
  queueStyle,
}: {
  /** null = every store the member may see. */
  locationIds: string[] | null;
  /** One store only (manager home): "My store", no store count. */
  single?: boolean;
  /** Render the cross-store cash pickups queue above the stores. */
  showQueue?: boolean;
  /** Who a posted pickup will be stamped with, for the form's "by …" line. */
  actorName?: string | null;
  /** The owner home's customize handles. */
  handle?: ReactNode;
  queueHandle?: ReactNode;
  style?: React.CSSProperties;
  queueStyle?: React.CSSProperties;
}) {
  const [period, setPeriodState] = useState<StorePeriod>('mtd');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [data, setData] = useState<StoresResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [payModal, setPayModal] = useState<{ store: StoreCardData; method: string } | null>(null);
  const cp = useCashPickups(locationIds);

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

  /** From the queue: open the card, start recording, scroll to it. */
  const recordFor = (locationId: string) => {
    if (closed[locationId]) toggle(locationId);
    cp.startRecord(locationId);
    window.setTimeout(() => {
      document
        .getElementById(`store-${locationId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
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
  const cashPending = cp.queue?.totals.pendingCents ?? 0;

  return (
    <>
      {showQueue && (
        <CashPickupsQueue cp={cp} onRecord={recordFor} handle={queueHandle} style={queueStyle} />
      )}
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, ...style }}
        data-testid="stores-section"
      >
        <div className="stores-head">
          <h2>{single ? 'My store' : 'Stores'}</h2>
          <span className="stores-head-sub">
            {data ? `${rangeLabel(data.range)} · ${periodWord(period)}` : '…'} · salespeople, money
            received and cash on hand
          </span>
          <div className="seg" data-noprint="true">
            <button
              type="button"
              className={`seg-btn${period === 'today' ? ' is-active' : ''}`}
              onClick={() => setPeriod('today')}
              data-testid="store-period-today"
            >
              Today
            </button>
            <button
              type="button"
              className={`seg-btn${period === 'mtd' ? ' is-active' : ''}`}
              onClick={() => setPeriod('mtd')}
              data-testid="store-period-mtd"
            >
              Month to date
            </button>
          </div>
          {handle}
        </div>

        {error && (
          <Alert
            tone="error"
            action={
              <Button size="sm" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            The store cards could not be loaded.
          </Alert>
        )}

        {loading && !data && (
          <section className="panel">
            <ShimmerRows rows={4} />
          </section>
        )}

        {data && stores.length === 0 && !error && (
          <section className="panel">
            <div className="sc-empty" style={{ padding: '28px var(--pad)', textAlign: 'center' }}>
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
            onOpenPayments={(method) => setPayModal({ store: s, method })}
            cp={cp}
            actorName={actorName}
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
              cap="Cash on hand"
              val={usdWhole(cashPending)}
              color={
                (cp.queue?.totals.dueCount ?? 0) > 0
                  ? 'var(--status-risk-fg)'
                  : cashPending > 0
                    ? 'var(--status-waiting-fg)'
                    : undefined
              }
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
    </>
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
