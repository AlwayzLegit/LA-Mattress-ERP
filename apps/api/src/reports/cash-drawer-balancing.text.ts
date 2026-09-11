import type {
  BalanceGroup,
  CashDrawerBalancingReport,
  PaymentLine,
} from './cash-drawer-balancing.controller';
import { clockStamp, fit, mmddyy, put, putRight, trimTo } from './text-layout';

/**
 * The STORIS AR.317 page layout for Report Cash Drawer Balancing Totals
 * (owner sample output, 2026-09-10): 132 Courier columns, a two-line
 * page header and two-line column header on every page, then the
 * register — Balance-By group → pay class → payment type → tender lines,
 * "Total For …" at each level right-aligned to column 78 with the amount
 * ending at column 89, a Grand Total, the Cash Drawer Reconciliation
 * block at column 42, and a final page echoing the parameters.
 *
 * Column positions are measured from the sample:
 *   code 0 · name 13 · reference 42 · tender 59 · amount →89 ·
 *   subtotal →100 · time 101 · drawer 109 · mgr 114 · init 120 · batch 127
 * Mgr and Batch are STORIS-only (manager override, deposit batch) and
 * print blank.
 */

export const REPORT_WIDTH = 132;
export const LINES_PER_PAGE = 52;

export interface RenderContext {
  businessName: string;
  generatedAt: Date;
  /** The clock the header stamps — the store's, or the business's working zone. */
  timezone: string;
}

