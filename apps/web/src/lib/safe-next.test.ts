import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';

const ORIGIN = 'https://erp.example.com';

describe('safeNext', () => {
  it('keeps same-origin paths with their query', () => {
    expect(safeNext('/pos', ORIGIN)).toBe('/pos');
    expect(safeNext('/reports/written-sales?view=summary', ORIGIN)).toBe(
      '/reports/written-sales?view=summary',
    );
  });

  it('refuses anything that leaves the site', () => {
    expect(safeNext('//evil.example', ORIGIN)).toBe('/dashboard');
    expect(safeNext('/\\evil.example', ORIGIN)).toBe('/dashboard');
    expect(safeNext('\\\\evil.example', ORIGIN)).toBe('/dashboard');
    expect(safeNext('https://evil.example/pos', ORIGIN)).toBe('/dashboard');
    expect(safeNext('javascript:alert(1)', ORIGIN)).toBe('/dashboard');
  });

  it('falls back when there is no next', () => {
    expect(safeNext(null, ORIGIN)).toBe('/dashboard');
    expect(safeNext('', ORIGIN)).toBe('/dashboard');
  });
});
