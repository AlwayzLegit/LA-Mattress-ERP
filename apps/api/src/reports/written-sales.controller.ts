import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { parseDayRange, type DayRange } from '../common/date-range';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { toCsv } from './csv';

/**
 * Report Written Sales Dollars (STORIS TE.320, owner 2026-09-02): what
 * was written in a date window, per location, per transaction type, per
 * order, per line — merchandise, cost, gross profit and profit %, then the
 * order's charges, misc fee, sales tax and total —
 * with totals per order, type, location and grand.
 *
 * Jetnine mapping of the STORIS screen:
 * - Date window: the document's written (created) timestamp in the
 *   store's timezone. Store filter takes one or many `locationId`s.
 * - Types: "New Transactions excluding Layaway" (sales orders),
 *   "Layaway" (order kind layaway), "Register Sales" (POS cash-and-carry
 *   sales — STORIS has no separate register, Jetnine does) and
 *   "ADJUSTMENT": money that changed on documents written *before* the
 *   window — price adjustments granted in the window, cancellations in
 *   the window of earlier orders (the full order comes back out), and
 *   lines added in the window to earlier orders.
 * - Order Type: both / orders only / adjustments only.
 * - Report Type: detail (lines + orders) or summary (totals only).
 * - Include Audit Comments: the order's notes, internal notes and note
 *   thread under each order. Include All Salespeople: second salesperson
 *   and split. Include Customer's Full Address: the ship-to line.
 * - Gross profit is cost-derived and only present with
 *   `reports.financial.view` (masked otherwise, like Sales by product).
 * - Quotes, drafts and imported legacy documents are never written sales.
 */

export type OrderTypeFilter = 'both' | 'orders' | 'adjustments';
export type ReportType = 'detail' | 'summary';

export interface WrittenTotals {
  merchCents: number;
  profitCents: number | null;
  profitPct: number | null;
  chargesCents: number;
  discountCents: number;
  miscFeeCents: number;
  taxCents: number;
  totalCents: number;
  documents: number;
}

export interface WrittenLine {
  lineId: string;
  quantity: number;
  productNumber: string | null;
  description: string;
  merchCents: number;
  profitCents: number | null;
  profitPct: number | null;
  enteredBy: string | null;
}

export interface WrittenDocument {
  documentType: 'order' | 'sale' | 'adjustment';
  documentId: string;
  number: string;
  /** Store-local written date and time. */
  date: string;
  time: string;
  customerId: string | null;
  customerCode: string | null;
  customerName: string | null;
  address: string | null;
  salespeople: string[];
  marketingCode: string | null;
  /** Adjustments: what kind of change this row records. */
  adjustmentKind: 'price_adjustment' | 'cancellation' | 'lines_added' | null;
  adjustmentReason: string | null;
  comments: string[];
  lines: WrittenLine[];
  totals: WrittenTotals;
}

export interface WrittenTypeGroup {
  key: 'orders' | 'layaway' | 'register' | 'adjustments';
  label: string;
  documents: WrittenDocument[];
  totals: WrittenTotals;
}

export interface WrittenLocationGroup {
  locationId: string;
  locationName: string;
  types: WrittenTypeGroup[];
  totals: WrittenTotals;
}

export interface WrittenSalesReport {
  generatedAt: string;
  range: DayRange;
  orderType: OrderTypeFilter;
  reportType: ReportType;
  includeAuditComments: boolean;
  includeAllSalespeople: boolean;
  includeAddress: boolean;
  locationIds: string[];
  canSeeProfit: boolean;
  locations: WrittenLocationGroup[];
  totals: WrittenTotals;
}

const TYPE_LABELS: Record<WrittenTypeGroup['key'], string> = {
  orders: 'New Transactions excluding Layaway',
  layaway: 'Layaway',
  register: 'Register Sales',
  adjustments: 'ADJUSTMENT',
};
const TYPE_ORDER: WrittenTypeGroup['key'][] = ['orders', 'layaway', 'register', 'adjustments'];

function emptyTotals(canSeeProfit: boolean): WrittenTotals {
  return {
    merchCents: 0,
    profitCents: canSeeProfit ? 0 : null,
    profitPct: null,
    chargesCents: 0,
    discountCents: 0,
    miscFeeCents: 0,
    taxCents: 0,
    totalCents: 0,
    documents: 0,
  };
}

