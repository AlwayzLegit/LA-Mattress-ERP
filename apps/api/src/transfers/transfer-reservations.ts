import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';

/**
 * A10 (owner 2026-11-02): an open transfer holds its units at the origin
 * the way an open sales order does. Creating a transfer bumps
 * `inventory_levels.reserved` at the origin for every line, so the
 * units stop being available to the register, to other transfers and to
 * As-Is moves while the transfer waits to ship; shipping releases the
 * hold as it deducts on-hand, and cancelling releases it outright.
 *
 * Mirrors `OrdersService.applyReservations` / `applyReleases`: the hold
 * moves `reserved`, never `on_hand`, and writes a delta-0 movement so the
 * ledger explains why available stock dropped (D3 — movements stay the
 * single audit trail).
 */
export const TRANSFER_RESERVE_REASON = 'transfer_reserve';
export const TRANSFER_RELEASE_REASON = 'transfer_release';

export interface TransferHoldLine {
  variantId: string;
  quantity: number;
}

export interface TransferHoldArgs {
  businessId: string;
  actorUserId: string | null;
  transferId: string;
  fromLocationId: string;
  lines: readonly TransferHoldLine[];
}

export async function reserveTransferOrigin(
  db: PostgresJsDatabase,
  args: TransferHoldArgs,
): Promise<void> {
  for (const l of args.lines) {
    if (l.quantity <= 0) continue;
    await db
      .insert(schema.inventoryLevels)
      .values({
        businessId: args.businessId,
        variantId: l.variantId,
        locationId: args.fromLocationId,
        onHand: 0,
        reserved: l.quantity,
      })
      .onConflictDoUpdate({
        target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
        set: {
          reserved: sql`${schema.inventoryLevels.reserved} + ${l.quantity}`,
          updatedAt: new Date(),
        },
      });
    await db.insert(schema.inventoryMovements).values({
      businessId: args.businessId,
      variantId: l.variantId,
      locationId: args.fromLocationId,
      delta: 0,
      reason: TRANSFER_RESERVE_REASON,
      referenceType: 'stock_transfer',
      referenceId: args.transferId,
      actorUserId: args.actorUserId,
      notes: `reserved ${l.quantity}`,
    });
  }
}

/**
 * Hand the held units back. `reserved` is floored at zero, as the order
 * release is — a negative counter would make every availability read
 * wrong.
 */
export async function releaseTransferOrigin(
  db: PostgresJsDatabase,
  args: TransferHoldArgs,
): Promise<void> {
  for (const l of args.lines) {
    if (l.quantity <= 0) continue;
    await db
      .update(schema.inventoryLevels)
      .set({
        reserved: sql`GREATEST(0, ${schema.inventoryLevels.reserved} - ${l.quantity})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.inventoryLevels.variantId, l.variantId),
          eq(schema.inventoryLevels.locationId, args.fromLocationId),
        ),
      );
    await db.insert(schema.inventoryMovements).values({
      businessId: args.businessId,
      variantId: l.variantId,
      locationId: args.fromLocationId,
      delta: 0,
      reason: TRANSFER_RELEASE_REASON,
      referenceType: 'stock_transfer',
      referenceId: args.transferId,
      actorUserId: args.actorUserId,
      notes: `released ${l.quantity}`,
    });
  }
}
