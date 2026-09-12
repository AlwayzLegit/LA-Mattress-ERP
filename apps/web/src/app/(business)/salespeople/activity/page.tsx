'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  Alert,
  BackLink,
  Card,
  EmptyState,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  TableEmpty,
  TableWrap,
  Toolbar,
  rowKeys,
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
              if (e.key === 'Enter' && hits[0]) {
                router.push(`/salespeople/${hits[0].membershipId}/activity`);
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
                <tr>
                  <th>Salesperson</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {hits.length === 0 && <TableEmpty colSpan={4}>No salespeople match.</TableEmpty>}
                {hits.map((m) => (
                  <tr
                    {...rowKeys}
                    key={m.membershipId}
                    data-testid="sp-lookup-hit"
                    onClick={() => router.push(`/salespeople/${m.membershipId}/activity`)}
                    className="cursor-pointer"
                  >
                    <td>
                      <strong>{m.name ?? '(no name)'}</strong>
                    </td>
                    <td>{m.email}</td>
                    <td>{m.roleName ?? '—'}</td>
                    <td className="actions">
                      <LinkButton
                        size="sm"
                        variant="ghost"
                        href={`/salespeople/${m.membershipId}/activity`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        View activity
                      </LinkButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
