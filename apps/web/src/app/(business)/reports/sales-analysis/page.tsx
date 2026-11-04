'use client';

import Link from 'next/link';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import { Money } from '@/components/money';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  StatGrid,
  StatTile,
  TableWrap,
  Toolbar,
} from '@/components/ui';

/**
 * Sales Analysis (STORIS "Run Sales Analysis Report", owner 2026-11-04):
 * every salesperson's written, delivered and returned dollars for the
 * range, the open pipeline still to deliver, and how far each one is
 * from their monthly bonus goal.
 */

type Basis = 'delivered' | 'written';

interface Row {
  membershipId: string | null;
  name: string;
  code: string;
  roleName: string | null;
  status: string | null;
  writtenCents: number;
  writtenCount: number;
  deliveredCents: number;
  deliveredCount: number;
  returnedCents: number;
  returnedCount: number;
  netDeliveredCents: number;
  openCents: number;
  openCount: number;
  goalCents: number | null;
  toGoalCents: number | null;
  pctOfGoal: number | null;
}

interface Report {
  generatedAt: string;
  range: { start: string; end: string };
  basis: Basis;
  timezone: string;
  locationId: string | null;
  goalsApply: boolean;
  rows: Row[];
  totals: Omit<
    Row,
    | 'membershipId'
    | 'name'
    | 'code'
    | 'roleName'
    | 'status'
    | 'goalCents'
    | 'toGoalCents'
    | 'pctOfGoal'
  > & { goalCents: number };
}

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}

