'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl, api, ApiError } from '@/lib/api';
import { incomingConversations, type LiveConversation } from './live-state';

export function useLiveChat() {
  const [conversations, setConversations] = useState<LiveConversation[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'denied'>(
    'connecting',
  );
  const [unread, setUnread] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [sound, setSound] = useState(false);
  const [notice, setNotice] = useState('Enable sound to hear incoming chats.');
  const [notifications, setNotifications] = useState(false);
  const [latest, setLatest] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const audio = useRef<AudioContext | null>(null);
  const soundRef = useRef(false);
  const notificationRef = useRef(false);
  const beep = useCallback(() => {
    const context = audio.current;
    if (!soundRef.current || !context || context.state !== 'running') return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.frequency.setValueAtTime(740, context.currentTime);
    oscillator.frequency.setValueAtTime(990, context.currentTime + 0.13);
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.4);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.42);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }, []);
  const toggleSound = useCallback(async () => {
    if (soundRef.current) {
      soundRef.current = false;
      setSound(false);
      setNotice('Chat sounds muted.');
      return;
    }
    try {
      if (!audio.current || audio.current.state === 'closed') audio.current = new AudioContext();
      await audio.current.resume();
      soundRef.current = audio.current.state === 'running';
      setSound(soundRef.current);
      setNotice(
        soundRef.current
          ? 'Sound is on. Incoming visitor messages will chime.'
          : 'Sound is blocked by this browser. Try again.',
      );
      beep();
    } catch {
      setNotice('Sound is unavailable in this browser.');
    }
  }, [beep]);
  const toggleNotifications = useCallback(async () => {
    if (notificationRef.current) {
      notificationRef.current = false;
      setNotifications(false);
      return;
    }
    if (!('Notification' in window)) {
      setNotice('Desktop notifications are unavailable in this browser.');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      notificationRef.current = permission === 'granted';
      setNotifications(notificationRef.current);
      setNotice(
        permission === 'granted'
          ? 'Desktop alerts are on while this inbox stays open.'
          : 'Notifications are blocked. Allow them in your browser site settings.',
      );
    } catch {
      setNotice('This browser could not enable notifications.');
    }
  }, []);
  const select = useCallback((id: string) => {
    setSelected(id);
    setUnread((old) => old.filter((value) => value !== id));
  }, []);
  useEffect(() => {
    let previous: Map<string, number> | null = null;
    let disposed = false;
    let source: EventSource;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSnapshot = Date.now();
    let attempt = 0;
    function connect() {
      if (disposed) return;
      source = new EventSource(`${apiUrl}/v1/chat/conversations/live`, {
        withCredentials: true,
      });
      source.addEventListener('snapshot', (event) => {
        const { conversations: rows } = JSON.parse((event as MessageEvent).data) as {
          conversations: LiveConversation[];
        };
        const incoming = incomingConversations(previous, rows);
        previous = new Map(rows.map((row) => [row.id, row.visitorSequence]));
        lastSnapshot = Date.now();
        attempt = 0;
        setConnection('live');
        setConversations([...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        if (!incoming.length) return;
        setLatest(
          `${incoming.length === 1 ? 'New visitor message' : 'New visitor messages'} just arrived.`,
        );
        setUnread((old) => [
          ...new Set([
            ...old,
            ...incoming
              .filter(
                (row) => row.id !== selectedRef.current || document.hidden || !document.hasFocus(),
              )
              .map((row) => row.id),
          ]),
        ]);
        // Share the latest alerted sequence with other tabs without storing chat content.
        if (!soundRef.current && !notificationRef.current) return;
        const fresh = incoming.filter((row) => {
          try {
            const key = `chat-alert:v1:${row.id}`;
            if (Number(localStorage.getItem(key) ?? 0) >= row.visitorSequence) return false;
            localStorage.setItem(key, String(row.visitorSequence));
          } catch {
            /* Storage can be disabled; in-tab watermark still deduplicates. */
          }
          return true;
        });
        if (!fresh.length) return;
        beep();
        if (
          notificationRef.current &&
          Notification.permission === 'granted' &&
          (document.hidden || !document.hasFocus())
        ) {
          try {
            const notification = new Notification('LA Mattress - New chat message', {
              body: 'A website visitor is waiting. Open the inbox to reply.',
              tag: 'la-mattress-chat',
            });
            notification.onclick = () => {
              window.focus();
              select(fresh[0]!.id);
              notification.close();
            };
          } catch {
            setNotice('Desktop alerts are unavailable. The inbox still shows unread messages.');
          }
        }
      });
      const revoke = () => {
        source.close();
        clearTimeout(reconnectTimer);
        setConnection('denied');
        setConversations([]);
        setUnread([]);
        setSelected(null);
        setNotice('Sign in and choose a business with chat access to reconnect.');
      };
      source.addEventListener('access-revoked', revoke);
      source.addEventListener('unavailable', () => setConnection('reconnecting'));
      source.onerror = () => {
        source.close();
        setConnection('reconnecting');
        reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000));
        void api('/v1/chat/conversations?limit=1', { cache: 'no-store' }).catch(
          (error: unknown) => {
            if (!disposed && error instanceof ApiError && [401, 403, 412].includes(error.status))
              revoke();
          },
        );
      };
    }
    connect();
    const timer = setInterval(() => {
      if (source.readyState !== EventSource.CLOSED && Date.now() - lastSnapshot > 10000)
        setConnection('reconnecting');
    }, 3000);
    const onFocus = () => {
      if (!document.hidden && selectedRef.current)
        setUnread((old) => old.filter((id) => id !== selectedRef.current));
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      disposed = true;
      source.close();
      clearInterval(timer);
      clearTimeout(reconnectTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [beep, select]);
  useEffect(() => {
    const oldTitle = document.title;
    document.title = unread.length
      ? `(${unread.length}) New chats - LA Mattress`
      : 'Live chat - LA Mattress';
    return () => {
      document.title = oldTitle;
    };
  }, [unread.length]);
  useEffect(
    () => () => {
      void audio.current?.close();
    },
    [],
  );
  return {
    conversations,
    connection,
    unread,
    selected,
    select,
    sound,
    toggleSound,
    notifications,
    toggleNotifications,
    notice,
    latest,
  };
}
