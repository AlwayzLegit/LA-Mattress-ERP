'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Field,
  Input,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import { useSession } from '@/lib/auth-client';
import { api, apiUrl } from '@/lib/api';
import { addDays, type DateRange } from '@/lib/date-range';

interface AuditLogRow {
  id: string;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  changesJson: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface Filters {
  action: string;
  actorUserId: string;
}

/**
 * Query params for /v1/audit-logs. The API treats `until` as EXCLUSIVE,
 * so an inclusive picker range `[start, end]` becomes
 * `since=start&until=end+1 day`; "All time" sends neither bound.
 */
function auditParams(filters: Filters, range: DateRange): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.action) params.set('action', filters.action);
  if (filters.actorUserId) params.set('actorUserId', filters.actorUserId);
  if (range.preset !== 'all') {
    params.set('since', range.start);
    params.set('until', addDays(range.end, 1));
  }
  return params;
}

const AUDIT_COLUMNS: ColumnDef<AuditLogRow>[] = [
  {
    id: 'when',
    label: 'When',
    className: 'nowrap',
    sortValue: (r) => r.createdAt,
    render: (r) => new Date(r.createdAt).toLocaleString(),
  },
  {
    id: 'actor',
    label: 'Actor',
    sortValue: (r) => r.actorEmail,
    render: (r) => r.actorEmail ?? <em>system</em>,
  },
  {
    id: 'action',
    label: 'Action',
    sortValue: (r) => r.action,
    render: (r) => <code>{r.action}</code>,
  },
  {
    id: 'target',
    label: 'Target',
    sortValue: (r) => (r.targetType ? `${r.targetType}:${r.targetId ?? ''}` : null),
    render: (r) =>
      r.targetType ? (
        <span>
          {r.targetType}
          {r.targetId ? `:${r.targetId.slice(0, 8)}…` : ''}
        </span>
      ) : (
        <em className="muted">—</em>
      ),
  },
  {
    id: 'diff',
    label: 'Diff',
    render: (r) =>
      r.changesJson ? (
        <pre className="m-0 whitespace-pre-wrap rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-muted)] p-1.5 font-mono text-xs">
          {JSON.stringify(r.changesJson, null, 2)}
        </pre>
      ) : (
        <em className="muted">—</em>
      ),
  },
];

export default function AuditLogPage() {
  const session = useSession();
  const [filters, setFilters] = useState<Filters>({ action: '', actorUserId: '' });
  // Page-level window (?range= / ?start=&end=); "All time" restores the
  // unbounded stream the page had before the picker.
  const [range, setRange, rangeReady] = useUrlDateRange('last30');
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cols = useListColumns('audit', AUDIT_COLUMNS, rows);

  async function fetchRows(currentFilters: Filters, currentRange: DateRange): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const params = auditParams(currentFilters, currentRange);
      // Uses the shared api() helper like every other page: this one
      // hand-rolled fetch against its own NEXT_PUBLIC_API_URL default,
      // so in production it called http://localhost:4000 and the global
      // audit log was permanently "Failed to fetch" (QA 2026-08-26, D8).
      const body = await api<{ data: AuditLogRow[]; nextCursor: string | null }>(
        `/v1/audit-logs?${params.toString()}`,
      );
      setRows(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Wait for the URL window to be read so we don't fetch twice.
    if (session.data && rangeReady) void fetchRows(filters, range);
    // We refetch on session change and when the picker applies a new
    // window, not on every keystroke; the form submit calls fetchRows
    // explicitly with the current values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.data?.user.id, rangeReady, range]);

  if (session.isPending) {
    return (
      <div>
        <PageHeader title="Audit log" />
        <LoadingRows />
      </div>
    );
  }
  if (!session.data) {
    return (
      <div>
        <PageHeader title="Audit log" />
        <Alert tone="warning">Sign in required.</Alert>
      </div>
    );
  }

  const exportHref = (() => {
    const qs = auditParams(filters, range).toString();
    return `${apiUrl}/v1/audit-logs/export.csv${qs ? `?${qs}` : ''}`;
  })();

  return (
    <div>
      <PageHeader
        title="Audit log"
        actions={
          <>
            <DateRangePicker value={range} onChange={setRange} allowAllTime testid="audit-range" />
            <a
              className="btn btn-secondary btn-sm"
              href={exportHref}
              title="Download the filtered stream as CSV (the export itself is audited)"
              data-testid="audit-export"
            >
              Export CSV
            </a>
          </>
        }
      />
      <FilterForm
        filters={filters}
        onChange={setFilters}
        onSubmit={(next) => fetchRows(next, range)}
        pending={loading}
      />
      <Stack>
        {error && (
          <Alert tone="error" data-testid="audit-error">
            {error}
          </Alert>
        )}
        {loading && !rows && <LoadingRows />}
        {rows && (
          <Card flush>
            <TableWrap>
              <table data-testid="audit-table" className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="audit" />
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>
                      No audit log entries match these filters.
                    </TableEmpty>
                  )}
                  {cols.sorted.map((r) => (
                    <tr key={r.id} className="align-top">
                      <ColumnCells list={cols} row={r} />
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

function FilterForm({
  filters,
  onChange,
  onSubmit,
  pending,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  onSubmit: (next: Filters) => void;
  pending: boolean;
}) {
  function handle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSubmit(filters);
  }
  return (
    <form onSubmit={handle}>
      <Toolbar className="items-end">
        <Field label="Action" className="min-w-[220px] max-w-[340px] flex-1">
          <Input
            name="action"
            value={filters.action}
            onChange={(e) => onChange({ ...filters, action: e.target.value })}
            placeholder="product.variant.price.update"
          />
        </Field>
        <Field label="Actor user id" className="min-w-[220px] max-w-[340px] flex-1">
          <Input
            name="actorUserId"
            value={filters.actorUserId}
            onChange={(e) => onChange({ ...filters, actorUserId: e.target.value })}
            placeholder="uuid"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={pending}>
          Apply
        </Button>
      </Toolbar>
    </form>
  );
}
