/** Wire shapes for `/v1/competitions/*` (redesign Phase 11). */

export type RaceKey = 'leads' | 'avg' | 'high' | 'sales' | 'beds' | 'ex';

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
  value: number;
  valueLabel: string;
  detail: string;
  netCents: number;
  sales: number;
  spark: number[];
  orders: RaceOrder[];
  isYou: boolean;
}

export interface RaceCard {
  key: RaceKey;
  title: string;
  sub: string;
  metricLabel: string;
  detailLabel: string;
  unit: 'leads' | '$' | 'sales' | 'beds' | 'exchanges';
  rule: string;
  empty: string;
  on: boolean;
  prizeCents: number;
  /** Everyone who competes, ranked rows first, then the unranked in name order. */
  rows: RaceRow[];
  /** The first three ranked rows (the collapsed strip). */
  top: RaceRow[];
  you: { rank: number | null; value: number | null; valueLabel: string; gap: string } | null;
  unranked: string | null;
  leader: { name: string; value: number } | null;
  pace: { leaderPct: number; youPct: number; pacePct: number; label: string } | null;
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
    sweep: { four: number; five: number; six: number };
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

export interface WinnersSheet {
  month: string;
  label: string;
  payoutLabel: string;
  /** One prize for every race, or null when they differ — then each winner shows its own. */
  prizeCents: number | null;
  winners: WinnerLine[];
}

export const LEAD_SIZES = ['Twin', 'Twin XL', 'Full', 'Queen', 'King', 'Cal King'];
export const LEAD_CATEGORIES = [
  'Hybrid',
  'Memory foam',
  'Innerspring',
  'Adjustable base',
  'Specific product',
];

export function usdWholeCents(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

/** Fires the strip's refresh on any screen after a lead or a sale changes. */
export const COMPETITION_EVENT = 'erp:competition-update';
export function pingCompetition(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMPETITION_EVENT));
}
