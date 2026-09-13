'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  cx,
  Input,
  type ListColumns,
  LoadingRows,
  ResetColumns,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { fmtDate, LocationPicker, SectionError, useSection } from './kit';
import type { Ledger, LedgerRow } from './types';

function monthStartYmd(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

const LEDGER_COLUMNS: ColumnDef<LedgerRow>[] = [
  { id: 'date', label: 'Date', sortValue: (r) => r.date, render: (r) => fmtDate(r.date) },
  {
    id: 'quantity',
    label: 'Quantity',
    num: true,
    sortValue: (r) => r.quantity,
    render: (r) => (r.quantity > 0 ? `+${r.quantity}` : r.quantity),
  },
  {
    id: 'balance',
    label: 'Balance',
    num: true,
    sortValue: (r) => r.balance,
    render: (r) => r.balance,
  },
  {
    id: 'reference',
    label: 'Reference',
    sortValue: (r) => r.referenceNumber ?? r.referenceType,
    render: (r) =>
      r.referenceNumber ?? (r.referenceType ? r.referenceType.replace(/_/g, ' ') : '—'),
  },
  { id: 'memo', label: 'Memo', sortValue: (r) => r.memo, render: (r) => r.memo },
  {
    id: 'comments',
    label: 'Comments',
    className: 'muted',
    sortValue: (r) => r.comments,
    render: (r) => r.comments ?? '—',
  },
  {
    id: 'sku',
    label: 'SKU',
    sortValue: (r) => r.sku,
    render: (r) => <code>{r.sku ?? '—'}</code>,
  },
  {
    id: 'location',
    label: 'Location',
    sortValue: (r) => r.locationName,
    render: (r) => r.locationName ?? '—',
  },
  { id: 'user', label: 'User', sortValue: (r) => r.user, render: (r) => r.user ?? '—' },
  {
    id: 'order',
    label: 'Order',
    sortValue: (r) => r.orderNumber,
    render: (r) => (r.orderId ? <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : '—'),
  },
];

/**
 * The opening / ending balance rows: date under Date, the balance under
 * Balance, the label under Memo, wherever those columns sit.
 */
function BoundaryRow({
  list,
  date,
  quantity,
  balance,
  label,
  className,
  testId,
}: {
  list: ListColumns<LedgerRow>;
  date: string;
  quantity?: ReactNode;
  balance: ReactNode;
  label: ReactNode;
  className?: string;
  testId: string;
}) {
  return (
    <tr className={className} data-testid={testId}>
      {list.ordered.map((c) => (
        <td key={c.id} className={cx(c.num && 'num', c.id === 'quantity' && 'muted')}>
          {c.id === 'date'
            ? fmtDate(date)
            : c.id === 'quantity'
              ? quantity
              : c.id === 'balance'
                ? balance
                : c.id === 'memo'
                  ? label
                  : null}
        </td>
      ))}
    </tr>
  );
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
  const cols = useListColumns(
    `products-activity-ledger-${kind}`,
    LEDGER_COLUMNS,
    data?.rows ?? null,
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
                <ColumnHeadRow list={cols} testIdPrefix={`products-activity-ledger-${kind}`} />
              </thead>
              <tbody>
                {data && (
                  <BoundaryRow
                    list={cols}
                    date={data.start}
                    balance={data.openingBalance}
                    label="Opening balance"
                    className="muted"
                    testId="ledger-opening"
                  />
                )}
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>No movements in this range.</TableEmpty>
                )}
                {cols.sorted.map((r) => (
                  <tr key={r.id} data-testid="ledger-row">
                    <ColumnCells list={cols} row={r} />
                  </tr>
                ))}
                {data && (
                  <BoundaryRow
                    list={cols}
                    date={data.end}
                    quantity={asIs ? 'As-Is' : 'QOH'}
                    balance={<strong>{data.endingBalance}</strong>}
                    label={
                      <>
                        Ending balance
                        {data.endingBalance !== data.onHandNow && (
                          <span className="muted"> · on hand now {data.onHandNow}</span>
                        )}
                      </>
                    }
                    testId="ledger-ending"
                  />
                )}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        )}
      </Card>
    </Stack>
  );
}
