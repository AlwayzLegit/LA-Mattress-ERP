'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
export type TeamRoom = {
  id: string;
  kind: string;
  title: string;
  lastSequence: number;
  revision: number;
  unread: number;
  unreadSequence: number;
  mentioned: number;
  open: number;
  urgent: number;
};
export type TeamPerson = { id: string; name: string; available: boolean };
type Directory = {
  membershipId: string;
  rooms: TeamRoom[];
  people: TeamPerson[];
  locations: { id: string; name: string }[];
};
export function useTeamChat(enabled: boolean, notify: () => void) {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const active = useRef(enabled);
  active.current = enabled;
  const observed = useRef(new Map<string, number>());
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    if (!active.current || loading.current) return;
    loading.current = true;
    try {
      const result = await api<Directory>('/v1/chat/conversations/team/directory', {
        cache: 'no-store',
      });
      if (!active.current) return;
      if (
        result.rooms.some(
          (r) => r.unread > 0 && r.unreadSequence > (observed.current.get(r.id) ?? 0),
        )
      )
        notify();
      result.rooms.forEach((r) =>
        observed.current.set(r.id, Math.max(observed.current.get(r.id) ?? 0, r.unreadSequence)),
      );
      setDirectory(result);
      setError('');
    } catch (e) {
      if (!active.current) return;
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        setDirectory(null);
        setOpen(false);
        setRoomId(null);
      }
      setError('Team workspace unavailable. Retrying…');
    } finally {
      loading.current = false;
    }
  }, [notify]);
  useEffect(() => {
    if (!enabled) {
      setDirectory(null);
      setOpen(false);
      setRoomId(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(run, 5000);
    };
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, refresh]);
  return {
    directory,
    error,
    open,
    setOpen,
    roomId,
    setRoomId,
    refresh,
    unread: directory?.rooms.reduce((sum, r) => sum + r.unread, 0) ?? 0,
  };
}
