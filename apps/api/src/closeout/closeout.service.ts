import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { ROOT_DRIZZLE } from '../database/database.module';
import { ExceptionsService } from '../controls/exceptions.service';
import { balanceDueCentsSql } from '../orders/order-balance';
import { OrdersService } from '../orders/orders.service';

export interface CloseoutSummary {
  locationId: string;
  closeDate: string;
  alreadyRan: boolean;
  exceptionCount: number;
  stockReleasedCount: number;
  findings: {
    openCashShifts: number;
    undeliveredToday: number;
    openRuns: number;
    deliveredWithBalance: number;
  };
}

const AUTO_RELEASE_DAYS = 30;

/**
 * The 22:00 end-of-day close per store (PLAN-POS-OPERATIONS §12, P9).
 * Never blocks anything — it flags: open cash drawers, deliveries that
 * were scheduled today and didn't complete, delivery runs never closed
 * out, and delivered orders still carrying a balance. Findings land on
 * the exception register (G5) where the owner dashboard counts them.
 * The nightly Auto Stock Release (G13) rides along once per business.
 *
 * The in-process timer follows the OverdueScheduler pattern: check
 * every 10 minutes, fire once per store-local day after 22:00 local
 * time, idempotent via the daily_closeouts unique row.
 */
@Injectable()
export class CloseoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloseoutService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(ROOT_DRIZZLE) private readonly rootDb: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.CLOSEOUT_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), 10 * 60 * 1000);
    this.timer.unref?.();
    this.logger.log(`Daily close-out scheduled at ${this.closeHour()}:00 store-local time`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private closeHour(): number {
    const h = Number(process.env.CLOSEOUT_LOCAL_HOUR ?? '22');
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 22;
  }

  /** Store-local {date, hour} for a timezone; falls back to LA. */
  private localNow(timezone: string | null): { date: string; hour: number } {
    const tz = timezone || 'America/Los_Angeles';
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: Number(get('hour')) % 24,
      };
    } catch {
      return this.localNow('America/Los_Angeles');
    }
  }

  private async tick(): Promise<void> {
    try {
      const locations = await this.rootDb
        .select({
          id: schema.locations.id,
          businessId: schema.locations.businessId,
          timezone: schema.locations.timezone,
        })
        .from(schema.locations)
        .innerJoin(schema.businesses, eq(schema.businesses.id, schema.locations.businessId))
        .where(and(eq(schema.locations.isActive, true), eq(schema.businesses.status, 'active')));

      const releasedBusinesses = new Set<string>();
      for (const loc of locations) {
        const { date, hour } = this.localNow(loc.timezone);
        if (hour < this.closeHour()) continue;
        const summary = await this.runForLocation({
          businessId: loc.businessId,
          locationId: loc.id,
          closeDate: date,
          trigger: 'scheduler',
          releaseStock: !releasedBusinesses.has(loc.businessId),
          actorUserId: null,
        });
        if (!summary.alreadyRan) {
          releasedBusinesses.add(loc.businessId);
          this.logger.log(
            `Close-out ${date} for location ${loc.id}: ${summary.exceptionCount} exception(s), ${summary.stockReleasedCount} stock release(s)`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Close-out sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * One store's close for one local date. Idempotent — the unique
   * (location, date) row makes a second call a no-op.
   */
  async runForLocation(args: {
    businessId: string;
    locationId: string;
    closeDate: string;
    trigger: 'scheduler' | 'manual';
    releaseStock: boolean;
    actorUserId: string | null;
  }): Promise<CloseoutSummary> {
    const db = this.rootDb;
    const inserted = await db
      .insert(schema.dailyCloseouts)
      .values({
        businessId: args.businessId,
        locationId: args.locationId,
        closeDate: args.closeDate,
        trigger: args.trigger,
      })
      .onConflictDoNothing({
        target: [schema.dailyCloseouts.locationId, schema.dailyCloseouts.closeDate],
      })
      .returning({ id: schema.dailyCloseouts.id });
    if (!inserted[0]) {
      return {
        locationId: args.locationId,
        closeDate: args.closeDate,
        alreadyRan: true,
        exceptionCount: 0,
        stockReleasedCount: 0,
        findings: { openCashShifts: 0, undeliveredToday: 0, openRuns: 0, deliveredWithBalance: 0 },
      };
    }
    const closeoutId = inserted[0].id;

    // --- Findings ---------------------------------------------------------
    const openShifts = await db
      .select({ id: schema.cashShifts.id })
      .from(schema.cashShifts)
      .where(
        and(
          eq(schema.cashShifts.businessId, args.businessId),
          eq(schema.cashShifts.locationId, args.locationId),
          isNull(schema.cashShifts.closedAt),
        ),
      );

    const undelivered = await db
      .select({ id: schema.deliveries.id, orderId: schema.deliveries.orderId })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .where(
        and(
          eq(schema.deliveries.businessId, args.businessId),
          eq(schema.orders.locationId, args.locationId),
          eq(schema.deliveries.scheduledDate, args.closeDate),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      );

    const openRuns = await db
      .select({ id: schema.deliveryRuns.id, runDate: schema.deliveryRuns.runDate })
      .from(schema.deliveryRuns)
      .where(
        and(
          eq(schema.deliveryRuns.businessId, args.businessId),
          eq(schema.deliveryRuns.locationId, args.locationId),
          sql`${schema.deliveryRuns.runDate} <= ${args.closeDate}`,
          inArray(schema.deliveryRuns.status, ['open', 'out']),
        ),
      );

    // §1's standing alert: delivered + balance due > 0 — the classic
    // "quietly write off the balance after delivery" pattern.
    const withBalance = await db.execute(sql`
      SELECT o.id, o.number,
             ${balanceDueCentsSql(sql.raw('o.id'), sql.raw('o.total_cents'))} AS balance_cents
      FROM orders o
      WHERE o.business_id = ${args.businessId}
        AND o.location_id = ${args.locationId}
        AND o.status IN ('fulfilled', 'completed')
        AND o.imported_at IS NULL
        AND ${balanceDueCentsSql(sql.raw('o.id'), sql.raw('o.total_cents'))} > 0
      LIMIT 25
    `);
    const balanceRows = (withBalance as unknown as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      number: String(r.number),
      balanceCents: Number(r.balance_cents),
    }));

    // --- Register the findings -------------------------------------------
    let exceptionCount = 0;
    const flag = async (
      type: string,
      severity: 'warning' | 'critical',
      summary: string,
      metadata: Record<string, unknown>,
    ) => {
      exceptionCount += 1;
      await this.exceptions.record({
        type,
        severity,
        summary,
        metadata,
        businessId: args.businessId,
        actorUserId: args.actorUserId,
        entityType: 'daily_closeout',
        entityId: closeoutId,
      });
    };

    if (openShifts.length > 0) {
      await flag(
        'close_out_cash',
        'warning',
        `Close-out ${args.closeDate}: ${openShifts.length} cash drawer(s) still open`,
        { shiftIds: openShifts.map((s) => s.id) },
      );
    }
    if (undelivered.length > 0) {
      await flag(
        'close_out_deliveries',
        'warning',
        `Close-out ${args.closeDate}: ${undelivered.length} delivery(ies) scheduled today not completed`,
        { deliveryIds: undelivered.map((d) => d.id) },
      );
    }
    if (openRuns.length > 0) {
      await flag(
        'close_out_runs',
        'critical',
        `Close-out ${args.closeDate}: ${openRuns.length} delivery run(s) never closed out — pieces unaccounted for`,
        { runIds: openRuns.map((r) => r.id) },
      );
    }
    if (balanceRows.length > 0) {
      await flag(
        'close_out_balance',
        'critical',
        `Close-out ${args.closeDate}: ${balanceRows.length} delivered order(s) still carry a balance`,
        {
          orders: balanceRows,
        },
      );
    }

    // --- Nightly Auto Stock Release (G13), once per business per day -----
    let stockReleased = 0;
    if (args.releaseStock) {
      stockReleased = await this.autoStockRelease(args.businessId);
    }

    const findings = {
      openCashShifts: openShifts.length,
      undeliveredToday: undelivered.length,
      openRuns: openRuns.length,
      deliveredWithBalance: balanceRows.length,
    };
    await db
      .update(schema.dailyCloseouts)
      .set({ exceptionCount, stockReleasedCount: stockReleased, summaryJson: findings })
      .where(eq(schema.dailyCloseouts.id, closeoutId));
    await this.audit.log({
      action: 'closeout.run',
      targetType: 'daily_closeout',
      targetId: closeoutId,
      businessId: args.businessId,
      actorUserId: args.actorUserId,
      metadata: { closeDate: args.closeDate, trigger: args.trigger, ...findings, stockReleased },
    });

    return {
      locationId: args.locationId,
      closeDate: args.closeDate,
      alreadyRan: false,
      exceptionCount,
      stockReleasedCount: stockReleased,
      findings,
    };
  }

  /** The G13 release, business-wide, on the root connection. */
  private async autoStockRelease(businessId: string): Promise<number> {
    const cutoff = new Date(Date.now() - AUTO_RELEASE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const stale = await this.rootDb
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        locationId: schema.orders.locationId,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          inArray(schema.orders.status, ['open', 'partially_fulfilled']),
          sql`${schema.orders.requestedDate} < ${cutoff}`,
          sql`${schema.orders.lockedAt} IS NULL`,
          sql`${schema.orders.importedAt} IS NULL`,
        ),
      )
      .limit(50);

    let released = 0;
    for (const o of stale) {
      const [trip] = await this.rootDb
        .select({ id: schema.deliveries.id })
        .from(schema.deliveries)
        .where(
          and(
            eq(schema.deliveries.orderId, o.id),
            inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
          ),
        )
        .limit(1);
      if (trip) continue;
      const [holding] = await this.rootDb
        .select({ id: schema.orderLines.id })
        .from(schema.orderLines)
        .where(and(eq(schema.orderLines.orderId, o.id), sql`${schema.orderLines.qtyReserved} > 0`))
        .limit(1);
      if (!holding) continue;

      await this.orders.releaseOrder(this.rootDb, {
        businessId,
        orderId: o.id,
        locationId: o.locationId,
        actorUserId: null,
        updateLines: true,
      });
      await this.audit.log({
        action: 'order.auto_stock_release',
        targetType: 'order',
        targetId: o.id,
        businessId,
        actorUserId: null,
        metadata: { days: AUTO_RELEASE_DAYS, cutoff, scheduler: true },
      });
      await this.exceptions.record({
        type: 'auto_stock_release',
        severity: 'info',
        entityType: 'order',
        entityId: o.id,
        summary: `Order ${o.number} released its stock — promised over ${AUTO_RELEASE_DAYS} days ago with no truck booked`,
        businessId,
        actorUserId: null,
      });
      released += 1;
    }
    return released;
  }
}
