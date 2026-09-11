/**
 * The pure math behind the STORIS "Replenish Inventory" screen (A22
 * slice 4): what counts as available under the run's options, how much
 * a line needs once stock and open POs are netted, and carton rounding.
 * No I/O — the controller feeds it cells and reads back rows.
 */

export type ReplenishMode = 'allocated_order' | 'stock_level';
export type StockLevelBasis = 'minimum' | 'safety';

export interface ReplenishOptions {
  /** Count floor-sample units as sellable stock. */
  includeFloorSamples: boolean;
  /** Count pending As-Is (returned) pieces as sellable stock. */
  includeReturns: boolean;
  /** Round every order quantity up to whole purchase cartons. */
  roundToCarton: boolean;
}

export interface StockCell {
  onHand: number;
  reserved: number;
  floorSample: number;
  asIsPending: number;
  /** Open PO units not already allocated to a sales order. */
  netOnPo: number;
}

export const EMPTY_CELL: StockCell = {
  onHand: 0,
  reserved: 0,
  floorSample: 0,
  asIsPending: 0,
  netOnPo: 0,
};

/** Sellable units under the run's options (may go negative when over-reserved). */
export function availableOf(cell: StockCell, opts: ReplenishOptions): number {
  return (
    cell.onHand -
    cell.reserved -
    cell.floorSample +
    (opts.includeFloorSamples ? cell.floorSample : 0) +
    (opts.includeReturns ? cell.asIsPending : 0)
  );
}

/**
 * Allocated-order need: the uncovered order shortfall, less whatever is
 * free on the floor and already on its way. Negative stock counts as
 * zero — a short cell never inflates the order.
 */
export function allocatedNeed(demand: number, available: number, netOnPo: number): number {
  return Math.max(0, demand - Math.max(0, available) - Math.max(0, netOnPo));
}

/**
 * Stock-level need: top the position (available + open PO) back up to
 * the threshold — the store's minimum or the variant's safety point.
 * When the variant carries a reorder quantity and there is something to
 * order, the order is at least that many (the vendor's pack).
 */
export function stockLevelNeed(
  threshold: number,
  available: number,
  netOnPo: number,
  reorderQty: number | null | undefined,
): number {
  const need = Math.max(0, threshold - Math.max(0, available) - Math.max(0, netOnPo));
  if (need > 0 && reorderQty != null && reorderQty > 0) return Math.max(need, reorderQty);
  return need;
}

/**
 * Carton rounding: `cartons` is always the whole cartons the quantity
 * spans (informational when rounding is off); `totalQty` is what the
 * PO line gets.
 */
export function cartonRound(
  orderQty: number,
  cartonQty: number | null | undefined,
  round: boolean,
): { cartonQty: number; cartons: number; totalQty: number } {
  const size = Math.max(1, Math.floor(cartonQty ?? 1));
  const qty = Math.max(0, Math.floor(orderQty));
  const cartons = Math.ceil(qty / size);
  return { cartonQty: size, cartons, totalQty: round ? cartons * size : qty };
}
