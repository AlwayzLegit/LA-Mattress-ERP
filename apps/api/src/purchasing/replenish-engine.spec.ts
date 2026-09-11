import { describe, expect, it } from 'vitest';
import {
  allocatedNeed,
  availableOf,
  cartonRound,
  stockLevelNeed,
  type ReplenishOptions,
} from './replenish-engine';

const base: ReplenishOptions = {
  includeFloorSamples: false,
  includeReturns: false,
  roundToCarton: false,
};
const cell = { onHand: 10, reserved: 4, floorSample: 2, asIsPending: 3, netOnPo: 0 };

describe('availableOf', () => {
  it('nets reserved and floor samples by default', () => {
    expect(availableOf(cell, base)).toBe(4);
  });
  it('adds floor samples and returns back in when asked', () => {
    expect(availableOf(cell, { ...base, includeFloorSamples: true })).toBe(6);
    expect(availableOf(cell, { ...base, includeReturns: true })).toBe(7);
    expect(availableOf(cell, { ...base, includeFloorSamples: true, includeReturns: true })).toBe(9);
  });
});

describe('allocatedNeed', () => {
  it('orders the uncovered shortfall less free stock and open POs', () => {
    expect(allocatedNeed(5, 2, 1)).toBe(2);
    expect(allocatedNeed(5, 10, 0)).toBe(0);
  });
  it('treats negative stock and negative net PO as zero', () => {
    expect(allocatedNeed(5, -3, -2)).toBe(5);
  });
});

describe('stockLevelNeed', () => {
  it('tops the position up to the threshold', () => {
    expect(stockLevelNeed(10, 3, 2, null)).toBe(5);
    expect(stockLevelNeed(10, 8, 2, null)).toBe(0);
  });
  it('orders at least the reorder quantity when there is something to order', () => {
    expect(stockLevelNeed(10, 3, 2, 12)).toBe(12);
    expect(stockLevelNeed(10, 12, 0, 12)).toBe(0);
  });
});

describe('cartonRound', () => {
  it('reports whole cartons and rounds only when asked', () => {
    expect(cartonRound(7, 4, false)).toEqual({ cartonQty: 4, cartons: 2, totalQty: 7 });
    expect(cartonRound(7, 4, true)).toEqual({ cartonQty: 4, cartons: 2, totalQty: 8 });
    expect(cartonRound(8, 4, true)).toEqual({ cartonQty: 4, cartons: 2, totalQty: 8 });
  });
  it('treats a missing or zero carton as single units', () => {
    expect(cartonRound(3, null, true)).toEqual({ cartonQty: 1, cartons: 3, totalQty: 3 });
    expect(cartonRound(3, 0, true)).toEqual({ cartonQty: 1, cartons: 3, totalQty: 3 });
    expect(cartonRound(0, 6, true)).toEqual({ cartonQty: 6, cartons: 0, totalQty: 0 });
  });
});
