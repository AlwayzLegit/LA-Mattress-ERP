import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

/**
 * STORIS "Logistical Scheduling" (A22 slice 5), the two views the
 * calendar does not cover:
 *
 * - **Search for schedules** — one list across sales-order deliveries,
 *   stock transfers and service calls: deliver-from location, route,
 *   truck, transfer-to location, date range (past dates on request).
 * - **Confirm schedule** — the day's deliveries with the confirmation
 *   call's Contact Status, the Stops / Units / Dollars / Volume strip,
 *   and the T D F P OO flags (ticket printed, dollars due, fully
 *   reserved, pick list printed, on open PO).
 *
 * Contact status is a delivery field (migration 0096): the call is part
 * of the schedule, not a note.
 */

export const CONTACT_STATUSES = [
  'not_contacted',
  'left_message',
  'no_answer',
  'confirmed',
  'reschedule_requested',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

const KINDS = ['orders', 'transfers', 'service'] as const;
type Kind = (typeof KINDS)[number];
const LIVE_DELIVERY_STATUSES = ['scheduled', 'loaded', 'out_for_delivery'] as const;
const DEFAULT_SPAN_DAYS = 35;

export interface ScheduleRow {
  kind: 'order' | 'transfer' | 'service';
  /** The schedule entry: delivery id, transfer id or service order id. */
  id: string;
  /** The document behind it: order id, transfer id or service order id. */
  documentId: string;
  number: string;
  date: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  contactStatus: string | null;
  fromLocationName: string | null;
  toLocationName: string | null;
  route: string | null;
  truck: string | null;
  /** Driver (deliveries) or technician (service calls). */
  crewName: string | null;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  postalCode: string | null;
  units: number;
  dollarsCents: number;
  balanceDueCents: number | null;
  volume: number;
}

export interface ScheduleTotals {
  stops: number;
  units: number;
  dollarsCents: number;
  volume: number;
}

export interface ConfirmRow {
  deliveryId: string;
  orderId: string;
  orderNumber: string;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  contactStatus: string | null;
  contactedAt: Date | null;
  route: string | null;
  truck: string | null;
  routePosition: number | null;
  driverName: string | null;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  postalCode: string | null;
  fulfillmentType: string;
  units: number;
  dollarsCents: number;
  balanceDueCents: number;
  volume: number;
  flags: { T: boolean; D: boolean; F: boolean; P: boolean; OO: boolean };
  notes: string | null;
}

function ymd(v: string | undefined, label: string): string | null {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException(`${label} must be YYYY-MM-DD`);
  return v;
}
function addDays(day: string, n: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function csv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
const contains = (col: SQLWrapper, needle: string) =>
  sql`${col} ILIKE ${`%${needle.replace(/[%_]/g, '\\$&')}%`}`;

@TenantScoped()
@Controller('v1')
export class SchedulingController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Search for schedules. `kind` picks the list; the date range defaults
   * to today → +35 days, and `includePast=1` drops the lower bound so
   * yesterday's unfinished stops show too.
   */
  @Get('scheduling/search')
  @RequirePermission('deliveries.view')
  async search(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('kind') kindRaw?: string,
    @Query('locationId') locationId?: string,
    @Query('toLocationId') toLocationId?: string,
    @Query('route') route?: string,
    @Query('truck') truck?: string,
    @Query('start') startRaw?: string,
    @Query('end') endRaw?: string,
    @Query('includePast') includePast?: string,
    @Query('status') status?: string,
    @Query('contactStatus') contactStatus?: string,
  ): Promise<{
    kind: Kind;
    range: { start: string | null; end: string };
    rows: ScheduleRow[];
    totals: ScheduleTotals;
  }> {
    const kind = (kindRaw || 'orders') as Kind;
    if (!KINDS.includes(kind)) {
      throw new BadRequestException(`kind must be one of ${KINDS.join(', ')}`);
    }
    const past = includePast === '1' || includePast === 'true';
    const today = isoToday();
    const start = past ? null : (ymd(startRaw, 'start') ?? today);
    const end = ymd(endRaw, 'end') ?? addDays(start ?? today, DEFAULT_SPAN_DAYS);
    if (start && end < start) throw new BadRequestException('end must not be before start');
    const filters = {
      locationId: locationId || null,
      toLocationId: toLocationId || null,
      route: route?.trim() || null,
      truck: truck?.trim() || null,
      status: status?.trim() || null,
      contactStatus: csv(contactStatus),
      start,
      end,
    };
    const rows =
      kind === 'orders'
        ? await this.deliveryRows(filters)
        : kind === 'transfers'
          ? await this.transferRows(filters)
          : await this.serviceRows(filters);
    return { kind, range: { start, end }, rows, totals: totalsOf(rows) };
  }

  /**
   * Confirm schedule: the deliveries of a day (or range) with the
   * confirmation-call status, the totals strip and the flags.
   */
  @Get('scheduling/confirm')
  @RequirePermission('deliveries.view')
  async confirm(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
    @Query('date') dateRaw?: string,
    @Query('start') startRaw?: string,
    @Query('end') endRaw?: string,
    @Query('deliveryStatus') deliveryStatus?: string,
    @Query('contactStatus') contactStatus?: string,
    @Query('route') route?: string,
  ): Promise<{
    range: { start: string; end: string };
    rows: ConfirmRow[];
    totals: ScheduleTotals & { confirmed: number };
  }> {
    const date = ymd(dateRaw, 'date');
    const start = date ?? ymd(startRaw, 'start') ?? isoToday();
    const end = date ?? ymd(endRaw, 'end') ?? start;
    if (end < start) throw new BadRequestException('end must not be before start');
    const statuses = csv(deliveryStatus);
    const contacts = csv(contactStatus);
    for (const c of contacts) {
      if (c !== 'none' && !(CONTACT_STATUSES as readonly string[]).includes(c)) {
        throw new BadRequestException(
          `contactStatus must be among ${[...CONTACT_STATUSES, 'none'].join(', ')}`,
        );
      }
    }
    const where = and(
      gte(schema.deliveries.scheduledDate, start),
      lte(schema.deliveries.scheduledDate, end),
      locationId ? eq(schema.deliveries.locationId, locationId) : undefined,
      statuses.length
        ? inArray(schema.deliveries.status, statuses)
        : inArray(schema.deliveries.status, [...LIVE_DELIVERY_STATUSES]),
      contactFilter(contacts),
      route?.trim()
        ? contains(
            sql`COALESCE(${schema.deliveries.route}, ${schema.deliveryRuns.route})`,
            route.trim(),
          )
        : undefined,
    );
    const rows = await this.db
      .select({
        deliveryId: schema.deliveries.id,
        orderId: schema.deliveries.orderId,
        orderNumber: schema.orders.number,
        scheduledDate: schema.deliveries.scheduledDate,
        windowStart: schema.deliveries.windowStart,
        windowEnd: schema.deliveries.windowEnd,
        status: schema.deliveries.status,
        contactStatus: schema.deliveries.contactStatus,
        contactedAt: schema.deliveries.contactedAt,
        route: sql<
          string | null
        >`COALESCE(${schema.deliveries.route}, ${schema.deliveryRuns.route})`,
        truck: schema.deliveryRuns.truck,
        routePosition: schema.deliveries.routePosition,
        driverName: schema.users.name,
        pickListFlag: schema.deliveries.pickListFlag,
        notes: schema.deliveries.notes,
        customerName: sql<
          string | null
        >`NULLIF(TRIM(CONCAT(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        phone: sql<
          string | null
        >`COALESCE(${schema.orders.addressPhone}, ${schema.customers.phone})`,
        city: schema.orders.addressCity,
        postalCode: schema.orders.addressPostalCode,
        fulfillmentType: schema.orders.fulfillmentType,
        totalCents: schema.orders.totalCents,
        ticketPrintCount: schema.orders.ticketPrintCount,
      })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(schema.deliveryRuns, eq(schema.deliveryRuns.id, schema.deliveries.runId))
      .leftJoin(schema.memberships, eq(schema.memberships.id, schema.deliveries.driverMembershipId))
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(where)
      .orderBy(
        asc(schema.deliveries.scheduledDate),
        asc(schema.deliveries.routePosition),
        asc(schema.deliveries.createdAt),
      )
      .limit(500);
    if (rows.length === 0) {
      return {
        range: { start, end },
        rows: [],
        totals: { stops: 0, units: 0, dollarsCents: 0, volume: 0, confirmed: 0 },
      };
    }
    const deliveryIds = rows.map((r) => r.deliveryId);
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const [loads, paid, lines, onOrder] = await Promise.all([
      this.deliveryLoads(deliveryIds),
      this.paidByOrder(orderIds),
      this.db
        .select({
          orderId: schema.orderLines.orderId,
          short: sql<number>`COALESCE(SUM(GREATEST(0, ${schema.orderLines.quantity} - ${schema.orderLines.qtyReserved} - ${schema.orderLines.qtyFulfilled})), 0)::int`,
        })
        .from(schema.orderLines)
        .where(
          and(
            inArray(schema.orderLines.orderId, orderIds),
            isNotNull(schema.orderLines.variantId),
            eq(schema.orderLines.lineType, 'stock'),
          ),
        )
        .groupBy(schema.orderLines.orderId),
      this.db
        .select({ orderId: schema.orderLines.orderId })
        .from(schema.poLineAllocations)
        .innerJoin(
          schema.orderLines,
          eq(schema.orderLines.id, schema.poLineAllocations.orderLineId),
        )
        .where(
          and(
            inArray(schema.orderLines.orderId, orderIds),
            eq(schema.poLineAllocations.status, 'ordered'),
          ),
        )
        .groupBy(schema.orderLines.orderId),
    ]);
    const shortByOrder = new Map(lines.map((l) => [l.orderId, l.short]));
    const onOrderSet = new Set(onOrder.map((o) => o.orderId));
    const out: ConfirmRow[] = rows.map((r) => {
      const load = loads.get(r.deliveryId) ?? { units: 0, volume: 0 };
      const balance = Math.max(0, r.totalCents - (paid.get(r.orderId) ?? 0));
      return {
        deliveryId: r.deliveryId,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        scheduledDate: r.scheduledDate,
        windowStart: r.windowStart,
        windowEnd: r.windowEnd,
        status: r.status,
        contactStatus: r.contactStatus,
        contactedAt: r.contactedAt,
        route: r.route,
        truck: r.truck ?? null,
        routePosition: r.routePosition,
        driverName: r.driverName ?? null,
        customerName: r.customerName,
        phone: r.phone,
        city: r.city,
        postalCode: r.postalCode,
        fulfillmentType: r.fulfillmentType,
        units: load.units,
        dollarsCents: r.totalCents,
        balanceDueCents: balance,
        volume: load.volume,
        flags: {
          T: r.ticketPrintCount > 0,
          D: balance > 0,
          F: (shortByOrder.get(r.orderId) ?? 0) === 0,
          P: r.pickListFlag != null,
          OO: onOrderSet.has(r.orderId),
        },
        notes: r.notes,
      };
    });
    return {
      range: { start, end },
      rows: out,
      totals: {
        stops: out.length,
        units: out.reduce((s, r) => s + r.units, 0),
        dollarsCents: out.reduce((s, r) => s + r.dollarsCents, 0),
        volume: out.reduce((s, r) => s + r.volume, 0),
        confirmed: out.filter((r) => r.contactStatus === 'confirmed').length,
      },
    };
  }

  /** The confirmation call's outcome on a delivery. */
  @Patch('deliveries/:id/contact')
  @RequirePermission('deliveries.schedule')
  async setContact(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { contactStatus?: ContactStatus | null; notes?: string | null },
  ): Promise<{ id: string; contactStatus: string | null; contactedAt: Date | null }> {
    const next = body.contactStatus ?? null;
    if (next !== null && !CONTACT_STATUSES.includes(next)) {
      throw new BadRequestException(`contactStatus must be one of ${CONTACT_STATUSES.join(', ')}`);
    }
    const [delivery] = await this.db
      .select({
        id: schema.deliveries.id,
        contactStatus: schema.deliveries.contactStatus,
        status: schema.deliveries.status,
      })
      .from(schema.deliveries)
      .where(eq(schema.deliveries.id, id))
      .limit(1);
    if (!delivery) throw new NotFoundException('Delivery not found');
    const contactedAt = next ? new Date() : null;
    await this.db
      .update(schema.deliveries)
      .set({ contactStatus: next, contactedAt, updatedAt: new Date() })
      .where(eq(schema.deliveries.id, id));
    await this.audit.log({
      action: 'delivery.contact',
      targetType: 'delivery',
      targetId: id,
      before: { contactStatus: delivery.contactStatus },
      after: { contactStatus: next, notes: body.notes?.trim() || null },
    });
    return { id, contactStatus: next, contactedAt };
  }

  // ─── search lists ─────────────────────────────────────────────────────

  private async deliveryRows(f: {
    locationId: string | null;
    route: string | null;
    truck: string | null;
    status: string | null;
    contactStatus: string[];
    start: string | null;
    end: string;
  }): Promise<ScheduleRow[]> {
    const rows = await this.db
      .select({
        id: schema.deliveries.id,
        orderId: schema.deliveries.orderId,
        number: schema.orders.number,
        date: schema.deliveries.scheduledDate,
        windowStart: schema.deliveries.windowStart,
        windowEnd: schema.deliveries.windowEnd,
        status: schema.deliveries.status,
        contactStatus: schema.deliveries.contactStatus,
        fromLocationName: schema.locations.name,
        route: sql<
          string | null
        >`COALESCE(${schema.deliveries.route}, ${schema.deliveryRuns.route})`,
        truck: schema.deliveryRuns.truck,
        crewName: schema.users.name,
        customerName: sql<
          string | null
        >`NULLIF(TRIM(CONCAT(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        phone: sql<
          string | null
        >`COALESCE(${schema.orders.addressPhone}, ${schema.customers.phone})`,
        city: schema.orders.addressCity,
        postalCode: schema.orders.addressPostalCode,
        totalCents: schema.orders.totalCents,
      })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.deliveries.locationId))
      .leftJoin(schema.deliveryRuns, eq(schema.deliveryRuns.id, schema.deliveries.runId))
      .leftJoin(schema.memberships, eq(schema.memberships.id, schema.deliveries.driverMembershipId))
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(
        and(
          f.start ? gte(schema.deliveries.scheduledDate, f.start) : undefined,
          lte(schema.deliveries.scheduledDate, f.end),
          f.locationId ? eq(schema.deliveries.locationId, f.locationId) : undefined,
          f.status
            ? eq(schema.deliveries.status, f.status)
            : inArray(schema.deliveries.status, [...LIVE_DELIVERY_STATUSES]),
          contactFilter(f.contactStatus),
          f.route
            ? contains(
                sql`COALESCE(${schema.deliveries.route}, ${schema.deliveryRuns.route})`,
                f.route,
              )
            : undefined,
          f.truck ? contains(schema.deliveryRuns.truck, f.truck) : undefined,
        ),
      )
      .orderBy(
        asc(schema.deliveries.scheduledDate),
        asc(schema.deliveries.routePosition),
        asc(schema.deliveries.createdAt),
      )
      .limit(500);
    if (rows.length === 0) return [];
    const [loads, paid] = await Promise.all([
      this.deliveryLoads(rows.map((r) => r.id)),
      this.paidByOrder([...new Set(rows.map((r) => r.orderId))]),
    ]);
    return rows.map((r) => {
      const load = loads.get(r.id) ?? { units: 0, volume: 0 };
      return {
        kind: 'order' as const,
        id: r.id,
        documentId: r.orderId,
        number: r.number,
        date: r.date,
        windowStart: r.windowStart,
        windowEnd: r.windowEnd,
        status: r.status,
        contactStatus: r.contactStatus,
        fromLocationName: r.fromLocationName ?? null,
        toLocationName: null,
        route: r.route,
        truck: r.truck ?? null,
        crewName: r.crewName ?? null,
        customerName: r.customerName,
        phone: r.phone,
        city: r.city,
        postalCode: r.postalCode,
        units: load.units,
        dollarsCents: r.totalCents,
        balanceDueCents: Math.max(0, r.totalCents - (paid.get(r.orderId) ?? 0)),
        volume: load.volume,
      };
    });
  }

  private async transferRows(f: {
    locationId: string | null;
    toLocationId: string | null;
    route: string | null;
    truck: string | null;
    status: string | null;
    start: string | null;
    end: string;
  }): Promise<ScheduleRow[]> {
    const from = alias(schema.locations, 'from_loc');
    const toLoc = alias(schema.locations, 'to_loc');
    const date = sql<string>`COALESCE(${schema.stockTransfers.scheduledFor}, ${schema.stockManifests.manifestDate})`;
    const routeExpr = sql`COALESCE(${schema.stockTransfers.route}, ${schema.stockManifests.routeName})`;
    const rows = await this.db
      .select({
        id: schema.stockTransfers.id,
        number: schema.stockTransfers.number,
        date,
        status: schema.stockTransfers.status,
        transferType: schema.stockTransfers.transferType,
        fromLocationName: from.name,
        toLocationName: toLoc.name,
        route: sql<string | null>`${routeExpr}`,
        truck: schema.stockManifests.routeName,
        manifestNumber: schema.stockManifests.number,
        units: sql<number>`COALESCE((SELECT SUM(COALESCE(${schema.stockTransferLines.quantityOrdered}, ${schema.stockTransferLines.quantityShipped})) FROM ${schema.stockTransferLines} WHERE ${schema.stockTransferLines.transferId} = ${schema.stockTransfers.id}), 0)::int`,
        volume: sql<number>`COALESCE((SELECT SUM(COALESCE(${schema.stockTransferLines.quantityOrdered}, ${schema.stockTransferLines.quantityShipped}) * COALESCE(${schema.productVariants.capacityUnits}, 1)) FROM ${schema.stockTransferLines} LEFT JOIN ${schema.productVariants} ON ${schema.productVariants.id} = ${schema.stockTransferLines.variantId} WHERE ${schema.stockTransferLines.transferId} = ${schema.stockTransfers.id}), 0)::int`,
      })
      .from(schema.stockTransfers)
      .leftJoin(from, eq(from.id, schema.stockTransfers.fromLocationId))
      .leftJoin(toLoc, eq(toLoc.id, schema.stockTransfers.toLocationId))
      .leftJoin(
        schema.stockManifests,
        eq(schema.stockManifests.id, schema.stockTransfers.manifestId),
      )
      .where(
        and(
          sql`${date} IS NOT NULL`,
          f.start ? sql`${date} >= ${f.start}` : undefined,
          sql`${date} <= ${f.end}`,
          f.locationId ? eq(schema.stockTransfers.fromLocationId, f.locationId) : undefined,
          f.toLocationId ? eq(schema.stockTransfers.toLocationId, f.toLocationId) : undefined,
          f.status
            ? eq(schema.stockTransfers.status, f.status)
            : inArray(schema.stockTransfers.status, ['draft', 'in_transit']),
          f.route ? contains(routeExpr, f.route) : undefined,
          f.truck ? contains(schema.stockManifests.routeName, f.truck) : undefined,
        ),
      )
      .orderBy(asc(date), asc(schema.stockTransfers.number))
      .limit(500);
    return rows.map((r) => ({
      kind: 'transfer' as const,
      id: r.id,
      documentId: r.id,
      number: r.number,
      date: r.date,
      windowStart: null,
      windowEnd: null,
      status: r.status,
      contactStatus: null,
      fromLocationName: r.fromLocationName ?? null,
      toLocationName: r.toLocationName ?? null,
      route: r.route,
      truck: r.truck ?? null,
      crewName: null,
      customerName: r.manifestNumber ? `Manifest ${r.manifestNumber}` : null,
      phone: null,
      city: null,
      postalCode: null,
      units: r.units,
      dollarsCents: 0,
      balanceDueCents: null,
      volume: r.volume,
    }));
  }

  private async serviceRows(f: {
    locationId: string | null;
    status: string | null;
    start: string | null;
    end: string;
  }): Promise<ScheduleRow[]> {
    const rows = await this.db
      .select({
        id: schema.serviceOrders.id,
        number: schema.serviceOrders.number,
        date: schema.serviceOrders.scheduledFor,
        status: schema.serviceOrders.status,
        fromLocationName: schema.locations.name,
        crewName: schema.users.name,
        customerName: sql<
          string | null
        >`NULLIF(TRIM(CONCAT(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        phone: schema.customers.phone,
        totalCents: schema.serviceOrders.totalCents,
      })
      .from(schema.serviceOrders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.serviceOrders.customerId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.serviceOrders.locationId))
      .leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.serviceOrders.technicianMembershipId),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(
        and(
          isNotNull(schema.serviceOrders.scheduledFor),
          f.start ? gte(schema.serviceOrders.scheduledFor, f.start) : undefined,
          lte(schema.serviceOrders.scheduledFor, f.end),
          f.locationId ? eq(schema.serviceOrders.locationId, f.locationId) : undefined,
          f.status
            ? eq(schema.serviceOrders.status, f.status)
            : sql`${schema.serviceOrders.status} NOT IN ('completed', 'cancelled')`,
        ),
      )
      .orderBy(asc(schema.serviceOrders.scheduledFor), asc(schema.serviceOrders.number))
      .limit(500);
    return rows.map((r) => ({
      kind: 'service' as const,
      id: r.id,
      documentId: r.id,
      number: r.number,
      date: r.date!,
      windowStart: null,
      windowEnd: null,
      status: r.status,
      contactStatus: null,
      fromLocationName: r.fromLocationName ?? null,
      toLocationName: null,
      route: null,
      truck: null,
      crewName: r.crewName ?? null,
      customerName: r.customerName,
      phone: r.phone ?? null,
      city: null,
      postalCode: null,
      units: 1,
      dollarsCents: r.totalCents,
      balanceDueCents: null,
      volume: 0,
    }));
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  /** Units and capacity volume riding each delivery. */
  private async deliveryLoads(
    deliveryIds: string[],
  ): Promise<Map<string, { units: number; volume: number }>> {
    const rows = await this.db
      .select({
        deliveryId: schema.deliveryLines.deliveryId,
        units: sql<number>`COALESCE(SUM(${schema.deliveryLines.quantity}), 0)::int`,
        volume: sql<number>`COALESCE(SUM(${schema.deliveryLines.quantity} * COALESCE(${schema.productVariants.capacityUnits}, 1)), 0)::int`,
      })
      .from(schema.deliveryLines)
      .leftJoin(schema.orderLines, eq(schema.orderLines.id, schema.deliveryLines.orderLineId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(inArray(schema.deliveryLines.deliveryId, deliveryIds))
      .groupBy(schema.deliveryLines.deliveryId);
    return new Map(rows.map((r) => [r.deliveryId, { units: r.units, volume: r.volume }]));
  }

  private async paidByOrder(orderIds: string[]): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        orderId: schema.payments.orderId,
        paid: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
      })
      .from(schema.payments)
      .where(
        and(inArray(schema.payments.orderId, orderIds), eq(schema.payments.status, 'succeeded')),
      )
      .groupBy(schema.payments.orderId);
    return new Map(rows.map((r) => [r.orderId!, r.paid]));
  }
}

function contactFilter(contacts: string[]): SQL | undefined {
  if (contacts.length === 0) return undefined;
  const named = contacts.filter((c) => c !== 'none');
  const none = contacts.includes('none');
  if (named.length && none) {
    return or(
      inArray(schema.deliveries.contactStatus, named),
      isNull(schema.deliveries.contactStatus),
    );
  }
  if (named.length) return inArray(schema.deliveries.contactStatus, named);
  return isNull(schema.deliveries.contactStatus);
}

function totalsOf(rows: ScheduleRow[]): ScheduleTotals {
  return {
    stops: rows.length,
    units: rows.reduce((s, r) => s + r.units, 0),
    dollarsCents: rows.reduce((s, r) => s + r.dollarsCents, 0),
    volume: rows.reduce((s, r) => s + r.volume, 0),
  };
}
