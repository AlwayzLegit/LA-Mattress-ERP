'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  ExchangeTicketDoc,
  type ExchangeTicketExchange,
  type ExchangeTicketReturn,
} from '@/components/exchange-ticket';
import type { OrderDocumentPayload } from '@/components/order-documents';
import { PrintToolbar } from '../../print-toolbar';

/**
 * Exchange Ticket (A22 slice 6, STORIS Enter an Exchange → print), in
 * the invoice's dress since owner 2026-11-05. Three reads: the container,
 * the return leg, and the replacement order's print document (which also
 * carries the tenant branding and the store address). Printing records
 * the count on the exchange.
 */
export default function ExchangeTicketPrintPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [x, setX] = useState<ExchangeTicketExchange | null>(null);
  const [ret, setRet] = useState<ExchangeTicketReturn | null>(null);
  const [sale, setSale] = useState<OrderDocumentPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printedAt] = useState(() => new Date());

  useEffect(() => {
    if (!id) return;
    api<ExchangeTicketExchange>(`/v1/exchanges/${id}`)
      .then(async (d) => {
        const [r, o] = await Promise.all([
          api<ExchangeTicketReturn>(`/v1/order-returns/${d.returnId}`).catch(() => null),
          api<OrderDocumentPayload>(`/v1/orders/${d.saleOrderId}/document`).catch(() => null),
        ]);
        setRet(r);
        setSale(o);
        setX(d);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

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
      {x && <ExchangeTicketDoc exchange={x} ret={ret} sale={sale} printedAt={printedAt} />}
    </div>
  );
}
