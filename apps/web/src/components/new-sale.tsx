'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Search, X } from 'lucide-react';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
import { autofillFromZip, type ZipHit } from '@/lib/zip-lookup';
import { ProductSearchDialog, type SearchRow } from '@/components/product-search-dialog';
import { Money } from '@/components/money';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  SectionHeading,
  Select,
  Stack,
  TableWrap,
  Toolbar,
} from '@/components/ui';

/**
 * New Sale — the single-screen order entry from PLAN-POS-OPERATIONS §4
 * (amendment A3: supersedes the three-step wizard; A4: the quick-sale
 * register is retired and take-with flows through here).
 *
 * Customer, merchandise, and payment all live on one screen: universal
 * customer search up top, an Add Product popup with stock/ATP awareness,
 * one-click Removal/Recycling fee lines, and a pinned totals + payments
 * rail. Complete
 * posts the order (or a plain register sale for a fully-paid take-with),
 * Save as Draft parks it store-wide.
 */

const FULFILLMENTS = [
  { value: 'delivery', label: 'Delivery' },
  { value: 'pickup', label: 'Customer pickup' },
  { value: 'take_with', label: 'Take-with' },
  { value: 'direct_ship', label: 'Direct ship' },
] as const;
type Fulfillment = (typeof FULFILLMENTS)[number]['value'];

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
type Tender = (typeof TENDERS)[number]['value'];

const RECYCLING_DESC = 'Recycling Fee';

interface CustomerHit {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  addressesJson: { line1?: string | null; city?: string | null; region?: string | null }[] | null;
}
interface Line {
  key: string;
  variantId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineDiscountCents: number;
  lineType: 'stock' | 'special_order' | 'custom';
  fulfillmentMethod: '' | Fulfillment;
  /** Per-line fulfill-from location; '' = the selling store. */
  sourceLocationId: string;
  deliveryDate: string;
  availableHere?: number;
  atpDate?: string | null;
  /**
   * The product's own tax rate (tax class), null/undefined = the store
   * rate. 0 marks an untaxed line — installation, services (owner
   * 2026-09-06). Mirrors what the server charges on the written order.
   */
  taxRateBps?: number | null;
}
interface PaymentLine {
  key: string;
  method: Tender;
  amountCents: number;
  ref: string;
}
interface LocationRow {
  id: string;
  name: string;
  taxRateBps: number | null;
  locationType?: string;
  /** Where THIS member may ring a sale; inventory can source from anywhere. */
  canSellHere?: boolean;
}
interface MemberRow {
  membershipId: string;
  name: string | null;
  email: string;
  status: string;
}
interface DraftRow {
  id: string;
  number: string;
  customerId: string;
  totalCents: number;
  createdAt: string;
}

let lineKeySeq = 0;
const nextKey = () => `l${++lineKeySeq}`;

/**
 * The warehouse that Add Product should default to (owner 2026-08-30:
 * "the default inventory for everyone needs to be warehouse"). Matched
 * by location type first, then by name for locations created before
 * location types existed.
 */
function findWarehouse<T extends { locationType?: string; name: string }>(
  locs: T[],
): T | undefined {
  return (
    locs.find((l) => l.locationType === 'warehouse') ??
    locs.find((l) => /warehouse|whse|\bwh\b/i.test(l.name))
  );
}

