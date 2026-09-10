import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { tzDayEndExclusive, tzDayStart, type DayRange } from '../common/date-range';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

/**
 * Store cards (owner hand-off 2026-09-10): one card per store with its
 * salespeople, every form of money received, and a tick per cash payment
 * confirming the cash was physically handed over. Rendered by the owner,
 * manager and operations homes, so the numbers are computed once here.
 *
 * Definitions (owner-confirmed 2026-09-10):
 *  - Written    = orders created in the window, not draft/quote/cancelled
 *                 (the owner KPI's definition). Attributed in full to the
 *                 order's primary salesperson.
 *  - Delivered  = orders with a delivery that reached `delivered` in the
 *                 window; each order counts once at its full total.
 *  - Money received = every positive succeeded payment in the window on a
 *                 document written at the store — orders, POS sales and
 *                 service tickets alike — grouped by the live tender
 *                 methods. Refunds are the negative payment rows the
 *                 return / price-adjustment flows write; they count only
 *                 under "Refunds paid out", never as money received or as
 *                 cash awaiting pickup.
 *  - Cash awaiting pickup = cash payments in the window with no receipt.
 * Legacy-imported documents are excluded throughout (sprint decision D8).
 * The window's dates come from the business clock; each store's day
 * boundaries are then taken in that store's own timezone, so a store in
 * another zone never picks up the neighbouring day's money.
 */

export type StorePeriod = 'mtd' | 'today';

/** The live tender methods, in the order the card lists them. */
export const TENDER_METHODS = [
  'cash',
  'card',
  'external_card',
  'check',
  'financing',
  'gift_card',
  'store_credit',
] as const;

export interface PickupReceipt {
  receivedAt: Date;
  byMembershipId: string | null;
  byName: string;
  byRole: string | null;
}

export interface CashPaymentRow {
  paymentId: string;
  docKind: 'order' | 'sale' | 'service';
  docId: string;
  docNumber: string;
  customerName: string | null;
  soldAt: Date;
  paidAt: Date;
  /** 'deposit' | 'paid in full' | 'balance on delivery' | 'installment' */
  kind: string;
  salespersonName: string | null;
  amountCents: number;
  receipt: PickupReceipt | null;
}

export interface SalespersonRow {
  membershipId: string;
  name: string;
  isManager: boolean;
  writtenCents: number;
  deliveredCents: number;
  orders: number;
  avgTicketCents: number;
  collectedCents: number;
  lastWriteUpAt: Date | null;
}

export interface StoreCard {
  locationId: string;
  name: string;
  timezone: string;
  manager: { membershipId: string; name: string } | null;
  sellingCount: number;
  writtenCents: number;
  writtenCount: number;
  deliveredCents: number;
  deliveredCount: number;
  avgTicketCents: number;
  receivedCents: number;
  receivedCount: number;
  refundsCents: number;
  cashTotalCents: number;
  cashPendingCents: number;
  cashPaymentCount: number;
  cashReceivedCount: number;
  salespeople: SalespersonRow[];
  tenders: { method: string; cents: number; count: number }[];
  cashPayments: CashPaymentRow[];
}

export interface StoresResponse {
  date: string;
  period: StorePeriod;
  range: DayRange;
  viewer: { membershipId: string | null; canConfirmCashPickup: boolean };
  stores: StoreCard[];
  totals: {
    storeCount: number;
    writtenCents: number;
    writtenCount: number;
    deliveredCents: number;
    deliveredCount: number;
    receivedCents: number;
    receivedCount: number;
    cashPendingCents: number;
  };
}

export interface PaymentListResponse {
  location: { id: string; name: string };
  method: string;
  range: DayRange;
  rows: CashPaymentRow[];
  totalCents: number;
  count: number;
}

interface PaymentRecord extends CashPaymentRow {
  method: string;
  locationId: string;
  salespersonMembershipId: string | null;
}

interface MemberInfo {
  membershipId: string;
  userId: string;
  name: string;
  roleName: string | null;
  managerDashboard: boolean;
}

function parseLocationIds(raw?: string): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  return ids.length > 0 ? ids : null;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

interface StoreRef {
  id: string;
  timezone: string;
}

