import { and, eq, gt, inArray, isNull, lte, max, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { buildCategoryIndex, loadCategoryIndex } from '../catalog/category-tree';
import type {
  ReplenishmentControl,
  ReplenishmentProduct,
  RunCriteria,
  VendorReplenishment,
} from './replenishment-engine';
import { resolveLeadDays, salesWindow } from './replenishment-engine';

/**
 * The vendor's stored replenishment document (vendors.replenishment_json)
 * is the engine's VendorReplenishment plus PO-creation settings the pure
 * engine never sees (§5.1 Default Requested Date).
 */
export interface VendorReplenishmentSettings extends VendorReplenishment {
  /** §5.1 — 'vendor_lead_days' (default) or 'today'. */
  defaultRequestedDate?: 'vendor_lead_days' | 'today';
}

/** Ops-settings block (businesses.ops_settings_json.salesRateReplenishment). */
export interface SalesRateReplenishmentOps {
  unitSalesRateCalculation?: 'written' | 'delivered' | null;
  excludeWeekendsInVendorLeadDays?: boolean | null;
  standardRounding?: boolean | null;
  includeStoreStockInAvailability?: boolean | null;
  layawayInNetPurchaseOrder?: boolean | null;
}

export function controlFromOps(ops: SalesRateReplenishmentOps | null): ReplenishmentControl {
  return {
    unitSalesRateCalculation: ops?.unitSalesRateCalculation ?? 'written',
    excludeWeekendsInVendorLeadDays: ops?.excludeWeekendsInVendorLeadDays ?? false,
    standardRounding: ops?.standardRounding ?? true,
    includeStoreStockInAvailability: ops?.includeStoreStockInAvailability ?? false,
    layawayInNetPurchaseOrder: ops?.layawayInNetPurchaseOrder ?? false,
  };
}

/** Statuses that count as open supply. Jetnine has no PO types and no
 * separate hold flag: a held replenishment PO IS a draft (T-28), and the
 * pack says held POs still count as supply — so drafts are included. */
const OPEN_PO_STATUSES = ['draft', 'ordered', 'partially_received'];
/** Order statuses carrying live demand. */
const OPEN_ORDER_STATUSES = ['open', 'partially_fulfilled'];

export interface ReplenishmentCandidateMeta {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorSku: string | null;
  costCents: number | null;
  categoryName: string | null;
  /** Full path ("Mattresses › Hybrid"); categoryName is the leaf. */
  categoryPath: string | null;
}

/**
 * Assemble the pure engine's inputs from live data — the ONE data path
 * all run modes share (T-31 rests on this as much as on the engine).
 *
 * Jetnine mappings, recorded deliberately:
 * - "Warehouse" is the run's chosen location; every OTHER active
 *   location is "store stock" (§2.4). A location can replenish itself —
 *   single-location businesses just pick their only location.
 * - Written basis = order-write activity (orders.created_at + POS
 *   sales.created_at); delivered basis = delivered deliveries
 *   (completed_at) + POS sales (take-with delivers at completion).
 *   Legacy-imported records are excluded — their timestamps are
 *   import-time, not sale-time (consistent with the buyer's report).
 * - Returns = POS refund lines in the window (order-side returns flow
 *   through refunds too).
 * - Branch B's fill window = criteria.daysForReplenishment ??
 *   vendor.daysForReplenishment ?? vendor lead days (no Auto-Fill Days
 *   field in Jetnine). ASAP orders always count. Transfers with no
 *   scheduled date are excluded entirely (§2.5).
 * - Layaway demand is kept out of uncommittedDemand so branch A never
 *   double-subtracts when LayawayInNetPurchaseOrder is on.
 * - No special-order/discontinued/kit flags exist: inactive variants and
 *   products are the discontinued set and are excluded up front;
 *   direct-ship PO lines never touch our stock so they are not supply.
 * - unitVolume = variant capacityUnits (G12's truck-capacity measure is
 *   the closest thing to STORIS cube volume).
 */
export async function buildReplenishmentInputs(
  db: PostgresJsDatabase,
  opts: {
    vendorId: string;
    warehouseLocationId: string;
    vendor: VendorReplenishment;
    criteria: RunCriteria;
    control: ReplenishmentControl;
    today: Date;
    categoryId?: string | null;
    /** Required on the root-db (EOD) path where RLS is not in force. */
    businessId?: string;
  },
): Promise<{ products: ReplenishmentProduct[]; meta: Map<string, ReplenishmentCandidateMeta> }> {
  const { vendorId, warehouseLocationId, vendor, criteria, control, today, businessId } = opts;
  const biz = (col: { businessId: unknown }) =>
    businessId ? eq(col.businessId as never, businessId) : undefined;

  // A22.1: categories nest — a category filter keeps the subcategories and
  // a vendor exception on the root reaches every product filed under it.
  const ownerId =
    businessId ??
    (
      await db
        .select({ businessId: schema.vendors.businessId })
        .from(schema.vendors)
        .where(eq(schema.vendors.id, vendorId))
        .limit(1)
    )[0]?.businessId;
  const categoryIndex = ownerId ? await loadCategoryIndex(db, ownerId) : buildCategoryIndex([]);
  const candidates = await db
    .select({
      variantId: schema.productVariants.id,
      categoryId: schema.products.categoryId,
      productName: schema.products.name,
      variantName: schema.productVariants.name,
      sku: schema.productVariants.sku,
      vendorSku: schema.productVariants.vendorSku,
      costCents: schema.productVariants.costCents,
      capacityUnits: schema.productVariants.capacityUnits,
      categoryName: schema.categories.name,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .where(
      and(
        biz(schema.productVariants),
        eq(schema.productVariants.preferredVendorId, vendorId),
        eq(schema.productVariants.isActive, true),
        eq(schema.products.isActive, true),
        criteria.productIds?.length
          ? inArray(schema.productVariants.id, criteria.productIds)
          : undefined,
        opts.categoryId
          ? inArray(schema.products.categoryId, categoryIndex.treeIds(opts.categoryId))
          : undefined,
      ),
    );
  const meta = new Map<string, ReplenishmentCandidateMeta>(
    candidates.map((c) => [
      c.variantId,
      {
        variantId: c.variantId,
        productName: c.productName,
        variantName: c.variantName,
        sku: c.sku,
        vendorSku: c.vendorSku,
        costCents: c.costCents,
        categoryName: c.categoryName,
        categoryPath: categoryIndex.pathOf(c.categoryId),
      },
    ]),
  );
  if (candidates.length === 0) return { products: [], meta };
  const ids = candidates.map((c) => c.variantId);

  const window = salesWindow(criteria, vendor, today);
  const wStart = window.start.toISOString();
  const wEnd = window.end.toISOString();
  const fillDays =
    criteria.daysForReplenishment ?? vendor.daysForReplenishment ?? resolveLeadDays(vendor, null);
  const fillCutoff = new Date(today.getTime() + fillDays * 86_400_000).toISOString().slice(0, 10);
  const unreserved = sql<number>`${schema.orderLines.quantity} - ${schema.orderLines.qtyReserved} - ${schema.orderLines.qtyFulfilled}`;

  const [
    levels,
    posSold,
    orderSold,
    deliveredSold,
    returned,
    onOrder,
    demand,
    transfers,
    asIs,
    lastSale,
  ] = await Promise.all([
    // Stock split warehouse vs stores. Floor samples are never sellable.
    db
      .select({
        variantId: schema.inventoryLevels.variantId,
        whOnHand: sql<number>`COALESCE(SUM(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.floorSample}) FILTER (WHERE ${schema.inventoryLevels.locationId} = ${warehouseLocationId}), 0)::int`,
        whCommitted: sql<number>`COALESCE(SUM(${schema.inventoryLevels.reserved}) FILTER (WHERE ${schema.inventoryLevels.locationId} = ${warehouseLocationId}), 0)::int`,
        storeAvailable: sql<number>`COALESCE(SUM(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample}) FILTER (WHERE ${schema.inventoryLevels.locationId} <> ${warehouseLocationId}), 0)::int`,
      })
      .from(schema.inventoryLevels)
      .where(and(biz(schema.inventoryLevels), inArray(schema.inventoryLevels.variantId, ids)))
      .groupBy(schema.inventoryLevels.variantId),
    // Written basis: POS sale lines by write date.
    db
      .select({
        variantId: schema.saleLines.variantId,
        qty: sql<number>`COALESCE(SUM(${schema.saleLines.quantity}), 0)::int`,
      })
      .from(schema.saleLines)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.saleLines.saleId))
      .where(
        and(
          biz(schema.saleLines),
          inArray(schema.saleLines.variantId, ids),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
          isNull(schema.sales.importedAt),
          sql`${schema.sales.createdAt} >= ${wStart}::timestamptz`,
          sql`${schema.sales.createdAt} < ${wEnd}::timestamptz`,
        ),
      )
      .groupBy(schema.saleLines.variantId),
    // Written basis: order lines by write date (quotes/cancels excluded).
    db
      .select({
        variantId: schema.orderLines.variantId,
        qty: sql<number>`COALESCE(SUM(${schema.orderLines.quantity}), 0)::int`,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .where(
        and(
          biz(schema.orderLines),
          inArray(schema.orderLines.variantId, ids),
          sql`${schema.orders.status} NOT IN ('quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          sql`${schema.orders.createdAt} >= ${wStart}::timestamptz`,
          sql`${schema.orders.createdAt} < ${wEnd}::timestamptz`,
        ),
      )
      .groupBy(schema.orderLines.variantId),
    // Delivered basis: delivered delivery lines by completion date.
    db
      .select({
        variantId: schema.orderLines.variantId,
        qty: sql<number>`COALESCE(SUM(${schema.deliveryLines.quantity}), 0)::int`,
      })
      .from(schema.deliveryLines)
      .innerJoin(schema.deliveries, eq(schema.deliveries.id, schema.deliveryLines.deliveryId))
      .innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.deliveryLines.orderLineId))
      .where(
        and(
          biz(schema.deliveryLines),
          inArray(schema.orderLines.variantId, ids),
          eq(schema.deliveries.status, 'delivered'),
          sql`${schema.deliveries.completedAt} >= ${wStart}::timestamptz`,
          sql`${schema.deliveries.completedAt} < ${wEnd}::timestamptz`,
        ),
      )
      .groupBy(schema.orderLines.variantId),
    // Returns in the window (both bases subtract them).
    db
      .select({
        variantId: schema.refundLines.variantId,
        qty: sql<number>`COALESCE(SUM(${schema.refundLines.quantity}), 0)::int`,
      })
      .from(schema.refundLines)
      .innerJoin(schema.refunds, eq(schema.refunds.id, schema.refundLines.refundId))
      .where(
        and(
          biz(schema.refundLines),
          inArray(schema.refundLines.variantId, ids),
          sql`${schema.refunds.createdAt} >= ${wStart}::timestamptz`,
          sql`${schema.refunds.createdAt} < ${wEnd}::timestamptz`,
        ),
      )
      .groupBy(schema.refundLines.variantId),
    // Open supply into the warehouse. Direct-ship POs never raise stock.
    db
      .select({
        variantId: schema.purchaseOrderLines.variantId,
        qty: sql<number>`COALESCE(SUM(${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected}), 0)::int`,
      })
      .from(schema.purchaseOrderLines)
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
      )
      .where(
        and(
          biz(schema.purchaseOrderLines),
          inArray(schema.purchaseOrderLines.variantId, ids),
          inArray(schema.purchaseOrders.status, OPEN_PO_STATUSES),
          eq(schema.purchaseOrders.locationId, warehouseLocationId),
          eq(schema.purchaseOrders.directShip, false),
        ),
      )
      .groupBy(schema.purchaseOrderLines.variantId),
    // Sold-but-unreserved demand, split three ways in one pass:
    // all of it (branch A), the due-soon slice (branch B), layaway.
    db
      .select({
        variantId: schema.orderLines.variantId,
        uncommitted: sql<number>`COALESCE(SUM(${unreserved}) FILTER (WHERE ${schema.orders.orderKind} <> 'layaway'), 0)::int`,
        layaway: sql<number>`COALESCE(SUM(${unreserved}) FILTER (WHERE ${schema.orders.orderKind} = 'layaway'), 0)::int`,
        dueSoon: sql<number>`COALESCE(SUM(${unreserved}) FILTER (WHERE ${schema.orders.orderKind} <> 'layaway' AND (${schema.orders.deliveryStatus} = 'asap' OR COALESCE(${schema.orderLines.deliveryDate}, ${schema.orders.requestedDate}) <= ${fillCutoff}::date)), 0)::int`,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .where(
        and(
          biz(schema.orderLines),
          inArray(schema.orderLines.variantId, ids),
          inArray(schema.orders.status, OPEN_ORDER_STATUSES),
          isNull(schema.orders.importedAt),
          gt(unreserved, 0),
        ),
      )
      .groupBy(schema.orderLines.variantId),
    // Inbound transfers to the warehouse, scheduled within fill days.
    db
      .select({
        variantId: schema.stockTransferLines.variantId,
        qty: sql<number>`COALESCE(SUM(${schema.stockTransferLines.quantityShipped} - ${schema.stockTransferLines.quantityReceived}), 0)::int`,
      })
      .from(schema.stockTransferLines)
      .innerJoin(
        schema.stockTransfers,
        eq(schema.stockTransfers.id, schema.stockTransferLines.transferId),
      )
      .where(
        and(
          biz(schema.stockTransferLines),
          inArray(schema.stockTransferLines.variantId, ids),
          eq(schema.stockTransfers.toLocationId, warehouseLocationId),
          inArray(schema.stockTransfers.status, ['draft', 'in_transit']),
          sql`${schema.stockTransfers.scheduledFor} IS NOT NULL`,
          lte(schema.stockTransfers.scheduledFor, fillCutoff),
        ),
      )
      .groupBy(schema.stockTransferLines.variantId),
    // As-Is quantity — a buyer aid column, never part of the math.
    db
      .select({
        variantId: schema.asIsItems.variantId,
        qty: sql<number>`COALESCE(SUM(${schema.asIsItems.quantity}), 0)::int`,
      })
      .from(schema.asIsItems)
      .where(
        and(
          biz(schema.asIsItems),
          inArray(schema.asIsItems.variantId, ids),
          eq(schema.asIsItems.status, 'pending_review'),
        ),
      )
      .groupBy(schema.asIsItems.variantId),
    // Last sale date (POS completion), a grid display column.
    db
      .select({
        variantId: schema.saleLines.variantId,
        last: max(schema.sales.completedAt),
      })
      .from(schema.saleLines)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.saleLines.saleId))
      .where(
        and(
          biz(schema.saleLines),
          inArray(schema.saleLines.variantId, ids),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
        ),
      )
      .groupBy(schema.saleLines.variantId),
  ]);

  const by = <T extends { variantId: string | null }>(rows: T[]) =>
    new Map(rows.filter((r) => r.variantId).map((r) => [r.variantId as string, r]));
  const levelBy = by(levels);
  const posBy = by(posSold);
  const orderBy = by(orderSold);
  const delivBy = by(deliveredSold);
  const retBy = by(returned);
  const onOrderBy = by(onOrder);
  const demandBy = by(demand);
  const xferBy = by(transfers);
  const asIsBy = by(asIs);
  const lastBy = by(lastSale);

  const products: ReplenishmentProduct[] = candidates.map((c) => {
    const lvl = levelBy.get(c.variantId);
    const dem = demandBy.get(c.variantId);
    const unitsSold =
      control.unitSalesRateCalculation === 'delivered'
        ? (delivBy.get(c.variantId)?.qty ?? 0) + (posBy.get(c.variantId)?.qty ?? 0)
        : (posBy.get(c.variantId)?.qty ?? 0) + (orderBy.get(c.variantId)?.qty ?? 0);
    const last = lastBy.get(c.variantId)?.last ?? null;
    return {
      variantId: c.variantId,
      categoryId: c.categoryId,
      categoryLineage: categoryIndex.lineageOf(c.categoryId),
      unitsSold,
      unitsReturned: retBy.get(c.variantId)?.qty ?? 0,
      warehouseOnHand: lvl?.whOnHand ?? 0,
      warehouseCommitted: lvl?.whCommitted ?? 0,
      storeStockAvailable: lvl?.storeAvailable ?? 0,
      onOrder: onOrderBy.get(c.variantId)?.qty ?? 0,
      uncommittedDemand: dem?.uncommitted ?? 0,
      dueSoonDemand: dem?.dueSoon ?? 0,
      inboundTransfers: xferBy.get(c.variantId)?.qty ?? 0,
      layawayUnits: dem?.layaway ?? 0,
      unitVolume: c.capacityUnits,
      asIsQty: asIsBy.get(c.variantId)?.qty ?? 0,
      lastSaleDate: last
        ? new Date(last as unknown as string | Date).toISOString().slice(0, 10)
        : null,
    };
  });

  return { products, meta };
}

/**
 * Parse and default the stored vendor document. Null/absent = vendor not
 * enabled for sales-rate replenishment (callers 400/skip).
 */
export function parseVendorReplenishment(raw: unknown): VendorReplenishmentSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    generateAutomaticPos: r.generateAutomaticPos === true,
    automaticallyHoldPos: r.automaticallyHoldPos === true,
    weeklySalesRateWeeks: asInt(r.weeklySalesRateWeeks, 8),
    includeAllBackOrders: r.includeAllBackOrders === true,
    daysForReplenishment: r.daysForReplenishment == null ? null : asInt(r.daysForReplenishment, 0),
    minimumStockDays: asInt(r.minimumStockDays, 0),
    leadDays: asInt(r.leadDays, 0),
    variancePercent: asInt(r.variancePercent, 100),
    varianceStart: typeof r.varianceStart === 'string' ? r.varianceStart : null,
    varianceEnd: typeof r.varianceEnd === 'string' ? r.varianceEnd : null,
    minimumSalesRate: typeof r.minimumSalesRate === 'number' ? r.minimumSalesRate : 0,
    buildDays: Array.isArray(r.buildDays)
      ? r.buildDays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
      : [],
    categoryExceptions: Array.isArray(r.categoryExceptions)
      ? r.categoryExceptions
          .filter(
            (e): e is { categoryId: string; minimumStockDays?: number; leadDays?: number } =>
              !!e &&
              typeof e === 'object' &&
              typeof (e as { categoryId?: unknown }).categoryId === 'string',
          )
          .map((e) => ({
            categoryId: e.categoryId,
            minimumStockDays: e.minimumStockDays,
            leadDays: e.leadDays,
          }))
      : undefined,
    defaultRequestedDate: r.defaultRequestedDate === 'today' ? 'today' : 'vendor_lead_days',
    firstAverageUnitsPeriodWeeks: asInt(r.firstAverageUnitsPeriodWeeks, 4),
    secondAverageUnitsPeriodWeeks: asInt(r.secondAverageUnitsPeriodWeeks, 12),
    sortCriteria:
      r.sortCriteria === 'product' ||
      r.sortCriteria === 'category' ||
      r.sortCriteria === 'group' ||
      r.sortCriteria === 'vendor_model'
        ? r.sortCriteria
        : 'vendor_model',
  };
}

function asInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}
