import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { categoryPathSql, joinCategoryPath } from '../catalog/category-tree';

/**
 * The report-builder source-file catalog (pack 01/03). Sources and
 * their SYSTEM dictionaries are code: this file is the only place that
 * knows physical columns. Authors see dictionaries, never columns.
 *
 * Tenancy is structural — every query runs on the request-scoped RLS
 * db, and businessId never appears as an authorable dictionary.
 */

export interface SystemDictionary {
  name: string;
  description: string;
  columnHeading: string;
  width: number;
  justification: 'left' | 'right' | 'centered';
  /** Drives conversion at render + which aggregations make sense. */
  type: 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean';
  /** Pack 07 layer 3: permission required to SEE the data (masking). */
  maskPermission?: string;
  /** Pack 01: keys kept out of the builder to protect integrity. */
  selectableInBuilder?: boolean;
  expr: PgColumn | SQL;
}

/** Relation graph edge for the File Join Assistant (pack 03). */
export interface SourceRelation {
  /** The related source whose dictionaries may be grafted here. */
  sourceId: string;
  /** Host-side column equated to the join source's key column. */
  hostKey: PgColumn | SQL;
  /** Join-source key column (on that source's base table). */
  joinKey: PgColumn;
}

export interface ReportSource {
  id: string;
  name: string;
  description: string;
  /** Pack 07 layer 2 mapped to Jetnine: source-level permission gate. */
  requiredPermission: string;
  dictionaries: SystemDictionary[];
  relations: SourceRelation[];
  /** Deterministic sort tiebreaker (pack 12 rec #5): the base pk. */
  tiebreaker: PgColumn;
  /**
   * Base query builder: FROM + fixed joins. The runner adds the
   * SELECT map, WHERE, ORDER BY, LIMIT.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(q: any): any;
}

const money = (
  name: string,
  heading: string,
  expr: PgColumn | SQL,
  over: Partial<SystemDictionary> = {},
): SystemDictionary => ({
  name,
  description: heading,
  columnHeading: heading,
  width: 12,
  justification: 'right',
  type: 'money',
  expr,
  ...over,
});
const textd = (
  name: string,
  heading: string,
  expr: PgColumn | SQL,
  over: Partial<SystemDictionary> = {},
): SystemDictionary => ({
  name,
  description: heading,
  columnHeading: heading,
  width: 18,
  justification: 'left',
  type: 'text',
  expr,
  ...over,
});
const dated = (
  name: string,
  heading: string,
  expr: PgColumn | SQL,
  over: Partial<SystemDictionary> = {},
): SystemDictionary => ({
  name,
  description: heading,
  columnHeading: heading,
  width: 10,
  justification: 'left',
  type: 'date',
  expr,
  ...over,
});
const numd = (
  name: string,
  heading: string,
  expr: PgColumn | SQL,
  over: Partial<SystemDictionary> = {},
): SystemDictionary => ({
  name,
  description: heading,
  columnHeading: heading,
  width: 8,
  justification: 'right',
  type: 'number',
  expr,
  ...over,
});

/** The pack's shipped "Cost" field security code equivalent. */
export const COST_MASK = 'reports.cost.view';

export const REPORT_SOURCES: ReportSource[] = [
  {
    id: 'orders',
    name: 'Sales orders',
    description: 'Order headers with customer, location, and money totals',
    requiredPermission: 'reports.sales.view',
    dictionaries: [
      textd('ORDER_NUMBER', 'Order #', schema.orders.number, { width: 14 }),
      textd('STATUS', 'Status', schema.orders.status, { width: 12 }),
      textd('ORDER_KIND', 'Kind', schema.orders.orderKind, { width: 12 }),
      textd('FULFILLMENT', 'Fulfillment', schema.orders.fulfillmentType, { width: 10 }),
      dated('WRITTEN_DATE', 'Written', sql`${schema.orders.createdAt}::date`),
      dated('COMPLETED_DATE', 'Completed', sql`${schema.orders.completedAt}::date`),
      dated('REQUESTED_DATE', 'Requested', schema.orders.requestedDate),
      textd('LOCATION', 'Location', schema.locations.name, { width: 14 }),
      textd(
        'CUSTOMER',
        'Customer',
        sql`TRIM(COALESCE(${schema.customers.firstName}, '') || ' ' || COALESCE(${schema.customers.lastName}, ''))`,
        { width: 22 },
      ),
      textd('CUSTOMER_EMAIL', 'Email', schema.customers.email, { width: 24 }),
      money('SUBTOTAL', 'Subtotal', schema.orders.subtotalCents),
      money('DISCOUNT', 'Discount', schema.orders.discountCents),
      money('TAX', 'Tax', schema.orders.taxCents),
      money('TOTAL', 'Total', schema.orders.totalCents),
      money('DEPOSIT_REQUIRED', 'Deposit req.', schema.orders.depositRequiredCents),
      textd('MARKETING_CODE', 'Marketing', schema.orders.marketingCode, { width: 14 }),
      textd('ORDER_ID', 'Order id', schema.orders.id, {
        selectableInBuilder: false,
        width: 36,
      }),
      textd('CUSTOMER_ID', 'Customer id', schema.orders.customerId, {
        selectableInBuilder: false,
        width: 36,
      }),
    ],
    tiebreaker: schema.orders.id,
    relations: [
      {
        sourceId: 'customers',
        hostKey: schema.orders.customerId,
        joinKey: schema.customers.id,
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(q: any) {
      return q
        .from(schema.orders)
        .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
        .leftJoin(schema.locations, eq(schema.locations.id, schema.orders.locationId));
    },
  },
  {
    id: 'sales',
    name: 'POS sales',
    description: 'Completed point-of-sale transactions',
    requiredPermission: 'reports.sales.view',
    dictionaries: [
      textd('SALE_NUMBER', 'Sale #', schema.sales.number, { width: 14 }),
      textd('STATUS', 'Status', schema.sales.status, { width: 14 }),
      dated('SALE_DATE', 'Date', sql`${schema.sales.completedAt}::date`),
      textd('LOCATION', 'Location', schema.locations.name, { width: 14 }),
      money('SUBTOTAL', 'Subtotal', schema.sales.subtotalCents),
      money('DISCOUNT', 'Discount', schema.sales.discountCents),
      money('TAX', 'Tax', schema.sales.taxCents),
      money('TOTAL', 'Total', schema.sales.totalCents),
    ],
    tiebreaker: schema.sales.id,
    relations: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(q: any) {
      return q
        .from(schema.sales)
        .leftJoin(schema.locations, eq(schema.locations.id, schema.sales.locationId));
    },
  },
  {
    id: 'customers',
    name: 'Customers',
    description: 'Customer master records',
    requiredPermission: 'customers.view',
    dictionaries: [
      textd('FIRST_NAME', 'First name', schema.customers.firstName, { width: 14 }),
      textd('LAST_NAME', 'Last name', schema.customers.lastName, { width: 16 }),
      textd('EMAIL_ADDR', 'Email', schema.customers.email, { width: 26 }),
      textd('PHONE', 'Phone', schema.customers.phone, { width: 14 }),
      dated('CREATED_DATE', 'Created', sql`${schema.customers.createdAt}::date`),
      textd('CUSTOMER_ID', 'Customer id', schema.customers.id, {
        selectableInBuilder: false,
        width: 36,
      }),
    ],
    tiebreaker: schema.customers.id,
    relations: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(q: any) {
      return q.from(schema.customers);
    },
  },
  {
    id: 'products',
    name: 'Products',
    description: 'Product variants with vendor, category, price and cost',
    requiredPermission: 'products.view',
    dictionaries: [
      textd('PRODUCT_NAME', 'Product', schema.products.name, { width: 24 }),
      textd('VARIANT_NAME', 'Variant', schema.productVariants.name, { width: 16 }),
      textd('SKU', 'SKU', schema.productVariants.sku, { width: 14 }),
      textd('CATEGORY', 'Category', categoryPathSql, { width: 24 }),
      textd('VENDOR', 'Vendor', schema.vendors.name, { width: 18 }),
      money('PRICE', 'Price', schema.productVariants.priceCents),
      money('COST', 'Cost', schema.productVariants.costCents, { maskPermission: COST_MASK }),
      numd('CAPACITY_UNITS', 'Cap. units', schema.productVariants.capacityUnits),
      textd(
        'ACTIVE',
        'Active',
        sql`CASE WHEN ${schema.productVariants.isActive} THEN 'Y' ELSE 'N' END`,
        {
          width: 6,
          justification: 'centered',
        },
      ),
      textd('VARIANT_ID', 'Variant id', schema.productVariants.id, {
        selectableInBuilder: false,
        width: 36,
      }),
    ],
    tiebreaker: schema.productVariants.id,
    relations: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(q: any) {
      return joinCategoryPath(
        q
          .from(schema.productVariants)
          .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
          .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId)),
      ).leftJoin(schema.vendors, eq(schema.vendors.id, schema.productVariants.preferredVendorId));
    },
  },
  {
    id: 'purchase_orders',
    name: 'Purchase orders',
    description: 'PO headers with vendor and status',
    requiredPermission: 'purchase_orders.view',
    dictionaries: [
      textd('PO_NUMBER', 'PO #', schema.purchaseOrders.number, { width: 14 }),
      textd('STATUS', 'Status', schema.purchaseOrders.status, { width: 14 }),
      textd('VENDOR', 'Vendor', schema.vendors.name, { width: 18 }),
      textd('LOCATION', 'Location', schema.locations.name, { width: 14 }),
      dated('CREATED_DATE', 'Created', sql`${schema.purchaseOrders.createdAt}::date`),
      dated('EXPECTED_DATE', 'Expected', sql`${schema.purchaseOrders.expectedAt}::date`),
      money('SUBTOTAL', 'Subtotal', schema.purchaseOrders.subtotalCents, {
        maskPermission: COST_MASK,
      }),
      textd(
        'DIRECT_SHIP',
        'Direct ship',
        sql`CASE WHEN ${schema.purchaseOrders.directShip} THEN 'Y' ELSE 'N' END`,
        { width: 6, justification: 'centered' },
      ),
    ],
    tiebreaker: schema.purchaseOrders.id,
    relations: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(q: any) {
      return q
        .from(schema.purchaseOrders)
        .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
        .leftJoin(schema.locations, eq(schema.locations.id, schema.purchaseOrders.locationId));
    },
  },
];

export function getSource(id: string): ReportSource | undefined {
  return REPORT_SOURCES.find((s) => s.id === id);
}

export function getSystemDictionary(
  source: ReportSource,
  name: string,
): SystemDictionary | undefined {
  return source.dictionaries.find((d) => d.name === name);
}

/**
 * Resolve a joined dictionary (pack 03) into a correlated scalar
 * subquery — first-match semantics per the pack's `12` recommendation
 * #3: a LEFT-JOIN-pick-one, never row fan-out.
 */
export function joinedExpr(
  host: ReportSource,
  joinSourceId: string,
  joinFieldName: string,
): { expr: SQL; dict: SystemDictionary } | null {
  const rel = host.relations.find((r) => r.sourceId === joinSourceId);
  if (!rel) return null;
  const joinSource = getSource(joinSourceId);
  if (!joinSource) return null;
  const dict = getSystemDictionary(joinSource, joinFieldName);
  if (!dict) return null;
  const table = rel.joinKey.table;
  const expr = sql`(SELECT ${dict.expr} FROM ${table} WHERE ${rel.joinKey} = ${rel.hostKey} LIMIT 1)`;
  return { expr, dict };
}

// Used by the tests + db handle typing.
export type ReportDb = PostgresJsDatabase;
