import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { businesses } from './platform';
import { memberships } from './tenancy';
import { payments } from './sales';
import { auditLogs } from './audit';

/**
 * Dashboard ledgers (owner hand-off 2026-09-10, store cards + changes
 * card). Both are shared server state between the owner and Operations —
 * the whole point of the tick is that the owner sees *who* confirmed the
 * cash was handed over, so a boolean in the browser was never enough.
 */

/**
 * One row per cash payment whose physical cash has been picked up
 * (ticked on a store card). Ticking stamps the moment and the acting
 * member; unticking deletes the row. The member reference is nullable
 * so a receipt survives the member leaving — the name is resolved at
 * read time and falls back to "a former member".
 */
export const cashPickupReceipts = pgTable(
  'cash_pickup_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    receivedByMembershipId: uuid('received_by_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('cash_pickup_receipts_business_idx').on(t.businessId),
    paymentUnique: uniqueIndex('cash_pickup_receipts_payment_uniq').on(t.paymentId),
  }),
);

/**
 * A member's "seen" tick on one money-related order change. The change
 * itself is the audit row (the audit trail is the source of truth for
 * what changed, by whom); the acknowledgement is per member so each
 * owner's ticks are their own.
 */
export const orderChangeAcks = pgTable(
  'order_change_acks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    auditLogId: uuid('audit_log_id')
      .notNull()
      .references(() => auditLogs.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('order_change_acks_business_idx').on(t.businessId),
    memberIdx: index('order_change_acks_member_idx').on(t.businessId, t.membershipId),
    changeMemberUnique: uniqueIndex('order_change_acks_change_member_uniq').on(
      t.auditLogId,
      t.membershipId,
    ),
  }),
);
