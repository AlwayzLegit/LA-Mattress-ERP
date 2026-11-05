'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { categoryList, categoryOptions, type CategoryFlat } from '@/lib/categories';
import { ProductsNav } from '@/components/products-nav';
import {
  Alert,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  Field,
  Input,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  TableWrap,
  useListColumns,
} from '@/components/ui';

/**
 * Min stock (owner 2026-09-25): the screen where a location's minimums —
 * `inventory_levels.reorder_point`, the STORIS per-store Min Stock that
 * until now only the catalog import could write — are set by hand, with
 * trailing sales velocity beside each item so the number is set against
 * what actually sells. Sold columns count units written at ALL stores
 * (a warehouse minimum serves every store's demand); the Weeks box widens
 * the last column when four weeks isn't enough history.
 */

interface LocationRow {
  id: string;
  name: string;
  locationType?: string;
}
interface MinStockRow {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  variantSku: string | null;
  brandName: string | null;
  groupName: string | null;
  onHand: number;
  available: number;
  reorderPoint: number | null;
  weekly: number[];
}
interface MinStockResponse {
  weeks: number;
  rows: MinStockRow[];
}

interface CategoryOption {
  id: string;
  name: string;
}

/** Units written in the trailing n weeks (weekly[0] = the last 7 days). */
function soldIn(weekly: number[], n: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(n, weekly.length); i++) sum += weekly[i] ?? 0;
  return sum;
}

