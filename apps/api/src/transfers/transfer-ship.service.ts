import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../costing/costing.service';
import { DRIZZLE } from '../database/database.module';
import { shipPieces } from '../returns/as-is-pieces';

/** Ops gates for transfers (Q2/Q3, owner 2026-08-28). Null = default. */
export interface TransferOps {
  storeToStore?: boolean | null;
  requireTicketBeforeShip?: boolean | null;
}

/**
 * The ONE ship path for stock transfers: the `/ship` endpoint, the
 * create-with-`ship:true` shortcut, and manifest Complete (Q1) all move
 * inventory through here, so the Q3 print gate, the negative-stock
 * refusal, FIFO consumption, and serial flagging can never diverge.
 */
@Injectable()
export class TransferShipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CostingService) private readonly costing: CostingService,
  ) {}

  async transferOps(businessId: string): Promise<TransferOps> {
    const [biz] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return ((biz?.opsSettingsJson ?? {}) as { transfers?: TransferOps | null }).transfers ?? {};
  }

  /**
   * Ship a draft transfer end to end. Throws the same HTTP errors the
   * `/ship` endpoint always has; `ops` can be passed in when the caller
   * already loaded it (manifest completion ships in a loop).
   */
  async ship(
    businessId: string,
    actorId: string,
    transferId: string,
    notes: string | null,
    ops?: TransferOps,
    viaManifest = false,
  ): Promise<void> {
    const [transfer] = await this.db
      .select()
      .from(schema.stockTransfers)
      .where(eq(schema.stockTransfers.id, transferId))
      .limit(1);
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status !== 'draft') {
      throw new ForbiddenException(`Cannot ship a ${transfer.status} transfer`);
    }
    // F177 (lean): a manifested transfer belongs to its truck run — it
    // ships through the manifest's Complete, or gets removed first.
    if (transfer.manifestId !== null && !viaManifest) {
      throw new BadRequestException(
        'This transfer is on a manifest — complete the manifest, or remove the transfer from it first.',
      );
    }
    const gates = ops ?? (await this.transferOps(businessId));
    if (gates.requireTicketBeforeShip !== false && transfer.ticketPrintedAt === null) {
      throw new BadRequestException(
        `Print the transfer ticket before shipping (ops.transfers.requireTicketBeforeShip) — transfer ${transfer.number}.`,
      );
    }

    const lines = await this.db
      .select()
      .from(schema.stockTransferLines)
      .where(eq(schema.stockTransferLines.transferId, transferId));

    // Owner 2026-10-30: as-is lines ride on their piece, not the level.
    const stockLines = lines.filter((l) => !l.asIsItemId);

    // Snapshot origin levels and refuse if any line would go negative.
    const variantIds = stockLines.map((l) => l.variantId);
    const originLevels = await this.db
      .select({
        variantId: schema.inventoryLevels.variantId,
        onHand: schema.inventoryLevels.onHand,
      })
      .from(schema.inventoryLevels)
      .where(
        and(
          eq(schema.inventoryLevels.locationId, transfer.fromLocationId),
          inArray(schema.inventoryLevels.variantId, variantIds),
        ),
      );
    const onHandByVariant = new Map(originLevels.map((r) => [r.variantId, r.onHand]));
    for (const l of stockLines) {
      const onHand = onHandByVariant.get(l.variantId) ?? 0;
      if (onHand < l.quantityShipped) {
        throw new BadRequestException(
          `Insufficient stock for variant ${l.variantId} at origin: have ${onHand}, need ${l.quantityShipped}.`,
        );
      }
    }

    await this.deductOrigin(
      businessId,
      actorId,
      transfer.id,
      transfer.fromLocationId,
      stockLines.map((l) => ({ variantId: l.variantId, quantity: l.quantityShipped })),
      notes ?? transfer.notes,
    );

    await this.markSerialsInTransit(transferId);
    await this.markAsIsInTransit(transferId);

    await this.db
      .update(schema.stockTransfers)
      .set({ status: 'in_transit', shippedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.stockTransfers.id, transferId));

    await this.audit.log({
      action: 'stock_transfer.ship',
      targetType: 'stock_transfer',
      targetId: transferId,
      after: { lineCount: lines.length },
    });
  }

  async deductOrigin(
    businessId: string,
    actorId: string,
    transferId: string,
    fromLocationId: string,
    lines: { variantId: string; quantity: number }[],
    notes: string | null,
  ): Promise<void> {
    for (const l of lines) {
      await this.db.insert(schema.inventoryMovements).values({
        businessId,
        variantId: l.variantId,
        locationId: fromLocationId,
        delta: -l.quantity,
        reason: 'transfer_out',
        referenceType: 'stock_transfer',
        referenceId: transferId,
        actorUserId: actorId,
        notes,
      });
      // FIFO: shipping consumes origin layers; the weighted unit cost of
      // what actually left rides on the line so receiving can layer the
      // destination at the same cost.
      const consumed = await this.costing.consume(this.db, {
        businessId,
        variantId: l.variantId,
        locationId: fromLocationId,
        quantity: l.quantity,
        referenceType: 'transfer_out',
        referenceId: transferId,
      });
      await this.db
        .update(schema.stockTransferLines)
        .set({ unitCostCents: Math.round(consumed.costCents / l.quantity) })
        .where(
          and(
            eq(schema.stockTransferLines.transferId, transferId),
            eq(schema.stockTransferLines.variantId, l.variantId),
          ),
        );
      await this.db
        .insert(schema.inventoryLevels)
        .values({
          businessId,
          variantId: l.variantId,
          locationId: fromLocationId,
          onHand: 0,
        })
        .onConflictDoUpdate({
          target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId],
          set: {
            onHand: sql`GREATEST(0, ${schema.inventoryLevels.onHand} - ${l.quantity})`,
            updatedAt: new Date(),
          },
        });
    }
  }

  /** Owner 2026-10-30: the as-is pieces on this transfer are on the truck. */
  async markAsIsInTransit(transferId: string): Promise<void> {
    const lines = await this.db
      .select({ asIsItemId: schema.stockTransferLines.asIsItemId })
      .from(schema.stockTransferLines)
      .where(eq(schema.stockTransferLines.transferId, transferId));
    await shipPieces(
      this.db,
      lines.map((l) => l.asIsItemId).filter((x): x is string => !!x),
    );
  }

  /** J3: flag every named piece on this transfer as riding the truck. */
  async markSerialsInTransit(transferId: string): Promise<void> {
    const lines = await this.db
      .select({ serialIdsJson: schema.stockTransferLines.serialIdsJson })
      .from(schema.stockTransferLines)
      .where(eq(schema.stockTransferLines.transferId, transferId));
    const ids = lines.flatMap((l) => (l.serialIdsJson as string[] | null) ?? []);
    if (ids.length === 0) return;
    await this.db
      .update(schema.serialUnits)
      .set({ status: 'in_transit', updatedAt: new Date() })
      .where(and(inArray(schema.serialUnits.id, ids), eq(schema.serialUnits.status, 'in_stock')));
  }
}