const COL = {
  code: 0,
  name: 13,
  reference: 42,
  tender: 59,
  amountEnd: 89,
  subtotalEnd: 100,
  time: 101,
  drawer: 109,
  mgr: 114,
  init: 120,
  batch: 127,
  totalLabelEnd: 78,
  recon: 42,
  reconAmountEnd: 85,
  reconDashStart: 75,
} as const;

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${(Math.abs(cents) / 100).toFixed(2)}`;
}

const trim = (line: string) => trimTo(line, REPORT_WIDTH);

/**
 * The STORIS page header: reference at 0, the account banner centered on
 * the 132-column line, the clock at 113; the as-of date at 0, the title
 * at 49, the page number at 116.
 */
function pageHeader(report: CashDrawerBalancingReport, ctx: RenderContext, page: number): string[] {
  const asOf =
    report.range.start === report.range.end
      ? mmddyy(report.range.start)
      : `${mmddyy(report.range.start)} - ${mmddyy(report.range.end)}`;
  let l1 = put('', 0, 'Reference: AR.317.RPT');
  const banner = fit(`-=- ${ctx.businessName} -=-`, 66).trimEnd();
  l1 = put(l1, Math.max(24, Math.floor((REPORT_WIDTH - banner.length) / 2)), banner);
  l1 = put(l1, 113, clockStamp(ctx.generatedAt, ctx.timezone));
  let l2 = put('', 0, `As of Date ${asOf}`);
  l2 = put(l2, 49, 'Report Cash Drawer Balancing Totals');
  l2 = put(l2, 116, `Page: ${page}`);
  let h1 = put('', COL.code, 'Customer');
  h1 = put(h1, COL.tender, 'Payment Type');
  h1 = put(h1, 91, 'Reference');
  h1 = put(h1, 107, 'Drawer');
  h1 = put(h1, COL.init, 'Oper');
  let h2 = put('', COL.code, 'Code');
  h2 = put(h2, COL.name, 'Customer Name');
  h2 = put(h2, COL.reference, 'Reference');
  h2 = put(h2, COL.tender, 'Gift Cert./Chk. No.');
  h2 = put(h2, 83, 'Amount');
  h2 = put(h2, 92, 'Subtotal');
  h2 = put(h2, 102, 'Time');
  h2 = put(h2, 107, 'Number');
  h2 = put(h2, COL.mgr, 'Mgr');
  h2 = put(h2, COL.init, 'Init');
  h2 = put(h2, COL.batch, 'Batch');
  return [trim(l1), trim(l2), '', trim(h1), trim(h2), ''];
}

function totalLine(label: string, cents: number): string {
  let l = putRight('', COL.totalLabelEnd, label);
  l = putRight(l, COL.amountEnd, money(cents));
  return trim(l);
}

function tenderLine(l: PaymentLine): string {
  let s = put('', COL.code, fit(l.customerCode, 12));
  s = put(s, COL.name, fit(l.customerName, 28));
  s = put(s, COL.reference, fit(l.reference, 16));
  const tender = l.tenderRef
    ? `${shortType(l.paymentType)} ${l.tenderRef}`
    : shortType(l.paymentType);
  s = put(s, COL.tender, fit(tender, 22));
  s = putRight(s, COL.amountEnd, money(l.amountCents));
  s = putRight(s, COL.subtotalEnd, money(l.referenceSubtotalCents));
  s = put(s, COL.time, l.time);
  s = put(s, COL.drawer, fit(l.drawerNumber, 5));
  s = put(s, COL.init, fit(l.operatorInitials, 4));
  return trim(s);
}

/** "CARD - STRIPE" → "CARD": the STORIS total line names the short type. */
export function shortType(paymentType: string): string {
  return paymentType.split(' - ')[0]!.trim();
}

/** "Store 02 - WEST LA MATTRESS STOR": the kind in mixed case, the name shouted. */
function groupHeading(report: CashDrawerBalancingReport, g: BalanceGroup): string {
  if (report.balanceBy === 'operator') {
    return `Operator ${g.code ? `${g.code} - ` : ''}${g.label.toUpperCase()}`;
  }
  if (report.balanceBy === 'drawer') {
    const name = g.code ? `Drawer ${g.code}` : g.label;
    return `${name}${g.sublabel ? ` - ${g.sublabel.toUpperCase()}` : ''}`;
  }
  return `Store ${g.code ? `${g.code} - ` : ''}${g.label.toUpperCase()}`;
}

function groupTotalLabel(report: CashDrawerBalancingReport, g: BalanceGroup): string {
  if (report.balanceBy === 'operator') return `Total For Operator ${g.code ?? g.label}:`;
  if (report.balanceBy === 'drawer') return `Total For ${g.code ? `Drawer ${g.code}` : g.label}:`;
  return `Total For Store ${g.code ?? g.label}:`;
}

function reconciliation(cash: number, check: number, deposit: number): string[] {
  const row = (label: string, cents: number) =>
    trim(putRight(put('', COL.recon, label), COL.reconAmountEnd, money(cents)));
  return [
    put('', COL.recon, 'Cash Drawer Reconciliation:'),
    row('CASH', cash),
    row('CHECK', check),
    put('', COL.reconDashStart, '----------'),
    row('Total Deposit', deposit),
  ];
}

/**
 * The body lines, before pagination — spaced the way the STORIS spool is:
 * a blank line between payment types, the pay-class, group and grand
 * totals stacked directly under the last tender total, two blank lines
 * before the reconciliation block.
 */
export function renderCashDrawerBalancingBody(report: CashDrawerBalancingReport): string[] {
  const lines: string[] = [];
  report.groups.forEach((g, gi) => {
    if (gi > 0) lines.push('');
    lines.push(trim(groupHeading(report, g)), '');
    g.payClasses.forEach((pc, ci) => {
      if (ci > 0) lines.push('');
      lines.push(`Pay Class ${pc.code} - ${pc.label}`, '');
      pc.paymentTypes.forEach((pt, ti) => {
        if (ti > 0) lines.push('');
        lines.push(`Payment Type ${pt.label}`);
        for (const l of pt.lines) lines.push(tenderLine(l));
        lines.push(totalLine(`Total For Payment Type ${shortType(pt.label)}:`, pt.amountCents));
      });
      lines.push(totalLine(`Total For Pay Class ${pc.code}:`, pc.amountCents));
    });
    lines.push(totalLine(groupTotalLabel(report, g), g.amountCents));
    // Jetnine addition: the drawer counts that back the group's cash line.
    for (const d of g.drawers) {
      const state =
        d.status === 'balanced'
          ? `balanced${d.inTolerance === false ? ' - OUT OF TOLERANCE' : ''}`
          : 'open';
      let s = put('', COL.recon, `Drawer ${d.number} ${state}`);
      s = putRight(s, COL.reconAmountEnd, `float ${money(d.openingFloatCents)}`);
      if (d.varianceCents != null) {
        s = put(s, COL.reconAmountEnd + 2, `over/short ${money(d.varianceCents)}`);
      }
      lines.push(trim(s));
    }
  });
  if (report.groups.length === 0) {
    lines.push('No tenders in this window.');
  }
  lines.push(totalLine('Grand Total  :', report.amountCents), '', '');
  lines.push(
    ...reconciliation(
      report.reconciliation.cashCents,
      report.reconciliation.checkCents,
      report.reconciliation.depositCents,
    ),
  );
  return lines;
}

/** The parameter echo STORIS prints on its own final page. */
export function renderParameterPage(report: CashDrawerBalancingReport): string[] {
  const time = (t: string, def: string) => (t === def ? 'None' : t);
  const by = report.balanceBy === 'drawer' ? 'D' : report.balanceBy === 'operator' ? 'O' : 'S';
  const f = report.filters;
  return [
    `   Start Time: ${time(report.range.startTime, '00:00')}`,
    `   End Time: ${time(report.range.endTime, '23:59')}`,
    `   Balance By: ${by}`,
    `   Drawer: ${f.drawerId ?? 'All'}`,
    `   Operator: ${f.operatorName ?? f.operatorId ?? 'All'}`,
    `   Store: ${f.locationCode ?? f.locationName ?? f.locationId ?? 'All'}`,
    `   Bal Drawer Ref: ${f.drawerState === 'balanced' ? 'Yes' : 'All'}`,
    `   UnBal Drawer Ref: ${f.drawerState === 'unbalanced' ? 'Yes' : 'All'}`,
  ];
}

/** Every page, header included, ready for the PDF writer or a text file. */
export function renderCashDrawerBalancingPages(
  report: CashDrawerBalancingReport,
  ctx: RenderContext,
): string[][] {
  const body = renderCashDrawerBalancingBody(report);
  const pages: string[][] = [];
  const header = (n: number) => pageHeader(report, ctx, n);
  const room = LINES_PER_PAGE - header(1).length;
  for (let i = 0; i < Math.max(1, body.length); i += room) {
    pages.push([...header(pages.length + 1), ...body.slice(i, i + room)]);
  }
  pages.push([...header(pages.length + 1), ...renderParameterPage(report)]);
  return pages;
}

/** Plain text: pages separated by a form feed, the way a spooled report is. */
export function renderCashDrawerBalancingText(
  report: CashDrawerBalancingReport,
  ctx: RenderContext,
): string {
  return renderCashDrawerBalancingPages(report, ctx)
    .map((p) => p.join('\n'))
    .join('\n\f\n');
}
