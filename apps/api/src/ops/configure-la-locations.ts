/** Owner-authorized 2026-09-14 cutover. Validate rolls the whole transaction back. */
import postgres from 'postgres';
import { withTenantContext } from '@jetnine/db';

export const STORE_PREFIXES = {
  Koreatown: 'KO',
  'West LA': 'WE',
  'La Brea': 'LB',
  'Studio City': 'ST',
  Warehouse: 'WA',
} as const;

/**
 * Owner 2026-09-19: the invoice prints the selling store's address and
 * phone, taken from mattressstoreslosangeles.com (store pages, Sep 2026).
 * Written into locations.address_json only where no street line is on
 * file yet — an address someone typed in Locations settings is kept.
 * The Warehouse has no public listing; set it in Locations settings.
 */
export const STORE_CONTACT: Record<
  string,
  { line1: string; city: string; region: string; postalCode: string; phone: string }
> = {
  Koreatown: {
    line1: '201 S Western Ave',
    city: 'Los Angeles',
    region: 'CA',
    postalCode: '90004',
    phone: '213-984-4654',
  },
  'West LA': {
    line1: '10861 W Pico Blvd',
    city: 'Los Angeles',
    region: 'CA',
    postalCode: '90064',
    phone: '310-507-8024',
  },
  'La Brea': {
    line1: '300 S La Brea Ave',
    city: 'Los Angeles',
    region: 'CA',
    postalCode: '90036',
    phone: '323-275-4715',
  },
  'Studio City': {
    line1: '12306 Ventura Blvd',
    city: 'Studio City',
    region: 'CA',
    postalCode: '91604',
    phone: '818-766-3500',
  },
};

interface Summary {
  prefixes: { name: string; before: string | null; after: string }[];
  /** Stores whose address/phone were filled from STORE_CONTACT this run. */
  contacts: string[];
  reassignedMembers: string[];
  reassignedShifts: number;
  glendale: 'absent' | 'deleted' | 'archived';
  retainedReferences: { table: string; column: string; count: number }[];
}

class Preview extends Error {
  constructor(readonly summary: Summary) {
    super('Preview rolled back');
  }
}

