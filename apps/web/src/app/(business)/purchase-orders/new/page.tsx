'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  PageHeader,
  SectionHeading,
  Select,
  Stack,
  TableWrap,
  Toolbar,
} from '@/components/ui';

interface Vendor {
  id: string;
  name: string;
}
interface LocationRow {
  id: string;
  name: string;
}
interface VariantRow {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  priceCents: number;
}
interface Line {
  variantId: string;
  description: string;
  /** The item's SKU, shown in its own column so the buyer checks it against the vendor. */
  sku: string | null;
  quantity: number;
  unitCostStr: string;
  /** Set when the line buys for a specific customer order (queue pre-load). */
  orderLineId?: string;
  /** Display-only: the sales order this line is bought for. */
  orderNumber?: string;
}

interface ReorderSuggestion {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  available: number;
  reorderPoint: number;
  suggestedQty: number;
  unitCostCents: number | null;
}

interface QueueRow {
  orderLineId: string;
  orderNumber: string;
  customerName: string | null;
  variantId: string | null;
  sku: string | null;
  preferredVendorId: string | null;
  unitCostCents: number | null;
  description: string;
  toOrder: number;
}

/**
 * The purchase-order staging screen.
 *
 * Nothing is written until a button is pressed: lines, quantities and
 * costs live in React state, so backing out costs nothing. That is the
 * point — `?vendorId=…&preload=reorder` sends the reorder panel here
 * with its suggestions already staged, instead of committing a numbered
 * draft the moment someone clicks (CR 2026-08-31, root cause of the
 * draft pile-up).
 *
 * Two exits: **Save as draft** parks it for later, **Place order**
 * commits to the vendor.
 */
