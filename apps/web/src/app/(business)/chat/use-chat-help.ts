'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
export type HelpRequest = {
  id: string;
  conversationId: string;
  question: string;
  status: string;
  version: number;
  incoming: boolean;
  requesterName: string;
  helperName: string;
  updatedAt: string;
};
export function useChatHelp(enabled: boolean, notify: () => void) {
  const [requests, setRequests] = useState<HelpRequest[]>([]);
  const [error, setError] = useState('');
  const active = useRef(enabled);
  active.current = enabled;
  const previous = useRef<Map<string, number>>(new Map());
  const refresh = useCallback(async () => {
    if (!active.current) return;
    try {
      const rows = await api<HelpRequest[]>('/v1/chat/conversations/help-inbox', {
        cache: 'no-store',
      });
      if (!active.current) return;
      if (
        rows.some(
          (row) =>
            (row.incoming && row.status === 'requested' && !previous.current.has(row.id)) ||
            (!row.incoming &&
              ['accepted', 'finished'].includes(row.status) &&
              previous.current.has(row.id) &&
              previous.current.get(row.id) !== row.version),
        )
      )
        notify();
      previous.current = new Map(rows.map((row) => [row.id, row.version]));
      setRequests(rows);
      setError('');
    } catch (e) {
      if (!active.current) return;
      if (e instanceof ApiError && [401, 403].includes(e.status)) setRequests([]);
      setError('Team help is unavailable. Retrying…');
    }
  }, [notify]);
  useEffect(() => {
    if (!enabled) {
      setRequests([]);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(run, 3000);
    };
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, refresh]);
  return { requests, error, refresh };
}
