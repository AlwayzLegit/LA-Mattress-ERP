'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  LoadingRows,
  Select,
  Stack,
  TableWrap,
} from '@/components/ui';

/**
 * STORIS "Replenish Inventory" (A22 slice 4): Allocated order / Stock
 * level replenishment across every vendor at once — filters, the
 * fulfillment-status checkboxes, include floor samples / returns, carton
 * rounding — and Create purchase orders (one PO per vendor and receiving
 * location, special-order allocations included).
 */

export type ReplenishMode = 'allocated_order' | 'stock_level';

interface Location {
  id: string;
  name: string;
  locationType: string;
}
interface Vendor {
  id: string;
  name: string;
}
interface RefOption {
  id: string;
  name: string;
}
interface OrderRef {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  lineId: string;
  quantity: number;
  shortfall: number;
  fillBy: string | null;
  deliveryStatus: string | null;
}
interface Line {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorSku: string | null;
  categoryName: string | null;
  collectionName: string | null;
  costCents: number | null;
  locationId: string | null;
  locationName: string | null;
  onHand: number;
  reserved: number;
  floorSample: number;
  asIsPending: number;
  netOnPo: number;
  available: number;
  demand: number;
  minimum: number | null;
  safety: number | null;
  reorderQty: number | null;
  orderQty: number;
  cartonQty: number;
  cartons: number;
  totalQty: number;
  orders: OrderRef[];
}
interface Group {
  vendorId: string | null;
  vendorName: string | null;
  lines: Line[];
  totals: { lines: number; totalQty: number; costCents: number };
}
interface Result {
  generatedAt: string;
  mode: ReplenishMode;
  basis: 'minimum' | 'safety';
  groups: Group[];
  totals: { lines: number; totalQty: number; costCents: number };
}

const DELIVERY_STATUSES: { key: string; label: string }[] = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'estimated', label: 'Estimated' },
  { key: 'asap', label: 'ASAP' },
  { key: 'will_call', label: 'Will call' },
  { key: 'none', label: 'Not set' },
];

const rowKey = (l: { variantId: string; locationId: string | null }) =>
  `${l.variantId}:${l.locationId ?? '*'}`;

