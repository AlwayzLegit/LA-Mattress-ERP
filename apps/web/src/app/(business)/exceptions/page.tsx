'use client';

import Link from 'next/link';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatRange, presetLabel, type DateRange } from '@/lib/date-range';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import { LoadMore } from '@/components/load-more';
import { useCursorList } from '@/lib/use-cursor-list';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  StatusBadge,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';

/**
 * Exception register (PLAN-STORIS-GAP §0.3): overrides, unlocks,
 * over-capacity bookings, write-offs — severity-tagged and
 * acknowledge-able, so nothing gets scrolled past. The ranked digest
 * (§2) is the per-associate outlier report the owner reads weekly.
 */

interface ExceptionRow {
  id: string;
  type: string;
  severity: string;
  actorEmail: string | null;
  summary: string;
  acknowledgedAt: string | null;
  acknowledgedByEmail: string | null;
  createdAt: string;
  orderId: string | null;
  orderNumber: string | null;
}

interface DigestRow {
  actorUserId: string | null;
  actorEmail: string | null;
  total: number;
  byType: Record<string, number>;
}

/** "Last 7 days" / "Aug 4 – Sep 2, 2026" — the digest card's window, capitalised. */
function windowTitle(range: DateRange): string {
  const label = presetLabel(range.preset);
  return label === 'Custom' ? formatRange(range) : label;
}

const TYPE_LABELS: Record<string, string> = {
  security_override: 'Security override',
  order_unlock: 'Order unlock',
  delivery_cap_override: 'Over-capacity booking',
  write_off: 'Write-off',
  vendor_credit_write_off: 'Vendor credit given up',
};

const DIGEST_COLUMNS: ColumnDef<DigestRow>[] = [
  {
    id: 'associate',
    label: 'Associate',
    sortValue: (d) => d.actorEmail,
    render: (d) => d.actorEmail ?? 'system',
  },
  {
    id: 'total',
    label: 'Total',
    num: true,
    sortValue: (d) => d.total,
    render: (d) => <strong>{d.total}</strong>,
  },
  {
    id: 'breakdown',
    label: 'Breakdown',
    render: (d) => (
      <span className="muted">
        {Object.entries(d.byType)
          .map(([t, n]) => `${TYPE_LABELS[t] ?? t.replace(/_/g, ' ')} ×${n}`)
          .join(' · ')}
      </span>
    ),
  },
];

