import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { addDays, DOW_LABELS, isDay, mondayOf } from './week';

/**
 * The master week (owner 2026-11-04): the schedule is the same most
 * weeks, so one saved week — a shift per member per weekday — can be
 * stamped onto any week and adjusted from there.
 *
 *  - `POST save {week}` replaces the master with that week's shifts
 *    (drafts and published alike; pending day-offs are not shifts).
 *  - `POST apply {week, replace?}` writes the master onto the week as
 *    draft shifts. By default a member who already has a row on a day
 *    keeps it (the master fills the gaps); `replace: true` overwrites.
 *    Publishing stays a separate, deliberate step.
 *
 * A viewer with store access rows works only within those stores, as
 * every other schedule call does.
 */

export interface MasterRow {
  membershipId: string;
  name: string;
  roleName: string | null;
  locationId: string | null;
  locationName: string | null;
  /** 0 = Monday … 6 = Sunday. */
  dow: number;
  dowLabel: string;
  startMinutes: number;
  endMinutes: number;
}

export interface MasterWeek {
  rows: MasterRow[];
  people: number;
  shifts: number;
  hours: number;
  updatedAt: Date | null;
}

function allowedLocations(tenant: RequestTenantContext): string[] | null {
  return tenant.scopeLocationIds;
}

function inScope(allowed: string[] | null, locationId: string | null): boolean {
  return !allowed || (locationId != null && allowed.includes(locationId));
}

