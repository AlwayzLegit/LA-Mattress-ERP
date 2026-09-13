'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LoadMore } from '@/components/load-more';
import { useCursorList } from '@/lib/use-cursor-list';
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

interface TransferRow {
  id: string;
  number: string;
  status: string;
  transferType: string;
  scheduledFor: string | null;
  orderId: string | null;
  fromLocationName: string | null;
  toLocationName: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

const TRANSFER_COLUMNS: ColumnDef<TransferRow>[] = [
  {
    id: 'number',
    label: 'Transfer',
    sortValue: (t) => t.number,
    render: (t) => (
      <>
        <code>{t.number}</code>
        {t.orderId && (
          <>
            {' '}
            <Link href={`/orders/${t.orderId}`} className="muted">
              order
            </Link>
          </>
        )}
      </>
    ),
  },
  {
    id: 'type',
    label: 'Type',
    sortValue: (t) => t.transferType,
    render: (t) => t.transferType.replace('_', ' '),
  },
  {
    id: 'from',
    label: 'From',
    sortValue: (t) => t.fromLocationName,
    render: (t) => t.fromLocationName ?? '—',
  },
  {
    id: 'to',
    label: 'To',
    sortValue: (t) => t.toLocationName,
    render: (t) => t.toLocationName ?? '—',
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (t) => t.status,
    render: (t) => <StatusBadge status={t.status} />,
  },
  {
    id: 'scheduled',
    label: 'Scheduled',
    title: 'Auto transfers: the XFR-053 schedule date',
    sortValue: (t) => t.scheduledFor,
    render: (t) =>
      t.scheduledFor ? new Date(`${t.scheduledFor}T00:00:00`).toLocaleDateString() : '—',
  },
  {
    id: 'created',
    label: 'Created',
    sortValue: (t) => t.createdAt,
    render: (t) => new Date(t.createdAt).toLocaleDateString(),
  },
  {
    id: 'actions',
    label: '',
    srLabel: 'Actions',
    className: 'actions',
    fixed: true,
    render: (t) => (
      <LinkButton size="sm" href={`/transfers/${t.id}`}>
        Open
      </LinkButton>
    ),
  },
];

export default function TransfersPage() {
  const list = useCursorList<TransferRow>('/v1/stock-transfers');
  const [aging, setAging] = useState<{ id: string; number: string; daysInTransit: number }[]>([]);
  const { rows, error } = list;
  const cols = useListColumns('transfers', TRANSFER_COLUMNS, rows);

  useEffect(() => {
    api<{ id: string; number: string; daysInTransit: number }[]>('/v1/stock-transfers/aging?days=3')
      .then(setAging)
      .catch(() => setAging([]));
  }, []);

  useEffect(() => {
    void list.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <PageHeader
        title="Stock transfers"
        actions={
          <>
            <LinkButton href="/transfers/manifests" variant="secondary" size="sm">
              Manifests
            </LinkButton>
            <LinkButton href="/transfers/new" variant="primary">
              + New transfer
            </LinkButton>
          </>
        }
      />
      <Stack>
        {aging.length > 0 && (
          <Alert tone="error" title="In transit too long" data-testid="transfer-aging-alert">
            {aging.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ' · '}
                <Link href={`/transfers/${a.id}`}>
                  {a.number} ({a.daysInTransit}d)
                </Link>
              </span>
            ))}
            <span className="muted">
              {' '}
              — receive them or close them short; goods on the road are sellable nowhere.
            </span>
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {rows == null ? (
          <Card>
            <LoadingRows />
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              title="No transfers yet"
              action={
                <LinkButton size="sm" href="/transfers/new">
                  New transfer
                </LinkButton>
              }
            >
              Create a transfer to move stock between locations.
            </EmptyState>
          </Card>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="transfers" />
                </thead>
                <tbody>
                  {cols.sorted.map((t) => (
                    <tr key={t.id}>
                      <ColumnCells list={cols} row={t} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
            <LoadMore state={list} noun="transfers" />
          </Card>
        )}
      </Stack>
    </div>
  );
}
