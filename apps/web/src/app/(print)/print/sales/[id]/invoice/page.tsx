'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { InvoiceDoc, type OrderDocumentPayload } from '@/components/order-documents';
import { PrintToolbar } from '../../../print-toolbar';

/**
 * A register sale (take-with, paid in full) printed as the same Sales
 * Order document a delivery order prints — owner 2026-11-14: the
 * customer takes home the same paper whichever way the ticket was rung,
 * not a till receipt.
 */
export default function SaleInvoicePrintPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [doc, setDoc] = useState<OrderDocumentPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printedAt] = useState(() => new Date());

  useEffect(() => {
    if (!id) return;
    api<OrderDocumentPayload>(`/v1/sales/${id}/document`)
      .then(setDoc)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <PrintToolbar
        backHref={`/sales/${id}`}
        onPrint={() => window.print()}
        label="Print invoice"
      />
      {error && <p style={{ color: '#b00', padding: 16 }}>{error}</p>}
      {doc && <InvoiceDoc doc={doc} printedAt={printedAt} />}
    </div>
  );
}
