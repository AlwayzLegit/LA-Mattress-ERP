import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { DEFAULT_AS_IS_REASON_CODES } from '@jetnine/shared';

/**
 * Owner 2026-11-02: every business starts with the standard As-Is reasons
 * (damaged, manufacturer defect, comfort exchange, warranty, …) instead of
 * an empty picker the owner has to fill by hand. Both business-creation
 * paths (super-admin and self-service onboarding) call this right after
 * the system roles are seeded; migration 0115 did the same once for the
 * businesses that already existed. A code the business already has is
 * left alone — the unique index on (business, class, code) makes the
 * insert a no-op for it.
 */
export async function seedDefaultReasonCodes(
  db: PostgresJsDatabase,
  businessId: string,
): Promise<void> {
  await db
    .insert(schema.reasonCodes)
    .values(
      DEFAULT_AS_IS_REASON_CODES.map((c) => ({
        businessId,
        code: c.code,
        description: c.description,
        usageClass: 'as_is',
      })),
    )
    .onConflictDoNothing();
}
