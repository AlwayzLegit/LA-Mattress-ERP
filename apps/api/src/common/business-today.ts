import { and, asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';

/**
 * The calendar date `at` falls on in `timeZone`, as YYYY-MM-DD. `en-CA`
 * formats as YYYY-MM-DD; an unknown zone falls back to UTC rather than
 * failing a request.
 */
export function ymdInTimeZone(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * "Today" for a business: the local date at its stores. `new Date()
 * .toISOString()` is the UTC date, which in Los Angeles turns into
 * tomorrow at 5 PM (4 PM in winter) — schedules then defaulted past
 * today's stops. Reads the timezone of the business's first active
 * store (warehouses last); a business with no location reads UTC.
 */
export async function businessToday(
  db: PostgresJsDatabase,
  businessId: string,
  at: Date = new Date(),
): Promise<string> {
  return ymdInTimeZone(at, await businessTimeZone(db, businessId));
}

/**
 * The business's day clock: the timezone of its first active store
 * (warehouses last). Every report and list day window is cut on it —
 * a business with no location reads UTC.
 */
export async function businessTimeZone(
  db: PostgresJsDatabase,
  businessId: string,
): Promise<string> {
  const [loc] = await db
    .select({ timezone: schema.locations.timezone })
    .from(schema.locations)
    .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
    .orderBy(asc(schema.locations.locationType), asc(schema.locations.createdAt))
    .limit(1);
  return loc?.timezone ?? 'UTC';
}

/** One store's timezone, falling back to the business clock. */
export async function locationTimeZone(
  db: PostgresJsDatabase,
  businessId: string,
  locationId: string,
): Promise<string> {
  const [loc] = await db
    .select({ timezone: schema.locations.timezone })
    .from(schema.locations)
    .where(and(eq(schema.locations.id, locationId), eq(schema.locations.businessId, businessId)))
    .limit(1);
  return loc?.timezone ?? businessTimeZone(db, businessId);
}
