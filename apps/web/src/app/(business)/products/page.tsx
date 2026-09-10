'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
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

export default function ProductsPage() {
  const router = useRouter();
  const list = useCursorList<ProductRow>('/v1/products');
  const [q, setQ] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  // Vendor door (owner 2026-09-02): /products?vendorId=…&vendor=Name from
  // the vendors page's "products we carry" count.
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  const { rows, error } = list;

  const params = (query: string, v = vendor, loc = locationId) => ({
    ...(query ? { q: query } : {}),
    ...(v ? { vendorId: v.id } : {}),
    ...(loc ? { locationId: loc } : {}),
  });

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const vendorId = sp.get('vendorId');
    const v = vendorId ? { id: vendorId, name: sp.get('vendor') ?? 'vendor' } : null;
    setVendor(v);
    void list.load(params('', v, ''));
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
              title={q ? `No products match "${q}"` : 'No products yet'}
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
              Create a product or import a CSV below.
            </EmptyState>
          </Card>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table" data-testid="products-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Vendor model</th>
                    <th>Vendor</th>
                    <th>Description</th>
                    <th className="num">On hand</th>
                    <th className="num">Available</th>
                    <th className="num">Net on PO</th>
                    <th className="num">Sales margin cost</th>
                    <th className="num">As-Is on hand</th>
                    <th className="num">As-Is available</th>
                    <th className="num">Price</th>
                    <th>Status</th>
                    <th className="num">As-Is non-sellable</th>
                    <th>Product group</th>
                    <th>Brand</th>
                    <th className="actions" />
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
                      <td>
                        <code>{p.sku ?? '—'}</code>
                      </td>
                      <td>{p.vendorModel ?? '—'}</td>
                      <td>{p.vendorName ?? '—'}</td>
                      <td>
                        <strong>{p.name}</strong>
                      </td>
                      <td className="num">{p.onHand}</td>
                      <td className="num">{p.available}</td>
                      <td className="num">{p.netOnPo}</td>
                      <td className="num">
                        {p.costCents != null ? (
                          <Money cents={p.costCents} />
                        ) : (
                          <em className="muted">hidden</em>
                        )}
                      </td>
                      <td className="num">{p.asIsOnHand}</td>
                      <td className="num">{p.asIsAvailable}</td>
                      <td className="num">
                        {p.priceCents != null ? <Money cents={p.priceCents} /> : '—'}
                      </td>
                      <td>
                        {statusLabel(p)}
                        {!p.isActive && (
                          <>
                            {' '}
                            <StatusBadge status="inactive" />
                          </>
                        )}
                      </td>
                      <td className="num">{p.asIsNonSellable}</td>
                      <td>{p.group ?? '—'}</td>
                      <td>{p.brandName ?? '—'}</td>
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
