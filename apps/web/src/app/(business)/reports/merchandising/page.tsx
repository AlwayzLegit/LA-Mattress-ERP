'use client';

import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Field,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { Money } from '@/components/money';

interface MerchRow {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  vendorName: string | null;
  categoryName: string | null;
  brandName: string | null;
  onHand: number;
  reserved: number;
  floorSample: number;
  netAvailable: number;
  asIsQty: number;
  onOrder: number;
  soldMtd: number;
  soldYtd: number;
  costCents: number | null;
  priceCents: number;
  markupPct: number | null;
}

interface MerchReport {
  generatedAt: string;
  truncated: boolean;
  rows: MerchRow[];
}

interface NamedRow {
  id: string;
  name: string;
}

const MERCH_COLUMNS: ColumnDef<MerchRow>[] = [
  {
    id: 'product',
    label: 'Product',
    sortValue: (r) => r.productName,
    render: (r) => (
      <>
        {r.productName}
        {r.variantName && <span className="muted"> · {r.variantName}</span>}
        {r.sku && <div className="muted">{r.sku}</div>}
      </>
    ),
  },
  {
    id: 'vendor',
    label: 'Vendor',
    sortValue: (r) => r.vendorName,
    render: (r) => r.vendorName ?? '—',
  },
  {
    id: 'onHand',
    label: 'On hand',
    num: true,
    sortValue: (r) => r.onHand,
    render: (r) => r.onHand,
  },
  {
    id: 'reserved',
    label: 'Rsvd',
    num: true,
    sortValue: (r) => r.reserved,
    render: (r) => r.reserved,
  },
  {
    id: 'floor',
    label: 'Floor',
    num: true,
    sortValue: (r) => r.floorSample,
    render: (r) => r.floorSample,
  },
  {
    id: 'available',
    label: 'Avail',
    num: true,
    sortValue: (r) => r.netAvailable,
    render: (r) => r.netAvailable,
  },
  { id: 'asIs', label: 'As-Is', num: true, sortValue: (r) => r.asIsQty, render: (r) => r.asIsQty },
  {
    id: 'onOrder',
    label: 'On order',
    num: true,
    sortValue: (r) => r.onOrder,
    render: (r) => r.onOrder,
  },
  { id: 'mtd', label: 'MTD', num: true, sortValue: (r) => r.soldMtd, render: (r) => r.soldMtd },
  { id: 'ytd', label: 'YTD', num: true, sortValue: (r) => r.soldYtd, render: (r) => r.soldYtd },
  {
    id: 'cost',
    label: 'Cost',
    num: true,
    sortValue: (r) => r.costCents,
    render: (r) => (r.costCents != null ? <Money cents={r.costCents} /> : '—'),
  },
  {
    id: 'price',
    label: 'Price',
    num: true,
    sortValue: (r) => r.priceCents,
    render: (r) => <Money cents={r.priceCents} />,
  },
  {
    id: 'markup',
    label: 'Markup',
    num: true,
    sortValue: (r) => r.markupPct,
    render: (r) => (r.markupPct != null ? `${r.markupPct}%` : '—'),
  },
];

/**
 * The buyer's report: stock position, inbound supply, as-is holdings,
 * and sales velocity per variant, with replacement cost and markup.
 */
export default function MerchandisingPage() {
  const [report, setReport] = useState<MerchReport | null>(null);
  const [vendors, setVendors] = useState<NamedRow[]>([]);
  const [categories, setCategories] = useState<NamedRow[]>([]);
  const [brands, setBrands] = useState<NamedRow[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [includeAll, setIncludeAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const cols = useListColumns('reports-merchandising', MERCH_COLUMNS, report?.rows ?? null);

  function query(): string {
    const p = new URLSearchParams();
    if (vendorId) p.set('vendorId', vendorId);
    if (categoryId) p.set('categoryId', categoryId);
    if (brandId) p.set('brandId', brandId);
    if (includeAll) p.set('includeNoActivity', 'true');
    return p.toString();
  }

  async function load() {
    setRunning(true);
    try {
      setReport(await api<MerchReport>(`/v1/reports/merchandising?${query()}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    void load();
    void (async () => {
      try {
        type Lookup = NamedRow[] | { data?: NamedRow[]; flat?: NamedRow[] };
        const [v, c, b] = await Promise.all([
          api<Lookup>('/v1/vendors'),
          api<Lookup>('/v1/categories'),
          api<Lookup>('/v1/brands'),
        ]);
        // Vendors and brands come back as arrays; categories as `{ flat, tree }`.
        const arr = (x: Lookup) => (Array.isArray(x) ? x : (x.data ?? x.flat ?? []));
        setVendors(arr(v));
        setCategories(arr(c));
        setBrands(arr(b));
      } catch {
        // Filters degrade to "all" when a lookup fails; the report still loads.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/reports">Reports</BackLink>}
        title="Merchandising activity"
        sub="The buyer's report: stock position, inbound supply, as-is holdings and sales velocity per variant."
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        <Card>
          <Toolbar
            className="items-end"
            end={
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await downloadFile(
                      `/v1/reports/merchandising?${query()}&format=csv`,
                      'merchandising.csv',
                    );
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Download size={13} aria-hidden />
                {busy ? 'Preparing…' : 'CSV'}
              </Button>
            }
          >
            <Field label="Vendor">
              <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">All vendors</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category">
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Brand">
              <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                <option value="">All brands</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 self-center pb-2">
              <input
                type="checkbox"
                checked={includeAll}
                onChange={(e) => setIncludeAll(e.target.checked)}
              />
              Include no-activity products
            </label>
            <Button size="sm" variant="primary" disabled={running} onClick={() => void load()}>
              <RefreshCw size={13} aria-hidden />
              Run
            </Button>
          </Toolbar>
          {!report ? (
            <LoadingRows />
          ) : (
            <Stack>
              {report.truncated && (
                <Alert tone="warning">
                  Showing the top 2000 rows by YTD units — narrow the filters for full coverage.
                </Alert>
              )}
              <TableWrap>
                <table className="table" data-testid="merch-table">
                  <thead>
                    <ColumnHeadRow list={cols} testIdPrefix="reports-merchandising" />
                  </thead>
                  <tbody>
                    {report.rows.length === 0 && (
                      <TableEmpty colSpan={cols.ordered.length}>
                        No rows match the filters.
                      </TableEmpty>
                    )}
                    {cols.sorted.map((r) => (
                      <tr key={r.variantId}>
                        <ColumnCells list={cols} row={r} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={cols} />
              </TableWrap>
            </Stack>
          )}
        </Card>
      </Stack>
    </div>
  );
}
