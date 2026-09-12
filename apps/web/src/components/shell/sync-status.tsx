'use client';

import { useEffect, useState } from 'react';
import { useApiStatus } from '@/lib/api-status';
import { pendingCount, readActiveBusinessId } from '@/lib/offline';

/**
 * Sidebar footer (canvas 3a/3d/3e): a dot and a sentence. Green "Synced ·
 * 9:41 AM"; amber "Connecting…" before the first answer; red "Offline ·
 * retrying" when the API cannot be reached or sales are queued locally.
 * Polls the offline queue every 15s; the browser's online/offline events
 * and the API status flip it immediately.
 */
export function SyncStatus({ connecting = false }: { connecting?: boolean }) {
  const apiStatus = useApiStatus();
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    let alive = true;
    const tick = async () => {
      const biz = readActiveBusinessId();
      if (!biz) return;
      try {
        const n = await pendingCount(biz);
        if (alive) {
          setQueued(n);
          setCheckedAt(new Date());
        }
      } catch {
        // IndexedDB unavailable — treat as nothing queued.
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 15_000);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const down = !online || apiStatus.down;
  const tone: 'ok' | 'warn' | 'bad' = down ? 'bad' : connecting || queued > 0 ? 'warn' : 'ok';
  const time = checkedAt
    ? checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  const label = !online
    ? 'Offline · sales queue locally'
    : apiStatus.down
      ? 'Offline · retrying'
      : queued > 0
        ? `${queued} sale${queued === 1 ? '' : 's'} waiting to sync`
        : connecting
          ? 'Connecting…'
          : time
            ? `Synced · ${time}`
            : 'Synced';
  return (
    <div data-testid="sync-status" className={`sync sync-${tone}`} role="status">
      <span className="sync-dot" aria-hidden />
      <span className="sync-label">{label}</span>
    </div>
  );
}
