'use client';

import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Field,
  Input,
  LinkButton,
  type ListColumns,
  LoadingRows,
  PageHeader,
  ResetColumns,
  SectionHeading,
  Select,
  Stack,
  StatGrid,
  StatTile,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
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

/**
 * A totals row's cells in the header's order: the label spans the leading
 * columns that carry no total, each total sits under its own column and
 * the rest stay blank, so a moved column keeps its total under it.
 */
function TotalCells<Row>({
  list,
  label,
  totals,
}: {
  list: ListColumns<Row>;
  label: ReactNode;
  totals: Record<string, ReactNode>;
}) {
  const firstTotal = list.ordered.findIndex((c) => c.id in totals);
  const lead = firstTotal < 0 ? list.ordered.length : firstTotal;
  let placed = lead > 0;
  return (
    <>
      {lead > 0 && <td colSpan={lead}>{label}</td>}
      {list.ordered.slice(lead).map((c) => {
        if (c.id in totals) {
          return (
            <td key={c.id} className="num">
              {totals[c.id]}
            </td>
          );
        }
        if (!placed) {
          placed = true;
          return <td key={c.id}>{label}</td>;
        }
        return <td key={c.id} />;
      })}
    </>
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

interface ZShift {
  id: string;
  openedAt: string;
  closedAt: string | null;
  openingFloatCents: number;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
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
  shifts: ZShift[];
}
interface CategoryRow {
  categoryId: string | null;
  categoryName: string;
  quantity: number;
  revenueCents: number;
}
interface TaxClassRow {
  taxClassId: string | null;
  taxClassName: string;
  lineCount: number;
  netSalesCents: number;
  taxCents: number;
}
interface TaxLocationRow {
  locationId: string;
  locationName: string | null;
  documents: number;
  taxCents: number;
  totalCents: number;
}
interface TaxSummary {
  rows: TaxClassRow[];
  byLocation: TaxLocationRow[];
  totalTaxCents: number;
}
interface ValuationRow {
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
}
interface Valuation {
  rows: ValuationRow[];
  totalCostValueCents: number;
  totalRetailValueCents: number;
}

const Z_DRAWER_COLUMNS: ColumnDef<ZShift>[] = [
  {
    id: 'opened',
    label: 'Opened',
    sortValue: (s) => s.openedAt,
    render: (s) => new Date(s.openedAt).toLocaleTimeString(),
  },
  {
    id: 'closed',
    label: 'Closed',
    sortValue: (s) => s.closedAt,
    render: (s) => (s.closedAt ? new Date(s.closedAt).toLocaleTimeString() : 'open'),
  },
  {
    id: 'float',
    label: 'Float',
    num: true,
    sortValue: (s) => s.openingFloatCents,
    render: (s) => <Money cents={s.openingFloatCents} />,
  },
  {
    id: 'expected',
    label: 'Expected',
    num: true,
    sortValue: (s) => s.expectedCashCents,
    render: (s) => (s.expectedCashCents != null ? <Money cents={s.expectedCashCents} /> : '—'),
  },
  {
    id: 'counted',
    label: 'Counted',
    num: true,
    sortValue: (s) => s.countedCashCents,
    render: (s) => (s.countedCashCents != null ? <Money cents={s.countedCashCents} /> : '—'),
  },
  {
    id: 'variance',
    label: 'Variance',
    num: true,
    sortValue: (s) => s.varianceCents,
    render: (s) => (
      <span
        style={{
          color: s.varianceCents != null && s.varianceCents !== 0 ? 'var(--danger)' : undefined,
        }}
      >
        {s.varianceCents != null ? <Money cents={s.varianceCents} /> : '—'}
      </span>
    ),
  },
];

const DAILY_COLUMNS: ColumnDef<DailyTotalRow>[] = [
  { id: 'day', label: 'Day', sortValue: (d) => d.day, render: (d) => d.day },
  {
    id: 'sales',
    label: 'Sales',
    num: true,
    sortValue: (d) => d.saleCount,
    render: (d) => d.saleCount,
  },
  {
    id: 'subtotal',
    label: 'Subtotal',
    num: true,
    sortValue: (d) => d.subtotalCents,
    render: (d) => <Money cents={d.subtotalCents} />,
  },
  {
    id: 'discount',
    label: 'Discount',
    num: true,
    sortValue: (d) => d.discountCents,
    render: (d) => <Money cents={d.discountCents} />,
  },
  {
    id: 'tax',
    label: 'Tax',
    num: true,
    sortValue: (d) => d.taxCents,
    render: (d) => <Money cents={d.taxCents} />,
  },
  {
    id: 'total',
    label: 'Total',
    num: true,
    sortValue: (d) => d.totalCents,
    render: (d) => (
      <strong>
        <Money cents={d.totalCents} />
      </strong>
    ),
  },
];

const ASSOCIATE_COLUMNS: ColumnDef<AssociateTotalRow>[] = [
  {
    id: 'associate',
    label: 'Associate',
    sortValue: (a) => a.associateEmail,
    render: (a) => a.associateEmail ?? '(deleted)',
  },
  {
    id: 'sales',
    label: 'Sales',
    num: true,
    sortValue: (a) => a.saleCount,
    render: (a) => a.saleCount,
  },
  {
    id: 'total',
    label: 'Total',
    num: true,
    sortValue: (a) => a.totalCents,
    render: (a) => <Money cents={a.totalCents} />,
  },
];

const PRODUCT_COLUMNS: ColumnDef<ProductRow>[] = [
  {
    id: 'product',
    label: 'Product',
    sortValue: (p) => p.productName,
    render: (p) => p.productName,
  },
  {
    id: 'variant',
    label: 'Variant',
    sortValue: (p) => p.variantName,
    render: (p) => p.variantName ?? '—',
  },
  { id: 'sku', label: 'SKU', sortValue: (p) => p.sku, render: (p) => <code>{p.sku ?? '—'}</code> },
  { id: 'qty', label: 'Qty', num: true, sortValue: (p) => p.quantity, render: (p) => p.quantity },
  {
    id: 'revenue',
    label: 'Revenue',
    num: true,
    sortValue: (p) => p.revenueCents,
    render: (p) => <Money cents={p.revenueCents} />,
  },
];
/** Only shown when the API returned margins (cost visibility). */
const PRODUCT_MARGIN_COLUMN: ColumnDef<ProductRow> = {
  id: 'margin',
  label: 'Margin',
  num: true,
  sortValue: (p) => p.marginCents,
  render: (p) => (p.marginCents != null ? <Money cents={p.marginCents} /> : '—'),
};

const INVENTORY_COLUMNS: ColumnDef<InventoryRow>[] = [
  {
    id: 'product',
    label: 'Product',
    sortValue: (r) => r.productName,
    render: (r) => (
      <>
        {r.productName}
        {r.variantName && <span className="muted"> — {r.variantName}</span>}
      </>
    ),
  },
  { id: 'sku', label: 'SKU', sortValue: (r) => r.sku, render: (r) => <code>{r.sku ?? '—'}</code> },
  {
    id: 'onHand',
    label: 'On hand',
    num: true,
    sortValue: (r) => r.onHand,
    render: (r) => r.onHand,
  },
  {
    id: 'reserved',
    label: 'Reserved',
    num: true,
    sortValue: (r) => r.reserved,
    render: (r) => r.reserved,
  },
  {
    id: 'available',
    label: 'Available',
    num: true,
    sortValue: (r) => r.available,
    render: (r) => <strong>{r.available}</strong>,
  },
];

const CATEGORY_COLUMNS: ColumnDef<CategoryRow>[] = [
  {
    id: 'category',
    label: 'Category',
    sortValue: (c) => c.categoryName,
    render: (c) => c.categoryName,
  },
  { id: 'qty', label: 'Qty', num: true, sortValue: (c) => c.quantity, render: (c) => c.quantity },
  {
    id: 'revenue',
    label: 'Revenue',
    num: true,
    sortValue: (c) => c.revenueCents,
    render: (c) => <Money cents={c.revenueCents} />,
  },
];

const GIFT_CARD_COLUMNS: ColumnDef<GiftCardLiabilityRow>[] = [
  { id: 'code', label: 'Code', sortValue: (r) => r.code, render: (r) => <code>{r.code}</code> },
  {
    id: 'customer',
    label: 'Customer',
    sortValue: (r) => r.customerName,
    render: (r) => r.customerName ?? '—',
  },
  { id: 'issued', label: 'Issued', sortValue: (r) => r.issuedAt, render: (r) => r.issuedAt },
  {
    id: 'expires',
    label: 'Expires',
    sortValue: (r) => r.expiresAt,
    render: (r) => r.expiresAt ?? '—',
  },
  {
    id: 'initial',
    label: 'Initial',
    num: true,
    sortValue: (r) => r.initialCents,
    render: (r) => <Money cents={r.initialCents} />,
  },
  {
    id: 'remaining',
    label: 'Remaining',
    num: true,
    sortValue: (r) => r.remainingCents,
    render: (r) => <Money cents={r.remainingCents} />,
  },
];

function describeDateChange(r: DeliveryDateChangeRow): string {
  return r.action === 'delivery.cancel'
    ? 'Cancelled'
    : r.fromDate && r.toDate
      ? `${r.fromDate} → ${r.toDate}`
      : (r.toDate ?? r.fromDate ?? r.action);
}

const DATE_CHANGE_COLUMNS: ColumnDef<DeliveryDateChangeRow>[] = [
  {
    id: 'when',
    label: 'When',
    sortValue: (r) => r.at,
    render: (r) => new Date(r.at).toLocaleString(),
  },
  {
    id: 'order',
    label: 'Order',
    sortValue: (r) => r.orderNumber,
    render: (r) => r.orderNumber ?? '—',
  },
  {
    id: 'change',
    label: 'Change',
    sortValue: (r) => describeDateChange(r),
    render: (r) => describeDateChange(r),
  },
  { id: 'by', label: 'By', sortValue: (r) => r.actorEmail, render: (r) => r.actorEmail ?? '—' },
];

const TAX_CLASS_COLUMNS: ColumnDef<TaxClassRow>[] = [
  {
    id: 'taxClass',
    label: 'Tax class',
    sortValue: (r) => r.taxClassName,
    render: (r) => r.taxClassName,
  },
  {
    id: 'lines',
    label: 'Lines',
    num: true,
    sortValue: (r) => r.lineCount,
    render: (r) => r.lineCount,
  },
  {
    id: 'netSales',
    label: 'Net sales',
    num: true,
    sortValue: (r) => r.netSalesCents,
    render: (r) => <Money cents={r.netSalesCents} />,
  },
  {
    id: 'taxCollected',
    label: 'Tax collected',
    num: true,
    sortValue: (r) => r.taxCents,
    render: (r) => <Money cents={r.taxCents} />,
  },
];

const TAX_LOCATION_COLUMNS: ColumnDef<TaxLocationRow>[] = [
  {
    id: 'location',
    label: 'Location',
    sortValue: (r) => r.locationName ?? r.locationId,
    render: (r) => r.locationName ?? r.locationId,
  },
  {
    id: 'documents',
    label: 'Documents',
    num: true,
    sortValue: (r) => r.documents,
    render: (r) => r.documents,
  },
  {
    id: 'totalSold',
    label: 'Total sold',
    num: true,
    sortValue: (r) => r.totalCents,
    render: (r) => <Money cents={r.totalCents} />,
  },
  {
    id: 'taxCollected',
    label: 'Tax collected',
    num: true,
    sortValue: (r) => r.taxCents,
    render: (r) => <Money cents={r.taxCents} />,
  },
];

const VALUATION_COLUMNS: ColumnDef<ValuationRow>[] = [
  {
    id: 'product',
    label: 'Product',
    sortValue: (r) => r.productName,
    render: (r) => (
      <>
        {r.productName}
        {r.variantName && <span className="muted"> — {r.variantName}</span>}
      </>
    ),
  },
  { id: 'sku', label: 'SKU', sortValue: (r) => r.sku, render: (r) => <code>{r.sku ?? '—'}</code> },
  {
    id: 'location',
    label: 'Location',
    sortValue: (r) => r.locationName,
    render: (r) => r.locationName ?? '—',
  },
  {
    id: 'onHand',
    label: 'On hand',
    num: true,
    sortValue: (r) => r.onHand,
    render: (r) => r.onHand,
  },
  {
    id: 'unitCost',
    label: 'Unit cost',
    num: true,
    sortValue: (r) => r.costCents,
    render: (r) => (r.costCents != null ? <Money cents={r.costCents} /> : '—'),
  },
  {
    id: 'costValue',
    label: 'Cost value',
    num: true,
    sortValue: (r) => r.costValueCents,
    render: (r) => (r.costValueCents != null ? <Money cents={r.costValueCents} /> : '—'),
  },
  {
    id: 'retailValue',
    label: 'Retail value',
    num: true,
    sortValue: (r) => r.retailValueCents,
    render: (r) => <Money cents={r.retailValueCents} />,
  },
];

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

  // Column order + sort per record list on this page (one hook per table).
  const zDrawerCols = useListColumns('reports-z-drawers', Z_DRAWER_COLUMNS, z?.shifts ?? null);
  const summaryColumns = useMemo<ColumnDef<SalesSummaryRow>[]>(
    () => [
      {
        id: 'group',
        label:
          summaryGroupBy === 'day'
            ? 'Day'
            : summaryGroupBy === 'location'
              ? 'Location'
              : 'Salesperson',
        sortValue: (r) => r.label,
        render: (r) => r.label,
      },
      {
        id: 'documents',
        label: 'Documents',
        num: true,
        sortValue: (r) => r.documentCount,
        render: (r) => r.documentCount,
      },
      {
        id: 'merchandise',
        label: 'Merchandise',
        num: true,
        sortValue: (r) => r.merchandiseCents,
        render: (r) => <Money cents={r.merchandiseCents} />,
      },
      {
        id: 'discounts',
        label: 'Discounts',
        num: true,
        sortValue: (r) => r.discountCents,
        render: (r) => <Money cents={r.discountCents} />,
      },
      {
        id: 'tax',
        label: 'Tax',
        num: true,
        sortValue: (r) => r.taxCents,
        render: (r) => <Money cents={r.taxCents} />,
      },
      {
        id: 'total',
        label: 'Total',
        num: true,
        sortValue: (r) => r.totalCents,
        render: (r) => <Money cents={r.totalCents} />,
      },
    ],
    [summaryGroupBy],
  );
  const summaryCols = useListColumns(
    'reports-sales-summary',
    summaryColumns,
    summary?.rows ?? null,
  );
  const dailyCols = useListColumns('reports-daily-by-day', DAILY_COLUMNS, daily?.byDay ?? null);
  const associateCols = useListColumns(
    'reports-daily-by-associate',
    ASSOCIATE_COLUMNS,
    daily?.byAssociate ?? null,
  );
  const productColumns = useMemo(
    () =>
      products?.[0]?.marginCents != null
        ? [...PRODUCT_COLUMNS, PRODUCT_MARGIN_COLUMN]
        : PRODUCT_COLUMNS,
    [products],
  );
  const productCols = useListColumns('reports-sales-by-product', productColumns, products);
  const invCols = useListColumns('reports-inventory-on-hand', INVENTORY_COLUMNS, inv);
  const categoryCols = useListColumns('reports-sales-by-category', CATEGORY_COLUMNS, categories);
  const giftCols = useListColumns(
    'reports-gift-card-liability',
    GIFT_CARD_COLUMNS,
    giftLiability?.rows ?? null,
  );
  const dateChangeCols = useListColumns(
    'reports-delivery-date-changes',
    DATE_CHANGE_COLUMNS,
    dateChanges,
  );
  const taxClassCols = useListColumns(
    'reports-tax-summary',
    TAX_CLASS_COLUMNS,
    taxSummary?.rows ?? null,
  );
  const taxLocationCols = useListColumns(
    'reports-tax-by-location',
    TAX_LOCATION_COLUMNS,
    taxSummary?.byLocation ?? null,
  );
  const valuationCols = useListColumns(
    'reports-inventory-valuation',
    VALUATION_COLUMNS,
    valuation?.rows ?? null,
  );

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
                    <ColumnHeadRow list={zDrawerCols} testIdPrefix="reports-z-drawers" />
                  </thead>
                  <tbody>
                    {z.shifts.length === 0 && (
                      <TableEmpty colSpan={zDrawerCols.ordered.length}>No data.</TableEmpty>
                    )}
                    {zDrawerCols.sorted.map((s) => (
                      <tr key={s.id}>
                        <ColumnCells list={zDrawerCols} row={s} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={zDrawerCols} />
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
                    <ColumnHeadRow list={summaryCols} testIdPrefix="reports-sales-summary" />
                  </thead>
                  <tbody>
                    {summary.rows.length === 0 && (
                      <TableEmpty colSpan={summaryCols.ordered.length}>No data.</TableEmpty>
                    )}
                    {summaryCols.sorted.map((r) => (
                      <tr key={r.key || '(none)'}>
                        <ColumnCells list={summaryCols} row={r} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={summaryCols} />
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
                    <ColumnHeadRow list={dailyCols} testIdPrefix="reports-daily-by-day" />
                  </thead>
                  <tbody>
                    {daily.byDay.length === 0 && (
                      <TableEmpty colSpan={dailyCols.ordered.length}>No data.</TableEmpty>
                    )}
                    {dailyCols.sorted.map((d) => (
                      <tr key={d.day}>
                        <ColumnCells list={dailyCols} row={d} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={dailyCols} />
              </TableWrap>

              <SectionHeading as="h3" title="By associate" />
              <TableWrap>
                <table className="table">
                  <thead>
                    <ColumnHeadRow list={associateCols} testIdPrefix="reports-daily-by-associate" />
                  </thead>
                  <tbody>
                    {daily.byAssociate.length === 0 && (
                      <TableEmpty colSpan={associateCols.ordered.length}>No data.</TableEmpty>
                    )}
                    {associateCols.sorted.map((a) => (
                      <tr key={a.associateUserId ?? 'none'}>
                        <ColumnCells list={associateCols} row={a} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={associateCols} />
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
                  <ColumnHeadRow list={productCols} testIdPrefix="reports-sales-by-product" />
                </thead>
                <tbody>
                  {products.length === 0 && (
                    <TableEmpty colSpan={productCols.ordered.length}>No data.</TableEmpty>
                  )}
                  {productCols.sorted.map((p) => (
                    <tr key={p.variantId}>
                      <ColumnCells list={productCols} row={p} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={productCols} />
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
                  <ColumnHeadRow list={invCols} testIdPrefix="reports-inventory-on-hand" />
                </thead>
                <tbody>
                  {inv.length === 0 && (
                    <TableEmpty colSpan={invCols.ordered.length}>No data.</TableEmpty>
                  )}
                  {invCols.sorted.map((r) => (
                    <tr key={r.variantId}>
                      <ColumnCells list={invCols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={invCols} />
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
                  <ColumnHeadRow list={categoryCols} testIdPrefix="reports-sales-by-category" />
                </thead>
                <tbody>
                  {categories.length === 0 && (
                    <TableEmpty colSpan={categoryCols.ordered.length}>No data.</TableEmpty>
                  )}
                  {categoryCols.sorted.map((c) => (
                    <tr key={c.categoryId ?? 'none'}>
                      <ColumnCells list={categoryCols} row={c} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={categoryCols} />
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
                    <ColumnHeadRow list={giftCols} testIdPrefix="reports-gift-card-liability" />
                  </thead>
                  <tbody>
                    {giftLiability.rows.length === 0 && (
                      <TableEmpty colSpan={giftCols.ordered.length}>No data.</TableEmpty>
                    )}
                    {giftCols.sorted.map((r) => (
                      <tr key={r.code}>
                        <ColumnCells list={giftCols} row={r} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={giftCols} />
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
                  <ColumnHeadRow
                    list={dateChangeCols}
                    testIdPrefix="reports-delivery-date-changes"
                  />
                </thead>
                <tbody>
                  {dateChanges.length === 0 && (
                    <TableEmpty colSpan={dateChangeCols.ordered.length}>No data.</TableEmpty>
                  )}
                  {dateChangeCols.sorted.map((r, i) => (
                    <tr key={`${r.deliveryId ?? 'x'}-${i}`}>
                      <ColumnCells list={dateChangeCols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={dateChangeCols} />
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
                      <ColumnHeadRow list={taxClassCols} testIdPrefix="reports-tax-summary" />
                    </thead>
                    <tbody>
                      {taxSummary.rows.length === 0 && (
                        <TableEmpty colSpan={taxClassCols.ordered.length}>No data.</TableEmpty>
                      )}
                      {taxClassCols.sorted.map((r) => (
                        <tr key={r.taxClassId ?? 'default'}>
                          <ColumnCells list={taxClassCols} row={r} />
                        </tr>
                      ))}
                      {taxSummary.rows.length > 0 && (
                        <tr className="font-semibold">
                          <TotalCells
                            list={taxClassCols}
                            label="Total tax"
                            totals={{ taxCollected: <Money cents={taxSummary.totalTaxCents} /> }}
                          />
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <ResetColumns list={taxClassCols} />
                </TableWrap>
                {taxSummary.byLocation && taxSummary.byLocation.length > 0 && (
                  <>
                    <SectionHeading as="h3" title="By location (completed documents)" />
                    <TableWrap>
                      <table className="table">
                        <thead>
                          <ColumnHeadRow
                            list={taxLocationCols}
                            testIdPrefix="reports-tax-by-location"
                          />
                        </thead>
                        <tbody>
                          {taxLocationCols.sorted.map((r) => (
                            <tr key={r.locationId}>
                              <ColumnCells list={taxLocationCols} row={r} />
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <ResetColumns list={taxLocationCols} />
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
                      <ColumnHeadRow
                        list={valuationCols}
                        testIdPrefix="reports-inventory-valuation"
                      />
                    </thead>
                    <tbody>
                      {valuation.rows.length === 0 && (
                        <TableEmpty colSpan={valuationCols.ordered.length}>No data.</TableEmpty>
                      )}
                      {valuationCols.sorted.map((r) => (
                        <tr key={`${r.variantId}-${r.locationId}`}>
                          <ColumnCells list={valuationCols} row={r} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ResetColumns list={valuationCols} />
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
