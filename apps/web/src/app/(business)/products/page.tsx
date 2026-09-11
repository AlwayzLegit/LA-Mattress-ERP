'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { GripVertical, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { PRODUCT_PURCHASE_STATUS_LABELS, type ProductPurchaseStatus } from '@jetnine/shared';
import { api } from '@/lib/api';
import { CsvImport } from '@/components/csv-import';
import { LoadMore } from '@/components/load-more';
import { Money } from '@/components/money';
import { ProductsNav } from '@/components/products-nav';
import { useCursorList } from '@/lib/use-cursor-list';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  StatusBadge,
  TableWrap,
  Toolbar,
} from '@/components/ui';

/**
 * The STORIS product browser (amendment A19, owner 2026-09-10): one row
 * per product with Vendor Model · Vendor · Description · On Hand ·
 * Available · Net On PO · Sales Margin Cost · As-Is On Hand · As-Is
 * Available · Price · Status · As-Is Non-Sellable · Product Group · Brand,
 * across every store or one of them.
 */
interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
  isActive: boolean;
  purchaseStatus: ProductPurchaseStatus | string;
  brandName: string | null;
  vendorName: string | null;
  vendorModel: string | null;
  group: string | null;
  priceCents: number | null;
  costCents: number | null;
  onHand: number;
  available: number;
  netOnPo: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
}

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * The browser's columns (owner 2026-09-11): drag a header to put the
 * columns in any order — kept per browser in localStorage — and click a
 * header to sort by it (server-side, so every page follows the sort).
 * `sort` is the API key; `num` right-aligns.
 */
interface Column {
  id: string;
  label: string;
  sort: string;
  num?: boolean;
  render: (p: ProductRow, statusLabel: (p: ProductRow) => string) => ReactNode;
}

