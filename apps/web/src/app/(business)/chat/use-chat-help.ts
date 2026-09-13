'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
export type HelpRequest = {
  id: string;
  conversationId: string;
  question: string;
  status: string;
  version: number;
  unread: number;
  mentioned: boolean;
  unreadSequence: number;
  incoming: boolean;
  requesterName: string;
  helperName: string;
  updatedAt: string;
};
export function useChatHelp(enabled: boolean, notify: () => void) {
  const [requests, setRequests] = useState<HelpRequest[]>([]);
  const [error, setError] = useState('');
  const [suggestion, setSuggestion] = useState<{ conversationId: string; body: string } | null>(
    null,
  );
  const lastMessage = useRef(new Map<string, number>());
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
            (row.unread > 0 && row.unreadSequence > (lastMessage.current.get(row.id) ?? 0)) ||
            (row.incoming && row.status === 'requested' && !previous.current.has(row.id)) ||
            (!row.incoming &&
              ['accepted', 'finished'].includes(row.status) &&
              previous.current.has(row.id) &&
              previous.current.get(row.id) !== row.version),
        )
      )
        notify();
      rows.forEach((row) =>
        lastMessage.current.set(
          row.id,
          Math.max(lastMessage.current.get(row.id) ?? 0, row.unreadSequence),
        ),
      );
      previous.current = new Map(rows.map((row) => [row.id, row.version]));
      setRequests(rows);
      setError('');
    } catch (e) {
      if (!active.current) return;
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        setRequests([]);
        setSuggestion(null);
      }
      setError('Team help is unavailable. Retrying…');
    }
  }, [notify]);
  useEffect(() => {
    if (!enabled) {
      setRequests([]);
      setSuggestion(null);
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
  return { requests, error, refresh, suggestion, setSuggestion };
}
