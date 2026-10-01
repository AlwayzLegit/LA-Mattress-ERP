import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { schema, withDrizzleTenantContext } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { ExceptionsService } from '../controls/exceptions.service';
import { GlDerivationService } from '../gl/gl-derivation.service';
import { ROOT_DRIZZLE } from '../database/database.module';
import { computeReorderSuggestions } from '../purchasing/replenishment';
import { vendorRunsToday } from '../purchasing/replenishment-engine';
import { parseVendorReplenishment } from '../purchasing/replenishment-data';
import { ReplenishmentRunService } from '../purchasing/replenishment.controller';
import { executeReportRun } from '../report-builder/report-runner';
import { getSource } from '../report-builder/report-sources';
import { jobHealth, parseJobDetail } from './job-health';
import { remindOverdueTasks } from '../orders/collaboration';

/** The declared step list (JOB-002): the operator can always see it. */
export interface JobDefinition {
  id: string;
  name: string;
  description: string;
  /** Order within a nightly pass — explicit, never implied. */
  order: number;
  /** Steps that must have succeeded for this business date first. */
  dependsOn: string[];
  /** JOB-002: destructive steps are declared, and none exist yet. */
  destructive: boolean;
}

export const JOB_REGISTRY: JobDefinition[] = [
  {
    id: 'task_overdue_reminders',
    name: 'Overdue team tasks',
    description:
      'Notifies the task owner and creator when an open task is overdue. One reminder per deadline and recipient; completed tasks are excluded.',
    order: 50,
    dependsOn: [],
    destructive: false,
  },
  {
    id: 'po_overdue_sweep',
    name: 'Overdue purchase orders',
    description:
      'Flags open POs whose expected date has passed as warning exceptions for the buyer.',
    order: 10,
    dependsOn: [],
    destructive: false,
  },
  {
    id: 'auto_replenishment',
    name: 'Auto-replenishment purchase orders',
    description:
      'Drafts purchase orders when stock reaches its reorder point, accounting for open orders. ' +
      'Enable automatic replenishment in operations settings; a buyer reviews and places each draft.',
    order: 30,
    dependsOn: ['po_overdue_sweep'],
    destructive: false,
  },
  {
    id: 'sales_rate_replenishment',
    name: 'Sales-rate replenishment purchase orders',
    description:
      'Uses sales rates to replenish stock for vendors with automatic purchase orders enabled. ' +
      'Follows each vendor’s build days and hold-for-review settings.',
    order: 35,
    dependsOn: [],
    destructive: false,
  },
  {
    id: 'report_builder_schedule',
    name: 'Scheduled report-builder reports',
    description:
      'Runs reports marked Add to Schedule and saves their results in the report archive.',
    order: 60,
    dependsOn: [],
    destructive: false,
  },
  {
    id: 'gl_derivation',
    name: 'GL journal-event derivation',
    description:
      'Creates accounting journal batches for the business date. Missing account mappings and ' +
      'closed periods are reported for review; already posted groups are preserved on retry.',
    order: 70,
    dependsOn: [],
    destructive: false,
  },
  {
    id: 'transfer_aging',
    name: 'Transfer aging',
    description:
      'Flags transfers in transit longer than 3 days — goods on the road are sellable nowhere.',
    order: 40,
    dependsOn: [],
    destructive: false,
  },
];

interface JobOutcome {
  recordsAffected: number;
  detail: Record<string, unknown>;
}

const CATCHUP_DAYS = 7;
const RUN_LOCAL_HOUR = 2;

