'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { formatPhone } from '@jetnine/shared';
import { TableWrap } from '@/components/ui';
import { PrintToolbar } from '../../print-toolbar';

/**
 * Manifest document (Q1, owner 2026-08-28): the truck's paper — one
 * lane, one date, transfers in load order with unit counts and a
 * driver signature line. Individual transfer tickets still print per
 * transfer; this is the load sheet.
 */

interface ManifestTransfer {
  id: string;
  number: string;
  status: string;
  transferType: string;
  loadNumber: number | null;
  lineCount: number;
  unitCount: number;
}

interface Manifest {
  id: string;
  number: string;
  status: string;
  manifestDate: string;
  routeName: string | null;
  businessName: string | null;
  fromLocationName: string | null;
  fromLocationAddressJson: unknown;
  toLocationName: string | null;
  toLocationAddressJson: unknown;
  notes: string | null;
  transfers: ManifestTransfer[];
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

function AddressBlock({ addressJson }: { addressJson: unknown }) {
  if (!addressJson || typeof addressJson !== 'object') return null;
  const a = addressJson as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : null);
  const cityLine = [s('city'), s('region') ?? s('state'), s('postalCode') ?? s('zip')]
    .filter(Boolean)
    .join(', ');
  return (
    <div style={{ fontSize: 11, color: '#111' }}>
      {s('line1') && <div>{s('line1')}</div>}
      {cityLine && <div>{cityLine}</div>}
      {s('phone') && <div>Ph. {formatPhone(s('phone'))}</div>}
    </div>
  );
}

export default function ManifestPrintPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [m, setM] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<Manifest>(`/v1/stock-manifests/${id}`)
      .then(setM)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  const totalUnits = m?.transfers.reduce((s, t) => s + t.unitCount, 0) ?? 0;

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <PrintToolbar
        backHref={`/transfers/manifests/${id}`}
        onPrint={() => window.print()}
        label="Print manifest"
      />
      {error && <p style={{ color: '#b00', padding: 16 }}>{error}</p>}
      {m && (
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
              <div style={{ fontSize: 18, fontWeight: 700 }}>Transfer Manifest</div>
              <div style={{ fontSize: 11 }}>{m.businessName}</div>
            </div>
            <div style={{ ...box, textAlign: 'center', width: 220 }}>
              <div style={label}>Manifest #</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{m.number}</div>
              <div style={{ fontSize: 10, marginTop: 2 }}>
                {m.manifestDate}
                {m.routeName ? ` · ${m.routeName}` : ''}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <div style={{ ...box, flex: 1, minHeight: 70 }}>
              <div style={label}>From</div>
              <div style={{ fontWeight: 700 }}>{m.fromLocationName ?? '—'}</div>
              <AddressBlock addressJson={m.fromLocationAddressJson} />
            </div>
            <div style={{ ...box, flex: 1, minHeight: 70 }}>
              <div style={label}>To</div>
              <div style={{ fontWeight: 700 }}>{m.toLocationName ?? '—'}</div>
              <AddressBlock addressJson={m.toLocationAddressJson} />
            </div>
          </div>

          {/* Print sheet: the cells draw their own black rules, so the wrap drops its chrome. */}
          <TableWrap
            style={{
              marginTop: 'var(--space-3)',
              border: 'none',
              borderRadius: 0,
              background: 'transparent',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Load', 'Transfer #', 'Type', 'Lines', 'Units', 'Loaded ✓'].map((h) => (
                    <th key={h} style={{ ...cell, ...label, textAlign: 'left' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.transfers.map((t) => (
                  <tr key={t.id}>
                    <td style={{ ...cell, width: 48, textAlign: 'right' }}>{t.loadNumber ?? ''}</td>
                    <td style={{ ...cell, width: 140 }}>
                      <code>{t.number}</code>
                    </td>
                    <td style={cell}>{t.transferType}</td>
                    <td style={{ ...cell, width: 56, textAlign: 'right' }}>{t.lineCount}</td>
                    <td style={{ ...cell, width: 56, textAlign: 'right' }}>{t.unitCount}</td>
                    {/* Blank tally box the loader ticks by hand. */}
                    <td style={{ ...cell, width: 70 }}>&nbsp;</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...cell, fontWeight: 700 }} colSpan={4}>
                    Total units
                  </td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{totalUnits}</td>
                  <td style={cell}>&nbsp;</td>
                </tr>
              </tbody>
            </table>
          </TableWrap>

          {m.notes && (
            <div style={{ ...box, marginTop: 10, minHeight: 30 }}>
              <div style={label}>Notes</div>
              {m.notes}
            </div>
          )}

          <div style={{ marginTop: 56, display: 'flex', gap: 24 }}>
            <div style={{ flex: 1 }}>
              <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
                Loaded by (signature)
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
                Driver signature
              </div>
            </div>
            <div style={{ width: 120 }}>
              <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>Date</div>
            </div>
          </div>
          <p style={{ fontSize: 10, color: '#333', marginTop: 'var(--space-4)' }}>
            Each transfer on this manifest has its own ticket for the receiving side. Complete the
            manifest in the system when the truck leaves.
          </p>
        </div>
      )}
    </div>
  );
}
