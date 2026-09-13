'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  SectionHeading,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';

interface SummaryRow {
  key: string;
  label: string;
  documentCount: number;
  merchandiseCents: number;
  totalCents: number;
}

interface SalesSummary {
  rows: SummaryRow[];
  totals: { documentCount: number; totalCents: number };
}

interface OrderRow {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  createdAt: string;
}

interface SaleRow {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  createdAt: string;
}

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
}

const ORDER_COLUMNS: ColumnDef<OrderRow>[] = [
  {
    id: 'order',
    label: 'Order',
    sortValue: (o) => o.number,
    render: (o) => <Link href={`/orders/${o.id}`}>{o.number}</Link>,
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (o) => o.status,
    render: (o) => <StatusBadge status={o.status} />,
  },
  {
    id: 'total',
    label: 'Total',
    num: true,
    sortValue: (o) => o.totalCents,
    render: (o) => <Money cents={o.totalCents} />,
  },
];

const SALE_COLUMNS: ColumnDef<SaleRow>[] = [
  {
    id: 'sale',
    label: 'Sale',
    sortValue: (s) => s.number,
    render: (s) => s.number,
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (s) => s.status,
    render: (s) => <StatusBadge status={s.status} />,
  },
  {
    id: 'total',
    label: 'Total',
    num: true,
    sortValue: (s) => s.totalCents,
    render: (s) => <Money cents={s.totalCents} />,
  },
];

/**
 * Salesperson activity (Sales Views Phase 4): one grid of written
 * activity per salesperson over the window, with a drill-in listing the
 * person's orders and POS sales. Store data scope applies server-side.
 */
export default function SalespeoplePage() {
  // Window lives in the URL (`?range=last30` / `?start&end`) so the view can
  // be bookmarked; the report and the drill-in share it.
  const [range, setRange, ready] = useUrlDateRange('last30');
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [picked, setPicked] = useState<SummaryRow | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [sales, setSales] = useState<SaleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<MemberRow[]>('/v1/business/members')
      .then(setMembers)
      .catch(() => setMembers([]));
  }, []);

  // Refetch whenever the window changes (once the URL has been read). A
  // drill-in from the previous window would no longer match the table, so
  // it closes here and the user re-opens it against the new window.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setPicked(null);
    setOrders(null);
    setSales(null);
    api<SalesSummary>(
      `/v1/reports/sales/summary?basis=written&groupBy=salesperson&start=${range.start}&end=${range.end}`,
    )
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ready, range.start, range.end]);

  async function drill(row: SummaryRow) {
    setPicked(row);
    setOrders(null);
    setSales(null);
    // The summary keys salespeople by user id; orders filter by
    // membership id — resolve through the member list.
    const member = members.find((m) => m.userId === row.key);
    // Same window as the table so the documents listed add up to the row.
    const windowQs = `start=${range.start}&end=${range.end}`;
    try {
      const [o, sl] = await Promise.all([
        member
          ? api<{ data: OrderRow[] }>(
              `/v1/orders?limit=100&salespersonMembershipId=${member.membershipId}&${windowQs}`,
            )
          : Promise.resolve({ data: [] as OrderRow[] }),
        row.key
          ? api<{ data: SaleRow[] }>(`/v1/sales?limit=100&associateUserId=${row.key}&${windowQs}`)
          : Promise.resolve({ data: [] as SaleRow[] }),
      ]);
      setOrders(o.data);
      setSales(sl.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Built inline: the actions cell needs `members` and `drill`.
  const summaryColumns: ColumnDef<SummaryRow>[] = [
    {
      id: 'salesperson',
      label: 'Salesperson',
      sortValue: (r) => r.label,
      render: (r) => r.label,
    },
    {
      id: 'documents',
      label: 'Documents',
      num: true,
      sortValue: (r) => r.documentCount,
      render: (r) => r.documentCount,
    },
    {
      id: 'merchandise',
      label: 'Merchandise',
      num: true,
      sortValue: (r) => r.merchandiseCents,
      render: (r) => <Money cents={r.merchandiseCents} />,
    },
    {
      id: 'totalWritten',
      label: 'Total written',
      num: true,
      sortValue: (r) => r.totalCents,
      render: (r) => <Money cents={r.totalCents} />,
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => {
        const member = members.find((m) => m.userId === r.key);
        return (
          <>
            <Button size="sm" variant="ghost" onClick={() => void drill(r)}>
              Documents
            </Button>
            {member ? (
              <LinkButton
                size="sm"
                variant="ghost"
                href={`/salespeople/${member.membershipId}/activity`}
                data-testid="salesperson-activity"
              >
                View activity
              </LinkButton>
            ) : null}
          </>
        );
      },
    },
  ];
  const cols = useListColumns('salespeople', summaryColumns, summary?.rows ?? null);
  const orderCols = useListColumns('salespeople-orders', ORDER_COLUMNS, orders);
  const saleCols = useListColumns('salespeople-sales', SALE_COLUMNS, sales);

  return (
    <div>
      <PageHeader
        title="Salespeople"
        sub="Written activity per salesperson over the window."
        actions={
          <>
            <LinkButton
              size="sm"
              href="/salespeople/activity"
              data-testid="salespeople-activity-link"
            >
              View salesperson activity
            </LinkButton>
            <DateRangePicker value={range} onChange={setRange} testid="salespeople-range" />
          </>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        <Card title="Written activity" flush>
          {!summary ? (
            <div className="p-4">
              <LoadingRows />
            </div>
          ) : (
            <TableWrap>
              <table className="table" data-testid="salespeople-table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="salespeople" />
                </thead>
                <tbody>
                  {summary.rows.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>Nothing in this window.</TableEmpty>
                  )}
                  {cols.sorted.map((r) => (
                    <tr key={r.key || '(none)'}>
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
          )}
        </Card>

        {picked && (
          <Card title={`Documents — ${picked.label}`}>
            {!orders || !sales ? (
              <LoadingRows />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <SectionHeading as="h3" title="Orders" />
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <ColumnHeadRow list={orderCols} testIdPrefix="salespeople-orders" />
                      </thead>
                      <tbody>
                        {orders.length === 0 && (
                          <TableEmpty colSpan={orderCols.ordered.length}>
                            Nothing in this window.
                          </TableEmpty>
                        )}
                        {orderCols.sorted.map((o) => (
                          <tr key={o.id}>
                            <ColumnCells list={orderCols} row={o} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <ResetColumns list={orderCols} />
                  </TableWrap>
                </div>
                <div>
                  <SectionHeading as="h3" title="POS sales" />
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <ColumnHeadRow list={saleCols} testIdPrefix="salespeople-sales" />
                      </thead>
                      <tbody>
                        {sales.length === 0 && (
                          <TableEmpty colSpan={saleCols.ordered.length}>
                            Nothing in this window.
                          </TableEmpty>
                        )}
                        {saleCols.sorted.map((sl) => (
                          <tr key={sl.id}>
                            <ColumnCells list={saleCols} row={sl} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <ResetColumns list={saleCols} />
                  </TableWrap>
                </div>
              </div>
            )}
          </Card>
        )}
      </Stack>
    </div>
  );
}
