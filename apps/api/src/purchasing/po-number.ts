import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';

/**
 * `PO-<year>-<seq>` per business, retrying past a collision. Shared by
 * the sales-rate replenishment PO builder and the Replenish screen.
 */
export async function generatePoNumber(
  db: PostgresJsDatabase,
  businessId: string,
): Promise<string> {
  const year = new Date().getUTCFullYear();
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.businessId, businessId),
          sql`${schema.purchaseOrders.number} LIKE ${`PO-${year}-%`}`,
        ),
      );
    const seq = (rows[0]?.count ?? 0) + 1 + attempt;
    const candidate = `PO-${year}-${String(seq).padStart(6, '0')}`;
    const [existing] = await db
      .select({ id: schema.purchaseOrders.id })
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.businessId, businessId),
          eq(schema.purchaseOrders.number, candidate),
        ),
      )
      .limit(1);
    if (!existing) return candidate;
  }
  return `PO-${year}-${Date.now().toString().slice(-6)}`;
}
