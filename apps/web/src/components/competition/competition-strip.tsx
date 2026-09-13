'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { readLocal, writeLocal } from '@/app/(business)/dashboard/shared/kit';
import { LeadDialog } from './lead-dialog';
import { LeaderboardDialog } from './leaderboard-dialog';
import { LeadsPanel } from './leads-panel';
import { COMPETITION_EVENT, usdWholeCents, type CompetitionBoard, type RaceCard } from './types';

/**
 * The sales competition strip (redesign Phase 11, README §3.6): above
 * every role home. Header line, days left, the sweep chip, + Log lead,
 * Collapse; six cards with everyone who competes (owner 2026-09-13: every
 * salesperson, sales or not — the unranked sit under the ranked with no
 * number; collapsed keeps the top three), the pace line, your pinned row
 * with the gap in the metric's units, and the one-line rule; the rules
 * footer. Hidden when the viewer may not see it (403 / 404) so a home
 * never breaks for it.
 *
 * Motion budget: a rank change on your own screen slides the row once
 * (280ms) and flashes the card once (800ms). Nothing else moves.
 */
const COLLAPSE_KEY = 'jetnine.competition.collapsed';
const POLL_MS = 60_000;

export function useCompetition() {
  const [board, setBoard] = useState<CompetitionBoard | null | undefined>(undefined);
  const [error, setError] = useState(false);
  const load = useCallback((quiet = true) => {
    if (!quiet) setBoard(undefined);
    return api<CompetitionBoard>('/v1/competitions/current')
      .then((b) => {
        setBoard(b);
        setError(false);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setBoard(null);
        else setError(true);
      });
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    const onPing = () => void load();
    window.addEventListener(COMPETITION_EVENT, onPing);
    window.addEventListener('erp:team-update', onPing);
    window.addEventListener('focus', onPing);
    return () => {
      window.clearInterval(t);
      window.removeEventListener(COMPETITION_EVENT, onPing);
      window.removeEventListener('erp:team-update', onPing);
      window.removeEventListener('focus', onPing);
    };
  }, [load]);
  return { board, error, reload: load, setBoard };
}

