import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
} from '../common/pagination';
import { CostingService } from '../costing/costing.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { ExceptionsService } from '../controls/exceptions.service';
import {
  SecurityOverrideService,
  type OverrideCredentials,
} from '../controls/security-override.service';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

const SOURCES = ['return', 'warranty', 'defect', 'exchange_pickup', 'stock'] as const;
const REVIEW_ACTIONS = ['restock', 'vendor_return', 'scrap'] as const;

interface IntakeBody {
  variantId?: string;
  locationId?: string;
  quantity?: number;
  source?: (typeof SOURCES)[number];
  condition?: string | null;
  storageLocation?: string | null;
  reasonCodeId?: string;
  reason?: string;
  override?: OverrideCredentials;
  notes?: string | null;
  /**
   * A22 slice 3 (STORIS Stock Adjustment → Move to As-Is): the pieces
   * come out of sellable stock here — the level drops by `quantity`
   * (available units only) and the ledger records an `as_is_intake`.
   * Without it the intake is the walk-in path: nothing was in stock.
   */
  fromStock?: boolean;
}

interface VoidBody {
  reason?: string | null;
  /** Put the unit back into sellable stock (an as-is adjustment made in error). */
  returnToStock?: boolean;
}

interface ReviewBody {
  action?: (typeof REVIEW_ACTIONS)[number];
  /**
   * Restock target — defaults to the item's own variant; pass the
   * matching `-AS` variant to move it into as-is stock instead.
   */
  targetVariantId?: string;
  notes?: string | null;
  /** Scrap (G4): coded write-off reason + optional manager override. */
  reasonCodeId?: string;
  reason?: string;
  override?: OverrideCredentials;
  /** Vendor return (G4): the R/A number and the credit to chase. */
  raNumber?: string;
  expectedCreditCents?: number;
}

interface AsIsRow {
  id: string;
  variantId: string;
  productName: string | null;
  variantName: string | null;
  sku: string | null;
  locationId: string;
  locationName: string | null;
  quantity: number;
  source: string;
  status: string;
  referenceType: string | null;
  referenceId: string | null;
  restockedVariantId: string | null;
  pieceNumber: string | null;
  condition: string | null;
  asIsPriceCents: number | null;
  storageLocation: string | null;
  vendorRaNumber: string | null;
  vendorCreditCents: number | null;
  vendorCreditStatus: string | null;
  notes: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  /** Where the piece came from — resolved from reference_type/id (owner 2026-09-02). */
  origin: AsIsOrigin | null;
}

/**
 * The document the piece walked in on, resolved for the review screen:
 * the invoice (sale or order) with its customer, the RMA when a return
 * authorized it, the transfer or PO for consolidation/defect intake.
 * `manual` intake has no origin.
 */
export interface AsIsOrigin {
  kind: 'sale' | 'order' | 'order_return' | 'stock_transfer' | 'purchase_order';
  /** The clickable document: a sale, order, transfer or purchase order. */
  documentId: string;
  documentNumber: string;
  /** RMA number when a return authorization produced the piece. */
  rmaNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  /** Transfer origin store / PO vendor — the "from" of the piece. */
  fromName: string | null;
  documentDate: Date | null;
}

/**
 * The As-Is review queue (PLAN-POS-OPERATIONS §10): returned,
 * warranty, and defect units wait here — outside sellable stock —
 * until a manager or warehouse reviews them. Disposition: restock
 * (same variant or the `-AS` variant), return to vendor, or scrap.
 */
