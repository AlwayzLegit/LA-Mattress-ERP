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
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

/**
 * The Changes card (owner hand-off 2026-09-10): every edit made to an
 * order after it was written, with what it was → what it is now, the
 * reason, the money it moved, who did it and who approved it — plus a
 * per-viewer "seen" tick on anything that touched money.
 *
 * Derived from `audit_logs` (owner decision 2026-09-10, option A): the
 * audit trail is already the record of what changed and by whom, so the
 * card reads it rather than keeping a second log. What a row can show is
 * therefore bounded by what the writing module recorded — where the
 * prior value or the amount was not captured, the row says so ("—",
 * "no money change") instead of guessing. The acknowledgement is the
 * only new state: one row per (audit row, member).
 */

export type ChangeTone = 'danger' | 'warn' | 'ok' | 'info';
export type ChangesFilter = 'all' | 'money' | 'unseen';

export interface ChangeRow {
  /** The audit row id — also the acknowledgement key. */
  id: string;
  occurredAt: Date;
  type: string;
  label: string;
  tone: ChangeTone;
  /** Money-related rows carry the per-viewer seen tick. */
  moneyRelated: boolean;
  was: string | null;
  now: string | null;
  reason: string | null;
  /** Signed cents; null when the change moved no money or the amount was not recorded. */
  impactCents: number | null;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  locationId: string;
  locationName: string;
  authorName: string;
  /** "approved by Maya Torres" · "approved by self" · "no approval needed" */
  approval: string;
  seenAt: Date | null;
}

export interface ChangesResponse {
  rows: ChangeRow[];
  counts: { all: number; money: number; unseen: number };
  viewer: { membershipId: string | null };
}

const ORDER_ACTIONS = [
  'order.update',
  'order.line.add',
  'order.line.remove',
  'order.line.update',
  'order.cancel',
  'order.payment.take',
  'order.price_adjustment',
  'order.return',
  'order.return_authorized',
  'order_return.cancel',
  'order.unlock',
  'delivery.cap_override',
] as const;

const DELIVERY_ACTIONS = ['delivery.schedule', 'delivery.update', 'delivery.cancel'] as const;

const APPROVAL_ACTION = 'security.override';

/** How close (ms) an override must sit to a change to count as its approval. */
const APPROVAL_WINDOW_MS = 120_000;

const METHOD_LABELS: Record<string, string> = {
  cash: 'cash',
  card: 'card',
  external_card: 'external card',
  check: 'check',
  financing: 'financing',
  gift_card: 'gift card',
  store_credit: 'store credit',
};

interface Described {
  type: string;
  label: string;
  tone: ChangeTone;
  moneyRelated: boolean;
  was: string | null;
  now: string | null;
  reason: string | null;
  impactCents: number | null;
}

