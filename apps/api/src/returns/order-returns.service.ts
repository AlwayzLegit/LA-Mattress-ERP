import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { DRIZZLE } from '../database/database.module';
import { CommissionsService } from '../money/commissions.service';
import { paidCents } from '../orders/order-math';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';
import { StoreCreditService } from './store-credit.service';

/**
 * The physical half of the A7 return lifecycle: goods arrive back →
 * qtyReturned bumps, units land in As-Is, and only now the refund
 * fires (original tenders newest-first, or the store-credit ledger).
 * Shared by the counter drop-off path (authorize + receive in one
 * request) and the warehouse receive endpoint for truck pickups.
 */
@Injectable()
export class OrderReturnsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StoreCreditService) private readonly storeCredit: StoreCreditService,
    @Inject(CommissionsService) private readonly commissions: CommissionsService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  async receiveGoods(
    returnId: string,
    actorUserId: string | null,
    opts: { receiveLocationId?: string | null } = {},
  ): Promise<void> {
    const [ret] = await this.db
      .select()
      .from(schema.orderReturns)
      .where(eq(schema.orderReturns.id, returnId))
      .limit(1);
    if (!ret) throw new NotFoundException('Return not found');
    // Where the goods physically land (As-Is staging). Defaults to the
    // original order's location; a warehouse receive names itself here.
    if (opts.receiveLocationId) {
      const [loc] = await this.db
        .select({ id: schema.locations.id, businessId: schema.locations.businessId })
        .from(schema.locations)
        .where(eq(schema.locations.id, opts.receiveLocationId))
        .limit(1);
      if (!loc || loc.businessId !== ret.businessId) {
        throw new BadRequestException('receive locationId must name a location of this business');
      }
    }
    if (ret.status !== 'authorized') {
      throw new ConflictException(`Return ${ret.rmaNumber} is already ${ret.status}`);
    }
    if (!ret.orderId) {
      // No-original returns are written completed in one step and never
      // sit in 'authorized' — this is a data-integrity backstop.
      throw new ConflictException(`Return ${ret.rmaNumber} has no order to receive against`);
    }
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, ret.orderId))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');

    const returnLines = await this.db
      .select()
      .from(schema.orderReturnLines)
      .where(eq(schema.orderReturnLines.returnId, returnId));

    // Exchange settlement (docs/erp-exchange): a return bound into a
    // live exchange container settles against the replacement order
    // instead of refunding — the plain refund path below never runs.
    // A split or cancelled container restores plain-return behavior.
    const [exchange] = await this.db
      .select()
      .from(schema.exchanges)
      .where(eq(schema.exchanges.returnId, returnId))
      .limit(1);
    const liveExchange =
      exchange && (exchange.status === 'open' || exchange.status === 'on_hold') ? exchange : null;
    if (liveExchange?.status === 'on_hold') {
      throw new ConflictException(
        `Exchange ${liveExchange.number} is held for approval — release it before receiving the return`,
      );
    }

    // Money first — validate before any goods movement so a blocked
    // refund leaves the return untouched (still authorized).
    const toStoreCredit = ret.refundMethod === 'store_credit';
    const payments = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, ret.orderId))
      .orderBy(desc(schema.payments.createdAt));
    if (!liveExchange && !toStoreCredit && ret.amountCents > paidCents(payments)) {
      throw new BadRequestException(
        `Refund (${ret.amountCents}) exceeds the money now collected on ${order.number} — cancel and re-authorize as store credit`,
      );
    }

    // Goods: bump returned counters and stage everything in As-Is.
    for (const rl of returnLines) {
      if (!rl.orderLineId) {
        throw new ConflictException(`Return line ${rl.id} has no order line`);
      }
      const [line] = await this.db
        .select()
        .from(schema.orderLines)
        .where(eq(schema.orderLines.id, rl.orderLineId))
        .limit(1);
      if (!line) throw new NotFoundException(`Order line not found: ${rl.orderLineId}`);
      if (line.qtyFulfilled - line.qtyReturned < rl.quantity) {
        throw new ConflictException(
          `Line "${line.description}" no longer has ${rl.quantity} returnable unit(s)`,
        );
      }
      await this.db
        .update(schema.orderLines)
        .set({ qtyReturned: line.qtyReturned + rl.quantity })
        .where(eq(schema.orderLines.id, line.id));
      if (line.variantId) {
        // G10 piece identity: one As-Is row per returned unit, each
        // with its own reference number.
        const inserted = await this.db
          .insert(schema.asIsItems)
          .values(
            Array.from({ length: rl.quantity }, () => ({
              businessId: ret.businessId,
              variantId: line.variantId!,
              locationId: opts.receiveLocationId ?? order.locationId,
              quantity: 1,
              source: 'return',
              // Reference the order (matching the P8 contract the As-Is
              // UI links from); the return doc itself is on order_returns.
              referenceType: 'order',
              referenceId: ret.orderId,
              reasonCodeId: rl.reasonCodeId,
              notes: rl.reason ?? ret.reason ?? null,
            })),
          )
          .returning({ id: schema.asIsItems.id });
        for (const piece of inserted) {
          await this.db
            .update(schema.asIsItems)
            .set({ pieceNumber: `AS-${piece.id.slice(0, 8).toUpperCase()}` })
            .where(eq(schema.asIsItems.id, piece.id));
        }
      }
    }

    // Money: an exchange settles against the replacement order through
    // the store-credit ledger — issue the credit (minus the restocking
    // fee), then redeem what the replacement's balance can absorb. Any
    // remainder stays as visible, spendable store credit. The credit is
    // capped at what was actually collected on the original order — the
    // same invariant the plain-refund path enforces below; a delivered-
    // but-half-paid original never mints unearned credit.
    if (liveExchange) {
      const fee = liveExchange.restockingFeeCents;
      const collected = Math.max(0, paidCents(payments));
      const credit = Math.max(0, Math.min(ret.amountCents, collected) - fee);
      if (credit < ret.amountCents - fee) {
        await this.audit.log({
          action: 'exchange.credit_capped',
          targetType: 'exchange',
          targetId: liveExchange.id,
          after: {
            number: liveExchange.number,
            returnCents: ret.amountCents,
            collectedCents: collected,
            creditCents: credit,
          },
        });
      }
      if (credit > 0) {
        await this.storeCredit.issue(this.db, {
          businessId: ret.businessId,
          customerId: order.customerId,
          amountCents: credit,
          reason: `Exchange ${liveExchange.number} — return ${ret.rmaNumber}${fee > 0 ? ` (restocking fee ${fee} cents withheld)` : ''}`,
          referenceType: 'exchange',
          referenceId: liveExchange.id,
          actorUserId,
        });
      }
      const [saleOrder] = await this.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, liveExchange.saleOrderId))
        .limit(1);
      if (!saleOrder) throw new NotFoundException('Exchange replacement order not found');
      const salePayments = await this.db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, saleOrder.id));
      const balanceDue = Math.max(0, saleOrder.totalCents - paidCents(salePayments));
      const applied = Math.min(credit, balanceDue);
      if (applied > 0) {
        await this.db.insert(schema.payments).values({
          businessId: ret.businessId,
          saleId: null,
          orderId: saleOrder.id,
          kind: 'balance',
          method: 'store_credit',
          amountCents: applied,
          status: 'succeeded',
        });
        await this.storeCredit.redeem(this.db, {
          businessId: ret.businessId,
          customerId: order.customerId,
          amountCents: applied,
          referenceType: 'exchange',
          referenceId: liveExchange.id,
          actorUserId,
          reason: `Applied to exchange ${liveExchange.number} (${saleOrder.number})`,
        });
      }
      // A22 slice 6 (STORIS "refund tender"): when the return is worth
      // more than the replacement, the leftover credit goes back the way
      // the exchange asked — original tenders (newest first), cash or
      // check — instead of sitting on the ledger. Store credit (the
      // default) leaves it spendable.
      let refundedCents = 0;
      const residual = credit - applied;
      if (residual > 0 && liveExchange.refundTender !== 'store_credit') {
        await this.storeCredit.redeem(this.db, {
          businessId: ret.businessId,
          customerId: order.customerId,
          amountCents: residual,
          referenceType: 'exchange',
          referenceId: liveExchange.id,
          actorUserId,
          reason: `Refunded from exchange ${liveExchange.number} by ${liveExchange.refundTender}`,
        });
        if (liveExchange.refundTender === 'original') {
          let remaining = residual;
          for (const p of payments) {
            if (remaining <= 0) break;
            if (p.status !== 'succeeded' || p.amountCents <= 0) continue;
            const slice = Math.min(remaining, p.amountCents);
            await this.db.insert(schema.payments).values({
              businessId: ret.businessId,
              saleId: null,
              orderId: ret.orderId,
              kind: 'refund',
              method: p.method,
              amountCents: -slice,
              status: 'succeeded',
            });
            remaining -= slice;
          }
          refundedCents = residual - remaining;
        } else {
          await this.db.insert(schema.payments).values({
            businessId: ret.businessId,
            saleId: null,
            orderId: ret.orderId,
            kind: 'refund',
            method: liveExchange.refundTender,
            amountCents: -residual,
            status: 'succeeded',
          });
          refundedCents = residual;
        }
      }
      await this.db
        .update(schema.exchanges)
        .set({ updatedAt: new Date() })
        .where(eq(schema.exchanges.id, liveExchange.id));
      await this.audit.log({
        action: 'exchange.settle',
        targetType: 'exchange',
        targetId: liveExchange.id,
        after: {
          number: liveExchange.number,
          rmaNumber: ret.rmaNumber,
          returnCents: ret.amountCents,
          restockingFeeCents: fee,
          creditIssuedCents: credit,
          appliedToSaleCents: applied,
          saleOrderNumber: saleOrder.number,
          residualCreditCents: credit - applied - refundedCents,
          refundTender: liveExchange.refundTender,
          refundedCents,
        },
      });
      void this.webhooks.fire({
        businessId: ret.businessId,
        eventType: 'exchange.settled',
        payload: {
          exchangeId: liveExchange.id,
          number: liveExchange.number,
          rmaNumber: ret.rmaNumber,
          creditIssuedCents: credit,
          appliedToSaleCents: applied,
          saleOrderId: saleOrder.id,
          saleOrderNumber: saleOrder.number,
        },
      });
    } else if (toStoreCredit) {
      await this.storeCredit.issue(this.db, {
        businessId: ret.businessId,
        customerId: order.customerId,
        amountCents: ret.amountCents,
        reason: ret.reason ?? `Return ${ret.rmaNumber} on ${order.number}`,
        referenceType: 'order_return',
        referenceId: ret.id,
        actorUserId,
      });
    } else {
      let remaining = ret.amountCents;
      for (const p of payments) {
        if (remaining <= 0) break;
        if (p.status !== 'succeeded' || p.amountCents <= 0) continue;
        const slice = Math.min(remaining, p.amountCents);
        await this.db.insert(schema.payments).values({
          businessId: ret.businessId,
          saleId: null,
          orderId: ret.orderId,
          kind: 'refund',
          method: p.method,
          amountCents: -slice,
          status: 'succeeded',
        });
        remaining -= slice;
      }
    }

    // §9 exchange/return clawback: the salespeople give back the
    // commission on the returned fraction (no-op until the order has
    // completed and accrued).
    await this.commissions.reverseForOrderReturn(this.db, {
      businessId: ret.businessId,
      orderId: ret.orderId,
      refundedCents: ret.amountCents,
      orderTotalCents: order.totalCents,
      rmaNumber: ret.rmaNumber,
    });

    const now = new Date();
    await this.db
      .update(schema.orderReturns)
      .set({
        status: 'completed',
        goodsReceivedAt: now,
        receivedByUserId: actorUserId,
        completedAt: now,
      })
      .where(eq(schema.orderReturns.id, returnId));

    await this.audit.log({
      action: 'order.return',
      targetType: 'order',
      targetId: ret.orderId,
      after: {
        rmaNumber: ret.rmaNumber,
        amountCents: ret.amountCents,
        refundMethod: ret.refundMethod,
        fulfillment: ret.fulfillment,
        unitCount: returnLines.reduce((s, l) => s + l.quantity, 0),
        reason: ret.reason ?? null,
        receiveLocationId: opts.receiveLocationId ?? order.locationId,
      },
    });
  }
}
