import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
} from '@nestjs/common';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { tzDayStart } from '../common/date-range';
import { DRIZZLE, ROOT_DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { importESM } from '../utils/import-esm';
import {
  allowedPunches,
  hoursFromMs,
  isPunchType,
  statusOf,
  workedMsBetween,
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
    @Inject(ROOT_DRIZZLE) private readonly rootDb: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async me(tenant: RequestTenantContext): Promise<TimeClockMe> {
    if (!tenant.membershipId) {
      throw new ForbiddenException('The time clock needs a signed-in member');
    }
    return this.meFor(tenant.businessId!, tenant.membershipId);
  }

  /** The strip for one member — the signed-in one, or the one a kiosk just verified. */
  private async meFor(businessId: string, membershipId: string): Promise<TimeClockMe> {
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
    // Store-local instants for the two windows, resolved once so the
    // chips, today's hours and the week's hours all agree.
    const [bounds] = await this.db
      .select({
        dayStart: sql<Date>`${tzDayStart(today, tz)}`,
        weekStart: sql<Date>`${tzDayStart(weekStart, tz)}`,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));
    const dayStart = asDate(bounds!.dayStart);
    const weekStartAt = asDate(bounds!.weekStart);

    const mine = and(
      eq(schema.timePunches.businessId, businessId),
      eq(schema.timePunches.membershipId, membershipId),
    );
    const punchCols = {
      id: schema.timePunches.id,
      type: schema.timePunches.type,
      at: schema.timePunches.at,
    };
    const [weekPunches, [seed], [shift]] = await Promise.all([
      this.db
        .select(punchCols)
        .from(schema.timePunches)
        .where(and(mine, gte(schema.timePunches.at, weekStartAt)))
        .orderBy(schema.timePunches.at),
      // The last punch before the week began seeds the state, so a
      // shift that ran through Sunday midnight is still open on Monday.
      this.db
        .select(punchCols)
        .from(schema.timePunches)
        .where(and(mine, lt(schema.timePunches.at, weekStartAt)))
        .orderBy(desc(schema.timePunches.at))
        .limit(1),
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
    const punches = seed ? [seed, ...weekPunches] : weekPunches;
    const all: Punch[] = punches.map((p) => ({ type: p.type as PunchType, at: p.at }));
    const todays = weekPunches.filter((p) => p.at >= dayStart);
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
      hoursToday: hoursFromMs(workedMsBetween(all, dayStart, now)),
      hoursWeek: hoursFromMs(workedMsBetween(all, weekStartAt, now)),
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
    return this.record(tenant.businessId!, before, body.type);
  }

  /**
   * A22 slice 7 (STORIS Access Time Clock): the shared-terminal kiosk.
   * The terminal itself is signed in as any member who may punch; each
   * punch carries the punching member's own email + password, verified
   * here against their credential account (never a session), and lands
   * on THEIR membership. Nothing about the terminal's session changes.
   */
  @Post('kiosk-punch')
  @RequirePermission('timeclock.punch')
  async kioskPunch(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { email?: unknown; password?: unknown; type?: unknown },
  ): Promise<TimeClockMe & { punched: { type: PunchType; at: Date } }> {
    if (!isPunchType(body?.type)) {
      throw new BadRequestException('type must be clock_in, break_start, break_end or clock_out');
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) throw new BadRequestException('email and password are required');
    const denied = () =>
      new ForbiddenException({ statusCode: 403, code: 'KIOSK_DENIED', message: 'Invalid sign-in' });
    const [user] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (!user) throw denied();
    const [account] = await this.rootDb
      .select({ password: schema.accounts.password })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.userId, user.id), eq(schema.accounts.providerId, 'credential')))
      .limit(1);
    if (!account?.password) throw denied();
    const { verifyPassword } = await importESM<{
      verifyPassword: (args: { hash: string; password: string }) => Promise<boolean>;
    }>('better-auth/crypto');
    if (!(await verifyPassword({ hash: account.password, password }))) throw denied();
    const [membership] = await this.db
      .select({ id: schema.memberships.id, roleId: schema.memberships.roleId })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.businessId, tenant.businessId!),
          eq(schema.memberships.userId, user.id),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!membership) throw denied();
    const [canPunch] = await this.db
      .select({ permission: schema.rolePermissions.permission })
      .from(schema.rolePermissions)
      .where(
        and(
          eq(schema.rolePermissions.roleId, membership.roleId),
          eq(schema.rolePermissions.permission, 'timeclock.punch'),
        ),
      )
      .limit(1);
    if (!canPunch) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'KIOSK_DENIED',
        message: 'This member cannot use the time clock',
      });
    }
    const before = await this.meFor(tenant.businessId!, membership.id);
    return this.record(tenant.businessId!, before, body.type, 'kiosk');
  }

  private async record(
    businessId: string,
    before: TimeClockMe,
    type: PunchType,
    source: 'self' | 'kiosk' = 'self',
  ): Promise<TimeClockMe & { punched: { type: PunchType; at: Date } }> {
    if (!before.allowed.includes(type)) {
      throw new BadRequestException(
        `Cannot ${type.replace('_', ' ')} while ${
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
      businessId,
      membershipId: before.member.membershipId,
      locationId: before.member.locationId,
      type,
      at,
    });
    await this.audit.log({
      action: 'timeclock.punch',
      targetType: 'membership',
      targetId: before.member.membershipId,
      metadata: { type, at, locationId: before.member.locationId, source },
    });
    const after = await this.meFor(businessId, before.member.membershipId);
    return { ...after, punched: { type, at } };
  }
}
