'use client';

import Link from 'next/link';
import { Card, LoadingRows, Stack, StatusBadge, TableEmpty, TableWrap } from '@/components/ui';
import { fmtDate, SectionError, StripTiles, useSection } from './kit';
import type { PurchaseOrderRow, Strip } from './types';

/** STORIS Purchase Orders tab (A21 D7). */
export function PurchaseOrdersPanel({ productId }: { productId: string }) {
  const { data, error, loading } = useSection<{ strip: Strip; rows: PurchaseOrderRow[] }>(
    `/v1/products/${productId}/activity/purchase-orders`,
  );
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
                <tr>
                  <th>PO number</th>
                  <th>Vendor</th>
                  <th>Receiving location</th>
                  <th>SKU</th>
                  <th className="num">Quantity due</th>
                  <th>Acknowledged (placed)</th>
                  <th>Delivery date</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={10}>No open purchase orders for this product.</TableEmpty>
                )}
                {data?.rows.map((r, i) => (
                  <tr key={`${r.purchaseOrderId}:${i}`} data-testid="activity-po-row">
                    <td>
                      <Link href={`/purchase-orders/${r.purchaseOrderId}`}>{r.number}</Link>
                    </td>
                    <td>{r.vendorName ?? '—'}</td>
                    <td>{r.receivingLocationName ?? '—'}</td>
                    <td>
                      <code>{r.sku ?? '—'}</code>
                    </td>
                    <td className="num">
                      {r.quantityDue}
                      <span className="muted"> / {r.quantityOrdered}</span>
                    </td>
                    <td>{fmtDate(r.placedAt)}</td>
                    <td>{fmtDate(r.expectedAt)}</td>
                    <td>{fmtDate(r.createdAt)}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>{r.transactionType === 'direct_ship' ? 'Direct ship' : 'Merchandise'}</td>
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
