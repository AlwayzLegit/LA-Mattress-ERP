'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingRows,
  PageHeader,
  PhoneInput,
  Select,
} from '@/components/ui';

/**
 * Advanced Vendor Settings (owner 2026-09-02, STORIS): four tabs —
 * General (vendor master + stock/lead days), Shipping (landed-cost
 * lines), PO Cutting Date (collection exceptions) and Auto PO Replen
 * (the sales-rate replenishment document). Each tab saves on its own.
 */

type LandedCostType = 'percent' | 'dollar' | 'calculate';
interface LandedCostLine {
  active: boolean;
  type: LandedCostType;
  percent: number | null;
  cents: number | null;
  label: string | null;
}
interface Shipping {
  freight: LandedCostLine;
  importFee: LandedCostLine;
  miscFee: LandedCostLine;
  custom: [LandedCostLine, LandedCostLine];
}
interface CuttingRow {
  id?: string;
  collectionId: string;
  collectionName: string;
  cuttingDate: string;
  notes: string | null;
}
interface Replenishment {
  generateAutomaticPos: boolean;
  automaticallyHoldPos: boolean;
  weeklySalesRateWeeks: number;
  includeAllBackOrders: boolean;
  daysForReplenishment: number | null;
  minimumStockDays: number;
  leadDays: number;
  variancePercent: number;
  varianceStart?: string | null;
  varianceEnd?: string | null;
  minimumSalesRate: number;
  buildDays: number[];
  defaultRequestedDate?: 'vendor_lead_days' | 'today';
  firstAverageUnitsPeriodWeeks?: number;
  secondAverageUnitsPeriodWeeks?: number;
  sortCriteria?: 'vendor_model' | 'product' | 'category' | 'group';
}
interface Vendor {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  remitTo: string | null;
  notes: string | null;
  isActive: boolean;
}
interface Advanced {
  vendor: Vendor;
  shipping: Shipping;
  poCuttingDates: CuttingRow[];
  replenishment: Replenishment | null;
  collections: { id: string; name: string; vendorId: string | null }[];
}

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'cutting', label: 'PO Cutting Date' },
  { key: 'replen', label: 'Auto PO Replen' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 13, 16, 26, 52];

