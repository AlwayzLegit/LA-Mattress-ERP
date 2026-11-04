import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { businessTimeZone, ymdInTimeZone } from '../common/business-today';
import { isDay, zonedBounds } from '../common/date-range';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { toCsv } from './csv';

/**
 * Sales Analysis (STORIS "Run Sales Analysis Report", owner 2026-11-04):
 * one row per salesperson for a date range — what they wrote, what was
 * delivered (completed), what came back, and how far they are from
 * their bonus goal.
 *
 *  - Written: orders by order date (status not draft / quote / cancelled)
 *    plus register sales by sale date. A split order credits each
 *    salesperson their share (`split_bps`; the second gets the rest).
 *  - Delivered: orders completed in the range by completion date, plus
 *    register sales (written and delivered the same moment).
 *  - Returned: completed returns in the range, credited back against
 *    the order's salesperson. Net delivered = delivered − returned.
 *  - Open: everything written and not yet completed or cancelled, any
 *    date — the pipeline that will deliver later.
 *  - Goal: the member's monthly goal (set on their member page). The
 *    progress columns are filled only when the range sits inside one
 *    calendar month, because a monthly goal has no meaning across two.
 *
 * `basis` picks which number the goal is measured against: `delivered`
 * (the default — the owner pays the bonus on what reached the customer)
 * or `written`.
 */

export type SalesAnalysisBasis = 'delivered' | 'written';

export interface SalesAnalysisRow {
  membershipId: string | null;
  name: string;
  code: string;
  roleName: string | null;
  status: string | null;
  writtenCents: number;
  writtenCount: number;
  deliveredCents: number;
  deliveredCount: number;
  returnedCents: number;
  returnedCount: number;
  netDeliveredCents: number;
  openCents: number;
  openCount: number;
  goalCents: number | null;
  /** Goal minus the basis amount, floored at zero; null without a goal or across months. */
  toGoalCents: number | null;
  /** Basis amount as a percentage of the goal (can exceed 100); null without a goal or across months. */
  pctOfGoal: number | null;
}

export interface SalesAnalysisReport {
  generatedAt: string;
  range: { start: string; end: string };
  basis: SalesAnalysisBasis;
  timezone: string;
  locationId: string | null;
  /** True when the range lies inside one calendar month, so monthly goals apply. */
  goalsApply: boolean;
  rows: SalesAnalysisRow[];
  totals: {
    writtenCents: number;
    writtenCount: number;
    deliveredCents: number;
    deliveredCount: number;
    returnedCents: number;
    returnedCount: number;
    netDeliveredCents: number;
    openCents: number;
    openCount: number;
    goalCents: number;
  };
}

const OPEN_STATUSES = ['open', 'confirmed', 'partially_fulfilled', 'fulfilled'];
const UNASSIGNED = 'unassigned';

interface Bucket {
  writtenCents: number;
  writtenCount: number;
  deliveredCents: number;
  deliveredCount: number;
  returnedCents: number;
  returnedCount: number;
  openCents: number;
  openCount: number;
}

function emptyBucket(): Bucket {
  return {
    writtenCents: 0,
    writtenCount: 0,
    deliveredCents: 0,
    deliveredCount: 0,
    returnedCents: 0,
    returnedCount: 0,
    openCents: 0,
    openCount: 0,
  };
}

function initials(name: string | null, email: string | null): string {
  const src = (name ?? '').trim();
  if (src) {
    return src
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('');
  }
  return (email ?? '??').slice(0, 2).toUpperCase();
}

