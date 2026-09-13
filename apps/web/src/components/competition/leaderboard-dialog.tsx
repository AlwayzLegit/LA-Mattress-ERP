'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Dialog } from '@/components/ui';
import { api } from '@/lib/api';
import { ShimmerRows } from '@/app/(business)/dashboard/owner/owner-kit';
import {
  usdWholeCents,
  type CompetitionBoard,
  type HistoryRow,
  type RaceCard,
  type RaceRow,
} from './types';

/**
 * The leaderboard (README §3.6): everyone who competes — the ranked rows
 * first, then the people the race cannot rank yet with no number — a
 * month sparkline per row, the secondary number, your row tinted, and the
 * orders behind the focused number on the right. History lists past
 * months with the winner, your rank and the payout.
 */
export function LeaderboardDialog({
  board,
  card,
  initialTab = 'month',
  onClose,
}: {
  board: CompetitionBoard;
  card: RaceCard;
  initialTab?: 'month' | 'history';
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'month' | 'history'>(initialTab);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  useEffect(() => {
    if (tab !== 'history' || history) return;
    api<HistoryRow[]>('/v1/competitions/history')
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [tab, history]);

  const focus: RaceRow | null = card.rows.find((r) => r.isYou) ?? card.top[0] ?? null;
  const focusName = focus ? (focus.isYou ? 'you' : firstName(focus.name)) : '—';
  const sparkMax = Math.max(1, ...card.rows.flatMap((r) => r.spark));

  return (
    <Dialog
      title={card.title}
      description={
        <span className="lb-sub">
          People · {board.monthLabel} ·{' '}
          {board.daysLeft === 0 ? 'ends tonight' : `${board.daysLeft} days left`}{' '}
          <span className="mono lb-prize">{usdWholeCents(card.prizeCents)} to first</span>
        </span>
      }
      onClose={onClose}
      size="lg"
      testId="leaderboard-dialog"
      className="lb"
    >
      <div className="lb-tabs" role="tablist" aria-label="Leaderboard tabs">
        <div className="seg">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'month'}
            className={`seg-btn${tab === 'month' ? ' is-active' : ''}`}
            onClick={() => setTab('month')}
            data-testid="lb-tab-month"
          >
            This month
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'history'}
            className={`seg-btn${tab === 'history' ? ' is-active' : ''}`}
            onClick={() => setTab('history')}
            data-testid="lb-tab-history"
          >
            History
          </button>
        </div>
      </div>

      {tab === 'month' ? (
        <div className="lb-month">
          <div className="lb-table-wrap">
            <table className="dt lb-table">
              <thead>
                <tr>
                  <th className="first">#</th>
                  <th>Salesperson</th>
                  <th>Month</th>
                  <th className="num">{card.detailLabel || 'Net'}</th>
                  <th className="num last">{card.metricLabel}</th>
                </tr>
              </thead>
              <tbody>
                {card.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="sub" style={{ padding: '18px var(--pad)' }}>
                      {card.empty}
                    </td>
                  </tr>
                )}
                {card.rows.map((r) => (
                  <tr
                    key={r.id}
                    className={`${r.isYou ? 'is-you' : ''}${r.rank === null ? ' is-unranked' : ''}`}
                    data-testid="lb-row"
                  >
                    <td className="first lb-rank">{r.rank ?? '—'}</td>
                    <td>
                      <span style={{ fontWeight: r.isYou ? 600 : 500 }}>{r.name}</span>{' '}
                      {r.storeName && <span className="sub">{r.storeName}</span>}
                    </td>
                    <td>
                      <span className="lb-spark" aria-hidden>
                        {r.spark.map((v, i) => (
                          <span
                            key={i}
                            style={{
                              height: `${Math.max(v > 0 ? 2 : 1, Math.round((v / sparkMax) * 16))}px`,
                            }}
                          />
                        ))}
                      </span>
                    </td>
                    <td className="num mono sub">
                      {card.key === 'sales'
                        ? usdWholeCents(r.netCents)
                        : r.detail.replace(/^of /, '')}
                    </td>
                    <td className="num mono last" style={{ fontWeight: 600 }}>
                      {r.valueLabel}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="lb-side">
            <div className="lb-side-cap t-mono-sm">
              {card.key === 'ex' ? 'The exchanges behind' : 'The orders behind'} {focusName}
            </div>
            {!focus || focus.orders.length === 0 ? (
              <div className="sub">Nothing yet.</div>
            ) : (
              focus.orders.map((o) => (
                <Link
                  key={o.id}
                  href={o.number.startsWith('EX-') ? '/exchanges' : `/orders/${o.id}`}
                  className="lb-order"
                  onClick={onClose}
                >
                  <span>
                    <span className="mono lb-order-num">{o.number}</span>{' '}
                    <span className="sub">{o.who ?? ''}</span>
                  </span>
                  {o.amountCents > 0 && (
                    <span className="mono">{usdWholeCents(o.amountCents)}</span>
                  )}
                </Link>
              ))
            )}
            <div className="lb-rule sub">{card.rule}</div>
          </aside>
        </div>
      ) : (
        <div className="lb-table-wrap">
          {history == null ? (
            <ShimmerRows rows={4} />
          ) : (
            <table className="dt lb-table">
              <thead>
                <tr>
                  <th className="first">Month</th>
                  <th>Winner</th>
                  <th className="num">Result</th>
                  <th className="num">Your rank</th>
                  <th className="num last">Paid</th>
                </tr>
              </thead>
              <tbody>
                {history.filter((h) => h.race === card.key).length === 0 && (
                  <tr>
                    <td colSpan={5} className="sub" style={{ padding: '18px var(--pad)' }}>
                      No closed month yet — {board.monthLabel} is the first.
                    </td>
                  </tr>
                )}
                {history
                  .filter((h) => h.race === card.key)
                  .map((h) => (
                    <tr key={h.month} data-testid="lb-history-row">
                      <td className="first" style={{ fontWeight: 600 }}>
                        {h.label}
                      </td>
                      <td>
                        {h.winner ?? '—'}{' '}
                        {h.winnerStore && <span className="sub">{h.winnerStore}</span>}
                      </td>
                      <td className="num mono" style={{ fontWeight: 600 }}>
                        {h.result}
                      </td>
                      <td className="num mono" style={{ color: 'var(--accent)' }}>
                        {h.yourRank ? `#${h.yourRank}` : '—'}
                      </td>
                      <td className="num mono sub last">{h.paid}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          <div className="lb-history-foot">
            <Link href={`/print/competition-winners`} className="panel-link" target="_blank">
              Printable winners sheet →
            </Link>
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
