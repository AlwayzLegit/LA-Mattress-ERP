'use client';

import { useEffect, useState } from 'react';
import { useCompetition } from '@/components/competition/competition-strip';
import { usdWholeCents, type RaceCard } from '@/components/competition/types';

/**
 * TV mode (README §3.6): a dark, chrome-free 1920×1080 frame for the
 * showroom wall. One race in focus at 30px rows with the leader tinted,
 * the other five as one-line leaders on the right, a cycle indicator, the
 * four rules in the footer. Auto-cycles every six seconds. Same data,
 * same type, no new colours. A TV has no viewer, so it shows the company:
 * the People race, never a pinned row.
 */
const CYCLE_MS = 6000;

export default function CompetitionTvPage() {
  const { board } = useCompetition('people');
  const [idx, setIdx] = useState(0);
  const [clock, setClock] = useState('');
  useEffect(() => {
    const t = window.setInterval(() => setIdx((i) => i + 1), CYCLE_MS);
    const c = window.setInterval(
      () =>
        setClock(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })),
      1000,
    );
    setClock(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
    return () => {
      window.clearInterval(t);
      window.clearInterval(c);
    };
  }, []);

  if (board === undefined) return <div className="tv tv-empty">Loading the board…</div>;
  if (board === null) {
    return (
      <div className="tv tv-empty">
        <div>
          <h1>Sales competition</h1>
          <p>Sign in with an account that can see the competition to run the wall display.</p>
        </div>
      </div>
    );
  }
  const cards = board.cards.filter((c) => c.on);
  const focus: RaceCard | undefined = cards[idx % Math.max(cards.length, 1)];
  if (!focus) return <div className="tv tv-empty">No races are on this month.</div>;
  const others = cards.filter((c) => c.key !== focus.key);
  const sw = board.config.sweep;

  return (
    <div className="tv" data-testid="tv-competition">
      <header className="tv-head">
        <h1>
          {board.monthLabel} sales competition
          <span className="tv-head-sub">
            {board.daysLeft === 0 ? 'ends tonight' : `${board.daysLeft} days left`} · ends{' '}
            {board.endsAt}
          </span>
        </h1>
        <span className="mono tv-clock">{clock}</span>
      </header>
      <main className="tv-main">
        <section className="tv-focus" key={focus.key}>
          <div className="tv-focus-head">
            <h2>
              {focus.title} <span className="tv-focus-sub">{focus.sub}</span>
            </h2>
            <span className="mono tv-focus-prize">{usdWholeCents(focus.prizeCents)} to first</span>
          </div>
          {focus.rows.length === 0 ? (
            <div className="tv-focus-empty">{focus.empty}</div>
          ) : (
            <ol className="tv-rows">
              {focus.rows.slice(0, 10).map((r) => (
                <li key={r.id} className={r.rank === 1 ? 'is-leader' : ''}>
                  <span className="tv-rank">{r.rank}</span>
                  <span className="tv-name">
                    {r.name} <span className="tv-store">{r.storeName ?? ''}</span>
                  </span>
                  <span className="tv-detail">{r.detail}</span>
                  <span className="mono tv-value">{r.valueLabel}</span>
                </li>
              ))}
            </ol>
          )}
          <div className="tv-focus-foot">
            <span className="tv-dots" aria-hidden>
              {cards.map((c) => (
                <span key={c.key} className={c.key === focus.key ? 'is-on' : ''} />
              ))}
            </span>
            <span className="tv-rule">{focus.rule}</span>
          </div>
        </section>
        <aside className="tv-side">
          {others.map((c) => {
            const l = c.rows[0];
            return (
              <div className="tv-leader" key={c.key}>
                <span className="tv-leader-title">{c.title}</span>
                <span className="tv-leader-name">
                  {l ? (
                    <>
                      {l.name} <span className="tv-store">{l.storeName ?? ''}</span>
                    </>
                  ) : (
                    <span className="tv-store">nobody yet</span>
                  )}
                </span>
                <span className="mono tv-leader-value">{l ? l.valueLabel : '—'}</span>
              </div>
            );
          })}
          <div className="tv-foot">
            Only completed orders count · returns within {board.config.returnWindowDays} days come
            off · prizes pay on the {ordinal(board.config.payoutDay)} ·{' '}
            <strong>
              win 4 of 6 → {usdWholeCents(sw.four)} · 5 of 6 → {usdWholeCents(sw.five)} · all 6 →{' '}
              {usdWholeCents(sw.six)}
            </strong>
          </div>
        </aside>
      </main>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
