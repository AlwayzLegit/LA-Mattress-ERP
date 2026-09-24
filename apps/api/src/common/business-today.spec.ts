import { describe, expect, it } from 'vitest';
import { ymdInTimeZone } from './business-today';

describe('ymdInTimeZone', () => {
  it('keeps the store date after 5 PM Pacific, when UTC has already rolled over', () => {
    // 2026-09-23 17:30 PDT = 2026-09-24 00:30 UTC.
    const at = new Date('2026-09-24T00:30:00Z');
    expect(at.toISOString().slice(0, 10)).toBe('2026-09-24');
    expect(ymdInTimeZone(at, 'America/Los_Angeles')).toBe('2026-09-23');
  });

  it('rolls over at local midnight, and falls back to UTC for an unknown zone', () => {
    expect(ymdInTimeZone(new Date('2026-09-24T07:00:00Z'), 'America/Los_Angeles')).toBe(
      '2026-09-24',
    );
    expect(ymdInTimeZone(new Date('2026-09-24T00:30:00Z'), 'Not/AZone')).toBe('2026-09-24');
  });
});
