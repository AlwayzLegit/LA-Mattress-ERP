import { describe, expect, it } from 'vitest';
import {
  allowedPunches,
  hoursFromMs,
  statusOf,
  workedMs,
  workedMsBetween,
  type Punch,
} from './timeclock-math';

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 10, h, m));
const p = (type: Punch['type'], h: number, m = 0): Punch => ({ type, at: t(h, m) });

describe('statusOf', () => {
  it('is out with no punches', () => {
    expect(statusOf([])).toEqual({ status: 'out', since: null });
  });
  it('follows the last punch in time order, not insertion order', () => {
    expect(statusOf([p('clock_in', 9)]).status).toBe('in');
    expect(statusOf([p('clock_in', 9), p('break_start', 12)]).status).toBe('break');
    expect(statusOf([p('break_end', 13), p('clock_in', 9), p('break_start', 12)]).status).toBe(
      'in',
    );
    const out = statusOf([p('clock_in', 9), p('clock_out', 17)]);
    expect(out).toEqual({ status: 'out', since: t(17) });
  });
});

describe('workedMs', () => {
  it('sums clocked-in segments and leaves breaks out', () => {
    const punches = [
      p('clock_in', 8, 58),
      p('break_start', 12, 31),
      p('break_end', 13, 2),
      p('clock_out', 17, 4),
    ];
    // 8:58→12:31 = 3h33m, 13:02→17:04 = 4h02m → 7h35m.
    expect(hoursFromMs(workedMs(punches, t(23)))).toBe(7.58);
  });
  it('accrues an open segment to now', () => {
    expect(workedMs([p('clock_in', 9)], t(11, 30))).toBe(2.5 * 3_600_000);
    // On break: the open segment closed at break start.
    expect(workedMs([p('clock_in', 9), p('break_start', 10)], t(11))).toBe(3_600_000);
  });
  it('never goes backwards on an out-of-order punch', () => {
    // A clock_out stamped before the clock_in sorts first and is ignored;
    // the member is still on the clock, so time accrues from 10:00 — the
    // total never dips below what the later punches justify.
    expect(workedMs([p('clock_in', 10), p('clock_out', 9)], t(12))).toBe(2 * 3_600_000);
    // A stray clock_out while already out is ignored.
    expect(workedMs([p('clock_out', 8), p('clock_in', 9), p('clock_out', 10)], t(12))).toBe(
      3_600_000,
    );
    // A second clock_in while already in does not restart the segment.
    expect(workedMs([p('clock_in', 9), p('clock_in', 10), p('clock_out', 11)], t(12))).toBe(
      2 * 3_600_000,
    );
  });
});

describe('workedMsBetween', () => {
  it('counts only the part of each segment inside the window', () => {
    // Clocked in 22:00 the day before, out 02:00 today: today gets 2h.
    const yesterday = new Date(Date.UTC(2026, 8, 9, 22));
    const punches: Punch[] = [
      { type: 'clock_in', at: yesterday },
      { type: 'clock_out', at: t(2) },
    ];
    expect(workedMsBetween(punches, t(0), t(12))).toBe(2 * 3_600_000);
    // The same segment seen from yesterday's window is the other 2h.
    expect(workedMsBetween(punches, new Date(Date.UTC(2026, 8, 9)), t(0))).toBe(2 * 3_600_000);
  });
  it('carries an open segment across the boundary to now', () => {
    const sunday = new Date(Date.UTC(2026, 8, 6, 23));
    const punches: Punch[] = [{ type: 'clock_in', at: sunday }];
    const monday = new Date(Date.UTC(2026, 8, 7));
    const now = new Date(Date.UTC(2026, 8, 7, 1, 30));
    expect(workedMsBetween(punches, monday, now)).toBe(1.5 * 3_600_000);
    expect(statusOf(punches).status).toBe('in');
  });
  it('leaves breaks and out-of-window time alone', () => {
    const punches: Punch[] = [
      p('clock_in', 9),
      p('break_start', 12),
      p('break_end', 13),
      p('clock_out', 17),
    ];
    expect(workedMsBetween(punches, t(10), t(14))).toBe(3 * 3_600_000);
    expect(workedMsBetween(punches, t(18), t(20))).toBe(0);
    expect(workedMsBetween(punches, t(12), t(11))).toBe(0);
  });
});

describe('allowedPunches', () => {
  it('offers only the moves that change the status', () => {
    expect(allowedPunches('out')).toEqual(['clock_in']);
    expect(allowedPunches('in')).toEqual(['break_start', 'clock_out']);
    expect(allowedPunches('break')).toEqual(['break_end']);
  });
});
