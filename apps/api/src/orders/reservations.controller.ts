import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { assertOrderEditable } from './order-guards';
import { LIVE_ORDER_STATUSES } from './order-math';
import { OrdersService } from './orders.service';

/**
 * A22 slice 3 — STORIS "Reassign Reservation": for one product at one
 * location, every open order line that wants it (reserved or waiting),
 * and the two moves — reserve units onto a line, or put a line's
 * reserved units back (back order) — so a manager can hand today's
 * piece to the customer who needs it first. Both moves go through the
 * order service's reserve/release primitives, so the stock math and the
 * `order_reserve` / `order_release` ledger rows are the same ones the
 * order page writes.
 */

const MOVE_ACTIONS = ['reserve', 'back_order'] as const;

export interface ReservationBoardRow {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  orderKind: string;
  fulfillmentType: string | null;
  deliveryStatus: string | null;
  orderDate: Date;
  /** The date the line has to be filled by: its own delivery date, else the order's requested date. */
  fillBy: string | null;
  customerName: string | null;
  lineId: string;
  description: string;
  quantity: number;
  qtyReserved: number;
  qtyFulfilled: number;
  /** Units the line still lacks — neither fulfilled nor reserved. */
  shortfall: number;
}

export interface ReservationBoard {
  strip: {
    onHand: number;
    reserved: number;
    floorSample: number;
    available: number;
  };
  rows: ReservationBoardRow[];
}

interface MoveBody {
  variantId?: string;
  locationId?: string;
  quantity?: number;
  action?: (typeof MOVE_ACTIONS)[number];
  /** The line giving units up (required for back_order; optional for reserve = move between orders). */
  fromLineId?: string;
  /** The line receiving units (required for reserve). */
  toLineId?: string;
}

type LineWithOrder = {
  line: typeof schema.orderLines.$inferSelect;
  order: typeof schema.orders.$inferSelect;
};

