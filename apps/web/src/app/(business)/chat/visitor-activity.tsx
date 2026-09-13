'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import styles from './chat.module.css';

type Activity = {
  context: { currentPage?: { path: string; title: string; seenAt: string } | null } | null;
  sharedDraft?: { text: string; expiresAt: number } | null;
};

export function useVisitorActivity(id: string, version?: number) {
  const [snapshot, setSnapshot] = useState<{ id: string; data: Activity } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const data = await api<Activity>(`/v1/chat/conversations/${id}/context`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!cancelled) {
          setSnapshot({ id, data });
          setUnavailable(false);
        }
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    const expiry = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(expiry);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [id, version]);
  const data = snapshot?.id === id ? snapshot.data : null;
  return {
    page: data?.context?.currentPage,
    draft: data?.sharedDraft && data.sharedDraft.expiresAt > now ? data.sharedDraft : null,
    unavailable,
    loading: !data && !unavailable,
  };
}

export function VisitorPage({ activity }: { activity: ReturnType<typeof useVisitorActivity> }) {
  const page = activity.page;
  const safePage = page && /^\/(?:$|(?:products|collections|pages|blogs)\/[a-zA-Z0-9/_-]+$|sleep-quiz\/?$)/.test(page.path);
  return (
    <div className={styles.pageStrip} aria-label="Visitor’s latest page">
      <span className={styles.activityLabel}>VISITOR’S PAGE</span>
      {safePage ? (
        <>
          <a href={`https://www.mattressstoreslosangeles.com${page.path}`} target="_blank" rel="noopener noreferrer" title={page.path}>
            {page.title || page.path} <span aria-hidden="true">↗</span>
          </a>
          <small>Last seen {new Date(page.seenAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>
        </>
      ) : <span>{activity.loading ? 'Connecting to visitor…' : 'No public page shared'}</span>}
      {activity.unavailable && <small role="status">Reconnecting to visitor activity…</small>}
    </div>
  );
}

export function VisitorDraft({ activity, assigned, typing }: {
  activity: ReturnType<typeof useVisitorActivity>; assigned: boolean; typing: boolean;
}) {
  const draft = assigned ? activity.draft : null;
  return (
    <section className={styles.liveDraft} data-active={Boolean(draft)} aria-label="Visitor draft preview" data-sentry-mask>
      <div className={styles.draftHeading}>
        <strong><span className={styles.draftDot} aria-hidden="true" />{draft ? 'Visitor is composing' : typing ? 'Visitor is typing' : 'Visitor draft preview'}</strong>
        <span>{draft ? 'UNSENT · SHARED WITH PERMISSION' : 'UNSENT'}</span>
      </div>
      {draft ? <p className={styles.draftText}>{draft.text}</p> : (
        <p className={styles.draftHint}>{!assigned ? 'Accept this chat to see drafts the visitor chooses to share.' : activity.unavailable ? 'Preview is temporarily unavailable. You can still reply.' : 'Opted-in drafts appear here while the visitor types.'}</p>
      )}
      {draft && <small>Still being edited. This is not a sent message.</small>}
    </section>
  );
}
