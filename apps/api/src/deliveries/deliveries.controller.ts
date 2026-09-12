import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { TicketFlagsService } from './ticket-flags.service';
import { ExceptionsService } from '../controls/exceptions.service';
import { SecurityOverrideService } from '../controls/security-override.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { OrdersService } from '../orders/orders.service';
import { OrderReturnsService } from '../returns/order-returns.service';
import {
  deriveFulfillmentStatus,
  planFulfillment,
  remainingFulfillment,
  type FulfillmentRequest,
} from '../orders/order-math';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * §7 route auto-suggestion: LA-area routes group naturally by zip
 * prefix, so the default label is the first three digits + "xx"
 * ("900xx", "913xx"). Free text after that — the dispatcher renames and
 * regroups at will.
 */
function suggestRoute(
  postalCode: string | null,
  zipRoutes?: Record<string, string> | null,
): string | null {
  const zip = postalCode?.trim().match(/^(\d{5})/)?.[1];
  if (!zip) return null;
  // G12: an explicit zip→route map wins (longest prefix first) — the
  // dispatcher pre-declares geography instead of the salesperson picking.
  if (zipRoutes) {
    const prefixes = Object.keys(zipRoutes).sort((a, b) => b.length - a.length);
    for (const p of prefixes) {
      if (zip.startsWith(p)) return zipRoutes[p]!;
    }
  }
  return `${zip.slice(0, 3)}xx`;
}

type DeliveryStatus =
  | 'scheduled'
  | 'loaded'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed'
  | 'cancelled';

/** Statuses a delivery can still be edited/rescheduled in. */
const EDITABLE: DeliveryStatus[] = ['scheduled', 'loaded'];
/** Legal en-route transitions the status endpoint accepts. */
const TRANSITIONS: Record<string, DeliveryStatus[]> = {
  scheduled: ['loaded', 'out_for_delivery'],
  loaded: ['out_for_delivery', 'scheduled'],
  out_for_delivery: ['loaded'],
};

interface ScheduleDeliveryBody {
  scheduledDate?: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  driverMembershipId?: string | null;
  notes?: string | null;
  /** Route label; omitted → auto-suggested from the ship-to zip (§7). */
  route?: string | null;
  /**
   * §7 soft cap: a day at/over capacity refuses with 409 unless this is
   * true — the caller confirmed, and the override is logged to the
   * owner notifications feed.
   */
  confirmOverCapacity?: boolean;
  /** Omitted → everything still owed on the order rides on this delivery. */
  lines?: { orderLineId?: string; quantity?: number }[];
}

interface UpdateDeliveryBody {
  scheduledDate?: string;
  route?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  driverMembershipId?: string | null;
  routePosition?: number | null;
  notes?: string | null;
  /**
   * Redesign Phase 8 (README §3.4): moving a stop onto a full day is
   * allowed, but only deliberately — confirm the cap and say why in one
   * line. The note is kept on the delivery (it prints on the day sheet)
   * and on the audit row.
   */
  confirmOverCapacity?: boolean;
  overCapacityNote?: string | null;
}

interface CompleteDeliveryBody {
  /** true → the truck came back with the goods; nothing moves. */
  failed?: boolean;
  notes?: string | null;
}

