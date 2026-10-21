'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import {
  Alert,
  Button,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  LinkButton,
  LoadingRows,
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
 *
 * The filter strip and the product columns are shared with Stock by
 * location (`product-filters.tsx`, `product-columns.tsx`).
 */

interface StoreCell {
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  min: number | null;
  demand: number;
}
interface ProductRow extends ProductColumnFields {
  reserved: number;
  stockByLocation: Record<string, StoreCell>;
}
interface LocationRow {
  id: string;
  name: string;
  locationType?: string;
  isActive?: boolean;
}

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
  const f = useProductFilters(initial);
  const [sort, setSort] = useState(initial.get('sort') ?? '');
  const [dir, setDir] = useState<'asc' | 'desc'>(initial.get('dir') === 'desc' ? 'desc' : 'asc');
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  // Store columns: the warehouse first, then the stores by name.
  const storeColumns = useMemo<ColumnDef<ProductRow>[]>(
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
          sortKey: `available:${l.id}`,
          num: true,
          thClassName: 'pb-store-th',
          render: (p: ProductRow): ReactNode => {
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
  // `canSeeCost` comes from /members/me; until it loads, fall back to
  // "any row carries a cost" so the column never flashes in and out.
  const canSeeCost = useOptionalActingStore()?.me?.canSeeCost;
  const showCost = canSeeCost ?? (rows ?? []).some((r) => r.costCents != null);
  const visibleColumns = useMemo<ColumnDef<ProductRow>[]>(
    () => [
      ...productIdentityColumns<ProductRow>(),
      ...storeColumns,
      ...productDetailColumns<ProductRow>(showCost),
    ],
    [storeColumns, showCost],
  );
  useEffect(migrateLegacyColumnOrder, []);
  const cols = useListColumns('products', visibleColumns, rows, {
    server: { sort, dir, onSort: toggleSort },
  });

  useEffect(() => {
    void api<LocationRow[]>('/v1/business/locations')
      .then((l) => setLocations(l))
      .catch(() => setLocations([]));
  }, []);

  const filterParams = f.params;
  const params = useCallback(
    (cursor: string | null) => {
      const p = filterParams();
      p.set('limit', '50');
      if (sort) {
        p.set('sort', sort);
        p.set('dir', dir);
      }
      if (cursor) p.set('cursor', cursor);
      return p;
    },
    [filterParams, sort, dir],
  );

  useEffect(() => {
    const mine = ++seq.current;
    // Mirror into the URL (replace, no history spam).
    const u = params(null);
    u.delete('limit');
    if (f.vendor) u.set('vendor', f.vendor.name);
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
        <ProductFilterBar
          f={f}
          showCost={showCost}
          end={
            cols.isCustom && (
              <Button
                variant="ghost"
                size="sm"
                onClick={cols.reset}
                data-testid="products-reset-columns"
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
                      {f.filtered && (
                        <Button size="sm" onClick={f.clearAll} style={{ marginTop: 10 }}>
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
