import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CompetitionsService } from '../competitions/competitions.service';
import { DRIZZLE } from '../database/database.module';
import { CommissionsService } from '../money/commissions.service';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';
import { loadReturnsSettled } from './order-balance';
import { balanceDueCents, paidCents } from './order-math';
import { OrdersService } from './orders.service';

/**
 * The one way an order closes (owner 2026-10-22). Completing is what the
 * sales competitions, commissions (G5) and every "completed" report key
 * on, and until now only the order page's Complete button — or a
 * take-with hand-over at the register — got there: delivered orders sat
 * at `fulfilled` for weeks and the board showed nobody's sales. Now an
 * order completes on its own the moment it is both fulfilled and paid
 * (balance due = 0, the plan's completion rule): at the delivery or
 * counter hand-over when the money is already in, or at the payment that
 * clears the balance afterwards. Complete-with-balance (AR, G8) stays a
 * deliberate click.
 */
@Injectable()
export class OrderCompletionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(CommissionsService) private readonly commissions: CommissionsService,
    @Inject(CompetitionsService) private readonly competitions: CompetitionsService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  /**
   * Complete the order when it is fulfilled and nothing is owed. Returns
   * true when it completed here; false when it is not ready (still units
   * to deliver, a balance due) or already closed. Never throws for a
   * not-ready order — callers are the delivery and payment paths, which
   * must succeed regardless.
   */
  async tryAutoComplete(
    businessId: string,
    orderId: string,
    actorUserId: string | null,
  ): Promise<boolean> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!order || order.status !== 'fulfilled' || order.completedAt || order.cancelledAt) {
      return false;
    }
    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId));
    const due = balanceDueCents(
      order.totalCents,
      payments,
      await loadReturnsSettled(this.db, orderId),
    );
    if (due > 0) return false;
    await this.finalize(businessId, orderId, actorUserId, { dueCents: 0, auto: true });
    return true;
  }

  /**
   * The closing tail shared with the explicit Complete endpoint: release
   * whatever reservation residue is left so the stock ledger ends clean,
   * stamp the order, accrue commissions, tell the competitions, audit,
   * and fire the webhook.
   */
  async finalize(
    businessId: string,
    orderId: string,
    actorUserId: string | null,
    opts: { dueCents: number; auto: boolean },
  ): Promise<void> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!order) return;
    await this.orders.releaseOrder(this.db, {
      businessId,
      orderId,
      locationId: order.stockLocationId ?? order.locationId,
      actorUserId,
    });
    await this.db
      .update(schema.orders)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.orders.id, orderId));

    // Commission accrues at completion (G5), split per split_bps;
    // imported orders never accrue (D8) — enforced in the service.
    await this.commissions.accrueForOrder(this.db, { businessId, orderId });
    // Sales competitions (redesign Phase 11): convert a matching lead and
    // notice any overtake. Never blocks the completion.
    await this.competitions.onOrderCompleted(businessId, orderId);

    await this.audit.log({
      action: 'order.complete',
      targetType: 'order',
      targetId: orderId,
      after: {
        balanceDueCents: opts.dueCents,
        withBalance: opts.dueCents > 0,
        ...(opts.auto ? { auto: true } : {}),
      },
    });

    if (order.importedAt) return;
    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId));
    const paid = paidCents(payments);
    const settled = await loadReturnsSettled(this.db, orderId);
    void this.webhooks.fire({
      businessId,
      eventType: 'order.completed',
      payload: {
        orderId,
        number: order.number,
        status: 'completed',
        customerId: order.customerId,
        locationId: order.locationId,
        totalCents: order.totalCents,
        paidCents: paid,
        balanceDueCents: balanceDueCents(order.totalCents, payments, settled),
      },
    });
  }
}
