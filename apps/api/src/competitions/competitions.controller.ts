import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { phoneDigits } from '@jetnine/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';
import {
  CompetitionsService,
  type CompetitionBoard,
  type HistoryRow,
  type LeadRow,
  type WinnerLine,
} from './competitions.service';

const SIZES = ['Twin', 'Twin XL', 'Full', 'Queen', 'King', 'Cal King'];
/** What the shopper wants: the Mattresses subcategories of the catalog tree (A22.1), a base, or a named product. */
const CATEGORIES = [
  'Hybrid',
  'Memory Foam',
  'Innerspring',
  'Latex',
  'Adjustable base',
  'Specific product',
];

/**
 * The competition strip's API (redesign Phase 11): the board, the closed
 * months, the winners sheet, and the leads a salesperson logs. Reads are
 * `competitions.view`; the lead verbs are `competitions.leads.log` and act
 * on the caller's own leads (a manager with `reports.sales.view` sees the
 * store's list, but still cannot attach or lose someone else's lead).
 */
@TenantScoped()
@Controller('v1/competitions')
export class CompetitionsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(CompetitionsService) private readonly competitions: CompetitionsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  @Get('current')
  @RequirePermission('competitions.view')
  async current(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('month') month?: string,
  ): Promise<CompetitionBoard> {
    const cfg = await this.competitions.config(tenant.businessId!);
    if (!cfg.enabled) throw new NotFoundException('Competitions are off');
    const role = tenant.roleName;
    const hidden =
      (role === 'Cashier' && !cfg.visibility.sales) ||
      (role === 'Manager' && !cfg.visibility.managers) ||
      (role === 'Warehouse' && !cfg.visibility.warehouse);
    if (hidden) throw new NotFoundException('Competitions are hidden for this role');
    return this.competitions.board(tenant, { month });
  }

  @Get('history')
  @RequirePermission('competitions.view')
  history(@CurrentTenant() tenant: RequestTenantContext): Promise<HistoryRow[]> {
    return this.competitions.history(tenant);
  }

  /** The printable winners sheet for a closed month (default: last month). */
  @Get('sheet')
  @RequirePermission('competitions.view')
  async sheet(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('month') monthQ?: string,
  ): Promise<{
    month: string;
    label: string;
    payoutLabel: string;
    /** The one prize every race pays, or null when they differ (each winner carries its own). */
    prizeCents: number | null;
    winners: WinnerLine[];
  }> {
    const businessId = tenant.businessId!;
    const cfg = await this.competitions.config(businessId);
    const { today } = await this.competitions.clock(businessId);
    const cur = today.slice(0, 7);
    const [y, m] = cur.split('-').map(Number) as [number, number];
    const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    const month = monthQ && /^\d{4}-\d{2}$/.test(monthQ) && monthQ < cur ? monthQ : lastMonth;
    const winners = await this.competitions.winners(tenant, month);
    const [py, pm] = month.split('-').map(Number) as [number, number];
    const next = new Date(Date.UTC(py, pm, 1));
    const payMonth = next.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
    return {
      month,
      label: new Date(Date.UTC(py, pm - 1, 1)).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      payoutLabel: `${payMonth} ${cfg.payoutDay}`,
      prizeCents: winners.every((w) => w.prizeCents === winners[0]?.prizeCents)
        ? (winners[0]?.prizeCents ?? null)
        : null,
      winners,
    };
  }

  // ---------------------------------------------------------------------
  // Leads

  @Get('leads')
  @RequirePermission('competitions.view')
  leads(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('all') all?: string,
  ): Promise<LeadRow[]> {
    return this.competitions.leads(tenant, all === '1' || all === 'true');
  }

  @Post('leads')
  @RequirePermission('competitions.leads.log')
  async logLead(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body()
    body: {
      name?: string;
      phone?: string;
      wantedSize?: string | null;
      wantedCategory?: string | null;
      note?: string | null;
      locationId?: string | null;
    },
  ): Promise<LeadRow> {
    const businessId = tenant.businessId!;
    if (!tenant.membershipId) throw new ForbiddenException('Leads are logged under a member');
    const phone = (body.phone ?? '').trim();
    const digits = phoneDigits(phone);
    if (!digits)
      throw new BadRequestException('A phone number is what matches the sale — it is required');
    const name = (body.name ?? '').trim().slice(0, 80);
    const wantedSize = body.wantedSize && SIZES.includes(body.wantedSize) ? body.wantedSize : null;
    const wantedCategory =
      CATEGORIES.find(
        (c) => c.toLowerCase() === (body.wantedCategory ?? '').trim().toLowerCase(),
      ) ?? null;
    const note = body.note?.trim().slice(0, 160) || null;
    const cfg = await this.competitions.config(businessId);
    const { stores } = await this.competitions.clock(businessId);
    let locationId =
      body.locationId && stores.some((s) => s.id === body.locationId) ? body.locationId : null;
    if (!locationId) {
      const board = await this.competitions.board(tenant);
      locationId = board.viewer.storeId ?? stores[0]?.id ?? null;
    }
    if (!locationId) throw new BadRequestException('No selling store to log the lead at');

    // The same phone already open under this salesperson: refresh, do not duplicate.
    const [dup] = await this.db
      .select({ id: schema.salesLeads.id })
      .from(schema.salesLeads)
      .where(
        and(
          eq(schema.salesLeads.businessId, businessId),
          eq(schema.salesLeads.salespersonMembershipId, tenant.membershipId),
          eq(schema.salesLeads.status, 'open'),
          eq(schema.salesLeads.phoneDigits, digits),
        ),
      )
      .limit(1);
    const expiresAt = new Date(Date.now() + cfg.leadWindowDays * 86_400_000);
    let id: string;
    if (dup) {
      await this.db
        .update(schema.salesLeads)
        .set({
          name: name || undefined,
          wantedSize,
          wantedCategory,
          note,
          expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.salesLeads.id, dup.id));
      id = dup.id;
    } else {
      const [ins] = await this.db
        .insert(schema.salesLeads)
        .values({
          businessId,
          locationId,
          salespersonMembershipId: tenant.membershipId,
          name,
          phone,
          phoneDigits: digits,
          wantedSize,
          wantedCategory,
          note,
          expiresAt,
        })
        .returning({ id: schema.salesLeads.id });
      id = ins!.id;
    }
    await this.audit.log({
      action: dup ? 'lead.refresh' : 'lead.log',
      targetType: 'sales_lead',
      targetId: id,
      metadata: { name, phoneDigits: digits, wantedSize, wantedCategory, locationId },
    });
    if (!dup) {
      void this.webhooks.fire({
        businessId,
        eventType: 'lead.logged',
        payload: {
          leadId: id,
          name,
          phone,
          wantedSize,
          wantedCategory,
          locationId,
          salespersonMembershipId: tenant.membershipId,
        },
      });
    }
    return this.leadById(tenant, id);
  }

  private async leadById(tenant: RequestTenantContext, id: string): Promise<LeadRow> {
    const rows = await this.competitions.leads(tenant, true);
    const row = rows.find((l) => l.id === id);
    if (!row) throw new NotFoundException('Lead not found');
    return row;
  }

  private async ownLead(tenant: RequestTenantContext, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Lead not found');
    const [lead] = await this.db
      .select()
      .from(schema.salesLeads)
      .where(
        and(eq(schema.salesLeads.businessId, tenant.businessId!), eq(schema.salesLeads.id, id)),
      )
      .limit(1);
    if (!lead) throw new NotFoundException('Lead not found');
    // The contract: only the salesperson who logged the lead can follow it
    // up, attach an order or lose it — a manager's verb would move someone
    // else's Lead Conversion number.
    if (lead.salespersonMembershipId !== tenant.membershipId) {
      throw new ForbiddenException('Only the salesperson who logged the lead can change it');
    }
    if (lead.status !== 'open')
      throw new BadRequestException(`That lead is already ${lead.status}`);
    return lead;
  }

  @Post('leads/:id/follow-up')
  @RequirePermission('competitions.leads.log')
  async followUp(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { at?: string },
  ): Promise<LeadRow> {
    const lead = await this.ownLead(tenant, id);
    const at =
      body.at && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at) : nextMorning(new Date());
    await this.db
      .update(schema.salesLeads)
      .set({ followUpAt: at, updatedAt: new Date() })
      .where(eq(schema.salesLeads.id, lead.id));
    await this.audit.log({
      action: 'lead.follow_up',
      targetType: 'sales_lead',
      targetId: lead.id,
      metadata: { at: at.toISOString() },
    });
    return this.leadById(tenant, lead.id);
  }

  /** Attach an order by hand — audited, and the conversion says so. */
  @Post('leads/:id/attach')
  @RequirePermission('competitions.leads.log')
  async attach(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { orderId?: string; orderNumber?: string },
  ): Promise<LeadRow> {
    const lead = await this.ownLead(tenant, id);
    const [order] = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        repId: schema.orders.salespersonMembershipId,
        importedAt: schema.orders.importedAt,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, tenant.businessId!),
          body.orderId && /^[0-9a-f-]{36}$/i.test(body.orderId)
            ? eq(schema.orders.id, body.orderId)
            : eq(schema.orders.number, (body.orderNumber ?? '').trim().toUpperCase()),
        ),
      )
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    if (order.importedAt) throw new BadRequestException('Imported legacy orders never count');
    if (['draft', 'quote', 'cancelled'].includes(order.status)) {
      throw new BadRequestException(
        `${order.number} is ${order.status} — attach a written or completed order`,
      );
    }
    if (order.repId !== lead.salespersonMembershipId) {
      throw new BadRequestException(`${order.number} is not written under this salesperson`);
    }
    await this.db
      .update(schema.salesLeads)
      .set({
        status: 'converted',
        convertedOrderId: order.id,
        convertedAt: new Date(),
        conversion: 'manual',
        updatedAt: new Date(),
      })
      .where(eq(schema.salesLeads.id, lead.id));
    await this.audit.log({
      action: 'lead.convert',
      targetType: 'sales_lead',
      targetId: lead.id,
      metadata: {
        orderId: order.id,
        orderNumber: order.number,
        conversion: 'manual',
        name: lead.name,
      },
    });
    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'lead.converted',
      payload: {
        leadId: lead.id,
        orderId: order.id,
        orderNumber: order.number,
        conversion: 'manual',
      },
    });
    return this.leadById(tenant, lead.id);
  }

  @Post('leads/:id/lost')
  @RequirePermission('competitions.leads.log')
  async lost(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<LeadRow> {
    const lead = await this.ownLead(tenant, id);
    await this.db
      .update(schema.salesLeads)
      .set({ status: 'lost', lostAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.salesLeads.id, lead.id));
    await this.audit.log({ action: 'lead.lost', targetType: 'sales_lead', targetId: lead.id });
    return this.leadById(tenant, lead.id);
  }
}

/** Tomorrow at 10:00 in the server's clock — the follow-up reminder time. */
function nextMorning(now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}
