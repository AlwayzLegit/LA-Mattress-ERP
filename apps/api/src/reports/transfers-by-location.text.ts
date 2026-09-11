import type {
  TransfersByLocationReport,
  TransfersByLocationTransfer,
} from './transfers-by-location.controller';
import { clockStamp, fit, mmddyy, put, putRight, trimTo, paginate } from './text-layout';

/**
 * The STORIS TE.324 spool for Report Transfers by Location (owner sample,
 * 2026-08-26): 132 Courier columns, a three-line page header and two-line
 * column header on every page, then one "Receiving Store:" block per
 * destination with a line per transfer line — Transfer Number · Transfer
 * Date · Sending Location · Transfer For · Product · Brand · Order Qty ·
 * Res Qty · BOy Qty · Manifest Number — and a "Vendor Model:" sub-line
 * when the variant carries one. Instructions print under the transfer
 * when the report asks for them.
 */

export const LINES_PER_PAGE = 52;

export interface RenderContext {
  businessName: string;
  generatedAt: Date;
  timezone: string;
}

const COL = {
  number: 0,
  date: 13,
  sending: 22,
  transferFor: 31,
  product: 53,
  brand: 70,
  orderEnd: 88,
  resEnd: 95,
  heldEnd: 102,
  manifestEnd: 131,
} as const;

const trim = (line: string) => trimTo(line);

export function transferForLabel(transferType: string): string {
  switch (transferType) {
    case 'replenishment':
      return 'STOCK';
    case 'auto':
      return 'STOCK (auto)';
    case 'floor_sample':
      return 'Floor Sample';
    case 'as_is':
      return 'Move To As-Is';
    case 'customer':
      return 'Customer';
    default:
      return transferType;
  }
}

function pageHeader(report: TransfersByLocationReport, ctx: RenderContext, page: number): string[] {
  const from = report.range.start ? mmddyy(report.range.start) : 'EARLIEST';
  const to = report.range.end ? mmddyy(report.range.end) : 'LATEST';
  let l1 = put('', 0, 'Reference: TE.324.RPT');
  const banner = fit(`-=- ${ctx.businessName} -=-`, 66).trimEnd();
  l1 = put(l1, Math.max(24, Math.floor((132 - banner.length) / 2)), banner);
  l1 = put(l1, 113, clockStamp(ctx.generatedAt, ctx.timezone));
  let l2 = put('', 0, `From ${from} To ${to}`);
  l2 = put(l2, 49, 'Report Transfers by Location');
  l2 = put(l2, 116, `Page: ${page}`);
  const scope =
    report.filters.reserveLevel === 'partial'
      ? 'For Partially Reserved Transfers'
      : report.filters.reserveLevel === 'full'
        ? 'For Fully Reserved Transfers'
        : 'For All Items';
  const l3 = put('', Math.max(0, Math.floor((132 - scope.length) / 2)), scope);
  let h1 = put('', COL.number, 'Transfer');
  h1 = put(h1, COL.date, 'Transfer');
  h1 = put(h1, COL.sending, 'Sending');
  h1 = putRight(h1, COL.orderEnd, 'Order');
  h1 = putRight(h1, COL.resEnd, 'Res');
  h1 = putRight(h1, COL.heldEnd, 'BOy');
  h1 = putRight(h1, COL.manifestEnd, 'Manifest');
  let h2 = put('', COL.number, 'Number');
  h2 = put(h2, COL.date, 'Date');
  h2 = put(h2, COL.sending, 'Location');
  h2 = put(h2, COL.transferFor, 'Transfer For');
  h2 = put(h2, COL.product, 'Product');
  h2 = put(h2, COL.brand, 'Brand');
  h2 = putRight(h2, COL.orderEnd, 'Qty');
  h2 = putRight(h2, COL.resEnd, 'Qty');
  h2 = putRight(h2, COL.heldEnd, 'Qty');
  h2 = putRight(h2, COL.manifestEnd, 'Number');
  return [trim(l1), trim(l2), trim(l3), '', trim(h1), trim(h2), ''];
}

function transferLines(t: TransfersByLocationTransfer, includeInstructions: boolean): string[] {
  const out: string[] = [];
  t.lines.forEach((l, i) => {
    let s = '';
    if (i === 0) {
      s = put(s, COL.number, fit(t.number, 12));
      s = put(s, COL.date, mmddyy(t.date));
      s = put(s, COL.sending, fit(t.fromLocationName, 8));
      s = put(s, COL.transferFor, fit(t.transferFor, 21));
    }
    s = put(s, COL.product, fit(l.sku ?? l.productName, 16));
    s = put(s, COL.brand, fit(l.brand, 12));
    s = putRight(s, COL.orderEnd, String(l.orderQty));
    s = putRight(s, COL.resEnd, String(l.resQty));
    s = putRight(s, COL.heldEnd, String(l.heldQty));
    if (i === 0 && t.manifestNumber) s = putRight(s, COL.manifestEnd, fit(t.manifestNumber, 12));
    out.push(trim(s));
    if (l.vendorModel) {
      out.push(trim(put('', COL.product, `Vendor Model: ${l.vendorModel}`)));
    }
  });
  if (includeInstructions && (t.instructions || t.notes)) {
    if (t.instructions) out.push(trim(put('', COL.product, `Instructions: ${t.instructions}`)));
    if (t.notes) out.push(trim(put('', COL.product, `Notes: ${t.notes}`)));
  }
  return out;
}

/** The body lines before pagination: a block per receiving store. */
export function renderTransfersByLocationBody(report: TransfersByLocationReport): string[] {
  const lines: string[] = [];
  if (report.groups.length === 0) {
    lines.push('No transfers match the parameters.');
    return lines;
  }
  report.groups.forEach((g, gi) => {
    if (gi > 0) lines.push('');
    lines.push(trim(`Receiving Store:  ${g.locationName.toUpperCase()}`), '');
    for (const t of g.transfers)
      lines.push(...transferLines(t, report.filters.includeInstructions));
    let total = put('', COL.transferFor, fit(`Total For ${g.locationName}:`, 21));
    total = putRight(total, COL.orderEnd, String(g.totals.orderQty));
    total = putRight(total, COL.resEnd, String(g.totals.resQty));
    total = putRight(total, COL.heldEnd, String(g.totals.heldQty));
    lines.push(trim(total));
  });
  lines.push('');
  let grand = put('', COL.transferFor, 'Grand Total:');
  grand = putRight(grand, COL.orderEnd, String(report.totals.orderQty));
  grand = putRight(grand, COL.resEnd, String(report.totals.resQty));
  grand = putRight(grand, COL.heldEnd, String(report.totals.heldQty));
  lines.push(trim(grand));
  return lines;
}

export function renderTransfersByLocationPages(
  report: TransfersByLocationReport,
  ctx: RenderContext,
): string[][] {
  return paginate(
    renderTransfersByLocationBody(report),
    (n) => pageHeader(report, ctx, n),
    LINES_PER_PAGE,
  );
}

/** Plain text: pages separated by a form feed, the way a spooled report is. */
export function renderTransfersByLocationText(
  report: TransfersByLocationReport,
  ctx: RenderContext,
): string {
  return renderTransfersByLocationPages(report, ctx)
    .map((p) => p.join('\n'))
    .join('\n\f\n');
}
