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
  Select,
  Stack,
  StatusBadge,
  TableWrap,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';
import { Money } from '@/components/money';

interface DiscountCode {
  id: string;
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  description: string | null;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  usageCount: number;
  perCustomerLimit: number | null;
  minSubtotalCents: number | null;
}

export default function DiscountsPage() {
  const [rows, setRows] = useState<DiscountCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [kind, setKind] = useState<'percent' | 'fixed'>('percent');

  async function load() {
    setError(null);
    try {
      setRows(await api<DiscountCode[]>('/v1/business/discount-codes'));
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
      const valueRaw = String(data.get('value') ?? '');
      const value =
        kind === 'percent'
          ? Math.round(Number(valueRaw) * 100) // % → basis points
          : Math.round(Number(valueRaw) * 100); // $ → cents
      await api('/v1/business/discount-codes', {
        method: 'POST',
        body: JSON.stringify({
          code: String(data.get('code') ?? '').toUpperCase(),
          kind,
          value,
          description: String(data.get('description') ?? '') || null,
          startsAt: String(data.get('startsAt') ?? '') || null,
          endsAt: String(data.get('endsAt') ?? '') || null,
          usageLimit: parseLimit(data.get('usageLimit')),
          perCustomerLimit: parseLimit(data.get('perCustomerLimit')),
          minSubtotalCents: parseDollarsOrNull(data.get('minSubtotal')),
        }),
      });
      form.reset();
      setKind('percent');
      setCreating(false);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(row: DiscountCode) {
    try {
      await api(`/v1/business/discount-codes/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !row.isActive }),
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function destroy(row: DiscountCode) {
    const message =
      row.usageCount > 0
        ? `Delete "${row.code}"? ${row.usageCount} prior redemption(s) will be removed too. Toggling Inactive instead keeps history.`
        : `Delete "${row.code}"?`;
    if (!confirm(message)) return;
    try {
      await api(`/v1/business/discount-codes/${row.id}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Built inline: the actions cell needs `toggleActive` and `destroy`.
  const columns: ColumnDef<DiscountCode>[] = [
    {
      id: 'code',
      label: 'Code',
      sortValue: (r) => r.code,
      render: (r) => (
        <>
          <code>{r.code}</code>
          {r.description && <div className="muted">{r.description}</div>}
        </>
      ),
    },
    {
      id: 'discount',
      label: 'Discount',
      // Percent codes sort before fixed ones; within a kind, by value.
      sortValue: (r) => (r.kind === 'percent' ? r.value : 1_000_000_000 + r.value),
      render: (r) => (
        <>
          {r.kind === 'percent' ? `${(r.value / 100).toFixed(2)}%` : <Money cents={r.value} />}
          {r.minSubtotalCents != null && (
            <div className="muted">
              min <Money cents={r.minSubtotalCents} />
            </div>
          )}
        </>
      ),
    },
    {
      id: 'window',
      label: 'Window',
      className: 'nowrap',
      sortValue: (r) => r.startsAt,
      render: (r) => (
        <>
          {r.startsAt ? new Date(r.startsAt).toLocaleDateString() : '—'} →{' '}
          {r.endsAt ? new Date(r.endsAt).toLocaleDateString() : '∞'}
        </>
      ),
    },
    {
      id: 'used',
      label: 'Used',
      num: true,
      sortValue: (r) => r.usageCount,
      render: (r) => (
        <>
          {r.usageCount}
          {r.usageLimit != null && ` / ${r.usageLimit}`}
          {r.perCustomerLimit != null && <div className="muted">{r.perCustomerLimit}/customer</div>}
        </>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (r) => (r.isActive ? 'active' : 'inactive'),
      render: (r) => <StatusBadge status={r.isActive ? 'active' : 'inactive'} />,
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => toggleActive(r)}>
            {r.isActive ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" variant="danger" onClick={() => destroy(r)}>
            Delete
          </Button>
        </>
      ),
    },
  ];
  const cols = useListColumns('settings-discounts', columns, rows);

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/settings">Settings</BackLink>}
        title="Discount codes"
        sub="Codes apply at the POS as an order-level discount. Cashiers enter the code on the payment screen; the system validates window, limits, and minimum subtotal before the sale completes."
        actions={
          <Button
            variant={creating ? 'secondary' : 'primary'}
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? 'Cancel' : '+ New code'}
          </Button>
        }
      />

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        {creating && (
          <Card title="New discount code" className="form-narrow">
            <form onSubmit={create}>
              <FormGrid cols={2}>
                <Field label="Code" required>
                  <Input name="code" required placeholder="SAVE15" className="uppercase" />
                </Field>
                <Field label="Kind" required>
                  <Select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as 'percent' | 'fixed')}
                  >
                    <option value="percent">% off</option>
                    <option value="fixed">$ off</option>
                  </Select>
                </Field>
                <Field
                  label={kind === 'percent' ? 'Percent (e.g. 15 = 15%)' : 'Amount in dollars'}
                  required
                >
                  <Input name="value" type="number" step="0.01" min={0.01} required />
                </Field>
                <Field label="Description (optional)">
                  <Input name="description" />
                </Field>
                <Field label="Starts (optional)">
                  <Input name="startsAt" type="datetime-local" />
                </Field>
                <Field label="Ends (optional)">
                  <Input name="endsAt" type="datetime-local" />
                </Field>
                <FormGrid cols={3} className="form-span">
                  <Field label="Total uses (optional)">
                    <Input name="usageLimit" type="number" min={1} />
                  </Field>
                  <Field label="Uses per customer (optional)">
                    <Input name="perCustomerLimit" type="number" min={1} />
                  </Field>
                  <Field label="Min subtotal $ (optional)">
                    <Input name="minSubtotal" type="number" step="0.01" min={0} />
                  </Field>
                </FormGrid>
              </FormGrid>
              <FormActions>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create code'}
                </Button>
              </FormActions>
            </form>
          </Card>
        )}

        {rows == null ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState title="No discount codes yet">
            Create a code and cashiers can apply it on the payment screen.
          </EmptyState>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="settings-discounts" />
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

function parseLimit(raw: FormDataEntryValue | null): number | null {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function parseDollarsOrNull(raw: FormDataEntryValue | null): number | null {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
