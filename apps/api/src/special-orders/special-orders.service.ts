import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { DRIZZLE } from '../database/database.module';
import { EmailService } from '../email/email.service';
import { deriveFulfillmentStatus } from '../orders/order-math';
import { OrdersService } from '../orders/orders.service';

/**
 * The special-order loop (STORIS cutover G3): a customer buys something
 * the store doesn't stock, a PO buys it, and the moment it arrives on
 * the dock the units are committed to that customer and they get the
 * "your item is in" email. This service owns the receiving side; the
 * queue and PO generation live in the controller.
 */
@Injectable()
export class SpecialOrdersService {
  private readonly logger = new Logger(SpecialOrdersService.name);

  constructor(
    @Inject(DRIZZLE) private readonly rootDb: PostgresJsDatabase,
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  /**
   * Called by the PO receive flow after stock lands. Walks this PO
   * line's open allocations oldest-first, consuming the received
   * quantity: consumed units reserve immediately for their order line
   * (the goods were bought FOR that customer — nobody else gets them),
   * the allocation flips to received (splitting when a receipt covers
   * it only partially), and the customer is emailed once per order.
   */
  async handleReceipt(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      poLineId: string;
      locationId: string;
      quantity: number;
      actorUserId: string | null;
    },
  ): Promise<void> {
    let remaining = args.quantity;
    const allocations = await db
      .select()
      .from(schema.poLineAllocations)
      .where(
        and(
          eq(schema.poLineAllocations.poLineId, args.poLineId),
          eq(schema.poLineAllocations.status, 'ordered'),
        ),
      )
      .orderBy(asc(schema.poLineAllocations.createdAt));
    if (allocations.length === 0) return;

    const notifiedOrders = new Set<string>();
    for (const alloc of allocations) {
      if (remaining <= 0) break;
      const consumed = Math.min(alloc.quantity, remaining);
      remaining -= consumed;

      if (consumed === alloc.quantity) {
        await db
          .update(schema.poLineAllocations)
          .set({ status: 'received', updatedAt: new Date() })
          .where(eq(schema.poLineAllocations.id, alloc.id));
      } else {
        // Partial receipt: split so the received part is recorded and the
        // rest stays on order.
        await db
          .update(schema.poLineAllocations)
          .set({ quantity: alloc.quantity - consumed, updatedAt: new Date() })
          .where(eq(schema.poLineAllocations.id, alloc.id));
        await db.insert(schema.poLineAllocations).values({
          businessId: alloc.businessId,
          poLineId: alloc.poLineId,
          orderLineId: alloc.orderLineId,
          quantity: consumed,
          status: 'received',
        });
      }

      // Owner 2026-10-28: a transfer line's link only earmarks the units;
      // the transfer ships them from free stock once they are here.
      if (!alloc.orderLineId) continue;
      const [line] = await db
        .select({
          id: schema.orderLines.id,
          orderId: schema.orderLines.orderId,
          variantId: schema.orderLines.variantId,
          description: schema.orderLines.description,
          quantity: schema.orderLines.quantity,
          qtyReserved: schema.orderLines.qtyReserved,
          qtyFulfilled: schema.orderLines.qtyFulfilled,
          sourceLocationId: schema.orderLines.sourceLocationId,
          orderStatus: schema.orders.status,
          orderStockLocationId: schema.orders.stockLocationId,
          orderLocationId: schema.orders.locationId,
        })
        .from(schema.orderLines)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
        .where(eq(schema.orderLines.id, alloc.orderLineId))
        .limit(1);
      if (!line) continue;

      // The arrived units belong to this customer: commit them on the
      // spot so the shared pool never sees them.
      //
      // Owner 2026-10-28 (KO-10069, FULL COBALT FIRM): the line had
      // already been delivered out of count-corrected stock when its PO
      // arrived, and the receipt reserved the unit again — a phantom
      // reservation nobody could see. Reserve only what the line still
      // lacks (quantity − fulfilled − reserved), and only while the
      // order is live.
      const need = Math.max(0, line.quantity - line.qtyFulfilled - line.qtyReserved);
      const live = ['open', 'partially_fulfilled'].includes(line.orderStatus);
      const take = live ? Math.min(consumed, need) : 0;
      if (line.variantId && take > 0) {
        // The units sit where the PO landed. A line that reserves
        // nothing elsewhere follows them, so the delivery later consumes
        // the reservation at the location it was made (a Koreatown
        // receipt delivered from the Warehouse left levels reserved at
        // the store with no line behind them).
        const effective =
          line.sourceLocationId ?? line.orderStockLocationId ?? line.orderLocationId;
        if (line.qtyReserved === 0 && effective !== args.locationId) {
          await db
            .update(schema.orderLines)
            .set({ sourceLocationId: args.locationId })
            .where(eq(schema.orderLines.id, line.id));
        }
        await this.orders.applyReservations(db, {
          businessId: args.businessId,
          orderId: line.orderId,
          locationId: args.locationId,
          actorUserId: args.actorUserId,
          reservations: [{ orderLineId: line.id, variantId: line.variantId, quantity: take }],
        });
      }

      if (!notifiedOrders.has(line.orderId)) {
        notifiedOrders.add(line.orderId);
        await this.sendArrivalEmail(db, line.orderId, line.description).catch((err) => {
          // Email is best-effort — the receipt itself must never roll back
          // because a mail API hiccuped.
          this.logger.warn({ err, orderId: line.orderId }, 'arrival email failed');
        });
      }
    }
  }

