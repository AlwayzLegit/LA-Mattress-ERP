import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';

/** A customer order line still waiting for stock that no PO covers yet. */
export interface WaitingOrderLine {
  orderLineId: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  /** Units the line still lacks after stock reservations and PO allocations. */
  quantity: number;
}

/**
 * A draft transfer line the origin cannot ship yet (owner 2026-10-21: a
 * floor model moved to a store on a transfer that must first be ordered
 * on a PO shows under Purchasing, linked to the transfer, like a customer
 * order would).
 */
export interface WaitingTransferLine {
  transferLineId: string;
  transferId: string;
  transferNumber: string;
  fromLocationName: string | null;
  toLocationName: string | null;
  /** Units the line still lacks at the origin. */
  quantity: number;
}

export interface ReorderSuggestionLine {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorSku: string | null;
  available: number;
  reorderPoint: number | null;
  /**
   * Units sold to customers, not in stock and on no PO (oldest order
   * first) — plus draft transfer units the origin store cannot ship.
   */
  waitingQty: number;
  waitingOrders: WaitingOrderLine[];
  waitingTransfers: WaitingTransferLine[];
  /** Open (placed) PO units not already promised to a customer. */
  onPoQty: number;
  /** Of `suggestedQty`: what the waiting customers still need. */
  customerQty: number;
  /** Of `suggestedQty`: the reorder-point top-up for the shelf. */
  stockQty: number;
  suggestedQty: number;
  unitCostCents: number | null;
}

export interface ReorderVendorGroup {
  vendorId: string | null;
  vendorName: string | null;
  lines: ReorderSuggestionLine[];
}

const OPEN_ORDER_STATUSES = ['open', 'partially_fulfilled'];
const OPEN_PO_STATUSES = ['ordered', 'partially_received'];

/**
 * Draft transfers short of stock at their origin, per variant (owner
 * 2026-10-21). A draft is the only state a transfer can wait in: it ships
 * once the origin has the units, so until then its lines are demand on
 * the origin the same way an open order line is. Counted: the scheduled
 * quantity less what the origin has free, after the origin's own waiting
 * orders (already counted) took theirs. Auto transfers (generated from a
 * sales order) are skipped — their order line is already waiting.
 */
