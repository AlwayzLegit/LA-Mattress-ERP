import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses, users } from './platform';
import { locations, memberships } from './tenancy';
import { reasonCodes } from './controls';
import { customers } from './customers';
import { productVariants } from './catalog';
import { taxClasses } from './taxes';

/**
 * Sales orders (STORIS "order entry", cutover gap G1). Distinct from
 * `sales`, which stays the cash-and-carry POS aggregate (sprint decision
 * D1): an order is written today, deposited against, and fulfilled later.
 *
 * Status lifecycle:
 *   quote → open → partially_fulfilled → fulfilled → completed
 *        └──────────── cancelled ────────────┘
 *
 * `quote` holds no stock. Moving to `open` reserves stock through
 * `inventory_levels.reserved` + `inventory_movements` (D3); cancelling
 * releases it. Completion (Day 3, fulfillment) requires balance due = 0
 * unless the actor holds `orders.complete_with_balance`.
 *
 * Money that can be derived is never stored: `paid_cents` is the sum of
 * succeeded payments and `balance_due_cents` is `total_cents - paid_cents`,
 * both computed at read time.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    /**
     * Fulfill-from: which location's stock this order reserves and
     * consumes. Null = the selling location. Set at write time (New Sale
     * "Inventory from"); immutable once any line holds a reservation —
     * release first, then move it.
     */
    stockLocationId: uuid('stock_location_id').references(() => locations.id, {
      onDelete: 'restrict',
    }),
    // Human-friendly: "SO-2026-000123", unique per business.
    number: text('number').notNull(),
    /**
     * 'quote' | 'open' | 'partially_fulfilled' | 'fulfilled' | 'completed'
     * | 'cancelled'
     */
    status: text('status').notNull(),
    // Unlike POS sales, an order always names the customer — we have to
    // know who to deliver to and who owes the balance.
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    // Commission attribution (G5, Day 5). Splits are stored as the first
    // salesperson's share in basis points; the second gets the remainder.
    salespersonMembershipId: uuid('salesperson_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    secondSalespersonMembershipId: uuid('second_salesperson_membership_id').references(
      () => memberships.id,
      { onDelete: 'set null' },
    ),
    splitBps: integer('split_bps'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    // The order-level discount the writer typed, kept separate from the
    // aggregate below. Totals are recomputed from the lines after every
    // edit, and that recompute needs the operator's input back — not the
    // sum it previously produced.
    orderDiscountCents: integer('order_discount_cents').notNull().default(0),
    // Line discounts + the order-level discount. Same meaning as
    // `sales.discount_cents`, so revenue reports can union the two.
    discountCents: integer('discount_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    // Policy amount the customer is expected to put down before the order
    // leaves `quote`. Seeded from the business default deposit percentage
    // and editable per order.
    depositRequiredCents: integer('deposit_required_cents').notNull().default(0),
    /**
     * 'sales_order' | 'layaway' — a layaway is an order whose balance is
     * paid down on an installment plan before it fulfills. Quotes are a
     * status, not a kind.
     */
    orderKind: text('order_kind').notNull().default('sales_order'),
    /**
     * Exchange Orders (PLAN-POS-OPERATIONS §10) link back to the original
     * sale's order; the printed document shows it as "Original Invoice #".
     */
    originalOrderId: uuid('original_order_id'),
    /**
     * 'delivery' | 'pickup' | 'take_with' | 'direct_ship' — the order
     * default; STORIS split tickets are per-line overrides on
     * `order_lines.fulfillment_method`.
     */
    fulfillmentType: text('fulfillment_type').notNull().default('delivery'),
    /** 'scheduled' | 'estimated' | 'asap' | 'will_call' */
    deliveryStatus: text('delivery_status'),
    deliveryInstructions: text('delivery_instructions'),
    // Pickup orders name which store hands the goods over; NULL means the
    // order's own selling location.
    pickupLocationId: uuid('pickup_location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    // Billing snapshot when it differs from the shipping snapshot below;
    // NULL means "same as customer record".
    billingAddressJson: jsonb('billing_address_json'),
    // Promotion-source tag ("LABOR-DAY-TV"); free text, reportable later.
    marketingCode: text('marketing_code'),
    // A20 (STORIS Step 1 "Marketing Code 2"): a second attribution tag.
    marketingCode2: text('marketing_code_2'),
    /** A20 "Order Source Entry": Walk-in / Phone / Web / Referral … (ops.orderSources). */
    orderSource: text('order_source'),
    /** A20 "Assign Payment Terminal": which reader took the card (ops.paymentTerminals). */
    paymentTerminal: text('payment_terminal'),
    /** A20 "View/Edit Exception Comments": why this order's exceptions happened. */
    exceptionNotes: text('exception_notes'),
    /** A20 "Trade/Designer Information": { name, company, phone, email, note }. */
    tradeDesignerJson: jsonb('trade_designer_json'),
    /** A20 "Custom Order Information": [{ label, value }] printed on the invoice. */
    customInfoJson: jsonb('custom_info_json'),
    // Step-3 charges. Kept as three named buckets (STORIS parity) rather
    // than fee lines; added to total_cents after tax, never taxed (v1).
    deliveryFeeCents: integer('delivery_fee_cents').notNull().default(0),
    installFeeCents: integer('install_fee_cents').notNull().default(0),
    otherFeeCents: integer('other_fee_cents').notNull().default(0),
    otherFeeLabel: text('other_fee_label'),
    // Address snapshot — the delivery goes where the customer said at
    // write time, even if their customer record changes later.
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    addressCity: text('address_city'),
    addressRegion: text('address_region'),
    addressPostalCode: text('address_postal_code'),
    addressPhone: text('address_phone'),
    requestedDate: date('requested_date'),
    notes: text('notes'),
    internalNotes: text('internal_notes'),
    /**
     * Opaque token for the customer-facing status page (/track/<token>).
     * NULL until staff share the order; the token is 48 hex chars of
     * crypto randomness, so possession of the link IS the authorization
     * — the public endpoint exposes only customer-safe fields.
     */
    publicToken: text('public_token'),
    /**
     * A1 lock: set when an *individual* delivery ticket is printed —
     * the order is "on the truck" and refuses edits until a permitted
     * role unlocks it with a typed reason (batch printing never sets
     * this). NULL = unlocked.
     */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /**
     * G9: how many times the delivery ticket has printed — reprints are
     * how merchandise walks out twice, so copy 2+ is logged and
     * registered.
     */
    ticketPrintCount: integer('ticket_print_count').notNull().default(0),
    /**
     * G9: an unlock is a 15-minute window, not a permanent state. Set
     * to now()+15min at unlock; past it, a printed order counts as
     * locked again (lazily — no job needed).
     */
    relockAt: timestamp('relock_at', { withTimezone: true }),
    // D8: legacy history imports carry these and are excluded from the
    // cash drawer, commission accrual, and webhook emission.
    importedAt: timestamp('imported_at', { withTimezone: true }),
    legacyNumber: text('legacy_number'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNumberUnique: uniqueIndex('orders_business_number_uniq').on(t.businessId, t.number),
    publicTokenUnique: uniqueIndex('orders_public_token_uniq').on(t.publicToken),
    businessIdx: index('orders_business_id_idx').on(t.businessId),
    locationIdx: index('orders_location_id_idx').on(t.locationId),
    customerIdx: index('orders_customer_id_idx').on(t.customerId),
    statusIdx: index('orders_status_idx').on(t.businessId, t.status),
    salespersonIdx: index('orders_salesperson_membership_id_idx').on(t.salespersonMembershipId),
    // Import re-runs (D7) upsert by legacy number; also the predicate the
    // D8 exclusions filter on.
    legacyNumberIdx: index('orders_business_legacy_number_idx').on(t.businessId, t.legacyNumber),
    splitBpsRange: check(
      'orders_split_bps_range',
      sql`${t.splitBps} IS NULL OR (${t.splitBps} >= 0 AND ${t.splitBps} <= 10000)`,
    ),
  }),
);

/**
 * Order lines. `qty_reserved` / `qty_fulfilled` track how much of the
 * ordered quantity is committed in stock and how much has physically
 * left, so an order can be partially delivered without losing the
 * remainder.
 *
 * `line_type='special_order'` marks a line we do not have and will buy
 * (G3) — those never reserve stock; they get a `po_line_allocations` row
 * on Day 4 instead.
 */
export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
    /**
     * Per-line fulfill-from: which location's stock THIS line reserves
     * and consumes. Null = the order's default (orders.stock_location_id,
     * else the selling location). Chosen at item selection in New Sale;
     * immutable while the line holds a reservation.
     */
    sourceLocationId: uuid('source_location_id').references(() => locations.id, {
      onDelete: 'restrict',
    }),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    qtyReserved: integer('qty_reserved').notNull().default(0),
    qtyFulfilled: integer('qty_fulfilled').notNull().default(0),
    /** §10: units taken back on a return (never exceeds qty_fulfilled). */
    qtyReturned: integer('qty_returned').notNull().default(0),
    /**
     * 'stock' | 'special_order' | 'custom' | 'direct_ship' (PO-060: the
     * vendor ships straight to the customer — never reserves stock; its
     * PO receipt fulfills the line without touching inventory).
     */
    lineType: text('line_type').notNull().default('stock'),
    unitPriceCents: integer('unit_price_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    // The rate this line was actually charged at, in basis points. Frozen
    // at write time so a later tax-class edit can't restate an order.
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    taxClassId: uuid('tax_class_id').references(() => taxClasses.id, { onDelete: 'set null' }),
    // Populated at fulfillment for serial-tracked products (G7, Day 4).
    serialUnitIds: uuid('serial_unit_ids').array(),
    /**
     * Per-line override of the order's fulfillment method (split ticket):
     * 'delivery' | 'pickup' | 'take_with' | 'direct_ship'. NULL inherits
     * the order default.
     */
    fulfillmentMethod: text('fulfillment_method'),
    // Per-line promised date when parts of an order arrive separately.
    deliveryDate: date('delivery_date'),
    // A20 (STORIS Step 2 line details). All optional; none affects money.
    /** "Line Comments": prints under the line on the invoice and delivery ticket. */
    comment: text('comment'),
    /** "Assign Rooms to Order": where the piece goes in the home (ops.rooms). */
    room: text('room'),
    /** "Assign Pieces": how many pieces the truck carries for one unit. */
    pieces: integer('pieces'),
    /** "Prep Codes": warehouse instructions from ops.prepCodes. */
    prepCodes: jsonb('prep_codes').$type<string[]>(),
    /** "Customer's Own Material": { supplied: true, description }. */
    comJson: jsonb('com_json'),
    /** "Direct Ship Details": { vendorName, vendorOrderRef, trackingNumber, expectedDate }. */
    directShipJson: jsonb('direct_ship_json'),
    /** "Maintain Linked Installation Line": the order's installation fee covers this line. */
    needsInstall: boolean('needs_install').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('order_lines_order_id_idx').on(t.orderId),
    businessIdx: index('order_lines_business_id_idx').on(t.businessId),
    variantIdx: index('order_lines_variant_id_idx').on(t.variantId),
    // Drives the Day 4 "to-order queue": special-order lines not yet
    // fully allocated to a PO.
    lineTypeIdx: index('order_lines_business_line_type_idx').on(t.businessId, t.lineType),
    quantityPositive: check('order_lines_quantity_positive', sql`${t.quantity} > 0`),
    reservedRange: check(
      'order_lines_reserved_range',
      sql`${t.qtyReserved} >= 0 AND ${t.qtyReserved} <= ${t.quantity}`,
    ),
    fulfilledRange: check(
      'order_lines_fulfilled_range',
      sql`${t.qtyFulfilled} >= 0 AND ${t.qtyFulfilled} <= ${t.quantity}`,
    ),
  }),
);

