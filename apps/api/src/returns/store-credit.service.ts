import { BadRequestException, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';

/**
 * Store-credit ledger operations (PLAN-POS-OPERATIONS §10). Credit
 * lives on the customer record and never expires; the balance is the
 * SUM of the ledger, never stored. Issue on returns/refunds, redeem on
 * store_credit tenders — redemption always checks the balance so a
 * tender can never overdraw.
 */
@Injectable()
export class StoreCreditService {
  /**
   * Serializes ledger debits per customer: every check-then-debit
   * (redeem, voiding a no-original return) takes this row lock first, so
   * two debits can't both see the same balance. Held until the request's
   * transaction commits.
   */
  async lockCustomer(db: PostgresJsDatabase, customerId: string): Promise<void> {
    await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId))
      .for('update');
  }

  async balanceCents(db: PostgresJsDatabase, customerId: string): Promise<number> {
    const [row] = await db
      .select({
        balance: sql<number>`COALESCE(SUM(${schema.storeCreditEntries.deltaCents}), 0)::int`,
      })
      .from(schema.storeCreditEntries)
      .where(eq(schema.storeCreditEntries.customerId, customerId));
    return row?.balance ?? 0;
  }

  async issue(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      customerId: string;
      amountCents: number;
      reason: string | null;
      referenceType: 'refund' | 'order_return' | 'manual' | 'exchange';
      referenceId: string | null;
      actorUserId: string | null;
    },
  ): Promise<void> {
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new BadRequestException('store credit amount must be a positive integer');
    }
    await db.insert(schema.storeCreditEntries).values({
      businessId: args.businessId,
      customerId: args.customerId,
      deltaCents: args.amountCents,
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      createdByUserId: args.actorUserId,
    });
  }

  /** Throws 400 when the customer's balance can't cover the tender. */
  async redeem(
    db: PostgresJsDatabase,
    args: {
      businessId: string;
      customerId: string;
      amountCents: number;
      referenceType: 'payment' | 'exchange';
      referenceId: string | null;
      actorUserId: string | null;
      reason?: string;
    },
  ): Promise<void> {
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new BadRequestException('store credit amount must be a positive integer');
    }
    await this.lockCustomer(db, args.customerId);
    const balance = await this.balanceCents(db, args.customerId);
    if (balance < args.amountCents) {
      throw new BadRequestException(
        `Insufficient store credit: balance is $${(balance / 100).toFixed(2)}`,
      );
    }
    await db.insert(schema.storeCreditEntries).values({
      businessId: args.businessId,
      customerId: args.customerId,
      deltaCents: -args.amountCents,
      reason: args.reason ?? 'Redeemed at checkout',
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      createdByUserId: args.actorUserId,
    });
  }
}
