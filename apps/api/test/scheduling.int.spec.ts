/**
 * Amendment A22 slice 5 — STORIS "Logistical Scheduling": Search for
 * schedules (sales orders / transfers / service orders) and Confirm
 * schedule (contact status, totals strip, T D F P OO flags).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.SCHEDULING_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_scheduling';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'SchedPass!2026';

let app: INestApplication;
let businessId = '';
let ownerCookie = '';
let cashierCookie = '';
let warehouseId = '';
let storeId = '';
let delivery1Id = '';
let delivery2Id = '';
let transfer2Id = '';
let manifestNumber = '';
let serviceId = '';
let service2Id = '';

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const TODAY = day(0);
const YESTERDAY = day(-1);
const TOMORROW = day(1);
const IN_THREE = day(3);
const IN_FORTY = day(40);

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

async function seed(): Promise<void> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({ slug: 'sched-test', name: 'Sched Test Co', status: 'active' })
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
    async function makeUser(email: string, role: string, name = role) {
      const [u] = await db
        .insert(schema.users)
        .values({ email, emailVerified: true, name })
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
        })
        .returning({ id: schema.memberships.id });
      return m!.id;
    }
    await makeUser('owner@sched-test.local', 'Owner');
    await makeUser('cashier@sched-test.local', 'Cashier');
    const driverMembershipId = await makeUser('driver@sched-test.local', 'Warehouse', 'Dan Driver');

    const loc = async (name: string, locationType: string) => {
      const [l] = await db
        .insert(schema.locations)
        .values({ businessId, name, timezone: 'America/Los_Angeles', locationType })
        .returning({ id: schema.locations.id });
      return l!.id;
    };
    warehouseId = await loc('Warehouse', 'warehouse');
    storeId = await loc('Culver City', 'store');

    const [vendor] = await db
      .insert(schema.vendors)
      .values({ businessId, name: 'Helix' })
      .returning({ id: schema.vendors.id });
    const [product] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'KING-SET', name: 'KING SET' })
      .returning({ id: schema.products.id });
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: product!.id,
        sku: 'KING-SET',
        priceCents: 50000,
        costCents: 20000,
        capacityUnits: 3,
      })
      .returning({ id: schema.productVariants.id });
    const variantId = variant!.id;

    const customer = async (firstName: string, lastName: string, phone: string) => {
      const [c] = await db
        .insert(schema.customers)
        .values({ businessId, firstName, lastName, phone })
        .returning({ id: schema.customers.id });
      return c!.id;
    };
    const janeId = await customer('Jane', 'Doe', '310-555-0100');
    const johnId = await customer('John', 'Roe', '626-555-0200');

    const order = async (
      number: string,
      customerId: string,
      extra: Partial<typeof schema.orders.$inferInsert>,
    ) => {
      const [o] = await db
        .insert(schema.orders)
        .values({
          businessId,
          locationId: storeId,
          stockLocationId: warehouseId,
          number,
          status: 'open',
          customerId,
          ...extra,
        })
        .returning({ id: schema.orders.id });
      return o!.id;
    };
    const line = async (orderId: string, quantity: number, qtyReserved: number) => {
      const [l] = await db
        .insert(schema.orderLines)
        .values({
          businessId,
          orderId,
          variantId,
          description: 'KING SET',
          quantity,
          qtyReserved,
          unitPriceCents: 50000,
          totalCents: 50000 * quantity,
        })
        .returning({ id: schema.orderLines.id });
      return l!.id;
    };
    const delivery = async (
      orderId: string,
      locationId: string,
      extra: Partial<typeof schema.deliveries.$inferInsert>,
      lines: { orderLineId: string; quantity: number }[],
    ) => {
      const [d] = await db
        .insert(schema.deliveries)
        .values({ businessId, locationId, orderId, scheduledDate: TODAY, ...extra })
        .returning({ id: schema.deliveries.id });
      await db
        .insert(schema.deliveryLines)
        .values(lines.map((l) => ({ businessId, deliveryId: d!.id, ...l })));
      return d!.id;
    };

    // SO-1: ticket printed, half paid, fully reserved, pick list printed,
    // on Dan's West run in Box 1.
    const so1 = await order('SO-1', janeId, {
      totalCents: 100000,
      ticketPrintCount: 1,
      addressCity: 'Culver City',
      addressPostalCode: '90230',
    });
    const l1 = await line(so1, 2, 2);
    await db.insert(schema.payments).values({
      businessId,
      orderId: so1,
      method: 'cash',
      amountCents: 40000,
      status: 'succeeded',
    });
    const [run] = await db
      .insert(schema.deliveryRuns)
      .values({
        businessId,
        locationId: warehouseId,
        runDate: TODAY,
        route: 'West',
        truck: 'Box 1',
        driverMembershipId,
      })
      .returning({ id: schema.deliveryRuns.id });
    delivery1Id = await delivery(
      so1,
      warehouseId,
      {
        windowStart: '09:00',
        windowEnd: '12:00',
        routePosition: 1,
        runId: run!.id,
        driverMembershipId,
        pickListFlag: 'P',
      },
      [{ orderLineId: l1, quantity: 2 }],
    );

    // SO-2: nothing paid, not reserved, waiting on a PO, confirmed by phone,
    // its own East route from the store.
    const so2 = await order('SO-2', johnId, {
      totalCents: 50000,
      addressCity: 'Pasadena',
      addressPostalCode: '91101',
      addressPhone: '626-555-0999',
    });
    const l2 = await line(so2, 1, 0);
    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        businessId,
        vendorId: vendor!.id,
        locationId: warehouseId,
        number: 'PO-1',
        status: 'ordered',
        placedAt: new Date(),
      })
      .returning({ id: schema.purchaseOrders.id });
    const [poLine] = await db
      .insert(schema.purchaseOrderLines)
      .values({
        businessId,
        purchaseOrderId: po!.id,
        variantId,
        quantityOrdered: 1,
        unitCostCents: 20000,
        lineTotalCents: 20000,
      })
      .returning({ id: schema.purchaseOrderLines.id });
    await db.insert(schema.poLineAllocations).values({
      businessId,
      poLineId: poLine!.id,
      orderLineId: l2,
      quantity: 1,
      status: 'ordered',
    });
    delivery2Id = await delivery(
      so2,
      storeId,
      { route: 'East', routePosition: 2, contactStatus: 'confirmed', contactedAt: new Date() },
      [{ orderLineId: l2, quantity: 1 }],
    );

    // SO-3 delivered yesterday; SO-4 forty days out.
    const so3 = await order('SO-3', janeId, { totalCents: 30000, status: 'fulfilled' });
    const l3 = await line(so3, 1, 0);
    await delivery(
      so3,
      warehouseId,
      { scheduledDate: YESTERDAY, status: 'delivered', completedAt: new Date() },
      [{ orderLineId: l3, quantity: 1 }],
    );
    const so4 = await order('SO-4', johnId, { totalCents: 20000 });
    const l4 = await line(so4, 1, 1);
    await delivery(so4, warehouseId, { scheduledDate: IN_FORTY }, [
      { orderLineId: l4, quantity: 1 },
    ]);

    // Transfers: T1 scheduled tomorrow on the West route; T2 rides a
    // manifest (its date comes from the manifest) in Truck A.
    const [t1] = await db
      .insert(schema.stockTransfers)
      .values({
        businessId,
        fromLocationId: warehouseId,
        toLocationId: storeId,
        number: 'TR-1',
        status: 'draft',
        scheduledFor: TOMORROW,
        route: 'West',
      })
      .returning({ id: schema.stockTransfers.id });
    await db.insert(schema.stockTransferLines).values({
      businessId,
      transferId: t1!.id,
      variantId,
      quantityShipped: 3,
      quantityOrdered: 4,
    });
    const [manifest] = await db
      .insert(schema.stockManifests)
      .values({
        businessId,
        fromLocationId: warehouseId,
        toLocationId: storeId,
        number: 'MF-1',
        manifestDate: IN_THREE,
        routeName: 'Truck A',
      })
      .returning({ id: schema.stockManifests.id, number: schema.stockManifests.number });
    manifestNumber = manifest!.number;
    const [t2] = await db
      .insert(schema.stockTransfers)
      .values({
        businessId,
        fromLocationId: warehouseId,
        toLocationId: storeId,
        number: 'TR-2',
        status: 'in_transit',
        manifestId: manifest!.id,
      })
      .returning({ id: schema.stockTransfers.id });
    transfer2Id = t2!.id;
    await db.insert(schema.stockTransferLines).values({
      businessId,
      transferId: t2!.id,
      variantId,
      quantityShipped: 2,
    });

    // Service calls: SV-1 booked in two days with Dan; SV-2 not booked.
    const [sv1] = await db
      .insert(schema.serviceOrders)
      .values({
        businessId,
        locationId: storeId,
        number: 'SV-1',
        customerId: janeId,
        itemDescription: 'Adjustable base',
        issue: 'Motor hum',
        scheduledFor: day(2),
        technicianMembershipId: driverMembershipId,
        totalCents: 12000,
      })
      .returning({ id: schema.serviceOrders.id });
    serviceId = sv1!.id;
    const [sv2] = await db
      .insert(schema.serviceOrders)
      .values({
        businessId,
        locationId: storeId,
        number: 'SV-2',
        customerId: johnId,
        itemDescription: 'Pillow',
        issue: 'Seam',
      })
      .returning({ id: schema.serviceOrders.id });
    service2Id = sv2!.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function captureCookie(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .send({ email, password: PASSWORD })
    .expect(200);
  const cookies = res.get('Set-Cookie') ?? [];
  const sessionCookie = cookies
    .map((c) => c.split(';')[0])
    .filter((c): c is string => Boolean(c?.startsWith('jetnine.session_token=')))
    .find((c) => !c.endsWith('='));
  if (!sessionCookie) throw new Error(`no session cookie for ${email}`);
  return sessionCookie;
}

const as = (cookie: string) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', cookie).set('X-Business-Id', businessId),
  patch: (url: string) =>
    request(app.getHttpServer()).patch(url).set('Cookie', cookie).set('X-Business-Id', businessId),
});

interface Row {
  kind: string;
  id: string;
  number: string;
  date: string;
  route: string | null;
  truck: string | null;
  crewName: string | null;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  postalCode: string | null;
  units: number;
  dollarsCents: number;
  balanceDueCents: number | null;
  volume: number;
  status: string;
  contactStatus: string | null;
  toLocationName: string | null;
}
async function search(qs: string): Promise<{ rows: Row[]; totals: Record<string, number> }> {
  const res = await as(ownerCookie).get(`/v1/scheduling/search?${qs}`).expect(200);
  return res.body;
}

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'sched-test-secret-sched-test-secret-!!';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.WEB_BASE_URL ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();
  ownerCookie = await captureCookie('owner@sched-test.local');
  cashierCookie = await captureCookie('cashier@sched-test.local');
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('Search for schedules — sales orders', () => {
  it('lists the open stops from today with route, truck, driver, contact and the totals strip', async () => {
    const r = await search('kind=orders');
    expect(r.rows.map((x) => x.number)).toEqual(['SO-1', 'SO-2']);
    expect(r.rows[0]).toMatchObject({
      kind: 'order',
      id: delivery1Id,
      date: TODAY,
      route: 'West',
      truck: 'Box 1',
      crewName: 'Dan Driver',
      customerName: 'Jane Doe',
      phone: '310-555-0100',
      city: 'Culver City',
      postalCode: '90230',
      units: 2,
      dollarsCents: 100000,
      balanceDueCents: 60000,
      volume: 6,
      contactStatus: null,
    });
    // The order's own phone beats the customer's; the delivery's own route beats the run's.
    expect(r.rows[1]).toMatchObject({
      route: 'East',
      truck: null,
      phone: '626-555-0999',
      contactStatus: 'confirmed',
      units: 1,
      volume: 3,
    });
    expect(r.totals).toEqual({ stops: 2, units: 3, dollarsCents: 150000, volume: 9 });
  });

  it('filters by route, truck, deliver-from location, past dates and status; rejects bad dates', async () => {
    expect((await search('kind=orders&route=east')).rows.map((x) => x.number)).toEqual(['SO-2']);
    expect((await search('kind=orders&truck=box')).rows.map((x) => x.number)).toEqual(['SO-1']);
    expect((await search(`kind=orders&locationId=${storeId}`)).rows.map((x) => x.number)).toEqual([
      'SO-2',
    ]);
    // Delivered yesterday: hidden by default, shown with past dates + status.
    expect((await search('kind=orders&includePast=1')).rows.map((x) => x.number)).toEqual([
      'SO-1',
      'SO-2',
    ]);
    expect(
      (await search('kind=orders&includePast=1&status=delivered')).rows.map((x) => x.number),
    ).toEqual(['SO-3']);
    // Forty days out sits past the default 35-day window.
    expect((await search(`kind=orders&end=${IN_FORTY}`)).rows.map((x) => x.number)).toEqual([
      'SO-1',
      'SO-2',
      'SO-4',
    ]);
    expect((await search('kind=orders&contactStatus=confirmed')).rows.map((x) => x.number)).toEqual(
      ['SO-2'],
    );
    await as(ownerCookie).get('/v1/scheduling/search?kind=orders&start=09/11/2026').expect(400);
    await as(ownerCookie).get('/v1/scheduling/search?kind=bogus').expect(400);
  });
});

describe('Search for schedules — transfers and service orders', () => {
  it('transfers: scheduled date or manifest date, route / truck / transfer-to filters, units and volume', async () => {
    const r = await search('kind=transfers');
    expect(r.rows.map((x) => x.number)).toEqual(['TR-1', 'TR-2']);
    expect(r.rows[0]).toMatchObject({
      kind: 'transfer',
      date: TOMORROW,
      route: 'West',
      toLocationName: 'Culver City',
      units: 4,
      volume: 12,
      dollarsCents: 0,
      balanceDueCents: null,
    });
    expect(r.rows[1]).toMatchObject({
      id: transfer2Id,
      date: IN_THREE,
      route: 'Truck A',
      truck: 'Truck A',
      customerName: `Manifest ${manifestNumber}`,
      units: 2,
      status: 'in_transit',
    });
    expect(r.totals).toMatchObject({ stops: 2, units: 6, volume: 18 });
    expect((await search('kind=transfers&truck=truck a')).rows.map((x) => x.number)).toEqual([
      'TR-2',
    ]);
    expect((await search(`kind=transfers&toLocationId=${warehouseId}`)).rows).toEqual([]);
    expect(
      (await search(`kind=transfers&locationId=${warehouseId}&toLocationId=${storeId}`)).rows,
    ).toHaveLength(2);
  });

  it('service orders: only booked calls, with the technician; booking goes through the service order patch', async () => {
    const r = await search('kind=service');
    expect(r.rows.map((x) => x.number)).toEqual(['SV-1']);
    expect(r.rows[0]).toMatchObject({
      kind: 'service',
      id: serviceId,
      date: day(2),
      crewName: 'Dan Driver',
      customerName: 'Jane Doe',
      phone: '310-555-0100',
      dollarsCents: 12000,
      units: 1,
    });
    await as(ownerCookie)
      .patch(`/v1/service-orders/${service2Id}`)
      .send({ scheduledFor: 'next week' })
      .expect(400);
    await as(ownerCookie)
      .patch(`/v1/service-orders/${service2Id}`)
      .send({ scheduledFor: day(5) })
      .expect(200);
    expect((await search('kind=service')).rows.map((x) => x.number)).toEqual(['SV-1', 'SV-2']);
  });
});

describe('Confirm schedule', () => {
  it("shows the day's stops with the flags, totals and contact status", async () => {
    const res = await as(ownerCookie).get(`/v1/scheduling/confirm?date=${TODAY}`).expect(200);
    const rows = res.body.rows as {
      orderNumber: string;
      flags: Record<string, boolean>;
      balanceDueCents: number;
      contactStatus: string | null;
      truck: string | null;
      driverName: string | null;
      postalCode: string | null;
    }[];
    expect(rows.map((r) => r.orderNumber)).toEqual(['SO-1', 'SO-2']);
    expect(rows[0]).toMatchObject({
      flags: { T: true, D: true, F: true, P: true, OO: false },
      balanceDueCents: 60000,
      truck: 'Box 1',
      driverName: 'Dan Driver',
      postalCode: '90230',
    });
    expect(rows[1]).toMatchObject({
      flags: { T: false, D: true, F: false, P: false, OO: true },
      balanceDueCents: 50000,
      contactStatus: 'confirmed',
    });
    expect(res.body.totals).toEqual({
      stops: 2,
      units: 3,
      dollarsCents: 150000,
      volume: 9,
      confirmed: 1,
    });
    // Filters: not called / confirmed / a past day's delivered stops / route.
    const none = await as(ownerCookie)
      .get(`/v1/scheduling/confirm?date=${TODAY}&contactStatus=none`)
      .expect(200);
    expect(none.body.rows.map((r: { orderNumber: string }) => r.orderNumber)).toEqual(['SO-1']);
    const confirmed = await as(ownerCookie)
      .get(`/v1/scheduling/confirm?date=${TODAY}&contactStatus=confirmed,left_message`)
      .expect(200);
    expect(confirmed.body.rows.map((r: { orderNumber: string }) => r.orderNumber)).toEqual([
      'SO-2',
    ]);
    const delivered = await as(ownerCookie)
      .get(`/v1/scheduling/confirm?date=${YESTERDAY}&deliveryStatus=delivered`)
      .expect(200);
    expect(delivered.body.rows.map((r: { orderNumber: string }) => r.orderNumber)).toEqual([
      'SO-3',
    ]);
    const west = await as(ownerCookie)
      .get(`/v1/scheduling/confirm?date=${TODAY}&route=west`)
      .expect(200);
    expect(west.body.rows.map((r: { orderNumber: string }) => r.orderNumber)).toEqual(['SO-1']);
    await as(ownerCookie)
      .get(`/v1/scheduling/confirm?date=${TODAY}&contactStatus=bogus`)
      .expect(400);
  });

  it('records the confirmation call on the delivery', async () => {
    const set = await as(ownerCookie)
      .patch(`/v1/deliveries/${delivery1Id}/contact`)
      .send({ contactStatus: 'left_message', notes: 'voicemail 9:10' })
      .expect(200);
    expect(set.body.contactStatus).toBe('left_message');
    expect(set.body.contactedAt).toBeTruthy();
    const board = await as(ownerCookie).get(`/v1/scheduling/confirm?date=${TODAY}`).expect(200);
    expect(board.body.rows[0].contactStatus).toBe('left_message');
    await as(ownerCookie)
      .patch(`/v1/deliveries/${delivery1Id}/contact`)
      .send({ contactStatus: 'texted' })
      .expect(400);
    const cleared = await as(ownerCookie)
      .patch(`/v1/deliveries/${delivery1Id}/contact`)
      .send({ contactStatus: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ contactStatus: null, contactedAt: null });
    await as(cashierCookie)
      .patch(`/v1/deliveries/${delivery2Id}/contact`)
      .send({ contactStatus: 'confirmed' })
      .expect(403);
  });
});
