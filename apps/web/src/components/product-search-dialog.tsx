'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import { Button, Card, Input, Select, TableEmpty, TableWrap, Toolbar } from '@/components/ui';

/**
 * The Add Product popup shared by New Sale and the order page's line
 * editor: search with vendor/stock filters, availability + ATP for the
 * chosen "From" location, click a row to add it. The caller owns what
 * "add" means (a cart line, an order line).
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
const SIZES = [
  'Twin',
  'Twin XL',
  'Full',
  'Queen',
  'King',
  'Cal King',
  'Split King',
  'Split Cal King',
];
const FIRMNESS = ['Plush', 'Medium', 'Medium Firm', 'Firm', 'Extra Firm'];
export function ProductSearchDialog({
  locationId,
  locationName,
  locations,
  storeId,
  onChangeLocation,
  onAdd,
  onClose,
}: {
  locationId: string;
  locationName: string | null;
  locations: ProductSearchLocation[];
  storeId: string;
  onChangeLocation: (id: string) => void;
  onAdd: (row: SearchRow) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [stockFilter, setStockFilter] = useState<'' | '1' | '0'>('');
  const [size, setSize] = useState('');
  const [firmness, setFirmness] = useState('');
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  // BA-0010: arrow keys move a visible highlight through the results,
  // Enter adds the highlighted row.
  const [hi, setHi] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // BA-0011: focus returns to whatever opened the dialog when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    void api<{ data: VendorRow[] } | VendorRow[]>('/v1/vendors?limit=100')
      .then((r) => setVendors(Array.isArray(r) ? r : r.data))
      .catch(() => setVendors([]));
  }, []);

  // BA-0011: focus trap — Tab wraps inside the dialog, Escape closes.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length > 0) {
        e.preventDefault();
        const next =
          e.key === 'ArrowDown' ? Math.min(hi + 1, rows.length - 1) : Math.max(hi - 1, 0);
        setHi(next);
        panelRef.current
          ?.querySelectorAll('[data-testid="product-result"]')
          [next]?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    // Enter adds the highlighted row only from the search box — buttons
    // and selects keep their native Enter behavior.
    if (
      e.key === 'Enter' &&
      rows[hi] &&
      (e.target as HTMLElement).getAttribute('data-testid') === 'product-query'
    ) {
      e.preventDefault();
      onAdd(rows[hi]);
      return;
    }
    if (e.key === 'Tab' && panelRef.current) {
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (vendorId) params.set('vendorId', vendorId);
      if (stockFilter) params.set('inStock', stockFilter);
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
    }, 250);
  }, [q, vendorId, stockFilter, size, firmness, locationId]);

  return (
    // Modal chrome: no shared overlay primitive exists yet, so the
    // backdrop/panel positioning is structural utility classes.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add Product"
        className="w-[min(760px,94vw)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        data-testid="product-search-dialog"
      >
        <Card
          title="Add Product"
          description="Availability and the added line’s inventory source follow the “From” location — each line can still be changed on the order afterwards."
          actions={
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close Add Product">
              <X size={14} aria-hidden />
            </Button>
          }
        >
          <Toolbar
            end={
              rows.length >= 100 ? (
                <span className="muted">Showing first 100 — refine your search.</span>
              ) : undefined
            }
          >
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search model, brand, size…"
              aria-label="Search products"
              data-testid="product-query"
            />
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              aria-label="Vendor filter"
              data-testid="vendor-filter"
            >
              <option value="">All vendors</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
            <Select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              aria-label="Size filter"
              data-testid="size-filter"
            >
              <option value="">All sizes</option>
              {SIZES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <Select
              value={firmness}
              onChange={(e) => setFirmness(e.target.value)}
              aria-label="Firmness filter"
              data-testid="firmness-filter"
            >
              <option value="">All firmness</option>
              {FIRMNESS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <Select
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value as typeof stockFilter)}
              data-testid="stock-filter"
              aria-label="Stock filter"
            >
              <option value="">All stock</option>
              <option value="1">In stock</option>
              <option value="0">Not in stock</option>
            </Select>
            <Select
              value={locationId}
              onChange={(e) => onChangeLocation(e.target.value)}
              data-testid="search-source"
              aria-label="Inventory from"
            >
              {[...locations]
                .sort((a, b) =>
                  a.locationType === b.locationType
                    ? a.name.localeCompare(b.name)
                    : a.locationType === 'warehouse'
                      ? -1
                      : 1,
                )
                .map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    From {loc.name}
                    {loc.locationType === 'warehouse' ? ' (WH)' : ''}
                    {loc.id === storeId ? ' — this store' : ''}
                  </option>
                ))}
            </Select>
          </Toolbar>
          <TableWrap maxHeight="52vh">
            <table className="table table-sticky">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Vendor</th>
                  <th className="num">Price</th>
                  <th className="num" title={locationName ?? undefined}>
                    {locationName ? `At ${locationName}` : 'Here'}
                  </th>
                  <th className="num">All</th>
                  <th>ATP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.variantId}
                    onClick={() => onAdd(r)}
                    onMouseEnter={() => setHi(i)}
                    style={{
                      cursor: 'pointer',
                      // BA-0010: the keyboard highlight is visible.
                      background: i === hi ? 'var(--surface-hover, rgb(0 0 0 / 0.06))' : undefined,
                    }}
                    aria-selected={i === hi}
                    data-testid="product-result"
                  >
                    <td>
                      {r.productName}
                      {r.variantName ? ` — ${r.variantName}` : ''}
                    </td>
                    <td>
                      <code>{r.sku ?? '—'}</code>
                    </td>
                    <td>{r.vendorName ?? '—'}</td>
                    <td className="num">
                      {r.priceCents > 0 ? (
                        <Money cents={r.priceCents} />
                      ) : (
                        // D12: an unpriced catalog item is priced at the
                        // register — say so instead of showing "$0.00".
                        <span className="muted">price at register</span>
                      )}
                    </td>
                    <td className="num">{r.availableHere}</td>
                    <td className="num">{r.availableTotal}</td>
                    <td className="muted">
                      {r.availableTotal > 0
                        ? ''
                        : r.atpDate
                          ? `~${new Date(r.atpDate).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                            })}`
                          : 'no PO'}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <TableEmpty colSpan={7}>No matches.</TableEmpty>}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>
    </div>
  );
}