@TenantScoped()
@Controller('v1/as-is')
export class AsIsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SecurityOverrideService) private readonly overrides: SecurityOverrideService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(CostingService) private readonly costing: CostingService,
  ) {}

  @Get()
  @RequirePermission('inventory.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('status') status?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<PageResponse<AsIsRow>> {
    const limit = clampLimit(limitStr);
    const cursor = decodeCursor(cursorStr);
    const conditions: SQL[] = [];
    if (status) conditions.push(eq(schema.asIsItems.status, status));
    if (cursor) {
      conditions.push(
        timestampCursorWhere(schema.asIsItems.createdAt, schema.asIsItems.id, cursor)!,
      );
    }
    const rows = await this.queryRows(conditions, limit + 1);
    return buildPage(rows, limit, (r) => r.createdAt);
  }

  /** The shared list query — cursor-ordered newest-first. */
  private async queryRows(conditions: SQL[], limit: number): Promise<AsIsRow[]> {
    const rows = await this.queryBaseRows(conditions, limit);
    const origins = await this.resolveOrigins(rows);
    return rows.map((r) => ({ ...r, origin: origins.get(r.id) ?? null }));
  }

  /**
   * Batch-resolve every row's reference to the document it came from:
   * one query per reference type, never one per row.
   */
  private async resolveOrigins(rows: Omit<AsIsRow, 'origin'>[]): Promise<Map<string, AsIsOrigin>> {
    const out = new Map<string, AsIsOrigin>();
    const idsOf = (type: string) => [
      ...new Set(
        rows.filter((r) => r.referenceType === type && r.referenceId).map((r) => r.referenceId!),
      ),
    ];
    const assign = (type: string, byRef: Map<string, AsIsOrigin>) => {
      for (const r of rows) {
        if (r.referenceType === type && r.referenceId && byRef.has(r.referenceId)) {
          out.set(r.id, byRef.get(r.referenceId)!);
        }
      }
    };
    const customerName = (first: string | null, last: string | null) =>
      [first, last].filter(Boolean).join(' ') || null;

    // Register refunds → the sale (invoice) and its customer.
    const refundIds = idsOf('refund');
    if (refundIds.length) {
      const hits = await this.db
        .select({
          refundId: schema.refunds.id,
          saleId: schema.sales.id,
          number: schema.sales.number,
          customerId: schema.sales.customerId,
          first: schema.customers.firstName,
          last: schema.customers.lastName,
          date: schema.sales.createdAt,
        })
        .from(schema.refunds)
        .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
        .leftJoin(schema.customers, eq(schema.customers.id, schema.sales.customerId))
        .where(inArray(schema.refunds.id, refundIds));
      assign(
        'refund',
        new Map(
          hits.map((h) => [
            h.refundId,
            {
              kind: 'sale' as const,
              documentId: h.saleId,
              documentNumber: h.number,
              rmaNumber: null,
              customerId: h.customerId,
              customerName: customerName(h.first, h.last),
              fromName: null,
              documentDate: h.date,
            },
          ]),
        ),
      );
    }

    // Order returns → the RMA and the order it was authorized against.
    const orderReturnIds = idsOf('order_return');
    if (orderReturnIds.length) {
      const hits = await this.db
        .select({
          returnId: schema.orderReturns.id,
          rma: schema.orderReturns.rmaNumber,
          orderId: schema.orders.id,
          number: schema.orders.number,
          customerId: schema.orders.customerId,
          first: schema.customers.firstName,
          last: schema.customers.lastName,
          date: schema.orders.createdAt,
        })
        .from(schema.orderReturns)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderReturns.orderId))
        .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
        .where(inArray(schema.orderReturns.id, orderReturnIds));
      assign(
        'order_return',
        new Map(
          hits.map((h) => [
            h.returnId,
            {
              kind: 'order_return' as const,
              documentId: h.orderId,
              documentNumber: h.number,
              rmaNumber: h.rma,
              customerId: h.customerId,
              customerName: customerName(h.first, h.last),
              fromName: null,
              documentDate: h.date,
            },
          ]),
        ),
      );
    }

    // Straight order references (older return flows).
    const orderIds = idsOf('order');
    if (orderIds.length) {
      const hits = await this.db
        .select({
          orderId: schema.orders.id,
          number: schema.orders.number,
          customerId: schema.orders.customerId,
          first: schema.customers.firstName,
          last: schema.customers.lastName,
          date: schema.orders.createdAt,
        })
        .from(schema.orders)
        .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
        .where(inArray(schema.orders.id, orderIds));
      assign(
        'order',
        new Map(
          hits.map((h) => [
            h.orderId,
            {
              kind: 'order' as const,
              documentId: h.orderId,
              documentNumber: h.number,
              rmaNumber: null,
              customerId: h.customerId,
              customerName: customerName(h.first, h.last),
              fromName: null,
              documentDate: h.date,
            },
          ]),
        ),
      );
    }

    // Consolidation transfers → the transfer and the store it left.
    const transferIds = idsOf('stock_transfer');
    if (transferIds.length) {
      const hits = await this.db
        .select({
          transferId: schema.stockTransfers.id,
          number: schema.stockTransfers.number,
          fromName: schema.locations.name,
          date: schema.stockTransfers.createdAt,
        })
        .from(schema.stockTransfers)
        .leftJoin(schema.locations, eq(schema.locations.id, schema.stockTransfers.fromLocationId))
        .where(inArray(schema.stockTransfers.id, transferIds));
      assign(
        'stock_transfer',
        new Map(
          hits.map((h) => [
            h.transferId,
            {
              kind: 'stock_transfer' as const,
              documentId: h.transferId,
              documentNumber: h.number,
              rmaNumber: null,
              customerId: null,
              customerName: null,
              fromName: h.fromName,
              documentDate: h.date,
            },
          ]),
        ),
      );
    }

    // Defects found at receiving → the PO and its vendor.
    const poIds = idsOf('purchase_order');
    if (poIds.length) {
      const hits = await this.db
        .select({
          poId: schema.purchaseOrders.id,
          number: schema.purchaseOrders.number,
          vendorName: schema.vendors.name,
          date: schema.purchaseOrders.createdAt,
        })
        .from(schema.purchaseOrders)
        .leftJoin(schema.vendors, eq(schema.vendors.id, schema.purchaseOrders.vendorId))
        .where(inArray(schema.purchaseOrders.id, poIds));
      assign(
        'purchase_order',
        new Map(
          hits.map((h) => [
            h.poId,
            {
              kind: 'purchase_order' as const,
              documentId: h.poId,
              documentNumber: h.number,
              rmaNumber: null,
              customerId: null,
              customerName: null,
              fromName: h.vendorName,
              documentDate: h.date,
            },
          ]),
        ),
      );
    }
    return out;
  }

  private async queryBaseRows(
    conditions: SQL[],
    limit: number,
  ): Promise<Omit<AsIsRow, 'origin'>[]> {
    return this.db
      .select({
        id: schema.asIsItems.id,
        variantId: schema.asIsItems.variantId,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        locationId: schema.asIsItems.locationId,
        locationName: schema.locations.name,
        quantity: schema.asIsItems.quantity,
        source: schema.asIsItems.source,
        status: schema.asIsItems.status,
        referenceType: schema.asIsItems.referenceType,
        referenceId: schema.asIsItems.referenceId,
        restockedVariantId: schema.asIsItems.restockedVariantId,
        pieceNumber: schema.asIsItems.pieceNumber,
        condition: schema.asIsItems.condition,
        asIsPriceCents: schema.asIsItems.asIsPriceCents,
        storageLocation: schema.asIsItems.storageLocation,
        vendorRaNumber: schema.asIsItems.vendorRaNumber,
        vendorCreditCents: schema.asIsItems.vendorCreditCents,
        vendorCreditStatus: schema.asIsItems.vendorCreditStatus,
        notes: schema.asIsItems.notes,
        reviewedAt: schema.asIsItems.reviewedAt,
        createdAt: schema.asIsItems.createdAt,
      })
      .from(schema.asIsItems)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.asIsItems.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.asIsItems.locationId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(...timestampCursorOrder(schema.asIsItems.createdAt, schema.asIsItems.id))
      .limit(limit);
  }

  /** Manual intake — warranty/defect units walking in outside a return. */
  @Post()
  @RequirePermission('inventory.adjust')
  async intake(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: IntakeBody,
  ): Promise<AsIsRow> {
    if (!body.variantId) throw new BadRequestException('variantId is required');
    if (!body.locationId) throw new BadRequestException('locationId is required');
    if (!Number.isInteger(body.quantity) || (body.quantity ?? 0) <= 0) {
      throw new BadRequestException('quantity must be a positive integer');
    }
    const source = body.source ?? 'warranty';
    if (!SOURCES.includes(source)) {
      throw new BadRequestException(`source must be one of ${SOURCES.join(', ')}`);
    }
    const [variant] = await this.db
      .select({ id: schema.productVariants.id, costCents: schema.productVariants.costCents })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, body.variantId))
      .limit(1);
    if (!variant) throw new NotFoundException('Variant not found');
    const fromStock = body.fromStock === true || source === 'stock';
    if (fromStock) {
      const [level] = await this.db
        .select({
          onHand: schema.inventoryLevels.onHand,
          reserved: schema.inventoryLevels.reserved,
          floorSample: schema.inventoryLevels.floorSample,
        })
        .from(schema.inventoryLevels)
        .where(
          and(
            eq(schema.inventoryLevels.variantId, body.variantId),
            eq(schema.inventoryLevels.locationId, body.locationId),
          ),
        )
        .limit(1);
      const available = level ? level.onHand - level.reserved - level.floorSample : 0;
      if (available < body.quantity!) {
        throw new BadRequestException(
          `Only ${Math.max(0, available)} available unit(s) here — release reservations or the floor hold before moving ${body.quantity} to As-Is`,
        );
      }
    }

    // G10: coded intake reason (class `as_is`); a RESTRICTED code needs
    // write-off authority or a manager override (STORIS "As-Is
    // Restricted" behavior).
    const reason = await this.overrides.resolveReason(
      'as_is',
      { reasonCodeId: body.reasonCodeId, reason: body.reason },
      { required: false },
    );
    if (reason.reasonCodeId) {
      const [code] = await this.db
        .select({ isRestricted: schema.reasonCodes.isRestricted })
        .from(schema.reasonCodes)
        .where(eq(schema.reasonCodes.id, reason.reasonCodeId))
        .limit(1);
      if (code?.isRestricted) {
        await this.overrides.require({
          permission: 'inventory.write_off',
          action: `Use restricted as-is reason ${reason.reasonCode}`,
          entityType: 'as_is_item',
          override: body.override,
        });
      }
    }

    // G10 piece identity: one row per unit, each with its own
    // reference. The piece number derives from the row id — unique
    // without a sequence race.
    const inserted = await this.db
      .insert(schema.asIsItems)
      .values(
        Array.from({ length: body.quantity! }, () => ({
          businessId: tenant.businessId!,
          variantId: body.variantId!,
          locationId: body.locationId!,
          quantity: 1,
          source,
          referenceType: 'manual',
          condition: body.condition ?? null,
          storageLocation: body.storageLocation ?? null,
          reasonCodeId: reason.reasonCodeId,
          notes: body.notes ?? reason.reasonText ?? null,
        })),
      )
      .returning();
    for (const row of inserted) {
      await this.db
        .update(schema.asIsItems)
        .set({ pieceNumber: `AS-${row.id.slice(0, 8).toUpperCase()}` })
        .where(eq(schema.asIsItems.id, row.id));
    }
    if (fromStock) {
      // The pieces leave sellable stock: one ledger row for the move,
      // FIFO layers consumed, the level dropped. Restock (Move from
      // As-Is) is the mirror image and lands them back at catalog cost.
      await this.db.insert(schema.inventoryMovements).values({
        businessId: tenant.businessId!,
        variantId: body.variantId,
        locationId: body.locationId,
        delta: -body.quantity!,
        reason: 'as_is_intake',
        referenceType: 'as_is_item',
        referenceId: inserted[0]!.id,
        reasonCodeId: reason.reasonCodeId,
        actorUserId: actor.id,
        notes: body.notes ?? reason.reasonText ?? null,
      });
      await this.costing.consume(this.db, {
        businessId: tenant.businessId!,
        variantId: body.variantId,
        locationId: body.locationId,
        quantity: body.quantity!,
        referenceType: 'as_is_intake',
        referenceId: inserted[0]!.id,
      });
      await this.db
        .update(schema.inventoryLevels)
        .set({
          onHand: sql`GREATEST(0, ${schema.inventoryLevels.onHand} - ${body.quantity!})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, body.variantId),
            eq(schema.inventoryLevels.locationId, body.locationId),
          ),
        );
    }
    await this.audit.log({
      action: 'as_is.intake',
      targetType: 'as_is_item',
      targetId: inserted[0]!.id,
      after: {
        variantId: body.variantId,
        pieces: inserted.length,
        source,
        fromStock,
        reasonCode: reason.reasonCode,
      },
    });
    return this.load(inserted[0]!.id);
  }

  /**
   * A22 slice 3 (STORIS "As-Is Adjustment"): take a piece out of the
   * as-is queue without a disposition — the intake was a mistake, or
   * the piece was counted twice. `returnToStock` puts the unit back
   * into sellable stock (only meaningful for a piece that came out of
   * stock); otherwise the row simply closes as `voided`. Pending pieces
   * only — a reviewed piece already has its ledger.
   */
  @Post(':id/void')
  @RequirePermission('inventory.adjust')
  async voidPiece(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: VoidBody,
  ): Promise<AsIsRow> {
    const [item] = await this.db
      .select()
      .from(schema.asIsItems)
      .where(eq(schema.asIsItems.id, id))
      .limit(1);
    if (!item) throw new NotFoundException('As-Is item not found');
    if (item.status !== 'pending_review') {
      throw new BadRequestException(`Item is already ${item.status}`);
    }
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestException('reason is required');
    const returnToStock = body.returnToStock === true;
    if (returnToStock) {
      await this.db.insert(schema.inventoryMovements).values({
        businessId: tenant.businessId!,
        variantId: item.variantId,
        locationId: item.locationId,
        delta: item.quantity,
        reason: 'as_is_void',
        referenceType: 'as_is_item',
        referenceId: item.id,
        actorUserId: actor.id,
        notes: reason,
      });
      const [pv] = await this.db
        .select({ costCents: schema.productVariants.costCents })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, item.variantId))
        .limit(1);
      await this.costing.addLayer(this.db, {
        businessId: tenant.businessId!,
        variantId: item.variantId,
        locationId: item.locationId,
        sourceType: 'as_is_void',
        referenceId: item.id,
        quantity: item.quantity,
        unitCostCents: pv?.costCents ?? null,
      });
      await this.db
        .insert(schema.inventoryLevels)
        .values({
          businessId: tenant.businessId!,
          variantId: item.variantId,
          locationId: item.locationId,
          onHand: item.quantity,
        })
        .onConflictDoUpdate({
          target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
          set: {
            onHand: sql`${schema.inventoryLevels.onHand} + ${item.quantity}`,
            updatedAt: new Date(),
          },
        });
    }
    await this.db
      .update(schema.asIsItems)
      .set({
        status: 'voided',
        reviewedByUserId: actor.id,
        reviewedAt: new Date(),
        notes: [item.notes, `Voided: ${reason}`].filter(Boolean).join(' · '),
      })
      .where(eq(schema.asIsItems.id, id));
    await this.audit.log({
      action: 'as_is.void',
      targetType: 'as_is_item',
      targetId: id,
      before: { status: item.status, quantity: item.quantity },
      after: { status: 'voided', returnToStock, reason },
    });
    return this.load(id);
  }

  /**
   * G10: the as-is selling price is its own permission (STORIS "Set or
   * change as-is selling price"), and condition / storage location are
   * editable in place.
   */
  @Patch(':id')
  @RequirePermission('inventory.view')
  async updatePiece(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body()
    body: {
      asIsPriceCents?: number | null;
      condition?: string | null;
      storageLocation?: string | null;
      override?: OverrideCredentials;
    },
  ): Promise<AsIsRow> {
    const [item] = await this.db
      .select()
      .from(schema.asIsItems)
      .where(eq(schema.asIsItems.id, id))
      .limit(1);
    if (!item) throw new NotFoundException('As-Is item not found');
    const patch: Partial<typeof schema.asIsItems.$inferInsert> = {};
    if (body.asIsPriceCents !== undefined) {
      if (
        body.asIsPriceCents !== null &&
        (!Number.isInteger(body.asIsPriceCents) || body.asIsPriceCents < 0)
      ) {
        throw new BadRequestException('asIsPriceCents must be a non-negative integer');
      }
      await this.overrides.require({
        permission: 'as_is.price.set',
        action: `Set as-is price on piece ${item.pieceNumber ?? item.id}`,
        entityType: 'as_is_item',
        entityId: id,
        override: body.override,
      });
      patch.asIsPriceCents = body.asIsPriceCents;
    }
    if (body.condition !== undefined) patch.condition = body.condition;
    if (body.storageLocation !== undefined) patch.storageLocation = body.storageLocation;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Nothing to update');
    }
    await this.db.update(schema.asIsItems).set(patch).where(eq(schema.asIsItems.id, id));
    await this.audit.log({
      action: 'as_is.update',
      targetType: 'as_is_item',
      targetId: id,
      before: {
        asIsPriceCents: item.asIsPriceCents,
        condition: item.condition,
        storageLocation: item.storageLocation,
      },
      after: patch as Record<string, unknown>,
    });
    return this.load(id);
  }

  /** G10 aging: pieces waiting in review longer than `days` (default 60). */
  @Get('aging')
  @RequirePermission('inventory.view')
  async aging(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('days') daysStr?: string,
  ): Promise<AsIsRow[]> {
    const days = Math.min(365, Math.max(1, Number(daysStr) || 60));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.queryRows([eq(schema.asIsItems.status, 'pending_review')], 200);
    return rows.filter((r) => new Date(r.createdAt).getTime() < cutoff.getTime());
  }

  /**
   * The §10 review: restock puts the units into sellable stock (the
   * original variant, or the `-AS` variant when passed); vendor_return
   * and scrap close the row without touching inventory. One-shot — a
   * reviewed row is final.
   */
  @Post(':id/review')
  @RequirePermission('inventory.adjust')
  async review(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: ReviewBody,
  ): Promise<AsIsRow> {
    if (!body.action || !REVIEW_ACTIONS.includes(body.action)) {
      throw new BadRequestException(`action must be one of ${REVIEW_ACTIONS.join(', ')}`);
    }
    const [item] = await this.db
      .select()
      .from(schema.asIsItems)
      .where(eq(schema.asIsItems.id, id))
      .limit(1);
    if (!item) throw new NotFoundException('As-Is item not found');
    if (item.status !== 'pending_review') {
      throw new BadRequestException(`Item is already ${item.status}`);
    }

    let restockedVariantId: string | null = null;
    let vendorRaNumber: string | null = null;
    let vendorCreditCents: number | null = null;
    let vendorCreditStatus: string | null = null;

    if (body.action === 'restock') {
      restockedVariantId = body.targetVariantId ?? item.variantId;
      if (restockedVariantId !== item.variantId) {
        const [target] = await this.db
          .select({ id: schema.productVariants.id })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.id, restockedVariantId))
          .limit(1);
        if (!target) throw new NotFoundException('Target variant not found');
      }
      await this.db.insert(schema.inventoryMovements).values({
        businessId: tenant.businessId!,
        variantId: restockedVariantId,
        locationId: item.locationId,
        delta: item.quantity,
        reason: 'as_is_restock',
        referenceType: 'as_is_item',
        referenceId: item.id,
        actorUserId: actor.id,
        notes: body.notes ?? null,
      });
      // FIFO: restocked as-is pieces layer at the variant's catalog cost.
      {
        const [pv] = await this.db
          .select({ costCents: schema.productVariants.costCents })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.id, restockedVariantId))
          .limit(1);
        await this.costing.addLayer(this.db, {
          businessId: tenant.businessId!,
          variantId: restockedVariantId,
          locationId: item.locationId,
          sourceType: 'as_is_restock',
          referenceId: item.id,
          quantity: item.quantity,
          unitCostCents: pv?.costCents ?? null,
        });
      }
      await this.db
        .insert(schema.inventoryLevels)
        .values({
          businessId: tenant.businessId!,
          variantId: restockedVariantId,
          locationId: item.locationId,
          onHand: item.quantity,
        })
        .onConflictDoUpdate({
          target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
          set: {
            onHand: sql`${schema.inventoryLevels.onHand} + ${item.quantity}`,
            updatedAt: new Date(),
          },
        });
    } else if (body.action === 'vendor_return') {
      // G4: no R/A number, no way to chase the vendor credit.
      vendorRaNumber = body.raNumber?.trim() || null;
      if (!vendorRaNumber) {
        throw new BadRequestException(
          'raNumber is required for a vendor return — no R/A, no credit to chase',
        );
      }
      if (body.expectedCreditCents !== undefined) {
        if (!Number.isInteger(body.expectedCreditCents) || body.expectedCreditCents < 0) {
          throw new BadRequestException('expectedCreditCents must be a non-negative integer');
        }
        vendorCreditCents = body.expectedCreditCents;
      }
      vendorCreditStatus = 'open';
    } else {
      // G4: scrap is a write-off — its own permission (override-able),
      // a coded reason (class `write_off`), valued at cost, and a row
      // on the write-off register the owner reads weekly.
      await this.overrides.require({
        permission: 'inventory.write_off',
        action: `Write off ${item.quantity} unit(s) pending As-Is review`,
        entityType: 'as_is_item',
        entityId: item.id,
        override: body.override,
      });
      const reason = await this.overrides.resolveReason('write_off', {
        reasonCodeId: body.reasonCodeId ?? body.override?.reasonCodeId,
        reason: body.reason ?? body.override?.reason ?? body.notes,
      });
      const [variant] = await this.db
        .select({ costCents: schema.productVariants.costCents })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, item.variantId))
        .limit(1);
      const unitCost = variant?.costCents ?? 0;
      await this.db.insert(schema.writeOffs).values({
        businessId: tenant.businessId!,
        asIsItemId: item.id,
        variantId: item.variantId,
        locationId: item.locationId,
        quantity: item.quantity,
        unitCostCents: unitCost,
        totalCostCents: unitCost * item.quantity,
        reasonCodeId: reason.reasonCodeId,
        reason: reason.reasonText,
        actorUserId: actor.id,
      });
      await this.exceptions.record({
        type: 'write_off',
        severity: 'warning',
        entityType: 'as_is_item',
        entityId: item.id,
        summary: `${item.quantity} unit(s) written off at cost $${((unitCost * item.quantity) / 100).toFixed(2)}`,
        metadata: {
          variantId: item.variantId,
          quantity: item.quantity,
          totalCostCents: unitCost * item.quantity,
          reasonCode: reason.reasonCode,
          reason: reason.reasonText,
        },
      });
    }

    const status =
      body.action === 'restock'
        ? 'restocked'
        : body.action === 'vendor_return'
          ? 'vendor_return'
          : 'scrapped';
    await this.db
      .update(schema.asIsItems)
      .set({
        status,
        restockedVariantId,
        vendorRaNumber,
        vendorCreditCents,
        vendorCreditStatus,
        reviewedByUserId: actor.id,
        reviewedAt: new Date(),
        notes: body.notes ?? item.notes,
      })
      .where(eq(schema.asIsItems.id, id));

    await this.audit.log({
      action: 'as_is.review',
      targetType: 'as_is_item',
      targetId: id,
      after: {
        action: body.action,
        status,
        restockedVariantId,
        quantity: item.quantity,
        vendorRaNumber,
        vendorCreditCents,
      },
    });
    return this.load(id);
  }

  /**
   * H2 (RTV-020/021): unwind a vendor return sent in error — wrong
   * vendor, wrong piece, or the truck never left. The piece goes back
   * to pending_review and its credit chase is voided. Only possible
   * while the credit is still open (or was never set up): once money
   * has been received, reverse it through the vendor invoice instead.
   */
  @Post(':id/reopen')
  @RequirePermission('inventory.adjust')
  async reopen(
    @CurrentTenant() _tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { notes?: string | null },
  ): Promise<AsIsRow> {
    const [item] = await this.db
      .select()
      .from(schema.asIsItems)
      .where(eq(schema.asIsItems.id, id))
      .limit(1);
    if (!item) throw new NotFoundException('As-Is item not found');
    if (item.status !== 'vendor_return') {
      throw new BadRequestException(
        `Only a vendor_return piece can be reopened (this one is ${item.status})`,
      );
    }
    if (item.vendorCreditStatus === 'received') {
      throw new BadRequestException(
        'Credit already received — reverse it with the vendor before reopening the piece',
      );
    }
    await this.db
      .update(schema.asIsItems)
      .set({
        status: 'pending_review',
        vendorRaNumber: null,
        vendorCreditCents: null,
        vendorCreditStatus: null,
        reviewedByUserId: null,
        reviewedAt: null,
        notes: body.notes ?? item.notes,
      })
      .where(eq(schema.asIsItems.id, id));
    await this.audit.log({
      action: 'as_is.reopen',
      targetType: 'as_is_item',
      targetId: id,
      before: {
        status: item.status,
        vendorRaNumber: item.vendorRaNumber,
        vendorCreditCents: item.vendorCreditCents,
        vendorCreditStatus: item.vendorCreditStatus,
      },
      after: { status: 'pending_review' },
    });
    await this.exceptions.record({
      type: 'rtv_reopened',
      severity: 'info',
      entityType: 'as_is_item',
      entityId: id,
      summary: `Vendor return ${item.vendorRaNumber ?? ''} unwound — piece ${item.pieceNumber ?? id} back in review`,
      metadata: {
        vendorRaNumber: item.vendorRaNumber,
        vendorCreditCents: item.vendorCreditCents,
      },
      actorUserId: actor.id,
    });
    return this.load(id);
  }

  /**
   * G4: close out a vendor-return credit — received from the vendor, or
   * given up on (which is itself an exception worth seeing).
   */
  @Post(':id/vendor-credit')
  @RequirePermission('vendor_invoices.manage')
  async vendorCredit(
    @CurrentTenant() _tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { action?: 'received' | 'write_off'; notes?: string | null },
  ): Promise<AsIsRow> {
    if (!body.action || !['received', 'write_off'].includes(body.action)) {
      throw new BadRequestException('action must be received or write_off');
    }
    const [item] = await this.db
      .select()
      .from(schema.asIsItems)
      .where(eq(schema.asIsItems.id, id))
      .limit(1);
    if (!item) throw new NotFoundException('As-Is item not found');
    if (item.vendorCreditStatus !== 'open') {
      throw new BadRequestException('No open vendor credit on this item');
    }
    const newStatus = body.action === 'received' ? 'received' : 'written_off';
    await this.db
      .update(schema.asIsItems)
      .set({ vendorCreditStatus: newStatus, notes: body.notes ?? item.notes })
      .where(eq(schema.asIsItems.id, id));
    await this.audit.log({
      action: 'as_is.vendor_credit',
      targetType: 'as_is_item',
      targetId: id,
      after: { vendorCreditStatus: newStatus, vendorCreditCents: item.vendorCreditCents },
    });
    if (body.action === 'write_off') {
      await this.exceptions.record({
        type: 'vendor_credit_write_off',
        severity: 'warning',
        entityType: 'as_is_item',
        entityId: id,
        summary: `Vendor credit ${item.vendorRaNumber ?? ''} written off ($${(((item.vendorCreditCents ?? 0) as number) / 100).toFixed(2)})`,
        metadata: {
          vendorRaNumber: item.vendorRaNumber,
          vendorCreditCents: item.vendorCreditCents,
        },
        actorUserId: actor?.id ?? null,
      });
    }
    return this.load(id);
  }

  private async load(id: string): Promise<AsIsRow> {
    const rows = await this.db
      .select({
        id: schema.asIsItems.id,
        variantId: schema.asIsItems.variantId,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        locationId: schema.asIsItems.locationId,
        locationName: schema.locations.name,
        quantity: schema.asIsItems.quantity,
        source: schema.asIsItems.source,
        status: schema.asIsItems.status,
        referenceType: schema.asIsItems.referenceType,
        referenceId: schema.asIsItems.referenceId,
        restockedVariantId: schema.asIsItems.restockedVariantId,
        pieceNumber: schema.asIsItems.pieceNumber,
        condition: schema.asIsItems.condition,
        asIsPriceCents: schema.asIsItems.asIsPriceCents,
        storageLocation: schema.asIsItems.storageLocation,
        vendorRaNumber: schema.asIsItems.vendorRaNumber,
        vendorCreditCents: schema.asIsItems.vendorCreditCents,
        vendorCreditStatus: schema.asIsItems.vendorCreditStatus,
        notes: schema.asIsItems.notes,
        reviewedAt: schema.asIsItems.reviewedAt,
        createdAt: schema.asIsItems.createdAt,
      })
      .from(schema.asIsItems)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.asIsItems.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.asIsItems.locationId))
      .where(inArray(schema.asIsItems.id, [id]))
      .limit(1);
    if (!rows[0]) throw new NotFoundException('As-Is item not found');
    const origins = await this.resolveOrigins(rows);
    return { ...rows[0], origin: origins.get(rows[0].id) ?? null };
  }
}
