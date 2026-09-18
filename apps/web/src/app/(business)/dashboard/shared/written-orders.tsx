'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, useRef } from 'react';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
import { Alert, Button, SlideOver } from '@/components/ui';
import { Panel, ShimmerRows } from '../owner/owner-kit';
import { dayAndTime, rangeLabel } from './kit';
import type { StorePeriod } from './types';

interface WrittenOrder {
  id: string;
  number: string;
  status: string;
  createdAt: string;
  totalCents: number;
  balanceDueCents: number;
  locationName: string;
  timezone: string;
  salespersonName: string | null;
  customerName: string;
}
interface WrittenOrdersResponse {
  range: { start: string; end: string };
  rows: WrittenOrder[];
  count: number;
  totalCents: number;
  nextOffset: number | null;
}

export function WrittenOrders({
  locationId,
  salespersonId,
  period = 'today',
}: {
  locationId?: string;
  salespersonId?: string;
  period?: StorePeriod;
}) {
  const [data, setData] = useState<WrittenOrdersResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Every query (filters + refresh) gets a sequence number; a "Load more"
  // page that resolves after the query changed is dropped instead of
  // being appended to the new dataset.
  const querySeq = useRef(0);
  const load = useCallback(
    async (offset: number, signal?: AbortSignal) => {
      const seq = querySeq.current;
      setBusy(true);
      setError(null);
      const q = new URLSearchParams({ period, offset: String(offset) });
      if (locationId) q.set('locationId', locationId);
      if (salespersonId) q.set('salespersonMembershipId', salespersonId);
      try {
        const next = await api<WrittenOrdersResponse>(`/v1/dashboard/written-orders?${q}`, {
          signal,
        });
        if (signal?.aborted || seq !== querySeq.current) return;
        setData((old) => ({
          ...next,
          rows: offset && old ? [...old.rows, ...next.rows] : next.rows,
        }));
      } catch (e) {
        if (!signal?.aborted && seq === querySeq.current)
          setError(e instanceof Error ? e.message : 'Could not load written orders');
      } finally {
        if (!signal?.aborted && seq === querySeq.current) setBusy(false);
      }
    },
    [period, locationId, salespersonId],
  );
  useEffect(() => {
    const c = new AbortController();
    querySeq.current += 1;
    setData(null);
    void load(0, c.signal);
    return () => c.abort();
  }, [load, revision]);
  return (
    <div data-testid="written-orders">
      <div className="written-orders-summary">
        <span>{data ? rangeLabel(data.range) : 'Loading sales…'}</span>
        {data && (
          <strong>
            {formatMoney(data.totalCents)} written · {data.count} sales
          </strong>
        )}
        <Button size="sm" disabled={busy} onClick={() => setRevision((n) => n + 1)}>
          Refresh sales
        </Button>
      </div>
      {error && (
        <Alert
          tone="error"
          action={
            <Button size="sm" onClick={() => setRevision((n) => n + 1)}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {!data && busy && <ShimmerRows rows={3} />}
      {data && data.count === 0 && (
        <p className="sc-empty" style={{ padding: 16 }}>
          No written sales in this period.
        </p>
      )}
      {data && data.rows.length > 0 && (
        <div
          className="written-orders-scroll"
          tabIndex={0}
          role="region"
          aria-label="Written sales orders"
        >
          <table className="store-table written-orders-table">
            <thead>
              <tr>
                <th>Written</th>
                <th>Store</th>
                <th>Salesperson</th>
                <th>Order</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((o) => (
                <tr key={o.id}>
                  <td>{dayAndTime(o.createdAt, o.timezone)}</td>
                  <td>{o.locationName}</td>
                  <td>{o.salespersonName ?? 'Unassigned'}</td>
                  <td>
                    <Link href={`/orders/${o.id}?store=all&written=all`} className="mono">
                      {o.number}
                    </Link>
                  </td>
                  <td>{o.customerName || 'Walk-in'}</td>
                  <td>{o.status.replace(/_/g, ' ')}</td>
                  <td className="num">{formatMoney(o.totalCents)}</td>
                  <td className="num">{formatMoney(o.balanceDueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.nextOffset != null && (
        <div style={{ padding: 12 }}>
          <Button size="sm" disabled={busy} onClick={() => void load(data.nextOffset!)}>
            {busy ? 'Loading…' : `Load more · ${data.rows.length} of ${data.count}`}
          </Button>
        </div>
      )}
    </div>
  );
}

export function TodaySalesCard() {
  return (
    <Panel
      title="Today · all stores"
      sub="Each sale, by salesperson · includes Warehouse"
      testid="today-sales-card"
    >
      <WrittenOrders />
    </Panel>
  );
}

export function SalespersonOrdersDialog({
  locationId,
  locationName,
  salespersonId,
  name,
  period,
  onClose,
}: {
  locationId: string;
  locationName: string;
  salespersonId: string;
  name: string;
  period: StorePeriod;
  onClose: () => void;
}) {
  return (
    <SlideOver
      title={`${name} · written orders`}
      meta={`${locationName} · ${period === 'today' ? 'Today' : 'Month to date'} · Select an order to view or edit it`}
      onClose={onClose}
      className="written-orders-dialog"
      testId="salesperson-orders-dialog"
    >
      <WrittenOrders locationId={locationId} salespersonId={salespersonId} period={period} />
    </SlideOver>
  );
}
