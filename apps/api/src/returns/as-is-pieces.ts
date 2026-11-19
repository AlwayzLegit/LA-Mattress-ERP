import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AS_IS_NON_SELLABLE_CONDITIONS } from '../catalog/product-stock';

/**
 * Owner 2026-10-30: selling and moving As-Is pieces by the piece.
 *
 * A piece in the As-Is queue (`pending_review`) can be put on a sales-
 * order line or a transfer line. The piece IS the reservation — it goes
 * `committed` while the line holds it, `in_transit` once a transfer
 * ships it, `sold` once the order fulfills it, and back to
 * `pending_review` (at the destination, for a transfer) when the hold
 * ends. Stock levels never move for an as-is piece: it was never in
 * sellable stock, and the Products browser already counts it under
 * As-Is on hand / available.
 *
 * Every helper takes the request's transactional `db` so the piece
 * flips together with the line that holds it.
 */

export type AsIsPiece = typeof schema.asIsItems.$inferSelect;

/** Conditions the queue treats as not sellable (damaged, parts). */
export function isSellableCondition(condition: string | null): boolean {
  return !(AS_IS_NON_SELLABLE_CONDITIONS as readonly string[]).includes(condition ?? '');
}

function label(piece: { id: string; pieceNumber: string | null }): string {
  return piece.pieceNumber ?? piece.id.slice(0, 8);
}

/**
 * Load a piece that a line wants to take, checking it belongs to this
 * business, is the line's item, is still free and is sellable. Locks
 * the row for the transaction so two registers can't take one piece.
 */
export async function loadFreePiece(
  db: PostgresJsDatabase,
  args: { businessId: string; pieceId: string; variantId?: string | null; locationId?: string },
): Promise<AsIsPiece> {
  const [piece] = await db
    .select()
    .from(schema.asIsItems)
    .where(
      and(eq(schema.asIsItems.id, args.pieceId), eq(schema.asIsItems.businessId, args.businessId)),
    )
    .limit(1)
    .for('update');
  if (!piece) throw new NotFoundException('As-Is piece not found');
  if (args.variantId && piece.variantId !== args.variantId) {
    throw new BadRequestException(`As-Is piece ${label(piece)} is a different item than the line`);
  }
  if (args.locationId && piece.locationId !== args.locationId) {
    throw new BadRequestException(
      `As-Is piece ${label(piece)} is not at the line's source location`,
    );
  }
  if (piece.status !== 'pending_review') {
    const held = ['committed', 'in_transit', 'sold'].includes(piece.status);
    throw new BadRequestException(
      held
        ? `As-Is piece ${label(piece)} is already ${piece.status.replace('_', ' ')} on another document`
        : `As-Is piece ${label(piece)} is ${piece.status.replace('_', ' ')} — not in the queue`,
    );
  }
  if (!isSellableCondition(piece.condition)) {
    throw new BadRequestException(
      `As-Is piece ${label(piece)} is marked ${piece.condition} — not sellable`,
    );
  }
  if (piece.quantity !== 1) {
    throw new BadRequestException(
      `As-Is piece ${label(piece)} carries ${piece.quantity} units — split it in the As-Is queue first`,
    );
  }
  return piece;
}

/** Hold the piece for an order line. */
export async function commitPieceToOrderLine(
  db: PostgresJsDatabase,
  pieceId: string,
  orderLineId: string,
): Promise<void> {
  await db
    .update(schema.asIsItems)
    .set({ status: 'committed', orderLineId, transferLineId: null })
    .where(eq(schema.asIsItems.id, pieceId));
}

/** Hold the piece for a draft transfer line. */
export async function commitPieceToTransferLine(
  db: PostgresJsDatabase,
  pieceId: string,
  transferLineId: string,
): Promise<void> {
  await db
    .update(schema.asIsItems)
    .set({ status: 'committed', transferLineId, orderLineId: null })
    .where(eq(schema.asIsItems.id, pieceId));
}

/**
 * Let go of a held piece: back to the queue where it physically sits.
 * Only a `committed` piece can be released — a sold or in-transit one
 * has left. Returns whether anything changed.
 */
export async function releasePiece(db: PostgresJsDatabase, pieceId: string): Promise<boolean> {
  const rows = await db
    .update(schema.asIsItems)
    .set({ status: 'pending_review', orderLineId: null, transferLineId: null })
    .where(and(eq(schema.asIsItems.id, pieceId), eq(schema.asIsItems.status, 'committed')))
    .returning({ id: schema.asIsItems.id });
  return rows.length > 0;
}