function addTotals(into: WrittenTotals, t: WrittenTotals): void {
  into.merchCents += t.merchCents;
  if (into.profitCents != null && t.profitCents != null) into.profitCents += t.profitCents;
  into.chargesCents += t.chargesCents;
  into.discountCents += t.discountCents;
  into.miscFeeCents += t.miscFeeCents;
  into.taxCents += t.taxCents;
  into.totalCents += t.totalCents;
  into.documents += t.documents;
  into.profitPct = pct(into.merchCents, into.profitCents);
}

function pct(merchCents: number, profitCents: number | null): number | null {
  if (profitCents == null || merchCents === 0) return null;
  return Math.round((profitCents / merchCents) * 1000) / 10;
}

function initials(name: string | null, email: string | null): string | null {
  const src = (name ?? '').trim();
  if (src) {
    return src
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0]!)
      .join('')
      .slice(0, 3)
      .toUpperCase();
  }
  return email ? email.slice(0, 2).toUpperCase() : null;
}

function customerCode(id: string | null): string | null {
  return id ? id.slice(0, 8).toUpperCase() : null;
}

function customerName(first: string | null, last: string | null): string | null {
  const s = [last, first].filter(Boolean).join(' ').trim();
  return s ? s.toUpperCase() : null;
}

interface AddressParts {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
}

function formatAddress(a: AddressParts | null | undefined): string | null {
  if (!a) return null;
  const street = [a.line1, a.line2].filter(Boolean).join(' ');
  const cityLine = [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const s = [street, cityLine].filter(Boolean).join(', ');
  return s ? s.toUpperCase() : null;
}

function firstCustomerAddress(raw: unknown): AddressParts | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const a = raw[0];
  return a && typeof a === 'object' ? (a as AddressParts) : null;
}

function splitList(v: string | string[] | undefined): string[] {
  const parts = (Array.isArray(v) ? v : v ? [v] : []).flatMap((s) => s.split(','));
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
}

