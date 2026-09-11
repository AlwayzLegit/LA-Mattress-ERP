import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { businesses } from './platform';
import { citext, tsvector } from '../types';

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    email: citext('email'),
    phone: text('phone'),
    /** Optional secondary phone (owner 2026-08-31) — spouse, work, cell. */
    phone2: text('phone2'),
    /** A20 (STORIS Billing Information): work phone + extension. */
    workPhone: text('work_phone'),
    workPhoneExt: text('work_phone_ext'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    addressesJson: jsonb('addresses_json'),
    /** Where they heard about us (lead source), captured at the counter. */
    referralSource: text('referral_source'),
    notes: text('notes'),
    // GENERATED ALWAYS AS — see migration. Kept here so SQL queries can
    // reference the column by Drizzle alias.
    searchTsv: tsvector('search_tsv'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('customers_business_id_idx').on(t.businessId),
    emailIdx: index('customers_business_email_idx').on(t.businessId, t.email),
    phoneIdx: index('customers_business_phone_idx').on(t.businessId, t.phone),
  }),
);
