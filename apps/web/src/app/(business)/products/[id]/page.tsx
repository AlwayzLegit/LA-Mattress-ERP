'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  centsToInputString,
  FIRMNESS_LEVELS,
  MATTRESS_SIZES,
  PRODUCT_PURCHASE_STATUS_LABELS,
  PRODUCT_PURCHASE_STATUSES,
  type ProductPurchaseStatus,
} from '@jetnine/shared';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import { ProductsNav } from '@/components/products-nav';
import { ReassignReservationDialog } from '@/components/reassign-reservation-dialog';
import { StockAdjustmentDialog } from '@/components/stock-adjustment-dialog';
import { AdjustStockDialog } from '@/components/adjust-stock-dialog';
import { StatusChip } from '@/components/ui';
import type { PurchaseOrderRow } from './activity/types';
import { AsIsPanel } from './activity/as-is-panel';
import { AtpCard } from './activity/atp-card';
import { GeneralPanel } from './activity/general-panel';
import { InventoryDetailPanel } from './activity/inventory-detail-panel';
import { fmtDate } from './activity/kit';
import { OpenOrdersPanel } from './activity/open-orders-panel';
import { PurchaseOrdersPanel } from './activity/purchase-orders-panel';
import { SalesHistoryPanel } from './activity/sales-history-panel';
import { SerialsPanel } from './activity/serials-panel';
import { SummaryPanel } from './activity/summary-panel';
import { TransfersPanel } from './activity/transfers-panel';
import { PRODUCT_TABS, type AtpResult, type ProductTab, type Shipping } from './activity/types';
import {
  Alert,
  BackLink,
  Button,
  Card,
  Field,
  FormGrid,
  Input,
  KeyValue,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  StatGrid,
  StatTile,
  StatusBadge,
  TableEmpty,
  TableWrap,
} from '@/components/ui';

interface Variant {
  id: string;
  sku: string | null;
  name: string | null;
  barcode: string | null;
  priceCents: number;
  costCents: number | null;
  /** A22.2: canonical size / firmness, null when the item fits several sizes or has none. */
  size: string | null;
  firmness: string | null;
  isActive: boolean;
  reorderPoint: number | null;
  reorderQty: number | null;
  preferredVendorId: string | null;
  vendorSku: string | null;
}
interface Vendor {
  id: string;
  name: string;
}
interface ProductImage {
  id: string;
  storageKey: string;
  altText: string | null;
  position: number;
}
/** Stock the STORIS View Product Activity screen shows (amendment A19). */
interface StockTotals {
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  netOnPo: number;
  totalPo: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
  layawayReserved: number;
  /** A21 D3: open PO units already allocated to order lines. */
  onOrderReserved: number;
}
interface LocationStockRow extends StockTotals {
  variantId: string;
  variantSku: string | null;
  variantActive: boolean;
  locationId: string;
  locationName: string;
  locationActive: boolean;
  storageBinId: string | null;
  storageBinCode: string | null;
  reorderPoint: number | null;
}
interface Product {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  taxClassId: string | null;
  brandId: string | null;
  collectionId: string | null;
  isActive: boolean;
  variants: Variant[];
  images: ProductImage[];
  // STORIS Advanced Product Settings (A19).
  secondDescription: string | null;
  purchaseStatus: ProductPurchaseStatus | string;
  boxesPerProduct: number;
  logisticalCartonQty: number;
  purchaseCartonQty: number;
  logisticalCartonTransfers: boolean;
  brandName: string | null;
  categoryName: string | null;
  categoryPath?: string | null;
  collectionName: string | null;
  vendorName: string | null;
  vendorModel: string | null;
  group: string | null;
  size: string | null;
  firmness: string | null;
  // A21 General Information (D9) + serial tracking for the Serial/Reference tab.
  serialTracked: boolean;
  suggestedRetailCents: number | null;
  shipping: Shipping;
  stock: { totals: StockTotals; byLocation: LocationStockRow[] };
}