function flag(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

@TenantScoped()
@Controller('v1/reports/written-sales')
export class WrittenSalesController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get()
  @RequirePermission('reports.sales.view')
  async report(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('locationId') locationIdRaw?: string | string[],
    @Query('orderType') orderTypeRaw?: string,
    @Query('reportType') reportTypeRaw?: string,
    @Query('includeAuditComments') auditRaw?: string,
    @Query('includeAllSalespeople') allSpRaw?: string,
    @Query('includeAddress') addressRaw?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<WrittenSalesReport | void> {
    const today = new Date().toISOString().slice(0, 10);
    const range = parseDayRange(start, end) ?? { start: today, end: today };
    const orderType: OrderTypeFilter =
      orderTypeRaw === 'orders' || orderTypeRaw === 'adjustments' ? orderTypeRaw : 'both';
    const reportType: ReportType = reportTypeRaw === 'summary' ? 'summary' : 'detail';
    const includeAuditComments = flag(auditRaw, false);
    const includeAllSalespeople = flag(allSpRaw, true);
    const includeAddress = flag(addressRaw, true);
    const locationIds = splitList(locationIdRaw);
    const canSeeProfit = tenant.permissions.has('reports.financial.view' as never);
    const businessId = tenant.businessId!;

    const stores = await this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        timezone: schema.locations.timezone,
      })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.businessId, businessId),
          locationIds.length ? inArray(schema.locations.id, locationIds) : undefined,
          salesScopeCond(tenant, schema.locations.id),
        ),
      )
      .orderBy(asc(schema.locations.name));
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const storeIds = stores.map((s) => s.id);

    const groups = new Map<string, WrittenLocationGroup>();
    const typeOf = (locationId: string, key: WrittenTypeGroup['key']): WrittenTypeGroup => {
      let g = groups.get(locationId);
      if (!g) {
        const store = storeById.get(locationId);
        g = {
          locationId,
          locationName: store?.name ?? '(unknown)',
          types: [],
          totals: emptyTotals(canSeeProfit),
        };
        groups.set(locationId, g);
      }
      let t = g.types.find((x) => x.key === key);
      if (!t) {
        t = { key, label: TYPE_LABELS[key], documents: [], totals: emptyTotals(canSeeProfit) };
        g.types.push(t);
      }
      return t;
    };
    const push = (locationId: string, key: WrittenTypeGroup['key'], doc: WrittenDocument) => {
      const t = typeOf(locationId, key);
      t.documents.push(doc);
    };

    if (storeIds.length > 0) {
      const writtenIn = (
        createdAt: typeof schema.orders.createdAt,
        tz: typeof schema.locations.timezone,
      ) =>
        and(
          sql`(${createdAt} AT TIME ZONE ${tz}) >= ${range.start}::date`,
          sql`(${createdAt} AT TIME ZONE ${tz}) < (${range.end}::date + 1)`,
        );

      if (orderType !== 'adjustments') {
        await this.collectOrders(businessId, storeIds, writtenIn, canSeeProfit, {
          includeAuditComments,
          includeAllSalespeople,
          includeAddress,
          push,
        });
        await this.collectRegisterSales(businessId, storeIds, writtenIn, canSeeProfit, {
          includeAddress,
          push,
        });
      }
      if (orderType !== 'orders') {
        await this.collectAdjustments(businessId, storeIds, range, canSeeProfit, {
          includeAllSalespeople,
          includeAddress,
          push,
        });
      }
    }

    // Roll up: order → type → location → grand. Summary drops the rows.
    const grand = emptyTotals(canSeeProfit);
    const locations: WrittenLocationGroup[] = [];
    for (const store of stores) {
      const g = groups.get(store.id);
      if (!g) continue;
      g.types.sort((a, b) => TYPE_ORDER.indexOf(a.key) - TYPE_ORDER.indexOf(b.key));
      for (const t of g.types) {
        t.documents.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
        for (const d of t.documents) addTotals(t.totals, d.totals);
        addTotals(g.totals, t.totals);
        if (reportType === 'summary') t.documents = [];
      }
      addTotals(grand, g.totals);
      locations.push(g);
    }

    const report: WrittenSalesReport = {
      generatedAt: new Date().toISOString(),
      range,
      orderType,
      reportType,
      includeAuditComments,
      includeAllSalespeople,
      includeAddress,
      locationIds: storeIds,
      canSeeProfit,
      locations,
      totals: grand,
    };

    if (format === 'csv') {
      const money = (c: number | null) => (c == null ? null : (c / 100).toFixed(2));
      const cost = (row: Pick<WrittenTotals, 'merchCents' | 'profitCents'>) =>
        money(row.profitCents == null ? null : row.merchCents - row.profitCents);
      const headers = [
        'Location',
        'Type',
        'Order number',
        'Order date',
        'Time',
        'Customer code',
        'Customer name',
        'Salespeople',
        'Marketing code',
        'Address',
        'Qty',
        'Product number',
        'Description',
        'Merch amount',
        'Cost',
        'Gross profit',
        'Profit pct',
        'Charges',
        'Misc fee',
        'Sales tax',
        'Total order',
        'Ent by',
      ];
      const data: (string | number | null)[][] = [];
      const totalsRow = (label: string, t: WrittenTotals) => [
        label,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        money(t.merchCents),
        cost(t),
        money(t.profitCents),
        t.profitPct,
        money(t.chargesCents),
        money(t.miscFeeCents),
        money(t.taxCents),
        money(t.totalCents),
        '',
      ];
      for (const loc of report.locations) {
        for (const t of loc.types) {
          for (const d of t.documents) {
            const head = [
              loc.locationName,
              t.label,
              d.number,
              d.date,
              d.time,
              d.customerCode,
              d.customerName,
              d.salespeople.join(','),
              d.marketingCode,
              d.address,
            ];
            for (const l of d.lines) {
              data.push([
                ...head,
                l.quantity,
                l.productNumber,
                l.description,
                money(l.merchCents),
                cost(l),
                money(l.profitCents),
                l.profitPct,
                '',
                '',
                '',
                '',
                l.enteredBy,
              ]);
            }
            data.push([
              ...head,
              '',
              '',
              `Total for order ${d.number}`,
              money(d.totals.merchCents),
              cost(d.totals),
              money(d.totals.profitCents),
              d.totals.profitPct,
              money(d.totals.chargesCents),
              money(d.totals.miscFeeCents),
              money(d.totals.taxCents),
              money(d.totals.totalCents),
              '',
            ]);
          }
          data.push(totalsRow(`Total for type ${t.label} (${loc.locationName})`, t.totals));
        }
        data.push(totalsRow(`Total for location ${loc.locationName}`, loc.totals));
      }
      data.push(totalsRow('Grand total', report.totals));
      res!.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res!.setHeader(
        'Content-Disposition',
        `attachment; filename="written-sales-${range.start}-to-${range.end}.csv"`,
      );
      res!.send(toCsv(headers, data));
      return;
    }
    return report;
  }

  private async collectOrders(
    businessId: string,
    storeIds: string[],
    writtenIn: (
      createdAt: typeof schema.orders.createdAt,
      tz: typeof schema.locations.timezone,
    ) => ReturnType<typeof and>,
    canSeeProfit: boolean,
    opts: {
      includeAuditComments: boolean;
      includeAllSalespeople: boolean;
      includeAddress: boolean;
      push: (locationId: string, key: WrittenTypeGroup['key'], doc: WrittenDocument) => void;
    },
  ): Promise<void> {
    const sp1m = alias(schema.memberships, 'sp1m');
    const sp1u = alias(schema.users, 'sp1u');
    const sp2m = alias(schema.memberships, 'sp2m');
    const sp2u = alias(schema.users, 'sp2u');
    const orders = await this.db
      .select({
        id: schema.orders.id,
        locationId: schema.orders.locationId,
        number: schema.orders.number,
        orderKind: schema.orders.orderKind,
        createdAt: schema.orders.createdAt,
        date: sql<string>`to_char(${schema.orders.createdAt} AT TIME ZONE ${schema.locations.timezone}, 'YYYY-MM-DD')`,
        time: sql<string>`to_char(${schema.orders.createdAt} AT TIME ZONE ${schema.locations.timezone}, 'HH24:MI')`,
        customerId: schema.orders.customerId,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        customerAddresses: schema.customers.addressesJson,
        addressLine1: schema.orders.addressLine1,
        addressLine2: schema.orders.addressLine2,
        addressCity: schema.orders.addressCity,
        addressRegion: schema.orders.addressRegion,
        addressPostalCode: schema.orders.addressPostalCode,
        marketingCode: schema.orders.marketingCode,
        orderDiscountCents: schema.orders.orderDiscountCents,
        taxCents: schema.orders.taxCents,
        totalCents: schema.orders.totalCents,
        deliveryFeeCents: schema.orders.deliveryFeeCents,
        installFeeCents: schema.orders.installFeeCents,
        otherFeeCents: schema.orders.otherFeeCents,
        notes: schema.orders.notes,
        internalNotes: schema.orders.internalNotes,
        sp1Name: sp1u.name,
        sp1Email: sp1u.email,
        sp2Name: sp2u.name,
        sp2Email: sp2u.email,
        splitBps: schema.orders.splitBps,
      })
      .from(schema.orders)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.orders.locationId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(sp1m, eq(sp1m.id, schema.orders.salespersonMembershipId))
      .leftJoin(sp1u, eq(sp1u.id, sp1m.userId))
      .leftJoin(sp2m, eq(sp2m.id, schema.orders.secondSalespersonMembershipId))
      .leftJoin(sp2u, eq(sp2u.id, sp2m.userId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          inArray(schema.orders.locationId, storeIds),
          writtenIn(schema.orders.createdAt, schema.locations.timezone),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
        ),
      )
      .orderBy(asc(schema.orders.createdAt));
    if (orders.length === 0) return;

    const orderIds = orders.map((o) => o.id);
    const lines = await this.db
      .select({
        id: schema.orderLines.id,
        orderId: schema.orderLines.orderId,
        quantity: schema.orderLines.quantity,
        description: schema.orderLines.description,
        totalCents: schema.orderLines.totalCents,
        variantSku: schema.productVariants.sku,
        productSku: schema.products.sku,
        costCents: schema.productVariants.costCents,
      })
      .from(schema.orderLines)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(inArray(schema.orderLines.orderId, orderIds))
      .orderBy(asc(schema.orderLines.createdAt));
    const linesByOrder = new Map<string, typeof lines>();
    for (const l of lines) {
      const arr = linesByOrder.get(l.orderId) ?? [];
      arr.push(l);
      linesByOrder.set(l.orderId, arr);
    }

    const notesByOrder = new Map<string, string[]>();
    if (opts.includeAuditComments) {
      const notes = await this.db
        .select({
          orderId: schema.orderNotes.orderId,
          body: schema.orderNotes.body,
          createdAt: schema.orderNotes.createdAt,
        })
        .from(schema.orderNotes)
        .where(inArray(schema.orderNotes.orderId, orderIds))
        .orderBy(asc(schema.orderNotes.createdAt));
      for (const n of notes) {
        const arr = notesByOrder.get(n.orderId) ?? [];
        arr.push(n.body);
        notesByOrder.set(n.orderId, arr);
      }
    }

    for (const o of orders) {
      const sp1 = initials(o.sp1Name, o.sp1Email);
      const sp2 = initials(o.sp2Name, o.sp2Email);
      const salespeople = [sp1, opts.includeAllSalespeople ? sp2 : null].filter((s): s is string =>
        Boolean(s),
      );
      const enteredBy = sp1 ?? sp2;
      const wl: WrittenLine[] = (linesByOrder.get(o.id) ?? []).map((l) => {
        const cost = canSeeProfit ? l.quantity * (l.costCents ?? 0) : null;
        const profit = cost == null ? null : l.totalCents - cost;
        return {
          lineId: l.id,
          quantity: l.quantity,
          productNumber: l.variantSku ?? l.productSku ?? null,
          description: l.description,
          merchCents: l.totalCents,
          profitCents: profit,
          profitPct: pct(l.totalCents, profit),
          enteredBy,
        };
      });
      const merch = wl.reduce((s, l) => s + l.merchCents, 0);
      const profit = canSeeProfit ? wl.reduce((s, l) => s + (l.profitCents ?? 0), 0) : null;
      const comments = opts.includeAuditComments
        ? [
            ...(o.notes ? [`Note: ${o.notes}`] : []),
            ...(o.internalNotes ? [`Internal: ${o.internalNotes}`] : []),
            ...(notesByOrder.get(o.id) ?? []),
          ]
        : [];
      const address = opts.includeAddress
        ? (formatAddress({
            line1: o.addressLine1,
            line2: o.addressLine2,
            city: o.addressCity,
            region: o.addressRegion,
            postalCode: o.addressPostalCode,
          }) ?? formatAddress(firstCustomerAddress(o.customerAddresses)))
        : null;
      opts.push(o.locationId, o.orderKind === 'layaway' ? 'layaway' : 'orders', {
        documentType: 'order',
        documentId: o.id,
        number: o.number,
        date: o.date,
        time: o.time,
        customerId: o.customerId,
        customerCode: customerCode(o.customerId),
        customerName: customerName(o.customerFirst, o.customerLast),
        address,
        salespeople,
        marketingCode: o.marketingCode,
        adjustmentKind: null,
        adjustmentReason: null,
        comments,
        lines: wl,
        totals: {
          merchCents: merch,
          profitCents: profit,
          profitPct: pct(merch, profit),
          chargesCents: o.deliveryFeeCents + o.installFeeCents,
          discountCents: o.orderDiscountCents,
          miscFeeCents: o.otherFeeCents,
          taxCents: o.taxCents,
          totalCents: o.totalCents,
          documents: 1,
        },
      });
    }
  }

  private async collectRegisterSales(
    businessId: string,
    storeIds: string[],
    writtenIn: (
      createdAt: typeof schema.orders.createdAt,
      tz: typeof schema.locations.timezone,
    ) => ReturnType<typeof and>,
    canSeeProfit: boolean,
    opts: {
      includeAddress: boolean;
      push: (locationId: string, key: WrittenTypeGroup['key'], doc: WrittenDocument) => void;
    },
  ): Promise<void> {
    const sales = await this.db
      .select({
        id: schema.sales.id,
        locationId: schema.sales.locationId,
        number: schema.sales.number,
        date: sql<string>`to_char(${schema.sales.createdAt} AT TIME ZONE ${schema.locations.timezone}, 'YYYY-MM-DD')`,
        time: sql<string>`to_char(${schema.sales.createdAt} AT TIME ZONE ${schema.locations.timezone}, 'HH24:MI')`,
        customerId: schema.sales.customerId,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        customerAddresses: schema.customers.addressesJson,
        discountCents: schema.sales.discountCents,
        taxCents: schema.sales.taxCents,
        totalCents: schema.sales.totalCents,
        associateName: schema.users.name,
        associateEmail: schema.users.email,
      })
      .from(schema.sales)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.sales.locationId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.sales.customerId))
      .leftJoin(schema.users, eq(schema.users.id, schema.sales.associateUserId))
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          inArray(schema.sales.locationId, storeIds),
          writtenIn(schema.sales.createdAt as never, schema.locations.timezone),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
          isNull(schema.sales.importedAt),
        ),
      )
      .orderBy(asc(schema.sales.createdAt));
    if (sales.length === 0) return;
    const lines = await this.db
      .select({
        id: schema.saleLines.id,
        saleId: schema.saleLines.saleId,
        quantity: schema.saleLines.quantity,
        description: schema.saleLines.description,
        totalCents: schema.saleLines.totalCents,
        variantSku: schema.productVariants.sku,
        productSku: schema.products.sku,
        costCents: schema.productVariants.costCents,
      })
      .from(schema.saleLines)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.saleLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        inArray(
          schema.saleLines.saleId,
          sales.map((s) => s.id),
        ),
      );
    const bySale = new Map<string, typeof lines>();
    for (const l of lines) {
      const arr = bySale.get(l.saleId) ?? [];
      arr.push(l);
      bySale.set(l.saleId, arr);
    }
    for (const s of sales) {
      const enteredBy = initials(s.associateName, s.associateEmail);
      const wl: WrittenLine[] = (bySale.get(s.id) ?? []).map((l) => {
        const cost = canSeeProfit ? l.quantity * (l.costCents ?? 0) : null;
        const profit = cost == null ? null : l.totalCents - cost;
        return {
          lineId: l.id,
          quantity: l.quantity,
          productNumber: l.variantSku ?? l.productSku ?? null,
          description: l.description,
          merchCents: l.totalCents,
          profitCents: profit,
          profitPct: pct(l.totalCents, profit),
          enteredBy,
        };
      });
      const merch = wl.reduce((x, l) => x + l.merchCents, 0);
      const profit = canSeeProfit ? wl.reduce((x, l) => x + (l.profitCents ?? 0), 0) : null;
      opts.push(s.locationId, 'register', {
        documentType: 'sale',
        documentId: s.id,
        number: s.number,
        date: s.date,
        time: s.time,
        customerId: s.customerId,
        customerCode: customerCode(s.customerId),
        customerName: customerName(s.customerFirst, s.customerLast),
        address: opts.includeAddress
          ? formatAddress(firstCustomerAddress(s.customerAddresses))
          : null,
        salespeople: enteredBy ? [enteredBy] : [],
        marketingCode: null,
        adjustmentKind: null,
        adjustmentReason: null,
        comments: [],
        lines: wl,
        totals: {
          merchCents: merch,
          profitCents: profit,
          profitPct: pct(merch, profit),
          chargesCents: 0,
          discountCents: s.discountCents,
          miscFeeCents: 0,
          taxCents: s.taxCents,
          totalCents: s.totalCents,
          documents: 1,
        },
      });
    }
  }

  /**
   * ADJUSTMENT rows: money that moved in the window on orders written
   * before it. Three sources, each its own row under the order's store.
   */
  private async collectAdjustments(
    businessId: string,
    storeIds: string[],
    range: DayRange,
    canSeeProfit: boolean,
    opts: {
      includeAllSalespeople: boolean;
      includeAddress: boolean;
      push: (locationId: string, key: WrittenTypeGroup['key'], doc: WrittenDocument) => void;
    },
  ): Promise<void> {
    const sp1m = alias(schema.memberships, 'adj_sp1m');
    const sp1u = alias(schema.users, 'adj_sp1u');
    const sp2m = alias(schema.memberships, 'adj_sp2m');
    const sp2u = alias(schema.users, 'adj_sp2u');
    const localCreated = sql`(${schema.orders.createdAt} AT TIME ZONE ${schema.locations.timezone})`;
    const beforeWindow = sql`${localCreated} < ${range.start}::date`;
    const inWindow = (col: ReturnType<typeof sql>) =>
      and(
        sql`(${col} AT TIME ZONE ${schema.locations.timezone}) >= ${range.start}::date`,
        sql`(${col} AT TIME ZONE ${schema.locations.timezone}) < (${range.end}::date + 1)`,
      );
    const headerCols = {
      id: schema.orders.id,
      locationId: schema.orders.locationId,
      number: schema.orders.number,
      timezone: schema.locations.timezone,
      customerId: schema.orders.customerId,
      customerFirst: schema.customers.firstName,
      customerLast: schema.customers.lastName,
      customerAddresses: schema.customers.addressesJson,
      addressLine1: schema.orders.addressLine1,
      addressLine2: schema.orders.addressLine2,
      addressCity: schema.orders.addressCity,
      addressRegion: schema.orders.addressRegion,
      addressPostalCode: schema.orders.addressPostalCode,
      marketingCode: schema.orders.marketingCode,
      orderDiscountCents: schema.orders.orderDiscountCents,
      taxCents: schema.orders.taxCents,
      totalCents: schema.orders.totalCents,
      deliveryFeeCents: schema.orders.deliveryFeeCents,
      installFeeCents: schema.orders.installFeeCents,
      otherFeeCents: schema.orders.otherFeeCents,
      subtotalCents: schema.orders.subtotalCents,
      cancelledAt: schema.orders.cancelledAt,
      sp1Name: sp1u.name,
      sp1Email: sp1u.email,
      sp2Name: sp2u.name,
      sp2Email: sp2u.email,
    };
    const base = () =>
      this.db
        .select(headerCols)
        .from(schema.orders)
        .innerJoin(schema.locations, eq(schema.locations.id, schema.orders.locationId))
        .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
        .leftJoin(sp1m, eq(sp1m.id, schema.orders.salespersonMembershipId))
        .leftJoin(sp1u, eq(sp1u.id, sp1m.userId))
        .leftJoin(sp2m, eq(sp2m.id, schema.orders.secondSalespersonMembershipId))
        .leftJoin(sp2u, eq(sp2u.id, sp2m.userId));
    type Header = Awaited<ReturnType<typeof base>>[number];

    const local = (at: Date, tz: string): { date: string; time: string } => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(at);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      const hour = get('hour') === '24' ? '00' : get('hour');
      return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        time: `${hour}:${get('minute')}`,
      };
    };
    const docFor = (
      o: Header,
      at: Date,
      kind: NonNullable<WrittenDocument['adjustmentKind']>,
      reason: string | null,
      lines: WrittenLine[],
      totals: WrittenTotals,
    ): WrittenDocument => {
      const sp1 = initials(o.sp1Name, o.sp1Email);
      const sp2 = initials(o.sp2Name, o.sp2Email);
      const { date, time } = local(at, o.timezone);
      return {
        documentType: 'adjustment',
        documentId: o.id,
        number: o.number,
        date,
        time,
        customerId: o.customerId,
        customerCode: customerCode(o.customerId),
        customerName: customerName(o.customerFirst, o.customerLast),
        address: opts.includeAddress
          ? (formatAddress({
              line1: o.addressLine1,
              line2: o.addressLine2,
              city: o.addressCity,
              region: o.addressRegion,
              postalCode: o.addressPostalCode,
            }) ?? formatAddress(firstCustomerAddress(o.customerAddresses)))
          : null,
        salespeople: [sp1, opts.includeAllSalespeople ? sp2 : null].filter((s): s is string =>
          Boolean(s),
        ),
        marketingCode: o.marketingCode,
        adjustmentKind: kind,
        adjustmentReason: reason,
        comments: [],
        lines,
        totals,
      };
    };

    // 1. Price adjustments granted in the window (audit: order.price_adjustment).
    const priceAdj = await this.db
      .select({
        orderId: schema.auditLogs.targetId,
        changes: schema.auditLogs.changesJson,
        createdAt: schema.auditLogs.createdAt,
      })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          eq(schema.auditLogs.action, 'order.price_adjustment'),
          gte(schema.auditLogs.createdAt, new Date(`${range.start}T00:00:00Z`)),
          lt(
            schema.auditLogs.createdAt,
            new Date(new Date(`${range.end}T00:00:00Z`).getTime() + 2 * 86_400_000),
          ),
        ),
      )
      .orderBy(asc(schema.auditLogs.createdAt));
    const adjOrderIds = [...new Set(priceAdj.map((a) => a.orderId).filter(Boolean))] as string[];
    if (adjOrderIds.length > 0) {
      const headers = await base().where(
        and(
          eq(schema.orders.businessId, businessId),
          inArray(schema.orders.locationId, storeIds),
          inArray(schema.orders.id, adjOrderIds),
          isNull(schema.orders.importedAt),
        ),
      );
      const byId = new Map(headers.map((h) => [h.id, h]));
      for (const a of priceAdj) {
        const o = a.orderId ? byId.get(a.orderId) : undefined;
        if (!o) continue;
        const { date } = local(a.createdAt, o.timezone);
        if (date < range.start || date > range.end) continue;
        const after = ((a.changes ?? {}) as { after?: Record<string, unknown> }).after ?? {};
        const amount = typeof after.amountCents === 'number' ? after.amountCents : 0;
        const reason =
          (typeof after.reason === 'string' && after.reason) ||
          (typeof after.reasonCode === 'string' && after.reasonCode) ||
          null;
        const merch = -amount;
        const profit = canSeeProfit ? merch : null;
        opts.push(
          o.locationId,
          'adjustments',
          docFor(
            o,
            a.createdAt,
            'price_adjustment',
            reason,
            [
              {
                lineId: `adj:${a.createdAt.getTime()}`,
                quantity: 0,
                productNumber: null,
                description: `Price adjustment${reason ? ` — ${reason}` : ''}`,
                merchCents: merch,
                profitCents: profit,
                profitPct: pct(merch, profit),
                enteredBy: null,
              },
            ],
            {
              merchCents: merch,
              profitCents: profit,
              profitPct: pct(merch, profit),
              chargesCents: 0,
              discountCents: 0,
              miscFeeCents: 0,
              taxCents: 0,
              totalCents: merch,
              documents: 1,
            },
          ),
        );
      }
    }

    // 2. Cancellations in the window of orders written before it.
    const cancelled = await base().where(
      and(
        eq(schema.orders.businessId, businessId),
        inArray(schema.orders.locationId, storeIds),
        eq(schema.orders.status, 'cancelled'),
        sql`${schema.orders.cancelledAt} IS NOT NULL`,
        beforeWindow,
        inWindow(sql`${schema.orders.cancelledAt}`),
        isNull(schema.orders.importedAt),
      ),
    );
    if (cancelled.length > 0) {
      const lines = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          quantity: schema.orderLines.quantity,
          totalCents: schema.orderLines.totalCents,
          costCents: schema.productVariants.costCents,
        })
        .from(schema.orderLines)
        .leftJoin(
          schema.productVariants,
          eq(schema.productVariants.id, schema.orderLines.variantId),
        )
        .where(
          inArray(
            schema.orderLines.orderId,
            cancelled.map((c) => c.id),
          ),
        );
      const agg = new Map<string, { merch: number; cost: number }>();
      for (const l of lines) {
        const a = agg.get(l.orderId) ?? { merch: 0, cost: 0 };
        a.merch += l.totalCents;
        a.cost += l.quantity * (l.costCents ?? 0);
        agg.set(l.orderId, a);
      }
      for (const o of cancelled) {
        const a = agg.get(o.id) ?? { merch: 0, cost: 0 };
        const merch = -a.merch;
        const profit = canSeeProfit ? -(a.merch - a.cost) : null;
        opts.push(
          o.locationId,
          'adjustments',
          docFor(
            o,
            o.cancelledAt!,
            'cancellation',
            null,
            [
              {
                lineId: `cancel:${o.id}`,
                quantity: 0,
                productNumber: null,
                description: 'Order cancelled',
                merchCents: merch,
                profitCents: profit,
                profitPct: pct(merch, profit),
                enteredBy: null,
              },
            ],
            {
              merchCents: merch,
              profitCents: profit,
              profitPct: pct(merch, profit),
              chargesCents: -(o.deliveryFeeCents + o.installFeeCents),
              discountCents: -o.orderDiscountCents,
              miscFeeCents: -o.otherFeeCents,
              taxCents: -o.taxCents,
              totalCents: -o.totalCents,
              documents: 1,
            },
          ),
        );
      }
    }

    // 3. Lines added in the window to orders written before it.
    const added = await this.db
      .select({
        id: schema.orderLines.id,
        orderId: schema.orderLines.orderId,
        quantity: schema.orderLines.quantity,
        description: schema.orderLines.description,
        totalCents: schema.orderLines.totalCents,
        taxCents: schema.orderLines.taxCents,
        createdAt: schema.orderLines.createdAt,
        variantSku: schema.productVariants.sku,
        productSku: schema.products.sku,
        costCents: schema.productVariants.costCents,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.orders.locationId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          inArray(schema.orders.locationId, storeIds),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          beforeWindow,
          inWindow(sql`${schema.orderLines.createdAt}`),
          // A line stamped in the same minute as its order is the original write.
          sql`${schema.orderLines.createdAt} >= ${schema.orders.createdAt} + interval '1 minute'`,
        ),
      )
      .orderBy(asc(schema.orderLines.createdAt));
    if (added.length > 0) {
      const ids = [...new Set(added.map((l) => l.orderId))];
      const headers = await base().where(inArray(schema.orders.id, ids));
      const byId = new Map(headers.map((h) => [h.id, h]));
      const byOrder = new Map<string, typeof added>();
      for (const l of added) {
        const arr = byOrder.get(l.orderId) ?? [];
        arr.push(l);
        byOrder.set(l.orderId, arr);
      }
      for (const [orderId, ls] of byOrder) {
        const o = byId.get(orderId);
        if (!o) continue;
        const wl: WrittenLine[] = ls.map((l) => {
          const cost = canSeeProfit ? l.quantity * (l.costCents ?? 0) : null;
          const profit = cost == null ? null : l.totalCents - cost;
          return {
            lineId: l.id,
            quantity: l.quantity,
            productNumber: l.variantSku ?? l.productSku ?? null,
            description: l.description,
            merchCents: l.totalCents,
            profitCents: profit,
            profitPct: pct(l.totalCents, profit),
            enteredBy: initials(o.sp1Name, o.sp1Email),
          };
        });
        const merch = wl.reduce((s, l) => s + l.merchCents, 0);
        const profit = canSeeProfit ? wl.reduce((s, l) => s + (l.profitCents ?? 0), 0) : null;
        const tax = ls.reduce((s, l) => s + l.taxCents, 0);
        opts.push(
          o.locationId,
          'adjustments',
          docFor(o, ls[0]!.createdAt, 'lines_added', null, wl, {
            merchCents: merch,
            profitCents: profit,
            profitPct: pct(merch, profit),
            chargesCents: 0,
            discountCents: 0,
            miscFeeCents: 0,
            taxCents: tax,
            totalCents: merch + tax,
            documents: 1,
          }),
        );
      }
    }
  }
}