export function ReplenishPanel({ mode }: { mode: ReplenishMode }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [categories, setCategories] = useState<RefOption[]>([]);
  const [collections, setCollections] = useState<RefOption[]>([]);
  const [locationId, setLocationId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [q, setQ] = useState('');
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [basis, setBasis] = useState<'minimum' | 'safety'>('minimum');
  const [includeFloorSamples, setIncludeFloorSamples] = useState(false);
  const [includeReturns, setIncludeReturns] = useState(false);
  const [roundToCarton, setRoundToCarton] = useState(true);
  const [includeZero, setIncludeZero] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [place, setPlace] = useState(true);
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      try {
        const [l, v] = await Promise.all([
          api<Location[]>('/v1/business/locations'),
          api<Vendor[]>('/v1/vendors'),
        ]);
        setLocations(l);
        setVendors(v);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      api<{ flat: RefOption[] } | RefOption[]>('/v1/categories')
        .then((r) => setCategories(Array.isArray(r) ? r : r.flat))
        .catch(() => setCategories([]));
      api<RefOption[]>('/v1/collections')
        .then(setCollections)
        .catch(() => setCollections([]));
    })();
  }, []);

  useEffect(() => {
    setResult(null);
    setOverrides({});
    setPicked(new Set());
  }, [mode]);

  function body() {
    return {
      mode,
      locationId: locationId || null,
      vendorId: vendorId || null,
      categoryId: categoryId || null,
      collectionId: collectionId || null,
      q: q.trim() || null,
      deliveryStatuses: mode === 'allocated_order' ? [...statuses] : null,
      stockLevelBasis: basis,
      includeFloorSamples,
      includeReturns,
      roundToCarton,
      includeZero,
    };
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await api<Result>('/v1/purchasing/replenish/run', {
        method: 'POST',
        body: JSON.stringify(body()),
      });
      setResult(res);
      setOverrides({});
      setPicked(new Set(res.groups.filter((g) => g.vendorId).map((g) => g.vendorId!)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function createPos() {
    if (!result) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api<{
        purchaseOrders: {
          vendorName: string | null;
          number: string;
          status: string;
          lineCount: number;
          poId: string;
        }[];
        skipped: { vendorName: string | null; reason: string }[];
      }>('/v1/purchasing/replenish/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          ...body(),
          vendorIds: [...picked],
          place,
          overrides: Object.entries(overrides).map(([key, totalQty]) => {
            const [variantId, loc] = key.split(':');
            return { variantId, locationId: loc === '*' ? null : loc, totalQty };
          }),
        }),
      });
      for (const po of res.purchaseOrders) {
        toast.success(
          `${po.number} — ${po.vendorName ?? 'vendor'} (${po.lineCount} line${po.lineCount === 1 ? '' : 's'}, ${po.status === 'draft' ? 'held as draft' : 'placed'})`,
        );
      }
      for (const s of res.skipped) toast.warning(`${s.vendorName ?? 'No vendor'}: ${s.reason}`);
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const effective = useMemo(() => {
    if (!result) return null;
    return result.groups.map((g) => {
      const lines = g.lines.map((l) => ({
        ...l,
        effectiveQty: overrides[rowKey(l)] ?? l.totalQty,
      }));
      const totalQty = lines.reduce((s, l) => s + l.effectiveQty, 0);
      const costCents = lines.reduce((s, l) => s + l.effectiveQty * (l.costCents ?? 0), 0);
      return { ...g, lines, totals: { lines: lines.length, totalQty, costCents } };
    });
  }, [result, overrides]);
  const orderable = (effective ?? []).filter(
    (g) => g.vendorId && picked.has(g.vendorId) && g.totals.totalQty > 0,
  );

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  return (
    <Stack>
      {error && <Alert tone="error">{error}</Alert>}
      <Card
        title={
          mode === 'allocated_order' ? 'Allocated order replenishment' : 'Stock level replenishment'
        }
        description={
          mode === 'allocated_order'
            ? 'Every open sales-order line short of stock and of PO cover, netted against free stock and open POs at the location the order draws from.'
            : 'Every position below its threshold — the store minimum (Min Stock per location) or the product safety point — topped back up.'
        }
        data-testid="replenish-criteria"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <FormGrid cols={3}>
            <Field
              label={mode === 'allocated_order' ? 'Location (orders draw from)' : 'Location'}
              hint={
                mode === 'stock_level' && basis === 'safety'
                  ? 'Safety stock is business-wide; the location receives the POs'
                  : 'Blank = every location'
              }
            >
              <Select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                data-testid="replenish-location"
              >
                <option value="">All locations</option>
                {[...locations]
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
            <Field label="Vendor" hint="Blank = every vendor, one PO each">
              <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">All vendors</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Product / SKU contains">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. HEXMIC" />
            </Field>
            <Field label="Category">
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Collection (group)">
              <Select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                <option value="">All collections</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {mode === 'stock_level' ? (
              <Field label="Threshold">
                <Select
                  value={basis}
                  onChange={(e) => setBasis(e.target.value === 'safety' ? 'safety' : 'minimum')}
                  data-testid="replenish-basis"
                >
                  <option value="minimum">Minimum stock (per store)</option>
                  <option value="safety">Safety stock (product reorder point)</option>
                </Select>
              </Field>
            ) : (
              <Field label="Fulfillment status" as="div" hint="None ticked = every order">
                <div className="flex flex-wrap gap-3 text-sm">
                  {DELIVERY_STATUSES.map((s) => (
                    <label key={s.key} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={statuses.has(s.key)}
                        onChange={() => setStatuses((prev) => toggle(prev, s.key))}
                        data-testid={`replenish-status-${s.key}`}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <Field label="Options" as="div" className="form-span">
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={includeFloorSamples}
                    onChange={(e) => setIncludeFloorSamples(e.target.checked)}
                  />
                  Include floor samples as stock
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={includeReturns}
                    onChange={(e) => setIncludeReturns(e.target.checked)}
                  />
                  Include returns (pending As-Is) as stock
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={roundToCarton}
                    onChange={(e) => setRoundToCarton(e.target.checked)}
                    data-testid="replenish-carton"
                  />
                  Round up to purchase cartons
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={includeZero}
                    onChange={(e) => setIncludeZero(e.target.checked)}
                  />
                  Show positions with nothing to order
                </label>
              </div>
            </Field>
          </FormGrid>
          <FormActions>
            <Button type="submit" variant="primary" disabled={running} data-testid="replenish-run">
              {running ? 'Running…' : 'Run'}
            </Button>
          </FormActions>
        </form>
      </Card>

      {running && !result ? (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      ) : effective == null ? null : effective.length === 0 ? (
        <Card title="Items to replenish">
          <EmptyState title="Nothing to replenish">
            {mode === 'allocated_order'
              ? 'Every open order line is covered by stock or an open purchase order.'
              : 'Every position is at or above its threshold.'}
          </EmptyState>
        </Card>
      ) : (
        <>
          {effective.map((g) => (
            <Card
              key={g.vendorId ?? '~'}
              title={
                <label className="flex items-center gap-2">
                  {g.vendorId && (
                    <input
                      type="checkbox"
                      checked={picked.has(g.vendorId)}
                      onChange={() => setPicked((prev) => toggle(prev, g.vendorId!))}
                      aria-label={`Create a purchase order for ${g.vendorName}`}
                      data-testid="replenish-pick-vendor"
                    />
                  )}
                  {g.vendorName ?? 'No vendor — set a preferred vendor on the product'}
                </label>
              }
              description={`${g.totals.lines} line(s) · ${g.totals.totalQty} unit(s) · `}
              actions={<Money cents={g.totals.costCents} />}
              flush
              data-testid="replenish-group"
            >
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Vendor model</th>
                      <th>Location</th>
                      <th className="num">On hand</th>
                      <th className="num">Reserved</th>
                      <th className="num">Available</th>
                      <th className="num">Net PO</th>
                      <th className="num">
                        {mode === 'allocated_order' ? 'Orders need' : 'Threshold'}
                      </th>
                      <th className="num">Need</th>
                      <th className="num" title="Units per purchase carton">
                        Carton
                      </th>
                      <th className="num">Cartons</th>
                      <th className="num">Total qty</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.lines.map((l) => {
                      const key = rowKey(l);
                      const open = expanded.has(key);
                      return (
                        <Fragment key={key}>
                          <tr data-testid="replenish-line">
                            <td>
                              <Link href={`/products/${l.productId}`}>{l.productName}</Link>
                              {l.variantName ? ` — ${l.variantName}` : ''}
                              {l.sku ? (
                                <div className="muted text-xs">
                                  <code>{l.sku}</code>
                                </div>
                              ) : null}
                              {l.orders.length > 0 && (
                                <button
                                  type="button"
                                  className="btn-link text-xs"
                                  onClick={() => setExpanded((prev) => toggle(prev, key))}
                                >
                                  {open ? 'Hide' : 'Show'} {l.orders.length} order
                                  {l.orders.length === 1 ? '' : 's'}
                                </button>
                              )}
                            </td>
                            <td>{l.vendorSku ?? '—'}</td>
                            <td>{l.locationName ?? 'All'}</td>
                            <td className="num">{l.onHand}</td>
                            <td className="num">{l.reserved}</td>
                            <td className="num">{l.available}</td>
                            <td className="num">{l.netOnPo}</td>
                            <td className="num">
                              {l.demand}
                              {mode === 'stock_level' && l.reorderQty ? (
                                <div className="muted text-xs">pack {l.reorderQty}</div>
                              ) : null}
                            </td>
                            <td className="num">{l.orderQty}</td>
                            <td className="num">{l.cartonQty}</td>
                            <td className="num">{l.cartons}</td>
                            <td className="num">
                              <Input
                                type="number"
                                min={0}
                                className="w-20 text-right"
                                aria-label={`Total quantity for ${l.productName}`}
                                value={String(l.effectiveQty)}
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  setOverrides((o) => ({
                                    ...o,
                                    [key]: Number.isInteger(n) && n >= 0 ? n : 0,
                                  }));
                                }}
                                data-testid="replenish-total-qty"
                              />
                            </td>
                            <td className="num">
                              <Money cents={l.effectiveQty * (l.costCents ?? 0)} />
                            </td>
                          </tr>
                          {open && (
                            <tr className="muted">
                              <td />
                              <td colSpan={12}>
                                {l.orders.map((o) => (
                                  <div key={o.lineId}>
                                    <Link href={`/orders/${o.orderId}`}>{o.orderNumber}</Link>
                                    {o.customerName ? ` · ${o.customerName}` : ''} · needs{' '}
                                    {o.shortfall} of {o.quantity}
                                    {o.fillBy ? ` · by ${o.fillBy}` : ''}
                                    {o.deliveryStatus ? ` · ${o.deliveryStatus}` : ''}
                                  </div>
                                ))}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          ))}
          <Card data-testid="replenish-create">
            <FormActions
              start={
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={place}
                    onChange={(e) => setPlace(e.target.checked)}
                  />
                  Place the purchase orders now (untick to hold them as drafts)
                </label>
              }
            >
              <Button
                variant="primary"
                onClick={() => void createPos()}
                disabled={creating || orderable.length === 0}
                data-testid="replenish-create-pos"
              >
                {creating
                  ? 'Creating…'
                  : `Create ${orderable.length} purchase order${orderable.length === 1 ? '' : 's'}`}
              </Button>
            </FormActions>
          </Card>
        </>
      )}
    </Stack>
  );
}
