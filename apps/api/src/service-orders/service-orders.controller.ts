import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import {
  type PageResponse,
  buildPage,
  clampLimit,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
} from '../common/pagination';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { EmailService } from '../email/email.service';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

type ServiceStatus =
  | 'intake'
  | 'awaiting_parts'
  | 'in_service'
  | 'ready'
  | 'completed'
  | 'cancelled';

/** Board transitions; completed/cancelled are terminal verbs of their own. */
const TRANSITIONS: Record<string, ServiceStatus[]> = {
  intake: ['awaiting_parts', 'in_service', 'cancelled'],
  awaiting_parts: ['in_service', 'intake', 'cancelled'],
  in_service: ['ready', 'awaiting_parts', 'cancelled'],
  ready: ['in_service', 'completed'],
};

const PAYMENT_METHODS = ['cash', 'card', 'external_card', 'check', 'financing'] as const;

interface CreateBody {
  locationId?: string;
  customerId?: string;
  serialUnitId?: string;
  itemDescription?: string;
  issue?: string;
  warranty?: boolean;
  technicianMembershipId?: string | null;
}

interface LineBody {
  variantId?: string;
  description?: string;
  quantity?: number;
  unitPriceCents?: number;
  kind?: 'part' | 'labor';
}

interface Detail {
  id: string;
  number: string;
  status: string;
  locationId: string;
  customerId: string;
  customerName: string | null;
  serialUnitId: string | null;
  serial: string | null;
  itemDescription: string | null;
  issue: string;
  warranty: boolean;
  technicianMembershipId: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceDueCents: number;
  completedAt: Date | null;
  createdAt: Date;
  lines: {
    id: string;
    variantId: string | null;
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    kind: string;
  }[];
  notes: { id: string; body: string; createdAt: Date }[];
}

/**
 * Service orders (STORIS cutover G6): intake → board → ready →
 * completed, with parts/labor charges and the customer notified when
 * their item is ready. Money collected lands in `payments` via
 * service_order_id, so the drawer and tender mix see it natively.
 */
