'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Stack,
  TableWrap,
  useListColumns,
} from '@/components/ui';

interface DupProduct {
  id: string;
  sku: string | null;
  name: string;
  isActive: boolean;
  createdAt: string;
  priceCents: number | null;
  variants: number;
  onHand: number;
  reserved: number;
  documents: number;
  deletable: boolean;
  source: string | null;
  imported: boolean;
}
interface DupGroup {
  name: string;
  products: DupProduct[];
}

/**
 * Duplicate products (owner ask 2026-09-02): the same mattress showing
 * two or three times in the Add Product popup. One row per product that
 * shares its name with another, with what retiring it would touch, and
 * the two safe ways out — deactivate (hides it from selling, keeps its
 * history) or delete (only when nothing references it).
 */
export default function DuplicateProductsPage() {
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ groups: DupGroup[]; productCount: number }>('/v1/products/duplicates');
      setGroups(r.groups);
      setCount(r.productCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function deactivate(p: DupProduct) {
    if (!confirm(`Hide ${p.name} (${p.sku ?? 'no SKU'}) from selling? Its history stays.`)) return;
    setBusy(p.id);
    try {
      await api(`/v1/products/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: false }),
      });
      toast.success(`${p.sku ?? p.name} deactivated`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function keepImported(names?: string[]) {
    const scope = names ? `for "${names[0]}"` : 'in every group';
    if (
      !confirm(
        `Keep the imported copy ${scope} and deactivate the Shopify / app-built copies? Nothing is deleted.`,
      )
    )
      return;
    setBusy(names ? names[0]! : '*');
    try {
      const r = await api<{ deactivated: unknown[]; kept: number; skippedGroups: number }>(
        '/v1/products/duplicates/keep-imported',
        { method: 'POST', body: JSON.stringify(names ? { names } : {}) },
      );
      toast.success(
        `Deactivated ${r.deactivated.length}, kept ${r.kept} imported` +
          (r.skippedGroups
            ? ` · ${r.skippedGroups} group${r.skippedGroups === 1 ? '' : 's'} had no imported copy`
            : ''),
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(p: DupProduct) {
    if (!confirm(`Permanently delete ${p.name} (${p.sku ?? 'no SKU'})? This cannot be undone.`))
      return;
    setBusy(p.id);
    try {
      await api(`/v1/products/${p.id}`, { method: 'DELETE' });
      toast.success(`${p.sku ?? p.name} deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // One column set shared by every group's table; the rows are sorted as
  // one list and then split back into their groups (jeopardy's pattern).
  const DUP_COLUMNS: ColumnDef<DupProduct>[] = [
    {
      id: 'sku',
      label: 'SKU',
      sortValue: (p) => p.sku,
      render: (p) => (
        <>
          <code>{p.sku ?? '—'}</code>
          {p.variants > 1 && <span className="muted"> · {p.variants} variants</span>}
        </>
      ),
    },
    {
      id: 'source',
      label: 'Source',
      sortValue: (p) => p.source ?? 'built here',
      render: (p) => (
        <span
          className={`badge ${p.imported ? 'badge-success' : 'badge-neutral'}`}
          data-testid="duplicate-source"
        >
          {p.source ?? 'built here'}
        </span>
      ),
    },
    {
      id: 'price',
      label: 'Price',
      num: true,
      sortValue: (p) => p.priceCents,
      render: (p) => (p.priceCents != null ? <Money cents={p.priceCents} /> : '—'),
    },
    {
      id: 'onHand',
      label: 'On hand',
      num: true,
      sortValue: (p) => p.onHand,
      render: (p) => (
        <strong style={{ color: p.onHand > 0 ? 'var(--success)' : undefined }}>{p.onHand}</strong>
      ),
    },
    {
      id: 'reserved',
      label: 'Reserved',
      num: true,
      sortValue: (p) => p.reserved,
      render: (p) => p.reserved,
    },
    {
      id: 'documents',
      label: 'Documents',
      num: true,
      sortValue: (p) => p.documents,
      render: (p) => p.documents,
    },
    {
      id: 'created',
      label: 'Created',
      className: 'nowrap',
      sortValue: (p) => p.createdAt,
      render: (p) => new Date(p.createdAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (p) => (
        <>
          <LinkButton href={`/products/${p.id}`} variant="secondary" size="sm">
            Open
          </LinkButton>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy === p.id}
            onClick={() => void deactivate(p)}
            data-testid="duplicate-deactivate"
          >
            Deactivate
          </Button>
          {p.deletable && (
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={busy === p.id}
              onClick={() => void remove(p)}
              data-testid="duplicate-delete"
            >
              Delete
            </Button>
          )}
        </>
      ),
    },
  ];
  const allProducts = useMemo(() => groups?.flatMap((g) => g.products) ?? null, [groups]);
  const cols = useListColumns('products-duplicates', DUP_COLUMNS, allProducts);

  return (
    <div data-testid="duplicate-products">
      <PageHeader
        eyebrow={<BackLink href="/products">Back to products</BackLink>}
        title="Duplicate products"
        sub={
          groups && groups.length > 0
            ? `${groups.length} name${groups.length === 1 ? '' : 's'} · ${count} products`
            : undefined
        }
        actions={
          groups && groups.some((g) => canKeepImported(g)) ? (
            <Button
              variant="primary"
              disabled={busy != null}
              onClick={() => void keepImported()}
              data-testid="keep-imported-all"
            >
              Keep imported copies everywhere
            </Button>
          ) : undefined
        }
      />
      <Stack>
        <Alert tone="info">
          Active products that share a name with another. Each row says where it came from (the
          STORIS/CSV import, a Shopify sync, or built here). &ldquo;Keep imported&rdquo; deactivates
          the non-import copies in a group so they stop showing at the register; nothing is deleted,
          and a deactivated product can be switched back on from its page.
        </Alert>
        {error && <Alert tone="error">{error}</Alert>}
        {groups == null ? (
          <Card>
            <LoadingRows />
          </Card>
        ) : groups.length === 0 ? (
          <Card>
            <EmptyState title="No duplicates">No two active products share a name.</EmptyState>
          </Card>
        ) : (
          groups.map((g) => (
            <Card
              key={g.name}
              title={g.name}
              flush
              data-testid="duplicate-group"
              actions={
                canKeepImported(g) ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy != null}
                    onClick={() => void keepImported([g.name])}
                    data-testid="keep-imported-group"
                  >
                    Keep imported copy
                  </Button>
                ) : undefined
              }
            >
              <TableWrap>
                <table className="table">
                  <thead>
                    <ColumnHeadRow list={cols} testIdPrefix="products-duplicates" />
                  </thead>
                  <tbody>
                    {cols.sorted
                      .filter((p) => g.products.includes(p))
                      .map((p) => (
                        <tr key={p.id}>
                          <ColumnCells list={cols} row={p} />
                        </tr>
                      ))}
                  </tbody>
                </table>
                <ResetColumns list={cols} />
              </TableWrap>
            </Card>
          ))
        )}
      </Stack>
    </div>
  );
}

function canKeepImported(g: DupGroup): boolean {
  return g.products.some((p) => p.imported) && g.products.some((p) => !p.imported);
}