async function waitingTransferLines(
  db: PostgresJsDatabase,
  businessId: string | undefined,
  orderDemandAt: Map<string, number>,
): Promise<Map<string, WaitingTransferLine[]>> {
  const from = alias(schema.locations, 'from_loc');
  const to = alias(schema.locations, 'to_loc');
  const freeAtOrigin = sql<number>`COALESCE((SELECT SUM(il.on_hand - il.reserved - il.floor_sample) FROM inventory_levels il WHERE il.variant_id = ${schema.stockTransferLines.variantId} AND il.location_id = ${schema.stockTransfers.fromLocationId}), 0)::int`;
  const rows = await db
    .select({
      transferLineId: schema.stockTransferLines.id,
      transferId: schema.stockTransfers.id,
      transferNumber: schema.stockTransfers.number,
      variantId: schema.stockTransferLines.variantId,
      fromLocationId: schema.stockTransfers.fromLocationId,
      fromLocationName: from.name,
      toLocationName: to.name,
      quantity: schema.stockTransferLines.quantityShipped,
      freeAtOrigin,
    })
    .from(schema.stockTransferLines)
    .innerJoin(
      schema.stockTransfers,
      eq(schema.stockTransfers.id, schema.stockTransferLines.transferId),
    )
    .leftJoin(from, eq(from.id, schema.stockTransfers.fromLocationId))
    .leftJoin(to, eq(to.id, schema.stockTransfers.toLocationId))
    .where(
      and(
        businessId ? eq(schema.stockTransferLines.businessId, businessId) : undefined,
        eq(schema.stockTransfers.status, 'draft'),
        isNull(schema.stockTransfers.orderId),
        sql`${schema.stockTransferLines.quantityShipped} > 0`,
      ),
    )
    .orderBy(asc(schema.stockTransfers.createdAt), asc(schema.stockTransferLines.id));
  const out = new Map<string, WaitingTransferLine[]>();
  // Free stock at one origin covers its transfers in creation order, after
  // the orders that already draw from that store.
  const freeLeft = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.variantId}:${r.fromLocationId}`;
    if (!freeLeft.has(key)) {
      freeLeft.set(key, Math.max(0, r.freeAtOrigin - (orderDemandAt.get(key) ?? 0)));
    }
    const free = freeLeft.get(key)!;
    const covered = Math.min(free, r.quantity);
    freeLeft.set(key, free - covered);
    const short = r.quantity - covered;
    if (short <= 0) continue;
    const list = out.get(r.variantId) ?? [];
    list.push({
      transferLineId: r.transferLineId,
      transferId: r.transferId,
      transferNumber: r.transferNumber,
      fromLocationName: r.fromLocationName ?? null,
      toLocationName: r.toLocationName ?? null,
      quantity: short,
    });
    out.set(r.variantId, list);
  }
  return out;
}

/**
 * Pure arithmetic of one suggestion row (owner 2026-10-01: "making the
 * order doesn't increase the suggested number").
 *
 * - **Customer need**: units sold and waiting, less what is free on the
 *   shelf and what open POs already bring in.
 * - **Stock top-up**: once those customers are served, the shelf
 *   position (free stock + open PO − waiting + customer need) is
 *   compared with the reorder point; at or below it, the variant's
 *   reorder qty, else a top-up to 2× the point (never less than 1).
 *   A point of 0 means the item is not kept on the shelf (owner
 *   2026-10-01: every STORIS Min Stock came in as 0, and "0 on hand,
 *   point 0" suggested 1 for every out-of-stock item) — no top-up;
 *   customers waiting still count.
 *
 * Returns null when there is nothing to suggest.
 */
export function suggestionFor(input: {
  available: number;
  onPo: number;
  waiting: number;
  reorderPoint: number | null;
  reorderQty: number | null;
}): { customerQty: number; stockQty: number; suggestedQty: number } | null {
  const free = Math.max(0, input.available);
  const onPo = Math.max(0, input.onPo);
  const customerQty = Math.max(0, input.waiting - free - onPo);
  const position = input.available + onPo - input.waiting + customerQty;
  const point = input.reorderPoint;
  const stockQty =
    point != null && point > 0 && position <= point
      ? (input.reorderQty ?? Math.max(1, point * 2 - position))
      : 0;
  const suggestedQty = customerQty + stockQty;
  return suggestedQty > 0 ? { customerQty, stockQty, suggestedQty } : null;
}

/**
 * Reorder suggestions (REPL-040 basis), grouped by preferred vendor:
 * every active variant whose customers are waiting on stock, or whose
 * position sits at or below its reorder point.
 *
 * Available = on-hand − reserved − floor samples, summed across
 * locations. Waiting = open order lines (stock and special-order; not
 * direct-ship, not services) short of stock, net of reservations and PO
 * allocations — the same shortfall the Replenish screen's allocated-order
 * run uses. On PO = placed, undeleted, non-direct-ship PO units not yet
 * received and not allocated to a customer.
 *
 * Shared by the interactive endpoint (request-scoped db, RLS supplies
 * the tenant) and the nightly auto-replenishment job (root db — pass
 * `businessId` explicitly; every query is scoped by it).
 */
export async function computeReorderSuggestions(
  db: PostgresJsDatabase,
  businessId?: string,
): Promise<ReorderVendorGroup[]> {
  // 1. Customers waiting: open order lines short of stock and PO cover.
  // Services (installation, removal, fees) are sold, never stocked —
  // the same rule migration 0108 used to find them.
  const serviceProduct = sql`(
    ${schema.products.name} ~* '\\minstall'
    OR ${schema.products.categoryId} IN (
      SELECT c.id FROM categories c
      LEFT JOIN categories pc ON pc.id = c.parent_id
      WHERE c.name IN ('Delivery & Installation', 'Services & Fees')
         OR pc.name IN ('Delivery & Installation', 'Services & Fees')
    )
  )`;
  const allocated = sql<number>`COALESCE((SELECT SUM(${schema.poLineAllocations.quantity}) FROM ${schema.poLineAllocations} WHERE ${schema.poLineAllocations.orderLineId} = ${schema.orderLines.id} AND ${schema.poLineAllocations.status} = 'ordered'), 0)::int`;
  const demandRows = await db
    .select({
      orderLineId: schema.orderLines.id,
      variantId: schema.orderLines.variantId,
      quantity: schema.orderLines.quantity,
      qtyReserved: schema.orderLines.qtyReserved,
      qtyFulfilled: schema.orderLines.qtyFulfilled,
      allocated,
      orderId: schema.orders.id,
      orderNumber: schema.orders.number,
      customerName: sql<
        string | null
      >`NULLIF(TRIM(CONCAT(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
      drawsFrom: sql<string>`COALESCE(${schema.orderLines.sourceLocationId}, ${schema.orders.stockLocationId}, ${schema.orders.locationId})`,
    })
    .from(schema.orderLines)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
    .where(
      and(
        businessId ? eq(schema.orderLines.businessId, businessId) : undefined,
        inArray(schema.orders.status, OPEN_ORDER_STATUSES),
        inArray(schema.orderLines.lineType, ['stock', 'special_order']),
        sql`${schema.orderLines.quantity} - ${schema.orderLines.qtyFulfilled} - ${schema.orderLines.qtyReserved} > 0`,
        sql`NOT ${serviceProduct}`,
      ),
    )
    .orderBy(asc(schema.orders.createdAt), asc(schema.orderLines.createdAt));
  const waitingBy = new Map<string, WaitingOrderLine[]>();
  /** Waiting order units per (variant, store they draw from). */
  const orderDemandAt = new Map<string, number>();
  for (const r of demandRows) {
    const short = r.quantity - r.qtyFulfilled - r.qtyReserved - r.allocated;
    if (short <= 0 || !r.variantId) continue;
    const list = waitingBy.get(r.variantId) ?? [];
    list.push({
      orderLineId: r.orderLineId,
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      customerName: r.customerName,
      quantity: short,
    });
    waitingBy.set(r.variantId, list);
    const at = `${r.variantId}:${r.drawsFrom}`;
    orderDemandAt.set(at, (orderDemandAt.get(at) ?? 0) + short);
  }
  // 1b. Draft transfers the origin store cannot ship yet.
  const transfersBy = await waitingTransferLines(db, businessId, orderDemandAt);
  const waitingIds = [...new Set([...waitingBy.keys(), ...transfersBy.keys()])];

  // 2. Candidate variants: a reorder point, or customers waiting.
  const rows = await db
    .select({
      variantId: schema.productVariants.id,
      productName: schema.products.name,
      variantName: schema.productVariants.name,
      sku: schema.productVariants.sku,
      vendorSku: schema.productVariants.vendorSku,
      reorderPoint: schema.productVariants.reorderPoint,
      reorderQty: schema.productVariants.reorderQty,
      costCents: schema.productVariants.costCents,
      vendorId: schema.productVariants.preferredVendorId,
      vendorName: schema.vendors.name,
      available: sql<number>`COALESCE(SUM(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample}), 0)::int`,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .leftJoin(
      schema.inventoryLevels,
      businessId
        ? and(
            eq(schema.inventoryLevels.variantId, schema.productVariants.id),
            eq(schema.inventoryLevels.businessId, businessId),
          )
        : eq(schema.inventoryLevels.variantId, schema.productVariants.id),
    )
    .leftJoin(schema.vendors, eq(schema.vendors.id, schema.productVariants.preferredVendorId))
    .where(
      and(
        or(
          sql`${schema.productVariants.reorderPoint} IS NOT NULL`,
          waitingIds.length ? inArray(schema.productVariants.id, waitingIds) : undefined,
        ),
        eq(schema.productVariants.isActive, true),
        eq(schema.products.isActive, true),
        businessId ? eq(schema.productVariants.businessId, businessId) : undefined,
      ),
    )
    .groupBy(
      schema.productVariants.id,
      schema.products.name,
      schema.productVariants.name,
      schema.productVariants.sku,
      schema.productVariants.vendorSku,
      schema.productVariants.reorderPoint,
      schema.productVariants.reorderQty,
      schema.productVariants.costCents,
      schema.productVariants.preferredVendorId,
      schema.vendors.name,
    );
  if (rows.length === 0) return [];

  // 3. Open PO units not already promised to a customer.
  const poAllocated = sql<number>`COALESCE((SELECT SUM(${schema.poLineAllocations.quantity}) FROM ${schema.poLineAllocations} WHERE ${schema.poLineAllocations.poLineId} = ${schema.purchaseOrderLines.id} AND ${schema.poLineAllocations.status} = 'ordered'), 0)::int`;
  const poRows = await db
    .select({
      variantId: schema.purchaseOrderLines.variantId,
      open: sql<number>`(${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected})::int`,
      allocated: poAllocated,
    })
    .from(schema.purchaseOrderLines)
    .innerJoin(
      schema.purchaseOrders,
      eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
    )
    .where(
      and(
        businessId ? eq(schema.purchaseOrderLines.businessId, businessId) : undefined,
        inArray(schema.purchaseOrders.status, OPEN_PO_STATUSES),
        isNull(schema.purchaseOrders.deletedAt),
        eq(schema.purchaseOrders.directShip, false),
      ),
    );
  const onPoBy = new Map<string, number>();
  for (const p of poRows) {
    const free = Math.max(0, p.open - p.allocated);
    if (free > 0) onPoBy.set(p.variantId, (onPoBy.get(p.variantId) ?? 0) + free);
  }

  const byVendor = new Map<string, ReorderVendorGroup>();
  for (const r of rows) {
    const waitingOrders = waitingBy.get(r.variantId) ?? [];
    const waitingTransfers = transfersBy.get(r.variantId) ?? [];
    const waitingQty =
      waitingOrders.reduce((n, w) => n + w.quantity, 0) +
      waitingTransfers.reduce((n, w) => n + w.quantity, 0);
    const onPoQty = onPoBy.get(r.variantId) ?? 0;
    const s = suggestionFor({
      available: r.available,
      onPo: onPoQty,
      waiting: waitingQty,
      reorderPoint: r.reorderPoint,
      reorderQty: r.reorderQty,
    });
    if (!s) continue;
    const key = r.vendorId ?? 'unassigned';
    const group = byVendor.get(key) ?? {
      vendorId: r.vendorId ?? null,
      vendorName: r.vendorName ?? null,
      lines: [],
    };
    group.lines.push({
      variantId: r.variantId,
      productName: r.productName,
      variantName: r.variantName,
      sku: r.sku,
      vendorSku: r.vendorSku,
      available: r.available,
      reorderPoint: r.reorderPoint,
      waitingQty,
      waitingOrders,
      waitingTransfers,
      onPoQty,
      customerQty: s.customerQty,
      stockQty: s.stockQty,
      suggestedQty: s.suggestedQty,
      unitCostCents: r.costCents ?? null,
    });
    byVendor.set(key, group);
  }
  for (const g of byVendor.values()) {
    // Customers waiting first, then the shelf top-ups.
    g.lines.sort(
      (a, b) =>
        Number(b.customerQty > 0) - Number(a.customerQty > 0) ||
        a.productName.localeCompare(b.productName),
    );
  }
  return [...byVendor.values()].sort((a, b) =>
    (a.vendorName ?? 'zzz').localeCompare(b.vendorName ?? 'zzz'),
  );
}
