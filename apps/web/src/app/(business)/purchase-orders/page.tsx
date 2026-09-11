'use client';

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { LoadMore } from '@/components/load-more';
import { useCursorList } from '@/lib/use-cursor-list';
import { Money } from '@/components/money';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  LinkButton,
  LoadingRows,
  PageHeader,
  SectionHeading,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
} from '@/components/ui';

interface PoRow {
  id: string;
  number: string;
  status: string;
  vendorName: string | null;
  expectedAt: string | null;
  subtotalCents: number;
  createdAt: string;
  /** Soft-deleted draft (CR 2026-08-31); only ever set under "Show deleted". */
  deletedAt: string | null;
  deletedByEmail: string | null;
}

interface SuggestionLine {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorSku: string | null;
  available: number;
  reorderPoint: number;
  suggestedQty: number;
  unitCostCents: number | null;
}
interface SuggestionGroup {
  vendorId: string | null;
  vendorName: string | null;
  lines: SuggestionLine[];
}

export default function PurchaseOrdersPage() {
  const list = useCursorList<PoRow>('/v1/purchase-orders');
  const [suggestions, setSuggestions] = useState<SuggestionGroup[] | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { rows } = list;

  // Vendor door (owner 2026-09-02): /purchase-orders?vendorId=…&vendor=Name
  // from the vendors page's "on PO" count.
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  const reload = (deleted = showDeleted, v = vendor) =>
    list.load({
      ...(deleted ? { includeDeleted: '1' } : {}),
      ...(v ? { vendorId: v.id } : {}),
    });

  async function restore(po: PoRow) {
    try {
      await api(`/v1/purchase-orders/${po.id}/restore`, { method: 'POST' });
      toast.success(`${po.number} restored.`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadSuggestions() {
    try {
      const s = await api<{ vendors: SuggestionGroup[] }>(
        '/v1/purchase-orders/reorder-suggestions',
      );
      setSuggestions(s.vendors);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const vendorId = sp.get('vendorId');
    const v = vendorId ? { id: vendorId, name: sp.get('vendor') ?? 'vendor' } : null;
    setVendor(v);
    void reload(showDeleted, v);
    void loadSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = vendor != null || showDeleted;

  return (
    <div>
      <PageHeader
        title="Purchase orders"
        actions={
          <>
            <LinkButton
              href="/print/purchase-orders?status=ordered&directShip=0&printed=0"
              variant="secondary"
              size="sm"
              target="_blank"
              title="Print every placed PO that has not been printed yet (change the filters on the print page URL)"
              data-testid="batch-print-pos"
            >
              Batch print
            </LinkButton>
            <LinkButton href="/purchase-orders/new" variant="primary">
              + New PO
            </LinkButton>
          </>
        }
      />
      <Stack>
        {(error ?? list.error) && <Alert tone="error">{error ?? list.error}</Alert>}

        {suggestions != null && suggestions.length > 0 && (
          <Card
            title="Reorder suggestions"
            description={
              <>
                Items at or below their reorder point (available = on hand − committed, all
                locations). Set points on each product&apos;s variants.{' '}
                <strong>Review &amp; order</strong> opens the builder with these lines staged —
                nothing is written until you save there.
              </>
            }
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void loadSuggestions()}
                aria-label="Refresh suggestions"
              >
                <RefreshCw size={13} aria-hidden />
              </Button>
            }
            data-testid="reorder-suggestions"
          >
            <Stack>
              {suggestions.map((g) => (
                <div key={g.vendorId ?? 'unassigned'}>
                  <SectionHeading
                    as="h3"
                    title={g.vendorName ?? 'No preferred vendor set'}
                    description={
                      g.vendorId ? undefined : (
                        <>
                          <Link href="/vendors">Create a vendor</Link> and assign it on the variant
                          to draft automatically.
                        </>
                      )
                    }
                    actions={
                      g.vendorId ? (
                        // CR 2026-08-31: this used to POST a numbered draft on
                        // the first click, which is how the list filled with
                        // $0.00 shells. It now opens the staging screen with
                        // the suggestions loaded but nothing written.
                        <LinkButton
                          size="sm"
                          variant="primary"
                          href={`/purchase-orders/new?vendorId=${g.vendorId}&preload=reorder`}
                          data-testid={`review-po-${g.vendorName}`}
                        >
                          Review &amp; order ({g.lines.length} item{g.lines.length === 1 ? '' : 's'}
                          )
                        </LinkButton>
                      ) : undefined
                    }
                  />
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>SKU</th>
                          <th className="num">Available</th>
                          <th className="num">Point</th>
                          <th className="num">Suggested</th>
                          <th className="num">Unit cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l) => (
                          <tr key={l.variantId}>
                            <td>
                              {l.productName}
                              {l.variantName && <span className="muted"> — {l.variantName}</span>}
                            </td>
                            <td>
                              <code>{l.vendorSku ?? l.sku ?? '—'}</code>
                              {l.vendorSku && l.sku && l.vendorSku !== l.sku && (
                                <div className="muted">ours: {l.sku}</div>
                              )}
                            </td>
                            <td className="num">
                              <span className="badge badge-danger">{l.available}</span>
                            </td>
                            <td className="num">{l.reorderPoint}</td>
                            <td className="num">
                              <strong>{l.suggestedQty}</strong>
                            </td>
                            <td className="num">
                              {l.unitCostCents != null ? <Money cents={l.unitCostCents} /> : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </div>
              ))}
            </Stack>
          </Card>
        )}

        <div>
          <Toolbar
            end={
              <label className="muted flex items-center gap-2" data-testid="show-deleted-toggle">
                <input
                  type="checkbox"
                  checked={showDeleted}
                  onChange={(e) => {
                    setShowDeleted(e.target.checked);
                    void reload(e.target.checked);
                  }}
                />
                Show deleted
              </label>
            }
          >
            {vendor ? (
              <span className="pill" data-testid="po-vendor-chip">
                Vendor: <strong>{vendor.name}</strong>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setVendor(null);
                    window.history.replaceState(null, '', '/purchase-orders');
                    void reload(showDeleted, null);
                  }}
                >
                  clear
                </button>
              </span>
            ) : (
              <span className="muted">All vendors</span>
            )}
          </Toolbar>

          {rows == null ? (
            <LoadingRows />
          ) : rows.length === 0 && !filtered ? (
            <EmptyState
              title="No purchase orders yet"
              action={
                <LinkButton size="sm" variant="secondary" href="/purchase-orders/new">
                  + New PO
                </LinkButton>
              }
            >
              Create a PO to restock from a vendor.
            </EmptyState>
          ) : (
            <Card flush>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>PO</th>
                      <th>Vendor</th>
                      <th>Status</th>
                      <th className="num">Subtotal</th>
                      <th>Created</th>
                      <th className="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <TableEmpty colSpan={6}>No purchase orders match these filters.</TableEmpty>
                    )}
                    {rows.map((p) => (
                      <tr
                        key={p.id}
                        data-testid={p.deletedAt ? 'po-row-deleted' : 'po-row'}
                        style={p.deletedAt ? { opacity: 0.55 } : undefined}
                      >
                        <td>
                          <code>{p.number}</code>
                          {p.deletedAt && (
                            <div className="muted">
                              deleted {new Date(p.deletedAt).toLocaleString()}
                              {p.deletedByEmail ? ` by ${p.deletedByEmail}` : ''}
                            </div>
                          )}
                        </td>
                        <td>{p.vendorName ?? '—'}</td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="num">
                          <Money cents={p.subtotalCents} />
                        </td>
                        <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                        <td className="actions">
                          {p.deletedAt && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void restore(p)}
                              data-testid={`restore-${p.number}`}
                            >
                              Restore
                            </Button>
                          )}
                          <LinkButton
                            size="sm"
                            variant="secondary"
                            href={`/purchase-orders/${p.id}`}
                          >
                            Open
                          </LinkButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <LoadMore state={list} noun="purchase orders" />
            </Card>
          )}
        </div>
      </Stack>
    </div>
  );
}
