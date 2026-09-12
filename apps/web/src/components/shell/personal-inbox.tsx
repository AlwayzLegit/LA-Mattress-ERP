'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCheck, ClipboardList, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { InboxPage } from '@jetnine/shared';
import { api, ApiError } from '@/lib/api';
import { Button, LoadingRows, SlideOver } from '@/components/ui';
import { ago, NotificationsDrawer, type NotificationRow } from './notifications-drawer';

export function useTeamInbox(userId: string | undefined) {
  const pathname = usePathname();
  const [data, setData] = useState<InboxPage | null>(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [reading, setReading] = useState(false);
  const version = useRef(0);
  const identity = useRef('');
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  useEffect(() => {
    const current = ++version.current;
    const nextIdentity = `${userId ?? ''}:${pathname}`;
    if (identity.current !== nextIdentity) {
      setData(null);
      identity.current = nextIdentity;
    }
    setError('');
    if (!userId) return;
    const abort = new AbortController();
    void api<InboxPage>('/v1/inbox', { signal: abort.signal })
      .then((page) => {
        if (!abort.signal.aborted && current === version.current) setData(page);
      })
      .catch((e) => {
        if (!abort.signal.aborted && current === version.current)
          setError(
            e instanceof ApiError && e.status === 403
              ? 'Your role needs order access to use the team inbox.'
              : 'Unable to load your inbox. Try refreshing.',
          );
      });
    return () => abort.abort();
  }, [userId, pathname, refreshKey]);
  useEffect(() => {
    if (!userId) return;
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(tick, 30000);
    window.addEventListener('focus', tick);
    window.addEventListener('erp:team-update', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      window.removeEventListener('erp:team-update', tick);
    };
  }, [refresh, userId]);
  const markRead = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      setReading(true);
      try {
        await api('/v1/inbox/read', { method: 'POST', body: JSON.stringify({ ids }) });
        refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not mark updates read');
      } finally {
        setReading(false);
      }
    },
    [refresh],
  );
  return { data, unread: data?.unread ?? 0, error, refresh, markRead, reading };
}

export function PersonalInbox({
  inbox,
  ownerRows,
  onOwnerRead,
  onClose,
}: {
  inbox: ReturnType<typeof useTeamInbox>;
  ownerRows: NotificationRow[] | null;
  onOwnerRead: () => void;
  onClose: () => void;
}) {
  const [ownerFeed, setOwnerFeed] = useState(false);
  if (ownerFeed)
    return (
      <NotificationsDrawer
        rows={ownerRows}
        onClose={onClose}
        onMarkRead={onOwnerRead}
        onBack={() => setOwnerFeed(false)}
      />
    );
  const unreadIds = inbox.data?.data.filter((n) => !n.readAt).map((n) => n.id) ?? [];
  return (
    <SlideOver
      title="My inbox"
      width={440}
      testId="personal-inbox"
      onClose={onClose}
      meta={
        <>
          <span>
            Tasks and order updates for you{inbox.data ? ` · ${inbox.unread} unread` : ''}
          </span>
          <Button size="sm" variant="ghost" aria-label="Refresh inbox" onClick={inbox.refresh}>
            <RefreshCw size={14} />
          </Button>
        </>
      }
      foot={
        <>
          <Button
            size="sm"
            disabled={!unreadIds.length || inbox.reading}
            onClick={() => void inbox.markRead(unreadIds)}
          >
            <CheckCheck size={14} />
            {inbox.reading ? 'Saving…' : 'Mark shown updates read'}
          </Button>
          <span className="muted text-xs" style={{ marginLeft: 'auto' }}>
            Saved across devices
          </span>
        </>
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3 text-xs">
        <Link href="/tasks" onClick={onClose} className="flex items-center gap-1">
          <ClipboardList size={14} />
          Team Tasks
        </Link>
        {ownerRows && (
          <button
            type="button"
            className="text-secondary underline"
            onClick={() => setOwnerFeed(true)}
          >
            Owner order changes ({ownerRows.length})
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {inbox.error ? (
          <p role="alert" className="p-5 text-sm text-danger">
            {inbox.error}
          </p>
        ) : !inbox.data ? (
          <div className="p-5">
            <LoadingRows rows={4} what="Your inbox" onRetry={inbox.refresh} />
          </div>
        ) : inbox.data.data.length === 0 ? (
          <div className="p-8 text-center">
            <CheckCheck size={28} className="mx-auto mb-3 text-secondary" />
            <h3 className="font-semibold">You’re caught up</h3>
            <p className="muted mt-2 text-sm">
              New assignments, notes and related order updates will appear here. Add a task or
              notify a teammate from an order to get started.
            </p>
          </div>
        ) : (
          <ul>
            {inbox.data.data.map((n) => (
              <li
                key={n.id}
                className={`border-b border-border ${n.readAt ? '' : 'bg-surface-2'}`}
                data-testid="inbox-update"
              >
                <Link
                  // Tasks and notes live on the full order page; a plain
                  // order update opens the quick slide-over; a competition
                  // notice (no order) goes to the strip on the home.
                  href={
                    !n.orderId
                      ? '/dashboard'
                      : n.taskId
                        ? `/orders/${n.orderId}/full#team-tasks`
                        : n.noteId
                          ? `/orders/${n.orderId}/full#order-notes`
                          : `/orders/${n.orderId}`
                  }
                  className="block px-5 py-4 hover:bg-surface-2"
                  onClick={() => {
                    if (!n.readAt) void inbox.markRead([n.id]);
                    onClose();
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`}
                      aria-label={n.readAt ? 'Read' : 'Unread'}
                    />
                    <strong className="flex-1 text-sm">{n.title}</strong>
                    <time className="muted text-xs" dateTime={n.createdAt}>
                      {ago(n.createdAt)}
                    </time>
                  </div>
                  <div className="ml-4 mt-1 text-sm">{n.message}</div>
                  <p className="muted ml-4 mt-2 text-xs">
                    {n.orderId ? `${n.orderNumber} · Open order →` : 'Open the competition strip →'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SlideOver>
  );
}
