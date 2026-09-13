'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ReplenishPanel, type ReplenishMode } from './replenish-panel';
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
  SectionHeading,
  Select,
  Stack,
  TableWrap,
  useListColumns,
} from '@/components/ui';

interface Vendor {
  id: string;
  name: string;
}
interface Location {
  id: string;
  name: string;
  locationType: string;
}
interface VendorSettings {
  generateAutomaticPos: boolean;
  automaticallyHoldPos: boolean;
  weeklySalesRateWeeks: number;
  includeAllBackOrders: boolean;
  daysForReplenishment: number | null;
  minimumStockDays: number;
  leadDays: number;
  variancePercent: number;
  minimumSalesRate: number;
  buildDays: number[];
  defaultRequestedDate?: 'vendor_lead_days' | 'today';
}
interface GridRow {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorSku: string | null;
  costCents: number | null;
  required: number;
  additional: number;
  available: number;
  netPo: number;
  orderQty: number;
  salesRate: number;
  volume: number;
  asIsQty: number;
  lastSaleDate: string | null;
}
/** A grid row with the session-only Order Qty override applied. */
type SalesRateRow = GridRow & { effectiveQty: number };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type ReplenishmentType = ReplenishMode | 'sales_rate';
const TYPES: { key: ReplenishmentType; label: string }[] = [
  { key: 'allocated_order', label: 'Allocated order' },
  { key: 'stock_level', label: 'Stock level' },
  { key: 'sales_rate', label: 'Sales rate' },
];

/**
 * STORIS "Replenish Inventory" (A22 slice 4): one screen, three
 * replenishment types — Allocated order and Stock level run across every
 * vendor at once; Sales rate is the per-vendor engine the nightly build
 * uses.
 */
