/**
 * New Sale inventory-source defaults (HANDOFF_inventory_source_defaults,
 * redesign Phase 4). Pure functions so the rules are testable against the
 * handoff's matrix and shared by the register and the Add Product dialog.
 *
 * Resolution order for a line that the salesperson has not touched:
 *   1. effective fulfillment is take-with  → the order's Store
 *   2. business.defaultSourceLocationId     → that location
 *   3. exactly one location typed warehouse → that location
 *   4. fallback                             → the order's Store
 * A touched line is never moved; it gets an inline note instead.
 */

export type Fulfillment = 'delivery' | 'pickup' | 'take_with' | 'direct_ship';

export interface SourceLocation {
  id: string;
  name: string;
  locationType?: string;
}

export interface SourcingContext {
  /** The order's Store (Order details), which defaults to the acting store. */
  orderLocationId: string;
  orderFulfillment: Fulfillment;
  locations: SourceLocation[];
  /** business.ops.defaultSourceLocationId, if set. */
  defaultSourceLocationId?: string | null;
}

export interface SourcedLine {
  /** '' inherits the order's fulfillment. */
  fulfillmentMethod: '' | Fulfillment;
  /** Resolved location id ('' = not yet resolved). */
  sourceLocationId: string;
  /** True once the salesperson edited the source by hand. */
  sourceTouched: boolean;
  lineType: 'stock' | 'special_order' | 'custom';
}

export function effectiveFulfillment(
  line: Pick<SourcedLine, 'fulfillmentMethod'>,
  orderFulfillment: Fulfillment,
): Fulfillment {
  return line.fulfillmentMethod || orderFulfillment;
}

/** The single warehouse, if the business has exactly one. */
export function singleWarehouse(locations: SourceLocation[]): SourceLocation | undefined {
  const wh = locations.filter((l) => l.locationType === 'warehouse');
  return wh.length === 1 ? wh[0] : undefined;
}

/** Steps 2–4: the default for anything that is not take-with. */
export function warehouseDefault(ctx: SourcingContext): string {
  if (
    ctx.defaultSourceLocationId &&
    ctx.locations.some((l) => l.id === ctx.defaultSourceLocationId)
  ) {
    return ctx.defaultSourceLocationId;
  }
  const wh = singleWarehouse(ctx.locations);
  if (wh) return wh.id;
  return ctx.orderLocationId;
}

/** Where an untouched line with this effective fulfillment sources from. */
export function defaultSourceFor(fulfillment: Fulfillment, ctx: SourcingContext): string {
  if (fulfillment === 'take_with') return ctx.orderLocationId;
  return warehouseDefault(ctx);
}

/** The Add Product dialog's initial "From". */
export function pickerDefaultSource(ctx: SourcingContext): string {
  return defaultSourceFor(ctx.orderFulfillment, ctx);
}

/**
 * Recompute untouched lines only. Called on line fulfillment change, order
 * fulfillment change, order Store change, and product added.
 */
export function resourceUntouched<T extends SourcedLine>(lines: T[], ctx: SourcingContext): T[] {
  let changed = false;
  const next = lines.map((l) => {
    if (l.sourceTouched || l.lineType === 'custom') return l;
    const want = defaultSourceFor(effectiveFulfillment(l, ctx.orderFulfillment), ctx);
    if (want === l.sourceLocationId) return l;
    changed = true;
    return { ...l, sourceLocationId: want };
  });
  return changed ? next : lines;
}

/** Suffix for a location name in the From / Inventory from selects. */
export function sourceLabel(loc: SourceLocation, orderLocationId: string): string {
  if (loc.locationType === 'warehouse') return `${loc.name} — warehouse`;
  if (loc.id === orderLocationId) return `${loc.name} — this store`;
  return loc.name;
}

export interface LineWarningInput {
  effective: Fulfillment;
  available: number | null | undefined;
  quantity: number;
  unitPriceCents: number;
  sourceTouched: boolean;
  sourceLocationId: string;
  orderLocationId: string;
  sourceName: string;
  storeName: string;
  atpDate?: string | null;
}

export type LineWarningTone = 'risk' | 'waiting' | 'note';

/**
 * The one inline note a line may carry, in priority order: $0 price,
 * take-with short at the store, short at the source (PO / special order),
 * take-with from another store.
 */
export function lineWarning(
  input: LineWarningInput,
): { tone: LineWarningTone; text: string } | null {
  const { effective, available, quantity } = input;
  const short = available != null && available < quantity;
  if (input.unitPriceCents === 0) {
    return { tone: 'waiting', text: 'Priced at $0.00 — confirm before payment.' };
  }
  if (short && effective === 'take_with') {
    return {
      tone: 'risk',
      text: `Take-with: ${available} available at ${input.sourceName}. Change the source location or the fulfillment type.`,
    };
  }
  if (short && input.atpDate) {
    const when = new Date(input.atpDate).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    return {
      tone: 'waiting',
      text: `Not in stock at ${input.sourceName}. On open PO — expected ${when}; will reserve against it.`,
    };
  }
  if (short) {
    return {
      tone: 'waiting',
      text: `Not in stock at ${input.sourceName}. No open PO — will special-order.`,
    };
  }
  if (
    input.sourceTouched &&
    effective === 'take_with' &&
    input.sourceLocationId !== input.orderLocationId
  ) {
    return {
      tone: 'note',
      text: `Take-with from ${input.sourceName}, not ${input.storeName} — customer collects there.`,
    };
  }
  return null;
}
