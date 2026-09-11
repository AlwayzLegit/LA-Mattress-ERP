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
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import {
  buildPage,
  clampLimit as clampPageLimit,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
} from '../common/pagination';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

interface CustomerRow {
  id: string;
  email: string | null;
  phone: string | null;
  phone2: string | null;
  /** A20 (STORIS Billing Information): work phone + extension. */
  workPhone: string | null;
  workPhoneExt: string | null;
  firstName: string | null;
  lastName: string | null;
  notes: string | null;
  addressesJson: unknown;
  referralSource: string | null;
  /** A22 slice 6 (STORIS Update a Customer Address): number, trade names, name parts, alternate contact, standing instructions. */
  customerNumber: string | null;
  businessName: string | null;
  contactName: string | null;
  prefix: string | null;
  middleName: string | null;
  suffix: string | null;
  alternateName: string | null;
  alternateRelationship: string | null;
  deliveryInstructions: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CreateBody {
  email?: string | null;
  phone?: string | null;
  phone2?: string | null;
  workPhone?: string | null;
  workPhoneExt?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  notes?: string | null;
  addressesJson?: unknown;
  referralSource?: string | null;
  businessName?: string | null;
  contactName?: string | null;
  prefix?: string | null;
  middleName?: string | null;
  suffix?: string | null;
  alternateName?: string | null;
  alternateRelationship?: string | null;
  deliveryInstructions?: string | null;
}

/** The free-text fields create and update share (the number is assigned, never typed). */
const TEXT_FIELDS = [
  'email',
  'phone',
  'phone2',
  'workPhone',
  'workPhoneExt',
  'firstName',
  'lastName',
  'notes',
  'referralSource',
  'businessName',
  'contactName',
  'prefix',
  'middleName',
  'suffix',
  'alternateName',
  'alternateRelationship',
  'deliveryInstructions',
] as const;

type UpdateBody = CreateBody;

@TenantScoped()
@Controller('v1/customers')
export class CustomersController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  /**
   * List customers, optionally filtered by `q` (matches name, email,
   * phone via the customers.search_tsv generated tsvector).
   */
  @Get()
  @RequirePermission('customers.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('q') q?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<PageResponse<CustomerRow>> {
    const limit = clampPageLimit(limitStr);
    if (q && q.trim().length > 0) {
      // Search returns ts_rank-ordered results; cursor pagination over a
      // dynamic ranking is not meaningful, so a single page is returned
      // with `nextCursor: null`. Clients refine with the next query.
      const normalized = q.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
      const tsq = sql`websearch_to_tsquery('simple', ${normalized})`;
      const data = await this.db
        .select(SELECT_COLS)
        .from(schema.customers)
        .where(sql`${schema.customers.searchTsv} @@ ${tsq}`)
        .orderBy(desc(sql`ts_rank(${schema.customers.searchTsv}, ${tsq})`))
        .limit(limit);
      return { data, nextCursor: null };
    }
    const cursor = decodeCursor(cursorStr);
    const where = cursor
      ? timestampCursorWhere(schema.customers.createdAt, schema.customers.id, cursor)
      : undefined;
    const rows = await this.db
      .select(SELECT_COLS)
      .from(schema.customers)
      .where(where)
      .orderBy(...timestampCursorOrder(schema.customers.createdAt, schema.customers.id))
      .limit(limit + 1);
    return buildPage(rows, limit, (r) => r.createdAt);
  }