export default function ExceptionsPage() {
  const [openOnly, setOpenOnly] = useState(true);
  const [severity, setSeverity] = useState('');
  const list = useCursorList<ExceptionRow>('/v1/exceptions');
  const [digest, setDigest] = useState<DigestRow[] | null>(null);
  // The digest carries its own window (owner 2026-09-02), namespaced in
  // the URL as `digest.range` / `digest.start` / `digest.end`.
  const [digestRange, setDigestRange, digestReady] = useUrlDateRange('last7', { key: 'digest' });
  const [busy, setBusy] = useState(false);
  const { rows, error } = list;

  const load = useCallback(async () => {
    await list.load({
      ...(openOnly ? { open: '1' } : {}),
      ...(severity ? { severity } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOnly, severity]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!digestReady) return;
    let cancelled = false;
    setDigest(null);
    api<DigestRow[]>(`/v1/exceptions/digest?start=${digestRange.start}&end=${digestRange.end}`)
      .then((rows) => {
        if (!cancelled) setDigest(rows);
      })
      .catch(() => {
        if (!cancelled) setDigest([]);
      });
    return () => {
      cancelled = true;
    };
  }, [digestReady, digestRange.start, digestRange.end]);

  async function ack(id: string) {
    setBusy(true);
    try {
      await api(`/v1/exceptions/${id}/ack`, { method: 'POST' });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // The acknowledge cell needs `ack` and the busy flag, so the register's
  // columns are built here; the digest's are static.
  const columns: ColumnDef<ExceptionRow>[] = [
    {
      id: 'when',
      label: 'When',
      className: 'nowrap',
      sortValue: (r) => r.createdAt,
      render: (r) => new Date(r.createdAt).toLocaleString(),
    },
    {
      id: 'type',
      label: 'Type',
      sortValue: (r) => TYPE_LABELS[r.type] ?? r.type,
      render: (r) => TYPE_LABELS[r.type] ?? r.type.replace(/_/g, ' '),
    },
    {
      id: 'who',
      label: 'Who',
      sortValue: (r) => r.actorEmail,
      render: (r) => r.actorEmail ?? 'system',
    },
    {
      id: 'order',
      label: 'Order',
      className: 'nowrap',
      sortValue: (r) => r.orderNumber,
      render: (r) =>
        r.orderId && r.orderNumber ? (
          <Link href={`/orders/${r.orderId}`} data-testid="exception-order">
            {r.orderNumber}
          </Link>
        ) : (
          '—'
        ),
    },
    { id: 'what', label: 'What', sortValue: (r) => r.summary, render: (r) => r.summary },
    {
      id: 'severity',
      label: 'Severity',
      sortValue: (r) => r.severity,
      render: (r) => <StatusBadge status={r.severity} />,
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) =>
        r.acknowledgedAt ? (
          <span className="muted">ack&apos;d by {r.acknowledgedByEmail ?? '—'}</span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            data-testid="ack-exception"
            onClick={() => void ack(r.id)}
          >
            Acknowledge
          </Button>
        ),
    },
  ];
  const cols = useListColumns('exceptions-register', columns, rows);
  const digestCols = useListColumns('exceptions-digest', DIGEST_COLUMNS, digest);

  return (
    <div>
      <PageHeader
        title="Exception register"
        sub="Overrides, unlocks, over-capacity bookings, write-offs. Acknowledge what you've seen."
      />

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="min-w-0">
            <Toolbar>
              <Select
                aria-label="Acknowledgement"
                value={openOnly ? '1' : ''}
                onChange={(e) => setOpenOnly(e.target.value === '1')}
              >
                <option value="1">Unacknowledged</option>
                <option value="">All</option>
              </Select>
              <Select
                aria-label="Severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
              >
                <option value="">Any severity</option>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </Select>
            </Toolbar>

            {!rows && !error && <LoadingRows rows={4} />}
            {rows && rows.length === 0 && (
              <EmptyState title="Nothing waiting. Good.">
                {openOnly || severity
                  ? 'No exceptions match these filters.'
                  : 'No exceptions have been logged yet.'}
              </EmptyState>
            )}
            {rows && rows.length > 0 && (
              <Card flush>
                <TableWrap>
                  <table className="table" data-testid="exceptions-table">
                    <thead>
                      <ColumnHeadRow list={cols} testIdPrefix="exceptions" />
                    </thead>
                    <tbody>
                      {cols.sorted.map((r) => (
                        <tr key={r.id} data-testid="exception-row">
                          <ColumnCells list={cols} row={r} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ResetColumns list={cols} />
                </TableWrap>
                <LoadMore state={list} noun="exceptions" />
              </Card>
            )}
          </div>

          <div className="min-w-0">
            <Card
              title="By associate (ranked)"
              description={windowTitle(digestRange)}
              actions={
                <DateRangePicker
                  compact
                  align="right"
                  value={digestRange}
                  onChange={setDigestRange}
                  testid="digest-range"
                />
              }
            >
              {!digest && <LoadingRows rows={3} />}
              {digest && digest.length === 0 && (
                <p className="muted">No exceptions in this window.</p>
              )}
              {digest && digest.length > 0 && (
                <TableWrap>
                  <table className="table" data-testid="exceptions-digest">
                    <thead>
                      <ColumnHeadRow list={digestCols} testIdPrefix="exceptions-digest" />
                    </thead>
                    <tbody>
                      {digestCols.sorted.map((d) => (
                        <tr key={d.actorUserId ?? 'system'}>
                          <ColumnCells list={digestCols} row={d} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ResetColumns list={digestCols} />
                </TableWrap>
              )}
            </Card>
          </div>
        </div>
      </Stack>
    </div>
  );
}
