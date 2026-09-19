import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

interface DayStats {
  writtenCents: number;
  documents: number;
  collectedCents: number;
  avgTicketCents: number;
}

interface CallbackRow {
  orderId: string;
  number: string;
  status: string;
  customerName: string | null;
  phone: string | null;
  totalCents: number;
  createdAt: Date;
  ageDays: number;
}

interface MyDeliveryRow {
  deliveryId: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  phone: string | null;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  driverName: string | null;
  /** 'today' | 'tomorrow' relative to the store clock. */
  when: 'today' | 'tomorrow';
}

interface BalanceRow {
  orderId: string;
  number: string;
  status: string;
  customerName: string | null;
  phone: string | null;
  fulfillmentType: string | null;
  requestedDate: string | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  /** Balance still open with the delivery/pickup date already here or past. */
  dueNow: boolean;
}

interface PickupRow {
  orderId: string;
  number: string;
  customerName: string | null;
  phone: string | null;
  ageDays: number;
  ready: boolean;
  mine: boolean;
}

interface ReturnRow {
  id: string;
  kind: 'return' | 'exchange';
  number: string;
  status: string;
  orderId: string | null;
  orderNumber: string | null;
  customerName: string | null;
  amountCents: number | null;
  createdAt: Date;
}

interface PromoRow {
  id: string;
  code: string;
  kind: string;
  value: number;
  description: string | null;
  minSubtotalCents: number | null;
  endsAt: Date | null;
  remainingUses: number | null;
}

export interface MyDaySummary {
  date: string;
  location: { id: string; name: string; timezone: string };
  locations: { id: string; name: string; locationType: string }[];
  /** Card 1 — my written/collected today vs the same weekday last week. */
  myDay: { today: DayStats; lastWeek: DayStats };
  /** Card 2 — my drawer, if I have a shift open anywhere. */
  drawer: {
    shift: {
      id: string;
      locationId: string;
      locationName: string | null;
      openedAt: Date;
      hoursOpen: number;
      openingFloatCents: number;
      cashInCents: number;
      expectedCashCents: number;
      suspended: boolean;
      /** Open past 12h — close it before it becomes tomorrow's problem. */
      stale: boolean;
    } | null;
    /** The picked store's last close, so a cashier knows the ritual was done. */
    lastClose: { closedAt: Date; varianceCents: number | null } | null;
  };
  /** Card 3 — my quotes and drafts, oldest first. */
  callbacks: CallbackRow[];
  /** Card 4 — my customers' deliveries today and tomorrow. */
  myDeliveries: MyDeliveryRow[];
  /** Card 5 — my open orders still owing money (balance = total − paid). */
  balanceDue: { totalCents: number; rows: BalanceRow[] };
  /** Card 6 — pickups waiting at this store, mine flagged. */
  pickups: PickupRow[];
  /** Card 7 — my commission for the current period. */
  commission: {
    period: string;
    accruedCents: number;
    pendingCents: number;
    approvedCents: number;
    paidCents: number;
    lastPaid: { period: string; cents: number } | null;
  };
  /** Card 8 — what I may offer without asking. */
  promos: {
    codes: PromoRow[];
    priceVariance: { tier1Pct: number; tier1MaxCents: number; tier2Pct: number };
  };
  /** Card 9 — returns and exchanges I started that are not finished. */
  myReturns: ReturnRow[];
  /** Card 10 — the store today and where I stand this week. */
  scoreboard: {
    storeTodayCents: number;
    storeTodayDocuments: number;
    myShareCents: number;
    week: { rank: number | null; sellers: number; myCents: number; leaderCents: number };
  };
}

const NOT_WRITTEN = ['draft', 'quote', 'cancelled'];
const LIVE_ORDER = ['open', 'partially_fulfilled', 'fulfilled'];
const RETURN_DONE = ['completed', 'cancelled'];

