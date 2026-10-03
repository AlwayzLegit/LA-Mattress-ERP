import { describe, expect, it } from 'vitest';
import { zonedBounds, zonedMidnight } from './date-range';

describe('zonedMidnight / zonedBounds', () => {
  it('starts a Los Angeles day at 07:00 UTC in summer, 08:00 in winter', () => {
    expect(zonedMidnight('2026-10-02', 'America/Los_Angeles').toISOString()).toBe(
      '2026-10-02T07:00:00.000Z',
    );
    expect(zonedMidnight('2026-12-15', 'America/Los_Angeles').toISOString()).toBe(
      '2026-12-15T08:00:00.000Z',
    );
  });

  it('a 6 PM Pacific sale falls inside its own day', () => {
    const { from, toExclusive } = zonedBounds(
      { start: '2026-10-02', end: '2026-10-02' },
      'America/Los_Angeles',
    );
    const sixPm = new Date('2026-10-03T01:01:05Z');
    expect(sixPm >= from && sixPm < toExclusive).toBe(true);
    expect(toExclusive.toISOString()).toBe('2026-10-03T07:00:00.000Z');
  });

  it('spans DST switches (23- and 25-hour days)', () => {
    const spring = zonedBounds({ start: '2026-03-08', end: '2026-03-08' }, 'America/Los_Angeles');
    expect(spring.from.toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(spring.toExclusive.toISOString()).toBe('2026-03-09T07:00:00.000Z');
    const fall = zonedBounds({ start: '2026-11-01', end: '2026-11-01' }, 'America/Los_Angeles');
    expect(fall.from.toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(fall.toExclusive.toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('reads UTC for UTC or an unknown zone; ranges cover every day', () => {
    expect(zonedMidnight('2026-10-02', 'UTC').toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(zonedMidnight('2026-10-02', 'Not/AZone').toISOString()).toBe('2026-10-02T00:00:00.000Z');
    const month = zonedBounds({ start: '2026-01-01', end: '2026-01-31' }, 'America/New_York');
    expect(month.from.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(month.toExclusive.toISOString()).toBe('2026-02-01T05:00:00.000Z');
  });
});

describe('tzLiteral', () => {
  it('inlines a real zone and reads UTC for anything else', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const d = new PgDialect();
    const { tzLiteral } = await import('./date-range');
    expect(d.sqlToQuery(tzLiteral('America/Los_Angeles')).sql).toBe("'America/Los_Angeles'");
    expect(d.sqlToQuery(tzLiteral("UTC'; drop table x; --")).sql).toBe("'UTC'");
    expect(d.sqlToQuery(tzLiteral('Not/AZone')).sql).toBe("'UTC'");
  });
});
