'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { clockTime, hours1, PUNCH_LABELS, shiftLabel } from './kit';
import type { PunchType, TimeClockMe } from './types';

/**
 * Screen 1 — the time clock strip (hand-off 2026-09-10, step 2): the
 * first element in the main column on the Manager, Operations and
 * Warehouse homes. Status, today's hours and punches, this week's hours,
 * today's shift, and the one or two punches that make sense right now.
 * Hidden when the member cannot punch (a 403).
 */
export function TimeClockStrip() {
  const [me, setMe] = useState<TimeClockMe | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<TimeClockMe>('/v1/timeclock/me')
        .then(setMe)
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 403) setMe(null);
          else setMe((m) => m ?? null);
        }),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // While on the clock the hours keep moving; refresh every minute.
  useEffect(() => {
    if (!me || me.status === 'out') return;
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [me, load]);

  if (me === null) return null;

  const punch = async (type: PunchType) => {
    setBusy(true);
    try {
      const r = await api<TimeClockMe & { punched: { type: PunchType; at: string } }>(
        '/v1/timeclock/punch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type }),
        },
      );
      setMe(r);
      toast.success(
        `${PUNCH_LABELS[r.punched.type]} recorded at ${clockTime(r.punched.at, r.timezone)} · ${r.member.name}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const tz = me?.timezone;
  const pill = me
    ? me.status === 'in'
      ? {
          bg: 'var(--accent-soft)',
          fg: 'var(--accent-ink)',
          text: `On the clock since ${me.since ? clockTime(me.since, tz) : '—'}`,
        }
      : me.status === 'break'
        ? {
            bg: 'var(--warn-soft)',
            fg: 'var(--warn-ink)',
            text: `On break since ${me.since ? clockTime(me.since, tz) : '—'}`,
          }
        : {
            bg: 'var(--surface2)',
            fg: 'var(--muted)',
            text: me.since ? `Clocked out at ${clockTime(me.since, tz)}` : 'Clocked out',
          }
    : null;

  return (
    <div className="tc-strip" data-testid="time-clock-strip" data-noprint="true">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span className="eyebrow">Time clock</span>
        <span style={{ fontWeight: 500 }}>{me?.member.name ?? '…'}</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          {me ? `${me.member.roleName ?? 'Member'} · ${me.member.locationName}` : ''}
        </span>
      </div>
      {pill && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 9px',
            borderRadius: 4,
            fontSize: 11.5,
            background: pill.bg,
            color: pill.fg,
          }}
          data-testid="time-clock-status"
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'currentColor',
              display: 'inline-block',
            }}
          />
          {pill.text}
        </span>
      )}
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
        <span
          className="mono"
          style={{ fontSize: 17, fontWeight: 500 }}
          data-testid="time-clock-hours"
        >
          {me ? `${me.hoursToday.toFixed(2)} h` : '—'}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>today</span>
      </span>
      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
        {me && me.punchesToday.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>No punches yet today</span>
        )}
        {me?.punchesToday.map((p) => (
          <span key={p.id} className="tc-chip">
            {PUNCH_LABELS[p.type]}
            <span className="mono" style={{ color: 'var(--text)' }}>
              {clockTime(p.at, tz)}
            </span>
          </span>
        ))}
      </span>
      <span
        style={{
          marginLeft: 'auto',
          display: 'inline-flex',
          gap: 14,
          fontSize: 11.5,
          color: 'var(--muted)',
          flexWrap: 'wrap',
        }}
      >
        <span>
          Week{' '}
          <span className="mono" style={{ color: 'var(--text)' }}>
            {me ? `${hours1(me.hoursWeek)} h` : '—'}
          </span>
        </span>
        <span>
          Scheduled{' '}
          <span className="mono" style={{ color: 'var(--text)' }}>
            {me
              ? me.scheduledToday
                ? shiftLabel(me.scheduledToday.startMinutes, me.scheduledToday.endMinutes)
                : 'day off'
              : '—'}
          </span>
        </span>
      </span>
      <span style={{ display: 'inline-flex', gap: 6 }}>
        {me?.status === 'out' && (
          <button
            type="button"
            className="tc-btn is-primary"
            disabled={busy}
            onClick={() => void punch('clock_in')}
            data-testid="punch-clock_in"
          >
            Clock in
          </button>
        )}
        {me?.status === 'in' && (
          <>
            <button
              type="button"
              className="tc-btn"
              disabled={busy}
              onClick={() => void punch('break_start')}
              data-testid="punch-break_start"
            >
              Start break
            </button>
            <button
              type="button"
              className="tc-btn is-danger"
              disabled={busy}
              onClick={() => void punch('clock_out')}
              data-testid="punch-clock_out"
            >
              Clock out
            </button>
          </>
        )}
        {me?.status === 'break' && (
          <button
            type="button"
            className="tc-btn is-primary"
            disabled={busy}
            onClick={() => void punch('break_end')}
            data-testid="punch-break_end"
          >
            End break
          </button>
        )}
      </span>
    </div>
  );
}