/**
 * `col` falls inside `range` for the store `loc` points at, with the day
 * boundaries taken in that store's timezone: one OR-branch per store.
 */
function storeWindow(
  stores: StoreRef[],
  range: DayRange,
  col: PgColumn | SQL,
  loc: PgColumn | SQL,
): SQL {
  if (stores.length === 0) return sql`false`;
  return sql`(${sql.join(
    stores.map(
      (s) =>
        sql`(${loc} = ${s.id}::uuid AND ${col} >= ${tzDayStart(range.start, s.timezone)} AND ${col} < ${tzDayEndExclusive(range.end, s.timezone)})`,
    ),
    sql` OR `,
  )})`;
}

/** Human label for a payment's kind, given the document it sits on. */
function paymentKindLabel(kind: string, amountCents: number, docTotalCents: number | null): string {
  switch (kind) {
    case 'sale':
      return 'paid in full';
    case 'deposit':
      return docTotalCents != null && amountCents >= docTotalCents ? 'paid in full' : 'deposit';
    case 'balance':
      return 'balance on delivery';
    case 'installment':
      return 'installment';
    default:
      return kind.replace(/_/g, ' ');
  }
}

@TenantScoped()
@Controller('v1/dashboard')
export class StoreDashboardController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  /** Business clock: first store's timezone, store-local today. */
  private async clock(businessId: string): Promise<{ tz: string; today: string }> {
    const stores = await this.db
      .select({ timezone: schema.locations.timezone, locationType: schema.locations.locationType })
      .from(schema.locations)
      .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
      .orderBy(schema.locations.name);
    const tz = (stores.find((s) => s.locationType !== 'warehouse') ?? stores[0])?.timezone ?? 'UTC';
    const [row] = await this.db
      .select({ today: sql<string>`(now() AT TIME ZONE ${tz})::date::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return { tz, today: row!.today };
  }

  private periodOf(raw: string | undefined): StorePeriod {
    return raw === 'today' ? 'today' : 'mtd';
  }

  private rangeFor(period: StorePeriod, today: string): DayRange {
    return period === 'today'
      ? { start: today, end: today }
      : { start: `${today.slice(0, 7)}-01`, end: today };
  }

  /** Active selling stores this member may see, narrowed by the request. */
  private async storesFor(
    tenant: RequestTenantContext,
    businessId: string,
    requested: string[] | null,
  ): Promise<{ id: string; name: string; timezone: string }[]> {
    const scoped = tenant.dataScope === 'store' ? (tenant.scopeLocationIds ?? []) : null;
    if (scoped && scoped.length === 0) return [];
    const rows = await this.db
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
    return rows;
  }

  /** Every active member with their name, role and manager flag. */
  private async members(businessId: string): Promise<Map<string, MemberInfo>> {
    const rows = await this.db
      .select({
        membershipId: schema.memberships.id,
        userId: schema.memberships.userId,
        name: schema.users.name,
        email: schema.users.email,
        roleName: schema.roles.name,
        managerDashboard: schema.memberships.managerDashboard,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(eq(schema.memberships.businessId, businessId));
    const map = new Map<string, MemberInfo>();
    for (const r of rows) {
      map.set(r.membershipId, {
        membershipId: r.membershipId,
        userId: r.userId,
        name: r.name ?? r.email,
        roleName: r.roleName ?? null,
        managerDashboard: r.managerDashboard,
      });
    }
    return map;
  }

  /**
   * Store manager (owner decision 2026-09-10, option B): the member whose
   * manager-dashboard toggle is on AND whose store access lists this
   * store. Several → first by name; none → no badge.
   */
  private async managersByStore(
    businessId: string,
    members: Map<string, MemberInfo>,
  ): Promise<Map<string, MemberInfo>> {
    const flagged = [...members.values()].filter((m) => m.managerDashboard);
    const out = new Map<string, MemberInfo>();
    if (flagged.length === 0) return out;
    const scopes = await this.db
      .select({
        membershipId: schema.membershipLocationScopes.membershipId,
        locationId: schema.membershipLocationScopes.locationId,
      })
      .from(schema.membershipLocationScopes)
      .innerJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.membershipLocationScopes.membershipId),
      )
      .where(
        and(
          eq(schema.memberships.businessId, businessId),
          inArray(
            schema.membershipLocationScopes.membershipId,
            flagged.map((m) => m.membershipId),
          ),
        ),
      );
    const byStore = new Map<string, MemberInfo[]>();
    for (const s of scopes) {
      const m = members.get(s.membershipId);
      if (!m) continue;
      const list = byStore.get(s.locationId) ?? [];
      list.push(m);
      byStore.set(s.locationId, list);
    }
    for (const [loc, list] of byStore) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      out.set(loc, list[0]!);
    }
    return out;
  }

  /**
   * Every succeeded payment in the window on a document at one of the
   * stores, with the document, customer, salesperson and pickup receipt
   * resolved. One query feeds the tender rows, the cash list and the
   * payment dialog.
   */
  private async paymentsIn(
    tenant: RequestTenantContext,
    businessId: string,
    stores: StoreRef[],
    range: DayRange,
    members: Map<string, MemberInfo>,
    extra?: { method?: string; paymentId?: string },
  ): Promise<PaymentRecord[]> {
    if (stores.length === 0) return [];
    const receiptMember = alias(schema.memberships, 'receipt_member');
    const receiptUser = alias(schema.users, 'receipt_user');
    const receiptRole = alias(schema.roles, 'receipt_role');
    const locationExpr = sql<string>`COALESCE(${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`;
    const customerExpr = sql<string>`COALESCE(${schema.orders.customerId}, ${schema.sales.customerId}, ${schema.serviceOrders.customerId})`;

    const rows = await this.db
      .select({
        paymentId: schema.payments.id,
        method: schema.payments.method,
        kind: schema.payments.kind,
        amountCents: schema.payments.amountCents,
        paidAt: schema.payments.createdAt,
        locationId: locationExpr,
        orderId: schema.orders.id,
        orderNumber: schema.orders.number,
        orderTotalCents: schema.orders.totalCents,
        orderCreatedAt: schema.orders.createdAt,
        orderSalesperson: schema.orders.salespersonMembershipId,
        saleId: schema.sales.id,
        saleNumber: schema.sales.number,
        saleCreatedAt: schema.sales.createdAt,
        saleAssociateUserId: schema.sales.associateUserId,
        serviceId: schema.serviceOrders.id,
        serviceNumber: schema.serviceOrders.number,
        serviceCreatedAt: schema.serviceOrders.createdAt,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        receiptAt: schema.cashPickupReceipts.receivedAt,
        receiptBy: schema.cashPickupReceipts.receivedByMembershipId,
        receiptByName: receiptUser.name,
        receiptByEmail: receiptUser.email,
        receiptByRole: receiptRole.name,
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
      .leftJoin(
        receiptMember,
        eq(receiptMember.id, schema.cashPickupReceipts.receivedByMembershipId),
      )
      .leftJoin(receiptUser, eq(receiptUser.id, receiptMember.userId))
      .leftJoin(receiptRole, eq(receiptRole.id, receiptMember.roleId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          eq(schema.payments.status, 'succeeded'),
          // Money in only: the return and price-adjustment flows write
          // negative rows for money paid back.
          gt(schema.payments.amountCents, 0),
          extra?.paymentId ? eq(schema.payments.id, extra.paymentId) : undefined,
          extra?.paymentId
            ? sql`${locationExpr} IN (${sql.join(
                stores.map((s) => sql`${s.id}::uuid`),
                sql`, `,
              )})`
            : storeWindow(stores, range, schema.payments.createdAt, locationExpr),
          extra?.method ? eq(schema.payments.method, extra.method) : undefined,
          isNull(schema.sales.importedAt),
          isNull(schema.orders.importedAt),
          isNull(schema.serviceOrders.importedAt),
          salesScopeCond(tenant, locationExpr),
        ),
      )
      .orderBy(desc(schema.payments.createdAt));

    const byUser = new Map<string, MemberInfo>();
    for (const m of members.values()) byUser.set(m.userId, m);

    return rows.map((r) => {
      const docKind: 'order' | 'sale' | 'service' = r.orderId
        ? 'order'
        : r.saleId
          ? 'sale'
          : 'service';
      const docId = r.orderId ?? r.saleId ?? r.serviceId ?? '';
      const docNumber = r.orderNumber ?? r.saleNumber ?? r.serviceNumber ?? '';
      const soldAt = r.orderCreatedAt ?? r.saleCreatedAt ?? r.serviceCreatedAt ?? r.paidAt;
      const salespersonMembershipId =
        r.orderSalesperson ??
        (r.saleAssociateUserId ? (byUser.get(r.saleAssociateUserId)?.membershipId ?? null) : null);
      const customerName =
        [r.customerFirst, r.customerLast]
          .filter((s) => !!s)
          .join(' ')
          .trim() || null;
      const receipt: PickupReceipt | null = r.receiptAt
        ? {
            receivedAt: r.receiptAt,
            byMembershipId: r.receiptBy ?? null,
            byName: r.receiptByName ?? r.receiptByEmail ?? 'a former member',
            byRole: r.receiptByRole ?? null,
          }
        : null;
      return {
        paymentId: r.paymentId,
        method: r.method,
        locationId: r.locationId,
        docKind,
        docId,
        docNumber,
        customerName,
        soldAt,
        paidAt: r.paidAt,
        kind: paymentKindLabel(r.kind, r.amountCents, r.orderId ? r.orderTotalCents : null),
        salespersonMembershipId,
        salespersonName: salespersonMembershipId
          ? (members.get(salespersonMembershipId)?.name ?? null)
          : null,
        amountCents: r.amountCents,
        receipt,
      };
    });
  }

  @Get('stores')
  @RequirePermission('orders.view')
  async stores(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('period') periodQ?: string,
    @Query('locationIds') locationIdsQ?: string,
    @Query('locationId') locationIdQ?: string,
  ): Promise<StoresResponse> {
    const businessId = tenant.businessId!;
    const { today } = await this.clock(businessId);
    const period = this.periodOf(periodQ);
    const range = this.rangeFor(period, today);
    const requested =
      parseLocationIds(locationIdsQ) ?? (locationIdQ && isUuid(locationIdQ) ? [locationIdQ] : null);
    const stores = await this.storesFor(tenant, businessId, requested);
    const storeIds = stores.map((s) => s.id);
    const members = await this.members(businessId);
    const managers = await this.managersByStore(businessId, members);

    const refundLocation = sql<string>`COALESCE(${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`;
    const liveOrder = and(
      eq(schema.orders.businessId, businessId),
      sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
      isNull(schema.orders.importedAt),
      storeIds.length > 0 ? inArray(schema.orders.locationId, storeIds) : sql`false`,
      salesScopeCond(tenant, schema.orders.locationId),
    );

    const [written, delivered, payments, saleRefunds, orderRefunds] = await Promise.all([
      storeIds.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              id: schema.orders.id,
              locationId: schema.orders.locationId,
              salesperson: schema.orders.salespersonMembershipId,
              totalCents: schema.orders.totalCents,
              createdAt: schema.orders.createdAt,
            })
            .from(schema.orders)
            .where(
              and(
                liveOrder,
                storeWindow(stores, range, schema.orders.createdAt, schema.orders.locationId),
              ),
            ),
      storeIds.length === 0
        ? Promise.resolve([])
        : this.db
            .selectDistinctOn([schema.orders.id], {
              id: schema.orders.id,
              locationId: schema.orders.locationId,
              salesperson: schema.orders.salespersonMembershipId,
              totalCents: schema.orders.totalCents,
            })
            .from(schema.deliveries)
            .innerJoin(schema.orders, eq(schema.orders.id, schema.deliveries.orderId))
            .where(
              and(
                liveOrder,
                eq(schema.deliveries.status, 'delivered'),
                storeWindow(stores, range, schema.deliveries.completedAt, schema.orders.locationId),
              ),
            ),
      this.paymentsIn(tenant, businessId, stores, range, members),
      storeIds.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              locationId: schema.sales.locationId,
              cents: sql<number>`COALESCE(SUM(${schema.refunds.amountCents}), 0)::int`,
            })
            .from(schema.refunds)
            .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
            .where(
              and(
                eq(schema.refunds.businessId, businessId),
                storeWindow(stores, range, schema.refunds.createdAt, schema.sales.locationId),
                isNull(schema.sales.importedAt),
                salesScopeCond(tenant, schema.sales.locationId),
              ),
            )
            .groupBy(schema.sales.locationId),
      // Order and service refunds: the negative payment rows the return
      // and price-adjustment flows write when money goes back out.
      storeIds.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              locationId: refundLocation,
              cents: sql<number>`COALESCE(SUM(-${schema.payments.amountCents}), 0)::int`,
            })
            .from(schema.payments)
            .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
            .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
            .leftJoin(
              schema.serviceOrders,
              eq(schema.serviceOrders.id, schema.payments.serviceOrderId),
            )
            .where(
              and(
                eq(schema.payments.businessId, businessId),
                eq(schema.payments.status, 'succeeded'),
                lt(schema.payments.amountCents, 0),
                storeWindow(stores, range, schema.payments.createdAt, refundLocation),
                isNull(schema.sales.importedAt),
                isNull(schema.orders.importedAt),
                isNull(schema.serviceOrders.importedAt),
                salesScopeCond(tenant, refundLocation),
              ),
            )
            .groupBy(refundLocation),
    ]);

    const refundsByStore = new Map<string, number>();
    for (const r of [...saleRefunds, ...orderRefunds]) {
      refundsByStore.set(r.locationId, (refundsByStore.get(r.locationId) ?? 0) + r.cents);
    }

    const cards: StoreCard[] = stores.map((store) => {
      const reps = new Map<string, SalespersonRow>();
      const rep = (membershipId: string): SalespersonRow => {
        let row = reps.get(membershipId);
        if (!row) {
          row = {
            membershipId,
            name: members.get(membershipId)?.name ?? 'Former member',
            isManager: managers.get(store.id)?.membershipId === membershipId,
            writtenCents: 0,
            deliveredCents: 0,
            orders: 0,
            avgTicketCents: 0,
            collectedCents: 0,
            lastWriteUpAt: null,
          };
          reps.set(membershipId, row);
        }
        return row;
      };
      const manager = managers.get(store.id) ?? null;
      if (manager) rep(manager.membershipId);

      let writtenCents = 0;
      let writtenCount = 0;
      for (const o of written) {
        if (o.locationId !== store.id) continue;
        writtenCents += o.totalCents;
        writtenCount += 1;
        if (o.salesperson) {
          const r = rep(o.salesperson);
          r.writtenCents += o.totalCents;
          r.orders += 1;
          if (!r.lastWriteUpAt || o.createdAt > r.lastWriteUpAt) r.lastWriteUpAt = o.createdAt;
        }
      }
      let deliveredCents = 0;
      let deliveredCount = 0;
      for (const o of delivered) {
        if (o.locationId !== store.id) continue;
        deliveredCents += o.totalCents;
        deliveredCount += 1;
        if (o.salesperson) rep(o.salesperson).deliveredCents += o.totalCents;
      }

      const tenders: { method: string; cents: number; count: number }[] = TENDER_METHODS.map(
        (method) => ({ method, cents: 0, count: 0 }),
      );
      const tenderIdx = new Map<string, number>(tenders.map((t, i) => [t.method, i]));
      let receivedCents = 0;
      let receivedCount = 0;
      const cashPayments: CashPaymentRow[] = [];
      for (const p of payments) {
        if (p.locationId !== store.id) continue;
        receivedCents += p.amountCents;
        receivedCount += 1;
        const idx = tenderIdx.get(p.method);
        if (idx != null) {
          tenders[idx]!.cents += p.amountCents;
          tenders[idx]!.count += 1;
        } else {
          // A method the catalog does not list yet still shows its money.
          tenders.push({ method: p.method, cents: p.amountCents, count: 1 });
          tenderIdx.set(p.method, tenders.length - 1);
        }
        if (p.docKind === 'order' && p.salespersonMembershipId) {
          rep(p.salespersonMembershipId).collectedCents += p.amountCents;
        }
        if (p.method === 'cash') {
          const { method: _m, locationId: _l, salespersonMembershipId: _s, ...row } = p;
          cashPayments.push(row);
        }
      }
      // Cash rows: oldest first, so the list reads like the drawer log.
      cashPayments.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());
      const cashTotalCents = cashPayments.reduce((s, p) => s + p.amountCents, 0);
      const cashReceived = cashPayments.filter((p) => p.receipt);
      const cashPendingCents = cashTotalCents - cashReceived.reduce((s, p) => s + p.amountCents, 0);

      const salespeople = [...reps.values()]
        .map((r) => ({
          ...r,
          avgTicketCents: r.orders > 0 ? Math.round(r.writtenCents / r.orders) : 0,
        }))
        .sort((a, b) => b.writtenCents - a.writtenCents || a.name.localeCompare(b.name));

      return {
        locationId: store.id,
        name: store.name,
        timezone: store.timezone,
        manager: manager ? { membershipId: manager.membershipId, name: manager.name } : null,
        sellingCount: salespeople.filter((r) => r.orders > 0).length,
        writtenCents,
        writtenCount,
        deliveredCents,
        deliveredCount,
        avgTicketCents: writtenCount > 0 ? Math.round(writtenCents / writtenCount) : 0,
        receivedCents,
        receivedCount,
        refundsCents: refundsByStore.get(store.id) ?? 0,
        cashTotalCents,
        cashPendingCents,
        cashPaymentCount: cashPayments.length,
        cashReceivedCount: cashReceived.length,
        salespeople,
        tenders,
        cashPayments,
      };
    });

    const totals = cards.reduce(
      (t, c) => ({
        storeCount: t.storeCount + 1,
        writtenCents: t.writtenCents + c.writtenCents,
        writtenCount: t.writtenCount + c.writtenCount,
        deliveredCents: t.deliveredCents + c.deliveredCents,
        deliveredCount: t.deliveredCount + c.deliveredCount,
        receivedCents: t.receivedCents + c.receivedCents,
        receivedCount: t.receivedCount + c.receivedCount,
        cashPendingCents: t.cashPendingCents + c.cashPendingCents,
      }),
      {
        storeCount: 0,
        writtenCents: 0,
        writtenCount: 0,
        deliveredCents: 0,
        deliveredCount: 0,
        receivedCents: 0,
        receivedCount: 0,
        cashPendingCents: 0,
      },
    );

    return {
      date: today,
      period,
      range,
      viewer: {
        membershipId: tenant.membershipId,
        canConfirmCashPickup: tenant.permissions.has('pos.cash.pickup_confirm'),
      },
      stores: cards,
      totals,
    };
  }

  /** The payment list behind a tender row: every payment of one method at one store. */
  @Get('stores/:locationId/payments')
  @RequirePermission('orders.view')
  async payments(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('locationId') locationId: string,
    @Query('method') method?: string,
    @Query('period') periodQ?: string,
  ): Promise<PaymentListResponse> {
    const businessId = tenant.businessId!;
    if (!isUuid(locationId)) throw new BadRequestException('locationId must be a uuid');
    if (!method || !/^[a-z_]{1,32}$/.test(method)) {
      throw new BadRequestException('method is required');
    }
    const [store] = await this.storesFor(tenant, businessId, [locationId]);
    if (!store) throw new NotFoundException('Store not found');
    const { today } = await this.clock(businessId);
    const range = this.rangeFor(this.periodOf(periodQ), today);
    const members = await this.members(businessId);
    const rows = await this.paymentsIn(tenant, businessId, [store], range, members, { method });
    const list = rows.map(({ method: _m, locationId: _l, salespersonMembershipId: _s, ...r }) => r);
    return {
      location: { id: store.id, name: store.name },
      method,
      range,
      rows: list,
      totalCents: list.reduce((s, r) => s + r.amountCents, 0),
      count: list.length,
    };
  }

  /** Resolve one cash payment the member may see, or throw. */
  private async cashPayment(
    tenant: RequestTenantContext,
    businessId: string,
    paymentId: string,
  ): Promise<PaymentRecord> {
    if (!isUuid(paymentId)) throw new BadRequestException('paymentId must be a uuid');
    const stores = await this.storesFor(tenant, businessId, null);
    const { today } = await this.clock(businessId);
    const members = await this.members(businessId);
    const [row] = await this.paymentsIn(
      tenant,
      businessId,
      stores,
      { start: today, end: today },
      members,
      { paymentId },
    );
    if (!row) throw new NotFoundException('Payment not found');
    if (row.method !== 'cash') {
      throw new BadRequestException('Only cash payments are picked up');
    }
    return row;
  }

  private async confirmOne(
    tenant: RequestTenantContext,
    paymentId: string,
  ): Promise<{ paymentId: string; receipt: PickupReceipt }> {
    const businessId = tenant.businessId!;
    const p = await this.cashPayment(tenant, businessId, paymentId);
    if (p.receipt) return { paymentId, receipt: p.receipt };
    await this.db
      .insert(schema.cashPickupReceipts)
      .values({ businessId, paymentId, receivedByMembershipId: tenant.membershipId })
      .onConflictDoNothing();
    await this.audit.log({
      action: 'cash_pickup.confirm',
      targetType: 'payment',
      targetId: paymentId,
      metadata: {
        docKind: p.docKind,
        docNumber: p.docNumber,
        amountCents: p.amountCents,
        locationId: p.locationId,
      },
    });
    void this.webhooks.fire({
      businessId,
      eventType: 'cash_pickup.confirmed',
      payload: {
        paymentId,
        docKind: p.docKind,
        docId: p.docId,
        docNumber: p.docNumber,
        amountCents: p.amountCents,
        locationId: p.locationId,
        receivedByMembershipId: tenant.membershipId,
      },
    });
    const after = await this.cashPayment(tenant, businessId, paymentId);
    return { paymentId, receipt: after.receipt! };
  }

  private async clearOne(tenant: RequestTenantContext, paymentId: string): Promise<void> {
    const businessId = tenant.businessId!;
    const p = await this.cashPayment(tenant, businessId, paymentId);
    if (!p.receipt) return;
    await this.db
      .delete(schema.cashPickupReceipts)
      .where(
        and(
          eq(schema.cashPickupReceipts.businessId, businessId),
          eq(schema.cashPickupReceipts.paymentId, paymentId),
        ),
      );
    await this.audit.log({
      action: 'cash_pickup.clear',
      targetType: 'payment',
      targetId: paymentId,
      metadata: {
        docKind: p.docKind,
        docNumber: p.docNumber,
        amountCents: p.amountCents,
        locationId: p.locationId,
        previouslyReceivedAt: p.receipt.receivedAt,
        previouslyReceivedBy: p.receipt.byMembershipId,
      },
    });
  }

  /** Tick: the cash for this payment was physically handed over to me. */
  @Put('cash-pickups/:paymentId')
  @RequirePermission('pos.cash.pickup_confirm')
  async confirm(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('paymentId') paymentId: string,
  ): Promise<{ paymentId: string; receipt: PickupReceipt }> {
    return this.confirmOne(tenant, paymentId);
  }

  /** Untick (undo). */
  @Delete('cash-pickups/:paymentId')
  @RequirePermission('pos.cash.pickup_confirm')
  async clear(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('paymentId') paymentId: string,
  ): Promise<{ paymentId: string; receipt: null }> {
    await this.clearOne(tenant, paymentId);
    return { paymentId, receipt: null };
  }

  /** "Mark all received" / "Clear all ticks" on one store card. */
  @Post('cash-pickups/bulk')
  @RequirePermission('pos.cash.pickup_confirm')
  async bulk(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { paymentIds?: unknown; received?: unknown },
  ): Promise<{ updated: number }> {
    const ids = Array.isArray(body?.paymentIds)
      ? body.paymentIds.filter((x): x is string => typeof x === 'string' && isUuid(x))
      : [];
    if (ids.length === 0 || ids.length > 200) {
      throw new BadRequestException('paymentIds must list 1–200 payment ids');
    }
    if (typeof body.received !== 'boolean') {
      throw new BadRequestException('received must be true or false');
    }
    let updated = 0;
    for (const id of ids) {
      if (body.received) await this.confirmOne(tenant, id);
      else await this.clearOne(tenant, id);
      updated += 1;
    }
    return { updated };
  }
}