export default function ReplenishmentPage() {
  const [type, setType] = useState<ReplenishmentType>('allocated_order');
  return (
    <div>
      <PageHeader
        title="Replenish inventory"
        sub="Allocated orders, stock levels, or the sales-rate engine — pick the type, run, and create the purchase orders by vendor"
        actions={
          <div className="seg seg-lg" role="tablist" aria-label="Replenishment type">
            {TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={type === t.key}
                className={`seg-btn${type === t.key ? ' is-active' : ''}`}
                onClick={() => setType(t.key)}
                data-testid={`replenishment-type-${t.key}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />
      {type === 'sales_rate' ? <SalesRatePanel /> : <ReplenishPanel mode={type} />}
    </div>
  );
}

function SalesRatePanel() {
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [vendorId, setVendorId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [settings, setSettings] = useState<VendorSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Criteria (§4.1)
  const [variance, setVariance] = useState('');
  const [daysForRepl, setDaysForRepl] = useState('');
  const [salesWindow, setSalesWindow] = useState<'this_year_prior' | 'last_year_subsequent'>(
    'this_year_prior',
  );
  const [includeOverstocks, setIncludeOverstocks] = useState(false);

  // Results (§4.2). Overrides are session-only — Rebuild List drops them.
  const [rows, setRows] = useState<GridRow[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [v, l] = await Promise.all([
          api<Vendor[]>('/v1/vendors'),
          api<Location[]>('/v1/business/locations'),
        ]);
        setVendors(v);
        setLocations(l);
        if (l.length === 1) setLocationId(l[0]!.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  useEffect(() => {
    setSettings(null);
    setSettingsLoaded(false);
    setRows(null);
    setOverrides({});
    if (!vendorId) return;
    void (async () => {
      try {
        const res = await api<{ settings: VendorSettings | null }>(
          `/v1/purchasing/replenishment/vendors/${vendorId}/settings`,
        );
        setSettings(res.settings);
        setSettingsLoaded(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [vendorId]);

  function criteriaBody() {
    return {
      vendorId,
      locationId,
      variancePercent: variance === '' ? null : Number(variance),
      daysForReplenishment: daysForRepl === '' ? null : Number(daysForRepl),
      salesWindow,
      includeOverstocks,
    };
  }

  async function run(rebuild = false) {
    if (!vendorId || !locationId) {
      toast.error('Pick a vendor and a warehouse location first');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await api<{ rows: GridRow[] }>('/v1/purchasing/replenishment/run', {
        method: 'POST',
        body: JSON.stringify(criteriaBody()),
      });
      setRows(res.rows);
      setOverrides({}); // Rebuild List semantics: overrides never survive a run
      if (rebuild) toast.success('List rebuilt — overrides discarded');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function createPo() {
    setCreating(true);
    setError(null);
    try {
      const body = {
        ...criteriaBody(),
        overrides: Object.entries(overrides).map(([variantId, orderQty]) => ({
          variantId,
          orderQty,
        })),
      };
      const res = await api<{ poId: string; number: string; status: string; lineCount: number }>(
        '/v1/purchasing/replenishment/purchase-order',
        { method: 'POST', body: JSON.stringify(body) },
      );
      toast.success(
        `${res.number} created (${res.lineCount} line${res.lineCount === 1 ? '' : 's'}${
          res.status === 'draft' ? ', held for review' : ', placed'
        })`,
      );
      void run();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function saveSettings(patch: Partial<VendorSettings>) {
    try {
      const res = await api<{ settings: VendorSettings | null }>(
        `/v1/purchasing/replenishment/vendors/${vendorId}/settings`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
      setSettings(res.settings);
      toast.success('Vendor replenishment settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const effectiveRows = useMemo(
    () =>
      (rows ?? []).map((r) => ({
        ...r,
        effectiveQty: overrides[r.variantId] ?? r.orderQty,
      })),
    [rows, overrides],
  );
  const orderable = effectiveRows.filter((r) => r.effectiveQty > 0);

  // Order Qty is edited in place, so the cell needs `setOverrides`.
  const gridColumns: ColumnDef<SalesRateRow>[] = [
    {
      id: 'product',
      label: 'Product',
      sortValue: (r) => r.productName,
      render: (r) => (
        <>
          {r.productName}
          {r.variantName ? ` — ${r.variantName}` : ''}
          {r.sku ? (
            <>
              {' '}
              <span className="muted">{r.sku}</span>
            </>
          ) : null}
        </>
      ),
    },
    {
      id: 'vendorProduct',
      label: 'Vendor product',
      sortValue: (r) => r.vendorSku ?? r.sku,
      render: (r) => r.vendorSku ?? r.sku ?? '—',
    },
    {
      id: 'rate',
      label: 'Rate/wk',
      num: true,
      sortValue: (r) => r.salesRate,
      render: (r) => r.salesRate.toFixed(2),
    },
    {
      id: 'required',
      label: 'Required',
      num: true,
      sortValue: (r) => r.required,
      render: (r) => r.required,
    },
    {
      id: 'additional',
      label: 'Additional',
      num: true,
      sortValue: (r) => r.additional,
      render: (r) => r.additional,
    },
    {
      id: 'available',
      label: 'Available',
      num: true,
      sortValue: (r) => r.available,
      render: (r) => r.available,
    },
    { id: 'netPo', label: 'Net PO', num: true, sortValue: (r) => r.netPo, render: (r) => r.netPo },
    {
      id: 'volume',
      label: 'Volume',
      num: true,
      sortValue: (r) => r.volume,
      render: (r) => r.volume,
    },
    {
      id: 'asIs',
      label: 'As-is',
      num: true,
      sortValue: (r) => r.asIsQty,
      render: (r) => r.asIsQty,
    },
    {
      id: 'lastSale',
      label: 'Last sale',
      sortValue: (r) => r.lastSaleDate,
      render: (r) => r.lastSaleDate ?? '—',
    },
    {
      id: 'orderQty',
      label: 'Order qty',
      num: true,
      sortValue: (r) => r.effectiveQty,
      render: (r) => (
        <Input
          type="number"
          className="w-20 text-right"
          aria-label={`Order quantity for ${r.productName}`}
          value={String(r.effectiveQty)}
          onChange={(e) => {
            const n = Number(e.target.value);
            setOverrides((o) => ({
              ...o,
              [r.variantId]: Number.isInteger(n) ? n : 0,
            }));
          }}
        />
      ),
    },
  ];
  const cols = useListColumns('replenishment-sales-rate', gridColumns, effectiveRows);

  return (
    <div>
      <Stack>
        {error ? <Alert tone="error">{error}</Alert> : null}

        <Card
          title="Sales-rate criteria"
          description="One engine, three run modes — what this screen shows is exactly what the nightly build orders"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <FormGrid cols={3}>
              <Field label="Vendor" required>
                <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">Select a vendor…</option>
                  {(vendors ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Warehouse location" required>
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Select a location…</option>
                  {/* Q2: warehouses first — they are the replenishment target. */}
                  {[...(locations ?? [])]
                    .sort((a, b) =>
                      a.locationType === b.locationType
                        ? a.name.localeCompare(b.name)
                        : a.locationType === 'warehouse'
                          ? -1
                          : 1,
                    )
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.locationType === 'warehouse' ? ' (warehouse)' : ''}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Variance %" hint="Blank = 100">
                <Input
                  type="number"
                  min={0}
                  max={999}
                  value={variance}
                  onChange={(e) => setVariance(e.target.value)}
                  placeholder="100"
                />
              </Field>
              <Field
                label="Days for replenishment"
                hint={
                  settings?.includeAllBackOrders === true
                    ? 'Ignored — this vendor includes all back orders'
                    : undefined
                }
              >
                <Input
                  type="number"
                  min={0}
                  max={999}
                  value={daysForRepl}
                  onChange={(e) => setDaysForRepl(e.target.value)}
                  placeholder="Vendor default"
                  disabled={settings?.includeAllBackOrders === true}
                />
              </Field>
              <Field label="Sales to use">
                <Select
                  value={salesWindow}
                  onChange={(e) =>
                    setSalesWindow(
                      e.target.value === 'last_year_subsequent'
                        ? 'last_year_subsequent'
                        : 'this_year_prior',
                    )
                  }
                >
                  <option value="this_year_prior">This year&apos;s prior weeks</option>
                  <option value="last_year_subsequent">Last year&apos;s subsequent weeks</option>
                </Select>
              </Field>
              <div className="field">
                <span className="field-label">Include overstocks</span>
                <label className="flex h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={includeOverstocks}
                    onChange={(e) => setIncludeOverstocks(e.target.checked)}
                  />
                  Show rows with nothing to order
                </label>
              </div>
            </FormGrid>
            <FormActions>
              {rows ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void run(true)}
                  disabled={running}
                >
                  Rebuild list
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                disabled={running || !vendorId || !locationId}
              >
                {running ? 'Running…' : 'Run'}
              </Button>
            </FormActions>
          </form>
        </Card>

        {vendorId && settingsLoaded ? (
          <Card
            title="Vendor replenishment settings"
            actions={
              <LinkButton size="sm" href={`/vendors/${vendorId}/settings?tab=replen`}>
                Advanced vendor settings
              </LinkButton>
            }
          >
            <Stack>
              {settings ? null : (
                <Alert tone="warning">
                  Not configured — this vendor is skipped by every run mode until enabled.
                </Alert>
              )}
              <VendorSettingsForm settings={settings} onSave={(p) => void saveSettings(p)} />
            </Stack>
          </Card>
        ) : null}

        {rows === null ? (
          vendorId && running ? (
            <Card>
              <LoadingRows rows={4} />
            </Card>
          ) : null
        ) : rows.length === 0 ? (
          <Card title="Items for replenishment">
            <EmptyState title="Nothing to replenish">
              No product cleared the sales-rate floor with a quantity to order under these criteria.
            </EmptyState>
          </Card>
        ) : (
          <Card
            title="Items for replenishment"
            description={`${rows.length} row(s) · ${orderable.length} with quantity to order — Order Qty edits are session-only; Rebuild List resets them.`}
          >
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="replenishment-sales-rate" />
                </thead>
                <tbody>
                  {cols.sorted.map((r) => (
                    <tr key={r.variantId}>
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
            <FormActions
              start={
                <span>
                  Only lines with a positive order quantity are written to the purchase order.
                </span>
              }
            >
              <Button
                variant="primary"
                onClick={() => void createPo()}
                disabled={creating || orderable.length === 0}
              >
                {creating
                  ? 'Creating…'
                  : `Create purchase order (${orderable.length} line${orderable.length === 1 ? '' : 's'})`}
              </Button>
            </FormActions>
          </Card>
        )}
      </Stack>
    </div>
  );
}

function VendorSettingsForm({
  settings,
  onSave,
}: {
  settings: VendorSettings | null;
  onSave: (patch: Partial<VendorSettings>) => void;
}) {
  const [form, setForm] = useState<VendorSettings>(
    settings ?? {
      generateAutomaticPos: false,
      automaticallyHoldPos: true,
      weeklySalesRateWeeks: 8,
      includeAllBackOrders: false,
      daysForReplenishment: null,
      minimumStockDays: 14,
      leadDays: 21,
      variancePercent: 100,
      minimumSalesRate: 0,
      buildDays: [],
      defaultRequestedDate: 'vendor_lead_days',
    },
  );
  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  function num(field: keyof VendorSettings, label: string, min = 0, max = 999) {
    return (
      <Field label={label}>
        <Input
          type="number"
          min={min}
          max={max}
          value={String(form[field] ?? '')}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              [field]: e.target.value === '' ? null : Number(e.target.value),
            }))
          }
        />
      </Field>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <FormGrid cols={3}>
        {num('weeklySalesRateWeeks', 'Sales-rate window (weeks)', 1, 156)}
        {num('minimumStockDays', 'Minimum stock days')}
        {num('leadDays', 'Lead days')}
        {num('variancePercent', 'Variance %')}
        {num('minimumSalesRate', 'Minimum sales rate (units/wk)')}
        {num('daysForReplenishment', 'Days for replenishment')}
        <Field label="Requested date on POs">
          <Select
            value={form.defaultRequestedDate ?? 'vendor_lead_days'}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                defaultRequestedDate: e.target.value === 'today' ? 'today' : 'vendor_lead_days',
              }))
            }
          >
            <option value="vendor_lead_days">Vendor lead days</option>
            <option value="today">Today&apos;s date</option>
          </Select>
        </Field>

        <SectionHeading as="h3" title="Automatic POs" />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.generateAutomaticPos}
            onChange={(e) => setForm((f) => ({ ...f, generateAutomaticPos: e.target.checked }))}
          />
          Generate automatic POs (nightly)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.automaticallyHoldPos}
            onChange={(e) => setForm((f) => ({ ...f, automaticallyHoldPos: e.target.checked }))}
          />
          Automatically hold POs (draft for buyer review)
        </label>
        <label className="flex items-center gap-2 text-sm">
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
          Include all back orders
        </label>

        <SectionHeading as="h3" title="Build POs on" />
        <div className="form-span flex flex-wrap items-center gap-4 text-sm">
          {WEEKDAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
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
              />
              {d}
            </label>
          ))}
        </div>
      </FormGrid>
      <FormActions>
        <Button type="submit" variant="primary">
          Save vendor settings
        </Button>
      </FormActions>
    </form>
  );
}
