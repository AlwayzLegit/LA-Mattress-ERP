import {
  BadRequestException,
  Body,
  ConflictException,
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
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

interface LocationRow {
  id: string;
  name: string;
  locationType: string;
  timezone: string;
  taxRateBps: number | null;
  addressJson: unknown;
  orderPrefix: string | null;
  replenishmentDays: number[] | null;
  isActive: boolean;
  createdAt: Date;
}

interface CreateBody {
  name?: string;
  /** Q2: 'store' (default) or 'warehouse'. */
  locationType?: string;
  timezone?: string;
  taxRateBps?: number | null;
  addressJson?: unknown;
  /** Store code for per-store order numbering, e.g. "WL" (1-4 A-Z). */
  orderPrefix?: string | null;
  /** J5: weekdays (0=Sun…6=Sat) that accept auto transfers; null = all. */
  replenishmentDays?: number[] | null;
}

interface UpdateBody extends CreateBody {
  isActive?: boolean;
}

/** J5: null = every day; [] deliberately disables auto transfers in. */
function validateReplenishmentDays(raw: number[] | null): number[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new BadRequestException(
      'replenishmentDays must be weekday numbers 0 (Sun) through 6 (Sat)',
    );
  }
  return [...new Set(raw)].sort();
}

function validateLocationType(raw: string): 'store' | 'warehouse' {
  const type = raw.trim().toLowerCase();
  if (type !== 'store' && type !== 'warehouse') {
    throw new BadRequestException("locationType must be 'store' or 'warehouse'");
  }
  return type;
}

function normalizeOrderPrefix(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === '') return null;
  const prefix = raw.trim().toUpperCase();
  if (!/^[A-Z]{1,4}$/.test(prefix)) {
    throw new BadRequestException('orderPrefix must be 1-4 letters, e.g. "WL"');
  }
  return prefix;
}

/**
 * A timezone is only usable if the runtime's Intl database knows it —
 * everything downstream (close-of-day, Z-report bucketing) formats
 * through Intl, so this is the exact definition of "valid" we need.
 */
function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new BadRequestException(
      `invalid timezone "${timezone}" — use an IANA name like America/Los_Angeles`,
    );
  }
}

