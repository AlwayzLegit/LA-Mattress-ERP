'use client';

import { Download, Printer, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { rangeToSearch } from '@/lib/date-range';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  cx,
  EmptyState,
  Input,
  LoadingRows,
  PageHeader,
} from '@/components/ui';
import styles from './written-sales.module.css';
import { Popover, Segmented, StoreSelect } from './filters';
import { LinesView } from './lines-view';
import { OrdersView } from './orders-view';
import { SummaryView } from './summary-view';
import {
  allDocs,
  docMatches,
  fmtDate,
  fmtPct,
  headline,
  ORDER_TYPES,
  VIEWS,
  type Doc,
  type OrderTypeFilter,
  type Report,
  type View,
} from './ws-lib';

/**
 * Report Written Sales Dollars (STORIS TE.320, owner 2026-09-02; reworked
 * after the owner's 2026-09-26 UX audit: "more helpful, useful, friendly,
 * compact").
 *
 * - One filter row that applies as you change it (no Run button): dates,
 *   stores (a checklist), All / Sales / Adjustments, the view, a search,
 *   and the rarely-changed switches under More.
 * - One row of headline numbers instead of six tiles plus a Grand total
 *   card that repeated them.
 * - Three views: Summary (by store and by salesperson), Orders (one row
 *   per order, open for items — the default) and Lines (the STORIS body).
 *   Print prints the view on screen; CSV keeps the STORIS columns.
 */

interface Location {
  id: string;
  name: string;
}