function NewPurchaseOrderInner() {
  const router = useRouter();
  const params = useSearchParams();
  const preloadVendorId = params?.get('vendorId') ?? '';
  const preloadKind = params?.get('preload') ?? '';
  /** Guards the one-shot preload against the suggestions effect refiring. */
  const preloaded = useRef(false);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [freightStr, setFreightStr] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<VariantRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reorder, setReorder] = useState<ReorderSuggestion[]>([]);
  const [queue, setQueue] = useState<QueueRow[]>([]);

  // §6 builder pre-load for the selected vendor: (a) items at/below
  // their reorder point, (b) sold-not-in-stock special-order lines.
  useEffect(() => {
    if (!vendorId) return;
    let stale = false;
    void api<{
      vendors: { vendorId: string | null; lines: ReorderSuggestion[] }[];
    }>('/v1/purchase-orders/reorder-suggestions')
      .then((r) => {
        if (stale) return;
        setReorder(r.vendors.find((v) => v.vendorId === vendorId)?.lines ?? []);
      })
      .catch(() => setReorder([]));
    void api<QueueRow[]>('/v1/special-orders/queue')
      .then((rows) => {
        if (stale) return;
        setQueue(rows.filter((r) => r.variantId && r.preferredVendorId === vendorId));
      })
      .catch(() => setQueue([]));
    return () => {
      stale = true;
    };
  }, [vendorId]);

  useEffect(() => {
    void (async () => {
      try {
        const [vs, ls] = await Promise.all([
          api<Vendor[]>('/v1/vendors'),
          api<LocationRow[]>('/v1/pos/locations'),
        ]);
        setVendors(vs);
        setLocations(ls);
        const wanted = vs.find((v) => v.id === preloadVendorId);
        if (wanted) setVendorId(wanted.id);
        else if (vs.length > 0) setVendorId(vs[0]!.id);
        if (ls.length > 0) setLocationId(ls[0]!.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arriving from the reorder panel: stage every suggestion at once, so
  // the buyer edits a filled basket rather than clicking "Add" 40 times.
  // Once only — changing vendor afterwards means they are hand-building.
  useEffect(() => {
    if (preloaded.current) return;
    if (preloadKind !== 'reorder' || !preloadVendorId) return;
    if (vendorId !== preloadVendorId || reorder.length === 0) return;
    preloaded.current = true;
    setLines((prev) => {
      const have = new Set(prev.filter((l) => !l.orderLineId).map((l) => l.variantId));
      return [
        ...prev,
        ...reorder
          .filter((s) => !have.has(s.variantId))
          .map((s) => ({
            variantId: s.variantId,
            description: [s.productName, s.variantName].filter(Boolean).join(' — '),
            sku: s.sku,
            quantity: s.suggestedQty,
            unitCostStr: s.unitCostCents != null ? (s.unitCostCents / 100).toFixed(2) : '',
          })),
      ];
    });
  }, [preloadKind, preloadVendorId, vendorId, reorder]);

  // Staged lines only exist in this tab; a stray reload or back button
  // should not silently bin the basket (same guard as the order writer).
  useEffect(() => {
    if (lines.length === 0 || saving) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [lines.length, saving]);

  async function searchVariants() {
    if (!search.trim()) {
      setResults([]);
      return;
    }
    try {
      const rows = await api<VariantRow[]>(`/v1/pos/lookup?q=${encodeURIComponent(search.trim())}`);
      setResults(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function addLine(v: VariantRow) {
    if (lines.some((l) => l.variantId === v.variantId)) return;
    setLines((prev) => [
      ...prev,
      {
        variantId: v.variantId,
        description: [v.productName, v.variantName].filter(Boolean).join(' — '),
        sku: v.sku,
        quantity: 1,
        unitCostStr: '',
      },
    ]);
    setSearch('');
    setResults([]);
  }

  function setLine(index: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void save(true);
  }

  /**
   * The only write this screen makes. `place: false` parks it as a
   * draft; true commits the order to the vendor.
   */
  async function save(place: boolean) {
    setError(null);
    if (lines.length === 0) {
      setError('Add at least one line.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        vendorId,
        locationId,
        place,
        expectedAt: expectedAt || undefined,
        freightCents: freightStr ? Math.round(Number(freightStr) * 100) : null,
        notes: notes || null,
        lines: lines.map((l) => ({
          variantId: l.variantId,
          quantity: Number(l.quantity),
          unitCostCents: Math.round(Number(l.unitCostStr) * 100),
          orderLineId: l.orderLineId,
        })),
      };
      for (const l of body.lines) {
        if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
          throw new Error('Each line needs a positive integer quantity.');
        }
        if (!Number.isFinite(l.unitCostCents) || l.unitCostCents < 0) {
          throw new Error('Each line needs a unit cost.');
        }
      }
      const created = await api<{ id: string }>('/v1/purchase-orders', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      router.push(`/purchase-orders/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  const subtotalCents = lines.reduce(
    (s, l) => s + Math.round(Number(l.unitCostStr) * 100) * Number(l.quantity || 0),
    0,
  );

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/purchase-orders">All purchase orders</BackLink>}
        title="New purchase order"
        sub="Nothing is written until you save as draft or place the order."
      />
      <form onSubmit={submit}>
        <Stack>
          <Card title="Details">
            <FormGrid cols={2}>
              <Field
                label="Vendor"
                hint={
                  vendors.length === 0 ? (
                    <>
                      No vendors yet — <Link href="/vendors">create one first</Link>.
                    </>
                  ) : undefined
                }
              >
                <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Location">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Expected delivery">
                <Input
                  type="date"
                  value={expectedAt}
                  onChange={(e) => setExpectedAt(e.target.value)}
                />
              </Field>
              <Field label="Freight ($)" hint="Spread into unit cost at receipt">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={freightStr}
                  onChange={(e) => setFreightStr(e.target.value)}
                />
              </Field>
              <Field label="Notes" className="form-span">
                <textarea
                  className="textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </Field>
            </FormGrid>
          </Card>

          {(reorder.length > 0 || queue.length > 0) && (
            // Deliberately a list, not a table: the lines table below is
            // the only place a staged item should read as a row.
            <Card title="Suggested for this vendor" data-testid="builder-suggestions">
              {reorder.length > 0 && (
                <>
                  <SectionHeading as="h3" title="At or below reorder point" />
                  <Stack gap="sm">
                    {reorder.map((s) => (
                      <div key={s.variantId} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          {s.productName}
                          {s.variantName ? ` — ${s.variantName}` : ''}{' '}
                          <span className="muted">
                            ({s.available} avail, point {s.reorderPoint})
                          </span>
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={lines.some(
                            (l) => l.variantId === s.variantId && !l.orderLineId,
                          )}
                          onClick={() =>
                            setLines((prev) => [
                              ...prev,
                              {
                                variantId: s.variantId,
                                description: [s.productName, s.variantName]
                                  .filter(Boolean)
                                  .join(' — '),
                                sku: s.sku,
                                quantity: s.suggestedQty,
                                unitCostStr:
                                  s.unitCostCents != null ? (s.unitCostCents / 100).toFixed(2) : '',
                              },
                            ])
                          }
                        >
                          Add {s.suggestedQty}
                        </Button>
                      </div>
                    ))}
                  </Stack>
                </>
              )}
              {queue.length > 0 && (
                <>
                  <SectionHeading
                    as="h3"
                    title="Sold, not in stock"
                    description="The order carries the sales order #."
                  />
                  <Stack gap="sm">
                    {queue.map((q) => (
                      <div key={q.orderLineId} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          {q.description}{' '}
                          <span className="muted">
                            for {q.orderNumber}
                            {q.customerName ? ` (${q.customerName})` : ''}
                          </span>
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={lines.some((l) => l.orderLineId === q.orderLineId)}
                          onClick={() =>
                            setLines((prev) => [
                              ...prev,
                              {
                                variantId: q.variantId!,
                                description: q.description,
                                sku: q.sku,
                                quantity: q.toOrder,
                                unitCostStr:
                                  q.unitCostCents != null ? (q.unitCostCents / 100).toFixed(2) : '',
                                orderLineId: q.orderLineId,
                                orderNumber: q.orderNumber,
                              },
                            ])
                          }
                        >
                          Add {q.toOrder}
                        </Button>
                      </div>
                    ))}
                  </Stack>
                </>
              )}
            </Card>
          )}

          <Card title="Add items">
            <Toolbar>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void searchVariants();
                  }
                }}
                placeholder="Search by name, SKU, or barcode"
                aria-label="Search by name, SKU, or barcode"
              />
              <Button type="button" variant="secondary" size="sm" onClick={searchVariants}>
                <Search size={14} aria-hidden />
                Search
              </Button>
            </Toolbar>
            {results.length > 0 && (
              <TableWrap>
                <table className="table table-dense">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>SKU</th>
                      <th className="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => {
                      const staged = lines.some((l) => l.variantId === r.variantId);
                      return (
                        <tr key={r.variantId}>
                          <td>
                            <strong>{r.productName}</strong>
                            {r.variantName && <span className="muted"> — {r.variantName}</span>}
                          </td>
                          <td>
                            <code>{r.sku ?? '—'}</code>
                          </td>
                          <td className="actions">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={staged}
                              onClick={() => addLine(r)}
                            >
                              {staged ? 'Added' : 'Add'}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card title="Lines" flush={lines.length > 0}>
            {lines.length === 0 ? (
              <EmptyState title="No lines yet">
                Search for an item above to add it to the order.
              </EmptyState>
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>SKU</th>
                      <th>Qty</th>
                      <th>Unit cost ($)</th>
                      <th className="num">Line total</th>
                      <th className="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const lineTotal =
                        Math.round(Number(l.unitCostStr) * 100) * Number(l.quantity || 0);
                      return (
                        <tr key={`${l.variantId}-${l.orderLineId ?? i}`}>
                          <td>
                            {l.description}
                            {l.orderNumber && (
                              <>
                                {' '}
                                <span className="badge badge-info">for {l.orderNumber}</span>
                              </>
                            )}
                          </td>
                          <td data-testid="po-line-sku">
                            {l.sku ? <code>{l.sku}</code> : <span className="muted">—</span>}
                          </td>
                          <td>
                            <Input
                              type="number"
                              min={1}
                              aria-label="Quantity"
                              value={l.quantity}
                              onChange={(e) => setLine(i, { quantity: Number(e.target.value) })}
                              className="w-20"
                            />
                          </td>
                          <td>
                            <Input
                              type="number"
                              step="0.01"
                              min={0}
                              aria-label="Unit cost"
                              value={l.unitCostStr}
                              onChange={(e) => setLine(i, { unitCostStr: e.target.value })}
                              className="w-28"
                            />
                          </td>
                          <td className="num">
                            <Money cents={lineTotal} />
                          </td>
                          <td className="actions">
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              onClick={() => removeLine(i)}
                            >
                              Remove
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="num">
                        <strong>Subtotal</strong>
                      </td>
                      <td className="num">
                        <strong>
                          <Money cents={subtotalCents} />
                        </strong>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </TableWrap>
            )}
          </Card>

          <div>
            {error && <Alert tone="error">{error}</Alert>}
            <FormActions
              start={
                <span className="muted">
                  Nothing is saved until you press one of these — leave and this basket is gone.
                </span>
              }
            >
              <Button
                type="button"
                variant="secondary"
                disabled={saving}
                onClick={() => void save(false)}
                data-testid="save-draft"
              >
                Save as draft
              </Button>
              <Button type="submit" variant="primary" disabled={saving} data-testid="place-order">
                <Plus size={14} aria-hidden />
                {saving ? 'Saving…' : 'Place order'}
              </Button>
            </FormActions>
          </div>
        </Stack>
      </form>
    </div>
  );
}

export default function NewPurchaseOrderPage() {
  return (
    <Suspense fallback={null}>
      <NewPurchaseOrderInner />
    </Suspense>
  );
}
