import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { resolveTakenAt } from '../common/payment-taken-at';
import { DRIZZLE } from '../database/database.module';
import { EmailService } from '../email/email.service';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

const FREQUENCIES = ['weekly', 'biweekly', 'monthly'] as const;
type Frequency = (typeof FREQUENCIES)[number];

const PAYMENT_METHODS = ['cash', 'card', 'external_card', 'check', 'financing'] as const;

interface CreatePlanBody {
  type?: 'layaway' | 'in_house';
  frequency?: Frequency;
  startDate?: string;
  /** Either a per-installment amount or a number of installments. */
  installmentAmountCents?: number;
  installmentCount?: number;
}

interface PlanDetail {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  type: string;
  status: string;
  frequency: string;
  startDate: string;
  installmentAmountCents: number;
  installments: {
    id: string;
    seq: number;
    dueDate: string;
    amountCents: number;
    status: string;
    paidPaymentId: string | null;
  }[];
}

function addInterval(d: Date, frequency: Frequency, times: number): Date {
  const out = new Date(d);
  if (frequency === 'monthly') out.setMonth(out.getMonth() + times);
  else out.setDate(out.getDate() + (frequency === 'weekly' ? 7 : 14) * times);
  return out;
}

/**
 * Layaway / in-house plans (STORIS cutover G4). A plan schedules an
 * order's balance into installments; paying one posts an ordinary order
 * payment (kind='installment') — the drawer, tender mix, and balance
 * math see it like any other money. The plan completes itself when the
 * last installment lands.
 */
