import {
  boolean,
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
import { customers } from './customers';

/**
 * Service orders (STORIS cutover G6): warranty calls, repairs, and the
 * paperwork around them. Number series "SV-YYYY-NNNNNN". Charges (parts
 * and labor) live on service_order_lines; the money collected lands in
 * `payments` via `service_order_id` — one table behind every tender.
 */
export const serviceOrders = pgTable(
  'service_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** Either a tracked serial or a free-text description of the item. */
    serialUnitId: uuid('serial_unit_id'),
    itemDescription: text('item_description'),
    issue: text('issue').notNull(),
    /**
     * 'intake' | 'awaiting_parts' | 'in_service' | 'ready' | 'completed'
     * | 'cancelled'
     */
    status: text('status').notNull().default('intake'),
    technicianMembershipId: uuid('technician_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    warranty: boolean('warranty').notNull().default(false),
    /**
     * A22 slice 5 (STORIS Logistical Scheduling → service orders): the
     * day the technician visit is booked for, so the schedule search can
     * list service calls beside deliveries and transfers.
     */
    scheduledFor: date('scheduled_for'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    importedAt: timestamp('imported_at', { withTimezone: true }),
    legacyNumber: text('legacy_number'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNumberUnique: uniqueIndex('service_orders_business_number_uniq').on(
      t.businessId,
      t.number,
    ),
    businessIdx: index('service_orders_business_id_idx').on(t.businessId),
    statusIdx: index('service_orders_status_idx').on(t.businessId, t.status),
    customerIdx: index('service_orders_customer_id_idx').on(t.customerId),
  }),
);

/** Parts + labor. `variantId` set for parts pulled from stock; labor is free-text. */
export const serviceOrderLines = pgTable(
  'service_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    serviceOrderId: uuid('service_order_id')
      .notNull()
      .references(() => serviceOrders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id'),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitPriceCents: integer('unit_price_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    /** 'part' | 'labor' */
    kind: text('kind').notNull().default('labor'),
  },
  (t) => ({
    serviceOrderIdx: index('service_order_lines_service_order_id_idx').on(t.serviceOrderId),
    businessIdx: index('service_order_lines_business_id_idx').on(t.businessId),
  }),
);

/** The ticket's running narrative — status changes and technician notes. */
export const serviceOrderNotes = pgTable(
  'service_order_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    serviceOrderId: uuid('service_order_id')
      .notNull()
      .references(() => serviceOrders.id, { onDelete: 'cascade' }),
    authorMembershipId: uuid('author_membership_id'),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serviceOrderIdx: index('service_order_notes_service_order_id_idx').on(t.serviceOrderId),
    businessIdx: index('service_order_notes_business_id_idx').on(t.businessId),
  }),
);

/** CRM: free-form notes pinned to a customer (P1-lite). */
export const customerNotes = pgTable(
  'customer_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    authorMembershipId: uuid('author_membership_id'),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('customer_notes_customer_id_idx').on(t.customerId),
    businessIdx: index('customer_notes_business_id_idx').on(t.businessId),
  }),
);

/** CRM: tags ("VIP", "wholesale", "do-not-call") + the links to customers. */
export const customerTags = pgTable(
  'customer_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNameUnique: uniqueIndex('customer_tags_business_name_uniq').on(t.businessId, t.name),
    businessIdx: index('customer_tags_business_id_idx').on(t.businessId),
  }),
);

export const customerTagLinks = pgTable(
  'customer_tag_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => customerTags.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    customerTagUnique: uniqueIndex('customer_tag_links_customer_tag_uniq').on(
      t.customerId,
      t.tagId,
    ),
    businessIdx: index('customer_tag_links_business_id_idx').on(t.businessId),
    tagIdx: index('customer_tag_links_tag_id_idx').on(t.tagId),
  }),
);
