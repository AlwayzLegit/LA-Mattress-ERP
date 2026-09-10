/**
 * §7 acceptance (STORIS cutover, decisions D7/D8): synthetic
 * STORIS-shaped CSVs walk the whole pipeline — stage → auto-map →
 * validate → commit → recon gates 1–4 — and re-running any of it
 * updates the same records instead of duplicating them. Imported
 * documents carry `imported_at` so the drawer, commissions, and
 * webhooks ignore them.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
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
  process.env.IMPORT_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/jetnine_import';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');
const PASSWORD = 'ImportPass!26';

let app: INestApplication;
let businessId = '';
let ownerCookie = '';
let verifySql: ReturnType<typeof postgres>;
let verifyDb: ReturnType<typeof drizzle>;

// --- Synthetic STORIS-shaped fixtures (headers as the report writer emits them) ---

const CUSTOMERS_CSV = `CUST#,FIRST_NAME,LAST_NAME,EMAIL,PHONE,ADDRESS1,CITY,STATE,ZIP
C1001,Maria,Alvarez,maria.alvarez@example.test,310-555-0101,12 Palm Ave,Los Angeles,CA,90001
C1002,Devon,Brooks,devon.brooks@example.test,310-555-0102,88 Ocean Blvd,Torrance,CA,90501
C1003,Priya,Nair,priya.nair@example.test,,45 Hill St,Glendale,CA,91201`;

const PRODUCTS_CSV = `SKU,DESCRIPTION,CATEGORY,RETAIL,COST,SERIALIZED
MAT-Q-FIRM,Queen Firm Mattress,Mattresses,"$999.99",450.00,N
ADJ-BASE-Q,Queen Adjustable Base,Bases,"$1,299.00",700.00,Y
PILLOW-STD,Standard Pillow,Accessories,99.50,30.25,N`;

const INVENTORY_CSV = `SKU,LOCATION,ON_HAND,UNIT_COST
MAT-Q-FIRM,Main Warehouse,10,450.00
MAT-Q-FIRM,Showroom,2,450.00
ADJ-BASE-Q,Main Warehouse,3,700.00
PILLOW-STD,Main Warehouse,50,30.25`;

const ORDERS_CSV = `ORDER#,CUST#,LOCATION,ORDER_DATE,PROMISED_DATE,STATUS,TOTAL,TAX,DEPOSIT
SO-88121,C1001,Main Warehouse,07/15/2026,09/01/2026,OPEN,"$2,398.99",199.00,500.00
SO-88122,C1002,Showroom,08/01/2026,08/30/2026,OPEN,999.99,0.00,999.99
SO-88123,C9999,Main Warehouse,08/02/2026,,OPEN,150.00,0.00,0.00`;

const ORDER_LINES_CSV = `ORDER#,LINE#,SKU,DESCRIPTION,QTY,UNIT_PRICE,EXT_PRICE
SO-88121,1,MAT-Q-FIRM,Queen Firm Mattress,1,999.99,999.99
SO-88121,2,ADJ-BASE-Q,Queen Adjustable Base,1,"1,199.00","1,199.00"
SO-88122,1,MAT-Q-FIRM,Queen Firm Mattress,1,999.99,999.99`;

const SALES_CSV = `INVOICE#,CUST#,LOCATION,DATE,TOTAL,TAX,TENDER
INV-1001,C1003,Showroom,06/12/2026,89.99,7.42,CASH
INV-1002,C1001,Main Warehouse,05/03/2026,"1,542.50",127.29,VISA`;

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
      .values({ slug: 'import-test', name: 'Import Test Co', status: 'active' })
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
    const [u] = await db
      .insert(schema.users)
      .values({ email: 'owner@import-test.local', emailVerified: true, name: 'Owner' })
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
      roleId: roles.get('Owner')!,
      status: 'active',
      acceptedAt: new Date(),
    });
    // The two stores STORIS knows about.
    await db.insert(schema.locations).values([
      { businessId, name: 'Main Warehouse', timezone: 'America/Los_Angeles', taxRateBps: 0 },
      { businessId, name: 'Showroom', timezone: 'America/Los_Angeles', taxRateBps: 0 },
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

function api() {
  return {
    post: (url: string) =>
      request(app.getHttpServer())
        .post(url)
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId),
    get: (url: string) =>
      request(app.getHttpServer())
        .get(url)
        .set('Cookie', ownerCookie)
        .set('X-Business-Id', businessId),
  };
}

/** stage → validate → commit; returns the batch id. */
async function runBatch(entity: string, csv: string, expectInvalid = 0): Promise<string> {
  const staged = await api()
    .post('/v1/import/batches')
    .send({ entity, filename: `${entity}.csv`, csv });
  expect(staged.status).toBe(201);
  expect(staged.body.unmappedRequired).toEqual([]);
  const batchId = staged.body.id as string;
  const validated = await api().post(`/v1/import/batches/${batchId}/validate`).send({});
  expect(validated.status).toBe(201);
  expect(validated.body.invalidRowCount).toBe(expectInvalid);
  const committed = await api().post(`/v1/import/batches/${batchId}/commit`).send({});
  expect(committed.status).toBe(201);
  expect(committed.body.failed).toBe(0);
  return batchId;
}

