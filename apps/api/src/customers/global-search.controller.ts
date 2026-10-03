import { Controller, Get, Inject, Query } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

export interface SearchResults {
  customers: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    customerNumber: string | null;
  }[];
  orders: {
    id: string;
    number: string;
    legacyNumber: string | null;
    status: string;
    totalCents: number;
    requestedDate: string | null;
    customerName: string | null;
  }[];
  sales: {
    id: string;
    number: string;
    totalCents: number;
    createdAt: Date;
    customerName: string | null;
    imported: boolean;
  }[];
  products: {
    productId: string;
    variantId: string;
    name: string;
    variantName: string | null;
    sku: string | null;
    priceCents: number;
    /** Available units where there are any — warehouses first, never a 0. */
    stock: { locationId: string; locationName: string; warehouse: boolean; available: number }[];
  }[];
  purchaseOrders: {
    id: string;
    number: string;
    status: string;
    vendorName: string | null;
    totalCents: number;
    expectedAt: Date | null;
  }[];
  vendors: { id: string; name: string; phone: string | null; email: string | null }[];
  returns: {
    id: string;
    rmaNumber: string;
    status: string;
    orderId: string | null;
    orderNumber: string | null;
    customerName: string | null;
    amountCents: number;
  }[];
  serviceOrders: {
    id: string;
    number: string;
    status: string;
    itemDescription: string | null;
    customerName: string | null;
  }[];
  deliveries: {
    id: string;
    scheduledDate: string;
    status: string;
    kind: string;
    orderId: string;
    orderNumber: string;
    customerName: string | null;
    city: string | null;
  }[];
}

export type RecentKind =
  | 'order'
  | 'customer'
  | 'product'
  | 'po'
  | 'sale'
  | 'service'
  | 'vendor'
  | 'delivery';
const RECENT_KINDS = new Set<RecentKind>([
  'order',
  'customer',
  'product',
  'po',
  'sale',
  'service',
  'vendor',
  'delivery',
]);
export interface RecentRecord {
  kind: RecentKind;
  id: string;
  /** Mono identifier: document number, SKU or phone. */
  code: string;
  title: string;
  sub: string;
  href: string;
}

const EMPTY: SearchResults = {
  customers: [],
  orders: [],
  sales: [],
  products: [],
  purchaseOrders: [],
  vendors: [],
  returns: [],
  serviceOrders: [],
  deliveries: [],
};

const customerName = sql<string>`NULLIF(TRIM(CONCAT(COALESCE(${schema.customers.firstName}, ''), ' ', COALESCE(${schema.customers.lastName}, ''))), '')`;

/**
 * The customer's saved addresses as plain text — only the string and
 * number values (street, city, zip), never the JSON keys, so a search
 * for "line" or "city" doesn't match everyone.
 */
const addressValues = sql`COALESCE(jsonb_path_query_array(${schema.customers.addressesJson}, ${sql.raw(`'strict $.** ? (@.type() == "string" || @.type() == "number")'`)})::text, '')`;

/** Digits of one phone column (NULL-safe). */
function phoneDigits(col: unknown): SQL {
  return sql`regexp_replace(COALESCE(${col}, ''), '\\D', '', 'g')`;
}

/**
 * Every typed word must hit somewhere (owner 2026-10-02: "easier to find
 * with the least amount of information"). A word matches the record's
 * text — names, numbers, SKUs, emails, street / city / zip — anywhere in
 * it; a word that is mostly digits (3+) also matches any phone, compared
 * digits-to-digits so "555-0142", "(818) 555" and "0142" all hit.
 * `phones` holds each phone's digits separated by `|`, so two numbers
 * never run together into a false match.
 */
function matchAll(tokens: string[], text: SQL, phones?: SQL): SQL {
  return and(
    ...tokens.map((t) => {
      const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const digits = t.replace(/\D/g, '');
      const textHit = sql`${text} ILIKE ${like}`;
      if (phones && digits.length >= 3 && !/[a-z]/i.test(t)) {
        return sql`(${textHit} OR ${phones} LIKE ${`%${digits}%`})`;
      }
      return textHit;
    }),
  )!;
}

function has(tenant: RequestTenantContext, permission: string): boolean {
  return tenant.isSuperAdmin || tenant.permissions.has(permission as never);
}

/**
 * The global search (manager-dashboard handoff G1; widened owner
 * 2026-10-02 — the sidebar box): one query string finds customers,
 * orders, register receipts, products (with stock by store), purchase
 * orders, vendors, returns, service tickets and delivery stops. Every
 * signed-in member may search; each group only returns what the
 * member's role may view, and sales documents respect their store data
 * scope like every list view.
 */