@TenantScoped()
@Controller('v1/inventory')
export class ReservationsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  @Get('reservation-board')
  @RequirePermission('inventory.view')
  async board(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('variantId') variantId?: string,
    @Query('locationId') locationId?: string,
  ): Promise<ReservationBoard> {
    if (!variantId || !locationId) {
      throw new BadRequestException('variantId and locationId are required');
    }
    const [level] = await this.db
      .select({
        onHand: schema.inventoryLevels.onHand,
        reserved: schema.inventoryLevels.reserved,
        floorSample: schema.inventoryLevels.floorSample,
      })
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, variantId),
          eq(schema.inventoryLevels.locationId, locationId),
        ),
      )
      .limit(1);
    const strip = {
      onHand: level?.onHand ?? 0,
      reserved: level?.reserved ?? 0,
      floorSample: level?.floorSample ?? 0,
      available: Math.max(
        0,
        (level?.onHand ?? 0) - (level?.reserved ?? 0) - (level?.floorSample ?? 0),
      ),
    };
    const rows = await this.db
      .select({
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        orderStatus: schema.orders.status,
        orderKind: schema.orders.orderKind,
        fulfillmentType: schema.orders.fulfillmentType,
        deliveryStatus: schema.orders.deliveryStatus,
        orderDate: schema.orders.createdAt,
        lineDeliveryDate: schema.orderLines.deliveryDate,
        requestedDate: schema.orders.requestedDate,
        customerName: sql<
          string | null
        >`NULLIF(TRIM(CONCAT(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        lineId: schema.orderLines.id,
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orderLines.variantId, variantId),
          inArray(schema.orders.status, [...LIVE_ORDER_STATUSES]),
          sql`${schema.orderLines.quantity} > ${schema.orderLines.qtyFulfilled}`,
          sql`COALESCE(${schema.orderLines.sourceLocationId}, ${schema.orders.stockLocationId}, ${schema.orders.locationId}) = ${locationId}`,
        ),
      )
      .orderBy(asc(schema.orders.createdAt), asc(schema.orderLines.createdAt));
    return {
      strip,
      rows: rows.map((r) => ({
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        orderStatus: r.orderStatus,
        orderKind: r.orderKind,
        fulfillmentType: r.fulfillmentType,
        deliveryStatus: r.deliveryStatus,
        orderDate: r.orderDate,
        fillBy: r.lineDeliveryDate ?? r.requestedDate ?? null,
        customerName: r.customerName,
        lineId: r.lineId,
        description: r.description,
        quantity: r.quantity,
        qtyReserved: r.qtyReserved,
        qtyFulfilled: r.qtyFulfilled,
        shortfall: Math.max(0, r.quantity - r.qtyFulfilled - r.qtyReserved),
      })),
    };
  }

  /**
   * Move reserved units. `back_order` hands `quantity` of `fromLineId`'s
   * reservation back to available stock; `reserve` commits `quantity`
   * available units to `toLineId` — first releasing them from
   * `fromLineId` when the piece is being taken from another order. Both
   * orders must pass the order-edit guards (live, unlocked, off the
   * truck), and a reserve never exceeds what the target line still
   * lacks or what the location has free.
   */
  @Post('reservations/move')
  @RequirePermission('orders.update')
  async move(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: MoveBody,
  ): Promise<ReservationBoard> {
    const { variantId, locationId, quantity, action } = body;
    if (!variantId || !locationId) {
      throw new BadRequestException('variantId and locationId are required');
    }
    if (!Number.isInteger(quantity) || (quantity ?? 0) <= 0) {
      throw new BadRequestException('quantity must be a positive integer');
    }
    if (!action || !MOVE_ACTIONS.includes(action)) {
      throw new BadRequestException(`action must be one of ${MOVE_ACTIONS.join(', ')}`);
    }
    const from = body.fromLineId
      ? await this.loadLine(body.fromLineId, variantId, locationId)
      : null;
    const to = body.toLineId ? await this.loadLine(body.toLineId, variantId, locationId) : null;
    if (action === 'back_order' && !from) {
      throw new BadRequestException('fromLineId is required to back order a reservation');
    }
    if (action === 'reserve' && !to) {
      throw new BadRequestException('toLineId is required to reserve');
    }
    if (from && to && from.line.id === to.line.id) {
      throw new BadRequestException('fromLineId and toLineId must differ');
    }
    if (from) {
      await assertOrderEditable(this.db, from.order);
      if (from.line.qtyReserved < quantity!) {
        throw new BadRequestException(
          `${from.order.number} holds only ${from.line.qtyReserved} reserved unit(s) on that line`,
        );
      }
    }
    if (to) {
      await assertOrderEditable(this.db, to.order);
      const lacks = to.line.quantity - to.line.qtyFulfilled - to.line.qtyReserved;
      if (lacks < quantity!) {
        throw new BadRequestException(
          `${to.order.number} still lacks only ${Math.max(0, lacks)} unit(s) on that line`,
        );
      }
    }

    // Lock the level row for the rest of the request so two managers
    // reassigning the same piece serialize (same rule as order entry).
    const levels = await this.orders.stockLevels(this.db, locationId, [variantId], { lock: true });
    const level = levels.get(variantId) ?? { onHand: 0, reserved: 0 };
    let available = level.onHand - level.reserved;

    if (from) {
      await this.orders.applyReleases(this.db, {
        businessId: tenant.businessId!,
        orderId: from.order.id,
        locationId,
        actorUserId: actor.id,
        releases: [{ orderLineId: from.line.id, variantId, quantity: quantity! }],
      });
      available += quantity!;
    }
    if (to) {
      if (available < quantity!) {
        throw new BadRequestException(
          `Only ${Math.max(0, available)} unit(s) available here — back order another line first`,
        );
      }
      await this.orders.applyReservations(this.db, {
        businessId: tenant.businessId!,
        orderId: to.order.id,
        locationId,
        actorUserId: actor.id,
        reservations: [{ orderLineId: to.line.id, variantId, quantity: quantity! }],
      });
    }

    await this.audit.log({
      action:
        action === 'reserve' ? 'inventory.reservation.reserve' : 'inventory.reservation.back_order',
      targetType: 'product_variant',
      targetId: variantId,
      before: from
        ? { orderId: from.order.id, orderNumber: from.order.number, lineId: from.line.id }
        : null,
      after: {
        locationId,
        quantity,
        ...(to ? { orderId: to.order.id, orderNumber: to.order.number, lineId: to.line.id } : {}),
      },
    });
    // Like the order page's line release, the ledger rows and the audit
    // entry are the record — no outbound event for a reservation move.
    return this.board(tenant, variantId, locationId);
  }

  private async loadLine(
    lineId: string,
    variantId: string,
    locationId: string,
  ): Promise<LineWithOrder> {
    const [hit] = await this.db
      .select({ line: schema.orderLines, order: schema.orders })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .where(eq(schema.orderLines.id, lineId))
      .limit(1);
    if (!hit) throw new NotFoundException('Order line not found');
    if (hit.line.variantId !== variantId) {
      throw new BadRequestException(`Line on ${hit.order.number} is for a different product`);
    }
    const effective =
      hit.line.sourceLocationId ?? hit.order.stockLocationId ?? hit.order.locationId;
    if (effective !== locationId) {
      throw new BadRequestException(
        `Line on ${hit.order.number} reserves from a different location`,
      );
    }
    return hit;
  }
}