@TenantScoped()
@Controller('v1/reports')
export class SalesAnalysisController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get('sales-analysis')
  @RequirePermission('reports.sales.view')
  async run(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
    @Query('basis') basisQ?: string,
    @Query('locationId') locationIdQ?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<SalesAnalysisReport | void> {
    const businessId = tenant.businessId!;
    const tz = await businessTimeZone(this.db, businessId);
    const today = ymdInTimeZone(new Date(), tz);
    // Default window: this store-local month to date.
    const start = isDay(startQ) ? startQ : `${today.slice(0, 7)}-01`;
    const end = isDay(endQ) && endQ >= start ? endQ : today;
    const basis: SalesAnalysisBasis = basisQ === 'written' ? 'written' : 'delivered';
    const locationId =
      locationIdQ && /^[0-9a-f-]{36}$/i.test(locationIdQ) ? locationIdQ.toLowerCase() : null;
    const { from, toExclusive } = zonedBounds({ start, end }, tz);
    const goalsApply = start.slice(0, 7) === end.slice(0, 7);

    const orderScope = and(
      eq(schema.orders.businessId, businessId),
      isNull(schema.orders.importedAt),
      salesScopeCond(tenant, schema.orders.locationId),
      locationId ? eq(schema.orders.locationId, locationId) : undefined,
    );
    const orderCols = {
      id: schema.orders.id,
      totalCents: schema.orders.totalCents,
      salespersonMembershipId: schema.orders.salespersonMembershipId,
      secondSalespersonMembershipId: schema.orders.secondSalespersonMembershipId,
      splitBps: schema.orders.splitBps,
    };
    const saleScope = and(
      eq(schema.sales.businessId, businessId),
      isNull(schema.sales.importedAt),
      sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
      gte(schema.sales.completedAt, from),
      lt(schema.sales.completedAt, toExclusive),
      salesScopeCond(tenant, schema.sales.locationId),
      locationId ? eq(schema.sales.locationId, locationId) : undefined,
    );

    const [written, delivered, open, returned, registerSales, members] = await Promise.all([
      this.db
        .select(orderCols)
        .from(schema.orders)
        .where(
          and(
            orderScope,
            gte(schema.orders.createdAt, from),
            lt(schema.orders.createdAt, toExclusive),
            sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          ),
        ),
      this.db
        .select(orderCols)
        .from(schema.orders)
        .where(
          and(
            orderScope,
            eq(schema.orders.status, 'completed'),
            gte(schema.orders.completedAt, from),
            lt(schema.orders.completedAt, toExclusive),
          ),
        ),
      this.db
        .select(orderCols)
        .from(schema.orders)
        .where(
          and(
            orderScope,
            inArray(schema.orders.status, OPEN_STATUSES),
            isNull(schema.orders.completedAt),
          ),
        ),
      this.db
        .select({
          id: schema.orderReturns.id,
          totalCents: schema.orderReturns.amountCents,
          salespersonMembershipId: schema.orders.salespersonMembershipId,
          secondSalespersonMembershipId: schema.orders.secondSalespersonMembershipId,
          splitBps: schema.orders.splitBps,
        })
        .from(schema.orderReturns)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderReturns.orderId))
        .where(
          and(
            orderScope,
            eq(schema.orderReturns.status, 'completed'),
            gte(schema.orderReturns.completedAt, from),
            lt(schema.orderReturns.completedAt, toExclusive),
          ),
        ),
      this.db
        .select({
          id: schema.sales.id,
          totalCents: schema.sales.totalCents,
          associateUserId: schema.sales.associateUserId,
        })
        .from(schema.sales)
        .where(saleScope),
      this.db
        .select({
          membershipId: schema.memberships.id,
          userId: schema.memberships.userId,
          status: schema.memberships.status,
          goalCents: schema.memberships.monthlyGoalCents,
          name: schema.users.name,
          email: schema.users.email,
          roleName: schema.roles.name,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .leftJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
        .where(eq(schema.memberships.businessId, businessId)),
    ]);

    const memberByUser = new Map(members.map((m) => [m.userId, m.membershipId]));
    const buckets = new Map<string, Bucket>();
    const at = (key: string | null) => {
      const k = key ?? UNASSIGNED;
      let b = buckets.get(k);
      if (!b) {
        b = emptyBucket();
        buckets.set(k, b);
      }
      return b;
    };
    // A split order credits the first salesperson `split_bps` and the
    // second the remainder; an unsplit order is wholly the first's.
    const credit = (
      o: {
        totalCents: number;
        salespersonMembershipId: string | null;
        secondSalespersonMembershipId: string | null;
        splitBps: number | null;
      },
      centsKey: keyof Bucket,
      countKey: keyof Bucket,
    ) => {
      const first = o.salespersonMembershipId;
      const second = o.secondSalespersonMembershipId;
      if (first && second && second !== first) {
        const bps = o.splitBps ?? 5000;
        const firstCents = Math.round((o.totalCents * bps) / 10000);
        const a = at(first);
        a[centsKey] += firstCents;
        a[countKey] += 1;
        const b = at(second);
        b[centsKey] += o.totalCents - firstCents;
        b[countKey] += 1;
        return;
      }
      const b = at(first ?? second);
      b[centsKey] += o.totalCents;
      b[countKey] += 1;
    };
    for (const o of written) credit(o, 'writtenCents', 'writtenCount');
    for (const o of delivered) credit(o, 'deliveredCents', 'deliveredCount');
    for (const o of open) credit(o, 'openCents', 'openCount');
    for (const r of returned) credit(r, 'returnedCents', 'returnedCount');
    for (const s of registerSales) {
      const b = at(s.associateUserId ? (memberByUser.get(s.associateUserId) ?? null) : null);
      b.writtenCents += s.totalCents;
      b.writtenCount += 1;
      b.deliveredCents += s.totalCents;
      b.deliveredCount += 1;
    }

    const rows: SalesAnalysisRow[] = [];
    const seen = new Set<string>();
    const pushRow = (
      key: string,
      m: {
        name: string | null;
        email: string | null;
        roleName: string | null;
        status: string | null;
        goalCents: number | null;
      } | null,
    ) => {
      const b = buckets.get(key) ?? emptyBucket();
      const net = b.deliveredCents - b.returnedCents;
      const hasNumbers = Object.values(b).some((v) => v !== 0);
      const goal = m?.goalCents ?? null;
      // A member who sold nothing in the range and has no goal is noise;
      // a member with a goal shows even at zero so the gap is visible.
      if (!hasNumbers && goal == null) return;
      const amount = basis === 'delivered' ? net : b.writtenCents;
      const measured = goalsApply && goal != null && goal > 0;
      rows.push({
        membershipId: key === UNASSIGNED ? null : key,
        name: key === UNASSIGNED ? 'No salesperson' : (m?.name ?? m?.email ?? 'Member'),
        code: key === UNASSIGNED ? '—' : initials(m?.name ?? null, m?.email ?? null),
        roleName: m?.roleName ?? null,
        status: m?.status ?? null,
        ...b,
        netDeliveredCents: net,
        goalCents: goal,
        toGoalCents: measured ? Math.max(0, goal - amount) : null,
        pctOfGoal: measured ? Math.round((amount / goal) * 1000) / 10 : null,
      });
      seen.add(key);
    };
    for (const m of members) pushRow(m.membershipId, m);
    if (buckets.has(UNASSIGNED)) pushRow(UNASSIGNED, null);
    rows.sort((a, b) => {
      if (a.membershipId == null) return 1;
      if (b.membershipId == null) return -1;
      const av = basis === 'delivered' ? a.netDeliveredCents : a.writtenCents;
      const bv = basis === 'delivered' ? b.netDeliveredCents : b.writtenCents;
      return bv - av || a.name.localeCompare(b.name);
    });

    const totals = rows.reduce(
      (t, r) => ({
        writtenCents: t.writtenCents + r.writtenCents,
        writtenCount: t.writtenCount + r.writtenCount,
        deliveredCents: t.deliveredCents + r.deliveredCents,
        deliveredCount: t.deliveredCount + r.deliveredCount,
        returnedCents: t.returnedCents + r.returnedCents,
        returnedCount: t.returnedCount + r.returnedCount,
        netDeliveredCents: t.netDeliveredCents + r.netDeliveredCents,
        openCents: t.openCents + r.openCents,
        openCount: t.openCount + r.openCount,
        goalCents: t.goalCents + (r.goalCents ?? 0),
      }),
      {
        writtenCents: 0,
        writtenCount: 0,
        deliveredCents: 0,
        deliveredCount: 0,
        returnedCents: 0,
        returnedCount: 0,
        netDeliveredCents: 0,
        openCents: 0,
        openCount: 0,
        goalCents: 0,
      },
    );

    const report: SalesAnalysisReport = {
      generatedAt: new Date().toISOString(),
      range: { start, end },
      basis,
      timezone: tz,
      locationId,
      goalsApply,
      rows,
      totals,
    };

    if (format === 'csv') {
      const money = (c: number) => (c / 100).toFixed(2);
      const headers = [
        'Salesperson',
        'Code',
        'Role',
        'Written $',
        'Written #',
        'Delivered $',
        'Delivered #',
        'Returned $',
        'Returned #',
        'Net delivered $',
        'Open $',
        'Open #',
        'Goal $',
        'To goal $',
        '% of goal',
      ];
      const data = rows.map((r) => [
        r.name,
        r.code,
        r.roleName ?? '',
        money(r.writtenCents),
        r.writtenCount,
        money(r.deliveredCents),
        r.deliveredCount,
        money(r.returnedCents),
        r.returnedCount,
        money(r.netDeliveredCents),
        money(r.openCents),
        r.openCount,
        r.goalCents == null ? '' : money(r.goalCents),
        r.toGoalCents == null ? '' : money(r.toGoalCents),
        r.pctOfGoal == null ? '' : r.pctOfGoal,
      ]);
      data.push([
        'Total',
        '',
        '',
        money(totals.writtenCents),
        totals.writtenCount,
        money(totals.deliveredCents),
        totals.deliveredCount,
        money(totals.returnedCents),
        totals.returnedCount,
        money(totals.netDeliveredCents),
        money(totals.openCents),
        totals.openCount,
        money(totals.goalCents),
        '',
        '',
      ]);
      const header = `# sales-analysis basis=${basis} start=${start} end=${end} tz=${tz} generated=${report.generatedAt}\n`;
      res!.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res!.setHeader(
        'Content-Disposition',
        `attachment; filename="sales-analysis-${basis}-${start}-to-${end}.csv"`,
      );
      res!.send(header + toCsv(headers, data));
      return;
    }
    return report;
  }
}
