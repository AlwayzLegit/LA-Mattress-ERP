'use client';

import { useEffect, useState } from 'react';
import CompetitionWinnersPrintPage from '@/app/(print)/print/competition-winners/page';
import { installDashboardStub } from '../stub';

/** The printable winners sheet on fixtures (redesign Phase 11). */
export default function WinnersPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installDashboardStub({ role: 'manager' });
    setReady(true);
  }, []);
  if (!ready) return null;
  return <CompetitionWinnersPrintPage />;
}
