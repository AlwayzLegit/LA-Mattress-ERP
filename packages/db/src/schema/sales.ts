import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses, users } from './platform';
import { locations } from './tenancy';
import { customers } from './customers';
import { productVariants } from './catalog';
import { orders } from './orders';

export const sales = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    // Human-friendly: "INV-2026-000123"
    number: text('number').notNull(),
    // 'draft' | 'completed' | 'voided' | 'refunded' | 'partially_refunded'
    status: text('status').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    associateUserId: uuid('associate_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    subtotalCents: integer('subtotal_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    notes: text('notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** D8: set on legacy-imported sales — excluded from drawer, commissions, webhooks. */
    importedAt: timestamp('imported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNumberUnique: uniqueIndex('sales_business_number_uniq').on(t.businessId, t.number),
    businessIdx: index('sales_business_id_idx').on(t.businessId),
    locationIdx: index('sales_location_id_idx').on(t.locationId),
    customerIdx: index('sales_customer_id_idx').on(t.customerId),
    associateIdx: index('sales_associate_user_id_idx').on(t.associateUserId),
    statusIdx: index('sales_status_idx').on(t.businessId, t.status),
  }),
);

export const saleLines = pgTable(
  'sale_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    /**
     * This line's share of the SALE-level discount, allocated pro-rata at
     * sale time. Persisted rather than re-derived: a refund has to return
     * exactly what the customer paid, and the pro-rata rounding residue
     * cannot be reconstructed later (line order isn't stored). Legacy rows
     * predating this column read 0 and fall back to reconstruction.
     */
    orderDiscountShareCents: integer('order_discount_share_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
  },
  (t) => ({
    saleIdx: index('sale_lines_sale_id_idx').on(t.saleId),
    businessIdx: index('sale_lines_business_id_idx').on(t.businessId),
    variantIdx: index('sale_lines_variant_id_idx').on(t.variantId),
  }),
);

/**
 * Tenders. Generalized in the STORIS cutover (sprint decision D2) to
 * cover order money as well as POS money: `sale_id` became nullable,
 * `order_id` was added, and a CHECK enforces exactly one of them. A
 * deposit is nothing more special than a payment on an open order,
 * which keeps one table behind the cash drawer, the shift reconcile,
 * and every revenue report.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    /** G6: a service ticket's charge. Exactly one parent among sale/order/service. */
    serviceOrderId: uuid('service_order_id'),
    /**
     * 'sale' — POS cash-and-carry tender
     * 'deposit' — money down on an order that is not yet fulfilled
     * 'balance' — the rest, usually collected at delivery
     * 'installment' — a scheduled layaway / in-house plan payment (G4)
     */
    kind: text('kind').notNull().default('sale'),
    /**
     * 'cash' | 'card' | 'store_credit' | 'gift_card' | 'financing'
     * | 'external_card' | 'check'
     *
     * `financing` records a third-party approval (D5 — we keep the
     * record, the provider keeps the loan); `external_card` is a card
     * run on a standalone terminal outside Jetnine, which still has to
     * land in the drawer.
     */
    method: text('method').notNull(),
    amountCents: integer('amount_cents').notNull(),
    processor: text('processor'),
    processorRef: text('processor_ref'),
    // For method='financing': who approved it and under what number.
    financingProvider: text('financing_provider'),
    financingRef: text('financing_ref'),
    // Card tenders: the brand ('visa' | 'mastercard' | 'amex' | …) so the
    // store dashboards can break card volume down by network.
    cardBrand: text('card_brand'),
    // Financing tenders (synchrony/acima/financing): the promo term the
    // customer signed (6 | 12 | 15 | 18 | 24 | 36 | 48 months).
    financingMonths: integer('financing_months'),
    // 'pending' | 'succeeded' | 'failed' | 'refunded'
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    saleIdx: index('payments_sale_id_idx').on(t.saleId),
    orderIdx: index('payments_order_id_idx').on(t.orderId),
    businessIdx: index('payments_business_id_idx').on(t.businessId),
    processorRefIdx: index('payments_processor_ref_idx').on(t.processor, t.processorRef),
    kindIdx: index('payments_business_kind_idx').on(t.businessId, t.kind),
    // A payment belongs to exactly one document. Without this, an
    // order deposit could also be counted against a sale and the
    // drawer would double-count it.
    parentExactlyOne: check(
      'payments_parent_exactly_one',
      sql`num_nonnulls(${t.saleId}, ${t.orderId}, ${t.serviceOrderId}) = 1`,
    ),
  }),
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    amountCents: integer('amount_cents').notNull(),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    saleIdx: index('refunds_sale_id_idx').on(t.saleId),
    businessIdx: index('refunds_business_id_idx').on(t.businessId),
    approvedIdx: index('refunds_approved_by_user_id_idx').on(t.approvedByUserId),
  }),
);

export const refundLines = pgTable(
  'refund_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    saleLineId: uuid('sale_line_id')
      .notNull()
      .references(() => saleLines.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
    quantity: integer('quantity').notNull(),
    amountCents: integer('amount_cents').notNull(),
  },
  (t) => ({
    refundIdx: index('refund_lines_refund_id_idx').on(t.refundId),
    businessIdx: index('refund_lines_business_id_idx').on(t.businessId),
    saleLineIdx: index('refund_lines_sale_line_id_idx').on(t.saleLineId),
  }),
);
