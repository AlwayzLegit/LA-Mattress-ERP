'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
export function PushControls() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function change(enable: boolean) {
    setBusy(true);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window))
        throw Error('Background push is unavailable in this browser.');
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (enable) {
        const { publicKey } = await api<{ publicKey: string }>('/v1/chat/conversations/push-key');
        if ((await Notification.requestPermission()) !== 'granted')
          throw Error('Allow notifications in your browser settings to enable background alerts.');
        subscription ??= await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: Uint8Array.from(
            atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')),
            (char) => char.charCodeAt(0),
          ),
        });
        await api('/v1/chat/conversations/push-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
          body: JSON.stringify(subscription.toJSON()),
        });
        setStatus('Background push enabled for this business and browser.');
      } else {
        if (subscription) {
          await api('/v1/chat/conversations/push-unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });
          await subscription.unsubscribe();
        }
        setStatus('Background push disabled.');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to configure background push.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <Button disabled={busy} onClick={() => void change(true)}>
        Enable background push
      </Button>{' '}
      <Button disabled={busy} onClick={() => void change(false)}>
        Disable background push
      </Button>
      <p role="status">{status}</p>
    </div>
  );
}