  @Get(':id')
  @RequirePermission('customers.view')
  async get(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<CustomerRow & { recentSales: SaleSummary[] }> {
    const [row] = await this.db
      .select(SELECT_COLS)
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Customer not found');

    // Recent sales for the purchase-history section. Epic 1.10 will start
    // populating sales rows; until then this is just an empty list, which
    // the page renders as "no purchases yet".
    const recentSales = await this.db
      .select({
        id: schema.sales.id,
        number: schema.sales.number,
        status: schema.sales.status,
        totalCents: schema.sales.totalCents,
        completedAt: schema.sales.completedAt,
        createdAt: schema.sales.createdAt,
      })
      .from(schema.sales)
      .where(eq(schema.sales.customerId, id))
      .orderBy(desc(schema.sales.createdAt))
      .limit(20);

    return { ...row, recentSales };
  }

  /**
   * Customer 360 summary (Sales Views Phase 4): lifetime and
   * year-to-date activity totals over POS sales + orders, and the open
   * orders with their computed balance (Balance = Total − Amount Paid —
   * derived, never stored). Imported documents count toward totals:
   * their history is real even though their money flows are excluded
   * elsewhere.
   */
  @Get(':id/summary')
  @RequirePermission('customers.view')
  async summary(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{
    lifetime: { documents: number; totalCents: number };
    ytd: { documents: number; totalCents: number };
    openOrders: {
      id: string;
      number: string;
      status: string;
      totalCents: number;
      paidCents: number;
      balanceCents: number;
      requestedDate: string | null;
    }[];
  }> {
    const [exists] = await this.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    if (!exists) throw new NotFoundException('Customer not found');
    const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));

    const [saleTotals] = await this.db
      .select({
        documents: sql<number>`COUNT(*)::int`,
        totalCents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}), 0)::int`,
        ytdDocuments: sql<number>`COUNT(*) FILTER (WHERE ${schema.sales.completedAt} >= ${yearStart.toISOString()}::timestamptz)::int`,
        ytdTotalCents: sql<number>`COALESCE(SUM(${schema.sales.totalCents}) FILTER (WHERE ${schema.sales.completedAt} >= ${yearStart.toISOString()}::timestamptz), 0)::int`,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.customerId, id),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
        ),
      );
    const [orderTotals] = await this.db
      .select({
        documents: sql<number>`COUNT(*)::int`,
        totalCents: sql<number>`COALESCE(SUM(${schema.orders.totalCents}), 0)::int`,
        ytdDocuments: sql<number>`COUNT(*) FILTER (WHERE ${schema.orders.createdAt} >= ${yearStart.toISOString()}::timestamptz)::int`,
        ytdTotalCents: sql<number>`COALESCE(SUM(${schema.orders.totalCents}) FILTER (WHERE ${schema.orders.createdAt} >= ${yearStart.toISOString()}::timestamptz), 0)::int`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.customerId, id),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
        ),
      );

    const open = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        totalCents: schema.orders.totalCents,
        requestedDate: schema.orders.requestedDate,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.customerId, id),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled', 'completed')`,
        ),
      )
      .orderBy(desc(schema.orders.createdAt))
      .limit(50);
    const paid = open.length
      ? await this.db
          .select({
            orderId: schema.payments.orderId,
            paidCents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
          })
          .from(schema.payments)
          .where(
            and(
              inArray(
                schema.payments.orderId,
                open.map((o) => o.id),
              ),
              eq(schema.payments.status, 'succeeded'),
            ),
          )
          .groupBy(schema.payments.orderId)
      : [];
    const paidBy = new Map(paid.map((p) => [p.orderId, p.paidCents]));

    return {
      lifetime: {
        documents: (saleTotals?.documents ?? 0) + (orderTotals?.documents ?? 0),
        totalCents: (saleTotals?.totalCents ?? 0) + (orderTotals?.totalCents ?? 0),
      },
      ytd: {
        documents: (saleTotals?.ytdDocuments ?? 0) + (orderTotals?.ytdDocuments ?? 0),
        totalCents: (saleTotals?.ytdTotalCents ?? 0) + (orderTotals?.ytdTotalCents ?? 0),
      },
      openOrders: open.map((o) => {
        const paidCents = paidBy.get(o.id) ?? 0;
        return { ...o, paidCents, balanceCents: o.totalCents - paidCents };
      }),
    };
  }

  @Post()
  @RequirePermission('customers.create')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: CreateBody,
  ): Promise<CustomerRow> {
    if (!hasAnyIdentity(body)) {
      throw new BadRequestException(
        'At least one of firstName, lastName, email, or phone is required',
      );
    }
    const [row] = await this.db
      .insert(schema.customers)
      .values({
        businessId: tenant.businessId!,
        email: normalize(body.email),
        phone: normalize(body.phone),
        phone2: normalize(body.phone2),
        workPhone: normalize(body.workPhone),
        workPhoneExt: normalize(body.workPhoneExt),
        firstName: normalize(body.firstName),
        lastName: normalize(body.lastName),
        notes: normalize(body.notes),
        addressesJson: (body.addressesJson ?? null) as never,
        referralSource: normalize(body.referralSource),
        customerNumber: await this.nextCustomerNumber(tenant.businessId!),
        businessName: normalize(body.businessName),
        contactName: normalize(body.contactName),
        prefix: normalize(body.prefix),
        middleName: normalize(body.middleName),
        suffix: normalize(body.suffix),
        alternateName: normalize(body.alternateName),
        alternateRelationship: normalize(body.alternateRelationship),
        deliveryInstructions: normalize(body.deliveryInstructions),
      })
      .returning(SELECT_COLS);
    if (!row) throw new BadRequestException('failed to create customer');
    await this.audit.log({
      action: 'customer.create',
      targetType: 'customer',
      targetId: row.id,
      after: {
        email: row.email,
        phone: row.phone,
        firstName: row.firstName,
        lastName: row.lastName,
      },
    });
    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'customer.created',
      payload: {
        customerId: row.id,
        email: row.email,
        phone: row.phone,
        firstName: row.firstName,
        lastName: row.lastName,
      },
    });
    return row;
  }

  @Patch(':id')
  @RequirePermission('customers.update')
  async update(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: UpdateBody,
  ): Promise<CustomerRow> {
    const [existing] = await this.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Customer not found');

    const update: Partial<typeof schema.customers.$inferInsert> = { updatedAt: new Date() };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const key of TEXT_FIELDS) {
      const v = body[key as keyof UpdateBody];
      if (v !== undefined) {
        const next = normalize(v as string | null | undefined);
        if (next !== existing[key]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (update as any)[key] = next;
          before[key] = existing[key];
          after[key] = next;
        }
      }
    }
    if (body.addressesJson !== undefined) {
      update.addressesJson = body.addressesJson as never;
      before.addressesJson = existing.addressesJson;
      after.addressesJson = body.addressesJson;
    }

    if (Object.keys(after).length === 0) {
      const [unchanged] = await this.db
        .select(SELECT_COLS)
        .from(schema.customers)
        .where(eq(schema.customers.id, id))
        .limit(1);
      return unchanged!;
    }

    const [updated] = await this.db
      .update(schema.customers)
      .set(update)
      .where(eq(schema.customers.id, id))
      .returning(SELECT_COLS);
    if (!updated) throw new NotFoundException('Customer not found after update');

    await this.audit.log({
      action: 'customer.update',
      targetType: 'customer',
      targetId: id,
      before,
      after,
    });
    return updated;
  }

  /**
   * A22 slice 6: `C-000001`-style numbers per business, assigned at
   * creation (the migration numbered existing customers in creation
   * order). Count + retry past a collision, like every document number.
   */
  private async nextCustomerNumber(businessId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.customers)
        .where(eq(schema.customers.businessId, businessId));
      const candidate = `C-${String((row?.count ?? 0) + 1 + attempt).padStart(6, '0')}`;
      const [dup] = await this.db
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(
          and(
            eq(schema.customers.businessId, businessId),
            eq(schema.customers.customerNumber, candidate),
          ),
        )
        .limit(1);
      if (!dup) return candidate;
    }
    return `C-${Date.now().toString().slice(-6)}`;
  }

  /**
   * Possible duplicates of one customer (handoff G4): same phone
   * digits, same email, or the same exact name. The register created
   * the same caller four to six times, and every duplicate breaks the
   * phone-call flow — this list feeds the merge tool below.
   */
  @Get(':id/duplicates')
  @RequirePermission('customers.view')
  async duplicates(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<
    {
      id: string;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
      email: string | null;
      matchedBy: string;
      docCount: number;
    }[]
  > {
    const [me] = await this.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    if (!me) throw new NotFoundException('Customer not found');

    const digitsOf = (v: string | null) => (v ?? '').replace(/\D/g, '');
    const myDigits = [digitsOf(me.phone), digitsOf(me.phone2)].filter((d) => d.length >= 7);
    const fullName = [me.firstName, me.lastName].filter(Boolean).join(' ').trim().toLowerCase();
    // Either of MY numbers matching either of THEIR numbers is a hit.
    const phoneCond =
      myDigits.length > 0
        ? (or(
            ...myDigits.flatMap((d) => [
              sql`regexp_replace(COALESCE(${schema.customers.phone}, ''), '\\D', '', 'g') = ${d}`,
              sql`regexp_replace(COALESCE(${schema.customers.phone2}, ''), '\\D', '', 'g') = ${d}`,
            ]),
          ) ?? sql`false`)
        : sql`false`;
    const emailCond = me.email
      ? sql`LOWER(${schema.customers.email}) = ${me.email.toLowerCase()}`
      : sql`false`;
    const nameCond = fullName
      ? sql`LOWER(TRIM(CONCAT(COALESCE(${schema.customers.firstName}, ''), ' ', COALESCE(${schema.customers.lastName}, '')))) = ${fullName}`
      : sql`false`;

    const rows = await this.db
      .select({
        id: schema.customers.id,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        phone: schema.customers.phone,
        email: schema.customers.email,
        phoneHit: sql<boolean>`${phoneCond}`,
        emailHit: sql<boolean>`${emailCond}`,
      })
      .from(schema.customers)
      .where(
        and(
          eq(schema.customers.businessId, tenant.businessId!),
          ne(schema.customers.id, id),
          or(phoneCond, emailCond, nameCond),
        ),
      )
      .orderBy(desc(schema.customers.updatedAt))
      .limit(10);
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const docCounts = new Map<string, number>();
    for (const table of [schema.orders, schema.sales] as const) {
      const counts = await this.db
        .select({ customerId: table.customerId, n: sql<number>`count(*)::int` })
        .from(table)
        .where(inArray(table.customerId, ids))
        .groupBy(table.customerId);
      for (const c of counts) {
        if (c.customerId) docCounts.set(c.customerId, (docCounts.get(c.customerId) ?? 0) + c.n);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      phone: r.phone,
      email: r.email,
      matchedBy: r.phoneHit ? 'phone' : r.emailHit ? 'email' : 'name',
      docCount: docCounts.get(r.id) ?? 0,
    }));
  }

  /**
   * Merge a duplicate into this customer (handoff G4, owner-picked
   * warn-plus-merge). Every document and ledger entry the duplicate
   * owns — orders, receipts, store credit, returns, service tickets,
   * notes, tags, gift cards, serialized units, discount redemptions —
   * re-homes onto :id, blank contact fields backfill from the
   * duplicate, and the duplicate row is deleted. One customer, one
   * history.
   */
  @Post(':id/merge')
  @RequirePermission('customers.update')
  async merge(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { sourceCustomerId?: string },
  ): Promise<CustomerRow> {
    const sourceId = body.sourceCustomerId;
    if (!sourceId) throw new BadRequestException('sourceCustomerId is required');
    if (sourceId === id) {
      throw new BadRequestException('A customer cannot be merged into themselves');
    }
    const [target] = await this.db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.id, id), eq(schema.customers.businessId, tenant.businessId!)))
      .limit(1);
    if (!target) throw new NotFoundException('Customer not found');
    const [source] = await this.db
      .select()
      .from(schema.customers)
      .where(
        and(eq(schema.customers.id, sourceId), eq(schema.customers.businessId, tenant.businessId!)),
      )
      .limit(1);
    if (!source) throw new NotFoundException('Duplicate customer not found');

    // Re-home every reference. Tag links dedupe against the target's
    // existing tags before the leftovers are dropped with the source.
    const repoint: [string, string][] = [
      ['orders', 'customer_id'],
      ['sales', 'customer_id'],
      ['store_credit_entries', 'customer_id'],
      ['order_returns', 'customer_id'],
      ['discount_redemptions', 'customer_id'],
      ['service_orders', 'customer_id'],
      ['customer_notes', 'customer_id'],
      ['serial_units', 'customer_id'],
      ['gift_cards', 'issued_for_customer_id'],
    ];
    for (const [table, column] of repoint) {
      await this.db.execute(
        sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${id} WHERE ${sql.identifier(column)} = ${sourceId}`,
      );
    }
    await this.db.execute(sql`
      UPDATE customer_tag_links l SET customer_id = ${id}
      WHERE l.customer_id = ${sourceId}
        AND NOT EXISTS (
          SELECT 1 FROM customer_tag_links x
          WHERE x.customer_id = ${id} AND x.tag_id = l.tag_id
        )`);
    await this.db.execute(sql`DELETE FROM customer_tag_links WHERE customer_id = ${sourceId}`);

    // Blank contact fields on the keeper backfill from the duplicate.
    const backfill: Record<string, unknown> = {};
    if (!target.phone && source.phone) backfill.phone = source.phone;
    if (!target.phone2 && source.phone2) backfill.phone2 = source.phone2;
    if (!target.workPhone && source.workPhone) {
      backfill.workPhone = source.workPhone;
      backfill.workPhoneExt = source.workPhoneExt;
    }
    if (!target.email && source.email) backfill.email = source.email;
    if (!target.firstName && source.firstName) backfill.firstName = source.firstName;
    if (!target.lastName && source.lastName) backfill.lastName = source.lastName;
    if (!target.referralSource && source.referralSource) {
      backfill.referralSource = source.referralSource;
    }
    const targetAddresses = Array.isArray(target.addressesJson)
      ? (target.addressesJson as unknown[])
      : [];
    if (targetAddresses.length === 0 && Array.isArray(source.addressesJson)) {
      backfill.addressesJson = source.addressesJson;
    }
    if (!target.notes && source.notes) backfill.notes = source.notes;
    if (Object.keys(backfill).length > 0) {
      await this.db
        .update(schema.customers)
        .set({ ...backfill, updatedAt: new Date() })
        .where(eq(schema.customers.id, id));
    }

    await this.db.delete(schema.customers).where(eq(schema.customers.id, sourceId));

    await this.audit.log({
      action: 'customer.merge',
      targetType: 'customer',
      targetId: id,
      before: {
        mergedCustomerId: sourceId,
        mergedName: [source.firstName, source.lastName].filter(Boolean).join(' '),
        mergedPhone: source.phone,
        mergedEmail: source.email,
      },
      after: { keptCustomerId: id },
    });
    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'customer.merged',
      payload: {
        customerId: id,
        mergedCustomerId: sourceId,
        mergedPhone: source.phone,
        mergedEmail: source.email,
      },
    });

    const [row] = await this.db
      .select(SELECT_COLS)
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    return row!;
  }

  @Delete(':id')
  @RequirePermission('customers.delete')
  async delete(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ deleted: true }> {
    const [existing] = await this.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Customer not found');
    // Sales reference customers via ON DELETE SET NULL, so removing the
    // customer record preserves the historical sale.
    await this.db.delete(schema.customers).where(eq(schema.customers.id, id));
    await this.audit.log({
      action: 'customer.delete',
      targetType: 'customer',
      targetId: id,
      before: {
        email: existing.email,
        phone: existing.phone,
        firstName: existing.firstName,
        lastName: existing.lastName,
      },
    });
    return { deleted: true };
  }
}

interface SaleSummary {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  completedAt: Date | null;
  createdAt: Date;
}

const SELECT_COLS = {
  id: schema.customers.id,
  email: schema.customers.email,
  phone: schema.customers.phone,
  phone2: schema.customers.phone2,
  workPhone: schema.customers.workPhone,
  workPhoneExt: schema.customers.workPhoneExt,
  firstName: schema.customers.firstName,
  lastName: schema.customers.lastName,
  notes: schema.customers.notes,
  addressesJson: schema.customers.addressesJson,
  referralSource: schema.customers.referralSource,
  customerNumber: schema.customers.customerNumber,
  businessName: schema.customers.businessName,
  contactName: schema.customers.contactName,
  prefix: schema.customers.prefix,
  middleName: schema.customers.middleName,
  suffix: schema.customers.suffix,
  alternateName: schema.customers.alternateName,
  alternateRelationship: schema.customers.alternateRelationship,
  deliveryInstructions: schema.customers.deliveryInstructions,
  createdAt: schema.customers.createdAt,
  updatedAt: schema.customers.updatedAt,
} as const;

function normalize(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasAnyIdentity(body: CreateBody): boolean {
  return Boolean(
    normalize(body.firstName) ||
    normalize(body.lastName) ||
    normalize(body.email) ||
    normalize(body.phone),
  );
}

void and;
