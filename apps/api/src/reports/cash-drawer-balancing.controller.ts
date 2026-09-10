import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { parseDayRange, type DayRange } from '../common/date-range';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import {
  renderCashDrawerBalancingPages,
  renderCashDrawerBalancingText,
} from './cash-drawer-balancing.text';
import { toCsv } from './csv';
import { textPagesToPdf } from './text-pdf';

/**
 * Report Cash Drawer Balancing Totals (STORIS AR.317, owner 2026-09-02):
 * every tender taken in a balance-date window, listed under the store /
 * operator / drawer it landed in ("Balance By"), then under its pay
 * class (CASH, CHECK, CREDIT, …) and payment type, with a subtotal at
 * each level, a grand total, and a Cash Drawer Reconciliation block
 * (cash + check = the bank deposit). Drawer counts (float, expected,
 * counted, over/short) ride along per group so the balancing totals and
 * the register sit on one page.
 *
 * Definitions (Jetnine mapping of the STORIS parameter screen):
 * - Balance Date + Starting/Ending Time: the payment's timestamp in the
 *   store's own timezone. Ending time is inclusive to the minute.
 * - Drawer: a cash shift. A payment belongs to the shift open at its
 *   store when it was taken (the operator's own shift when several are
 *   open at once). Drawer numbers are the shift id's first 8 characters.
 * - Operator: the associate on the register sale or the salesperson on
 *   the order; initials in the register, name in the group heading.
 * - Balanced / UnBalanced Drawer Reference: balanced = the drawer has
 *   been closed (counted); unbalanced = still open, or no drawer at all.
 * - Imported legacy documents are excluded (D8): their money never
 *   touched a Jetnine drawer.
 * - Customer Code: the STORIS customer number when the customer came
 *   over in the migration (`legacy_refs`, entity `customer`, from a STORIS
 *   import batch — connector imports map Shopify / WooCommerce / Wix ids
 *   there too and are not STORIS numbers); otherwise the first 8
 *   characters of the Jetnine id. Store code is the
 *   location's order prefix ("02" in the STORIS output).
 *
 * Output: JSON for the page, `format=csv`, and — matching the STORIS
 * "S Basic PDF" spool line for line — `format=pdf` (Courier landscape)
 * and `format=txt` (the same pages, form-feed separated).
 */

export type BalanceBy = 'drawer' | 'operator' | 'store';
export type DrawerState = 'all' | 'balanced' | 'unbalanced';

export interface DrawerBalance {
  id: string;
  number: string;
  locationId: string;
  locationName: string;
  operatorId: string;
  operatorName: string;
  openedAt: string;
  closedAt: string | null;
  /** balanced = closed and counted; open = still running. */
  status: 'balanced' | 'open';
  openingFloatCents: number;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
  /** Null until closed; |variance| within ops.cashBalancing.toleranceCents. */
  inTolerance: boolean | null;
}

export interface PaymentLine {
  paymentId: string;
  kind: string;
  documentType: 'sale' | 'order' | 'service';
  documentId: string;
  /** The document number — STORIS "Reference". */
  reference: string;
  customerId: string | null;
  customerCode: string | null;
  customerName: string | null;
  paymentType: string;
  /** Gift cert. / check no. / processor reference. */
  tenderRef: string | null;
  amountCents: number;
  /** Every payment on the same document inside the window. */
  referenceSubtotalCents: number;
  /** Store-local day and HH:MM. */
  day: string;
  time: string;
  drawerId: string | null;
  drawerNumber: string | null;
  operatorId: string | null;
  operatorInitials: string | null;
  operatorName: string | null;
  locationId: string;
  locationName: string;
}

export interface PaymentTypeGroup {
  key: string;
  label: string;
  count: number;
  amountCents: number;
  lines: PaymentLine[];
}

export interface PayClassGroup {
  code: number;
  label: string;
  count: number;
  amountCents: number;
  paymentTypes: PaymentTypeGroup[];
}

export interface Reconciliation {
  cashCents: number;
  checkCents: number;
  /** Cash + check: what goes to the bank. */
  depositCents: number;
}

