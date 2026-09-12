import { describe, expect, it } from 'vitest';
import {
  defaultSourceFor,
  lineWarning,
  pickerDefaultSource,
  resourceUntouched,
  type SourcedLine,
  type SourcingContext,
} from './pos-sourcing';

const WH = { id: 'wh', name: 'Warehouse', locationType: 'warehouse' };
const GLENDALE = { id: 'gl', name: 'Glendale Store', locationType: 'store' };
const KTOWN = { id: 'kt', name: 'Koreatown', locationType: 'store' };
const WESTLA = { id: 'wl', name: 'West LA', locationType: 'store' };
const ctx = (over: Partial<SourcingContext> = {}): SourcingContext => ({
  orderLocationId: 'gl',
  orderFulfillment: 'delivery',
  locations: [WH, GLENDALE, KTOWN, WESTLA],
  ...over,
});
const line = (over: Partial<SourcedLine> = {}): SourcedLine => ({
  fulfillmentMethod: '',
  sourceLocationId: '',
  sourceTouched: false,
  lineType: 'stock',
  ...over,
});

// Numbers refer to the handoff's test matrix (§5).
describe('sourcing defaults', () => {
  it('1 — delivery order: a new line sources from the warehouse', () => {
    expect(resourceUntouched([line()], ctx())[0]!.sourceLocationId).toBe('wh');
  });
  it('2 — line set to take-with flips to the order store', () => {
    const [l] = resourceUntouched([line({ fulfillmentMethod: 'take_with' })], ctx());
    expect(l!.sourceLocationId).toBe('gl');
  });
  it('3 — back to delivery returns to the warehouse', () => {
    const [l] = resourceUntouched(
      [line({ fulfillmentMethod: 'delivery', sourceLocationId: 'gl' })],
      ctx(),
    );
    expect(l!.sourceLocationId).toBe('wh');
  });
  it('4 — a touched line is never moved', () => {
    const touched = line({
      sourceLocationId: 'kt',
      sourceTouched: true,
      fulfillmentMethod: 'take_with',
    });
    expect(resourceUntouched([touched], ctx())[0]).toBe(touched);
    expect(
      lineWarning({
        effective: 'take_with',
        available: 5,
        quantity: 1,
        unitPriceCents: 6900,
        sourceTouched: true,
        sourceLocationId: 'kt',
        orderLocationId: 'gl',
        sourceName: 'Koreatown',
        storeName: 'Glendale Store',
      }),
    ).toEqual({
      tone: 'note',
      text: 'Take-with from Koreatown, not Glendale Store — customer collects there.',
    });
  });
  it('5 — untouched take-with line follows a store change', () => {
    const [l] = resourceUntouched(
      [line({ fulfillmentMethod: 'take_with', sourceLocationId: 'gl' })],
      ctx({ orderLocationId: 'wl' }),
    );
    expect(l!.sourceLocationId).toBe('wl');
  });
  it('6 — take-with order: the picker opens from the order store', () => {
    expect(pickerDefaultSource(ctx({ orderFulfillment: 'take_with' }))).toBe('gl');
    expect(pickerDefaultSource(ctx())).toBe('wh');
  });
  it('7 — "Same as order" inherits take-with', () => {
    const [l] = resourceUntouched([line()], ctx({ orderFulfillment: 'take_with' }));
    expect(l!.sourceLocationId).toBe('gl');
  });
  it('8 — no warehouse: falls back to the store, never blank', () => {
    const noWh = ctx({ locations: [GLENDALE, KTOWN] });
    expect(defaultSourceFor('delivery', noWh)).toBe('gl');
    const twoWh = ctx({ locations: [WH, { ...WH, id: 'wh2', name: 'Annex' }, GLENDALE] });
    expect(defaultSourceFor('delivery', twoWh)).toBe('gl');
  });
  it('business default beats the warehouse', () => {
    expect(defaultSourceFor('delivery', ctx({ defaultSourceLocationId: 'kt' }))).toBe('kt');
    // …but a stale id that no longer exists is ignored.
    expect(defaultSourceFor('delivery', ctx({ defaultSourceLocationId: 'gone' }))).toBe('wh');
  });
  it('9 — take-with short at the store gets its own copy', () => {
    expect(
      lineWarning({
        effective: 'take_with',
        available: 0,
        quantity: 1,
        unitPriceCents: 129900,
        sourceTouched: false,
        sourceLocationId: 'gl',
        orderLocationId: 'gl',
        sourceName: 'Glendale Store',
        storeName: 'Glendale Store',
      })?.text,
    ).toBe(
      'Take-with: 0 available at Glendale Store. Change the source location or the fulfillment type.',
    );
  });
  it('custom fee lines never re-source', () => {
    const fee = line({ lineType: 'custom' });
    expect(resourceUntouched([fee], ctx())[0]).toBe(fee);
  });
});
