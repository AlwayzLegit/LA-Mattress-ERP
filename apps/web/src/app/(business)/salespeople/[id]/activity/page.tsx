'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { localToday, type DateRange } from '@/lib/date-range';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  KeyValue,
  LinkButton,
  PageHeader,
  ResetColumns,
  Skeleton,
  Stack,
  StatGrid,
  StatTile,
  StatusBadge,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';

/**
 * View Salesperson Activity (owner 2026-09-02, STORIS-style): one member,
 * eight views down the left — General (totals), Open Orders, Completed
 * Orders, Canceled Orders, Layaways, Carts, Quotes, Leads. Read-only;
 * every number comes from `GET /v1/salespeople/:membershipId/activity`
 * and every row links to its document.
 */

interface OrderRow {
  id: string;
  number: string;
  customerId: string | null;
  customerName: string;
  orderType: string;
  fulfillmentType: string;
  fulfillmentStatus: string;
  orderDate: string;
  fulfillmentDate: string | null;
  completedDate: string | null;
  cancelledDate: string | null;
  merchandiseCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  salespeople: number;
}
interface Activity {
  salesperson: {
    membershipId: string;
    userId: string;
    code: string;
    name: string;
    email: string | null;
    sellingLocations: string[];
    status: string;
  };
  range: { from: string; to: string; today: string };
  general: {
    ordersCents: number;
    ordersCount: number;
    layawaysCents: number;
    layawaysCount: number;
    quotesCents: number;
    quotesCount: number;
    cartsCents: number;
    cartsCount: number;
    writtenTodayCents: number;
    writtenMtdCents: number;
    deliveredTodayCents: number;
    deliveredMtdCents: number;
  };
  openOrders: OrderRow[];
  completedOrders: OrderRow[];
  canceledOrders: OrderRow[];
  layaways: OrderRow[];
  carts: OrderRow[];
  quotes: OrderRow[];
  leads: LeadRow[];
}
interface LeadRow {
  customerId: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string;
  documentId: string;
  documentNumber: string;
  date: string;
}

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'open', label: 'Open Orders' },
  { key: 'completed', label: 'Completed Orders' },
  { key: 'canceled', label: 'Canceled Orders' },
  { key: 'layaways', label: 'Layaways' },
  { key: 'carts', label: 'Carts' },
  { key: 'quotes', label: 'Quotes' },
  { key: 'leads', label: 'Leads' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return m && day && y ? `${m}/${day}/${y}` : d;
}

