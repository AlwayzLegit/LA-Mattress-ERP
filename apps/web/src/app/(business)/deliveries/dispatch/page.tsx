'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { SecurityOverrideDialog } from '@/components/security-override-dialog';
import { Money } from '@/components/money';
import { toast } from 'sonner';
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
  LinkButton,
  LoadingRows,
  EmptyState,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  StatusBadge,
  TableWrap,
  useListColumns,
} from '@/components/ui';

/**
 * Dispatcher view (PLAN-POS-OPERATIONS §7): one day's stops as a simple
 * table sorted by route then stop, with the capacity state ("12/15")
 * up top. Route labels are auto-suggested from zip at scheduling and
 * edited inline here; stop numbers reorder the same way. Drivers never
 * see this screen — they get the printed tickets.
 */

interface DeliveryDetail {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  routePosition: number | null;
  route: string | null;
  runId: string | null;
  addressLine1: string | null;
  addressCity: string | null;
  addressPostalCode: string | null;
  addressPhone: string | null;
  balanceDueCents: number;
  lines: { id: string; description: string; quantity: number }[];
}

interface Capacity {
  cap: number;
  days: { date: string; booked: number; remaining: number }[];
}

interface Run {
  id: string;
  runDate: string;
  route: string | null;
  truck: string | null;
  status: string;
  codDueCents: number;
  codCollectedCents: number | null;
  stops: DeliveryDetail[];
}

interface ReasonCode {
  id: string;
  code: string;
  description: string;
}

const CLOSED_STOP = ['delivered', 'failed', 'cancelled'];

/**
 * G7 close-out: the mandatory reconciliation. Every open stop gets an
 * outcome; failed stops take a coded reason and an optional reschedule;
 * COD due vs collected is compared server-side and variances land in
 * the exception register.
 */
