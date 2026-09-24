'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { DeliveryTicketDoc, type OrderDocumentPayload } from '@/components/order-documents';
import { PrintToolbar } from '../print-toolbar';
import { localToday } from '@/lib/date-range';

/**
 * Batch "Print all for date" (§7): one delivery ticket per trip
 * scheduled that day, page-broken. Per amendment A1, batch printing
 * does NOT lock any order. Trips whose orders aren't ready — stock not
 * fully reserved, or the trip already failed — print with a bold flag
 * saying which and why instead of being silently skipped.
 */

interface DeliveryRow {
  id: string;
  orderId: string;
  scheduledDate: string;
  status: string;
  routePosition: number | null;
}

interface Ticket {
  delivery: DeliveryRow;
  doc: OrderDocumentPayload;
  flag: string | null;
}

function flagFor(delivery: DeliveryRow, doc: OrderDocumentPayload): string | null {
  if (delivery.status === 'failed') return 'previous attempt failed — reschedule';
  const short = doc.lines.some(
    (l) => l.lineType === 'stock' && l.qtyReserved + l.qtyFulfilled < l.quantity,
  );
  if (short) return 'stock not fully reserved';
  return null;
}

function BatchPrintInner() {
  const search = useSearchParams();
  const date = search?.get('date') ?? localToday();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    api<DeliveryRow[]>(`/v1/deliveries?from=${date}&to=${date}`)
      .then(async (trips) => {
        const undelivered = trips.filter((t) =>
          ['scheduled', 'loaded', 'out_for_delivery', 'failed'].includes(t.status),
        );
        const docs = await Promise.all(
          undelivered.map((t) =>
            api<OrderDocumentPayload>(`/v1/orders/${t.orderId}/document`).catch(() => null),
          ),
        );
        if (stale) return;
        setTickets(
          undelivered.flatMap((delivery, i) => {
            const doc = docs[i];
            return doc ? [{ delivery, doc, flag: flagFor(delivery, doc) }] : [];
          }),
        );
      })
      .catch((err) => {
        if (!stale) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stale = true;
    };
  }, [date]);

  const flagged = (tickets ?? []).filter((t) => t.flag);

  return (
    <div style={{ background: '#fff', minHeight: '100vh', color: '#000' }}>
      <PrintToolbar
        backHref="/deliveries"
        onPrint={() => window.print()}
        label={`Print all for ${date}`}
        note="Batch printing does not lock orders."
      />
      {error && <p style={{ color: '#b00', padding: 16 }}>{error}</p>}
      {tickets && tickets.length === 0 && (
        <p style={{ padding: 16, fontFamily: 'Arial, sans-serif' }}>
          No undelivered trips scheduled for {date}.
        </p>
      )}
      {flagged.length > 0 && (
        <div
          className="print-toolbar"
          style={{ padding: '8px 16px', fontFamily: 'Arial, sans-serif', fontSize: 13 }}
        >
          <strong>{flagged.length} not ready:</strong>{' '}
          {flagged.map((t) => `${t.doc.order.number} (${t.flag})`).join(' · ')}
        </div>
      )}
      {tickets?.map((t) => (
        <div key={t.delivery.id} style={{ pageBreakAfter: 'always' }} data-testid="batch-ticket">
          <DeliveryTicketDoc
            doc={t.doc}
            routeDate={t.delivery.scheduledDate}
            routePosition={t.delivery.routePosition}
            flag={t.flag}
          />
        </div>
      ))}
    </div>
  );
}

export default function BatchPrintPage() {
  return (
    <Suspense fallback={null}>
      <BatchPrintInner />
    </Suspense>
  );
}
