'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  MATTRESS_SIZES,
  PRODUCT_PURCHASE_STATUS_LABELS,
  PRODUCT_PURCHASE_STATUSES,
} from '@jetnine/shared';
import { api } from '@/lib/api';
import { categoryList, categoryOptions, type CategoryFlat } from '@/lib/categories';
import { Button, Field, Input, Select } from '@/components/ui';

/**
 * The Products browser's filter strip (redesign Phase 7, canvas 6a) —
 * search, category / group, size, stock, "show inactive", the vendor
 * chip and the ten Advanced-search criteria — as one hook and one bar,
 * so Stock by location carries the same filters (owner 2026-10-21) and a
 * filter means one thing on both screens. The hook owns the state and
 * the query-string it produces; the page decides when to fetch.
 */

export interface RefOption {
  id: string;
  name: string;
}
interface ReasonCodeOption {
  id: string;
  code: string;
  description: string;
}

/** Advanced search (canvas 6a): ten fields behind a disclosure. */
export interface Criteria {
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
export const EMPTY_CRITERIA: Criteria = {
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
export function criteriaParams(c: Criteria): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (!v.trim()) continue;
    out[k] = CENTS_KEYS.has(k) ? String(Math.round(Number(v) * 100)) : v.trim();
  }
  return out;
}

export const STOCK_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'anywhere', label: 'In stock anywhere' },
  { value: 'short', label: 'Short somewhere' },
  { value: 'out', label: 'Out everywhere' },
];

export interface ProductFilters {
  q: string;
  setQ: (v: string) => void;
  categoryId: string;
  setCategoryId: (v: string) => void;
  size: string;
  setSize: (v: string) => void;
  stock: string;
  setStock: (v: string) => void;
  includeInactive: boolean;
  setIncludeInactive: (v: boolean) => void;
  vendor: RefOption | null;
  setVendor: (v: RefOption | null) => void;
  criteria: Criteria;
  setCriteria: (c: Criteria | ((c: Criteria) => Criteria)) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean | ((v: boolean) => boolean)) => void;
  /** Reference lists for the selects (loaded lazily when Advanced opens). */
  categories: RefOption[];
  catFlat: CategoryFlat[];
  brands: RefOption[];
  collections: RefOption[];
  groupFacets: { value: string; count: number }[];
  asIsReasons: ReasonCodeOption[];
  loadRefs: () => void;
  /** The filter query-string values the API takes (no paging or sort). */
  params: () => URLSearchParams;
  /** True once anything narrows the list. */
  filtered: boolean;
  hasCriteria: boolean;
  critSummary: string[];
  clearAll: () => void;
}

/**
 * Filter state seeded from a query string (the page mirrors it back into
 * the URL so a filtered view survives reload and can be shared).
 */
