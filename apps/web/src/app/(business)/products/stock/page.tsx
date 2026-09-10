'use client';

import { useEffect, useState } from 'react';
import { ClipboardList, PackageCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { CsvImport } from '@/components/csv-import';
import { ProductsNav } from '@/components/products-nav';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  FormActions,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
} from '@/components/ui';

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}
interface Level {
  variantId: string;
  locationId: string;
  productName: string;
  variantSku: string | null;
  variantName: string | null;
  variantBarcode: string | null;
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  storageBinId: string | null;
  storageBinCode: string | null;
}
interface Bin {
  id: string;
  locationId: string;
  code: string;
  description: string | null;
  isActive: boolean;
}

interface ReservationRow {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  requestedDate: string | null;
  customerName: string | null;
  lineId: string;
  description: string;
  qtyReserved: number;
}

const ADJUST_REASONS = ['count_correction', 'damage', 'theft', 'other'] as const;

export default function InventoryPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  const [locationId, setLocationId] = useState<string>('');
  const [levels, setLevels] = useState<Level[] | null>(null);
  const [bins, setBins] = useState<Bin[]>([]);
  const [q, setQ] = useState('');
  const [newBin, setNewBin] = useState('');
  const [addingBin, setAddingBin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reserved drill-down: which orders hold this variant's committed units.
  const [resFor, setResFor] = useState<Level | null>(null);
  const [reservations, setReservations] = useState<ReservationRow[] | null>(null);

  async function openReservations(level: Level) {
    setResFor(level);
    setReservations(null);
    try {
      setReservations(
        await api<ReservationRow[]>(
          `/v1/inventory/reservations?variantId=${level.variantId}&locationId=${level.locationId}`,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setResFor(null);
    }
  }

  async function releaseReservation(r: ReservationRow) {
    if (
      !confirm(
        `Release ${r.qtyReserved} reserved unit(s) from ${r.orderNumber}? The stock becomes sellable immediately; re-reserve on ${r.orderNumber} from its page when replacement stock lands.`,
      )
    )
      return;
    try {
      await api(`/v1/orders/${r.orderId}/lines/${r.lineId}/release`, { method: 'POST' });
      toast.success(`Released — ${r.orderNumber} now holds no reservation on this item.`);
      if (resFor) await openReservations(resFor);
      await loadLevels(locationId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadLocations() {
    try {
      const rows = await api<Location[]>('/v1/business/locations');
      const active = rows.filter((l) => l.isActive);
      setLocations(active);
      // Vendor door (owner 2026-09-02): /products/stock?vendorId=…&locationId=all
      // from the vendors page's "in inventory" count.
      const sp = new URLSearchParams(window.location.search);
      const vendorId = sp.get('vendorId');
      if (vendorId) setVendor({ id: vendorId, name: sp.get('vendor') ?? 'vendor' });
      const wanted = sp.get('locationId');
      if (wanted === 'all' || (wanted && active.some((l) => l.id === wanted))) {
        setLocationId(wanted);
        return;
      }
      if (active[0] && !locationId) setLocationId(active[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadLevels(loc: string, query = q, v: { id: string } | null = vendor) {
    if (!loc) return;
    try {
      // 'all' is the combined view: no location filter, bins stay per store.
      const params = new URLSearchParams(loc === 'all' ? {} : { locationId: loc });
      if (query.trim()) params.set('q', query.trim());
      if (v) params.set('vendorId', v.id);
      setLevels(await api<Level[]>(`/v1/inventory/levels?${params.toString()}`));
      setBins(loc === 'all' ? [] : await api<Bin[]>(`/v1/inventory/bins?locationId=${loc}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function assignBin(level: Level, storageBinId: string | null) {
    try {
      await api('/v1/inventory/levels/assign-bin', {
        method: 'POST',
        body: JSON.stringify({
          variantId: level.variantId,
          locationId: level.locationId,
          storageBinId,
        }),
      });
      await loadLevels(locationId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function addBin() {
    const code = newBin.trim();
    if (!code || !locationId || addingBin) return;
    setAddingBin(true);
    try {
      await api('/v1/inventory/bins', {
        method: 'POST',
        body: JSON.stringify({ locationId, code }),
      });
      setNewBin('');
      await loadLevels(locationId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingBin(false);
    }
  }

  useEffect(() => {
    void loadLocations();
  }, []);
  useEffect(() => {
    if (locationId) void loadLevels(locationId);
  }, [locationId]);

  /** J2: hold N units as floor samples — on hand but never sellable. */
  async function setFloor(level: Level) {
    const qtyStr = prompt(
      `Floor-sample hold for ${level.variantSku ?? level.productName} (currently ${level.floorSample} of ${level.onHand} on hand). Set to:`,
      String(level.floorSample),
    );
    if (qtyStr == null) return;
    const quantity = Number(qtyStr);
    if (!Number.isInteger(quantity) || quantity < 0) {
      toast.error('Enter a whole number ≥ 0');
      return;
    }
    try {
      await api('/v1/inventory/levels/floor-sample', {
        method: 'POST',
        body: JSON.stringify({
          variantId: level.variantId,
          locationId: level.locationId,
          quantity,
        }),
      });
      await loadLevels(locationId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function adjust(level: Level) {
    const deltaStr = prompt(
      `Adjust ${level.variantSku ?? level.productName} (current ${level.onHand}). Delta:`,
      '0',
    );
    if (!deltaStr) return;
    const delta = Number(deltaStr);
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error('delta must be a non-zero integer');
      return;
    }
    const reason = prompt(`Reason (${ADJUST_REASONS.join(', ')}):`, 'count_correction');
    if (!reason) return;
    const notes = prompt('Optional notes:', '') ?? undefined;
    try {
      await api('/v1/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify({
          variantId: level.variantId,
          locationId: level.locationId,
          delta,
          reason,
          notes: notes || undefined,
        }),
      });
      await loadLevels(locationId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const filtered = q.trim() !== '' || vendor != null;
  const activeBins = bins.filter((b) => b.isActive);

  return (
    <div>
      <PageHeader
        title="Stock by location"
        actions={
          <>
            <LinkButton href="/products/counts" variant="secondary" size="sm">
              <ClipboardList size={14} />
              Count stock
            </LinkButton>
            <LinkButton href="/products/receive" variant="primary">
              <PackageCheck size={14} />
              Receive
            </LinkButton>
          </>
        }
      />
      <ProductsNav />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void loadLevels(locationId);
        }}
      >
        <Toolbar>
          <label htmlFor="inventory-location" className="muted">
            Location
          </label>
          <Select
            id="inventory-location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value="">— Pick —</option>
            <option value="all">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          {vendor && (
            <span className="muted" data-testid="inventory-vendor-chip">
              Vendor: <strong>{vendor.name}</strong>{' '}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setVendor(null);
                  window.history.replaceState(null, '', '/products/stock');
                  void loadLevels(locationId, q, null);
                }}
              >
                clear
              </Button>
            </span>
          )}
          <Input
            name="q"
            placeholder="Search by name, SKU, or barcode"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('');
              void loadLevels(locationId, '');
            }}
          >
            Clear
          </Button>
        </Toolbar>
      </form>

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        {levels == null ? (
          <Card>
            <LoadingRows />
          </Card>
        ) : levels.length === 0 && !filtered ? (
          <Card>
            <EmptyState
              title="No stock at this location yet"
              action={
                <LinkButton size="sm" href="/products/receive">
                  Receive
                </LinkButton>
              }
            >
              Use Receive to add some.
            </EmptyState>
          </Card>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU</th>
                    <th>Barcode</th>
                    <th className="num">On hand</th>
                    <th className="num">Reserved</th>
                    <th className="num" title="Floor samples — on hand but never sellable as new">
                      Floor
                    </th>
                    <th className="num">Available</th>
                    <th>Bin</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {levels.length === 0 && (
                    <TableEmpty colSpan={9}>
                      {q.trim()
                        ? `No stock matches "${q.trim()}" at this location.`
                        : 'No stock from this vendor at this location.'}
                    </TableEmpty>
                  )}
                  {levels.map((l) => (
                    <tr key={`${l.variantId}-${l.locationId}`}>
                      <td>{l.productName}</td>
                      <td>
                        <code>{l.variantSku ?? '—'}</code>
                      </td>
                      <td>
                        <code>{l.variantBarcode ?? '—'}</code>
                      </td>
                      <td className="num">{l.onHand}</td>
                      <td className="num">
                        {l.reserved > 0 ? (
                          <button
                            type="button"
                            className="btn-link"
                            title="See which orders hold these units — release from there to sell the piece today"
                            data-testid="reserved-count"
                            onClick={() => void openReservations(l)}
                          >
                            {l.reserved}
                          </button>
                        ) : (
                          l.reserved
                        )}
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn-link"
                          title="Click to set the floor-sample hold"
                          onClick={() => void setFloor(l)}
                        >
                          {l.floorSample > 0 ? l.floorSample : '—'}
                        </button>
                      </td>
                      <td className="num">{l.available}</td>
                      <td>
                        <Select
                          value={l.storageBinId ?? ''}
                          onChange={(e) => void assignBin(l, e.target.value || null)}
                          aria-label={`Bin for ${l.variantSku ?? l.productName}`}
                        >
                          <option value="">—</option>
                          {bins
                            .filter((b) => b.isActive || b.id === l.storageBinId)
                            .map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.code}
                              </option>
                            ))}
                        </Select>
                      </td>
                      <td className="actions">
                        <Button size="sm" variant="ghost" onClick={() => adjust(l)}>
                          Adjust
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        )}

        <Card>
          <details data-testid="inventory-bins">
            <summary className="card-title">
              Storage bins at this location ({activeBins.length})
            </summary>
            <Stack gap="sm">
              <p className="card-desc">
                Bins are named slots inside the warehouse (DOCK, A-14). Assign one per stock row
                above and the pick list prints it.
              </p>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addBin();
                }}
              >
                <Input
                  placeholder="New bin code…"
                  aria-label="New bin code"
                  value={newBin}
                  onChange={(e) => setNewBin(e.target.value)}
                  className="w-40"
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  disabled={!newBin.trim() || !locationId || addingBin}
                >
                  {addingBin ? 'Adding…' : 'Add bin'}
                </Button>
              </form>
              {bins.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {bins.map((b) => (
                    <span
                      key={b.id}
                      className={`badge ${b.isActive ? 'badge-neutral' : 'badge-warning'}`}
                    >
                      {b.code}
                      {!b.isActive && ' (inactive)'}
                    </span>
                  ))}
                </div>
              )}
            </Stack>
          </details>
        </Card>

        <Card>
          <details data-testid="inventory-csv-import">
            <summary className="card-title">Import on-hand counts from a CSV file</summary>
            <Stack gap="sm">
              <p className="card-desc">
                One row per SKU per location (columns like SKU, LOCATION, ON_HAND, UNIT_COST — the
                location must match a store name exactly). Products must exist first; import the
                product file on the Products page if they don&apos;t.
              </p>
              <CsvImport
                entity="inventory"
                onCommitted={() => (locationId ? loadLevels(locationId) : undefined)}
              />
            </Stack>
          </details>
        </Card>
      </Stack>

      {resFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="reservations-dialog"
        >
          <Card
            className="w-full max-w-[640px]"
            title={`Reserved — ${resFor.productName}${resFor.variantSku ? ` (${resFor.variantSku})` : ''}`}
            description="These orders hold the committed units. Release one to sell the piece today, then re-reserve it on that order from its page when replacement stock lands."
          >
            {!reservations ? (
              <LoadingRows rows={2} />
            ) : reservations.length === 0 ? (
              <EmptyState>No live orders hold this item here.</EmptyState>
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Customer</th>
                      <th>Promised</th>
                      <th className="num">Reserved</th>
                      <th className="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {reservations.map((r) => (
                      <tr key={r.lineId}>
                        <td>
                          <a href={`/orders/${r.orderId}`}>{r.orderNumber}</a>
                        </td>
                        <td>{r.customerName ?? '—'}</td>
                        <td>{r.requestedDate ?? '—'}</td>
                        <td className="num">{r.qtyReserved}</td>
                        <td className="actions">
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => void releaseReservation(r)}
                            data-testid="release-reservation"
                          >
                            Release
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            <FormActions>
              <Button variant="secondary" onClick={() => setResFor(null)}>
                Close
              </Button>
            </FormActions>
          </Card>
        </div>
      )}
    </div>
  );
}
