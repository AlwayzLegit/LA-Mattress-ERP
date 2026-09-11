'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Button,
  Card,
  Input,
  LoadingRows,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
} from '@/components/ui';
import { fmtDate, LocationPicker, SectionError, useSection } from './kit';
import type { Ledger } from './types';

function monthStartYmd(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * STORIS Regular Inventory Detail / As-Is Inventory Detail (A22): the
 * movement ledger for this product at a location between two dates, with
 * a running balance and the ending balance (quantity on hand now).
 */
export function InventoryDetailPanel({
  productId,
  kind,
}: {
  productId: string;
  kind: 'regular' | 'as_is';
}) {
  const [locationId, setLocationId] = useState('');
  const [start, setStart] = useState(monthStartYmd);
  const [end, setEnd] = useState(todayYmd);
  const [applied, setApplied] = useState({ start: monthStartYmd(), end: todayYmd() });
  const qs = new URLSearchParams({ kind, start: applied.start, end: applied.end });
  if (locationId) qs.set('locationId', locationId);
  const { data, error, loading } = useSection<Ledger>(
    `/v1/products/${productId}/activity/ledger?${qs.toString()}`,
  );
  const asIs = kind === 'as_is';
  return (
    <Stack>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ start, end });
        }}
      >
        <Toolbar>
          <LocationPicker
            value={locationId}
            onChange={setLocationId}
            testId={`ledger-${kind}-location`}
          />
          <label className="flex items-center gap-2">
            <span className="muted whitespace-nowrap">Start date</span>
            <Input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              aria-label="Start date"
              data-testid={`ledger-${kind}-start`}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="muted whitespace-nowrap">End date</span>
            <Input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              aria-label="End date"
              data-testid={`ledger-${kind}-end`}
            />
          </label>
          <Button type="submit" variant="secondary" size="sm">
            Apply
          </Button>
        </Toolbar>
      </form>
      <SectionError error={error} />
      <Card
        title={asIs ? 'As-Is inventory detail' : 'Regular inventory detail'}
        flush
        description={
          asIs
            ? 'Every as-is piece entered and reviewed out in the range, with the running as-is balance.'
            : 'Every stock movement in the range with the running balance; reservations do not move stock and are not listed.'
        }
        data-testid={`activity-ledger-${kind}`}
      >
        {loading && !data ? (
          <LoadingRows rows={4} />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Quantity</th>
                  <th className="num">Balance</th>
                  <th>Reference</th>
                  <th>Memo</th>
                  <th>Comments</th>
                  <th>SKU</th>
                  <th>Location</th>
                  <th>User</th>
                  <th>Order</th>
                </tr>
              </thead>
              <tbody>
                {data && (
                  <tr className="muted" data-testid="ledger-opening">
                    <td>{fmtDate(data.start)}</td>
                    <td className="num" />
                    <td className="num">{data.openingBalance}</td>
                    <td colSpan={7}>Opening balance</td>
                  </tr>
                )}
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={10}>No movements in this range.</TableEmpty>
                )}
                {data?.rows.map((r) => (
                  <tr key={r.id} data-testid="ledger-row">
                    <td>{fmtDate(r.date)}</td>
                    <td className="num">{r.quantity > 0 ? `+${r.quantity}` : r.quantity}</td>
                    <td className="num">{r.balance}</td>
                    <td>
                      {r.referenceNumber ??
                        (r.referenceType ? r.referenceType.replace(/_/g, ' ') : '—')}
                    </td>
                    <td>{r.memo}</td>
                    <td className="muted">{r.comments ?? '—'}</td>
                    <td>
                      <code>{r.sku ?? '—'}</code>
                    </td>
                    <td>{r.locationName ?? '—'}</td>
                    <td>{r.user ?? '—'}</td>
                    <td>
                      {r.orderId ? <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : '—'}
                    </td>
                  </tr>
                ))}
                {data && (
                  <tr data-testid="ledger-ending">
                    <td>{fmtDate(data.end)}</td>
                    <td className="num muted">{asIs ? 'As-Is' : 'QOH'}</td>
                    <td className="num">
                      <strong>{data.endingBalance}</strong>
                    </td>
                    <td colSpan={7}>
                      Ending balance
                      {data.endingBalance !== data.onHandNow && (
                        <span className="muted"> · on hand now {data.onHandNow}</span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </Stack>
  );
}
