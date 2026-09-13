/**
 * Sales-rate PO replenishment — the ONE calculation engine
 * (docs/HANDOFF-po-replenishment-sales-rate). All three run modes (EOD,
 * on-demand, scheduled) call this same pure code; T-31 is the contract.
 *
 * Core equation (§2):
 *   QuantityToOrder = UnitsRequired + AdditionalUnitsRequired
 *                     − UnitsAvailable − NetPO
 *
 * Open questions self-decided (flagged in SPRINT-STATUS):
 *  - §9.1: sales rate uses UnitsSold − UnitsReturned (the source's "="
 *    is a documentation typo).
 *  - §9.2: rounding off = truncate toward zero (inferred; T-09).
 *  - §9.10: Minimum Sales Rate filter is strict `<`.
 *  - Jetnine divergences: no product "groups" — category exceptions
 *    only; no PO types — every open PO counts as supply; no
 *    PO-from-order-entry flag — §3.4 not applicable.
 */

export interface ReplenishmentControl {
  /** §2.3 written vs delivered basis (business-wide). */
  unitSalesRateCalculation: 'written' | 'delivered';
  /** §2.2 divisor: true → lead days are business days (÷5). */
  excludeWeekendsInVendorLeadDays: boolean;
  /** §2.6: true → half-up per column; false → truncate toward zero. */
  standardRounding: boolean;
  /** §2.4: store stock counts toward availability. */
  includeStoreStockInAvailability: boolean;
  /** Inventory control: layaway units subtract from NetPO in branch A. */
  layawayInNetPurchaseOrder: boolean;
}

export interface VendorReplenishment {
  generateAutomaticPos: boolean;
  automaticallyHoldPos: boolean;
  /** §2.3 window X, in weeks. */
  weeklySalesRateWeeks: number;
  /** §2.5 branch selector. */
  includeAllBackOrders: boolean;
  daysForReplenishment: number | null;
  minimumStockDays: number;
  leadDays: number;
  /** Default 100; applies only within the variance window when set. */
  variancePercent: number;
  varianceStart?: string | null;
  varianceEnd?: string | null;
  /** §3.5 floor, units/week; strict `<` drops the row entirely. */
  minimumSalesRate: number;
  /** §3.1 EOD gate: weekdays 0(Sun)–6(Sat) the vendor builds POs. */
  buildDays: number[];
  /**
   * Advanced Vendor Settings → Auto PO Replen (owner 2026-09-02): the two
   * average-units windows STORIS shows beside the sales rate, in weeks.
   * Stored and reported; the grid's average-units columns read them.
   */
  firstAverageUnitsPeriodWeeks?: number;
  secondAverageUnitsPeriodWeeks?: number;
  /** Grid / PO line order: vendor model (vendor SKU), product, category, group. */
  sortCriteria?: 'vendor_model' | 'product' | 'category' | 'group';
  categoryExceptions?: {
    categoryId: string;
    minimumStockDays?: number;
    leadDays?: number;
  }[];
}

export interface ReplenishmentProduct {
  variantId: string;
  categoryId: string | null;
  /**
   * The category itself first, then its parent, then the root (A22.1
   * categories nest). A vendor exception on "Mattresses" then covers
   * "Mattresses › Hybrid"; the nearest ancestor with a value wins.
   * Omit to match on categoryId alone.
   */
  categoryLineage?: string[];
  unitsSold: number;
  unitsReturned: number;
  warehouseOnHand: number;
  warehouseCommitted: number;
  storeStockAvailable: number;
  /** Open supply-eligible PO units (held POs INCLUDED — §2.5). */
  onOrder: number;
  /** Branch A: all sold-but-unreserved demand. */
  uncommittedDemand: number;
  /** Branch B: sold-not-reserved due within fill days, or ASAP. */
  dueSoonDemand: number;
  /** Branch B: inbound transfers scheduled within fill days. */
  inboundTransfers: number;
  layawayUnits: number;
  /** §3.3 hard exclusions. */
  specialOrder?: boolean;
  discontinued?: boolean;
  nonInventory?: boolean;
  kitMaster?: boolean;
  serviceStatus?: number;
  unitVolume?: number;
  asIsQty?: number;
  lastSaleDate?: string | null;
}

export interface RunCriteria {
  /** Blank = 100 (§2.3). Integer 0–999. */
  variancePercent?: number | null;
  /** Screen value overrides the vendor setting (§2.5 / T-18). */
  daysForReplenishment?: number | null;
  salesWindow: 'this_year_prior' | 'last_year_subsequent';
  includeOverstocks: boolean;
  includeServiceItems: boolean;
  productIds?: string[] | null;
  vendorModel?: string | null;
}

export interface ReplenishmentRow {
  variantId: string;
  required: number;
  additional: number;
  available: number;
  netPo: number;
  orderQty: number;
  salesRate: number;
  volume: number;
  asIsQty: number;
  lastSaleDate: string | null;
}

export class ReplenishmentValidationError extends Error {}

/** §2.6 — round per COLUMN, never the summed result (T-08). */
function roundQty(value: number, standardRounding: boolean): number {
  return standardRounding ? Math.round(value) : Math.trunc(value);
}

/** A category id, or its lineage (self first, then ancestors up to the root). */
export type CategoryRef = string | string[] | null | undefined;

/**
 * The nearest category exception with the field set: the product's own
 * category first, then its parent, then the root.
 */
