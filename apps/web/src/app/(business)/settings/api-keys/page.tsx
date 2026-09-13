'use client';

import { toast } from 'sonner';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
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
  Select,
  Stack,
  TableWrap,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';

interface KeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  livemode: 'live' | 'test';
  scopes: string[];
  notes: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const [rows, setRows] = useState<KeyRow[] | null>(null);
  const [allScopes, setAllScopes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newKey, setNewKey] = useState<{ id: string; key: string } | null>(null);
  const [filter, setFilter] = useState('');

  async function load() {
    setError(null);
    try {
      const [list, scopes] = await Promise.all([
        api<KeyRow[]>('/v1/business/api-keys'),
        api<{ all: string[] }>('/v1/business/api-keys/scopes'),
      ]);
      setRows(list);
      setAllScopes(scopes.all);
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
      const scopes = data.getAll('scopes').map(String);
      if (scopes.length === 0) throw new Error('Pick at least one scope.');
      const created = await api<KeyRow & { key: string }>('/v1/business/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          name: String(data.get('name') ?? ''),
          notes: String(data.get('notes') ?? '') || null,
          scopes,
          livemode: data.get('livemode') === 'live' ? 'live' : 'test',
        }),
      });
      setNewKey({ id: created.id, key: created.key });
      form.reset();
      setCreating(false);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(row: KeyRow) {
    if (
      !confirm(
        `Revoke "${row.name}"? Anything still using this key will start getting 401s immediately.`,
      )
    )
      return;
    try {
      await api(`/v1/business/api-keys/${row.id}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const visibleScopes = useMemo(() => {
    if (!filter) return allScopes;
    return allScopes.filter((s) => s.includes(filter.toLowerCase()));
  }, [allScopes, filter]);

  // Built inline: the Revoke cell needs `revoke`.
  const columns: ColumnDef<KeyRow>[] = [
    {
      id: 'name',
      label: 'Name',
      sortValue: (r) => r.name,
      render: (r) => (
        <>
          <strong>{r.name}</strong>
          {r.revokedAt && <span className="badge badge-danger ml-1.5">revoked</span>}
          {r.notes && <div className="muted">{r.notes}</div>}
        </>
      ),
    },
    {
      id: 'prefix',
      label: 'Prefix',
      sortValue: (r) => r.keyPrefix,
      render: (r) => (
        <>
          <code>{r.keyPrefix}…</code>
          <div className="muted">{r.livemode}</div>
        </>
      ),
    },
    {
      id: 'scopes',
      label: 'Scopes',
      sortValue: (r) => r.scopes.join(', '),
      render: (r) => <code className="break-words">{r.scopes.join(', ')}</code>,
    },
    {
      id: 'lastUsed',
      label: 'Last used',
      sortValue: (r) => r.lastUsedAt,
      render: (r) =>
        r.lastUsedAt ? (
          new Date(r.lastUsedAt).toLocaleString()
        ) : (
          <span className="muted">never</span>
        ),
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) =>
        !r.revokedAt && (
          <Button size="sm" variant="danger" onClick={() => revoke(r)}>
            Revoke
          </Button>
        ),
    },
  ];
  const cols = useListColumns('settings-api-keys', columns, rows);

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/settings">Settings</BackLink>}
        title="API keys"
        sub={
          <>
            Send the key as <code>Authorization: Bearer &lt;key&gt;</code>. The key implies the
            business — no <code>X-Business-Id</code> header required. Scopes are checked against the
            platform permission catalog: a key with <code>sales.view</code> can read the sales API
            but not write.{' '}
            <a
              href={`${process.env.NEXT_PUBLIC_API_URL ?? ''}/v1/docs`}
              target="_blank"
              rel="noreferrer"
            >
              API reference →
            </a>
          </>
        }
        actions={
          <Button
            variant={creating ? 'secondary' : 'primary'}
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? 'Cancel' : '+ New API key'}
          </Button>
        }
      />

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        {newKey && (
          <Alert
            tone="warning"
            title="Save this key — it won't be shown again:"
            action={
              <Button size="sm" variant="secondary" onClick={() => setNewKey(null)}>
                Got it
              </Button>
            }
          >
            <code className="block break-all whitespace-pre-wrap">{newKey.key}</code>
          </Alert>
        )}

        {creating && (
          <Card title="New API key" className="form-narrow">
            <form onSubmit={create}>
              <FormGrid cols={2}>
                <Field label="Name" required>
                  <Input name="name" required placeholder="Read-only integration" />
                </Field>
                <Field label="Mode">
                  <Select name="livemode" defaultValue="test">
                    <option value="test">Test (recommended)</option>
                    <option value="live">Live</option>
                  </Select>
                </Field>
                <Field label="Notes (optional)" className="form-span">
                  <Input name="notes" />
                </Field>
                <Field label="Scopes" required className="form-span">
                  <Input
                    type="search"
                    placeholder="Filter… e.g. sales, inventory"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </Field>
                <div className="form-span grid max-h-60 gap-1 overflow-auto rounded-[var(--radius-sm)] border border-[var(--border)] p-2 sm:grid-cols-2">
                  {visibleScopes.length === 0 && (
                    <span className="muted">No scopes match “{filter}”.</span>
                  )}
                  {visibleScopes.map((s) => (
                    <label key={s} className="flex items-center gap-1.5">
                      <input type="checkbox" name="scopes" value={s} />
                      <code>{s}</code>
                    </label>
                  ))}
                </div>
              </FormGrid>
              <FormActions>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create key'}
                </Button>
              </FormActions>
            </form>
          </Card>
        )}

        {rows == null ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState title="No API keys yet">
            Create one to let an integration call the API on this business&apos;s behalf.
          </EmptyState>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="settings-api-keys" />
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
      </Stack>
    </div>
  );
}
