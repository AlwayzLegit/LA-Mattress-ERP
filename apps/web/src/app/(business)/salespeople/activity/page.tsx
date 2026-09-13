'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  Alert,
  BackLink,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  TableEmpty,
  TableWrap,
  Toolbar,
  rowKeys,
  useListColumns,
} from '@/components/ui';

/**
 * View Salesperson Activity — lookup (owner 2026-09-02, STORIS-style):
 * pick a member of the business and land on their activity views.
 */

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
  roleName?: string | null;
  status?: string;
}

const MEMBER_COLUMNS: ColumnDef<MemberRow>[] = [
  {
    id: 'salesperson',
    label: 'Salesperson',
    sortValue: (m) => m.name,
    render: (m) => <strong>{m.name ?? '(no name)'}</strong>,
  },
  {
    id: 'email',
    label: 'Email',
    sortValue: (m) => m.email,
    render: (m) => m.email,
  },
  {
    id: 'role',
    label: 'Role',
    sortValue: (m) => m.roleName,
    render: (m) => m.roleName ?? '—',
  },
  {
    id: 'actions',
    label: '',
    srLabel: 'Actions',
    className: 'actions',
    fixed: true,
    render: (m) => (
      <LinkButton
        size="sm"
        variant="ghost"
        href={`/salespeople/${m.membershipId}/activity`}
        onClick={(e) => e.stopPropagation()}
      >
        View activity
      </LinkButton>
    ),
  },
];

export default function SalespersonActivityLookupPage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<MemberRow[]>('/v1/business/members')
      .then(setMembers)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const term = q.trim().toLowerCase();
  const hits = (members ?? []).filter(
    (m) =>
      !term || (m.name ?? '').toLowerCase().includes(term) || m.email.toLowerCase().includes(term),
  );
  const cols = useListColumns('salespeople-activity', MEMBER_COLUMNS, hits);

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/salespeople">Salespeople</BackLink>}
        title="View Salesperson Activity"
        sub="Pick a salesperson to see their open, completed and canceled orders, layaways, carts, quotes and leads."
      />
      <Card>
        <Toolbar>
          <Input
            type="search"
            autoFocus
            aria-label="Salesperson"
            placeholder="Search by name or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              const first = cols.sorted[0];
              if (e.key === 'Enter' && first) {
                router.push(`/salespeople/${first.membershipId}/activity`);
              }
            }}
            data-testid="sp-lookup"
          />
        </Toolbar>
        {error && <Alert tone="error">{error}</Alert>}
        {!members && !error && <LoadingRows rows={4} />}
        {members && members.length === 0 && (
          <EmptyState title="No salespeople yet">
            Invite members to the business to look up their activity.
          </EmptyState>
        )}
        {members && members.length > 0 && (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="salespeople-activity" />
              </thead>
              <tbody>
                {hits.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>No salespeople match.</TableEmpty>
                )}
                {cols.sorted.map((m) => (
                  <tr
                    {...rowKeys}
                    key={m.membershipId}
                    data-testid="sp-lookup-hit"
                    onClick={() => router.push(`/salespeople/${m.membershipId}/activity`)}
                    className="cursor-pointer"
                  >
                    <ColumnCells list={cols} row={m} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
