'use client';

import { StatusPill, usdWhole } from '../owner/owner-kit';
import { clockTime, dayAndTime, dayShort, plural, stamp, tenderMeta } from './kit';
import type { StoreCardData, StorePeriod } from './types';

/**
 * Screen 2 — one store's card (hand-off 2026-09-10): header with the
 * manager, selling count and cash pill; five-cell stat strip; and, when
 * expanded, the salesperson table beside money received by tender and
 * the cash pickup list with a tick per cash payment.
 */
export function StoreCard({
  card,
  period,
  open,
  onToggle,
  canTick,
  busy,
  onTick,
  onBulk,
  onOpenPayments,
}: {
  card: StoreCardData;
  period: StorePeriod;
  open: boolean;
  onToggle: () => void;
  canTick: boolean;
  /** Payment ids with a tick request in flight. */
  busy: Set<string>;
  onTick: (paymentId: string, received: boolean) => void;
  onBulk: (received: boolean) => void;
  onOpenPayments: (method: string) => void;
}) {
  const tz = card.timezone;
  const outstanding = card.cashPendingCents > 0;
  const allTicked = card.cashPaymentCount > 0 && card.cashReceivedCount === card.cashPaymentCount;
  const cashState =
    card.cashPaymentCount === 0
      ? 'no cash'
      : allTicked
        ? 'all cash picked up'
        : card.cashReceivedCount > 0
          ? `${card.cashReceivedCount} of ${card.cashPaymentCount} picked up`
          : 'awaiting pickup';
  const cashReceivedCents = card.cashTotalCents - card.cashPendingCents;
  const cashNote =
    card.cashPaymentCount === 0
      ? null
      : allTicked
        ? 'all picked up'
        : card.cashReceivedCount === 0
          ? 'none picked up'
          : `${usdWhole(cashReceivedCents)} received`;

  return (
    <section
      className="panel panel-clip"
      data-testid="store-card"
      data-location-id={card.locationId}
    >
      <div className="panel-head" style={{ gap: 10 }}>
        <h2 style={{ fontSize: 14 }}>{card.name}</h2>
        <span className="panel-sub">
          {card.manager ? `${card.manager.name} · manager · ` : ''}
          {card.sellingCount} selling
        </span>
        <StatusPill tone={outstanding ? 'warn' : 'ok'}>
          <span className="mono">
            {usdWhole(outstanding ? card.cashPendingCents : card.cashTotalCents)}
          </span>
          <span>{cashState}</span>
        </StatusPill>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={onToggle}
          data-testid="store-card-toggle"
        >
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </div>

      <div className="store-stats">
        <Stat
          label="Written"
          value={usdWhole(card.writtenCents)}
          sub={plural(card.writtenCount, 'order')}
        />
        <Stat
          label="Delivered"
          value={usdWhole(card.deliveredCents)}
          sub={plural(card.deliveredCount, 'order')}
        />
        <Stat label="Avg ticket" value={usdWhole(card.avgTicketCents)} />
        <Stat
          label="Money received"
          value={usdWhole(card.receivedCents)}
          sub={plural(card.receivedCount, 'payment')}
          color="var(--accent-ink)"
        />
        <Stat
          label="Cash awaiting pickup"
          value={usdWhole(card.cashPendingCents)}
          sub={card.cashPaymentCount > 0 ? `of ${usdWhole(card.cashTotalCents)}` : 'no cash'}
          color={outstanding ? 'var(--warn)' : 'var(--accent-ink)'}
        />
      </div>

      {open && (
        <div className="store-detail" data-testid="store-card-detail">
          <div style={{ minWidth: 0, overflowX: 'auto' }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Salesperson activity
            </div>
            {card.salespeople.length === 0 ? (
              <div style={{ padding: '20px 0', color: 'var(--muted)', fontSize: 12.5 }}>
                Nothing written at this store in the period.
              </div>
            ) : (
              <table className="store-table">
                <thead>
                  <tr>
                    <th>Salesperson</th>
                    <th className="num">Written</th>
                    <th className="num">Delivered</th>
                    <th className="num">Orders</th>
                    <th className="num">Avg ticket</th>
                    <th className="num">Collected</th>
                    <th className="num" style={{ paddingRight: 0 }}>
                      Last write-up
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {card.salespeople.map((s) => (
                    <tr key={s.membershipId} data-testid="store-salesperson">
                      <td style={{ fontWeight: s.isManager ? 600 : 400 }}>
                        {s.name}
                        {s.isManager && <span className="manager-badge">Manager</span>}
                      </td>
                      <td className="num">{usdWhole(s.writtenCents)}</td>
                      <td className="num" style={{ color: 'var(--text2)' }}>
                        {usdWhole(s.deliveredCents)}
                      </td>
                      <td className="num" style={{ color: 'var(--muted)' }}>
                        {s.orders}
                      </td>
                      <td className="num" style={{ color: 'var(--muted)' }}>
                        {usdWhole(s.avgTicketCents)}
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
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Money received · click for payments
            </div>
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
                    data-testid={`tender-${t.method}`}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span className="tender-swatch" style={{ background: meta.swatch }} />
                      {meta.label}
                      {!empty && (
                        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--faint)' }}>
                          {plural(t.count, 'payment')}
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--accent-ink)' }}>
                      {t.method === 'cash' && cashNote}
                    </span>
                    <span className="mono" style={{ color: empty ? 'var(--faint)' : undefined }}>
                      {empty ? '—' : usdWhole(t.cents)}
                    </span>
                  </button>
                );
              })}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '9px 6px 0',
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                <span>Total received</span>
                <span className="mono">{usdWhole(card.receivedCents)}</span>
              </div>
              {card.refundsCents > 0 && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '4px 6px 0',
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ color: 'var(--muted)' }}>Refunds paid out</span>
                  <span className="mono" style={{ color: 'var(--danger)' }}>
                    {usdWhole(card.refundsCents)}
                  </span>
                </div>
              )}
            </div>

            <div
              className={`pickup-box${outstanding ? ' is-outstanding' : ''}`}
              data-testid="cash-pickup"
            >
              <div className="pickup-head">
                <span className="eyebrow">Cash pickup</span>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {usdWhole(card.cashTotalCents)}
                </span>
                {canTick && card.cashPaymentCount > 0 && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => onBulk(!allTicked)}
                    data-testid="cash-pickup-bulk"
                  >
                    {allTicked ? 'Clear all ticks' : 'Mark all received'}
                  </button>
                )}
              </div>
              {card.cashPayments.length === 0 ? (
                <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--muted)' }}>
                  No cash taken this period.
                </div>
              ) : (
                card.cashPayments.map((p) => {
                  const done = !!p.receipt;
                  return (
                    <label
                      key={p.paymentId}
                      className={`pickup-row${done ? ' is-received' : ''}`}
                      data-testid="cash-pickup-row"
                      style={{ cursor: canTick ? 'pointer' : 'default' }}
                    >
                      <input
                        type="checkbox"
                        checked={done}
                        disabled={!canTick || busy.has(p.paymentId)}
                        onChange={(e) => onTick(p.paymentId, e.target.checked)}
                        style={{ accentColor: 'var(--accent)', width: 15, height: 15 }}
                        aria-label={`${p.docNumber} cash ${done ? 'received' : 'awaiting pickup'}`}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span className="mono">{p.docNumber}</span>
                        <span style={{ color: 'var(--muted)' }}>
                          {' '}
                          · sold {dayShort(p.soldAt, tz)}
                        </span>
                        <div className="pickup-meta">
                          {p.receipt
                            ? `Received ${stamp(p.receipt.receivedAt, tz)} · ${p.receipt.byName}${p.receipt.byRole ? ` (${p.receipt.byRole})` : ''}`
                            : `${p.kind}${p.customerName ? ` · ${p.customerName}` : ''} · awaiting pickup`}
                        </div>
                      </span>
                      <span className="pickup-amount">{usdWhole(p.amountCents)}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="store-stat">
      <div className="store-stat-label">{label}</div>
      <div className="store-stat-value" style={{ color }}>
        <span>{value}</span>
        {sub && <span className="store-stat-sub">{sub}</span>}
      </div>
    </div>
  );
}
