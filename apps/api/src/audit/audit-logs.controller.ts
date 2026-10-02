import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Response } from 'express';
import { schema } from '@jetnine/db';
import {
  buildPage,
  clampLimit as clampPageLimit,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
} from '../common/pagination';
import { TenantScoped, RequirePermission } from '../tenancy/decorators';
import { getRequestDb } from '../tenancy/request-context';
import { AuditService } from './audit.service';

interface AuditLogRow {
  id: string;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  /** The member's name (users.name), for "Henry added …" timelines. */
  actorName: string | null;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  changesJson: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  /**
   * Readable names for the ids inside changesJson — order lines and
   * variants (product name), locations, memberships — so a timeline can
   * say "added 2 × QUEEN TWILIGHT FIRM" instead of printing uuids
   * (owner 2026-10-02: "make the Change history easier to understand").
   */
  names: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every uuid-looking string anywhere in a changes payload. */
function collectIds(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    if (UUID.test(value)) out.add(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectIds(v, out, depth + 1);
  }
}

/**
 * Read-only viewer for the current business's audit log. Filters: actor
 * (user_id), action, target (type + id), date range. Cursor-paginated
 * newest-first. The target filter is what turns this into a per-record
 * timeline — the order detail page reads its history through it.
 */
@TenantScoped()
@Controller('v1/audit-logs')
export class AuditLogsController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.view')
  async list(
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<PageResponse<AuditLogRow>> {
    const limit = clampPageLimit(limitStr);
    const db = getRequestDb();

    const conditions: SQL[] = [];
    if (actorUserId) conditions.push(eq(schema.auditLogs.actorUserId, actorUserId));
    if (action) conditions.push(eq(schema.auditLogs.action, action));
    if (targetType) conditions.push(eq(schema.auditLogs.targetType, targetType));
    if (targetId) conditions.push(eq(schema.auditLogs.targetId, targetId));
    if (since) {
      const sinceDate = new Date(since);
      if (!Number.isNaN(sinceDate.getTime())) {
        conditions.push(gte(schema.auditLogs.createdAt, sinceDate));
      }
    }
    if (until) {
      const untilDate = new Date(until);
      if (!Number.isNaN(untilDate.getTime())) {
        conditions.push(lt(schema.auditLogs.createdAt, untilDate));
      }
    }
    const cursor = decodeCursor(cursorStr);
    if (cursor) {
      conditions.push(
        timestampCursorWhere(schema.auditLogs.createdAt, schema.auditLogs.id, cursor)!,
      );
    }

    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: schema.auditLogs.id,
        action: schema.auditLogs.action,
        actorUserId: schema.auditLogs.actorUserId,
        actorEmail: schema.users.email,
        actorName: schema.users.name,
        actorType: schema.auditLogs.actorType,
        targetType: schema.auditLogs.targetType,
        targetId: schema.auditLogs.targetId,
        changesJson: schema.auditLogs.changesJson,
        ip: schema.auditLogs.ip,
        userAgent: schema.auditLogs.userAgent,
        createdAt: schema.auditLogs.createdAt,
      })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(where)
      .orderBy(...timestampCursorOrder(schema.auditLogs.createdAt, schema.auditLogs.id))
      .limit(limit + 1);

