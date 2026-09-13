'use client';

import { Download, FileText, Play, Printer } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { rangeToSearch } from '@/lib/date-range';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import { Money } from '@/components/money';
import Link from 'next/link';
import {
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  Field,
  Input,
  type ListColumns,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  useListColumns,
} from '@/components/ui';

/**
 * Report Cash Drawer Balancing Totals (STORIS AR.317, owner 2026-09-02).
 * The parameter card mirrors the STORIS screen — balance date, starting
 * and ending time, Balance By drawer/operator/store, drawer, operator,
 * store, balanced/unbalanced drawer reference — and the output is the
 * same register: group → pay class → payment type → tender lines with
 * subtotals, a grand total and the Cash Drawer Reconciliation.
 */

type BalanceBy = 'drawer' | 'operator' | 'store';
type DrawerState = 'all' | 'balanced' | 'unbalanced';

interface DrawerBalance {
  id: string;
  number: string;
  locationName: string;
  operatorName: string;
  openedAt: string;
  closedAt: string | null;
  status: 'balanced' | 'open';
  openingFloatCents: number;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
  inTolerance: boolean | null;
}
interface PaymentLine {
  paymentId: string;
  documentType: 'sale' | 'order' | 'service';
  documentId: string;
  reference: string;
  customerCode: string | null;
  customerName: string | null;
  paymentType: string;
  tenderRef: string | null;
  amountCents: number;
  referenceSubtotalCents: number;
  day: string;
  time: string;
  drawerNumber: string | null;
  operatorInitials: string | null;
}
interface PaymentTypeGroup {
  key: string;
  label: string;
  count: number;
  amountCents: number;
  lines: PaymentLine[];
}
interface PayClassGroup {
  code: number;
  label: string;
  count: number;
  amountCents: number;
  paymentTypes: PaymentTypeGroup[];
}
interface Reconciliation {
  cashCents: number;
  checkCents: number;
  depositCents: number;
}
interface BalanceGroup {
  key: string;
  label: string;
  sublabel: string | null;
  count: number;
  amountCents: number;
  payClasses: PayClassGroup[];
  reconciliation: Reconciliation;
  drawers: DrawerBalance[];
}
interface Report {
  generatedAt: string;
  range: { start: string; end: string; startTime: string; endTime: string };
  balanceBy: BalanceBy;
  toleranceCents: number;
  groups: BalanceGroup[];
  count: number;
  amountCents: number;
  reconciliation: Reconciliation;
}
interface Location {
  id: string;
  name: string;
  locationType?: string;
}
interface Member {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
}

/** One register row = one tender line with the group / pay class / payment type it sits under. */
interface RegisterRow {
  g: BalanceGroup;
  pc: PayClassGroup;
  pt: PaymentTypeGroup;
  l: PaymentLine;
}
/** One drawer-count row = one balanced drawer under its group. */
interface DrawerRow {
  g: BalanceGroup;
  d: DrawerBalance;
}

const BALANCE_BY: { key: BalanceBy; label: string }[] = [
  { key: 'drawer', label: 'Drawer' },
  { key: 'operator', label: 'Operator' },
  { key: 'store', label: 'Store' },
];
const DRAWER_STATES: { key: DrawerState; label: string; hint: string }[] = [
  { key: 'all', label: 'All drawers', hint: 'Balanced and still-open drawers' },
  { key: 'balanced', label: 'Balanced', hint: 'Drawers that have been closed and counted' },
  { key: 'unbalanced', label: 'UnBalanced', hint: 'Drawers still open (not yet counted)' },
];

function docHref(l: PaymentLine): string {
  if (l.documentType === 'sale') return `/sales/${l.documentId}`;
  if (l.documentType === 'service') return `/service/${l.documentId}`;
  return `/orders/${l.documentId}`;
}

