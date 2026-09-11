import { BadRequestException, Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { isSupportedCurrency, SUPPORTED_CURRENCIES } from '@jetnine/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

/** White-label branding. All fields optional; null clears the field. */
export interface BusinessBranding {
  /** #rrggbb accent applied as the app's brand color for this tenant. */
  accentColor?: string | null;
  /** https URL rendered in the sidebar header. */
  logoUrl?: string | null;
  /** Display-name override for the shell + receipts; legal `name` stays. */
  publicName?: string | null;
}

interface BusinessSettings {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string | null;
  currencyCode: string;
  defaultTaxRateBps: number;
  receiptHeader: string | null;
  receiptFooter: string | null;
  branding: BusinessBranding | null;
  ops: OpsSettings | null;
}

/** PLAN-POS-OPERATIONS operational knobs; all optional, admin-edited. */
interface OpsSettings {
  recyclingFeeCents?: number | null;
  invoiceHeaderNote?: string | null;
  invoiceFooterNote?: string | null;
  unlockRoleIds?: string[] | null;
  deliveryDailyCap?: number | null;
  poReplyTo?: string | null;
  /** G9: block delivery-ticket print above this balance due (null = off). */
  maxBalanceForTicketPrintCents?: number | null;
  /** G11: auto-clear matched invoices within this variance (null = manual). */
  invoiceVarianceToleranceCents?: number | null;
  /** G11: hide expected quantities on the receiving grid. */
  blindReceiving?: boolean | null;
  /** G12: optional per-day piece budget for the trucks. */
  deliveryDailyPieceCap?: number | null;
  /** G12: optional per-day capacity-unit budget (variant capacityUnits). */
  deliveryDailyCapacityUnits?: number | null;
  /** G12: zip-prefix → route map ("912" → "Glendale AM"). */
  zipRoutes?: Record<string, string> | null;
  /** B14: how contested stock is prioritized when backfilling Pending
   * lines — 'delivery_date' (owner default) or 'order_date'. */
  reserveBasis?: 'delivery_date' | 'order_date' | null;
  /** I4 (RTN-040): days after completion a return is allowed without a
   * manager override (null = no window, returns always allowed). */
  returnWindowDays?: number | null;
  /** Exchange pack: % of the return credit charged as a restocking fee
   * on exchanges (null/0 = none). Overridable per exchange with its own
   * permission. */
  restockingFeePercent?: number | null;
  /** Exchange pack (E1): hold every new exchange for approval. */
  exchangeHoldAtEntry?: boolean | null;
  /** J4 (XFR-052 / CFG-POS-AUTOSCHED): blank disables auto transfers;
   * 0 is valid and means same-day + 1 per the XFR-053 formula. */
  autoScheduleDays?: number | null;
  /** REPL-040: nightly auto-replenishment PO drafts (off by default). */
  autoReplenishmentEnabled?: boolean | null;
  /** Sales-rate replenishment purchasing controls (HANDOFF-po-replenishment
   * §2/§6). Null/absent field = the documented default. */
  salesRateReplenishment?: {
    unitSalesRateCalculation?: 'written' | 'delivered' | null;
    excludeWeekendsInVendorLeadDays?: boolean | null;
    standardRounding?: boolean | null;
    includeStoreStockInAvailability?: boolean | null;
    layawayInNetPurchaseOrder?: boolean | null;
  } | null;
  /** Blind-count cash balancing (cash pack, owner 2026-08-28).
   * Null block or null tolerance = discipline off (close accepts any
   * variance, the pre-blind-count behavior). Tolerance is CASH-only by
   * construction — Jetnine shift closes only count cash (AC-7). */
  cashBalancing?: {
    /** AC-5/6: |variance| beyond this refuses the close. */
    toleranceCents?: number | null;
    /** AC-8: failed attempts before the drawer suspends. Null = no cap. */
    maxAttempts?: number | null;
  } | null;
  /** Transfers pack Q2/Q3 (owner 2026-08-28). Null field = default. */
  transfers?: {
    /** E20: store↔store transfers. Null/true = allowed; false rejects. */
    storeToStore?: boolean | null;
    /** Q3: ship requires a printed transfer ticket. Null/true = required. */
    requireTicketBeforeShip?: boolean | null;
  } | null;
  /** G6 three-tier price-variance thresholds (defaults 5% / $50 / 15%). */
  priceVariance?: {
    tier1Pct?: number | null;
    tier1MaxCents?: number | null;
    tier2Pct?: number | null;
  } | null;
  /**
   * What reaches the Operations feed (owner 2026-08-31). Every field is
   * tri-state: absent or null means the documented default in
   * OPS_THRESHOLD_DEFAULTS, while zero is a real setting — a $0 refund
   * threshold means "show me every refund".
   */
  opsReview?: {
    refundCents?: number | null;
    discountPct?: number | null;
    overrideCents?: number | null;
    drawerVarianceCents?: number | null;
    inventoryAdjustUnits?: number | null;
    takeWithOpenHours?: number | null;
    lookbackDays?: number | null;
  } | null;
  /**
   * A20 (STORIS Enter a Sales Order) pick lists. Each is a plain list of
   * labels; the order-page pickers accept free text too, so a missing
   * entry never blocks a sale. Null/absent = no suggestions.
   */
  marketingCodes?: string[] | null;
  orderSources?: string[] | null;
  prepCodes?: string[] | null;
  rooms?: string[] | null;
  paymentTerminals?: string[] | null;
}

/** A20 pick lists: up to 200 labels of up to 60 characters, de-duplicated. */
const OPS_LIST_KEYS = [
  'marketingCodes',
  'orderSources',
  'prepCodes',
  'rooms',
  'paymentTerminals',
] as const;

function validateOpsList(key: string, value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new BadRequestException(`ops.${key} must be a list or null`);
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new BadRequestException(`ops.${key} entries must be text`);
    const v = raw.trim().replace(/\s+/g, ' ');
    if (!v) continue;
    if (v.length > 60) throw new BadRequestException(`ops.${key} entries must be ≤ 60 characters`);
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > 200) throw new BadRequestException(`ops.${key} holds at most 200 entries`);
  return out;
}