/**
 * The nightly batch runner (EOD-001 → JOB-002). Deliberately not
 * STORIS's Generate Daily Reports: steps are declared and visible,
 * reporting is separate from processing, nothing destructive runs
 * implicitly, each (job, business date) runs at most once, and a
 * catch-up executes one pass per missed business date instead of
 * collapsing days. The `job_runs` table is the morning run report.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Stateless; instantiated directly so the EOD path shares the exact
   * run code the interactive endpoint uses (T-31). */
  private readonly replenishmentRunner = new ReplenishmentRunService();

  constructor(
    @Inject(ROOT_DRIZZLE) private readonly rootDb: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(GlDerivationService) private readonly glDerivation: GlDerivationService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.NIGHTLY_JOBS_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), 60 * 60 * 1000);
    this.timer.unref?.();
    this.logger.log(`Nightly batch runner armed (~${RUN_LOCAL_HOUR}:00 business-local)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Business-local calendar date/hour (first location's timezone). */
  private async localNow(businessId: string): Promise<{ date: string; hour: number }> {
    const [loc] = await this.rootDb
      .select({ timezone: schema.locations.timezone })
      .from(schema.locations)
      .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
      .orderBy(schema.locations.createdAt)
      .limit(1);
    const tz = loc?.timezone || 'America/Los_Angeles';
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
      return { date: new Date().toISOString().slice(0, 10), hour: new Date().getUTCHours() };
    }
  }

  private async tick(): Promise<void> {
    try {
      const businesses = await this.rootDb
        .select({ id: schema.businesses.id })
        .from(schema.businesses)
        .where(eq(schema.businesses.status, 'active'));
      for (const biz of businesses) {
        const { date: today, hour } = await this.localNow(biz.id);
        // JOB-003: never at the date boundary — run after the small hours.
        if (hour < RUN_LOCAL_HOUR) continue;
        for (const businessDate of await this.pendingDates(biz.id, today)) {
          await this.runForBusiness(biz.id, businessDate);
        }
      }
    } catch (err) {
      this.logger.error(`nightly tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Business dates still owed, oldest first — yesterday and backwards up
   * to the catch-up window. One pass per missed date, never collapsed.
   */
  private async pendingDates(businessId: string, todayLocal: string): Promise<string[]> {
    const [latest] = await this.rootDb
      .select({ businessDate: sql<string | null>`max(${schema.jobRuns.businessDate})` })
      .from(schema.jobRuns)
      .where(eq(schema.jobRuns.businessId, businessId));
    const today = new Date(`${todayLocal}T12:00:00Z`);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const floor = new Date(today.getTime() - CATCHUP_DAYS * 86_400_000);
    let cursor = latest?.businessDate
      ? new Date(`${latest.businessDate}T12:00:00Z`).getTime() + 86_400_000
      : yesterday.getTime();
    cursor = Math.max(cursor, floor.getTime());
    const out: string[] = [];
    for (let t = cursor; t <= yesterday.getTime(); t += 86_400_000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  /** Run every registered job for one business date. Idempotent per step. */
  async runForBusiness(
    businessId: string,
    businessDate: string,
  ): Promise<{ jobId: string; status: string; recordsAffected: number }[]> {
    const results: { jobId: string; status: string; recordsAffected: number }[] = [];
    const succeededToday = new Set<string>();
    const terminalToday = new Map<string, string>();
    const existing = await this.rootDb
      .select({
        jobId: schema.jobRuns.jobId,
        status: schema.jobRuns.status,
        detailJson: schema.jobRuns.detailJson,
      })
      .from(schema.jobRuns)
      .where(
        and(
          eq(schema.jobRuns.businessId, businessId),
          eq(schema.jobRuns.businessDate, businessDate),
        ),
      );
    for (const e of existing) {
      const health = jobHealth(e.jobId, e.status, parseJobDetail(e.detailJson));
      if (health.status === 'succeeded') succeededToday.add(e.jobId);
      if (!health.retryable) terminalToday.set(e.jobId, health.status);
    }

    for (const job of [...JOB_REGISTRY].sort((a, b) => a.order - b.order)) {
      if (terminalToday.has(job.id)) {
        const previous = terminalToday.get(job.id)!;
        results.push({
          jobId: job.id,
          status: previous === 'succeeded' ? 'already_ran' : previous,
          recordsAffected: 0,
        });
        continue;
      }
      const blocked = job.dependsOn.filter((d) => !succeededToday.has(d));
      const startedAt = new Date();
      let status = 'succeeded';
      let outcome: JobOutcome = { recordsAffected: 0, detail: {} };
      let error: string | null = null;
      if (blocked.length > 0) {
        status = 'skipped';
        error = `dependency not satisfied: ${blocked.join(', ')}`;
      } else {
        try {
          outcome = await this.dispatch(job.id, businessId, businessDate);
          status = jobHealth(job.id, 'succeeded', outcome.detail).status;
        } catch (err) {
          status = 'failed';
          error = err instanceof Error ? err.message : String(err);
          this.logger.error(`job ${job.id} failed for ${businessId}@${businessDate}: ${error}`);
        }
      }
      const finishedAt = new Date();
      await this.rootDb
        .insert(schema.jobRuns)
        .values({
          businessId,
          jobId: job.id,
          businessDate,
          status,
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          recordsAffected: outcome.recordsAffected,
          detailJson: JSON.stringify(outcome.detail),
          error,
        })
        .onConflictDoUpdate({
          target: [schema.jobRuns.businessId, schema.jobRuns.jobId, schema.jobRuns.businessDate],
          set: {
            status,
            startedAt,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            recordsAffected: outcome.recordsAffected,
            detailJson: JSON.stringify(outcome.detail),
            error,
          },
        });
      if (status === 'succeeded') succeededToday.add(job.id);
      results.push({ jobId: job.id, status, recordsAffected: outcome.recordsAffected });
    }
    return results;
  }

  private dispatch(jobId: string, businessId: string, businessDate: string): Promise<JobOutcome> {
    switch (jobId) {
      case 'task_overdue_reminders':
        return remindOverdueTasks(this.rootDb, businessId).then((sent) => ({
          recordsAffected: sent,
          detail: { sent },
        }));
      case 'po_overdue_sweep':
        return this.poOverdueSweep(businessId, businessDate);
      case 'auto_replenishment':
        return this.autoReplenishment(businessId);
      case 'sales_rate_replenishment':
        return this.salesRateReplenishment(businessId, businessDate);
      case 'report_builder_schedule':
        return this.reportBuilderSchedule(businessId);
      case 'gl_derivation':
        return this.glDerive(businessId, businessDate);
      case 'transfer_aging':
        return this.transferAging(businessId, businessDate);
      default:
        throw new Error(`unregistered job: ${jobId}`);
    }
  }

  // ------------------------------------------------------------------

  private async poOverdueSweep(businessId: string, businessDate: string): Promise<JobOutcome> {
    const overdue = await this.rootDb
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        expectedAt: schema.purchaseOrders.expectedAt,
      })
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.businessId, businessId),
          inArray(schema.purchaseOrders.status, ['ordered', 'partially_received']),
          lt(schema.purchaseOrders.expectedAt, new Date(`${businessDate}T00:00:00Z`)),
        ),
      );
    let flagged = 0;
    for (const po of overdue) {
      const [already] = await this.rootDb
        .select({ id: schema.exceptionEvents.id })
        .from(schema.exceptionEvents)
        .where(
          and(
            eq(schema.exceptionEvents.businessId, businessId),
            eq(schema.exceptionEvents.type, 'po_overdue'),
            eq(schema.exceptionEvents.entityId, po.id),
          ),
        )
        .limit(1);
      if (already) continue;
      await this.exceptions.record({
        type: 'po_overdue',
        severity: 'warning',
        entityType: 'purchase_order',
        entityId: po.id,
        summary: `${po.number} is past its expected date (${po.expectedAt?.toISOString().slice(0, 10)}) and still open — chase the vendor or update the PO`,
        metadata: { businessDate },
        businessId,
      });
      flagged += 1;
    }
    return { recordsAffected: flagged, detail: { overdue: overdue.length, flagged } };
  }

  /**
   * REPL-040: sales-rate replenishment, our lean basis — reorder points
   * against available stock. Drafts one PO per preferred vendor, netting
   * out anything already on an open PO. Generation automatic, release
   * manual — same convention as auto transfers.
   */
  private async autoReplenishment(businessId: string): Promise<JobOutcome> {
    const [biz] = await this.rootDb
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const ops = (biz?.opsSettingsJson ?? {}) as { autoReplenishmentEnabled?: boolean | null };
    if (ops.autoReplenishmentEnabled !== true) {
      return { recordsAffected: 0, detail: { disabled: true } };
    }

    const groups = await computeReorderSuggestions(this.rootDb, businessId);

    // Placed POs are already netted inside the suggestion (owner
    // 2026-10-01); a draft — tonight's from an earlier run, or a buyer's
    // unplaced basket — still covers the gap, so net those here.
    const variantIds = groups.flatMap((g) => g.lines.map((l) => l.variantId));
    const onOrder = new Map<string, number>();
    if (variantIds.length > 0) {
      const rows = await this.rootDb
        .select({
          variantId: schema.purchaseOrderLines.variantId,
          remaining: sql<number>`sum(${schema.purchaseOrderLines.quantityOrdered} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected})::int`,
        })
        .from(schema.purchaseOrderLines)
        .innerJoin(
          schema.purchaseOrders,
          eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
        )
        .where(
          and(
            eq(schema.purchaseOrderLines.businessId, businessId),
            eq(schema.purchaseOrders.status, 'draft'),
            sql`${schema.purchaseOrders.deletedAt} IS NULL`,
            inArray(schema.purchaseOrderLines.variantId, variantIds),
          ),
        )
        .groupBy(schema.purchaseOrderLines.variantId);
      for (const r of rows) if (r.remaining > 0) onOrder.set(r.variantId, r.remaining);
    }

    // Ship-to: the first active warehouse-typed location (Q2), falling
    // back to the oldest active location; per-vendor ship-to is a
    // follow-up.
    const [loc] = await this.rootDb
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
      .orderBy(
        sql`(${schema.locations.locationType} = 'warehouse') DESC`,
        schema.locations.createdAt,
      )
      .limit(1);
    if (!loc) return { recordsAffected: 0, detail: { skipped: 'no active location' } };

    let created = 0;
    let skippedUnassigned = 0;
    for (const group of groups) {
      if (!group.vendorId) {
        skippedUnassigned += group.lines.length;
        continue;
      }
      const lines = group.lines
        .map((l) => ({ ...l, quantity: l.suggestedQty - (onOrder.get(l.variantId) ?? 0) }))
        .filter((l) => l.quantity > 0);
      if (lines.length === 0) continue;

      const number = await this.generatePoNumber(businessId);
      const [po] = await this.rootDb
        .insert(schema.purchaseOrders)
        .values({
          businessId,
          vendorId: group.vendorId,
          locationId: loc.id,
          number,
          status: 'draft',
          subtotalCents: lines.reduce((s, l) => s + l.quantity * (l.unitCostCents ?? 0), 0),
          notes: 'Auto-replenishment draft — review quantities and place',
          createdByUserId: null,
        })
        .returning();
      if (!po) continue;
      await this.rootDb.insert(schema.purchaseOrderLines).values(
        lines.map((l) => ({
          businessId,
          purchaseOrderId: po.id,
          variantId: l.variantId,
          quantityOrdered: l.quantity,
          unitCostCents: l.unitCostCents ?? 0,
          lineTotalCents: l.quantity * (l.unitCostCents ?? 0),
        })),
      );
      await this.audit.log({
        action: 'purchase_order.create',
        targetType: 'purchase_order',
        targetId: po.id,
        after: {
          number,
          vendorId: group.vendorId,
          status: 'draft',
          lineCount: lines.length,
          trigger: 'auto_replenishment',
        },
        businessId,
      });
      created += 1;
    }
    if (created > 0) {
      await this.exceptions.record({
        type: 'auto_replenishment',
        severity: 'info',
        entityType: 'business',
        entityId: businessId,
        summary: `Auto-replenishment drafted ${created} purchase order(s) — review and place them`,
        metadata: { created, skippedUnassigned },
        businessId,
      });
    }
    return { recordsAffected: created, detail: { created, skippedUnassigned } };
  }

  /**
   * §3.1 EOD mode of sales-rate replenishment. Same engine, same data
   * path as POST /v1/purchasing/replenishment/run — only the trigger
   * differs (T-31). Ship-to follows the auto_replenishment convention:
   * the business's first active location is the warehouse.
   */
  private async salesRateReplenishment(
    businessId: string,
    businessDate: string,
  ): Promise<JobOutcome> {
    const vendors = await this.rootDb
      .select({
        id: schema.vendors.id,
        name: schema.vendors.name,
        replenishmentJson: schema.vendors.replenishmentJson,
      })
      .from(schema.vendors)
      .where(
        and(
          eq(schema.vendors.businessId, businessId),
          eq(schema.vendors.isActive, true),
          sql`${schema.vendors.replenishmentJson} IS NOT NULL`,
        ),
      );
    if (vendors.length === 0) return { recordsAffected: 0, detail: { vendors: 0 } };

    const [loc] = await this.rootDb
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
      .orderBy(
        sql`(${schema.locations.locationType} = 'warehouse') DESC`,
        schema.locations.createdAt,
      )
      .limit(1);
    if (!loc) return { recordsAffected: 0, detail: { skipped: 'no active location' } };

    // Noon UTC of the business date keeps getUTCDay() on that calendar day.
    const today = new Date(`${businessDate}T12:00:00Z`);
    let created = 0;
    let skippedGate = 0;
    let empty = 0;
    const pos: string[] = [];
    for (const v of vendors) {
      const settings = parseVendorReplenishment(v.replenishmentJson);
      if (!settings || !vendorRunsToday(settings, today)) {
        skippedGate += 1;
        continue;
      }
      const result = await this.replenishmentRunner.createPurchaseOrder(this.rootDb, {
        vendorId: v.id,
        locationId: loc.id,
        criteria: {
          variancePercent: null,
          daysForReplenishment: null,
          salesWindow: 'this_year_prior',
          includeOverstocks: false,
          includeServiceItems: false,
          productIds: null,
        },
        businessId,
        today,
        audit: this.audit,
      });
      if (!result) {
        empty += 1;
        continue;
      }
      created += 1;
      pos.push(result.number);
    }
    if (created > 0) {
      await this.exceptions.record({
        type: 'auto_replenishment',
        severity: 'info',
        entityType: 'business',
        entityId: businessId,
        summary: `Sales-rate replenishment created ${created} purchase order(s): ${pos.join(', ')}`,
        metadata: { created, pos, skippedGate, empty },
        businessId,
      });
    }
    return { recordsAffected: created, detail: { created, pos, skippedGate, empty } };
  }

  /**
   * Pack 08 (report builder): the scheduler runs the SAME pipeline as
   * the interactive endpoint (executeReportRun) inside the tenant's
   * RLS context, and its only output is an archive record with
   * runSource='eod' (acceptance #38/#64). Reports whose required
   * prompts have no answer are skipped with the error recorded —
   * scheduled runs carry no operator to ask.
   */
  /** GL slice 2: run the derivation inside the tenant RLS context. */
  private async glDerive(businessId: string, businessDate: string): Promise<JobOutcome> {
    const runId = randomUUID();
    const outcome = await withDrizzleTenantContext(this.rootDb, { businessId }, (tx) =>
      this.glDerivation.derive(tx as never, businessId, businessDate, runId),
    );
    return {
      recordsAffected: outcome.posted.length,
      detail: {
        posted: outcome.posted,
        skipped: outcome.skipped,
        note: 'exchanges settle through orders/returns; refunds derive with proportional tax',
      },
    };
  }

  private async reportBuilderSchedule(businessId: string): Promise<JobOutcome> {
    const defs = await this.rootDb
      .select()
      .from(schema.reportDefinitions)
      .where(
        and(
          eq(schema.reportDefinitions.businessId, businessId),
          eq(schema.reportDefinitions.addToSchedule, true),
        ),
      );
    if (defs.length === 0) return { recordsAffected: 0, detail: { scheduled: 0 } };

    let archived = 0;
    const errors: Record<string, string> = {};
    for (const row of defs) {
      const source = getSource(row.sourceId);
      if (!source) {
        errors[row.name] = `unknown source '${row.sourceId}'`;
        continue;
      }
      try {
        const result = await withDrizzleTenantContext(this.rootDb, { businessId }, async (tx) => {
          const userDicts = await tx
            .select()
            .from(schema.reportDictionaries)
            .where(eq(schema.reportDictionaries.sourceId, row.sourceId));
          return executeReportRun(tx as never, {
            row,
            source,
            userDicts: userDicts.map((d) => ({
              name: d.name,
              kind: d.kind as 'formula' | 'joined',
              width: d.width,
              maskPermission: d.maskPermission,
              columnHeading: d.columnHeading,
              justification: d.justification,
              formula: d.formula,
              joinSourceId: d.joinSourceId,
              joinFieldName: d.joinFieldName,
            })),
            answers: {},
            runBy: 'scheduler',
          });
        });
        await this.rootDb.insert(schema.reportArchives).values({
          businessId,
          reportDefinitionId: row.id,
          reportName: row.name,
          sourceId: row.sourceId,
          access: row.access,
          ownerUserId: row.ownerUserId,
          runSource: 'eod',
          definitionSnapshotJson: row.definitionJson as never,
          resultJson: result as never,
          rowCount: result.rows.length,
          createdByUserId: null,
        });
        archived += 1;
      } catch (err) {
        errors[row.name] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      recordsAffected: archived,
      detail: { scheduled: defs.length, archived, errors },
    };
  }

  private async transferAging(businessId: string, businessDate: string): Promise<JobOutcome> {
    const cutoff = new Date(new Date(`${businessDate}T00:00:00Z`).getTime() - 3 * 86_400_000);
    const aging = await this.rootDb
      .select({ id: schema.stockTransfers.id, number: schema.stockTransfers.number })
      .from(schema.stockTransfers)
      .where(
        and(
          eq(schema.stockTransfers.businessId, businessId),
          eq(schema.stockTransfers.status, 'in_transit'),
          lt(schema.stockTransfers.shippedAt, cutoff),
        ),
      );
    let flagged = 0;
    for (const t of aging) {
      const [already] = await this.rootDb
        .select({ id: schema.exceptionEvents.id })
        .from(schema.exceptionEvents)
        .where(
          and(
            eq(schema.exceptionEvents.businessId, businessId),
            eq(schema.exceptionEvents.type, 'transfer_aging'),
            eq(schema.exceptionEvents.entityId, t.id),
          ),
        )
        .limit(1);
      if (already) continue;
      await this.exceptions.record({
        type: 'transfer_aging',
        severity: 'warning',
        entityType: 'stock_transfer',
        entityId: t.id,
        summary: `${t.number} has been in transit over 3 days — receive it or close it short`,
        metadata: { businessDate },
        businessId,
      });
      flagged += 1;
    }
    return { recordsAffected: flagged, detail: { aging: aging.length, flagged } };
  }

  /** Same PO-YYYY-NNNNNN sequence the interactive PO entry uses. */
  private async generatePoNumber(businessId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await this.rootDb
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.purchaseOrders)
        .where(
          and(
            eq(schema.purchaseOrders.businessId, businessId),
            sql`${schema.purchaseOrders.number} LIKE ${`PO-${year}-%`}`,
          ),
        );
      const seq = (rows[0]?.count ?? 0) + 1 + attempt;
      const candidate = `PO-${year}-${String(seq).padStart(6, '0')}`;
      const [existing] = await this.rootDb
        .select({ id: schema.purchaseOrders.id })
        .from(schema.purchaseOrders)
        .where(
          and(
            eq(schema.purchaseOrders.businessId, businessId),
            eq(schema.purchaseOrders.number, candidate),
          ),
        )
        .limit(1);
      if (!existing) return candidate;
    }
    return `PO-${year}-${Date.now().toString().slice(-6)}`;
  }
}
