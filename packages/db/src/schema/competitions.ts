import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orders } from './orders';
import { businesses } from './platform';
import { locations, memberships } from './tenancy';

/**
 * Sales competitions (redesign Phase 11, README §3.6).
 *
 * Six races a month, People and Stores, computed at read time from the
 * order ledger — nothing about a ranking is stored except what cannot be
 * derived later: the leads a salesperson logged (the Lead Conversion
 * race's denominator), the last rank each person held (so an overtake
 * can be noticed once), and each closed month's winners (so History and
 * the printable sheet read the same after returns settle and staff
 * change).
 */

/**
 * A lead: a customer who walked out without buying, logged in under ten
 * seconds with a phone number. The phone is the match key — a completed
 * order under the same salesperson whose customer carries the same
 * digits within 30 days converts it on its own; attaching by hand is
 * audited. `phone_digits` is the normalised form the match runs on.
 */
export const salesLeads = pgTable(
  'sales_leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    salespersonMembershipId: uuid('salesperson_membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),
    phone: text('phone').notNull(),
    phoneDigits: text('phone_digits').notNull(),
    wantedSize: text('wanted_size'),
    wantedCategory: text('wanted_category'),
    note: text('note'),
    /** 'open' | 'converted' | 'lost' */
    status: text('status').notNull().default('open'),
    convertedOrderId: uuid('converted_order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    /** 'auto' (phone match) | 'manual' (attached by hand, audited) */
    conversion: text('conversion'),
    lostAt: timestamp('lost_at', { withTimezone: true }),
    followUpAt: timestamp('follow_up_at', { withTimezone: true }),
    /** The lead stops matching after this moment (logged + window days). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('sales_leads_business_idx').on(t.businessId),
    repIdx: index('sales_leads_rep_idx').on(t.businessId, t.salespersonMembershipId, t.status),
    phoneIdx: index('sales_leads_phone_idx').on(t.businessId, t.phoneDigits),
    monthIdx: index('sales_leads_created_idx').on(t.businessId, t.createdAt),
  }),
);

/**
 * The last rank each subject (a member or a store) held on each race this
 * month. Rewritten whenever an order completes; a subject whose new rank
 * is worse than the stored one has been overtaken, and gets one inbox
 * notice per race per day (the notice's event key carries the day).
 */
export const competitionRanks = pgTable(
  'competition_ranks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** YYYY-MM in the business's store-local calendar. */
    month: text('month').notNull(),
    /** 'people' | 'stores' */
    scope: text('scope').notNull(),
    /** 'leads' | 'avg' | 'high' | 'sales' | 'beds' | 'ex' */
    race: text('race').notNull(),
    /** membership id or location id, per scope. */
    subjectId: uuid('subject_id').notNull(),
    rank: integer('rank').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('competition_ranks_business_idx').on(t.businessId),
    subjectUnique: uniqueIndex('competition_ranks_subject_uniq').on(
      t.businessId,
      t.month,
      t.scope,
      t.race,
      t.subjectId,
    ),
  }),
);

/**
 * A closed month's winners, one row per race per scope, written the
 * first time anyone reads the month after it ends (and after its return
 * window, for the paid flag). History, the winner banner and the
 * printable sheet all read from here so the story never changes.
 */
export const competitionResults = pgTable(
  'competition_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    scope: text('scope').notNull(),
    race: text('race').notNull(),
    winnerId: uuid('winner_id'),
    winnerName: text('winner_name'),
    winnerStore: text('winner_store'),
    /** The metric as an integer (cents for money races, count otherwise). */
    value: integer('value'),
    /** "$2,480 across 6 sales" — the one-line story for the sheet. */
    story: text('story'),
    /** "$2,480 avg" — the short form for the banner. */
    short: text('short'),
    prizeCents: integer('prize_cents').notNull().default(0),
    /** Full ranking as computed at close, for the History dialog. */
    rankingJson: jsonb('ranking_json'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => ({
    businessIdx: index('competition_results_business_idx').on(t.businessId),
    raceUnique: uniqueIndex('competition_results_race_uniq').on(
      t.businessId,
      t.month,
      t.scope,
      t.race,
    ),
  }),
);