@TenantScoped()
@Controller('v1/search')
export class GlobalSearchController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get()
  async search(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('q') qRaw?: string,
  ): Promise<SearchResults> {
    const q = (qRaw ?? '').trim();
    if (q.length < 2) return { ...EMPTY };
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
    const businessId = tenant.businessId!;
    const out: SearchResults = { ...EMPTY };

    const custText = sql`concat_ws(' ', ${schema.customers.firstName}, ${schema.customers.lastName}, ${schema.customers.businessName}, ${schema.customers.contactName}, ${schema.customers.alternateName}, ${schema.customers.email}, ${schema.customers.customerNumber}, ${schema.customers.phone}, ${schema.customers.phone2}, ${schema.customers.workPhone}, ${addressValues})`;
    const custPhones = sql`concat_ws('|', ${phoneDigits(schema.customers.phone)}, ${phoneDigits(schema.customers.phone2)}, ${phoneDigits(schema.customers.workPhone)})`;

    if (has(tenant, 'customers.view') || has(tenant, 'orders.view')) {
      out.customers = await this.db
        .select({
          id: schema.customers.id,
          name: customerName,
          phone: schema.customers.phone,
          email: schema.customers.email,
          customerNumber: schema.customers.customerNumber,
        })
        .from(schema.customers)
        .where(
          and(eq(schema.customers.businessId, businessId), matchAll(tokens, custText, custPhones)),
        )
        .orderBy(desc(schema.customers.updatedAt))
        .limit(6);
    }

    if (has(tenant, 'orders.view')) {
      const orderText = sql`concat_ws(' ', ${schema.orders.number}, ${schema.orders.legacyNumber}, ${schema.orders.addressLine1}, ${schema.orders.addressLine2}, ${schema.orders.addressCity}, ${schema.orders.addressPostalCode}, ${schema.orders.addressPhone}, ${custText})`;
      const orderPhones = sql`concat_ws('|', ${phoneDigits(schema.orders.addressPhone)}, ${custPhones})`;
      out.orders = await this.db
        .select({
          id: schema.orders.id,
          number: schema.orders.number,
          legacyNumber: schema.orders.legacyNumber,
          status: schema.orders.status,
          totalCents: schema.orders.totalCents,
          requestedDate: schema.orders.requestedDate,
          customerName,
        })
        .from(schema.orders)
        .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            matchAll(tokens, orderText, orderPhones),
            salesScopeCond(tenant, schema.orders.locationId),
          ),
        )
        .orderBy(desc(schema.orders.createdAt))
        .limit(6);

      const returnOrder = alias(schema.orders, 'return_order');
      const returnText = sql`concat_ws(' ', ${schema.orderReturns.rmaNumber}, ${schema.orderReturns.referencedOrderNumber}, ${returnOrder.number}, ${custText})`;
      out.returns = await this.db
        .select({
          id: schema.orderReturns.id,
          rmaNumber: schema.orderReturns.rmaNumber,
          status: schema.orderReturns.status,
          orderId: schema.orderReturns.orderId,
          orderNumber: returnOrder.number,
          customerName,
          amountCents: schema.orderReturns.amountCents,
        })
        .from(schema.orderReturns)
        .leftJoin(returnOrder, eq(returnOrder.id, schema.orderReturns.orderId))
        .leftJoin(
          schema.customers,
          eq(
            schema.customers.id,
            sql`COALESCE(${returnOrder.customerId}, ${schema.orderReturns.customerId})`,
          ),
        )
        .where(
          and(
            eq(schema.orderReturns.businessId, businessId),
            matchAll(tokens, returnText, custPhones),
            salesScopeCond(
              tenant,
              sql`COALESCE(${schema.orderReturns.locationId}, ${returnOrder.locationId})`,
            ),
          ),
        )
        .orderBy(desc(schema.orderReturns.authorizedAt))
        .limit(4);
    }

    if (has(tenant, 'sales.view') || has(tenant, 'orders.view')) {
      out.sales = await this.db
        .select({
          id: schema.sales.id,
          number: schema.sales.number,
          totalCents: schema.sales.totalCents,
          createdAt: schema.sales.createdAt,
          customerName,
          imported: sql<boolean>`${schema.sales.importedAt} IS NOT NULL`,
        })
        .from(schema.sales)
        .leftJoin(schema.customers, eq(schema.customers.id, schema.sales.customerId))
        .where(
          and(
            eq(schema.sales.businessId, businessId),
            matchAll(tokens, sql`concat_ws(' ', ${schema.sales.number}, ${custText})`, custPhones),
            salesScopeCond(tenant, schema.sales.locationId),
          ),
        )
        .orderBy(desc(schema.sales.createdAt))
        .limit(4);
    }

    if (has(tenant, 'deliveries.view')) {
      const delText = sql`concat_ws(' ', ${schema.orders.number}, ${schema.orders.addressLine1}, ${schema.orders.addressCity}, ${schema.orders.addressPostalCode}, ${schema.orders.addressPhone}, ${custText})`;
      const delPhones = sql`concat_ws('|', ${phoneDigits(schema.orders.addressPhone)}, ${custPhones})`;
      out.deliveries = await this.db
        .select({
          id: schema.deliveries.id,
          scheduledDate: schema.deliveries.scheduledDate,
          status: schema.deliveries.status,
          kind: schema.deliveries.kind,
          orderId: schema.orders.id,
          orderNumber: schema.orders.number,
          customerName,
          city: schema.orders.addressCity,
        })
        .from(schema.deliveries)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
        .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
        .where(
          and(
            eq(schema.deliveries.businessId, businessId),
            matchAll(tokens, delText, delPhones),
            salesScopeCond(tenant, schema.orders.locationId),
          ),
        )
        .orderBy(desc(schema.deliveries.scheduledDate))
        .limit(4);
    }

    if (has(tenant, 'service_orders.view')) {
      const svcText = sql`concat_ws(' ', ${schema.serviceOrders.number}, ${schema.serviceOrders.legacyNumber}, ${schema.serviceOrders.itemDescription}, ${schema.serviceOrders.issue}, ${custText})`;
      out.serviceOrders = await this.db
        .select({
          id: schema.serviceOrders.id,
          number: schema.serviceOrders.number,
          status: schema.serviceOrders.status,
          itemDescription: schema.serviceOrders.itemDescription,
          customerName,
        })
        .from(schema.serviceOrders)
        .leftJoin(schema.customers, eq(schema.customers.id, schema.serviceOrders.customerId))
        .where(
          and(
            eq(schema.serviceOrders.businessId, businessId),
            matchAll(tokens, svcText, custPhones),
          ),
        )
        .orderBy(desc(schema.serviceOrders.createdAt))
        .limit(4);
    }

    if (has(tenant, 'products.view')) {
      const prodText = sql`concat_ws(' ', ${schema.products.name}, ${schema.products.sku}, ${schema.productVariants.sku}, ${schema.productVariants.name}, ${schema.productVariants.barcode}, ${schema.productVariants.vendorSku}, ${schema.brands.name})`;
      const variants = await this.db
        .select({
          productId: schema.products.id,
          variantId: schema.productVariants.id,
          name: schema.products.name,
          variantName: schema.productVariants.name,
          sku: sql<string | null>`COALESCE(${schema.productVariants.sku}, ${schema.products.sku})`,
          priceCents: schema.productVariants.priceCents,
        })
        .from(schema.productVariants)
        .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
        .where(
          and(
            eq(schema.productVariants.businessId, businessId),
            eq(schema.products.isActive, true),
            matchAll(tokens, prodText),
          ),
        )
        // An exact SKU first, then by name.
        .orderBy(
          desc(
            sql`lower(COALESCE(${schema.productVariants.sku}, ${schema.products.sku}, '')) = lower(${q})`,
          ),
          asc(schema.products.name),
        )
        .limit(6);
      const stockBy = new Map<string, NonNullable<SearchResults['products'][number]['stock']>>();
      if (variants.length > 0) {
        const levels = await this.db
          .select({
            variantId: schema.inventoryLevels.variantId,
            locationId: schema.locations.id,
            locationName: schema.locations.name,
            warehouse: sql<boolean>`${schema.locations.locationType} = 'warehouse'`,
            available: sql<number>`(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample})::int`,
          })
          .from(schema.inventoryLevels)
          .innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
          .where(
            and(
              inArray(
                schema.inventoryLevels.variantId,
                variants.map((v) => v.variantId),
              ),
              eq(schema.locations.isActive, true),
              // Owner: no stock, no line — never show a 0.
              sql`${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample} > 0`,
            ),
          )
          // Warehouse first (owner), then stores by name.
          .orderBy(
            desc(sql`${schema.locations.locationType} = 'warehouse'`),
            asc(schema.locations.name),
          );
        for (const l of levels) {
          const list = stockBy.get(l.variantId) ?? [];
          list.push({
            locationId: l.locationId,
            locationName: l.locationName,
            warehouse: l.warehouse,
            available: l.available,
          });
          stockBy.set(l.variantId, list);
        }
      }
      out.products = variants.map((v) => ({
        ...v,
        stock: stockBy.get(v.variantId) ?? [],
      }));
    }

    if (has(tenant, 'purchase_orders.view')) {
      out.purchaseOrders = await this.db
        .select({
          id: schema.purchaseOrders.id,
          number: schema.purchaseOrders.number,
          status: schema.purchaseOrders.status,
          vendorName: schema.vendors.name,
          totalCents: schema.purchaseOrders.subtotalCents,
          expectedAt: schema.purchaseOrders.expectedAt,
        })
        .from(schema.purchaseOrders)
        .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
        .where(
          and(
            eq(schema.purchaseOrders.businessId, businessId),
            isNull(schema.purchaseOrders.deletedAt),
            matchAll(
              tokens,
              sql`concat_ws(' ', ${schema.purchaseOrders.number}, ${schema.vendors.name})`,
            ),
          ),
        )
        .orderBy(desc(schema.purchaseOrders.createdAt))
        .limit(4);
    }

    if (has(tenant, 'vendors.view') || has(tenant, 'purchase_orders.view')) {
      out.vendors = await this.db
        .select({
          id: schema.vendors.id,
          name: schema.vendors.name,
          phone: schema.vendors.phone,
          email: schema.vendors.email,
        })
        .from(schema.vendors)
        .where(
          and(
            eq(schema.vendors.businessId, businessId),
            matchAll(
              tokens,
              sql`concat_ws(' ', ${schema.vendors.name}, ${schema.vendors.contactName}, ${schema.vendors.email}, ${schema.vendors.phone})`,
              phoneDigits(schema.vendors.phone),
            ),
          ),
        )
        .orderBy(asc(schema.vendors.name))
        .limit(3);
    }

    return out;
  }

  /**
   * Names for the member's recently opened records (owner 2026-10-02:
   * the search window opens on them). The browser keeps the list of
   * `kind:id` refs per person; this resolves current names and drops
   * anything gone or outside what the member may see. Order is kept.
   */
  @Get('recent')
  async recent(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('refs') refsRaw?: string,
  ): Promise<RecentRecord[]> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const refs = (refsRaw ?? '')
      .split(',')
      .map((r) => r.split(':') as [string, string])
      .filter(([k, id]) => RECENT_KINDS.has(k as RecentKind) && UUID.test(id ?? ''))
      .slice(0, 12) as [RecentKind, string][];
    if (refs.length === 0) return [];
    const ids = (kind: RecentKind) => refs.filter(([k]) => k === kind).map(([, id]) => id);
    const businessId = tenant.businessId!;
    const found = new Map<string, RecentRecord>();
    const put = (r: RecentRecord) => found.set(`${r.kind}:${r.id}`, r);

    const orderIds = ids('order');
    if (orderIds.length && has(tenant, 'orders.view')) {
      const rows = await this.db
        .select({
          id: schema.orders.id,
          number: schema.orders.number,
          status: schema.orders.status,
          customerName,
        })
        .from(schema.orders)
        .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            inArray(schema.orders.id, orderIds),
            salesScopeCond(tenant, schema.orders.locationId),
          ),
        );
      for (const r of rows) {
        put({
          kind: 'order',
          id: r.id,
          code: r.number,
          title: r.customerName ?? '—',
          sub: r.status.replace(/_/g, ' '),
          href: `/orders/${r.id}`,
        });
      }
    }
    const customerIds = ids('customer');
    if (customerIds.length && (has(tenant, 'customers.view') || has(tenant, 'orders.view'))) {
      const rows = await this.db
        .select({
          id: schema.customers.id,
          name: customerName,
          phone: schema.customers.phone,
          email: schema.customers.email,
        })
        .from(schema.customers)
        .where(
          and(
            eq(schema.customers.businessId, businessId),
            inArray(schema.customers.id, customerIds),
          ),
        );
      for (const r of rows) {
        put({
          kind: 'customer',
          id: r.id,
          code: r.phone ?? '',
          title: r.name ?? r.email ?? 'customer',
          sub: r.email ?? '',
          href: `/customers/${r.id}`,
        });
      }
    }
    const productIds = ids('product');
    if (productIds.length && has(tenant, 'products.view')) {
      const rows = await this.db
        .select({ id: schema.products.id, name: schema.products.name, sku: schema.products.sku })
        .from(schema.products)
        .where(
          and(eq(schema.products.businessId, businessId), inArray(schema.products.id, productIds)),
        );
      for (const r of rows) {
        put({
          kind: 'product',
          id: r.id,
          code: r.sku ?? '',
          title: r.name,
          sub: 'product',
          href: `/products/${r.id}`,
        });
      }
    }
    const poIds = ids('po');
    if (poIds.length && has(tenant, 'purchase_orders.view')) {
      const rows = await this.db
        .select({
          id: schema.purchaseOrders.id,
          number: schema.purchaseOrders.number,
          status: schema.purchaseOrders.status,
          vendorName: schema.vendors.name,
        })
        .from(schema.purchaseOrders)
        .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
        .where(
          and(
            eq(schema.purchaseOrders.businessId, businessId),
            inArray(schema.purchaseOrders.id, poIds),
            isNull(schema.purchaseOrders.deletedAt),
          ),
        );
      for (const r of rows) {
        put({
          kind: 'po',
          id: r.id,
          code: r.number,
          title: r.vendorName ?? 'purchase order',
          sub: r.status.replace(/_/g, ' '),
          href: `/purchase-orders/${r.id}`,
        });
      }
    }
    const saleIds = ids('sale');
    if (saleIds.length && (has(tenant, 'sales.view') || has(tenant, 'orders.view'))) {
      const rows = await this.db
        .select({ id: schema.sales.id, number: schema.sales.number, customerName })
        .from(schema.sales)
        .leftJoin(schema.customers, eq(schema.customers.id, schema.sales.customerId))
        .where(
          and(
            eq(schema.sales.businessId, businessId),
            inArray(schema.sales.id, saleIds),
            salesScopeCond(tenant, schema.sales.locationId),
          ),
        );
      for (const r of rows) {
        put({
          kind: 'sale',
          id: r.id,
          code: r.number,
          title: r.customerName ?? '—',
          sub: 'receipt',
          href: `/sales/${r.id}`,
        });
      }
    }
    const serviceIds = ids('service');
    if (serviceIds.length && has(tenant, 'service_orders.view')) {
      const rows = await this.db
        .select({
          id: schema.serviceOrders.id,
          number: schema.serviceOrders.number,
          item: schema.serviceOrders.itemDescription,
          customerName,
        })
        .from(schema.serviceOrders)
        .leftJoin(schema.customers, eq(schema.customers.id, schema.serviceOrders.customerId))
        .where(
          and(
            eq(schema.serviceOrders.businessId, businessId),
            inArray(schema.serviceOrders.id, serviceIds),
          ),
        );
      for (const r of rows) {
        put({
          kind: 'service',
          id: r.id,
          code: r.number,
          title: r.customerName ?? '—',
          sub: r.item ?? 'service',
          href: `/service/${r.id}`,
        });
      }
    }
    const vendorIds = ids('vendor');
    if (vendorIds.length && (has(tenant, 'vendors.view') || has(tenant, 'purchase_orders.view'))) {
      const rows = await this.db
        .select({ id: schema.vendors.id, name: schema.vendors.name, phone: schema.vendors.phone })
        .from(schema.vendors)
        .where(
          and(eq(schema.vendors.businessId, businessId), inArray(schema.vendors.id, vendorIds)),
        );
      for (const r of rows) {
        put({
          kind: 'vendor',
          id: r.id,
          code: r.phone ?? '',
          title: r.name,
          sub: 'vendor',
          href: `/vendors/${r.id}`,
        });
      }
    }
    const deliveryIds = ids('delivery');
    if (deliveryIds.length && has(tenant, 'deliveries.view')) {
      const rows = await this.db
        .select({
          id: schema.deliveries.id,
          scheduledDate: schema.deliveries.scheduledDate,
          kind: schema.deliveries.kind,
          number: schema.orders.number,
          customerName,
        })
        .from(schema.deliveries)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
        .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
        .where(
          and(
            eq(schema.deliveries.businessId, businessId),
            inArray(schema.deliveries.id, deliveryIds),
            salesScopeCond(tenant, schema.orders.locationId),
          ),
        );
      for (const r of rows) {
        put({
          kind: 'delivery',
          id: r.id,
          code: r.number,
          title: r.customerName ?? '—',
          sub: `${r.kind === 'return_pickup' ? 'pickup' : 'delivery'} ${r.scheduledDate}`,
          href: `/deliveries/${r.id}`,
        });
      }
    }
    return refs.map(([k, id]) => found.get(`${k}:${id}`)).filter((r): r is RecentRecord => !!r);
  }
}
