import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

interface StoreTile {
  locationId: string;
  locationName: string | null;
  saleCount: number;
  saleTotalCents: number;
  orderCount: number;
  orderTotalCents: number;
}

interface AssociateTile {
  userId: string | null;
  name: string | null;
  email: string | null;
  saleTotalCents: number;
  orderTotalCents: number;
  totalCents: number;
}

interface MorningDashboard {
  date: string;
  today: string;
  salesByStore: StoreTile[];
  salesByAssociate: AssociateTile[];
  deliveriesToday: {
    booked: number;
    cap: number;
    byStatus: Record<string, number>;
  };
  refundsCancellations: {
    id: string;
    action: string;
    actorEmail: string | null;
    orderNumber: string | null;
    createdAt: Date;
    changesJson: unknown;
  }[];
  modifiedOrders: {
    orderId: string;
    orderNumber: string | null;
    changeCount: number;
    actorEmails: string[];
  }[];
  openExceptions: {
    count: number;
    latest: { id: string; type: string; severity: string; summary: string; createdAt: Date }[];
  };
}

interface ManagerQueueRow {
  id: string;
  number: string;
  status: string;
  deliveryStatus: string | null;
  requestedDate: string | null;
  totalCents: number;
  balanceDueCents: number;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  salespersonName: string | null;
  salespersonMembershipId: string | null;
  secondSalespersonMembershipId: string | null;
  createdAt: Date;
  /** Stock-line units still unreserved (quantity − reserved − fulfilled). */
  shortUnits: number;
}

interface ManagerDashboard {
  /** Store-local calendar date the "today" numbers cover. */
  date: string;
  location: { id: string; name: string; timezone: string };
  /** Stores this member may point the dashboard at. */
  locations: { id: string; name: string }[];
  /** The caller's membership — the UI filters "mine" rows with it. */
  membershipId: string;
  kpis: {
    mine: {
      writtenCents: number;
      writtenCount: number;
      collectedCents: number;
      openCount: number;
      openBalanceCents: number;
      closed7dCount: number;
      closed7dCents: number;
      /** Written this store-local calendar month, ANY store. */
      monthWrittenCents: number;
      monthlyGoalCents: number | null;
      /** Commission accrued for the current payroll period. */
      commissionPeriodCents: number;
    };
    store: {
      writtenCents: number;
      writtenCount: number;
      collectedCents: number;
      /** Today's money by tender. */
      tenderMix: { method: string; cents: number }[];
    };
    exceptionsOpen: number;
    pastDuePromises: number;
    /** Open orders owing money for 14+ days. */
    unpaidAging: number;
  };
  drawer: { shiftOpen: boolean; closedToday: boolean; suspended: boolean };
  salesByDay: { day: string; mineCents: number; storeCents: number }[];
  leaderboardWeek: { name: string; cents: number }[];
  pipeline: { key: string; count: number; cents: number }[];
  queues: {
    myOpen: ManagerQueueRow[];
    storeOpen: ManagerQueueRow[];
    recentlyClosed: ManagerQueueRow[];
    todaysDeliveries: (ManagerQueueRow & {
      deliveryId: string;
      deliveryState: string;
      scheduledDate: string;
      windowStart: string | null;
      windowEnd: string | null;
      driverName: string | null;
    })[];
    /** Open orders with unreserved stock units, soonest promise first. */
    backorders: ManagerQueueRow[];
    /** Drafts and quotes going cold, oldest first. */
    staleCarts: ManagerQueueRow[];
  };
  returnsInFlight: {
    id: string;
    rmaNumber: string;
    status: string;
    createdAt: Date;
    orderId: string | null;
    orderNumber: string | null;
    customerName: string | null;
    salespersonMembershipId: string | null;
    salespersonName: string | null;
  }[];
  incoming: {
    kind: 'transfer' | 'po';
    id: string;
    number: string;
    status: string;
    expected: string | null;
  }[];
  lowStock: {
    variantId: string;
    productName: string;
    variantName: string | null;
    sku: string | null;
    available: number;
  }[];
  creditHolders: {
    customerId: string;
    customerName: string | null;
    phone: string | null;
    balanceCents: number;
    salespersonMembershipId: string | null;
    salespersonName: string | null;
  }[];
  activity: {
    orderId: string;
    orderNumber: string;
    latestAt: Date;
    events: { action: string; actorName: string | null; createdAt: Date }[];
  }[];
  /** Redesign Phase 9: the store headline with both baselines. */
  headline: {
    writtenCents: number;
    ticketCount: number;
    avgTicketCents: number;
    lastWeek: { date: string; writtenCents: number };
    lastMonth: { date: string; writtenCents: number };
    topRep: { name: string; count: number } | null;
  };
  /** "Needs a call today": past-due promises and orders short on stock. */
  needsCall: { total: number; atRisk: number; waitingOnStock: number };
  /** Last night's close: the most recent closed drawer at the store. */
  lastClose: {
    status: 'clean' | 'short' | 'over' | 'open' | 'suspended' | 'none';
    varianceCents: number | null;
    closedAt: Date | null;
    byName: string | null;
    closeDay: string | null;
  };
}

const REFUND_ACTIONS = [
  'order.return',
  'order.return_authorized',
  'order_return.cancel',
  'order.cancel',
  'order.price_adjustment',
  'sale.refund',
];
const MODIFY_ACTIONS = ['order.update', 'order.line.add', 'order.line.remove'];

/**
 * The P9 morning brief (PLAN-POS-OPERATIONS §12): yesterday's business
 * by store and by associate, today's truck load against the cap,
 * yesterday's refunds/cancellations with who did them, the daily
 * modification log, and the open exception count. The store-manager
 * view is the same endpoint scoped by `locationId`.
 *
 * Day boundaries are UTC calendar dates on created_at — consistent with
 * the Z-report convention already in use.
 */
