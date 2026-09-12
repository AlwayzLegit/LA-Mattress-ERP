'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { LoadingRows, TableWrap } from '@/components/ui';
import { PrintToolbar } from '../../print-toolbar';

/**
 * The run manifest (PLAN-STORIS-GAP §4 / G7): the driver's paper for
 * the day — stops in order with items, COD to collect per stop, and a
 * signature line each, plus the run's COD total. The office keys the
 * close-out from this sheet.
 */

interface Stop {
  id: string;
  orderNumber: string;
  customerName: string | null;
  routePosition: number | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressPhone: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  balanceDueCents: number;
  status: string;
  lines: { id: string; description: string; quantity: number }[];
}

interface Run {
  id: string;
  runDate: string;
  route: string | null;
  truck: string | null;
  status: string;
  codDueCents: number;
  notes: string | null;
  stops: Stop[];
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function RunManifestPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<Run>(`/v1/delivery-runs/${id}`)
      .then(setRun)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  if (error) return <p style={{ padding: 24 }}>{error}</p>;
  if (!run)
    return (
      <div style={{ padding: 24 }}>
        <LoadingRows rows={6} what="This document" />
      </div>
    );

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24, fontSize: 13 }}>
      <PrintToolbar
        backHref="/deliveries/dispatch"
        onPrint={() => window.print()}
        label="Print manifest"
      />
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Delivery Manifest</h1>
          <div>
            {run.runDate}
            {run.route ? ` · Route ${run.route}` : ''}
            {run.truck ? ` · ${run.truck}` : ''}
          </div>
          {run.notes && <div style={{ marginTop: 4 }}>{run.notes}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>COD total: {usd(run.codDueCents)}</div>
          <div>{run.stops.length} stop(s)</div>
        </div>
      </header>

      {/* Print sheet: the cells draw their own black rules, so the wrap drops its chrome. */}
      <TableWrap style={{ border: 'none', borderRadius: 0, background: 'transparent' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #000', textAlign: 'left' }}>
              <th style={{ padding: '4px 6px', width: 36 }}>#</th>
              <th style={{ padding: '4px 6px' }}>Customer / address</th>
              <th style={{ padding: '4px 6px' }}>Items</th>
              <th style={{ padding: '4px 6px', width: 80, textAlign: 'right' }}>Collect</th>
              <th style={{ padding: '4px 6px', width: 160 }}>Signature / outcome</th>
            </tr>
          </thead>
          <tbody>
            {run.stops.map((s, i) => (
              <tr key={s.id} style={{ borderBottom: '1px solid #999', verticalAlign: 'top' }}>
                <td style={{ padding: '8px 6px', fontWeight: 700 }}>{s.routePosition ?? i + 1}</td>
                <td style={{ padding: '8px 6px' }}>
                  <strong>{s.customerName ?? '—'}</strong> · {s.orderNumber}
                  <div>
                    {[s.addressLine1, s.addressLine2].filter(Boolean).join(', ')}
                    <br />
                    {[s.addressCity, s.addressRegion, s.addressPostalCode]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                  {s.addressPhone && <div>☎ {s.addressPhone}</div>}
                  {s.windowStart && s.windowEnd && (
                    <div>
                      Window {s.windowStart.slice(0, 5)}–{s.windowEnd.slice(0, 5)}
                    </div>
                  )}
                </td>
                <td style={{ padding: '8px 6px' }}>
                  {s.lines.map((l) => (
                    <div key={l.id}>
                      {l.quantity}× {l.description}
                    </div>
                  ))}
                </td>
                <td style={{ padding: '8px 6px', textAlign: 'right', fontWeight: 600 }}>
                  {s.balanceDueCents > 0 ? usd(s.balanceDueCents) : '—'}
                </td>
                <td style={{ padding: '8px 6px' }}>
                  <div style={{ borderBottom: '1px solid #000', height: 26, marginBottom: 4 }} />
                  <div style={{ fontSize: 10.5 }}>
                    ☐ delivered &nbsp; ☐ not home &nbsp; ☐ refused &nbsp; ☐ damaged
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

      <footer style={{ marginTop: 24, display: 'flex', gap: 40 }}>
        <div style={{ flex: 1 }}>
          <div style={{ borderBottom: '1px solid #000', height: 28 }} />
          <div style={{ fontSize: 11 }}>Driver signature</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ borderBottom: '1px solid #000', height: 28 }} />
          <div style={{ fontSize: 11 }}>COD received by (office)</div>
        </div>
        <div style={{ width: 140 }}>
          <div style={{ borderBottom: '1px solid #000', height: 28 }} />
          <div style={{ fontSize: 11 }}>Cash returned $</div>
        </div>
      </footer>
    </div>
  );
}
