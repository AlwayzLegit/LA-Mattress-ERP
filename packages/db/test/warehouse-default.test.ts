/**
 * Migration 0104 — the warehouse becomes the default stock source
 * (HANDOFF_inventory_source_defaults §2 step 3). The migration has already
 * run against an empty database by the time tests start, so this replays
 * its statements over fixtures shaped like production: a business whose
 * "Warehouse" is still typed store, one that already has two warehouses,
 * and one with a default of its own.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { businesses, locations } from '../src/schema';

const url =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/jetnine_test';
const root = postgres(url, { max: 2, prepare: false });
const db = drizzle(root);

const statements = readFileSync(
  join(__dirname, '..', 'drizzle', '0104_warehouse_source_default.sql'),
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);

async function replay() {
  for (const s of statements) await root.unsafe(s);
}

let plain = '';
let twoWarehouses = '';
let configured = '';
let plainWarehouse = '';
let ownChoice = '';

beforeAll(async () => {
  await root.unsafe(`TRUNCATE businesses, locations RESTART IDENTITY CASCADE`);
  const [a] = await db
    .insert(businesses)
    .values({ slug: 'wh-plain', name: 'Plain', status: 'active' })
    .returning();
  const [b] = await db
    .insert(businesses)
    .values({ slug: 'wh-two', name: 'Two warehouses', status: 'active' })
    .returning();
  const [c] = await db
    .insert(businesses)
    .values({ slug: 'wh-configured', name: 'Configured', status: 'active' })
    .returning();
  plain = a!.id;
  twoWarehouses = b!.id;
  configured = c!.id;
  const tz = 'America/Los_Angeles';
  const rows = await db
    .insert(locations)
    .values([
      { businessId: plain, name: 'Glendale Store', timezone: tz },
      { businessId: plain, name: ' Warehouse ', timezone: tz }, // typed store by 0066
      { businessId: plain, name: 'Warehouse Outlet', timezone: tz }, // only sounds like one
      { businessId: twoWarehouses, name: 'Warehouse', locationType: 'warehouse', timezone: tz },
      { businessId: twoWarehouses, name: 'East DC', locationType: 'warehouse', timezone: tz },
      { businessId: configured, name: 'Main Store', timezone: tz },
      { businessId: configured, name: 'Warehouse', timezone: tz },
    ])
    .returning({ id: locations.id, name: locations.name, businessId: locations.businessId });
  plainWarehouse = rows.find((r) => r.businessId === plain && r.name === ' Warehouse ')!.id;
  ownChoice = rows.find((r) => r.businessId === configured && r.name === 'Main Store')!.id;
  await db
    .update(businesses)
    .set({ opsSettingsJson: { recyclingFeeCents: 1800, defaultSourceLocationId: ownChoice } })
    .where(eq(businesses.id, configured));
});

afterAll(async () => {
  await root.end({ timeout: 5 });
});

async function ops(id: string) {
  const [b] = await db
    .select({ ops: businesses.opsSettingsJson })
    .from(businesses)
    .where(eq(businesses.id, id));
  return (b!.ops ?? {}) as Record<string, unknown>;
}

describe('0104 warehouse source default', () => {
  it('marks the location named Warehouse and makes it the default stock source', async () => {
    await replay();
    const locs = await db
      .select({ name: locations.name, locationType: locations.locationType })
      .from(locations)
      .where(eq(locations.businessId, plain));
    expect(Object.fromEntries(locs.map((l) => [l.name.trim(), l.locationType]))).toEqual({
      'Glendale Store': 'store',
      Warehouse: 'warehouse',
      'Warehouse Outlet': 'store',
    });
    expect(await ops(plain)).toEqual({ defaultSourceLocationId: plainWarehouse });
  });

  it('leaves a business with two warehouses to choose, and never overwrites a configured default', async () => {
    expect((await ops(twoWarehouses)).defaultSourceLocationId).toBeUndefined();
    const own = await ops(configured);
    expect(own.defaultSourceLocationId).toBe(ownChoice);
    expect(own.recyclingFeeCents).toBe(1800);
    // The Warehouse of the configured business is still typed, so the
    // register's implicit single-warehouse step reads it too.
    const [wh] = await db
      .select({ locationType: locations.locationType })
      .from(locations)
      .where(eq(locations.businessId, configured))
      .then((rows) => rows.filter((r) => r.locationType === 'warehouse'));
    expect(wh).toBeTruthy();
  });

  it('is idempotent', async () => {
    await replay();
    expect(await ops(plain)).toEqual({ defaultSourceLocationId: plainWarehouse });
    expect(await ops(configured)).toMatchObject({ defaultSourceLocationId: ownChoice });
  });
});
