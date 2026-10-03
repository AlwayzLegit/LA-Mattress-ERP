import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { businessTimeZone } from '../common/business-today';
import { parseDayRange, tzDayEndExclusive, tzDayStart, zonedBounds } from '../common/date-range';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { digestByActor, discountPercent, type ActorDigestRow } from './ops-feed';
import { OpsFeedService } from './ops-feed.service';

/**
 * One document written today at a store (owner 2026-09-02): the order or
 * register sale behind the store's Written number, with its cost and
 * profit. Cost is the standard cost of the lines (variant cost × qty);
 * profit is merchandise (subtotal − discounts) − cost — tax, delivery and
 * fees are not profit.
 */
interface StoreDocument {
  id: string;
  kind: 'order' | 'sale';
  number: string;
  customerName: string | null;
  writtenCents: number;
  merchandiseCents: number;
  costCents: number;
  profitCents: number;
}

interface StoreRow {
  locationId: string;
  locationName: string;
  timezone: string;
  writtenCents: number;
  writtenCount: number;
  collectedCents: number;
  refundedCents: number;
  costCents: number;
  profitCents: number;
  documents: StoreDocument[];
}

interface SalespersonRow {
  /** `m:<membershipId>` for order writers, `u:<userId>` for register sales. */
  key: string;
  name: string;
  writtenCents: number;
  writtenCount: number;
  collectedCents: number;
  refundedCents: number;
  discountCents: number;
  discountPct: number;
}

interface MoneyBlock {
  inCents: number;
  outCents: number;
  netCents: number;
  byTender: { method: string; cents: number; count: number }[];
  out: { refundsCents: number; returnsCents: number; writeOffsCents: number };
  exchanges: { count: number; restockingFeeCents: number };
}

interface RitualRow {
  locationId: string;
  locationName: string;
  /** Store-local date the row describes. */
  date: string;
  drawerOpen: boolean;
  drawerClosed: boolean;
  drawerSuspended: boolean;
  varianceCents: number | null;
  closeoutRan: boolean;
  closeoutExceptions: number;
}

interface OperationsSummary {
  /** Store-local calendar date the "today" numbers cover. */
  date: string;
  /** The window `money` and `byStore` cover (defaults to today → today). */
  range: { start: string; end: string };
  stores: { id: string; name: string; timezone: string }[];
  money: MoneyBlock;
  salesByDay: { day: string; writtenCents: number }[];
  byStore: StoreRow[];
  ritual: RitualRow[];
}

interface ActivityGroup {
  orderId: string;
  orderNumber: string;
  latestAt: Date;
  events: { action: string; actorName: string | null; createdAt: Date }[];
}

/**
 * The Operations home (owner 2026-08-31): every store's selling, every
 * dollar in and out, and every hand-made change to money or stock —
 * read, then signed off.
 *
 * Deliberately several endpoints rather than one: the summary is cheap
 * and always rendered, while the feed, the per-salesperson table and
 * the digest each cost real query time and are fetched independently so
 * a slow card never holds up the page. Each is permission-gated on its
 * own, so a 403 hides one card instead of the whole dashboard.
 *
 * Day boundaries follow the store's own timezone, matching the manager
 * dashboard; imported legacy documents are excluded throughout (D8).
 */