/**
 * The Cashier home — "My Day" (owner 2026-09-01, §12.3). Ten cards, every
 * one answering a question the person at the register actually asks:
 * how am I doing, is my drawer right, who do I call back, whose
 * delivery is today, who still owes, who is here to pick up, what have
 * I earned, what can I offer, what did I start that isn't finished, and
 * how does the store look. Everything "mine" keys on the signed-in
 * membership (orders) or user (register sales, returns, shifts); the
 * store-level cards follow a picked store like the manager home does.
 *
 * Money rules as everywhere: written = split-attributed order totals
 * plus register sales; balance due is computed from the payment ledger,
 * never stored; imported legacy rows are excluded (D8).
 */
@TenantScoped()
@Controller('v1/dashboard/my-day')
export class MyDayController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get()
  @RequirePermission('cashier.dashboard.view')
  async summary(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
  ): Promise<MyDaySummary> {
    const businessId = tenant.businessId!;
    const me = tenant.membershipId;
    const myUserId = tenant.userId;
    if (!me || !myUserId) {
      throw new ForbiddenException('My Day needs a signed-in member');
    }

    // Which store is "here"? Approved stores for a selling-restricted
    // member, every active store otherwise; a warehouse never leads.
    const pickable = await this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        timezone: schema.locations.timezone,
        locationType: schema.locations.locationType,
      })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.businessId, businessId),
          eq(schema.locations.isActive, true),
          tenant.sellingScope === 'approved'
            ? inArray(schema.locations.id, tenant.scopeLocationIds ?? [])
            : undefined,
        ),
      )
      .orderBy(schema.locations.name);
    if (pickable.length === 0) {
      throw new BadRequestException('No stores are available to this member');
    }
    const loc = locationId
      ? pickable.find((l) => l.id === locationId)
      : (pickable.find((l) => l.locationType !== 'warehouse') ?? pickable[0]);
    if (!loc) throw new ForbiddenException('You are not approved for that store');
    const tz = loc.timezone;

    const [dayRow] = await this.db
      .select({
        today: sql<string>`(now() AT TIME ZONE ${tz})::date::text`,
        tomorrow: sql<string>`((now() AT TIME ZONE ${tz})::date + 1)::text`,
        lastWeek: sql<string>`((now() AT TIME ZONE ${tz})::date - 7)::text`,
        period: sql<string>`to_char(now() AT TIME ZONE ${tz}, 'YYYY-MM')`,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const today = dayRow!.today;
    const tomorrow = dayRow!.tomorrow;
    const lastWeek = dayRow!.lastWeek;
    const period = dayRow!.period;

    const [
      todayStats,
      lastWeekStats,
      drawer,
      callbacks,
      myDeliveries,
      balanceDue,
      pickups,
      commission,
      promos,
      myReturns,
      scoreboard,
    ] = await Promise.all([
      this.dayStats(tenant, me, myUserId, tz, today),
      this.dayStats(tenant, me, myUserId, tz, lastWeek),
      this.drawer(businessId, myUserId, loc.id),
      this.callbacks(tenant, me),
      this.myDeliveries(tenant, me, today, tomorrow),
      this.balanceDue(tenant, me, today),
      this.pickups(businessId, me, loc.id),
      this.commission(businessId, me, period),
      this.promos(businessId),
      this.myReturns(businessId, myUserId),
      this.scoreboard(businessId, me, myUserId, loc.id, tz, today),
    ]);

    return {
      date: today,
      location: { id: loc.id, name: loc.name, timezone: tz },
      locations: pickable.map((l) => ({
        id: l.id,
        name: l.name,
        locationType: l.locationType,
      })),
      myDay: { today: todayStats, lastWeek: lastWeekStats },
      drawer,
      callbacks,
      myDeliveries,
      balanceDue,
      pickups,
      commission,
      promos,
      myReturns,
      scoreboard,
    };
  }

  /** My split-attributed share of an order's total, as SQL. */
  private myShare(me: string) {
    const o = schema.orders;
    return sql<number>`CASE
      WHEN ${o.salespersonMembershipId} = ${me}
        THEN ROUND(${o.totalCents}::bigint * (CASE WHEN ${o.secondSalespersonMembershipId} IS NOT NULL THEN COALESCE(${o.splitBps}, 10000) ELSE 10000 END) / 10000.0)
      WHEN ${o.secondSalespersonMembershipId} = ${me}
        THEN ROUND(${o.totalCents}::bigint * (10000 - COALESCE(${o.splitBps}, 10000)) / 10000.0)
      ELSE 0 END`;
  }

  private mineCond(me: string) {
    return or(
      eq(schema.orders.salespersonMembershipId, me),
      eq(schema.orders.secondSalespersonMembershipId, me),
    )!;
  }

  // --- Card 1 ---------------------------------------------------------
  private async dayStats(
    tenant: RequestTenantContext,
    me: string,
    myUserId: string,
    tz: string,
    day: string,
  ): Promise<DayStats> {
    const businessId = tenant.businessId!;
    const localDay = (col: unknown) => sql`(${col} AT TIME ZONE ${tz})::date::text`;
    const [orders] = await this.db
      .select({
        cents: sql<number>`COALESCE(SUM(${this.myShare(me)}), 0)::int`,
        documents: sql<number>`COUNT(*)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          notInArray(schema.orders.status, NOT_WRITTEN),
          isNull(schema.orders.importedAt),
          this.mineCond(me),
          sql`${localDay(schema.orders.createdAt)} = ${day}`,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    const [sales] = await this.db
      .select({
        cents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int`,
        documents: sql<number>`COUNT(*)::int`,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          eq(schema.sales.associateUserId, myUserId),
          sql`${localDay(schema.sales.createdAt)} = ${day}`,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );
    // Collected: money that landed today on documents I wrote, whenever
    // they were written — a deposit taken today on last week's order is
    // today's collection.
    const [orderPay] = await this.db
      .select({ cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int` })
      .from(schema.payments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.orders.importedAt),
          this.mineCond(me),
          sql`${localDay(schema.payments.createdAt)} = ${day}`,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    const [salePay] = await this.db
      .select({ cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int` })
      .from(schema.payments)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.sales.importedAt),
          eq(schema.sales.associateUserId, myUserId),
          sql`${localDay(schema.payments.createdAt)} = ${day}`,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );
    const writtenCents = (orders?.cents ?? 0) + (sales?.cents ?? 0);
    const documents = (orders?.documents ?? 0) + (sales?.documents ?? 0);
    return {
      writtenCents,
      documents,
      collectedCents: (orderPay?.cents ?? 0) + (salePay?.cents ?? 0),
      avgTicketCents: documents > 0 ? Math.round(writtenCents / documents) : 0,
    };
  }

  // --- Card 2 ---------------------------------------------------------
  private async drawer(
    businessId: string,
    myUserId: string,
    storeId: string,
  ): Promise<MyDaySummary['drawer']> {
    const [open] = await this.db
      .select({
        id: schema.cashShifts.id,
        locationId: schema.cashShifts.locationId,
        locationName: schema.locations.name,
        openedAt: schema.cashShifts.openedAt,
        openingFloatCents: schema.cashShifts.openingFloatCents,
        suspendedAt: schema.cashShifts.suspendedAt,
      })
      .from(schema.cashShifts)
      .leftJoin(schema.locations, eq(schema.locations.id, schema.cashShifts.locationId))
      .where(
        and(
          eq(schema.cashShifts.businessId, businessId),
          eq(schema.cashShifts.openedByUserId, myUserId),
          isNull(schema.cashShifts.closedAt),
        ),
      )
      .orderBy(desc(schema.cashShifts.openedAt))
      .limit(1);

    let shift: MyDaySummary['drawer']['shift'] = null;
    if (open) {
      // Same drawer math as the close ritual (cash-shifts.controller):
      // cash on register sales completed since open + cash taken on
      // orders since open at this location; imported rows never touched
      // the drawer (D8).
      const [saleCash] = await this.db
        .select({ cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int` })
        .from(schema.payments)
        .innerJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
        .where(
          and(
            eq(schema.payments.businessId, businessId),
            eq(schema.sales.locationId, open.locationId),
            eq(schema.payments.method, 'cash'),
            eq(schema.payments.status, 'succeeded'),
            isNull(schema.sales.importedAt),
            sql`${schema.sales.completedAt} >= ${open.openedAt.toISOString()}::timestamptz`,
          ),
        );
      const [orderCash] = await this.db
        .select({ cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int` })
        .from(schema.payments)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
        .where(
          and(
            eq(schema.payments.businessId, businessId),
            eq(schema.orders.locationId, open.locationId),
            eq(schema.payments.method, 'cash'),
            eq(schema.payments.status, 'succeeded'),
            isNull(schema.orders.importedAt),
            sql`${schema.payments.createdAt} >= ${open.openedAt.toISOString()}::timestamptz`,
          ),
        );
      const cashInCents = (saleCash?.cents ?? 0) + (orderCash?.cents ?? 0);
      const hoursOpen = (Date.now() - open.openedAt.getTime()) / 3_600_000;
      shift = {
        id: open.id,
        locationId: open.locationId,
        locationName: open.locationName ?? null,
        openedAt: open.openedAt,
        hoursOpen: Math.round(hoursOpen * 10) / 10,
        openingFloatCents: open.openingFloatCents,
        cashInCents,
        expectedCashCents: open.openingFloatCents + cashInCents,
        suspended: open.suspendedAt != null,
        stale: hoursOpen >= 12,
      };
    }

    const [last] = await this.db
      .select({
        closedAt: schema.cashShifts.closedAt,
        varianceCents: schema.cashShifts.varianceCents,
      })
      .from(schema.cashShifts)
      .where(
        and(
          eq(schema.cashShifts.businessId, businessId),
          eq(schema.cashShifts.locationId, storeId),
          sql`${schema.cashShifts.closedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(schema.cashShifts.closedAt))
      .limit(1);
    return {
      shift,
      lastClose: last?.closedAt
        ? { closedAt: last.closedAt, varianceCents: last.varianceCents ?? null }
        : null,
    };
  }

  // --- Card 3 ---------------------------------------------------------
  private async callbacks(tenant: RequestTenantContext, me: string): Promise<CallbackRow[]> {
    const rows = await this.db
      .select({
        orderId: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
        phone: schema.customers.phone,
        totalCents: schema.orders.totalCents,
        createdAt: schema.orders.createdAt,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, tenant.businessId!),
          inArray(schema.orders.status, ['draft', 'quote']),
          isNull(schema.orders.importedAt),
          this.mineCond(me),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .orderBy(asc(schema.orders.createdAt))
      .limit(15);
    const now = Date.now();
    return rows.map((r) => ({
      orderId: r.orderId,
      number: r.number,
      status: r.status,
      customerName: [r.first, r.last].filter(Boolean).join(' ') || null,
      phone: r.phone ?? null,
      totalCents: r.totalCents,
      createdAt: r.createdAt,
      ageDays: Math.floor((now - r.createdAt.getTime()) / 86_400_000),
    }));
  }

  // --- Card 4 ---------------------------------------------------------
  private async myDeliveries(
    tenant: RequestTenantContext,
    me: string,
    today: string,
    tomorrow: string,
  ): Promise<MyDeliveryRow[]> {
    const rows = await this.db
      .select({
        deliveryId: schema.deliveries.id,
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
        phone: sql<
          string | null
        >`COALESCE(${schema.orders.addressPhone}, ${schema.customers.phone})`,
        scheduledDate: schema.deliveries.scheduledDate,
        windowStart: schema.deliveries.windowStart,
        windowEnd: schema.deliveries.windowEnd,
        status: schema.deliveries.status,
        driverName: schema.users.name,
      })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(schema.memberships, eq(schema.memberships.id, schema.deliveries.driverMembershipId))
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(
        and(
          eq(schema.deliveries.businessId, tenant.businessId!),
          inArray(schema.deliveries.scheduledDate, [today, tomorrow]),
          notInArray(schema.deliveries.status, ['cancelled']),
          isNull(schema.orders.importedAt),
          this.mineCond(me),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .orderBy(
        asc(schema.deliveries.scheduledDate),
        asc(schema.deliveries.windowStart),
        asc(schema.deliveries.createdAt),
      )
      .limit(30);
    return rows.map((r) => ({
      deliveryId: r.deliveryId,
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      customerName: [r.first, r.last].filter(Boolean).join(' ') || null,
      phone: r.phone ?? null,
      scheduledDate: r.scheduledDate,
      windowStart: r.windowStart ?? null,
      windowEnd: r.windowEnd ?? null,
      status: r.status,
      driverName: r.driverName ?? null,
      when: r.scheduledDate === today ? 'today' : 'tomorrow',
    }));
  }

  // --- Card 5 ---------------------------------------------------------
  private async balanceDue(
    tenant: RequestTenantContext,
    me: string,
    today: string,
  ): Promise<MyDaySummary['balanceDue']> {
    const paid = sql<number>`COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.order_id = ${schema.orders.id} AND p.status = 'succeeded'), 0)::int`;
    const rows = await this.db
      .select({
        orderId: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
        phone: schema.customers.phone,
        fulfillmentType: schema.orders.fulfillmentType,
        requestedDate: schema.orders.requestedDate,
        totalCents: schema.orders.totalCents,
        paidCents: paid,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, tenant.businessId!),
          inArray(schema.orders.status, LIVE_ORDER),
          isNull(schema.orders.importedAt),
          this.mineCond(me),
          sql`${schema.orders.totalCents} > ${paid}`,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .orderBy(sql`${schema.orders.requestedDate} ASC NULLS LAST`, asc(schema.orders.createdAt))
      .limit(20);
    const mapped: BalanceRow[] = rows.map((r) => ({
      orderId: r.orderId,
      number: r.number,
      status: r.status,
      customerName: [r.first, r.last].filter(Boolean).join(' ') || null,
      phone: r.phone ?? null,
      fulfillmentType: r.fulfillmentType ?? null,
      requestedDate: r.requestedDate ?? null,
      totalCents: r.totalCents,
      paidCents: r.paidCents,
      balanceCents: r.totalCents - r.paidCents,
      dueNow: r.requestedDate != null && r.requestedDate <= today,
    }));
    return {
      totalCents: mapped.reduce((s, r) => s + r.balanceCents, 0),
      rows: mapped,
    };
  }

  // --- Card 6 ---------------------------------------------------------
  private async pickups(businessId: string, me: string, storeId: string): Promise<PickupRow[]> {
    const pickupLoc = sql`COALESCE(${schema.orders.pickupLocationId}, ${schema.orders.locationId})`;
    const orders = await this.db
      .select({
        orderId: schema.orders.id,
        number: schema.orders.number,
        createdAt: schema.orders.createdAt,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
        phone: schema.customers.phone,
        primary: schema.orders.salespersonMembershipId,
        second: schema.orders.secondSalespersonMembershipId,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          inArray(schema.orders.fulfillmentType, ['pickup', 'will_call']),
          inArray(schema.orders.status, ['open', 'partially_fulfilled']),
          isNull(schema.orders.importedAt),
          sql`${pickupLoc} = ${storeId}::uuid`,
        ),
      )
      .orderBy(asc(schema.orders.createdAt))
      .limit(30);
    if (orders.length === 0) return [];
    const lines = await this.db
      .select({
        orderId: schema.orderLines.orderId,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
        lineType: schema.orderLines.lineType,
      })
      .from(schema.orderLines)
      .where(
        inArray(
          schema.orderLines.orderId,
          orders.map((o) => o.orderId),
        ),
      );
    const readyBy = new Map<string, boolean>(orders.map((o) => [o.orderId, true]));
    for (const l of lines) {
      if (l.lineType !== 'stock') continue;
      if (l.qtyReserved + l.qtyFulfilled < l.quantity) readyBy.set(l.orderId, false);
    }
    const now = Date.now();
    return orders.map((o) => ({
      orderId: o.orderId,
      number: o.number,
      customerName: [o.first, o.last].filter(Boolean).join(' ') || null,
      phone: o.phone ?? null,
      ageDays: Math.floor((now - o.createdAt.getTime()) / 86_400_000),
      ready: readyBy.get(o.orderId) ?? false,
      mine: o.primary === me || o.second === me,
    }));
  }

  // --- Card 7 ---------------------------------------------------------
  private async commission(
    businessId: string,
    me: string,
    period: string,
  ): Promise<MyDaySummary['commission']> {
    const c = schema.commissionEntries;
    const [row] = await this.db
      .select({
        accrued: sql<number>`COALESCE(SUM(${c.amountCents}), 0)::int`,
        pending: sql<number>`COALESCE(SUM(${c.amountCents}) FILTER (WHERE ${c.status} = 'pending'), 0)::int`,
        approved: sql<number>`COALESCE(SUM(${c.amountCents}) FILTER (WHERE ${c.status} = 'approved'), 0)::int`,
        paid: sql<number>`COALESCE(SUM(${c.amountCents}) FILTER (WHERE ${c.status} = 'paid'), 0)::int`,
      })
      .from(c)
      .where(and(eq(c.businessId, businessId), eq(c.membershipId, me), eq(c.period, period)));
    const [last] = await this.db
      .select({
        period: c.period,
        cents: sql<number>`COALESCE(SUM(${c.amountCents}), 0)::int`,
      })
      .from(c)
      .where(
        and(
          eq(c.businessId, businessId),
          eq(c.membershipId, me),
          eq(c.status, 'paid'),
          sql`${c.period} < ${period}`,
        ),
      )
      .groupBy(c.period)
      .orderBy(desc(c.period))
      .limit(1);
    return {
      period,
      accruedCents: row?.accrued ?? 0,
      pendingCents: row?.pending ?? 0,
      approvedCents: row?.approved ?? 0,
      paidCents: row?.paid ?? 0,
      lastPaid: last ? { period: last.period, cents: last.cents } : null,
    };
  }

  // --- Card 8 ---------------------------------------------------------
  private async promos(businessId: string): Promise<MyDaySummary['promos']> {
    const d = schema.discountCodes;
    const rows = await this.db
      .select({
        id: d.id,
        code: d.code,
        kind: d.kind,
        value: d.value,
        description: d.description,
        minSubtotalCents: d.minSubtotalCents,
        endsAt: d.endsAt,
        usageLimit: d.usageLimit,
        usageCount: d.usageCount,
      })
      .from(d)
      .where(
        and(
          eq(d.businessId, businessId),
          eq(d.isActive, true),
          sql`(${d.startsAt} IS NULL OR ${d.startsAt} <= now())`,
          sql`(${d.endsAt} IS NULL OR ${d.endsAt} >= now())`,
          sql`(${d.usageLimit} IS NULL OR ${d.usageCount} < ${d.usageLimit})`,
        ),
      )
      .orderBy(sql`${d.endsAt} ASC NULLS LAST`, asc(d.code))
      .limit(12);
    const [biz] = await this.db
      .select({ ops: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const pv = ((biz?.ops as Record<string, unknown> | null)?.priceVariance ?? {}) as {
      tier1Pct?: number;
      tier1MaxCents?: number;
      tier2Pct?: number;
    };
    return {
      codes: rows.map((r) => ({
        id: r.id,
        code: r.code,
        kind: r.kind,
        value: r.value,
        description: r.description ?? null,
        minSubtotalCents: r.minSubtotalCents ?? null,
        endsAt: r.endsAt ?? null,
        remainingUses: r.usageLimit != null ? Math.max(0, r.usageLimit - r.usageCount) : null,
      })),
      // Same defaults the enforcement service applies (controls/price-variance).
      priceVariance: {
        tier1Pct: pv.tier1Pct ?? 5,
        tier1MaxCents: pv.tier1MaxCents ?? 5000,
        tier2Pct: pv.tier2Pct ?? 15,
      },
    };
  }

  // --- Card 9 ---------------------------------------------------------
  private async myReturns(businessId: string, myUserId: string): Promise<ReturnRow[]> {
    const returns = await this.db
      .select({
        id: schema.orderReturns.id,
        number: schema.orderReturns.rmaNumber,
        status: schema.orderReturns.status,
        orderId: schema.orderReturns.orderId,
        orderNumber: schema.orders.number,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
        amountCents: schema.orderReturns.amountCents,
        createdAt: schema.orderReturns.authorizedAt,
      })
      .from(schema.orderReturns)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.orderReturns.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orderReturns.customerId))
      .where(
        and(
          eq(schema.orderReturns.businessId, businessId),
          eq(schema.orderReturns.createdByUserId, myUserId),
          notInArray(schema.orderReturns.status, RETURN_DONE),
        ),
      )
      .orderBy(asc(schema.orderReturns.authorizedAt))
      .limit(15);
    const exchanges = await this.db
      .select({
        id: schema.exchanges.id,
        number: schema.exchanges.number,
        status: schema.exchanges.status,
        orderId: schema.exchanges.originalOrderId,
        orderNumber: schema.orders.number,
        first: schema.customers.firstName,
        last: schema.customers.lastName,
        createdAt: schema.exchanges.createdAt,
      })
      .from(schema.exchanges)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.exchanges.originalOrderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.exchanges.businessId, businessId),
          eq(schema.exchanges.createdByUserId, myUserId),
          notInArray(schema.exchanges.status, RETURN_DONE),
        ),
      )
      .orderBy(asc(schema.exchanges.createdAt))
      .limit(15);
    const rows: ReturnRow[] = [
      ...returns.map((r) => ({
        id: r.id,
        kind: 'return' as const,
        number: r.number,
        status: r.status,
        orderId: r.orderId,
        orderNumber: r.orderNumber ?? null,
        customerName: [r.first, r.last].filter(Boolean).join(' ') || null,
        amountCents: r.amountCents,
        createdAt: r.createdAt,
      })),
      ...exchanges.map((x) => ({
        id: x.id,
        kind: 'exchange' as const,
        number: x.number,
        status: x.status,
        orderId: x.orderId ?? null,
        orderNumber: x.orderNumber ?? null,
        customerName: [x.first, x.last].filter(Boolean).join(' ') || null,
        amountCents: null,
        createdAt: x.createdAt,
      })),
    ];
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // --- Card 10 --------------------------------------------------------
  private async scoreboard(
    businessId: string,
    me: string,
    myUserId: string,
    storeId: string,
    tz: string,
    today: string,
  ): Promise<MyDaySummary['scoreboard']> {
    const localDay = (col: unknown) => sql`(${col} AT TIME ZONE ${tz})::date::text`;
    const weekStart = sql`date_trunc('week', now() AT TIME ZONE ${tz})`;
    const o = schema.orders;
    const s = schema.sales;

    // The store today: every seller's written business at this store.
    const [storeOrders] = await this.db
      .select({
        cents: sql<number>`COALESCE(SUM(${o.totalCents}), 0)::int`,
        documents: sql<number>`COUNT(*)::int`,
        mine: sql<number>`COALESCE(SUM(${this.myShare(me)}), 0)::int`,
      })
      .from(o)
      .where(
        and(
          eq(o.businessId, businessId),
          eq(o.locationId, storeId),
          notInArray(o.status, NOT_WRITTEN),
          isNull(o.importedAt),
          sql`${localDay(o.createdAt)} = ${today}`,
        ),
      );
    const [storeSales] = await this.db
      .select({
        cents: sql<number>`COALESCE(SUM(${s.totalCents}), 0)::int`,
        documents: sql<number>`COUNT(*)::int`,
        mine: sql<number>`COALESCE(SUM(CASE WHEN ${s.associateUserId} = ${myUserId} THEN ${s.totalCents} ELSE 0 END), 0)::int`,
      })
      .from(s)
      .where(
        and(
          eq(s.businessId, businessId),
          eq(s.locationId, storeId),
          eq(s.status, 'completed'),
          isNull(s.importedAt),
          sql`${localDay(s.createdAt)} = ${today}`,
        ),
      );

    // This week, by seller, across the store: orders split-attributed
    // by membership, register sales by the associate's membership.
    const weekRows = (await this.db.execute(sql`
      WITH attributed AS (
        SELECT salesperson_membership_id AS membership_id,
               ROUND(total_cents::bigint * (CASE WHEN second_salesperson_membership_id IS NOT NULL THEN COALESCE(split_bps, 10000) ELSE 10000 END) / 10000.0) AS cents
          FROM orders
         WHERE business_id = ${businessId} AND location_id = ${storeId}
           AND status NOT IN ('draft', 'quote', 'cancelled') AND imported_at IS NULL
           AND salesperson_membership_id IS NOT NULL
           AND (created_at AT TIME ZONE ${tz}) >= ${weekStart}
        UNION ALL
        SELECT second_salesperson_membership_id,
               ROUND(total_cents::bigint * (10000 - COALESCE(split_bps, 10000)) / 10000.0)
          FROM orders
         WHERE business_id = ${businessId} AND location_id = ${storeId}
           AND status NOT IN ('draft', 'quote', 'cancelled') AND imported_at IS NULL
           AND second_salesperson_membership_id IS NOT NULL
           AND (created_at AT TIME ZONE ${tz}) >= ${weekStart}
        UNION ALL
        SELECT m.id, sa.total_cents
          FROM sales sa
          JOIN memberships m ON m.user_id = sa.associate_user_id AND m.business_id = sa.business_id
         WHERE sa.business_id = ${businessId} AND sa.location_id = ${storeId}
           AND sa.status = 'completed' AND sa.imported_at IS NULL
           AND (sa.created_at AT TIME ZONE ${tz}) >= ${weekStart}
      )
      SELECT membership_id, SUM(cents)::bigint AS cents
        FROM attributed
       GROUP BY membership_id
       ORDER BY cents DESC`)) as unknown as { membership_id: string; cents: string | number }[];
    const ranked = weekRows.map((r) => ({ id: r.membership_id, cents: Number(r.cents) }));
    const myIdx = ranked.findIndex((r) => r.id === me);
    return {
      storeTodayCents: (storeOrders?.cents ?? 0) + (storeSales?.cents ?? 0),
      storeTodayDocuments: (storeOrders?.documents ?? 0) + (storeSales?.documents ?? 0),
      myShareCents: (storeOrders?.mine ?? 0) + (storeSales?.mine ?? 0),
      week: {
        rank: myIdx >= 0 ? myIdx + 1 : null,
        sellers: ranked.length,
        myCents: myIdx >= 0 ? ranked[myIdx]!.cents : 0,
        leaderCents: ranked[0]?.cents ?? 0,
      },
    };
  }
}