@TenantScoped()
@Controller('v1')
export class PaymentPlansController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  @Post('orders/:orderId/payment-plan')
  @RequirePermission('payment_plans.manage')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('orderId') orderId: string,
    @Body() body: CreatePlanBody,
  ): Promise<PlanDetail> {
    const type = body.type ?? 'layaway';
    if (type !== 'layaway' && type !== 'in_house') {
      throw new BadRequestException("type must be 'layaway' or 'in_house'");
    }
    const frequency = body.frequency ?? 'monthly';
    if (!FREQUENCIES.includes(frequency)) {
      throw new BadRequestException(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
    }
    const start = body.startDate ? new Date(body.startDate) : new Date();
    if (Number.isNaN(start.getTime())) throw new BadRequestException('startDate must be a date');

    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'quote') {
      throw new BadRequestException('Confirm the order before putting it on a plan');
    }
    if (order.completedAt || order.cancelledAt) throw new BadRequestException('Order is closed');
    const [existing] = await this.db
      .select({ id: schema.paymentPlans.id })
      .from(schema.paymentPlans)
      .where(eq(schema.paymentPlans.orderId, orderId))
      .limit(1);
    if (existing) throw new BadRequestException('This order already has a payment plan');

    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId));
    const paid = payments
      .filter((p) => p.status === 'succeeded')
      .reduce((s, p) => s + p.amountCents, 0);
    const balance = Math.max(0, order.totalCents - paid);
    if (balance <= 0) throw new BadRequestException('Nothing left to schedule — balance is zero');

    let amount: number;
    let count: number;
    if (body.installmentAmountCents) {
      amount = Math.round(body.installmentAmountCents);
      if (amount <= 0) throw new BadRequestException('installmentAmountCents must be positive');
      count = Math.ceil(balance / amount);
    } else if (body.installmentCount) {
      count = Math.round(body.installmentCount);
      if (count <= 0 || count > 120) {
        throw new BadRequestException('installmentCount must be between 1 and 120');
      }
      amount = Math.ceil(balance / count);
    } else {
      throw new BadRequestException('Provide installmentAmountCents or installmentCount');
    }

    const [plan] = await this.db
      .insert(schema.paymentPlans)
      .values({
        businessId: tenant.businessId!,
        orderId,
        type,
        frequency,
        startDate: start.toISOString().slice(0, 10),
        installmentAmountCents: amount,
      })
      .returning();
    if (!plan) throw new BadRequestException('failed to create plan');

    // Generate the schedule; the last installment takes the remainder so
    // the plan sums to the balance exactly (money is integer cents).
    let remaining = balance;
    const values = [];
    for (let seq = 1; seq <= count; seq++) {
      const thisAmount = seq === count ? remaining : Math.min(amount, remaining);
      remaining -= thisAmount;
      values.push({
        businessId: tenant.businessId!,
        planId: plan.id,
        seq,
        dueDate: addInterval(start, frequency, seq - 1)
          .toISOString()
          .slice(0, 10),
        amountCents: thisAmount,
      });
    }
    await this.db.insert(schema.paymentPlanInstallments).values(values);

    await this.audit.log({
      action: 'payment_plan.create',
      targetType: 'payment_plan',
      targetId: plan.id,
      after: { orderId, type, frequency, count, installmentAmountCents: amount, balance },
    });
    return this.detail(plan.id);
  }

  @Get('payment-plans')
  @RequirePermission('payment_plans.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('status') status?: string,
  ): Promise<PlanDetail[]> {
    const filters = [];
    if (status) filters.push(eq(schema.paymentPlans.status, status));
    const rows = await this.db
      .select({ id: schema.paymentPlans.id })
      .from(schema.paymentPlans)
      .where(filters.length ? and(...filters) : undefined)
      .limit(200);
    return Promise.all(rows.map((r) => this.detail(r.id)));
  }

  @Get('payment-plans/overdue-report')
  @RequirePermission('payment_plans.view')
  async overdueReport(@CurrentTenant() _tenant: RequestTenantContext): Promise<{
    rows: {
      planId: string;
      orderNumber: string;
      customerName: string | null;
      overdueCount: number;
      overdueCents: number;
      oldestDueDate: string;
    }[];
    totalOverdueCents: number;
  }> {
    const today = new Date().toISOString().slice(0, 10);
    const overdue = await this.db
      .select({
        planId: schema.paymentPlanInstallments.planId,
        overdueCount: sql<number>`COUNT(*)::int`,
        overdueCents: sql<number>`COALESCE(SUM(${schema.paymentPlanInstallments.amountCents}), 0)::int`,
        oldestDueDate: sql<string>`MIN(${schema.paymentPlanInstallments.dueDate})`,
      })
      .from(schema.paymentPlanInstallments)
      .where(
        and(
          inArray(schema.paymentPlanInstallments.status, ['due', 'overdue']),
          lt(schema.paymentPlanInstallments.dueDate, today),
        ),
      )
      .groupBy(schema.paymentPlanInstallments.planId);

    const rows = [];
    let total = 0;
    for (const o of overdue) {
      const d = await this.detail(o.planId);
      if (d.status !== 'active') continue;
      rows.push({
        planId: o.planId,
        orderNumber: d.orderNumber,
        customerName: d.customerName,
        overdueCount: o.overdueCount,
        overdueCents: o.overdueCents,
        oldestDueDate: o.oldestDueDate,
      });
      total += o.overdueCents;
    }
    return { rows, totalOverdueCents: total };
  }

  /**
   * The overdue sweep: flip past-due installments to 'overdue' and send
   * one reminder per plan. Idempotent — already-overdue rows don't
   * re-mail. Called nightly by the scheduler (deploy hardening) and
   * runnable by hand from the report.
   */
  @Post('payment-plans/run-overdue')
  @RequirePermission('payment_plans.manage')
  async runOverdue(
    @CurrentTenant() _tenant: RequestTenantContext,
  ): Promise<{ marked: number; reminded: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const marked = await this.db
      .update(schema.paymentPlanInstallments)
      .set({ status: 'overdue', updatedAt: new Date() })
      .where(
        and(
          eq(schema.paymentPlanInstallments.status, 'due'),
          lt(schema.paymentPlanInstallments.dueDate, today),
        ),
      )
      .returning({ planId: schema.paymentPlanInstallments.planId });

    const planIds = [...new Set(marked.map((m) => m.planId))];
    let reminded = 0;
    for (const planId of planIds) {
      const d = await this.detail(planId).catch(() => null);
      if (!d || d.status !== 'active') continue;
      const [order] = await this.db
        .select({ customerId: schema.orders.customerId, importedAt: schema.orders.importedAt })
        .from(schema.orders)
        .where(eq(schema.orders.id, d.orderId))
        .limit(1);
      if (!order || order.importedAt) continue; // D8
      const [customer] = await this.db
        .select({ email: schema.customers.email, firstName: schema.customers.firstName })
        .from(schema.customers)
        .where(eq(schema.customers.id, order.customerId))
        .limit(1);
      if (!customer?.email) continue;
      const overdueRows = d.installments.filter((i) => i.status === 'overdue');
      const cents = overdueRows.reduce((s, i) => s + i.amountCents, 0);
      await this.email
        .send({
          to: customer.email,
          subject: `Payment reminder — ${d.orderNumber}`,
          text: `Hi${customer.firstName ? ` ${customer.firstName}` : ''},\n\nA payment of $${(cents / 100).toFixed(2)} on your plan for order ${d.orderNumber} is past due. Please visit us or call to bring the plan current.\n`,
          html: `<p>Hi${customer.firstName ? ` ${customer.firstName}` : ''},</p><p>A payment of <strong>$${(cents / 100).toFixed(2)}</strong> on your plan for order <strong>${d.orderNumber}</strong> is past due. Please visit us or call to bring the plan current.</p>`,
        })
        .then(() => {
          reminded += 1;
        })
        .catch(() => undefined);
    }
    await this.audit.log({
      action: 'payment_plans.run_overdue',
      targetType: 'payment_plan',
      targetId: undefined,
      after: { marked: marked.length, reminded },
    });
    return { marked: marked.length, reminded };
  }

  /** Take one installment. Money lands as an order payment (kind installment). */
  @Post('payment-plans/:id/installments/:seq/pay')
  @RequirePermission('payment_plans.manage')
  async payInstallment(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Param('seq') seqStr: string,
    @Body() body: { method?: string; processorRef?: string; takenAtLocationId?: string },
  ): Promise<PlanDetail> {
    const seq = Number(seqStr);
    const method = body.method ?? 'cash';
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
      throw new BadRequestException(`method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }
    const [plan] = await this.db
      .select()
      .from(schema.paymentPlans)
      .where(eq(schema.paymentPlans.id, id))
      .limit(1);
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== 'active') throw new BadRequestException(`Plan is ${plan.status}`);
    const [inst] = await this.db
      .select()
      .from(schema.paymentPlanInstallments)
      .where(
        and(
          eq(schema.paymentPlanInstallments.planId, id),
          eq(schema.paymentPlanInstallments.seq, seq),
        ),
      )
      .limit(1);
    if (!inst) throw new NotFoundException('Installment not found');
    if (inst.status === 'paid' || inst.status === 'waived') {
      throw new BadRequestException(`Installment ${seq} is already ${inst.status}`);
    }

    const [planOrder] = await this.db
      .select({ locationId: schema.orders.locationId })
      .from(schema.orders)
      .where(eq(schema.orders.id, plan.orderId))
      .limit(1);
    if (!planOrder) throw new NotFoundException('Order not found');
    const takenAt = await resolveTakenAt(
      this.db,
      tenant,
      planOrder.locationId,
      body.takenAtLocationId,
    );
    const [payment] = await this.db
      .insert(schema.payments)
      .values({
        businessId: tenant.businessId!,
        saleId: null,
        orderId: plan.orderId,
        locationId: takenAt.locationId,
        takenByMembershipId: takenAt.takenByMembershipId,
        kind: 'installment',
        method,
        amountCents: inst.amountCents,
        processor: null,
        processorRef: body.processorRef ?? null,
        status: 'succeeded',
      })
      .returning();
    await this.db
      .update(schema.paymentPlanInstallments)
      .set({ status: 'paid', paidPaymentId: payment!.id, updatedAt: new Date() })
      .where(eq(schema.paymentPlanInstallments.id, inst.id));

    // Last one in → the plan is complete.
    const open = await this.db
      .select({ id: schema.paymentPlanInstallments.id })
      .from(schema.paymentPlanInstallments)
      .where(
        and(
          eq(schema.paymentPlanInstallments.planId, id),
          inArray(schema.paymentPlanInstallments.status, ['due', 'overdue']),
        ),
      );
    if (open.length === 0) {
      await this.db
        .update(schema.paymentPlans)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(schema.paymentPlans.id, id));
    }

    await this.audit.log({
      action: 'payment_plan.installment_paid',
      targetType: 'payment_plan',
      targetId: id,
      after: { seq, amountCents: inst.amountCents, method, paymentId: payment!.id },
    });
    return this.detail(id);
  }

  private async detail(id: string): Promise<PlanDetail> {
    const [plan] = await this.db
      .select()
      .from(schema.paymentPlans)
      .where(eq(schema.paymentPlans.id, id))
      .limit(1);
    if (!plan) throw new NotFoundException('Plan not found');
    const [order] = await this.db
      .select({ number: schema.orders.number, customerId: schema.orders.customerId })
      .from(schema.orders)
      .where(eq(schema.orders.id, plan.orderId))
      .limit(1);
    const [customer] = order
      ? await this.db
          .select({ firstName: schema.customers.firstName, lastName: schema.customers.lastName })
          .from(schema.customers)
          .where(eq(schema.customers.id, order.customerId))
          .limit(1)
      : [];
    const installments = await this.db
      .select({
        id: schema.paymentPlanInstallments.id,
        seq: schema.paymentPlanInstallments.seq,
        dueDate: schema.paymentPlanInstallments.dueDate,
        amountCents: schema.paymentPlanInstallments.amountCents,
        status: schema.paymentPlanInstallments.status,
        paidPaymentId: schema.paymentPlanInstallments.paidPaymentId,
      })
      .from(schema.paymentPlanInstallments)
      .where(eq(schema.paymentPlanInstallments.planId, id))
      .orderBy(asc(schema.paymentPlanInstallments.seq));
    return {
      id: plan.id,
      orderId: plan.orderId,
      orderNumber: order?.number ?? '?',
      customerName: customer
        ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null
        : null,
      type: plan.type,
      status: plan.status,
      frequency: plan.frequency,
      startDate: plan.startDate,
      installmentAmountCents: plan.installmentAmountCents,
      installments,
    };
  }
}