export function CompetitionStrip({
  showLeads = false,
  actorName,
}: {
  /** Render the "My leads" panel under the strip (salesperson / manager homes). */
  showLeads?: boolean;
  actorName?: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState<{ card: RaceCard; tab: 'month' | 'history' } | null>(null);
  const [leadOpen, setLeadOpen] = useState(false);
  const [bannerHidden, setBannerHidden] = useState<string | null>(null);
  const { board, error, reload } = useCompetition();

  useEffect(() => {
    setCollapsed(readLocal<boolean>(COLLAPSE_KEY, false));
    setBannerHidden(readLocal<string>('jetnine.competition.bannerHidden', ''));
  }, []);

  // Rank-change motion: remember the previous ranks per card.
  const prevRanks = useRef<Map<string, number>>(new Map());
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [moved, setMoved] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!board) return;
    const next = new Map<string, number>();
    const flashed = new Set<string>();
    const slid = new Set<string>();
    for (const c of board.cards) {
      for (const r of c.top) next.set(`${c.key}:${r.id}`, r.rank ?? 0);
      const you = c.rows.find((r) => r.isYou);
      if (you) next.set(`${c.key}:you`, you.rank ?? 0);
      const before = prevRanks.current.get(`${c.key}:you`);
      if (before != null && you && before !== (you.rank ?? 0)) {
        flashed.add(c.key);
        slid.add(c.key);
      } else if (
        prevRanks.current.size > 0 &&
        c.top[0] &&
        prevRanks.current.get(`${c.key}:${c.top[0].id}`) !== 1
      ) {
        flashed.add(c.key);
      }
    }
    prevRanks.current = next;
    if (flashed.size > 0) {
      setFlash(flashed);
      setMoved(slid);
      const t = window.setTimeout(() => {
        setFlash(new Set());
        setMoved(new Set());
      }, 900);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [board]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeLocal(COLLAPSE_KEY, !c);
      return !c;
    });
  };
  const sweepChip = useMemo(() => {
    if (!board?.sweep) return null;
    const s = board.sweep;
    return (
      <span
        className={`cs-sweep${s.n >= 4 ? ' is-on' : ''}`}
        title={`First on 4 of 6 cards pays ${usdWholeCents(board.config.sweep.four)}; 5 of 6 pays ${usdWholeCents(board.config.sweep.five)}; all 6 pays ${usdWholeCents(board.config.sweep.six)} — instead of the per-card ${usdWholeCents(board.config.prizeCents)}s`}
        data-testid="cs-sweep"
      >
        <strong>{s.name}</strong> leads <span className="cs-sweep-n">{s.n}</span> of 6 ·{' '}
        <span className="mono">{s.bonus}</span>
      </span>
    );
  }, [board]);

  if (board === null) return null;
  if (board === undefined) {
    return error ? null : (
      <div className="cs cs-loading" data-testid="competition-strip" aria-busy />
    );
  }

  const cards = board.cards.filter((c) => c.on);
  const prize = usdWholeCents(board.config.prizeCents);
  const sw = board.config.sweep;
  const days = board.daysLeft;
  const daysLabel =
    days === 0
      ? 'ends tonight'
      : days === 1
        ? 'day left'
        : board.last48
          ? `days left · ends ${board.endsAt}`
          : 'days left';
  const showBanner = board.banner && bannerHidden !== board.banner.month;

  return (
    <>
      {showBanner && board.banner && (
        <div className="cs-banner" data-testid="cs-banner">
          <div className="cs-banner-title">{board.banner.label}</div>
          <div className="cs-banner-list">
            {board.banner.winners
              .filter((w) => w.name)
              .map((w) => (
                <span key={w.race}>
                  <span className="cs-banner-race">{w.title}</span> <strong>{w.name}</strong>
                  {w.store ? `, ${w.store}` : ''} · {w.short}
                </span>
              ))}
          </div>
          <div className="cs-banner-actions">
            <Link
              href={`/print/competition-winners?month=${board.banner.month}`}
              target="_blank"
              className="btn btn-sm cs-banner-btn"
            >
              Print for the break room
            </Link>
            <button
              type="button"
              className="cs-banner-dismiss"
              onClick={() => {
                writeLocal('jetnine.competition.bannerHidden', board.banner!.month);
                setBannerHidden(board.banner!.month);
              }}
            >
              Shows until{' '}
              {new Date(`${board.banner.until}T12:00:00`).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })}{' '}
              ×
            </button>
          </div>
        </div>
      )}

      <section
        className={`cs${board.last48 ? ' is-last48' : ''}${collapsed ? ' is-collapsed' : ''}`}
        data-testid="competition-strip"
      >
        <div className="cs-head">
          <h2>{board.monthLabel} competition</h2>
          <span className="cs-head-sub">
            {cards.length} races · {prize} each ·{' '}
            <strong>
              win 4 → {usdWholeCents(sw.four)} · 5 → {usdWholeCents(sw.five)} · all 6 →{' '}
              {usdWholeCents(sw.six)}
            </strong>
          </span>
          <span
            className={`cs-days${board.last48 ? ' is-last48' : days <= 5 ? ' is-soon' : ''}`}
            data-testid="cs-days"
          >
            <span className="cs-days-n">
              {board.isDayOne && days === board.daysInMonth - 1 ? days + 1 : days}
            </span>
            <span>{daysLabel}</span>
          </span>
          {board.viewer.canLog && (
            <Button
              size="sm"
              className="cs-log"
              onClick={() => setLeadOpen(true)}
              data-testid="cs-log-lead"
            >
              + Log lead
            </Button>
          )}
          {sweepChip}
          <Button size="sm" onClick={toggleCollapsed} data-testid="cs-collapse">
            {collapsed ? 'Expand' : 'Collapse'}
          </Button>
        </div>

        <div
          className="cs-cards"
          style={{ gridTemplateColumns: `repeat(${Math.max(cards.length, 1)}, minmax(0, 1fr))` }}
        >
          {cards.map((c) => (
            <RaceCardView
              key={c.key}
              card={c}
              board={board}
              collapsed={collapsed}
              flash={flash.has(c.key)}
              moved={moved.has(c.key)}
              onOpen={() => setOpen({ card: c, tab: 'month' })}
            />
          ))}
        </div>

        <div className="cs-foot">
          <span>
            Only completed orders count. A sale returned within {board.config.returnWindowDays} days
            comes off the board. Ties break by net sales.{' '}
            <strong>
              First on 4 of 6 cards pays {usdWholeCents(sw.four)}; 5 of 6 pays{' '}
              {usdWholeCents(sw.five)}; all 6 pays {usdWholeCents(sw.six)}
            </strong>{' '}
            — in place of the {prize}s.
          </span>
          <span className="cs-foot-right">
            Prizes pay <strong>{board.config.payoutLabel}</strong>, once returns settle ·{' '}
            <button
              type="button"
              className="panel-link cs-history"
              onClick={() => cards[0] && setOpen({ card: cards[0], tab: 'history' })}
              data-testid="cs-history"
            >
              History
            </button>
          </span>
        </div>
      </section>

      {showLeads && board.viewer.canLog && (
        <LeadsPanel
          actorName={actorName ?? board.viewer.name}
          onLog={() => setLeadOpen(true)}
          onChanged={() => void reload()}
        />
      )}

      {open && (
        <LeaderboardDialog
          board={board}
          card={board.cards.find((c) => c.key === open.card.key) ?? open.card}
          initialTab={open.tab}
          onClose={() => setOpen(null)}
        />
      )}
      {leadOpen && (
        <LeadDialog
          onClose={() => setLeadOpen(false)}
          actorName={actorName ?? board.viewer.name}
          locationId={board.viewer.storeId}
        />
      )}
    </>
  );
}

