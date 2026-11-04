import { BadRequestException, Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { businessTimeZone, ymdInTimeZone } from '../common/business-today';
import { isDay, zonedMidnight } from '../common/date-range';
import { DRIZZLE } from '../database/database.module';
import { toCsv } from '../reports/csv';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { hoursFromMs, workedMsBetween, type Punch, type PunchType } from './timeclock-math';
import { addDays } from './week';

/**
 * Report Time Clock Activity (STORIS, owner 2026-11-04): every member's
 * punches and hours between two dates, a row per store-local day, with
 * a total per person and for the range. Hours are derived from the
 * punches the same way the dashboard strip derives them (breaks
 * excluded, a shift that crosses midnight split at midnight), so the
 * report and the strip never disagree.
 *
 * Permission `timeclock.report` — the Owner, Managers, Operations and
 * the Bookkeeper. A store-scoped viewer sees the people of their own
 * stores (members whose store access overlaps theirs); unscoped members
 * (warehouse, office) show only to an unrestricted viewer.
 */

export interface TimeClockDay {
  date: string;
  /** First clock-in inside the day, store-local ISO; null when the shift began the day before. */
  firstIn: string | null;
  /** Last clock-out inside the day; null when still on the clock at the day's end. */
  lastOut: string | null;
  breakMinutes: number;
  hours: number;
  /** True when the member was still clocked in (or on break) when the day ended. */
  openAtEnd: boolean;
  punches: { type: PunchType; at: string; locationName: string | null }[];
}

export interface TimeClockPerson {
  membershipId: string;
  name: string;
  roleName: string | null;
  locationName: string;
  days: TimeClockDay[];
  daysWorked: number;
  totalHours: number;
}

export interface TimeClockActivityReport {
  generatedAt: string;
  range: { start: string; end: string };
  timezone: string;
  people: TimeClockPerson[];
  totals: { people: number; daysWorked: number; hours: number };
}

const MAX_DAYS = 370;

function fmtLocal(at: Date, tz: string): string {
  // "2026-11-04T09:00" in the store's wall clock, for the CSV and the page.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Minutes on break inside `[from, to)`: every break_start → break_end pair clipped to the window. */
function breakMsBetween(punches: Punch[], from: Date, to: Date): number {
  const a = from.getTime();
  const b = to.getTime();
  let total = 0;
  let open: number | null = null;
  for (const p of punches) {
    const t = p.at.getTime();
    if (p.type === 'break_start') {
      if (open == null) open = t;
    } else if (open != null) {
      // break_end closes it; a clock_out while "on break" closes it too.
      const s = Math.max(open, a);
      const e = Math.min(t, b);
      if (e > s) total += e - s;
      open = null;
    }
  }
  if (open != null) {
    const s = Math.max(open, a);
    if (b > s) total += b - s;
  }
  return total;
}

@TenantScoped()
@Controller('v1/timeclock')
export class TimeClockActivityController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get('activity')
  @RequirePermission('timeclock.report')
  async activity(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
    @Query('membershipId') membershipIdQ?: string,
    @Query('locationId') locationIdQ?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<TimeClockActivityReport | void> {
    const businessId = tenant.businessId!;
    const tz = await businessTimeZone(this.db, businessId);
    const today = ymdInTimeZone(new Date(), tz);
    // Default window: this week so far (Monday to today).
    const start = isDay(startQ) ? startQ : addDays(today, -6);
    const end = isDay(endQ) && endQ >= start ? endQ : today;
    const days: string[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      days.push(d);
      if (days.length > MAX_DAYS) {
        throw new BadRequestException(`The range is capped at ${MAX_DAYS} days`);
      }
    }
    const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
    const onlyMember = isUuid(membershipIdQ) ? membershipIdQ : null;
    const onlyLocation = isUuid(locationIdQ) ? locationIdQ : null;

    // Everyone on the roster (active or not — a punch from someone since
    // removed still has to show on the report) with their first store.
    const [members, scopes, locations] = await Promise.all([
      this.db
        .select({
          membershipId: schema.memberships.id,
          status: schema.memberships.status,
          name: schema.users.name,
          email: schema.users.email,
          roleName: schema.roles.name,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .leftJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
        .where(eq(schema.memberships.businessId, businessId)),
      this.db
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
        .orderBy(asc(schema.locations.name)),
      this.db
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(eq(schema.locations.businessId, businessId)),
    ]);
    const locationName = new Map(locations.map((l) => [l.id, l.name]));
    const scopeOf = new Map<string, { id: string; name: string }[]>();
    for (const s of scopes) {
      const list = scopeOf.get(s.membershipId) ?? [];
      list.push({ id: s.locationId, name: s.locationName });
      scopeOf.set(s.membershipId, list);
    }
    const viewerStores =
      tenant.dataScope === 'store' ? new Set(tenant.scopeLocationIds ?? []) : null;

    const people = members.filter((m) => {
      if (onlyMember && m.membershipId !== onlyMember) return false;
      const stores = scopeOf.get(m.membershipId) ?? [];
      if (onlyLocation && !stores.some((s) => s.id === onlyLocation)) return false;
      if (viewerStores) {
        if (stores.length === 0) return false;
        if (!stores.some((s) => viewerStores.has(s.id))) return false;
      }
      return true;
    });
    const ids = people.map((p) => p.membershipId);

    // Punches from a day either side of the window, so a shift that
    // crossed midnight into the first day (or out of the last) is seen.
    const from = zonedMidnight(start, tz);
    const toExclusive = zonedMidnight(addDays(end, 1), tz);
    const punchRows =
      ids.length === 0
        ? []
        : await this.db
            .select({
              membershipId: schema.timePunches.membershipId,
              type: schema.timePunches.type,
              at: schema.timePunches.at,
              locationId: schema.timePunches.locationId,
            })
            .from(schema.timePunches)
            .where(
              and(
                eq(schema.timePunches.businessId, businessId),
                inArray(schema.timePunches.membershipId, ids),
                gte(schema.timePunches.at, new Date(from.getTime() - 36 * 3_600_000)),
                lt(schema.timePunches.at, new Date(toExclusive.getTime() + 36 * 3_600_000)),
              ),
            )
            .orderBy(asc(schema.timePunches.at));
    const punchesOf = new Map<string, (Punch & { locationId: string | null })[]>();
    for (const p of punchRows) {
      const list = punchesOf.get(p.membershipId) ?? [];
      list.push({ type: p.type as PunchType, at: p.at, locationId: p.locationId });
      punchesOf.set(p.membershipId, list);
    }

    const now = Date.now();
    const out: TimeClockPerson[] = [];
    for (const m of people) {
      const punches = punchesOf.get(m.membershipId) ?? [];
      if (punches.length === 0) continue;
      const dayRows: TimeClockDay[] = [];
      for (const date of days) {
        const dayStart = zonedMidnight(date, tz);
        const dayEnd = zonedMidnight(addDays(date, 1), tz);
        // The day's own punches, and the hours of every segment that
        // overlaps the day (a segment opened yesterday still counts).
        const inDay = punches.filter((p) => p.at >= dayStart && p.at < dayEnd);
        const windowEnd = new Date(Math.min(dayEnd.getTime(), now));
        const workedMs = workedMsBetween(punches, dayStart, windowEnd);
        if (inDay.length === 0 && workedMs === 0) continue;
        const ins = inDay.filter((p) => p.type === 'clock_in');
        const outs = inDay.filter((p) => p.type === 'clock_out');
        // Still on the clock when the day closed: the last punch at or
        // before the day's end is not a clock_out.
        const lastBefore = [...punches].reverse().find((p) => p.at < dayEnd);
        const openAtEnd = lastBefore != null && lastBefore.type !== 'clock_out';
        dayRows.push({
          date,
          firstIn: ins[0] ? fmtLocal(ins[0].at, tz) : null,
          lastOut: outs.length > 0 ? fmtLocal(outs[outs.length - 1]!.at, tz) : null,
          breakMinutes: Math.round(breakMsBetween(punches, dayStart, windowEnd) / 60_000),
          hours: hoursFromMs(workedMs),
          openAtEnd: openAtEnd && (dayEnd.getTime() > now || outs.length === 0),
          punches: inDay.map((p) => ({
            type: p.type,
            at: fmtLocal(p.at, tz),
            locationName: p.locationId ? (locationName.get(p.locationId) ?? null) : null,
          })),
        });
      }
      if (dayRows.length === 0) continue;
      const stores = scopeOf.get(m.membershipId) ?? [];
      out.push({
        membershipId: m.membershipId,
        name: m.name ?? m.email ?? 'Member',
        roleName: m.roleName ?? null,
        locationName: stores[0]?.name ?? 'All locations',
        days: dayRows,
        daysWorked: dayRows.filter((d) => d.hours > 0).length,
        totalHours: Math.round(dayRows.reduce((s, d) => s + d.hours, 0) * 100) / 100,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));

    const report: TimeClockActivityReport = {
      generatedAt: new Date().toISOString(),
      range: { start, end },
      timezone: tz,
      people: out,
      totals: {
        people: out.length,
        daysWorked: out.reduce((s, p) => s + p.daysWorked, 0),
        hours: Math.round(out.reduce((s, p) => s + p.totalHours, 0) * 100) / 100,
      },
    };

    if (format === 'csv') {
      const headers = ['Member', 'Role', 'Store', 'Date', 'In', 'Out', 'Break (min)', 'Hours'];
      const data: (string | number | null)[][] = [];
      for (const p of out) {
        for (const d of p.days) {
          data.push([
            p.name,
            p.roleName ?? '',
            p.locationName,
            d.date,
            d.firstIn ? d.firstIn.slice(11) : '',
            d.lastOut ? d.lastOut.slice(11) : d.openAtEnd ? 'on the clock' : '',
            d.breakMinutes,
            d.hours,
          ]);
        }
        data.push([p.name, '', '', 'Total', '', '', '', p.totalHours]);
      }
      data.push(['All', '', '', 'Total', '', '', '', report.totals.hours]);
      const header = `# time-clock-activity start=${start} end=${end} tz=${tz} generated=${report.generatedAt}\n`;
      res!.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res!.setHeader(
        'Content-Disposition',
        `attachment; filename="time-clock-activity-${start}-to-${end}.csv"`,
      );
      res!.send(header + toCsv(headers, data));
      return;
    }
    return report;
  }
}
