import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { loadCategoryIndex } from '../catalog/category-tree';
import { AuditService } from '../audit/audit.service';
import {
  CurrentTenant,
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { generatePoNumber } from './po-number';
import {
  allocatedNeed,
  availableOf,
  cartonRound,
  EMPTY_CELL,
  stockLevelNeed,
  type ReplenishMode,
  type ReplenishOptions,
  type StockCell,
  type StockLevelBasis,
} from './replenish-engine';
import { parseVendorReplenishment } from './replenishment-data';
import {
  cuttingDateMessage,
  defaultFreightCents,
  loadLandedCost,
  pastCuttingDate,
  todayIso,
} from './vendor-settings';

/**
 * STORIS "Replenish Inventory" (A22 slice 4): one screen, two
 * replenishment types, every vendor at once.
 *
 * - **Allocated order**: every open sales-order line short of stock —
 *   not fulfilled, not reserved, not already covered by a PO allocation
 *   — grouped by product at the location the order draws from, netted
 *   against what is free there and what is already on open POs.
 * - **Stock level**: every position below its threshold — the store's
 *   Min Stock (`inventory_levels.reorder_point`, basis `minimum`) or the
 *   variant's safety point (`product_variants.reorder_point`, basis
 *   `safety`, business-wide).
 *
 * Rows group by the vendor that supplies the variant (preferred vendor,
 * else the collection's vendor, else the vendor named like the brand);
 * "Create purchase orders" writes one PO per vendor and receiving
 * location, with the special-order allocations that let receiving
 * commit the units to the customer. Carton rounding uses the product's
 * purchase carton quantity.
 */

const MODES = ['allocated_order', 'stock_level'] as const;
const BASES = ['minimum', 'safety'] as const;
const OPEN_ORDER_STATUSES = ['open', 'partially_fulfilled'] as const;
const OPEN_PO_STATUSES = ['ordered', 'partially_received'] as const;
/** STORIS fulfillment-status checkboxes → the order's delivery status ('none' = not set). */
export const REPLENISH_DELIVERY_STATUSES = [
  'scheduled',
  'estimated',
  'asap',
  'will_call',
  'none',
] as const;
type DeliveryStatusFilter = (typeof REPLENISH_DELIVERY_STATUSES)[number];

interface RunBody {
  mode?: ReplenishMode;
  /** Receiving location (allocated: the orders' stock location; stock level: the store). Null = every location. */
  locationId?: string | null;
  vendorId?: string | null;
  categoryId?: string | null;
  collectionId?: string | null;
  /** SKU / product-name contains. */
  q?: string | null;
  /** Allocated order: which order delivery statuses count. Empty / null = all. */
  deliveryStatuses?: DeliveryStatusFilter[] | null;
  stockLevelBasis?: StockLevelBasis;
  includeFloorSamples?: boolean;
  includeReturns?: boolean;
  roundToCarton?: boolean;
  /** Keep rows with nothing to order (the position is fine) in the grid. */
  includeZero?: boolean;
}

interface CreateBody extends RunBody {
  /** Buyer edits: the total quantity to order per row (variant + location). */
  overrides?: { variantId?: string; locationId?: string | null; totalQty?: number }[];
  /** Only these vendors' groups become POs (default: every vendor group). */
  vendorIds?: string[] | null;
  /** Place immediately (default) or leave the POs as drafts. */
  place?: boolean;
  notes?: string | null;
}

export interface ReplenishOrderRef {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  lineId: string;
  quantity: number;
  /** Units the line still lacks after stock reservations and PO allocations. */
  shortfall: number;
  fillBy: string | null;
  deliveryStatus: string | null;
}

export interface ReplenishLine extends StockCell {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorSku: string | null;
  categoryName: string | null;
  /** Full path ("Mattresses › Hybrid"); categoryName is the leaf. */
  categoryPath: string | null;
  collectionName: string | null;
  costCents: number | null;
  locationId: string | null;
  locationName: string | null;
  available: number;
  /** Allocated order: uncovered order units. Stock level: the threshold in force. */
  demand: number;
  minimum: number | null;
  safety: number | null;
  reorderQty: number | null;
  /** Raw need before rounding. */
  orderQty: number;
  cartonQty: number;
  cartons: number;
  /** What the PO line gets (rounded when asked). */
  totalQty: number;
  orders: ReplenishOrderRef[];
}

export interface ReplenishVendorGroup {
  vendorId: string | null;
  vendorName: string | null;
  lines: ReplenishLine[];
  totals: { lines: number; totalQty: number; costCents: number };
}

export interface ReplenishResult {
  generatedAt: string;
  mode: ReplenishMode;
  basis: StockLevelBasis;
  options: ReplenishOptions;
  groups: ReplenishVendorGroup[];
  totals: { lines: number; totalQty: number; costCents: number };
}

interface Parsed {
  mode: ReplenishMode;
  basis: StockLevelBasis;
  locationId: string | null;
  vendorId: string | null;
  categoryId: string | null;
  collectionId: string | null;
  q: string | null;
  deliveryStatuses: DeliveryStatusFilter[] | null;
  options: ReplenishOptions;
  includeZero: boolean;
}

interface VariantMeta {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorSku: string | null;
  costCents: number | null;
  categoryId: string | null;
  categoryName: string | null;
  collectionId: string | null;
  collectionName: string | null;
  collectionVendorId: string | null;
  brandName: string | null;
  preferredVendorId: string | null;
  purchaseCartonQty: number;
  reorderPoint: number | null;
  reorderQty: number | null;
  variantActive: boolean;
  productActive: boolean;
}

const cellKey = (variantId: string, locationId: string | null) =>
  `${variantId}:${locationId ?? '*'}`;

@TenantScoped()
@Controller('v1/purchasing/replenish')
export class ReplenishController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Criteria → the grid, grouped by vendor. */
  @Post('run')
  @RequirePermission('purchase_orders.view')
  async run(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: RunBody,
  ): Promise<ReplenishResult> {
    const parsed = this.parse(body);
    return this.compute(tenant.businessId!, parsed);
  }

  /**
   * Create purchase orders from the grid: recompute the run, apply the
   * buyer's quantity edits, and write one PO per vendor and receiving
   * location — with special-order allocations in allocated-order mode.
   */
  @Post('purchase-orders')
  @RequirePermission('purchase_orders.create')
  async createPurchaseOrders(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: CreateBody,
  ): Promise<{
    purchaseOrders: {
      vendorId: string;
      vendorName: string | null;
      locationId: string;
      poId: string;
      number: string;
      status: string;
      lineCount: number;
      totalQty: number;
    }[];
    skipped: { vendorName: string | null; reason: string }[];
  }> {
    const parsed = this.parse(body);
    const businessId = tenant.businessId!;
    const overrides = new Map<string, number>();
    for (const o of body.overrides ?? []) {
      if (!o.variantId || !Number.isInteger(o.totalQty) || (o.totalQty ?? -1) < 0) {
        throw new BadRequestException('overrides[] entries need variantId + non-negative totalQty');
      }
      overrides.set(cellKey(o.variantId, o.locationId ?? null), o.totalQty!);
    }
    const wanted = body.vendorIds?.length ? new Set(body.vendorIds) : null;
    const place = body.place !== false;

    const result = await this.compute(businessId, { ...parsed, includeZero: true });
    const created: {
      vendorId: string;
      vendorName: string | null;
      locationId: string;
      poId: string;
      number: string;
      status: string;
      lineCount: number;
      totalQty: number;
    }[] = [];
    const skipped: { vendorName: string | null; reason: string }[] = [];

    for (const group of result.groups) {
      if (wanted && (!group.vendorId || !wanted.has(group.vendorId))) continue;
      const lines = group.lines
        .map((l) => ({
          ...l,
          totalQty: overrides.get(cellKey(l.variantId, l.locationId)) ?? l.totalQty,
        }))
        .filter((l) => l.totalQty > 0);
      if (lines.length === 0) continue;
      if (!group.vendorId) {
        skipped.push({
          vendorName: null,
          reason: `${lines.length} line(s) have no vendor — set a preferred vendor on the product first`,
        });
        continue;
      }
      // One PO per receiving location; safety-stock rows have none and
      // need the run's location.
      const byLocation = new Map<string, typeof lines>();
      for (const l of lines) {
        const locationId = l.locationId ?? parsed.locationId;
        if (!locationId) {
          throw new BadRequestException(
            'locationId is required to create purchase orders for safety-stock rows',
          );
        }
        byLocation.set(locationId, [...(byLocation.get(locationId) ?? []), l]);
      }
      for (const [locationId, locLines] of byLocation) {
        const po = await this.writePurchaseOrder(businessId, actor, {
          vendorId: group.vendorId,
          vendorName: group.vendorName,
          locationId,
          lines: locLines,
          mode: parsed.mode,
          place,
          notes: body.notes ?? null,
        });
        if (po) created.push(po);
        else {
          skipped.push({
            vendorName: group.vendorName,
            reason: 'Every line is past its PO cutting date',
          });
        }
      }
    }
    if (created.length === 0 && skipped.length === 0) {
      throw new BadRequestException('No lines with quantity to order — nothing to create');
    }
    return { purchaseOrders: created, skipped };
  }

  // ─── run ──────────────────────────────────────────────────────────────

  private parse(body: RunBody): Parsed {
    const mode = body.mode ?? 'allocated_order';
    if (!MODES.includes(mode)) {
      throw new BadRequestException(`mode must be one of ${MODES.join(', ')}`);
    }
    const basis = body.stockLevelBasis ?? 'minimum';
    if (!BASES.includes(basis)) {
      throw new BadRequestException(`stockLevelBasis must be one of ${BASES.join(', ')}`);
    }
    const statuses = (body.deliveryStatuses ?? []).filter(Boolean);
    for (const s of statuses) {
      if (!REPLENISH_DELIVERY_STATUSES.includes(s)) {
        throw new BadRequestException(
          `deliveryStatuses must be among ${REPLENISH_DELIVERY_STATUSES.join(', ')}`,
        );
      }
    }
    return {
      mode,
      basis,
      locationId: body.locationId || null,
      vendorId: body.vendorId || null,
      categoryId: body.categoryId || null,
      collectionId: body.collectionId || null,
      q: body.q?.trim() || null,
      deliveryStatuses: statuses.length ? statuses : null,
      options: {
        includeFloorSamples: body.includeFloorSamples === true,
        includeReturns: body.includeReturns === true,
        roundToCarton: body.roundToCarton === true,
      },
      includeZero: body.includeZero === true,
    };
  }

  private async compute(businessId: string, p: Parsed): Promise<ReplenishResult> {
    if (p.locationId) {
      const [loc] = await this.db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.id, p.locationId))
        .limit(1);
      if (!loc) throw new NotFoundException('Location not found');
    }

    // 1. The positions that want something, by mode.
    type Position = {
      variantId: string;
      locationId: string | null;
      demand: number;
      minimum: number | null;
      safety: number | null;
      orders: ReplenishOrderRef[];
    };
    const positions: Position[] = [];
    if (p.mode === 'allocated_order') {
      const lines = await this.openOrderLines(p);
      const byKey = new Map<string, Position>();
      for (const l of lines) {
        const key = cellKey(l.variantId, l.locationId);
        const pos = byKey.get(key) ?? {
          variantId: l.variantId,
          locationId: l.locationId,
          demand: 0,
          minimum: null,
          safety: null,
          orders: [],
        };
        pos.demand += l.shortfall;
        pos.orders.push({
          orderId: l.orderId,
          orderNumber: l.orderNumber,
          customerName: l.customerName,
          lineId: l.lineId,
          quantity: l.quantity,
          shortfall: l.shortfall,
          fillBy: l.fillBy,
          deliveryStatus: l.deliveryStatus,
        });
        byKey.set(key, pos);
      }
      positions.push(...byKey.values());
    } else if (p.basis === 'minimum') {
      const levels = await this.db
        .select({
          variantId: schema.inventoryLevels.variantId,
          locationId: schema.inventoryLevels.locationId,
          minimum: schema.inventoryLevels.reorderPoint,
        })
        .from(schema.inventoryLevels)
        .where(
          and(
            sql`${schema.inventoryLevels.reorderPoint} IS NOT NULL`,
            p.locationId ? eq(schema.inventoryLevels.locationId, p.locationId) : undefined,
          ),
        );
      for (const l of levels) {
        positions.push({
          variantId: l.variantId,
          locationId: l.locationId,
          demand: l.minimum!,
          minimum: l.minimum,
          safety: null,
          orders: [],
        });
      }
    } else {
      const variants = await this.db
        .select({
          variantId: schema.productVariants.id,
          safety: schema.productVariants.reorderPoint,
        })
        .from(schema.productVariants)
        .where(sql`${schema.productVariants.reorderPoint} IS NOT NULL`);
      for (const v of variants) {
        positions.push({
          variantId: v.variantId,
          locationId: p.locationId,
          demand: v.safety!,
          minimum: null,
          safety: v.safety,
          orders: [],
        });
      }
    }
    if (positions.length === 0) return this.emptyResult(p);

    // 2. Product / vendor meta, filtered.
    const variantIds = [...new Set(positions.map((x) => x.variantId))];
    const meta = await this.loadMeta(businessId, variantIds);
    const vendorOf = await this.vendorResolver(businessId);
    // A22.1: categories nest — "Mattresses" keeps every subcategory.
    const categoryIndex = await loadCategoryIndex(this.db, businessId);
    const categoryIds = p.categoryId ? new Set(categoryIndex.treeIds(p.categoryId)) : null;
    const keep = new Set<string>();
    for (const m of meta.values()) {
      if (!m.variantActive || !m.productActive) continue;
      if (categoryIds && (!m.categoryId || !categoryIds.has(m.categoryId))) continue;
      if (p.collectionId && m.collectionId !== p.collectionId) continue;
      if (p.q) {
        const hay = `${m.sku ?? ''} ${m.vendorSku ?? ''} ${m.productName} ${m.variantName ?? ''}`;
        if (!hay.toLowerCase().includes(p.q.toLowerCase())) continue;
      }
      if (p.vendorId && vendorOf(m).vendorId !== p.vendorId) continue;
      keep.add(m.variantId);
    }
    const kept = positions.filter((x) => keep.has(x.variantId));
    if (kept.length === 0) return this.emptyResult(p);

    // 3. Stock cells: levels, pending as-is, net open PO — per location,
    // or summed across locations for the business-wide safety basis.
    const cells = await this.loadCells(
      [...new Set(kept.map((x) => x.variantId))],
      p.mode === 'stock_level' && p.basis === 'safety' ? null : p.locationId,
      p.mode === 'stock_level' && p.basis === 'safety',
    );
    const locationNames = new Map(
      (
        await this.db
          .select({ id: schema.locations.id, name: schema.locations.name })
          .from(schema.locations)
      ).map((l) => [l.id, l.name]),
    );

    // 4. Rows.
    const lines: ReplenishLine[] = [];
    for (const pos of kept) {
      const m = meta.get(pos.variantId)!;
      const cell =
        cells.get(cellKey(pos.variantId, pos.locationId)) ??
        cells.get(cellKey(pos.variantId, null)) ??
        EMPTY_CELL;
      const available = availableOf(cell, p.options);
      const orderQty =
        p.mode === 'allocated_order'
          ? allocatedNeed(pos.demand, available, cell.netOnPo)
          : stockLevelNeed(pos.demand, available, cell.netOnPo, m.reorderQty);
      const rounded = cartonRound(orderQty, m.purchaseCartonQty, p.options.roundToCarton);
      if (rounded.totalQty === 0 && !p.includeZero) continue;
      pos.orders.sort((a, b) => (a.fillBy ?? '9999').localeCompare(b.fillBy ?? '9999'));
      lines.push({
        ...cell,
        variantId: pos.variantId,
        productId: m.productId,
        productName: m.productName,
        variantName: m.variantName,
        sku: m.sku,
        vendorSku: m.vendorSku,
        categoryName: m.categoryName,
        categoryPath: categoryIndex.pathOf(m.categoryId),
        collectionName: m.collectionName,
        costCents: m.costCents,
        locationId: pos.locationId,
        locationName: pos.locationId ? (locationNames.get(pos.locationId) ?? null) : null,
        available,
        demand: pos.demand,
        minimum: pos.minimum,
        safety: pos.safety,
        reorderQty: m.reorderQty,
        orderQty,
        cartonQty: rounded.cartonQty,
        cartons: rounded.cartons,
        totalQty: rounded.totalQty,
        orders: pos.orders,
      });
    }

    // 5. Group by vendor.
    const groups = new Map<string, ReplenishVendorGroup>();
    for (const line of lines) {
      const v = vendorOf(meta.get(line.variantId)!);
      const key = v.vendorId ?? '~';
      const g = groups.get(key) ?? {
        vendorId: v.vendorId,
        vendorName: v.vendorName,
        lines: [],
        totals: { lines: 0, totalQty: 0, costCents: 0 },
      };
      g.lines.push(line);
      g.totals.lines += 1;
      g.totals.totalQty += line.totalQty;
      g.totals.costCents += line.totalQty * (line.costCents ?? 0);
      groups.set(key, g);
    }
    // Vendors alphabetically, the vendor-less group last.
    const sorted = [...groups.values()].sort((a, b) =>
      a.vendorId && b.vendorId
        ? (a.vendorName ?? '').localeCompare(b.vendorName ?? '')
        : Number(!a.vendorId) - Number(!b.vendorId),
    );
    for (const g of sorted) {
      g.lines.sort(
        (a, b) =>
          (a.vendorSku ?? a.sku ?? '~').localeCompare(b.vendorSku ?? b.sku ?? '~') ||
          (a.locationName ?? '').localeCompare(b.locationName ?? ''),
      );
    }
    return {
      generatedAt: new Date().toISOString(),
      mode: p.mode,
      basis: p.basis,
      options: p.options,
      groups: sorted,
      totals: sorted.reduce(
        (t, g) => ({
          lines: t.lines + g.totals.lines,
          totalQty: t.totalQty + g.totals.totalQty,
          costCents: t.costCents + g.totals.costCents,
        }),
        { lines: 0, totalQty: 0, costCents: 0 },
      ),
    };
  }

  private emptyResult(p: Parsed): ReplenishResult {
    return {
      generatedAt: new Date().toISOString(),
      mode: p.mode,
      basis: p.basis,
      options: p.options,
      groups: [],
      totals: { lines: 0, totalQty: 0, costCents: 0 },
    };
  }

  /** Open order lines short of stock and of PO cover, at the location they draw from. */
  private async openOrderLines(p: Parsed): Promise<
    {
      lineId: string;
      variantId: string;
      locationId: string;
      quantity: number;
      shortfall: number;
      orderId: string;
      orderNumber: string;
      customerName: string | null;
      fillBy: string | null;
      deliveryStatus: string | null;
    }[]
  > {
    const location = sql<string>`COALESCE(${schema.orderLines.sourceLocationId}, ${schema.orders.stockLocationId}, ${schema.orders.locationId})`;
    const allocated = sql<number>`COALESCE((SELECT SUM(${schema.poLineAllocations.quantity}) FROM ${schema.poLineAllocations} WHERE ${schema.poLineAllocations.orderLineId} = ${schema.orderLines.id} AND ${schema.poLineAllocations.status} = 'ordered'), 0)::int`;
    const statusFilter = p.deliveryStatuses
      ? (() => {
          const named = p.deliveryStatuses.filter((s) => s !== 'none');
          const none = p.deliveryStatuses.includes('none');
          if (named.length && none) {
            return sql`(${schema.orders.deliveryStatus} IN ${named} OR ${schema.orders.deliveryStatus} IS NULL)`;
          }
          if (named.length) return inArray(schema.orders.deliveryStatus, named);
          return isNull(schema.orders.deliveryStatus);
        })()
      : undefined;
    const rows = await this.db
      .select({
        lineId: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        locationId: location,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
        allocated,
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        customerName: sql<
          string | null
        >`NULLIF(TRIM(CONCAT(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        lineDeliveryDate: schema.orderLines.deliveryDate,
        requestedDate: schema.orders.requestedDate,
        deliveryStatus: schema.orders.deliveryStatus,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          sql`${schema.orderLines.variantId} IS NOT NULL`,
          inArray(schema.orders.status, [...OPEN_ORDER_STATUSES]),
          sql`${schema.orderLines.quantity} - ${schema.orderLines.qtyFulfilled} - ${schema.orderLines.qtyReserved} > 0`,
          p.locationId ? sql`${location} = ${p.locationId}` : undefined,
          statusFilter,
        ),
      )
      .orderBy(asc(schema.orders.createdAt), asc(schema.orderLines.createdAt));
    return rows
      .map((r) => ({
        lineId: r.lineId,
        variantId: r.variantId!,
        locationId: r.locationId,
        quantity: r.quantity,
        shortfall: r.quantity - r.qtyFulfilled - r.qtyReserved - r.allocated,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        customerName: r.customerName,
        fillBy: r.lineDeliveryDate ?? r.requestedDate ?? null,
        deliveryStatus: r.deliveryStatus,
      }))
      .filter((r) => r.shortfall > 0);
  }

  private async loadMeta(
    businessId: string,
    variantIds: string[],
  ): Promise<Map<string, VariantMeta>> {
    const rows = await this.db
      .select({
        variantId: schema.productVariants.id,
        productId: schema.products.id,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        vendorSku: schema.productVariants.vendorSku,
        costCents: schema.productVariants.costCents,
        categoryId: schema.products.categoryId,
        categoryName: schema.categories.name,
        collectionId: schema.products.collectionId,
        collectionName: schema.collections.name,
        collectionVendorId: schema.collections.vendorId,
        brandName: schema.brands.name,
        preferredVendorId: schema.productVariants.preferredVendorId,
        purchaseCartonQty: schema.products.purchaseCartonQty,
        reorderPoint: schema.productVariants.reorderPoint,
        reorderQty: schema.productVariants.reorderQty,
        variantActive: schema.productVariants.isActive,
        productActive: schema.products.isActive,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
      .leftJoin(schema.collections, eq(schema.collections.id, schema.products.collectionId))
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .where(
        and(
          eq(schema.productVariants.businessId, businessId),
          inArray(schema.productVariants.id, variantIds),
        ),
      );
    return new Map(rows.map((r) => [r.variantId, r]));
  }

  /** Preferred vendor → collection vendor → vendor named like the brand. */
  private async vendorResolver(
    businessId: string,
  ): Promise<(m: VariantMeta) => { vendorId: string | null; vendorName: string | null }> {
    const vendors = await this.db
      .select({ id: schema.vendors.id, name: schema.vendors.name })
      .from(schema.vendors)
      .where(and(eq(schema.vendors.businessId, businessId), eq(schema.vendors.isActive, true)));
    const byId = new Map(vendors.map((v) => [v.id, v.name]));
    const byName = new Map(vendors.map((v) => [v.name.trim().toLowerCase(), v.id]));
    return (m) => {
      const id =
        (m.preferredVendorId && byId.has(m.preferredVendorId) ? m.preferredVendorId : null) ??
        (m.collectionVendorId && byId.has(m.collectionVendorId) ? m.collectionVendorId : null) ??
        (m.brandName ? (byName.get(m.brandName.trim().toLowerCase()) ?? null) : null);
      return { vendorId: id, vendorName: id ? (byId.get(id) ?? null) : null };
    };
  }

  /**
   * Stock per (variant, location) — or per variant across locations when
   * `sumAcross` — with pending as-is pieces and the net open PO supply
   * (ordered − accepted − rejected − allocated to sales orders; direct
   * ship never raises stock).
   */
  private async loadCells(
    variantIds: string[],
    locationId: string | null,
    sumAcross: boolean,
  ): Promise<Map<string, StockCell>> {
    const key = (variantId: string, loc: string | null) =>
      cellKey(variantId, sumAcross ? null : loc);
    const cells = new Map<string, StockCell>();
    const cell = (variantId: string, loc: string | null) => {
      const k = key(variantId, loc);
      const c = cells.get(k) ?? { ...EMPTY_CELL };
      cells.set(k, c);
      return c;
    };
    const levels = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        locationId: schema.inventoryLevels.locationId,
        onHand: schema.inventoryLevels.onHand,
        reserved: schema.inventoryLevels.reserved,
        floorSample: schema.inventoryLevels.floorSample,
      })
      .from(schema.inventoryLevels)
      .where(
        and(
          inArray(schema.inventoryLevels.variantId, variantIds),
          locationId ? eq(schema.inventoryLevels.locationId, locationId) : undefined,
        ),
      );
    for (const l of levels) {
      const c = cell(l.variantId, l.locationId);
      c.onHand += l.onHand;
      c.reserved += l.reserved;
      c.floorSample += l.floorSample;
    }
    const asIs = await this.db
      .select({
        variantId: schema.asIsItems.variantId,
        locationId: schema.asIsItems.locationId,
        qty: sql<number>`SUM(${schema.asIsItems.quantity})::int`,
      })
      .from(schema.asIsItems)
      .where(
        and(
          inArray(schema.asIsItems.variantId, variantIds),
          eq(schema.asIsItems.status, 'pending_review'),
          locationId ? eq(schema.asIsItems.locationId, locationId) : undefined,
        ),
      )
      .groupBy(schema.asIsItems.variantId, schema.asIsItems.locationId);
    for (const a of asIs) cell(a.variantId, a.locationId).asIsPending += a.qty;
    const allocated = sql<number>`COALESCE((SELECT SUM(${schema.poLineAllocations.quantity}) FROM ${schema.poLineAllocations} WHERE ${schema.poLineAllocations.poLineId} = ${schema.purchaseOrderLines.id} AND ${schema.poLineAllocations.status} = 'ordered'), 0)::int`;
    const pos = await this.db
      .select({
        variantId: schema.purchaseOrderLines.variantId,
        locationId: schema.purchaseOrders.locationId,
        open: sql<number>`(${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected})::int`,
        allocated,
      })
      .from(schema.purchaseOrderLines)
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
      )
      .where(
        and(
          inArray(schema.purchaseOrderLines.variantId, variantIds),
          inArray(schema.purchaseOrders.status, [...OPEN_PO_STATUSES]),
          isNull(schema.purchaseOrders.deletedAt),
          eq(schema.purchaseOrders.directShip, false),
          locationId ? eq(schema.purchaseOrders.locationId, locationId) : undefined,
        ),
      );
    for (const l of pos) {
      cell(l.variantId, l.locationId).netOnPo += Math.max(0, l.open - l.allocated);
    }
    return cells;
  }

  // ─── PO writer ────────────────────────────────────────────────────────

  private async writePurchaseOrder(
    businessId: string,
    actor: CurrentUserPayload,
    args: {
      vendorId: string;
      vendorName: string | null;
      locationId: string;
      lines: ReplenishLine[];
      mode: ReplenishMode;
      place: boolean;
      notes: string | null;
    },
  ): Promise<{
    vendorId: string;
    vendorName: string | null;
    locationId: string;
    poId: string;
    number: string;
    status: string;
    lineCount: number;
    totalQty: number;
  } | null> {
    // Advanced Vendor Settings → PO Cutting Date: drop the lines past it
    // and say so on the PO, like the sales-rate builder does.
    const cut = await pastCuttingDate(
      this.db,
      args.vendorId,
      args.lines.map((l) => l.variantId),
      todayIso(),
    );
    const cutIds = new Set(cut.map((c) => c.variantId));
    const lines = args.lines.filter((l) => !cutIds.has(l.variantId));
    if (lines.length === 0) return null;

    const [vendor] = await this.db
      .select({ replenishmentJson: schema.vendors.replenishmentJson })
      .from(schema.vendors)
      .where(eq(schema.vendors.id, args.vendorId))
      .limit(1);
    const leadDays = parseVendorReplenishment(vendor?.replenishmentJson)?.leadDays ?? null;
    const expectedAt = leadDays != null ? new Date(Date.now() + leadDays * 86_400_000) : null;
    const subtotalCents = lines.reduce((s, l) => s + l.totalQty * (l.costCents ?? 0), 0);
    const freightCents = defaultFreightCents(
      await loadLandedCost(this.db, args.vendorId),
      subtotalCents,
    );
    const number = await generatePoNumber(this.db, businessId);
    const modeLabel = args.mode === 'allocated_order' ? 'allocated orders' : 'stock levels';
    const [po] = await this.db
      .insert(schema.purchaseOrders)
      .values({
        businessId,
        vendorId: args.vendorId,
        locationId: args.locationId,
        number,
        status: args.place ? 'ordered' : 'draft',
        placedAt: args.place ? new Date() : null,
        expectedAt,
        subtotalCents,
        freightCents,
        notes:
          args.notes ??
          `Replenish inventory — ${modeLabel}${cut.length ? ` — ${cuttingDateMessage(cut)}` : ''}`,
        createdByUserId: actor.id,
      })
      .returning({ id: schema.purchaseOrders.id, status: schema.purchaseOrders.status });
    if (!po) throw new BadRequestException('failed to create purchase order');

    let totalQty = 0;
    for (const l of lines) {
      const [poLine] = await this.db
        .insert(schema.purchaseOrderLines)
        .values({
          businessId,
          purchaseOrderId: po.id,
          variantId: l.variantId,
          quantityOrdered: l.totalQty,
          unitCostCents: l.costCents ?? 0,
          lineTotalCents: l.totalQty * (l.costCents ?? 0),
        })
        .returning({ id: schema.purchaseOrderLines.id });
      totalQty += l.totalQty;
      // Allocated orders: the special-order link, earliest fill-by first,
      // so receiving commits the units to the customers waiting.
      let remaining = l.totalQty;
      for (const o of l.orders) {
        if (remaining <= 0) break;
        const qty = Math.min(remaining, o.shortfall);
        if (qty <= 0) continue;
        await this.db.insert(schema.poLineAllocations).values({
          businessId,
          poLineId: poLine!.id,
          orderLineId: o.lineId,
          quantity: qty,
          status: 'ordered',
        });
        remaining -= qty;
      }
    }
    await this.audit.log({
      action: 'purchase_order.create',
      targetType: 'purchase_order',
      targetId: po.id,
      after: {
        number,
        vendorId: args.vendorId,
        status: po.status,
        subtotalCents,
        lineCount: lines.length,
        trigger: `replenish_${args.mode}`,
      },
    });
    return {
      vendorId: args.vendorId,
      vendorName: args.vendorName,
      locationId: args.locationId,
      poId: po.id,
      number,
      status: po.status,
      lineCount: lines.length,
      totalQty,
    };
  }
}
