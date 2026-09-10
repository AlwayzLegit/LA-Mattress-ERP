import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { businesses } from './platform';
import { locations, memberships } from './tenancy';

/**
 * Staff schedule + time clock (owner hand-off 2026-09-10, step 2). Nothing
 * for this existed in the live app; these two tables are the whole data
 * layer behind the schedule card and the time clock strip.
 */

/**
 * One row per member per day. Times are minutes from store-local
 * midnight so a shift reads the same in every viewer's timezone. A row
 * with NULL times is an explicit day off that has not been published
 * yet — it counts as an unpublished change and is dropped on publish
 * (an absent row already means "off"). `published_at` is null while the
 * row is a draft edit; publishing the week stamps every draft in it.
 */
export const staffShifts = pgTable(
  'staff_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    date: date('date').notNull(),
    startMinutes: integer('start_minutes'),
    endMinutes: integer('end_minutes'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    updatedByMembershipId: uuid('updated_by_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessDateIdx: index('staff_shifts_business_date_idx').on(t.businessId, t.date),
    memberDayUnique: uniqueIndex('staff_shifts_member_day_uniq').on(t.membershipId, t.date),
    // Either both times (a shift) or neither (a pending day off).
    timesTogether: check(
      'staff_shifts_times_together',
      sql`(${t.startMinutes} IS NULL) = (${t.endMinutes} IS NULL)`,
    ),
    endAfterStart: check(
      'staff_shifts_end_after_start',
      sql`${t.startMinutes} IS NULL OR (${t.startMinutes} >= 0 AND ${t.endMinutes} > ${t.startMinutes} AND ${t.endMinutes} <= 1440)`,
    ),
  }),
);

/**
 * Every punch, append-only. Hours are derived (never stored): the sum of
 * clock-in → break-start / break-end → clock-out segments, each clamped
 * at zero so an out-of-order punch can never make a total go backwards.
 */
export const timePunches = pgTable(
  'time_punches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    /** 'clock_in' | 'break_start' | 'break_end' | 'clock_out' */
    type: text('type').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('time_punches_business_idx').on(t.businessId),
    memberAtIdx: index('time_punches_member_at_idx').on(t.businessId, t.membershipId, t.at),
    typeCheck: check(
      'time_punches_type_check',
      sql`${t.type} in ('clock_in', 'break_start', 'break_end', 'clock_out')`,
    ),
  }),
);