@TenantScoped()
@Controller('v1/service-orders')
export class ServiceOrdersController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  @Get()
  @RequirePermission('service_orders.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('status') status?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<PageResponse<Detail>> {
    const limit = clampLimit(limitStr);
    const cursor = decodeCursor(cursorStr);
    const filters = [];
    if (status) filters.push(eq(schema.serviceOrders.status, status));
    if (cursor) {
      filters.push(
        timestampCursorWhere(schema.serviceOrders.createdAt, schema.serviceOrders.id, cursor)!,
      );
    }
    const rows = await this.db
      .select({ id: schema.serviceOrders.id, createdAt: schema.serviceOrders.createdAt })
      .from(schema.serviceOrders)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(...timestampCursorOrder(schema.serviceOrders.createdAt, schema.serviceOrders.id))
      .limit(limit + 1);
    const page = buildPage(rows, limit, (r) => r.createdAt);
    const data = await Promise.all(page.data.map((r) => this.detail(r.id)));
    return { data, nextCursor: page.nextCursor };
  }

  @Get(':id')
  @RequirePermission('service_orders.view')
  async get(@CurrentTenant() _tenant: RequestTenantContext, @Param('id') id: string) {
    return this.detail(id);
  }

  @Post()
  @RequirePermission('service_orders.create')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: CreateBody,
  ): Promise<Detail> {
    if (!body.locationId) throw new BadRequestException('locationId is required');
    if (!body.customerId) throw new BadRequestException('customerId is required');
    if (!body.issue?.trim()) throw new BadRequestException('issue is required');
    if (!body.serialUnitId && !body.itemDescription?.trim()) {
      throw new BadRequestException('Provide serialUnitId or itemDescription');
    }
    const [customer] = await this.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.id, body.customerId))
      .limit(1);
    if (!customer) throw new NotFoundException('Customer not found');
    if (body.serialUnitId) {
      const [serial] = await this.db
        .select({ id: schema.serialUnits.id })
        .from(schema.serialUnits)
        .where(eq(schema.serialUnits.id, body.serialUnitId))
        .limit(1);
      if (!serial) throw new NotFoundException('Serial unit not found');
      await this.db
        .update(schema.serialUnits)
        .set({ status: 'in_service', updatedAt: new Date() })
        .where(eq(schema.serialUnits.id, body.serialUnitId));
    }

    const number = await this.generateNumber(tenant.businessId!);
    const [row] = await this.db
      .insert(schema.serviceOrders)
      .values({
        businessId: tenant.businessId!,
        locationId: body.locationId,
        number,
        customerId: body.customerId,
        serialUnitId: body.serialUnitId ?? null,
        itemDescription: body.itemDescription ?? null,
        issue: body.issue.trim(),
        warranty: body.warranty ?? false,
        technicianMembershipId: body.technicianMembershipId ?? null,
      })
      .returning();
    await this.audit.log({
      action: 'service_order.create',
      targetType: 'service_order',
      targetId: row!.id,
      after: { number, customerId: body.customerId, warranty: body.warranty ?? false },
    });
    return this.detail(row!.id);
  }

  @Post(':id/status')
  @RequirePermission('service_orders.update')
  async setStatus(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { status?: string; note?: string },
  ): Promise<Detail> {
    const row = await this.load(id);
    const next = body.status as ServiceStatus;
    const allowed = TRANSITIONS[row.status] ?? [];
    if (!next || !allowed.includes(next)) {
      throw new BadRequestException(
        `Cannot go from ${row.status} to ${body.status ?? '(missing)'} — allowed: ${allowed.join(', ') || 'none'}`,
      );
    }
    await this.db
      .update(schema.serviceOrders)
      .set({
        status: next,
        completedAt: next === 'completed' ? new Date() : row.completedAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.serviceOrders.id, id));
    if (body.note?.trim()) {
      await this.db.insert(schema.serviceOrderNotes).values({
        businessId: tenant.businessId!,
        serviceOrderId: id,
        body: body.note.trim(),
      });
    }
    await this.db.insert(schema.serviceOrderNotes).values({
      businessId: tenant.businessId!,
      serviceOrderId: id,
      body: `Status: ${row.status} → ${next}`,
    });
    await this.audit.log({
      action: 'service_order.status',
      targetType: 'service_order',
      targetId: id,
      before: { status: row.status },
      after: { status: next },
    });
    if (next === 'ready') {
      await this.notifyReady(id).catch(() => undefined);
    }
    return this.detail(id);
  }

  @Patch(':id')
  @RequirePermission('service_orders.update')
  async update(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body()
    body: {
      technicianMembershipId?: string | null;
      issue?: string;
      warranty?: boolean;
      /** A22 slice 5: the technician visit date (YYYY-MM-DD, null clears). */
      scheduledFor?: string | null;
    },
  ): Promise<Detail> {
    const before = await this.load(id);
    if (body.scheduledFor != null && !/^\d{4}-\d{2}-\d{2}$/.test(body.scheduledFor)) {
      throw new BadRequestException('scheduledFor must be YYYY-MM-DD');
    }
    await this.db
      .update(schema.serviceOrders)
      .set({
        ...(body.technicianMembershipId !== undefined
          ? { technicianMembershipId: body.technicianMembershipId }
          : {}),
        ...(body.issue !== undefined ? { issue: body.issue } : {}),
        ...(body.warranty !== undefined ? { warranty: body.warranty } : {}),
        ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.serviceOrders.id, id));
    if (body.scheduledFor !== undefined && body.scheduledFor !== before.scheduledFor) {
      await this.audit.log({
        action: 'service_order.schedule',
        targetType: 'service_order',
        targetId: id,
        before: { scheduledFor: before.scheduledFor },
        after: { scheduledFor: body.scheduledFor },
      });
    }
    return this.detail(id);
  }

  @Post(':id/lines')
  @RequirePermission('service_orders.update')
  async addLine(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: LineBody,
  ): Promise<Detail> {
    const row = await this.load(id);
    if (row.completedAt || row.status === 'cancelled') {
      throw new BadRequestException('This ticket is closed');
    }
    const quantity = Number(body.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('quantity must be a positive integer');
    }
    let description = body.description?.trim() ?? '';
    let unitPrice = body.unitPriceCents;
    if (body.variantId) {
      const [variant] = await this.db
        .select({
          id: schema.productVariants.id,
          priceCents: schema.productVariants.priceCents,
          name: schema.productVariants.name,
          productId: schema.productVariants.productId,
        })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, body.variantId))
        .limit(1);
      if (!variant) throw new NotFoundException('Variant not found');
      unitPrice ??= variant.priceCents;
      if (!description) {
        const [product] = await this.db
          .select({ name: schema.products.name })
          .from(schema.products)
          .where(eq(schema.products.id, variant.productId))
          .limit(1);
        description = [product?.name, variant.name].filter(Boolean).join(' — ') || 'Part';
      }
    }
    if (!description) throw new BadRequestException('description is required for labor lines');
    if (unitPrice == null || !Number.isInteger(unitPrice) || unitPrice < 0) {
      throw new BadRequestException('unitPriceCents must be a non-negative integer');
    }
    // Warranty work is free to the customer.
    const effectivePrice = row.warranty ? 0 : unitPrice;
    await this.db.insert(schema.serviceOrderLines).values({
      businessId: tenant.businessId!,
      serviceOrderId: id,
      variantId: body.variantId ?? null,
      description,
      quantity,
      unitPriceCents: effectivePrice,
      totalCents: quantity * effectivePrice,
      kind: body.kind === 'part' || body.variantId ? 'part' : 'labor',
    });
    await this.recomputeTotals(id);
    return this.detail(id);
  }

  @Delete(':id/lines/:lineId')
  @RequirePermission('service_orders.update')
  async removeLine(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ): Promise<Detail> {
    const row = await this.load(id);
    if (row.completedAt || row.status === 'cancelled') {
      throw new BadRequestException('This ticket is closed');
    }
    await this.db
      .delete(schema.serviceOrderLines)
      .where(
        and(
          eq(schema.serviceOrderLines.id, lineId),
          eq(schema.serviceOrderLines.serviceOrderId, id),
        ),
      );
    await this.recomputeTotals(id);
    return this.detail(id);
  }

  @Post(':id/notes')
  @RequirePermission('service_orders.update')
  async addNote(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { body?: string },
  ): Promise<Detail> {
    await this.load(id);
    if (!body.body?.trim()) throw new BadRequestException('body is required');
    await this.db.insert(schema.serviceOrderNotes).values({
      businessId: tenant.businessId!,
      serviceOrderId: id,
      body: body.body.trim(),
    });
    return this.detail(id);
  }

  /** Collect on the ticket; the drawer sees it as ordinary money. */
  @Post(':id/payments')
  @RequirePermission('service_orders.update')
  async takePayment(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { method?: string; amountCents?: number; processorRef?: string },
  ): Promise<Detail> {
    const row = await this.load(id);
    if (row.status === 'cancelled') throw new BadRequestException('Ticket is cancelled');
    const method = body.method ?? 'cash';
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
      throw new BadRequestException(`method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }
    const amount = Number(body.amountCents ?? 0);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }
    const detail = await this.detail(id);
    if (amount > detail.balanceDueCents) {
      throw new BadRequestException(
        `That over-collects: balance due is ${detail.balanceDueCents} cents`,
      );
    }
    await this.db.insert(schema.payments).values({
      businessId: tenant.businessId!,
      saleId: null,
      orderId: null,
      serviceOrderId: id,
      kind: 'sale',
      method,
      amountCents: amount,
      processorRef: body.processorRef ?? null,
      status: 'succeeded',
    });
    await this.audit.log({
      action: 'service_order.payment',
      targetType: 'service_order',
      targetId: id,
      after: { method, amountCents: amount },
    });
    return this.detail(id);
  }

  /** Close the ticket: balance must be collected (warranty tickets are $0). */
  @Post(':id/complete')
  @RequirePermission('service_orders.update')
  async complete(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<Detail> {
    const row = await this.load(id);
    if (row.completedAt) throw new BadRequestException('Ticket is already completed');
    if (row.status === 'cancelled') throw new BadRequestException('Ticket is cancelled');
    const detail = await this.detail(id);
    if (detail.balanceDueCents > 0) {
      throw new BadRequestException(
        `Collect the balance first — ${detail.balanceDueCents} cents due`,
      );
    }
    await this.db
      .update(schema.serviceOrders)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.serviceOrders.id, id));
    // The serviced unit goes back to its owner.
    if (row.serialUnitId) {
      await this.db
        .update(schema.serialUnits)
        .set({ status: 'sold', updatedAt: new Date() })
        .where(eq(schema.serialUnits.id, row.serialUnitId));
    }
    await this.db.insert(schema.serviceOrderNotes).values({
      businessId: tenant.businessId!,
      serviceOrderId: id,
      body: 'Completed — picked up / returned to customer',
    });
    await this.audit.log({
      action: 'service_order.complete',
      targetType: 'service_order',
      targetId: id,
      after: { totalCents: detail.totalCents },
    });
    return this.detail(id);
  }

  // ---------------------------------------------------------------------

  private async load(id: string) {
    const [row] = await this.db
      .select()
      .from(schema.serviceOrders)
      .where(eq(schema.serviceOrders.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Service order not found');
    return row;
  }

  private async recomputeTotals(id: string): Promise<void> {
    const [sums] = await this.db
      .select({
        subtotal: sql<number>`COALESCE(SUM(${schema.serviceOrderLines.totalCents}), 0)::int`,
      })
      .from(schema.serviceOrderLines)
      .where(eq(schema.serviceOrderLines.serviceOrderId, id));
    const subtotal = sums?.subtotal ?? 0;
    // Service work is untaxed by default; jurisdictions that tax parts
    // can price lines gross. Revisit with the tax-class work if needed.
    await this.db
      .update(schema.serviceOrders)
      .set({ subtotalCents: subtotal, taxCents: 0, totalCents: subtotal, updatedAt: new Date() })
      .where(eq(schema.serviceOrders.id, id));
  }

  private async notifyReady(id: string): Promise<void> {
    const row = await this.load(id);
    if (row.importedAt) return; // D8
    const [customer] = await this.db
      .select({ email: schema.customers.email, firstName: schema.customers.firstName })
      .from(schema.customers)
      .where(eq(schema.customers.id, row.customerId))
      .limit(1);
    if (!customer?.email) return;
    const [biz] = await this.db
      .select({ name: schema.businesses.name })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, row.businessId))
      .limit(1);
    const store = biz?.name ?? 'the store';
    await this.email.send({
      to: customer.email,
      subject: `Your service is ready — ${row.number}`,
      text: `Hi${customer.firstName ? ` ${customer.firstName}` : ''},\n\nYour item from service ticket ${row.number} is ready for pickup at ${store}.\n\n— ${store}`,
      html: `<p>Hi${customer.firstName ? ` ${customer.firstName}` : ''},</p><p>Your item from service ticket <strong>${row.number}</strong> is ready for pickup at ${store}.</p><p>— ${store}</p>`,
    });
  }

  private async detail(id: string): Promise<Detail> {
    const row = await this.load(id);
    const [customer] = await this.db
      .select({ firstName: schema.customers.firstName, lastName: schema.customers.lastName })
      .from(schema.customers)
      .where(eq(schema.customers.id, row.customerId))
      .limit(1);
    const [serial] = row.serialUnitId
      ? await this.db
          .select({ serial: schema.serialUnits.serial })
          .from(schema.serialUnits)
          .where(eq(schema.serialUnits.id, row.serialUnitId))
          .limit(1)
      : [];
    const lines = await this.db
      .select()
      .from(schema.serviceOrderLines)
      .where(eq(schema.serviceOrderLines.serviceOrderId, id));
    const notes = await this.db
      .select({
        id: schema.serviceOrderNotes.id,
        body: schema.serviceOrderNotes.body,
        createdAt: schema.serviceOrderNotes.createdAt,
      })
      .from(schema.serviceOrderNotes)
      .where(eq(schema.serviceOrderNotes.serviceOrderId, id))
      .orderBy(asc(schema.serviceOrderNotes.createdAt));
    const pays = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.serviceOrderId, id));
    const paid = pays
      .filter((p) => p.status === 'succeeded')
      .reduce((s, p) => s + p.amountCents, 0);
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      locationId: row.locationId,
      customerId: row.customerId,
      customerName: customer
        ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null
        : null,
      serialUnitId: row.serialUnitId,
      serial: serial?.serial ?? null,
      itemDescription: row.itemDescription,
      issue: row.issue,
      warranty: row.warranty,
      technicianMembershipId: row.technicianMembershipId,
      subtotalCents: row.subtotalCents,
      taxCents: row.taxCents,
      totalCents: row.totalCents,
      paidCents: paid,
      balanceDueCents: Math.max(0, row.totalCents - paid),
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      lines: lines.map((l) => ({
        id: l.id,
        variantId: l.variantId,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        totalCents: l.totalCents,
        kind: l.kind,
      })),
      notes,
    };
  }

  private async generateNumber(businessId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 8; attempt++) {
      const rows = await this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.serviceOrders)
        .where(
          and(
            eq(schema.serviceOrders.businessId, businessId),
            sql`${schema.serviceOrders.number} LIKE ${`SV-${year}-%`}`,
          ),
        );
      const seq = (rows[0]?.count ?? 0) + 1 + attempt;
      const candidate = `SV-${year}-${String(seq).padStart(6, '0')}`;
      const [existing] = await this.db
        .select({ id: schema.serviceOrders.id })
        .from(schema.serviceOrders)
        .where(
          and(
            eq(schema.serviceOrders.businessId, businessId),
            eq(schema.serviceOrders.number, candidate),
          ),
        )
        .limit(1);
      if (!existing) return candidate;
    }
    return `SV-${year}-${Math.random().toString().slice(2, 8)}`;
  }
}