    const names = await this.resolveNames(
      db,
      rows.map((r) => r.changesJson),
    );
    const enriched = rows.map((r) => {
      const ids = new Set<string>();
      collectIds(r.changesJson, ids);
      const own: Record<string, string> = {};
      for (const id of ids) {
        const n = names.get(id);
        if (n) own[id] = n;
      }
      return {
        ...r,
        actorEmail: r.actorEmail ?? null,
        actorName: r.actorName?.trim() || null,
        names: own,
      };
    });
    return buildPage(enriched, limit, (r) => r.createdAt);
  }

  /**
   * One lookup per kind for every id the page's payloads mention. The
   * request db is tenant-scoped (RLS), so another business's ids never
   * resolve. A line resolves to its product's name (falling back to the
   * line's own description — fees, custom lines); a removed line is
   * gone, but its variantId still names the product.
   */
  private async resolveNames(
    db: ReturnType<typeof getRequestDb>,
    payloads: unknown[],
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const p of payloads) collectIds(p, ids);
    const out = new Map<string, string>();
    if (ids.size === 0) return out;
    const list = [...ids].slice(0, 1000);
    const [lines, variants, locations, members] = await Promise.all([
      db
        .select({
          id: schema.orderLines.id,
          description: schema.orderLines.description,
          productName: schema.products.name,
        })
        .from(schema.orderLines)
        .leftJoin(
          schema.productVariants,
          eq(schema.productVariants.id, schema.orderLines.variantId),
        )
        .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .where(inArray(schema.orderLines.id, list)),
      db
        .select({ id: schema.productVariants.id, productName: schema.products.name })
        .from(schema.productVariants)
        .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .where(inArray(schema.productVariants.id, list)),
      db
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(inArray(schema.locations.id, list)),
      db
        .select({ id: schema.memberships.id, name: schema.users.name, email: schema.users.email })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(inArray(schema.memberships.id, list)),
    ]);
    for (const l of lines) {
      const n = (l.productName ?? l.description ?? '').trim();
      if (n) out.set(l.id, n);
    }
    for (const v of variants) if (v.productName?.trim()) out.set(v.id, v.productName.trim());
    for (const l of locations) if (l.name?.trim()) out.set(l.id, l.name.trim());
    for (const m of members) {
      const n = (m.name ?? m.email ?? '').trim();
      if (n) out.set(m.id, n);
    }
    return out;
  }

  /**
   * AUD-006 (sysadmin pack): the audit stream is exportable — same
   * filters as the list, CSV, capped at 10,000 rows newest-first. The
   * export is itself an audit event (AUD-003: privileged reads are
   * events), so pulling the log leaves a trace in the log.
   */
  @Get('export.csv')
  @RequirePermission('audit.view')
  async exportCsv(
    @Res() res: Response,
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ): Promise<void> {
    const db = getRequestDb();
    const conditions: SQL[] = [];
    if (actorUserId) conditions.push(eq(schema.auditLogs.actorUserId, actorUserId));
    if (action) conditions.push(eq(schema.auditLogs.action, action));
    if (targetType) conditions.push(eq(schema.auditLogs.targetType, targetType));
    if (targetId) conditions.push(eq(schema.auditLogs.targetId, targetId));
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) conditions.push(gte(schema.auditLogs.createdAt, d));
    }
    if (until) {
      const d = new Date(until);
      if (!Number.isNaN(d.getTime())) conditions.push(lt(schema.auditLogs.createdAt, d));
    }

    const rows = await db
      .select({
        createdAt: schema.auditLogs.createdAt,
        action: schema.auditLogs.action,
        actorEmail: schema.users.email,
        actorType: schema.auditLogs.actorType,
        targetType: schema.auditLogs.targetType,
        targetId: schema.auditLogs.targetId,
        changesJson: schema.auditLogs.changesJson,
        ip: schema.auditLogs.ip,
      })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.auditLogs.createdAt), desc(schema.auditLogs.id))
      .limit(10_000);

    await this.audit.log({
      action: 'audit.export',
      targetType: 'audit_log',
      metadata: {
        rows: rows.length,
        filters: { actorUserId, action, targetType, targetId, since, until },
      },
    });

    const esc = (v: unknown): string => {
      if (v == null) return '';
      let s = typeof v === 'string' ? v : JSON.stringify(v);
      // Spreadsheet formula-injection guard: a leading =, +, -, @, tab
      // or CR would execute as a formula when the CSV opens in Excel.
      // Values here include user-typed text (notes, reasons), so
      // neutralize with a leading apostrophe.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'created_at,action,actor_email,actor_type,target_type,target_id,changes,ip';
    const lines = rows.map((r) =>
      [
        r.createdAt.toISOString(),
        r.action,
        r.actorEmail,
        r.actorType,
        r.targetType,
        r.targetId,
        r.changesJson,
        r.ip,
      ]
        .map(esc)
        .join(','),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send([header, ...lines].join('\n'));
  }
}
