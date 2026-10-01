import { describe, expect, it } from 'vitest';
import { stageSuggestion, suggestionBreakdown, type ReorderSuggestion } from './stage-suggestion';

const royalSands: ReorderSuggestion = {
  variantId: 'v1',
  productName: 'TWINXL ROYAL SANDS FIRM',
  variantName: null,
  sku: '7786-3X',
  available: 0,
  reorderPoint: 0,
  waitingQty: 2,
  waitingOrders: [
    {
      orderLineId: 'ol1',
      orderId: 'o1',
      orderNumber: 'KO-10050',
      customerName: 'Ana',
      quantity: 2,
    },
  ],
  onPoQty: 0,
  customerQty: 2,
  stockQty: 1,
  suggestedQty: 3,
  unitCostCents: 47_000,
};

describe('stageSuggestion', () => {
  it('stages the customer units linked to their order and the top-up as stock', () => {
    expect(stageSuggestion(royalSands, [])).toEqual([
      {
        variantId: 'v1',
        description: 'TWINXL ROYAL SANDS FIRM',
        sku: '7786-3X',
        quantity: 2,
        unitCostStr: '470.00',
        orderLineId: 'ol1',
        orderNumber: 'KO-10050',
      },
      {
        variantId: 'v1',
        description: 'TWINXL ROYAL SANDS FIRM',
        sku: '7786-3X',
        quantity: 1,
        unitCostStr: '470.00',
      },
    ]);
  });

  it('splits oldest order first and never stages a line twice', () => {
    const s: ReorderSuggestion = {
      ...royalSands,
      waitingOrders: [
        { orderLineId: 'a', orderId: 'oa', orderNumber: 'KO-1', customerName: null, quantity: 2 },
        { orderLineId: 'b', orderId: 'ob', orderNumber: 'KO-2', customerName: null, quantity: 2 },
      ],
      waitingQty: 4,
      customerQty: 3, // one unit is free on the shelf
      stockQty: 0,
      suggestedQty: 3,
    };
    expect(stageSuggestion(s, []).map((l) => [l.orderLineId, l.quantity])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(stageSuggestion(s, [{ variantId: 'v1', orderLineId: 'a' }])).toHaveLength(1);
    expect(stageSuggestion(royalSands, [{ variantId: 'v1' }]).every((l) => l.orderLineId)).toBe(
      true,
    );
  });

  it('treats an older API response as all shelf stock', () => {
    const old: ReorderSuggestion = { ...royalSands, suggestedQty: 1 };
    delete old.customerQty;
    delete old.stockQty;
    delete old.waitingOrders;
    const staged = stageSuggestion(old, []);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ quantity: 1 });
    expect(staged[0]!.orderLineId).toBeUndefined();
  });
});

describe('suggestionBreakdown', () => {
  it('says who the units are for', () => {
    expect(suggestionBreakdown(royalSands)).toBe('2 for KO-10050 + 1 for stock');
    expect(suggestionBreakdown({ ...royalSands, customerQty: 0 })).toBeNull();
  });
});
