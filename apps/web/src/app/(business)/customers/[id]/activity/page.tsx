'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  DisplayStatusBadge,
  EmptyState,
  Field,
  KeyValue,
  LinkButton,
  PageHeader,
  ResetColumns,
  Select,
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
 * View Customer Activity (owner 2026-09-02, STORIS-style): one customer,
 * eight views down the left — General Information, Open Orders, Order
 * Line Details, Historical Purchases, Current Deposits, Historical
 * Deposits, Open A/R Items, Open Service Orders. Read-only; every number
 * comes from `GET /v1/customers/:id/activity` and links to its document.
 */

interface YearTotals {
  sales: { cents: number; count: number };
  returns: { cents: number; count: number };
  service: { cents: number; count: number };
}
interface Activity {
  customer: {
    id: string;
    code: string;
    name: string;
    phone: string | null;
    phone2: string | null;
    email: string | null;
    address: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
    } | null;
    storeCreditCents: number;
    notes: string | null;
  };
  general: {
    shipFromLocation: string | null;
    totals: { thisYear: YearTotals; lastYear: YearTotals; lifetime: YearTotals };
  };
  openOrders: {
    totalOrdersCents: number;
    depositsCents: number;
    arCents: number;
    unpaidBalanceCents: number;
    rows: OpenOrderRow[];
  };
  orderLines: {
    orderId: string;
    number: string;
    status: string;
    lines: OrderLine[];
  }[];
  historicalPurchases: HistoricalPurchase[];
  currentDeposits: CurrentDeposit[];
  historicalDeposits: {
    totalLiabilityCents: number;
    rows: HistoricalDeposit[];
  };
  openArItems: ArItem[];
  openServiceOrders: ServiceOrderRow[];
}
interface OpenOrderRow {
  id: string;
  number: string;
  orderType: string;
  fulfillmentType: string;
  orderDate: string;
  salespersonName: string | null;
  merchandiseCents: number;
  otherCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  displayStatus: string;
}
interface OrderLine {
  id: string;
  sku: string | null;
  description: string;
  qtyReserved: number;
  qtyOrdered: number;
  backorderQty: number;
  fulfillmentDate: string | null;
  qtyReceived: number;
  poNumber: string | null;
  poId: string | null;
  poDeliveryDate: string | null;
  poQuantity: number;
  fulfillmentMethod: string;
  fulfillmentStatus: string;
}
interface HistoricalPurchase {
  docId: string;
  docType: 'order' | 'sale' | 'return';
  number: string;
  orderType: string;
  invoiceDate: string;
  sku: string | null;
  description: string;
  quantity: number;
  priceCents: number;
}
interface CurrentDeposit {
  orderId: string;
  number: string;
  depositCents: number;
  orderCents: number;
  orderType: string;
  orderDate: string;
  depositType: string | null;
  arCreditCents: number;
}
interface HistoricalDeposit {
  id: string;
  orderId: string;
  number: string;
  type: string;
  date: string;
  depositCents: number;
  activityCents: number;
  reason: string;
}
interface ArItem {
  id: string;
  orderId: string;
  reference: string;
  transactionDate: string;
  dueDate: string | null;
  inDispute: boolean;
  transactionType: string;
  memo: string;
  amountCents: number;
}
interface ServiceOrderRow {
  id: string;
  number: string;
  orderDate: string;
  type: string;
  coordinator: string | null;
  status: string;
  product: string;
  description: string;
  estimatedDate: string | null;
  scheduledDate: string | null;
  totalCents: number;
}

