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
import { businesses, users } from './platform';
import { locations } from './tenancy';
import { productVariants } from './catalog';
import { reasonCodes } from './controls';

/**
 * Warehouse storage bins (STORIS Tracked Storage Location parity, lean —
 * owner-scoped build 2026-08-27). A bin is a named slot inside one
 * location ("DOCK", "A-14"); stock levels optionally point at the bin
 * that holds them so pick lists and receiving know where to walk.
 * Deactivate-not-delete, unique code per location.
 */
export const storageBins = pgTable(
  'storage_bins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    locationCodeUnique: uniqueIndex('storage_bins_location_code_uniq').on(t.locationId, t.code),
    businessIdx: index('storage_bins_business_id_idx').on(t.businessId),
    locationIdx: index('storage_bins_location_id_idx').on(t.locationId),
  }),
);

// Snapshot of stock per (variant, location). Updated transactionally alongside
// movements; movements are the source of truth.
export const inventoryLevels = pgTable(
  'inventory_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    /**
     * J2 (XFR-030/STK-020): units held as floor samples — physically on
     * hand but never sellable or reservable as new. Set by receiving a
     * floor_sample transfer or the manual hold; available stock is
     * `on_hand - reserved - floor_sample` everywhere.
     */
    floorSample: integer('floor_sample').notNull().default(0),
    /**
     * STORIS "Min Stock" per store (owner 2026-09-03 catalog load): the
     * minimum on hand this location wants. The variant's reorderPoint is
     * kept as the sum across locations so REPL-040 suggestions still
     * work; this keeps the per-store number for per-store replenishment.
     */
    reorderPoint: integer('reorder_point'),
    // Where the stock physically sits inside the location (nullable — most
    // catalogs start unbinned). Set-null so deleting a bin never blocks.
    storageBinId: uuid('storage_bin_id').references(() => storageBins.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    variantLocationUnique: uniqueIndex('inventory_levels_variant_location_uniq').on(
      t.variantId,
      t.locationId,
    ),
    businessIdx: index('inventory_levels_business_id_idx').on(t.businessId),
  }),
);

// Append-only ledger. on_hand on inventory_levels is derived from these.
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    // 'sale' | 'return' | 'adjustment' | 'receive' | 'transfer' | 'write_off'
    // | 'as_is_intake' | 'as_is_restock' | 'order_reserve' | 'order_release' …
    reason: text('reason').notNull(),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    /**
     * A22 slice 3 (STORIS Stock Adjustment "Reason Code"): the coded
     * reason behind a manual adjustment or write-off, so the ledger and
     * the shrink report can group by it. Free-text `notes` stays the
     * fallback while a business has no codes of the class.
     */
    reasonCodeId: uuid('reason_code_id').references(() => reasonCodes.id, {
      onDelete: 'set null',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('inventory_movements_business_id_idx').on(t.businessId),
    variantIdx: index('inventory_movements_variant_id_idx').on(t.variantId),
    locationIdx: index('inventory_movements_location_id_idx').on(t.locationId),
    referenceIdx: index('inventory_movements_reference_idx').on(t.referenceType, t.referenceId),
  }),
);

/**
 * Individually-tracked units (STORIS cutover G7, lean). A serial exists
 * once per physical unit; its status walks in_stock → committed (picked
 * for an order line) → sold (fulfilled), with in_service/returned for
 * the service loop. Only variants of serial-tracked products get rows.
 */
export const serialUnits = pgTable(
  'serial_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    serial: text('serial').notNull(),
    /** 'in_stock' | 'committed' | 'sold' | 'in_service' | 'returned'
     *  (back from a customer, or staged in as-is review)
     *  | 'in_transit' (riding a transfer, J3) | 'floor_sample' (J2). */
    status: text('status').notNull().default('in_stock'),
    orderLineId: uuid('order_line_id'),
    customerId: uuid('customer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessSerialUnique: uniqueIndex('serial_units_business_variant_serial_uniq').on(
      t.businessId,
      t.variantId,
      t.serial,
    ),
    businessIdx: index('serial_units_business_id_idx').on(t.businessId),
    variantIdx: index('serial_units_variant_id_idx').on(t.variantId, t.locationId, t.status),
    orderLineIdx: index('serial_units_order_line_id_idx').on(t.orderLineId),
  }),
);
