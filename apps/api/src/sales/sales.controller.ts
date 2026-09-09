import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { assertSellingScope, salesScopeCond } from '../common/sales-scope';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../costing/costing.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import {
  buildPage,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
  clampLimit as clampPageLimit,
} from '../common/pagination';
import { vendorMatchFor } from '../common/vendor-match';
import { DRIZZLE } from '../database/database.module';
import { CommissionsService } from '../money/commissions.service';
import { GiftCardsService } from '../gift-cards/gift-cards.service';
import { StoreCreditService } from '../returns/store-credit.service';
import { StripeService } from '../stripe/stripe.service';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';
import { computeTotals, reconstructOrderDiscountShares, refundUnitCents } from './totals';
import { PriceVarianceService } from '../controls/price-variance.service';
import type { OverrideCredentials } from '../controls/security-override.service';
import { parseDayRange, utcBounds } from '../common/date-range';

interface LookupRow {
  variantId: string;
  productId: string;
  productName: string;
  sku: string | null;
  barcode: string | null;
  variantName: string | null;
  priceCents: number;
}

interface PaymentInput {
  method?: 'cash' | 'card' | 'gift_card' | 'financing' | 'external_card' | 'check';
  /** For 'financing': which provider approved it (Synchrony, Acima, …). */
  financingProvider?: string;
  /** For 'financing': the provider's approval/application reference. */
  financingRef?: string;
  amountCents?: number;
  /** For 'card', the (test) processor reference; optional. */
  processorRef?: string;
  /**
   * For 'card', a Stripe PaymentMethod id (`pm_xxx`) collected on the
   * client via Stripe Elements. When present and the business has a
   * connected Stripe account, the backend charges this method on the
   * merchant's account before the sale is recorded. When absent, the
   * payment is recorded as a manual capture (legacy / dev mode).
   */
  stripePaymentMethodId?: string;
  /**
   * For 'gift_card', the human-typed code (case-insensitive). Server
   * validates state + balance, decrements, writes a gift_card_transactions
   * row that points back to this sale. The `processorRef` is set to the
   * gift card id so refunds can credit the same card.
   */
  giftCardCode?: string;
}

interface CartLineInput {
  variantId?: string;
  quantity?: number;
  /** Optional override; defaults to the variant's price. */
  unitPriceCents?: number;
  lineDiscountCents?: number;
}

interface CreateSaleBody {
  locationId?: string;
  customerId?: string | null;
  notes?: string | null;
  lines?: CartLineInput[];
  orderDiscountCents?: number;
  /**
   * Optional discount code. If supplied, the backend looks up the
   * code, validates active/window/usage/min-subtotal/per-customer
   * limits, computes the cents amount, and applies it as the order
   * discount. Cannot be combined with `orderDiscountCents`.
   */
  discountCode?: string;
  payments?: PaymentInput[];
  /**
   * G6 price-variance control, same shape the order endpoints take: a
   * coded reason for a tier-2 discount, and manager credentials when
   * the discount is tier 3 or below cost.
   */
  priceReasonCodeId?: string;
  priceReason?: string;
  override?: OverrideCredentials;
}

interface RefundLine {
  saleLineId?: string;
  quantity?: number;
}

interface RefundBody {
  reason?: string | null;
  lines?: RefundLine[];
  /**
   * §10: 'original' (default) reverses the original tenders;
   * 'store_credit' issues the amount to the customer's store-credit
   * ledger instead (requires the sale to have a customer).
   */
  refundMethod?: 'original' | 'store_credit';
}

interface SaleListRow {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  customerId: string | null;
  customerName: string | null;
  associateUserId: string | null;
  locationId: string;
  completedAt: Date | null;
  createdAt: Date;
}

interface SaleLineRow {
  id: string;
  variantId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  totalCents: number;
  refundedQuantity: number;
}

interface PaymentRow {
  id: string;
  method: string;
  amountCents: number;
  status: string;
  processor: string | null;
  processorRef: string | null;
  createdAt: Date;
}

interface RefundRow {
  id: string;
  amountCents: number;
  reason: string | null;
  createdAt: Date;
}

interface SaleDetail extends Omit<SaleListRow, 'customerName'> {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  notes: string | null;
  lines: SaleLineRow[];
  payments: PaymentRow[];
  refunds: RefundRow[];
}

/**
 * Mattress size and firmness, read off the catalog (owner ask
 * 2026-09-01: filter the Add Product popup by size and firmness). Most
 * of the catalog came from Shopify with the size and firmness inside the
 * product name, so the classifier looks at the variant's attributes
 * first and the product + variant names second. Order matters: "Twin XL"
 * before "Twin", "Cal King" before "King", "Medium Firm" before both
 * "Medium" and "Firm".
 */
export const MATTRESS_SIZES = [
  'Twin',
  'Twin XL',
  'Full',
  'Queen',
  'King',
  'Cal King',
  'Split King',
  'Split Cal King',
] as const;
export const FIRMNESS_LEVELS = ['Plush', 'Medium', 'Medium Firm', 'Firm', 'Extra Firm'] as const;

const NAME_HAY = sql`(coalesce(${schema.productVariants.attributesJson}->>'size', '') || ' ' || coalesce(${schema.productVariants.attributesJson}->>'firmness', '') || ' ' || coalesce(${schema.products.name}, '') || ' ' || coalesce(${schema.productVariants.name}, ''))`;

const SIZE_EXPR = sql`CASE
  WHEN ${NAME_HAY} ~* '\\m(split\\s+cal(ifornia)?\\.?\\s+king)\\M' THEN 'Split Cal King'
  WHEN ${NAME_HAY} ~* '\\m(split\\s+king)\\M' THEN 'Split King'
  WHEN ${NAME_HAY} ~* '\\m(cal(ifornia)?\\.?\\s+king)\\M' THEN 'Cal King'
  WHEN ${NAME_HAY} ~* '\\mking\\M' THEN 'King'
  WHEN ${NAME_HAY} ~* '\\mqueen\\M' THEN 'Queen'
  WHEN ${NAME_HAY} ~* '\\m(full|double)\\M' THEN 'Full'
  WHEN ${NAME_HAY} ~* '\\m(twin\\s*x-?l|txl)\\M' THEN 'Twin XL'
  WHEN ${NAME_HAY} ~* '\\mtwin\\M' THEN 'Twin'
  ELSE NULL END`;

