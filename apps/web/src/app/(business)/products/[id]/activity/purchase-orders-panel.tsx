'use client';

import Link from 'next/link';
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
  useListColumns,
} from '@/components/ui';
import { fmtDate, SectionError, StripTiles, useSection } from './kit';
import type { PurchaseOrderRow, Strip } from './types';

const PO_TYPE_LABEL: Record<PurchaseOrderRow['purchaseOrderType'], string> = {
  standard: 'Standard',
  special_order: 'Special order',
  direct_ship: 'Direct ship',
};

const PO_COLUMNS: ColumnDef<PurchaseOrderRow>[] = [
  {
    id: 'number',
    label: 'PO number',
    sortValue: (r) => r.number,
    render: (r) => <Link href={`/purchase-orders/${r.purchaseOrderId}`}>{r.number}</Link>,
  },
  {
    id: 'vendor',
    label: 'Vendor',
    sortValue: (r) => r.vendorName,
    render: (r) => r.vendorName ?? '—',
  },
  {
    id: 'receivingLocation',
    label: 'Receiving location',
    sortValue: (r) => r.receivingLocationName,
    render: (r) => r.receivingLocationName ?? '—',
  },
  {
    id: 'sku',
    label: 'SKU',
    sortValue: (r) => r.sku,
    render: (r) => <code>{r.sku ?? '—'}</code>,
  },
  {
    id: 'quantityDue',
    label: 'Quantity due',
    num: true,
    sortValue: (r) => r.quantityDue,
    render: (r) => (
      <>
        {r.quantityDue}
        <span className="muted"> / {r.quantityOrdered}</span>
      </>
    ),
  },
  {
    id: 'placed',
    label: 'Acknowledged (placed)',
    sortValue: (r) => r.placedAt,
    render: (r) => fmtDate(r.placedAt),
  },
  {
    id: 'delivery',
    label: 'Delivery date',
    sortValue: (r) => r.expectedAt,
    render: (r) => fmtDate(r.expectedAt),
  },
  {
    id: 'created',
    label: 'Created',
    sortValue: (r) => r.createdAt,
    render: (r) => fmtDate(r.createdAt),
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (r) => r.status,
    render: (r) => <StatusBadge status={r.status} />,
  },
  {
    id: 'transactionType',
    label: 'Transaction type',
    sortValue: (r) => r.transactionType,
    render: (r) => (r.transactionType === 'direct_ship' ? 'Direct ship' : 'Merchandise'),
  },
  {
    id: 'poType',
    label: 'PO type',
    sortValue: (r) => PO_TYPE_LABEL[r.purchaseOrderType],
    render: (r) => PO_TYPE_LABEL[r.purchaseOrderType],
  },
  {
    id: 'atDock',
    label: 'At dock',
    title: 'Units received at the dock and not yet accepted',
    sortValue: (r) => (r.atDock ? r.quantityAtDock : 0),
    render: (r) => (r.atDock ? `Yes · ${r.quantityAtDock}` : 'No'),
  },
];

/** STORIS Purchase Orders tab (A21 D7). */
export function PurchaseOrdersPanel({ productId }: { productId: string }) {
  const { data, error, loading } = useSection<{ strip: Strip; rows: PurchaseOrderRow[] }>(
    `/v1/products/${productId}/activity/purchase-orders`,
  );
  const cols = useListColumns('products-activity-purchase-orders', PO_COLUMNS, data?.rows ?? null);
  return (
    <Stack>
      <StripTiles strip={data?.strip} />
      <SectionError error={error} />
      <Card
        title="Purchase orders"
        flush
        description="Draft and placed purchase orders that still owe units of this product, direct ship included."
        data-testid="activity-purchase-orders"
      >
        {loading && !data ? (
          <LoadingRows rows={3} />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="products-activity-purchase-orders" />
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>
                    No open purchase orders for this product.
                  </TableEmpty>
                )}
                {cols.sorted.map((r, i) => (
                  <tr key={`${r.purchaseOrderId}:${i}`} data-testid="activity-po-row">
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