interface Changes {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface DescribeCtx {
  memberName: (id: unknown) => string | null;
  variantLabel: (id: unknown) => string | null;
}

function usd(cents: unknown): string | null {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  const whole = Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
  return `${cents < 0 ? '−' : ''}$${whole}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function shortDate(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const [y, m, d] = s.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function addressLine(src: Record<string, unknown> | undefined): string | null {
  if (!src) return null;
  const parts = [src.addressLine1, src.addressLine2, src.addressCity, src.addressRegion]
    .map(str)
    .filter((s): s is string => !!s);
  return parts.length > 0 ? parts.join(', ') : null;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function parseLocationIds(raw?: string): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => isUuid(s));
  return ids.length > 0 ? ids : null;
}

/** Turn one audit row into the card's columns. Exported for unit tests. */
export function describeChange(action: string, changes: Changes, ctx: DescribeCtx): Described {
  const before = changes.before ?? {};
  const after = changes.after ?? {};
  const meta = changes.metadata ?? {};
  const has = (k: string) => k in after;
  const base: Described = {
    type: 'order_edited',
    label: 'Order edited',
    tone: 'info',
    moneyRelated: false,
    was: null,
    now: null,
    reason: null,
    impactCents: null,
  };

  switch (action) {
    case 'order.update': {
      if (has('orderDiscountCents')) {
        const b = num(before.orderDiscountCents);
        const a = num(after.orderDiscountCents) ?? 0;
        const reduced = b != null && a < b;
        return {
          ...base,
          type: reduced ? 'discount_reduced' : 'discount_added',
          label: reduced ? 'Discount reduced' : 'Discount added',
          tone: 'warn',
          moneyRelated: true,
          was: b != null ? `${usd(b)} order discount` : null,
          now: `${usd(a)} order discount`,
          impactCents: b != null ? -(a - b) : null,
        };
      }
      if (has('deliveryFeeCents')) {
        const b = num(before.deliveryFeeCents);
        const a = num(after.deliveryFeeCents) ?? 0;
        const waived = a === 0;
        return {
          ...base,
          type: waived ? 'delivery_fee_waived' : 'delivery_fee_changed',
          label: waived ? 'Delivery fee waived' : 'Delivery fee changed',
          tone: waived ? 'warn' : 'info',
          moneyRelated: true,
          was: b != null ? `${usd(b)} delivery fee` : null,
          now: waived ? 'waived' : `${usd(a)} delivery fee`,
          impactCents: b != null ? a - b : null,
        };
      }
      if (has('installFeeCents') || has('otherFeeCents')) {
        const key = has('installFeeCents') ? 'installFeeCents' : 'otherFeeCents';
        const b = num(before[key]);
        const a = num(after[key]) ?? 0;
        const waived = a === 0;
        const fee = key === 'installFeeCents' ? 'install fee' : 'fee';
        return {
          ...base,
          type: waived ? 'fee_waived' : 'fee_changed',
          label: waived ? `${fee[0]!.toUpperCase()}${fee.slice(1)} waived` : 'Fee changed',
          tone: waived ? 'warn' : 'info',
          moneyRelated: true,
          was: b != null ? `${usd(b)} ${fee}` : null,
          now: waived ? 'waived' : `${usd(a)} ${fee}`,
          impactCents: b != null ? a - b : null,
        };
      }
      if (has('salespersonMembershipId')) {
        return {
          ...base,
          type: 'salesperson_changed',
          label: 'Salesperson changed',
          tone: 'warn',
          moneyRelated: true,
          was: ctx.memberName(before.salespersonMembershipId),
          now: ctx.memberName(after.salespersonMembershipId) ?? 'unassigned',
          reason: 'commission follows the new salesperson',
        };
      }
      if (
        has('addressLine1') ||
        has('addressLine2') ||
        has('addressCity') ||
        has('addressRegion') ||
        has('addressPostalCode')
      ) {
        return {
          ...base,
          type: 'address_changed',
          label: 'Address changed',
          was: addressLine(before),
          now: addressLine(after) ?? 'address updated',
        };
      }
      if (has('requestedDate')) {
        return {
          ...base,
          type: 'requested_date_changed',
          label: 'Delivery date changed',
          was: shortDate(before.requestedDate),
          now: shortDate(after.requestedDate) ?? 'no date',
        };
      }
      if (has('status')) {
        return {
          ...base,
          type: 'order_confirmed',
          label: after.status === 'open' ? 'Order confirmed' : 'Status changed',
          was: str(before.status),
          now: str(after.status),
        };
      }
      if (has('stockLocationId') || has('pickupLocationId')) {
        return { ...base, type: 'location_changed', label: 'Stock location changed' };
      }
      return base;
    }
    case 'order.line.add': {
      const qty = num(after.quantity) ?? 1;
      const label = ctx.variantLabel(after.variantId) ?? 'line';
      return {
        ...base,
        type: 'line_added',
        label: 'Line added',
        moneyRelated: true,
        now: `${label} ×${qty} added`,
        // The event records what was added, not its price; reading the
        // live line would let later edits rewrite this row's history.
        impactCents: null,
      };
    }
    case 'order.line.remove': {
      const qty = num(before.quantity) ?? 1;
      const label = ctx.variantLabel(before.variantId) ?? 'line';
      return {
        ...base,
        type: 'line_removed',
        label: 'Line removed',
        tone: 'warn',
        moneyRelated: true,
        was: `${label} ×${qty}`,
        now: 'removed from the order',
      };
    }
    case 'order.line.update': {
      if (has('unitPriceCents')) {
        const b = num(before.unitPriceCents);
        const a = num(after.unitPriceCents);
        // Only the event's own quantity may scale the delta — never the
        // line's current quantity, which later edits move.
        const qty = num(after.quantity) ?? num(before.quantity);
        const perUnit = a != null && b != null ? a - b : null;
        return {
          ...base,
          type: 'price_override',
          label: 'Price override',
          tone: 'warn',
          moneyRelated: true,
          was: b != null ? `${usd(b)} unit price` : null,
          now: a != null ? `${usd(a)} approved price` : null,
          reason: perUnit != null && qty == null ? `${usd(perUnit)} per unit` : null,
          impactCents: perUnit != null && qty != null ? perUnit * qty : null,
        };
      }
      if (has('lineDiscountCents')) {
        const b = num(before.lineDiscountCents);
        const a = num(after.lineDiscountCents) ?? 0;
        return {
          ...base,
          type: 'discount_added',
          label: b != null && a < b ? 'Discount reduced' : 'Discount added',
          tone: 'warn',
          moneyRelated: true,
          was: b != null ? `${usd(b)} line discount` : null,
          now: `${usd(a)} line discount`,
          impactCents: b != null ? -(a - b) : null,
        };
      }
      if (has('quantity')) {
        return {
          ...base,
          type: 'quantity_changed',
          label: 'Quantity changed',
          moneyRelated: true,
          was: num(before.quantity) != null ? `×${num(before.quantity)}` : null,
          now: num(after.quantity) != null ? `×${num(after.quantity)}` : null,
        };
      }
      if (has('deliveryDate')) {
        return {
          ...base,
          type: 'line_delivery_date_changed',
          label: 'Delivery date changed',
          was: shortDate(before.deliveryDate),
          now: shortDate(after.deliveryDate) ?? 'no date',
        };
      }
      if (has('fulfillmentMethod')) {
        return {
          ...base,
          type: 'fulfillment_changed',
          label: 'Fulfillment changed',
          was: str(before.fulfillmentMethod)?.replace(/_/g, ' ') ?? null,
          now: str(after.fulfillmentMethod)?.replace(/_/g, ' ') ?? null,
        };
      }
      return { ...base, type: 'line_edited', label: 'Line edited' };
    }
    case 'order.cancel':
      return {
        ...base,
        type: 'order_cancelled',
        label: 'Order cancelled',
        tone: 'danger',
        moneyRelated: true,
        was: str(before.status),
        now: 'cancelled',
        reason: str(after.reason),
      };
    case 'order.payment.take': {
      const kind = str(after.kind) ?? 'deposit';
      const amount = num(after.amountCents);
      const method = METHOD_LABELS[str(after.method) ?? ''] ?? str(after.method) ?? '';
      const labels: Record<string, string> = {
        deposit: 'Deposit collected',
        balance: 'Balance collected',
        installment: 'Installment collected',
        sale: 'Payment taken',
      };
      const kindWord: Record<string, string> = {
        deposit: 'deposit',
        balance: 'balance',
        installment: 'installment',
        sale: 'payment',
      };
      return {
        ...base,
        type: `${kind}_collected`,
        label: labels[kind] ?? 'Payment taken',
        tone: 'ok',
        moneyRelated: true,
        now: `${usd(amount) ?? 'payment'} ${method} ${kindWord[kind] ?? kind}`.trim(),
        reason: str(after.spilloverFrom) ? `spillover from ${str(after.spilloverFrom)}` : null,
        impactCents: amount,
      };
    }
    case 'order.price_adjustment': {
      const amount = num(after.amountCents);
      const toCredit = after.refundMethod === 'store_credit';
      return {
        ...base,
        type: 'refund_issued',
        label: 'Refund issued',
        tone: 'danger',
        moneyRelated: true,
        now: `${usd(amount) ?? 'refund'} ${toCredit ? 'to store credit' : 'to original tender'}`,
        reason: str(after.reason),
        impactCents: amount != null ? -amount : null,
      };
    }
    case 'order.return': {
      const amount = num(after.amountCents);
      const method = str(after.refundMethod);
      return {
        ...base,
        type: 'refund_issued',
        label: 'Refund issued',
        tone: 'danger',
        moneyRelated: true,
        was: str(after.rmaNumber) ? `RMA ${str(after.rmaNumber)}` : null,
        now: `${usd(amount) ?? 'refund'} refunded${method ? ` · ${method.replace(/_/g, ' ')}` : ''}`,
        reason: str(after.reason),
        impactCents: amount != null ? -amount : null,
      };
    }
    case 'order.return_authorized':
      return {
        ...base,
        type: 'return_authorized',
        label: 'Return authorized',
        tone: 'warn',
        was: str(after.rmaNumber) ? `RMA ${str(after.rmaNumber)}` : null,
        now: `${usd(num(after.amountCents)) ?? 'refund'} pending goods`,
        reason: str(after.reason),
      };
    case 'order_return.cancel':
      return {
        ...base,
        type: 'return_cancelled',
        label: 'Return authorization cancelled',
        reason: str(after.reason) ?? str(meta.reason),
      };
    case 'order.unlock':
      return {
        ...base,
        type: 'order_unlocked',
        label: 'Order unlocked',
        tone: 'warn',
        reason: str(meta.reason) ?? str(after.reason),
      };
    case 'delivery.cap_override':
      return {
        ...base,
        type: 'capacity_override',
        label: 'Delivery booked over capacity',
        tone: 'warn',
        reason: str(meta.reason) ?? str(after.reason),
      };
    case 'delivery.schedule':
      return {
        ...base,
        type: 'delivery_scheduled',
        label: 'Delivery scheduled',
        now: shortDate(after.scheduledDate),
      };
    case 'delivery.update':
      if (has('scheduledDate')) {
        return {
          ...base,
          type: 'delivery_rescheduled',
          label: 'Delivery rescheduled',
          was: shortDate(before.scheduledDate),
          now: shortDate(after.scheduledDate),
          reason: str(after.reason) ?? str(after.note),
        };
      }
      return { ...base, type: 'delivery_edited', label: 'Delivery edited' };
    case 'delivery.cancel':
      return { ...base, type: 'delivery_cancelled', label: 'Delivery cancelled', tone: 'warn' };
    default:
      return base;
  }
}

@TenantScoped()
@Controller('v1/dashboard/changes')
export class OrderChangesController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get()
  @RequirePermission('audit.view')
  async list(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('filter') filterQ?: string,
    @Query('locationIds') locationIdsQ?: string,
    @Query('limit') limitQ?: string,
  ): Promise<ChangesResponse> {
    const businessId = tenant.businessId!;
    const filter: ChangesFilter = filterQ === 'money' || filterQ === 'unseen' ? filterQ : 'all';
    const limit = Math.min(200, Math.max(1, Number(limitQ) || 60));
    const locationIds = parseLocationIds(locationIdsQ);

    // The raw pool: recent audit rows for the actions the card understands,
    // wider than the page so location scoping still fills it.
    const raw = await this.db
      .select({
        id: schema.auditLogs.id,
        action: schema.auditLogs.action,
        targetType: schema.auditLogs.targetType,
        targetId: schema.auditLogs.targetId,
        actorUserId: schema.auditLogs.actorUserId,
        actorName: schema.users.name,
        actorEmail: schema.users.email,
        changesJson: schema.auditLogs.changesJson,
        createdAt: schema.auditLogs.createdAt,
      })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(
        and(
          eq(schema.auditLogs.businessId, businessId),
          inArray(schema.auditLogs.action, [
            ...ORDER_ACTIONS,
            ...DELIVERY_ACTIONS,
            APPROVAL_ACTION,
          ]),
        ),
      )
      .orderBy(desc(schema.auditLogs.createdAt), desc(schema.auditLogs.id))
      .limit(Math.max(400, limit * 4));

    // Delivery rows point at a delivery; resolve to its order.
    const deliveryIds = [
      ...new Set(
        raw
          .filter((r) => r.targetType === 'delivery' && r.targetId && isUuid(r.targetId))
          .map((r) => r.targetId!),
      ),
    ];
    const deliveryOrder = new Map<string, string>();
    if (deliveryIds.length > 0) {
      const rows = await this.db
        .select({ id: schema.deliveries.id, orderId: schema.deliveries.orderId })
        .from(schema.deliveries)
        .where(inArray(schema.deliveries.id, deliveryIds));
      for (const d of rows) deliveryOrder.set(d.id, d.orderId);
    }
    const orderIdOf = (r: (typeof raw)[number]): string | null => {
      if (!r.targetId || !isUuid(r.targetId)) return null;
      if (r.targetType === 'order') return r.targetId;
      if (r.targetType === 'delivery') return deliveryOrder.get(r.targetId) ?? null;
      return null;
    };

    const orderIds = [...new Set(raw.map(orderIdOf).filter((v): v is string => !!v))];
    if (orderIds.length === 0) {
      return {
        rows: [],
        counts: { all: 0, money: 0, unseen: 0 },
        viewer: { membershipId: tenant.membershipId },
      };
    }
    const orders = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        locationId: schema.orders.locationId,
        locationName: schema.locations.name,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
      })
      .from(schema.orders)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.orders.locationId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          inArray(schema.orders.id, orderIds),
          // Legacy-imported orders never reach the card (D8).
          isNull(schema.orders.importedAt),
          locationIds ? inArray(schema.orders.locationId, locationIds) : undefined,
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    const orderById = new Map(orders.map((o) => [o.id, o] as const));

    // Lookups the descriptions need: member names and variant labels.
    const memberIds = new Set<string>();
    const variantIds = new Set<string>();
    for (const r of raw) {
      const c = (r.changesJson ?? {}) as Changes;
      for (const side of [c.before, c.after]) {
        if (!side) continue;
        const sp = side.salespersonMembershipId;
        if (typeof sp === 'string' && isUuid(sp)) memberIds.add(sp);
        const v = side.variantId;
        if (typeof v === 'string' && isUuid(v)) variantIds.add(v);
      }
    }
    const memberNames = new Map<string, string>();
    if (memberIds.size > 0) {
      const rows = await this.db
        .select({
          id: schema.memberships.id,
          name: schema.users.name,
          email: schema.users.email,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(inArray(schema.memberships.id, [...memberIds]));
      for (const m of rows) memberNames.set(m.id, m.name ?? m.email);
    }
    const variantLabels = new Map<string, string>();
    if (variantIds.size > 0) {
      const rows = await this.db
        .select({
          id: schema.productVariants.id,
          variantName: schema.productVariants.name,
          productName: schema.products.name,
        })
        .from(schema.productVariants)
        .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .where(inArray(schema.productVariants.id, [...variantIds]));
      for (const v of rows) {
        variantLabels.set(
          v.id,
          v.variantName ? `${v.productName} — ${v.variantName}` : v.productName,
        );
      }
    }
    const ctx: DescribeCtx = {
      memberName: (id) => (typeof id === 'string' ? (memberNames.get(id) ?? null) : null),
      variantLabel: (id) => (typeof id === 'string' ? (variantLabels.get(id) ?? null) : null),
    };

    // Approvals: a second-user override on the same order within the
    // window is the approval of the change beside it.
    const approvals = new Map<
      string,
      { at: number; actorUserId: string | null; authorizingUserId: string | null }[]
    >();
    const authorizerIds = new Set<string>();
    for (const r of raw) {
      if (r.action !== APPROVAL_ACTION) continue;
      const orderId = orderIdOf(r);
      if (!orderId) continue;
      const meta = ((r.changesJson ?? {}) as Changes).metadata ?? {};
      const authorizingUserId = str(meta.authorizingUserId);
      if (authorizingUserId) authorizerIds.add(authorizingUserId);
      const list = approvals.get(orderId) ?? [];
      list.push({ at: r.createdAt.getTime(), actorUserId: r.actorUserId, authorizingUserId });
      approvals.set(orderId, list);
    }
    const userNames = new Map<string, string>();
    if (authorizerIds.size > 0) {
      const rows = await this.db
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, [...authorizerIds]));
      for (const u of rows) userNames.set(u.id, u.name ?? u.email);
    }
    const approvalFor = (orderId: string, at: Date, actorUserId: string | null): string => {
      const list = approvals.get(orderId);
      if (!list) return 'no approval needed';
      const t = at.getTime();
      const hit = list.find((a) => Math.abs(a.at - t) <= APPROVAL_WINDOW_MS);
      if (!hit) return 'no approval needed';
      if (hit.authorizingUserId && actorUserId && hit.authorizingUserId === actorUserId) {
        return 'approved by self';
      }
      const name = hit.authorizingUserId ? userNames.get(hit.authorizingUserId) : null;
      return name ? `approved by ${name}` : 'approved by override';
    };

    const built: Omit<ChangeRow, 'seenAt'>[] = [];
    for (const r of raw) {
      if (r.action === APPROVAL_ACTION) continue;
      const orderId = orderIdOf(r);
      const order = orderId ? orderById.get(orderId) : undefined;
      if (!order) continue;
      const d = describeChange(r.action, (r.changesJson ?? {}) as Changes, ctx);
      built.push({
        id: r.id,
        occurredAt: r.createdAt,
        ...d,
        orderId: order.id,
        orderNumber: order.number,
        customerName:
          [order.customerFirst, order.customerLast]
            .filter((s) => !!s)
            .join(' ')
            .trim() || null,
        locationId: order.locationId,
        locationName: order.locationName,
        authorName: r.actorName ?? r.actorEmail ?? 'system',
        approval: approvalFor(order.id, r.createdAt, r.actorUserId),
      });
    }

    const acks = new Map<string, Date>();
    if (tenant.membershipId && built.length > 0) {
      const rows = await this.db
        .select({
          auditLogId: schema.orderChangeAcks.auditLogId,
          at: schema.orderChangeAcks.acknowledgedAt,
        })
        .from(schema.orderChangeAcks)
        .where(
          and(
            eq(schema.orderChangeAcks.businessId, businessId),
            eq(schema.orderChangeAcks.membershipId, tenant.membershipId),
            inArray(
              schema.orderChangeAcks.auditLogId,
              built.map((b) => b.id),
            ),
          ),
        );
      for (const a of rows) acks.set(a.auditLogId, a.at);
    }
    const all: ChangeRow[] = built.map((b) => ({ ...b, seenAt: acks.get(b.id) ?? null }));
    const money = all.filter((r) => r.moneyRelated);
    const unseen = money.filter((r) => !r.seenAt);
    const page = (filter === 'money' ? money : filter === 'unseen' ? unseen : all).slice(0, limit);
    return {
      rows: page,
      counts: { all: all.length, money: money.length, unseen: unseen.length },
      viewer: { membershipId: tenant.membershipId },
    };
  }

  private async auditRowOrThrow(businessId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw new BadRequestException('id must be a uuid');
    const [row] = await this.db
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.id, id), eq(schema.auditLogs.businessId, businessId)))
      .limit(1);
    if (!row) throw new NotFoundException('Change not found');
  }

  private requireMember(tenant: RequestTenantContext): string {
    if (!tenant.membershipId) {
      throw new BadRequestException('Seen ticks belong to a signed-in member');
    }
    return tenant.membershipId;
  }

  /** Tick: I have seen this money change. Per member — nobody else's tick moves. */
  @Put(':id/seen')
  @RequirePermission('audit.view')
  async seen(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ id: string; seenAt: Date }> {
    const businessId = tenant.businessId!;
    const membershipId = this.requireMember(tenant);
    await this.auditRowOrThrow(businessId, id);
    await this.db
      .insert(schema.orderChangeAcks)
      .values({ businessId, auditLogId: id, membershipId })
      .onConflictDoNothing();
    const [row] = await this.db
      .select({ at: schema.orderChangeAcks.acknowledgedAt })
      .from(schema.orderChangeAcks)
      .where(
        and(
          eq(schema.orderChangeAcks.auditLogId, id),
          eq(schema.orderChangeAcks.membershipId, membershipId),
        ),
      )
      .limit(1);
    return { id, seenAt: row!.at };
  }

  /** Untick. */
  @Delete(':id/seen')
  @RequirePermission('audit.view')
  async unseen(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ id: string; seenAt: null }> {
    const membershipId = this.requireMember(tenant);
    if (!isUuid(id)) throw new BadRequestException('id must be a uuid');
    await this.db
      .delete(schema.orderChangeAcks)
      .where(
        and(
          eq(schema.orderChangeAcks.businessId, tenant.businessId!),
          eq(schema.orderChangeAcks.auditLogId, id),
          eq(schema.orderChangeAcks.membershipId, membershipId),
        ),
      );
    return { id, seenAt: null };
  }

  /** "Mark all seen" for the rows the viewer is looking at. */
  @Post('seen-all')
  @RequirePermission('audit.view')
  async seenAll(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { ids?: unknown },
  ): Promise<{ updated: number }> {
    const businessId = tenant.businessId!;
    const membershipId = this.requireMember(tenant);
    const ids = Array.isArray(body?.ids)
      ? [...new Set(body.ids.filter((x): x is string => typeof x === 'string' && isUuid(x)))]
      : [];
    if (ids.length === 0 || ids.length > 500) {
      throw new BadRequestException('ids must list 1–500 change ids');
    }
    const known = await this.db
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.businessId, businessId), inArray(schema.auditLogs.id, ids)));
    if (known.length === 0) return { updated: 0 };
    await this.db
      .insert(schema.orderChangeAcks)
      .values(known.map((k) => ({ businessId, auditLogId: k.id, membershipId })))
      .onConflictDoNothing();
    return { updated: known.length };
  }
}
