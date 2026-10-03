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
    return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
  } catch {
    return new Date(guess);
  }
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
 * expressions to Postgres. Only a zone `Intl` accepts (letters, digits,
 * `_ + - /`) is inlined; anything else reads UTC.
 */
export function tzLiteral(tz: string): SQL {
  let safe = 'UTC';
  if (/^[A-Za-z0-9_+\-/]+$/.test(tz)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      safe = tz;
    } catch {
      // unknown zone
    }
  }
  return sql.raw(`'${safe}'`);
}

/** Store-local midnight at the start of `day` in `tz`, as SQL. */
export function tzDayStart(day: string, tz: string): SQL {
  return sql`(${day}::date::timestamp AT TIME ZONE ${tz})`;
}

/** Store-local midnight after `day` in `tz` (exclusive end), as SQL. */
export function tzDayEndExclusive(day: string, tz: string): SQL {
  return sql`((${day}::date + 1)::timestamp AT TIME ZONE ${tz})`;
}