const DEFAULT_REPLEN: Replenishment = {
  generateAutomaticPos: false,
  automaticallyHoldPos: true,
  weeklySalesRateWeeks: 4,
  includeAllBackOrders: false,
  daysForReplenishment: 10,
  minimumStockDays: 14,
  leadDays: 21,
  variancePercent: 100,
  varianceStart: null,
  varianceEnd: null,
  minimumSalesRate: 0,
  buildDays: [],
  defaultRequestedDate: 'vendor_lead_days',
  firstAverageUnitsPeriodWeeks: 4,
  secondAverageUnitsPeriodWeeks: 12,
  sortCriteria: 'vendor_model',
};

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function VendorSettingsPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [data, setData] = useState<Advanced | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('general');

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('tab');
    if (initial && TABS.some((t) => t.key === initial)) setTab(initial as TabKey);
  }, []);

  useEffect(() => {
    if (!id) return;
    api<Advanced>(`/v1/vendors/${id}/advanced-settings`)
      .then(setData)
      .catch((err) => setError(errMsg(err)));
  }, [id]);

  function pick(next: TabKey) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url.toString());
  }

  return (
    <div data-testid="vendor-settings">
      <p style={{ margin: '0 0 12px' }}>
        <Link href="/vendors">← Vendors</Link>
      </p>
      <PageHeader
        title="Advanced Vendor Settings"
        sub={
          data ? (
            <>
              Vendor code <code>{data.vendor.id.slice(0, 8).toUpperCase()}</code> ·{' '}
              <strong data-testid="vendor-settings-name">{data.vendor.name}</strong>
            </>
          ) : (
            'Loading vendor…'
          )
        }
      />
      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 13 }} role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      )}
      {data && (
        <>
          <nav
            aria-label="Vendor settings tabs"
            className="mb-4 flex flex-wrap gap-1 border-b"
            style={{ borderColor: 'var(--border)' }}
          >
            {TABS.map((t) => {
              const active = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => pick(t.key)}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`vendor-tab-${t.key}`}
                  className="cursor-pointer border-0 bg-transparent px-3.5 py-2 text-sm"
                  style={{
                    borderBottom: active ? '2px solid var(--brand)' : '2px solid transparent',
                    fontWeight: active ? 700 : 500,
                    marginBottom: -1,
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>
          {tab === 'general' && (
            <GeneralTab
              vendor={data.vendor}
              replenishment={data.replenishment}
              onSaved={(v) => setData((d) => (d ? { ...d, vendor: v } : d))}
              onReplenSaved={(r) => setData((d) => (d ? { ...d, replenishment: r } : d))}
            />
          )}
          {tab === 'shipping' && (
            <ShippingTab
              vendorId={id}
              shipping={data.shipping}
              onSaved={(s) => setData((d) => (d ? { ...d, shipping: s } : d))}
            />
          )}
          {tab === 'cutting' && (
            <CuttingTab
              vendorId={id}
              rows={data.poCuttingDates}
              collections={data.collections}
              onSaved={(rows) => setData((d) => (d ? { ...d, poCuttingDates: rows } : d))}
            />
          )}
          {tab === 'replen' && (
            <ReplenTab
              vendorId={id}
              settings={data.replenishment}
              onSaved={(r) => setData((d) => (d ? { ...d, replenishment: r } : d))}
            />
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- General */

function GeneralTab({
  vendor,
  replenishment,
  onSaved,
  onReplenSaved,
}: {
  vendor: Vendor;
  replenishment: Replenishment | null;
  onSaved: (v: Vendor) => void;
  onReplenSaved: (r: Replenishment | null) => void;
}) {
  const [form, setForm] = useState(vendor);
  const [days, setDays] = useState({
    minimumStockDays: replenishment?.minimumStockDays ?? DEFAULT_REPLEN.minimumStockDays,
    leadDays: replenishment?.leadDays ?? DEFAULT_REPLEN.leadDays,
    defaultRequestedDate: replenishment?.defaultRequestedDate ?? 'vendor_lead_days',
  });
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(vendor), [vendor]);

  async function save() {
    setSaving(true);
    try {
      const v = await api<Vendor>(`/v1/vendors/${vendor.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.name,
          contactName: form.contactName,
          email: form.email,
          phone: form.phone,
          remitTo: form.remitTo,
          notes: form.notes,
          isActive: form.isActive,
        }),
      });
      onSaved(v);
      const r = await api<{ settings: Replenishment | null }>(
        `/v1/purchasing/replenishment/vendors/${vendor.id}/settings`,
        {
          method: 'PATCH',
          body: JSON.stringify({ ...(replenishment ?? DEFAULT_REPLEN), ...days }),
        },
      );
      onReplenSaved(r.settings);
      toast.success('Vendor saved');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  const text = (key: keyof Vendor, label: string, type = 'text') => (
    <Field label={label}>
      <Input
        type={type}
        value={(form[key] as string | null) ?? ''}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value || null }))}
        style={{ width: '100%' }}
        data-testid={`vendor-${key}`}
      />
    </Field>
  );

  return (
    <Card title="General" data-testid="vendor-general">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="grid gap-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vendor name *">
            <Input
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              style={{ width: '100%' }}
              data-testid="vendor-name"
            />
          </Field>
          {text('contactName', 'Contact name')}
          {text('email', 'Email', 'email')}
          <Field label="Phone">
            <PhoneInput
              value={form.phone ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value || null }))}
              style={{ width: '100%' }}
              data-testid="vendor-phone"
            />
          </Field>
          {text('remitTo', 'Remit-to (payments go here)')}
          <Field label="Status">
            <Select
              value={form.isActive ? 'active' : 'inactive'}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === 'active' }))}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            className="textarea"
            rows={2}
            value={form.notes ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value || null }))}
            style={{ width: '100%', resize: 'vertical' }}
          />
        </Field>
        <h3 className="m-0 text-sm font-semibold">Purchasing defaults</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Minimum stock days">
            <Input
              type="number"
              min={0}
              max={999}
              value={String(days.minimumStockDays)}
              onChange={(e) => setDays((d) => ({ ...d, minimumStockDays: Number(e.target.value) }))}
            />
          </Field>
          <Field label="Lead days">
            <Input
              type="number"
              min={0}
              max={999}
              value={String(days.leadDays)}
              onChange={(e) => setDays((d) => ({ ...d, leadDays: Number(e.target.value) }))}
            />
          </Field>
          <Field label="Default requested date on POs">
            <Select
              value={days.defaultRequestedDate}
              onChange={(e) =>
                setDays((d) => ({
                  ...d,
                  defaultRequestedDate: e.target.value === 'today' ? 'today' : 'vendor_lead_days',
                }))
              }
            >
              <option value="vendor_lead_days">Vendor lead days</option>
              <option value="today">Today&apos;s date</option>
            </Select>
          </Field>
        </div>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={saving}
            data-testid="vendor-general-save"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* --------------------------------------------------------------- Shipping */

function ShippingTab({
  vendorId,
  shipping,
  onSaved,
}: {
  vendorId: string;
  shipping: Shipping;
  onSaved: (s: Shipping) => void;
}) {
  const [form, setForm] = useState<Shipping>(shipping);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(shipping), [shipping]);

  async function save() {
    setSaving(true);
    try {
      const res = await api<{ shipping: Shipping }>(`/v1/vendors/${vendorId}/shipping`, {
        method: 'PATCH',
        body: JSON.stringify(form),
      });
      onSaved(res.shipping);
      toast.success('Shipping settings saved');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  const lines: {
    key: string;
    title: string;
    line: LandedCostLine;
    allowCalculate: boolean;
    custom?: 0 | 1;
  }[] = [
    { key: 'freight', title: 'Landed Freight Active', line: form.freight, allowCalculate: false },
    {
      key: 'importFee',
      title: 'Import Fee - Landed Cost Active',
      line: form.importFee,
      allowCalculate: true,
    },
    {
      key: 'miscFee',
      title: 'Misc. Fee - Landed Cost Active',
      line: form.miscFee,
      allowCalculate: true,
    },
    {
      key: 'custom0',
      title: 'Landed Cost Active',
      line: form.custom[0],
      allowCalculate: true,
      custom: 0,
    },
    {
      key: 'custom1',
      title: 'Landed Cost Active',
      line: form.custom[1],
      allowCalculate: true,
      custom: 1,
    },
  ];

  function update(entry: (typeof lines)[number], patch: Partial<LandedCostLine>) {
    setForm((f) => {
      if (entry.custom !== undefined) {
        const custom: [LandedCostLine, LandedCostLine] = [f.custom[0], f.custom[1]];
        custom[entry.custom] = { ...custom[entry.custom], ...patch };
        return { ...f, custom };
      }
      const k = entry.key as 'freight' | 'importFee' | 'miscFee';
      return { ...f, [k]: { ...f[k], ...patch } };
    });
  }

  return (
    <Card title="Shipping — landed cost" data-testid="vendor-shipping">
      <p className="mb-3 text-sm text-muted">
        Active percent and dollar lines are added up into a new purchase order&apos;s freight
        (spread per unit into landed cost at receipt). &quot;Calculate&quot; lines are entered from
        the vendor invoice.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="grid gap-3"
      >
        {lines.map((entry) => (
          <div
            key={entry.key}
            className="grid items-center gap-3 rounded border p-3 md:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1fr)_auto]"
            style={{ borderColor: 'var(--border)' }}
            data-testid={`landed-${entry.key}`}
          >
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={entry.line.active}
                onChange={(e) => update(entry, { active: e.target.checked })}
                data-testid={`landed-${entry.key}-active`}
              />
              {entry.custom !== undefined ? (
                <Input
                  placeholder="Fee name"
                  value={entry.line.label ?? ''}
                  onChange={(e) => update(entry, { label: e.target.value || null })}
                  style={{ maxWidth: 200 }}
                  aria-label={`Custom landed cost ${entry.custom + 1} label`}
                />
              ) : null}
              <span>{entry.title}</span>
            </label>
            <span className="text-sm text-muted">Cost</span>
            {entry.line.type === 'calculate' ? (
              <span className="text-sm text-muted">Entered from the vendor invoice</span>
            ) : entry.line.type === 'percent' ? (
              <Input
                type="number"
                min={0}
                max={100}
                step={0.01}
                placeholder="%"
                value={entry.line.percent ?? ''}
                onChange={(e) =>
                  update(entry, { percent: e.target.value === '' ? null : Number(e.target.value) })
                }
                disabled={!entry.line.active}
                aria-label={`${entry.title} percent`}
              />
            ) : (
              <Input
                type="number"
                min={0}
                step={0.01}
                placeholder="$"
                value={entry.line.cents == null ? '' : (entry.line.cents / 100).toFixed(2)}
                onChange={(e) =>
                  update(entry, {
                    cents: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100),
                  })
                }
                disabled={!entry.line.active}
                aria-label={`${entry.title} dollars`}
              />
            )}
            <fieldset className="m-0 border-0 p-0">
              <legend className="text-xs text-muted">Type</legend>
              <div className="flex gap-3 text-sm">
                {(
                  [
                    'percent',
                    'dollar',
                    ...(entry.allowCalculate ? ['calculate'] : []),
                  ] as LandedCostType[]
                ).map((t) => (
                  <label key={t} className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`type-${entry.key}`}
                      checked={entry.line.type === t}
                      onChange={() => update(entry, { type: t })}
                    />
                    {t === 'percent' ? 'Percent' : t === 'dollar' ? 'Dollar' : 'Calculate'}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        ))}
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={saving}
            data-testid="vendor-shipping-save"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------- PO Cutting Date */

function CuttingTab({
  vendorId,
  rows,
  collections,
  onSaved,
}: {
  vendorId: string;
  rows: CuttingRow[];
  collections: Advanced['collections'];
  onSaved: (rows: CuttingRow[]) => void;
}) {
  const [list, setList] = useState<CuttingRow[]>(rows);
  const [collectionId, setCollectionId] = useState('');
  const [cuttingDate, setCuttingDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => setList(rows), [rows]);

  function add() {
    const c = collections.find((x) => x.id === collectionId);
    if (!c || !cuttingDate) {
      toast.error('Pick a collection and a PO cutting date');
      return;
    }
    setList((l) => [
      ...l.filter((r) => r.collectionId !== c.id),
      { collectionId: c.id, collectionName: c.name, cuttingDate, notes: notes || null },
    ]);
    setCollectionId('');
    setCuttingDate('');
    setNotes('');
  }

  async function save() {
    setSaving(true);
    try {
      const res = await api<{ poCuttingDates: CuttingRow[] }>(
        `/v1/vendors/${vendorId}/po-cutting-dates`,
        {
          method: 'PUT',
          body: JSON.stringify({
            rows: list.map((r) => ({
              collectionId: r.collectionId,
              cuttingDate: r.cuttingDate,
              notes: r.notes,
            })),
          }),
        },
      );
      onSaved(res.poCuttingDates);
      toast.success('PO cutting dates saved');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  const dirty = JSON.stringify(list) !== JSON.stringify(rows);

  return (
    <Card title="PO Cutting Date — collection exceptions" data-testid="vendor-cutting">
      <p className="mb-3 text-sm text-muted">
        After a collection&apos;s cutting date, purchase orders for it can no longer be created or
        placed, and sales-rate replenishment leaves it off automatic POs.
      </p>
      <div className="mb-3 grid items-end gap-3 md:grid-cols-[minmax(0,1.5fr)_auto_minmax(0,1fr)_auto]">
        <Field label="Collection code">
          <Select
            value={collectionId}
            onChange={(e) => setCollectionId(e.target.value)}
            data-testid="cutting-collection"
          >
            <option value="">Select a collection…</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.vendorId === vendorId ? '' : ' (other vendor)'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="PO cutting date">
          <Input
            type="date"
            value={cuttingDate}
            onChange={(e) => setCuttingDate(e.target.value)}
            data-testid="cutting-date"
          />
        </Field>
        <Field label="Description / notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Button type="button" variant="secondary" onClick={add} data-testid="cutting-add">
          <Plus size={14} />
          Add
        </Button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" data-testid="cutting-table">
          <thead>
            <tr>
              <th>Collection code</th>
              <th>Description</th>
              <th>PO cutting date</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <EmptyState>No collection exceptions.</EmptyState>
                </td>
              </tr>
            )}
            {list.map((r) => (
              <tr key={r.collectionId} data-testid="cutting-row">
                <td className="font-semibold">{r.collectionName}</td>
                <td>{r.notes ?? '—'}</td>
                <td>{r.cuttingDate}</td>
                <td style={{ textAlign: 'right' }}>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      setList((l) => l.filter((x) => x.collectionId !== r.collectionId))
                    }
                    aria-label={`Remove ${r.collectionName}`}
                  >
                    <Trash2 size={14} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3">
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={saving || !dirty}
          data-testid="vendor-cutting-save"
        >
          <Save size={14} />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------- Auto PO Replen */

function ReplenTab({
  vendorId,
  settings,
  onSaved,
}: {
  vendorId: string;
  settings: Replenishment | null;
  onSaved: (r: Replenishment | null) => void;
}) {
  const [form, setForm] = useState<Replenishment>(settings ?? DEFAULT_REPLEN);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  async function save() {
    setSaving(true);
    try {
      const res = await api<{ settings: Replenishment | null }>(
        `/v1/purchasing/replenishment/vendors/${vendorId}/settings`,
        { method: 'PATCH', body: JSON.stringify(form) },
      );
      onSaved(res.settings);
      toast.success('Auto PO replenishment settings saved');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  const check = (key: keyof Replenishment, label: string, testid?: string) => (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="font-semibold">{label}</span>
      <input
        type="checkbox"
        checked={Boolean(form[key])}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
        data-testid={testid}
      />
    </label>
  );
  const weeks = (key: keyof Replenishment, label: string) => (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="font-semibold">{label}</span>
      <Select
        value={String(form[key] ?? '')}
        onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))}
        style={{ width: 90 }}
      >
        {WEEK_OPTIONS.map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </Select>
    </label>
  );
  const num = (key: keyof Replenishment, label: string, nullable = false) => (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="font-semibold">{label}</span>
      <Input
        type="number"
        min={0}
        max={999}
        value={form[key] == null ? '' : String(form[key])}
        onChange={(e) =>
          setForm((f) => ({
            ...f,
            [key]: e.target.value === '' ? (nullable ? null : 0) : Number(e.target.value),
          }))
        }
        style={{ width: 110 }}
        disabled={key === 'daysForReplenishment' && form.includeAllBackOrders}
      />
    </label>
  );
  const dateField = (key: 'varianceStart' | 'varianceEnd', label: string) => (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="font-semibold">{label}</span>
      <Input
        type="date"
        value={form[key] ?? ''}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value || null }))}
        style={{ width: 170 }}
      />
    </label>
  );

  return (
    <Card title="Auto PO Replen" data-testid="vendor-replen">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
      >
        <div className="grid gap-3">
          {check('generateAutomaticPos', 'Generate Automatic POs', 'replen-generate')}
          {check('automaticallyHoldPos', 'Automatically Hold POs')}
          {weeks('weeklySalesRateWeeks', 'Weekly Sales Rate Calculation')}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold">Include All Back Orders</span>
            <input
              type="checkbox"
              checked={form.includeAllBackOrders}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  includeAllBackOrders: e.target.checked,
                  daysForReplenishment: e.target.checked ? null : f.daysForReplenishment,
                }))
              }
            />
          </label>
          {num('daysForReplenishment', 'Days For Replenishment', true)}
          {weeks('firstAverageUnitsPeriodWeeks', 'First Average Units Period')}
          {weeks('secondAverageUnitsPeriodWeeks', 'Second Average Units Period')}
          {dateField('varianceStart', 'Variance Starting Date')}
          {dateField('varianceEnd', 'Variance Ending Date')}
          {num('variancePercent', 'Variance Percentage')}
          {num('minimumSalesRate', 'Minimum Sales Rate')}
        </div>
        <div className="grid content-start gap-4">
          <fieldset className="m-0 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
            <legend className="px-1 text-sm font-semibold">Build POs</legend>
            <div className="grid gap-1">
              {WEEKDAYS.map((d, i) => (
                <label key={d} className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-semibold">{d}</span>
                  <input
                    type="checkbox"
                    checked={form.buildDays.includes(i)}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        buildDays: e.target.checked
                          ? [...f.buildDays, i].sort()
                          : f.buildDays.filter((x) => x !== i),
                      }))
                    }
                    data-testid={`replen-build-${i}`}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="m-0 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
            <legend className="px-1 text-sm font-semibold">Sort Criteria</legend>
            <div className="grid gap-1 text-sm">
              {(
                [
                  ['vendor_model', 'Vendor Model'],
                  ['product', 'Product'],
                  ['category', 'Category'],
                  ['group', 'Group'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="sortCriteria"
                    checked={(form.sortCriteria ?? 'vendor_model') === k}
                    onChange={() => setForm((f) => ({ ...f, sortCriteria: k }))}
                    data-testid={`replen-sort-${k}`}
                  />
                  <span className="font-semibold">{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="lg:col-span-2 flex items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            disabled={saving}
            data-testid="vendor-replen-save"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Link href={`/replenishment?vendorId=${vendorId}`} className="text-sm">
            Run sales-rate replenishment →
          </Link>
          {form.minimumStockDays === 0 && form.leadDays === 0 ? (
            <span className="text-xs text-muted">
              Set minimum stock days and lead days on the General tab before the first run.
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
