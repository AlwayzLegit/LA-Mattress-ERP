'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  MATTRESS_SIZES,
  PRODUCT_PURCHASE_STATUS_LABELS,
  PRODUCT_PURCHASE_STATUSES,
} from '@jetnine/shared';
import { api } from '@/lib/api';
import { useOptionalActingStore } from '@/lib/acting-store';
import { CsvImport } from '@/components/csv-import';
import { Money } from '@/components/money';
import { ProductsNav } from '@/components/products-nav';
import {
  Alert,
  Button,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Field,
  Input,
  LinkButton,
  LoadingRows,
  Select,
  StatusBadge,
  rowKeys,
  useListColumns,
} from '@/components/ui';

/**
 * Products browser (redesign Phase 7, README §3.3, canvas 6a). The
 * question is "who has this, anywhere, right now?" — so one row per
 * SKU and **one column per store** (available = on hand − reserved),
 * plus the company total, every STORIS column, drag-to-reorder and
 * click-to-sort headers (order remembered on this browser), a stock
 * filter (in stock anywhere / short somewhere / out everywhere), and
 * the colour rules stated in words in the footer: red = 0 with open
 * demand, amber = positive but below the store's minimum, grey = a
 * plain zero. Never colour alone.
 */

interface StoreCell {
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  min: number | null;
  demand: number;
}
interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
  isActive: boolean;
  purchaseStatus: string;
  brandName: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  collectionName: string | null;
  vendorName: string | null;
  vendorModel: string | null;
  group: string | null;
  size: string | null;
  firmness: string | null;
  priceCents: number | null;
  costCents: number | null;
  onHand: number;
  reserved: number;
  available: number;
  netOnPo: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
  stockByLocation: Record<string, StoreCell>;
}
interface LocationRow {
  id: string;
  name: string;
  locationType?: string;
  isActive?: boolean;
}
interface RefOption {
  id: string;
  name: string;
}
interface CategoryFlat {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
}
interface ReasonCodeOption {
  id: string;
  code: string;
  description: string;
}

/** Categories nest, so the picker reads "Mattresses › Hybrid". */
function categoryOptions(flat: CategoryFlat[]): RefOption[] {
  const byParent = new Map<string | null, CategoryFlat[]>();
  for (const c of flat) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const out: RefOption[] = [];
  const walk = (parentId: string | null, prefix: string) => {
    const kids = [...(byParent.get(parentId) ?? [])].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    for (const c of kids) {
      const label = prefix ? `${prefix} › ${c.name}` : c.name;
      out.push({ id: c.id, name: label });
      walk(c.id, label);
    }
  };
  walk(null, '');
  return out;
}

/** Advanced search (canvas 6a): ten fields behind a disclosure. */
interface Criteria {
  vendorModel: string;
  brandId: string;
  collectionId: string;
  group: string;
  purchaseStatus: string;
  asIsReasonCodeId: string;
  priceMin: string;
  priceMax: string;
  costMin: string;
  costMax: string;
}
const EMPTY_CRITERIA: Criteria = {
  vendorModel: '',
  brandId: '',
  collectionId: '',
  group: '',
  purchaseStatus: '',
  asIsReasonCodeId: '',
  priceMin: '',
  priceMax: '',
  costMin: '',
  costMax: '',
};
const CENTS_KEYS = new Set(['priceMin', 'priceMax', 'costMin', 'costMax']);
function criteriaParams(c: Criteria): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (!v.trim()) continue;
    out[k] = CENTS_KEYS.has(k) ? String(Math.round(Number(v) * 100)) : v.trim();
  }
  return out;
}

const STOCK_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'anywhere', label: 'In stock anywhere' },
  { value: 'short', label: 'Short somewhere' },
  { value: 'out', label: 'Out everywhere' },
];

interface Column {
  id: string;
  label: string;
  /** API sort key; store columns sort by `available:<locationId>`. */
  sort: string;
  num?: boolean;
  store?: LocationRow;
  render: (p: ProductRow) => ReactNode;
}

function statusLabel(p: ProductRow): string {
  return PRODUCT_PURCHASE_STATUS_LABELS[p.purchaseStatus as never] ?? p.purchaseStatus;
}

