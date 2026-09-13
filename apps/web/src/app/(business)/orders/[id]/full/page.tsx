'use client';

import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, CreditCard, Lock, Printer, Share2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import {
  CARD_BRANDS,
  FINANCING_TERM_MONTHS,
  formatMoney,
  isFinancingMethod,
} from '@jetnine/shared';
import { orderNextSteps } from '@/lib/order-next-steps';
import { api, ApiError } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Breadcrumbs,
  Button,
  Card,
  DisplayStatusBadge,
  Field,
  FormActions,
  FormGrid,
  Input,
  KeyValue,
  LinkButton,
  PageHeader,
  SectionHeading,
  Select,
  Skeleton,
  Stack,
  StatGrid,
  StatTile,
  StatusBadge,
  TableWrap,
  Toolbar,
} from '@/components/ui';
import { SecurityOverrideDialog } from '@/components/security-override-dialog';
import { OrderNotesCard } from '@/components/order-notes-card';
import { TeamTasks } from '@/components/team-tasks';
import { ProductSearchDialog, type SearchRow } from '@/components/product-search-dialog';
import { OrderActionsMenu } from '../actions/actions-menu';
import { OrderHeaderDialog } from '../actions/header-dialog';
import { LineDetailsDialog } from '../actions/edit-dialogs';
import type { CostedLines, OpsLists } from '../actions/types';

/**
 * Order detail (STORIS cutover Day 2): the working view of one sales
 * order — lines with reservation state, money in vs balance due, and the
 * actions the store takes between writing an order and fulfilling it.
 * Fulfillment itself (deliveries, stock decrement, completion) is Day 3.
 */

interface OrderLine {
  id: string;
  variantId: string | null;
  description: string;
  quantity: number;
  qtyReserved: number;
  qtyFulfilled: number;
  qtyReturned: number;
  lineType: string;
  fulfillmentMethod: string | null;
  sourceLocationId: string | null;
  unitPriceCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  taxRateBps?: number;
  /** A20 line details (STORIS Step 2 actions). */
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
  /** The PO this line rides on, when sourced through purchasing (owner 2026-09-02). */
  po: {
    poId: string;
    poNumber: string;
    poStatus: string;
    ordered: number;
    received: number;
    expectedAt: string | null;
  } | null;
}
interface OrderPayment {
  id: string;
  kind: string;
  method: string;
  amountCents: number;
  status: string;
  processorRef: string | null;
  cardBrand: string | null;
  financingMonths: number | null;
  createdAt: string;
}
interface OrderDetail {
  /** P-013: the same display vocabulary the orders list shows. */
  displayStatus?: string;
  displayPoNumber?: string | null;
  id: string;
  number: string;
  status: string;
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
  creditDueCents: number;
  family: {
    id: string;
    number: string;
    status: string;
    totalCents: number;
    balanceDueCents: number;
    fulfillmentType: string;
    requestedDate: string | null;
    lines: {
      id: string;
      description: string;
      quantity: number;
      fulfillmentMethod: string | null;
    }[];
  }[];
  /** §10 exchanges written against this order. */
  exchangeOrders: {
    id: string;
    number: string;
    status: string;
    totalCents: number;
    createdAt: string;
  }[];
  orderKind: string;
  originalOrderId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressPhone: string | null;
  notes: string | null;
  internalNotes: string | null;
  /** A20 header fields (STORIS Step 1 + Actions). */
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
  deliveryFeeCents?: number;
  installFeeCents?: number;
  otherFeeCents?: number;
  otherFeeLabel?: string | null;
  salespersonMembershipId?: string | null;
  secondSalespersonMembershipId?: string | null;
  splitBps?: number | null;
  deliveryStatus?: string | null;
  deliveryInstructions?: string | null;
  pickupLocationId?: string | null;
  legacyNumber: string | null;
  lockedAt: string | null;
  onOpenRun: { runId: string; runDate: string } | null;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  lines: OrderLine[];
  payments: OrderPayment[];
}
interface CustomerRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  /** A22 slice 6 (STORIS customer panel). */
  customerNumber?: string | null;
  businessName?: string | null;
  contactName?: string | null;
  alternateName?: string | null;
  alternateRelationship?: string | null;
  deliveryInstructions?: string | null;
  phone2?: string | null;
  workPhone?: string | null;
  workPhoneExt?: string | null;
  addressesJson?:
    | {
        label?: string | null;
        line1?: string | null;
        line2?: string | null;
        city?: string | null;
        region?: string | null;
        postalCode?: string | null;
      }[]
    | null;
}
interface DeliveryRow {
  id: string;
  scheduledDate: string;
  status: string;
  windowStart: string | null;
  windowEnd: string | null;
  lines: { id: string; description: string; quantity: number }[];
}
interface ReturnableLine {
  id: string;
  description: string;
  qtyFulfilled: number;
  qtyReturned: number;
}

interface AuditRow {
  id: string;
  action: string;
  createdAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  changesJson: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } | null;
}