export default function SalespersonActivityPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('general');
  // Completed / Canceled window, carried in the URL as `window.range` /
  // `window.start` / `window.end`. Named `windowRange` (not `window`) so
  // the global stays reachable below.
  const [windowRange, setWindowRange, windowReady] = useUrlDateRange('last30', { key: 'window' });

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('tab');
    if (initial && TABS.some((t) => t.key === initial)) setTab(initial as TabKey);
  }, []);

  const load = useCallback(
    async (range?: { from: string; to: string }): Promise<Activity | null> => {
      if (!id) return null;
      const qs = new URLSearchParams({ today: localToday() });
      if (range?.from) qs.set('from', range.from);
      if (range?.to) qs.set('to', range.to);
      try {
        const d = await api<Activity>(`/v1/salespeople/${id}/activity?${qs.toString()}`);
        setData(d);
        return d;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [id],
  );

  // First load: if the URL names a window, use it; otherwise let the API
  // pick its own default (first of last month → end of this month) and seed
  // the picker from the response so the button reads what the tables show.
  useEffect(() => {
    if (!windowReady) return;
    const params = new URLSearchParams(window.location.search);
    if (params.has('window.range') || params.has('window.start')) {
      void load({ from: windowRange.start, to: windowRange.end });
    } else {
      void load().then((d) => {
        if (d) setWindowRange({ preset: 'custom', start: d.range.from, end: d.range.to });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once the URL has been read
  }, [windowReady, load]);

  function pickWindow(next: DateRange) {
    setWindowRange(next);
    void load({ from: next.start, to: next.end });
  }

  function pick(next: TabKey) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url.toString());
  }

  const header = (
    <PageHeader
      eyebrow={<BackLink href="/salespeople">Salespeople</BackLink>}
      title="View Salesperson Activity"
      sub={data ? `${data.salesperson.code} · ${data.salesperson.name}` : undefined}
      actions={
        <LinkButton size="sm" href="/salespeople/activity">
          Look up another salesperson
        </LinkButton>
      }
    />
  );

  if (error && !data) {
    return (
      <div>
        {header}
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <div data-testid="sp-activity-loading">
        {header}
        <Stack>
          <Skeleton style={{ height: 100 }} />
          <Skeleton style={{ height: 320 }} />
        </Stack>
      </div>
    );
  }
  const s = data.salesperson;
  const rangeBar = (
    <Toolbar>
      <DateRangePicker value={windowRange} onChange={pickWindow} align="left" testid="sp-range" />
    </Toolbar>
  );

  return (
    <div data-testid="salesperson-activity">
      {header}
      <Stack>
        <Card data-testid="sp-header">
          <KeyValue
            rows={[
              {
                label: 'Salesperson',
                value: (
                  <>
                    <code>{s.code}</code> <strong data-testid="sp-name">{s.name}</strong>
                  </>
                ),
              },
              { label: 'Email address', value: s.email ?? '—' },
              { label: 'Status', value: <StatusBadge status={s.status} /> },
              {
                label: 'Selling location',
                value: s.sellingLocations.length > 0 ? s.sellingLocations.join(', ') : 'All stores',
              },
            ]}
          />
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
          <nav
            aria-label="Salesperson activity views"
            className="flex gap-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 lg:sticky lg:top-4 lg:flex-col lg:gap-0 lg:overflow-hidden lg:p-0"
          >
            {TABS.map((t) => {
              const active = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => pick(t.key)}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`sp-tab-${t.key}`}
                  className={`shrink-0 cursor-pointer whitespace-nowrap rounded-md bg-transparent px-3.5 py-2.5 text-left text-[13px] text-[var(--text)] lg:w-full lg:rounded-none lg:border-b lg:border-b-[var(--border)] lg:border-l-[3px] ${
                    active
                      ? 'bg-[var(--surface-muted)] font-bold lg:border-l-[var(--brand)]'
                      : 'font-medium hover:bg-[var(--surface-muted)] lg:border-l-transparent'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0">
            {tab === 'general' && <General data={data} />}
            {tab === 'open' && (
              <OrdersTable
                title="Open orders"
                testid="sp-open"
                rows={data.openOrders}
                variant="open"
                empty="No open orders."
              />
            )}
            {tab === 'completed' && (
              <OrdersTable
                title="Completed orders"
                testid="sp-completed"
                rows={data.completedOrders}
                variant="completed"
                empty="No orders completed in this window."
                before={rangeBar}
              />
            )}
            {tab === 'canceled' && (
              <OrdersTable
                title="Canceled orders"
                testid="sp-canceled"
                rows={data.canceledOrders}
                variant="cancelled"
                empty="No orders canceled in this window."
                before={rangeBar}
              />
            )}
            {tab === 'layaways' && (
              <OrdersTable
                title="Layaways"
                testid="sp-layaways"
                rows={data.layaways}
                variant="open"
                empty="No open layaways."
              />
            )}
            {tab === 'carts' && (
              <OrdersTable
                title="Carts"
                testid="sp-carts"
                rows={data.carts}
                variant="draft"
                empty="No saved carts."
              />
            )}
            {tab === 'quotes' && (
              <OrdersTable
                title="Quotes"
                testid="sp-quotes"
                rows={data.quotes}
                variant="draft"
                empty="No open quotes."
              />
            )}
            {tab === 'leads' && <Leads data={data} />}
          </div>
        </div>
      </Stack>
    </div>
  );
}

function MoneyBox({ label, cents, testid }: { label: string; cents: number; testid?: string }) {
  return (
    <StatTile
      label={label}
      value={
        <span data-testid={testid}>
          <Money cents={cents} />
        </span>
      }
    />
  );
}

function General({ data }: { data: Activity }) {
  const g = data.general;
  return (
    <Card
      title="Totals"
      description="Orders, layaways, quotes and carts are the open documents this salesperson wrote or shares. Written counts the day the order was taken; delivered counts the day it completed."
      data-testid="sp-general"
    >
      <StatGrid cols={4}>
        <MoneyBox
          label={`Orders (${g.ordersCount})`}
          cents={g.ordersCents}
          testid="sp-orders-total"
        />
        <MoneyBox
          label={`Layaways (${g.layawaysCount})`}
          cents={g.layawaysCents}
          testid="sp-layaways-total"
        />
        <MoneyBox
          label={`Quotes (${g.quotesCount})`}
          cents={g.quotesCents}
          testid="sp-quotes-total"
        />
        <MoneyBox label={`Carts (${g.cartsCount})`} cents={g.cartsCents} testid="sp-carts-total" />
        <MoneyBox
          label="Written sales today"
          cents={g.writtenTodayCents}
          testid="sp-written-today"
        />
        <MoneyBox
          label="Written sales month to date"
          cents={g.writtenMtdCents}
          testid="sp-written-mtd"
        />
        <MoneyBox
          label="Delivered sales today"
          cents={g.deliveredTodayCents}
          testid="sp-delivered-today"
        />
        <MoneyBox
          label="Delivered sales month to date"
          cents={g.deliveredMtdCents}
          testid="sp-delivered-mtd"
        />
      </StatGrid>
    </Card>
  );
}

function OrdersTable({
  title,
  testid,
  rows,
  variant,
  empty,
  before,
}: {
  title: string;
  testid: string;
  rows: OrderRow[];
  variant: 'open' | 'completed' | 'cancelled' | 'draft';
  empty: string;
  before?: React.ReactNode;
}) {
  const sum = (k: 'merchandiseCents' | 'totalCents' | 'amountPaidCents' | 'balanceCents') =>
    rows.reduce((s, r) => s + r[k], 0);
  const dateLabel =
    variant === 'completed'
      ? 'Completed date'
      : variant === 'cancelled'
        ? 'Canceled date'
        : 'Order date';
  const dateOf = (r: OrderRow) =>
    variant === 'completed'
      ? (r.completedDate ?? r.orderDate)
      : variant === 'cancelled'
        ? (r.cancelledDate ?? r.orderDate)
        : r.orderDate;
  // Inline: the date column's label and value depend on `variant`, and the
  // two fulfillment columns only exist for open documents.
  const columns: ColumnDef<OrderRow>[] = [
    {
      id: 'order',
      label: 'Order',
      sortValue: (r) => r.number,
      render: (r) => <Link href={`/orders/${r.id}`}>{r.number}</Link>,
    },
    {
      id: 'orderType',
      label: 'Order type',
      sortValue: (r) => r.orderType,
      render: (r) => r.orderType,
    },
    {
      id: 'customer',
      label: 'Customer name',
      sortValue: (r) => r.customerName,
      render: (r) =>
        r.customerId ? (
          <Link href={`/customers/${r.customerId}/activity`}>{r.customerName}</Link>
        ) : (
          r.customerName
        ),
    },
    {
      id: 'fulfillmentType',
      label: 'Fulfillment type',
      sortValue: (r) => r.fulfillmentType,
      render: (r) => r.fulfillmentType,
    },
    ...(variant === 'open'
      ? [
          {
            id: 'fulfillmentStatus',
            label: 'Fulfillment status',
            sortValue: (r) => r.fulfillmentStatus,
            render: (r) => r.fulfillmentStatus,
          } satisfies ColumnDef<OrderRow>,
        ]
      : []),
    {
      id: 'date',
      label: dateLabel,
      sortValue: (r) => dateOf(r),
      render: (r) => fmtDate(dateOf(r)),
    },
    ...(variant === 'open'
      ? [
          {
            id: 'fulfillmentDate',
            label: 'Fulfillment date',
            sortValue: (r) => r.fulfillmentDate,
            render: (r) => fmtDate(r.fulfillmentDate),
          } satisfies ColumnDef<OrderRow>,
        ]
      : []),
    {
      id: 'merchandise',
      label: 'Merchandise',
      num: true,
      sortValue: (r) => r.merchandiseCents,
      render: (r) => <Money cents={r.merchandiseCents} />,
    },
    {
      id: 'total',
      label: 'Total',
      num: true,
      sortValue: (r) => r.totalCents,
      render: (r) => <Money cents={r.totalCents} />,
    },
    {
      id: 'amountPaid',
      label: 'Amount paid',
      num: true,
      sortValue: (r) => r.amountPaidCents,
      render: (r) => <Money cents={r.amountPaidCents} />,
    },
    {
      id: 'balance',
      label: 'Balance',
      num: true,
      sortValue: (r) => r.balanceCents,
      render: (r) =>
        r.balanceCents > 0 ? (
          <strong>
            <Money cents={r.balanceCents} />
          </strong>
        ) : (
          <Money cents={r.balanceCents} />
        ),
    },
    {
      id: 'salespeople',
      label: 'Salespeople',
      num: true,
      sortValue: (r) => r.salespeople,
      render: (r) => r.salespeople,
    },
  ];
  const cols = useListColumns('salesperson-activity-orders', columns, rows);
  const totals: Record<string, { testid: string; cents: number }> = {
    merchandise: { testid: `${testid}-merch`, cents: sum('merchandiseCents') },
    total: { testid: `${testid}-total`, cents: sum('totalCents') },
    amountPaid: { testid: `${testid}-paid`, cents: sum('amountPaidCents') },
    balance: { testid: `${testid}-balance`, cents: sum('balanceCents') },
  };
  const totalsLabelId = cols.ordered.find((c) => !totals[c.id])?.id;
  return (
    <Card title={title} data-testid={testid}>
      {before}
      {rows.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <TableWrap>
          <table className="table">
            <thead>
              <ColumnHeadRow list={cols} testIdPrefix={testid} />
            </thead>
            <tbody>
              {cols.sorted.map((r) => (
                <tr key={r.id} data-testid={`${testid}-row`}>
                  <ColumnCells list={cols} row={r} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                {cols.ordered.map((c) => {
                  const t = totals[c.id];
                  return (
                    <td key={c.id} className={c.num ? 'num' : undefined} data-testid={t?.testid}>
                      {t ? (
                        <Money cents={t.cents} />
                      ) : c.id === totalsLabelId ? (
                        `Totals (${rows.length})`
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
          <ResetColumns list={cols} />
        </TableWrap>
      )}
    </Card>
  );
}

const LEAD_COLUMNS: ColumnDef<LeadRow>[] = [
  {
    id: 'customer',
    label: 'Customer',
    sortValue: (l) => l.name,
    render: (l) => <Link href={`/customers/${l.customerId}`}>{l.name}</Link>,
  },
  { id: 'phone', label: 'Phone', sortValue: (l) => l.phone, render: (l) => l.phone ?? '—' },
  { id: 'email', label: 'Email', sortValue: (l) => l.email, render: (l) => l.email ?? '—' },
  { id: 'source', label: 'Source', sortValue: (l) => l.source, render: (l) => l.source },
  {
    id: 'document',
    label: 'Document',
    sortValue: (l) => l.documentNumber,
    render: (l) => <Link href={`/orders/${l.documentId}`}>{l.documentNumber}</Link>,
  },
  { id: 'date', label: 'Date', sortValue: (l) => l.date, render: (l) => fmtDate(l.date) },
];

function Leads({ data }: { data: Activity }) {
  const rows = data.leads;
  const cols = useListColumns('salesperson-activity-leads', LEAD_COLUMNS, rows);
  return (
    <Card
      title="Leads"
      description="Customers on this salesperson's quotes or carts who have not bought yet."
      data-testid="sp-leads"
    >
      {rows.length === 0 ? (
        <EmptyState>No open leads.</EmptyState>
      ) : (
        <TableWrap>
          <table className="table">
            <thead>
              <ColumnHeadRow list={cols} testIdPrefix="sp-leads" />
            </thead>
            <tbody>
              {cols.sorted.map((l) => (
                <tr key={l.customerId} data-testid="sp-lead-row">
                  <ColumnCells list={cols} row={l} />
                </tr>
              ))}
            </tbody>
          </table>
          <ResetColumns list={cols} />
        </TableWrap>
      )}
    </Card>
  );
}