@TenantScoped()
@Controller('v1/dashboard/operations')
export class OpsDashboardController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(OpsFeedService) private readonly feed: OpsFeedService,
  ) {}

  @Get()
  @RequirePermission('ops.dashboard.view')
  async summary(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
  ): Promise<OperationsSummary> {
    const businessId = tenant.businessId!;
    const stores = await this.stores(tenant, businessId);
    if (stores.length === 0) {
      throw new BadRequestException('No stores are available to this member');
    }
    // The roll-up needs one clock. The first non-warehouse store's
    // timezone is the business's working day, same as the manager view.
    const tz = stores[0]!.timezone;
    const [dayRow] = await this.db
      .select({ today: sql<string>`(now() AT TIME ZONE ${tz})::date::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const today = dayRow!.today;
    // Owner 2026-09-02: the Selling and Money blocks follow the picker's
    // window (store-local days); the ritual and the 14-day chart stay on
    // today. No window → today, as before.
    const range = parseDayRange(startQ, endQ) ?? { start: today, end: today };
    const dayStart = tzDayStart(range.start, tz);
    const dayEnd = tzDayEndExclusive(range.end, tz);

    // Deliberately NOT the feed: one page load already builds it twice
    // (/feed and /digest), and the client derives its counts from the
    // /feed response it fetches anyway. The summary stays the cheap
    // call its header comment promises.
    const [money, salesByDay, byStore, ritual] = await Promise.all([
      this.money(tenant, businessId, dayStart, dayEnd),
      this.salesByDay(tenant, businessId, tz),
      this.byStore(tenant, businessId, stores, dayStart, dayEnd),
      this.ritual(tenant, businessId, stores),
    ]);

    return {
      date: today,
      range,
      stores: stores.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone })),
      money,
      salesByDay,
      byStore,
      ritual,
    };
  }

  /** The prioritized action feed. */
  @Get('feed')
  @RequirePermission('ops.dashboard.view')
  async feedRows(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('days') daysStr?: string,
    @Query('limit') limitStr?: string,
  ) {
    const days = Number(daysStr) > 0 ? Number(daysStr) : undefined;
    const cap = Number(limitStr) > 0 ? Number(limitStr) : undefined;
    const result = await this.feed.build(tenant, { days, cap });
    return {
      rows: result.rows,
      total: result.totalBeforeCap,
      thresholds: result.thresholds,
    };
  }

  /** Grouped by who did it — the pattern a chronological list hides. */
  @Get('digest')
  @RequirePermission('ops.dashboard.view')
  async digest(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('days') daysStr?: string,
  ): Promise<ActorDigestRow[]> {
    const days = Number(daysStr) > 0 ? Number(daysStr) : undefined;
    const result = await this.feed.build(tenant, { days, cap: 500 });
    return digestByActor(result.rows);
  }

  /** Every salesperson at every store, over the trailing window. */
  @Get('salespeople')
  @RequirePermission('ops.dashboard.view')
  async salespeople(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('days') daysStr?: string,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
  ): Promise<SalespersonRow[]> {
    const businessId = tenant.businessId!;
    // `start`/`end` (picker window) win over the legacy trailing `days`.
    const window = parseDayRange(startQ, endQ);
    const days = Math.min(90, Math.max(1, Number(daysStr) || 30));
    const bounds = window ? zonedBounds(window, await businessTimeZone(this.db, businessId)) : null;
    const since = bounds ? bounds.from : new Date(Date.now() - days * 86_400_000);
    const until = bounds ? bounds.toExclusive : null;

    const memberUser = alias(schema.users, 'member_user');
    const orderRows = await this.db
      .select({
        totalCents: schema.orders.totalCents,
        discountCents: schema.orders.discountCents,
        subtotalCents: schema.orders.subtotalCents,
        primary: schema.orders.salespersonMembershipId,
        second: schema.orders.secondSalespersonMembershipId,
        splitBps: schema.orders.splitBps,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          gte(schema.orders.createdAt, since),
          until ? lt(schema.orders.createdAt, until) : undefined,
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    const saleRows = await this.db
      .select({
        totalCents: schema.sales.totalCents,
        discountCents: schema.sales.discountCents,
        subtotalCents: schema.sales.subtotalCents,
        associateUserId: schema.sales.associateUserId,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          gte(schema.sales.createdAt, since),
          until ? lt(schema.sales.createdAt, until) : undefined,
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );

    const names = new Map<string, string>();
    const members = await this.db
      .select({
        id: schema.memberships.id,
        userId: schema.memberships.userId,
        name: memberUser.name,
        email: memberUser.email,
      })
      .from(schema.memberships)
      .innerJoin(memberUser, eq(memberUser.id, schema.memberships.userId))
      .where(eq(schema.memberships.businessId, businessId));
    for (const m of members) {
      names.set(`m:${m.id}`, m.name ?? m.email);
      names.set(`u:${m.userId}`, m.name ?? m.email);
    }

    const acc = new Map<string, SalespersonRow>();
    const bump = (key: string, patch: Partial<SalespersonRow>) => {
      const row = acc.get(key) ?? {
        key,
        name: names.get(key) ?? 'Unassigned',
        writtenCents: 0,
        writtenCount: 0,
        collectedCents: 0,
        refundedCents: 0,
        discountCents: 0,
        discountPct: 0,
      };
      row.writtenCents += patch.writtenCents ?? 0;
      row.writtenCount += patch.writtenCount ?? 0;
      row.discountCents += patch.discountCents ?? 0;
      acc.set(key, row);
    };
    // Subtotals feed the discount percentage and are never returned, so
    // they ride alongside the rows rather than inside them.
    const subtotals = new Map<string, number>();
    const addSubtotal = (key: string, cents: number) =>
      subtotals.set(key, (subtotals.get(key) ?? 0) + cents);

    for (const o of orderRows) {
      const split = o.second && o.splitBps != null ? o.splitBps : 10000;
      if (o.primary) {
        const key = `m:${o.primary}`;
        const share = split / 10000;
        bump(key, {
          writtenCents: Math.round(o.totalCents * share),
          writtenCount: 1,
          discountCents: Math.round(o.discountCents * share),
        });
        addSubtotal(key, Math.round(o.subtotalCents * share));
      }
      if (o.second) {
        const key = `m:${o.second}`;
        const share = (10000 - split) / 10000;
        bump(key, {
          writtenCents: Math.round(o.totalCents * share),
          writtenCount: 1,
          discountCents: Math.round(o.discountCents * share),
        });
        addSubtotal(key, Math.round(o.subtotalCents * share));
      }
    }
    for (const s of saleRows) {
      if (!s.associateUserId) continue;
      const key = `u:${s.associateUserId}`;
      bump(key, {
        writtenCents: s.totalCents,
        writtenCount: 1,
        discountCents: s.discountCents,
      });
      addSubtotal(key, s.subtotalCents);
    }

    // Refunds land on whoever rang the original sale.
    const refundRows = await this.db
      .select({
        amountCents: schema.refunds.amountCents,
        associateUserId: schema.sales.associateUserId,
      })
      .from(schema.refunds)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
      .where(
        and(
          eq(schema.refunds.businessId, businessId),
          gte(schema.refunds.createdAt, since),
          until ? lt(schema.refunds.createdAt, until) : undefined,
          isNull(schema.sales.importedAt),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );
    // A refund-only associate — nothing written this window, a $900
    // refund processed on an old sale — is exactly the outlier this
    // table exists to expose, so the refund creates the row.
    for (const r of refundRows) {
      if (!r.associateUserId) continue;
      const key = `u:${r.associateUserId}`;
      bump(key, {});
      acc.get(key)!.refundedCents += r.amountCents;
    }

    // Money actually collected, attributed the same way the document
    // is: an order's payments to its writer, a register sale's to whoever
    // rang it. Split orders credit the primary writer — the second
    // salesperson's share of *written* business is already counted above,
    // and splitting a tender again would double-count the cash.
    const orderCollected = await this.db
      .select({
        membershipId: schema.orders.salespersonMembershipId,
        cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
      })
      .from(schema.payments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          gte(schema.payments.createdAt, since),
          until ? lt(schema.payments.createdAt, until) : undefined,
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.orders.importedAt),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .groupBy(schema.orders.salespersonMembershipId);
    for (const c of orderCollected) {
      if (!c.membershipId) continue;
      const key = `m:${c.membershipId}`;
      bump(key, {});
      acc.get(key)!.collectedCents += c.cents;
    }
    const saleCollected = await this.db
      .select({
        associateUserId: schema.sales.associateUserId,
        cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
      })
      .from(schema.payments)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          gte(schema.payments.createdAt, since),
          until ? lt(schema.payments.createdAt, until) : undefined,
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.sales.importedAt),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(schema.sales.associateUserId);
    for (const c of saleCollected) {
      if (!c.associateUserId) continue;
      const key = `u:${c.associateUserId}`;
      bump(key, {});
      acc.get(key)!.collectedCents += c.cents;
    }

    for (const [key, row] of acc) {
      row.discountPct =
        Math.round(discountPercent(row.discountCents, subtotals.get(key) ?? 0) * 10) / 10;
    }
    return [...acc.values()].sort((a, b) => b.writtenCents - a.writtenCents);
  }

  /** Recent order changes, grouped by order — kept from the manager view. */
  @Get('activity')
  @RequirePermission('ops.dashboard.view')
  async activity(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('limit') limitStr?: string,
  ): Promise<ActivityGroup[]> {
    const businessId = tenant.businessId!;
    const limit = Math.min(200, Math.max(1, Number(limitStr) || 60));
    const rows = await this.db
      .select({
        action: schema.auditLogs.action,
        targetId: schema.auditLogs.targetId,
        createdAt: schema.auditLogs.createdAt,
        actorName: schema.users.name,
        actorEmail: schema.users.email,
        orderNumber: schema.orders.number,
      })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .leftJoin(schema.orders, sql`${schema.orders.id}::text = ${schema.auditLogs.targetId}`)
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          eq(schema.auditLogs.targetType, 'order'),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(limit);

    const groups = new Map<string, ActivityGroup>();
    for (const r of rows) {
      if (!r.targetId || !r.orderNumber) continue;
      const group = groups.get(r.targetId) ?? {
        orderId: r.targetId,
        orderNumber: r.orderNumber,
        latestAt: r.createdAt,
        events: [],
      };
      group.events.push({
        action: r.action,
        actorName: r.actorName ?? r.actorEmail,
        createdAt: r.createdAt,
      });
      if (r.createdAt > group.latestAt) group.latestAt = r.createdAt;
      groups.set(r.targetId, group);
    }
    return [...groups.values()].sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());
  }

  // ------------------------------------------------------------- internals

  private async stores(tenant: RequestTenantContext, businessId: string) {
    const rows = await this.db
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
          tenant.dataScope === 'store'
            ? inArray(schema.locations.id, tenant.scopeLocationIds ?? [])
            : undefined,
        ),
      )
      .orderBy(schema.locations.name);
    // Selling stores lead; a warehouse never sets the business clock.
    return [
      ...rows.filter((r) => r.locationType !== 'warehouse'),
      ...rows.filter((r) => r.locationType === 'warehouse'),
    ];
  }

  /**
   * Today's money, all stores. "In" is every succeeded payment by
   * tender; "out" is refunds, authorized returns and write-offs, which
   * are three different tables and never net into the payment ledger.
   */
  private async money(
    tenant: RequestTenantContext,
    businessId: string,
    dayStart: ReturnType<typeof sql>,
    dayEnd: ReturnType<typeof sql>,
  ): Promise<MoneyBlock> {
    const locationExpr = sql`COALESCE(${schema.payments.locationId}, ${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`;
    const byTender = await this.db
      .select({
        method: schema.payments.method,
        cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.payments)
      .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .leftJoin(schema.serviceOrders, eq(schema.serviceOrders.id, schema.payments.serviceOrderId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          gte(schema.payments.createdAt, dayStart),
          lt(schema.payments.createdAt, dayEnd),
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.sales.importedAt),
          isNull(schema.orders.importedAt),
          isNull(schema.serviceOrders.importedAt),
          salesScopeCond(tenant, locationExpr),
        ),
      )
      .groupBy(schema.payments.method)
      .orderBy(desc(sql`COALESCE(SUM(${schema.payments.amountCents}), 0)`));

    const [refundTotal] = await this.db
      .select({ cents: sql<number>`COALESCE(SUM(${schema.refunds.amountCents}), 0)::int` })
      .from(schema.refunds)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
      .where(
        and(
          eq(schema.refunds.businessId, businessId),
          gte(schema.refunds.createdAt, dayStart),
          lt(schema.refunds.createdAt, dayEnd),
          isNull(schema.sales.importedAt),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );

    // The out-flows carry the same store scoping as the in-flow, or a
    // store-scoped member's net would subtract every store's returns
    // from only their own store's takings.
    const [returnTotal] = await this.db
      .select({ cents: sql<number>`COALESCE(SUM(${schema.orderReturns.amountCents}), 0)::int` })
      .from(schema.orderReturns)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.orderReturns.orderId))
      .where(
        and(
          eq(schema.orderReturns.businessId, businessId),
          gte(schema.orderReturns.authorizedAt, dayStart),
          lt(schema.orderReturns.authorizedAt, dayEnd),
          sql`${schema.orderReturns.status} <> 'cancelled'`,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );

    const [writeOffTotal] = await this.db
      .select({ cents: sql<number>`COALESCE(SUM(${schema.writeOffs.totalCostCents}), 0)::int` })
      .from(schema.writeOffs)
      .where(
        and(
          eq(schema.writeOffs.businessId, businessId),
          gte(schema.writeOffs.createdAt, dayStart),
          lt(schema.writeOffs.createdAt, dayEnd),
          salesScopeCond(tenant, schema.writeOffs.locationId),
        ),
      );

    const [exchangeTotal] = await this.db
      .select({
        count: sql<number>`COUNT(*)::int`,
        fee: sql<number>`COALESCE(SUM(${schema.exchanges.restockingFeeCents}), 0)::int`,
      })
      .from(schema.exchanges)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.exchanges.saleOrderId))
      .where(
        and(
          eq(schema.exchanges.businessId, businessId),
          gte(schema.exchanges.createdAt, dayStart),
          lt(schema.exchanges.createdAt, dayEnd),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );

    const inCents = byTender.reduce((sum, t) => sum + t.cents, 0);
    const refundsCents = refundTotal?.cents ?? 0;
    const returnsCents = returnTotal?.cents ?? 0;
    const writeOffsCents = writeOffTotal?.cents ?? 0;
    const outCents = refundsCents + returnsCents + writeOffsCents;
    return {
      inCents,
      outCents,
      netCents: inCents - outCents,
      byTender,
      out: { refundsCents, returnsCents, writeOffsCents },
      exchanges: { count: exchangeTotal?.count ?? 0, restockingFeeCents: exchangeTotal?.fee ?? 0 },
    };
  }

  /** Written business per store-local day, 14 days, zero-filled. */
  private async salesByDay(
    tenant: RequestTenantContext,
    businessId: string,
    tz: string,
  ): Promise<{ day: string; writtenCents: number }[]> {
    const localDay = (col: unknown) => sql<string>`(${col} AT TIME ZONE ${tz})::date::text`;
    const window = sql`(now() AT TIME ZONE ${tz})::date - 13`;

    const orderRows = await this.db
      .select({ day: localDay(schema.orders.createdAt), cents: schema.orders.totalCents })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          sql`(${schema.orders.createdAt} AT TIME ZONE ${tz})::date >= ${window}`,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    const saleRows = await this.db
      .select({ day: localDay(schema.sales.createdAt), cents: schema.sales.totalCents })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          sql`(${schema.sales.createdAt} AT TIME ZONE ${tz})::date >= ${window}`,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );

    const [days] = await this.db
      .select({
        list: sql<
          string[]
        >`array(SELECT ((now() AT TIME ZONE ${tz})::date - i)::text FROM generate_series(13, 0, -1) AS i)`,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const buckets = new Map<string, number>((days?.list ?? []).map((d) => [d, 0]));
    for (const r of [...orderRows, ...saleRows]) {
      if (buckets.has(r.day)) buckets.set(r.day, buckets.get(r.day)! + r.cents);
    }
    return [...buckets].map(([day, writtenCents]) => ({ day, writtenCents }));
  }

  private async byStore(
    tenant: RequestTenantContext,
    businessId: string,
    stores: { id: string; name: string; timezone: string }[],
    dayStart: ReturnType<typeof sql>,
    dayEnd: ReturnType<typeof sql>,
  ): Promise<StoreRow[]> {
    const rows = new Map<string, StoreRow>(
      stores.map((s) => [
        s.id,
        {
          locationId: s.id,
          locationName: s.name,
          timezone: s.timezone,
          writtenCents: 0,
          writtenCount: 0,
          collectedCents: 0,
          refundedCents: 0,
          costCents: 0,
          profitCents: 0,
          documents: [],
        },
      ]),
    );

    const written = await this.db
      .select({
        locationId: schema.orders.locationId,
        cents: sql<number>`COALESCE(SUM(${schema.orders.totalCents}), 0)::int`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          gte(schema.orders.createdAt, dayStart),
          lt(schema.orders.createdAt, dayEnd),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .groupBy(schema.orders.locationId);
    for (const w of written) {
      const row = rows.get(w.locationId);
      if (row) {
        row.writtenCents += w.cents;
        row.writtenCount += w.count;
      }
    }

    const rung = await this.db
      .select({
        locationId: schema.sales.locationId,
        cents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          gte(schema.sales.createdAt, dayStart),
          lt(schema.sales.createdAt, dayEnd),
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .groupBy(schema.sales.locationId);
    for (const s of rung) {
      const row = rows.get(s.locationId);
      if (row) {
        row.writtenCents += s.cents;
        row.writtenCount += s.count;
      }
    }

    const collected = await this.db
      .select({
        locationId: sql<string>`COALESCE(${schema.payments.locationId}, ${schema.sales.locationId}, ${schema.orders.locationId})`,
        cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
      })
      .from(schema.payments)
      .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          gte(schema.payments.createdAt, dayStart),
          lt(schema.payments.createdAt, dayEnd),
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.sales.importedAt),
          isNull(schema.orders.importedAt),
        ),
      )
      .groupBy(
        sql`COALESCE(${schema.payments.locationId}, ${schema.sales.locationId}, ${schema.orders.locationId})`,
      );
    for (const c of collected) {
      const row = rows.get(c.locationId);
      if (row) row.collectedCents += c.cents;
    }

    const refunded = await this.db
      .select({
        locationId: schema.sales.locationId,
        cents: sql<number>`COALESCE(SUM(${schema.refunds.amountCents}), 0)::int`,
      })
      .from(schema.refunds)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
      .where(
        and(
          eq(schema.refunds.businessId, businessId),
          gte(schema.refunds.createdAt, dayStart),
          lt(schema.refunds.createdAt, dayEnd),
          isNull(schema.sales.importedAt),
        ),
      )
      .groupBy(schema.sales.locationId);
    for (const r of refunded) {
      const row = rows.get(r.locationId);
      if (row) row.refundedCents += r.cents;
    }

    // Per-document breakdown under each store: written, cost, profit.
    const orderDocs = await this.db
      .select({
        id: schema.orders.id,
        locationId: schema.orders.locationId,
        number: schema.orders.number,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        totalCents: schema.orders.totalCents,
        subtotalCents: schema.orders.subtotalCents,
        discountCents: schema.orders.discountCents,
        createdAt: schema.orders.createdAt,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          gte(schema.orders.createdAt, dayStart),
          lt(schema.orders.createdAt, dayEnd),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .orderBy(desc(schema.orders.createdAt));
    const orderCost = new Map<string, number>();
    if (orderDocs.length > 0) {
      const costs = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          cents: sql<number>`COALESCE(SUM(${schema.orderLines.quantity} * COALESCE(${schema.productVariants.costCents}, 0)), 0)::int`,
        })
        .from(schema.orderLines)
        .leftJoin(
          schema.productVariants,
          eq(schema.productVariants.id, schema.orderLines.variantId),
        )
        .where(
          inArray(
            schema.orderLines.orderId,
            orderDocs.map((o) => o.id),
          ),
        )
        .groupBy(schema.orderLines.orderId);
      for (const c of costs) orderCost.set(c.orderId, c.cents);
    }
    const saleDocs = await this.db
      .select({
        id: schema.sales.id,
        locationId: schema.sales.locationId,
        number: schema.sales.number,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        totalCents: schema.sales.totalCents,
        subtotalCents: schema.sales.subtotalCents,
        discountCents: schema.sales.discountCents,
        createdAt: schema.sales.createdAt,
      })
      .from(schema.sales)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.sales.customerId))
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          gte(schema.sales.createdAt, dayStart),
          lt(schema.sales.createdAt, dayEnd),
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      )
      .orderBy(desc(schema.sales.createdAt));
    const saleCost = new Map<string, number>();
    if (saleDocs.length > 0) {
      const costs = await this.db
        .select({
          saleId: schema.saleLines.saleId,
          cents: sql<number>`COALESCE(SUM(${schema.saleLines.quantity} * COALESCE(${schema.productVariants.costCents}, 0)), 0)::int`,
        })
        .from(schema.saleLines)
        .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.saleLines.variantId))
        .where(
          inArray(
            schema.saleLines.saleId,
            saleDocs.map((o) => o.id),
          ),
        )
        .groupBy(schema.saleLines.saleId);
      for (const c of costs) saleCost.set(c.saleId, c.cents);
    }
    const push = (
      kind: 'order' | 'sale',
      d: (typeof orderDocs)[number],
      costCents: number,
    ): void => {
      const row = rows.get(d.locationId);
      if (!row) return;
      const merchandiseCents = d.subtotalCents - d.discountCents;
      const doc: StoreDocument = {
        id: d.id,
        kind,
        number: d.number,
        customerName: [d.firstName, d.lastName].filter(Boolean).join(' ') || null,
        writtenCents: d.totalCents,
        merchandiseCents,
        costCents,
        profitCents: merchandiseCents - costCents,
      };
      row.documents.push(doc);
      row.costCents += costCents;
      row.profitCents += doc.profitCents;
    };
    for (const d of orderDocs) push('order', d, orderCost.get(d.id) ?? 0);
    for (const d of saleDocs) push('sale', d, saleCost.get(d.id) ?? 0);
    for (const row of rows.values()) {
      row.documents.sort((a, b) => b.writtenCents - a.writtenCents);
    }

    return [...rows.values()];
  }

  /**
   * Open/close ritual, one row per store in that store's own local day.
   * The morning glance: which drawers are open, which never closed, and
   * whether last night's close-out actually ran.
   *
   * Three fixed queries however many stores there are (the first pass
   * ran 3×N): store-local dates come from Intl — the same IANA zone
   * names Postgres uses — and the shift/closeout reads batch on the
   * location list, bucketing per store in JS.
   */
  private async ritual(
    tenant: RequestTenantContext,
    businessId: string,
    stores: { id: string; name: string; timezone: string }[],
  ): Promise<RitualRow[]> {
    const localDate = (at: Date, timeZone: string): string => {
      try {
        // en-CA formats as YYYY-MM-DD.
        return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
      } catch {
        return at.toISOString().slice(0, 10);
      }
    };
    const now = new Date();
    const dateBy = new Map(stores.map((s) => [s.id, localDate(now, s.timezone)]));
    const tzBy = new Map(stores.map((s) => [s.id, s.timezone]));
    const storeIds = stores.map((s) => s.id);

    // Any store-local "today" began at most 38h ago (UTC+14 through
    // UTC-12); one bounded fetch, then the per-store date filter in JS.
    const shifts = await this.db
      .select({
        locationId: schema.cashShifts.locationId,
        openedAt: schema.cashShifts.openedAt,
        closedAt: schema.cashShifts.closedAt,
        suspendedAt: schema.cashShifts.suspendedAt,
        varianceCents: schema.cashShifts.varianceCents,
      })
      .from(schema.cashShifts)
      .where(
        and(
          eq(schema.cashShifts.businessId, businessId),
          inArray(schema.cashShifts.locationId, storeIds),
          gte(schema.cashShifts.openedAt, new Date(now.getTime() - 38 * 3_600_000)),
          salesScopeCond(tenant, schema.cashShifts.locationId),
        ),
      );
    const shiftsBy = new Map<string, typeof shifts>();
    for (const shift of shifts) {
      const tz = tzBy.get(shift.locationId);
      if (!tz || localDate(shift.openedAt, tz) !== dateBy.get(shift.locationId)) continue;
      const list = shiftsBy.get(shift.locationId) ?? [];
      list.push(shift);
      shiftsBy.set(shift.locationId, list);
    }

    const closeouts = await this.db
      .select({
        locationId: schema.dailyCloseouts.locationId,
        closeDate: schema.dailyCloseouts.closeDate,
        exceptionCount: schema.dailyCloseouts.exceptionCount,
      })
      .from(schema.dailyCloseouts)
      .where(
        and(
          eq(schema.dailyCloseouts.businessId, businessId),
          inArray(schema.dailyCloseouts.locationId, storeIds),
          inArray(schema.dailyCloseouts.closeDate, [...new Set(dateBy.values())]),
        ),
      );
    const closeoutBy = new Map(
      closeouts
        .filter((c) => c.closeDate === dateBy.get(c.locationId))
        .map((c) => [c.locationId, c.exceptionCount]),
    );

    return stores.map((store) => {
      const todays = shiftsBy.get(store.id) ?? [];
      const variances = todays.map((s) => s.varianceCents).filter((v): v is number => v != null);
      return {
        locationId: store.id,
        locationName: store.name,
        date: dateBy.get(store.id)!,
        drawerOpen: todays.some((s) => s.closedAt == null),
        drawerClosed: todays.length > 0 && todays.every((s) => s.closedAt != null),
        drawerSuspended: todays.some((s) => s.suspendedAt != null),
        varianceCents: variances.length > 0 ? variances.reduce((a, b) => a + b, 0) : null,
        closeoutRan: closeoutBy.has(store.id),
        closeoutExceptions: closeoutBy.get(store.id) ?? 0,
      };
    });
  }
}
