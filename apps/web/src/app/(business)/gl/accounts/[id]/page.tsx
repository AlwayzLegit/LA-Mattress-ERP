'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  TableEmpty,
  TableWrap,
  rowKeys,
  useListColumns,
} from '@/components/ui';

/**
 * F277-lean account drill-down: per-period totals for the year, then
 * the posted lines behind them with the batch each line came from.
 */

interface PeriodRow {
  period: number;
  debitCents: number;
  creditCents: number;
}
interface JournalLine {
  batchId: string;
  batchNumber: string;
  batchType: string;
  sourceType: string | null;
  businessDate: string;
  period: number;
  memo: string | null;
  debitCents: number;
  creditCents: number;
}
interface Activity {
  account: { id: string; code: string; name: string; accountType: string };
  fiscalYear: number;
  byPeriod: PeriodRow[];
  lines: JournalLine[];
}

const PERIOD_COLUMNS: ColumnDef<PeriodRow>[] = [
  {
    id: 'period',
    label: 'Period',
    sortValue: (p) => p.period,
    render: (p) => (p.period === 13 ? 'Year-end' : p.period),
  },
  {
    id: 'debits',
    label: 'Debits',
    num: true,
    sortValue: (p) => p.debitCents,
    render: (p) => <Money cents={p.debitCents} />,
  },
  {
    id: 'credits',
    label: 'Credits',
    num: true,
    sortValue: (p) => p.creditCents,
    render: (p) => <Money cents={p.creditCents} />,
  },
  {
    id: 'net',
    label: 'Net',
    num: true,
    sortValue: (p) => p.debitCents - p.creditCents,
    render: (p) => <Money cents={p.debitCents - p.creditCents} />,
  },
];

const JOURNAL_COLUMNS: ColumnDef<JournalLine>[] = [
  {
    id: 'date',
    label: 'Date',
    className: 'nowrap',
    sortValue: (l) => l.businessDate,
    render: (l) => l.businessDate,
  },
  {
    id: 'batch',
    label: 'Batch',
    sortValue: (l) => l.batchNumber,
    render: (l) => <code>{l.batchNumber}</code>,
  },
  {
    id: 'type',
    label: 'Type',
    sortValue: (l) => l.sourceType ?? l.batchType,
    render: (l) => l.sourceType ?? l.batchType,
  },
  { id: 'memo', label: 'Memo', sortValue: (l) => l.memo, render: (l) => l.memo ?? '—' },
  {
    id: 'debit',
    label: 'Debit',
    num: true,
    sortValue: (l) => l.debitCents,
    render: (l) => (l.debitCents > 0 ? <Money cents={l.debitCents} /> : '—'),
  },
  {
    id: 'credit',
    label: 'Credit',
    num: true,
    sortValue: (l) => l.creditCents,
    render: (l) => (l.creditCents > 0 ? <Money cents={l.creditCents} /> : '—'),
  },
];

export default function GlAccountActivityPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [periodFilter, setPeriodFilter] = useState<number | null>(null);
  const lines = useMemo(
    () =>
      data
        ? periodFilter
          ? data.lines.filter((l) => l.period === periodFilter)
          : data.lines
        : null,
    [data, periodFilter],
  );
  const periodCols = useListColumns('gl-account-periods', PERIOD_COLUMNS, data?.byPeriod ?? null);
  const lineCols = useListColumns('gl-account-journal', JOURNAL_COLUMNS, lines);

  useEffect(() => {
    if (!id) return;
    api<Activity>(`/v1/gl/accounts/${id}/activity?year=${year}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id, year]);

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Account" eyebrow={<BackLink href="/gl">General ledger</BackLink>} />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!data || !lines) return <LoadingRows rows={6} />;

  const yearOptions = [year - 1, year, year + 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/gl">General ledger</BackLink>}
        title={
          <>
            <code>{data.account.code}</code> {data.account.name}
          </>
        }
        sub={`${data.account.accountType} · fiscal ${data.fiscalYear}`}
        actions={
          <Select
            aria-label="Fiscal year"
            value={String(year)}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        }
      />

      <Stack>
        <Card
          title="By period"
          description="Click a period to filter the posted lines below."
          flush
        >
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={periodCols} testIdPrefix="gl-account-periods" />
              </thead>
              <tbody>
                {data.byPeriod.length === 0 && (
                  <TableEmpty colSpan={periodCols.ordered.length}>
                    No posted activity in {data.fiscalYear}.
                  </TableEmpty>
                )}
                {periodCols.sorted.map((p) => {
                  const selected = periodFilter === p.period;
                  return (
                    <tr
                      {...rowKeys}
                      key={p.period}
                      className="cursor-pointer"
                      aria-selected={selected}
                      style={selected ? { background: 'var(--bg-secondary)' } : undefined}
                      onClick={() => setPeriodFilter(selected ? null : p.period)}
                    >
                      <ColumnCells list={periodCols} row={p} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ResetColumns list={periodCols} />
          </TableWrap>
        </Card>

        <Card
          title={`Posted lines${periodFilter ? ` — period ${periodFilter}` : ''} (${lines.length})`}
          actions={
            periodFilter ? (
              <Button size="sm" variant="ghost" onClick={() => setPeriodFilter(null)}>
                Show all periods
              </Button>
            ) : undefined
          }
          flush
        >
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={lineCols} testIdPrefix="gl-account-journal" />
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <TableEmpty colSpan={lineCols.ordered.length}>
                    {periodFilter
                      ? `No posted lines in period ${periodFilter}.`
                      : `No posted lines in ${data.fiscalYear}.`}
                  </TableEmpty>
                )}
                {lineCols.sorted.map((l, i) => (
                  <tr key={`${l.batchId}-${i}`}>
                    <ColumnCells list={lineCols} row={l} index={i} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={lineCols} />
          </TableWrap>
        </Card>
      </Stack>
    </div>
  );
}
