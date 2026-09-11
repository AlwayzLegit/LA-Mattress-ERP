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
import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

interface SerialRow {
  id: string;
  variantId: string;
  locationId: string;
  serial: string;
  status: string;
  orderLineId: string | null;
  customerId: string | null;
}

/**
 * Serial units, lean edition (STORIS cutover G7): register serials as
 * they arrive, commit them to an order line at pick time, and let
 * fulfillment flip them to sold. Enough to answer "whose mattress is
 * this?" — full serial workflows (service loop, returns) build on it.
 */
@TenantScoped()
@Controller('v1/serials')
export class SerialsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('inventory.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('variantId') variantId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
    @Query('orderLineId') orderLineId?: string,
  ): Promise<SerialRow[]> {
    const filters = [];
    if (variantId) filters.push(eq(schema.serialUnits.variantId, variantId));
    if (locationId) filters.push(eq(schema.serialUnits.locationId, locationId));
    if (status) filters.push(eq(schema.serialUnits.status, status));
    if (orderLineId) filters.push(eq(schema.serialUnits.orderLineId, orderLineId));
    return this.db
      .select({
        id: schema.serialUnits.id,
        variantId: schema.serialUnits.variantId,
        locationId: schema.serialUnits.locationId,
        serial: schema.serialUnits.serial,
        status: schema.serialUnits.status,
        orderLineId: schema.serialUnits.orderLineId,
        customerId: schema.serialUnits.customerId,
      })
      .from(schema.serialUnits)
      .where(filters.length ? and(...filters) : undefined)
      .limit(500);
  }

  /** Register serials for units that just arrived (receiving dock). */
  @Post('register')
  @RequirePermission('inventory.receive')
  async register(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { variantId?: string; locationId?: string; serials?: string[] },
  ): Promise<SerialRow[]> {
    if (!body.variantId || !body.locationId) {
      throw new BadRequestException('variantId and locationId are required');
    }
    const serials = (body.serials ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (serials.length === 0) throw new BadRequestException('serials must be a non-empty list');
    if (new Set(serials).size !== serials.length) {
      throw new BadRequestException('serials contains duplicates');
    }
    const rows = await this.db
      .insert(schema.serialUnits)
      .values(
        serials.map((serial) => ({
          businessId: tenant.businessId!,
          variantId: body.variantId!,
          locationId: body.locationId!,
          serial,
        })),
      )
      .onConflictDoNothing()
      .returning();
    await this.audit.log({
      action: 'serials.register',
      targetType: 'product_variant',
      targetId: body.variantId,
      after: { count: rows.length, serials },
    });
    return rows as SerialRow[];
  }

  /**
   * A22 slice 3 (STORIS Stock Adjustment → Change Serial): correct a
   * mistyped serial on a unit that is still in the building. Sold and
   * in-service units keep the serial the customer's paperwork carries.
   */
  @Patch(':id')
  @RequirePermission('serials.manage')
  async rename(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { serial?: string },
  ): Promise<SerialRow> {
    const serial = body.serial?.trim();
    if (!serial) throw new BadRequestException('serial is required');
    if (serial.length > 80) throw new BadRequestException('serial must be 80 characters or fewer');
    const [unit] = await this.db
      .select()
      .from(schema.serialUnits)
      .where(eq(schema.serialUnits.id, id))
      .limit(1);
    if (!unit) throw new NotFoundException('Serial unit not found');
    if (
      !['in_stock', 'committed', 'floor_sample', 'returned', 'in_transit'].includes(unit.status)
    ) {
      throw new BadRequestException(`A ${unit.status} unit keeps its serial`);
    }
    if (serial === unit.serial) return unit as SerialRow;
    const [dup] = await this.db
      .select({ id: schema.serialUnits.id })
      .from(schema.serialUnits)
      .where(
        and(
          eq(schema.serialUnits.variantId, unit.variantId),
          eq(schema.serialUnits.serial, serial),
        ),
      )
      .limit(1);
    if (dup) throw new ConflictException(`Serial ${serial} already exists on this product`);
    const [row] = await this.db
      .update(schema.serialUnits)
      .set({ serial, updatedAt: new Date() })
      .where(eq(schema.serialUnits.id, id))
      .returning();
    await this.audit.log({
      action: 'serials.rename',
      targetType: 'serial_unit',
      targetId: id,
      before: { serial: unit.serial },
      after: { serial },
    });
    return row as SerialRow;
  }

  /**
   * Pick: commit specific serials to an order line. Count can't exceed
   * the line's quantity; only in-stock serials of the line's variant at
   * some location qualify.
   */
  @Post('assign/:orderLineId')
  @RequirePermission('deliveries.complete')
  async assign(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('orderLineId') orderLineId: string,
    @Body() body: { serialUnitIds?: string[] },
  ): Promise<SerialRow[]> {
    const ids = body.serialUnitIds ?? [];
    if (ids.length === 0) throw new BadRequestException('serialUnitIds must be non-empty');
    const [line] = await this.db
      .select({
        id: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        quantity: schema.orderLines.quantity,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.id, orderLineId))
      .limit(1);
    if (!line) throw new NotFoundException('Order line not found');

    const already = await this.db
      .select({ id: schema.serialUnits.id })
      .from(schema.serialUnits)
      .where(
        and(
          eq(schema.serialUnits.orderLineId, orderLineId),
          inArray(schema.serialUnits.status, ['committed', 'sold']),
        ),
      );
    if (already.length + ids.length > line.quantity) {
      throw new BadRequestException(
        `Line takes ${line.quantity} unit(s); ${already.length} already picked`,
      );
    }

    const targets = await this.db
      .select()
      .from(schema.serialUnits)
      .where(and(inArray(schema.serialUnits.id, ids), eq(schema.serialUnits.status, 'in_stock')));
    if (targets.length !== ids.length) {
      throw new BadRequestException('Every serial must exist and be in stock');
    }
    if (line.variantId && targets.some((t) => t.variantId !== line.variantId)) {
      throw new BadRequestException("A serial's variant must match the order line");
    }

    const rows = await this.db
      .update(schema.serialUnits)
      .set({ status: 'committed', orderLineId, updatedAt: new Date() })
      .where(inArray(schema.serialUnits.id, ids))
      .returning();
    await this.audit.log({
      action: 'serials.assign',
      targetType: 'order_line',
      targetId: orderLineId,
      after: { serialUnitIds: ids },
    });
    return rows as SerialRow[];
  }
}