/**
 * A delivery run / manifest (PLAN-STORIS-GAP §4 / G7, STORIS "Build a
 * Delivery Manifest"): the truck's day as a real object. Membership on
 * an open run is the HARD lock on the underlying orders (amendment A5);
 * close-out is the mandatory reconciliation — every stop ends
 * delivered, failed (coded reason, auto-reschedule), and the COD due
 * vs collected variance is registered.
 */
export const deliveryRuns = pgTable(
  'delivery_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    runDate: date('run_date').notNull(),
    route: text('route'),
    /** Free truck label until a truck entity exists ("Box truck 1"). */
    truck: text('truck'),
    driverMembershipId: uuid('driver_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    /** 'open' | 'out' | 'completed' */
    status: text('status').notNull().default('open'),
    notes: text('notes'),
    codDueCents: integer('cod_due_cents').notNull().default(0),
    codCollectedCents: integer('cod_collected_cents'),
    /** Who the driver handed the money to, from the close-out screen. */
    codReceivedBy: text('cod_received_by'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByUserId: uuid('completed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    businessIdx: index('delivery_runs_business_id_idx').on(t.businessId),
    dateIdx: index('delivery_runs_date_idx').on(t.businessId, t.runDate),
    statusIdx: index('delivery_runs_status_idx').on(t.businessId, t.status),
  }),
);

/**
 * A scheduled trip that moves some or all of an order's lines to the
 * customer (G2). An order can need several — the sofa is in stock today,
 * the matching chair arrives next month.
 *
 * Status lifecycle:
 *   scheduled → loaded → out_for_delivery → delivered
 *            └──── failed / cancelled ────┘
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /**
     * A22 slice 6: 'delivery' (goods out) | 'return_pickup' (the truck
     * collects a return — completing it receives the goods back instead
     * of fulfilling the order). `returnId` names the return document.
     */
    kind: text('kind').notNull().default('delivery'),
    returnId: uuid('return_id'),
    scheduledDate: date('scheduled_date').notNull(),
    // Local wall-clock window ("09:00"–"12:00"); the location's timezone
    // supplies the offset. Stored without a zone on purpose — a route is
    // planned in store time, not UTC.
    windowStart: time('window_start'),
    windowEnd: time('window_end'),
    /**
     * Delivery-ticket flag (erp-delivery-reprints 01/02): null = never
     * printed, 'P' = printed and current, 'R' = printed but stale —
     * reprint required (advisory, never blocking). Written only through
     * the ticket-flags state machine.
     */
    ticketFlag: text('ticket_flag'),
    /** Coupled to ticket_flag by invariant R7 (never survives a null ticket). */
    pickListFlag: text('pick_list_flag'),
    /**
     * 'scheduled' | 'loaded' | 'out_for_delivery' | 'delivered' | 'failed'
     * | 'cancelled'
     */
    status: text('status').notNull().default('scheduled'),
    driverMembershipId: uuid('driver_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    // Ordinal within the day's route; the calendar drag-reorders these.
    routePosition: integer('route_position'),
    /**
     * Route label (§7): auto-suggested from the ship-to zip at
     * scheduling ("900xx"), freely editable by the dispatcher.
     */
    route: text('route'),
    /** G7: membership on an open run hard-locks the order (A5). */
    runId: uuid('run_id').references(() => deliveryRuns.id, { onDelete: 'set null' }),
    /** G7: coded reason (class `delivery_failure`) when the stop fails. */
    failureReasonCodeId: uuid('failure_reason_code_id').references(() => reasonCodes.id, {
      onDelete: 'set null',
    }),
    /**
     * A22 slice 5 (STORIS Confirm Schedule "Contact Status"): where the
     * confirmation call stands — 'not_contacted' | 'left_message' |
     * 'no_answer' | 'confirmed' | 'reschedule_requested'. Null = never
     * touched; `contactedAt` stamps the last change.
     */
    contactStatus: text('contact_status'),
    contactedAt: timestamp('contacted_at', { withTimezone: true }),
    notes: text('notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('deliveries_business_id_idx').on(t.businessId),
    runIdx: index('deliveries_run_id_idx').on(t.runId),
    orderIdx: index('deliveries_order_id_idx').on(t.orderId),
    // The calendar's primary query: one location's board for a date range.
    calendarIdx: index('deliveries_location_scheduled_date_idx').on(t.locationId, t.scheduledDate),
    statusIdx: index('deliveries_status_idx').on(t.businessId, t.status),
    driverIdx: index('deliveries_driver_membership_id_idx').on(t.driverMembershipId),
  }),
);

