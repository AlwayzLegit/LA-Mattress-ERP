'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  EmptyState,
  LoadingRows,
  PageHeader,
  Stack,
  StatGrid,
  StatTile,
  TableWrap,
} from '@/components/ui';

interface Proposal {
  productId: string;
  variantId: string;
  sku: string | null;
  name: string;
  score: number;
}
interface CleanupProduct {
  id: string;
  sku: string | null;
  name: string;
  isActive: boolean;
  source: string | null;
  reasons: string[];
  onHand: number;
  reserved: number;
  saleLines: number;
  orderLines: number;
  otherRefs: number;
  proposed: Proposal | null;
  alternates: Proposal[];
  action: 'relink' | 'deactivate' | 'delete';
}
interface CleanupLine {
  doc: 'sale' | 'order';
  lineId: string;
  docId: string;
  number: string;
  status: string;
  date: string;
  imported: boolean;
  customer: string | null;
  quantity: number;
  unitPriceCents: number;
  sku: string | null;
  name: string;
  proposed: Proposal | null;
  alternates: Proposal[];
  stockAdjustSuggested: boolean;
  qtyReserved: number;
  serialTracked: boolean;
}
interface ShopifyPriced {
  productId: string;
  variantId: string;
  sku: string | null;
  name: string;
  priceCents: number;
}
interface Report {
  lastInventoryImportAt: string | null;
  products: CleanupProduct[];
  lines: CleanupLine[];
  shopifyPriced: ShopifyPriced[];
  counts: {
    products: number;
    withProposal: number;
    saleLines: number;
    orderLines: number;
    linesWithProposal: number;
    linesTruncated: boolean;
    shopifyPriced: number;
    stockOnListings: number;
  };
}
interface LineChange {
  doc: 'sale' | 'order';
  lineId: string;
  toVariantId?: string;
  toSku?: string;
  adjustStock?: boolean;
}
interface ProductChange {
  productId: string;
  action: 'deactivate' | 'delete';
}
interface ApplyResult {
  dryRun: boolean;
  lines: {
    doc: string;
    lineId: string;
    ok: boolean;
    message: string;
    from?: { sku: string | null };
    to?: { sku: string | null; description: string };
    stockMoved?: number;
    reservationMoved?: number;
  }[];
  products: { productId: string; action: string; ok: boolean; message: string }[];
  prices: {
    variantId: string;
    sku: string | null;
    name: string;
    fromCents: number;
    ok: boolean;
    message: string;
  }[];
  summary: {
    linesRelinked: number;
    linesFailed: number;
    productsRetired: number;
    productsFailed: number;
    pricesReset: number;
    stockCleared: number;
  };
}
interface Changes {
  lines: LineChange[];
  products: ProductChange[];
  resetPrices?: boolean;
}

/** Per-line choices the owner makes on the page: which listing, and whether to move stock. */
interface LineChoice {
  on: boolean;
  target: string; // variant id, or 'sku:<text>' for a typed override
  adjustStock: boolean;
}

const YES = new Set(['y', 'yes', 'true', 'x', '1', 'ok', 'confirm', 'confirmed']);