export default function WrittenSalesPage() {
  const [range, setRange, rangeReady] = useUrlDateRange('today');
  const [orderType, setOrderType] = useState<OrderTypeFilter>('both');
  const [view, setView] = useState<View>('orders');
  const [includeAuditComments, setIncludeAuditComments] = useState(false);
  const [includeAllSalespeople, setIncludeAllSalespeople] = useState(true);
  const [includeAddress, setIncludeAddress] = useState(true);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [paramsReady, setParamsReady] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const ot = p.get('orderType');
    if (ot === 'orders' || ot === 'adjustments' || ot === 'both') setOrderType(ot);
    const v = p.get('view');
    if (v === 'summary' || v === 'orders' || v === 'lines') setView(v);
    // Links saved before the redesign.
    else if (p.get('reportType') === 'summary') setView('summary');
    if (p.get('audit') === '1') setIncludeAuditComments(true);
    if (p.get('allSalespeople') === '0') setIncludeAllSalespeople(false);
    if (p.get('address') === '0') setIncludeAddress(false);
    const locs = p.get('locationId');
    if (locs) setLocationIds(locs.split(',').filter(Boolean));
    setSearch(p.get('q') ?? '');
    setParamsReady(true);
  }, []);

  useEffect(() => {
    api<Location[]>('/v1/business/locations')
      // Every location, warehouses included — orders written while acting
      // for a warehouse are attributed to it (owner 2026-09-25).
      .then(setLocations)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // The screen always reads the detail; summary is worked out here, so
  // switching views never waits on the server.
  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set('start', range.start);
    p.set('end', range.end);
    p.set('orderType', orderType);
    p.set('reportType', 'detail');
    p.set('includeAuditComments', String(includeAuditComments));
    p.set('includeAllSalespeople', String(includeAllSalespeople));
    p.set('includeAddress', String(includeAddress));
    if (locationIds.length) p.set('locationId', locationIds.join(','));
    return p.toString();
  }, [range, orderType, includeAuditComments, includeAllSalespeople, includeAddress, locationIds]);

  const run = useCallback(async () => {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Report>(`/v1/reports/written-sales?${query}`);
      if (mine === seq.current) setReport(r);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, [query]);

  // Filters apply as they change (debounced so a date typed digit by digit
  // is one request).
  useEffect(() => {
    if (!rangeReady || !paramsReady) return;
    const h = window.setTimeout(() => void run(), 200);
    return () => window.clearTimeout(h);
  }, [run, rangeReady, paramsReady]);

  // The URL carries every choice, so a reload or a shared link lands here.
  useEffect(() => {
    if (!rangeReady || !paramsReady) return;
    const url = new URL(window.location.href);
    const p = url.searchParams;
    rangeToSearch(range, p);
    p.delete('reportType');
    for (const [k, v] of [
      ['orderType', orderType === 'both' ? '' : orderType],
      ['view', view === 'orders' ? '' : view],
      ['audit', includeAuditComments ? '1' : ''],
      ['allSalespeople', includeAllSalespeople ? '' : '0'],
      ['address', includeAddress ? '' : '0'],
      ['locationId', locationIds.join(',')],
      ['q', search.trim()],
    ] as const) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    window.history.replaceState(null, '', url.toString());
  }, [
    rangeReady,
    paramsReady,
    range,
    orderType,
    view,
    includeAuditComments,
    includeAllSalespeople,
    includeAddress,
    locationIds,
    search,
  ]);

  async function exportCsv() {
    setExporting(true);
    try {
      const csvQuery = query.replace(
        'reportType=detail',
        `reportType=${view === 'summary' ? 'summary' : 'detail'}`,
      );
      await downloadFile(
        `/v1/reports/written-sales?${csvQuery}&format=csv`,
        `written-sales-${range.start}-to-${range.end}.csv`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  const matches = useCallback((d: Doc) => docMatches(d, search), [search]);
  const docs = useMemo(() => (report ? allDocs(report) : []), [report]);
  const shownCount = useMemo(() => docs.filter((x) => matches(x.d)).length, [docs, matches]);
  const head = report ? headline(report) : null;
  const profit = report?.canSeeProfit ?? false;
  const moreSet = includeAuditComments || !includeAllSalespeople || !includeAddress;
  const rangeLabel = report
    ? `${fmtDate(report.range.start)}${report.range.end !== report.range.start ? ` – ${fmtDate(report.range.end)}` : ''}`
    : '';

  return (
    <div data-testid="written-sales" className={styles.report}>
      <PageHeader
        eyebrow={<BackLink href="/reports">Reports</BackLink>}
        title="Report Written Sales Dollars"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => window.print()} disabled={!report}>
              <Printer size={14} />
              Print
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void exportCsv()}
              disabled={exporting}
              title={
                view === 'summary' ? 'Totals only, STORIS columns' : 'Every line, STORIS columns'
              }
            >
              <Download size={14} />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          </>
        }
      />
      {report && (
        <p className={styles.printMeta}>
          {rangeLabel} · {ORDER_TYPES.find((t) => t.key === report.orderType)?.label} ·{' '}
          {VIEWS.find((v) => v.key === view)?.label}
          {search.trim() ? ` · matching "${search.trim()}"` : ''} · {report.totals.documents}{' '}
          {report.totals.documents === 1 ? 'document' : 'documents'} · printed{' '}
          {new Date().toLocaleString()}
        </p>
      )}

      <div className={cx(styles.filterBar, 'no-print')} data-testid="ws-params">
        <DateRangePicker value={range} onChange={setRange} compact testid="ws-range" />
        <StoreSelect locations={locations} value={locationIds} onChange={setLocationIds} />
        <Segmented
          options={ORDER_TYPES}
          value={orderType}
          onChange={setOrderType}
          label="Which transactions"
          testid="ws-order-type"
        />
        <Segmented options={VIEWS} value={view} onChange={setView} label="View" testid="ws-view" />
        {view !== 'summary' && (
          <label className={styles.searchBox}>
            <Search size={14} aria-hidden />
            <Input
              type="search"
              placeholder="Search customer, phone, order #"
              aria-label="Search the report"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="ws-search"
            />
          </label>
        )}
        <Popover label="More" active={moreSet} testid="ws-more" align="right">
          <label className={styles.popOption}>
            <input
              type="checkbox"
              checked={includeAllSalespeople}
              onChange={(e) => setIncludeAllSalespeople(e.target.checked)}
            />
            Show both salespeople on split sales
          </label>
          <label className={styles.popOption}>
            <input
              type="checkbox"
              checked={includeAddress}
              onChange={(e) => setIncludeAddress(e.target.checked)}
              data-testid="ws-address"
            />
            Include the ship-to address
          </label>
          <label className={styles.popOption}>
            <input
              type="checkbox"
              checked={includeAuditComments}
              onChange={(e) => setIncludeAuditComments(e.target.checked)}
              data-testid="ws-audit"
            />
            Include order notes and audit comments
          </label>
        </Popover>
        <span className={styles.busy} aria-live="polite" data-testid="ws-status">
          {busy ? 'Updating…' : ''}
        </span>
      </div>

      {error && (
        <Alert tone="error" className="no-print">
          {error}
        </Alert>
      )}

      {!report && !error && (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      )}

      {report && head && (
        <div className={cx(styles.body, busy && styles.stale)}>
          <dl className={styles.headline} data-testid="ws-headline">
            <div className={styles.headlineMain}>
              <dt>Written</dt>
              <dd data-testid="ws-written">
                <Money cents={head.writtenCents} />
              </dd>
            </div>
            <div>
              <dt>Sales</dt>
              <dd>{head.orders}</dd>
            </div>
            <div>
              <dt>Avg sale</dt>
              <dd>{head.averageCents == null ? '—' : <Money cents={head.averageCents} />}</dd>
            </div>
            <div>
              <dt>Merch</dt>
              <dd>
                <Money cents={report.totals.merchCents} />
              </dd>
            </div>
            {profit && (
              <div>
                <dt>Gross profit</dt>
                <dd>
                  {report.totals.profitCents == null ? (
                    '—'
                  ) : (
                    <>
                      <Money cents={report.totals.profitCents} />{' '}
                      <span className={styles.headlinePct}>{fmtPct(report.totals.profitPct)}</span>
                    </>
                  )}
                </dd>
              </div>
            )}
            <div>
              <dt>Tax</dt>
              <dd>
                <Money cents={report.totals.taxCents} />
              </dd>
            </div>
            {head.adjustments > 0 && (
              <div>
                <dt>Adjustments ({head.adjustments})</dt>
                <dd>
                  <Money cents={head.adjustmentsCents} />
                </dd>
              </div>
            )}
          </dl>
          {!profit && (
            <p className={cx(styles.note, 'no-print')}>
              Cost and gross profit are hidden — they need the financial reports permission.
            </p>
          )}

          {report.locations.length === 0 ? (
            <Card>
              <EmptyState>
                Nothing written {rangeLabel ? `on ${rangeLabel}` : 'in this window'}.
              </EmptyState>
            </Card>
          ) : view === 'summary' ? (
            <SummaryView report={report} />
          ) : (
            <>
              {search.trim() && (
                <p className={cx(styles.note, 'no-print')} data-testid="ws-search-count">
                  {shownCount === 0
                    ? `Nothing matches "${search.trim()}".`
                    : `Showing ${shownCount} of ${docs.length} — totals stay for the whole report.`}
                </p>
              )}
              {view === 'orders' ? (
                <OrdersView report={report} matches={matches} />
              ) : (
                <LinesView report={report} matches={matches} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