interface DeliveryRow {
  id: string;
  orderId: string;
  locationId: string;
  /** A22 slice 6: 'delivery' | 'return_pickup' (the truck collects a return). */
  kind: string;
  returnId: string | null;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  driverMembershipId: string | null;
  routePosition: number | null;
  route: string | null;
  runId: string | null;
  notes: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

interface DeliveryDetail extends DeliveryRow {
  orderNumber: string;
  /** The RMA a return pickup collects. */
  rmaNumber: string | null;
  customerId: string;
  customerName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressPhone: string | null;
  fulfillmentType: string;
  balanceDueCents: number;
  lines: {
    id: string;
    orderLineId: string;
    quantity: number;
    /** Physical pieces on the truck: quantity × the line's pieces-per-unit. */
    pieces: number;
    description: string;
    lineType: string;
  }[];
}

/**
 * Deliveries (STORIS cutover Day 3): the calendar and the trucks. A
 * delivery is a promise to move specific order-line units on a date;
 * completing it is the moment stock actually leaves — on-hand drops,
 * the reservation is consumed, and the order advances along the
 * fulfillment axis. Failure and cancellation move nothing.
 */
@TenantScoped()
@Controller('v1')
export class DeliveriesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(SecurityOverrideService) private readonly overrides: SecurityOverrideService,
    @Inject(TicketFlagsService) private readonly ticketFlags: TicketFlagsService,
    @Inject(OrderReturnsService) private readonly returns: OrderReturnsService,
  ) {}

  /**
   * Calendar / day-sheet query: deliveries in a date range, optionally
   * one driver's, ordered by date then route position. The day-sheet is
   * this list for a single day printed; no separate endpoint needed.
   */
  @Get('deliveries')
  @RequirePermission('deliveries.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('locationId') locationId?: string,
    @Query('driverMembershipId') driverMembershipId?: string,
    @Query('status') status?: string,
    @Query('orderId') orderId?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<DeliveryDetail[]> {
    // The board asks for a whole month at once (35 days × cap); default stays 500.
    const parsed = Number.parseInt(limitRaw ?? '', 10);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 2000) : 500;
    const filters = [];
    if (orderId) filters.push(eq(schema.deliveries.orderId, orderId));
    if (from) filters.push(gte(schema.deliveries.scheduledDate, from));
    if (to) filters.push(lte(schema.deliveries.scheduledDate, to));
    if (locationId) filters.push(eq(schema.deliveries.locationId, locationId));
    if (driverMembershipId) {
      filters.push(eq(schema.deliveries.driverMembershipId, driverMembershipId));
    }
    if (status) filters.push(eq(schema.deliveries.status, status));

    const rows = await this.db
      .select()
      .from(schema.deliveries)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(
        asc(schema.deliveries.scheduledDate),
        asc(schema.deliveries.routePosition),
        asc(schema.deliveries.createdAt),
      )
      .limit(limit);
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  /**
   * §7 capacity: booked stops per day against the soft cap
   * (ops.deliveryDailyCap, default 15). The New Sale screen and the
   * dispatch table both read this; every date in [from, to] comes back
   * even when empty so calendars can render without gap logic.
   * Declared before `deliveries/:id` so "capacity" isn't captured as an
   * id. The cap counts trucks business-wide — LA Mattress runs one
   * delivery fleet, not one per store (v1 convention).
   */
  @Get('deliveries/capacity')
  @RequirePermission('deliveries.view')
  async capacity(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{
    cap: number;
    pieceCap: number | null;
    unitCap: number | null;
    days: {
      date: string;
      booked: number;
      remaining: number;
      pieces: number;
      capacityUnits: number;
    }[];
  }> {
    const start = from && !Number.isNaN(new Date(from).getTime()) ? from : isoToday();
    const end = to && !Number.isNaN(new Date(to).getTime()) ? to : start;
    if (end < start) throw new BadRequestException('to must not be before from');
    const span =
      (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) /
      86_400_000;
    if (span > 62) throw new BadRequestException('range too large (max 62 days)');

    const config = await this.capacityConfig(tenant.businessId!);
    const cap = config.stopCap;
    const rows = await this.db
      .select({
        date: schema.deliveries.scheduledDate,
        booked: sql<number>`count(distinct ${schema.deliveries.id})::int`,
        // A20 "Assign Pieces": a unit can be several pieces on the truck.
        pieces: sql<number>`coalesce(sum(${schema.deliveryLines.quantity} * coalesce(${schema.orderLines.pieces}, 1)), 0)::int`,
        units: sql<number>`coalesce(sum(${schema.deliveryLines.quantity} * coalesce(${schema.productVariants.capacityUnits}, 1)), 0)::int`,
      })
      .from(schema.deliveries)
      .leftJoin(schema.deliveryLines, eq(schema.deliveryLines.deliveryId, schema.deliveries.id))
      .leftJoin(schema.orderLines, eq(schema.orderLines.id, schema.deliveryLines.orderLineId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(
        and(
          gte(schema.deliveries.scheduledDate, start),
          lte(schema.deliveries.scheduledDate, end),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      )
      .groupBy(schema.deliveries.scheduledDate);
    const byDate = new Map(rows.map((r) => [r.date, r]));

    const days: {
      date: string;
      booked: number;
      remaining: number;
      pieces: number;
      capacityUnits: number;
    }[] = [];
    for (let i = 0; i <= span; i++) {
      const date = new Date(new Date(`${start}T00:00:00Z`).getTime() + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const row = byDate.get(date);
      const booked = row?.booked ?? 0;
      days.push({
        date,
        booked,
        remaining: Math.max(0, cap - booked),
        pieces: row?.pieces ?? 0,
        capacityUnits: row?.units ?? 0,
      });
    }
    return { cap, pieceCap: config.pieceCap, unitCap: config.unitCap, days };
  }

  @Get('deliveries/:id')
  @RequirePermission('deliveries.view')
  async get(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<DeliveryDetail> {
    const row = await this.load(id);
    return this.hydrate(row);
  }

  /**
   * Put an order (or part of one) on the truck for a date. Only a
   * confirmed order can be scheduled — a quote holds no stock and has no
   * committed customer. Units already riding on another live delivery
   * cannot be double-booked.
   */
  @Post('orders/:orderId/deliveries')
  @RequirePermission('deliveries.schedule')
  async schedule(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('orderId') orderId: string,
    @Body() body: ScheduleDeliveryBody,
  ): Promise<DeliveryDetail> {
    if (!body.scheduledDate || Number.isNaN(new Date(body.scheduledDate).getTime())) {
      throw new BadRequestException('scheduledDate (YYYY-MM-DD) is required');
    }
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'quote') {
      throw new BadRequestException('Confirm the order (take a deposit) before scheduling it');
    }
    if (order.completedAt || order.cancelledAt) {
      throw new BadRequestException('This order is closed');
    }

    const orderLines = await this.db
      .select({
        id: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
        lineType: schema.orderLines.lineType,
        fulfillmentMethod: schema.orderLines.fulfillmentMethod,
        pieces: schema.orderLines.pieces,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, orderId));

    // Units already promised to a live (not delivered/failed/cancelled)
    // delivery are spoken for.
    const pending = await this.pendingByOrderLine(orderId);
    const schedulable = orderLines
      // PO-060: direct-ship lines ride the vendor's truck, not ours.
      .filter((l) => l.lineType !== 'direct_ship')
      .map((l) => ({
        ...l,
        // For scheduling purposes, "fulfilled" includes what's already on a
        // truck — planFulfillment then caps requests at what's truly free.
        qtyFulfilled: l.qtyFulfilled + (pending.get(l.id) ?? 0),
      }));

    // Mixed fulfillment: lines EXPLICITLY marked take-with or pickup are
    // handed over at the counter (order fulfill), never scheduled by
    // default. Lines with no override follow the human's explicit act of
    // scheduling — booking a delivery on a pickup-typed order is a
    // deliberate change of plan, not a mistake to refuse. An explicit
    // body.lines still schedules exactly what it names.
    const counterMarked = (m: string | null) => m === 'take_with' || m === 'pickup';
    const truckBound = schedulable.filter((l) => !counterMarked(l.fulfillmentMethod));
    const requests: FulfillmentRequest[] =
      body.lines && body.lines.length > 0
        ? body.lines.map((l) => ({
            orderLineId: String(l.orderLineId ?? ''),
            quantity: Number(l.quantity ?? 0),
          }))
        : remainingFulfillment(truckBound);
    if (requests.length === 0) {
      const counterRemaining = schedulable.some(
        (l) => counterMarked(l.fulfillmentMethod) && l.quantity - l.qtyFulfilled > 0,
      );
      throw new BadRequestException(
        counterRemaining
          ? 'Nothing to schedule — the remaining units are marked take-with/pickup. Hand them over from the order page instead.'
          : 'Nothing left to schedule on this order',
      );
    }
    const plan = planFulfillment(schedulable, requests);
    if (plan.errors.length > 0) throw new BadRequestException(plan.errors.join('; '));

    // §7/G12 soft cap, now multi-dimensional: stops always, pieces and
    // capacity units when ops sets budgets. The refusal names WHICH
    // dimension is over; overrides stay deliberate and logged.
    const config = await this.capacityConfig(tenant.businessId!);
    const cap = config.stopCap;
    const load = await this.dayLoad(body.scheduledDate);
    const booked = load.stops;

    // What this delivery adds, in pieces and capacity units.
    const stepVariantIds = plan.steps
      .map((step) => orderLines.find((l) => l.id === step.orderLineId)?.variantId)
      .filter((v): v is string => Boolean(v));
    const capUnitsByVariant = new Map<string, number>();
    if (stepVariantIds.length > 0) {
      const variants = await this.db
        .select({
          id: schema.productVariants.id,
          capacityUnits: schema.productVariants.capacityUnits,
        })
        .from(schema.productVariants)
        .where(inArray(schema.productVariants.id, stepVariantIds));
      for (const v of variants) capUnitsByVariant.set(v.id, v.capacityUnits ?? 1);
    }
    let incomingPieces = 0;
    let incomingUnits = 0;
    for (const step of plan.steps) {
      const line = orderLines.find((l) => l.id === step.orderLineId);
      incomingPieces += step.quantity * (line?.pieces ?? 1);
      incomingUnits +=
        step.quantity * (line?.variantId ? (capUnitsByVariant.get(line.variantId) ?? 1) : 1);
    }

    const overDimensions: string[] = [];
    if (booked >= cap) overDimensions.push(`stops (${booked}/${cap})`);
    if (config.pieceCap != null && load.pieces + incomingPieces > config.pieceCap) {
      overDimensions.push(`pieces (${load.pieces} + ${incomingPieces} > ${config.pieceCap})`);
    }
    if (config.unitCap != null && load.units + incomingUnits > config.unitCap) {
      overDimensions.push(`capacity units (${load.units} + ${incomingUnits} > ${config.unitCap})`);
    }
    const overCapacity = overDimensions.length > 0;
    if (overCapacity && !body.confirmOverCapacity) {
      // Structured code, not just prose: the client used to sniff the
      // message for "at capacity", so the G12 rewrite to multi-dimension
      // wording silently disabled the confirm affordance and made the
      // documented override unreachable (QA 2026-08-26, D6).
      throw new ConflictException({
        statusCode: 409,
        code: 'OVER_CAPACITY',
        dimensions: overDimensions,
        message: `${body.scheduledDate} is over capacity on ${overDimensions.join(' and ')}. Confirm to book beyond the cap.`,
      });
    }

    // Route position: append to the end of that day's route.
    const dayRows = await this.db
      .select({ routePosition: schema.deliveries.routePosition })
      .from(schema.deliveries)
      .where(
        and(
          eq(schema.deliveries.locationId, order.locationId),
          eq(schema.deliveries.scheduledDate, body.scheduledDate),
        ),
      );
    const nextPosition = dayRows.reduce((m, r) => Math.max(m, r.routePosition ?? 0), 0) + 1;

    const [delivery] = await this.db
      .insert(schema.deliveries)
      .values({
        businessId: tenant.businessId!,
        locationId: order.locationId,
        orderId,
        scheduledDate: body.scheduledDate,
        windowStart: body.windowStart ?? null,
        windowEnd: body.windowEnd ?? null,
        driverMembershipId: body.driverMembershipId ?? null,
        routePosition: nextPosition,
        route: body.route?.trim() || suggestRoute(order.addressPostalCode, config.zipRoutes),
        notes: body.notes ?? null,
      })
      .returning();
    if (!delivery) throw new BadRequestException('failed to create delivery');

    if (overCapacity) {
      await this.audit.log({
        action: 'delivery.cap_override',
        targetType: 'order',
        targetId: orderId,
        metadata: {
          deliveryId: delivery.id,
          scheduledDate: body.scheduledDate,
          booked: booked + 1,
          cap,
          orderNumber: order.number,
        },
      });
      await this.exceptions.record({
        type: 'delivery_cap_override',
        severity: 'warning',
        entityType: 'order',
        entityId: orderId,
        summary: `Order ${order.number} booked over capacity on ${body.scheduledDate} (${booked + 1}/${cap})`,
        metadata: { deliveryId: delivery.id, scheduledDate: body.scheduledDate, cap },
      });
    }

    await this.db.insert(schema.deliveryLines).values(
      plan.steps.map((s) => ({
        businessId: tenant.businessId!,
        deliveryId: delivery.id,
        orderLineId: s.orderLineId,
        quantity: s.quantity,
      })),
    );

    await this.audit.log({
      action: 'delivery.schedule',
      targetType: 'delivery',
      targetId: delivery.id,
      after: {
        orderId,
        orderNumber: order.number,
        scheduledDate: body.scheduledDate,
        lineCount: plan.steps.length,
      },
    });
    // R8 — a new delivery date on the order stales every printed ticket.
    await this.ticketFlags.applyEdit(
      orderId,
      { kind: 'header_change', field: 'next_delivery_date' },
      'delivery.schedule',
    );
    const detail = await this.hydrate(delivery);
    this.fireEvent('delivery.scheduled', tenant.businessId!, detail);
    return detail;
  }

  /** Reschedule / reassign; only before the truck leaves. */
  @Patch('deliveries/:id')
  @RequirePermission('deliveries.schedule')
  async update(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateDeliveryBody,
  ): Promise<DeliveryDetail> {
    const row = await this.load(id);
    if (!EDITABLE.includes(row.status as DeliveryStatus)) {
      throw new BadRequestException(`A ${row.status} delivery cannot be edited`);
    }
    if (body.scheduledDate !== undefined && Number.isNaN(new Date(body.scheduledDate).getTime())) {
      throw new BadRequestException('scheduledDate must be a date');
    }
    const moving = body.scheduledDate !== undefined && body.scheduledDate !== row.scheduledDate;
    // The same soft cap the create path enforces (§7/G12), applied to a
    // move: the target day's load plus what this stop carries.
    let capOverride: { booked: number; cap: number; dimensions: string[]; note: string } | null =
      null;
    if (moving) {
      const config = await this.capacityConfig(tenant.businessId!);
      const load = await this.dayLoad(body.scheduledDate!);
      const [mine] = await this.db
        .select({
          pieces: sql<number>`coalesce(sum(${schema.deliveryLines.quantity} * coalesce(${schema.orderLines.pieces}, 1)), 0)::int`,
          units: sql<number>`coalesce(sum(${schema.deliveryLines.quantity} * coalesce(${schema.productVariants.capacityUnits}, 1)), 0)::int`,
        })
        .from(schema.deliveryLines)
        .leftJoin(schema.orderLines, eq(schema.orderLines.id, schema.deliveryLines.orderLineId))
        .leftJoin(
          schema.productVariants,
          eq(schema.productVariants.id, schema.orderLines.variantId),
        )
        .where(eq(schema.deliveryLines.deliveryId, id));
      const over: string[] = [];
      if (load.stops >= config.stopCap) over.push(`stops (${load.stops}/${config.stopCap})`);
      if (config.pieceCap != null && load.pieces + (mine?.pieces ?? 0) > config.pieceCap) {
        over.push(`pieces (${load.pieces} + ${mine?.pieces ?? 0} > ${config.pieceCap})`);
      }
      if (config.unitCap != null && load.units + (mine?.units ?? 0) > config.unitCap) {
        over.push(`capacity units (${load.units} + ${mine?.units ?? 0} > ${config.unitCap})`);
      }
      if (over.length > 0) {
        if (!body.confirmOverCapacity) {
          throw new ConflictException({
            statusCode: 409,
            code: 'OVER_CAPACITY',
            dimensions: over,
            message: `${body.scheduledDate} is over capacity on ${over.join(' and ')}. Confirm to book beyond the cap.`,
          });
        }
        const note = body.overCapacityNote?.trim() ?? '';
        if (!note) {
          throw new BadRequestException(
            'A one-line note is required to move a stop over the cap — it prints on the day sheet',
          );
        }
        const by = actor?.name?.trim() || actor?.email || null;
        capOverride = {
          booked: load.stops + 1,
          cap: config.stopCap,
          dimensions: over,
          note: by ? `${note} — ${by}` : note,
        };
      }
    }
    const nextNotes = body.notes !== undefined ? body.notes : capOverride ? row.notes : undefined;
    const notesWithCap = capOverride
      ? [nextNotes ?? null, `Over cap ${body.scheduledDate}: ${capOverride.note}`]
          .filter(Boolean)
          .join('\n')
      : nextNotes;
    await this.db
      .update(schema.deliveries)
      .set({
        ...(body.scheduledDate !== undefined ? { scheduledDate: body.scheduledDate } : {}),
        ...(body.windowStart !== undefined ? { windowStart: body.windowStart } : {}),
        ...(body.windowEnd !== undefined ? { windowEnd: body.windowEnd } : {}),
        ...(body.driverMembershipId !== undefined
          ? { driverMembershipId: body.driverMembershipId }
          : {}),
        ...(body.routePosition !== undefined ? { routePosition: body.routePosition } : {}),
        ...(body.route !== undefined ? { route: body.route?.trim() || null } : {}),
        ...(notesWithCap !== undefined ? { notes: notesWithCap } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.deliveries.id, id));
    if (capOverride) {
      await this.audit.log({
        action: 'delivery.cap_override',
        targetType: 'delivery',
        targetId: id,
        metadata: {
          deliveryId: id,
          orderId: row.orderId,
          from: row.scheduledDate,
          scheduledDate: body.scheduledDate,
          booked: capOverride.booked,
          cap: capOverride.cap,
          dimensions: capOverride.dimensions,
          note: capOverride.note,
          actorUserId: actor?.id ?? null,
        },
      });
      await this.exceptions.record({
        type: 'delivery_cap_override',
        severity: 'warning',
        entityType: 'order',
        entityId: row.orderId,
        summary: `Delivery moved over capacity to ${body.scheduledDate} (${capOverride.booked}/${capOverride.cap}): ${capOverride.note}`,
        metadata: {
          deliveryId: id,
          scheduledDate: body.scheduledDate,
          cap: capOverride.cap,
          note: capOverride.note,
        },
      });
    }
    await this.audit.log({
      action: 'delivery.update',
      targetType: 'delivery',
      targetId: id,
      before:
        body.scheduledDate !== undefined && body.scheduledDate !== row.scheduledDate
          ? { scheduledDate: row.scheduledDate }
          : undefined,
      after: body as Record<string, unknown>,
    });
    if (body.scheduledDate !== undefined && body.scheduledDate !== row.scheduledDate) {
      // R8 — moving a delivery date is a header-level change: every
      // printed ticket on the order goes stale (runs on the post-move
      // snapshot so flags land on the delivery's new date).
      await this.ticketFlags.applyEdit(
        row.orderId,
        { kind: 'header_change', field: 'next_delivery_date' },
        'delivery.update',
      );
    }
    return this.hydrate(await this.load(id));
  }

  /** Loaded / out-for-delivery hops (and stepping back while still out). */
  @Post('deliveries/:id/status')
  @RequirePermission('deliveries.complete')
  async setStatus(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { status?: string },
  ): Promise<DeliveryDetail> {
    const row = await this.load(id);
    const next = body.status as DeliveryStatus;
    const allowed = TRANSITIONS[row.status] ?? [];
    if (!next || !allowed.includes(next)) {
      throw new BadRequestException(
        `Cannot go from ${row.status} to ${body.status ?? '(missing)'} — allowed: ${allowed.join(', ') || 'none'}`,
      );
    }
    await this.db
      .update(schema.deliveries)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(schema.deliveries.id, id));
    await this.audit.log({
      action: 'delivery.status',
      targetType: 'delivery',
      targetId: id,
      before: { status: row.status },
      after: { status: next },
    });
    return this.hydrate(await this.load(id));
  }

  /**
   * The truck's verdict. Delivered → the goods leave: stock decrements,
   * reservations consume, lines' fulfilled counts rise, and the order
   * advances (partially_fulfilled / fulfilled). Failed → record it,
   * nothing moves; the units go back on the schedulable pile.
   */
  @Post('deliveries/:id/complete')
  @RequirePermission('deliveries.complete')
  async complete(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: CompleteDeliveryBody,
  ): Promise<DeliveryDetail> {
    const row = await this.load(id);
    if (row.status === 'delivered' || row.status === 'failed' || row.status === 'cancelled') {
      throw new BadRequestException(`This delivery is already ${row.status}`);
    }

    if (body.failed) {
      await this.db
        .update(schema.deliveries)
        .set({
          status: 'failed',
          completedAt: new Date(),
          notes: body.notes
            ? [row.notes, `Failed: ${body.notes}`].filter(Boolean).join('\n')
            : row.notes,
          updatedAt: new Date(),
        })
        .where(eq(schema.deliveries.id, id));
      await this.audit.log({
        action: 'delivery.failed',
        targetType: 'delivery',
        targetId: id,
        after: { notes: body.notes ?? null },
      });
      return this.hydrate(await this.load(id));
    }

    // A22 slice 6: a return pickup brings goods BACK — receiving the
    // return (qtyReturned, As-Is staging, the refund) is the completion;
    // nothing is fulfilled. The goods land at the order's stock location.
    if (row.kind === 'return_pickup') {
      if (!row.returnId) throw new BadRequestException('This pickup has no return attached');
      const [stockOwner] = await this.db
        .select({ stockLocationId: schema.orders.stockLocationId })
        .from(schema.orders)
        .where(eq(schema.orders.id, row.orderId))
        .limit(1);
      await this.returns.receiveGoods(row.returnId, actor?.id ?? null, {
        receiveLocationId: stockOwner?.stockLocationId ?? row.locationId,
      });
      await this.db
        .update(schema.deliveries)
        .set({ status: 'delivered', completedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.deliveries.id, id));
      await this.audit.log({
        action: 'delivery.picked_up',
        targetType: 'delivery',
        targetId: id,
        after: { orderId: row.orderId, returnId: row.returnId },
      });
      return this.hydrate(await this.load(id));
    }

    const dLines = await this.db
      .select({
        orderLineId: schema.deliveryLines.orderLineId,
        quantity: schema.deliveryLines.quantity,
      })
      .from(schema.deliveryLines)
      .where(eq(schema.deliveryLines.deliveryId, id));
    const orderLines = await this.db
      .select({
        id: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, row.orderId));

    const plan = planFulfillment(
      orderLines,
      dLines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })),
    );
    if (plan.errors.length > 0) throw new BadRequestException(plan.errors.join('; '));

    // Consume from the order's fulfill-from location — the delivery row
    // itself lives on the selling store's calendar.
    const [stockOwner] = await this.db
      .select({ stockLocationId: schema.orders.stockLocationId })
      .from(schema.orders)
      .where(eq(schema.orders.id, row.orderId))
      .limit(1);
    await this.orders.applyFulfillment(this.db, {
      businessId: tenant.businessId!,
      orderId: row.orderId,
      locationId: stockOwner?.stockLocationId ?? row.locationId,
      actorUserId: actor?.id ?? null,
      steps: plan.steps,
      referenceType: 'delivery',
      referenceId: id,
    });
    await this.db
      .update(schema.deliveries)
      .set({ status: 'delivered', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.deliveries.id, id));

    await this.advanceOrder(row.orderId);

    await this.audit.log({
      action: 'delivery.delivered',
      targetType: 'delivery',
      targetId: id,
      after: { orderId: row.orderId, units: plan.steps.reduce((s, x) => s + x.quantity, 0) },
    });
    const detail = await this.hydrate(await this.load(id));
    this.fireEvent('delivery.delivered', tenant.businessId!, detail);
    return detail;
  }

  @Post('deliveries/:id/cancel')
  @RequirePermission('deliveries.schedule')
  async cancel(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<DeliveryDetail> {
    const row = await this.load(id);
    if (!EDITABLE.includes(row.status as DeliveryStatus)) {
      throw new BadRequestException(`A ${row.status} delivery cannot be cancelled`);
    }
    await this.db
      .update(schema.deliveries)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(schema.deliveries.id, id));
    await this.audit.log({ action: 'delivery.cancel', targetType: 'delivery', targetId: id });
    await this.ticketFlags.applyEdit(
      row.orderId,
      { kind: 'header_change', field: 'next_delivery_date' },
      'delivery.cancel',
    );
    return this.hydrate(await this.load(id));
  }

  // ---------------------------------------------------------------------
  // Delivery runs (PLAN-STORIS-GAP §4 / G7 — the manifest)
  // ---------------------------------------------------------------------

  /**
   * Build a run from scheduled deliveries. Membership on the run is the
   * A5 hard lock on the underlying orders; the run carries the COD the
   * driver must collect.
   */
  @Post('delivery-runs')
  @RequirePermission('deliveries.schedule')
  async createRun(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body()
    body: {
      runDate?: string;
      route?: string | null;
      truck?: string | null;
      driverMembershipId?: string | null;
      notes?: string | null;
      deliveryIds?: string[];
    },
  ): Promise<{ id: string }> {
    if (!body.runDate || Number.isNaN(new Date(body.runDate).getTime())) {
      throw new BadRequestException('runDate (YYYY-MM-DD) is required');
    }
    if (!body.deliveryIds || body.deliveryIds.length === 0) {
      throw new BadRequestException('deliveryIds must contain at least one delivery');
    }
    const stops = await this.db
      .select()
      .from(schema.deliveries)
      .where(inArray(schema.deliveries.id, body.deliveryIds));
    if (stops.length !== body.deliveryIds.length) {
      throw new NotFoundException('One or more deliveries were not found');
    }
    for (const d of stops) {
      if (!['scheduled', 'loaded'].includes(d.status)) {
        throw new BadRequestException(`Delivery ${d.id} is ${d.status} — not loadable`);
      }
      if (d.runId) throw new ConflictException(`Delivery ${d.id} is already on a run`);
      if (d.scheduledDate !== body.runDate) {
        throw new BadRequestException(
          `Delivery ${d.id} is scheduled ${d.scheduledDate}, not ${body.runDate}`,
        );
      }
    }
    const codDueCents = await this.codDueFor(stops.map((d) => d.orderId));

    const [run] = await this.db
      .insert(schema.deliveryRuns)
      .values({
        businessId: tenant.businessId!,
        locationId: stops[0]!.locationId,
        runDate: body.runDate,
        route: body.route ?? stops[0]!.route ?? null,
        truck: body.truck ?? null,
        driverMembershipId: body.driverMembershipId ?? stops[0]!.driverMembershipId ?? null,
        notes: body.notes ?? null,
        codDueCents,
        createdByUserId: actor?.id ?? null,
      })
      .returning();
    await this.db
      .update(schema.deliveries)
      .set({ runId: run!.id, updatedAt: new Date() })
      .where(inArray(schema.deliveries.id, body.deliveryIds));
    await this.audit.log({
      action: 'delivery_run.create',
      targetType: 'delivery_run',
      targetId: run!.id,
      after: { runDate: body.runDate, stops: stops.length, codDueCents },
    });
    return { id: run!.id };
  }

  @Get('delivery-runs')
  @RequirePermission('deliveries.view')
  async listRuns(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('date') date?: string,
    @Query('status') status?: string,
  ): Promise<unknown[]> {
    const runs = await this.db
      .select()
      .from(schema.deliveryRuns)
      .where(
        and(
          eq(schema.deliveryRuns.businessId, tenant.businessId!),
          date ? eq(schema.deliveryRuns.runDate, date) : undefined,
          status ? eq(schema.deliveryRuns.status, status) : undefined,
        ),
      )
      .orderBy(asc(schema.deliveryRuns.runDate), asc(schema.deliveryRuns.createdAt))
      .limit(100);
    return Promise.all(runs.map((r) => this.hydrateRun(r)));
  }

  @Get('delivery-runs/:id')
  @RequirePermission('deliveries.view')
  async getRun(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<unknown> {
    return this.hydrateRun(await this.loadRun(id));
  }

  /** The truck leaves: every stop flips to out_for_delivery. */
  @Post('delivery-runs/:id/depart')
  @RequirePermission('deliveries.complete')
  async departRun(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ status: string }> {
    const run = await this.loadRun(id);
    if (run.status !== 'open') throw new ConflictException(`Run is ${run.status}`);
    await this.db
      .update(schema.deliveryRuns)
      .set({ status: 'out' })
      .where(eq(schema.deliveryRuns.id, id));
    await this.db
      .update(schema.deliveries)
      .set({ status: 'out_for_delivery', updatedAt: new Date() })
      .where(
        and(
          eq(schema.deliveries.runId, id),
          inArray(schema.deliveries.status, ['scheduled', 'loaded']),
        ),
      );
    await this.audit.log({
      action: 'delivery_run.depart',
      targetType: 'delivery_run',
      targetId: id,
    });
    return { status: 'out' };
  }

  /**
   * Pulling an order off a run needs a coded reason and writes the
   * manifest-removal exception (STORIS S$TE_MAINIF_RMV).
   */
  @Post('delivery-runs/:id/remove-delivery')
  @RequirePermission('deliveries.schedule')
  async removeFromRun(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { deliveryId?: string; reasonCodeId?: string; reason?: string },
  ): Promise<{ removed: string }> {
    const run = await this.loadRun(id);
    if (run.status === 'completed') throw new ConflictException('Run is already completed');
    if (!body.deliveryId) throw new BadRequestException('deliveryId is required');
    const [d] = await this.db
      .select()
      .from(schema.deliveries)
      .where(eq(schema.deliveries.id, body.deliveryId))
      .limit(1);
    if (!d || d.runId !== id) throw new NotFoundException('Delivery is not on this run');
    const reason = await this.overrides.resolveReason('manifest_removal', {
      reasonCodeId: body.reasonCodeId,
      reason: body.reason,
    });
    await this.db
      .update(schema.deliveries)
      .set({
        runId: null,
        status: d.status === 'out_for_delivery' ? 'loaded' : d.status,
        updatedAt: new Date(),
      })
      .where(eq(schema.deliveries.id, body.deliveryId));
    await this.db
      .update(schema.deliveryRuns)
      .set({ codDueCents: await this.codDueForRun(id) })
      .where(eq(schema.deliveryRuns.id, id));
    await this.audit.log({
      action: 'delivery_run.remove',
      targetType: 'delivery',
      targetId: body.deliveryId,
      metadata: { runId: id, reason: reason.reasonText, reasonCode: reason.reasonCode },
    });
    await this.exceptions.record({
      type: 'manifest_removal',
      severity: 'warning',
      entityType: 'order',
      entityId: d.orderId,
      summary: `Delivery pulled off run ${run.runDate}${run.route ? ` (${run.route})` : ''}`,
      metadata: {
        runId: id,
        deliveryId: d.id,
        reason: reason.reasonText,
        reasonCode: reason.reasonCode,
      },
    });
    return { removed: body.deliveryId };
  }

  /**
   * Close-out (STORIS "Complete the Delivery Manifest Process"): the
   * mandatory reconciliation. Every open stop needs an outcome —
   * delivered (goods leave: stock, reservations, order status) or
   * failed (coded reason, optional auto-reschedule). COD due vs
   * collected is compared and a variance is registered, never dropped.
   */
  @Post('delivery-runs/:id/close')
  @RequirePermission('deliveries.complete')
  async closeRun(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: {
      outcomes?: {
        deliveryId?: string;
        outcome?: 'delivered' | 'failed';
        reasonCodeId?: string;
        reason?: string;
        rescheduleDate?: string;
      }[];
      codCollectedCents?: number;
      codReceivedBy?: string | null;
    },
  ): Promise<unknown> {
    const run = await this.loadRun(id);
    if (run.status === 'completed') throw new ConflictException('Run is already completed');

    const stops = await this.db
      .select()
      .from(schema.deliveries)
      .where(eq(schema.deliveries.runId, id));
    const open = stops.filter((d) => !['delivered', 'failed', 'cancelled'].includes(d.status));
    const outcomes = new Map((body.outcomes ?? []).map((o) => [o.deliveryId, o]));
    const missing = open.filter((d) => !outcomes.get(d.id)?.outcome);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Every stop needs an outcome — missing: ${missing.map((d) => d.id).join(', ')}`,
      );
    }

    for (const d of open) {
      const o = outcomes.get(d.id)!;
      if (o.outcome === 'delivered') {
        await this.complete(tenant, actor, d.id, {});
      } else {
        const reason = await this.overrides.resolveReason('delivery_failure', {
          reasonCodeId: o.reasonCodeId,
          reason: o.reason,
        });
        await this.complete(tenant, actor, d.id, {
          failed: true,
          notes: reason.reasonText ?? reason.reasonCode ?? 'failed',
        });
        await this.db
          .update(schema.deliveries)
          .set({ failureReasonCodeId: reason.reasonCodeId })
          .where(eq(schema.deliveries.id, d.id));
        await this.exceptions.record({
          type: 'delivery_failed',
          severity: 'warning',
          entityType: 'order',
          entityId: d.orderId,
          summary: `Stop failed on run ${run.runDate}: ${reason.reasonText ?? reason.reasonCode ?? '—'}`,
          metadata: { deliveryId: d.id, reasonCode: reason.reasonCode, reason: reason.reasonText },
        });
        if (o.rescheduleDate) {
          const lines = await this.db
            .select()
            .from(schema.deliveryLines)
            .where(eq(schema.deliveryLines.deliveryId, d.id));
          const [redo] = await this.db
            .insert(schema.deliveries)
            .values({
              businessId: tenant.businessId!,
              locationId: d.locationId,
              orderId: d.orderId,
              scheduledDate: o.rescheduleDate,
              route: d.route,
              notes: `Rescheduled after failed stop (${reason.reasonCode ?? reason.reasonText ?? ''})`,
            })
            .returning();
          if (lines.length > 0) {
            await this.db.insert(schema.deliveryLines).values(
              lines.map((l) => ({
                businessId: tenant.businessId!,
                deliveryId: redo!.id,
                orderLineId: l.orderLineId,
                quantity: l.quantity,
              })),
            );
          }
        }
      }
    }

    // COD reconciliation: what the driver owes the drawer vs what came
    // back. The due side counts the stops that actually delivered.
    const deliveredOrderIds = open
      .filter((d) => outcomes.get(d.id)!.outcome === 'delivered')
      .map((d) => d.orderId);
    const codDue = await this.codDueFor(deliveredOrderIds);
    const collected = body.codCollectedCents ?? 0;
    if (!Number.isInteger(collected) || collected < 0) {
      throw new BadRequestException('codCollectedCents must be a non-negative integer');
    }
    if (codDue !== collected) {
      await this.exceptions.record({
        type: 'cod_variance',
        severity: 'warning',
        entityType: 'delivery_run',
        entityId: id,
        summary: `Run ${run.runDate}: COD due $${(codDue / 100).toFixed(2)}, collected $${(collected / 100).toFixed(2)}`,
        metadata: {
          codDueCents: codDue,
          codCollectedCents: collected,
          receivedBy: body.codReceivedBy ?? null,
        },
      });
    }

    await this.db
      .update(schema.deliveryRuns)
      .set({
        status: 'completed',
        codDueCents: codDue,
        codCollectedCents: collected,
        codReceivedBy: body.codReceivedBy ?? null,
        completedAt: new Date(),
        completedByUserId: actor?.id ?? null,
      })
      .where(eq(schema.deliveryRuns.id, id));
    await this.audit.log({
      action: 'delivery_run.close',
      targetType: 'delivery_run',
      targetId: id,
      after: {
        delivered: deliveredOrderIds.length,
        failed: open.length - deliveredOrderIds.length,
        codDueCents: codDue,
        codCollectedCents: collected,
      },
    });
    return this.hydrateRun(await this.loadRun(id));
  }

  private async loadRun(id: string) {
    const [run] = await this.db
      .select()
      .from(schema.deliveryRuns)
      .where(eq(schema.deliveryRuns.id, id))
      .limit(1);
    if (!run) throw new NotFoundException('Delivery run not found');
    return run;
  }

  /** Balance still owed across a set of orders — the COD the run carries. */
  private async codDueFor(orderIds: string[]): Promise<number> {
    if (orderIds.length === 0) return 0;
    const unique = [...new Set(orderIds)];
    const orders = await this.db
      .select({ id: schema.orders.id, totalCents: schema.orders.totalCents })
      .from(schema.orders)
      .where(inArray(schema.orders.id, unique));
    const payments = await this.db
      .select({
        orderId: schema.payments.orderId,
        amountCents: schema.payments.amountCents,
        status: schema.payments.status,
      })
      .from(schema.payments)
      .where(inArray(schema.payments.orderId, unique));
    const paidBy = new Map<string, number>();
    for (const p of payments) {
      if (p.status !== 'succeeded' || !p.orderId) continue;
      paidBy.set(p.orderId, (paidBy.get(p.orderId) ?? 0) + p.amountCents);
    }
    return orders.reduce((sum, o) => sum + Math.max(0, o.totalCents - (paidBy.get(o.id) ?? 0)), 0);
  }

  private async codDueForRun(runId: string): Promise<number> {
    const stops = await this.db
      .select({ orderId: schema.deliveries.orderId })
      .from(schema.deliveries)
      .where(eq(schema.deliveries.runId, runId));
    return this.codDueFor(stops.map((s) => s.orderId));
  }

  private async hydrateRun(run: typeof schema.deliveryRuns.$inferSelect) {
    const stops = await this.db
      .select()
      .from(schema.deliveries)
      .where(eq(schema.deliveries.runId, run.id))
      .orderBy(asc(schema.deliveries.routePosition), asc(schema.deliveries.createdAt));
    const detailed = await Promise.all(stops.map((s) => this.hydrate(s)));
    // The day sheet prints the driver; readers with deliveries.view cannot
    // list members, so the run carries the name.
    const [driver] = run.driverMembershipId
      ? await this.db
          .select({ name: schema.users.name })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(eq(schema.memberships.id, run.driverMembershipId))
          .limit(1)
      : [];
    return { ...run, driverName: driver?.name ?? null, stops: detailed };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** ops.deliveryDailyCap, defaulting to the spec's 15 stops/day. */
  private async dailyCap(businessId: string): Promise<number> {
    return (await this.capacityConfig(businessId)).stopCap;
  }

  /**
   * G12 multi-dimensional capacity: stops (always), pieces and capacity
   * units (opt-in via ops). A truck fills by volume, not stop count —
   * fifteen twins and fifteen king sets are not the same day.
   */
  private async capacityConfig(businessId: string): Promise<{
    stopCap: number;
    pieceCap: number | null;
    unitCap: number | null;
    zipRoutes: Record<string, string> | null;
  }> {
    const [biz] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const ops = (biz?.opsSettingsJson ?? {}) as {
      deliveryDailyCap?: number;
      deliveryDailyPieceCap?: number | null;
      deliveryDailyCapacityUnits?: number | null;
      zipRoutes?: Record<string, string> | null;
    };
    return {
      stopCap: ops.deliveryDailyCap && ops.deliveryDailyCap > 0 ? ops.deliveryDailyCap : 15,
      pieceCap:
        ops.deliveryDailyPieceCap && ops.deliveryDailyPieceCap > 0
          ? ops.deliveryDailyPieceCap
          : null,
      unitCap:
        ops.deliveryDailyCapacityUnits && ops.deliveryDailyCapacityUnits > 0
          ? ops.deliveryDailyCapacityUnits
          : null,
      zipRoutes: ops.zipRoutes ?? null,
    };
  }

  /** Booked load for one day: stops, pieces, and capacity units. */
  private async dayLoad(date: string): Promise<{ stops: number; pieces: number; units: number }> {
    const [row] = await this.db
      .select({
        stops: sql<number>`count(distinct ${schema.deliveries.id})::int`,
        // A20 "Assign Pieces": a unit can be several pieces on the truck.
        pieces: sql<number>`coalesce(sum(${schema.deliveryLines.quantity} * coalesce(${schema.orderLines.pieces}, 1)), 0)::int`,
        units: sql<number>`coalesce(sum(${schema.deliveryLines.quantity} * coalesce(${schema.productVariants.capacityUnits}, 1)), 0)::int`,
      })
      .from(schema.deliveries)
      .leftJoin(schema.deliveryLines, eq(schema.deliveryLines.deliveryId, schema.deliveries.id))
      .leftJoin(schema.orderLines, eq(schema.orderLines.id, schema.deliveryLines.orderLineId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(
        and(
          eq(schema.deliveries.scheduledDate, date),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      );
    return row ?? { stops: 0, pieces: 0, units: 0 };
  }

  private async load(id: string): Promise<DeliveryRow> {
    const [row] = await this.db
      .select()
      .from(schema.deliveries)
      .where(eq(schema.deliveries.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Delivery not found');
    return row;
  }

  /** Units of each order line riding on a live delivery (not this one's history). */
  private async pendingByOrderLine(orderId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        orderLineId: schema.deliveryLines.orderLineId,
        quantity: schema.deliveryLines.quantity,
        status: schema.deliveries.status,
      })
      .from(schema.deliveryLines)
      .innerJoin(schema.deliveries, eq(schema.deliveries.id, schema.deliveryLines.deliveryId))
      .where(
        and(
          eq(schema.deliveries.orderId, orderId),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      );
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.orderLineId, (map.get(r.orderLineId) ?? 0) + r.quantity);
    return map;
  }

  /** Recompute the order's fulfillment status from its lines and persist. */
  private async advanceOrder(orderId: string): Promise<void> {
    const lines = await this.db
      .select({
        quantity: schema.orderLines.quantity,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, orderId));
    const status = deriveFulfillmentStatus(lines);
    await this.db
      .update(schema.orders)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(schema.orders.id, orderId),
          inArray(schema.orders.status, ['open', 'partially_fulfilled', 'fulfilled']),
        ),
      );
  }

  private async hydrate(row: DeliveryRow): Promise<DeliveryDetail> {
    const [order] = await this.db
      .select({
        number: schema.orders.number,
        customerId: schema.orders.customerId,
        fulfillmentType: schema.orders.fulfillmentType,
        totalCents: schema.orders.totalCents,
        addressLine1: schema.orders.addressLine1,
        addressLine2: schema.orders.addressLine2,
        addressCity: schema.orders.addressCity,
        addressRegion: schema.orders.addressRegion,
        addressPostalCode: schema.orders.addressPostalCode,
        addressPhone: schema.orders.addressPhone,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, row.orderId))
      .limit(1);
    const [customer] = order
      ? await this.db
          .select({
            firstName: schema.customers.firstName,
            lastName: schema.customers.lastName,
          })
          .from(schema.customers)
          .where(eq(schema.customers.id, order.customerId))
          .limit(1)
      : [];
    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, row.orderId));
    const paid = payments
      .filter((p) => p.status === 'succeeded')
      .reduce((s, p) => s + p.amountCents, 0);
    const lines = await this.db
      .select({
        id: schema.deliveryLines.id,
        orderLineId: schema.deliveryLines.orderLineId,
        quantity: schema.deliveryLines.quantity,
        // A20 "Assign Pieces": what the crew loads and ticks, not the unit count.
        pieces: sql<number>`(${schema.deliveryLines.quantity} * coalesce(${schema.orderLines.pieces}, 1))::int`,
        description: schema.orderLines.description,
        lineType: schema.orderLines.lineType,
      })
      .from(schema.deliveryLines)
      .innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.deliveryLines.orderLineId))
      .where(eq(schema.deliveryLines.deliveryId, row.id));
    const [ret] = row.returnId
      ? await this.db
          .select({ rmaNumber: schema.orderReturns.rmaNumber })
          .from(schema.orderReturns)
          .where(eq(schema.orderReturns.id, row.returnId))
          .limit(1)
      : [];
    return {
      ...row,
      orderNumber: order?.number ?? '?',
      rmaNumber: ret?.rmaNumber ?? null,
      customerId: order?.customerId ?? '',
      customerName: customer
        ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null
        : null,
      addressLine1: order?.addressLine1 ?? null,
      addressLine2: order?.addressLine2 ?? null,
      addressCity: order?.addressCity ?? null,
      addressRegion: order?.addressRegion ?? null,
      addressPostalCode: order?.addressPostalCode ?? null,
      addressPhone: order?.addressPhone ?? null,
      fulfillmentType: order?.fulfillmentType ?? 'delivery',
      balanceDueCents: Math.max(0, (order?.totalCents ?? 0) - paid),
      lines,
    };
  }

  private fireEvent(
    eventType: 'delivery.scheduled' | 'delivery.delivered',
    businessId: string,
    detail: DeliveryDetail,
  ): void {
    void this.webhooks.fire({
      businessId,
      eventType,
      payload: {
        deliveryId: detail.id,
        orderId: detail.orderId,
        orderNumber: detail.orderNumber,
        status: detail.status,
        scheduledDate: detail.scheduledDate,
      },
    });
  }
}
