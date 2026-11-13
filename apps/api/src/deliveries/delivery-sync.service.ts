import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { DRIZZLE } from '../database/database.module';
import { TicketFlagsService } from './ticket-flags.service';

/**
 * Order changes follow the delivery (owner 2026-11-10).
 *
 * Nothing on the server used to touch a delivery once the order was
 * written: a line added later, a quantity raised, a promised date set on
 * the Order details dialog, a quote confirmed — none of them put units on
 * a truck. The order read "Scheduled" while the stop carried only the old
 * lines, or the order never reached the Deliveries calendar at all, and
 * whoever staged the truck never saw the new goods.
 *
 * After every such change the controller calls `sync`, which makes the
 * stops match the order:
 *  - truck-bound units not yet on a live stop join the order's scheduled
 *    stop (the one on the line's own delivery date when it has one, else
 *    the earliest), instead of waiting for a second "Schedule delivery"
 *    that would open a separate stop for the same day;
 *  - with no live stop, and a promised date on the order, a stop is
 *    booked on that date — the same booking New Sale makes at the
 *    register, so a date set afterwards counts too. Capacity is not a
 *    reason to leave an order off the calendar; the dispatcher sees the
 *    day's load and moves stops from there;
 *  - units re-marked take-with / pickup / will-call leave the scheduled
 *    stop they were on.
 * A split (`Split order…`) stays the one way to put lines on different
 * days: it writes a sibling order with its own promised date.
 *
 * The nightly `delivery_sync` job runs the same sync over every open
 * delivery order (owner 2026-11-13, LB-10085: a mattress swapped onto the
 * order an hour after the sale, three days before this sync existed, left
 * the stop carrying only the pillows). Orders edited before the sync was
 * wired up catch up overnight — or at once from the Jobs page.
 */

type Line = {
  id: string;
  quantity: number;
  qtyFulfilled: number;
  lineType: string;
  fulfillmentMethod: string | null;
  deliveryDate: string | null;
};

export type DeliverySyncResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'unchanged' }
  | { kind: 'joined'; deliveryId: string; scheduledDate: string; units: number }
  | { kind: 'booked'; deliveryId: string; scheduledDate: string; units: number }
  | { kind: 'left'; deliveryId: string; units: number };

export interface DeliverySyncOptions {
  /**
   * Never book a new stop on a promised date before this (YYYY-MM-DD).
   * An order edit books on the promised date whatever it is — the writer
   * is looking at it — but the nightly sweep must not drop stops onto
   * days that have passed.
   */
  minBookingDate?: string;
}

export interface DeliverySweepOutcome {
  orders: number;
  joined: number;
  booked: number;
  left: number;
  changed: string[];
}

const LIVE_STOP = ['scheduled', 'loaded', 'out_for_delivery'] as const;

function counterMarked(m: string | null): boolean {
  return m === 'take_with' || m === 'pickup' || m === 'will_call';
}

