import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { isDay, tzDayEndExclusive, tzDayStart } from '../common/date-range';
import { ExceptionsService } from '../controls/exceptions.service';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

/**
 * The close-out sheet (redesign Phase 10, README §3.5 "Z-report"): one
 * store, one store-local date. Six tiles with the same-weekday-last-week
 * baseline, the tender mix with the refund line, the cash drawers with
 * their variance and the inline exception, what the 10pm close found,
 * the day's refunds and cancellations, and the manager's sign-off.
 *
 * Everything on the sheet is derived at read time from the ledgers the
 * day already wrote — the only rows this controller owns are the
 * sign-off and the two drawer verbs, and those go on the exception
 * register with the actor's name so the owner's exceptions see them.
 * Legacy-imported documents never count (D8).
 */

export interface CloseOutDrawer {
  id: string;
  /** 1-based, in opening order within the day: "Drawer 2". */
  number: number;
  openedAt: string;
  closedAt: string | null;
  openedBy: string | null;
  closedBy: string | null;
  openingFloatCents: number;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
  status: 'open' | 'clean' | 'short' | 'over' | 'suspended';
  closeAttempts: number;
  recount: { by: string; at: string } | null;
  reason: { text: string; by: string; at: string } | null;
}

export interface CloseOutLine {
  tone: 'ok' | 'risk' | 'hold' | 'info';
  text: string;
}

export interface CloseOutEvent {
  kind: 'refund' | 'cancellation';
  number: string;
  href: string | null;
  who: string | null;
  note: string;
  amountCents: number;
  at: string;
}

export interface CloseOutReport {
  date: string;
  today: string;
  location: { id: string; name: string; timezone: string };
  locations: { id: string; name: string }[];
  baseline: { date: string; label: string };
  tiles: {
    sales: { count: number; baseline: number };
    gross: { cents: number; baseline: number };
    tax: { cents: number; ratePct: number | null };
    refunds: { cents: number; count: number; baseline: number };
    net: { cents: number; baseline: number };
    orderMoney: { cents: number; orderCount: number };
  };
  tenders: { method: string; count: number; amountCents: number }[];
  refundLine: { count: number; amountCents: number };
  drawers: CloseOutDrawer[];
  close: {
    id: string;
    ranAt: string;
    trigger: string;
    exceptionCount: number;
    stockReleasedCount: number;
    findings: {
      openCashShifts: number;
      undeliveredToday: number;
      openRuns: number;
      deliveredWithBalance: number;
    };
  } | null;
  closeHour: number;
  did: CloseOutLine[];
  exceptions: { open: number; total: number };
  events: CloseOutEvent[];
  signoff: { name: string; at: string; openExceptionCount: number; note: string | null } | null;
  viewer: { canSignOff: boolean };
}

