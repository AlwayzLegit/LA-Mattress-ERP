import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { DRIZZLE } from '../database/database.module';
import { deriveDisplayStatus } from '../orders/orders.controller';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';

/**
 * View Salesperson Activity (owner 2026-09-02, modeled on STORIS "View
 * Salesperson Activity"): one read that feeds the eight views — General
 * (totals), Open Orders, Completed Orders, Canceled Orders, Layaways,
 * Carts, Quotes and Leads — for one member, counting every order where
 * they are the primary or the second salesperson. Money is derived from
 * the documents; nothing is stored.
 */

interface OrderRowOut {
  id: string;
  number: string;
  customerId: string | null;
  customerName: string;
  orderType: string;
  fulfillmentType: string;
  fulfillmentStatus: string;
  orderDate: string;
  fulfillmentDate: string | null;
  completedDate: string | null;
  cancelledDate: string | null;
  merchandiseCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  salespeople: number;
}

export interface SalespersonActivity {
  salesperson: {
    membershipId: string;
    userId: string;
    code: string;
    name: string;
    email: string | null;
    sellingLocations: string[];
    status: string;
  };
  range: { from: string; to: string; today: string };
  general: {
    ordersCents: number;
    ordersCount: number;
    layawaysCents: number;
    layawaysCount: number;
    quotesCents: number;
    quotesCount: number;
    cartsCents: number;
    cartsCount: number;
    writtenTodayCents: number;
    writtenMtdCents: number;
    deliveredTodayCents: number;
    deliveredMtdCents: number;
  };
  openOrders: OrderRowOut[];
  completedOrders: OrderRowOut[];
  canceledOrders: OrderRowOut[];
  layaways: OrderRowOut[];
  carts: OrderRowOut[];
  quotes: OrderRowOut[];
  leads: {
    customerId: string;
    name: string;
    phone: string | null;
    email: string | null;
    source: string;
    documentId: string;
    documentNumber: string;
    date: string;
  }[];
}

const OPEN_STATUSES = ['open', 'confirmed', 'partially_fulfilled', 'fulfilled'];

function orderTypeLabel(kind: string, fulfillmentType: string, status: string): string {
  if (status === 'quote') return 'Quote';
  if (status === 'draft') return 'Cart';
  if (kind === 'layaway') return 'Layaway';
  if (kind === 'exchange') return 'Exchange';
  if (kind === 'sale') return 'Sale';
  if (
    fulfillmentType === 'pickup' ||
    fulfillmentType === 'will_call' ||
    fulfillmentType === 'take_with'
  )
    return 'Take-With Order';
  return 'Sales Order';
}

function fulfillmentLabel(t: string): string {
  if (t === 'pickup' || t === 'take_with') return 'Take With';
  if (t === 'will_call') return 'Will Call';
  if (t === 'split') return 'Split Ticket';
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ');
}

function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