/** The order fulfilled: the piece left with the customer. */
export async function sellPiece(
  db: PostgresJsDatabase,
  pieceId: string,
  orderLineId: string,
): Promise<void> {
  await db
    .update(schema.asIsItems)
    .set({ status: 'sold', orderLineId })
    .where(
      and(
        eq(schema.asIsItems.id, pieceId),
        inArray(schema.asIsItems.status, ['committed', 'pending_review']),
      ),
    );
}

/** The transfer shipped: the pieces are on the truck. */
export async function shipPieces(db: PostgresJsDatabase, pieceIds: string[]): Promise<void> {
  if (pieceIds.length === 0) return;
  await db
    .update(schema.asIsItems)
    .set({ status: 'in_transit' })
    .where(and(inArray(schema.asIsItems.id, pieceIds), eq(schema.asIsItems.status, 'committed')));
}

/** The transfer received: the piece joins the destination's queue. */
export async function arrivePiece(
  db: PostgresJsDatabase,
  pieceId: string,
  locationId: string,
): Promise<void> {
  await db
    .update(schema.asIsItems)
    .set({ status: 'pending_review', locationId, transferLineId: null, orderLineId: null })
    .where(eq(schema.asIsItems.id, pieceId));
}

export interface FreePieceRow {
  id: string;
  pieceNumber: string | null;
  condition: string | null;
  asIsPriceCents: number | null;
  storageLocation: string | null;
  source: string;
  notes: string | null;
  createdAt: Date;
  /** False for damaged / parts pieces and legacy multi-unit rows. */
  sellable: boolean;
}

/** Pieces of one item in one location's queue, oldest first (the picker list). */
export async function listFreePieces(
  db: PostgresJsDatabase,
  args: { businessId: string; variantId: string; locationId: string },
): Promise<FreePieceRow[]> {
  const rows = await db
    .select({
      id: schema.asIsItems.id,
      pieceNumber: schema.asIsItems.pieceNumber,
      condition: schema.asIsItems.condition,
      asIsPriceCents: schema.asIsItems.asIsPriceCents,
      storageLocation: schema.asIsItems.storageLocation,
      source: schema.asIsItems.source,
      notes: schema.asIsItems.notes,
      createdAt: schema.asIsItems.createdAt,
      quantity: schema.asIsItems.quantity,
    })
    .from(schema.asIsItems)
    .where(
      and(
        eq(schema.asIsItems.businessId, args.businessId),
        eq(schema.asIsItems.variantId, args.variantId),
        eq(schema.asIsItems.locationId, args.locationId),
        eq(schema.asIsItems.status, 'pending_review'),
      ),
    )
    .orderBy(schema.asIsItems.createdAt);
  return rows.map(({ quantity, ...r }) => ({
    ...r,
    sellable: isSellableCondition(r.condition) && quantity === 1,
  }));
}

/**
 * Correlated count of sellable as-is pieces of a variant — the product
 * search's "As-is at {store}" column. Pass null for every store.
 */
export function freeAsIsCountSql(
  variantIdCol: SQL | unknown,
  locationId: string | null,
): SQL<number> {
  // A JS array in a sql template renders as a tuple (a record), which
  // Postgres cannot cast to text[] — so the list is joined as parameters.
  const nonSellable = sql.join(
    AS_IS_NON_SELLABLE_CONDITIONS.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql<number>`(
    SELECT count(*)::int FROM as_is_items a
    WHERE a.variant_id = ${variantIdCol as SQL}
      AND a.status = 'pending_review'
      AND a.quantity = 1
      AND coalesce(a.condition, '') NOT IN (${nonSellable})
      ${locationId ? sql`AND a.location_id = ${locationId}` : sql``}
  )`;
}

/** The piece each line holds, keyed by line id — for the detail hydrates. */
export async function piecesByLine(
  db: PostgresJsDatabase,
  pieceIds: string[],
): Promise<
  Map<
    string,
    {
      id: string;
      pieceNumber: string | null;
      condition: string | null;
      asIsPriceCents: number | null;
      storageLocation: string | null;
      status: string;
      locationId: string;
    }
  >
> {
  const out = new Map<
    string,
    {
      id: string;
      pieceNumber: string | null;
      condition: string | null;
      asIsPriceCents: number | null;
      storageLocation: string | null;
      status: string;
      locationId: string;
    }
  >();
  const ids = [...new Set(pieceIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: schema.asIsItems.id,
      pieceNumber: schema.asIsItems.pieceNumber,
      condition: schema.asIsItems.condition,
      asIsPriceCents: schema.asIsItems.asIsPriceCents,
      storageLocation: schema.asIsItems.storageLocation,
      status: schema.asIsItems.status,
      locationId: schema.asIsItems.locationId,
    })
    .from(schema.asIsItems)
    .where(inArray(schema.asIsItems.id, ids));
  for (const r of rows) out.set(r.id, r);
  return out;
}
