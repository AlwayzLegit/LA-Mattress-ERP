'use client';

import { useEffect, useState } from 'react';
import { PackageCheck, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { ProductsNav } from '@/components/products-nav';
import {
  Alert,
  BackLink,
  Button,
  Card,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  PageHeader,
  Select,
  Stack,
  TableWrap,
  Toolbar,
} from '@/components/ui';

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}
interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
}
interface Variant {
  id: string;
  sku: string | null;
  name: string | null;
  barcode: string | null;
}
interface ProductDetail {
  id: string;
  name: string;
  variants: Variant[];
}

interface Line {
  variantId: string;
  label: string;
  quantity: number;
}

export default function ReceivePage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<ProductRow[]>([]);
  const [searchMore, setSearchMore] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState('');
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void api<Location[]>('/v1/business/locations').then((rows) => {
      const active = rows.filter((l) => l.isActive);
      setLocations(active);
      if (active[0]) setLocationId(active[0].id);
    });
  }, []);

  async function searchProducts() {
    if (!search.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      const res = await api<{ data: ProductRow[]; nextCursor: string | null }>(
        `/v1/products?q=${encodeURIComponent(search)}&limit=50`,
      );
      setSearchResults(res.data);
      // The q-search branch server-side is a single ranked page with
      // nextCursor always null, so a full page is the truncation signal.
      setSearchMore(res.nextCursor != null || res.data.length >= 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addProduct(productId: string) {
    try {
      const detail = await api<ProductDetail>(`/v1/products/${productId}`);
      // Append every variant of the matched product as a line with qty=0.
      setLines((prev) => {
        const existing = new Set(prev.map((l) => l.variantId));
        const additions = detail.variants
          .filter((v) => !existing.has(v.id))
          .map((v) => ({
            variantId: v.id,
            label: `${detail.name} — ${v.sku ?? v.name ?? v.id.slice(0, 8)}`,
            quantity: 0,
          }));
        return [...prev, ...additions];
      });
      setSearchResults([]);
      setSearch('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function setQty(i: number, qty: number) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, quantity: qty } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function commit() {
    if (committing) return;
    setError(null);
    setSuccess(null);
    if (!locationId) {
      setError('Pick a location first');
      return;
    }
    const positive = lines.filter((l) => l.quantity > 0);
    if (positive.length === 0) {
      setError('At least one line must have a positive quantity');
      return;
    }
    setCommitting(true);
    try {
      await api<{ lines: { onHand: number }[] }>('/v1/inventory/receive', {
        method: 'POST',
        body: JSON.stringify({
          locationId,
          notes: notes || undefined,
          lines: positive.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        }),
      });
      const total = positive.reduce((s, l) => s + l.quantity, 0);
      setSuccess(
        `Received ${total} unit${total === 1 ? '' : 's'} across ${positive.length} variant${
          positive.length === 1 ? '' : 's'
        }.`,
      );
      setLines([]);
      setNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/products">Products</BackLink>}
        title="Receive inventory"
      />
      <ProductsNav />

      <Stack>
        <Card title="Receipt">
          <FormGrid cols={2}>
            <Field label="Location" required>
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">— Pick —</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notes">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </FormGrid>
        </Card>

        <Card title="Add products">
          <Toolbar>
            <Input
              placeholder="Search by name, SKU, or barcode"
              aria-label="Search products"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void searchProducts();
                }
              }}
            />
            <Button variant="secondary" size="sm" onClick={searchProducts}>
              <Search size={14} />
              Search
            </Button>
          </Toolbar>
          {searchResults.length > 0 && (
            <TableWrap>
              <table className="table table-dense">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                      </td>
                      <td>
                        <code>{p.sku ?? '—'}</code>
                      </td>
                      <td className="actions">
                        <Button size="sm" variant="secondary" onClick={() => addProduct(p.id)}>
                          Add variants
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {searchMore && (
                    <tr>
                      <td colSpan={3} className="muted">
                        More matches — refine your search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Lines">
          {lines.length === 0 ? (
            <EmptyState title="No lines yet">Search and add a product.</EmptyState>
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th className="num">Quantity</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.variantId}>
                      <td>{l.label}</td>
                      <td className="num">
                        <Input
                          type="number"
                          min={0}
                          value={l.quantity}
                          onChange={(e) => setQty(i, Number(e.target.value))}
                          aria-label={`Quantity for ${l.label}`}
                          className="w-24 text-right"
                        />
                      </td>
                      <td className="actions">
                        <Button size="sm" variant="danger" onClick={() => removeLine(i)}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {error && (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          )}
          {success && (
            <Alert tone="success" className="mt-3" data-testid="receive-success">
              {success}
            </Alert>
          )}
          <FormActions>
            <Button variant="primary" onClick={commit} disabled={lines.length === 0 || committing}>
              <PackageCheck size={14} />
              {committing ? 'Committing…' : 'Commit'}
            </Button>
          </FormActions>
        </Card>
      </Stack>
    </div>
  );
}
