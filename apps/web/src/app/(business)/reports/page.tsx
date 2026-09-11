'use client';

import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  SectionHeading,
  Select,
  Stack,
  StatGrid,
  StatTile,
  TableEmpty,
  TableWrap,
  Toolbar,
} from '@/components/ui';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import { api } from '@/lib/api';
import { formatRange } from '@/lib/date-range';
import { downloadFile } from '@/lib/download';
import { Money } from '@/components/money';

/**
 * Export button that downloads via an in-page fetch (see lib/download)
 * so failures surface as a toast instead of a silent dead click.
 */
function CsvButton({ path, filename, size }: { path: string; filename: string; size?: 'sm' }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size={size}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadFile(path, filename);
        } catch (err) {
          toast.error(`CSV download failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download size={size === 'sm' ? 13 : 14} aria-hidden />
      {busy ? 'Preparing…' : 'Download CSV'}
    </Button>
  );
}

interface SalesSummaryRow {
  key: string;
  label: string;
  documentCount: number;
  merchandiseCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}
interface SalesSummary {
  basis: 'written' | 'delivered';
  groupBy: 'day' | 'location' | 'salesperson';
  start: string;
  end: string;
  rows: SalesSummaryRow[];
  totals: {
    documentCount: number;
    merchandiseCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
    averageMerchandiseCents: number;
  };
}
interface AdjustmentsReport {
  truncated: boolean;
  byReason: { reason: string; movements: number; totalIn: number; totalOut: number }[];
  rows: {
    at: string;
    reason: string;
    delta: number;
    productName: string;
    sku: string | null;
    locationName: string | null;
    actorEmail: string | null;
    notes: string | null;
    referenceType: string | null;
  }[];
}
interface ReceiptsReport {
  rows: {
    method: string;
    locationId: string | null;
    locationName: string | null;
    count: number;
    amountCents: number;
  }[];
  totals: { count: number; amountCents: number };
}
interface GiftCardLiabilityRow {
  code: string;
  status: string;
  customerName: string | null;
  issuedAt: string;
  expiresAt: string | null;
  initialCents: number;
  remainingCents: number;
}
interface GiftCardLiability {
  cardCount: number;
  outstandingCents: number;
  rows: GiftCardLiabilityRow[];
}
interface DeliveryDateChangeRow {
  at: string;
  action: string;
  deliveryId: string | null;
  orderNumber: string | null;
  actorEmail: string | null;
  fromDate: string | null;
  toDate: string | null;
}
interface DailyTotalRow {
  day: string;
  saleCount: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}
interface AssociateTotalRow {
  associateUserId: string | null;
  associateEmail: string | null;
  saleCount: number;
  totalCents: number;
}
interface PaymentMethodRow {
  method: string;
  amountCents: number;
  count: number;
}
interface DailyReport {
  start: string;
  end: string;
  byDay: DailyTotalRow[];
  byAssociate: AssociateTotalRow[];
  byPaymentMethod: PaymentMethodRow[];
}
interface ProductRow {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  revenueCents: number;
  costCents: number | null;
  marginCents: number | null;
}
interface InventoryRow {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  onHand: number;
  reserved: number;
  available: number;
}

interface ZReport {
  date: string;
  saleCount: number;
  grossCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  refundCount: number;
  refundsCents: number;
  netCents: number;
  tenders: { method: string; amountCents: number; count: number }[];
  orderPaymentsCents: number;
  shifts: {
    id: string;
    openedAt: string;
    closedAt: string | null;
    openingFloatCents: number;
    expectedCashCents: number | null;
    countedCashCents: number | null;
    varianceCents: number | null;
  }[];
}
interface CategoryRow {
  categoryId: string | null;
  categoryName: string;
  quantity: number;
  revenueCents: number;
}
interface TaxSummary {
  rows: {
    taxClassId: string | null;
    taxClassName: string;
    lineCount: number;
    netSalesCents: number;
    taxCents: number;
  }[];
  byLocation: {
    locationId: string;
    locationName: string | null;
    documents: number;
    taxCents: number;
    totalCents: number;
  }[];
  totalTaxCents: number;
}
interface Valuation {
  rows: {
    variantId: string;
    locationId: string;
    locationName: string | null;
    productName: string;
    variantName: string | null;
    sku: string | null;
    onHand: number;
    costCents: number | null;
    costValueCents: number | null;
    retailValueCents: number;
  }[];
  totalCostValueCents: number;
  totalRetailValueCents: number;
}

export default function ReportsPage() {
  const today = new Date().toISOString().slice(0, 10);
  // Page-level window (Shopify-style picker, carried in the URL as
  // ?range= / ?start=&end=); every range-scoped report below follows it.
  const [range, setRange, rangeReady] = useUrlDateRange('last7');
  const [lowStock, setLowStock] = useState('5');
  const [daily, setDaily] = useState<DailyReport | null>(null);
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [inv, setInv] = useState<InventoryRow[] | null>(null);
  const [zDate, setZDate] = useState(today);
  const [z, setZ] = useState<ZReport | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [taxSummary, setTaxSummary] = useState<TaxSummary | null>(null);
  // Valuation + tax are cost/financial reports — 403 for roles without
  // reports.financial.view. We hide those cards instead of erroring.
  const [financialDenied, setFinancialDenied] = useState(false);
  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [giftLiability, setGiftLiability] = useState<GiftCardLiability | null>(null);
  const [receipts, setReceipts] = useState<ReceiptsReport | null>(null);
  const [adjustments, setAdjustments] = useState<AdjustmentsReport | null>(null);
  const [dateChanges, setDateChanges] = useState<DeliveryDateChangeRow[] | null>(null);
  const [summaryBasis, setSummaryBasis] = useState<'written' | 'delivered'>('written');
  const [summaryGroupBy, setSummaryGroupBy] = useState<'day' | 'location' | 'salesperson'>('day');

  async function loadSummary(
    basis: 'written' | 'delivered' = summaryBasis,
    groupBy: 'day' | 'location' | 'salesperson' = summaryGroupBy,
  ) {
    try {
      setSummary(
        await api<SalesSummary>(
          `/v1/reports/sales/summary?basis=${basis}&groupBy=${groupBy}&start=${range.start}&end=${range.end}`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadDaily() {
    try {
      setDaily(
        await api<DailyReport>(`/v1/reports/sales/daily?start=${range.start}&end=${range.end}`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function loadProducts() {
    try {
      setProducts(
        await api<ProductRow[]>(
          `/v1/reports/sales/by-product?start=${range.start}&end=${range.end}`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function loadInv() {
    try {
      setInv(
        await api<InventoryRow[]>(
          `/v1/reports/inventory/on-hand${lowStock ? `?lowStock=${encodeURIComponent(lowStock)}` : ''}`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadZ(date: string) {
    try {
      setZ(await api<ZReport>(`/v1/reports/z?date=${date}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function loadCategories() {
    try {
      setCategories(
        await api<CategoryRow[]>(
          `/v1/reports/sales/by-category?start=${range.start}&end=${range.end}`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function loadFinancial() {
    try {
      setTaxSummary(
        await api<TaxSummary>(`/v1/reports/tax/summary?start=${range.start}&end=${range.end}`),
      );
      setValuation(await api<Valuation>(`/v1/reports/inventory/valuation`));
      setGiftLiability(await api<GiftCardLiability>('/v1/reports/gift-cards/liability'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|forbidden/i.test(msg)) setFinancialDenied(true);
      else setError(msg);
    }
  }

  async function loadReceipts() {
    try {
      setReceipts(
        await api<ReceiptsReport>(`/v1/reports/receipts?start=${range.start}&end=${range.end}`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadAdjustments() {
    try {
      setAdjustments(
        await api<AdjustmentsReport>(
          `/v1/reports/inventory-adjustments?start=${range.start}&end=${range.end}`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadDateChanges() {
    try {
      const res = await api<{ rows: DeliveryDateChangeRow[] }>(
        '/v1/reports/delivery-date-changes?days=30',
      );
      setDateChanges(res.rows);
    } catch {
      setDateChanges([]);
    }
  }

  // Reports that don't follow the page window load once.
  useEffect(() => {
    void loadDateChanges();
    void loadInv();
    void loadZ(zDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Range-scoped reports: wait for the URL to be read (`rangeReady`) so we
  // don't fire once with the fallback window and again with the real one.
  useEffect(() => {
    if (!rangeReady) return;
    void loadAdjustments();
    void loadReceipts();
    void loadSummary();
    void loadDaily();
    void loadProducts();
    void loadCategories();
    void loadFinancial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeReady, range]);

  return (
    <div>
      <PageHeader
        title="Reports"
        actions={
          <>
            <LinkButton size="sm" href="/reports/merchandising">
              Merchandising activity
            </LinkButton>
            <LinkButton
              size="sm"
              href="/reports/cash-drawer-balancing"
              data-testid="reports-cash-drawer-link"
            >
              Cash drawer balancing
            </LinkButton>
            <LinkButton
              size="sm"
              href="/reports/written-sales"
              data-testid="reports-written-sales-link"
            >
              Written sales dollars
            </LinkButton>
            <LinkButton
              size="sm"
              href="/reports/transfers-by-location"
              data-testid="reports-transfers-by-location-link"
            >
              Transfers by location
            </LinkButton>
            <DateRangePicker value={range} onChange={setRange} testid="reports-range" />
          </>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        <Card title="Z-report (daily close-out)" data-testid="z-report">
          <Toolbar className="items-end">
            <Field label="Day">
              <Input
                type="date"
                value={zDate}
                onChange={(e) => {
                  setZDate(e.target.value);
                  void loadZ(e.target.value);
                }}
              />
            </Field>
            <Button size="sm" variant="secondary" onClick={() => window.print()}>
              Print
            </Button>
          </Toolbar>
          {z ? (
            <>
              <StatGrid cols={6}>
                <StatTile label="Sales" value={String(z.saleCount)} />
                <StatTile label="Gross" value={<Money cents={z.grossCents} />} />
                <StatTile label="Tax" value={<Money cents={z.taxCents} />} />
                <StatTile label="Refunds" value={<Money cents={z.refundsCents} />} tone="danger" />
                <StatTile label="Net" value={<Money cents={z.netCents} />} tone="brand" />
                <StatTile label="Order money" value={<Money cents={z.orderPaymentsCents} />} />
              </StatGrid>

              <SectionHeading as="h3" title="Tenders" />
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th className="num">Count</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {z.tenders.length === 0 && <TableEmpty colSpan={3}>No data.</TableEmpty>}
                    {z.tenders.map((t) => (
                      <tr key={t.method}>
                        <td>{t.method}</td>
                        <td className="num">{t.count}</td>
                        <td className="num">
                          <Money cents={t.amountCents} />
                        </td>
                      </tr>
                    ))}
                    {z.refundsCents > 0 && (
                      <tr style={{ color: 'var(--danger)' }}>
                        <td>refunds (all tenders)</td>
                        <td className="num">{z.refundCount}</td>
                        <td className="num">
                          <Money cents={-z.refundsCents} />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TableWrap>
              {z.refundsCents > 0 && (
                <p className="field-hint">
                  Tender rows are money taken in; refunds aren&apos;t attributed to a specific
                  tender, so the drawer count should be reconciled against the refund line above.
                </p>
              )}

              <SectionHeading as="h3" title="Cash drawers" />
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Opened</th>
                      <th>Closed</th>
                      <th className="num">Float</th>
                      <th className="num">Expected</th>
                      <th className="num">Counted</th>
                      <th className="num">Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {z.shifts.length === 0 && <TableEmpty colSpan={6}>No data.</TableEmpty>}
                    {z.shifts.map((s) => (
                      <tr key={s.id}>
                        <td>{new Date(s.openedAt).toLocaleTimeString()}</td>
                        <td>{s.closedAt ? new Date(s.closedAt).toLocaleTimeString() : 'open'}</td>
                        <td className="num">
                          <Money cents={s.openingFloatCents} />
                        </td>
                        <td className="num">
                          {s.expectedCashCents != null ? (
                            <Money cents={s.expectedCashCents} />
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="num">
                          {s.countedCashCents != null ? <Money cents={s.countedCashCents} /> : '—'}
                        </td>
                        <td
                          className="num"
                          style={{
                            color:
                              s.varianceCents != null && s.varianceCents !== 0
                                ? 'var(--danger)'
                                : undefined,
                          }}
                        >
                          {s.varianceCents != null ? <Money cents={s.varianceCents} /> : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          ) : (
            <LoadingRows />
          )}
        </Card>

        <Card title="Sales summary — written vs delivered" data-testid="sales-summary">
          <Toolbar
            className="items-end"
            end={
              <CsvButton
                path={`/v1/reports/sales/summary?basis=${summaryBasis}&groupBy=${summaryGroupBy}&start=${range.start}&end=${range.end}&format=csv`}
                filename={`sales-summary-${summaryBasis}-${range.start}-to-${range.end}.csv`}
                size="sm"
              />
            }
          >
            <Field label="Basis">
              <Select
                value={summaryBasis}
                onChange={(e) => {
                  const b = e.target.value as 'written' | 'delivered';
                  setSummaryBasis(b);
                  void loadSummary(b, summaryGroupBy);
                }}
              >
                <option value="written">Written (as sold)</option>
                <option value="delivered">Delivered (as fulfilled)</option>
              </Select>
            </Field>
            <Field label="Group by">
              <Select
                value={summaryGroupBy}
                onChange={(e) => {
                  const g = e.target.value as 'day' | 'location' | 'salesperson';
                  setSummaryGroupBy(g);
                  void loadSummary(summaryBasis, g);
                }}
              >
                <option value="day">Day</option>
                <option value="location">Location</option>
                <option value="salesperson">Salesperson</option>
              </Select>
            </Field>
            <Button size="sm" variant="secondary" onClick={() => void loadSummary()}>
              <RefreshCw size={13} aria-hidden />
              Run
            </Button>
          </Toolbar>
          {summary ? (
            <Stack>
              <StatGrid cols={4}>
                <StatTile label="Documents" value={String(summary.totals.documentCount)} />
                <StatTile
                  label="Merchandise"
                  value={<Money cents={summary.totals.merchandiseCents} />}
                />
                <StatTile
                  label="Avg / document"
                  value={<Money cents={summary.totals.averageMerchandiseCents} />}
                />
                <StatTile
                  label="Total"
                  value={<Money cents={summary.totals.totalCents} />}
                  tone="brand"
                />
              </StatGrid>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>
                        {summaryGroupBy === 'day'
                          ? 'Day'
                          : summaryGroupBy === 'location'
                            ? 'Location'
                            : 'Salesperson'}
                      </th>
                      <th className="num">Documents</th>
                      <th className="num">Merchandise</th>
                      <th className="num">Discounts</th>
                      <th className="num">Tax</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.length === 0 && <TableEmpty colSpan={6}>No data.</TableEmpty>}
                    {summary.rows.map((r) => (
                      <tr key={r.key || '(none)'}>
                        <td>{r.label}</td>
                        <td className="num">{r.documentCount}</td>
                        <td className="num">
                          <Money cents={r.merchandiseCents} />
                        </td>
                        <td className="num">
                          <Money cents={r.discountCents} />
                        </td>
                        <td className="num">
                          <Money cents={r.taxCents} />
                        </td>
                        <td className="num">
                          <Money cents={r.totalCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Stack>
          ) : (
            <LoadingRows />
          )}
        </Card>

        <Card title="Daily sales" description={formatRange(range)}>
          <Toolbar
            end={
              <CsvButton
                size="sm"
                path={`/v1/reports/sales/daily?start=${range.start}&end=${range.end}&format=csv`}
                filename={`daily-sales-${range.start}-to-${range.end}.csv`}
              />
            }
          >
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                void loadDaily();
                void loadProducts();
                void loadCategories();
                void loadFinancial();
              }}
            >
              <RefreshCw size={13} aria-hidden />
              Refresh
            </Button>
          </Toolbar>

          {daily ? (
            <>
              <SectionHeading as="h3" title="By day" />
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th className="num">Sales</th>
                      <th className="num">Subtotal</th>
                      <th className="num">Discount</th>
                      <th className="num">Tax</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daily.byDay.length === 0 && <TableEmpty colSpan={6}>No data.</TableEmpty>}
                    {daily.byDay.map((d) => (
                      <tr key={d.day}>
                        <td>{d.day}</td>
                        <td className="num">{d.saleCount}</td>
                        <td className="num">
                          <Money cents={d.subtotalCents} />
                        </td>
                        <td className="num">
                          <Money cents={d.discountCents} />
                        </td>
                        <td className="num">
                          <Money cents={d.taxCents} />
                        </td>
                        <td className="num">
                          <strong>
                            <Money cents={d.totalCents} />
                          </strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>

              <SectionHeading as="h3" title="By associate" />
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Associate</th>
                      <th className="num">Sales</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daily.byAssociate.length === 0 && (
                      <TableEmpty colSpan={3}>No data.</TableEmpty>
                    )}
                    {daily.byAssociate.map((a) => (
                      <tr key={a.associateUserId ?? 'none'}>
                        <td>{a.associateEmail ?? '(deleted)'}</td>
                        <td className="num">{a.saleCount}</td>
                        <td className="num">
                          <Money cents={a.totalCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>

              <SectionHeading as="h3" title="By payment method" />
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th className="num">Count</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daily.byPaymentMethod.length === 0 && (
                      <TableEmpty colSpan={3}>No data.</TableEmpty>
                    )}
                    {daily.byPaymentMethod.map((p) => (
                      <tr key={p.method}>
                        <td>{p.method}</td>
                        <td className="num">{p.count}</td>
                        <td className="num">
                          <Money cents={p.amountCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          ) : (
            <LoadingRows />
          )}
        </Card>

        <Card
          title="Sales by product"
          actions={
            <CsvButton
              size="sm"
              path={`/v1/reports/sales/by-product?start=${range.start}&end=${range.end}&format=csv`}
              filename={`sales-by-product-${range.start}-to-${range.end}.csv`}
            />
          }
        >
          {products ? (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Variant</th>
                    <th>SKU</th>
                    <th className="num">Qty</th>
                    <th className="num">Revenue</th>
                    {products[0]?.marginCents != null && <th className="num">Margin</th>}
                  </tr>
                </thead>
                <tbody>
                  {products.length === 0 && <TableEmpty colSpan={6}>No data.</TableEmpty>}
                  {products.map((p) => (
                    <tr key={p.variantId}>
                      <td>{p.productName}</td>
                      <td>{p.variantName ?? '—'}</td>
                      <td>
                        <code>{p.sku ?? '—'}</code>
                      </td>
                      <td className="num">{p.quantity}</td>
                      <td className="num">
                        <Money cents={p.revenueCents} />
                      </td>
                      {p.marginCents != null && (
                        <td className="num">
                          <Money cents={p.marginCents ?? 0} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          ) : (
            <LoadingRows />
          )}
        </Card>

        <Card title="Inventory on hand">
          <Toolbar
            className="items-end"
            end={
              <CsvButton
                size="sm"
                path={`/v1/reports/inventory/on-hand${lowStock ? `?lowStock=${encodeURIComponent(lowStock)}&format=csv` : '?format=csv'}`}
                filename="inventory-on-hand.csv"
              />
            }
          >
            <Field label="Show items with available ≤">
              <Input
                type="number"
                min={0}
                value={lowStock}
                onChange={(e) => setLowStock(e.target.value)}
                placeholder="(blank = all)"
              />
            </Field>
            <Button size="sm" variant="primary" onClick={loadInv}>
              <RefreshCw size={13} aria-hidden />
              Refresh
            </Button>
          </Toolbar>
          {inv ? (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU</th>
                    <th className="num">On hand</th>
                    <th className="num">Reserved</th>
                    <th className="num">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.length === 0 && <TableEmpty colSpan={5}>No data.</TableEmpty>}
                  {inv.map((r) => (
                    <tr key={r.variantId}>
                      <td>
                        {r.productName}
                        {r.variantName && <span className="muted"> — {r.variantName}</span>}
                      </td>
                      <td>
                        <code>{r.sku ?? '—'}</code>
                      </td>
                      <td className="num">{r.onHand}</td>
                      <td className="num">{r.reserved}</td>
                      <td className="num">
                        <strong>{r.available}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          ) : (
            <LoadingRows />
          )}
        </Card>

        <Card
          title="Sales by category"
          actions={
            <CsvButton
              size="sm"
              path={`/v1/reports/sales/by-category?start=${range.start}&end=${range.end}&format=csv`}
              filename={`sales-by-category-${range.start}-to-${range.end}.csv`}
            />
          }
        >
          {categories ? (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="num">Qty</th>
                    <th className="num">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.length === 0 && <TableEmpty colSpan={3}>No data.</TableEmpty>}
                  {categories.map((c) => (
                    <tr key={c.categoryId ?? 'none'}>
                      <td>{c.categoryName}</td>
                      <td className="num">{c.quantity}</td>
                      <td className="num">
                        <Money cents={c.revenueCents} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          ) : (
            <LoadingRows />
          )}
        </Card>

        {!financialDenied && giftLiability && (
          <Card
            title="Gift card liability"
            data-testid="gift-card-liability"
            actions={
              <CsvButton
                path="/v1/reports/gift-cards/liability?format=csv"
                filename="gift-card-liability.csv"
                size="sm"
              />
            }
          >
            <Stack>
              <StatGrid cols={4}>
                <StatTile label="Outstanding cards" value={String(giftLiability.cardCount)} />
                <StatTile
                  label="Total liability"
                  value={<Money cents={giftLiability.outstandingCents} />}
                  tone="brand"
                />
              </StatGrid>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Customer</th>
                      <th>Issued</th>
                      <th>Expires</th>
                      <th className="num">Initial</th>
                      <th className="num">Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {giftLiability.rows.length === 0 && (
                      <TableEmpty colSpan={6}>No data.</TableEmpty>
                    )}
                    {giftLiability.rows.map((r) => (
                      <tr key={r.code}>
                        <td>
                          <code>{r.code}</code>
                        </td>
                        <td>{r.customerName ?? '—'}</td>
                        <td>{r.issuedAt}</td>
                        <td>{r.expiresAt ?? '—'}</td>
                        <td className="num">
                          <Money cents={r.initialCents} />
                        </td>
                        <td className="num">
                          <Money cents={r.remainingCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Stack>
          </Card>
        )}

        <Card title="Receipts by payment type" data-testid="receipts-report">
          <Toolbar
            end={
              <CsvButton
                path={`/v1/reports/receipts?start=${range.start}&end=${range.end}&format=csv`}
                filename={`receipts-${range.start}-to-${range.end}.csv`}
                size="sm"
              />
            }
          >
            <Button size="sm" variant="secondary" onClick={() => void loadReceipts()}>
              <RefreshCw size={13} aria-hidden />
              Run for {formatRange(range)}
            </Button>
          </Toolbar>
          {!receipts ? (
            <LoadingRows />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Location</th>
                    <th className="num">Count</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.rows.length === 0 && <TableEmpty colSpan={4}>No data.</TableEmpty>}
                  {receipts.rows.map((r, i) => (
                    <tr key={`${r.method}-${r.locationId ?? 'x'}-${i}`}>
                      <td>{r.method}</td>
                      <td>{r.locationName ?? '—'}</td>
                      <td className="num">{r.count}</td>
                      <td className="num">
                        <Money cents={r.amountCents} />
                      </td>
                    </tr>
                  ))}
                  {receipts.rows.length > 0 && (
                    <tr className="font-semibold">
                      <td>Total</td>
                      <td />
                      <td className="num">{receipts.totals.count}</td>
                      <td className="num">
                        <Money cents={receipts.totals.amountCents} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Inventory adjustments" data-testid="inventory-adjustments">
          <Toolbar
            end={
              <CsvButton
                path={`/v1/reports/inventory-adjustments?start=${range.start}&end=${range.end}&format=csv`}
                filename={`inventory-adjustments-${range.start}-to-${range.end}.csv`}
                size="sm"
              />
            }
          >
            <Button size="sm" variant="secondary" onClick={() => void loadAdjustments()}>
              <RefreshCw size={13} aria-hidden />
              Run for {formatRange(range)}
            </Button>
          </Toolbar>
          {!adjustments ? (
            <LoadingRows />
          ) : (
            <Stack>
              {adjustments.truncated && (
                <Alert tone="warning">
                  Showing the most recent 1000 movements — narrow the window for full coverage.
                </Alert>
              )}
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th className="num">Movements</th>
                      <th className="num">Units in</th>
                      <th className="num">Units out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adjustments.byReason.length === 0 && (
                      <TableEmpty colSpan={4}>No data.</TableEmpty>
                    )}
                    {adjustments.byReason.map((r) => (
                      <tr key={r.reason}>
                        <td>{r.reason}</td>
                        <td className="num">{r.movements}</td>
                        <td className="num">{r.totalIn}</td>
                        <td className="num">{r.totalOut}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Stack>
          )}
        </Card>

        <Card title="Delivery date changes (30 days)" data-testid="delivery-date-changes">
          {!dateChanges ? (
            <LoadingRows />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Order</th>
                    <th>Change</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {dateChanges.length === 0 && <TableEmpty colSpan={4}>No data.</TableEmpty>}
                  {dateChanges.map((r, i) => (
                    <tr key={`${r.deliveryId ?? 'x'}-${i}`}>
                      <td>{new Date(r.at).toLocaleString()}</td>
                      <td>{r.orderNumber ?? '—'}</td>
                      <td>
                        {r.action === 'delivery.cancel'
                          ? 'Cancelled'
                          : r.fromDate && r.toDate
                            ? `${r.fromDate} → ${r.toDate}`
                            : (r.toDate ?? r.fromDate ?? r.action)}
                      </td>
                      <td>{r.actorEmail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        {!financialDenied && (
          <Card
            title="Tax summary"
            actions={
              <CsvButton
                size="sm"
                path={`/v1/reports/tax/summary?start=${range.start}&end=${range.end}&format=csv`}
                filename={`tax-summary-${range.start}-to-${range.end}.csv`}
              />
            }
          >
            {taxSummary ? (
              <>
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tax class</th>
                        <th className="num">Lines</th>
                        <th className="num">Net sales</th>
                        <th className="num">Tax collected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taxSummary.rows.length === 0 && (
                        <TableEmpty colSpan={4}>No data.</TableEmpty>
                      )}
                      {taxSummary.rows.map((r) => (
                        <tr key={r.taxClassId ?? 'default'}>
                          <td>{r.taxClassName}</td>
                          <td className="num">{r.lineCount}</td>
                          <td className="num">
                            <Money cents={r.netSalesCents} />
                          </td>
                          <td className="num">
                            <Money cents={r.taxCents} />
                          </td>
                        </tr>
                      ))}
                      {taxSummary.rows.length > 0 && (
                        <tr className="font-semibold">
                          <td colSpan={3}>Total tax</td>
                          <td className="num">
                            <Money cents={taxSummary.totalTaxCents} />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </TableWrap>
                {taxSummary.byLocation && taxSummary.byLocation.length > 0 && (
                  <>
                    <SectionHeading as="h3" title="By location (completed documents)" />
                    <TableWrap>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Location</th>
                            <th className="num">Documents</th>
                            <th className="num">Total sold</th>
                            <th className="num">Tax collected</th>
                          </tr>
                        </thead>
                        <tbody>
                          {taxSummary.byLocation.map((r) => (
                            <tr key={r.locationId}>
                              <td>{r.locationName ?? r.locationId}</td>
                              <td className="num">{r.documents}</td>
                              <td className="num">
                                <Money cents={r.totalCents} />
                              </td>
                              <td className="num">
                                <Money cents={r.taxCents} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  </>
                )}
              </>
            ) : (
              <LoadingRows />
            )}
          </Card>
        )}

        {!financialDenied && (
          <Card
            title="Inventory valuation"
            actions={
              <CsvButton
                size="sm"
                path="/v1/reports/inventory/valuation?format=csv"
                filename="inventory-valuation.csv"
              />
            }
          >
            {valuation ? (
              <Stack>
                <StatGrid cols={4}>
                  <StatTile
                    label="At cost"
                    value={<Money cents={valuation.totalCostValueCents} />}
                  />
                  <StatTile
                    label="At retail"
                    value={<Money cents={valuation.totalRetailValueCents} />}
                  />
                </StatGrid>
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>SKU</th>
                        <th>Location</th>
                        <th className="num">On hand</th>
                        <th className="num">Unit cost</th>
                        <th className="num">Cost value</th>
                        <th className="num">Retail value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {valuation.rows.length === 0 && <TableEmpty colSpan={7}>No data.</TableEmpty>}
                      {valuation.rows.map((r) => (
                        <tr key={`${r.variantId}-${r.locationId}`}>
                          <td>
                            {r.productName}
                            {r.variantName && <span className="muted"> — {r.variantName}</span>}
                          </td>
                          <td>
                            <code>{r.sku ?? '—'}</code>
                          </td>
                          <td>{r.locationName ?? '—'}</td>
                          <td className="num">{r.onHand}</td>
                          <td className="num">
                            {r.costCents != null ? <Money cents={r.costCents} /> : '—'}
                          </td>
                          <td className="num">
                            {r.costValueCents != null ? <Money cents={r.costValueCents} /> : '—'}
                          </td>
                          <td className="num">
                            <Money cents={r.retailValueCents} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Stack>
            ) : (
              <LoadingRows />
            )}
          </Card>
        )}
      </Stack>
    </div>
  );
}
