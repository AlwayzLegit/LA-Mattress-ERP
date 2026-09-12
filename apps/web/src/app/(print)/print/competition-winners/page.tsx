'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { WinnersSheet } from '@/components/competition/types';
import { PrintToolbar } from '../print-toolbar';

/**
 * The printable winners sheet (README §3.6): letter, black on white. Six
 * races, winner, store, one-line story, the number. Paid on the 5th once
 * returns settle. `?month=YYYY-MM` — default last month.
 */
export default function CompetitionWinnersPrintPage() {
  return (
    <Suspense fallback={null}>
      <Sheet />
    </Suspense>
  );
}

function Sheet() {
  const search = useSearchParams();
  const month = search.get('month');
  const [data, setData] = useState<WinnersSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<WinnersSheet>(`/v1/competitions/sheet${month ? `?month=${month}` : ''}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load'));
  }, [month]);

  return (
    <div
      style={{
        background: '#f3f2ee',
        minHeight: '100vh',
        fontFamily: 'Arial, Helvetica, sans-serif',
      }}
    >
      <PrintToolbar
        backHref="/dashboard"
        onPrint={() => window.print()}
        label="Print winners sheet"
        note="Letter · black on white · for the break room"
      />
      <style>{`
        @media print { body { background: #fff !important; } .cw-page { border: 0 !important; margin: 0 !important; } }
        .cw-page { width: 816px; margin: 24px auto; background: #fff; border: 1px solid #dcd9d2; padding: 48px 56px; color: #000; min-height: 1000px; box-sizing: border-box; }
        .cw-eyebrow { font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #333; }
        .cw-title { font-size: 28px; font-weight: 700; margin: 4px 0 2px; }
        .cw-sub { font-size: 13px; color: #333; padding-bottom: 14px; border-bottom: 2px solid #000; }
        .cw-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding: 18px 0; border-bottom: 1px solid #bbb; }
        .cw-race { font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #333; }
        .cw-name { font-size: 22px; font-weight: 700; margin-top: 2px; }
        .cw-name span { font-weight: 400; font-size: 16px; color: #333; }
        .cw-story { font-size: 13px; color: #222; margin-top: 4px; }
        .cw-value { font-size: 26px; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .cw-foot { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; color: #333; padding-top: 14px; }
      `}</style>
      <div className="cw-page" data-testid="winners-sheet">
        {error && <p>{error}</p>}
        {data && (
          <>
            <div className="cw-eyebrow">Sales competition</div>
            <h1 className="cw-title">{data.label} winners</h1>
            <div className="cw-sub">
              {data.winners.length} races · ${Math.round(data.prizeCents / 100)} each · paid{' '}
              {data.payoutLabel} after returns settle
            </div>
            {data.winners.map((w) => (
              <div className="cw-row" key={w.race}>
                <div>
                  <div className="cw-race">{w.title}</div>
                  <div className="cw-name">
                    {w.name ?? 'No one ranked'}
                    {w.store ? <span> · {w.store}</span> : null}
                  </div>
                  <div className="cw-story">{w.story}</div>
                </div>
                <div className="cw-value">{w.value}</div>
              </div>
            ))}
            <div className="cw-foot">
              <span>{data.storesLine ?? 'People race only this month.'}</span>
              <span>Next month is live — check the strip.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