function Stat({
  label,
  value,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: '10px 12px',
        background: 'var(--surface)',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: strong ? 700 : 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A subtotal row's cells in the header's order: the label spans the
 * leading columns that carry no total, each total sits under its own
 * column, and the rest stay blank — so a moved Amount column keeps its
 * subtotal under it.
 */
function TotalCells<Row>({
  list,
  label,
  labelClassName,
  totals,
  totalClassName,
  totalTestId,
}: {
  list: ListColumns<Row>;
  label: ReactNode;
  labelClassName?: string;
  totals: Record<string, ReactNode>;
  totalClassName?: string;
  totalTestId?: string;
}) {
  const firstTotal = list.ordered.findIndex((c) => c.id in totals);
  const lead = firstTotal < 0 ? list.ordered.length : firstTotal;
  let placed = lead > 0;
  return (
    <>
      {lead > 0 && (
        <td colSpan={lead} className={labelClassName}>
          {label}
        </td>
      )}
      {list.ordered.slice(lead).map((c) => {
        if (c.id in totals) {
          return (
            <td
              key={c.id}
              className={`num ${totalClassName ?? ''}`.trim()}
              data-testid={totalTestId}
            >
              {totals[c.id]}
            </td>
          );
        }
        if (!placed) {
          placed = true;
          return (
            <td key={c.id} className={labelClassName}>
              {label}
            </td>
          );
        }
        return <td key={c.id} />;
      })}
    </>
  );
}

function registerKey(g: BalanceGroup, pc: PayClassGroup, pt: PaymentTypeGroup): string {
  return `${g.key}|${pc.code}|${pt.key}`;
}

export default function CashDrawerBalancingPage() {
  const [range, setRange, rangeReady] = useUrlDateRange('today');
  const [startTime, setStartTime] = useState('00:00');
  const [endTime, setEndTime] = useState('23:59');
  const [balanceBy, setBalanceBy] = useState<BalanceBy>('store');
  const [drawerState, setDrawerState] = useState<DrawerState>('all');
  const [locationId, setLocationId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [drawerId, setDrawerId] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [paramsReady, setParamsReady] = useState(false);

  // The register and drawer-count tables: flat rows sorted once, then
  // bucketed back under their group / pay class / payment type.
  const registerColumns = useMemo<ColumnDef<RegisterRow>[]>(
    () => [
      {
        id: 'customerCode',
        label: 'Customer code',
        sortValue: (r) => r.l.customerCode,
        render: (r) => <code>{r.l.customerCode ?? '—'}</code>,
      },
      {
        id: 'customerName',
        label: 'Customer name',
        sortValue: (r) => r.l.customerName,
        render: (r) => r.l.customerName ?? '—',
      },
      {
        id: 'reference',
        label: 'Reference',
        sortValue: (r) => r.l.reference,
        render: (r) => <a href={docHref(r.l)}>{r.l.reference}</a>,
      },
      {
        id: 'paymentType',
        label: 'Payment type · gift cert / chk no.',
        sortValue: (r) => r.l.paymentType,
        render: (r) => (
          <>
            {r.l.paymentType}
            {r.l.tenderRef ? <span className="ml-2 text-muted">{r.l.tenderRef}</span> : null}
          </>
        ),
      },
      {
        id: 'amount',
        label: 'Amount',
        num: true,
        sortValue: (r) => r.l.amountCents,
        render: (r) => <Money cents={r.l.amountCents} />,
      },
      {
        id: 'referenceSubtotal',
        label: 'Reference subtotal',
        num: true,
        sortValue: (r) => r.l.referenceSubtotalCents,
        render: (r) => <Money cents={r.l.referenceSubtotalCents} />,
      },
      {
        id: 'time',
        label: 'Time',
        sortValue: (r) => `${r.l.day} ${r.l.time}`,
        render: (r) => (
          <>
            {report && (r.l.day !== report.range.start || r.l.day !== report.range.end)
              ? `${r.l.day} `
              : ''}
            {r.l.time}
          </>
        ),
      },
      {
        id: 'drawer',
        label: 'Drawer',
        sortValue: (r) => r.l.drawerNumber,
        render: (r) => r.l.drawerNumber ?? '—',
      },
      {
        id: 'oper',
        label: 'Oper',
        sortValue: (r) => r.l.operatorInitials,
        render: (r) => r.l.operatorInitials ?? '—',
      },
    ],
    [report],
  );
  const registerRows = useMemo<RegisterRow[] | null>(
    () =>
      report
        ? report.groups.flatMap((g) =>
            g.payClasses.flatMap((pc) =>
              pc.paymentTypes.flatMap((pt) => pt.lines.map((l) => ({ g, pc, pt, l }))),
            ),
          )
        : null,
    [report],
  );
  const regCols = useListColumns(
    'reports-cash-drawer-balancing-register',
    registerColumns,
    registerRows,
  );
  const registerByType = useMemo(() => {
    const by = new Map<string, RegisterRow[]>();
    for (const r of regCols.sorted) {
      const k = registerKey(r.g, r.pc, r.pt);
      const bucket = by.get(k);
      if (bucket) bucket.push(r);
      else by.set(k, [r]);
    }
    return by;
  }, [regCols.sorted]);

  const drawerColumns = useMemo<ColumnDef<DrawerRow>[]>(
    () => [
      {
        id: 'drawer',
        label: 'Drawer',
        sortValue: (r) => r.d.number,
        render: (r) => (
          <>
            <a href={`/shifts/${r.d.id}`}>{r.d.number}</a>
            {report && report.balanceBy !== 'store' ? (
              <span className="ml-1 text-muted">{r.d.locationName}</span>
            ) : null}
          </>
        ),
      },
      {
        id: 'operator',
        label: 'Operator',
        sortValue: (r) => r.d.operatorName,
        render: (r) => r.d.operatorName,
      },
      {
        id: 'opened',
        label: 'Opened',
        sortValue: (r) => r.d.openedAt,
        render: (r) => fmtTime(r.d.openedAt),
      },
      {
        id: 'closed',
        label: 'Closed',
        sortValue: (r) => r.d.closedAt,
        render: (r) => (r.d.closedAt ? fmtTime(r.d.closedAt) : 'open'),
      },
      {
        id: 'float',
        label: 'Float',
        num: true,
        sortValue: (r) => r.d.openingFloatCents,
        render: (r) => <Money cents={r.d.openingFloatCents} />,
      },
      {
        id: 'expected',
        label: 'Expected',
        num: true,
        sortValue: (r) => r.d.expectedCashCents,
        render: (r) =>
          r.d.expectedCashCents != null ? <Money cents={r.d.expectedCashCents} /> : '—',
      },
      {
        id: 'counted',
        label: 'Counted',
        num: true,
        sortValue: (r) => r.d.countedCashCents,
        render: (r) =>
          r.d.countedCashCents != null ? <Money cents={r.d.countedCashCents} /> : '—',
      },
      {
        id: 'overShort',
        label: 'Over / short',
        num: true,
        sortValue: (r) => r.d.varianceCents,
        render: (r) => (
          <span
            style={{
              color:
                r.d.inTolerance === false
                  ? 'var(--danger)'
                  : r.d.inTolerance
                    ? 'var(--success)'
                    : undefined,
            }}
          >
            {r.d.varianceCents != null ? <Money cents={r.d.varianceCents} /> : '—'}
          </span>
        ),
      },
    ],
    [report],
  );
  const drawerRows = useMemo<DrawerRow[] | null>(
    () => (report ? report.groups.flatMap((g) => g.drawers.map((d) => ({ g, d }))) : null),
    [report],
  );
  const drawerCols = useListColumns(
    'reports-cash-drawer-balancing-drawers',
    drawerColumns,
    drawerRows,
  );
  const drawersByGroup = useMemo(() => {
    const by = new Map<string, DrawerRow[]>();
    for (const r of drawerCols.sorted) {
      const bucket = by.get(r.g.key);
      if (bucket) bucket.push(r);
      else by.set(r.g.key, [r]);
    }
    return by;
  }, [drawerCols.sorted]);

  // Parameters live in the URL so a balanced day can be bookmarked.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = (k: string, fallback: string) => {
      const v = p.get(k);
      return v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback;
    };
    setStartTime(t('startTime', '00:00'));
    setEndTime(t('endTime', '23:59'));
    const by = p.get('balanceBy');
    if (by === 'drawer' || by === 'operator' || by === 'store') setBalanceBy(by);
    const ds = p.get('drawerState');
    if (ds === 'balanced' || ds === 'unbalanced') setDrawerState(ds);
    setLocationId(p.get('locationId') ?? '');
    setOperatorId(p.get('operatorId') ?? '');
    setDrawerId(p.get('drawerId') ?? '');
    setParamsReady(true);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [l, m] = await Promise.all([
          api<Location[]>('/v1/business/locations'),
          api<Member[]>('/v1/business/members').catch(() => [] as Member[]),
        ]);
        setLocations(l.filter((x) => (x.locationType ?? 'store') !== 'warehouse'));
        setMembers(m);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const query = useCallback((): string => {
    const p = new URLSearchParams();
    p.set('start', range.start);
    p.set('end', range.end);
    p.set('startTime', startTime);
    p.set('endTime', endTime);
    p.set('balanceBy', balanceBy);
    p.set('drawerState', drawerState);
    if (locationId) p.set('locationId', locationId);
    if (operatorId) p.set('operatorId', operatorId);
    if (drawerId) p.set('drawerId', drawerId.trim());
    return p.toString();
  }, [range, startTime, endTime, balanceBy, drawerState, locationId, operatorId, drawerId]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api<Report>(`/v1/reports/cash-drawer-balancing?${query()}`));
      const url = new URL(window.location.href);
      const p = url.searchParams;
      rangeToSearch(range, p);
      for (const [k, v] of [
        ['startTime', startTime === '00:00' ? '' : startTime],
        ['endTime', endTime === '23:59' ? '' : endTime],
        ['balanceBy', balanceBy === 'store' ? '' : balanceBy],
        ['drawerState', drawerState === 'all' ? '' : drawerState],
        ['locationId', locationId],
        ['operatorId', operatorId],
        ['drawerId', drawerId.trim()],
      ] as const) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      window.history.replaceState(null, '', url.toString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [query, range, startTime, endTime, balanceBy, drawerState, locationId, operatorId, drawerId]);

  useEffect(() => {
    if (rangeReady && paramsReady) void run();
    // Run once when the URL parameters are known; later runs are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeReady, paramsReady]);

  /** CSV for a spreadsheet; PDF is the STORIS "Basic PDF" spool, line for line. */
  async function exportAs(format: 'csv' | 'pdf') {
    setExporting(true);
    try {
      await downloadFile(
        `/v1/reports/cash-drawer-balancing?${query()}&format=${format}`,
        `cash-drawer-balancing-${range.start}-to-${range.end}.${format}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  const drawerOptions = report
    ? [...new Map(report.groups.flatMap((g) => g.drawers).map((d) => [d.id, d])).values()]
    : [];

  return (
    <div data-testid="cash-drawer-balancing">
      <p style={{ margin: '0 0 12px' }}>
        <Link href="/reports">← Reports</Link>
      </p>
      <PageHeader
        title="Report Cash Drawer Balancing Totals"
        sub="Every tender taken in the balance window under its store, operator or drawer, with pay-class subtotals and the cash + check deposit."
        actions={
          <>
            <Button variant="secondary" onClick={() => window.print()} disabled={!report}>
              <Printer size={14} />
              Print
            </Button>
            <Button
              variant="secondary"
              onClick={() => void exportAs('pdf')}
              disabled={exporting}
              title="Download the STORIS-layout Basic PDF"
            >
              <FileText size={14} />
              PDF
            </Button>
            <Button variant="secondary" onClick={() => void exportAs('csv')} disabled={exporting}>
              <Download size={14} />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        <Card title="Parameters" data-testid="cdb-params">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
            className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Balance date">
                <DateRangePicker value={range} onChange={setRange} compact testid="cdb-range" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Starting time">
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value || '00:00')}
                    data-testid="cdb-start-time"
                  />
                </Field>
                <Field label="Ending time">
                  <Input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value || '23:59')}
                    data-testid="cdb-end-time"
                  />
                </Field>
              </div>
              <Field label="Store">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">All stores</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Operator">
                <Select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
                  <option value="">All operators</option>
                  {members.map((m) => (
                    <option key={m.membershipId} value={m.userId}>
                      {m.name ?? m.email}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Drawer">
                <Input
                  list="cdb-drawers"
                  placeholder="All drawers"
                  value={drawerId}
                  onChange={(e) => setDrawerId(e.target.value)}
                  data-testid="cdb-drawer"
                />
                <datalist id="cdb-drawers">
                  {drawerOptions.map((d) => (
                    <option key={d.id} value={d.number}>
                      {d.locationName} · {d.operatorName} · {d.status}
                    </option>
                  ))}
                </datalist>
              </Field>
              <fieldset className="m-0 border-0 p-0">
                <legend className="mb-1 text-xs text-muted">Balance by</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {BALANCE_BY.map((b) => (
                    <label key={b.key} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="balanceBy"
                        value={b.key}
                        checked={balanceBy === b.key}
                        onChange={() => setBalanceBy(b.key)}
                        data-testid={`cdb-by-${b.key}`}
                      />
                      {b.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="m-0 border-0 p-0 sm:col-span-2">
                <legend className="mb-1 text-xs text-muted">Drawer reference</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {DRAWER_STATES.map((s) => (
                    <label key={s.key} className="flex items-center gap-1.5" title={s.hint}>
                      <input
                        type="radio"
                        name="drawerState"
                        value={s.key}
                        checked={drawerState === s.key}
                        onChange={() => setDrawerState(s.key)}
                        data-testid={`cdb-state-${s.key}`}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="flex items-end">
              <Button type="submit" variant="primary" disabled={busy} data-testid="cdb-run">
                <Play size={14} />
                {busy ? 'Running…' : 'Run'}
              </Button>
            </div>
          </form>
        </Card>

        {error && (
          <p style={{ color: 'var(--danger)', fontSize: 13 }} role="alert">
            {error}
          </p>
        )}

        {!report && !error && (
          <Card>
            <LoadingRows rows={4} />
          </Card>
        )}

        {report && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Tenders" value={String(report.count)} />
              <Stat label="Grand total" value={<Money cents={report.amountCents} />} />
              <Stat label="Cash" value={<Money cents={report.reconciliation.cashCents} />} />
              <Stat label="Check" value={<Money cents={report.reconciliation.checkCents} />} />
              <Stat
                label="Total deposit"
                value={<Money cents={report.reconciliation.depositCents} />}
                strong
              />
            </div>

            {report.groups.length === 0 ? (
              <Card>
                <EmptyState>No tenders in this window.</EmptyState>
              </Card>
            ) : (
              report.groups.map((g) => (
                <Card
                  key={g.key}
                  title={
                    <span data-testid="cdb-group">
                      {BALANCE_BY.find((b) => b.key === report.balanceBy)?.label} · {g.label}
                      {g.sublabel ? (
                        <span className="ml-2 text-sm font-normal text-muted">{g.sublabel}</span>
                      ) : null}
                    </span>
                  }
                >
                  <p className="mb-2 text-xs text-muted">
                    {g.count} tender{g.count === 1 ? '' : 's'}
                  </p>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="table" data-testid="cdb-register">
                      <thead>
                        <ColumnHeadRow
                          list={regCols}
                          testIdPrefix="reports-cash-drawer-balancing-register"
                        />
                      </thead>
                      <tbody>
                        {g.payClasses.map((pc) => (
                          <Fragment key={pc.code}>
                            <tr className="bg-surface-muted">
                              <td colSpan={regCols.ordered.length} className="font-semibold">
                                Pay class {pc.code} – {pc.label}
                              </td>
                            </tr>
                            {pc.paymentTypes.map((pt) => (
                              <Fragment key={pt.key}>
                                <tr>
                                  <td colSpan={regCols.ordered.length} className="text-muted">
                                    Payment type {pt.label}
                                  </td>
                                </tr>
                                {(registerByType.get(registerKey(g, pc, pt)) ?? []).map((r) => (
                                  <tr key={r.l.paymentId} data-testid="cdb-line">
                                    <ColumnCells list={regCols} row={r} />
                                  </tr>
                                ))}
                                <tr>
                                  <TotalCells
                                    list={regCols}
                                    label={`Total for payment type ${pt.label}:`}
                                    labelClassName="text-right text-muted"
                                    totals={{ amount: <Money cents={pt.amountCents} /> }}
                                    totalClassName="font-semibold"
                                  />
                                </tr>
                              </Fragment>
                            ))}
                            <tr>
                              <TotalCells
                                list={regCols}
                                label={`Total for pay class ${pc.code}:`}
                                labelClassName="text-right font-semibold"
                                totals={{ amount: <Money cents={pc.amountCents} /> }}
                                totalClassName="font-semibold"
                              />
                            </tr>
                          </Fragment>
                        ))}
                        <tr>
                          <TotalCells
                            list={regCols}
                            label={`Total for ${g.label}:`}
                            labelClassName="text-right font-bold"
                            totals={{ amount: <Money cents={g.amountCents} /> }}
                            totalClassName="font-bold"
                            totalTestId="cdb-group-total"
                          />
                        </tr>
                      </tbody>
                    </table>
                    <ResetColumns list={regCols} />
                  </div>

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <div>
                      <h4 className="mb-2 text-sm font-semibold">Cash drawer reconciliation</h4>
                      <table className="table">
                        <tbody>
                          <tr>
                            <td>CASH</td>
                            <td className="num">
                              <Money cents={g.reconciliation.cashCents} />
                            </td>
                          </tr>
                          <tr>
                            <td>CHECK</td>
                            <td className="num">
                              <Money cents={g.reconciliation.checkCents} />
                            </td>
                          </tr>
                          <tr>
                            <td className="font-semibold">Total deposit</td>
                            <td className="num font-semibold">
                              <Money cents={g.reconciliation.depositCents} />
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <h4 className="mb-2 text-sm font-semibold">Drawer counts</h4>
                      {g.drawers.length === 0 ? (
                        <p className="text-sm text-muted">No drawer balanced in this window.</p>
                      ) : (
                        <div style={{ overflowX: 'auto' }}>
                          <table className="table" data-testid="cdb-drawers">
                            <thead>
                              <ColumnHeadRow
                                list={drawerCols}
                                testIdPrefix="reports-cash-drawer-balancing-drawers"
                              />
                            </thead>
                            <tbody>
                              {(drawersByGroup.get(g.key) ?? []).map((r) => (
                                <tr key={r.d.id}>
                                  <ColumnCells list={drawerCols} row={r} />
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <ResetColumns list={drawerCols} />
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ))
            )}

            <Card title="Grand total" data-testid="cdb-grand">
              <div className="grid gap-4 md:grid-cols-2">
                <table className="table">
                  <tbody>
                    <tr>
                      <td className="font-semibold">Grand total</td>
                      <td className="num font-semibold">
                        <Money cents={report.amountCents} />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <table className="table">
                  <tbody>
                    <tr>
                      <td>CASH</td>
                      <td className="num">
                        <Money cents={report.reconciliation.cashCents} />
                      </td>
                    </tr>
                    <tr>
                      <td>CHECK</td>
                      <td className="num">
                        <Money cents={report.reconciliation.checkCents} />
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold">Total deposit</td>
                      <td className="num font-semibold">
                        <Money cents={report.reconciliation.depositCents} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted">
                Balance date {report.range.start}
                {report.range.end !== report.range.start ? ` – ${report.range.end}` : ''} ·{' '}
                {report.range.startTime}–{report.range.endTime} · balanced by {report.balanceBy} ·
                tolerance <Money cents={report.toleranceCents} /> · generated{' '}
                {new Date(report.generatedAt).toLocaleString()}
              </p>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
