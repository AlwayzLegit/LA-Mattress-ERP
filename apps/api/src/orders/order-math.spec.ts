import { describe, expect, it } from 'vitest';
import { computeTotals } from '../sales/totals';
import {
  balanceDueCents,
  defaultDepositCents,
  deriveFulfillmentStatus,
  isLiveOrderStatus,
  paidCents,
  returnsSettledCents,
  planReleases,
  planReservations,
  type ReservableLine,
  type StockLevel,
  planFulfillment,
  remainingFulfillment,
  type FulfillableStockLine,
} from './order-math';

const succeeded = (amountCents: number) => ({ amountCents, status: 'succeeded' });

function levels(entries: Record<string, StockLevel>): Map<string, StockLevel> {
  return new Map(Object.entries(entries));
}

function line(over: Partial<ReservableLine> & { id: string }): ReservableLine {
  return {
    variantId: 'v1',
    quantity: 1,
    qtyReserved: 0,
    lineType: 'stock',
    ...over,
  };
}

describe('paidCents / balanceDueCents', () => {
  it('sums only succeeded payments', () => {
    const payments = [
      succeeded(25_000),
      { amountCents: 10_000, status: 'pending' },
      { amountCents: 5_000, status: 'failed' },
      succeeded(1_000),
    ];
    expect(paidCents(payments)).toBe(26_000);
  });

  it('is zero for an order with no payments', () => {
    expect(paidCents([])).toBe(0);
    expect(balanceDueCents(99_999, [])).toBe(99_999);
  });

  it('reports the remaining balance after a deposit', () => {
    // $1,299.99 sofa, 25% down.
    expect(balanceDueCents(129_999, [succeeded(32_500)])).toBe(97_499);
  });

  it('reads zero — not negative — when the customer overpaid', () => {
    // A negative balance would offset other orders in an AR total.
    expect(balanceDueCents(10_000, [succeeded(12_000)])).toBe(0);
  });

  it('reaches exactly zero when the balance is collected in full', () => {
    expect(balanceDueCents(129_999, [succeeded(32_500), succeeded(97_499)])).toBe(0);
  });

  // Owner amendment 2026-10-31: a completed return settles its value on
  // the order, so a refund to the original tenders is not re-owed.
  it('a return refunded to original tenders leaves a paid-in-full order at zero', () => {
    // LB-11230: $3,047.23 paid, one $328.49 line returned and refunded.
    const payments = [succeeded(304_723), succeeded(-32_849)];
    const settled = returnsSettledCents([
      { status: 'completed', amountCents: 32_849, creditOutCents: 0 },
    ]);
    expect(settled).toBe(32_849);
    expect(balanceDueCents(304_723, payments, settled)).toBe(0);
  });

  it('a store-credit refund settles nothing on the order itself', () => {
    const settled = returnsSettledCents([
      { status: 'completed', amountCents: 32_849, creditOutCents: 32_849 },
    ]);
    expect(settled).toBe(0);
    // Paid in full: nothing owed, and the credit lives on the ledger.
    expect(balanceDueCents(304_723, [succeeded(304_723)], settled)).toBe(0);
    // Half paid: the goods kept are still owed; the credit is separate.
    expect(balanceDueCents(100_000, [succeeded(40_000)], settled)).toBe(60_000);
  });

  it('an exchange counts only the credit that stayed out as settled', () => {
    // $1,000 returned into an exchange, $400 applied to the replacement,
    // the $600 leftover refunded to the card (refund rows on the order).
    const payments = [succeeded(100_000), succeeded(-60_000)];
    const settled = returnsSettledCents([
      { status: 'completed', amountCents: 100_000, creditOutCents: 100_000 - 60_000 },
    ]);
    expect(settled).toBe(60_000);
    expect(balanceDueCents(100_000, payments, settled)).toBe(0);
  });

  it('ignores returns that are only authorized or cancelled', () => {
    expect(
      returnsSettledCents([
        { status: 'authorized', amountCents: 5_000, creditOutCents: 0 },
        { status: 'cancelled', amountCents: 5_000, creditOutCents: 0 },
      ]),
    ).toBe(0);
  });
});

