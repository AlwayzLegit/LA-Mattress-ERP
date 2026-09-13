import { Controller, ForbiddenException, Get, Inject, Query } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { parseDayRange, tzDayEndExclusive, tzDayStart, type DayRange } from '../common/date-range';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

/**
 * The owner home (Claude Design hand-off, 2026-09-04): one call for the
 * KPI strip and the written-business chart, following the topbar's
 * period, store scope and compare-to; a second call for the filterable
 * orders table; and the sidebar's nav counts. Day boundaries are the
 * business's store-local days (first non-warehouse store's timezone,
 * the convention the operations home already uses).
 *
 * "Written" = orders created in the window (not draft/quote/cancelled);
 * "Register" = completed POS sales. Imported STORIS history is excluded
 * everywhere (D8).
 */

type CompareMode = 'none' | 'prior' | 'year';

interface TrendPoint {
  day: string;
  orderCents: number;
  registerCents: number;
}

export interface OwnerDashboard {
  date: string;
  range: DayRange;
  compare: CompareMode;
  compareRange: DayRange | null;
  timezone: string;
  kpis: {
    writtenCents: number;
    writtenCount: number;
    registerCents: number;
    ticketCount: number;
    refundsCents: number;
    refundCount: number;
    openOrders: number;
    openBalanceCents: number;
    /** Null when the caller lacks reports.financial.view. */
    receivablesCents: number | null;
    receivableAccounts: number | null;
    trucksToday: { booked: number; cap: number; byStatus: Record<string, number> };
  };
  previous: {
    writtenCents: number;
    registerCents: number;
    refundsCents: number;
  } | null;
  trend: TrendPoint[];
  compareTrend: TrendPoint[];
  /**
   * Redesign Phase 9 headline: company written today against the same
   * weekday last week and the same calendar day last month, plus the six
   * small figures and their baselines. Always store-local "today",
   * whatever window the chart is on.
   */
  today: {
    date: string;
    writtenCents: number;
    ticketCount: number;
    storeCount: number;
    avgTicketCents: number;
    lastWeek: { date: string; writtenCents: number };
    lastMonth: { date: string; writtenCents: number };
    /** Yesterday's written total — the day-one empty copy names it. */
    yesterdayWrittenCents: number;
    collectedCents: number;
    collectedLastWeekCents: number;
    balanceDueCents: number;
    refundsCents: number;
    refundsLastWeekCents: number;
    cancellations: number;
    cancellationsLastWeek: number;
    deliveries: { booked: number; cap: number };
  };
  monthToDate: { range: DayRange; writtenCents: number; prior: DayRange; priorCents: number };
  exceptions: { open: number; critical: number };
}

export interface OwnerOrderRow {
  id: string;
  number: string;
  status: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  locationId: string;
  storeName: string | null;
  fulfillmentType: string;
  /** Requested delivery / pickup day, YYYY-MM-DD. */
  promised: string | null;
  promisedLate: boolean;
  totalCents: number;
  balanceCents: number;
  rep: string | null;
  shortUnits: number;
  ageDays: number;
  createdAt: Date;
}

const OPEN_STATUSES = ['open'];
const PENDING_STATUSES = ['draft', 'quote'];

function shiftDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The same calendar day one month earlier, clamped to that month's length. */
export function sameDayLastMonth(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const lastOfPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const prev = new Date(Date.UTC(y, m - 2, Math.min(d, lastOfPrev)));
  return prev.toISOString().slice(0, 10);
}

