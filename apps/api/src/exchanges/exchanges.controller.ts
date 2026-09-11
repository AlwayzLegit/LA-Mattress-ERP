import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
} from '../common/pagination';
import { ExceptionsService } from '../controls/exceptions.service';
import {
  SecurityOverrideService,
  type OverrideCredentials,
} from '../controls/security-override.service';
import { DRIZZLE } from '../database/database.module';
import { paidCents } from '../orders/order-math';
import { StoreCreditService } from '../returns/store-credit.service';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

const FULFILLMENTS = ['drop_off', 'pickup'] as const;
const REFUND_TENDERS = ['store_credit', 'original', 'cash', 'check'] as const;

interface BindBody {
  saleOrderId?: string;
  returnId?: string;
  evenExchange?: boolean;
  restockingFeeCents?: number;
  returnSalespersonMembershipId?: string | null;
  /** A22 slice 6: how the returned goods come back, and how leftover credit is paid out. */
  fulfillment?: (typeof FULFILLMENTS)[number];
  refundTender?: (typeof REFUND_TENDERS)[number];
  notes?: string | null;
  override?: OverrideCredentials;
}

interface ExchangeRow {
  id: string;
  number: string;
  status: string;
  evenExchange: boolean;
  restockingFeeCents: number;
  restockingFeeOverridden: boolean;
  returnId: string;
  rmaNumber: string | null;
  returnStatus: string | null;
  returnCents: number;
  saleOrderId: string;
  saleOrderNumber: string | null;
  saleOrderStatus: string | null;
  saleTotalCents: number;
  originalOrderId: string | null;
  originalOrderNumber: string | null;
  referencedOrderNumber: string | null;
  customerName: string | null;
  createdAt: Date;
  completedAt: Date | null;
  splitAt: Date | null;
}

interface ExchangeDetail extends ExchangeRow {
  notes: string | null;
  returnSalespersonMembershipId: string | null;
  returnSalespersonName: string | null;
  fulfillment: string;
  refundTender: string;
  ticketPrintCount: number;
  settlement: {
    returnCents: number;
    restockingFeeCents: number;
    creditCents: number;
    saleTotalCents: number;
    salePaidCents: number;
    saleBalanceDueCents: number;
  };
}

/**
 * Enter an Exchange (docs/erp-exchange): the container over a customer
 * return and a replacement sales order. Both legs are created through
 * their own existing surfaces (`POST /v1/orders/:id/return` with
 * fulfillment 'pickup', `POST /v1/orders/:id/exchange`, or the
 * no-original return); this controller binds them, holds them for
 * approval when ops demands it, computes the restocking fee, and lets
 * them be split back apart. Settlement itself fires when the return's
 * goods come back (OrderReturnsService diverts to the container).
 */
