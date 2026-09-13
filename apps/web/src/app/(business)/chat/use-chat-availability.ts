'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
export function useChatAvailability() {
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
  return { available, setAvailable, capacity, setCapacity, status, setStatus, busy, setBusy };
}
