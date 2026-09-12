'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { TableWrap } from '@/components/ui';
import { PrintToolbar } from '../../print-toolbar';

/**
 * Count sheet (physical inventory, FAQ pack C1). Deliberately **blind**:
 * system quantities are not printed, so the counter writes what is
 * actually on the floor instead of confirming what the screen says.
 * Lines come bin-ordered from the API — the walking order.
 */

interface CountLine {
  id: string;
  variantId: string;
  sku: string | null;
  productName: string;
  binCode: string | null;
  countedQty: number | null;
}

interface CountDetail {
  id: string;
  locationName: string;
  status: string;
  countDate: string;
  frozenAt: string;
  notes: string | null;
  lines: CountLine[];
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
/* Print sheet: the cells draw their own black rules, so the wrap drops its chrome. */
const wrap: React.CSSProperties = { border: 'none', borderRadius: 0, background: 'transparent' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' };

export default function CountSheetPrintPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [c, setC] = useState<CountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<CountDetail>(`/v1/inventory/counts/${id}`)
      .then(setC)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <PrintToolbar
        backHref={`/products/counts/${id}`}
        onPrint={() => window.print()}
        label="Print count sheet"
      />
      {error && <p style={{ color: '#b00', padding: 16 }}>{error}</p>}
      {c && (
        <div
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
              <div style={{ fontSize: 18, fontWeight: 700 }}>Physical Count Sheet</div>
              <div style={{ fontSize: 11 }}>{c.locationName}</div>
            </div>
            <div style={{ ...box, textAlign: 'center', width: 220 }}>
              <div style={label}>Count date</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {new Date(`${c.countDate}T00:00:00`).toLocaleDateString()}
              </div>
              <div style={{ fontSize: 10, marginTop: 2 }}>
                Frozen {new Date(c.frozenAt).toLocaleString()}
              </div>
            </div>
          </div>

          {c.notes && (
            <div style={{ ...box, marginTop: 10 }}>
              <div style={label}>Notes</div>
              {c.notes}
            </div>
          )}

          <TableWrap style={{ ...wrap, marginTop: 12 }}>
            <table style={table}>
              <thead>
                <tr>
                  {['Bin', 'SKU', 'Item', 'Counted qty', 'Initials'].map((h) => (
                    <th key={h} style={{ ...cell, ...label, textAlign: 'left' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={{ ...cell, width: 80 }}>{l.binCode ?? '—'}</td>
                    <td style={{ ...cell, width: 140 }}>
                      <code>{l.sku ?? '—'}</code>
                    </td>
                    <td style={cell}>{l.productName}</td>
                    {/* Blank boxes — the sheet is blind on purpose. */}
                    <td style={{ ...cell, width: 90 }}>&nbsp;</td>
                    <td style={{ ...cell, width: 70 }}>&nbsp;</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <div style={{ marginTop: 48, display: 'flex', gap: 24 }}>
            <div style={{ flex: 1 }}>
              <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
                Counted by (signature)
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
                Verified by (signature)
              </div>
            </div>
            <div style={{ width: 120 }}>
              <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>Date</div>
            </div>
          </div>
          <p style={{ fontSize: 10, color: '#333', marginTop: 'var(--space-4)' }}>
            Count every unit physically present, including items staged for delivery. Write the
            quantity even when it is zero. Anything found that is not on this sheet goes in the
            blank lines below with its SKU.
          </p>
          {/* A few blank rows for found stock. */}
          <TableWrap style={{ ...wrap, marginTop: 8 }}>
            <table style={table}>
              <tbody>
                {[0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td style={{ ...cell, width: 80 }}>&nbsp;</td>
                    <td style={{ ...cell, width: 140 }}>&nbsp;</td>
                    <td style={cell}>&nbsp;</td>
                    <td style={{ ...cell, width: 90 }}>&nbsp;</td>
                    <td style={{ ...cell, width: 70 }}>&nbsp;</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
      )}
    </div>
  );
}
