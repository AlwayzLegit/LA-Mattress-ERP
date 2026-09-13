'use client';

import { Search, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
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
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';

interface CustomerRow {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  notes: string | null;
  createdAt: string;
}

const CUSTOMER_COLUMNS: ColumnDef<CustomerRow>[] = [
  {
    id: 'name',
    label: 'Name',
    sortValue: (c) => displayName(c),
    render: (c) => <strong>{displayName(c) || <span className="muted">—</span>}</strong>,
  },
  { id: 'email', label: 'Email', sortValue: (c) => c.email, render: (c) => c.email ?? '—' },
  { id: 'phone', label: 'Phone', sortValue: (c) => c.phone, render: (c) => c.phone ?? '—' },
  {
    id: 'actions',
    label: '',
    srLabel: 'Actions',
    className: 'actions',
    fixed: true,
    render: (c) => (
      <LinkButton size="sm" href={`/customers/${c.id}`}>
        Open
      </LinkButton>
    ),
  },
];

export default function CustomersPage() {
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const cols = useListColumns('customers', CUSTOMER_COLUMNS, rows);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  function buildUrl(query: string, cursor?: string | null) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    return `/v1/customers${qs ? `?${qs}` : ''}`;
  }

  async function load(query: string) {
    setError(null);
    try {
      const res = await api<{ data: CustomerRow[]; nextCursor: string | null }>(buildUrl(query));
      setRows(res.data);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api<{ data: CustomerRow[]; nextCursor: string | null }>(
        buildUrl(q, nextCursor),
      );
      setRows((prev) => [...(prev ?? []), ...res.data]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void load('');
  }, []);

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void load(q);
  }

  const showEmptyPage = rows !== null && rows.length === 0 && !q;

  return (
    <div>
      <PageHeader
        title="Customers"
        actions={
          <>
            <LinkButton href="/customers/activity" size="sm" data-testid="customers-activity-link">
              View customer activity
            </LinkButton>
            <LinkButton href="/customers/new" variant="primary">
              <UserPlus size={14} aria-hidden />
              Add customer
            </LinkButton>
          </>
        }
      />

      <form onSubmit={search}>
        <Toolbar>
          <Input
            name="q"
            placeholder="Search by name, email, or phone"
            aria-label="Search customers"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button type="submit" variant="primary" size="sm">
            <Search size={14} aria-hidden />
            Search
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('');
              void load('');
            }}
          >
            Clear
          </Button>
        </Toolbar>
      </form>

      {error && <Alert tone="error">{error}</Alert>}

      <Stack>
        {!rows && !error && <LoadingRows />}
        {showEmptyPage && (
          <EmptyState
            title="No customers yet"
            action={
              <LinkButton size="sm" href="/customers/new">
                Add customer
              </LinkButton>
            }
          >
            Add the first one here, or create customers inline while writing a sale.
          </EmptyState>
        )}
        {rows && !showEmptyPage && (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="customers" />
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>
                      No customers match &ldquo;{q}&rdquo;.
                    </TableEmpty>
                  )}
                  {cols.sorted.map((c) => (
                    <tr key={c.id}>
                      <ColumnCells list={cols} row={c} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
          </Card>
        )}
        {nextCursor && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </Stack>
    </div>
  );
}

function displayName(c: CustomerRow): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ');
}
