'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { LeadDialog } from '@/components/competition/lead-dialog';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
import { setDraftSummary } from '@/lib/api-status';
import { SELLING_STORE_KEY } from '@/lib/acting-store';
import {
  defaultSourceFor,
  effectiveFulfillment,
  lineWarning,
  pickerDefaultSource,
  resourceUntouched,
  singleWarehouse,
  sourceLabel,
  type Fulfillment,
  type SourcingContext,
} from '@/lib/pos-sourcing';
import { autofillFromZip, type ZipHit } from '@/lib/zip-lookup';
import { ProductSearchDialog, type SearchRow } from '@/components/product-search-dialog';
import { Money } from '@/components/money';
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  Kbd,
  LoadingRows,
  Select,
  StatusChip,
} from '@/components/ui';

/**
 * New Sale — the register (redesign Phase 4, README §3.1, canvas 4a–4f).
 *
 * Layout: content grid `minmax(0,1fr) 316px`. The items table takes the
 * full content width so Amount is always in view; the rail holds only
 * the customer, the order details, the totals and one action block.
 *
 * Sourcing (HANDOFF_inventory_source_defaults): Add Product opens from the
 * warehouse; a line whose effective fulfillment is take-with follows the
 * order's Store; untouched lines re-source when the order's fulfillment or
 * store changes and carry an `auto` badge; a touched line is never moved.
 * The rules live in `lib/pos-sourcing.ts`.
 *
 * Complete posts the order (or a plain register sale for a fully-paid
 * take-with), Save draft parks it store-wide. Everything locks when done;
 * the chip turns Scheduled; P prints, N starts the next sale.
 */

const FULFILLMENTS: { value: Fulfillment; label: string }[] = [
  { value: 'delivery', label: 'Delivery' },
  { value: 'pickup', label: 'Customer pickup' },
  { value: 'take_with', label: 'Take-with' },
  { value: 'direct_ship', label: 'Direct ship' },
];

