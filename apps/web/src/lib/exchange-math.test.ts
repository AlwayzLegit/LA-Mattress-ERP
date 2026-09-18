import { describe, expect, it } from 'vitest';
import {
  exchangeSettlement,
  perUnitCreditCents,
  returnCreditCents,
  returnableQty,
} from './exchange-math';

const line = (over: Partial<Parameters<typeof perUnitCreditCents>[0]> & { id: string }) => ({
  quantity: 2,
  qtyFulfilled: 2,
  qtyReturned: 0,
  totalCents: 180000,
  taxCents: 17100,
  ...over,
});

describe('returnableQty', () => {
  it('is delivered minus already returned, never negative', () => {
    expect(returnableQty(line({ id: 'a' }))).toBe(2);
    expect(returnableQty(line({ id: 'a', qtyReturned: 1 }))).toBe(1);
    expect(returnableQty(line({ id: 'a', qtyFulfilled: 0 }))).toBe(0);
    expect(returnableQty(line({ id: 'a', qtyFulfilled: 1, qtyReturned: 2 }))).toBe(0);
  });
});

describe('perUnitCreditCents', () => {
  it('splits total-after-discount plus tax across the units', () => {
    expect(perUnitCreditCents(line({ id: 'a' }))).toBe(98550);
  });
  it('is zero on a zero-quantity line', () => {
    expect(perUnitCreditCents(line({ id: 'a', quantity: 0 }))).toBe(0);
  });
});

describe('returnCreditCents', () => {
  it('sums picked units and caps at what is returnable', () => {
    const lines = [line({ id: 'a' }), line({ id: 'b', qtyReturned: 1 })];
    expect(returnCreditCents(lines, { a: 1, b: 5 })).toBe(98550 * 2);
    expect(returnCreditCents(lines, {})).toBe(0);
    expect(returnCreditCents(lines, { a: -3 })).toBe(0);
  });
});

describe('exchangeSettlement', () => {
  it('customer owes the difference when the replacement costs more', () => {
    const s = exchangeSettlement({ replacementTotalCents: 250000, returnCreditCents: 197100 });
    expect(s).toEqual({
      creditCents: 197100,
      creditAppliedCents: 197100,
      customerOwesCents: 52900,
      creditBackCents: 0,
    });
  });
  it('credit comes back when the return is worth more', () => {
    const s = exchangeSettlement({ replacementTotalCents: 100000, returnCreditCents: 197100 });
    expect(s.customerOwesCents).toBe(0);
    expect(s.creditAppliedCents).toBe(100000);
    expect(s.creditBackCents).toBe(97100);
  });
  it('a restocking fee reduces the credit, never below zero', () => {
    expect(
      exchangeSettlement({
        replacementTotalCents: 100000,
        returnCreditCents: 50000,
        restockingFeeCents: 5000,
      }).customerOwesCents,
    ).toBe(55000);
    expect(
      exchangeSettlement({
        replacementTotalCents: 100000,
        returnCreditCents: 5000,
        restockingFeeCents: 9000,
      }),
    ).toEqual({
      creditCents: 0,
      creditAppliedCents: 0,
      customerOwesCents: 100000,
      creditBackCents: 0,
    });
  });
});
