'use client';

import Link from 'next/link';
import { PRODUCT_PURCHASE_STATUS_LABELS } from '@jetnine/shared';
import { Money } from '@/components/money';
import { StatusBadge, type ColumnDef } from '@/components/ui';

/**
 * The STORIS product columns of the Products browser (redesign Phase 7),
 * as a factory so Stock by location shows the same set (owner
 * 2026-10-21). Column ids are the browser's — a saved column order keys
 * on them. Every column carries both a server sort key (the browser
 * sorts through the API) and a client sort value (Stock by location
 * sorts the rows it has).
 */
export interface ProductColumnFields {
  /** The product id — the SKU and description link to its page. */
  id: string;
  sku: string | null;
  name: string;
  isActive: boolean;
  purchaseStatus: string;
  brandName: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  collectionName: string | null;
  vendorName: string | null;
  vendorModel: string | null;
  group: string | null;
  size: string | null;
  firmness: string | null;
  priceCents: number | null;
  costCents: number | null;
  /** Company-wide stock. */
  onHand: number;
  available: number;
  netOnPo: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
}

function statusLabel(p: ProductColumnFields): string {
  return PRODUCT_PURCHASE_STATUS_LABELS[p.purchaseStatus as never] ?? p.purchaseStatus;
}

/** Category, product (SKU), vendor model, vendor, description — the identity columns. */
export function productIdentityColumns<T extends ProductColumnFields>(): ColumnDef<T>[] {
  return [
    {
      id: 'category',
      label: 'Product category',
      sortKey: 'categoryName',
      sortValue: (p) => p.categoryPath ?? p.categoryName,
      render: (p) => p.categoryPath ?? p.categoryName ?? '—',
    },
    {
      id: 'product',
      label: 'Product',
      sortKey: 'sku',
      sortValue: (p) => p.sku,
      render: (p) => (
        <Link
          href={`/products/${p.id}`}
          className="pb-sku"
          data-testid="product-link"
          onClick={(e) => e.stopPropagation()}
        >
          {p.sku ?? '—'}
        </Link>
      ),
    },
    {
      id: 'vendorModel',
      label: 'Vendor model',
      sortKey: 'vendorModel',
      sortValue: (p) => p.vendorModel,
      render: (p) => <span className="pb-mono">{p.vendorModel ?? '—'}</span>,
    },
    {
      id: 'vendor',
      label: 'Vendor',
      sortKey: 'vendorName',
      sortValue: (p) => p.vendorName,
      render: (p) => p.vendorName ?? '—',
    },
    {
      id: 'description',
      label: 'Description',
      sortKey: 'name',
      sortValue: (p) => p.name,
      cellClassName: () => 'pb-desc-cell',
      render: (p) => (
        <Link href={`/products/${p.id}`} className="pb-name" onClick={(e) => e.stopPropagation()}>
          {p.name}
        </Link>
      ),
    },
  ];
}

/**
 * Company stock, PO, cost, As-Is, price, status and the descriptive
 * attributes. `showCost` drops the Sales margin cost column for roles
 * without cost access.
 */
export function productDetailColumns<T extends ProductColumnFields>(
  showCost: boolean,
): ColumnDef<T>[] {
  const cols: ColumnDef<T>[] = [
    {
      id: 'onHand',
      label: 'On hand · company',
      sortKey: 'onHand',
      sortValue: (p) => p.onHand,
      num: true,
      render: (p) => p.onHand,
    },
    {
      id: 'netOnPo',
      label: 'Net on PO',
      sortKey: 'netOnPo',
      sortValue: (p) => p.netOnPo,
      num: true,
      render: (p) => p.netOnPo,
    },
    {
      id: 'available',
      label: 'Available · ATP',
      sortKey: 'available',
      sortValue: (p) => p.available,
      num: true,
      render: (p) => (
        <span title="Available to promise: available now plus units still due on open POs">
          {p.available}
          {p.netOnPo > 0 && <span className="pb-atp"> · {p.available + p.netOnPo}</span>}
        </span>
      ),
    },
    {
      id: 'cost',
      label: 'Sales margin cost',
      sortKey: 'costCents',
      sortValue: (p) => p.costCents,
      num: true,
      // The column only renders for viewers with cost access, so a null here
      // means no cost on file — not "you may not see this".
      render: (p) =>
        p.costCents == null ? <span className="pb-muted">—</span> : <Money cents={p.costCents} />,
    },
    {
      id: 'asIsOnHand',
      label: 'As-Is on hand',
      sortKey: 'asIsOnHand',
      sortValue: (p) => p.asIsOnHand,
      num: true,
      render: (p) => p.asIsOnHand,
    },
    {
      id: 'asIsAvailable',
      label: 'As-Is available',
      sortKey: 'asIsAvailable',
      sortValue: (p) => p.asIsAvailable,
      num: true,
      render: (p) => p.asIsAvailable,
    },
    {
      id: 'price',
      label: 'Price',
      sortKey: 'priceCents',
      sortValue: (p) => p.priceCents,
      num: true,
      render: (p) => (p.priceCents == null ? '—' : <Money cents={p.priceCents} />),
    },
    {
      id: 'status',
      label: 'Status',
      sortKey: 'purchaseStatus',
      sortValue: (p) => statusLabel(p),
      render: (p) => (
        <>
          {statusLabel(p)}
          {!p.isActive && <StatusBadge status="inactive" className="ml-1" />}
        </>
      ),
    },
    {
      id: 'asIsNonSellable',
      label: 'As-Is non-sellable',
      sortKey: 'asIsNonSellable',
      sortValue: (p) => p.asIsNonSellable,
      num: true,
      render: (p) => p.asIsNonSellable,
    },
    {
      id: 'group',
      label: 'Product group',
      sortKey: 'group',
      sortValue: (p) => p.group,
      render: (p) => <span className="pb-mono">{p.group ?? '—'}</span>,
    },
    {
      id: 'brand',
      label: 'Brand',
      sortKey: 'brandName',
      sortValue: (p) => p.brandName,
      render: (p) => p.brandName ?? '—',
    },
    {
      id: 'size',
      label: 'Size',
      sortKey: 'size',
      sortValue: (p) => p.size,
      render: (p) => p.size ?? '—',
    },
    {
      id: 'firmness',
      label: 'Firmness',
      sortKey: 'firmness',
      sortValue: (p) => p.firmness,
      render: (p) => p.firmness ?? '—',
    },
    {
      id: 'collection',
      label: 'Primary collection',
      sortKey: 'collectionName',
      sortValue: (p) => p.collectionName,
      render: (p) => p.collectionName ?? '—',
    },
  ];
  return showCost ? cols : cols.filter((c) => c.id !== 'cost');
}
