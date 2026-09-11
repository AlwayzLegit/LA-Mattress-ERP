import { check, date, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses, users } from './platform';
import { locations, memberships } from './tenancy';
import { customers } from './customers';
import { productVariants } from './catalog';
import { orders, orderLines } from './orders';
import { reasonCodes } from './controls';

/**
 * As-Is intake queue (PLAN-POS-OPERATIONS §10): every returned item —
 * and warranty/defect intakes — lands here instead of sellable stock,
 * and waits for a manager/warehouse review. The review decides its
 * disposition: restock (into the same variant or the matching `-AS`
 * as-is variant), return to vendor, or scrap. Only a restock touches
 * inventory.
 */
export const asIsItems = pgTable(
  'as_is_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    /**
     * 'return' | 'warranty' | 'defect' | 'exchange_pickup' | 'transfer'
     * (as_is consolidation intake) | 'stock' (A22 slice 3: moved out of
     * sellable stock by the Stock Adjustment dialog — the level dropped).
     */
    source: text('source').notNull().default('return'),
    /** 'pending_review' | 'restocked' | 'vendor_return' | 'scrapped' | 'voided' (A22: removed by an as-is adjustment) */
    status: text('status').notNull().default('pending_review'),
    /** What produced it: 'refund' | 'order' | 'manual' | 'stock_transfer' + the row's id. */
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    /** Where the units went on restock (may be the `-AS` variant). */
    restockedVariantId: uuid('restocked_variant_id').references(() => productVariants.id, {
      onDelete: 'set null',
    }),
    /**
     * G10 piece identity (STORIS: "tracks as-is items by piece"). New
     * intakes create one row per unit with a piece reference; legacy
     * rows may still carry quantity > 1.
     */
    pieceNumber: text('piece_number'),
    /** 'like_new' | 'light_wear' | 'damaged' | 'parts' — free text ok. */
    condition: text('condition'),
    /** Permission-gated as-is selling price for the piece. */
    asIsPriceCents: integer('as_is_price_cents'),
    /** Where the piece physically sits ("Back rack B3"). */
    storageLocation: text('storage_location'),
    /** Coded intake reason (class `as_is`; restricted codes gated). */
    reasonCodeId: uuid('reason_code_id').references(() => reasonCodes.id, {
      onDelete: 'set null',
    }),
    /** Vendor return (G4): the R/A number the credit is chased under. */
    vendorRaNumber: text('vendor_ra_number'),
    /** Expected vendor credit for a vendor_return disposition. */
    vendorCreditCents: integer('vendor_credit_cents'),
    /** 'open' | 'received' | 'written_off' — null unless vendor_return. */
    vendorCreditStatus: text('vendor_credit_status'),
    notes: text('notes'),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('as_is_items_business_id_idx').on(t.businessId),
    statusIdx: index('as_is_items_status_idx').on(t.businessId, t.status),
    variantIdx: index('as_is_items_variant_id_idx').on(t.variantId),
    locationIdx: index('as_is_items_location_id_idx').on(t.locationId),
    quantityPositive: check('as_is_items_quantity_positive', sql`${t.quantity} > 0`),
  }),
);

/**
 * Store-credit ledger (§10): credit lives on the customer record,
 * never expires, and auto-surfaces at checkout. Issued by returns and
 * refunds (positive delta), redeemed by store_credit tenders (negative
 * delta). The balance is always the SUM — never stored.
 */
export const storeCreditEntries = pgTable(
  'store_credit_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Positive = issued, negative = redeemed. */
    deltaCents: integer('delta_cents').notNull(),
    reason: text('reason'),
    /** 'refund' | 'order_return' | 'payment' | 'manual' + the row's id. */
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('store_credit_entries_business_id_idx').on(t.businessId),
    customerIdx: index('store_credit_entries_customer_id_idx').on(t.businessId, t.customerId),
  }),
);

/**
 * Return document (PLAN-STORIS-GAP §8, amendment A7): the financial
 * event is gated on the physical event. A return is *authorized* at
 * entry (lines, method, reasons — no money, no inventory), and the
 * refund fires only when the goods are physically received back
 * (status → completed, goods to As-Is, tenders reversed). Counter
 * drop-offs — goods in hand — authorize and receive in one step,
 * flagged by fulfillment='drop_off'.
 */
