/**
 * A20 — Enter a Sales Order: every STORIS section and action (PLAN-POS-
 * OPERATIONS §12.16). The order/line header fields, attachments, the
 * multi-line discount, line split, remove-overrides, tax info, costed
 * lines, the commission table, linked documents, stock availability and
 * the product card — plus the customer's work phone.
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
  process.env.ORDER_ACTIONS_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_order_actions';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'ActionsPass!2026';

let app: INestApplication;
let businessId = '';
let locationId = '';
let customerId = '';
let sofaVariantId = '';
let cashierMembershipId = '';
let ownerCookie = '';
let cashierCookie = '';
let orderId = '';
let sofaLineId = '';
let feeLineId = '';

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
      .values({
        slug: 'actions-test',
        name: 'Actions Test Co',
        status: 'active',
        defaultTaxRateBps: 700,
      })
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
    const [plan] = await db
      .insert(schema.commissionPlans)
      .values({ businessId, name: 'Floor 5%', basis: 'percent_of_sale', rateBps: 500 })
      .returning();

    async function makeUser(email: string, name: string, role: string) {
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
          commissionPlanId: role === 'Cashier' ? plan!.id : null,
        })
        .returning();
      return m!.id;
    }
    await makeUser('owner@actions-test.local', 'Olive Owner', 'Owner');
    cashierMembershipId = await makeUser('cashier@actions-test.local', 'Cass Hier', 'Cashier');

    const [loc] = await db
      .insert(schema.locations)
      .values({
        businessId,
        name: 'Showroom',
        timezone: 'America/Los_Angeles',
        taxRateBps: 700,
        orderPrefix: '02',
      })
      .returning();
    locationId = loc!.id;

    const [cust] = await db
      .insert(schema.customers)
      .values({
        businessId,
        firstName: 'Dana',
        lastName: 'Reyes',
        email: 'dana@example.test',
        phone: '3105550100',
      })
      .returning();
    customerId = cust!.id;

    const [brand] = await db
      .insert(schema.brands)
      .values({ businessId, name: 'Harbour' })
      .returning();
    const [furniture] = await db
      .insert(schema.categories)
      .values({ businessId, name: 'Bedroom Furniture', position: 0 })
      .returning();
    const [daybeds] = await db
      .insert(schema.categories)
      .values({ businessId, name: 'Daybeds & Sofa Beds', parentId: furniture!.id, position: 0 })
      .returning();
    const [p] = await db
      .insert(schema.products)
      .values({
        businessId,
        sku: 'SOFA',
        name: 'Harbour Sofa',
        brandId: brand!.id,
        categoryId: daybeds!.id,
        description: 'Kiln-dried frame, 10-year warranty',
      })
      .returning();
    const [v] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: p!.id,
        sku: 'SOFA-1',
        priceCents: 100_000,
        costCents: 40_000,
        attributesJson: { size: 'Queen' },
      })
      .returning();
    sofaVariantId = v!.id;
    await db
      .insert(schema.inventoryLevels)
      .values({ businessId, variantId: v!.id, locationId, onHand: 5, reserved: 0 });
  });
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

function as(cookie: string) {
  return {
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('Cookie', cookie).set('x-business-id', businessId),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('Cookie', cookie)
        .set('x-business-id', businessId),
    patch: (path: string) =>
      request(app.getHttpServer())
        .patch(path)
        .set('Cookie', cookie)
        .set('x-business-id', businessId),
    del: (path: string) =>
      request(app.getHttpServer())
        .delete(path)
        .set('Cookie', cookie)
        .set('x-business-id', businessId),
  };
}

interface Detail {
  id: string;
  orderDiscountCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  marketingCode: string | null;
  marketingCode2: string | null;
  orderSource: string | null;
  paymentTerminal: string | null;
  exceptionNotes: string | null;
  tradeDesignerJson: { name?: string; company?: string } | null;
  customInfoJson: { label: string; value: string }[] | null;
  lines: {
    id: string;
    description: string;
    quantity: number;
    qtyReserved: number;
    unitPriceCents: number;
    discountCents: number;
    taxRateBps: number;
    lineType: string;
    comment: string | null;
    room: string | null;
    pieces: number | null;
    prepCodes: string[] | null;
    comJson: { supplied: boolean; description: string | null } | null;
    directShipJson: unknown;
    needsInstall: boolean;
  }[];
}

const detail = async () =>
  (await as(ownerCookie).get(`/v1/orders/${orderId}`).expect(200)).body as Detail;

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'actions-test-secret-actions-test-secret';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  ownerCookie = await captureCookie('owner@actions-test.local');
  cashierCookie = await captureCookie('cashier@actions-test.local');

  const created = await as(cashierCookie)
    .post('/v1/orders')
    .send({
      locationId,
      customerId,
      confirm: true,
      salespersonMembershipId: cashierMembershipId,
      lines: [
        { variantId: sofaVariantId, quantity: 3 },
        { lineType: 'custom', description: 'Recycling Fee', quantity: 1, unitPriceCents: 1050 },
      ],
    })
    .expect(201);
  orderId = created.body.id;
  sofaLineId = created.body.lines.find((l: { variantId: string | null }) => l.variantId).id;
  feeLineId = created.body.lines.find((l: { variantId: string | null }) => !l.variantId).id;
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('A20 — Enter a Sales Order actions', () => {
  it('saves the Step 1 header fields and the line details', async () => {
    const res = await as(cashierCookie)
      .patch(`/v1/orders/${orderId}`)
      .send({
        marketingCode: 'LABOR-DAY-TV',
        marketingCode2: 'YELP',
        orderSource: 'Walk-in',
        paymentTerminal: 'Reader 1',
        exceptionNotes: 'Manager approved the floor-model price',
        tradeDesigner: { name: 'Ines Park', company: 'Park Interiors' },
        customInfo: [
          { label: 'Fabric', value: 'Linen, oat' },
          { label: '', value: '' },
        ],
      })
      .expect(200);
    const o = res.body as Detail;
    expect(o.marketingCode).toBe('LABOR-DAY-TV');
    expect(o.marketingCode2).toBe('YELP');
    expect(o.orderSource).toBe('Walk-in');
    expect(o.paymentTerminal).toBe('Reader 1');
    expect(o.exceptionNotes).toContain('Manager approved');
    expect(o.tradeDesignerJson).toMatchObject({ name: 'Ines Park', company: 'Park Interiors' });
    expect(o.customInfoJson).toEqual([{ label: 'Fabric', value: 'Linen, oat' }]);

    const line = (
      await as(cashierCookie)
        .patch(`/v1/orders/${orderId}/lines/${sofaLineId}`)
        .send({
          comment: 'Deliver before noon',
          room: 'Living room',
          pieces: 2,
          prepCodes: ['Assemble', 'assemble', 'Inspect'],
          com: { description: '6 yd customer fabric' },
          needsInstall: true,
        })
        .expect(200)
    ).body as Detail;
    const sofa = line.lines.find((l) => l.id === sofaLineId)!;
    expect(sofa).toMatchObject({
      comment: 'Deliver before noon',
      room: 'Living room',
      pieces: 2,
      prepCodes: ['Assemble', 'Inspect'],
      comJson: { supplied: true, description: '6 yd customer fabric' },
      needsInstall: true,
    });
    // Money untouched by metadata.
    expect(sofa.unitPriceCents).toBe(100_000);
    expect(sofa.qtyReserved).toBe(3);

    await as(cashierCookie)
      .patch(`/v1/orders/${orderId}/lines/${sofaLineId}`)
      .send({ pieces: 500 })
      .expect(400);
  });

  it('attaches, serves and removes files within the limits', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const list = (
      await as(cashierCookie)
        .post(`/v1/orders/${orderId}/attachments`)
        .send({
          name: 'floor plan.png',
          mimeType: 'image/png',
          dataBase64: `data:image/png;base64,${png.toString('base64')}`,
          lineId: sofaLineId,
          note: 'Stairs',
        })
        .expect(201)
    ).body as {
      id: string;
      name: string;
      sizeBytes: number;
      lineId: string;
      uploadedBy: string | null;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'floor plan.png',
      sizeBytes: png.length,
      lineId: sofaLineId,
      uploadedBy: 'Cass Hier',
    });

    const bin = await as(ownerCookie)
      .get(`/v1/orders/${orderId}/attachments/${list[0]!.id}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(bin.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(bin.body as Buffer, png)).toBe(0);

    await as(cashierCookie)
      .post(`/v1/orders/${orderId}/attachments`)
      .send({ name: 'x.exe', mimeType: 'application/x-msdownload', dataBase64: 'AAAA' })
      .expect(400);
    // Over 5 MB: the API refuses it (400); the production body parser
    // (25 MB) lets it through to that check, the bare test app stops it
    // earlier with a 413. Either way it never lands.
    const big = await as(cashierCookie)
      .post(`/v1/orders/${orderId}/attachments`)
      .send({
        name: 'big.pdf',
        mimeType: 'application/pdf',
        dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
      });
    expect([400, 413]).toContain(big.status);

    const after = (
      await as(cashierCookie).del(`/v1/orders/${orderId}/attachments/${list[0]!.id}`).expect(200)
    ).body as unknown[];
    expect(after).toHaveLength(0);
  });

  it('discounts multiple lines, splits a line and restores catalog prices', async () => {
    // 10% off the sofa line: 3 × $1,000 × 10% = $300.
    await as(cashierCookie)
      .post(`/v1/orders/${orderId}/lines/discount-multiple`)
      .send({ lineIds: [sofaLineId], mode: 'percent', value: 10 })
      .expect(201);
    let o = await detail();
    expect(o.lines.find((l) => l.id === sofaLineId)!.discountCents).toBe(30_000);
    expect(o.discountCents).toBe(30_000);
    // G6/A10: the discount went through the price monitor — 10% and $300
    // off list is past tier 1, so the exception register has it.
    const flagged = await withDb((db) =>
      db
        .select({ type: schema.exceptionEvents.type, summary: schema.exceptionEvents.summary })
        .from(schema.exceptionEvents)
        .where(eq(schema.exceptionEvents.entityId, orderId)),
    );
    expect(
      flagged.some((f) => f.type === 'price_override' && /Discount lines/.test(f.summary)),
    ).toBe(true);

    // Split one unit off: reservations and discount follow the units.
    const split = (
      await as(cashierCookie)
        .post(`/v1/orders/${orderId}/lines/${sofaLineId}/split`)
        .send({ quantity: 1 })
        .expect(201)
    ).body as { newLineId: string };
    o = await detail();
    const kept = o.lines.find((l) => l.id === sofaLineId)!;
    const moved = o.lines.find((l) => l.id === split.newLineId)!;
    expect(kept).toMatchObject({
      quantity: 2,
      qtyReserved: 2,
      discountCents: 20_000,
      room: 'Living room',
    });
    expect(moved).toMatchObject({
      quantity: 1,
      qtyReserved: 1,
      discountCents: 10_000,
      room: 'Living room',
      unitPriceCents: 100_000,
    });
    expect(o.lines).toHaveLength(3);
    await as(cashierCookie)
      .post(`/v1/orders/${orderId}/lines/${split.newLineId}/split`)
      .send({ quantity: 1 })
      .expect(400);

    // A line on a scheduled delivery cannot be split (its delivery rows
    // would be left over-allocated), and the truck counts pieces per unit.
    const today = new Date().toISOString().slice(0, 10);
    const deliveryId = await withDb(async (db) => {
      const [d] = await db
        .insert(schema.deliveries)
        .values({ businessId, locationId, orderId, scheduledDate: today, status: 'scheduled' })
        .returning({ id: schema.deliveries.id });
      await db.insert(schema.deliveryLines).values({
        businessId,
        deliveryId: d!.id,
        orderLineId: sofaLineId,
        quantity: 2,
      });
      return d!.id;
    });
    await as(cashierCookie)
      .post(`/v1/orders/${orderId}/lines/${sofaLineId}/split`)
      .send({ quantity: 1 })
      .expect(400);
    const capacity = (
      await as(ownerCookie).get(`/v1/deliveries/capacity?from=${today}&to=${today}`).expect(200)
    ).body as { days: { date: string; pieces: number }[] };
    // 2 units × 2 pieces per unit (set on the line earlier) = 4 pieces.
    expect(capacity.days.find((d) => d.date === today)?.pieces).toBe(4);
    await withDb(async (db) => {
      await db.delete(schema.deliveryLines).where(eq(schema.deliveryLines.deliveryId, deliveryId));
      await db.delete(schema.deliveries).where(eq(schema.deliveries.id, deliveryId));
    });

    // A price override + order discount, then Remove All Price Overrides and Discounts.
    await as(cashierCookie)
      .patch(`/v1/orders/${orderId}/lines/${sofaLineId}`)
      .send({ unitPriceCents: 90_000 })
      .expect(200);
    await as(cashierCookie)
      .patch(`/v1/orders/${orderId}`)
      .send({ orderDiscountCents: 5_000 })
      .expect(200);
    const restored = (
      await as(cashierCookie).post(`/v1/orders/${orderId}/remove-overrides`).expect(201)
    ).body as { restored: number };
    expect(restored.restored).toBe(3); // two sofa lines + the order discount
    o = await detail();
    expect(o.orderDiscountCents).toBe(0);
    expect(o.discountCents).toBe(0);
    for (const l of o.lines.filter((l) => l.lineType !== 'custom')) {
      expect(l.unitPriceCents).toBe(100_000);
      expect(l.discountCents).toBe(0);
    }
    expect(o.lines.find((l) => l.id === feeLineId)!.unitPriceCents).toBe(1050);
  });

  it('reports tax, cost, commission, linked documents, stock and the product', async () => {
    const tax = (await as(cashierCookie).get(`/v1/orders/${orderId}/tax-info`).expect(200))
      .body as {
      storeRateBps: number;
      untaxedLines: number;
      lines: { id: string; taxRateBps: number; lineSubtotalCents: number; taxCents: number }[];
    };
    expect(tax.storeRateBps).toBe(700);
    expect(tax.untaxedLines).toBe(1);
    const sofaTax = tax.lines.find((l) => l.id === sofaLineId)!;
    expect(sofaTax.taxRateBps).toBe(700);
    expect(sofaTax.lineSubtotalCents).toBe(200_000);
    expect(sofaTax.taxCents).toBe(14_000);

    await as(cashierCookie).get(`/v1/orders/${orderId}/costed`).expect(403);
    const costed = (await as(ownerCookie).get(`/v1/orders/${orderId}/costed`).expect(200)).body as {
      revenueCents: number;
      costCents: number;
      marginCents: number;
      lines: { id: string; costCents: number | null; marginPct: number | null }[];
    };
    expect(costed.revenueCents).toBe(301_050);
    expect(costed.costCents).toBe(120_000);
    expect(costed.marginCents).toBe(181_050);
    expect(costed.lines.find((l) => l.id === sofaLineId)).toMatchObject({
      costCents: 80_000,
      marginPct: 60,
    });

    // Projected like accrual: 5% of the order total ($3,010.50 + 7% tax on
    // the merchandise = $3,220.50 → $161.03), spread over the sofa lines.
    interface Comm {
      salespeople: {
        membershipId: string;
        name: string;
        shareBps: number;
        basisCents: number | null;
        commissionCents: number | null;
      }[];
      lines: { id: string; commissionCents: (number | null)[]; spiffCents: null }[];
      totals: { merchandiseCents: number; commissionCents: (number | null)[] };
      costHidden: boolean;
    }
    const comm = (await as(cashierCookie).get(`/v1/orders/${orderId}/commission-table`).expect(200))
      .body as Comm;
    expect(comm.costHidden).toBe(false);
    expect(comm.salespeople).toHaveLength(1);
    expect(comm.salespeople[0]).toMatchObject({
      membershipId: cashierMembershipId,
      name: 'Cass Hier',
      shareBps: 10_000,
      basisCents: 322_050,
      commissionCents: 16_103,
    });
    expect(comm.totals).toEqual({ merchandiseCents: 300_000, commissionCents: [16_103] });
    expect(comm.lines.find((l) => l.id === sofaLineId)!.commissionCents).toEqual([10_735]);
    expect(comm.lines.reduce((n, l) => n + (l.commissionCents[0] ?? 0), 0)).toBe(16_103);
    expect(comm.lines.every((l) => l.spiffCents === null)).toBe(true);

    // A margin plan reveals cost: hidden from a cashier, shown to the owner.
    await withDb((db) =>
      db
        .update(schema.commissionPlans)
        .set({ basis: 'percent_of_margin' })
        .where(eq(schema.commissionPlans.name, 'Floor 5%')),
    );
    const hidden = (
      await as(cashierCookie).get(`/v1/orders/${orderId}/commission-table`).expect(200)
    ).body as Comm;
    expect(hidden.costHidden).toBe(true);
    expect(hidden.salespeople[0]).toMatchObject({ basisCents: null, commissionCents: null });
    expect(hidden.lines.every((l) => l.commissionCents[0] === null)).toBe(true);
    const shown = (await as(ownerCookie).get(`/v1/orders/${orderId}/commission-table`).expect(200))
      .body as Comm;
    // $3,220.50 − 3 × $400 cost = $2,020.50 → 5% = $101.03.
    expect(shown.costHidden).toBe(false);
    expect(shown.salespeople[0]).toMatchObject({ basisCents: 202_050, commissionCents: 10_103 });

    const linked = (await as(cashierCookie).get(`/v1/orders/${orderId}/linked`).expect(200))
      .body as {
      lines: { id: string; purchaseOrders: unknown[]; deliveries: unknown[]; returns: unknown[] }[];
      transfers: unknown[];
      exchanges: unknown[];
    };
    expect(linked.lines).toHaveLength(3);
    expect(
      linked.lines.every((l) => l.purchaseOrders.length === 0 && l.deliveries.length === 0),
    ).toBe(true);
    expect(linked.transfers).toEqual([]);

    const stock = (
      await as(cashierCookie).get(`/v1/orders/${orderId}/lines/${sofaLineId}/stock`).expect(200)
    ).body as {
      sku: string;
      levels: { locationName: string; onHand: number; reserved: number; available: number }[];
    };
    expect(stock.sku).toBe('SOFA-1');
    expect(stock.levels).toEqual([
      { locationId: locationId, locationName: 'Showroom', onHand: 5, reserved: 3, available: 2 },
    ]);
    await as(cashierCookie).get(`/v1/orders/${orderId}/lines/${feeLineId}/stock`).expect(400);

    const product = (
      await as(cashierCookie).get(`/v1/orders/${orderId}/lines/${sofaLineId}/product`).expect(200)
    ).body as {
      name: string;
      brand: string;
      sku: string;
      priceCents: number;
      attributes: { size: string };
      description: string;
    };
    expect(product).toMatchObject({
      name: 'Harbour Sofa',
      brand: 'Harbour',
      // A22.1: the full nested category, not the leaf.
      category: 'Bedroom Furniture › Daybeds & Sofa Beds',
      sku: 'SOFA-1',
      priceCents: 100_000,
      attributes: { size: 'Queen' },
    });
    expect(product.description).toContain('warranty');
  });

  it('keeps the customer work phone and extension', async () => {
    const c = (
      await as(ownerCookie)
        .patch(`/v1/customers/${customerId}`)
        .send({ workPhone: '3105550199', workPhoneExt: '204' })
        .expect(200)
    ).body as { workPhone: string | null; workPhoneExt: string | null };
    expect(c).toMatchObject({ workPhone: '3105550199', workPhoneExt: '204' });
    const again = (await as(ownerCookie).get(`/v1/customers/${customerId}`).expect(200)).body as {
      workPhone: string | null;
    };
    expect(again.workPhone).toBe('3105550199');
    const row = await withDb((db) =>
      db
        .select({ ext: schema.customers.workPhoneExt })
        .from(schema.customers)
        .where(eq(schema.customers.id, customerId)),
    );
    expect(row[0]!.ext).toBe('204');
  });
});
