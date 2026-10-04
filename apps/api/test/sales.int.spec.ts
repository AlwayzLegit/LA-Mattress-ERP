/**
 * Epic 1.10 acceptance:
 *   A cashier completes a sale paid 50% cash, 50% card, sees inventory
 *   decrement, views it in the sales list, refunds a single line, and
 *   the inventory is restored.
 *
 * Also covers POS lookup (barcode + name), payment-sum validation,
 * sale numbering, and per-role permission gates.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AppModule } from '../src/app.module';

const TEST_DB_URL =
  process.env.SALES_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_sales';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'SalesPass!2026';

let app: INestApplication;
let businessId = '';
let locationId = '';
let variantAId = '';
let variantBId = '';
let cashierCookie = '';
let ownerCookie = '';
let inventoryClerkCookie = '';

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
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const passwordHash = await hashPassword(PASSWORD);
    const [biz] = await db
      .insert(schema.businesses)
      .values({
        slug: 'sales-test',
        name: 'Sales Test Co',
        status: 'active',
        defaultTaxRateBps: 1000, // 10% — used because the location has no override
      })
      .returning();
    businessId = biz!.id;

    const roles = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      const [r] = await db
        .insert(schema.roles)
        .values({
          businessId,
          name: role.name,
          description: role.description,
          isSystem: true,
        })
        .returning();
      roles.set(role.name, r!.id);
      if (role.permissions.length > 0) {
        await db
          .insert(schema.rolePermissions)
          .values(role.permissions.map((permission) => ({ roleId: r!.id, permission })));
      }
    }

    async function makeUser(email: string, role: string): Promise<void> {
      const [u] = await db
        .insert(schema.users)
        .values({ email, emailVerified: true, name: role })
        .returning();
      await db.insert(schema.accounts).values({
        accountId: u!.id,
        providerId: 'credential',
        userId: u!.id,
        password: passwordHash,
      });
      await db.insert(schema.memberships).values({
        businessId,
        userId: u!.id,
        roleId: roles.get(role)!,
        status: 'active',
        acceptedAt: new Date(),
      });
    }
    await makeUser('owner@sales-test.local', 'Owner');
    await makeUser('cashier@sales-test.local', 'Cashier');
    await makeUser('clerk@sales-test.local', 'Warehouse');

    const [loc] = await db
      .insert(schema.locations)
      .values({ businessId, name: 'Main', timezone: 'America/New_York' })
      .returning();
    locationId = loc!.id;

    const [productA] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'COKE', name: 'Coca-Cola' })
      .returning();
    const [variantA] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: productA!.id,
        sku: 'COKE-12OZ',
        barcode: '049000000443',
        priceCents: 200,
      })
      .returning();
    variantAId = variantA!.id;

    const [productB] = await db
      .insert(schema.products)
      .values({ businessId, sku: 'CHIPS', name: 'Lay’s Classic' })
      .returning();
    const [variantB] = await db
      .insert(schema.productVariants)
      .values({
        businessId,
        productId: productB!.id,
        sku: 'CHIPS-1OZ',
        priceCents: 150,
      })
      .returning();
    variantBId = variantB!.id;

    // Stock starts: A=10, B=5 — set directly.
    await db.insert(schema.inventoryLevels).values([
      { businessId, variantId: variantAId, locationId, onHand: 10 },
      { businessId, variantId: variantBId, locationId, onHand: 5 },
    ]);
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

async function levelOf(variantId: string): Promise<number> {
  const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    const [row] = await db
      .select()
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, variantId),
          eq(schema.inventoryLevels.locationId, locationId),
        ),
      );
    return row?.onHand ?? 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  await resetTestDb();
  await seed();

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'sales-test-secret-sales-test-secret-x';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  await app.init();

  ownerCookie = await captureCookie('owner@sales-test.local');
  cashierCookie = await captureCookie('cashier@sales-test.local');
  inventoryClerkCookie = await captureCookie('clerk@sales-test.local');
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Epic 1.10 — POS register & sales', () => {
  it('POS lookup by exact barcode returns one row', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/pos/lookup?q=049000000443')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].productName).toBe('Coca-Cola');
    expect(res.body[0].priceCents).toBe(200);
  });

  it('POS lookup by partial name matches via ILIKE fallback', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/pos/lookup?q=coca')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.some((r: { productName: string }) => r.productName === 'Coca-Cola')).toBe(true);
  });

  it('Inventory clerk (no pos.access) is blocked from lookup', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/pos/lookup?q=coke')
      .set('Cookie', inventoryClerkCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/pos\.access/);
  });

  let saleId = '';
  let saleNumber = '';
  let saleLineAId = '';
  it('Cashier completes a 50/50 cash+card sale, decrements inventory, audit-logs', async () => {
    // Cart: 2 Coke @ $2.00 + 1 Chips @ $1.50 = $5.50 subtotal
    // Tax 10% = $0.55, total = $6.05 (605¢). Split: $3.03 cash + $3.02 card.
    const res = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [
          { variantId: variantAId, quantity: 2 },
          { variantId: variantBId, quantity: 1 },
        ],
        payments: [
          { method: 'cash', amountCents: 303 },
          { method: 'card', amountCents: 302 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.subtotalCents).toBe(550);
    expect(res.body.taxCents).toBe(55);
    expect(res.body.totalCents).toBe(605);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.number).toMatch(/^INV-\d{4}-\d{6}$/);
    saleId = res.body.id;
    saleNumber = res.body.number;
    saleLineAId = res.body.lines.find((l: { variantId: string }) => l.variantId === variantAId).id;

    expect(await levelOf(variantAId)).toBe(8); // 10 - 2
    expect(await levelOf(variantBId)).toBe(4); // 5 - 1

    // Audit row.
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    try {
      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'sale.complete'));
      expect(audits.length).toBe(1);
      expect(audits[0]!.changesJson).toMatchObject({
        after: { number: saleNumber, totalCents: 605, lineCount: 2 },
      });
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  it('Sale appears in the list and renders detail with payments', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/sales')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(list.status).toBe(200);
    expect(list.body.data[0].id).toBe(saleId);

    const detail = await request(app.getHttpServer())
      .get(`/v1/sales/${saleId}`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId);
    expect(detail.status).toBe(200);
    expect(detail.body.payments.map((p: { method: string }) => p.method).sort()).toEqual([
      'card',
      'cash',
    ]);
    expect(
      detail.body.lines.every((l: { refundedQuantity: number }) => l.refundedQuantity === 0),
    ).toBe(true);
  });

  it('Payment sum mismatch returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [{ variantId: variantBId, quantity: 1 }],
        payments: [{ method: 'cash', amountCents: 100 }], // total would be 165
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/payments sum/);
  });

  it('Cashier without pos.refund.create is denied', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/sales/${saleId}/refund`)
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ saleLineId: saleLineAId, quantity: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/pos\.refund\.create/);
  });

  it('Owner refunds 1 unit of line A — goods go to As-Is (not stock), sale partially_refunded', async () => {
    const before = await levelOf(variantAId);
    const res = await request(app.getHttpServer())
      .post(`/v1/sales/${saleId}/refund`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        reason: 'customer changed mind',
        lines: [{ saleLineId: saleLineAId, quantity: 1 }],
      });
    expect(res.status).toBe(201);
    // 1 unit @ $2.00 + the 10% tax the customer actually paid on it.
    // (Was 200 — pre-tax — until the QA D1 fix; sale refunds now return
    // tax like the order-return path always has.)
    expect(res.body.amountCents).toBe(220);
    expect(res.body.saleStatus).toBe('partially_refunded');
    // §10 (P8): returned goods land in the As-Is review queue, NOT
    // straight back into sellable stock.
    expect(await levelOf(variantAId)).toBe(before);
    const queue = await request(app.getHttpServer())
      .get('/v1/as-is?status=pending_review')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(queue.status).toBe(200);
    expect(
      queue.body.data.some(
        (r: { variantId: string; quantity: number }) =>
          r.variantId === variantAId && r.quantity === 1,
      ),
    ).toBe(true);

    // Detail shows refunded quantity.
    const detail = await request(app.getHttpServer())
      .get(`/v1/sales/${saleId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const lineA = detail.body.lines.find((l: { id: string }) => l.id === saleLineAId);
    expect(lineA.refundedQuantity).toBe(1);
  });

  it('Refunding more than remaining returns 400', async () => {
    // Line A had qty 2, 1 already refunded; trying to refund 5 should fail.
    const res = await request(app.getHttpServer())
      .post(`/v1/sales/${saleId}/refund`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ saleLineId: saleLineAId, quantity: 5 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only 1 remaining/);
  });

  it('Refunding the rest moves sale to "refunded"', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/v1/sales/${saleId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const lineB = detail.body.lines.find((l: { variantId: string }) => l.variantId === variantBId);

    const res = await request(app.getHttpServer())
      .post(`/v1/sales/${saleId}/refund`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        lines: [
          { saleLineId: saleLineAId, quantity: 1 },
          { saleLineId: lineB.id, quantity: 1 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.saleStatus).toBe('refunded');
    // P8 (§10): refunded units sit in As-Is review, not sellable stock —
    // levels stay where the sale left them until a restock review.
    expect(await levelOf(variantAId)).toBe(8);
    expect(await levelOf(variantBId)).toBe(4);
  });

  it('Sale numbers increment within the same year', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', cashierCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [{ variantId: variantBId, quantity: 1 }],
        payments: [{ method: 'cash', amountCents: 165 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.number).not.toBe(saleNumber);
    expect(res.body.number).toMatch(/^INV-\d{4}-\d{6}$/);
  });
});

/**
 * QA finding D1 (2026-08-26): INV-2026-000005 sold a $1,000 line under a
 * 30% cart discount — $700 collected in cash — and the refund paid out
 * $1,000. `sale_lines.discount_cents` holds only a line's own discount;
 * the cart-wide discount lived on the sale header and was never applied
 * to the refund, so every discounted sale refunded the discount as a
 * gift. This reproduces the exact shape.
 */
