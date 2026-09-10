'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  Stack,
  StatusBadge,
  TableWrap,
} from '@/components/ui';

interface Vendor {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  stats: {
    productsCarried: number;
    inStockProducts: number;
    inStockUnits: number;
    onPoUnits: number;
    openPos: number;
  };
}

/** A count that opens the page filtered to this vendor (owner 2026-09-02). */
function CountLink({
  n,
  href,
  sub,
  testid,
}: {
  n: number;
  href: string;
  sub?: string;
  testid: string;
}) {
  if (n === 0) {
    return (
      <span className="muted" data-testid={testid}>
        0
      </span>
    );
  }
  return (
    <Link href={href} data-testid={testid} className="font-semibold">
      {n}
      {sub && <span className="muted font-normal"> {sub}</span>}
    </Link>
  );
}

export default function VendorsPage() {
  const [rows, setRows] = useState<Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      setRows(await api<Vendor[]>('/v1/vendors'));
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
    // React nulls the synthetic event's currentTarget once the handler
    // yields — grab the form element before any await or reset() throws.
    const form = e.currentTarget;
    setSaving(true);
    try {
      const data = new FormData(form);
      await api('/v1/vendors', {
        method: 'POST',
        body: JSON.stringify({
          name: String(data.get('name') ?? ''),
          contactName: String(data.get('contactName') ?? '') || null,
          email: String(data.get('email') ?? '') || null,
          phone: String(data.get('phone') ?? '') || null,
          notes: String(data.get('notes') ?? '') || null,
        }),
      });
      form.reset();
      setCreating(false);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function destroy(id: string) {
    if (!confirm('Delete this vendor?')) return;
    try {
      await api(`/v1/vendors/${id}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <PageHeader
        title="Vendors"
        actions={
          <>
            <LinkButton size="sm" variant="secondary" href="/purchase-orders">
              Purchase orders
            </LinkButton>
            <Button
              variant={creating ? 'secondary' : 'primary'}
              onClick={() => setCreating((v) => !v)}
            >
              {creating ? 'Cancel' : '+ New vendor'}
            </Button>
          </>
        }
      />

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        {creating && (
          <Card title="New vendor" className="form-narrow">
            <form onSubmit={create}>
              <FormGrid cols={2}>
                <Field label="Name" required className="form-span">
                  <Input name="name" required />
                </Field>
                <Field label="Contact name">
                  <Input name="contactName" />
                </Field>
                <Field label="Email">
                  <Input name="email" type="email" />
                </Field>
                <Field label="Phone">
                  <Input name="phone" type="tel" />
                </Field>
                <Field label="Notes" className="form-span">
                  <textarea className="textarea" name="notes" rows={2} />
                </Field>
              </FormGrid>
              <FormActions>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setCreating(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={saving}>
                  <Plus size={14} aria-hidden />
                  {saving ? 'Creating…' : 'Create vendor'}
                </Button>
              </FormActions>
            </form>
          </Card>
        )}

        {rows == null ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No vendors yet"
            action={
              !creating ? (
                <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
                  + New vendor
                </Button>
              ) : undefined
            }
          >
            Add a vendor to start placing purchase orders.
          </EmptyState>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Contact</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th className="num">Products</th>
                    <th className="num">In inventory</th>
                    <th className="num">On PO</th>
                    <th>Status</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <Link
                          href={`/vendors/${v.id}/settings`}
                          className="font-bold"
                          data-testid="vendor-settings-link"
                        >
                          {v.name}
                        </Link>
                      </td>
                      <td>{v.contactName ?? '—'}</td>
                      <td>{v.email ?? '—'}</td>
                      <td>{v.phone ?? '—'}</td>
                      <td className="num">
                        <CountLink
                          n={v.stats.productsCarried}
                          href={`/products?vendorId=${v.id}&vendor=${encodeURIComponent(v.name)}`}
                          testid="vendor-products"
                        />
                      </td>
                      <td className="num">
                        <CountLink
                          n={v.stats.inStockProducts}
                          sub={`· ${v.stats.inStockUnits} units`}
                          href={`/products/stock?vendorId=${v.id}&vendor=${encodeURIComponent(v.name)}&locationId=all`}
                          testid="vendor-in-stock"
                        />
                      </td>
                      <td className="num">
                        <CountLink
                          n={v.stats.onPoUnits}
                          sub={`· ${v.stats.openPos} PO${v.stats.openPos === 1 ? '' : 's'}`}
                          href={`/purchase-orders?vendorId=${v.id}&vendor=${encodeURIComponent(v.name)}`}
                          testid="vendor-on-po"
                        />
                      </td>
                      <td>
                        <StatusBadge status={v.isActive ? 'active' : 'inactive'} />
                      </td>
                      <td className="actions">
                        <LinkButton
                          size="sm"
                          variant="secondary"
                          href={`/vendors/${v.id}/settings`}
                        >
                          Settings
                        </LinkButton>
                        <Button size="sm" variant="danger" onClick={() => destroy(v.id)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        )}
      </Stack>
    </div>
  );
}
