import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { phoneDigits } from '@jetnine/shared';
import { AuditService } from '../audit/audit.service';
import { tzDayEndExclusive, tzDayStart } from '../common/date-range';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import type { RequestTenantContext } from '../tenancy/request-context';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

/**
 * Sales competitions (redesign Phase 11, README §3.6): six races a month
 * between people, computed from the order ledger every time the strip
 * asks. Only completed orders count; an order with a completed return
 * comes off the board; ties break by net sales; the sweep tiers replace
 * the per-card prizes. Imported legacy documents never count (D8).
 *
 * Every active member whose role can log a lead (`competitions.leads.log`),
 * except the Owner role, is on every card, sales or not (owner
 * 2026-09-13): the ranked rows come
 * first, then the people the race cannot rank yet (no sales for a $ race,
 * nothing at all for a count race) with no rank number. The Stores race
 * was retired the same day — only people compete.
 *
 * The service owns three side effects: converting a lead when an order
 * completes (phone match, same salesperson, inside the lead's window),
 * noticing an overtake (one inbox notice per race per day), and freezing
 * a closed month's winners the first time anyone reads it.
 */

export type RaceKey = 'leads' | 'avg' | 'high' | 'sales' | 'beds' | 'ex';
/** Only people compete (owner 2026-09-13); the column keeps the value for stored results. */
export type RaceScope = 'people';

export interface RaceDef {
  key: RaceKey;
  title: string;
  sub: string;
  metricLabel: string;
  detailLabel: string;
  unit: 'leads' | '$' | 'sales' | 'beds' | 'exchanges';
  rule: string;
  empty: string;
}

export const RACES: RaceDef[] = [
  {
    key: 'leads',
    title: 'Lead Conversion',
    sub: 'converted leads',
    metricLabel: 'Converted',
    detailLabel: 'Logged',
    unit: 'leads',
    rule: 'Lead converts when a completed order matches the phone within 30 days.',
    empty: 'No leads logged yet. Log the next customer who walks out without buying.',
  },
  {
    key: 'avg',
    title: 'Average Ticket',
    sub: 'net ÷ completed orders',
    metricLabel: 'Average',
    detailLabel: 'Orders',
    unit: '$',
    rule: 'No minimum order count — a one-sale average is fragile and says so.',
    empty: 'First completed sale sets the bar.',
  },
  {
    key: 'high',
    title: 'Highest Ticket',
    sub: 'one order',
    metricLabel: 'Order',
    detailLabel: 'Customer',
    unit: '$',
    rule: 'The single largest completed order this month.',
    empty: 'The first order of the month is the biggest — for now.',
  },
  {
    key: 'sales',
    title: 'Most Sales',
    sub: 'completed orders',
    metricLabel: 'Orders',
    detailLabel: 'Net',
    unit: 'sales',
    rule: 'Count of completed orders; net dollars shown small.',
    empty: 'Zero across the board. Every store starts even.',
  },
  {
    key: 'beds',
    title: 'Most Adjustable Beds',
    sub: 'units on completed orders',
    metricLabel: 'Beds',
    detailLabel: '',
    unit: 'beds',
    rule: 'Adjustable base units on completed orders.',
    empty: 'No bases sold yet.',
  },
  {
    key: 'ex',
    title: 'Least Exchanges',
    sub: 'fewest, as a fraction of sales',
    metricLabel: 'Exchanges',
    detailLabel: 'Sales',
    unit: 'exchanges',
    rule: 'Ties break by most sales. Zero sales is not ranked.',
    empty: 'Nobody has sold, so nobody is ranked. Sell first.',
  },
];

export const RACE_KEYS = RACES.map((r) => r.key);

/** Resolved settings — every knob has a value. */
export interface CompetitionConfig {
  enabled: boolean;
  cards: Record<RaceKey, { on: boolean; prizePeopleCents: number }>;
  sweep: { four: number; five: number; six: number };
  payoutDay: number;
  returnWindowDays: number;
  bannerDays: number;
  visibility: { sales: boolean; managers: boolean; warehouse: boolean; notices: boolean };
  leadWindowDays: number;
}

export const DEFAULT_CONFIG: CompetitionConfig = {
  enabled: true,
  cards: Object.fromEntries(
    RACE_KEYS.map((k) => [k, { on: true, prizePeopleCents: 10_000 }]),
  ) as CompetitionConfig['cards'],
  sweep: { four: 100_000, five: 150_000, six: 200_000 },
  payoutDay: 5,
  returnWindowDays: 30,
  bannerDays: 3,
  visibility: { sales: true, managers: true, warehouse: true, notices: true },
  leadWindowDays: 30,
};

export function resolveConfig(raw: unknown): CompetitionConfig {
  const r = (raw ?? {}) as Partial<CompetitionConfig> & {
    cards?: Partial<Record<RaceKey, Partial<CompetitionConfig['cards'][RaceKey]>>>;
    sweep?: Partial<CompetitionConfig['sweep']>;
    visibility?: Partial<CompetitionConfig['visibility']>;
  };
  // Every stored field may be null (SET-002: blank means the documented
  // default), so each one coalesces on its own — never a spread.
  const cards = {} as CompetitionConfig['cards'];
  for (const k of RACE_KEYS) {
    const c = r.cards?.[k];
    const d = DEFAULT_CONFIG.cards[k];
    cards[k] = {
      on: c?.on ?? d.on,
      prizePeopleCents: c?.prizePeopleCents ?? d.prizePeopleCents,
    };
  }
  return {
    enabled: r.enabled ?? DEFAULT_CONFIG.enabled,
    cards,
    sweep: {
      four: r.sweep?.four ?? DEFAULT_CONFIG.sweep.four,
      five: r.sweep?.five ?? DEFAULT_CONFIG.sweep.five,
      six: r.sweep?.six ?? DEFAULT_CONFIG.sweep.six,
    },
    payoutDay: r.payoutDay ?? DEFAULT_CONFIG.payoutDay,
    returnWindowDays: r.returnWindowDays ?? DEFAULT_CONFIG.returnWindowDays,
    bannerDays: r.bannerDays ?? DEFAULT_CONFIG.bannerDays,
    visibility: {
      sales: r.visibility?.sales ?? DEFAULT_CONFIG.visibility.sales,
      managers: r.visibility?.managers ?? DEFAULT_CONFIG.visibility.managers,
      warehouse: r.visibility?.warehouse ?? DEFAULT_CONFIG.visibility.warehouse,
      notices: r.visibility?.notices ?? DEFAULT_CONFIG.visibility.notices,
    },
    leadWindowDays: r.leadWindowDays ?? DEFAULT_CONFIG.leadWindowDays,
  };
}

