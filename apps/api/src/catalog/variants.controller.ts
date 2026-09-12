import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { buildPage, clampLimit, decodeCursor, type PageResponse } from '../common/pagination';
import { FIRMNESS_LEVELS, MATTRESS_SIZES, normalizeFirmness, normalizeSize } from '@jetnine/shared';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { deriveVariantSizing, validateVariants } from './products.controller';

interface UpdateVariantBody {
  sku?: string | null;
  name?: string | null;
  priceCents?: number;
  costCents?: number | null;
  barcode?: string | null;
  attributesJson?: Record<string, unknown> | null;
  /** A22.2: canonical size / firmness (any spelling accepted), null to clear. */
  size?: string | null;
  firmness?: string | null;
  isActive?: boolean;
}

@TenantScoped()
@Controller('v1/products')
export class VariantsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Flat variant work-list for the bulk price editor. Cursor-paginated by
   * SKU (id tiebreaker) so a stable walk covers the whole catalog;
   * `unpricedOnly=1` narrows to active variants still at $0 — the state
   * every STORIS-imported variant lands in under D12. `unpricedCount` is
   * the remaining-work counter regardless of the current filter.
   */
  @Get('variants/pricing')
  @RequirePermission('products.view')
  async pricingList(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('q') q?: string,
    @Query('unpricedOnly') unpricedOnly?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<
    PageResponse<{
      id: string;
      sku: string | null;
      name: string | null;
      productId: string;
      productName: string;
      priceCents: number;
      costCents: number | null;
      vendorSku: string | null;
    }> & { unpricedCount: number }
  > {
    const limit = clampLimit(limitStr);
    const skuExpr = sql`coalesce(${schema.productVariants.sku}, '')`;
    const activeOnly = and(
      eq(schema.productVariants.isActive, true),
      eq(schema.products.isActive, true),
    )!;
    const filters = [activeOnly];
    if (unpricedOnly === '1' || unpricedOnly === 'true') {
      filters.push(eq(schema.productVariants.priceCents, 0));
    }
    if (q && q.trim().length > 0) {
      const tsq = sql`websearch_to_tsquery('simple', ${q})`;
      filters.push(
        sql`(${schema.productVariants.searchTsv} @@ ${tsq}
             OR ${schema.products.searchTsv} @@ ${tsq})`,
      );
    }
    const cursor = decodeCursor(cursorStr);
    if (cursor) {
      filters.push(
        or(
          gt(skuExpr, cursor.v as string),
          and(sql`${skuExpr} = ${cursor.v as string}`, gt(schema.productVariants.id, cursor.id)),
        )!,
      );
    }

    const canSeeCost = tenant.isSuperAdmin || tenant.permissions.has('products.cost.view');
    const rows = await this.db
      .select({
        id: schema.productVariants.id,
        sku: schema.productVariants.sku,
        name: schema.productVariants.name,
        productId: schema.products.id,
        productName: schema.products.name,
        priceCents: schema.productVariants.priceCents,
        costCents: schema.productVariants.costCents,
        vendorSku: schema.productVariants.vendorSku,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
      .where(and(...filters))
      .orderBy(asc(skuExpr), asc(schema.productVariants.id))
      .limit(limit + 1);

    const [{ count: unpricedCount }] = (await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
      .where(and(activeOnly, eq(schema.productVariants.priceCents, 0)))) as [{ count: number }];

    const page = buildPage(
      rows.map((r) => ({ ...r, costCents: canSeeCost ? (r.costCents ?? null) : null })),
      limit,
      (r) => r.sku ?? '',
    );
    return { ...page, unpricedCount };
  }

  /**
   * Batched price entry for the pricing page. Each item audits exactly like
   * the single-variant price PATCH so the change history stays field-level;
   * unchanged prices are skipped. The whole request runs on the tenant's
   * RLS transaction, so a mid-batch failure rolls everything back.
   */
  @Post('variants/bulk-price')
  @RequirePermission('products.update')
  async bulkPrice(
    @Body() body: { updates?: { id?: string; priceCents?: number }[] },
  ): Promise<{ updated: number; unchanged: number }> {
    const updates = body.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new BadRequestException('updates must be a non-empty array');
    }
    if (updates.length > 200) {
      throw new BadRequestException('at most 200 price updates per request');
    }
    for (const u of updates) {
      if (!u || typeof u.id !== 'string' || u.id.length === 0) {
        throw new BadRequestException('every update needs a variant id');
      }
      if (typeof u.priceCents !== 'number' || !Number.isInteger(u.priceCents) || u.priceCents < 0) {
        throw new BadRequestException('priceCents must be a non-negative integer');
      }
    }
    const ids = updates.map((u) => u.id!);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('duplicate variant ids in updates');
    }

    const existing = await this.db
      .select({ id: schema.productVariants.id, priceCents: schema.productVariants.priceCents })
      .from(schema.productVariants)
      .where(inArray(schema.productVariants.id, ids));
    const beforeById = new Map(existing.map((r) => [r.id, r.priceCents]));
    const missing = ids.filter((id) => !beforeById.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        `Variant(s) not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`,
      );
    }

    let updated = 0;
    for (const u of updates) {
      const before = beforeById.get(u.id!)!;
      if (before === u.priceCents) continue;
      await this.db
        .update(schema.productVariants)
        .set({ priceCents: u.priceCents })
        .where(eq(schema.productVariants.id, u.id!));
      await this.audit.log({
        action: 'product.variant.price.update',
        targetType: 'product_variant',
        targetId: u.id!,
        before: { priceCents: before },
        after: { priceCents: u.priceCents },
      });
      updated += 1;
    }
    return { updated, unchanged: updates.length - updated };
  }

  @Post(':productId/variants')
  @RequirePermission('products.update')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('productId') productId: string,
    @Body()
    body: {
      sku?: string;
      name?: string;
      priceCents?: number;
      costCents?: number | null;
      barcode?: string | null;
      attributesJson?: Record<string, unknown> | null;
      size?: string | null;
      firmness?: string | null;
    },
  ) {
    if (typeof body.priceCents !== 'number') {
      throw new BadRequestException('priceCents is required');
    }
    const [product] = await this.db
      .select({ name: schema.products.name })
      .from(schema.products)
      .where(eq(schema.products.id, productId))
      .limit(1);
    if (!product) throw new NotFoundException('Product not found');
    validateVariants([
      {
        priceCents: body.priceCents,
        costCents: body.costCents ?? null,
      },
    ]);
    const [variant] = await this.db
      .insert(schema.productVariants)
      .values({
        businessId: tenant.businessId!,
        productId,
        sku: body.sku ?? null,
        name: body.name ?? null,
        priceCents: body.priceCents,
        costCents: body.costCents ?? null,
        barcode: body.barcode ?? null,
        attributesJson: (body.attributesJson ?? null) as never,
        ...deriveVariantSizing(body, product.name),
      })
      .returning();
    if (!variant) throw new BadRequestException('failed to create variant');
    await this.audit.log({
      action: 'product.variant.create',
      targetType: 'product_variant',
      targetId: variant.id,
      after: { sku: variant.sku, priceCents: variant.priceCents, productId },
    });
    return variant;
  }

  @Patch('variants/:id')
  @RequirePermission('products.update')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateVariantBody,
  ): Promise<{ updated: true }> {
    const [existing] = await this.db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Variant not found');

    if (body.priceCents !== undefined) {
      validateVariants([{ priceCents: body.priceCents, costCents: body.costCents ?? null }]);
    }

    const update: Partial<typeof schema.productVariants.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const key of ['sku', 'name', 'priceCents', 'costCents', 'barcode', 'isActive'] as const) {
      const v = body[key as keyof UpdateVariantBody];
      if (v !== undefined && v !== existing[key]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (update as any)[key] = v;
        before[key] = existing[key];
        after[key] = v;
      }
    }
    if (body.attributesJson !== undefined) {
      update.attributesJson = body.attributesJson as never;
      before.attributesJson = existing.attributesJson;
      after.attributesJson = body.attributesJson;
    }
    if (body.size !== undefined) {
      const size = body.size === null || body.size === '' ? null : normalizeSize(body.size);
      if (body.size && !size) {
        throw new BadRequestException(`size must be one of: ${MATTRESS_SIZES.join(', ')}`);
      }
      if (size !== existing.size) {
        update.size = size;
        before.size = existing.size;
        after.size = size;
      }
    }
    if (body.firmness !== undefined) {
      const firmness =
        body.firmness === null || body.firmness === '' ? null : normalizeFirmness(body.firmness);
      if (body.firmness && !firmness) {
        throw new BadRequestException(`firmness must be one of: ${FIRMNESS_LEVELS.join(', ')}`);
      }
      if (firmness !== existing.firmness) {
        update.firmness = firmness;
        before.firmness = existing.firmness;
        after.firmness = firmness;
      }
    }

    if (Object.keys(after).length === 0) return { updated: true };

    await this.db
      .update(schema.productVariants)
      .set(update)
      .where(eq(schema.productVariants.id, id));
    await this.audit.log({
      action: 'product.variant.update',
      targetType: 'product_variant',
      targetId: id,
      before,
      after,
    });
    return { updated: true };
  }

  /**
   * Backwards-compatible price-only PATCH retained for Epic 1.3/1.4 tests
   * and the audit-log demo. PATCH /variants/:id is the general update;
   * this endpoint stays narrowly scoped for consumers that only need to
   * touch price.
   */
  @Patch('variants/:id/price')
  @RequirePermission('products.update')
  async updatePrice(
    @Param('id') id: string,
    @Body('priceCents') priceCents: number | undefined,
  ): Promise<{
    id: string;
    sku: string | null;
    name: string | null;
    priceCents: number;
  }> {
    if (typeof priceCents !== 'number' || priceCents < 0 || !Number.isInteger(priceCents)) {
      throw new BadRequestException('priceCents must be a non-negative integer');
    }
    const [existing] = await this.db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Variant not found');
    const [updated] = await this.db
      .update(schema.productVariants)
      .set({ priceCents })
      .where(eq(schema.productVariants.id, id))
      .returning();
    if (!updated) throw new NotFoundException('Variant not found after update');
    await this.audit.log({
      action: 'product.variant.price.update',
      targetType: 'product_variant',
      targetId: updated.id,
      before: { priceCents: existing.priceCents },
      after: { priceCents: updated.priceCents },
    });
    return {
      id: updated.id,
      sku: updated.sku,
      name: updated.name,
      priceCents: updated.priceCents,
    };
  }

  @Delete('variants/:id')
  @RequirePermission('products.update')
  async deactivate(@Param('id') id: string): Promise<{ deactivated: true }> {
    const [existing] = await this.db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Variant not found');
    if (!existing.isActive) return { deactivated: true };
    await this.db
      .update(schema.productVariants)
      .set({ isActive: false })
      .where(eq(schema.productVariants.id, id));
    await this.audit.log({
      action: 'product.variant.deactivate',
      targetType: 'product_variant',
      targetId: id,
      before: { isActive: true },
      after: { isActive: false },
    });
    return { deactivated: true };
  }
}