beforeAll(async () => {
  await resetTestDb();
  await seed();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.BETTER_AUTH_URL ??= 'http://localhost';
  process.env.BETTER_AUTH_SECRET ??= 'import-test-secret-import-test-secret!!';
  process.env.AUTH_TRUSTED_ORIGINS ??= 'http://localhost';
  process.env.NODE_ENV ??= 'test';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RESEND_API_KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  await app.init();
  ownerCookie = await captureCookie('owner@import-test.local');
  verifySql = postgres(TEST_DB_URL, { max: 1, prepare: false });
  verifyDb = drizzle(verifySql);
}, 120_000);

afterAll(async () => {
  if (verifySql) await verifySql.end({ timeout: 5 });
  if (app) await app.close();
});

describe('pipeline mechanics', () => {
  it('lists entities in dependency order for the wizard', async () => {
    const res = await api().get('/v1/import/entities');
    expect(res.status).toBe(200);
    const order = res.body.map((e: { entity: string }) => e.entity);
    expect(order).toEqual([
      'customer',
      'vendor',
      'product',
      'inventory',
      'order',
      'order_line',
      'sale',
      'sale_line',
    ]);
  });

  it('rejects unparseable money with a per-row report', async () => {
    const staged = await api()
      .post('/v1/import/batches')
      .send({ entity: 'product', csv: 'SKU,DESCRIPTION,RETAIL\nBAD-1,Broken,ABC' });
    const validated = await api().post(`/v1/import/batches/${staged.body.id}/validate`).send({});
    expect(validated.body.invalidRowCount).toBe(1);
    const report = validated.body.validationJson;
    expect(report.errors[0].errors[0].message).toMatch(/bad money value "ABC"/);
    // Un-validated rows never commit.
    const commit = await api().post(`/v1/import/batches/${staged.body.id}/commit`).send({});
    expect(commit.status).toBe(201);
    expect(commit.body.committed).toBe(0);
  });

  it('flags duplicate legacy ids inside a batch', async () => {
    const staged = await api()
      .post('/v1/import/batches')
      .send({ entity: 'customer', csv: 'CUST#,FIRST_NAME\nDUP1,A\nDUP1,B' });
    const validated = await api().post(`/v1/import/batches/${staged.body.id}/validate`).send({});
    expect(validated.body.invalidRowCount).toBe(1);
    expect(JSON.stringify(validated.body.validationJson)).toContain('duplicate legacy id');
    expect(JSON.stringify(validated.body.validationJson)).toContain('DUP1');
  });
});

