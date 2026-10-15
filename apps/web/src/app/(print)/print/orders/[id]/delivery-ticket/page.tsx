'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { DeliveryTicketDoc, type OrderDocumentPayload } from '@/components/order-documents';
import { PrintToolbar } from '../../../print-toolbar';

/**
 * Individual delivery-ticket print. Per amendment A1 the Print button
 * first records the print server-side — which LOCKS the order against
 * edits — then opens the browser print dialog. Batch printing (from
 * /print/deliveries) never locks.
 */
export default function DeliveryTicketPrintPage() {
  // useSearchParams needs a Suspense boundary (as in /print/purchase-orders).
  return (
    <Suspense fallback={null}>
      <DeliveryTicketPrint />
    </Suspense>
  );
}

function DeliveryTicketPrint() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  // Owner 2026-10-15: opened from one delivery stop, the ticket is that
  // stop's — its date on the ticket, and the print recorded against it.
  const deliveryId = useSearchParams()?.get('deliveryId') ?? null;
  const [routeDate, setRouteDate] = useState<string | null>(null);
  const [doc, setDoc] = useState<OrderDocumentPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [copyNumber, setCopyNumber] = useState<number | null>(null);
  const [checks, setChecks] = useState<{ check: string; ok: boolean; detail: string }[] | null>(
    null,
  );

  useEffect(() => {
    if (!id) return;
    api<OrderDocumentPayload>(`/v1/orders/${id}/document`)
      .then((d) => {
        setDoc(d);
        setLocked(Boolean(d.order.lockedAt));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    if (deliveryId) {
      api<{ scheduledDate: string }>(`/v1/deliveries/${deliveryId}`)
        .then((d) => setRouteDate(d.scheduledDate))
        .catch(() => setRouteDate(null));
    }
  }, [id, deliveryId]);

  async function printAndLock() {
    setChecks(null);
    try {
      const res = await api<{ lockedAt: string | null; copyNumber: number }>(
        `/v1/orders/${id}/delivery-ticket-print`,
        { method: 'POST', body: JSON.stringify(deliveryId ? { deliveryId } : {}) },
      );
      setLocked(Boolean(res.lockedAt));
      setCopyNumber(res.copyNumber);
    } catch (err) {
      // G9: the server refuses with a pass/fail checklist — show it so
      // the user knows exactly what to fix, not just a dead button.
      if (err instanceof ApiError && err.code === 'PRINT_BLOCKED') {
        setChecks((err.body?.checks as { check: string; ok: boolean; detail: string }[]) ?? null);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    window.print();
  }

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <PrintToolbar
        backHref={`/orders/${id}`}
        onPrint={printAndLock}
        label="Print ticket"
        note={
          locked
            ? 'Order is locked (ticket printed).'
            : 'Printing locks the order against edits until it is unlocked.'
        }
      />
      {error && <p style={{ color: '#b00', padding: 16 }}>{error}</p>}
      {checks && (
        <div
          data-testid="print-blocked-checklist"
          style={{ margin: 16, padding: 12, border: '2px solid #b00', fontSize: 13 }}
        >
          <strong>Cannot print yet:</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {checks.map((c) => (
              <li key={c.check} style={{ color: c.ok ? '#060' : '#b00' }}>
                {c.ok ? '✓' : '✗'} {c.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {copyNumber != null && copyNumber > 1 && (
        <p style={{ margin: 16, fontWeight: 700 }}>REPRINT — copy #{copyNumber}</p>
      )}
      {doc && <DeliveryTicketDoc doc={doc} routeDate={routeDate} />}
    </div>
  );
}
