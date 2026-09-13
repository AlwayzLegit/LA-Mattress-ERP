'use client';

import { Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { formatMoney } from '@jetnine/shared';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  StatGrid,
  StatTile,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';
import { Money } from '@/components/money';

interface ReportRow {
  membershipId: string;
  salesperson: string;
  totalCents: number;
  pendingCents: number;
  entries: number;
}
interface Report {
  period: string;
  bySalesperson: ReportRow[];
}
interface StatementEntry {
  id: string;
  documentNumber: string | null;
  basisCents: number;
  amountCents: number;
  rateBps: number;
  status: string;
  accruedAt: string;
  notes: string | null;
}
interface Statement {
  period: string;
  membershipId: string;
  salesperson: string;
  entries: StatementEntry[];
  totals: {
    accruedCents: number;
    reversalCents: number;
    netCents: number;
    pendingCents: number;
    approvedCents: number;
    paidCents: number;
  };
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

const STATEMENT_COLUMNS: ColumnDef<StatementEntry>[] = [
  {
    id: 'date',
    label: 'Date',
    sortValue: (e) => e.accruedAt,
    render: (e) => new Date(e.accruedAt).toLocaleDateString(),
  },
  {
    id: 'document',
    label: 'Document',
    sortValue: (e) => e.documentNumber,
    render: (e) => (
      <>
        <code>{e.documentNumber ?? '—'}</code>
        {e.notes && <div className="muted">{e.notes}</div>}
      </>
    ),
  },
  {
    id: 'basis',
    label: 'Basis',
    num: true,
    sortValue: (e) => e.basisCents,
    render: (e) => <Money cents={e.basisCents} />,
  },
  {
    id: 'rate',
    label: 'Rate',
    num: true,
    sortValue: (e) => e.rateBps,
    render: (e) => `${(e.rateBps / 100).toFixed(2)}%`,
  },
  {
    id: 'commission',
    label: 'Commission',
    num: true,
    sortValue: (e) => e.amountCents,
    render: (e) => (
      <strong style={{ color: e.amountCents < 0 ? 'var(--danger)' : undefined }}>
        {formatMoney(e.amountCents)}
      </strong>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (e) => e.status,
    render: (e) => <StatusBadge status={e.status} />,
  },
];

/**
 * The payroll view: monthly totals per associate, and a per-associate
 * statement that prints as the payroll-day paper trail. Approve/paid
 * actions require commissions.manage (buttons fail with a toast for
 * roles without it).
 */
export default function CommissionsPage() {
  const [period, setPeriod] = useState(currentPeriod());
  const [report, setReport] = useState<Report | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Built inline: the Statement button needs `openStatement`.
  const accrualColumns: ColumnDef<ReportRow>[] = [
    {
      id: 'associate',
      label: 'Associate',
      sortValue: (r) => r.salesperson,
      render: (r) => r.salesperson,
    },
    {
      id: 'entries',
      label: 'Entries',
      num: true,
      sortValue: (r) => r.entries,
      render: (r) => r.entries,
    },
    {
      id: 'pending',
      label: 'Pending',
      num: true,
      sortValue: (r) => r.pendingCents,
      render: (r) => <Money cents={r.pendingCents} />,
    },
    {
      id: 'total',
      label: 'Total',
      num: true,
      sortValue: (r) => r.totalCents,
      render: (r) => (
        <strong>
          <Money cents={r.totalCents} />
        </strong>
      ),
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => (
        <Button
          size="sm"
          onClick={() => void openStatement(r.membershipId)}
          data-testid={`statement-${r.salesperson}`}
        >
          Statement
        </Button>
      ),
    },
  ];
  const accrualCols = useListColumns(
    'commissions-accruals',
    accrualColumns,
    report?.bySalesperson ?? null,
  );
  const statementCols = useListColumns(
    'commissions-statement',
    STATEMENT_COLUMNS,
    statement?.entries ?? null,
  );

  async function load(p: string) {
    setStatement(null);
    setLoading(true);
    try {
      setReport(await api<Report>(`/v1/commissions/report?period=${p}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openStatement(membershipId: string) {
    try {
      setStatement(
        await api<Statement>(
          `/v1/commissions/statement?period=${period}&membershipId=${membershipId}`,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function setStatus(status: 'approved' | 'paid') {
    if (!statement) return;
    const from = status === 'approved' ? 'pending' : 'approved';
    const ids = statement.entries.filter((e) => e.status === from).map((e) => e.id);
    if (ids.length === 0) {
      toast.info(`Nothing ${from} to mark ${status}.`);
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ updated: number }>('/v1/commissions/entries/set-status', {
        method: 'POST',
        body: JSON.stringify({ entryIds: ids, status }),
      });
      toast.success(`${res.updated} entr${res.updated === 1 ? 'y' : 'ies'} marked ${status}`);
      await openStatement(statement.membershipId);
      await load(period);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Commissions"
        sub="Monthly accruals per associate. Open a statement for the payroll-day paper trail."
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        <Card title="By associate" className="no-print">
          <Toolbar className="items-end">
            <Field label="Payroll month">
              <Input
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                data-testid="commission-period"
              />
            </Field>
            <Button
              size="sm"
              variant="primary"
              disabled={loading}
              onClick={() => void load(period)}
            >
              {loading ? 'Loading…' : 'Load'}
            </Button>
          </Toolbar>
          {report == null ? (
            <LoadingRows />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={accrualCols} testIdPrefix="commissions-accruals" />
                </thead>
                <tbody>
                  {report.bySalesperson.length === 0 && (
                    <TableEmpty colSpan={accrualCols.ordered.length}>
                      No commission entries for {period}.
                    </TableEmpty>
                  )}
                  {accrualCols.sorted.map((r) => (
                    <tr key={r.membershipId}>
                      <ColumnCells list={accrualCols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={accrualCols} />
            </TableWrap>
          )}
        </Card>

        {statement && (
          <Card
            title={`Statement — ${statement.salesperson} · ${statement.period}`}
            actions={
              <div className="no-print contents">
                <Button size="sm" disabled={busy} onClick={() => void setStatus('approved')}>
                  Approve pending
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void setStatus('paid')}>
                  Mark approved paid
                </Button>
                <Button size="sm" variant="secondary" onClick={() => window.print()}>
                  <Printer size={13} aria-hidden /> Print
                </Button>
              </div>
            }
            data-testid="commission-statement"
          >
            <Stack>
              <StatGrid cols={6}>
                <StatTile label="Accrued" value={formatMoney(statement.totals.accruedCents)} />
                <StatTile
                  label="Reversals"
                  value={formatMoney(statement.totals.reversalCents)}
                  tone={statement.totals.reversalCents !== 0 ? 'danger' : undefined}
                />
                <StatTile label="Net" value={formatMoney(statement.totals.netCents)} tone="brand" />
                <StatTile label="Pending" value={formatMoney(statement.totals.pendingCents)} />
                <StatTile label="Approved" value={formatMoney(statement.totals.approvedCents)} />
                <StatTile label="Paid" value={formatMoney(statement.totals.paidCents)} />
              </StatGrid>
              <TableWrap>
                <table className="table">
                  <thead>
                    <ColumnHeadRow list={statementCols} testIdPrefix="commissions-statement" />
                  </thead>
                  <tbody>
                    {statement.entries.length === 0 && (
                      <TableEmpty colSpan={statementCols.ordered.length}>
                        No entries this period.
                      </TableEmpty>
                    )}
                    {statementCols.sorted.map((e) => (
                      <tr key={e.id}>
                        <ColumnCells list={statementCols} row={e} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={statementCols} />
              </TableWrap>
            </Stack>
          </Card>
        )}

        <CommissionPlansCard />
      </Stack>
    </div>
  );
}

/**
 * Commission plans + who is on them.
 *
 * The API has had plan CRUD and assignment since G5, but nothing in the
 * app ever exposed it — so no member had a plan, `planFor()` returned
 * null for everyone, and commissions silently never accrued at all
 * ("No commission entries", QA 2026-08-26 D7). Accrual works; it just
 * had no way to be switched on.
 */
interface Plan {
  id: string;
  name: string;
  basis: string;
  rateBps: number;
}

const PLAN_COLUMNS: ColumnDef<Plan>[] = [
  {
    id: 'plan',
    label: 'Plan',
    sortValue: (p) => p.name,
    render: (p) => p.name,
  },
  {
    id: 'basis',
    label: 'Basis',
    sortValue: (p) => p.basis,
    render: (p) => (p.basis === 'percent_of_margin' ? 'of margin' : 'of sale'),
  },
  {
    id: 'rate',
    label: 'Rate',
    num: true,
    sortValue: (p) => p.rateBps,
    render: (p) => `${(p.rateBps / 100).toFixed(2)}%`,
  },
];

function CommissionPlansCard() {
  interface Member {
    membershipId: string;
    email: string;
    name: string | null;
    commissionPlanId?: string | null;
  }
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [basis, setBasis] = useState('percent_of_sale');
  const [busy, setBusy] = useState(false);
  const planCols = useListColumns('commissions-plans', PLAN_COLUMNS, plans);

  async function load() {
    try {
      setPlans(await api<Plan[]>('/v1/commission-plans'));
    } catch {
      setPlans([]);
    }
    try {
      setMembers(await api<Member[]>('/v1/business/members'));
    } catch {
      setMembers([]);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function createPlan() {
    const pct = Number(rate);
    if (!name.trim() || !Number.isFinite(pct) || pct <= 0) {
      toast.error('Name and a rate above 0 are required.');
      return;
    }
    setBusy(true);
    try {
      await api('/v1/commission-plans', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), basis, rateBps: Math.round(pct * 100) }),
      });
      setName('');
      setRate('');
      toast.success('Plan created. Assign it to a salesperson to start accruing.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function assign(membershipId: string, planId: string) {
    setBusy(true);
    try {
      await api('/v1/commission-plans/assign', {
        method: 'POST',
        body: JSON.stringify({ membershipId, planId: planId || null }),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card
        title="Commission plans"
        description="Commission accrues at completion only for salespeople who are on a plan. Nobody on a plan means nothing accrues."
        className="no-print"
      >
        {plans === null ? (
          <LoadingRows rows={2} />
        ) : plans.length === 0 ? (
          <EmptyState>No plans yet — create one below.</EmptyState>
        ) : (
          <TableWrap>
            <table className="table" data-testid="commission-plans-table">
              <thead>
                <ColumnHeadRow list={planCols} testIdPrefix="commissions-plans" />
              </thead>
              <tbody>
                {planCols.sorted.map((p) => (
                  <tr key={p.id}>
                    <ColumnCells list={planCols} row={p} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={planCols} />
          </TableWrap>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createPlan();
          }}
        >
          <FormGrid cols={3}>
            <Field label="Plan name" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Flat 5%"
                data-testid="plan-name"
              />
            </Field>
            <Field label="Rate (%)" required>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                data-testid="plan-rate"
              />
            </Field>
            <Field label="Basis">
              <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="percent_of_sale">Percent of sale</option>
                <option value="percent_of_margin">Percent of margin</option>
              </Select>
            </Field>
          </FormGrid>
          <FormActions>
            <Button type="submit" variant="secondary" disabled={busy} data-testid="create-plan">
              {busy ? 'Adding…' : 'Add plan'}
            </Button>
          </FormActions>
        </form>
      </Card>

      {members.length > 0 && (plans?.length ?? 0) > 0 && (
        <Card
          title="Who is on a plan"
          description="Pick a plan per salesperson; leave blank for anyone not on commission."
          className="no-print"
        >
          <TableWrap>
            <table className="table" data-testid="plan-assignments">
              <thead>
                <tr>
                  <th>Salesperson</th>
                  <th>Plan</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.membershipId}>
                    <td>{m.name ?? m.email}</td>
                    <td>
                      <Select
                        aria-label={`Plan for ${m.name ?? m.email}`}
                        value={m.commissionPlanId ?? ''}
                        disabled={busy}
                        onChange={(e) => void assign(m.membershipId, e.target.value)}
                      >
                        <option value="">Not on commission</option>
                        {plans!.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </>
  );
}
