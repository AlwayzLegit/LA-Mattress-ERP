'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { HANDOFF_EVENT, PICKUP_POSTED_EVENT, usdCents, varianceLabel } from './cash-pickups';
import { clockTime, docHref, plural, stamp } from './kit';
import type { HandoffRow, HandoffsResponse } from './types';

/**
 * Owner cash hand-off (owner 2026-09-30). A posted pickup means somebody
 * — usually Operations — carried the cash out of the store. Until the
 * owner ticks that it is in their hands, the pickup sits here, at the
 * top of the owner's home, grouped by who is holding it. A pickup the
 * owner posts themselves is received from the store on the spot and
 * never shows. Ticks made on this page stay in place (checked) so a
 * mis-tick can be undone; the panel clears on the next load.
 */

interface Group {
  key: string;
  name: string;
  rows: HandoffRow[];
  waitingCents: number;
  waitingCount: number;
}

export function CashHandoffs() {
  const [data, setData] = useState<HandoffsResponse | null | undefined>(undefined);
  /** Pickups ticked (or unticked) on this page, by id, kept visible until the next load. */
  const [touched, setTouched] = useState<Map<string, HandoffRow>>(new Map());
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    api<HandoffsResponse>('/v1/dashboard/cash-pickups/handoffs')
      .then(setData)
      .catch((err) => {
        // No permission (everyone but the owner) — the panel never shows.
        if (err instanceof ApiError && err.status === 403) setData(null);
        else setData((d) => (d === undefined ? null : d));
      });
  }, []);

  useEffect(() => {
    load();
    const onFocus = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(PICKUP_POSTED_EVENT, load);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(PICKUP_POSTED_EVENT, load);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const out = data.awaiting.map((r) => touched.get(r.id) ?? r);
    const seen = new Set(out.map((r) => r.id));
    for (const r of touched.values()) if (!seen.has(r.id)) out.push(r);
    return out.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }, [data, touched]);

  const groups = useMemo(() => {
    const by = new Map<string, Group>();
    for (const r of rows) {
      const key = r.recordedByMembershipId ?? `name:${r.byName}`;
      const g = by.get(key) ?? {
        key,
        name: r.byName,
        rows: [],
        waitingCents: 0,
        waitingCount: 0,
      };
      g.rows.push(r);
      if (!r.ownerReceipt) {
        g.waitingCents += r.countedCents;
        g.waitingCount += 1;
      }
      by.set(key, g);
    }
    return [...by.values()].sort(
      (a, b) => b.waitingCents - a.waitingCents || a.name.localeCompare(b.name),
    );
  }, [rows]);

  if (!data || rows.length === 0) return null;

  const waitingCents = groups.reduce((n, g) => n + g.waitingCents, 0);
  const waitingCount = groups.reduce((n, g) => n + g.waitingCount, 0);

  const settle = (updated: HandoffRow[]) => {
    setTouched((m) => {
      const next = new Map(m);
      for (const r of updated) next.set(r.id, r);
      return next;
    });
    window.dispatchEvent(new Event(HANDOFF_EVENT));
  };
  const withBusy = async (ids: string[], fn: () => Promise<void>) => {
    setBusy((b) => new Set([...b, ...ids]));
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };

  const toggle = (r: HandoffRow) =>
    withBusy([r.id], async () => {
      const updated = await api<HandoffRow>(`/v1/dashboard/cash-pickups/${r.id}/owner-received`, {
        method: r.ownerReceipt ? 'DELETE' : 'PUT',
      });
      settle([updated]);
      if (updated.ownerReceipt) {
        toast.success(`${r.number} · ${usdCents(r.countedCents)} received from ${r.byName}`);
      }
    });

  const receiveAll = (g: Group) => {
    const ids = g.rows.filter((r) => !r.ownerReceipt).map((r) => r.id);
    if (ids.length === 0) return;
    return withBusy(ids, async () => {
      const res = await api<{ rows: HandoffRow[] }>('/v1/dashboard/cash-pickups/owner-received', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickupIds: ids }),
      });
      settle(res.rows);
      toast.success(`${usdCents(g.waitingCents)} received from ${g.name}`);
    });
  };

  return (
    <section
      className={`panel panel-clip ho${waitingCount > 0 ? ' is-waiting' : ''}`}
      data-testid="cash-handoffs"
      aria-label="Cash handed to you"
    >
      <div className="panel-head">
        <h2>Cash handed to you</h2>
        <span className="panel-sub">
          {waitingCount > 0
            ? `${plural(waitingCount, 'pickup')} waiting — tick each once the cash is in your hands`
            : 'All received'}
        </span>
        <span className="cq-total">
          <span className="cq-total-amt mono" data-testid="ho-total">
            {usdCents(waitingCents)}
          </span>
          <span className="panel-sub">not yet with you</span>
        </span>
      </div>
      {groups.map((g) => (
        <div key={g.key} className="ho-group" data-testid="ho-group">
          <div className="ho-group-head">
            <span>
              <strong>{g.name}</strong>
              {g.waitingCount > 0 ? (
                <>
                  {' '}
                  picked up <span className="mono">{usdCents(g.waitingCents)}</span> in{' '}
                  {plural(g.waitingCount, 'pickup')}
                </>
              ) : (
                ' · everything received'
              )}
            </span>
            {g.waitingCount > 1 && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void receiveAll(g)}
                disabled={g.rows.some((r) => busy.has(r.id))}
                data-testid="ho-receive-all"
              >
                Received all from {g.name.split(' ')[0]}
              </button>
            )}
          </div>
          {g.rows.map((r) => {
            const got = r.ownerReceipt;
            const canUntick = !got || got.from === 'operator';
            return (
              <label
                key={r.id}
                className={`ho-row${got ? ' is-received' : ''}`}
                data-testid="ho-row"
                data-received={got ? 'true' : 'false'}
              >
                <input
                  type="checkbox"
                  checked={!!got}
                  disabled={busy.has(r.id) || !canUntick}
                  onChange={() => void toggle(r)}
                  style={{ accentColor: 'var(--accent)', width: 16, height: 16 }}
                  aria-label={`Received ${r.number} ${usdCents(r.countedCents)} from ${r.byName}`}
                />
                <span className="ho-row-main">
                  <span>
                    <span className="mono" style={{ fontWeight: 600 }}>
                      {r.number}
                    </span>{' '}
                    · {r.locationName} · picked up {stamp(r.recordedAt, r.timezone)}
                  </span>
                  <span className="ho-row-meta">
                    {plural(r.paymentCount, 'payment')}
                    {r.slip ? ` · slip ${r.slip}` : ''}
                    {r.varianceCents ? (
                      <span style={{ color: 'var(--status-risk-fg)' }}>
                        {' '}
                        · variance {varianceLabel(r.varianceCents)}
                      </span>
                    ) : null}
                    {r.items.length > 0 && ' · '}
                    {r.items.slice(0, 4).map((it, i) => (
                      <span key={it.paymentId}>
                        {i > 0 && ', '}
                        <Link href={docHref(it.docKind, it.docId)} className="mono">
                          {it.docNumber}
                        </Link>
                      </span>
                    ))}
                    {r.items.length > 4 && ` +${r.items.length - 4}`}
                  </span>
                </span>
                <span className="ho-row-status">
                  {got ? (
                    <span style={{ color: 'var(--status-fulfilled-fg)' }}>
                      ✓ Received {clockTime(got.receivedAt, r.timezone)}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--status-waiting-fg)' }}>
                      With {r.byName.split(' ')[0]}
                    </span>
                  )}
                </span>
                <span className="mono ho-row-amt">{usdCents(r.countedCents)}</span>
              </label>
            );
          })}
        </div>
      ))}
    </section>
  );
}