function findException<K extends 'minimumStockDays' | 'leadDays'>(
  vendor: VendorReplenishment,
  category: CategoryRef,
  field: K,
): number | undefined {
  const lineage = Array.isArray(category) ? category : category ? [category] : [];
  for (const id of lineage) {
    const exc = vendor.categoryExceptions?.find(
      (e) => e.categoryId === id && e[field] !== undefined,
    );
    if (exc) return exc[field];
  }
  return undefined;
}

/** First-match-wins resolution (§2.1/§2.2); category exception → vendor. */
export function resolveMinimumStockDays(
  vendor: VendorReplenishment,
  category: CategoryRef,
): number {
  return findException(vendor, category, 'minimumStockDays') ?? vendor.minimumStockDays;
}

export function resolveLeadDays(vendor: VendorReplenishment, category: CategoryRef): number {
  return findException(vendor, category, 'leadDays') ?? vendor.leadDays;
}

export function validateCriteria(criteria: RunCriteria, vendor: VendorReplenishment): void {
  if (criteria.productIds?.length && criteria.vendorModel) {
    throw new ReplenishmentValidationError('Specify products or a vendor model, not both');
  }
  if (vendor.includeAllBackOrders && criteria.daysForReplenishment != null) {
    throw new ReplenishmentValidationError(
      'Days for Replenishment cannot be set when Include All Back Orders is on',
    );
  }
  if (
    criteria.variancePercent != null &&
    (criteria.variancePercent < 0 || criteria.variancePercent > 999)
  ) {
    throw new ReplenishmentValidationError('Variance Percent must be 0–999');
  }
}

/** §2.3 window bounds for the sales query, from a supplied clock (T-20). */
export function salesWindow(
  criteria: RunCriteria,
  vendor: VendorReplenishment,
  today: Date,
): { start: Date; end: Date; weeks: number } {
  const weeks = Math.max(1, vendor.weeklySalesRateWeeks);
  const ms = weeks * 7 * 86_400_000;
  if (criteria.salesWindow === 'last_year_subsequent') {
    const anchor = new Date(today.getTime());
    anchor.setUTCFullYear(anchor.getUTCFullYear() - 1);
    return { start: anchor, end: new Date(anchor.getTime() + ms), weeks };
  }
  return { start: new Date(today.getTime() - ms), end: today, weeks };
}

/**
 * The pure per-product calculation. Returns null when the row is
 * excluded from the report entirely (hard exclusions or the minimum
 * sales-rate floor), and a row with a non-positive orderQty only so the
 * caller can honor Include Overstocks (§3.6 — even then, only qty > 0
 * ever reaches a PO).
 */
export function calculateRow(
  p: ReplenishmentProduct,
  vendor: VendorReplenishment,
  control: ReplenishmentControl,
  criteria: RunCriteria,
): ReplenishmentRow | null {
  if (p.specialOrder || p.discontinued || p.nonInventory || p.kitMaster) return null;
  if (!criteria.includeServiceItems && (p.serviceStatus ?? 0) >= 2) return null;

  const variancePct = criteria.variancePercent ?? 100;
  const rawRate = (p.unitsSold - p.unitsReturned) / Math.max(1, vendor.weeklySalesRateWeeks);
  const rate = rawRate * (variancePct / 100);
  if (rate < vendor.minimumSalesRate) return null; // strict < (§3.5)

  const category = p.categoryLineage ?? p.categoryId;
  const minDays = resolveMinimumStockDays(vendor, category);
  // §2.1 — ALWAYS ÷7 (calendar days); the weekend switch never touches it.
  const required = roundQty((minDays / 7) * rate, control.standardRounding);

  const leadDays = resolveLeadDays(vendor, category);
  const daysPerWeek = control.excludeWeekendsInVendorLeadDays ? 5 : 7;
  const additional = roundQty((leadDays / daysPerWeek) * rate, control.standardRounding);

  let available = p.warehouseOnHand - p.warehouseCommitted;
  if (control.includeStoreStockInAvailability) available += p.storeStockAvailable;

  // §2.5 — NetPO. Held POs are already inside onOrder; never clamp.
  let netPo = p.onOrder;
  if (vendor.includeAllBackOrders) {
    netPo -= p.uncommittedDemand;
    if (control.layawayInNetPurchaseOrder) netPo -= p.layawayUnits;
  } else {
    netPo -= p.dueSoonDemand;
    netPo += p.inboundTransfers;
  }

  const orderQty = required + additional - available - netPo;
  return {
    variantId: p.variantId,
    required,
    additional,
    available,
    netPo,
    orderQty,
    salesRate: rate,
    volume: (p.unitVolume ?? 0) * Math.max(orderQty, 0),
    asIsQty: p.asIsQty ?? 0,
    lastSaleDate: p.lastSaleDate ?? null,
  };
}

/** Run the whole candidate list; §3.6 Include Overstocks filter. */
export function runReplenishment(
  products: ReplenishmentProduct[],
  vendor: VendorReplenishment,
  control: ReplenishmentControl,
  criteria: RunCriteria,
): ReplenishmentRow[] {
  validateCriteria(criteria, vendor);
  const rows: ReplenishmentRow[] = [];
  for (const p of products) {
    const row = calculateRow(p, vendor, control, criteria);
    if (!row) continue;
    if (row.orderQty <= 0 && !criteria.includeOverstocks) continue;
    rows.push(row);
  }
  return rows;
}

/** §3.1 EOD vendor gate. */
export function vendorRunsToday(vendor: VendorReplenishment, today: Date): boolean {
  if (!vendor.generateAutomaticPos) return false;
  return vendor.buildDays.includes(today.getUTCDay());
}