function RunCard({
  run,
  failureCodes,
  onChanged,
}: {
  run: Run;
  failureCodes: ReasonCode[];
  onChanged: () => Promise<void> | void;
}) {
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<
    Record<
      string,
      {
        outcome: 'delivered' | 'failed';
        reasonCodeId?: string;
        reason?: string;
        rescheduleDate?: string;
      }
    >
  >({});
  const [codCollected, setCodCollected] = useState('');
  const [codReceivedBy, setCodReceivedBy] = useState('');

  const openStops = run.stops.filter((s) => !CLOSED_STOP.includes(s.status));

  async function act(path: string, body?: unknown) {
    setBusy(true);
    try {
      await api(`/v1/delivery-runs/${run.id}${path}`, {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Pulling a stop off a run is a manifest-removal exception in STORIS
  // terms — it needs a CODED reason and can need a manager. A native
  // window.prompt could carry neither (and froze the QA browser), so it
  // goes through the same dialog every other gated action uses.
  const [removingStopId, setRemovingStopId] = useState<string | null>(null);

  async function submitClose() {
    const missing = openStops.filter((s) => !outcomes[s.id]?.outcome);
    if (missing.length > 0) {
      toast.error('Every stop needs an outcome before close-out.');
      return;
    }
    await act('/close', {
      outcomes: openStops.map((s) => ({ deliveryId: s.id, ...outcomes[s.id] })),
      codCollectedCents: Math.round(Number(codCollected || '0') * 100),
      codReceivedBy: codReceivedBy.trim() || null,
    });
    setClosing(false);
  }

  const showActionsColumn = closing || run.status !== 'completed';

  // The stop sequence IS the run, so these columns move but never sort.
  const actionsColumn: ColumnDef<DeliveryDetail> = {
    id: 'actions',
    label: closing ? 'Outcome' : '',
    srLabel: closing ? undefined : 'Actions',
    className: 'actions',
    fixed: true,
    render: (s) => {
      const open = !CLOSED_STOP.includes(s.status);
      return (
        <>
          {closing && open && (
            <span className="inline-flex flex-wrap items-center justify-end gap-2">
              <Select
                value={outcomes[s.id]?.outcome ?? ''}
                data-testid="stop-outcome"
                aria-label="Outcome"
                onChange={(e) =>
                  setOutcomes((prev) => ({
                    ...prev,
                    [s.id]: {
                      ...prev[s.id],
                      outcome: e.target.value as 'delivered' | 'failed',
                    },
                  }))
                }
                className="w-32"
              >
                <option value="">Outcome…</option>
                <option value="delivered">Delivered</option>
                <option value="failed">Failed</option>
              </Select>
              {outcomes[s.id]?.outcome === 'failed' && (
                <>
                  {failureCodes.length > 0 ? (
                    <Select
                      value={outcomes[s.id]?.reasonCodeId ?? ''}
                      aria-label="Failure reason"
                      onChange={(e) =>
                        setOutcomes((prev) => ({
                          ...prev,
                          [s.id]: { ...prev[s.id]!, reasonCodeId: e.target.value },
                        }))
                      }
                      className="w-40"
                    >
                      <option value="">Why…</option>
                      {failureCodes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} — {c.description}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      placeholder="Why?"
                      aria-label="Failure reason"
                      value={outcomes[s.id]?.reason ?? ''}
                      onChange={(e) =>
                        setOutcomes((prev) => ({
                          ...prev,
                          [s.id]: { ...prev[s.id]!, reason: e.target.value },
                        }))
                      }
                      className="w-36"
                    />
                  )}
                  <Input
                    type="date"
                    title="Reschedule to"
                    aria-label="Reschedule to"
                    value={outcomes[s.id]?.rescheduleDate ?? ''}
                    onChange={(e) =>
                      setOutcomes((prev) => ({
                        ...prev,
                        [s.id]: { ...prev[s.id]!, rescheduleDate: e.target.value },
                      }))
                    }
                    className="w-36"
                  />
                </>
              )}
            </span>
          )}
          {run.status !== 'completed' && !closing && open && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              data-testid="pull-off-run"
              onClick={() => setRemovingStopId(s.id)}
            >
              Pull off run
            </Button>
          )}
        </>
      );
    },
  };
  const stopColumns: ColumnDef<DeliveryDetail>[] = [
    {
      id: 'position',
      label: '#',
      num: true,
      render: (s, i) => <strong>{s.routePosition ?? i + 1}</strong>,
    },
    {
      id: 'stop',
      label: 'Stop',
      render: (s) => (
        <>
          {s.orderNumber} · {s.customerName ?? '—'}
        </>
      ),
    },
    { id: 'status', label: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    {
      id: 'collect',
      label: 'Collect',
      num: true,
      render: (s) => (s.balanceDueCents > 0 ? <Money cents={s.balanceDueCents} /> : '—'),
    },
    ...(showActionsColumn ? [actionsColumn] : []),
  ];
  const stopCols = useListColumns('deliveries-dispatch-runs', stopColumns, run.stops);

  return (
    <Card
      data-testid="run-card"
      title={
        <>
          Run {run.route ?? '—'} {run.truck ? `· ${run.truck}` : ''}{' '}
          <StatusBadge status={run.status} />
        </>
      }
      description={
        <>
          {run.stops.length} stop(s) · COD due <Money cents={run.codDueCents} />
          {run.codCollectedCents != null && (
            <>
              {' '}
              · collected <Money cents={run.codCollectedCents} />
            </>
          )}
        </>
      }
      actions={
        <>
          <LinkButton
            href={`/print/delivery-runs/${run.id}`}
            variant="secondary"
            size="sm"
            target="_blank"
          >
            <Printer size={13} aria-hidden /> Manifest
          </LinkButton>
          {run.status === 'open' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void act('/depart')}
            >
              Depart
            </Button>
          )}
          {run.status !== 'completed' && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              data-testid="run-close-toggle"
              onClick={() => setClosing((c) => !c)}
            >
              {closing ? 'Hide close-out' : 'Close out…'}
            </Button>
          )}
        </>
      }
    >
      <Stack>
        <TableWrap>
          <table className="table table-dense">
            <thead>
              <ColumnHeadRow list={stopCols} testIdPrefix="deliveries-dispatch-runs" />
            </thead>
            <tbody>
              {run.stops.map((s, i) => (
                <tr key={s.id}>
                  <ColumnCells list={stopCols} row={s} index={i} />
                </tr>
              ))}
            </tbody>
          </table>
          <ResetColumns list={stopCols} />
        </TableWrap>

        {closing && (
          <div>
            <FormGrid cols={3}>
              <Field label="COD collected ($)">
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={codCollected}
                  data-testid="cod-collected"
                  onChange={(e) => setCodCollected(e.target.value)}
                />
              </Field>
              <Field label="Cash handed to">
                <Input value={codReceivedBy} onChange={(e) => setCodReceivedBy(e.target.value)} />
              </Field>
            </FormGrid>
            <FormActions
              start={
                openStops.length > 0
                  ? `${openStops.length} open stop(s) need an outcome.`
                  : 'All stops have an outcome.'
              }
            >
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={busy}
                data-testid="run-close-submit"
                onClick={() => void submitClose()}
              >
                Complete run
              </Button>
            </FormActions>
          </div>
        )}
      </Stack>

      <SecurityOverrideDialog
        open={removingStopId != null}
        title="Pull this stop off the run"
        usageClass="manifest_removal"
        submitLabel="Pull off run"
        perform={async (payload) => {
          await api(`/v1/delivery-runs/${run.id}/remove-delivery`, {
            method: 'POST',
            body: JSON.stringify({ deliveryId: removingStopId, ...payload }),
          });
        }}
        onClose={() => setRemovingStopId(null)}
        onSuccess={() => void onChanged()}
      />
    </Card>
  );
}

function DispatchInner() {
  const search = useSearchParams();
  const [date, setDate] = useState(
    () => search?.get('date') ?? new Date().toISOString().slice(0, 10),
  );
  const [rows, setRows] = useState<DeliveryDetail[] | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [failureCodes, setFailureCodes] = useState<ReasonCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [buildingRun, setBuildingRun] = useState(false);

  useEffect(() => {
    api<ReasonCode[]>('/v1/reason-codes?usageClass=delivery_failure')
      .then(setFailureCodes)
      .catch(() => setFailureCodes([]));
  }, []);

  const load = useCallback(async (d: string) => {
    try {
      const [trips, cap, dayRuns] = await Promise.all([
        api<DeliveryDetail[]>(`/v1/deliveries?from=${d}&to=${d}`),
        api<Capacity>(`/v1/deliveries/capacity?from=${d}&to=${d}`),
        api<Run[]>(`/v1/delivery-runs?date=${d}`).catch(() => [] as Run[]),
      ]);
      trips.sort(
        (a, b) =>
          (a.route ?? '￿').localeCompare(b.route ?? '￿') ||
          (a.routePosition ?? 999) - (b.routePosition ?? 999),
      );
      setRows(trips);
      setCapacity(cap);
      setRuns(dayRuns);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/v1/deliveries/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await load(date);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Stop and Route are edited in place, so the cells need `patch`.
  const stopColumns: ColumnDef<DeliveryDetail>[] = [
    {
      id: 'stop',
      label: 'Stop',
      sortValue: (r) => r.routePosition,
      render: (r) => (
        <Input
          type="number"
          min={1}
          aria-label="Stop number"
          defaultValue={r.routePosition ?? ''}
          disabled={!(r.status === 'scheduled' || r.status === 'loaded')}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v > 0 && v !== r.routePosition) {
              void patch(r.id, { routePosition: v });
            }
          }}
          className="w-16"
        />
      ),
    },
    {
      id: 'route',
      label: 'Route',
      sortValue: (r) => r.route,
      render: (r) => (
        <Input
          defaultValue={r.route ?? ''}
          placeholder="—"
          aria-label="Route"
          disabled={!(r.status === 'scheduled' || r.status === 'loaded')}
          data-testid="route-input"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (r.route ?? '')) void patch(r.id, { route: v || null });
          }}
          className="w-28"
        />
      ),
    },
    {
      id: 'order',
      label: 'Order #',
      className: 'nowrap',
      sortValue: (r) => r.orderNumber,
      render: (r) => <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>,
    },
    {
      id: 'customer',
      label: 'Customer',
      sortValue: (r) => r.customerName,
      render: (r) => r.customerName ?? '—',
    },
    {
      id: 'address',
      label: 'Address',
      sortValue: (r) =>
        [r.addressLine1, r.addressCity, r.addressPostalCode].filter(Boolean).join(', ') || null,
      render: (r) => (
        <>
          {[r.addressLine1, r.addressCity, r.addressPostalCode].filter(Boolean).join(', ') || '—'}
          {r.addressPhone && <div className="muted">{r.addressPhone}</div>}
        </>
      ),
    },
    {
      id: 'window',
      label: 'Window',
      className: 'nowrap',
      sortValue: (r) => r.windowStart,
      render: (r) =>
        r.windowStart && r.windowEnd
          ? `${r.windowStart.slice(0, 5)}–${r.windowEnd.slice(0, 5)}`
          : '—',
    },
    {
      id: 'items',
      label: 'Items',
      sortValue: (r) => r.lines.map((l) => `${l.quantity}× ${l.description}`).join(', '),
      render: (r) => r.lines.map((l) => `${l.quantity}× ${l.description}`).join(', '),
    },
    {
      id: 'collect',
      label: 'Collect',
      num: true,
      sortValue: (r) => r.balanceDueCents,
      render: (r) => (r.balanceDueCents > 0 ? <Money cents={r.balanceDueCents} /> : '—'),
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (r) => r.status,
      render: (r) => <StatusBadge status={r.status} />,
    },
  ];
  const cols = useListColumns('deliveries-dispatch-stops', stopColumns, rows);

  const day = capacity?.days[0];
  const atCap = day && capacity && day.booked >= capacity.cap;
  const unassigned = (rows ?? []).filter(
    (r) => !r.runId && (r.status === 'scheduled' || r.status === 'loaded'),
  );

  async function createRun() {
    setBuildingRun(true);
    try {
      await api('/v1/delivery-runs', {
        method: 'POST',
        body: JSON.stringify({ runDate: date, deliveryIds: unassigned.map((r) => r.id) }),
      });
      await load(date);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuildingRun(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/deliveries">Calendar</BackLink>}
        title="Dispatch"
        meta={
          day && capacity ? (
            <span
              className={`badge badge-${atCap ? 'danger' : day.booked >= capacity.cap - 3 ? 'warning' : 'success'}`}
              data-testid="capacity-chip"
            >
              {day.booked}/{capacity.cap} stops
            </span>
          ) : undefined
        }
        sub="Stops for the day by route. Edit a route label or stop number in place; drivers work off the printed tickets."
        actions={
          <>
            <Input
              type="date"
              value={date}
              aria-label="Dispatch date"
              onChange={(e) => setDate(e.target.value)}
              data-testid="dispatch-date"
            />
            <LinkButton
              href={`/print/deliveries?date=${date}`}
              variant="secondary"
              size="sm"
              target="_blank"
            >
              <Printer size={13} aria-hidden /> All tickets
            </LinkButton>
          </>
        }
      />

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {!rows && !error && <LoadingRows rows={5} />}
        {rows && rows.length === 0 && runs.length === 0 && (
          <EmptyState title="Nothing to dispatch">No deliveries scheduled for {date}.</EmptyState>
        )}

        {runs.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            failureCodes={failureCodes}
            onChanged={() => load(date)}
          />
        ))}

        {unassigned.length > 0 && (
          <Alert
            tone="info"
            action={
              <Button
                size="sm"
                variant="secondary"
                data-testid="create-run"
                disabled={buildingRun}
                aria-busy={buildingRun}
                onClick={() => void createRun()}
              >
                Build run from {unassigned.length} unassigned stop(s)
              </Button>
            }
          >
            Building the run hard-locks the orders until close-out.
          </Alert>
        )}

        {rows && rows.length > 0 && (
          <Card title="Stops" flush>
            <TableWrap>
              <table className="table" data-testid="dispatch-table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="deliveries-dispatch-stops" />
                </thead>
                <tbody>
                  {cols.sorted.map((r) => (
                    <tr key={r.id} data-testid="dispatch-row">
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

export default function DispatchPage() {
  return (
    <Suspense fallback={<LoadingRows rows={5} />}>
      <DispatchInner />
    </Suspense>
  );
}