function initials(name: string | null, email: string | null): string {
  const src = (name ?? '').trim();
  if (src) {
    const parts = src.split(/\s+/);
    return parts
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('');
  }
  return (email ?? '??').slice(0, 2).toUpperCase();
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function isDay(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

@TenantScoped()
@Controller('v1/salespeople')
export class SalespersonActivityController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get(':membershipId/activity')
  @RequirePermission('reports.sales.view')
  async activity(
    @Param('membershipId') membershipId: string,
    @Query('from') fromQ?: string,
    @Query('to') toQ?: string,
    @Query('today') todayQ?: string,
  ): Promise<SalespersonActivity> {
    const [m] = await this.db
      .select({
        membershipId: schema.memberships.id,
        userId: schema.memberships.userId,
        status: schema.memberships.status,
        sellingScope: schema.memberships.sellingScope,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.id, membershipId))
      .limit(1);
    if (!m) throw new NotFoundException('Salesperson not found');

    const today = isDay(todayQ) ? todayQ : isoDate(new Date())!;
    // Default window: the first of last month through the end of this month.
    const [ty, tm] = today.split('-').map(Number) as [number, number, number];
    const defFrom = isoDate(new Date(Date.UTC(ty, tm - 2, 1)))!;
    const defTo = isoDate(new Date(Date.UTC(ty, tm, 0)))!;
    const from = isDay(fromQ) ? fromQ : defFrom;
    const to = isDay(toQ) ? toQ : defTo;
    const mtdStart = monthStart(today);

    // Selling locations (approved list) or every store.
    let sellingLocations: string[] = [];
    if (m.sellingScope === 'approved') {
      const scopes = await this.db
        .select({ name: schema.locations.name })
        .from(schema.membershipLocationScopes)
        .innerJoin(
          schema.locations,
          eq(schema.locations.id, schema.membershipLocationScopes.locationId),
        )
        .where(eq(schema.membershipLocationScopes.membershipId, membershipId))
        .orderBy(schema.locations.name);
      sellingLocations = scopes.map((s) => s.name);
    }

    // Every order this member wrote or shares.
    const orders = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        orderKind: schema.orders.orderKind,
        fulfillmentType: schema.orders.fulfillmentType,
        subtotalCents: schema.orders.subtotalCents,
        discountCents: schema.orders.discountCents,
        totalCents: schema.orders.totalCents,
        requestedDate: schema.orders.requestedDate,
        secondSalespersonMembershipId: schema.orders.secondSalespersonMembershipId,
        customerId: schema.orders.customerId,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        phone: schema.customers.phone,
        email: schema.customers.email,
        completedAt: schema.orders.completedAt,
        cancelledAt: schema.orders.cancelledAt,
        createdAt: schema.orders.createdAt,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        or(
          eq(schema.orders.salespersonMembershipId, membershipId),
          eq(schema.orders.secondSalespersonMembershipId, membershipId),
        ),
      )
      .orderBy(desc(schema.orders.createdAt));
    const ids = orders.map((o) => o.id);

    const paid = new Map<string, number>();
    const trip = new Map<string, { date: string | null; status: string }>();
    const onPo = new Set<string>();
    const reservedShort = new Set<string>();
    const fullyReturned = new Set<string>();
    const awaitingPickup = new Set<string>();
    const exchanged = new Set<string>();
    if (ids.length > 0) {
      const pays = await this.db
        .select({
          orderId: schema.payments.orderId,
          cents: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)::int`,
        })
        .from(schema.payments)
        .where(and(inArray(schema.payments.orderId, ids), eq(schema.payments.status, 'succeeded')))
        .groupBy(schema.payments.orderId);
      for (const p of pays) if (p.orderId) paid.set(p.orderId, p.cents);

      const trips = await this.db
        .select({
          orderId: schema.deliveries.orderId,
          scheduledDate: schema.deliveries.scheduledDate,
          status: schema.deliveries.status,
        })
        .from(schema.deliveries)
        .where(
          and(
            inArray(schema.deliveries.orderId, ids),
            inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
          ),
        );
      for (const t of trips) {
        const cur = trip.get(t.orderId);
        if (!cur || t.status === 'out_for_delivery') {
          trip.set(t.orderId, { date: t.scheduledDate, status: t.status });
        }
      }

      const allocs = await this.db
        .select({ orderId: schema.orderLines.orderId })
        .from(schema.poLineAllocations)
        .innerJoin(
          schema.orderLines,
          eq(schema.orderLines.id, schema.poLineAllocations.orderLineId),
        )
        .innerJoin(
          schema.purchaseOrderLines,
          eq(schema.purchaseOrderLines.id, schema.poLineAllocations.poLineId),
        )
        .where(
          and(
            inArray(schema.orderLines.orderId, ids),
            sql`${schema.poLineAllocations.status} != 'cancelled'`,
            sql`${schema.purchaseOrderLines.quantityOrdered} > ${schema.purchaseOrderLines.quantityReceived}`,
          ),
        );
      for (const a of allocs) onPo.add(a.orderId);

      const lineAgg = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          fulfilled: sql<number>`coalesce(sum(${schema.orderLines.qtyFulfilled}), 0)::int`,
          returned: sql<number>`coalesce(sum(${schema.orderLines.qtyReturned}), 0)::int`,
          short: sql<number>`count(*) filter (where ${schema.orderLines.lineType} = 'stock' and ${schema.orderLines.qtyReserved} + ${schema.orderLines.qtyFulfilled} < ${schema.orderLines.quantity})::int`,
        })
        .from(schema.orderLines)
        .where(inArray(schema.orderLines.orderId, ids))
        .groupBy(schema.orderLines.orderId);
      for (const r of lineAgg) {
        if (r.returned > 0 && r.returned >= r.fulfilled) fullyReturned.add(r.orderId);
        if (r.short > 0) reservedShort.add(r.orderId);
      }

      const openReturns = await this.db
        .select({ orderId: schema.orderReturns.orderId })
        .from(schema.orderReturns)
        .where(
          and(
            inArray(schema.orderReturns.orderId, ids),
            eq(schema.orderReturns.status, 'authorized'),
          ),
        );
      for (const r of openReturns) if (r.orderId) awaitingPickup.add(r.orderId);

      const children = await this.db
        .select({ originalOrderId: schema.orders.originalOrderId })
        .from(schema.orders)
        .where(
          and(
            inArray(schema.orders.originalOrderId, ids),
            sql`${schema.orders.status} != 'cancelled'`,
          ),
        );
      for (const c of children) if (c.originalOrderId) exchanged.add(c.originalOrderId);
    }

    const toRow = (o: (typeof orders)[number]): OrderRowOut => {
      const paidCents = paid.get(o.id) ?? 0;
      const balance = Math.max(0, o.totalCents - paidCents);
      const t = trip.get(o.id);
      const merchandise = o.subtotalCents - o.discountCents;
      return {
        id: o.id,
        number: o.number,
        customerId: o.customerId,
        customerName: [o.lastName, o.firstName].filter(Boolean).join(', ') || '—',
        orderType: orderTypeLabel(o.orderKind, o.fulfillmentType, o.status),
        fulfillmentType: fulfillmentLabel(o.fulfillmentType),
        fulfillmentStatus: deriveDisplayStatus({
          status: o.status,
          orderKind: o.orderKind,
          balance,
          tripStatus: t?.status ?? null,
          onPo: onPo.has(o.id),
          reservedShort: reservedShort.has(o.id),
          awaitingPickup: awaitingPickup.has(o.id),
          fullyReturned: fullyReturned.has(o.id),
          exchanged: exchanged.has(o.id),
        }),
        orderDate: isoDate(o.createdAt)!,
        fulfillmentDate: t?.date ?? o.requestedDate ?? null,
        completedDate: isoDate(o.completedAt),
        cancelledDate: isoDate(o.cancelledAt),
        merchandiseCents: merchandise,
        totalCents: o.totalCents,
        amountPaidCents: paidCents,
        balanceCents: balance,
        salespeople: o.secondSalespersonMembershipId ? 2 : 1,
      };
    };

    const inRange = (d: Date | null): boolean => {
      const day = isoDate(d);
      return !!day && day >= from && day <= to;
    };

    const openOrders = orders
      .filter((o) => OPEN_STATUSES.includes(o.status) && o.orderKind !== 'layaway')
      .map(toRow);
    const layaways = orders
      .filter((o) => OPEN_STATUSES.includes(o.status) && o.orderKind === 'layaway')
      .map(toRow);
    const completedOrders = orders
      .filter(
        (o) =>
          (o.status === 'completed' || o.status === 'fulfilled') &&
          inRange(o.completedAt ?? o.createdAt),
      )
      .map(toRow);
    const canceledOrders = orders
      .filter((o) => o.status === 'cancelled' && inRange(o.cancelledAt ?? o.createdAt))
      .map(toRow);
    const carts = orders.filter((o) => o.status === 'draft').map(toRow);
    const quotes = orders.filter((o) => o.status === 'quote').map(toRow);

    // Leads: customers on this member's quotes or carts with no real order yet.
    const realCustomers = new Set(
      orders
        .filter((o) => !['draft', 'quote', 'cancelled'].includes(o.status) && o.customerId)
        .map((o) => o.customerId as string),
    );
    const seen = new Set<string>();
    const leads: SalespersonActivity['leads'] = [];
    for (const o of orders) {
      if (o.status !== 'quote' && o.status !== 'draft') continue;
      if (!o.customerId || realCustomers.has(o.customerId) || seen.has(o.customerId)) continue;
      seen.add(o.customerId);
      leads.push({
        customerId: o.customerId,
        name: [o.firstName, o.lastName].filter(Boolean).join(' ') || '(no name)',
        phone: o.phone,
        email: o.email,
        source: o.status === 'quote' ? 'Quote' : 'Cart',
        documentId: o.id,
        documentNumber: o.number,
        date: isoDate(o.createdAt)!,
      });
    }

    const sum = (rows: OrderRowOut[]) => rows.reduce((s, r) => s + r.totalCents, 0);
    const written = orders.filter((o) => !['draft', 'quote', 'cancelled'].includes(o.status));
    const writtenOn = (pred: (d: string) => boolean) =>
      written.filter((o) => pred(isoDate(o.createdAt)!)).reduce((s, o) => s + o.totalCents, 0);
    const delivered = orders.filter(
      (o) => (o.status === 'completed' || o.status === 'fulfilled') && o.completedAt,
    );
    const deliveredOn = (pred: (d: string) => boolean) =>
      delivered.filter((o) => pred(isoDate(o.completedAt)!)).reduce((s, o) => s + o.totalCents, 0);

    return {
      salesperson: {
        membershipId: m.membershipId,
        userId: m.userId,
        code: initials(m.name, m.email),
        name: m.name ?? m.email ?? '(no name)',
        email: m.email ?? null,
        sellingLocations,
        status: m.status,
      },
      range: { from, to, today },
      general: {
        ordersCents: sum(openOrders),
        ordersCount: openOrders.length,
        layawaysCents: sum(layaways),
        layawaysCount: layaways.length,
        quotesCents: sum(quotes),
        quotesCount: quotes.length,
        cartsCents: sum(carts),
        cartsCount: carts.length,
        writtenTodayCents: writtenOn((d) => d === today),
        writtenMtdCents: writtenOn((d) => d >= mtdStart && d <= today),
        deliveredTodayCents: deliveredOn((d) => d === today),
        deliveredMtdCents: deliveredOn((d) => d >= mtdStart && d <= today),
      },
      openOrders,
      completedOrders,
      canceledOrders,
      layaways,
      carts,
      quotes,
      leads,
    };
  }
}