// ---------------------------------------------------------------------------
// Wire shapes

export interface RaceOrder {
  id: string;
  number: string;
  who: string | null;
  amountCents: number;
  at: string;
}

export interface RaceRow {
  id: string;
  name: string;
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
  /** 1-based; null when the race cannot rank this person yet (listed after the ranked rows). */
  rank: number | null;
  /** The metric as an integer: cents for $ races, a count otherwise (0 when unranked). */
  value: number;
  valueLabel: string;
  /** "8 sales", "of 15", "SC-10234 · Priya" */
  detail: string;
  netCents: number;
  sales: number;
  /** Ten buckets across the month, raw metric per bucket. */
  spark: number[];
  orders: RaceOrder[];
  isYou: boolean;
}

export interface RaceCard extends RaceDef {
  on: boolean;
  prizeCents: number;
  /** Everyone, ranked rows first, then the unranked in name order. */
  rows: RaceRow[];
  /** The first three ranked rows (the collapsed strip, the winners). */
  top: RaceRow[];
  you: {
    rank: number | null;
    value: number | null;
    valueLabel: string;
    gap: string;
  } | null;
  unranked: string | null;
  leader: { name: string; value: number } | null;
  pace: { leaderPct: number; youPct: number; pacePct: number; label: string } | null;
  empty: string;
}

export interface WinnerLine {
  race: RaceKey;
  title: string;
  name: string | null;
  store: string | null;
  story: string;
  short: string;
  value: string;
  prizeCents: number;
}

export interface HistoryRow {
  month: string;
  label: string;
  race: RaceKey;
  title: string;
  winner: string | null;
  winnerStore: string | null;
  result: string;
  yourRank: number | null;
  paid: string;
}

export interface CompetitionBoard {
  month: string;
  monthLabel: string;
  today: string;
  dayOfMonth: number;
  daysInMonth: number;
  daysLeft: number;
  endsAt: string;
  last48: boolean;
  isDayOne: boolean;
  config: {
    prizeCents: number;
    sweep: CompetitionConfig['sweep'];
    payoutDay: number;
    payoutLabel: string;
    returnWindowDays: number;
  };
  viewer: {
    membershipId: string | null;
    name: string | null;
    storeId: string | null;
    storeName: string | null;
    canLog: boolean;
  };
  cards: RaceCard[];
  sweep: { name: string; n: number; bonus: string; isYou: boolean } | null;
  banner: {
    month: string;
    label: string;
    winners: WinnerLine[];
    until: string;
  } | null;
}

export interface LeadRow {
  id: string;
  name: string;
  phone: string;
  wanted: string;
  wantedSize: string | null;
  wantedCategory: string | null;
  note: string | null;
  status: 'open' | 'converted' | 'lost';
  loggedAt: string;
  expiresAt: string;
  daysLeft: number;
  followUpAt: string | null;
  convertedOrderId: string | null;
  convertedOrderNumber: string | null;
  conversion: 'auto' | 'manual' | null;
  salesperson: string;
  salespersonMembershipId: string;
  locationId: string;
}

// ---------------------------------------------------------------------------

interface CompletedOrder {
  id: string;
  number: string;
  locationId: string;
  repId: string | null;
  customer: string | null;
  netCents: number;
  completedAt: Date;
  day: number;
  beds: number;
}

interface Subject {
  id: string;
  name: string;
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
  orders: CompletedOrder[];
  netCents: number;
  sales: number;
  high: CompletedOrder | null;
  beds: number;
  exchanges: { number: string; who: string | null; at: Date; day: number }[];
  leadsLogged: number;
  leadsConverted: {
    number: string;
    who: string | null;
    amountCents: number;
    at: Date;
    day: number;
  }[];
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function usd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.trim().split(/\s+/)[0] ?? null;
}
function daysIn(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}
function monthName(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1]!;
}
function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}
function storeCodeOf(name: string, prefix: string | null): string {
  if (prefix) return prefix.toUpperCase().slice(0, 3);
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.map((w) => w[0]).join('') : name.slice(0, 2)).toUpperCase();
}

