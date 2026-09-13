'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button, SlideOver } from '@/components/ui';

/**
 * Order-change notifications (the owner feed from /v1/notifications).
 * "Read" is per browser: we remember the newest timestamp the user has
 * acknowledged and count anything newer as unread — the feed itself is
 * the audit log, which has no per-user read state.
 */
export interface NotificationRow {
  id: string;
  action: string;
  label: string;
  actorName: string | null;
  actorEmail: string | null;
  orderId: string | null;
  orderNumber: string | null;
  changesJson: unknown;
  createdAt: string;
}

const SEEN_KEY = 'jetnine.notifications.seenAt';

function readSeenAt(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function toneOf(action: string): 'danger' | 'warn' | 'info' {
  if (/cancel|refund|void|return\b|price_adjustment/.test(action)) return 'danger';
  if (/discount|override|remove|unlock|salesperson/.test(action)) return 'warn';
  return 'info';
}

export function detailOf(n: NotificationRow): string {
  const c = n.changesJson as {
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } | null;
  const src = c?.metadata ?? c?.after;
  if (!src || typeof src !== 'object') return '';
  const reason = src.reason ?? src.description ?? src.note;
  return typeof reason === 'string' ? reason : '';
}

/** Loads the feed once; exposes the unread count for the bell. */
export function useNotifications(enabled: boolean, identity: string) {
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const key = `${SEEN_KEY}:${identity}`;
  useEffect(() => {
    setRows(null);
    if (!enabled) return;
    const abort = new AbortController();
    setSeenAt(readSeenAt(key));
    void api<{ data: NotificationRow[] }>('/v1/notifications?limit=50', { signal: abort.signal })
      .then((r) => setRows(r.data))
      .catch(() => {
        if (!abort.signal.aborted) setRows(null);
      });
    return () => abort.abort();
  }, [enabled, key]);
  const unread = rows ? rows.filter((n) => !seenAt || n.createdAt > seenAt).length : 0;
  const markRead = useCallback(() => {
    const newest = rows?.[0]?.createdAt ?? new Date().toISOString();
    try {
      localStorage.setItem(key, newest);
    } catch {
      // ignore
    }
    setSeenAt(newest);
  }, [rows, key]);
  return { rows, unread, markRead };
}

export function NotificationsDrawer({
  rows,
  onClose,
  onMarkRead,
  onBack,
}: {
  rows: NotificationRow[] | null;
  onClose: () => void;
  onMarkRead: () => void;
  onBack?: () => void;
}) {
  const count = rows?.length ?? 0;
  return (
    <SlideOver
      title="Order changes"
      width={440}
      testId="notifications-drawer"
      onClose={onClose}
      meta={
        <>
          <span>{count} recent</span>
          {onBack && (
            <Button size="sm" variant="ghost" onClick={onBack}>
              ← My inbox
            </Button>
          )}
        </>
      }
      foot={
        <>
          <Button
            onClick={() => {
              onMarkRead();
              onClose();
              toast.success(`${count} notifications marked read`);
            }}
          >
            Mark all read
          </Button>
          <Link href="/audit" onClick={onClose} style={{ marginLeft: 'auto', fontSize: 12.5 }}>
            Audit log →
          </Link>
        </>
      }
    >
      <div style={{ margin: '-16px' }}>
        {rows == null && (
          <div style={{ padding: 18, color: 'var(--muted)', fontSize: 12.5 }}>
            Order changes are not available to your role.
          </div>
        )}
        {rows && rows.length === 0 && (
          <div style={{ padding: 18, color: 'var(--muted)', fontSize: 12.5 }}>
            No order changes recorded yet.
          </div>
        )}
        {rows?.map((n) => {
          const tone = toneOf(n.action);
          const dot =
            tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--info)';
          const body = (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dot,
                    flex: 'none',
                  }}
                />
                <span style={{ fontWeight: 500 }}>{n.label}</span>
                <span className="mono" style={{ color: 'var(--text2)' }}>
                  {n.orderNumber ?? ''}
                </span>
                <span
                  className="mono"
                  style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}
                >
                  {ago(n.createdAt)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, paddingLeft: 14 }}>
                {[detailOf(n), n.actorName ?? n.actorEmail ?? 'system'].filter(Boolean).join(' · ')}
              </div>
            </>
          );
          const style: React.CSSProperties = {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '10px 18px',
            border: 0,
            borderBottom: '1px solid var(--border)',
            background: 'transparent',
            color: 'inherit',
            textDecoration: 'none',
          };
          return n.orderId ? (
            <Link
              key={n.id}
              href={`/orders/${n.orderId}`}
              onClick={onClose}
              style={style}
              className="hover:bg-surface-2"
            >
              {body}
            </Link>
          ) : (
            <div key={n.id} style={style}>
              {body}
            </div>
          );
        })}
      </div>
    </SlideOver>
  );
}
