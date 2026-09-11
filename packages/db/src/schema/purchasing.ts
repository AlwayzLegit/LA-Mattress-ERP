import {
  boolean,
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
import { businesses, users } from './platform';
import { locations } from './tenancy';
import { collections, productVariants } from './catalog';

/**
 * Suppliers / vendors that the business buys from. Kept lightweight —
 * just enough contact info to write a PO and reorder. Full vendor
 * portals (statements, payment terms, PO emailing) are explicit
 * future work.
 */
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    email: text('email'),
    phone: text('phone'),
    addressJson: jsonb('address_json'),
    /**
     * G11: where payments go. Changing this is the classic vendor-master
     * fraud, so every change is separately audited and alerts the owner.
     */
    remitTo: text('remit_to'),
    notes: text('notes'),
    /**
     * Sales-rate PO replenishment settings (HANDOFF-po-replenishment-
     * sales-rate §6, Advanced Vendor Settings → Auto PO Replen), one
     * document per vendor: generateAutomaticPos, automaticallyHoldPos,
     * weeklySalesRateWeeks, includeAllBackOrders, daysForReplenishment,
     * minimumStockDays, leadDays, variancePercent (+start/end),
     * minimumSalesRate, buildDays[0-6], categoryExceptions[]. Null =
     * vendor not enabled for sales-rate replenishment.
     */
    replenishmentJson: jsonb('replenishment_json'),
    /**
     * Advanced Vendor Settings → Shipping (owner 2026-09-02, STORIS):
     * landed-cost lines — freight, import fee, misc fee and two custom
     * lines — each {active, type: percent|dollar|calculate, percent,
     * cents, label}. Active percent/dollar lines default a new PO's
     * freight (landed cost lean, Q1); "calculate" lines are entered from
     * the vendor invoice. Null = nothing configured.
     */
    landedCostJson: jsonb('landed_cost_json'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNameUnique: uniqueIndex('vendors_business_name_uniq').on(t.businessId, t.name),
    businessIdx: index('vendors_business_id_idx').on(t.businessId),
  }),
);

/**
 * Purchase orders. Status lifecycle:
 *   draft → ordered → partially_received → received → closed
 *                  └──────── canceled ───────────┘
 * Receipts against the PO go through inventory_movements with
 * reason='receive_po' and reference_type='purchase_order'.
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    /** 'draft' | 'ordered' | 'partially_received' | 'received' | 'canceled' */
    status: text('status').notNull(),
    expectedAt: timestamp('expected_at', { withTimezone: true }),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    /**
     * Landed cost lean (run-02 Q1, owner 2026-08-28): one freight amount
     * for the whole PO, spread per ordered unit into the FIFO layer cost
     * at receipt. Null = no freight. Editable only before any receipt.
     */
    freightCents: integer('freight_cents'),
    /**
     * PO-060 (I7/B15): the vendor ships straight to the customer. The
     * goods never touch our inventory — receiving posts cost of sale and
     * fulfills the linked sales-order lines instead of raising stock.
     */
    directShip: boolean('direct_ship').notNull().default(false),
    /** Direct-ship only: customer ship-to snapshot {name, phone, email, address}. */
    shipToJson: jsonb('ship_to_json'),
    notes: text('notes'),
    /**
     * A22 slice 7 (STORIS Print a Purchase Order): how many times the
     * vendor document was printed and when last — a second print is a
     * reprint, and the batch screen can pick "not yet printed".
     */
    printCount: integer('print_count').notNull().default(0),
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Soft delete for drafts (CR 2026-08-31). A draft PO had no exit:
     * the only way to retire one was to place it — recording a vendor
     * commitment that never existed — and then cancel it. Deleting
     * stamps these two columns and keeps the row, so the number stays
     * spoken for and can never be handed to a different order. Gaps in
     * the sequence are expected and correct.
     *
     * Only drafts are ever deletable; a placed PO cancels instead.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNumberUnique: uniqueIndex('purchase_orders_business_number_uniq').on(
      t.businessId,
      t.number,
    ),
    vendorIdx: index('purchase_orders_vendor_id_idx').on(t.vendorId),
    locationIdx: index('purchase_orders_location_id_idx').on(t.locationId),
    statusIdx: index('purchase_orders_status_idx').on(t.businessId, t.status),
    // The default list excludes deleted rows, so the index it reads
    // carries the flag.
    liveIdx: index('purchase_orders_live_idx').on(t.businessId, t.deletedAt, t.createdAt),
  }),
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    quantityOrdered: integer('quantity_ordered').notNull(),
    quantityReceived: integer('quantity_received').notNull().default(0),
    /**
     * Receiving stages (PLAN-POS-OPERATIONS §6): received at the dock →
     * inspected → accepted into sellable stock. Invariant per line:
     * ordered ≥ received ≥ inspected ≥ accepted. Stock and the linked
     * sales-order reservation move at ACCEPT, not at dock receipt.
     */
    quantityInspected: integer('quantity_inspected').notNull().default(0),
    quantityAccepted: integer('quantity_accepted').notNull().default(0),
    /** G11 third bucket: inspected units that failed — dispositioned via As-Is. */
    quantityRejected: integer('quantity_rejected').notNull().default(0),
    unitCostCents: integer('unit_cost_cents').notNull(),
    lineTotalCents: integer('line_total_cents').notNull(),
  },
  (t) => ({
    poIdx: index('purchase_order_lines_po_id_idx').on(t.purchaseOrderId),
    businessIdx: index('purchase_order_lines_business_id_idx').on(t.businessId),
    variantIdx: index('purchase_order_lines_variant_id_idx').on(t.variantId),
  }),
);

