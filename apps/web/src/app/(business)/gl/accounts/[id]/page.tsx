'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  TableEmpty,
  TableWrap,
  rowKeys,
} from '@/components/ui';

/**
 * F277-lean account drill-down: per-period totals for the year, then
 * the posted lines behind them with the batch each line came from.
 */

interface Activity {
  account: { id: string; code: string; name: string; accountType: string };
  fiscalYear: number;
  byPeriod: { period: number; debitCents: number; creditCents: number }[];
  lines: {
    batchId: string;
    batchNumber: string;
    batchType: string;
    sourceType: string | null;
    businessDate: string;
    period: number;
    memo: string | null;
    debitCents: number;
    creditCents: number;
  }[];
}

export default function GlAccountActivityPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [periodFilter, setPeriodFilter] = useState<number | null>(null);

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
  if (!data) return <LoadingRows rows={6} />;

  const lines = periodFilter ? data.lines.filter((l) => l.period === periodFilter) : data.lines;
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
                <tr>
                  <th>Period</th>
                  <th className="num">Debits</th>
                  <th className="num">Credits</th>
                  <th className="num">Net</th>
                </tr>
              </thead>
              <tbody>
                {data.byPeriod.length === 0 && (
                  <TableEmpty colSpan={4}>No posted activity in {data.fiscalYear}.</TableEmpty>
                )}
                {data.byPeriod.map((p) => {
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
                      <td>{p.period === 13 ? 'Year-end' : p.period}</td>
                      <td className="num">
                        <Money cents={p.debitCents} />
                      </td>
                      <td className="num">
                        <Money cents={p.creditCents} />
                      </td>
                      <td className="num">
                        <Money cents={p.debitCents - p.creditCents} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
                <tr>
                  <th>Date</th>
                  <th>Batch</th>
                  <th>Type</th>
                  <th>Memo</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <TableEmpty colSpan={6}>
                    {periodFilter
                      ? `No posted lines in period ${periodFilter}.`
                      : `No posted lines in ${data.fiscalYear}.`}
                  </TableEmpty>
                )}
                {lines.map((l, i) => (
                  <tr key={`${l.batchId}-${i}`}>
                    <td className="nowrap">{l.businessDate}</td>
                    <td>
                      <code>{l.batchNumber}</code>
                    </td>
                    <td>{l.sourceType ?? l.batchType}</td>
                    <td>{l.memo ?? '—'}</td>
                    <td className="num">
                      {l.debitCents > 0 ? <Money cents={l.debitCents} /> : '—'}
                    </td>
                    <td className="num">
                      {l.creditCents > 0 ? <Money cents={l.creditCents} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </Stack>
    </div>
  );
}
