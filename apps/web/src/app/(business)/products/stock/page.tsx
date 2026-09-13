'use client';

import { useEffect, useState } from 'react';
import { ClipboardList, PackageCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { CsvImport } from '@/components/csv-import';
import { ProductsNav } from '@/components/products-nav';
import { ReassignReservationDialog } from '@/components/reassign-reservation-dialog';
import { StockAdjustmentDialog } from '@/components/stock-adjustment-dialog';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
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
  // A22 slice 3: the STORIS Stock Adjustment dialog and the Reassign
  // Reservation dialog replace the old prompt() adjust and the
  // release-only reservations popup.
  const [adjustFor, setAdjustFor] = useState<Level | null>(null);
  const [resFor, setResFor] = useState<Level | null>(null);

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

  const filtered = q.trim() !== '' || vendor != null;
  const activeBins = bins.filter((b) => b.isActive);

  // Cells reach the bins list and the dialog setters, so the columns live
  // in the component (the hook keys on ids, not array identity).
  const STOCK_COLUMNS: ColumnDef<Level>[] = [
    {
      id: 'product',
      label: 'Product',
      sortValue: (l) => l.productName,
      render: (l) => l.productName,
    },
    {
      id: 'sku',
      label: 'SKU',
      sortValue: (l) => l.variantSku,
      render: (l) => <code>{l.variantSku ?? '—'}</code>,
    },
    {
      id: 'barcode',
      label: 'Barcode',
      sortValue: (l) => l.variantBarcode,
      render: (l) => <code>{l.variantBarcode ?? '—'}</code>,
    },
    {
      id: 'onHand',
      label: 'On hand',
      num: true,
      sortValue: (l) => l.onHand,
      render: (l) => l.onHand,
    },
    {
      id: 'reserved',
      label: 'Reserved',
      num: true,
      sortValue: (l) => l.reserved,
      render: (l) =>
        l.reserved > 0 ? (
          <button
            type="button"
            className="btn-link"
            title="See which orders hold these units — back order one to sell the piece today, or reserve it elsewhere"
            data-testid="reserved-count"
            onClick={() => setResFor(l)}
          >
            {l.reserved}
          </button>
        ) : (
          l.reserved
        ),
    },
    {
      id: 'floor',
      label: 'Floor',
      num: true,
      title: 'Floor samples — on hand but never sellable as new',
      sortValue: (l) => l.floorSample,
      render: (l) => (
        <button
          type="button"
          className="btn-link"
          title="Click to set the floor-sample hold"
          onClick={() => void setFloor(l)}
        >
          {l.floorSample > 0 ? l.floorSample : '—'}
        </button>
      ),
    },
    {
      id: 'available',
      label: 'Available',
      num: true,
      sortValue: (l) => l.available,
      render: (l) => l.available,
    },
    {
      id: 'bin',
      label: 'Bin',
      sortValue: (l) => l.storageBinCode,
      render: (l) => (
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
      ),
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (l) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAdjustFor(l)}
          data-testid="stock-adjust"
        >
          Adjust
        </Button>
      ),
    },
  ];
  const cols = useListColumns('products-stock', STOCK_COLUMNS, levels);

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
            aria-label="Search stock by name, SKU, or barcode"
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
                  <ColumnHeadRow list={cols} testIdPrefix="products-stock" />
                </thead>
                <tbody>
                  {levels.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>
                      {q.trim()
                        ? `No stock matches "${q.trim()}" at this location.`
                        : 'No stock from this vendor at this location.'}
                    </TableEmpty>
                  )}
                  {cols.sorted.map((l) => (
                    <tr key={`${l.variantId}-${l.locationId}`}>
                      <ColumnCells list={cols} row={l} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
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

      {adjustFor && (
        <StockAdjustmentDialog
          open
          variantId={adjustFor.variantId}
          locationId={adjustFor.locationId}
          onClose={() => setAdjustFor(null)}
          onChanged={() => void loadLevels(locationId)}
          onReassign={() => {
            setResFor(adjustFor);
            setAdjustFor(null);
          }}
        />
      )}
      {resFor && (
        <ReassignReservationDialog
          open
          variantId={resFor.variantId}
          locationId={resFor.locationId}
          itemLabel={`${resFor.variantSku ?? resFor.productName}`}
          onClose={() => setResFor(null)}
          onChanged={() => void loadLevels(locationId)}
        />
      )}
    </div>
  );
}
