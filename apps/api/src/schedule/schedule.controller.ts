import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { addDays, isDay, mondayOf, weekDays } from './week';

/**
 * Staff schedule (owner hand-off 2026-09-10, step 2, screen 5): one week
 * at a time, Monday → Sunday, every active member with their shifts.
 * Owner and Operations set shifts and publish the week; everyone else
 * reads it. Times are minutes from store-local midnight.
 *
 * Draft model: a set or cleared shift is an unpublished change until the
 * week is published. A cleared shift on a row that was published stays
 * as a pending day off (NULL times) so the count is honest; publishing
 * drops those rows and stamps the rest.
 *
 * Scope: a member whose store access is restricted (`scopeLocationIds`)
 * sees and edits only their own locations — the locations list, the
 * people and the shifts are cut down server-side, a location outside the
 * scope is refused, and shifts at other locations never leave the API.
 */

export interface ShiftCell {
  date: string;
  /** null = pending day off (an unpublished removal). */
  startMinutes: number | null;
  endMinutes: number | null;
  published: boolean;
}

export interface SchedulePerson {
  membershipId: string;
  name: string;
  roleName: string | null;
  locationId: string | null;
  locationName: string;
  /** Managers, Operations and the owner read in bold on the grid. */
  isLead: boolean;
  shifts: ShiftCell[];
}

export interface ScheduleWeek {
  today: string;
  timezone: string;
  week: { start: string; end: string; days: { date: string; dow: string; isToday: boolean }[] };
  locations: { id: string; name: string; locationType: string }[];
  canEdit: boolean;
  people: SchedulePerson[];
  unpublishedCount: number;
  lastPublishedAt: Date | null;
}

const LEAD_ROLES = new Set(['Owner', 'Manager', 'Operations']);

function isUuid(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

/** The locations a member may see; null = unrestricted. */
function allowedLocations(tenant: RequestTenantContext): string[] | null {
  return tenant.scopeLocationIds;
}

function assertAllowed(allowed: string[] | null, locationId: string | null): void {
  if (allowed && (locationId == null || !allowed.includes(locationId))) {
    throw new ForbiddenException('That location is outside your store access');
  }
}

function minutes(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1440) {
    throw new BadRequestException(`${what} must be whole minutes from midnight (0–1440)`);
  }
  return v;
}

