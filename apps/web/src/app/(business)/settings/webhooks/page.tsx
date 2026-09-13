'use client';

import { toast } from 'sonner';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  BackLink,
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
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  consecutiveFailures: number;
  totalDeliveries: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}
interface Delivery {
  id: string;
  eventType: string;
  status: string;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
}

const DELIVERY_COLUMNS: ColumnDef<Delivery>[] = [
  {
    id: 'time',
    label: 'Time',
    className: 'nowrap',
    sortValue: (d) => d.createdAt,
    render: (d) => new Date(d.createdAt).toLocaleString(),
  },
  {
    id: 'event',
    label: 'Event',
    sortValue: (d) => d.eventType,
    render: (d) => <code>{d.eventType}</code>,
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (d) => d.status,
    render: (d) => (
      <>
        <StatusBadge status={d.status} />
        {d.responseStatus != null && <span className="muted"> ({d.responseStatus})</span>}
      </>
    ),
  },
  {
    id: 'response',
    label: 'Response',
    sortValue: (d) => d.errorMessage ?? d.responseBody,
    render: (d) =>
      d.errorMessage ? (
        <code className="text-[var(--danger)]">{d.errorMessage}</code>
      ) : d.responseBody ? (
        <code className="block max-h-[60px] overflow-auto break-all">
          {d.responseBody.slice(0, 200)}
        </code>
      ) : (
        '—'
      ),
  },
];

