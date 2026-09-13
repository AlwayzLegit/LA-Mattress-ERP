import {
  type AnyPgColumn,
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
import { businesses } from './platform';
import { taxClasses } from './taxes';
import { vendors } from './purchasing';
import { tsvector } from '../types';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('categories_business_id_idx').on(t.businessId),
    parentIdx: index('categories_parent_id_idx').on(t.parentId),
  }),
);

/**
 * Brand + Collection reference entities (STORIS Brand Settings /
 * Collection Settings parity, owner-scoped build 2026-08-27). Brands
 * are flat labels; collections optionally belong to a vendor (the
 * Ashley-style vendor collection). Products reference both nullable —
 * the P4 invoice Brand column prefers the real brand and falls back
 * to the variant's preferred vendor for unbranded catalog rows.
 */
export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNameUnique: uniqueIndex('brands_business_name_uniq').on(t.businessId, t.name),
    businessIdx: index('brands_business_id_idx').on(t.businessId),
  }),
);

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessNameUnique: uniqueIndex('collections_business_name_uniq').on(t.businessId, t.name),
    businessIdx: index('collections_business_id_idx').on(t.businessId),
  }),
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    sku: text('sku'),
    name: text('name').notNull(),
    description: text('description'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    /**
     * Optional tax class override. When null, the sale uses the
     * location/business default tax rate; when set, the line tax
     * uses this class's `rate_bps` regardless of location.
     */
    taxClassId: uuid('tax_class_id').references(() => taxClasses.id, { onDelete: 'set null' }),
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    collectionId: uuid('collection_id').references(() => collections.id, { onDelete: 'set null' }),
    serialTracked: boolean('serial_tracked').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    // STORIS Advanced Product Settings (amendment A19, owner 2026-09-10).
    // `name` is STORIS's Description; this is its Second Description.
    secondDescription: text('second_description'),
    /**
     * STORIS Purchase Status — whether the buyer may still order it:
     * 'active' | 'discontinued' | 'special_order' | 'closeout'
     * (PRODUCT_PURCHASE_STATUSES in @jetnine/shared). Independent of
     * `is_active`, which is the selling switch (Product Status).
     */
    purchaseStatus: text('purchase_status').notNull().default('active'),
    // Packing: how many boxes one unit ships as, and the carton
    // multiples purchasing and transfers move it in.
    boxesPerProduct: integer('boxes_per_product').notNull().default(1),
    logisticalCartonQty: integer('logistical_carton_qty').notNull().default(1),
    purchaseCartonQty: integer('purchase_carton_qty').notNull().default(1),
    logisticalCartonTransfers: boolean('logistical_carton_transfers').notNull().default(false),
    /**
     * A21 (View Product Activity → General Information): STORIS Suggested
     * Retail Price, display only — selling price stays on the variant.
     */
    suggestedRetailCents: integer('suggested_retail_cents'),
    /**
     * A21 Shipping Information block: {weightLb, heightIn, widthIn,
     * depthIn, shippingVolume, deliveryVolume} — numbers or null. Display
     * and print only; delivery capacity keeps using variant capacity units.
     */
    shippingJson: jsonb('shipping_json'),
    // Generated tsvector (set by the migration via GENERATED ALWAYS AS).
    // Drizzle's pg-core doesn't model generated columns directly, so the
    // column is declared here only so tools that introspect the schema know
    // it exists; reads/writes go through the migration-side definition.
    searchTsv: tsvector('search_tsv'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessSkuUnique: uniqueIndex('products_business_sku_uniq').on(t.businessId, t.sku),
    businessIdx: index('products_business_id_idx').on(t.businessId),
    categoryIdx: index('products_category_id_idx').on(t.categoryId),
  }),
);

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Denormalized from product_id so RLS can use it without an extra join.
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku'),
    name: text('name'),
    attributesJson: jsonb('attributes_json'),
    priceCents: integer('price_cents').notNull(),
    costCents: integer('cost_cents'),
    barcode: text('barcode'),
    /**
     * Reorder automation. NULL reorderPoint = not managed. Trigger:
     * available (on-hand − reserved, summed across locations) at or
     * below the point. Suggested order = reorderQty when set, else
     * top-up to 2× the point (a simple min/max heuristic).
     */
    reorderPoint: integer('reorder_point'),
    reorderQty: integer('reorder_qty'),
    /**
     * G12 (STORIS Product Group Capacity Units): how much of a truck-day
     * one unit consumes — a king set with an adjustable base is not a
     * twin. Arbitrary units; ops sets the per-day budget.
     */
    capacityUnits: integer('capacity_units').notNull().default(1),
    preferredVendorId: uuid('preferred_vendor_id').references(() => vendors.id, {
      onDelete: 'set null',
    }),
    /**
     * The vendor's own part number for this variant, when it differs
     * from our selling `sku` (e.g. Shopify-synced SKUs vs supplier
     * catalogs). Purchasing surfaces (reorder suggestions, PO lines)
     * print this to the vendor, falling back to `sku` when unset.
     */
    vendorSku: text('vendor_sku'),
    /**
     * A22.2: the bedding size this variant is ("Queen", "Split Cal
     * King"; MATTRESS_SIZES in @jetnine/shared) and its firmness ("Plush"
     * … "Extra Firm"; FIRMNESS_LEVELS). Set from the STORIS group code /
     * the name on import, editable on the product page, null when the
     * item fits several sizes or has no firmness. Both ride in
     * search_tsv so free text finds "queen bamboo sheets".
     */
    size: text('size'),
    firmness: text('firmness'),
    isActive: boolean('is_active').notNull().default(true),
    searchTsv: tsvector('search_tsv'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('product_variants_product_id_idx').on(t.productId),
    businessIdx: index('product_variants_business_id_idx').on(t.businessId),
    barcodeIdx: index('product_variants_barcode_idx').on(t.businessId, t.barcode),
    skuIdx: index('product_variants_sku_idx').on(t.businessId, t.sku),
    sizeIdx: index('product_variants_size_idx').on(t.businessId, t.size),
  }),
);

// Image references attached to a product. The actual bytes live in R2;
// we only persist the storage key + display metadata. Max 4 images per
// product is enforced in the controller.
export const productImages = pgTable(
  'product_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    altText: text('alt_text'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('product_images_product_id_idx').on(t.productId),
    businessIdx: index('product_images_business_id_idx').on(t.businessId),
  }),
);
