'use client';

import { useEffect, useState, type FormEvent, useRef } from 'react';
import { api } from '@/lib/api';
import {
  Alert,
  Button,
  Card,
  Field,
  FormActions,
  FormGrid,
  Input,
  TableEmpty,
  TableWrap,
  Toolbar,
  useFocusTrap,
  rowKeys,
} from '@/components/ui';

/**
 * Customer search-or-create modal, shared by the POS register and the
 * order writer. Extracted from pos/page.tsx on Day 2 of the STORIS
 * cutover so both surfaces attach customers through the same flow.
 */

export interface CustomerRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}

export function customerDisplayName(c: CustomerRow): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)';
}

export function CustomerPicker({
  onPick,
  onCancel,
}: {
  onPick: (c: CustomerRow) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    try {
      const res = await api<{ data: CustomerRow[]; nextCursor: string | null }>(
        `/v1/customers?q=${encodeURIComponent(q)}`,
      );
      setRows(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createNew(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const data = new FormData(e.currentTarget);
      const created = await api<CustomerRow>('/v1/customers', {
        method: 'POST',
        body: JSON.stringify({
          firstName: data.get('firstName') || null,
          lastName: data.get('lastName') || null,
          email: data.get('email') || null,
          phone: data.get('phone') || null,
        }),
      });
      onPick(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // Focus stays inside and returns to the opener (Phase 12).
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, { onClose: onCancel });

  return (
    // Modal chrome: the backdrop/panel positioning stays inline (structural,
    // not styling); the focus trap is the shared hook.
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Attach customer"
        className="w-[min(480px,92vw)]"
        onClick={(e) => e.stopPropagation()}
      >
        <Card
          title="Attach customer"
          actions={
            <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close">
              ✕
            </Button>
          }
        >
          {creating ? (
            <form onSubmit={createNew}>
              <FormGrid cols={2}>
                <Field label="First name">
                  <Input name="firstName" autoFocus />
                </Field>
                <Field label="Last name">
                  <Input name="lastName" />
                </Field>
                <Field label="Email">
                  <Input name="email" type="email" />
                </Field>
                <Field label="Phone">
                  <Input name="phone" type="tel" />
                </Field>
              </FormGrid>
              {error && <Alert tone="error">{error}</Alert>}
              <FormActions>
                <Button variant="secondary" onClick={() => setCreating(false)} disabled={saving}>
                  Back
                </Button>
                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? 'Creating…' : 'Create & attach'}
                </Button>
              </FormActions>
            </form>
          ) : (
            <>
              <Toolbar>
                <Input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void search();
                  }}
                  placeholder="Search by name, email, or phone"
                  aria-label="Search customers"
                />
                <Button size="sm" variant="secondary" onClick={search} disabled={searching}>
                  {searching ? 'Searching…' : 'Search'}
                </Button>
              </Toolbar>
              {error && <Alert tone="error">{error}</Alert>}
              <TableWrap maxHeight={240}>
                <table className="table table-dense table-sticky">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Contact</th>
                      <th className="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <TableEmpty colSpan={3}>
                        {searching ? 'Searching…' : 'No matches.'}
                      </TableEmpty>
                    )}
                    {rows.map((c) => (
                      <tr
                        {...rowKeys}
                        key={c.id}
                        onClick={() => onPick(c)}
                        className="cursor-pointer"
                      >
                        <td>
                          <strong>{customerDisplayName(c)}</strong>
                        </td>
                        <td className="muted">{c.email ?? c.phone ?? '—'}</td>
                        <td className="actions">
                          <Button size="sm" variant="secondary" onClick={() => onPick(c)}>
                            Attach
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <FormActions
                start={
                  <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
                    + New customer
                  </Button>
                }
              >
                <Button variant="secondary" onClick={onCancel}>
                  Cancel
                </Button>
              </FormActions>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
