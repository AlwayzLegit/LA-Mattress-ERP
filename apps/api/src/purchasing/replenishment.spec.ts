import { describe, expect, it } from 'vitest';
import { suggestionFor } from './replenishment';

describe('suggestionFor', () => {
  it('suggests nothing for an out-of-stock item with min stock 0 (owner 2026-10-01)', () => {
    expect(
      suggestionFor({ available: 0, onPo: 0, waiting: 0, reorderPoint: 0, reorderQty: null }),
    ).toBeNull();
    expect(
      suggestionFor({ available: 0, onPo: 0, waiting: 0, reorderPoint: null, reorderQty: null }),
    ).toBeNull();
  });

  it('still orders what customers are waiting for at min stock 0', () => {
    expect(
      suggestionFor({ available: 0, onPo: 0, waiting: 2, reorderPoint: 0, reorderQty: null }),
    ).toEqual({ customerQty: 2, stockQty: 0, suggestedQty: 2 });
    expect(
      suggestionFor({ available: 1, onPo: 0, waiting: 2, reorderPoint: 0, reorderQty: null }),
    ).toEqual({ customerQty: 1, stockQty: 0, suggestedQty: 1 });
  });

  it('tops the shelf up to a real minimum', () => {
    expect(
      suggestionFor({ available: 0, onPo: 0, waiting: 0, reorderPoint: 1, reorderQty: null }),
    ).toEqual({ customerQty: 0, stockQty: 2, suggestedQty: 2 });
    expect(
      suggestionFor({ available: 2, onPo: 0, waiting: 0, reorderPoint: 2, reorderQty: 4 }),
    ).toEqual({ customerQty: 0, stockQty: 4, suggestedQty: 4 });
    expect(
      suggestionFor({ available: 3, onPo: 0, waiting: 0, reorderPoint: 2, reorderQty: null }),
    ).toBeNull();
  });
});
