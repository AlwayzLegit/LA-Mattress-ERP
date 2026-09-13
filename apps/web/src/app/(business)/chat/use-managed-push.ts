'use client';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import type { ChatPolicy } from './use-chat-availability';
export function useManagedPush(policy: ChatPolicy | null, permissionGranted: boolean) {
  useEffect(() => {
    if (
      !policy?.enabled ||
      !policy.required ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      typeof Notification === 'undefined'
    )
      return;
    let disposed = false;
    let pending = false;
    async function register() {
      if (disposed || pending || Notification.permission !== 'granted') return;
      pending = true;
      try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        if (disposed) return;
        const { publicKey } = await api<{ publicKey: string }>('/v1/chat/conversations/push-key');
        const subscription =
          (await registration.pushManager.getSubscription()) ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: Uint8Array.from(
              atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')),
              (char) => char.charCodeAt(0),
            ),
          }));
        if (!disposed)
          await api('/v1/chat/conversations/push-subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
            body: JSON.stringify(subscription.toJSON()),
          });
      } catch {
        /* A browser permission or connectivity change is retried on focus. */
      } finally {
        pending = false;
      }
    }
    void register();
    window.addEventListener('focus', register);
    return () => {
      disposed = true;
      window.removeEventListener('focus', register);
    };
  }, [policy?.membershipId, policy?.enabled, policy?.required, permissionGranted]);
}
