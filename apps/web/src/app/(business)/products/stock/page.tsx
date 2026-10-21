'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, PackageCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useOptionalActingStore } from '@/lib/acting-store';
import { CsvImport } from '@/components/csv-import';
import {
  productDetailColumns,
  productIdentityColumns,
  type ProductColumnFields,
} from '@/components/product-columns';
import { ProductFilterBar, useProductFilters } from '@/components/product-filters';
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
  Field,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  useListColumns,
} from '@/components/ui';

/**
 * Stock by location: one row per SKU at the chosen store (or every
 * store), with the store's own numbers — on hand, reserved, floor
 * samples, available, As-Is, bin — beside every column the Products
 * browser has, behind the same filter strip (owner 2026-10-21). Bins
 * and adjustments act on the row's variant at its location.
 */

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}
/** `/v1/inventory/levels` row: the store's stock plus the product columns. */
interface Level {
  variantId: string;
  locationId: string;
  productId: string;
  productName: string;
  variantSku: string | null;
  variantName: string | null;
  variantBarcode: string | null;
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
  /** False when the row exists only for its As-Is pieces (no stock record to bin). */
  hasLevel?: boolean;
  storageBinId: string | null;
  storageBinCode: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  brandName: string | null;
  collectionName: string | null;
  vendorName: string | null;
  vendorModel: string | null;
  group: string | null;
  size: string | null;
  firmness: string | null;
  priceCents: number | null;
  costCents: number | null;
  purchaseStatus: string;
  productActive: boolean;
  companyOnHand: number;
  companyAvailable: number;
  netOnPo: number;
}
/** A level row shaped for the shared product columns (company stock under the browser's names). */
interface StockRow extends ProductColumnFields {
  level: Level;
  locOnHand: number;
  reserved: number;
  floorSample: number;
  locAvailable: number;
}
interface Bin {
  id: string;
  locationId: string;
  code: string;
  description: string | null;
  isActive: boolean;
}

function toRow(l: Level): StockRow {
  return {
    id: l.productId,
    sku: l.variantSku,
    name: l.productName,
    isActive: l.productActive,
    purchaseStatus: l.purchaseStatus,
    brandName: l.brandName,
    categoryName: l.categoryName,
    categoryPath: l.categoryPath,
    collectionName: l.collectionName,
    vendorName: l.vendorName,
    vendorModel: l.vendorModel,
    group: l.group,
    size: l.size,
    firmness: l.firmness,
    priceCents: l.priceCents,
    costCents: l.costCents,
    onHand: l.companyOnHand,
    available: l.companyAvailable,
    netOnPo: l.netOnPo,
    asIsOnHand: l.asIsOnHand,
    asIsAvailable: l.asIsAvailable,
    asIsNonSellable: l.asIsNonSellable,
    level: l,
    locOnHand: l.onHand,
    reserved: l.reserved,
    floorSample: l.floorSample,
    locAvailable: l.available,
  };
}

