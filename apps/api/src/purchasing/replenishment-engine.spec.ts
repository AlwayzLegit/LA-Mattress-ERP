/**
 * Acceptance tests T-01…T-26 (pure-engine subset) from
 * docs/HANDOFF-po-replenishment-sales-rate §8, ported verbatim.
 * Defaults per the spec: MinimumStockDays 14, LeadDays 21,
 * ExcludeWeekends false, 8-week window, Variance 100, MinimumSalesRate 0,
 * standard rounding ON, IncludeAllBackOrders false, on hand 45,
 * committed 15, on order 5, 80 sold / 0 returned over 8 weeks ⇒ rate 10.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateRow,
  runReplenishment,
  salesWindow,
  validateCriteria,
  vendorRunsToday,
  ReplenishmentValidationError,
  type ReplenishmentControl,
  type ReplenishmentProduct,
  type RunCriteria,
  type VendorReplenishment,
} from './replenishment-engine';

function control(over: Partial<ReplenishmentControl> = {}): ReplenishmentControl {
  return {
    unitSalesRateCalculation: 'written',
    excludeWeekendsInVendorLeadDays: false,
    standardRounding: true,
    includeStoreStockInAvailability: false,
    layawayInNetPurchaseOrder: false,
    ...over,
  };
}

function vendor(over: Partial<VendorReplenishment> = {}): VendorReplenishment {
  return {
    generateAutomaticPos: true,
    automaticallyHoldPos: false,
    weeklySalesRateWeeks: 8,
    includeAllBackOrders: false,
    daysForReplenishment: null,
    minimumStockDays: 14,
    leadDays: 21,
    variancePercent: 100,
    minimumSalesRate: 0,
    buildDays: [1, 2, 3, 4, 5],
    ...over,
  };
}

function product(over: Partial<ReplenishmentProduct> = {}): ReplenishmentProduct {
  return {
    variantId: 'v1',
    categoryId: null,
    unitsSold: 80,
    unitsReturned: 0,
    warehouseOnHand: 45,
    warehouseCommitted: 15,
    storeStockAvailable: 0,
    onOrder: 5,
    uncommittedDemand: 0,
    dueSoonDemand: 0,
    inboundTransfers: 0,
    layawayUnits: 0,
    ...over,
  };
}

function criteria(over: Partial<RunCriteria> = {}): RunCriteria {
  return {
    salesWindow: 'this_year_prior',
    includeOverstocks: false,
    includeServiceItems: false,
    ...over,
  };
}

describe('sales-rate replenishment engine — §8 acceptance tests', () => {
  it('T-01 baseline: Required 20, Additional 30, Available 30, NetPO 5 → Order 15', () => {
    const row = calculateRow(product(), vendor(), control(), criteria())!;
    expect(row.required).toBe(20);
    expect(row.additional).toBe(30);
    expect(row.available).toBe(30);
    expect(row.netPo).toBe(5);
    expect(row.orderQty).toBe(15);
  });

  it('T-02 ExcludeWeekends: Additional (21/5)*10 = 42 → Order 27; Required stays 20', () => {
    const row = calculateRow(
      product(),
      vendor(),
      control({ excludeWeekendsInVendorLeadDays: true }),
      criteria(),
    )!;
    expect(row.required).toBe(20); // the ÷7 in Required never changes
    expect(row.additional).toBe(42);
    expect(row.orderQty).toBe(27);
  });

  it('T-03 Variance 50: rate 5 → Order −10, suppressed unless Include Overstocks, never on a PO', () => {
    const rows = runReplenishment(
      [product()],
      vendor(),
      control(),
      criteria({ variancePercent: 50 }),
    );
    expect(rows).toEqual([]); // suppressed
    const shown = runReplenishment(
      [product()],
      vendor(),
      control(),
      criteria({ variancePercent: 50, includeOverstocks: true }),
    );
    expect(shown[0]!.required).toBe(10);
    expect(shown[0]!.additional).toBe(15);
    expect(shown[0]!.orderQty).toBe(-10);
  });

  it('T-04 Variance 200: rate 20 → Required 40, Additional 60 → Order 65', () => {
    const row = calculateRow(product(), vendor(), control(), criteria({ variancePercent: 200 }))!;
    expect(row.required).toBe(40);
    expect(row.additional).toBe(60);
    expect(row.orderQty).toBe(65);
  });

  it('T-05 MinimumSalesRate 12 vs rate 10: row absent entirely', () => {
    const row = calculateRow(product(), vendor({ minimumSalesRate: 12 }), control(), criteria());
    expect(row).toBeNull();
  });

  it('T-06 the negative-NetPO sign convention: zero forecast + 40 uncommitted → Order 35', () => {
    const row = calculateRow(
      product({
        warehouseOnHand: 0,
        warehouseCommitted: 0,
        onOrder: 5,
        uncommittedDemand: 40,
      }),
      vendor({ minimumStockDays: 0, leadDays: 0, includeAllBackOrders: true }),
      control(),
      criteria(),
    )!;
    expect(row.required).toBe(0);
    expect(row.additional).toBe(0);
    expect(row.available).toBe(0);
    expect(row.netPo).toBe(-35); // 5 − 40; never clamped
    expect(row.orderQty).toBe(35);
  });

  it('T-07 layaway joins the subtraction when the control says so → Order 45', () => {
    const row = calculateRow(
      product({
        warehouseOnHand: 0,
        warehouseCommitted: 0,
        onOrder: 5,
        uncommittedDemand: 40,
        layawayUnits: 10,
      }),
      vendor({ minimumStockDays: 0, leadDays: 0, includeAllBackOrders: true }),
      control({ layawayInNetPurchaseOrder: true }),
      criteria(),
    )!;
    expect(row.netPo).toBe(-45);
    expect(row.orderQty).toBe(45);
  });

  it('T-08 rounding is per column: rate 3.3, 14/14 days → 7 + 7 = 14, never 13', () => {
    // 26.4 sold / 8 weeks = 3.3/week; (14/7)*3.3 = 6.6 per column.
    const row = calculateRow(
      product({
        unitsSold: 26.4 as unknown as number,
        warehouseOnHand: 0,
        warehouseCommitted: 0,
        onOrder: 0,
      }),
      vendor({ minimumStockDays: 14, leadDays: 14 }),
      control(),
      criteria(),
    )!;
    expect(row.required).toBe(7);
    expect(row.additional).toBe(7);
    expect(row.required + row.additional).toBe(14);
  });

  it('T-09 rounding off truncates: 6 + 6 = 12 (inferred — flagged in open questions)', () => {
    const row = calculateRow(
      product({
        unitsSold: 26.4 as unknown as number,
        warehouseOnHand: 0,
        warehouseCommitted: 0,
        onOrder: 0,
      }),
      vendor({ minimumStockDays: 14, leadDays: 14 }),
      control({ standardRounding: false }),
      criteria(),
    )!;
    expect(row.required).toBe(6);
    expect(row.additional).toBe(6);
  });

  it('T-10/T-11: onOrder carries supply-eligible units — held POs included (callers build the figure)', () => {
    // Jetnine has no PO types; every open PO is supply. The held-PO rule
    // (T-11) is baked into the onOrder input the data layer supplies.
    const base = calculateRow(product(), vendor(), control(), criteria())!;
    const without = calculateRow(product({ onOrder: 25 }), vendor(), control(), criteria())!;
    expect(base.orderQty - without.orderQty).toBe(20); // 20 extra inbound units cut the order by 20
  });

  it('T-12/T-13: kit masters and discontinued products are absent; components evaluated alone', () => {
    expect(calculateRow(product({ kitMaster: true }), vendor(), control(), criteria())).toBeNull();
    expect(
      calculateRow(product({ discontinued: true }), vendor(), control(), criteria()),
    ).toBeNull();
    expect(calculateRow(product(), vendor(), control(), criteria())).not.toBeNull();
  });

  it('T-15 Include Overstocks shows negatives but they never make a PO (poLines filter is qty > 0)', () => {
    const rows = runReplenishment(
      [
        product({ variantId: 'a' }),
        product({ variantId: 'b', warehouseOnHand: 200 }),
        product({ variantId: 'c', warehouseOnHand: 65 }),
      ],
      vendor(),
      control(),
      criteria({ includeOverstocks: true }),
    );
    expect(rows.map((r) => r.orderQty)).toEqual([15, -140, -5]);
    const poEligible = rows.filter((r) => r.orderQty > 0);
    expect(poEligible.map((r) => r.variantId)).toEqual(['a']);
  });

  it('T-16 products AND vendor model together → validation error', () => {
    expect(() =>
      validateCriteria(criteria({ productIds: ['x'], vendorModel: 'M1' }), vendor()),
    ).toThrow(ReplenishmentValidationError);
  });

  it('T-17 IncludeAllBackOrders + DaysForReplenishment → validation error, not a no-op', () => {
    expect(() =>
      validateCriteria(
        criteria({ daysForReplenishment: 30 }),
        vendor({ includeAllBackOrders: true }),
      ),
    ).toThrow(ReplenishmentValidationError);
  });

  it('T-20 seasonal window: last_year_subsequent = [today−1y, today−1y+8w] with a frozen clock', () => {
    const today = new Date('2026-08-27T00:00:00Z');
    const w = salesWindow(criteria({ salesWindow: 'last_year_subsequent' }), vendor(), today);
    expect(w.start.toISOString().slice(0, 10)).toBe('2025-08-27');
    expect(w.end.toISOString().slice(0, 10)).toBe('2025-10-22'); // +56 days
    const cur = salesWindow(criteria(), vendor(), today);
    expect(cur.start.toISOString().slice(0, 10)).toBe('2026-07-02');
    expect(cur.end.toISOString().slice(0, 10)).toBe('2026-08-27');
  });

  it('T-25/T-26 vendor gates: GenerateAutomaticPOs off, or today not in Build POs → skipped', () => {
    const wed = new Date('2026-08-26T12:00:00Z'); // a Wednesday (3)
    expect(vendorRunsToday(vendor({ generateAutomaticPos: false }), wed)).toBe(false);
    expect(vendorRunsToday(vendor({ buildDays: [0, 6] }), wed)).toBe(false);
    expect(vendorRunsToday(vendor({ buildDays: [3] }), wed)).toBe(true);
  });

  it('category exception hierarchy: exception beats the vendor default', () => {
    const v = vendor({
      categoryExceptions: [{ categoryId: 'cat1', minimumStockDays: 28, leadDays: 7 }],
    });
    const row = calculateRow(product({ categoryId: 'cat1' }), v, control(), criteria())!;
    expect(row.required).toBe(40); // (28/7)*10
    expect(row.additional).toBe(10); // (7/7)*10
    const other = calculateRow(product({ categoryId: 'other' }), v, control(), criteria())!;
    expect(other.required).toBe(20);
  });

  it('category exceptions follow the lineage: the nearest ancestor with a value wins', () => {
    const v = vendor({
      categoryExceptions: [
        { categoryId: 'mattresses', minimumStockDays: 28, leadDays: 7 },
        { categoryId: 'hybrid', leadDays: 14 },
      ],
    });
    // "Mattresses › Hybrid": min-stock days come from the root, lead days from the leaf.
    const hybrid = calculateRow(
      product({ categoryId: 'hybrid', categoryLineage: ['hybrid', 'mattresses'] }),
      v,
      control(),
      criteria(),
    )!;
    expect(hybrid.required).toBe(40); // (28/7)*10
    expect(hybrid.additional).toBe(20); // (14/7)*10
    // A sibling subcategory without its own exception inherits the root's.
    const latex = calculateRow(
      product({ categoryId: 'latex', categoryLineage: ['latex', 'mattresses'] }),
      v,
      control(),
      criteria(),
    )!;
    expect(latex.required).toBe(40);
    expect(latex.additional).toBe(10);
  });

  it('returns subtract from the rate (§9.1 typo decision)', () => {
    const row = calculateRow(
      product({ unitsSold: 80, unitsReturned: 40 }),
      vendor(),
      control(),
      criteria(),
    )!;
    expect(row.salesRate).toBe(5);
  });
});
