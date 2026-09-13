'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
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

interface GiftCard {
  id: string;
  code: string;
  initialBalanceCents: number;
  currentBalanceCents: number;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

const GIFT_CARD_COLUMNS: ColumnDef<GiftCard>[] = [
  {
    id: 'code',
    label: 'Code',
    sortValue: (g) => g.code,
    render: (g) => <code>{g.code}</code>,
  },
  {
    id: 'balance',
    label: 'Balance',
    num: true,
    sortValue: (g) => g.currentBalanceCents,
    render: (g) => (
      <>
        <Money cents={g.currentBalanceCents} />
        <div className="muted">
          of <Money cents={g.initialBalanceCents} />
        </div>
      </>
    ),
  },
  {
    id: 'issuedFor',
    label: 'Issued for',
    render: () => '—',
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (g) => g.status,
    render: (g) => <StatusBadge status={g.status} />,
  },
  {
    id: 'issued',
    label: 'Issued',
    className: 'nowrap',
    sortValue: (g) => g.createdAt,
    render: (g) => new Date(g.createdAt).toLocaleDateString(),
  },
  {
    id: 'expires',
    label: 'Expires',
    className: 'nowrap',
    sortValue: (g) => g.expiresAt,
    render: (g) => (g.expiresAt ? new Date(g.expiresAt).toLocaleDateString() : '—'),
  },
  {
    id: 'actions',
    label: '',
    srLabel: 'Actions',
    className: 'actions',
    fixed: true,
    render: (g) => (
      <LinkButton size="sm" href={`/gift-cards/${g.id}`}>
        Open
      </LinkButton>
    ),
  },
];

export default function GiftCardsPage() {
  const [rows, setRows] = useState<GiftCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cols = useListColumns('gift-cards', GIFT_CARD_COLUMNS, rows);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api<{ data: GiftCard[]; nextCursor: string | null }>('/v1/gift-cards');
        setRows(res.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  return (
    <div>
      <PageHeader
        title="Gift cards"
        actions={
          <LinkButton href="/gift-cards/new" variant="primary">
            + Issue new
          </LinkButton>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {!rows && !error && (
          <Card>
            <LoadingRows />
          </Card>
        )}
        {rows && rows.length === 0 && (
          <Card>
            <EmptyState title="No gift cards issued yet">
              Use “+ Issue new” to create the first one.
            </EmptyState>
          </Card>
        )}
        {rows && rows.length > 0 && (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="gift-cards" />
                </thead>
                <tbody>
                  {cols.sorted.map((g) => (
                    <tr key={g.id}>
                      <ColumnCells list={cols} row={g} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
          </Card>
        )}
      </Stack>
    </div>
  );
}
