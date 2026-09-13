'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import {
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  LoadingRows,
  ResetColumns,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { fmtDate, LocationPicker, SectionError, StripTiles, titleCase, useSection } from './kit';
import type { AsIsRow, Strip } from './types';

const AS_IS_COLUMNS: ColumnDef<AsIsRow>[] = [
  {
    id: 'piece',
    label: 'Piece',
    sortValue: (r) => r.pieceNumber,
    render: (r) => (
      <>
        <code>{r.pieceNumber ?? '—'}</code>
        {r.quantity > 1 && <span className="muted"> ×{r.quantity}</span>}
      </>
    ),
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
    sortValue: (r) => r.condition,
    render: (r) => (
      <>
        As-Is
        {r.condition && <span className="muted"> · {titleCase(r.condition)}</span>}
      </>
    ),
  },
  {
    id: 'reason',
    label: 'Reason code',
    sortValue: (r) => r.reasonCode?.code ?? null,
    render: (r) =>
      r.reasonCode ? <span title={r.reasonCode.description}>{r.reasonCode.code}</span> : '—',
  },
  {
    id: 'price',
    label: 'Selling price',
    num: true,
    sortValue: (r) => r.asIsPriceCents,
    render: (r) => (r.asIsPriceCents != null ? <Money cents={r.asIsPriceCents} /> : '—'),
  },
  {
    id: 'sellable',
    label: 'Sellable',
    sortValue: (r) => r.sellable,
    render: (r) => (r.sellable ? 'Yes' : 'No'),
  },
  {
    id: 'storage',
    label: 'Storage location',
    sortValue: (r) => r.storageLocation,
    render: (r) => r.storageLocation ?? '—',
  },
  {
    id: 'source',
    label: 'Source',
    sortValue: (r) => r.source,
    render: (r) => titleCase(r.source),
  },
  {
    id: 'comments',
    label: 'Piece comments',
    className: 'muted',
    sortValue: (r) => r.notes,
    render: (r) => r.notes ?? '—',
  },
];

/** STORIS As-Is tab (A21 D11): pieces in review at a location. */
export function AsIsPanel({ productId }: { productId: string }) {
  const [locationId, setLocationId] = useState('');
  const { data, error, loading } = useSection<{ strip: Strip; rows: AsIsRow[] }>(
    `/v1/products/${productId}/activity/as-is${locationId ? `?locationId=${locationId}` : ''}`,
  );
  const cols = useListColumns('products-activity-as-is', AS_IS_COLUMNS, data?.rows ?? null);
  return (
    <Stack>
      <Toolbar>
        <LocationPicker value={locationId} onChange={setLocationId} testId="as-is-location" />
      </Toolbar>
      <StripTiles strip={data?.strip} />
      <SectionError error={error} />
      <Card
        title="As-Is pieces"
        flush
        description={
          <>
            Pieces of this product in as-is review. Price, sell or dispose of them on the{' '}
            <Link href="/as-is">As-Is queue</Link>.
          </>
        }
        data-testid="activity-as-is"
      >
        {loading && !data ? (
          <LoadingRows rows={3} />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="products-activity-as-is" />
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>
                    No as-is pieces in review for this product.
                  </TableEmpty>
                )}
                {cols.sorted.map((r) => (
                  <tr key={r.id} data-testid="activity-as-is-row">
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
