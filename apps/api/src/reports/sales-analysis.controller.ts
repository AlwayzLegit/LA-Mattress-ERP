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
 * Owner 2026-11-05: every dollar figure is split into **merchandise**
 * (subtotal after discounts — items only, no tax, no delivery/install
 * fees), **tax** and **total** (the grand total the customer pays).
 * Goals and bonus are measured on merchandise. Each row also carries
 * the **cost** of the goods delivered, **profit** (net delivered
 * merchandise − cost) and, when `pct` is given, the salesperson's
 * **commission** (profit × profit-share percentage).
 *
 *  - Written: orders by order date (status not draft / quote / cancelled)
 *    plus register sales by sale date. A split order credits each
 *    salesperson their share (`split_bps`; the second gets the rest).
 *  - Delivered: orders completed in the range by completion date, plus
 *    register sales (written and delivered the same moment).
 *  - Returned: completed returns in the range, credited back against
 *    the order's salesperson. A return's refund is split into
 *    merchandise and tax in the same proportion as its order.
 *    Net delivered = delivered − returned.
 *  - Cost: the FIFO cost consumed when the order was fulfilled (or the
 *    register sale rung); an order with no cost record falls back to
 *    its lines' catalog cost.
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
  /** Written merchandise (subtotal after discounts, before tax and fees). */
  writtenSubtotalCents: number;
  writtenTaxCents: number;
  /** Written grand total (merchandise + tax + fees). */
  writtenCents: number;
  writtenCount: number;
  deliveredSubtotalCents: number;
  deliveredTaxCents: number;
  deliveredCents: number;
  deliveredCount: number;
  returnedSubtotalCents: number;
  returnedTaxCents: number;
  returnedCents: number;
  returnedCount: number;
  /** Delivered merchandise net of returned merchandise — the bonus basis. */
  netDeliveredSubtotalCents: number;
  /** Delivered total net of refunds. */
  netDeliveredCents: number;
  /** Cost of the goods delivered in the range. */
  costCents: number;
  /** Net delivered merchandise − cost. */
  profitCents: number;
  /** profit × profit-share percentage; null when no percentage was given. */
  commissionCents: number | null;
  openSubtotalCents: number;
  openCents: number;
  openCount: number;
  goalCents: number | null;
  /** Goal minus the basis merchandise amount, floored at zero; null without a goal or across months. */
  toGoalCents: number | null;
  /** Basis merchandise amount as a percentage of the goal (can exceed 100); null without a goal or across months. */
  pctOfGoal: number | null;
}

export interface SalesAnalysisTotals {
  writtenSubtotalCents: number;
  writtenTaxCents: number;
  writtenCents: number;
  writtenCount: number;
  deliveredSubtotalCents: number;
  deliveredTaxCents: number;
  deliveredCents: number;
  deliveredCount: number;
  returnedSubtotalCents: number;
  returnedTaxCents: number;
  returnedCents: number;
  returnedCount: number;
  netDeliveredSubtotalCents: number;
  netDeliveredCents: number;
  costCents: number;
  profitCents: number;
  commissionCents: number | null;
  openSubtotalCents: number;
  openCents: number;
  openCount: number;
  goalCents: number;
}

export interface SalesAnalysisReport {
  generatedAt: string;
  range: { start: string; end: string };
  basis: SalesAnalysisBasis;
  timezone: string;
  locationId: string | null;
  /** The profit-share percentage the commission column was computed with, if any. */
  profitSharePct: number | null;
  /** True when the range lies inside one calendar month, so monthly goals apply. */
  goalsApply: boolean;
  rows: SalesAnalysisRow[];
  totals: SalesAnalysisTotals;
}

const OPEN_STATUSES = ['open', 'confirmed', 'partially_fulfilled', 'fulfilled'];
const UNASSIGNED = 'unassigned';
/** Cost consumptions that are the cost of goods sold for an order or register sale. */
const ORDER_COGS_TYPES = ['order_fulfill', 'direct_ship'];

/** The money on one document, as it is credited to a salesperson. */
interface Amounts {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  costCents: number;
}

interface Bucket {
  written: Amounts;
  writtenCount: number;
  delivered: Amounts;
  deliveredCount: number;
  returned: Amounts;
  returnedCount: number;
  open: Amounts;
  openCount: number;
}

type AmountKey = 'written' | 'delivered' | 'returned' | 'open';

