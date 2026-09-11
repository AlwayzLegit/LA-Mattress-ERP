/**
 * A21 (PLAN-POS-OPERATIONS §12.17): response shapes of
 * `GET /v1/products/:id/activity/<section>` — the STORIS View Product
 * Activity tabs. Mirrors `apps/api/src/catalog/product-activity.controller.ts`.
 */

/** The header strip every section repeats (A19 stock totals + A21 on-order reserved). */
export interface Strip {
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  netOnPo: number;
  totalPo: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
  layawayReserved: number;
  onOrderReserved: number;
}

export interface AtpResult {
  desiredQuantity: number;
  asOf: string;
  total: { atpQuantity: number; atpDate: string | null };
  byLocation: {
    locationId: string;
    locationName: string;
    atpQuantity: number;
    atpDate: string | null;
  }[];
}

export interface PurchaseOrderRow {
  purchaseOrderId: string;
  number: string;
  vendorId: string;
  vendorName: string | null;
  receivingLocationId: string;
  receivingLocationName: string | null;
  sku: string | null;
  quantityOrdered: number;
  quantityDue: number;
  placedAt: string | null;
  expectedAt: string | null;
  createdAt: string;
  status: string;
  transactionType: 'merchandise' | 'direct_ship';
}

export interface OpenOrderRow {
  orderId: string;
  orderNumber: string;
  orderType: 'sales_order' | 'layaway' | 'exchange' | 'quote';
  sellingLocationId: string;
  sellingLocationName: string | null;
  fulfillmentDate: string | null;
  orderQuantity: number;
  reservedQuantity: number;
  fulfillmentType: string;
  fulfillmentStatus: string | null;
  shipFromLocationId: string | null;
  shipFromLocationName: string | null;
  orderDate: string;
  customerId: string | null;
  customerName: string | null;
  lineId: string;
  lineDescription: string;
  lineType: string;
}

export interface SalesHistoryPeriod {
  period: string;
  label: string;
  salesCents: number;
  costCents: number | null;
  profitPercent: number | null;
  shipped: number;
  returned: number;
  net: number;
}

export interface TransferRow {
  transferId: string;
  number: string;
  status: string;
  transferType: string;
  fromLocationId: string;
  fromLocationName: string | null;
  toLocationId: string;
  toLocationName: string | null;
  transferDate: string;
  quantity: number;
  reservedQuantity: number;
  orderId: string | null;
  orderNumber: string | null;
  scheduledFor: string | null;
  customerName: string | null;
}

export interface SerialRow {
  id: string;
  serial: string;
  sku: string | null;
  locationId: string;
  locationName: string | null;
  receivedAt: string;
  status: string;
  storageBinCode: string | null;
  orderId: string | null;
  orderNumber: string | null;
  customerName: string | null;
  specialOrder: string | null;
}

export interface AsIsRow {
  id: string;
  pieceNumber: string | null;
  sku: string | null;
  locationId: string;
  locationName: string | null;
  quantity: number;
  receivedAt: string;
  status: string;
  condition: string | null;
  sellable: boolean;
  reasonCode: { code: string; description: string } | null;
  asIsPriceCents: number | null;
  storageLocation: string | null;
  source: string;
  notes: string | null;
}

export interface Summary {
  locationId: string | null;
  monthStart: string;
  strip: Strip;
  beginningBalance: number;
  beginningAsIsBalance: number;
  regular: {
    received: number;
    adjustments: number;
    transferredIn: number;
    transferredOut: number;
    sales: number;
  };
  asIs: { transferredIn: number; transferredOut: number; added: number; removed: number };
}

export interface General {
  capacityUnits: number | null;
  cost: {
    averageCents: number | null;
    poReplacementCents: number | null;
    averageLandedCents: number | null;
    freightPerUnitCents: number | null;
    freightPercent: number | null;
    layerUnits: number;
    vendorName: string | null;
  };
}

/** The STORIS Shipping Information block, stored on the product (D9). */
export interface Shipping {
  weightLb: number | null;
  heightIn: number | null;
  widthIn: number | null;
  depthIn: number | null;
  shippingVolume: number | null;
  deliveryVolume: number | null;
}

/** The STORIS section list, in STORIS order (D1). */
export const PRODUCT_TABS = [
  { key: 'availability', label: 'Location Availability ATP' },
  { key: 'purchase-orders', label: 'Purchase Orders' },
  { key: 'open-orders', label: 'Open Orders' },
  { key: 'sales-history', label: 'Sales History' },
  { key: 'inbound', label: 'Inbound Transfers' },
  { key: 'outbound', label: 'Outbound Transfers' },
  { key: 'general', label: 'General Information' },
  { key: 'serials', label: 'Serial/Reference' },
  { key: 'as-is', label: 'As-Is' },
  { key: 'summary', label: 'Summary' },
] as const;
export type ProductTab = (typeof PRODUCT_TABS)[number]['key'];
