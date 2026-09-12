'use client';

import { useEffect, useState } from 'react';
import OwnerHome from '@/app/(business)/dashboard/owner/owner-home';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import { DashboardFiltersProvider } from '@/lib/dashboard-filters';
import { installDashboardStub } from './stub';

/** The owner home on the canvas's five stores (redesign Phase 9). */
export default function OwnerDashboardPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installDashboardStub({ role: 'owner' });
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <BusinessSettingsProvider>
      <DashboardFiltersProvider>
        <div
          className="mx-auto w-full max-w-[1560px] px-[22px] pb-12 pt-[22px]"
          style={{ background: 'var(--bg)', minHeight: '100vh' }}
        >
          <div className="t-mono-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
            PREVIEW · FIXTURES FROM THE CANVAS · NOTHING IS SAVED
          </div>
          <OwnerHome userName="Alex Rivera" email="alex@lamattress.com" />
        </div>
      </DashboardFiltersProvider>
    </BusinessSettingsProvider>
  );
}