const COLUMNS: Column[] = [
  {
    id: 'product',
    label: 'Product',
    sort: 'sku',
    render: (p) => <code>{p.sku ?? '—'}</code>,
  },
  {
    id: 'vendorModel',
    label: 'Vendor model',
    sort: 'vendorModel',
    render: (p) => p.vendorModel ?? '—',
  },
  { id: 'vendor', label: 'Vendor', sort: 'vendorName', render: (p) => p.vendorName ?? '—' },
  {
    id: 'description',
    label: 'Description',
    sort: 'name',
    render: (p) => <strong>{p.name}</strong>,
  },
  { id: 'onHand', label: 'On hand', sort: 'onHand', num: true, render: (p) => p.onHand },
  { id: 'available', label: 'Available', sort: 'available', num: true, render: (p) => p.available },
  { id: 'netOnPo', label: 'Net on PO', sort: 'netOnPo', num: true, render: (p) => p.netOnPo },
  {
    id: 'cost',
    label: 'Sales margin cost',
    sort: 'costCents',
    num: true,
    render: (p) =>
      p.costCents != null ? <Money cents={p.costCents} /> : <em className="muted">hidden</em>,
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
    render: (p) => (p.priceCents != null ? <Money cents={p.priceCents} /> : '—'),
  },
  {
    id: 'status',
    label: 'Status',
    sort: 'purchaseStatus',
    render: (p, statusLabel) => (
      <>
        {statusLabel(p)}
        {!p.isActive && (
          <>
            {' '}
            <StatusBadge status="inactive" />
          </>
        )}
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
  { id: 'group', label: 'Product group', sort: 'group', render: (p) => p.group ?? '—' },
  { id: 'brand', label: 'Brand', sort: 'brandName', render: (p) => p.brandName ?? '—' },
];
const DEFAULT_ORDER = COLUMNS.map((c) => c.id);
const COLUMN_ORDER_KEY = 'jetnine.products.columns';

function readColumnOrder(): string[] {
  try {
    const raw = localStorage.getItem(COLUMN_ORDER_KEY);
    if (!raw) return DEFAULT_ORDER;
    const saved = JSON.parse(raw) as unknown;
    if (!Array.isArray(saved)) return DEFAULT_ORDER;
    const known = saved.filter((id): id is string => DEFAULT_ORDER.includes(String(id)));
    // Columns added after the order was saved go on the end.
    return [...known, ...DEFAULT_ORDER.filter((id) => !known.includes(id))];
  } catch {
    return DEFAULT_ORDER;
  }
}

function writeColumnOrder(order: string[]): void {
  try {
    if (order.join() === DEFAULT_ORDER.join()) localStorage.removeItem(COLUMN_ORDER_KEY);
    else localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Storage unavailable — the order lasts for this page only.
  }
}

export default function ProductsPage() {
  const router = useRouter();
  const list = useCursorList<ProductRow>('/v1/products');
  const [q, setQ] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  // Owner 2026-09-10: the catalog replace retired 733 listings; the browser
  // lists what is still sellable unless you ask for the rest.
  const [includeInactive, setIncludeInactive] = useState(false);
  // Vendor door (owner 2026-09-02): /products?vendorId=…&vendor=Name from
  // the vendors page's "products we carry" count.
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  // Owner 2026-09-11: column order (per browser) and sort (in the URL).
  const [order, setOrder] = useState<string[]>(DEFAULT_ORDER);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [sort, setSort] = useState('');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const { rows, error } = list;

  const params = (
    query: string,
    v = vendor,
    loc = locationId,
    inactive = includeInactive,
    s = sort,
    d = dir,
  ) => ({
    ...(query ? { q: query } : {}),
    ...(v ? { vendorId: v.id } : {}),
    ...(loc ? { locationId: loc } : {}),
    ...(inactive ? { includeInactive: '1' } : {}),
    ...(s ? { sort: s, dir: d } : {}),
  });

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const vendorId = sp.get('vendorId');
    const v = vendorId ? { id: vendorId, name: sp.get('vendor') ?? 'vendor' } : null;
    setVendor(v);
    const s = COLUMNS.some((c) => c.sort === sp.get('sort')) ? (sp.get('sort') as string) : '';
    const d = sp.get('dir') === 'desc' ? 'desc' : 'asc';
    setSort(s);
    setDir(d);
    setOrder(readColumnOrder());
    void list.load(params('', v, '', false, s, d));
    api<Location[]>('/v1/business/locations')
      .then((rows) => setLocations(rows.filter((l) => l.isActive)))
      .catch(() => setLocations([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void list.load(params(q));
  }

  function changeLocation(loc: string) {
    setLocationId(loc);
    void list.load(params(q, vendor, loc));
  }

  function toggleInactive(next: boolean) {
    setIncludeInactive(next);
    void list.load(params(q, vendor, locationId, next));
  }

  // Owner 2026-08-31: delete straight from the list — same endpoint as
  // the product page's button. The server refuses (with the exact
  // reason) any product that still has stock or document history, so a
  // wrong click can never gut an invoice; the refusal shows as a toast.
  async function deleteProduct(p: ProductRow) {
    if (!confirm(`Permanently delete ${p.name} and all its variants? This cannot be undone.`))
      return;
    try {
      await api(`/v1/products/${p.id}`, { method: 'DELETE' });
      toast.success(`${p.name} deleted`);
      void list.load(params(q));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const statusLabel = (p: ProductRow) =>
    PRODUCT_PURCHASE_STATUS_LABELS[p.purchaseStatus as ProductPurchaseStatus] ?? p.purchaseStatus;

  /** Click a header: sort by it; click again to flip. The URL keeps it. */
  function toggleSort(key: string) {
    const nextDir: 'asc' | 'desc' = sort === key ? (dir === 'asc' ? 'desc' : 'asc') : 'asc';
    setSort(key);
    setDir(nextDir);
    const sp = new URLSearchParams(window.location.search);
    sp.set('sort', key);
    sp.set('dir', nextDir);
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    void list.load(params(q, vendor, locationId, includeInactive, key, nextDir));
  }

  /** Drop a dragged header on another: it takes that column's place. */
  function moveColumn(from: string, to: string) {
    if (from === to) return;
    setOrder((prev) => {
      const next = prev.filter((id) => id !== from);
      next.splice(next.indexOf(to), 0, from);
      writeColumnOrder(next);
      return next;
    });
  }

  const columns = order
    .map((id) => COLUMNS.find((c) => c.id === id))
    .filter((c): c is Column => !!c);
  const customOrder = order.join() !== DEFAULT_ORDER.join();

  return (
    <div>
      <PageHeader
        title="Products"
        actions={
          <>
            <LinkButton href="/products/duplicates" variant="secondary" size="sm">
              Find duplicates
            </LinkButton>
            <LinkButton href="/products/cleanup" variant="secondary" size="sm">
              Shopify cleanup
            </LinkButton>
            <LinkButton href="/products/pricing" variant="secondary" size="sm">
              Set prices
            </LinkButton>
            <LinkButton href="/products/labels" variant="secondary" size="sm">
              Print labels
            </LinkButton>
            <LinkButton href="/products/new" variant="primary">
              <Plus size={14} />
              Create product
            </LinkButton>
          </>
        }
      />
      <ProductsNav />

      <form onSubmit={search}>
        <Toolbar>
          <label htmlFor="products-location" className="muted">
            Location
          </label>
          <Select
            id="products-location"
            value={locationId}
            onChange={(e) => changeLocation(e.target.value)}
            data-testid="products-location"
          >
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <Input
            name="q"
            placeholder="Search by name, SKU, or barcode"
            aria-label="Search by name, SKU, or barcode"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="muted flex items-center gap-1.5 whitespace-nowrap">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => toggleInactive(e.target.checked)}
              data-testid="products-include-inactive"
            />
            Show inactive
          </label>
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('');
              void list.load(params(''));
            }}
          >
            Clear
          </Button>
        </Toolbar>
      </form>

      <Stack>
        {vendor && (
          <Alert
            tone="info"
            data-testid="products-vendor-chip"
            action={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setVendor(null);
                  window.history.replaceState(null, '', '/products');
                  void list.load(params(q, null));
                }}
              >
                clear
              </Button>
            }
          >
            Showing products from <strong>{vendor.name}</strong>
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}

        {rows == null ? (
          <Card>
            <LoadingRows />
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              title={
                q
                  ? `No products match "${q}"`
                  : includeInactive
                    ? 'No products yet'
                    : 'No active products'
              }
              action={
                q ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setQ('');
                      void list.load(params(''));
                    }}
                  >
                    Clear search
                  </Button>
                ) : (
                  <LinkButton href="/products/new" variant="secondary" size="sm">
                    Create product
                  </LinkButton>
                )
              }
            >
              {includeInactive
                ? 'Create a product or import a CSV below.'
                : 'Tick "Show inactive" to include deactivated products, or create one below.'}
            </EmptyState>
          </Card>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table" data-testid="products-table">
                <thead>
                  <tr>
                    {columns.map((c) => {
                      const active = sort === c.sort;
                      return (
                        <th
                          key={c.id}
                          className={[c.num ? 'num' : '', dropId === c.id ? 'th-drop' : '']
                            .filter(Boolean)
                            .join(' ')}
                          aria-sort={
                            active ? (dir === 'desc' ? 'descending' : 'ascending') : undefined
                          }
                          draggable
                          onDragStart={(e) => {
                            setDragId(c.id);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', c.id);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (dropId !== c.id) setDropId(c.id);
                          }}
                          onDragLeave={() => setDropId((d) => (d === c.id ? null : d))}
                          onDrop={(e) => {
                            e.preventDefault();
                            const from = dragId ?? e.dataTransfer.getData('text/plain');
                            if (from) moveColumn(from, c.id);
                            setDragId(null);
                            setDropId(null);
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setDropId(null);
                          }}
                          title="Click to sort · drag to move this column"
                          data-testid={`products-col-${c.id}`}
                        >
                          <span className="th-grip" aria-hidden>
                            <GripVertical size={11} />
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleSort(c.sort)}
                            data-testid={`products-sort-${c.id}`}
                            className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-inherit [letter-spacing:inherit] [text-transform:inherit]"
                          >
                            {c.label}
                            {active ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
                          </button>
                        </th>
                      );
                    })}
                    <th className="actions">
                      {customOrder && (
                        <button
                          type="button"
                          onClick={() => {
                            setOrder(DEFAULT_ORDER);
                            writeColumnOrder(DEFAULT_ORDER);
                          }}
                          className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-inherit [letter-spacing:inherit] [text-transform:inherit]"
                          title="Put the columns back in the standard order"
                          data-testid="products-reset-columns"
                        >
                          Reset columns
                        </button>
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr
                      key={p.id}
                      data-testid="product-row"
                      className="cursor-pointer"
                      onClick={() => router.push(`/products/${p.id}`)}
                    >
                      {columns.map((c) => (
                        <td key={c.id} className={c.num ? 'num' : undefined}>
                          {c.render(p, statusLabel)}
                        </td>
                      ))}
                      <td className="actions" onClick={(e) => e.stopPropagation()}>
                        <LinkButton href={`/products/${p.id}`} variant="secondary" size="sm">
                          Open
                        </LinkButton>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void deleteProduct(p)}
                          aria-label={`Delete ${p.name}`}
                          title="Delete this product (only when unused — no stock, no documents)"
                          data-testid="product-row-delete"
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <LoadMore state={list} noun="products" />
          </Card>
        )}

        <Card>
          <details data-testid="products-csv-import">
            <summary className="section-title cursor-pointer">
              Import products from a CSV file
            </summary>
            <div className="pt-3">
              <CsvImport entity="product" onCommitted={() => list.load(params(q))} />
            </div>
          </details>
        </Card>
      </Stack>
    </div>
  );
}