const TABS = [
  { key: 'general', label: 'General Information' },
  { key: 'open-orders', label: 'Open Orders' },
  { key: 'order-lines', label: 'Order Line Details' },
  { key: 'history', label: 'Historical Purchases' },
  { key: 'deposits', label: 'Current Deposits' },
  { key: 'deposit-history', label: 'Historical Deposits' },
  { key: 'ar', label: 'Open A/R Items' },
  { key: 'service', label: 'Open Service Orders' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function docHref(docType: 'order' | 'sale' | 'return', docId: string): string {
  if (docType === 'sale') return `/sales/${docId}`;
  return `/orders/${docId}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return m && day && y ? `${m}/${day}/${y}` : d;
}

const PAGE_TITLE = 'View Customer Activity';

const money = <R,>(get: (r: R) => number) => ({
  num: true as const,
  sortValue: get,
  render: (r: R) => <Money cents={get(r)} />,
});

const OPEN_ORDER_COLUMNS: ColumnDef<OpenOrderRow>[] = [
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
    id: 'fulfillment',
    label: 'Fulfillment',
    cellClassName: () => 'capitalize',
    sortValue: (r) => r.fulfillmentType,
    render: (r) => r.fulfillmentType.replace(/_/g, ' '),
  },
  {
    id: 'orderDate',
    label: 'Order date',
    sortValue: (r) => r.orderDate,
    render: (r) => fmtDate(r.orderDate),
  },
  {
    id: 'salesperson',
    label: 'Salesperson',
    sortValue: (r) => r.salespersonName,
    render: (r) => r.salespersonName ?? '—',
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (r) => r.displayStatus,
    render: (r) => <DisplayStatusBadge displayStatus={r.displayStatus} />,
  },
  { id: 'merchandise', label: 'Merchandise', ...money<OpenOrderRow>((r) => r.merchandiseCents) },
  { id: 'other', label: 'Other', ...money<OpenOrderRow>((r) => r.otherCents) },
  { id: 'total', label: 'Total', ...money<OpenOrderRow>((r) => r.totalCents) },
  { id: 'amountPaid', label: 'Amount paid', ...money<OpenOrderRow>((r) => r.amountPaidCents) },
  {
    id: 'balance',
    label: 'Balance',
    num: true,
    sortValue: (r) => r.balanceCents,
    render: (r) => (
      <strong>
        <Money cents={r.balanceCents} />
      </strong>
    ),
  },
];

const ORDER_LINE_COLUMNS: ColumnDef<OrderLine>[] = [
  {
    id: 'product',
    label: 'Product',
    className: 'nowrap',
    sortValue: (l) => l.sku,
    render: (l) => l.sku ?? '—',
  },
  {
    id: 'description',
    label: 'Description',
    sortValue: (l) => l.description,
    render: (l) => l.description,
  },
  {
    id: 'qtyReserved',
    label: 'Qty reserved',
    num: true,
    sortValue: (l) => l.qtyReserved,
    render: (l) => l.qtyReserved,
  },
  {
    id: 'qtyOrdered',
    label: 'Qty ordered',
    num: true,
    sortValue: (l) => l.qtyOrdered,
    render: (l) => l.qtyOrdered,
  },
  {
    id: 'backorderQty',
    label: 'Backorder qty',
    num: true,
    sortValue: (l) => l.backorderQty,
    render: (l) => l.backorderQty,
  },
  {
    id: 'fulfillmentDate',
    label: 'Fulfillment date',
    sortValue: (l) => l.fulfillmentDate,
    render: (l) => fmtDate(l.fulfillmentDate),
  },
  {
    id: 'qtyReceived',
    label: 'Qty received',
    num: true,
    sortValue: (l) => l.qtyReceived,
    render: (l) => l.qtyReceived,
  },
  {
    id: 'poNumber',
    label: 'PO number',
    sortValue: (l) => l.poNumber,
    render: (l) =>
      l.poNumber && l.poId ? <Link href={`/purchase-orders/${l.poId}`}>{l.poNumber}</Link> : '—',
  },
  {
    id: 'poDeliveryDate',
    label: 'PO delivery date',
    sortValue: (l) => l.poDeliveryDate,
    render: (l) => fmtDate(l.poDeliveryDate),
  },
  {
    id: 'poQty',
    label: 'PO qty',
    num: true,
    sortValue: (l) => l.poQuantity || null,
    render: (l) => l.poQuantity || '—',
  },
  {
    id: 'fulfillmentMethod',
    label: 'Fulfillment method',
    sortValue: (l) => l.fulfillmentMethod,
    render: (l) => l.fulfillmentMethod,
  },
  {
    id: 'fulfillmentStatus',
    label: 'Fulfillment status',
    sortValue: (l) => l.fulfillmentStatus,
    render: (l) => l.fulfillmentStatus,
  },
];

const HISTORY_COLUMNS: ColumnDef<HistoricalPurchase>[] = [
  {
    id: 'orderNumber',
    label: 'Order number',
    sortValue: (r) => r.number,
    render: (r) => <Link href={docHref(r.docType, r.docId)}>{r.number}</Link>,
  },
  {
    id: 'orderType',
    label: 'Order type',
    sortValue: (r) => r.orderType,
    render: (r) => r.orderType,
  },
  {
    id: 'invoiceDate',
    label: 'Invoice date',
    sortValue: (r) => r.invoiceDate,
    render: (r) => fmtDate(r.invoiceDate),
  },
  {
    id: 'product',
    label: 'Product',
    className: 'nowrap',
    sortValue: (r) => r.sku,
    render: (r) => r.sku ?? '—',
  },
  {
    id: 'description',
    label: 'Description',
    sortValue: (r) => r.description,
    render: (r) => r.description,
  },
  {
    id: 'quantity',
    label: 'Quantity',
    num: true,
    sortValue: (r) => r.quantity,
    render: (r) => r.quantity,
  },
  { id: 'price', label: 'Price', ...money<HistoricalPurchase>((r) => r.priceCents) },
];

const DEPOSIT_COLUMNS: ColumnDef<CurrentDeposit>[] = [
  {
    id: 'orderNumber',
    label: 'Order number',
    sortValue: (r) => r.number,
    render: (r) => <Link href={`/orders/${r.orderId}`}>{r.number}</Link>,
  },
  { id: 'depositAmount', label: 'Deposit amount', ...money<CurrentDeposit>((r) => r.depositCents) },
  { id: 'orderAmount', label: 'Order amount', ...money<CurrentDeposit>((r) => r.orderCents) },
  {
    id: 'orderType',
    label: 'Order type',
    sortValue: (r) => r.orderType,
    render: (r) => r.orderType,
  },
  {
    id: 'orderDate',
    label: 'Order date',
    sortValue: (r) => r.orderDate,
    render: (r) => fmtDate(r.orderDate),
  },
  {
    id: 'depositType',
    label: 'Deposit type',
    cellClassName: () => 'capitalize',
    sortValue: (r) => r.depositType,
    render: (r) => r.depositType ?? '—',
  },
  { id: 'arCredit', label: 'A/R credit', ...money<CurrentDeposit>((r) => r.arCreditCents) },
];

const DEPOSIT_HISTORY_COLUMNS: ColumnDef<HistoricalDeposit>[] = [
  {
    id: 'orderNumber',
    label: 'Order number',
    sortValue: (r) => r.number,
    render: (r) => (r.orderId ? <Link href={`/orders/${r.orderId}`}>{r.number}</Link> : r.number),
  },
  { id: 'type', label: 'Type', sortValue: (r) => r.type, render: (r) => r.type },
  { id: 'date', label: 'Date', sortValue: (r) => r.date, render: (r) => fmtDate(r.date) },
  {
    id: 'depositAmount',
    label: 'Deposit amount',
    ...money<HistoricalDeposit>((r) => r.depositCents),
  },
  {
    id: 'activityAmount',
    label: 'Activity amount',
    num: true,
    cellClassName: (r) => r.activityCents < 0 && 'text-danger',
    sortValue: (r) => r.activityCents,
    render: (r) => <Money cents={r.activityCents} />,
  },
  {
    id: 'reason',
    label: 'Reason for activity',
    cellClassName: () => 'capitalize',
    sortValue: (r) => r.reason,
    render: (r) => r.reason,
  },
];

const AR_COLUMNS: ColumnDef<ArItem>[] = [
  {
    id: 'reference',
    label: 'Reference',
    sortValue: (r) => r.reference,
    render: (r) => <Link href={`/orders/${r.orderId}`}>{r.reference}</Link>,
  },
  {
    id: 'transactionDate',
    label: 'Transaction date',
    sortValue: (r) => r.transactionDate,
    render: (r) => fmtDate(r.transactionDate),
  },
  {
    id: 'dueDate',
    label: 'Due date',
    sortValue: (r) => r.dueDate,
    render: (r) => fmtDate(r.dueDate),
  },
  {
    id: 'inDispute',
    label: 'In dispute',
    sortValue: (r) => r.inDispute,
    render: (r) => (r.inDispute ? 'Yes' : 'No'),
  },
  {
    id: 'transactionType',
    label: 'Transaction type',
    sortValue: (r) => r.transactionType,
    render: (r) => r.transactionType,
  },
  { id: 'memo', label: 'Memo reference', sortValue: (r) => r.memo, render: (r) => r.memo },
  {
    id: 'amount',
    label: 'Amount',
    num: true,
    sortValue: (r) => r.amountCents,
    render: (r) => (
      <strong>
        <Money cents={r.amountCents} />
      </strong>
    ),
  },
];

const SERVICE_COLUMNS: ColumnDef<ServiceOrderRow>[] = [
  {
    id: 'orderNumber',
    label: 'Order number',
    sortValue: (r) => r.number,
    render: (r) => <Link href={`/service/${r.id}`}>{r.number}</Link>,
  },
  {
    id: 'orderDate',
    label: 'Order date',
    sortValue: (r) => r.orderDate,
    render: (r) => fmtDate(r.orderDate),
  },
  { id: 'type', label: 'Type', sortValue: (r) => r.type, render: (r) => r.type },
  {
    id: 'coordinator',
    label: 'Coordinator',
    sortValue: (r) => r.coordinator,
    render: (r) => r.coordinator ?? '—',
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (r) => r.status,
    render: (r) => <StatusBadge status={r.status} />,
  },
  { id: 'product', label: 'Product', sortValue: (r) => r.product, render: (r) => r.product },
  {
    id: 'description',
    label: 'Product description',
    sortValue: (r) => r.description,
    render: (r) => r.description,
  },
  {
    id: 'estimatedDate',
    label: 'Estimated date',
    sortValue: (r) => r.estimatedDate,
    render: (r) => fmtDate(r.estimatedDate),
  },
  {
    id: 'scheduledDate',
    label: 'Scheduled date',
    sortValue: (r) => r.scheduledDate,
    render: (r) => fmtDate(r.scheduledDate),
  },
  { id: 'total', label: 'Total', ...money<ServiceOrderRow>((r) => r.totalCents) },
];

export default function CustomerActivityPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('general');

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('tab');
    if (initial && TABS.some((t) => t.key === initial)) setTab(initial as TabKey);
  }, []);

  useEffect(() => {
    if (!id) return;
    api<Activity>(`/v1/customers/${id}/activity`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  function pick(next: TabKey) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url.toString());
  }

  const backLink = <BackLink href={`/customers/${id}`}>Customer record</BackLink>;

  if (error && !data) {
    return (
      <div>
        <PageHeader eyebrow={backLink} title={PAGE_TITLE} />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <div data-testid="activity-loading">
        <PageHeader eyebrow={backLink} title={PAGE_TITLE} />
        <Stack>
          <Skeleton style={{ height: 120 }} />
          <Skeleton style={{ height: 320 }} />
        </Stack>
      </div>
    );
  }
  const c = data.customer;

  return (
    <div data-testid="customer-activity">
      <PageHeader
        eyebrow={backLink}
        title={PAGE_TITLE}
        actions={
          <LinkButton size="sm" href="/customers/activity">
            Look up another customer
          </LinkButton>
        }
      />

      <Stack>
        <Card
          title={<span data-testid="activity-name">{c.name}</span>}
          description={
            <>
              Customer code <code>{c.code}</code>
            </>
          }
          data-testid="activity-header"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <KeyValue
              rows={[
                { label: 'Cell phone', value: c.phone ?? '—' },
                { label: 'Home / other phone', value: c.phone2 ?? '—' },
              ]}
            />
            <KeyValue
              rows={[
                { label: 'Email address', value: c.email ?? '—' },
                {
                  label: 'Store credit balance',
                  value: (
                    <strong data-testid="activity-store-credit">
                      <Money cents={c.storeCreditCents} />
                    </strong>
                  ),
                },
              ]}
            />
          </div>
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          {/* Spec §12.4: the eight views run down the left (stack above the
              content on phones). No shared side-nav primitive exists yet, so
              this uses the card frame plus token utilities. */}
          <nav aria-label="Customer activity views" className="card card-flush lg:sticky lg:top-4">
            {TABS.map((t) => {
              const active = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => pick(t.key)}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`activity-tab-${t.key}`}
                  className={[
                    'block w-full cursor-pointer border-0 border-b border-l-[3px] border-b-border px-3.5 py-2.5 text-left transition-colors last:border-b-0',
                    active
                      ? 'border-l-brand bg-surface-muted font-bold'
                      : 'border-l-transparent bg-transparent font-medium hover:bg-surface-muted',
                  ].join(' ')}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0">
            {tab === 'general' && <GeneralInformation data={data} />}
            {tab === 'open-orders' && <OpenOrders data={data} />}
            {tab === 'order-lines' && <OrderLineDetails data={data} />}
            {tab === 'history' && <HistoricalPurchases data={data} />}
            {tab === 'deposits' && <CurrentDeposits data={data} />}
            {tab === 'deposit-history' && <HistoricalDeposits data={data} />}
            {tab === 'ar' && <OpenArItems data={data} />}
            {tab === 'service' && <OpenServiceOrders data={data} />}
          </div>
        </div>
      </Stack>
    </div>
  );
}

function GeneralInformation({ data }: { data: Activity }) {
  const a = data.customer.address;
  const t = data.general.totals;
  const rows: { label: string; y: YearTotals }[] = [
    { label: 'This year', y: t.thisYear },
    { label: 'Last year', y: t.lastYear },
    { label: 'Lifetime', y: t.lifetime },
  ];
  const cityLine = a
    ? [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'
    : '—';
  return (
    <Stack>
      <Card title="General information" data-testid="activity-general">
        <div className="grid gap-4 md:grid-cols-2">
          <KeyValue
            rows={[
              { label: 'Address 1', value: a?.line1 ?? '—' },
              { label: 'Address 2', value: a?.line2 ?? '—' },
              { label: 'City, State Zip Code', value: cityLine },
              { label: 'Ship from location', value: data.general.shipFromLocation ?? '—' },
            ]}
          />
          <KeyValue
            rows={[
              {
                label: 'Credit remarks / notes',
                value: <div className="whitespace-pre-wrap">{data.customer.notes ?? '—'}</div>,
              },
            ]}
          />
        </div>
      </Card>
      <Card title="Totals" flush data-testid="activity-totals">
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Period</span>
                </th>
                <th className="num">Sales</th>
                <th className="num">#</th>
                <th className="num">Returns</th>
                <th className="num">#</th>
                <th className="num">Service</th>
                <th className="num">#</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} data-testid={`totals-${r.label.toLowerCase().replace(' ', '-')}`}>
                  <td>
                    <strong>{r.label}</strong>
                  </td>
                  <td className="num">
                    <Money cents={r.y.sales.cents} />
                  </td>
                  <td className="num">{r.y.sales.count}</td>
                  <td className="num">
                    <Money cents={r.y.returns.cents} />
                  </td>
                  <td className="num">{r.y.returns.count}</td>
                  <td className="num">
                    <Money cents={r.y.service.cents} />
                  </td>
                  <td className="num">{r.y.service.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </Stack>
  );
}

function OpenOrdersSummary({ data }: { data: Activity }) {
  const o = data.openOrders;
  return (
    <StatGrid cols={5}>
      <StatTile label="Credit limit" value="Unlimited" />
      <StatTile
        label="Total orders"
        value={<Money cents={o.totalOrdersCents} />}
        data-testid="sum-total-orders"
      />
      <StatTile
        label="Deposits"
        value={<Money cents={o.depositsCents} />}
        data-testid="sum-deposits"
      />
      <StatTile label="Total A/R" value={<Money cents={o.arCents} />} data-testid="sum-ar" />
      <StatTile
        label="Unpaid balance"
        value={<Money cents={o.unpaidBalanceCents} />}
        tone={o.unpaidBalanceCents > 0 ? 'danger' : undefined}
        data-testid="sum-unpaid"
      />
    </StatGrid>
  );
}

function OpenOrders({ data }: { data: Activity }) {
  const rows = data.openOrders.rows;
  const cols = useListColumns('customer-activity-orders', OPEN_ORDER_COLUMNS, rows);
  const sum = (k: keyof (typeof rows)[number]) =>
    rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
  const totals: Record<string, number> = {
    merchandise: sum('merchandiseCents'),
    other: sum('otherCents'),
    total: sum('totalCents'),
    amountPaid: sum('amountPaidCents'),
    balance: sum('balanceCents'),
  };
  const totalsLabelId = cols.ordered.find((c) => !(c.id in totals))?.id;
  return (
    <Card title="Open orders" data-testid="activity-open-orders">
      <Stack>
        <OpenOrdersSummary data={data} />
        {rows.length === 0 ? (
          <EmptyState>No open orders.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="customer-activity-orders" />
              </thead>
              <tbody>
                {cols.sorted.map((r) => (
                  <tr key={r.id} data-testid="open-order-row">
                    <ColumnCells list={cols} row={r} />
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold">
                  {cols.ordered.map((c) => (
                    <td key={c.id} className={c.num ? 'num' : undefined}>
                      {c.id in totals ? (
                        <Money cents={totals[c.id] ?? 0} />
                      ) : c.id === totalsLabelId ? (
                        'Totals'
                      ) : null}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        )}
      </Stack>
    </Card>
  );
}

function OrderLineDetails({ data }: { data: Activity }) {
  const orders = data.orderLines;
  const [orderId, setOrderId] = useState<string>(orders[0]?.orderId ?? '');
  const current = useMemo(() => orders.find((o) => o.orderId === orderId), [orders, orderId]);
  const cols = useListColumns(
    'customer-activity-order-lines',
    ORDER_LINE_COLUMNS,
    current?.lines ?? null,
  );
  return (
    <Card
      title="Order line details"
      data-testid="activity-order-lines"
      actions={
        current ? (
          <LinkButton size="sm" href={`/orders/${current.orderId}`}>
            Open order
          </LinkButton>
        ) : undefined
      }
    >
      {orders.length === 0 ? (
        <EmptyState>No orders yet.</EmptyState>
      ) : (
        <>
          <Toolbar>
            <Field label="Order number">
              <Select
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                data-testid="order-lines-select"
              >
                {orders.map((o) => (
                  <option key={o.orderId} value={o.orderId}>
                    {o.number} · {o.status.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
          </Toolbar>
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="customer-activity-order-lines" />
              </thead>
              <tbody>
                {cols.sorted.map((l) => (
                  <tr key={l.id} data-testid="order-line-row">
                    <ColumnCells list={cols} row={l} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        </>
      )}
    </Card>
  );
}

function HistoricalPurchases({ data }: { data: Activity }) {
  const [filter, setFilter] = useState<'all' | 'order' | 'sale' | 'return'>('all');
  const rows = useMemo(
    () => data.historicalPurchases.filter((r) => filter === 'all' || r.docType === filter),
    [data.historicalPurchases, filter],
  );
  const cols = useListColumns('customer-activity-history', HISTORY_COLUMNS, rows);
  return (
    <Card title="Historical purchases" data-testid="activity-history">
      <Toolbar>
        <Field label="Document filter">
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            data-testid="history-filter"
          >
            <option value="all">All documents</option>
            <option value="order">Delivered orders</option>
            <option value="sale">Register sales</option>
            <option value="return">Returns</option>
          </Select>
        </Field>
      </Toolbar>
      {rows.length === 0 ? (
        <EmptyState>No completed purchases yet.</EmptyState>
      ) : (
        <TableWrap>
          <table className="table">
            <thead>
              <ColumnHeadRow list={cols} testIdPrefix="customer-activity-history" />
            </thead>
            <tbody>
              {cols.sorted.map((r, i) => (
                <tr key={`${r.docId}-${i}`} data-testid="history-row">
                  <ColumnCells list={cols} row={r} index={i} />
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

function CurrentDeposits({ data }: { data: Activity }) {
  const rows = data.currentDeposits;
  const cols = useListColumns('customer-activity-deposits', DEPOSIT_COLUMNS, rows);
  const totals: Record<string, { testid?: string; cents: number }> = {
    depositAmount: {
      testid: 'deposits-total',
      cents: rows.reduce((s, r) => s + r.depositCents, 0),
    },
    arCredit: { cents: rows.reduce((s, r) => s + r.arCreditCents, 0) },
  };
  const totalsLabelId = cols.ordered.find((c) => !totals[c.id])?.id;
  return (
    <Card title="Current deposits" data-testid="activity-deposits">
      {rows.length === 0 ? (
        <EmptyState>No open orders holding deposits.</EmptyState>
      ) : (
        <TableWrap>
          <table className="table">
            <thead>
              <ColumnHeadRow list={cols} testIdPrefix="customer-activity-deposits" />
            </thead>
            <tbody>
              {cols.sorted.map((r) => (
                <tr key={r.orderId} data-testid="deposit-row">
                  <ColumnCells list={cols} row={r} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                {cols.ordered.map((c) => {
                  const t = totals[c.id];
                  return (
                    <td key={c.id} className={c.num ? 'num' : undefined} data-testid={t?.testid}>
                      {t ? <Money cents={t.cents} /> : c.id === totalsLabelId ? 'Totals' : null}
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

function HistoricalDeposits({ data }: { data: Activity }) {
  const h = data.historicalDeposits;
  const cols = useListColumns('customer-activity-deposit-history', DEPOSIT_HISTORY_COLUMNS, h.rows);
  return (
    <Card title="Historical deposits" data-testid="activity-deposit-history">
      <Stack>
        <StatGrid cols={4}>
          <StatTile
            label="Total deposit liability"
            value={<Money cents={h.totalLiabilityCents} />}
            sub="Money held on undelivered orders"
            data-testid="deposit-liability"
          />
        </StatGrid>
        {h.rows.length === 0 ? (
          <EmptyState>No deposit activity yet.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="customer-activity-deposit-history" />
              </thead>
              <tbody>
                {cols.sorted.map((r) => (
                  <tr key={r.id} data-testid="deposit-history-row">
                    <ColumnCells list={cols} row={r} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        )}
      </Stack>
    </Card>
  );
}

function OpenArItems({ data }: { data: Activity }) {
  // Section-level window (`ar.range` / `ar.start` / `ar.end` in the URL);
  // "All time" is the default and means no filter. Filtering is client-side
  // on the rows already loaded, so there is nothing to wait for.
  const [range, setRange] = useUrlDateRange('all', { key: 'ar' });
  const rows = useMemo(
    () =>
      data.openArItems.filter((r) => {
        if (range.preset === 'all') return true;
        const d = (r.dueDate ?? r.transactionDate).slice(0, 10);
        return d >= range.start && d <= range.end;
      }),
    [data.openArItems, range.preset, range.start, range.end],
  );
  const cols = useListColumns('customer-activity-ar', AR_COLUMNS, rows);
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  return (
    <Card title="Open A/R items" data-testid="activity-ar">
      <Toolbar>
        {/* Not a <label>: the picker's popover has its own controls, and a
            wrapping label would re-dispatch stray clicks to the trigger. */}
        <div className="field">
          <span className="field-label" id="ar-range-label">
            Due / transaction date
          </span>
          <div aria-labelledby="ar-range-label">
            <DateRangePicker
              value={range}
              onChange={setRange}
              compact
              allowAllTime
              align="left"
              testid="ar-range"
            />
          </div>
        </div>
      </Toolbar>
      <Stack>
        <StatGrid cols={4}>
          <StatTile label="Credit limit" value="Unlimited" />
          <StatTile
            label="Open receivables"
            value={<Money cents={total} />}
            tone={total > 0 ? 'danger' : undefined}
            data-testid="ar-total"
          />
        </StatGrid>
        {rows.length === 0 ? (
          <EmptyState>Nothing owed on delivered orders or scheduled installments.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="customer-activity-ar" />
              </thead>
              <tbody>
                {cols.sorted.map((r) => (
                  <tr key={r.id} data-testid="ar-row">
                    <ColumnCells list={cols} row={r} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        )}
      </Stack>
    </Card>
  );
}

function OpenServiceOrders({ data }: { data: Activity }) {
  const rows = data.openServiceOrders;
  const cols = useListColumns('customer-activity-service', SERVICE_COLUMNS, rows);
  return (
    <Card title="Open service orders" data-testid="activity-service">
      <Stack>
        <OpenOrdersSummary data={data} />
        {rows.length === 0 ? (
          <EmptyState>No open service orders.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="customer-activity-service" />
              </thead>
              <tbody>
                {cols.sorted.map((r) => (
                  <tr key={r.id} data-testid="service-row">
                    <ColumnCells list={cols} row={r} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        )}
      </Stack>
    </Card>
  );
}
