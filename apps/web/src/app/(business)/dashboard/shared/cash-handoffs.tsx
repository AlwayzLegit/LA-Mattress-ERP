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
 * top of the owner's home. A pickup the owner posts themselves is
 * received from the store on the spot and never shows. Ticks made on
 * this page stay in place (checked) so a mis-tick can be undone; the
 * panel clears on the next load.
 *
 * Owner 2026-10-29: one tick per pickup, with who holds it on the row —
 * no grouping by runner and no "Received all" button. Each envelope is
 * counted into the owner's hands on its own. The list is sectioned by
 * store, oldest pickup first within each, and every payment on a pickup
 * has its own tick; the pickup reads as received once all are ticked.
 */

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

  const stores = useMemo(() => {
    const by = new Map<string, { id: string; name: string; rows: HandoffRow[] }>();
    for (const r of rows) {
      const g = by.get(r.locationId) ?? { id: r.locationId, name: r.locationName, rows: [] };
      g.rows.push(r);
      by.set(r.locationId, g);
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  if (!data || rows.length === 0) return null;

  const waiting = rows.filter((r) => !r.ownerReceipt);
  const waitingCents = waiting.reduce((n, r) => n + r.countedCents, 0);
  const waitingCount = waiting.length;

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

  // Owner 2026-10-29: one tick per payment. The pickup closes on its own
  // once every payment on it is ticked.
  const toggleItem = (r: HandoffRow, paymentId: string, received: boolean) =>
    withBusy([r.id], async () => {
      const updated = await api<HandoffRow>(
        `/v1/dashboard/cash-pickups/${r.id}/items/${paymentId}/owner-received`,
        { method: received ? 'DELETE' : 'PUT' },
      );
      settle([updated]);
      if (updated.ownerReceipt && !r.ownerReceipt) {
        toast.success(`${r.number} · ${usdCents(r.countedCents)} received from ${r.byName}`);
      }
    });

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
      {stores.map((store) => {
        const open = store.rows.filter((r) => !r.ownerReceipt);
        return (
          <div key={store.id} className="ho-group" data-testid="ho-store">
            <div className="ho-group-head">
              <span>
                <strong>{store.name}</strong>
                {open.length > 0 ? (
                  <>
                    {' '}
                    <span className="mono">
                      {usdCents(open.reduce((n, r) => n + r.countedCents, 0))}
                    </span>{' '}
                    in {plural(open.length, 'pickup')}
                  </>
                ) : (
                  ' · everything received'
                )}
              </span>
            </div>
            {store.rows.map((r) => {
              const got = r.ownerReceipt;
              const canUntick = !got || got.from === 'operator';
              const ticked = r.items.filter((it) => it.ownerReceivedAt).length;
              return (
                <div
                  key={r.id}
                  className={`ho-pickup${got ? ' is-received' : ''}`}
                  data-testid="ho-row"
                  data-received={got ? 'true' : 'false'}
                >
                  <div className="ho-pickup-head">
                    <span className="ho-row-main">
                      <span>
                        <span className="mono" style={{ fontWeight: 600 }}>
                          {r.number}
                        </span>{' '}
                        · picked up {stamp(r.recordedAt, r.timezone)}
                        {r.slip ? ` · slip ${r.slip}` : ''}
                        {r.varianceCents ? (
                          <span style={{ color: 'var(--status-risk-fg)' }}>
                            {' '}
                            · variance {varianceLabel(r.varianceCents)}
                          </span>
                        ) : null}
                      </span>
                      <span className="ho-row-meta">
                        {ticked} of {plural(r.items.length, 'payment')} received
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
                  </div>
                  {r.items.map((it) => {
                    const itGot = Boolean(it.ownerReceivedAt);
                    return (
                      <label
                        key={it.paymentId}
                        className={`ho-row ho-item${itGot ? ' is-received' : ''}`}
                        data-testid="ho-item"
                        data-received={itGot ? 'true' : 'false'}
                      >
                        <input
                          type="checkbox"
                          checked={itGot}
                          disabled={busy.has(r.id) || !canUntick}
                          onChange={() => void toggleItem(r, it.paymentId, itGot)}
                          style={{ accentColor: 'var(--accent)', width: 16, height: 16 }}
                          aria-label={`Received ${it.docNumber} ${usdCents(it.amountCents)} from ${r.byName}`}
                        />
                        <span className="ho-row-main">
                          <span>
                            <Link href={docHref(it.docKind, it.docId)} className="mono">
                              {it.docNumber}
                            </Link>
                          </span>
                        </span>
                        <span className="ho-row-status">
                          {itGot ? (
                            <span style={{ color: 'var(--status-fulfilled-fg)' }}>
                              ✓ Received {clockTime(it.ownerReceivedAt!, r.timezone)}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--status-waiting-fg)' }}>
                              With {r.byName.split(' ')[0]}
                            </span>
                          )}
                        </span>
                        <span className="mono ho-row-amt">{usdCents(it.amountCents)}</span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
