'use client';

import { useEffect, useState } from 'react';
import { ActingStoreProvider } from '@/lib/acting-store';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import { OrdersBook } from '@/components/orders/orders-book';
import { OrderSheet } from '@/components/orders/order-sheet';

/**
 * Orders book on the prototype's fixtures (redesign Phase 6) behind a
 * fetch stub — for checking the screen without a session. `?open=o1`
 * mounts the slide-over for that fixture (o1 is locked, o2 has a
 * deposit, o5 is cancelled).
 */

const LOCS = [
  { id: 'gl', name: 'Glendale', locationType: 'store' },
  { id: 'kt', name: 'Koreatown', locationType: 'store' },
  { id: 'lb', name: 'La Brea', locationType: 'store' },
  { id: 'sc', name: 'Studio City', locationType: 'store' },
  { id: 'wl', name: 'West LA', locationType: 'store' },
  { id: 'wh', name: 'Warehouse', locationType: 'warehouse' },
];
const REPS = [
  { membershipId: 'm1', name: 'Priya Nair', email: 'priya@x', status: 'active' },
  { membershipId: 'm2', name: 'Marcus Lee', email: 'marcus@x', status: 'active' },
  { membershipId: 'm3', name: 'Dana Ortiz', email: 'dana@x', status: 'active' },
  { membershipId: 'm4', name: 'Sam Patel', email: 'sam@x', status: 'active' },
];
const CUST = [
  { id: 'c1', firstName: 'Elena', lastName: 'Marquez', phone: '(818) 555-0142' },
  { id: 'c2', firstName: 'Omar', lastName: 'Haddad', phone: '(213) 555-0177' },
  { id: 'c3', firstName: 'Grace', lastName: 'Kim', phone: '(310) 555-0110' },
  { id: 'c4', firstName: 'Tom', lastName: 'Nguyen', phone: '(323) 555-0199' },
  { id: 'c5', firstName: 'Ana', lastName: 'Silva', phone: '(626) 555-0124' },
  { id: 'c6', firstName: 'Ben', lastName: 'Carter', phone: '(818) 555-0163' },
];
const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const ago = (n: number, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 12, 0, 0);
  return d.toISOString();
};

interface Fx {
  id: string;
  number: string;
  cust: (typeof CUST)[number];
  loc: string;
  status: string;
  displayStatus: string;
  rep: string;
  totalCents: number;
  paidCents: number;
  units: number;
  reserved: number;
  fulfilled: number;
  promised: string | null;
  written: string;
  lockedAt: string | null;
  fulfillment: string;
}
const FX: Fx[] = [
  {
    id: 'o1',
    number: 'SO-10441',
    cust: CUST[0]!,
    loc: 'gl',
    status: 'open',
    displayStatus: 'Scheduled',
    rep: 'm1',
    totalCents: 259800,
    paidCents: 50000,
    units: 2,
    reserved: 2,
    fulfilled: 0,
    promised: day(2),
    written: ago(3, 13),
    lockedAt: ago(1, 8),
    fulfillment: 'delivery',
  },
  {
    id: 'o2',
    number: 'SO-10440',
    cust: CUST[1]!,
    loc: 'gl',
    status: 'open',
    displayStatus: 'On PO',
    rep: 'm2',
    totalCents: 142241,
    paidCents: 71121,
    units: 3,
    reserved: 2,
    fulfilled: 0,
    promised: day(5),
    written: ago(3, 11),
    lockedAt: null,
    fulfillment: 'delivery',
  },
  {
    id: 'o3',
    number: 'SO-10438',
    cust: CUST[2]!,
    loc: 'kt',
    status: 'open',
    displayStatus: 'Reserved',
    rep: 'm3',
    totalCents: 89900,
    paidCents: 89900,
    units: 1,
    reserved: 1,
    fulfilled: 0,
    promised: day(1),
    written: ago(4, 15),
    lockedAt: null,
    fulfillment: 'pickup',
  },
  {
    id: 'o4',
    number: 'SO-10436',
    cust: CUST[3]!,
    loc: 'gl',
    status: 'open',
    displayStatus: 'Scheduled',
    rep: 'm1',
    totalCents: 329700,
    paidCents: 100000,
    units: 3,
    reserved: 3,
    fulfilled: 0,
    promised: day(-2),
    written: ago(9, 16),
    lockedAt: null,
    fulfillment: 'delivery',
  },
  {
    id: 'o5',
    number: 'SO-10431',
    cust: CUST[4]!,
    loc: 'wl',
    status: 'cancelled',
    displayStatus: 'Cancelled',
    rep: 'm4',
    totalCents: 129900,
    paidCents: 0,
    units: 1,
    reserved: 0,
    fulfilled: 0,
    promised: null,
    written: ago(12, 10),
    lockedAt: null,
    fulfillment: 'delivery',
  },
  {
    id: 'o6',
    number: 'SO-10429',
    cust: CUST[5]!,
    loc: 'gl',
    status: 'completed',
    displayStatus: 'Delivered',
    rep: 'm2',
    totalCents: 69900,
    paidCents: 69900,
    units: 1,
    reserved: 0,
    fulfilled: 1,
    promised: day(-6),
    written: ago(14, 9),
    lockedAt: null,
    fulfillment: 'delivery',
  },
  {
    id: 'o7',
    number: 'SO-10427',
    cust: CUST[0]!,
    loc: 'sc',
    status: 'draft',
    displayStatus: 'Draft',
    rep: 'm3',
    totalCents: 189900,
    paidCents: 0,
    units: 2,
    reserved: 0,
    fulfilled: 0,
    promised: null,
    written: ago(16, 12),
    lockedAt: null,
    fulfillment: 'delivery',
  },
  {
    id: 'o8',
    number: 'SO-10425',
    cust: CUST[2]!,
    loc: 'gl',
    status: 'open',
    displayStatus: 'Pending',
    rep: 'm1',
    totalCents: 249900,
    paidCents: 24990,
    units: 4,
    reserved: 0,
    fulfilled: 0,
    promised: day(9),
    written: ago(18, 17),
    lockedAt: null,
    fulfillment: 'delivery',
  },
];

