'use client';

import { useEffect, useState } from 'react';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import DeliveriesBoardPage from '@/app/(business)/deliveries/page';
import { installDeliveriesStub } from './stub';

/** Deliveries board on fixtures (redesign Phase 8). `?view=month` for the overview. */
export default function DeliveriesPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installDeliveriesStub();
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
        <DeliveriesBoardPage />
      </div>
    </BusinessSettingsProvider>
  );
}
