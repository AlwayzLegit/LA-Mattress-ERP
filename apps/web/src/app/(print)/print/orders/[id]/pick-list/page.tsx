'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  Barcode39,
  type OrderDocumentPayload,
  LineInstructions,
} from '@/components/order-documents';
import { TableWrap } from '@/components/ui';
import { PrintToolbar } from '../../../print-toolbar';

/**
 * Pick list (PLAN-STORIS-GAP §3 / G15): the warehouse pull sheet.
 * Deliberately NO prices, NO discounts, NO totals — the warehouse
 * should never see line pricing on a pull document. Printing never
 * locks anything; it's an internal working paper.
 */
export default function PickListPrintPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [doc, setDoc] = useState<OrderDocumentPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<OrderDocumentPayload>(`/v1/orders/${id}/document`)
      .then(setDoc)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  if (error) return <p style={{ padding: 24 }}>{error}</p>;
  if (!doc) return <p style={{ padding: 24 }}>Loading…</p>;

  const goods = doc.lines.filter((l) => l.lineType !== 'custom');

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <PrintToolbar
        backHref={`/orders/${id}`}
        onPrint={() => window.print()}
        label="Print pick list"
      />
      <div style={{ maxWidth: 720, margin: '0 auto', padding: 24, fontSize: 13, color: '#000' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: 18, margin: 0 }}>PICK LIST</h1>
            <div>
              Order <strong>{doc.order.number}</strong>
              {doc.location?.name ? ` · ${doc.location.name}` : ''}
            </div>
            {doc.scheduledDate && <div>Scheduled: {doc.scheduledDate}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div>{doc.customer?.name ?? ''}</div>
            <div style={{ fontSize: 11.5 }}>{doc.order.fulfillmentType.replace(/_/g, ' ')}</div>
            {/* BA-0029: scannable order-number barcode. */}
            <Barcode39 value={doc.order.number} height={30} />
          </div>
        </header>

        {/* Print sheet: the cells draw their own black rules, so the wrap drops its chrome. */}
        <TableWrap style={{ border: 'none', borderRadius: 0, background: 'transparent' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #000', textAlign: 'left' }}>
                <th style={{ padding: '4px 6px', width: 50 }}>Qty</th>
                <th style={{ padding: '4px 6px' }}>Item</th>
                <th style={{ padding: '4px 6px', width: 140 }}>Model / SKU</th>
                <th style={{ padding: '4px 6px', width: 80 }}>Bin</th>
                <th style={{ padding: '4px 6px', width: 70 }}>Pulled ☐</th>
              </tr>
            </thead>
            <tbody>
              {goods.map((l) => (
                <tr key={l.id} style={{ borderBottom: '1px solid #999' }}>
                  <td style={{ padding: '10px 6px', fontWeight: 700, fontSize: 15 }}>
                    {l.quantity}
                  </td>
                  <td style={{ padding: '10px 6px' }}>
                    {l.description}
                    {l.lineType === 'special_order' && (
                      <span style={{ fontWeight: 700 }}> — SPECIAL ORDER</span>
                    )}
                    <LineInstructions l={l} />
                  </td>
                  <td style={{ padding: '10px 6px' }}>
                    {l.model ?? '—'}
                    {/* BA-0029: SKU barcode per line, when it encodes. */}
                    {l.model && (
                      <div>
                        <Barcode39 value={l.model} height={22} showText={false} />
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 6px', fontWeight: 700 }}>{l.bin ?? '—'}</td>
                  <td style={{ padding: '10px 6px' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 22,
                        height: 22,
                        border: '2px solid #000',
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>

        <footer style={{ marginTop: 28, display: 'flex', gap: 40 }}>
          <div style={{ flex: 1 }}>
            <div style={{ borderBottom: '1px solid #000', height: 26 }} />
            <div style={{ fontSize: 11 }}>Pulled by</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ borderBottom: '1px solid #000', height: 26 }} />
            <div style={{ fontSize: 11 }}>Checked by</div>
          </div>
        </footer>
      </div>
    </div>
  );
}
