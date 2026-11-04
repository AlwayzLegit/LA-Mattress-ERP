import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
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
import { CostingService } from '../costing/costing.service';
import { ExceptionsService } from '../controls/exceptions.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

/**
 * Physical inventory (FAQ pack C1/B16, lean soft-freeze lifecycle).
 *
 * The freeze snapshots every stock level at one location; the store keeps
 * selling while counting. At post time each line's variance is
 * `counted − (frozen + post-freeze ledger delta)` — so a unit sold
 * mid-count neither hides shrink nor double-deducts. Posting writes
 * ordinary `physical_count` movements and flips the levels; reservations
 * are never touched — a shortage that undercuts a reservation registers
 * a critical exception for a human instead (the pack's commitment rule).
 */
interface CountLineOut {
  id: string;
  variantId: string;
  sku: string | null;
  productName: string;
  /** Owner 2026-11-04: the count walks the floor by brand, then group (category). */
  brandName: string | null;
  groupName: string | null;
  binCode: string | null;
  frozenQty: number;
  frozenReserved: number;
  postFreezeDelta: number;
  countedQty: number | null;
  variance: number | null;
  reasonCodeId: string | null;
  postedVariance: number | null;
}

@TenantScoped()
@Controller('v1/inventory/counts')
export class PhysicalCountsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(CostingService) private readonly costing: CostingService,
  ) {}

  @Get()
  @RequirePermission('inventory.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('locationId') locationId?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<
    PageResponse<{
      id: string;
      locationId: string;
      locationName: string;
      status: string;
      countDate: string;
      frozenAt: Date;
      postedAt: Date | null;
      lineCount: number;
      countedCount: number;
    }>
  > {
    const limit = clampLimit(limitStr);
    const filters: SQL[] = locationId ? [eq(schema.physicalCounts.locationId, locationId)] : [];
    const cursor = decodeCursor(cursorStr);
    if (cursor) {
      filters.push(
        timestampCursorWhere(schema.physicalCounts.frozenAt, schema.physicalCounts.id, cursor)!,
      );
    }
    const rows = await this.db
      .select({
        id: schema.physicalCounts.id,
        locationId: schema.physicalCounts.locationId,
        locationName: schema.locations.name,
        status: schema.physicalCounts.status,
        countDate: schema.physicalCounts.countDate,
        frozenAt: schema.physicalCounts.frozenAt,
        postedAt: schema.physicalCounts.postedAt,
        lineCount: sql<number>`(select count(*)::int from ${schema.physicalCountLines} l where l.count_id = ${schema.physicalCounts.id})`,
        countedCount: sql<number>`(select count(*)::int from ${schema.physicalCountLines} l where l.count_id = ${schema.physicalCounts.id} and l.counted_qty is not null)`,
      })
      .from(schema.physicalCounts)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.physicalCounts.locationId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(...timestampCursorOrder(schema.physicalCounts.frozenAt, schema.physicalCounts.id))
      .limit(limit + 1);
    return buildPage(rows, limit, (r) => r.frozenAt);
  }

  /**
   * Create + freeze in one step: snapshot every non-empty level at the
   * location. One live count per location at a time.
   */
  @Post()
  @RequirePermission('inventory.adjust')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: { locationId?: string; notes?: string | null },
  ): Promise<{ id: string; lineCount: number }> {
    if (!body.locationId) throw new BadRequestException('locationId is required');
    const [loc] = await this.db
      .select({ id: schema.locations.id, isActive: schema.locations.isActive })
      .from(schema.locations)
      .where(eq(schema.locations.id, body.locationId))
      .limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    if (!loc.isActive) throw new BadRequestException('Location is inactive');

    const [live] = await this.db
      .select({ id: schema.physicalCounts.id })
      .from(schema.physicalCounts)
      .where(
        and(
          eq(schema.physicalCounts.locationId, body.locationId),
          inArray(schema.physicalCounts.status, ['open', 'counting']),
        ),
      )
      .limit(1);
    if (live) {
      throw new ConflictException('A count is already in progress at this location');
    }

    const levels = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        onHand: schema.inventoryLevels.onHand,
        reserved: schema.inventoryLevels.reserved,
        storageBinId: schema.inventoryLevels.storageBinId,
      })
      .from(schema.inventoryLevels)
      .where(eq(schema.inventoryLevels.locationId, body.locationId));
    const snapshot = levels.filter((l) => l.onHand !== 0 || l.reserved !== 0);
    if (snapshot.length === 0) {
      throw new BadRequestException('No stock to count at this location');
    }

    const [count] = await this.db
      .insert(schema.physicalCounts)
      .values({
        businessId: tenant.businessId!,
        locationId: body.locationId,
        countDate: new Date().toISOString().slice(0, 10),
        createdByUserId: actor.id,
        notes: body.notes ?? null,
      })
      .returning();
    if (!count) throw new BadRequestException('failed to create count');

    await this.db.insert(schema.physicalCountLines).values(
      snapshot.map((l) => ({
        businessId: tenant.businessId!,
        countId: count.id,
        variantId: l.variantId,
        storageBinId: l.storageBinId ?? null,
        frozenQty: l.onHand,
        frozenReserved: l.reserved,
      })),
    );

    await this.audit.log({
      action: 'inventory.count.create',
      targetType: 'physical_count',
      targetId: count.id,
      after: { locationId: body.locationId, lineCount: snapshot.length },
    });
    return { id: count.id, lineCount: snapshot.length };
  }

  @Get(':id')
  @RequirePermission('inventory.view')
  async detail(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{
    id: string;
    locationId: string;
    locationName: string;
    status: string;
    countDate: string;
    frozenAt: Date;
    postedAt: Date | null;
    notes: string | null;
    lines: CountLineOut[];
  }> {
    const count = await this.load(id);
    const [loc] = await this.db
      .select({ name: schema.locations.name })
      .from(schema.locations)
      .where(eq(schema.locations.id, count.locationId))
      .limit(1);
    const lines = await this.lines(count);
    return {
      id: count.id,
      locationId: count.locationId,
      locationName: loc?.name ?? '',
      status: count.status,
      countDate: count.countDate,
      frozenAt: count.frozenAt,
      postedAt: count.postedAt,
      notes: count.notes,
      lines,
    };
  }

  /**
   * Batched count entry. A variant found on the floor that was not in the
   * snapshot gets a zero-frozen line — "found stock" is a real case.
   */
  @Post(':id/lines')
  @RequirePermission('inventory.adjust')
  async enterCounts(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { entries?: { variantId?: string; countedQty?: number }[] },
  ): Promise<{ updated: number }> {
    const count = await this.load(id);
    if (count.status !== 'open' && count.status !== 'counting') {
      throw new ConflictException(`Count is ${count.status}`);
    }
    const entries = body.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new BadRequestException('entries must be a non-empty array');
    }
    if (entries.length > 500) throw new BadRequestException('at most 500 entries per request');
    for (const e of entries) {
      if (!e || typeof e.variantId !== 'string' || e.variantId.length === 0) {
        throw new BadRequestException('every entry needs a variantId');
      }
      if (typeof e.countedQty !== 'number' || !Number.isInteger(e.countedQty) || e.countedQty < 0) {
        throw new BadRequestException('countedQty must be a non-negative integer');
      }
    }

    let updated = 0;
    for (const e of entries) {
      const res = await this.db
        .update(schema.physicalCountLines)
        .set({ countedQty: e.countedQty!, countedByUserId: actor.id, countedAt: new Date() })
        .where(
          and(
            eq(schema.physicalCountLines.countId, id),
            eq(schema.physicalCountLines.variantId, e.variantId!),
          ),
        )
        .returning({ id: schema.physicalCountLines.id });
      if (res.length === 0) {
        // Found stock: verify the variant exists, then add a zero-frozen line.
        const [variant] = await this.db
          .select({ id: schema.productVariants.id })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.id, e.variantId!))
          .limit(1);
        if (!variant) throw new NotFoundException(`Variant ${e.variantId} not found`);
        await this.db.insert(schema.physicalCountLines).values({
          businessId: tenant.businessId!,
          countId: id,
          variantId: e.variantId!,
          frozenQty: 0,
          frozenReserved: 0,
          countedQty: e.countedQty!,
          countedByUserId: actor.id,
          countedAt: new Date(),
        });
      }
      updated += 1;
    }
    if (count.status === 'open') {
      await this.db
        .update(schema.physicalCounts)
        .set({ status: 'counting' })
        .where(eq(schema.physicalCounts.id, id));
    }
    return { updated };
  }

  /**
   * Post accepted variances. Every counted line with a non-zero variance
   * needs a `physical_variance` reason code once codes exist for the
   * class (A9 transition rule); uncounted lines block unless explicitly
   * skipped. Variances become `physical_count` movements; a shortage that
   * undercuts reservations registers a critical exception and leaves the
   * reservation for a human.
   */
  @Post(':id/post')
  @RequirePermission('inventory.adjust')
  async post(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: {
      reasonCodeId?: string | null;
      lineReasons?: { lineId?: string; reasonCodeId?: string }[];
      skipUncounted?: boolean;
    },
  ): Promise<{ posted: number; skipped: number; varianceUnits: number }> {
    const count = await this.load(id);
    if (count.status !== 'open' && count.status !== 'counting') {
      throw new ConflictException(`Count is ${count.status}`);
    }
    const lines = await this.lines(count);
    const uncounted = lines.filter((l) => l.countedQty === null);
    if (uncounted.length > 0 && body.skipUncounted !== true) {
      throw new BadRequestException(
        `${uncounted.length} line(s) are uncounted — count them or pass skipUncounted:true to leave them unchanged`,
      );
    }

    const varying = lines.filter((l) => l.countedQty !== null && (l.variance ?? 0) !== 0);

    // A9: once the class has active codes, a coded reason is mandatory.
    const activeCodes = await this.db
      .select({ id: schema.reasonCodes.id })
      .from(schema.reasonCodes)
      .where(
        and(
          eq(schema.reasonCodes.usageClass, 'physical_variance'),
          eq(schema.reasonCodes.active, true),
        ),
      );
    const codeIds = new Set(activeCodes.map((c) => c.id));
    const perLine = new Map(
      (body.lineReasons ?? [])
        .filter((r) => r?.lineId && r.reasonCodeId)
        .map((r) => [r.lineId as string, r.reasonCodeId as string]),
    );
    const resolveReason = (lineId: string): string | null => {
      const chosen = perLine.get(lineId) ?? body.reasonCodeId ?? null;
      if (codeIds.size > 0) {
        if (!chosen || !codeIds.has(chosen)) return null;
      }
      return chosen;
    };
    if (codeIds.size > 0) {
      const missing = varying.filter((l) => resolveReason(l.id) === null);
      if (missing.length > 0) {
        throw new BadRequestException(
          `A physical_variance reason code is required on ${missing.length} variance line(s)`,
        );
      }
    }

    let varianceUnits = 0;
    for (const line of varying) {
      const variance = line.variance!;
      varianceUnits += Math.abs(variance);
      const reasonCodeId = resolveReason(line.id);

      await this.db.insert(schema.inventoryMovements).values({
        businessId: tenant.businessId!,
        variantId: line.variantId,
        locationId: count.locationId,
        delta: variance,
        reason: 'physical_count',
        referenceType: 'physical_count',
        referenceId: count.id,
        actorUserId: actor.id,
        notes: `counted ${line.countedQty}, expected ${line.frozenQty + line.postFreezeDelta}`,
      });
      // FIFO: overages layer at the variant's catalog cost; shortages
      // consume oldest-first (the shrink carries real cost).
      if (variance > 0) {
        const [pv] = await this.db
          .select({ costCents: schema.productVariants.costCents })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.id, line.variantId))
          .limit(1);
        await this.costing.addLayer(this.db, {
          businessId: tenant.businessId!,
          variantId: line.variantId,
          locationId: count.locationId,
          sourceType: 'physical_count',
          referenceId: count.id,
          quantity: variance,
          unitCostCents: pv?.costCents ?? null,
        });
      } else {
        await this.costing.consume(this.db, {
          businessId: tenant.businessId!,
          variantId: line.variantId,
          locationId: count.locationId,
          quantity: -variance,
          referenceType: 'physical_count',
          referenceId: count.id,
        });
      }
      const [level] = await this.db
        .update(schema.inventoryLevels)
        .set({
          onHand: sql`${schema.inventoryLevels.onHand} + ${variance}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.inventoryLevels.variantId, line.variantId),
            eq(schema.inventoryLevels.locationId, count.locationId),
          ),
        )
        .returning({
          onHand: schema.inventoryLevels.onHand,
          reserved: schema.inventoryLevels.reserved,
        });
      if (!level) {
        // Found stock for a variant with no level row yet.
        await this.db.insert(schema.inventoryLevels).values({
          businessId: tenant.businessId!,
          variantId: line.variantId,
          locationId: count.locationId,
          onHand: variance,
          reserved: 0,
        });
      } else if (level.onHand < level.reserved) {
        await this.exceptions.record({
          type: 'physical_commitment',
          severity: 'critical',
          entityType: 'physical_count',
          entityId: count.id,
          summary: `Count shortage on ${line.sku ?? line.variantId}: on hand ${level.onHand} < reserved ${level.reserved} — reservations left intact, reassign manually`,
          metadata: { variantId: line.variantId, onHand: level.onHand, reserved: level.reserved },
        });
      }
      await this.db
        .update(schema.physicalCountLines)
        .set({ postedVariance: variance, reasonCodeId })
        .where(eq(schema.physicalCountLines.id, line.id));
    }

    await this.db
      .update(schema.physicalCounts)
      .set({ status: 'posted', postedAt: new Date(), postedByUserId: actor.id })
      .where(eq(schema.physicalCounts.id, id));

    if (varying.length > 0) {
      await this.exceptions.record({
        type: 'physical_variance',
        severity: 'warning',
        entityType: 'physical_count',
        entityId: count.id,
        summary: `Physical count posted with ${varying.length} variance line(s), ${varianceUnits} unit(s)`,
        metadata: {
          locationId: count.locationId,
          lines: varying.map((l) => ({ variantId: l.variantId, variance: l.variance })),
        },
      });
    }
    await this.audit.log({
      action: 'inventory.count.post',
      targetType: 'physical_count',
      targetId: count.id,
      after: { posted: varying.length, skipped: uncounted.length, varianceUnits },
    });
    return { posted: varying.length, skipped: uncounted.length, varianceUnits };
  }

  @Post(':id/cancel')
  @RequirePermission('inventory.adjust')
  async cancel(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ cancelled: true }> {
    const count = await this.load(id);
    if (count.status !== 'open' && count.status !== 'counting') {
      throw new ConflictException(`Count is ${count.status}`);
    }
    await this.db
      .update(schema.physicalCounts)
      .set({ status: 'cancelled' })
      .where(eq(schema.physicalCounts.id, id));
    await this.audit.log({
      action: 'inventory.count.cancel',
      targetType: 'physical_count',
      targetId: id,
    });
    return { cancelled: true };
  }

  // -------------------------------------------------------------------

  private async load(id: string) {
    const [count] = await this.db
      .select()
      .from(schema.physicalCounts)
      .where(eq(schema.physicalCounts.id, id))
      .limit(1);
    if (!count) throw new NotFoundException('Count not found');
    return count;
  }

  private async lines(count: typeof schema.physicalCounts.$inferSelect): Promise<CountLineOut[]> {
    const rows = await this.db
      .select({
        id: schema.physicalCountLines.id,
        variantId: schema.physicalCountLines.variantId,
        sku: schema.productVariants.sku,
        productName: schema.products.name,
        brandName: schema.brands.name,
        groupName: schema.categories.name,
        binCode: schema.storageBins.code,
        frozenQty: schema.physicalCountLines.frozenQty,
        frozenReserved: schema.physicalCountLines.frozenReserved,
        countedQty: schema.physicalCountLines.countedQty,
        reasonCodeId: schema.physicalCountLines.reasonCodeId,
        postedVariance: schema.physicalCountLines.postedVariance,
      })
      .from(schema.physicalCountLines)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.physicalCountLines.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
      .leftJoin(
        schema.storageBins,
        eq(schema.storageBins.id, schema.physicalCountLines.storageBinId),
      )
      .where(eq(schema.physicalCountLines.countId, count.id))
      // Owner 2026-11-04: the sheet reads brand, then group, then the bin
      // walk and SKU — items without a brand or group close each run.
      .orderBy(
        sql`${schema.brands.name} ASC NULLS LAST`,
        sql`${schema.categories.name} ASC NULLS LAST`,
        sql`${schema.storageBins.code} ASC NULLS LAST`,
        asc(schema.productVariants.sku),
      );

    // Soft-freeze correction: ledger delta since the freeze, per variant.
    const deltas = await this.db
      .select({
        variantId: schema.inventoryMovements.variantId,
        delta: sql<number>`coalesce(sum(${schema.inventoryMovements.delta}), 0)::int`,
      })
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.locationId, count.locationId),
          gt(schema.inventoryMovements.createdAt, count.frozenAt),
          inArray(
            schema.inventoryMovements.variantId,
            rows.map((r) => r.variantId),
          ),
        ),
      )
      .groupBy(schema.inventoryMovements.variantId);
    const deltaByVariant = new Map(deltas.map((d) => [d.variantId, d.delta]));

    return rows.map((r) => {
      const postFreezeDelta =
        count.status === 'posted' || count.status === 'cancelled'
          ? 0
          : (deltaByVariant.get(r.variantId) ?? 0);
      return {
        ...r,
        postFreezeDelta,
        variance: r.countedQty === null ? null : r.countedQty - (r.frozenQty + postFreezeDelta),
      };
    });
  }
}
