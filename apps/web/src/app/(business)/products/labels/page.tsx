'use client';

import { Printer, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatMoney } from '@jetnine/shared';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  Field,
  Input,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';
import { code128Svg } from '@/lib/code128';

interface LookupRow {
  variantId: string;
  productId: string;
  productName: string;
  sku: string | null;
  barcode: string | null;
  variantName: string | null;
  priceCents: number;
}

interface PickedLabel extends LookupRow {
  copies: number;
}

/**
 * Two layouts: a 30-up letter sheet (Avery 5160-compatible, 2.625×1")
 * and a single-column thermal label roll (2.25×1.25"). The grid is
 * plain CSS so it prints identically from any register machine.
 */
const SHEETS = {
  avery30: { label: 'Letter sheet, 30-up (Avery 5160)', cols: 3, w: '2.625in', h: '1in' },
  roll: { label: 'Label roll, 2.25 × 1.25 in', cols: 1, w: '2.25in', h: '1.25in' },
} as const;
type SheetKey = keyof typeof SHEETS;

export default function LabelsPage() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<LookupRow[] | null>(null);
  const [picked, setPicked] = useState<PickedLabel[]>([]);
  const [sheet, setSheet] = useState<SheetKey>('avery30');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      setHits(await api<LookupRow[]>(`/v1/pos/lookup?q=${encodeURIComponent(q)}&limit=200`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  function add(row: LookupRow) {
    setPicked((cur) => {
      const existing = cur.find((p) => p.variantId === row.variantId);
      if (existing) {
        return cur.map((p) => (p.variantId === row.variantId ? { ...p, copies: p.copies + 1 } : p));
      }
      return [...cur, { ...row, copies: 1 }];
    });
  }

  function setCopies(variantId: string, copies: number) {
    setPicked((cur) =>
      cur.map((p) => (p.variantId === variantId ? { ...p, copies: Math.max(1, copies) } : p)),
    );
  }

  const printable = picked.flatMap((p) => {
    const code = p.barcode ?? p.sku;
    if (!code) return [];
    const svg = code128Svg(code, { height: 44 });
    if (!svg) return [];
    return Array.from({ length: p.copies }, (_, i) => ({
      ...p,
      code,
      svg,
      key: `${p.variantId}-${i}`,
    }));
  });
  const skipped = picked.filter((p) => {
    const code = p.barcode ?? p.sku;
    return !code || !code128Svg(code);
  });
  const layout = SHEETS[sheet];

  // The Add button queues into component state, so the columns live here.
  const HIT_COLUMNS: ColumnDef<LookupRow>[] = [
    {
      id: 'product',
      label: 'Product',
      sortValue: (h) => h.productName,
      render: (h) => (
        <>
          {h.productName}
          {h.variantName && <span className="muted"> — {h.variantName}</span>}
        </>
      ),
    },
    {
      id: 'sku',
      label: 'SKU',
      sortValue: (h) => h.barcode ?? h.sku,
      render: (h) => <code>{h.barcode ?? h.sku ?? '—'}</code>,
    },
    {
      id: 'price',
      label: 'Price',
      num: true,
      sortValue: (h) => h.priceCents,
      render: (h) => formatMoney(h.priceCents),
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (h) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => add(h)}
          data-testid={`add-label-${h.sku}`}
        >
          Add
        </Button>
      ),
    },
  ];
  const hitCols = useListColumns('products-labels-results', HIT_COLUMNS, hits);

  return (
    <div>
      <PageHeader
        className="no-print"
        eyebrow={<BackLink href="/products">Products</BackLink>}
        title="Barcode labels"
        sub="Pick items, set copy counts, and print a label sheet. Labels carry the variant barcode when set, otherwise the SKU."
        actions={
          <Button
            variant="primary"
            onClick={() => window.print()}
            disabled={printable.length === 0}
            data-testid="print-labels"
          >
            <Printer size={14} aria-hidden /> Print{' '}
            {printable.length > 0 && `(${printable.length})`}
          </Button>
        }
      />

      <Stack className="no-print">
        {error && <Alert tone="error">{error}</Alert>}

        <Card title="Find items">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Toolbar>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, SKU, or barcode"
                aria-label="Search by name, SKU, or barcode"
                data-testid="label-search"
              />
              <Button type="submit" variant="secondary" size="sm" disabled={searching}>
                {searching ? 'Searching…' : 'Search'}
              </Button>
            </Toolbar>
          </form>
          {hits && hits.length === 0 && (
            <EmptyState title="No matches">Try a different name, SKU, or barcode.</EmptyState>
          )}
          {hits && hits.length > 0 && (
            <Stack gap="sm">
              <TableWrap>
                <table className="table">
                  <thead>
                    <ColumnHeadRow list={hitCols} testIdPrefix="products-labels-results" />
                  </thead>
                  <tbody>
                    {hitCols.sorted.map((h) => (
                      <tr key={h.variantId}>
                        <ColumnCells list={hitCols} row={h} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={hitCols} />
              </TableWrap>
              {hits.length >= 200 && (
                <p className="muted">Showing first 200 matches — refine your search.</p>
              )}
            </Stack>
          )}
        </Card>

        <Card title="Print queue">
          <Toolbar>
            <Field label="Label layout">
              <Select value={sheet} onChange={(e) => setSheet(e.target.value as SheetKey)}>
                {Object.entries(SHEETS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>
          </Toolbar>
          <Stack gap="sm">
            {picked.length === 0 ? (
              <EmptyState title="Nothing queued">Search above and add items.</EmptyState>
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Code</th>
                      <th className="num">Copies</th>
                      <th className="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {picked.map((p) => (
                      <tr key={p.variantId}>
                        <td>
                          {p.productName}
                          {p.variantName && <span className="muted"> — {p.variantName}</span>}
                        </td>
                        <td>
                          <code>{p.barcode ?? p.sku ?? 'no code — skipped'}</code>
                        </td>
                        <td className="num">
                          <Input
                            type="number"
                            min={1}
                            value={p.copies}
                            aria-label={`Copies of ${p.productName}`}
                            onChange={(e) => setCopies(p.variantId, Number(e.target.value))}
                            className="w-20"
                            data-testid={`copies-${p.sku}`}
                          />
                        </td>
                        <td className="actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setPicked((cur) => cur.filter((x) => x.variantId !== p.variantId))
                            }
                            aria-label="Remove"
                          >
                            <Trash2 size={14} aria-hidden />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            {skipped.length > 0 && (
              <Alert tone="warning">
                {skipped.length} item(s) have no printable code (no barcode or SKU, or characters a
                Code 128 barcode can&apos;t carry) and will be skipped.
              </Alert>
            )}
          </Stack>
        </Card>
      </Stack>

      {/* Print-only label grid. Same visibility trick as the receipt:
          hidden on screen, and on print everything else hides. */}
      <div className="label-sheet" data-testid="label-sheet">
        <style>{labelCss(layout.cols, layout.w, layout.h)}</style>
        {printable.map((l) => (
          <div className="label" key={l.key}>
            <div className="label-name">
              {l.productName}
              {l.variantName ? ` — ${l.variantName}` : ''}
            </div>
            <div className="label-barcode" dangerouslySetInnerHTML={{ __html: l.svg! }} />
            <div className="label-meta">
              <span className="label-code">{l.code}</span>
              <span className="label-price">{formatMoney(l.priceCents)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function labelCss(cols: number, w: string, h: string): string {
  return `
.label-sheet { display: none; }
@media print {
  body * { visibility: hidden !important; }
  .no-print { display: none !important; }
  .label-sheet { display: grid !important; visibility: visible !important;
    position: absolute; inset: 0; grid-template-columns: repeat(${cols}, ${w});
    align-content: start; justify-content: center; gap: 0; }
  .label-sheet * { visibility: visible !important; }
  .label { width: ${w}; height: ${h}; overflow: hidden; padding: 2mm 3mm;
    box-sizing: border-box; display: flex; flex-direction: column;
    justify-content: space-between; page-break-inside: avoid; color: #000; }
  .label-name { font: 600 8pt/1.15 system-ui, sans-serif; max-height: 2.3em; overflow: hidden; }
  .label-barcode { flex: 1; min-height: 0; margin: 1mm 0; }
  .label-barcode svg { width: 100%; height: 100%; }
  .label-meta { display: flex; justify-content: space-between; align-items: baseline;
    font: 7pt ui-monospace, monospace; }
  .label-price { font-weight: 700; font-size: 9pt; }
  @page { margin: 4mm; }
}
`;
}