export interface BalanceGroup {
  key: string;
  /** Store code (order prefix), drawer number, or operator initials. */
  code: string | null;
  label: string;
  sublabel: string | null;
  count: number;
  amountCents: number;
  payClasses: PayClassGroup[];
  reconciliation: Reconciliation;
  drawers: DrawerBalance[];
}

export interface CashDrawerBalancingReport {
  generatedAt: string;
  range: { start: string; end: string; startTime: string; endTime: string };
  balanceBy: BalanceBy;
  filters: {
    locationId: string | null;
    locationCode: string | null;
    locationName: string | null;
    operatorId: string | null;
    operatorName: string | null;
    drawerId: string | null;
    drawerState: DrawerState;
  };
  toleranceCents: number;
  groups: BalanceGroup[];
  count: number;
  amountCents: number;
  reconciliation: Reconciliation;
}

const PAY_CLASSES: Record<string, { code: number; label: string }> = {
  cash: { code: 1, label: 'CASH' },
  check: { code: 2, label: 'CHECK' },
  card: { code: 3, label: 'CREDIT' },
  external_card: { code: 3, label: 'CREDIT' },
  financing: { code: 4, label: 'FINANCING' },
  gift_card: { code: 5, label: 'GIFT CARD' },
  store_credit: { code: 6, label: 'STORE CREDIT' },
};
const OTHER_CLASS = { code: 9, label: 'OTHER' };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isTime(s: unknown): s is string {
  return typeof s === 'string' && TIME_RE.test(s);
}

