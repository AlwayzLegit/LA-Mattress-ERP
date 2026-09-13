'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FIRMNESS_LEVELS, MATTRESS_SIZES } from '@jetnine/shared';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import { Button, Dialog, Field, Input, Kbd, LoadingRows, Select, rowKeys } from '@/components/ui';

/**
 * Add Product (redesign Phase 5, README §3.1, canvas 4c): a real dialog
 * (role, focus trap, Esc, focus return), 1080px. Search matches every
 * word in any order; Vendor, Size, Firmness filters; **From** is the
 * loudest control (accent-filled) because the whole risk of the
 * warehouse default is a salesperson not noticing where a line will
 * pull from; "In stock first" sorts. Columns: Product / vendor, SKU,
 * Size, Firmness, Price, At {From} (green > 0, red 0), All stores, ATP
 * with its definition on hover, Add. Footer: "Showing N of 1,948", where
 * the line will source from and why, ↵ adds the first row, esc closes.
 * Shared with the order page's line editor; the caller owns what "add"
 * means.
 */

export interface ProductSearchLocation {
  id: string;
  name: string;
  locationType?: string;
}

export interface SearchRow {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  priceCents: number;
  vendorId: string | null;
  vendorName: string | null;
  size: string | null;
  firmness: string | null;
  /** Catalog category path ("Mattresses › Hybrid"), null when unfiled. */
  categoryPath?: string | null;
  availableHere: number;
  availableTotal: number;
  atpDate: string | null;
  /** Product's own rate at the store (0 = untaxed), null = the store rate applies. */
  taxRateBps?: number | null;
}
interface VendorRow {
  id: string;
  name: string;
}
const SIZES = MATTRESS_SIZES;
const FIRMNESS = FIRMNESS_LEVELS;

