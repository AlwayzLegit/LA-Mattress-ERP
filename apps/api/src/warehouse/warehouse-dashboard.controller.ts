import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

/** The picker's "everything" sentinel — also the default. */
const ALL = 'all';

interface InboundRow {
  id: string;
  number: string;
  vendorName: string | null;
  locationName: string | null;
  expectedAt: Date | null;
  orderedUnits: number;
  receivedUnits: number;
  overdue: boolean;
}

interface DockRow {
  id: string;
  number: string;
  vendorName: string | null;
  locationName: string | null;
  /** Received or inspected but not yet accepted/rejected. */
  unitsInProgress: number;
  lastActivityAt: Date;
}

interface PickupRow {
  orderId: string;
  number: string;
  customerName: string | null;
  locationName: string | null;
  ageDays: number;
  /** Every stock line reserved or fulfilled — stageable now. */
  ready: boolean;
}

interface ArrivedRow {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  locationName: string | null;
  description: string;
  quantity: number;
  arrivedAt: Date;
}

interface TransferRow {
  id: string;
  number: string;
  /** Relative to the selected scope; 'internal' when both ends are inside it. */
  direction: 'inbound' | 'outbound' | 'internal';
  fromName: string | null;
  toName: string | null;
  status: string;
  units: number;
  /** in_transit only: days since it shipped (last update). */
  days: number | null;
  awaitingTicket: boolean;
}

interface WarehouseSummary {
  date: string;
  /** id 'all' when the combined view is active (the default). */
  location: { id: string; name: string; timezone: string };
  locations: { id: string; name: string; locationType: string }[];
  inbound: InboundRow[];
  dock: DockRow[];
  pickups: PickupRow[];
  arrived: ArrivedRow[];
  transfers: { rows: TransferRow[]; closedShort30d: number };
  asIs: {
    count: number;
    costCents: number;
    oldestAt: Date | null;
    rows: {
      id: string;
      productName: string;
      locationName: string | null;
      quantity: number;
      condition: string | null;
      createdAt: Date;
    }[];
  };
  counts: {
    open: { id: string; countDate: string; status: string; locationName: string | null }[];
    lastPostedDate: string | null;
    negative: {
      variantId: string;
      productName: string;
      sku: string | null;
      locationName: string | null;
      onHand: number;
    }[];
  };
}

interface LoadoutRow {
  deliveryId: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  locationName: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  route: string | null;
  driverName: string | null;
  status: string;
  pieces: number;
  /** A serial-tracked line on the truck without its serials picked. */
  serialShort: boolean;
}

interface PicklistRow {
  variantId: string;
  locationId: string;
  locationName: string | null;
  productName: string;
  variantName: string | null;
  sku: string | null;
  bin: string | null;
  quantity: number;
  onHand: number;
  short: boolean;
  serialShort: boolean;
}

const LIVE_DELIVERY = ['scheduled', 'out', 'out_for_delivery'];

interface Scope {
  /** 'all' or a real location id. */
  id: string;
  name: string;
  /** One clock for "today": the lead (warehouse-type first) location's. */
  timezone: string;
  locationIds: string[];
  locations: { id: string; name: string; locationType: string; timezone: string }[];
}

/**
 * The Warehouse home (owner 2026-09-01, §12.2; amended 2026-09-01: the
 * combined all-locations view is the DEFAULT, with the per-location
 * picker still available). Every card takes a list of location ids —
 * one entry when a location is picked, all of them otherwise — so both
 * modes run the same queries.
 *
 * Split endpoints for the same reason the Operations home is split: the
 * summary is one bundle of small indexed reads, while the load-out and
 * pick-list join through delivery lines and fetch independently.
 */
