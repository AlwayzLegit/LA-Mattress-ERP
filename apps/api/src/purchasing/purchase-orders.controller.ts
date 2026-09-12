import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
} from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { checkPoDeletable, checkPoRestorable } from './po-delete-guard';
import { computeReorderSuggestions } from './replenishment';
import { CostingService } from '../costing/costing.service';
import { ExceptionsService } from '../controls/exceptions.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { EmailService } from '../email/email.service';
import { OrdersService } from '../orders/orders.service';
import { SpecialOrdersService } from '../special-orders/special-orders.service';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import {
  cuttingDateMessage,
  defaultFreightCents,
  loadLandedCost,
  pastCuttingDate,
  todayIso,
} from './vendor-settings';
import type { RequestTenantContext } from '../tenancy/request-context';

interface PoLineInput {
  variantId?: string;
  quantity?: number;
  unitCostCents?: number;
  /**
   * §6: when this line buys stock for a specific customer order line
   * (the builder's "sold-not-in-stock" pre-load), the allocation is
   * written so the sales order # rides on the PO and receipt commits
   * the units to that customer.
   */
  orderLineId?: string;
}

interface CreatePoBody {
  vendorId?: string;
  locationId?: string;
  expectedAt?: string;
  /** Landed cost lean (Q1): whole-PO freight, spread per unit at receipt. */
  freightCents?: number | null;
  notes?: string | null;
  lines?: PoLineInput[];
  /**
   * Whether to mark the PO as `ordered` immediately (instead of leaving
   * it as a `draft` for later edits). Defaults to true — most users
   * create + place in one step.
   */
  place?: boolean;
}

interface ReceivePoBody {
  notes?: string | null;
  lines?: { lineId?: string; quantity?: number }[];
}

/**
 * PO corrections (FAQ pack D-group): edit an un-closed PO in place.
 * A line entry either updates an existing line (`lineId`), removes it
 * (`lineId` + `remove`), or adds a new one (`variantId`). Quantities can
 * never drop below what has already been received.
 */
interface UpdatePoBody {
  expectedAt?: string | null;
  /** Q1: editable only while nothing has been received. */
  freightCents?: number | null;
  notes?: string | null;
  lines?: {
    lineId?: string;
    variantId?: string;
    quantity?: number;
    unitCostCents?: number;
    remove?: boolean;
  }[];
}

/** Un-receive: back accepted units out of stock and off the PO counters. */
interface UnreceivePoBody {
  notes?: string | null;
  lines?: { lineId?: string; quantity?: number }[];
}

/**
 * Staged receiving (§6): each entry is an *increment* to one or more
 * stages of one line. Invariant per line at all times:
 *   ordered ≥ received ≥ inspected ≥ accepted.
 */
interface ReceiveStagesBody {
  notes?: string | null;
  lines?: {
    lineId?: string;
    received?: number;
    inspected?: number;
    accepted?: number;
    /** G11 third bucket: inspected units that failed — go to As-Is review. */
    rejected?: number;
  }[];
}

interface PoListRow {
  id: string;
  number: string;
  status: string;
  vendorId: string;
  vendorName: string | null;
  locationId: string;
  expectedAt: Date | null;
  placedAt: Date | null;
  closedAt: Date | null;
  subtotalCents: number;
  /** Q1 landed cost lean: whole-PO freight loaded into layer cost. */
  freightCents: number | null;
  createdAt: Date;
  /** A22 slice 7: batch print picks direct ships in or out and not-yet-printed POs. */
  directShip: boolean;
  printCount: number;
  /** Set on a soft-deleted draft; null on every live PO. */
  deletedAt: Date | null;
  deletedByEmail: string | null;
}

interface PoLineRow {
  id: string;
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  /** Vendor's part number when it differs from our sku (null = same). */
  vendorSku: string | null;
  quantityOrdered: number;
  quantityReceived: number;
  quantityInspected: number;
  quantityAccepted: number;
  quantityRejected: number;
  unitCostCents: number;
  lineTotalCents: number;
  /** §6: units on this line bought for specific customer orders. */
  linkedOrders: { orderId: string; orderNumber: string; quantity: number }[];
}

interface PoDetail extends PoListRow {
  notes: string | null;
  createdByUserId: string | null;
  /** Ship-to + vendor contact block for the printable vendor document. */
  locationName: string | null;
  locationAddressJson: unknown;
  vendorContactName: string | null;
  vendorEmail: string | null;
  vendorPhone: string | null;
  /** Letterhead for the printed / emailed document. */
  businessName: string | null;
  businessLogoUrl: string | null;
  /** G11: ops.blindReceiving — the receiving grid hides expected qtys. */
  blindReceiving: boolean;
  /** PO-060: vendor ships straight to the customer (shipToJson block). */
  directShip: boolean;
  shipToJson: unknown;
  /** A22 slice 7: print tracking — a second print is a reprint. */
  printCount: number;
  lastPrintedAt: Date | null;
  lines: PoLineRow[];
}

/** A receipt's answer (redesign Phase 7): the PO after posting plus the orders it unblocked. */
interface PoReceiveResult extends PoDetail {
  unblockedOrders: { orderId: string; number: string; units: number }[];
}