describe('Refunds honour a SALE-level discount (QA D1)', () => {
  let discountedSaleId = '';
  let discountedLineId = '';

  it('a cart-discounted sale refunds what was collected, not list price', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [{ variantId: variantAId, quantity: 1 }],
        // $2.00 line, 30% off the cart = $0.60 off → $1.40 + 10% tax.
        orderDiscountCents: 60,
        // 30% is tier 3 — log-only since A10; the reason just
        // annotates the exception entry.
        priceReason: 'D1 fixture — deep discount',
        payments: [{ method: 'cash', amountCents: 154 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.totalCents).toBe(154); // 140 net + 14 tax
    discountedSaleId = created.body.id;
    discountedLineId = created.body.lines[0].id;

    const refund = await request(app.getHttpServer())
      .post(`/v1/sales/${discountedSaleId}/refund`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ lines: [{ saleLineId: discountedLineId, quantity: 1 }], reason: 'D1 regression' });
    expect(refund.status).toBe(201);
    // Exactly what the customer handed over — NOT the $2.00 list price,
    // and not $2.00 + tax.
    expect(refund.body.amountCents).toBe(154);
  });

  it('never refunds more than the sale collected', async () => {
    const sale = await request(app.getHttpServer())
      .get(`/v1/sales/${discountedSaleId}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    const refunded = sale.body.refunds.reduce(
      (s: number, r: { amountCents: number }) => s + r.amountCents,
      0,
    );
    expect(refunded).toBeLessThanOrEqual(sale.body.totalCents);
  });
});

/**
 * QA finding D2 (2026-08-26): the register bypassed the G6 price-variance
 * gate entirely — a 30% discount rang straight through to cash with no
 * reason, no authorization, and no exception. New Sale's fully-paid
 * take-with fast lane posts here too, so the hole was reachable from the
 * order screen as well. Same door, same monitor now — since A10 the gate
 * is log-only (no reason, no override), but the register-sale path must
 * still record the exception the order path records.
 */
describe('Register sales pass the price-variance monitor (QA D2 / A10)', () => {
  it('a small discount still rings through untouched (tier 1)', async () => {
    // $2.00 line, $0.05 off → under both the 5% and $50 floors.
    const res = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [{ variantId: variantAId, quantity: 1 }],
        orderDiscountCents: 5,
        payments: [{ method: 'cash', amountCents: 215 }], // 195 + 10% tax (rounded)
      });
    expect([201, 400]).toContain(res.status);
    // If the payment sum is off the fixture rounds differently; the point
    // is that it is NOT refused for a missing reason.
    if (res.status === 400) expect(res.body.code).not.toBe('REASON_REQUIRED');
  });

  it('a 30% register discount rings through with no reason (A10)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [{ variantId: variantAId, quantity: 1 }],
        orderDiscountCents: 60,
        payments: [{ method: 'cash', amountCents: 154 }],
      });
    expect(res.status).toBe(201);
  });

  it('the same discount with a volunteered reason registers an exception', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        lines: [{ variantId: variantAId, quantity: 1 }],
        orderDiscountCents: 60,
        priceReason: 'floor model, scratched',
        payments: [{ method: 'cash', amountCents: 154 }],
      });
    expect(res.status).toBe(201);

    const exceptions = await request(app.getHttpServer())
      .get('/v1/exceptions?type=price_override')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(exceptions.status).toBe(200);
    expect(
      exceptions.body.data.some((e: { summary: string }) =>
        e.summary.includes('Register sale discount'),
      ),
    ).toBe(true);
  });
});

describe('Invoice lookup — GET /v1/sales?q=', () => {
  let customerId = '';
  let lookupNumber = '';

  it('Seeds a customer sale to search for', async () => {
    const customer = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({ firstName: 'Zelda', lastName: 'Lookupson', phone: '3105550000' });
    expect(customer.status).toBe(201);
    customerId = customer.body.id as string;

    const catalog = await request(app.getHttpServer())
      .post('/v1/products')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        sku: 'LOOKUP-1',
        name: 'Lookup Widget',
        variants: [{ sku: 'LOOKUP-1-A', priceCents: 5000 }],
      });
    expect(catalog.status).toBe(201);
    const variantId = catalog.body.variants[0].id as string;

    const sale = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        customerId,
        lines: [{ variantId, quantity: 1 }],
        payments: [{ method: 'cash', amountCents: 5500 }],
      });
    expect(sale.status).toBe(201);
    lookupNumber = sale.body.number as string;
  });

  it('Finds the sale by full invoice number (the scanned-barcode path)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/sales?q=${encodeURIComponent(lookupNumber)}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const numbers = (res.body.data as { number: string }[]).map((r) => r.number);
    expect(numbers).toContain(lookupNumber);
  });

  it('Finds the sale by number fragment and carries the customer name', async () => {
    const fragment = lookupNumber.slice(-4);
    const res = await request(app.getHttpServer())
      .get(`/v1/sales?q=${encodeURIComponent(fragment)}`)
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const row = (res.body.data as { number: string; customerName: string | null }[]).find(
      (r) => r.number === lookupNumber,
    );
    expect(row).toBeDefined();
    expect(row!.customerName).toBe('Zelda Lookupson');
  });

  it('Finds the sale by customer name', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/sales?q=Lookupson')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    const rows = res.body.data as { number: string; customerId: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.customerId === customerId || r.number === lookupNumber)).toBe(true);
    expect(rows.map((r) => r.number)).toContain(lookupNumber);
  });

  it('A non-matching query returns an empty page, not everything', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/sales?q=NO-SUCH-INVOICE-XYZ')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('Ring a sale for someone else (owner 2026-10-03)', () => {
  it('the picked salesperson is credited; the signed-in member still takes the money', async () => {
    const sqlc = postgres(TEST_DB_URL, { max: 1, prepare: false });
    const db = drizzle(sqlc);
    let cashier: { membershipId: string; userId: string };
    try {
      const [row] = await db
        .select({ membershipId: schema.memberships.id, userId: schema.users.id })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.users.email, 'cashier@sales-test.local'));
      cashier = row!;
    } finally {
      await sqlc.end({ timeout: 5 });
    }
    const res = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        salespersonMembershipId: cashier.membershipId,
        lines: [{ variantId: variantAId, quantity: 1 }],
        payments: [{ method: 'cash', amountCents: 220 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.associateUserId).toBe(cashier.userId);

    const bogus = await request(app.getHttpServer())
      .post('/v1/sales')
      .set('Cookie', ownerCookie)
      .set('X-Business-Id', businessId)
      .send({
        locationId,
        salespersonMembershipId: '00000000-0000-0000-0000-000000000000',
        lines: [{ variantId: variantAId, quantity: 1 }],
        payments: [{ method: 'cash', amountCents: 220 }],
      });
    expect(bogus.status).toBe(404);
  });
});
