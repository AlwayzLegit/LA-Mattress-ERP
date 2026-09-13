import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { loadCategoryIndex } from '../catalog/category-tree';
import { AuditService } from '../audit/audit.service';
import {
  CurrentTenant,
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { generatePoNumber } from './po-number';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import {
  cuttingDateMessage,
  defaultFreightCents,
  loadLandedCost,
  pastCuttingDate,
  todayIso,
} from './vendor-settings';
import type { RequestTenantContext } from '../tenancy/request-context';
import {
  runReplenishment,
  resolveLeadDays,
  validateCriteria,
  ReplenishmentValidationError,
  type ReplenishmentRow,
  type RunCriteria,
} from './replenishment-engine';
import {
  buildReplenishmentInputs,
  controlFromOps,
  parseVendorReplenishment,
  type ReplenishmentCandidateMeta,
  type SalesRateReplenishmentOps,
  type VendorReplenishmentSettings,
} from './replenishment-data';

export interface ReplenishmentGridRow extends ReplenishmentRow, ReplenishmentCandidateMeta {}

interface RunBody {
  vendorId?: string;
  locationId?: string;
  variancePercent?: number | null;
  daysForReplenishment?: number | null;
  salesWindow?: 'this_year_prior' | 'last_year_subsequent';
  includeOverstocks?: boolean;
  includeServiceItems?: boolean;
  productIds?: string[] | null;
  categoryId?: string | null;
}

type CreatePoBody = RunBody & {
  /** Session-only buyer edits (T-32): recomputed rows + these overrides. */
  overrides?: { variantId?: string; orderQty?: number }[];
  notes?: string | null;
};

/**
 * The ONE run path every mode calls (T-31): load vendor doc + business
 * control, validate, build inputs, run the pure engine. The interactive
 * endpoint and the EOD job may differ ONLY in how they obtain a db
 * handle and the criteria defaults — never in calculation.
 */
@Injectable()
export class ReplenishmentRunService {
  async run(
    db: PostgresJsDatabase,
    opts: {
      vendorId: string;
      locationId: string;
      criteria: RunCriteria;
      today?: Date;
      businessId?: string;
    },
  ): Promise<{
    rows: ReplenishmentGridRow[];
    vendor: VendorReplenishmentSettings;
    control: ReturnType<typeof controlFromOps>;
  }> {
    const today = opts.today ?? new Date();
    const [vendorRow] = await db
      .select({
        id: schema.vendors.id,
        businessId: schema.vendors.businessId,
        replenishmentJson: schema.vendors.replenishmentJson,
        isActive: schema.vendors.isActive,
      })
      .from(schema.vendors)
      .where(
        and(
          eq(schema.vendors.id, opts.vendorId),
          opts.businessId ? eq(schema.vendors.businessId, opts.businessId) : undefined,
        ),
      )
      .limit(1);
    if (!vendorRow) throw new NotFoundException('Vendor not found');
    const vendor = parseVendorReplenishment(vendorRow.replenishmentJson);
    if (!vendor) {
      throw new BadRequestException(
        'Vendor has no replenishment settings — configure them first (PATCH …/vendors/:id/settings)',
      );
    }

    const [loc] = await db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.id, opts.locationId),
          eq(schema.locations.isActive, true),
          opts.businessId ? eq(schema.locations.businessId, opts.businessId) : undefined,
        ),
      )
      .limit(1);
    if (!loc) throw new NotFoundException('Location not found');

    const [biz] = await db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, vendorRow.businessId))
      .limit(1);
    const ops = (
      (biz?.opsSettingsJson ?? {}) as {
        salesRateReplenishment?: SalesRateReplenishmentOps | null;
      }
    ).salesRateReplenishment;
    const control = controlFromOps(ops ?? null);

    try {
      validateCriteria(opts.criteria, vendor);
    } catch (err) {
      if (err instanceof ReplenishmentValidationError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const { products, meta } = await buildReplenishmentInputs(db, {
      vendorId: opts.vendorId,
      warehouseLocationId: opts.locationId,
      vendor,
      criteria: opts.criteria,
      control,
      today,
      categoryId: (opts.criteria as { categoryId?: string | null }).categoryId ?? null,
      businessId: opts.businessId,
    });
    const rows = runReplenishment(products, vendor, control, opts.criteria).map((r) => ({
      ...r,
      ...(meta.get(r.variantId) ?? {
        variantId: r.variantId,
        productName: '(unknown)',
        variantName: null,
        sku: null,
        vendorSku: null,
        costCents: null,
        categoryName: null,
        categoryPath: null,
      }),
    }));
    // Advanced Vendor Settings → Sort Criteria (owner 2026-09-02).
    const key = (r: ReplenishmentGridRow): string => {
      switch (vendor.sortCriteria ?? 'vendor_model') {
        case 'product':
          return `${r.productName}\u0000${r.variantName ?? ''}`;
        case 'category':
        case 'group':
          return `${r.categoryPath ?? r.categoryName ?? '~'}\u0000${r.productName}\u0000${r.variantName ?? ''}`;
        default:
          return `${r.vendorSku ?? r.sku ?? '~'}\u0000${r.productName}`;
      }
    };
    rows.sort((a, b) => key(a).localeCompare(key(b)));
    return { rows, vendor, control };
  }

  /**
   * §5 PO creation from a finished run. Only qty > 0 lines are written;
   * Automatically Hold POs leaves the PO a draft (Jetnine's hold state,
   * T-28), otherwise it is placed immediately. Header expected date per
   * §5.1: vendor lead days (furthest line date, T-29) or today (T-30).
   */
  async createPurchaseOrder(
    db: PostgresJsDatabase,
    opts: {
      vendorId: string;
      locationId: string;
      criteria: RunCriteria;
      overrides?: Map<string, number>;
      notes?: string | null;
      actorUserId?: string | null;
      today?: Date;
      businessId?: string;
      audit?: AuditService;
    },
  ): Promise<{ poId: string; number: string; status: string; lineCount: number } | null> {
    const today = opts.today ?? new Date();
    const { rows, vendor } = await this.run(db, opts);

    const lines = rows
      .map((r) => ({
        ...r,
        orderQty: opts.overrides?.get(r.variantId) ?? r.orderQty,
      }))
      .filter((r) => r.orderQty > 0);
    if (lines.length === 0) return null;

    const businessId =
      opts.businessId ??
      (
        await db
          .select({ businessId: schema.vendors.businessId })
          .from(schema.vendors)
          .where(eq(schema.vendors.id, opts.vendorId))
          .limit(1)
      )[0]?.businessId;
    if (!businessId) throw new NotFoundException('Vendor not found');

    // §5.1 delivery dates. Jetnine PO lines carry no dates — the header
    // expected date takes the furthest-future lead-day date (T-29).
    let expectedAt: Date;
    if (vendor.defaultRequestedDate === 'today') {
      expectedAt = today;
    } else {
      // A22.1: a lead-day exception on the root category reaches the
      // subcategories, so resolve on the lineage, not the leaf id.
      const catByVariant = new Map<string, string[]>();
      const cats = await db
        .select({ id: schema.productVariants.id, categoryId: schema.products.categoryId })
        .from(schema.productVariants)
        .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .where(
          inArray(
            schema.productVariants.id,
            lines.map((l) => l.variantId),
          ),
        );
      const categoryIndex = await loadCategoryIndex(db, businessId);
      for (const c of cats) catByVariant.set(c.id, categoryIndex.lineageOf(c.categoryId));
      const maxLead = Math.max(
        ...lines.map((l) => resolveLeadDays(vendor, catByVariant.get(l.variantId) ?? null)),
      );
      expectedAt = new Date(today.getTime() + maxLead * 86_400_000);
    }

    // Advanced Vendor Settings → PO Cutting Date: a collection past its
    // cutting date never lands on an automatic PO.
    const cut = await pastCuttingDate(
      db,
      opts.vendorId,
      lines.map((l) => l.variantId),
      todayIso(),
    );
    if (cut.length > 0) {
      const cutIds = new Set(cut.map((c) => c.variantId));
      const kept = lines.filter((l) => !cutIds.has(l.variantId));
      if (kept.length === 0) return null;
      lines.splice(0, lines.length, ...kept);
    }

    const hold = vendor.automaticallyHoldPos;
    const number = await generatePoNumber(db, businessId);
    const subtotalCents = lines.reduce((s, l) => s + l.orderQty * (l.costCents ?? 0), 0);
    // Advanced Vendor Settings → Shipping: active landed-cost lines default
    // the PO's freight (landed cost lean, Q1).
    const freightCents = defaultFreightCents(
      await loadLandedCost(db, opts.vendorId),
      subtotalCents,
    );
    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        businessId,
        vendorId: opts.vendorId,
        locationId: opts.locationId,
        number,
        status: hold ? 'draft' : 'ordered',
        placedAt: hold ? null : new Date(),
        expectedAt,
        subtotalCents,
        freightCents,
        notes:
          opts.notes ??
          `Sales-rate replenishment${hold ? ' — held for review (vendor setting)' : ''}${
            cut.length ? ` — ${cuttingDateMessage(cut)}` : ''
          }`,
        createdByUserId: opts.actorUserId ?? null,
      })
      .returning();
    if (!po) throw new BadRequestException('failed to create purchase order');
    await db.insert(schema.purchaseOrderLines).values(
      lines.map((l) => ({
        businessId,
        purchaseOrderId: po.id,
        variantId: l.variantId,
        quantityOrdered: l.orderQty,
        unitCostCents: l.costCents ?? 0,
        lineTotalCents: l.orderQty * (l.costCents ?? 0),
      })),
    );
    await opts.audit?.log({
      action: 'purchase_order.create',
      targetType: 'purchase_order',
      targetId: po.id,
      after: {
        number,
        vendorId: opts.vendorId,
        status: po.status,
        subtotalCents,
        lineCount: lines.length,
        trigger: 'sales_rate_replenishment',
      },
      businessId,
    });
    return { poId: po.id, number, status: po.status, lineCount: lines.length };
  }
}

