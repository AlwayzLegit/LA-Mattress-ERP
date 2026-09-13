'use client';

import { useEffect, useState } from 'react';
import OperationsDashboardView from '@/app/(business)/dashboard/operations-dashboard';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import { DashboardFiltersProvider } from '@/lib/dashboard-filters';
import { installDashboardStub } from '../stub';

/** The Operations home on fixtures (redesign Phase 10). */
export default function OperationsDashboardPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installDashboardStub({ role: 'ops' });
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
          <OperationsDashboardView userName="Dana Whitmore" />
        </div>
      </DashboardFiltersProvider>
    </BusinessSettingsProvider>
  );
}
