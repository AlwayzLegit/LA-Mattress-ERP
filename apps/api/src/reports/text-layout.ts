/**
 * Column helpers for the STORIS "Basic PDF" text layouts (132 Courier
 * columns): place text at a column, right-align it to an edge, fit a
 * cell, and stamp the header clock. Shared by every spooled report so
 * they line up the same way.
 */

export const REPORT_WIDTH = 132;

/** Fit `s` into `width` columns — collapse whitespace, cut or pad. */
export function fit(s: string | null | undefined, width: number): string {
  const v = (s ?? '').replace(/\s+/g, ' ');
  return v.length > width ? v.slice(0, width) : v.padEnd(width);
}

/** Place `text` so that it starts at column `at`. */
export function put(line: string, at: number, text: string): string {
  const padded = line.length < at ? line.padEnd(at) : line;
  return padded.slice(0, at) + text + padded.slice(at + text.length);
}

/** Place `text` so that it ends at column `end` (exclusive, like a right edge). */
export function putRight(line: string, end: number, text: string): string {
  return put(line, Math.max(0, end - text.length), text);
}

/** Cut a line to the report width and drop trailing blanks. */
export function trimTo(line: string, width = REPORT_WIDTH): string {
  return line.length > width ? line.slice(0, width) : line.replace(/\s+$/, '');
}

/** `2026-08-26` → `08/26/26`. */
export function mmddyy(day: string): string {
  const [y, m, d] = day.split('-');
  return `${m}/${d}/${y!.slice(2)}`;
}

/** `18:23:56 08/26/26` in the report's clock zone. */
export function clockStamp(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${hour}:${get('minute')}:${get('second')} ${get('month')}/${get('day')}/${get('year')}`;
}

/**
 * Break body lines into pages that each start with `header(pageNumber)`;
 * an empty body still yields one page. Never splits a group of lines that
 * `keepTogether` marks: a line index in that set starts a block that must
 * land on the same page as the lines up to the next marked index.
 */
export function paginate(
  body: string[],
  header: (page: number) => string[],
  linesPerPage: number,
): string[][] {
  const pages: string[][] = [];
  const room = Math.max(1, linesPerPage - header(1).length);
  for (let i = 0; i < Math.max(1, body.length); i += room) {
    pages.push([...header(pages.length + 1), ...body.slice(i, i + room)]);
  }
  return pages;
}