describe('defaultDepositCents', () => {
  it('applies the policy rate', () => {
    expect(defaultDepositCents(100_000, 2500)).toBe(25_000);
  });

  it('rounds up so the store never under-collects', () => {
    // 25% of $999.99 is $249.9975 — ask for $250.00.
    expect(defaultDepositCents(99_999, 2500)).toBe(25_000);
  });

  it('never exceeds the order total', () => {
    expect(defaultDepositCents(5_000, 10_000)).toBe(5_000);
  });

  it('handles a zero-deposit policy and a zero-total order', () => {
    expect(defaultDepositCents(100_000, 0)).toBe(0);
    expect(defaultDepositCents(0, 2500)).toBe(0);
  });

  it('rejects a nonsense rate or total', () => {
    expect(() => defaultDepositCents(100, 10_001)).toThrow(/depositRateBps/);
    expect(() => defaultDepositCents(-1, 2500)).toThrow(/totalCents/);
    expect(() => defaultDepositCents(100.5, 2500)).toThrow(/totalCents/);
  });
});

describe('planReservations', () => {
  it('commits a line in full when stock covers it', () => {
    const plan = planReservations(
      [line({ id: 'l1', quantity: 3 })],
      levels({ v1: { onHand: 10, reserved: 0 } }),
    );
    expect(plan.reservations).toEqual([{ orderLineId: 'l1', variantId: 'v1', quantity: 3 }]);
    expect(plan.shortfalls).toEqual([]);
  });

  it('only counts stock that is not already promised elsewhere', () => {
    // 10 on hand, 8 already committed to other orders → 2 available.
    const plan = planReservations(
      [line({ id: 'l1', quantity: 5 })],
      levels({ v1: { onHand: 10, reserved: 8 } }),
    );
    expect(plan.reservations).toEqual([{ orderLineId: 'l1', variantId: 'v1', quantity: 2 }]);
    expect(plan.shortfalls).toEqual([{ orderLineId: 'l1', variantId: 'v1', quantity: 3 }]);
  });

  it('reports the whole line short when nothing is available', () => {
    const plan = planReservations(
      [line({ id: 'l1', quantity: 2 })],
      levels({ v1: { onHand: 0, reserved: 0 } }),
    );
    expect(plan.reservations).toEqual([]);
    expect(plan.shortfalls).toEqual([{ orderLineId: 'l1', variantId: 'v1', quantity: 2 }]);
  });

  it('treats a variant with no inventory row as zero available', () => {
    const plan = planReservations([line({ id: 'l1', quantity: 4 })], levels({}));
    expect(plan.reservations).toEqual([]);
    expect(plan.shortfalls[0]!.quantity).toBe(4);
  });

  it('never lets over-committed stock read as available', () => {
    // A prior bug or a manual adjustment could leave reserved > on_hand.
    const plan = planReservations(
      [line({ id: 'l1', quantity: 1 })],
      levels({ v1: { onHand: 2, reserved: 5 } }),
    );
    expect(plan.reservations).toEqual([]);
    expect(plan.shortfalls[0]!.quantity).toBe(1);
  });

  it('only asks for the units a partially reserved line still lacks', () => {
    const plan = planReservations(
      [line({ id: 'l1', quantity: 5, qtyReserved: 3 })],
      levels({ v1: { onHand: 10, reserved: 3 } }),
    );
    expect(plan.reservations).toEqual([{ orderLineId: 'l1', variantId: 'v1', quantity: 2 }]);
  });

  it('is a no-op for a line that is already fully reserved', () => {
    // This is what makes the reserve endpoint safe to call twice.
    const plan = planReservations(
      [line({ id: 'l1', quantity: 4, qtyReserved: 4 })],
      levels({ v1: { onHand: 10, reserved: 4 } }),
    );
    expect(plan.reservations).toEqual([]);
    expect(plan.shortfalls).toEqual([]);
  });

  it('skips special-order lines entirely — we do not own those units', () => {
    const plan = planReservations(
      [line({ id: 'l1', quantity: 2, lineType: 'special_order' })],
      levels({ v1: { onHand: 10, reserved: 0 } }),
    );
    expect(plan.reservations).toEqual([]);
    expect(plan.shortfalls).toEqual([]);
  });

  it('skips lines with no variant (free-text charges)', () => {
    const plan = planReservations(
      [line({ id: 'l1', variantId: null, quantity: 1 })],
      levels({ v1: { onHand: 10, reserved: 0 } }),
    );
    expect(plan.reservations).toEqual([]);
    expect(plan.shortfalls).toEqual([]);
  });

  it('draws two lines of the same variant from one pool', () => {
    // Both lines want the last 3 units; the second must not double-book.
    const plan = planReservations(
      [line({ id: 'l1', quantity: 2 }), line({ id: 'l2', quantity: 2 })],
      levels({ v1: { onHand: 3, reserved: 0 } }),
    );
    expect(plan.reservations).toEqual([
      { orderLineId: 'l1', variantId: 'v1', quantity: 2 },
      { orderLineId: 'l2', variantId: 'v1', quantity: 1 },
    ]);
    expect(plan.shortfalls).toEqual([{ orderLineId: 'l2', variantId: 'v1', quantity: 1 }]);
  });

  it('keeps separate variants independent', () => {
    const plan = planReservations(
      [
        line({ id: 'l1', variantId: 'v1', quantity: 2 }),
        line({ id: 'l2', variantId: 'v2', quantity: 2 }),
      ],
      levels({ v1: { onHand: 1, reserved: 0 }, v2: { onHand: 5, reserved: 0 } }),
    );
    expect(plan.reservations).toEqual([
      { orderLineId: 'l1', variantId: 'v1', quantity: 1 },
      { orderLineId: 'l2', variantId: 'v2', quantity: 2 },
    ]);
    expect(plan.shortfalls).toEqual([{ orderLineId: 'l1', variantId: 'v1', quantity: 1 }]);
  });
});

