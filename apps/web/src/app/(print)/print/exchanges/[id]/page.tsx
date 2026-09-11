'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { PrintToolbar } from '../../print-toolbar';

/**
 * Exchange Ticket (A22 slice 6, STORIS Enter an Exchange → print): the
 * container number, both legs (the RMA with its lines and the
 * replacement order with its lines), the return salesperson, how the
 * goods come back, the settlement and the refund tender. Printing
 * records the count on the exchange.
 */

interface ExchangeDetail {
  id: string;
  number: string;
  status: string;
  evenExchange: boolean;
  restockingFeeCents: number;
  returnId: string;
  rmaNumber: string | null;
  returnStatus: string | null;
  returnCents: number;
  saleOrderId: string;
  saleOrderNumber: string | null;
  saleOrderStatus: string | null;
  saleTotalCents: number;
  originalOrderNumber: string | null;
  customerName: string | null;
  createdAt: string;
  notes: string | null;
  returnSalespersonName: string | null;
  fulfillment: string;
  refundTender: string;
  ticketPrintCount: number;
  settlement: {
    returnCents: number;
    restockingFeeCents: number;
    creditCents: number;
    saleTotalCents: number;
    salePaidCents: number;
    saleBalanceDueCents: number;
  };
}
interface ReturnDetail {
  businessName: string | null;
  locationName: string | null;
  customerPhone: string | null;
  addressLine1: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  lines: { id: string; description: string | null; quantity: number; perUnitCents: number }[];
}
interface OrderDetail {
  lines: { id: string; description: string; quantity: number; totalCents: number }[];
  salespersonName?: string | null;
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
const TENDER: Record<string, string> = {
  store_credit: 'store credit',
  original: 'original tenders',
  cash: 'cash',
  check: 'check',
};

export default function ExchangeTicketPrintPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [x, setX] = useState<ExchangeDetail | null>(null);
  const [ret, setRet] = useState<ReturnDetail | null>(null);
  const [sale, setSale] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<ExchangeDetail>(`/v1/exchanges/${id}`)
      .then(async (d) => {
        setX(d);
        const [r, o] = await Promise.all([
          api<ReturnDetail>(`/v1/order-returns/${d.returnId}`).catch(() => null),
          api<OrderDetail>(`/v1/orders/${d.saleOrderId}`).catch(() => null),
        ]);
        setRet(r);
        setSale(o);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  const net = x ? x.settlement.saleTotalCents - x.settlement.creditCents : 0;

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <PrintToolbar
        backHref={`/exchanges/${id}`}
        onPrint={() => {
          api(`/v1/exchanges/${id}/ticket-print`, { method: 'POST' })
            .then(() => window.print())
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
        label="Print exchange ticket"
        note={x && x.ticketPrintCount > 0 ? `Printed ${x.ticketPrintCount} time(s)` : undefined}
      />
      {error && <p style={{ color: '#b00', padding: 16 }}>{error}</p>}
      {x && (
        <div
          data-testid="exchange-ticket"
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
              <div style={{ fontSize: 18, fontWeight: 700 }}>Exchange Ticket</div>
              <div style={{ fontSize: 11 }}>{ret?.businessName}</div>
              <div style={{ fontSize: 11 }}>
                {ret?.locationName ? `Store: ${ret.locationName}` : ''}
                {x.returnSalespersonName ? ` · Return by: ${x.returnSalespersonName}` : ''}
              </div>
            </div>
            <div style={{ ...box, textAlign: 'center', width: 220 }}>
              <div style={label}>Exchange #</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{x.number}</div>
              <div style={{ fontSize: 10, marginTop: 2 }}>
                {new Date(x.createdAt).toLocaleDateString()} · {x.status}
                {x.evenExchange ? ' · even exchange' : ''}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <div style={{ ...box, flex: 1, minHeight: 70 }}>
              <div style={label}>Customer</div>
              <div style={{ fontWeight: 700 }}>{x.customerName ?? '—'}</div>
              <div style={{ fontSize: 11 }}>
                {ret?.addressLine1 && <div>{ret.addressLine1}</div>}
                {(ret?.addressCity || ret?.addressPostalCode) && (
                  <div>
                    {[ret?.addressCity, ret?.addressRegion, ret?.addressPostalCode]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                )}
                {ret?.customerPhone && <div>Ph. {ret.customerPhone}</div>}
              </div>
            </div>
            <div style={{ ...box, flex: 1, minHeight: 70 }}>
              <div style={label}>Legs</div>
              <div style={{ fontSize: 11 }}>
                Original invoice: <strong>{x.originalOrderNumber ?? '—'}</strong>
              </div>
              <div style={{ fontSize: 11 }}>
                Return: <strong>{x.rmaNumber ?? '—'}</strong> ({x.returnStatus ?? '—'}) · goods by{' '}
                {x.fulfillment === 'pickup' ? 'truck pickup' : 'drop-off'}
              </div>
              <div style={{ fontSize: 11 }}>
                Replacement: <strong>{x.saleOrderNumber ?? '—'}</strong> ({x.saleOrderStatus ?? '—'}
                )
              </div>
            </div>
          </div>

          <div style={{ ...label, marginTop: 14 }}>Returned</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
            <thead>
              <tr>
                <th style={{ ...cell, textAlign: 'left' }}>Item</th>
                <th style={{ ...cell, textAlign: 'right' }}>Qty</th>
                <th style={{ ...cell, textAlign: 'right' }}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {(ret?.lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td style={cell}>{l.description ?? '—'}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{l.quantity}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    {usd(l.quantity * l.perUnitCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ ...label, marginTop: 14 }}>Replacement</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
            <thead>
              <tr>
                <th style={{ ...cell, textAlign: 'left' }}>Item</th>
                <th style={{ ...cell, textAlign: 'right' }}>Qty</th>
                <th style={{ ...cell, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {(sale?.lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td style={cell}>{l.description}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{l.quantity}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{usd(l.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <table style={{ borderCollapse: 'collapse', minWidth: 320 }}>
              <tbody>
                <tr>
                  <td style={cell}>Replacement total</td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    {usd(x.settlement.saleTotalCents)}
                  </td>
                </tr>
                <tr>
                  <td style={cell}>Return credit</td>
                  <td style={{ ...cell, textAlign: 'right' }}>−{usd(x.settlement.returnCents)}</td>
                </tr>
                {x.settlement.restockingFeeCents > 0 && (
                  <tr>
                    <td style={cell}>Restocking fee</td>
                    <td style={{ ...cell, textAlign: 'right' }}>
                      +{usd(x.settlement.restockingFeeCents)}
                    </td>
                  </tr>
                )}
                <tr>
                  <td style={{ ...cell, fontWeight: 700 }}>
                    {net >= 0
                      ? 'Balance the customer owes'
                      : `Refund to customer (${TENDER[x.refundTender] ?? x.refundTender})`}
                  </td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                    {usd(Math.abs(net))}
                  </td>
                </tr>
                <tr>
                  <td style={cell}>Paid on replacement so far</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{usd(x.settlement.salePaidCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {x.notes && (
            <div style={{ marginTop: 12, fontSize: 11 }}>
              <span style={label}>Notes</span> {x.notes}
            </div>
          )}

          <div style={{ display: 'flex', gap: 24, marginTop: 40 }}>
            <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
              Customer signature
            </div>
            <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
              Associate / date
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