const FIRMNESS_EXPR = sql`CASE
  WHEN ${NAME_HAY} ~* '\\m(extra\\s+firm|x-?firm|ultra\\s+firm)\\M' THEN 'Extra Firm'
  WHEN ${NAME_HAY} ~* '\\m(medium\\s+firm|med\\.?\\s+firm|luxury\\s+firm|cushion\\s+firm|plush\\s+firm)\\M' THEN 'Medium Firm'
  WHEN ${NAME_HAY} ~* '\\mfirm\\M' THEN 'Firm'
  WHEN ${NAME_HAY} ~* '\\m(medium|med\\.?)\\M' THEN 'Medium'
  WHEN ${NAME_HAY} ~* '\\m(plush|soft|ultra\\s+plush)\\M' THEN 'Plush'
  ELSE NULL END`;

@TenantScoped()
@Controller('v1')
export class SalesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StripeService) private readonly stripe: StripeService,
    @Inject(GiftCardsService) private readonly giftCards: GiftCardsService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
    @Inject(CommissionsService) private readonly commissions: CommissionsService,
    @Inject(StoreCreditService) private readonly storeCredit: StoreCreditService,
    @Inject(PriceVarianceService) private readonly priceVariance: PriceVarianceService,
    @Inject(CostingService) private readonly costing: CostingService,
  ) {}

  /**
   * Variant lookup for the POS register. Matches an exact barcode first
   * (so a scan auto-resolves), then falls back to product name / SKU
   * substring search. Returns active variants only.
   */
  /**
   * New Sale product popup (PLAN-POS-OPERATIONS §4): searchable, vendor-
   * filterable results carrying live stock at the selling location plus
   * everywhere, and — when a variant is out of stock — the ATP date: the
   * earliest expected date among open POs that still owe units of it.
   */
  @Get('pos/product-search')
  @RequirePermission('pos.access')
  async productSearch(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('q') q?: string,
    @Query('vendorId') vendorId?: string,
    @Query('inStock') inStock?: string,
    @Query('locationId') locationId?: string,
    @Query('limit') limitStr?: string,
    @Query('variantIds') variantIdsStr?: string,
    @Query('size') size?: string,
    @Query('firmness') firmness?: string,
  ): Promise<
    {
      variantId: string;
      productId: string;
      productName: string;
      variantName: string | null;
      sku: string | null;
      priceCents: number;
      vendorId: string | null;
      vendorName: string | null;
      /** Canonical mattress size read off the name/attributes, or null. */
      size: string | null;
      /** Canonical firmness read off the name/attributes, or null. */
      firmness: string | null;
      availableHere: number;
      availableTotal: number;
      atpDate: string | null;
      /**
       * The product's own tax rate at the selling location (tax class
       * override for `locationId`, else the class fallback), or null when
       * the product has no tax class and the store rate applies. 0 means
       * the line is untaxed (owner 2026-09-06: installation is a service).
       */
      taxRateBps: number | null;
    }[]
  > {
    const query = (q ?? '').trim();
    const limit = clampLimit(limitStr, 30);
    const filters = [eq(schema.productVariants.isActive, true), eq(schema.products.isActive, true)];
    if (query) {
      filters.push(
        sql`(${schema.products.name} ILIKE ${'%' + query + '%'} OR ${schema.productVariants.name} ILIKE ${'%' + query + '%'} OR ${schema.productVariants.sku} ILIKE ${'%' + query + '%'})`,
      );
    }
    // Vendor (owner ask 2026-09-01): imported catalogs rarely carry a
    // preferred vendor on the variant, so the filter also accepts the
    // product's brand or the vendor's name inside the product name
    // ("Twin Helix Dusk …" for vendor Helix).
    if (vendorId) filters.push(await vendorMatchFor(this.db, tenant.businessId!, vendorId));
    // Size / firmness are read off what the catalog actually says —
    // attributes when a variant has them, else the product and variant
    // names — so Shopify-shaped "Queen Helix Dusk 12\" Medium Firm …"
    // products filter as well as hand-built ones.
    if (size) {
      const canonical = MATTRESS_SIZES.find((x) => x.toLowerCase() === size.trim().toLowerCase());
      if (!canonical)
        throw new BadRequestException(`size must be one of: ${MATTRESS_SIZES.join(', ')}`);
      filters.push(sql`${SIZE_EXPR} = ${canonical}`);
    }
    if (firmness) {
      const canonical = FIRMNESS_LEVELS.find(
        (x) => x.toLowerCase() === firmness.trim().toLowerCase(),
      );
      if (!canonical) {
        throw new BadRequestException(`firmness must be one of: ${FIRMNESS_LEVELS.join(', ')}`);
      }
      filters.push(sql`${FIRMNESS_EXPR} = ${canonical}`);
    }
    // BA-0021: reopened drafts re-check availability for their exact
    // variants, so stock warnings survive the round trip.
    const variantIds = (variantIdsStr ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    if (variantIds.length > 0) filters.push(inArray(schema.productVariants.id, variantIds));

    const rows = await this.db
      .select({
        variantId: schema.productVariants.id,
        productId: schema.products.id,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        priceCents: schema.productVariants.priceCents,
        vendorId: schema.productVariants.preferredVendorId,
        vendorName: schema.vendors.name,
        size: sql<string | null>`${SIZE_EXPR}`,
        firmness: sql<string | null>`${FIRMNESS_EXPR}`,
        taxRateBps: sql<number | null>`coalesce(
          ${
            locationId
              ? sql`(SELECT r.rate_bps FROM tax_class_rates r WHERE r.tax_class_id = ${schema.products.taxClassId} AND r.location_id = ${locationId} LIMIT 1)`
              : sql`NULL::int`
          },
          (SELECT c.rate_bps FROM tax_classes c WHERE c.id = ${schema.products.taxClassId})
        )::int`,
        availableHere: locationId
          ? sql<number>`coalesce(sum(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample}) FILTER (WHERE ${schema.inventoryLevels.locationId} = ${locationId}), 0)::int`
          : sql<number>`0`,
        availableTotal: sql<number>`coalesce(sum(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample}), 0)::int`,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.productVariants.preferredVendorId))
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .leftJoin(
        schema.inventoryLevels,
        eq(schema.inventoryLevels.variantId, schema.productVariants.id),
      )
      .where(and(...filters))
      .groupBy(
        schema.productVariants.id,
        schema.products.id,
        schema.vendors.name,
        schema.brands.name,
      )
      .having(
        inStock === '1'
          ? sql`coalesce(sum(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample}), 0) > 0`
          : inStock === '0'
            ? sql`coalesce(sum(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample}), 0) <= 0`
            : sql`true`,
      )
      .orderBy(schema.products.name)
      .limit(limit);

    // ATP only matters for the out-of-stock rows the popup is warning about.
    const outIds = rows.filter((r) => r.availableTotal <= 0).map((r) => r.variantId);
    const atp = new Map<string, string>();
    if (outIds.length > 0) {
      const pos = await this.db
        .select({
          variantId: schema.purchaseOrderLines.variantId,
          expectedAt: sql<string | null>`min(${schema.purchaseOrders.expectedAt})::text`,
        })
        .from(schema.purchaseOrderLines)
        .innerJoin(
          schema.purchaseOrders,
          eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
        )
        .where(
          and(
            inArray(schema.purchaseOrderLines.variantId, outIds),
            inArray(schema.purchaseOrders.status, ['draft', 'ordered', 'partially_received']),
            sql`${schema.purchaseOrderLines.quantityOrdered} > ${schema.purchaseOrderLines.quantityReceived}`,
            sql`${schema.purchaseOrders.expectedAt} IS NOT NULL`,
          ),
        )
        .groupBy(schema.purchaseOrderLines.variantId);
      for (const r of pos) if (r.variantId && r.expectedAt) atp.set(r.variantId, r.expectedAt);
    }

    return rows.map((r) => ({ ...r, atpDate: atp.get(r.variantId) ?? null }));
  }

  @Get('pos/lookup')
  @RequirePermission('pos.access')
  async lookup(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('q') q?: string,
    @Query('limit') limitStr?: string,
  ): Promise<LookupRow[]> {
    const query = (q ?? '').trim();
    if (!query) return [];
    const limit = clampLimit(limitStr, 25);

    // Exact barcode hit first — when the cashier scans, this is the
    // expected single-row result.
    const barcodeRows = await this.db
      .select({
        variantId: schema.productVariants.id,
        productId: schema.products.id,
        productName: schema.products.name,
        sku: schema.productVariants.sku,
        barcode: schema.productVariants.barcode,
        variantName: schema.productVariants.name,
        priceCents: schema.productVariants.priceCents,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.productVariants.barcode, query),
          eq(schema.productVariants.isActive, true),
          eq(schema.products.isActive, true),
        ),
      )
      .limit(limit);
    if (barcodeRows.length > 0) return barcodeRows;

    // Otherwise, ILIKE on name + SKU. We don't use the products
    // tsvector here because POS lookups are partial-prefix patterns
    // ("coke") and tsvector lemmatization could miss exact substrings.
    const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
    return this.db
      .select({
        variantId: schema.productVariants.id,
        productId: schema.products.id,
        productName: schema.products.name,
        sku: schema.productVariants.sku,
        barcode: schema.productVariants.barcode,
        variantName: schema.productVariants.name,
        priceCents: schema.productVariants.priceCents,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.productVariants.isActive, true),
          eq(schema.products.isActive, true),
          sql`(${schema.products.name} ILIKE ${pattern} OR ${schema.productVariants.sku} ILIKE ${pattern})`,
        ),
      )
      .limit(limit);
  }

  /**
   * Lightweight location list for the POS register. Anyone with
   * `pos.access` can see active locations + their tax rates without
   * needing `locations.view` (which is reserved for the back-office
   * locations admin page).
   *
   * `taxRateBps` is the EFFECTIVE rate — a location with no rate of its
   * own inherits `businesses.default_tax_rate_bps` (levels 3→4 of the
   * tax-resolution ladder in schema/taxes.ts), matching what the server
   * charges when the order is written. Returning the raw null here made
   * New Sale display 0.00% while the written order taxed correctly.
   */
  @Get('pos/locations')
  @RequirePermission('pos.access')
  async posLocations(
    @CurrentTenant() tenant: RequestTenantContext,
  ): Promise<
    { id: string; name: string; taxRateBps: number; locationType: string; canSellHere: boolean }[]
  > {
    const [biz] = await this.db
      .select({ defaultTaxRateBps: schema.businesses.defaultTaxRateBps })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    const rows = await this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        taxRateBps: schema.locations.taxRateBps,
        locationType: schema.locations.locationType,
      })
      .from(schema.locations)
      .where(eq(schema.locations.isActive, true))
      .orderBy(schema.locations.name);
    // Owner amendment 2026-08-30: every location comes back — members see
    // and SOURCE inventory from anywhere. `canSellHere` marks where this
    // member may actually ring the sale (the server still enforces it at
    // write time); the register filters its selling-location picker by it.
    const scopeIds =
      tenant.sellingScope === 'approved' ? new Set(tenant.scopeLocationIds ?? []) : null;
    return rows.map((r) => ({
      ...r,
      taxRateBps: r.taxRateBps ?? biz?.defaultTaxRateBps ?? 0,
      canSellHere: !scopeIds || scopeIds.has(r.id),
    }));
  }

  /**
   * List/search sales. `q` is the invoice-lookup path (the top clerk flow):
   * it matches the document number as a case-insensitive substring — a
   * scanned receipt barcode types the full number and hits exactly — or
   * the customer via the tsvector, and it composes with the cursor so a
   * broad match still pages newest-first.
   */
  @Get('sales')
  @RequirePermission('sales.view')
  async list(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('q') q?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
    @Query('associateUserId') associateUserId?: string,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
  ): Promise<PageResponse<SaleListRow>> {
    const limit = clampPageLimit(limitStr);
    const cursor = decodeCursor(cursorStr);
    const window = parseDayRange(startQ, endQ);
    const bounds = window ? utcBounds(window) : null;
    const filters: (ReturnType<typeof and> | undefined)[] = [
      cursor ? timestampCursorWhere(schema.sales.createdAt, schema.sales.id, cursor) : undefined,
      salesScopeCond(tenant, schema.sales.locationId),
      associateUserId ? eq(schema.sales.associateUserId, associateUserId) : undefined,
      bounds ? gte(schema.sales.createdAt, bounds.from) : undefined,
      bounds ? lt(schema.sales.createdAt, bounds.toExclusive) : undefined,
    ];
    const query = q?.trim();
    if (query) {
      const tsq = sql`websearch_to_tsquery('simple', ${query})`;
      filters.push(
        or(
          ilike(schema.sales.number, `%${query.replace(/[%_]/g, '\\$&')}%`),
          sql`${schema.customers.searchTsv} @@ ${tsq}`,
        )!,
      );
    }
    const rows = await this.db
      .select({
        id: schema.sales.id,
        number: schema.sales.number,
        status: schema.sales.status,
        totalCents: schema.sales.totalCents,
        customerId: schema.sales.customerId,
        customerName: sql<
          string | null
        >`nullif(trim(concat(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        associateUserId: schema.sales.associateUserId,
        locationId: schema.sales.locationId,
        completedAt: schema.sales.completedAt,
        createdAt: schema.sales.createdAt,
      })
      .from(schema.sales)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.sales.customerId))
      .where(and(...filters.filter(Boolean)))
      .orderBy(...timestampCursorOrder(schema.sales.createdAt, schema.sales.id))
      .limit(limit + 1);
    return buildPage(rows, limit, (r) => r.createdAt);
  }

  @Get('sales/:id')
  @RequirePermission('sales.view')
  async get(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<SaleDetail> {
    const [sale] = await this.db
      .select()
      .from(schema.sales)
      .where(eq(schema.sales.id, id))
      .limit(1);
    if (!sale) throw new NotFoundException('Sale not found');

    const lines = await this.db
      .select()
      .from(schema.saleLines)
      .where(eq(schema.saleLines.saleId, id));

    const refundedByLine = await this.db
      .select({
        saleLineId: schema.refundLines.saleLineId,
        quantity: sql<number>`COALESCE(SUM(${schema.refundLines.quantity}), 0)::int`,
      })
      .from(schema.refundLines)
      .innerJoin(schema.refunds, eq(schema.refunds.id, schema.refundLines.refundId))
      .where(eq(schema.refunds.saleId, id))
      .groupBy(schema.refundLines.saleLineId);
    const refundedMap = new Map(refundedByLine.map((r) => [r.saleLineId, r.quantity]));

    const payments = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.saleId, id))
      .orderBy(schema.payments.createdAt);

    const refunds = await this.db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.saleId, id))
      .orderBy(desc(schema.refunds.createdAt));

    return {
      id: sale.id,
      number: sale.number,
      status: sale.status,
      totalCents: sale.totalCents,
      subtotalCents: sale.subtotalCents,
      discountCents: sale.discountCents,
      taxCents: sale.taxCents,
      customerId: sale.customerId,
      associateUserId: sale.associateUserId,
      locationId: sale.locationId,
      notes: sale.notes,
      completedAt: sale.completedAt,
      createdAt: sale.createdAt,
      lines: lines.map((l) => ({
        id: l.id,
        variantId: l.variantId,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents,
        totalCents: l.totalCents,
        refundedQuantity: refundedMap.get(l.id) ?? 0,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        method: p.method,
        amountCents: p.amountCents,
        status: p.status,
        processor: p.processor,
        processorRef: p.processorRef,
        createdAt: p.createdAt,
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        amountCents: r.amountCents,
        reason: r.reason,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * Complete a sale in one shot. The whole thing runs inside the
   * request's RLS transaction, so a failure mid-way (e.g. a payment
   * row insert failing) rolls everything back including the inventory
   * decrement.
   */
  @Post('sales')
  @RequirePermission('pos.transaction.create')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: CreateSaleBody,
  ): Promise<SaleDetail> {
    if (!body.locationId) throw new BadRequestException('locationId is required');
    assertSellingScope(tenant, body.locationId);
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must contain at least one entry');
    }
    if (!body.payments || body.payments.length === 0) {
      throw new BadRequestException('payments must contain at least one entry');
    }

    // Resolve location + tax rate.
    const [location] = await this.db
      .select({
        id: schema.locations.id,
        taxRateBps: schema.locations.taxRateBps,
      })
      .from(schema.locations)
      .where(eq(schema.locations.id, body.locationId))
      .limit(1);
    if (!location) throw new NotFoundException('Location not found');

    let taxRateBps = location.taxRateBps;
    if (taxRateBps == null) {
      const [biz] = await this.db
        .select({ defaultTaxRateBps: schema.businesses.defaultTaxRateBps })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, tenant.businessId!))
        .limit(1);
      taxRateBps = biz?.defaultTaxRateBps ?? 0;
    }

    // Resolve every variant in one go.
    const variantIds = body.lines.map((l) => {
      if (!l.variantId) throw new BadRequestException('lines[].variantId is required');
      return l.variantId;
    });
    const variants = await this.db
      .select({
        id: schema.productVariants.id,
        productId: schema.productVariants.productId,
        sku: schema.productVariants.sku,
        priceCents: schema.productVariants.priceCents,
        // Needed by the G6 variance gate to spot a below-cost sale.
        costCents: schema.productVariants.costCents,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        // The product's tax class id (may be null). The resolved rate
        // is computed below — first the per-location override, then
        // the class's fallback, then location/business defaults.
        taxClassId: schema.products.taxClassId,
        taxClassFallbackRateBps: schema.taxClasses.rateBps,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.taxClasses, eq(schema.taxClasses.id, schema.products.taxClassId))
      .where(inArray(schema.productVariants.id, variantIds));
    const byId = new Map(variants.map((v) => [v.id, v]));
    for (const id of variantIds) {
      if (!byId.has(id)) throw new NotFoundException(`Variant not found: ${id}`);
    }

    // Phase 2.18: resolve per-location overrides for any tax class
    // that's actually referenced on a line. Doing this in one query
    // (one IN list) keeps the round-trip count constant regardless of
    // how many distinct classes appear in the cart.
    const taxClassIds = Array.from(
      new Set(variants.map((v) => v.taxClassId).filter((id): id is string => Boolean(id))),
    );
    const overrideMap = new Map<string, number>();
    if (taxClassIds.length > 0) {
      const overrides = await this.db
        .select({
          taxClassId: schema.taxClassRates.taxClassId,
          rateBps: schema.taxClassRates.rateBps,
        })
        .from(schema.taxClassRates)
        .where(
          and(
            inArray(schema.taxClassRates.taxClassId, taxClassIds),
            eq(schema.taxClassRates.locationId, body.locationId),
          ),
        );
      for (const o of overrides) overrideMap.set(o.taxClassId, o.rateBps);
    }

    // Resolve a discount code if one was supplied. We compute the
    // cents amount up-front and pass it to computeTotals as the
    // order discount; the redemption row + usage increment land
    // after the sale is durable so a failed insert never burns a
    // code's remaining usage.
    let resolvedOrderDiscount = body.orderDiscountCents;
    let appliedDiscount: { id: string; amountCents: number } | null = null;
    if (body.discountCode) {
      if (body.orderDiscountCents) {
        throw new BadRequestException('cannot supply both discountCode and orderDiscountCents');
      }
      const codeText = body.discountCode.trim();
      if (!codeText) throw new BadRequestException('discountCode cannot be empty');

      const [code] = await this.db
        .select()
        .from(schema.discountCodes)
        .where(eq(schema.discountCodes.code, codeText))
        .limit(1);
      if (!code) throw new NotFoundException(`Discount code "${codeText}" not found`);
      if (!code.isActive) throw new BadRequestException('Discount code is inactive');
      const now = new Date();
      if (code.startsAt && code.startsAt.getTime() > now.getTime()) {
        throw new BadRequestException('Discount code is not yet valid');
      }
      if (code.endsAt && code.endsAt.getTime() < now.getTime()) {
        throw new BadRequestException('Discount code has expired');
      }
      if (code.usageLimit != null && code.usageCount >= code.usageLimit) {
        throw new BadRequestException('Discount code has reached its usage limit');
      }

      // Compute post-line-discount subtotal locally — it's what the
      // discount applies against. Mirrors the math in computeTotals.
      let postLineNet = 0;
      for (const l of body.lines) {
        const v = byId.get(l.variantId!)!;
        const unit = l.unitPriceCents ?? v.priceCents;
        const gross = l.quantity! * unit;
        const lineDisc = Math.min(l.lineDiscountCents ?? 0, gross);
        postLineNet += gross - lineDisc;
      }

      if (code.minSubtotalCents != null && postLineNet < code.minSubtotalCents) {
        throw new BadRequestException(
          `Discount code requires a subtotal of at least $${(code.minSubtotalCents / 100).toFixed(
            2,
          )}`,
        );
      }
      if (code.perCustomerLimit != null) {
        if (!body.customerId) {
          throw new BadRequestException(
            'Discount code requires an attached customer to enforce its per-customer limit',
          );
        }
        const prior = await this.db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(schema.discountRedemptions)
          .where(
            and(
              eq(schema.discountRedemptions.discountCodeId, code.id),
              eq(schema.discountRedemptions.customerId, body.customerId),
            ),
          );
        const used = prior[0]?.count ?? 0;
        if (used >= code.perCustomerLimit) {
          throw new BadRequestException(
            'Customer has reached the per-customer limit for this discount code',
          );
        }
      }

      const computedCents =
        code.kind === 'percent' ? Math.floor((postLineNet * code.value) / 10000) : code.value;
      resolvedOrderDiscount = Math.min(computedCents, postLineNet);
      appliedDiscount = { id: code.id, amountCents: resolvedOrderDiscount };
    }

    // Compute totals via the pure helper. Throws BadRequest on bad shape.
    const totals = (() => {
      try {
        return computeTotals({
          taxRateBps: taxRateBps!,
          orderDiscountCents: resolvedOrderDiscount,
          lines: body.lines.map((l) => {
            const v = byId.get(l.variantId!)!;
            const desc = [v.productName, v.variantName].filter(Boolean).join(' — ');
            return {
              variantId: v.id,
              description: desc,
              quantity: l.quantity!,
              unitPriceCents: l.unitPriceCents ?? v.priceCents,
              lineDiscountCents: l.lineDiscountCents,
              // Tax-class override; falls through to the sale-level
              // taxRateBps inside computeTotals when this is null.
              // Resolution order: per-location override → class
              // fallback → undefined (defers to location/business
              // default inside computeTotals).
              taxRateBps:
                (v.taxClassId ? overrideMap.get(v.taxClassId) : undefined) ??
                v.taxClassFallbackRateBps ??
                undefined,
            };
          }),
        });
      } catch (e) {
        throw new BadRequestException(e instanceof Error ? e.message : String(e));
      }
    })();

    // G6 price variance — the register discounts money exactly like an
    // order does, so it passes through exactly the same gate. Missed
    // originally, which left the till side wide open: a 30% discount
    // rang straight through to cash with no reason, no authorization
    // and no exception (QA 2026-08-26, D2). New Sale's fully-paid
    // take-with fast lane posts here too, so this closes that as well.
    // Runs before any tender is touched.
    await this.priceVariance.enforce(
      tenant.businessId!,
      body.lines.map((l) => {
        const v = byId.get(l.variantId!)!;
        return {
          quantity: l.quantity!,
          unitPriceCents: l.unitPriceCents ?? v.priceCents,
          lineDiscountCents: l.lineDiscountCents ?? 0,
          lineType: 'stock',
          listPriceCents: v.priceCents,
          costCents: v.costCents ?? null,
          description: [v.productName, v.variantName].filter(Boolean).join(' — '),
        };
      }),
      // A discount CODE is a pre-authorized instrument — someone with
      // `discounts.manage` created it with its own limits — so it is not
      // associate discretion and does not need a reason at the till.
      // Only an ad-hoc cart discount goes through the gate. (Line-level
      // discounts always do, above.)
      appliedDiscount ? 0 : (resolvedOrderDiscount ?? 0),
      body,
      { action: 'Register sale discount' },
    );

    // Validate payments cover the total exactly.
    const paymentSum = body.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
    if (paymentSum !== totals.totalCents) {
      throw new BadRequestException(
        `payments sum (${paymentSum}) must equal total (${totals.totalCents})`,
      );
    }
    for (const p of body.payments) {
      const METHODS = ['cash', 'card', 'gift_card', 'financing', 'external_card', 'check'];
      if (!METHODS.includes(p.method ?? '')) {
        throw new BadRequestException(`payments[].method must be one of: ${METHODS.join(', ')}`);
      }
      if (p.method === 'financing' && !p.financingProvider) {
        throw new BadRequestException('financing payments need financingProvider');
      }
      if (
        typeof p.amountCents !== 'number' ||
        !Number.isInteger(p.amountCents) ||
        p.amountCents <= 0
      ) {
        throw new BadRequestException('payments[].amountCents must be a positive integer');
      }
      if (p.method === 'gift_card' && (!p.giftCardCode || p.giftCardCode.trim().length === 0)) {
        throw new BadRequestException('gift_card payments must include giftCardCode');
      }
    }

    // Pre-validate every gift card up front: the cashier should hear
    // "card has $3.00, you tried to spend $5.00" *before* we touch
    // Stripe or write any rows. We resolve the cards once here and
    // reuse the resolved ids when actually charging post-sale-insert.
    const giftCardResolved = new Map<number, { id: string; balanceBefore: number }>();
    for (let i = 0; i < body.payments.length; i++) {
      const p = body.payments[i]!;
      if (p.method !== 'gift_card') continue;
      const card = await this.giftCards.findByCode(this.db, tenant.businessId!, p.giftCardCode!);
      if (!card) throw new BadRequestException(`Gift card ${p.giftCardCode} not found.`);
      if (card.status !== 'active') {
        throw new BadRequestException(`Gift card is ${card.status}.`);
      }
      if (card.expiresAt && card.expiresAt < new Date()) {
        throw new BadRequestException('Gift card has expired.');
      }
      if (card.currentBalanceCents < p.amountCents!) {
        throw new BadRequestException(
          `Gift card balance is ${card.currentBalanceCents} cents; cannot charge ${p.amountCents}.`,
        );
      }
      giftCardResolved.set(i, { id: card.id, balanceBefore: card.currentBalanceCents });
    }

    // For card payments that supply a Stripe PaymentMethod id, charge
    // the merchant's connected Stripe account BEFORE writing the sale.
    // If any charge fails, no sale row is written. If a card line has
    // no `stripePaymentMethodId`, fall back to the manual capture path
    // (used in dev/test or by businesses that haven't connected
    // Stripe).
    const cardPayments = body.payments.filter((p) => p.method === 'card');
    const stripeCardPayments = cardPayments.filter((p) => Boolean(p.stripePaymentMethodId));
    let merchantStripeAccountId: string | null = null;
    if (stripeCardPayments.length > 0) {
      const [merchant] = await this.db
        .select({
          stripeAccountId: schema.merchantStripeAccounts.stripeAccountId,
          chargesEnabled: schema.merchantStripeAccounts.chargesEnabled,
          disconnectedAt: schema.merchantStripeAccounts.disconnectedAt,
        })
        .from(schema.merchantStripeAccounts)
        .where(eq(schema.merchantStripeAccounts.businessId, tenant.businessId!))
        .limit(1);
      if (!merchant || merchant.disconnectedAt) {
        throw new BadRequestException(
          'Stripe is not connected for this business. Connect via Settings → Billing.',
        );
      }
      if (!merchant.chargesEnabled) {
        throw new BadRequestException(
          'Connected Stripe account cannot accept charges yet. Finish onboarding in Stripe.',
        );
      }
      merchantStripeAccountId = merchant.stripeAccountId;
    }

    const chargeResults: Map<number, { paymentIntentId: string }> = new Map();
    if (merchantStripeAccountId) {
      for (let i = 0; i < body.payments.length; i++) {
        const p = body.payments[i]!;
        if (p.method !== 'card' || !p.stripePaymentMethodId) continue;
        const charge = await this.stripe.chargeCard({
          stripeAccountId: merchantStripeAccountId,
          amountCents: p.amountCents!,
          currency: 'usd',
          paymentMethodId: p.stripePaymentMethodId,
          description: `Sale at ${tenant.businessId!.slice(0, 8)}`,
          metadata: { businessId: tenant.businessId!, locationId: body.locationId },
        });
        if (charge.status !== 'succeeded') {
          throw new BadRequestException(
            `Card payment ${i} failed: status ${charge.status}. The sale was not recorded.`,
          );
        }
        chargeResults.set(i, { paymentIntentId: charge.paymentIntentId });
      }
    }

    // Generate a sale number with retry on uniqueness conflicts.
    const number = await this.generateSaleNumber(tenant.businessId!);

    // Insert the sale row.
    const [sale] = await this.db
      .insert(schema.sales)
      .values({
        businessId: tenant.businessId!,
        locationId: body.locationId,
        number,
        status: 'completed',
        customerId: body.customerId ?? null,
        // Null when the request was authenticated by an API key — no
        // human cashier is on the receipt.
        associateUserId: actor?.id ?? null,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        notes: body.notes ?? null,
        completedAt: new Date(),
      })
      .returning();
    if (!sale) throw new BadRequestException('failed to create sale');

    // Sale lines.
    const insertedLines = await this.db
      .insert(schema.saleLines)
      .values(
        totals.lines.map((l) => ({
          businessId: tenant.businessId!,
          saleId: sale.id,
          variantId: l.variantId,
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          discountCents: l.discountCents,
          orderDiscountShareCents: l.orderDiscountShareCents,
          taxCents: l.taxCents,
          totalCents: l.totalCents,
        })),
      )
      .returning();

    // Charge each gift_card payment now that the sale exists. Pre-
    // validation already confirmed balance + status; if anything has
    // shifted since (race with another redemption) the service throws
    // and the surrounding tx behavior is the same as a Stripe failure
    // mid-flight — partial state, surfaced to the caller.
    const giftCardChargeResults = new Map<number, string>();
    for (let i = 0; i < body.payments.length; i++) {
      const p = body.payments[i]!;
      if (p.method !== 'gift_card') continue;
      const result = await this.giftCards.charge(this.db, tenant.businessId!, {
        code: p.giftCardCode!,
        amountCents: p.amountCents!,
        saleId: sale.id,
        actorUserId: actor?.id ?? null,
      });
      giftCardChargeResults.set(i, result.giftCardId);
    }

    // Payments. Card payments charged via Stripe carry the
    // PaymentIntent id in `processor_ref`; legacy/manual cards keep
    // their processor='manual' identity. Gift-card payments carry the
    // gift card's id in `processor_ref` so refund flow can credit
    // back to the same card.
    const insertedPayments = await this.db
      .insert(schema.payments)
      .values(
        body.payments.map((p, i) => {
          const charge = chargeResults.get(i);
          const gcId = giftCardChargeResults.get(i);
          return {
            businessId: tenant.businessId!,
            saleId: sale.id,
            method: p.method!,
            amountCents: p.amountCents!,
            processor:
              p.method === 'card'
                ? charge
                  ? 'stripe'
                  : 'manual'
                : p.method === 'gift_card'
                  ? 'gift_card'
                  : null,
            processorRef: gcId ?? charge?.paymentIntentId ?? p.processorRef ?? null,
            financingProvider: p.method === 'financing' ? (p.financingProvider ?? null) : null,
            financingRef: p.method === 'financing' ? (p.financingRef ?? null) : null,
            status: 'succeeded',
          };
        }),
      )
      .returning();

    // Inventory: one movement per line + level decrement.
    for (const l of totals.lines) {
      await this.db.insert(schema.inventoryMovements).values({
        businessId: tenant.businessId!,
        variantId: l.variantId,
        locationId: body.locationId,
        delta: -l.quantity,
        reason: 'sale',
        referenceType: 'sale',
        referenceId: sale.id,
        actorUserId: actor?.id ?? null,
        notes: null,
      });
      // FIFO COGS for the walk-out sale.
      await this.costing.consume(this.db, {
        businessId: tenant.businessId!,
        variantId: l.variantId,
        locationId: body.locationId,
        quantity: l.quantity,
        referenceType: 'sale',
        referenceId: sale.id,
      });
      await this.db
        .insert(schema.inventoryLevels)
        .values({
          businessId: tenant.businessId!,
          variantId: l.variantId,
          locationId: body.locationId,
          onHand: 0,
        })
        .onConflictDoUpdate({
          target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
          set: {
            onHand: sql`GREATEST(0, ${schema.inventoryLevels.onHand} - ${l.quantity})`,
            updatedAt: new Date(),
          },
        });
    }

    // If a discount code was applied, log the redemption + bump
    // usage_count. Done after the sale is durable so a failed sale
    // never burns a redemption.
    if (appliedDiscount) {
      await this.db.insert(schema.discountRedemptions).values({
        businessId: tenant.businessId!,
        discountCodeId: appliedDiscount.id,
        saleId: sale.id,
        customerId: sale.customerId,
        amountCents: appliedDiscount.amountCents,
      });
      await this.db
        .update(schema.discountCodes)
        .set({
          usageCount: sql`${schema.discountCodes.usageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.discountCodes.id, appliedDiscount.id));
    }

    await this.audit.log({
      action: 'sale.complete',
      targetType: 'sale',
      targetId: sale.id,
      after: {
        number: sale.number,
        totalCents: sale.totalCents,
        lineCount: totals.lines.length,
        customerId: sale.customerId,
        discountCodeId: appliedDiscount?.id ?? null,
        discountAmountCents: appliedDiscount?.amountCents ?? 0,
      },
    });

    // Fire-and-forget outbound webhook. We capture the businessId
    // up-front because the request-scoped tenant context will be
    // gone by the time the dispatcher runs.
    // Commission accrues the moment the sale completes (G5); imported
    // sales never accrue (D8) — the service enforces both.
    await this.commissions.accrueForSale(this.db, {
      businessId: tenant.businessId!,
      saleId: sale.id,
    });

    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'sale.created',
      payload: {
        saleId: sale.id,
        number: sale.number,
        totalCents: sale.totalCents,
        subtotalCents: sale.subtotalCents,
        discountCents: sale.discountCents,
        taxCents: sale.taxCents,
        customerId: sale.customerId,
        locationId: sale.locationId,
        completedAt: sale.completedAt,
      },
    });

    return {
      id: sale.id,
      number: sale.number,
      status: sale.status,
      totalCents: sale.totalCents,
      subtotalCents: sale.subtotalCents,
      discountCents: sale.discountCents,
      taxCents: sale.taxCents,
      customerId: sale.customerId,
      associateUserId: sale.associateUserId,
      locationId: sale.locationId,
      notes: sale.notes,
      completedAt: sale.completedAt,
      createdAt: sale.createdAt,
      lines: insertedLines.map((l) => ({
        id: l.id,
        variantId: l.variantId,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents,
        totalCents: l.totalCents,
        refundedQuantity: 0,
      })),
      payments: insertedPayments.map((p) => ({
        id: p.id,
        method: p.method,
        amountCents: p.amountCents,
        status: p.status,
        processor: p.processor,
        processorRef: p.processorRef,
        createdAt: p.createdAt,
      })),
      refunds: [],
    };
  }

  @Post('sales/:id/refund')
  @RequirePermission('pos.refund.create')
  async refund(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: RefundBody,
  ): Promise<{ refundId: string; amountCents: number; saleStatus: string }> {
    const [sale] = await this.db
      .select()
      .from(schema.sales)
      .where(eq(schema.sales.id, id))
      .limit(1);
    if (!sale) throw new NotFoundException('Sale not found');
    if (sale.status !== 'completed' && sale.status !== 'partially_refunded') {
      throw new ForbiddenException(`cannot refund a sale in status ${sale.status}`);
    }
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must contain at least one entry');
    }

    const saleLines = await this.db
      .select()
      .from(schema.saleLines)
      .where(eq(schema.saleLines.saleId, id));
    const lineById = new Map(saleLines.map((l) => [l.id, l]));

    // Sale-level discount shares are persisted per line; sales written
    // before that column existed carry 0, so reconstruct pro-rata from
    // the header. Without this a cart-wide discount is refunded as if it
    // were never given.
    const shareByLine = new Map<string, number>(
      saleLines.map((l) => [l.id, l.orderDiscountShareCents]),
    );
    const storedShares = saleLines.reduce((s, l) => s + l.orderDiscountShareCents, 0);
    const lineDiscounts = saleLines.reduce((s, l) => s + l.discountCents, 0);
    const legacyOrderDiscount = sale.discountCents - lineDiscounts;
    if (storedShares === 0 && legacyOrderDiscount > 0) {
      const shares = reconstructOrderDiscountShares(saleLines, legacyOrderDiscount);
      saleLines.forEach((l, i) => shareByLine.set(l.id, shares[i]!));
    }

    // Tally previously-refunded quantities per line so we can enforce
    // that we never refund more units than were sold.
    const priorRefunded = await this.db
      .select({
        saleLineId: schema.refundLines.saleLineId,
        quantity: sql<number>`COALESCE(SUM(${schema.refundLines.quantity}), 0)::int`,
      })
      .from(schema.refundLines)
      .innerJoin(schema.refunds, eq(schema.refunds.id, schema.refundLines.refundId))
      .where(eq(schema.refunds.saleId, id))
      .groupBy(schema.refundLines.saleLineId);
    const priorMap = new Map(priorRefunded.map((r) => [r.saleLineId, r.quantity]));

    let amountCents = 0;
    const validated: { line: (typeof saleLines)[number]; quantity: number; perUnit: number }[] = [];
    for (const r of body.lines) {
      if (!r.saleLineId) throw new BadRequestException('lines[].saleLineId is required');
      const line = lineById.get(r.saleLineId);
      if (!line) throw new NotFoundException(`sale line not found: ${r.saleLineId}`);
      if (typeof r.quantity !== 'number' || !Number.isInteger(r.quantity) || r.quantity <= 0) {
        throw new BadRequestException('lines[].quantity must be a positive integer');
      }
      const already = priorMap.get(line.id) ?? 0;
      if (already + r.quantity > line.quantity) {
        throw new BadRequestException(
          `cannot refund ${r.quantity} units of line ${line.id}: only ${line.quantity - already} remaining`,
        );
      }
      const perUnit = refundUnitCents({
        ...line,
        orderDiscountShareCents: shareByLine.get(line.id) ?? 0,
      });
      validated.push({ line, quantity: r.quantity, perUnit });
      amountCents += perUnit * r.quantity;
    }

    // §10: refunds go back to the original tenders unless the customer
    // takes store credit instead — then no money moves at all, the
    // amount lands on their ledger.
    const toStoreCredit = body.refundMethod === 'store_credit';
    if (toStoreCredit && !sale.customerId) {
      throw new BadRequestException(
        'Store-credit refunds need a customer on the sale — attach one first',
      );
    }

    // If the sale was paid (in part) on a Stripe-charged card, reverse
    // the matching PaymentIntent on the merchant's connected account
    // before we record any refund rows. Allocate the refund amount to
    // Stripe-backed payments first; if the original tender was cash or
    // legacy/manual card, the refund is bookkeeping-only (cashier
    // hands cash back from the drawer).
    const allPayments = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.saleId, id))
      .orderBy(schema.payments.createdAt);

    const stripePayments = toStoreCredit
      ? []
      : allPayments.filter((p) => p.processor === 'stripe' && p.processorRef);
    if (stripePayments.length > 0) {
      const [merchant] = await this.db
        .select({ stripeAccountId: schema.merchantStripeAccounts.stripeAccountId })
        .from(schema.merchantStripeAccounts)
        .where(eq(schema.merchantStripeAccounts.businessId, tenant.businessId!))
        .limit(1);
      if (!merchant) {
        throw new BadRequestException(
          'Sale was paid via Stripe but merchant account is no longer connected; reconnect Stripe before issuing the refund.',
        );
      }
      let remaining = amountCents;
      for (const p of stripePayments) {
        if (remaining <= 0) break;
        const refundable = Math.min(remaining, p.amountCents);
        await this.stripe.refundCharge({
          stripeAccountId: merchant.stripeAccountId,
          paymentIntentId: p.processorRef!,
          amountCents: refundable,
          reason: body.reason ?? undefined,
          metadata: { saleId: id, businessId: tenant.businessId! },
        });
        remaining -= refundable;
      }
    }

    // Insert the refund header.
    const [refund] = await this.db
      .insert(schema.refunds)
      .values({
        businessId: tenant.businessId!,
        saleId: id,
        reason: body.reason ?? null,
        amountCents,
        approvedByUserId: actor.id,
      })
      .returning();
    if (!refund) throw new BadRequestException('failed to create refund');

    // Credit any gift_card-paid portion back onto the same card. The
    // payment row carries the gift card's id in `processor_ref`. We
    // allocate against gift_card payments AFTER the Stripe allocation,
    // so a mixed-tender sale (card + gift card) refunds card first
    // (matches what the customer expects) and only touches the gift
    // card if the refund exceeds the card-paid portion.
    const giftCardPayments = toStoreCredit
      ? []
      : allPayments.filter((p) => p.processor === 'gift_card' && p.processorRef);
    if (giftCardPayments.length > 0) {
      const stripeTotalRefunded = stripePayments.reduce(
        (s, p) => s + Math.min(amountCents, p.amountCents),
        0,
      );
      let remaining = Math.max(0, amountCents - stripeTotalRefunded);
      for (const p of giftCardPayments) {
        if (remaining <= 0) break;
        const refundable = Math.min(remaining, p.amountCents);
        await this.giftCards.credit(this.db, tenant.businessId!, {
          giftCardId: p.processorRef!,
          amountCents: refundable,
          refundId: refund.id,
          actorUserId: actor.id,
        });
        remaining -= refundable;
      }
    }

    // Insert refund lines. Returned goods do NOT go back to sellable
    // stock (§10) — they land in the As-Is queue and wait for a
    // manager/warehouse review to decide restock / vendor / scrap.
    for (const v of validated) {
      await this.db.insert(schema.refundLines).values({
        businessId: tenant.businessId!,
        refundId: refund.id,
        saleLineId: v.line.id,
        variantId: v.line.variantId,
        quantity: v.quantity,
        amountCents: v.perUnit * v.quantity,
      });

      if (v.line.variantId) {
        await this.db.insert(schema.asIsItems).values({
          businessId: tenant.businessId!,
          variantId: v.line.variantId,
          locationId: sale.locationId,
          quantity: v.quantity,
          source: 'return',
          referenceType: 'refund',
          referenceId: refund.id,
          notes: body.reason ?? null,
        });
      }
    }

    // Store-credit refunds land on the customer's ledger; the balance
    // auto-surfaces at their next checkout.
    if (toStoreCredit) {
      await this.storeCredit.issue(this.db, {
        businessId: tenant.businessId!,
        customerId: sale.customerId!,
        amountCents,
        reason: body.reason ?? `Refund on ${sale.number}`,
        referenceType: 'refund',
        referenceId: refund.id,
        actorUserId: actor.id,
      });
    }

    // Compute new sale status: all lines fully refunded → 'refunded';
    // otherwise 'partially_refunded'.
    const totalSoldUnits = saleLines.reduce((s, l) => s + l.quantity, 0);
    const totalRefundedUnits =
      [...priorMap.values()].reduce((s, q) => s + q, 0) +
      validated.reduce((s, v) => s + v.quantity, 0);
    const nextStatus = totalRefundedUnits >= totalSoldUnits ? 'refunded' : 'partially_refunded';
    await this.db.update(schema.sales).set({ status: nextStatus }).where(eq(schema.sales.id, id));

    await this.audit.log({
      action: 'sale.refund',
      targetType: 'sale',
      targetId: id,
      after: {
        refundId: refund.id,
        amountCents,
        lineCount: validated.length,
        reason: body.reason ?? null,
      },
    });

    // Negative commission entries proportional to the refunded fraction
    // (G5) — the salesperson's period nets out what the store gave back.
    await this.commissions.reverseForRefund(this.db, {
      businessId: tenant.businessId!,
      saleId: id,
      refundedCents: amountCents,
      saleTotalCents: sale.totalCents,
    });

    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'sale.refunded',
      payload: {
        saleId: id,
        refundId: refund.id,
        amountCents,
        saleStatus: nextStatus,
        reason: body.reason ?? null,
      },
    });

    return { refundId: refund.id, amountCents, saleStatus: nextStatus };
  }

  /**
   * Generate a per-business, per-year sequential sale number. Counts
   * the sales already written this year and increments. Retries up to
   * 5 times if a concurrent insert wins the race for the same number.
   */
  private async generateSaleNumber(businessId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await this.db
        .select({
          count: sql<number>`COUNT(*)::int`,
        })
        .from(schema.sales)
        .where(
          and(
            eq(schema.sales.businessId, businessId),
            sql`${schema.sales.number} LIKE ${`INV-${year}-%`}`,
          ),
        );
      const count = rows[0]?.count ?? 0;
      const seq = count + 1 + attempt;
      const candidate = `INV-${year}-${String(seq).padStart(6, '0')}`;
      const [existing] = await this.db
        .select({ id: schema.sales.id })
        .from(schema.sales)
        .where(and(eq(schema.sales.businessId, businessId), eq(schema.sales.number, candidate)))
        .limit(1);
      if (!existing) return candidate;
    }
    // Fall back to a randomized suffix if 5 sequential candidates all
    // collided (extremely unlikely outside a hot test loop).
    return `INV-${year}-${Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0')}`;
  }
}

function clampLimit(raw: string | undefined, def: number): number {
  const n = Number(raw ?? String(def));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}
