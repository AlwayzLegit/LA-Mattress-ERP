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
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Stack,
  StatusBadge,
  TableWrap,
  useListColumns,
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

  // The actions cell calls `destroy`, so the columns are built here.
  const columns: ColumnDef<Vendor>[] = [
    {
      id: 'name',
      label: 'Name',
      sortValue: (v) => v.name,
      render: (v) => (
        <Link
          href={`/vendors/${v.id}/settings`}
          className="font-bold"
          data-testid="vendor-settings-link"
        >
          {v.name}
        </Link>
      ),
    },
    {
      id: 'contact',
      label: 'Contact',
      sortValue: (v) => v.contactName,
      render: (v) => v.contactName ?? '—',
    },
    { id: 'email', label: 'Email', sortValue: (v) => v.email, render: (v) => v.email ?? '—' },
    { id: 'phone', label: 'Phone', sortValue: (v) => v.phone, render: (v) => v.phone ?? '—' },
    {
      id: 'products',
      label: 'Products',
      num: true,
      sortValue: (v) => v.stats.productsCarried,
      render: (v) => (
        <CountLink
          n={v.stats.productsCarried}
          href={`/products?vendorId=${v.id}&vendor=${encodeURIComponent(v.name)}`}
          testid="vendor-products"
        />
      ),
    },
    {
      id: 'inStock',
      label: 'In inventory',
      num: true,
      sortValue: (v) => v.stats.inStockProducts,
      render: (v) => (
        <CountLink
          n={v.stats.inStockProducts}
          sub={`· ${v.stats.inStockUnits} units`}
          href={`/products/stock?vendorId=${v.id}&vendor=${encodeURIComponent(v.name)}&locationId=all`}
          testid="vendor-in-stock"
        />
      ),
    },
    {
      id: 'onPo',
      label: 'On PO',
      num: true,
      sortValue: (v) => v.stats.onPoUnits,
      render: (v) => (
        <CountLink
          n={v.stats.onPoUnits}
          sub={`· ${v.stats.openPos} PO${v.stats.openPos === 1 ? '' : 's'}`}
          href={`/purchase-orders?vendorId=${v.id}&vendor=${encodeURIComponent(v.name)}`}
          testid="vendor-on-po"
        />
      ),
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (v) => (v.isActive ? 'active' : 'inactive'),
      render: (v) => <StatusBadge status={v.isActive ? 'active' : 'inactive'} />,
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (v) => (
        <>
          <LinkButton size="sm" variant="secondary" href={`/vendors/${v.id}/settings`}>
            Settings
          </LinkButton>
          <Button size="sm" variant="danger" onClick={() => destroy(v.id)}>
            Delete
          </Button>
        </>
      ),
    },
  ];
  const cols = useListColumns('vendors', columns, rows);

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
                  <ColumnHeadRow list={cols} testIdPrefix="vendors" />
                </thead>
                <tbody>
                  {cols.sorted.map((v) => (
                    <tr key={v.id}>
                      <ColumnCells list={cols} row={v} />
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