/**
 * SET-007: the declared registry behind `GET /v1/business/settings/
 * registry`. `nullMeans` is mandatory prose for every nullable setting
 * (SET-002 — blank is never implicit); `classTags` mark the risk class
 * per the sysadmin pack (SET-003).
 */
const OPS_SETTINGS_REGISTRY = [
  {
    key: 'recyclingFeeCents',
    label: 'Recycling fee per unit',
    type: 'money',
    nullMeans: 'State default ($10.50 per unit)',
    classTags: [],
    readBy: 'POS + order writer recycling line',
  },
  {
    key: 'deliveryDailyCap',
    label: 'Delivery stops per day',
    type: 'integer',
    nullMeans: 'Soft cap of 15 stops',
    classTags: ['TRISTATE'],
    readBy: 'Delivery scheduling (soft cap, override logged)',
  },
  {
    key: 'deliveryDailyPieceCap',
    label: 'Delivery pieces per day',
    type: 'integer',
    nullMeans: 'No piece budget',
    classTags: ['TRISTATE'],
    readBy: 'Delivery scheduling',
  },
  {
    key: 'deliveryDailyCapacityUnits',
    label: 'Delivery capacity units per day',
    type: 'integer',
    nullMeans: 'No capacity budget',
    classTags: ['TRISTATE'],
    readBy: 'Delivery scheduling',
  },
  {
    key: 'zipRoutes',
    label: 'Zip-prefix route map',
    type: 'map',
    nullMeans: 'No route suggestions',
    classTags: [],
    readBy: 'Delivery scheduling route suggestion',
  },
  {
    key: 'invoiceHeaderNote',
    label: 'Invoice header note',
    type: 'text',
    nullMeans: 'No note printed',
    classTags: [],
    readBy: 'Printed invoice / delivery ticket',
  },
  {
    key: 'invoiceFooterNote',
    label: 'Invoice footer note',
    type: 'text',
    nullMeans: 'No note printed',
    classTags: [],
    readBy: 'Printed invoice / delivery ticket',
  },
  {
    key: 'poReplyTo',
    label: 'PO reply-to email',
    type: 'email',
    nullMeans: 'Sends from the platform address',
    classTags: [],
    readBy: 'Emailed purchase orders',
  },
  {
    key: 'maxBalanceForTicketPrintCents',
    label: 'Max balance for ticket print',
    type: 'money',
    nullMeans: 'No cap — tickets print with any balance due',
    classTags: ['TRISTATE'],
    readBy: 'Delivery-ticket print gate (G9)',
  },
  {
    key: 'invoiceVarianceToleranceCents',
    label: 'Vendor-invoice auto-clear tolerance',
    type: 'money',
    nullMeans: 'Every matched invoice needs manual approval',
    classTags: ['TRISTATE'],
    readBy: 'Vendor invoice matching (G11)',
  },
  {
    key: 'blindReceiving',
    label: 'Blind receiving',
    type: 'boolean',
    nullMeans: 'Off — expected quantities shown at the dock',
    classTags: [],
    readBy: 'PO receiving grid (G11)',
  },
  {
    key: 'reserveBasis',
    label: 'Stock reservation basis',
    type: 'enum:delivery_date|order_date',
    nullMeans: 'Earliest delivery date first (owner default, B14)',
    classTags: ['GUARDED'],
    readBy: 'Pending-allocation backfill',
  },
  {
    key: 'returnWindowDays',
    label: 'Return window (days)',
    type: 'integer',
    nullMeans: 'No window — returns always allowed without override',
    classTags: ['TRISTATE'],
    readBy: 'Return authorization (I4)',
  },
  {
    key: 'restockingFeePercent',
    label: 'Exchange restocking fee (%)',
    type: 'percent',
    nullMeans: 'No restocking fee on exchanges',
    classTags: ['TRISTATE'],
    readBy: 'Exchange bind (docs/erp-exchange)',
  },
  {
    key: 'exchangeHoldAtEntry',
    label: 'Hold exchanges for approval (E1)',
    type: 'boolean',
    nullMeans: 'Off — exchanges settle without approval',
    classTags: [],
    readBy: 'Exchange bind + settlement gate',
  },
  {
    key: 'autoScheduleDays',
    label: 'Auto transfer schedule days',
    type: 'integer',
    nullMeans: 'Auto transfers DISABLED (0 = next-day; XFR-052)',
    classTags: ['TRISTATE'],
    readBy: 'Auto replenishment transfers',
  },
  {
    key: 'salesRateReplenishment',
    label: 'Sales-rate replenishment controls',
    type: 'map',
    nullMeans:
      'Defaults: written basis, calendar-day lead divisor, standard rounding on, store stock excluded, layaway excluded',
    classTags: [],
    readBy: 'Sales-rate replenishment runs (interactive + EOD)',
  },
  {
    key: 'cashBalancing',
    label: 'Blind-count cash balancing',
    type: 'map',
    nullMeans: 'Off — shift close accepts any variance (tolerance $ value is an Ops decision)',
    classTags: [],
    readBy: 'Cash-shift close endpoint',
  },
  {
    key: 'transfers',
    label: 'Stock-transfer gates',
    type: 'map',
    nullMeans: 'Defaults: store↔store allowed, printed ticket required before ship',
    classTags: [],
    readBy: 'Stock-transfer create + ship endpoints',
  },
  {
    key: 'autoReplenishmentEnabled',
    label: 'Nightly auto-replenishment POs',
    type: 'boolean',
    nullMeans: 'Off — no PO drafts overnight',
    classTags: [],
    readBy: 'Nightly batch runner (JOB-002)',
  },
  {
    key: 'marketingCodes',
    label: 'Marketing codes (order attribution)',
    type: 'list',
    nullMeans: 'No suggestions — the order page accepts any code typed',
    classTags: [],
    readBy: 'Order page Marketing Code 1 / 2 pickers; Written Sales report',
  },
  {
    key: 'orderSources',
    label: 'Order sources',
    type: 'list',
    nullMeans: 'No suggestions — the order page accepts any source typed',
    classTags: [],
    readBy: 'Order page Order Source Entry',
  },
  {
    key: 'prepCodes',
    label: 'Prep codes (warehouse instructions)',
    type: 'list',
    nullMeans: 'No suggestions — line details accept any code typed',
    classTags: [],
    readBy: 'Order line details; delivery ticket and pick list',
  },
  {
    key: 'rooms',
    label: 'Rooms (where a piece goes in the home)',
    type: 'list',
    nullMeans: 'No suggestions — line details accept any room typed',
    classTags: [],
    readBy: 'Order line details; delivery ticket',
  },
  {
    key: 'paymentTerminals',
    label: 'Payment terminals (card readers)',
    type: 'list',
    nullMeans: 'No terminals to assign',
    classTags: [],
    readBy: 'Order page Assign Payment Terminal',
  },
  {
    key: 'unlockRoleIds',
    label: 'Roles allowed to unlock printed orders',
    type: 'role-list',
    nullMeans: 'Managers and owners (default unlock set)',
    classTags: [],
    readBy: 'Order unlock (A1)',
  },
  {
    key: 'priceVariance',
    label: 'Price-variance tiers',
    type: 'object',
    nullMeans: 'Defaults: 5% / $50 no-friction, 15% manager tier',
    classTags: [],
    readBy: 'Order-writer discount gate (G6)',
  },
  {
    key: 'opsReview',
    label: 'Operations feed thresholds',
    type: 'object',
    nullMeans:
      'Defaults: refunds ≥ $200, discounts ≥ 20%, overrides ≥ $100, drawer variance ≥ $5, stock adjustments ≥ 5 units, take-with open 24h, 7-day lookback',
    classTags: ['TRISTATE'],
    readBy: 'Operations dashboard feed',
  },
] as const;