/**
 * The bridge between a customer's special-order line and the PO line
 * that buys it (STORIS cutover G3). Receiving against the PO line walks
 * these allocations: 'ordered' units become 'received', the customer's
 * order line reserves the just-arrived stock, and the store emails
 * "your item is in".
 */
export const poLineAllocations = pgTable(
  'po_line_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    poLineId: uuid('po_line_id')
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: 'cascade' }),
    orderLineId: uuid('order_line_id').notNull(),
    quantity: integer('quantity').notNull(),
    /** 'ordered' | 'received' | 'cancelled' */
    status: text('status').notNull().default('ordered'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('po_line_allocations_business_id_idx').on(t.businessId),
    poLineIdx: index('po_line_allocations_po_line_id_idx').on(t.poLineId),
    orderLineIdx: index('po_line_allocations_order_line_id_idx').on(t.orderLineId),
  }),
);

/**
 * Vendor invoices (PLAN-POS-OPERATIONS §6): the vendor's bill, recorded
 * and auto-matched to a purchase order by PO number for approval. No
 * landed cost / freight allocation in v1 — the variance against the
 * PO's subtotal is surfaced, not allocated.
 */
export const vendorInvoices = pgTable(
  'vendor_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    /** NULL until (auto-)matched to a PO. */
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id, {
      onDelete: 'set null',
    }),
    /** The vendor's own invoice number. */
    number: text('number').notNull(),
    invoiceDate: date('invoice_date'),
    totalCents: integer('total_cents').notNull(),
    /** 'unmatched' | 'matched' | 'approved' */
    status: text('status').notNull().default('unmatched'),
    notes: text('notes'),
    /** G11 SoD: who keyed the invoice — the approver must differ. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('vendor_invoices_business_id_idx').on(t.businessId),
    vendorIdx: index('vendor_invoices_vendor_id_idx').on(t.vendorId),
    poIdx: index('vendor_invoices_purchase_order_id_idx').on(t.purchaseOrderId),
    statusIdx: index('vendor_invoices_status_idx').on(t.businessId, t.status),
    // One row per vendor invoice number per vendor — re-recording the
    // same bill is a mistake, not a new payable.
    numberUnique: uniqueIndex('vendor_invoices_vendor_number_unique').on(t.vendorId, t.number),
  }),
);

/**
 * Advanced Vendor Settings → PO Cutting Date (owner 2026-09-02, STORIS
 * "Collection Exceptions"): the last day a purchase order may be cut for
 * a vendor's collection. After it, PO creation and placement refuse
 * lines from that collection and sales-rate replenishment drops them.
 */
export const vendorPoCuttingDates = pgTable(
  'vendor_po_cutting_dates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    cuttingDate: date('cutting_date').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vendorCollectionUnique: uniqueIndex('vendor_po_cutting_dates_vendor_collection_uniq').on(
      t.vendorId,
      t.collectionId,
    ),
    businessIdx: index('vendor_po_cutting_dates_business_id_idx').on(t.businessId),
    vendorIdx: index('vendor_po_cutting_dates_vendor_id_idx').on(t.vendorId),
  }),
);