function initials(name: string | null, email: string | null): string | null {
  const src = (name ?? '').trim();
  if (src) {
    const parts = src.split(/\s+/).filter(Boolean);
    return parts
      .map((p) => p[0]!)
      .join('')
      .slice(0, 3)
      .toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return null;
}

function drawerNumber(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function paymentTypeLabel(row: {
  method: string;
  processor: string | null;
  financingProvider: string | null;
}): string {
  const base = row.method.replace(/_/g, ' ').toUpperCase();
  if (row.method === 'card' && row.processor) return `${base} - ${row.processor.toUpperCase()}`;
  if (row.method === 'financing' && row.financingProvider) {
    return `${base} - ${row.financingProvider.toUpperCase()}`;
  }
  return base;
}

function localParts(at: Date, tz: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
}

@TenantScoped()
@Controller('v1/reports/cash-drawer-balancing')
export class CashDrawerBalancingController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get()
  @RequirePermission('reports.sales.view')
  async report(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('startTime') startTimeRaw?: string,
    @Query('endTime') endTimeRaw?: string,
    @Query('balanceBy') balanceByRaw?: string,
    @Query('locationId') locationId?: string,
    @Query('operatorId') operatorId?: string,
    @Query('drawerId') drawerIdRaw?: string,
    @Query('drawerState') drawerStateRaw?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<CashDrawerBalancingReport | void> {
    const today = new Date().toISOString().slice(0, 10);
    const range: DayRange = parseDayRange(start, end) ?? { start: today, end: today };
    const startTime = isTime(startTimeRaw) ? startTimeRaw : '00:00';
    const endTime = isTime(endTimeRaw) ? endTimeRaw : '23:59';
    const balanceBy: BalanceBy =
      balanceByRaw === 'drawer' || balanceByRaw === 'operator' ? balanceByRaw : 'store';
    const drawerState: DrawerState =
      drawerStateRaw === 'balanced' || drawerStateRaw === 'unbalanced' ? drawerStateRaw : 'all';
    const drawerFilter = drawerIdRaw?.trim() || null;

    const businessId = tenant.businessId!;
    const business = await this.business(businessId);
    const toleranceCents = business.toleranceCents;

    const saleAssociate = alias(schema.users, 'sale_associate');
    const spMembership = alias(schema.memberships, 'sp_membership');
    const spUser = alias(schema.users, 'sp_user');
    const docLocation = sql<string>`COALESCE(${schema.sales.locationId}, ${schema.orders.locationId}, ${schema.serviceOrders.locationId})`;
    const localTs = sql`(${schema.payments.createdAt} AT TIME ZONE ${schema.locations.timezone})`;
    const windowFrom = sql`(${range.start} || ' ' || ${startTime})::timestamp`;
    const windowTo = sql`((${range.end} || ' ' || ${endTime})::timestamp + interval '1 minute')`;

    const rows = await this.db
      .select({
        paymentId: schema.payments.id,
        kind: schema.payments.kind,
        method: schema.payments.method,
        processor: schema.payments.processor,
        processorRef: schema.payments.processorRef,
        financingProvider: schema.payments.financingProvider,
        financingRef: schema.payments.financingRef,
        amountCents: schema.payments.amountCents,
        createdAt: schema.payments.createdAt,
        saleId: schema.payments.saleId,
        orderId: schema.payments.orderId,
        serviceOrderId: schema.payments.serviceOrderId,
        saleNumber: schema.sales.number,
        orderNumber: schema.orders.number,
        serviceNumber: schema.serviceOrders.number,
        customerId: sql<
          string | null
        >`COALESCE(${schema.sales.customerId}, ${schema.orders.customerId}, ${schema.serviceOrders.customerId})`,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        locationId: docLocation,
        locationName: schema.locations.name,
        locationCode: schema.locations.orderPrefix,
        timezone: schema.locations.timezone,
        day: sql<string>`to_char(${localTs}, 'YYYY-MM-DD')`,
        time: sql<string>`to_char(${localTs}, 'HH24:MI')`,
        operatorId: sql<string | null>`COALESCE(${saleAssociate.id}, ${spUser.id})`,
        operatorName: sql<string | null>`COALESCE(${saleAssociate.name}, ${spUser.name})`,
        operatorEmail: sql<string | null>`COALESCE(${saleAssociate.email}, ${spUser.email})`,
      })
      .from(schema.payments)
      .leftJoin(schema.sales, eq(schema.sales.id, schema.payments.saleId))
      .leftJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .leftJoin(schema.serviceOrders, eq(schema.serviceOrders.id, schema.payments.serviceOrderId))
      .leftJoin(schema.locations, sql`${schema.locations.id} = ${docLocation}`)
      .leftJoin(
        schema.customers,
        sql`${schema.customers.id} = COALESCE(${schema.sales.customerId}, ${schema.orders.customerId}, ${schema.serviceOrders.customerId})`,
      )
      .leftJoin(saleAssociate, eq(saleAssociate.id, schema.sales.associateUserId))
      .leftJoin(spMembership, eq(spMembership.id, schema.orders.salespersonMembershipId))
      .leftJoin(spUser, eq(spUser.id, spMembership.userId))
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          eq(schema.payments.status, 'succeeded'),
          isNull(schema.sales.importedAt),
          isNull(schema.orders.importedAt),
          isNull(schema.serviceOrders.importedAt),
          sql`${schema.locations.id} IS NOT NULL`,
          sql`${localTs} >= ${windowFrom}`,
          sql`${localTs} < ${windowTo}`,
          locationId ? sql`${docLocation} = ${locationId}` : undefined,
          salesScopeCond(tenant, docLocation),
        ),
      )
      .orderBy(asc(schema.payments.createdAt));

    // Drawers: every shift that could hold one of these payments, or
    // that was balanced (closed) inside the window. Attribution runs in
    // JS because two operators may legitimately have drawers open at one
    // store at the same time.
    const lower = new Date(`${range.start}T00:00:00.000Z`);
    lower.setUTCDate(lower.getUTCDate() - 2);
    const upper = new Date(`${range.end}T00:00:00.000Z`);
    upper.setUTCDate(upper.getUTCDate() + 2);
    const shifts = await this.db
      .select({
        id: schema.cashShifts.id,
        locationId: schema.cashShifts.locationId,
        locationName: schema.locations.name,
        timezone: schema.locations.timezone,
        openedByUserId: schema.cashShifts.openedByUserId,
        openedByName: schema.users.name,
        openedByEmail: schema.users.email,
        openedAt: schema.cashShifts.openedAt,
        closedAt: schema.cashShifts.closedAt,
        openingFloatCents: schema.cashShifts.openingFloatCents,
        expectedCashCents: schema.cashShifts.expectedCashCents,
        countedCashCents: schema.cashShifts.countedCashCents,
        varianceCents: schema.cashShifts.varianceCents,
      })
      .from(schema.cashShifts)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.cashShifts.locationId))
      .leftJoin(schema.users, eq(schema.users.id, schema.cashShifts.openedByUserId))
      .where(
        and(
          eq(schema.cashShifts.businessId, businessId),
          lt(schema.cashShifts.openedAt, upper),
          or(isNull(schema.cashShifts.closedAt), gte(schema.cashShifts.closedAt, lower)),
          locationId ? eq(schema.cashShifts.locationId, locationId) : undefined,
          salesScopeCond(tenant, schema.cashShifts.locationId),
        ),
      )
      .orderBy(asc(schema.cashShifts.openedAt));

    const drawerById = new Map<string, DrawerBalance>();
    for (const s of shifts) {
      const balanced = s.closedAt != null;
      drawerById.set(s.id, {
        id: s.id,
        number: drawerNumber(s.id),
        locationId: s.locationId,
        locationName: s.locationName,
        operatorId: s.openedByUserId,
        operatorName: s.openedByName ?? s.openedByEmail ?? '(unknown)',
        openedAt: s.openedAt.toISOString(),
        closedAt: s.closedAt ? s.closedAt.toISOString() : null,
        status: balanced ? 'balanced' : 'open',
        openingFloatCents: s.openingFloatCents,
        expectedCashCents: s.expectedCashCents,
        countedCashCents: s.countedCashCents,
        varianceCents: s.varianceCents,
        inTolerance:
          balanced && s.varianceCents != null ? Math.abs(s.varianceCents) <= toleranceCents : null,
      });
    }
    const drawerFor = (locId: string, at: Date, operator: string | null): DrawerBalance | null => {
      const t = at.getTime();
      const open = shifts.filter(
        (s) =>
          s.locationId === locId &&
          s.openedAt.getTime() <= t &&
          (s.closedAt == null || s.closedAt.getTime() > t),
      );
      if (open.length === 0) return null;
      const own = operator ? open.find((s) => s.openedByUserId === operator) : undefined;
      return drawerById.get((own ?? open[0]!).id) ?? null;
    };

    // STORIS customer numbers for migrated customers (D7 identity map).
    // The source lives on the import batch (the ref's own column is the
    // 'storis' default), so a Shopify / WooCommerce / Wix customer ref
    // (`shp-…`, `woo-…`) is never mistaken for a STORIS number.
    const customerIds = [...new Set(rows.map((r) => r.customerId).filter((c): c is string => !!c))];
    const legacyCustomerCode = new Map<string, string>();
    if (customerIds.length > 0) {
      const refs = await this.db
        .select({ jetnineId: schema.legacyRefs.jetnineId, legacyId: schema.legacyRefs.legacyId })
        .from(schema.legacyRefs)
        .leftJoin(
          schema.importBatches,
          eq(schema.importBatches.id, schema.legacyRefs.importBatchId),
        )
        .where(
          and(
            eq(schema.legacyRefs.businessId, businessId),
            eq(schema.legacyRefs.entity, 'customer'),
            inArray(schema.legacyRefs.jetnineId, customerIds),
            sql`COALESCE(${schema.importBatches.source}, ${schema.legacyRefs.source}) = 'storis'`,
          ),
        );
      for (const ref of refs) legacyCustomerCode.set(ref.jetnineId, ref.legacyId);
    }
    const customerCode = (id: string | null): string | null =>
      id ? (legacyCustomerCode.get(id) ?? id.slice(0, 8).toUpperCase()) : null;
    const storeCode = new Map<string, string | null>();
    for (const r of rows) storeCode.set(r.locationId, r.locationCode);

    // Reference subtotal: all money on the same document inside the window.
    const docTotals = new Map<string, number>();
    for (const r of rows) {
      const docKey = r.saleId ?? r.orderId ?? r.serviceOrderId ?? r.paymentId;
      docTotals.set(docKey, (docTotals.get(docKey) ?? 0) + r.amountCents);
    }

    const lines: PaymentLine[] = [];
    const methodOf = new Map<string, string>();
    for (const r of rows) {
      const drawer = drawerFor(r.locationId, r.createdAt, r.operatorId);
      if (drawerFilter) {
        if (!drawer) continue;
        if (drawer.id !== drawerFilter && drawer.number !== drawerFilter.toUpperCase()) continue;
      }
      if (drawerState === 'balanced' && drawer?.status !== 'balanced') continue;
      if (drawerState === 'unbalanced' && drawer?.status === 'balanced') continue;
      if (operatorId && r.operatorId !== operatorId) continue;
      const documentType: PaymentLine['documentType'] = r.saleId
        ? 'sale'
        : r.orderId
          ? 'order'
          : 'service';
      const docKey = r.saleId ?? r.orderId ?? r.serviceOrderId ?? r.paymentId;
      const customerName =
        [r.customerLast, r.customerFirst].filter(Boolean).join(' ').trim() || null;
      methodOf.set(r.paymentId, r.method);
      lines.push({
        paymentId: r.paymentId,
        kind: r.kind,
        documentType,
        documentId: docKey,
        reference: r.saleNumber ?? r.orderNumber ?? r.serviceNumber ?? '—',
        customerId: r.customerId,
        customerCode: customerCode(r.customerId),
        customerName: customerName ? customerName.toUpperCase() : null,
        paymentType: paymentTypeLabel(r),
        tenderRef: r.processorRef ?? r.financingRef ?? null,
        amountCents: r.amountCents,
        referenceSubtotalCents: docTotals.get(docKey) ?? r.amountCents,
        day: r.day,
        time: r.time,
        drawerId: drawer?.id ?? null,
        drawerNumber: drawer?.number ?? null,
        operatorId: r.operatorId,
        operatorInitials: initials(r.operatorName, r.operatorEmail),
        operatorName: r.operatorName ?? r.operatorEmail ?? null,
        locationId: r.locationId,
        locationName: r.locationName ?? '(unknown)',
      });
    }

    // Group: store / operator / drawer → pay class → payment type.
    const groups = new Map<string, BalanceGroup & { methods: Map<string, PaymentLine[]> }>();
    const groupKey = (
      l: PaymentLine,
    ): { key: string; code: string | null; label: string; sublabel: string | null } => {
      if (balanceBy === 'operator') {
        return {
          key: l.operatorId ?? 'none',
          code: l.operatorInitials,
          label: l.operatorName ?? 'No operator',
          sublabel: l.operatorInitials,
        };
      }
      if (balanceBy === 'drawer') {
        return {
          key: l.drawerId ?? `none:${l.locationId}`,
          code: l.drawerNumber,
          label: l.drawerNumber ? `Drawer ${l.drawerNumber}` : 'No drawer',
          sublabel: l.locationName,
        };
      }
      return {
        key: l.locationId,
        code: storeCode.get(l.locationId) ?? null,
        label: l.locationName,
        sublabel: null,
      };
    };
    for (const l of lines) {
      const g = groupKey(l);
      let group = groups.get(g.key);
      if (!group) {
        group = {
          key: g.key,
          code: g.code,
          label: g.label,
          sublabel: g.sublabel,
          count: 0,
          amountCents: 0,
          payClasses: [],
          reconciliation: { cashCents: 0, checkCents: 0, depositCents: 0 },
          drawers: [],
          methods: new Map(),
        };
        groups.set(g.key, group);
      }
      const method = methodOf.get(l.paymentId) ?? 'other';
      const bucket = group.methods.get(method) ?? [];
      bucket.push(l);
      group.methods.set(method, bucket);
    }

    const grand: Reconciliation = { cashCents: 0, checkCents: 0, depositCents: 0 };
    let grandCount = 0;
    let grandAmount = 0;
    const out: BalanceGroup[] = [];
    for (const group of groups.values()) {
      const byClass = new Map<number, PayClassGroup & { types: Map<string, PaymentTypeGroup> }>();
      for (const [method, bucket] of group.methods) {
        const cls = PAY_CLASSES[method] ?? OTHER_CLASS;
        let pc = byClass.get(cls.code);
        if (!pc) {
          pc = {
            code: cls.code,
            label: cls.label,
            count: 0,
            amountCents: 0,
            paymentTypes: [],
            types: new Map(),
          };
          byClass.set(cls.code, pc);
        }
        for (const l of bucket) {
          let pt = pc.types.get(l.paymentType);
          if (!pt) {
            pt = { key: l.paymentType, label: l.paymentType, count: 0, amountCents: 0, lines: [] };
            pc.types.set(l.paymentType, pt);
          }
          pt.lines.push(l);
          pt.count += 1;
          pt.amountCents += l.amountCents;
          pc.count += 1;
          pc.amountCents += l.amountCents;
          group.count += 1;
          group.amountCents += l.amountCents;
          if (method === 'cash') group.reconciliation.cashCents += l.amountCents;
          if (method === 'check') group.reconciliation.checkCents += l.amountCents;
        }
      }
      group.reconciliation.depositCents =
        group.reconciliation.cashCents + group.reconciliation.checkCents;
      group.payClasses = [...byClass.values()]
        .sort((a, b) => a.code - b.code)
        .map((pc) => ({
          code: pc.code,
          label: pc.label,
          count: pc.count,
          amountCents: pc.amountCents,
          paymentTypes: [...pc.types.values()].sort((a, b) => a.label.localeCompare(b.label)),
        }));
      grand.cashCents += group.reconciliation.cashCents;
      grand.checkCents += group.reconciliation.checkCents;
      grandCount += group.count;
      grandAmount += group.amountCents;

      // Drawers that belong under this heading: the group's own drawer, the
      // operator's drawers, or every drawer balanced/open at the store
      // inside the balance-date window.
      const inWindow = (d: DrawerBalance) => {
        const at = new Date(d.closedAt ?? d.openedAt);
        const tz = shifts.find((s) => s.id === d.id)?.timezone ?? 'UTC';
        const { day } = localParts(at, tz);
        return day >= range.start && day <= range.end;
      };
      group.drawers = [...drawerById.values()].filter((d) => {
        if (drawerState === 'balanced' && d.status !== 'balanced') return false;
        if (drawerState === 'unbalanced' && d.status === 'balanced') return false;
        if (balanceBy === 'drawer') return d.id === group.key;
        if (balanceBy === 'operator') return d.operatorId === group.key && inWindow(d);
        return d.locationId === group.key && inWindow(d);
      });
      const { methods: _methods, ...rest } = group;
      void _methods;
      out.push(rest);
    }
    grand.depositCents = grand.cashCents + grand.checkCents;
    out.sort((a, b) => a.label.localeCompare(b.label));

    // Echo the parameters the STORIS way: the store's code, the operator's name.
    const filteredStore = locationId
      ? ((
          await this.db
            .select({
              name: schema.locations.name,
              code: schema.locations.orderPrefix,
              timezone: schema.locations.timezone,
            })
            .from(schema.locations)
            .where(
              and(eq(schema.locations.businessId, businessId), eq(schema.locations.id, locationId)),
            )
            .limit(1)
        )[0] ?? null)
      : null;
    const filteredOperator = operatorId
      ? ((
          await this.db
            .select({ name: schema.users.name, email: schema.users.email })
            .from(schema.users)
            .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
            .where(
              and(eq(schema.memberships.businessId, businessId), eq(schema.users.id, operatorId)),
            )
            .limit(1)
        )[0] ?? null)
      : null;

    const report: CashDrawerBalancingReport = {
      generatedAt: new Date().toISOString(),
      range: { ...range, startTime, endTime },
      balanceBy,
      filters: {
        locationId: locationId ?? null,
        locationCode: filteredStore?.code ?? null,
        locationName: filteredStore?.name ?? null,
        operatorId: operatorId ?? null,
        operatorName: filteredOperator ? (filteredOperator.name ?? filteredOperator.email) : null,
        drawerId: drawerFilter,
        drawerState,
      },
      toleranceCents,
      groups: out,
      count: grandCount,
      amountCents: grandAmount,
      reconciliation: grand,
    };

    if (format === 'csv') {
      const headers = [
        'Group',
        'Pay class',
        'Payment type',
        'Customer code',
        'Customer name',
        'Reference',
        'Tender ref',
        'Amount',
        'Reference subtotal',
        'Date',
        'Time',
        'Drawer',
        'Operator',
      ];
      const data: (string | number | null)[][] = [];
      for (const g of report.groups) {
        for (const pc of g.payClasses) {
          for (const pt of pc.paymentTypes) {
            for (const l of pt.lines) {
              data.push([
                g.label,
                `${pc.code} - ${pc.label}`,
                pt.label,
                l.customerCode,
                l.customerName,
                l.reference,
                l.tenderRef,
                (l.amountCents / 100).toFixed(2),
                (l.referenceSubtotalCents / 100).toFixed(2),
                l.day,
                l.time,
                l.drawerNumber,
                l.operatorInitials,
              ]);
            }
          }
        }
      }
      data.push([]);
      data.push(['Grand total', '', '', '', '', '', '', (report.amountCents / 100).toFixed(2)]);
      data.push(['Cash', '', '', '', '', '', '', (grand.cashCents / 100).toFixed(2)]);
      data.push(['Check', '', '', '', '', '', '', (grand.checkCents / 100).toFixed(2)]);
      data.push(['Total deposit', '', '', '', '', '', '', (grand.depositCents / 100).toFixed(2)]);
      res!.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res!.setHeader(
        'Content-Disposition',
        `attachment; filename="cash-drawer-balancing-${range.start}-to-${range.end}.csv"`,
      );
      res!.send(toCsv(headers, data));
      return;
    }
    if (format === 'pdf' || format === 'txt') {
      // The header clock runs on the store's time: the filtered store's,
      // else the first store on the register, else the first store.
      const timezone =
        filteredStore?.timezone ??
        rows[0]?.timezone ??
        (await this.firstTimezone(businessId)) ??
        'UTC';
      const ctx = { businessName: business.name, generatedAt: new Date(), timezone };
      const stem = `cash-drawer-balancing-${range.start}-to-${range.end}`;
      if (format === 'pdf') {
        const pdf = textPagesToPdf(renderCashDrawerBalancingPages(report, ctx), {
          title: 'Report Cash Drawer Balancing Totals',
        });
        res!.setHeader('Content-Type', 'application/pdf');
        res!.setHeader('Content-Disposition', `attachment; filename="${stem}.pdf"`);
        res!.send(pdf);
        return;
      }
      res!.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res!.setHeader('Content-Disposition', `attachment; filename="${stem}.txt"`);
      res!.send(renderCashDrawerBalancingText(report, ctx));
      return;
    }
    return report;
  }

  private async business(businessId: string): Promise<{ name: string; toleranceCents: number }> {
    const [biz] = await this.db
      .select({ name: schema.businesses.name, opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const ops = (biz?.opsSettingsJson ?? {}) as {
      cashBalancing?: { toleranceCents?: number | null } | null;
    };
    const t = ops.cashBalancing?.toleranceCents;
    return { name: biz?.name ?? '', toleranceCents: typeof t === 'number' && t >= 0 ? t : 0 };
  }

  private async firstTimezone(businessId: string): Promise<string | null> {
    const [loc] = await this.db
      .select({ timezone: schema.locations.timezone })
      .from(schema.locations)
      .where(eq(schema.locations.businessId, businessId))
      .orderBy(asc(schema.locations.createdAt))
      .limit(1);
    return loc?.timezone ?? null;
  }
}