/** Which order lines (and how many units of each) ride on a delivery. */
export const deliveryLines = pgTable(
  'delivery_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),
    /** Per-line ticket flag — see deliveries.ticket_flag. */
    ticketFlag: text('ticket_flag'),
    pickListFlag: text('pick_list_flag'),
  },
  (t) => ({
    deliveryIdx: index('delivery_lines_delivery_id_idx').on(t.deliveryId),
    businessIdx: index('delivery_lines_business_id_idx').on(t.businessId),
    orderLineIdx: index('delivery_lines_order_line_id_idx').on(t.orderLineId),
    quantityPositive: check('delivery_lines_quantity_positive', sql`${t.quantity} > 0`),
  }),
);

/**
 * Free-form notes on an order (owner ask 2026-09-01): anyone who can see
 * the order can leave one, and every note keeps its author and time.
 * Append-only — the order's `notes`/`internal_notes` columns stay the
 * printed/customer-facing text; this is the running conversation.
 */
/**
 * A20 (STORIS "Add / Edit / View Attachments"): files pinned to an order
 * or to one of its lines — a signed quote, a floor-plan photo, a vendor
 * confirmation. No object store is provisioned, so the bytes live here
 * (base64, ≤ 5 MB each, 25 per order) and are served through the API
 * with the order's own permissions.
 */
export const orderAttachments = pgTable(
  'order_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id').references(() => orderLines.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Base64 of the file body. */
    dataBase64: text('data_base64').notNull(),
    note: text('note'),
    uploadedByMembershipId: uuid('uploaded_by_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('order_attachments_order_id_idx').on(t.orderId, t.createdAt),
    businessIdx: index('order_attachments_business_id_idx').on(t.businessId),
    sizePositive: check('order_attachments_size_positive', sql`${t.sizeBytes} > 0`),
  }),
);

export const orderNotes = pgTable(
  'order_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    authorMembershipId: uuid('author_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    mentionedMembershipIds: jsonb('mentioned_membership_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('order_notes_order_id_idx').on(t.orderId, t.createdAt),
    businessIdx: index('order_notes_business_id_idx').on(t.businessId),
  }),
);
