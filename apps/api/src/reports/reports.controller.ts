import { Controller, ForbiddenException, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { loadCategoryIndex } from '../catalog/category-tree';
import { CurrentTenant } from '../auth/current-user.decorator';
import { salesScopeCond, sellingScopeCond } from '../common/sales-scope';
import { CostingService } from '../costing/costing.service';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { toCsv } from './csv';

interface DailyTotalRow {
  day: string; // ISO YYYY-MM-DD
  saleCount: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}
interface AssociateTotalRow {
  associateUserId: string | null;
  associateEmail: string | null;
  saleCount: number;
  totalCents: number;
}
interface PaymentMethodRow {
  method: string;
  amountCents: number;
  count: number;
}
interface OrderPaymentsDayRow {
  day: string;
  amountCents: number;
  count: number;
}
interface AdjustmentRow {
  at: string;
  reason: string;
  delta: number;
  productName: string;
  sku: string | null;
  locationName: string | null;
  actorEmail: string | null;
  notes: string | null;
  referenceType: string | null;
}

interface AdjustmentsReport {
  start: string;
  end: string;
  generatedAt: string;
  truncated: boolean;
  byReason: { reason: string; movements: number; totalIn: number; totalOut: number }[];
  rows: AdjustmentRow[];
}

interface CustomerPurchaseRow {
  documentType: 'sale' | 'order';
  documentNumber: string;
  documentDate: string;
  customerName: string | null;
  productName: string;
  sku: string | null;
  description: string;
  quantity: number;
  totalCents: number;
}

interface MerchRow {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorName: string | null;
  categoryName: string | null;
  /** Full path ("Mattresses › Hybrid"); categoryName is the leaf. */
  categoryPath: string | null;
  brandName: string | null;
  onHand: number;
  reserved: number;
  floorSample: number;
  netAvailable: number;
  asIsQty: number;
  onOrder: number;
  soldMtd: number;
  soldYtd: number;
  costCents: number | null;
  priceCents: number;
  markupPct: number | null;
}

interface MerchReport {
  generatedAt: string;
  truncated: boolean;
  rows: MerchRow[];
}

interface ReceiptsRow {
  method: string;
  locationId: string | null;
  locationName: string | null;
  count: number;
  amountCents: number;
}

interface ReceiptsReport {
  start: string;
  end: string;
  generatedAt: string;
  rows: ReceiptsRow[];
  totals: { count: number; amountCents: number };
}

interface GiftCardLiabilityRow {
  code: string;
  status: string;
  customerName: string | null;
  issuedAt: string;
  expiresAt: string | null;
  initialCents: number;
  remainingCents: number;
}

interface GiftCardLiability {
  generatedAt: string;
  includeExpired: boolean;
  cardCount: number;
  outstandingCents: number;
  rows: GiftCardLiabilityRow[];
}

interface DeliveryDateChangeRow {
  at: string;
  action: string;
  deliveryId: string | null;
  orderNumber: string | null;
  actorEmail: string | null;
  fromDate: string | null;
  toDate: string | null;
}

interface JeopardyRow {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  locationId: string;
  locationName: string | null;
  lineId: string;
  productName: string;
  sku: string | null;
  shortfall: number;
  deliveryDate: string;
  salespersonMembershipId: string | null;
  salespersonName: string | null;
  /** 'no_supply' — nothing inbound covers the shortfall;
   *  'late' — earliest inbound supply lands after the promised date. */
  risk: 'no_supply' | 'late';
  daysLate: number | null;
  supplySource: 'po' | 'transfer' | null;
  supplyReference: string | null;
  supplyDate: string | null;
}

interface JeopardyReport {
  horizonDays: number;
  generatedAt: string;
  rows: JeopardyRow[];
}

interface SalesSummaryRow {
  key: string;
  label: string;
  documentCount: number;
  merchandiseCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

interface SalesSummary {
  basis: 'written' | 'delivered';
  groupBy: 'day' | 'location' | 'salesperson';
  start: string;
  end: string;
  rows: SalesSummaryRow[];
  totals: {
    documentCount: number;
    merchandiseCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
    /** Average merchandise per document — counts documents, never
     *  document-salesperson pairs (catalog rule, Report Average Value). */
    averageMerchandiseCents: number;
  };
}

interface DailyReport {
  start: string;
  end: string;
  byDay: DailyTotalRow[];
  byAssociate: AssociateTotalRow[];
  /** Tender mix across POS sales AND order deposits/balances (D2). */
  byPaymentMethod: PaymentMethodRow[];
  /** Money taken against sales orders per day — deposits and balances. */
  orderPaymentsByDay: OrderPaymentsDayRow[];
}

interface ZReportTenderRow {
  method: string;
  amountCents: number;
  count: number;
}
interface ZReportShiftRow {
  id: string;
  locationId: string;
  openedAt: string;
  closedAt: string | null;
  openingFloatCents: number;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
}
interface ZReport {
  date: string;
  locationId: string | null;
  saleCount: number;
  grossCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  refundCount: number;
  refundsCents: number;
  netCents: number;
  tenders: ZReportTenderRow[];
  orderPaymentsCents: number;
  shifts: ZReportShiftRow[];
}

interface CategoryRow {
  categoryId: string | null;
  /** Leaf name, 'Uncategorized' without a category. */
  categoryName: string;
  /** Full path ("Mattresses › Hybrid"), 'Uncategorized' without a category. */
  categoryPath: string;
  quantity: number;
  revenueCents: number;
}

interface ValuationRow {
  variantId: string;
  locationId: string;
  locationName: string | null;
  productName: string;
  variantName: string | null;
  sku: string | null;
  onHand: number;
  costCents: number | null;
  priceCents: number;
  costValueCents: number | null;
  retailValueCents: number;
}

interface TaxSummaryRow {
  taxClassId: string | null;
  taxClassName: string;
  lineCount: number;
  /**
   * Net line revenue (after line discounts, before order-level discount
   * allocation). The exact taxed base differs by the pro-rata order
   * discount, so this is context, not a filing figure — `taxCents` is
   * the exact number.
   */
  netSalesCents: number;
  taxCents: number;
}

interface ProductRow {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  revenueCents: number;
  costCents: number | null;
  marginCents: number | null;
}
interface InventoryRow {
  variantId: string;
  locationId: string;
  productName: string;
  sku: string | null;
  variantName: string | null;
  onHand: number;
  reserved: number;
  available: number;
}

@TenantScoped()
@Controller('v1/reports')
export class ReportsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(CostingService) private readonly costing: CostingService,
  ) {}

  /**
   * Daily sales totals across the requested window. Returns three slices
   * of the same data: per-day, per-associate, and per-payment-method.
   * The window defaults to the last 7 days inclusive of today (UTC).
   */
  @Get('sales/daily')
  @RequirePermission('reports.sales.view')
  async daily(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<DailyReport | void> {
    const { startDate, endDate } = parseRange(startStr, endStr);
    const startTs = new Date(`${startDate}T00:00:00.000Z`);
    const endTsExclusive = new Date(`${endDate}T00:00:00.000Z`);
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);

    // We only count completed sales (and partial refunds keep their sale
    // row in 'partially_refunded' but the originating revenue still
    // counts). Voided sales are excluded.
    const includedStatuses = sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`;
    const dateRange = and(
      gte(schema.sales.completedAt, startTs),
      lt(schema.sales.completedAt, endTsExclusive),
    );

    const dayExpr = sql<string>`to_char(${schema.sales.completedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const byDay = await this.db
      .select({
        day: dayExpr,
        saleCount: sql<number>`COUNT(*)::int`,
        subtotalCents: sql<number>`COALESCE(SUM(${schema.sales.subtotalCents}), 0)::int`,
        discountCents: sql<number>`COALESCE(SUM(${schema.sales.discountCents}), 0)::int`,
        taxCents: sql<number>`COALESCE(SUM(${schema.sales.taxCents}), 0)::int`,
        totalCents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int`,
      })
      .from(schema.sales)
      .where(and(dateRange, includedStatuses, salesScopeCond(tenant, schema.sales.locationId)))
      .groupBy(dayExpr)
      .orderBy(dayExpr);

    const byAssociate = await this.db
      .select({
        associateUserId: schema.sales.associateUserId,
        associateEmail: schema.users.email,
        saleCount: sql<number>`COUNT(*)::int`,
        totalCents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int`,
      })
      .from(schema.sales)
      .leftJoin(schema.users, eq(schema.users.id, schema.sales.associateUserId))
      .where(and(dateRange, includedStatuses, salesScopeCond(tenant, schema.sales.locationId)))
      .groupBy(schema.sales.associateUserId, schema.users.email)
      .orderBy(desc(sql`COALESCE(SUM(${schema.sales.totalCents}), 0)`));

    const salePayments = await this.db
      .select({
        method: schema.payments.method,
        amountCents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.payments)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .where(
        and(
          dateRange,
          includedStatuses,
          eq(schema.payments.status, 'succeeded'),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(schema.payments.method);

    // Order deposits/balances join the tender mix (D2). Received-at is the
    // payment's own timestamp — an order can live for weeks, its money
    // lands the day it is taken. Imported legacy orders excluded per D8.
    const orderPaymentWindow = and(
      gte(schema.payments.createdAt, startTs),
      lt(schema.payments.createdAt, endTsExclusive),
      eq(schema.payments.status, 'succeeded'),
      isNull(schema.orders.importedAt),
      salesScopeCond(tenant, schema.orders.locationId),
    );
    const orderPayments = await this.db
      .select({
        method: schema.payments.method,
        amountCents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.payments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(orderPaymentWindow)
      .groupBy(schema.payments.method);

    const methodTotals = new Map<string, { amountCents: number; count: number }>();
    for (const row of [...salePayments, ...orderPayments]) {
      const cur = methodTotals.get(row.method) ?? { amountCents: 0, count: 0 };
      cur.amountCents += row.amountCents;
      cur.count += row.count;
      methodTotals.set(row.method, cur);
    }
    const byPaymentMethod = [...methodTotals.entries()]
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.amountCents - a.amountCents);

    const orderPayDayExpr = sql<string>`to_char(${schema.payments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const orderPaymentsByDay = await this.db
      .select({
        day: orderPayDayExpr,
        amountCents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.payments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(orderPaymentWindow)
      .groupBy(orderPayDayExpr)
      .orderBy(orderPayDayExpr);

    const report: DailyReport = {
      start: startDate,
      end: endDate,
      byDay,
      byAssociate,
      byPaymentMethod,
      orderPaymentsByDay,
    };
    if (format === 'csv') {
      requireExport(tenant);
      const csv = toCsv(
        ['day', 'sale_count', 'subtotal_cents', 'discount_cents', 'tax_cents', 'total_cents'],
        report.byDay.map((r) => [
          r.day,
          r.saleCount,
          r.subtotalCents,
          r.discountCents,
          r.taxCents,
          r.totalCents,
        ]),
      );
      sendCsv(res!, `sales-daily-${startDate}-to-${endDate}.csv`, csv);
      return;
    }
    return report;
  }

  /**
   * Sales aggregated per variant across a date window. Margin (and any
   * cost-derived field) is omitted unless the caller has
   * `reports.financial.view`.
   */
  @Get('sales/by-product')
  @RequirePermission('reports.sales.view')
  async byProduct(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<ProductRow[] | void> {
    const { startDate, endDate } = parseRange(startStr, endStr);
    const startTs = new Date(`${startDate}T00:00:00.000Z`);
    const endTsExclusive = new Date(`${endDate}T00:00:00.000Z`);
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);

    const canSeeFinancial = hasPermission(tenant, 'reports.financial.view');

    const rows = await this.db
      .select({
        variantId: schema.saleLines.variantId,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        costCents: schema.productVariants.costCents,
        quantity: sql<number>`COALESCE(SUM(${schema.saleLines.quantity}), 0)::int`,
        revenueCents: sql<number>`COALESCE(SUM(${schema.saleLines.totalCents}), 0)::int`,
      })
      .from(schema.saleLines)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.saleLines.saleId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.saleLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          gte(schema.sales.completedAt, startTs),
          lt(schema.sales.completedAt, endTsExclusive),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(
        schema.saleLines.variantId,
        schema.products.name,
        schema.productVariants.name,
        schema.productVariants.sku,
        schema.productVariants.costCents,
      )
      .orderBy(desc(sql`COALESCE(SUM(${schema.saleLines.totalCents}), 0)`));

    const out: ProductRow[] = rows.map((r) => {
      const cost = canSeeFinancial ? r.costCents : null;
      const margin =
        canSeeFinancial && r.costCents != null ? r.revenueCents - r.costCents * r.quantity : null;
      return {
        variantId: r.variantId ?? '',
        productName: r.productName ?? '(deleted product)',
        variantName: r.variantName ?? null,
        sku: r.sku ?? null,
        quantity: r.quantity,
        revenueCents: r.revenueCents,
        costCents: cost,
        marginCents: margin,
      };
    });

    if (format === 'csv') {
      requireExport(tenant);
      const headers = ['product', 'variant', 'sku', 'quantity', 'revenue_cents'];
      if (canSeeFinancial) headers.push('cost_cents', 'margin_cents');
      const data = out.map((r) => {
        const row: (string | number | null)[] = [
          r.productName,
          r.variantName,
          r.sku,
          r.quantity,
          r.revenueCents,
        ];
        if (canSeeFinancial) row.push(r.costCents, r.marginCents);
        return row;
      });
      sendCsv(res!, `sales-by-product-${startDate}-to-${endDate}.csv`, toCsv(headers, data));
      return;
    }
    return out;
  }

  /**
   * Inventory on-hand snapshot. Optional `locationId` filter and
   * `lowStock` numeric threshold (returns rows where available <= N).
   */
  @Get('inventory/on-hand')
  @RequirePermission('reports.inventory.view')
  async inventory(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
    @Query('lowStock') lowStockStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<InventoryRow[] | void> {
    const where = locationId ? eq(schema.inventoryLevels.locationId, locationId) : undefined;
    const rows = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        locationId: schema.inventoryLevels.locationId,
        productName: schema.products.name,
        sku: schema.productVariants.sku,
        variantName: schema.productVariants.name,
        onHand: schema.inventoryLevels.onHand,
        reserved: schema.inventoryLevels.reserved,
        floorSample: schema.inventoryLevels.floorSample,
      })
      .from(schema.inventoryLevels)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.inventoryLevels.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(where)
      .orderBy(schema.products.name, schema.productVariants.sku);

    const all = rows.map((r) => ({
      ...r,
      available: Math.max(0, r.onHand - r.reserved - r.floorSample),
    }));
    const lowStock = lowStockStr != null ? Number(lowStockStr) : NaN;
    const filtered = Number.isFinite(lowStock) ? all.filter((r) => r.available <= lowStock) : all;

    if (format === 'csv') {
      requireExport(tenant);
      sendCsv(
        res!,
        `inventory-on-hand-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(
          ['product', 'variant', 'sku', 'on_hand', 'reserved', 'available'],
          filtered.map((r) => [
            r.productName,
            r.variantName,
            r.sku,
            r.onHand,
            r.reserved,
            r.available,
          ]),
        ),
      );
      return;
    }
    return filtered;
  }

  /**
   * Z-report — the daily close-out sheet, built to sit next to the STORIS
   * Z-report on parallel-run day. One UTC day (default: today), optional
   * location filter. Imported legacy documents are excluded (D8): this is
   * a drawer-day view, not a history view.
   */
  @Get('z')
  @RequirePermission('reports.sales.view')
  async zReport(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('date') dateStr?: string,
    @Query('locationId') locationId?: string,
  ): Promise<ZReport> {
    const date = matchesDate(dateStr) ? dateStr! : new Date().toISOString().slice(0, 10);
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const saleDay = and(
      gte(schema.sales.completedAt, dayStart),
      lt(schema.sales.completedAt, dayEnd),
      sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
      isNull(schema.sales.importedAt),
      locationId ? eq(schema.sales.locationId, locationId) : undefined,
      salesScopeCond(tenant, schema.sales.locationId),
    );

    const [salesTotals] = await this.db
      .select({
        saleCount: sql<number>`COUNT(*)::int`,
        subtotalCents: sql<number>`COALESCE(SUM(${schema.sales.subtotalCents}), 0)::int`,
        discountCents: sql<number>`COALESCE(SUM(${schema.sales.discountCents}), 0)::int`,
        taxCents: sql<number>`COALESCE(SUM(${schema.sales.taxCents}), 0)::int`,
        grossCents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int`,
      })
      .from(schema.sales)
      .where(saleDay);

    const [refundTotals] = await this.db
      .select({
        refundCount: sql<number>`COUNT(*)::int`,
        refundsCents: sql<number>`COALESCE(SUM(${schema.refunds.amountCents}), 0)::int`,
      })
      .from(schema.refunds)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
      .where(
        and(
          gte(schema.refunds.createdAt, dayStart),
          lt(schema.refunds.createdAt, dayEnd),
          isNull(schema.sales.importedAt),
          locationId ? eq(schema.sales.locationId, locationId) : undefined,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );

    // Tender mix: every succeeded payment taken today, whatever document
    // it landed on (POS sale, order deposit/balance, service charge) —
    // matching what the drawer actually saw. Payments against imported
    // documents are excluded via the left joins.
    const tenders = await this.db
      .select({
        method: schema.payments.method,
        amountCents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.payments)
      .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      // Service charges are the third payment parent (exactly one of
      // sale/order/service per row). Without this join a location
      // filter's COALESCE was NULL for them — every service payment
      // silently vanished from the filtered Z — and D8's imported
      // exclusion could never apply to service documents.
      .leftJoin(schema.serviceOrders, eq(schema.serviceOrders.id, schema.payments.serviceOrderId))
      .where(
        and(
          gte(schema.payments.createdAt, dayStart),
          lt(schema.payments.createdAt, dayEnd),
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.sales.importedAt),
          isNull(schema.orders.importedAt),
          isNull(schema.serviceOrders.importedAt),
          locationId
            ? sql`COALESCE(${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId}) = ${locationId}`
            : undefined,
          salesScopeCond(
            tenant,
            sql`COALESCE(${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`,
          ),
        ),
      )
      .groupBy(schema.payments.method)
      .orderBy(desc(sql`COALESCE(SUM(${schema.payments.amountCents}), 0)`));

    const [orderMoney] = await this.db
      .select({
        amountCents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
      })
      .from(schema.payments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(
        and(
          gte(schema.payments.createdAt, dayStart),
          lt(schema.payments.createdAt, dayEnd),
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.orders.importedAt),
          locationId ? eq(schema.orders.locationId, locationId) : undefined,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );

    const shifts = await this.db
      .select({
        id: schema.cashShifts.id,
        locationId: schema.cashShifts.locationId,
        openedAt: schema.cashShifts.openedAt,
        closedAt: schema.cashShifts.closedAt,
        openingFloatCents: schema.cashShifts.openingFloatCents,
        expectedCashCents: schema.cashShifts.expectedCashCents,
        countedCashCents: schema.cashShifts.countedCashCents,
        varianceCents: schema.cashShifts.varianceCents,
      })
      .from(schema.cashShifts)
      .where(
        and(
          // A shift belongs to today's Z if it was open at any point today:
          // opened before end-of-day and not closed before start-of-day.
          lt(schema.cashShifts.openedAt, dayEnd),
          or(isNull(schema.cashShifts.closedAt), gte(schema.cashShifts.closedAt, dayStart)),
          locationId ? eq(schema.cashShifts.locationId, locationId) : undefined,
          salesScopeCond(tenant, schema.cashShifts.locationId),
        ),
      )
      .orderBy(schema.cashShifts.openedAt);

    const grossCents = salesTotals?.grossCents ?? 0;
    const refundsCents = refundTotals?.refundsCents ?? 0;
    return {
      date,
      locationId: locationId ?? null,
      saleCount: salesTotals?.saleCount ?? 0,
      grossCents,
      subtotalCents: salesTotals?.subtotalCents ?? 0,
      discountCents: salesTotals?.discountCents ?? 0,
      taxCents: salesTotals?.taxCents ?? 0,
      refundCount: refundTotals?.refundCount ?? 0,
      refundsCents,
      netCents: grossCents - refundsCents,
      tenders,
      orderPaymentsCents: orderMoney?.amountCents ?? 0,
      shifts: shifts.map((s) => ({
        ...s,
        openedAt: s.openedAt.toISOString(),
        closedAt: s.closedAt ? s.closedAt.toISOString() : null,
      })),
    };
  }

  /** Sales aggregated per product category across a date window. */
  @Get('sales/by-category')
  @RequirePermission('reports.sales.view')
  async byCategory(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<CategoryRow[] | void> {
    const { startDate, endDate } = parseRange(startStr, endStr);
    const startTs = new Date(`${startDate}T00:00:00.000Z`);
    const endTsExclusive = new Date(`${endDate}T00:00:00.000Z`);
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);

    const grouped = await this.db
      .select({
        categoryId: schema.products.categoryId,
        categoryName: sql<string>`COALESCE(${schema.categories.name}, 'Uncategorized')`,
        quantity: sql<number>`COALESCE(SUM(${schema.saleLines.quantity}), 0)::int`,
        revenueCents: sql<number>`COALESCE(SUM(${schema.saleLines.totalCents}), 0)::int`,
      })
      .from(schema.saleLines)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.saleLines.saleId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.saleLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
      .where(
        and(
          gte(schema.sales.completedAt, startTs),
          lt(schema.sales.completedAt, endTsExclusive),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(schema.products.categoryId, schema.categories.name)
      .orderBy(desc(sql`COALESCE(SUM(${schema.saleLines.totalCents}), 0)`));
    // A22.1: categories nest, so each bucket also reads its full path.
    const categoryIndex = await loadCategoryIndex(this.db, tenant.businessId!);
    const rows: CategoryRow[] = grouped.map((r) => ({
      ...r,
      categoryPath: categoryIndex.pathOf(r.categoryId) ?? r.categoryName,
    }));

    if (format === 'csv') {
      requireExport(tenant);
      sendCsv(
        res!,
        `sales-by-category-${startDate}-to-${endDate}.csv`,
        toCsv(
          ['category', 'quantity', 'revenue_cents'],
          rows.map((r) => [r.categoryPath, r.quantity, r.revenueCents]),
        ),
      );
      return;
    }
    return rows;
  }

  /**
   * Inventory valuation: on-hand × cost (and × retail) per variant.
   * Cost-derived, so it sits behind `reports.financial.view`.
   */
  @Get('inventory/valuation')
  @RequirePermission('reports.financial.view')
  async valuation(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<{
    rows: ValuationRow[];
    totalCostValueCents: number;
    totalRetailValueCents: number;
  } | void> {
    const rows = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        locationId: schema.inventoryLevels.locationId,
        locationName: schema.locations.name,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        onHand: schema.inventoryLevels.onHand,
        costCents: schema.productVariants.costCents,
        priceCents: schema.productVariants.priceCents,
      })
      .from(schema.inventoryLevels)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.inventoryLevels.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
      .where(locationId ? eq(schema.inventoryLevels.locationId, locationId) : undefined)
      .orderBy(schema.products.name, schema.productVariants.sku);

    // FIFO valuation (owner decision 2026-08-27): layered stock is valued
    // at its actual layer costs; any remainder that predates costing
    // falls back to the catalog cost.
    const fifo = await this.costing.valuation(this.db, {
      businessId: tenant.businessId!,
      locationId,
    });
    const out: ValuationRow[] = rows.map((r) => {
      const layered = fifo.get(`${r.variantId}:${r.locationId}`);
      const layeredQty = Math.min(layered?.quantity ?? 0, r.onHand);
      const remainder = r.onHand - layeredQty;
      const costValueCents = layered
        ? layered.costCents + remainder * (r.costCents ?? 0)
        : r.costCents != null
          ? r.costCents * r.onHand
          : null;
      return {
        ...r,
        costValueCents,
        retailValueCents: r.priceCents * r.onHand,
      };
    });
    const totalCostValueCents = out.reduce((s, r) => s + (r.costValueCents ?? 0), 0);
    const totalRetailValueCents = out.reduce((s, r) => s + r.retailValueCents, 0);

    if (format === 'csv') {
      requireExport(tenant);
      sendCsv(
        res!,
        `inventory-valuation-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(
          [
            'product',
            'variant',
            'sku',
            'location',
            'on_hand',
            'cost_cents',
            'cost_value_cents',
            'retail_value_cents',
          ],
          out.map((r) => [
            r.productName,
            r.variantName,
            r.sku,
            r.locationName ?? r.locationId,
            r.onHand,
            r.costCents,
            r.costValueCents,
            r.retailValueCents,
          ]),
        ),
      );
      return;
    }
    return { rows: out, totalCostValueCents, totalRetailValueCents };
  }

  /**
   * Tax collected across a window, grouped by the product's tax class.
   * Lines whose product has no class fall under the business/location
   * default rate. Reconciles to the cent with SUM(sales.tax_cents).
   */
  @Get('tax/summary')
  @RequirePermission('reports.financial.view')
  async taxSummary(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<{
    rows: TaxSummaryRow[];
    byLocation: {
      locationId: string;
      locationName: string | null;
      documents: number;
      taxCents: number;
      totalCents: number;
    }[];
    totalTaxCents: number;
    start: string;
    end: string;
  } | void> {
    const { startDate, endDate } = parseRange(startStr, endStr);
    const startTs = new Date(`${startDate}T00:00:00.000Z`);
    const endTsExclusive = new Date(`${endDate}T00:00:00.000Z`);
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);

    const rows = await this.db
      .select({
        taxClassId: schema.products.taxClassId,
        taxClassName: sql<string>`COALESCE(${schema.taxClasses.name}, 'Default rate')`,
        lineCount: sql<number>`COUNT(*)::int`,
        // Line totalCents is net of line discounts and pre-tax (totals.ts).
        netSalesCents: sql<number>`COALESCE(SUM(${schema.saleLines.totalCents}), 0)::int`,
        taxCents: sql<number>`COALESCE(SUM(${schema.saleLines.taxCents}), 0)::int`,
      })
      .from(schema.saleLines)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.saleLines.saleId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.saleLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.taxClasses, eq(schema.taxClasses.id, schema.products.taxClassId))
      .where(
        and(
          gte(schema.sales.completedAt, startTs),
          lt(schema.sales.completedAt, endTsExclusive),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(schema.products.taxClassId, schema.taxClasses.name)
      .orderBy(desc(sql`COALESCE(SUM(${schema.saleLines.taxCents}), 0)`));

    const totalTaxCents = rows.reduce((s, r) => s + r.taxCents, 0);

    // Jurisdiction view (catalog 87). LA Mattress jurisdictions map to
    // locations (a location carries its tax rate), so filing totals are
    // by location, over completed POS sales AND completed orders.
    const saleTaxByLoc = await this.db
      .select({
        locationId: schema.sales.locationId,
        documents: sql<number>`COUNT(*)::int`,
        taxCents: sql<number>`COALESCE(SUM(${schema.sales.taxCents}), 0)::int`,
        totalCents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int`,
      })
      .from(schema.sales)
      .where(
        and(
          gte(schema.sales.completedAt, startTs),
          lt(schema.sales.completedAt, endTsExclusive),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
          isNull(schema.sales.importedAt),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(schema.sales.locationId);
    const orderTaxByLoc = await this.db
      .select({
        locationId: schema.orders.locationId,
        documents: sql<number>`COUNT(*)::int`,
        taxCents: sql<number>`COALESCE(SUM(${schema.orders.taxCents}), 0)::int`,
        totalCents: sql<number>`COALESCE(SUM(${schema.orders.totalCents}), 0)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          gte(schema.orders.completedAt, startTs),
          lt(schema.orders.completedAt, endTsExclusive),
          eq(schema.orders.status, 'completed'),
          isNull(schema.orders.importedAt),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .groupBy(schema.orders.locationId);
    const byLocMap = new Map<
      string,
      { locationId: string; documents: number; taxCents: number; totalCents: number }
    >();
    for (const r of [...saleTaxByLoc, ...orderTaxByLoc]) {
      const cur = byLocMap.get(r.locationId) ?? {
        locationId: r.locationId,
        documents: 0,
        taxCents: 0,
        totalCents: 0,
      };
      cur.documents += r.documents;
      cur.taxCents += r.taxCents;
      cur.totalCents += r.totalCents;
      byLocMap.set(r.locationId, cur);
    }
    const locNames = byLocMap.size
      ? await this.db
          .select({ id: schema.locations.id, name: schema.locations.name })
          .from(schema.locations)
          .where(inArray(schema.locations.id, [...byLocMap.keys()]))
      : [];
    const locNameBy = new Map(locNames.map((l) => [l.id, l.name]));
    const byLocation = [...byLocMap.values()]
      .map((r) => ({ ...r, locationName: locNameBy.get(r.locationId) ?? null }))
      .sort((a, b) => b.taxCents - a.taxCents);

    if (format === 'csv') {
      requireExport(tenant);
      sendCsv(
        res!,
        `tax-summary-${startDate}-to-${endDate}.csv`,
        toCsv(
          ['tax_class', 'line_count', 'net_sales_cents', 'tax_cents'],
          rows.map((r) => [r.taxClassName, r.lineCount, r.netSalesCents, r.taxCents]),
        ),
      );
      return;
    }
    return { rows, byLocation, totalTaxCents, start: startDate, end: endDate };
  }

  /**
   * Accounts receivable (G8-lite): every live or completed document that
   * still has money owing, bucketed by age. Quotes owe nothing; imported
   * docs are included — their balances are real even if their history
   * came from STORIS.
   */
  @Get('ar')
  @RequirePermission('reports.financial.view')
  async ar(@CurrentTenant() _tenant: RequestTenantContext): Promise<{
    rows: {
      customerId: string;
      customerName: string | null;
      documents: number;
      balanceCents: number;
      bucket0_30: number;
      bucket31_60: number;
      bucket61_90: number;
      bucket90plus: number;
    }[];
    totalCents: number;
  }> {
    const orders = await this.db
      .select({
        id: schema.orders.id,
        customerId: schema.orders.customerId,
        totalCents: schema.orders.totalCents,
        createdAt: schema.orders.createdAt,
        status: schema.orders.status,
      })
      .from(schema.orders)
      .where(sql`${schema.orders.status} NOT IN ('quote', 'cancelled')`);
    const orderIds = orders.map((o) => o.id);
    const paid = new Map<string, number>();
    if (orderIds.length > 0) {
      const pays = await this.db
        .select({
          orderId: schema.payments.orderId,
          amount: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
        })
        .from(schema.payments)
        .where(
          and(sql`${schema.payments.orderId} IS NOT NULL`, eq(schema.payments.status, 'succeeded')),
        )
        .groupBy(schema.payments.orderId);
      for (const p of pays) if (p.orderId) paid.set(p.orderId, p.amount);
    }

    const byCustomer = new Map<
      string,
      {
        documents: number;
        balanceCents: number;
        bucket0_30: number;
        bucket31_60: number;
        bucket61_90: number;
        bucket90plus: number;
      }
    >();
    const now = Date.now();
    for (const o of orders) {
      const balance = o.totalCents - (paid.get(o.id) ?? 0);
      if (balance <= 0) continue;
      const days = Math.floor((now - new Date(o.createdAt).getTime()) / 86_400_000);
      const cur = byCustomer.get(o.customerId) ?? {
        documents: 0,
        balanceCents: 0,
        bucket0_30: 0,
        bucket31_60: 0,
        bucket61_90: 0,
        bucket90plus: 0,
      };
      cur.documents += 1;
      cur.balanceCents += balance;
      if (days <= 30) cur.bucket0_30 += balance;
      else if (days <= 60) cur.bucket31_60 += balance;
      else if (days <= 90) cur.bucket61_90 += balance;
      else cur.bucket90plus += balance;
      byCustomer.set(o.customerId, cur);
    }

    const customerIds = [...byCustomer.keys()];
    const names = customerIds.length
      ? await this.db
          .select({
            id: schema.customers.id,
            firstName: schema.customers.firstName,
            lastName: schema.customers.lastName,
          })
          .from(schema.customers)
          .where(inArray(schema.customers.id, customerIds))
      : [];
    const nameBy = new Map(
      names.map((c) => [c.id, [c.firstName, c.lastName].filter(Boolean).join(' ') || null]),
    );
    const rows = customerIds
      .map((customerId) => ({
        customerId,
        customerName: nameBy.get(customerId) ?? null,
        ...byCustomer.get(customerId)!,
      }))
      .sort((a, b) => b.balanceCents - a.balanceCents);
    return { rows, totalCents: rows.reduce((s, r) => s + r.balanceCents, 0) };
  }

  /**
   * Unified sales report — the catalog's Written Sales Dollars /
   * Written Sales Summary / Completed (Monthly) Sales Dollars merged
   * into one surface with written-vs-delivered as a first-class
   * dimension (pack 01/06). Covers POS sales AND sales orders; imported
   * legacy documents excluded (D8); store data scope applies.
   *
   * Deliberate divergence (recorded in SPRINT-STATUS): "written" uses
   * the document's CURRENT totals dated by entry time — we do not keep
   * an at-entry snapshot, so later edits fold into the written figure
   * instead of listing as separate adjustment records.
   */
  @Get('sales/summary')
  @RequirePermission('reports.sales.view')
  async salesSummary(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('basis') basisStr?: string,
    @Query('groupBy') groupByStr?: string,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<SalesSummary | void> {
    const basis: 'written' | 'delivered' = basisStr === 'delivered' ? 'delivered' : 'written';
    const groupBy: 'day' | 'location' | 'salesperson' =
      groupByStr === 'location' || groupByStr === 'salesperson' ? groupByStr : 'day';
    const { startDate, endDate } = parseRange(startStr, endStr);
    const startTs = new Date(`${startDate}T00:00:00.000Z`);
    const endTsExclusive = new Date(`${endDate}T00:00:00.000Z`);
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);

    const saleDate = basis === 'written' ? schema.sales.createdAt : schema.sales.completedAt;
    const orderDate = basis === 'written' ? schema.orders.createdAt : schema.orders.completedAt;

    const saleWhere = and(
      gte(saleDate, startTs),
      lt(saleDate, endTsExclusive),
      sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
      isNull(schema.sales.importedAt),
      salesScopeCond(tenant, schema.sales.locationId),
    );
    const orderWhere = and(
      gte(orderDate, startTs),
      lt(orderDate, endTsExclusive),
      basis === 'written'
        ? sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`
        : eq(schema.orders.status, 'completed'),
      isNull(schema.orders.importedAt),
      salesScopeCond(tenant, schema.orders.locationId),
    );

    const saleKey =
      groupBy === 'day'
        ? sql<string>`to_char(${saleDate} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
        : groupBy === 'location'
          ? sql<string>`${schema.sales.locationId}::text`
          : sql<string>`COALESCE(${schema.sales.associateUserId}::text, '')`;
    const orderKey =
      groupBy === 'day'
        ? sql<string>`to_char(${orderDate} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
        : groupBy === 'location'
          ? sql<string>`${schema.orders.locationId}::text`
          : sql<string>`COALESCE(${schema.memberships.userId}::text, '')`;

    const saleRows = await this.db
      .select({
        key: saleKey,
        documentCount: sql<number>`COUNT(*)::int`,
        merchandiseCents: sql<number>`COALESCE(SUM(${schema.sales.subtotalCents}), 0)::int`,
        discountCents: sql<number>`COALESCE(SUM(${schema.sales.discountCents}), 0)::int`,
        taxCents: sql<number>`COALESCE(SUM(${schema.sales.taxCents}), 0)::int`,
        totalCents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int`,
      })
      .from(schema.sales)
      .where(saleWhere)
      .groupBy(saleKey);

    let orderQuery = this.db
      .select({
        key: orderKey,
        documentCount: sql<number>`COUNT(*)::int`,
        merchandiseCents: sql<number>`COALESCE(SUM(${schema.orders.subtotalCents}), 0)::int`,
        discountCents: sql<number>`COALESCE(SUM(${schema.orders.discountCents}), 0)::int`,
        taxCents: sql<number>`COALESCE(SUM(${schema.orders.taxCents}), 0)::int`,
        totalCents: sql<number>`COALESCE(SUM(${schema.orders.totalCents}), 0)::int`,
      })
      .from(schema.orders)
      .$dynamic();
    if (groupBy === 'salesperson') {
      orderQuery = orderQuery.leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.orders.salespersonMembershipId),
      );
    }
    const orderRows = await orderQuery.where(orderWhere).groupBy(orderKey);

    const merged = new Map<string, SalesSummaryRow>();
    for (const r of [...saleRows, ...orderRows]) {
      const cur = merged.get(r.key) ?? {
        key: r.key,
        label: r.key,
        documentCount: 0,
        merchandiseCents: 0,
        discountCents: 0,
        taxCents: 0,
        totalCents: 0,
      };
      cur.documentCount += r.documentCount;
      cur.merchandiseCents += r.merchandiseCents;
      cur.discountCents += r.discountCents;
      cur.taxCents += r.taxCents;
      cur.totalCents += r.totalCents;
      merged.set(r.key, cur);
    }

    // Human labels for non-day groupings.
    if (groupBy === 'location') {
      const ids = [...merged.keys()].filter(Boolean);
      const locs = ids.length
        ? await this.db
            .select({ id: schema.locations.id, name: schema.locations.name })
            .from(schema.locations)
            .where(inArray(schema.locations.id, ids))
        : [];
      const nameBy = new Map(locs.map((l) => [l.id, l.name]));
      for (const row of merged.values()) row.label = nameBy.get(row.key) ?? row.key;
    } else if (groupBy === 'salesperson') {
      const ids = [...merged.keys()].filter(Boolean);
      const users = ids.length
        ? await this.db
            .select({ id: schema.users.id, email: schema.users.email })
            .from(schema.users)
            .where(inArray(schema.users.id, ids))
        : [];
      const emailBy = new Map(users.map((u) => [u.id, u.email]));
      for (const row of merged.values())
        row.label = row.key === '' ? '(no salesperson)' : (emailBy.get(row.key) ?? row.key);
    }

    const rows = [...merged.values()].sort((a, b) =>
      groupBy === 'day' ? a.key.localeCompare(b.key) : b.totalCents - a.totalCents,
    );
    const totals = rows.reduce(
      (acc, r) => ({
        documentCount: acc.documentCount + r.documentCount,
        merchandiseCents: acc.merchandiseCents + r.merchandiseCents,
        discountCents: acc.discountCents + r.discountCents,
        taxCents: acc.taxCents + r.taxCents,
        totalCents: acc.totalCents + r.totalCents,
        averageMerchandiseCents: 0,
      }),
      {
        documentCount: 0,
        merchandiseCents: 0,
        discountCents: 0,
        taxCents: 0,
        totalCents: 0,
        averageMerchandiseCents: 0,
      },
    );
    totals.averageMerchandiseCents = totals.documentCount
      ? Math.round(totals.merchandiseCents / totals.documentCount)
      : 0;

    const report: SalesSummary = { basis, groupBy, start: startDate, end: endDate, rows, totals };
    if (format === 'csv') {
      requireExport(tenant);
      // Provenance rides the export (pack 01 § run-time options echo).
      const header = `# basis=${basis} groupBy=${groupBy} start=${startDate} end=${endDate} generated=${new Date().toISOString()}\n`;
      const csv = toCsv(
        [
          'key',
          'label',
          'documents',
          'merchandise_cents',
          'discount_cents',
          'tax_cents',
          'total_cents',
        ],
        rows.map((r) => [
          r.key,
          r.label,
          r.documentCount,
          r.merchandiseCents,
          r.discountCents,
          r.taxCents,
          r.totalCents,
        ]),
      );
      sendCsv(res!, `sales-summary-${basis}-${startDate}-to-${endDate}.csv`, header + csv);
      return;
    }
    return report;
  }

  /**
   * Delivery Dates in Jeopardy — the pack's top-value operational screen
   * (catalog 85): open order lines whose unreserved quantity is not
   * covered by inbound supply before the promised date. Explicit risk
   * states, never the legacy 999 sentinel. Lines with no promised date
   * anywhere (ASAP/CWC equivalents) are excluded — nothing to be in
   * jeopardy of. Store data scope applies.
   */
  @Get('delivery-jeopardy')
  @RequirePermission('orders.view')
  async deliveryJeopardy(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('horizonDays') horizonStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<JeopardyReport | void> {
    const horizonDays = Math.min(Math.max(Number(horizonStr) || 30, 1), 365);
    const horizon = new Date();
    horizon.setUTCDate(horizon.getUTCDate() + horizonDays);
    const horizonDate = horizon.toISOString().slice(0, 10);

    const lines = await this.db
      .select({
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        customerId: schema.orders.customerId,
        locationId: schema.orders.locationId,
        requestedDate: schema.orders.requestedDate,
        salespersonMembershipId: schema.orders.salespersonMembershipId,
        lineId: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        shortfall: sql<number>`(${schema.orderLines.quantity} - ${schema.orderLines.qtyReserved} - ${schema.orderLines.qtyFulfilled})::int`,
        lineDeliveryDate: schema.orderLines.deliveryDate,
        description: schema.orderLines.description,
        sourceLocationId: sql<string>`coalesce(${schema.orderLines.sourceLocationId}, ${schema.orders.stockLocationId}, ${schema.orders.locationId})`,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .where(
        and(
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled', 'completed')`,
          isNull(schema.orders.importedAt),
          inArray(schema.orderLines.lineType, ['stock', 'special_order']),
          sql`coalesce(${schema.orderLines.fulfillmentMethod}, ${schema.orders.fulfillmentType}) <> 'direct_ship'`,
          sql`(${schema.orderLines.quantity} - ${schema.orderLines.qtyReserved} - ${schema.orderLines.qtyFulfilled}) > 0`,
          salesScopeCond(tenant, schema.orders.locationId),
          // Owner ask 2026-08-29: an approved-only seller works only the
          // at-risk orders of the stores they are approved for.
          sellingScopeCond(tenant, schema.orders.locationId),
        ),
      );
    if (lines.length === 0) {
      return { horizonDays, generatedAt: new Date().toISOString(), rows: [] };
    }

    // Promised-date resolution: line date, else the order's earliest live
    // scheduled delivery, else the order's requested date.
    const orderIds = [...new Set(lines.map((l) => l.orderId))];
    const dels = await this.db
      .select({
        orderId: schema.deliveries.orderId,
        scheduledDate: sql<string>`MIN(${schema.deliveries.scheduledDate})`,
      })
      .from(schema.deliveries)
      .where(
        and(
          inArray(schema.deliveries.orderId, orderIds),
          sql`${schema.deliveries.status} IN ('scheduled', 'loaded', 'out_for_delivery')`,
        ),
      )
      .groupBy(schema.deliveries.orderId);
    const deliveryByOrder = new Map(dels.map((d) => [d.orderId, d.scheduledDate]));

    const variantIds = [...new Set(lines.map((l) => l.variantId).filter(Boolean))] as string[];

    // Inbound supply, earliest first: open POs by expected date, and
    // draft/in-transit transfers by scheduled date, per variant+location.
    const poSupply = variantIds.length
      ? await this.db
          .select({
            variantId: schema.purchaseOrderLines.variantId,
            locationId: schema.purchaseOrders.locationId,
            expectedAt: sql<string>`MIN(${schema.purchaseOrders.expectedAt})`,
            reference: sql<string>`MIN(${schema.purchaseOrders.number})`,
          })
          .from(schema.purchaseOrderLines)
          .innerJoin(
            schema.purchaseOrders,
            eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
          )
          .where(
            and(
              inArray(schema.purchaseOrderLines.variantId, variantIds),
              sql`${schema.purchaseOrders.status} IN ('ordered', 'partially_received')`,
              sql`${schema.purchaseOrders.expectedAt} IS NOT NULL`,
              sql`(${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted}) > 0`,
            ),
          )
          .groupBy(schema.purchaseOrderLines.variantId, schema.purchaseOrders.locationId)
      : [];
    const transferSupply = variantIds.length
      ? await this.db
          .select({
            variantId: schema.stockTransferLines.variantId,
            locationId: schema.stockTransfers.toLocationId,
            scheduledFor: sql<string>`MIN(${schema.stockTransfers.scheduledFor})`,
            reference: sql<string>`MIN(${schema.stockTransfers.number})`,
          })
          .from(schema.stockTransferLines)
          .innerJoin(
            schema.stockTransfers,
            eq(schema.stockTransfers.id, schema.stockTransferLines.transferId),
          )
          .where(
            and(
              inArray(schema.stockTransferLines.variantId, variantIds),
              sql`${schema.stockTransfers.status} IN ('draft', 'in_transit')`,
              sql`${schema.stockTransfers.scheduledFor} IS NOT NULL`,
            ),
          )
          .groupBy(schema.stockTransferLines.variantId, schema.stockTransfers.toLocationId)
      : [];
    const supplyBy = new Map<
      string,
      { date: string; source: 'po' | 'transfer'; reference: string }
    >();
    for (const r of poSupply) {
      const date = new Date(r.expectedAt).toISOString().slice(0, 10);
      supplyBy.set(`${r.variantId}:${r.locationId}`, {
        date,
        source: 'po',
        reference: r.reference,
      });
    }
    for (const r of transferSupply) {
      const key = `${r.variantId}:${r.locationId}`;
      const date = String(r.scheduledFor).slice(0, 10);
      const cur = supplyBy.get(key);
      if (!cur || date < cur.date)
        supplyBy.set(key, { date, source: 'transfer', reference: r.reference });
    }

    // Labels.
    const spIds = [
      ...new Set(lines.map((l) => l.salespersonMembershipId).filter(Boolean)),
    ] as string[];
    const [customers, variants, locs, salespeople] = await Promise.all([
      this.db
        .select({
          id: schema.customers.id,
          firstName: schema.customers.firstName,
          lastName: schema.customers.lastName,
        })
        .from(schema.customers)
        .where(
          inArray(schema.customers.id, [
            ...new Set(lines.map((l) => l.customerId).filter(Boolean)),
          ] as string[]),
        ),
      variantIds.length
        ? this.db
            .select({
              id: schema.productVariants.id,
              sku: schema.productVariants.sku,
              productName: schema.products.name,
            })
            .from(schema.productVariants)
            .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
            .where(inArray(schema.productVariants.id, variantIds))
        : Promise.resolve([]),
      this.db
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(inArray(schema.locations.id, [...new Set(lines.map((l) => l.locationId))])),
      spIds.length
        ? this.db
            .select({
              membershipId: schema.memberships.id,
              name: schema.users.name,
              email: schema.users.email,
            })
            .from(schema.memberships)
            .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
            .where(inArray(schema.memberships.id, spIds))
        : Promise.resolve([]),
    ]);
    const customerBy = new Map(
      customers.map((c) => [c.id, [c.firstName, c.lastName].filter(Boolean).join(' ') || null]),
    );
    const variantBy = new Map(variants.map((v) => [v.id, v]));
    const locBy = new Map(locs.map((l) => [l.id, l.name]));
    const spBy = new Map(salespeople.map((m) => [m.membershipId, m.name || m.email]));

    const rows: JeopardyRow[] = [];
    for (const l of lines) {
      const promised =
        l.lineDeliveryDate ?? deliveryByOrder.get(l.orderId) ?? l.requestedDate ?? null;
      if (!promised || promised > horizonDate) continue;
      const supply = l.variantId ? supplyBy.get(`${l.variantId}:${l.sourceLocationId}`) : undefined;
      let risk: 'no_supply' | 'late';
      let daysLate: number | null = null;
      if (!supply) {
        risk = 'no_supply';
      } else if (supply.date > promised) {
        risk = 'late';
        daysLate = Math.round(
          (new Date(supply.date).getTime() - new Date(promised).getTime()) / 86_400_000,
        );
      } else {
        continue; // covered — inbound supply lands in time
      }
      const v = l.variantId ? variantBy.get(l.variantId) : undefined;
      rows.push({
        orderId: l.orderId,
        orderNumber: l.orderNumber,
        customerName: customerBy.get(l.customerId) ?? null,
        locationId: l.locationId,
        locationName: locBy.get(l.locationId) ?? null,
        lineId: l.lineId,
        productName: v?.productName ?? l.description ?? '(unlinked stock item)',
        sku: v?.sku ?? null,
        shortfall: l.shortfall,
        deliveryDate: promised,
        salespersonMembershipId: l.salespersonMembershipId,
        salespersonName: l.salespersonMembershipId
          ? (spBy.get(l.salespersonMembershipId) ?? null)
          : null,
        risk,
        daysLate,
        supplySource: supply?.source ?? null,
        supplyReference: supply?.reference ?? null,
        supplyDate: supply?.date ?? null,
      });
    }
    rows.sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));

    const report: JeopardyReport = {
      horizonDays,
      generatedAt: new Date().toISOString(),
      rows,
    };
    if (format === 'csv') {
      requireExport(tenant);
      const header = `# horizonDays=${horizonDays} generated=${report.generatedAt}\n`;
      sendCsv(
        res!,
        `delivery-jeopardy-${new Date().toISOString().slice(0, 10)}.csv`,
        header +
          toCsv(
            [
              'order',
              'customer',
              'salesperson',
              'location',
              'product',
              'sku',
              'shortfall',
              'promised',
              'risk',
              'days_late',
              'supply_source',
              'supply_reference',
              'supply_date',
            ],
            rows.map((r) => [
              r.orderNumber,
              r.customerName,
              r.salespersonName,
              r.locationName,
              r.productName,
              r.sku,
              r.shortfall,
              r.deliveryDate,
              r.risk,
              r.daysLate,
              r.supplySource,
              r.supplyReference,
              r.supplyDate,
            ]),
          ),
      );
      return;
    }
    return report;
  }

  /**
   * Outstanding gift-card liability (catalog 76): every card still
   * carrying a balance, with the total the business owes. Cards are
   * business-wide (no location dimension), so store scope does not
   * apply; the figure is financial, so it sits behind
   * reports.financial.view.
   */
  @Get('gift-cards/liability')
  @RequirePermission('reports.financial.view')
  async giftCardLiability(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('includeExpired') includeExpiredStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<GiftCardLiability | void> {
    const includeExpired = includeExpiredStr === 'true';
    const statuses = includeExpired ? ['active', 'expired'] : ['active'];
    const rows = await this.db
      .select({
        code: schema.giftCards.code,
        status: schema.giftCards.status,
        customerName: sql<
          string | null
        >`nullif(trim(concat(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        issuedAt: schema.giftCards.createdAt,
        expiresAt: schema.giftCards.expiresAt,
        initialCents: schema.giftCards.initialBalanceCents,
        remainingCents: schema.giftCards.currentBalanceCents,
      })
      .from(schema.giftCards)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.giftCards.issuedForCustomerId))
      .where(
        and(
          inArray(schema.giftCards.status, statuses),
          sql`${schema.giftCards.currentBalanceCents} > 0`,
        ),
      )
      .orderBy(desc(schema.giftCards.currentBalanceCents));

    const out: GiftCardLiability = {
      generatedAt: new Date().toISOString(),
      includeExpired,
      cardCount: rows.length,
      outstandingCents: rows.reduce((a, r) => a + r.remainingCents, 0),
      rows: rows.map((r) => ({
        ...r,
        issuedAt: r.issuedAt.toISOString().slice(0, 10),
        expiresAt: r.expiresAt ? r.expiresAt.toISOString().slice(0, 10) : null,
      })),
    };
    if (format === 'csv') {
      requireExport(tenant);
      const header = `# includeExpired=${includeExpired} generated=${out.generatedAt}\n`;
      sendCsv(
        res!,
        `gift-card-liability-${new Date().toISOString().slice(0, 10)}.csv`,
        header +
          toCsv(
            ['code', 'status', 'customer', 'issued', 'expires', 'initial_cents', 'remaining_cents'],
            out.rows.map((r) => [
              r.code,
              r.status,
              r.customerName,
              r.issuedAt,
              r.expiresAt,
              r.initialCents,
              r.remainingCents,
            ]),
          ),
      );
      return;
    }
    return out;
  }

  /**
   * Delivery date changes (catalog 86 — Sales Reservation
   * Reassignments): the change log for delivery commitments, read from
   * the audit trail (schedule / update / cancel events), with the
   * before/after dates when the diff captured them.
   */
  @Get('delivery-date-changes')
  @RequirePermission('deliveries.view')
  async deliveryDateChanges(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('days') daysStr?: string,
  ): Promise<{ days: number; rows: DeliveryDateChangeRow[] }> {
    const days = Math.min(Math.max(Number(daysStr) || 30, 1), 365);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);

    const events = await this.db
      .select({
        at: schema.auditLogs.createdAt,
        action: schema.auditLogs.action,
        targetId: schema.auditLogs.targetId,
        changesJson: schema.auditLogs.changesJson,
        actorEmail: schema.users.email,
      })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(
        and(
          inArray(schema.auditLogs.action, [
            'delivery.schedule',
            'delivery.update',
            'delivery.cancel',
          ]),
          gte(schema.auditLogs.createdAt, since),
        ),
      )
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(500);

    const deliveryIds = [
      ...new Set(events.map((e) => e.targetId).filter((x): x is string => Boolean(x))),
    ];
    const orders = deliveryIds.length
      ? await this.db
          .select({ deliveryId: schema.deliveries.id, orderNumber: schema.orders.number })
          .from(schema.deliveries)
          .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
          .where(inArray(schema.deliveries.id, deliveryIds))
      : [];
    const orderBy = new Map(orders.map((o) => [o.deliveryId, o.orderNumber]));

    const rows: DeliveryDateChangeRow[] = events.map((e) => {
      const changes = (e.changesJson ?? {}) as {
        before?: { scheduledDate?: unknown };
        after?: { scheduledDate?: unknown };
      };
      const pick = (v: unknown) => (typeof v === 'string' ? v : null);
      return {
        at: e.at.toISOString(),
        action: e.action,
        deliveryId: e.targetId,
        orderNumber: e.targetId ? (orderBy.get(e.targetId) ?? null) : null,
        actorEmail: e.actorEmail,
        fromDate: pick(changes.before?.scheduledDate),
        toDate: pick(changes.after?.scheduledDate),
      };
    });
    // Only date-relevant events: keep rows where a date moved, appeared,
    // or the delivery was cancelled outright.
    const filtered = rows.filter((r) => r.action === 'delivery.cancel' || r.toDate || r.fromDate);
    return { days, rows: filtered };
  }

  /**
   * Summarized sales receipts (catalog 92): every succeeded payment in
   * the window, whatever document it landed on (POS sale, order
   * deposit/balance, service charge), grouped by payment method and the
   * taking location. Imported documents excluded (D8); store scope
   * applies. Nothing here purges — no DAILY.DETAIL retention trap.
   */
  @Get('receipts')
  @RequirePermission('reports.sales.view')
  async receipts(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<ReceiptsReport | void> {
    const { startDate, endDate } = parseRange(startStr, endStr);
    const startTs = new Date(`${startDate}T00:00:00.000Z`);
    const endTsExclusive = new Date(`${endDate}T00:00:00.000Z`);
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);

    const locExpr = sql<
      string | null
    >`COALESCE(${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`;
    const rows = await this.db
      .select({
        method: schema.payments.method,
        locationId: sql<string | null>`${locExpr}::text`,
        count: sql<number>`COUNT(*)::int`,
        amountCents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
      })
      .from(schema.payments)
      .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .leftJoin(schema.serviceOrders, eq(schema.serviceOrders.id, schema.payments.serviceOrderId))
      .where(
        and(
          gte(schema.payments.createdAt, startTs),
          lt(schema.payments.createdAt, endTsExclusive),
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.sales.importedAt),
          isNull(schema.orders.importedAt),
          isNull(schema.serviceOrders.importedAt),
          salesScopeCond(tenant, locExpr),
        ),
      )
      .groupBy(schema.payments.method, locExpr)
      .orderBy(desc(sql`COALESCE(SUM(${schema.payments.amountCents}), 0)`));

    const locIds = [...new Set(rows.map((r) => r.locationId).filter(Boolean))] as string[];
    const locs = locIds.length
      ? await this.db
          .select({ id: schema.locations.id, name: schema.locations.name })
          .from(schema.locations)
          .where(inArray(schema.locations.id, locIds))
      : [];
    const locBy = new Map(locs.map((l) => [l.id, l.name]));

    const report: ReceiptsReport = {
      start: startDate,
      end: endDate,
      generatedAt: new Date().toISOString(),
      rows: rows.map((r) => ({
        ...r,
        locationName: r.locationId ? (locBy.get(r.locationId) ?? null) : null,
      })),
      totals: {
        count: rows.reduce((a, r) => a + r.count, 0),
        amountCents: rows.reduce((a, r) => a + r.amountCents, 0),
      },
    };
    if (format === 'csv') {
      requireExport(tenant);
      const header = `# start=${startDate} end=${endDate} generated=${report.generatedAt}\n`;
      sendCsv(
        res!,
        `receipts-${startDate}-to-${endDate}.csv`,
        header +
          toCsv(
            ['method', 'location', 'count', 'amount_cents'],
            report.rows.map((r) => [r.method, r.locationName, r.count, r.amountCents]),
          ),
      );
      return;
    }
    return report;
  }

  /**
   * Merchandising activity — the buyer's report (catalog 67): per
   * variant, stock position, as-is and inbound quantities, sales
   * velocity (MTD/YTD units over completed documents), replacement cost
   * and markup. Rows with no stock, no supply, and no sales are dropped
   * unless includeNoActivity=true (the catalog's detail-line rule).
   * Cost-derived, so reports.financial.view.
   */
  @Get('merchandising')
  @RequirePermission('reports.financial.view')
  async merchandising(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('vendorId') vendorId?: string,
    @Query('categoryId') categoryId?: string,
    @Query('brandId') brandId?: string,
    @Query('includeNoActivity') includeNoActivityStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<MerchReport | void> {
    const includeNoActivity = includeNoActivityStr === 'true';
    const CAP = 2000;

    // A22.1: categories nest — filtering by "Mattresses" keeps the hybrids.
    const categoryIndex = await loadCategoryIndex(this.db, tenant.businessId!);
    const variants = await this.db
      .select({
        variantId: schema.productVariants.id,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        costCents: schema.productVariants.costCents,
        priceCents: schema.productVariants.priceCents,
        vendorName: schema.vendors.name,
        categoryId: schema.products.categoryId,
        categoryName: schema.categories.name,
        brandName: schema.brands.name,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.productVariants.preferredVendorId))
      .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .where(
        and(
          vendorId ? eq(schema.productVariants.preferredVendorId, vendorId) : undefined,
          categoryId
            ? inArray(schema.products.categoryId, categoryIndex.treeIds(categoryId))
            : undefined,
          brandId ? eq(schema.products.brandId, brandId) : undefined,
        ),
      );
    if (variants.length === 0) {
      return { generatedAt: new Date().toISOString(), truncated: false, rows: [] };
    }
    const ids = variants.map((v) => v.variantId);

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

    const [levels, asIs, onOrder, saleQty, orderQty] = await Promise.all([
      this.db
        .select({
          variantId: schema.inventoryLevels.variantId,
          onHand: sql<number>`COALESCE(SUM(${schema.inventoryLevels.onHand}), 0)::int`,
          reserved: sql<number>`COALESCE(SUM(${schema.inventoryLevels.reserved}), 0)::int`,
          floorSample: sql<number>`COALESCE(SUM(${schema.inventoryLevels.floorSample}), 0)::int`,
        })
        .from(schema.inventoryLevels)
        .where(inArray(schema.inventoryLevels.variantId, ids))
        .groupBy(schema.inventoryLevels.variantId),
      this.db
        .select({
          variantId: schema.asIsItems.variantId,
          qty: sql<number>`COALESCE(SUM(${schema.asIsItems.quantity}), 0)::int`,
        })
        .from(schema.asIsItems)
        .where(
          and(
            inArray(schema.asIsItems.variantId, ids),
            eq(schema.asIsItems.status, 'pending_review'),
          ),
        )
        .groupBy(schema.asIsItems.variantId),
      this.db
        .select({
          variantId: schema.purchaseOrderLines.variantId,
          qty: sql<number>`COALESCE(SUM(${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted}), 0)::int`,
        })
        .from(schema.purchaseOrderLines)
        .innerJoin(
          schema.purchaseOrders,
          eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
        )
        .where(
          and(
            inArray(schema.purchaseOrderLines.variantId, ids),
            sql`${schema.purchaseOrders.status} IN ('ordered', 'partially_received')`,
          ),
        )
        .groupBy(schema.purchaseOrderLines.variantId),
      this.db
        .select({
          variantId: schema.saleLines.variantId,
          mtd: sql<number>`COALESCE(SUM(${schema.saleLines.quantity}) FILTER (WHERE ${schema.sales.completedAt} >= ${monthStart.toISOString()}::timestamptz), 0)::int`,
          ytd: sql<number>`COALESCE(SUM(${schema.saleLines.quantity}) FILTER (WHERE ${schema.sales.completedAt} >= ${yearStart.toISOString()}::timestamptz), 0)::int`,
        })
        .from(schema.saleLines)
        .innerJoin(schema.sales, eq(schema.sales.id, schema.saleLines.saleId))
        .where(
          and(
            inArray(schema.saleLines.variantId, ids),
            sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
            isNull(schema.sales.importedAt),
            gte(schema.sales.completedAt, yearStart),
          ),
        )
        .groupBy(schema.saleLines.variantId),
      this.db
        .select({
          variantId: schema.orderLines.variantId,
          mtd: sql<number>`COALESCE(SUM(${schema.orderLines.quantity}) FILTER (WHERE ${schema.orders.completedAt} >= ${monthStart.toISOString()}::timestamptz), 0)::int`,
          ytd: sql<number>`COALESCE(SUM(${schema.orderLines.quantity}) FILTER (WHERE ${schema.orders.completedAt} >= ${yearStart.toISOString()}::timestamptz), 0)::int`,
        })
        .from(schema.orderLines)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
        .where(
          and(
            inArray(schema.orderLines.variantId, ids),
            eq(schema.orders.status, 'completed'),
            isNull(schema.orders.importedAt),
            gte(schema.orders.completedAt, yearStart),
          ),
        )
        .groupBy(schema.orderLines.variantId),
    ]);

    const levelBy = new Map(levels.map((l) => [l.variantId, l]));
    const asIsBy = new Map(asIs.map((a) => [a.variantId, a.qty]));
    const orderBy = new Map(onOrder.map((o) => [o.variantId, o.qty]));
    const soldBy = new Map<string, { mtd: number; ytd: number }>();
    for (const r of [...saleQty, ...orderQty]) {
      if (!r.variantId) continue;
      const cur = soldBy.get(r.variantId) ?? { mtd: 0, ytd: 0 };
      cur.mtd += r.mtd;
      cur.ytd += r.ytd;
      soldBy.set(r.variantId, cur);
    }

    let rows: MerchRow[] = variants.map((v) => {
      const lvl = levelBy.get(v.variantId);
      const sold = soldBy.get(v.variantId) ?? { mtd: 0, ytd: 0 };
      const onHand = lvl?.onHand ?? 0;
      const reserved = lvl?.reserved ?? 0;
      const floorSample = lvl?.floorSample ?? 0;
      const cost = v.costCents;
      return {
        variantId: v.variantId,
        productName: v.productName,
        variantName: v.variantName,
        sku: v.sku,
        vendorName: v.vendorName,
        categoryName: v.categoryName,
        categoryPath: categoryIndex.pathOf(v.categoryId),
        brandName: v.brandName,
        onHand,
        reserved,
        floorSample,
        netAvailable: Math.max(0, onHand - reserved - floorSample),
        asIsQty: asIsBy.get(v.variantId) ?? 0,
        onOrder: orderBy.get(v.variantId) ?? 0,
        soldMtd: sold.mtd,
        soldYtd: sold.ytd,
        costCents: cost,
        priceCents: v.priceCents,
        markupPct: cost && cost > 0 ? Math.round(((v.priceCents - cost) / cost) * 1000) / 10 : null,
      };
    });
    if (!includeNoActivity) {
      rows = rows.filter(
        (r) => r.onHand > 0 || r.asIsQty > 0 || r.onOrder > 0 || r.soldYtd > 0 || r.reserved > 0,
      );
    }
    rows.sort((a, b) => b.soldYtd - a.soldYtd || a.productName.localeCompare(b.productName));
    const truncated = rows.length > CAP;
    if (truncated) rows = rows.slice(0, CAP);

    const report: MerchReport = { generatedAt: new Date().toISOString(), truncated, rows };
    if (format === 'csv') {
      requireExport(tenant);
      const header = `# vendorId=${vendorId ?? ''} categoryId=${categoryId ?? ''} brandId=${brandId ?? ''} includeNoActivity=${includeNoActivity} truncated=${truncated} generated=${report.generatedAt}\n`;
      sendCsv(
        res!,
        `merchandising-${new Date().toISOString().slice(0, 10)}.csv`,
        header +
          toCsv(
            [
              'product',
              'variant',
              'sku',
              'vendor',
              'category',
              'brand',
              'on_hand',
              'reserved',
              'floor',
              'net_available',
              'as_is',
              'on_order',
              'sold_mtd',
              'sold_ytd',
              'cost_cents',
              'price_cents',
              'markup_pct',
            ],
            rows.map((r) => [
              r.productName,
              r.variantName,
              r.sku,
              r.vendorName,
              r.categoryPath ?? r.categoryName,
              r.brandName,
              r.onHand,
              r.reserved,
              r.floorSample,
              r.netAvailable,
              r.asIsQty,
              r.onOrder,
              r.soldMtd,
              r.soldYtd,
              r.costCents,
              r.priceCents,
              r.markupPct,
            ]),
          ),
      );
      return;
    }
    return report;
  }

  /**
   * Inventory adjustments (catalog 40): the movement ledger over a
   * window, grouped by reason with a detail list — a pure read (nothing
   * here is EOD-coupled or self-deleting). Store scope applies via the
   * movement's location.
   */
  @Get('inventory-adjustments')
  @RequirePermission('reports.inventory.view')
  async inventoryAdjustments(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('reason') reason?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<AdjustmentsReport | void> {
    const { startDate, endDate } = parseRange(startStr, endStr);
    const startTs = new Date(`${startDate}T00:00:00.000Z`);
    const endTsExclusive = new Date(`${endDate}T00:00:00.000Z`);
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);
    const CAP = 1000;

    const raw = await this.db
      .select({
        at: schema.inventoryMovements.createdAt,
        reason: schema.inventoryMovements.reason,
        delta: schema.inventoryMovements.delta,
        productName: schema.products.name,
        sku: schema.productVariants.sku,
        locationName: schema.locations.name,
        actorEmail: schema.users.email,
        notes: schema.inventoryMovements.notes,
        referenceType: schema.inventoryMovements.referenceType,
      })
      .from(schema.inventoryMovements)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.inventoryMovements.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.inventoryMovements.locationId))
      .leftJoin(schema.users, eq(schema.users.id, schema.inventoryMovements.actorUserId))
      .where(
        and(
          gte(schema.inventoryMovements.createdAt, startTs),
          lt(schema.inventoryMovements.createdAt, endTsExclusive),
          reason ? eq(schema.inventoryMovements.reason, reason) : undefined,
          salesScopeCond(tenant, schema.inventoryMovements.locationId),
        ),
      )
      .orderBy(desc(schema.inventoryMovements.createdAt))
      .limit(CAP + 1);
    const truncated = raw.length > CAP;
    const sliced = truncated ? raw.slice(0, CAP) : raw;

    const byReasonMap = new Map<
      string,
      { reason: string; movements: number; totalIn: number; totalOut: number }
    >();
    for (const r of sliced) {
      const cur = byReasonMap.get(r.reason) ?? {
        reason: r.reason,
        movements: 0,
        totalIn: 0,
        totalOut: 0,
      };
      cur.movements += 1;
      if (r.delta >= 0) cur.totalIn += r.delta;
      else cur.totalOut += -r.delta;
      byReasonMap.set(r.reason, cur);
    }

    const report: AdjustmentsReport = {
      start: startDate,
      end: endDate,
      generatedAt: new Date().toISOString(),
      truncated,
      byReason: [...byReasonMap.values()].sort((a, b) => b.movements - a.movements),
      rows: sliced.map((r) => ({ ...r, at: r.at.toISOString() })),
    };
    if (format === 'csv') {
      requireExport(tenant);
      const header = `# start=${startDate} end=${endDate} reason=${reason ?? ''} truncated=${truncated} generated=${report.generatedAt}\n`;
      sendCsv(
        res!,
        `inventory-adjustments-${startDate}-to-${endDate}.csv`,
        header +
          toCsv(
            ['at', 'reason', 'delta', 'product', 'sku', 'location', 'actor', 'reference', 'notes'],
            report.rows.map((r) => [
              r.at,
              r.reason,
              r.delta,
              r.productName,
              r.sku,
              r.locationName,
              r.actorEmail,
              r.referenceType,
              r.notes,
            ]),
          ),
      );
      return;
    }
    return report;
  }

  /**
   * Customer purchase history (catalog 42): completed POS sale lines +
   * completed order lines, one customer or all, as a view/CSV export.
   * Store scope applies.
   */
  @Get('customer-purchases')
  @RequirePermission('reports.sales.view')
  async customerPurchases(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('customerId') customerId?: string,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<{ rows: CustomerPurchaseRow[]; truncated: boolean } | void> {
    const { startDate, endDate } = parseRange(startStr, endStr);
    const startTs = new Date(`${startDate}T00:00:00.000Z`);
    const endTsExclusive = new Date(`${endDate}T00:00:00.000Z`);
    endTsExclusive.setUTCDate(endTsExclusive.getUTCDate() + 1);
    const CAP = 5000;

    const nameExpr = sql<
      string | null
    >`nullif(trim(concat(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`;
    const saleRows = await this.db
      .select({
        documentNumber: schema.sales.number,
        documentDate: schema.sales.completedAt,
        customerName: nameExpr,
        productName: sql<string>`COALESCE(${schema.products.name}, ${schema.saleLines.description})`,
        sku: schema.productVariants.sku,
        description: schema.saleLines.description,
        quantity: schema.saleLines.quantity,
        totalCents: schema.saleLines.totalCents,
      })
      .from(schema.saleLines)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.saleLines.saleId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.sales.customerId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.saleLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          gte(schema.sales.completedAt, startTs),
          lt(schema.sales.completedAt, endTsExclusive),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
          customerId ? eq(schema.sales.customerId, customerId) : undefined,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .limit(CAP + 1);
    const orderRows = await this.db
      .select({
        documentNumber: schema.orders.number,
        documentDate: schema.orders.completedAt,
        customerName: nameExpr,
        productName: sql<string>`COALESCE(${schema.products.name}, ${schema.orderLines.description})`,
        sku: schema.productVariants.sku,
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
        totalCents: schema.orderLines.totalCents,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          gte(schema.orders.completedAt, startTs),
          lt(schema.orders.completedAt, endTsExclusive),
          eq(schema.orders.status, 'completed'),
          customerId ? eq(schema.orders.customerId, customerId) : undefined,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .limit(CAP + 1);

    let rows: CustomerPurchaseRow[] = [
      ...saleRows.map((r) => ({
        documentType: 'sale' as const,
        documentNumber: r.documentNumber,
        documentDate: r.documentDate ? r.documentDate.toISOString().slice(0, 10) : '',
        customerName: r.customerName,
        productName: r.productName,
        sku: r.sku,
        description: r.description,
        quantity: r.quantity,
        totalCents: r.totalCents,
      })),
      ...orderRows.map((r) => ({
        documentType: 'order' as const,
        documentNumber: r.documentNumber,
        documentDate: r.documentDate ? r.documentDate.toISOString().slice(0, 10) : '',
        customerName: r.customerName,
        productName: r.productName,
        sku: r.sku,
        description: r.description,
        quantity: r.quantity,
        totalCents: r.totalCents,
      })),
    ].sort((a, b) => b.documentDate.localeCompare(a.documentDate));
    const truncated = rows.length > CAP;
    if (truncated) rows = rows.slice(0, CAP);

    if (format === 'csv') {
      requireExport(tenant);
      const header = `# customerId=${customerId ?? ''} start=${startDate} end=${endDate} truncated=${truncated} generated=${new Date().toISOString()}\n`;
      sendCsv(
        res!,
        `customer-purchases-${startDate}-to-${endDate}.csv`,
        header +
          toCsv(
            ['type', 'document', 'date', 'customer', 'product', 'sku', 'quantity', 'total_cents'],
            rows.map((r) => [
              r.documentType,
              r.documentNumber,
              r.documentDate,
              r.customerName,
              r.productName,
              r.sku,
              r.quantity,
              r.totalCents,
            ]),
          ),
      );
      return;
    }
    return { rows, truncated };
  }
}

function hasPermission(tenant: RequestTenantContext, permission: string): boolean {
  if (tenant.isSuperAdmin) return true;
  return tenant.permissions.has(permission as never);
}

function requireExport(tenant: RequestTenantContext): void {
  if (!hasPermission(tenant, 'reports.export')) {
    throw new ForbiddenException('reports.export permission required for CSV download');
  }
}

function parseRange(start?: string, end?: string): { startDate: string; endDate: string } {
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);
  const defaultStart = new Date(today);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 6);
  const isoStart = defaultStart.toISOString().slice(0, 10);
  return {
    startDate: matchesDate(start) ? start! : isoStart,
    endDate: matchesDate(end) ? end! : isoToday,
  };
}

function matchesDate(s: string | undefined): boolean {
  return Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));
}

function sendCsv(res: Response, filename: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}
