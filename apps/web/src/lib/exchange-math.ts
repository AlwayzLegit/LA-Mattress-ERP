/**
 * Enter an Exchange — the on-screen settlement estimate (PLAN-POS-
 * OPERATIONS §10). The server computes the exact numbers when the
 * documents are written; these mirror its rules so the register shows
 * the customer the right shape of the deal before anything is saved.
 */

export interface ReturnableLine {
  quantity: number;
  qtyFulfilled: number;
  qtyReturned: number;
  /** Line total after discounts, cents. */
  totalCents: number;
  taxCents: number;
}

/** Units that can still come back: delivered minus already returned. */
export function returnableQty(l: ReturnableLine): number {
  return Math.max(0, l.qtyFulfilled - l.qtyReturned);
}

/**
 * The credit per unit is what the customer actually paid for it — line
 * total (after discounts) plus its tax share — matching the server's
 * per-unit computation at return authorization.
 */
export function perUnitCreditCents(l: ReturnableLine): number {
  if (l.quantity <= 0) return 0;
  return Math.round((l.totalCents + l.taxCents) / l.quantity);
}

export function returnCreditCents<T extends ReturnableLine & { id: string }>(
  lines: T[],
  returnQty: Record<string, number>,
): number {
  return lines.reduce((sum, l) => {
    const q = Math.min(Math.max(0, returnQty[l.id] ?? 0), returnableQty(l));
    return sum + perUnitCreditCents(l) * q;
  }, 0);
}

export interface ExchangeSettlement {
  /** Credit after the restocking fee, floored at zero. */
  creditCents: number;
  /** The part of the credit the replacement absorbs. */
  creditAppliedCents: number;
  /** Replacement total minus the applied credit. */
  customerOwesCents: number;
  /** Credit left after the replacement — goes back per the refund tender. */
  creditBackCents: number;
}

export function exchangeSettlement(input: {
  replacementTotalCents: number;
  returnCreditCents: number;
  restockingFeeCents?: number;
}): ExchangeSettlement {
  const total = Math.max(0, input.replacementTotalCents);
  const creditCents = Math.max(
    0,
    input.returnCreditCents - Math.max(0, input.restockingFeeCents ?? 0),
  );
  const creditAppliedCents = Math.min(creditCents, total);
  return {
    creditCents,
    creditAppliedCents,
    customerOwesCents: total - creditAppliedCents,
    creditBackCents: creditCents - creditAppliedCents,
  };
}
