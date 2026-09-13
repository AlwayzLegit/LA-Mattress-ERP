'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  // The builder's own `ColumnDef` below is a report's output column.
  type ColumnDef as ListColumnDef,
  ColumnHeadRow,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  type ListColumns,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  TableEmpty,
  TableWrap,
  useListColumns,
} from '@/components/ui';

interface DictionaryMeta {
  name: string;
  columnHeading: string;
  width: number;
  type: string;
  kind: string;
  masked: boolean;
  selectable: boolean;
}
interface SourceMeta {
  id: string;
  name: string;
  description: string;
  dictionaries: DictionaryMeta[];
  relations: { sourceId: string; name: string }[];
}
interface ReportListRow {
  id: string;
  name: string;
  description: string | null;
  sourceId: string;
  access: string;
  systemOwned: boolean;
  canEdit: boolean;
}
interface ColumnDef {
  dictionary: string;
  width?: number | null;
  break?: boolean;
  total?: boolean;
}
interface PromptDef {
  dictionary: string;
  label: string;
  required?: boolean;
  promptType: 'simple' | 'range' | 'multi_select';
  dateCode?: boolean;
  includeExclude?: 'include' | 'exclude' | null;
}
interface FilterDef {
  dictionary: string;
  operator: string;
  value?: string | null;
}
interface RunResult {
  title: string | null;
  subTitle: string | null;
  runTimeInformation: string | null;
  columns: { name: string; heading: string; masked: boolean; type: string }[];
  rows: Record<string, string | number | boolean | null>[];
  groups: { key: string | number | null; totals: Record<string, number> }[];
  grandTotals: Record<string, number>;
  summaryOnly: boolean;
  truncated: boolean;
  warnings: string[];
}

interface ArchiveRow {
  id: string;
  reportName: string;
  runSource: string;
  rowCount: number;
  createdAt: string;
}
type ResultRow = RunResult['rows'][number];

const OPERATORS = ['EQ', 'NE', 'LT', 'GT', 'LE', 'GE', 'TR', 'FL'];

function fmt(v: string | number | boolean | null, type: string): string {
  if (v == null) return '';
  if (type === 'money' && typeof v === 'number') return (v / 100).toFixed(2);
  return String(v);
}
const isNumeric = (type: string) => type === 'money' || type === 'number';

const ARCHIVE_COLUMNS: ListColumnDef<ArchiveRow>[] = [
  {
    id: 'report',
    label: 'Report',
    sortValue: (a) => a.reportName,
    render: (a) => a.reportName,
  },
  {
    id: 'source',
    label: 'Source',
    sortValue: (a) => a.runSource,
    render: (a) => (a.runSource === 'eod' ? 'Scheduled' : 'On demand'),
  },
  { id: 'rows', label: 'Rows', num: true, sortValue: (a) => a.rowCount, render: (a) => a.rowCount },
  {
    id: 'archived',
    label: 'Archived',
    sortValue: (a) => a.createdAt,
    render: (a) => new Date(a.createdAt).toLocaleString(),
  },
  {
    id: 'actions',
    label: '',
    srLabel: 'Actions',
    className: 'actions',
    fixed: true,
    render: (a) => (
      <Button
        size="sm"
        onClick={() =>
          void downloadFile(
            `/v1/report-builder/archives/${a.id}?format=csv`,
            `${a.reportName.replace(/[^A-Za-z0-9_-]+/g, '-')}-archive.csv`,
          ).catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
        }
      >
        CSV
      </Button>
    ),
  },
];

/**
 * A totals row's cells in the header's order: the label spans the leading
 * columns that carry no total, each total sits under its own column and
 * the rest stay blank, so a moved column keeps its total under it.
 */
function TotalCells<Row>({
  list,
  label,
  totals,
}: {
  list: ListColumns<Row>;
  label: ReactNode;
  totals: Record<string, ReactNode>;
}) {
  const firstTotal = list.ordered.findIndex((c) => c.id in totals);
  const lead = firstTotal < 0 ? list.ordered.length : firstTotal;
  let placed = lead > 0;
  return (
    <>
      {lead > 0 && <td colSpan={lead}>{label}</td>}
      {list.ordered.slice(lead).map((c) => {
        if (c.id in totals) {
          return (
            <td key={c.id} className={c.num ? 'num' : undefined}>
              {totals[c.id]}
            </td>
          );
        }
        if (!placed) {
          placed = true;
          return <td key={c.id}>{label}</td>;
        }
        return <td key={c.id} />;
      })}
    </>
  );
}

