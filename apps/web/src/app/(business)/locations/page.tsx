'use client';

import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { formatPhone } from '@jetnine/shared';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Field,
  FormActions,
  FormGrid,
  Input,
  LoadingRows,
  PageHeader,
  PhoneInput,
  ResetColumns,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';

interface Location {
  id: string;
  name: string;
  /** Q2: 'store' | 'warehouse' — drives transfer gating + replenishment. */
  locationType: string;
  timezone: string;
  taxRateBps: number | null;
  /** J5: weekdays (0=Sun…6=Sat) accepting auto transfers; null = all. */
  replenishmentDays: number[] | null;
  isActive: boolean;
  orderPrefix: string | null;
  /** Street address + phone; prints on every invoice from this store (owner 2026-09-19). */
  addressJson: StoreContact | null;
}

interface StoreContact {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  phone?: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function LocationsPage() {
  const [rows, setRows] = useState<Location[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  async function load() {
    try {
      setRows(await api<Location[]>('/v1/business/locations?includeInactive=true'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const form = e.currentTarget;
    try {
      const data = new FormData(form);
      const taxRaw = String(data.get('taxRateBps') ?? '').trim();
      await api('/v1/business/locations', {
        method: 'POST',
        body: JSON.stringify({
          name: String(data.get('name') ?? ''),
          locationType: String(data.get('locationType') ?? 'store'),
          timezone: String(data.get('timezone') ?? ''),
          taxRateBps: taxRaw ? Number(taxRaw) : null,
          orderPrefix:
            String(data.get('orderPrefix') ?? '')
              .trim()
              .toUpperCase() || null,
        }),
      });
      form.reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function toggle(loc: Location) {
    try {
      await api(`/v1/business/locations/${loc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !loc.isActive }),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Toggle one weekday in the location's replenishment set. null (all
   * days) materializes to the full set first so unchecking one day
   * keeps the other six.
   */
  async function toggleDay(loc: Location, day: number) {
    const current = loc.replenishmentDays ?? [0, 1, 2, 3, 4, 5, 6];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    try {
      await api(`/v1/business/locations/${loc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ replenishmentDays: next.length === 7 ? null : next.sort() }),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleType(loc: Location) {
    const next = loc.locationType === 'warehouse' ? 'store' : 'warehouse';
    try {
      await api(`/v1/business/locations/${loc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ locationType: next }),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(loc: Location) {
    if (
      !window.confirm(
        `Delete "${loc.name}" permanently? Only possible while nothing references it.`,
      )
    )
      return;
    try {
      await api(`/v1/business/locations/${loc.id}`, { method: 'DELETE' });
      toast.success(`Deleted "${loc.name}"`);
      await load();
    } catch (err) {
      // 409 = has history; the server message says what references it.
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Type, replenishment days and the actions all toggle through the
  // handlers above, so the columns are built here.
  const columns: ColumnDef<Location>[] = [
    {
      id: 'name',
      label: 'Name',
      sortValue: (l) => l.name,
      render: (l) => <strong>{l.name}</strong>,
    },
    {
      id: 'type',
      label: 'Type',
      sortValue: (l) => l.locationType,
      render: (l) => (
        <button
          type="button"
          className={`badge cursor-pointer border-0 ${
            l.locationType === 'warehouse' ? 'badge-info' : 'badge-neutral'
          }`}
          title="Click to switch between store and warehouse"
          onClick={() => void toggleType(l)}
        >
          {l.locationType}
        </button>
      ),
    },
    { id: 'timezone', label: 'Timezone', sortValue: (l) => l.timezone, render: (l) => l.timezone },
    {
      id: 'orderPrefix',
      label: 'Order prefix',
      sortValue: (l) => l.orderPrefix ?? '',
      render: (l) => <OrderPrefix key={`${l.id}:${l.orderPrefix}`} location={l} onSaved={load} />,
    },
    {
      id: 'contact',
      label: 'Address & phone',
      title: 'Prints on every invoice written at this store',
      sortValue: (l) => l.addressJson?.line1 ?? '',
      render: (l) => (
        <StoreContactEditor
          key={`${l.id}:${JSON.stringify(l.addressJson ?? {})}`}
          location={l}
          onSaved={load}
        />
      ),
    },
    {
      id: 'tax',
      label: 'Tax',
      num: true,
      sortValue: (l) => l.taxRateBps,
      render: (l) => (l.taxRateBps != null ? `${(l.taxRateBps / 100).toFixed(2)}%` : 'inherit'),
    },
    {
      id: 'replenishment',
      label: 'Replenishment days',
      title: 'Weekdays this store accepts auto replenishment transfers',
      sortValue: (l) => (l.replenishmentDays ?? [0, 1, 2, 3, 4, 5, 6]).length,
      render: (l) => (
        <div className="flex gap-1">
          {WEEKDAYS.map((label, day) => {
            const on = (l.replenishmentDays ?? [0, 1, 2, 3, 4, 5, 6]).includes(day);
            return (
              <button
                key={label}
                type="button"
                className={`badge cursor-pointer border-0 ${on ? 'badge-success' : 'badge-neutral'}`}
                aria-pressed={on}
                title={on ? `Accepts auto transfers on ${label}` : `No auto transfers on ${label}`}
                onClick={() => void toggleDay(l, day)}
              >
                {label[0]}
              </button>
            );
          })}
        </div>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (l) => (l.isActive ? 'active' : 'inactive'),
      render: (l) => <StatusBadge status={l.isActive ? 'active' : 'inactive'} />,
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (l) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => toggle(l)}>
            {l.isActive ? 'Deactivate' : 'Activate'}
          </Button>
          {!l.isActive && (
            <Button size="sm" variant="danger" onClick={() => void remove(l)}>
              Delete
            </Button>
          )}
        </>
      ),
    },
  ];
  const cols = useListColumns(
    'locations',
    columns,
    rows?.filter((l) => showInactive || l.isActive) ?? null,
  );

  return (
    <div>
      <PageHeader
        title="Locations"
        sub="Stores and warehouses. Type drives transfer gating and replenishment; tax overrides the business default."
      />
      <Stack>
        <Card title="Add location">
          <form onSubmit={submit}>
            <FormGrid cols={3}>
              <Field label="Name" required>
                <Input name="name" required />
              </Field>
              <Field label="Type">
                <Select name="locationType" defaultValue="store">
                  <option value="store">Store</option>
                  <option value="warehouse">Warehouse</option>
                </Select>
              </Field>
              <Field label="Timezone" required>
                <Input name="timezone" defaultValue="America/Los_Angeles" required />
              </Field>
              <Field label="Tax override (bps)" hint="Blank = inherit the business tax rate.">
                <Input name="taxRateBps" type="number" min={0} />
              </Field>
              <Field label="Order prefix" hint="1–4 letters. New orders use this store's sequence.">
                <Input name="orderPrefix" maxLength={4} pattern="[A-Za-z]{1,4}" />
              </Field>
            </FormGrid>
            <FormActions>
              <Button type="submit" variant="primary" disabled={creating}>
                <Plus size={14} aria-hidden />
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </FormActions>
          </form>
        </Card>
        {error && <Alert tone="error">{error}</Alert>}
        {!rows && !error && (
          <Card>
            <LoadingRows />
          </Card>
        )}
        {rows && (
          <Card flush>
            <label className="flex items-center gap-2 p-4 text-sm">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Show inactive locations
            </label>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="locations" />
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>
                      No locations yet. Add the first one above.
                    </TableEmpty>
                  )}
                  {cols.sorted.map((l) => (
                    <tr key={l.id}>
                      <ColumnCells list={cols} row={l} />
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

/**
 * Owner 2026-09-19: the invoice header carries the selling store's
 * address and phone. Edited inline, saved as locations.address_json in
 * the same shape the documents read (line1/line2/city/region/postalCode/
 * phone).
 */
function StoreContactEditor({
  location,
  onSaved,
}: {
  location: Location;
  onSaved: () => Promise<void>;
}) {
  const initial = location.addressJson ?? {};
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<StoreContact>({
    line1: initial.line1 ?? '',
    line2: initial.line2 ?? '',
    city: initial.city ?? '',
    region: initial.region ?? '',
    postalCode: initial.postalCode ?? '',
    phone: initial.phone ?? '',
  });
  const [saving, setSaving] = useState(false);
  const summary = [initial.line1, initial.city].filter(Boolean).join(', ');
  const set = (k: keyof StoreContact) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    try {
      const trimmed = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, (v ?? '').trim()]),
      ) as StoreContact;
      const hasAny = Object.values(trimmed).some(Boolean);
      await api(`/v1/business/locations/${location.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ addressJson: hasAny ? { ...initial, ...trimmed } : null }),
      });
      await onSaved();
      setOpen(false);
      toast.success(`Address and phone saved for ${location.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="link text-left"
        onClick={() => setOpen(true)}
        data-testid="location-contact"
      >
        {summary ? (
          <>
            <div>{summary}</div>
            {initial.phone && <div className="muted mono">{formatPhone(initial.phone)}</div>}
          </>
        ) : (
          <span className="muted">Add address & phone</span>
        )}
      </button>
    );
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-1" style={{ minWidth: 260 }}>
      <Input placeholder="Street" value={form.line1} onChange={set('line1')} aria-label="Street" />
      <Input
        placeholder="Suite / unit"
        value={form.line2}
        onChange={set('line2')}
        aria-label="Suite"
      />
      <div className="flex gap-1">
        <Input placeholder="City" value={form.city} onChange={set('city')} aria-label="City" />
        <Input
          placeholder="ST"
          value={form.region}
          onChange={set('region')}
          aria-label="State"
          style={{ width: 56 }}
        />
        <Input
          placeholder="ZIP"
          value={form.postalCode}
          onChange={set('postalCode')}
          aria-label="ZIP"
          style={{ width: 84 }}
        />
      </div>
      <PhoneInput
        placeholder="Phone"
        value={form.phone ?? ''}
        onChange={set('phone')}
        aria-label="Phone"
      />
      <div className="flex gap-1">
        <Button type="submit" size="sm" variant="primary" disabled={saving}>
          Save
        </Button>
        <Button type="button" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function OrderPrefix({ location, onSaved }: { location: Location; onSaved: () => Promise<void> }) {
  const [prefix, setPrefix] = useState(location.orderPrefix ?? '');
  const [saving, setSaving] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    try {
      await api(`/v1/business/locations/${location.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ orderPrefix: prefix.trim().toUpperCase() || null }),
      });
      await onSaved();
      toast.success(`Order prefix saved for ${location.name}. Existing orders keep their numbers.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={save} className="flex items-center gap-2">
      <Input
        aria-label={`Order prefix for ${location.name}`}
        value={prefix}
        onChange={(e) => setPrefix(e.target.value.toUpperCase())}
        maxLength={4}
        pattern="[A-Za-z]{1,4}"
        className="w-20"
        placeholder="SO"
      />
      <Button size="sm" type="submit" disabled={saving || prefix === (location.orderPrefix ?? '')}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}