export default function InventoryPage() {
  const initial =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>(initial.get('locationId') ?? '');
  const [levels, setLevels] = useState<Level[] | null>(null);
  const [bins, setBins] = useState<Bin[]>([]);
  const [newBin, setNewBin] = useState('');
  const [addingBin, setAddingBin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  // A22 slice 3: the STORIS Stock Adjustment dialog and the Reassign
  // Reservation dialog replace the old prompt() adjust and the
  // release-only reservations popup.
  const [adjustFor, setAdjustFor] = useState<Level | null>(null);
  const [resFor, setResFor] = useState<Level | null>(null);
  // Vendor door (owner 2026-09-02): /products/stock?vendorId=…&locationId=all
  // from the vendors page's "in inventory" count — the hook reads it.
  const f = useProductFilters(initial);

  useEffect(() => {
    api<Location[]>('/v1/business/locations')
      .then((rows) => {
        const active = rows.filter((l) => l.isActive);
        setLocations(active);
        setLocationId((cur) => {
          if (cur === 'all' || active.some((l) => l.id === cur)) return cur;
          return active[0]?.id ?? '';
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const filterParams = f.params;
  const params = useCallback(() => {
    const p = filterParams();
    // 'all' is the combined view: no location filter, bins stay per store.
    if (locationId && locationId !== 'all') p.set('locationId', locationId);
    // The levels endpoint lists every row holding stock unless told to
    // hide retired products, the way the Products browser does by default.
    if (!f.includeInactive) p.set('activeOnly', '1');
    return p;
  }, [filterParams, locationId, f.includeInactive]);

  useEffect(() => {
    if (!locationId) return;
    const mine = ++seq.current;
    // Mirror into the URL (replace, no history spam).
    const u = filterParams();
    u.set('locationId', locationId);
    if (f.vendor) u.set('vendor', f.vendor.name);
    window.history.replaceState(null, '', `?${u.toString()}`);
    const t = setTimeout(
      () => {
        Promise.all([
          api<Level[]>(`/v1/inventory/levels?${params().toString()}`),
          locationId === 'all'
            ? Promise.resolve([] as Bin[])
            : api<Bin[]>(`/v1/inventory/bins?locationId=${locationId}`),
        ])
          .then(([rows, b]) => {
            if (seq.current !== mine) return;
            setLevels(rows);
            setBins(b);
            setError(null);
          })
          .catch((err) => {
            if (seq.current !== mine) return;
            setError(err instanceof Error ? err.message : String(err));
          });
      },
      levels === null ? 0 : 250,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, locationId, tick]);

  const reload = () => setTick((n) => n + 1);

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
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function addBin() {
    const code = newBin.trim();
    if (!code || !locationId || locationId === 'all' || addingBin) return;
    setAddingBin(true);
    try {
      await api('/v1/inventory/bins', {
        method: 'POST',
        body: JSON.stringify({ locationId, code }),
      });
      setNewBin('');
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingBin(false);
    }
  }

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
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const canSeeCost = useOptionalActingStore()?.me?.canSeeCost;
  const showCost = canSeeCost ?? (levels ?? []).some((r) => r.costCents != null);
  const rows = useMemo(() => levels?.map(toRow) ?? null, [levels]);
  const activeBins = bins.filter((b) => b.isActive);

  // The store's own columns sit between the product identity and the
  // company-wide columns. Cells reach the bins list and the dialog
  // setters, so they live in the component (the hook keys on ids).
  const storeColumns: ColumnDef<StockRow>[] = [
    ...(locationId === 'all'
      ? [
          {
            id: 'location',
            label: 'Location',
            sortValue: (r: StockRow) =>
              locations.find((l) => l.id === r.level.locationId)?.name ?? r.level.locationId,
            render: (r: StockRow) =>
              locations.find((l) => l.id === r.level.locationId)?.name ?? '—',
          },
        ]
      : []),
    {
      id: 'barcode',
      label: 'Barcode',
      sortValue: (r) => r.level.variantBarcode,
      render: (r) => <code>{r.level.variantBarcode ?? '—'}</code>,
    },
    {
      id: 'locOnHand',
      label: 'On hand',
      num: true,
      title: 'On hand at this location',
      sortValue: (r) => r.locOnHand,
      render: (r) => r.locOnHand,
    },
    {
      id: 'reserved',
      label: 'Reserved',
      num: true,
      sortValue: (r) => r.reserved,
      render: (r) =>
        r.reserved > 0 ? (
          <button
            type="button"
            className="btn-link"
            title="See which orders hold these units — back order one to sell the piece today, or reserve it elsewhere"
            data-testid="reserved-count"
            onClick={() => setResFor(r.level)}
          >
            {r.reserved}
          </button>
        ) : (
          r.reserved
        ),
    },
    {
      id: 'floor',
      label: 'Floor',
      num: true,
      title: 'Floor samples — on hand but never sellable as new',
      sortValue: (r) => r.floorSample,
      render: (r) => (
        <button
          type="button"
          className="btn-link"
          title="Click to set the floor-sample hold"
          onClick={() => void setFloor(r.level)}
        >
          {r.floorSample > 0 ? r.floorSample : '—'}
        </button>
      ),
    },
    {
      id: 'locAvailable',
      label: 'Available',
      num: true,
      title: 'Available at this location (on hand − reserved − floor)',
      sortValue: (r) => r.locAvailable,
      render: (r) => r.locAvailable,
    },
    {
      id: 'bin',
      label: 'Bin',
      sortValue: (r) => r.level.storageBinCode,
      render: (r) =>
        r.level.hasLevel === false ? (
          <span className="muted">—</span>
        ) : (
          <Select
            value={r.level.storageBinId ?? ''}
            onChange={(e) => void assignBin(r.level, e.target.value || null)}
            aria-label={`Bin for ${r.sku ?? r.name}`}
          >
            <option value="">—</option>
            {bins
              .filter((b) => b.isActive || b.id === r.level.storageBinId)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code}
                </option>
              ))}
          </Select>
        ),
    },
  ];
  const columns: ColumnDef<StockRow>[] = [
    ...productIdentityColumns<StockRow>(),
    ...storeColumns,
    ...productDetailColumns<StockRow>(showCost),
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAdjustFor(r.level)}
          data-testid="stock-adjust"
        >
          Adjust
        </Button>
      ),
    },
  ];
  // v2: the column set changed on 2026-10-21 (product columns added), so
  // a saved order from the old set starts fresh.
  const cols = useListColumns('products-stock-v2', columns, rows);

  const locationPicker = (
    <Field label="Location">
      <Select
        id="inventory-location"
        value={locationId}
        onChange={(e) => setLocationId(e.target.value)}
        data-testid="inventory-location"
      >
        <option value="">— Pick —</option>
        <option value="all">All locations</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <div className="pb">
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

      <section className="pb-card" aria-label="Stock by location">
        <ProductFilterBar
          f={f}
          showCost={showCost}
          before={locationPicker}
          testIdPrefix="stock"
          end={
            cols.isCustom && (
              <Button
                variant="ghost"
                size="sm"
                onClick={cols.reset}
                data-testid="stock-reset-columns"
              >
                Reset columns
              </Button>
            )
          }
        />

        <div className="pb-sheet">
          {error && (
            <div style={{ padding: 12 }}>
              <Alert
                tone="error"
                action={
                  <Button size="sm" onClick={reload}>
                    Retry
                  </Button>
                }
              >
                {error}
              </Alert>
            </div>
          )}
          {!rows && !error && (
            <div style={{ padding: 12 }}>
              <LoadingRows rows={8} height={34} what="Stock" />
            </div>
          )}
          {rows && rows.length === 0 && !f.filtered ? (
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
          ) : (
            rows && (
              <table className="table table-sticky pb-table" data-testid="stock-table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="products-stock" />
                </thead>
                <tbody>
                  {cols.sorted.map((r) => (
                    <tr
                      key={`${r.level.variantId}-${r.level.locationId}`}
                      data-testid="stock-row"
                      className={r.isActive ? undefined : 'is-inactive'}
                    >
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={cols.ordered.length} className="pb-empty">
                        <div className="pb-empty-title">Nothing matches</div>
                        <div>Try fewer words or clear a filter.</div>
                        <Button size="sm" onClick={f.clearAll} style={{ marginTop: 10 }}>
                          Clear filters
                        </Button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )
          )}
        </div>

        <div className="pb-foot" data-testid="stock-footer">
          <span>
            Showing <strong>{rows?.length ?? 0}</strong>
            {locationId === 'all' ? ' rows across every location' : ' SKUs at this location'}
          </span>
          <span>
            On hand, Reserved, Floor, Available, As-Is and Bin are this location&apos;s;{' '}
            <strong>On hand · company</strong>, Net on PO and Available · ATP count every location.
          </span>
          <span>
            Sales margin cost{' '}
            {showCost ? 'shows for your role' : 'hides for roles without cost access'}. Column order
            is saved on this browser.
          </span>
        </div>
      </section>

      <Stack>
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
                  disabled={!newBin.trim() || !locationId || locationId === 'all' || addingBin}
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
              <CsvImport entity="inventory" onCommitted={reload} />
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
          onChanged={reload}
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
          onChanged={reload}
        />
      )}
    </div>
  );
}