@TenantScoped()
@Controller('v1/purchasing/replenishment')
export class ReplenishmentController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReplenishmentRunService) private readonly runner: ReplenishmentRunService,
  ) {}

  @Get('vendors/:vendorId/settings')
  @RequirePermission('vendors.view')
  async getSettings(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('vendorId') vendorId: string,
  ): Promise<{ settings: VendorReplenishmentSettings | null }> {
    const [row] = await this.db
      .select({ replenishmentJson: schema.vendors.replenishmentJson })
      .from(schema.vendors)
      .where(eq(schema.vendors.id, vendorId))
      .limit(1);
    if (!row) throw new NotFoundException('Vendor not found');
    return { settings: parseVendorReplenishment(row.replenishmentJson) };
  }

  /**
   * Replace the vendor's replenishment document. Body `null`/`{enabled:
   * false}` clears it (vendor drops out of every run mode).
   */
  @Patch('vendors/:vendorId/settings')
  @RequirePermission('vendors.manage')
  async patchSettings(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('vendorId') vendorId: string,
    @Body() body: (Partial<VendorReplenishmentSettings> & { enabled?: boolean }) | null,
  ): Promise<{ settings: VendorReplenishmentSettings | null }> {
    const [existing] = await this.db
      .select({ replenishmentJson: schema.vendors.replenishmentJson, name: schema.vendors.name })
      .from(schema.vendors)
      .where(eq(schema.vendors.id, vendorId))
      .limit(1);
    if (!existing) throw new NotFoundException('Vendor not found');

    const before = parseVendorReplenishment(existing.replenishmentJson);
    let next: VendorReplenishmentSettings | null;
    if (body == null || body.enabled === false) {
      next = null;
    } else {
      const merged = { ...(before ?? {}), ...body };
      delete (merged as { enabled?: boolean }).enabled;
      next = parseVendorReplenishment(merged);
      this.validateSettings(next!);
    }

    await this.db
      .update(schema.vendors)
      .set({ replenishmentJson: next as never, updatedAt: new Date() })
      .where(eq(schema.vendors.id, vendorId));
    await this.audit.log({
      action: 'vendor.update',
      targetType: 'vendor',
      targetId: vendorId,
      before: { replenishment: before },
      after: { replenishment: next },
    });
    return { settings: next };
  }

  private validateSettings(s: VendorReplenishmentSettings): void {
    if (s.weeklySalesRateWeeks < 1 || s.weeklySalesRateWeeks > 156) {
      throw new BadRequestException('weeklySalesRateWeeks must be 1–156');
    }
    for (const [k, v] of [
      ['minimumStockDays', s.minimumStockDays],
      ['leadDays', s.leadDays],
    ] as const) {
      if (v < 0 || v > 999) throw new BadRequestException(`${k} must be 0–999`);
    }
    if (
      s.daysForReplenishment != null &&
      (s.daysForReplenishment < 0 || s.daysForReplenishment > 999)
    ) {
      throw new BadRequestException('daysForReplenishment must be 0–999 or null');
    }
    if (s.variancePercent < 0 || s.variancePercent > 999) {
      throw new BadRequestException('variancePercent must be 0–999');
    }
    if (s.minimumSalesRate < 0) {
      throw new BadRequestException('minimumSalesRate must be ≥ 0');
    }
    for (const [k, v] of [
      ['firstAverageUnitsPeriodWeeks', s.firstAverageUnitsPeriodWeeks],
      ['secondAverageUnitsPeriodWeeks', s.secondAverageUnitsPeriodWeeks],
    ] as const) {
      if (v != null && (v < 1 || v > 156)) throw new BadRequestException(`${k} must be 1–156`);
    }
    if (s.includeAllBackOrders && s.daysForReplenishment != null) {
      throw new BadRequestException(
        'daysForReplenishment cannot be set while includeAllBackOrders is on',
      );
    }
  }

  /** Criteria screen → Items-for-Replenishment grid (§4). */
  @Post('run')
  @RequirePermission('purchase_orders.view')
  async run(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Body() body: RunBody,
  ): Promise<{ generatedAt: string; rows: ReplenishmentGridRow[] }> {
    const { vendorId, locationId, criteria } = this.parseRun(body);
    const { rows } = await this.runner.run(this.db, { vendorId, locationId, criteria });
    return { generatedAt: new Date().toISOString(), rows };
  }

  /** §5 Create Purchase Order from the grid (with session overrides). */
  @Post('purchase-order')
  @RequirePermission('purchase_orders.create')
  async createPo(
    @CurrentTenant() _tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: CreatePoBody,
  ): Promise<{ poId: string; number: string; status: string; lineCount: number }> {
    const { vendorId, locationId, criteria } = this.parseRun(body);
    const overrides = new Map<string, number>();
    for (const o of body.overrides ?? []) {
      if (!o.variantId || typeof o.orderQty !== 'number' || !Number.isInteger(o.orderQty)) {
        throw new BadRequestException('overrides[] entries need variantId + integer orderQty');
      }
      overrides.set(o.variantId, o.orderQty);
    }
    const result = await this.runner.createPurchaseOrder(this.db, {
      vendorId,
      locationId,
      criteria,
      overrides,
      notes: body.notes ?? null,
      actorUserId: actor.id,
      audit: this.audit,
    });
    if (!result) {
      throw new BadRequestException('No lines with quantity to order — nothing to create');
    }
    return result;
  }

  private parseRun(body: RunBody): {
    vendorId: string;
    locationId: string;
    criteria: RunCriteria & { categoryId?: string | null };
  } {
    if (!body.vendorId) throw new BadRequestException('vendorId is required');
    if (!body.locationId) throw new BadRequestException('locationId is required');
    return {
      vendorId: body.vendorId,
      locationId: body.locationId,
      criteria: {
        variancePercent: body.variancePercent ?? null,
        daysForReplenishment: body.daysForReplenishment ?? null,
        salesWindow:
          body.salesWindow === 'last_year_subsequent' ? 'last_year_subsequent' : 'this_year_prior',
        includeOverstocks: body.includeOverstocks === true,
        includeServiceItems: body.includeServiceItems === true,
        productIds: body.productIds?.length ? body.productIds : null,
        categoryId: body.categoryId ?? null,
      },
    };
  }
}