const FIXED_BEFORE_STORES: Column[] = [
  {
    id: 'category',
    label: 'Product category',
    sort: 'categoryName',
    render: (p) => p.categoryPath ?? p.categoryName ?? '—',
  },
  {
    id: 'product',
    label: 'Product',
    sort: 'sku',
    render: (p) => (
      <Link
        href={`/products/${p.id}`}
        className="pb-sku"
        data-testid="product-link"
        onClick={(e) => e.stopPropagation()}
      >
        {p.sku ?? '—'}
      </Link>
    ),
  },
  {
    id: 'vendorModel',
    label: 'Vendor model',
    sort: 'vendorModel',
    render: (p) => <span className="pb-mono">{p.vendorModel ?? '—'}</span>,
  },
  { id: 'vendor', label: 'Vendor', sort: 'vendorName', render: (p) => p.vendorName ?? '—' },
  {
    id: 'description',
    label: 'Description',
    sort: 'name',
    render: (p) => (
      <Link href={`/products/${p.id}`} className="pb-name" onClick={(e) => e.stopPropagation()}>
        {p.name}
      </Link>
    ),
  },
];
const FIXED_AFTER_STORES: Column[] = [
  { id: 'onHand', label: 'On hand · company', sort: 'onHand', num: true, render: (p) => p.onHand },
  { id: 'netOnPo', label: 'Net on PO', sort: 'netOnPo', num: true, render: (p) => p.netOnPo },
  {
    id: 'available',
    label: 'Available · ATP',
    sort: 'available',
    num: true,
    render: (p) => (
      <span title="Available to promise: available now plus units still due on open POs">
        {p.available}
        {p.netOnPo > 0 && <span className="pb-atp"> · {p.available + p.netOnPo}</span>}
      </span>
    ),
  },
  {
    id: 'cost',
    label: 'Sales margin cost',
    sort: 'costCents',
    num: true,
    // The column only renders for viewers with cost access, so a null here
    // means no cost on file — not "you may not see this".
    render: (p) =>
      p.costCents == null ? <span className="pb-muted">—</span> : <Money cents={p.costCents} />,
  },
  {
    id: 'asIsOnHand',
    label: 'As-Is on hand',
    sort: 'asIsOnHand',
    num: true,
    render: (p) => p.asIsOnHand,
  },
  {
    id: 'asIsAvailable',
    label: 'As-Is available',
    sort: 'asIsAvailable',
    num: true,
    render: (p) => p.asIsAvailable,
  },
  {
    id: 'price',
    label: 'Price',
    sort: 'priceCents',
    num: true,
    render: (p) => (p.priceCents == null ? '—' : <Money cents={p.priceCents} />),
  },
  {
    id: 'status',
    label: 'Status',
    sort: 'purchaseStatus',
    render: (p) => (
      <>
        {statusLabel(p)}
        {!p.isActive && <StatusBadge status="inactive" className="ml-1" />}
      </>
    ),
  },
  {
    id: 'asIsNonSellable',
    label: 'As-Is non-sellable',
    sort: 'asIsNonSellable',
    num: true,
    render: (p) => p.asIsNonSellable,
  },
  {
    id: 'group',
    label: 'Product group',
    sort: 'group',
    render: (p) => <span className="pb-mono">{p.group ?? '—'}</span>,
  },
  { id: 'brand', label: 'Brand', sort: 'brandName', render: (p) => p.brandName ?? '—' },
  { id: 'size', label: 'Size', sort: 'size', render: (p) => p.size ?? '—' },
  { id: 'firmness', label: 'Firmness', sort: 'firmness', render: (p) => p.firmness ?? '—' },
  {
    id: 'collection',
    label: 'Primary collection',
    sort: 'collectionName',
    render: (p) => p.collectionName ?? '—',
  },
];

/**
 * The column order used to live under its own key before every list got
 * the shared primitive (2026-09-13); carry a saved order across once.
 */
