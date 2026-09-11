import {
  boolean,
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
import { memberships } from './tenancy';
import { orders } from './orders';
import { orderReturns } from './returns';

/**
 * Enter an Exchange (docs/erp-exchange): one settlement over two
 * first-class documents — a customer return and a replacement sales
 * order. The container carries what is shared (number, original order,
 * per-leg return salesperson, the restocking fee, the approval hold)
 * and nothing that belongs to a leg; Split Exchange is therefore a
 * container dissolve, never document surgery.
 *
 * Settlement rides the store-credit ledger: when the return's goods
 * come back, the credit (minus any restocking fee) is issued to the
 * customer and immediately redeemed against the replacement order's
 * balance — every cent reconciles through existing ledgers, and any
 * excess stays as visible store credit.
 */
export const exchanges = pgTable(
  'exchanges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** EX-{year}-{seq}. */
    number: text('number').notNull(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => orderReturns.id, { onDelete: 'restrict' }),
    saleOrderId: uuid('sale_order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** Null for a pre-cutover (no-original) exchange. */
    originalOrderId: uuid('original_order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    /** The order number the customer claimed when no original exists. */
    referencedOrderNumber: text('referenced_order_number'),
    /** 'on_hold' (E1 approval) | 'open' | 'completed' | 'split' | 'cancelled' */
    status: text('status').notNull().default('open'),
    /** Like-for-like — required when the original was financed (D1). */
    evenExchange: boolean('even_exchange').notNull().default(false),
    /** Deducted from the return credit at settlement. */
    restockingFeeCents: integer('restocking_fee_cents').notNull().default(0),
    /** Overridden fees are sticky — never recalculated (EXCHANGE 05). */
    restockingFeeOverridden: boolean('restocking_fee_overridden').notNull().default(false),
    /** The return leg's own commission attribution (per-leg salespeople). */
    returnSalespersonMembershipId: uuid('return_salesperson_membership_id').references(
      () => memberships.id,
      { onDelete: 'set null' },
    ),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * A22 slice 6 (STORIS Enter an Exchange): how the returned goods come
     * back ('drop_off' | 'pickup'), how any credit left after the
     * replacement is paid out ('store_credit' | 'original' | 'cash' |
     * 'check'), and how many exchange tickets were printed.
     */
    fulfillment: text('fulfillment').notNull().default('drop_off'),
    refundTender: text('refund_tender').notNull().default('store_credit'),
    ticketPrintCount: integer('ticket_print_count').notNull().default(0),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    splitAt: timestamp('split_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNumberUnique: uniqueIndex('exchanges_business_number_uniq').on(t.businessId, t.number),
    // Partial: a split or cancelled container releases its legs, so a
    // corrected exchange can re-bind the same return or order.
    returnUnique: uniqueIndex('exchanges_return_id_uniq')
      .on(t.returnId)
      .where(sql`${t.status} not in ('split', 'cancelled')`),
    saleOrderUnique: uniqueIndex('exchanges_sale_order_id_uniq')
      .on(t.saleOrderId)
      .where(sql`${t.status} not in ('split', 'cancelled')`),
    businessIdx: index('exchanges_business_id_idx').on(t.businessId),
    statusIdx: index('exchanges_status_idx').on(t.businessId, t.status),
    originalIdx: index('exchanges_original_order_id_idx').on(t.originalOrderId),
  }),
);
