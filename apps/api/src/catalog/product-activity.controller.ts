import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { parseLandedCost } from '../purchasing/vendor-settings';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import {
  AS_IS_NON_SELLABLE_CONDITIONS,
  EMPTY_TOTALS,
  OPEN_ORDER_STATUSES,
  OPEN_PO_STATUSES,
  loadProductStockByLocation,
  loadProductStockTotals,
  type StockTotals,
} from './product-stock';

/**
 * A21 (PLAN-POS-OPERATIONS §12.17): the STORIS "View Product Activity"
 * tabs, one read per section. Every read scopes to the product's
 * variants and — where STORIS has a Location picker — to one store when
 * `locationId` is given. Nothing here writes; cost and profit figures
 * come back null without `products.cost.view`.
 */

type Db = PostgresJsDatabase;

interface ProductVariantRef {
  id: string;
  sku: string | null;
  name: string | null;
  isActive: boolean;
  priceCents: number;
  costCents: number | null;
  preferredVendorId: string | null;
  capacityUnits: number;
}

interface ProductRef {
  id: string;
  sku: string | null;
  name: string;
  serialTracked: boolean;
  variants: ProductVariantRef[];
  variantIds: string[];
  primary: ProductVariantRef | undefined;
}

/** Locations every section labels rows with (active or not). */
type LocationName = { id: string; name: string; isActive: boolean };

export interface AtpResult {
  desiredQuantity: number;
  /** Today's date (UTC) the ATP date compares against. */
  asOf: string;
  total: { atpQuantity: number; atpDate: string | null };
  byLocation: {
    locationId: string;
    locationName: string;
    atpQuantity: number;
    atpDate: string | null;
  }[];
}

export interface ActivityPurchaseOrderRow {
  purchaseOrderId: string;
  number: string;
  vendorId: string;
  vendorName: string | null;
  receivingLocationId: string;
  receivingLocationName: string | null;
  sku: string | null;
  quantityOrdered: number;
  quantityDue: number;
  placedAt: string | null;
  expectedAt: string | null;
  createdAt: string;
  status: string;
  transactionType: 'merchandise' | 'direct_ship';
}

export interface ActivityOpenOrderRow {
  orderId: string;
  orderNumber: string;
  orderType: 'sales_order' | 'layaway' | 'exchange' | 'quote';
  sellingLocationId: string;
  sellingLocationName: string | null;
  fulfillmentDate: string | null;
  orderQuantity: number;
  reservedQuantity: number;
  fulfillmentType: string;
  fulfillmentStatus: string | null;
  shipFromLocationId: string | null;
  shipFromLocationName: string | null;
  orderDate: string;
  customerId: string | null;
  customerName: string | null;
  lineId: string;
  lineDescription: string;
  lineType: string;
}

export interface SalesHistoryPeriod {
  /** `YYYY-MM`. */
  period: string;
  label: string;
  salesCents: number;
  costCents: number | null;
  profitPercent: number | null;
  shipped: number;
  returned: number;
  net: number;
}

export interface ActivityTransferRow {
  transferId: string;
  number: string;
  status: string;
  transferType: string;
  fromLocationId: string;
  fromLocationName: string | null;
  toLocationId: string;
  toLocationName: string | null;
  transferDate: string;
  quantity: number;
  reservedQuantity: number;
  orderId: string | null;
  orderNumber: string | null;
  scheduledFor: string | null;
  customerName: string | null;
}

export interface ActivitySerialRow {
  id: string;
  serial: string;
  sku: string | null;
  locationId: string;
  locationName: string | null;
  receivedAt: string;
  status: string;
  storageBinCode: string | null;
  orderId: string | null;
  orderNumber: string | null;
  customerName: string | null;
  specialOrder: string | null;
}

export interface ActivityAsIsRow {
  id: string;
  pieceNumber: string | null;
  sku: string | null;
  locationId: string;
  locationName: string | null;
  quantity: number;
  receivedAt: string;
  status: string;
  condition: string | null;
  sellable: boolean;
  reasonCode: { code: string; description: string } | null;
  asIsPriceCents: number | null;
  storageLocation: string | null;
  source: string;
  notes: string | null;
}

export interface ActivitySummary {
  locationId: string | null;
  monthStart: string;
  strip: StockTotals;
  beginningBalance: number;
  beginningAsIsBalance: number;
  regular: {
    received: number;
    adjustments: number;
    transferredIn: number;
    transferredOut: number;
    sales: number;
  };
  asIs: {
    transferredIn: number;
    transferredOut: number;
    added: number;
    removed: number;
  };
}

export interface ActivityGeneral {
  capacityUnits: number | null;
  cost: {
    /** Quantity-weighted average of the remaining FIFO layers. */
    averageCents: number | null;
    /** Catalog cost — what a new PO line defaults to. */
    poReplacementCents: number | null;
    averageLandedCents: number | null;
    freightPerUnitCents: number | null;
    freightPercent: number | null;
    layerUnits: number;
    vendorName: string | null;
  };
}

const RECEIVED_REASONS = ['receive', 'receive_po', 'unreceive_po'];
const ADJUSTMENT_REASONS = [
  'adjustment',
  'physical_count',
  'physical_variance',
  'physical_commitment',
  'import',
  'as_is_restock',
];
const SALE_REASONS = ['sale', 'order_fulfill'];
const OPEN_TRANSFER_STATUSES = ['draft', 'in_transit'];
const LIVE_DELIVERY_STATUSES = ['scheduled', 'loaded', 'out_for_delivery'];
const SALE_STATUSES = ['completed', 'partially_refunded', 'refunded'];
const HISTORY_MONTHS = 14;

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

