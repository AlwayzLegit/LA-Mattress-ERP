'use client';

import { usdWhole } from '../owner/owner-kit';
import { CashOnHandPanel, type CashPickupsApi } from './cash-pickups';
import { clockTime, dayAndTime, plural, tenderMeta } from './kit';
import type { StoreCardData, StorePeriod } from './types';

/**
 * One store's card (redesign Phase 9, canvas 8 "Stores"): a header with
 * the manager and salesperson count on the left and Written · Delivered
 * · Received · Refunds on the right; then three columns — the
 * salespeople table, money received by method (each row opens the
 * payment list), and cash on hand with the tick list and the Record →
 * Post pickup flow.
 */
export function StoreCard({
  card,
  period,
  open,
  onToggle,
  onOpenPayments,
  cp,
  actorName,
}: {
  card: StoreCardData;
  period: StorePeriod;
  open: boolean;
  onToggle: () => void;
  onOpenPayments: (method: string) => void;
  cp: CashPickupsApi;
  actorName?: string | null;
}) {
  const tz = card.timezone;
  const reps = card.salespeople;

  return (
    <section
      className="panel panel-clip sc"
      data-testid="store-card"
      data-location-id={card.locationId}
      id={`store-${card.locationId}`}
    >
      <div className="sc-head">
        <h3 className="sc-name">{card.name}</h3>
        <span className="sc-sub">
          {card.manager ? `${card.manager.name} · ` : ''}
          {plural(Math.max(card.sellingCount, reps.length), 'salesperson', 'salespeople')}
        </span>
        <div className="sc-figs" data-testid="store-figs">
          <Fig label="Written" value={usdWhole(card.writtenCents)} strong />
          <Fig
            label="Delivered"
            value={card.deliveredCents ? usdWhole(card.deliveredCents) : '—'}
            muted={!card.deliveredCents}
          />
          <Fig label="Received" value={usdWhole(card.receivedCents)} />
          <Fig
            label="Refunds"
            value={card.refundsCents ? `−${usdWhole(card.refundsCents)}` : '—'}
            danger={card.refundsCents > 0}
            muted={!card.refundsCents}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onToggle}
          data-testid="store-card-toggle"
        >
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </div>

      {open && (
        <div className="sc-body" data-testid="store-card-detail">
          <div className="sc-col" style={{ minWidth: 0, overflowX: 'auto' }}>
            <div className="eyebrow sc-col-title">Salespeople</div>
            {reps.length === 0 ? (
              <div className="sc-empty">Nothing written at this store in the period.</div>
            ) : (
              <table className="store-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Written</th>
                    <th className="num">Orders</th>
                    <th className="num">Avg</th>
                    <th className="num">Collected</th>
                    <th className="num" style={{ paddingRight: 0 }}>
                      Last sale
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {reps.map((s) => (
                    <tr key={s.membershipId} data-testid="store-salesperson">
                      <td style={{ fontWeight: s.isManager ? 600 : 400 }}>
                        {s.name}
                        {s.isManager && <span className="manager-badge">Manager</span>}
                      </td>
                      <td className="num">{usdWhole(s.writtenCents)}</td>
                      <td className="num" style={{ color: 'var(--muted)' }}>
                        {s.orders}
                      </td>
                      <td className="num" style={{ color: 'var(--muted)' }}>
                        {s.orders ? usdWhole(s.avgTicketCents) : '—'}
                      </td>
                      <td className="num">{usdWhole(s.collectedCents)}</td>
                      <td
                        className="num"
                        style={{ paddingRight: 0, fontSize: 11.5, color: 'var(--muted)' }}
                      >
                        {s.lastWriteUpAt
                          ? period === 'today'
                            ? clockTime(s.lastWriteUpAt, tz)
                            : dayAndTime(s.lastWriteUpAt, tz)
                          : 'no sales'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="sc-col" style={{ minWidth: 0 }}>
            <div className="eyebrow sc-col-title">Money received · by method</div>
            <div data-testid="store-tenders">
              {card.tenders.map((t) => {
                const meta = tenderMeta(t.method);
                const empty = t.cents === 0 && t.count === 0;
                return (
                  <button
                    key={t.method}
                    type="button"
                    className="tender-row"
                    disabled={empty}
                    onClick={() => onOpenPayments(t.method)}
                    title={empty ? undefined : 'Show the payments'}
                    data-testid={`tender-${t.method}`}
                  >
                    <span style={{ minWidth: 0, color: empty ? 'var(--muted)' : undefined }}>
                      <span className="tender-swatch" style={{ background: meta.swatch }} />
                      {meta.label}
                      {!empty && <span className="tender-count"> · {t.count}</span>}
                    </span>
                    <span />
                    <span className="mono" style={{ color: empty ? 'var(--faint)' : undefined }}>
                      {empty ? '—' : usdWhole(t.cents)}
                    </span>
                  </button>
                );
              })}
              <div className="sc-total">
                <span>Total received</span>
                <span className="mono">{usdWhole(card.receivedCents)}</span>
              </div>
              {card.refundsCents > 0 && (
                <div className="sc-total is-refund">
                  <span>Refunds paid out</span>
                  <span className="mono">−{usdWhole(card.refundsCents)}</span>
                </div>
              )}
            </div>
          </div>

          <div className="sc-col" style={{ minWidth: 0 }}>
            <CashOnHandPanel cp={cp} locationId={card.locationId} actorName={actorName} />
          </div>
        </div>
      )}
    </section>
  );
}

function Fig({
  label,
  value,
  strong,
  danger,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  danger?: boolean;
  muted?: boolean;
}) {
  return (
    <span className="sc-fig">
      <span className="sc-fig-label">{label}</span>
      <span
        className={`sc-fig-value mono${strong ? ' is-strong' : ''}`}
        style={{ color: danger ? 'var(--status-risk-fg)' : muted ? 'var(--faint)' : undefined }}
      >
        {value}
      </span>
    </span>
  );
}
