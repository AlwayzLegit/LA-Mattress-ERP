import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { salesScopeCond } from '../common/sales-scope';
import { ExceptionsService } from '../controls/exceptions.service';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

/**
 * Cash pickups (redesign Phase 9, README §3.5). Every store holds the
 * cash it took until somebody carries it out: the queue says how much
 * is on hand since the last pickup, how old the oldest note is, and
 * whether a pickup is **due** (more than $1,500 on hand, or any cash
 * payment older than three days). Recording a pickup counts the drawer
 * against the payments ticked (none ticked = all of them), writes the
 * slip, and posting stamps every payment with who and when, issues
 * `PU-nnnn`, and flags any variance to the 10pm exception register.
 *
 * Who may post: anyone with `pos.cash.pickup_record` — the owner and
 * Operations for every store, a manager for the store they run (the
 * stores their membership is scoped to). The older per-payment tick
 * (`pos.cash.pickup_confirm`) still works and is what a posted pickup
 * writes for each payment, so both views agree.
 *
 * Owner hand-off (owner 2026-09-30): the pickup is the first step of a
 * custody chain. Whoever posts it has carried the cash out of the store;
 * the owner (`pos.cash.pickup_owner_receive`) then ticks that the cash
 * is in their hands — "received from <operator>". A pickup the owner
 * posts themselves is received from the store on the spot. Pickups still
 * with an operator sit on the owner's dashboard until ticked.
 */

export const PICKUP_DUE_CENTS = 150_000;
export const PICKUP_DUE_DAYS = 3;
/**
 * How far back the drawer is read. Cash is "on hand" while it has no
 * pickup receipt, whatever the last pickup's timestamp — a partial
 * pickup leaves the unticked notes in the drawer — but a tenant with
 * years of never-ticked history should not wake up with every store due,
 * so payments older than this never count.
 */
export const PICKUP_LOOKBACK_DAYS = 60;

export type PickupStatus = 'none' | 'collected' | 'holding' | 'due';

export interface PendingCashRow {
  paymentId: string;
  docKind: 'order' | 'sale' | 'service';
  docId: string;
  docNumber: string;
  customerName: string | null;
  salespersonName: string | null;
  paidAt: Date;
  /** Store-local days since the payment was taken (0 = today). */
  ageDays: number;
  amountCents: number;
}

export interface PickupItemRef {
  paymentId: string;
  amountCents: number;
  docKind: 'order' | 'sale' | 'service';
  docId: string;
  docNumber: string;
}

/** The owner's tick on a pickup: the cash reached them. */
export interface OwnerReceipt {
  receivedAt: Date;
  /** Null for a `legacy` pickup (posted before the hand-off existed) or a former member. */
  byName: string | null;
  /** 'operator' = handed over by the poster; 'store' = the owner took it from the store. */
  from: 'operator' | 'store' | 'legacy';
}

export interface PickupSummary {
  id: string;
  number: string;
  recordedAt: Date;
  recordedByMembershipId: string | null;
  byName: string;
  countedCents: number;
  expectedCents: number;
  varianceCents: number;
  slip: string | null;
  note: string | null;
  paymentCount: number;
  /** The payments carried out, each pointing at its document (owner 2026-09-25). */
  items: PickupItemRef[];
  /** Null while the cash is still with whoever posted the pickup. */
  ownerReceipt: OwnerReceipt | null;
}

export interface HandoffRow extends PickupSummary {
  locationId: string;
  locationName: string;
  timezone: string;
}

export interface HandoffsResponse {
  /** Posted pickups whose cash has not reached the owner yet, oldest first. */
  awaiting: HandoffRow[];
  /** Pickups the owner received in the last week, newest first (undo lives here). */
  recent: HandoffRow[];
  totals: { awaitingCount: number; awaitingCents: number };
}

export interface CashPickupStore {
  locationId: string;
  name: string;
  timezone: string;
  status: PickupStatus;
  pendingCents: number;
  pendingCount: number;
  oldestDays: number | null;
  /** The last pickup's moment, or the start of the lookback window. */
  since: Date;
  lastPickup: PickupSummary | null;
  payments: PendingCashRow[];
  /** The caller may record a pickup for this store. */
  canRecord: boolean;
}

export interface CashPickupQueue {
  date: string;
  rule: { dueCents: number; dueDays: number };
  viewer: { membershipId: string | null; canRecord: boolean };
  stores: CashPickupStore[];
  totals: { storeCount: number; pendingCents: number; dueCount: number; holdingCount: number };
}

export interface PostPickupBody {
  locationId?: unknown;
  paymentIds?: unknown;
  countedCents?: unknown;
  slip?: unknown;
  note?: unknown;
}