  /**
   * PO-060: receiving a direct-ship PO line means the vendor shipped to
   * the customer — there is no stock to reserve. The allocation flips to
   * received and the linked order line is FULFILLED on the spot (no
   * inventory movement: the goods never touched our stock), then the
   * order's fulfillment status is recomputed and the customer told their
   * goods are on the way from the vendor.
   */
  async handleDirectShipReceipt(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      poLineId: string;
      quantity: number;
      actorUserId: string | null;
    },
  ): Promise<void> {
    let remaining = args.quantity;
    const allocations = await db
      .select()
      .from(schema.poLineAllocations)
      .where(
        and(
          eq(schema.poLineAllocations.poLineId, args.poLineId),
          eq(schema.poLineAllocations.status, 'ordered'),
        ),
      )
      .orderBy(asc(schema.poLineAllocations.createdAt));
    if (allocations.length === 0) return;

    const touchedOrders = new Set<string>();
    const notifiedOrders = new Set<string>();
    for (const alloc of allocations) {
      if (remaining <= 0) break;
      const consumed = Math.min(alloc.quantity, remaining);
      remaining -= consumed;

      if (consumed === alloc.quantity) {
        await db
          .update(schema.poLineAllocations)
          .set({ status: 'received', updatedAt: new Date() })
          .where(eq(schema.poLineAllocations.id, alloc.id));
      } else {
        await db
          .update(schema.poLineAllocations)
          .set({ quantity: alloc.quantity - consumed, updatedAt: new Date() })
          .where(eq(schema.poLineAllocations.id, alloc.id));
        await db.insert(schema.poLineAllocations).values({
          businessId: alloc.businessId,
          poLineId: alloc.poLineId,
          orderLineId: alloc.orderLineId,
          quantity: consumed,
          status: 'received',
        });
      }

      if (!alloc.orderLineId) continue;
      const [line] = await db
        .select({
          id: schema.orderLines.id,
          orderId: schema.orderLines.orderId,
          description: schema.orderLines.description,
        })
        .from(schema.orderLines)
        .where(eq(schema.orderLines.id, alloc.orderLineId))
        .limit(1);
      if (!line) continue;

      await db
        .update(schema.orderLines)
        .set({ qtyFulfilled: sql`${schema.orderLines.qtyFulfilled} + ${consumed}` })
        .where(eq(schema.orderLines.id, line.id));
      touchedOrders.add(line.orderId);

      if (!notifiedOrders.has(line.orderId)) {
        notifiedOrders.add(line.orderId);
        await this.sendArrivalEmail(db, line.orderId, line.description, 'direct_ship').catch(
          (err) => {
            this.logger.warn({ err, orderId: line.orderId }, 'direct-ship email failed');
          },
        );
      }
    }

    // The one place an order can become fulfilled without a delivery or
    // POS fulfillment: derive it from the lines like everywhere else.
    for (const orderId of touchedOrders) {
      const [order] = await db
        .select({ status: schema.orders.status })
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      if (!order || !['open', 'partially_fulfilled'].includes(order.status)) continue;
      const lines = await db
        .select({
          quantity: schema.orderLines.quantity,
          qtyFulfilled: schema.orderLines.qtyFulfilled,
        })
        .from(schema.orderLines)
        .where(eq(schema.orderLines.orderId, orderId));
      const next = deriveFulfillmentStatus(lines);
      if (next !== order.status) {
        await db
          .update(schema.orders)
          .set({ status: next, updatedAt: new Date() })
          .where(eq(schema.orders.id, orderId));
      }
    }
  }

  private async sendArrivalEmail(
    db: PostgresJsDatabase,
    orderId: string,
    itemDescription: string,
    mode: 'arrival' | 'direct_ship' = 'arrival',
  ): Promise<void> {
    const [order] = await db
      .select({
        number: schema.orders.number,
        customerId: schema.orders.customerId,
        importedAt: schema.orders.importedAt,
        businessId: schema.orders.businessId,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!order || order.importedAt) return; // D8: imported orders stay silent
    const [customer] = await db
      .select({
        email: schema.customers.email,
        firstName: schema.customers.firstName,
      })
      .from(schema.customers)
      .where(eq(schema.customers.id, order.customerId))
      .limit(1);
    if (!customer?.email) return;
    const [biz] = await db
      .select({ name: schema.businesses.name })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, order.businessId))
      .limit(1);
    const store = biz?.name ?? 'the store';
    const first = customer.firstName ? ` ${customer.firstName}` : '';
    if (mode === 'direct_ship') {
      await this.email.send({
        to: customer.email,
        subject: `Your order is on its way — ${order.number}`,
        text: `Hi${first},\n\nGood news: ${itemDescription} from your order ${order.number} has shipped from our supplier directly to you.\n\n— ${store}`,
        html: `<p>Hi${first},</p><p>Good news: <strong>${itemDescription}</strong> from your order <strong>${order.number}</strong> has shipped from our supplier directly to you.</p><p>— ${store}</p>`,
      });
      return;
    }
    await this.email.send({
      to: customer.email,
      subject: `Your special order has arrived — ${order.number}`,
      text: `Hi${first},\n\nGood news: ${itemDescription} from your order ${order.number} has arrived at ${store}. We'll be in touch to schedule your delivery or pickup.\n\n— ${store}`,
      html: `<p>Hi${first},</p><p>Good news: <strong>${itemDescription}</strong> from your order <strong>${order.number}</strong> has arrived at ${store}. We'll be in touch to schedule your delivery or pickup.</p><p>— ${store}</p>`,
    });
  }

  /** Serial hand-off at fulfillment: committed serials on the line become sold. */
  async markSerialsSold(
    db: PostgresJsDatabase,
    args: { orderLineIds: readonly string[]; customerId: string },
  ): Promise<void> {
    if (args.orderLineIds.length === 0) return;
    await db
      .update(schema.serialUnits)
      .set({ status: 'sold', customerId: args.customerId, updatedAt: new Date() })
      .where(
        and(
          inArray(schema.serialUnits.orderLineId, [...args.orderLineIds]),
          eq(schema.serialUnits.status, 'committed'),
        ),
      );
  }
}