const zero = (): Amounts => ({ subtotalCents: 0, taxCents: 0, totalCents: 0, costCents: 0 });

function emptyBucket(): Bucket {
  return {
    written: zero(),
    writtenCount: 0,
    delivered: zero(),
    deliveredCount: 0,
    returned: zero(),
    returnedCount: 0,
    open: zero(),
    openCount: 0,
  };
}

function add(into: Amounts, a: Amounts, factor = 1): void {
  into.subtotalCents += Math.round(a.subtotalCents * factor);
  into.taxCents += Math.round(a.taxCents * factor);
  into.totalCents += Math.round(a.totalCents * factor);
  into.costCents += Math.round(a.costCents * factor);
}

function remainder(whole: Amounts, firstShare: number): Amounts {
  return {
    subtotalCents: whole.subtotalCents - Math.round(whole.subtotalCents * firstShare),
    taxCents: whole.taxCents - Math.round(whole.taxCents * firstShare),
    totalCents: whole.totalCents - Math.round(whole.totalCents * firstShare),
    costCents: whole.costCents - Math.round(whole.costCents * firstShare),
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

/** Merchandise = subtotal (gross) − every discount; never below zero. */
function merchandise(o: { subtotalCents: number; discountCents: number }): number {
  return Math.max(0, o.subtotalCents - o.discountCents);
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
    @Query('pct') pctQ?: string,
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
    const pctNum = pctQ == null || pctQ === '' ? NaN : Number(pctQ);
    const profitSharePct =
      Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 100
        ? Math.round(pctNum * 100) / 100
        : null;
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
      subtotalCents: schema.orders.subtotalCents,
      discountCents: schema.orders.discountCents,
      taxCents: schema.orders.taxCents,
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
          amountCents: schema.orderReturns.amountCents,
          orderSubtotalCents: schema.orders.subtotalCents,
          orderDiscountCents: schema.orders.discountCents,
          orderTaxCents: schema.orders.taxCents,
          orderTotalCents: schema.orders.totalCents,
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
          subtotalCents: schema.sales.subtotalCents,
          discountCents: schema.sales.discountCents,
          taxCents: schema.sales.taxCents,
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

    // Cost of goods for what was delivered: the FIFO consumptions recorded
    // at fulfilment (orders) or at the register (sales), keyed by document.
    // An order with no consumption (direct-ship before costing, seeded
    // data) falls back to its lines' catalog cost.
    const deliveredIds = delivered.map((o) => o.id);
    const saleIds = registerSales.map((s) => s.id);
    const costByRef = new Map<string, number>();
    const fallbackCostByOrder = new Map<string, number>();
    if (deliveredIds.length > 0 || saleIds.length > 0) {
      const refIds = [...deliveredIds, ...saleIds];
      const consumed = await this.db
        .select({
          referenceId: schema.costConsumptions.referenceId,
          cents: sql<number>`COALESCE(SUM(${schema.costConsumptions.quantity} * ${schema.costConsumptions.unitCostCents}), 0)::int`,
        })
        .from(schema.costConsumptions)
        .where(
          and(
            eq(schema.costConsumptions.businessId, businessId),
            inArray(schema.costConsumptions.referenceType, [...ORDER_COGS_TYPES, 'sale']),
            inArray(schema.costConsumptions.referenceId, refIds),
          ),
        )
        .groupBy(schema.costConsumptions.referenceId);
      for (const c of consumed) if (c.referenceId) costByRef.set(c.referenceId, c.cents);
      const uncosted = deliveredIds.filter((id) => !costByRef.has(id));
      if (uncosted.length > 0) {
        const lines = await this.db
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
            and(
              eq(schema.orderLines.businessId, businessId),
              inArray(schema.orderLines.orderId, uncosted),
            ),
          )
          .groupBy(schema.orderLines.orderId);
        for (const l of lines) fallbackCostByOrder.set(l.orderId, l.cents);
      }
    }

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
        salespersonMembershipId: string | null;
        secondSalespersonMembershipId: string | null;
        splitBps: number | null;
      },
      amounts: Amounts,
      key: AmountKey,
    ) => {
      const first = o.salespersonMembershipId;
      const second = o.secondSalespersonMembershipId;
      if (first && second && second !== first) {
        const share = (o.splitBps ?? 5000) / 10000;
        const a = at(first);
        add(a[key], amounts, share);
        a[`${key}Count`] += 1;
        const b = at(second);
        add(b[key], remainder(amounts, share));
        b[`${key}Count`] += 1;
        return;
      }
      const b = at(first ?? second);
      add(b[key], amounts);
      b[`${key}Count`] += 1;
    };
    const orderAmounts = (o: (typeof written)[number], cost = 0): Amounts => ({
      subtotalCents: merchandise(o),
      taxCents: o.taxCents,
      totalCents: o.totalCents,
      costCents: cost,
    });
    for (const o of written) credit(o, orderAmounts(o), 'written');
    for (const o of delivered) {
      const cost = costByRef.get(o.id) ?? fallbackCostByOrder.get(o.id) ?? 0;
      credit(o, orderAmounts(o, cost), 'delivered');
    }
    for (const o of open) credit(o, orderAmounts(o), 'open');
    for (const r of returned) {
      // The refund is split into merchandise and tax the way the order was.
      const orderTotal = r.orderTotalCents;
      const merch = merchandise({
        subtotalCents: r.orderSubtotalCents,
        discountCents: r.orderDiscountCents,
      });
      const subtotal =
        orderTotal > 0 ? Math.round((r.amountCents * merch) / orderTotal) : r.amountCents;
      const tax = orderTotal > 0 ? Math.round((r.amountCents * r.orderTaxCents) / orderTotal) : 0;
      credit(
        r,
        { subtotalCents: subtotal, taxCents: tax, totalCents: r.amountCents, costCents: 0 },
        'returned',
      );
    }
    for (const s of registerSales) {
      const b = at(s.associateUserId ? (memberByUser.get(s.associateUserId) ?? null) : null);
      const amounts: Amounts = {
        subtotalCents: merchandise(s),
        taxCents: s.taxCents,
        totalCents: s.totalCents,
        costCents: costByRef.get(s.id) ?? 0,
      };
      add(b.written, { ...amounts, costCents: 0 });
      b.writtenCount += 1;
      add(b.delivered, amounts);
      b.deliveredCount += 1;
    }

    const rows: SalesAnalysisRow[] = [];
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
      const netSubtotal = b.delivered.subtotalCents - b.returned.subtotalCents;
      const net = b.delivered.totalCents - b.returned.totalCents;
      const hasNumbers =
        b.writtenCount + b.deliveredCount + b.returnedCount + b.openCount > 0 ||
        [b.written, b.delivered, b.returned, b.open].some((a) =>
          Object.values(a).some((v) => v !== 0),
        );
      const goal = m?.goalCents ?? null;
      // A member who sold nothing in the range and has no goal is noise;
      // a member with a goal shows even at zero so the gap is visible.
      if (!hasNumbers && goal == null) return;
      const amount = basis === 'delivered' ? netSubtotal : b.written.subtotalCents;
      const measured = goalsApply && goal != null && goal > 0;
      const cost = b.delivered.costCents;
      const profit = netSubtotal - cost;
      rows.push({
        membershipId: key === UNASSIGNED ? null : key,
        name: key === UNASSIGNED ? 'No salesperson' : (m?.name ?? m?.email ?? 'Member'),
        code: key === UNASSIGNED ? '—' : initials(m?.name ?? null, m?.email ?? null),
        roleName: m?.roleName ?? null,
        status: m?.status ?? null,
        writtenSubtotalCents: b.written.subtotalCents,
        writtenTaxCents: b.written.taxCents,
        writtenCents: b.written.totalCents,
        writtenCount: b.writtenCount,
        deliveredSubtotalCents: b.delivered.subtotalCents,
        deliveredTaxCents: b.delivered.taxCents,
        deliveredCents: b.delivered.totalCents,
        deliveredCount: b.deliveredCount,
        returnedSubtotalCents: b.returned.subtotalCents,
        returnedTaxCents: b.returned.taxCents,
        returnedCents: b.returned.totalCents,
        returnedCount: b.returnedCount,
        netDeliveredSubtotalCents: netSubtotal,
        netDeliveredCents: net,
        costCents: cost,
        profitCents: profit,
        commissionCents:
          profitSharePct == null ? null : Math.round((profit * profitSharePct) / 100),
        openSubtotalCents: b.open.subtotalCents,
        openCents: b.open.totalCents,
        openCount: b.openCount,
        goalCents: goal,
        toGoalCents: measured ? Math.max(0, goal - amount) : null,
        pctOfGoal: measured ? Math.round((amount / goal) * 1000) / 10 : null,
      });
    };
    for (const m of members) pushRow(m.membershipId, m);
    if (buckets.has(UNASSIGNED)) pushRow(UNASSIGNED, null);
    rows.sort((a, b) => {
      if (a.membershipId == null) return 1;
      if (b.membershipId == null) return -1;
      const av = basis === 'delivered' ? a.netDeliveredSubtotalCents : a.writtenSubtotalCents;
      const bv = basis === 'delivered' ? b.netDeliveredSubtotalCents : b.writtenSubtotalCents;
      return bv - av || a.name.localeCompare(b.name);
    });

    const totals: SalesAnalysisTotals = {
      writtenSubtotalCents: 0,
      writtenTaxCents: 0,
      writtenCents: 0,
      writtenCount: 0,
      deliveredSubtotalCents: 0,
      deliveredTaxCents: 0,
      deliveredCents: 0,
      deliveredCount: 0,
      returnedSubtotalCents: 0,
      returnedTaxCents: 0,
      returnedCents: 0,
      returnedCount: 0,
      netDeliveredSubtotalCents: 0,
      netDeliveredCents: 0,
      costCents: 0,
      profitCents: 0,
      commissionCents: profitSharePct == null ? null : 0,
      openSubtotalCents: 0,
      openCents: 0,
      openCount: 0,
      goalCents: 0,
    };
    for (const r of rows) {
      for (const k of Object.keys(totals) as (keyof SalesAnalysisTotals)[]) {
        if (k === 'commissionCents') {
          if (totals.commissionCents != null) totals.commissionCents += r.commissionCents ?? 0;
        } else if (k === 'goalCents') {
          totals.goalCents += r.goalCents ?? 0;
        } else {
          totals[k] += r[k];
        }
      }
    }

    const report: SalesAnalysisReport = {
      generatedAt: new Date().toISOString(),
      range: { start, end },
      basis,
      timezone: tz,
      locationId,
      profitSharePct,
      goalsApply,
      rows,
      totals,
    };

    if (format === 'csv') {
      const money = (c: number) => (c / 100).toFixed(2);
      const opt = (c: number | null) => (c == null ? '' : money(c));
      const headers = [
        'Salesperson',
        'Code',
        'Role',
        'Written merchandise $',
        'Written tax $',
        'Written total $',
        'Written #',
        'Delivered merchandise $',
        'Delivered tax $',
        'Delivered total $',
        'Delivered #',
        'Returned merchandise $',
        'Returned tax $',
        'Returned total $',
        'Returned #',
        'Net delivered merchandise $',
        'Net delivered total $',
        'Cost $',
        'Profit $',
        `Commission $${profitSharePct == null ? '' : ` (${profitSharePct}%)`}`,
        'Open merchandise $',
        'Open total $',
        'Open #',
        'Goal $',
        'To goal $',
        '% of goal',
      ];
      const line = (r: SalesAnalysisRow | SalesAnalysisTotals, label: string[]) => [
        ...label,
        money(r.writtenSubtotalCents),
        money(r.writtenTaxCents),
        money(r.writtenCents),
        r.writtenCount,
        money(r.deliveredSubtotalCents),
        money(r.deliveredTaxCents),
        money(r.deliveredCents),
        r.deliveredCount,
        money(r.returnedSubtotalCents),
        money(r.returnedTaxCents),
        money(r.returnedCents),
        r.returnedCount,
        money(r.netDeliveredSubtotalCents),
        money(r.netDeliveredCents),
        money(r.costCents),
        money(r.profitCents),
        opt(r.commissionCents),
        money(r.openSubtotalCents),
        money(r.openCents),
        r.openCount,
      ];
      const data = rows.map((r) => [
        ...line(r, [r.name, r.code, r.roleName ?? '']),
        opt(r.goalCents),
        opt(r.toGoalCents),
        r.pctOfGoal == null ? '' : r.pctOfGoal,
      ]);
      data.push([...line(totals, ['Total', '', '']), money(totals.goalCents), '', '']);
      const header = `# sales-analysis basis=${basis} start=${start} end=${end} tz=${tz}${
        profitSharePct == null ? '' : ` profit-share=${profitSharePct}%`
      } generated=${report.generatedAt}\n`;
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
