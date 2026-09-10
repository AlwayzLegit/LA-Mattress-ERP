/**
 * Product-level stock the STORIS screens show (amendment A19): the list's
 * On Hand / Available / Net On PO / As-Is columns and the product page's
 * per-location availability grid, computed once here so both agree.
 *
 * Definitions (the same ones the register, replenishment and reports use):
 *   available        = Σ max(0, on_hand − reserved − floor_sample) per level
 *   netOnPo          = Σ (ordered − accepted − rejected) over placed, live,
 *                      non-direct-ship purchase orders ('ordered' |
 *                      'partially_received'); totalPo = Σ ordered on the same
 *   asIsOnHand       = as-is pieces still in review (status pending_review;
 *                      restocked pieces are ordinary stock, vendor returns and
 *                      scrap are gone)
 *   asIsNonSellable  = those in condition 'damaged' or 'parts'
 *   asIsAvailable    = asIsOnHand − asIsNonSellable
 *   layawayReserved  = qty_reserved on open layaway order lines, at the line's
 *                      stock location
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';

export const OPEN_PO_STATUSES = ['ordered', 'partially_received'] as const;
export const OPEN_ORDER_STATUSES = ['open', 'partially_fulfilled'] as const;
export const AS_IS_NON_SELLABLE_CONDITIONS = ['damaged', 'parts'] as const;

export interface StockTotals {
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  netOnPo: number;
  totalPo: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
  layawayReserved: number;
}

export interface LocationStockRow extends StockTotals {
  variantId: string;
  variantSku: string | null;
  locationId: string;
  locationName: string;
  storageBinId: string | null;
  storageBinCode: string | null;
}

export const EMPTY_TOTALS: StockTotals = {
  onHand: 0,
  reserved: 0,
  floorSample: 0,
  available: 0,
  netOnPo: 0,
  totalPo: 0,
  asIsOnHand: 0,
  asIsAvailable: 0,
  asIsNonSellable: 0,
  layawayReserved: 0,
};

function add(a: StockTotals, b: Partial<StockTotals>): StockTotals {
  const out = { ...a };
  for (const k of Object.keys(EMPTY_TOTALS) as (keyof StockTotals)[]) {
    out[k] += Number(b[k] ?? 0);
  }
  return out;
}

interface Cell extends Partial<StockTotals> {
  variantId: string;
  locationId: string | null;
}

/**
 * Every (variant, location) cell with stock, open PO units, as-is pieces or
 * layaway reservations for the given variants. `locationId` narrows every
 * source to that store.
 */
async function loadCells(
  db: PostgresJsDatabase,
  businessId: string,
  variantIds: string[],
  locationId?: string,
): Promise<Cell[]> {
  if (variantIds.length === 0) return [];
  const byVariant = inArray(schema.inventoryLevels.variantId, variantIds);

  const levels = await db
    .select({
      variantId: schema.inventoryLevels.variantId,
      locationId: schema.inventoryLevels.locationId,
      onHand: sql<number>`sum(${schema.inventoryLevels.onHand})::int`,
      reserved: sql<number>`sum(${schema.inventoryLevels.reserved})::int`,
      floorSample: sql<number>`sum(${schema.inventoryLevels.floorSample})::int`,
      available: sql<number>`sum(greatest(0, ${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample}))::int`,
    })
    .from(schema.inventoryLevels)
    .where(
      and(
        eq(schema.inventoryLevels.businessId, businessId),
        byVariant,
        locationId ? eq(schema.inventoryLevels.locationId, locationId) : undefined,
      ),
    )
    .groupBy(schema.inventoryLevels.variantId, schema.inventoryLevels.locationId);

  const po = await db
    .select({
      variantId: schema.purchaseOrderLines.variantId,
      locationId: schema.purchaseOrders.locationId,
      netOnPo: sql<number>`sum(greatest(0, ${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected}))::int`,
      totalPo: sql<number>`sum(${schema.purchaseOrderLines.quantityOrdered})::int`,
    })
    .from(schema.purchaseOrderLines)
    .innerJoin(
      schema.purchaseOrders,
      eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
    )
    .where(
      and(
        eq(schema.purchaseOrders.businessId, businessId),
        inArray(schema.purchaseOrderLines.variantId, variantIds),
        inArray(schema.purchaseOrders.status, [...OPEN_PO_STATUSES]),
        isNull(schema.purchaseOrders.deletedAt),
        eq(schema.purchaseOrders.directShip, false),
        locationId ? eq(schema.purchaseOrders.locationId, locationId) : undefined,
      ),
    )
    .groupBy(schema.purchaseOrderLines.variantId, schema.purchaseOrders.locationId);

  const asIs = await db
    .select({
      variantId: schema.asIsItems.variantId,
      locationId: schema.asIsItems.locationId,
      asIsOnHand: sql<number>`sum(${schema.asIsItems.quantity})::int`,
      asIsNonSellable: sql<number>`coalesce(sum(${schema.asIsItems.quantity}) filter (where ${schema.asIsItems.condition} in ('damaged', 'parts')), 0)::int`,
    })
    .from(schema.asIsItems)
    .where(
      and(
        eq(schema.asIsItems.businessId, businessId),
        inArray(schema.asIsItems.variantId, variantIds),
        eq(schema.asIsItems.status, 'pending_review'),
        locationId ? eq(schema.asIsItems.locationId, locationId) : undefined,
      ),
    )
    .groupBy(schema.asIsItems.variantId, schema.asIsItems.locationId);

  const lineLocation = sql<string>`coalesce(${schema.orderLines.sourceLocationId}, ${schema.orders.stockLocationId}, ${schema.orders.locationId})`;
  const layaway = await db
    .select({
      variantId: schema.orderLines.variantId,
      locationId: lineLocation,
      layawayReserved: sql<number>`sum(${schema.orderLines.qtyReserved})::int`,
    })
    .from(schema.orderLines)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
    .where(
      and(
        eq(schema.orders.businessId, businessId),
        inArray(schema.orderLines.variantId, variantIds),
        eq(schema.orders.orderKind, 'layaway'),
        inArray(schema.orders.status, [...OPEN_ORDER_STATUSES]),
        sql`${schema.orderLines.qtyReserved} > 0`,
        locationId ? sql`${lineLocation} = ${locationId}` : undefined,
      ),
    )
    .groupBy(schema.orderLines.variantId, lineLocation);

  const cells: Cell[] = [...levels, ...po, ...asIs];
  for (const r of layaway) {
    if (r.variantId) cells.push({ ...r, variantId: r.variantId });
  }
  return cells;
}