@TenantScoped()
@Controller('v1/schedule')
export class ScheduleController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async clock(businessId: string): Promise<{ tz: string; today: string }> {
    const stores = await this.db
      .select({ timezone: schema.locations.timezone, locationType: schema.locations.locationType })
      .from(schema.locations)
      .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
      .orderBy(schema.locations.name);
    const tz = (stores.find((s) => s.locationType !== 'warehouse') ?? stores[0])?.timezone ?? 'UTC';
    const [row] = await this.db
      .select({ today: sql<string>`(now() AT TIME ZONE ${tz})::date::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return { tz, today: row!.today };
  }

  /** Active members with name, role and their first store (by name). */
  private async people(businessId: string): Promise<
    Map<
      string,
      {
        membershipId: string;
        name: string;
        roleName: string | null;
        locationId: string | null;
        locationName: string;
        scopeIds: string[];
      }
    >
  > {
    const rows = await this.db
      .select({
        membershipId: schema.memberships.id,
        name: schema.users.name,
        email: schema.users.email,
        roleName: schema.roles.name,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(
        and(eq(schema.memberships.businessId, businessId), eq(schema.memberships.status, 'active')),
      );
    const scopes = await this.db
      .select({
        membershipId: schema.membershipLocationScopes.membershipId,
        locationId: schema.membershipLocationScopes.locationId,
        locationName: schema.locations.name,
      })
      .from(schema.membershipLocationScopes)
      .innerJoin(
        schema.locations,
        eq(schema.locations.id, schema.membershipLocationScopes.locationId),
      )
      .where(eq(schema.membershipLocationScopes.businessId, businessId))
      .orderBy(schema.locations.name);
    const byMember = new Map<string, { id: string; name: string }[]>();
    for (const s of scopes) {
      const list = byMember.get(s.membershipId) ?? [];
      list.push({ id: s.locationId, name: s.locationName });
      byMember.set(s.membershipId, list);
    }
    const out = new Map<
      string,
      {
        membershipId: string;
        name: string;
        roleName: string | null;
        locationId: string | null;
        locationName: string;
        scopeIds: string[];
      }
    >();
    for (const r of rows) {
      const list = byMember.get(r.membershipId) ?? [];
      out.set(r.membershipId, {
        membershipId: r.membershipId,
        name: r.name ?? r.email,
        roleName: r.roleName ?? null,
        locationId: list[0]?.id ?? null,
        locationName: list[0]?.name ?? 'All locations',
        scopeIds: list.map((l) => l.id),
      });
    }
    return out;
  }

  @Get()
  @RequirePermission('schedule.view')
  async week(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('week') weekQ?: string,
    @Query('locationId') locationIdQ?: string,
  ): Promise<ScheduleWeek> {
    const businessId = tenant.businessId!;
    const { tz, today } = await this.clock(businessId);
    const start = mondayOf(isDay(weekQ) ? weekQ : today);
    const end = addDays(start, 6);
    const locationId = isUuid(locationIdQ) ? locationIdQ : null;
    const allowed = allowedLocations(tenant);
    if (locationId) assertAllowed(allowed, locationId);
    if (allowed && allowed.length === 0) {
      return {
        today,
        timezone: tz,
        week: {
          start,
          end,
          days: weekDays(start).map((d) => ({ ...d, isToday: d.date === today })),
        },
        locations: [],
        canEdit: false,
        people: [],
        unpublishedCount: 0,
        lastPublishedAt: null,
      };
    }
    const inScope = (loc: string | null) => !allowed || (loc != null && allowed.includes(loc));

    const [locations, people, shifts] = await Promise.all([
      this.db
        .select({
          id: schema.locations.id,
          name: schema.locations.name,
          locationType: schema.locations.locationType,
        })
        .from(schema.locations)
        .where(
          and(
            eq(schema.locations.businessId, businessId),
            eq(schema.locations.isActive, true),
            allowed ? inArray(schema.locations.id, allowed) : undefined,
          ),
        )
        .orderBy(schema.locations.name),
      this.people(businessId),
      this.db
        .select({
          membershipId: schema.staffShifts.membershipId,
          locationId: schema.staffShifts.locationId,
          date: schema.staffShifts.date,
          startMinutes: schema.staffShifts.startMinutes,
          endMinutes: schema.staffShifts.endMinutes,
          publishedAt: schema.staffShifts.publishedAt,
        })
        .from(schema.staffShifts)
        .where(
          and(
            eq(schema.staffShifts.businessId, businessId),
            gte(schema.staffShifts.date, start),
            lte(schema.staffShifts.date, end),
          ),
        ),
    ]);

    const shiftsByMember = new Map<string, typeof shifts>();
    for (const s of shifts) {
      const list = shiftsByMember.get(s.membershipId) ?? [];
      list.push(s);
      shiftsByMember.set(s.membershipId, list);
    }

    // A store's grid: members with access to it, plus anyone already
    // rostered there this week. "All locations": everyone the viewer may
    // see — every member for an unrestricted viewer, otherwise those who
    // share (or are rostered at) one of the viewer's locations.
    const rows: SchedulePerson[] = [];
    for (const p of people.values()) {
      const mine = (shiftsByMember.get(p.membershipId) ?? []).filter((s) => inScope(s.locationId));
      if (locationId) {
        const scoped = p.scopeIds.includes(locationId);
        const rostered = mine.some((s) => s.locationId === locationId);
        if (!scoped && !rostered) continue;
      } else if (allowed) {
        const shares = p.scopeIds.some((id) => allowed.includes(id));
        if (!shares && mine.length === 0) continue;
      }
      rows.push({
        membershipId: p.membershipId,
        name: p.name,
        roleName: p.roleName,
        locationId: p.locationId,
        locationName: p.locationName,
        isLead: !!p.roleName && LEAD_ROLES.has(p.roleName),
        shifts: mine
          .filter(
            (s) => !locationId || s.locationId === locationId || (!allowed && s.locationId == null),
          )
          .map((s) => ({
            date: s.date,
            startMinutes: s.startMinutes,
            endMinutes: s.endMinutes,
            published: s.publishedAt != null,
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      });
    }
    rows.sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name));

    const visible = rows.flatMap((r) => r.shifts);
    const unpublishedCount = visible.filter((s) => !s.published).length;
    const lastPublishedAt = shifts
      .filter((s) => inScope(s.locationId) || (!allowed && s.locationId == null))
      .reduce<Date | null>(
        (m, s) => (s.publishedAt && (!m || s.publishedAt > m) ? s.publishedAt : m),
        null,
      );

    return {
      today,
      timezone: tz,
      week: {
        start,
        end,
        days: weekDays(start).map((d) => ({ ...d, isToday: d.date === today })),
      },
      locations,
      canEdit: tenant.permissions.has('schedule.edit'),
      people: rows,
      unpublishedCount,
      lastPublishedAt,
    };
  }

  private async memberOrThrow(businessId: string, membershipId: unknown): Promise<string> {
    if (!isUuid(membershipId)) throw new BadRequestException('membershipId must be a uuid');
    const [m] = await this.db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.id, membershipId),
          eq(schema.memberships.businessId, businessId),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!m) throw new NotFoundException('Member not found');
    return m.id;
  }

  /** Set a shift (a draft until the week is published). */
  @Put('shifts')
  @RequirePermission('schedule.edit')
  async setShift(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body()
    body: {
      membershipId?: unknown;
      date?: unknown;
      startMinutes?: unknown;
      endMinutes?: unknown;
      locationId?: unknown;
    },
  ): Promise<ShiftCell & { membershipId: string }> {
    const businessId = tenant.businessId!;
    const membershipId = await this.memberOrThrow(businessId, body.membershipId);
    if (!isDay(body.date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const startMinutes = minutes(body.startMinutes, 'startMinutes');
    const endMinutes = minutes(body.endMinutes, 'endMinutes');
    if (endMinutes <= startMinutes) {
      throw new BadRequestException('End time must be after the start time');
    }
    let locationId: string | null = null;
    if (body.locationId != null && body.locationId !== '') {
      if (!isUuid(body.locationId)) throw new BadRequestException('locationId must be a uuid');
      locationId = body.locationId;
    } else {
      locationId = (await this.people(businessId)).get(membershipId)?.locationId ?? null;
    }
    const allowed = allowedLocations(tenant);
    if (allowed) assertAllowed(allowed, locationId);
    const now = new Date();
    await this.db
      .insert(schema.staffShifts)
      .values({
        businessId,
        membershipId,
        locationId,
        date: body.date,
        startMinutes,
        endMinutes,
        publishedAt: null,
        updatedByMembershipId: tenant.membershipId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.staffShifts.membershipId, schema.staffShifts.date],
        set: {
          locationId,
          startMinutes,
          endMinutes,
          publishedAt: null,
          updatedByMembershipId: tenant.membershipId,
          updatedAt: now,
        },
      });
    await this.audit.log({
      action: 'schedule.shift.set',
      targetType: 'membership',
      targetId: membershipId,
      metadata: { date: body.date, startMinutes, endMinutes, locationId },
    });
    return { membershipId, date: body.date, startMinutes, endMinutes, published: false };
  }

  /** Day off: clears the shift (a pending removal until published). */
  @Post('shifts/off')
  @RequirePermission('schedule.edit')
  async dayOff(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { membershipId?: unknown; date?: unknown },
  ): Promise<{ membershipId: string; date: string; pending: boolean }> {
    const businessId = tenant.businessId!;
    const membershipId = await this.memberOrThrow(businessId, body.membershipId);
    if (!isDay(body.date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const [existing] = await this.db
      .select({
        id: schema.staffShifts.id,
        publishedAt: schema.staffShifts.publishedAt,
        locationId: schema.staffShifts.locationId,
      })
      .from(schema.staffShifts)
      .where(
        and(
          eq(schema.staffShifts.businessId, businessId),
          eq(schema.staffShifts.membershipId, membershipId),
          eq(schema.staffShifts.date, body.date),
        ),
      )
      .limit(1);
    if (!existing) return { membershipId, date: body.date, pending: false };
    const allowed = allowedLocations(tenant);
    if (allowed) assertAllowed(allowed, existing.locationId);
    if (existing.publishedAt) {
      // Was published: keep a pending day-off row so the change is counted.
      await this.db
        .update(schema.staffShifts)
        .set({
          startMinutes: null,
          endMinutes: null,
          publishedAt: null,
          updatedByMembershipId: tenant.membershipId,
          updatedAt: new Date(),
        })
        .where(eq(schema.staffShifts.id, existing.id));
    } else {
      await this.db.delete(schema.staffShifts).where(eq(schema.staffShifts.id, existing.id));
    }
    await this.audit.log({
      action: 'schedule.shift.off',
      targetType: 'membership',
      targetId: membershipId,
      metadata: { date: body.date, wasPublished: !!existing.publishedAt },
    });
    return { membershipId, date: body.date, pending: !!existing.publishedAt };
  }

  /** Publish the week: pending day-offs are dropped, every draft is stamped. */
  @Post('publish')
  @RequirePermission('schedule.edit')
  async publish(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { week?: unknown; locationId?: unknown },
  ): Promise<{
    week: { start: string; end: string };
    published: number;
    removed: number;
    publishedAt: Date;
  }> {
    const businessId = tenant.businessId!;
    if (!isDay(body.week)) throw new BadRequestException('week must be YYYY-MM-DD');
    const start = mondayOf(body.week);
    const end = addDays(start, 6);
    const locationId = isUuid(body.locationId) ? body.locationId : null;
    const allowed = allowedLocations(tenant);
    if (locationId) assertAllowed(allowed, locationId);
    if (allowed && allowed.length === 0) {
      throw new ForbiddenException('That location is outside your store access');
    }
    const inWeek = and(
      eq(schema.staffShifts.businessId, businessId),
      gte(schema.staffShifts.date, start),
      lte(schema.staffShifts.date, end),
      locationId
        ? eq(schema.staffShifts.locationId, locationId)
        : allowed
          ? inArray(schema.staffShifts.locationId, allowed)
          : undefined,
    );
    const removed = await this.db
      .delete(schema.staffShifts)
      .where(and(inWeek, isNull(schema.staffShifts.startMinutes)))
      .returning({ id: schema.staffShifts.id });
    const publishedAt = new Date();
    const published = await this.db
      .update(schema.staffShifts)
      .set({ publishedAt, updatedAt: publishedAt })
      .where(and(inWeek, isNull(schema.staffShifts.publishedAt)))
      .returning({ id: schema.staffShifts.id });
    await this.audit.log({
      action: 'schedule.publish',
      targetType: 'schedule_week',
      targetId: start,
      metadata: { start, end, locationId, published: published.length, removed: removed.length },
    });
    return {
      week: { start, end },
      published: published.length,
      removed: removed.length,
      publishedAt,
    };
  }
}