function row(f: Fx) {
  return {
    id: f.id,
    number: f.number,
    customerName: `${f.cust.firstName} ${f.cust.lastName}`,
    customerPhone: f.cust.phone,
    displayStatus: f.displayStatus,
    poNumber: f.displayStatus === 'On PO' ? 'PO-4471' : null,
    deliveryDate: f.promised,
    balanceDueCents: Math.max(0, f.totalCents - f.paidCents),
    creditDueCents: 0,
    salespersonName: REPS.find((r) => r.membershipId === f.rep)?.name ?? null,
    salespersonMembershipId: f.rep,
    locationId: f.loc,
    locationName: LOCS.find((l) => l.id === f.loc)?.name ?? null,
    lockedAt: f.lockedAt,
    totalCents: f.totalCents,
    createdAt: f.written,
    lineSummary: { units: f.units, reserved: f.reserved, fulfilled: f.fulfilled, specialOrder: 0 },
  };
}

function detail(f: Fx) {
  const lines = [
    {
      id: `${f.id}-l1`,
      description: 'Cloud Comfort Mattress — Queen',
      quantity: 1,
      qtyReserved: Math.min(1, f.reserved),
      qtyFulfilled: f.fulfilled,
      lineType: 'stock',
      fulfillmentMethod: null,
      sourceLocationId: 'wh',
      totalCents: 129900,
    },
    ...(f.units > 1
      ? [
          {
            id: `${f.id}-l2`,
            description: 'Adjustable base — Queen',
            quantity: f.units - 1,
            qtyReserved: Math.max(0, f.reserved - 1),
            qtyFulfilled: 0,
            lineType: 'stock',
            fulfillmentMethod: null,
            sourceLocationId: 'wh',
            totalCents: f.totalCents - 129900 - 1800,
          },
        ]
      : []),
    {
      id: `${f.id}-l3`,
      description: 'Recycling Fee',
      quantity: 1,
      qtyReserved: 0,
      qtyFulfilled: 0,
      lineType: 'custom',
      fulfillmentMethod: null,
      sourceLocationId: null,
      totalCents: 1800,
    },
  ];
  return {
    id: f.id,
    number: f.number,
    status: f.status,
    displayStatus: f.displayStatus,
    customerId: f.cust.id,
    locationId: f.loc,
    stockLocationId: 'wh',
    fulfillmentType: f.fulfillment,
    requestedDate: f.promised,
    totalCents: f.totalCents,
    paidCents: f.paidCents,
    balanceDueCents: Math.max(0, f.totalCents - f.paidCents),
    creditDueCents: 0,
    addressLine1: '410 N Brand Blvd',
    addressLine2: null,
    addressCity: 'Glendale',
    addressRegion: 'CA',
    addressPostalCode: '91203',
    deliveryInstructions: null,
    salespersonMembershipId: f.rep,
    lockedAt: f.lockedAt,
    onOpenRun: null,
    createdAt: f.written,
    completedAt: f.status === 'completed' ? ago(6) : null,
    cancelledAt: f.status === 'cancelled' ? ago(10) : null,
    lines,
    payments:
      f.paidCents > 0
        ? [
            {
              id: `${f.id}-p1`,
              kind: 'deposit',
              method: 'card',
              amountCents: f.paidCents,
              status: 'succeeded',
              processorRef: '4412',
              createdAt: ago(3, 14),
            },
          ]
        : [],
  };
}