interface UpdateBody {
  name?: string;
  defaultTaxRateBps?: number;
  receiptHeader?: string | null;
  receiptFooter?: string | null;
  /**
   * ISO 4217 code from the curated set (`SUPPORTED_CURRENCIES`).
   * Validated against that list; unknown codes are rejected 400 so a
   * stale client can't drop the business into a state where balances
   * render with an unsupported symbol.
   */
  currencyCode?: string;
  branding?: BusinessBranding;
  ops?: OpsSettings;
}

function validateOps(input: OpsSettings): OpsSettings {
  const out: OpsSettings = {};
  if (input.recyclingFeeCents !== undefined) {
    if (
      input.recyclingFeeCents !== null &&
      (!Number.isInteger(input.recyclingFeeCents) || input.recyclingFeeCents < 0)
    ) {
      throw new BadRequestException('ops.recyclingFeeCents must be a non-negative integer');
    }
    out.recyclingFeeCents = input.recyclingFeeCents;
  }
  if (input.deliveryDailyCap !== undefined) {
    if (
      input.deliveryDailyCap !== null &&
      (!Number.isInteger(input.deliveryDailyCap) || input.deliveryDailyCap < 1)
    ) {
      throw new BadRequestException('ops.deliveryDailyCap must be a positive integer');
    }
    out.deliveryDailyCap = input.deliveryDailyCap;
  }
  if (input.invoiceHeaderNote !== undefined) out.invoiceHeaderNote = input.invoiceHeaderNote;
  if (input.invoiceFooterNote !== undefined) out.invoiceFooterNote = input.invoiceFooterNote;
  if (input.poReplyTo !== undefined) out.poReplyTo = input.poReplyTo;
  if (input.unlockRoleIds !== undefined) {
    if (input.unlockRoleIds !== null && !Array.isArray(input.unlockRoleIds)) {
      throw new BadRequestException('ops.unlockRoleIds must be an array of role ids');
    }
    out.unlockRoleIds = input.unlockRoleIds;
  }
  if (input.maxBalanceForTicketPrintCents !== undefined) {
    if (
      input.maxBalanceForTicketPrintCents !== null &&
      (!Number.isInteger(input.maxBalanceForTicketPrintCents) ||
        input.maxBalanceForTicketPrintCents < 0)
    ) {
      throw new BadRequestException(
        'ops.maxBalanceForTicketPrintCents must be a non-negative integer',
      );
    }
    out.maxBalanceForTicketPrintCents = input.maxBalanceForTicketPrintCents;
  }
  if (input.invoiceVarianceToleranceCents !== undefined) {
    if (
      input.invoiceVarianceToleranceCents !== null &&
      (!Number.isInteger(input.invoiceVarianceToleranceCents) ||
        input.invoiceVarianceToleranceCents < 0)
    ) {
      throw new BadRequestException(
        'ops.invoiceVarianceToleranceCents must be a non-negative integer',
      );
    }
    out.invoiceVarianceToleranceCents = input.invoiceVarianceToleranceCents;
  }
  if (input.blindReceiving !== undefined) {
    if (input.blindReceiving !== null && typeof input.blindReceiving !== 'boolean') {
      throw new BadRequestException('ops.blindReceiving must be a boolean');
    }
    out.blindReceiving = input.blindReceiving;
  }
  for (const key of ['deliveryDailyPieceCap', 'deliveryDailyCapacityUnits'] as const) {
    if (input[key] !== undefined) {
      if (input[key] !== null && (!Number.isInteger(input[key]) || (input[key] as number) < 1)) {
        throw new BadRequestException(`ops.${key} must be a positive integer`);
      }
      out[key] = input[key];
    }
  }
  if (input.zipRoutes !== undefined) {
    if (input.zipRoutes !== null) {
      if (typeof input.zipRoutes !== 'object' || Array.isArray(input.zipRoutes)) {
        throw new BadRequestException('ops.zipRoutes must be an object of prefix → route');
      }
      for (const [prefix, route] of Object.entries(input.zipRoutes)) {
        if (!/^\d{1,5}$/.test(prefix) || typeof route !== 'string' || !route.trim()) {
          throw new BadRequestException(
            'ops.zipRoutes keys must be 1–5 digit zip prefixes with non-empty route names',
          );
        }
      }
    }
    out.zipRoutes = input.zipRoutes;
  }
  if (input.reserveBasis !== undefined) {
    if (
      input.reserveBasis !== null &&
      input.reserveBasis !== 'delivery_date' &&
      input.reserveBasis !== 'order_date'
    ) {
      throw new BadRequestException("ops.reserveBasis must be 'delivery_date' or 'order_date'");
    }
    out.reserveBasis = input.reserveBasis;
  }
  if (input.returnWindowDays !== undefined) {
    if (
      input.returnWindowDays !== null &&
      (!Number.isInteger(input.returnWindowDays) || input.returnWindowDays < 1)
    ) {
      throw new BadRequestException('ops.returnWindowDays must be a positive integer or null');
    }
    out.returnWindowDays = input.returnWindowDays;
  }
  if (input.restockingFeePercent !== undefined) {
    if (
      input.restockingFeePercent !== null &&
      (typeof input.restockingFeePercent !== 'number' ||
        !Number.isFinite(input.restockingFeePercent) ||
        input.restockingFeePercent < 0 ||
        input.restockingFeePercent > 100)
    ) {
      throw new BadRequestException('ops.restockingFeePercent must be between 0 and 100, or null');
    }
    out.restockingFeePercent = input.restockingFeePercent;
  }
  if (input.exchangeHoldAtEntry !== undefined) {
    if (input.exchangeHoldAtEntry !== null && typeof input.exchangeHoldAtEntry !== 'boolean') {
      throw new BadRequestException('ops.exchangeHoldAtEntry must be a boolean or null');
    }
    out.exchangeHoldAtEntry = input.exchangeHoldAtEntry;
  }
  if (input.autoScheduleDays !== undefined) {
    if (
      input.autoScheduleDays !== null &&
      (!Number.isInteger(input.autoScheduleDays) || input.autoScheduleDays < 0)
    ) {
      throw new BadRequestException('ops.autoScheduleDays must be a non-negative integer or null');
    }
    out.autoScheduleDays = input.autoScheduleDays;
  }
  if (input.salesRateReplenishment !== undefined) {
    const v = input.salesRateReplenishment;
    if (v !== null) {
      if (typeof v !== 'object' || Array.isArray(v)) {
        throw new BadRequestException('ops.salesRateReplenishment must be an object or null');
      }
      if (
        v.unitSalesRateCalculation != null &&
        !['written', 'delivered'].includes(v.unitSalesRateCalculation)
      ) {
        throw new BadRequestException(
          "ops.salesRateReplenishment.unitSalesRateCalculation must be 'written' or 'delivered'",
        );
      }
      for (const key of [
        'excludeWeekendsInVendorLeadDays',
        'standardRounding',
        'includeStoreStockInAvailability',
        'layawayInNetPurchaseOrder',
      ] as const) {
        if (v[key] != null && typeof v[key] !== 'boolean') {
          throw new BadRequestException(`ops.salesRateReplenishment.${key} must be a boolean`);
        }
      }
    }
    out.salesRateReplenishment = v;
  }
  if (input.transfers !== undefined) {
    const v = input.transfers;
    if (v !== null) {
      if (typeof v !== 'object' || Array.isArray(v)) {
        throw new BadRequestException('ops.transfers must be an object or null');
      }
      for (const key of ['storeToStore', 'requireTicketBeforeShip'] as const) {
        if (v[key] != null && typeof v[key] !== 'boolean') {
          throw new BadRequestException(`ops.transfers.${key} must be a boolean`);
        }
      }
    }
    out.transfers = v;
  }
  if (input.cashBalancing !== undefined) {
    const v = input.cashBalancing;
    if (v !== null) {
      if (typeof v !== 'object' || Array.isArray(v)) {
        throw new BadRequestException('ops.cashBalancing must be an object or null');
      }
      if (
        v.toleranceCents != null &&
        (!Number.isInteger(v.toleranceCents) || v.toleranceCents < 0)
      ) {
        throw new BadRequestException(
          'ops.cashBalancing.toleranceCents must be a non-negative integer',
        );
      }
      if (v.maxAttempts != null && (!Number.isInteger(v.maxAttempts) || v.maxAttempts < 1)) {
        throw new BadRequestException('ops.cashBalancing.maxAttempts must be a positive integer');
      }
    }
    out.cashBalancing = v;
  }
  if (input.autoReplenishmentEnabled !== undefined) {
    if (
      input.autoReplenishmentEnabled !== null &&
      typeof input.autoReplenishmentEnabled !== 'boolean'
    ) {
      throw new BadRequestException('ops.autoReplenishmentEnabled must be a boolean or null');
    }
    out.autoReplenishmentEnabled = input.autoReplenishmentEnabled;
  }
  if (input.priceVariance !== undefined) {
    if (input.priceVariance !== null) {
      const pv = input.priceVariance;
      for (const [key, val] of Object.entries(pv) as [string, number | null | undefined][]) {
        if (val != null && (typeof val !== 'number' || !Number.isFinite(val) || val < 0)) {
          throw new BadRequestException(`ops.priceVariance.${key} must be a non-negative number`);
        }
      }
      if (pv.tier1Pct != null && pv.tier2Pct != null && pv.tier2Pct < pv.tier1Pct) {
        throw new BadRequestException('ops.priceVariance.tier2Pct must be ≥ tier1Pct');
      }
    }
    out.priceVariance = input.priceVariance;
  }
  for (const key of OPS_LIST_KEYS) {
    if (input[key] !== undefined) out[key] = validateOpsList(key, input[key]);
  }
  if (input.opsReview !== undefined) {
    if (input.opsReview !== null) {
      for (const [key, val] of Object.entries(input.opsReview) as [
        string,
        number | null | undefined,
      ][]) {
        if (val != null && (typeof val !== 'number' || !Number.isFinite(val) || val < 0)) {
          throw new BadRequestException(`ops.opsReview.${key} must be a non-negative number`);
        }
      }
      if (input.opsReview.discountPct != null && input.opsReview.discountPct > 100) {
        throw new BadRequestException('ops.opsReview.discountPct must be between 0 and 100');
      }
    }
    out.opsReview = input.opsReview;
  }
  return out;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validateBranding(input: BusinessBranding): BusinessBranding {
  const out: BusinessBranding = {};
  if (input.accentColor !== undefined) {
    if (input.accentColor !== null && !HEX_COLOR_RE.test(input.accentColor)) {
      throw new BadRequestException('branding.accentColor must be a #rrggbb hex color');
    }
    out.accentColor = input.accentColor;
  }
  if (input.logoUrl !== undefined) {
    if (input.logoUrl !== null) {
      let url: URL;
      try {
        url = new URL(input.logoUrl);
      } catch {
        throw new BadRequestException('branding.logoUrl must be a valid URL');
      }
      if (url.protocol !== 'https:') {
        throw new BadRequestException('branding.logoUrl must be https');
      }
      if (input.logoUrl.length > 2000) {
        throw new BadRequestException('branding.logoUrl too long');
      }
    }
    out.logoUrl = input.logoUrl;
  }
  if (input.publicName !== undefined) {
    if (input.publicName !== null) {
      const trimmed = input.publicName.trim();
      if (trimmed.length === 0 || trimmed.length > 120) {
        throw new BadRequestException('branding.publicName must be 1–120 characters');
      }
      out.publicName = trimmed;
    } else {
      out.publicName = null;
    }
  }
  return out;
}

@TenantScoped()
@Controller('v1/business/settings')
export class SettingsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * SET-007 (sysadmin pack, scaled to our deliberately flat model): the
   * settings registry as data — every ops setting the system reads,
   * with its type, what blank means (SET-002: no implicit tri-state),
   * and its risk class. A setting that is not in this registry does not
   * exist; the Settings page renders its reference section from it.
   */
  @Get('registry')
  @RequirePermission('business.settings.view')
  registry(): typeof OPS_SETTINGS_REGISTRY {
    return OPS_SETTINGS_REGISTRY;
  }

  /**
   * The subset of settings every screen needs regardless of role — the
   * POS recycling fee, receipt header/footer, currency, branding, delivery
   * caps. `business.settings.view` belongs to Owner/Manager only, so the
   * register (cashiers, salespeople) could never read the full settings and
   * silently fell back to the hard-coded $10.50 fee. Any active member of
   * the business may read this; nothing here is sensitive (no reply-to
   * email, no unlock role ids).
   */
  @Get('pos')
  async pos(@CurrentTenant() tenant: RequestTenantContext): Promise<PosSettings> {
    const [b] = await this.db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    if (!b) throw new BadRequestException('Business not found');
    return toPosSettings(b);
  }

  @Get()
  @RequirePermission('business.settings.view')
  async get(@CurrentTenant() tenant: RequestTenantContext): Promise<BusinessSettings> {
    const [b] = await this.db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    if (!b) throw new BadRequestException('Business not found');
    return toSettings(b);
  }

  @Patch()
  @RequirePermission('business.settings.update')
  async update(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: UpdateBody,
  ): Promise<BusinessSettings> {
    const [existing] = await this.db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .limit(1);
    if (!existing) throw new BadRequestException('Business not found');

    const update: Partial<typeof schema.businesses.$inferInsert> = { updatedAt: new Date() };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const trimmed = body.name.trim();
      if (!trimmed) throw new BadRequestException('name cannot be empty');
      if (trimmed !== existing.name) {
        update.name = trimmed;
        before.name = existing.name;
        after.name = trimmed;
      }
    }
    if (body.defaultTaxRateBps !== undefined) {
      if (!Number.isInteger(body.defaultTaxRateBps) || body.defaultTaxRateBps < 0) {
        throw new BadRequestException('defaultTaxRateBps must be a non-negative integer');
      }
      if (body.defaultTaxRateBps !== existing.defaultTaxRateBps) {
        update.defaultTaxRateBps = body.defaultTaxRateBps;
        before.defaultTaxRateBps = existing.defaultTaxRateBps;
        after.defaultTaxRateBps = body.defaultTaxRateBps;
      }
    }
    if (body.receiptHeader !== undefined && body.receiptHeader !== existing.receiptHeader) {
      update.receiptHeader = body.receiptHeader;
      before.receiptHeader = existing.receiptHeader;
      after.receiptHeader = body.receiptHeader;
    }
    if (body.receiptFooter !== undefined && body.receiptFooter !== existing.receiptFooter) {
      update.receiptFooter = body.receiptFooter;
      before.receiptFooter = existing.receiptFooter;
      after.receiptFooter = body.receiptFooter;
    }
    if (body.currencyCode !== undefined) {
      const next = body.currencyCode.toUpperCase();
      if (!isSupportedCurrency(next)) {
        throw new BadRequestException(
          `currencyCode must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
        );
      }
      if (next !== existing.currencyCode) {
        update.currencyCode = next;
        before.currencyCode = existing.currencyCode;
        after.currencyCode = next;
      }
    }
    if (body.branding !== undefined) {
      // Merge field-by-field: PATCHing one branding field must not wipe
      // the others; explicit null clears a field.
      const patch = validateBranding(body.branding);
      const current = (existing.brandingJson ?? {}) as BusinessBranding;
      const merged: BusinessBranding = { ...current, ...patch };
      for (const key of Object.keys(merged) as (keyof BusinessBranding)[]) {
        if (merged[key] == null) delete merged[key];
      }
      const next = Object.keys(merged).length > 0 ? merged : null;
      if (JSON.stringify(next) !== JSON.stringify(existing.brandingJson ?? null)) {
        update.brandingJson = next;
        before.branding = existing.brandingJson ?? null;
        after.branding = next;
      }
    }

    if (body.ops !== undefined) {
      // Same merge semantics as branding: field-by-field, null clears.
      const patch = validateOps(body.ops);
      const current = (existing.opsSettingsJson ?? {}) as OpsSettings;
      const merged: OpsSettings = { ...current, ...patch };
      for (const key of Object.keys(merged) as (keyof OpsSettings)[]) {
        if (merged[key] == null) delete merged[key];
      }
      const next = Object.keys(merged).length > 0 ? merged : null;
      if (JSON.stringify(next) !== JSON.stringify(existing.opsSettingsJson ?? null)) {
        update.opsSettingsJson = next;
        before.ops = existing.opsSettingsJson ?? null;
        after.ops = next;
      }
    }

    if (Object.keys(after).length === 0) return toSettings(existing);

    const [updated] = await this.db
      .update(schema.businesses)
      .set(update)
      .where(eq(schema.businesses.id, tenant.businessId!))
      .returning();
    if (!updated) throw new BadRequestException('Business not found after update');

    await this.audit.log({
      action: 'business.settings.update',
      targetType: 'business',
      targetId: updated.id,
      before,
      after,
    });

    return toSettings(updated);
  }
}

/** Ops keys safe for every member to read (everything except contact/role plumbing). */
const POS_VISIBLE_OPS_KEYS = [
  'recyclingFeeCents',
  // A20 order-page pick lists.
  'marketingCodes',
  'orderSources',
  'prepCodes',
  'rooms',
  'paymentTerminals',
  'invoiceHeaderNote',
  'invoiceFooterNote',
  'deliveryDailyCap',
  'deliveryDailyPieceCap',
  'deliveryDailyCapacityUnits',
  'zipRoutes',
  'maxBalanceForTicketPrintCents',
  'reserveBasis',
  'returnWindowDays',
  'restockingFeePercent',
  'exchangeHoldAtEntry',
  'autoScheduleDays',
  'priceVariance',
] as const;

export interface PosSettings {
  id: string;
  name: string;
  currencyCode: string;
  defaultTaxRateBps: number;
  receiptHeader: string | null;
  receiptFooter: string | null;
  branding: BusinessBranding | null;
  ops: Pick<OpsSettings, (typeof POS_VISIBLE_OPS_KEYS)[number]> | null;
}

function toPosSettings(b: typeof schema.businesses.$inferSelect): PosSettings {
  const full = (b.opsSettingsJson as OpsSettings | null) ?? null;
  let ops: PosSettings['ops'] = null;
  if (full) {
    ops = {};
    for (const key of POS_VISIBLE_OPS_KEYS) {
      if (full[key] !== undefined) (ops as Record<string, unknown>)[key] = full[key];
    }
  }
  return {
    id: b.id,
    name: b.name,
    currencyCode: b.currencyCode,
    defaultTaxRateBps: b.defaultTaxRateBps,
    receiptHeader: b.receiptHeader ?? null,
    receiptFooter: b.receiptFooter ?? null,
    branding: (b.brandingJson as BusinessBranding | null) ?? null,
    ops,
  };
}

function toSettings(b: typeof schema.businesses.$inferSelect): BusinessSettings {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    status: b.status,
    plan: b.plan ?? null,
    currencyCode: b.currencyCode,
    defaultTaxRateBps: b.defaultTaxRateBps,
    receiptHeader: b.receiptHeader ?? null,
    receiptFooter: b.receiptFooter ?? null,
    branding: (b.brandingJson as BusinessBranding | null) ?? null,
    ops: (b.opsSettingsJson as OpsSettings | null) ?? null,
  };
}
