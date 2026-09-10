/**
 * Wire shapes for the dashboard store cards and the Changes card
 * (hand-off 2026-09-10). Mirrors `apps/api/src/reports/
 * store-dashboard.controller.ts` and `order-changes.controller.ts`;
 * timestamps arrive as ISO strings.
 */

export type StorePeriod = 'mtd' | 'today';

export interface PickupReceipt {
  receivedAt: string;
  byMembershipId: string | null;
  byName: string;
  byRole: string | null;
}

export interface CashPaymentRow {
  paymentId: string;
  docKind: 'order' | 'sale' | 'service';
  docId: string;
  docNumber: string;
  customerName: string | null;
  soldAt: string;
  paidAt: string;
  kind: string;
  salespersonName: string | null;
  amountCents: number;
  receipt: PickupReceipt | null;
}

export interface SalespersonRow {
  membershipId: string;
  name: string;
  isManager: boolean;
  writtenCents: number;
  deliveredCents: number;
  orders: number;
  avgTicketCents: number;
  collectedCents: number;
  lastWriteUpAt: string | null;
}

export interface StoreCardData {
  locationId: string;
  name: string;
  timezone: string;
  manager: { membershipId: string; name: string } | null;
  sellingCount: number;
  writtenCents: number;
  writtenCount: number;
  deliveredCents: number;
  deliveredCount: number;
  avgTicketCents: number;
  receivedCents: number;
  receivedCount: number;
  refundsCents: number;
  cashTotalCents: number;
  cashPendingCents: number;
  cashPaymentCount: number;
  cashReceivedCount: number;
  salespeople: SalespersonRow[];
  tenders: { method: string; cents: number; count: number }[];
  cashPayments: CashPaymentRow[];
}

export interface StoresResponse {
  date: string;
  period: StorePeriod;
  range: { start: string; end: string };
  viewer: { membershipId: string | null; canConfirmCashPickup: boolean };
  stores: StoreCardData[];
  totals: {
    storeCount: number;
    writtenCents: number;
    writtenCount: number;
    deliveredCents: number;
    deliveredCount: number;
    receivedCents: number;
    receivedCount: number;
    cashPendingCents: number;
  };
}

export interface PaymentListResponse {
  location: { id: string; name: string };
  method: string;
  range: { start: string; end: string };
  rows: CashPaymentRow[];
  totalCents: number;
  count: number;
}

export type ChangeTone = 'danger' | 'warn' | 'ok' | 'info';
export type ChangesFilter = 'all' | 'money' | 'unseen';

export interface ChangeRow {
  id: string;
  occurredAt: string;
  type: string;
  label: string;
  tone: ChangeTone;
  moneyRelated: boolean;
  was: string | null;
  now: string | null;
  reason: string | null;
  impactCents: number | null;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  locationId: string;
  locationName: string;
  authorName: string;
  approval: string;
  seenAt: string | null;
}

export interface ChangesResponse {
  rows: ChangeRow[];
  counts: { all: number; money: number; unseen: number };
  viewer: { membershipId: string | null };
}
