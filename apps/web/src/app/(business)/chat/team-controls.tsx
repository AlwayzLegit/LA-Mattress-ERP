'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import styles from './chat.module.css';
export function TeamControls() {
  const [available, setAvailable] = useState(false);
  const [capacity, setCapacity] = useState(5);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!available) return;
    const timer = setInterval(() => {
      void api('/v1/chat/conversations/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
        body: JSON.stringify({ available: true, capacity }),
      }).catch(() => {
        setAvailable(false);
        setStatus('Availability heartbeat failed. Set yourself available again when connected.');
      });
    }, 15000);
    return () => clearInterval(timer);
  }, [available, capacity]);
  return (
    <div className={styles.teamControls}>
      <Button
        disabled={busy}
        aria-pressed={available}
        onClick={async () => {
          setBusy(true);
          try {
            await api('/v1/chat/conversations/availability', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
              body: JSON.stringify({ available: !available, capacity }),
            });
            setAvailable(!available);
            setStatus(
              !available
                ? 'You are available while this inbox remains connected.'
                : 'You are away.',
            );
          } catch (e) {
            setStatus(e instanceof Error ? e.message : 'Unable to change availability');
          } finally {
            setBusy(false);
          }
        }}
      >
        {available ? '● Available for chats' : '○ Away · start taking chats'}
      </Button>
      <details className={styles.settingsMenu}>
        <summary>Availability options</summary>
        <div className={styles.settingsContent}>
          <label>
            Maximum active chats{' '}
            <select value={capacity} onChange={(e) => setCapacity(Number(e.target.value))}>
              {[1, 2, 3, 5, 10, 20].map((value) => (
                <option key={value} value={value}>
                  {value} chats
                </option>
              ))}
            </select>
          </label>
          <Button
            onClick={async () => {
              try {
                const result = await api<{
                  transport: { pending: number; failed: number };
                  push: { pending: number; failed: number };
                }>('/v1/chat/conversations/operations');
                setStatus(
                  `Transport: ${result.transport.pending} pending / ${result.transport.failed} failed. Push: ${result.push.pending} pending / ${result.push.failed} failed.`,
                );
              } catch (e) {
                setStatus(e instanceof Error ? e.message : 'Operations unavailable');
              }
            }}
          >
            Delivery status
          </Button>
          <Button
            onClick={async () => {
              try {
                const result = await api<{ retried: number }>(
                  '/v1/chat/conversations/retry-failed',
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
                    body: '{}',
                  },
                );
                setStatus(`${result.retried} failed deliveries queued for retry.`);
              } catch (e) {
                setStatus(e instanceof Error ? e.message : 'Retry unavailable');
              }
            }}
          >
            Retry failed deliveries
          </Button>
        </div>
      </details>
      {status && (
        <span className={styles.teamStatus} role="status">
          {status}
        </span>
      )}
    </div>
  );
}
