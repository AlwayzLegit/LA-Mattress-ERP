import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { ExceptionsService } from '../controls/exceptions.service';
import { computeAutoTransferDate } from './auto-schedule';
import { reserveTransferOrigin } from './transfer-reservations';

export interface AutoTransferShortfall {
  variantId: string;
  quantity: number;
}

/**
 * Auto transfers (XFR-051/052/053, FAQ J4/J5). When a confirmed sales
 * order is short at its own location but another location holds free
 * stock, the system writes a DRAFT transfer (type 'auto') from the
 * best-stocked sister location, scheduled per the STORIS formula
 * (`autoScheduleDays + today + 1`, rolled to the destination's next
 * replenishment day). A person still reviews and ships it — generation
 * is automatic, release is manual, exactly as STORIS behaves.
 *
 * Gated by `ops.autoScheduleDays`: blank = feature off; zero is a valid
 * value (same-day + 1).
 */
@Injectable()
export class AutoTransfersService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
  ) {}

  async generateForShortfalls(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      orderId: string;
      orderNumber: string;
      locationId: string;
      shortfalls: readonly AutoTransferShortfall[];
      actorUserId: string | null;
    },
  ): Promise<{ created: number }> {
    if (args.shortfalls.length === 0) return { created: 0 };

    const [biz] = await db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, args.businessId))
      .limit(1);
    const ops = (biz?.opsSettingsJson ?? {}) as { autoScheduleDays?: number | null };
    const days = ops.autoScheduleDays;
    if (days == null || !Number.isInteger(days) || days < 0) return { created: 0 };

    // Need per variant, net of what open auto transfers for this order
    // already carry — confirming twice must not double-generate.
    const need = new Map<string, number>();
    for (const s of args.shortfalls) {
      if (s.quantity > 0) need.set(s.variantId, (need.get(s.variantId) ?? 0) + s.quantity);
    }
    const openAuto = await db
      .select({
        variantId: schema.stockTransferLines.variantId,
        quantity: sql<number>`coalesce(sum(${schema.stockTransferLines.quantityShipped}), 0)::int`,
      })
      .from(schema.stockTransferLines)
      .innerJoin(
        schema.stockTransfers,
        eq(schema.stockTransfers.id, schema.stockTransferLines.transferId),
      )
      .where(
        and(
          eq(schema.stockTransfers.orderId, args.orderId),
          eq(schema.stockTransfers.transferType, 'auto'),
          inArray(schema.stockTransfers.status, ['draft', 'in_transit']),
        ),
      )
      .groupBy(schema.stockTransferLines.variantId);
    for (const row of openAuto) {
      const remaining = (need.get(row.variantId) ?? 0) - row.quantity;
      if (remaining > 0) need.set(row.variantId, remaining);
      else need.delete(row.variantId);
    }
    if (need.size === 0) return { created: 0 };

    // XFR-053: schedule against the DESTINATION's replenishment days.
    const [dest] = await db
      .select({ replenishmentDaysJson: schema.locations.replenishmentDaysJson })
      .from(schema.locations)
      .where(eq(schema.locations.id, args.locationId))
      .limit(1);
    const allowedDays = (dest?.replenishmentDaysJson ?? null) as number[] | null;
    const scheduled = computeAutoTransferDate(new Date(), days, allowedDays);
    if (scheduled === null) {
      await this.exceptions.record({
        type: 'auto_transfer_skipped',
        severity: 'warning',
        entityType: 'order',
        entityId: args.orderId,
        summary: `Auto transfer for ${args.orderNumber} not generated — the destination has no replenishment days checked`,
        metadata: { locationId: args.locationId },
      });
      return { created: 0 };
    }
    const scheduledFor = scheduled.toISOString().slice(0, 10);

    // Free stock elsewhere, biggest pile first per variant.
    const sources = await db
      .select({
        variantId: schema.inventoryLevels.variantId,
        locationId: schema.inventoryLevels.locationId,
        free: sql<number>`${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample}`,
      })
      .from(schema.inventoryLevels)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
      .where(
        and(
          inArray(schema.inventoryLevels.variantId, [...need.keys()]),
          ne(schema.inventoryLevels.locationId, args.locationId),
          eq(schema.locations.isActive, true),
          sql`${schema.inventoryLevels.onHand} - ${schema.inventoryLevels.reserved} - ${schema.inventoryLevels.floorSample} > 0`,
        ),
      );

    // Pick one source per variant (largest free pile), then group the
    // picks by source so each source location becomes one transfer.
    const byVariant = new Map<string, { locationId: string; free: number }>();
    for (const s of sources) {
      const best = byVariant.get(s.variantId);
      if (!best || s.free > best.free) {
        byVariant.set(s.variantId, { locationId: s.locationId, free: s.free });
      }
    }
    const bySource = new Map<string, { variantId: string; quantity: number }[]>();
    for (const [variantId, qty] of need) {
      const pick = byVariant.get(variantId);
      if (!pick) continue; // nowhere holds free stock — stays Pending (B14 fills on receipt)
      const quantity = Math.min(qty, pick.free);
      const list = bySource.get(pick.locationId) ?? [];
      list.push({ variantId, quantity });
      bySource.set(pick.locationId, list);
    }
    if (bySource.size === 0) return { created: 0 };

    let created = 0;
    for (const [fromLocationId, lines] of bySource) {
      const number = await this.generateNumber(db, args.businessId);
      const [transfer] = await db
        .insert(schema.stockTransfers)
        .values({
          businessId: args.businessId,
          fromLocationId,
          toLocationId: args.locationId,
          number,
          status: 'draft',
          transferType: 'auto',
          scheduledFor,
          orderId: args.orderId,
          notes: `Auto transfer for ${args.orderNumber}`,
          createdByUserId: args.actorUserId,
        })
        .returning();
      if (!transfer) continue;
      await db.insert(schema.stockTransferLines).values(
        lines.map((l) => ({
          businessId: args.businessId,
          transferId: transfer.id,
          variantId: l.variantId,
          quantityShipped: l.quantity,
        })),
      );
      // A10: the auto transfer is open, so it holds the picked units at
      // the source — a second shortfall cannot claim the same pile.
      await reserveTransferOrigin(db, {
        businessId: args.businessId,
        actorUserId: args.actorUserId,
        transferId: transfer.id,
        fromLocationId,
        lines,
      });
      await this.audit.log({
        action: 'stock_transfer.auto_create',
        targetType: 'stock_transfer',
        targetId: transfer.id,
        after: {
          number,
          orderId: args.orderId,
          orderNumber: args.orderNumber,
          fromLocationId,
          toLocationId: args.locationId,
          scheduledFor,
          lineCount: lines.length,
        },
      });
      created += 1;
    }
    return { created };
  }

  /** Same ST-YYYY-NNNNNN sequence the manual transfer entry uses. */
  private async generateNumber(db: PostgresJsDatabase, businessId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.stockTransfers)
        .where(
          and(
            eq(schema.stockTransfers.businessId, businessId),
            sql`${schema.stockTransfers.number} LIKE ${`ST-${year}-%`}`,
          ),
        );
      const seq = (rows[0]?.count ?? 0) + 1 + attempt;
      const candidate = `ST-${year}-${String(seq).padStart(6, '0')}`;
      const [existing] = await db
        .select({ id: schema.stockTransfers.id })
        .from(schema.stockTransfers)
        .where(
          and(
            eq(schema.stockTransfers.businessId, businessId),
            eq(schema.stockTransfers.number, candidate),
          ),
        )
        .limit(1);
      if (!existing) return candidate;
    }
    return `ST-${year}-${Date.now().toString().slice(-6)}`;
  }
}
