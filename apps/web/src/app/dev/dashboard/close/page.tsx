'use client';

import { useEffect, useState } from 'react';
import CloseOutSheet from '@/app/(business)/shifts/close/close-out-sheet';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import { installDashboardStub } from '../stub';

/** The close-out sheet (Z-report) for Glendale, yesterday, on fixtures (redesign Phase 10). */
export default function CloseOutPreview() {
  const [ready, setReady] = useState(false);
  const [nav, setNav] = useState<{ date: string; locationId: string | null }>({
    date: '',
    locationId: 'gl',
  });
  useEffect(() => {
    installDashboardStub({ role: 'manager' });
    const d = new Date();
    d.setDate(d.getDate() - 1);
    setNav({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      locationId: 'gl',
    });
    setReady(true);
  }, []);
  if (!ready || !nav.date) return null;
  return (
    <BusinessSettingsProvider>
      <div
        className="mx-auto w-full max-w-[1560px] px-[22px] pb-12 pt-[22px]"
        style={{ background: 'var(--bg)', minHeight: '100vh' }}
      >
        <div className="t-mono-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
          PREVIEW · FIXTURES FROM THE CANVAS · NOTHING IS SAVED
        </div>
        <CloseOutSheet date={nav.date} locationId={nav.locationId} onNavigate={setNav} />
      </div>
    </BusinessSettingsProvider>
  );
}
