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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { assertSellingScope, salesScopeCond } from '../common/sales-scope';
import { TicketFlagsService } from '../deliveries/ticket-flags.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  encodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
} from '../common/pagination';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { CommissionsService } from '../money/commissions.service';
import { StoreCreditService } from '../returns/store-credit.service';
import { OrderReturnsService } from '../returns/order-returns.service';
import {
  SecurityOverrideService,
  type OverrideCredentials,
} from '../controls/security-override.service';
import { PriceVarianceService } from '../controls/price-variance.service';
import { AutoTransfersService } from '../transfers/auto-transfers.service';
import { ExceptionsService } from '../controls/exceptions.service';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';
import {
  balanceDueCents,
  defaultDepositCents,
  deriveFulfillmentStatus,
  isLiveOrderStatus,
  paidCents,
  planFulfillment,
  remainingFulfillment,
  type FulfillmentRequest,
  type OrderStatus,
} from './order-math';
import { OrdersService } from './orders.service';
import { parseDayRange, utcBounds } from '../common/date-range';

/**
 * Fallback deposit policy: a quarter down, per the plan's example. Made a
 * per-business setting when the settings surface lands; until then every
 * order can still override it at write time.
 */
const DEFAULT_DEPOSIT_RATE_BPS = 2500;

const PAYMENT_METHODS = [
  'cash',
  'card',
  'store_credit',
  'gift_card',
  'financing',
  'external_card',
  'check',
  'paypal',
  'venmo',
  'zelle',
  'synchrony',
  'acima',
] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const FULFILLMENT_TYPES = ['delivery', 'pickup', 'take_with', 'direct_ship'] as const;
const DELIVERY_STATUSES = ['scheduled', 'estimated', 'asap', 'will_call'] as const;
const ORDER_KINDS = ['sales_order', 'layaway', 'exchange'] as const;
const LINE_TYPES = ['stock', 'special_order', 'custom', 'direct_ship'] as const;

interface OrderLineInput {
  variantId?: string;
  /** Free-text override; defaults to the variant's product/variant name. */
  description?: string;
  quantity?: number;
  /** Optional override; defaults to the variant's price. */
  unitPriceCents?: number;
  lineDiscountCents?: number;
  lineType?: (typeof LINE_TYPES)[number];
  /** Split-ticket override of the order's fulfillment method. */
  fulfillmentMethod?: (typeof FULFILLMENT_TYPES)[number] | null;
  /** Per-line fulfill-from location; null/omitted = the order's default. */
  sourceLocationId?: string | null;
  /** Per-line promised date (YYYY-MM-DD) when items arrive separately. */
  deliveryDate?: string | null;
}

interface AddressInput {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  phone?: string | null;
}

/** A20 "Trade/Designer Information". */
interface TradeDesignerInput {
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
}

/** A20 "Custom Order Information": one printed label/value row. */
interface CustomInfoRow {
  label: string;
  value: string;
}

const A20_TEXT_MAX = 200;

function a20Text(field: string, v: unknown, max = A20_TEXT_MAX): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new BadRequestException(`${field} must be ≤ ${max} characters`);
  return t || null;
}

function a20TradeDesigner(v: unknown): TradeDesignerInput | null {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new BadRequestException('tradeDesigner must be an object or null');
  }
  const o = v as Record<string, unknown>;
  const out: TradeDesignerInput = {
    name: a20Text('tradeDesigner.name', o.name),
    company: a20Text('tradeDesigner.company', o.company),
    phone: a20Text('tradeDesigner.phone', o.phone, 40),
    email: a20Text('tradeDesigner.email', o.email),
    note: a20Text('tradeDesigner.note', o.note, 1000),
  };
  return Object.values(out).some((x) => x) ? out : null;
}

function a20CustomInfo(v: unknown): CustomInfoRow[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new BadRequestException('customInfo must be a list or null');
  if (v.length > 40) throw new BadRequestException('customInfo holds at most 40 rows');
  const rows: CustomInfoRow[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object')
      throw new BadRequestException('customInfo rows are objects');
    const r = raw as Record<string, unknown>;
    const label = a20Text('customInfo.label', r.label, 80);
    const value = a20Text('customInfo.value', r.value, 500);
    if (!label && !value) continue;
    rows.push({ label: label ?? '', value: value ?? '' });
  }
  return rows.length > 0 ? rows : null;
}

/** A20 "Prep Codes": a short list of short labels. */
function a20Codes(field: string, v: unknown): string[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new BadRequestException(`${field} must be a list or null`);
  const out: string[] = [];
  for (const raw of v) {
    const t = a20Text(field, raw, 60);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  if (out.length > 20) throw new BadRequestException(`${field} holds at most 20 entries`);
  return out.length > 0 ? out : null;
}

interface StepThreeFees {
  deliveryFeeCents?: number;
  installFeeCents?: number;
  otherFeeCents?: number;
  otherFeeLabel?: string | null;
}

interface CreateOrderBody extends StepThreeFees {
  /**
   * Split-at-sale (owner ask 2026-08-30): after the order is written,
   * every group of lines whose per-line deliveryDate differs from the
   * order's requestedDate moves to its own suffixed order (-A, -B …).
   */
  splitByDeliveryDate?: boolean;
  locationId?: string;
  customerId?: string;
  lines?: OrderLineInput[];
  orderDiscountCents?: number;
  orderKind?: (typeof ORDER_KINDS)[number];
  fulfillmentType?: (typeof FULFILLMENT_TYPES)[number];
  deliveryStatus?: (typeof DELIVERY_STATUSES)[number] | null;
  deliveryInstructions?: string | null;
  pickupLocationId?: string | null;
  /** Fulfill-from location; null/omitted = the selling location. */
  stockLocationId?: string | null;
  billingAddress?: AddressInput | null;
  marketingCode?: string | null;
  requestedDate?: string | null;
  address?: AddressInput;
  notes?: string | null;
  internalNotes?: string | null;
  salespersonMembershipId?: string | null;
  secondSalespersonMembershipId?: string | null;
  splitBps?: number | null;
  depositRequiredCents?: number;
  /**
   * Write the order straight to `open` (reserving stock) instead of
   * parking it as a quote. The order writer sets this once the customer
   * commits.
   */
  confirm?: boolean;
  /**
   * Park as a store-wide draft instead (PLAN-POS-OPERATIONS §4): no
   * reservation, resumable by any associate, listed under status=draft.
   */
  draft?: boolean;
  /** G6 price-variance controls: coded reason + optional manager override. */
  priceReasonCodeId?: string;
  priceReason?: string;
  override?: OverrideCredentials;
}

interface UpdateOrderBody extends StepThreeFees {
  fulfillmentType?: (typeof FULFILLMENT_TYPES)[number];
  orderKind?: (typeof ORDER_KINDS)[number];
  deliveryStatus?: (typeof DELIVERY_STATUSES)[number] | null;
  deliveryInstructions?: string | null;
  pickupLocationId?: string | null;
  /** Fulfill-from location; null/omitted = the selling location. */
  stockLocationId?: string | null;
  billingAddress?: AddressInput | null;
  marketingCode?: string | null;
  /** A20 header fields — metadata, never money. */
  marketingCode2?: string | null;
  orderSource?: string | null;
  paymentTerminal?: string | null;
  exceptionNotes?: string | null;
  tradeDesigner?: TradeDesignerInput | null;
  customInfo?: CustomInfoRow[] | null;
  requestedDate?: string | null;
  address?: AddressInput;
  notes?: string | null;
  internalNotes?: string | null;
  salespersonMembershipId?: string | null;
  secondSalespersonMembershipId?: string | null;
  splitBps?: number | null;
  depositRequiredCents?: number;
  orderDiscountCents?: number;
  /** 'quote' → 'open' only; every other transition has its own endpoint. */
  status?: 'open';
  /** G6 price-variance controls: coded reason + optional manager override. */
  priceReasonCodeId?: string;
  priceReason?: string;
  override?: OverrideCredentials;
}

interface OrderPaymentBody {
  method?: PaymentMethod;
  amountCents?: number;
  /** 'deposit' | 'balance' | 'installment'. Inferred when omitted. */
  kind?: 'deposit' | 'balance' | 'installment';
  processorRef?: string;
  financingProvider?: string;
  financingRef?: string;
}

/** Body of PATCH /orders/:id/lines/:lineId (money fields + A20 line details). */
interface LineEditBody {
  quantity?: number;
  unitPriceCents?: number;
  lineDiscountCents?: number;
  fulfillmentMethod?: string | null;
  sourceLocationId?: string | null;
  deliveryDate?: string | null;
  priceReasonCodeId?: string;
  priceReason?: string;
  /** A20 line details. */
  description?: string;
  comment?: string | null;
  room?: string | null;
  pieces?: number | null;
  prepCodes?: string[] | null;
  com?: { description?: string | null } | null;
  directShip?: {
    vendorName?: string | null;
    vendorOrderRef?: string | null;
    trackingNumber?: string | null;
    expectedDate?: string | null;
  } | null;
  needsInstall?: boolean;
}

/** Line fields that pass the A1 print lock (metadata, never money or stock). */
const LINE_METADATA_FIELDS = new Set([
  'description',
  'comment',
  'room',
  'pieces',
  'prepCodes',
  'com',
  'directShip',
  'needsInstall',
]);

interface CancelOrderBody {
  reason?: string | null;
}

interface OrderListRow {
  id: string;
  number: string;
  status: string;
  customerId: string;
  locationId: string;
  stockLocationId?: string | null;
  totalCents: number;
  depositRequiredCents: number;
  fulfillmentType: string;
  requestedDate: string | null;
  importedAt: Date | null;
  createdAt: Date;
}

interface OrderLineRow {
  id: string;
  variantId: string | null;
  description: string;
  quantity: number;
  qtyReserved: number;
  qtyFulfilled: number;
  qtyReturned: number;
  lineType: string;
  unitPriceCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  taxRateBps: number;
  fulfillmentMethod: string | null;
  sourceLocationId: string | null;
  deliveryDate: string | null;
  /** A20 line details (STORIS Step 2 actions). */
  comment: string | null;
  room: string | null;
  pieces: number | null;
  prepCodes: string[] | null;
  comJson: unknown;
  directShipJson: unknown;
  needsInstall: boolean;
}

interface OrderPaymentRow {
  id: string;
  kind: string;
  method: string;
  amountCents: number;
  status: string;
  processor: string | null;
  processorRef: string | null;
  financingProvider: string | null;
  financingRef: string | null;
  createdAt: Date;
}

interface OrderDetail extends OrderListRow {
  subtotalCents: number;
  orderDiscountCents: number;
  discountCents: number;
  taxCents: number;
  /** Derived (D-money rule): sum of succeeded payments. */
  paidCents: number;
  /** Derived: total - paid, floored at zero. */
  balanceDueCents: number;
  /** Derived (§10 exchanges): paid - total, floored at zero. */
  creditDueCents: number;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressPhone: string | null;
  notes: string | null;
  internalNotes: string | null;
  /** §10: the original order this exchange was written against. */
  originalOrderId: string | null;
  salespersonMembershipId: string | null;
  secondSalespersonMembershipId: string | null;
  splitBps: number | null;
  orderKind: string;
  deliveryStatus: string | null;
  deliveryInstructions: string | null;
  pickupLocationId: string | null;
  billingAddressJson: unknown;
  marketingCode: string | null;
  /** A20 (STORIS Step 1 + Actions): attribution, source, terminal, comments. */
  marketingCode2: string | null;
  orderSource: string | null;
  paymentTerminal: string | null;
  exceptionNotes: string | null;
  tradeDesignerJson: unknown;
  customInfoJson: unknown;
  deliveryFeeCents: number;
  installFeeCents: number;
  otherFeeCents: number;
  otherFeeLabel: string | null;
  legacyNumber: string | null;
  /** A1 print lock: set when an individual delivery ticket was printed. */
  lockedAt: Date | null;
  /** Set while a stop for this order sits on an open/departed run. */
  onOpenRun: { runId: string; runDate: string } | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  lines: OrderLineRow[];
  payments: OrderPaymentRow[];
  /** Other live orders in this order's split family (base number + letter suffixes). */
  family: {
    id: string;
    number: string;
    status: string;
    totalCents: number;
    balanceDueCents: number;
    /** Owner 2026-09-02: the split card shows what each piece carries. */
    fulfillmentType: string;
    requestedDate: string | null;
    lines: {
      id: string;
      description: string;
      quantity: number;
      fulfillmentMethod: string | null;
    }[];
  }[];
}

/**
 * The purchase order a line is riding on (owner 2026-09-02): "PO-123 ·
 * on order" until receiving accepts the units, then "accepted, reserved".
 * From po_line_allocations — ordered vs received quantities per line.
 */
export interface OrderLinePo {
  poId: string;
  poNumber: string;
  poStatus: string;
  ordered: number;
  received: number;
  expectedAt: Date | null;
}

/**
 * P-013 (BA-0017): the ONE owner-facing status vocabulary (§8 display
 * ladder). List rows, the order detail page, and the status filter all
 * derive from this ladder — never from the raw lifecycle status.
 */
export const DISPLAY_STATUSES = [
  'Draft',
  'Quote',
  'Cancelled',
  'Awaiting Return Pickup',
  'Returned',
  'Exchanged',
  'Delivered',
  'Layaway',
  'Out for Delivery',
  'Scheduled',
  'On PO',
  'Reserved',
  'Pending',
] as const;

export function deriveDisplayStatus(x: {
  status: string;
  orderKind: string;
  balance: number;
  tripStatus: string | null;
  onPo: boolean;
  reservedShort: boolean;
  awaitingPickup: boolean;
  fullyReturned: boolean;
  exchanged: boolean;
}): string {
  if (x.status === 'draft') return 'Draft';
  if (x.status === 'quote') return 'Quote';
  if (x.status === 'cancelled') return 'Cancelled';
  if (x.awaitingPickup) return 'Awaiting Return Pickup';
  if (x.fullyReturned) return 'Returned';
  if (x.exchanged) return 'Exchanged';
  if (x.status === 'completed' || x.status === 'fulfilled') return 'Delivered';
  if (x.orderKind === 'layaway' && x.balance > 0) return 'Layaway';
  if (x.tripStatus === 'out_for_delivery') return 'Out for Delivery';
  if (x.tripStatus) return 'Scheduled';
  if (x.onPo) return 'On PO';
  if (!x.reservedShort) return 'Reserved';
  return 'Pending';
}

/** The one-call payload the printable documents render from (§11). */
interface OrderDocument {
  business: {
    name: string;
    logoUrl: string | null;
    /** Settings → Branding accent (#rrggbb); the invoice's brand color. */
    accentColor: string | null;
    invoiceHeaderNote: string | null;
    invoiceFooterNote: string | null;
  };
  location: {
    name: string;
    orderPrefix: string | null;
    addressJson: unknown;
  } | null;
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    /** A22 slice 6 (STORIS customer panel): number, trade names, alternate contact, standing instructions. */
    customerNumber: string | null;
    businessName: string | null;
    contactName: string | null;
    alternateName: string | null;
    alternateRelationship: string | null;
    deliveryInstructions: string | null;
    /** Billing address for the SOLD TO block (BA-0014/BA-0030 audit fix). */
    address: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
    } | null;
  } | null;
  salespersonName: string | null;
  secondSalespersonName: string | null;
  /** §10: set on exchange orders — the Original Invoice #. */
  originalOrderNumber: string | null;
  /** Earliest undelivered trip date, falling back to the requested date. */
  scheduledDate: string | null;
  order: OrderDetail;
  lines: (OrderLineRow & { model: string | null; brand: string | null })[];
  /**
   * Owner 2026-08-31: a split family prints ONE combined invoice —
   * every piece's lines under the base number, take-with lines marked,
   * with the family's combined money. Null when the order stands alone.
   */
  familyInvoice: {
    numbers: string[];
    lines: (OrderLineRow & {
      model: string | null;
      brand: string | null;
      pieceNumber: string;
      takenWith: boolean;
    })[];
    subtotalCents: number;
    discountCents: number;
    deliveryFeeCents: number;
    installFeeCents: number;
    otherFeeCents: number;
    taxCents: number;
    totalCents: number;
    paidCents: number;
    balanceDueCents: number;
  } | null;
}

/** Step-3 fee fields must be non-negative integer cents. */
function assertFees(body: StepThreeFees): void {
  for (const [k, v] of [
    ['deliveryFeeCents', body.deliveryFeeCents],
    ['installFeeCents', body.installFeeCents],
    ['otherFeeCents', body.otherFeeCents],
  ] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
      throw new BadRequestException(`${k} must be a non-negative integer`);
    }
  }
}

/** Validated per-line fulfillment override, or NULL to inherit the order's. */
function lineFulfillment(line: OrderLineInput | undefined): string | null {
  const m = line?.fulfillmentMethod;
  if (m == null) return null;
  if (!FULFILLMENT_TYPES.includes(m)) {
    throw new BadRequestException(
      `line fulfillmentMethod must be one of ${FULFILLMENT_TYPES.join(', ')}`,
    );
  }
  return m;
}

/**
 * Sales orders (cutover gap G1). An order is written now and delivered
 * later, so unlike a POS sale it carries a customer, a deposit, committed
 * stock, and a balance the store collects at fulfillment.
 *
 * Fulfillment itself — deliveries, stock decrement, order completion —
 * lands with the `deliveries` module on Day 3. What this module owns is
 * the order spine: write it, price it, commit stock to it, take money
 * against it, cancel it.
 */