export async function configureLaLocations(options: {
  databaseUrl: string;
  businessSlug: string;
  mode: 'validate' | 'commit';
}): Promise<Summary> {
  const pg = postgres(options.databaseUrl, { max: 1, prepare: false });
  try {
    const [business] = await pg<{ id: string }[]>`
      SELECT id FROM businesses WHERE slug = ${options.businessSlug}`;
    if (!business) throw new Error('Business not found');
    try {
      return await withTenantContext(pg, { businessId: business.id }, async (tx) => {
        await tx`SET LOCAL lock_timeout = '10s'`;
        const locations = await tx<
          {
            id: string;
            name: string;
            order_prefix: string | null;
            is_active: boolean;
            address_json: Record<string, unknown> | null;
          }[]
        >`SELECT id, name, order_prefix, is_active, address_json FROM locations
          WHERE business_id = ${business.id} ORDER BY id FOR UPDATE`;
        const summary: Summary = {
          prefixes: [],
          contacts: [],
          reassignedMembers: [],
          reassignedShifts: 0,
          glendale: 'absent',
          retainedReferences: [],
        };
        // All five names must match exactly once, and codes cannot belong to another location.
        for (const [name, prefix] of Object.entries(STORE_PREFIXES)) {
          const matches = locations.filter((l) => l.name === name && l.is_active);
          if (matches.length !== 1) throw new Error(`Expected one active location named ${name}`);
          if (locations.some((l) => l.order_prefix === prefix && l.id !== matches[0]!.id)) {
            throw new Error(`Prefix ${prefix} is already assigned to another location`);
          }
        }
        for (const [name, prefix] of Object.entries(STORE_PREFIXES)) {
          const location = locations.find((l) => l.name === name && l.is_active)!;
          if (location.order_prefix !== prefix) {
            await tx`UPDATE locations SET order_prefix = ${prefix}
              WHERE id = ${location.id} AND business_id = ${business.id}`;
            summary.prefixes.push({ name, before: location.order_prefix, after: prefix });
          }
          // Keep existing counters and reserve any already-used numeric suffixes.
          // No sales or historical order numbers are rewritten.
          const [used] = await tx<{ next: number }[]>`
            SELECT greatest(10001, coalesce(max(split_part(number, '-', 2)::int) + 1, 10001)) AS next
            FROM orders WHERE business_id = ${business.id} AND number ~ ${`^${prefix}-[0-9]+$`}`;
          await tx`INSERT INTO order_sequences (business_id, location_id, next_value)
            VALUES (${business.id}, ${location.id}, ${used!.next})
            ON CONFLICT (location_id) DO UPDATE
            SET next_value = greatest(order_sequences.next_value, excluded.next_value)`;
        }
        // Store address + phone for the invoice header (owner 2026-09-19).
        for (const [name, contact] of Object.entries(STORE_CONTACT)) {
          const location = locations.find((l) => l.name === name && l.is_active);
          if (!location) continue;
          const existing = location.address_json ?? {};
          const hasStreet = typeof existing.line1 === 'string' && existing.line1.trim() !== '';
          if (hasStreet && typeof existing.phone === 'string' && existing.phone.trim() !== '')
            continue;
          const next = hasStreet
            ? { ...existing, phone: existing.phone || contact.phone }
            : { ...existing, ...contact };
          await tx`UPDATE locations SET address_json = ${JSON.stringify(next)}::jsonb
            WHERE id = ${location.id} AND business_id = ${business.id}`;
          summary.contacts.push(name);
        }
        const retired = locations.filter((l) => l.name === 'Glendale Store');
        if (retired.length > 1)
          throw new Error('Multiple Glendale locations; refusing an ambiguous move');
        const glendale = retired[0];
        if (glendale) {
          const warehouse = locations.find((l) => l.name === 'Warehouse' && l.is_active)!;
          const assigned = await tx<{ membership_id: string }[]>`
            SELECT membership_id FROM membership_location_scopes
            WHERE business_id = ${business.id} AND location_id = ${glendale.id} ORDER BY membership_id FOR UPDATE`;
          summary.reassignedMembers = assigned.map((m) => m.membership_id);
          // Preserve every other scope and every role/permission, including invited/disabled members.
          await tx`INSERT INTO membership_location_scopes (business_id, membership_id, location_id)
            SELECT business_id, membership_id, ${warehouse.id}::uuid FROM membership_location_scopes
            WHERE business_id = ${business.id} AND location_id = ${glendale.id}
            ON CONFLICT (membership_id, location_id) DO NOTHING`;
          await tx`DELETE FROM membership_location_scopes
            WHERE business_id = ${business.id} AND location_id = ${glendale.id}`;
          const shifts =
            await tx`UPDATE staff_shifts SET location_id = ${warehouse.id}, updated_at = now()
            WHERE business_id = ${business.id} AND location_id = ${glendale.id}
            AND date >= (now() AT TIME ZONE 'America/Los_Angeles')::date RETURNING id`;
          summary.reassignedShifts = shifts.length;
          await tx`UPDATE locations SET is_active = false, replenishment_days_json = '[]'::jsonb
            WHERE business_id = ${business.id} AND id = ${glendale.id}`;
          // Inspect every FK, including cascades and newer modules, before considering deletion.
          const refs = await tx<{ schema_name: string; table_name: string; column_name: string }[]>`
            SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
            FROM pg_constraint fk JOIN pg_class c ON c.oid = fk.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = ANY(fk.conkey)
            WHERE fk.contype = 'f' AND fk.confrelid = 'public.locations'::regclass
            ORDER BY n.nspname, c.relname, a.attname`;
          for (const ref of refs) {
            const [count] = await tx<{ count: number }[]>`
              SELECT count(*)::int AS count FROM ${tx(`${ref.schema_name}.${ref.table_name}`)}
              WHERE ${tx(ref.column_name)} = ${glendale.id}`;
            if (count!.count > 0)
              summary.retainedReferences.push({
                table: ref.table_name,
                column: ref.column_name,
                count: count!.count,
              });
          }
          summary.glendale = summary.retainedReferences.length ? 'archived' : 'deleted';
          if (summary.glendale === 'deleted') {
            await tx`DELETE FROM locations WHERE business_id = ${business.id} AND id = ${glendale.id}`;
          }
        }
        if (
          summary.prefixes.length ||
          summary.contacts.length ||
          summary.reassignedMembers.length ||
          summary.reassignedShifts ||
          (glendale && (glendale.is_active || summary.glendale === 'deleted'))
        ) {
          await tx`INSERT INTO audit_logs (business_id, actor_type, action, target_type, target_id, changes_json)
            VALUES (${business.id}, 'system', 'locations.owner_cutover', 'business', ${business.id},
              ${tx.json({ ...summary, reason: 'Owner requests 2026-09-14 (prefixes) / 2026-09-19 (store contact)' })})`;
        }
        if (options.mode === 'validate') throw new Preview(summary);
        return summary;
      });
    } catch (error) {
      if (error instanceof Preview) return error.summary;
      throw error;
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

if (require.main === module) {
  const mode = process.argv[2];
  if ((mode !== 'validate' && mode !== 'commit') || !process.env.DATABASE_URL) {
    throw new Error('Usage: configure-la-locations validate|commit (DATABASE_URL required)');
  }
  void configureLaLocations({
    databaseUrl: process.env.DATABASE_URL,
    businessSlug: 'la-mattress',
    mode,
  })
    .then((summary) => process.stdout.write(`${JSON.stringify({ mode, ...summary }, null, 2)}\n`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Location cutover failed');
      process.exitCode = 1;
    });
}
