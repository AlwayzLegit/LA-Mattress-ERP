import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { businesses, users } from './platform';

/**
 * Reason Code registry (PLAN-STORIS-GAP §0.2, STORIS "Reason Code
 * Settings"). Every reason prompt in the system draws from this table,
 * filtered by usage class — free text is only a transitional fallback
 * while a business has no active codes for a class. `isRestricted`
 * mirrors STORIS "As-Is Restricted": assigning or clearing a restricted
 * code needs the gating permission or a security override.
 */
export const reasonCodes = pgTable(
  'reason_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    description: text('description').notNull(),
    /**
     * Where the code is legal: 'exception' | 'as_is' | 'return' |
     * 'adjustment' | 'delivery_failure' | 'manifest_removal' |
     * 'inventory_adjustment' | 'transfer_variance' | 'write_off'.
     * (Catalog lives in @jetnine/shared REASON_USAGE_CLASSES.)
     */
    usageClass: text('usage_class').notNull(),
    isRestricted: boolean('is_restricted').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('reason_codes_business_id_idx').on(t.businessId),
    classIdx: index('reason_codes_class_idx').on(t.businessId, t.usageClass, t.active),
    codeUnique: uniqueIndex('reason_codes_business_class_code_uniq').on(
      t.businessId,
      t.usageClass,
      t.code,
    ),
  }),
);

/**
 * Security override register (PLAN-STORIS-GAP §0.1, STORIS "Security
 * Override Screen"): when a user without a permission performs a gated
 * action under a second, authorized user's credentials, the override is
 * stamped here with both identities, the reason code, and the before/
 * after of what changed. Reportable — this is the POS exception file,
 * not a log line.
 */
export const securityOverrides = pgTable(
  'security_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorizingUserId: uuid('authorizing_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The permission the actor lacked (from the shared catalog). */
    permission: text('permission').notNull(),
    /** Human description of the gated action, shown on the override screen. */
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    reasonCodeId: uuid('reason_code_id').references(() => reasonCodes.id, {
      onDelete: 'set null',
    }),
    /** Free-text fallback while the business has no exception codes. */
    reason: text('reason'),
    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('security_overrides_business_id_idx').on(t.businessId),
    createdIdx: index('security_overrides_created_idx').on(t.businessId, t.createdAt),
    actorIdx: index('security_overrides_actor_idx').on(t.businessId, t.actorUserId),
  }),
);

/**
 * Exception register (PLAN-STORIS-GAP §0.3): the reportable file the
 * owner actually works — severity, type, actor, acknowledged state —
 * not a scrolling feed. Overrides, unlocks, cap overrides, write-offs
 * and (with G6) threshold breaches all land here; the per-associate
 * ranked digest reads from it.
 */
export const exceptionEvents = pgTable(
  'exception_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** 'security_override' | 'order_unlock' | 'delivery_cap_override' | 'write_off' | 'return_cancel' | … */
    type: text('type').notNull(),
    /** 'info' | 'warning' | 'critical' */
    severity: text('severity').notNull().default('warning'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    summary: text('summary').notNull(),
    metadataJson: jsonb('metadata_json'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedByUserId: uuid('acknowledged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('exception_events_business_id_idx').on(t.businessId),
    openIdx: index('exception_events_open_idx').on(t.businessId, t.acknowledgedAt, t.createdAt),
    actorIdx: index('exception_events_actor_idx').on(t.businessId, t.actorUserId, t.createdAt),
    typeIdx: index('exception_events_type_idx').on(t.businessId, t.type),
  }),
);

/**
 * Daily close-out runs (PLAN-POS-OPERATIONS §12 / P9): the 22:00 job
 * per store. Never blocks — it flags. One row per location per local
 * date is the idempotency key; the summary keeps what was flagged.
 */
export const dailyCloseouts = pgTable(
  'daily_closeouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    /** The store-local calendar date the close covers (YYYY-MM-DD). */
    closeDate: text('close_date').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    /** 'scheduler' | 'manual' */
    trigger: text('trigger').notNull().default('scheduler'),
    exceptionCount: integer('exception_count').notNull().default(0),
    stockReleasedCount: integer('stock_released_count').notNull().default(0),
    summaryJson: jsonb('summary_json'),
  },
  (t) => ({
    businessIdx: index('daily_closeouts_business_id_idx').on(t.businessId),
    dateIdx: index('daily_closeouts_date_idx').on(t.businessId, t.closeDate),
    locationDateUnique: uniqueIndex('daily_closeouts_location_date_uniq').on(
      t.locationId,
      t.closeDate,
    ),
  }),
);

/**
 * Operations review ledger (owner 2026-08-31). The exception register
 * above answers "what tripped a control"; this answers "who read it".
 * Every row on the operations feed — a refund, an inventory adjustment,
 * a take-with left open on a split ticket — can be cleared by an
 * Operations member, and the clear is stamped here with their name and
 * the moment they did it. Rows that ARE exception events clear through
 * `exception_events.acknowledged_at` instead, so a subject is never
 * recorded twice.
 *
 * `subject_type` + `subject_id` is deliberately loose: the feed unions
 * a dozen tables and a foreign key per source would mean a migration
 * every time a new signal is added. The unique index is what keeps a
 * subject from being cleared twice.
 */
export const opsReviews = pgTable(
  'ops_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** Feed source: 'refund' | 'inventory_movement' | 'take_with_open' | … */
    subjectType: text('subject_type').notNull(),
    /** The source row's id. Text, not uuid — some subjects are composite. */
    subjectId: text('subject_id').notNull(),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
  },
  (t) => ({
    businessIdx: index('ops_reviews_business_id_idx').on(t.businessId),
    reviewedIdx: index('ops_reviews_reviewed_idx').on(t.businessId, t.reviewedAt),
    subjectUnique: uniqueIndex('ops_reviews_subject_uniq').on(
      t.businessId,
      t.subjectType,
      t.subjectId,
    ),
  }),
);

/**
 * Close-out sign-offs (redesign Phase 10, Z-report). The manager on duty
 * signs the store's close-out sheet for one local date: it records who
 * read it and when. It is deliberately not a resolution — every
 * exception the 10pm close raised stays open on the register until it
 * is acknowledged there — so a signed sheet with a short drawer still
 * shows the owner both facts. One row per store per date; the name is
 * denormalised so the sheet reads the same after the member leaves.
 */
export const closeOutSignoffs = pgTable(
  'close_out_signoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    /** The store-local calendar date the sheet covers (YYYY-MM-DD). */
    closeDate: text('close_date').notNull(),
    signedByUserId: uuid('signed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    signedByName: text('signed_by_name').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Open exceptions on the sheet at the moment of signing. */
    openExceptionCount: integer('open_exception_count').notNull().default(0),
    note: text('note'),
  },
  (t) => ({
    businessIdx: index('close_out_signoffs_business_id_idx').on(t.businessId),
    locationDateUnique: uniqueIndex('close_out_signoffs_location_date_uniq').on(
      t.locationId,
      t.closeDate,
    ),
  }),
);
