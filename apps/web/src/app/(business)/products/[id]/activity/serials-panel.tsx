'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Card,
  EmptyState,
  LoadingRows,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
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
                <tr>
                  <th>Serial / reference</th>
                  <th>SKU</th>
                  <th>Location</th>
                  <th>Received date</th>
                  <th>Status</th>
                  <th>Storage location</th>
                  <th>Order number</th>
                  <th>Customer</th>
                  <th>Special-order detail</th>
                </tr>
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={9}>No pieces on hand at this location.</TableEmpty>
                )}
                {data?.rows.map((r) => (
                  <tr key={r.id} data-testid="activity-serial-row">
                    <td>
                      <code>{r.serial}</code>
                    </td>
                    <td>
                      <code>{r.sku ?? '—'}</code>
                    </td>
                    <td>{r.locationName ?? '—'}</td>
                    <td>{fmtDate(r.receivedAt)}</td>
                    <td>{STATUS_LABEL[r.status] ?? titleCase(r.status)}</td>
                    <td>{r.storageBinCode ?? '—'}</td>
                    <td>
                      {r.orderId ? <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : '—'}
                    </td>
                    <td>{r.customerName ?? '—'}</td>
                    <td>{r.specialOrder ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </Stack>
  );
}
