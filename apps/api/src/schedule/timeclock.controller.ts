import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
} from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { tzDayStart } from '../common/date-range';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import {
  allowedPunches,
  hoursFromMs,
  isPunchType,
  statusOf,
  workedMs,
  type ClockStatus,
  type Punch,
  type PunchType,
} from './timeclock-math';
import { mondayOf } from './week';

/**
 * The time clock strip (owner hand-off 2026-09-10, step 2, screen 1): the
 * signed-in member's status, today's punches and hours, this week's
 * hours and today's scheduled shift. Punches are append-only; hours are
 * derived every read (see timeclock-math.ts).
 */

export interface TimeClockMe {
  date: string;
  timezone: string;
  member: {
    membershipId: string;
    name: string;
    roleName: string | null;
    locationId: string | null;
    locationName: string;
  };
  status: ClockStatus;
  since: Date | null;
  punchesToday: { id: string; type: PunchType; at: Date }[];
  hoursToday: number;
  hoursWeek: number;
  scheduledToday: { startMinutes: number; endMinutes: number } | null;
  allowed: PunchType[];
}

@TenantScoped()
@Controller('v1/timeclock')
export class TimeClockController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async me(tenant: RequestTenantContext): Promise<TimeClockMe> {
    const businessId = tenant.businessId!;
    if (!tenant.membershipId) {
      throw new ForbiddenException('The time clock needs a signed-in member');
    }
    const membershipId = tenant.membershipId;

    const [member] = await this.db
      .select({
        name: schema.users.name,
        email: schema.users.email,
        roleName: schema.roles.name,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(eq(schema.memberships.id, membershipId))
      .limit(1);
    const [home] = await this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        timezone: schema.locations.timezone,
      })
      .from(schema.membershipLocationScopes)
      .innerJoin(
        schema.locations,
        eq(schema.locations.id, schema.membershipLocationScopes.locationId),
      )
      .where(eq(schema.membershipLocationScopes.membershipId, membershipId))
      .orderBy(schema.locations.name)
      .limit(1);
    let tz = home?.timezone;
    if (!tz) {
      const [store] = await this.db
        .select({ timezone: schema.locations.timezone })
        .from(schema.locations)
        .where(
          and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)),
        )
        .orderBy(schema.locations.name)
        .limit(1);
      tz = store?.timezone ?? 'UTC';
    }
    const [day] = await this.db
      .select({ today: sql<string>`(now() AT TIME ZONE ${tz})::date::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const today = day!.today;
    const weekStart = mondayOf(today);

    const [punches, [shift]] = await Promise.all([
      this.db
        .select({
          id: schema.timePunches.id,
          type: schema.timePunches.type,
          at: schema.timePunches.at,
        })
        .from(schema.timePunches)
        .where(
          and(
            eq(schema.timePunches.businessId, businessId),
            eq(schema.timePunches.membershipId, membershipId),
            gte(schema.timePunches.at, tzDayStart(weekStart, tz)),
          ),
        )
        .orderBy(schema.timePunches.at),
      this.db
        .select({
          startMinutes: schema.staffShifts.startMinutes,
          endMinutes: schema.staffShifts.endMinutes,
        })
        .from(schema.staffShifts)
        .where(
          and(
            eq(schema.staffShifts.businessId, businessId),
            eq(schema.staffShifts.membershipId, membershipId),
            eq(schema.staffShifts.date, today),
          ),
        )
        .limit(1),
    ]);

    const now = new Date();
    const all: Punch[] = punches.map((p) => ({ type: p.type as PunchType, at: p.at }));
    // Today's punches: store-local day boundary, computed once here so
    // the arithmetic below and the chips agree.
    const [bound] = await this.db
      .select({ start: sql<Date>`${tzDayStart(today, tz)}` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const dayStart = bound!.start instanceof Date ? bound!.start : new Date(bound!.start);
    const todays = punches.filter((p) => p.at >= dayStart);
    const todayPunches: Punch[] = todays.map((p) => ({ type: p.type as PunchType, at: p.at }));
    const { status, since } = statusOf(all);

    return {
      date: today,
      timezone: tz,
      member: {
        membershipId,
        name: member?.name ?? member?.email ?? 'Member',
        roleName: member?.roleName ?? null,
        locationId: home?.id ?? null,
        locationName: home?.name ?? 'All locations',
      },
      status,
      since,
      punchesToday: todays.map((p) => ({ id: p.id, type: p.type as PunchType, at: p.at })),
      hoursToday: hoursFromMs(workedMs(todayPunches, now)),
      hoursWeek: hoursFromMs(workedMs(all, now)),
      scheduledToday:
        shift && shift.startMinutes != null && shift.endMinutes != null
          ? { startMinutes: shift.startMinutes, endMinutes: shift.endMinutes }
          : null,
      allowed: allowedPunches(status),
    };
  }

  @Get('me')
  @RequirePermission('timeclock.punch')
  async get(@CurrentTenant() tenant: RequestTenantContext): Promise<TimeClockMe> {
    return this.me(tenant);
  }

  /** Append a punch; only a punch that moves the status is accepted. */
  @Post('punch')
  @RequirePermission('timeclock.punch')
  async punch(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { type?: unknown },
  ): Promise<TimeClockMe & { punched: { type: PunchType; at: Date } }> {
    if (!isPunchType(body?.type)) {
      throw new BadRequestException('type must be clock_in, break_start, break_end or clock_out');
    }
    const before = await this.me(tenant);
    if (!before.allowed.includes(body.type)) {
      throw new BadRequestException(
        `Cannot ${body.type.replace('_', ' ')} while ${
          before.status === 'in'
            ? 'on the clock'
            : before.status === 'break'
              ? 'on break'
              : 'clocked out'
        }`,
      );
    }
    const at = new Date();
    await this.db.insert(schema.timePunches).values({
      businessId: tenant.businessId!,
      membershipId: before.member.membershipId,
      locationId: before.member.locationId,
      type: body.type,
      at,
    });
    await this.audit.log({
      action: 'timeclock.punch',
      targetType: 'membership',
      targetId: before.member.membershipId,
      metadata: { type: body.type, at, locationId: before.member.locationId },
    });
    const after = await this.me(tenant);
    return { ...after, punched: { type: body.type, at } };
  }
}
