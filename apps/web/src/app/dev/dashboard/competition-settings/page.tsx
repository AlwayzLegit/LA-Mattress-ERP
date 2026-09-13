'use client';

import { useEffect, useState } from 'react';
import { CompetitionsCard } from '@/app/(business)/settings/competitions-card';
import { installDashboardStub } from '../stub';

/** The owner's competition settings card on fixtures (redesign Phase 11). */
export default function CompetitionSettingsPreview() {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<{ ops: { competitions?: null } | null }>({ ops: null });
  useEffect(() => {
    installDashboardStub({ role: 'owner' });
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <div
      className="mx-auto w-full max-w-[1560px] px-[22px] pb-12 pt-[22px]"
      style={{ background: 'var(--bg)', minHeight: '100vh' }}
    >
      <div className="t-mono-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
        PREVIEW · FIXTURES FROM THE CANVAS · NOTHING IS SAVED
      </div>
      <div className="dh-eyebrow t-mono-sm">SETTINGS · COMPETITIONS</div>
      <CompetitionsCard settings={settings} onSaved={setSettings} />
    </div>
  );
}
