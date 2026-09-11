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
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { loadProductStockByLocation, type StockTotals } from '../catalog/product-stock';
import { CostingService } from '../costing/costing.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import {
  buildPage,
  clampLimit as clampPageLimit,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
} from '../common/pagination';
import { vendorMatchFor } from '../common/vendor-match';
import { ExceptionsService } from '../controls/exceptions.service';
import {
  SecurityOverrideService,
  type OverrideCredentials,
} from '../controls/security-override.service';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

const ADJUST_REASONS = new Set(['count_correction', 'damage', 'theft', 'other']);

interface LevelRow {
  variantId: string;
  locationId: string;
  productId: string;
  productName: string;
  variantSku: string | null;
  variantName: string | null;
  variantBarcode: string | null;
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  storageBinId: string | null;
  storageBinCode: string | null;
  updatedAt: Date;
}

interface MovementRow {
  id: string;
  variantId: string;
  locationId: string;
  delta: number;
  reason: string;
  referenceType: string | null;
  referenceId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  notes: string | null;
  createdAt: Date;
}

interface AdjustBody {
  variantId?: string;
  locationId?: string;
  delta?: number;
  reason?: string;
  notes?: string;
  /** A22 slice 3: coded reason (class `inventory_adjustment`) behind the change. */
  reasonCodeId?: string;
  /** A22 slice 3: the cost an upward adjustment layers at (defaults to the catalog cost). */
  unitCostCents?: number;
}

interface WriteOffBody {
  variantId?: string;
  locationId?: string;
  quantity?: number;
  reasonCodeId?: string;
  reason?: string;
  notes?: string;
  override?: OverrideCredentials;
}

/**
 * A22 slice 3: everything the STORIS Stock Adjustment dialog shows in
 * its header strip for one variant at one location, plus the pieces the
 * As-Is tabs and the Change Serial tab act on.
 */
export interface StockCard extends StockTotals {
  variantId: string;
  productId: string;
  productName: string;
  sku: string | null;
  serialTracked: boolean;
  costCents: number | null;
  locationId: string;
  locationName: string;
  storageBinId: string | null;
  storageBinCode: string | null;
  /** The `-AS` sibling variant, when the catalog carries one, for Move from As-Is. */
  asIsVariantId: string | null;
  asIsPieces: {
    id: string;
    pieceNumber: string | null;
    condition: string | null;
    storageLocation: string | null;
    asIsPriceCents: number | null;
    source: string;
    createdAt: Date;
  }[];
  serials: { id: string; serial: string; status: string }[];
  bins: { id: string; code: string }[];
}

interface ReceiveBody {
  locationId?: string;
  notes?: string;
  lines?: { variantId?: string; quantity?: number }[];
}