@TenantScoped()
@Controller('v1/purchase-orders')
export class PurchaseOrdersController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
    @Inject(SpecialOrdersService) private readonly specialOrders: SpecialOrdersService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(CostingService) private readonly costing: CostingService,
  ) {}

  /**
   * `includeDeleted=1` brings soft-deleted drafts back into the list
   * (the "Show deleted" filter); by default they are hidden, which is
   * the whole point of deleting one.
   */
  @Get()
  @RequirePermission('purchase_orders.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('status') status?: string,
    @Query('vendorId') vendorId?: string,
    @Query('includeDeleted') includeDeleted?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
    @Query('locationId') locationId?: string,
    @Query('directShip') directShip?: string,
    @Query('printed') printed?: string,
    @Query('number') number?: string,
  ): Promise<PageResponse<PoListRow>> {
    const limit = clampLimit(limitStr);
    const deleter = alias(schema.users, 'po_deleter');
    const conditions: SQL[] = [];
    if (status) conditions.push(eq(schema.purchaseOrders.status, status));
    if (vendorId) conditions.push(eq(schema.purchaseOrders.vendorId, vendorId));
    // A22 slice 7 (batch print): receiving location, direct ships in or
    // out, printed / not yet printed, and a PO number to pick one.
    if (locationId) conditions.push(eq(schema.purchaseOrders.locationId, locationId));
    if (directShip === '0') conditions.push(eq(schema.purchaseOrders.directShip, false));
    if (directShip === '1') conditions.push(eq(schema.purchaseOrders.directShip, true));
    if (printed === '0') conditions.push(eq(schema.purchaseOrders.printCount, 0));
    if (printed === '1') conditions.push(gt(schema.purchaseOrders.printCount, 0));
    if (number?.trim()) {
      conditions.push(sql`${schema.purchaseOrders.number} ILIKE ${`%${number.trim()}%`}`);
    }
    if (includeDeleted !== '1') conditions.push(isNull(schema.purchaseOrders.deletedAt));
    const cursor = decodeCursor(cursorStr);
    if (cursor) {
      conditions.push(
        timestampCursorWhere(schema.purchaseOrders.createdAt, schema.purchaseOrders.id, cursor)!,
      );
    }
    const rows = await this.db
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        status: schema.purchaseOrders.status,
        vendorId: schema.purchaseOrders.vendorId,
        vendorName: schema.vendors.name,
        locationId: schema.purchaseOrders.locationId,
        expectedAt: schema.purchaseOrders.expectedAt,
        placedAt: schema.purchaseOrders.placedAt,
        closedAt: schema.purchaseOrders.closedAt,
        subtotalCents: schema.purchaseOrders.subtotalCents,
        freightCents: schema.purchaseOrders.freightCents,
        createdAt: schema.purchaseOrders.createdAt,
        directShip: schema.purchaseOrders.directShip,
        printCount: schema.purchaseOrders.printCount,
        deletedAt: schema.purchaseOrders.deletedAt,
        deletedByEmail: deleter.email,
      })
      .from(schema.purchaseOrders)
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
      .leftJoin(deleter, eq(deleter.id, schema.purchaseOrders.deletedByUserId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(...timestampCursorOrder(schema.purchaseOrders.createdAt, schema.purchaseOrders.id))
      .limit(limit + 1);
    return buildPage(rows, limit, (r) => r.createdAt);
  }

  /**
   * Reorder suggestions: every managed variant (non-null reorder_point)
   * whose available stock — on-hand minus reserved, summed across all
   * locations — is at or below its point, grouped by preferred vendor
   * so each group can become one PO. Suggested quantity is the variant's
   * reorder_qty when set, else a top-up to 2× the point (min/max).
   * Declared before the ':id' route so the static path wins.
   */
  @Get('reorder-suggestions')
  @RequirePermission('purchase_orders.view')
  async reorderSuggestions(@CurrentTenant() _tenant: RequestTenantContext): Promise<{
    vendors: {
      vendorId: string | null;
      vendorName: string | null;
      lines: {
        variantId: string;
        productName: string;
        variantName: string | null;
        sku: string | null;
        vendorSku: string | null;
        available: number;
        reorderPoint: number;
        suggestedQty: number;
        unitCostCents: number | null;
      }[];
    }[];
  }> {
    const vendors = (await computeReorderSuggestions(this.db)) as Awaited<
      ReturnType<PurchaseOrdersController['reorderSuggestions']>
    >['vendors'];
    return { vendors };
  }

  /**
   * A22 slice 7 (STORIS Print a Purchase Order): record a print of the
   * vendor document — the count says whether this is a reprint, and
   * the batch screen filters on it.
   */
  @Post(':id/print')
  @RequirePermission('purchase_orders.view')
  async recordPrint(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ printCount: number; lastPrintedAt: Date; reprint: boolean }> {
    const [po] = await this.db
      .select({ id: schema.purchaseOrders.id, printCount: schema.purchaseOrders.printCount })
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');
    const now = new Date();
    const next = po.printCount + 1;
    await this.db
      .update(schema.purchaseOrders)
      .set({ printCount: next, lastPrintedAt: now, updatedAt: now })
      .where(eq(schema.purchaseOrders.id, id));
    await this.audit.log({
      action: 'purchase_order.print',
      targetType: 'purchase_order',
      targetId: id,
      after: { printCount: next, reprint: po.printCount > 0 },
    });
    return { printCount: next, lastPrintedAt: now, reprint: po.printCount > 0 };
  }

  @Get(':id')
  @RequirePermission('purchase_orders.view')
  async get(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<PoDetail> {
    return this.hydrate(id);
  }

  @Post()
  @RequirePermission('purchase_orders.create')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: CreatePoBody,
  ): Promise<PoDetail> {
    if (!body.vendorId) throw new BadRequestException('vendorId is required');
    if (!body.locationId) throw new BadRequestException('locationId is required');
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must contain at least one entry');
    }

    // Validate vendor + location belong to this business (RLS would
    // also catch it; explicit lookups give a friendly 404).
    const [vendor] = await this.db
      .select({ id: schema.vendors.id })
      .from(schema.vendors)
      .where(eq(schema.vendors.id, body.vendorId))
      .limit(1);
    if (!vendor) throw new NotFoundException('Vendor not found');
    const [location] = await this.db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(eq(schema.locations.id, body.locationId))
      .limit(1);
    if (!location) throw new NotFoundException('Location not found');

    // Validate every variant + collect descriptions for audit / response.
    const variantIds: string[] = [];
    for (const l of body.lines) {
      if (!l.variantId) throw new BadRequestException('lines[].variantId is required');
      if (!Number.isInteger(l.quantity) || (l.quantity ?? 0) <= 0) {
        throw new BadRequestException('lines[].quantity must be a positive integer');
      }
      if (!Number.isInteger(l.unitCostCents) || (l.unitCostCents ?? -1) < 0) {
        throw new BadRequestException('lines[].unitCostCents must be a non-negative integer');
      }
      variantIds.push(l.variantId);
    }
    const variants = await this.db
      .select({
        id: schema.productVariants.id,
      })
      .from(schema.productVariants)
      .where(inArray(schema.productVariants.id, variantIds));
    if (variants.length !== new Set(variantIds).size) {
      throw new NotFoundException('One or more variants not found');
    }

    if (
      body.freightCents != null &&
      (!Number.isInteger(body.freightCents) || body.freightCents < 0)
    ) {
      throw new BadRequestException('freightCents must be a non-negative integer or null');
    }

    const subtotalCents = body.lines.reduce((s, l) => s + l.quantity! * l.unitCostCents!, 0);
    // Advanced Vendor Settings (owner 2026-09-02): a collection past its PO
    // cutting date cannot be ordered; active landed-cost lines default the
    // freight when the caller leaves it out.
    const cut = await pastCuttingDate(this.db, body.vendorId, variantIds, todayIso());
    if (cut.length > 0) throw new BadRequestException(cuttingDateMessage(cut));
    const freightCents =
      body.freightCents === undefined
        ? defaultFreightCents(await loadLandedCost(this.db, body.vendorId), subtotalCents)
        : body.freightCents;
    const number = await this.generatePoNumber(tenant.businessId!);
    const place = body.place !== false;
    const expectedAt = parseDate(body.expectedAt);

    const [po] = await this.db
      .insert(schema.purchaseOrders)
      .values({
        businessId: tenant.businessId!,
        vendorId: body.vendorId,
        locationId: body.locationId,
        number,
        status: place ? 'ordered' : 'draft',
        expectedAt,
        placedAt: place ? new Date() : null,
        subtotalCents,
        freightCents: freightCents ?? null,
        notes: body.notes ?? null,
        createdByUserId: actor.id,
      })
      .returning();
    if (!po) throw new BadRequestException('failed to create purchase order');

    for (const l of body.lines) {
      const [poLine] = await this.db
        .insert(schema.purchaseOrderLines)
        .values({
          businessId: tenant.businessId!,
          purchaseOrderId: po.id,
          variantId: l.variantId!,
          quantityOrdered: l.quantity!,
          unitCostCents: l.unitCostCents!,
          lineTotalCents: l.quantity! * l.unitCostCents!,
        })
        .returning();
      if (l.orderLineId && poLine) {
        const [orderLine] = await this.db
          .select({
            id: schema.orderLines.id,
            variantId: schema.orderLines.variantId,
            quantity: schema.orderLines.quantity,
          })
          .from(schema.orderLines)
          .where(eq(schema.orderLines.id, l.orderLineId))
          .limit(1);
        if (!orderLine) throw new NotFoundException(`Order line not found: ${l.orderLineId}`);
        if (orderLine.variantId !== l.variantId) {
          throw new BadRequestException(
            'lines[].orderLineId must reference an order line for the same variant',
          );
        }
        await this.db.insert(schema.poLineAllocations).values({
          businessId: tenant.businessId!,
          poLineId: poLine.id,
          orderLineId: orderLine.id,
          quantity: Math.min(l.quantity!, orderLine.quantity),
          status: 'ordered',
        });
      }
    }

    await this.audit.log({
      action: 'purchase_order.create',
      targetType: 'purchase_order',
      targetId: po.id,
      after: {
        number: po.number,
        vendorId: body.vendorId,
        status: po.status,
        subtotalCents,
        lineCount: body.lines.length,
      },
    });
    return this.hydrate(po.id);
  }

  /**
   * Place a draft. Before this endpoint a draft PO was a dead end —
   * it could not be emailed, received against, or placed, only canceled.
   */
  @Post(':id/place')
  @RequirePermission('purchase_orders.create')
  async place(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<PoDetail> {
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');
    // A deleted draft still carries status 'draft', so the status check
    // alone would let it be placed — turning an invisible, unrestorable
    // row into a real vendor commitment. Restore it first.
    if (po.deletedAt) {
      throw new ConflictException({
        message: 'This purchase order is deleted. Restore it before placing it.',
        code: 'ALREADY_DELETED',
      });
    }
    if (po.status !== 'draft') {
      throw new ForbiddenException(`Cannot place a ${po.status} purchase order`);
    }
    const placingLines = await this.db
      .select({ variantId: schema.purchaseOrderLines.variantId })
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const cut = await pastCuttingDate(
      this.db,
      po.vendorId,
      placingLines.map((l) => l.variantId),
      todayIso(),
    );
    if (cut.length > 0) throw new BadRequestException(cuttingDateMessage(cut));
    await this.db
      .update(schema.purchaseOrders)
      .set({ status: 'ordered', placedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.purchaseOrders.id, id));
    await this.audit.log({
      action: 'purchase_order.place',
      targetType: 'purchase_order',
      targetId: id,
      before: { status: 'draft' },
      after: { status: 'ordered' },
    });
    return this.hydrate(id);
  }

  /**
   * Edit an un-closed PO: expected date, notes, line quantities/costs,
   * remove untouched lines, add forgotten ones. Received / canceled POs
   * are immutable — corrections after receipt go through `unreceive`.
   * Guards: a quantity can never drop below what is already received or
   * below the units committed to sales orders, and only a line with no
   * receipts and no order linkage can be removed.
   */
  @Patch(':id')
  @RequirePermission('purchase_orders.create')
  async update(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: UpdatePoBody,
  ): Promise<PoDetail> {
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.deletedAt) {
      throw new ConflictException({
        message: 'This purchase order is deleted. Restore it before editing it.',
        code: 'ALREADY_DELETED',
      });
    }
    if (po.status !== 'draft' && po.status !== 'ordered' && po.status !== 'partially_received') {
      throw new ForbiddenException(`Cannot edit a ${po.status} purchase order`);
    }

    const lines = await this.db
      .select()
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const byId = new Map(lines.map((l) => [l.id, l]));
    const lineIds = lines.map((l) => l.id);
    const allocations = lineIds.length
      ? await this.db
          .select({
            poLineId: schema.poLineAllocations.poLineId,
            quantity: schema.poLineAllocations.quantity,
          })
          .from(schema.poLineAllocations)
          .where(inArray(schema.poLineAllocations.poLineId, lineIds))
      : [];
    const allocatedByLine = new Map<string, number>();
    for (const a of allocations) {
      allocatedByLine.set(a.poLineId, (allocatedByLine.get(a.poLineId) ?? 0) + a.quantity);
    }

    // Validate the whole edit before touching anything.
    const updates: { line: (typeof lines)[number]; quantity: number; unitCostCents: number }[] = [];
    const removals: (typeof lines)[number][] = [];
    const additions: { variantId: string; quantity: number; unitCostCents: number }[] = [];
    const seen = new Set<string>();
    for (const e of body.lines ?? []) {
      if (e.lineId) {
        if (seen.has(e.lineId)) {
          throw new BadRequestException(`Duplicate lineId in request: ${e.lineId}`);
        }
        seen.add(e.lineId);
        const line = byId.get(e.lineId);
        if (!line) throw new NotFoundException(`PO line not found: ${e.lineId}`);
        const allocated = allocatedByLine.get(line.id) ?? 0;
        if (e.remove) {
          if (line.quantityReceived > 0) {
            throw new BadRequestException(
              `Cannot remove a line with ${line.quantityReceived} unit(s) already received — un-receive them first`,
            );
          }
          if (allocated > 0) {
            throw new BadRequestException(
              'Cannot remove a line committed to sales orders — unlink the special order first',
            );
          }
          removals.push(line);
          continue;
        }
        const quantity = e.quantity ?? line.quantityOrdered;
        const unitCostCents = e.unitCostCents ?? line.unitCostCents;
        if (!Number.isInteger(quantity) || quantity <= 0) {
          throw new BadRequestException('lines[].quantity must be a positive integer');
        }
        if (!Number.isInteger(unitCostCents) || unitCostCents < 0) {
          throw new BadRequestException('lines[].unitCostCents must be a non-negative integer');
        }
        if (quantity < line.quantityReceived) {
          throw new BadRequestException(
            `Cannot set quantity to ${quantity}: ${line.quantityReceived} unit(s) already received`,
          );
        }
        if (quantity < allocated) {
          throw new BadRequestException(
            `Cannot set quantity to ${quantity}: ${allocated} unit(s) committed to sales orders`,
          );
        }
        updates.push({ line, quantity, unitCostCents });
      } else if (e.variantId) {
        if (!Number.isInteger(e.quantity) || (e.quantity ?? 0) <= 0) {
          throw new BadRequestException('lines[].quantity must be a positive integer');
        }
        if (!Number.isInteger(e.unitCostCents) || (e.unitCostCents ?? -1) < 0) {
          throw new BadRequestException('lines[].unitCostCents must be a non-negative integer');
        }
        const [variant] = await this.db
          .select({ id: schema.productVariants.id })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.id, e.variantId))
          .limit(1);
        if (!variant) throw new NotFoundException(`Variant not found: ${e.variantId}`);
        additions.push({
          variantId: e.variantId,
          quantity: e.quantity!,
          unitCostCents: e.unitCostCents!,
        });
      } else {
        throw new BadRequestException('Each line entry needs a lineId or a variantId');
      }
    }
    if (lines.length - removals.length + additions.length === 0) {
      throw new BadRequestException('A purchase order needs at least one line — cancel it instead');
    }

    for (const r of removals) {
      await this.db.delete(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, r.id));
    }
    for (const u of updates) {
      await this.db
        .update(schema.purchaseOrderLines)
        .set({
          quantityOrdered: u.quantity,
          unitCostCents: u.unitCostCents,
          lineTotalCents: u.quantity * u.unitCostCents,
        })
        .where(eq(schema.purchaseOrderLines.id, u.line.id));
    }
    for (const a of additions) {
      await this.db.insert(schema.purchaseOrderLines).values({
        businessId: tenant.businessId!,
        purchaseOrderId: id,
        variantId: a.variantId,
        quantityOrdered: a.quantity,
        unitCostCents: a.unitCostCents,
        lineTotalCents: a.quantity * a.unitCostCents,
      });
    }

    const refreshed = await this.db
      .select({ lineTotalCents: schema.purchaseOrderLines.lineTotalCents })
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const subtotalCents = refreshed.reduce((s, l) => s + l.lineTotalCents, 0);
    const patch: Partial<typeof schema.purchaseOrders.$inferInsert> = {
      subtotalCents,
      updatedAt: new Date(),
    };
    if (body.expectedAt !== undefined) {
      patch.expectedAt = body.expectedAt === null ? null : parseDate(body.expectedAt);
    }
    if (body.freightCents !== undefined && body.freightCents !== po.freightCents) {
      if (
        body.freightCents !== null &&
        (!Number.isInteger(body.freightCents) || body.freightCents < 0)
      ) {
        throw new BadRequestException('freightCents must be a non-negative integer or null');
      }
      // Q1: earlier receipts already layered their freight share — a new
      // amount would make the layers inconsistent with the PO.
      if (lines.some((l) => l.quantityReceived > 0)) {
        throw new BadRequestException(
          'Cannot change freight after units have been received — un-receive them first',
        );
      }
      patch.freightCents = body.freightCents;
    }
    if (body.notes !== undefined) patch.notes = body.notes ?? null;
    await this.db.update(schema.purchaseOrders).set(patch).where(eq(schema.purchaseOrders.id, id));

    await this.audit.log({
      action: 'purchase_order.update',
      targetType: 'purchase_order',
      targetId: id,
      before: { subtotalCents: po.subtotalCents },
      after: {
        subtotalCents,
        updatedLines: updates.length,
        removedLines: removals.length,
        addedLines: additions.length,
      },
    });
    return this.hydrate(id);
  }

  /**
   * Un-receive: correct a mis-keyed receipt. Backs `quantity` accepted
   * units per line out of stock (an `unreceive_po` ledger entry, never a
   * silent edit) and rolls the received/inspected/accepted counters back
   * together, reopening the PO. Refuses to cut into units committed to
   * sales orders or already reserved — free stock only, the same
   * convention as physical counts.
   */
  @Post(':id/unreceive')
  @RequirePermission('purchase_orders.receive')
  async unreceive(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: UnreceivePoBody,
  ): Promise<PoDetail> {
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must contain at least one entry');
    }
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status !== 'partially_received' && po.status !== 'received') {
      throw new ForbiddenException(`Nothing received on a ${po.status} purchase order`);
    }
    if (po.directShip) {
      // PO-060: the receipt fulfilled the customer's order and posted
      // cost of sale — there is no stock to put back. Corrections go
      // through a customer return.
      throw new BadRequestException(
        'Cannot un-receive a direct-ship PO — the goods went to the customer; correct via a return',
      );
    }

    const lines = await this.db
      .select()
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const byId = new Map(lines.map((l) => [l.id, l]));

    const seen = new Set<string>();
    const validated: { line: (typeof lines)[number]; qty: number }[] = [];
    for (const r of body.lines) {
      if (!r.lineId) throw new BadRequestException('lines[].lineId is required');
      if (seen.has(r.lineId)) {
        throw new BadRequestException(`Duplicate lineId in request: ${r.lineId}`);
      }
      seen.add(r.lineId);
      const line = byId.get(r.lineId);
      if (!line) throw new NotFoundException(`PO line not found: ${r.lineId}`);
      if (!Number.isInteger(r.quantity) || (r.quantity ?? 0) <= 0) {
        throw new BadRequestException('lines[].quantity must be a positive integer');
      }
      const qty = r.quantity!;
      if (qty > line.quantityAccepted) {
        throw new BadRequestException(
          `Cannot un-receive ${qty} of line ${line.id}: only ${line.quantityAccepted} accepted`,
        );
      }
      // Units already committed to a sales order stay committed.
      const [committed] = await this.db
        .select({
          quantity: sql<number>`coalesce(sum(${schema.poLineAllocations.quantity}), 0)::int`,
        })
        .from(schema.poLineAllocations)
        .where(
          and(
            eq(schema.poLineAllocations.poLineId, line.id),
            eq(schema.poLineAllocations.status, 'received'),
          ),
        );
      if (qty > line.quantityAccepted - (committed?.quantity ?? 0)) {
        throw new BadRequestException(
          `Cannot un-receive ${qty} of line ${line.id}: ${committed?.quantity ?? 0} unit(s) are committed to sales orders`,
        );
      }
      // Free stock only — a reservation is never silently unwound.
      const [level] = await this.db
        .select({
          onHand: schema.inventoryLevels.onHand,
          reserved: schema.inventoryLevels.reserved,
          floorSample: schema.inventoryLevels.floorSample,
        })
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, line.variantId),
            eq(schema.inventoryLevels.locationId, po.locationId),
          ),
        )
        .limit(1);
      const free = (level?.onHand ?? 0) - (level?.reserved ?? 0) - (level?.floorSample ?? 0);
      if (qty > free) {
        throw new BadRequestException(
          `Cannot un-receive ${qty} of line ${line.id}: only ${Math.max(free, 0)} free (unreserved) unit(s) at this location — release reservations first`,
        );
      }
      validated.push({ line, qty });
    }

    let unitsUnreceived = 0;
    for (const v of validated) {
      await this.db.insert(schema.inventoryMovements).values({
        businessId: tenant.businessId!,
        variantId: v.line.variantId,
        locationId: po.locationId,
        delta: -v.qty,
        reason: 'unreceive_po',
        referenceType: 'purchase_order',
        referenceId: po.id,
        actorUserId: actor.id,
        notes: body.notes ?? null,
      });
      await this.db
        .update(schema.inventoryLevels)
        .set({
          onHand: sql`${schema.inventoryLevels.onHand} - ${v.qty}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, v.line.variantId),
            eq(schema.inventoryLevels.locationId, po.locationId),
          ),
        );
      await this.db
        .update(schema.purchaseOrderLines)
        .set({
          quantityReceived: v.line.quantityReceived - v.qty,
          quantityInspected: v.line.quantityInspected - v.qty,
          quantityAccepted: v.line.quantityAccepted - v.qty,
        })
        .where(eq(schema.purchaseOrderLines.id, v.line.id));
      // FIFO: back the units out of this PO's own layers first.
      await this.costing.consume(this.db, {
        businessId: tenant.businessId!,
        variantId: v.line.variantId,
        locationId: po.locationId,
        quantity: v.qty,
        referenceType: 'po_unreceive',
        referenceId: po.id,
        preferReferenceId: po.id,
      });
      unitsUnreceived += v.qty;
    }

    const refreshed = await this.db
      .select({
        ordered: schema.purchaseOrderLines.quantityOrdered,
        received: schema.purchaseOrderLines.quantityReceived,
        accepted: schema.purchaseOrderLines.quantityAccepted,
        rejected: schema.purchaseOrderLines.quantityRejected,
      })
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const fullyAccepted = refreshed.every((l) => l.accepted + l.rejected >= l.ordered);
    const anyReceived = refreshed.some((l) => l.received > 0);
    const nextStatus = fullyAccepted ? 'received' : anyReceived ? 'partially_received' : 'ordered';
    await this.db
      .update(schema.purchaseOrders)
      .set({
        status: nextStatus,
        closedAt: fullyAccepted ? po.closedAt : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.purchaseOrders.id, id));

    await this.exceptions.record({
      type: 'po_unreceive',
      severity: 'info',
      entityType: 'purchase_order',
      entityId: po.id,
      summary: `${unitsUnreceived} unit(s) un-received on ${po.number} — receipt correction`,
      metadata: { lines: validated.map((v) => ({ poLineId: v.line.id, quantity: v.qty })) },
    });
    await this.audit.log({
      action: 'purchase_order.unreceive',
      targetType: 'purchase_order',
      targetId: po.id,
      after: { status: nextStatus, unitsUnreceived, lineCount: validated.length },
    });
    return this.hydrate(id);
  }

  /**
   * Receive a batch of units against an open PO. Multiple receipts
   * across the lifetime of the PO are supported — the status
   * transitions automatically from `ordered` → `partially_received` →
   * `received` once every line's `quantity_received` catches up to
   * `quantity_ordered`.
   *
   * Each line in the body specifies how many units arrived; we
   * append `inventory_movements` rows + upsert `inventory_levels`
   * exactly the way the manual Receive flow does, then bump the PO
   * line counters.
   */
  @Post(':id/receive')
  @RequirePermission('purchase_orders.receive')
  async receive(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: ReceivePoBody,
  ): Promise<PoReceiveResult> {
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must contain at least one entry');
    }
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status !== 'ordered' && po.status !== 'partially_received') {
      throw new ForbiddenException(`Cannot receive against a ${po.status} purchase order`);
    }

    const lines = await this.db
      .select()
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const byId = new Map(lines.map((l) => [l.id, l]));

    // Validate every requested receipt up-front before mutating
    // anything; we want partial-success semantics.
    const validated: { line: (typeof lines)[number]; qty: number }[] = [];
    for (const r of body.lines) {
      if (!r.lineId) throw new BadRequestException('lines[].lineId is required');
      const line = byId.get(r.lineId);
      if (!line) throw new NotFoundException(`PO line not found: ${r.lineId}`);
      if (!Number.isInteger(r.quantity) || (r.quantity ?? 0) <= 0) {
        throw new BadRequestException('lines[].quantity must be a positive integer');
      }
      const remaining = line.quantityOrdered - line.quantityReceived;
      if (r.quantity! > remaining) {
        throw new BadRequestException(
          `Cannot receive ${r.quantity} of line ${line.id}: only ${remaining} remaining`,
        );
      }
      validated.push({ line, qty: r.quantity! });
    }

    // Fast path: dock receipt, inspection, and acceptance in one step.
    // The staged endpoint below is the granular §6 flow; this one keeps
    // the one-click "it all arrived fine" behavior.
    return this.applyReceiving(
      tenant,
      actor,
      po,
      validated.map((v) => ({ line: v.line, received: v.qty, inspected: v.qty, accepted: v.qty })),
      body.notes ?? null,
    );
  }

  /**
   * Staged receiving (§6): one screen, per line Received → Inspected →
   * Accepted, each an increment. Stock and the linked sales-order
   * reservations move only at ACCEPT; dock receipt and inspection are
   * bookkeeping until then. The PO auto-completes only when every line
   * is fully accepted.
   */
  @Post(':id/receiving')
  @RequirePermission('purchase_orders.receive')
  async receiveStages(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: ReceiveStagesBody,
  ): Promise<PoReceiveResult> {
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must contain at least one entry');
    }
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status !== 'ordered' && po.status !== 'partially_received') {
      throw new ForbiddenException(`Cannot receive against a ${po.status} purchase order`);
    }

    const lines = await this.db
      .select()
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const byId = new Map(lines.map((l) => [l.id, l]));

    const seen = new Set<string>();
    const entries: {
      line: (typeof lines)[number];
      received: number;
      inspected: number;
      accepted: number;
      rejected: number;
    }[] = [];
    for (const r of body.lines) {
      if (!r.lineId) throw new BadRequestException('lines[].lineId is required');
      if (seen.has(r.lineId)) {
        throw new BadRequestException(`Duplicate lineId in request: ${r.lineId}`);
      }
      seen.add(r.lineId);
      const line = byId.get(r.lineId);
      if (!line) throw new NotFoundException(`PO line not found: ${r.lineId}`);
      const inc = (v: number | undefined, name: string): number => {
        if (v === undefined) return 0;
        if (!Number.isInteger(v) || v < 0) {
          throw new BadRequestException(`lines[].${name} must be a non-negative integer`);
        }
        return v;
      };
      const received = inc(r.received, 'received');
      const inspected = inc(r.inspected, 'inspected');
      const accepted = inc(r.accepted, 'accepted');
      const rejected = inc(r.rejected, 'rejected');
      if (received + inspected + accepted + rejected === 0) {
        throw new BadRequestException('Each line needs at least one stage increment');
      }
      // Invariant after the increments:
      //   ordered ≥ received ≥ inspected ≥ accepted + rejected.
      const nextReceived = line.quantityReceived + received;
      const nextInspected = line.quantityInspected + inspected;
      const nextAccepted = line.quantityAccepted + accepted;
      const nextRejected = line.quantityRejected + rejected;
      if (nextReceived > line.quantityOrdered) {
        throw new BadRequestException(
          `Cannot receive ${received}: only ${line.quantityOrdered - line.quantityReceived} of ${line.quantityOrdered} remaining`,
        );
      }
      if (nextInspected > nextReceived) {
        throw new BadRequestException('Cannot inspect more units than have been received');
      }
      if (nextAccepted + nextRejected > nextInspected) {
        throw new BadRequestException('Cannot accept + reject more units than have been inspected');
      }
      entries.push({ line, received, inspected, accepted, rejected });
    }

    return this.applyReceiving(tenant, actor, po, entries, body.notes ?? null);
  }

  /**
   * Shared receiving core. Bumps the three stage counters; the accepted
   * increment is the only one that moves stock (inventory ledger + level
   * upsert) and walks the special-order allocations (G3) so linked
   * sales-order lines flip to Reserved and the customer gets the "your
   * item is in" email. Completion = every line fully ACCEPTED.
   */
  private async applyReceiving(
    tenant: RequestTenantContext,
    actor: CurrentUserPayload,
    po: typeof schema.purchaseOrders.$inferSelect,
    entries: {
      line: typeof schema.purchaseOrderLines.$inferSelect;
      received: number;
      inspected: number;
      accepted: number;
      rejected?: number;
    }[],
    notes: string | null,
  ): Promise<PoReceiveResult> {
    let unblockedOrders: PoReceiveResult['unblockedOrders'] = [];
    let unitsReceived = 0;
    let unitsAccepted = 0;
    // Q1 landed cost lean: every ordered unit carries the same freight
    // share, fixed by the ordered total so partial receipts layer
    // identically whenever they arrive (sub-cent remainders round away).
    let freightPerUnitCents = 0;
    if (po.freightCents != null && po.freightCents > 0) {
      const [ordered] = await this.db
        .select({
          total: sql<number>`COALESCE(SUM(${schema.purchaseOrderLines.quantityOrdered}), 0)::int`,
        })
        .from(schema.purchaseOrderLines)
        .where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id));
      if ((ordered?.total ?? 0) > 0) {
        freightPerUnitCents = Math.round(po.freightCents / ordered!.total);
      }
    }
    for (const e of entries) {
      if (po.directShip && (e.rejected ?? 0) > 0) {
        // The goods are at the customer's door, not on our dock — a bad
        // direct-ship unit is a return/exchange conversation, not a dock
        // reject.
        throw new BadRequestException(
          'Direct-ship POs cannot reject units at receiving — handle problems as a customer return',
        );
      }
      if (e.accepted > 0 && po.directShip) {
        // PO-060: the vendor shipped straight to the customer. No stock,
        // no movement, no lasting valuation — a cost layer consumed on
        // the spot posts cost of sale at the PO cost.
        await this.costing.addLayer(this.db, {
          businessId: tenant.businessId!,
          variantId: e.line.variantId,
          locationId: po.locationId,
          sourceType: 'po_receive',
          referenceId: po.id,
          quantity: e.accepted,
          unitCostCents: e.line.unitCostCents + freightPerUnitCents,
        });
        await this.costing.consume(this.db, {
          businessId: tenant.businessId!,
          variantId: e.line.variantId,
          locationId: po.locationId,
          quantity: e.accepted,
          referenceType: 'direct_ship',
          referenceId: po.id,
          preferReferenceId: po.id,
        });
      } else if (e.accepted > 0) {
        await this.db.insert(schema.inventoryMovements).values({
          businessId: tenant.businessId!,
          variantId: e.line.variantId,
          locationId: po.locationId,
          delta: e.accepted,
          reason: 'receive_po',
          referenceType: 'purchase_order',
          referenceId: po.id,
          actorUserId: actor.id,
          notes,
        });
        await this.db
          .insert(schema.inventoryLevels)
          .values({
            businessId: tenant.businessId!,
            variantId: e.line.variantId,
            locationId: po.locationId,
            onHand: e.accepted,
          })
          .onConflictDoUpdate({
            target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
            set: {
              onHand: sql`${schema.inventoryLevels.onHand} + ${e.accepted}`,
              updatedAt: new Date(),
            },
          });
        // FIFO: the receipt is a cost layer at the PO line's unit cost.
        await this.costing.addLayer(this.db, {
          businessId: tenant.businessId!,
          variantId: e.line.variantId,
          locationId: po.locationId,
          sourceType: 'po_receive',
          referenceId: po.id,
          quantity: e.accepted,
          unitCostCents: e.line.unitCostCents + freightPerUnitCents,
        });
      }
      const rejected = e.rejected ?? 0;
      if (rejected > 0) {
        // G11 third bucket: failed units go to As-Is review as pieces —
        // the reviewer disposes them (vendor return w/ R/A, or scrap as
        // a valued write-off). They never silently become sellable.
        const pieces = await this.db
          .insert(schema.asIsItems)
          .values(
            Array.from({ length: rejected }, () => ({
              businessId: tenant.businessId!,
              variantId: e.line.variantId,
              locationId: po.locationId,
              quantity: 1,
              source: 'defect',
              referenceType: 'purchase_order',
              referenceId: po.id,
              notes: notes ?? `Rejected at receiving on ${po.number}`,
            })),
          )
          .returning({ id: schema.asIsItems.id });
        for (const piece of pieces) {
          await this.db
            .update(schema.asIsItems)
            .set({ pieceNumber: `AS-${piece.id.slice(0, 8).toUpperCase()}` })
            .where(eq(schema.asIsItems.id, piece.id));
        }
        await this.exceptions.record({
          type: 'po_reject',
          severity: 'info',
          entityType: 'purchase_order',
          entityId: po.id,
          summary: `${rejected} unit(s) rejected at receiving on ${po.number} — staged in As-Is review`,
          metadata: { poLineId: e.line.id, rejected },
        });
      }
      await this.db
        .update(schema.purchaseOrderLines)
        .set({
          quantityReceived: e.line.quantityReceived + e.received,
          quantityInspected: e.line.quantityInspected + e.inspected,
          quantityAccepted: e.line.quantityAccepted + e.accepted,
          quantityRejected: e.line.quantityRejected + rejected,
        })
        .where(eq(schema.purchaseOrderLines.id, e.line.id));
      if (e.accepted > 0 && po.directShip) {
        await this.specialOrders.handleDirectShipReceipt(this.db, {
          businessId: tenant.businessId!,
          poLineId: e.line.id,
          quantity: e.accepted,
          actorUserId: actor.id ?? null,
        });
      } else if (e.accepted > 0) {
        await this.specialOrders.handleReceipt(this.db, {
          businessId: tenant.businessId!,
          poLineId: e.line.id,
          locationId: po.locationId,
          quantity: e.accepted,
          actorUserId: actor.id ?? null,
        });
      }
      unitsReceived += e.received;
      unitsAccepted += e.accepted;
    }

    // §6: the PO auto-completes only when every line is fully accepted;
    // anything short of that is a partial receipt with "X of Y remaining".
    const refreshed = await this.db
      .select({
        ordered: schema.purchaseOrderLines.quantityOrdered,
        received: schema.purchaseOrderLines.quantityReceived,
        accepted: schema.purchaseOrderLines.quantityAccepted,
        rejected: schema.purchaseOrderLines.quantityRejected,
      })
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id));
    // G11: a PO completes when every ordered unit is DISPOSITIONED —
    // accepted into stock or rejected into As-Is; rejects no longer
    // strand the PO open (or worse, pressure the dock into accepting
    // damage to close it).
    const fullyAccepted = refreshed.every((l) => l.accepted + l.rejected >= l.ordered);
    const nextStatus = fullyAccepted ? 'received' : 'partially_received';
    const closedAt = fullyAccepted ? new Date() : null;
    await this.db
      .update(schema.purchaseOrders)
      .set({ status: nextStatus, closedAt, updatedAt: new Date() })
      .where(eq(schema.purchaseOrders.id, po.id));

    await this.audit.log({
      action: 'purchase_order.receive',
      targetType: 'purchase_order',
      targetId: po.id,
      after: {
        status: nextStatus,
        unitsReceived,
        unitsAccepted,
        lineCount: entries.length,
      },
    });

    // B14: newly accepted stock backfills "Pending" order lines in
    // reservation-basis order (special-order allocations above already
    // took their linked units first).
    const acceptedVariantIds = po.directShip
      ? [] // direct ship: nothing entered stock, nothing to backfill
      : entries
          .filter((e) => e.accepted > 0 && e.line.variantId)
          .map((e) => e.line.variantId as string);
    if (acceptedVariantIds.length > 0) {
      const [biz] = await this.db
        .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, tenant.businessId!))
        .limit(1);
      const ops = (biz?.opsSettingsJson ?? {}) as { reserveBasis?: string | null };
      const allocations = await this.orders.allocatePending(this.db, {
        businessId: tenant.businessId!,
        actorUserId: actor.id ?? null,
        basis: ops.reserveBasis === 'order_date' ? 'order_date' : 'delivery_date',
        variantIds: acceptedVariantIds,
      });
      for (const a of allocations) {
        await this.audit.log({
          action: 'order.allocate_pending',
          targetType: 'order',
          targetId: a.orderId,
          metadata: { number: a.number, trigger: 'po_receive', poId: po.id, lines: a.lines },
        });
      }
      unblockedOrders = allocations.map((a) => ({
        orderId: a.orderId,
        number: a.number,
        units: a.lines.reduce((n, l) => n + l.quantity, 0),
      }));
    }

    if (fullyAccepted) {
      void this.webhooks.fire({
        businessId: tenant.businessId!,
        eventType: 'purchase_order.received',
        payload: {
          purchaseOrderId: po.id,
          number: po.number,
          vendorId: po.vendorId,
          locationId: po.locationId,
          subtotalCents: po.subtotalCents,
        },
      });
    }
    return { ...(await this.hydrate(po.id)), unblockedOrders };
  }

  @Post(':id/cancel')
  @RequirePermission('purchase_orders.cancel')
  async cancel(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<PoDetail> {
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');
    // Cancelling a deleted draft would flip its status and strand it —
    // restore only accepts drafts. Deleted rows accept exactly one verb.
    if (po.deletedAt) {
      throw new ConflictException({
        message: 'This purchase order is deleted. Restore it before cancelling it.',
        code: 'ALREADY_DELETED',
      });
    }
    if (po.status === 'received' || po.status === 'canceled') {
      throw new ForbiddenException(`Cannot cancel a ${po.status} purchase order`);
    }
    await this.db
      .update(schema.purchaseOrders)
      .set({ status: 'canceled', closedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.purchaseOrders.id, id));

    await this.audit.log({
      action: 'purchase_order.cancel',
      targetType: 'purchase_order',
      targetId: id,
      before: { status: po.status },
      after: { status: 'canceled' },
    });
    return this.hydrate(id);
  }

  /**
   * Delete a draft (CR 2026-08-31). Before this endpoint a draft PO had
   * no exit: retiring one meant placing it — recording a vendor
   * commitment that never existed — and cancelling, or stripping its
   * lines and leaving a $0.00 shell on the list forever. The reorder
   * panel makes drafts one click at a time, so the shells accumulate.
   *
   * Soft, not hard: the row stays, keeping its number spoken for. PO
   * numbers come from a count of existing rows, so a kept row is also
   * what stops the next PO inheriting a deleted one's number — gaps in
   * the sequence are expected.
   *
   * The whole request runs inside the RLS transaction, so un-sourcing
   * the linked special-order lines and stamping the delete either both
   * happen or neither does. There is no stock to release: a draft PO
   * holds none — stock moves only at receive/unreceive — so the only
   * thing a draft holds is its allocations.
   */
  @Delete(':id')
  @RequirePermission('purchase_orders.delete')
  async remove(
    @CurrentTenant() _tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<PoDetail> {
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');

    const lines = await this.db
      .select({
        id: schema.purchaseOrderLines.id,
        quantityReceived: schema.purchaseOrderLines.quantityReceived,
        quantityInspected: schema.purchaseOrderLines.quantityInspected,
        quantityAccepted: schema.purchaseOrderLines.quantityAccepted,
        quantityRejected: schema.purchaseOrderLines.quantityRejected,
      })
      .from(schema.purchaseOrderLines)
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));

    const [invoice] = await this.db
      .select({ number: schema.vendorInvoices.number })
      .from(schema.vendorInvoices)
      .where(
        and(
          eq(schema.vendorInvoices.purchaseOrderId, id),
          inArray(schema.vendorInvoices.status, ['matched', 'approved']),
        ),
      )
      .limit(1);

    // A linked sales-order line the customer already has in hand: un-
    // sourcing it would put a fulfilled line back on the buying queue.
    const lineIds = lines.map((l) => l.id);
    let fulfilledOrderNumber: string | null = null;
    if (lineIds.length > 0) {
      const [fulfilled] = await this.db
        .select({ number: schema.orders.number })
        .from(schema.poLineAllocations)
        .innerJoin(
          schema.orderLines,
          eq(schema.orderLines.id, schema.poLineAllocations.orderLineId),
        )
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
        .where(
          and(
            inArray(schema.poLineAllocations.poLineId, lineIds),
            sql`${schema.poLineAllocations.status} <> 'cancelled'`,
            sql`${schema.orderLines.qtyFulfilled} > 0`,
          ),
        )
        .limit(1);
      fulfilledOrderNumber = fulfilled?.number ?? null;
    }

    const refusal = checkPoDeletable({
      status: po.status,
      deletedAt: po.deletedAt,
      hasReceivedUnits: lines.some(
        (l) =>
          l.quantityReceived > 0 ||
          l.quantityInspected > 0 ||
          l.quantityAccepted > 0 ||
          l.quantityRejected > 0,
      ),
      matchedInvoiceNumber: invoice?.number ?? null,
      fulfilledOrderNumber,
    });
    if (refusal) {
      throw new ConflictException({ message: refusal.message, code: refusal.code });
    }

    // Return every linked special-order line to the queue as un-sourced.
    // The queue counts allocations that are not 'cancelled', so this is
    // what puts the line back in front of a buyer.
    let unsourced = 0;
    if (lineIds.length > 0) {
      const released = await this.db
        .update(schema.poLineAllocations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            inArray(schema.poLineAllocations.poLineId, lineIds),
            sql`${schema.poLineAllocations.status} <> 'cancelled'`,
          ),
        )
        .returning({ id: schema.poLineAllocations.id });
      unsourced = released.length;
    }

    const deletedAt = new Date();
    await this.db
      .update(schema.purchaseOrders)
      .set({ deletedAt, deletedByUserId: actor?.id ?? null, updatedAt: deletedAt })
      .where(eq(schema.purchaseOrders.id, id));

    await this.audit.log({
      action: 'purchase_order.delete',
      targetType: 'purchase_order',
      targetId: id,
      metadata: {
        number: po.number,
        subtotalCents: po.subtotalCents,
        lineCount: lines.length,
        unsourcedAllocations: unsourced,
      },
    });
    return this.hydrate(id);
  }

  /**
   * Undo a delete. The draft comes back with its original number,
   * lines and subtotal — but its special-order allocations do not:
   * those lines went back on the buying queue and may have been sourced
   * elsewhere in the meantime, so re-claiming them here could source one
   * line twice. Re-link from the queue if that is what is wanted.
   */
  @Post(':id/restore')
  @RequirePermission('purchase_orders.delete')
  async restore(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<PoDetail> {
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');

    const refusal = checkPoRestorable({ status: po.status, deletedAt: po.deletedAt });
    if (refusal) {
      throw new ConflictException({ message: refusal.message, code: refusal.code });
    }

    await this.db
      .update(schema.purchaseOrders)
      .set({ deletedAt: null, deletedByUserId: null, updatedAt: new Date() })
      .where(eq(schema.purchaseOrders.id, id));

    await this.audit.log({
      action: 'purchase_order.restore',
      targetType: 'purchase_order',
      targetId: id,
      metadata: { number: po.number },
    });
    return this.hydrate(id);
  }

  /**
   * §6: email the PO to the vendor from the system. Replies route to
   * the admin-set ops.poReplyTo when configured. The email body is the
   * same data the printable document renders — vendor SKU, quantities,
   * costs, and the linked sales order #s so the vendor sees which units
   * are customer-committed.
   */
  @Post(':id/email')
  @RequirePermission('purchase_orders.create')
  async emailToVendor(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ sent: true; to: string }> {
    const po = await this.hydrate(id);
    if (po.status === 'draft') {
      throw new BadRequestException('Place the purchase order before emailing it');
    }
    if (!po.vendorEmail) {
      throw new BadRequestException('This vendor has no email address on file');
    }

    const [biz] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    const ops = (biz?.opsSettingsJson ?? {}) as { poReplyTo?: string };

    const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    const rows = po.lines
      .map((l) => {
        const linked =
          l.linkedOrders.length > 0
            ? `<br/><small>For sales order(s): ${l.linkedOrders
                .map((o) => `${escapeHtml(o.orderNumber)} ×${o.quantity}`)
                .join(', ')}</small>`
            : '';
        return `<tr><td>${escapeHtml(l.vendorSku ?? l.sku ?? '')}</td><td>${escapeHtml(
          l.productName,
        )}${l.variantName ? ` — ${escapeHtml(l.variantName)}` : ''}${linked}</td><td align="right">${
          l.quantityOrdered
        }</td><td align="right">${money(l.unitCostCents)}</td><td align="right">${money(
          l.lineTotalCents,
        )}</td></tr>`;
      })
      .join('');
    const html = `
      <h2>Purchase Order ${escapeHtml(po.number)}</h2>
      <p>From: ${escapeHtml(po.businessName ?? '')}<br/>
      Ship to: ${escapeHtml(po.locationName ?? '')}<br/>
      ${po.expectedAt ? `Expected: ${new Date(po.expectedAt).toISOString().slice(0, 10)}` : ''}</p>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
        <tr><th>SKU</th><th>Item</th><th>Qty</th><th>Unit cost</th><th>Total</th></tr>
        ${rows}
        <tr><td colspan="4" align="right"><strong>Subtotal</strong></td><td align="right"><strong>${money(
          po.subtotalCents,
        )}</strong></td></tr>
      </table>
      ${po.notes ? `<p>${escapeHtml(po.notes)}</p>` : ''}
    `;

    await this.email.send({
      to: po.vendorEmail,
      subject: `Purchase Order ${po.number} — ${po.businessName ?? ''}`.trim(),
      html,
      text: `Purchase Order ${po.number}. ${po.lines.length} line(s), subtotal ${money(po.subtotalCents)}.`,
      replyTo: ops.poReplyTo || undefined,
    });

    await this.audit.log({
      action: 'purchase_order.email',
      targetType: 'purchase_order',
      targetId: id,
      metadata: { to: po.vendorEmail, replyTo: ops.poReplyTo ?? null },
    });
    return { sent: true, to: po.vendorEmail };
  }

  private async hydrate(id: string): Promise<PoDetail> {
    const poDeleter = alias(schema.users, 'po_detail_deleter');
    const [po] = await this.db
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        status: schema.purchaseOrders.status,
        vendorId: schema.purchaseOrders.vendorId,
        vendorName: schema.vendors.name,
        vendorContactName: schema.vendors.contactName,
        vendorEmail: schema.vendors.email,
        vendorPhone: schema.vendors.phone,
        locationId: schema.purchaseOrders.locationId,
        locationName: schema.locations.name,
        locationAddressJson: schema.locations.addressJson,
        businessName: schema.businesses.name,
        businessBrandingJson: schema.businesses.brandingJson,
        businessOpsJson: schema.businesses.opsSettingsJson,
        expectedAt: schema.purchaseOrders.expectedAt,
        placedAt: schema.purchaseOrders.placedAt,
        closedAt: schema.purchaseOrders.closedAt,
        subtotalCents: schema.purchaseOrders.subtotalCents,
        freightCents: schema.purchaseOrders.freightCents,
        directShip: schema.purchaseOrders.directShip,
        shipToJson: schema.purchaseOrders.shipToJson,
        printCount: schema.purchaseOrders.printCount,
        lastPrintedAt: schema.purchaseOrders.lastPrintedAt,
        notes: schema.purchaseOrders.notes,
        createdByUserId: schema.purchaseOrders.createdByUserId,
        createdAt: schema.purchaseOrders.createdAt,
        deletedAt: schema.purchaseOrders.deletedAt,
        deletedByEmail: poDeleter.email,
      })
      .from(schema.purchaseOrders)
      .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.purchaseOrders.locationId))
      .leftJoin(schema.businesses, eq(schema.businesses.id, schema.purchaseOrders.businessId))
      .leftJoin(poDeleter, eq(poDeleter.id, schema.purchaseOrders.deletedByUserId))
      .where(eq(schema.purchaseOrders.id, id))
      .limit(1);
    if (!po) throw new NotFoundException('Purchase order not found');

    const lines = await this.db
      .select({
        id: schema.purchaseOrderLines.id,
        variantId: schema.purchaseOrderLines.variantId,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        vendorSku: schema.productVariants.vendorSku,
        quantityOrdered: schema.purchaseOrderLines.quantityOrdered,
        quantityReceived: schema.purchaseOrderLines.quantityReceived,
        quantityInspected: schema.purchaseOrderLines.quantityInspected,
        quantityAccepted: schema.purchaseOrderLines.quantityAccepted,
        quantityRejected: schema.purchaseOrderLines.quantityRejected,
        unitCostCents: schema.purchaseOrderLines.unitCostCents,
        lineTotalCents: schema.purchaseOrderLines.lineTotalCents,
      })
      .from(schema.purchaseOrderLines)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.purchaseOrderLines.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id));

    // §6: every PO line bought for a customer order carries that sales
    // order # — resolved through the special-order allocations.
    const linkedByLine = new Map<
      string,
      { orderId: string; orderNumber: string; quantity: number }[]
    >();
    if (lines.length > 0) {
      const allocs = await this.db
        .select({
          poLineId: schema.poLineAllocations.poLineId,
          quantity: schema.poLineAllocations.quantity,
          status: schema.poLineAllocations.status,
          orderId: schema.orderLines.orderId,
          orderNumber: schema.orders.number,
        })
        .from(schema.poLineAllocations)
        .innerJoin(
          schema.orderLines,
          eq(schema.orderLines.id, schema.poLineAllocations.orderLineId),
        )
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
        .where(
          inArray(
            schema.poLineAllocations.poLineId,
            lines.map((l) => l.id),
          ),
        );
      for (const a of allocs) {
        if (a.status === 'cancelled') continue;
        const list = linkedByLine.get(a.poLineId) ?? [];
        const existing = list.find((o) => o.orderId === a.orderId);
        if (existing) existing.quantity += a.quantity;
        else list.push({ orderId: a.orderId, orderNumber: a.orderNumber, quantity: a.quantity });
        linkedByLine.set(a.poLineId, list);
      }
    }

    const branding = (po.businessBrandingJson ?? {}) as { logoUrl?: string; publicName?: string };
    const blindReceiving = Boolean(
      ((po.businessOpsJson ?? {}) as { blindReceiving?: boolean }).blindReceiving,
    );
    const { businessBrandingJson: _branding, businessOpsJson: _ops, ...rest } = po;
    return {
      ...rest,
      businessName: branding.publicName ?? po.businessName ?? null,
      businessLogoUrl: branding.logoUrl ?? null,
      blindReceiving,
      lines: lines.map((l) => ({
        ...l,
        productName: l.productName ?? '(deleted)',
        linkedOrders: linkedByLine.get(l.id) ?? [],
      })),
    };
  }

  /**
   * Per-business, per-year PO number. Mirrors the sale-numbering
   * approach: count + retry-on-conflict, with a randomized fallback
   * if 5 sequential candidates collide.
   */
  private async generatePoNumber(businessId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.purchaseOrders)
        .where(
          and(
            eq(schema.purchaseOrders.businessId, businessId),
            sql`${schema.purchaseOrders.number} LIKE ${`PO-${year}-%`}`,
          ),
        );
      const count = rows[0]?.count ?? 0;
      const seq = count + 1 + attempt;
      const candidate = `PO-${year}-${String(seq).padStart(6, '0')}`;
      const [existing] = await this.db
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
    return `PO-${year}-${Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0')}`;
  }
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
