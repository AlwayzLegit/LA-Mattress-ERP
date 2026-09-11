import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses, users } from './platform';
import { locations } from './tenancy';
import { productVariants } from './catalog';
import { reasonCodes } from './controls';
import { orders } from './orders';

/**
 * Stock transfers move inventory between two of the business's own
 * locations. Lifecycle:
 *   draft → in_transit → received
 *                    ├── closed_short (G8: variance write-off)
 *                    └── canceled
 *
 * Shipping deducts inventory at the origin (`reason='transfer_out'`,
 * `reference_type='stock_transfer'`); receiving credits the destination
 * (`reason='transfer_in'`). Partial receipts are supported — the
 * transfer auto-flips to `received` once every line's
 * `quantity_received` matches the shipped quantity.
 */
export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    fromLocationId: uuid('from_location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    toLocationId: uuid('to_location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    /** 'draft' | 'in_transit' | 'received' | 'closed_short' | 'canceled' */
    status: text('status').notNull(),
    /**
     * G8 (STORIS transfer types): 'replenishment' | 'floor_sample' |
     * 'customer' | 'as_is' | 'auto' — a floor model moved to a store is
     * not silently sellable as new. 'auto' (XFR-051) is generated from a
     * sales-order shortfall and released manually.
     */
    transferType: text('transfer_type').notNull().default('replenishment'),
    /** XFR-053: the calculated auto-transfer date (auto transfers only). */
    scheduledFor: date('scheduled_for'),
    /** The sales order whose shortfall generated this auto transfer. */
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    /** G8: coded reason (class `transfer_variance`) on a short close. */
    varianceReasonCodeId: uuid('variance_reason_code_id').references(() => reasonCodes.id, {
      onDelete: 'set null',
    }),
    /** A22 slice 2 (STORIS Enter a Transfer): coded reason for the move (class `transfer`). */
    reasonCodeId: uuid('reason_code_id').references(() => reasonCodes.id, { onDelete: 'set null' }),
    /**
     * A22 slice 2 — STORIS Delivery Information: the route it rides, whether
     * it ships straight to the customer, and instructions for this
     * fulfillment only (the ticket prints them).
     */
    route: text('route'),
    shipDirect: boolean('ship_direct').notNull().default(false),
    fulfillmentInstructions: text('fulfillment_instructions'),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Q3 (transfers pack, owner 2026-08-28): shipping is gated on the
     * transfer ticket having printed (ops.transfers.requireTicketBeforeShip,
     * default on). Null = never printed. Drafts are immutable in Jetnine,
     * so a printed ticket cannot go stale — no P/R demotion needed.
     */
    ticketPrintedAt: timestamp('ticket_printed_at', { withTimezone: true }),
    ticketPrintCount: integer('ticket_print_count').notNull().default(0),
    /**
     * Q1 manifests (owner 2026-08-28: manifests without scanning): the
     * truck/date manifest this transfer rides on. Null = not manifested.
     * A draft on an open manifest ships via the manifest's Complete.
     */
    manifestId: uuid('manifest_id').references(() => stockManifests.id, {
      onDelete: 'set null',
    }),
    /** Loading order on the manifest, 0-99 — lower loads first. */
    loadNumber: integer('load_number'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNumberUnique: uniqueIndex('stock_transfers_business_number_uniq').on(
      t.businessId,
      t.number,
    ),
    statusIdx: index('stock_transfers_status_idx').on(t.businessId, t.status),
    fromIdx: index('stock_transfers_from_location_id_idx').on(t.fromLocationId),
    toIdx: index('stock_transfers_to_location_id_idx').on(t.toLocationId),
    distinctLocations: check(
      'stock_transfers_distinct_locations_chk',
      sql`from_location_id <> to_location_id`,
    ),
  }),
);

export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => stockTransfers.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    quantityShipped: integer('quantity_shipped').notNull(),
    quantityReceived: integer('quantity_received').notNull().default(0),
    /**
     * Transfers pack D18: total wanted on the line. When it exceeds
     * quantity_shipped the difference is the HELD remainder — not
     * shipped, not on the ticket. On full receipt the remainder rolls
     * into a fresh draft transfer (D19: "becomes schedulable"). Null =
     * no hold (ordered == shipped).
     */
    quantityOrdered: integer('quantity_ordered'),
    /**
     * FIFO cost carried across the transfer: the weighted unit cost of
     * the origin layers consumed at ship time. Receiving creates the
     * destination layer at this cost. Null on transfers shipped before
     * costing existed — receive falls back to the variant catalog cost.
     */
    unitCostCents: integer('unit_cost_cents'),
    /**
     * J3 (XFR-040): the specific serial pieces riding this line (array
     * of serial_units ids, ≤ quantity_shipped). Ship flags them
     * in_transit; receive re-homes them at the destination.
     */
    serialIdsJson: jsonb('serial_ids_json'),
  },
  (t) => ({
    transferIdx: index('stock_transfer_lines_transfer_id_idx').on(t.transferId),
    businessIdx: index('stock_transfer_lines_business_id_idx').on(t.businessId),
    variantIdx: index('stock_transfer_lines_variant_id_idx').on(t.variantId),
  }),
);

/**
 * Q1 (transfers pack / run-04, owner 2026-08-28): truck/date manifests
 * without scanning. A manifest groups draft transfers on one lane for
 * one truck run; building against the same open (toLocation, routeName,
 * manifestDate) key APPENDS rather than creating a duplicate (STORIS
 * 08-manifests key semantics). Complete ships every draft on it — the
 * print-before-ship gate still applies per transfer. Receiving stays
 * tap-based per transfer at the destination.
 */
export const stockManifests = pgTable(
  'stock_manifests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    fromLocationId: uuid('from_location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    toLocationId: uuid('to_location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    /** The truck run's date. */
    manifestDate: date('manifest_date').notNull(),
    /** Free-text route / truck label; null = unrouted. */
    routeName: text('route_name'),
    /** 'open' | 'completed' | 'canceled' */
    status: text('status').notNull().default('open'),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNumberUnique: uniqueIndex('stock_manifests_business_number_uniq').on(
      t.businessId,
      t.number,
    ),
    businessIdx: index('stock_manifests_business_id_idx').on(t.businessId),
    statusIdx: index('stock_manifests_status_idx').on(t.businessId, t.status),
    laneIdx: index('stock_manifests_lane_idx').on(t.toLocationId, t.manifestDate),
  }),
);
