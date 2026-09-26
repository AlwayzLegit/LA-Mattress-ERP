/**
 * Report Written Sales Dollars — the shapes `GET /v1/reports/written-sales`
 * returns and the small pure helpers the three views share (owner
 * 2026-09-26 audit: "more helpful, useful, friendly, compact").
 */

export type OrderTypeFilter = 'both' | 'orders' | 'adjustments';
export type View = 'summary' | 'orders' | 'lines';

export interface Totals {
  merchCents: number;
  profitCents: number | null;
  profitPct: number | null;
  chargesCents: number;
  discountCents: number;
  miscFeeCents: number;
  taxCents: number;
  totalCents: number;
  documents: number;
}
export interface Line {
  lineId: string;
  quantity: number;
  productNumber: string | null;
  description: string;
  merchCents: number;
  profitCents: number | null;
  profitPct: number | null;
  enteredBy: string | null;
}
export interface Doc {
  documentType: 'order' | 'sale' | 'adjustment';
  documentId: string;
  number: string;
  date: string;
  time: string;
  customerId?: string | null;
  customerCode: string | null;
  customerName: string | null;
  customerPhone?: string | null;
  customerDisplayName?: string | null;
  address: string | null;
  salespeople: string[];
  salespersonShares?: { name: string; bps: number }[];
  marketingCode: string | null;
  adjustmentKind: 'price_adjustment' | 'cancellation' | 'lines_added' | null;
  adjustmentReason: string | null;
  comments: string[];
  lines: Line[];
  totals: Totals;
}
export interface TypeGroup {
  key: string;
  label: string;
  documents: Doc[];
  totals: Totals;
}
export interface LocationGroup {
  locationId: string;
  locationName: string;
  types: TypeGroup[];
  totals: Totals;
}
export interface Report {
  generatedAt: string;
  range: { start: string; end: string };
  orderType: OrderTypeFilter;
  reportType: 'detail' | 'summary';
  canSeeProfit: boolean;
  locations: LocationGroup[];
  totals: Totals;
}

export const ORDER_TYPES: { key: OrderTypeFilter; label: string }[] = [
  { key: 'both', label: 'All' },
  { key: 'orders', label: 'Sales' },
  { key: 'adjustments', label: 'Adjustments' },
];
export const VIEWS: { key: View; label: string; hint: string }[] = [
  { key: 'summary', label: 'Summary', hint: 'Totals by store and by salesperson' },
  { key: 'orders', label: 'Orders', hint: 'One row per order; open a row for its items' },
  { key: 'lines', label: 'Lines', hint: 'Every item line — the STORIS layout' },
];

export const ADJUSTMENT_LABEL: Record<NonNullable<Doc['adjustmentKind']>, string> = {
  price_adjustment: 'Price adjustment',
  cancellation: 'Cancellation',
  lines_added: 'Lines added',
};

export function docHref(d: Doc): string {
  return d.documentType === 'sale' ? `/sales/${d.documentId}` : `/orders/${d.documentId}`;
}

/** "2026-09-26" → "09/26/26". */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${m}/${d}/${y.slice(2)}` : iso;
}

/** "13:54" → "1:54 PM". */
export function fmtTime(hm: string): string {
  const [h, m] = hm.split(':').map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return hm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function fmtPct(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toFixed(1)}%`;
}

/** A variant with no real option prints as "Lamp — Default"; the suffix says nothing. */
export function cleanDescription(description: string): string {
  return description.replace(/\s+[—-]\s+default$/i, '');
}

/** "Maria Gonzalez", falling back to the STORIS "GONZALEZ MARIA". */
export function customerLabel(d: Doc): string {
  return d.customerDisplayName || d.customerName || '—';
}

export function isAdjustment(d: Doc): boolean {
  return d.documentType === 'adjustment';
}

export function allDocs(report: Report): { loc: LocationGroup; t: TypeGroup; d: Doc }[] {
  return report.locations.flatMap((loc) =>
    loc.types.flatMap((t) => t.documents.map((d) => ({ loc, t, d }))),
  );
}

