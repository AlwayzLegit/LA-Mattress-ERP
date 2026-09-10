/**
 * Time clock arithmetic (owner hand-off 2026-09-10, step 2). Pure, so the
 * rules are unit-tested without a database:
 *
 *  - Status follows the last punch: clock_in / break_end → on the clock,
 *    break_start → on break, clock_out (or nothing) → clocked out.
 *  - Worked time is the sum of clocked-in segments (clock_in → break_start,
 *    break_end → clock_out, and so on). Each segment is clamped at zero so
 *    an out-of-order punch can never make the total go backwards, and an
 *    open segment accrues to `now`.
 *  - A punch is only accepted when it moves the status: clock_in while
 *    out, break_start / clock_out while on the clock, break_end while on
 *    break.
 */

export type PunchType = 'clock_in' | 'break_start' | 'break_end' | 'clock_out';
export type ClockStatus = 'out' | 'in' | 'break';

export interface Punch {
  type: PunchType;
  at: Date;
}

export const PUNCH_TYPES: PunchType[] = ['clock_in', 'break_start', 'break_end', 'clock_out'];

export function isPunchType(v: unknown): v is PunchType {
  return typeof v === 'string' && (PUNCH_TYPES as string[]).includes(v);
}

function sorted(punches: Punch[]): Punch[] {
  return [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Status after the punches so far, and when it began. */
export function statusOf(punches: Punch[]): { status: ClockStatus; since: Date | null } {
  const last = sorted(punches).at(-1);
  if (!last) return { status: 'out', since: null };
  switch (last.type) {
    case 'clock_in':
    case 'break_end':
      return { status: 'in', since: last.at };
    case 'break_start':
      return { status: 'break', since: last.at };
    default:
      return { status: 'out', since: last.at };
  }
}

/** Milliseconds on the clock (breaks excluded), an open segment counted to `now`. */
export function workedMs(punches: Punch[], now: Date): number {
  let total = 0;
  let open: Date | null = null;
  for (const p of sorted(punches)) {
    if (p.type === 'clock_in' || p.type === 'break_end') {
      if (open == null) open = p.at;
    } else if (open != null) {
      total += Math.max(0, p.at.getTime() - open.getTime());
      open = null;
    }
  }
  if (open != null) total += Math.max(0, now.getTime() - open.getTime());
  return total;
}

/** The punches that make sense from a status — what the strip offers as buttons. */
export function allowedPunches(status: ClockStatus): PunchType[] {
  switch (status) {
    case 'out':
      return ['clock_in'];
    case 'in':
      return ['break_start', 'clock_out'];
    case 'break':
      return ['break_end'];
  }
}

export function hoursFromMs(ms: number): number {
  return Math.round((ms / 3_600_000) * 100) / 100;
}