const RECOUNT_TYPE = 'cash_recount_requested';
const REASON_TYPE = 'cash_variance_reason';
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shiftDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function usd(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${(abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function localClock(at: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

function closeHour(): number {
  const h = Number(process.env.CLOSEOUT_LOCAL_HOUR ?? '22');
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 22;
}

@TenantScoped()
@Controller('v1/closeouts')
export class CloseOutReportController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  // ---------------------------------------------------------------------
  // Scope

  /** Selling stores the viewer may see, in name order. */
  private async stores(
    tenant: RequestTenantContext,
  ): Promise<{ id: string; name: string; timezone: string }[]> {
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
          eq(schema.locations.businessId, tenant.businessId!),
          eq(schema.locations.isActive, true),
        ),
      )
      .orderBy(asc(schema.locations.name));
    const scope = tenant.dataScope === 'store' ? new Set(tenant.scopeLocationIds ?? []) : null;
    return rows
      .filter((r) => r.locationType !== 'warehouse')
      .filter((r) => !scope || scope.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, timezone: r.timezone || 'America/Los_Angeles' }));
  }

  private async pickStore(tenant: RequestTenantContext, locationId?: string) {
    const stores = await this.stores(tenant);
    if (stores.length === 0) throw new NotFoundException('No selling store in scope');
    const store = locationId ? stores.find((s) => s.id === locationId) : stores[0];
    if (!store) throw new NotFoundException('Location not found');
    return { store, stores };
  }

  private async localToday(businessId: string, tz: string): Promise<string> {
    const [row] = await this.db
      .select({ today: sql<string>`(now() AT TIME ZONE ${tz})::date::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return row?.today ?? new Date().toISOString().slice(0, 10);
  }

  /** users.id → display name, for drawer and exception stamps. */
  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.id, unique));
    return new Map(rows.map((r) => [r.id, r.name ?? r.email]));
  }

  /** memberships.id → display name, for salesperson stamps. */
  private async memberNames(businessId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({
        membershipId: schema.memberships.id,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.businessId, businessId));
    return new Map(rows.map((r) => [r.membershipId, r.name ?? r.email]));
  }

  // ---------------------------------------------------------------------
  // The sheet

  @Get('report')
  @RequirePermission('reports.sales.view')
  async report(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('date') dateStr?: string,
    @Query('locationId') locationId?: string,
  ): Promise<CloseOutReport> {
    const businessId = tenant.businessId!;
    const { store, stores } = await this.pickStore(tenant, locationId);
    const tz = store.timezone;
    const today = await this.localToday(businessId, tz);
    const date = isDay(dateStr) ? dateStr : today;
    const baselineDay = shiftDays(date, -7);
    const weekday = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!;

    const from = (d: string) => tzDayStart(d, tz);
    const to = (d: string) => tzDayEndExclusive(d, tz);

    // --- Written: register sales + orders written, per day --------------
    const writtenFor = async (d: string) => {
      const [o] = await this.db
        .select({
          count: sql<number>`count(*)::int`,
          gross: sql<number>`coalesce(sum(${schema.orders.totalCents}), 0)::int`,
          tax: sql<number>`coalesce(sum(${schema.orders.taxCents}), 0)::int`,
        })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            eq(schema.orders.locationId, store.id),
            sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
            isNull(schema.orders.importedAt),
            sql`${schema.orders.createdAt} >= ${from(d)} AND ${schema.orders.createdAt} < ${to(d)}`,
          ),
        );
      const [s] = await this.db
        .select({
          count: sql<number>`count(*)::int`,
          gross: sql<number>`coalesce(sum(${schema.sales.totalCents}), 0)::int`,
          tax: sql<number>`coalesce(sum(${schema.sales.taxCents}), 0)::int`,
        })
        .from(schema.sales)
        .where(
          and(
            eq(schema.sales.businessId, businessId),
            eq(schema.sales.locationId, store.id),
            sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
            isNull(schema.sales.importedAt),
            sql`${schema.sales.createdAt} >= ${from(d)} AND ${schema.sales.createdAt} < ${to(d)}`,
          ),
        );
      return {
        count: (o?.count ?? 0) + (s?.count ?? 0),
        gross: (o?.gross ?? 0) + (s?.gross ?? 0),
        tax: (o?.tax ?? 0) + (s?.tax ?? 0),
      };
    };

    // --- Money: payments in/out by method, this store's documents -------
    const payLocation = sql`COALESCE(${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`;
    const paymentsBase = (d: string, sign: 'in' | 'out') =>
      and(
        eq(schema.payments.businessId, businessId),
        eq(schema.payments.status, 'succeeded'),
        sign === 'in'
          ? sql`${schema.payments.amountCents} > 0`
          : sql`${schema.payments.amountCents} < 0`,
        sql`${schema.payments.createdAt} >= ${from(d)} AND ${schema.payments.createdAt} < ${to(d)}`,
        isNull(schema.sales.importedAt),
        isNull(schema.orders.importedAt),
        isNull(schema.serviceOrders.importedAt),
        sql`${payLocation} = ${store.id}::uuid`,
      );
    const paymentsQuery = () =>
      this.db
        .select({
          method: schema.payments.method,
          count: sql<number>`count(*)::int`,
          cents: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)::int`,
        })
        .from(schema.payments)
        .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
        .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
        .leftJoin(
          schema.serviceOrders,
          eq(schema.serviceOrders.id, schema.payments.serviceOrderId),
        );
    const tendersFor = (d: string) =>
      paymentsQuery()
        .where(paymentsBase(d, 'in'))
        .groupBy(schema.payments.method)
        .orderBy(desc(sql`coalesce(sum(${schema.payments.amountCents}), 0)`));
    const outFor = async (d: string) => {
      const rows = await paymentsQuery().where(paymentsBase(d, 'out'));
      return {
        count: rows.reduce((n, r) => n + r.count, 0),
        cents: -rows.reduce((n, r) => n + r.cents, 0),
      };
    };
    const registerRefundsFor = async (d: string) => {
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
            eq(schema.sales.locationId, store.id),
            isNull(schema.sales.importedAt),
            sql`${schema.refunds.createdAt} >= ${from(d)} AND ${schema.refunds.createdAt} < ${to(d)}`,
          ),
        );
      return { count: row?.count ?? 0, cents: row?.cents ?? 0 };
    };
    const orderMoneyFor = async (d: string) => {
      const [row] = await this.db
        .select({
          cents: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)::int`,
          orders: sql<number>`count(distinct ${schema.payments.orderId})::int`,
        })
        .from(schema.payments)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
        .where(
          and(
            eq(schema.payments.businessId, businessId),
            eq(schema.payments.status, 'succeeded'),
            sql`${schema.payments.amountCents} > 0`,
            eq(schema.orders.locationId, store.id),
            isNull(schema.orders.importedAt),
            sql`${schema.payments.createdAt} >= ${from(d)} AND ${schema.payments.createdAt} < ${to(d)}`,
          ),
        );
      return { cents: row?.cents ?? 0, orderCount: row?.orders ?? 0 };
    };

    const [
      written,
      writtenBase,
      tenders,
      out,
      outBase,
      regRefunds,
      regRefundsBase,
      orderMoney,
      members,
    ] = await Promise.all([
      writtenFor(date),
      writtenFor(baselineDay),
      tendersFor(date),
      outFor(date),
      outFor(baselineDay),
      registerRefundsFor(date),
      registerRefundsFor(baselineDay),
      orderMoneyFor(date),
      this.memberNames(businessId),
    ]);

    const refundsCents = out.cents + regRefunds.cents;
    const refundsCount = out.count + regRefunds.count;
    const refundsBaseCents = outBase.cents + regRefundsBase.cents;
    const taxable = written.gross - written.tax;

    // --- Drawers: every shift open at any point of the store day ---------
    const shiftRows = await this.db
      .select({
        id: schema.cashShifts.id,
        openedAt: schema.cashShifts.openedAt,
        closedAt: schema.cashShifts.closedAt,
        openedByUserId: schema.cashShifts.openedByUserId,
        closedByUserId: schema.cashShifts.closedByUserId,
        openingFloatCents: schema.cashShifts.openingFloatCents,
        expectedCashCents: schema.cashShifts.expectedCashCents,
        countedCashCents: schema.cashShifts.countedCashCents,
        varianceCents: schema.cashShifts.varianceCents,
        closeAttempts: schema.cashShifts.closeAttempts,
        suspendedAt: schema.cashShifts.suspendedAt,
      })
      .from(schema.cashShifts)
      .where(
        and(
          eq(schema.cashShifts.businessId, businessId),
          eq(schema.cashShifts.locationId, store.id),
          sql`${schema.cashShifts.openedAt} < ${to(date)}`,
          or(
            isNull(schema.cashShifts.closedAt),
            sql`${schema.cashShifts.closedAt} >= ${from(date)}`,
          ),
        ),
      )
      .orderBy(asc(schema.cashShifts.openedAt));
    const shiftIds = shiftRows.map((s) => s.id);
    const drawerEvents =
      shiftIds.length === 0
        ? []
        : await this.db
            .select({
              type: schema.exceptionEvents.type,
              entityId: schema.exceptionEvents.entityId,
              actorUserId: schema.exceptionEvents.actorUserId,
              createdAt: schema.exceptionEvents.createdAt,
              metadata: schema.exceptionEvents.metadataJson,
            })
            .from(schema.exceptionEvents)
            .where(
              and(
                eq(schema.exceptionEvents.businessId, businessId),
                eq(schema.exceptionEvents.entityType, 'cash_shift'),
                inArray(schema.exceptionEvents.entityId, shiftIds),
                inArray(schema.exceptionEvents.type, [RECOUNT_TYPE, REASON_TYPE]),
              ),
            )
            .orderBy(desc(schema.exceptionEvents.createdAt));
    const users = await this.userNames([
      ...shiftRows.flatMap((s) => [s.openedByUserId, s.closedByUserId ?? '']),
      ...drawerEvents.map((e) => e.actorUserId ?? ''),
    ]);
    const drawers: CloseOutDrawer[] = shiftRows.map((s, i) => {
      const recountEv = drawerEvents.find((e) => e.entityId === s.id && e.type === RECOUNT_TYPE);
      const reasonEv = drawerEvents.find((e) => e.entityId === s.id && e.type === REASON_TYPE);
      const variance = s.varianceCents ?? 0;
      const status: CloseOutDrawer['status'] = !s.closedAt
        ? 'open'
        : s.suspendedAt
          ? 'suspended'
          : variance === 0
            ? 'clean'
            : variance < 0
              ? 'short'
              : 'over';
      return {
        id: s.id,
        number: i + 1,
        openedAt: s.openedAt.toISOString(),
        closedAt: s.closedAt ? s.closedAt.toISOString() : null,
        openedBy: users.get(s.openedByUserId) ?? null,
        closedBy: s.closedByUserId ? (users.get(s.closedByUserId) ?? null) : null,
        openingFloatCents: s.openingFloatCents,
        expectedCashCents: s.expectedCashCents,
        countedCashCents: s.countedCashCents,
        varianceCents: s.closedAt ? s.varianceCents : null,
        status,
        closeAttempts: s.closeAttempts,
        recount: recountEv
          ? {
              by: users.get(recountEv.actorUserId ?? '') ?? 'a manager',
              at: recountEv.createdAt.toISOString(),
            }
          : null,
        reason: reasonEv
          ? {
              text: String((reasonEv.metadata as { reason?: string } | null)?.reason ?? ''),
              by: users.get(reasonEv.actorUserId ?? '') ?? 'a manager',
              at: reasonEv.createdAt.toISOString(),
            }
          : null,
      };
    });

    // --- The 10pm close and its exceptions --------------------------------
    const [closeRow] = await this.db
      .select({
        id: schema.dailyCloseouts.id,
        ranAt: schema.dailyCloseouts.ranAt,
        trigger: schema.dailyCloseouts.trigger,
        exceptionCount: schema.dailyCloseouts.exceptionCount,
        stockReleasedCount: schema.dailyCloseouts.stockReleasedCount,
        summaryJson: schema.dailyCloseouts.summaryJson,
      })
      .from(schema.dailyCloseouts)
      .where(
        and(
          eq(schema.dailyCloseouts.businessId, businessId),
          eq(schema.dailyCloseouts.locationId, store.id),
          eq(schema.dailyCloseouts.closeDate, date),
        ),
      )
      .limit(1);
    const summary = (closeRow?.summaryJson ?? {}) as Partial<
      NonNullable<CloseOutReport['close']>['findings']
    >;
    const findings = {
      openCashShifts: summary.openCashShifts ?? 0,
      undeliveredToday: summary.undeliveredToday ?? 0,
      openRuns: summary.openRuns ?? 0,
      deliveredWithBalance: summary.deliveredWithBalance ?? 0,
    };
    const exceptionEntityIds = [...(closeRow ? [closeRow.id] : []), ...shiftIds];
    const excRows =
      exceptionEntityIds.length === 0
        ? []
        : await this.db
            .select({
              acknowledgedAt: schema.exceptionEvents.acknowledgedAt,
              type: schema.exceptionEvents.type,
            })
            .from(schema.exceptionEvents)
            .where(
              and(
                eq(schema.exceptionEvents.businessId, businessId),
                inArray(schema.exceptionEvents.entityId, exceptionEntityIds),
                sql`${schema.exceptionEvents.severity} <> 'info'`,
              ),
            );
    const exceptions = {
      open: excRows.filter((e) => !e.acknowledgedAt).length,
      total: excRows.length,
    };

    // --- "What the 10pm close did" ---------------------------------------
    const did: CloseOutLine[] = [];
    if (closeRow) {
      did.push({
        tone: 'ok',
        text: `Posted ${plural(written.count, 'sale')} and ${plural(orderMoney.orderCount, 'order payment')} to the ledger`,
      });
      did.push(
        findings.openCashShifts > 0
          ? {
              tone: 'risk',
              text: `Flagged ${plural(findings.openCashShifts, 'cash drawer')} still open at close`,
            }
          : {
              tone: 'ok',
              text:
                drawers.length > 0
                  ? `Checked ${plural(drawers.length, 'drawer')} — every one closed`
                  : 'No cash drawer was opened today',
            },
      );
      did.push(
        findings.undeliveredToday > 0
          ? {
              tone: 'risk',
              text: `Flagged ${plural(findings.undeliveredToday, 'delivery', 'deliveries')} scheduled today not completed`,
            }
          : { tone: 'ok', text: 'Every delivery scheduled today was completed' },
      );
      if (findings.openRuns > 0) {
        did.push({
          tone: 'risk',
          text: `Flagged ${plural(findings.openRuns, 'delivery run')} never closed out — pieces unaccounted for`,
        });
      }
      if (findings.deliveredWithBalance > 0) {
        did.push({
          tone: 'risk',
          text: `Flagged ${plural(findings.deliveredWithBalance, 'delivered order')} still carrying a balance`,
        });
      }
      for (const d of drawers) {
        if (d.status === 'short' || d.status === 'over' || d.status === 'suspended') {
          const amt = usd(Math.abs(d.varianceCents ?? 0));
          const word = d.status === 'suspended' ? 'suspended' : d.status;
          did.push(
            d.reason
              ? {
                  tone: 'ok',
                  text: `Drawer ${d.number} ${word} ${amt} — reason recorded by ${d.reason.by}`,
                }
              : d.recount
                ? {
                    tone: 'hold',
                    text: `Flagged Drawer ${d.number} ${word} ${amt} — recount requested by ${d.recount.by}`,
                  }
                : { tone: 'risk', text: `Flagged Drawer ${d.number} ${word} ${amt} — no recount` },
          );
        }
      }
      if (closeRow.stockReleasedCount > 0) {
        did.push({
          tone: 'hold',
          text: `Released stock on ${plural(closeRow.stockReleasedCount, 'stale order')} — promised over 30 days ago, no truck booked`,
        });
      }
      if (exceptions.total > 0) {
        did.push({
          tone: exceptions.open > 0 ? 'info' : 'ok',
          text:
            exceptions.open > 0
              ? `${exceptions.open} of ${plural(exceptions.total, 'exception')} still open on the register`
              : `All ${plural(exceptions.total, 'exception')} acknowledged`,
        });
      }
    } else {
      did.push({
        tone: 'hold',
        text:
          date >= today
            ? `Runs at ${localClock(new Date(Date.UTC(2000, 0, 1, closeHour())), 'UTC')} store time — nothing posted yet`
            : 'The close never ran for this day — nothing was posted or flagged',
      });
      for (const d of drawers) {
        if (d.status === 'short' || d.status === 'over' || d.status === 'suspended') {
          did.push({
            tone: d.reason ? 'ok' : 'risk',
            text: `Drawer ${d.number} ${d.status} ${usd(Math.abs(d.varianceCents ?? 0))}${
              d.reason
                ? ` — reason recorded by ${d.reason.by}`
                : d.recount
                  ? ' — recount requested'
                  : ''
            }`,
          });
        }
      }
    }

    // --- Refunds & cancellations -----------------------------------------
    const events: CloseOutEvent[] = [];
    const orderRefunds = await this.db
      .select({
        orderId: schema.orders.id,
        number: schema.orders.number,
        amountCents: schema.payments.amountCents,
        method: schema.payments.method,
        at: schema.payments.createdAt,
        rep: schema.orders.salespersonMembershipId,
      })
      .from(schema.payments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          eq(schema.payments.status, 'succeeded'),
          sql`${schema.payments.amountCents} < 0`,
          eq(schema.orders.locationId, store.id),
          isNull(schema.orders.importedAt),
          sql`${schema.payments.createdAt} >= ${from(date)} AND ${schema.payments.createdAt} < ${to(date)}`,
        ),
      )
      .orderBy(asc(schema.payments.createdAt))
      .limit(50);
    for (const r of orderRefunds) {
      events.push({
        kind: 'refund',
        number: r.number,
        href: `/orders/${r.orderId}`,
        who: r.rep ? (members.get(r.rep) ?? null) : null,
        note: `refund${r.method === 'store_credit' ? ' to store credit' : ''}`,
        amountCents: r.amountCents,
        at: r.at.toISOString(),
      });
    }
    const saleRefunds = await this.db
      .select({
        saleId: schema.sales.id,
        number: schema.sales.number,
        amountCents: schema.refunds.amountCents,
        reason: schema.refunds.reason,
        at: schema.refunds.createdAt,
        rep: schema.sales.associateUserId,
      })
      .from(schema.refunds)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
      .where(
        and(
          eq(schema.refunds.businessId, businessId),
          eq(schema.sales.locationId, store.id),
          isNull(schema.sales.importedAt),
          sql`${schema.refunds.createdAt} >= ${from(date)} AND ${schema.refunds.createdAt} < ${to(date)}`,
        ),
      )
      .orderBy(asc(schema.refunds.createdAt))
      .limit(50);
    const saleReps = await this.userNames(saleRefunds.map((r) => r.rep ?? ''));
    for (const r of saleRefunds) {
      events.push({
        kind: 'refund',
        number: r.number,
        href: `/sales/${r.saleId}`,
        who: r.rep ? (saleReps.get(r.rep) ?? null) : null,
        note: r.reason ? `refund · ${r.reason}` : 'register refund',
        amountCents: -r.amountCents,
        at: r.at.toISOString(),
      });
    }
    const cancelled = await this.db
      .select({
        orderId: schema.orders.id,
        number: schema.orders.number,
        totalCents: schema.orders.totalCents,
        at: schema.orders.cancelledAt,
        rep: schema.orders.salespersonMembershipId,
        paidCents: sql<number>`coalesce((select sum(p.amount_cents) from payments p where p.order_id = ${schema.orders.id} and p.status = 'succeeded'), 0)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          eq(schema.orders.locationId, store.id),
          eq(schema.orders.status, 'cancelled'),
          isNull(schema.orders.importedAt),
          sql`${schema.orders.cancelledAt} >= ${from(date)} AND ${schema.orders.cancelledAt} < ${to(date)}`,
        ),
      )
      .orderBy(asc(schema.orders.cancelledAt))
      .limit(50);
    for (const c of cancelled) {
      events.push({
        kind: 'cancellation',
        number: c.number,
        href: `/orders/${c.orderId}`,
        who: c.rep ? (members.get(c.rep) ?? null) : null,
        note:
          c.paidCents > 0
            ? `cancelled, ${usd(c.paidCents)} paid still on the order`
            : `cancelled · ${usd(c.totalCents)} written`,
        amountCents: c.paidCents > 0 ? c.paidCents : 0,
        at: (c.at ?? new Date()).toISOString(),
      });
    }
    events.sort((a, b) => a.at.localeCompare(b.at));

    // --- Sign-off -----------------------------------------------------------
    const [signRow] = await this.db
      .select({
        name: schema.closeOutSignoffs.signedByName,
        at: schema.closeOutSignoffs.signedAt,
        openExceptionCount: schema.closeOutSignoffs.openExceptionCount,
        note: schema.closeOutSignoffs.note,
      })
      .from(schema.closeOutSignoffs)
      .where(
        and(
          eq(schema.closeOutSignoffs.businessId, businessId),
          eq(schema.closeOutSignoffs.locationId, store.id),
          eq(schema.closeOutSignoffs.closeDate, date),
        ),
      )
      .limit(1);

    return {
      date,
      today,
      location: { id: store.id, name: store.name, timezone: tz },
      locations: stores.map((s) => ({ id: s.id, name: s.name })),
      baseline: { date: baselineDay, label: `last ${weekday}` },
      tiles: {
        sales: { count: written.count, baseline: writtenBase.count },
        gross: { cents: written.gross, baseline: writtenBase.gross },
        tax: {
          cents: written.tax,
          ratePct: taxable > 0 ? Math.round((written.tax / taxable) * 1000) / 10 : null,
        },
        refunds: { cents: refundsCents, count: refundsCount, baseline: refundsBaseCents },
        net: {
          cents: written.gross - refundsCents,
          baseline: writtenBase.gross - refundsBaseCents,
        },
        orderMoney,
      },
      tenders: tenders.map((t) => ({ method: t.method, count: t.count, amountCents: t.cents })),
      refundLine: { count: refundsCount, amountCents: refundsCents },
      drawers,
      close: closeRow
        ? {
            id: closeRow.id,
            ranAt: closeRow.ranAt.toISOString(),
            trigger: closeRow.trigger,
            exceptionCount: closeRow.exceptionCount,
            stockReleasedCount: closeRow.stockReleasedCount,
            findings,
          }
        : null,
      closeHour: closeHour(),
      did,
      exceptions,
      events,
      signoff: signRow
        ? {
            name: signRow.name,
            at: signRow.at.toISOString(),
            openExceptionCount: signRow.openExceptionCount,
            note: signRow.note,
          }
        : null,
      viewer: { canSignOff: tenant.permissions.has('reports.closeout.sign_off') },
    };
  }

  // ---------------------------------------------------------------------
  // Verbs

  /** Signs the sheet: name + time. Exceptions stay open on the register. */
  @Post('sign-off')
  @RequirePermission('reports.closeout.sign_off')
  async signOff(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: { locationId?: string; date?: string; note?: string },
  ): Promise<CloseOutReport> {
    if (!isDay(body.date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const { store } = await this.pickStore(tenant, body.locationId);
    const today = await this.localToday(tenant.businessId!, store.timezone);
    if (body.date > today) throw new BadRequestException('That day has not happened yet');
    const note = body.note?.trim().slice(0, 200) || null;
    const sheet = await this.report(tenant, body.date, store.id);
    if (sheet.signoff) return sheet;

    const name = actor?.name ?? actor?.email ?? 'a manager';
    const [inserted] = await this.db
      .insert(schema.closeOutSignoffs)
      .values({
        businessId: tenant.businessId!,
        locationId: store.id,
        closeDate: body.date,
        signedByUserId: actor?.id ?? null,
        signedByName: name,
        openExceptionCount: sheet.exceptions.open,
        note,
      })
      .onConflictDoNothing({
        target: [schema.closeOutSignoffs.locationId, schema.closeOutSignoffs.closeDate],
      })
      .returning({ id: schema.closeOutSignoffs.id });
    if (inserted) {
      await this.audit.log({
        action: 'closeout.sign_off',
        targetType: 'close_out_signoff',
        targetId: inserted.id,
        metadata: {
          locationId: store.id,
          locationName: store.name,
          closeDate: body.date,
          openExceptionCount: sheet.exceptions.open,
          netCents: sheet.tiles.net.cents,
          note,
        },
      });
      void this.webhooks.fire({
        businessId: tenant.businessId!,
        eventType: 'close_out.signed_off',
        payload: {
          signoffId: inserted.id,
          locationId: store.id,
          closeDate: body.date,
          signedBy: name,
          openExceptionCount: sheet.exceptions.open,
          netCents: sheet.tiles.net.cents,
        },
      });
    }
    return this.report(tenant, body.date, store.id);
  }

  /** Loads a closed drawer the viewer may act on. */
  private async drawerFor(tenant: RequestTenantContext, shiftId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(shiftId)) throw new NotFoundException('Drawer not found');
    const [row] = await this.db
      .select({
        id: schema.cashShifts.id,
        locationId: schema.cashShifts.locationId,
        closedAt: schema.cashShifts.closedAt,
        varianceCents: schema.cashShifts.varianceCents,
        suspendedAt: schema.cashShifts.suspendedAt,
        closedByUserId: schema.cashShifts.closedByUserId,
      })
      .from(schema.cashShifts)
      .where(
        and(
          eq(schema.cashShifts.businessId, tenant.businessId!),
          eq(schema.cashShifts.id, shiftId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Drawer not found');
    const { store } = await this.pickStore(tenant, row.locationId);
    if (!row.closedAt) throw new BadRequestException('That drawer is still open');
    if ((row.varianceCents ?? 0) === 0 && !row.suspendedAt) {
      throw new BadRequestException('That drawer balanced — nothing to act on');
    }
    return { row, store };
  }

  private async closeDayOf(businessId: string, closedAt: Date, tz: string): Promise<string> {
    const [r] = await this.db
      .select({
        day: sql<string>`(${closedAt.toISOString()}::timestamptz AT TIME ZONE ${tz})::date::text`,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return r?.day ?? closedAt.toISOString().slice(0, 10);
  }

  /** "Request recount": one warning on the register, with who asked. */
  @Post('drawers/:shiftId/recount')
  @RequirePermission('reports.closeout.sign_off')
  async requestRecount(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('shiftId') shiftId: string,
  ): Promise<CloseOutReport> {
    const { row, store } = await this.drawerFor(tenant, shiftId);
    const [existing] = await this.db
      .select({ id: schema.exceptionEvents.id })
      .from(schema.exceptionEvents)
      .where(
        and(
          eq(schema.exceptionEvents.businessId, tenant.businessId!),
          eq(schema.exceptionEvents.entityType, 'cash_shift'),
          eq(schema.exceptionEvents.entityId, row.id),
          eq(schema.exceptionEvents.type, RECOUNT_TYPE),
        ),
      )
      .limit(1);
    const closer = row.closedByUserId
      ? ((await this.userNames([row.closedByUserId])).get(row.closedByUserId) ?? 'the cashier')
      : 'the cashier';
    const variance = row.varianceCents ?? 0;
    if (!existing) {
      await this.exceptions.record({
        type: RECOUNT_TYPE,
        severity: 'warning',
        entityType: 'cash_shift',
        entityId: row.id,
        summary: `${store.name}: recount requested on the drawer ${closer} closed ${variance < 0 ? 'short' : 'over'} ${usd(Math.abs(variance))}`,
        metadata: {
          locationId: store.id,
          shiftId: row.id,
          varianceCents: variance,
          requestedBy: actor?.name ?? actor?.email ?? null,
        },
      });
      await this.audit.log({
        action: 'cash_shift.recount_requested',
        targetType: 'cash_shift',
        targetId: row.id,
        metadata: { locationId: store.id, varianceCents: variance },
      });
    }
    return this.report(
      tenant,
      await this.closeDayOf(tenant.businessId!, row.closedAt!, store.timezone),
      store.id,
    );
  }

  /** "Record with reason": the variance explained, on the register with the name. */
  @Post('drawers/:shiftId/reason')
  @RequirePermission('reports.closeout.sign_off')
  async recordReason(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('shiftId') shiftId: string,
    @Body() body: { reason?: string },
  ): Promise<CloseOutReport> {
    const reason = body.reason?.trim().slice(0, 240) ?? '';
    if (reason.length < 3) throw new BadRequestException('Give a reason of at least a few words');
    const { row, store } = await this.drawerFor(tenant, shiftId);
    const variance = row.varianceCents ?? 0;
    await this.exceptions.record({
      type: REASON_TYPE,
      severity: 'info',
      entityType: 'cash_shift',
      entityId: row.id,
      summary: `${store.name}: drawer ${variance < 0 ? 'short' : 'over'} ${usd(Math.abs(variance))} — ${reason}`,
      metadata: {
        locationId: store.id,
        shiftId: row.id,
        varianceCents: variance,
        reason,
        recordedBy: actor?.name ?? actor?.email ?? null,
      },
    });
    await this.audit.log({
      action: 'cash_shift.variance_reason',
      targetType: 'cash_shift',
      targetId: row.id,
      metadata: { locationId: store.id, varianceCents: variance, reason },
    });
    return this.report(
      tenant,
      await this.closeDayOf(tenant.businessId!, row.closedAt!, store.timezone),
      store.id,
    );
  }
}
