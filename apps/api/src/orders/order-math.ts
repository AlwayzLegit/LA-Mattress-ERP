/**
 * Pure order math, shared by the orders controller and (from Day 3) the
 * delivery/fulfillment flow. Nothing here touches the database, so every
 * rule below is unit-testable without a Postgres round-trip.
 *
 * Cart totals themselves are NOT re-implemented — orders reuse
 * `sales/totals.ts` verbatim (sprint decision D1 keeps the two aggregates
 * separate, but the arithmetic behind a line is the same arithmetic).
 * What lives here is what an order has and a cash-and-carry sale does
 * not: money already collected, a balance still owed, a deposit policy,
 * and stock committed rather than sold.
 *
 * All money is integer cents; all rates are basis points (10000 = 100%).
 */

/** Payment statuses that count as money actually collected. */
const COLLECTED_STATUSES = new Set(['succeeded']);

export interface OrderPaymentLike {
  amountCents: number;
  status: string;
}

/**
 * Money actually collected on an order. Pending and failed tenders are
 * not money — only `succeeded` counts, matching how the cash drawer and
 * every revenue report read the payments table.
 */
export function paidCents(payments: readonly OrderPaymentLike[]): number {
  let sum = 0;
  for (const p of payments) {
    if (!COLLECTED_STATUSES.has(p.status)) continue;
    sum += p.amountCents;
  }
  return sum;
}

export interface OrderReturnLike {
  /** 'authorized' | 'completed' | 'cancelled' — only completed returns settle money. */
  status: string;
  /** Refund value of the return (fees already deducted). */
  amountCents: number;
  /**
   * The part of that value handed back as store credit — a plain
   * store-credit refund, or the credit an exchange minted for the
   * replacement — rather than reversed on this order's own tenders.
   * Credit that later left the ledger as a refund on this order is
   * excluded again, because that refund is already a payment row.
   */
  creditOutCents: number;
}

/**
 * Value of completed returns settled against the order itself (owner
 * amendment 2026-10-31, PLAN-POS-OPERATIONS §0): a return refunded to
 * the original tenders writes negative payment rows, so the refund must
 * also come off what the order asks for or the credit counts twice —
 * once as money out, once as a line still on the total. A store-credit
 * refund never touched this order's tenders, so it settles nothing
 * here; the customer holds the credit instead.
 */
export function returnsSettledCents(returns: readonly OrderReturnLike[]): number {
  let sum = 0;
  for (const r of returns) {
    if (r.status !== 'completed') continue;
    sum += Math.max(0, r.amountCents - r.creditOutCents);
  }
  return sum;
}

/**
 * What the customer still owes: total − money collected − value of
 * completed returns settled on this order. Never negative: an
 * overpayment is a refund/credit problem, not a negative balance, and
 * reporting it as a negative number would silently offset other orders
 * in an AR total. `returnsSettled` is `returnsSettledCents(...)` (or the
 * SQL twin in `order-balance.ts`); callers with no returns loaded pass 0
 * only when the order cannot have been returned against (a quote, a
 * brand-new order).
 */
export function balanceDueCents(
  totalCents: number,
  payments: readonly OrderPaymentLike[],
  returnsSettled = 0,
): number {
  return Math.max(0, totalCents - paidCents(payments) - returnsSettled);
}

/**
 * The policy deposit for an order total, rounded up to the cent. Rounding
 * up rather than down means a 25% policy on a $999.99 order asks for
 * $250.00, not $249.99 — the store never under-collects because of
 * rounding.
 */
export function defaultDepositCents(totalCents: number, depositRateBps: number): number {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error('totalCents must be a non-negative integer');
  }
  if (!Number.isInteger(depositRateBps) || depositRateBps < 0 || depositRateBps > 10000) {
    throw new Error('depositRateBps must be an integer between 0 and 10000');
  }
  return Math.min(totalCents, Math.ceil((totalCents * depositRateBps) / 10000));
}

export interface ReservableLine {
  id: string;
  variantId: string | null;
  quantity: number;
  qtyReserved: number;
  /** 'stock' | 'special_order' */
  lineType: string;
}

/** On-hand and already-committed units for one (variant, location). */
export interface StockLevel {
  onHand: number;
  reserved: number;
}

export interface Reservation {
  orderLineId: string;
  variantId: string;
  /** Additional units to commit. Always > 0. */
  quantity: number;
}

export interface Shortfall {
  orderLineId: string;
  variantId: string;
  /** Units the line wanted that stock could not cover. Always > 0. */
  quantity: number;
}

export interface ReservationPlan {
  reservations: Reservation[];
  shortfalls: Shortfall[];
}

/**
 * Work out how much of each line can be committed against current stock.
 *
 * Available stock for a variant is `on_hand - reserved` — units that are
 * physically here and not already promised to another order. A line
 * reserves at most what it still needs (`quantity - qtyReserved`), and at
 * most what is available; the remainder is reported as a shortfall rather
 * than being silently dropped, because Day 4 turns shortfalls into
 * special orders and POs.
 *
 * Lines already marked `special_order` are skipped entirely: we don't own
 * those units, so there is nothing to commit and nothing short.
 *
 * Availability is consumed as the plan is built, so two lines on the same
 * order competing for the same variant can't both reserve the last unit.
 */