export default function WebhooksPage() {
  const [rows, setRows] = useState<Endpoint[] | null>(null);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newSecret, setNewSecret] = useState<{ id: string; secret: string } | null>(null);
  const [openEndpointId, setOpenEndpointId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [testing, setTesting] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [list, types] = await Promise.all([
        api<Endpoint[]>('/v1/business/webhooks'),
        api<{ types: string[] }>('/v1/business/webhooks/event-types'),
      ]);
      setRows(list);
      setEventTypes(types.types);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const form = e.currentTarget;
    try {
      const data = new FormData(form);
      const events = data.getAll('events').map(String);
      if (events.length === 0) throw new Error('Pick at least one event type.');
      const created = await api<Endpoint & { secret: string }>('/v1/business/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          url: String(data.get('url') ?? ''),
          description: String(data.get('description') ?? '') || null,
          events,
        }),
      });
      setNewSecret({ id: created.id, secret: created.secret });
      form.reset();
      setCreating(false);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(row: Endpoint) {
    try {
      await api(`/v1/business/webhooks/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !row.isActive }),
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function destroy(row: Endpoint) {
    if (!confirm(`Delete webhook for ${row.url}? Delivery history is removed too.`)) return;
    try {
      await api(`/v1/business/webhooks/${row.id}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function testFire(row: Endpoint) {
    setTesting(row.id);
    try {
      const res = await api<{ status: string }>(`/v1/business/webhooks/${row.id}/test`, {
        method: 'POST',
      });
      if (res.status === 'succeeded') {
        toast.success('Test event delivered (HTTP 2xx).');
      } else {
        toast.error(`Test event failed: ${res.status}. Inspect deliveries below.`);
      }
      if (openEndpointId === row.id) void loadDeliveries(row.id);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(null);
    }
  }

  async function loadDeliveries(id: string) {
    try {
      setDeliveries(await api<Delivery[]>(`/v1/business/webhooks/${id}/deliveries?limit=200`));
      setOpenEndpointId(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Built inline: the actions cell needs the row callbacks and `testing`.
  const endpointColumns: ColumnDef<Endpoint>[] = [
    {
      id: 'url',
      label: 'URL',
      sortValue: (r) => r.url,
      render: (r) => (
        <>
          <code className="break-all">{r.url}</code>
          {r.description && <div className="muted">{r.description}</div>}
        </>
      ),
    },
    {
      id: 'events',
      label: 'Events',
      sortValue: (r) => r.events.join(', '),
      render: (r) => <code className="break-words">{r.events.join(', ')}</code>,
    },
    {
      id: 'health',
      label: 'Health',
      sortValue: (r) => (r.isActive ? 'active' : 'paused'),
      render: (r) => (
        <>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge status={r.isActive ? 'active' : 'paused'} />
            {r.consecutiveFailures > 0 && (
              <span className="text-[var(--danger)]">
                {r.consecutiveFailures} consecutive failure(s)
              </span>
            )}
          </span>
          <div className="muted">
            {r.totalDeliveries} delivered ·{' '}
            {r.lastSuccessAt
              ? `ok ${new Date(r.lastSuccessAt).toLocaleString()}`
              : 'no success yet'}
          </div>
        </>
      ),
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => testFire(r)} disabled={testing === r.id}>
            {testing === r.id ? 'Testing…' : 'Test'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => loadDeliveries(r.id)}>
            History
          </Button>
          <Button size="sm" variant="ghost" onClick={() => toggleActive(r)}>
            {r.isActive ? 'Pause' : 'Enable'}
          </Button>
          <Button size="sm" variant="danger" onClick={() => destroy(r)}>
            Delete
          </Button>
        </>
      ),
    },
  ];
  const cols = useListColumns('settings-webhooks', endpointColumns, rows);
  const deliveryCols = useListColumns('settings-webhooks-deliveries', DELIVERY_COLUMNS, deliveries);

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/settings">Settings</BackLink>}
        title="Outbound webhooks"
        sub={
          <>
            LA Mattress ERP will POST a JSON body to your URL whenever a subscribed event fires.
            Verify the <code>X-Jetnine-Signature</code> header (Stripe-style{' '}
            <code>t=&lt;unix&gt;,v1=&lt;hmacsha256(t.body)&gt;</code>) using the secret shown once
            at create time.
          </>
        }
        actions={
          <Button
            variant={creating ? 'secondary' : 'primary'}
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? 'Cancel' : '+ New endpoint'}
          </Button>
        }
      />

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        {newSecret && (
          <Alert
            tone="warning"
            title="Save this signing secret — it won't be shown again:"
            action={
              <Button size="sm" variant="secondary" onClick={() => setNewSecret(null)}>
                Got it
              </Button>
            }
          >
            <code className="block break-all whitespace-pre-wrap">{newSecret.secret}</code>
          </Alert>
        )}

        {creating && (
          <Card title="New endpoint" className="form-narrow">
            <form onSubmit={create}>
              <FormGrid cols={1}>
                <Field label="URL" required>
                  <Input
                    name="url"
                    type="url"
                    placeholder="https://example.com/webhooks/la-mattress-erp"
                    required
                  />
                </Field>
                <Field label="Description (optional)">
                  <Input name="description" />
                </Field>
                <fieldset className="m-0 min-w-0 border-0 p-0">
                  <legend className="field-label">Subscribe to events *</legend>
                  <label className="flex items-center gap-1.5 pb-2 font-semibold">
                    <input type="checkbox" name="events" value="*" />
                    All events (wildcard, including future types)
                  </label>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {eventTypes.map((t) => (
                      <label key={t} className="flex items-center gap-1.5">
                        <input type="checkbox" name="events" value={t} />
                        <code>{t}</code>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </FormGrid>
              <FormActions>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create endpoint'}
                </Button>
              </FormActions>
            </form>
          </Card>
        )}

        {rows == null ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState title="No webhook endpoints yet">
            Add an endpoint to receive a POST whenever a subscribed event fires.
          </EmptyState>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="settings-webhooks" />
                </thead>
                <tbody>
                  {cols.sorted.map((r) => (
                    <tr key={r.id}>
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
          </Card>
        )}

        {openEndpointId && (
          <Card
            title="Recent deliveries"
            flush
            actions={
              <Button size="sm" variant="ghost" onClick={() => setOpenEndpointId(null)}>
                Close
              </Button>
            }
          >
            <TableWrap maxHeight="60vh">
              <table className="table table-dense table-sticky">
                <thead>
                  <ColumnHeadRow list={deliveryCols} testIdPrefix="settings-webhooks-deliveries" />
                </thead>
                <tbody>
                  {deliveries.length === 0 && (
                    <TableEmpty colSpan={deliveryCols.ordered.length}>
                      No deliveries yet.
                    </TableEmpty>
                  )}
                  {deliveryCols.sorted.map((d) => (
                    <tr key={d.id}>
                      <ColumnCells list={deliveryCols} row={d} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={deliveryCols} />
            </TableWrap>
          </Card>
        )}
      </Stack>
    </div>
  );
}
