/** Shapes the A20 dialogs read — mirrors apps/api/src/orders/order-actions.controller.ts. */

export interface ActionLine {
  id: string;
  variantId: string | null;
  description: string;
  quantity: number;
  qtyReserved: number;
  qtyFulfilled: number;
  lineType: string;
  unitPriceCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  taxRateBps?: number;
  fulfillmentMethod: string | null;
  sourceLocationId: string | null;
  comment?: string | null;
  room?: string | null;
  pieces?: number | null;
  prepCodes?: string[] | null;
  comJson?: { supplied?: boolean; description?: string | null } | null;
  directShipJson?: {
    vendorName?: string | null;
    vendorOrderRef?: string | null;
    trackingNumber?: string | null;
    expectedDate?: string | null;
  } | null;
  needsInstall?: boolean;
}

export interface ActionOrder {
  id: string;
  number: string;
  status: string;
  orderKind: string;
  customerId: string;
  locationId: string;
  stockLocationId: string | null;
  fulfillmentType: string;
  requestedDate: string | null;
  subtotalCents: number;
  orderDiscountCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  depositRequiredCents: number;
  paidCents: number;
  balanceDueCents: number;
  deliveryFeeCents?: number;
  installFeeCents?: number;
  otherFeeCents?: number;
  otherFeeLabel?: string | null;
  notes: string | null;
  internalNotes: string | null;
  marketingCode?: string | null;
  marketingCode2?: string | null;
  orderSource?: string | null;
  paymentTerminal?: string | null;
  exceptionNotes?: string | null;
  tradeDesignerJson?: {
    name?: string | null;
    company?: string | null;
    phone?: string | null;
    email?: string | null;
    note?: string | null;
  } | null;
  customInfoJson?: { label: string; value: string }[] | null;
  salespersonMembershipId?: string | null;
  secondSalespersonMembershipId?: string | null;
  splitBps?: number | null;
  deliveryStatus?: string | null;
  deliveryInstructions?: string | null;
  pickupLocationId?: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressPhone: string | null;
  lockedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  lines: ActionLine[];
  payments: {
    id: string;
    kind: string;
    method: string;
    amountCents: number;
    status: string;
    createdAt: string;
  }[];
}

export interface OpsLists {
  marketingCodes?: string[] | null;
  orderSources?: string[] | null;
  prepCodes?: string[] | null;
  rooms?: string[] | null;
  paymentTerminals?: string[] | null;
}

export interface AttachmentRow {
  id: string;
  lineId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface TaxInfo {
  storeRateBps: number;
  subtotalCents: number;
  orderDiscountCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  untaxedLines: number;
  lines: {
    id: string;
    description: string;
    quantity: number;
    taxClassId: string | null;
    taxClassName: string | null;
    taxRateBps: number;
    lineSubtotalCents: number;
    taxCents: number;
  }[];
}

export interface CostedLines {
  lines: {
    id: string;
    description: string;
    quantity: number;
    unitCostCents: number | null;
    costCents: number | null;
    revenueCents: number;
    marginCents: number | null;
    marginPct: number | null;
  }[];
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number | null;
  linesWithoutCost: number;
}

export interface CommissionTable {
  salespeople: {
    membershipId: string;
    name: string;
    shareBps: number;
    plan: { id: string; name: string; basis: string; rateBps: number } | null;
    basisCents: number | null;
    commissionCents: number | null;
  }[];
  lines: {
    id: string;
    description: string;
    quantity: number;
    merchandiseCents: number;
    commissionCents: (number | null)[];
    spiffCents: null;
  }[];
  totals: { merchandiseCents: number; commissionCents: (number | null)[] };
  costHidden: boolean;
}

export interface LinkedDocuments {
  lines: {
    id: string;
    description: string;
    purchaseOrders: {
      poId: string;
      number: string;
      status: string;
      expectedAt: string | null;
      quantity: number;
      allocationStatus: string;
    }[];
    deliveries: { id: string; scheduledDate: string; status: string; quantity: number }[];
    returns: { id: string; rmaNumber: string; status: string; quantity: number }[];
  }[];
  transfers: {
    id: string;
    number: string;
    status: string;
    from: string;
    to: string;
    shippedAt: string | null;
    receivedAt: string | null;
  }[];
  exchanges: { id: string; number: string; status: string; createdAt: string }[];
}

export interface LineStock {
  variantId: string;
  sku: string | null;
  levels: {
    locationId: string;
    locationName: string;
    onHand: number;
    reserved: number;
    available: number;
  }[];
}

export interface LineProduct {
  productId: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  secondDescription: string | null;
  sku: string | null;
  variantName: string | null;
  attributes: unknown;
  priceCents: number;
  isActive: boolean;
}