@TenantScoped()
@Controller('v1/exchanges')
export class ExchangesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SecurityOverrideService) private readonly overrides: SecurityOverrideService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(StoreCreditService) private readonly storeCredit: StoreCreditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  @Get()
  @RequirePermission('orders.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('status') status?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<PageResponse<ExchangeRow>> {
    const limit = clampLimit(limitStr);
    const cursor = decodeCursor(cursorStr);
    const conditions: SQL[] = [];
    if (status) conditions.push(eq(schema.exchanges.status, status));
    if (cursor) {
      conditions.push(
        timestampCursorWhere(schema.exchanges.createdAt, schema.exchanges.id, cursor)!,
      );
    }
    const rows = await this.baseSelect()
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(...timestampCursorOrder(schema.exchanges.createdAt, schema.exchanges.id))
      .limit(limit + 1);
    const page = buildPage(rows, limit, (r) => r.createdAt);
    await this.lazyComplete(page.data);
    return page;
  }

  @Get(':id')
  @RequirePermission('orders.view')
  async detail(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<ExchangeDetail> {
    return this.hydrate(id);
  }

  /**
   * Bind the two legs into one exchange. The replacement order and the
   * return document must already exist; the container validates the
   * pairing (same customer, financed-original even-exchange rule),
   * prices the restocking fee, and applies the E1 approval hold.
   */
  @Post()
  @RequirePermission('exchanges.create')
  async bind(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: BindBody,
  ): Promise<ExchangeDetail> {
    if (!body.saleOrderId) throw new BadRequestException('saleOrderId is required');
    if (!body.returnId) throw new BadRequestException('returnId is required');
    const fulfillment = body.fulfillment ?? 'drop_off';
    if (!FULFILLMENTS.includes(fulfillment)) {
      throw new BadRequestException(`fulfillment must be one of ${FULFILLMENTS.join(', ')}`);
    }
    const refundTender = body.refundTender ?? 'store_credit';
    if (!REFUND_TENDERS.includes(refundTender)) {
      throw new BadRequestException(`refundTender must be one of ${REFUND_TENDERS.join(', ')}`);
    }
    if (body.returnSalespersonMembershipId) {
      const [sp] = await this.db
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.id, body.returnSalespersonMembershipId),
            eq(schema.memberships.businessId, tenant.businessId!),
          ),
        )
        .limit(1);
      if (!sp) throw new NotFoundException('Return salesperson not found');
    }

    const [saleOrder] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, body.saleOrderId))
      .limit(1);
    if (!saleOrder) throw new NotFoundException('Replacement order not found');
    if (['completed', 'cancelled'].includes(saleOrder.status)) {
      throw new BadRequestException(
        `Cannot bind a ${saleOrder.status} order as the replacement leg`,
      );
    }

    const [ret] = await this.db
      .select()
      .from(schema.orderReturns)
      .where(eq(schema.orderReturns.id, body.returnId))
      .limit(1);
    if (!ret) throw new NotFoundException('Return not found');

    // Only a LIVE container claims its legs — a split or cancelled
    // exchange releases them, so a corrected re-bind is possible (the
    // partial unique indexes enforce the same rule at the DB layer).
    const [taken] = await this.db
      .select({ id: schema.exchanges.id })
      .from(schema.exchanges)
      .where(
        sql`(${schema.exchanges.returnId} = ${body.returnId} or ${schema.exchanges.saleOrderId} = ${body.saleOrderId}) and ${schema.exchanges.status} not in ('split', 'cancelled')`,
      )
      .limit(1);
    if (taken) throw new ConflictException('That return or order is already part of an exchange');

    // Two admissible return states: an authorized with-original return
    // (settles at goods receipt) or a completed no-original return
    // (credit already on the ledger — settles at bind/approve).
    const noOriginal = ret.orderId == null;
    if (!noOriginal && ret.status !== 'authorized') {
      throw new BadRequestException(
        `Return ${ret.rmaNumber} is ${ret.status} — only an authorized return can join an exchange`,
      );
    }
    if (noOriginal && ret.status !== 'completed') {
      throw new BadRequestException(`No-original return ${ret.rmaNumber} is ${ret.status}`);
    }

    let originalOrder: typeof schema.orders.$inferSelect | null = null;
    if (!noOriginal) {
      const [orig] = await this.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, ret.orderId!))
        .limit(1);
      if (!orig) throw new NotFoundException('Original order not found');
      originalOrder = orig;
    }

    // Settlement rides the customer's store-credit ledger, so both
    // legs must bill the same customer (a differently-billed
    // replacement is a separate return + sale, not an exchange).
    const returnCustomerId = noOriginal ? ret.customerId : originalOrder!.customerId;
    if (!returnCustomerId || saleOrder.customerId !== returnCustomerId) {
      throw new BadRequestException(
        'The replacement order must bill the same customer as the return',
      );
    }

    const evenExchange = Boolean(body.evenExchange);

    // D1: a financed original cannot be re-struck at the register —
    // only a like-for-like even exchange is allowed in place.
    if (originalOrder) {
      const originalPayments = await this.db
        .select({ method: schema.payments.method, status: schema.payments.status })
        .from(schema.payments)
        .where(eq(schema.payments.orderId, originalOrder.id));
      const financed = originalPayments.some(
        (p) => p.method === 'financing' && p.status === 'succeeded',
      );
      if (financed && !evenExchange) {
        throw new BadRequestException(
          'The original order was financed — only an even (like-for-like) exchange is allowed. Enter a separate return and sale instead.',
        );
      }
    }

    if (evenExchange) {
      await this.assertEvenExchange(ret.id, noOriginal, saleOrder.id);
    }

    // Restocking fee: ops percentage of the return credit, or an
    // explicit override (its own permission; sticky — never
    // recalculated once overridden). No-original exchanges carry no
    // fee: their credit is already on the ledger, loss-prevention
    // flagged, and store-credit-only.
    const [bizRow] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    const ops = (bizRow?.opsSettingsJson ?? {}) as {
      restockingFeePercent?: number | null;
      exchangeHoldAtEntry?: boolean;
    };
    let restockingFeeCents = 0;
    let restockingFeeOverridden = false;
    if (!noOriginal) {
      const pct = ops.restockingFeePercent;
      const computed =
        pct != null && pct > 0
          ? Math.min(ret.amountCents, Math.round((ret.amountCents * pct) / 100))
          : 0;
      restockingFeeCents = computed;
      if (body.restockingFeeCents !== undefined) {
        if (
          !Number.isInteger(body.restockingFeeCents) ||
          body.restockingFeeCents < 0 ||
          body.restockingFeeCents > ret.amountCents
        ) {
          throw new BadRequestException(
            'restockingFeeCents must be an integer between 0 and the return amount',
          );
        }
        if (body.restockingFeeCents !== computed) {
          await this.overrides.require({
            permission: 'exchanges.restocking_fee.override',
            action: `Override restocking fee to ${body.restockingFeeCents} cents (calculated ${computed})`,
            entityType: 'exchange',
            override: body.override,
          });
          restockingFeeCents = body.restockingFeeCents;
          restockingFeeOverridden = true;
        }
      }
    }

    const onHold = Boolean(ops.exchangeHoldAtEntry);

    // Two concurrent binds can race the count-based number: retry the
    // INSERT itself with a fresh number on a unique-violation, so the
    // race resolves instead of surfacing a 500.
    let exchange: typeof schema.exchanges.$inferSelect | undefined;
    let number = '';
    for (let attempt = 0; attempt < 3 && !exchange; attempt++) {
      number = await this.generateNumber(tenant.businessId!);
      try {
        [exchange] = await this.db
          .insert(schema.exchanges)
          .values({
            businessId: tenant.businessId!,
            number,
            returnId: ret.id,
            saleOrderId: saleOrder.id,
            originalOrderId: originalOrder?.id ?? null,
            referencedOrderNumber: noOriginal ? ret.referencedOrderNumber : null,
            status: onHold ? 'on_hold' : 'open',
            evenExchange,
            restockingFeeCents,
            restockingFeeOverridden,
            returnSalespersonMembershipId: body.returnSalespersonMembershipId ?? null,
            fulfillment,
            refundTender,
            notes: body.notes ?? null,
            createdByUserId: actor?.id ?? null,
          })
          .returning();
      } catch (err) {
        const pgCode = (err as { code?: string; constraint_name?: string }).code;
        const constraint = (err as { constraint_name?: string }).constraint_name ?? '';
        if (pgCode === '23505' && constraint.includes('number') && attempt < 2) continue;
        if (pgCode === '23505' && !constraint.includes('number')) {
          throw new ConflictException('That return or order is already part of an exchange');
        }
        throw err;
      }
    }
    if (!exchange) throw new BadRequestException('failed to create exchange');

    if (restockingFeeOverridden) {
      await this.audit.log({
        action: 'exchange.restocking_fee.override',
        targetType: 'exchange',
        targetId: exchange.id,
        after: { number, restockingFeeCents },
      });
    }
    if (onHold) {
      await this.exceptions.record({
        type: 'exchange_hold',
        severity: 'info',
        entityType: 'exchange',
        entityId: exchange.id,
        summary: `Exchange ${number} held for approval at entry (E1)`,
        metadata: { returnId: ret.id, saleOrderId: saleOrder.id },
      });
    }
    await this.audit.log({
      action: 'exchange.create',
      targetType: 'exchange',
      targetId: exchange.id,
      after: {
        number,
        rmaNumber: ret.rmaNumber,
        saleOrderNumber: saleOrder.number,
        originalOrderNumber: originalOrder?.number ?? null,
        referencedOrderNumber: noOriginal ? ret.referencedOrderNumber : null,
        evenExchange,
        restockingFeeCents,
        onHold,
      },
    });

    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'exchange.created',
      payload: {
        exchangeId: exchange.id,
        number,
        rmaNumber: ret.rmaNumber,
        saleOrderNumber: saleOrder.number,
        evenExchange,
        restockingFeeCents,
        onHold,
      },
    });

    // A no-original return's credit is already banked — apply it to the
    // replacement now (unless held; the approve step settles then).
    if (noOriginal && !onHold) {
      await this.settleFromLedger(exchange.id, actor?.id ?? null);
    }
    return this.hydrate(exchange.id);
  }

  /** Release the E1 approval hold. */
  @Post(':id/approve')
  @RequirePermission('exchanges.approve')
  async approve(
    @CurrentTenant() _tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<ExchangeDetail> {
    const [exchange] = await this.db
      .select()
      .from(schema.exchanges)
      .where(eq(schema.exchanges.id, id))
      .limit(1);
    if (!exchange) throw new NotFoundException('Exchange not found');
    if (exchange.status !== 'on_hold') {
      throw new BadRequestException(`Exchange ${exchange.number} is ${exchange.status}, not held`);
    }
    await this.db
      .update(schema.exchanges)
      .set({
        status: 'open',
        approvedByUserId: actor?.id ?? null,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.exchanges.id, id));
    await this.audit.log({
      action: 'exchange.approve',
      targetType: 'exchange',
      targetId: id,
      after: { number: exchange.number },
    });
    void this.webhooks.fire({
      businessId: exchange.businessId,
      eventType: 'exchange.approved',
      payload: { exchangeId: id, number: exchange.number },
    });
    // A held no-original exchange still owes its ledger settlement.
    const [ret] = await this.db
      .select({ orderId: schema.orderReturns.orderId })
      .from(schema.orderReturns)
      .where(eq(schema.orderReturns.id, exchange.returnId))
      .limit(1);
    if (ret && ret.orderId == null) {
      await this.settleFromLedger(id, actor?.id ?? null);
    }
    return this.hydrate(id);
  }

  /** A22 slice 6: record an exchange ticket print. */
  @Post(':id/ticket-print')
  @RequirePermission('orders.view')
  async ticketPrint(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ ticketPrintCount: number }> {
    const [exchange] = await this.db
      .select({ id: schema.exchanges.id, count: schema.exchanges.ticketPrintCount })
      .from(schema.exchanges)
      .where(eq(schema.exchanges.id, id))
      .limit(1);
    if (!exchange) throw new NotFoundException('Exchange not found');
    const next = exchange.count + 1;
    await this.db
      .update(schema.exchanges)
      .set({ ticketPrintCount: next, updatedAt: new Date() })
      .where(eq(schema.exchanges.id, id));
    await this.audit.log({
      action: 'exchange.ticket_print',
      targetType: 'exchange',
      targetId: id,
      after: { ticketPrintCount: next },
    });
    return { ticketPrintCount: next };
  }

  /**
   * Split Exchange: dissolve the container. Both legs are already
   * first-class documents, so each simply completes on its own from
   * here — the return reverts to plain-refund behavior, the order to a
   * plain order. Money already settled stays where it landed.
   */
  @Post(':id/split')
  @RequirePermission('exchanges.create')
  async split(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<ExchangeDetail> {
    const [exchange] = await this.db
      .select()
      .from(schema.exchanges)
      .where(eq(schema.exchanges.id, id))
      .limit(1);
    if (!exchange) throw new NotFoundException('Exchange not found');
    if (!['open', 'on_hold'].includes(exchange.status)) {
      throw new BadRequestException(`Cannot split a ${exchange.status} exchange`);
    }
    await this.db
      .update(schema.exchanges)
      .set({ status: 'split', splitAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.exchanges.id, id));
    await this.audit.log({
      action: 'exchange.split',
      targetType: 'exchange',
      targetId: id,
      after: { number: exchange.number },
    });
    void this.webhooks.fire({
      businessId: exchange.businessId,
      eventType: 'exchange.split',
      payload: { exchangeId: id, number: exchange.number },
    });
    return this.hydrate(id);
  }

  /**
   * Void the container before money moves: the return authorization is
   * cancelled with it; the replacement order stays and follows its own
   * lifecycle (cancel it separately if unwanted). Once settlement has
   * run, use split instead.
   */
  @Post(':id/cancel')
  @RequirePermission('exchanges.create')
  async cancel(
    @CurrentTenant() _tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ): Promise<ExchangeDetail> {
    const [exchange] = await this.db
      .select()
      .from(schema.exchanges)
      .where(eq(schema.exchanges.id, id))
      .limit(1);
    if (!exchange) throw new NotFoundException('Exchange not found');
    if (!['open', 'on_hold'].includes(exchange.status)) {
      throw new BadRequestException(`Cannot cancel a ${exchange.status} exchange`);
    }
    const [ret] = await this.db
      .select()
      .from(schema.orderReturns)
      .where(eq(schema.orderReturns.id, exchange.returnId))
      .limit(1);
    if (!ret) throw new NotFoundException('Return not found');
    if (ret.status !== 'authorized') {
      throw new BadRequestException(
        `Return ${ret.rmaNumber} is ${ret.status} — money has moved; split the exchange instead`,
      );
    }
    const reason = body.reason?.trim() || `Exchange ${exchange.number} cancelled`;
    await this.db
      .update(schema.orderReturns)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledByUserId: actor?.id ?? null,
        cancelReason: reason,
      })
      .where(eq(schema.orderReturns.id, ret.id));
    await this.db
      .update(schema.exchanges)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(schema.exchanges.id, id));
    await this.audit.log({
      action: 'exchange.cancel',
      targetType: 'exchange',
      targetId: id,
      after: { number: exchange.number, rmaNumber: ret.rmaNumber, reason },
    });
    void this.webhooks.fire({
      businessId: exchange.businessId,
      eventType: 'exchange.cancelled',
      payload: { exchangeId: id, number: exchange.number, rmaNumber: ret.rmaNumber, reason },
    });
    return this.hydrate(id);
  }

  /**
   * Even exchange = like-for-like: the replacement's variant/quantity
   * multiset must equal the return's. (The finance contract covers the
   * same goods — D1.)
   */
  private async assertEvenExchange(
    returnId: string,
    noOriginal: boolean,
    saleOrderId: string,
  ): Promise<void> {
    const returnLines = await this.db
      .select({
        variantId: noOriginal ? schema.orderReturnLines.variantId : schema.orderLines.variantId,
        quantity: schema.orderReturnLines.quantity,
      })
      .from(schema.orderReturnLines)
      .leftJoin(schema.orderLines, eq(schema.orderLines.id, schema.orderReturnLines.orderLineId))
      .where(eq(schema.orderReturnLines.returnId, returnId));
    const saleLines = await this.db
      .select({ variantId: schema.orderLines.variantId, quantity: schema.orderLines.quantity })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, saleOrderId));

    const tally = (rows: { variantId: string | null; quantity: number }[]) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        if (!r.variantId) continue;
        m.set(r.variantId, (m.get(r.variantId) ?? 0) + r.quantity);
      }
      return m;
    };
    const a = tally(returnLines);
    const b = tally(saleLines);
    const same = a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
    if (!same) {
      throw new BadRequestException(
        'Not an even exchange — the replacement must match the returned items exactly (like-for-like)',
      );
    }
  }

  /**
   * No-original settlement: the credit is already on the customer's
   * ledger (issued when the no-original return completed); redeem what
   * the replacement's balance can absorb, capped by what the ledger
   * still holds.
   */
  private async settleFromLedger(exchangeId: string, actorUserId: string | null): Promise<void> {
    const [exchange] = await this.db
      .select()
      .from(schema.exchanges)
      .where(eq(schema.exchanges.id, exchangeId))
      .limit(1);
    if (!exchange) return;
    const [ret] = await this.db
      .select()
      .from(schema.orderReturns)
      .where(eq(schema.orderReturns.id, exchange.returnId))
      .limit(1);
    const [saleOrder] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, exchange.saleOrderId))
      .limit(1);
    if (!ret?.customerId || !saleOrder) return;

    const salePayments = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, saleOrder.id));
    const balanceDue = Math.max(0, saleOrder.totalCents - paidCents(salePayments));
    const ledger = await this.storeCredit.balanceCents(this.db, ret.customerId);
    const applied = Math.min(ret.amountCents, balanceDue, ledger);
    if (applied > 0) {
      await this.db.insert(schema.payments).values({
        businessId: exchange.businessId,
        saleId: null,
        orderId: saleOrder.id,
        kind: 'balance',
        method: 'store_credit',
        amountCents: applied,
        status: 'succeeded',
      });
      await this.storeCredit.redeem(this.db, {
        businessId: exchange.businessId,
        customerId: ret.customerId,
        amountCents: applied,
        referenceType: 'exchange',
        referenceId: exchange.id,
        actorUserId,
        reason: `Applied to exchange ${exchange.number} (${saleOrder.number})`,
      });
    }
    await this.audit.log({
      action: 'exchange.settle',
      targetType: 'exchange',
      targetId: exchange.id,
      after: {
        number: exchange.number,
        rmaNumber: ret.rmaNumber,
        returnCents: ret.amountCents,
        restockingFeeCents: 0,
        appliedToSaleCents: applied,
        saleOrderNumber: saleOrder.number,
        source: 'no_original_ledger',
      },
    });
    void this.webhooks.fire({
      businessId: exchange.businessId,
      eventType: 'exchange.settled',
      payload: {
        exchangeId: exchange.id,
        number: exchange.number,
        appliedToSaleCents: applied,
        saleOrderId: saleOrder.id,
        saleOrderNumber: saleOrder.number,
      },
    });
  }

  private baseSelect() {
    const orig = alias(schema.orders, 'orig');
    return this.db
      .select({
        id: schema.exchanges.id,
        number: schema.exchanges.number,
        status: schema.exchanges.status,
        evenExchange: schema.exchanges.evenExchange,
        restockingFeeCents: schema.exchanges.restockingFeeCents,
        restockingFeeOverridden: schema.exchanges.restockingFeeOverridden,
        returnId: schema.exchanges.returnId,
        rmaNumber: schema.orderReturns.rmaNumber,
        returnStatus: schema.orderReturns.status,
        returnCents: sql<number>`coalesce(${schema.orderReturns.amountCents}, 0)::int`,
        saleOrderId: schema.exchanges.saleOrderId,
        saleOrderNumber: schema.orders.number,
        saleOrderStatus: schema.orders.status,
        saleTotalCents: sql<number>`coalesce(${schema.orders.totalCents}, 0)::int`,
        originalOrderId: schema.exchanges.originalOrderId,
        originalOrderNumber: orig.number,
        referencedOrderNumber: schema.exchanges.referencedOrderNumber,
        customerName: sql<
          string | null
        >`nullif(trim(concat(${schema.customers.firstName}, ' ', ${schema.customers.lastName})), '')`,
        createdAt: schema.exchanges.createdAt,
        completedAt: schema.exchanges.completedAt,
        splitAt: schema.exchanges.splitAt,
        notes: schema.exchanges.notes,
        returnSalespersonMembershipId: schema.exchanges.returnSalespersonMembershipId,
        returnSalespersonName: schema.users.name,
        fulfillment: schema.exchanges.fulfillment,
        refundTender: schema.exchanges.refundTender,
        ticketPrintCount: schema.exchanges.ticketPrintCount,
      })
      .from(schema.exchanges)
      .leftJoin(schema.orderReturns, eq(schema.orderReturns.id, schema.exchanges.returnId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.exchanges.saleOrderId))
      .leftJoin(orig, eq(orig.id, schema.exchanges.originalOrderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.exchanges.returnSalespersonMembershipId),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .$dynamic();
  }

  /**
   * The container completes when both legs are done: return received,
   * replacement order completed. Persisted lazily on read — both the
   * list and the detail run this, so filters and reports see the real
   * status without waiting for someone to open the detail page.
   */
  private async lazyComplete(
    rows: {
      id: string;
      status: string;
      returnStatus: string | null;
      saleOrderStatus: string | null;
      completedAt: Date | null;
    }[],
  ): Promise<void> {
    const due = rows.filter(
      (r) =>
        r.status === 'open' && r.returnStatus === 'completed' && r.saleOrderStatus === 'completed',
    );
    if (due.length === 0) return;
    const now = new Date();
    for (const r of due) {
      await this.db
        .update(schema.exchanges)
        .set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(and(eq(schema.exchanges.id, r.id), eq(schema.exchanges.status, 'open')));
      r.status = 'completed';
      r.completedAt = now;
    }
  }

  private async hydrate(id: string): Promise<ExchangeDetail> {
    const [row] = await this.baseSelect().where(eq(schema.exchanges.id, id)).limit(1);
    if (!row) throw new NotFoundException('Exchange not found');

    const salePayments = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, row.saleOrderId));
    const salePaidCents = paidCents(salePayments);
    const creditCents = Math.max(0, row.returnCents - row.restockingFeeCents);

    await this.lazyComplete([row]);

    return {
      ...row,
      settlement: {
        returnCents: row.returnCents,
        restockingFeeCents: row.restockingFeeCents,
        creditCents,
        saleTotalCents: row.saleTotalCents,
        salePaidCents,
        saleBalanceDueCents: Math.max(0, row.saleTotalCents - salePaidCents),
      },
    };
  }

  /** EX-{year}-{seq}, count + retry like every other document number. */
  private async generateNumber(businessId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 8; attempt++) {
      const rows = await this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.exchanges)
        .where(
          and(
            eq(schema.exchanges.businessId, businessId),
            sql`${schema.exchanges.number} LIKE ${`EX-${year}-%`}`,
          ),
        );
      const seq = (rows[0]?.count ?? 0) + 1 + attempt;
      const candidate = `EX-${year}-${String(seq).padStart(6, '0')}`;
      const [existing] = await this.db
        .select({ id: schema.exchanges.id })
        .from(schema.exchanges)
        .where(
          and(eq(schema.exchanges.businessId, businessId), eq(schema.exchanges.number, candidate)),
        )
        .limit(1);
      if (!existing) return candidate;
    }
    return `EX-${year}-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
  }
}
