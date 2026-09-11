import { BadRequestException, ConflictException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { isLiveOrderStatus } from './order-math';

/**
 * The three guards every stock-touching edit of an order passes (A20
 * actions, A22 reassign reservation): the order is live, it is not
 * locked behind a printed delivery ticket (or an expired unlock
 * window), and it is not riding an open delivery run. Shared so the
 * order page and the inventory screens refuse the same edits for the
 * same reasons.
 */
export async function assertOrderEditable(
  db: PostgresJsDatabase,
  order: Pick<
    typeof schema.orders.$inferSelect,
    'id' | 'status' | 'lockedAt' | 'ticketPrintCount' | 'relockAt'
  >,
): Promise<void> {
  if (!isLiveOrderStatus(order.status)) {
    throw new BadRequestException(`Order is ${order.status} and cannot be changed`);
  }
  if (order.lockedAt) {
    throw new ConflictException(
      'Order is locked — its delivery ticket has been printed. Unlock it with a reason before editing.',
    );
  }
  if (order.ticketPrintCount > 0 && order.relockAt && order.relockAt.getTime() < Date.now()) {
    throw new ConflictException(
      'The unlock window expired and the lock re-engaged. Unlock again with a reason.',
    );
  }
  const [onRun] = await db
    .select({ runId: schema.deliveries.runId })
    .from(schema.deliveries)
    .innerJoin(schema.deliveryRuns, eq(schema.deliveryRuns.id, schema.deliveries.runId))
    .where(
      and(
        eq(schema.deliveries.orderId, order.id),
        inArray(schema.deliveryRuns.status, ['open', 'out']),
      ),
    )
    .limit(1);
  if (onRun) {
    throw new ConflictException(
      'This order is on a delivery run. Remove it from the run (with a reason) before editing.',
    );
  }
}