@TenantScoped()
@Controller('v1/inventory')
export class InventoryController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
    @Inject(CostingService) private readonly costing: CostingService,
    @Inject(SecurityOverrideService) private readonly overrides: SecurityOverrideService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
  ) {}

  /**
   * List on-hand levels for a location. If locationId is omitted, returns
   * all locations' rows for the current business. The available column is
   * computed as on_hand - reserved (clamped to ≥0).
   */
  @Get('levels')
  @RequirePermission('inventory.view')
  async levels(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
    @Query('q') q?: string,
    @Query('vendorId') vendorId?: string,
  ): Promise<LevelRow[]> {
    const filters = [];
    if (locationId) filters.push(eq(schema.inventoryLevels.locationId, locationId));
    // Vendor (owner 2026-09-02): the vendors page's "in inventory" count
    // opens here, across every location. Same rule as the Add Product popup.
    if (vendorId) filters.push(await vendorMatchFor(this.db, _tenant.businessId!, vendorId));
    const query = q?.trim();
    if (query) {
      // Same tsvector the catalog search uses — covers product name,
      // variant SKU, and barcode in one predicate.
      const tsq = sql`websearch_to_tsquery('simple', ${query})`;
      filters.push(
        sql`(${schema.productVariants.searchTsv} @@ ${tsq}
             OR ${schema.products.searchTsv} @@ ${tsq})`,
      );
    }
    const where = filters.length ? and(...filters) : undefined;
    const rows = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        locationId: schema.inventoryLevels.locationId,
        productId: schema.products.id,
        productName: schema.products.name,
        variantSku: schema.productVariants.sku,
        variantName: schema.productVariants.name,
        variantBarcode: schema.productVariants.barcode,
        onHand: schema.inventoryLevels.onHand,
        reserved: schema.inventoryLevels.reserved,
        floorSample: schema.inventoryLevels.floorSample,
        storageBinId: schema.inventoryLevels.storageBinId,
        storageBinCode: schema.storageBins.code,
        updatedAt: schema.inventoryLevels.updatedAt,
      })
      .from(schema.inventoryLevels)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.inventoryLevels.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .leftJoin(schema.storageBins, eq(schema.storageBins.id, schema.inventoryLevels.storageBinId))
      .where(where)
      .orderBy(asc(schema.products.name), asc(schema.productVariants.sku));
    return rows.map((r) => ({
      ...r,
      available: Math.max(0, r.onHand - r.reserved - r.floorSample),
    }));
  }

  /**
   * Who holds the reserved units (owner ask 2026-08-30): clicking the
   * Reserved number on the inventory page lists the order lines
   * committing this variant at this location, so staff can release a
   * reservation to sell the piece today and re-commit it elsewhere.
   * A line counts against the location it actually reserves from:
   * its own source, else the order's stock location, else the order's
   * selling location.
   */
  @Get('reservations')
  @RequirePermission('inventory.view')
  async reservations(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('variantId') variantId?: string,
    @Query('locationId') locationId?: string,
  ): Promise<
    {
      orderId: string;
      orderNumber: string;
      orderStatus: string;
      requestedDate: string | null;
      customerName: string | null;
      lineId: string;
      description: string;
      qtyReserved: number;
    }[]
  > {
    if (!variantId || !locationId) {
      throw new BadRequestException('variantId and locationId are required');
    }
    return this.db
      .select({
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        orderStatus: schema.orders.status,
        requestedDate: schema.orders.requestedDate,
        customerName: sql<
          string | null
        >`NULLIF(TRIM(CONCAT(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        lineId: schema.orderLines.id,
        description: schema.orderLines.description,
        qtyReserved: schema.orderLines.qtyReserved,
      })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orderLines.variantId, variantId),
          sql`${schema.orderLines.qtyReserved} > 0`,
          sql`COALESCE(${schema.orderLines.sourceLocationId}, ${schema.orders.stockLocationId}, ${schema.orders.locationId}) = ${locationId}`,
        ),
      )
      .orderBy(asc(schema.orders.createdAt));
  }

  /**
   * Storage bins (STORIS Tracked Storage Location parity, lean). Bins are
   * per-location named slots; stock levels optionally point at one so the
   * pick list and receiving know where to walk. Convention: managed under
   * `inventory.adjust` — the people who correct stock own where it sits.
   */
  @Get('bins')
  @RequirePermission('inventory.view')
  async bins(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
  ): Promise<
    {
      id: string;
      locationId: string;
      code: string;
      description: string | null;
      isActive: boolean;
    }[]
  > {
    const where = locationId ? eq(schema.storageBins.locationId, locationId) : undefined;
    return this.db
      .select({
        id: schema.storageBins.id,
        locationId: schema.storageBins.locationId,
        code: schema.storageBins.code,
        description: schema.storageBins.description,
        isActive: schema.storageBins.isActive,
      })
      .from(schema.storageBins)
      .where(where)
      .orderBy(asc(schema.storageBins.code));
  }

  @Post('bins')
  @RequirePermission('inventory.adjust')
  async createBin(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { locationId?: string; code?: string; description?: string | null },
  ): Promise<{ id: string; locationId: string; code: string }> {
    const code = body.code?.trim().toUpperCase();
    if (!code) throw new BadRequestException('code is required');
    if (code.length > 24) throw new BadRequestException('code must be 24 characters or fewer');
    if (!body.locationId) throw new BadRequestException('locationId is required');
    const [loc] = await this.db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(eq(schema.locations.id, body.locationId))
      .limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    const [dup] = await this.db
      .select({ id: schema.storageBins.id })
      .from(schema.storageBins)
      .where(
        and(eq(schema.storageBins.locationId, body.locationId), eq(schema.storageBins.code, code)),
      )
      .limit(1);
    if (dup) throw new ConflictException(`Bin "${code}" already exists at this location`);
    const [row] = await this.db
      .insert(schema.storageBins)
      .values({
        businessId: tenant.businessId!,
        locationId: body.locationId,
        code,
        description: body.description?.trim() || null,
      })
      .returning();
    if (!row) throw new BadRequestException('failed to create bin');
    await this.audit.log({
      action: 'inventory.bin.create',
      targetType: 'storage_bin',
      targetId: row.id,
      after: { locationId: row.locationId, code: row.code },
    });
    return { id: row.id, locationId: row.locationId, code: row.code };
  }

  @Patch('bins/:id')
  @RequirePermission('inventory.adjust')
  async updateBin(
    @Param('id') id: string,
    @Body() body: { code?: string; description?: string | null; isActive?: boolean },
  ): Promise<{ updated: true }> {
    const [existing] = await this.db
      .select()
      .from(schema.storageBins)
      .where(eq(schema.storageBins.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Bin not found');
    const update: Partial<typeof schema.storageBins.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (body.code !== undefined) {
      const code = body.code.trim().toUpperCase();
      if (!code) throw new BadRequestException('code cannot be empty');
      if (code.length > 24) throw new BadRequestException('code must be 24 characters or fewer');
      if (code !== existing.code) {
        update.code = code;
        before.code = existing.code;
        after.code = code;
      }
    }
    if (body.description !== undefined) {
      const description = body.description?.trim() || null;
      if (description !== existing.description) {
        update.description = description;
        before.description = existing.description;
        after.description = description;
      }
    }
    if (body.isActive !== undefined && body.isActive !== existing.isActive) {
      update.isActive = body.isActive;
      before.isActive = existing.isActive;
      after.isActive = body.isActive;
    }
    if (Object.keys(after).length === 0) return { updated: true };
    if (update.code) {
      const [dup] = await this.db
        .select({ id: schema.storageBins.id })
        .from(schema.storageBins)
        .where(
          and(
            eq(schema.storageBins.locationId, existing.locationId),
            eq(schema.storageBins.code, update.code),
          ),
        )
        .limit(1);
      if (dup && dup.id !== id) {
        throw new ConflictException(`Bin "${update.code}" already exists at this location`);
      }
    }
    await this.db.update(schema.storageBins).set(update).where(eq(schema.storageBins.id, id));
    await this.audit.log({
      action: 'inventory.bin.update',
      targetType: 'storage_bin',
      targetId: id,
      before,
      after,
    });
    return { updated: true };
  }

  /**
   * Point a stock level at the bin holding it (or null to unbin). The
   * level row must already exist — a bin assignment for stock that has
   * never had a level is meaningless — and the bin must be an active bin
   * of the same location.
   */
  /**
   * J2 (STK-020): set the floor-sample hold on a level — units that are
   * physically on hand but never sellable or reservable as new. This is
   * the manual "nail down" path; receiving a floor_sample transfer is
   * the other. Absolute set, clamped to on-hand, audited.
   */
  @Post('levels/floor-sample')
  @RequirePermission('inventory.adjust')
  async setFloorSample(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Body() body: { variantId?: string; locationId?: string; quantity?: number },
  ): Promise<{ floorSample: number }> {
    if (!body.variantId || !body.locationId) {
      throw new BadRequestException('variantId and locationId are required');
    }
    if (!Number.isInteger(body.quantity) || (body.quantity ?? -1) < 0) {
      throw new BadRequestException('quantity must be a non-negative integer');
    }
    const [level] = await this.db
      .select({
        onHand: schema.inventoryLevels.onHand,
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
    if (!level) throw new NotFoundException('No stock level for that variant at that location');
    const next = Math.min(body.quantity!, level.onHand);
    await this.db
      .update(schema.inventoryLevels)
      .set({ floorSample: next, updatedAt: new Date() })
      .where(
        and(
          eq(schema.inventoryLevels.variantId, body.variantId),
          eq(schema.inventoryLevels.locationId, body.locationId),
        ),
      );
    await this.audit.log({
      action: 'inventory.floor_sample.set',
      targetType: 'inventory_level',
      targetId: body.variantId,
      before: { floorSample: level.floorSample },
      after: { floorSample: next, locationId: body.locationId },
    });
    return { floorSample: next };
  }

  @Post('levels/assign-bin')
  @RequirePermission('inventory.adjust')
  async assignBin(
    @Body() body: { variantId?: string; locationId?: string; storageBinId?: string | null },
  ): Promise<{ updated: true }> {
    if (!body.variantId || !body.locationId) {
      throw new BadRequestException('variantId and locationId are required');
    }
    const [level] = await this.db
      .select()
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.variantId, body.variantId),
          eq(schema.inventoryLevels.locationId, body.locationId),
        ),
      )
      .limit(1);
    if (!level) throw new NotFoundException('No stock level exists for that variant and location');
    const storageBinId = body.storageBinId ?? null;
    if (storageBinId) {
      const [bin] = await this.db
        .select()
        .from(schema.storageBins)
        .where(eq(schema.storageBins.id, storageBinId))
        .limit(1);
      if (!bin) throw new NotFoundException('Bin not found');
      if (bin.locationId !== body.locationId) {
        throw new BadRequestException('Bin belongs to a different location');
      }
      if (!bin.isActive) throw new BadRequestException('Bin is inactive');
    }
    if (storageBinId === level.storageBinId) return { updated: true };
    await this.db
      .update(schema.inventoryLevels)
      .set({ storageBinId, updatedAt: new Date() })
      .where(eq(schema.inventoryLevels.id, level.id));
    await this.audit.log({
      action: 'inventory.bin.assign',
      targetType: 'inventory_level',
      targetId: level.id,
      before: { storageBinId: level.storageBinId },
      after: { storageBinId, variantId: body.variantId, locationId: body.locationId },
    });
    return { updated: true };
  }

  @Get('movements')
  @RequirePermission('inventory.view')
  async movements(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('variantId') variantId?: string,
    @Query('locationId') locationId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<PageResponse<MovementRow>> {
    const limit = clampPageLimit(limitStr);
    const conditions = [] as ReturnType<typeof eq>[];
    if (variantId) conditions.push(eq(schema.inventoryMovements.variantId, variantId));
    if (locationId) conditions.push(eq(schema.inventoryMovements.locationId, locationId));
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) conditions.push(gte(schema.inventoryMovements.createdAt, d));
    }
    if (until) {
      const d = new Date(until);
      if (!Number.isNaN(d.getTime())) conditions.push(lt(schema.inventoryMovements.createdAt, d));
    }
    const cursor = decodeCursor(cursorStr);
    if (cursor) {
      conditions.push(
        timestampCursorWhere(
          schema.inventoryMovements.createdAt,
          schema.inventoryMovements.id,
          cursor,
        )!,
      );
    }
    const rows = await this.db
      .select({
        id: schema.inventoryMovements.id,
        variantId: schema.inventoryMovements.variantId,
        locationId: schema.inventoryMovements.locationId,
        delta: schema.inventoryMovements.delta,
        reason: schema.inventoryMovements.reason,
        referenceType: schema.inventoryMovements.referenceType,
        referenceId: schema.inventoryMovements.referenceId,
        actorUserId: schema.inventoryMovements.actorUserId,
        actorEmail: schema.users.email,
        notes: schema.inventoryMovements.notes,
        createdAt: schema.inventoryMovements.createdAt,
      })
      .from(schema.inventoryMovements)
      .leftJoin(schema.users, eq(schema.users.id, schema.inventoryMovements.actorUserId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(
        ...timestampCursorOrder(schema.inventoryMovements.createdAt, schema.inventoryMovements.id),
      )
      .limit(limit + 1);
    const enriched = rows.map((r) => ({ ...r, actorEmail: r.actorEmail ?? null }));
    return buildPage(enriched, limit, (r) => r.createdAt);
  }

  /**
   * Manual adjustment. Reason is one of: count_correction, damage, theft,
   * other. The delta can be negative (loss) but on_hand floors at 0.
   * Writes one inventory_movements row + upserts the inventory_levels row.
   */
  @Post('adjust')
  @RequirePermission('inventory.adjust')
  async adjust(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: AdjustBody,
  ): Promise<{ onHand: number; movementId: string }> {
    const { variantId, locationId, delta, reason } = body;
    if (!variantId) throw new BadRequestException('variantId is required');
    if (!locationId) throw new BadRequestException('locationId is required');
    if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) {
      throw new BadRequestException('delta must be a non-zero integer');
    }
    if (!reason || !ADJUST_REASONS.has(reason)) {
      throw new BadRequestException(`reason must be one of: ${[...ADJUST_REASONS].join(', ')}`);
    }
    if (body.unitCostCents !== undefined && body.unitCostCents !== null) {
      if (!Number.isInteger(body.unitCostCents) || body.unitCostCents < 0) {
        throw new BadRequestException('unitCostCents must be a non-negative integer');
      }
      if (delta < 0) {
        throw new BadRequestException('unitCostCents only applies to an upward adjustment');
      }
    }
    // A22: the coded reason (class `inventory_adjustment`) is validated
    // when given; the legacy bucket + free text stay the floor so a
    // business without codes of the class is never blocked.
    const coded = await this.overrides.resolveReason(
      'inventory_adjustment',
      { reasonCodeId: body.reasonCodeId, reason: body.notes },
      { required: false, codeOptional: true },
    );

    const result = await this.applyDelta(tenant, actor, {
      variantId,
      locationId,
      delta,
      reason,
      notes: body.notes ?? coded.reasonText ?? undefined,
      reasonCodeId: coded.reasonCodeId,
      unitCostCents: body.unitCostCents ?? null,
    });

    await this.audit.log({
      action: 'inventory.adjust',
      targetType: 'product_variant',
      targetId: variantId,
      metadata: {
        delta,
        reason,
        locationId,
        notes: body.notes ?? null,
        reasonCode: coded.reasonCode,
        unitCostCents: body.unitCostCents ?? null,
      },
    });

    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'inventory.adjusted',
      payload: {
        variantId,
        locationId,
        delta,
        reason,
        onHand: result.onHand,
        movementId: result.movementId,
      },
    });

    return result;
  }

  /**
   * A22 slice 3 (STORIS Stock Adjustment → Write-off): scrap units
   * straight out of sellable stock. Same rules as an As-Is scrap — its
   * own permission (override-able), a coded `write_off` reason, valued
   * at cost on the write-off register, an exception for the owner's
   * feed — plus the ledger movement that actually drops on hand. Only
   * available units can go: reserved and floor-sample units must be
   * released first, so a write-off never pulls a committed piece.
   */
  @Post('write-off')
  @RequirePermission('inventory.adjust')
  async writeOff(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: WriteOffBody,
  ): Promise<{ writeOffId: string; movementId: string; onHand: number; totalCostCents: number }> {
    const { variantId, locationId, quantity } = body;
    if (!variantId) throw new BadRequestException('variantId is required');
    if (!locationId) throw new BadRequestException('locationId is required');
    if (!Number.isInteger(quantity) || (quantity ?? 0) <= 0) {
      throw new BadRequestException('quantity must be a positive integer');
    }
    const [variant] = await this.db
      .select({ id: schema.productVariants.id, costCents: schema.productVariants.costCents })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId))
      .limit(1);
    if (!variant) throw new NotFoundException('Variant not found');
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
    const available = level ? level.onHand - level.reserved - level.floorSample : 0;
    if (available < quantity!) {
      throw new BadRequestException(
        `Only ${Math.max(0, available)} available unit(s) here — release reservations or the floor hold before writing off ${quantity}`,
      );
    }
    await this.overrides.require({
      permission: 'inventory.write_off',
      action: `Write off ${quantity} unit(s) from stock`,
      entityType: 'product_variant',
      entityId: variantId,
      override: body.override,
    });
    const reason = await this.overrides.resolveReason('write_off', {
      reasonCodeId: body.reasonCodeId ?? body.override?.reasonCodeId,
      reason: body.reason ?? body.override?.reason ?? body.notes,
    });
    const unitCost = variant.costCents ?? 0;
    const [row] = await this.db
      .insert(schema.writeOffs)
      .values({
        businessId: tenant.businessId!,
        variantId,
        locationId,
        quantity: quantity!,
        unitCostCents: unitCost,
        totalCostCents: unitCost * quantity!,
        reasonCodeId: reason.reasonCodeId,
        reason: reason.reasonText,
        actorUserId: actor.id,
      })
      .returning({ id: schema.writeOffs.id });
    if (!row) throw new BadRequestException('failed to record write-off');
    const result = await this.applyDelta(tenant, actor, {
      variantId,
      locationId,
      delta: -quantity!,
      reason: 'write_off',
      notes: body.notes ?? reason.reasonText ?? undefined,
      referenceType: 'write_off',
      referenceId: row.id,
      reasonCodeId: reason.reasonCodeId,
    });
    await this.exceptions.record({
      type: 'write_off',
      severity: 'warning',
      entityType: 'product_variant',
      entityId: variantId,
      summary: `${quantity} unit(s) written off from stock at cost $${((unitCost * quantity!) / 100).toFixed(2)}`,
      metadata: {
        variantId,
        locationId,
        quantity,
        totalCostCents: unitCost * quantity!,
        reasonCode: reason.reasonCode,
        reason: reason.reasonText,
        writeOffId: row.id,
      },
    });
    await this.audit.log({
      action: 'inventory.write_off',
      targetType: 'product_variant',
      targetId: variantId,
      metadata: {
        locationId,
        quantity,
        reasonCode: reason.reasonCode,
        reason: reason.reasonText,
        writeOffId: row.id,
        movementId: result.movementId,
      },
    });
    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'inventory.adjusted',
      payload: {
        variantId,
        locationId,
        delta: -quantity!,
        reason: 'write_off',
        onHand: result.onHand,
        movementId: result.movementId,
      },
    });
    return {
      writeOffId: row.id,
      movementId: result.movementId,
      onHand: result.onHand,
      totalCostCents: unitCost * quantity!,
    };
  }

  /**
   * A22 slice 3: the Stock Adjustment dialog's header strip and tab
   * data for one variant at one location — the same totals the product
   * page shows (on hand / reserved / floor / available / PO / as-is),
   * the pending as-is pieces here, the serials here, and the bins.
   */
  @Get('stock-card')
  @RequirePermission('inventory.view')
  async stockCard(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('variantId') variantId?: string,
    @Query('locationId') locationId?: string,
  ): Promise<StockCard> {
    if (!variantId || !locationId) {
      throw new BadRequestException('variantId and locationId are required');
    }
    const [variant] = await this.db
      .select({
        id: schema.productVariants.id,
        sku: schema.productVariants.sku,
        costCents: schema.productVariants.costCents,
        productId: schema.products.id,
        productName: schema.products.name,
        serialTracked: schema.products.serialTracked,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.id, variantId))
      .limit(1);
    if (!variant) throw new NotFoundException('Variant not found');
    const [location] = await this.db
      .select({ id: schema.locations.id, name: schema.locations.name })
      .from(schema.locations)
      .where(eq(schema.locations.id, locationId))
      .limit(1);
    if (!location) throw new NotFoundException('Location not found');

    const stock = await loadProductStockByLocation(this.db, tenant.businessId!, variant.productId);
    const row = stock.byLocation.find(
      (r) => r.variantId === variantId && r.locationId === locationId,
    );
    const totals: StockTotals = row ?? {
      onHand: 0,
      reserved: 0,
      floorSample: 0,
      available: 0,
      netOnPo: 0,
      totalPo: 0,
      asIsOnHand: 0,
      asIsAvailable: 0,
      asIsNonSellable: 0,
      layawayReserved: 0,
      onOrderReserved: 0,
    };
    const asIsSibling = variant.sku
      ? await this.db
          .select({ id: schema.productVariants.id })
          .from(schema.productVariants)
          .where(
            and(
              eq(schema.productVariants.businessId, tenant.businessId!),
              eq(schema.productVariants.sku, `${variant.sku}-AS`),
            ),
          )
          .limit(1)
      : [];
    const asIsPieces = await this.db
      .select({
        id: schema.asIsItems.id,
        pieceNumber: schema.asIsItems.pieceNumber,
        condition: schema.asIsItems.condition,
        storageLocation: schema.asIsItems.storageLocation,
        asIsPriceCents: schema.asIsItems.asIsPriceCents,
        source: schema.asIsItems.source,
        createdAt: schema.asIsItems.createdAt,
      })
      .from(schema.asIsItems)
      .where(
        and(
          eq(schema.asIsItems.variantId, variantId),
          eq(schema.asIsItems.locationId, locationId),
          eq(schema.asIsItems.status, 'pending_review'),
        ),
      )
      .orderBy(asc(schema.asIsItems.createdAt));
    const serials = variant.serialTracked
      ? await this.db
          .select({
            id: schema.serialUnits.id,
            serial: schema.serialUnits.serial,
            status: schema.serialUnits.status,
          })
          .from(schema.serialUnits)
          .where(
            and(
              eq(schema.serialUnits.variantId, variantId),
              eq(schema.serialUnits.locationId, locationId),
              inArray(schema.serialUnits.status, [
                'in_stock',
                'committed',
                'floor_sample',
                'returned',
              ]),
            ),
          )
          .orderBy(asc(schema.serialUnits.serial))
      : [];
    const bins = await this.db
      .select({ id: schema.storageBins.id, code: schema.storageBins.code })
      .from(schema.storageBins)
      .where(
        and(eq(schema.storageBins.locationId, locationId), eq(schema.storageBins.isActive, true)),
      )
      .orderBy(asc(schema.storageBins.code));
    return {
      ...totals,
      variantId,
      productId: variant.productId,
      productName: variant.productName,
      sku: variant.sku,
      serialTracked: variant.serialTracked,
      costCents: variant.costCents,
      locationId,
      locationName: location.name,
      storageBinId: row?.storageBinId ?? null,
      storageBinCode: row?.storageBinCode ?? null,
      asIsVariantId: asIsSibling[0]?.id ?? null,
      asIsPieces,
      serials,
      bins,
    };
  }

  /**
   * Receive a batch of variants at a location. Each line is positive.
   * Writes one inventory_movements row per line and upserts the matching
   * inventory_levels row. The whole batch lives inside the request's RLS
   * transaction, so a partial failure rolls back cleanly.
   */
  @Post('receive')
  @RequirePermission('inventory.receive')
  async receive(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: ReceiveBody,
  ): Promise<{
    locationId: string;
    lines: { variantId: string; quantity: number; onHand: number }[];
  }> {
    const { locationId } = body;
    if (!locationId) throw new BadRequestException('locationId is required');
    const lines = body.lines ?? [];
    if (lines.length === 0) throw new BadRequestException('lines must contain at least one entry');
    for (const l of lines) {
      if (!l.variantId) throw new BadRequestException('lines[].variantId is required');
      if (typeof l.quantity !== 'number' || !Number.isInteger(l.quantity) || l.quantity <= 0) {
        throw new BadRequestException('lines[].quantity must be a positive integer');
      }
    }

    const out: { variantId: string; quantity: number; onHand: number }[] = [];
    for (const l of lines) {
      const result = await this.applyDelta(tenant, actor, {
        variantId: l.variantId!,
        locationId,
        delta: l.quantity!,
        reason: 'receive',
        notes: body.notes,
      });
      out.push({ variantId: l.variantId!, quantity: l.quantity!, onHand: result.onHand });
    }

    await this.audit.log({
      action: 'inventory.receive',
      targetType: 'location',
      targetId: locationId,
      metadata: {
        lineCount: lines.length,
        totalUnits: lines.reduce((sum, l) => sum + (l.quantity ?? 0), 0),
        notes: body.notes ?? null,
      },
    });

    return { locationId, lines: out };
  }

  private async applyDelta(
    tenant: RequestTenantContext,
    actor: CurrentUserPayload,
    args: {
      variantId: string;
      locationId: string;
      delta: number;
      reason: string;
      notes?: string;
      referenceType?: string;
      referenceId?: string;
      reasonCodeId?: string | null;
      /** Cost an upward delta layers at; null → the variant's catalog cost. */
      unitCostCents?: number | null;
    },
  ): Promise<{ onHand: number; movementId: string }> {
    // Verify variant + location belong to the active business (RLS would
    // also catch cross-tenant attempts, but a friendly 404 beats a 0-row
    // result).
    const [variant] = await this.db
      .select({ id: schema.productVariants.id, costCents: schema.productVariants.costCents })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, args.variantId))
      .limit(1);
    if (!variant) throw new NotFoundException('Variant not found');
    const [location] = await this.db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(eq(schema.locations.id, args.locationId))
      .limit(1);
    if (!location) throw new NotFoundException('Location not found');

    // Append the ledger row.
    const [movement] = await this.db
      .insert(schema.inventoryMovements)
      .values({
        businessId: tenant.businessId!,
        variantId: args.variantId,
        locationId: args.locationId,
        delta: args.delta,
        reason: args.reason,
        referenceType: args.referenceType ?? null,
        referenceId: args.referenceId ?? null,
        reasonCodeId: args.reasonCodeId ?? null,
        actorUserId: actor.id,
        notes: args.notes ?? null,
      })
      .returning({ id: schema.inventoryMovements.id });
    if (!movement) throw new BadRequestException('failed to record movement');

    // FIFO: manual receipts and upward adjustments layer at the variant's
    // catalog cost; downward adjustments consume oldest-first.
    if (args.delta > 0) {
      await this.costing.addLayer(this.db, {
        businessId: tenant.businessId!,
        variantId: args.variantId,
        locationId: args.locationId,
        sourceType: args.reason === 'receive' ? 'receive' : 'adjustment',
        referenceId: null,
        quantity: args.delta,
        unitCostCents: args.unitCostCents ?? variant.costCents,
      });
    } else if (args.delta < 0) {
      await this.costing.consume(this.db, {
        businessId: tenant.businessId!,
        variantId: args.variantId,
        locationId: args.locationId,
        quantity: -args.delta,
        referenceType: args.referenceType ?? 'inventory_adjust',
        referenceId: args.referenceId ?? movement.id,
      });
    }

    // Upsert inventory_levels.on_hand. We GREATEST(0, ...) so we never
    // record a negative on_hand even if a careless adjustment overshoots.
    const [level] = await this.db
      .insert(schema.inventoryLevels)
      .values({
        businessId: tenant.businessId!,
        variantId: args.variantId,
        locationId: args.locationId,
        onHand: Math.max(0, args.delta),
      })
      .onConflictDoUpdate({
        target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
        set: {
          onHand: sql`GREATEST(0, ${schema.inventoryLevels.onHand} + ${args.delta})`,
          updatedAt: new Date(),
        },
      })
      .returning({ onHand: schema.inventoryLevels.onHand });
    if (!level) throw new BadRequestException('failed to update inventory level');

    return { onHand: level.onHand, movementId: movement.id };
  }
}