export interface PostPickupResult {
  pickup: PickupSummary & { locationId: string; paymentIds: string[] };
  store: CashPickupStore;
}

interface StoreRef {
  id: string;
  name: string;
  timezone: string;
}

function isUuid(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

function parseLocationIds(raw?: string): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(isUuid);
  return ids.length > 0 ? ids : null;
}

/** `YYYY-MM-DD` of an instant in a timezone. */
function localDay(at: Date, tz: string): string {
  try {
    return at.toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

function usd(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function ownerReceiptOf(
  r: { ownerAt: Date | null; ownerBy: string | null; ownerFrom: string | null },
  names: Map<string, string>,
): OwnerReceipt | null {
  if (!r.ownerAt) return null;
  const from =
    r.ownerFrom === 'store' || r.ownerFrom === 'legacy' ? r.ownerFrom : ('operator' as const);
  return {
    receivedAt: r.ownerAt,
    byName: r.ownerBy ? (names.get(r.ownerBy) ?? 'a former member') : null,
    from,
  };
}

/** The pickup columns every summary reads, owner hand-off included. */
const pickupCols = {
  id: schema.cashPickups.id,
  locationId: schema.cashPickups.locationId,
  number: schema.cashPickups.number,
  recordedAt: schema.cashPickups.recordedAt,
  by: schema.cashPickups.recordedByMembershipId,
  countedCents: schema.cashPickups.countedCents,
  expectedCents: schema.cashPickups.expectedCents,
  varianceCents: schema.cashPickups.varianceCents,
  slip: schema.cashPickups.slip,
  note: schema.cashPickups.note,
  ownerAt: schema.cashPickups.ownerReceivedAt,
  ownerBy: schema.cashPickups.ownerReceivedByMembershipId,
  ownerFrom: schema.cashPickups.ownerReceivedFrom,
  // Qualified by hand: drizzle renders a single-table column as a bare
  // "id", which inside this subquery resolved to `i.id` and counted 0.
  paymentCount: sql<number>`(SELECT count(*) FROM cash_pickup_items i WHERE i.pickup_id = "cash_pickups"."id")::int`,
};

type PickupColsRow = {
  id: string;
  locationId: string;
  number: string;
  recordedAt: Date;
  by: string | null;
  countedCents: number;
  expectedCents: number;
  varianceCents: number;
  slip: string | null;
  note: string | null;
  ownerAt: Date | null;
  ownerBy: string | null;
  ownerFrom: string | null;
  paymentCount: number;
};

function summaryOf(
  r: PickupColsRow,
  names: Map<string, string>,
  items: PickupItemRef[],
): PickupSummary {
  return {
    id: r.id,
    number: r.number,
    recordedAt: r.recordedAt,
    recordedByMembershipId: r.by,
    byName: (r.by && names.get(r.by)) || 'a former member',
    countedCents: r.countedCents,
    expectedCents: r.expectedCents,
    varianceCents: r.varianceCents,
    slip: r.slip,
    note: r.note,
    paymentCount: r.paymentCount,
    items,
    ownerReceipt: ownerReceiptOf(r, names),
  };
}

@TenantScoped()
@Controller('v1/dashboard/cash-pickups')
export class CashPickupsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
  ) {}

  /** Business clock: first selling store's timezone, store-local today. */
  private async today(businessId: string, tz: string): Promise<string> {
    const [row] = await this.db
      .select({ today: sql<string>`(now() AT TIME ZONE ${tz})::date::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return row!.today;
  }

  /** Active selling stores the member may see, narrowed by the request. */
  private async storesFor(
    tenant: RequestTenantContext,
    businessId: string,
    requested: string[] | null,
  ): Promise<StoreRef[]> {
    const scoped = tenant.dataScope === 'store' ? (tenant.scopeLocationIds ?? []) : null;
    if (scoped && scoped.length === 0) return [];
    return this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        timezone: schema.locations.timezone,
      })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.businessId, businessId),
          eq(schema.locations.isActive, true),
          sql`${schema.locations.locationType} <> 'warehouse'`,
          scoped ? inArray(schema.locations.id, scoped) : undefined,
          requested ? inArray(schema.locations.id, requested) : undefined,
        ),
      )
      .orderBy(schema.locations.name);
  }

  /**
   * Stores this member may record a pickup for. Owner / Operations /
   * anyone unscoped: every store they can see. A Manager: only the
   * stores their membership is scoped to — "their own store".
   */
  private async recordableStores(
    tenant: RequestTenantContext,
    businessId: string,
  ): Promise<Set<string> | 'all' | 'none'> {
    if (!tenant.permissions.has('pos.cash.pickup_record') && !tenant.isSuperAdmin) return 'none';
    if (tenant.isSuperAdmin || tenant.roleName !== 'Manager') return 'all';
    if (!tenant.membershipId) return 'none';
    const rows = await this.db
      .select({ locationId: schema.membershipLocationScopes.locationId })
      .from(schema.membershipLocationScopes)
      .where(eq(schema.membershipLocationScopes.membershipId, tenant.membershipId));
    void businessId;
    return new Set(rows.map((r) => r.locationId));
  }

  /** Member names for pickup stamps and salesperson columns. */
  private async memberNames(businessId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({
        membershipId: schema.memberships.id,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.businessId, businessId));
    return new Map(rows.map((r) => [r.membershipId, r.name ?? r.email]));
  }

  /** The most recent posted pickup per store, with its payment count. */
  /**
   * The documents behind each pickup's payments, so a "picked up by …"
   * line can name the orders and link into them (owner 2026-09-25).
   */
  private async pickupItems(pickupIds: string[]): Promise<Map<string, PickupItemRef[]>> {
    const itemsBy = new Map<string, PickupItemRef[]>();
    if (pickupIds.length === 0) return itemsBy;
    const itemRows = await this.db
      .select({
        pickupId: schema.cashPickupItems.pickupId,
        paymentId: schema.payments.id,
        amountCents: schema.payments.amountCents,
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        saleId: schema.sales.id,
        saleNumber: schema.sales.number,
        serviceId: schema.serviceOrders.id,
        serviceNumber: schema.serviceOrders.number,
      })
      .from(schema.cashPickupItems)
      .innerJoin(schema.payments, eq(schema.payments.id, schema.cashPickupItems.paymentId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .leftJoin(schema.serviceOrders, eq(schema.serviceOrders.id, schema.payments.serviceOrderId))
      .where(inArray(schema.cashPickupItems.pickupId, pickupIds))
      .orderBy(desc(schema.payments.amountCents));
    for (const it of itemRows) {
      const docKind: PickupItemRef['docKind'] = it.orderId
        ? 'order'
        : it.saleId
          ? 'sale'
          : 'service';
      const docId = it.orderId ?? it.saleId ?? it.serviceId;
      const docNumber = it.orderNumber ?? it.saleNumber ?? it.serviceNumber;
      if (!docId || !docNumber) continue;
      const list = itemsBy.get(it.pickupId) ?? [];
      list.push({
        paymentId: it.paymentId,
        amountCents: it.amountCents,
        docKind,
        docId,
        docNumber,
      });
      itemsBy.set(it.pickupId, list);
    }
    return itemsBy;
  }

  private async lastPickups(
    businessId: string,
    storeIds: string[],
    names: Map<string, string>,
  ): Promise<Map<string, PickupSummary>> {
    const out = new Map<string, PickupSummary>();
    if (storeIds.length === 0) return out;
    const rows = await this.db
      .selectDistinctOn([schema.cashPickups.locationId], pickupCols)
      .from(schema.cashPickups)
      .where(
        and(
          eq(schema.cashPickups.businessId, businessId),
          inArray(schema.cashPickups.locationId, storeIds),
        ),
      )
      .orderBy(schema.cashPickups.locationId, desc(schema.cashPickups.recordedAt));
    const itemsBy = await this.pickupItems(rows.map((r) => r.id));
    for (const r of rows) {
      out.set(r.locationId, summaryOf(r, names, itemsBy.get(r.id) ?? []));
    }
    return out;
  }

  /**
   * Cash still in the drawer at each store: succeeded cash payments on
   * live documents at the store with no pickup receipt, taken inside the
   * lookback window. A payment left unticked by a partial pickup stays
   * here until it is posted. Legacy-imported documents never count (D8).
   */
  private async pendingCash(
    tenant: RequestTenantContext,
    businessId: string,
    stores: StoreRef[],
    floor: Date,
    names: Map<string, string>,
    byUser: Map<string, string>,
  ): Promise<Map<string, PendingCashRow[]>> {
    const out = new Map<string, PendingCashRow[]>(stores.map((s) => [s.id, []]));
    if (stores.length === 0) return out;
    const locationExpr = sql<string>`COALESCE(${schema.payments.locationId}, ${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`;
    const customerExpr = sql<string>`COALESCE(${schema.orders.customerId}, ${schema.sales.customerId}, ${schema.serviceOrders.customerId})`;
    // Drizzle's postgres-js driver hands timestamptz params through
    // untouched, so a raw Date here reached the wire as an object and the
    // driver threw ERR_INVALID_ARG_TYPE — the "Cash on hand is unavailable"
    // 500 of 2026-09-12. Bind the ISO string and cast.
    const window = sql`(${locationExpr} IN (${sql.join(
      stores.map((s) => sql`${s.id}::uuid`),
      sql`, `,
    )}) AND ${schema.payments.createdAt} >= ${floor.toISOString()}::timestamptz)`;
    const rows = await this.db
      .select({
        paymentId: schema.payments.id,
        amountCents: schema.payments.amountCents,
        paidAt: schema.payments.createdAt,
        locationId: locationExpr,
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        orderSalesperson: schema.orders.salespersonMembershipId,
        saleId: schema.sales.id,
        saleNumber: schema.sales.number,
        saleAssociateUserId: schema.sales.associateUserId,
        serviceId: schema.serviceOrders.id,
        serviceNumber: schema.serviceOrders.number,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
      })
      .from(schema.payments)
      .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .leftJoin(schema.serviceOrders, eq(schema.serviceOrders.id, schema.payments.serviceOrderId))
      .leftJoin(schema.customers, eq(schema.customers.id, customerExpr))
      .leftJoin(
        schema.cashPickupReceipts,
        eq(schema.cashPickupReceipts.paymentId, schema.payments.id),
      )
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          eq(schema.payments.status, 'succeeded'),
          eq(schema.payments.method, 'cash'),
          gt(schema.payments.amountCents, 0),
          isNull(schema.cashPickupReceipts.id),
          isNull(schema.sales.importedAt),
          isNull(schema.orders.importedAt),
          isNull(schema.serviceOrders.importedAt),
          window,
          salesScopeCond(tenant, locationExpr),
        ),
      )
      .orderBy(schema.payments.createdAt);
    const tzOf = new Map(stores.map((s) => [s.id, s.timezone]));
    const now = new Date();
    for (const r of rows) {
      const list = out.get(r.locationId);
      if (!list) continue;
      const tz = tzOf.get(r.locationId) ?? 'UTC';
      const salesperson =
        r.orderSalesperson ??
        (r.saleAssociateUserId ? (byUser.get(r.saleAssociateUserId) ?? null) : null);
      list.push({
        paymentId: r.paymentId,
        docKind: r.orderId ? 'order' : r.saleId ? 'sale' : 'service',
        docId: r.orderId ?? r.saleId ?? r.serviceId ?? '',
        docNumber: r.orderNumber ?? r.saleNumber ?? r.serviceNumber ?? '',
        customerName:
          [r.customerFirst, r.customerLast]
            .filter((s) => !!s)
            .join(' ')
            .trim() || null,
        salespersonName: salesperson ? (names.get(salesperson) ?? null) : null,
        paidAt: r.paidAt,
        ageDays: Math.max(0, dayDiff(localDay(now, tz), localDay(r.paidAt, tz))),
        amountCents: r.amountCents,
      });
    }
    return out;
  }

  /** Membership id by user id, for register sales attributed to a user. */
  private async membershipByUser(businessId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ membershipId: schema.memberships.id, userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(eq(schema.memberships.businessId, businessId));
    return new Map(rows.map((r) => [r.userId, r.membershipId]));
  }

  private async buildQueue(
    tenant: RequestTenantContext,
    businessId: string,
    stores: StoreRef[],
  ): Promise<CashPickupQueue> {
    const tz = stores[0]?.timezone ?? 'UTC';
    const today = await this.today(businessId, tz);
    const [names, byUser, recordable] = await Promise.all([
      this.memberNames(businessId),
      this.membershipByUser(businessId),
      this.recordableStores(tenant, businessId),
    ]);
    const last = await this.lastPickups(
      businessId,
      stores.map((s) => s.id),
      names,
    );
    const floor = new Date(Date.now() - PICKUP_LOOKBACK_DAYS * 86_400_000);
    const pending = await this.pendingCash(tenant, businessId, stores, floor, names, byUser);
    const cards: CashPickupStore[] = stores.map((s) => {
      const payments = pending.get(s.id) ?? [];
      const pendingCents = payments.reduce((n, p) => n + p.amountCents, 0);
      const oldestDays = payments.length ? Math.max(...payments.map((p) => p.ageDays)) : null;
      const status: PickupStatus =
        payments.length === 0
          ? last.get(s.id)
            ? 'collected'
            : 'none'
          : pendingCents > PICKUP_DUE_CENTS || (oldestDays ?? 0) > PICKUP_DUE_DAYS
            ? 'due'
            : 'holding';
      return {
        locationId: s.id,
        name: s.name,
        timezone: s.timezone,
        status,
        pendingCents,
        pendingCount: payments.length,
        oldestDays,
        since: last.get(s.id)?.recordedAt ?? floor,
        lastPickup: last.get(s.id) ?? null,
        payments,
        canRecord: recordable === 'all' || (recordable !== 'none' && recordable.has(s.id)),
      };
    });
    return {
      date: today,
      rule: { dueCents: PICKUP_DUE_CENTS, dueDays: PICKUP_DUE_DAYS },
      viewer: { membershipId: tenant.membershipId, canRecord: recordable !== 'none' },
      stores: cards,
      totals: {
        storeCount: cards.length,
        pendingCents: cards.reduce((n, c) => n + c.pendingCents, 0),
        dueCount: cards.filter((c) => c.status === 'due').length,
        holdingCount: cards.filter((c) => c.status === 'holding').length,
      },
    };
  }

  /** The queue: every store in scope, due first when sorted by the UI. */
  @Get('queue')
  @RequirePermission('orders.view')
  async queue(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationIds') locationIdsQ?: string,
    @Query('locationId') locationIdQ?: string,
  ): Promise<CashPickupQueue> {
    const businessId = tenant.businessId!;
    const requested =
      parseLocationIds(locationIdsQ) ?? (isUuid(locationIdQ) ? [locationIdQ] : null);
    const stores = await this.storesFor(tenant, businessId, requested);
    return this.buildQueue(tenant, businessId, stores);
  }

  /** Recent pickups at one store (or every store), newest first. */
  @Get('history')
  @RequirePermission('orders.view')
  async history(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('locationId') locationIdQ?: string,
    @Query('limit') limitQ?: string,
  ): Promise<{ rows: (PickupSummary & { locationId: string; locationName: string })[] }> {
    const businessId = tenant.businessId!;
    const stores = await this.storesFor(
      tenant,
      businessId,
      isUuid(locationIdQ) ? [locationIdQ] : null,
    );
    if (stores.length === 0) return { rows: [] };
    const limit = Math.min(100, Math.max(1, Number(limitQ) || 20));
    const names = await this.memberNames(businessId);
    const storeName = new Map(stores.map((s) => [s.id, s.name]));
    const rows = await this.db
      .select(pickupCols)
      .from(schema.cashPickups)
      .where(
        and(
          eq(schema.cashPickups.businessId, businessId),
          inArray(
            schema.cashPickups.locationId,
            stores.map((s) => s.id),
          ),
        ),
      )
      .orderBy(desc(schema.cashPickups.recordedAt))
      .limit(limit);
    const historyItems = await this.pickupItems(rows.map((r) => r.id));
    return {
      rows: rows.map((r) => ({
        ...summaryOf(r, names, historyItems.get(r.id) ?? []),
        locationId: r.locationId,
        locationName: storeName.get(r.locationId) ?? '',
      })),
    };
  }

  /**
   * Next `PU-nnnn` for the business. Two posters at once would both read
   * the same maximum, so the read runs under a per-business transaction
   * advisory lock: every tenant request is one transaction (the RLS
   * interceptor), and the lock releases with it.
   */
  private async nextNumber(businessId: string): Promise<string> {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`cash_pickups:${businessId}`}))`,
    );
    const [row] = await this.db
      .select({
        n: sql<number>`COALESCE(MAX(NULLIF(regexp_replace(${schema.cashPickups.number}, '\\D', '', 'g'), '')::int), 0)::int`,
      })
      .from(schema.cashPickups)
      .where(eq(schema.cashPickups.businessId, businessId));
    return `PU-${String((row?.n ?? 0) + 1).padStart(4, '0')}`;
  }

  /**
   * Record → Post. The count is against the ticked payments (none
   * ticked = every pending cash payment at the store); the variance is
   * what it is, stored, and flagged when non-zero. Every covered payment
   * gets its receipt stamp with the poster and the moment.
   */
  @Post()
  @RequirePermission('pos.cash.pickup_record')
  async post(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: PostPickupBody,
  ): Promise<PostPickupResult> {
    const businessId = tenant.businessId!;
    if (!isUuid(body?.locationId)) throw new BadRequestException('locationId must be a uuid');
    const counted = Number(body.countedCents);
    if (!Number.isInteger(counted) || counted < 0) {
      throw new BadRequestException('countedCents must be a whole number of cents, 0 or more');
    }
    const slip =
      body.slip == null || body.slip === ''
        ? null
        : typeof body.slip === 'string' && body.slip.trim().length <= 40
          ? body.slip.trim()
          : null;
    if (body.slip != null && body.slip !== '' && slip == null) {
      throw new BadRequestException('slip must be up to 40 characters');
    }
    const note =
      body.note == null || body.note === ''
        ? null
        : typeof body.note === 'string' && body.note.trim().length <= 200
          ? body.note.trim()
          : null;
    if (body.note != null && body.note !== '' && note == null) {
      throw new BadRequestException('note must be up to 200 characters');
    }
    const requestedIds = Array.isArray(body.paymentIds) ? body.paymentIds.filter(isUuid) : [];
    if (Array.isArray(body.paymentIds) && requestedIds.length !== body.paymentIds.length) {
      throw new BadRequestException('paymentIds must be payment uuids');
    }

    const [store] = await this.storesFor(tenant, businessId, [body.locationId]);
    if (!store) throw new NotFoundException('Store not found');
    const recordable = await this.recordableStores(tenant, businessId);
    if (recordable === 'none' || (recordable !== 'all' && !recordable.has(store.id))) {
      throw new ForbiddenException('You can record a pickup for your own store only');
    }

    const before = await this.buildQueue(tenant, businessId, [store]);
    const card = before.stores[0]!;
    const pending = card.payments;
    const selected = requestedIds.length
      ? pending.filter((p) => requestedIds.includes(p.paymentId))
      : pending;
    if (requestedIds.length && selected.length !== requestedIds.length) {
      throw new BadRequestException(
        'A ticked payment is no longer waiting — it was picked up already or is not cash at this store',
      );
    }
    if (selected.length === 0) {
      throw new BadRequestException('No cash payments are waiting for pickup at this store');
    }
    const expected = selected.reduce((n, p) => n + p.amountCents, 0);
    const variance = counted - expected;

    // Number under the per-business lock, then insert; the unique index
    // is the backstop, never the retry loop.
    const number = await this.nextNumber(businessId);
    // The owner posting a pickup took the cash from the store themselves:
    // the hand-off is complete the moment it is posted.
    const ownerTakes = tenant.permissions.has('pos.cash.pickup_owner_receive');
    const [inserted] = await this.db
      .insert(schema.cashPickups)
      .values({
        businessId,
        locationId: store.id,
        number,
        recordedByMembershipId: tenant.membershipId,
        countedCents: counted,
        expectedCents: expected,
        varianceCents: variance,
        slip,
        note,
        ...(ownerTakes
          ? {
              ownerReceivedAt: sql`now()`,
              ownerReceivedByMembershipId: tenant.membershipId,
              ownerReceivedFrom: 'store',
            }
          : {}),
      })
      .returning({
        id: schema.cashPickups.id,
        number: schema.cashPickups.number,
        recordedAt: schema.cashPickups.recordedAt,
        ownerAt: schema.cashPickups.ownerReceivedAt,
        ownerBy: schema.cashPickups.ownerReceivedByMembershipId,
        ownerFrom: schema.cashPickups.ownerReceivedFrom,
      });
    if (!inserted) throw new BadRequestException('Could not save the pickup — try again');

    await this.db.insert(schema.cashPickupItems).values(
      selected.map((p) => ({
        businessId,
        pickupId: inserted.id,
        paymentId: p.paymentId,
        amountCents: p.amountCents,
      })),
    );
    await this.db
      .insert(schema.cashPickupReceipts)
      .values(
        selected.map((p) => ({
          businessId,
          paymentId: p.paymentId,
          receivedByMembershipId: tenant.membershipId,
          receivedAt: inserted.recordedAt,
        })),
      )
      .onConflictDoNothing();

    const paymentIds = selected.map((p) => p.paymentId);
    await this.audit.log({
      action: 'cash_pickup.post',
      targetType: 'cash_pickup',
      targetId: inserted.id,
      metadata: {
        number: inserted.number,
        locationId: store.id,
        locationName: store.name,
        countedCents: counted,
        expectedCents: expected,
        varianceCents: variance,
        slip,
        paymentIds,
      },
    });
    if (variance !== 0) {
      await this.exceptions.record({
        type: 'cash_pickup_variance',
        severity: Math.abs(variance) >= 5_000 ? 'critical' : 'warning',
        entityType: 'cash_pickup',
        entityId: inserted.id,
        summary: `${inserted.number} · ${store.name}: counted ${usd(counted)} against ${usd(expected)} in cash payments — ${variance > 0 ? 'over' : 'short'} ${usd(variance)}`,
        metadata: {
          number: inserted.number,
          locationId: store.id,
          countedCents: counted,
          expectedCents: expected,
          varianceCents: variance,
          slip,
          paymentIds,
        },
      });
    }
    void this.webhooks.fire({
      businessId,
      eventType: 'cash_pickup.posted',
      payload: {
        pickupId: inserted.id,
        number: inserted.number,
        locationId: store.id,
        countedCents: counted,
        expectedCents: expected,
        varianceCents: variance,
        slip,
        paymentIds,
        recordedByMembershipId: tenant.membershipId,
      },
    });
    if (ownerTakes) {
      void this.webhooks.fire({
        businessId,
        eventType: 'cash_pickup.owner_received',
        payload: {
          pickupId: inserted.id,
          number: inserted.number,
          locationId: store.id,
          countedCents: counted,
          from: 'store',
          recordedByMembershipId: tenant.membershipId,
          ownerReceivedByMembershipId: tenant.membershipId,
        },
      });
    }

    const after = await this.buildQueue(tenant, businessId, [store]);
    const names = await this.memberNames(businessId);
    return {
      pickup: {
        id: inserted.id,
        number: inserted.number,
        recordedAt: inserted.recordedAt,
        recordedByMembershipId: tenant.membershipId,
        ownerReceipt: ownerReceiptOf(inserted, names),
        byName: (tenant.membershipId && names.get(tenant.membershipId)) || 'you',
        countedCents: counted,
        expectedCents: expected,
        varianceCents: variance,
        slip,
        note,
        paymentCount: selected.length,
        items: selected.map((p) => ({
          paymentId: p.paymentId,
          amountCents: p.amountCents,
          docKind: p.docKind,
          docId: p.docId,
          docNumber: p.docNumber,
        })),
        locationId: store.id,
        paymentIds,
      },
      store: after.stores[0]!,
    };
  }
  // ---- Owner hand-off (owner 2026-09-30) ---------------------------------

  /** Pickups in the stores the member may see, with their documents resolved. */
  private async handoffRows(
    businessId: string,
    stores: StoreRef[],
    names: Map<string, string>,
    where: SQL | undefined,
    order: SQL,
    limit: number,
  ): Promise<HandoffRow[]> {
    if (stores.length === 0) return [];
    const byId = new Map(stores.map((st) => [st.id, st]));
    const rows = await this.db
      .select(pickupCols)
      .from(schema.cashPickups)
      .where(
        and(
          eq(schema.cashPickups.businessId, businessId),
          inArray(
            schema.cashPickups.locationId,
            stores.map((st) => st.id),
          ),
          where,
        ),
      )
      .orderBy(order)
      .limit(limit);
    const items = await this.pickupItems(rows.map((r) => r.id));
    return rows.map((r) => ({
      ...summaryOf(r, names, items.get(r.id) ?? []),
      locationId: r.locationId,
      locationName: byId.get(r.locationId)?.name ?? '',
      timezone: byId.get(r.locationId)?.timezone ?? 'UTC',
    }));
  }

  /**
   * The owner's hand-off list: every posted pickup whose cash is still
   * with whoever carried it out (oldest first), and what the owner
   * received this past week so a mis-tick can be undone.
   */
  @Get('handoffs')
  @RequirePermission('pos.cash.pickup_owner_receive')
  async handoffs(@CurrentTenant() tenant: RequestTenantContext): Promise<HandoffsResponse> {
    const businessId = tenant.businessId!;
    const stores = await this.storesFor(tenant, businessId, null);
    const names = await this.memberNames(businessId);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [awaiting, recent] = await Promise.all([
      this.handoffRows(
        businessId,
        stores,
        names,
        isNull(schema.cashPickups.ownerReceivedAt),
        asc(schema.cashPickups.recordedAt),
        200,
      ),
      this.handoffRows(
        businessId,
        stores,
        names,
        and(
          isNotNull(schema.cashPickups.ownerReceivedAt),
          ne(schema.cashPickups.ownerReceivedFrom, 'legacy'),
          gte(schema.cashPickups.ownerReceivedAt, sql`${weekAgo}::timestamptz`),
        ),
        desc(schema.cashPickups.ownerReceivedAt),
        20,
      ),
    ]);
    return {
      awaiting,
      recent,
      totals: {
        awaitingCount: awaiting.length,
        awaitingCents: awaiting.reduce((n, r) => n + r.countedCents, 0),
      },
    };
  }

  /** One pickup in a store the member may see, or 404. */
  private async pickupFor(
    tenant: RequestTenantContext,
    businessId: string,
    pickupId: string,
  ): Promise<{ row: HandoffRow; stores: StoreRef[]; names: Map<string, string> }> {
    if (!isUuid(pickupId)) throw new BadRequestException('pickupId must be a uuid');
    const stores = await this.storesFor(tenant, businessId, null);
    const names = await this.memberNames(businessId);
    const [row] = await this.handoffRows(
      businessId,
      stores,
      names,
      eq(schema.cashPickups.id, pickupId),
      asc(schema.cashPickups.recordedAt),
      1,
    );
    if (!row) throw new NotFoundException('Pickup not found');
    return { row, stores, names };
  }

  private async receiveOne(tenant: RequestTenantContext, pickupId: string): Promise<HandoffRow> {
    const businessId = tenant.businessId!;
    const { row, stores, names } = await this.pickupFor(tenant, businessId, pickupId);
    if (row.ownerReceipt) return row;
    // Posted by the owner themselves (e.g. an old pickup ticked later):
    // the cash came from the store, not from an operator.
    const from: 'operator' | 'store' =
      row.recordedByMembershipId && row.recordedByMembershipId === tenant.membershipId
        ? 'store'
        : 'operator';
    const updated = await this.db
      .update(schema.cashPickups)
      .set({
        ownerReceivedAt: sql`now()`,
        ownerReceivedByMembershipId: tenant.membershipId,
        ownerReceivedFrom: from,
      })
      .where(
        and(
          eq(schema.cashPickups.businessId, businessId),
          eq(schema.cashPickups.id, pickupId),
          isNull(schema.cashPickups.ownerReceivedAt),
        ),
      )
      .returning({ id: schema.cashPickups.id });
    if (updated.length > 0) {
      await this.audit.log({
        action: 'cash_pickup.owner_receive',
        targetType: 'cash_pickup',
        targetId: pickupId,
        metadata: {
          number: row.number,
          locationId: row.locationId,
          locationName: row.locationName,
          countedCents: row.countedCents,
          from,
          recordedByMembershipId: row.recordedByMembershipId,
          recordedByName: row.byName,
        },
      });
      void this.webhooks.fire({
        businessId,
        eventType: 'cash_pickup.owner_received',
        payload: {
          pickupId,
          number: row.number,
          locationId: row.locationId,
          countedCents: row.countedCents,
          from,
          recordedByMembershipId: row.recordedByMembershipId,
          ownerReceivedByMembershipId: tenant.membershipId,
        },
      });
    }
    const [after] = await this.handoffRows(
      businessId,
      stores,
      names,
      eq(schema.cashPickups.id, pickupId),
      asc(schema.cashPickups.recordedAt),
      1,
    );
    return after!;
  }

  /** Tick: the cash on this pickup is in the owner's hands. */
  @Put(':pickupId/owner-received')
  @RequirePermission('pos.cash.pickup_owner_receive')
  async receive(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('pickupId') pickupId: string,
  ): Promise<HandoffRow> {
    return this.receiveOne(tenant, pickupId);
  }

  /** "Received all from Ana": tick several pickups at once. */
  @Post('owner-received')
  @RequirePermission('pos.cash.pickup_owner_receive')
  async receiveMany(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { pickupIds?: unknown },
  ): Promise<{ rows: HandoffRow[] }> {
    const ids = Array.isArray(body?.pickupIds) ? body.pickupIds.filter(isUuid) : [];
    if (
      ids.length === 0 ||
      ids.length > 200 ||
      (Array.isArray(body?.pickupIds) && ids.length !== body.pickupIds.length)
    ) {
      throw new BadRequestException('pickupIds must list 1–200 pickup ids');
    }
    const rows: HandoffRow[] = [];
    for (const id of [...new Set(ids)]) rows.push(await this.receiveOne(tenant, id));
    return { rows };
  }

  /**
   * Untick — a mis-tick only. The cash goes back to "with the operator".
   * A pickup the owner took from the store has no operator to go back to,
   * and a legacy one was never ticked, so neither can be undone.
   */
  @Delete(':pickupId/owner-received')
  @RequirePermission('pos.cash.pickup_owner_receive')
  async unreceive(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('pickupId') pickupId: string,
  ): Promise<HandoffRow> {
    const businessId = tenant.businessId!;
    const { row, stores, names } = await this.pickupFor(tenant, businessId, pickupId);
    const receipt = row.ownerReceipt;
    if (!receipt) return row;
    if (receipt.from !== 'operator') {
      throw new ConflictException(
        receipt.from === 'store'
          ? `${row.number} was taken from the store by the owner — there is no hand-off to undo`
          : `${row.number} was settled before the owner hand-off existed — there is nothing to undo`,
      );
    }
    await this.db
      .update(schema.cashPickups)
      .set({
        ownerReceivedAt: null,
        ownerReceivedByMembershipId: null,
        ownerReceivedFrom: null,
      })
      .where(
        and(eq(schema.cashPickups.businessId, businessId), eq(schema.cashPickups.id, pickupId)),
      );
    await this.audit.log({
      action: 'cash_pickup.owner_unreceive',
      targetType: 'cash_pickup',
      targetId: pickupId,
      metadata: {
        number: row.number,
        locationId: row.locationId,
        countedCents: row.countedCents,
        previouslyReceivedAt: receipt.receivedAt,
        previouslyReceivedBy: receipt.byName,
      },
    });
    const [after] = await this.handoffRows(
      businessId,
      stores,
      names,
      eq(schema.cashPickups.id, pickupId),
      asc(schema.cashPickups.recordedAt),
      1,
    );
    return after!;
  }
}