describe('planReleases', () => {
  it('releases exactly what each line holds', () => {
    expect(
      planReleases([
        line({ id: 'l1', quantity: 5, qtyReserved: 3 }),
        line({ id: 'l2', variantId: 'v2', quantity: 2, qtyReserved: 2 }),
      ]),
    ).toEqual([
      { orderLineId: 'l1', variantId: 'v1', quantity: 3 },
      { orderLineId: 'l2', variantId: 'v2', quantity: 2 },
    ]);
  });

  it('ignores lines holding nothing', () => {
    expect(planReleases([line({ id: 'l1', quantity: 5, qtyReserved: 0 })])).toEqual([]);
  });

  it('round-trips a reservation back to zero', () => {
    const stock = levels({ v1: { onHand: 4, reserved: 0 } });
    const plan = planReservations([line({ id: 'l1', quantity: 4 })], stock);
    const reserved = plan.reservations[0]!.quantity;
    const releases = planReleases([line({ id: 'l1', quantity: 4, qtyReserved: reserved })]);
    expect(releases[0]!.quantity).toBe(reserved);
  });
});

describe('deriveFulfillmentStatus', () => {
  it('is open while nothing has shipped', () => {
    expect(deriveFulfillmentStatus([{ quantity: 2, qtyFulfilled: 0 }])).toBe('open');
  });

  it('is partially_fulfilled when one line went out', () => {
    expect(
      deriveFulfillmentStatus([
        { quantity: 2, qtyFulfilled: 2 },
        { quantity: 1, qtyFulfilled: 0 },
      ]),
    ).toBe('partially_fulfilled');
  });

  it('is partially_fulfilled on a split line', () => {
    expect(deriveFulfillmentStatus([{ quantity: 4, qtyFulfilled: 1 }])).toBe('partially_fulfilled');
  });

  it('is fulfilled once every line is out the door', () => {
    expect(
      deriveFulfillmentStatus([
        { quantity: 2, qtyFulfilled: 2 },
        { quantity: 1, qtyFulfilled: 1 },
      ]),
    ).toBe('fulfilled');
  });

  it('treats an empty order as open, not fulfilled', () => {
    expect(deriveFulfillmentStatus([])).toBe('open');
  });
});

describe('isLiveOrderStatus', () => {
  it('accepts every status that can still change', () => {
    for (const s of ['quote', 'open', 'partially_fulfilled', 'fulfilled']) {
      expect(isLiveOrderStatus(s)).toBe(true);
    }
  });

  it('rejects finished orders', () => {
    expect(isLiveOrderStatus('completed')).toBe(false);
    expect(isLiveOrderStatus('cancelled')).toBe(false);
  });
});