function customerName(first: string | null, last: string | null): string | null {
  const s = [first, last].filter(Boolean).join(' ').trim();
  return s || null;
}

function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function clampQuantity(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) {
    throw new BadRequestException('quantity must be a whole number from 1 to 100000');
  }
  return n;
}

@Controller('v1/products/:id/activity')
@TenantScoped()
export class ProductActivityController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ---------------------------------------------------------------- shared

  private async loadProduct(tenant: RequestTenantContext, id: string): Promise<ProductRef> {
    const [p] = await this.db
      .select({
        id: schema.products.id,
        sku: schema.products.sku,
        name: schema.products.name,
        serialTracked: schema.products.serialTracked,
      })
      .from(schema.products)
      .where(and(eq(schema.products.businessId, tenant.businessId!), eq(schema.products.id, id)))
      .limit(1);
    if (!p) throw new NotFoundException('Product not found');
    const variants = await this.db
      .select({
        id: schema.productVariants.id,
        sku: schema.productVariants.sku,
        name: schema.productVariants.name,
        isActive: schema.productVariants.isActive,
        priceCents: schema.productVariants.priceCents,
        costCents: schema.productVariants.costCents,
        preferredVendorId: schema.productVariants.preferredVendorId,
        capacityUnits: schema.productVariants.capacityUnits,
      })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.productId, id))
      .orderBy(asc(schema.productVariants.createdAt));
    const primary =
      variants.find((v) => v.sku && v.sku === p.sku) ??
      variants.find((v) => v.isActive) ??
      variants[0];
    return {
      ...p,
      variants,
      variantIds: variants.map((v) => v.id),
      primary,
    };
  }

  private async locations(businessId: string): Promise<Map<string, LocationName>> {
    const rows = await this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        isActive: schema.locations.isActive,
      })
      .from(schema.locations)
      .where(eq(schema.locations.businessId, businessId))
      .orderBy(asc(schema.locations.name));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** The STORIS header strip: the product's totals, for one store or all. */
  private async strip(
    businessId: string,
    productId: string,
    locationId?: string,
  ): Promise<StockTotals> {
    const totals = await loadProductStockTotals(this.db, businessId, [productId], locationId);
    return totals.get(productId) ?? { ...EMPTY_TOTALS };
  }

  private canSeeCost(tenant: RequestTenantContext): boolean {
    return tenant.isSuperAdmin || tenant.permissions.has('products.cost.view');
  }

  private async assertLocation(businessId: string, locationId?: string): Promise<void> {
    if (!locationId) return;
    const [l] = await this.db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.id, locationId)))
      .limit(1);
    if (!l) throw new BadRequestException('Unknown locationId');
  }

  // ------------------------------------------------------------------- ATP

  /**
   * Available to Promise (D2): how many can be promised now, and when the
   * desired quantity could be — today when net available covers it, else
   * the expected date of the open PO whose cumulative undelivered units
   * cover the shortfall. No projection of open orders' promise dates.
   */
  @Get('atp')
  @RequirePermission('products.view')
  async atp(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query('quantity') quantityStr?: string,
  ): Promise<AtpResult> {
    const product = await this.loadProduct(tenant, id);
    const desired = clampQuantity(quantityStr);
    const { totals, byLocation } = await loadProductStockByLocation(
      this.db,
      tenant.businessId!,
      product.id,
    );
    const inbound = product.variantIds.length
      ? await this.db
          .select({
            locationId: schema.purchaseOrders.locationId,
            expectedAt: schema.purchaseOrders.expectedAt,
            due: sql<number>`sum(greatest(0, ${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected}))::int`,
          })
          .from(schema.purchaseOrderLines)
          .innerJoin(
            schema.purchaseOrders,
            eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
          )
          .where(
            and(
              eq(schema.purchaseOrders.businessId, tenant.businessId!),
              inArray(schema.purchaseOrderLines.variantId, product.variantIds),
              inArray(schema.purchaseOrders.status, [...OPEN_PO_STATUSES]),
              isNull(schema.purchaseOrders.deletedAt),
              eq(schema.purchaseOrders.directShip, false),
              sql`${schema.purchaseOrders.expectedAt} IS NOT NULL`,
            ),
          )
          .groupBy(schema.purchaseOrders.locationId, schema.purchaseOrders.expectedAt)
          .orderBy(asc(schema.purchaseOrders.expectedAt))
      : [];
    const today = new Date().toISOString().slice(0, 10);
    const dateFor = (available: number, pos: { expectedAt: Date | null; due: number }[]) => {
      if (available >= desired) return today;
      let cum = available;
      for (const po of pos) {
        cum += po.due;
        if (cum >= desired && po.expectedAt) return po.expectedAt.toISOString().slice(0, 10);
      }
      return null;
    };
    // Per location: sum the variant rows, then walk that store's inbound.
    const perLocation = new Map<string, { name: string; available: number }>();
    for (const r of byLocation) {
      const cur = perLocation.get(r.locationId) ?? { name: r.locationName, available: 0 };
      cur.available += r.available;
      perLocation.set(r.locationId, cur);
    }
    const result: AtpResult = {
      desiredQuantity: desired,
      asOf: today,
      total: { atpQuantity: totals.available, atpDate: dateFor(totals.available, inbound) },
      byLocation: [...perLocation.entries()].map(([locationId, l]) => ({
        locationId,
        locationName: l.name,
        atpQuantity: l.available,
        atpDate: dateFor(
          l.available,
          inbound.filter((po) => po.locationId === locationId),
        ),
      })),
    };
    return result;
  }

  // --------------------------------------------------------- purchase orders

  /** D7: draft and placed POs with units still due, direct ship included. */
  @Get('purchase-orders')
  @RequirePermission('products.view')
  async purchaseOrders(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ strip: StockTotals; rows: ActivityPurchaseOrderRow[] }> {
    const product = await this.loadProduct(tenant, id);
    const strip = await this.strip(tenant.businessId!, product.id);
    if (product.variantIds.length === 0) return { strip, rows: [] };
    const rows = await this.db
      .select({
        purchaseOrderId: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        vendorId: schema.purchaseOrders.vendorId,
        vendorName: schema.vendors.name,
        receivingLocationId: schema.purchaseOrders.locationId,
        receivingLocationName: schema.locations.name,
        sku: schema.productVariants.sku,
        quantityOrdered: schema.purchaseOrderLines.quantityOrdered,
        quantityDue: sql<number>`greatest(0, ${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected})::int`,
        placedAt: schema.purchaseOrders.placedAt,
        expectedAt: schema.purchaseOrders.expectedAt,
        createdAt: schema.purchaseOrders.createdAt,
        status: schema.purchaseOrders.status,
        directShip: schema.purchaseOrders.directShip,
      })
      .from(schema.purchaseOrderLines)
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
      )
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.purchaseOrderLines.variantId),
      )
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.purchaseOrders.locationId))
      .where(
        and(
          eq(schema.purchaseOrders.businessId, tenant.businessId!),
          inArray(schema.purchaseOrderLines.variantId, product.variantIds),
          inArray(schema.purchaseOrders.status, ['draft', ...OPEN_PO_STATUSES]),
          isNull(schema.purchaseOrders.deletedAt),
          sql`(${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected}) > 0`,
        ),
      )
      .orderBy(
        sql`${schema.purchaseOrders.expectedAt} ASC NULLS LAST`,
        asc(schema.purchaseOrders.createdAt),
      );
    return {
      strip,
      rows: rows.map((r) => ({
        purchaseOrderId: r.purchaseOrderId,
        number: r.number,
        vendorId: r.vendorId,
        vendorName: r.vendorName ?? null,
        receivingLocationId: r.receivingLocationId,
        receivingLocationName: r.receivingLocationName ?? null,
        sku: r.sku ?? null,
        quantityOrdered: r.quantityOrdered,
        quantityDue: r.quantityDue,
        placedAt: iso(r.placedAt),
        expectedAt: iso(r.expectedAt),
        createdAt: r.createdAt.toISOString(),
        status: r.status,
        transactionType: r.directShip ? 'direct_ship' : 'merchandise',
      })),
    };
  }

  // ------------------------------------------------------------ open orders

  /**
   * D6: lines of the product on open orders with units not yet fulfilled.
   * `locationId` matches the ship-from (`useFulfillment=1`, default) and /
   * or the selling store (`useSelling=1`, default); `orderType` narrows to
   * sales orders, layaways, exchanges or quotes (STORIS Open Shopping
   * Carts) — quotes only appear when asked for.
   */
  @Get('open-orders')
  @RequirePermission('products.view')
  async openOrders(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query('locationId') locationId?: string,
    @Query('useFulfillment') useFulfillmentStr?: string,
    @Query('useSelling') useSellingStr?: string,
    @Query('orderType') orderTypeRaw?: string,
  ): Promise<{ strip: StockTotals; rows: ActivityOpenOrderRow[] }> {
    const product = await this.loadProduct(tenant, id);
    await this.assertLocation(tenant.businessId!, locationId);
    const strip = await this.strip(tenant.businessId!, product.id, locationId);
    if (product.variantIds.length === 0) return { strip, rows: [] };
    const orderType = orderTypeRaw && orderTypeRaw !== 'all' ? orderTypeRaw : null;
    if (orderType && !['sales_order', 'layaway', 'exchange', 'quote'].includes(orderType)) {
      throw new BadRequestException(
        'orderType must be one of all, sales_order, layaway, exchange, quote',
      );
    }
    const useFulfillment = useFulfillmentStr === undefined || useFulfillmentStr === '1';
    const useSelling = useSellingStr === undefined || useSellingStr === '1';
    const shipFrom = sql<string>`coalesce(${schema.orderLines.sourceLocationId}, ${schema.orders.stockLocationId}, ${schema.orders.locationId})`;
    const statuses = orderType === 'quote' ? ['quote'] : [...OPEN_ORDER_STATUSES];
    const conditions = [
      eq(schema.orders.businessId, tenant.businessId!),
      inArray(schema.orderLines.variantId, product.variantIds),
      inArray(schema.orders.status, statuses),
      sql`(${schema.orderLines.quantity} - ${schema.orderLines.qtyFulfilled}) > 0`,
    ];
    if (orderType === 'layaway') conditions.push(eq(schema.orders.orderKind, 'layaway'));
    if (orderType === 'exchange') {
      conditions.push(sql`${schema.orders.originalOrderId} IS NOT NULL`);
    }
    if (orderType === 'sales_order') {
      conditions.push(
        eq(schema.orders.orderKind, 'sales_order'),
        sql`${schema.orders.originalOrderId} IS NULL`,
      );
    }
    if (locationId) {
      if (!useFulfillment && !useSelling) {
        throw new BadRequestException(
          'Pick the fulfillment location, the selling location, or both',
        );
      }
      const parts = [
        useFulfillment ? sql`${shipFrom} = ${locationId}` : null,
        useSelling ? sql`${schema.orders.locationId} = ${locationId}` : null,
      ].filter((x): x is ReturnType<typeof sql> => x !== null);
      conditions.push(
        parts.length === 2
          ? sql`(${parts[0]} OR ${parts[1]})`
          : (parts[0] as ReturnType<typeof sql>),
      );
    }
    const rows = await this.db
      .select({
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        orderKind: schema.orders.orderKind,
        orderStatus: schema.orders.status,
        originalOrderId: schema.orders.originalOrderId,
        sellingLocationId: schema.orders.locationId,
        requestedDate: schema.orders.requestedDate,
        orderFulfillmentType: schema.orders.fulfillmentType,
        deliveryStatus: schema.orders.deliveryStatus,
        orderDate: schema.orders.createdAt,
        customerId: schema.orders.customerId,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
        lineId: schema.orderLines.id,
        lineDescription: schema.orderLines.description,
        lineType: schema.orderLines.lineType,
        lineDeliveryDate: schema.orderLines.deliveryDate,
        lineFulfillmentMethod: schema.orderLines.fulfillmentMethod,
        quantity: schema.orderLines.quantity,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
        qtyReserved: schema.orderLines.qtyReserved,
        shipFromLocationId: shipFrom,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(and(...conditions))
      .orderBy(
        sql`coalesce(${schema.orderLines.deliveryDate}, ${schema.orders.requestedDate}) ASC NULLS LAST`,
        asc(schema.orders.createdAt),
      );
    if (rows.length === 0) return { strip, rows: [] };
    const names = await this.locations(tenant.businessId!);
    // Fulfillment status: the line's live delivery, else the order's
    // delivery status (will call reads CWC on the page).
    const lineIds = rows.map((r) => r.lineId);
    const deliveries = await this.db
      .select({
        orderLineId: schema.deliveryLines.orderLineId,
        status: schema.deliveries.status,
        scheduledDate: schema.deliveries.scheduledDate,
      })
      .from(schema.deliveryLines)
      .innerJoin(schema.deliveries, eq(schema.deliveries.id, schema.deliveryLines.deliveryId))
      .where(
        and(
          inArray(schema.deliveryLines.orderLineId, lineIds),
          inArray(schema.deliveries.status, LIVE_DELIVERY_STATUSES),
        ),
      )
      .orderBy(asc(schema.deliveries.scheduledDate));
    const deliveryFor = new Map<string, { status: string; scheduledDate: string }>();
    for (const d of deliveries) {
      if (!deliveryFor.has(d.orderLineId)) {
        deliveryFor.set(d.orderLineId, { status: d.status, scheduledDate: d.scheduledDate });
      }
    }
    return {
      strip,
      rows: rows.map((r) => {
        const delivery = deliveryFor.get(r.lineId);
        const orderType: ActivityOpenOrderRow['orderType'] =
          r.orderStatus === 'quote'
            ? 'quote'
            : r.originalOrderId
              ? 'exchange'
              : r.orderKind === 'layaway'
                ? 'layaway'
                : 'sales_order';
        return {
          orderId: r.orderId,
          orderNumber: r.orderNumber,
          orderType,
          sellingLocationId: r.sellingLocationId,
          sellingLocationName: names.get(r.sellingLocationId)?.name ?? null,
          fulfillmentDate: delivery?.scheduledDate ?? r.lineDeliveryDate ?? r.requestedDate ?? null,
          orderQuantity: r.quantity - r.qtyFulfilled,
          reservedQuantity: r.qtyReserved,
          fulfillmentType: r.lineFulfillmentMethod ?? r.orderFulfillmentType,
          fulfillmentStatus: delivery?.status ?? r.deliveryStatus ?? null,
          shipFromLocationId: r.shipFromLocationId ?? null,
          shipFromLocationName: r.shipFromLocationId
            ? (names.get(r.shipFromLocationId)?.name ?? null)
            : null,
          orderDate: r.orderDate.toISOString(),
          customerId: r.customerId ?? null,
          customerName: customerName(r.first ?? null, r.last ?? null),
          lineId: r.lineId,
          lineDescription: r.lineDescription,
          lineType: r.lineType,
        };
      }),
    };
  }

  // ---------------------------------------------------------- sales history

  /**
   * D5: fourteen monthly periods (this month and the thirteen before it,
   * newest first) of register sales + completed orders, with returns.
   * Cost = catalog cost × quantity; null without cost access.
   */
  @Get('sales-history')
  @RequirePermission('products.view')
  async salesHistory(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query('locationId') locationId?: string,
  ): Promise<{ strip: StockTotals; periods: SalesHistoryPeriod[] }> {
    const product = await this.loadProduct(tenant, id);
    await this.assertLocation(tenant.businessId!, locationId);
    const strip = await this.strip(tenant.businessId!, product.id, locationId);
    const canSeeCost = this.canSeeCost(tenant);
    const now = new Date();
    const first = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1),
    );
    const buckets = new Map<string, SalesHistoryPeriod>();
    for (let i = 0; i < HISTORY_MONTHS; i++) {
      const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
      const key = d.toISOString().slice(0, 7);
      buckets.set(key, {
        period: key,
        label: MONTH_LABEL.format(d),
        salesCents: 0,
        costCents: canSeeCost ? 0 : null,
        profitPercent: null,
        shipped: 0,
        returned: 0,
        net: 0,
      });
    }
    if (product.variantIds.length === 0) {
      return { strip, periods: [...buckets.values()].reverse() };
    }
    const ids = product.variantIds;
    const biz = tenant.businessId!;
    const period = (col: unknown) => sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM')`;

    const [registerSales, orderSales, registerRefunds, orderReturns] = await Promise.all([
      this.db
        .select({
          period: period(schema.sales.completedAt),
          quantity: sql<number>`coalesce(sum(${schema.saleLines.quantity}), 0)::int`,
          cents: sql<number>`coalesce(sum(${schema.saleLines.totalCents} - ${schema.saleLines.taxCents}), 0)::int`,
          costCents: sql<number>`coalesce(sum(${schema.saleLines.quantity} * coalesce(${schema.productVariants.costCents}, 0)), 0)::int`,
        })
        .from(schema.saleLines)
        .innerJoin(schema.sales, eq(schema.sales.id, schema.saleLines.saleId))
        .innerJoin(
          schema.productVariants,
          eq(schema.productVariants.id, schema.saleLines.variantId),
        )
        .where(
          and(
            eq(schema.sales.businessId, biz),
            inArray(schema.saleLines.variantId, ids),
            inArray(schema.sales.status, SALE_STATUSES),
            gte(schema.sales.completedAt, first),
            locationId ? eq(schema.sales.locationId, locationId) : undefined,
          ),
        )
        .groupBy(period(schema.sales.completedAt)),
      this.db
        .select({
          period: period(schema.orders.completedAt),
          quantity: sql<number>`coalesce(sum(${schema.orderLines.quantity}), 0)::int`,
          cents: sql<number>`coalesce(sum(${schema.orderLines.totalCents} - ${schema.orderLines.taxCents}), 0)::int`,
          costCents: sql<number>`coalesce(sum(${schema.orderLines.quantity} * coalesce(${schema.productVariants.costCents}, 0)), 0)::int`,
        })
        .from(schema.orderLines)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
        .innerJoin(
          schema.productVariants,
          eq(schema.productVariants.id, schema.orderLines.variantId),
        )
        .where(
          and(
            eq(schema.orders.businessId, biz),
            inArray(schema.orderLines.variantId, ids),
            eq(schema.orders.status, 'completed'),
            gte(schema.orders.completedAt, first),
            locationId ? eq(schema.orders.locationId, locationId) : undefined,
          ),
        )
        .groupBy(period(schema.orders.completedAt)),
      this.db
        .select({
          period: period(schema.refunds.createdAt),
          quantity: sql<number>`coalesce(sum(${schema.refundLines.quantity}), 0)::int`,
        })
        .from(schema.refundLines)
        .innerJoin(schema.refunds, eq(schema.refunds.id, schema.refundLines.refundId))
        .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
        .where(
          and(
            eq(schema.sales.businessId, biz),
            inArray(schema.refundLines.variantId, ids),
            gte(schema.refunds.createdAt, first),
            locationId ? eq(schema.sales.locationId, locationId) : undefined,
          ),
        )
        .groupBy(period(schema.refunds.createdAt)),
      this.db
        .select({
          period: period(schema.orderReturns.completedAt),
          quantity: sql<number>`coalesce(sum(${schema.orderReturnLines.quantity}), 0)::int`,
        })
        .from(schema.orderReturnLines)
        .innerJoin(
          schema.orderReturns,
          eq(schema.orderReturns.id, schema.orderReturnLines.returnId),
        )
        .leftJoin(schema.orders, eq(schema.orders.id, schema.orderReturns.orderId))
        .where(
          and(
            eq(schema.orderReturns.businessId, biz),
            inArray(schema.orderReturnLines.variantId, ids),
            sql`${schema.orderReturns.completedAt} IS NOT NULL`,
            gte(schema.orderReturns.completedAt, first),
            locationId ? eq(schema.orders.locationId, locationId) : undefined,
          ),
        )
        .groupBy(period(schema.orderReturns.completedAt)),
    ]);
    for (const r of [...registerSales, ...orderSales]) {
      const b = buckets.get(r.period);
      if (!b) continue;
      b.shipped += r.quantity;
      b.salesCents += r.cents;
      if (b.costCents !== null) b.costCents += r.costCents;
    }
    for (const r of [...registerRefunds, ...orderReturns]) {
      const b = buckets.get(r.period);
      if (b) b.returned += r.quantity;
    }
    for (const b of buckets.values()) {
      b.net = b.shipped - b.returned;
      b.profitPercent =
        b.costCents !== null && b.salesCents > 0
          ? Math.round(((b.salesCents - b.costCents) / b.salesCents) * 10000) / 100
          : null;
    }
    return { strip, periods: [...buckets.values()].reverse() };
  }

  // -------------------------------------------------------------- transfers

  /** D8: open transfers (draft, in transit) into or out of a location. */
  @Get('transfers')
  @RequirePermission('products.view')
  async transfers(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query('direction') directionRaw?: string,
    @Query('locationId') locationId?: string,
  ): Promise<{ strip: StockTotals; quantity: number; rows: ActivityTransferRow[] }> {
    const direction = directionRaw === 'out' ? 'out' : directionRaw === 'in' ? 'in' : null;
    if (!direction) throw new BadRequestException('direction must be in or out');
    const product = await this.loadProduct(tenant, id);
    await this.assertLocation(tenant.businessId!, locationId);
    const strip = await this.strip(tenant.businessId!, product.id, locationId);
    if (product.variantIds.length === 0) return { strip, quantity: 0, rows: [] };
    const sideColumn =
      direction === 'in'
        ? schema.stockTransfers.toLocationId
        : schema.stockTransfers.fromLocationId;
    const rows = await this.db
      .select({
        transferId: schema.stockTransfers.id,
        number: schema.stockTransfers.number,
        status: schema.stockTransfers.status,
        transferType: schema.stockTransfers.transferType,
        fromLocationId: schema.stockTransfers.fromLocationId,
        toLocationId: schema.stockTransfers.toLocationId,
        shippedAt: schema.stockTransfers.shippedAt,
        createdAt: schema.stockTransfers.createdAt,
        scheduledFor: schema.stockTransfers.scheduledFor,
        orderId: schema.stockTransfers.orderId,
        orderNumber: schema.orders.number,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
        quantityShipped: schema.stockTransferLines.quantityShipped,
        quantityOrdered: schema.stockTransferLines.quantityOrdered,
      })
      .from(schema.stockTransferLines)
      .innerJoin(
        schema.stockTransfers,
        eq(schema.stockTransfers.id, schema.stockTransferLines.transferId),
      )
      .leftJoin(schema.orders, eq(schema.orders.id, schema.stockTransfers.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.stockTransfers.businessId, tenant.businessId!),
          inArray(schema.stockTransferLines.variantId, product.variantIds),
          inArray(schema.stockTransfers.status, OPEN_TRANSFER_STATUSES),
          locationId ? eq(sideColumn, locationId) : undefined,
        ),
      )
      .orderBy(
        sql`${schema.stockTransfers.scheduledFor} ASC NULLS LAST`,
        asc(schema.stockTransfers.createdAt),
      );
    const names = await this.locations(tenant.businessId!);
    const out = rows.map((r) => {
      const quantity = r.quantityShipped > 0 ? r.quantityShipped : (r.quantityOrdered ?? 0);
      return {
        transferId: r.transferId,
        number: r.number,
        status: r.status,
        transferType: r.transferType,
        fromLocationId: r.fromLocationId,
        fromLocationName: names.get(r.fromLocationId)?.name ?? null,
        toLocationId: r.toLocationId,
        toLocationName: names.get(r.toLocationId)?.name ?? null,
        transferDate: (r.shippedAt ?? r.createdAt).toISOString(),
        quantity,
        reservedQuantity: r.orderId ? quantity : 0,
        orderId: r.orderId ?? null,
        orderNumber: r.orderNumber ?? null,
        scheduledFor: r.scheduledFor ?? null,
        customerName: customerName(r.first ?? null, r.last ?? null),
      };
    });
    return { strip, quantity: out.reduce((n, r) => n + r.quantity, 0), rows: out };
  }

  // ------------------------------------------------------ general information

  /**
   * D9: the Cost Information block — FIFO average, catalog (PO
   * replacement) cost, and the preferred vendor's landed-cost lines
   * applied on top. Null across the board without cost access.
   */
  @Get('general')
  @RequirePermission('products.view')
  async general(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<ActivityGeneral> {
    const product = await this.loadProduct(tenant, id);
    const primary = product.primary;
    const empty: ActivityGeneral = {
      capacityUnits: primary?.capacityUnits ?? null,
      cost: {
        averageCents: null,
        poReplacementCents: null,
        averageLandedCents: null,
        freightPerUnitCents: null,
        freightPercent: null,
        layerUnits: 0,
        vendorName: null,
      },
    };
    if (!this.canSeeCost(tenant) || product.variantIds.length === 0) return empty;
    const [layers] = await this.db
      .select({
        units: sql<number>`coalesce(sum(${schema.costLayers.quantityRemaining}), 0)::int`,
        value: sql<number>`coalesce(sum(${schema.costLayers.quantityRemaining} * ${schema.costLayers.unitCostCents}), 0)::bigint`,
      })
      .from(schema.costLayers)
      .where(
        and(
          eq(schema.costLayers.businessId, tenant.businessId!),
          inArray(schema.costLayers.variantId, product.variantIds),
          sql`${schema.costLayers.quantityRemaining} > 0`,
        ),
      );
    const units = layers?.units ?? 0;
    const average = units > 0 ? Math.round(Number(layers!.value) / units) : null;
    const poReplacement = primary?.costCents ?? null;
    const basis = average ?? poReplacement;
    let vendorName: string | null = null;
    let landedAdd = 0;
    let freightPerUnit: number | null = null;
    let freightPercent: number | null = null;
    if (primary?.preferredVendorId) {
      const [vendor] = await this.db
        .select({ name: schema.vendors.name, landedCostJson: schema.vendors.landedCostJson })
        .from(schema.vendors)
        .where(eq(schema.vendors.id, primary.preferredVendorId))
        .limit(1);
      if (vendor) {
        vendorName = vendor.name;
        const landed = parseLandedCost(vendor.landedCostJson);
        const lines = [landed.freight, landed.importFee, landed.miscFee, ...landed.custom];
        for (const line of lines) {
          if (!line.active) continue;
          if (line.type === 'percent' && line.percent != null && basis != null) {
            landedAdd += Math.round((basis * line.percent) / 100);
          } else if (line.type === 'dollar' && line.cents != null) {
            landedAdd += line.cents;
          }
        }
        if (landed.freight.active) {
          if (landed.freight.type === 'percent' && landed.freight.percent != null) {
            freightPercent = landed.freight.percent;
            if (basis != null) freightPerUnit = Math.round((basis * landed.freight.percent) / 100);
          } else if (landed.freight.type === 'dollar' && landed.freight.cents != null) {
            freightPerUnit = landed.freight.cents;
            if (basis) freightPercent = Math.round((landed.freight.cents / basis) * 10000) / 100;
          }
        }
      }
    }
    return {
      capacityUnits: primary?.capacityUnits ?? null,
      cost: {
        averageCents: average,
        poReplacementCents: poReplacement,
        averageLandedCents: basis != null ? basis + landedAdd : null,
        freightPerUnitCents: freightPerUnit,
        freightPercent,
        layerUnits: units,
        vendorName,
      },
    };
  }

  // ---------------------------------------------------------------- serials

  /** D10: the product's serial units at a location, sold ones excluded. */
  @Get('serials')
  @RequirePermission('products.view')
  async serials(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query('locationId') locationId?: string,
  ): Promise<{ strip: StockTotals; serialTracked: boolean; rows: ActivitySerialRow[] }> {
    const product = await this.loadProduct(tenant, id);
    await this.assertLocation(tenant.businessId!, locationId);
    const strip = await this.strip(tenant.businessId!, product.id, locationId);
    if (product.variantIds.length === 0) {
      return { strip, serialTracked: product.serialTracked, rows: [] };
    }
    const rows = await this.db
      .select({
        id: schema.serialUnits.id,
        serial: schema.serialUnits.serial,
        sku: schema.productVariants.sku,
        variantId: schema.serialUnits.variantId,
        locationId: schema.serialUnits.locationId,
        createdAt: schema.serialUnits.createdAt,
        status: schema.serialUnits.status,
        orderLineId: schema.serialUnits.orderLineId,
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        lineType: schema.orderLines.lineType,
        lineDescription: schema.orderLines.description,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
      })
      .from(schema.serialUnits)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.serialUnits.variantId),
      )
      .leftJoin(schema.orderLines, eq(schema.orderLines.id, schema.serialUnits.orderLineId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.serialUnits.businessId, tenant.businessId!),
          inArray(schema.serialUnits.variantId, product.variantIds),
          ne(schema.serialUnits.status, 'sold'),
          locationId ? eq(schema.serialUnits.locationId, locationId) : undefined,
        ),
      )
      .orderBy(asc(schema.serialUnits.createdAt), asc(schema.serialUnits.serial));
    const names = await this.locations(tenant.businessId!);
    const bins = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        locationId: schema.inventoryLevels.locationId,
        code: schema.storageBins.code,
      })
      .from(schema.inventoryLevels)
      .innerJoin(schema.storageBins, eq(schema.storageBins.id, schema.inventoryLevels.storageBinId))
      .where(
        and(
          eq(schema.inventoryLevels.businessId, tenant.businessId!),
          inArray(schema.inventoryLevels.variantId, product.variantIds),
        ),
      );
    const binAt = new Map(bins.map((b) => [`${b.variantId}:${b.locationId}`, b.code]));
    return {
      strip,
      serialTracked: product.serialTracked,
      rows: rows.map((r) => ({
        id: r.id,
        serial: r.serial,
        sku: r.sku ?? null,
        locationId: r.locationId,
        locationName: names.get(r.locationId)?.name ?? null,
        receivedAt: r.createdAt.toISOString(),
        status: r.status,
        storageBinCode: binAt.get(`${r.variantId}:${r.locationId}`) ?? null,
        orderId: r.orderId ?? null,
        orderNumber: r.orderNumber ?? null,
        customerName: customerName(r.first ?? null, r.last ?? null),
        specialOrder: r.lineType === 'special_order' ? (r.lineDescription ?? null) : null,
      })),
    };
  }

  // ------------------------------------------------------------------ as-is

  /** D11: as-is pieces in review at a location. */
  @Get('as-is')
  @RequirePermission('products.view')
  async asIs(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query('locationId') locationId?: string,
  ): Promise<{ strip: StockTotals; rows: ActivityAsIsRow[] }> {
    const product = await this.loadProduct(tenant, id);
    await this.assertLocation(tenant.businessId!, locationId);
    const strip = await this.strip(tenant.businessId!, product.id, locationId);
    if (product.variantIds.length === 0) return { strip, rows: [] };
    const rows = await this.db
      .select({
        id: schema.asIsItems.id,
        pieceNumber: schema.asIsItems.pieceNumber,
        sku: schema.productVariants.sku,
        locationId: schema.asIsItems.locationId,
        quantity: schema.asIsItems.quantity,
        createdAt: schema.asIsItems.createdAt,
        status: schema.asIsItems.status,
        condition: schema.asIsItems.condition,
        reasonCode: schema.reasonCodes.code,
        reasonDescription: schema.reasonCodes.description,
        asIsPriceCents: schema.asIsItems.asIsPriceCents,
        storageLocation: schema.asIsItems.storageLocation,
        source: schema.asIsItems.source,
        notes: schema.asIsItems.notes,
      })
      .from(schema.asIsItems)
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.asIsItems.variantId))
      .leftJoin(schema.reasonCodes, eq(schema.reasonCodes.id, schema.asIsItems.reasonCodeId))
      .where(
        and(
          eq(schema.asIsItems.businessId, tenant.businessId!),
          inArray(schema.asIsItems.variantId, product.variantIds),
          eq(schema.asIsItems.status, 'pending_review'),
          locationId ? eq(schema.asIsItems.locationId, locationId) : undefined,
        ),
      )
      .orderBy(asc(schema.asIsItems.createdAt));
    const names = await this.locations(tenant.businessId!);
    const nonSellable = new Set<string>(AS_IS_NON_SELLABLE_CONDITIONS);
    return {
      strip,
      rows: rows.map((r) => ({
        id: r.id,
        pieceNumber: r.pieceNumber ?? null,
        sku: r.sku ?? null,
        locationId: r.locationId,
        locationName: names.get(r.locationId)?.name ?? null,
        quantity: r.quantity,
        receivedAt: r.createdAt.toISOString(),
        status: r.status,
        condition: r.condition ?? null,
        sellable: !(r.condition && nonSellable.has(r.condition)),
        reasonCode: r.reasonCode ? { code: r.reasonCode, description: r.reasonDescription! } : null,
        asIsPriceCents: r.asIsPriceCents ?? null,
        storageLocation: r.storageLocation ?? null,
        source: r.source,
        notes: r.notes ?? null,
      })),
    };
  }

  // ---------------------------------------------------------------- summary

  /**
   * D12: beginning-of-month balances from the movement ledger and the
   * month-to-date buckets STORIS shows, for one store or all.
   */
  @Get('summary')
  @RequirePermission('products.view')
  async summary(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query('locationId') locationId?: string,
  ): Promise<ActivitySummary> {
    const product = await this.loadProduct(tenant, id);
    await this.assertLocation(tenant.businessId!, locationId);
    const strip = await this.strip(tenant.businessId!, product.id, locationId);
    const monthStart = monthStartUtc();
    const out: ActivitySummary = {
      locationId: locationId ?? null,
      monthStart: monthStart.toISOString(),
      strip,
      beginningBalance: strip.onHand,
      beginningAsIsBalance: strip.asIsOnHand,
      regular: { received: 0, adjustments: 0, transferredIn: 0, transferredOut: 0, sales: 0 },
      asIs: { transferredIn: 0, transferredOut: 0, added: 0, removed: 0 },
    };
    if (product.variantIds.length === 0) return out;
    const biz = tenant.businessId!;
    const ids = product.variantIds;

    const movements = await this.db
      .select({
        reason: schema.inventoryMovements.reason,
        delta: sql<number>`coalesce(sum(${schema.inventoryMovements.delta}), 0)::int`,
      })
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.businessId, biz),
          inArray(schema.inventoryMovements.variantId, ids),
          gte(schema.inventoryMovements.createdAt, monthStart),
          locationId ? eq(schema.inventoryMovements.locationId, locationId) : undefined,
        ),
      )
      .groupBy(schema.inventoryMovements.reason);
    let monthDelta = 0;
    for (const m of movements) {
      monthDelta += m.delta;
      if (RECEIVED_REASONS.includes(m.reason)) out.regular.received += m.delta;
      else if (ADJUSTMENT_REASONS.includes(m.reason)) out.regular.adjustments += m.delta;
      else if (m.reason === 'transfer_in') out.regular.transferredIn += m.delta;
      else if (m.reason === 'transfer_out') out.regular.transferredOut -= m.delta;
      else if (SALE_REASONS.includes(m.reason)) out.regular.sales -= m.delta;
    }
    out.beginningBalance = strip.onHand - monthDelta;

    const [added] = await this.db
      .select({ n: sql<number>`coalesce(sum(${schema.asIsItems.quantity}), 0)::int` })
      .from(schema.asIsItems)
      .where(
        and(
          eq(schema.asIsItems.businessId, biz),
          inArray(schema.asIsItems.variantId, ids),
          gte(schema.asIsItems.createdAt, monthStart),
          locationId ? eq(schema.asIsItems.locationId, locationId) : undefined,
        ),
      );
    const [removed] = await this.db
      .select({ n: sql<number>`coalesce(sum(${schema.asIsItems.quantity}), 0)::int` })
      .from(schema.asIsItems)
      .where(
        and(
          eq(schema.asIsItems.businessId, biz),
          inArray(schema.asIsItems.variantId, ids),
          ne(schema.asIsItems.status, 'pending_review'),
          sql`${schema.asIsItems.reviewedAt} IS NOT NULL`,
          gte(schema.asIsItems.reviewedAt, monthStart),
          locationId ? eq(schema.asIsItems.locationId, locationId) : undefined,
        ),
      );
    out.asIs.added = added?.n ?? 0;
    out.asIs.removed = removed?.n ?? 0;
    out.beginningAsIsBalance = strip.asIsOnHand - out.asIs.added + out.asIs.removed;

    const asIsTransfers = await this.db
      .select({
        toLocationId: schema.stockTransfers.toLocationId,
        fromLocationId: schema.stockTransfers.fromLocationId,
        shippedAt: schema.stockTransfers.shippedAt,
        receivedAt: schema.stockTransfers.receivedAt,
        shipped: sql<number>`coalesce(sum(${schema.stockTransferLines.quantityShipped}), 0)::int`,
        received: sql<number>`coalesce(sum(${schema.stockTransferLines.quantityReceived}), 0)::int`,
      })
      .from(schema.stockTransferLines)
      .innerJoin(
        schema.stockTransfers,
        eq(schema.stockTransfers.id, schema.stockTransferLines.transferId),
      )
      .where(
        and(
          eq(schema.stockTransfers.businessId, biz),
          inArray(schema.stockTransferLines.variantId, ids),
          eq(schema.stockTransfers.transferType, 'as_is'),
          ne(schema.stockTransfers.status, 'canceled'),
          sql`(${schema.stockTransfers.shippedAt} >= ${monthStart.toISOString()}::timestamptz OR ${schema.stockTransfers.receivedAt} >= ${monthStart.toISOString()}::timestamptz)`,
        ),
      )
      .groupBy(
        schema.stockTransfers.id,
        schema.stockTransfers.toLocationId,
        schema.stockTransfers.fromLocationId,
        schema.stockTransfers.shippedAt,
        schema.stockTransfers.receivedAt,
      );
    for (const t of asIsTransfers) {
      if (
        t.shippedAt &&
        t.shippedAt >= monthStart &&
        (!locationId || t.fromLocationId === locationId)
      ) {
        out.asIs.transferredOut += t.shipped;
      }
      if (
        t.receivedAt &&
        t.receivedAt >= monthStart &&
        (!locationId || t.toLocationId === locationId)
      ) {
        out.asIs.transferredIn += t.received;
      }
    }
    return out;
  }
}
