'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Card,
  LoadingRows,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
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
                <tr>
                  <th>Transfer number</th>
                  <th>{inbound ? 'From location' : 'To location'}</th>
                  <th>Transfer date</th>
                  <th className="num">Transfer quantity</th>
                  <th className="num">Reserved quantity</th>
                  <th>Order number</th>
                  <th>Scheduled date</th>
                  <th>Customer name</th>
                  <th>Transfer type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={10}>
                    No open {inbound ? 'inbound' : 'outbound'} transfers for this product.
                  </TableEmpty>
                )}
                {data?.rows.map((r, i) => (
                  <tr key={`${r.transferId}:${i}`} data-testid="activity-transfer-row">
                    <td>
                      <Link href={`/transfers/${r.transferId}`}>{r.number}</Link>
                    </td>
                    <td>{(inbound ? r.fromLocationName : r.toLocationName) ?? '—'}</td>
                    <td>{fmtDate(r.transferDate)}</td>
                    <td className="num">{r.quantity}</td>
                    <td className="num">{r.reservedQuantity}</td>
                    <td>
                      {r.orderId ? <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : '—'}
                    </td>
                    <td>{fmtDate(r.scheduledFor)}</td>
                    <td>{r.customerName ?? '—'}</td>
                    <td>{titleCase(r.transferType)}</td>
                    <td>
                      <StatusBadge status={r.status} />
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