function migrateLegacyColumnOrder(): void {
  try {
    const legacy = localStorage.getItem('jetnine.products.columns');
    if (legacy && !localStorage.getItem('jetnine.columns.products')) {
      localStorage.setItem('jetnine.columns.products', legacy);
    }
    localStorage.removeItem('jetnine.products.columns');
  } catch {
    // storage unavailable
  }
}

/** Store cell tone (canvas 6a): red = 0 with demand, amber = under min, grey = plain zero. */
function cellTone(c: StoreCell | undefined): 'risk' | 'waiting' | 'zero' | 'ok' {
  const avail = c?.available ?? 0;
  if (avail <= 0 && (c?.demand ?? 0) > 0) return 'risk';
  if (avail <= 0) return 'zero';
  if (c?.min != null && avail < c.min) return 'waiting';
  return 'ok';
}

export default function ProductsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const initial =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [categoryId, setCategoryId] = useState(initial.get('categoryId') ?? '');
  const [size, setSize] = useState(initial.get('size') ?? '');
  const [stock, setStock] = useState(initial.get('stock') ?? '');
  const [includeInactive, setIncludeInactive] = useState(initial.get('includeInactive') === '1');
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(() =>
    initial.get('vendorId')
      ? { id: initial.get('vendorId')!, name: initial.get('vendor') ?? 'vendor' }
      : null,
  );
  const [sort, setSort] = useState(initial.get('sort') ?? '');
  const [dir, setDir] = useState<'asc' | 'desc'>(initial.get('dir') === 'desc' ? 'desc' : 'asc');
  const [criteria, setCriteria] = useState<Criteria>(() => {
    const c = { ...EMPTY_CRITERIA };
    for (const k of Object.keys(c) as (keyof Criteria)[]) {
      const v = initial.get(k);
      if (v) c[k] = CENTS_KEYS.has(k) ? (Number(v) / 100).toString() : v;
    }
    return c;
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [brands, setBrands] = useState<RefOption[]>([]);
  const [collections, setCollections] = useState<RefOption[]>([]);
  const [categories, setCategories] = useState<RefOption[]>([]);
  const [asIsReasons, setAsIsReasons] = useState<ReasonCodeOption[]>([]);
  const [refsLoaded, setRefsLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  // Store columns: the warehouse first, then the stores by name.
  const storeColumns = useMemo<Column[]>(
    () =>
      [...locations]
        .filter((l) => l.isActive !== false)
        .sort((a, b) => {
          const wa = a.locationType === 'warehouse' ? 0 : 1;
          const wb = b.locationType === 'warehouse' ? 0 : 1;
          return wa - wb || a.name.localeCompare(b.name);
        })
        .map((l) => ({
          id: `loc:${l.id}`,
          label: l.name,
          sort: `available:${l.id}`,
          num: true,
          store: l,
          render: (p: ProductRow) => {
            const c = p.stockByLocation[l.id];
            const tone = cellTone(c);
            return (
              <span
                className={`pb-store is-${tone}`}
                title={`${l.name}: ${c?.onHand ?? 0} on hand · ${c?.reserved ?? 0} reserved${
                  c?.min != null ? ` · minimum ${c.min}` : ''
                }${(c?.demand ?? 0) > 0 ? ` · ${c!.demand} waiting on orders` : ''}`}
                data-testid="store-cell"
                data-tone={tone}
              >
                {c?.available ?? 0}
              </span>
            );
          },
        })),
    [locations],
  );
  const allColumns = useMemo(
    () => [...FIXED_BEFORE_STORES, ...storeColumns, ...FIXED_AFTER_STORES],
    [storeColumns],
  );
  // `canSeeCost` comes from /members/me; until it loads, fall back to
  // "any row carries a cost" so the column never flashes in and out.
  const canSeeCost = useOptionalActingStore()?.me?.canSeeCost;
  const showCost = canSeeCost ?? (rows ?? []).some((r) => r.costCents != null);
  const visibleColumns = useMemo<ColumnDef<ProductRow>[]>(
    () =>
      allColumns
        .filter((c) => c.id !== 'cost' || showCost)
        .map((c) => ({
          id: c.id,
          label: c.label,
          sortKey: c.sort,
          num: c.num,
          thClassName: c.store ? 'pb-store-th' : undefined,
          cellClassName: c.id === 'description' ? () => 'pb-desc-cell' : undefined,
          render: c.render,
        })),
    [allColumns, showCost],
  );
  useEffect(migrateLegacyColumnOrder, []);
  const cols = useListColumns('products', visibleColumns, rows, {
    server: { sort, dir, onSort: toggleSort },
  });

  useEffect(() => {
    void api<CategoryFlat[] | { flat: CategoryFlat[] }>('/v1/categories')
      .then((r) => setCategories(categoryOptions(Array.isArray(r) ? r : r.flat)))
      .catch(() => setCategories([]));
    void api<LocationRow[]>('/v1/business/locations')
      .then((l) => setLocations(l))
      .catch(() => setLocations([]));
  }, []);

  const loadRefs = useCallback(() => {
    if (refsLoaded) return;
    setRefsLoaded(true);
    void api<RefOption[]>('/v1/brands')
      .then(setBrands)
      .catch(() => setBrands([]));
    void api<RefOption[]>('/v1/collections')
      .then(setCollections)
      .catch(() => setCollections([]));
    void api<ReasonCodeOption[]>('/v1/reason-codes?usageClass=as_is')
      .then(setAsIsReasons)
      .catch(() => setAsIsReasons([]));
  }, [refsLoaded]);

  const params = useCallback(
    (cursor: string | null) => {
      const p = new URLSearchParams({ limit: '50' });
      if (q.trim()) p.set('q', q.trim());
      if (categoryId) p.set('categoryId', categoryId);
      if (size) p.set('size', size);
      if (stock) p.set('stock', stock);
      if (includeInactive) p.set('includeInactive', '1');
      if (vendor) p.set('vendorId', vendor.id);
      if (sort) {
        p.set('sort', sort);
        p.set('dir', dir);
      }
      for (const [k, v] of Object.entries(criteriaParams(criteria))) p.set(k, v);
      if (cursor) p.set('cursor', cursor);
      return p;
    },
    [q, categoryId, size, stock, includeInactive, vendor, sort, dir, criteria],
  );

  useEffect(() => {
    const mine = ++seq.current;
    // Mirror into the URL (replace, no history spam).
    const u = params(null);
    u.delete('limit');
    if (vendor) u.set('vendor', vendor.name);
    const qs = u.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
    const t = setTimeout(
      () => {
        api<{ data: ProductRow[]; nextCursor: string | null }>(
          `/v1/products?${params(null).toString()}`,
        )
          .then((page) => {
            if (seq.current !== mine) return;
            setRows(page.data);
            setNextCursor(page.nextCursor);
            setError(null);
          })
          .catch((e) => {
            if (seq.current !== mine) return;
            setError(e instanceof Error ? e.message : String(e));
          });
      },
      rows === null ? 0 : 250,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, tick]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<{ data: ProductRow[]; nextCursor: string | null }>(
        `/v1/products?${params(nextCursor).toString()}`,
      );
      setRows((prev) => [...(prev ?? []), ...page.data]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleSort(key: string) {
    setRows(null);
    if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(key);
      setDir('asc');
    }
  }
  function clearAll() {
    setQ('');
    setCategoryId('');
    setSize('');
    setStock('');
    setIncludeInactive(false);
    setVendor(null);
    setCriteria(EMPTY_CRITERIA);
  }

  const hasCriteria = Object.keys(criteriaParams(criteria)).length > 0;
  const filtered = !!(
    q.trim() ||
    categoryId ||
    size ||
    stock ||
    includeInactive ||
    vendor ||
    hasCriteria
  );
  const critSummary = [
    criteria.vendorModel && `model “${criteria.vendorModel}”`,
    criteria.brandId && `brand ${brands.find((b) => b.id === criteria.brandId)?.name ?? ''}`,
    criteria.collectionId &&
      `collection ${collections.find((b) => b.id === criteria.collectionId)?.name ?? ''}`,
    criteria.group && `group ${criteria.group}`,
    criteria.purchaseStatus &&
      `status ${PRODUCT_PURCHASE_STATUS_LABELS[criteria.purchaseStatus as never] ?? criteria.purchaseStatus}`,
    criteria.asIsReasonCodeId && 'As-Is reason',
    (criteria.priceMin || criteria.priceMax) &&
      `price ${criteria.priceMin || '0'}–${criteria.priceMax || '∞'}`,
    (criteria.costMin || criteria.costMax) &&
      `cost ${criteria.costMin || '0'}–${criteria.costMax || '∞'}`,
  ].filter(Boolean);
  const setCrit = (k: keyof Criteria, v: string) => setCriteria((c) => ({ ...c, [k]: v }));

  return (
    <div className="pb" data-testid="products-browser">
      <header className="pb-head">
        <div>
          <div className="t-label">Stock</div>
          <div className="pb-title-row">
            <h1 className="pb-title">Products</h1>
            <span className="pb-sub" data-testid="products-summary">
              {rows ? `${rows.length} shown${nextCursor ? ' · more below' : ''}` : '…'} · one row
              per SKU, one column per store
            </span>
          </div>
        </div>
        <div className="pb-head-actions">
          <LinkButton href="/products/receive" size="sm">
            Receive
          </LinkButton>
          <LinkButton href="/products/counts" size="sm">
            Count
          </LinkButton>
          <LinkButton href="/transfers/new" size="sm">
            Transfer
          </LinkButton>
          <LinkButton href="/products/labels" size="sm">
            Print labels
          </LinkButton>
          <LinkButton href="/products/new" variant="primary" size="sm">
            + Create product
          </LinkButton>
        </div>
      </header>

      <ProductsNav />

      <section className="pb-card" aria-label="Products">
        <div className="pb-toolbar">
          <Field label="Search" className="pb-search">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, SKU, barcode or vendor model"
              data-testid="products-search"
              autoComplete="off"
            />
          </Field>
          <Field label="Category">
            <Select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              data-testid="products-category"
            >
              <option value="">Any</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Size">
            <Select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              data-testid="products-size"
            >
              <option value="">Any</option>
              {MATTRESS_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Stock">
            <Select
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              data-testid="products-stock"
            >
              {STOCK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <label className="pb-check">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              data-testid="products-include-inactive"
            />
            Show inactive
          </label>
          <button
            type="button"
            className="pb-disclosure"
            aria-expanded={advancedOpen}
            aria-controls="products-advanced"
            onClick={() => {
              setAdvancedOpen((v) => !v);
              loadRefs();
            }}
            data-testid="products-advanced-toggle"
          >
            Advanced search {advancedOpen ? '▾' : '▸'}
            {!advancedOpen && critSummary.length > 0 && (
              <span className="pb-crit-summary"> · {critSummary.join(', ')}</span>
            )}
          </button>
          <span className="pb-toolbar-end">
            {filtered && (
              <Button variant="ghost" size="sm" onClick={clearAll} data-testid="clear-filters">
                Clear filters
              </Button>
            )}
            {cols.isCustom && (
              <Button
                variant="ghost"
                size="sm"
                onClick={cols.reset}
                data-testid="products-reset-columns"
              >
                Reset columns
              </Button>
            )}
          </span>
        </div>

        {advancedOpen && (
          <div
            id="products-advanced"
            className="pb-advanced"
            data-testid="products-advanced-search"
          >
            <Field label="Vendor model">
              <Input
                value={criteria.vendorModel}
                onChange={(e) => setCrit('vendorModel', e.target.value)}
                placeholder="contains"
                data-testid="criteria-vendor-model"
              />
            </Field>
            <Field label="Brand">
              <Select
                value={criteria.brandId}
                onChange={(e) => setCrit('brandId', e.target.value)}
                data-testid="criteria-brand"
              >
                <option value="">Any</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Collection">
              <Select
                value={criteria.collectionId}
                onChange={(e) => setCrit('collectionId', e.target.value)}
                data-testid="criteria-collection"
              >
                <option value="">Any</option>
                {collections.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Product group">
              <Input
                value={criteria.group}
                onChange={(e) => setCrit('group', e.target.value)}
                placeholder="e.g. QUEEN"
                data-testid="criteria-group"
              />
            </Field>
            <Field label="Purchase status">
              <Select
                value={criteria.purchaseStatus}
                onChange={(e) => setCrit('purchaseStatus', e.target.value)}
                data-testid="criteria-purchase-status"
              >
                <option value="">Any</option>
                {PRODUCT_PURCHASE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PRODUCT_PURCHASE_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="As-Is reason">
              <Select
                value={criteria.asIsReasonCodeId}
                onChange={(e) => setCrit('asIsReasonCodeId', e.target.value)}
                data-testid="criteria-as-is-reason"
              >
                <option value="">Any</option>
                {asIsReasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} — {r.description}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Price from ($)">
              <Input
                type="number"
                min={0}
                step="0.01"
                value={criteria.priceMin}
                onChange={(e) => setCrit('priceMin', e.target.value)}
                className="input-num"
                data-testid="criteria-price-min"
              />
            </Field>
            <Field label="Price to ($)">
              <Input
                type="number"
                min={0}
                step="0.01"
                value={criteria.priceMax}
                onChange={(e) => setCrit('priceMax', e.target.value)}
                className="input-num"
                data-testid="criteria-price-max"
              />
            </Field>
            {showCost && (
              <>
                <Field label="Cost from ($)">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={criteria.costMin}
                    onChange={(e) => setCrit('costMin', e.target.value)}
                    className="input-num"
                    data-testid="criteria-cost-min"
                  />
                </Field>
                <Field label="Cost to ($)">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={criteria.costMax}
                    onChange={(e) => setCrit('costMax', e.target.value)}
                    className="input-num"
                    data-testid="criteria-cost-max"
                  />
                </Field>
              </>
            )}
            <div className="pb-advanced-actions">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCriteria(EMPTY_CRITERIA)}
                disabled={!hasCriteria}
              >
                Clear criteria
              </Button>
            </div>
          </div>
        )}

        {vendor && (
          <div className="pb-chips" data-testid="products-vendor-chip">
            <span className="pb-chips-label">Showing</span>
            <span className="pb-chip">
              products from {vendor.name}
              <button
                type="button"
                onClick={() => setVendor(null)}
                aria-label="Remove vendor filter"
              >
                ×
              </button>
            </span>
          </div>
        )}

        <div className="pb-sheet">
          {error && (
            <div style={{ padding: 12 }}>
              <Alert
                tone="error"
                action={
                  <Button size="sm" onClick={() => setTick((n) => n + 1)}>
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
              <LoadingRows rows={8} height={34} what="Products" />
            </div>
          )}
          {rows && (
            <table className="table table-sticky pb-table" data-testid="products-table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="products" />
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    {...rowKeys}
                    key={p.id}
                    data-testid="product-row"
                    className={p.isActive ? undefined : 'is-inactive'}
                    onClick={() => router.push(`/products/${p.id}`)}
                  >
                    <ColumnCells list={cols} row={p} />
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={cols.ordered.length} className="pb-empty">
                      <div className="pb-empty-title">Nothing matches</div>
                      <div>Try fewer words or clear a filter.</div>
                      {filtered && (
                        <Button size="sm" onClick={clearAll} style={{ marginTop: 10 }}>
                          Clear filters
                        </Button>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {nextCursor && (
            <div className="pb-more">
              <Button
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="load-more"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>

        <div className="pb-foot" data-testid="products-footer">
          <span>
            Showing <strong>{rows?.length ?? 0}</strong>
            {nextCursor ? ' · more available' : ''}
          </span>
          <span>
            Store columns show <strong>available</strong> (on hand − reserved); red = 0 with open
            demand, amber = below the store minimum, grey = a plain zero.
          </span>
          <span>
            Sales margin cost{' '}
            {showCost ? 'shows for your role' : 'hides for roles without cost access'}. Column order
            is saved on this browser.
          </span>
        </div>
      </section>

      <details className="pb-import" data-testid="products-csv-import">
        <summary>Import products from CSV</summary>
        <CsvImport entity="product" onCommitted={() => setTick((n) => n + 1)} />
      </details>
    </div>
  );
}