@TenantScoped()
@Controller('v1/dashboard')
export class MorningDashboardController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get('morning')
  @RequirePermission('reports.sales.view')
  async morning(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('date') dateStr?: string,
    @Query('locationId') locationId?: string,
  ): Promise<MorningDashboard> {
    const date = dateStr ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    const today = new Date().toISOString().slice(0, 10);
    const businessId = tenant.businessId!;

    // --- Yesterday's business, by store ----------------------------------
    const saleAgg = await this.db
      .select({
        locationId: schema.sales.locationId,
        count: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${schema.sales.totalCents}), 0)::int`,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          sql`${schema.sales.createdAt}::date = ${date}`,
          locationId ? eq(schema.sales.locationId, locationId) : undefined,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(schema.sales.locationId);
    const orderAgg = await this.db
      .select({
        locationId: schema.orders.locationId,
        count: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${schema.orders.totalCents}), 0)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          sql`${schema.orders.createdAt}::date = ${date}`,
          salesScopeCond(tenant, schema.orders.locationId),
          locationId ? eq(schema.orders.locationId, locationId) : undefined,
        ),
      )
      .groupBy(schema.orders.locationId);

    const storeMap = new Map<string, StoreTile>();
    const store = (id: string): StoreTile => {
      const s = storeMap.get(id) ?? {
        locationId: id,
        locationName: null,
        saleCount: 0,
        saleTotalCents: 0,
        orderCount: 0,
        orderTotalCents: 0,
      };
      storeMap.set(id, s);
      return s;
    };
    for (const r of saleAgg) {
      const s = store(r.locationId);
      s.saleCount = r.count;
      s.saleTotalCents = r.total;
    }
    for (const r of orderAgg) {
      const s = store(r.locationId);
      s.orderCount = r.count;
      s.orderTotalCents = r.total;
    }
    if (storeMap.size > 0) {
      const names = await this.db
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(inArray(schema.locations.id, [...storeMap.keys()]));
      for (const n of names) {
        const s = storeMap.get(n.id);
        if (s) s.locationName = n.name;
      }
    }

    // --- Yesterday's business, by associate ------------------------------
    const associateMap = new Map<string, AssociateTile>();
    const associate = (userId: string): AssociateTile => {
      const a = associateMap.get(userId) ?? {
        userId,
        name: null,
        email: null,
        saleTotalCents: 0,
        orderTotalCents: 0,
        totalCents: 0,
      };
      associateMap.set(userId, a);
      return a;
    };
    const salesByUser = await this.db
      .select({
        userId: schema.sales.associateUserId,
        total: sql<number>`coalesce(sum(${schema.sales.totalCents}), 0)::int`,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          sql`${schema.sales.createdAt}::date = ${date}`,
          locationId ? eq(schema.sales.locationId, locationId) : undefined,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(schema.sales.associateUserId);
    for (const r of salesByUser) {
      if (r.userId) associate(r.userId).saleTotalCents += r.total;
    }
    // Orders attribute by salesperson membership with the split applied.
    const dayOrders = await this.db
      .select({
        totalCents: schema.orders.totalCents,
        primary: schema.orders.salespersonMembershipId,
        second: schema.orders.secondSalespersonMembershipId,
        splitBps: schema.orders.splitBps,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          sql`${schema.orders.createdAt}::date = ${date}`,
          salesScopeCond(tenant, schema.orders.locationId),
          locationId ? eq(schema.orders.locationId, locationId) : undefined,
        ),
      );
    const membershipIds = [
      ...new Set(dayOrders.flatMap((o) => [o.primary, o.second]).filter(Boolean) as string[]),
    ];
    const memberUsers = new Map<string, string>();
    if (membershipIds.length > 0) {
      const rows = await this.db
        .select({ id: schema.memberships.id, userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(inArray(schema.memberships.id, membershipIds));
      for (const r of rows) memberUsers.set(r.id, r.userId);
    }
    for (const o of dayOrders) {
      if (!o.primary) continue;
      const primaryUser = memberUsers.get(o.primary);
      const secondUser = o.second ? memberUsers.get(o.second) : null;
      const split = o.second && o.splitBps != null ? o.splitBps : 10000;
      if (primaryUser) {
        associate(primaryUser).orderTotalCents += Math.round((o.totalCents * split) / 10000);
      }
      if (secondUser) {
        associate(secondUser).orderTotalCents += Math.round(
          (o.totalCents * (10000 - split)) / 10000,
        );
      }
    }
    if (associateMap.size > 0) {
      const users = await this.db
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, [...associateMap.keys()]));
      for (const u of users) {
        const a = associateMap.get(u.id);
        if (a) {
          a.name = u.name;
          a.email = u.email;
        }
      }
    }
    for (const a of associateMap.values()) a.totalCents = a.saleTotalCents + a.orderTotalCents;

    // --- Today's deliveries vs the cap -----------------------------------
    const deliveriesToday = await this.db
      .select({
        status: schema.deliveries.status,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .where(
        and(
          eq(schema.deliveries.businessId, businessId),
          eq(schema.deliveries.scheduledDate, today),
          sql`${schema.deliveries.status} != 'cancelled'`,
          locationId ? eq(schema.orders.locationId, locationId) : undefined,
        ),
      )
      .groupBy(schema.deliveries.status);
    const byStatus: Record<string, number> = {};
    let booked = 0;
    for (const r of deliveriesToday) {
      byStatus[r.status] = r.count;
      booked += r.count;
    }
    const [biz] = await this.db
      .select({ ops: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const cap = (biz?.ops as { deliveryDailyCap?: number } | null)?.deliveryDailyCap ?? 15;

    // --- Refunds / cancellations with the associate ----------------------
    const refundRows = await this.db
      .select({
        id: schema.auditLogs.id,
        action: schema.auditLogs.action,
        actorEmail: schema.users.email,
        targetType: schema.auditLogs.targetType,
        targetId: schema.auditLogs.targetId,
        changesJson: schema.auditLogs.changesJson,
        createdAt: schema.auditLogs.createdAt,
      })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          inArray(schema.auditLogs.action, REFUND_ACTIONS),
          sql`${schema.auditLogs.createdAt}::date = ${date}`,
        ),
      )
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(50);

    // --- The daily modification log --------------------------------------
    const modRows = await this.db
      .select({
        actorEmail: schema.users.email,
        targetId: schema.auditLogs.targetId,
      })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          inArray(schema.auditLogs.action, MODIFY_ACTIONS),
          sql`${schema.auditLogs.createdAt}::date = ${date}`,
        ),
      );
    const modByOrder = new Map<string, { changeCount: number; actorEmails: Set<string> }>();
    for (const r of modRows) {
      if (!r.targetId) continue;
      const m = modByOrder.get(r.targetId) ?? { changeCount: 0, actorEmails: new Set<string>() };
      m.changeCount += 1;
      if (r.actorEmail) m.actorEmails.add(r.actorEmail);
      modByOrder.set(r.targetId, m);
    }

    // Resolve order numbers for both audit-derived tiles.
    const orderIds = [
      ...new Set(
        [
          ...refundRows
            .filter((r) => r.targetType === 'order' && r.targetId)
            .map((r) => r.targetId!),
          ...modByOrder.keys(),
        ].filter(Boolean),
      ),
    ];
    const numberById = new Map<string, string>();
    if (orderIds.length > 0) {
      const rows = await this.db
        .select({ id: schema.orders.id, number: schema.orders.number })
        .from(schema.orders)
        .where(inArray(schema.orders.id, orderIds));
      for (const r of rows) numberById.set(r.id, r.number);
    }

    // --- Open exceptions --------------------------------------------------
    const [openCount] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.exceptionEvents)
      .where(
        and(
          eq(schema.exceptionEvents.businessId, businessId),
          isNull(schema.exceptionEvents.acknowledgedAt),
        ),
      );
    const latestExceptions = await this.db
      .select({
        id: schema.exceptionEvents.id,
        type: schema.exceptionEvents.type,
        severity: schema.exceptionEvents.severity,
        summary: schema.exceptionEvents.summary,
        createdAt: schema.exceptionEvents.createdAt,
      })
      .from(schema.exceptionEvents)
      .where(
        and(
          eq(schema.exceptionEvents.businessId, businessId),
          isNull(schema.exceptionEvents.acknowledgedAt),
        ),
      )
      .orderBy(desc(schema.exceptionEvents.createdAt))
      .limit(5);

    return {
      date,
      today,
      salesByStore: [...storeMap.values()].sort(
        (a, b) => b.saleTotalCents + b.orderTotalCents - (a.saleTotalCents + a.orderTotalCents),
      ),
      salesByAssociate: [...associateMap.values()].sort((a, b) => b.totalCents - a.totalCents),
      deliveriesToday: { booked, cap, byStatus },
      refundsCancellations: refundRows.map((r) => ({
        id: r.id,
        action: r.action,
        actorEmail: r.actorEmail,
        orderNumber: r.targetId ? (numberById.get(r.targetId) ?? null) : null,
        createdAt: r.createdAt,
        changesJson: r.changesJson,
      })),
      modifiedOrders: [...modByOrder.entries()]
        .map(([orderId, m]) => ({
          orderId,
          orderNumber: numberById.get(orderId) ?? null,
          changeCount: m.changeCount,
          actorEmails: [...m.actorEmails],
        }))
        .sort((a, b) => b.changeCount - a.changeCount)
        .slice(0, 20),
      openExceptions: { count: openCount?.count ?? 0, latest: latestExceptions },
    };
  }

  /**
   * The store-manager dashboard (owner decision 2026-08-30): one
   * aggregate call, everything scoped to ONE store chosen from the
   * member's approved list, with "today" computed in that store's local
   * timezone — never UTC. Gated by the per-member `managerDashboard`
   * toggle, not by role. "Written" leads (documents created today, split
   * attribution for two salespeople); collected money rides alongside.
   */
  @Get('manager')
  @RequirePermission('orders.view')
  async manager(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
  ): Promise<ManagerDashboard> {
    const businessId = tenant.businessId!;
    if (!tenant.membershipId) {
      throw new ForbiddenException('The manager dashboard needs a signed-in member');
    }
    const [me] = await this.db
      .select({
        managerDashboard: schema.memberships.managerDashboard,
        monthlyGoalCents: schema.memberships.monthlyGoalCents,
      })
      .from(schema.memberships)
      .where(eq(schema.memberships.id, tenant.membershipId))
      .limit(1);
    // Redesign 2026-09-04: an Owner may preview the manager home from the
    // dashboard's role switch without the per-member toggle.
    if (!me?.managerDashboard && tenant.roleName !== 'Owner' && !tenant.isSuperAdmin) {
      throw new ForbiddenException(
        'The manager dashboard is not enabled for you — a manager can turn it on from your member page',
      );
    }

    // Which stores can this dashboard point at? Approved stores for a
    // selling-restricted member; every active store otherwise.
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
    if (!loc) {
      throw new ForbiddenException('You are not approved for that store');
    }
    const tz = loc.timezone;

    const [todayRow] = await this.db
      .select({
        today: sql<string>`(now() AT TIME ZONE ${tz})::date::text`,
        tomorrow: sql<string>`((now() AT TIME ZONE ${tz})::date + 1)::text`,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const today = todayRow!.today;
    const tomorrow = todayRow!.tomorrow;

    const localDay = (col: unknown) => sql<string>`(${col} AT TIME ZONE ${tz})::date::text`;

    // --- Written business, last 14 store-local days -----------------------
    const orderRows = await this.db
      .select({
        totalCents: schema.orders.totalCents,
        day: localDay(schema.orders.createdAt),
        primary: schema.orders.salespersonMembershipId,
        second: schema.orders.secondSalespersonMembershipId,
        splitBps: schema.orders.splitBps,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          eq(schema.orders.locationId, loc.id),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          sql`(${schema.orders.createdAt} AT TIME ZONE ${tz})::date >= (now() AT TIME ZONE ${tz})::date - 13`,
        ),
      );
    const saleRows = await this.db
      .select({
        totalCents: schema.sales.totalCents,
        day: localDay(schema.sales.createdAt),
        associateUserId: schema.sales.associateUserId,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          eq(schema.sales.locationId, loc.id),
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          sql`(${schema.sales.createdAt} AT TIME ZONE ${tz})::date >= (now() AT TIME ZONE ${tz})::date - 13`,
        ),
      );

    const myMembershipId = tenant.membershipId;
    const myUserId = tenant.userId;
    const mineShareBps = (o: {
      primary: string | null;
      second: string | null;
      splitBps: number | null;
    }) => {
      const split = o.second && o.splitBps != null ? o.splitBps : 10000;
      if (o.primary === myMembershipId) return split;
      if (o.second === myMembershipId) return 10000 - split;
      return 0;
    };

    // Day buckets (14 local days, oldest first, zero-filled).
    const dayKeys: string[] = [];
    {
      const [days] = await this.db
        .select({
          list: sql<
            string[]
          >`array(SELECT ((now() AT TIME ZONE ${tz})::date - i)::text FROM generate_series(13, 0, -1) AS i)`,
        })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1);
      dayKeys.push(...(days?.list ?? []));
    }
    const byDay = new Map<string, { mineCents: number; storeCents: number }>(
      dayKeys.map((d) => [d, { mineCents: 0, storeCents: 0 }]),
    );
    const week = dayKeys.slice(-7);
    const weekSet = new Set(week);
    const leaderboard = new Map<string, number>(); // membership/user key -> cents

    const kpiMine = {
      writtenCents: 0,
      writtenCount: 0,
      collectedCents: 0,
      openCount: 0,
      openBalanceCents: 0,
      closed7dCount: 0,
      closed7dCents: 0,
      monthWrittenCents: 0,
      monthlyGoalCents: null as number | null,
      commissionPeriodCents: 0,
    };
    const kpiStore = {
      writtenCents: 0,
      writtenCount: 0,
      collectedCents: 0,
      tenderMix: [] as { method: string; cents: number }[],
    };

    for (const o of orderRows) {
      const bucket = byDay.get(o.day);
      const share = mineShareBps(o);
      const mineCents = Math.round((o.totalCents * share) / 10000);
      if (bucket) {
        bucket.storeCents += o.totalCents;
        bucket.mineCents += mineCents;
      }
      if (o.day === today) {
        kpiStore.writtenCents += o.totalCents;
        kpiStore.writtenCount += 1;
        if (share > 0) {
          kpiMine.writtenCents += mineCents;
          kpiMine.writtenCount += 1;
        }
      }
      if (weekSet.has(o.day)) {
        const split = o.second && o.splitBps != null ? o.splitBps : 10000;
        if (o.primary) {
          leaderboard.set(
            `m:${o.primary}`,
            (leaderboard.get(`m:${o.primary}`) ?? 0) + Math.round((o.totalCents * split) / 10000),
          );
        }
        if (o.second) {
          leaderboard.set(
            `m:${o.second}`,
            (leaderboard.get(`m:${o.second}`) ?? 0) +
              Math.round((o.totalCents * (10000 - split)) / 10000),
          );
        }
      }
    }
    for (const r of saleRows) {
      const bucket = byDay.get(r.day);
      const mine = r.associateUserId === myUserId;
      if (bucket) {
        bucket.storeCents += r.totalCents;
        if (mine) bucket.mineCents += r.totalCents;
      }
      if (r.day === today) {
        kpiStore.writtenCents += r.totalCents;
        kpiStore.writtenCount += 1;
        if (mine) {
          kpiMine.writtenCents += r.totalCents;
          kpiMine.writtenCount += 1;
        }
      }
      if (weekSet.has(r.day) && r.associateUserId) {
        leaderboard.set(
          `u:${r.associateUserId}`,
          (leaderboard.get(`u:${r.associateUserId}`) ?? 0) + r.totalCents,
        );
      }
    }

    // --- Collected today (store-local) ------------------------------------
    const tenderMix = new Map<string, number>();
    const orderPays = await this.db
      .select({
        amountCents: schema.payments.amountCents,
        method: schema.payments.method,
        primary: schema.orders.salespersonMembershipId,
        second: schema.orders.secondSalespersonMembershipId,
      })
      .from(schema.payments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          eq(schema.payments.status, 'succeeded'),
          eq(schema.orders.locationId, loc.id),
          sql`(${schema.payments.createdAt} AT TIME ZONE ${tz})::date::text = ${today}`,
        ),
      );
    for (const pRow of orderPays) {
      kpiStore.collectedCents += pRow.amountCents;
      tenderMix.set(pRow.method, (tenderMix.get(pRow.method) ?? 0) + pRow.amountCents);
      if (pRow.primary === myMembershipId || pRow.second === myMembershipId) {
        kpiMine.collectedCents += pRow.amountCents;
      }
    }
    const salePays = await this.db
      .select({
        amountCents: schema.payments.amountCents,
        method: schema.payments.method,
        associateUserId: schema.sales.associateUserId,
      })
      .from(schema.payments)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          eq(schema.payments.status, 'succeeded'),
          eq(schema.sales.locationId, loc.id),
          sql`(${schema.payments.createdAt} AT TIME ZONE ${tz})::date::text = ${today}`,
        ),
      );
    for (const pRow of salePays) {
      kpiStore.collectedCents += pRow.amountCents;
      tenderMix.set(pRow.method, (tenderMix.get(pRow.method) ?? 0) + pRow.amountCents);
      if (pRow.associateUserId === myUserId) kpiMine.collectedCents += pRow.amountCents;
    }

    // --- Open book at the store (queues, pipeline, past-due) --------------
    const paidExpr = sql<number>`COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.order_id = ${schema.orders.id} AND p.status = 'succeeded'), 0)::int`;
    const queueSelect = {
      id: schema.orders.id,
      number: schema.orders.number,
      status: schema.orders.status,
      deliveryStatus: schema.orders.deliveryStatus,
      requestedDate: schema.orders.requestedDate,
      totalCents: schema.orders.totalCents,
      paidCents: paidExpr,
      primary: schema.orders.salespersonMembershipId,
      second: schema.orders.secondSalespersonMembershipId,
      splitBps: schema.orders.splitBps,
      customerId: schema.customers.id,
      customerFirst: schema.customers.firstName,
      customerLast: schema.customers.lastName,
      customerPhone: schema.customers.phone,
      createdAt: schema.orders.createdAt,
    };
    const openRows = await this.db
      .select(queueSelect)
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          eq(schema.orders.locationId, loc.id),
          inArray(schema.orders.status, ['draft', 'quote', 'open']),
          isNull(schema.orders.importedAt),
        ),
      )
      .orderBy(sql`${schema.orders.requestedDate} ASC NULLS LAST`, schema.orders.createdAt)
      .limit(400);

    const closedRows = await this.db
      .select({ ...queueSelect, closedAt: schema.orders.completedAt })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          eq(schema.orders.locationId, loc.id),
          inArray(schema.orders.status, ['completed', 'fulfilled']),
          isNull(schema.orders.importedAt),
          sql`COALESCE(${schema.orders.completedAt}, ${schema.orders.updatedAt}) >= now() - interval '7 days'`,
        ),
      )
      .orderBy(sql`COALESCE(${schema.orders.completedAt}, ${schema.orders.updatedAt}) DESC`)
      .limit(50);

    const delRows = await this.db
      .select({
        ...queueSelect,
        deliveryId: schema.deliveries.id,
        deliveryState: schema.deliveries.status,
        scheduledDate: schema.deliveries.scheduledDate,
        windowStart: schema.deliveries.windowStart,
        windowEnd: schema.deliveries.windowEnd,
        driverMembershipId: schema.deliveries.driverMembershipId,
      })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.deliveries.businessId, businessId),
          eq(schema.orders.locationId, loc.id),
          inArray(schema.deliveries.scheduledDate, [today, tomorrow]),
          sql`${schema.deliveries.status} != 'cancelled'`,
        ),
      )
      .orderBy(schema.deliveries.scheduledDate, schema.deliveries.routePosition)
      .limit(60);

    // Unreserved stock units per open order — feeds the backorder watch
    // and the per-row "N short" flag.
    const shortMap = new Map<string, number>();
    if (openRows.length > 0) {
      const shorts = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          short: sql<number>`COALESCE(SUM(GREATEST(${schema.orderLines.quantity} - ${schema.orderLines.qtyReserved} - ${schema.orderLines.qtyFulfilled}, 0)), 0)::int`,
        })
        .from(schema.orderLines)
        .where(
          and(
            inArray(
              schema.orderLines.orderId,
              openRows.map((r) => r.id),
            ),
            eq(schema.orderLines.lineType, 'stock'),
            sql`${schema.orderLines.variantId} IS NOT NULL`,
          ),
        )
        .groupBy(schema.orderLines.orderId);
      for (const r of shorts) shortMap.set(r.orderId, r.short);
    }

    // Returns and exchanges still owed a resolution at this store.
    const returnRows = await this.db
      .select({
        id: schema.orderReturns.id,
        rmaNumber: schema.orderReturns.rmaNumber,
        retStatus: schema.orderReturns.status,
        createdAt: schema.orderReturns.authorizedAt,
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        primary: schema.orders.salespersonMembershipId,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
      })
      .from(schema.orderReturns)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderReturns.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orderReturns.customerId))
      .where(
        and(
          eq(schema.orderReturns.businessId, businessId),
          eq(schema.orders.locationId, loc.id),
          sql`${schema.orderReturns.status} NOT IN ('completed', 'cancelled')`,
        ),
      )
      .orderBy(desc(schema.orderReturns.authorizedAt))
      .limit(10);

    // Incoming stock: transfers on the truck plus POs the vendor owes.
    const incomingTransfers = await this.db
      .select({
        id: schema.stockTransfers.id,
        number: schema.stockTransfers.number,
        status: schema.stockTransfers.status,
        expected: schema.stockTransfers.scheduledFor,
      })
      .from(schema.stockTransfers)
      .where(
        and(
          eq(schema.stockTransfers.businessId, businessId),
          eq(schema.stockTransfers.toLocationId, loc.id),
          eq(schema.stockTransfers.status, 'in_transit'),
        ),
      )
      .limit(8);
    const incomingPOs = await this.db
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        status: schema.purchaseOrders.status,
        expected: sql<
          string | null
        >`(${schema.purchaseOrders.expectedAt} AT TIME ZONE ${tz})::date::text`,
      })
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.businessId, businessId),
          eq(schema.purchaseOrders.locationId, loc.id),
          inArray(schema.purchaseOrders.status, ['ordered', 'partially_received']),
        ),
      )
      .orderBy(sql`${schema.purchaseOrders.expectedAt} ASC NULLS LAST`)
      .limit(8);

    // Worst stock positions at this store (stocked variants only).
    const lowStock = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        available: sql<number>`(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved})::int`,
      })
      .from(schema.inventoryLevels)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.inventoryLevels.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.inventoryLevels.businessId, businessId),
          eq(schema.inventoryLevels.locationId, loc.id),
          sql`(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved}) <= 5`,
          sql`(${schema.inventoryLevels.onHand} > 0 OR ${schema.inventoryLevels.reserved} > 0)`,
        ),
      )
      .orderBy(sql`(${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved}) ASC`)
      .limit(5);

    // Order-change activity at this store, grouped by order.
    const actRows = await this.db
      .select({
        action: schema.auditLogs.action,
        createdAt: schema.auditLogs.createdAt,
        actorName: schema.users.name,
        actorEmail: schema.users.email,
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
      })
      .from(schema.auditLogs)
      .innerJoin(schema.orders, sql`${schema.auditLogs.targetId} = ${schema.orders.id}::text`)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          sql`${schema.auditLogs.action} LIKE 'order.%'`,
          eq(schema.orders.locationId, loc.id),
        ),
      )
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(60);

    // Customers holding store credit whose latest order lives here.
    const creditRows = (await this.db.execute(sql`
      SELECT c.id AS customer_id, c.first_name, c.last_name, c.phone,
             s.bal::int AS balance_cents, o.salesperson_membership_id
      FROM (
        SELECT customer_id, SUM(delta_cents) AS bal
        FROM store_credit_entries
        WHERE business_id = ${businessId}
        GROUP BY customer_id
        HAVING SUM(delta_cents) > 0
      ) s
      JOIN customers c ON c.id = s.customer_id
      LEFT JOIN LATERAL (
        SELECT salesperson_membership_id, location_id
        FROM orders
        WHERE customer_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) o ON true
      WHERE o.location_id = ${loc.id}
      ORDER BY s.bal DESC
      LIMIT 10`)) as unknown as {
      customer_id: string;
      first_name: string | null;
      last_name: string | null;
      phone: string | null;
      balance_cents: number;
      salesperson_membership_id: string | null;
    }[];

    // My month so far (ANY store — the goal is per member, not per store)
    // and my commission accrual for the current payroll period.
    const [monthOrders] = await this.db
      .select({
        // total_cents * split_bps must widen to bigint: int32 overflows
        // at $2,147.48 × 10000 — every real mattress order (prod 500,
        // 2026-08-30).
        cents: sql<number>`COALESCE(SUM(CASE
          WHEN ${schema.orders.salespersonMembershipId} = ${myMembershipId}
            THEN ROUND(${schema.orders.totalCents}::bigint * (CASE WHEN ${schema.orders.secondSalespersonMembershipId} IS NOT NULL THEN COALESCE(${schema.orders.splitBps}, 10000) ELSE 10000 END) / 10000.0)
          WHEN ${schema.orders.secondSalespersonMembershipId} = ${myMembershipId}
            THEN ROUND(${schema.orders.totalCents}::bigint * (10000 - COALESCE(${schema.orders.splitBps}, 10000)) / 10000.0)
          ELSE 0 END), 0)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          sql`(${schema.orders.createdAt} AT TIME ZONE ${tz}) >= date_trunc('month', now() AT TIME ZONE ${tz})`,
        ),
      );
    let monthSalesCents = 0;
    if (myUserId) {
      const [monthSales] = await this.db
        .select({ cents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int` })
        .from(schema.sales)
        .where(
          and(
            eq(schema.sales.businessId, businessId),
            eq(schema.sales.status, 'completed'),
            isNull(schema.sales.importedAt),
            eq(schema.sales.associateUserId, myUserId),
            sql`(${schema.sales.createdAt} AT TIME ZONE ${tz}) >= date_trunc('month', now() AT TIME ZONE ${tz})`,
          ),
        );
      monthSalesCents = monthSales?.cents ?? 0;
    }
    const [commission] = await this.db
      .select({
        cents: sql<number>`COALESCE(SUM(${schema.commissionEntries.amountCents}), 0)::int`,
      })
      .from(schema.commissionEntries)
      .where(
        and(
          eq(schema.commissionEntries.businessId, businessId),
          eq(schema.commissionEntries.membershipId, myMembershipId!),
          sql`${schema.commissionEntries.period} = to_char(now() AT TIME ZONE ${tz}, 'YYYY-MM')`,
        ),
      );

    // Drawer status for the store.
    const [lastShift] = await this.db
      .select({
        closedAt: schema.cashShifts.closedAt,
        suspendedAt: schema.cashShifts.suspendedAt,
        closedDay: sql<
          string | null
        >`(${schema.cashShifts.closedAt} AT TIME ZONE ${tz})::date::text`,
      })
      .from(schema.cashShifts)
      .where(
        and(eq(schema.cashShifts.businessId, businessId), eq(schema.cashShifts.locationId, loc.id)),
      )
      .orderBy(desc(schema.cashShifts.openedAt))
      .limit(1);

    // Salesperson names for every membership id we touched, and user
    // names for register associates on the leaderboard.
    const membershipIds = [
      ...new Set(
        [...openRows, ...closedRows, ...delRows]
          .flatMap((r) => [r.primary, r.second])
          .concat([...leaderboard.keys()].filter((k) => k.startsWith('m:')).map((k) => k.slice(2)))
          .concat(delRows.map((r) => r.driverMembershipId))
          .concat(returnRows.map((r) => r.primary))
          .concat(creditRows.map((r) => r.salesperson_membership_id))
          .filter(Boolean) as string[],
      ),
    ];
    const memberName = new Map<string, string>();
    const memberUserId = new Map<string, string>();
    if (membershipIds.length > 0) {
      const rows = await this.db
        .select({
          id: schema.memberships.id,
          userId: schema.memberships.userId,
          name: schema.users.name,
          email: schema.users.email,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(inArray(schema.memberships.id, membershipIds));
      for (const r of rows) {
        memberName.set(r.id, r.name ?? r.email ?? 'associate');
        memberUserId.set(r.id, r.userId);
      }
    }
    const saleUserIds = [
      ...new Set([...leaderboard.keys()].filter((k) => k.startsWith('u:')).map((k) => k.slice(2))),
    ];
    const userName = new Map<string, string>();
    if (saleUserIds.length > 0) {
      const rows = await this.db
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, saleUserIds));
      for (const r of rows) userName.set(r.id, r.name ?? r.email ?? 'associate');
    }

    // A member who writes orders AND rings register sales is one bar,
    // not two: fold register (user-keyed) cents into the membership bar
    // when we know the membership's user.
    const leaderboardByName = new Map<string, number>();
    const userToMembershipName = new Map<string, string>();
    for (const [mid, uid] of memberUserId) {
      userToMembershipName.set(uid, memberName.get(mid) ?? 'associate');
    }
    for (const [key, cents] of leaderboard) {
      const name = key.startsWith('m:')
        ? (memberName.get(key.slice(2)) ?? 'associate')
        : (userToMembershipName.get(key.slice(2)) ?? userName.get(key.slice(2)) ?? 'associate');
      leaderboardByName.set(name, (leaderboardByName.get(name) ?? 0) + cents);
    }

    type RawRow = (typeof openRows)[number];
    const toQueueRow = (r: RawRow): ManagerQueueRow => ({
      id: r.id,
      number: r.number,
      status: r.status,
      deliveryStatus: r.deliveryStatus,
      requestedDate: r.requestedDate,
      totalCents: r.totalCents,
      balanceDueCents: Math.max(0, r.totalCents - r.paidCents),
      customerId: r.customerId,
      customerName: [r.customerFirst, r.customerLast].filter(Boolean).join(' ').trim() || null,
      customerPhone: r.customerPhone,
      salespersonName: r.primary ? (memberName.get(r.primary) ?? null) : null,
      salespersonMembershipId: r.primary,
      secondSalespersonMembershipId: r.second,
      createdAt: r.createdAt,
      shortUnits: shortMap.get(r.id) ?? 0,
    });

    const myOpenAll = openRows.filter(
      (r) => r.primary === myMembershipId || r.second === myMembershipId,
    );
    kpiMine.openCount = myOpenAll.length;
    kpiMine.openBalanceCents = myOpenAll.reduce(
      (sum, r) => sum + Math.max(0, r.totalCents - r.paidCents),
      0,
    );
    for (const r of closedRows) {
      const share = mineShareBps(r);
      if (share > 0) {
        kpiMine.closed7dCount += 1;
        kpiMine.closed7dCents += Math.round((r.totalCents * share) / 10000);
      }
    }

    const pipeline = new Map<string, { count: number; cents: number }>();
    for (const r of openRows) {
      const key =
        r.status === 'draft'
          ? 'draft'
          : r.status === 'quote'
            ? 'quote'
            : r.deliveryStatus
              ? 'scheduled'
              : 'open';
      const b = pipeline.get(key) ?? { count: 0, cents: 0 };
      b.count += 1;
      b.cents += r.totalCents;
      pipeline.set(key, b);
    }
    const pastDuePromises = openRows.filter(
      (r) => r.status !== 'draft' && r.requestedDate != null && r.requestedDate < today,
    ).length;
    const agingCutoff = Date.now() - 14 * 86_400_000;
    const unpaidAging = openRows.filter(
      (r) =>
        r.status === 'open' &&
        r.totalCents - r.paidCents > 0 &&
        r.createdAt.getTime() < agingCutoff,
    ).length;
    const backorders = openRows
      .filter((r) => r.status === 'open' && (shortMap.get(r.id) ?? 0) > 0)
      .slice(0, 10);
    const staleCarts = [...openRows]
      .filter((r) => r.status === 'draft' || r.status === 'quote')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, 10);

    // Group the audit trail one row per order, newest order first.
    const activityByOrder = new Map<string, ManagerDashboard['activity'][number]>();
    for (const a of actRows) {
      const g = activityByOrder.get(a.orderId) ?? {
        orderId: a.orderId,
        orderNumber: a.orderNumber,
        latestAt: a.createdAt,
        events: [],
      };
      if (g.events.length < 6) {
        g.events.push({
          action: a.action,
          actorName: a.actorName ?? a.actorEmail ?? null,
          createdAt: a.createdAt,
        });
      }
      activityByOrder.set(a.orderId, g);
    }

    kpiMine.monthWrittenCents = (monthOrders?.cents ?? 0) + monthSalesCents;
    kpiMine.monthlyGoalCents = me?.monthlyGoalCents ?? null;
    kpiMine.commissionPeriodCents = commission?.cents ?? 0;
    kpiStore.tenderMix = [...tenderMix.entries()]
      .map(([method, cents]) => ({ method, cents }))
      .sort((a, b) => b.cents - a.cents);

    const [openExceptions] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.exceptionEvents)
      .where(
        and(
          eq(schema.exceptionEvents.businessId, businessId),
          isNull(schema.exceptionEvents.acknowledgedAt),
        ),
      );

    // ---- Phase 9 headline baselines, needs-a-call, last night's close ----
    const [baseRow] = await this.db
      .select({
        lastWeek: sql<string>`((now() AT TIME ZONE ${tz})::date - 7)::text`,
        lastMonth: sql<string>`LEAST((now() AT TIME ZONE ${tz})::date - interval '1 month', (date_trunc('month', (now() AT TIME ZONE ${tz})::date) - interval '1 day'))::date::text`,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const lastWeekDay = baseRow!.lastWeek;
    const lastMonthDay = baseRow!.lastMonth;
    const writtenOn = async (day: string): Promise<number> => {
      const [o] = await this.db
        .select({ cents: sql<number>`COALESCE(SUM(${schema.orders.totalCents}), 0)::int` })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            eq(schema.orders.locationId, loc.id),
            sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
            isNull(schema.orders.importedAt),
            sql`(${schema.orders.createdAt} AT TIME ZONE ${tz})::date::text = ${day}`,
          ),
        );
      const [r] = await this.db
        .select({ cents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int` })
        .from(schema.sales)
        .where(
          and(
            eq(schema.sales.businessId, businessId),
            eq(schema.sales.locationId, loc.id),
            eq(schema.sales.status, 'completed'),
            isNull(schema.sales.importedAt),
            sql`(${schema.sales.createdAt} AT TIME ZONE ${tz})::date::text = ${day}`,
          ),
        );
      return (o?.cents ?? 0) + (r?.cents ?? 0);
    };
    const [lastWeekCents, lastMonthCents] = await Promise.all([
      writtenOn(lastWeekDay),
      writtenOn(lastMonthDay),
    ]);
    const repCounts = new Map<string, number>();
    for (const o of orderRows) {
      if (o.day !== today || !o.primary) continue;
      repCounts.set(o.primary, (repCounts.get(o.primary) ?? 0) + 1);
    }
    const topRepEntry = [...repCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    let topRepName: string | null = null;
    if (topRepEntry) {
      topRepName = memberName.get(topRepEntry[0]) ?? null;
      if (!topRepName) {
        const [m] = await this.db
          .select({ name: schema.users.name, email: schema.users.email })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(eq(schema.memberships.id, topRepEntry[0]))
          .limit(1);
        topRepName = m?.name ?? m?.email ?? null;
      }
    }
    const shortOpen = openRows.filter((r) => r.status === 'open' && (shortMap.get(r.id) ?? 0) > 0);
    const lateOpen = openRows.filter(
      (r) => r.status !== 'draft' && r.requestedDate != null && r.requestedDate < today,
    );
    const needsCallIds = new Set([...shortOpen, ...lateOpen].map((r) => r.id));
    const [closedShift] = await this.db
      .select({
        closedAt: schema.cashShifts.closedAt,
        varianceCents: schema.cashShifts.varianceCents,
        suspendedAt: schema.cashShifts.suspendedAt,
        byName: schema.users.name,
        byEmail: schema.users.email,
        closeDay: sql<
          string | null
        >`(${schema.cashShifts.closedAt} AT TIME ZONE ${tz})::date::text`,
      })
      .from(schema.cashShifts)
      .leftJoin(schema.users, eq(schema.users.id, schema.cashShifts.closedByUserId))
      .where(
        and(
          eq(schema.cashShifts.businessId, businessId),
          eq(schema.cashShifts.locationId, loc.id),
          sql`${schema.cashShifts.closedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(schema.cashShifts.closedAt))
      .limit(1);
    const lastClose: ManagerDashboard['lastClose'] = lastShift?.suspendedAt
      ? {
          status: 'suspended',
          varianceCents: lastShift.closedAt ? (closedShift?.varianceCents ?? null) : null,
          closedAt: closedShift?.closedAt ?? null,
          byName: closedShift?.byName ?? closedShift?.byEmail ?? null,
          closeDay: closedShift?.closeDay ?? null,
        }
      : !closedShift
        ? { status: 'none', varianceCents: null, closedAt: null, byName: null, closeDay: null }
        : {
            status:
              (closedShift.varianceCents ?? 0) === 0
                ? 'clean'
                : (closedShift.varianceCents ?? 0) < 0
                  ? 'short'
                  : 'over',
            varianceCents: closedShift.varianceCents ?? 0,
            closedAt: closedShift.closedAt,
            byName: closedShift.byName ?? closedShift.byEmail ?? null,
            closeDay: closedShift.closeDay,
          };

    return {
      headline: {
        writtenCents: kpiStore.writtenCents,
        ticketCount: kpiStore.writtenCount,
        avgTicketCents:
          kpiStore.writtenCount > 0 ? Math.round(kpiStore.writtenCents / kpiStore.writtenCount) : 0,
        lastWeek: { date: lastWeekDay, writtenCents: lastWeekCents },
        lastMonth: { date: lastMonthDay, writtenCents: lastMonthCents },
        topRep: topRepEntry && topRepName ? { name: topRepName, count: topRepEntry[1] } : null,
      },
      needsCall: {
        total: needsCallIds.size,
        atRisk: lateOpen.length,
        waitingOnStock: shortOpen.length,
      },
      lastClose,
      date: today,
      location: { id: loc.id, name: loc.name, timezone: tz },
      locations: pickable.map((l) => ({ id: l.id, name: l.name })),
      membershipId: myMembershipId!,
      kpis: {
        mine: kpiMine,
        store: kpiStore,
        exceptionsOpen: openExceptions?.count ?? 0,
        pastDuePromises,
        unpaidAging,
      },
      drawer: {
        shiftOpen: !!lastShift && !lastShift.closedAt,
        closedToday: !!lastShift && lastShift.closedDay === today,
        suspended: !!lastShift?.suspendedAt,
      },
      salesByDay: dayKeys.map((d) => ({ day: d, ...byDay.get(d)! })),
      leaderboardWeek: [...leaderboardByName.entries()]
        .map(([name, cents]) => ({ name, cents }))
        .sort((a, b) => b.cents - a.cents)
        .slice(0, 10),
      pipeline: ['draft', 'quote', 'open', 'scheduled']
        .filter((k) => pipeline.has(k))
        .map((k) => ({ key: k, ...pipeline.get(k)! })),
      queues: {
        myOpen: myOpenAll.slice(0, 15).map(toQueueRow),
        storeOpen: openRows.slice(0, 20).map(toQueueRow),
        recentlyClosed: closedRows.slice(0, 10).map(toQueueRow),
        todaysDeliveries: delRows.map((r) => ({
          ...toQueueRow(r),
          deliveryId: r.deliveryId,
          deliveryState: r.deliveryState,
          scheduledDate: r.scheduledDate,
          driverName: r.driverMembershipId ? (memberName.get(r.driverMembershipId) ?? null) : null,
          windowStart: r.windowStart,
          windowEnd: r.windowEnd,
        })),
        backorders: backorders.map(toQueueRow),
        staleCarts: staleCarts.map(toQueueRow),
      },
      returnsInFlight: returnRows.map((r) => ({
        id: r.id,
        rmaNumber: r.rmaNumber,
        status: r.retStatus,
        createdAt: r.createdAt,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        customerName: [r.customerFirst, r.customerLast].filter(Boolean).join(' ').trim() || null,
        salespersonMembershipId: r.primary,
        salespersonName: r.primary ? (memberName.get(r.primary) ?? null) : null,
      })),
      incoming: [
        ...incomingTransfers.map((t) => ({
          kind: 'transfer' as const,
          id: t.id,
          number: t.number,
          status: t.status,
          expected: t.expected,
        })),
        ...incomingPOs.map((po) => ({
          kind: 'po' as const,
          id: po.id,
          number: po.number,
          status: po.status,
          expected: po.expected,
        })),
      ]
        .sort((a, b) => (a.expected ?? '9999').localeCompare(b.expected ?? '9999'))
        .slice(0, 10),
      lowStock,
      creditHolders: creditRows.map((r) => ({
        customerId: r.customer_id,
        customerName: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null,
        phone: r.phone,
        balanceCents: r.balance_cents,
        salespersonMembershipId: r.salesperson_membership_id,
        salespersonName: r.salesperson_membership_id
          ? (memberName.get(r.salesperson_membership_id) ?? null)
          : null,
      })),
      activity: [...activityByOrder.values()]
        .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime())
        .slice(0, 12),
    };
  }
}
