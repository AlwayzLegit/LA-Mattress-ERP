'use client';

import { useEffect, useState } from 'react';
import { Button, ErrorState } from '@/components/ui';
import { dismissOutage, retryNow, useApiStatus } from '@/lib/api-status';
import { pendingCount, readActiveBusinessId } from '@/lib/offline';

/**
 * Global error state (canvas 3d): shown above the page when the API
 * cannot be reached. The sidebar and the store context stay; the message
 * names the draft, says it is safe, retries on its own with a visible
 * timer, and the button jumps the queue. Never a bare "Loading…".
 */
export function ShellError() {
  const s = useApiStatus();
  const [now, setNow] = useState(() => Date.now());
  const [queued, setQueued] = useState(0);

  useEffect(() => {
    if (!s.down) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [s.down]);

  useEffect(() => {
    if (!s.down) return;
    const biz = readActiveBusinessId();
    if (!biz) return;
    pendingCount(biz)
      .then(setQueued)
      .catch(() => setQueued(0));
  }, [s.down, s.attempt]);

  if (!s.down || s.dismissed) return null;
  const secs = s.nextRetryAt ? Math.max(0, Math.ceil((s.nextRetryAt - now) / 1000)) : 0;

  return (
    <div className="shell-error" data-testid="shell-error">
      <ErrorState title="The register could not reach the server">
        {s.draft ? (
          <>
            Your draft <span className="mono">{s.draft}</span> is kept on this machine.{' '}
          </>
        ) : queued > 0 ? (
          <>
            {queued} sale{queued === 1 ? ' is' : 's are'} queued on this machine.{' '}
          </>
        ) : (
          <>Anything you save is kept on this machine. </>
        )}
        Retry now, or keep writing — items and payments will save when the connection is back.
        Nothing has been lost.
        <div className="error-state-actions">
          <Button size="sm" onClick={retryNow}>
            Retry now
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissOutage}>
            Keep writing offline
          </Button>
          <span className="error-state-countdown">
            {secs > 0 ? `retrying in ${secs}s` : 'retrying…'} · attempt {Math.max(1, s.attempt)}
          </span>
        </div>
      </ErrorState>
    </div>
  );
}