@TenantScoped()
@Controller('v1/business/locations')
export class LocationsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('locations.view')
  async list(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<LocationRow[]> {
    return this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        locationType: schema.locations.locationType,
        timezone: schema.locations.timezone,
        taxRateBps: schema.locations.taxRateBps,
        addressJson: schema.locations.addressJson,
        orderPrefix: schema.locations.orderPrefix,
        replenishmentDays: sql<number[] | null>`${schema.locations.replenishmentDaysJson}`.as(
          'replenishment_days',
        ),
        isActive: schema.locations.isActive,
        createdAt: schema.locations.createdAt,
      })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.businessId, tenant.businessId!),
          includeInactive === 'true' ? undefined : eq(schema.locations.isActive, true),
        ),
      )
      .orderBy(asc(schema.locations.name));
  }

  @Post()
  @RequirePermission('locations.create')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: CreateBody,
  ): Promise<LocationRow> {
    const name = body.name?.trim();
    const timezone = body.timezone?.trim();
    if (!name) throw new BadRequestException('name is required');
    if (!timezone) throw new BadRequestException('timezone is required');
    assertValidTimezone(timezone);
    if (body.taxRateBps != null && (!Number.isInteger(body.taxRateBps) || body.taxRateBps < 0)) {
      throw new BadRequestException('taxRateBps must be a non-negative integer');
    }
    const [row] = await this.db
      .insert(schema.locations)
      .values({
        businessId: tenant.businessId!,
        name,
        locationType:
          body.locationType === undefined ? 'store' : validateLocationType(body.locationType),
        timezone,
        taxRateBps: body.taxRateBps ?? null,
        addressJson: (body.addressJson ?? null) as never,
        orderPrefix: normalizeOrderPrefix(body.orderPrefix),
      })
      .returning();
    if (!row) throw new BadRequestException('failed to create location');
    await this.audit.log({
      action: 'location.create',
      targetType: 'location',
      targetId: row.id,
      after: { name, timezone, locationType: row.locationType, taxRateBps: row.taxRateBps },
    });
    return toRow(row);
  }

  @Patch(':id')
  @RequirePermission('locations.update')
  async update(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: UpdateBody,
  ): Promise<LocationRow> {
    const [existing] = await this.db
      .select()
      .from(schema.locations)
      .where(and(eq(schema.locations.id, id), eq(schema.locations.businessId, tenant.businessId!)))
      .limit(1);
    if (!existing) throw new NotFoundException('Location not found');

    const update: Partial<typeof schema.locations.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (body.name !== undefined && body.name.trim() !== existing.name) {
      update.name = body.name.trim();
      before.name = existing.name;
      after.name = update.name;
    }
    if (body.locationType !== undefined) {
      const type = validateLocationType(body.locationType);
      if (type !== existing.locationType) {
        update.locationType = type;
        before.locationType = existing.locationType;
        after.locationType = type;
      }
    }
    if (body.timezone !== undefined && body.timezone.trim() !== existing.timezone) {
      assertValidTimezone(body.timezone.trim());
      update.timezone = body.timezone.trim();
      before.timezone = existing.timezone;
      after.timezone = update.timezone;
    }
    if (body.taxRateBps !== undefined && body.taxRateBps !== existing.taxRateBps) {
      if (body.taxRateBps !== null && (!Number.isInteger(body.taxRateBps) || body.taxRateBps < 0)) {
        throw new BadRequestException('taxRateBps must be null or a non-negative integer');
      }
      update.taxRateBps = body.taxRateBps;
      before.taxRateBps = existing.taxRateBps;
      after.taxRateBps = body.taxRateBps;
    }
    if (body.addressJson !== undefined) {
      update.addressJson = body.addressJson as never;
      before.addressJson = existing.addressJson;
      after.addressJson = body.addressJson;
    }
    if (body.replenishmentDays !== undefined) {
      update.replenishmentDaysJson = validateReplenishmentDays(body.replenishmentDays) as never;
      before.replenishmentDays = existing.replenishmentDaysJson;
      after.replenishmentDays = update.replenishmentDaysJson;
    }
    if (body.orderPrefix !== undefined) {
      const prefix = normalizeOrderPrefix(body.orderPrefix);
      if (prefix !== existing.orderPrefix) {
        update.orderPrefix = prefix;
        before.orderPrefix = existing.orderPrefix;
        after.orderPrefix = prefix;
      }
    }
    if (body.isActive !== undefined && body.isActive !== existing.isActive) {
      update.isActive = body.isActive;
      before.isActive = existing.isActive;
      after.isActive = body.isActive;
    }

    if (Object.keys(after).length === 0) return toRow(existing);

    const [updated] = await this.db
      .update(schema.locations)
      .set(update)
      .where(eq(schema.locations.id, id))
      .returning();
    if (!updated) throw new NotFoundException('Location not found after update');

    await this.audit.log({
      action: 'location.update',
      targetType: 'location',
      targetId: updated.id,
      before,
      after,
    });

    return toRow(updated);
  }

  /**
   * Hard delete, for mistake records only. Two guards: the location must
   * already be deactivated (forces a deliberate two-step), and nothing may
   * reference it. The reference check is explicit rather than relying on FK
   * errors because several FKs cascade (inventory levels/movements, tax
   * rates, membership scopes) — a bare DELETE would silently take that data
   * with it instead of failing.
   */
  @Delete(':id')
  @RequirePermission('locations.delete')
  async remove(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ deleted: true }> {
    const [existing] = await this.db
      .select()
      .from(schema.locations)
      .where(and(eq(schema.locations.id, id), eq(schema.locations.businessId, tenant.businessId!)))
      .limit(1);
    if (!existing) throw new NotFoundException('Location not found');
    if (existing.isActive) {
      throw new BadRequestException('Deactivate the location before deleting it');
    }

    const referencedBy: string[] = [];
    for (const { label, exists } of await this.locationReferences(id)) {
      if (exists) referencedBy.push(label);
    }
    if (referencedBy.length > 0) {
      throw new ConflictException(
        `Location has history and cannot be deleted (referenced by: ${referencedBy.join(', ')}). Keep it deactivated instead.`,
      );
    }

    await this.db.delete(schema.locations).where(eq(schema.locations.id, id));
    await this.audit.log({
      action: 'location.delete',
      targetType: 'location',
      targetId: existing.id,
      before: { name: existing.name, timezone: existing.timezone, isActive: existing.isActive },
    });
    return { deleted: true };
  }

  /** One existence probe per table that carries a location FK. */
  private async locationReferences(locationId: string) {
    const probe = async (label: string, table: PgTable, ...columns: PgColumn[]) => {
      for (const column of columns) {
        const rows = await this.db
          .select({ one: sql`1` })
          .from(table)
          .where(eq(column, locationId))
          .limit(1);
        if (rows.length > 0) return { label, exists: true };
      }
      return { label, exists: false };
    };
    return Promise.all([
      probe('inventory levels', schema.inventoryLevels, schema.inventoryLevels.locationId),
      probe('inventory movements', schema.inventoryMovements, schema.inventoryMovements.locationId),
      probe('serial units', schema.serialUnits, schema.serialUnits.locationId),
      probe('cash shifts', schema.cashShifts, schema.cashShifts.locationId),
      probe('sales', schema.sales, schema.sales.locationId),
      probe('orders', schema.orders, schema.orders.locationId),
      probe('deliveries', schema.deliveries, schema.deliveries.locationId),
      probe('service orders', schema.serviceOrders, schema.serviceOrders.locationId),
      probe('purchase orders', schema.purchaseOrders, schema.purchaseOrders.locationId),
      probe(
        'stock transfers',
        schema.stockTransfers,
        schema.stockTransfers.fromLocationId,
        schema.stockTransfers.toLocationId,
      ),
      probe(
        'staff location scopes',
        schema.membershipLocationScopes,
        schema.membershipLocationScopes.locationId,
      ),
      probe('tax class rates', schema.taxClassRates, schema.taxClassRates.locationId),
    ]);
  }
}

function toRow(row: typeof schema.locations.$inferSelect): LocationRow {
  return {
    id: row.id,
    name: row.name,
    locationType: row.locationType,
    timezone: row.timezone,
    taxRateBps: row.taxRateBps ?? null,
    addressJson: row.addressJson,
    orderPrefix: row.orderPrefix ?? null,
    replenishmentDays: (row.replenishmentDaysJson as number[] | null) ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}