describe('order totals reuse the POS cart math', () => {
  it('prices a two-line order with tax the way a sale would', () => {
    // Sprint decision D1 keeps orders and sales as separate aggregates,
    // but the arithmetic behind a line has to stay identical — otherwise
    // the same sofa is taxed differently depending on how it was sold.
    const totals = computeTotals({
      taxRateBps: 0,
      lines: [
        {
          variantId: 'v1',
          description: 'Sofa',
          quantity: 1,
          unitPriceCents: 129_999,
          taxRateBps: 700,
        },
        {
          variantId: 'v2',
          description: 'Delivery',
          quantity: 1,
          unitPriceCents: 9_900,
          taxRateBps: 0,
        },
      ],
    });
    expect(totals.subtotalCents).toBe(139_899);
    expect(totals.taxCents).toBe(9_100); // round(129999 * 0.07)
    expect(totals.totalCents).toBe(148_999);
  });

  it('deposit and balance add back up to the order total', () => {
    const totals = computeTotals({
      taxRateBps: 700,
      lines: [{ variantId: 'v1', description: 'Sofa', quantity: 1, unitPriceCents: 129_999 }],
    });
    const deposit = defaultDepositCents(totals.totalCents, 2500);
    const balance = balanceDueCents(totals.totalCents, [succeeded(deposit)]);
    expect(deposit + balance).toBe(totals.totalCents);
  });

  it('allocates an order discount pro-rata across lines', () => {
    const totals = computeTotals({
      taxRateBps: 1000,
      orderDiscountCents: 10_000,
      lines: [
        { variantId: 'v1', description: 'Sofa', quantity: 1, unitPriceCents: 90_000 },
        { variantId: 'v2', description: 'Chair', quantity: 1, unitPriceCents: 10_000 },
      ],
    });
    expect(totals.subtotalCents).toBe(100_000);
    expect(totals.discountCents).toBe(10_000);
    // Tax is assessed on the discounted base: 90,000 → 81,000 and
    // 10,000 → 9,000, so 10% of 90,000.
    expect(totals.taxCents).toBe(9_000);
    expect(totals.totalCents).toBe(99_000);
  });
});

describe('planFulfillment', () => {
  const line = (over: Partial<FulfillableStockLine> = {}): FulfillableStockLine => ({
    id: 'L1',
    variantId: 'V1',
    quantity: 3,
    qtyReserved: 3,
    qtyFulfilled: 0,
    ...over,
  });

  it('fulfills within the reservation', () => {
    const { steps, errors } = planFulfillment([line()], [{ orderLineId: 'L1', quantity: 2 }]);
    expect(errors).toEqual([]);
    expect(steps).toEqual([{ orderLineId: 'L1', variantId: 'V1', quantity: 2, fromReserved: 2 }]);
  });

  it('caps reserved consumption at what was actually reserved', () => {
    const { steps } = planFulfillment(
      [line({ qtyReserved: 1 })],
      [{ orderLineId: 'L1', quantity: 3 }],
    );
    expect(steps[0]).toEqual({ orderLineId: 'L1', variantId: 'V1', quantity: 3, fromReserved: 1 });
  });

  it('rejects over-fulfillment past the unfulfilled remainder', () => {
    const { steps, errors } = planFulfillment(
      [line({ qtyFulfilled: 2 })],
      [{ orderLineId: 'L1', quantity: 2 }],
    );
    expect(steps).toEqual([]);
    expect(errors[0]).toMatch(/only 1 unfulfilled/);
  });

  it('rejects unknown lines, duplicates, and non-positive quantities', () => {
    const { errors } = planFulfillment(
      [line()],
      [
        { orderLineId: 'NOPE', quantity: 1 },
        { orderLineId: 'L1', quantity: 0 },
        { orderLineId: 'L1', quantity: 1 },
      ],
    );
    // Unknown line, zero quantity, and the duplicate — the first L1 entry
    // claims the slot even though its quantity was invalid, so the retry
    // is reported as a duplicate rather than silently taking its place.
    expect(errors).toHaveLength(3);
  });

  it('remainingFulfillment asks for exactly what is still owed', () => {
    const lines = [line({ id: 'A', qtyFulfilled: 1 }), line({ id: 'B', qtyFulfilled: 3 })];
    expect(remainingFulfillment(lines)).toEqual([{ orderLineId: 'A', quantity: 2 }]);
  });
});
