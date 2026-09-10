'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  Alert,
  BackLink,
  Button,
  Card,
  Field,
  FormActions,
  FormGrid,
  Input,
  KeyValue,
  LinkButton,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
} from '@/components/ui';

interface CountLine {
  id: string;
  variantId: string;
  sku: string | null;
  productName: string;
  binCode: string | null;
  frozenQty: number;
  frozenReserved: number;
  postFreezeDelta: number;
  countedQty: number | null;
  variance: number | null;
  reasonCodeId: string | null;
  postedVariance: number | null;
}

interface CountDetail {
  id: string;
  locationId: string;
  locationName: string;
  status: string;
  countDate: string;
  frozenAt: string;
  postedAt: string | null;
  notes: string | null;
  lines: CountLine[];
}

interface ReasonCode {
  id: string;
  code: string;
  description: string;
}

export default function PhysicalCountDetailPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [count, setCount] = useState<CountDetail | null>(null);
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [skipUncounted, setSkipUncounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    try {
      setCount(await api<CountDetail>(`/v1/inventory/counts/${id}`));
      setDrafts({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
    api<ReasonCode[]>('/v1/reason-codes?usageClass=physical_variance')
      .then(setReasonCodes)
      .catch(() => setReasonCodes([]));
  }, [id]);

  const live = count?.status === 'open' || count?.status === 'counting';

  const dirty = useMemo(() => {
    if (!count) return [];
    return count.lines
      .filter((l) => {
        const d = drafts[l.variantId];
        if (d === undefined || d.trim() === '') return false;
        const n = Number(d);
        return Number.isInteger(n) && n >= 0 && n !== l.countedQty;
      })
      .map((l) => ({ variantId: l.variantId, countedQty: Number(drafts[l.variantId]) }));
  }, [count, drafts]);

  const invalid = useMemo(() => {
    return Object.values(drafts).some((d) => {
      if (d.trim() === '') return false;
      const n = Number(d);
      return !Number.isInteger(n) || n < 0;
    });
  }, [drafts]);

  const uncounted = count?.lines.filter((l) => l.countedQty === null).length ?? 0;
  const variances = count?.lines.filter((l) => l.countedQty !== null && l.variance !== 0) ?? [];
  const needsReason = reasonCodes.length > 0 && variances.length > 0;

  async function saveCounts() {
    if (dirty.length === 0 || busy) return;
    setBusy(true);
    try {
      await api(`/v1/inventory/counts/${id}/lines`, {
        method: 'POST',
        body: JSON.stringify({ entries: dirty }),
      });
      toast.success(`Saved ${dirty.length} count(s)`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    if (busy) return;
    if (dirty.length > 0) {
      toast.error('Save your entered counts first.');
      return;
    }
    if (needsReason && !reasonCodeId) {
      toast.error('Pick a variance reason code before posting.');
      return;
    }
    const msg =
      `Post this count? ${variances.length} variance line(s) will adjust stock` +
      (uncounted > 0 ? `; ${uncounted} uncounted line(s) will be left unchanged.` : '.');
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      const res = await api<{ posted: number; skipped: number; varianceUnits: number }>(
        `/v1/inventory/counts/${id}/post`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(reasonCodeId ? { reasonCodeId } : {}),
            ...(uncounted > 0 ? { skipUncounted: true } : {}),
          }),
        },
      );
      toast.success(
        `Posted — ${res.posted} variance line(s), ${res.varianceUnits} unit(s) adjusted`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelCount() {
    if (busy) return;
    if (!confirm('Cancel this count? Entered counts are discarded and stock is unchanged.')) return;
    setBusy(true);
    try {
      await api(`/v1/inventory/counts/${id}/cancel`, { method: 'POST', body: '{}' });
      toast.success('Count cancelled');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/products/counts">All counts</BackLink>}
        title={count ? `Count — ${count.locationName}` : 'Physical count'}
        meta={count ? <StatusBadge status={count.status} /> : undefined}
        sub={
          count
            ? `Counted ${count.lines.length - uncounted}/${count.lines.length} · Frozen ${new Date(count.frozenAt).toLocaleString()}`
            : undefined
        }
        actions={
          <LinkButton href={`/print/counts/${id}`} variant="secondary" size="sm">
            <Printer size={14} />
            Count sheet
          </LinkButton>
        }
      />

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {count == null ? (
          <Card>
            <LoadingRows />
          </Card>
        ) : (
          <>
            <Card
              title="Count details"
              description={
                live
                  ? 'Expected = frozen snapshot plus stock movement since the freeze, so sales made during the count do not show up as shrink. Variance = counted − expected.'
                  : undefined
              }
            >
              <KeyValue
                rows={[
                  { label: 'Location', value: count.locationName },
                  {
                    label: 'Date',
                    value: new Date(`${count.countDate}T00:00:00`).toLocaleDateString(),
                  },
                  { label: 'Frozen', value: new Date(count.frozenAt).toLocaleString() },
                  ...(count.postedAt
                    ? [{ label: 'Posted', value: new Date(count.postedAt).toLocaleString() }]
                    : []),
                  {
                    label: 'Counted',
                    value: `${count.lines.length - uncounted}/${count.lines.length}`,
                  },
                  ...(count.notes ? [{ label: 'Notes', value: count.notes }] : []),
                ]}
              />
            </Card>

            <Card flush>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Bin</th>
                      <th>SKU</th>
                      <th>Item</th>
                      <th className="num">Expected</th>
                      <th className="num">Counted</th>
                      <th className="num">Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {count.lines.length === 0 && (
                      <TableEmpty colSpan={6}>No lines on this count.</TableEmpty>
                    )}
                    {count.lines.map((l) => {
                      const expected = l.frozenQty + l.postFreezeDelta;
                      const draft = drafts[l.variantId];
                      const shownVariance =
                        count.status === 'posted' ? l.postedVariance : l.variance;
                      return (
                        <tr key={l.id}>
                          <td>{l.binCode ?? '—'}</td>
                          <td>
                            <code>{l.sku ?? '—'}</code>
                          </td>
                          <td>{l.productName}</td>
                          <td className="num">{expected}</td>
                          <td className="num">
                            {live ? (
                              <Input
                                value={draft ?? (l.countedQty === null ? '' : String(l.countedQty))}
                                onChange={(e) =>
                                  setDrafts((d) => ({ ...d, [l.variantId]: e.target.value }))
                                }
                                inputMode="numeric"
                                placeholder="—"
                                aria-label={`Counted quantity for ${l.sku ?? l.productName}`}
                                className="w-20 text-right"
                              />
                            ) : (
                              (l.countedQty ?? '—')
                            )}
                          </td>
                          <td
                            className="num"
                            style={
                              shownVariance != null && shownVariance !== 0
                                ? { color: 'var(--danger)', fontWeight: 600 }
                                : undefined
                            }
                          >
                            {shownVariance == null
                              ? '—'
                              : shownVariance > 0
                                ? `+${shownVariance}`
                                : shownVariance}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </Card>

            {live && (
              <Card title="Save and post">
                {(needsReason || uncounted > 0) && (
                  <FormGrid cols={2}>
                    {needsReason && (
                      <Field label="Variance reason" required>
                        <Select
                          value={reasonCodeId}
                          onChange={(e) => setReasonCodeId(e.target.value)}
                        >
                          <option value="">— Variance reason —</option>
                          {reasonCodes.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.code} — {r.description}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    {uncounted > 0 && (
                      <div className="field">
                        <span className="field-label">Uncounted lines</span>
                        <label className="flex h-9 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={skipUncounted}
                            onChange={(e) => setSkipUncounted(e.target.checked)}
                          />
                          Leave {uncounted} uncounted line(s) unchanged
                        </label>
                      </div>
                    )}
                  </FormGrid>
                )}
                {invalid && (
                  <Alert tone="error" className={needsReason || uncounted > 0 ? 'mt-3' : undefined}>
                    Counts must be whole numbers ≥ 0.
                  </Alert>
                )}
                <FormActions
                  start={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void cancelCount()}
                    >
                      Cancel count
                    </Button>
                  }
                >
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy || (uncounted > 0 && !skipUncounted)}
                    onClick={() => void post()}
                  >
                    Post count
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={dirty.length === 0 || invalid || busy}
                    onClick={() => void saveCounts()}
                  >
                    {busy ? 'Working…' : `Save ${dirty.length || ''} count(s)`}
                  </Button>
                </FormActions>
              </Card>
            )}
          </>
        )}
      </Stack>
    </div>
  );
}
