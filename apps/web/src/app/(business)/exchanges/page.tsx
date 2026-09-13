'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Repeat } from 'lucide-react';
import { LoadMore } from '@/components/load-more';
import { useCursorList } from '@/lib/use-cursor-list';
import { Money } from '@/components/money';
import {
  Alert,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Stack,
  StatusBadge,
  TableWrap,
  useListColumns,
} from '@/components/ui';

interface ExchangeRow {
  id: string;
  number: string;
  status: string;
  rmaNumber: string | null;
  returnCents: number;
  restockingFeeCents: number;
  saleOrderNumber: string | null;
  saleTotalCents: number;
  originalOrderNumber: string | null;
  referencedOrderNumber: string | null;
  customerName: string | null;
  createdAt: string;
}

const EXCHANGE_COLUMNS: ColumnDef<ExchangeRow>[] = [
  {
    id: 'number',
    label: 'Exchange',
    sortValue: (r) => r.number,
    render: (r) => (
      <Link href={`/exchanges/${r.id}`}>
        <code>{r.number}</code>
      </Link>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (r) => r.status,
    render: (r) => <StatusBadge status={r.status} />,
  },
  {
    id: 'customer',
    label: 'Customer',
    sortValue: (r) => r.customerName,
    render: (r) => r.customerName ?? '—',
  },
  {
    id: 'original',
    label: 'Original',
    sortValue: (r) => r.originalOrderNumber ?? r.referencedOrderNumber,
    render: (r) => <code>{r.originalOrderNumber ?? r.referencedOrderNumber ?? '—'}</code>,
  },
  {
    id: 'returnCredit',
    label: 'Return credit',
    num: true,
    sortValue: (r) => r.returnCents,
    render: (r) => <Money cents={r.returnCents} />,
  },
  {
    id: 'fee',
    label: 'Fee',
    num: true,
    sortValue: (r) => r.restockingFeeCents,
    render: (r) => (r.restockingFeeCents > 0 ? <Money cents={r.restockingFeeCents} /> : '—'),
  },
  {
    id: 'replacement',
    label: 'Replacement',
    sortValue: (r) => r.saleOrderNumber,
    render: (r) => <code>{r.saleOrderNumber ?? '—'}</code>,
  },
  {
    id: 'saleTotal',
    label: 'Sale total',
    num: true,
    sortValue: (r) => r.saleTotalCents,
    render: (r) => <Money cents={r.saleTotalCents} />,
  },
  {
    id: 'written',
    label: 'Written',
    className: 'nowrap',
    sortValue: (r) => r.createdAt,
    render: (r) => new Date(r.createdAt).toLocaleDateString(),
  },
];

export default function ExchangesPage() {
  const list = useCursorList<ExchangeRow>('/v1/exchanges');
  const { rows, error } = list;
  const cols = useListColumns('exchanges', EXCHANGE_COLUMNS, rows);

  useEffect(() => {
    void list.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <PageHeader
        title="Exchanges"
        sub="One settlement over two documents: the return credits the replacement; the difference is the balance due."
        actions={
          <LinkButton href="/exchanges/new" variant="primary">
            <Repeat size={14} />
            New exchange
          </LinkButton>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {rows == null && !error && <LoadingRows rows={4} />}
        {rows && rows.length === 0 && (
          <EmptyState
            title="No exchanges yet"
            action={
              <LinkButton size="sm" href="/exchanges/new">
                New exchange
              </LinkButton>
            }
          >
            Start one from an order&apos;s detail page or with New exchange.
          </EmptyState>
        )}
        {rows && rows.length > 0 && (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="exchanges" />
                </thead>
                <tbody>
                  {cols.sorted.map((r) => (
                    <tr key={r.id}>
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
            <LoadMore state={list} noun="exchanges" />
          </Card>
        )}
      </Stack>
    </div>
  );
}
