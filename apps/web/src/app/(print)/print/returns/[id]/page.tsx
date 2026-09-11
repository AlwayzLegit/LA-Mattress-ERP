'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { PrintToolbar } from '../../print-toolbar';

/**
 * Return Ticket (A22 slice 6, STORIS Enter a Return → print): the RMA,
 * the customer and the original invoice, the store and salesperson who
 * took the return, the lines with their reasons, the fees withheld, the
 * refund method, and the pickup stop when the truck collects the goods.
 * Printing records the count on the return.
 */

interface ReturnDetail {
  id: string;
  rmaNumber: string;
  status: string;
  fulfillment: string;
  refundMethod: string;
  amountCents: number;
  reason: string | null;
  restockingFeeCents: number;
  pickupFeeCents: number;
  pickupDate: string | null;
  ticketPrintCount: number;
  authorizedAt: string;
  orderId: string | null;
  orderNumber: string | null;
  orderDate: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  locationName: string | null;
  salespersonName: string | null;
  businessName: string | null;
  linesTotalCents: number;
  pickup: {
    scheduledDate: string;
    windowStart: string | null;
    windowEnd: string | null;
    status: string;
    contactStatus: string | null;
  } | null;
  lines: {
    id: string;
    description: string | null;
    quantity: number;
    perUnitCents: number;
    reasonCode: string | null;
    reason: string | null;
  }[];
}

const box: React.CSSProperties = { border: '1px solid #000', padding: '6px 10px' };
const label: React.CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#333',
};
const cell: React.CSSProperties = {
  border: '1px solid #000',
  padding: '4px 8px',
  fontSize: 12,
  verticalAlign: 'top',
};
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString() : '—');

export default function ReturnTicketPrintPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [r, setR] = useState<ReturnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<ReturnDetail>(`/v1/order-returns/${id}`)
      .then(setR)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <PrintToolbar
        backHref={r?.orderId ? `/orders/${r.orderId}` : '/returns'}
        onPrint={() => {
          api(`/v1/order-returns/${id}/ticket-print`, { method: 'POST' })
            .then(() => window.print())
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
        label="Print return ticket"
        note={r && r.ticketPrintCount > 0 ? `Printed ${r.ticketPrintCount} time(s)` : undefined}
      />
      {error && <p style={{ color: '#b00', padding: 16 }}>{error}</p>}
      {r && (
        <div
          data-testid="return-ticket"
          style={{
            background: '#fff',
            color: '#000',
            fontFamily: 'Arial, Helvetica, sans-serif',
            fontSize: 12,
            maxWidth: 780,
            margin: '0 auto',
            padding: 24,
          }}
        >
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
          >
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>Return Ticket</div>
              <div style={{ fontSize: 11 }}>{r.businessName}</div>
              <div style={{ fontSize: 11 }}>
                {r.locationName ? `Store: ${r.locationName}` : ''}
                {r.salespersonName ? ` · Taken by: ${r.salespersonName}` : ''}
              </div>
            </div>
            <div style={{ ...box, textAlign: 'center', width: 220 }}>
              <div style={label}>RMA #</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{r.rmaNumber}</div>
              <div style={{ fontSize: 10, marginTop: 2 }}>
                Authorized {new Date(r.authorizedAt).toLocaleDateString()} · {r.status}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <div style={{ ...box, flex: 1, minHeight: 80 }}>
              <div style={label}>Customer</div>
              <div style={{ fontWeight: 700 }}>{r.customerName ?? '—'}</div>
              <div style={{ fontSize: 11 }}>
                {r.addressLine1 && <div>{r.addressLine1}</div>}
                {r.addressLine2 && <div>{r.addressLine2}</div>}
                {(r.addressCity || r.addressPostalCode) && (
                  <div>
                    {[r.addressCity, r.addressRegion, r.addressPostalCode]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                )}
                {r.customerPhone && <div>Ph. {r.customerPhone}</div>}
                {r.customerEmail && <div>{r.customerEmail}</div>}
              </div>
            </div>
            <div style={{ ...box, flex: 1, minHeight: 80 }}>
              <div style={label}>Original invoice</div>
              <div style={{ fontWeight: 700 }}>{r.orderNumber ?? '—'}</div>
              <div style={{ fontSize: 11 }}>
                {r.orderDate ? `Sold ${new Date(r.orderDate).toLocaleDateString()}` : ''}
              </div>
              <div style={{ fontSize: 11, marginTop: 6 }}>
                Goods come back by:{' '}
                <strong>{r.fulfillment === 'pickup' ? 'truck pickup' : 'customer drop-off'}</strong>
              </div>
              {r.pickup && (
                <div style={{ fontSize: 11 }}>
                  Pickup {day(r.pickup.scheduledDate)}
                  {r.pickup.windowStart
                    ? ` ${r.pickup.windowStart.slice(0, 5)}–${(r.pickup.windowEnd ?? '').slice(0, 5)}`
                    : ''}
                  {r.pickup.contactStatus ? ` · ${r.pickup.contactStatus.replace(/_/g, ' ')}` : ''}
                </div>
              )}
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
            <thead>
              <tr>
                <th style={{ ...cell, textAlign: 'left' }}>Item</th>
                <th style={{ ...cell, textAlign: 'left' }}>Reason</th>
                <th style={{ ...cell, textAlign: 'right' }}>Qty</th>
                <th style={{ ...cell, textAlign: 'right' }}>Per unit</th>
                <th style={{ ...cell, textAlign: 'right' }}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td style={cell}>{l.description ?? '—'}</td>
                  <td style={cell}>
                    {[l.reasonCode, l.reason].filter(Boolean).join(' — ') || '—'}
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>{l.quantity}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{usd(l.perUnitCents)}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    {usd(l.quantity * l.perUnitCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <table style={{ borderCollapse: 'collapse', minWidth: 300 }}>
              <tbody>
                <tr>
                  <td style={cell}>Returned merchandise</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{usd(r.linesTotalCents)}</td>
                </tr>
                {r.restockingFeeCents > 0 && (
                  <tr>
                    <td style={cell}>Restocking fee</td>
                    <td style={{ ...cell, textAlign: 'right' }}>−{usd(r.restockingFeeCents)}</td>
                  </tr>
                )}
                {r.pickupFeeCents > 0 && (
                  <tr>
                    <td style={cell}>Pickup fee</td>
                    <td style={{ ...cell, textAlign: 'right' }}>−{usd(r.pickupFeeCents)}</td>
                  </tr>
                )}
                <tr>
                  <td style={{ ...cell, fontWeight: 700 }}>
                    Refund (
                    {r.refundMethod === 'store_credit' ? 'store credit' : 'original tenders'})
                  </td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                    {usd(r.amountCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {r.reason && (
            <div style={{ marginTop: 12, fontSize: 11 }}>
              <span style={label}>Reason</span> {r.reason}
            </div>
          )}

          <div style={{ display: 'flex', gap: 24, marginTop: 40 }}>
            <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
              Customer signature
            </div>
            <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
              Received by / date
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