export const orderReturns = pgTable(
  'order_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /**
     * Null for a no-original return (RTN-010/SEC-RTN-NOORIG): the
     * customer has no findable order, so the document stands alone.
     */
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    /** No-original returns name the customer directly (credit recipient). */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /**
     * RTN-011: whatever order number the customer claimed, recorded
     * verbatim (even a bogus one) for the loss-prevention trail.
     */
    referencedOrderNumber: text('referenced_order_number'),
    /** Customer-facing RMA: "RMA-{order number}-{n}". */
    rmaNumber: text('rma_number').notNull(),
    /** 'authorized' | 'completed' | 'cancelled' */
    status: text('status').notNull().default('authorized'),
    /** 'drop_off' (goods in hand — refund immediately) | 'pickup' */
    fulfillment: text('fulfillment').notNull().default('drop_off'),
    /** 'original' | 'store_credit' — captured at authorization. */
    refundMethod: text('refund_method').notNull().default('original'),
    /** Total to refund, computed from the lines at authorization (fees already deducted). */
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason'),
    /**
     * A22 slice 6 (STORIS Enter a Return): who took the return, which
     * store took it, the fees withheld from the refund, the requested
     * pickup date and the calendar stop that carries the pickup, and
     * how many return tickets were printed.
     */
    salespersonMembershipId: uuid('salesperson_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    restockingFeeCents: integer('restocking_fee_cents').notNull().default(0),
    pickupFeeCents: integer('pickup_fee_cents').notNull().default(0),
    pickupDate: date('pickup_date'),
    pickupDeliveryId: uuid('pickup_delivery_id'),
    ticketPrintCount: integer('ticket_print_count').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }).notNull().defaultNow(),
    goodsReceivedAt: timestamp('goods_received_at', { withTimezone: true }),
    receivedByUserId: uuid('received_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelReason: text('cancel_reason'),
  },
  (t) => ({
    businessIdx: index('order_returns_business_id_idx').on(t.businessId),
    statusIdx: index('order_returns_status_idx').on(t.businessId, t.status),
    orderIdx: index('order_returns_order_id_idx').on(t.orderId),
  }),
);

export const orderReturnLines = pgTable(
  'order_return_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    returnId: uuid('return_id')
      .notNull()
      .references(() => orderReturns.id, { onDelete: 'cascade' }),
    /** Null for no-original lines — they name the variant directly. */
    orderLineId: uuid('order_line_id').references(() => orderLines.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
    /** Display description for lines with no order line to borrow from. */
    description: text('description'),
    quantity: integer('quantity').notNull(),
    /** What the customer paid per unit (line total + tax share). */
    perUnitCents: integer('per_unit_cents').notNull(),
    /** Coded return reason (class `return`); text is the A9 fallback. */
    reasonCodeId: uuid('reason_code_id').references(() => reasonCodes.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
  },
  (t) => ({
    businessIdx: index('order_return_lines_business_id_idx').on(t.businessId),
    returnIdx: index('order_return_lines_return_id_idx').on(t.returnId),
    orderLineIdx: index('order_return_lines_order_line_id_idx').on(t.orderLineId),
    quantityPositive: check('order_return_lines_quantity_positive', sql`${t.quantity} > 0`),
  }),
);

/**
 * Write-off register (PLAN-STORIS-GAP §8 / G4): scrap is not a button,
 * it's a valued, permissioned exit for physical goods. Every scrapped
 * unit lands here at cost so the shrink report has a dollar number the
 * owner reads weekly.
 */
export const writeOffs = pgTable(
  'write_offs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    asIsItemId: uuid('as_is_item_id').references(() => asIsItems.id, { onDelete: 'set null' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    /** Cost basis per unit at write-off time (variant cost; 0 if unknown). */
    unitCostCents: integer('unit_cost_cents').notNull().default(0),
    totalCostCents: integer('total_cost_cents').notNull().default(0),
    reasonCodeId: uuid('reason_code_id').references(() => reasonCodes.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('write_offs_business_id_idx').on(t.businessId),
    createdIdx: index('write_offs_created_idx').on(t.businessId, t.createdAt),
    quantityPositive: check('write_offs_quantity_positive', sql`${t.quantity} > 0`),
  }),
);