@Injectable()
export class CompetitionsService {
  private readonly logger = new Logger(CompetitionsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  // -------------------------------------------------------------------------
  // Settings + clock

  async config(businessId: string): Promise<CompetitionConfig> {
    const [b] = await this.db
      .select({ ops: schema.businesses.opsSettingsJson })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return resolveConfig((b?.ops as { competitions?: unknown } | null)?.competitions);
  }

  /** Selling stores (name order) and the business clock in the first store's timezone. */
  async clock(businessId: string): Promise<{
    tz: string;
    today: string;
    stores: { id: string; name: string; code: string; timezone: string }[];
  }> {
    const rows = await this.db
      .select({
        id: schema.locations.id,
        name: schema.locations.name,
        prefix: schema.locations.orderPrefix,
        timezone: schema.locations.timezone,
        type: schema.locations.locationType,
      })
      .from(schema.locations)
      .where(and(eq(schema.locations.businessId, businessId), eq(schema.locations.isActive, true)))
      .orderBy(asc(schema.locations.name));
    const stores = rows
      .filter((r) => r.type !== 'warehouse')
      .map((r) => ({
        id: r.id,
        name: r.name,
        code: storeCodeOf(r.name, r.prefix),
        timezone: r.timezone || 'America/Los_Angeles',
      }));
    const tz = stores[0]?.timezone ?? rows[0]?.timezone ?? 'America/Los_Angeles';
    const [c] = await this.db
      .select({ today: sql<string>`(now() AT TIME ZONE ${tz})::date::text` })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return { tz, today: c?.today ?? new Date().toISOString().slice(0, 10), stores };
  }

  /**
   * Who competes: every active member whose role can log a lead (Manager,
   * Cashier by default) — never the Owner role (owner 2026-09-13: the
   * owner is off the board entirely, ledger and all). They are on every
   * card from day one, sales or not — the store shown is the first one
   * their access covers until they sell somewhere.
   */
  private async competitors(
    businessId: string,
  ): Promise<{ id: string; name: string; storeId: string | null }[]> {
    const rows = await this.db
      .select({
        id: schema.memberships.id,
        name: schema.users.name,
        email: schema.users.email,
        storeId: sql<string | null>`(
          select mls.location_id from membership_location_scopes mls
          where mls.membership_id = ${schema.memberships.id}
          order by mls.location_id limit 1
        )`,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .innerJoin(
        schema.rolePermissions,
        and(
          eq(schema.rolePermissions.roleId, schema.memberships.roleId),
          eq(schema.rolePermissions.permission, 'competitions.leads.log'),
        ),
      )
      .where(
        and(
          eq(schema.memberships.businessId, businessId),
          eq(schema.memberships.status, 'active'),
          ne(schema.roles.name, 'Owner'),
        ),
      )
      .orderBy(asc(schema.users.name));
    return rows.map((r) => ({ id: r.id, name: r.name?.trim() || r.email, storeId: r.storeId }));
  }

  /** Memberships that never appear on the board: the Owner role, in any month. */
  private async nonCompetitors(businessId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(and(eq(schema.memberships.businessId, businessId), eq(schema.roles.name, 'Owner')));
    return new Set(rows.map((r) => r.id));
  }

  private async memberNames(businessId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({
        id: schema.memberships.id,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.businessId, businessId));
    return new Map(rows.map((r) => [r.id, r.name?.trim() || r.email]));
  }

  // -------------------------------------------------------------------------
  // The month's raw material

  private async loadMonth(businessId: string, month: string, tz: string, cfg: CompetitionConfig) {
    const first = `${month}-01`;
    const last = `${month}-${String(daysIn(month)).padStart(2, '0')}`;
    const from = tzDayStart(first, tz);
    const to = tzDayEndExclusive(last, tz);
    const dayOf = (col: unknown) => sql<number>`extract(day from (${col} AT TIME ZONE ${tz}))::int`;

    // Completed orders, minus any with a completed return inside the window.
    const orderRows = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        locationId: schema.orders.locationId,
        repId: schema.orders.salespersonMembershipId,
        totalCents: schema.orders.totalCents,
        taxCents: schema.orders.taxCents,
        completedAt: schema.orders.completedAt,
        day: dayOf(schema.orders.completedAt),
        customer: schema.customers.firstName,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, businessId),
          eq(schema.orders.status, 'completed'),
          isNull(schema.orders.importedAt),
          sql`${schema.orders.completedAt} >= ${from} AND ${schema.orders.completedAt} < ${to}`,
          sql`NOT EXISTS (
            SELECT 1 FROM order_returns r
            WHERE r.order_id = ${schema.orders.id}
              AND r.status = 'completed'
              AND r.completed_at <= ${schema.orders.completedAt} + make_interval(days => ${cfg.returnWindowDays})
          )`,
        ),
      )
      .orderBy(asc(schema.orders.completedAt));
    const orderIds = orderRows.map((o) => o.id);

    // Adjustable base units per order: category name first, description second.
    const bedsByOrder = new Map<string, number>();
    if (orderIds.length > 0) {
      const bedRows = await this.db
        .select({
          orderId: schema.orderLines.orderId,
          qty: sql<number>`coalesce(sum(${schema.orderLines.quantity}), 0)::int`,
        })
        .from(schema.orderLines)
        .leftJoin(
          schema.productVariants,
          eq(schema.productVariants.id, schema.orderLines.variantId),
        )
        .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
        .where(
          and(
            inArray(schema.orderLines.orderId, orderIds),
            sql`(${schema.categories.name} ILIKE '%adjustable%' OR ${schema.orderLines.description} ILIKE '%adjustable%')`,
          ),
        )
        .groupBy(schema.orderLines.orderId);
      for (const b of bedRows) bedsByOrder.set(b.orderId, b.qty);
    }

    const orders: CompletedOrder[] = orderRows.map((o) => ({
      id: o.id,
      number: o.number,
      locationId: o.locationId,
      repId: o.repId,
      customer: o.customer,
      netCents: o.totalCents - o.taxCents,
      completedAt: o.completedAt ?? new Date(),
      day: o.day,
      beds: bedsByOrder.get(o.id) ?? 0,
    }));

    // Exchanges opened this month, attributed to the original order's rep/store.
    const exchangeRows = await this.db
      .select({
        number: schema.exchanges.number,
        createdAt: schema.exchanges.createdAt,
        day: dayOf(schema.exchanges.createdAt),
        repId: schema.orders.salespersonMembershipId,
        locationId: schema.orders.locationId,
        customer: schema.customers.firstName,
      })
      .from(schema.exchanges)
      .innerJoin(
        schema.orders,
        eq(
          schema.orders.id,
          sql`coalesce(${schema.exchanges.originalOrderId}, ${schema.exchanges.saleOrderId})`,
        ),
      )
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.exchanges.businessId, businessId),
          sql`${schema.exchanges.status} <> 'cancelled'`,
          isNull(schema.orders.importedAt),
          sql`${schema.exchanges.createdAt} >= ${from} AND ${schema.exchanges.createdAt} < ${to}`,
        ),
      );

    // Leads logged this month (denominator) and converted this month.
    const leadRows = await this.db
      .select({
        id: schema.salesLeads.id,
        name: schema.salesLeads.name,
        repId: schema.salesLeads.salespersonMembershipId,
        locationId: schema.salesLeads.locationId,
        createdAt: schema.salesLeads.createdAt,
        convertedAt: schema.salesLeads.convertedAt,
        convertedDay: dayOf(schema.salesLeads.convertedAt),
        loggedInMonth: sql<boolean>`(${schema.salesLeads.createdAt} >= ${from} AND ${schema.salesLeads.createdAt} < ${to})`,
        convertedInMonth: sql<boolean>`(${schema.salesLeads.convertedAt} >= ${from} AND ${schema.salesLeads.convertedAt} < ${to})`,
        status: schema.salesLeads.status,
        orderNumber: schema.orders.number,
        orderNet: sql<number>`coalesce(${schema.orders.totalCents} - ${schema.orders.taxCents}, 0)::int`,
      })
      .from(schema.salesLeads)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.salesLeads.convertedOrderId))
      .where(
        and(
          eq(schema.salesLeads.businessId, businessId),
          sql`((${schema.salesLeads.createdAt} >= ${from} AND ${schema.salesLeads.createdAt} < ${to})
            OR (${schema.salesLeads.convertedAt} >= ${from} AND ${schema.salesLeads.convertedAt} < ${to}))`,
        ),
      );

    return { orders, exchangeRows, leadRows, from, to };
  }

  /**
   * Every person on the board with the month folded in: the competitors
   * first (all of them, zero to start), then anyone else the ledger names
   * — a former member's completed orders still count for the month. The
   * `excluded` memberships (the Owner role) never appear, sales or not.
   */
  private buildSubjects(
    data: Awaited<ReturnType<CompetitionsService['loadMonth']>>,
    names: Map<string, string>,
    stores: { id: string; name: string; code: string }[],
    competitors: { id: string; name: string; storeId: string | null }[],
    excluded: Set<string>,
  ): Map<string, Subject> {
    const byStore = new Map(stores.map((s) => [s.id, s]));
    const subjects = new Map<string, Subject>();
    const get = (key: string | null, storeId: string | null, name?: string): Subject | null => {
      if (!key || excluded.has(key)) return null;
      let s = subjects.get(key);
      if (!s) {
        const st = storeId ? byStore.get(storeId) : undefined;
        s = {
          id: key,
          name: name ?? names.get(key) ?? 'former member',
          storeId,
          storeCode: st?.code ?? null,
          storeName: st?.name ?? null,
          orders: [],
          netCents: 0,
          sales: 0,
          high: null,
          beds: 0,
          exchanges: [],
          leadsLogged: 0,
          leadsConverted: [],
        };
        subjects.set(key, s);
      }
      return s;
    };
    for (const c of competitors) get(c.id, c.storeId, c.name);
    for (const o of data.orders) {
      const s = get(o.repId, o.locationId);
      if (!s) continue;
      s.orders.push(o);
      s.netCents += o.netCents;
      s.sales += 1;
      s.beds += o.beds;
      if (!s.high || o.netCents > s.high.netCents) s.high = o;
      // The person's store is where they last sold.
      s.storeId = o.locationId;
      const st = byStore.get(o.locationId);
      s.storeCode = st?.code ?? null;
      s.storeName = st?.name ?? null;
    }
    for (const e of data.exchangeRows) {
      const s = get(e.repId, e.locationId);
      if (!s) continue;
      s.exchanges.push({ number: e.number, who: e.customer, at: e.createdAt, day: e.day });
    }
    for (const l of data.leadRows) {
      const s = get(l.repId, l.locationId);
      if (!s) continue;
      if (l.loggedInMonth) s.leadsLogged += 1;
      // A lead counts as converted in the month it converted — never in
      // the month it was logged.
      if (l.status === 'converted' && l.convertedInMonth && l.convertedAt && l.convertedDay) {
        s.leadsConverted.push({
          number: l.orderNumber ?? '—',
          who: l.name || null,
          amountCents: l.orderNet,
          at: l.convertedAt,
          day: l.convertedDay,
        });
      }
    }
    return subjects;
  }

  private metric(s: Subject, key: RaceKey): number | null {
    switch (key) {
      case 'leads':
        return s.leadsConverted.length;
      case 'avg':
        return s.sales ? Math.round(s.netCents / s.sales) : null;
      case 'high':
        return s.high ? s.high.netCents : null;
      case 'sales':
        return s.sales;
      case 'beds':
        return s.beds;
      case 'ex':
        return s.sales ? s.exchanges.length : null;
    }
  }

  private fmt(v: number, key: RaceKey): string {
    return key === 'avg' || key === 'high' ? usd(v) : String(v);
  }

  private detail(s: Subject, key: RaceKey): string {
    switch (key) {
      case 'leads':
        return `of ${s.leadsLogged}`;
      case 'avg':
        return plural(s.sales, 'sale');
      case 'high':
        return s.high ? `${s.high.number} · ${firstName(s.high.customer) ?? '—'}` : '';
      case 'sales':
        return usd(s.netCents);
      case 'beds':
        return '';
      case 'ex':
        return `of ${s.sales}`;
    }
  }

  private spark(s: Subject, key: RaceKey, daysInMonth: number): number[] {
    const buckets = new Array(10).fill(0) as number[];
    const idx = (day: number) => Math.min(9, Math.floor(((day - 1) / daysInMonth) * 10));
    if (key === 'leads') for (const l of s.leadsConverted) buckets[idx(l.day)]! += 1;
    else if (key === 'ex') for (const e of s.exchanges) buckets[idx(e.day)]! += 1;
    else if (key === 'beds') for (const o of s.orders) buckets[idx(o.day)]! += o.beds;
    else if (key === 'sales') for (const o of s.orders) buckets[idx(o.day)]! += 1;
    else if (key === 'high')
      for (const o of s.orders) buckets[idx(o.day)] = Math.max(buckets[idx(o.day)]!, o.netCents);
    else {
      const sums = new Array(10).fill(0) as number[];
      const counts = new Array(10).fill(0) as number[];
      for (const o of s.orders) {
        sums[idx(o.day)]! += o.netCents;
        counts[idx(o.day)]! += 1;
      }
      for (let i = 0; i < 10; i++) buckets[i] = counts[i] ? Math.round(sums[i]! / counts[i]!) : 0;
    }
    return buckets;
  }

  private ordersBehind(s: Subject, key: RaceKey): RaceOrder[] {
    const toRO = (o: CompletedOrder): RaceOrder => ({
      id: o.id,
      number: o.number,
      who: firstName(o.customer),
      amountCents: o.netCents,
      at: o.completedAt.toISOString(),
    });
    if (key === 'leads')
      return s.leadsConverted
        .slice(-6)
        .reverse()
        .map((l) => ({
          id: l.number,
          number: l.number,
          who: firstName(l.who),
          amountCents: l.amountCents,
          at: l.at.toISOString(),
        }));
    if (key === 'ex')
      return s.exchanges
        .slice(-6)
        .reverse()
        .map((e) => ({
          id: e.number,
          number: e.number,
          who: firstName(e.who),
          amountCents: 0,
          at: e.at.toISOString(),
        }));
    if (key === 'high') return s.high ? [toRO(s.high)] : [];
    if (key === 'beds')
      return s.orders
        .filter((o) => o.beds > 0)
        .slice(-6)
        .reverse()
        .map(toRO);
    return s.orders.slice(-6).reverse().map(toRO);
  }

  /**
   * Rank a race: value desc (ex asc), ties by net desc, then by sales desc.
   * Everyone comes back — the ranked rows first with 1-based ranks, then
   * the people the race cannot rank yet (no sales for a $ race or Least
   * Exchanges; neither a lead nor a sale for the count races) in name
   * order with `rank: null`.
   */
  private rank(
    subjects: Subject[],
    key: RaceKey,
  ): { s: Subject; v: number | null; rank: number | null }[] {
    const all = subjects.map((s) => ({ s, v: this.metric(s, key) }));
    const rankable = (r: { s: Subject; v: number | null }): r is { s: Subject; v: number } =>
      r.v !== null && (key === 'leads' || key === 'beds' ? r.v > 0 || r.s.sales > 0 : true);
    const ranked = all.filter(rankable);
    ranked.sort((a, b) => {
      const dv = key === 'ex' ? a.v - b.v : b.v - a.v;
      if (dv !== 0) return dv;
      if (key === 'ex' && b.s.sales !== a.s.sales) return b.s.sales - a.s.sales;
      if (b.s.netCents !== a.s.netCents) return b.s.netCents - a.s.netCents;
      return b.s.sales - a.s.sales;
    });
    const rest = all.filter((r) => !rankable(r)).sort((a, b) => a.s.name.localeCompare(b.s.name));
    return [
      ...ranked.map((r, i) => ({ ...r, rank: i + 1 })),
      ...rest.map((r) => ({ ...r, rank: null })),
    ];
  }

  private gapText(key: RaceKey, leaderV: number, mineV: number, leaderName: string): string {
    const d = key === 'ex' ? mineV - leaderV : leaderV - mineV;
    const who = firstName(leaderName) ?? leaderName;
    switch (key) {
      case 'leads':
        return `${plural(d, 'lead')} behind ${who}`;
      case 'sales':
        return `${plural(d, 'sale')} behind ${who}`;
      case 'beds':
        return `${plural(d, 'bed')} behind ${who}`;
      case 'ex':
        return `${d} more ${d === 1 ? 'exchange' : 'exchanges'} than ${who}`;
      default:
        return `${usd(d)} behind ${who}`;
    }
  }

  // -------------------------------------------------------------------------
  // The board

  /** Which store is "yours" for the lead form. */
  private async viewerStore(
    tenant: RequestTenantContext,
    stores: { id: string; name: string }[],
    subjectsPeople: Map<string, Subject>,
  ): Promise<{ id: string; name: string } | null> {
    const mine = tenant.membershipId ? subjectsPeople.get(tenant.membershipId) : undefined;
    if (mine?.storeId) {
      const st = stores.find((s) => s.id === mine.storeId);
      if (st) return st;
    }
    if (tenant.membershipId) {
      const rows = await this.db
        .select({ locationId: schema.membershipLocationScopes.locationId })
        .from(schema.membershipLocationScopes)
        .where(eq(schema.membershipLocationScopes.membershipId, tenant.membershipId));
      const st = stores.find((s) => rows.some((r) => r.locationId === s.id));
      if (st) return st;
    }
    return stores[0] ?? null;
  }

  async board(
    tenant: RequestTenantContext,
    opts: { month?: string } = {},
  ): Promise<CompetitionBoard> {
    const businessId = tenant.businessId!;
    const cfg = await this.config(businessId);
    const { tz, today, stores } = await this.clock(businessId);
    const month = opts.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : today.slice(0, 7);
    const dim = daysIn(month);
    const dayOfMonth = month === today.slice(0, 7) ? Number(today.slice(8, 10)) : dim;
    const daysLeft = Math.max(0, dim - dayOfMonth);

    const data = await this.loadMonth(businessId, month, tz, cfg);
    const names = await this.memberNames(businessId);
    // Today's roster only joins the live month. A closed month is what its
    // ledger says: no zero-sale "winner" from an empty month, no rank for
    // someone hired since.
    const competitors = month === today.slice(0, 7) ? await this.competitors(businessId) : [];
    const excluded = await this.nonCompetitors(businessId);
    const subjects = this.buildSubjects(data, names, stores, competitors, excluded);
    const viewerStore = await this.viewerStore(tenant, stores, subjects);
    // An owner watches the race; there is no pinned row for someone off the board.
    const meId =
      tenant.membershipId && !excluded.has(tenant.membershipId) ? tenant.membershipId : null;
    const isDayOne = data.orders.length === 0 && data.leadRows.length === 0;

    const cards: RaceCard[] = [];
    let sweepLeader: { id: string; name: string; n: number } | null = null;
    const leadCounts = new Map<string, { name: string; n: number }>();
    for (const def of RACES) {
      const card = cfg.cards[def.key];
      const ranked = this.rank([...subjects.values()], def.key);
      const rows: RaceRow[] = ranked.map((r, i) => ({
        id: r.s.id,
        name: r.s.name,
        storeId: r.s.storeId,
        storeCode: r.s.storeCode,
        storeName: r.s.storeName,
        rank: r.rank,
        value: r.v ?? 0,
        // A count race shows the zero; a $ race has nothing to show yet.
        valueLabel: r.v !== null ? this.fmt(r.v, def.key) : '—',
        detail: r.rank !== null || r.v !== null ? this.detail(r.s, def.key) : 'no sales yet',
        netCents: r.s.netCents,
        sales: r.s.sales,
        spark: this.spark(r.s, def.key, dim),
        orders: i < 12 || r.s.id === meId ? this.ordersBehind(r.s, def.key) : [],
        isYou: r.s.id === meId,
      }));
      const top = rows.filter((r) => r.rank !== null).slice(0, 3);
      // A zero cannot lead a count race; fewest exchanges (with sales) can.
      const leader = top[0] && (top[0].value > 0 || def.key === 'ex') ? top[0] : null;
      const mineRow = rows.find((r) => r.isYou) ?? null;
      const mine = mineRow && mineRow.rank !== null ? mineRow : null;
      const mineSubject = meId ? subjects.get(meId) : undefined;
      if (leader && card.on) {
        const cur = leadCounts.get(leader.id) ?? { name: leader.name, n: 0 };
        cur.n += 1;
        leadCounts.set(leader.id, cur);
      }
      const max = leader ? Math.max(leader.value, 1) : 1;
      const paceV = leader
        ? def.key === 'avg' || def.key === 'high' || def.key === 'ex'
          ? leader.value
          : Math.round((leader.value / Math.max(dayOfMonth, 1)) * dim)
        : 0;
      const paceMax = Math.max(max, paceV, 1);
      cards.push({
        ...def,
        on: card.on,
        prizeCents: card.prizePeopleCents,
        rows,
        top,
        you:
          mine && leader
            ? {
                rank: mine.rank,
                value: mine.value,
                valueLabel: mine.valueLabel,
                gap:
                  mine.rank === 1
                    ? 'you lead'
                    : this.gapText(def.key, leader.value, mine.value, leader.name),
              }
            : meId
              ? {
                  rank: mine?.rank ?? null,
                  value: mine?.value ?? null,
                  valueLabel: mineRow?.valueLabel ?? '—',
                  gap:
                    def.key === 'ex' && mineSubject && mineSubject.sales === 0
                      ? 'sell one to be ranked'
                      : 'nothing yet',
                }
              : null,
        unranked:
          def.key === 'ex' && mineSubject && mineSubject.sales === 0
            ? 'sell one to be ranked'
            : null,
        leader: leader ? { name: leader.name, value: leader.value } : null,
        pace:
          leader && !isDayOne
            ? {
                leaderPct: Math.round((leader.value / paceMax) * 100),
                youPct: mine ? Math.round((Math.max(mine.value, 0) / paceMax) * 100) : 0,
                pacePct: Math.round((paceV / paceMax) * 100),
                label: this.fmt(paceV, def.key),
              }
            : null,
        empty: def.empty,
      });
    }
    for (const [id, c] of leadCounts) {
      if (c.n >= 3 && (!sweepLeader || c.n > sweepLeader.n))
        sweepLeader = { id, name: c.name, n: c.n };
    }
    const sweep = sweepLeader
      ? {
          name: sweepLeader.id === meId ? 'You' : sweepLeader.name,
          n: sweepLeader.n,
          bonus:
            sweepLeader.n >= 6
              ? `${usd(cfg.sweep.six)} · clean sweep`
              : sweepLeader.n >= 5
                ? usd(cfg.sweep.five)
                : sweepLeader.n >= 4
                  ? usd(cfg.sweep.four)
                  : `one more for ${usd(cfg.sweep.four)}`,
          isYou: sweepLeader.id === meId,
        }
      : null;

    // Winner banner: the previous month's winners for the first bannerDays.
    let banner: CompetitionBoard['banner'] = null;
    if (month === today.slice(0, 7) && dayOfMonth <= cfg.bannerDays) {
      const prev = prevMonth(month);
      const winners = await this.winners(tenant, prev);
      if (winners.some((w) => w.name)) {
        banner = {
          month: prev,
          label: `${monthName(prev)} winners`,
          winners,
          until: `${month}-${String(cfg.bannerDays).padStart(2, '0')}`,
        };
      }
    }

    const endsAtDate = new Date(`${month}-${String(dim).padStart(2, '0')}T00:00:00Z`);
    const nm = nextMonth(month);
    return {
      month,
      monthLabel: monthName(month),
      today,
      dayOfMonth,
      daysInMonth: dim,
      daysLeft,
      endsAt: `${WEEKDAY_SHORT[endsAtDate.getUTCDay()]} ${monthName(month).slice(0, 3)} ${dim}, 11:59 PM`,
      last48: daysLeft <= 2 && daysLeft > 0,
      isDayOne,
      config: {
        prizeCents: cfg.cards.sales.prizePeopleCents,
        sweep: cfg.sweep,
        payoutDay: cfg.payoutDay,
        payoutLabel: `${monthName(nm).slice(0, 3)} ${cfg.payoutDay}`,
        returnWindowDays: cfg.returnWindowDays,
      },
      viewer: {
        membershipId: tenant.membershipId,
        name: tenant.membershipId ? (names.get(tenant.membershipId) ?? null) : null,
        storeId: viewerStore?.id ?? null,
        storeName: viewerStore?.name ?? null,
        canLog: tenant.permissions.has('competitions.leads.log') && !!tenant.membershipId,
      },
      cards,
      sweep,
      banner,
    };
  }

  // -------------------------------------------------------------------------
  // Closed months: winners, history, the sheet

  /** The winners of a closed month, frozen on first read. */
  async winners(tenant: RequestTenantContext, month: string): Promise<WinnerLine[]> {
    const scope: RaceScope = 'people';
    const businessId = tenant.businessId!;
    const existing = await this.db
      .select()
      .from(schema.competitionResults)
      .where(
        and(
          eq(schema.competitionResults.businessId, businessId),
          eq(schema.competitionResults.month, month),
          eq(schema.competitionResults.scope, scope),
        ),
      );
    let rows = existing;
    if (rows.length === 0) {
      const { today } = await this.clock(businessId);
      if (month >= today.slice(0, 7)) return [];
      const board = await this.board(tenant, { month });
      const values = board.cards.map((c) => {
        const w = c.top[0] ?? null;
        return {
          businessId,
          month,
          scope,
          race: c.key,
          winnerId: w?.id ?? null,
          winnerName: w?.name ?? null,
          winnerStore: w?.storeName ?? null,
          value: w?.value ?? null,
          story: w ? this.story(c.key, w) : null,
          short: w ? this.short(c.key, w) : null,
          prizeCents: c.on ? c.prizeCents : 0,
          rankingJson: c.rows.slice(0, 20).map((r) => ({
            id: r.id,
            name: r.name,
            store: r.storeName,
            rank: r.rank,
            value: r.value,
            valueLabel: r.valueLabel,
            detail: r.detail,
          })),
        };
      });
      if (values.length > 0) {
        await this.db.insert(schema.competitionResults).values(values).onConflictDoNothing();
        rows = await this.db
          .select()
          .from(schema.competitionResults)
          .where(
            and(
              eq(schema.competitionResults.businessId, businessId),
              eq(schema.competitionResults.month, month),
              eq(schema.competitionResults.scope, scope),
            ),
          );
      }
    }
    return RACES.map((def) => {
      const r = rows.find((x) => x.race === def.key);
      return {
        race: def.key,
        title: def.title,
        name: r?.winnerName ?? null,
        store: r?.winnerStore ?? null,
        story: r?.story ?? 'No one was ranked.',
        short: r?.short ?? '—',
        value: r?.value != null ? this.fmt(r.value, def.key) : '—',
        prizeCents: r?.prizeCents ?? 0,
      };
    });
  }

  private story(key: RaceKey, r: RaceRow): string {
    switch (key) {
      case 'leads':
        return (
          `${plural(r.value, 'lead')} converted ${r.detail}`.replace(' of ', ' of ') + ' logged'
        );
      case 'avg':
        return `${usd(r.value)} across ${r.detail}`;
      case 'high':
        return `${r.detail} — ${usd(r.value)}`;
      case 'sales':
        return `${plural(r.value, 'completed order')}, ${r.detail} net`;
      case 'beds':
        return `${plural(r.value, 'base')} on completed orders`;
      case 'ex':
        return `${plural(r.value, 'exchange')} on ${r.detail.replace('of ', '')} sales`;
    }
  }

  private short(key: RaceKey, r: RaceRow): string {
    switch (key) {
      case 'leads':
        return `${r.value} converted`;
      case 'avg':
        return `${usd(r.value)} avg`;
      case 'high':
        return usd(r.value);
      case 'sales':
        return plural(r.value, 'sale');
      case 'beds':
        return plural(r.value, 'bed');
      case 'ex':
        return `${r.value} ${r.detail}`;
    }
  }

  /** History rows for the last twelve closed months, every race. */
  async history(tenant: RequestTenantContext): Promise<HistoryRow[]> {
    const businessId = tenant.businessId!;
    const cfg = await this.config(businessId);
    const { today } = await this.clock(businessId);
    const out: HistoryRow[] = [];
    let month = prevMonth(today.slice(0, 7));
    for (let i = 0; i < 12; i++) {
      const people = await this.winners(tenant, month);
      if (people.every((w) => !w.name)) {
        month = prevMonth(month);
        continue;
      }
      const rows = await this.db
        .select({
          race: schema.competitionResults.race,
          ranking: schema.competitionResults.rankingJson,
          paidAt: schema.competitionResults.paidAt,
        })
        .from(schema.competitionResults)
        .where(
          and(
            eq(schema.competitionResults.businessId, businessId),
            eq(schema.competitionResults.month, month),
            eq(schema.competitionResults.scope, 'people'),
          ),
        );
      const nm = nextMonth(month);
      const payDay = `${nm}-${String(cfg.payoutDay).padStart(2, '0')}`;
      const payLabel = `${monthName(nm).slice(0, 3)} ${cfg.payoutDay}`;
      for (const w of people) {
        const r = rows.find((x) => x.race === w.race);
        const ranking = (r?.ranking ?? []) as { id: string; rank: number | null }[];
        const mine = tenant.membershipId ? ranking.find((x) => x.id === tenant.membershipId) : null;
        out.push({
          month,
          label: monthLabel(month),
          race: w.race,
          title: w.title,
          winner: w.name,
          winnerStore: w.store,
          result: w.short,
          yourRank: mine?.rank ?? null,
          paid: r?.paidAt
            ? `paid ${payLabel}`
            : today >= payDay
              ? `paid ${payLabel}`
              : `pays ${payLabel}`,
        });
      }
      month = prevMonth(month);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Leads

  async leads(tenant: RequestTenantContext, all: boolean): Promise<LeadRow[]> {
    const businessId = tenant.businessId!;
    const names = await this.memberNames(businessId);
    const mineOnly = !all || !tenant.permissions.has('reports.sales.view');
    const rows = await this.db
      .select({
        lead: schema.salesLeads,
        orderNumber: schema.orders.number,
      })
      .from(schema.salesLeads)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.salesLeads.convertedOrderId))
      .where(
        and(
          eq(schema.salesLeads.businessId, businessId),
          mineOnly
            ? tenant.membershipId
              ? eq(schema.salesLeads.salespersonMembershipId, tenant.membershipId)
              : sql`false`
            : // Someone else's leads stay behind the viewer's store scope.
              salesScopeCond(tenant, schema.salesLeads.locationId),
          gte(schema.salesLeads.createdAt, new Date(Date.now() - 90 * 86_400_000)),
        ),
      )
      .orderBy(desc(schema.salesLeads.createdAt))
      .limit(200);
    const now = Date.now();
    return rows.map(({ lead: l, orderNumber }) => ({
      id: l.id,
      name: l.name || 'Walk-in',
      phone: l.phone,
      wanted:
        [l.wantedSize, l.wantedCategory].filter(Boolean).join(', ') +
          (l.note ? `${l.wantedSize || l.wantedCategory ? ', ' : ''}${l.note}` : '') || '—',
      wantedSize: l.wantedSize,
      wantedCategory: l.wantedCategory,
      note: l.note,
      status: l.status as LeadRow['status'],
      loggedAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
      daysLeft: Math.max(0, Math.ceil((l.expiresAt.getTime() - now) / 86_400_000)),
      followUpAt: l.followUpAt ? l.followUpAt.toISOString() : null,
      convertedOrderId: l.convertedOrderId,
      convertedOrderNumber: orderNumber ?? null,
      conversion: (l.conversion as LeadRow['conversion']) ?? null,
      salesperson: names.get(l.salespersonMembershipId) ?? 'former member',
      salespersonMembershipId: l.salespersonMembershipId,
      locationId: l.locationId,
    }));
  }

  // -------------------------------------------------------------------------
  // Hooks

  /**
   * After an order completes: convert a matching open lead, then notice
   * anyone whose rank slipped. Never throws — the order is already done.
   */
  async onOrderCompleted(businessId: string, orderId: string): Promise<void> {
    try {
      await this.convertLeadFor(businessId, orderId);
      await this.noticeOvertakes(businessId, orderId);
    } catch (err) {
      this.logger.warn(
        `competition hook failed for order ${orderId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async convertLeadFor(businessId: string, orderId: string): Promise<void> {
    const [o] = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        repId: schema.orders.salespersonMembershipId,
        importedAt: schema.orders.importedAt,
        completedAt: schema.orders.completedAt,
        phone: schema.customers.phone,
        phone2: schema.customers.phone2,
        addressPhone: schema.orders.addressPhone,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.businessId, businessId)))
      .limit(1);
    if (!o || o.importedAt || !o.repId) return;
    const digits = [o.phone, o.phone2, o.addressPhone].map(phoneDigits).filter(Boolean);
    if (digits.length === 0) return;
    const keys = [...new Set(digits.map((d) => d.slice(-10)))];
    const at = o.completedAt ?? new Date();
    const [lead] = await this.db
      .select({ id: schema.salesLeads.id, name: schema.salesLeads.name })
      .from(schema.salesLeads)
      .where(
        and(
          eq(schema.salesLeads.businessId, businessId),
          eq(schema.salesLeads.salespersonMembershipId, o.repId),
          eq(schema.salesLeads.status, 'open'),
          sql`right(${schema.salesLeads.phoneDigits}, 10) IN (${sql.join(
            keys.map((k) => sql`${k}`),
            sql`, `,
          )})`,
          lt(schema.salesLeads.createdAt, at),
          sql`${schema.salesLeads.expiresAt} >= ${at.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(schema.salesLeads.createdAt))
      .limit(1);
    if (!lead) return;
    await this.db
      .update(schema.salesLeads)
      .set({
        status: 'converted',
        convertedOrderId: o.id,
        convertedAt: at,
        conversion: 'auto',
        updatedAt: new Date(),
      })
      .where(eq(schema.salesLeads.id, lead.id));
    await this.audit.log({
      action: 'lead.convert',
      targetType: 'sales_lead',
      targetId: lead.id,
      businessId,
      metadata: { orderId: o.id, orderNumber: o.number, conversion: 'auto', name: lead.name },
    });
    void this.webhooks.fire({
      businessId,
      eventType: 'lead.converted',
      payload: { leadId: lead.id, orderId: o.id, orderNumber: o.number, conversion: 'auto' },
    });
  }

  /** Compare the new People ranks with the stored ones; one notice per race per day. */
  private async noticeOvertakes(businessId: string, orderId: string): Promise<void> {
    const cfg = await this.config(businessId);
    if (!cfg.enabled) return;
    const { tz, today, stores } = await this.clock(businessId);
    const month = today.slice(0, 7);
    const data = await this.loadMonth(businessId, month, tz, cfg);
    const names = await this.memberNames(businessId);
    const competitors = await this.competitors(businessId);
    const excluded = await this.nonCompetitors(businessId);
    const people = this.buildSubjects(data, names, stores, competitors, excluded);
    const [order] = await this.db
      .select({ repId: schema.orders.salespersonMembershipId, number: schema.orders.number })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);

    const stored = await this.db
      .select({
        race: schema.competitionRanks.race,
        subjectId: schema.competitionRanks.subjectId,
        rank: schema.competitionRanks.rank,
      })
      .from(schema.competitionRanks)
      .where(
        and(
          eq(schema.competitionRanks.businessId, businessId),
          eq(schema.competitionRanks.month, month),
          eq(schema.competitionRanks.scope, 'people'),
        ),
      );
    const prev = new Map(stored.map((r) => [`${r.race}:${r.subjectId}`, r.rank]));

    const upserts: (typeof schema.competitionRanks.$inferInsert)[] = [];
    const notices: (typeof schema.memberNotifications.$inferInsert)[] = [];
    for (const def of RACES) {
      if (!cfg.cards[def.key].on) continue;
      const ranked = this.rank([...people.values()], def.key).filter(
        (r): r is { s: Subject; v: number; rank: number } => r.rank !== null,
      );
      ranked.forEach((r, i) => {
        const rank = r.rank;
        upserts.push({
          businessId,
          month,
          scope: 'people',
          race: def.key,
          subjectId: r.s.id,
          rank,
        });
        const before = prev.get(`${def.key}:${r.s.id}`);
        // A zero-sale row shuffling down when someone sells is not an overtake.
        if (
          cfg.visibility.notices &&
          before != null &&
          rank > before &&
          r.s.id !== order?.repId &&
          i > 0 &&
          (r.v > 0 || def.key === 'ex')
        ) {
          const leader = ranked[0]!;
          const passer = ranked[i - 1]!;
          notices.push({
            businessId,
            recipientMembershipId: r.s.id,
            actorMembershipId: order?.repId ?? null,
            orderId: null,
            kind: 'competition.overtaken',
            title: `Overtaken on ${def.title}`,
            message: `${firstName(passer.s.name) ?? passer.s.name} moved ahead with ${order?.number ?? 'a completed order'} — you are #${rank} now, ${this.gapText(def.key, leader.v, r.v, leader.s.name)}.`,
            eventKey: `competition:${month}:${def.key}:${today}`,
          });
        }
      });
    }
    if (upserts.length > 0) {
      await this.db
        .insert(schema.competitionRanks)
        .values(upserts)
        .onConflictDoUpdate({
          target: [
            schema.competitionRanks.businessId,
            schema.competitionRanks.month,
            schema.competitionRanks.scope,
            schema.competitionRanks.race,
            schema.competitionRanks.subjectId,
          ],
          set: { rank: sql`excluded.rank`, updatedAt: new Date() },
        });
    }
    if (notices.length > 0) {
      await this.db.insert(schema.memberNotifications).values(notices).onConflictDoNothing();
    }
  }
}
