import { describe, expect, it } from 'vitest';
import { applySavedOrder, compareSortValues, moveId, sortRows, type ColumnDef } from './columns';

describe('column order', () => {
  it('keeps saved order, drops ids that no longer exist, appends new ones', () => {
    expect(applySavedOrder(['c', 'a', 'zzz'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
    expect(applySavedOrder(null, ['a', 'b'])).toEqual(['a', 'b']);
    expect(applySavedOrder('junk', ['a', 'b'])).toEqual(['a', 'b']);
    expect(applySavedOrder([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('moves a column onto another and leaves fixed columns alone', () => {
    const fixed = new Set(['actions']);
    expect(moveId(['a', 'b', 'c', 'actions'], 'c', 'a', fixed)).toEqual(['c', 'a', 'b', 'actions']);
    expect(moveId(['a', 'b', 'c', 'actions'], 'a', 'c', fixed)).toEqual(['b', 'c', 'a', 'actions']);
    expect(moveId(['a', 'b', 'actions'], 'a', 'actions', fixed)).toEqual(['a', 'b', 'actions']);
    expect(moveId(['a', 'b', 'actions'], 'actions', 'a', fixed)).toEqual(['a', 'b', 'actions']);
    expect(moveId(['a', 'b'], 'a', 'a', fixed)).toEqual(['a', 'b']);
  });
});

describe('client sort', () => {
  it('orders numbers numerically, text with numeric awareness, blanks last', () => {
    expect(compareSortValues(2, 10)).toBeLessThan(0);
    expect(compareSortValues('SO-10', 'SO-9')).toBeGreaterThan(0);
    expect(compareSortValues('apple', 'Banana')).toBeLessThan(0);
    expect(compareSortValues(null, 0)).toBeGreaterThan(0);
    expect(compareSortValues(new Date('2026-01-02'), new Date('2026-01-01'))).toBeGreaterThan(0);
  });

  it('is stable and keeps blanks at the bottom in both directions', () => {
    type R = { n: string; v: number | null };
    const col: ColumnDef<R> = { id: 'v', label: 'V', sortValue: (r) => r.v, render: () => null };
    const rows: R[] = [
      { n: 'a', v: 3 },
      { n: 'b', v: null },
      { n: 'c', v: 1 },
      { n: 'd', v: 3 },
    ];
    expect(sortRows(rows, col, 'asc').map((r) => r.n)).toEqual(['c', 'a', 'd', 'b']);
    expect(sortRows(rows, col, 'desc').map((r) => r.n)).toEqual(['a', 'd', 'c', 'b']);
    expect(sortRows(rows, undefined, 'asc')).toBe(rows);
  });
});