interface RefEntity {
  id: string;
  name: string;
  isActive: boolean;
}
interface TaxClass {
  id: string;
  name: string;
  rateBps: number;
}

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = (params?.id ?? '') as string;
  const [p, setP] = useState<Product | null>(null);
  const [taxClasses, setTaxClasses] = useState<TaxClass[]>([]);
  const [brands, setBrands] = useState<RefEntity[]>([]);
  const [collections, setCollections] = useState<RefEntity[]>([]);
  const [newBrand, setNewBrand] = useState('');
  const [newCollection, setNewCollection] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A21: the STORIS View Product Activity section list; the picked one
  // lives in the URL so a reload or a shared link lands on the same tab.
  const [tab, setTab] = useState<ProductTab>('availability');
  const [atp, setAtp] = useState<AtpResult | null>(null);
  // Redesign Phase 7 (README §3.3): the quick Adjust dialog, the counts
  // on the activity tabs, and the open POs behind "Next promise".
  const [quickAdjustAt, setQuickAdjustAt] = useState<string | null | false>(false);
  const [counts, setCounts] = useState<Partial<Record<ProductTab, number>>>({});
  const [poRows, setPoRows] = useState<PurchaseOrderRow[]>([]);

  useEffect(() => {
    if (!id) return;
    const count = (url: string, key: ProductTab) =>
      api<{ rows?: unknown[] } | unknown[]>(url)
        .then((r) => {
          const n = Array.isArray(r) ? r.length : Array.isArray(r.rows) ? r.rows.length : null;
          if (n != null) setCounts((c) => ({ ...c, [key]: n }));
        })
        .catch(() => undefined);
    void count(`/v1/products/${id}/activity/open-orders`, 'open-orders');
    void api<{ rows: PurchaseOrderRow[] }>(`/v1/products/${id}/activity/purchase-orders`)
      .then((r) => {
        setPoRows(r.rows ?? []);
        setCounts((c) => ({ ...c, 'purchase-orders': (r.rows ?? []).length }));
      })
      .catch(() => undefined);
    void count(`/v1/products/${id}/activity/transfers?direction=in`, 'inbound');
    void count(`/v1/products/${id}/activity/transfers?direction=out`, 'outbound');
    void count(`/v1/products/${id}/activity/as-is`, 'as-is');
    void count(`/v1/products/${id}/activity/serials`, 'serials');
  }, [id]);

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('tab');
    if (initial && PRODUCT_TABS.some((t) => t.key === initial)) setTab(initial as ProductTab);
  }, []);

  function pickTab(next: ProductTab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url.toString());
  }

  async function load() {
    try {
      setP(await api<Product>(`/v1/products/${id}`));
      // Tax classes are gated by business.settings.view; if the
      // current user doesn't have it, just silently render the
      // picker as read-only.
      try {
        setTaxClasses(await api<TaxClass[]>('/v1/business/tax-classes'));
      } catch {
        setTaxClasses([]);
      }
      try {
        setBrands(await api<RefEntity[]>('/v1/brands'));
        setCollections(await api<RefEntity[]>('/v1/collections'));
      } catch {
        setBrands([]);
        setCollections([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function setTaxClass(taxClassId: string | null) {
    try {
      await api(`/v1/products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ taxClassId }),
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function patchProduct(patch: Record<string, unknown>) {
    try {
      await api(`/v1/products/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function createAndAssign(kind: 'brand' | 'collection', name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const created = await api<{ id: string }>(
        kind === 'brand' ? '/v1/brands' : '/v1/collections',
        {
          method: 'POST',
          body: JSON.stringify({ name: trimmed }),
        },
      );
      await api(`/v1/products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(
          kind === 'brand' ? { brandId: created.id } : { collectionId: created.id },
        ),
      });
      if (kind === 'brand') setNewBrand('');
      else setNewCollection('');
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // A22.2: size and firmness live on the variant; any spelling the API
  // knows ("cal king", "CK") lands as the canonical label.
  async function setVariantSizing(variantId: string, patch: { size?: string; firmness?: string }) {
    try {
      await api(`/v1/products/variants/${variantId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(patch.size !== undefined ? { size: patch.size || null } : {}),
          ...(patch.firmness !== undefined ? { firmness: patch.firmness || null } : {}),
        }),
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function setVariantPrice(variantId: string, dollars: string) {
    try {
      const cents = Math.round(Number(dollars) * 100);
      await api(`/v1/products/variants/${variantId}/price`, {
        method: 'PATCH',
        body: JSON.stringify({ priceCents: cents }),
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Product-level switch (owner ask 2026-08-30): deactivating hides the
  // product from search and New Sale everywhere; every existing document
  // keeps its lines. Reactivate brings it right back.
  async function toggleProductActive() {
    if (!p) return;
    if (
      p.isActive &&
      !confirm(
        `Deactivate ${p.name}? It disappears from product search and New Sale; ` +
          'existing orders and receipts are untouched. You can reactivate it here anytime.',
      )
    )
      return;
    await patchProduct({ isActive: !p.isActive });
    toast.success(p.isActive ? 'Product deactivated' : 'Product reactivated');
  }

  // Full delete — the server refuses (with the reason) if the product
  // still has stock or appears on any document; junk and duplicates go.
  async function deleteProduct() {
    if (!p) return;
    if (!confirm(`Permanently delete ${p.name} and all its variants? This cannot be undone.`))
      return;
    try {
      await api(`/v1/products/${id}`, { method: 'DELETE' });
      toast.success('Product deleted');
      router.push('/products');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function deactivateVariant(variantId: string) {
    if (!confirm('Deactivate this variant?')) return;
    try {
      await api(`/v1/products/variants/${variantId}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function registerImage() {
    const contentType = prompt('Content type', 'image/png');
    if (!contentType) return;
    try {
      const url = await api<{ uploadUrl: string; storageKey: string }>(
        `/v1/products/${id}/images/upload-url`,
        {
          method: 'POST',
          body: JSON.stringify({ contentType }),
        },
      );
      // In production the client uploads to url.uploadUrl with PUT; here
      // we just register the key (the test environment uses a placeholder
      // upload URL, and most dev runs don't need to transfer bytes).
      await api(`/v1/products/${id}/images`, {
        method: 'POST',
        body: JSON.stringify({ storageKey: url.storageKey }),
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteImage(imageId: string) {
    if (!confirm('Delete this image?')) return;
    try {
      await api(`/v1/products/images/${imageId}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Location availability actions (A19 → A22 slice 3): the STORIS Stock
  // Adjustment dialog and Reassign Reservation open on this product's row.
  const [adjustFor, setAdjustFor] = useState<LocationStockRow | null>(null);
  const [reassignFor, setReassignFor] = useState<LocationStockRow | null>(null);

  async function setFloorAt(row: LocationStockRow) {
    const qtyStr = prompt(
      `Floor-sample hold at ${row.locationName} (currently ${row.floorSample} of ${row.onHand} on hand). Set to:`,
      String(row.floorSample),
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
        body: JSON.stringify({ variantId: row.variantId, locationId: row.locationId, quantity }),
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function primaryVariant(product: Product): Variant | undefined {
    return (
      product.variants.find((v) => v.sku && v.sku === product.sku) ??
      product.variants.find((v) => v.isActive) ??
      product.variants[0]
    );
  }

  const atpFor = (locationId: string) => atp?.byLocation.find((l) => l.locationId === locationId);

  if (error)
    return (
      <div>
        <PageHeader
          eyebrow={<BackLink href="/products">All products</BackLink>}
          title="Product not found"
        />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  if (!p) return <LoadingRows rows={5} />;

  return (
    <div>
      {(() => {
        const v = primaryVariant(p);
        const identity = [
          p.vendorName,
          p.vendorModel,
          p.categoryPath ?? p.categoryName,
          v?.size ?? p.size,
          v?.firmness ?? p.firmness,
          v ? `Price ${centsToInputString(v.priceCents).replace(/^/, '$')}` : null,
        ].filter(Boolean);
        return (
          <header className="pp-head" data-testid="product-header">
            <div>
              <div className="pp-crumb">
                <Link href="/products">Products</Link> / {p.name}
              </div>
              <div className="pp-title-row">
                <h1 className="pp-title">{p.name}</h1>
                <span className="pp-sku">
                  <code>{p.sku ?? '—'}</code>
                </span>
                <StatusChip
                  status={p.isActive ? 'fulfilled' : 'cancelled'}
                  label={p.isActive ? 'Active' : 'Inactive'}
                />
                {p.purchaseStatus !== 'active' && <StatusBadge status={String(p.purchaseStatus)} />}
              </div>
              <div className="pp-identity">
                {identity.join(' · ')}
                {p.secondDescription ? ` · ${p.secondDescription}` : ''}
              </div>
            </div>
            <div className="pp-actions">
              <Button
                size="sm"
                variant="primary"
                onClick={() => setQuickAdjustAt(null)}
                disabled={!v}
                data-testid="product-adjust-stock"
              >
                Adjust stock
              </Button>
              <Button
                size="sm"
                onClick={() => router.push(`/transfers/new${v ? `?variantId=${v.id}` : ''}`)}
                data-testid="product-transfer"
              >
                Transfer
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  router.push(`/products/labels${p.sku ? `?q=${encodeURIComponent(p.sku)}` : ''}`)
                }
                data-testid="product-print-label"
              >
                Print label
              </Button>
              <Button size="sm" onClick={() => pickTab('general')} data-testid="product-edit">
                Edit product
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void toggleProductActive()}
                data-testid="product-toggle-active"
              >
                {p.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                onClick={() => void deleteProduct()}
                data-testid="product-delete"
              >
                Delete…
              </Button>
            </div>
          </header>
        );
      })()}

      <ProductsNav />

      {(() => {
        // "Where it is" (canvas 6b): one row per location, every variant summed,
        // with the store minimum and the next promise for a customer.
        const byLoc = new Map<
          string,
          {
            locationId: string;
            locationName: string;
            onHand: number;
            reserved: number;
            floorSample: number;
            available: number;
            netOnPo: number;
            min: number | null;
            skus: string[];
          }
        >();
        for (const r of p.stock.byLocation) {
          const cur = byLoc.get(r.locationId) ?? {
            locationId: r.locationId,
            locationName: r.locationName,
            onHand: 0,
            reserved: 0,
            floorSample: 0,
            available: 0,
            netOnPo: 0,
            min: null as number | null,
            skus: [] as string[],
          };
          cur.onHand += r.onHand;
          cur.reserved += r.reserved;
          cur.floorSample += r.floorSample;
          cur.available += r.available;
          cur.netOnPo += r.netOnPo;
          if (r.reorderPoint != null) cur.min = Math.max(cur.min ?? 0, r.reorderPoint);
          if (r.variantSku) cur.skus.push(r.variantSku);
          byLoc.set(r.locationId, cur);
        }
        const rows = [...byLoc.values()];
        const anyAvail = rows
          .filter((r) => r.available > 0)
          .sort((a, b) => b.available - a.available);
        const promise = (r: (typeof rows)[number]) => {
          if (r.available > 0) return { text: 'Today', now: true };
          // Only a placed merchandise PO is a promise: drafts are not
          // ordered yet and direct-ship stock never reaches the store.
          const po = poRows
            .filter(
              (x) =>
                x.receivingLocationId === r.locationId &&
                x.quantityDue > 0 &&
                x.transactionType === 'merchandise' &&
                (x.status === 'ordered' || x.status === 'partially_received'),
            )
            .sort((a, b) => (a.expectedAt ?? '9999').localeCompare(b.expectedAt ?? '9999'))[0];
          if (po) return { text: `${fmtDate(po.expectedAt)} · ${po.number}`, now: false };
          const src = anyAvail.find((x) => x.locationId !== r.locationId);
          if (src) return { text: `Transfer from ${src.locationName} · 2 days`, now: false };
          if (p.purchaseStatus === 'special_order')
            return { text: 'Special order · ~3 weeks', now: false };
          if (p.purchaseStatus === 'discontinued')
            return { text: 'Discontinued — none coming', now: false };
          return { text: 'Order from vendor', now: false };
        };
        const tone = (r: (typeof rows)[number]) =>
          r.available <= 0 && r.reserved > 0
            ? 'is-risk'
            : r.available <= 0
              ? 'is-zero'
              : r.min != null && r.available < r.min
                ? 'is-waiting'
                : 'is-ok';
        const totalAtp = p.stock.totals.available + p.stock.totals.netOnPo;
        const v = primaryVariant(p);
        return (
          <section className="pp-where" aria-label="Where it is" data-testid="product-where">
            <div className="pp-where-head">
              <h2>Where it is</h2>
              <span className="pp-where-sub">
                available = on hand − reserved · ATP = available + inbound on PO
              </span>
              <span className="pp-where-total" data-testid="product-company-totals">
                Company: <strong>{p.stock.totals.available}</strong> available ·{' '}
                <strong>{totalAtp}</strong> ATP
                {p.stock.totals.reserved > 0 ? ` · ${p.stock.totals.reserved} reserved` : ''}
              </span>
            </div>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th className="num">On hand</th>
                    <th className="num">Reserved</th>
                    <th className="num">Floor</th>
                    <th className="num">Available</th>
                    <th className="num">On PO</th>
                    <th className="num">ATP</th>
                    <th className="num">Min</th>
                    <th>Next promise</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <TableEmpty colSpan={10}>No active locations or variants.</TableEmpty>
                  )}
                  {rows.map((r) => {
                    const pr = promise(r);
                    return (
                      <tr key={r.locationId} data-testid="where-row">
                        <td>
                          <span className="pp-where-loc">{r.locationName}</span>
                          {r.skus.length === 1 && <span className="pp-where-sku">{r.skus[0]}</span>}
                        </td>
                        <td className="num pp-num">{r.onHand}</td>
                        <td className="num pp-num">{r.reserved}</td>
                        <td className="num pp-num">{r.floorSample}</td>
                        <td className={`num pp-num ${tone(r)}`} data-testid="where-available">
                          {r.available}
                        </td>
                        <td className="num pp-num">{r.netOnPo}</td>
                        <td className="num pp-num">{r.available + r.netOnPo}</td>
                        <td className="num pp-num">{r.min ?? '—'}</td>
                        <td
                          className={`pp-promise${pr.now ? ' is-now' : ''}`}
                          data-testid="where-promise"
                        >
                          {pr.text}
                        </td>
                        <td className="actions">
                          <Button
                            size="sm"
                            onClick={() => setQuickAdjustAt(r.locationId)}
                            disabled={!v}
                            data-testid="where-adjust"
                          >
                            Adjust
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </section>
        );
      })()}

      <nav className="pp-tabs" aria-label="Product activity views" data-testid="product-tabs">
        {PRODUCT_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="pp-tab"
            onClick={() => pickTab(t.key)}
            aria-current={t.key === tab ? 'page' : undefined}
            data-testid={`product-tab-${t.key}`}
          >
            {t.key === 'availability'
              ? 'Availability detail'
              : t.key === 'general'
                ? 'Edit product'
                : t.label}
            {counts[t.key] != null && <span className="pp-tab-count">{counts[t.key]}</span>}
          </button>
        ))}
      </nav>

      <div>
        <div className="min-w-0">
          {tab === 'availability' && (
            <Stack>
              <AtpCard productId={id} onResult={setAtp} />
              <StatGrid cols={6} data-testid="product-stock-totals">
                <StatTile label="On hand" value={p.stock.totals.onHand} />
                <StatTile
                  label="Net available"
                  value={p.stock.totals.available}
                  sub={`${p.stock.totals.reserved} reserved · ${p.stock.totals.floorSample} floor`}
                  tone={p.stock.totals.available > 0 ? 'success' : undefined}
                />
                <StatTile label="As-Is" value={p.stock.totals.asIsOnHand} />
                <StatTile
                  label="As-Is available"
                  value={p.stock.totals.asIsAvailable}
                  sub={`${p.stock.totals.asIsNonSellable} non-sellable`}
                />
                <StatTile label="Net PO" value={p.stock.totals.netOnPo} />
                <StatTile label="Total PO" value={p.stock.totals.totalPo} />
              </StatGrid>

              <Card title="Merchandising" data-testid="product-merchandising">
                {(() => {
                  const v = primaryVariant(p);
                  return (
                    <KeyValue
                      rows={[
                        {
                          label: 'Selling price',
                          value: v ? (
                            <Input
                              defaultValue={centsToInputString(v.priceCents)}
                              type="number"
                              step="0.01"
                              aria-label="Selling price"
                              data-testid="selling-price"
                              onBlur={(e) => {
                                if (e.target.value !== centsToInputString(v.priceCents)) {
                                  void setVariantPrice(v.id, e.target.value);
                                }
                              }}
                              className="w-28"
                            />
                          ) : (
                            '—'
                          ),
                        },
                        {
                          label: 'Sales margin cost',
                          value:
                            v?.costCents != null ? (
                              <Money cents={v.costCents} />
                            ) : (
                              <em className="muted">hidden</em>
                            ),
                        },
                        {
                          label: 'Suggested retail price',
                          value: (
                            <Input
                              defaultValue={
                                p.suggestedRetailCents != null
                                  ? centsToInputString(p.suggestedRetailCents)
                                  : ''
                              }
                              type="number"
                              step="0.01"
                              min={0}
                              aria-label="Suggested retail price"
                              data-testid="merch-suggested-retail"
                              className="w-28"
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                const next = raw === '' ? null : Math.round(Number(raw) * 100);
                                if (next !== null && (!Number.isInteger(next) || next < 0)) return;
                                if (next !== p.suggestedRetailCents)
                                  void patchProduct({ suggestedRetailCents: next });
                              }}
                            />
                          ),
                        },
                        {
                          label: 'Purchase status',
                          value: (
                            <Select
                              value={p.purchaseStatus}
                              aria-label="Purchase status"
                              data-testid="purchase-status"
                              onChange={(e) =>
                                void patchProduct({ purchaseStatus: e.target.value })
                              }
                            >
                              {PRODUCT_PURCHASE_STATUSES.map((st) => (
                                <option key={st} value={st}>
                                  {PRODUCT_PURCHASE_STATUS_LABELS[st]}
                                </option>
                              ))}
                            </Select>
                          ),
                        },
                        {
                          label: 'Product status',
                          value: <StatusBadge status={p.isActive ? 'active' : 'inactive'} />,
                        },
                        { label: 'Layaway reserved', value: p.stock.totals.layawayReserved },
                      ]}
                    />
                  );
                })()}
              </Card>

              <Card title="Location availability" flush data-testid="product-locations">
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Location</th>
                        <th>SKU</th>
                        <th>ATP date</th>
                        <th className="num">ATP quantity</th>
                        <th className="num">On hand</th>
                        <th className="num">Net available</th>
                        <th className="num">Reserved</th>
                        <th className="num">Floor</th>
                        <th className="num">Net PO</th>
                        <th className="num">As-Is</th>
                        <th className="num">As-Is available</th>
                        <th className="num" title="As-is pieces have no reservation state (A21 D4)">
                          As-Is reserved
                        </th>
                        <th className="num">As-Is non-sellable</th>
                        <th className="num">On order reserved</th>
                        <th className="num">Layaway reserved</th>
                        <th className="num">Total PO</th>
                        <th>Bin</th>
                        <th className="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {p.stock.byLocation.length === 0 && (
                        <TableEmpty colSpan={18}>No active locations or variants.</TableEmpty>
                      )}
                      {p.stock.byLocation.map((row) => (
                        <tr
                          key={`${row.variantId}:${row.locationId}`}
                          data-testid="product-location-row"
                        >
                          <td>
                            {row.locationName}
                            {!row.locationActive && (
                              <>
                                {' '}
                                <StatusBadge status="inactive" />
                              </>
                            )}
                          </td>
                          <td>
                            <code>{row.variantSku ?? '—'}</code>
                            {!row.variantActive && (
                              <>
                                {' '}
                                <StatusBadge status="inactive" />
                              </>
                            )}
                          </td>
                          <td data-testid="location-atp-date">
                            {atp ? fmtDate(atpFor(row.locationId)?.atpDate ?? null) : '…'}
                          </td>
                          <td className="num">{atpFor(row.locationId)?.atpQuantity ?? '—'}</td>
                          <td className="num">{row.onHand}</td>
                          <td className="num">{row.available}</td>
                          <td className="num">
                            {row.reserved > 0 ? (
                              <button
                                type="button"
                                className="btn-link"
                                title="Who holds these units — back order or reserve from here"
                                data-testid="product-reserved-count"
                                onClick={() => setReassignFor(row)}
                              >
                                {row.reserved}
                              </button>
                            ) : (
                              row.reserved
                            )}
                          </td>
                          <td className="num">{row.floorSample}</td>
                          <td className="num">{row.netOnPo}</td>
                          <td className="num">{row.asIsOnHand}</td>
                          <td className="num">{row.asIsAvailable}</td>
                          <td className="num">0</td>
                          <td className="num">{row.asIsNonSellable}</td>
                          <td className="num">{row.onOrderReserved}</td>
                          <td className="num">{row.layawayReserved}</td>
                          <td className="num">{row.totalPo}</td>
                          <td>{row.storageBinCode ?? '—'}</td>
                          <td className="actions">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setAdjustFor(row)}
                              data-testid="product-stock-adjust"
                            >
                              Adjust
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => void setFloorAt(row)}>
                              Floor sample
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Card>
            </Stack>
          )}

          {tab === 'purchase-orders' && <PurchaseOrdersPanel productId={id} />}
          {tab === 'open-orders' && <OpenOrdersPanel productId={id} />}
          {tab === 'sales-history' && <SalesHistoryPanel productId={id} />}
          {tab === 'inbound' && <TransfersPanel productId={id} direction="in" />}
          {tab === 'outbound' && <TransfersPanel productId={id} direction="out" />}
          {tab === 'serials' && (
            <SerialsPanel
              productId={id}
              onEnableTracking={
                p.serialTracked ? undefined : () => void patchProduct({ serialTracked: true })
              }
            />
          )}
          {tab === 'as-is' && <AsIsPanel productId={id} />}
          {tab === 'summary' && <SummaryPanel productId={id} />}
          {tab === 'as-is-detail' && <InventoryDetailPanel productId={id} kind="as_is" />}
          {tab === 'regular-detail' && <InventoryDetailPanel productId={id} kind="regular" />}
          {tab === 'carts' && <OpenOrdersPanel productId={id} initialOrderType="quote" />}

          {tab === 'general' && (
            <Stack>
              <GeneralPanel product={p} primary={primaryVariant(p)} patchProduct={patchProduct} />
              <Card
                title="Descriptive"
                description="What STORIS calls Description, Second Description, Brand, Vendor Model, Vendor and Group."
                data-testid="product-descriptive"
              >
                <FormGrid cols={2}>
                  <Field label="Description">
                    <Input
                      defaultValue={p.name}
                      aria-label="Description"
                      data-testid="product-name"
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next && next !== p.name) void patchProduct({ name: next });
                      }}
                    />
                  </Field>
                  <Field label="Second description">
                    <Input
                      defaultValue={p.secondDescription ?? ''}
                      aria-label="Second description"
                      data-testid="second-description"
                      onBlur={(e) => {
                        const next = e.target.value.trim() || null;
                        if (next !== p.secondDescription)
                          void patchProduct({ secondDescription: next });
                      }}
                    />
                  </Field>
                  <Field label="Brand" hint="Change it in Brand & collection below.">
                    <Input value={p.brandName ?? ''} readOnly aria-label="Brand" />
                  </Field>
                  <Field label="Vendor model" hint="Edit on the Reorder automation card.">
                    <Input value={p.vendorModel ?? ''} readOnly aria-label="Vendor model" />
                  </Field>
                  <Field label="Vendor" hint="The preferred vendor on the Reorder automation card.">
                    <Input value={p.vendorName ?? ''} readOnly aria-label="Vendor" />
                  </Field>
                  <Field label="Group" hint="STORIS size / product group from the import.">
                    <Input value={p.group ?? ''} readOnly aria-label="Group" />
                  </Field>
                  <Field label="Size" hint="Set per variant in the Variants card below.">
                    <Input value={p.size ?? ''} readOnly aria-label="Size" />
                  </Field>
                  <Field label="Firmness" hint="Set per variant in the Variants card below.">
                    <Input value={p.firmness ?? ''} readOnly aria-label="Firmness" />
                  </Field>
                  <Field label="Category">
                    <Input value={p.categoryName ?? ''} readOnly aria-label="Category" />
                  </Field>
                </FormGrid>
              </Card>

              <Card
                title="Purchase status & packing"
                description="Whether the buyer may still order it, and the box and carton multiples it moves in."
                data-testid="product-packing"
              >
                <FormGrid cols={2}>
                  <Field label="Current purchase status">
                    <Select
                      value={p.purchaseStatus}
                      aria-label="Current purchase status"
                      onChange={(e) => void patchProduct({ purchaseStatus: e.target.value })}
                    >
                      {PRODUCT_PURCHASE_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {PRODUCT_PURCHASE_STATUS_LABELS[st]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Boxes per product">
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      defaultValue={p.boxesPerProduct}
                      aria-label="Boxes per product"
                      data-testid="boxes-per-product"
                      onBlur={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isInteger(n) && n >= 1 && n !== p.boxesPerProduct)
                          void patchProduct({ boxesPerProduct: n });
                      }}
                    />
                  </Field>
                  <Field label="Logistical carton quantity">
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      defaultValue={p.logisticalCartonQty}
                      aria-label="Logistical carton quantity"
                      onBlur={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isInteger(n) && n >= 1 && n !== p.logisticalCartonQty)
                          void patchProduct({ logisticalCartonQty: n });
                      }}
                    />
                  </Field>
                  <Field label="Purchase carton quantity">
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      defaultValue={p.purchaseCartonQty}
                      aria-label="Purchase carton quantity"
                      onBlur={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isInteger(n) && n >= 1 && n !== p.purchaseCartonQty)
                          void patchProduct({ purchaseCartonQty: n });
                      }}
                    />
                  </Field>
                  <Field label="Logistical carton transfers" as="div">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={p.logisticalCartonTransfers}
                        onChange={(e) =>
                          void patchProduct({ logisticalCartonTransfers: e.target.checked })
                        }
                      />
                      Transfer in whole cartons
                    </label>
                  </Field>
                </FormGrid>
              </Card>

              {taxClasses.length > 0 && (
                <Card
                  title="Tax class"
                  description={
                    <>
                      Override the location/business default tax rate for this product. Manage
                      classes in <Link href="/settings/tax-classes">Settings → Tax classes</Link>.
                    </>
                  }
                >
                  <FormGrid cols={2}>
                    <Field label="Tax class">
                      <Select
                        value={p.taxClassId ?? ''}
                        onChange={(e) => setTaxClass(e.target.value || null)}
                      >
                        <option value="">(use location/business default)</option>
                        {taxClasses.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} — {(c.rateBps / 100).toFixed(2)}%
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </FormGrid>
                </Card>
              )}

              <Card
                title="Brand & collection"
                description="The invoice's Brand column prints this brand; without one it falls back to the variant's preferred vendor."
              >
                <FormGrid cols={2}>
                  <Stack gap="sm">
                    <Field label="Brand">
                      <Select
                        value={p.brandId ?? ''}
                        onChange={(e) => void patchProduct({ brandId: e.target.value || null })}
                      >
                        <option value="">(no brand)</option>
                        {brands
                          .filter((b) => b.isActive || b.id === p.brandId)
                          .map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <div className="flex gap-2">
                      <Input
                        placeholder="New brand…"
                        aria-label="New brand"
                        value={newBrand}
                        onChange={(e) => setNewBrand(e.target.value)}
                        className="min-w-0 flex-1"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!newBrand.trim()}
                        onClick={() => void createAndAssign('brand', newBrand)}
                      >
                        Add
                      </Button>
                    </div>
                  </Stack>
                  <Stack gap="sm">
                    <Field label="Collection">
                      <Select
                        value={p.collectionId ?? ''}
                        onChange={(e) =>
                          void patchProduct({ collectionId: e.target.value || null })
                        }
                      >
                        <option value="">(no collection)</option>
                        {collections
                          .filter((c) => c.isActive || c.id === p.collectionId)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <div className="flex gap-2">
                      <Input
                        placeholder="New collection…"
                        aria-label="New collection"
                        value={newCollection}
                        onChange={(e) => setNewCollection(e.target.value)}
                        className="min-w-0 flex-1"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!newCollection.trim()}
                        onClick={() => void createAndAssign('collection', newCollection)}
                      >
                        Add
                      </Button>
                    </div>
                  </Stack>
                </FormGrid>
              </Card>

              <Card title="Variants" flush>
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>SKU</th>
                        <th>Size</th>
                        <th>Firmness</th>
                        <th>Barcode</th>
                        <th className="num">Price</th>
                        <th className="num">Cost</th>
                        <th className="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {p.variants.length === 0 && (
                        <TableEmpty colSpan={8}>This product has no variants.</TableEmpty>
                      )}
                      {p.variants.map((v) => (
                        <tr key={v.id}>
                          <td>{v.name ?? '—'}</td>
                          <td>
                            <code>{v.sku ?? '—'}</code>
                          </td>
                          <td>
                            <Select
                              value={v.size ?? ''}
                              aria-label={`Size for ${v.name ?? v.sku ?? 'variant'}`}
                              data-testid="variant-size"
                              onChange={(e) =>
                                void setVariantSizing(v.id, { size: e.target.value })
                              }
                            >
                              <option value="">—</option>
                              {MATTRESS_SIZES.map((x) => (
                                <option key={x} value={x}>
                                  {x}
                                </option>
                              ))}
                            </Select>
                          </td>
                          <td>
                            <Select
                              value={v.firmness ?? ''}
                              aria-label={`Firmness for ${v.name ?? v.sku ?? 'variant'}`}
                              data-testid="variant-firmness"
                              onChange={(e) =>
                                void setVariantSizing(v.id, { firmness: e.target.value })
                              }
                            >
                              <option value="">—</option>
                              {FIRMNESS_LEVELS.map((x) => (
                                <option key={x} value={x}>
                                  {x}
                                </option>
                              ))}
                            </Select>
                          </td>
                          <td>
                            <code>{v.barcode ?? '—'}</code>
                          </td>
                          <td className="num">
                            <Input
                              defaultValue={centsToInputString(v.priceCents)}
                              type="number"
                              step="0.01"
                              aria-label={`Price for ${v.name ?? v.sku ?? 'variant'}`}
                              onBlur={(e) => {
                                if (e.target.value !== centsToInputString(v.priceCents)) {
                                  void setVariantPrice(v.id, e.target.value);
                                }
                              }}
                              className="w-24"
                            />
                          </td>
                          <td className="num">
                            {v.costCents != null ? (
                              <Money cents={v.costCents} />
                            ) : (
                              <em className="muted">hidden</em>
                            )}
                          </td>
                          <td className="actions">
                            {v.isActive ? (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => deactivateVariant(v.id)}
                              >
                                Deactivate
                              </Button>
                            ) : (
                              <StatusBadge status="inactive" />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Card>

              <ReorderSettingsCard variants={p.variants} onSaved={load} />

              <Card
                title="Images"
                actions={
                  p.images.length < 4 ? (
                    <Button variant="secondary" size="sm" onClick={registerImage}>
                      + Register image (max 4)
                    </Button>
                  ) : undefined
                }
              >
                {p.images.length === 0 ? (
                  <EmptyImages />
                ) : (
                  <div className="flex flex-wrap gap-3">
                    {p.images.map((img) => (
                      <div
                        key={img.id}
                        className="max-w-[220px] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-muted)] p-2 text-xs"
                      >
                        <Stack gap="sm">
                          <code className="block break-all">{img.storageKey}</code>
                          <div>
                            <Button size="sm" variant="danger" onClick={() => deleteImage(img.id)}>
                              Delete
                            </Button>
                          </div>
                        </Stack>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </Stack>
          )}
        </div>
      </div>
      {quickAdjustAt !== false &&
        (() => {
          const v = primaryVariant(p);
          if (!v) return null;
          const locs = p.stock.byLocation
            .filter((r) => r.variantId === v.id)
            .map((r) => ({
              locationId: r.locationId,
              locationName: r.locationName,
              onHand: r.onHand,
              reserved: r.reserved,
            }));
          return (
            <AdjustStockDialog
              productName={p.name}
              sku={v.sku}
              variantId={v.id}
              locations={locs}
              initialLocationId={quickAdjustAt}
              onClose={() => setQuickAdjustAt(false)}
              onPosted={() => void load()}
              onMore={(locationId) => {
                const row = p.stock.byLocation.find(
                  (r) => r.variantId === v.id && r.locationId === locationId,
                );
                setQuickAdjustAt(false);
                if (row) setAdjustFor(row);
              }}
            />
          );
        })()}
      {adjustFor && (
        <StockAdjustmentDialog
          open
          variantId={adjustFor.variantId}
          locationId={adjustFor.locationId}
          onClose={() => setAdjustFor(null)}
          onChanged={() => void load()}
          onReassign={() => {
            setReassignFor(adjustFor);
            setAdjustFor(null);
          }}
        />
      )}
      {reassignFor && (
        <ReassignReservationDialog
          open
          variantId={reassignFor.variantId}
          locationId={reassignFor.locationId}
          itemLabel={`${reassignFor.variantSku ?? p?.name ?? 'item'} @ ${reassignFor.locationName}`}
          onClose={() => setReassignFor(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

function EmptyImages() {
  return <p className="muted">No images registered yet.</p>;
}

/**
 * Reorder automation per variant: the stock level that triggers a
 * suggestion, how many to order, and which vendor's PO it lands on.
 * Saved per row — a blank point turns the variant's automation off.
 */
function ReorderSettingsCard({
  variants,
  onSaved,
}: {
  variants: Variant[];
  onSaved: () => Promise<void> | void;
}) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<
    Record<string, { point: string; qty: string; vendorId: string; vendorSku: string }>
  >({});

  useEffect(() => {
    void api<Vendor[]>('/v1/vendors')
      .then(setVendors)
      .catch(() => setVendors([]));
  }, []);

  function valueFor(v: Variant) {
    return (
      draft[v.id] ?? {
        point: v.reorderPoint != null ? String(v.reorderPoint) : '',
        qty: v.reorderQty != null ? String(v.reorderQty) : '',
        vendorId: v.preferredVendorId ?? '',
        vendorSku: v.vendorSku ?? '',
      }
    );
  }

  async function save(v: Variant) {
    const d = valueFor(v);
    setSavingId(v.id);
    try {
      const sentVendorSku = d.vendorSku.trim() === '' ? null : d.vendorSku.trim();
      const res = await api<{ vendorSku?: string | null }>(
        `/v1/products/variants/${v.id}/reorder`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            reorderPoint: d.point === '' ? null : Number(d.point),
            reorderQty: d.qty === '' ? null : Number(d.qty),
            preferredVendorId: d.vendorId === '' ? null : d.vendorId,
            vendorSku: sentVendorSku,
          }),
        },
      );
      // Trust but verify: only claim success if the server echoed the
      // vendor SKU back. A backend that predates the field returns 200
      // without the key while silently dropping it — a false "saved"
      // here would tell a buyer the part number reached the PO.
      if (sentVendorSku !== null && (res.vendorSku ?? null) !== sentVendorSku) {
        toast.error(
          'Reorder point saved, but the server did not store the vendor SKU — the API may need an update.',
        );
        await onSaved();
        return;
      }
      toast.success('Reorder settings saved');
      await onSaved();
      setDraft((cur) => {
        const next = { ...cur };
        delete next[v.id];
        return next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  const active = variants.filter((v) => v.isActive);

  return (
    <Card
      title="Reorder automation"
      flush
      description="When available stock (on hand − committed, all locations) falls to the reorder point, the item appears in Purchasing → Reorder suggestions under its vendor. Leave the point blank to turn automation off for a variant. If the vendor uses a different part number than your SKU (common for Shopify-synced catalogs), set it as the Vendor SKU — purchase orders will show the vendor's number."
    >
      <TableWrap>
        <table className="table">
          <thead>
            <tr>
              <th>Variant</th>
              <th className="num">Reorder point</th>
              <th className="num">Order qty</th>
              <th>Preferred vendor</th>
              <th>Vendor SKU</th>
              <th className="actions" />
            </tr>
          </thead>
          <tbody>
            {active.length === 0 && (
              <TableEmpty colSpan={6}>No active variants to automate.</TableEmpty>
            )}
            {active.map((v) => {
              const d = valueFor(v);
              return (
                <tr key={v.id}>
                  <td>{v.name ?? <code>{v.sku ?? v.id.slice(0, 8)}</code>}</td>
                  <td className="num">
                    <Input
                      type="number"
                      min={0}
                      value={d.point}
                      placeholder="off"
                      aria-label="Reorder point"
                      onChange={(e) =>
                        setDraft((cur) => ({ ...cur, [v.id]: { ...d, point: e.target.value } }))
                      }
                      className="w-20"
                      data-testid={`reorder-point-${v.sku}`}
                    />
                  </td>
                  <td className="num">
                    <Input
                      type="number"
                      min={1}
                      value={d.qty}
                      placeholder="auto"
                      aria-label="Order quantity"
                      onChange={(e) =>
                        setDraft((cur) => ({ ...cur, [v.id]: { ...d, qty: e.target.value } }))
                      }
                      className="w-20"
                    />
                  </td>
                  <td>
                    <Select
                      value={d.vendorId}
                      aria-label="Preferred vendor"
                      onChange={(e) =>
                        setDraft((cur) => ({
                          ...cur,
                          [v.id]: { ...d, vendorId: e.target.value },
                        }))
                      }
                    >
                      <option value="">— none —</option>
                      {vendors.map((vd) => (
                        <option key={vd.id} value={vd.id}>
                          {vd.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Input
                      value={d.vendorSku}
                      placeholder={v.sku ? `same as ${v.sku}` : 'vendor part #'}
                      aria-label="Vendor SKU"
                      onChange={(e) =>
                        setDraft((cur) => ({
                          ...cur,
                          [v.id]: { ...d, vendorSku: e.target.value },
                        }))
                      }
                      className="w-36"
                      data-testid={`vendor-sku-${v.sku}`}
                    />
                  </td>
                  <td className="actions">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={savingId === v.id}
                      onClick={() => void save(v)}
                      data-testid={`save-reorder-${v.sku}`}
                    >
                      {savingId === v.id ? 'Saving…' : 'Save'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