export default function MinStockPage() {
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [locationId, setLocationId] = useState('');
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [q, setQ] = useState('');
  /** The adjustable window: the last sold column shows this many weeks. */
  const [weeksInput, setWeeksInput] = useState('8');
  const weeks = Math.min(52, Math.max(4, Number.parseInt(weeksInput, 10) || 4));

  const [data, setData] = useState<MinStockResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    void api<LocationRow[]>('/v1/business/locations')
      .then((l) => {
        setLocations(l);
        // Default to the warehouse — the screen exists for its buyer.
        setLocationId(
          (cur) => cur || (l.find((x) => x.locationType === 'warehouse') ?? l[0])?.id || '',
        );
      })
      .catch(() => setLocations([]));
    void api<CategoryFlat[] | { flat: CategoryFlat[] }>('/v1/categories')
      .then((r) => setCategories(categoryOptions(categoryList(r))))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (!locationId) return;
    const mine = ++seq.current;
    setError(null);
    const t = setTimeout(() => {
      const p = new URLSearchParams({ locationId, weeks: String(weeks) });
      if (q.trim()) p.set('q', q.trim());
      if (categoryId) p.set('categoryId', categoryId);
      void api<MinStockResponse>(`/v1/inventory/min-stock?${p}`)
        .then((r) => {
          if (seq.current !== mine) return;
          setData(r);
          setDrafts({});
        })
        .catch((err) => {
          if (seq.current !== mine) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 300);
    return () => clearTimeout(t);
  }, [locationId, q, categoryId, weeks]);

  const save = useCallback(
    async (row: MinStockRow) => {
      const raw = drafts[row.variantId];
      if (raw === undefined) return;
      const point = raw.trim() === '' ? null : Number(raw);
      if (point !== null && (!Number.isInteger(point) || point < 0)) {
        toast.error('Min must be a whole number (or empty for not managed).');
        return;
      }
      if (point === row.reorderPoint) return;
      setSavingId(row.variantId);
      try {
        await api('/v1/inventory/min-stock', {
          method: 'PATCH',
          body: JSON.stringify({ variantId: row.variantId, locationId, reorderPoint: point }),
        });
        setData((cur) =>
          cur
            ? {
                ...cur,
                rows: cur.rows.map((r) =>
                  r.variantId === row.variantId ? { ...r, reorderPoint: point } : r,
                ),
              }
            : cur,
        );
        setDrafts((d) => {
          const { [row.variantId]: _done, ...rest } = d;
          return rest;
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingId(null);
      }
    },
    [drafts, locationId],
  );

  const locationName = locations.find((l) => l.id === locationId)?.name ?? '…';

  // Owner 2026-11-04: brand and group as columns of their own, every
  // column sortable (click a header), order draggable. The min cell shows
  // the saved number beside the box so "0" and "not set" read differently.
  const columns = useMemo<ColumnDef<MinStockRow>[]>(() => {
    const sold = (n: number, label: string, cls?: string): ColumnDef<MinStockRow> => ({
      id: `sold${n}`,
      label,
      num: true,
      className: cls,
      sortValue: (r) => soldIn(r.weekly, n),
      render: (r) => soldIn(r.weekly, n),
    });
    const cols: ColumnDef<MinStockRow>[] = [
      {
        id: 'product',
        label: 'Product',
        className: 'first',
        sortValue: (r) => r.productName,
        render: (r) => (
          <>
            {r.productName}
            {r.variantName ? (
              <span style={{ color: 'var(--muted)' }}> · {r.variantName}</span>
            ) : null}
          </>
        ),
      },
      {
        id: 'sku',
        label: 'SKU',
        className: 'mono',
        sortValue: (r) => r.variantSku,
        render: (r) => r.variantSku ?? '—',
      },
      {
        id: 'brand',
        label: 'Brand',
        sortValue: (r) => r.brandName,
        render: (r) => r.brandName ?? <span style={{ color: 'var(--muted)' }}>—</span>,
      },
      {
        id: 'group',
        label: 'Group',
        sortValue: (r) => r.groupName,
        render: (r) => r.groupName ?? <span style={{ color: 'var(--muted)' }}>—</span>,
      },
      {
        id: 'onHand',
        label: 'On hand',
        num: true,
        sortValue: (r) => r.onHand,
        render: (r) => r.onHand,
      },
      {
        id: 'available',
        label: 'Available',
        num: true,
        sortValue: (r) => r.available,
        cellClassName: (r) =>
          r.reorderPoint != null && r.reorderPoint > 0 && r.available < r.reorderPoint
            ? 'minstock-below'
            : null,
        render: (r) => r.available,
      },
      {
        id: 'min',
        label: `Min · ${locationName}`,
        num: true,
        sortValue: (r) => r.reorderPoint,
        render: (r) => {
          const draft = drafts[r.variantId];
          const dirty =
            draft !== undefined && draft !== (r.reorderPoint != null ? String(r.reorderPoint) : '');
          return (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span
                className="text-xs"
                style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}
                data-testid="minstock-saved"
              >
                {r.reorderPoint == null ? 'not set' : `set to ${r.reorderPoint}`}
              </span>
              <Input
                value={draft ?? (r.reorderPoint != null ? String(r.reorderPoint) : '')}
                onChange={(e) =>
                  setDrafts((d) => ({
                    ...d,
                    [r.variantId]: e.target.value.replace(/[^\d]/g, ''),
                  }))
                }
                onBlur={() => void save(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                inputMode="numeric"
                placeholder="—"
                disabled={savingId === r.variantId}
                className="input-num"
                style={dirty ? { borderColor: 'var(--warn)' } : undefined}
                title={dirty ? 'Unsaved — press Enter or leave the box to save' : undefined}
                aria-label={`Minimum for ${r.productName}`}
                data-testid="minstock-input"
              />
            </div>
          );
        },
      },
      sold(1, 'Sold 1 wk'),
      sold(2, '2 wk'),
      sold(3, '3 wk'),
      sold(4, '4 wk', weeks > 4 ? undefined : 'last'),
    ];
    if (weeks > 4) cols.push(sold(weeks, `${weeks} wk`, 'last'));
    return cols;
  }, [drafts, locationName, save, savingId, weeks]);
  const cols = useListColumns('minstock', columns, data?.rows ?? null);

  return (
    <div>
      <PageHeader
        title="Min stock"
        sub="Set what each item's on-hand needs to be at a location, next to what it actually sold — the sales-rate replenishment engine and the amber low-stock flags read these minimums"
      />
      <ProductsNav />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Location">
            <Select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              data-testid="minstock-location"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.locationType === 'warehouse' ? ' (warehouse)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, SKU, barcode"
              data-testid="minstock-search"
            />
          </Field>
          <Field label="Category">
            <Select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              data-testid="minstock-category"
            >
              <option value="">Any</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Weeks (last column)">
            <Input
              type="number"
              min={4}
              max={52}
              value={weeksInput}
              onChange={(e) => setWeeksInput(e.target.value)}
              className="input-num"
              style={{ width: 90 }}
              data-testid="minstock-weeks"
            />
          </Field>
        </div>
      </Card>

      <div aria-live="polite" className="mt-3">
        {error && <Alert tone="error">{error}</Alert>}
      </div>

      {!data && !error ? (
        <LoadingRows rows={8} />
      ) : data && data.rows.length === 0 ? (
        <EmptyState title="No items">
          No active products match — clear the search or pick another category.
        </EmptyState>
      ) : data ? (
        <TableWrap>
          {/* dt-static: inside a scrolling wrap a sticky header pins to the
              wrap, not the page, and slides 50px down over the first rows. */}
          <table className="dt dt-static" data-testid="minstock-table">
            <thead>
              <ColumnHeadRow list={cols} testIdPrefix="minstock" />
            </thead>
            <tbody>
              {cols.sorted.map((r, i) => (
                <tr key={r.variantId} data-testid="minstock-row">
                  <ColumnCells list={cols} row={r} index={i} />
                </tr>
              ))}
            </tbody>
          </table>
          <ResetColumns list={cols} />
        </TableWrap>
      ) : null}
      {data && (
        <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          Sold columns count units written at all stores (register sales + orders; quotes, cancels
          and imported history excluded). An amber Available sits below the item&apos;s minimum.
          Click a column to sort; the box shows the saved minimum, and a blank box means the item is
          not managed here.
        </p>
      )}
    </div>
  );
}