const TENDERS = [
  { value: 'card', label: 'Card' },
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
const REMOVAL_DESC = 'Mattress Removal';
const DECLINED_DESC = 'Client Declined New Foundation';

interface CustomerHit {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  addressesJson: { line1?: string | null; city?: string | null; region?: string | null }[] | null;
}
interface Addons {
  removal: boolean;
  recycling: boolean;
  declined: boolean;
}
interface Line {
  key: string;
  variantId: string | null;
  description: string;
  sku: string | null;
  size: string | null;
  quantity: number;
  unitPriceCents: number;
  lineDiscountCents: number;
  lineType: 'stock' | 'special_order' | 'custom';
  fulfillmentMethod: '' | Fulfillment;
  /** Resolved source location id. */
  sourceLocationId: string;
  /** True once the salesperson picked the source by hand. */
  sourceTouched: boolean;
  deliveryDate: string;
  /** Removal / Recycling / Declined foundation toggles on mattress and base lines. */
  addons: Addons;
  atpDate?: string | null;
  /** Product's own tax rate (tax class); null = the store rate; 0 = untaxed. */
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
interface Avail {
  availableHere: number;
  atpDate: string | null;
  taxRateBps: number | null;
}

let lineKeySeq = 0;
const nextKey = () => `l${++lineKeySeq}`;
const NO_ADDONS: Addons = { removal: false, recycling: false, declined: false };

/** Add-on chips show on mattress and base lines only. */
function isMattressOrBase(description: string): boolean {
  return /mattress|foundation|box ?spring|adjustable|\bbase\b|hybrid|posturepedic|tempur/i.test(
    description,
  );
}

const EMPTY_ADDRESS = { line1: '', line2: '', city: '', region: '', postalCode: '' };
const EMPTY_NEW_CUSTOMER = {
  firstName: '',
  lastName: '',
  phone: '',
  phone2: '',
  email: '',
  referralSource: '',
  ...EMPTY_ADDRESS,
};

export function NewSale({ exchangeOf }: { exchangeOf?: string } = {}) {
  const router = useRouter();

  // --- reference data ---
  const [locations, setLocations] = useState<LocationRow[] | null>(null);
  const [locationId, setLocationId] = useState('');
  const [taxRateBps, setTaxRateBps] = useState(0);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [recyclingFeeCents, setRecyclingFeeCents] = useState(1050);
  const [defaultSourceLocationId, setDefaultSourceLocationId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [resumedDraft, setResumedDraft] = useState<{ id: string; number: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- customer ---
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [storeCredit, setStoreCredit] = useState<number | null>(null);
  const [openOrders, setOpenOrders] = useState<
    { id: string; number: string; requestedDate: string | null; deliveryDate: string | null }[]
  >([]);
  const [exchangeOriginal, setExchangeOriginal] = useState<{ id: string; number: string } | null>(
    null,
  );
  const [custQuery, setCustQuery] = useState('');
  const [leadOpen, setLeadOpen] = useState(false);
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  const [custMore, setCustMore] = useState(false);
  const [custOpen, setCustOpen] = useState(false);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [newCust, setNewCust] = useState(EMPTY_NEW_CUSTOMER);
  const [dupeWarn, setDupeWarn] = useState<{
    id: string;
    name: string;
    phone: string | null;
  } | null>(null);
  const [billDiffers, setBillDiffers] = useState(false);
  const [newBill, setNewBill] = useState(EMPTY_ADDRESS);
  const custTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const customerInput = useRef<HTMLInputElement>(null);

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
  const [moreOpen, setMoreOpen] = useState(false);

  // --- lines ---
  const [lines, setLines] = useState<Line[]>([]);
  const [showProductSearch, setShowProductSearch] = useState(false);
  /** Explicit "From" chosen in the picker for this draft; null = follows the rules. */
  const [pickerFrom, setPickerFrom] = useState<string | null>(null);
  const [avail, setAvail] = useState<Record<string, Avail>>({});

  // --- money ---
  const [orderDiscount, setOrderDiscount] = useState('');
  const [installFee, setInstallFee] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('');
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  const [payMethod, setPayMethod] = useState<Tender>('card');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');
  /** The "Take a payment" rail panel is open (F8 or the 44px button). */
  const [paying, setPaying] = useState(false);
  const [zeroOk, setZeroOk] = useState(false);
  const payAmountInput = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    id: string;
    number: string;
    kind: 'order' | 'sale';
    splitOrders?: { id: string; number: string; requestedDate: string | null }[];
    takeWith?: { orderId: string; number: string; completed: boolean; reason: string | null };
    bookedDeliveries?: string[];
    sources: string[];
    dueCents: number;
    at: Date;
  } | null>(null);
  const locked = done != null;

  const locs = useMemo(() => locations ?? [], [locations]);
  const store = locs.find((l) => l.id === locationId) ?? null;
  const ctx = useMemo<SourcingContext>(
    () => ({
      orderLocationId: locationId,
      orderFulfillment: fulfillment,
      locations: locs,
      defaultSourceLocationId,
    }),
    [locationId, fulfillment, locs, defaultSourceLocationId],
  );
  const nameOf = useCallback(
    (id: string) => locs.find((l) => l.id === id)?.name ?? 'the source',
    [locs],
  );

  // ---------------------------------------------------------------- effects

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

  // §7: while writing a delivery sale, show how many stops the chosen day has left.
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

  // G14: the customer's open orders — two trucks to one house is margin loss.
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

  // §10: store credit surfaces at checkout.
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
    api<{ id: string; number: string; customerId: string }>(`/v1/orders/${exchangeOf}`)
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
  }, [exchangeOf]);

  const loadDrafts = useCallback(() => {
    void api<{ data: DraftRow[] }>('/v1/orders?status=draft&limit=30')
      .then((r) => setDrafts(r.data))
      .catch(() => setDrafts([]));
  }, []);

  useEffect(() => {
    void api<LocationRow[]>('/v1/pos/locations')
      .then((rows) => {
        setLocations(rows);
        // The acting store (topbar chip) is the order's Store by default.
        let acting: LocationRow | undefined;
        try {
          const raw = sessionStorage.getItem(SELLING_STORE_KEY);
          if (raw) {
            const saved = JSON.parse(raw) as { id: string };
            acting = rows.find((l) => l.id === saved.id);
          }
        } catch {
          acting = undefined;
        }
        const selling =
          acting ?? rows.find((l) => l.canSellHere !== false && l.locationType !== 'warehouse');
        if (selling) {
          setLocationId(selling.id);
          setTaxRateBps(selling.taxRateBps ?? 0);
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    void api<MemberRow[]>('/v1/business/members')
      .then((rows) => setMembers(rows.filter((m) => m.status === 'active' && m.name?.trim())))
      .catch(() => setMembers([]));
    void api<{
      ops: { recyclingFeeCents?: number | null; defaultSourceLocationId?: string | null } | null;
    }>('/v1/business/settings/pos')
      .then((s) => {
        if (s.ops?.recyclingFeeCents != null) setRecyclingFeeCents(s.ops.recyclingFeeCents);
        setDefaultSourceLocationId(s.ops?.defaultSourceLocationId ?? null);
      })
      .catch(() => undefined);
    loadDrafts();
  }, [loadDrafts]);

  // The topbar chip changed the acting store: follow it while nothing is on the ticket.
  useEffect(() => {
    const onActing = (e: Event) => {
      const loc = (e as CustomEvent<{ id: string }>).detail;
      if (!loc || lines.length > 0 || customer || locked) return;
      const row = locs.find((l) => l.id === loc.id);
      if (row && row.canSellHere !== false) {
        setLocationId(row.id);
        setTaxRateBps(row.taxRateBps ?? 0);
      }
    };
    window.addEventListener('erp:acting-store', onActing);
    return () => window.removeEventListener('erp:acting-store', onActing);
  }, [locs, lines.length, customer, locked]);

  // Universal customer search — debounced.
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
          setCustMore(r.nextCursor != null || r.data.length >= 20);
          setCustOpen(true);
        })
        .catch(() => {
          setCustHits([]);
          setCustMore(false);
        });
    }, 250);
  }, [custQuery]);

  // Sourcing: untouched lines follow the order's fulfillment / store / default.
  useEffect(() => {
    if (!locationId) return;
    setLines((prev) => resourceUntouched(prev, ctx));
  }, [ctx, locationId]);

  // Availability per (source, variant): fetched once per pair, cached.
  useEffect(() => {
    const need = new Map<string, string[]>();
    for (const l of lines) {
      if (!l.variantId || !l.sourceLocationId) continue;
      if (avail[`${l.sourceLocationId}:${l.variantId}`]) continue;
      need.set(l.sourceLocationId, [...(need.get(l.sourceLocationId) ?? []), l.variantId]);
    }
    if (need.size === 0) return;
    let stale = false;
    void Promise.all(
      [...need.entries()].map(async ([loc, ids]) => {
        try {
          const rows = await api<SearchRow[]>(
            `/v1/pos/product-search?locationId=${loc}&variantIds=${[...new Set(ids)].join(',')}&limit=100`,
          );
          return rows.map((r) => [
            `${loc}:${r.variantId}`,
            {
              availableHere: r.availableHere,
              atpDate: r.atpDate,
              taxRateBps: r.taxRateBps ?? null,
            } satisfies Avail,
          ]);
        } catch {
          return [] as [string, Avail][];
        }
      }),
    ).then((chunks) => {
      if (stale) return;
      const add = Object.fromEntries(chunks.flat() as [string, Avail][]);
      if (Object.keys(add).length > 0) setAvail((prev) => ({ ...prev, ...add }));
    });
    return () => {
      stale = true;
    };
  }, [lines, avail]);

  // BA-0001: an in-progress sale must not vanish on a stray nav click.
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
        !window.confirm("This sale isn't saved — leave anyway? Use Save draft first to keep it.")
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

  // ---------------------------------------------------------------- totals

  const totals = useMemo(() => {
    let merchandise = 0;
    let recycling = 0;
    let lineDiscount = 0;
    for (const l of lines) {
      const gross = l.quantity * l.unitPriceCents;
      if (l.lineType === 'custom' && l.description === RECYCLING_DESC) recycling += gross;
      else merchandise += gross;
      if (l.addons.recycling) recycling += l.quantity * recyclingFeeCents;
      lineDiscount += Math.min(l.lineDiscountCents, gross);
    }
    const install = parseDollars(installFee);
    const delivery = parseDollars(deliveryFee);
    const afterLines = merchandise - lineDiscount;
    const orderDisc = Math.min(parseDollars(orderDiscount), Math.max(0, afterLines));
    // Tax mirrors sales/totals.ts: custom lines (fees, removal) are
    // untaxed; every product line taxes at its own rate on its net less
    // its pro-rata share of the order discount.
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
      orderDiscApplied: orderDisc,
      install,
      delivery,
      taxCents,
      untaxedLines,
      totalCents,
      paidCents,
      balanceCents: Math.max(0, totalCents - paidCents),
    };
  }, [lines, orderDiscount, installFee, deliveryFee, taxRateBps, payments, recyclingFeeCents]);

  const availFor = useCallback(
    (l: Line): Avail | undefined =>
      l.variantId ? avail[`${l.sourceLocationId}:${l.variantId}`] : undefined,
    [avail],
  );
  const anyShort = lines.some((l) => {
    const a = availFor(l);
    return l.lineType !== 'custom' && a != null && a.availableHere < l.quantity;
  });
  const hasZero = lines.some((l) => l.lineType !== 'custom' && l.unitPriceCents === 0);
  const zeroBlock = hasZero && !zeroOk;
  const status: 'draft' | 'waiting' | 'scheduled' = locked
    ? 'scheduled'
    : anyShort
      ? 'waiting'
      : 'draft';

  // Name the draft for the shell's outage banner.
  useEffect(() => {
    if (lines.length === 0 || locked) {
      setDraftSummary(null);
      return;
    }
    const n = resumedDraft?.number ?? 'this draft';
    setDraftSummary(
      `${n} (${lines.length} line${lines.length === 1 ? '' : 's'}, ${formatMoney(totals.totalCents)})`,
    );
    return () => setDraftSummary(null);
  }, [lines.length, totals.totalCents, resumedDraft, locked]);

  // ---------------------------------------------------------------- lines

  function addProduct(row: SearchRow, fromId: string) {
    const auto = defaultSourceFor(fulfillment, ctx);
    setAvail((prev) => ({
      ...prev,
      [`${fromId}:${row.variantId}`]: {
        availableHere: row.availableHere,
        atpDate: row.atpDate,
        taxRateBps: row.taxRateBps ?? null,
      },
    }));
    setLines((prev) => [
      ...prev,
      // Adding the same product again always makes a NEW line — a second
      // unit often sells at a different price.
      {
        key: nextKey(),
        variantId: row.variantId,
        description: [row.productName, row.variantName].filter(Boolean).join(' — '),
        sku: row.sku,
        size: row.size,
        quantity: 1,
        unitPriceCents: row.priceCents,
        lineDiscountCents: 0,
        lineType: 'stock',
        fulfillmentMethod: '',
        sourceLocationId: fromId,
        // A "From" the salesperson picked in the dialog is their choice;
        // the rules only move lines they have not touched.
        sourceTouched: fromId !== auto,
        deliveryDate: '',
        addons: { ...NO_ADDONS },
        atpDate: row.atpDate,
        taxRateBps: row.taxRateBps ?? null,
      },
    ]);
    setShowProductSearch(false);
    toast.success(
      `${row.productName}${row.size ? `, ${row.size}` : ''} added · from ${nameOf(fromId)}`,
    );
  }

  function patchLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function setLineFulfillment(key: string, next: '' | Fulfillment) {
    setLines((prev) =>
      resourceUntouched(
        prev.map((l) => (l.key === key ? { ...l, fulfillmentMethod: next } : l)),
        ctx,
      ),
    );
  }

  function setLineSource(key: string, id: string) {
    patchLine(key, { sourceLocationId: id, sourceTouched: true });
  }

  function toggleAddon(key: string, which: keyof Addons) {
    setLines((prev) =>
      prev.map((l) =>
        l.key === key ? { ...l, addons: { ...l.addons, [which]: !l.addons[which] } } : l,
      ),
    );
  }

  /** Lines as the API wants them: add-ons become the custom fee lines the invoice prints. */
  function expandLines() {
    const out: {
      variantId?: string;
      description?: string;
      quantity: number;
      unitPriceCents: number;
      lineDiscountCents?: number;
      lineType: Line['lineType'];
      fulfillmentMethod?: Fulfillment;
      sourceLocationId?: string;
      deliveryDate?: string;
    }[] = [];
    const fee = (description: string, quantity: number, unitPriceCents: number) =>
      out.push({ description, quantity, unitPriceCents, lineType: 'custom' });
    for (const l of lines) {
      out.push({
        variantId: l.variantId ?? undefined,
        description: l.lineType === 'custom' ? l.description : undefined,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        lineDiscountCents: l.lineDiscountCents || undefined,
        lineType: l.lineType,
        fulfillmentMethod: l.fulfillmentMethod || undefined,
        // Sent whenever it differs from the order's store; the server
        // applies the same resolution order for anything left blank.
        sourceLocationId:
          l.lineType !== 'custom' && l.sourceLocationId && l.sourceLocationId !== locationId
            ? l.sourceLocationId
            : undefined,
        deliveryDate: l.deliveryDate || undefined,
      });
      if (l.addons.removal) fee(REMOVAL_DESC, l.quantity, 0);
      if (l.addons.recycling) fee(RECYCLING_DESC, l.quantity, recyclingFeeCents);
      if (l.addons.declined) fee(DECLINED_DESC, 1, 0);
    }
    return out;
  }

  function addPayment() {
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
    // Repeat to $0: the panel stays open for the next tender and closes on
    // its own once nothing is left to collect (canvas 4d).
    if (totals.balanceCents - cents <= 0) setPaying(false);
    else payAmountInput.current?.focus();
  }

  async function resumeDraft(id: string) {
    setError(null);
    setDraftsOpen(false);
    try {
      const o = await api<{
        id: string;
        number: string;
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
      const f = (o.fulfillmentType as Fulfillment) ?? 'delivery';
      const nextCtx: SourcingContext = {
        ...ctx,
        orderLocationId: o.locationId,
        orderFulfillment: f,
      };
      setCustomer(cust);
      setLocationId(o.locationId);
      setTaxRateBps(locs.find((l) => l.id === o.locationId)?.taxRateBps ?? taxRateBps);
      setFulfillment(f);
      setRequestedDate(o.requestedDate ?? '');
      setDeliveryInstructions(o.deliveryInstructions ?? '');
      setNotes(o.notes ?? '');
      setOrderDiscount(o.orderDiscountCents ? (o.orderDiscountCents / 100).toFixed(2) : '');
      setInstallFee(o.installFeeCents ? (o.installFeeCents / 100).toFixed(2) : '');
      setDeliveryFee(o.deliveryFeeCents ? (o.deliveryFeeCents / 100).toFixed(2) : '');
      setLines(
        o.lines.map((l) => {
          const fm = (l.fulfillmentMethod as Line['fulfillmentMethod']) ?? '';
          const eff = effectiveFulfillment({ fulfillmentMethod: fm }, f);
          const autoSource = defaultSourceFor(eff, nextCtx);
          const source = l.sourceLocationId ?? o.locationId;
          return {
            key: nextKey(),
            variantId: l.variantId,
            description: l.description,
            sku: null,
            size: null,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            lineDiscountCents: l.discountCents,
            lineType: (l.lineType as Line['lineType']) ?? 'stock',
            fulfillmentMethod: fm,
            sourceLocationId: source,
            // A stored source that differs from the rule was a choice.
            sourceTouched: source !== autoSource,
            deliveryDate: l.deliveryDate ?? '',
            addons: { ...NO_ADDONS },
            taxRateBps: l.lineType === 'custom' ? 0 : (l.taxRateBps ?? null),
          };
        }),
      );
      setResumedDraft({ id, number: o.number });
      toast.success(`${o.number} resumed — completing it replaces the draft`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ---------------------------------------------------------------- submit

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
    if (mode === 'complete' && zeroBlock) {
      setError('A line is priced at $0.00 — fix the price or confirm it is intentional.');
      return;
    }
    if (mode === 'complete' && parseDollars(payAmount) > 0) {
      setError(
        `You typed $${payAmount} in the payment box but didn't record it — press Record, or clear the box, then Complete.`,
      );
      return;
    }
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
    if (mode === 'complete' && requestedDate) {
      const lateLines = lines.filter((l) => {
        const a = availFor(l);
        return a?.atpDate && a.atpDate > requestedDate;
      });
      if (lateLines.length > 0) {
        const ok = window.confirm(
          `Promised ${requestedDate}, but not expected until ${lateLines
            .map((l) => `${l.description} (${availFor(l)?.atpDate})`)
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
    const linePayload = expandLines();
    const sources = [
      ...new Set(
        lines.filter((l) => l.lineType !== 'custom').map((l) => nameOf(l.sourceLocationId)),
      ),
    ];

    // Take-with fully paid, all real stock, no fee lines → a plain register sale.
    const allSellable = lines.every((l) => l.lineType !== 'special_order');
    if (
      !exchangeOriginal &&
      mode === 'complete' &&
      orderType === 'sales_order' &&
      fulfillment === 'take_with' &&
      linePayload.every((l) => l.lineType !== 'custom') &&
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
          payments: [
            {
              method: payments[0]?.method === 'cash' ? 'cash' : 'card',
              amountCents: totals.totalCents,
            },
          ],
        }),
      });
      if (resumedDraft) await cancelDraft(resumedDraft.id);
      setDone({
        id: sale.id,
        number: sale.number,
        kind: 'sale',
        sources,
        dueCents: 0,
        at: new Date(),
      });
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
        splitBps: sp.length === 2 ? 5000 : undefined,
        lines: linePayload,
        orderDiscountCents: parseDollars(orderDiscount) || undefined,
        installFeeCents: parseDollars(installFee) || undefined,
        deliveryFeeCents: parseDollars(deliveryFee) || undefined,
        draft: mode === 'draft' ? true : undefined,
        confirm: mode === 'complete' && orderType !== 'quote' ? true : undefined,
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
    if (resumedDraft && resumedDraft.id !== order.id) await cancelDraft(resumedDraft.id);

    // Take-with hand-over: completing a sale with take-with lines splits
    // them to a -A piece and completes it when stock and money allow.
    let takeWith: NonNullable<typeof done>['takeWith'];
    if (
      mode === 'complete' &&
      orderType !== 'quote' &&
      lines.some(
        (l) => effectiveFulfillment(l, fulfillment) === 'take_with' && l.lineType !== 'custom',
      )
    ) {
      try {
        const res = await api<{
          takeWith?: { orderId: string; number: string; completed: boolean; reason: string | null };
        }>(`/v1/orders/${order.id}/complete`, { method: 'POST', body: JSON.stringify({}) });
        takeWith = res.takeWith;
      } catch {
        takeWith = undefined;
      }
    }

    // The delivery date books the truck (one per split sibling on its own date).
    const bookedDeliveries: string[] = [];
    if (mode === 'complete' && orderType !== 'quote' && fulfillment === 'delivery') {
      const truckBound = lines.some(
        (l) =>
          l.lineType !== 'custom' &&
          !['take_with', 'pickup'].includes(effectiveFulfillment(l, fulfillment)),
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
        sources,
        dueCents: Math.max(0, order.totalCents - totals.paidCents),
        at: new Date(),
      });
    }
  }

  async function cancelDraft(id: string) {
    await api(`/v1/orders/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'superseded by completed New Sale' }),
    }).catch(() => undefined);
  }

  function clearNewCustomer() {
    setNewCust(EMPTY_NEW_CUSTOMER);
    setNewBill(EMPTY_ADDRESS);
    setBillDiffers(false);
    setDupeWarn(null);
    zipMemo.current.cust = null;
    zipMemo.current.bill = null;
  }

  async function attachExistingCustomer(idToUse: string) {
    try {
      const existing = await api<CustomerHit>(`/v1/customers/${idToUse}`);
      setCustomer(existing);
      setCreatingCustomer(false);
      clearNewCustomer();
      toast.success('Attached the existing customer — no duplicate created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const resetAll = useCallback(() => {
    setCustomer(null);
    setCustQuery('');
    setCreatingCustomer(false);
    clearNewCustomer();
    setLines([]);
    setPayments([]);
    setPayAmount('');
    setPayRef('');
    setPaying(false);
    setOrderDiscount('');
    setInstallFee('');
    setDeliveryFee('');
    setNotes('');
    setDeliveryInstructions('');
    setRequestedDate('');
    setShipDiffers(false);
    setPickerFrom(null);
    setZeroOk(false);
    setResumedDraft(null);
    setOrderType('sales_order');
    setError(null);
    setDone(null);
    // After a completed sale the cursor rests on New sale, not the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function printReceipt() {
    if (!done) return;
    const href =
      done.kind === 'sale' ? `/sales/${done.id}` : `/print/orders/${done.id}/invoice?scope=order`;
    window.open(href, '_blank', 'noopener');
  }

  // Register keys: F2 add product, F8 take payment, Esc closes the picker,
  // P prints when complete, N starts the next sale when complete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable);
      if (e.key === 'F2' && !locked) {
        e.preventDefault();
        setShowProductSearch(true);
      } else if (e.key === 'F8' && !locked) {
        e.preventDefault();
        setPaying(true);
        payAmountInput.current?.focus();
        payAmountInput.current?.select();
      } else if (!typing && locked && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        printReceipt();
      } else if (!typing && locked && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        resetAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, resetAll]);

  // Opening the panel (button or F8) puts the cursor in Amount.
  useEffect(() => {
    if (!paying) return;
    const id = window.requestAnimationFrame(() => {
      payAmountInput.current?.focus();
      payAmountInput.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [paying]);

  // ---------------------------------------------------------------- render

  const pickerLocation = pickerFrom ?? (locationId ? pickerDefaultSource(ctx) : '');
  // Footer sentence in the picker: where added lines will source from and why.
  const pickerNote = !locationId
    ? ''
    : pickerFrom
      ? '(your choice for this draft)'
      : fulfillment === 'take_with'
        ? 'because the order is take-with'
        : pickerLocation !== locationId
          ? '— the default; take-with lines switch to the store'
          : singleWarehouse(ctx.locations)
            ? '— the default'
            : '';
  const payDisabled = zeroBlock || lines.length === 0 || totals.balanceCents === 0;
  const payAmountCents = payAmount.trim() ? parseDollars(payAmount) : 0;
  const dueLabel =
    totals.balanceCents === 0 && lines.length > 0
      ? 'Paid in full'
      : totals.paidCents > 0
        ? 'Balance due'
        : 'Due';
  const completeLabel =
    orderType === 'quote'
      ? 'Save quote'
      : totals.balanceCents === 0 && lines.length > 0
        ? 'Complete sale'
        : 'Complete with balance';
  const completeHint = !customer
    ? 'Add a customer to complete'
    : lines.length === 0
      ? ' '
      : totals.balanceCents > 0
        ? `${formatMoney(totals.balanceCents)} collected at ${fulfillment === 'delivery' ? 'the door' : 'pickup'}`
        : "Reserves stock at each line's source";
  const draftNumber = done?.number ?? resumedDraft?.number ?? null;

  return (
    <div className="register" data-density="register" data-testid="new-sale">
      <header className="reg-head">
        <div>
          <div className="t-label">Sell · {store?.name ?? '…'}</div>
          <div className="reg-title-row">
            <h1 className="reg-title">{locked ? 'Sale' : 'New sale'}</h1>
            {draftNumber && <span className="reg-number">{draftNumber}</span>}
            <StatusChip status={status} data-testid="register-status" />
          </div>
        </div>
        <div className="reg-head-end">
          <span className="reg-save-note">
            {locked
              ? `Completed ${done!.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
              : resumedDraft
                ? 'Draft resumed · completing it replaces the draft'
                : lines.length > 0
                  ? 'Save draft keeps this for the store'
                  : ' '}
          </span>
          {!locked && drafts.length > 0 && (
            <Button size="sm" onClick={() => setDraftsOpen((v) => !v)} aria-expanded={draftsOpen}>
              Resume a draft <span className="mono">{drafts.length}</span>
            </Button>
          )}
        </div>
      </header>

      {draftsOpen && drafts.length > 0 && (
        <div className="reg-drafts" data-testid="draft-chips">
          {drafts.map((d) => (
            <div key={d.id} className="reg-draft-row">
              <button
                type="button"
                className="reg-draft-btn"
                onClick={() => void resumeDraft(d.id)}
              >
                <span className="mono">{d.number}</span>
                <span className="reg-draft-when">{ago(d.createdAt)}</span>
                <span className="mono reg-draft-total">{formatMoney(d.totalCents)}</span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete draft ${d.number}`}
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
                    .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
                }}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}

      {exchangeOriginal && (
        <Alert tone="warning" data-testid="exchange-banner">
          Writing an <strong>Exchange Order</strong> against original invoice{' '}
          <strong>{exchangeOriginal.number}</strong> — the document prints with the original number,
          and the customer is fixed to the original order&apos;s.
        </Alert>
      )}
      {!exchangeOriginal && openOrders.length > 0 && (
        <Alert tone="warning" data-testid="duplicate-order-banner">
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
      {loadError && (
        <Alert
          tone="error"
          action={
            <Button size="sm" onClick={() => location.reload()}>
              Retry
            </Button>
          }
        >
          The register could not load its stores: {loadError}
        </Alert>
      )}

      <div className="reg-grid">
        {/* ---------------------------------------------------------- items */}
        <section className="reg-items" aria-labelledby="reg-items-title">
          <div className="reg-section-head">
            <h2 id="reg-items-title" className="t-title">
              Items
            </h2>
            <span className="reg-count mono">
              {lines.length} line{lines.length === 1 ? '' : 's'}
            </span>
            <span className="reg-section-note">Stock is reserved when the sale completes</span>
            <Button
              variant="primary"
              kbd="F2"
              onClick={() => setShowProductSearch(true)}
              disabled={locked || !locationId}
              data-testid="add-product"
            >
              Add product
            </Button>
          </div>
          {locations == null ? (
            <LoadingRows rows={4} height={44} what="The register" />
          ) : lines.length === 0 ? (
            <EmptyState
              title="No items yet"
              action={
                <>
                  <Button
                    variant="primary"
                    onClick={() => setShowProductSearch(true)}
                    disabled={locked}
                  >
                    Add product
                  </Button>
                  {drafts.length > 0 && (
                    <Button onClick={() => setDraftsOpen(true)}>Resume a draft</Button>
                  )}
                </>
              }
            >
              Press <Kbd keys="F2" /> or Add product. Lines source from the{' '}
              {nameOf(defaultSourceFor('delivery', ctx))} unless the customer is taking them today.
            </EmptyState>
          ) : (
            <div className="reg-table-wrap">
              <table className="table reg-table">
                <colgroup>
                  <col />
                  <col style={{ width: 62 }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 80 }} />
                  <col style={{ width: 148 }} />
                  <col style={{ width: 172 }} />
                  <col style={{ width: 104 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Price</th>
                    <th className="num">Disc</th>
                    <th>Fulfillment</th>
                    <th>Inventory from</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <LineRow
                      key={l.key}
                      line={l}
                      locked={locked}
                      ctx={ctx}
                      storeName={store?.name ?? 'the store'}
                      avail={availFor(l)}
                      recyclingFeeCents={recyclingFeeCents}
                      onPatch={patchLine}
                      onFulfillment={setLineFulfillment}
                      onSource={setLineSource}
                      onAddon={toggleAddon}
                      onRemove={(k) => setLines((p) => p.filter((x) => x.key !== k))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ----------------------------------------------------------- rail */}
        <aside className="reg-rail">
          <section className="reg-card" aria-labelledby="reg-cust-title">
            <div className="reg-card-head">
              <h2 id="reg-cust-title" className="t-title">
                Customer
              </h2>
              {customer && (
                <a href={`/customers/${customer.id}`} className="reg-link">
                  History
                </a>
              )}
            </div>
            {customer ? (
              <div className="reg-customer">
                <div style={{ minWidth: 0 }}>
                  <div className="reg-customer-name" data-testid="order-customer">
                    {customerName(customer)}
                  </div>
                  <div className="reg-customer-sub mono">{customer.phone ?? '—'}</div>
                  <div className="reg-customer-sub">
                    {[customer.email, addressPreview(customer)].filter(Boolean).join(' · ')}
                    {storeCredit != null && storeCredit > 0 && (
                      <span data-testid="store-credit-chip">
                        {' · '}
                        {formatMoney(storeCredit)} store credit
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCustomer(null)}
                  disabled={locked}
                >
                  Change
                </Button>
              </div>
            ) : creatingCustomer ? (
              <NewCustomerForm
                value={newCust}
                onChange={setNewCust}
                bill={newBill}
                onBill={setNewBill}
                billDiffers={billDiffers}
                onBillDiffers={setBillDiffers}
                zipMemo={zipMemo}
                dupeWarn={dupeWarn}
                onUseExisting={(id) => void attachExistingCustomer(id)}
                busy={creatingBusy}
                onCancel={() => {
                  setCreatingCustomer(false);
                  clearNewCustomer();
                }}
                onCreate={() => {
                  const addr = (a: typeof EMPTY_ADDRESS) => ({
                    line1: a.line1.trim() || null,
                    line2: a.line2.trim() || null,
                    city: a.city.trim() || null,
                    region: a.region.trim() || null,
                    postalCode: a.postalCode.trim() || null,
                  });
                  const hasAddr = (a: { line1: string; city: string }) =>
                    Boolean(a.line1.trim() || a.city.trim());
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
                      clearNewCustomer();
                    })
                    .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setCreatingBusy(false));
                }}
              />
            ) : (
              <div className="reg-cust-search">
                <Field label="Phone or name">
                  <Input
                    ref={customerInput}
                    value={custQuery}
                    onChange={(e) => setCustQuery(e.target.value)}
                    placeholder="(818) 555-…"
                    data-testid="customer-search"
                    autoFocus
                    autoComplete="off"
                  />
                </Field>
                {custOpen && custHits.length > 0 && (
                  <div className="reg-cust-hits" role="listbox" aria-label="Matching customers">
                    {custHits.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="reg-cust-hit"
                        data-testid="customer-hit"
                        onClick={() => {
                          setCustomer(c);
                          setCustOpen(false);
                          setCustQuery('');
                        }}
                      >
                        <span className="reg-cust-hit-name">{customerName(c)}</span>
                        <span className="reg-cust-hit-sub">{addressPreview(c)}</span>
                        <span className="mono reg-cust-hit-phone">{c.phone ?? ''}</span>
                      </button>
                    ))}
                    {custMore && <div className="reg-cust-more">More matches — keep typing.</div>}
                  </div>
                )}
                {leadOpen && (
                  <LeadDialog
                    onClose={() => setLeadOpen(false)}
                    actorName={null}
                    locationId={locationId || null}
                    initial={/\d{3}/.test(custQuery) ? { phone: custQuery } : { name: custQuery }}
                    onSaved={() => setCustQuery('')}
                  />
                )}
                <div className="reg-cust-actions">
                  <Button
                    onClick={() => {
                      clearNewCustomer();
                      setCreatingCustomer(true);
                    }}
                    disabled={locked}
                  >
                    New customer
                  </Button>
                  {/* Redesign Phase 11: the customer who is walking out. */}
                  <Button
                    variant="ghost"
                    onClick={() => setLeadOpen(true)}
                    disabled={locked}
                    data-testid="log-as-lead"
                  >
                    Log as lead instead
                  </Button>
                </div>
              </div>
            )}
            {customer && fulfillment !== 'take_with' && (
              <label className="reg-check">
                <input
                  type="checkbox"
                  checked={shipDiffers}
                  onChange={(e) => setShipDiffers(e.target.checked)}
                  disabled={locked}
                />
                Ship to a different address
              </label>
            )}
            {customer && shipDiffers && fulfillment !== 'take_with' && (
              <div className="reg-stack">
                <Input
                  placeholder="Address line 1"
                  aria-label="Address line 1"
                  value={ship.line1}
                  onChange={(e) => setShip({ ...ship, line1: e.target.value })}
                  disabled={locked}
                />
                <Input
                  placeholder="Line 2"
                  aria-label="Line 2"
                  value={ship.line2}
                  onChange={(e) => setShip({ ...ship, line2: e.target.value })}
                  disabled={locked}
                />
                <div className="reg-two">
                  <Input
                    placeholder="City"
                    aria-label="City"
                    value={ship.city}
                    onChange={(e) => setShip({ ...ship, city: e.target.value })}
                    disabled={locked}
                  />
                  <Input
                    placeholder="State"
                    aria-label="State"
                    value={ship.region}
                    onChange={(e) => setShip({ ...ship, region: e.target.value })}
                    disabled={locked}
                  />
                </div>
                <div className="reg-two">
                  <Input
                    placeholder="ZIP"
                    aria-label="ZIP"
                    value={ship.postalCode}
                    onChange={(e) =>
                      autofillFromZip(e.target.value, setShip, zipMemo.current, 'ship')
                    }
                    disabled={locked}
                  />
                  <Input
                    placeholder="Phone at address"
                    aria-label="Phone at address"
                    value={ship.phone}
                    onChange={(e) => setShip({ ...ship, phone: e.target.value })}
                    disabled={locked}
                  />
                </div>
              </div>
            )}
          </section>

          <section className="reg-card" aria-labelledby="reg-order-title">
            <h2 id="reg-order-title" className="t-title">
              Order details
            </h2>
            <div className="reg-two">
              <Field label="Store">
                <Select
                  value={locationId}
                  onChange={(e) => {
                    setLocationId(e.target.value);
                    const next = locs.find((l) => l.id === e.target.value);
                    if (next) setTaxRateBps(next.taxRateBps ?? taxRateBps);
                  }}
                  disabled={locked}
                  data-testid="order-store"
                >
                  {locs
                    .filter((l) => l.canSellHere !== false && l.locationType !== 'warehouse')
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
                    setFulfillment(e.target.value as Fulfillment);
                    setPickerFrom(null);
                  }}
                  disabled={locked}
                  data-testid="fulfillment-method"
                >
                  {FULFILLMENTS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={fulfillment === 'take_with' ? 'Taken' : 'Promised'}
                hint={
                  fulfillment === 'delivery' &&
                  dayCapacity &&
                  dayCapacity.booked < dayCapacity.cap ? (
                    <span data-testid="newsale-capacity">
                      {dayCapacity.cap - dayCapacity.booked} of {dayCapacity.cap} stops left
                    </span>
                  ) : undefined
                }
                error={
                  fulfillment === 'delivery' &&
                  dayCapacity &&
                  dayCapacity.booked >= dayCapacity.cap ? (
                    <span data-testid="newsale-capacity">
                      Full — {dayCapacity.booked}/{dayCapacity.cap} stops
                    </span>
                  ) : undefined
                }
              >
                <Input
                  type="date"
                  value={
                    fulfillment === 'take_with'
                      ? new Date().toISOString().slice(0, 10)
                      : requestedDate
                  }
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setRequestedDate(e.target.value)}
                  disabled={locked || fulfillment === 'take_with'}
                  className="input-mono"
                />
              </Field>
              <Field label="Salesperson">
                <Select
                  value={salespeople[0] ?? ''}
                  onChange={(e) => setSalespeople([e.target.value, salespeople[1] ?? ''])}
                  disabled={locked}
                >
                  <option value="">Me (signed in)</option>
                  {members.map((m) => (
                    <option key={m.membershipId} value={m.membershipId}>
                      {m.name?.trim() || m.email}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <button
              type="button"
              className="reg-more"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              {moreOpen ? '▾' : '▸'} More — type, second salesperson, notes, fees
            </button>
            {moreOpen && (
              <div className="reg-stack">
                <Field label="Order type">
                  <Select
                    value={orderType}
                    onChange={(e) => setOrderType(e.target.value as typeof orderType)}
                    disabled={locked}
                    data-testid="order-type"
                  >
                    <option value="sales_order">Sales order</option>
                    <option value="layaway">Layaway ($100 min deposit)</option>
                    <option value="quote">Sales quote</option>
                  </Select>
                </Field>
                <Field label="2nd salesperson (equal split)">
                  <Select
                    value={salespeople[1] ?? ''}
                    onChange={(e) => setSalespeople([salespeople[0] ?? '', e.target.value])}
                    disabled={locked}
                  >
                    <option value="">None</option>
                    {members.map((m) => (
                      <option key={m.membershipId} value={m.membershipId}>
                        {m.name?.trim() || m.email}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="reg-two">
                  <Field label="Delivery fee">
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={deliveryFee}
                      onChange={(e) => setDeliveryFee(e.target.value)}
                      disabled={locked}
                      className="input-num"
                    />
                  </Field>
                  <Field label="Installation">
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={installFee}
                      onChange={(e) => setInstallFee(e.target.value)}
                      disabled={locked}
                      className="input-num"
                    />
                  </Field>
                </div>
                <Field
                  label="Order discount"
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
                    disabled={locked}
                    className="input-num"
                  />
                </Field>
                {fulfillment !== 'take_with' && (
                  <Field label="Delivery / pickup instructions">
                    <textarea
                      value={deliveryInstructions}
                      onChange={(e) => setDeliveryInstructions(e.target.value)}
                      rows={2}
                      className="textarea"
                      disabled={locked}
                    />
                  </Field>
                )}
                <Field label="Order notes (printed on the invoice)">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className="textarea"
                    disabled={locked}
                  />
                </Field>
              </div>
            )}
          </section>

          <section className="reg-card reg-totals" aria-label="Totals" data-testid="totals-panel">
            <TotalRow label="Merchandise" cents={totals.merchandise} />
            <TotalRow label="Discounts" cents={-totals.discounts} />
            {totals.recycling > 0 && <TotalRow label="Recycling" cents={totals.recycling} />}
            {totals.install > 0 && <TotalRow label="Installation" cents={totals.install} />}
            <TotalRow label="Delivery" cents={totals.delivery} />
            <TotalRow
              label={`Tax ${(taxRateBps / 100).toFixed(taxRateBps % 100 === 0 ? 0 : 2)}%${
                totals.untaxedLines ? ` · ${totals.untaxedLines} untaxed` : ''
              }`}
              cents={totals.taxCents}
            />
            <div className="reg-total">
              <span>Total</span>
              <span className="reg-total-value" data-testid="grand-total">
                <Money cents={totals.totalCents} />
              </span>
            </div>
            {payments.map((p) => (
              <div key={p.key} className="reg-total-row reg-payment">
                <span>
                  {TENDERS.find((t) => t.value === p.method)?.label}
                  {p.ref ? <span className="mono"> ••{p.ref.slice(-4)}</span> : null}
                  {!locked && (
                    <button
                      type="button"
                      className="reg-text-btn"
                      onClick={() => setPayments((prev) => prev.filter((x) => x.key !== p.key))}
                    >
                      remove
                    </button>
                  )}
                </span>
                <span className="mono">−{formatMoney(p.amountCents)}</span>
              </div>
            ))}
            <div
              className={`reg-due${totals.balanceCents === 0 && lines.length > 0 ? ' is-paid' : ''}`}
            >
              <span>{dueLabel}</span>
              <span className="mono" data-testid="balance-due">
                <Money cents={totals.balanceCents} />
              </span>
            </div>
          </section>

          {!locked ? (
            <section className="reg-card reg-actions" aria-label="Payment and completion">
              <div aria-live="polite">{error && <Alert tone="error">{error}</Alert>}</div>
              {hasZero && (
                <div className="reg-zero" data-testid="zero-guard">
                  <strong>A line is priced at $0.00.</strong> Fix the price, or confirm it is
                  intentional (floor model, warranty replacement) before taking payment.
                  <label className="reg-check">
                    <input
                      type="checkbox"
                      checked={zeroOk}
                      onChange={(e) => setZeroOk(e.target.checked)}
                    />
                    $0.00 is intentional
                  </label>
                </div>
              )}
              {paying ? (
                <div
                  className="reg-pay-panel"
                  role="group"
                  aria-labelledby="reg-pay-title"
                  data-testid="pay-panel"
                >
                  <h2 id="reg-pay-title" className="reg-pay-title">
                    Take a payment
                  </h2>
                  <div className="reg-pay-grid">
                    <Field label="Method">
                      <Select
                        value={payMethod}
                        onChange={(e) => setPayMethod(e.target.value as Tender)}
                        data-testid="pay-method"
                      >
                        {TENDERS.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Amount">
                      <Input
                        ref={payAmountInput}
                        type="number"
                        step="0.01"
                        min={0}
                        placeholder={(totals.balanceCents / 100).toFixed(2)}
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addPayment();
                          }
                        }}
                        data-testid="pay-amount"
                        className="input-num reg-cell-input"
                        disabled={zeroBlock}
                      />
                    </Field>
                  </div>
                  {payMethod === 'card' ? (
                    <Field label="Card last 4">
                      <Input
                        value={payRef}
                        onChange={(e) => setPayRef(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        inputMode="numeric"
                        placeholder="4412"
                        className="input-mono"
                        data-testid="pay-ref"
                        disabled={zeroBlock}
                      />
                    </Field>
                  ) : payMethod !== 'cash' ? (
                    <Field label="Reference (optional)">
                      <Input
                        value={payRef}
                        onChange={(e) => setPayRef(e.target.value)}
                        className="input-mono"
                        data-testid="pay-ref"
                        disabled={zeroBlock}
                      />
                    </Field>
                  ) : null}
                  <div className="reg-pay-quick">
                    <Button
                      size="sm"
                      onClick={() => setPayAmount((totals.balanceCents / 100).toFixed(2))}
                      disabled={zeroBlock || totals.balanceCents === 0}
                      data-testid="pay-full"
                    >
                      Pay in full
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        setPayAmount((Math.round(totals.totalCents / 2) / 100).toFixed(2))
                      }
                      disabled={zeroBlock || totals.totalCents === 0}
                      data-testid="pay-half"
                    >
                      50% deposit
                    </Button>
                  </div>
                  <div className="reg-pay-actions">
                    <Button
                      variant="primary"
                      onClick={addPayment}
                      disabled={zeroBlock}
                      data-testid="add-payment"
                      className="reg-record"
                    >
                      Record{payAmountCents > 0 ? ` ${formatMoney(payAmountCents)}` : ''}
                    </Button>
                    <Button onClick={() => setPaying(false)} data-testid="pay-done">
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="primary"
                  kbd="F8"
                  className="reg-take-payment"
                  disabled={payDisabled}
                  onClick={() => setPaying(true)}
                  data-testid="take-payment"
                >
                  Take payment
                </Button>
              )}
              <div className="reg-two">
                <Button
                  className="reg-complete"
                  disabled={busy || zeroBlock || !customer || lines.length === 0}
                  onClick={() => void submit('complete')}
                  data-testid="complete-sale"
                >
                  {busy ? 'Working…' : completeLabel}
                </Button>
                <Button
                  onClick={() => void submit('draft')}
                  disabled={busy}
                  data-testid="save-draft"
                >
                  Save draft
                </Button>
              </div>
              <div className="reg-hint">{completeHint}</div>
            </section>
          ) : (
            <section className="reg-card reg-done" aria-label="Sale complete">
              <p className="reg-done-line">
                <h2 className="reg-done-title">Sale complete</h2>{' '}
                {lines.filter((l) => l.lineType !== 'custom').length} line
                {lines.filter((l) => l.lineType !== 'custom').length === 1 ? '' : 's'}
                {done!.sources.length > 0 ? ` reserved at ${listJoin(done!.sources)}` : ''}.{' '}
                {done!.dueCents > 0
                  ? `${formatMoney(done!.dueCents)} due at ${fulfillment === 'delivery' ? 'the door' : 'pickup'}.`
                  : 'Paid in full.'}
                {requestedDate
                  ? ` ${fulfillment === 'pickup' ? 'Pickup' : 'Delivery'} ${requestedDate}.`
                  : ''}
              </p>
              {done!.splitOrders && done!.splitOrders.length > 0 && (
                <Alert tone="info" data-testid="split-siblings">
                  Backordered lines split into{' '}
                  {done!.splitOrders.map((s, i) => (
                    <span key={s.id}>
                      {i > 0 && ', '}
                      <a href={`/orders/${s.id}`}>{s.number}</a>
                      {s.requestedDate ? ` (promised ${s.requestedDate})` : ''}
                    </span>
                  ))}{' '}
                  — one payment covers them all.
                </Alert>
              )}
              {done!.bookedDeliveries && done!.bookedDeliveries.length > 0 && (
                <Alert tone="success" data-testid="booked-deliveries">
                  Delivery booked: {done!.bookedDeliveries.join(', ')} — it&apos;s on the Deliveries
                  calendar.
                </Alert>
              )}
              {done!.takeWith && (
                <Alert
                  tone={done!.takeWith.completed ? 'success' : 'warning'}
                  data-testid="take-with-result"
                >
                  {done!.takeWith.completed ? (
                    <>
                      Take-with items went out on{' '}
                      <a href={`/orders/${done!.takeWith.orderId}`}>{done!.takeWith.number}</a> —
                      paid and completed.
                    </>
                  ) : (
                    <>
                      Take-with items split to{' '}
                      <a href={`/orders/${done!.takeWith.orderId}`}>{done!.takeWith.number}</a>,
                      waiting: {done!.takeWith.reason ?? 'not ready yet'}. Finish it with Complete
                      on that order.
                    </>
                  )}
                </Alert>
              )}
              <Button variant="primary" className="reg-complete" kbd="P" onClick={printReceipt}>
                Print receipt
              </Button>
              <div className="reg-two">
                <Button
                  onClick={() =>
                    router.push(
                      done!.kind === 'sale' ? `/sales/${done!.id}` : `/orders/${done!.id}`,
                    )
                  }
                >
                  Open {done!.kind}
                </Button>
                <Button kbd="N" onClick={resetAll} data-testid="new-sale-again">
                  New sale
                </Button>
              </div>
            </section>
          )}
        </aside>
      </div>

      {showProductSearch && locationId && (
        <ProductSearchDialog
          locationId={pickerLocation || locationId}
          locationName={
            locs.find((l) => l.id === (pickerLocation || locationId))
              ? sourceLabel(locs.find((l) => l.id === (pickerLocation || locationId))!, locationId)
              : null
          }
          locations={locs}
          storeId={locationId}
          onChangeLocation={(id) => setPickerFrom(id)}
          onAdd={(row) => addProduct(row, pickerLocation || locationId)}
          sourceNote={pickerNote}
          onClose={() => setShowProductSearch(false)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function LineRow({
  line: l,
  locked,
  ctx,
  storeName,
  avail,
  recyclingFeeCents,
  onPatch,
  onFulfillment,
  onSource,
  onAddon,
  onRemove,
}: {
  line: Line;
  locked: boolean;
  ctx: SourcingContext;
  storeName: string;
  avail: Avail | undefined;
  recyclingFeeCents: number;
  onPatch: (key: string, patch: Partial<Line>) => void;
  onFulfillment: (key: string, f: '' | Fulfillment) => void;
  onSource: (key: string, id: string) => void;
  onAddon: (key: string, which: keyof Addons) => void;
  onRemove: (key: string) => void;
}) {
  const isFee = l.lineType === 'custom';
  const eff = effectiveFulfillment(l, ctx.orderFulfillment);
  const sourceName = ctx.locations.find((x) => x.id === l.sourceLocationId)?.name ?? 'the source';
  const addonCents = l.addons.recycling ? l.quantity * recyclingFeeCents : 0;
  const amount = l.quantity * l.unitPriceCents - l.lineDiscountCents + addonCents;
  const zero = !isFee && l.unitPriceCents === 0;
  const warn = isFee
    ? null
    : lineWarning({
        effective: eff,
        available: avail?.availableHere,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        sourceTouched: l.sourceTouched,
        sourceLocationId: l.sourceLocationId,
        orderLocationId: ctx.orderLocationId,
        sourceName,
        storeName,
        atpDate: avail?.atpDate,
      });
  const short = avail != null && avail.availableHere < l.quantity;
  const orderLabel = FULFILLMENTS.find((f) => f.value === ctx.orderFulfillment)?.label ?? '';
  const sorted = [...ctx.locations].sort((a, b) =>
    a.locationType === b.locationType
      ? a.name.localeCompare(b.name)
      : a.locationType === 'warehouse'
        ? -1
        : 1,
  );
  return (
    <tr className={zero ? 'reg-row-zero' : undefined} data-testid="line-row">
      <td>
        <div className="reg-line-name">{l.description}</div>
        <div className="reg-line-meta">
          {l.sku && <span className="mono">{l.sku}</span>}
          {l.size && <span>{l.size}</span>}
          {isFee && <span className="muted">fee</span>}
          {!locked && (
            <button type="button" className="reg-text-btn" onClick={() => onRemove(l.key)}>
              remove
            </button>
          )}
        </div>
        {!isFee && isMattressOrBase(l.description) && (
          <div className="reg-addons">
            {(
              [
                ['removal', 'Removal', 0],
                ['recycling', 'Recycling', recyclingFeeCents],
                ['declined', 'Declined foundation', 0],
              ] as const
            ).map(([k, label, cents]) => (
              <button
                key={k}
                type="button"
                className={`reg-addon${l.addons[k] ? ' is-on' : ''}`}
                aria-pressed={l.addons[k]}
                disabled={locked}
                onClick={() => onAddon(l.key, k)}
                data-testid={
                  k === 'recycling'
                    ? 'add-recycling-fee'
                    : k === 'declined'
                      ? 'add-declined-foundation'
                      : 'add-removal'
                }
              >
                <span aria-hidden className="mono">
                  {l.addons[k] ? '✓' : '+'}
                </span>{' '}
                {label}{' '}
                <span className="reg-addon-price">({cents ? formatMoney(cents) : '$0'})</span>
              </button>
            ))}
          </div>
        )}
        {warn && (
          <div
            className={`reg-warn reg-warn-${warn.tone}`}
            data-testid={short ? 'atp-banner' : undefined}
          >
            <span aria-hidden className="mono">
              {warn.tone === 'risk' ? '▲' : warn.tone === 'waiting' ? '◔' : '·'}
            </span>{' '}
            {warn.text}
          </div>
        )}
      </td>
      <td className="num">
        <Input
          type="number"
          min={1}
          max={999}
          value={l.quantity}
          aria-label={`Quantity for ${l.description}`}
          disabled={locked}
          className="input-num reg-cell-input"
          onChange={(e) => {
            const qty = Math.floor(Number(e.target.value));
            if (!Number.isFinite(qty) || qty < 1) {
              if (e.target.value !== '') toast('Quantity stays at 1 — use remove to drop the line');
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
        />
      </td>
      <td className="num">
        <Input
          type="number"
          step="0.01"
          min={0}
          key={`${l.key}-${l.unitPriceCents}`}
          defaultValue={(l.unitPriceCents / 100).toFixed(2)}
          onBlur={(e) => onPatch(l.key, { unitPriceCents: parseDollars(e.target.value) })}
          aria-label={`Unit price for ${l.description}`}
          aria-invalid={zero || undefined}
          disabled={locked}
          className={`input-num reg-cell-input${zero ? ' is-zero' : ''}`}
          data-testid="line-price"
        />
      </td>
      <td className="num">
        <Input
          type="number"
          step="0.01"
          min={0}
          placeholder="0.00"
          defaultValue={l.lineDiscountCents ? (l.lineDiscountCents / 100).toFixed(2) : ''}
          aria-label={`Discount for ${l.description}`}
          onBlur={(e) => onPatch(l.key, { lineDiscountCents: parseDollars(e.target.value) })}
          disabled={locked}
          className="input-num reg-cell-input"
        />
      </td>
      <td>
        {isFee ? (
          <span className="muted">—</span>
        ) : (
          <Select
            value={l.fulfillmentMethod}
            onChange={(e) => onFulfillment(l.key, e.target.value as '' | Fulfillment)}
            aria-label={`Fulfillment for ${l.description}`}
            disabled={locked}
            className="reg-cell-input"
          >
            <option value="">Same as order · {orderLabel}</option>
            {FULFILLMENTS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        )}
      </td>
      <td>
        {isFee ? (
          <span className="muted">—</span>
        ) : (
          <>
            <div className="reg-source">
              <Select
                value={l.sourceLocationId}
                onChange={(e) => onSource(l.key, e.target.value)}
                aria-label={`Inventory source for ${l.description}`}
                disabled={locked}
                className="reg-cell-input"
                data-testid="line-source"
              >
                {sorted.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {sourceLabel(loc, ctx.orderLocationId)}
                  </option>
                ))}
              </Select>
              {!l.sourceTouched && (
                <span className="reg-auto" title="Follows the fulfillment type. Edit to override.">
                  auto
                </span>
              )}
            </div>
            <div
              className={`reg-avail${short ? (eff === 'take_with' ? ' is-risk' : ' is-waiting') : ''}`}
            >
              {avail
                ? `${avail.availableHere} available${avail.atpDate ? ' · on PO' : ''}`
                : 'checking stock…'}
            </div>
          </>
        )}
      </td>
      <td className="num mono reg-amount">
        <Money cents={amount} />
      </td>
    </tr>
  );
}

function NewCustomerForm({
  value,
  onChange,
  bill,
  onBill,
  billDiffers,
  onBillDiffers,
  zipMemo,
  dupeWarn,
  onUseExisting,
  busy,
  onCancel,
  onCreate,
}: {
  value: typeof EMPTY_NEW_CUSTOMER;
  onChange: (v: typeof EMPTY_NEW_CUSTOMER) => void;
  bill: typeof EMPTY_ADDRESS;
  onBill: (v: typeof EMPTY_ADDRESS) => void;
  billDiffers: boolean;
  onBillDiffers: (v: boolean) => void;
  zipMemo: React.MutableRefObject<{
    cust: ZipHit | null;
    bill: ZipHit | null;
    ship: ZipHit | null;
  }>;
  dupeWarn: { id: string; name: string; phone: string | null } | null;
  onUseExisting: (id: string) => void;
  busy: boolean;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="reg-stack" data-testid="new-customer-form">
      <div className="t-label">New customer</div>
      <div className="reg-two">
        <Input
          placeholder="First name"
          aria-label="First name"
          value={value.firstName}
          onChange={(e) => onChange({ ...value, firstName: e.target.value })}
          autoFocus
        />
        <Input
          placeholder="Last name"
          aria-label="Last name"
          value={value.lastName}
          onChange={(e) => onChange({ ...value, lastName: e.target.value })}
        />
      </div>
      <div className="reg-two">
        <Input
          placeholder="Phone"
          aria-label="Phone"
          value={value.phone}
          onChange={(e) => onChange({ ...value, phone: e.target.value })}
          className="input-mono"
        />
        <Input
          placeholder="2nd phone (optional)"
          aria-label="2nd phone (optional)"
          value={value.phone2}
          onChange={(e) => onChange({ ...value, phone2: e.target.value })}
          className="input-mono"
          data-testid="new-customer-phone2"
        />
      </div>
      <Input
        placeholder="Email"
        aria-label="Email"
        value={value.email}
        onChange={(e) => onChange({ ...value, email: e.target.value })}
      />
      {dupeWarn && (
        <Alert
          tone="warning"
          data-testid="dupe-warning"
          action={
            <Button
              size="sm"
              data-testid="use-existing-customer"
              onClick={() => onUseExisting(dupeWarn.id)}
            >
              Use existing
            </Button>
          }
        >
          Looks like <strong>{dupeWarn.name}</strong>
          {dupeWarn.phone ? ` (${dupeWarn.phone})` : ''} already exists — use them instead?
        </Alert>
      )}
      <div className="t-label">Delivery address</div>
      <Input
        placeholder="Delivery address"
        aria-label="Delivery address"
        value={value.line1}
        onChange={(e) => onChange({ ...value, line1: e.target.value })}
        data-testid="new-customer-address"
      />
      <div className="reg-two">
        <Input
          placeholder="Apt / unit"
          aria-label="Apt / unit"
          value={value.line2}
          onChange={(e) => onChange({ ...value, line2: e.target.value })}
        />
        <Input
          placeholder="City"
          aria-label="City"
          value={value.city}
          onChange={(e) => onChange({ ...value, city: e.target.value })}
        />
      </div>
      <div className="reg-two">
        <Input
          placeholder="State"
          aria-label="State"
          value={value.region}
          onChange={(e) => onChange({ ...value, region: e.target.value })}
        />
        <Input
          placeholder="ZIP"
          aria-label="ZIP"
          value={value.postalCode}
          onChange={(e) =>
            autofillFromZip(e.target.value, onChange as never, zipMemo.current, 'cust')
          }
          className="input-mono"
        />
      </div>
      <label className="reg-check">
        <input
          type="checkbox"
          checked={billDiffers}
          onChange={(e) => onBillDiffers(e.target.checked)}
        />
        Billing address is different
      </label>
      {billDiffers && (
        <>
          <div className="t-label">Billing address</div>
          <Input
            placeholder="Billing address"
            aria-label="Billing address"
            value={bill.line1}
            onChange={(e) => onBill({ ...bill, line1: e.target.value })}
            data-testid="new-customer-billing"
          />
          <div className="reg-two">
            <Input
              placeholder="Apt / unit"
              aria-label="Apt / unit"
              value={bill.line2}
              onChange={(e) => onBill({ ...bill, line2: e.target.value })}
            />
            <Input
              placeholder="City"
              aria-label="City"
              value={bill.city}
              onChange={(e) => onBill({ ...bill, city: e.target.value })}
            />
          </div>
          <div className="reg-two">
            <Input
              placeholder="State"
              aria-label="State"
              value={bill.region}
              onChange={(e) => onBill({ ...bill, region: e.target.value })}
            />
            <Input
              placeholder="ZIP"
              aria-label="ZIP"
              value={bill.postalCode}
              onChange={(e) =>
                autofillFromZip(e.target.value, onBill as never, zipMemo.current, 'bill')
              }
              className="input-mono"
            />
          </div>
        </>
      )}
      <Field label="How did they hear about us?">
        <Input
          placeholder="Walk-in, Google, referral…"
          value={value.referralSource}
          onChange={(e) => onChange({ ...value, referralSource: e.target.value })}
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
      <div className="reg-two">
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" data-testid="create-customer" disabled={busy} onClick={onCreate}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  );
}

function TotalRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="reg-total-row">
      <span>{label}</span>
      <span className="mono">
        {cents < 0 ? '−' : ''}
        {formatMoney(Math.abs(cents))}
      </span>
    </div>
  );
}

/** "A", "A and B", "A, B and C". */
function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function ago(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
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