@TenantScoped()
@Controller('v1')
export class OrdersController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
    @Inject(CommissionsService) private readonly commissions: CommissionsService,
    @Inject(StoreCreditService) private readonly storeCredit: StoreCreditService,
    @Inject(SecurityOverrideService) private readonly overrides: SecurityOverrideService,
    @Inject(OrderReturnsService) private readonly orderReturns: OrderReturnsService,
    @Inject(ExceptionsService) private readonly exceptions: ExceptionsService,
    @Inject(PriceVarianceService) private readonly priceVariance: PriceVarianceService,
    @Inject(AutoTransfersService) private readonly autoTransfers: AutoTransfersService,
    @Inject(TicketFlagsService) private readonly ticketFlags: TicketFlagsService,
  ) {}

  @Get('orders')
  @RequirePermission('orders.view')
  async list(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('number') number?: string,
    @Query('salespersonMembershipId') salespersonMembershipId?: string,
    @Query('mine') mine?: string,
    @Query('locationId') locationIdFilter?: string,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
  ): Promise<PageResponse<OrderListRow>> {
    const limit = clampLimit(limitStr);
    const cursor = decodeCursor(cursorStr);
    const filters = [];
    const scope = salesScopeCond(tenant, schema.orders.locationId);
    if (scope) filters.push(scope);
    const window = parseDayRange(startQ, endQ);
    if (window) {
      const b = utcBounds(window);
      filters.push(
        gte(schema.orders.createdAt, b.from),
        lt(schema.orders.createdAt, b.toExclusive),
      );
    }
    if (status) filters.push(eq(schema.orders.status, status));
    if (customerId) filters.push(eq(schema.orders.customerId, customerId));
    // Exact document-number recall (the exchange writer's original-order
    // field types the number off the paper invoice).
    if (number) filters.push(eq(schema.orders.number, number.trim()));
    if (salespersonMembershipId)
      filters.push(eq(schema.orders.salespersonMembershipId, salespersonMembershipId));
    if (locationIdFilter) filters.push(eq(schema.orders.locationId, locationIdFilter));
    // "My orders": carrying me as either salesperson — the dashboard card
    // every associate works their book from.
    if (mine === '1' || mine === 'true') {
      const me = tenant.membershipId;
      if (me) {
        filters.push(
          or(
            eq(schema.orders.salespersonMembershipId, me),
            eq(schema.orders.secondSalespersonMembershipId, me),
          )!,
        );
      }
    }
    if (cursor) {
      filters.push(
        or(
          lt(schema.orders.createdAt, new Date(cursor.v as string)),
          and(
            eq(schema.orders.createdAt, new Date(cursor.v as string)),
            lt(schema.orders.id, cursor.id),
          ),
        )!,
      );
    }

    const rows = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        customerId: schema.orders.customerId,
        locationId: schema.orders.locationId,
        stockLocationId: schema.orders.stockLocationId,
        totalCents: schema.orders.totalCents,
        depositRequiredCents: schema.orders.depositRequiredCents,
        fulfillmentType: schema.orders.fulfillmentType,
        requestedDate: schema.orders.requestedDate,
        importedAt: schema.orders.importedAt,
        createdAt: schema.orders.createdAt,
      })
      .from(schema.orders)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.orders.createdAt), desc(schema.orders.id))
      .limit(limit + 1);
    return buildPage(rows, limit, (r) => r.createdAt);
  }

  /**
   * The spec's orders table (PLAN-POS-OPERATIONS §8): one page of orders
   * with everything the columns need — customer, salesperson, balance
   * due, delivery date — plus the STORIS display status derived from the
   * order's real state (Draft → Pending → On PO → Reserved → Scheduled →
   * Out for Delivery → Delivered; Quote/Layaway/Cancelled as applicable).
   */
  @Get('orders/list-view')
  @RequirePermission('orders.view')
  async listView(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('view') view?: string,
    @Query('mine') mine?: string,
    @Query('locationId') locationIdFilter?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('display') display?: string,
    @Query('start') startQ?: string,
    @Query('end') endQ?: string,
  ): Promise<
    PageResponse<{
      id: string;
      number: string;
      customerName: string;
      displayStatus: string;
      poNumber: string | null;
      deliveryDate: string | null;
      balanceDueCents: number;
      salespersonName: string | null;
      totalCents: number;
      createdAt: Date;
      lineSummary: {
        units: number;
        reserved: number;
        fulfilled: number;
        specialOrder: number;
      } | null;
    }>
  > {
    const limit = clampLimit(limitStr);
    // P-014 (BA-0018/BA-0024): sortable columns. Delivery date and
    // balance due are derived values, so they sort via scalar
    // subqueries; sorted views paginate by offset (cursor "o:<n>")
    // instead of the created-at cursor.
    const SORTS: Record<string, ReturnType<typeof sql>> = {
      number: sql`${schema.orders.number}`,
      customer: sql`(${schema.customers.firstName} || ' ' || coalesce(${schema.customers.lastName}, ''))`,
      deliveryDate: sql`coalesce(
        (select min(d.scheduled_date) from deliveries d
          where d.order_id = ${schema.orders.id}
            and d.status in ('scheduled','loaded','out_for_delivery')),
        ${schema.orders.requestedDate})`,
      balanceDue: sql`greatest(0, ${schema.orders.totalCents} - coalesce(
        (select sum(p.amount_cents) from payments p
          where p.order_id = ${schema.orders.id} and p.status = 'succeeded'), 0))`,
    };
    const sortExpr = sort ? SORTS[sort] : undefined;
    const sortDesc = dir === 'desc';
    const offset = sortExpr && cursorStr?.startsWith('o:') ? Number(cursorStr.slice(2)) || 0 : 0;
    const cursor = sortExpr ? null : decodeCursor(cursorStr);
    const filters = [];
    if (status) filters.push(eq(schema.orders.status, status));
    const window = parseDayRange(startQ, endQ);
    if (window) {
      const b = utcBounds(window);
      filters.push(
        gte(schema.orders.createdAt, b.from),
        lt(schema.orders.createdAt, b.toExclusive),
      );
    }
    // P-013 (BA-0017): filter by the DISPLAY vocabulary — the same words
    // the badges show. The 1:1 states narrow in SQL; derived states
    // narrow to their possible lifecycle statuses and post-filter on the
    // computed display status (a page may return fewer than `limit`
    // rows while nextCursor keeps paging).
    const displayFilter = display && DISPLAY_STATUSES.includes(display as never) ? display : null;
    if (displayFilter === 'Draft') filters.push(eq(schema.orders.status, 'draft'));
    else if (displayFilter === 'Quote') filters.push(eq(schema.orders.status, 'quote'));
    else if (displayFilter === 'Cancelled') filters.push(eq(schema.orders.status, 'cancelled'));
    else if (displayFilter === 'Delivered')
      filters.push(inArray(schema.orders.status, ['completed', 'fulfilled']));
    else if (
      displayFilter &&
      ['Pending', 'On PO', 'Reserved', 'Scheduled', 'Out for Delivery', 'Layaway'].includes(
        displayFilter,
      )
    )
      filters.push(inArray(schema.orders.status, ['open', 'partially_fulfilled']));
    else if (displayFilter)
      // Returned / Exchanged / Awaiting Return Pickup can sit on any
      // live-or-done order.
      filters.push(sql`${schema.orders.status} not in ('draft', 'quote', 'cancelled')`);
    // G13 saved view: "Past Due" — the most useful list in the building.
    // Undelivered orders whose promised date has passed.
    if (view === 'past_due') {
      const today = new Date().toISOString().slice(0, 10);
      filters.push(
        inArray(schema.orders.status, ['open', 'partially_fulfilled']),
        sql`${schema.orders.requestedDate} < ${today}`,
      );
    }
    if (q?.trim()) {
      const like = `%${q.trim()}%`;
      filters.push(
        sql`(${schema.orders.number} ILIKE ${like} OR ${schema.customers.firstName} ILIKE ${like} OR ${schema.customers.lastName} ILIKE ${like})`,
      );
    }
    // "My orders" — same semantics as the plain list endpoint.
    if ((mine === '1' || mine === 'true') && tenant.membershipId) {
      filters.push(
        or(
          eq(schema.orders.salespersonMembershipId, tenant.membershipId),
          eq(schema.orders.secondSalespersonMembershipId, tenant.membershipId),
        )!,
      );
    }
    if (locationIdFilter) filters.push(eq(schema.orders.locationId, locationIdFilter));
    const cursorWhere = timestampCursorWhere(schema.orders.createdAt, schema.orders.id, cursor);
    if (cursorWhere) filters.push(cursorWhere);

    const rows = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        orderKind: schema.orders.orderKind,
        totalCents: schema.orders.totalCents,
        requestedDate: schema.orders.requestedDate,
        createdAt: schema.orders.createdAt,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        salespersonName: schema.users.name,
      })
      .from(schema.orders)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.orders.salespersonMembershipId),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(
        ...(sortExpr
          ? [
              sortDesc ? sql`${sortExpr} DESC NULLS LAST` : sql`${sortExpr} ASC NULLS LAST`,
              schema.orders.id,
            ]
          : timestampCursorOrder(schema.orders.createdAt, schema.orders.id)),
      )
      .offset(offset)
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const ids = pageRows.map((r) => r.id);
    const paid = new Map<string, number>();
    const deliveryState = new Map<string, { date: string | null; status: string }>();
    const poByOrder = new Map<string, string>();
    const reservedShort = new Set<string>();
    const fullyReturned = new Set<string>();
    const exchangedOriginals = new Set<string>();
    const awaitingPickup = new Set<string>();
    const lineSummaryByOrder = new Map<
      string,
      { units: number; reserved: number; fulfilled: number; specialOrder: number }
    >();
    if (ids.length > 0) {
      const pays = await this.db
        .select({
          orderId: schema.payments.orderId,
          cents: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)::int`,
        })
        .from(schema.payments)
        .where(and(inArray(schema.payments.orderId, ids), eq(schema.payments.status, 'succeeded')))
        .groupBy(schema.payments.orderId);
      for (const p of pays) if (p.orderId) paid.set(p.orderId, p.cents);

      // Undelivered trips, most advanced status first per order.
      const trips = await this.db
        .select({
          orderId: schema.deliveries.orderId,
          scheduledDate: schema.deliveries.scheduledDate,
          status: schema.deliveries.status,
        })
        .from(schema.deliveries)
        .where(
          and(
            inArray(schema.deliveries.orderId, ids),
            inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
          ),
        );
      for (const t of trips) {
        const cur = deliveryState.get(t.orderId);
        if (!cur || t.status === 'out_for_delivery') {
          deliveryState.set(t.orderId, { date: t.scheduledDate, status: t.status });
        }
      }

      // Lines still owed by an open PO → "On PO (#…)".
      const allocs = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          poNumber: schema.purchaseOrders.number,
        })
        .from(schema.poLineAllocations)
        .innerJoin(
          schema.orderLines,
          eq(schema.orderLines.id, schema.poLineAllocations.orderLineId),
        )
        .innerJoin(
          schema.purchaseOrderLines,
          eq(schema.purchaseOrderLines.id, schema.poLineAllocations.poLineId),
        )
        .innerJoin(
          schema.purchaseOrders,
          eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
        )
        .where(
          and(
            inArray(schema.orderLines.orderId, ids),
            sql`${schema.purchaseOrderLines.quantityOrdered} > ${schema.purchaseOrderLines.quantityReceived}`,
          ),
        );
      for (const a of allocs) if (!poByOrder.has(a.orderId)) poByOrder.set(a.orderId, a.poNumber);

      // §10 display statuses: fully-returned orders and originals with
      // an exchange written against them.
      const returnAgg = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          fulfilled: sql<number>`coalesce(sum(${schema.orderLines.qtyFulfilled}), 0)::int`,
          returned: sql<number>`coalesce(sum(${schema.orderLines.qtyReturned}), 0)::int`,
        })
        .from(schema.orderLines)
        .where(inArray(schema.orderLines.orderId, ids))
        .groupBy(schema.orderLines.orderId);
      for (const r of returnAgg) {
        if (r.returned > 0 && r.returned >= r.fulfilled) fullyReturned.add(r.orderId);
      }
      const exchangeChildren = await this.db
        .select({ originalOrderId: schema.orders.originalOrderId })
        .from(schema.orders)
        .where(
          and(
            inArray(schema.orders.originalOrderId, ids),
            sql`${schema.orders.status} != 'cancelled'`,
          ),
        );
      for (const r of exchangeChildren) {
        if (r.originalOrderId) exchangedOriginals.add(r.originalOrderId);
      }

      // G13 line-level roll-up: a 5-line order isn't one status. The
      // list shows "3 of 5 reserved · 1 SO" style summaries per row.
      const lineAgg = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          units: sql<number>`coalesce(sum(${schema.orderLines.quantity}), 0)::int`,
          reserved: sql<number>`coalesce(sum(${schema.orderLines.qtyReserved}), 0)::int`,
          fulfilled: sql<number>`coalesce(sum(${schema.orderLines.qtyFulfilled}), 0)::int`,
          specialOrder: sql<number>`coalesce(sum(${schema.orderLines.quantity}) filter (where ${schema.orderLines.lineType} = 'special_order'), 0)::int`,
        })
        .from(schema.orderLines)
        .where(
          and(
            inArray(schema.orderLines.orderId, ids),
            sql`${schema.orderLines.lineType} != 'custom'`,
          ),
        )
        .groupBy(schema.orderLines.orderId);
      for (const a of lineAgg) {
        lineSummaryByOrder.set(a.orderId, {
          units: a.units,
          reserved: a.reserved,
          fulfilled: a.fulfilled,
          specialOrder: a.specialOrder,
        });
      }

      // Gap §1/§8: an authorized return whose goods haven't come back
      // shows as "Awaiting Return Pickup" — the truck still owes a stop.
      const openReturns = await this.db
        .select({ orderId: schema.orderReturns.orderId })
        .from(schema.orderReturns)
        .where(
          and(
            inArray(schema.orderReturns.orderId, ids),
            eq(schema.orderReturns.status, 'authorized'),
          ),
        );
      for (const r of openReturns) if (r.orderId) awaitingPickup.add(r.orderId);

      // Stock lines not yet fully reserved → still "Pending".
      const shorts = await this.db
        .select({ orderId: schema.orderLines.orderId })
        .from(schema.orderLines)
        .where(
          and(
            inArray(schema.orderLines.orderId, ids),
            eq(schema.orderLines.lineType, 'stock'),
            sql`${schema.orderLines.qtyReserved} + ${schema.orderLines.qtyFulfilled} < ${schema.orderLines.quantity}`,
          ),
        );
      for (const r of shorts) reservedShort.add(r.orderId);
    }

    const enriched = pageRows.map((r) => {
      const balance = Math.max(0, r.totalCents - (paid.get(r.id) ?? 0));
      const credit = Math.max(0, (paid.get(r.id) ?? 0) - r.totalCents);
      const trip = deliveryState.get(r.id);
      const displayStatus = deriveDisplayStatus({
        status: r.status,
        orderKind: r.orderKind,
        balance,
        tripStatus: trip?.status ?? null,
        onPo: poByOrder.has(r.id),
        reservedShort: reservedShort.has(r.id),
        awaitingPickup: awaitingPickup.has(r.id),
        fullyReturned: fullyReturned.has(r.id),
        exchanged: exchangedOriginals.has(r.id),
      });
      return {
        id: r.id,
        number: r.number,
        customerName: [r.firstName, r.lastName].filter(Boolean).join(' ') || '—',
        displayStatus,
        poNumber: displayStatus === 'On PO' ? (poByOrder.get(r.id) ?? null) : null,
        deliveryDate: trip?.date ?? r.requestedDate,
        balanceDueCents: balance,
        creditDueCents: credit,
        salespersonName: r.salespersonName ?? null,
        lineSummary: lineSummaryByOrder.get(r.id) ?? null,
        totalCents: r.totalCents,
        createdAt: r.createdAt,
      };
    });
    const hasMore = rows.length > limit;
    const last = pageRows[pageRows.length - 1];
    return {
      data: displayFilter ? enriched.filter((r) => r.displayStatus === displayFilter) : enriched,
      nextCursor:
        hasMore && last
          ? sortExpr
            ? `o:${offset + limit}`
            : encodeCursor(last.createdAt, last.id)
          : null,
    };
  }

  /**
   * G13 Auto Stock Release (STORIS "Automatic Stock Release"): dead
   * orders sitting past their promised date stop tying up real
   * mattresses. Releases reservations on open orders promised more than
   * `days` ago with nothing on a truck; every release is registered.
   * P9's scheduler will run this nightly; until then it's a button.
   */
  /**
   * B14: fill "Pending" (under-reserved) stock lines from free stock, in
   * reservation-basis order — ops.reserveBasis, owner default
   * delivery_date. Runs automatically after PO receiving; this endpoint
   * is the manual/inspection path.
   */
  @Post('orders/allocate-pending')
  @RequirePermission('inventory.adjust')
  async allocatePending(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: { dryRun?: boolean },
  ): Promise<{
    allocated: { orderId: string; number: string; units: number }[];
    basis: 'delivery_date' | 'order_date';
    dryRun: boolean;
  }> {
    const [biz] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    const ops = (biz?.opsSettingsJson ?? {}) as { reserveBasis?: string | null };
    const basis = ops.reserveBasis === 'order_date' ? 'order_date' : 'delivery_date';
    const dryRun = body.dryRun === true;
    const allocations = await this.orders.allocatePending(this.db, {
      businessId: tenant.businessId!,
      actorUserId: actor.id,
      basis,
      dryRun,
    });
    if (!dryRun) {
      for (const a of allocations) {
        await this.audit.log({
          action: 'order.allocate_pending',
          targetType: 'order',
          targetId: a.orderId,
          metadata: { number: a.number, basis, lines: a.lines },
        });
      }
    }
    return {
      allocated: allocations.map((a) => ({
        orderId: a.orderId,
        number: a.number,
        units: a.lines.reduce((sum, l) => sum + l.quantity, 0),
      })),
      basis,
      dryRun,
    };
  }

  @Post('orders/auto-stock-release')
  @RequirePermission('inventory.adjust')
  async autoStockRelease(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: { days?: number; dryRun?: boolean },
  ): Promise<{ released: { id: string; number: string }[]; dryRun: boolean }> {
    const days = Number.isInteger(body.days) && (body.days ?? 0) > 0 ? (body.days as number) : 30;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const stale = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        locationId: schema.orders.locationId,
        stockLocationId: schema.orders.stockLocationId,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, tenant.businessId!),
          inArray(schema.orders.status, ['open', 'partially_fulfilled']),
          sql`${schema.orders.requestedDate} < ${cutoff}`,
          sql`${schema.orders.lockedAt} IS NULL`,
        ),
      )
      .limit(50);

    const released: { id: string; number: string }[] = [];
    for (const o of stale) {
      // Anything on a live truck stays committed.
      const [trip] = await this.db
        .select({ id: schema.deliveries.id })
        .from(schema.deliveries)
        .where(
          and(
            eq(schema.deliveries.orderId, o.id),
            inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
          ),
        )
        .limit(1);
      if (trip) continue;
      const [holding] = await this.db
        .select({ id: schema.orderLines.id })
        .from(schema.orderLines)
        .where(and(eq(schema.orderLines.orderId, o.id), sql`${schema.orderLines.qtyReserved} > 0`))
        .limit(1);
      if (!holding) continue;

      if (!body.dryRun) {
        await this.orders.releaseOrder(this.db, {
          businessId: tenant.businessId!,
          orderId: o.id,
          locationId: o.stockLocationId ?? o.locationId,
          actorUserId: actor?.id ?? null,
          updateLines: true,
        });
        await this.audit.log({
          action: 'order.auto_stock_release',
          targetType: 'order',
          targetId: o.id,
          metadata: { days, cutoff },
        });
        await this.exceptions.record({
          type: 'auto_stock_release',
          severity: 'info',
          entityType: 'order',
          entityId: o.id,
          summary: `Order ${o.number} released its stock — promised over ${days} days ago with no truck booked`,
        });
      }
      released.push({ id: o.id, number: o.number });
    }
    return { released, dryRun: Boolean(body.dryRun) };
  }

  /**
   * G13 reservation-drift reconciliation: phantom reservations are
   * silent and they compound. SUM(order_lines.qty_reserved) per
   * variant+location must equal inventory_levels.reserved; anything
   * else is drift worth an alert.
   */
  @Get('orders/reservation-drift')
  @RequirePermission('reports.inventory.view')
  async reservationDrift(@CurrentTenant() tenant: RequestTenantContext): Promise<
    {
      variantId: string;
      sku: string | null;
      locationId: string;
      lineReserved: number;
      levelReserved: number;
      driftUnits: number;
    }[]
  > {
    const rows = await this.db.execute(sql`
      WITH line_side AS (
        SELECT o.location_id, ol.variant_id, SUM(ol.qty_reserved)::int AS line_reserved
        FROM order_lines ol
        JOIN orders o ON o.id = ol.order_id
        WHERE ol.business_id = ${tenant.businessId}
          AND ol.variant_id IS NOT NULL
        GROUP BY o.location_id, ol.variant_id
      )
      SELECT
        COALESCE(ls.variant_id, il.variant_id) AS variant_id,
        pv.sku,
        COALESCE(ls.location_id, il.location_id) AS location_id,
        COALESCE(ls.line_reserved, 0) AS line_reserved,
        COALESCE(il.reserved, 0) AS level_reserved
      FROM line_side ls
      FULL OUTER JOIN inventory_levels il
        ON il.variant_id = ls.variant_id AND il.location_id = ls.location_id
        AND il.business_id = ${tenant.businessId}
      LEFT JOIN product_variants pv ON pv.id = COALESCE(ls.variant_id, il.variant_id)
      WHERE COALESCE(ls.line_reserved, 0) != COALESCE(il.reserved, 0)
    `);
    return (rows as unknown as Record<string, unknown>[]).map((r) => ({
      variantId: String(r.variant_id),
      sku: (r.sku as string | null) ?? null,
      locationId: String(r.location_id),
      lineReserved: Number(r.line_reserved),
      levelReserved: Number(r.level_reserved),
      driftUnits: Number(r.line_reserved) - Number(r.level_reserved),
    }));
  }

  /**
   * G14 duplicate-order detection (STORIS: prompts to consolidate
   * delivery dates): the customer's open orders with their promised /
   * scheduled dates, so New Sale can warn "this house already has a
   * truck coming" before a second one gets booked.
   */
  @Get('customers/:customerId/open-orders')
  @RequirePermission('orders.view')
  async openOrdersFor(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('customerId') customerId: string,
  ): Promise<
    { id: string; number: string; requestedDate: string | null; deliveryDate: string | null }[]
  > {
    const rows = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        requestedDate: schema.orders.requestedDate,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.customerId, customerId),
          inArray(schema.orders.status, ['open', 'partially_fulfilled']),
        ),
      )
      .orderBy(desc(schema.orders.createdAt))
      .limit(20);
    if (rows.length === 0) return [];
    const trips = await this.db
      .select({
        orderId: schema.deliveries.orderId,
        scheduledDate: schema.deliveries.scheduledDate,
      })
      .from(schema.deliveries)
      .where(
        and(
          inArray(
            schema.deliveries.orderId,
            rows.map((r) => r.id),
          ),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      );
    const tripByOrder = new Map<string, string>();
    for (const t of trips) {
      const cur = tripByOrder.get(t.orderId);
      if (!cur || t.scheduledDate < cur) tripByOrder.set(t.orderId, t.scheduledDate);
    }
    return rows.map((r) => ({
      ...r,
      deliveryDate: tripByOrder.get(r.id) ?? null,
    }));
  }

  /**
   * The customer file's purchase history: every purchase document —
   * orders AND point-of-sale receipts (the STORIS import landed as
   * sales) — newest-first with full line detail (what they bought, at
   * what price, how much of it was delivered or came back) and the
   * money picture, in one call — the customer page renders it without
   * a fetch per document.
   */
  @Get('customers/:customerId/order-history')
  @RequirePermission('orders.view')
  async orderHistoryFor(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('customerId') customerId: string,
    @Query('limit') limitStr?: string,
  ): Promise<
    {
      id: string;
      docType: 'order' | 'sale';
      number: string;
      status: string;
      orderKind: string;
      fulfillmentType: string | null;
      requestedDate: string | null;
      importedAt: Date | null;
      createdAt: Date;
      totalCents: number;
      paidCents: number;
      balanceDueCents: number;
      lines: {
        id: string;
        description: string;
        quantity: number;
        unitPriceCents: number;
        totalCents: number;
        taxCents: number;
        qtyFulfilled: number;
        qtyReturned: number;
        fulfillmentMethod: string | null;
      }[];
    }[]
  > {
    const limit = clampLimit(limitStr, 25);
    const orders = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        orderKind: schema.orders.orderKind,
        fulfillmentType: schema.orders.fulfillmentType,
        requestedDate: schema.orders.requestedDate,
        importedAt: schema.orders.importedAt,
        createdAt: schema.orders.createdAt,
        totalCents: schema.orders.totalCents,
      })
      .from(schema.orders)
      .where(eq(schema.orders.customerId, customerId))
      .orderBy(desc(schema.orders.createdAt), desc(schema.orders.id))
      .limit(limit);
    const sales = await this.db
      .select({
        id: schema.sales.id,
        number: schema.sales.number,
        status: schema.sales.status,
        importedAt: schema.sales.importedAt,
        completedAt: schema.sales.completedAt,
        createdAt: schema.sales.createdAt,
        totalCents: schema.sales.totalCents,
      })
      .from(schema.sales)
      .where(eq(schema.sales.customerId, customerId))
      .orderBy(desc(schema.sales.createdAt), desc(schema.sales.id))
      .limit(limit);

    const orderIds = orders.map((o) => o.id);
    const lines =
      orderIds.length === 0
        ? []
        : await this.db
            .select({
              id: schema.orderLines.id,
              orderId: schema.orderLines.orderId,
              description: schema.orderLines.description,
              quantity: schema.orderLines.quantity,
              unitPriceCents: schema.orderLines.unitPriceCents,
              totalCents: schema.orderLines.totalCents,
              taxCents: schema.orderLines.taxCents,
              qtyFulfilled: schema.orderLines.qtyFulfilled,
              qtyReturned: schema.orderLines.qtyReturned,
              fulfillmentMethod: schema.orderLines.fulfillmentMethod,
            })
            .from(schema.orderLines)
            .where(inArray(schema.orderLines.orderId, orderIds))
            .orderBy(schema.orderLines.createdAt);
    const payments =
      orderIds.length === 0
        ? []
        : await this.db
            .select({
              orderId: schema.payments.orderId,
              amountCents: schema.payments.amountCents,
              status: schema.payments.status,
            })
            .from(schema.payments)
            .where(inArray(schema.payments.orderId, orderIds));
    const saleIds = sales.map((s) => s.id);
    const saleLines =
      saleIds.length === 0
        ? []
        : await this.db
            .select({
              id: schema.saleLines.id,
              saleId: schema.saleLines.saleId,
              description: schema.saleLines.description,
              quantity: schema.saleLines.quantity,
              unitPriceCents: schema.saleLines.unitPriceCents,
              totalCents: schema.saleLines.totalCents,
              taxCents: schema.saleLines.taxCents,
            })
            .from(schema.saleLines)
            .where(inArray(schema.saleLines.saleId, saleIds));

    const paidByOrder = new Map<string, number>();
    for (const p of payments) {
      if (p.status !== 'succeeded' || !p.orderId) continue;
      paidByOrder.set(p.orderId, (paidByOrder.get(p.orderId) ?? 0) + p.amountCents);
    }
    const linesByOrder = new Map<string, typeof lines>();
    for (const l of lines) {
      const bucket = linesByOrder.get(l.orderId) ?? [];
      bucket.push(l);
      linesByOrder.set(l.orderId, bucket);
    }
    const linesBySale = new Map<string, typeof saleLines>();
    for (const l of saleLines) {
      const bucket = linesBySale.get(l.saleId) ?? [];
      bucket.push(l);
      linesBySale.set(l.saleId, bucket);
    }

    const orderDocs = orders.map((o) => {
      const paid = paidByOrder.get(o.id) ?? 0;
      return {
        ...o,
        docType: 'order' as const,
        paidCents: paid,
        balanceDueCents: Math.max(0, o.totalCents - paid),
        lines: (linesByOrder.get(o.id) ?? []).map(({ orderId: _orderId, ...rest }) => rest),
      };
    });
    // Receipts are settled documents: money collected at the counter,
    // goods handed over — the line state mirrors that.
    const saleDocs = sales.map((s) => ({
      id: s.id,
      docType: 'sale' as const,
      number: s.number,
      status: s.status,
      orderKind: 'sale',
      fulfillmentType: null,
      requestedDate: null,
      importedAt: s.importedAt,
      createdAt: s.completedAt ?? s.createdAt,
      totalCents: s.totalCents,
      paidCents: s.totalCents,
      balanceDueCents: 0,
      lines: (linesBySale.get(s.id) ?? []).map(({ saleId: _saleId, ...rest }) => ({
        ...rest,
        qtyFulfilled: rest.quantity,
        qtyReturned: 0,
        fulfillmentMethod: null,
      })),
    }));
    return [...orderDocs, ...saleDocs]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  @Get('orders/:id')
  @RequirePermission('orders.view')
  async get(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<
    OrderDetail & {
      displayStatus: string;
      displayPoNumber: string | null;
      lines: (OrderLineRow & { po: OrderLinePo | null })[];
      /** §10 exchanges written against this order (owner 2026-09-02: their own card). */
      exchangeOrders: {
        id: string;
        number: string;
        status: string;
        totalCents: number;
        createdAt: Date;
      }[];
    }
  > {
    const detail = await this.loadDetail(id);
    // Per-line purchase order (owner 2026-09-02): what each unreserved
    // line is waiting on, and when the PO has been accepted and the
    // units reserved.
    const poRows = await this.db
      .select({
        orderLineId: schema.poLineAllocations.orderLineId,
        allocStatus: schema.poLineAllocations.status,
        quantity: schema.poLineAllocations.quantity,
        poId: schema.purchaseOrders.id,
        poNumber: schema.purchaseOrders.number,
        poStatus: schema.purchaseOrders.status,
        expectedAt: schema.purchaseOrders.expectedAt,
      })
      .from(schema.poLineAllocations)
      .innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.poLineAllocations.orderLineId))
      .innerJoin(
        schema.purchaseOrderLines,
        eq(schema.purchaseOrderLines.id, schema.poLineAllocations.poLineId),
      )
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
      )
      .where(
        and(
          eq(schema.orderLines.orderId, id),
          sql`${schema.poLineAllocations.status} != 'cancelled'`,
          sql`${schema.purchaseOrders.deletedAt} IS NULL`,
        ),
      );
    const linePo = new Map<string, OrderLinePo>();
    for (const r of poRows) {
      const cur = linePo.get(r.orderLineId) ?? {
        poId: r.poId,
        poNumber: r.poNumber,
        poStatus: r.poStatus,
        ordered: 0,
        received: 0,
        expectedAt: r.expectedAt ?? null,
      };
      if (r.allocStatus === 'received') cur.received += r.quantity;
      else cur.ordered += r.quantity;
      linePo.set(r.orderLineId, cur);
    }
    const exchangeOrders = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        totalCents: schema.orders.totalCents,
        createdAt: schema.orders.createdAt,
      })
      .from(schema.orders)
      .where(eq(schema.orders.originalOrderId, id))
      .orderBy(schema.orders.createdAt);
    // P-013 (BA-0017): the detail page shows the same display status as
    // the list — one vocabulary, derived from the same ladder.
    const [trip] = await this.db
      .select({ status: schema.deliveries.status })
      .from(schema.deliveries)
      .where(
        and(
          eq(schema.deliveries.orderId, id),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      )
      .orderBy(sql`case when ${schema.deliveries.status} = 'out_for_delivery' then 0 else 1 end`)
      .limit(1);
    const [openPo] = await this.db
      .select({ number: schema.purchaseOrders.number })
      .from(schema.poLineAllocations)
      .innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.poLineAllocations.orderLineId))
      .innerJoin(
        schema.purchaseOrderLines,
        eq(schema.purchaseOrderLines.id, schema.poLineAllocations.poLineId),
      )
      .innerJoin(
        schema.purchaseOrders,
        eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
      )
      .where(
        and(
          eq(schema.orderLines.orderId, id),
          sql`${schema.purchaseOrderLines.quantityOrdered} > ${schema.purchaseOrderLines.quantityReceived}`,
        ),
      )
      .limit(1);
    const [openReturn] = await this.db
      .select({ id: schema.orderReturns.id })
      .from(schema.orderReturns)
      .where(and(eq(schema.orderReturns.orderId, id), eq(schema.orderReturns.status, 'authorized')))
      .limit(1);
    const [exchangeChild] = await this.db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(
        and(eq(schema.orders.originalOrderId, id), sql`${schema.orders.status} != 'cancelled'`),
      )
      .limit(1);
    const fulfilledUnits = detail.lines.reduce((n, l) => n + l.qtyFulfilled, 0);
    const returnedUnits = detail.lines.reduce((n, l) => n + l.qtyReturned, 0);
    const reservedShort = detail.lines.some(
      (l) => l.lineType === 'stock' && l.qtyReserved + l.qtyFulfilled < l.quantity,
    );
    const displayStatus = deriveDisplayStatus({
      status: detail.status,
      orderKind: detail.orderKind,
      balance: detail.balanceDueCents,
      tripStatus: trip?.status ?? null,
      onPo: Boolean(openPo),
      reservedShort,
      awaitingPickup: Boolean(openReturn),
      fullyReturned: returnedUnits > 0 && returnedUnits >= fulfilledUnits,
      exchanged: Boolean(exchangeChild),
    });
    return {
      ...detail,
      lines: detail.lines.map((l) => ({ ...l, po: linePo.get(l.id) ?? null })),
      exchangeOrders,
      displayStatus,
      displayPoNumber: displayStatus === 'On PO' ? (openPo?.number ?? null) : null,
    };
  }

  /**
   * Write an order. Runs inside the request's RLS transaction, so a
   * failure part-way through (a bad line, a reservation that can't be
   * written) rolls back the header, the lines, and the stock commitment
   * together.
   */
  @Post('orders')
  @RequirePermission('orders.create')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: CreateOrderBody,
  ): Promise<
    OrderDetail & { splitOrders?: { id: string; number: string; requestedDate: string | null }[] }
  > {
    if (!body.locationId) throw new BadRequestException('locationId is required');
    assertSellingScope(tenant, body.locationId);
    if (!body.customerId) throw new BadRequestException('customerId is required');
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must contain at least one entry');
    }
    const fulfillmentType = body.fulfillmentType ?? 'delivery';
    if (!FULFILLMENT_TYPES.includes(fulfillmentType)) {
      throw new BadRequestException(
        `fulfillmentType must be one of ${FULFILLMENT_TYPES.join(', ')}`,
      );
    }
    const orderKind = body.orderKind ?? 'sales_order';
    if (!ORDER_KINDS.includes(orderKind)) {
      throw new BadRequestException(`orderKind must be one of ${ORDER_KINDS.join(', ')}`);
    }
    if (body.deliveryStatus != null && !DELIVERY_STATUSES.includes(body.deliveryStatus)) {
      throw new BadRequestException(
        `deliveryStatus must be one of ${DELIVERY_STATUSES.join(', ')}`,
      );
    }
    assertFees(body);
    if (body.splitBps != null && (body.splitBps < 0 || body.splitBps > 10000)) {
      throw new BadRequestException('splitBps must be between 0 and 10000');
    }
    const orderDiscountCents = body.orderDiscountCents ?? 0;
    if (!Number.isInteger(orderDiscountCents) || orderDiscountCents < 0) {
      throw new BadRequestException('orderDiscountCents must be a non-negative integer');
    }
    if (
      body.depositRequiredCents !== undefined &&
      (!Number.isInteger(body.depositRequiredCents) || body.depositRequiredCents < 0)
    ) {
      throw new BadRequestException('depositRequiredCents must be a non-negative integer');
    }

    const [location] = await this.db
      .select({ id: schema.locations.id, taxRateBps: schema.locations.taxRateBps })
      .from(schema.locations)
      .where(eq(schema.locations.id, body.locationId))
      .limit(1);
    if (!location) throw new NotFoundException('Location not found');

    const [customer] = await this.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.id, body.customerId))
      .limit(1);
    if (!customer) throw new NotFoundException('Customer not found');

    if (body.pickupLocationId) {
      const [pickup] = await this.db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.id, body.pickupLocationId))
        .limit(1);
      if (!pickup) throw new NotFoundException('Pickup location not found');
    }
    if (body.stockLocationId) {
      const [src] = await this.db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.id, body.stockLocationId))
        .limit(1);
      if (!src) throw new NotFoundException('Stock location not found');
    }
    {
      const lineSources = [
        ...new Set(
          (body.lines ?? []).map((l) => l.sourceLocationId).filter((v): v is string => Boolean(v)),
        ),
      ];
      if (lineSources.length > 0) {
        const found = await this.db
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(inArray(schema.locations.id, lineSources));
        if (found.length !== lineSources.length) {
          throw new NotFoundException('One or more line source locations not found');
        }
      }
    }

    const priced = await this.priceLines(tenant, body.locationId, body.lines);
    // Drafts skip the variance gate; it re-runs when the draft is
    // completed through this endpoint again (drafts are superseded by a
    // fresh create, never confirmed in place).
    if (!body.draft) {
      await this.priceVariance.enforce(tenant.businessId!, priced, orderDiscountCents, body, {
        action: 'Write order below list price',
      });
    }

    const number = await this.orders.generateOrderNumber(
      this.db,
      tenant.businessId!,
      body.locationId,
    );
    const [order] = await this.db
      .insert(schema.orders)
      .values({
        businessId: tenant.businessId!,
        locationId: body.locationId,
        stockLocationId:
          body.stockLocationId && body.stockLocationId !== body.locationId
            ? body.stockLocationId
            : null,
        number,
        status: body.draft ? 'draft' : 'quote',
        customerId: body.customerId,
        salespersonMembershipId: body.salespersonMembershipId ?? tenant.membershipId ?? null,
        secondSalespersonMembershipId: body.secondSalespersonMembershipId ?? null,
        splitBps: body.splitBps ?? null,
        orderDiscountCents,
        orderKind,
        fulfillmentType,
        deliveryStatus: body.deliveryStatus ?? null,
        deliveryInstructions: body.deliveryInstructions ?? null,
        pickupLocationId: body.pickupLocationId ?? null,
        billingAddressJson: (body.billingAddress ?? null) as never,
        marketingCode: body.marketingCode ?? null,
        deliveryFeeCents: body.deliveryFeeCents ?? 0,
        installFeeCents: body.installFeeCents ?? 0,
        otherFeeCents: body.otherFeeCents ?? 0,
        otherFeeLabel: body.otherFeeLabel ?? null,
        addressLine1: body.address?.line1 ?? null,
        addressLine2: body.address?.line2 ?? null,
        addressCity: body.address?.city ?? null,
        addressRegion: body.address?.region ?? null,
        addressPostalCode: body.address?.postalCode ?? null,
        addressPhone: body.address?.phone ?? null,
        requestedDate: body.requestedDate ?? null,
        notes: body.notes ?? null,
        internalNotes: body.internalNotes ?? null,
      })
      .returning();
    if (!order) throw new BadRequestException('failed to create order');

    const orderDefaultSource = order.stockLocationId ?? order.locationId;
    await this.db.insert(schema.orderLines).values(
      priced.map((l, i) => ({
        businessId: tenant.businessId!,
        orderId: order.id,
        variantId: l.variantId,
        description: l.description,
        quantity: l.quantity,
        lineType: l.lineType,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.lineDiscountCents,
        taxRateBps: l.taxRateBps,
        taxClassId: l.taxClassId,
        fulfillmentMethod: lineFulfillment(body.lines![i]),
        // Stored only when it actually differs from the order's default,
        // so changing the default later re-inherits cleanly.
        sourceLocationId:
          body.lines![i]?.sourceLocationId &&
          body.lines![i]!.sourceLocationId !== orderDefaultSource
            ? body.lines![i]!.sourceLocationId!
            : null,
        deliveryDate: body.lines![i]?.deliveryDate ?? null,
        // Placeholders — recomputeTotals prices every line against the
        // whole cart (the order discount is allocated pro-rata) and
        // writes the real numbers back.
        taxCents: 0,
        totalCents: 0,
      })),
    );

    const totals = await this.orders.recomputeTotals(this.db, order.id);

    // Deposit policy: explicit amount wins, otherwise the default rate.
    const depositRequiredCents =
      body.depositRequiredCents ?? defaultDepositCents(totals.totalCents, DEFAULT_DEPOSIT_RATE_BPS);
    await this.db
      .update(schema.orders)
      .set({ depositRequiredCents, updatedAt: new Date() })
      .where(eq(schema.orders.id, order.id));

    // Confirming commits stock immediately. A quote deliberately holds
    // nothing — otherwise every browsing customer would tie up inventory.
    if (body.confirm) {
      const plan = await this.orders.reserveOrder(this.db, {
        businessId: tenant.businessId!,
        orderId: order.id,
        locationId: body.stockLocationId ?? body.locationId,
        actorUserId: actor?.id ?? null,
      });
      await this.db
        .update(schema.orders)
        .set({ status: 'open', updatedAt: new Date() })
        .where(eq(schema.orders.id, order.id));
      // XFR-051: shortfall at this store + free stock at a sister store
      // → draft auto transfer (no-op while ops.autoScheduleDays is blank).
      await this.autoTransfers.generateForShortfalls(this.db, {
        businessId: tenant.businessId!,
        orderId: order.id,
        orderNumber: order.number,
        locationId: body.stockLocationId ?? body.locationId,
        shortfalls: plan.shortfalls,
        actorUserId: actor?.id ?? null,
      });
    }

    await this.audit.log({
      action: 'order.create',
      targetType: 'order',
      targetId: order.id,
      after: {
        number: order.number,
        status: body.confirm ? 'open' : 'quote',
        totalCents: totals.totalCents,
        depositRequiredCents,
        lineCount: priced.length,
        customerId: order.customerId,
      },
    });

    // G6 (§5): the CA recycling fee is a state-mandated pass-through. A
    // qualifying order written without one registers an exception — the
    // removal shows up in the digest whether or not the UI prompted.
    if (!body.draft) {
      const RECYCLING_KEYWORDS = /mattress|foundation|adjustable base|box spring/i;
      const qualifies = priced.some(
        (l) => l.lineType !== 'custom' && RECYCLING_KEYWORDS.test(l.description),
      );
      const hasFee = priced.some(
        (l) => l.lineType === 'custom' && /recycling/i.test(l.description),
      );
      if (qualifies && !hasFee) {
        await this.exceptions.record({
          type: 'recycling_fee_removed',
          severity: 'info',
          entityType: 'order',
          entityId: order.id,
          summary: `Order ${order.number} has qualifying units but no recycling fee`,
        });
      }
    }

    let splitOrders: { id: string; number: string; requestedDate: string | null }[] = [];
    if (body.splitByDeliveryDate) {
      splitOrders = await this.splitByDeliveryDates(tenant, actor, order.id);
    }
    const detail = await this.loadDetail(order.id);
    this.fireOrderEvent('order.created', tenant.businessId!, detail);
    return splitOrders.length > 0 ? { ...detail, splitOrders } : detail;
  }

  /**
   * Split-at-sale: lines promised on a different date than the order
   * itself peel off into suffixed sibling orders, one per distinct
   * date. Lines with no date (or the order's own date) stay put; a
   * date that would take EVERY line is skipped — that is a date
   * change, not a split.
   */
  private async splitByDeliveryDates(
    tenant: RequestTenantContext,
    actor: CurrentUserPayload,
    orderId: string,
  ): Promise<{ id: string; number: string; requestedDate: string | null }[]> {
    const siblings: { id: string; number: string; requestedDate: string | null }[] = [];
    for (;;) {
      const [order] = await this.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      if (!order) break;
      const lines = await this.db
        .select()
        .from(schema.orderLines)
        .where(eq(schema.orderLines.orderId, orderId));
      const splitDates = [
        ...new Set(
          lines
            .map((l) => l.deliveryDate)
            .filter((d): d is string => Boolean(d) && d !== order.requestedDate),
        ),
      ].sort();
      const date = splitDates[0];
      if (!date) break;
      const moving = lines.filter((l) => l.deliveryDate === date);
      if (moving.length === lines.length) break; // would empty the order
      const sibling = await this.executeSplit(
        tenant,
        actor,
        order,
        moving.map((line) => ({ line, quantity: line.quantity })),
        date,
      );
      siblings.push({ ...sibling, requestedDate: date });
    }
    return siblings;
  }

  @Patch('orders/:id')
  @RequirePermission('orders.update')
  async update(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateOrderBody,
  ): Promise<OrderDetail> {
    const order = await this.requireLiveOrder(id);
    // G9 (§3): the locked-state allowlist. If staff must unlock to fix
    // a phone number, unlocking becomes routine and the lock is
    // worthless — contact/notes fixes pass through the lock.
    const SAFE_WHILE_LOCKED = new Set([
      'deliveryInstructions',
      'notes',
      'internalNotes',
      'address',
      // A20 metadata — attribution, source, terminal, comments never
      // touch money or the truck.
      'marketingCode',
      'marketingCode2',
      'orderSource',
      'paymentTerminal',
      'exceptionNotes',
      'tradeDesigner',
      'customInfo',
    ]);
    const touchesGuardedFields = Object.keys(body).some((k) => !SAFE_WHILE_LOCKED.has(k));
    if (touchesGuardedFields) {
      this.assertUnlocked(order);
      await this.assertNotOnOpenRun(id);
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.fulfillmentType !== undefined) {
      if (!FULFILLMENT_TYPES.includes(body.fulfillmentType)) {
        throw new BadRequestException(
          `fulfillmentType must be one of ${FULFILLMENT_TYPES.join(', ')}`,
        );
      }
      patch.fulfillmentType = body.fulfillmentType;
    }
    if (body.orderKind !== undefined) {
      if (!ORDER_KINDS.includes(body.orderKind)) {
        throw new BadRequestException(`orderKind must be one of ${ORDER_KINDS.join(', ')}`);
      }
      patch.orderKind = body.orderKind;
    }
    if (body.deliveryStatus !== undefined) {
      if (body.deliveryStatus != null && !DELIVERY_STATUSES.includes(body.deliveryStatus)) {
        throw new BadRequestException(
          `deliveryStatus must be one of ${DELIVERY_STATUSES.join(', ')}`,
        );
      }
      patch.deliveryStatus = body.deliveryStatus;
    }
    if (body.deliveryInstructions !== undefined)
      patch.deliveryInstructions = body.deliveryInstructions;
    if (body.marketingCode !== undefined) patch.marketingCode = body.marketingCode;
    if (body.marketingCode2 !== undefined) {
      patch.marketingCode2 = a20Text('marketingCode2', body.marketingCode2, 60);
    }
    if (body.orderSource !== undefined)
      patch.orderSource = a20Text('orderSource', body.orderSource, 60);
    if (body.paymentTerminal !== undefined) {
      patch.paymentTerminal = a20Text('paymentTerminal', body.paymentTerminal, 60);
    }
    if (body.exceptionNotes !== undefined) {
      patch.exceptionNotes = a20Text('exceptionNotes', body.exceptionNotes, 4000);
    }
    if (body.tradeDesigner !== undefined) {
      patch.tradeDesignerJson = a20TradeDesigner(body.tradeDesigner) as never;
    }
    if (body.customInfo !== undefined)
      patch.customInfoJson = a20CustomInfo(body.customInfo) as never;
    if (body.billingAddress !== undefined) patch.billingAddressJson = body.billingAddress as never;
    if (body.pickupLocationId !== undefined) {
      if (body.pickupLocationId) {
        const [pickup] = await this.db
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(eq(schema.locations.id, body.pickupLocationId))
          .limit(1);
        if (!pickup) throw new NotFoundException('Pickup location not found');
      }
      patch.pickupLocationId = body.pickupLocationId;
    }
    if (body.stockLocationId !== undefined) {
      if (body.stockLocationId) {
        const [src] = await this.db
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(eq(schema.locations.id, body.stockLocationId))
          .limit(1);
        if (!src) throw new NotFoundException('Stock location not found');
      }
      const effective =
        body.stockLocationId && body.stockLocationId !== order.locationId
          ? body.stockLocationId
          : null;
      if (effective !== (order.stockLocationId ?? null)) {
        // Reservations live at the old location — moving the source under
        // them would strand the holds. Release first, then move.
        const [holding] = await this.db
          .select({ id: schema.orderLines.id })
          .from(schema.orderLines)
          .where(and(eq(schema.orderLines.orderId, id), sql`${schema.orderLines.qtyReserved} > 0`))
          .limit(1);
        if (holding) {
          throw new BadRequestException(
            'This order holds reserved stock — release the reservation before changing where inventory comes from',
          );
        }
        patch.stockLocationId = effective;
      }
    }
    if (body.requestedDate !== undefined) patch.requestedDate = body.requestedDate;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.internalNotes !== undefined) patch.internalNotes = body.internalNotes;
    if (body.salespersonMembershipId !== undefined) {
      patch.salespersonMembershipId = body.salespersonMembershipId;
    }
    if (body.secondSalespersonMembershipId !== undefined) {
      patch.secondSalespersonMembershipId = body.secondSalespersonMembershipId;
    }
    if (body.splitBps !== undefined) {
      if (body.splitBps != null && (body.splitBps < 0 || body.splitBps > 10000)) {
        throw new BadRequestException('splitBps must be between 0 and 10000');
      }
      patch.splitBps = body.splitBps;
    }
    if (body.depositRequiredCents !== undefined) {
      if (!Number.isInteger(body.depositRequiredCents) || body.depositRequiredCents < 0) {
        throw new BadRequestException('depositRequiredCents must be a non-negative integer');
      }
      patch.depositRequiredCents = body.depositRequiredCents;
    }
    if (body.address) {
      if (body.address.line1 !== undefined) patch.addressLine1 = body.address.line1;
      if (body.address.line2 !== undefined) patch.addressLine2 = body.address.line2;
      if (body.address.city !== undefined) patch.addressCity = body.address.city;
      if (body.address.region !== undefined) patch.addressRegion = body.address.region;
      if (body.address.postalCode !== undefined) patch.addressPostalCode = body.address.postalCode;
      if (body.address.phone !== undefined) patch.addressPhone = body.address.phone;
    }

    let repriced = false;
    if (
      body.deliveryFeeCents !== undefined ||
      body.installFeeCents !== undefined ||
      body.otherFeeCents !== undefined ||
      body.otherFeeLabel !== undefined
    ) {
      assertFees(body);
      if (body.deliveryFeeCents !== undefined) patch.deliveryFeeCents = body.deliveryFeeCents;
      if (body.installFeeCents !== undefined) patch.installFeeCents = body.installFeeCents;
      if (body.otherFeeCents !== undefined) patch.otherFeeCents = body.otherFeeCents;
      if (body.otherFeeLabel !== undefined) patch.otherFeeLabel = body.otherFeeLabel;
      repriced = true;
    }
    if (body.orderDiscountCents !== undefined) {
      if (!Number.isInteger(body.orderDiscountCents) || body.orderDiscountCents < 0) {
        throw new BadRequestException('orderDiscountCents must be a non-negative integer');
      }
      patch.orderDiscountCents = body.orderDiscountCents;
      repriced = true;
    }

    // G6: a raised order discount, or completing a parked draft/quote,
    // re-runs the price-variance gate against catalog list prices.
    if (
      (body.orderDiscountCents !== undefined &&
        body.orderDiscountCents > order.orderDiscountCents) ||
      (body.status === 'open' && (order.status === 'draft' || order.status === 'quote'))
    ) {
      const lines = await this.varianceLinesFor(id);
      await this.priceVariance.enforce(
        tenant.businessId!,
        lines,
        body.orderDiscountCents ?? order.orderDiscountCents,
        body,
        { action: `Discount order ${order.number}`, entityType: 'order', entityId: id },
      );
    }

    await this.db.update(schema.orders).set(patch).where(eq(schema.orders.id, id));
    if (repriced) await this.orders.recomputeTotals(this.db, id);

    // Confirming a quote is the one status change this endpoint accepts;
    // it commits stock the same way `create({confirm:true})` does.
    if (body.status === 'open') {
      if (order.status !== 'quote' && order.status !== 'draft') {
        throw new BadRequestException(`Cannot confirm an order in status '${order.status}'`);
      }
      await this.orders.reserveOrder(this.db, {
        businessId: tenant.businessId!,
        orderId: id,
        locationId: order.stockLocationId ?? order.locationId,
        actorUserId: actor?.id ?? null,
      });
      await this.db
        .update(schema.orders)
        .set({ status: 'open', updatedAt: new Date() })
        .where(eq(schema.orders.id, id));
    }

    await this.audit.log({
      action: 'order.update',
      targetType: 'order',
      targetId: id,
      before: { status: order.status, totalCents: order.totalCents },
      after: { ...patch, status: body.status ?? order.status },
    });

    return this.loadDetail(id);
  }

  /** Append a line and reprice. Reserves immediately if the order is live. */
  @Post('orders/:id/lines')
  @RequirePermission('orders.update')
  async addLine(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: OrderLineInput & {
      priceReasonCodeId?: string;
      priceReason?: string;
      override?: OverrideCredentials;
    },
  ): Promise<OrderDetail> {
    const order = await this.requireLiveOrder(id);
    this.assertUnlocked(order);
    await this.assertNotOnOpenRun(id);
    const [priced] = await this.priceLines(tenant, order.locationId, [body]);
    if (order.status !== 'draft') {
      await this.priceVariance.enforce(tenant.businessId!, [priced!], 0, body, {
        action: `Add discounted line to ${order.number}`,
        entityType: 'order',
        entityId: id,
      });
    }

    if (body.sourceLocationId) {
      const [src] = await this.db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.id, body.sourceLocationId))
        .limit(1);
      if (!src) throw new NotFoundException('Line source location not found');
    }
    const [line] = await this.db
      .insert(schema.orderLines)
      .values({
        businessId: tenant.businessId!,
        orderId: id,
        variantId: priced!.variantId,
        description: priced!.description,
        quantity: priced!.quantity,
        lineType: priced!.lineType,
        unitPriceCents: priced!.unitPriceCents,
        discountCents: priced!.lineDiscountCents,
        taxRateBps: priced!.taxRateBps,
        taxClassId: priced!.taxClassId,
        sourceLocationId:
          body.sourceLocationId &&
          body.sourceLocationId !== (order.stockLocationId ?? order.locationId)
            ? body.sourceLocationId
            : null,
        taxCents: 0,
        totalCents: 0,
      })
      .returning();

    await this.orders.recomputeTotals(this.db, id);
    if (order.status !== 'quote') {
      await this.orders.reserveOrder(this.db, {
        businessId: tenant.businessId!,
        orderId: id,
        locationId: order.stockLocationId ?? order.locationId,
        actorUserId: actor?.id ?? null,
      });
    }

    await this.audit.log({
      action: 'order.line.add',
      targetType: 'order',
      targetId: id,
      after: { lineId: line!.id, variantId: line!.variantId, quantity: line!.quantity },
    });
    return this.loadDetail(id);
  }

  /**
   * Remove a line, releasing whatever it had committed. A line that has
   * already been (partly) delivered can't be removed — that's a refund,
   * not an edit.
   */
  @Delete('orders/:id/lines/:lineId')
  @RequirePermission('orders.update')
  async removeLine(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ): Promise<OrderDetail> {
    const order = await this.requireLiveOrder(id);
    this.assertUnlocked(order);
    await this.assertNotOnOpenRun(id);
    const [line] = await this.db
      .select()
      .from(schema.orderLines)
      .where(and(eq(schema.orderLines.id, lineId), eq(schema.orderLines.orderId, id)))
      .limit(1);
    if (!line) throw new NotFoundException('Order line not found');
    if (line.qtyFulfilled > 0) {
      throw new BadRequestException(
        'Cannot remove a line that has already been fulfilled — refund it instead',
      );
    }

    if (line.variantId && line.qtyReserved > 0) {
      await this.orders.applyReleases(this.db, {
        businessId: tenant.businessId!,
        orderId: id,
        locationId: line.sourceLocationId ?? order.stockLocationId ?? order.locationId,
        actorUserId: actor?.id ?? null,
        releases: [{ orderLineId: line.id, variantId: line.variantId, quantity: line.qtyReserved }],
        // The row is about to be deleted; skipping its update avoids a
        // pointless write against a doomed row.
        updateLines: false,
      });
    }

    await this.db.delete(schema.orderLines).where(eq(schema.orderLines.id, lineId));
    await this.orders.recomputeTotals(this.db, id);

    await this.audit.log({
      action: 'order.line.remove',
      targetType: 'order',
      targetId: id,
      before: { lineId, variantId: line.variantId, quantity: line.quantity },
    });
    return this.loadDetail(id);
  }

  /**
   * Split an order (owner ask 2026-08-30): a backorder pushes part of
   * the sale to a later date, so the writer picks the affected lines
   * and they move to a NEW order with its own promised date, delivery,
   * ticket, and balance. Stock committed to the moved units re-commits
   * on the new order at the same per-line source. Payments stay on the
   * original — they were tendered against it — and each order then
   * shows its own balance due.
   */
  @Post('orders/:id/split')
  @RequirePermission('orders.update')
  async splitOrder(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: {
      lines?: { lineId?: string; quantity?: number }[];
      /** The new order's promised date — the later, backordered date. */
      requestedDate?: string | null;
    },
  ): Promise<{ order: OrderDetail; newOrder: { id: string; number: string } }> {
    const order = await this.requireLiveOrder(id);
    this.assertUnlocked(order);
    await this.assertNotOnOpenRun(id);
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must name at least one line to move');
    }
    const ids = body.lines.map((l) => l.lineId);
    if (ids.some((x) => !x) || new Set(ids).size !== ids.length) {
      throw new BadRequestException('lines[].lineId must be unique and present');
    }

    const allLines = await this.db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, id));
    const byId = new Map(allLines.map((l) => [l.id, l]));
    const moves: { line: (typeof allLines)[number]; quantity: number }[] = [];
    for (const r of body.lines) {
      const line = byId.get(r.lineId!);
      if (!line) throw new NotFoundException('Order line not found');
      const movable = line.quantity - line.qtyFulfilled - line.qtyReturned;
      const qty = r.quantity ?? movable;
      if (!Number.isInteger(qty) || qty <= 0 || qty > movable) {
        throw new BadRequestException(
          `Line "${line.description}" has ${Math.max(movable, 0)} movable unit(s) — delivered units stay with the original order`,
        );
      }
      moves.push({ line, quantity: qty });
    }
    const movesEverything = allLines.every((l) => {
      const m = moves.find((x) => x.line.id === l.id);
      return m ? m.quantity === l.quantity : false;
    });
    if (movesEverything) {
      throw new BadRequestException(
        "Moving every line is not a split — change this order's promised date instead",
      );
    }

    const newOrder = await this.executeSplit(
      tenant,
      actor,
      order,
      moves,
      body.requestedDate ?? null,
    );
    return { order: await this.loadDetail(id), newOrder };
  }

  /**
   * Move an overpayment onto another of the customer's orders — the
   * companion action to the credit state on the Money card (handoff
   * 2026-08-30). Typically used across a split family, but any live
   * order of the same customer qualifies. Moves at most
   * min(this order's credit, the target's balance due).
   */
  @Post('orders/:id/move-credit')
  @RequirePermission('orders.deposit.take')
  async moveCredit(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { toOrderId?: string },
  ): Promise<OrderDetail> {
    if (!body.toOrderId) throw new BadRequestException('toOrderId is required');
    if (body.toOrderId === id) {
      throw new BadRequestException('toOrderId must be a different order');
    }
    const order = await this.requireLiveOrder(id);
    const target = await this.requireLiveOrder(body.toOrderId);
    if (target.customerId !== order.customerId) {
      throw new BadRequestException("Credit can only move between one customer's own orders");
    }
    const [fromPayments, toPayments] = await Promise.all([
      this.db
        .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
        .from(schema.payments)
        .where(eq(schema.payments.orderId, id)),
      this.db
        .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
        .from(schema.payments)
        .where(eq(schema.payments.orderId, target.id)),
    ]);
    const creditCents = paidCents(fromPayments) - order.totalCents;
    if (creditCents <= 0) throw new BadRequestException('This order has no credit to move');
    const targetDue = balanceDueCents(target.totalCents, toPayments);
    if (targetDue <= 0) throw new BadRequestException(`${target.number} has no balance due`);
    const amountCents = Math.min(creditCents, targetDue);
    await this.movePayments(id, target.id, amountCents);
    await this.audit.log({
      action: 'order.credit.move',
      targetType: 'order',
      targetId: id,
      after: { toOrderId: target.id, toNumber: target.number, amountCents },
    });
    await this.audit.log({
      action: 'order.credit.move',
      targetType: 'order',
      targetId: target.id,
      after: { fromOrderId: id, fromNumber: order.number, amountCents },
    });
    await this.ticketFlags.applyEdit(
      target.id,
      { kind: 'header_change', field: 'deposit' },
      'order.payment',
    );
    return this.loadDetail(id);
  }

  /**
   * Split numbering (owner ask 2026-08-30): the pieces keep the base
   * document number with a letter suffix — SO-2026-000016 splits into
   * SO-2026-000016-A, then -B, and so on. Splitting a suffixed order
   * strips its own letter first so the family shares one base.
   */
  private async nextSplitNumber(businessId: string, sourceNumber: string): Promise<string> {
    const base = sourceNumber.replace(/-[A-Z]$/, '');
    const rows = await this.db
      .select({ number: schema.orders.number })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          sql`${schema.orders.number} LIKE ${`${base}-%`}`,
        ),
      );
    const used = new Set(rows.map((r) => r.number));
    for (let i = 0; i < 26; i++) {
      const candidate = `${base}-${String.fromCharCode(65 + i)}`;
      if (!used.has(candidate)) return candidate;
    }
    throw new BadRequestException('Too many splits of this order');
  }

  /**
   * Orders sharing one split family: the base document number plus its
   * letter-suffixed siblings (SO-2026-000016, -A, -B, ...), excluding
   * `excludeId`, ordered base first then A, B, ...
   */
  private async splitFamily(
    businessId: string,
    number: string,
    excludeId: string,
  ): Promise<(typeof schema.orders.$inferSelect)[]> {
    const base = number.replace(/-[A-Z]$/, '');
    const rows = await this.db
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          or(eq(schema.orders.number, base), sql`${schema.orders.number} LIKE ${`${base}-_`}`),
        ),
      );
    return rows.filter((r) => r.id !== excludeId).sort((a, b) => a.number.localeCompare(b.number));
  }

  /**
   * Move `amountCents` of collected money from one order to another by
   * re-homing its most recent succeeded payment rows. A row that
   * straddles the boundary is split in two — both halves keep the same
   * method, kind, and processor reference, so the one real card charge
   * stays traceable from either order (handoff 2026-08-30).
   */
  private async movePayments(
    fromOrderId: string,
    toOrderId: string,
    amountCents: number,
  ): Promise<{ movedCents: number }> {
    const rows = await this.db
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.orderId, fromOrderId), eq(schema.payments.status, 'succeeded')))
      .orderBy(desc(schema.payments.createdAt));
    let remaining = amountCents;
    for (const p of rows) {
      if (remaining <= 0) break;
      if (p.amountCents <= remaining) {
        await this.db
          .update(schema.payments)
          .set({ orderId: toOrderId })
          .where(eq(schema.payments.id, p.id));
        remaining -= p.amountCents;
      } else {
        await this.db
          .update(schema.payments)
          .set({ amountCents: p.amountCents - remaining })
          .where(eq(schema.payments.id, p.id));
        await this.db.insert(schema.payments).values({
          businessId: p.businessId,
          saleId: null,
          orderId: toOrderId,
          kind: p.kind,
          method: p.method,
          amountCents: remaining,
          processor: p.processor,
          processorRef: p.processorRef,
          financingProvider: p.financingProvider,
          financingRef: p.financingRef,
          status: 'succeeded',
          createdAt: p.createdAt,
        });
        remaining = 0;
      }
    }
    return { movedCents: amountCents - remaining };
  }

  /** The mechanics shared by the split endpoint and split-at-sale. */
  private async executeSplit(
    tenant: RequestTenantContext,
    actor: CurrentUserPayload,
    order: typeof schema.orders.$inferSelect,
    moves: { line: typeof schema.orderLines.$inferSelect; quantity: number }[],
    requestedDate: string | null,
    opts: {
      /**
       * Take-with split (owner 2026-08-31): the collected money covers
       * the goods walking out the door FIRST — the child takes
       * min(everything paid, its own total), not just the excess past
       * the parent's total.
       */
      payChildFirst?: boolean;
      /** Override the child's fulfillment type (take-with pieces). */
      fulfillmentType?: string;
    } = {},
  ): Promise<{ id: string; number: string }> {
    const id = order.id;
    // The new order: same customer, store, salespeople, and addresses —
    // only the promised date is its own.
    const number = await this.nextSplitNumber(tenant.businessId!, order.number);
    const newStatus =
      order.status === 'draft' ? 'draft' : order.status === 'quote' ? 'quote' : 'open';
    const [target] = await this.db
      .insert(schema.orders)
      .values({
        businessId: tenant.businessId!,
        locationId: order.locationId,
        stockLocationId: order.stockLocationId,
        number,
        status: newStatus,
        customerId: order.customerId,
        salespersonMembershipId: order.salespersonMembershipId,
        secondSalespersonMembershipId: order.secondSalespersonMembershipId,
        splitBps: order.splitBps,
        orderKind: order.orderKind,
        fulfillmentType: opts.fulfillmentType ?? order.fulfillmentType,
        deliveryInstructions: order.deliveryInstructions,
        pickupLocationId: order.pickupLocationId,
        billingAddressJson: order.billingAddressJson as never,
        marketingCode: order.marketingCode,
        addressLine1: order.addressLine1,
        addressLine2: order.addressLine2,
        addressCity: order.addressCity,
        addressRegion: order.addressRegion,
        addressPostalCode: order.addressPostalCode,
        addressPhone: order.addressPhone,
        requestedDate: requestedDate,
        notes: `Split from ${order.number}`,
      })
      .returning();
    if (!target) throw new BadRequestException('failed to create the split order');

    for (const m of moves) {
      // Free the moved units' commitment at the line's effective source…
      const releaseQty = Math.min(m.line.qtyReserved, m.quantity);
      if (m.line.variantId && releaseQty > 0) {
        await this.orders.applyReleases(this.db, {
          businessId: tenant.businessId!,
          orderId: id,
          locationId: m.line.sourceLocationId ?? order.stockLocationId ?? order.locationId,
          actorUserId: actor?.id ?? null,
          releases: [{ orderLineId: m.line.id, variantId: m.line.variantId, quantity: releaseQty }],
          updateLines: true,
        });
      }
      // …write the moved units onto the new order (discount travels
      // proportionally)…
      const discountShare = Math.round((m.line.discountCents * m.quantity) / m.line.quantity);
      await this.db.insert(schema.orderLines).values({
        businessId: tenant.businessId!,
        orderId: target.id,
        variantId: m.line.variantId,
        description: m.line.description,
        quantity: m.quantity,
        lineType: m.line.lineType,
        unitPriceCents: m.line.unitPriceCents,
        discountCents: discountShare,
        taxRateBps: m.line.taxRateBps,
        taxClassId: m.line.taxClassId,
        sourceLocationId: m.line.sourceLocationId,
        fulfillmentMethod: m.line.fulfillmentMethod,
        serialUnitIds: null,
        taxCents: 0,
        totalCents: 0,
      });
      // …and shrink or drop the source line.
      if (m.quantity === m.line.quantity) {
        await this.db.delete(schema.orderLines).where(eq(schema.orderLines.id, m.line.id));
      } else {
        await this.db
          .update(schema.orderLines)
          .set({
            quantity: m.line.quantity - m.quantity,
            discountCents: m.line.discountCents - discountShare,
          })
          .where(eq(schema.orderLines.id, m.line.id));
      }
    }

    const parentTotals = await this.orders.recomputeTotals(this.db, id);
    const targetTotals = await this.orders.recomputeTotals(this.db, target.id);

    // Splitting must never change what the customer owes in total
    // (handoff 2026-08-30). Per-line rounding and the order-discount
    // pro-rata can drift the combined figure by a cent or two — pin any
    // drift onto the new order so parent + child always equal the
    // pre-split total.
    let childTotalCents = targetTotals.totalCents;
    const driftCents = order.totalCents - (parentTotals.totalCents + targetTotals.totalCents);
    if (driftCents !== 0) {
      childTotalCents += driftCents;
      await this.db
        .update(schema.orders)
        .set({
          taxCents: Math.max(0, targetTotals.taxCents + driftCents),
          totalCents: childTotalCents,
          updatedAt: new Date(),
        })
        .where(eq(schema.orders.id, target.id));
    }

    // Money follows the goods: whatever was already collected past the
    // parent's new (smaller) total covers the moved lines, so that
    // excess moves with them — a fully-paid order splits into two
    // fully-paid orders, never an overpaid parent plus an unpaid child.
    const collectedRows = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, id));
    const collectedCents = paidCents(collectedRows);
    const moveCents = opts.payChildFirst
      ? Math.min(collectedCents, childTotalCents)
      : Math.min(Math.max(0, collectedCents - parentTotals.totalCents), childTotalCents);
    let movedPaymentsCents = 0;
    if (moveCents > 0) {
      movedPaymentsCents = (await this.movePayments(id, target.id, moveCents)).movedCents;
    }

    // Each piece asks for the policy deposit on ITS total from here on —
    // the parent keeping the combined order's deposit line is how an $18
    // fee order ends up "requiring" a $73 deposit.
    await this.db
      .update(schema.orders)
      .set({
        depositRequiredCents: defaultDepositCents(
          parentTotals.totalCents,
          DEFAULT_DEPOSIT_RATE_BPS,
        ),
        updatedAt: new Date(),
      })
      .where(eq(schema.orders.id, id));
    await this.db
      .update(schema.orders)
      .set({
        depositRequiredCents: defaultDepositCents(childTotalCents, DEFAULT_DEPOSIT_RATE_BPS),
        updatedAt: new Date(),
      })
      .where(eq(schema.orders.id, target.id));

    if (newStatus === 'open') {
      await this.orders.reserveOrder(this.db, {
        businessId: tenant.businessId!,
        orderId: target.id,
        locationId: target.stockLocationId ?? target.locationId,
        actorUserId: actor?.id ?? null,
      });
    }

    const movedSummary = moves.map((m) => ({
      lineId: m.line.id,
      variantId: m.line.variantId,
      description: m.line.description,
      quantity: m.quantity,
    }));
    await this.audit.log({
      action: 'order.split',
      targetType: 'order',
      targetId: id,
      after: { toOrderId: target.id, toNumber: number, lines: movedSummary, movedPaymentsCents },
    });
    await this.audit.log({
      action: 'order.split',
      targetType: 'order',
      targetId: target.id,
      after: { fromOrderId: id, fromNumber: order.number, lines: movedSummary, movedPaymentsCents },
    });
    void this.webhooks.fire({
      businessId: tenant.businessId!,
      eventType: 'order.split',
      payload: {
        orderId: id,
        orderNumber: order.number,
        newOrderId: target.id,
        newOrderNumber: number,
        lines: movedSummary,
      },
    });

    return { id: target.id, number };
  }

  /**
   * Release ONE line's reservation (owner ask 2026-08-30, reached from
   * the inventory page's reserved drill-down): the committed units go
   * back to sellable stock so another order can take them; this order's
   * line stays, unreserved, to be re-committed later (Reserve on the
   * order page, or the nightly allocator when stock returns).
   */
  @Post('orders/:id/lines/:lineId/release')
  @RequirePermission('orders.update')
  async releaseLine(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ): Promise<OrderDetail> {
    const order = await this.requireLiveOrder(id);
    this.assertUnlocked(order);
    await this.assertNotOnOpenRun(id);
    const [line] = await this.db
      .select()
      .from(schema.orderLines)
      .where(and(eq(schema.orderLines.id, lineId), eq(schema.orderLines.orderId, id)))
      .limit(1);
    if (!line) throw new NotFoundException('Order line not found');
    if (!line.variantId || line.qtyReserved <= 0) {
      throw new BadRequestException('This line has no reserved units to release');
    }
    await this.orders.applyReleases(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
      locationId: line.sourceLocationId ?? order.stockLocationId ?? order.locationId,
      actorUserId: actor?.id ?? null,
      releases: [{ orderLineId: line.id, variantId: line.variantId, quantity: line.qtyReserved }],
      updateLines: true,
    });
    await this.audit.log({
      action: 'order.line.release',
      targetType: 'order',
      targetId: id,
      after: { lineId, variantId: line.variantId, released: line.qtyReserved },
    });
    return this.loadDetail(id);
  }

  /**
   * PO-060: the line type must be changeable on an open order line —
   * stock that will never arrive (store closing, consignment) or an
   * exchange replacement flips to `direct_ship` and the vendor ships to
   * the customer. Switching away from stock releases the reservation;
   * switching to stock tries to reserve. Refused once units are
   * fulfilled or a PO already carries the line.
   */
  /**
   * Edit one line in place (owner 2026-08-31: order lines look and work
   * like New Sale's). Besides the PO-060 line-type flip, this accepts
   * quantity, unit price, line discount, per-line fulfillment method,
   * fulfill-from location, and per-line promised date. Reservations
   * follow the edit: shrinking a quantity releases the excess, growing
   * one (or moving the source) re-reserves what the line lacks, and
   * money edits reprice the order and run the A10 price monitor.
   */
  @Patch('orders/:id/lines/:lineId')
  @RequirePermission('orders.update')
  async updateLine(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body()
    body: LineEditBody & { lineType?: string },
  ): Promise<OrderDetail> {
    const order = await this.requireLiveOrder(id);
    // A20: line details (comment, room, pieces, prep codes, COM, direct-ship
    // details, install flag, description) are truck-safe metadata — they
    // pass the print lock the way notes do (G9).
    const metadataOnly = Object.keys(body).every((k) => LINE_METADATA_FIELDS.has(k));
    if (!metadataOnly) {
      this.assertUnlocked(order);
      await this.assertNotOnOpenRun(id);
    }
    const [line] = await this.db
      .select()
      .from(schema.orderLines)
      .where(and(eq(schema.orderLines.id, lineId), eq(schema.orderLines.orderId, id)))
      .limit(1);
    if (!line) throw new NotFoundException('Order line not found');

    if (body.lineType === undefined) return this.editLineFields(tenant, actor, order, line, body);

    const allowed = ['stock', 'special_order', 'direct_ship'];
    if (!allowed.includes(body.lineType)) {
      throw new BadRequestException(`lineType must be one of ${allowed.join(', ')}`);
    }
    if (line.lineType === body.lineType) return this.loadDetail(id);
    if (!line.variantId || line.lineType === 'custom') {
      throw new BadRequestException('Custom lines have no stock type to change');
    }
    if (line.qtyFulfilled > 0) {
      throw new BadRequestException(
        'Cannot change the type of a line that has already been fulfilled',
      );
    }
    const allocations = await this.db
      .select({ id: schema.poLineAllocations.id })
      .from(schema.poLineAllocations)
      .where(
        and(
          eq(schema.poLineAllocations.orderLineId, lineId),
          sql`${schema.poLineAllocations.status} != 'cancelled'`,
        ),
      )
      .limit(1);
    if (allocations.length > 0) {
      throw new BadRequestException(
        'A purchase order already carries this line — cancel or un-receive it first',
      );
    }

    if (line.qtyReserved > 0 && body.lineType !== 'stock') {
      await this.orders.applyReleases(this.db, {
        businessId: tenant.businessId!,
        orderId: id,
        locationId: line.sourceLocationId ?? order.stockLocationId ?? order.locationId,
        actorUserId: actor?.id ?? null,
        releases: [{ orderLineId: line.id, variantId: line.variantId, quantity: line.qtyReserved }],
      });
    }
    await this.db
      .update(schema.orderLines)
      .set({ lineType: body.lineType })
      .where(eq(schema.orderLines.id, lineId));
    if (body.lineType === 'stock' && order.status !== 'quote') {
      await this.orders.reserveOrder(this.db, {
        businessId: tenant.businessId!,
        orderId: id,
        locationId: order.stockLocationId ?? order.locationId,
        actorUserId: actor?.id ?? null,
      });
    }
    await this.audit.log({
      action: 'order.line.line_type',
      targetType: 'order',
      targetId: id,
      before: { lineId, lineType: line.lineType },
      after: { lineType: body.lineType },
    });
    return this.loadDetail(id);
  }

  /** The field-editor half of updateLine (everything except lineType). */
  private async editLineFields(
    tenant: RequestTenantContext,
    actor: CurrentUserPayload,
    order: typeof schema.orders.$inferSelect,
    line: typeof schema.orderLines.$inferSelect,
    body: LineEditBody,
  ): Promise<OrderDetail> {
    const patch: Partial<typeof schema.orderLines.$inferInsert> = {};
    const before: Record<string, unknown> = { lineId: line.id };
    const after: Record<string, unknown> = {};
    let repriced = false;
    let sourceChanged = false;

    // A20 line details — metadata only, never money.
    const setMeta = <K extends keyof typeof patch>(key: K, next: (typeof patch)[K]) => {
      const prev = (line as Record<string, unknown>)[key as string];
      if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) return;
      patch[key] = next;
      before[key as string] = prev ?? null;
      after[key as string] = next ?? null;
    };
    if (body.description !== undefined) {
      const d = a20Text('description', body.description, 300);
      if (!d) throw new BadRequestException('description cannot be blank');
      setMeta('description', d);
    }
    if (body.comment !== undefined) setMeta('comment', a20Text('comment', body.comment, 1000));
    if (body.room !== undefined) setMeta('room', a20Text('room', body.room, 60));
    if (body.pieces !== undefined) {
      if (
        body.pieces !== null &&
        (!Number.isInteger(body.pieces) || body.pieces < 1 || body.pieces > 99)
      ) {
        throw new BadRequestException('pieces must be 1–99 or null');
      }
      setMeta('pieces', body.pieces);
    }
    if (body.prepCodes !== undefined) setMeta('prepCodes', a20Codes('prepCodes', body.prepCodes));
    if (body.com !== undefined) {
      const com = body.com;
      if (com != null && (typeof com !== 'object' || Array.isArray(com))) {
        throw new BadRequestException('com must be an object or null');
      }
      const desc = com ? a20Text('com.description', com.description, 500) : null;
      setMeta('comJson', com ? ({ supplied: true, description: desc } as never) : null);
    }
    if (body.directShip !== undefined) {
      const ds = body.directShip;
      if (ds != null && (typeof ds !== 'object' || Array.isArray(ds))) {
        throw new BadRequestException('directShip must be an object or null');
      }
      const o = (ds ?? {}) as Record<string, unknown>;
      const expected = a20Text('directShip.expectedDate', o.expectedDate, 10);
      if (expected && !/^\d{4}-\d{2}-\d{2}$/.test(expected)) {
        throw new BadRequestException('directShip.expectedDate must be YYYY-MM-DD');
      }
      const next = ds
        ? {
            vendorName: a20Text('directShip.vendorName', o.vendorName, 120),
            vendorOrderRef: a20Text('directShip.vendorOrderRef', o.vendorOrderRef, 80),
            trackingNumber: a20Text('directShip.trackingNumber', o.trackingNumber, 80),
            expectedDate: expected,
          }
        : null;
      setMeta(
        'directShipJson',
        next && Object.values(next).some((x) => x) ? (next as never) : null,
      );
    }
    if (body.needsInstall !== undefined) {
      if (typeof body.needsInstall !== 'boolean') {
        throw new BadRequestException('needsInstall must be a boolean');
      }
      setMeta('needsInstall', body.needsInstall);
    }

    if (body.quantity !== undefined) {
      if (!Number.isInteger(body.quantity) || body.quantity < 1) {
        throw new BadRequestException('quantity must be a positive integer');
      }
      if (body.quantity < line.qtyFulfilled) {
        throw new BadRequestException(
          `quantity cannot go below the ${line.qtyFulfilled} already fulfilled`,
        );
      }
      if (body.quantity !== line.quantity) {
        patch.quantity = body.quantity;
        before.quantity = line.quantity;
        after.quantity = body.quantity;
        repriced = true;
      }
    }
    if (body.unitPriceCents !== undefined) {
      if (!Number.isInteger(body.unitPriceCents) || body.unitPriceCents < 0) {
        throw new BadRequestException('unitPriceCents must be a non-negative integer');
      }
      if (body.unitPriceCents !== line.unitPriceCents) {
        patch.unitPriceCents = body.unitPriceCents;
        before.unitPriceCents = line.unitPriceCents;
        after.unitPriceCents = body.unitPriceCents;
        repriced = true;
      }
    }
    if (body.lineDiscountCents !== undefined) {
      if (!Number.isInteger(body.lineDiscountCents) || body.lineDiscountCents < 0) {
        throw new BadRequestException('lineDiscountCents must be a non-negative integer');
      }
      if (body.lineDiscountCents !== line.discountCents) {
        patch.discountCents = body.lineDiscountCents;
        before.lineDiscountCents = line.discountCents;
        after.lineDiscountCents = body.lineDiscountCents;
        repriced = true;
      }
    }
    {
      const qty = patch.quantity ?? line.quantity;
      const unit = patch.unitPriceCents ?? line.unitPriceCents;
      const disc = patch.discountCents ?? line.discountCents;
      if (disc > qty * unit) {
        throw new BadRequestException('lineDiscountCents cannot exceed the line subtotal');
      }
    }
    if (body.fulfillmentMethod !== undefined) {
      const fm = body.fulfillmentMethod || null;
      if (fm !== null && !FULFILLMENT_TYPES.includes(fm as (typeof FULFILLMENT_TYPES)[number])) {
        throw new BadRequestException(
          `fulfillmentMethod must be one of ${FULFILLMENT_TYPES.join(', ')} or null`,
        );
      }
      if (fm !== line.fulfillmentMethod) {
        patch.fulfillmentMethod = fm;
        before.fulfillmentMethod = line.fulfillmentMethod;
        after.fulfillmentMethod = fm;
      }
    }
    if (body.deliveryDate !== undefined) {
      const dd = body.deliveryDate || null;
      if (dd !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dd)) {
        throw new BadRequestException('deliveryDate must be YYYY-MM-DD or null');
      }
      if (dd !== line.deliveryDate) {
        patch.deliveryDate = dd;
        before.deliveryDate = line.deliveryDate;
        after.deliveryDate = dd;
      }
    }
    if (body.sourceLocationId !== undefined) {
      if (line.lineType === 'custom') {
        throw new BadRequestException('Custom lines have no fulfill-from location');
      }
      const src = body.sourceLocationId || null;
      if (src !== null) {
        const [loc] = await this.db
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(eq(schema.locations.id, src))
          .limit(1);
        if (!loc) throw new NotFoundException('Line source location not found');
      }
      if (src !== line.sourceLocationId) {
        patch.sourceLocationId = src;
        before.sourceLocationId = line.sourceLocationId;
        after.sourceLocationId = src;
        sourceChanged = true;
      }
    }

    if (Object.keys(after).length === 0) return this.loadDetail(order.id);

    // A10 price monitor: a live-order price cut is logged (never
    // blocked) against the variant's list price, like New Sale.
    if (repriced && line.variantId && order.status !== 'draft') {
      const [variant] = await this.db
        .select({
          priceCents: schema.productVariants.priceCents,
          costCents: schema.productVariants.costCents,
        })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, line.variantId))
        .limit(1);
      if (variant) {
        await this.priceVariance.enforce(
          tenant.businessId!,
          [
            {
              quantity: patch.quantity ?? line.quantity,
              unitPriceCents: patch.unitPriceCents ?? line.unitPriceCents,
              lineDiscountCents: patch.discountCents ?? line.discountCents,
              lineType: line.lineType,
              listPriceCents: variant.priceCents,
              costCents: variant.costCents ?? null,
              description: line.description,
            },
          ],
          0,
          body,
          { action: `Edit line on ${order.number}`, entityType: 'order', entityId: order.id },
        );
      }
    }

    // Reservations follow the edit: moving the source releases the
    // line's whole hold (it re-reserves at the new source below);
    // shrinking the quantity releases just the excess. Both must land
    // before the row update so the reserved-range check holds.
    const targetQty = patch.quantity ?? line.quantity;
    const releaseQty = sourceChanged ? line.qtyReserved : Math.max(0, line.qtyReserved - targetQty);
    if (line.variantId && releaseQty > 0) {
      await this.orders.applyReleases(this.db, {
        businessId: tenant.businessId!,
        orderId: order.id,
        locationId: line.sourceLocationId ?? order.stockLocationId ?? order.locationId,
        actorUserId: actor?.id ?? null,
        releases: [{ orderLineId: line.id, variantId: line.variantId, quantity: releaseQty }],
      });
    }

    await this.db.update(schema.orderLines).set(patch).where(eq(schema.orderLines.id, line.id));
    if (repriced) await this.orders.recomputeTotals(this.db, order.id);
    if (
      line.variantId &&
      line.lineType === 'stock' &&
      order.status !== 'quote' &&
      order.status !== 'draft' &&
      (sourceChanged || targetQty > line.quantity)
    ) {
      await this.orders.reserveOrder(this.db, {
        businessId: tenant.businessId!,
        orderId: order.id,
        locationId: order.stockLocationId ?? order.locationId,
        actorUserId: actor?.id ?? null,
      });
    }

    await this.audit.log({
      action: 'order.line.update',
      targetType: 'order',
      targetId: order.id,
      before,
      after,
    });
    return this.loadDetail(order.id);
  }

  /**
   * Commit stock to the order. Safe to call repeatedly — only the units a
   * line still lacks are ever reserved — which is what makes it usable as
   * a "try again now that the truck arrived" action.
   *
   * Anything stock can't cover comes back as a shortfall rather than an
   * error: the order is still valid, those units just have to be bought
   * (the Day 4 special-order queue).
   */
  @Post('orders/:id/reserve')
  @RequirePermission('orders.update')
  async reserve(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<{ order: OrderDetail; shortfalls: { orderLineId: string; quantity: number }[] }> {
    const order = await this.requireLiveOrder(id);
    const plan = await this.orders.reserveOrder(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
      locationId: order.stockLocationId ?? order.locationId,
      actorUserId: actor?.id ?? null,
    });

    if (order.status === 'quote' && plan.reservations.length > 0) {
      await this.db
        .update(schema.orders)
        .set({ status: 'open', updatedAt: new Date() })
        .where(eq(schema.orders.id, id));
    }

    await this.audit.log({
      action: 'order.reserve',
      targetType: 'order',
      targetId: id,
      after: {
        reserved: plan.reservations.reduce((s, r) => s + r.quantity, 0),
        short: plan.shortfalls.reduce((s, r) => s + r.quantity, 0),
      },
    });

    // XFR-051: cover what this store can't from a sister store's free
    // stock (no-op while ops.autoScheduleDays is blank; dedupes against
    // open auto transfers already written for this order).
    await this.autoTransfers.generateForShortfalls(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
      orderNumber: order.number,
      locationId: order.stockLocationId ?? order.locationId,
      shortfalls: plan.shortfalls,
      actorUserId: actor?.id ?? null,
    });

    return {
      order: await this.loadDetail(id),
      shortfalls: plan.shortfalls.map((s) => ({
        orderLineId: s.orderLineId,
        quantity: s.quantity,
      })),
    };
  }

  /** Hand every committed unit back without cancelling the order. */
  @Post('orders/:id/release')
  @RequirePermission('orders.update')
  async release(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<OrderDetail> {
    const order = await this.requireLiveOrder(id);
    const released = await this.orders.releaseOrder(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
      locationId: order.stockLocationId ?? order.locationId,
      actorUserId: actor?.id ?? null,
    });

    await this.audit.log({
      action: 'order.release',
      targetType: 'order',
      targetId: id,
      after: { released: released.reduce((s, r) => s + r.quantity, 0) },
    });
    return this.loadDetail(id);
  }

  /**
   * Take money against an order. A deposit and a balance payment are the
   * same row with a different `kind` (D2) — which is exactly why the cash
   * drawer picks both up without knowing orders exist.
   */
  @Post('orders/:id/payments')
  @RequirePermission('orders.deposit.take')
  async takePayment(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: OrderPaymentBody,
  ): Promise<OrderDetail> {
    const order = await this.requireLiveOrder(id);

    if (!body.method || !PAYMENT_METHODS.includes(body.method)) {
      throw new BadRequestException(`method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }
    if (
      typeof body.amountCents !== 'number' ||
      !Number.isInteger(body.amountCents) ||
      body.amountCents <= 0
    ) {
      throw new BadRequestException('amountCents must be a positive integer');
    }
    if (body.method === 'financing' && !body.financingProvider) {
      throw new BadRequestException('financing payments must name a financingProvider');
    }

    const existing = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, id));
    const due = balanceDueCents(order.totalCents, existing);

    // One tender can cover a whole split family (SO-..., -A, -B): the
    // register takes a single payment for the combined balance and the
    // money lands on each piece up to what that piece is owed, this order
    // first, then siblings in family order. Anything past the family's
    // combined balance is still refused — over-collecting is a refund
    // problem, not a bigger deposit.
    const allocations: {
      order: typeof order;
      amountCents: number;
      hadMoney: boolean;
    }[] = [];
    let leftover = body.amountCents;
    const firstShare = Math.min(leftover, due);
    if (firstShare > 0) {
      allocations.push({ order, amountCents: firstShare, hadMoney: paidCents(existing) > 0 });
      leftover -= firstShare;
    }
    if (leftover > 0) {
      const family = (await this.splitFamily(tenant.businessId!, order.number, id)).filter((r) =>
        isLiveOrderStatus(r.status),
      );
      for (const sib of family) {
        if (leftover <= 0) break;
        const sibPayments = await this.db
          .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
          .from(schema.payments)
          .where(eq(schema.payments.orderId, sib.id));
        const sibDue = balanceDueCents(sib.totalCents, sibPayments);
        if (sibDue <= 0) continue;
        const take = Math.min(leftover, sibDue);
        allocations.push({ order: sib, amountCents: take, hadMoney: paidCents(sibPayments) > 0 });
        leftover -= take;
      }
      if (leftover > 0) {
        throw new BadRequestException(
          `amountCents (${body.amountCents}) exceeds the balance due (${due})`,
        );
      }
    }

    // Infer the kind: the first money in is the deposit, the rest is
    // balance. An explicit kind (an installment against a plan) wins.
    const kind = body.kind ?? (paidCents(existing) === 0 ? 'deposit' : 'balance');

    // G6 (§5): the layaway minimum deposit ($100, or the full balance if
    // smaller) is enforced at save, not just in the UI. A manager can
    // authorize a smaller deposit at the point of action.
    const LAYAWAY_MIN_DEPOSIT_CENTS = 10000;
    if (
      order.orderKind === 'layaway' &&
      kind === 'deposit' &&
      body.amountCents < Math.min(LAYAWAY_MIN_DEPOSIT_CENTS, due)
    ) {
      await this.overrides.require({
        permission: 'orders.complete_with_balance',
        action: `Layaway deposit below the $100 minimum on ${order.number}`,
        entityType: 'order',
        entityId: id,
        override: (body as { override?: OverrideCredentials }).override,
      });
      await this.exceptions.record({
        type: 'layaway_min_deposit_override',
        severity: 'info',
        entityType: 'order',
        entityId: id,
        summary: `Layaway ${order.number} opened with a $${(body.amountCents / 100).toFixed(2)} deposit (min $100)`,
      });
    }

    // Money down means the customer committed, so a quote becomes an open
    // order and commits its stock here. Taking a deposit is one action at
    // the register, and this keeps the invariant worth having: an order
    // holding money is an order holding its goods. Each order receiving a
    // share of the tender gets its own payment row, audit entry, ticket
    // staleness, and webhook.
    let primaryPaymentId: string | null = null;
    for (const alloc of allocations) {
      const t = alloc.order;
      const allocKind = body.kind ?? (alloc.hadMoney ? 'balance' : 'deposit');
      if (t.status === 'quote') {
        await this.orders.reserveOrder(this.db, {
          businessId: tenant.businessId!,
          orderId: t.id,
          locationId: t.stockLocationId ?? t.locationId,
          actorUserId: actor?.id ?? null,
        });
        await this.db
          .update(schema.orders)
          .set({ status: 'open', updatedAt: new Date() })
          .where(eq(schema.orders.id, t.id));
      }

      const [payment] = await this.db
        .insert(schema.payments)
        .values({
          businessId: tenant.businessId!,
          saleId: null,
          orderId: t.id,
          kind: allocKind,
          method: body.method,
          amountCents: alloc.amountCents,
          processor: body.method === 'card' ? 'manual' : null,
          processorRef: body.processorRef ?? null,
          financingProvider: body.financingProvider ?? null,
          financingRef: body.financingRef ?? null,
          status: 'succeeded',
        })
        .returning();
      if (t.id === id) primaryPaymentId = payment!.id;

      // §10: store credit is a real ledger — the tender checks the
      // customer's balance and writes the redemption (throws 400 when the
      // balance can't cover it, before any of this commits… the request
      // transaction rolls the payment row back with it).
      if (body.method === 'store_credit') {
        await this.storeCredit.redeem(this.db, {
          businessId: tenant.businessId!,
          customerId: t.customerId,
          amountCents: alloc.amountCents,
          referenceType: 'payment',
          referenceId: payment!.id,
          actorUserId: actor?.id ?? null,
        });
      }

      await this.audit.log({
        action: 'order.payment.take',
        targetType: 'order',
        targetId: t.id,
        after: {
          paymentId: payment!.id,
          kind: allocKind,
          method: body.method,
          amountCents: alloc.amountCents,
          ...(t.id === id ? {} : { spilloverFrom: order.number, tenderedCents: body.amountCents }),
        },
      });

      // R8 (erp-delivery-reprints): a deposit of any kind on an order with
      // printed delivery tickets stales them all.
      await this.ticketFlags.applyEdit(
        t.id,
        { kind: 'header_change', field: 'deposit' },
        'order.payment',
      );

      if (t.id !== id) {
        const sibDetail = await this.loadDetail(t.id);
        this.fireOrderEvent('order.payment_received', tenant.businessId!, sibDetail, {
          paymentId: payment!.id,
          kind: allocKind,
          method: body.method,
          amountCents: alloc.amountCents,
        });
      }
    }

    const detail = await this.loadDetail(id);
    if (primaryPaymentId) {
      this.fireOrderEvent('order.payment_received', tenant.businessId!, detail, {
        paymentId: primaryPaymentId,
        kind,
        method: body.method,
        amountCents: allocations.find((a) => a.order.id === id)?.amountCents ?? 0,
      });
    }
    return detail;
  }

  /**
   * Cancel an order and release everything it holds. Refusing to cancel
   * an order that has collected money is deliberate: that money has to be
   * refunded or moved first, and silently orphaning it would leave the
   * drawer out of balance.
   */
  /**
   * Pickup fulfillment: the customer takes the goods over the counter, no
   * truck involved. Same stock semantics as a delivered delivery. Omitted
   * lines → everything still owed.
   */
  @Post('orders/:id/fulfill')
  @RequirePermission('deliveries.complete')
  async fulfill(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { lines?: { orderLineId?: string; quantity?: number }[] },
  ): Promise<OrderDetail> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'quote') {
      throw new BadRequestException('Confirm the order before fulfilling it');
    }
    if (order.completedAt || order.cancelledAt) {
      throw new BadRequestException('This order is closed');
    }

    const allLines = await this.db
      .select({
        id: schema.orderLines.id,
        variantId: schema.orderLines.variantId,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
        lineType: schema.orderLines.lineType,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, id));
    // PO-060: direct-ship lines fulfill through their vendor PO receipt,
    // never over the counter — there is no stock here to hand out.
    const lines = allLines.filter((l) => l.lineType !== 'direct_ship');

    const requests: FulfillmentRequest[] =
      body.lines && body.lines.length > 0
        ? body.lines.map((l) => ({
            orderLineId: String(l.orderLineId ?? ''),
            quantity: Number(l.quantity ?? 0),
          }))
        : remainingFulfillment(lines);
    if (requests.length === 0) throw new BadRequestException('Nothing left to fulfill');
    const plan = planFulfillment(lines, requests);
    if (plan.errors.length > 0) throw new BadRequestException(plan.errors.join('; '));

    await this.orders.applyFulfillment(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
      locationId: order.stockLocationId ?? order.locationId,
      actorUserId: actor?.id ?? null,
      steps: plan.steps,
    });
    const after = await this.db
      .select({
        quantity: schema.orderLines.quantity,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, id));
    await this.db
      .update(schema.orders)
      .set({ status: deriveFulfillmentStatus(after), updatedAt: new Date() })
      .where(eq(schema.orders.id, id));

    await this.audit.log({
      action: 'order.fulfill',
      targetType: 'order',
      targetId: id,
      after: { units: plan.steps.reduce((s, x) => s + x.quantity, 0), mode: 'pickup' },
    });
    return this.loadDetail(id);
  }

  /**
   * Close the book on an order. Requires every unit fulfilled, and the
   * money in — a balance due needs either zero or the explicit
   * `orders.complete_with_balance` permission (AR, G8). Whatever tiny
   * reservation residue remains (a cancelled line's units, a shortfall
   * that never arrived) is released so the stock ledger ends clean.
   */
  @Post('orders/:id/complete')
  @RequirePermission('orders.deposit.take')
  async complete(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { allowBalance?: boolean },
  ): Promise<
    OrderDetail & {
      takeWith?: { orderId: string; number: string; completed: boolean; reason: string | null };
    }
  > {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    if (order.completedAt) throw new BadRequestException('Order is already completed');
    if (order.cancelledAt) throw new BadRequestException('A cancelled order cannot be completed');

    // Take-with hand-over (owner 2026-08-31): hitting Complete on a live
    // order that still carries take-with lines splits them off to a -A
    // sibling (money collected covers the walking goods first) and
    // completes that piece on the spot when its stock is reserved and
    // its money is in. A short or unpaid piece stays open — never an
    // error — and finishes with one click here once inventory is
    // adjusted in. This replaces the per-line hand-over button.
    if (['open', 'partially_fulfilled'].includes(order.status)) {
      const lines = await this.db
        .select()
        .from(schema.orderLines)
        .where(eq(schema.orderLines.orderId, id));
      const isTakeWith = (l: (typeof lines)[number]) =>
        l.lineType !== 'direct_ship' &&
        (l.fulfillmentMethod ?? order.fulfillmentType) === 'take_with';
      const twLines = lines.filter(isTakeWith);
      const rest = lines.filter((l) => !isTakeWith(l));
      if (twLines.length > 0) {
        this.assertUnlocked(order);
        await this.assertNotOnOpenRun(id);
        let piece = order;
        if (rest.length > 0) {
          const moves = twLines
            .map((line) => ({
              line,
              quantity: line.quantity - line.qtyFulfilled - line.qtyReturned,
            }))
            .filter((m) => m.quantity > 0);
          if (moves.length === 0) {
            throw new BadRequestException('Every take-with unit is already handed over');
          }
          const sp = await this.executeSplit(tenant, actor, order, moves, null, {
            payChildFirst: true,
            fulfillmentType: 'take_with',
          });
          const [created] = await this.db
            .select()
            .from(schema.orders)
            .where(eq(schema.orders.id, sp.id))
            .limit(1);
          piece = created!;
        }
        const outcome = await this.tryCompleteTakeWith(tenant, actor, piece.id);
        const detail = await this.loadDetail(id);
        return {
          ...detail,
          takeWith: {
            orderId: piece.id,
            number: piece.number,
            completed: outcome.completed,
            reason: outcome.reason,
          },
        };
      }
    }

    if (order.status !== 'fulfilled') {
      throw new BadRequestException('Deliver or hand over every unit before completing the order');
    }

    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, id));
    const due = balanceDueCents(order.totalCents, payments);
    if (due > 0) {
      if (!body.allowBalance) {
        throw new BadRequestException(
          `Balance due is ${due} cents — collect it, or complete with balance explicitly`,
        );
      }
      if (!tenant.permissions.has('orders.complete_with_balance')) {
        throw new ForbiddenException('You are not allowed to complete an order with a balance due');
      }
    }

    // End clean: any reservation left (shortfall units that never shipped)
    // goes back to the pool.
    await this.orders.releaseOrder(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
      locationId: order.stockLocationId ?? order.locationId,
      actorUserId: actor?.id ?? null,
    });
    await this.db
      .update(schema.orders)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.orders.id, id));

    // Commission accrues at completion (G5), split per split_bps;
    // imported orders never accrue (D8) — enforced in the service.
    await this.commissions.accrueForOrder(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
    });

    await this.audit.log({
      action: 'order.complete',
      targetType: 'order',
      targetId: id,
      after: { balanceDueCents: due, withBalance: due > 0 },
    });
    const detail = await this.loadDetail(id);
    this.fireOrderEvent('order.completed', tenant.businessId!, detail);
    return detail;
  }

  /**
   * Finish a take-with piece: top up its reservation, and when every
   * unit is covered and the money is in, hand the goods over (fulfill)
   * and complete it. When it cannot finish, say exactly why — the order
   * page shows the reason as the waiting banner and the piece stays
   * open for the one-click retry after inventory is adjusted in.
   */
  private async tryCompleteTakeWith(
    tenant: RequestTenantContext,
    actor: CurrentUserPayload,
    pieceId: string,
  ): Promise<{ completed: boolean; reason: string | null }> {
    const [piece] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, pieceId))
      .limit(1);
    if (!piece) return { completed: false, reason: 'take-with piece not found' };

    // Top up first so "adjust inventory, then hit Complete" is one click.
    await this.orders.reserveOrder(this.db, {
      businessId: tenant.businessId!,
      orderId: pieceId,
      locationId: piece.stockLocationId ?? piece.locationId,
      actorUserId: actor?.id ?? null,
    });

    const lines = await this.db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, pieceId));
    const shortUnits = lines
      .filter((l) => l.variantId && l.lineType !== 'custom' && l.lineType !== 'direct_ship')
      .reduce((n, l) => n + Math.max(0, l.quantity - l.qtyFulfilled - l.qtyReserved), 0);
    if (shortUnits > 0) {
      return {
        completed: false,
        reason:
          `${shortUnits} unit(s) not in stock at the source location — a user with inventory ` +
          'access must adjust them in, then hit Complete',
      };
    }

    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, pieceId));
    const due = balanceDueCents(piece.totalCents, payments);
    if (due > 0) {
      return {
        completed: false,
        reason: `waiting on payment — $${(due / 100).toFixed(2)} still due`,
      };
    }

    const fulfillable = lines.filter((l) => l.lineType !== 'direct_ship');
    const requests = remainingFulfillment(fulfillable);
    if (requests.length > 0) {
      const plan = planFulfillment(fulfillable, requests);
      if (plan.errors.length > 0) return { completed: false, reason: plan.errors.join('; ') };
      await this.orders.applyFulfillment(this.db, {
        businessId: tenant.businessId!,
        orderId: pieceId,
        locationId: piece.stockLocationId ?? piece.locationId,
        actorUserId: actor?.id ?? null,
        steps: plan.steps,
      });
      const after = await this.db
        .select({
          quantity: schema.orderLines.quantity,
          qtyFulfilled: schema.orderLines.qtyFulfilled,
        })
        .from(schema.orderLines)
        .where(eq(schema.orderLines.orderId, pieceId));
      await this.db
        .update(schema.orders)
        .set({ status: deriveFulfillmentStatus(after), updatedAt: new Date() })
        .where(eq(schema.orders.id, pieceId));
      await this.audit.log({
        action: 'order.fulfill',
        targetType: 'order',
        targetId: pieceId,
        after: { units: plan.steps.reduce((n, x) => n + x.quantity, 0), mode: 'take_with' },
      });
    }
    // The piece is now 'fulfilled' with zero balance, so this lands in
    // complete()'s normal tail (release residue, commissions, webhook).
    await this.complete(tenant, actor, pieceId, {});
    return { completed: true, reason: null };
  }

  /**
   * Create (or return) the order's customer-facing share token. The
   * public page at /track/<token> shows a narrow read-only view;
   * generating is idempotent so re-sharing never invalidates a link a
   * customer already has.
   */
  @Post('orders/:id/share')
  @RequirePermission('orders.view')
  async share(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ token: string; path: string }> {
    const [order] = await this.db
      .select({ id: schema.orders.id, publicToken: schema.orders.publicToken })
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    let token = order.publicToken;
    if (!token) {
      const fresh = randomBytes(24).toString('hex');
      // Guarded write: two staff sharing at once must not overwrite a
      // token whose URL the other response already handed out.
      const [written] = await this.db
        .update(schema.orders)
        .set({ publicToken: fresh, updatedAt: new Date() })
        .where(and(eq(schema.orders.id, id), isNull(schema.orders.publicToken)))
        .returning({ publicToken: schema.orders.publicToken });
      if (written) {
        token = fresh;
        await this.audit.log({
          action: 'order.share_link_created',
          targetType: 'order',
          targetId: id,
        });
      } else {
        const [reread] = await this.db
          .select({ publicToken: schema.orders.publicToken })
          .from(schema.orders)
          .where(eq(schema.orders.id, id))
          .limit(1);
        token = reread?.publicToken ?? fresh;
      }
    }
    return { token, path: `/track/${token}` };
  }

  @Post('orders/:id/cancel')
  @RequirePermission('orders.cancel')
  async cancel(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: CancelOrderBody,
  ): Promise<OrderDetail> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'cancelled') throw new BadRequestException('Order is already cancelled');
    if (order.status === 'completed') {
      throw new BadRequestException('A completed order cannot be cancelled — refund it instead');
    }
    this.assertUnlocked(order);
    await this.assertNotOnOpenRun(id);

    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, id));
    if (paidCents(payments) > 0) {
      throw new ForbiddenException('Refund the money collected on this order before cancelling it');
    }

    await this.orders.releaseOrder(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
      locationId: order.stockLocationId ?? order.locationId,
      actorUserId: actor?.id ?? null,
    });
    await this.db
      .update(schema.orders)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        internalNotes: body.reason
          ? [order.internalNotes, `Cancelled: ${body.reason}`].filter(Boolean).join('\n')
          : order.internalNotes,
        updatedAt: new Date(),
      })
      .where(eq(schema.orders.id, id));

    await this.audit.log({
      action: 'order.cancel',
      targetType: 'order',
      targetId: id,
      before: { status: order.status },
      after: { status: 'cancelled', reason: body.reason ?? null },
    });

    const detail = await this.loadDetail(id);
    this.fireOrderEvent('order.cancelled', tenant.businessId!, detail);
    return detail;
  }

  /**
   * Record an *individual* delivery-ticket print. Per amendment A1 this
   * is the action that locks the order (batch printing never calls
   * this): the ticket is on the truck, so the paper and the system must
   * not diverge. Locking a live order re-stamps `lockedAt` on re-print;
   * finished/cancelled orders can still print (a reprint for the file)
   * without any lock taking effect.
   */
  @Post('orders/:id/delivery-ticket-print')
  @RequirePermission('orders.update')
  async deliveryTicketPrint(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { override?: OverrideCredentials; deliveryId?: string },
  ): Promise<{ lockedAt: Date | null; copyNumber: number }> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');

    if (!isLiveOrderStatus(order.status)) {
      return { lockedAt: order.lockedAt, copyNumber: order.ticketPrintCount };
    }
    // R10 (erp-delivery-reprints): a second-date ticket may only print
    // once the first date's ticket exists and a line qualifies; recorded
    // flags go P for the printed date. Runs before the lock so a refused
    // print changes nothing.
    const flagResult = await this.ticketFlags.recordPrint(id, body.deliveryId);
    if (!flagResult.ok) {
      throw new ConflictException({
        statusCode: 409,
        code: 'SECOND_DATE_NOT_PRINTABLE',
        message:
          'A ticket for this date cannot print yet: the first delivery date must be ticketed first, and a line must qualify (reserved-only second date, or first date fully assigned).',
        date: flagResult.date,
      });
    }

    // G9 / STORIS print preconditions — enforced server-side, reported
    // as a pass/fail checklist so the blocked user knows exactly why.
    const checks: { check: string; ok: boolean; detail: string }[] = [];
    const lines = await this.db
      .select({
        lineType: schema.orderLines.lineType,
        quantity: schema.orderLines.quantity,
        qtyReserved: schema.orderLines.qtyReserved,
        qtyFulfilled: schema.orderLines.qtyFulfilled,
        description: schema.orderLines.description,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, id));
    const shortLines = lines.filter(
      (l) => l.lineType === 'stock' && l.qtyReserved + l.qtyFulfilled < l.quantity,
    );
    checks.push({
      check: 'merchandise_reserved',
      ok: shortLines.length === 0,
      detail:
        shortLines.length === 0
          ? 'All stock lines reserved'
          : `Not reserved: ${shortLines.map((l) => l.description).join(', ')}`,
    });

    if (order.fulfillmentType === 'delivery') {
      const [trip] = await this.db
        .select({ id: schema.deliveries.id })
        .from(schema.deliveries)
        .where(
          and(
            eq(schema.deliveries.orderId, id),
            inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
          ),
        )
        .limit(1);
      checks.push({
        check: 'scheduled_date',
        ok: Boolean(trip),
        detail: trip ? 'Delivery scheduled' : 'No scheduled delivery on this order',
      });
    } else {
      checks.push({
        check: 'scheduled_date',
        ok: Boolean(order.requestedDate),
        detail: order.requestedDate ? `Promised ${order.requestedDate}` : 'No promised date set',
      });
    }

    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, id));
    const balance = Math.max(0, order.totalCents - paidCents(payments));
    const [biz] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    const maxBalance = (
      (biz?.opsSettingsJson ?? {}) as { maxBalanceForTicketPrintCents?: number | null }
    ).maxBalanceForTicketPrintCents;
    const overBalance = maxBalance != null && balance > maxBalance;
    checks.push({
      check: 'balance_cap',
      ok: !overBalance,
      detail: overBalance
        ? `Balance due $${(balance / 100).toFixed(2)} exceeds the $${((maxBalance ?? 0) / 100).toFixed(2)} ticket cap`
        : `Balance due $${(balance / 100).toFixed(2)}`,
    });

    const hardBlocked = checks.some((c) => !c.ok && c.check !== 'balance_cap');
    if (hardBlocked) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PRINT_BLOCKED',
        message: 'The delivery ticket cannot print yet',
        checks,
      });
    }
    if (overBalance) {
      // The balance cap alone has an override path — a manager can
      // release the ticket (STORIS Maximum Balance behavior).
      await this.overrides.require({
        permission: 'orders.complete_with_balance',
        action: `Print delivery ticket for ${order.number} with $${(balance / 100).toFixed(2)} still due`,
        entityType: 'order',
        entityId: id,
        override: body.override,
      });
    }

    const lockedAt = new Date();
    const copyNumber = order.ticketPrintCount + 1;
    await this.db
      .update(schema.orders)
      .set({ lockedAt, ticketPrintCount: copyNumber, relockAt: null, updatedAt: lockedAt })
      .where(eq(schema.orders.id, id));
    await this.audit.log({
      action: 'order.lock',
      targetType: 'order',
      targetId: id,
      metadata: { trigger: 'delivery_ticket_print', copyNumber },
    });
    if (copyNumber > 1) {
      // Reprints are how goods walk out twice — every copy 2+ is on
      // the register.
      await this.exceptions.record({
        type: 'ticket_reprint',
        severity: 'info',
        entityType: 'order',
        entityId: id,
        summary: `Delivery ticket for ${order.number} printed again (copy ${copyNumber})`,
        metadata: { copyNumber },
      });
    }
    return { lockedAt, copyNumber };
  }

  /**
   * Clear the A1 print lock. Gated on `orders.unlock` at the point of
   * action (PLAN-STORIS-GAP §0.1): a user holding the permission
   * proceeds; a user without it gets 403 OVERRIDE_REQUIRED and can
   * retry under an authorized user's credentials — the override is
   * stamped in the security_overrides register with both identities.
   * The reason is coded (class `exception`) once the business has codes
   * defined; free text is the transitional fallback (A9).
   */
  @Post('orders/:id/unlock')
  async unlock(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { reason?: string; reasonCodeId?: string; override?: OverrideCredentials },
  ): Promise<OrderDetail> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    const relockEngaged =
      order.ticketPrintCount > 0 && order.relockAt != null && order.relockAt.getTime() < Date.now();
    if (!order.lockedAt && !relockEngaged) {
      throw new BadRequestException('Order is not locked');
    }
    // A5: while manifested on an open run there is no unlock — the run
    // is the hard lock; pull the order off the run first.
    await this.assertNotOnOpenRun(id);

    const overrideResult = await this.overrides.require({
      permission: 'orders.unlock',
      action: `Unlock printed order ${order.number}`,
      entityType: 'order',
      entityId: id,
      before: { lockedAt: order.lockedAt?.toISOString() ?? 'relock_engaged' },
      after: { lockedAt: null },
      override: body.override,
    });
    const reason = await this.overrides.resolveReason('exception', {
      reasonCodeId: body.reasonCodeId ?? body.override?.reasonCodeId,
      reason: body.reason ?? body.override?.reason,
    });

    await this.db
      .update(schema.orders)
      // G9: the unlock is a 15-minute window — past relockAt the lock
      // lazily re-engages (assertUnlocked derives it, no cron).
      .set({
        lockedAt: null,
        relockAt: new Date(Date.now() + 15 * 60 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(schema.orders.id, id));
    await this.audit.log({
      action: 'order.unlock',
      targetType: 'order',
      targetId: id,
      metadata: {
        reason: reason.reasonText,
        reasonCode: reason.reasonCode,
        ...(overrideResult.overridden
          ? { authorizingUserId: overrideResult.authorizingUserId }
          : {}),
      },
    });
    // G9 escalation: the 3rd unlock on the same order stops being
    // routine — it goes to the register as critical.
    const [unlockCountRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.targetId, id), eq(schema.auditLogs.action, 'order.unlock')));
    const unlockCount = unlockCountRow?.count ?? 1;
    await this.exceptions.record({
      type: 'order_unlock',
      severity: unlockCount >= 3 ? 'critical' : 'warning',
      entityType: 'order',
      entityId: id,
      summary:
        unlockCount >= 3
          ? `Order ${order.number} unlocked for the ${unlockCount}th time — review this order`
          : `Order ${order.number} unlocked after ticket print`,
      metadata: { reason: reason.reasonText, reasonCode: reason.reasonCode, unlockCount },
    });
    return this.loadDetail(id);
  }

  /**
   * §10 / gap A7 return authorization: the return document is written
   * here — lines, per-line coded reasons (class `return`), refund
   * method, RMA number — but no money moves and no inventory changes.
   * The refund fires when the goods are physically received back
   * (`POST /v1/order-returns/:id/receive`). The one exception is a
   * counter drop-off (`fulfillment: 'drop_off'`, the default — goods in
   * hand): authorization and receipt happen in the same request and the
   * refund is immediate, flagged as drop-off on the record.
   */
  @Post('orders/:id/return')
  @RequirePermission('pos.refund.create')
  async returnGoods(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: {
      lines?: { lineId?: string; quantity?: number; reasonCodeId?: string; reason?: string }[];
      refundMethod?: 'original' | 'store_credit';
      fulfillment?: 'drop_off' | 'pickup';
      /** Where the goods land (As-Is staging) on drop-off; defaults to the order's location. */
      returnToLocationId?: string | null;
      reason?: string | null;
      override?: OverrideCredentials;
      /** A22 slice 6 (STORIS Enter a Return): who took it, which store, fees withheld, the pickup stop. */
      salespersonMembershipId?: string | null;
      locationId?: string | null;
      restockingFeeCents?: number;
      pickupFeeCents?: number;
      pickupDate?: string | null;
      pickupWindowStart?: string | null;
      pickupWindowEnd?: string | null;
      pickupNotes?: string | null;
    },
  ): Promise<OrderDetail> {
    if (!body.lines || body.lines.length === 0) {
      throw new BadRequestException('lines must contain at least one entry');
    }
    const fulfillment = body.fulfillment ?? 'drop_off';
    if (!['drop_off', 'pickup'].includes(fulfillment)) {
      throw new BadRequestException('fulfillment must be drop_off or pickup');
    }
    for (const [k, v] of [
      ['restockingFeeCents', body.restockingFeeCents],
      ['pickupFeeCents', body.pickupFeeCents],
    ] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        throw new BadRequestException(`${k} must be a non-negative integer`);
      }
    }
    if (body.pickupDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(body.pickupDate)) {
      throw new BadRequestException('pickupDate must be YYYY-MM-DD');
    }
    if (body.pickupDate && fulfillment !== 'pickup') {
      throw new BadRequestException('pickupDate only applies to a truck pickup');
    }
    if (body.salespersonMembershipId) {
      const [sp] = await this.db
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.id, body.salespersonMembershipId),
            eq(schema.memberships.businessId, tenant.businessId!),
          ),
        )
        .limit(1);
      if (!sp) throw new NotFoundException('Return salesperson not found');
    }
    if (body.locationId) {
      const [loc] = await this.db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.id, body.locationId))
        .limit(1);
      if (!loc) throw new NotFoundException('Return location not found');
    }
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'cancelled' || order.status === 'draft' || order.status === 'quote') {
      throw new BadRequestException(`Cannot return against a ${order.status} order`);
    }

    // I4 (RTN-040): outside the configured return window the return
    // needs `returns.override_window` at the point of action — a
    // manager passes untouched, anyone else retries under a manager's
    // credentials and the override lands in the register.
    const [bizRow] = await this.db
      .select({ opsSettingsJson: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    const windowDays = (bizRow?.opsSettingsJson as { returnWindowDays?: number | null } | null)
      ?.returnWindowDays;
    if (windowDays != null && windowDays > 0) {
      const anchor = order.completedAt ?? order.createdAt;
      const ageDays = (Date.now() - anchor.getTime()) / 86_400_000;
      if (ageDays > windowDays) {
        await this.overrides.require({
          permission: 'returns.override_window',
          action: `Return on ${order.number} — ${Math.floor(ageDays)} days old, outside the ${windowDays}-day window`,
          entityType: 'order',
          entityId: id,
          override: body.override,
        });
      }
    }

    const lines = await this.db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, id));
    const byId = new Map(lines.map((l) => [l.id, l]));

    // Units already spoken for by open (authorized) returns count
    // against what's still returnable.
    const openReturns = await this.db
      .select({
        orderLineId: schema.orderReturnLines.orderLineId,
        quantity: schema.orderReturnLines.quantity,
      })
      .from(schema.orderReturnLines)
      .innerJoin(schema.orderReturns, eq(schema.orderReturns.id, schema.orderReturnLines.returnId))
      .where(
        and(eq(schema.orderReturns.orderId, id), eq(schema.orderReturns.status, 'authorized')),
      );
    const pendingByLine = new Map<string, number>();
    for (const r of openReturns) {
      if (!r.orderLineId) continue;
      pendingByLine.set(r.orderLineId, (pendingByLine.get(r.orderLineId) ?? 0) + r.quantity);
    }

    let amountCents = 0;
    const validated: {
      line: (typeof lines)[number];
      quantity: number;
      perUnit: number;
      reasonCodeId: string | null;
      reason: string | null;
    }[] = [];
    for (const r of body.lines) {
      if (!r.lineId) throw new BadRequestException('lines[].lineId is required');
      const line = byId.get(r.lineId);
      if (!line) throw new NotFoundException(`Order line not found: ${r.lineId}`);
      if (!Number.isInteger(r.quantity) || (r.quantity ?? 0) <= 0) {
        throw new BadRequestException('lines[].quantity must be a positive integer');
      }
      const returnable = line.qtyFulfilled - line.qtyReturned - (pendingByLine.get(line.id) ?? 0);
      if (r.quantity! > returnable) {
        throw new BadRequestException(
          `Cannot return ${r.quantity} of line ${line.id}: only ${returnable} delivered unit(s) remain returnable`,
        );
      }
      // Coded per-line return reason (mandatory once class `return` has
      // codes; the shared free-text reason is the A9 fallback).
      const lineReason = await this.overrides.resolveReason(
        'return',
        { reasonCodeId: r.reasonCodeId, reason: r.reason ?? body.reason ?? null },
        // Owner 2026-08-30: the typed reason suffices — a code is a
        // bonus, never a gate, on returns and exchanges.
        { required: false, codeOptional: true },
      );
      // Refund what the customer actually paid for the unit: the line
      // total plus its tax share (order lines keep tax separately).
      const perUnit = Math.round((line.totalCents + line.taxCents) / line.quantity);
      validated.push({
        line,
        quantity: r.quantity!,
        perUnit,
        reasonCodeId: lineReason.reasonCodeId,
        reason: lineReason.reasonText,
      });
      amountCents += perUnit * r.quantity!;
    }

    // A22 slice 6: restocking and pickup fees come off the refund; a fee
    // can never exceed what the lines are worth.
    const restockingFeeCents = body.restockingFeeCents ?? 0;
    const pickupFeeCents = fulfillment === 'pickup' ? (body.pickupFeeCents ?? 0) : 0;
    if (restockingFeeCents + pickupFeeCents > amountCents) {
      throw new BadRequestException('Fees cannot exceed the value of the returned lines');
    }
    amountCents -= restockingFeeCents + pickupFeeCents;

    // Authorization-time sanity check on an original-tender refund; the
    // binding check re-runs at goods receipt.
    const toStoreCredit = body.refundMethod === 'store_credit';
    if (!toStoreCredit) {
      const payments = await this.db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, id));
      const collected = paidCents(payments);
      if (amountCents > collected) {
        throw new BadRequestException(
          `Refund (${amountCents}) exceeds the money collected (${collected}) — use store credit for the difference`,
        );
      }
    }

    const priorReturns = await this.db
      .select({ id: schema.orderReturns.id })
      .from(schema.orderReturns)
      .where(eq(schema.orderReturns.orderId, id));
    const rmaNumber = `RMA-${order.number}-${priorReturns.length + 1}`;

    const [ret] = await this.db
      .insert(schema.orderReturns)
      .values({
        businessId: tenant.businessId!,
        orderId: id,
        rmaNumber,
        status: 'authorized',
        fulfillment,
        refundMethod: toStoreCredit ? 'store_credit' : 'original',
        amountCents,
        reason: body.reason ?? null,
        salespersonMembershipId: body.salespersonMembershipId ?? null,
        locationId: body.locationId ?? null,
        restockingFeeCents,
        pickupFeeCents,
        pickupDate: fulfillment === 'pickup' ? (body.pickupDate ?? null) : null,
        createdByUserId: actor?.id ?? null,
      })
      .returning();
    await this.db.insert(schema.orderReturnLines).values(
      validated.map((v) => ({
        businessId: tenant.businessId!,
        returnId: ret!.id,
        orderLineId: v.line.id,
        quantity: v.quantity,
        perUnitCents: v.perUnit,
        reasonCodeId: v.reasonCodeId,
        reason: v.reason,
      })),
    );
    await this.audit.log({
      action: 'order.return_authorized',
      targetType: 'order',
      targetId: id,
      after: {
        rmaNumber,
        amountCents,
        refundMethod: toStoreCredit ? 'store_credit' : 'original',
        fulfillment,
        unitCount: validated.reduce((s, v) => s + v.quantity, 0),
        reason: body.reason ?? null,
      },
    });

    // Drop-off: the goods are in hand — receive (and refund) now.
    if (fulfillment === 'drop_off') {
      await this.orderReturns.receiveGoods(ret!.id, actor?.id ?? null, {
        receiveLocationId: body.returnToLocationId ?? null,
      });
    } else if (body.pickupDate) {
      // A22 slice 6: the pickup is a stop on the delivery calendar — a
      // `return_pickup` delivery carrying the returned lines; completing
      // it receives the return instead of fulfilling the order.
      const [stop] = await this.db
        .insert(schema.deliveries)
        .values({
          businessId: tenant.businessId!,
          locationId: body.locationId ?? order.locationId,
          orderId: id,
          kind: 'return_pickup',
          returnId: ret!.id,
          scheduledDate: body.pickupDate,
          windowStart: body.pickupWindowStart ?? null,
          windowEnd: body.pickupWindowEnd ?? null,
          notes: body.pickupNotes ?? `Pickup for ${rmaNumber}`,
        })
        .returning({ id: schema.deliveries.id });
      await this.db.insert(schema.deliveryLines).values(
        validated.map((v) => ({
          businessId: tenant.businessId!,
          deliveryId: stop!.id,
          orderLineId: v.line.id,
          quantity: v.quantity,
        })),
      );
      await this.db
        .update(schema.orderReturns)
        .set({ pickupDeliveryId: stop!.id })
        .where(eq(schema.orderReturns.id, ret!.id));
      await this.audit.log({
        action: 'delivery.scheduled',
        targetType: 'delivery',
        targetId: stop!.id,
        after: { kind: 'return_pickup', rmaNumber, scheduledDate: body.pickupDate },
      });
    }
    return this.loadDetail(id);
  }

  /**
   * §10 price adjustment / partial refund — money only, no goods. A
   * distinct transaction type from a return: nothing enters As-Is and
   * no quantities change.
   */
  @Post('orders/:id/price-adjustment')
  @RequirePermission('pos.refund.create')
  async priceAdjustment(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: {
      amountCents?: number;
      reason?: string;
      reasonCodeId?: string;
      refundMethod?: 'original' | 'store_credit';
    },
  ): Promise<OrderDetail> {
    if (!Number.isInteger(body.amountCents) || (body.amountCents ?? 0) <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }
    // Coded reason (class `adjustment`) once the registry has codes;
    // free text stays as the transitional fallback (gap amendment A9).
    const adjReason = await this.overrides.resolveReason('adjustment', {
      reasonCodeId: body.reasonCodeId,
      reason: body.reason,
    });
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');

    const payments = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, id))
      .orderBy(desc(schema.payments.createdAt));
    const collected = paidCents(payments);
    const toStoreCredit = body.refundMethod === 'store_credit';
    if (!toStoreCredit && body.amountCents! > collected) {
      throw new BadRequestException(
        `Adjustment (${body.amountCents}) exceeds the money collected (${collected})`,
      );
    }

    if (toStoreCredit) {
      await this.storeCredit.issue(this.db, {
        businessId: tenant.businessId!,
        customerId: order.customerId,
        amountCents: body.amountCents!,
        reason: adjReason.reasonText ?? adjReason.reasonCode ?? 'price adjustment',
        referenceType: 'order_return',
        referenceId: order.id,
        actorUserId: actor?.id ?? null,
      });
    } else {
      let remaining = body.amountCents!;
      for (const p of payments) {
        if (remaining <= 0) break;
        if (p.status !== 'succeeded' || p.amountCents <= 0) continue;
        const slice = Math.min(remaining, p.amountCents);
        await this.db.insert(schema.payments).values({
          businessId: tenant.businessId!,
          saleId: null,
          orderId: id,
          kind: 'adjustment',
          method: p.method,
          amountCents: -slice,
          status: 'succeeded',
        });
        remaining -= slice;
      }
    }

    await this.audit.log({
      action: 'order.price_adjustment',
      targetType: 'order',
      targetId: id,
      after: {
        amountCents: body.amountCents,
        refundMethod: toStoreCredit ? 'store_credit' : 'original',
        reason: adjReason.reasonText,
        reasonCode: adjReason.reasonCode,
      },
    });
    return this.loadDetail(id);
  }

  /**
   * §10 Exchange Order: a new order written against the original
   * invoice. The document prints as "Exchange Order" with the Original
   * Invoice # prominent; the return portion is handled by the return
   * endpoint (old goods → As-Is; credit covers the new goods).
   */
  @Post('orders/:id/exchange')
  @RequirePermission('orders.create')
  async createExchange(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: CreateOrderBody,
  ): Promise<OrderDetail> {
    const [original] = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        customerId: schema.orders.customerId,
        locationId: schema.orders.locationId,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!original) throw new NotFoundException('Original order not found');
    if (
      original.status === 'draft' ||
      original.status === 'quote' ||
      original.status === 'cancelled'
    ) {
      throw new BadRequestException(`Cannot write an exchange against a ${original.status} order`);
    }

    const created = await this.create(tenant, actor, {
      ...body,
      customerId: original.customerId,
      locationId: body.locationId ?? original.locationId,
      orderKind: 'exchange',
    });
    await this.db
      .update(schema.orders)
      .set({ originalOrderId: original.id, updatedAt: new Date() })
      .where(eq(schema.orders.id, created.id));

    await this.audit.log({
      action: 'order.exchange.create',
      targetType: 'order',
      targetId: created.id,
      metadata: { originalOrderId: original.id, originalNumber: original.number },
    });
    return this.loadDetail(created.id);
  }

  /**
   * Everything a printed document needs in one payload (PLAN-POS-
   * OPERATIONS §11): the order detail plus business branding + admin
   * header/footer notes, the store block, the customer (Sold To),
   * salesperson names, per-line model/brand, the scheduled date from the
   * earliest undelivered trip, and the payments list. The web print
   * views (invoice, delivery ticket, batch) all render from this.
   */
  @Get('orders/:id/document')
  @RequirePermission('orders.view')
  async document(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<OrderDocument> {
    const detail = await this.loadDetail(id);

    const [biz] = await this.db
      .select({
        name: schema.businesses.name,
        brandingJson: schema.businesses.brandingJson,
        opsSettingsJson: schema.businesses.opsSettingsJson,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    const branding = (biz?.brandingJson ?? {}) as {
      logoUrl?: string;
      publicName?: string;
      accentColor?: string;
    };
    const ops = (biz?.opsSettingsJson ?? {}) as {
      invoiceHeaderNote?: string;
      invoiceFooterNote?: string;
    };

    const [location] = await this.db
      .select({
        name: schema.locations.name,
        orderPrefix: schema.locations.orderPrefix,
        addressJson: schema.locations.addressJson,
      })
      .from(schema.locations)
      .where(eq(schema.locations.id, detail.locationId))
      .limit(1);

    const [customer] = await this.db
      .select({
        id: schema.customers.id,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        email: schema.customers.email,
        phone: schema.customers.phone,
        addressesJson: schema.customers.addressesJson,
        customerNumber: schema.customers.customerNumber,
        businessName: schema.customers.businessName,
        contactName: schema.customers.contactName,
        alternateName: schema.customers.alternateName,
        alternateRelationship: schema.customers.alternateRelationship,
        deliveryInstructions: schema.customers.deliveryInstructions,
      })
      .from(schema.customers)
      .where(eq(schema.customers.id, detail.customerId))
      .limit(1);

    // SOLD TO billing address: the entry labeled "billing" wins, else the
    // first address on file (entry 0 is the delivery address by the POS
    // convention, which doubles as billing when no separate one exists).
    const customerAddress = (() => {
      const list = Array.isArray(customer?.addressesJson)
        ? (customer.addressesJson as Record<string, unknown>[])
        : [];
      const a = list.find((x) => x?.label === 'billing') ?? list[0];
      if (!a) return null;
      const s = (k: string) => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : null);
      return {
        line1: s('line1'),
        line2: s('line2'),
        city: s('city'),
        region: s('region'),
        postalCode: s('postalCode'),
      };
    })();

    const salespersonName = async (membershipId: string | null) => {
      if (!membershipId) return null;
      const [row] = await this.db
        .select({ name: schema.users.name, email: schema.users.email })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.id, membershipId))
        .limit(1);
      // BA-0020: an empty-string display name falls through to the email
      // so documents never print a blank salesperson.
      return row?.name?.trim() || row?.email || null;
    };

    // Scheduled Date box = the earliest trip still owed to the customer.
    const [trip] = await this.db
      .select({ scheduledDate: schema.deliveries.scheduledDate })
      .from(schema.deliveries)
      .where(
        and(
          eq(schema.deliveries.orderId, id),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      )
      .orderBy(schema.deliveries.scheduledDate)
      .limit(1);

    // Line grid Model | Brand: model = variant SKU, brand = the product's
    // real brand when one is assigned, falling back to the variant's
    // preferred vendor for unbranded catalog rows (the original v1
    // convention, kept so imported products still print something).
    // Family pieces (split siblings) share the invoice — pull their
    // details up front so one meta lookup covers every line printed.
    const siblingRows = (
      await this.splitFamily(tenant.businessId!, detail.number, detail.id)
    ).filter((r) => !r.cancelledAt && r.status !== 'cancelled');
    const familyPieces =
      siblingRows.length > 0
        ? [detail, ...(await Promise.all(siblingRows.map((r) => this.loadDetail(r.id))))].sort(
            (a, b) => a.number.localeCompare(b.number),
          )
        : [detail];

    const variantIds = [
      ...new Set(familyPieces.flatMap((p) => p.lines.map((l) => l.variantId)).filter(Boolean)),
    ] as string[];
    const lineMeta = new Map<
      string,
      { model: string | null; brand: string | null; bin: string | null }
    >();
    if (variantIds.length > 0) {
      const rows = await this.db
        .select({
          variantId: schema.productVariants.id,
          model: schema.productVariants.sku,
          brandName: schema.brands.name,
          vendorName: schema.vendors.name,
        })
        .from(schema.productVariants)
        .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
        .leftJoin(schema.vendors, eq(schema.vendors.id, schema.productVariants.preferredVendorId))
        .where(inArray(schema.productVariants.id, variantIds));
      for (const r of rows)
        lineMeta.set(r.variantId, {
          model: r.model,
          brand: r.brandName ?? r.vendorName,
          bin: null,
        });
      // Storage bin per line for the pick list — where the stock sits at
      // the order's own location (bins are per-location; a line pulled
      // from elsewhere rides a transfer and gets picked there).
      const bins = await this.db
        .select({
          variantId: schema.inventoryLevels.variantId,
          code: schema.storageBins.code,
        })
        .from(schema.inventoryLevels)
        .innerJoin(
          schema.storageBins,
          eq(schema.storageBins.id, schema.inventoryLevels.storageBinId),
        )
        .where(
          and(
            inArray(schema.inventoryLevels.variantId, variantIds),
            eq(schema.inventoryLevels.locationId, detail.locationId),
          ),
        );
      for (const b of bins) {
        const meta = lineMeta.get(b.variantId);
        if (meta) meta.bin = b.code;
      }
    }

    // §10 Exchange Order doc: the Original Invoice # prints prominently.
    let originalOrderNumber: string | null = null;
    if (detail.originalOrderId) {
      const [orig] = await this.db
        .select({ number: schema.orders.number })
        .from(schema.orders)
        .where(eq(schema.orders.id, detail.originalOrderId))
        .limit(1);
      originalOrderNumber = orig?.number ?? null;
    }

    const familyInvoice =
      familyPieces.length > 1
        ? {
            numbers: familyPieces.map((p) => p.number),
            lines: familyPieces.flatMap((p) =>
              p.lines.map((l) => ({
                ...l,
                model: l.variantId ? (lineMeta.get(l.variantId)?.model ?? null) : null,
                brand: l.variantId ? (lineMeta.get(l.variantId)?.brand ?? null) : null,
                pieceNumber: p.number,
                takenWith: (l.fulfillmentMethod ?? p.fulfillmentType) === 'take_with',
              })),
            ),
            subtotalCents: familyPieces.reduce((n, p) => n + p.subtotalCents, 0),
            discountCents: familyPieces.reduce((n, p) => n + p.discountCents, 0),
            deliveryFeeCents: familyPieces.reduce((n, p) => n + p.deliveryFeeCents, 0),
            installFeeCents: familyPieces.reduce((n, p) => n + p.installFeeCents, 0),
            otherFeeCents: familyPieces.reduce((n, p) => n + p.otherFeeCents, 0),
            taxCents: familyPieces.reduce((n, p) => n + p.taxCents, 0),
            totalCents: familyPieces.reduce((n, p) => n + p.totalCents, 0),
            paidCents: familyPieces.reduce((n, p) => n + p.paidCents, 0),
            balanceDueCents: familyPieces.reduce((n, p) => n + p.balanceDueCents, 0),
          }
        : null;

    return {
      business: {
        name: branding.publicName ?? biz?.name ?? '',
        logoUrl: branding.logoUrl ?? null,
        accentColor: branding.accentColor ?? null,
        invoiceHeaderNote: ops.invoiceHeaderNote ?? null,
        invoiceFooterNote: ops.invoiceFooterNote ?? null,
      },
      location: location
        ? {
            name: location.name,
            orderPrefix: location.orderPrefix ?? null,
            addressJson: location.addressJson ?? null,
          }
        : null,
      customer: customer
        ? {
            id: customer.id,
            name: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || '(no name)',
            email: customer.email,
            phone: customer.phone,
            customerNumber: customer.customerNumber,
            businessName: customer.businessName,
            contactName: customer.contactName,
            alternateName: customer.alternateName,
            alternateRelationship: customer.alternateRelationship,
            deliveryInstructions: customer.deliveryInstructions,
            address: customerAddress,
          }
        : null,
      salespersonName: await salespersonName(detail.salespersonMembershipId),
      secondSalespersonName: await salespersonName(detail.secondSalespersonMembershipId),
      originalOrderNumber,
      scheduledDate: trip?.scheduledDate ?? detail.requestedDate,
      order: detail,
      lines: detail.lines.map((l) => ({
        ...l,
        model: l.variantId ? (lineMeta.get(l.variantId)?.model ?? null) : null,
        brand: l.variantId ? (lineMeta.get(l.variantId)?.brand ?? null) : null,
        bin: l.variantId ? (lineMeta.get(l.variantId)?.bin ?? null) : null,
      })),
      familyInvoice,
    };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Resolve variants, prices, and the tax rate for a batch of line
   * inputs. Rate resolution matches the POS exactly — per-location tax
   * class override, then the class fallback, then the location default,
   * then the business default — so an order and a sale of the same item
   * on the same day are taxed identically.
   */
  private async priceLines(
    tenant: RequestTenantContext,
    locationId: string,
    inputs: readonly OrderLineInput[],
  ): Promise<
    {
      variantId: string;
      description: string;
      quantity: number;
      unitPriceCents: number;
      lineDiscountCents: number;
      lineType: string;
      taxRateBps: number;
      taxClassId: string | null;
      /** Catalog list price (variance basis); custom lines = as entered. */
      listPriceCents: number;
      costCents: number | null;
    }[]
  > {
    for (const l of inputs) {
      if (!Number.isInteger(l.quantity) || (l.quantity ?? 0) <= 0) {
        throw new BadRequestException('lines[].quantity must be a positive integer');
      }
      if (l.lineType && !LINE_TYPES.includes(l.lineType)) {
        throw new BadRequestException(`lines[].lineType must be one of ${LINE_TYPES.join(', ')}`);
      }
      // Custom lines (PLAN-POS-OPERATIONS §4: recycling fee, removal, misc
      // charges) have no variant: they need their own description + price,
      // never reserve stock, and are untaxed (CA recycling fees are not
      // taxable; taxable merchandise is always a variant line).
      if (!l.variantId) {
        if (l.lineType !== 'custom') {
          throw new BadRequestException('lines[].variantId is required for product lines');
        }
        if (!l.description?.trim()) {
          throw new BadRequestException('custom lines need a description');
        }
        if (!Number.isInteger(l.unitPriceCents) || (l.unitPriceCents ?? -1) < 0) {
          throw new BadRequestException('custom lines need a non-negative unitPriceCents');
        }
      } else if (l.lineType === 'custom') {
        throw new BadRequestException('custom lines must not reference a variant');
      }
    }
    const variantIds = inputs.map((l) => l.variantId).filter((id): id is string => Boolean(id));

    const variants = await this.db
      .select({
        id: schema.productVariants.id,
        priceCents: schema.productVariants.priceCents,
        costCents: schema.productVariants.costCents,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        taxClassId: schema.products.taxClassId,
        taxClassFallbackRateBps: schema.taxClasses.rateBps,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.taxClasses, eq(schema.taxClasses.id, schema.products.taxClassId))
      .where(inArray(schema.productVariants.id, variantIds));
    const byId = new Map(variants.map((v) => [v.id, v]));
    for (const id of variantIds) {
      if (!byId.has(id)) throw new NotFoundException(`Variant not found: ${id}`);
    }

    const taxClassIds = Array.from(
      new Set(variants.map((v) => v.taxClassId).filter((id): id is string => Boolean(id))),
    );
    const overrideMap = new Map<string, number>();
    if (taxClassIds.length > 0) {
      const overrides = await this.db
        .select({
          taxClassId: schema.taxClassRates.taxClassId,
          rateBps: schema.taxClassRates.rateBps,
        })
        .from(schema.taxClassRates)
        .where(
          and(
            inArray(schema.taxClassRates.taxClassId, taxClassIds),
            eq(schema.taxClassRates.locationId, locationId),
          ),
        );
      for (const o of overrides) overrideMap.set(o.taxClassId, o.rateBps);
    }

    const [location] = await this.db
      .select({ taxRateBps: schema.locations.taxRateBps })
      .from(schema.locations)
      .where(eq(schema.locations.id, locationId))
      .limit(1);
    let fallbackRateBps = location?.taxRateBps ?? null;
    if (fallbackRateBps == null) {
      const [biz] = await this.db
        .select({ defaultTaxRateBps: schema.businesses.defaultTaxRateBps })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, tenant.businessId!))
        .limit(1);
      fallbackRateBps = biz?.defaultTaxRateBps ?? 0;
    }

    return inputs.map((l) => {
      const lineDiscountCents = l.lineDiscountCents ?? 0;
      if (!Number.isInteger(lineDiscountCents) || lineDiscountCents < 0) {
        throw new BadRequestException('lines[].lineDiscountCents must be a non-negative integer');
      }
      if (!l.variantId) {
        return {
          variantId: null as unknown as string,
          description: l.description!.trim(),
          quantity: l.quantity!,
          unitPriceCents: l.unitPriceCents!,
          lineDiscountCents,
          lineType: 'custom',
          taxRateBps: 0,
          taxClassId: null,
          listPriceCents: l.unitPriceCents!,
          costCents: null,
        };
      }
      const v = byId.get(l.variantId)!;
      const description =
        l.description ?? [v.productName, v.variantName].filter(Boolean).join(' — ');
      return {
        variantId: v.id,
        description,
        quantity: l.quantity!,
        unitPriceCents: l.unitPriceCents ?? v.priceCents,
        lineDiscountCents,
        lineType: l.lineType ?? 'stock',
        taxRateBps:
          (v.taxClassId ? overrideMap.get(v.taxClassId) : undefined) ??
          v.taxClassFallbackRateBps ??
          fallbackRateBps!,
        taxClassId: v.taxClassId,
        listPriceCents: v.priceCents,
        costCents: v.costCents ?? null,
      };
    });
  }

  /** Load an order's lines shaped for the variance gate. */
  private async varianceLinesFor(orderId: string): Promise<
    {
      quantity: number;
      unitPriceCents: number;
      lineDiscountCents: number;
      lineType: string;
      listPriceCents: number;
      costCents: number | null;
      description: string;
    }[]
  > {
    const rows = await this.db
      .select({
        quantity: schema.orderLines.quantity,
        unitPriceCents: schema.orderLines.unitPriceCents,
        discountCents: schema.orderLines.discountCents,
        lineType: schema.orderLines.lineType,
        description: schema.orderLines.description,
        listPriceCents: schema.productVariants.priceCents,
        costCents: schema.productVariants.costCents,
      })
      .from(schema.orderLines)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(eq(schema.orderLines.orderId, orderId));
    return rows.map((l) => ({
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      lineDiscountCents: l.discountCents,
      lineType: l.lineType,
      listPriceCents: l.listPriceCents ?? l.unitPriceCents,
      costCents: l.costCents ?? null,
      description: l.description,
    }));
  }

  /**
   * A1: an individually-printed delivery ticket freezes the order — no
   * edits while it's on the truck. Unlocking (POST :id/unlock, its own
   * permission, typed reason) clears the freeze.
   */
  /**
   * G7 / amendment A5: membership on an open delivery run is the HARD
   * lock — while the goods are manifested for a truck, the order cannot
   * be edited or even unlocked; it must be pulled off the run first
   * (coded reason, exception registered).
   */
  private async assertNotOnOpenRun(orderId: string): Promise<void> {
    const [onRun] = await this.db
      .select({ runId: schema.deliveries.runId })
      .from(schema.deliveries)
      .innerJoin(schema.deliveryRuns, eq(schema.deliveryRuns.id, schema.deliveries.runId))
      .where(
        and(
          eq(schema.deliveries.orderId, orderId),
          inArray(schema.deliveryRuns.status, ['open', 'out']),
        ),
      )
      .limit(1);
    if (onRun) {
      throw new ConflictException(
        'This order is on a delivery run. Remove it from the run (with a reason) before editing.',
      );
    }
  }

  private assertUnlocked(order: {
    lockedAt: Date | null;
    relockAt?: Date | null;
    ticketPrintCount?: number;
  }): void {
    if (order.lockedAt) {
      throw new ConflictException(
        'Order is locked — its delivery ticket has been printed. Unlock it with a reason before editing.',
      );
    }
    // G9: an unlock is a 15-minute window. Past it, a printed order
    // counts as locked again — no cron needed, the check is lazy.
    if (
      (order.ticketPrintCount ?? 0) > 0 &&
      order.relockAt &&
      order.relockAt.getTime() < Date.now()
    ) {
      throw new ConflictException(
        'The unlock window expired and the lock re-engaged. Unlock again with a reason.',
      );
    }
  }

  /** Load an order, refusing anything that is finished or cancelled. */
  private async requireLiveOrder(id: string): Promise<typeof schema.orders.$inferSelect> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    if (!isLiveOrderStatus(order.status)) {
      throw new BadRequestException(
        `Order is ${order.status as OrderStatus} and cannot be changed`,
      );
    }
    return order;
  }

  private async loadDetail(id: string): Promise<OrderDetail> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, id))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');

    // A5/G7: run membership is the hard lock the server enforces on
    // every edit path. Surface it on the detail so the UI can say so
    // and disable the controls — it enforced this silently before, and
    // the page looked fully editable until you clicked (QA D5).
    const [openRun] = await this.db
      .select({ runId: schema.deliveryRuns.id, runDate: schema.deliveryRuns.runDate })
      .from(schema.deliveries)
      .innerJoin(schema.deliveryRuns, eq(schema.deliveryRuns.id, schema.deliveries.runId))
      .where(
        and(
          eq(schema.deliveries.orderId, id),
          inArray(schema.deliveryRuns.status, ['open', 'out']),
        ),
      )
      .limit(1);

    const lines = await this.db
      .select()
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, id))
      .orderBy(schema.orderLines.createdAt);

    const payments = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, id))
      .orderBy(schema.payments.createdAt);

    // Split family (base number + letter suffixes), so the page can link
    // the pieces and offer to move credit between them.
    const familyRows = await this.splitFamily(order.businessId, order.number, order.id);
    let family: OrderDetail['family'] = [];
    if (familyRows.length > 0) {
      const famPayments = await this.db
        .select({
          orderId: schema.payments.orderId,
          amountCents: schema.payments.amountCents,
          status: schema.payments.status,
        })
        .from(schema.payments)
        .where(
          inArray(
            schema.payments.orderId,
            familyRows.map((r) => r.id),
          ),
        );
      const famLines = await this.db
        .select({
          id: schema.orderLines.id,
          orderId: schema.orderLines.orderId,
          description: schema.orderLines.description,
          quantity: schema.orderLines.quantity,
          fulfillmentMethod: schema.orderLines.fulfillmentMethod,
        })
        .from(schema.orderLines)
        .where(
          inArray(
            schema.orderLines.orderId,
            familyRows.map((r) => r.id),
          ),
        )
        .orderBy(schema.orderLines.createdAt);
      family = familyRows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        totalCents: r.totalCents,
        balanceDueCents: balanceDueCents(
          r.totalCents,
          famPayments.filter((fp) => fp.orderId === r.id),
        ),
        fulfillmentType: r.fulfillmentType,
        requestedDate: r.requestedDate,
        lines: famLines
          .filter((l) => l.orderId === r.id)
          .map((l) => ({
            id: l.id,
            description: l.description,
            quantity: l.quantity,
            fulfillmentMethod: l.fulfillmentMethod,
          })),
      }));
    }

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      customerId: order.customerId,
      locationId: order.locationId,
      stockLocationId: order.stockLocationId ?? null,
      subtotalCents: order.subtotalCents,
      orderDiscountCents: order.orderDiscountCents,
      discountCents: order.discountCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      paidCents: paidCents(payments),
      balanceDueCents: balanceDueCents(order.totalCents, payments),
      creditDueCents: Math.max(0, paidCents(payments) - order.totalCents),
      depositRequiredCents: order.depositRequiredCents,
      fulfillmentType: order.fulfillmentType,
      requestedDate: order.requestedDate,
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      addressCity: order.addressCity,
      addressRegion: order.addressRegion,
      addressPostalCode: order.addressPostalCode,
      addressPhone: order.addressPhone,
      notes: order.notes,
      internalNotes: order.internalNotes,
      originalOrderId: order.originalOrderId,
      salespersonMembershipId: order.salespersonMembershipId,
      secondSalespersonMembershipId: order.secondSalespersonMembershipId,
      splitBps: order.splitBps,
      orderKind: order.orderKind,
      deliveryStatus: order.deliveryStatus,
      deliveryInstructions: order.deliveryInstructions,
      pickupLocationId: order.pickupLocationId,
      billingAddressJson: order.billingAddressJson,
      marketingCode: order.marketingCode,
      marketingCode2: order.marketingCode2,
      orderSource: order.orderSource,
      paymentTerminal: order.paymentTerminal,
      exceptionNotes: order.exceptionNotes,
      tradeDesignerJson: order.tradeDesignerJson,
      customInfoJson: order.customInfoJson,
      deliveryFeeCents: order.deliveryFeeCents,
      installFeeCents: order.installFeeCents,
      otherFeeCents: order.otherFeeCents,
      otherFeeLabel: order.otherFeeLabel,
      importedAt: order.importedAt,
      legacyNumber: order.legacyNumber,
      lockedAt: order.lockedAt,
      onOpenRun: openRun ? { runId: openRun.runId, runDate: openRun.runDate } : null,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt,
      createdAt: order.createdAt,
      lines: lines.map((l) => ({
        id: l.id,
        variantId: l.variantId,
        description: l.description,
        quantity: l.quantity,
        qtyReserved: l.qtyReserved,
        qtyFulfilled: l.qtyFulfilled,
        qtyReturned: l.qtyReturned,
        lineType: l.lineType,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents,
        taxCents: l.taxCents,
        totalCents: l.totalCents,
        taxRateBps: l.taxRateBps,
        fulfillmentMethod: l.fulfillmentMethod,
        sourceLocationId: l.sourceLocationId,
        deliveryDate: l.deliveryDate,
        comment: l.comment,
        room: l.room,
        pieces: l.pieces,
        prepCodes: l.prepCodes ?? null,
        comJson: l.comJson,
        directShipJson: l.directShipJson,
        needsInstall: l.needsInstall,
      })),
      family,
      payments: payments.map((p) => ({
        id: p.id,
        kind: p.kind,
        method: p.method,
        amountCents: p.amountCents,
        status: p.status,
        processor: p.processor,
        processorRef: p.processorRef,
        financingProvider: p.financingProvider,
        financingRef: p.financingRef,
        createdAt: p.createdAt,
      })),
    };
  }

  /**
   * Fire-and-forget outbound webhook. Imported history stays silent
   * (D8) — replaying two years of STORIS orders must not spray a
   * customer's integrations with events that already happened.
   */
  private fireOrderEvent(
    eventType: 'order.created' | 'order.payment_received' | 'order.cancelled' | 'order.completed',
    businessId: string,
    order: OrderDetail,
    extra?: Record<string, unknown>,
  ): void {
    if (order.importedAt) return;
    void this.webhooks.fire({
      businessId,
      eventType,
      payload: {
        orderId: order.id,
        number: order.number,
        status: order.status,
        customerId: order.customerId,
        locationId: order.locationId,
        totalCents: order.totalCents,
        paidCents: order.paidCents,
        balanceDueCents: order.balanceDueCents,
        ...extra,
      },
    });
  }
}