@TenantScoped()
@Controller('v1/dashboard/warehouse')
export class WarehouseDashboardController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get()
  @RequirePermission('warehouse.dashboard.view')
  async summary(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
  ): Promise<WarehouseSummary> {
    const businessId = tenant.businessId!;
    const scope = await this.pickScope(tenant, businessId, locationId);
    const [dayRow] = await this.db
      .select({ today: sql<string>`(now() AT TIME ZONE ${scope.timezone})::date::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);

    const ids = scope.locationIds;
    const [inbound, dock, pickups, arrived, transfers, asIs, counts] = await Promise.all([
      this.inbound(businessId, ids),
      this.dock(businessId, ids),
      this.pickups(businessId, ids),
      this.arrived(businessId, ids),
      this.transfers(businessId, ids),
      this.asIs(businessId, ids),
      this.counts(businessId, ids),
    ]);

    return {
      date: dayRow!.today,
      location: { id: scope.id, name: scope.name, timezone: scope.timezone },
      locations: scope.locations.map((l) => ({
        id: l.id,
        name: l.name,
        locationType: l.locationType,
      })),
      inbound,
      dock,
      pickups,
      arrived,
      transfers,
      asIs,
      counts,
    };
  }

  /** Card 3 — today's truck: stops (vs cap in single-location mode), pieces, unpicked serials. */
  @Get('loadout')
  @RequirePermission('warehouse.dashboard.view')
  async loadout(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
    @Query('date') date?: string,
  ) {
    const businessId = tenant.businessId!;
    const scope = await this.pickScope(tenant, businessId, locationId);
    const day = parseDay(date) ?? (await this.localToday(businessId, scope.timezone, 0));
    const rows = await this.deliveryRows(businessId, scope.locationIds, day, LIVE_DELIVERY);

    // The daily stop cap is a per-location knob; against a combined view
    // a single cap would be a made-up number, so it stays null there.
    let cap: number | null = null;
    if (scope.id !== ALL) {
      const [biz] = await this.db
        .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1);
      const ops = (biz?.opsSettingsJson ?? {}) as { deliveryDailyCap?: number | null };
      cap = ops.deliveryDailyCap && ops.deliveryDailyCap > 0 ? ops.deliveryDailyCap : 15;
    }

    return {
      date: day,
      cap,
      stops: rows.length,
      pieces: rows.reduce((s, r) => s + r.pieces, 0),
      rows,
    };
  }

  /**
   * Card 4 — tomorrow's pull, aggregated per variant PER LOCATION (a
   * bin only means something inside its own building), so staging can
   * start this afternoon. `short` compares against on-hand: these units
   * are reserved to these orders, so reserved is not subtracted — the
   * question is whether the goods physically exist.
   */
  @Get('picklist')
  @RequirePermission('warehouse.dashboard.view')
  async picklist(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
    @Query('date') date?: string,
  ) {
    const businessId = tenant.businessId!;
    const scope = await this.pickScope(tenant, businessId, locationId);
    const day = parseDay(date) ?? (await this.localToday(businessId, scope.timezone, 1));
    const nameBy = new Map(scope.locations.map((l) => [l.id, l.name]));

    const lines = await this.db
      .select({
        variantId: schema.orderLines.variantId,
        locationId: schema.deliveries.locationId,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        serialTracked: schema.products.serialTracked,
        quantity: schema.deliveryLines.quantity,
        lineQuantity: schema.orderLines.quantity,
        serialUnitIds: schema.orderLines.serialUnitIds,
        lineType: schema.orderLines.lineType,
      })
      .from(schema.deliveryLines)
      .innerJoin(schema.deliveries, eq(schema.deliveries.id, schema.deliveryLines.deliveryId))
      .innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.deliveryLines.orderLineId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.deliveries.businessId, businessId),
          inArray(schema.deliveries.locationId, scope.locationIds),
          eq(schema.deliveries.scheduledDate, day),
          inArray(schema.deliveries.status, LIVE_DELIVERY),
        ),
      );

    const byKey = new Map<string, PicklistRow>();
    for (const l of lines) {
      if (!l.variantId || l.lineType !== 'stock') continue;
      const key = `${l.variantId}:${l.locationId}`;
      const row = byKey.get(key) ?? {
        variantId: l.variantId,
        locationId: l.locationId,
        locationName: nameBy.get(l.locationId) ?? null,
        productName: l.productName ?? '(deleted)',
        variantName: l.variantName,
        sku: l.sku,
        bin: null,
        quantity: 0,
        onHand: 0,
        short: false,
        serialShort: false,
      };
      row.quantity += l.quantity;
      if (l.serialTracked && (l.serialUnitIds?.length ?? 0) < l.lineQuantity) {
        row.serialShort = true;
      }
      byKey.set(key, row);
    }
    if (byKey.size > 0) {
      const levels = await this.db
        .select({
          variantId: schema.inventoryLevels.variantId,
          locationId: schema.inventoryLevels.locationId,
          onHand: schema.inventoryLevels.onHand,
          bin: schema.storageBins.code,
        })
        .from(schema.inventoryLevels)
        .leftJoin(
          schema.storageBins,
          eq(schema.storageBins.id, schema.inventoryLevels.storageBinId),
        )
        .where(
          and(
            eq(schema.inventoryLevels.businessId, businessId),
            inArray(schema.inventoryLevels.locationId, scope.locationIds),
            inArray(schema.inventoryLevels.variantId, [
              ...new Set([...byKey.values()].map((r) => r.variantId)),
            ]),
          ),
        );
      for (const level of levels) {
        const row = byKey.get(`${level.variantId}:${level.locationId}`);
        if (!row) continue;
        row.onHand = level.onHand;
        row.bin = level.bin;
      }
      for (const row of byKey.values()) row.short = row.onHand < row.quantity;
    }
    const rows = [...byKey.values()].sort(
      (a, b) =>
        (a.locationName ?? '').localeCompare(b.locationName ?? '') ||
        (a.bin ?? 'zzz').localeCompare(b.bin ?? 'zzz') ||
        a.productName.localeCompare(b.productName),
    );
    return { date: day, rows };
  }

  // ------------------------------------------------------------- internals

  /**
   * Resolve the picker value. Absent or 'all' → every location the
   * member may see, combined (the default); a real id → that one.
   * Warehouse-type locations lead both the ordering and the clock.
   */
  private async pickScope(
    tenant: RequestTenantContext,
    businessId: string,
    locationId?: string,
  ): Promise<Scope> {
    const rows = await this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        timezone: schema.locations.timezone,
        locationType: schema.locations.locationType,
      })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.businessId, businessId),
          eq(schema.locations.isActive, true),
          tenant.dataScope === 'store'
            ? inArray(schema.locations.id, tenant.scopeLocationIds ?? [])
            : undefined,
        ),
      )
      .orderBy(schema.locations.name);
    const ordered = [
      ...rows.filter((r) => r.locationType === 'warehouse'),
      ...rows.filter((r) => r.locationType !== 'warehouse'),
    ];
    if (ordered.length === 0) {
      throw new BadRequestException('No locations are available to this member');
    }
    if (!locationId || locationId === ALL) {
      return {
        id: ALL,
        name: 'All locations',
        timezone: ordered[0]!.timezone,
        locationIds: ordered.map((l) => l.id),
        locations: ordered,
      };
    }
    const loc = ordered.find((l) => l.id === locationId);
    if (!loc) throw new ForbiddenException('You are not approved for that location');
    return {
      id: loc.id,
      name: loc.name,
      timezone: loc.timezone,
      locationIds: [loc.id],
      locations: ordered,
    };
  }

  private async localToday(businessId: string, tz: string, plusDays: number): Promise<string> {
    const [row] = await this.db
      .select({ day: sql<string>`((now() AT TIME ZONE ${tz})::date + ${plusDays}::int)::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return row!.day;
  }

  /** Card 1 — open POs shipping into the scope: due, overdue, progress. */
  private async inbound(businessId: string, locationIds: string[]): Promise<InboundRow[]> {
    const rows = await this.db
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        vendorName: schema.vendors.name,
        locationName: schema.locations.name,
        expectedAt: schema.purchaseOrders.expectedAt,
        orderedUnits: sql<number>`COALESCE(SUM(${schema.purchaseOrderLines.quantityOrdered}), 0)::int`,
        receivedUnits: sql<number>`COALESCE(SUM(${schema.purchaseOrderLines.quantityReceived}), 0)::int`,
      })
      .from(schema.purchaseOrders)
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.purchaseOrders.locationId))
      .leftJoin(
        schema.purchaseOrderLines,
        eq(schema.purchaseOrderLines.purchaseOrderId, schema.purchaseOrders.id),
      )
      .where(
        and(
          eq(schema.purchaseOrders.businessId, businessId),
          inArray(schema.purchaseOrders.locationId, locationIds),
          inArray(schema.purchaseOrders.status, ['ordered', 'partially_received']),
          isNull(schema.purchaseOrders.deletedAt),
        ),
      )
      .groupBy(
        schema.purchaseOrders.id,
        schema.purchaseOrders.number,
        schema.vendors.name,
        schema.locations.name,
        schema.purchaseOrders.expectedAt,
      )
      .orderBy(sql`${schema.purchaseOrders.expectedAt} ASC NULLS LAST`)
      .limit(50);
    const now = Date.now();
    return rows
      .map((r) => ({ ...r, overdue: r.expectedAt != null && r.expectedAt.getTime() < now }))
      .sort((a, b) => Number(b.overdue) - Number(a.overdue));
  }

  /**
   * Card 2 — goods physically in a building but not yet sellable:
   * received or inspected units that nobody has accepted or rejected.
   * The most expensive invisible state a warehouse has.
   */
  private async dock(businessId: string, locationIds: string[]): Promise<DockRow[]> {
    const rows = await this.db
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        vendorName: schema.vendors.name,
        locationName: schema.locations.name,
        unitsInProgress: sql<number>`COALESCE(SUM(GREATEST(${schema.purchaseOrderLines.quantityReceived} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected}, 0)), 0)::int`,
        lastActivityAt: schema.purchaseOrders.updatedAt,
      })
      .from(schema.purchaseOrders)
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.purchaseOrders.locationId))
      .innerJoin(
        schema.purchaseOrderLines,
        eq(schema.purchaseOrderLines.purchaseOrderId, schema.purchaseOrders.id),
      )
      .where(
        and(
          eq(schema.purchaseOrders.businessId, businessId),
          inArray(schema.purchaseOrders.locationId, locationIds),
          isNull(schema.purchaseOrders.deletedAt),
          sql`${schema.purchaseOrders.status} NOT IN ('canceled')`,
        ),
      )
      .groupBy(
        schema.purchaseOrders.id,
        schema.purchaseOrders.number,
        schema.vendors.name,
        schema.locations.name,
        schema.purchaseOrders.updatedAt,
      )
      .having(
        sql`SUM(GREATEST(${schema.purchaseOrderLines.quantityReceived} - ${schema.purchaseOrderLines.quantityAccepted} - ${schema.purchaseOrderLines.quantityRejected}, 0)) > 0`,
      )
      .orderBy(asc(schema.purchaseOrders.updatedAt));
    return rows;
  }

  /** Card 5 — pickup orders staged (or stageable) and how long waiting. */
  private async pickups(businessId: string, locationIds: string[]): Promise<PickupRow[]> {
    const pickupLoc = sql`COALESCE(${schema.orders.pickupLocationId}, ${schema.orders.locationId})`;
    const orders = await this.db
      .select({
        orderId: schema.orders.id,
        number: schema.orders.number,
        createdAt: schema.orders.createdAt,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        locationName: schema.locations.name,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(schema.locations, sql`${schema.locations.id} = ${pickupLoc}`)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          inArray(schema.orders.fulfillmentType, ['pickup', 'will_call']),
          inArray(schema.orders.status, ['open', 'partially_fulfilled']),
          isNull(schema.orders.importedAt),
          sql`${pickupLoc} IN (${sql.join(
            locationIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ),
      )
      .orderBy(asc(schema.orders.createdAt))
      .limit(50);
    if (orders.length === 0) return [];

    const lines = await this.db
      .select({
        orderId: schema.orderLines.orderId,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
        lineType: schema.orderLines.lineType,
      })
      .from(schema.orderLines)
      .where(
        inArray(
          schema.orderLines.orderId,
          orders.map((o) => o.orderId),
        ),
      );
    const readyBy = new Map<string, boolean>();
    for (const o of orders) readyBy.set(o.orderId, true);
    for (const l of lines) {
      if (l.lineType !== 'stock') continue;
      if (l.qtyReserved + l.qtyFulfilled < l.quantity) readyBy.set(l.orderId, false);
    }
    const now = Date.now();
    return orders.map((o) => ({
      orderId: o.orderId,
      number: o.number,
      customerName: [o.customerFirst, o.customerLast].filter(Boolean).join(' ') || null,
      locationName: o.locationName,
      ageDays: Math.floor((now - o.createdAt.getTime()) / 86_400_000),
      ready: readyBy.get(o.orderId) ?? false,
    }));
  }

  /**
   * Card 6 — the customer's special order ARRIVED and nobody booked the
   * next step: allocation received, line unfulfilled, and no live
   * delivery on the order. The highest-value queue on the page.
   */
  private async arrived(businessId: string, locationIds: string[]): Promise<ArrivedRow[]> {
    const rows = await this.db
      .select({
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        locationName: schema.locations.name,
        description: schema.orderLines.description,
        quantity: schema.poLineAllocations.quantity,
        arrivedAt: schema.poLineAllocations.updatedAt,
      })
      .from(schema.poLineAllocations)
      .innerJoin(
        schema.purchaseOrderLines,
        eq(schema.purchaseOrderLines.id, schema.poLineAllocations.poLineId),
      )
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
      )
      .innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.poLineAllocations.orderLineId))
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.purchaseOrders.locationId))
      .where(
        and(
          eq(schema.poLineAllocations.businessId, businessId),
          eq(schema.poLineAllocations.status, 'received'),
          inArray(schema.purchaseOrders.locationId, locationIds),
          inArray(schema.orders.status, ['open', 'partially_fulfilled']),
          sql`${schema.orderLines.qtyFulfilled} < ${schema.orderLines.quantity}`,
          sql`NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = ${schema.orders.id} AND d.status IN ('scheduled', 'out', 'out_for_delivery'))`,
        ),
      )
      .orderBy(asc(schema.poLineAllocations.updatedAt))
      .limit(50);
    return rows.map((r) => ({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      customerName: [r.customerFirst, r.customerLast].filter(Boolean).join(' ') || null,
      locationName: r.locationName,
      description: r.description,
      quantity: r.quantity,
      arrivedAt: r.arrivedAt,
    }));
  }

  /** Card 7 — transfers touching the scope, and where they stand. */
  private async transfers(
    businessId: string,
    locationIds: string[],
  ): Promise<{ rows: TransferRow[]; closedShort30d: number }> {
    const idSet = new Set(locationIds);
    const fromLoc = alias(schema.locations, 'from_loc');
    const toLoc = alias(schema.locations, 'to_loc');
    const touching = or(
      inArray(schema.stockTransfers.fromLocationId, locationIds),
      inArray(schema.stockTransfers.toLocationId, locationIds),
    );
    const rows = await this.db
      .select({
        id: schema.stockTransfers.id,
        number: schema.stockTransfers.number,
        status: schema.stockTransfers.status,
        fromLocationId: schema.stockTransfers.fromLocationId,
        toLocationId: schema.stockTransfers.toLocationId,
        fromName: fromLoc.name,
        toName: toLoc.name,
        ticketPrintedAt: schema.stockTransfers.ticketPrintedAt,
        updatedAt: schema.stockTransfers.updatedAt,
        units: sql<number>`COALESCE(SUM(${schema.stockTransferLines.quantityShipped}), 0)::int`,
      })
      .from(schema.stockTransfers)
      .leftJoin(fromLoc, eq(fromLoc.id, schema.stockTransfers.fromLocationId))
      .leftJoin(toLoc, eq(toLoc.id, schema.stockTransfers.toLocationId))
      .leftJoin(
        schema.stockTransferLines,
        eq(schema.stockTransferLines.transferId, schema.stockTransfers.id),
      )
      .where(
        and(
          eq(schema.stockTransfers.businessId, businessId),
          inArray(schema.stockTransfers.status, ['draft', 'in_transit']),
          touching,
        ),
      )
      .groupBy(
        schema.stockTransfers.id,
        schema.stockTransfers.number,
        schema.stockTransfers.status,
        schema.stockTransfers.fromLocationId,
        schema.stockTransfers.toLocationId,
        fromLoc.name,
        toLoc.name,
        schema.stockTransfers.ticketPrintedAt,
        schema.stockTransfers.updatedAt,
      )
      .orderBy(asc(schema.stockTransfers.updatedAt))
      .limit(50);

    const now = Date.now();
    const mapped: TransferRow[] = rows.map((r) => {
      const fromIn = idSet.has(r.fromLocationId);
      const toIn = idSet.has(r.toLocationId);
      return {
        id: r.id,
        number: r.number,
        direction: fromIn && toIn ? 'internal' : fromIn ? 'outbound' : 'inbound',
        fromName: r.fromName,
        toName: r.toName,
        status: r.status,
        units: r.units,
        days:
          r.status === 'in_transit' ? Math.floor((now - r.updatedAt.getTime()) / 86_400_000) : null,
        awaitingTicket: r.status === 'draft' && r.ticketPrintedAt == null,
      };
    });

    const [shortCount] = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(schema.stockTransfers)
      .where(
        and(
          eq(schema.stockTransfers.businessId, businessId),
          eq(schema.stockTransfers.status, 'closed_short'),
          gte(schema.stockTransfers.updatedAt, new Date(now - 30 * 86_400_000)),
          touching,
        ),
      );
    return { rows: mapped, closedShort30d: shortCount?.count ?? 0 };
  }

  /** Card 8 — damage waiting for a decision is silent shrink. */
  private async asIs(businessId: string, locationIds: string[]) {
    const rows = await this.db
      .select({
        id: schema.asIsItems.id,
        quantity: schema.asIsItems.quantity,
        condition: schema.asIsItems.condition,
        createdAt: schema.asIsItems.createdAt,
        productName: schema.products.name,
        locationName: schema.locations.name,
        costCents: schema.productVariants.costCents,
      })
      .from(schema.asIsItems)
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.asIsItems.variantId))
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.asIsItems.locationId))
      .where(
        and(
          eq(schema.asIsItems.businessId, businessId),
          inArray(schema.asIsItems.locationId, locationIds),
          eq(schema.asIsItems.status, 'pending_review'),
        ),
      )
      .orderBy(asc(schema.asIsItems.createdAt))
      .limit(50);
    return {
      count: rows.reduce((s, r) => s + r.quantity, 0),
      costCents: rows.reduce((s, r) => s + r.quantity * (r.costCents ?? 0), 0),
      oldestAt: rows[0]?.createdAt ?? null,
      rows: rows.slice(0, 10).map((r) => ({
        id: r.id,
        productName: r.productName ?? '(deleted)',
        locationName: r.locationName,
        quantity: r.quantity,
        condition: r.condition,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Card 9 — count discipline + the ledger breaks only a count fixes. */
  private async counts(businessId: string, locationIds: string[]) {
    const open = await this.db
      .select({
        id: schema.physicalCounts.id,
        countDate: schema.physicalCounts.countDate,
        status: schema.physicalCounts.status,
        locationName: schema.locations.name,
      })
      .from(schema.physicalCounts)
      .leftJoin(schema.locations, eq(schema.locations.id, schema.physicalCounts.locationId))
      .where(
        and(
          eq(schema.physicalCounts.businessId, businessId),
          inArray(schema.physicalCounts.locationId, locationIds),
          inArray(schema.physicalCounts.status, ['open', 'counting']),
        ),
      )
      .orderBy(asc(schema.physicalCounts.countDate));

    const [last] = await this.db
      .select({ countDate: schema.physicalCounts.countDate })
      .from(schema.physicalCounts)
      .where(
        and(
          eq(schema.physicalCounts.businessId, businessId),
          inArray(schema.physicalCounts.locationId, locationIds),
          eq(schema.physicalCounts.status, 'posted'),
        ),
      )
      .orderBy(sql`${schema.physicalCounts.countDate} DESC`)
      .limit(1);

    const negative = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        onHand: schema.inventoryLevels.onHand,
        productName: schema.products.name,
        sku: schema.productVariants.sku,
        locationName: schema.locations.name,
      })
      .from(schema.inventoryLevels)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.inventoryLevels.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
      .where(
        and(
          eq(schema.inventoryLevels.businessId, businessId),
          inArray(schema.inventoryLevels.locationId, locationIds),
          lt(schema.inventoryLevels.onHand, 0),
        ),
      )
      .limit(20);

    return {
      open,
      lastPostedDate: last?.countDate ?? null,
      negative: negative.map((n) => ({
        variantId: n.variantId,
        productName: n.productName ?? '(deleted)',
        sku: n.sku,
        locationName: n.locationName,
        onHand: n.onHand,
      })),
    };
  }

  /** Shared by loadout: one row per delivery with pieces + serial state. */
  private async deliveryRows(
    businessId: string,
    locationIds: string[],
    day: string,
    statuses: string[],
  ): Promise<LoadoutRow[]> {
    const driverUser = alias(schema.users, 'driver_user');
    const deliveryLoc = alias(schema.locations, 'delivery_loc');
    const rows = await this.db
      .select({
        deliveryId: schema.deliveries.id,
        orderId: schema.deliveries.orderId,
        orderNumber: schema.orders.number,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        locationName: deliveryLoc.name,
        windowStart: schema.deliveries.windowStart,
        windowEnd: schema.deliveries.windowEnd,
        route: schema.deliveries.route,
        driverName: driverUser.name,
        status: schema.deliveries.status,
        pieces: sql<number>`COALESCE(SUM(${schema.deliveryLines.quantity}), 0)::int`,
        serialShort: sql<boolean>`BOOL_OR(${schema.products.serialTracked} AND COALESCE(array_length(${schema.orderLines.serialUnitIds}, 1), 0) < ${schema.orderLines.quantity})`,
      })
      .from(schema.deliveries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(deliveryLoc, eq(deliveryLoc.id, schema.deliveries.locationId))
      .leftJoin(schema.memberships, eq(schema.memberships.id, schema.deliveries.driverMembershipId))
      .leftJoin(driverUser, eq(driverUser.id, schema.memberships.userId))
      .leftJoin(schema.deliveryLines, eq(schema.deliveryLines.deliveryId, schema.deliveries.id))
      .leftJoin(schema.orderLines, eq(schema.orderLines.id, schema.deliveryLines.orderLineId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.deliveries.businessId, businessId),
          inArray(schema.deliveries.locationId, locationIds),
          eq(schema.deliveries.scheduledDate, day),
          inArray(schema.deliveries.status, statuses),
        ),
      )
      .groupBy(
        schema.deliveries.id,
        schema.deliveries.orderId,
        schema.orders.number,
        schema.customers.firstName,
        schema.customers.lastName,
        deliveryLoc.name,
        schema.deliveries.windowStart,
        schema.deliveries.windowEnd,
        schema.deliveries.route,
        driverUser.name,
        schema.deliveries.status,
        schema.deliveries.routePosition,
      )
      .orderBy(sql`${schema.deliveries.routePosition} ASC NULLS LAST`);
    return rows.map((r) => ({
      deliveryId: r.deliveryId,
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      customerName: [r.customerFirst, r.customerLast].filter(Boolean).join(' ') || null,
      locationName: r.locationName,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      route: r.route,
      driverName: r.driverName,
      status: r.status,
      pieces: r.pieces,
      serialShort: r.serialShort ?? false,
    }));
  }
}

/** YYYY-MM-DD or nothing — anything else is a caller bug. */
function parseDay(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadRequestException('date must be YYYY-MM-DD');
  }
  return raw;
}