@Injectable()
export class DeliverySyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TicketFlagsService) private readonly ticketFlags: TicketFlagsService,
  ) {}

  /**
   * Make the order's live stops carry what the order says. Safe to call
   * after any order mutation: a quote, draft, closed or non-delivery order
   * is left alone, and an order whose stops already match is untouched.
   */
  async sync(orderId: string, opts: DeliverySyncOptions = {}): Promise<DeliverySyncResult[]> {
    const [order] = await this.db
      .select({
        id: schema.orders.id,
        businessId: schema.orders.businessId,
        number: schema.orders.number,
        status: schema.orders.status,
        fulfillmentType: schema.orders.fulfillmentType,
        requestedDate: schema.orders.requestedDate,
        locationId: schema.orders.locationId,
        addressPostalCode: schema.orders.addressPostalCode,
        completedAt: schema.orders.completedAt,
        cancelledAt: schema.orders.cancelledAt,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!order) return [{ kind: 'skipped', reason: 'no order' }];
    if (order.status === 'quote' || order.status === 'draft') {
      return [{ kind: 'skipped', reason: order.status }];
    }
    if (order.completedAt || order.cancelledAt) return [{ kind: 'skipped', reason: 'closed' }];
    if (order.fulfillmentType !== 'delivery') {
      return [{ kind: 'skipped', reason: order.fulfillmentType }];
    }

    const lines: Line[] = await this.db
      .select({
        id: schema.orderLines.id,
        quantity: schema.orderLines.quantity,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
        lineType: schema.orderLines.lineType,
        fulfillmentMethod: schema.orderLines.fulfillmentMethod,
        deliveryDate: schema.orderLines.deliveryDate,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, orderId));

    const stops = await this.db
      .select({
        id: schema.deliveries.id,
        status: schema.deliveries.status,
        scheduledDate: schema.deliveries.scheduledDate,
        runId: schema.deliveries.runId,
      })
      .from(schema.deliveries)
      .where(
        and(
          eq(schema.deliveries.orderId, orderId),
          eq(schema.deliveries.kind, 'delivery'),
          inArray(schema.deliveries.status, [...LIVE_STOP]),
        ),
      )
      .orderBy(schema.deliveries.scheduledDate);

    const stopIds = stops.map((s) => s.id);
    const onStops = stopIds.length
      ? await this.db
          .select({
            id: schema.deliveryLines.id,
            deliveryId: schema.deliveryLines.deliveryId,
            orderLineId: schema.deliveryLines.orderLineId,
            quantity: schema.deliveryLines.quantity,
          })
          .from(schema.deliveryLines)
          .where(inArray(schema.deliveryLines.deliveryId, stopIds))
      : [];
    const pending = new Map<string, number>();
    for (const r of onStops) {
      pending.set(r.orderLineId, (pending.get(r.orderLineId) ?? 0) + r.quantity);
    }

    const results: DeliverySyncResult[] = [];

    // Only a stop nobody has loaded yet can change: a loaded truck or one
    // on a run is the dispatcher's, and the order-edit guards keep the
    // order from changing while it is out anyway.
    const openStops = stops.filter((s) => s.status === 'scheduled' && !s.runId);

    // 1. Units re-marked for the counter leave the scheduled stop.
    for (const line of lines) {
      if (line.lineType === 'direct_ship' || !counterMarked(line.fulfillmentMethod)) continue;
      for (const row of onStops.filter((r) => r.orderLineId === line.id)) {
        const stop = openStops.find((s) => s.id === row.deliveryId);
        if (!stop) continue;
        await this.db.delete(schema.deliveryLines).where(eq(schema.deliveryLines.id, row.id));
        pending.set(line.id, (pending.get(line.id) ?? 0) - row.quantity);
        results.push({ kind: 'left', deliveryId: stop.id, units: row.quantity });
        await this.audit.log({
          businessId: order.businessId,
          action: 'delivery.line_left',
          targetType: 'delivery',
          targetId: stop.id,
          after: {
            orderId,
            orderLineId: line.id,
            quantity: row.quantity,
            scheduledDate: stop.scheduledDate,
          },
        });
      }
    }

    // 2. Truck-bound units not yet on a live stop.
    const owed = lines
      .filter((l) => l.lineType !== 'direct_ship' && !counterMarked(l.fulfillmentMethod))
      .map((l) => ({
        line: l,
        quantity: l.quantity - l.qtyFulfilled - (pending.get(l.id) ?? 0),
      }))
      .filter((o) => o.quantity > 0);
    if (owed.length === 0) return results.length ? results : [{ kind: 'unchanged' }];

    if (openStops.length > 0) {
      // Join the stop on the line's own date when there is one, else the
      // earliest open stop.
      const byStop = new Map<string, { quantity: number; line: Line }[]>();
      for (const o of owed) {
        const target =
          openStops.find((s) => o.line.deliveryDate && s.scheduledDate === o.line.deliveryDate) ??
          openStops[0]!;
        const list = byStop.get(target.id) ?? [];
        list.push(o);
        byStop.set(target.id, list);
      }
      for (const [stopId, items] of byStop) {
        const stop = openStops.find((s) => s.id === stopId)!;
        let units = 0;
        for (const { line, quantity } of items) {
          const existing = onStops.find(
            (r) => r.deliveryId === stopId && r.orderLineId === line.id,
          );
          if (existing) {
            await this.db
              .update(schema.deliveryLines)
              .set({ quantity: existing.quantity + quantity })
              .where(eq(schema.deliveryLines.id, existing.id));
          } else {
            await this.db.insert(schema.deliveryLines).values({
              businessId: order.businessId,
              deliveryId: stopId,
              orderLineId: line.id,
              quantity,
            });
          }
          units += quantity;
        }
        results.push({
          kind: 'joined',
          deliveryId: stopId,
          scheduledDate: stop.scheduledDate,
          units,
        });
        await this.audit.log({
          businessId: order.businessId,
          action: 'delivery.lines_joined',
          targetType: 'delivery',
          targetId: stopId,
          after: {
            orderId,
            orderNumber: order.number,
            scheduledDate: stop.scheduledDate,
            units,
            lines: items.map((i) => ({ orderLineId: i.line.id, quantity: i.quantity })),
          },
        });
        // R8: the printed ticket no longer lists everything on the stop.
        await this.ticketFlags.applyEdit(
          orderId,
          { kind: 'header_change', field: 'line_added' },
          'delivery.lines_joined',
        );
      }
      return results;
    }

    if (stops.length > 0) {
      // Every live stop is loaded or on a run: nothing to join here, the
      // dispatcher books the leftover units from the order page.
      return results.length ? results : [{ kind: 'unchanged' }];
    }

    if (!order.requestedDate) {
      return results.length ? results : [{ kind: 'skipped', reason: 'no promised date' }];
    }
    if (opts.minBookingDate && order.requestedDate < opts.minBookingDate) {
      return results.length ? results : [{ kind: 'skipped', reason: 'promised date passed' }];
    }

    // 3. No stop at all: book one on the promised date.
    const [biz] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, order.businessId))
      .limit(1);
    const zipRoutes =
      ((biz?.opsSettingsJson ?? {}) as { zipRoutes?: Record<string, string> | null }).zipRoutes ??
      null;
    const dayRows = await this.db
      .select({ routePosition: schema.deliveries.routePosition })
      .from(schema.deliveries)
      .where(
        and(
          eq(schema.deliveries.locationId, order.locationId),
          eq(schema.deliveries.scheduledDate, order.requestedDate),
        ),
      );
    const nextPosition = dayRows.reduce((m, r) => Math.max(m, r.routePosition ?? 0), 0) + 1;
    const [delivery] = await this.db
      .insert(schema.deliveries)
      .values({
        businessId: order.businessId,
        locationId: order.locationId,
        orderId,
        scheduledDate: order.requestedDate,
        routePosition: nextPosition,
        route: suggestRoute(order.addressPostalCode, zipRoutes),
      })
      .returning({ id: schema.deliveries.id });
    const units = owed.reduce((n, o) => n + o.quantity, 0);
    await this.db.insert(schema.deliveryLines).values(
      owed.map((o) => ({
        businessId: order.businessId,
        deliveryId: delivery!.id,
        orderLineId: o.line.id,
        quantity: o.quantity,
      })),
    );
    await this.audit.log({
      businessId: order.businessId,
      action: 'delivery.schedule',
      targetType: 'delivery',
      targetId: delivery!.id,
      after: {
        orderId,
        orderNumber: order.number,
        scheduledDate: order.requestedDate,
        lineCount: owed.length,
        auto: true,
      },
    });
    await this.ticketFlags.applyEdit(
      orderId,
      { kind: 'header_change', field: 'next_delivery_date' },
      'delivery.schedule',
    );
    results.push({
      kind: 'booked',
      deliveryId: delivery!.id,
      scheduledDate: order.requestedDate,
      units,
    });
    return results;
  }

  /**
   * The nightly sweep: sync every open delivery order of the business the
   * way an edit syncs it. Idempotent — an order whose stops already match
   * is untouched — and it never books a stop before `minBookingDate`.
   */
  async syncBusiness(
    businessId: string,
    opts: { minBookingDate: string },
  ): Promise<DeliverySweepOutcome> {
    const candidates = await this.db
      .select({ id: schema.orders.id, number: schema.orders.number })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          eq(schema.orders.fulfillmentType, 'delivery'),
          inArray(schema.orders.status, ['open', 'partially_fulfilled']),
          isNull(schema.orders.completedAt),
          isNull(schema.orders.cancelledAt),
        ),
      )
      .orderBy(schema.orders.createdAt);
    const out: DeliverySweepOutcome = {
      orders: candidates.length,
      joined: 0,
      booked: 0,
      left: 0,
      changed: [],
    };
    for (const o of candidates) {
      const results = await this.sync(o.id, opts);
      let touched = false;
      for (const r of results) {
        if (r.kind === 'joined') out.joined += r.units;
        else if (r.kind === 'booked') out.booked += r.units;
        else if (r.kind === 'left') out.left += r.units;
        else continue;
        touched = true;
      }
      if (touched) out.changed.push(o.number);
    }
    return out;
  }

  /**
   * The promised date moved on the Order details dialog: when the order
   * has exactly one open stop, it moves with the date (the dispatcher
   * moves multi-stop orders one stop at a time from the order page).
   */
  async followPromisedDate(orderId: string, date: string): Promise<boolean> {
    const stops = await this.db
      .select({
        id: schema.deliveries.id,
        scheduledDate: schema.deliveries.scheduledDate,
        locationId: schema.deliveries.locationId,
        status: schema.deliveries.status,
        runId: schema.deliveries.runId,
      })
      .from(schema.deliveries)
      .where(
        and(
          eq(schema.deliveries.orderId, orderId),
          eq(schema.deliveries.kind, 'delivery'),
          inArray(schema.deliveries.status, [...LIVE_STOP]),
        ),
      );
    if (stops.length !== 1) return false;
    const stop = stops[0]!;
    if (stop.status !== 'scheduled' || stop.runId || stop.scheduledDate === date) return false;
    const dayRows = await this.db
      .select({ routePosition: schema.deliveries.routePosition })
      .from(schema.deliveries)
      .where(
        and(
          eq(schema.deliveries.locationId, stop.locationId),
          eq(schema.deliveries.scheduledDate, date),
        ),
      );
    const nextPosition = dayRows.reduce((m, r) => Math.max(m, r.routePosition ?? 0), 0) + 1;
    await this.db
      .update(schema.deliveries)
      .set({ scheduledDate: date, routePosition: nextPosition, updatedAt: new Date() })
      .where(eq(schema.deliveries.id, stop.id));
    await this.audit.log({
      action: 'delivery.reschedule',
      targetType: 'delivery',
      targetId: stop.id,
      before: { scheduledDate: stop.scheduledDate },
      after: { scheduledDate: date, orderId, followedPromisedDate: true },
    });
    await this.ticketFlags.applyEdit(
      orderId,
      { kind: 'header_change', field: 'next_delivery_date' },
      'delivery.reschedule',
    );
    return true;
  }
}

/** Mirror of the dispatcher's zip → route suggestion (G12). */
function suggestRoute(
  postalCode: string | null,
  zipRoutes?: Record<string, string> | null,
): string | null {
  const zip = postalCode?.trim().match(/^(\d{5})/)?.[1];
  if (!zip) return null;
  if (zipRoutes) {
    const prefixes = Object.keys(zipRoutes).sort((a, b) => b.length - a.length);
    for (const p of prefixes) {
      if (zip.startsWith(p)) return zipRoutes[p]!;
    }
  }
  return `${zip.slice(0, 3)}xx`;
}