describe('entity importers (D7 idempotency throughout)', () => {
  it('imports customers and re-import updates instead of duplicating', async () => {
    await runBatch('customer', CUSTOMERS_CSV);
    let rows = await verifyDb
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.businessId, businessId));
    expect(rows).toHaveLength(3);
    const maria = rows.find((c) => c.email === 'maria.alvarez@example.test');
    expect(maria?.firstName).toBe('Maria');
    expect((maria?.addressesJson as Array<{ city: string }>)[0]?.city).toBe('Los Angeles');

    // The corrected re-export: Devon's phone changed.
    await runBatch('customer', CUSTOMERS_CSV.replace('310-555-0102', '310-555-0199'));
    rows = await verifyDb
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.businessId, businessId));
    expect(rows).toHaveLength(3);
    expect(rows.find((c) => c.email === 'devon.brooks@example.test')?.phone).toBe('310-555-0199');
  });

  it('imports products with money/bool coercion and creates categories', async () => {
    await runBatch('product', PRODUCTS_CSV);
    const variants = await verifyDb
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.businessId, businessId));
    expect(variants).toHaveLength(3);
    const base = variants.find((v) => v.sku === 'ADJ-BASE-Q');
    expect(base?.priceCents).toBe(129_900);
    expect(base?.costCents).toBe(70_000);
    const products = await verifyDb
      .select()
      .from(schema.products)
      .where(eq(schema.products.businessId, businessId));
    expect(products.find((p) => p.sku === 'ADJ-BASE-Q')?.serialTracked).toBe(true);
    const cats = await verifyDb
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.businessId, businessId));
    expect(cats.map((c) => c.name).sort()).toEqual(['Accessories', 'Bases', 'Mattresses']);
  });

  it('enriches variants with vendor SKU / vendor / reorder point from STORIS-style columns', async () => {
    const csv = `SKU,DESCRIPTION,CATEGORY,RETAIL,REPLACE_COST,VENDOR_MODEL_NUMBER,VENDOR,MIN_STOCK
4163,Ireland Black Nightstand,Bedroom,199.00,83.00,04163,ACME,2
SAM-18002-ET-K,E King Franklin Mattress,Mattresses,3299.00,1684.00,,CANN,
SAM-18002-ET-Q,Queen Franklin Mattress,Mattresses,2499.00,1070.00,SAM18002Q,CANN,1`;
    await runBatch('product', csv);

    const variants = await verifyDb
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.businessId, businessId));
    const nightstand = variants.find((v) => v.sku === '4163');
    expect(nightstand?.vendorSku).toBe('04163');
    expect(nightstand?.reorderPoint).toBe(2);
    const king = variants.find((v) => v.sku === 'SAM-18002-ET-K');
    expect(king?.vendorSku).toBeNull(); // blank column leaves it unset
    expect(king?.reorderPoint).toBeNull();

    // Both CANN rows share one vendor row, created on the fly; the ACME
    // row gets its own. Preferred vendor lands on the variant.
    const vendorRows = await verifyDb
      .select()
      .from(schema.vendors)
      .where(eq(schema.vendors.businessId, businessId));
    const cann = vendorRows.filter((v) => v.name.toLowerCase() === 'cann');
    expect(cann).toHaveLength(1);
    expect(vendorRows.some((v) => v.name.toLowerCase() === 'acme')).toBe(true);
    expect(nightstand?.preferredVendorId).toBe(
      vendorRows.find((v) => v.name.toLowerCase() === 'acme')?.id,
    );
    expect(king?.preferredVendorId).toBe(cann[0]!.id);
  });

  it('D12: import without a RETAIL column keeps existing prices, new SKUs land at 0', async () => {
    const csv = `SKU,DESCRIPTION,CATEGORY,COST
PILLOW-STD,Standard Pillow,Accessories,30.25
NOPRICE-1,Unpriced Import Item,Accessories,12.00`;
    await runBatch('product', csv);

    const variants = await verifyDb
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.businessId, businessId));
    // Pre-existing variant (priced 99.50 in the earlier product batch)
    // keeps its price — the price-less re-import must not clobber it.
    expect(variants.find((v) => v.sku === 'PILLOW-STD')?.priceCents).toBe(9950);
    // Brand-new SKU with no price lands at 0 (unsellable until priced).
    expect(variants.find((v) => v.sku === 'NOPRICE-1')?.priceCents).toBe(0);
  });

  it('sets on-hand with an audit movement; re-run is a no-op', async () => {
    await runBatch('inventory', INVENTORY_CSV);
    const levels = await verifyDb
      .select()
      .from(schema.inventoryLevels)
      .where(eq(schema.inventoryLevels.businessId, businessId));
    expect(levels.reduce((s, l) => s + l.onHand, 0)).toBe(65);
    let movements = await verifyDb
      .select()
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.businessId, businessId),
          eq(schema.inventoryMovements.reason, 'import'),
        ),
      );
    expect(movements).toHaveLength(4);

    // Same file again: deltas are zero, so no new ledger noise.
    await runBatch('inventory', INVENTORY_CSV);
    movements = await verifyDb
      .select()
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.businessId, businessId),
          eq(schema.inventoryMovements.reason, 'import'),
        ),
      );
    expect(movements).toHaveLength(4);
  });

  it('imports open orders; unknown customers fail loudly, deposits become payments', async () => {
    const batchId = await runBatch('order', ORDERS_CSV, 1);
    const detail = await api().get(`/v1/import/batches/${batchId}?rows=invalid`);
    expect(JSON.stringify(detail.body.rows[0].errorsJson)).toContain('unknown customer');
    expect(JSON.stringify(detail.body.rows[0].errorsJson)).toContain('C9999');

    const orders = await verifyDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.businessId, businessId));
    expect(orders).toHaveLength(2);
    const big = orders.find((o) => o.number === 'SO-88121');
    expect(big?.status).toBe('open');
    expect(big?.totalCents).toBe(239_899);
    expect(big?.importedAt).not.toBeNull();
    expect(big?.legacyNumber).toBe('SO-88121');
    expect(big?.requestedDate).toBe('2026-09-01');

    const deposits = await verifyDb
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.businessId, businessId), eq(schema.payments.kind, 'deposit')));
    expect(deposits.reduce((s, p) => s + p.amountCents, 0)).toBe(149_999);

    // Lines land on the imported headers, resolved by SKU.
    await runBatch('order_line', ORDER_LINES_CSV);
    const lines = await verifyDb
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, big!.id));
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.description.includes('Adjustable'))?.totalCents).toBe(119_900);
  });

  it('imports sales history flagged imported_at with mapped tenders (D8)', async () => {
    await runBatch('sale', SALES_CSV);
    const sales = await verifyDb
      .select()
      .from(schema.sales)
      .where(and(eq(schema.sales.businessId, businessId), isNotNull(schema.sales.importedAt)));
    expect(sales).toHaveLength(2);
    const inv2 = sales.find((s) => s.number === 'INV-1002');
    expect(inv2?.totalCents).toBe(154_250);
    expect(inv2?.completedAt?.toISOString().slice(0, 10)).toBe('2026-05-03');

    const payments = await verifyDb
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.businessId, businessId), eq(schema.payments.kind, 'sale')));
    expect(payments.map((p) => p.method).sort()).toEqual(['card', 'cash']);
  });

  it('imports sale LINES onto committed headers — catalog SKUs bind, unknown SKUs keep their description (owner 2026-08-31)', async () => {
    // Header-only receipts showed nothing but money; the per-item
    // export attaches the lines by invoice number.
    const SALE_LINES_CSV = `INVOICE#,LINE#,SKU,DESCRIPTION,QTY,UNIT_PRICE,EXT_PRICE
INV-1001,1,MAT-Q-FIRM,Queen Foundation,1,79.99,79.99
INV-1001,2,LEGACY-GONE,Discontinued Frame,1,10.00,10.00
INV-1002,1,,Delivery Charge,1,"1,542.50","1,542.50"`;
    await runBatch('sale_line', SALE_LINES_CSV);

    const sale1 = await verifyDb
      .select()
      .from(schema.sales)
      .where(and(eq(schema.sales.businessId, businessId), eq(schema.sales.number, 'INV-1001')));
    const lines1 = await verifyDb
      .select()
      .from(schema.saleLines)
      .where(eq(schema.saleLines.saleId, sale1[0]!.id));
    expect(lines1).toHaveLength(2);
    const bound = lines1.find((l) => l.description === 'Queen Foundation');
    expect(bound?.variantId).not.toBeNull();
    expect(bound?.totalCents).toBe(7_999);
    const unknown = lines1.find((l) => l.description === 'Discontinued Frame');
    expect(unknown?.variantId).toBeNull();

    // Re-commit updates in place (D7), never duplicates.
    await runBatch('sale_line', SALE_LINES_CSV.replace('Queen Foundation', 'Queen Foundation XL'));
    const again = await verifyDb
      .select()
      .from(schema.saleLines)
      .where(eq(schema.saleLines.saleId, sale1[0]!.id));
    expect(again).toHaveLength(2);
    expect(again.some((l) => l.description === 'Queen Foundation XL')).toBe(true);

    // A line before its header fails loudly.
    const staged = await api().post('/v1/import/batches').send({
      entity: 'sale_line',
      csv: 'INVOICE#,SKU,QTY,UNIT_PRICE\nINV-9999,MAT-Q-FIRM,1,5.00',
    });
    const validated = await api().post(`/v1/import/batches/${staged.body.id}/validate`).send({});
    expect(validated.body.invalidRowCount).toBe(1);
    expect(JSON.stringify(validated.body.validationJson)).toContain('commit sale headers first');
  });
});