/** Small RFC-4180 reader: quoted fields, doubled quotes, CR/LF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** Turn an uploaded, confirmed sheet back into apply changes. */
function changesFromSheet(text: string): {
  lines: LineChange[];
  products: ProductChange[];
  skipped: number;
} {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const get = (r: string[], name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
  const lines: LineChange[] = [];
  const products: ProductChange[] = [];
  let skipped = 0;
  if (col('line_id') >= 0) {
    for (const r of rows.slice(1)) {
      if (!YES.has(get(r, 'confirm').toLowerCase())) {
        skipped += 1;
        continue;
      }
      const toSku = get(r, 'override_sku') || get(r, 'proposed_sku');
      const doc = get(r, 'doc') === 'order' ? 'order' : 'sale';
      if (!toSku) {
        skipped += 1;
        continue;
      }
      lines.push({
        doc,
        lineId: get(r, 'line_id'),
        toSku,
        adjustStock: YES.has(get(r, 'adjust_stock').toLowerCase()),
      });
    }
  } else if (col('product_id') >= 0) {
    for (const r of rows.slice(1)) {
      if (!YES.has(get(r, 'confirm').toLowerCase())) {
        skipped += 1;
        continue;
      }
      const action = get(r, 'action').toLowerCase();
      if (action !== 'deactivate' && action !== 'delete') {
        // 'relink' rows retire as deactivate once their lines have moved; 'keep' rows are skipped.
        if (action === 'relink')
          products.push({ productId: get(r, 'product_id'), action: 'deactivate' });
        else skipped += 1;
        continue;
      }
      products.push({ productId: get(r, 'product_id'), action });
    }
  } else {
    throw new Error('Not a cleanup sheet: expected a line_id or product_id column');
  }
  return { lines, products, skipped };
}

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/**
 * Shopify listings cleanup (owner ask 2026-09-06). The Shopify sync left
 * mixed-case listings next to the STORIS catalog and some sales were
 * rung on them. This page lists those listings and every sale / order
 * line on them with the STORIS listing it should have been, lets the
 * owner confirm here or in a downloaded sheet, previews the changes
 * (dry run), then applies them: lines move to the right listing, the
 * listings retire.
 */
export default function ShopifyCleanupPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, LineChoice>>({});
  const [productOn, setProductOn] = useState<Record<string, 'deactivate' | 'delete' | ''>>({});
  const [preview, setPreview] = useState<{ changes: Changes; result: ApplyResult } | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<Report>('/v1/products/cleanup/shopify');
      setReport(r);
      const next: Record<string, LineChoice> = {};
      for (const l of r.lines) {
        next[l.lineId] = {
          on: Boolean(l.proposed) && !l.serialTracked,
          target: l.proposed?.variantId ?? '',
          adjustStock: l.stockAdjustSuggested,
        };
      }
      setChoices(next);
      setProductOn({});
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const selectedLineChanges = useMemo<LineChange[]>(() => {
    if (!report) return [];
    const out: LineChange[] = [];
    for (const l of report.lines) {
      const c = choices[l.lineId];
      if (!c?.on || !c.target) continue;
      const change: LineChange = { doc: l.doc, lineId: l.lineId, adjustStock: c.adjustStock };
      if (c.target.startsWith('sku:')) change.toSku = c.target.slice(4).trim();
      else change.toVariantId = c.target;
      if (!change.toSku && !change.toVariantId) continue;
      out.push(change);
    }
    return out;
  }, [report, choices]);
  const selectedProductChanges = useMemo<ProductChange[]>(
    () =>
      Object.entries(productOn)
        .filter(
          (e): e is [string, 'deactivate' | 'delete'] => e[1] === 'deactivate' || e[1] === 'delete',
        )
        .map(([productId, action]) => ({ productId, action })),
    [productOn],
  );

  async function download(sheet: 'lines' | 'products') {
    setBusy(`dl-${sheet}`);
    try {
      await downloadFile(
        `/v1/products/cleanup/shopify.csv?sheet=${sheet}`,
        `shopify-cleanup-${sheet}.csv`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function dryRun(changes: Changes) {
    if (changes.lines.length === 0 && changes.products.length === 0 && !changes.resetPrices) {
      toast.error('Nothing selected');
      return;
    }
    setBusy('preview');
    try {
      const result = await api<ApplyResult>('/v1/products/cleanup/shopify/apply', {
        method: 'POST',
        body: JSON.stringify({ dryRun: true, ...changes }),
      });
      setPreview({ changes, result });
      setApplied(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function applyPreview() {
    if (!preview) return;
    const { lines, products, resetPrices } = preview.changes;
    const n = lines.length + products.length + (resetPrices ? preview.result.prices.length : 0);
    if (!confirm(`Apply ${n} change${n === 1 ? '' : 's'}? Every change is audit-logged.`)) return;
    setBusy('apply');
    try {
      const result = await api<ApplyResult>('/v1/products/cleanup/shopify/apply', {
        method: 'POST',
        body: JSON.stringify({ dryRun: false, lines, products, resetPrices: Boolean(resetPrices) }),
      });
      setApplied(result);
      setPreview(null);
      toast.success(
        `${result.summary.linesRelinked} line${result.summary.linesRelinked === 1 ? '' : 's'} relinked · ${result.summary.productsRetired} listing${result.summary.productsRetired === 1 ? '' : 's'} retired · ${result.summary.pricesReset} price${result.summary.pricesReset === 1 ? '' : 's'} reset` +
          (result.summary.linesFailed + result.summary.productsFailed
            ? ` · ${result.summary.linesFailed + result.summary.productsFailed} failed`
            : ''),
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function uploadSheet(file: File) {
    try {
      const text = await file.text();
      const { lines, products, skipped } = changesFromSheet(text);
      if (lines.length === 0 && products.length === 0) {
        toast.error(`No confirmed rows in ${file.name} (put Y in the confirm column)`);
        return;
      }
      toast.message(
        `${file.name}: ${lines.length} line${lines.length === 1 ? '' : 's'}, ${products.length} listing${products.length === 1 ? '' : 's'} confirmed` +
          (skipped ? `, ${skipped} not confirmed` : ''),
      );
      await dryRun({ lines, products });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const setChoice = (lineId: string, patch: Partial<LineChoice>) =>
    setChoices((prev) => ({ ...prev, [lineId]: { ...prev[lineId]!, ...patch } }));

  const productsById = useMemo(
    () => new Map((report?.products ?? []).map((p) => [p.id, p])),
    [report],
  );

  return (
    <div data-testid="shopify-cleanup">
      <PageHeader
        eyebrow={<BackLink href="/products">Back to products</BackLink>}
        title="Shopify listings cleanup"
        sub={
          report
            ? `${report.counts.products} listings · ${report.counts.saleLines} sale lines · ${report.counts.orderLines} order lines`
            : undefined
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy != null}
              onClick={() => void download('lines')}
            >
              <Download size={13} aria-hidden />
              {busy === 'dl-lines' ? 'Preparing…' : 'Sales sheet'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy != null}
              onClick={() => void download('products')}
            >
              <Download size={13} aria-hidden />
              {busy === 'dl-products' ? 'Preparing…' : 'Listings sheet'}
            </Button>
            <label className="btn btn-primary btn-sm cursor-pointer">
              <Upload size={13} aria-hidden />
              Upload confirmed sheet
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                disabled={busy != null}
                data-testid="cleanup-upload"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadSheet(f);
                  e.target.value = '';
                }}
              />
            </label>
          </>
        }
      />
      <Stack>
        <Alert tone="info">
          Listings that came from the Shopify sync — a lowercase letter in the name, or an import
          history that is only a connector — with every sale and order line still on them. Each line
          shows the STORIS listing it should have been (best guess and alternates; pick or type a
          SKU). Confirm here, or download a sheet, put <strong>Y</strong> in <code>confirm</code>{' '}
          (and a SKU in <code>override_sku</code> to disagree), and upload it back. Preview first:
          nothing is written until you apply, and every change is audit-logged. Retire a listing
          only after its lines have moved: deactivate keeps history, delete is refused while
          anything still points at it. Either way the stock on the listing is cleared — stock on a
          Shopify listing is never kept — and the sold units come off the STORIS SKU only.
          {report?.lastInventoryImportAt && (
            <>
              {' '}
              &ldquo;Move stock&rdquo; is pre-checked for register sales after the last inventory
              import ({new Date(report.lastInventoryImportAt).toLocaleDateString()}); earlier ones
              are already reflected in the counts.
            </>
          )}
        </Alert>
        {error && <Alert tone="error">{error}</Alert>}

        {report && (
          <StatGrid cols={4}>
            <StatTile label="Shopify listings" value={report.counts.products} />
            <StatTile
              label="With a proposed match"
              value={report.counts.withProposal}
              sub={`of ${report.counts.products}`}
            />
            <StatTile label="Sale lines" value={report.counts.saleLines} />
            <StatTile label="Order lines" value={report.counts.orderLines} />
          </StatGrid>
        )}

        {report && (
          <Card
            title="Prices the Shopify sync wrote on STORIS listings"
            description="Shared SKUs the sync re-priced. STORIS carries no retail price (D12); these go back to $0 and get priced at the register or on Set prices."
            flush
            actions={
              <Button
                variant="primary"
                size="sm"
                disabled={busy != null || report.shopifyPriced.length === 0}
                onClick={() => void dryRun({ lines: [], products: [], resetPrices: true })}
                data-testid="cleanup-preview-prices"
              >
                {busy === 'preview'
                  ? 'Checking…'
                  : `Reset ${report.shopifyPriced.length} price${report.shopifyPriced.length === 1 ? '' : 's'} to $0`}
              </Button>
            }
          >
            {report.shopifyPriced.length === 0 ? (
              <EmptyState title="No Shopify prices left on STORIS listings" />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Name</th>
                      <th className="num">Price from Shopify</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.shopifyPriced.map((p) => (
                      <tr key={p.variantId}>
                        <td>
                          <Link href={`/products/${p.productId}`}>{p.sku ?? '—'}</Link>
                        </td>
                        <td>{p.name}</td>
                        <td className="num">
                          <Money cents={p.priceCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        )}

        {preview && (
          <Card
            title={`Preview — ${preview.changes.lines.length} line${preview.changes.lines.length === 1 ? '' : 's'}, ${preview.changes.products.length} listing${preview.changes.products.length === 1 ? '' : 's'}`}
            actions={
              <>
                <Button variant="secondary" size="sm" onClick={() => setPreview(null)}>
                  Discard
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={
                    busy != null ||
                    preview.result.summary.linesRelinked +
                      preview.result.summary.productsRetired +
                      preview.result.summary.pricesReset ===
                      0
                  }
                  onClick={() => void applyPreview()}
                  data-testid="cleanup-apply"
                >
                  {busy === 'apply' ? 'Applying…' : 'Apply'}
                </Button>
              </>
            }
          >
            <ResultTable result={preview.result} report={report} productsById={productsById} />
          </Card>
        )}
        {applied && (
          <Card title="Applied">
            <ResultTable result={applied} report={report} productsById={productsById} />
          </Card>
        )}

        {report == null ? (
          <Card>
            <LoadingRows />
          </Card>
        ) : (
          <>
            <Card
              title="Sales and orders on Shopify listings"
              flush
              actions={
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy != null || selectedLineChanges.length === 0}
                  onClick={() => void dryRun({ lines: selectedLineChanges, products: [] })}
                  data-testid="cleanup-preview-lines"
                >
                  {busy === 'preview'
                    ? 'Checking…'
                    : `Preview ${selectedLineChanges.length} selected`}
                </Button>
              }
            >
              {report.lines.length === 0 ? (
                <EmptyState title="No lines on Shopify listings">
                  Every sale and order line already points at a STORIS listing.
                </EmptyState>
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th />
                        <th>Document</th>
                        <th>Date</th>
                        <th>Customer</th>
                        <th>Rung as</th>
                        <th className="num">Qty</th>
                        <th className="num">Unit price</th>
                        <th>Change to</th>
                        <th>Move stock</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.lines.map((l) => {
                        const c = choices[l.lineId] ?? {
                          on: false,
                          target: '',
                          adjustStock: false,
                        };
                        const isSku = c.target.startsWith('sku:');
                        return (
                          <tr key={l.lineId} data-testid="cleanup-line">
                            <td>
                              <input
                                type="checkbox"
                                checked={c.on}
                                disabled={l.serialTracked}
                                title={
                                  l.serialTracked
                                    ? 'Serial units picked — release first'
                                    : undefined
                                }
                                onChange={(e) => setChoice(l.lineId, { on: e.target.checked })}
                              />
                            </td>
                            <td>
                              <Link
                                href={l.doc === 'sale' ? `/sales/${l.docId}` : `/orders/${l.docId}`}
                              >
                                {l.number}
                              </Link>
                              <div className="muted small">
                                {l.doc} · {l.status}
                                {l.imported ? ' · imported' : ''}
                                {l.qtyReserved > 0 ? ` · ${l.qtyReserved} reserved` : ''}
                              </div>
                            </td>
                            <td>{new Date(l.date).toLocaleDateString()}</td>
                            <td>{l.customer ?? <span className="muted">—</span>}</td>
                            <td>
                              <div>{l.name}</div>
                              <div className="muted small">{l.sku}</div>
                            </td>
                            <td className="num">{l.quantity}</td>
                            <td className="num">
                              <Money cents={l.unitPriceCents} />
                            </td>
                            <td>
                              <select
                                className="input"
                                aria-label="Replacement product for this line"
                                value={isSku ? 'sku:' : c.target}
                                onChange={(e) =>
                                  setChoice(l.lineId, {
                                    target: e.target.value === 'sku:' ? 'sku:' : e.target.value,
                                    on: true,
                                  })
                                }
                              >
                                <option value="">— choose —</option>
                                {l.alternates.map((a) => (
                                  <option key={a.variantId} value={a.variantId}>
                                    {a.sku ?? a.name} · {a.name} ({pct(a.score)})
                                  </option>
                                ))}
                                <option value="sku:">Type a SKU…</option>
                              </select>
                              {isSku && (
                                <input
                                  className="input mt-1"
                                  aria-label="STORIS SKU of the replacement"
                                  placeholder="STORIS SKU"
                                  value={c.target.slice(4)}
                                  onChange={(e) =>
                                    setChoice(l.lineId, { target: `sku:${e.target.value}` })
                                  }
                                />
                              )}
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                checked={c.adjustStock}
                                disabled={l.imported}
                                title={
                                  l.imported
                                    ? 'Imported history never moves stock'
                                    : 'Hand the sold units back to the Shopify SKU and take them off the STORIS SKU'
                                }
                                onChange={(e) =>
                                  setChoice(l.lineId, { adjustStock: e.target.checked })
                                }
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              )}
              {report.counts.linesTruncated && (
                <div className="p-3">
                  <Alert tone="warning">
                    Only the first {report.lines.length} lines are shown here — the sales sheet
                    carries all of them.
                  </Alert>
                </div>
              )}
            </Card>

            <Card
              title="Shopify listings"
              flush
              actions={
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy != null || selectedProductChanges.length === 0}
                  onClick={() => void dryRun({ lines: [], products: selectedProductChanges })}
                  data-testid="cleanup-preview-products"
                >
                  {busy === 'preview'
                    ? 'Checking…'
                    : `Preview ${selectedProductChanges.length} selected`}
                </Button>
              }
            >
              {report.products.length === 0 ? (
                <EmptyState title="No Shopify listings left">
                  No product has a lowercase letter in its name or a connector-only import history.
                </EmptyState>
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Name</th>
                        <th>Source</th>
                        <th className="num">On hand</th>
                        <th className="num">Reserved</th>
                        <th className="num">Sales</th>
                        <th className="num">Orders</th>
                        <th className="num">Other</th>
                        <th>Proposed STORIS listing</th>
                        <th>Retire</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.products.map((p) => {
                        const referenced = p.saleLines + p.orderLines + p.otherRefs > 0;
                        return (
                          <tr key={p.id} data-testid="cleanup-product">
                            <td>
                              <Link href={`/products/${p.id}`}>{p.sku ?? '—'}</Link>
                              {!p.isActive && <div className="muted small">inactive</div>}
                            </td>
                            <td>{p.name}</td>
                            <td>{p.source ?? 'app'}</td>
                            <td className="num">{p.onHand}</td>
                            <td className="num">{p.reserved}</td>
                            <td className="num">{p.saleLines}</td>
                            <td className="num">{p.orderLines}</td>
                            <td className="num">{p.otherRefs}</td>
                            <td>
                              {p.proposed ? (
                                <>
                                  <div>{p.proposed.name}</div>
                                  <div className="muted small">
                                    {p.proposed.sku} · {pct(p.proposed.score)}
                                  </div>
                                </>
                              ) : (
                                <span className="muted">no confident match</span>
                              )}
                            </td>
                            <td>
                              <select
                                className="input"
                                aria-label="What to do with this product"
                                value={productOn[p.id] ?? ''}
                                onChange={(e) =>
                                  setProductOn((prev) => ({
                                    ...prev,
                                    [p.id]: e.target.value as 'deactivate' | 'delete' | '',
                                  }))
                                }
                              >
                                <option value="">— keep for now —</option>
                                {p.isActive && <option value="deactivate">Deactivate</option>}
                                <option value="delete" disabled={referenced}>
                                  Delete{referenced ? ' (still referenced)' : ''}
                                </option>
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </>
        )}
      </Stack>
    </div>
  );
}

function ResultTable({
  result,
  report,
  productsById,
}: {
  result: ApplyResult;
  report: Report | null;
  productsById: Map<string, CleanupProduct>;
}) {
  return (
    <TableWrap>
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Outcome</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {result.lines.map((r) => {
            const l = report?.lines.find((x) => x.lineId === r.lineId);
            return (
              <tr key={`l-${r.lineId}`}>
                <td>
                  {l?.number ?? r.lineId} <span className="muted small">{r.doc} line</span>
                </td>
                <td className={r.ok ? undefined : 'text-danger'}>{r.ok ? r.message : 'skipped'}</td>
                <td>
                  {r.ok ? (
                    <>
                      {r.from?.sku ?? '—'} → <strong>{r.to?.sku ?? '—'}</strong> (
                      {r.to?.description})
                      {r.stockMoved
                        ? ` · moves ${r.stockMoved} unit${r.stockMoved === 1 ? '' : 's'} of stock`
                        : ''}
                      {r.reservationMoved ? ` · carries ${r.reservationMoved} reserved` : ''}
                    </>
                  ) : (
                    r.message
                  )}
                </td>
              </tr>
            );
          })}
          {result.prices.map((r) => (
            <tr key={`$-${r.variantId}`}>
              <td>
                {r.sku ?? r.variantId} <span className="muted small">price</span>
              </td>
              <td className={r.ok ? undefined : 'text-danger'}>{r.ok ? r.message : 'skipped'}</td>
              <td>
                {r.name} · <Money cents={r.fromCents} /> → <Money cents={0} />
              </td>
            </tr>
          ))}
          {result.products.map((r) => {
            const p = productsById.get(r.productId);
            return (
              <tr key={`p-${r.productId}`}>
                <td>
                  {p?.sku ?? r.productId} <span className="muted small">listing</span>
                </td>
                <td className={r.ok ? undefined : 'text-danger'}>{r.ok ? r.action : 'skipped'}</td>
                <td>{r.message}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}
