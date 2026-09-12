'use client';

import { useEffect, useState } from 'react';
import { CompetitionStrip } from '@/components/competition/competition-strip';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import { installDashboardStub } from '../stub';

/** The competition strip + My leads as the salesperson sees them, on fixtures (redesign Phase 11). */
export default function CompetitionPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installDashboardStub({ role: 'manager' });
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <BusinessSettingsProvider>
      <div
        className="mx-auto w-full max-w-[1560px] px-[22px] pb-12 pt-[22px]"
        style={{ background: 'var(--bg)', minHeight: '100vh' }}
      >
        <div className="t-mono-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
          PREVIEW · FIXTURES FROM THE CANVAS · NOTHING IS SAVED
        </div>
        <div className="dh-eyebrow t-mono-sm" style={{ marginBottom: 4 }}>
          SELL · GLENDALE
        </div>
        <h1
          style={{
            margin: '0 0 14px',
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 600,
          }}
        >
          My day — Maya
        </h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <CompetitionStrip showLeads actorName="Maya Torres" />
          <div
            className="panel"
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--muted)',
              borderStyle: 'dashed',
            }}
          >
            Salesperson home continues below — the strip sits above all of it.
          </div>
        </div>
      </div>
    </BusinessSettingsProvider>
  );
}