/** Per-product totals for a list page (across locations, or one store). */
export async function loadProductStockTotals(
  db: PostgresJsDatabase,
  businessId: string,
  productIds: string[],
  locationId?: string,
): Promise<Map<string, StockTotals>> {
  const out = new Map<string, StockTotals>();
  if (productIds.length === 0) return out;
  const variants = await db
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
    .from(schema.productVariants)
    .where(
      and(
        eq(schema.productVariants.businessId, businessId),
        inArray(schema.productVariants.productId, productIds),
      ),
    );
  const productOf = new Map(variants.map((v) => [v.id, v.productId]));
  for (const id of productIds) out.set(id, { ...EMPTY_TOTALS });
  const cells = await loadCells(
    db,
    businessId,
    variants.map((v) => v.id),
    locationId,
  );
  for (const c of cells) {
    const pid = productOf.get(c.variantId);
    if (!pid) continue;
    out.set(pid, finish(add(out.get(pid) ?? EMPTY_TOTALS, c)));
  }
  return out;
}

function finish(t: StockTotals): StockTotals {
  return { ...t, asIsAvailable: t.asIsOnHand - t.asIsNonSellable };
}

/**
 * The product page's grid: one row per variant per active location (every
 * store listed, zeros included, the way STORIS's Location Availability
 * does), plus totals across them.
 */
export async function loadProductStockByLocation(
  db: PostgresJsDatabase,
  businessId: string,
  productId: string,
): Promise<{ totals: StockTotals; byLocation: LocationStockRow[] }> {
  const variants = await db
    .select({ id: schema.productVariants.id, sku: schema.productVariants.sku })
    .from(schema.productVariants)
    .where(
      and(
        eq(schema.productVariants.businessId, businessId),
        eq(schema.productVariants.productId, productId),
        eq(schema.productVariants.isActive, true),
      ),
    )
    .orderBy(schema.productVariants.createdAt);
  const locations = await db
    .select({ id: schema.locations.id, name: schema.locations.name })
    .from(schema.locations)
    .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
    .orderBy(schema.locations.name);
  const bins = await db
    .select({
      variantId: schema.inventoryLevels.variantId,
      locationId: schema.inventoryLevels.locationId,
      storageBinId: schema.inventoryLevels.storageBinId,
      storageBinCode: schema.storageBins.code,
    })
    .from(schema.inventoryLevels)
    .leftJoin(schema.storageBins, eq(schema.storageBins.id, schema.inventoryLevels.storageBinId))
    .where(
      and(
        eq(schema.inventoryLevels.businessId, businessId),
        inArray(
          schema.inventoryLevels.variantId,
          variants.map((v) => v.id),
        ),
      ),
    );
  const binAt = new Map(bins.map((b) => [`${b.variantId}:${b.locationId}`, b]));
  const cells = await loadCells(
    db,
    businessId,
    variants.map((v) => v.id),
  );
  const cellAt = new Map<string, StockTotals>();
  for (const c of cells) {
    if (!c.locationId) continue;
    const key = `${c.variantId}:${c.locationId}`;
    cellAt.set(key, add(cellAt.get(key) ?? EMPTY_TOTALS, c));
  }
  const byLocation: LocationStockRow[] = [];
  let totals = { ...EMPTY_TOTALS };
  for (const v of variants) {
    for (const l of locations) {
      const key = `${v.id}:${l.id}`;
      const t = finish(cellAt.get(key) ?? { ...EMPTY_TOTALS });
      totals = add(totals, t);
      const bin = binAt.get(key);
      byLocation.push({
        variantId: v.id,
        variantSku: v.sku ?? null,
        locationId: l.id,
        locationName: l.name,
        storageBinId: bin?.storageBinId ?? null,
        storageBinCode: bin?.storageBinCode ?? null,
        ...t,
      });
    }
  }
  return { totals: finish(totals), byLocation };
}