/** "$1,234.56" for *_cents fields, plain stringification otherwise. */
function formatAuditValue(field: string, value: unknown): string {
  if (value == null || value === '') return '—';
  if (/cents$/i.test(field) && typeof value === 'number') {
    return `$${(value / 100).toFixed(2)}`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The change-history line for one audit entry: each changed field with
 * its before → after values (PLAN-POS-OPERATIONS §8 — "every field
 * change attributed"). The audit service stores a minimal diff, so
 * every key present actually changed.
 */
function auditChanges(row: AuditRow): { field: string; from: string; to: string }[] {
  const before = row.changesJson?.before ?? {};
  const after = row.changesJson?.after ?? {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.map((field) => ({
    field,
    from: formatAuditValue(field, before[field]),
    to: formatAuditValue(field, after[field]),
  }));
}

/** Same tender list (and labels) as the New Sale register. */
const TENDERS = [
  { value: 'card', label: 'Credit card' },
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'synchrony', label: 'Synchrony' },
  { value: 'acima', label: 'Acima' },
  { value: 'store_credit', label: 'Store credit' },
] as const;

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [locationNames, setLocationNames] = useState<Map<string, string>>(new Map());
  const [locations, setLocations] = useState<{ id: string; name: string; locationType?: string }[]>(
    [],
  );
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [addSourceId, setAddSourceId] = useState('');
  // Backorder split: pick lines, give them their own promised date, and
  // they move to a new order.
  const [splitMode, setSplitMode] = useState(false);
  const [splitSel, setSplitSel] = useState<Set<string>>(new Set());
  const [splitDate, setSplitDate] = useState('');
  const [timeline, setTimeline] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  // Add-product price step (owner 2026-08-30): pick the product, set
  // the price it sells at, then the payment form pre-fills with the
  // charge so money can be taken on the new item immediately.
  const [pendingAdd, setPendingAdd] = useState<SearchRow | null>(null);
  const [addPrice, setAddPrice] = useState('');
  const [addQty, setAddQty] = useState('1');
  const [payMethod, setPayMethod] = useState<(typeof TENDERS)[number]['value']>('card');
  const [payRef, setPayRef] = useState('');
  /** Card tenders: brand subcategory — required before taking the payment. */
  const [payCardBrand, setPayCardBrand] = useState('');
  /** Synchrony/Acima tenders: months financed — required before taking the payment. */
  const [payMonths, setPayMonths] = useState('');
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [deliveryDate, setDeliveryDate] = useState('');
  const [dayCapacity, setDayCapacity] = useState<{ booked: number; cap: number } | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  // A20 (§12.16): the STORIS Actions menu and the line display toggles.
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [opsLists, setOpsLists] = useState<OpsLists>({});
  const [advanced, setAdvanced] = useState(false);
  const [costed, setCosted] = useState(false);
  const [costedData, setCostedData] = useState<CostedLines | null>(null);
  const [headerOpen, setHeaderOpen] = useState(false);
  const [lineDetailsId, setLineDetailsId] = useState<string | null>(null);
  const [members, setMembers] = useState<
    { membershipId: string; name: string | null; email: string }[]
  >([]);

  // §7: the associate sees the day's remaining capacity while booking.
  useEffect(() => {
    if (!deliveryDate) {
      setDayCapacity(null);
      return;
    }
    let stale = false;
    api<{ cap: number; days: { booked: number }[] }>(
      `/v1/deliveries/capacity?from=${deliveryDate}&to=${deliveryDate}`,
    )
      .then((r) => {
        if (!stale) setDayCapacity({ booked: r.days[0]?.booked ?? 0, cap: r.cap });
      })
      .catch(() => setDayCapacity(null));
    return () => {
      stale = true;
    };
  }, [deliveryDate]);

  async function load() {
    try {
      // Owner 2026-09-02 (#8): the store list does not depend on the order,
      // so it loads alongside it; everything keyed on the order fans out
      // the moment it lands. The skeleton below holds the layout meanwhile.
      const locationsReq = api<{ id: string; name: string; locationType?: string }[]>(
        '/v1/business/locations',
      )
        .then((locs) => {
          setLocations(locs);
          setLocationNames(new Map(locs.map((l) => [l.id, l.name])));
        })
        .catch(() => undefined);
      const o = await api<OrderDetail>(`/v1/orders/${id}`);
      setOrder(o);
      void locationsReq;
      void api<CustomerRow>(`/v1/customers/${o.customerId}`)
        .then(setCustomer)
        .catch(() => setCustomer(null));
      void api<DeliveryRow[]>(`/v1/deliveries?orderId=${o.id}`)
        .then(setDeliveries)
        .catch(() => setDeliveries([]));
      void api<{ id: string }[]>(`/v1/orders/${o.id}/attachments`)
        .then((rows) => setAttachmentCount(rows.length))
        .catch(() => undefined);
      if (costed) void loadCosted(o.id);
      // The audit log is the order's timeline: every mutation the API
      // makes writes an entry with targetId = the order id.
      void api<{ data: AuditRow[]; nextCursor: string | null }>(
        `/v1/audit-logs?targetType=order&targetId=${o.id}&limit=50`,
      )
        .then((r) => setTimeline(r.data))
        .catch(() => setTimeline([]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    if (id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    // A20 pick lists and the salesperson names the Order details card shows.
    void api<{ ops: OpsLists | null }>('/v1/business/settings/pos')
      .then((s) => setOpsLists(s.ops ?? {}))
      .catch(() => undefined);
    void api<{ membershipId: string; name: string | null; email: string; status: string }[]>(
      '/v1/business/members',
    )
      .then((rows) => setMembers(rows.filter((m) => m.status === 'active')))
      .catch(() => setMembers([]));
  }, []);

  /** Costed line display (A20): cost + margin per line, gated by products.cost.view. */
  async function loadCosted(orderId: string) {
    try {
      setCostedData(await api<CostedLines>(`/v1/orders/${orderId}/costed`));
    } catch (err) {
      setCosted(false);
      setCostedData(null);
      const status = (err as { status?: number }).status;
      toast.error(
        status === 403
          ? 'You need product cost access to see costed lines'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  }

  function lineExtras(l: OrderLine): string {
    const parts: string[] = [];
    parts.push(
      `Source: ${l.sourceLocationId ? (locationNames.get(l.sourceLocationId) ?? '—') : 'order default'}`,
    );
    parts.push(`Tax ${((l.taxRateBps ?? 0) / 100).toFixed(2)}%`);
    parts.push(`${l.qtyReserved}/${l.quantity} reserved`);
    if (l.room) parts.push(`Room: ${l.room}`);
    if (l.pieces) parts.push(`${l.pieces} piece${l.pieces === 1 ? '' : 's'}/unit`);
    if (l.prepCodes?.length) parts.push(`Prep: ${l.prepCodes.join(', ')}`);
    if (l.needsInstall) parts.push('Installation');
    if (l.comJson?.supplied) {
      parts.push(`COM${l.comJson.description ? `: ${l.comJson.description}` : ''}`);
    }
    const ds = l.directShipJson;
    if (ds && (ds.vendorName || ds.trackingNumber || ds.vendorOrderRef)) {
      parts.push(
        `Direct ship: ${[ds.vendorName, ds.vendorOrderRef, ds.trackingNumber, ds.expectedDate]
          .filter(Boolean)
          .join(' · ')}`,
      );
    }
    if (l.comment) parts.push(`“${l.comment}”`);
    return parts.join(' · ');
  }

  function costedCell(lineId: string): string {
    const c = costedData?.lines.find((x) => x.id === lineId);
    if (!c) return costedData ? ' · Cost —' : ' · Cost loading…';
    return ` · Cost ${c.costCents == null ? '—' : formatMoney(c.costCents)} · Margin ${
      c.marginCents == null ? '—' : formatMoney(c.marginCents)
    }${c.marginPct == null ? '' : ` (${c.marginPct.toFixed(1)}%)`}`;
  }

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/orders/${id}${path}`, {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function moveCredit(toOrderId: string, toNumber: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/orders/${id}/move-credit`, {
        method: 'POST',
        body: JSON.stringify({ toOrderId }),
      });
      toast.success(`Credit moved to ${toNumber}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function splitOrder() {
    if (splitSel.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ newOrder: { id: string; number: string } }>(
        `/v1/orders/${id}/split`,
        {
          method: 'POST',
          body: JSON.stringify({
            lines: [...splitSel].map((lineId) => ({ lineId })),
            requestedDate: splitDate || null,
          }),
        },
      );
      toast.success(
        `Split to ${result.newOrder.number} — money and balances updated on both orders.`,
      );
      setSplitMode(false);
      setSplitSel(new Set());
      setSplitDate('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // A parked draft becomes a live sale: the PATCH reserves stock and
  // re-runs the price-variance gate (G6), unlike the bare /reserve.
  async function confirmDraft() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'open' }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addLine(row: SearchRow, unitPriceCents: number, quantity: number) {
    setBusy(true);
    setError(null);
    try {
      const defaultSource = order?.stockLocationId ?? order?.locationId;
      const prevBalance = order?.balanceDueCents ?? 0;
      const detail = await api<{ balanceDueCents: number }>(`/v1/orders/${id}/lines`, {
        method: 'POST',
        body: JSON.stringify({
          variantId: row.variantId,
          quantity,
          unitPriceCents,
          sourceLocationId: addSourceId && addSourceId !== defaultSource ? addSourceId : undefined,
        }),
      });
      setPendingAdd(null);
      const deltaCents = Math.max(0, detail.balanceDueCents - prevBalance);
      if (deltaCents > 0) {
        // Pre-fill the payment form with exactly what the new item added
        // to the balance so taking the money is one click away.
        setPayAmount((deltaCents / 100).toFixed(2));
        toast.success(
          `Added ${row.productName} — payment form pre-filled with the ${(deltaCents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' })} it added.`,
        );
      } else {
        toast.success(`Added ${row.productName} — totals and stock updated.`);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Take-with hand-over (owner 2026-08-31): Complete on a live order
  // with take-with lines splits them to a -A sibling and completes it
  // when its stock and money are in. The server never errors for a
  // short or unpaid piece — it reports why, and the piece waits.
  async function completeTakeWith() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{
        takeWith?: { number: string; completed: boolean; reason: string | null };
      }>(`/v1/orders/${id}/complete`, { method: 'POST', body: JSON.stringify({}) });
      if (res.takeWith?.completed) {
        toast.success(`${res.takeWith.number} — taken with, paid, and completed.`);
      } else if (res.takeWith) {
        toast(`${res.takeWith.number} is waiting: ${res.takeWith.reason ?? 'not ready yet'}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // "+ Recycling" (owner 2026-08-31): same button as New Sale — one
  // untaxed fee line; each click counts one more unit on it.
  const [recyclingFeeCents, setRecyclingFeeCents] = useState(1050);
  useEffect(() => {
    api<{ ops: { recyclingFeeCents?: number | null } | null }>('/v1/business/settings/pos')
      .then((s2) => {
        if (s2.ops?.recyclingFeeCents != null) setRecyclingFeeCents(s2.ops.recyclingFeeCents);
      })
      .catch(() => undefined);
  }, []);
  async function addRecyclingFee() {
    if (!order) return;
    const fee = order.lines.find(
      (l) => l.lineType === 'custom' && l.description === 'Recycling Fee',
    );
    setBusy(true);
    try {
      if (fee) {
        await api(`/v1/orders/${id}/lines/${fee.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ quantity: fee.quantity + 1 }),
        });
      } else {
        await api(`/v1/orders/${id}/lines`, {
          method: 'POST',
          body: JSON.stringify({
            description: 'Recycling Fee',
            lineType: 'custom',
            quantity: 1,
            unitPriceCents: recyclingFeeCents,
          }),
        });
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Inline line editing (owner 2026-08-31: order lines look and work
  // like New Sale's). Inputs commit on blur; a failed edit reloads so
  // the boxes snap back to what the server holds.
  async function patchLineField(lineId: string, patch: Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`/v1/orders/${id}/lines/${lineId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      await load();
    } finally {
      setBusy(false);
    }
  }

  // Owner 2026-09-02 (#1): release ONE line's reservation, not the whole
  // order's. Same endpoint the Inventory page's Reserved popup uses.
  async function releaseLine(l: OrderLine) {
    if (
      !confirm(
        `Release the ${l.qtyReserved} reserved unit${l.qtyReserved === 1 ? '' : 's'} of "${l.description}" back to the shelf? The line stays on the order, unreserved.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api(`/v1/orders/${id}/lines/${l.id}/release`, { method: 'POST' });
      toast.success(`Released — ${l.description} is no longer holding stock.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(l: OrderLine) {
    if (
      !confirm(
        `Remove "${l.description}" from this order? Its reserved stock goes back to the shelf and the balance recalculates.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/orders/${id}/lines/${l.id}`, { method: 'DELETE' });
      toast.success('Line removed — totals and stock updated.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function takePayment() {
    const cents = Math.round(Number(payAmount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError('Enter a payment amount.');
      return;
    }
    // Subcategories the dashboards break tenders down by.
    if (payMethod === 'card' && !payCardBrand) {
      setError('Pick the card brand (Visa, Mastercard, …) before taking the payment.');
      return;
    }
    if (isFinancingMethod(payMethod) && !payMonths) {
      setError('Pick the months financed before taking the payment.');
      return;
    }
    await act('/payments', {
      method: payMethod,
      amountCents: cents,
      ...(payMethod === 'card' ? { cardBrand: payCardBrand } : {}),
      // A20 Step 4 Financing: Synchrony / Acima carry the provider and
      // the account / approval number the API already stores.
      ...(payMethod === 'synchrony' || payMethod === 'acima'
        ? {
            financingProvider: payMethod,
            financingMonths: Number(payMonths),
            ...(payRef.trim() ? { financingRef: payRef.trim() } : {}),
          }
        : payRef.trim()
          ? { processorRef: payRef.trim() }
          : {}),
    });
    setPayAmount('');
    setPayRef('');
    setPayCardBrand('');
    setPayMonths('');
  }

  if (error && !order) {
    return (
      <div>
        <PageHeader
          title="Order not found"
          eyebrow={<BackLink href="/orders">All orders</BackLink>}
        />
        <Alert
          tone="error"
          title="We couldn't open this order."
          action={
            <LinkButton href="/orders" variant="secondary" size="sm">
              ← Back to orders
            </LinkButton>
          }
        >
          {error}
        </Alert>
      </div>
    );
  }
  if (!order) return <OrderSkeleton />;

  const live = !order.completedAt && !order.cancelledAt;
  const depositOutstanding = Math.max(0, order.depositRequiredCents - order.paidCents);
  const editable = live && !order.lockedAt;

  return (
    <div>
      {/* P-024: a breadcrumb takes you back; the action row keeps one
          primary control. */}
      <PageHeader
        eyebrow={
          <Breadcrumbs items={[{ label: 'Orders', href: '/orders' }, { label: order.number }]} />
        }
        title={<span data-testid="order-number">{order.number}</span>}
        meta={
          <>
            <span data-testid="order-status" className="inline-flex">
              {/* P-013 (BA-0017): same badge words as the orders list. */}
              {order.displayStatus ? (
                <DisplayStatusBadge
                  displayStatus={order.displayStatus}
                  poNumber={order.displayPoNumber}
                />
              ) : (
                <StatusBadge status={order.status} />
              )}
            </span>
            {order.legacyNumber && <span className="muted">STORIS #{order.legacyNumber}</span>}
          </>
        }
        sub={
          <>
            {order.fulfillmentType}
            {order.requestedDate ? ` · promised ${order.requestedDate}` : ''} · written{' '}
            {new Date(order.createdAt).toLocaleString()}
          </>
        }
        actions={
          <>
            <OrderActionsMenu
              order={order}
              lines={order.lines}
              customer={customer}
              locations={locations}
              lists={opsLists}
              editable={editable}
              live={live}
              attachmentCount={attachmentCount}
              advanced={advanced}
              onToggleAdvanced={() => setAdvanced((v) => !v)}
              costed={costed}
              onToggleCosted={() => {
                if (costed) {
                  setCosted(false);
                  setCostedData(null);
                } else {
                  setCosted(true);
                  void loadCosted(order.id);
                }
              }}
              onChanged={load}
              onAttachmentsChanged={setAttachmentCount}
              onAuditLog={() =>
                document.getElementById('change-history')?.scrollIntoView({ behavior: 'smooth' })
              }
              onPrint={(scope) =>
                window.open(
                  `/print/orders/${id}/invoice${scope === 'order' ? '?scope=order' : ''}`,
                  '_blank',
                )
              }
            />
            <Button
              size="sm"
              variant="secondary"
              data-testid="share-status-link"
              onClick={async () => {
                try {
                  const res = await api<{ path: string }>(`/v1/orders/${id}/share`, {
                    method: 'POST',
                  });
                  const url = `${window.location.origin}${res.path}`;
                  await navigator.clipboard.writeText(url).catch(() => {});
                  toast.success('Status link copied — send it to the customer', {
                    description: url,
                  });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              <Share2 size={13} aria-hidden /> Share status link
            </Button>
            <span className="relative">
              <Button
                variant="primary"
                data-testid="order-documents-menu"
                aria-haspopup="menu"
                aria-expanded={docsOpen}
                onClick={() => setDocsOpen((v) => !v)}
              >
                <Printer size={13} aria-hidden /> Documents ▾
              </Button>
              {docsOpen && (
                // No shared dropdown-menu class exists yet; the popover
                // keeps its own chrome until one lands in globals.css.
                <span
                  role="menu"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '110%',
                    zIndex: 30,
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 170,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                    padding: 4,
                  }}
                >
                  {[
                    ['invoice', 'Invoice', 'print-invoice'],
                    ['invoice?scope=order', 'Invoice (this order only)', 'print-invoice-single'],
                    ['delivery-ticket', 'Delivery ticket', 'print-delivery-ticket'],
                    ['pick-list', 'Pick list', 'print-pick-list'],
                  ].map(([slug, label, testid]) => (
                    <Link
                      key={slug}
                      role="menuitem"
                      href={`/print/orders/${id}/${slug}`}
                      target="_blank"
                      data-testid={testid}
                      className="no-underline"
                      style={{
                        padding: '6px 10px',
                        fontSize: 13,
                        borderRadius: 6,
                        color: 'inherit',
                      }}
                      onClick={() => setDocsOpen(false)}
                    >
                      {label}
                    </Link>
                  ))}
                </span>
              )}
            </span>
          </>
        }
      />
      <NextStepBanner order={order} deliveries={deliveries} />
      {headerOpen && (
        <OrderHeaderDialog
          order={order}
          locations={locations}
          lists={opsLists}
          editable={editable}
          onClose={() => setHeaderOpen(false)}
          onSaved={load}
        />
      )}
      {lineDetailsId && (
        <LineDetailsDialog
          order={order}
          lines={order.lines}
          initialLineId={lineDetailsId}
          lists={opsLists}
          onClose={() => setLineDetailsId(null)}
          onSaved={load}
        />
      )}

      {order.onOpenRun && (
        <Alert
          tone="error"
          data-testid="run-locked-banner"
          action={
            <LinkButton href="/deliveries/dispatch" size="sm" variant="secondary">
              Dispatch →
            </LinkButton>
          }
        >
          <Truck size={14} aria-hidden className="mr-1 inline-block align-[-2px]" />
          <strong>On the {order.onOpenRun.runDate} delivery run</strong> — the goods are manifested
          against a truck, so this order is locked until the run closes out. Pull the stop off the
          run (with a reason) to edit it first.
        </Alert>
      )}

      {order.lockedAt && (
        <Alert
          tone="warning"
          data-testid="locked-banner"
          action={
            <Button
              size="sm"
              variant="secondary"
              data-testid="unlock-order"
              disabled={busy}
              onClick={() => setUnlockOpen(true)}
            >
              Unlock…
            </Button>
          }
        >
          <Lock size={14} aria-hidden className="mr-1 inline-block align-[-2px]" />
          <strong>Locked</strong> — the delivery ticket was printed{' '}
          {new Date(order.lockedAt).toLocaleString()}. No edits while it&apos;s on the truck.
        </Alert>
      )}

      <SecurityOverrideDialog
        open={unlockOpen}
        title={`Unlock order ${order.number}`}
        usageClass="exception"
        submitLabel="Unlock order"
        perform={(payload) =>
          api(`/v1/orders/${id}/unlock`, { method: 'POST', body: JSON.stringify(payload) }).then(
            () => undefined,
          )
        }
        onClose={() => setUnlockOpen(false)}
        onSuccess={() => void load()}
      />

      {showAddProduct && (
        <ProductSearchDialog
          locationId={addSourceId || (order.stockLocationId ?? order.locationId)}
          locationName={
            locationNames.get(addSourceId || (order.stockLocationId ?? order.locationId)) ?? null
          }
          locations={locations}
          storeId={order.locationId}
          onChangeLocation={(locId) => setAddSourceId(locId)}
          onAdd={(row) => {
            setShowAddProduct(false);
            setPendingAdd(row);
            setAddPrice((row.priceCents / 100).toFixed(2));
            setAddQty('1');
          }}
          onClose={() => setShowAddProduct(false)}
        />
      )}

      {pendingAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="add-price-dialog"
        >
          <Card
            className="w-full max-w-[420px]"
            title={
              <>
                Add {pendingAdd.productName}
                {pendingAdd.variantName ? ` — ${pendingAdd.variantName}` : ''}
              </>
            }
            description={
              <>
                Set the price it sells at (list <Money cents={pendingAdd.priceCents} />
                ). The payment form pre-fills with the charge after it&apos;s added.
              </>
            }
          >
            <FormGrid cols={2}>
              <Field label="Unit price ($)">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={addPrice}
                  onChange={(e) => setAddPrice(e.target.value)}
                  data-testid="add-line-price"
                  autoFocus
                />
              </Field>
              <Field label="Quantity">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={addQty}
                  onChange={(e) => setAddQty(e.target.value)}
                  data-testid="add-line-qty"
                />
              </Field>
            </FormGrid>
            <FormActions>
              <Button variant="ghost" onClick={() => setPendingAdd(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || !(Number(addPrice) >= 0) || !(Number(addQty) >= 1)}
                data-testid="add-line-confirm"
                onClick={() =>
                  void addLine(
                    pendingAdd,
                    Math.round(Number(addPrice) * 100),
                    Math.max(1, Math.round(Number(addQty))),
                  )
                }
              >
                Add to order
              </Button>
            </FormActions>
          </Card>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Stack className="min-w-0">
          <Card
            title="Lines"
            actions={
              editable ? (
                <>
                  {order.lines.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setSplitMode((v) => !v);
                        setSplitSel(new Set());
                      }}
                      data-testid="split-order"
                    >
                      {splitMode ? 'Cancel split' : 'Split order…'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void addRecyclingFee()}
                    data-testid="order-add-recycling"
                  >
                    + Recycling (${(recyclingFeeCents / 100).toFixed(2)})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    data-testid="order-add-declined-foundation"
                    onClick={async () => {
                      // Owner 2026-08-31: no-charge documentation line,
                      // same as New Sale's button.
                      setBusy(true);
                      try {
                        await api(`/v1/orders/${id}/lines`, {
                          method: 'POST',
                          body: JSON.stringify({
                            description: 'Client Declined New Foundation',
                            lineType: 'custom',
                            quantity: 1,
                            unitPriceCents: 0,
                          }),
                        });
                        await load();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : String(err));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    + Declined foundation ($0)
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      // Goods come off the truck: Add Product defaults to
                      // the warehouse for everyone (owner 2026-08-30).
                      const wh =
                        locations.find((l) => l.locationType === 'warehouse') ??
                        locations.find((l) => /warehouse|whse|\bwh\b/i.test(l.name));
                      setAddSourceId(wh?.id ?? order.stockLocationId ?? order.locationId);
                      setShowAddProduct(true);
                    }}
                    data-testid="order-add-product"
                  >
                    Add product
                  </Button>
                </>
              ) : undefined
            }
          >
            {splitMode && (
              <Toolbar
                data-testid="split-bar"
                end={
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || splitSel.size === 0}
                    onClick={() => void splitOrder()}
                    data-testid="split-confirm"
                  >
                    Split {splitSel.size || ''} line{splitSel.size === 1 ? '' : 's'} to a new order
                  </Button>
                }
              >
                <span className="muted">
                  Tick the backordered lines — they move to a new order with its own promised date.
                  Payments stay here.
                </span>
                <Field label="New promised date">
                  <Input
                    type="date"
                    value={splitDate}
                    onChange={(e) => setSplitDate(e.target.value)}
                    data-testid="split-date"
                  />
                </Field>
              </Toolbar>
            )}
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Type</th>
                    <th>Qty</th>
                    <th>Price $</th>
                    <th>Disc $</th>
                    <th>Fulfillment</th>
                    <th>Inventory from</th>
                    <th>Stock</th>
                    <th className="num">Amount</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l) => (
                    <Fragment key={l.id}>
                      <tr>
                        <td>
                          {splitMode && l.quantity - l.qtyFulfilled > 0 && (
                            <input
                              type="checkbox"
                              checked={splitSel.has(l.id)}
                              className="mr-2 accent-brand"
                              aria-label={`Split ${l.description} to a new order`}
                              data-testid="split-line"
                              onChange={(e) => {
                                setSplitSel((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(l.id);
                                  else next.delete(l.id);
                                  return next;
                                });
                              }}
                            />
                          )}
                          {l.description}
                        </td>
                        <td>
                          {l.lineType === 'custom' ? (
                            'custom'
                          ) : ['open', 'partially_fulfilled', 'draft', 'quote'].includes(
                              order.status,
                            ) && l.qtyFulfilled === 0 ? (
                            // PO-060: the type stays changeable on an open
                            // line — e.g. flip to direct ship when the
                            // vendor will deliver straight to the customer.
                            <Select
                              value={l.lineType}
                              aria-label={`Line type for ${l.description}`}
                              onChange={async (e) => {
                                try {
                                  await api(`/v1/orders/${id}/lines/${l.id}`, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ lineType: e.target.value }),
                                  });
                                  await load();
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : String(err));
                                }
                              }}
                            >
                              <option value="stock">stock</option>
                              <option value="special_order">special order</option>
                              <option value="direct_ship">direct ship</option>
                            </Select>
                          ) : l.lineType === 'special_order' ? (
                            <span className="text-warning">special order</span>
                          ) : l.lineType === 'direct_ship' ? (
                            <span
                              className="text-info"
                              title="The vendor ships straight to the customer"
                            >
                              direct ship
                            </span>
                          ) : (
                            'stock'
                          )}
                        </td>
                        <td>
                          {editable ? (
                            <Input
                              key={`qty-${l.id}-${l.quantity}`}
                              type="number"
                              min={1}
                              defaultValue={l.quantity}
                              onBlur={(e) => {
                                const qty = Math.round(Number(e.target.value));
                                if (Number.isFinite(qty) && qty >= 1 && qty !== l.quantity)
                                  void patchLineField(l.id, { quantity: qty });
                              }}
                              className="w-16"
                              aria-label={`Quantity for ${l.description}`}
                              data-testid="order-line-qty"
                            />
                          ) : (
                            l.quantity
                          )}
                        </td>
                        <td>
                          {editable ? (
                            <Input
                              key={`price-${l.id}-${l.unitPriceCents}`}
                              type="number"
                              step="0.01"
                              min={0}
                              defaultValue={(l.unitPriceCents / 100).toFixed(2)}
                              onBlur={(e) => {
                                const cents = Math.round(Number(e.target.value) * 100);
                                if (
                                  Number.isFinite(cents) &&
                                  cents >= 0 &&
                                  cents !== l.unitPriceCents
                                )
                                  void patchLineField(l.id, { unitPriceCents: cents });
                              }}
                              className="w-24"
                              aria-label={`Unit price for ${l.description}`}
                              data-testid="order-line-price"
                            />
                          ) : (
                            <Money cents={l.unitPriceCents} />
                          )}
                        </td>
                        <td>
                          {editable ? (
                            <Input
                              key={`disc-${l.id}-${l.discountCents}`}
                              type="number"
                              step="0.01"
                              min={0}
                              placeholder="0.00"
                              defaultValue={
                                l.discountCents ? (l.discountCents / 100).toFixed(2) : ''
                              }
                              onBlur={(e) => {
                                const cents = Math.round(Number(e.target.value || '0') * 100);
                                if (
                                  Number.isFinite(cents) &&
                                  cents >= 0 &&
                                  cents !== l.discountCents
                                )
                                  void patchLineField(l.id, { lineDiscountCents: cents });
                              }}
                              className="w-20"
                              aria-label={`Discount for ${l.description}`}
                              data-testid="order-line-disc"
                            />
                          ) : l.discountCents > 0 ? (
                            <Money cents={l.discountCents} />
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {l.lineType === 'custom' ? (
                            <span className="muted">fee</span>
                          ) : editable ? (
                            <Select
                              value={l.fulfillmentMethod ?? ''}
                              onChange={(e) =>
                                void patchLineField(l.id, {
                                  fulfillmentMethod: e.target.value || null,
                                })
                              }
                              className="w-32"
                              aria-label={`Fulfillment for ${l.description}`}
                              data-testid="order-line-fulfillment"
                            >
                              <option value="">Same as order</option>
                              <option value="delivery">Delivery</option>
                              <option value="pickup">Customer pickup</option>
                              <option value="take_with">Take-with</option>
                              <option value="direct_ship">Direct ship</option>
                            </Select>
                          ) : l.fulfillmentMethod ? (
                            l.fulfillmentMethod.replace(/_/g, ' ')
                          ) : (
                            'Same as order'
                          )}
                        </td>
                        <td>
                          {l.lineType === 'custom' ? (
                            <span className="muted">—</span>
                          ) : editable ? (
                            <Select
                              value={
                                l.sourceLocationId ?? order.stockLocationId ?? order.locationId
                              }
                              onChange={(e) => {
                                const fallback = order.stockLocationId ?? order.locationId;
                                void patchLineField(l.id, {
                                  sourceLocationId:
                                    e.target.value === fallback ? null : e.target.value,
                                });
                              }}
                              className="w-36"
                              aria-label={`Inventory source for ${l.description}`}
                              data-testid="order-line-source"
                            >
                              {[...locations]
                                .sort((a, b) =>
                                  a.locationType === b.locationType
                                    ? a.name.localeCompare(b.name)
                                    : a.locationType === 'warehouse'
                                      ? -1
                                      : 1,
                                )
                                .map((loc) => (
                                  <option key={loc.id} value={loc.id}>
                                    {loc.name}
                                    {loc.locationType === 'warehouse' ? ' (WH)' : ''}
                                  </option>
                                ))}
                            </Select>
                          ) : (
                            (locationNames.get(
                              l.sourceLocationId ?? order.stockLocationId ?? order.locationId,
                            ) ?? '—')
                          )}
                        </td>
                        <td>
                          <StockCell
                            line={l}
                            canRelease={Boolean(editable && !order.onOpenRun)}
                            busy={busy}
                            onRelease={() => void releaseLine(l)}
                          />
                        </td>
                        <td className="num">
                          <Money cents={l.totalCents} />
                        </td>
                        <td className="actions">
                          {live && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setLineDetailsId(l.id)}
                              aria-label={`Details for ${l.description}`}
                              title="Line details — comment, room, pieces, prep codes, COM, direct ship"
                              data-testid="order-line-details"
                            >
                              ⋯
                            </Button>
                          )}
                          {editable && l.qtyFulfilled === 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void removeLine(l)}
                              disabled={busy}
                              aria-label={`Remove ${l.description}`}
                              title="Remove line (releases its reserved stock)"
                              data-testid="order-remove-line"
                            >
                              ✕
                            </Button>
                          )}
                        </td>
                      </tr>
                      {(advanced || costed) && (
                        <tr data-testid="line-extras">
                          <td colSpan={10} className="muted" style={{ fontSize: 12 }}>
                            {advanced ? lineExtras(l) : ''}
                            {costed ? costedCell(l.id) : ''}
                          </td>
                        </tr>
                      )}
                      {l.lineType === 'stock' &&
                        !l.po &&
                        l.quantity - l.qtyFulfilled - l.qtyReserved > 0 && (
                          <tr>
                            <td
                              colSpan={10}
                              className="text-warning"
                              data-testid="order-line-short"
                            >
                              {l.quantity - l.qtyFulfilled - l.qtyReserved} not reserved — not in
                              stock at the selected source location.
                            </td>
                          </tr>
                        )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          {(order.family ?? []).length > 0 && <SplitOrdersCard order={order} />}

          <Card title="Payments" id="payments-card">
            {order.payments.length === 0 ? (
              <p className="muted">No money taken yet.</p>
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Kind</th>
                      <th>Method</th>
                      <th>Reference</th>
                      <th>Status</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.payments.map((p) => (
                      <tr key={p.id}>
                        <td>{new Date(p.createdAt).toLocaleString()}</td>
                        <td>{p.kind}</td>
                        <td>
                          {TENDERS.find((t) => t.value === p.method)?.label ?? p.method}
                          {p.cardBrand
                            ? ` · ${CARD_BRANDS.find((b) => b.value === p.cardBrand)?.label ?? p.cardBrand}`
                            : p.financingMonths
                              ? ` · ${p.financingMonths} mo`
                              : ''}
                        </td>
                        <td className="muted">{p.processorRef ?? '—'}</td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="num">
                          <Money cents={p.amountCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            {live && (
              <>
                <SectionHeading as="h3" title="New payment" />
                <FormGrid cols={3}>
                  <Field label="Method">
                    <Select
                      value={payMethod}
                      onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}
                      data-testid="order-pay-method"
                    >
                      {TENDERS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Amount ($)">
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      placeholder={
                        depositOutstanding > 0
                          ? (depositOutstanding / 100).toFixed(2)
                          : (order.balanceDueCents / 100).toFixed(2)
                      }
                      data-testid="payment-amount"
                    />
                  </Field>
                  {payMethod === 'card' && (
                    <Field label="Card brand">
                      <Select
                        value={payCardBrand}
                        onChange={(e) => setPayCardBrand(e.target.value)}
                        data-testid="payment-card-brand"
                      >
                        <option value="">Pick brand…</option>
                        {CARD_BRANDS.map((b) => (
                          <option key={b.value} value={b.value}>
                            {b.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {(payMethod === 'synchrony' || payMethod === 'acima') && (
                    <Field label="Months financed">
                      <Select
                        value={payMonths}
                        onChange={(e) => setPayMonths(e.target.value)}
                        data-testid="payment-months"
                      >
                        <option value="">Pick term…</option>
                        {FINANCING_TERM_MONTHS.map((m) => (
                          <option key={m} value={m}>
                            {m} months
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {payMethod !== 'cash' && (
                    <Field
                      label={
                        payMethod === 'synchrony' || payMethod === 'acima'
                          ? 'Financing account / approval #'
                          : 'Reference'
                      }
                    >
                      <Input
                        placeholder="Reference / last 4 / approval #"
                        value={payRef}
                        onChange={(e) => setPayRef(e.target.value)}
                        data-testid="payment-ref"
                      />
                    </Field>
                  )}
                </FormGrid>
                <FormActions
                  start={
                    depositOutstanding > 0 ? (
                      <span className="text-warning">
                        Deposit outstanding: {formatMoney(depositOutstanding)}
                      </span>
                    ) : undefined
                  }
                >
                  {order.balanceDueCents > 0 && (
                    <Button
                      variant="secondary"
                      onClick={() => setPayAmount((order.balanceDueCents / 100).toFixed(2))}
                    >
                      Exact balance
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    onClick={() => void takePayment()}
                    disabled={busy}
                    data-testid="take-payment"
                  >
                    <CreditCard size={14} aria-hidden />
                    {order.paidCents === 0 ? 'Take deposit' : 'Take payment'}
                  </Button>
                </FormActions>
              </>
            )}
          </Card>

          {live && (
            <PaymentPlanCard
              orderId={order.id}
              orderKind={order.orderKind}
              balanceDueCents={order.balanceDueCents}
              onChanged={load}
            />
          )}

          {(() => {
            // Mixed fulfillment: a line's effective method is its own
            // override, else the order's type. Counter lines hand over
            // here; only delivery-bound lines ride the truck (the server
            // enforces the same split when scheduling).
            const effective = (l: OrderLine) => l.fulfillmentMethod ?? order.fulfillmentType;
            const counterLines = order.lines.filter(
              (l) =>
                l.lineType !== 'custom' &&
                l.lineType !== 'direct_ship' &&
                (effective(l) === 'take_with' || effective(l) === 'pickup') &&
                l.quantity - l.qtyFulfilled > 0,
            );
            const counterUnits = counterLines.reduce(
              (n, l) => n + (l.quantity - l.qtyFulfilled),
              0,
            );
            const truckLines = order.lines.filter(
              (l) =>
                l.lineType !== 'custom' &&
                l.lineType !== 'direct_ship' &&
                effective(l) === 'delivery',
            );
            // Owner 2026-09-02 (#7): a pure take-with order never rides the
            // truck — one line instead of an empty card.
            if (truckLines.length === 0 && counterLines.length === 0 && deliveries.length === 0) {
              return (
                <CollapsedCard title="Deliveries & fulfillment" testid="deliveries-collapsed">
                  Nothing rides the truck on this order — take-with items hand over from Complete
                  take-with on the right.
                </CollapsedCard>
              );
            }
            return (
              <Card title="Deliveries & fulfillment">
                {deliveries.length === 0 ? (
                  <p className="muted">
                    {order.fulfillmentType === 'pickup'
                      ? 'Pickup order — hand over the goods below when the customer arrives.'
                      : 'Nothing scheduled yet.'}
                  </p>
                ) : (
                  <ul className="grid gap-1">
                    {deliveries.map((dv) => (
                      <li key={dv.id}>
                        <Link href={`/deliveries/${dv.id}`}>
                          {dv.scheduledDate}
                          {dv.windowStart ? ` ${dv.windowStart.slice(0, 5)}` : ''}
                        </Link>{' '}
                        — {dv.status.replace(/_/g, ' ')} ·{' '}
                        {dv.lines.reduce((s, l) => s + l.quantity, 0)} unit(s)
                        {['scheduled', 'loaded'].includes(dv.status) && (
                          <>
                            {' · '}
                            <Input
                              key={`resched-${dv.id}-${dv.scheduledDate}`}
                              type="date"
                              defaultValue={dv.scheduledDate}
                              onBlur={async (e) => {
                                const date = e.target.value;
                                if (!date || date === dv.scheduledDate) return;
                                // Owner 2026-08-31: New Sale books the
                                // delivery; date changes happen here.
                                setBusy(true);
                                try {
                                  await api(`/v1/deliveries/${dv.id}`, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ scheduledDate: date }),
                                  });
                                  toast.success(`Delivery moved to ${date}`);
                                  await load();
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : String(err));
                                  await load();
                                } finally {
                                  setBusy(false);
                                }
                              }}
                              className="w-36"
                              aria-label="Change the delivery date"
                              data-testid="reschedule-delivery-date"
                            />
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {live &&
                  order.status !== 'quote' &&
                  (order.fulfillmentType === 'delivery' ? (
                    <>
                      <SectionHeading as="h3" title="Book a delivery" />
                      <FormGrid cols={3}>
                        <Field label="Delivery date">
                          <Input
                            type="date"
                            value={deliveryDate}
                            onChange={(e) => setDeliveryDate(e.target.value)}
                            data-testid="delivery-date"
                          />
                        </Field>
                      </FormGrid>
                      <FormActions
                        start={
                          <>
                            {dayCapacity && (
                              <span
                                className={`badge badge-${
                                  dayCapacity.booked >= dayCapacity.cap ? 'danger' : 'info'
                                }`}
                                data-testid="capacity-hint"
                              >
                                {dayCapacity.booked}/{dayCapacity.cap} stops booked
                              </span>
                            )}
                            {counterUnits > 0 && (
                              <span className="muted" data-testid="counter-lines-hint">
                                {counterUnits} unit{counterUnits === 1 ? '' : 's'} marked
                                take-with/pickup stay off the truck — use{' '}
                                <strong>Complete take-with items</strong> in the actions to hand
                                them over.
                              </span>
                            )}
                          </>
                        }
                      >
                        <Button
                          variant="primary"
                          onClick={async () => {
                            if (!deliveryDate) {
                              setError('Pick a delivery date first.');
                              return;
                            }
                            // Over-cap booking is allowed but deliberate:
                            // the 409 becomes a confirm, and the retry
                            // carries the override flag (logged to the
                            // owner feed server-side).
                            setBusy(true);
                            setError(null);
                            try {
                              await api(`/v1/orders/${id}/deliveries`, {
                                method: 'POST',
                                body: JSON.stringify({ scheduledDate: deliveryDate }),
                              });
                              await load();
                            } catch (err) {
                              const msg = err instanceof Error ? err.message : String(err);
                              if (
                                err instanceof ApiError &&
                                err.code === 'OVER_CAPACITY' &&
                                window.confirm(`${msg}\n\nBook beyond the cap anyway?`)
                              ) {
                                try {
                                  await api(`/v1/orders/${id}/deliveries`, {
                                    method: 'POST',
                                    body: JSON.stringify({
                                      scheduledDate: deliveryDate,
                                      confirmOverCapacity: true,
                                    }),
                                  });
                                  await load();
                                } catch (err2) {
                                  setError(err2 instanceof Error ? err2.message : String(err2));
                                }
                              } else {
                                setError(msg);
                              }
                            } finally {
                              setBusy(false);
                            }
                          }}
                          disabled={busy}
                          data-testid="schedule-delivery"
                        >
                          <Truck size={14} aria-hidden />
                          Schedule delivery
                        </Button>
                      </FormActions>
                    </>
                  ) : (
                    <FormActions>
                      <Button
                        variant="primary"
                        onClick={() => void act('/fulfill', {})}
                        disabled={busy}
                        data-testid="fulfill-pickup"
                      >
                        Hand over the goods (pickup)
                      </Button>
                    </FormActions>
                  ))}
              </Card>
            );
          })()}

          <ReturnsCard order={order} busy={busy} onChanged={load} />
          <ExchangesCard order={order} />

          <TeamTasks orderId={order.id} orderNumber={order.number} />
          <OrderNotesCard orderId={order.id} />

          <Card title="Change history" id="change-history">
            {timeline.length === 0 ? (
              <p className="muted">No events recorded.</p>
            ) : (
              <ul className="grid gap-1.5" data-testid="order-timeline">
                {timeline.map((t) => {
                  const changes = auditChanges(t);
                  return (
                    <li key={t.id}>
                      <span className="text-secondary">
                        {new Date(t.createdAt).toLocaleString()}
                      </span>{' '}
                      — {t.action.replace('order.', '').replace(/[._]/g, ' ')}
                      {t.actorEmail && <span className="muted"> by {t.actorEmail}</span>}
                      {changes.length > 0 && (
                        <ul className="text-secondary mt-0.5 pl-3.5 text-xs">
                          {changes.map((c) => (
                            <li key={c.field}>
                              {c.field}: {c.from} → {c.to}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </Stack>

        <Stack className="min-w-0">
          <BalanceStrip order={order} />
          <Card
            title="Order details"
            actions={
              live ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setHeaderOpen(true)}
                  data-testid="order-details-edit"
                >
                  Edit…
                </Button>
              ) : undefined
            }
          >
            <KeyValue
              rows={[
                { label: 'Order type', value: order.orderKind.replace(/_/g, ' ') },
                { label: 'Written', value: new Date(order.createdAt).toLocaleDateString() },
                { label: 'Store', value: locationNames.get(order.locationId) ?? '—' },
                {
                  label: 'Salesperson',
                  value:
                    [order.salespersonMembershipId, order.secondSalespersonMembershipId]
                      .filter(Boolean)
                      .map((mid) => {
                        const m = members.find((x) => x.membershipId === mid);
                        return m ? m.name || m.email : '—';
                      })
                      .join(' + ') || '—',
                },
                { label: 'Fulfillment', value: order.fulfillmentType.replace(/_/g, ' ') },
                { label: 'Promised', value: order.requestedDate ?? '—' },
                {
                  label: 'Marketing codes',
                  value:
                    [order.marketingCode, order.marketingCode2].filter(Boolean).join(' · ') || '—',
                },
                { label: 'Order source', value: order.orderSource ?? '—' },
                { label: 'Payment terminal', value: order.paymentTerminal ?? '—' },
                ...(order.tradeDesignerJson?.name || order.tradeDesignerJson?.company
                  ? [
                      {
                        label: 'Trade / designer',
                        value: [order.tradeDesignerJson.name, order.tradeDesignerJson.company]
                          .filter(Boolean)
                          .join(' — '),
                      },
                    ]
                  : []),
                ...(order.customInfoJson?.length
                  ? [
                      {
                        label: 'Custom info',
                        value: `${order.customInfoJson.length} row${
                          order.customInfoJson.length === 1 ? '' : 's'
                        }`,
                      },
                    ]
                  : []),
              ]}
            />
          </Card>

          <Card
            title="Customer"
            actions={
              customer ? (
                <LinkButton size="sm" variant="secondary" href={`/customers/${customer.id}`}>
                  Open
                </LinkButton>
              ) : undefined
            }
          >
            {customer ? (
              <KeyValue
                rows={[
                  {
                    label: 'Name',
                    value: (
                      <Link href={`/customers/${customer.id}`}>
                        <strong>
                          {[customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
                            '(no name)'}
                        </strong>
                      </Link>
                    ),
                  },
                  { label: 'Contact', value: customer.email ?? customer.phone ?? '—' },
                  ...(customer.customerNumber
                    ? [{ label: 'Customer #', value: <code>{customer.customerNumber}</code> }]
                    : []),
                  ...(customer.businessName || customer.contactName
                    ? [
                        {
                          label: 'Business',
                          value: [customer.businessName, customer.contactName]
                            .filter(Boolean)
                            .join(' · '),
                        },
                      ]
                    : []),
                  ...(customer.alternateName
                    ? [
                        {
                          label: 'Alternate',
                          value: `${customer.alternateName}${customer.alternateRelationship ? ` (${customer.alternateRelationship})` : ''}`,
                        },
                      ]
                    : []),
                  ...(customer.deliveryInstructions
                    ? [{ label: 'Delivery instructions', value: customer.deliveryInstructions }]
                    : []),
                  ...(order.fulfillmentType === 'delivery' && order.addressLine1
                    ? [
                        {
                          label: 'Deliver to',
                          value: (
                            <>
                              {order.addressLine1}
                              {order.addressLine2 ? <>, {order.addressLine2}</> : null}
                              <br />
                              {[order.addressCity, order.addressRegion, order.addressPostalCode]
                                .filter(Boolean)
                                .join(', ')}
                              {order.addressPhone ? (
                                <>
                                  <br />
                                  {order.addressPhone}
                                </>
                              ) : null}
                            </>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            ) : (
              <p className="muted">Loading customer…</p>
            )}
          </Card>

          <Card title="Money">
            <Stack gap="sm">
              <KeyValue
                rows={[
                  { label: 'Subtotal', value: <MoneyValue cents={order.subtotalCents} /> },
                  { label: 'Discount', value: <MoneyValue cents={-order.discountCents} /> },
                  { label: 'Tax', value: <MoneyValue cents={order.taxCents} /> },
                  {
                    label: <strong>Total</strong>,
                    value: <MoneyValue cents={order.totalCents} bold />,
                  },
                ]}
              />
              <hr className="border-border" />
              <KeyValue
                rows={[
                  {
                    label: 'Deposit required',
                    value: <MoneyValue cents={order.depositRequiredCents} />,
                  },
                  { label: 'Paid', value: <MoneyValue cents={order.paidCents} /> },
                  {
                    label: <strong>Balance due</strong>,
                    value: (
                      <span data-testid="balance-due">
                        <MoneyValue cents={order.balanceDueCents} bold />
                      </span>
                    ),
                  },
                  ...(order.creditDueCents > 0
                    ? [
                        {
                          label: <strong className="text-danger">Overpaid — credit</strong>,
                          value: (
                            <span data-testid="credit-due" className="text-danger">
                              <MoneyValue cents={order.creditDueCents} bold />
                            </span>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
              <hr className="border-border" />
              <KeyValue
                data-testid="receivables"
                rows={[
                  {
                    label: <strong>Receivables</strong>,
                    value: order.balanceDueCents > 0 ? 'Open' : 'Settled',
                  },
                  {
                    label: 'Deposit outstanding',
                    value: <MoneyValue cents={depositOutstanding} />,
                  },
                  {
                    label: 'Days outstanding',
                    value:
                      order.balanceDueCents > 0
                        ? String(
                            Math.max(
                              0,
                              Math.floor(
                                (Date.now() -
                                  new Date(order.completedAt ?? order.createdAt).getTime()) /
                                  86_400_000,
                              ),
                            ),
                          )
                        : '—',
                  },
                  {
                    label: 'Fees in total',
                    value: (
                      <MoneyValue
                        cents={
                          (order.deliveryFeeCents ?? 0) +
                          (order.installFeeCents ?? 0) +
                          (order.otherFeeCents ?? 0)
                        }
                      />
                    ),
                  },
                ]}
              />
              {live &&
                order.creditDueCents > 0 &&
                (order.family ?? [])
                  .filter((f) => f.balanceDueCents > 0)
                  .map((f) => (
                    <Button
                      key={f.id}
                      variant="secondary"
                      onClick={() => void moveCredit(f.id, f.number)}
                      disabled={busy}
                      data-testid={`move-credit-${f.number}`}
                      className="w-full"
                    >
                      Move credit to {f.number} (owes <Money cents={f.balanceDueCents} />)
                    </Button>
                  ))}
              {(order.family ?? []).length > 0 && (
                <KeyValue
                  data-testid="split-family"
                  rows={[
                    {
                      label: 'Split family',
                      value: (order.family ?? []).map((f, i) => (
                        <span key={f.id}>
                          {i > 0 ? ' · ' : ''}
                          <Link href={`/orders/${f.id}`}>{f.number}</Link>
                        </span>
                      )),
                    },
                  ]}
                />
              )}
            </Stack>
          </Card>

          {live && (
            <Card title="Actions">
              <Stack gap="sm">
                {error && <Alert tone="error">{error}</Alert>}
                {order.status === 'draft' && (
                  <Button
                    variant="primary"
                    onClick={() => void confirmDraft()}
                    disabled={busy}
                    data-testid="confirm-draft"
                  >
                    <CheckCircle2 size={14} aria-hidden />
                    Confirm order — make it a live sale
                  </Button>
                )}
                {order.status === 'quote' && (
                  <Button
                    variant="primary"
                    onClick={() => void act('/reserve')}
                    disabled={busy}
                    data-testid="confirm-reserve"
                  >
                    Confirm order (commit stock)
                  </Button>
                )}
                {(() => {
                  // Take-with hand-over (owner 2026-08-31): visible while
                  // any take-with unit is still owed on a live order.
                  if (!['open', 'partially_fulfilled'].includes(order.status)) return null;
                  const tw = order.lines.filter(
                    (l) =>
                      l.lineType !== 'direct_ship' &&
                      (l.fulfillmentMethod ?? order.fulfillmentType) === 'take_with' &&
                      l.quantity - l.qtyFulfilled - l.qtyReturned > 0,
                  );
                  if (tw.length === 0) return null;
                  const pureTakeWith = order.lines.every(
                    (l) =>
                      l.lineType === 'custom' ||
                      (l.fulfillmentMethod ?? order.fulfillmentType) === 'take_with',
                  );
                  const shortUnits = tw
                    .filter((l) => l.variantId && l.lineType !== 'custom')
                    .reduce(
                      (n, l) => n + Math.max(0, l.quantity - l.qtyFulfilled - l.qtyReserved),
                      0,
                    );
                  const waiting: string[] = [];
                  if (pureTakeWith) {
                    if (shortUnits > 0)
                      waiting.push(
                        `${shortUnits} unit${shortUnits === 1 ? '' : 's'} not in stock at the source — a user with inventory access must adjust them in`,
                      );
                    if (order.balanceDueCents > 0)
                      waiting.push(`$${(order.balanceDueCents / 100).toFixed(2)} still due`);
                  }
                  return (
                    <>
                      {waiting.length > 0 && (
                        <Alert tone="warning" data-testid="take-with-waiting">
                          Take-with — waiting on: {waiting.join('; ')}. Then hit Complete.
                        </Alert>
                      )}
                      <Button
                        variant="primary"
                        onClick={() => void completeTakeWith()}
                        disabled={busy}
                        data-testid="complete-take-with"
                      >
                        <CheckCircle2 size={14} aria-hidden />
                        Complete take-with item{tw.length === 1 ? '' : 's'}
                      </Button>
                    </>
                  );
                })()}
                {order.status === 'fulfilled' && (
                  <Button
                    variant="primary"
                    onClick={() => void act('/complete', {})}
                    disabled={busy || order.balanceDueCents > 0}
                    data-testid="complete-order"
                    title={
                      order.balanceDueCents > 0
                        ? 'Collect the balance first'
                        : 'Close the book on this order'
                    }
                  >
                    <CheckCircle2 size={14} aria-hidden />
                    Complete order
                  </Button>
                )}
                {order.status === 'fulfilled' && order.balanceDueCents > 0 && (
                  <Button
                    variant="secondary"
                    onClick={() => void act('/complete', { allowBalance: true })}
                    disabled={busy}
                    data-testid="complete-with-balance"
                  >
                    Complete with balance due (AR)
                  </Button>
                )}
                {!['quote', 'fulfilled', 'draft'].includes(order.status) && (
                  <Button variant="secondary" onClick={() => void act('/release')} disabled={busy}>
                    Release reserved stock
                  </Button>
                )}
                <Button
                  variant="danger"
                  onClick={() => {
                    const reason = prompt('Cancel this order? Reason (optional):');
                    if (reason === null) return;
                    void act('/cancel', { reason: reason || null });
                  }}
                  disabled={busy}
                >
                  Cancel order
                </Button>
                <span className="field-hint">
                  Schedule or reschedule delivery in Deliveries &amp; fulfillment on the left.
                </span>
              </Stack>
            </Card>
          )}
        </Stack>
      </div>
    </div>
  );
}

/** Right-aligned money for the Money card's label/value rows. */
function MoneyValue({ cents, bold }: { cents: number; bold?: boolean }) {
  const money = <Money cents={cents} />;
  return (
    <span className="block text-right tabular-nums">{bold ? <strong>{money}</strong> : money}</span>
  );
}

interface PlanInstallment {
  seq: number;
  dueDate: string;
  amountCents: number;
  status: string;
}
interface PlanDetail {
  id: string;
  orderId: string;
  status: string;
  frequency: string;
  installments: PlanInstallment[];
}

/** Layaway / in-house plan (G4): create it here, take installments here. */
function PaymentPlanCard(props: {
  orderId: string;
  orderKind: string;
  balanceDueCents: number;
  onChanged: () => Promise<void> | void;
}) {
  const [plan, setPlan] = useState<PlanDetail | null | undefined>(undefined);
  const [count, setCount] = useState('3');
  const [frequency, setFrequency] = useState('monthly');
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const plans = await api<PlanDetail[]>('/v1/payment-plans');
      setPlan(plans.find((p) => p.orderId === props.orderId) ?? null);
    } catch {
      setPlan(null);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.orderId]);

  async function createPlan() {
    setBusy(true);
    setError(null);
    try {
      const created = await api<PlanDetail>(`/v1/orders/${props.orderId}/payment-plan`, {
        method: 'POST',
        body: JSON.stringify({ installmentCount: Number(count), frequency }),
      });
      setPlan(created);
      await props.onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pay(seq: number) {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<PlanDetail>(
        `/v1/payment-plans/${plan.id}/installments/${seq}/pay`,
        {
          method: 'POST',
          body: JSON.stringify({ method: 'cash' }),
        },
      );
      setPlan(updated);
      await props.onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (plan === undefined) return null;

  // Owner 2026-09-02 (#7): a regular order shows one line, not a plan
  // form — the button still starts a plan (3 monthly) in one click.
  if (plan === null && props.orderKind !== 'layaway' && !expanded) {
    return (
      <CollapsedCard
        title="Payment plan"
        testid="payment-plan-card"
        actions={
          props.balanceDueCents > 0 ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
                Options…
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void createPlan()}
                data-testid="create-plan"
              >
                Start layaway plan
              </Button>
            </>
          ) : undefined
        }
      >
        {props.balanceDueCents > 0
          ? 'None — split the balance into installments if the customer wants one.'
          : 'None.'}
      </CollapsedCard>
    );
  }

  return (
    <Card
      title="Payment plan"
      description={
        plan ? (
          <>
            {plan.frequency} plan · <span data-testid="plan-status">{plan.status}</span>
          </>
        ) : props.balanceDueCents > 0 ? (
          'Split the balance into installments.'
        ) : undefined
      }
      data-testid="payment-plan-card"
    >
      {error && <Alert tone="error">{error}</Alert>}
      {plan === null ? (
        props.balanceDueCents > 0 ? (
          <>
            <FormGrid cols={3}>
              <Field label="Installments">
                <Input
                  type="number"
                  min={2}
                  max={24}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  data-testid="plan-count"
                />
              </Field>
              <Field label="Frequency">
                <Select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                  <option value="weekly">weekly</option>
                  <option value="biweekly">biweekly</option>
                  <option value="monthly">monthly</option>
                </Select>
              </Field>
            </FormGrid>
            <FormActions>
              <Button
                variant="primary"
                onClick={() => void createPlan()}
                disabled={busy || !(Number(count) >= 1)}
                data-testid="create-plan"
              >
                Start layaway plan
              </Button>
            </FormActions>
          </>
        ) : (
          <p className="muted">No plan — the balance is already zero.</p>
        )
      ) : (
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Due</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {plan.installments.map((i) => (
                <tr key={i.seq}>
                  <td>{i.seq}</td>
                  <td>{i.dueDate}</td>
                  <td>
                    <StatusBadge status={i.status} />
                  </td>
                  <td className="num">
                    <Money cents={i.amountCents} />
                  </td>
                  <td className="actions">
                    {i.status !== 'paid' && plan.status === 'active' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void pay(i.seq)}
                        disabled={busy}
                        data-testid={`pay-installment-${i.seq}`}
                      >
                        Pay cash
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

/**
 * §10 Returns & exchange: delivered units come back through here — the
 * refund reverses original tenders or lands as store credit, the goods
 * go to the As-Is review queue (never straight to stock), and an
 * Exchange Order can be written against this invoice. Price adjustments
 * are the money-only variant.
 */
function ReturnsCard({
  order,
  busy,
  onChanged,
}: {
  order: {
    id: string;
    number: string;
    orderKind: string;
    originalOrderId?: string | null;
    paidCents: number;
    creditDueCents?: number;
    lines: ReturnableLine[];
  };
  busy: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<'original' | 'store_credit'>('original');
  const [fulfillment, setFulfillment] = useState<'drop_off' | 'pickup'>('drop_off');
  const [reason, setReason] = useState('');
  // A22 slice 6 (STORIS Enter a Return): who took it, which store, the
  // fees withheld, and the pickup stop for the delivery calendar.
  const [members, setMembers] = useState<{ membershipId: string; name: string | null }[]>([]);
  const [stores, setStores] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [salespersonId, setSalespersonId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [restockingFee, setRestockingFee] = useState('');
  const [pickupFee, setPickupFee] = useState('');
  const [pickupDate, setPickupDate] = useState('');
  const [pickupStart, setPickupStart] = useState('');
  const [pickupEnd, setPickupEnd] = useState('');
  useEffect(() => {
    api<{ membershipId: string; name: string | null }[]>('/v1/business/members')
      .then(setMembers)
      .catch(() => setMembers([]));
    api<{ id: string; name: string; isActive: boolean }[]>('/v1/business/locations')
      .then((rows) => setStores(rows.filter((l) => l.isActive)))
      .catch(() => setStores([]));
  }, []);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [working, setWorking] = useState(false);
  // A7 lifecycle: authorized returns wait here for the goods; receiving
  // fires the refund. Completed/cancelled returns stay as history.
  const [returns, setReturns] = useState<
    {
      id: string;
      rmaNumber: string;
      status: string;
      fulfillment: string;
      refundMethod: string;
      amountCents: number;
      authorizedAt: string;
      pickupDate?: string | null;
      pickupDeliveryId?: string | null;
    }[]
  >([]);
  // Cancelling a return authorization is override-gated server-side, so
  // it needs the dialog rather than a native prompt. Declared with the
  // other state — ReturnsCard returns early below.
  const [cancellingReturnId, setCancellingReturnId] = useState<string | null>(null);
  async function loadReturns() {
    try {
      const page = await api<{
        data: {
          id: string;
          rmaNumber: string;
          status: string;
          fulfillment: string;
          refundMethod: string;
          amountCents: number;
          authorizedAt: string;
        }[];
      }>(`/v1/order-returns?orderId=${order.id}`);
      setReturns(page.data);
    } catch {
      setReturns([]);
    }
  }
  useEffect(() => {
    void loadReturns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);
  // Coded adjustment reasons (gap sprint G2). While the business has no
  // codes of class `adjustment`, the shared free-text reason is sent.
  const [adjustCodes, setAdjustCodes] = useState<
    { id: string; code: string; description: string }[]
  >([]);
  const [adjustCodeId, setAdjustCodeId] = useState('');
  useEffect(() => {
    api<{ id: string; code: string; description: string }[]>(
      '/v1/reason-codes?usageClass=adjustment',
    )
      .then(setAdjustCodes)
      .catch(() => setAdjustCodes([]));
  }, []);

  // I4: a return outside the configured window comes back 403
  // OVERRIDE_REQUIRED — the dialog retries with manager credentials.
  const [windowOverrideOpen, setWindowOverrideOpen] = useState(false);

  const returnable = order.lines.filter((l) => l.qtyFulfilled - l.qtyReturned > 0);
  // Owner 2026-09-02 (#7): before anything is delivered there is nothing
  // to return — one line, not an empty form.
  if (returnable.length === 0 && returns.length === 0 && order.paidCents === 0) {
    return (
      <CollapsedCard title="Returns" testid="returns-collapsed">
        Nothing delivered yet — returns start once goods are out.
      </CollapsedCard>
    );
  }

  function buildReturnBody() {
    return {
      lines: Object.entries(qty)
        .filter(([, q]) => q > 0)
        .map(([lineId, quantity]) => ({
          lineId,
          quantity,
        })),
      refundMethod: method,
      fulfillment,
      reason: reason || null,
      ...(salespersonId ? { salespersonMembershipId: salespersonId } : {}),
      ...(storeId ? { locationId: storeId } : {}),
      ...(restockingFee.trim()
        ? { restockingFeeCents: Math.round(Number(restockingFee) * 100) }
        : {}),
      ...(fulfillment === 'pickup' && pickupFee.trim()
        ? { pickupFeeCents: Math.round(Number(pickupFee) * 100) }
        : {}),
      ...(fulfillment === 'pickup' && pickupDate
        ? {
            pickupDate,
            pickupWindowStart: pickupStart || null,
            pickupWindowEnd: pickupEnd || null,
          }
        : {}),
    };
  }

  async function processReturn() {
    const body = buildReturnBody();
    if (body.lines.length === 0) {
      toast.error('Enter a quantity on at least one line.');
      return;
    }
    setWorking(true);
    try {
      await api(`/v1/orders/${order.id}/return`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast.success(
        fulfillment === 'drop_off'
          ? 'Return processed — goods staged in As-Is review.'
          : 'Return authorized — the refund fires when the goods are received back.',
      );
      setQty({});
      setReason('');
      await onChanged();
      await loadReturns();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OVERRIDE_REQUIRED') {
        setWindowOverrideOpen(true);
      } else {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setWorking(false);
    }
  }

  async function receiveReturn(id: string) {
    setWorking(true);
    try {
      await api(`/v1/order-returns/${id}/receive`, { method: 'POST' });
      toast.success('Goods received — refund issued.');
      await onChanged();
      await loadReturns();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function processAdjustment() {
    const cents = Math.round(Number(adjustAmount) * 100);
    const hasReason = adjustCodes.length > 0 ? Boolean(adjustCodeId) : Boolean(reason.trim());
    if (!Number.isFinite(cents) || cents <= 0 || !hasReason) {
      toast.error('Enter an adjustment amount and a reason.');
      return;
    }
    setWorking(true);
    try {
      await api(`/v1/orders/${order.id}/price-adjustment`, {
        method: 'POST',
        body: JSON.stringify({
          amountCents: cents,
          ...(adjustCodeId ? { reasonCodeId: adjustCodeId } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          refundMethod: method,
        }),
      });
      toast.success('Price adjustment recorded.');
      setAdjustAmount('');
      setReason('');
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card
      title="Returns"
      description="Returned goods go to the As-Is queue for manager/warehouse review — never straight back to sellable stock."
      data-testid="returns-card"
    >
      <Stack>
        {returns.length > 0 && (
          <TableWrap>
            <table className="table" data-testid="returns-table">
              <thead>
                <tr>
                  <th>RMA</th>
                  <th>Status</th>
                  <th>Refund</th>
                  <th>Pickup</th>
                  <th className="num">Amount</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id}>
                    <td className="font-semibold">{r.rmaNumber}</td>
                    <td>
                      {r.status === 'authorized'
                        ? `awaiting ${r.fulfillment === 'pickup' ? 'pickup' : 'drop-off'}`
                        : r.status}
                    </td>
                    <td>
                      {r.refundMethod === 'store_credit' ? 'store credit' : 'original tenders'}
                    </td>
                    <td>
                      {r.pickupDeliveryId ? (
                        <Link href={`/deliveries/${r.pickupDeliveryId}`}>
                          {r.pickupDate ?? 'stop'}
                        </Link>
                      ) : (
                        (r.pickupDate ?? '—')
                      )}
                    </td>
                    <td className="num">
                      <Money cents={r.amountCents} />
                    </td>
                    <td className="actions">
                      <Link
                        href={`/print/returns/${r.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-ghost btn-sm"
                        data-testid="print-return-ticket"
                      >
                        Ticket
                      </Link>
                      {r.status === 'authorized' && (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={working}
                            data-testid="receive-return"
                            onClick={() => void receiveReturn(r.id)}
                          >
                            Goods received
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={working}
                            onClick={() => setCancellingReturnId(r.id)}
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        <SecurityOverrideDialog
          open={windowOverrideOpen}
          title="Outside the return window — manager approval needed"
          usageClass="exception"
          submitLabel="Approve return"
          perform={(payload) =>
            api(`/v1/orders/${order.id}/return`, {
              method: 'POST',
              body: JSON.stringify({ ...buildReturnBody(), override: payload.override }),
            }).then(() => undefined)
          }
          onClose={() => setWindowOverrideOpen(false)}
          onSuccess={() => {
            setQty({});
            setReason('');
            void onChanged();
            void loadReturns();
          }}
        />
        <SecurityOverrideDialog
          open={cancellingReturnId != null}
          title="Cancel this return authorization"
          usageClass="exception"
          submitLabel="Cancel return"
          perform={(payload) =>
            api(`/v1/order-returns/${cancellingReturnId}/cancel`, {
              method: 'POST',
              body: JSON.stringify(payload),
            }).then(() => undefined)
          }
          onClose={() => setCancellingReturnId(null)}
          onSuccess={() => {
            void onChanged();
            void loadReturns();
          }}
        />
        {returnable.length > 0 && (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Delivered item</th>
                  <th className="num">Returnable</th>
                  <th>Return qty</th>
                </tr>
              </thead>
              <tbody>
                {returnable.map((l) => {
                  const max = l.qtyFulfilled - l.qtyReturned;
                  return (
                    <tr key={l.id}>
                      <td>{l.description}</td>
                      <td className="num">{max}</td>
                      <td>
                        <Input
                          type="number"
                          min={0}
                          max={max}
                          value={qty[l.id] ?? 0}
                          data-testid="return-qty"
                          aria-label={`Return quantity for ${l.description}`}
                          onChange={(e) =>
                            setQty((prev) => ({
                              ...prev,
                              [l.id]: Math.max(0, Math.min(max, Number(e.target.value) || 0)),
                            }))
                          }
                          className="w-20"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div>
          <FormGrid cols={3}>
            <Field label="Refund to">
              <Select
                value={method}
                data-testid="refund-method"
                onChange={(e) => setMethod(e.target.value as 'original' | 'store_credit')}
              >
                <option value="original">Original tenders</option>
                <option value="store_credit">Store credit</option>
              </Select>
            </Field>
            <Field label="Goods come back by">
              <Select
                value={fulfillment}
                data-testid="return-fulfillment"
                onChange={(e) => setFulfillment(e.target.value as 'drop_off' | 'pickup')}
              >
                <option value="drop_off">Customer drop-off (refund now)</option>
                <option value="pickup">Truck pickup (refund on receipt)</option>
              </Select>
            </Field>
            <Field label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Field label="Return salesperson">
              <Select
                value={salespersonId}
                onChange={(e) => setSalespersonId(e.target.value)}
                data-testid="return-salesperson"
              >
                <option value="">—</option>
                {members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name ?? m.membershipId}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Store taking the return">
              <Select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                data-testid="return-store"
              >
                <option value="">Order&apos;s store</option>
                {stores.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Restocking fee ($)" hint="Withheld from the refund">
              <Input
                type="number"
                step="0.01"
                min={0}
                value={restockingFee}
                onChange={(e) => setRestockingFee(e.target.value)}
                data-testid="return-restocking-fee"
              />
            </Field>
            {fulfillment === 'pickup' && (
              <>
                <Field label="Pickup fee ($)" hint="Withheld from the refund">
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={pickupFee}
                    onChange={(e) => setPickupFee(e.target.value)}
                  />
                </Field>
                <Field label="Pickup date" hint="Puts the stop on the delivery calendar">
                  <Input
                    type="date"
                    value={pickupDate}
                    onChange={(e) => setPickupDate(e.target.value)}
                    data-testid="return-pickup-date"
                  />
                </Field>
                <Field label="Pickup window">
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      value={pickupStart}
                      onChange={(e) => setPickupStart(e.target.value)}
                    />
                    <span className="muted">to</span>
                    <Input
                      type="time"
                      value={pickupEnd}
                      onChange={(e) => setPickupEnd(e.target.value)}
                    />
                  </div>
                </Field>
              </>
            )}
            <SectionHeading as="h3" title="Price adjustment" />
            <Field label="Adjustment ($)">
              <Input
                type="number"
                step="0.01"
                min={0}
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                data-testid="adjust-amount"
              />
            </Field>
            {adjustCodes.length > 0 && (
              <Field label="Adjustment reason">
                <Select
                  value={adjustCodeId}
                  data-testid="adjust-reason-code"
                  onChange={(e) => setAdjustCodeId(e.target.value)}
                >
                  <option value="">Select…</option>
                  {adjustCodes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.description}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </FormGrid>
          <FormActions>
            <Button
              variant="secondary"
              disabled={busy || working}
              onClick={() => void processAdjustment()}
              data-testid="process-adjustment"
            >
              Price adjustment
            </Button>
            {returnable.length > 0 && (
              <Button
                variant="primary"
                disabled={busy || working}
                onClick={() => void processReturn()}
                data-testid="process-return"
              >
                Process return
              </Button>
            )}
          </FormActions>
        </div>
      </Stack>
    </Card>
  );
}

/**
 * Exchanges get their own card (owner 2026-09-02, #2): the exchange
 * orders written against this invoice, the original invoice when this
 * order is itself an exchange, and the door to write a new one.
 */
function ExchangesCard({
  order,
}: {
  order: {
    id: string;
    originalOrderId: string | null;
    creditDueCents: number;
    exchangeOrders: OrderDetail['exchangeOrders'];
    lines: { qtyFulfilled: number }[];
  };
}) {
  const delivered = order.lines.some((l) => l.qtyFulfilled > 0);
  const exchanges = order.exchangeOrders ?? [];
  if (!order.originalOrderId && exchanges.length === 0 && !delivered) {
    return (
      <CollapsedCard title="Exchanges" testid="exchanges-collapsed">
        None — an exchange can be written once goods are delivered.
      </CollapsedCard>
    );
  }
  return (
    <Card
      title="Exchanges"
      description="An exchange nets the return credit against the replacement in one settlement (restocking fee per Settings)."
      data-testid="exchanges-card"
      actions={
        !order.originalOrderId && delivered ? (
          <LinkButton
            href={`/exchanges/new?originalOrderId=${order.id}`}
            variant="secondary"
            size="sm"
            data-testid="write-exchange"
          >
            Write exchange
          </LinkButton>
        ) : undefined
      }
    >
      {order.originalOrderId && (
        <Alert tone="info">
          This is an <strong>Exchange Order</strong> —{' '}
          <Link href={`/orders/${order.originalOrderId}`}>view the original invoice</Link>.
          {order.creditDueCents > 0 && (
            <>
              {' '}
              Credit due to customer: <Money cents={order.creditDueCents} />.
            </>
          )}
        </Alert>
      )}
      {exchanges.length === 0 ? (
        !order.originalOrderId && <p className="muted">No exchange written against this invoice.</p>
      ) : (
        <TableWrap>
          <table className="table" data-testid="exchanges-table">
            <thead>
              <tr>
                <th>Exchange order</th>
                <th>Status</th>
                <th>Written</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {exchanges.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Link href={`/orders/${x.id}`}>
                      <strong>{x.number}</strong>
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={x.status} />
                  </td>
                  <td>{new Date(x.createdAt).toLocaleDateString()}</td>
                  <td className="num">
                    <Money cents={x.totalCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

/** A card that does not apply right now, kept to one line (owner 2026-09-02, #7). */
function CollapsedCard({
  title,
  testid,
  children,
  actions,
}: {
  title: string;
  testid: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Card title={title} actions={actions} data-testid={testid}>
      <p className="muted">{children}</p>
    </Card>
  );
}

/**
 * Stock state per line (owner 2026-09-02, #4 + PO ask): one badge that
 * says fulfilled / reserved / partial / not reserved, the PO the line is
 * waiting on and whether receiving has accepted it, and a per-line
 * Release for what is held.
 */
function StockCell({
  line: l,
  canRelease,
  busy,
  onRelease,
}: {
  line: OrderLine;
  canRelease: boolean;
  busy: boolean;
  onRelease: () => void;
}) {
  if (l.lineType === 'custom') {
    return <span className="muted">—</span>;
  }
  const open = l.quantity - l.qtyFulfilled;
  const state =
    l.lineType === 'direct_ship'
      ? { label: 'vendor ships', cls: 'badge-neutral' }
      : open <= 0
        ? { label: 'fulfilled', cls: 'badge-success' }
        : l.qtyReserved >= open
          ? { label: 'reserved', cls: 'badge-success' }
          : l.qtyReserved > 0
            ? { label: `${l.qtyReserved}/${open} reserved`, cls: 'badge-warning' }
            : { label: 'not reserved', cls: 'badge-danger' };
  return (
    <div className="grid gap-0.5 text-xs" data-testid="order-line-stock">
      <span>
        <span className={`badge ${state.cls}`}>{state.label}</span>
        {l.qtyFulfilled > 0 && open > 0 && (
          <span className="muted"> · {l.qtyFulfilled} fulfilled</span>
        )}
      </span>
      {l.po && (
        <span data-testid="order-line-po" className="nowrap">
          <Link href={`/purchase-orders/${l.po.poId}`}>{l.po.poNumber}</Link>
          <span className="muted">
            {' · '}
            {l.po.received > 0 && l.qtyReserved > 0
              ? l.po.ordered > 0
                ? `${l.po.received} accepted, reserved · ${l.po.ordered} still on order`
                : 'accepted, reserved'
              : l.po.expectedAt
                ? `on order · due ${new Date(l.po.expectedAt).toLocaleDateString()}`
                : 'on order'}
          </span>
        </span>
      )}
      {canRelease && l.qtyReserved > 0 && (
        <button
          type="button"
          onClick={onRelease}
          disabled={busy}
          className="btn-link text-left"
          data-testid="order-line-release"
        >
          Release {l.qtyReserved} reserved
        </button>
      )}
    </div>
  );
}

/**
 * Split family (owner 2026-09-02, #8): when a take-with item split off
 * its own order, show every piece with what it carries, right under the
 * lines it came from.
 */
function SplitOrdersCard({ order }: { order: OrderDetail }) {
  return (
    <Card title="Split orders" flush data-testid="split-orders-card">
      <TableWrap>
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Fulfillment</th>
              <th>Items</th>
              <th>Status</th>
              <th className="num">Balance due</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-surface-muted">
              <td>
                <strong>{order.number}</strong>
                <span className="muted block text-[11px]">this order</span>
              </td>
              <td>
                {order.fulfillmentType.replace(/_/g, ' ')}
                {order.requestedDate ? ` · ${order.requestedDate}` : ''}
              </td>
              <td>
                {order.lines
                  .filter((l) => l.lineType !== 'custom')
                  .map((l) => `${l.quantity} × ${l.description}`)
                  .join(', ')}
              </td>
              <td>
                <StatusBadge status={order.status} />
              </td>
              <td className="num">
                <Money cents={order.balanceDueCents} />
              </td>
            </tr>
            {order.family.map((f) => (
              <tr key={f.id}>
                <td>
                  <Link href={`/orders/${f.id}`}>
                    <strong>{f.number}</strong>
                  </Link>
                </td>
                <td>
                  {f.fulfillmentType.replace(/_/g, ' ')}
                  {f.requestedDate ? ` · ${f.requestedDate}` : ''}
                </td>
                <td>{f.lines.map((l) => `${l.quantity} × ${l.description}`).join(', ') || '—'}</td>
                <td>
                  <StatusBadge status={f.status} />
                </td>
                <td className="num">
                  <Money cents={f.balanceDueCents} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

/**
 * Next step (owner 2026-09-02, #6): one line computed from state, so the
 * page reads as a checklist instead of a search.
 */
function NextStepBanner({ order, deliveries }: { order: OrderDetail; deliveries: DeliveryRow[] }) {
  const steps = orderNextSteps(order, deliveries);
  if (steps.length === 0) return null;
  const first = steps[0]!;
  return (
    <Alert tone={first.tone} data-testid="next-step">
      <strong>Next:</strong> {first.text}
      {steps.slice(1, 3).map((st) => (
        <span key={st.text} className="opacity-85">
          {' '}
          · {st.text}
        </span>
      ))}
    </Alert>
  );
}

/** Sticky money strip for the sidebar (owner 2026-09-02, #5). */
function BalanceStrip({ order }: { order: OrderDetail }) {
  const owing = order.balanceDueCents > 0;
  return (
    <Card
      data-testid="balance-strip"
      className="sticky top-3 z-[5]"
      // Data-driven: the rule colour follows whether money is owed.
      style={{ borderLeft: `4px solid ${owing ? 'var(--danger)' : 'var(--success)'}` }}
    >
      <Stack gap="sm">
        <StatGrid cols={2}>
          <StatTile label="Total" value={<Money cents={order.totalCents} />} />
          <StatTile label="Paid" value={<Money cents={order.paidCents} />} />
          <StatTile
            className="col-span-2"
            label={owing ? 'Due' : 'Balance'}
            value={owing ? <Money cents={order.balanceDueCents} /> : 'Paid in full'}
            tone={owing ? 'danger' : 'success'}
          />
        </StatGrid>
        {owing && !order.completedAt && !order.cancelledAt && (
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            data-testid="balance-strip-pay"
            onClick={() =>
              document
                .getElementById('payments-card')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            Take payment
          </Button>
        )}
      </Stack>
    </Card>
  );
}

/** Page skeleton that holds the two-column layout while the order loads (#8). */
function OrderSkeleton() {
  return (
    <Stack data-testid="order-skeleton">
      <Stack gap="sm">
        <Skeleton style={{ height: 28, width: 260 }} />
        <Skeleton style={{ height: 14, width: 340 }} />
      </Stack>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Stack className="min-w-0">
          <Skeleton style={{ height: 220 }} />
          <Skeleton style={{ height: 140 }} />
          <Skeleton style={{ height: 120 }} />
        </Stack>
        <Stack className="min-w-0">
          <Skeleton style={{ height: 70 }} />
          <Skeleton style={{ height: 110 }} />
          <Skeleton style={{ height: 180 }} />
        </Stack>
      </div>
    </Stack>
  );
}
