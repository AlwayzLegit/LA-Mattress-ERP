import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CostingService } from '../costing/costing.service';
import { DRIZZLE } from '../database/database.module';
import { computeTotals } from '../sales/totals';
import {
  planReleases,
  planReservations,
  type FulfillmentStep,
  type Release,
  type Reservation,
  type Shortfall,
  type StockLevel,
} from './order-math';

export interface OrderTotalsSnapshot {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Order-side operations that outlive the controller: stock commitment
 * and totals maintenance. The delivery/fulfillment flow (Day 3) calls the
 * same reserve/release primitives, so they live here rather than inline
 * in the controller.
 *
 * Every method takes the caller's `db` handle. Inside a request that is
 * the RLS transaction opened by `RlsContextInterceptor`, which is what
 * makes a failure anywhere in a multi-step write roll the whole thing
 * back — including the inventory side effects.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(CostingService) private readonly costing: CostingService,
  ) {}

  /**
   * B14 backfill: reserve stock for confirmed order lines that could not
   * reserve when they were written ("Pending" in the list view). Priority
   * is the business's reservation basis — `delivery_date` (owner-chosen
   * default: earliest line delivery date, falling back to the order's
   * requested date, nulls last) or `order_date` (first written, first
   * served). Runs after stock arrives and on demand; it only consumes
   * free stock — it never takes an existing reservation away from a
   * later order (flagged convention; stealing is a human decision).
   */
  async allocatePending(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      actorUserId: string | null;
      basis: 'delivery_date' | 'order_date';
      /** Restrict to these variants (e.g. what a PO receipt just added). */
      variantIds?: readonly string[];
      dryRun?: boolean;
    },
  ): Promise<
    {
      orderId: string;
      number: string;
      lines: { orderLineId: string; variantId: string; quantity: number }[];
    }[]
  > {
    const need = sql`${schema.orderLines.quantity} - ${schema.orderLines.qtyReserved} - ${schema.orderLines.qtyFulfilled}`;
    const basisDate =
      args.basis === 'delivery_date'
        ? sql`coalesce(${schema.orderLines.deliveryDate}, ${schema.orders.requestedDate})`
        : sql`NULL`;
    const filters = [
      eq(schema.orders.businessId, args.businessId),
      inArray(schema.orders.status, ['open', 'partially_fulfilled']),
      sql`${schema.orders.lockedAt} IS NULL`,
      eq(schema.orderLines.lineType, 'stock'),
      sql`${need} > 0`,
    ];
    if (args.variantIds && args.variantIds.length > 0) {
      filters.push(inArray(schema.orderLines.variantId, [...new Set(args.variantIds)]));
    }
    const rows = await db
      .select({
        orderId: schema.orders.id,
        number: schema.orders.number,
        locationId: sql<string>`coalesce(${schema.orderLines.sourceLocationId}, ${schema.orders.stockLocationId}, ${schema.orders.locationId})`,
        orderLineId: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        need: sql<number>`${need}`,
        basisDate: sql<string | null>`${basisDate}`,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .where(and(...filters))
      .orderBy(
        args.basis === 'delivery_date'
          ? sql`coalesce(${schema.orderLines.deliveryDate}, ${schema.orders.requestedDate}) ASC NULLS LAST`
          : asc(schema.orders.createdAt),
        asc(schema.orders.createdAt),
        asc(schema.orderLines.id),
      )
      .limit(500);
    if (rows.length === 0) return [];

    // Free stock per (location, variant), locked for the transaction so a
    // concurrent register sale can't double-commit the same unit.
    const byLocation = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.variantId) continue;
      if (!byLocation.has(r.locationId)) byLocation.set(r.locationId, new Set());
      byLocation.get(r.locationId)!.add(r.variantId);
    }
    const free = new Map<string, number>();
    for (const [locationId, variants] of byLocation) {
      const levels = await this.stockLevels(db, locationId, [...variants], {
        lock: !args.dryRun,
      });
      for (const [variantId, level] of levels) {
        free.set(`${locationId}:${variantId}`, Math.max(0, level.onHand - level.reserved));
      }
    }

    // Grouped per (order, source location): with per-line fulfill-from,
    // one order's lines can reserve at different locations.
    const byOrderLoc = new Map<
      string,
      {
        orderId: string;
        number: string;
        locationId: string;
        lines: { orderLineId: string; variantId: string; quantity: number }[];
      }
    >();
    for (const r of rows) {
      if (!r.variantId) continue;
      const key = `${r.locationId}:${r.variantId}`;
      const available = free.get(key) ?? 0;
      if (available <= 0) continue;
      const take = Math.min(available, r.need);
      if (take <= 0) continue;
      free.set(key, available - take);
      const groupKey = `${r.orderId}:${r.locationId}`;
      if (!byOrderLoc.has(groupKey)) {
        byOrderLoc.set(groupKey, {
          orderId: r.orderId,
          number: r.number,
          locationId: r.locationId,
          lines: [],
        });
      }
      byOrderLoc
        .get(groupKey)!
        .lines.push({ orderLineId: r.orderLineId, variantId: r.variantId, quantity: take });
    }

    const groups = [...byOrderLoc.values()];
    if (!args.dryRun) {
      for (const a of groups) {
        await this.applyReservations(db, {
          businessId: args.businessId,
          orderId: a.orderId,
          locationId: a.locationId,
          actorUserId: args.actorUserId,
          reservations: a.lines.map((l) => ({
            orderLineId: l.orderLineId,
            variantId: l.variantId,
            quantity: l.quantity,
          })),
        });
      }
    }
    // Report per order (the callers' shape), merging location groups.
    const byOrder = new Map<
      string,
      {
        orderId: string;
        number: string;
        lines: { orderLineId: string; variantId: string; quantity: number }[];
      }
    >();
    for (const g of groups) {
      if (!byOrder.has(g.orderId)) {
        byOrder.set(g.orderId, { orderId: g.orderId, number: g.number, lines: [] });
      }
      byOrder.get(g.orderId)!.lines.push(...g.lines);
    }
    return [...byOrder.values()];
  }

  /**
   * Read current stock for a set of variants at one location, keyed by
   * variant id. Variants with no `inventory_levels` row are simply
   * absent — `planReservations` reads that as zero available.
   */
  async stockLevels(
    db: PostgresJsDatabase,
    locationId: string,
    variantIds: readonly string[],
    opts: { lock?: boolean } = {},
  ): Promise<Map<string, StockLevel>> {
    if (variantIds.length === 0) return new Map();
    const query = db
      .select({
        variantId: schema.inventoryLevels.variantId,
        onHand: schema.inventoryLevels.onHand,
        reserved: schema.inventoryLevels.reserved,
        floorSample: schema.inventoryLevels.floorSample,
      })
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.locationId, locationId),
          inArray(schema.inventoryLevels.variantId, [...new Set(variantIds)]),
        ),
      );
    // Reserving is read-then-write: without a lock, two registers can both
    // read "1 available" and both commit it. Locking the level rows for the
    // rest of the request transaction serializes them, so the second one
    // sees the first one's reservation and reports a shortfall instead.
    //
    // A variant with no level row yet cannot be locked (there is no row),
    // but it also has nothing to reserve — planReservations reads a missing
    // row as zero available — so the unprotected case commits nothing.
    const rows = await (opts.lock ? query.for('update') : query);
    // J2: floor samples are physically on hand but never part of the
    // sellable pool — netting them out here covers reservation planning
    // and pending-allocation backfill in one place.
    return new Map(
      rows.map((r) => [r.variantId, { onHand: r.onHand - r.floorSample, reserved: r.reserved }]),
    );
  }

  /**
   * Commit units to an order: bump `inventory_levels.reserved`, bump the
   * line's `qty_reserved`, and write an `order_reserve` movement per line
   * (D3 — movements stay the single audit trail).
   *
   * Reservations move `reserved`, never `on_hand`: the goods are still in
   * the building, they are just spoken for. `on_hand` drops at
   * fulfillment.
   */
  async applyReservations(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      orderId: string;
      locationId: string;
      actorUserId: string | null;
      reservations: readonly Reservation[];
    },
  ): Promise<void> {
    for (const r of args.reservations) {
      await db
        .update(schema.orderLines)
        .set({ qtyReserved: sql`${schema.orderLines.qtyReserved} + ${r.quantity}` })
        .where(eq(schema.orderLines.id, r.orderLineId));

      await db
        .insert(schema.inventoryLevels)
        .values({
          businessId: args.businessId,
          variantId: r.variantId,
          locationId: args.locationId,
          onHand: 0,
          reserved: r.quantity,
        })
        .onConflictDoUpdate({
          target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
          set: {
            reserved: sql`${schema.inventoryLevels.reserved} + ${r.quantity}`,
            updatedAt: new Date(),
          },
        });

      // Delta is 0 because on-hand did not change — the movement records
      // the commitment itself, which is what the audit trail needs to
      // explain why available stock dropped.
      await db.insert(schema.inventoryMovements).values({
        businessId: args.businessId,
        variantId: r.variantId,
        locationId: args.locationId,
        delta: 0,
        reason: 'order_reserve',
        referenceType: 'order',
        referenceId: args.orderId,
        actorUserId: args.actorUserId,
        notes: `reserved ${r.quantity}`,
      });
    }
  }

  /**
   * Hand committed units back to available stock. Mirrors
   * `applyReservations`; used by cancel and by line removal.
   *
   * `reserved` is floored at zero defensively — a negative reservation
   * count would make every availability read wrong, and no amount of
   * upstream care is worth trusting a counter that can go negative.
   */
  async applyReleases(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      orderId: string;
      locationId: string;
      actorUserId: string | null;
      releases: readonly Release[];
      /** Skip the order_lines write when the lines are being deleted anyway. */
      updateLines?: boolean;
    },
  ): Promise<void> {
    const updateLines = args.updateLines ?? true;
    for (const r of args.releases) {
      if (updateLines) {
        await db
          .update(schema.orderLines)
          .set({
            qtyReserved: sql`GREATEST(0, ${schema.orderLines.qtyReserved} - ${r.quantity})`,
          })
          .where(eq(schema.orderLines.id, r.orderLineId));
      }

      await db
        .update(schema.inventoryLevels)
        .set({
          reserved: sql`GREATEST(0, ${schema.inventoryLevels.reserved} - ${r.quantity})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, r.variantId),
            eq(schema.inventoryLevels.locationId, args.locationId),
          ),
        );

      await db.insert(schema.inventoryMovements).values({
        businessId: args.businessId,
        variantId: r.variantId,
        locationId: args.locationId,
        delta: 0,
        reason: 'order_release',
        referenceType: 'order',
        referenceId: args.orderId,
        actorUserId: args.actorUserId,
        notes: `released ${r.quantity}`,
      });
    }
  }

  /**
   * Reserve as much of an order as stock allows, returning what could not
   * be covered. Idempotent by construction: `planReservations` only ever
   * asks for the units a line still lacks, so calling this twice in a row
   * reserves nothing the second time.
   */
  async reserveOrder(
    db: PostgresJsDatabase,
    args: { businessId: string; orderId: string; locationId: string; actorUserId: string | null },
  ): Promise<{ reservations: Reservation[]; shortfalls: Shortfall[] }> {
    const lines = await db
      .select({
        id: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        lineType: schema.orderLines.lineType,
        sourceLocationId: schema.orderLines.sourceLocationId,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, args.orderId));

    // Per-line fulfill-from: each line reserves at its own source
    // (line override, else args.locationId — the order's default). Lines
    // are grouped so each location's levels are read and locked once.
    const groups = new Map<string, typeof lines>();
    for (const l of lines) {
      const loc = l.sourceLocationId ?? args.locationId;
      if (!groups.has(loc)) groups.set(loc, []);
      groups.get(loc)!.push(l);
    }
    const merged = { reservations: [] as Reservation[], shortfalls: [] as Shortfall[] };
    for (const [loc, group] of groups) {
      const variantIds = group.map((l) => l.variantId).filter((id): id is string => Boolean(id));
      const levels = await this.stockLevels(db, loc, variantIds, { lock: true });
      const plan = planReservations(group, levels);
      await this.applyReservations(db, {
        ...args,
        locationId: loc,
        reservations: plan.reservations,
      });
      merged.reservations.push(...plan.reservations);
      merged.shortfalls.push(...plan.shortfalls);
    }
    return merged;
  }

  /** Release everything an order currently holds. */
  async releaseOrder(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      orderId: string;
      locationId: string;
      actorUserId: string | null;
      updateLines?: boolean;
    },
  ): Promise<Release[]> {
    const lines = await db
      .select({
        id: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        lineType: schema.orderLines.lineType,
        sourceLocationId: schema.orderLines.sourceLocationId,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, args.orderId));

    // Release each line at the location it reserved from.
    const all: Release[] = [];
    const groups = new Map<string, typeof lines>();
    for (const l of lines) {
      const loc = l.sourceLocationId ?? args.locationId;
      if (!groups.has(loc)) groups.set(loc, []);
      groups.get(loc)!.push(l);
    }
    for (const [loc, group] of groups) {
      const releases = planReleases(group);
      await this.applyReleases(db, { ...args, locationId: loc, releases });
      all.push(...releases);
    }
    return all;
  }

  /**
   * Recompute an order's header money from its lines and persist it.
   * Called after every line mutation so the header is never stale —
   * totals are stored (they're what the customer signed), but they are
   * always a function of the lines, never edited directly.
   */
  async recomputeTotals(db: PostgresJsDatabase, orderId: string): Promise<OrderTotalsSnapshot> {
    const [order] = await db
      .select({
        orderDiscountCents: schema.orders.orderDiscountCents,
        deliveryFeeCents: schema.orders.deliveryFeeCents,
        installFeeCents: schema.orders.installFeeCents,
        otherFeeCents: schema.orders.otherFeeCents,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    // Step-3 charges (delivery/install/misc) ride on top of the taxed
    // cart: they join total_cents (and therefore the balance due) but are
    // not taxed themselves (v1 policy, documented in the plan doc).
    const feesCents =
      (order?.deliveryFeeCents ?? 0) + (order?.installFeeCents ?? 0) + (order?.otherFeeCents ?? 0);

    const lines = await db
      .select({
        id: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
        unitPriceCents: schema.orderLines.unitPriceCents,
        discountCents: schema.orderLines.discountCents,
        taxRateBps: schema.orderLines.taxRateBps,
        lineType: schema.orderLines.lineType,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, orderId))
      .orderBy(schema.orderLines.createdAt);

    if (lines.length === 0) {
      const empty: OrderTotalsSnapshot = {
        subtotalCents: 0,
        discountCents: 0,
        taxCents: 0,
        totalCents: feesCents,
      };
      await db
        .update(schema.orders)
        .set({ ...empty, updatedAt: new Date() })
        .where(eq(schema.orders.id, orderId));
      return empty;
    }

    const asCart = (ls: typeof lines) =>
      ls.map((l) => ({
        variantId: l.variantId ?? l.id,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        lineDiscountCents: l.discountCents,
        taxRateBps: l.taxRateBps,
      }));
    // The order discount lands on the goods, never on fee lines (recycling,
    // a charged redelivery fee …) — as the register prices it. Spread over
    // a fee it moved discount off taxed goods and raised the tax (Codex,
    // PR #222: a $10 fee on $100 with a $10 discount added $10.09). Only
    // when the discount is bigger than the goods themselves does it fall
    // back to the whole cart.
    const orderDiscountCents = order?.orderDiscountCents ?? 0;
    const goodsIdx = lines.flatMap((l, i) => (l.lineType === 'custom' ? [] : [i]));
    const feeIdx = lines.flatMap((l, i) => (l.lineType === 'custom' ? [i] : []));
    const goodsNet = goodsIdx.reduce((n, i) => {
      const l = lines[i]!;
      return n + Math.max(0, l.quantity * l.unitPriceCents - l.discountCents);
    }, 0);
    const separate =
      orderDiscountCents > 0 &&
      goodsIdx.length > 0 &&
      feeIdx.length > 0 &&
      orderDiscountCents <= goodsNet;
    let totals: ReturnType<typeof computeTotals>;
    if (separate) {
      const goods = computeTotals({
        taxRateBps: 0,
        orderDiscountCents,
        lines: asCart(goodsIdx.map((i) => lines[i]!)),
      });
      const fees = computeTotals({ taxRateBps: 0, lines: asCart(feeIdx.map((i) => lines[i]!)) });
      const byLine: (typeof goods.lines)[number][] = [];
      goodsIdx.forEach((i, k) => (byLine[i] = goods.lines[k]!));
      feeIdx.forEach((i, k) => (byLine[i] = fees.lines[k]!));
      totals = {
        lines: byLine,
        subtotalCents: goods.subtotalCents + fees.subtotalCents,
        discountCents: goods.discountCents + fees.discountCents,
        taxCents: goods.taxCents + fees.taxCents,
        totalCents: goods.totalCents + fees.totalCents,
      };
    } else {
      totals = computeTotals({ taxRateBps: 0, orderDiscountCents, lines: asCart(lines) });
    }

    // Push each line's share of tax back down — the order-level discount
    // is allocated pro-rata inside computeTotals, so a line's tax is only
    // knowable after the whole cart is priced.
    for (let i = 0; i < lines.length; i++) {
      const computed = totals.lines[i]!;
      await db
        .update(schema.orderLines)
        .set({ taxCents: computed.taxCents, totalCents: computed.totalCents })
        .where(eq(schema.orderLines.id, lines[i]!.id));
    }

    const snapshot: OrderTotalsSnapshot = {
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents + feesCents,
    };
    await db
      .update(schema.orders)
      .set({ ...snapshot, updatedAt: new Date() })
      .where(eq(schema.orders.id, orderId));
    return snapshot;
  }

  /**
   * Per-business, per-year sequential order number ("SO-2026-000123").
   * Same shape and same retry behaviour as the POS sale numbering — a
   * concurrent insert that wins the race just pushes us to the next
   * candidate.
   */
  async generateOrderNumber(
    db: PostgresJsDatabase,
    businessId: string,
    locationId?: string,
  ): Promise<string> {
    // Per-store numbering (PLAN-POS-OPERATIONS §1): a location with an
    // order_prefix numbers from its own atomic counter — `{PREFIX}-{seq}`.
    // Locations without a prefix keep the legacy per-business sequence.
    if (locationId) {
      const [loc] = await db
        .select({ prefix: schema.locations.orderPrefix })
        .from(schema.locations)
        .where(eq(schema.locations.id, locationId))
        .limit(1);
      if (loc?.prefix) {
        const [seq] = await db
          .insert(schema.orderSequences)
          .values({ businessId, locationId, nextValue: 10002 })
          .onConflictDoUpdate({
            target: schema.orderSequences.locationId,
            set: { nextValue: sql`${schema.orderSequences.nextValue} + 1` },
          })
          .returning({ nextValue: schema.orderSequences.nextValue });
        // Both paths return the post-claim counter, so the claimed number
        // is always returned - 1: first insert stores 10002 and claims
        // 10001; each conflict update increments and claims the prior value.
        const claimed = (seq?.nextValue ?? 10002) - 1;
        return `${loc.prefix}-${claimed}`;
      }
    }
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.businessId, businessId),
            sql`${schema.orders.number} LIKE ${`SO-${year}-%`}`,
          ),
        );
      const seq = (rows[0]?.count ?? 0) + 1 + attempt;
      const candidate = `SO-${year}-${String(seq).padStart(6, '0')}`;
      const [existing] = await db
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(and(eq(schema.orders.businessId, businessId), eq(schema.orders.number, candidate)))
        .limit(1);
      if (!existing) return candidate;
    }
    return `SO-${year}-${Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0')}`;
  }

  /**
   * The units leave the building: on-hand drops by the full quantity, the
   * reservation those units were holding is consumed (never below zero),
   * the line's qty_fulfilled rises, and an `order_fulfill` movement with a
   * real negative delta records the stock change — the one movement in the
   * order lifecycle where goods actually move (D3).
   */
  async applyFulfillment(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      orderId: string;
      locationId: string;
      actorUserId: string | null;
      steps: readonly FulfillmentStep[];
      referenceType?: string;
      referenceId?: string;
    },
  ): Promise<void> {
    // Per-line fulfill-from: consume each line at the location it
    // reserved from (line override, else args.locationId).
    const sourceRows = await db
      .select({
        id: schema.orderLines.id,
        sourceLocationId: schema.orderLines.sourceLocationId,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, args.orderId));
    const sourceOf = new Map(sourceRows.map((r) => [r.id, r.sourceLocationId]));

    for (const step of args.steps) {
      const stepLocationId = sourceOf.get(step.orderLineId) ?? args.locationId;
      await db
        .update(schema.orderLines)
        .set({
          qtyFulfilled: sql`${schema.orderLines.qtyFulfilled} + ${step.quantity}`,
          qtyReserved: sql`GREATEST(0, ${schema.orderLines.qtyReserved} - ${step.fromReserved})`,
        })
        .where(eq(schema.orderLines.id, step.orderLineId));

      if (!step.variantId) continue; // free-text line: no stock to move

      await db
        .insert(schema.inventoryLevels)
        .values({
          businessId: args.businessId,
          variantId: step.variantId,
          locationId: stepLocationId,
          onHand: -step.quantity,
          reserved: 0,
        })
        .onConflictDoUpdate({
          target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
          set: {
            onHand: sql`${schema.inventoryLevels.onHand} - ${step.quantity}`,
            reserved: sql`GREATEST(0, ${schema.inventoryLevels.reserved} - ${step.fromReserved})`,
            updatedAt: new Date(),
          },
        });

      // Serial hand-off (G7): whatever serials were picked for this line
      // leave with the goods. Customer stamped for "whose mattress is
      // this?" lookups later.
      const [orderRow] = await db
        .select({ customerId: schema.orders.customerId })
        .from(schema.orders)
        .where(eq(schema.orders.id, args.orderId))
        .limit(1);
      await db
        .update(schema.serialUnits)
        .set({
          status: 'sold',
          customerId: orderRow?.customerId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.serialUnits.orderLineId, step.orderLineId),
            eq(schema.serialUnits.status, 'committed'),
          ),
        );

      await db.insert(schema.inventoryMovements).values({
        businessId: args.businessId,
        variantId: step.variantId,
        locationId: stepLocationId,
        delta: -step.quantity,
        reason: 'order_fulfill',
        referenceType: args.referenceType ?? 'order',
        referenceId: args.referenceId ?? args.orderId,
        actorUserId: args.actorUserId,
        notes: `fulfilled ${step.quantity}`,
      });
      // FIFO COGS: the fulfilled units consume the oldest layers.
      await this.costing.consume(db, {
        businessId: args.businessId,
        variantId: step.variantId,
        locationId: stepLocationId,
        quantity: step.quantity,
        referenceType: 'order_fulfill',
        referenceId: args.orderId,
      });
    }
  }
}
