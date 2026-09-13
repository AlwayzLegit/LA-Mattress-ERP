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
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { fmtDate, LocationPicker, SectionError, StripTiles, titleCase, useSection } from './kit';
import type { OpenOrderRow, Strip } from './types';

const ORDER_TYPES = [
  { key: 'all', label: 'All orders' },
  { key: 'sales_order', label: 'Sales orders' },
  { key: 'layaway', label: 'Layaways' },
  { key: 'exchange', label: 'Exchanges' },
  { key: 'quote', label: 'Quotes (open shopping carts)' },
];

const ORDER_TYPE_LABEL: Record<OpenOrderRow['orderType'], string> = {
  sales_order: 'Sales order',
  layaway: 'Layaway',
  exchange: 'Exchange',
  quote: 'Quote',
};

function fulfillmentStatus(s: string | null): string {
  if (!s) return '—';
  if (s === 'will_call') return 'CWC';
  return titleCase(s);
}

const OPEN_ORDER_COLUMNS: ColumnDef<OpenOrderRow>[] = [
  {
    id: 'orderNumber',
    label: 'Order number',
    sortValue: (r) => r.orderNumber,
    render: (r) => <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>,
  },
  {
    id: 'orderType',
    label: 'Order type',
    sortValue: (r) => ORDER_TYPE_LABEL[r.orderType],
    render: (r) => ORDER_TYPE_LABEL[r.orderType],
  },
  {
    id: 'sellingLocation',
    label: 'Selling location',
    sortValue: (r) => r.sellingLocationName,
    render: (r) => r.sellingLocationName ?? '—',
  },
  {
    id: 'fulfillmentDate',
    label: 'Fulfillment date',
    sortValue: (r) => r.fulfillmentDate,
    render: (r) => fmtDate(r.fulfillmentDate),
  },
  {
    id: 'orderQuantity',
    label: 'Order quantity',
    num: true,
    sortValue: (r) => r.orderQuantity,
    render: (r) => r.orderQuantity,
  },
  {
    id: 'reserved',
    label: 'Reserved',
    num: true,
    sortValue: (r) => r.reservedQuantity,
    render: (r) => r.reservedQuantity,
  },
  {
    id: 'fulfillmentType',
    label: 'Fulfillment type',
    sortValue: (r) => r.fulfillmentType,
    render: (r) => titleCase(r.fulfillmentType),
  },
  {
    id: 'fulfillmentStatus',
    label: 'Fulfillment status',
    sortValue: (r) => r.fulfillmentStatus,
    render: (r) =>
      r.fulfillmentStatus && r.fulfillmentStatus !== 'will_call' ? (
        <StatusBadge status={r.fulfillmentStatus} />
      ) : (
        fulfillmentStatus(r.fulfillmentStatus)
      ),
  },
  {
    id: 'shipFrom',
    label: 'Ship from',
    sortValue: (r) => r.shipFromLocationName,
    render: (r) => r.shipFromLocationName ?? '—',
  },
  {
    id: 'orderDate',
    label: 'Order date',
    sortValue: (r) => r.orderDate,
    render: (r) => fmtDate(r.orderDate),
  },
  {
    id: 'customer',
    label: 'Customer',
    sortValue: (r) => r.customerName,
    render: (r) =>
      r.customerId ? (
        <Link href={`/customers/${r.customerId}`}>{r.customerName ?? '—'}</Link>
      ) : (
        (r.customerName ?? '—')
      ),
  },
  {
    id: 'line',
    label: 'Line',
    className: 'muted',
    sortValue: (r) => r.lineDescription,
    render: (r) => (
      <>
        {r.lineDescription}
        {r.lineType !== 'stock' && <> · {titleCase(r.lineType)}</>}
      </>
    ),
  },
  {
    id: 'linkedTransfer',
    label: 'Linked transfer',
    sortValue: (r) => r.linkedTransferNumber,
    render: (r) =>
      r.linkedTransferId ? (
        <Link href={`/transfers/${r.linkedTransferId}`}>{r.linkedTransferNumber}</Link>
      ) : (
        '—'
      ),
  },
  {
    id: 'linkedTransferQty',
    label: 'Linked transfer qty',
    num: true,
    sortValue: (r) => (r.linkedTransferId ? r.linkedTransferQuantity : null),
    render: (r) => (r.linkedTransferId ? r.linkedTransferQuantity : '—'),
  },
  {
    id: 'linkedPo',
    label: 'Linked PO',
    sortValue: (r) => r.linkedPurchaseOrderNumber,
    render: (r) =>
      r.linkedPurchaseOrderId ? (
        <Link href={`/purchase-orders/${r.linkedPurchaseOrderId}`}>
          {r.linkedPurchaseOrderNumber}
          <span className="muted"> · {r.linkedPurchaseOrderQuantity}</span>
        </Link>
      ) : (
        '—'
      ),
  },
];

/** STORIS Open Orders tab (A21 D6). */
export function OpenOrdersPanel({
  productId,
  initialOrderType = 'all',
}: {
  productId: string;
  /** STORIS Open Shopping Carts opens this panel on quotes (A22). */
  initialOrderType?: string;
}) {
  const [locationId, setLocationId] = useState('');
  const [useFulfillment, setUseFulfillment] = useState(true);
  const [useSelling, setUseSelling] = useState(true);
  const [orderType, setOrderType] = useState(initialOrderType);
  const qs = new URLSearchParams();
  if (locationId) qs.set('locationId', locationId);
  qs.set('useFulfillment', useFulfillment ? '1' : '0');
  qs.set('useSelling', useSelling ? '1' : '0');
  qs.set('orderType', orderType);
  const blocked = Boolean(locationId) && !useFulfillment && !useSelling;
  const { data, error, loading } = useSection<{ strip: Strip; rows: OpenOrderRow[] }>(
    blocked ? null : `/v1/products/${productId}/activity/open-orders?${qs.toString()}`,
  );
  const cols = useListColumns(
    'products-activity-open-orders',
    OPEN_ORDER_COLUMNS,
    data?.rows ?? null,
  );
  return (
    <Stack>
      <Toolbar>
        <LocationPicker value={locationId} onChange={setLocationId} testId="open-orders-location" />
        <label className="flex items-center gap-2">
          <span className="muted whitespace-nowrap">Order type</span>
          <Select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value)}
            aria-label="Order type"
            data-testid="open-orders-type"
          >
            {ORDER_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="muted flex items-center gap-1.5 whitespace-nowrap">
          <input
            type="checkbox"
            checked={useFulfillment}
            onChange={(e) => setUseFulfillment(e.target.checked)}
          />
          Use fulfillment location
        </label>
        <label className="muted flex items-center gap-1.5 whitespace-nowrap">
          <input
            type="checkbox"
            checked={useSelling}
            onChange={(e) => setUseSelling(e.target.checked)}
          />
          Use selling location
        </label>
      </Toolbar>
      <StripTiles strip={data?.strip} />
      <SectionError
        error={blocked ? 'Tick the fulfillment location, the selling location, or both.' : error}
      />
      <Card
        title="Open orders"
        flush
        description="Lines of this product on open orders with units still to fulfill. Quotes show when the order type says so."
        data-testid="activity-open-orders"
      >
        {loading && !data ? (
          <LoadingRows rows={3} />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="products-activity-open-orders" />
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>
                    No open orders for this product.
                  </TableEmpty>
                )}
                {cols.sorted.map((r) => (
                  <tr key={r.lineId} data-testid="activity-open-order-row">
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
