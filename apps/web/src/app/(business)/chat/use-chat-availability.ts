'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
export type ChatPolicy = {
  membershipId: string;
  enabled: boolean;
  required: boolean;
  allowAway: boolean;
  autoAvailable: boolean;
};
export function useChatAvailability() {
  const [available, setAvailable] = useState(false);
  const [capacity, setCapacity] = useState(5);
  const [policy, setPolicy] = useState<ChatPolicy | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef({ available, capacity });
  current.current = { available, capacity };
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_LIVE_CHAT_ENABLED !== 'true') return;
    let disposed = false;
    let initialized = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const state = await api<{
          requestedAvailable: boolean;
          available: boolean;
          capacity: number;
          policy: ChatPolicy;
        }>('/v1/chat/conversations/availability');
        if (disposed) return;
        setPolicy(state.policy);
        const takeChats =
          (!initialized && state.policy.autoAvailable) ||
          !state.policy.allowAway ||
          state.requestedAvailable;
        const nextCapacity = initialized ? current.current.capacity : state.capacity;
        if (takeChats)
          await api('/v1/chat/conversations/availability', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
            body: JSON.stringify({ available: true, capacity: nextCapacity }),
          });
        if (disposed) return;
        initialized = true;
        setAvailable(takeChats);
        setCapacity(nextCapacity);
        setStatus('');
      } catch {
        if (!disposed) setStatus('Chat availability is reconnecting…');
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 15000);
      }
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return {
    available,
    setAvailable,
    capacity,
    setCapacity,
    policy,
    status,
    setStatus,
    busy,
    setBusy,
  };
}
