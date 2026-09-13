'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  LoadingRows,
  ResetColumns,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { fmtDate, LocationPicker, SectionError, StripTiles, titleCase, useSection } from './kit';
import type { SerialRow, Strip } from './types';

const STATUS_LABEL: Record<string, string> = {
  in_stock: 'Unassigned',
  committed: 'Assigned',
  in_transit: 'In transit',
  floor_sample: 'Floor sample',
  returned: 'Returned',
  in_service: 'In service',
};

const SERIAL_COLUMNS: ColumnDef<SerialRow>[] = [
  {
    id: 'serial',
    label: 'Serial / reference',
    sortValue: (r) => r.serial,
    render: (r) => <code>{r.serial}</code>,
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
  {
    id: 'received',
    label: 'Received date',
    sortValue: (r) => r.receivedAt,
    render: (r) => fmtDate(r.receivedAt),
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (r) => STATUS_LABEL[r.status] ?? titleCase(r.status),
    render: (r) => STATUS_LABEL[r.status] ?? titleCase(r.status),
  },
  {
    id: 'storage',
    label: 'Storage location',
    sortValue: (r) => r.storageBinCode,
    render: (r) => r.storageBinCode ?? '—',
  },
  {
    id: 'order',
    label: 'Order number',
    sortValue: (r) => r.orderNumber,
    render: (r) => (r.orderId ? <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : '—'),
  },
  {
    id: 'customer',
    label: 'Customer',
    sortValue: (r) => r.customerName,
    render: (r) => r.customerName ?? '—',
  },
  {
    id: 'specialOrder',
    label: 'Special-order detail',
    sortValue: (r) => r.specialOrder,
    render: (r) => r.specialOrder ?? '—',
  },
];

/** STORIS Serial/Reference tab (A21 D10). */
export function SerialsPanel({
  productId,
  onEnableTracking,
}: {
  productId: string;
  onEnableTracking?: () => void;
}) {
  const [locationId, setLocationId] = useState('');
  const { data, error, loading } = useSection<{
    strip: Strip;
    serialTracked: boolean;
    rows: SerialRow[];
  }>(`/v1/products/${productId}/activity/serials${locationId ? `?locationId=${locationId}` : ''}`);
  const cols = useListColumns('products-activity-serials', SERIAL_COLUMNS, data?.rows ?? null);
  return (
    <Stack>
      <Toolbar>
        <LocationPicker value={locationId} onChange={setLocationId} testId="serials-location" />
      </Toolbar>
      <StripTiles strip={data?.strip} />
      <SectionError error={error} />
      <Card
        title="Serial / reference"
        flush
        description="Every numbered piece of this product on hand or committed, with where it sits and which order holds it."
        data-testid="activity-serials"
      >
        {loading && !data ? (
          <LoadingRows rows={3} />
        ) : data && !data.serialTracked && data.rows.length === 0 ? (
          <EmptyState
            title="Pieces of this product are not numbered"
            action={
              onEnableTracking ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={onEnableTracking}
                >
                  Turn on serial tracking
                </button>
              ) : undefined
            }
          >
            Serial tracking is opt-in per product; once it is on, receiving registers a serial or
            reference per piece and this tab lists them.
          </EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="products-activity-serials" />
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>
                    No pieces on hand at this location.
                  </TableEmpty>
                )}
                {cols.sorted.map((r) => (
                  <tr key={r.id} data-testid="activity-serial-row">
                    <ColumnCells list={cols} row={r} />
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
