import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { loadReturnsSettledByOrder } from '../orders/order-balance';
import type { RequestTenantContext } from '../tenancy/request-context';
import {
  resolveOpsThresholds,
  sortFeed,
  splitFamilyBase,
  subjectKey,
  withoutCleared,
  type OpsFeedRow,
  type OpsReviewSettings,
  type OpsThresholds,
} from './ops-feed';

/**
 * Stock movements the Operations member audits. Everything else —
 * `sale`, `order_reserve`, `order_release`, `order_fulfill`, `receive`,
 * `receive_po`, `import` — is the system doing what it was told, and
 * putting it on the feed would bury the movements a person chose to
 * make.
 */
const AUDITED_MOVEMENT_REASONS: Record<string, { label: string; severity: 'warning' | 'info' }> = {
  count_correction: { label: 'Count correction', severity: 'warning' },
  damage: { label: 'Damage write-down', severity: 'warning' },
  theft: { label: 'Shrink', severity: 'warning' },
  other: { label: 'Manual adjustment', severity: 'warning' },
  physical_count: { label: 'Cycle-count variance', severity: 'warning' },
  unreceive_po: { label: 'Receiving reversal', severity: 'warning' },
  as_is_restock: { label: 'As-is restock', severity: 'info' },
  transfer_in: { label: 'Transfer in', severity: 'info' },
  transfer_out: { label: 'Transfer out', severity: 'info' },
};

export interface OpsFeedResult {
  rows: OpsFeedRow[];
  thresholds: OpsThresholds;
  /** Rows the query produced before the cap, so the UI can say "+N more". */
  totalBeforeCap: number;
}

/**
 * Builds the operations feed: one prioritized list of everything a
 * person did to money or stock that a second pair of eyes should see.
 *
 * Each signal is its own query rather than one union — they hit
 * different tables with different time columns, and keeping them apart
 * means a new signal is an added method, not a rewritten query. The
 * cost is a fixed number of small indexed reads per request, which is
 * why the endpoint is separate from the dashboard summary.
 */
