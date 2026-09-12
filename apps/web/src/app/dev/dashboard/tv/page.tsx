'use client';

import { useEffect, useState } from 'react';
import CompetitionTvPage from '@/app/(tv)/tv/competition/page';
import { installDashboardStub } from '../stub';

/** TV mode on fixtures (redesign Phase 11) — open at 1920×1080. */
export default function TvPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installDashboardStub({ role: 'owner' });
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <div style={{ background: '#1c1b18', minHeight: '100vh' }}>
      <CompetitionTvPage />
    </div>
  );
}
