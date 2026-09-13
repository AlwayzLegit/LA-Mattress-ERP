'use client';

import { toast } from 'sonner';
import { useEffect, useState } from 'react';
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
  Field,
  FormActions,
  FormGrid,
  Input,
  LoadingRows,
  PageHeader,
  ResetColumns,
  SectionHeading,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  useListColumns,
} from '@/components/ui';

interface Account {
  id: string;
  code: string;
  name: string;
}

interface BatchRow {
  id: string;
  number: string;
  status: string;
  batchType: string;
  businessDate: string;
  period: number;
  memo: string | null;
  debitCents: number;
  postedAt: string | null;
}

interface LineDraft {
  accountId: string;
  memo: string;
  amountStr: string;
  side: 'debit' | 'credit';
}

const emptyLine = (): LineDraft => ({ accountId: '', memo: '', amountStr: '', side: 'debit' });

export default function GlJournalPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [businessDate, setBusinessDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine()]);

  async function load() {
    try {
      setAccounts(await api<Account[]>('/v1/gl/accounts'));
      const res = await api<{ rows: BatchRow[] }>('/v1/gl/journal-batches');
      setRows(res.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const totals = lines.reduce(
    (t, l) => {
      const cents = Math.round(Number(l.amountStr || 0) * 100);
      if (!Number.isFinite(cents) || cents <= 0) return t;
      return l.side === 'debit'
        ? { ...t, debit: t.debit + cents }
        : { ...t, credit: t.credit + cents };
    },
    { debit: 0, credit: 0 },
  );
  const balanced = totals.debit === totals.credit;

  async function submit(post: boolean) {
    setBusy(true);
    try {
      const body = {
        businessDate,
        memo: memo || null,
        post,
        lines: lines
          .filter((l) => l.accountId && Number(l.amountStr) > 0)
          .map((l) => ({
            accountId: l.accountId,
            memo: l.memo || null,
            debitCents: l.side === 'debit' ? Math.round(Number(l.amountStr) * 100) : 0,
            creditCents: l.side === 'credit' ? Math.round(Number(l.amountStr) * 100) : 0,
          })),
      };
      await api('/v1/gl/journal-batches', { method: 'POST', body: JSON.stringify(body) });
      toast.success(post ? 'Batch posted' : 'Draft saved');
      setMemo('');
      setLines([emptyLine(), emptyLine()]);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function postDraft(id: string) {
    setBusy(true);
    try {
      await api(`/v1/gl/journal-batches/${id}/post`, { method: 'POST', body: '{}' });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => {
      const current = prev[i];
      if (!current) return prev;
      const next = [...prev];
      next[i] = { ...current, ...patch };
      return next;
    });
  }

  // The Post cell needs `busy` and `postDraft`.
  const batchColumns: ColumnDef<BatchRow>[] = [
    {
      id: 'number',
      label: 'Batch',
      sortValue: (b) => b.number,
      render: (b) => <code>{b.number}</code>,
    },
    {
      id: 'date',
      label: 'Date',
      className: 'nowrap',
      sortValue: (b) => b.businessDate,
      render: (b) => b.businessDate,
    },
    { id: 'type', label: 'Type', sortValue: (b) => b.batchType, render: (b) => b.batchType },
    { id: 'memo', label: 'Memo', sortValue: (b) => b.memo, render: (b) => b.memo ?? '—' },
    {
      id: 'amount',
      label: 'Amount',
      num: true,
      sortValue: (b) => b.debitCents,
      render: (b) => <Money cents={b.debitCents} />,
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (b) => b.status,
      render: (b) => <StatusBadge status={b.status} />,
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (b) =>
        b.status === 'draft' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void postDraft(b.id)}>
            Post
          </Button>
        ),
    },
  ];
  const cols = useListColumns('gl-journal', batchColumns, rows);

  if (error && !rows) {
    return (
      <div>
        <PageHeader
          title="Journal entries"
          eyebrow={<BackLink href="/gl">General ledger</BackLink>}
        />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!rows) return <LoadingRows rows={6} />;

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/gl">General ledger</BackLink>}
        title="Journal entries"
        sub="Posted batches are append-only"
      />

      <Stack>
        <Card title="New journal entry">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || !balanced || totals.debit === 0) return;
              void submit(true);
            }}
          >
            <FormGrid cols={2}>
              <Field label="Date">
                <Input
                  type="date"
                  value={businessDate}
                  onChange={(e) => setBusinessDate(e.target.value)}
                />
              </Field>
              <Field label="Memo">
                <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
              </Field>
            </FormGrid>

            <SectionHeading as="h3" title="Lines" />
            <Stack gap="sm">
              {lines.map((l, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-4">
                  <Select
                    aria-label={`Line ${i + 1} account`}
                    value={l.accountId}
                    onChange={(e) => updateLine(i, { accountId: e.target.value })}
                  >
                    <option value="">Account…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={`Line ${i + 1} side`}
                    value={l.side}
                    onChange={(e) => updateLine(i, { side: e.target.value as 'debit' | 'credit' })}
                  >
                    <option value="debit">Debit</option>
                    <option value="credit">Credit</option>
                  </Select>
                  <Input
                    aria-label={`Line ${i + 1} amount`}
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="$"
                    value={l.amountStr}
                    onChange={(e) => updateLine(i, { amountStr: e.target.value })}
                  />
                  <Input
                    aria-label={`Line ${i + 1} memo`}
                    placeholder="Line memo"
                    value={l.memo}
                    onChange={(e) => updateLine(i, { memo: e.target.value })}
                  />
                </div>
              ))}
              <div>
                <Button size="sm" variant="ghost" onClick={() => setLines([...lines, emptyLine()])}>
                  + Line
                </Button>
              </div>
            </Stack>

            <FormActions
              start={
                <span style={{ color: balanced ? 'var(--success)' : 'var(--warning)' }}>
                  Debits <Money cents={totals.debit} /> · Credits <Money cents={totals.credit} />
                  {!balanced && ' (out of balance)'}
                </span>
              }
            >
              <Button variant="secondary" disabled={busy} onClick={() => void submit(false)}>
                Save draft
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !balanced || totals.debit === 0}
              >
                Post
              </Button>
            </FormActions>
          </form>
        </Card>

        <Card title="Batches" flush>
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="gl-journal" />
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>No journal batches yet.</TableEmpty>
                )}
                {cols.sorted.map((b) => (
                  <tr key={b.id}>
                    <ColumnCells list={cols} row={b} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        </Card>
      </Stack>
    </div>
  );
}
