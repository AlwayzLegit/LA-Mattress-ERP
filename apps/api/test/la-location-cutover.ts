import postgres from 'postgres';
import { expect } from 'vitest';
import { configureLaLocations, STORE_PREFIXES } from '../src/ops/configure-la-locations';

/** Runs inside the business integration suite's freshly migrated database. */
export async function verifyLocationCutover(databaseUrl: string) {
  const pg = postgres(databaseUrl, { max: 1, prepare: false });
  const slug = `location-cutover-${Date.now()}`;
  try {
    const [biz] = await pg`INSERT INTO businesses (slug, name, status)
      VALUES (${slug}, 'Cutover Test', 'active') RETURNING id`;
    const businessId = biz!.id;
    const ids: Record<string, string> = {};
    for (const name of [...Object.keys(STORE_PREFIXES), 'Glendale Store']) {
      const [loc] = await pg`INSERT INTO locations (business_id, name, timezone, location_type)
        VALUES (${businessId}, ${name}, 'America/Los_Angeles', ${name === 'Warehouse' ? 'warehouse' : 'store'}) RETURNING id`;
      ids[name] = loc!.id;
    }
    const [role] =
      await pg`INSERT INTO roles (business_id, name) VALUES (${businessId}, 'Test') RETURNING id`;
    const members: string[] = [];
    for (const status of ['active', 'invited', 'disabled']) {
      const [user] =
        await pg`INSERT INTO users (email, name) VALUES (${`${slug}-${status}@test.local`}, ${status}) RETURNING id`;
      const [member] =
        await pg`INSERT INTO memberships (business_id, user_id, role_id, status, data_scope, selling_scope)
        VALUES (${businessId}, ${user!.id}, ${role!.id}, ${status}, 'store', 'approved') RETURNING id`;
      members.push(member!.id);
      for (const name of status === 'active'
        ? ['Glendale Store', 'La Brea']
        : ['Glendale Store', 'Warehouse', 'La Brea']) {
        await pg`INSERT INTO membership_location_scopes (business_id, membership_id, location_id)
          VALUES (${businessId}, ${member!.id}, ${ids[name]!})`;
      }
    }
    const [customer] = await pg`INSERT INTO customers (business_id, first_name, last_name)
      VALUES (${businessId}, 'Historic', 'Customer') RETURNING id`;
    for (const [name, number] of [
      ['Glendale Store', 'SO-2026-000123'],
      ['Koreatown', 'KO-10050'],
    ]) {
      await pg`INSERT INTO orders (business_id, location_id, customer_id, number, status)
        VALUES (${businessId}, ${ids[name!]!}, ${customer!.id}, ${number!}, 'completed')`;
    }
    await pg`INSERT INTO order_sequences (business_id, location_id, next_value)
      VALUES (${businessId}, ${ids.Warehouse!}, 10222)`;
    for (const offset of [-1, 1]) {
      await pg`INSERT INTO staff_shifts (business_id, membership_id, location_id, date, start_minutes, end_minutes)
        VALUES (${businessId}, ${members[0]!}, ${ids['Glendale Store']!},
          (now() AT TIME ZONE 'America/Los_Angeles')::date + ${offset}::int, 600, 900)`;
    }
    const before =
      await pg`SELECT id, number, location_id FROM orders WHERE business_id = ${businessId} ORDER BY id`;
    const options = { databaseUrl, businessSlug: slug };
    const preview = await configureLaLocations({ ...options, mode: 'validate' });
    expect(preview.prefixes).toHaveLength(5);
    expect(preview.reassignedMembers.sort()).toEqual(members.sort());
    expect(preview.reassignedShifts).toBe(1);
    expect(preview.glendale).toBe('archived');
    const [unchanged] = await pg`SELECT order_prefix FROM locations WHERE id = ${ids.Koreatown!}`;
    expect(unchanged!.order_prefix).toBe(null);
    const [stillActive] =
      await pg`SELECT is_active FROM locations WHERE id = ${ids['Glendale Store']!}`;
    expect(stillActive!.is_active).toBe(true);
    expect(
      (
        await pg`SELECT * FROM membership_location_scopes WHERE location_id = ${ids['Glendale Store']!}`
      ).length,
    ).toBe(3);
    const committed = await configureLaLocations({ ...options, mode: 'commit' });
    expect(committed).toEqual(preview);
    expect(
      await pg`SELECT id, number, location_id FROM orders WHERE business_id = ${businessId} ORDER BY id`,
    ).toEqual(before);
    expect(
      (
        await pg`SELECT * FROM membership_location_scopes WHERE location_id = ${ids['Glendale Store']!}`
      ).length,
    ).toBe(0);
    const scopes =
      await pg`SELECT location_id FROM membership_location_scopes WHERE business_id = ${businessId}`;
    expect(scopes).toHaveLength(6);
    expect(new Set(scopes.map((s) => s.location_id))).toEqual(
      new Set([ids.Warehouse, ids['La Brea']]),
    );
    expect(
      (
        await pg`SELECT status, role_id, data_scope, selling_scope FROM memberships WHERE business_id = ${businessId}`
      ).every(
        (m) => m.role_id === role!.id && m.data_scope === 'store' && m.selling_scope === 'approved',
      ),
    ).toBe(true);
    const counters =
      await pg`SELECT location_id, next_value FROM order_sequences WHERE business_id = ${businessId}`;
    expect(counters.find((c) => c.location_id === ids.Koreatown)!.next_value).toBe(10051);
    expect(counters.find((c) => c.location_id === ids.Warehouse)!.next_value).toBe(10222);
    const again = await configureLaLocations({ ...options, mode: 'commit' });
    expect(again.prefixes).toHaveLength(0);
    expect(again.reassignedMembers).toHaveLength(0);
    expect(again.reassignedShifts).toBe(0);
    expect(
      (
        await pg`SELECT * FROM audit_logs WHERE business_id = ${businessId} AND action = 'locations.owner_cutover'`
      ).length,
    ).toBe(1);
    // Another tenant's location and number remain untouched.
    const [other] =
      await pg`INSERT INTO businesses (slug, name, status) VALUES (${`${slug}-other`}, 'Other', 'active') RETURNING id`;
    await pg`INSERT INTO locations (business_id, name, timezone, order_prefix)
      VALUES (${other!.id}, 'Koreatown', 'America/Los_Angeles', 'ZZ')`;
    await pg`DELETE FROM staff_shifts WHERE business_id = ${businessId}`;
    await pg`DELETE FROM orders WHERE business_id = ${businessId}`;
    expect((await configureLaLocations({ ...options, mode: 'commit' })).glendale).toBe('deleted');
    expect((await configureLaLocations({ ...options, mode: 'commit' })).glendale).toBe('absent');
    const [otherLocation] =
      await pg`SELECT order_prefix FROM locations WHERE business_id = ${other!.id}`;
    expect(otherLocation!.order_prefix).toBe('ZZ');
  } finally {
    await pg.end({ timeout: 5 });
  }
}