function RaceCardView({
  card,
  board,
  collapsed,
  flash,
  moved,
  onOpen,
}: {
  card: RaceCard;
  board: CompetitionBoard;
  collapsed: boolean;
  flash: boolean;
  moved: boolean;
  onOpen: () => void;
}) {
  const you = card.you;
  // Day one keeps each card's own empty copy instead of a column of zeros.
  const empty = card.rows.length === 0 || (board.isDayOne && card.top.length === 0);
  // Collapsed keeps the top three; expanded lists everyone who competes.
  const shown = collapsed ? card.top : card.rows;
  return (
    <button
      type="button"
      className={`cs-card${flash ? ' is-flash' : ''}`}
      onClick={onOpen}
      aria-label={`${card.title} leaderboard`}
      data-testid={`cs-card-${card.key}`}
    >
      <div className="cs-card-head">
        <span className="cs-card-title">{card.title}</span>
        <span className="mono cs-card-prize">{usdWholeCents(card.prizeCents)}</span>
      </div>
      {empty ? (
        <div className="cs-empty">{card.empty}</div>
      ) : (
        <ol className="cs-top">
          {shown.map((r) => (
            <li
              key={r.id}
              className={`${r.isYou ? 'is-you' : ''}${r.rank === null ? ' is-unranked' : ''}`}
              data-testid={`cs-row-${card.key}`}
            >
              <span className="cs-rank">{r.rank ?? '—'}</span>
              <span className="cs-name">
                {r.name}
                {r.storeCode && <span className="cs-store"> {r.storeCode}</span>}
              </span>
              <span className="mono cs-value">{r.valueLabel}</span>
              {r.detail && card.key !== 'high' && (
                <span className="mono cs-detail">{r.detail}</span>
              )}
              {card.key === 'high' && r.detail && (
                <span className="mono cs-detail cs-detail-wide">{r.detail}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {!collapsed && card.pace && (
        <div className="cs-pace" aria-hidden>
          <div className="cs-pace-caps">
            <span>you</span>
            <span>leader</span>
            <span>pace → {card.pace.label}</span>
          </div>
          <div className="cs-pace-bar">
            <span className="cs-pace-leader" style={{ width: `${card.pace.leaderPct}%` }} />
            <span className="cs-pace-you" style={{ width: `${card.pace.youPct}%` }} />
            <span className="cs-pace-tick" style={{ left: `${card.pace.pacePct}%` }} />
          </div>
        </div>
      )}
      {you && (
        <div className={`cs-you${moved ? ' is-moved' : ''}`} data-testid={`cs-you-${card.key}`}>
          <span className="cs-rank">{you.rank ?? '—'}</span>
          <span className="cs-you-name">
            You <span className="cs-gap">{you.gap}</span>
          </span>
          <span className="mono cs-value">{you.valueLabel}</span>
        </div>
      )}
      {!collapsed && <div className="cs-rule">{card.rule}</div>}
    </button>
  );
}