function fmtDate(d: string): string {
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

/** The goal bar: filled to the percentage, green once the goal is met. */
function GoalBar({ pct }: { pct: number }) {
  const width = Math.min(100, Math.max(0, pct));
  const met = pct >= 100;
  return (
    <div
      className="goal-bar"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      title={`${pct.toFixed(1)}% of goal`}
      style={{
        height: 8,
        borderRadius: 4,
        background: 'var(--surface-muted, #e5e7eb)',
        overflow: 'hidden',
        minWidth: 90,
      }}
    >
      <div
        style={{
          width: `${width}%`,
          height: '100%',
          background: met ? 'var(--success, #16a34a)' : 'var(--accent, #2563eb)',
        }}
      />
    </div>
  );
}

export default function SalesAnalysisPage() {
  const [range, setRange, rangeReady] = useUrlDateRange('mtd');
  const [basis, setBasis] = useState<Basis>('delivered');
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Location[]>('/v1/business/locations')
      .then((rows) => setLocations(rows.filter((l) => l.isActive)))
      .catch(() => setLocations([]));
  }, []);

  function query(): string {
    const p = new URLSearchParams({ start: range.start, end: range.end, basis });
    if (locationId) p.set('locationId', locationId);
    return p.toString();
  }

  useEffect(() => {
    if (!rangeReady) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    api<Report>(`/v1/reports/sales-analysis?${query()}`)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeReady, range.start, range.end, basis, locationId]);

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFile(
        `/v1/reports/sales-analysis?${query()}&format=csv`,
        `sales-analysis-${basis}-${range.start}-to-${range.end}.csv`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  const basisLabel = basis === 'delivered' ? 'net delivered' : 'written';
  const t = report?.totals;
  const basisTotal = t ? (basis === 'delivered' ? t.netDeliveredCents : t.writtenCents) : 0;
  const measured = report?.rows.filter((r) => r.pctOfGoal != null) ?? [];
  const metGoal = measured.filter((r) => (r.pctOfGoal ?? 0) >= 100).length;

  return (
    <div data-testid="sales-analysis">
      <p style={{ margin: '0 0 12px' }}>
        <Link href="/reports">← Reports</Link>
      </p>
      <PageHeader
        title="Run Sales Analysis Report"
        sub="Each salesperson's written, delivered and returned dollars for the range, what is still open to deliver, and how close they are to their monthly bonus goal."
        actions={
          <Button
            variant="secondary"
            onClick={() => void exportCsv()}
            disabled={exporting || !report}
            data-testid="sa-export"
          >
            <Download size={14} />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        }
      />

      <Stack>
        <Card>
          <Toolbar className="items-end">
            <Field label="Dates" as="div">
              <DateRangePicker value={range} onChange={setRange} compact testid="sa-range" />
            </Field>
            <Field label="Bonus measured on">
              <Select
                value={basis}
                onChange={(e) => setBasis(e.target.value as Basis)}
                data-testid="sa-basis"
              >
                <option value="delivered">Delivered (net of returns)</option>
                <option value="written">Written</option>
              </Select>
            </Field>
            <Field label="Store">
              <Select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                data-testid="sa-location"
              >
                <option value="">All stores</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          </Toolbar>
        </Card>

        {error && <Alert tone="error">{error}</Alert>}

        {report && !report.goalsApply && (
          <Alert tone="info" data-testid="sa-goals-note">
            Goals are monthly. Pick a range inside one calendar month to see each salesperson&apos;s
            progress toward their goal.
          </Alert>
        )}

        {report && t && (
          <StatGrid>
            <StatTile
              label={`Written · ${fmtDate(report.range.start)}${
                report.range.end !== report.range.start ? ` – ${fmtDate(report.range.end)}` : ''
              }`}
              value={<Money cents={t.writtenCents} />}
              sub={`${t.writtenCount} document${t.writtenCount === 1 ? '' : 's'}`}
            />
            <StatTile
              label="Delivered, net of returns"
              value={<Money cents={t.netDeliveredCents} />}
              sub={
                t.returnedCents > 0 ? (
                  <>
                    <Money cents={t.deliveredCents} /> delivered − <Money cents={t.returnedCents} />{' '}
                    returned
                  </>
                ) : (
                  `${t.deliveredCount} delivered`
                )
              }
            />
            <StatTile
              label="Open, still to deliver"
              value={<Money cents={t.openCents} />}
              sub={`${t.openCount} open order${t.openCount === 1 ? '' : 's'}`}
            />
            <StatTile
              label={report.goalsApply ? 'Goals met' : 'Goals set'}
              value={
                report.goalsApply
                  ? `${metGoal} of ${measured.length}`
                  : `${report.rows.filter((r) => r.goalCents != null).length}`
              }
              sub={
                t.goalCents > 0 && report.goalsApply ? (
                  <>
                    <Money cents={basisTotal} /> {basisLabel} of <Money cents={t.goalCents} /> in
                    goals
                  </>
                ) : (
                  'Set goals on each salesperson’s member page'
                )
              }
            />
          </StatGrid>
        )}

        <Card
          title="By salesperson"
          description={`Sorted by ${basisLabel} dollars. Goal progress is measured on ${basisLabel} dollars; set the goal on each member's page.`}
          flush
        >
          {busy && !report ? (
            <div style={{ padding: 16 }}>
              <LoadingRows rows={5} />
            </div>
          ) : !report || report.rows.length === 0 ? (
            <EmptyState title="Nothing written, delivered or returned in this range">
              Orders completed in the range count as delivered on their completion date.
            </EmptyState>
          ) : (
            <TableWrap>
              <table className="table" data-testid="sa-table">
                <thead>
                  <tr>
                    <th>Salesperson</th>
                    <th className="num">Written</th>
                    <th className="num">Delivered</th>
                    <th className="num">Returned</th>
                    <th className="num">Net delivered</th>
                    <th className="num">Open</th>
                    <th className="num">Goal</th>
                    <th className="num">To go</th>
                    <th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.membershipId ?? 'unassigned'} data-testid="sa-row">
                      <td>
                        {r.membershipId ? (
                          <Link href={`/salespeople/${r.membershipId}/activity`}>
                            <strong>{r.name}</strong>
                          </Link>
                        ) : (
                          <strong className="muted">{r.name}</strong>
                        )}
                        <div className="muted text-xs">
                          {[r.code !== '—' ? r.code : null, r.roleName].filter(Boolean).join(' · ')}
                          {r.status && r.status !== 'active' ? ` · ${r.status}` : ''}
                        </div>
                      </td>
                      <td className="num">
                        <Money cents={r.writtenCents} />
                        <div className="muted text-xs">{r.writtenCount}</div>
                      </td>
                      <td className="num">
                        <Money cents={r.deliveredCents} />
                        <div className="muted text-xs">{r.deliveredCount}</div>
                      </td>
                      <td className="num">
                        {r.returnedCents > 0 ? (
                          <>
                            −<Money cents={r.returnedCents} />
                            <div className="muted text-xs">{r.returnedCount}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        <strong>
                          <Money cents={r.netDeliveredCents} />
                        </strong>
                      </td>
                      <td className="num">
                        <Money cents={r.openCents} />
                        <div className="muted text-xs">{r.openCount}</div>
                      </td>
                      <td className="num">
                        {r.goalCents != null ? (
                          <Money cents={r.goalCents} />
                        ) : r.membershipId ? (
                          <Link href={`/members/${r.membershipId}`} className="muted text-xs">
                            Set goal
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        {r.toGoalCents == null ? (
                          <span className="muted">—</span>
                        ) : r.toGoalCents === 0 ? (
                          <strong style={{ color: 'var(--success, #16a34a)' }}>Met</strong>
                        ) : (
                          <Money cents={r.toGoalCents} />
                        )}
                      </td>
                      <td>
                        {r.pctOfGoal == null ? (
                          <span className="muted">—</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <GoalBar pct={r.pctOfGoal} />
                            <span className="text-xs" style={{ minWidth: 44 }}>
                              {r.pctOfGoal.toFixed(0)}%
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {t && (
                  <tfoot>
                    <tr data-testid="sa-totals">
                      <td>
                        <strong>Total</strong>
                      </td>
                      <td className="num">
                        <strong>
                          <Money cents={t.writtenCents} />
                        </strong>
                      </td>
                      <td className="num">
                        <strong>
                          <Money cents={t.deliveredCents} />
                        </strong>
                      </td>
                      <td className="num">
                        {t.returnedCents > 0 ? (
                          <strong>
                            −<Money cents={t.returnedCents} />
                          </strong>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        <strong>
                          <Money cents={t.netDeliveredCents} />
                        </strong>
                      </td>
                      <td className="num">
                        <strong>
                          <Money cents={t.openCents} />
                        </strong>
                      </td>
                      <td className="num">
                        {t.goalCents > 0 ? (
                          <strong>
                            <Money cents={t.goalCents} />
                          </strong>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        {report.goalsApply && t.goalCents > 0 ? (
                          <strong>
                            <Money cents={Math.max(0, t.goalCents - basisTotal)} />
                          </strong>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {report.goalsApply && t.goalCents > 0 ? (
                          <div className="flex items-center gap-2">
                            <GoalBar pct={(basisTotal / t.goalCents) * 100} />
                            <span className="text-xs" style={{ minWidth: 44 }}>
                              {((basisTotal / t.goalCents) * 100).toFixed(0)}%
                            </span>
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </TableWrap>
          )}
        </Card>

        <p className="muted text-xs">
          Written counts orders on the day they were taken (plus register sales); delivered counts
          orders on the day they completed, less returns completed in the range; open is every order
          written and not yet delivered or cancelled, whatever its date. A split order credits each
          salesperson their share. Imported STORIS history is excluded. Days are cut on store time.
        </p>
      </Stack>
    </div>
  );
}
