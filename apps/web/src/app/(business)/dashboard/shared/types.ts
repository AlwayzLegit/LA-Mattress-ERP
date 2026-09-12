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
export type ChangesFilter = 'all' | 'critical' | 'warning' | 'money' | 'unseen';

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

// ---- Step 2: staff schedule + time clock ----------------------------------

export interface ShiftCell {
  date: string;
  /** null = pending day off (an unpublished removal). */
  startMinutes: number | null;
  endMinutes: number | null;
  published: boolean;
}

export interface SchedulePerson {
  membershipId: string;
  name: string;
  roleName: string | null;
  locationId: string | null;
  locationName: string;
  isLead: boolean;
  shifts: ShiftCell[];
}

export interface ScheduleWeek {
  today: string;
  timezone: string;
  week: { start: string; end: string; days: { date: string; dow: string; isToday: boolean }[] };
  locations: { id: string; name: string; locationType: string }[];
  canEdit: boolean;
  people: SchedulePerson[];
  unpublishedCount: number;
  lastPublishedAt: string | null;
}

export type PunchType = 'clock_in' | 'break_start' | 'break_end' | 'clock_out';
export type ClockStatus = 'out' | 'in' | 'break';

export interface TimeClockMe {
  date: string;
  timezone: string;
  member: {
    membershipId: string;
    name: string;
    roleName: string | null;
    locationId: string | null;
    locationName: string;
  };
  status: ClockStatus;
  since: string | null;
  punchesToday: { id: string; type: PunchType; at: string }[];
  hoursToday: number;
  hoursWeek: number;
  scheduledToday: { startMinutes: number; endMinutes: number } | null;
  allowed: PunchType[];
}

// ---- Redesign Phase 9: cash pickups --------------------------------------

export type PickupStatus = 'none' | 'collected' | 'holding' | 'due';

export interface PendingCashRow {
  paymentId: string;
  docKind: 'order' | 'sale' | 'service';
  docId: string;
  docNumber: string;
  customerName: string | null;
  salespersonName: string | null;
  paidAt: string;
  /** Store-local days since the payment was taken (0 = today). */
  ageDays: number;
  amountCents: number;
}

export interface PickupSummary {
  id: string;
  number: string;
  recordedAt: string;
  byName: string;
  countedCents: number;
  expectedCents: number;
  varianceCents: number;
  slip: string | null;
  note: string | null;
  paymentCount: number;
}

export interface CashPickupStore {
  locationId: string;
  name: string;
  timezone: string;
  status: PickupStatus;
  pendingCents: number;
  pendingCount: number;
  oldestDays: number | null;
  since: string;
  lastPickup: PickupSummary | null;
  payments: PendingCashRow[];
  canRecord: boolean;
}

export interface CashPickupQueue {
  date: string;
  rule: { dueCents: number; dueDays: number };
  viewer: { membershipId: string | null; canRecord: boolean };
  stores: CashPickupStore[];
  totals: { storeCount: number; pendingCents: number; dueCount: number; holdingCount: number };
}

export interface PostPickupResult {
  pickup: PickupSummary & { locationId: string; paymentIds: string[] };
  store: CashPickupStore;
}
