'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Card,
  LoadingRows,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
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

/** STORIS Open Orders tab (A21 D6). */
export function OpenOrdersPanel({ productId }: { productId: string }) {
  const [locationId, setLocationId] = useState('');
  const [useFulfillment, setUseFulfillment] = useState(true);
  const [useSelling, setUseSelling] = useState(true);
  const [orderType, setOrderType] = useState('all');
  const qs = new URLSearchParams();
  if (locationId) qs.set('locationId', locationId);
  qs.set('useFulfillment', useFulfillment ? '1' : '0');
  qs.set('useSelling', useSelling ? '1' : '0');
  qs.set('orderType', orderType);
  const blocked = Boolean(locationId) && !useFulfillment && !useSelling;
  const { data, error, loading } = useSection<{ strip: Strip; rows: OpenOrderRow[] }>(
    blocked ? null : `/v1/products/${productId}/activity/open-orders?${qs.toString()}`,
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
                <tr>
                  <th>Order number</th>
                  <th>Order type</th>
                  <th>Selling location</th>
                  <th>Fulfillment date</th>
                  <th className="num">Order quantity</th>
                  <th className="num">Reserved</th>
                  <th>Fulfillment type</th>
                  <th>Fulfillment status</th>
                  <th>Ship from</th>
                  <th>Order date</th>
                  <th>Customer</th>
                  <th>Line</th>
                </tr>
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={12}>No open orders for this product.</TableEmpty>
                )}
                {data?.rows.map((r) => (
                  <tr key={r.lineId} data-testid="activity-open-order-row">
                    <td>
                      <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>
                    </td>
                    <td>{ORDER_TYPE_LABEL[r.orderType]}</td>
                    <td>{r.sellingLocationName ?? '—'}</td>
                    <td>{fmtDate(r.fulfillmentDate)}</td>
                    <td className="num">{r.orderQuantity}</td>
                    <td className="num">{r.reservedQuantity}</td>
                    <td>{titleCase(r.fulfillmentType)}</td>
                    <td>
                      {r.fulfillmentStatus && r.fulfillmentStatus !== 'will_call' ? (
                        <StatusBadge status={r.fulfillmentStatus} />
                      ) : (
                        fulfillmentStatus(r.fulfillmentStatus)
                      )}
                    </td>
                    <td>{r.shipFromLocationName ?? '—'}</td>
                    <td>{fmtDate(r.orderDate)}</td>
                    <td>
                      {r.customerId ? (
                        <Link href={`/customers/${r.customerId}`}>{r.customerName ?? '—'}</Link>
                      ) : (
                        (r.customerName ?? '—')
                      )}
                    </td>
                    <td className="muted">
                      {r.lineDescription}
                      {r.lineType !== 'stock' && <> · {titleCase(r.lineType)}</>}
                    </td>
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