export function useProductFilters(initial: URLSearchParams): ProductFilters {
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [categoryId, setCategoryId] = useState(initial.get('categoryId') ?? '');
  const [size, setSize] = useState(initial.get('size') ?? '');
  const [stock, setStock] = useState(initial.get('stock') ?? '');
  const [includeInactive, setIncludeInactive] = useState(initial.get('includeInactive') === '1');
  const [vendor, setVendor] = useState<RefOption | null>(() =>
    initial.get('vendorId')
      ? { id: initial.get('vendorId')!, name: initial.get('vendor') ?? 'vendor' }
      : null,
  );
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
  // Owner 2026-10-14: Product group picks from the groups the catalog has.
  const [groupFacets, setGroupFacets] = useState<{ value: string; count: number }[]>([]);
  const [categories, setCategories] = useState<RefOption[]>([]);
  /** Raw category rows so the Group filter can list a category's children. */
  const [catFlat, setCatFlat] = useState<CategoryFlat[]>([]);
  const [asIsReasons, setAsIsReasons] = useState<ReasonCodeOption[]>([]);
  const [refsLoaded, setRefsLoaded] = useState(false);

  useEffect(() => {
    void api<CategoryFlat[] | { flat: CategoryFlat[] }>('/v1/categories')
      .then((r) => {
        const flat = categoryList(r);
        setCatFlat(flat);
        setCategories(categoryOptions(flat));
      })
      .catch(() => {
        setCatFlat([]);
        setCategories([]);
      });
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
    void api<{ groups: { value: string; count: number }[] }>('/v1/products/facets')
      .then((f) => setGroupFacets(f.groups ?? []))
      .catch(() => setGroupFacets([]));
    void api<ReasonCodeOption[]>('/v1/reason-codes?usageClass=as_is')
      .then(setAsIsReasons)
      .catch(() => setAsIsReasons([]));
  }, [refsLoaded]);

  const params = useCallback(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (categoryId) p.set('categoryId', categoryId);
    if (size) p.set('size', size);
    if (stock) p.set('stock', stock);
    if (includeInactive) p.set('includeInactive', '1');
    if (vendor) p.set('vendorId', vendor.id);
    for (const [k, v] of Object.entries(criteriaParams(criteria))) p.set(k, v);
    return p;
  }, [q, categoryId, size, stock, includeInactive, vendor, criteria]);

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
  ].filter((x): x is string => Boolean(x));

  const clearAll = useCallback(() => {
    setQ('');
    setCategoryId('');
    setSize('');
    setStock('');
    setIncludeInactive(false);
    setVendor(null);
    setCriteria(EMPTY_CRITERIA);
  }, []);

  return {
    q,
    setQ,
    categoryId,
    setCategoryId,
    size,
    setSize,
    stock,
    setStock,
    includeInactive,
    setIncludeInactive,
    vendor,
    setVendor,
    criteria,
    setCriteria,
    advancedOpen,
    setAdvancedOpen,
    categories,
    catFlat,
    brands,
    collections,
    groupFacets,
    asIsReasons,
    loadRefs,
    params,
    filtered,
    hasCriteria,
    critSummary,
    clearAll,
  };
}

interface BarProps {
  f: ProductFilters;
  /** Cost fields show only for roles with cost access. */
  showCost: boolean;
  /** Controls placed before the search box (Stock by location's store picker). */
  before?: ReactNode;
  /** Controls placed at the far end of the strip (Reset columns). */
  end?: ReactNode;
  /** data-testid prefix: "products" keeps the browser's existing ids. */
  testIdPrefix?: string;
}