export function planReservations(
  lines: readonly ReservableLine[],
  levels: ReadonlyMap<string, StockLevel>,
): ReservationPlan {
  const reservations: Reservation[] = [];
  const shortfalls: Shortfall[] = [];
  // Local copy so multiple lines hitting one variant draw down the same
  // pool instead of each seeing the full quantity.
  const remaining = new Map<string, number>();

  for (const line of lines) {
    // special_order: we don't own the units yet. direct_ship (PO-060):
    // we never will — the vendor ships to the customer directly.
    if (line.lineType === 'special_order' || line.lineType === 'direct_ship') continue;
    if (!line.variantId) continue;

    const needed = line.quantity - line.qtyReserved;
    if (needed <= 0) continue;

    if (!remaining.has(line.variantId)) {
      const level = levels.get(line.variantId);
      const available = level ? level.onHand - level.reserved : 0;
      remaining.set(line.variantId, Math.max(0, available));
    }
    const pool = remaining.get(line.variantId)!;
    const take = Math.min(needed, pool);

    if (take > 0) {
      reservations.push({ orderLineId: line.id, variantId: line.variantId, quantity: take });
      remaining.set(line.variantId, pool - take);
    }
    if (needed - take > 0) {
      shortfalls.push({
        orderLineId: line.id,
        variantId: line.variantId,
        quantity: needed - take,
      });
    }
  }

  return { reservations, shortfalls };
}

export interface Release {
  orderLineId: string;
  variantId: string;
  /** Units to hand back to available stock. Always > 0. */
  quantity: number;
}

/**
 * Everything currently committed by these lines, so cancelling an order
 * (or deleting a line) hands the units back. Fulfilled units are NOT
 * released — they have already left the building; the fulfillment flow
 * converts them from reserved to gone.
 */
export function planReleases(lines: readonly ReservableLine[]): Release[] {
  const releases: Release[] = [];
  for (const line of lines) {
    if (!line.variantId) continue;
    if (line.qtyReserved <= 0) continue;
    releases.push({
      orderLineId: line.id,
      variantId: line.variantId,
      quantity: line.qtyReserved,
    });
  }
  return releases;
}

export interface FulfillableLine {
  quantity: number;
  qtyFulfilled: number;
}

/**
 * Where an open order sits on the fulfillment axis, derived from its
 * lines rather than stored — the same reason balance due is derived.
 * Returns the status the order should carry; `completed` and `cancelled`
 * are lifecycle decisions the caller owns, not functions of line
 * quantities.
 */
export function deriveFulfillmentStatus(
  lines: readonly FulfillableLine[],
): 'open' | 'partially_fulfilled' | 'fulfilled' {
  if (lines.length === 0) return 'open';
  let anyFulfilled = false;
  let allFulfilled = true;
  for (const l of lines) {
    if (l.qtyFulfilled > 0) anyFulfilled = true;
    if (l.qtyFulfilled < l.quantity) allFulfilled = false;
  }
  if (allFulfilled) return 'fulfilled';
  return anyFulfilled ? 'partially_fulfilled' : 'open';
}

/**
 * Order statuses from which stock is still committed and money can still
 * move. Used to gate deposits, line edits, and reservation.
 */
export const LIVE_ORDER_STATUSES = [
  'draft',
  'quote',
  'open',
  'partially_fulfilled',
  'fulfilled',
] as const;

export type OrderStatus =
  | 'draft'
  | 'quote'
  | 'open'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'completed'
  | 'cancelled';

export function isLiveOrderStatus(status: string): boolean {
  return (LIVE_ORDER_STATUSES as readonly string[]).includes(status);
}

// ============================================================================
// Fulfillment (Day 3)
// ============================================================================

export interface FulfillableStockLine {
  id: string;
  variantId: string | null;
  quantity: number;
  qtyReserved: number;
  qtyFulfilled: number;
}

export interface FulfillmentRequest {
  orderLineId: string;
  quantity: number;
}

export interface FulfillmentStep {
  orderLineId: string;
  variantId: string | null;
  /** Units leaving the building now. Always > 0. */
  quantity: number;
  /**
   * How many of those units were counted in `reserved`. On-hand drops by
   * `quantity` regardless; `reserved` only drops by this — fulfilling a
   * never-reserved unit (a shortfall the store covered anyway) must not
   * drive the reserved counter negative for everyone else.
   */
  fromReserved: number;
}

/**
 * Validate and shape a fulfillment: which units leave, per line, and how
 * much of each line's reservation they consume. Throws (via the returned
 * error string) on nothing at all — validation is data-driven so the
 * caller can turn problems into 400s with the line named.
 */
export function planFulfillment(
  lines: readonly FulfillableStockLine[],
  requests: readonly FulfillmentRequest[],
): { steps: FulfillmentStep[]; errors: string[] } {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const errors: string[] = [];
  const steps: FulfillmentStep[] = [];
  const seen = new Set<string>();
  for (const req of requests) {
    const line = byId.get(req.orderLineId);
    if (!line) {
      errors.push(`line ${req.orderLineId} is not on this order`);
      continue;
    }
    if (seen.has(req.orderLineId)) {
      errors.push(`line ${req.orderLineId} appears twice in the request`);
      continue;
    }
    seen.add(req.orderLineId);
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      errors.push(`line ${req.orderLineId}: quantity must be a positive integer`);
      continue;
    }
    const remaining = line.quantity - line.qtyFulfilled;
    if (req.quantity > remaining) {
      errors.push(
        `line ${req.orderLineId}: ${req.quantity} requested but only ${remaining} unfulfilled`,
      );
      continue;
    }
    steps.push({
      orderLineId: line.id,
      variantId: line.variantId,
      quantity: req.quantity,
      fromReserved: Math.min(line.qtyReserved, req.quantity),
    });
  }
  return { steps, errors };
}

/**
 * Default fulfillment request: everything still owed on every line.
 * The single-delivery common case ("bring it all") without the caller
 * enumerating lines.
 */
export function remainingFulfillment(lines: readonly FulfillableStockLine[]): FulfillmentRequest[] {
  return lines
    .filter((l) => l.quantity - l.qtyFulfilled > 0)
    .map((l) => ({ orderLineId: l.id, quantity: l.quantity - l.qtyFulfilled }));
}
