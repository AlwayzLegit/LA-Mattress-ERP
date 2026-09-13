'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  LoadingRows,
  ResetColumns,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { fmtDate, LocationPicker, SectionError, StripTiles, titleCase, useSection } from './kit';
import type { Strip, TransferRow } from './types';

/** STORIS Inbound / Outbound Transfers tabs (A21 D8). */
export function TransfersPanel({
  productId,
  direction,
}: {
  productId: string;
  direction: 'in' | 'out';
}) {
  const [locationId, setLocationId] = useState('');
  const qs = new URLSearchParams({ direction });
  if (locationId) qs.set('locationId', locationId);
  const { data, error, loading } = useSection<{
    strip: Strip;
    quantity: number;
    rows: TransferRow[];
  }>(`/v1/products/${productId}/activity/transfers?${qs.toString()}`);
  const inbound = direction === 'in';
  // The other-end location column depends on the direction, so the
  // columns live in the component.
  const TRANSFER_COLUMNS: ColumnDef<TransferRow>[] = [
    {
      id: 'number',
      label: 'Transfer number',
      sortValue: (r) => r.number,
      render: (r) => <Link href={`/transfers/${r.transferId}`}>{r.number}</Link>,
    },
    {
      id: 'otherLocation',
      label: inbound ? 'From location' : 'To location',
      sortValue: (r) => (inbound ? r.fromLocationName : r.toLocationName),
      render: (r) => (inbound ? r.fromLocationName : r.toLocationName) ?? '—',
    },
    {
      id: 'transferDate',
      label: 'Transfer date',
      sortValue: (r) => r.transferDate,
      render: (r) => fmtDate(r.transferDate),
    },
    {
      id: 'quantity',
      label: 'Transfer quantity',
      num: true,
      sortValue: (r) => r.quantity,
      render: (r) => r.quantity,
    },
    {
      id: 'reserved',
      label: 'Reserved quantity',
      num: true,
      sortValue: (r) => r.reservedQuantity,
      render: (r) => r.reservedQuantity,
    },
    {
      id: 'order',
      label: 'Order number',
      sortValue: (r) => r.orderNumber,
      render: (r) => (r.orderId ? <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : '—'),
    },
    {
      id: 'scheduled',
      label: 'Scheduled date',
      sortValue: (r) => r.scheduledFor,
      render: (r) => fmtDate(r.scheduledFor),
    },
    {
      id: 'customer',
      label: 'Customer name',
      sortValue: (r) => r.customerName,
      render: (r) => r.customerName ?? '—',
    },
    {
      id: 'type',
      label: 'Transfer type',
      sortValue: (r) => r.transferType,
      render: (r) => titleCase(r.transferType),
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (r) => r.status,
      render: (r) => <StatusBadge status={r.status} />,
    },
  ];
  const cols = useListColumns(
    `products-activity-transfers-${direction}`,
    TRANSFER_COLUMNS,
    data?.rows ?? null,
  );
  return (
    <Stack>
      <Toolbar>
        <LocationPicker
          value={locationId}
          onChange={setLocationId}
          label={inbound ? 'To location' : 'From location'}
          testId={`transfers-${direction}-location`}
        />
      </Toolbar>
      <StripTiles
        strip={data?.strip}
        extra={[
          {
            label: inbound ? 'Inbound quantity' : 'Outbound quantity',
            value: data?.quantity ?? '—',
          },
        ]}
      />
      <SectionError error={error} />
      <Card
        title={inbound ? 'Inbound transfers' : 'Outbound transfers'}
        flush
        description={`Open transfers (draft or in transit) ${inbound ? 'headed to' : 'leaving'} the picked location, or all of them.`}
        data-testid={`activity-transfers-${direction}`}
      >
        {loading && !data ? (
          <LoadingRows rows={3} />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow
                  list={cols}
                  testIdPrefix={`products-activity-transfers-${direction}`}
                />
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>
                    No open {inbound ? 'inbound' : 'outbound'} transfers for this product.
                  </TableEmpty>
                )}
                {cols.sorted.map((r, i) => (
                  <tr key={`${r.transferId}:${i}`} data-testid="activity-transfer-row">
                    <ColumnCells list={cols} row={r} index={i} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        )}
      </Card>
    </Stack>
  );
}
