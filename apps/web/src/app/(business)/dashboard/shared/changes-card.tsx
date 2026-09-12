'use client';

import { rowKeys } from '@/components/ui';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Panel, ShimmerRows, StatusPill } from '../owner/owner-kit';
import { dayShort, readLocal, relTime, stamp, usdSigned, writeLocal } from './kit';
import type { ChangeRow, ChangesFilter, ChangesResponse } from './types';

/**
 * Screen 4 — the Changes card (hand-off 2026-09-10): every edit after
 * the order was written, full width, with a per-viewer seen tick on
 * anything that touched money. Rows open the order; the Seen cell does
 * not.
 */
const FILTER_KEY = 'jetnine.dashboard.changesFilter';

function impactKind(r: ChangeRow): string {
  if (r.impactCents == null) return 'no money change';
  if (r.impactCents > 0) return 'money in';
  if (r.impactCents < 0) return 'off the order';
  return 'tender moved';
}

export function ChangesCard({
  locationIds,
  handle,
  style,
}: {
  locationIds: string[] | null;
  handle?: ReactNode;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const [filter, setFilterState] = useState<ChangesFilter>('all');
  const [data, setData] = useState<ChangesResponse | null | undefined>(undefined);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  useEffect(() => {
    const f = readLocal<string>(FILTER_KEY, 'all');
    setFilterState(
      f === 'money' || f === 'unseen' || f === 'critical' || f === 'warning' ? f : 'all',
    );
  }, []);
  const setFilter = (f: ChangesFilter) => {
    setFilterState(f);
    writeLocal(FILTER_KEY, f);
  };

  const scopeKey = locationIds ? locationIds.join(',') : '';
  const load = useCallback(() => {
    const qs = new URLSearchParams({ filter: 'all', limit: '120' });
    if (scopeKey) qs.set('locationIds', scopeKey);
    return api<ChangesResponse>(`/v1/dashboard/changes?${qs.toString()}`)
      .then(setData)
      .catch(() => setData(null));
  }, [scopeKey]);
  useEffect(() => {
    void load();
  }, [load]);

  const patch = (id: string, seenAt: string | null) =>
    setData((d) =>
      d ? { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, seenAt } : r)) } : d,
    );

  const toggleSeen = async (r: ChangeRow) => {
    setBusy((b) => new Set(b).add(r.id));
    try {
      if (r.seenAt) {
        await api(`/v1/dashboard/changes/${r.id}/seen`, { method: 'DELETE' });
        patch(r.id, null);
      } else {
        const res = await api<{ seenAt: string }>(`/v1/dashboard/changes/${r.id}/seen`, {
          method: 'PUT',
        });
        patch(r.id, res.seenAt);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(r.id);
        return n;
      });
    }
  };

  const rows = data?.rows ?? [];
  const money = rows.filter((r) => r.moneyRelated);
  const unseen = money.filter((r) => !r.seenAt);
  // Severity (redesign Phase 9): critical = money off the order or a
  // refund (danger tone); warning = anything else that touched money or
  // was flagged (warn); the rest is information.
  const critical = rows.filter((r) => r.tone === 'danger');
  const warning = rows.filter((r) => r.tone === 'warn');
  const shown =
    filter === 'critical'
      ? critical
      : filter === 'warning'
        ? warning
        : filter === 'money'
          ? money
          : filter === 'unseen'
            ? unseen
            : rows;

  const markAllSeen = async () => {
    if (unseen.length === 0) return;
    try {
      await api('/v1/dashboard/changes/seen-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: unseen.map((r) => r.id) }),
      });
      toast.success(`${unseen.length} money change${unseen.length === 1 ? '' : 's'} marked seen`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (data === null) return null;

  return (
    <Panel
      title="Changes"
      sub="edits after the order was written"
      style={style}
      testid="changes-card"
      actions={
        <>
          <div className="seg" data-noprint="true">
            {(
              [
                ['all', 'All', rows.length],
                ['critical', 'Critical', critical.length],
                ['warning', 'Warning', warning.length],
                ['unseen', 'Unseen', unseen.length],
              ] as const
            ).map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                className={`seg-btn${filter === key ? ' is-active' : ''}`}
                onClick={() => setFilter(key)}
                data-testid={`changes-filter-${key}`}
              >
                {label} <span className="mono">{n}</span>
              </button>
            ))}
          </div>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              color: unseen.length > 0 ? 'var(--warn)' : 'var(--muted)',
            }}
            data-testid="changes-unseen-summary"
          >
            {data
              ? unseen.length > 0
                ? `${unseen.length} money change${unseen.length === 1 ? '' : 's'} unseen`
                : 'all money changes seen'
              : ''}
          </span>
          {unseen.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void markAllSeen()}
              data-noprint="true"
              data-testid="changes-mark-all"
            >
              Mark all seen
            </button>
          )}
          <Link href="/audit" className="panel-link" style={{ marginLeft: 0 }}>
            Audit log →
          </Link>
          {handle}
        </>
      }
    >
      {data === undefined ? (
        <ShimmerRows rows={5} />
      ) : shown.length === 0 ? (
        <div
          style={{
            padding: '28px var(--pad)',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 12.5,
          }}
        >
          {filter === 'unseen'
            ? 'Every money change has your tick. Nothing waiting.'
            : filter === 'critical' || filter === 'warning'
              ? 'No changes at this severity.'
              : 'No changes recorded for the selected stores.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="changes-table" data-testid="changes-table">
            <thead>
              <tr>
                <th style={{ width: 104, paddingLeft: 'var(--pad)' }}>Seen</th>
                <th style={{ width: 66 }}>When</th>
                <th style={{ width: 104 }}>Store</th>
                <th>Change</th>
                <th style={{ width: 146 }}>Order</th>
                <th style={{ width: 104, textAlign: 'right' }}>Money</th>
                <th style={{ width: 132, paddingRight: 'var(--pad)' }}>By</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const seen = !!r.seenAt;
                const cls = r.moneyRelated ? (seen ? ' is-seen' : ' is-unseen') : '';
                return (
                  <tr
                    {...rowKeys}
                    key={r.id}
                    className={`is-clickable${cls}`}
                    onClick={() => router.push(`/orders/${r.orderId}`)}
                    data-testid="changes-row"
                  >
                    <td style={{ paddingLeft: 'var(--pad)' }} onClick={(e) => e.stopPropagation()}>
                      {r.moneyRelated ? (
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={seen}
                            disabled={busy.has(r.id)}
                            onChange={() => void toggleSeen(r)}
                            style={{ accentColor: 'var(--accent)' }}
                            aria-label={seen ? 'Seen' : 'Mark seen'}
                          />
                          {r.seenAt && (
                            <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                              {stamp(r.seenAt)}
                            </span>
                          )}
                        </label>
                      ) : (
                        <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>no money</span>
                      )}
                    </td>
                    <td>
                      <div className="mono">{relTime(r.occurredAt)}</div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
                        {dayShort(r.occurredAt)}
                      </div>
                    </td>
                    <td style={{ color: 'var(--text2)' }}>{r.locationName}</td>
                    <td style={{ whiteSpace: 'normal' }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                      >
                        <StatusPill tone={r.tone}>{r.label}</StatusPill>
                        {r.was && (
                          <span style={{ color: 'var(--muted)', textDecoration: 'line-through' }}>
                            {r.was}
                          </span>
                        )}
                        {r.was && r.now && <span style={{ color: 'var(--faint)' }}>→</span>}
                        {r.now && <span style={{ fontWeight: 500 }}>{r.now}</span>}
                      </div>
                      {r.reason && (
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                          {r.reason}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="mono">{r.orderNumber}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {r.customerName ?? 'Walk-in'}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div
                        className="mono"
                        style={{
                          fontWeight: 600,
                          color:
                            r.impactCents == null
                              ? 'var(--faint)'
                              : r.impactCents < 0
                                ? 'var(--danger)'
                                : r.impactCents > 0
                                  ? 'var(--accent-ink)'
                                  : 'var(--text2)',
                        }}
                      >
                        {r.impactCents == null ? '—' : usdSigned(r.impactCents)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--faint)' }}>{impactKind(r)}</div>
                    </td>
                    <td style={{ paddingRight: 'var(--pad)' }}>
                      <div>{r.authorName}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.approval}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
