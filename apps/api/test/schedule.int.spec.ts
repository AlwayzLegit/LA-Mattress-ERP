/**
 * Staff schedule + time clock (owner hand-off 2026-09-10, step 2).
 *
 * - Owner and Operations set shifts and publish the week; Manager,
 *   Cashier and Warehouse read the schedule and punch their own clock.
 * - A set or cleared shift is an unpublished change until the week is
 *   published; clearing a published shift leaves a pending day off that
 *   is counted, then dropped on publish.
 * - A store's grid lists the members with access to it; "All locations"
 *   lists everyone.
 * - Punches only move the status forward (clock in → break → clock out);
 *   hours are derived; every punch is audited.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.SCHEDULE_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_schedule';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'Schedule!2026x';
const TZ = 'America/Los_Angeles';

type Who = 'owner' | 'ops' | 'manager' | 'rep' | 'wh';
let app: INestApplication;
let businessId = '';
let aStoreId = '';
let bStoreId = '';
const cookies: Record<Who, string> = { owner: '', ops: '', manager: '', rep: '', wh: '' };
const members: Record<Who, string> = { owner: '', ops: '', manager: '', rep: '', wh: '' };

const localDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  return fn(db).finally(() => sql.end({ timeout: 5 }));
}

async function resetTestDb() {
  const env = { ...process.env, DATABASE_URL: TEST_DB_URL };
  execFileSync('pnpm', ['exec', 'tsx', 'src/reset.ts'], {
    cwd: dbPackageRoot,
    env,
    stdio: 'inherit',
  });
  execFileSync('pnpm', ['exec', 'tsx', 'src/migrate.ts'], {
    cwd: dbPackageRoot,
    env,
    stdio: 'inherit',
  });
}

async function seed() {
  await withDb(async (db) => {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'schedule-test', name: 'Schedule Test Co', status: 'active' })
      .returning();
    businessId = biz!.id;

    const roles = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      const [r] = await db
        .insert(schema.roles)
        .values({ businessId, name: role.name, description: role.description, isSystem: true })
        .returning();
      roles.set(role.name, r!.id);
      if (role.permissions.length > 0) {
        await db
          .insert(schema.rolePermissions)
          .values(role.permissions.map((permission) => ({ roleId: r!.id, permission })));
      }
    }
    const locs = await db
      .insert(schema.locations)
      .values([
        { businessId, name: 'A Store', timezone: TZ },
        { businessId, name: 'B Store', timezone: TZ },
      ])
      .returning();
    aStoreId = locs[0]!.id;
    bStoreId = locs[1]!.id;

    async function makeUser(key: Who, name: string, role: string, scope: string[] = []) {
      const [u] = await db
        .insert(schema.users)
        .values({ email: `${key}@schedule-test.local`, emailVerified: true, name })
        .returning();
      await db.insert(schema.accounts).values({
        accountId: u!.id,
        providerId: 'credential',
        userId: u!.id,
        password: passwordHash,
      });
      const [m] = await db
        .insert(schema.memberships)
        .values({
          businessId,
          userId: u!.id,
          roleId: roles.get(role)!,
          status: 'active',
          acceptedAt: new Date(),
          sellingScope: scope.length > 0 ? 'approved' : 'all',
        })
        .returning();
      members[key] = m!.id;
      for (const locationId of scope) {
        await db
          .insert(schema.membershipLocationScopes)
          .values({ businessId, membershipId: m!.id, locationId });
      }
    }
    await makeUser('owner', 'Olive Owner', 'Owner');
    await makeUser('ops', 'Dana Whitmore', 'Operations');
    await makeUser('manager', 'Maya Torres', 'Manager', [aStoreId]);
    await makeUser('rep', 'Priya Nair', 'Cashier', [aStoreId]);
    await makeUser('wh', 'Walt House', 'Warehouse');
  });
}

async function captureCookie(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .send({ email, password: PASSWORD })
    .expect(200);
  const found = (res.get('Set-Cookie') ?? [])
    .map((c) => c.split(';')[0])
    .filter((c): c is string => Boolean(c?.startsWith('jetnine.session_token=')))
    .find((c) => !c.endsWith('='));
  if (!found) throw new Error(`no session cookie for ${email}`);
  return found;
}

const as = (who: Who) => {
  const base = (m: 'get' | 'put' | 'post') => (path: string) =>
    request(app.getHttpServer())
      [m](path)
      .set('Cookie', cookies[who])
      .set('x-business-id', businessId);
  return { get: base('get'), put: base('put'), post: base('post') };
};

interface Person {
  membershipId: string;
  name: string;
  roleName: string | null;
  locationName: string;
  isLead: boolean;
  shifts: {
    date: string;
    startMinutes: number | null;
    endMinutes: number | null;
    published: boolean;
  }[];
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'schedule-secret-schedule-secret-xxxxxxx';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();
  for (const who of ['owner', 'ops', 'manager', 'rep', 'wh'] as const) {
    cookies[who] = await captureCookie(`${who}@schedule-test.local`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('the schedule permissions', () => {
  it('let Owner and Operations edit, everyone read and punch', () => {
    const perms = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!.permissions;
    expect(perms('Owner')).toContain('schedule.edit');
    expect(perms('Operations')).toContain('schedule.edit');
    for (const role of ['Manager', 'Cashier', 'Warehouse']) {
      expect(perms(role)).not.toContain('schedule.edit');
      expect(perms(role)).toContain('schedule.view');
      expect(perms(role)).toContain('timeclock.punch');
    }
  });
});

describe('GET /v1/schedule', () => {
  it('shows this week, Monday to Sunday, to a read-only unrestricted member', async () => {
    const res = await as('wh').get('/v1/schedule').expect(200);
    expect(res.body.canEdit).toBe(false);
    expect(res.body.today).toBe(localDay());
    expect(res.body.week.days).toHaveLength(7);
    expect(res.body.week.days.map((d: { dow: string }) => d.dow)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    expect(new Date(`${res.body.week.start}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(res.body.week.days.some((d: { isToday: boolean }) => d.isToday)).toBe(true);
    expect(res.body.locations.map((l: { name: string }) => l.name)).toEqual(['A Store', 'B Store']);
    const names = (res.body.people as Person[]).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Maya Torres', 'Priya Nair', 'Walt House']));
    const maya = (res.body.people as Person[]).find((p) => p.name === 'Maya Torres')!;
    expect(maya).toMatchObject({ roleName: 'Manager', locationName: 'A Store', isLead: true });
    const walt = (res.body.people as Person[]).find((p) => p.name === 'Walt House')!;
    expect(walt).toMatchObject({ locationName: 'All locations', isLead: false });
    expect(res.body.unpublishedCount).toBe(0);
  });

  it('cuts a store-restricted member down to their own locations', async () => {
    // The manager's access lists A Store only: no B Store in the picker,
    // no B Store people, and asking for B Store outright is refused.
    const res = await as('manager').get('/v1/schedule').expect(200);
    expect(res.body.canEdit).toBe(false);
    expect(res.body.locations.map((l: { name: string }) => l.name)).toEqual(['A Store']);
    expect((res.body.people as Person[]).map((p) => p.name).sort()).toEqual([
      'Maya Torres',
      'Priya Nair',
    ]);
    const a = await as('manager').get(`/v1/schedule?locationId=${aStoreId}`).expect(200);
    expect((a.body.people as Person[]).map((p) => p.name).sort()).toEqual([
      'Maya Torres',
      'Priya Nair',
    ]);
    await as('manager').get(`/v1/schedule?locationId=${bStoreId}`).expect(403);
    await as('rep').get(`/v1/schedule?locationId=${bStoreId}`).expect(403);
  });

  it('narrows a store to the members with access to it', async () => {
    const res = await as('owner').get(`/v1/schedule?locationId=${aStoreId}`).expect(200);
    expect(res.body.canEdit).toBe(true);
    expect((res.body.people as Person[]).map((p) => p.name).sort()).toEqual([
      'Maya Torres',
      'Priya Nair',
    ]);
    const b = await as('owner').get(`/v1/schedule?locationId=${bStoreId}`).expect(200);
    expect(b.body.people).toEqual([]);
  });
});

describe('shift editing and publishing', () => {
  let monday = '';
  const shiftOf = (people: Person[], name: string, date: string) =>
    people.find((p) => p.name === name)!.shifts.find((s) => s.date === date);

  it('is refused to a manager and a cashier', async () => {
    const week = await as('owner').get('/v1/schedule').expect(200);
    monday = week.body.week.start;
    const body = { membershipId: members.rep, date: monday, startMinutes: 540, endMinutes: 1020 };
    await as('manager').put('/v1/schedule/shifts').send(body).expect(403);
    await as('rep').put('/v1/schedule/shifts').send(body).expect(403);
    await as('rep').post('/v1/schedule/publish').send({ week: monday }).expect(403);
  });

  it('validates the shift', async () => {
    await as('ops')
      .put('/v1/schedule/shifts')
      .send({ membershipId: members.rep, date: monday, startMinutes: 1020, endMinutes: 540 })
      .expect(400);
    await as('ops')
      .put('/v1/schedule/shifts')
      .send({ membershipId: members.rep, date: monday, startMinutes: -5, endMinutes: 540 })
      .expect(400);
    await as('ops')
      .put('/v1/schedule/shifts')
      .send({ membershipId: members.rep, date: 'yesterday', startMinutes: 540, endMinutes: 1020 })
      .expect(400);
    await as('ops')
      .put('/v1/schedule/shifts')
      .send({
        membershipId: '00000000-0000-4000-8000-000000000000',
        date: monday,
        startMinutes: 540,
        endMinutes: 1020,
      })
      .expect(404);
  });

  it('sets a draft shift Operations can see as unpublished', async () => {
    const set = await as('ops')
      .put('/v1/schedule/shifts')
      .send({ membershipId: members.rep, date: monday, startMinutes: 540, endMinutes: 1020 })
      .expect(200);
    expect(set.body).toMatchObject({
      date: monday,
      startMinutes: 540,
      endMinutes: 1020,
      published: false,
    });

    const res = await as('ops').get('/v1/schedule').expect(200);
    expect(shiftOf(res.body.people, 'Priya Nair', monday)).toMatchObject({
      startMinutes: 540,
      endMinutes: 1020,
      published: false,
    });
    expect(res.body.unpublishedCount).toBe(1);
    // The shift inherits the member's store, so the store grid shows it too.
    const a = await as('ops').get(`/v1/schedule?locationId=${aStoreId}`).expect(200);
    expect(shiftOf(a.body.people, 'Priya Nair', monday)).toBeTruthy();
  });

  it('drops an unpublished draft on day off, keeps a pending day off for a published shift', async () => {
    const off = await as('ops')
      .post('/v1/schedule/shifts/off')
      .send({ membershipId: members.rep, date: monday })
      .expect(201);
    expect(off.body.pending).toBe(false);
    let res = await as('ops').get('/v1/schedule').expect(200);
    expect(shiftOf(res.body.people, 'Priya Nair', monday)).toBeUndefined();
    expect(res.body.unpublishedCount).toBe(0);

    await as('ops')
      .put('/v1/schedule/shifts')
      .send({ membershipId: members.rep, date: monday, startMinutes: 600, endMinutes: 1080 })
      .expect(200);
    const pub = await as('owner').post('/v1/schedule/publish').send({ week: monday }).expect(201);
    expect(pub.body).toMatchObject({ published: 1, removed: 0, week: { start: monday } });
    res = await as('manager').get('/v1/schedule').expect(200);
    expect(shiftOf(res.body.people, 'Priya Nair', monday)).toMatchObject({
      startMinutes: 600,
      endMinutes: 1080,
      published: true,
    });
    expect(res.body.unpublishedCount).toBe(0);
    expect(res.body.lastPublishedAt).toBeTruthy();

    const off2 = await as('ops')
      .post('/v1/schedule/shifts/off')
      .send({ membershipId: members.rep, date: monday })
      .expect(201);
    expect(off2.body.pending).toBe(true);
    res = await as('ops').get('/v1/schedule').expect(200);
    expect(shiftOf(res.body.people, 'Priya Nair', monday)).toMatchObject({
      startMinutes: null,
      endMinutes: null,
      published: false,
    });
    expect(res.body.unpublishedCount).toBe(1);

    const pub2 = await as('ops').post('/v1/schedule/publish').send({ week: monday }).expect(201);
    expect(pub2.body).toMatchObject({ published: 0, removed: 1 });
    res = await as('ops').get('/v1/schedule').expect(200);
    expect(shiftOf(res.body.people, 'Priya Nair', monday)).toBeUndefined();

    const audits = await withDb((db) =>
      db
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'schedule.publish')),
    );
    expect(audits).toHaveLength(2);
  });
});

describe('the time clock', () => {
  it('starts clocked out with today’s shift, and only moves forward', async () => {
    const today = localDay();
    await as('ops')
      .put('/v1/schedule/shifts')
      .send({ membershipId: members.rep, date: today, startMinutes: 540, endMinutes: 1020 })
      .expect(200);

    let me = await as('rep').get('/v1/timeclock/me').expect(200);
    expect(me.body).toMatchObject({
      date: today,
      status: 'out',
      since: null,
      hoursToday: 0,
      hoursWeek: 0,
      allowed: ['clock_in'],
      scheduledToday: { startMinutes: 540, endMinutes: 1020 },
    });
    expect(me.body.member).toMatchObject({
      name: 'Priya Nair',
      roleName: 'Cashier',
      locationName: 'A Store',
    });
    expect(me.body.punchesToday).toEqual([]);

    await as('rep').post('/v1/timeclock/punch').send({ type: 'break_end' }).expect(400);
    await as('rep').post('/v1/timeclock/punch').send({ type: 'nap' }).expect(400);

    me = await as('rep').post('/v1/timeclock/punch').send({ type: 'clock_in' }).expect(201);
    expect(me.body.status).toBe('in');
    expect(me.body.since).toBeTruthy();
    expect(me.body.allowed).toEqual(['break_start', 'clock_out']);
    expect(me.body.punched.type).toBe('clock_in');
    await as('rep').post('/v1/timeclock/punch').send({ type: 'clock_in' }).expect(400);

    me = await as('rep').post('/v1/timeclock/punch').send({ type: 'break_start' }).expect(201);
    expect(me.body.status).toBe('break');
    expect(me.body.allowed).toEqual(['break_end']);
    await as('rep').post('/v1/timeclock/punch').send({ type: 'clock_out' }).expect(400);

    me = await as('rep').post('/v1/timeclock/punch').send({ type: 'break_end' }).expect(201);
    expect(me.body.status).toBe('in');
    me = await as('rep').post('/v1/timeclock/punch').send({ type: 'clock_out' }).expect(201);
    expect(me.body.status).toBe('out');
    expect(me.body.punchesToday.map((p: { type: string }) => p.type)).toEqual([
      'clock_in',
      'break_start',
      'break_end',
      'clock_out',
    ]);
    expect(me.body.hoursToday).toBeGreaterThanOrEqual(0);
    expect(me.body.hoursToday).toBeLessThan(0.1);
    expect(me.body.hoursWeek).toBe(me.body.hoursToday);

    const audits = await withDb((db) =>
      db
        .select({ action: schema.auditLogs.action, targetId: schema.auditLogs.targetId })
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'timeclock.punch')),
    );
    expect(audits).toHaveLength(4);
    expect(audits.every((a) => a.targetId === members.rep)).toBe(true);
  });

  it('works for an unscoped member and is each member’s own', async () => {
    const wh = await as('wh').get('/v1/timeclock/me').expect(200);
    expect(wh.body.member.locationName).toBe('All locations');
    expect(wh.body.status).toBe('out');
    expect(wh.body.punchesToday).toEqual([]);
    const mgr = await as('manager')
      .post('/v1/timeclock/punch')
      .send({ type: 'clock_in' })
      .expect(201);
    expect(mgr.body.member.name).toBe('Maya Torres');
    const rep = await as('rep').get('/v1/timeclock/me').expect(200);
    expect(rep.body.status).toBe('out');
  });
});

describe('GET /v1/timeclock/activity (owner 2026-11-04, Report Time Clock Activity)', () => {
  /** The UTC instant of `HH:MM` on `day` on the store's wall clock. */
  function storeTime(day: string, hhmm: string): Date {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const wall = (at: number) => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(new Date(at));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    };
    const first = guess - (wall(guess) - guess);
    return new Date(first - (wall(first) - guess));
  }
  const shiftDay = (n: number) => {
    const d = new Date(`${localDay()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const yesterday = shiftDay(-1);
  const twoAgo = shiftDay(-2);
  const threeAgo = shiftDay(-3);

  beforeAll(async () => {
    await withDb(async (db) => {
      // Priya: a plain day at A Store yesterday, half an hour of break.
      await db.insert(schema.timePunches).values(
        (
          [
            ['clock_in', '09:00'],
            ['break_start', '12:00'],
            ['break_end', '12:30'],
            ['clock_out', '17:00'],
          ] as const
        ).map(([type, at]) => ({
          businessId,
          membershipId: members.rep,
          locationId: aStoreId,
          type,
          at: storeTime(yesterday, at),
        })),
      );
      // Walt (no store): a night shift that crosses midnight two nights ago.
      await db.insert(schema.timePunches).values([
        {
          businessId,
          membershipId: members.wh,
          type: 'clock_in',
          at: storeTime(threeAgo, '22:00'),
        },
        { businessId, membershipId: members.wh, type: 'clock_out', at: storeTime(twoAgo, '02:00') },
      ]);
    });
  });

  it('is for managers, Operations, the owner and the books — not the floor', () => {
    const perms = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!.permissions;
    for (const role of ['Owner', 'Manager', 'Operations', 'Bookkeeper']) {
      expect(perms(role), role).toContain('timeclock.report');
    }
    for (const role of ['Cashier', 'Warehouse']) {
      expect(perms(role), role).not.toContain('timeclock.report');
    }
  });

  it('refuses a cashier', async () => {
    await as('rep').get(`/v1/timeclock/activity?start=${yesterday}&end=${yesterday}`).expect(403);
  });

  it('lists a day per member with in, out, break and hours', async () => {
    const res = await as('owner')
      .get(`/v1/timeclock/activity?start=${yesterday}&end=${yesterday}`)
      .expect(200);
    expect(res.body.range).toEqual({ start: yesterday, end: yesterday });
    expect(res.body.timezone).toBe(TZ);
    const priya = res.body.people.find(
      (p: { membershipId: string }) => p.membershipId === members.rep,
    );
    expect(priya).toBeTruthy();
    expect(priya.name).toBe('Priya Nair');
    expect(priya.locationName).toBe('A Store');
    expect(priya.days).toHaveLength(1);
    expect(priya.days[0]).toMatchObject({
      date: yesterday,
      firstIn: `${yesterday}T09:00`,
      lastOut: `${yesterday}T17:00`,
      breakMinutes: 30,
      hours: 7.5,
      openAtEnd: false,
    });
    expect(priya.days[0].punches.map((p: { type: string }) => p.type)).toEqual([
      'clock_in',
      'break_start',
      'break_end',
      'clock_out',
    ]);
    expect(priya.days[0].punches[0].locationName).toBe('A Store');
    expect(priya.totalHours).toBe(7.5);
    expect(priya.daysWorked).toBe(1);
    // Walt's night shift was two nights ago, outside this window.
    expect(
      res.body.people.some((p: { membershipId: string }) => p.membershipId === members.wh),
    ).toBe(false);
    expect(res.body.totals).toEqual({ people: 1, daysWorked: 1, hours: 7.5 });
  });

  it('splits a shift that crosses midnight at store midnight', async () => {
    const res = await as('owner')
      .get(`/v1/timeclock/activity?start=${threeAgo}&end=${twoAgo}`)
      .expect(200);
    const walt = res.body.people.find(
      (p: { membershipId: string }) => p.membershipId === members.wh,
    );
    expect(walt).toBeTruthy();
    expect(walt.locationName).toBe('All locations');
    expect(walt.days).toHaveLength(2);
    expect(walt.days[0]).toMatchObject({
      date: threeAgo,
      firstIn: `${threeAgo}T22:00`,
      lastOut: null,
      hours: 2,
      openAtEnd: true,
    });
    expect(walt.days[1]).toMatchObject({
      date: twoAgo,
      firstIn: null,
      lastOut: `${twoAgo}T02:00`,
      hours: 2,
      openAtEnd: false,
    });
    expect(walt.totalHours).toBe(4);
  });

  it('shows a store-scoped manager their own store’s people only', async () => {
    const res = await as('manager')
      .get(`/v1/timeclock/activity?start=${threeAgo}&end=${yesterday}`)
      .expect(200);
    const ids = res.body.people.map((p: { membershipId: string }) => p.membershipId);
    expect(ids).toContain(members.rep);
    expect(ids).not.toContain(members.wh);
  });

  it('filters to one member and exports CSV', async () => {
    const one = await as('owner')
      .get(`/v1/timeclock/activity?start=${threeAgo}&end=${yesterday}&membershipId=${members.wh}`)
      .expect(200);
    expect(one.body.people.map((p: { membershipId: string }) => p.membershipId)).toEqual([
      members.wh,
    ]);
    const csv = await as('owner')
      .get(`/v1/timeclock/activity?start=${yesterday}&end=${yesterday}&format=csv`)
      .expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Priya Nair');
    expect(csv.text).toContain(`${yesterday},09:00,17:00,30,7.5`);
  });
});