/** Search across order number, customer, phone (digits) and salespeople. */
export function docMatches(d: Doc, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  const hay = [
    d.number,
    d.customerDisplayName,
    d.customerName,
    d.customerPhone,
    ...d.salespeople,
    d.marketingCode,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (hay.includes(q)) return true;
  if (digits.length >= 3 && (d.customerPhone ?? '').replace(/\D/g, '').includes(digits))
    return true;
  return false;
}

export interface Headline {
  writtenCents: number;
  orders: number;
  averageCents: number | null;
  adjustmentsCents: number;
  adjustments: number;
}

/**
 * The numbers row: what was written (sales net of adjustments = the report
 * total), how many sales, their average, and how much adjustments moved.
 */
export function headline(report: Report): Headline {
  let salesTotal = 0;
  let orders = 0;
  let adjustmentsCents = 0;
  let adjustments = 0;
  for (const { d } of allDocs(report)) {
    if (isAdjustment(d)) {
      adjustmentsCents += d.totals.totalCents;
      adjustments += 1;
    } else {
      salesTotal += d.totals.totalCents;
      orders += 1;
    }
  }
  return {
    writtenCents: report.totals.totalCents,
    orders,
    averageCents: orders > 0 ? Math.round(salesTotal / orders) : null,
    adjustmentsCents,
    adjustments,
  };
}

export interface SalespersonRow {
  name: string;
  /** Sales the person is on (a split sale counts for both). */
  orders: number;
  /** Credited amounts: each document's figures × the person's share. */
  totalCents: number;
  merchCents: number;
  profitCents: number | null;
  profitPct: number | null;
}

export const NO_SALESPERSON = 'No salesperson';

/**
 * Written sales by salesperson, credited the way commissions are: a split
 * sale is shared by its split, otherwise the first salesperson takes it.
 * Adjustments count against whoever wrote the original.
 */
export function bySalesperson(report: Report): SalespersonRow[] {
  const rows = new Map<
    string,
    { orders: number; total: number; merch: number; profit: number; profitKnown: boolean }
  >();
  for (const { d } of allDocs(report)) {
    const shares =
      d.salespersonShares && d.salespersonShares.length > 0
        ? d.salespersonShares
        : d.salespeople[0]
          ? [{ name: d.salespeople[0], bps: 10_000 }]
          : [{ name: NO_SALESPERSON, bps: 10_000 }];
    for (const { name, bps } of shares) {
      const r = rows.get(name) ?? { orders: 0, total: 0, merch: 0, profit: 0, profitKnown: true };
      const f = bps / 10_000;
      if (!isAdjustment(d)) r.orders += 1;
      r.total += d.totals.totalCents * f;
      r.merch += d.totals.merchCents * f;
      if (d.totals.profitCents == null) r.profitKnown = false;
      else r.profit += d.totals.profitCents * f;
      rows.set(name, r);
    }
  }
  return [...rows.entries()]
    .map(([name, r]) => {
      const merchCents = Math.round(r.merch);
      const profitCents = r.profitKnown ? Math.round(r.profit) : null;
      return {
        name,
        orders: r.orders,
        totalCents: Math.round(r.total),
        merchCents,
        profitCents,
        profitPct:
          profitCents == null || merchCents === 0
            ? null
            : Math.round((profitCents / merchCents) * 1000) / 10,
      };
    })
    .sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name));
}

/** Charges and misc fees are $0 on most reports; their columns show only when something is. */
export function usedColumns(report: Report): { charges: boolean; miscFee: boolean } {
  return {
    charges:
      report.totals.chargesCents !== 0 ||
      allDocs(report).some((x) => x.d.totals.chargesCents !== 0),
    miscFee:
      report.totals.miscFeeCents !== 0 ||
      allDocs(report).some((x) => x.d.totals.miscFeeCents !== 0),
  };
}

export function itemCount(d: Doc): number {
  return d.lines.reduce((s, l) => s + l.quantity, 0);
}

export function costCents(t: Pick<Totals, 'merchCents' | 'profitCents'>): number | null {
  return t.profitCents == null ? null : t.merchCents - t.profitCents;
}