describe('reconciliation gates (§7)', () => {
  it('gates 1–4 balance to the cent against the committed source rows', async () => {
    const res = await api().get('/v1/import/recon');
    expect(res.status).toBe(200);
    const recon = res.body;

    for (const row of recon.gate1_rowCounts) {
      // Vendors were never imported: 0 = 0 still matches.
      expect(row.match).toBe(true);
    }
    expect(recon.gate2_inventory.units).toEqual({ source: 65, db: 65, match: true });
    expect(recon.gate2_inventory.valuationCents).toEqual({
      source: 901_250,
      db: 901_250,
      match: true,
    });
    expect(recon.gate3_depositsHeldCents).toEqual({ source: 149_999, db: 149_999, match: true });
    // AR: (2398.99 - 500.00) + (999.99 - 999.99) = 1898.99
    expect(recon.gate4_openArCents).toEqual({ source: 189_899, db: 189_899, match: true });
  });
});

/**
 * Catalog replacement (owner 2026-09-03): the STORIS Active Inventory
 * export becomes the catalog — brand, category, group, vendor code and
 * replacement cost per SKU; per-store on-hand, as-is pieces and minimum
 * stock; and everything the file does not name is deleted (no history)
 * or deactivated (history). Order lines keep their product links.
 */
describe('catalog replacement (owner 2026-09-03)', () => {
  async function commitBatch(
    entity: string,
    csv: string,
    body: Record<string, unknown> = {},
    expectInvalid = 0,
  ) {
    const staged = await api()
      .post('/v1/import/batches')
      .send({ entity, filename: `${entity}.csv`, csv });
    expect(staged.status).toBe(201);
    expect(staged.body.unmappedRequired).toEqual([]);
    const validated = await api().post(`/v1/import/batches/${staged.body.id}/validate`).send({});
    expect(validated.body.invalidRowCount).toBe(expectInvalid);
    const committed = await api().post(`/v1/import/batches/${staged.body.id}/commit`).send(body);
    expect(committed.status).toBe(201);
    expect(committed.body.failed).toBe(0);
    return committed.body as {
      committed: number;
      replaced: {
        kept: number;
        deleted: number;
        deactivated: number;
        deletedSkus: string[];
        deactivatedSkus: string[];
      } | null;
      replaceSkipped: string | null;
    };
  }

  it('loads brand, category, group, vendor code and cost from the STORIS columns', async () => {
    const csv = `SKU,DESCRIPTION,BRAND,CATG,GROUP,VENDOR,REPLACE_COST
KEEP-1,QUEEN AURORA HYBRID,HELIX,MATT,QUEEN,DIAMO,640.00
TMP-DEL-1,TEMP FRAME,KNICK,FURN,FRAMES,KNICK,45.50`;
    const result = await commitBatch('product', csv);
    expect(result.committed).toBe(2);
    expect(result.replaced).toBeNull();

    const [keep] = await verifyDb
      .select({
        productId: schema.products.id,
        brandId: schema.products.brandId,
        categoryId: schema.products.categoryId,
        attributes: schema.productVariants.attributesJson,
        costCents: schema.productVariants.costCents,
        vendorId: schema.productVariants.preferredVendorId,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.sku, 'KEEP-1'));
    expect(keep?.costCents).toBe(64_000);
    expect((keep?.attributes as { group?: string })?.group).toBe('QUEEN');
    const [brand] = await verifyDb
      .select({ name: schema.brands.name })
      .from(schema.brands)
      .where(eq(schema.brands.id, keep!.brandId!));
    expect(brand?.name).toBe('HELIX');
    const [cat] = await verifyDb
      .select({ name: schema.categories.name })
      .from(schema.categories)
      .where(eq(schema.categories.id, keep!.categoryId!));
    expect(cat?.name).toBe('MATT');
    const [vendor] = await verifyDb
      .select({ name: schema.vendors.name })
      .from(schema.vendors)
      .where(eq(schema.vendors.id, keep!.vendorId!));
    expect(vendor?.name).toBe('DIAMO');
  });

  it('inventory: tolerant store names, as-is pieces and per-store minimum stock', async () => {
    const csv = `SKU,LOCATION,ON_HAND,AS_IS,MIN_STOCK,UNIT_COST
KEEP-1,MAIN WAREHOUSE,5,2,3,640.00
KEEP-1,Showroom,1,0,1,640.00
TMP-DEL-1,Warehouse,4,0,0,45.50
TMP-DEL-1,Nowhere,1,0,0,45.50`;
    await commitBatch('inventory', csv, {}, 1);

    const [variant] = await verifyDb
      .select({ id: schema.productVariants.id, reorderPoint: schema.productVariants.reorderPoint })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.sku, 'KEEP-1'));
    expect(variant?.reorderPoint).toBe(4);
    const levels = await verifyDb
      .select({
        onHand: schema.inventoryLevels.onHand,
        reorderPoint: schema.inventoryLevels.reorderPoint,
        location: schema.locations.name,
      })
      .from(schema.inventoryLevels)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
      .where(eq(schema.inventoryLevels.variantId, variant!.id));
    expect(
      levels
        .map((l) => [l.location, l.onHand, l.reorderPoint])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['Main Warehouse', 5, 3],
      ['Showroom', 1, 1],
    ]);
    const asIs = await verifyDb
      .select({ id: schema.asIsItems.id, source: schema.asIsItems.source })
      .from(schema.asIsItems)
      .where(eq(schema.asIsItems.variantId, variant!.id));
    expect(asIs).toHaveLength(2);
    expect(asIs[0]!.source).toBe('import');

    // "Warehouse" alone still finds Main Warehouse; a store nobody has
    // stays invalid instead of landing somewhere.
    const [temp] = await verifyDb
      .select({ id: schema.productVariants.id })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.sku, 'TMP-DEL-1'));
    const tempLevels = await verifyDb
      .select({ onHand: schema.inventoryLevels.onHand })
      .from(schema.inventoryLevels)
      .where(eq(schema.inventoryLevels.variantId, temp!.id));
    expect(tempLevels.map((l) => l.onHand)).toEqual([4]);

    // Re-import with fewer as-is pieces trims the import-sourced rows.
    await commitBatch(
      'inventory',
      `SKU,LOCATION,ON_HAND,AS_IS,MIN_STOCK
KEEP-1,Main Warehouse,5,1,3`,
    );
    const trimmed = await verifyDb
      .select({ id: schema.asIsItems.id })
      .from(schema.asIsItems)
      .where(eq(schema.asIsItems.variantId, variant!.id));
    expect(trimmed).toHaveLength(1);
  });

  it('replace catalog: deletes what has no history, deactivates what does, keeps order links', async () => {
    // MAT-Q-FIRM sits on imported order lines; TMP-DEL-1 does not.
    const [matVariant] = await verifyDb
      .select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.sku, 'MAT-Q-FIRM'));
    const linesBefore = await verifyDb
      .select({ id: schema.orderLines.id })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.variantId, matVariant!.id));
    expect(linesBefore.length).toBeGreaterThan(0);
    // TMP-DEL-1 was counted at 4 above; stock is history, so zero it out
    // to make it the genuinely history-free SKU this case is about.
    await commitBatch(
      'inventory',
      `SKU,LOCATION,ON_HAND,AS_IS,MIN_STOCK
TMP-DEL-1,Main Warehouse,0,0,0`,
    );

    const before = await verifyDb
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(eq(schema.products.businessId, businessId));

    const result = await commitBatch(
      'product',
      `SKU,DESCRIPTION,BRAND,CATG,GROUP,VENDOR,REPLACE_COST
KEEP-1,QUEEN AURORA HYBRID,HELIX,MATT,QUEEN,DIAMO,650.00
NEW-2,KING AURORA HYBRID,HELIX,MATT,KING,DIAMO,900.00`,
      { replaceCatalog: true },
    );
    expect(result.replaced).not.toBeNull();
    expect(result.replaced!.kept).toBe(2);
    expect(result.replaced!.deleted + result.replaced!.deactivated).toBe(before.length - 1);
    expect(result.replaced!.deleted).toBeGreaterThanOrEqual(1);
    expect(result.replaced!.deactivated).toBeGreaterThanOrEqual(1);

    // TMP-DEL-1 (no history) is gone, levels and refs with it.
    const gone = await verifyDb
      .select({ id: schema.productVariants.id })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.sku, 'TMP-DEL-1'));
    expect(gone).toHaveLength(0);
    const refs = await verifyDb
      .select({ id: schema.legacyRefs.id })
      .from(schema.legacyRefs)
      .where(
        and(eq(schema.legacyRefs.entity, 'product'), eq(schema.legacyRefs.legacyId, 'TMP-DEL-1')),
      );
    expect(refs).toHaveLength(0);

    // MAT-Q-FIRM (on order lines) is deactivated, still linked.
    const [mat] = await verifyDb
      .select({ isActive: schema.products.isActive })
      .from(schema.products)
      .where(eq(schema.products.id, matVariant!.productId));
    expect(mat?.isActive).toBe(false);
    const [matV] = await verifyDb
      .select({ isActive: schema.productVariants.isActive })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, matVariant!.id));
    expect(matV?.isActive).toBe(false);
    const linesAfter = await verifyDb
      .select({ id: schema.orderLines.id })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.variantId, matVariant!.id));
    expect(linesAfter).toHaveLength(linesBefore.length);

    // The kept SKU stays active with the refreshed cost; the new one exists.
    const kept = await verifyDb
      .select({
        sku: schema.productVariants.sku,
        costCents: schema.productVariants.costCents,
        isActive: schema.products.isActive,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(inArray(schema.productVariants.sku, ['KEEP-1', 'NEW-2']));
    expect(kept.map((k) => [k.sku, k.costCents, k.isActive]).sort()).toEqual([
      ['KEEP-1', 65_000, true],
      ['NEW-2', 90_000, true],
    ]);

    // A second replace with the same file is a no-op.
    const again = await commitBatch(
      'product',
      `SKU,DESCRIPTION,BRAND,CATG,GROUP,VENDOR,REPLACE_COST
KEEP-1,QUEEN AURORA HYBRID,HELIX,MATT,QUEEN,DIAMO,650.00
NEW-2,KING AURORA HYBRID,HELIX,MATT,KING,DIAMO,900.00`,
      { replaceCatalog: true },
    );
    expect(again.replaced).toEqual({
      kept: 2,
      deleted: 0,
      deactivated: 0,
      deletedSkus: [],
      deactivatedSkus: [],
    });
  });

  it('replace catalog: a product holding stock is retired, not deleted, and names its SKU', async () => {
    // STOCKED-1 has no document history but units on hand; a hard delete
    // would cascade its ledger away.
    await commitBatch(
      'product',
      `SKU,DESCRIPTION,BRAND,CATG,GROUP,VENDOR,REPLACE_COST
KEEP-1,QUEEN AURORA HYBRID,HELIX,MATT,QUEEN,DIAMO,650.00
NEW-2,KING AURORA HYBRID,HELIX,MATT,KING,DIAMO,900.00
STOCKED-1,TWIN AURORA HYBRID,HELIX,MATT,TWIN,DIAMO,400.00`,
    );
    await commitBatch(
      'inventory',
      `SKU,LOCATION,ON_HAND,AS_IS,MIN_STOCK
STOCKED-1,Main Warehouse,3,0,0`,
    );
    const [stocked] = await verifyDb
      .select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.sku, 'STOCKED-1'));

    const result = await commitBatch(
      'product',
      `SKU,DESCRIPTION,BRAND,CATG,GROUP,VENDOR,REPLACE_COST
KEEP-1,QUEEN AURORA HYBRID,HELIX,MATT,QUEEN,DIAMO,650.00
NEW-2,KING AURORA HYBRID,HELIX,MATT,KING,DIAMO,900.00`,
      { replaceCatalog: true },
    );
    expect(result.replaced).toEqual({
      kept: 2,
      deleted: 0,
      deactivated: 1,
      deletedSkus: [],
      deactivatedSkus: ['STOCKED-1'],
    });
    const [product] = await verifyDb
      .select({ isActive: schema.products.isActive })
      .from(schema.products)
      .where(eq(schema.products.id, stocked!.productId));
    expect(product?.isActive).toBe(false);
    const levels = await verifyDb
      .select({ onHand: schema.inventoryLevels.onHand })
      .from(schema.inventoryLevels)
      .where(eq(schema.inventoryLevels.variantId, stocked!.id));
    expect(levels.map((l) => l.onHand)).toEqual([3]);
  });

  it('replace catalog: retires nothing when a row failed, and refuses during a physical count', async () => {
    const before = await verifyDb
      .select({ id: schema.products.id, isActive: schema.products.isActive })
      .from(schema.products)
      .where(eq(schema.products.businessId, businessId));

    // One bad money value: the file did not land whole, so nothing goes.
    const partial = await commitBatch(
      'product',
      `SKU,DESCRIPTION,BRAND,CATG,GROUP,VENDOR,REPLACE_COST
KEEP-1,QUEEN AURORA HYBRID,HELIX,MATT,QUEEN,DIAMO,650.00
BROKEN-1,BROKEN ROW,HELIX,MATT,QUEEN,DIAMO,ABC`,
      { replaceCatalog: true },
      1,
    );
    expect(partial.replaced).toBeNull();
    expect(partial.replaceSkipped).toMatch(/1 of 2 committed/);
    const after = await verifyDb
      .select({ id: schema.products.id, isActive: schema.products.isActive })
      .from(schema.products)
      .where(eq(schema.products.businessId, businessId));
    expect(after).toEqual(before);

    // A count in progress blocks the replace before any row commits.
    const [warehouse] = await verifyDb
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.businessId, businessId),
          eq(schema.locations.name, 'Main Warehouse'),
        ),
      );
    const [count] = await verifyDb
      .insert(schema.physicalCounts)
      .values({
        businessId,
        locationId: warehouse!.id,
        status: 'counting',
        countDate: '2026-09-03',
      })
      .returning({ id: schema.physicalCounts.id });
    const staged = await api()
      .post('/v1/import/batches')
      .send({
        entity: 'product',
        csv: `SKU,DESCRIPTION,BRAND,CATG,GROUP,VENDOR,REPLACE_COST
KEEP-1,QUEEN AURORA HYBRID,HELIX,MATT,QUEEN,DIAMO,650.00`,
      });
    await api().post(`/v1/import/batches/${staged.body.id}/validate`).send({});
    const refused = await api()
      .post(`/v1/import/batches/${staged.body.id}/commit`)
      .send({ replaceCatalog: true });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/physical count is counting/);
    const [batch] = await verifyDb
      .select({ status: schema.importBatches.status })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, staged.body.id));
    expect(batch?.status).toBe('validated');
    await verifyDb.delete(schema.physicalCounts).where(eq(schema.physicalCounts.id, count!.id));
  });
});