@Injectable()
export class OpsFeedService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  async thresholdsFor(businessId: string): Promise<OpsThresholds> {
    const [biz] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const ops = (biz?.opsSettingsJson ?? {}) as { opsReview?: OpsReviewSettings | null };
    return resolveOpsThresholds(ops.opsReview ?? null);
  }

  async build(
    tenant: RequestTenantContext,
    opts: { days?: number; cap?: number } = {},
  ): Promise<OpsFeedResult> {
    const businessId = tenant.businessId!;
    const thresholds = await this.thresholdsFor(businessId);
    const days = opts.days && opts.days > 0 ? Math.min(90, opts.days) : thresholds.lookbackDays;
    const since = new Date(Date.now() - days * 86_400_000);
    const cap = opts.cap && opts.cap > 0 ? Math.min(500, opts.cap) : 200;

    const locationNames = await this.locationNames(businessId);
    const userNames = await this.userNames(businessId);
    const name = (id: string | null) => (id ? (userNames.get(id) ?? null) : null);
    const store = (id: string | null) => (id ? (locationNames.get(id) ?? null) : null);

    const collected = await Promise.all([
      this.negativeStock(tenant, businessId, store),
      this.openTakeWiths(tenant, businessId, thresholds, store),
      this.drawerVariances(tenant, businessId, thresholds, since, name, store),
      this.discounts(tenant, businessId, thresholds, since, name, store),
      this.refunds(tenant, businessId, thresholds, since, name, store),
      this.returns(tenant, businessId, thresholds, since, name, store),
      this.exchanges(tenant, businessId, since, name, store),
      this.writeOffs(tenant, businessId, thresholds, since, name, store),
      this.stockMovements(tenant, businessId, thresholds, since, name, store),
      this.giftCardAdjustments(businessId, since, name),
      this.securityOverrides(businessId, since, name),
      this.exceptions(businessId, since, name),
    ]);

    const all = collected.flat();
    const cleared = await this.clearedKeys(
      businessId,
      all.filter((r) => r.clearVia === 'review'),
    );
    const open = sortFeed(withoutCleared(all, cleared));
    return { rows: open.slice(0, cap), thresholds, totalBeforeCap: open.length };
  }

  /**
   * When each subject was last signed off in `ops_reviews`. The time
   * matters: withoutCleared() resurfaces a subject whose occurredAt has
   * moved past its review, so a standing condition that recurs is never
   * hidden behind a stale sign-off.
   */
  private async clearedKeys(
    businessId: string,
    candidates: OpsFeedRow[],
  ): Promise<Map<string, Date>> {
    if (candidates.length === 0) return new Map();
    const ids = [...new Set(candidates.map((r) => r.subjectId))];
    const rows = await this.db
      .select({
        subjectType: schema.opsReviews.subjectType,
        subjectId: schema.opsReviews.subjectId,
        reviewedAt: schema.opsReviews.reviewedAt,
      })
      .from(schema.opsReviews)
      .where(
        and(
          eq(schema.opsReviews.businessId, businessId),
          inArray(schema.opsReviews.subjectId, ids),
        ),
      );
    return new Map(rows.map((r) => [`${r.subjectType}:${r.subjectId}`, r.reviewedAt]));
  }

  private async locationNames(businessId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: schema.locations.id, name: schema.locations.name })
      .from(schema.locations)
      .where(eq(schema.locations.businessId, businessId));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async userNames(businessId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .selectDistinct({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.users)
      .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
      .where(eq(schema.memberships.businessId, businessId));
    return new Map(rows.map((r) => [r.id, r.name ?? r.email]));
  }

  // ---------------------------------------------------------------- signals

  /**
   * Negative on-hand. No time bound and no threshold: stock cannot be
   * less than nothing, so the number is always a break in the ledger,
   * however old. Critical, and it stays critical until someone counts.
   */
  private async negativeStock(
    tenant: RequestTenantContext,
    businessId: string,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.inventoryLevels.id,
        onHand: schema.inventoryLevels.onHand,
        locationId: schema.inventoryLevels.locationId,
        updatedAt: schema.inventoryLevels.updatedAt,
        sku: schema.productVariants.sku,
        productName: schema.products.name,
      })
      .from(schema.inventoryLevels)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.inventoryLevels.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.inventoryLevels.businessId, businessId),
          lt(schema.inventoryLevels.onHand, 0),
          salesScopeCond(tenant, schema.inventoryLevels.locationId),
        ),
      );
    return rows.map((r) => ({
      subjectType: 'negative_stock' as const,
      subjectId: r.id,
      severity: 'critical' as const,
      kind: 'Negative on-hand',
      summary: `${r.productName}${r.sku ? ` (${r.sku})` : ''} is at ${r.onHand} on hand`,
      amountCents: null,
      actorUserId: null,
      actorName: null,
      locationId: r.locationId,
      locationName: store(r.locationId),
      href: '/inventory',
      occurredAt: r.updatedAt,
      clearVia: 'review' as const,
    }));
  }

  /**
   * The owner's sharpest signal (2026-08-31): goods walked out on a
   * split ticket that never closed. A take-with line the customer has
   * already been handed (`qty_fulfilled > 0`) on an order that is
   * neither completed nor cancelled, where the ticket is genuinely
   * split — either the lines carry more than one fulfillment method,
   * or the document has letter-suffixed siblings.
   */
  private async openTakeWiths(
    tenant: RequestTenantContext,
    businessId: string,
    thresholds: OpsThresholds,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const cutoff = new Date(Date.now() - thresholds.takeWithOpenHours * 3_600_000);
    const effective = sql`COALESCE(${schema.orderLines.fulfillmentMethod}, ${schema.orders.fulfillmentType})`;
    const candidates = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        locationId: schema.orders.locationId,
        totalCents: sql<number>`${schema.orders.totalCents}::int`,
        createdAt: schema.orders.createdAt,
        takeWithUnits: sql<number>`SUM(CASE WHEN ${effective} = 'take_with' THEN ${schema.orderLines.qtyFulfilled} ELSE 0 END)::int`,
        methodCount: sql<number>`COUNT(DISTINCT ${effective})::int`,
      })
      .from(schema.orders)
      .innerJoin(schema.orderLines, eq(schema.orderLines.orderId, schema.orders.id))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          sql`${schema.orders.status} NOT IN ('completed', 'cancelled', 'draft', 'quote')`,
          isNull(schema.orders.importedAt),
          lt(schema.orders.createdAt, cutoff),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      )
      .groupBy(
        schema.orders.id,
        schema.orders.number,
        schema.orders.status,
        schema.orders.locationId,
        schema.orders.totalCents,
        schema.orders.createdAt,
      )
      .having(
        sql`SUM(CASE WHEN ${effective} = 'take_with' THEN ${schema.orderLines.qtyFulfilled} ELSE 0 END) > 0`,
      );
    if (candidates.length === 0) return [];

    // Balance due is derived money — computed from the payment ledger,
    // never read off a stored column (CLAUDE.md). A half-paid split
    // ticket's exposure is the balance, not the face value.
    const paidRows = await this.db
      .select({
        orderId: schema.payments.orderId,
        cents: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)::int`,
      })
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.businessId, businessId),
          inArray(
            schema.payments.orderId,
            candidates.map((c) => c.id),
          ),
          eq(schema.payments.status, 'succeeded'),
        ),
      )
      .groupBy(schema.payments.orderId);
    const paidBy = new Map(paidRows.map((r) => [r.orderId, r.cents]));
    const settledBy = await loadReturnsSettledByOrder(
      this.db,
      candidates.map((c) => c.id),
    );

    // Second pass for the family test: an order whose lines all share
    // one method can still be half of a split, as its own document.
    const bases = [...new Set(candidates.map((c) => splitFamilyBase(c.number)))];
    const family = await this.db
      .select({ number: schema.orders.number })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          or(
            inArray(schema.orders.number, bases),
            ...bases.map((b) => sql`${schema.orders.number} LIKE ${`${b}-_`}`),
          ),
        ),
      );
    const familySize = new Map<string, number>();
    for (const f of family) {
      const base = splitFamilyBase(f.number);
      familySize.set(base, (familySize.get(base) ?? 0) + 1);
    }

    return candidates
      .filter((c) => c.methodCount > 1 || (familySize.get(splitFamilyBase(c.number)) ?? 1) > 1)
      .map((c) => ({
        subjectType: 'take_with_open' as const,
        subjectId: c.id,
        severity: 'critical' as const,
        kind: 'Take-with on an open ticket',
        summary: `${c.number}: ${c.takeWithUnits} unit${c.takeWithUnits === 1 ? '' : 's'} went out on a split ticket still ${c.status}`,
        amountCents: Math.max(
          0,
          c.totalCents - (paidBy.get(c.id) ?? 0) - (settledBy.get(c.id) ?? 0),
        ),
        actorUserId: null,
        actorName: null,
        locationId: c.locationId,
        locationName: store(c.locationId),
        href: `/orders/${c.id}`,
        occurredAt: c.createdAt,
        clearVia: 'review' as const,
      }));
  }

  private async drawerVariances(
    tenant: RequestTenantContext,
    businessId: string,
    thresholds: OpsThresholds,
    since: Date,
    name: (id: string | null) => string | null,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.cashShifts.id,
        locationId: schema.cashShifts.locationId,
        varianceCents: schema.cashShifts.varianceCents,
        closedAt: schema.cashShifts.closedAt,
        openedAt: schema.cashShifts.openedAt,
        suspendedAt: schema.cashShifts.suspendedAt,
        closedByUserId: schema.cashShifts.closedByUserId,
        approvedByUserId: schema.cashShifts.approvedByUserId,
      })
      .from(schema.cashShifts)
      .where(
        and(
          eq(schema.cashShifts.businessId, businessId),
          // The signal fires at close (occurredAt = closedAt), so the
          // window bounds that — a shift opened before the window whose
          // count came up short yesterday still belongs on the feed.
          sql`COALESCE(${schema.cashShifts.closedAt}, ${schema.cashShifts.openedAt}) >= ${since.toISOString()}::timestamptz`,
          or(
            sql`ABS(COALESCE(${schema.cashShifts.varianceCents}, 0)) >= ${thresholds.drawerVarianceCents}`,
            sql`${schema.cashShifts.suspendedAt} IS NOT NULL`,
          ),
          salesScopeCond(tenant, schema.cashShifts.locationId),
        ),
      );
    return rows
      .filter((r) => r.suspendedAt != null || (r.varianceCents ?? 0) !== 0)
      .map((r) => {
        const variance = r.varianceCents ?? 0;
        const suspended = r.suspendedAt != null;
        return {
          subjectType: 'drawer_variance' as const,
          subjectId: r.id,
          severity: (suspended ? 'critical' : 'warning') as 'critical' | 'warning',
          kind: suspended ? 'Drawer suspended' : 'Drawer variance',
          summary: suspended
            ? `Drawer suspended after failed counts${variance ? ` (${variance > 0 ? 'over' : 'short'})` : ''}`
            : `Drawer ${variance > 0 ? 'over' : 'short'} by ${Math.abs(variance / 100).toFixed(2)}`,
          amountCents: variance,
          actorUserId: r.closedByUserId,
          actorName: name(r.closedByUserId),
          locationId: r.locationId,
          locationName: store(r.locationId),
          href: `/shifts/${r.id}`,
          occurredAt: r.closedAt ?? r.openedAt,
          clearVia: 'review' as const,
        };
      });
  }

  /**
   * Documents discounted at or past the threshold share of subtotal.
   * The settings registry has advertised this since the thresholds
   * shipped; the review pass caught that nothing read it. Order-level:
   * a deep line discount inside a shallow order is the price-variance
   * tiers' job (G6) — this signal watches the finished document.
   */
  private async discounts(
    tenant: RequestTenantContext,
    businessId: string,
    thresholds: OpsThresholds,
    since: Date,
    name: (id: string | null) => string | null,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    // discountPct = 100 means "flag only full write-downs"; the SQL
    // comparison handles it like any other value.
    const pctBps = Math.round(thresholds.discountPct * 100);
    const rows: OpsFeedRow[] = [];

    const saleRows = await this.db
      .select({
        id: schema.sales.id,
        number: schema.sales.number,
        discountCents: schema.sales.discountCents,
        subtotalCents: schema.sales.subtotalCents,
        associateUserId: schema.sales.associateUserId,
        locationId: schema.sales.locationId,
        createdAt: schema.sales.createdAt,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.businessId, businessId),
          gte(schema.sales.createdAt, since),
          eq(schema.sales.status, 'completed'),
          isNull(schema.sales.importedAt),
          sql`${schema.sales.subtotalCents} > 0`,
          sql`${schema.sales.discountCents} * 10000 >= ${schema.sales.subtotalCents} * ${pctBps}`,
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );
    for (const r of saleRows) {
      rows.push({
        subjectType: 'discount',
        subjectId: r.id,
        severity: 'warning',
        kind: 'Deep discount',
        summary: `${r.number}: ${Math.round((r.discountCents / r.subtotalCents) * 100)}% off ($${(r.discountCents / 100).toFixed(2)})`,
        amountCents: -r.discountCents,
        actorUserId: r.associateUserId,
        actorName: name(r.associateUserId),
        locationId: r.locationId,
        locationName: store(r.locationId),
        href: `/sales/${r.id}`,
        occurredAt: r.createdAt,
        clearVia: 'review',
      });
    }

    const orderRows = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        discountCents: schema.orders.discountCents,
        subtotalCents: schema.orders.subtotalCents,
        salespersonMembershipId: schema.orders.salespersonMembershipId,
        actorUserId: schema.memberships.userId,
        locationId: schema.orders.locationId,
        createdAt: schema.orders.createdAt,
      })
      .from(schema.orders)
      .leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.orders.salespersonMembershipId),
      )
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          gte(schema.orders.createdAt, since),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
          isNull(schema.orders.importedAt),
          sql`${schema.orders.subtotalCents} > 0`,
          sql`${schema.orders.discountCents} * 10000 >= ${schema.orders.subtotalCents} * ${pctBps}`,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    for (const r of orderRows) {
      rows.push({
        subjectType: 'discount',
        subjectId: r.id,
        severity: 'warning',
        kind: 'Deep discount',
        summary: `${r.number}: ${Math.round((r.discountCents / r.subtotalCents) * 100)}% off ($${(r.discountCents / 100).toFixed(2)})`,
        amountCents: -r.discountCents,
        actorUserId: r.actorUserId,
        actorName: name(r.actorUserId),
        locationId: r.locationId,
        locationName: store(r.locationId),
        href: `/orders/${r.id}`,
        occurredAt: r.createdAt,
        clearVia: 'review',
      });
    }
    return rows;
  }

  private async refunds(
    tenant: RequestTenantContext,
    businessId: string,
    thresholds: OpsThresholds,
    since: Date,
    name: (id: string | null) => string | null,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.refunds.id,
        saleId: schema.refunds.saleId,
        amountCents: schema.refunds.amountCents,
        reason: schema.refunds.reason,
        approvedByUserId: schema.refunds.approvedByUserId,
        createdAt: schema.refunds.createdAt,
        locationId: schema.sales.locationId,
        saleNumber: schema.sales.number,
      })
      .from(schema.refunds)
      .innerJoin(schema.sales, eq(schema.sales.id, schema.refunds.saleId))
      .where(
        and(
          eq(schema.refunds.businessId, businessId),
          gte(schema.refunds.createdAt, since),
          gte(schema.refunds.amountCents, thresholds.refundCents),
          isNull(schema.sales.importedAt),
          salesScopeCond(tenant, schema.sales.locationId),
        ),
      );
    return rows.map((r) => ({
      subjectType: 'refund' as const,
      subjectId: r.id,
      severity: 'warning' as const,
      kind: 'Refund',
      summary: `Refund on ${r.saleNumber}${r.reason ? ` — ${r.reason}` : ''}`,
      amountCents: -r.amountCents,
      actorUserId: r.approvedByUserId,
      actorName: name(r.approvedByUserId),
      locationId: r.locationId,
      locationName: store(r.locationId),
      href: `/sales/${r.saleId}`,
      occurredAt: r.createdAt,
      clearVia: 'review' as const,
    }));
  }

  private async returns(
    tenant: RequestTenantContext,
    businessId: string,
    thresholds: OpsThresholds,
    since: Date,
    name: (id: string | null) => string | null,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.orderReturns.id,
        rmaNumber: schema.orderReturns.rmaNumber,
        amountCents: schema.orderReturns.amountCents,
        status: schema.orderReturns.status,
        reason: schema.orderReturns.reason,
        createdByUserId: schema.orderReturns.createdByUserId,
        authorizedAt: schema.orderReturns.authorizedAt,
        orderId: schema.orderReturns.orderId,
        locationId: schema.orders.locationId,
      })
      .from(schema.orderReturns)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.orderReturns.orderId))
      .where(
        and(
          eq(schema.orderReturns.businessId, businessId),
          gte(schema.orderReturns.authorizedAt, since),
          gte(schema.orderReturns.amountCents, thresholds.refundCents),
          // A store-scoped member sees only their stores' returns. A
          // no-original return has no order and thus no location — it
          // fails closed for them, visible to all-store members only.
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    return rows.map((r) => ({
      subjectType: 'return' as const,
      subjectId: r.id,
      severity: 'warning' as const,
      kind: 'Return',
      summary: `${r.rmaNumber} (${r.status})${r.reason ? ` — ${r.reason}` : ''}`,
      amountCents: -r.amountCents,
      actorUserId: r.createdByUserId,
      actorName: name(r.createdByUserId),
      locationId: r.locationId,
      locationName: store(r.locationId),
      href: '/returns',
      occurredAt: r.authorizedAt,
      clearVia: 'review' as const,
    }));
  }

  /**
   * Every exchange entered is on the feed — the owner asked to see them
   * all, not just the exceptional ones. A waived restocking fee or an
   * entry still held for approval raises it from info to warning.
   */
  private async exchanges(
    tenant: RequestTenantContext,
    businessId: string,
    since: Date,
    name: (id: string | null) => string | null,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.exchanges.id,
        number: schema.exchanges.number,
        status: schema.exchanges.status,
        restockingFeeCents: schema.exchanges.restockingFeeCents,
        restockingFeeOverridden: schema.exchanges.restockingFeeOverridden,
        createdByUserId: schema.exchanges.createdByUserId,
        createdAt: schema.exchanges.createdAt,
        locationId: schema.orders.locationId,
      })
      .from(schema.exchanges)
      // Every exchange settles onto a sale order (not-null FK), which is
      // where its store lives.
      .innerJoin(schema.orders, eq(schema.orders.id, schema.exchanges.saleOrderId))
      .where(
        and(
          eq(schema.exchanges.businessId, businessId),
          gte(schema.exchanges.createdAt, since),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    return rows.map((r) => {
      const flagged = r.restockingFeeOverridden || r.status === 'on_hold';
      return {
        subjectType: 'exchange' as const,
        subjectId: r.id,
        severity: (flagged ? 'warning' : 'info') as 'warning' | 'info',
        kind: 'Exchange',
        summary: `${r.number} (${r.status})${r.restockingFeeOverridden ? ' — restocking fee overridden' : ''}`,
        amountCents: r.restockingFeeCents > 0 ? r.restockingFeeCents : null,
        actorUserId: r.createdByUserId,
        actorName: name(r.createdByUserId),
        locationId: r.locationId,
        locationName: store(r.locationId),
        href: `/exchanges/${r.id}`,
        occurredAt: r.createdAt,
        clearVia: 'review' as const,
      };
    });
  }

  private async writeOffs(
    tenant: RequestTenantContext,
    businessId: string,
    thresholds: OpsThresholds,
    since: Date,
    name: (id: string | null) => string | null,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.writeOffs.id,
        quantity: schema.writeOffs.quantity,
        totalCostCents: schema.writeOffs.totalCostCents,
        reason: schema.writeOffs.reason,
        actorUserId: schema.writeOffs.actorUserId,
        createdAt: schema.writeOffs.createdAt,
        locationId: schema.writeOffs.locationId,
        productName: schema.products.name,
      })
      .from(schema.writeOffs)
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.writeOffs.variantId))
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.writeOffs.businessId, businessId),
          gte(schema.writeOffs.createdAt, since),
          gte(schema.writeOffs.totalCostCents, thresholds.overrideCents),
          salesScopeCond(tenant, schema.writeOffs.locationId),
        ),
      );
    return rows.map((r) => ({
      subjectType: 'write_off' as const,
      subjectId: r.id,
      severity: 'warning' as const,
      kind: 'Write-off',
      summary: `${r.quantity} × ${r.productName} written off${r.reason ? ` — ${r.reason}` : ''}`,
      amountCents: -r.totalCostCents,
      actorUserId: r.actorUserId,
      actorName: name(r.actorUserId),
      locationId: r.locationId,
      locationName: store(r.locationId),
      href: '/inventory',
      occurredAt: r.createdAt,
      clearVia: 'review' as const,
    }));
  }

  private async stockMovements(
    tenant: RequestTenantContext,
    businessId: string,
    thresholds: OpsThresholds,
    since: Date,
    name: (id: string | null) => string | null,
    store: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const reasons = Object.keys(AUDITED_MOVEMENT_REASONS);
    const rows = await this.db
      .select({
        id: schema.inventoryMovements.id,
        delta: schema.inventoryMovements.delta,
        reason: schema.inventoryMovements.reason,
        notes: schema.inventoryMovements.notes,
        actorUserId: schema.inventoryMovements.actorUserId,
        createdAt: schema.inventoryMovements.createdAt,
        locationId: schema.inventoryMovements.locationId,
        productName: schema.products.name,
        sku: schema.productVariants.sku,
      })
      .from(schema.inventoryMovements)
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.inventoryMovements.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(
        and(
          eq(schema.inventoryMovements.businessId, businessId),
          gte(schema.inventoryMovements.createdAt, since),
          inArray(schema.inventoryMovements.reason, reasons),
          sql`ABS(${schema.inventoryMovements.delta}) >= ${thresholds.inventoryAdjustUnits}`,
          salesScopeCond(tenant, schema.inventoryMovements.locationId),
        ),
      );
    return rows.map((r) => {
      const meta = AUDITED_MOVEMENT_REASONS[r.reason] ?? {
        label: r.reason,
        severity: 'warning' as const,
      };
      return {
        subjectType: 'inventory_movement' as const,
        subjectId: r.id,
        severity: meta.severity,
        kind: meta.label,
        summary: `${r.delta > 0 ? '+' : ''}${r.delta} ${r.productName}${r.sku ? ` (${r.sku})` : ''}${r.notes ? ` — ${r.notes}` : ''}`,
        amountCents: null,
        actorUserId: r.actorUserId,
        actorName: name(r.actorUserId),
        locationId: r.locationId,
        locationName: store(r.locationId),
        href: '/inventory',
        occurredAt: r.createdAt,
        clearVia: 'review' as const,
      };
    });
  }

  private async giftCardAdjustments(
    businessId: string,
    since: Date,
    name: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.giftCardTransactions.id,
        kind: schema.giftCardTransactions.kind,
        amountCents: schema.giftCardTransactions.amountCents,
        actorUserId: schema.giftCardTransactions.actorUserId,
        createdAt: schema.giftCardTransactions.createdAt,
        giftCardId: schema.giftCardTransactions.giftCardId,
        code: schema.giftCards.code,
      })
      .from(schema.giftCardTransactions)
      .innerJoin(schema.giftCards, eq(schema.giftCards.id, schema.giftCardTransactions.giftCardId))
      .where(
        and(
          eq(schema.giftCardTransactions.businessId, businessId),
          gte(schema.giftCardTransactions.createdAt, since),
          // Issue and redeem are the register doing its job; a balance
          // moved by hand or a card cancelled is someone's decision.
          inArray(schema.giftCardTransactions.kind, ['adjust', 'cancel']),
        ),
      );
    return rows.map((r) => ({
      subjectType: 'gift_card_adjustment' as const,
      subjectId: r.id,
      severity: 'warning' as const,
      kind: r.kind === 'cancel' ? 'Gift card cancelled' : 'Gift card adjusted',
      summary: `Card ${r.code}`,
      amountCents: r.amountCents,
      actorUserId: r.actorUserId,
      actorName: name(r.actorUserId),
      locationId: null,
      locationName: null,
      href: `/gift-cards/${r.giftCardId}`,
      occurredAt: r.createdAt,
      clearVia: 'review' as const,
    }));
  }

  /**
   * Someone acted under another person's credentials. Always critical:
   * the permission model was bypassed, whatever the amount.
   */
  private async securityOverrides(
    businessId: string,
    since: Date,
    name: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.securityOverrides.id,
        permission: schema.securityOverrides.permission,
        action: schema.securityOverrides.action,
        reason: schema.securityOverrides.reason,
        actorUserId: schema.securityOverrides.actorUserId,
        authorizingUserId: schema.securityOverrides.authorizingUserId,
        createdAt: schema.securityOverrides.createdAt,
      })
      .from(schema.securityOverrides)
      .where(
        and(
          eq(schema.securityOverrides.businessId, businessId),
          gte(schema.securityOverrides.createdAt, since),
        ),
      );
    return rows.map((r) => ({
      subjectType: 'security_override' as const,
      subjectId: r.id,
      severity: 'critical' as const,
      kind: 'Security override',
      summary: `${r.action} — authorized by ${name(r.authorizingUserId) ?? 'unknown'}${r.reason ? ` (${r.reason})` : ''}`,
      amountCents: null,
      actorUserId: r.actorUserId,
      actorName: name(r.actorUserId),
      locationId: null,
      locationName: null,
      href: '/exceptions',
      occurredAt: r.createdAt,
      clearVia: 'review' as const,
    }));
  }

  /**
   * The exception register — price overrides past tier 2, order
   * unlocks, delivery-cap overrides, return cancels. These already have
   * an acknowledge column, so they clear through it rather than through
   * `ops_reviews`, and only unacknowledged rows reach the feed.
   */
  private async exceptions(
    businessId: string,
    since: Date,
    name: (id: string | null) => string | null,
  ): Promise<OpsFeedRow[]> {
    const rows = await this.db
      .select({
        id: schema.exceptionEvents.id,
        type: schema.exceptionEvents.type,
        severity: schema.exceptionEvents.severity,
        summary: schema.exceptionEvents.summary,
        actorUserId: schema.exceptionEvents.actorUserId,
        entityType: schema.exceptionEvents.entityType,
        entityId: schema.exceptionEvents.entityId,
        createdAt: schema.exceptionEvents.createdAt,
      })
      .from(schema.exceptionEvents)
      .where(
        and(
          eq(schema.exceptionEvents.businessId, businessId),
          gte(schema.exceptionEvents.createdAt, since),
          isNull(schema.exceptionEvents.acknowledgedAt),
        ),
      );
    return rows.map((r) => ({
      subjectType: 'exception' as const,
      subjectId: r.id,
      severity: (r.severity === 'critical'
        ? 'critical'
        : r.severity === 'info'
          ? 'info'
          : 'warning') as 'critical' | 'warning' | 'info',
      kind: humanizeExceptionType(r.type),
      summary: r.summary,
      amountCents: null,
      actorUserId: r.actorUserId,
      actorName: name(r.actorUserId),
      locationId: null,
      locationName: null,
      href: r.entityType === 'order' && r.entityId ? `/orders/${r.entityId}` : '/exceptions',
      occurredAt: r.createdAt,
      clearVia: 'exception' as const,
    }));
  }
}

/** `delivery_cap_override` → `Delivery cap override`. */
export function humanizeExceptionType(type: string): string {
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Re-exported so callers need only one import. */
export { subjectKey };
export type { OpsFeedRow, OpsThresholds };