@TenantScoped()
@Controller('v1/schedule/master')
export class ScheduleMasterController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('schedule.view')
  async get(@CurrentTenant() tenant: RequestTenantContext): Promise<MasterWeek> {
    const allowed = allowedLocations(tenant);
    const rows = await this.db
      .select({
        membershipId: schema.staffShiftTemplates.membershipId,
        name: schema.users.name,
        email: schema.users.email,
        roleName: schema.roles.name,
        locationId: schema.staffShiftTemplates.locationId,
        locationName: schema.locations.name,
        dow: schema.staffShiftTemplates.dow,
        startMinutes: schema.staffShiftTemplates.startMinutes,
        endMinutes: schema.staffShiftTemplates.endMinutes,
        updatedAt: schema.staffShiftTemplates.updatedAt,
      })
      .from(schema.staffShiftTemplates)
      .innerJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.staffShiftTemplates.membershipId),
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.staffShiftTemplates.locationId))
      .where(eq(schema.staffShiftTemplates.businessId, tenant.businessId!))
      .orderBy(asc(schema.users.name), asc(schema.staffShiftTemplates.dow));
    const visible = rows.filter((r) => inScope(allowed, r.locationId));
    const out: MasterRow[] = visible.map((r) => ({
      membershipId: r.membershipId,
      name: r.name ?? r.email ?? 'Member',
      roleName: r.roleName ?? null,
      locationId: r.locationId,
      locationName: r.locationName ?? null,
      dow: r.dow,
      dowLabel: DOW_LABELS[r.dow] ?? '',
      startMinutes: r.startMinutes,
      endMinutes: r.endMinutes,
    }));
    const updatedAt = visible.reduce<Date | null>(
      (m, r) => (m == null || r.updatedAt > m ? r.updatedAt : m),
      null,
    );
    return {
      rows: out,
      people: new Set(out.map((r) => r.membershipId)).size,
      shifts: out.length,
      hours:
        Math.round(out.reduce((s, r) => s + (r.endMinutes - r.startMinutes) / 60, 0) * 10) / 10,
      updatedAt,
    };
  }

  /** Replace the master with a week's shifts. */
  @Post('save')
  @RequirePermission('schedule.edit')
  async save(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { week?: unknown },
  ): Promise<{ week: { start: string; end: string }; saved: number }> {
    const businessId = tenant.businessId!;
    if (!isDay(body.week)) throw new BadRequestException('week must be YYYY-MM-DD');
    const start = mondayOf(body.week);
    const end = addDays(start, 6);
    const allowed = allowedLocations(tenant);
    if (allowed && allowed.length === 0) {
      throw new ForbiddenException('That location is outside your store access');
    }
    const shifts = await this.db
      .select({
        membershipId: schema.staffShifts.membershipId,
        locationId: schema.staffShifts.locationId,
        date: schema.staffShifts.date,
        startMinutes: schema.staffShifts.startMinutes,
        endMinutes: schema.staffShifts.endMinutes,
      })
      .from(schema.staffShifts)
      .where(
        and(
          eq(schema.staffShifts.businessId, businessId),
          gte(schema.staffShifts.date, start),
          lte(schema.staffShifts.date, end),
          isNotNull(schema.staffShifts.startMinutes),
          allowed ? inArray(schema.staffShifts.locationId, allowed) : undefined,
        ),
      );
    const now = new Date();
    const values = shifts.map((s) => ({
      businessId,
      membershipId: s.membershipId,
      locationId: s.locationId,
      dow: (new Date(`${s.date}T00:00:00Z`).getUTCDay() + 6) % 7,
      startMinutes: s.startMinutes!,
      endMinutes: s.endMinutes!,
      updatedByMembershipId: tenant.membershipId,
      updatedAt: now,
    }));
    await this.db.transaction(async (tx) => {
      // Within the viewer's stores the old master goes; a store they cannot
      // see keeps its rows.
      await tx
        .delete(schema.staffShiftTemplates)
        .where(
          and(
            eq(schema.staffShiftTemplates.businessId, businessId),
            allowed ? inArray(schema.staffShiftTemplates.locationId, allowed) : undefined,
          ),
        );
      // A member's row for a weekday is unique; when a store-restricted
      // viewer replaced only their stores, a member who moved stores
      // still ends up with one row — the new one.
      if (values.length > 0) {
        await tx
          .insert(schema.staffShiftTemplates)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.staffShiftTemplates.membershipId, schema.staffShiftTemplates.dow],
            set: {
              locationId: sql`excluded.location_id`,
              startMinutes: sql`excluded.start_minutes`,
              endMinutes: sql`excluded.end_minutes`,
              updatedByMembershipId: sql`excluded.updated_by_membership_id`,
              updatedAt: now,
            },
          });
      }
    });
    await this.audit.log({
      action: 'schedule.master.save',
      targetType: 'schedule_week',
      targetId: start,
      metadata: { start, end, saved: values.length },
    });
    return { week: { start, end }, saved: values.length };
  }

  /** Stamp the master onto a week as draft shifts. */
  @Post('apply')
  @RequirePermission('schedule.edit')
  async apply(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { week?: unknown; replace?: unknown },
  ): Promise<{ week: { start: string; end: string }; applied: number; skipped: number }> {
    const businessId = tenant.businessId!;
    if (!isDay(body.week)) throw new BadRequestException('week must be YYYY-MM-DD');
    const replace = body.replace === true;
    const start = mondayOf(body.week);
    const end = addDays(start, 6);
    const allowed = allowedLocations(tenant);
    if (allowed && allowed.length === 0) {
      throw new ForbiddenException('That location is outside your store access');
    }
    const master = await this.db
      .select({
        membershipId: schema.staffShiftTemplates.membershipId,
        locationId: schema.staffShiftTemplates.locationId,
        dow: schema.staffShiftTemplates.dow,
        startMinutes: schema.staffShiftTemplates.startMinutes,
        endMinutes: schema.staffShiftTemplates.endMinutes,
      })
      .from(schema.staffShiftTemplates)
      .innerJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.staffShiftTemplates.membershipId),
      )
      .where(
        and(
          eq(schema.staffShiftTemplates.businessId, businessId),
          // Someone who has since left the business is not scheduled.
          eq(schema.memberships.status, 'active'),
          allowed ? inArray(schema.staffShiftTemplates.locationId, allowed) : undefined,
        ),
      );
    if (master.length === 0) {
      throw new BadRequestException('No master week is saved yet — save one from a week first');
    }
    const now = new Date();
    let applied = 0;
    for (const m of master) {
      const date = addDays(start, m.dow);
      const row = {
        businessId,
        membershipId: m.membershipId,
        locationId: m.locationId,
        date,
        startMinutes: m.startMinutes,
        endMinutes: m.endMinutes,
        publishedAt: null,
        updatedByMembershipId: tenant.membershipId,
        updatedAt: now,
      };
      const q = this.db.insert(schema.staffShifts).values(row);
      const written = replace
        ? await q
            .onConflictDoUpdate({
              target: [schema.staffShifts.membershipId, schema.staffShifts.date],
              set: {
                locationId: m.locationId,
                startMinutes: m.startMinutes,
                endMinutes: m.endMinutes,
                publishedAt: null,
                updatedByMembershipId: tenant.membershipId,
                updatedAt: now,
              },
            })
            .returning({ id: schema.staffShifts.id })
        : await q.onConflictDoNothing().returning({ id: schema.staffShifts.id });
      applied += written.length;
    }
    const skipped = master.length - applied;
    await this.audit.log({
      action: 'schedule.master.apply',
      targetType: 'schedule_week',
      targetId: start,
      metadata: { start, end, replace, applied, skipped },
    });
    return { week: { start, end }, applied, skipped };
  }
}
