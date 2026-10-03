import { sql, type SQL } from 'drizzle-orm';

/**
 * Date-range query params (owner 2026-09-02, Shopify-style picker): every
 * list or dashboard that scopes by date accepts `start` / `end` as
 * `YYYY-MM-DD`, inclusive on both ends. A malformed or reversed pair is
 * ignored (the endpoint keeps its default window) rather than rejected,
 * so a stale bookmark still renders.
 */
export interface DayRange {
  start: string;
  end: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(s: unknown): s is string {
  return typeof s === 'string' && DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function parseDayRange(start?: string, end?: string): DayRange | null {
  if (!isDay(start) || !isDay(end) || start > end) return null;
  return { start, end };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant local midnight starts `day` in `timeZone`. Owner
 * 2026-10-02: a Z-report cut at UTC midnight (5 PM in Los Angeles) lost
 * the evening's cash sales to tomorrow. An unknown zone reads as UTC.
 */
export function zonedMidnight(day: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  try {
    const first = guess - zoneOffsetMs(new Date(guess), timeZone);
    // Re-read the offset at the answer: a DST switch between the guess
    // and local midnight moves it by an hour.
    const t = guess - zoneOffsetMs(new Date(first), timeZone);
    // Where the clock jumps AT midnight (Santiago, Havana…) local 00:00
    // doesn't exist, or exists twice; the day then starts at the first
    // instant whose local date is `day`. Scan ±3 h in 15-minute steps,
    // then narrow to the second.
    const ymd = (at: number) => localYmd(at, timeZone);
    if (ymd(t) === day && ymd(t - 1000) < day) return new Date(t);
    const STEP = 15 * 60_000;
    let prev = t - 3 * 3_600_000;
    for (let at = prev; at <= t + 3 * 3_600_000; at += STEP) {
      if (ymd(at) === day) {
        let lo = prev; // before the day
        let hi = at; // inside the day
        while (hi - lo > 1000) {
          const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
          if (ymd(mid) === day) hi = mid;
          else lo = mid;
        }
        return new Date(hi);
      }
      prev = at;
    }
    return new Date(t);
  } catch {
    return new Date(guess);
  }
}

function localYmd(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at));
}

/** `[from, toExclusive)` covering every store-local day in the range. */
export function zonedBounds(range: DayRange, timeZone: string): { from: Date; toExclusive: Date } {
  const [y, m, d] = range.end.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { from: zonedMidnight(range.start, timeZone), toExclusive: zonedMidnight(next, timeZone) };
}

/**
 * `tz` as an inline SQL literal, for day buckets that appear in both
 * SELECT and GROUP BY — a bound parameter there reads as two different
 * expressions to Postgres. Only a zone `Intl` accepts is inlined:
 * a named zone (letters, digits, `_ + - /`) as a string, a fixed offset
 * (`+05:30`) as an INTERVAL — Postgres reads a bare `'+05:30'` string as a
 * POSIX zone, sign inverted. Anything else reads UTC.
 */
export function tzLiteral(tz: string): SQL {
  const valid = (() => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  })();
  if (valid && /^[+-]\d{2}:\d{2}$/.test(tz)) return sql.raw(`INTERVAL '${tz}'`);
  if (valid && /^[A-Za-z0-9_+\-/]+$/.test(tz)) return sql.raw(`'${tz}'`);
  return sql.raw(`'UTC'`);
}

/** Store-local midnight at the start of `day` in `tz`, as SQL. */
export function tzDayStart(day: string, tz: string): SQL {
  return sql`(${day}::date::timestamp AT TIME ZONE ${tz})`;
}

/** Store-local midnight after `day` in `tz` (exclusive end), as SQL. */
export function tzDayEndExclusive(day: string, tz: string): SQL {
  return sql`((${day}::date + 1)::timestamp AT TIME ZONE ${tz})`;
}