/** The filter strip + Advanced search panel + vendor chip (pb-* styles). */
export function ProductFilterBar({
  f,
  showCost,
  before,
  end,
  testIdPrefix = 'products',
}: BarProps) {
  const tid = (s: string) => `${testIdPrefix}-${s}`;
  const setCrit = (k: keyof Criteria, v: string) => f.setCriteria((c) => ({ ...c, [k]: v }));

  // Group filter (owner 2026-09-25): the tree is two levels, so once a
  // category is picked the Group select narrows to one of its children
  // (Mattresses → Hybrid / Memory Foam / …). Picking a group just moves
  // categoryId to the child, so the URL, API call and Clear behavior are
  // exactly the single-select ones.
  const selectedCat = f.catFlat.find((c) => c.id === f.categoryId);
  const groupParentId = selectedCat?.parentId ?? f.categoryId;
  const groupChoices = groupParentId
    ? [...f.catFlat.filter((c) => c.parentId === groupParentId)].sort(
        (a, b) => a.position - b.position || a.name.localeCompare(b.name),
      )
    : [];
  const groupValue = selectedCat?.parentId ? f.categoryId : '';

  return (
    <>
      <div className="pb-toolbar">
        {before}
        <Field label="Search" className="pb-search">
          <Input
            value={f.q}
            onChange={(e) => f.setQ(e.target.value)}
            placeholder="Name, SKU, barcode or vendor model"
            data-testid={tid('search')}
            autoComplete="off"
          />
        </Field>
        <Field label="Category">
          <Select
            value={f.categoryId}
            onChange={(e) => f.setCategoryId(e.target.value)}
            data-testid={tid('category')}
          >
            <option value="">Any</option>
            {f.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {groupChoices.length > 0 && (
          <Field label="Group">
            <Select
              value={groupValue}
              onChange={(e) => f.setCategoryId(e.target.value || groupParentId)}
              data-testid={tid('group')}
            >
              <option value="">Any</option>
              {groupChoices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Size">
          <Select
            value={f.size}
            onChange={(e) => f.setSize(e.target.value)}
            data-testid={tid('size')}
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
            value={f.stock}
            onChange={(e) => f.setStock(e.target.value)}
            data-testid={tid('stock')}
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
            checked={f.includeInactive}
            onChange={(e) => f.setIncludeInactive(e.target.checked)}
            data-testid={tid('include-inactive')}
          />
          Show inactive
        </label>
        <button
          type="button"
          className="pb-disclosure"
          aria-expanded={f.advancedOpen}
          aria-controls={tid('advanced')}
          onClick={() => {
            f.setAdvancedOpen((v) => !v);
            f.loadRefs();
          }}
          data-testid={tid('advanced-toggle')}
        >
          Advanced search {f.advancedOpen ? '▾' : '▸'}
          {!f.advancedOpen && f.critSummary.length > 0 && (
            <span className="pb-crit-summary"> · {f.critSummary.join(', ')}</span>
          )}
        </button>
        <span className="pb-toolbar-end">
          {f.filtered && (
            <Button variant="ghost" size="sm" onClick={f.clearAll} data-testid="clear-filters">
              Clear filters
            </Button>
          )}
          {end}
        </span>
      </div>

      {f.advancedOpen && (
        <div id={tid('advanced')} className="pb-advanced" data-testid={tid('advanced-search')}>
          <Field label="Vendor model">
            <Input
              value={f.criteria.vendorModel}
              onChange={(e) => setCrit('vendorModel', e.target.value)}
              placeholder="contains"
              data-testid="criteria-vendor-model"
            />
          </Field>
          <Field label="Brand">
            <Select
              value={f.criteria.brandId}
              onChange={(e) => setCrit('brandId', e.target.value)}
              data-testid="criteria-brand"
            >
              <option value="">Any</option>
              {f.brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Collection">
            <Select
              value={f.criteria.collectionId}
              onChange={(e) => setCrit('collectionId', e.target.value)}
              data-testid="criteria-collection"
            >
              <option value="">Any</option>
              {f.collections.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Product group">
            <Select
              value={f.criteria.group}
              onChange={(e) => setCrit('group', e.target.value)}
              data-testid="criteria-group"
            >
              <option value="">Any</option>
              {/* A group typed into an old link still shows as chosen. */}
              {f.criteria.group &&
                !f.groupFacets.some(
                  (g) => g.value.toLowerCase() === f.criteria.group.toLowerCase(),
                ) && <option value={f.criteria.group}>{f.criteria.group}</option>}
              {f.groupFacets.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.value} ({g.count})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Purchase status">
            <Select
              value={f.criteria.purchaseStatus}
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
              value={f.criteria.asIsReasonCodeId}
              onChange={(e) => setCrit('asIsReasonCodeId', e.target.value)}
              data-testid="criteria-as-is-reason"
            >
              <option value="">Any</option>
              {f.asIsReasons.map((r) => (
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
              value={f.criteria.priceMin}
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
              value={f.criteria.priceMax}
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
                  value={f.criteria.costMin}
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
                  value={f.criteria.costMax}
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
              onClick={() => f.setCriteria(EMPTY_CRITERIA)}
              disabled={!f.hasCriteria}
            >
              Clear criteria
            </Button>
          </div>
        </div>
      )}

      {f.vendor && (
        <div className="pb-chips" data-testid={tid('vendor-chip')}>
          <span className="pb-chips-label">Showing</span>
          <span className="pb-chip">
            products from {f.vendor.name}
            <button
              type="button"
              onClick={() => f.setVendor(null)}
              aria-label="Remove vendor filter"
            >
              ×
            </button>
          </span>
        </div>
      )}
    </>
  );
}