export function NewSale({ exchangeOf }: { exchangeOf?: string } = {}) {
  const router = useRouter();

  // --- reference data ---
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [locationId, setLocationId] = useState('');
  // The Add Product dialog's "From" location — the source stamped on
  // each line as it is added ('' = the selling store). Per-line after
  // that; each row has its own Source select.
  const [searchSourceId, setSearchSourceId] = useState('');
  const [taxRateBps, setTaxRateBps] = useState(0);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [recyclingFeeCents, setRecyclingFeeCents] = useState(1050);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [resumedDraftId, setResumedDraftId] = useState<string | null>(null);

  // --- customer ---
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [storeCredit, setStoreCredit] = useState<number | null>(null);
  const [openOrders, setOpenOrders] = useState<
    { id: string; number: string; requestedDate: string | null; deliveryDate: string | null }[]
  >([]);
  const [exchangeOriginal, setExchangeOriginal] = useState<{
    id: string;
    number: string;
  } | null>(null);
  const [custQuery, setCustQuery] = useState('');
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  const [custMore, setCustMore] = useState(false);
  const [custOpen, setCustOpen] = useState(false);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [newCust, setNewCust] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    phone2: '',
    email: '',
    referralSource: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
  });
  // Dedupe warn-on-create (handoff G4): a matching phone means the
  // caller probably already exists — offer them, never block.
  const [dupeWarn, setDupeWarn] = useState<{
    id: string;
    name: string;
    phone: string | null;
  } | null>(null);
  const [billDiffers, setBillDiffers] = useState(false);
  const [newBill, setNewBill] = useState({
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
  });

  useEffect(() => {
    const digits = newCust.phone.replace(/\D/g, '');
    if (!creatingCustomer || digits.length < 7) {
      setDupeWarn(null);
      return;
    }
    const t = setTimeout(() => {
      void api<{ customers: { id: string; name: string; phone: string | null }[] }>(
        `/v1/search?q=${encodeURIComponent(digits)}`,
      )
        .then((r) => setDupeWarn(r.customers[0] ?? null))
        .catch(() => setDupeWarn(null));
    }, 300);
    return () => clearTimeout(t);
  }, [creatingCustomer, newCust.phone]);

  async function attachExistingCustomer(idToUse: string) {
    try {
      const existing = await api<CustomerHit>(`/v1/customers/${idToUse}`);
      setCustomer(existing);
      setCreatingCustomer(false);
      setDupeWarn(null);
      toast.success('Attached the existing customer — no duplicate created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  const custTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- ship to ---
  const [shipDiffers, setShipDiffers] = useState(false);
  const [ship, setShip] = useState({
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    phone: '',
  });
  // ZIP → city/state (owner 2026-09-01): each address block remembers
  // what the last autofill wrote so a corrected ZIP can replace it, while
  // a hand-typed city is never overwritten.
  const zipMemo = useRef<{ cust: ZipHit | null; bill: ZipHit | null; ship: ZipHit | null }>({
    cust: null,
    bill: null,
    ship: null,
  });

  // --- order meta ---
  const [orderType, setOrderType] = useState<'sales_order' | 'layaway' | 'quote'>('sales_order');
  const [fulfillment, setFulfillment] = useState<Fulfillment>('delivery');
  const [requestedDate, setRequestedDate] = useState('');
  const [dayCapacity, setDayCapacity] = useState<{ booked: number; cap: number } | null>(null);
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [notes, setNotes] = useState('');
  const [salespeople, setSalespeople] = useState<string[]>([]);

  // --- lines ---
  const [lines, setLines] = useState<Line[]>([]);
  const [showProductSearch, setShowProductSearch] = useState(false);

  // --- money ---
  const [orderDiscount, setOrderDiscount] = useState('');
  const [installFee, setInstallFee] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('');
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  const [payMethod, setPayMethod] = useState<Tender>('card');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    id: string;
    number: string;
    kind: 'order' | 'sale';
    splitOrders?: { id: string; number: string; requestedDate: string | null }[];
    takeWith?: { orderId: string; number: string; completed: boolean; reason: string | null };
    bookedDeliveries?: string[];
  } | null>(null);

  // §7: while writing a delivery sale, show how many stops the chosen
  // day still has against the soft cap.
  useEffect(() => {
    if (fulfillment !== 'delivery' || !requestedDate) {
      setDayCapacity(null);
      return;
    }
    let stale = false;
    api<{ cap: number; days: { booked: number }[] }>(
      `/v1/deliveries/capacity?from=${requestedDate}&to=${requestedDate}`,
    )
      .then((r) => {
        if (!stale) setDayCapacity({ booked: r.days[0]?.booked ?? 0, cap: r.cap });
      })
      .catch(() => setDayCapacity(null));
    return () => {
      stale = true;
    };
  }, [fulfillment, requestedDate]);

  // G14: the customer's open orders — two orders, same house, same
  // week is two trucks and pure margin loss.
  useEffect(() => {
    if (!customer) {
      setOpenOrders([]);
      return;
    }
    let stale = false;
    api<
      { id: string; number: string; requestedDate: string | null; deliveryDate: string | null }[]
    >(`/v1/customers/${customer.id}/open-orders`)
      .then((r) => {
        if (!stale) setOpenOrders(r);
      })
      .catch(() => setOpenOrders([]));
    return () => {
      stale = true;
    };
  }, [customer]);

  // §10: store credit auto-surfaces at checkout.
  useEffect(() => {
    if (!customer) {
      setStoreCredit(null);
      return;
    }
    let stale = false;
    api<{ balanceCents: number }>(`/v1/customers/${customer.id}/store-credit`)
      .then((r) => {
        if (!stale) setStoreCredit(r.balanceCents);
      })
      .catch(() => setStoreCredit(null));
    return () => {
      stale = true;
    };
  }, [customer]);

  // §10 exchange mode: pull the original order and pin its customer.
  useEffect(() => {
    if (!exchangeOf) return;
    let stale = false;
    api<{
      id: string;
      number: string;
      customerId: string;
    }>(`/v1/orders/${exchangeOf}`)
      .then(async (o) => {
        if (stale) return;
        setExchangeOriginal({ id: o.id, number: o.number });
        const c = await api<CustomerHit>(`/v1/customers/${o.customerId}`).catch(() => null);
        if (!stale && c) setCustomer(c);
      })
      .catch(() => setExchangeOriginal(null));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchangeOf]);

  const loadDrafts = useCallback(() => {
    void api<{ data: DraftRow[] }>('/v1/orders?status=draft&limit=30')
      .then((r) => setDrafts(r.data))
      .catch(() => setDrafts([]));
  }, []);

  useEffect(() => {
    void api<LocationRow[]>('/v1/pos/locations')
      .then((locs) => {
        setLocations(locs);
        // The store chosen at login (session store) wins: everything
        // rung this session — money included — counts toward it.
        let sessionStore: (typeof locs)[number] | undefined;
        try {
          const raw = sessionStorage.getItem('jetnine.sellingStore');
          if (raw) {
            const saved = JSON.parse(raw) as { id: string };
            sessionStore = locs.find((l) => l.id === saved.id);
          }
        } catch {
          sessionStore = undefined;
        }
        const selling = sessionStore ?? locs.find((l) => l.locationType !== 'warehouse') ?? locs[0];
        if (selling) {
          setLocationId(selling.id);
          setTaxRateBps(selling.taxRateBps ?? 0);
          // Goods come off the truck from the warehouse by default —
          // product search (and each added line's source) starts there;
          // the cashier flips "From" to the store for floor stock.
          const wh = findWarehouse(locs);
          if (wh && wh.id !== selling.id) setSearchSourceId(wh.id);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    void api<MemberRow[]>('/v1/business/members')
      .then((rows) => setMembers(rows.filter((m) => m.status === 'active')))
      .catch(() => setMembers([]));
    void api<{ ops: { recyclingFeeCents?: number | null } | null }>('/v1/business/settings/pos')
      .then((s) => {
        if (s.ops?.recyclingFeeCents != null) setRecyclingFeeCents(s.ops.recyclingFeeCents);
      })
      .catch(() => undefined);
    loadDrafts();
  }, [loadDrafts]);

  // Universal customer search: name, phone, email, or address — debounced.
  useEffect(() => {
    if (custTimer.current) clearTimeout(custTimer.current);
    const q = custQuery.trim();
    if (q.length < 2) {
      setCustHits([]);
      return;
    }
    custTimer.current = setTimeout(() => {
      void api<{ data: CustomerHit[]; nextCursor: string | null }>(
        `/v1/customers?q=${encodeURIComponent(q)}&limit=20`,
      )
        .then((r) => {
          setCustHits(r.data);
          // The q-search branch server-side is a single ranked page with
          // nextCursor always null, so a full page is the truncation signal.
          setCustMore(r.nextCursor != null || r.data.length >= 20);
          setCustOpen(true);
        })
        .catch(() => {
          setCustHits([]);
          setCustMore(false);
        });
    }, 250);
  }, [custQuery]);

  // BA-0001: an in-progress sale must not vanish on a stray nav click.
  // Guard both browser unload (refresh/close) and in-app anchor
  // navigation while the sale holds any work and isn't done.
  const dirty = !done && (customer != null || lines.length > 0);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onClickCapture = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (!href.startsWith('/') || href.startsWith('/pos')) return;
      if (
        !window.confirm("This sale isn't saved — leave anyway? Use Save as Draft first to keep it.")
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [dirty]);

  const totals = useMemo(() => {
    let merchandise = 0;
    let recycling = 0;
    let lineDiscount = 0;
    for (const l of lines) {
      const gross = l.quantity * l.unitPriceCents;
      if (l.lineType === 'custom' && l.description === RECYCLING_DESC) recycling += gross;
      else merchandise += gross;
      lineDiscount += Math.min(l.lineDiscountCents, gross);
    }
    const install = parseDollars(installFee);
    const delivery = parseDollars(deliveryFee);
    const afterLines = merchandise - lineDiscount;
    const orderDisc = Math.min(parseDollars(orderDiscount), Math.max(0, afterLines));
    // Tax mirrors sales/totals.ts: custom lines (fees, removal) are
    // untaxed; every product line taxes at its own rate — the product's
    // tax class when it has one (0 for an untaxed service like power
    // base installation), else the store rate — on its net less its
    // pro-rata share of the order discount.
    const taxableLines = lines
      .filter((l) => l.lineType !== 'custom')
      .map((l) => ({
        net: Math.max(0, l.quantity * l.unitPriceCents - l.lineDiscountCents),
        rate: l.taxRateBps ?? taxRateBps,
      }));
    const taxableNet = taxableLines.reduce((sum, l) => sum + l.net, 0);
    const discountOnTaxable = Math.min(orderDisc, taxableNet);
    let allocated = 0;
    let taxCents = 0;
    taxableLines.forEach((l, i) => {
      const share =
        taxableNet === 0
          ? 0
          : i === taxableLines.length - 1
            ? discountOnTaxable - allocated
            : Math.floor((discountOnTaxable * l.net) / taxableNet);
      allocated += share;
      taxCents += Math.round(((l.net - share) * l.rate) / 10000);
    });
    const untaxedLines = taxableLines.filter((l) => l.rate === 0 && l.net > 0).length;
    const totalCents =
      merchandise + recycling - lineDiscount - orderDisc + taxCents + install + delivery;
    const paidCents = payments.reduce((s, p) => s + p.amountCents, 0);
    return {
      merchandise,
      recycling,
      discounts: lineDiscount + orderDisc,
      // BA-0026: what the order-discount box actually applied, so the UI
      // can say when the typed number was capped at merchandise.
      orderDiscApplied: orderDisc,
      install,
      delivery,
      taxCents,
      untaxedLines,
      totalCents,
      paidCents,
      balanceCents: Math.max(0, totalCents - paidCents),
    };
  }, [lines, orderDiscount, installFee, deliveryFee, taxRateBps, payments]);

  function addProduct(row: SearchRow) {
    setLines((prev) => {
      const next = [...prev];
      // Owner 2026-08-30: adding the same product again always makes a
      // NEW line — a second unit often sells at a different price, and
      // each line carries its own price box. (Quantity on a line is
      // still editable when one price covers several units.)
      {
        next.push({
          key: nextKey(),
          variantId: row.variantId,
          description: [row.productName, row.variantName].filter(Boolean).join(' — '),
          quantity: 1,
          unitPriceCents: row.priceCents,
          lineDiscountCents: 0,
          lineType: 'stock',
          fulfillmentMethod: '',
          // Take-with hands goods over the counter, so the line pulls
          // from the store the member is logged into (owner 2026-08-30);
          // delivery lines keep coming off the warehouse search source.
          // The per-line "From" select changes either.
          sourceLocationId:
            fulfillment === 'take_with'
              ? ''
              : searchSourceId && searchSourceId !== locationId
                ? searchSourceId
                : '',
          deliveryDate: '',
          availableHere: row.availableHere,
          atpDate: row.atpDate,
          taxRateBps: row.taxRateBps ?? null,
        });
      }
      return next;
    });
    setShowProductSearch(false);
  }

  function patchLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addPayment() {
    // BA-0027: an empty box used to record the full balance straight from
    // the grey placeholder. Commit the default into the field first so
    // the amount is visible before it becomes money.
    if (!payAmount.trim()) {
      if (totals.balanceCents > 0) setPayAmount((totals.balanceCents / 100).toFixed(2));
      return;
    }
    const cents = parseDollars(payAmount);
    if (cents <= 0) return;
    setPayments((prev) => [
      ...prev,
      { key: nextKey(), method: payMethod, amountCents: cents, ref: payRef.trim() },
    ]);
    setPayAmount('');
    setPayRef('');
  }

  async function resumeDraft(id: string) {
    setError(null);
    try {
      const o = await api<{
        id: string;
        customerId: string;
        locationId: string;
        fulfillmentType: string;
        requestedDate: string | null;
        deliveryInstructions: string | null;
        notes: string | null;
        orderDiscountCents: number;
        installFeeCents: number;
        deliveryFeeCents: number;
        lines: {
          variantId: string | null;
          description: string;
          quantity: number;
          unitPriceCents: number;
          discountCents: number;
          lineType: string;
          taxRateBps?: number | null;
          fulfillmentMethod: string | null;
          sourceLocationId: string | null;
          deliveryDate: string | null;
        }[];
      }>(`/v1/orders/${id}`);
      const cust = await api<CustomerHit>(`/v1/customers/${o.customerId}`);
      setCustomer(cust);
      setLocationId(o.locationId);
      setFulfillment((o.fulfillmentType as Fulfillment) ?? 'delivery');
      setRequestedDate(o.requestedDate ?? '');
      setDeliveryInstructions(o.deliveryInstructions ?? '');
      setNotes(o.notes ?? '');
      setOrderDiscount(o.orderDiscountCents ? (o.orderDiscountCents / 100).toFixed(2) : '');
      setInstallFee(o.installFeeCents ? (o.installFeeCents / 100).toFixed(2) : '');
      setDeliveryFee(o.deliveryFeeCents ? (o.deliveryFeeCents / 100).toFixed(2) : '');
      setLines(
        o.lines.map((l) => ({
          key: nextKey(),
          variantId: l.variantId,
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          lineDiscountCents: l.discountCents,
          lineType: (l.lineType as Line['lineType']) ?? 'stock',
          fulfillmentMethod: (l.fulfillmentMethod as Line['fulfillmentMethod']) ?? '',
          sourceLocationId: l.sourceLocationId ?? '',
          deliveryDate: l.deliveryDate ?? '',
          // The written line's rate (its tax class at write time); the
          // availability refresh below overrides it with the live one.
          taxRateBps: l.lineType === 'custom' ? 0 : (l.taxRateBps ?? null),
        })),
      );
      setResumedDraftId(id);
      // BA-0021: the special-order/stock warning must follow the line —
      // re-check availability for the restored variants per source.
      const byLoc = new Map<string, string[]>();
      for (const l of o.lines) {
        if (!l.variantId) continue;
        const loc = l.sourceLocationId ?? o.locationId;
        byLoc.set(loc, [...(byLoc.get(loc) ?? []), l.variantId]);
      }
      const avail = new Map<
        string,
        { availableHere: number; atpDate: string | null; taxRateBps: number | null }
      >();
      await Promise.all(
        [...byLoc.entries()].map(async ([loc, ids]) => {
          try {
            const rows = await api<SearchRow[]>(
              `/v1/pos/product-search?locationId=${loc}&variantIds=${ids.join(',')}&limit=100`,
            );
            for (const r of rows)
              avail.set(`${loc}:${r.variantId}`, {
                availableHere: r.availableHere,
                atpDate: r.atpDate,
                taxRateBps: r.taxRateBps ?? null,
              });
          } catch {
            // availability refresh is best-effort — the draft still loads
          }
        }),
      );
      if (avail.size > 0) {
        setLines((prev) =>
          prev.map((l) => {
            if (!l.variantId) return l;
            const hit = avail.get(`${l.sourceLocationId || o.locationId}:${l.variantId}`);
            return hit
              ? {
                  ...l,
                  availableHere: hit.availableHere,
                  atpDate: hit.atpDate,
                  taxRateBps: hit.taxRateBps,
                }
              : l;
          }),
        );
      }
      toast.success('Draft loaded — completing it will replace the draft');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit(mode: 'complete' | 'draft') {
    setError(null);
    if (!customer) {
      setError('Attach a customer first.');
      return;
    }
    if (lines.length === 0) {
      setError('Add at least one line.');
      return;
    }
    // BA-0002: money typed in the amount box must never vanish on
    // Complete. Block with the reason instead of silently dropping it.
    if (mode === 'complete' && parseDollars(payAmount) > 0) {
      setError(
        `You typed $${payAmount} in the payment box but didn't add it — press Add payment, or clear the box, then Complete.`,
      );
      return;
    }
    // BA-0005: a past delivery date now books a real truck stop.
    if (mode === 'complete' && fulfillment === 'delivery' && requestedDate) {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      if (requestedDate < todayStr) {
        setError(`Delivery date ${requestedDate} is in the past — pick today or later.`);
        return;
      }
    }
    if (orderType === 'layaway' && mode === 'complete' && totals.paidCents < 10000) {
      setError('Layaway needs a minimum $100 deposit to open.');
      return;
    }
    // G14: promising a date before the goods can arrive is the #1
    // customer-service failure in furniture — make it a deliberate act.
    if (mode === 'complete' && requestedDate) {
      const lateLines = lines.filter((l) => l.atpDate && l.atpDate > requestedDate);
      if (lateLines.length > 0) {
        const ok = window.confirm(
          `Promised ${requestedDate}, but not expected until ${lateLines
            .map((l) => `${l.description} (${l.atpDate})`)
            .join(', ')}. Promise it anyway?`,
        );
        if (!ok) return;
      }
    }
    setBusy(true);
    try {
      await doSubmit(mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doSubmit(mode: 'complete' | 'draft') {
    if (!customer) throw new Error('Attach a customer first.');
    {
      const linePayload = lines.map((l) => ({
        variantId: l.variantId ?? undefined,
        description: l.lineType === 'custom' ? l.description : undefined,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        lineDiscountCents: l.lineDiscountCents || undefined,
        lineType: l.lineType,
        fulfillmentMethod: l.fulfillmentMethod || undefined,
        sourceLocationId:
          l.sourceLocationId && l.sourceLocationId !== locationId ? l.sourceLocationId : undefined,
        deliveryDate: l.deliveryDate || undefined,
      }));

      // Take-with fully paid, all real stock → a plain register sale.
      // (Exchanges always stay orders — the document must print as an
      // Exchange Order against the original invoice.)
      const allSellable = lines.every((l) => l.lineType !== 'special_order');
      if (
        !exchangeOriginal &&
        mode === 'complete' &&
        orderType === 'sales_order' &&
        fulfillment === 'take_with' &&
        // Custom fee lines (the recycling fee) can't ride the plain-sale
        // shortcut — it prices variants only, so the fee would vanish
        // from the document. The order path carries them, untaxed.
        lines.every((l) => l.lineType !== 'custom') &&
        lines.every((l) => !l.sourceLocationId || l.sourceLocationId === locationId) &&
        allSellable &&
        totals.paidCents >= totals.totalCents &&
        totals.totalCents > 0
      ) {
        const sale = await api<{ id: string; number: string }>('/v1/sales', {
          method: 'POST',
          body: JSON.stringify({
            locationId,
            customerId: customer.id,
            lines: lines
              .filter((l) => l.variantId)
              .map((l) => ({
                variantId: l.variantId,
                quantity: l.quantity,
                unitPriceCents: l.unitPriceCents,
                lineDiscountCents: l.lineDiscountCents || undefined,
              })),
            orderDiscountCents: parseDollars(orderDiscount) || undefined,
            // The register honours the same G6 discount gate as an
            // order, so the reason/override travels with it.
            payments: [
              {
                method: payments[0]?.method === 'cash' ? 'cash' : 'card',
                amountCents: totals.totalCents,
              },
            ],
          }),
        });
        if (resumedDraftId) await cancelDraft(resumedDraftId);
        setDone({ id: sale.id, number: sale.number, kind: 'sale' });
        return;
      }

      const sp = salespeople.filter(Boolean);
      const createPath = exchangeOriginal
        ? `/v1/orders/${exchangeOriginal.id}/exchange`
        : '/v1/orders';
      const order = await api<{
        id: string;
        number: string;
        totalCents: number;
        splitOrders?: { id: string; number: string; requestedDate: string | null }[];
      }>(createPath, {
        method: 'POST',
        body: JSON.stringify({
          locationId,
          customerId: customer.id,
          orderKind: orderType === 'layaway' ? 'layaway' : 'sales_order',
          fulfillmentType: fulfillment,
          requestedDate: requestedDate || null,
          deliveryInstructions: deliveryInstructions || null,
          notes: notes || null,
          address: shipDiffers
            ? {
                line1: ship.line1 || null,
                line2: ship.line2 || null,
                city: ship.city || null,
                region: ship.region || null,
                postalCode: ship.postalCode || null,
                phone: ship.phone || null,
              }
            : addressFromCustomer(customer),
          salespersonMembershipId: sp[0] || undefined,
          secondSalespersonMembershipId: sp[1] || undefined,
          // Equal split by default (PLAN-POS-OPERATIONS §4/§9).
          splitBps: sp.length === 2 ? 5000 : undefined,
          lines: linePayload,
          orderDiscountCents: parseDollars(orderDiscount) || undefined,
          installFeeCents: parseDollars(installFee) || undefined,
          deliveryFeeCents: parseDollars(deliveryFee) || undefined,
          draft: mode === 'draft' ? true : undefined,
          confirm: mode === 'complete' && orderType !== 'quote' ? true : undefined,
          // Lines promised on a different date split into -A/-B sibling
          // orders server-side (backorder split at the register).
          splitByDeliveryDate: true,
        }),
      });

      if (mode === 'complete') {
        for (const p of payments) {
          await api(`/v1/orders/${order.id}/payments`, {
            method: 'POST',
            body: JSON.stringify({
              method: p.method,
              amountCents: p.amountCents,
              kind: 'deposit',
              processorRef: p.ref || undefined,
            }),
          });
        }
      }
      if (resumedDraftId && resumedDraftId !== order.id) await cancelDraft(resumedDraftId);

      // Take-with hand-over (owner 2026-08-31): completing a sale with
      // take-with lines splits them to a -A piece and completes it when
      // stock and money allow. Runs after payments so the money can
      // cover the walking goods first; a failure here never loses the
      // sale — the order page carries the same Complete button.
      let takeWith: NonNullable<typeof done>['takeWith'];
      if (
        mode === 'complete' &&
        orderType !== 'quote' &&
        lines.some(
          (l) => (l.fulfillmentMethod || fulfillment) === 'take_with' && l.lineType !== 'custom',
        )
      ) {
        try {
          const res = await api<{
            takeWith?: {
              orderId: string;
              number: string;
              completed: boolean;
              reason: string | null;
            };
          }>(`/v1/orders/${order.id}/complete`, { method: 'POST', body: JSON.stringify({}) });
          takeWith = res.takeWith;
        } catch {
          takeWith = undefined;
        }
      }

      // Owner 2026-08-31: the delivery date BOOKS the truck. Promising a
      // date and then re-entering it on the order page was double work —
      // completing a delivery sale now schedules the real delivery (and
      // one per split sibling on its own date). Reschedules happen from
      // the order page or the calendar.
      const bookedDeliveries: string[] = [];
      if (mode === 'complete' && orderType !== 'quote' && fulfillment === 'delivery') {
        const truckBound = lines.some(
          (l) =>
            l.lineType !== 'custom' &&
            !['take_with', 'pickup'].includes(l.fulfillmentMethod || fulfillment),
        );
        const targets = [
          ...(requestedDate && truckBound
            ? [{ id: order.id, number: order.number, date: requestedDate }]
            : []),
          ...(order.splitOrders ?? [])
            .filter((sib) => sib.requestedDate)
            .map((sib) => ({ id: sib.id, number: sib.number, date: sib.requestedDate! })),
        ];
        for (const t of targets) {
          try {
            await api(`/v1/orders/${t.id}/deliveries`, {
              method: 'POST',
              // The capacity hint next to the date already warned the
              // writer; over-cap bookings log the standard exception.
              body: JSON.stringify({ scheduledDate: t.date, confirmOverCapacity: true }),
            });
            bookedDeliveries.push(`${t.number} on ${t.date}`);
          } catch {
            toast.error(
              `${t.number}: could not book the delivery — schedule it from the order page.`,
            );
          }
        }
      }

      if (mode === 'draft') {
        toast.success(`Draft ${order.number} saved — visible store-wide`);
        resetAll();
        loadDrafts();
      } else {
        setDone({
          id: order.id,
          number: order.number,
          kind: 'order',
          splitOrders: order.splitOrders,
          takeWith,
          bookedDeliveries,
        });
      }
    }
  }

  async function cancelDraft(id: string) {
    await api(`/v1/orders/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'superseded by completed New Sale' }),
    }).catch(() => undefined);
  }

  function resetAll() {
    setCustomer(null);
    setCustQuery('');
    setLines([]);
    setPayments([]);
    setOrderDiscount('');
    setInstallFee('');
    setDeliveryFee('');
    setNotes('');
    setDeliveryInstructions('');
    setRequestedDate('');
    setShipDiffers(false);
    {
      const wh = findWarehouse(locations);
      setSearchSourceId(wh && wh.id !== locationId ? wh.id : '');
    }
    setResumedDraftId(null);
    setOrderType('sales_order');
    setDone(null);
  }

  if (done) {
    return (
      <Card title={`${done.kind === 'sale' ? 'Sale' : 'Order'} ${done.number} complete`}>
        {done.splitOrders && done.splitOrders.length > 0 && (
          <Alert tone="info" data-testid="split-siblings">
            Backordered lines split into{' '}
            {done.splitOrders.map((s, i) => (
              <span key={s.id}>
                {i > 0 && ', '}
                <a href={`/orders/${s.id}`}>{s.number}</a>
                {s.requestedDate ? ` (promised ${s.requestedDate})` : ''}
              </span>
            ))}{' '}
            — one payment covers them all: money taken at the register lands on each order up to
            what it owes.
          </Alert>
        )}
        {done.bookedDeliveries && done.bookedDeliveries.length > 0 && (
          <Alert tone="success" data-testid="booked-deliveries">
            Delivery booked: {done.bookedDeliveries.join(', ')} — it&apos;s on the Deliveries
            calendar. Change the date from the order page if plans move.
          </Alert>
        )}
        {done.takeWith && (
          <Alert
            tone={done.takeWith.completed ? 'success' : 'warning'}
            data-testid="take-with-result"
          >
            {done.takeWith.completed ? (
              <>
                Take-with items went out on{' '}
                <a href={`/orders/${done.takeWith.orderId}`}>{done.takeWith.number}</a> — paid and
                completed.
              </>
            ) : (
              <>
                Take-with items split to{' '}
                <a href={`/orders/${done.takeWith.orderId}`}>{done.takeWith.number}</a>, waiting:{' '}
                {done.takeWith.reason ?? 'not ready yet'}. Finish it with Complete on that order.
              </>
            )}
          </Alert>
        )}
        <p className="muted">Open the {done.kind} page to print the invoice or receipt.</p>
        <FormActions>
          <Button variant="secondary" onClick={resetAll} data-testid="new-sale-again">
            New Sale
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              router.push(done.kind === 'sale' ? `/sales/${done.id}` : `/orders/${done.id}`)
            }
          >
            Open {done.kind}
          </Button>
        </FormActions>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]" data-testid="new-sale">
      <div className="flex min-w-0 flex-col">
        {/* Banners are DOM-first and visually first; `order` only exists
            because the draft strip below is DOM-last (BA-0036). */}
        {exchangeOriginal && (
          <Alert tone="warning" data-testid="exchange-banner" className="-order-2">
            Writing an <strong>Exchange Order</strong> against original invoice{' '}
            <strong>{exchangeOriginal.number}</strong> — the document prints with the original
            number, and the customer is fixed to the original order&apos;s.
          </Alert>
        )}
        {!exchangeOriginal && openOrders.length > 0 && (
          <Alert tone="warning" data-testid="duplicate-order-banner" className="-order-2">
            This customer already has {openOrders.length === 1 ? 'an open order' : 'open orders'}:{' '}
            {openOrders.map((o, i) => (
              <span key={o.id}>
                {i > 0 && ', '}
                <strong>{o.number}</strong>
                {(o.deliveryDate ?? o.requestedDate) && ` (${o.deliveryDate ?? o.requestedDate})`}
              </span>
            ))}
            {' — '}consider one truck: add to the existing order or match its delivery date.
          </Alert>
        )}

        <Card title={<StepTitle n={1} label="Customer" />}>
          <Stack gap="sm">
            {customer ? (
              <div className="flex items-center gap-3">
                <div className="min-w-0">
                  <strong data-testid="order-customer">{customerName(customer)}</strong>
                  <div className="muted">
                    {[customer.phone, customer.email, addressPreview(customer)]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  value={custQuery}
                  onChange={(e) => setCustQuery(e.target.value)}
                  placeholder="Search name, phone, email, or address…"
                  aria-label="Search customers"
                  className="w-full"
                  data-testid="customer-search"
                  autoFocus
                />
                {custOpen && custHits.length > 0 && (
                  <Card flush className="absolute top-[105%] left-0 right-0 z-20">
                    <div className="max-h-[280px] overflow-y-auto p-1.5">
                      {custHits.map((c) => (
                        <button
                          key={c.id}
                          style={hitBtn}
                          data-testid="customer-hit"
                          onClick={() => {
                            setCustomer(c);
                            setCustOpen(false);
                            setCustQuery('');
                          }}
                        >
                          <strong>{customerName(c)}</strong>{' '}
                          <span className="muted">
                            {[c.phone, addressPreview(c)].filter(Boolean).join(' · ')}
                          </span>
                        </button>
                      ))}
                      {custMore && (
                        <div className="muted px-2 py-1">More matches — keep typing.</div>
                      )}
                    </div>
                  </Card>
                )}
              </div>
            )}
            {!customer &&
              (creatingCustomer ? (
                // Every cell needs min-w-0: grid/flex items refuse to
                // shrink below their content width by default, and on a
                // narrow column the overflowing Create button lands
                // *under* the totals rail, which then swallows its
                // clicks (caught by the checkpoint-8 e2e run).
                <Stack gap="sm">
                  <SectionHeading as="h3" title="New customer" />
                  <div className="grid gap-2 sm:grid-cols-5">
                    <Input
                      placeholder="First name"
                      aria-label="First name"
                      value={newCust.firstName}
                      onChange={(e) => setNewCust({ ...newCust, firstName: e.target.value })}
                      className="min-w-0"
                    />
                    <Input
                      placeholder="Last name"
                      aria-label="Last name"
                      value={newCust.lastName}
                      onChange={(e) => setNewCust({ ...newCust, lastName: e.target.value })}
                      className="min-w-0"
                    />
                    <Input
                      placeholder="Phone"
                      aria-label="Phone"
                      value={newCust.phone}
                      onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })}
                      className="min-w-0"
                    />
                    <Input
                      placeholder="2nd phone (optional)"
                      aria-label="2nd phone (optional)"
                      value={newCust.phone2}
                      onChange={(e) => setNewCust({ ...newCust, phone2: e.target.value })}
                      className="min-w-0"
                      data-testid="new-customer-phone2"
                    />
                    <Input
                      placeholder="Email"
                      aria-label="Email"
                      value={newCust.email}
                      onChange={(e) => setNewCust({ ...newCust, email: e.target.value })}
                      className="min-w-0"
                    />
                  </div>
                  {dupeWarn && (
                    <Alert
                      tone="warning"
                      data-testid="dupe-warning"
                      action={
                        <Button
                          size="sm"
                          variant="secondary"
                          data-testid="use-existing-customer"
                          onClick={() => void attachExistingCustomer(dupeWarn.id)}
                        >
                          Use existing
                        </Button>
                      }
                    >
                      Looks like <strong>{dupeWarn.name}</strong>
                      {dupeWarn.phone ? ` (${dupeWarn.phone})` : ''} already exists — use them
                      instead?
                    </Alert>
                  )}
                  <SectionHeading as="h3" title="Delivery address" />
                  <div className="grid gap-2 sm:grid-cols-5">
                    <Input
                      placeholder="Delivery address"
                      aria-label="Delivery address"
                      value={newCust.line1}
                      onChange={(e) => setNewCust({ ...newCust, line1: e.target.value })}
                      className="min-w-0 sm:col-span-2"
                      data-testid="new-customer-address"
                    />
                    <Input
                      placeholder="Apt / unit"
                      aria-label="Apt / unit"
                      value={newCust.line2}
                      onChange={(e) => setNewCust({ ...newCust, line2: e.target.value })}
                      className="min-w-0"
                    />
                    <Input
                      placeholder="City"
                      aria-label="City"
                      value={newCust.city}
                      onChange={(e) => setNewCust({ ...newCust, city: e.target.value })}
                      className="min-w-0"
                    />
                    <div className="flex min-w-0 gap-2">
                      <Input
                        placeholder="State"
                        aria-label="State"
                        value={newCust.region}
                        onChange={(e) => setNewCust({ ...newCust, region: e.target.value })}
                        className="w-16 min-w-0"
                      />
                      <Input
                        placeholder="ZIP"
                        aria-label="ZIP"
                        value={newCust.postalCode}
                        onChange={(e) =>
                          autofillFromZip(e.target.value, setNewCust, zipMemo.current, 'cust')
                        }
                        className="min-w-0 flex-1"
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={billDiffers}
                      onChange={(e) => setBillDiffers(e.target.checked)}
                    />
                    Billing address is different
                  </label>
                  {billDiffers && <SectionHeading as="h3" title="Billing address" />}
                  {billDiffers && (
                    <div className="grid gap-2 sm:grid-cols-5">
                      <Input
                        placeholder="Billing address"
                        aria-label="Billing address"
                        value={newBill.line1}
                        onChange={(e) => setNewBill({ ...newBill, line1: e.target.value })}
                        className="min-w-0 sm:col-span-2"
                        data-testid="new-customer-billing"
                      />
                      <Input
                        placeholder="Apt / unit"
                        aria-label="Apt / unit"
                        value={newBill.line2}
                        onChange={(e) => setNewBill({ ...newBill, line2: e.target.value })}
                        className="min-w-0"
                      />
                      <Input
                        placeholder="City"
                        aria-label="City"
                        value={newBill.city}
                        onChange={(e) => setNewBill({ ...newBill, city: e.target.value })}
                        className="min-w-0"
                      />
                      <div className="flex min-w-0 gap-2">
                        <Input
                          placeholder="State"
                          aria-label="State"
                          value={newBill.region}
                          onChange={(e) => setNewBill({ ...newBill, region: e.target.value })}
                          className="w-16 min-w-0"
                        />
                        <Input
                          placeholder="ZIP"
                          aria-label="ZIP"
                          value={newBill.postalCode}
                          onChange={(e) =>
                            autofillFromZip(e.target.value, setNewBill, zipMemo.current, 'bill')
                          }
                          className="min-w-0 flex-1"
                        />
                      </div>
                    </div>
                  )}
                  <Field label="How did they hear about us?">
                    <Input
                      placeholder="Walk-in, Google, referral…"
                      aria-label="How did they hear about us?"
                      value={newCust.referralSource}
                      onChange={(e) => setNewCust({ ...newCust, referralSource: e.target.value })}
                      list="referral-sources"
                      data-testid="new-customer-referral"
                    />
                    <datalist id="referral-sources">
                      {[
                        'Walk-in / drive-by',
                        'Google search',
                        'Yelp',
                        'Facebook / Instagram',
                        'TV / radio',
                        'Referred by friend or family',
                        'Repeat customer',
                        'Billboard',
                      ].map((s) => (
                        <option key={s} value={s} />
                      ))}
                    </datalist>
                  </Field>
                  <FormActions>
                    <Button
                      variant="secondary"
                      disabled={creatingBusy}
                      onClick={() => setCreatingCustomer(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      data-testid="create-customer"
                      disabled={creatingBusy}
                      onClick={() => {
                        const addr = (a: {
                          line1: string;
                          line2: string;
                          city: string;
                          region: string;
                          postalCode: string;
                        }) => ({
                          line1: a.line1.trim() || null,
                          line2: a.line2.trim() || null,
                          city: a.city.trim() || null,
                          region: a.region.trim() || null,
                          postalCode: a.postalCode.trim() || null,
                        });
                        const hasAddr = (a: { line1: string; city: string }) =>
                          Boolean(a.line1.trim() || a.city.trim());
                        // Entry 0 is the delivery address (the delivery
                        // flow reads it); billing rides second.
                        const addresses = [
                          ...(hasAddr(newCust) ? [{ label: 'delivery', ...addr(newCust) }] : []),
                          ...(billDiffers && hasAddr(newBill)
                            ? [{ label: 'billing', ...addr(newBill) }]
                            : []),
                        ];
                        setCreatingBusy(true);
                        void api<CustomerHit>('/v1/customers', {
                          method: 'POST',
                          body: JSON.stringify({
                            firstName: newCust.firstName || null,
                            lastName: newCust.lastName || null,
                            phone: newCust.phone || null,
                            phone2: newCust.phone2 || null,
                            email: newCust.email || null,
                            referralSource: newCust.referralSource || null,
                            ...(addresses.length > 0 ? { addressesJson: addresses } : {}),
                          }),
                        })
                          .then((c) => {
                            setCustomer(c);
                            setCreatingCustomer(false);
                          })
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : String(err)),
                          )
                          .finally(() => setCreatingBusy(false));
                      }}
                    >
                      {creatingBusy ? 'Creating…' : 'Create'}
                    </Button>
                  </FormActions>
                </Stack>
              ) : (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setCreatingCustomer(true)}>
                    <Plus size={13} aria-hidden /> New customer
                  </Button>
                </div>
              ))}
            {customer && fulfillment !== 'take_with' && (
              <Stack gap="sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={shipDiffers}
                    onChange={(e) => setShipDiffers(e.target.checked)}
                  />
                  Ship to a different address (default: billing address)
                </label>
                {shipDiffers && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Input
                      placeholder="Address line 1"
                      aria-label="Address line 1"
                      value={ship.line1}
                      onChange={(e) => setShip({ ...ship, line1: e.target.value })}
                    />
                    <Input
                      placeholder="Line 2"
                      aria-label="Line 2"
                      value={ship.line2}
                      onChange={(e) => setShip({ ...ship, line2: e.target.value })}
                    />
                    <Input
                      placeholder="City"
                      aria-label="City"
                      value={ship.city}
                      onChange={(e) => setShip({ ...ship, city: e.target.value })}
                    />
                    <Input
                      placeholder="State"
                      aria-label="State"
                      value={ship.region}
                      onChange={(e) => setShip({ ...ship, region: e.target.value })}
                    />
                    <Input
                      placeholder="ZIP"
                      aria-label="ZIP"
                      value={ship.postalCode}
                      onChange={(e) =>
                        autofillFromZip(e.target.value, setShip, zipMemo.current, 'ship')
                      }
                    />
                    <Input
                      placeholder="Phone at address"
                      aria-label="Phone at address"
                      value={ship.phone}
                      onChange={(e) => setShip({ ...ship, phone: e.target.value })}
                    />
                  </div>
                )}
              </Stack>
            )}
          </Stack>
        </Card>

        <Card
          title={<StepTitle n={2} label="Items" />}
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setLines((prev) => [
                    ...prev,
                    {
                      key: nextKey(),
                      variantId: null,
                      description: 'Mattress Removal',
                      quantity: 1,
                      unitPriceCents: 0,
                      lineDiscountCents: 0,
                      lineType: 'custom',
                      fulfillmentMethod: '',
                      sourceLocationId: '',
                      deliveryDate: '',
                    },
                  ])
                }
              >
                + Removal ($0)
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="add-recycling-fee"
                onClick={() =>
                  // Owner 2026-08-30: the CA recycling fee is added by
                  // hand like Removal, never automatically. One untaxed
                  // fee line; each click counts one more unit on it.
                  setLines((prev) => {
                    const next = prev.map((l) => ({ ...l }));
                    const fee = next.find(
                      (l) => l.lineType === 'custom' && l.description === RECYCLING_DESC,
                    );
                    if (fee) fee.quantity += 1;
                    else
                      next.push({
                        key: nextKey(),
                        variantId: null,
                        description: RECYCLING_DESC,
                        quantity: 1,
                        unitPriceCents: recyclingFeeCents,
                        lineDiscountCents: 0,
                        lineType: 'custom',
                        fulfillmentMethod: '',
                        sourceLocationId: '',
                        deliveryDate: '',
                      });
                    return next;
                  })
                }
              >
                + Recycling (${(recyclingFeeCents / 100).toFixed(2)})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="add-declined-foundation"
                onClick={() =>
                  // Owner 2026-08-31: documents on the invoice that the
                  // customer declined a new foundation — a no-charge
                  // line, added by hand like Removal.
                  setLines((prev) => [
                    ...prev,
                    {
                      key: nextKey(),
                      variantId: null,
                      description: 'Client Declined New Foundation',
                      quantity: 1,
                      unitPriceCents: 0,
                      lineDiscountCents: 0,
                      lineType: 'custom',
                      fulfillmentMethod: '',
                      sourceLocationId: '',
                      deliveryDate: '',
                    },
                  ])
                }
              >
                + Declined foundation ($0)
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setShowProductSearch(true)}
                data-testid="add-product"
              >
                <Search size={13} aria-hidden /> Add Product
              </Button>
            </>
          }
        >
          {lines.length === 0 ? (
            <EmptyState>No items yet — Add Product to start.</EmptyState>
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Price $</th>
                    <th>Disc $</th>
                    <th>Fulfillment</th>
                    <th>Inventory from</th>
                    <th className="num">Amount</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <LineRow
                      key={l.key}
                      line={l}
                      storeId={locationId}
                      locations={locations}
                      onPatch={patchLine}
                      onRemove={(k) => setLines((p) => p.filter((x) => x.key !== k))}
                    />
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title={<StepTitle n={3} label="Order details" />}>
          <FormGrid cols={3}>
            <Field label="Order type">
              <Select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as typeof orderType)}
                data-testid="order-type"
              >
                <option value="sales_order">Sales order</option>
                <option value="layaway">Layaway ($100 min deposit)</option>
                <option value="quote">Sales quote</option>
              </Select>
            </Field>
            <Field label="Store">
              <Select
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  const next = locations.find((l) => l.id === e.target.value);
                  if (next) setTaxRateBps(next.taxRateBps ?? taxRateBps);
                }}
              >
                {locations
                  .filter((l) => l.canSellHere !== false)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Fulfillment">
              <Select
                value={fulfillment}
                onChange={(e) => {
                  const next = e.target.value as Fulfillment;
                  setFulfillment(next);
                  // Re-default every stock line's source for the new mode:
                  // take-with pulls from the login store, delivery from
                  // the warehouse. The per-line "From" select still wins
                  // after this.
                  const wh = findWarehouse(locations);
                  setLines((prev) =>
                    prev.map((l) =>
                      l.lineType === 'custom'
                        ? l
                        : {
                            ...l,
                            sourceLocationId:
                              next === 'take_with' ? '' : wh && wh.id !== locationId ? wh.id : '',
                          },
                    ),
                  );
                }}
                data-testid="fulfillment-method"
              >
                {FULFILLMENTS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            {fulfillment !== 'take_with' && (
              <Field
                label={fulfillment === 'pickup' ? 'Pickup date' : 'Delivery date'}
                // The capacity note rides the field: muted while stops
                // remain, red (and marked invalid) once the day is full.
                hint={
                  fulfillment === 'delivery' &&
                  dayCapacity &&
                  dayCapacity.booked < dayCapacity.cap ? (
                    <span data-testid="newsale-capacity">
                      {`${dayCapacity.cap - dayCapacity.booked} of ${dayCapacity.cap} stops left that day`}
                    </span>
                  ) : undefined
                }
                error={
                  fulfillment === 'delivery' &&
                  dayCapacity &&
                  dayCapacity.booked >= dayCapacity.cap ? (
                    <span data-testid="newsale-capacity">
                      {`Full — ${dayCapacity.booked}/${dayCapacity.cap} stops (booking will need a capacity override)`}
                    </span>
                  ) : undefined
                }
              >
                <Input
                  type="date"
                  value={requestedDate}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setRequestedDate(e.target.value)}
                />
              </Field>
            )}
            {members.length > 0 && (
              <>
                <Field label="Salesperson">
                  <Select
                    value={salespeople[0] ?? ''}
                    onChange={(e) => setSalespeople([e.target.value, salespeople[1] ?? ''])}
                  >
                    <option value="">Me (signed in)</option>
                    {members.map((m) => (
                      <option key={m.membershipId} value={m.membershipId}>
                        {m.name?.trim() || m.email}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="2nd salesperson (equal split)">
                  <Select
                    value={salespeople[1] ?? ''}
                    onChange={(e) => setSalespeople([salespeople[0] ?? '', e.target.value])}
                  >
                    <option value="">None</option>
                    {members.map((m) => (
                      <option key={m.membershipId} value={m.membershipId}>
                        {m.name?.trim() || m.email}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            {fulfillment !== 'take_with' && (
              <Field label="Delivery / pickup instructions" className="form-span">
                <textarea
                  value={deliveryInstructions}
                  onChange={(e) => setDeliveryInstructions(e.target.value)}
                  rows={2}
                  className="textarea"
                />
              </Field>
            )}
            <Field label="Order notes (printed on the invoice)" className="form-span">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="textarea"
              />
            </Field>
          </FormGrid>
        </Card>
        {/* BA-0036: DOM-last so the entry path gets the first tab stops;
            CSS order keeps the strip visually on top. */}
        {drafts.length > 0 && (
          <Toolbar className="-order-1" data-testid="draft-chips">
            <span className="muted">Drafts:</span>
            {drafts.map((d) => (
              <span key={d.id} className="inline-flex items-center gap-1">
                <Button size="sm" variant="secondary" onClick={() => void resumeDraft(d.id)}>
                  {d.number} · {formatMoney(d.totalCents)}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete draft ${d.number}`}
                  title="Delete this draft"
                  data-testid="delete-draft"
                  onClick={() => {
                    if (!confirm(`Delete draft ${d.number}? This cannot be undone.`)) return;
                    void api(`/v1/orders/${d.id}/cancel`, {
                      method: 'POST',
                      body: JSON.stringify({ reason: 'draft deleted at the register' }),
                    })
                      .then(() => {
                        toast.success(`Draft ${d.number} deleted`);
                        loadDrafts();
                      })
                      .catch((err) =>
                        toast.error(err instanceof Error ? err.message : String(err)),
                      );
                  }}
                >
                  ✕
                </Button>
              </span>
            ))}
          </Toolbar>
        )}
      </div>

      {/* Pinned totals + payments rail */}
      <div>
        <Stack className="sticky top-3">
          <Card title="Totals">
            <Stack gap="sm" data-testid="totals-panel">
              <div>
                <TotalRow label="Merchandise" cents={totals.merchandise} />
                <TotalRow label="Discounts" cents={-totals.discounts} />
              </div>
              <FormGrid cols={2}>
                <Field label="Installation $">
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={installFee}
                    onChange={(e) => setInstallFee(e.target.value)}
                  />
                </Field>
                <Field label="Delivery $">
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={deliveryFee}
                    onChange={(e) => setDeliveryFee(e.target.value)}
                  />
                </Field>
              </FormGrid>
              <div>
                <TotalRow label="Recycling" cents={totals.recycling} />
                <TotalRow
                  label={
                    `Tax (${(taxRateBps / 100).toFixed(2)}%)` +
                    (totals.untaxedLines
                      ? ` · ${totals.untaxedLines} untaxed line${totals.untaxedLines === 1 ? '' : 's'}`
                      : '')
                  }
                  cents={totals.taxCents}
                />
              </div>
              <Field
                label="Order discount $"
                hint={
                  parseDollars(orderDiscount) > totals.orderDiscApplied
                    ? `Capped at the merchandise total — ${formatMoney(totals.orderDiscApplied)} applied.`
                    : undefined
                }
              >
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={orderDiscount}
                  onChange={(e) => setOrderDiscount(e.target.value)}
                />
              </Field>
              <div>
                <div className="flex justify-between text-lg font-bold">
                  <span>Total</span>
                  <span data-testid="grand-total">
                    <Money cents={totals.totalCents} />
                  </span>
                </div>
                <TotalRow label="Amount paid" cents={totals.paidCents} />
                <div className="flex justify-between font-semibold">
                  <span>Balance due</span>
                  <span data-testid="balance-due">
                    <Money cents={totals.balanceCents} />
                  </span>
                </div>
              </div>
            </Stack>
          </Card>

          <Card title="Payments">
            {storeCredit != null && storeCredit > 0 && (
              <Alert tone="success" data-testid="store-credit-chip">
                Store credit available: <strong>{formatMoney(storeCredit)}</strong> — use the “Store
                credit” tender to apply it.
              </Alert>
            )}
            <Stack gap="sm">
              {payments.length > 0 && (
                <div>
                  {payments.map((p) => (
                    <div key={p.key} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {TENDERS.find((t) => t.value === p.method)?.label}
                        {p.ref ? ` · ${p.ref}` : ''}
                      </span>
                      <Money cents={p.amountCents} />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setPayments((prev) => prev.filter((x) => x.key !== p.key))}
                        aria-label="Remove payment"
                      >
                        <X size={13} aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-[1fr_90px] gap-2">
                <Select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as Tender)}
                  data-testid="pay-method"
                  aria-label="Payment method"
                >
                  {TENDERS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  placeholder={(totals.balanceCents / 100).toFixed(2)}
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  data-testid="pay-amount"
                  aria-label="Payment amount"
                />
              </div>
              {/* BA-0003: this field renders for every method so the rail
                keeps one height and Complete never moves mid-aim. */}
              <Input
                placeholder={
                  payMethod === 'cash' ? 'Reference (optional)' : 'Reference / last 4 / approval #'
                }
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                aria-label="Payment reference"
                className="w-full"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={addPayment}
                  data-testid="add-payment"
                >
                  Add payment
                </Button>
                {totals.balanceCents > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPayAmount((totals.balanceCents / 100).toFixed(2))}
                  >
                    Exact balance
                  </Button>
                )}
              </div>
            </Stack>
          </Card>

          <div>
            <div aria-live="polite">{error && <Alert tone="error">{error}</Alert>}</div>
            <div className="flex flex-col gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void submit('complete')}
                data-testid="complete-sale"
              >
                {busy
                  ? 'Working…'
                  : orderType === 'quote'
                    ? `Save quote ${formatMoney(totals.totalCents)}`
                    : `Complete ${formatMoney(totals.totalCents)}`}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void submit('draft')}
                data-testid="save-draft"
              >
                Save as Draft
              </Button>
            </div>
          </div>
        </Stack>
      </div>

      {showProductSearch && (
        <ProductSearchDialog
          locationId={searchSourceId || locationId}
          locationName={
            locations.find((l) => l.id === (searchSourceId || locationId))?.name ?? null
          }
          locations={locations}
          storeId={locationId}
          onChangeLocation={(id) => setSearchSourceId(id === locationId ? '' : id)}
          onAdd={addProduct}
          onClose={() => setShowProductSearch(false)}
        />
      )}
    </div>
  );
}

function LineRow({
  line: l,
  storeId,
  locations,
  onPatch,
  onRemove,
}: {
  line: Line;
  storeId: string;
  locations: LocationRow[];
  onPatch: (key: string, patch: Partial<Line>) => void;
  onRemove: (key: string) => void;
}) {
  const amount = l.quantity * l.unitPriceCents - l.lineDiscountCents;
  const outOfStock = l.variantId && (l.availableHere ?? 1) <= 0;
  return (
    <>
      <tr>
        <td className="min-w-[180px]">{l.description}</td>
        <td>
          <Input
            type="number"
            min={1}
            max={999}
            value={l.quantity}
            aria-label={`Quantity for ${l.description}`}
            onChange={(e) => {
              // BA-0004/BA-0006: a typo must not delete the line or book
              // a billion-dollar order. Removal is the ✕ only; quantity
              // stays within 1–999.
              const qty = Math.floor(Number(e.target.value));
              if (!Number.isFinite(qty) || qty < 1) {
                if (e.target.value !== '') toast('Quantity stays at 1 — use ✕ to remove the line');
                onPatch(l.key, { quantity: l.quantity });
                return;
              }
              if (qty > 999) {
                toast('Quantity capped at 999');
                onPatch(l.key, { quantity: 999 });
                return;
              }
              onPatch(l.key, { quantity: qty });
            }}
            className="w-16"
          />
        </td>
        <td>
          {/* Price override: click, type, done. Small variances stay frictionless;
              deep ones hit the G6 reason/manager gate at save. */}
          <Input
            type="number"
            step="0.01"
            min={0}
            defaultValue={(l.unitPriceCents / 100).toFixed(2)}
            onBlur={(e) => onPatch(l.key, { unitPriceCents: parseDollars(e.target.value) })}
            aria-label={`Unit price for ${l.description}`}
            className="w-24"
            data-testid="line-price"
          />
        </td>
        <td>
          <Input
            type="number"
            step="0.01"
            min={0}
            placeholder="0.00"
            aria-label={`Discount for ${l.description}`}
            onBlur={(e) => onPatch(l.key, { lineDiscountCents: parseDollars(e.target.value) })}
            className="w-20"
          />
        </td>
        <td>
          {l.lineType === 'custom' ? (
            <span className="muted">fee</span>
          ) : (
            <Select
              value={l.fulfillmentMethod}
              onChange={(e) =>
                onPatch(l.key, { fulfillmentMethod: e.target.value as Line['fulfillmentMethod'] })
              }
              className="w-32"
              aria-label={`Fulfillment for ${l.description}`}
            >
              <option value="">Same as order</option>
              {FULFILLMENTS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          )}
        </td>
        <td>
          {l.lineType === 'custom' ? (
            <span className="muted">—</span>
          ) : (
            <Select
              value={l.sourceLocationId || storeId}
              onChange={(e) =>
                onPatch(l.key, {
                  sourceLocationId: e.target.value === storeId ? '' : e.target.value,
                })
              }
              className="w-36"
              aria-label={`Inventory source for ${l.description}`}
              data-testid="line-source"
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
          )}
        </td>
        <td className="num">
          <Money cents={amount} />
        </td>
        <td className="actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRemove(l.key)}
            aria-label="Remove line"
          >
            <X size={14} aria-hidden />
          </Button>
        </td>
      </tr>
      {outOfStock && (
        <tr>
          <td colSpan={8}>
            <Alert tone="warning" data-testid="atp-banner">
              Not in stock at the selected source location.
              {l.atpDate
                ? ` Available ~${new Date(l.atpDate).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })} via PO.`
                : ' No open PO — will special-order.'}
            </Alert>
          </td>
        </tr>
      )}
    </>
  );
}

function StepTitle({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="badge badge-brand">
        {n}
      </span>
      {label}
    </span>
  );
}

function TotalRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between muted">
      <span>{label}</span>
      <Money cents={cents} />
    </div>
  );
}

function customerName(c: CustomerHit): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.phone || 'Customer';
}

function addressPreview(c: CustomerHit): string {
  const a = c.addressesJson?.[0];
  if (!a) return '';
  return [a.line1, a.city].filter(Boolean).join(', ');
}

function addressFromCustomer(c: CustomerHit) {
  const a = c.addressesJson?.[0];
  if (!a) return undefined;
  return {
    line1: a.line1 ?? null,
    line2: null,
    city: a.city ?? null,
    region: a.region ?? null,
    postalCode: null,
    phone: c.phone ?? null,
  };
}

function parseDollars(s: string): number {
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

// Autocomplete option inside the customer popover — no shared listbox
// primitive exists yet, so the reset stays here (structural only).
const hitBtn = {
  display: 'block',
  width: '100%',
  textAlign: 'left' as const,
  padding: '8px 10px',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
};