/** The run result's totals for one row of groups / grand totals, keyed by column. */
function totalsFor(result: RunResult, totals: Record<string, number>): Record<string, ReactNode> {
  return Object.fromEntries(
    result.columns
      .filter((c) => c.name in totals)
      .map((c) => [c.name, fmt(totals[c.name] ?? null, c.type)]),
  );
}

export default function ReportBuilderPage() {
  const [sources, setSources] = useState<SourceMeta[] | null>(null);
  const [reports, setReports] = useState<ReportListRow[] | null>(null);
  const [archives, setArchives] = useState<ArchiveRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'edit' | 'run'>('list');

  // Editor state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [title, setTitle] = useState('');
  const [access, setAccess] = useState('anyone');
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [filters, setFilters] = useState<FilterDef[]>([]);
  const [sorts, setSorts] = useState<string[]>([]);
  const [prompts, setPrompts] = useState<PromptDef[]>([]);

  // Runner state
  const [runReport, setRunReport] = useState<ReportListRow | null>(null);
  const [runInfo, setRunInfo] = useState<{
    prompts: PromptDef[];
    summaryOnlyAvailable: boolean;
    runTimeInformation: string | null;
  } | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [summaryOnly, setSummaryOnly] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);

  const source = useMemo(
    () => sources?.find((s) => s.id === sourceId) ?? null,
    [sources, sourceId],
  );
  const selectableDicts = useMemo(
    () => source?.dictionaries.filter((d) => d.selectable) ?? [],
    [source],
  );

  async function load() {
    setError(null);
    try {
      const [s, r, a] = await Promise.all([
        api<{ sources: SourceMeta[] }>('/v1/report-builder/sources'),
        api<{ reports: ReportListRow[] }>('/v1/report-builder/reports'),
        api<{
          archives: {
            id: string;
            reportName: string;
            runSource: string;
            rowCount: number;
            createdAt: string;
          }[];
        }>('/v1/report-builder/archives'),
      ]);
      setSources(s.sources);
      setReports(r.reports);
      setArchives(a.archives);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function startNew() {
    setEditingId(null);
    setName('');
    setDescription('');
    setSourceId('');
    setTitle('');
    setAccess('anyone');
    setColumns([]);
    setFilters([]);
    setSorts([]);
    setPrompts([]);
    setMode('edit');
  }

  async function startEdit(r: ReportListRow) {
    try {
      const full = await api<{
        name: string;
        description: string | null;
        sourceId: string;
        title: string | null;
        access: string;
        definitionJson: {
          columns: ColumnDef[];
          filters: FilterDef[];
          sorts: { dictionary: string }[];
          prompts: PromptDef[];
        };
      }>(`/v1/report-builder/reports/${r.id}`);
      setEditingId(r.id);
      setName(full.name);
      setDescription(full.description ?? '');
      setSourceId(full.sourceId);
      setTitle(full.title ?? '');
      setAccess(full.access);
      setColumns(full.definitionJson.columns ?? []);
      setFilters(full.definitionJson.filters ?? []);
      setSorts((full.definitionJson.sorts ?? []).map((s) => s.dictionary));
      setPrompts(full.definitionJson.prompts ?? []);
      setMode('edit');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function save() {
    const body = {
      name,
      description: description || null,
      sourceId,
      title: title || null,
      access,
      columns,
      filters,
      sorts: sorts.map((dictionary) => ({ dictionary })),
      prompts,
    };
    try {
      const saved = editingId
        ? await api<{ warnings: string[] }>(`/v1/report-builder/reports/${editingId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await api<{ warnings: string[] }>('/v1/report-builder/reports', {
            method: 'POST',
            body: JSON.stringify(body),
          });
      for (const w of saved.warnings ?? []) toast.warning(w);
      toast.success('Report saved');
      setMode('list');
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function openRunner(r: ReportListRow) {
    try {
      const full = await api<{
        runTimeInformation: string | null;
        summaryOnlyAvailable: boolean;
        definitionJson: { prompts: PromptDef[] };
      }>(`/v1/report-builder/reports/${r.id}`);
      setRunReport(r);
      setRunInfo({
        prompts: full.definitionJson.prompts ?? [],
        summaryOnlyAvailable: full.summaryOnlyAvailable,
        runTimeInformation: full.runTimeInformation,
      });
      setAnswers({});
      setSummaryOnly(false);
      setResult(null);
      setMode('run');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function execute() {
    if (!runReport) return;
    setRunning(true);
    setResult(null);
    try {
      const body = {
        answers: Object.fromEntries(
          Object.entries(answers)
            .filter(([, v]) => v !== '')
            .map(([k, v]) => [k, v.includes(',') ? v.split(',').map((x) => x.trim()) : v]),
        ),
        summaryOnly,
      };
      const res = await api<RunResult>(`/v1/report-builder/reports/${runReport.id}/run`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(res);
      for (const w of res.warnings ?? []) toast.warning(w);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function archiveRun() {
    if (!runReport) return;
    setRunning(true);
    try {
      const body = {
        answers: Object.fromEntries(
          Object.entries(answers)
            .filter(([, v]) => v !== '')
            .map(([k, v]) => [k, v.includes(',') ? v.split(',').map((x) => x.trim()) : v]),
        ),
        format: 'archive',
      };
      const res = await api<{ archiveId: string; rowCount: number }>(
        `/v1/report-builder/reports/${runReport.id}/run`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      toast.success(`Archived ${res.rowCount} row(s)`);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function clone(r: ReportListRow) {
    const newName = window.prompt(`Clone "${r.name}" as:`);
    if (!newName) return;
    try {
      await api(`/v1/report-builder/reports/${r.id}/clone`, {
        method: 'POST',
        body: JSON.stringify({ name: newName }),
      });
      toast.success(`Cloned as ${newName}`);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const dictOptions = selectableDicts.map((d) => (
    <option key={d.name} value={d.name}>
      {d.name}
    </option>
  ));

  // Built inline: the actions cell needs the run / edit / clone callbacks.
  const reportColumns: ListColumnDef<ReportListRow>[] = [
    {
      id: 'name',
      label: 'Name',
      sortValue: (r) => r.name,
      render: (r) => (
        <>
          {r.name}
          {r.systemOwned ? <span className="muted"> · system</span> : null}
          {r.description ? <div className="muted">{r.description}</div> : null}
        </>
      ),
    },
    { id: 'source', label: 'Source', sortValue: (r) => r.sourceId, render: (r) => r.sourceId },
    { id: 'access', label: 'Access', sortValue: (r) => r.access, render: (r) => r.access },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => (
        <>
          <Button size="sm" variant="primary" onClick={() => void openRunner(r)}>
            Run
          </Button>
          {r.canEdit && !r.systemOwned ? (
            <Button size="sm" onClick={() => void startEdit(r)}>
              Edit
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void clone(r)}>
            Clone
          </Button>
        </>
      ),
    },
  ];
  const reportCols = useListColumns('reports-builder', reportColumns, reports);
  const archiveCols = useListColumns('reports-builder-archives', ARCHIVE_COLUMNS, archives);
  // The result's columns come from the report definition, so the saved
  // order is kept per report.
  const resultColumns = useMemo<ListColumnDef<ResultRow>[]>(
    () =>
      (result?.columns ?? []).map((c) => ({
        id: c.name,
        label: (
          <>
            {c.heading}
            {c.masked ? ' 🔒' : ''}
          </>
        ),
        num: isNumeric(c.type),
        sortValue: (r) => r[c.name] ?? null,
        render: (r) => fmt(r[c.name] ?? null, c.type),
      })),
    [result],
  );
  const resultCols = useListColumns(
    `reports-builder-result-${runReport?.id ?? 'none'}`,
    resultColumns,
    result?.rows ?? null,
  );

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/reports">Reports</BackLink>}
        title="Report builder"
        sub="Author reports over the live data — dictionaries, filters, prompts, breaks and totals"
        actions={
          mode === 'list' ? (
            <Button variant="primary" onClick={startNew}>
              New report
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setMode('list')}>
              Back to reports
            </Button>
          )
        }
      />
      <Stack>
        {error ? <Alert tone="error">{error}</Alert> : null}

        {mode === 'list' ? (
          reports === null ? (
            <LoadingRows />
          ) : reports.length === 0 ? (
            <EmptyState title="No reports yet">Build the first one with New report.</EmptyState>
          ) : (
            <Card title="Reports" flush>
              <TableWrap>
                <table className="table">
                  <thead>
                    <ColumnHeadRow list={reportCols} testIdPrefix="reports-builder" />
                  </thead>
                  <tbody>
                    {reportCols.sorted.map((r) => (
                      <tr key={r.id}>
                        <ColumnCells list={reportCols} row={r} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={reportCols} />
              </TableWrap>
            </Card>
          )
        ) : null}

        {mode === 'list' && archives.length > 0 ? (
          <Card title="Archived runs" flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={archiveCols} testIdPrefix="reports-builder-archives" />
                </thead>
                <tbody>
                  {archiveCols.sorted.map((a) => (
                    <tr key={a.id}>
                      <ColumnCells list={archiveCols} row={a} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={archiveCols} />
            </TableWrap>
          </Card>
        ) : null}

        {mode === 'edit' ? (
          <>
            <Card title="Headings">
              <FormGrid cols={3}>
                <Field label="Report name" required>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={Boolean(editingId)}
                  />
                </Field>
                <Field label="Description">
                  <Input value={description} onChange={(e) => setDescription(e.target.value)} />
                </Field>
                <Field label="Source" required>
                  <Select
                    value={sourceId}
                    disabled={Boolean(editingId) || columns.length > 0}
                    onChange={(e) => {
                      setSourceId(e.target.value);
                      setColumns([]);
                      setFilters([]);
                      setSorts([]);
                      setPrompts([]);
                    }}
                  >
                    <option value="">Select…</option>
                    {(sources ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Access">
                  <Select value={access} onChange={(e) => setAccess(e.target.value)}>
                    <option value="anyone">Anyone can run</option>
                    <option value="same_role">Within my role</option>
                    <option value="owner_only">Only me</option>
                  </Select>
                </Field>
                <Field label="Title" hint="Tokens: {PROMPT_DICT}" className="form-span">
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>
              </FormGrid>
            </Card>

            {source ? (
              <>
                <Card
                  title="Output columns"
                  actions={
                    <Button
                      size="sm"
                      onClick={() =>
                        selectableDicts[0] &&
                        setColumns((cs) => [...cs, { dictionary: selectableDicts[0]!.name }])
                      }
                    >
                      Add column
                    </Button>
                  }
                >
                  {columns.length === 0 ? (
                    <p className="muted">No columns yet — add at least one.</p>
                  ) : (
                    <Stack gap="sm">
                      {columns.map((c, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <Select
                            value={c.dictionary}
                            aria-label="Dictionary"
                            onChange={(e) =>
                              setColumns((cs) =>
                                cs.map((x, j) =>
                                  j === i ? { ...x, dictionary: e.target.value } : x,
                                ),
                              )
                            }
                          >
                            {dictOptions}
                          </Select>
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={c.break ?? false}
                              onChange={(e) => {
                                const on = e.target.checked;
                                setColumns((cs) =>
                                  cs.map((x, j) => (j === i ? { ...x, break: on } : x)),
                                );
                                if (on && !sorts.includes(c.dictionary)) {
                                  setSorts((ss) => [...ss, c.dictionary]); // break ⇒ sort (#14)
                                }
                              }}
                            />
                            Break
                          </label>
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={c.total ?? false}
                              onChange={(e) =>
                                setColumns((cs) =>
                                  cs.map((x, j) =>
                                    j === i ? { ...x, total: e.target.checked } : x,
                                  ),
                                )
                              }
                            />
                            Total
                          </label>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </Stack>
                  )}
                </Card>

                <Card
                  title="Selection filters (fixed, AND)"
                  actions={
                    <Button
                      size="sm"
                      onClick={() =>
                        selectableDicts[0] &&
                        setFilters((fs) => [
                          ...fs,
                          { dictionary: selectableDicts[0]!.name, operator: 'EQ', value: '' },
                        ])
                      }
                    >
                      Add filter
                    </Button>
                  }
                >
                  {filters.length === 0 ? (
                    <p className="muted">No fixed filters — every row of the source qualifies.</p>
                  ) : (
                    <Stack gap="sm">
                      {filters.map((f, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <Select
                            value={f.dictionary}
                            aria-label="Dictionary"
                            onChange={(e) =>
                              setFilters((fs) =>
                                fs.map((x, j) =>
                                  j === i ? { ...x, dictionary: e.target.value } : x,
                                ),
                              )
                            }
                          >
                            {dictOptions}
                          </Select>
                          <Select
                            value={f.operator}
                            aria-label="Operator"
                            onChange={(e) =>
                              setFilters((fs) =>
                                fs.map((x, j) =>
                                  j === i ? { ...x, operator: e.target.value } : x,
                                ),
                              )
                            }
                          >
                            {OPERATORS.map((o) => (
                              <option key={o}>{o}</option>
                            ))}
                          </Select>
                          {f.operator !== 'TR' && f.operator !== 'FL' ? (
                            <Input
                              placeholder={'value ("" = blank)'}
                              aria-label="Value"
                              value={f.value ?? ''}
                              onChange={(e) =>
                                setFilters((fs) =>
                                  fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                                )
                              }
                            />
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </Stack>
                  )}
                </Card>

                <Card
                  title="Prompts (asked at run time)"
                  actions={
                    <Button
                      size="sm"
                      onClick={() =>
                        selectableDicts[0] &&
                        setPrompts((ps) => [
                          ...ps,
                          {
                            dictionary: selectableDicts[0]!.name,
                            label: 'Value',
                            promptType: 'simple',
                          },
                        ])
                      }
                    >
                      Add prompt
                    </Button>
                  }
                >
                  {prompts.length === 0 ? (
                    <p className="muted">No prompts — the report runs without asking anything.</p>
                  ) : (
                    <Stack gap="sm">
                      {prompts.map((p, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <Select
                            value={p.dictionary}
                            aria-label="Dictionary"
                            onChange={(e) =>
                              setPrompts((ps) =>
                                ps.map((x, j) =>
                                  j === i ? { ...x, dictionary: e.target.value } : x,
                                ),
                              )
                            }
                          >
                            {selectableDicts
                              .filter((d) => !d.name.includes('.'))
                              .map((d) => (
                                <option key={d.name} value={d.name}>
                                  {d.name}
                                </option>
                              ))}
                          </Select>
                          <Input
                            placeholder="Label"
                            aria-label="Label"
                            value={p.label}
                            onChange={(e) =>
                              setPrompts((ps) =>
                                ps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                              )
                            }
                          />
                          <Select
                            value={p.promptType}
                            aria-label="Prompt type"
                            onChange={(e) =>
                              setPrompts((ps) =>
                                ps.map((x, j) =>
                                  j === i
                                    ? {
                                        ...x,
                                        promptType: e.target.value as PromptDef['promptType'],
                                        includeExclude:
                                          e.target.value === 'multi_select'
                                            ? (x.includeExclude ?? 'include')
                                            : null,
                                      }
                                    : x,
                                ),
                              )
                            }
                          >
                            <option value="simple">Simple</option>
                            <option value="range">Range</option>
                            <option value="multi_select">Multi-select</option>
                          </Select>
                          {p.promptType === 'multi_select' ? (
                            <Select
                              value={p.includeExclude ?? 'include'}
                              aria-label="Include or exclude"
                              onChange={(e) =>
                                setPrompts((ps) =>
                                  ps.map((x, j) =>
                                    j === i
                                      ? {
                                          ...x,
                                          includeExclude: e.target.value as 'include' | 'exclude',
                                        }
                                      : x,
                                  ),
                                )
                              }
                            >
                              <option value="include">Include</option>
                              <option value="exclude">Exclude</option>
                            </Select>
                          ) : null}
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={p.required ?? false}
                              onChange={(e) =>
                                setPrompts((ps) =>
                                  ps.map((x, j) =>
                                    j === i ? { ...x, required: e.target.checked } : x,
                                  ),
                                )
                              }
                            />
                            Required
                          </label>
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={p.dateCode ?? false}
                              onChange={(e) =>
                                setPrompts((ps) =>
                                  ps.map((x, j) =>
                                    j === i ? { ...x, dateCode: e.target.checked } : x,
                                  ),
                                )
                              }
                            />
                            Date codes
                          </label>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setPrompts((ps) => ps.filter((_, j) => j !== i))}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </Stack>
                  )}
                </Card>

                <Card
                  title="Sorting"
                  actions={
                    <Button
                      size="sm"
                      onClick={() =>
                        selectableDicts[0] && setSorts((ss) => [...ss, selectableDicts[0]!.name])
                      }
                    >
                      Add sort
                    </Button>
                  }
                >
                  {sorts.length === 0 ? (
                    <p className="muted">No sort — rows come back in source order.</p>
                  ) : (
                    <Stack gap="sm">
                      {sorts.map((s, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <Select
                            value={s}
                            aria-label="Sort dictionary"
                            onChange={(e) =>
                              setSorts((ss) => ss.map((x, j) => (j === i ? e.target.value : x)))
                            }
                          >
                            {dictOptions}
                          </Select>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setSorts((ss) => ss.filter((_, j) => j !== i))}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </Stack>
                  )}
                </Card>

                <FormActions
                  start={
                    !name || columns.length === 0 ? (
                      <span>A report name and at least one output column are required.</span>
                    ) : undefined
                  }
                >
                  <Button variant="secondary" onClick={() => setMode('list')}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void save()}
                    disabled={!name || columns.length === 0}
                  >
                    Save report
                  </Button>
                </FormActions>
              </>
            ) : null}
          </>
        ) : null}

        {mode === 'run' && runReport && runInfo ? (
          <>
            <Card title={`Run: ${runReport.name}`}>
              <Stack>
                {runInfo.runTimeInformation ? (
                  <Alert tone="info">
                    <span className="whitespace-pre-wrap">{runInfo.runTimeInformation}</span>
                  </Alert>
                ) : null}
                <FormGrid cols={3}>
                  {runInfo.prompts.map((p) => (
                    <Field
                      key={p.dictionary}
                      label={p.label}
                      required={p.required}
                      hint={
                        [
                          p.dateCode ? 'TDAY / YDAY / CPTD / LPTD accepted' : null,
                          p.promptType === 'multi_select' ? 'Comma-separated values' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || undefined
                      }
                    >
                      <Input
                        value={answers[p.dictionary] ?? ''}
                        onChange={(e) =>
                          setAnswers((a) => ({ ...a, [p.dictionary]: e.target.value }))
                        }
                      />
                    </Field>
                  ))}
                  {runInfo.summaryOnlyAvailable ? (
                    <label className="flex items-center gap-2 self-end">
                      <input
                        type="checkbox"
                        checked={summaryOnly}
                        onChange={(e) => setSummaryOnly(e.target.checked)}
                      />
                      Summary only — totals, no detail rows
                    </label>
                  ) : null}
                </FormGrid>
              </Stack>
              <FormActions>
                <Button
                  variant="secondary"
                  onClick={() => void archiveRun()}
                  disabled={running}
                  title="Run now and store the result in the archive instead of rendering it"
                >
                  Send to archive
                </Button>
                <Button variant="primary" onClick={() => void execute()} disabled={running}>
                  {running ? 'Running…' : 'Run'}
                </Button>
              </FormActions>
            </Card>

            {result ? (
              <Card
                title={result.title ?? runReport.name}
                description={result.subTitle ?? undefined}
              >
                <Stack>
                  {result.truncated ? (
                    <Alert tone="warning">
                      Output truncated at the row cap — narrow the criteria.
                    </Alert>
                  ) : null}
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <ColumnHeadRow list={resultCols} testIdPrefix="reports-builder-result" />
                      </thead>
                      <tbody>
                        {result.rows.length === 0 && result.groups.length === 0 && (
                          <TableEmpty colSpan={Math.max(1, resultCols.ordered.length)}>
                            No rows matched.
                          </TableEmpty>
                        )}
                        {resultCols.sorted.map((r, i) => (
                          <tr key={i}>
                            <ColumnCells list={resultCols} row={r} />
                          </tr>
                        ))}
                        {result.groups.map((g, i) => (
                          <tr key={`g${i}`} className="font-medium">
                            <TotalCells
                              list={resultCols}
                              label={`TOTAL ${String(g.key ?? '')}`}
                              totals={totalsFor(result, g.totals)}
                            />
                          </tr>
                        ))}
                        {Object.keys(result.grandTotals).length > 0 ? (
                          <tr className="font-semibold">
                            <TotalCells
                              list={resultCols}
                              label="GRAND TOTAL"
                              totals={totalsFor(result, result.grandTotals)}
                            />
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                    <ResetColumns list={resultCols} />
                  </TableWrap>
                </Stack>
              </Card>
            ) : null}
          </>
        ) : null}
      </Stack>
    </div>
  );
}