function audit(f: Fx) {
  const who = REPS.find((r) => r.membershipId === f.rep)?.email ?? 'system';
  const rows = [
    f.lockedAt && {
      id: 'a1',
      action: 'order.lock',
      actorUserId: null,
      actorEmail: 'dispatch@x',
      createdAt: f.lockedAt,
      changesJson: null,
    },
    f.status === 'cancelled' && {
      id: 'a2',
      action: 'order.cancel',
      actorUserId: null,
      actorEmail: who,
      createdAt: ago(10, 16),
      changesJson: {
        before: { status: 'open' },
        after: {
          status: 'cancelled',
          reason: 'Customer changed mind',
          depositCents: 0,
          depositTo: null,
        },
      },
    },
    f.displayStatus === 'Scheduled' && {
      id: 'a3',
      action: 'delivery.schedule',
      actorUserId: null,
      actorEmail: 'dispatch@x',
      createdAt: ago(2, 11),
      changesJson: { after: { scheduledDate: f.promised } },
    },
    f.displayStatus === 'On PO' && {
      id: 'a4',
      action: 'order.allocate_pending',
      actorUserId: null,
      actorEmail: null,
      createdAt: ago(2, 10),
      changesJson: null,
    },
    f.paidCents > 0 && {
      id: 'a5',
      action: 'order.payment.take',
      actorUserId: null,
      actorEmail: who,
      createdAt: ago(3, 14),
      changesJson: { after: { method: 'card', amountCents: f.paidCents, processorRef: '4412' } },
    },
    {
      id: 'a6',
      action: 'order.create',
      actorUserId: null,
      actorEmail: who,
      createdAt: f.written,
      changesJson: null,
    },
  ].filter(Boolean);
  return { data: rows, nextCursor: null };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installStub() {
  const w = window as unknown as { __ordStub?: boolean };
  if (w.__ordStub) return;
  w.__ordStub = true;
  const real = window.fetch.bind(window);
  const local = new Map<string, Fx>(FX.map((f) => [f.id, { ...f }]));
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input as Request).url,
      location.origin,
    );
    const p = url.pathname;
    const q = url.searchParams;
    const method = init?.method ?? 'GET';
    if (p === '/v1/business/members/me') {
      return json({
        membershipId: 'm1',
        roleName: 'Manager',
        hiddenNav: [],
        sellingScope: 'all',
        scopeLocations: LOCS,
      });
    }
    if (p === '/v1/business/members/me/acting-store') return json({ ok: true });
    if (p === '/v1/business/locations' || p === '/v1/pos/locations') return json(LOCS);
    if (p === '/v1/business/members') return json(REPS);
    if (p === '/v1/business/settings/pos') return json({ ops: null });
    if (p === '/v1/reason-codes') return json([]);
    if (p === '/v1/orders/list-view') {
      let rows = [...local.values()];
      const loc = q.get('locationId');
      if (loc) rows = rows.filter((f) => f.loc === loc);
      const disp = q.get('display');
      if (disp) rows = rows.filter((f) => f.displayStatus === disp);
      if (q.get('view') === 'past_due')
        rows = rows.filter((f) => f.promised && f.promised < day(0) && f.status === 'open');
      const rep = q.get('salespersonMembershipId');
      if (rep) rows = rows.filter((f) => f.rep === rep);
      if (q.get('balanceDue') === '1')
        rows = rows.filter((f) => f.status === 'open' && f.totalCents > f.paidCents);
      const s = (q.get('q') ?? '').toLowerCase();
      if (s)
        rows = rows.filter((f) =>
          `${f.number} ${f.cust.firstName} ${f.cust.lastName} ${f.cust.phone}`
            .toLowerCase()
            .includes(s),
        );
      const start = q.get('start');
      if (start) rows = rows.filter((f) => f.written.slice(0, 10) >= start);
      const sort = q.get('sort');
      const dir = q.get('dir') === 'desc' ? -1 : 1;
      const key = (f: Fx): string | number => {
        switch (sort) {
          case 'number':
            return f.number;
          case 'customer':
            return f.cust.firstName;
          case 'store':
            return LOCS.find((l) => l.id === f.loc)?.name ?? '';
          case 'status':
            return f.displayStatus;
          case 'reserved':
            return f.units ? f.reserved / f.units : 0;
          case 'deliveryDate':
            return f.promised ?? '';
          case 'salesperson':
            return REPS.find((r) => r.membershipId === f.rep)?.name ?? '';
          case 'total':
            return f.totalCents;
          case 'balanceDue':
            return f.totalCents - f.paidCents;
          default:
            return f.written;
        }
      };
      rows.sort((a, b) => (key(a) > key(b) ? dir : key(a) < key(b) ? -dir : 0));
      if (!sort) rows.reverse();
      const data = rows.map(row);
      return json({
        data,
        nextCursor: null,
        summary: {
          count: data.length,
          balanceDueCents: data.reduce(
            (n, r) => n + (r.displayStatus === 'Cancelled' ? 0 : r.balanceDueCents),
            0,
          ),
        },
      });
    }
    const om = p.match(/^\/v1\/orders\/([^/]+)(\/(payments|cancel|unlock|share|deliveries))?$/);
    if (om) {
      const f = local.get(om[1]!);
      if (!f) return json({ message: 'Order not found' }, 404);
      if (om[3] === 'payments' && method === 'POST') {
        const b = JSON.parse(String(init?.body ?? '{}')) as { amountCents: number };
        f.paidCents = Math.min(f.totalCents, f.paidCents + b.amountCents);
        return json(detail(f));
      }
      if (om[3] === 'cancel' && method === 'POST') {
        f.status = 'cancelled';
        f.displayStatus = 'Cancelled';
        f.reserved = 0;
        f.lockedAt = null;
        return json(detail(f));
      }
      if (om[3] === 'unlock' && method === 'POST') {
        f.lockedAt = null;
        return json(detail(f));
      }
      if (om[3] === 'share') return json({ path: `/track/${f.id}` });
      if (om[3] === 'deliveries' && method === 'POST') {
        const b = JSON.parse(String(init?.body ?? '{}')) as { scheduledDate: string };
        f.promised = b.scheduledDate;
        f.displayStatus = 'Scheduled';
        return json({ id: 'd-new' });
      }
      return json(detail(f));
    }
    const cm = p.match(/^\/v1\/customers\/([^/]+)$/);
    if (cm) return json(CUST.find((c) => c.id === cm[1]) ?? CUST[0]);
    if (p === '/v1/deliveries') {
      const f = local.get(q.get('orderId') ?? '');
      return json(
        f && f.displayStatus === 'Scheduled' && f.promised
          ? [
              {
                id: `${f.id}-d`,
                status: 'scheduled',
                scheduledDate: f.promised,
                windowStart: '8–12',
              },
            ]
          : [],
      );
    }
    if (p === '/v1/audit-logs') {
      const f = local.get(q.get('targetId') ?? '');
      return json(f ? audit(f) : { data: [], nextCursor: null });
    }
    if (p.startsWith('/v1/')) return json({ message: `stub: ${p}` }, 404);
    return real(input, init);
  };
}

export default function OrdersPreview() {
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    installStub();
    try {
      sessionStorage.setItem('jetnine.sellingStore', JSON.stringify(LOCS[0]));
    } catch {
      // ignore
    }
    setOpen(new URLSearchParams(window.location.search).get('open'));
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <BusinessSettingsProvider>
      <ActingStoreProvider>
        <div
          className="mx-auto w-full max-w-[1560px] px-[22px] pb-12 pt-[22px]"
          style={{ background: 'var(--bg)', minHeight: '100vh' }}
        >
          <div className="t-mono-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
            PREVIEW · FIXTURES FROM THE PROTOTYPE · NOTHING IS SAVED
          </div>
          <OrdersBook>{open && <OrderSheet id={open} />}</OrdersBook>
        </div>
      </ActingStoreProvider>
    </BusinessSettingsProvider>
  );
}