function daysInclusive(range: DayRange): number {
  const a = Date.parse(`${range.start}T00:00:00Z`);
  const b = Date.parse(`${range.end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export function compareRangeFor(range: DayRange, mode: CompareMode): DayRange | null {
  if (mode === 'none') return null;
  if (mode === 'year') {
    return { start: shiftDays(range.start, -364), end: shiftDays(range.end, -364) };
  }
  const n = daysInclusive(range);
  const end = shiftDays(range.start, -1);
  return { start: shiftDays(end, -(n - 1)), end };
}

function parseLocationIds(raw?: string): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  return ids.length > 0 ? ids : null;
}

@TenantScoped()
@Controller('v1/dashboard')
export class OwnerDashboardController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  private async clock(
    businessId: string,
  ): Promise<{ tz: string; today: string; yesterday: string }> {
    const stores = await this.db
      .select({ timezone: schema.locations.timezone, locationType: schema.locations.locationType })
      .from(schema.locations)
      .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
      .orderBy(schema.locations.name);
    const tz = (stores.find((s) => s.locationType !== 'warehouse') ?? stores[0])?.timezone ?? 'UTC';
    const [row] = await this.db
      .select({
        today: sql<string>`(now() AT TIME ZONE ${tz})::date::text`,
        yesterday: sql<string>`((now() AT TIME ZONE ${tz})::date - 1)::text`,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    if (!row) {
      // RLS hid the business row: the request's tenant context does not
      // match this business. Say so instead of crashing on `undefined`.
      throw new ForbiddenException('Business is not in scope for this session');
    }
    return { tz, today: row.today, yesterday: row.yesterday };
  }

  /** Sidebar counts: open orders, past-promise orders, open exceptions, today's trucks. */
  @Get('nav-counts')
  @RequirePermission('orders.view')
  async navCounts(@CurrentTenant() tenant: RequestTenantContext): Promise<{
    openOrders: number;
    atRisk: number;
    exceptions: number;
    deliveriesToday: number;
  }> {
    const businessId = tenant.businessId!;
    const { today } = await this.clock(businessId);
    const scope = salesScopeCond(tenant, schema.orders.locationId);
    const [orders] = await this.db
      .select({
        open: sql<number>`count(*) FILTER (WHERE ${schema.orders.status} = 'open')::int`,
        late: sql<number>`count(*) FILTER (WHERE ${schema.orders.status} = 'open' AND ${schema.orders.requestedDate} IS NOT NULL AND ${schema.orders.requestedDate} < ${today}::date)::int`,
      })
      .from(schema.orders)
      .where(
        and(eq(schema.orders.businessId, businessId), isNull(schema.orders.importedAt), scope),
      );
    const [exc] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.exceptionEvents)
      .where(
        and(
          eq(schema.exceptionEvents.businessId, businessId),
          isNull(schema.exceptionEvents.acknowledgedAt),
        ),
      );
    const [del] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .where(
        and(
          eq(schema.deliveries.businessId, businessId),
          eq(schema.deliveries.scheduledDate, today),
          sql`${schema.deliveries.status} != 'cancelled'`,
          scope,
        ),
      );
    return {
      openOrders: orders?.open ?? 0,
      atRisk: orders?.late ?? 0,
      exceptions: exc?.n ?? 0,
      deliveriesToday: del?.n ?? 0,
    };
  }

  @Get('owner')
  @RequirePermission('reports.sales.view')
  async owner(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
    @Query('compare') compareQ?: string,
    @Query('locationIds') locationIdsQ?: string,
  ): Promise<OwnerDashboard> {
    const businessId = tenant.businessId!;
    const { tz, today, yesterday } = await this.clock(businessId);
    const range = parseDayRange(startQ, endQ) ?? { start: shiftDays(today, -29), end: today };
    const compare: CompareMode = compareQ === 'none' || compareQ === 'year' ? compareQ : 'prior';
    const compareRange = compareRangeFor(range, compare);
    const locationIds = parseLocationIds(locationIdsQ);

    const scopeOrders = and(
      salesScopeCond(tenant, schema.orders.locationId),
      locationIds ? inArray(schema.orders.locationId, locationIds) : undefined,
    );
    const scopeSales = and(
      salesScopeCond(tenant, schema.sales.locationId),
      locationIds ? inArray(schema.sales.locationId, locationIds) : undefined,
    );

    const localDay = (col: unknown) => sql<string>`(${col} AT TIME ZONE ${tz})::date::text`;

    const trendFor = async (r: DayRange): Promise<TrendPoint[]> => {
      const from = tzDayStart(r.start, tz);
      const to = tzDayEndExclusive(r.end, tz);
      const orderRows = await this.db
        .select({
          day: localDay(schema.orders.createdAt),
          cents: sql<number>`coalesce(sum(${schema.orders.totalCents}), 0)::int`,
        })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
            isNull(schema.orders.importedAt),
            sql`${schema.orders.createdAt} >= ${from} AND ${schema.orders.createdAt} < ${to}`,
            scopeOrders,
          ),
        )
        .groupBy(sql`1`);
      const saleRows = await this.db
        .select({
          day: localDay(schema.sales.createdAt),
          cents: sql<number>`coalesce(sum(${schema.sales.totalCents}), 0)::int`,
        })
        .from(schema.sales)
        .where(
          and(
            eq(schema.sales.businessId, businessId),
            sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
            isNull(schema.sales.importedAt),
            sql`${schema.sales.createdAt} >= ${from} AND ${schema.sales.createdAt} < ${to}`,
            scopeSales,
          ),
        )
        .groupBy(sql`1`);
      const byDay = new Map<string, TrendPoint>();
      for (let d = r.start; d <= r.end; d = shiftDays(d, 1)) {
        byDay.set(d, { day: d, orderCents: 0, registerCents: 0 });
      }
      for (const o of orderRows) {
        const p = byDay.get(o.day);
        if (p) p.orderCents = o.cents;
      }
      for (const s of saleRows) {
        const p = byDay.get(s.day);
        if (p) p.registerCents = s.cents;
      }
      return [...byDay.values()];
    };

    const refundsFor = async (r: DayRange): Promise<{ cents: number; count: number }> => {
      const from = tzDayStart(r.start, tz);
      const to = tzDayEndExclusive(r.end, tz);
      const [row] = await this.db
        .select({
          count: sql<number>`count(*)::int`,
          cents: sql<number>`coalesce(sum(${schema.refunds.amountCents}), 0)::int`,
        })
        .from(schema.refunds)
        .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
        .where(
          and(
            eq(schema.refunds.businessId, businessId),
            sql`${schema.refunds.createdAt} >= ${from} AND ${schema.refunds.createdAt} < ${to}`,
            isNull(schema.sales.importedAt),
            scopeSales,
          ),
        );
      return { cents: row?.cents ?? 0, count: row?.count ?? 0 };
    };

    const countFor = async (r: DayRange): Promise<{ orders: number; tickets: number }> => {
      const from = tzDayStart(r.start, tz);
      const to = tzDayEndExclusive(r.end, tz);
      const [o] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
            isNull(schema.orders.importedAt),
            sql`${schema.orders.createdAt} >= ${from} AND ${schema.orders.createdAt} < ${to}`,
            scopeOrders,
          ),
        );
      const [s] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.sales)
        .where(
          and(
            eq(schema.sales.businessId, businessId),
            sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
            isNull(schema.sales.importedAt),
            sql`${schema.sales.createdAt} >= ${from} AND ${schema.sales.createdAt} < ${to}`,
            scopeSales,
          ),
        );
      return { orders: o?.n ?? 0, tickets: s?.n ?? 0 };
    };

    const [trend, compareTrend, refunds, prevRefunds, counts] = await Promise.all([
      trendFor(range),
      compareRange ? trendFor(compareRange) : Promise.resolve([] as TrendPoint[]),
      refundsFor(range),
      compareRange ? refundsFor(compareRange) : Promise.resolve(null),
      countFor(range),
    ]);
    const sum = (rows: TrendPoint[], k: 'orderCents' | 'registerCents') =>
      rows.reduce((a, p) => a + p[k], 0);

    // Open book: orders still open, and what they still owe.
    const paidExpr = sql<number>`COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.order_id = ${schema.orders.id} AND p.status = 'succeeded'), 0)`;
    const [openBook] = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        balance: sql<number>`coalesce(sum(GREATEST(${schema.orders.totalCents} - ${paidExpr}, 0)), 0)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          inArray(schema.orders.status, OPEN_STATUSES),
          isNull(schema.orders.importedAt),
          scopeOrders,
        ),
      );

    // Receivables (financial permission): every unpaid balance on a live order.
    let receivablesCents: number | null = null;
    let receivableAccounts: number | null = null;
    if (tenant.isSuperAdmin || tenant.permissions.has('reports.financial.view')) {
      const [ar] = await this.db
        .select({
          cents: sql<number>`coalesce(sum(GREATEST(${schema.orders.totalCents} - ${paidExpr}, 0)), 0)::int`,
          accounts: sql<number>`count(DISTINCT ${schema.orders.customerId}) FILTER (WHERE ${schema.orders.totalCents} - ${paidExpr} > 0)::int`,
        })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            sql`${schema.orders.status} NOT IN ('quote', 'cancelled')`,
            scopeOrders,
          ),
        );
      receivablesCents = ar?.cents ?? 0;
      receivableAccounts = ar?.accounts ?? 0;
    }

    // Today's trucks against the cap.
    const deliveries = await this.db
      .select({ status: schema.deliveries.status, n: sql<number>`count(*)::int` })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .where(
        and(
          eq(schema.deliveries.businessId, businessId),
          eq(schema.deliveries.scheduledDate, today),
          sql`${schema.deliveries.status} != 'cancelled'`,
          scopeOrders,
        ),
      )
      .groupBy(schema.deliveries.status);
    const byStatus: Record<string, number> = {};
    let booked = 0;
    for (const d of deliveries) {
      byStatus[d.status] = d.n;
      booked += d.n;
    }
    const [biz] = await this.db
      .select({ ops: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const cap = (biz?.ops as { deliveryDailyCap?: number } | null)?.deliveryDailyCap ?? 15;

    // ---- Phase 9 headline, figures and side tiles -------------------------
    const lastWeekDay = shiftDays(today, -7);
    const lastMonthDay = sameDayLastMonth(today);
    const dayRange = (d: string): DayRange => ({ start: d, end: d });
    const mtd: DayRange = { start: `${today.slice(0, 7)}-01`, end: today };
    const priorMtd: DayRange = {
      start: `${lastMonthDay.slice(0, 7)}-01`,
      end: lastMonthDay,
    };
    const payLocation = sql<string>`COALESCE(${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`;
    const scopePayments = and(
      salesScopeCond(tenant, payLocation),
      locationIds
        ? sql`${payLocation} IN (${sql.join(
            locationIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : undefined,
    );
    const paymentsFor = async (
      r: DayRange,
      sign: 'in' | 'out',
    ): Promise<{ cents: number; count: number }> => {
      const from = tzDayStart(r.start, tz);
      const to = tzDayEndExclusive(r.end, tz);
      const [row] = await this.db
        .select({
          count: sql<number>`count(*)::int`,
          cents: sql<number>`coalesce(sum(${sign === 'in' ? schema.payments.amountCents : sql`-${schema.payments.amountCents}`}), 0)::int`,
        })
        .from(schema.payments)
        .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
        .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
        .leftJoin(schema.serviceOrders, eq(schema.serviceOrders.id, schema.payments.serviceOrderId))
        .where(
          and(
            eq(schema.payments.businessId, businessId),
            eq(schema.payments.status, 'succeeded'),
            sign === 'in'
              ? sql`${schema.payments.amountCents} > 0`
              : sql`${schema.payments.amountCents} < 0`,
            sql`${schema.payments.createdAt} >= ${from} AND ${schema.payments.createdAt} < ${to}`,
            isNull(schema.sales.importedAt),
            isNull(schema.orders.importedAt),
            isNull(schema.serviceOrders.importedAt),
            scopePayments,
          ),
        );
      return { cents: row?.cents ?? 0, count: row?.count ?? 0 };
    };
    const cancellationsFor = async (r: DayRange): Promise<number> => {
      const from = tzDayStart(r.start, tz);
      const to = tzDayEndExclusive(r.end, tz);
      const [row] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            eq(schema.orders.status, 'cancelled'),
            isNull(schema.orders.importedAt),
            sql`${schema.orders.cancelledAt} >= ${from} AND ${schema.orders.cancelledAt} < ${to}`,
            scopeOrders,
          ),
        );
      return row?.n ?? 0;
    };
    const writtenFor = async (r: DayRange): Promise<number> => {
      const rows = await trendFor(r);
      return sum(rows, 'orderCents') + sum(rows, 'registerCents');
    };
    const [
      todayWritten,
      todayCounts,
      lastWeekWritten,
      lastMonthWritten,
      yesterdayWritten,
      mtdWritten,
      priorMtdWritten,
      collectedToday,
      collectedLastWeek,
      refundsToday,
      refundsLastWeek,
      saleRefundsToday,
      saleRefundsLastWeek,
      cancelsToday,
      cancelsLastWeek,
      exceptionRows,
      storeRows,
    ] = await Promise.all([
      writtenFor(dayRange(today)),
      countFor(dayRange(today)),
      writtenFor(dayRange(lastWeekDay)),
      writtenFor(dayRange(lastMonthDay)),
      writtenFor(dayRange(yesterday)),
      writtenFor(mtd),
      writtenFor(priorMtd),
      paymentsFor(dayRange(today), 'in'),
      paymentsFor(dayRange(lastWeekDay), 'in'),
      paymentsFor(dayRange(today), 'out'),
      paymentsFor(dayRange(lastWeekDay), 'out'),
      refundsFor(dayRange(today)),
      refundsFor(dayRange(lastWeekDay)),
      cancellationsFor(dayRange(today)),
      cancellationsFor(dayRange(lastWeekDay)),
      this.db
        .select({ severity: schema.exceptionEvents.severity, n: sql<number>`count(*)::int` })
        .from(schema.exceptionEvents)
        .where(
          and(
            eq(schema.exceptionEvents.businessId, businessId),
            isNull(schema.exceptionEvents.acknowledgedAt),
          ),
        )
        .groupBy(schema.exceptionEvents.severity),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.locations)
        .where(
          and(
            eq(schema.locations.businessId, businessId),
            eq(schema.locations.isActive, true),
            sql`${schema.locations.locationType} <> 'warehouse'`,
            locationIds ? inArray(schema.locations.id, locationIds) : undefined,
            tenant.dataScope === 'store'
              ? inArray(schema.locations.id, tenant.scopeLocationIds ?? [])
              : undefined,
          ),
        ),
    ]);
    const todayTickets = todayCounts.orders + todayCounts.tickets;
    const exceptionsOpen = exceptionRows.reduce((n, r) => n + r.n, 0);
    const exceptionsCritical = exceptionRows.find((r) => r.severity === 'critical')?.n ?? 0;

    return {
      today: {
        date: today,
        writtenCents: todayWritten,
        ticketCount: todayTickets,
        storeCount: storeRows[0]?.n ?? 0,
        avgTicketCents: todayTickets > 0 ? Math.round(todayWritten / todayTickets) : 0,
        lastWeek: { date: lastWeekDay, writtenCents: lastWeekWritten },
        yesterdayWrittenCents: yesterdayWritten,
        lastMonth: { date: lastMonthDay, writtenCents: lastMonthWritten },
        collectedCents: collectedToday.cents,
        collectedLastWeekCents: collectedLastWeek.cents,
        balanceDueCents: openBook?.balance ?? 0,
        refundsCents: refundsToday.cents + saleRefundsToday.cents,
        refundsLastWeekCents: refundsLastWeek.cents + saleRefundsLastWeek.cents,
        cancellations: cancelsToday,
        cancellationsLastWeek: cancelsLastWeek,
        deliveries: { booked, cap },
      },
      monthToDate: {
        range: mtd,
        writtenCents: mtdWritten,
        prior: priorMtd,
        priorCents: priorMtdWritten,
      },
      exceptions: { open: exceptionsOpen, critical: exceptionsCritical },
      date: today,
      range,
      compare,
      compareRange,
      timezone: tz,
      kpis: {
        writtenCents: sum(trend, 'orderCents'),
        writtenCount: counts.orders,
        registerCents: sum(trend, 'registerCents'),
        ticketCount: counts.tickets,
        refundsCents: refunds.cents,
        refundCount: refunds.count,
        openOrders: openBook?.n ?? 0,
        openBalanceCents: openBook?.balance ?? 0,
        receivablesCents,
        receivableAccounts,
        trucksToday: { booked, cap, byStatus },
      },
      previous: compareRange
        ? {
            writtenCents: sum(compareTrend, 'orderCents'),
            registerCents: sum(compareTrend, 'registerCents'),
            refundsCents: prevRefunds?.cents ?? 0,
          }
        : null,
      trend,
      compareTrend,
    };
  }

  /**
   * The owner home's orders table: the window's orders with customer,
   * store, salesperson, balance and stock shortfall resolved, filtered,
   * searched, sorted and paged server-side.
   */
  @Get('owner/orders')
  @RequirePermission('orders.view')
  async ownerOrders(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
    @Query('locationIds') locationIdsQ?: string,
    @Query('filter') filterQ?: string,
    @Query('q') q?: string,
    @Query('sort') sortQ?: string,
    @Query('dir') dirQ?: string,
    @Query('page') pageQ?: string,
    @Query('pageSize') pageSizeQ?: string,
  ): Promise<{
    rows: OwnerOrderRow[];
    total: number;
    page: number;
    pageSize: number;
    counts: { all: number; open: number; pending: number; late: number };
  }> {
    const businessId = tenant.businessId!;
    const { tz, today } = await this.clock(businessId);
    const range = parseDayRange(startQ, endQ) ?? { start: shiftDays(today, -29), end: today };
    const locationIds = parseLocationIds(locationIdsQ);
    const filter =
      filterQ === 'open' || filterQ === 'pending' || filterQ === 'late' ? filterQ : 'all';
    const pageSize = Math.min(50, Math.max(5, Number(pageSizeQ) || 10));
    const pageWanted = Math.max(1, Number(pageQ) || 1);

    const paidExpr = sql<number>`COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.order_id = ${schema.orders.id} AND p.status = 'succeeded'), 0)::int`;
    const repUser = schema.users;
    const rows = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        customerId: schema.orders.customerId,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        customerPhone: schema.customers.phone,
        locationId: schema.orders.locationId,
        storeName: schema.locations.name,
        fulfillmentType: schema.orders.fulfillmentType,
        requestedDate: schema.orders.requestedDate,
        totalCents: schema.orders.totalCents,
        paidCents: paidExpr,
        repName: repUser.name,
        repEmail: repUser.email,
        createdAt: schema.orders.createdAt,
        ageDays: sql<number>`((now() AT TIME ZONE ${tz})::date - (${schema.orders.createdAt} AT TIME ZONE ${tz})::date)::int`,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.orders.locationId))
      .leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.orders.salespersonMembershipId),
      )
      .leftJoin(repUser, eq(repUser.id, schema.memberships.userId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          isNull(schema.orders.importedAt),
          sql`${schema.orders.status} != 'cancelled'`,
          sql`${schema.orders.createdAt} >= ${tzDayStart(range.start, tz)} AND ${schema.orders.createdAt} < ${tzDayEndExclusive(range.end, tz)}`,
          salesScopeCond(tenant, schema.orders.locationId),
          locationIds ? inArray(schema.orders.locationId, locationIds) : undefined,
        ),
      )
      .orderBy(desc(schema.orders.createdAt))
      .limit(1000);

    const shortMap = new Map<string, number>();
    const openIds = rows.filter((r) => r.status === 'open').map((r) => r.id);
    if (openIds.length > 0) {
      const shorts = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          short: sql<number>`COALESCE(SUM(GREATEST(${schema.orderLines.quantity} - ${schema.orderLines.qtyReserved} - ${schema.orderLines.qtyFulfilled}, 0)), 0)::int`,
        })
        .from(schema.orderLines)
        .where(
          and(
            inArray(schema.orderLines.orderId, openIds),
            eq(schema.orderLines.lineType, 'stock'),
            sql`${schema.orderLines.variantId} IS NOT NULL`,
          ),
        )
        .groupBy(schema.orderLines.orderId);
      for (const s of shorts) shortMap.set(s.orderId, s.short);
    }

    const needle = (q ?? '').trim().toLowerCase();
    let list: OwnerOrderRow[] = rows.map((r) => {
      const customerName = [r.customerFirst, r.customerLast].filter(Boolean).join(' ') || null;
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        customerId: r.customerId,
        customerName,
        customerPhone: r.customerPhone ?? null,
        locationId: r.locationId,
        storeName: r.storeName ?? null,
        fulfillmentType: r.fulfillmentType,
        promised: r.requestedDate,
        promisedLate: r.status === 'open' && !!r.requestedDate && r.requestedDate < today,
        totalCents: r.totalCents,
        balanceCents: Math.max(0, r.totalCents - r.paidCents),
        rep: r.repName ?? r.repEmail ?? null,
        shortUnits: shortMap.get(r.id) ?? 0,
        ageDays: r.ageDays,
        createdAt: r.createdAt,
      };
    });
    const isOpen = (r: OwnerOrderRow) => OPEN_STATUSES.includes(r.status);
    const isPending = (r: OwnerOrderRow) => PENDING_STATUSES.includes(r.status);
    const counts = {
      all: list.length,
      open: list.filter(isOpen).length,
      pending: list.filter(isPending).length,
      late: list.filter((r) => r.promisedLate).length,
    };
    if (filter === 'open') list = list.filter(isOpen);
    else if (filter === 'pending') list = list.filter(isPending);
    else if (filter === 'late') list = list.filter((r) => r.promisedLate);
    if (needle) {
      list = list.filter((r) =>
        `${r.number} ${r.customerName ?? ''} ${r.customerPhone ?? ''} ${r.rep ?? ''} ${r.storeName ?? ''}`
          .toLowerCase()
          .includes(needle),
      );
    }
    const statusRank: Record<string, number> = {
      draft: 0,
      quote: 1,
      open: 2,
      fulfilled: 3,
      completed: 4,
    };
    const keyOf: Record<string, (r: OwnerOrderRow) => number | string> = {
      number: (r) => r.number,
      customer: (r) => r.customerName ?? '',
      store: (r) => r.storeName ?? '',
      status: (r) => statusRank[r.status] ?? 9,
      promised: (r) => r.promised ?? '9999-12-31',
      total: (r) => r.totalCents,
      balance: (r) => r.balanceCents,
      rep: (r) => r.rep ?? '',
      age: (r) => r.ageDays,
      fulfillment: (r) => r.fulfillmentType,
    };
    const sortKey = sortQ && keyOf[sortQ] ? sortQ : 'age';
    const dir = dirQ === 'desc' ? -1 : 1;
    const key = keyOf[sortKey]!;
    list.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    });
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pageWanted, pages);
    const start = (page - 1) * pageSize;
    return { rows: list.slice(start, start + pageSize), total, page, pageSize, counts };
  }
}
