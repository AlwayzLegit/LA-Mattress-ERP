'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl, api, ApiError } from '@/lib/api';
import { incomingConversations, incomingHandoffs, type LiveConversation } from './live-state';

import type { ChatPolicy } from './use-chat-availability';

export function useLiveChatEngine(policy: ChatPolicy | null) {
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const pathname = usePathname();
  const router = useRouter();
  const inInbox = useRef(pathname === '/chat');
  inInbox.current = pathname === '/chat';
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
  const chime = useRef<AudioBuffer | null>(null);
  const activeChime = useRef<AudioBufferSourceNode | null>(null);
  const loadingSound = useRef(false);
  const soundRef = useRef(false);
  const notificationRef = useRef(false);
  const beep = useCallback(() => {
    const context = audio.current;
    if (!policyRef.current?.enabled || !soundRef.current || !context || context.state !== 'running')
      return;
    if (!chime.current) return;
    activeChime.current?.stop();
    const source = context.createBufferSource();
    source.buffer = chime.current;
    source.connect(context.destination);
    activeChime.current = source;
    source.onended = () => {
      source.disconnect();
      if (activeChime.current === source) activeChime.current = null;
    };
    source.start();
  }, []);
  const notifyHelp = useCallback(() => {
    beep();
    if (
      policyRef.current?.enabled &&
      notificationRef.current &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      document.hidden
    ) {
      try {
        const alert = new Notification('LA Mattress · Team help', {
          body: 'A teammate help request needs your attention.',
          tag: 'la-mattress-team-help',
        });
        alert.onclick = () => {
          window.focus();
          router.push('/chat');
          alert.close();
        };
      } catch {
        /* In-app help alerts remain available when desktop delivery is blocked. */
      }
    }
  }, [beep, router]);
  const toggleSound = useCallback(async () => {
    if (!policyRef.current?.enabled) {
      setNotice('Notifications are disabled by your administrator.');
      return;
    }
    if (loadingSound.current) return;
    const key = `chat-sound:v1:${policyRef.current.membershipId}`;
    if (soundRef.current) {
      if (policyRef.current.required) {
        setNotice('Sound is required by your administrator.');
        return;
      }
      try {
        localStorage.setItem(key, 'off');
      } catch {}
      activeChime.current?.stop();
      soundRef.current = false;
      setSound(false);
      setNotice('Chat sounds muted.');
      return;
    }
    loadingSound.current = true;
    setNotice('Loading notification sound…');
    try {
      if (!audio.current || audio.current.state === 'closed') audio.current = new AudioContext();
      await audio.current.resume();
      if (!chime.current) {
        const response = await fetch('/sounds/shopify-sales.mp3');
        if (!response.ok) throw new Error('Sound could not be loaded');
        chime.current = await audio.current.decodeAudioData(await response.arrayBuffer());
      }
      soundRef.current = audio.current.state === 'running';
      setSound(soundRef.current);
      if (soundRef.current) {
        try {
          localStorage.setItem(key, 'on');
        } catch {}
      }
      setNotice(
        soundRef.current
          ? 'Sound is on. Incoming visitor messages will chime.'
          : 'Sound is blocked by this browser. Try again.',
      );
      beep();
    } catch {
      soundRef.current = false;
      setSound(false);
      setNotice('Could not load the notification sound. Try enabling sound again.');
    } finally {
      loadingSound.current = false;
    }
  }, [beep]);
  const toggleNotifications = useCallback(async () => {
    if (!policyRef.current?.enabled) {
      setNotice('Notifications are disabled by your administrator.');
      return;
    }
    if (notificationRef.current) {
      if (policyRef.current.required) {
        setNotice('Notifications are required by your administrator.');
        return;
      }
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
          ? 'Desktop alerts are on while the ERP stays open.'
          : 'Notifications are blocked. Allow them in your browser site settings.',
      );
    } catch {
      setNotice('This browser could not enable notifications.');
    }
  }, []);
  useEffect(() => {
    if (!policy?.enabled) {
      notificationRef.current = false;
      setNotifications(false);
      return;
    }
    if (policy.required && typeof Notification !== 'undefined') {
      notificationRef.current = Notification.permission === 'granted';
      setNotifications(notificationRef.current);
    }
    const resume = () => {
      if (audio.current?.state === 'suspended') void audio.current.resume().catch(() => {});
      if (soundRef.current || loadingSound.current) return;
      let allowed = false;
      try {
        allowed = localStorage.getItem(`chat-sound:v1:${policy.membershipId}`) === 'on';
      } catch {}
      if (allowed || policy.required) void toggleSound();
    };
    try {
      if (localStorage.getItem(`chat-sound:v1:${policy.membershipId}`) === 'on') resume();
    } catch {}
    // Browsers may require a fresh interaction after reload, even after initial permission.
    document.addEventListener('pointerdown', resume);
    document.addEventListener('keydown', resume);
    return () => {
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
    };
  }, [policy?.membershipId, policy?.enabled, policy?.required, toggleSound]);
  const handoffSound = useCallback(() => {
    const context = audio.current;
    if (!policyRef.current?.enabled || !soundRef.current || !context || context.state !== 'running')
      return;
    [660, 880, 660].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = context.currentTime + index * 0.2;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(at);
      oscillator.stop(at + 0.19);
    });
  }, []);
  const select = useCallback((id: string) => {
    setSelected(id);
    setUnread((old) => old.filter((value) => value !== id));
  }, []);
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_LIVE_CHAT_ENABLED !== 'true') return;
    let previous: Map<string, number> | null = null;
    let assignments = new Map<string, string | null>();
    let disposed = false;
    let revoked = false;
    let lastConnect = Date.now();
    let source: EventSource;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSnapshot = Date.now();
    let attempt = 0;
    function connect() {
      if (disposed || revoked) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      lastConnect = Date.now();
      source = new EventSource(`${apiUrl}/v1/chat/conversations/live`, {
        withCredentials: true,
      });
      const stream = source;
      source.addEventListener('snapshot', (event) => {
        if (disposed || revoked || source !== stream) return;
        const { conversations: rows } = JSON.parse((event as MessageEvent).data) as {
          conversations: LiveConversation[];
        };
        const passes = incomingHandoffs(assignments, rows);
        assignments = new Map(
          rows.map((row) => [row.id, row.assignedToMe ? (row.assignedAt ?? null) : null]),
        );
        if (passes.length) {
          setUnread((old) => [...new Set([...old, ...passes.map((row) => row.id)])]);
          setLatest('A chat was passed to you. Open it and accept to respond.');
          for (const row of passes) {
            if (!policyRef.current?.enabled || (!soundRef.current && !notificationRef.current))
              continue;
            try {
              const key = `chat-handoff:v1:${row.id}`;
              if (localStorage.getItem(key) === row.assignedAt) continue;
              localStorage.setItem(key, row.assignedAt!);
            } catch {}
            handoffSound();
            if (
              notificationRef.current &&
              typeof Notification !== 'undefined' &&
              Notification.permission === 'granted'
            ) {
              try {
                const alert = new Notification('LA Mattress · Chat passed to you', {
                  body: 'A teammate needs you to take over. Open the chat and accept.',
                  tag: `handoff-${row.id}`,
                });
                alert.onclick = () => {
                  window.focus();
                  select(row.id);
                  router.push('/chat');
                  alert.close();
                };
              } catch {}
            }
          }
        }
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
                (row) =>
                  !inInbox.current ||
                  row.id !== selectedRef.current ||
                  document.hidden ||
                  !document.hasFocus(),
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
          policyRef.current?.enabled &&
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
              router.push('/chat');
              notification.close();
            };
          } catch {
            setNotice('Desktop alerts are unavailable. The inbox still shows unread messages.');
          }
        }
      });
      const revoke = () => {
        revoked = true;
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
        if (disposed || revoked || source !== stream) return;
        source.close();
        // The API renews its authenticated SSE stream every 30 seconds.
        // A recent snapshot remains healthy during that brief renewal.
        if (Date.now() - lastSnapshot > 10000) setConnection('reconnecting');
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
      if (disposed || revoked || Date.now() - lastSnapshot <= 10000) return;
      setConnection('reconnecting');
      // A half-open stream can stop emitting without firing onerror.
      if (!reconnectTimer && Date.now() - lastConnect > 10000) {
        source.close();
        connect();
      }
    }, 3000);
    const onFocus = () => {
      if (inInbox.current && !document.hidden && selectedRef.current)
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
  }, [beep, handoffSound, select, router]);
  useEffect(() => {
    if (pathname !== '/chat') return;
    const oldTitle = document.title;
    document.title = unread.length
      ? `(${unread.length}) New chats - LA Mattress`
      : 'Live chat - LA Mattress';
    return () => {
      document.title = oldTitle;
    };
  }, [unread.length, pathname]);
  useEffect(
    () => () => {
      void audio.current?.close();
    },
    [],
  );
  return {
    notifyHelp,
    testHandoffSound: handoffSound,
    notificationsLocked: Boolean(policy?.enabled && policy.required),
    notificationsDisabled: !policy?.enabled,
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