export function ProductSearchDialog({
  locationId,
  locationName,
  locations,
  storeId,
  onChangeLocation,
  onAdd,
  onClose,
  sourceNote,
}: {
  locationId: string;
  locationName: string | null;
  locations: ProductSearchLocation[];
  storeId: string;
  onChangeLocation: (id: string) => void;
  onAdd: (row: SearchRow) => void;
  onClose: () => void;
  /** Why the footer's source is what it is: "the default; take-with lines switch to the store". */
  sourceNote?: string;
}) {
  const [q, setQ] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [size, setSize] = useState('');
  const [firmness, setFirmness] = useState('');
  const [inStockFirst, setInStockFirst] = useState(true);
  const [rows, setRows] = useState<SearchRow[] | null>(null);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hi, setHi] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<{ data: VendorRow[] } | VendorRow[]>('/v1/vendors?limit=100')
      .then((r) => setVendors(Array.isArray(r) ? r : r.data))
      .catch(() => setVendors([]));
    void api<{ total: number }>('/v1/pos/catalog-count')
      .then((r) => setTotal(r.total))
      .catch(() => setTotal(null));
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (vendorId) params.set('vendorId', vendorId);
      if (size) params.set('size', size);
      if (firmness) params.set('firmness', firmness);
      params.set('locationId', locationId);
      params.set('limit', '100');
      void api<SearchRow[]>(`/v1/pos/product-search?${params.toString()}`)
        .then((r) => {
          setRows(r);
          setHi(0);
        })
        .catch(() => setRows([]));
    }, 220);
  }, [q, vendorId, size, firmness, locationId]);

  const shown = useMemo(() => {
    if (!rows) return [];
    if (!inStockFirst) return rows;
    return [...rows].sort((a, b) => Number(b.availableHere > 0) - Number(a.availableHere > 0));
  }, [rows, inStockFirst]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (shown.length > 0) {
        e.preventDefault();
        const next =
          e.key === 'ArrowDown' ? Math.min(hi + 1, shown.length - 1) : Math.max(hi - 1, 0);
        setHi(next);
        listRef.current
          ?.querySelectorAll('[data-testid="product-result"]')
          [next]?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    // Enter adds the highlighted row from the search box only — buttons
    // and selects keep their native Enter behavior.
    if (
      e.key === 'Enter' &&
      shown[hi] &&
      (e.target as HTMLElement).getAttribute('data-testid') === 'product-query'
    ) {
      e.preventDefault();
      onAdd(shown[hi]);
    }
  };

  const sorted = [...locations].sort((a, b) =>
    a.locationType === b.locationType
      ? a.name.localeCompare(b.name)
      : a.locationType === 'warehouse'
        ? -1
        : 1,
  );
  const fromLabel = (loc: ProductSearchLocation) =>
    loc.locationType === 'warehouse'
      ? `${loc.name} — warehouse`
      : loc.id === storeId
        ? `${loc.name} — this store`
        : loc.name;
  // Header and footer name the place plainly ("At Warehouse"); the select
  // carries the "— warehouse / — this store" qualifier.
  const fromName = locations.find((l) => l.id === locationId)?.name ?? locationName ?? 'here';

  return (
    <Dialog
      title="Add product"
      description="Availability and the line's inventory source follow “From”. Each line can be changed afterwards."
      onClose={onClose}
      size="xl"
      initialFocus={searchRef}
      testId="product-search-dialog"
      className="picker"
    >
      <div className="picker-body" onKeyDown={onKeyDown}>
        <div className="picker-toolbar">
          <Field label="Search" className="picker-search">
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, SKU or vendor model — any words, any order"
              data-testid="product-query"
              autoComplete="off"
            />
          </Field>
          <Field label="Vendor">
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              data-testid="vendor-filter"
            >
              <option value="">Any</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Size">
            <Select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              data-testid="size-filter"
            >
              <option value="">Any</option>
              {SIZES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Firmness">
            <Select
              value={firmness}
              onChange={(e) => setFirmness(e.target.value)}
              data-testid="firmness-filter"
            >
              <option value="">Any</option>
              {FIRMNESS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" className="picker-from-field">
            <Select
              value={locationId}
              onChange={(e) => onChangeLocation(e.target.value)}
              data-testid="search-source"
              className="picker-from"
            >
              {sorted.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  From {fromLabel(loc)}
                </option>
              ))}
            </Select>
          </Field>
          <label className="picker-check">
            <input
              type="checkbox"
              checked={inStockFirst}
              onChange={(e) => setInStockFirst(e.target.checked)}
              data-testid="stock-filter"
            />
            In stock first
          </label>
        </div>

        <div className="picker-list" ref={listRef}>
          {rows == null ? (
            <div style={{ padding: 16 }}>
              <LoadingRows rows={6} height={40} what="The catalog" />
            </div>
          ) : (
            <table className="table table-sticky picker-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Size</th>
                  <th>Firmness</th>
                  <th className="num">Price</th>
                  <th className="num">At {fromName}</th>
                  <th className="num">All stores</th>
                  <th className="num">
                    <abbr title="Available to promise: on hand minus reserved, plus units on open purchase orders">
                      ATP
                    </abbr>
                  </th>
                  <th className="actions">
                    <span className="sr-only">Add</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr
                    {...rowKeys}
                    key={r.variantId}
                    onClick={() => onAdd(r)}
                    onMouseEnter={() => setHi(i)}
                    className={i === hi ? 'is-selected' : undefined}
                    aria-selected={i === hi}
                    data-testid="product-result"
                  >
                    <td>
                      <div className="picker-name">{r.productName}</div>
                      <div className="picker-sub">
                        {[r.vendorName, r.variantName].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </td>
                    <td className="mono">{r.sku ?? '—'}</td>
                    <td data-testid="result-size">{r.size ?? '—'}</td>
                    <td>{r.firmness ?? '—'}</td>
                    <td className="num mono">
                      {r.priceCents > 0 ? (
                        <Money cents={r.priceCents} />
                      ) : (
                        <span className="muted">at register</span>
                      )}
                    </td>
                    <td
                      className={`num mono picker-here${r.availableHere > 0 ? ' is-in' : ' is-out'}`}
                    >
                      {r.availableHere}
                    </td>
                    <td className="num mono">{r.availableTotal}</td>
                    <td className="num mono">
                      {r.availableTotal > 0
                        ? r.availableTotal
                        : r.atpDate
                          ? `~${new Date(r.atpDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                          : '—'}
                    </td>
                    <td className="actions">
                      <Button
                        size="sm"
                        className="row-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAdd(r);
                        }}
                        aria-label={`Add ${r.productName}${r.variantName ? ` ${r.variantName}` : ''}`}
                      >
                        Add
                      </Button>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={9} className="table-empty">
                      <div style={{ fontWeight: 600, color: 'var(--text)' }}>
                        Nothing matches {q.trim() ? `“${q.trim()}”` : 'these filters'}
                      </div>
                      <div>Try fewer words, or clear the vendor, size and firmness filters.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="picker-foot">
          <span>
            Showing <strong className="mono">{shown.length}</strong>
            {total != null ? (
              <>
                {' '}
                of <span className="mono">{total.toLocaleString('en-US')}</span> products
              </>
            ) : (
              ' products'
            )}
          </span>
          <span className="picker-foot-source">
            Added lines source from <strong>{fromName}</strong>
            {sourceNote ? ` ${sourceNote}` : ''}
          </span>
          <span className="picker-foot-keys">
            <Kbd keys="enter" /> adds the first row · <Kbd keys="esc" /> closes
          </span>
        </div>
      </div>
    </Dialog>
  );
}
