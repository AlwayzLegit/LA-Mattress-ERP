'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  centsToInputString,
  PRODUCT_PURCHASE_STATUS_LABELS,
  type ProductPurchaseStatus,
} from '@jetnine/shared';
import { api } from '@/lib/api';
import { useOptionalActingStore } from '@/lib/acting-store';
import { Money } from '@/components/money';
import { ProductsNav } from '@/components/products-nav';
import { ReassignReservationDialog } from '@/components/reassign-reservation-dialog';
import { StockAdjustmentDialog } from '@/components/stock-adjustment-dialog';
import { AdjustStockDialog } from '@/components/adjust-stock-dialog';
import { StatusChip } from '@/components/ui';
import type { PurchaseOrderRow } from './activity/types';
import { AsIsPanel } from './activity/as-is-panel';
import { AtpCard } from './activity/atp-card';
import { InventoryDetailPanel } from './activity/inventory-detail-panel';
import { fmtDate } from './activity/kit';
import { OpenOrdersPanel } from './activity/open-orders-panel';
import { PurchaseOrdersPanel } from './activity/purchase-orders-panel';
import { SalesHistoryPanel } from './activity/sales-history-panel';
import { SerialsPanel } from './activity/serials-panel';
import { SummaryPanel } from './activity/summary-panel';
import { TransfersPanel } from './activity/transfers-panel';
import { PRODUCT_TABS, type AtpResult, type ProductTab, type Shipping } from './activity/types';
import { EditProductForm, marginPercent, type RefEntity } from './edit-product-form';
import {
  Alert,
  BackLink,
  Button,
  Card,
  KeyValue,
  LoadingRows,
  PageHeader,
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
  categoryId: string | null;
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

interface TaxClass {
  id: string;
  name: string;
  rateBps: number;
}

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  // "hidden" only when the viewer lacks products.cost.view; a null cost
  // with access is simply no cost on file.
  const canSeeCost = useOptionalActingStore()?.me?.canSeeCost;
  const costHidden = <em className="muted">{canSeeCost === false ? 'hidden' : '—'}</em>;
  const id = (params?.id ?? '') as string;
  const [p, setP] = useState<Product | null>(null);
  const [taxClasses, setTaxClasses] = useState<TaxClass[]>([]);
  const [brands, setBrands] = useState<RefEntity[]>([]);
  const [collections, setCollections] = useState<RefEntity[]>([]);
  // Unsaved edits on the Edit product tab: leaving the tab asks first.
  const [editDirty, setEditDirty] = useState(false);
  const onDirtyChange = useCallback((d: boolean) => setEditDirty(d), []);
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
    if (
      tab === 'general' &&
      next !== 'general' &&
      editDirty &&
      !confirm('You have unsaved changes to this product. Leave without saving?')
    )
      return;
    if (next !== 'general') setEditDirty(false);
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

  async function patchProduct(patch: Record<string, unknown>) {
    try {
      await api(`/v1/products/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
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

  /**
   * Owner 2026-09-21: a deactivated size could only be read, never
   * switched back on, so a product reactivated from the header still had
   * nothing sellable under it. Deactivating is a DELETE; turning it back
   * on is the ordinary variant PATCH.
   */
  async function reactivateVariant(variantId: string) {
    try {
      await api(`/v1/products/variants/${variantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: true }),
      });
      toast.success('Variant reactivated');
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

              <Card
                title="Merchandising"
                data-testid="product-merchandising"
                actions={
                  <Button size="sm" onClick={() => pickTab('general')} data-testid="merch-edit">
                    Edit price & cost
                  </Button>
                }
              >
                {(() => {
                  const v = primaryVariant(p);
                  const m = marginPercent(v?.priceCents, v?.costCents);
                  return (
                    <KeyValue
                      rows={[
                        {
                          label: 'Selling price',
                          value: v ? (
                            <span data-testid="selling-price">
                              <Money cents={v.priceCents} />
                            </span>
                          ) : (
                            '—'
                          ),
                        },
                        {
                          label: 'Cost',
                          value:
                            v?.costCents != null ? (
                              <span data-testid="merch-cost">
                                <Money cents={v.costCents} />
                              </span>
                            ) : (
                              costHidden
                            ),
                        },
                        { label: 'Margin', value: m != null ? `${m}%` : '—' },
                        {
                          label: 'Suggested retail price',
                          value:
                            p.suggestedRetailCents != null ? (
                              <Money cents={p.suggestedRetailCents} />
                            ) : (
                              '—'
                            ),
                        },
                        {
                          label: 'Purchase status',
                          value:
                            PRODUCT_PURCHASE_STATUS_LABELS[
                              p.purchaseStatus as ProductPurchaseStatus
                            ] ?? String(p.purchaseStatus),
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
              <EditProductForm
                product={p}
                taxClasses={taxClasses}
                brands={brands}
                collections={collections}
                onRefCreated={(kind, ref) =>
                  kind === 'brand'
                    ? setBrands((cur) => [...cur, ref])
                    : setCollections((cur) => [...cur, ref])
                }
                onSaved={load}
                onToggleVariant={(variantId, active) =>
                  void (active ? reactivateVariant(variantId) : deactivateVariant(variantId))
                }
                onDirtyChange={onDirtyChange}
              />

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
