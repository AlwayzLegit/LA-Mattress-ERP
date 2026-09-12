/**
 * Fixture-backed fetch for the dashboard previews (redesign Phase 9):
 * the five canvas stores with their salespeople, orders and payments,
 * the owner headline and figures, the cash pickups queue (postable), the
 * morning brief, the changes log, this week's schedule, the time clock
 * and the manager payload. Nothing is saved anywhere but the page.
 */

function toDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(s: string, n: number): string {
  const d = new Date(`${s}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toDay(d);
}
function atHour(day: string, h: number, m = 0): string {
  const d = new Date(`${day}T12:00:00`);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FxStore {
  id: string;
  name: string;
  manager: string;
  reps: string[];
  weight: number;
  refunds: number;
  lastPickupDaysAgo: number | null;
}
const STORES: FxStore[] = [
  {
    id: 'gl',
    name: 'Glendale',
    manager: 'Maya Torres',
    reps: ['Maya Torres', 'Arman Petrosyan', 'Priya Nair'],
    weight: 1,
    refunds: 0,
    lastPickupDaysAgo: 4,
  },
  {
    id: 'kt',
    name: 'Koreatown',
    manager: 'Devon Park',
    reps: ['Devon Park', 'Grace Kim'],
    weight: 0.78,
    refunds: 0,
    lastPickupDaysAgo: 2,
  },
  {
    id: 'wl',
    name: 'West LA',
    manager: 'Sam Whitfield',
    reps: ['Sam Whitfield', 'Lena Ortiz'],
    weight: 0.64,
    refunds: 219900,
    lastPickupDaysAgo: 6,
  },
  {
    id: 'sc',
    name: 'Studio City',
    manager: 'Ivan Kaplan',
    reps: ['Ivan Kaplan', 'Tara Obi'],
    weight: 0.49,
    refunds: 0,
    lastPickupDaysAgo: 1,
  },
  {
    id: 'lb',
    name: 'La Brea',
    manager: 'Nina Rossi',
    reps: ['Nina Rossi'],
    weight: 0.33,
    refunds: 129900,
    lastPickupDaysAgo: null,
  },
];
const CUSTOMERS = [
  'Omar Haddad',
  'Karen Liu',
  'Dana Wu',
  'Felix Moreno',
  'Helen Park',
  'Grace Kim',
  'Ivan Petrov',
  'Marco Silva',
  'Lena Fischer',
  'Tara Obi',
  'Paul Ng',
  'Amy Chen',
];
const METHODS = [
  'cash',
  'card',
  'financing',
  'cash',
  'external_card',
  'check',
  'cash',
  'card',
  'gift_card',
];

interface FxPayment {
  paymentId: string;
  method: string;
  amountCents: number;
  day: string;
  orderNumber: string;
  orderId: string;
  customer: string;
  rep: string;
  storeId: string;
  pickedUp: null | { at: string; by: string; number: string };
}
interface FxOrder {
  id: string;
  number: string;
  customer: string;
  rep: string;
  amountCents: number;
  day: string;
  storeId: string;
  delivered: boolean;
}

function memberId(name: string): string {
  return `m-${name.toLowerCase().replace(/[^a-z]/g, '')}`;
}

export function buildFixtures(today: string) {
  const orders: FxOrder[] = [];
  const payments: FxPayment[] = [];
  const dayOffsets = [0, 0, 1, 1, 2, 2, 4, 5, 7];
  STORES.forEach((s, si) => {
    for (let i = 0; i < 9; i++) {
      const day = addDays(today, -dayOffsets[i]!);
      const amt = Math.round((900 + ((i * 731 + si * 197) % 2400)) * s.weight) * 100;
      const rep = s.reps[i % s.reps.length]!;
      const number = `SO-${10400 + si * 9 + i}`;
      const id = `o-${si}-${i}`;
      orders.push({
        id,
        number,
        customer: CUSTOMERS[(i + si * 3) % CUSTOMERS.length]!,
        rep,
        amountCents: amt,
        day,
        storeId: s.id,
        delivered: i > 4,
      });
      const m = METHODS[(i + si) % METHODS.length]!;
      payments.push({
        paymentId: `p-${si}-${i}-a`,
        method: m,
        amountCents: Math.round(amt * 0.5),
        day,
        orderNumber: number,
        orderId: id,
        customer: CUSTOMERS[(i + si * 3) % CUSTOMERS.length]!,
        rep,
        storeId: s.id,
        pickedUp: null,
      });
      if (i % 3 === 0) {
        payments.push({
          paymentId: `p-${si}-${i}-b`,
          method: i % 2 ? 'cash' : 'card',
          amountCents: Math.round(amt * 0.2),
          day,
          orderNumber: number,
          orderId: id,
          customer: CUSTOMERS[(i + si * 3) % CUSTOMERS.length]!,
          rep,
          storeId: s.id,
          pickedUp: null,
        });
      }
    }
  });
  // Cash before each store's last pickup is already picked up.
  for (const s of STORES) {
    if (s.lastPickupDaysAgo == null) continue;
    const cutoff = addDays(today, -s.lastPickupDaysAgo);
    for (const p of payments) {
      if (p.storeId === s.id && p.method === 'cash' && p.day < cutoff) {
        p.pickedUp = { at: atHour(cutoff, 17, 40), by: 'Alex Rivera', number: 'PU-0090' };
      }
    }
  }
  return { orders, payments };
}

export function installDashboardStub(opts: { role: 'owner' | 'manager' } = { role: 'owner' }) {
  const w = window as unknown as { __dashStub?: boolean };
  if (w.__dashStub) return;
  w.__dashStub = true;
  const today = toDay(new Date());
  const { orders, payments } = buildFixtures(today);
  let pickupSeq = 90;
  const actor = opts.role === 'manager' ? 'Maya Torres' : 'Alex Rivera';
  const monthStart = `${today.slice(0, 7)}-01`;
  const dayAge = (day: string) =>
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);

  const storesFor = (ids: string[] | null) => STORES.filter((s) => !ids || ids.includes(s.id));
  const inPeriod = (day: string, period: string) =>
    period === 'today' ? day === today : day >= monthStart;

  const storeCard = (s: FxStore, period: string) => {
    const ords = orders.filter((o) => o.storeId === s.id && inPeriod(o.day, period));
    const pays = payments.filter((p) => p.storeId === s.id && inPeriod(p.day, period));
    const written = ords.reduce((n, o) => n + o.amountCents, 0);
    const delivered = ords.filter((o) => o.delivered).reduce((n, o) => n + o.amountCents, 0);
    const received = pays.reduce((n, p) => n + p.amountCents, 0);
    const methods = [
      'cash',
      'card',
      'external_card',
      'check',
      'financing',
      'gift_card',
      'store_credit',
    ];
    const cash = pays.filter((p) => p.method === 'cash');
    const cashReceived = cash.filter((p) => p.pickedUp);
    return {
      locationId: s.id,
      name: s.name,
      timezone: 'America/Los_Angeles',
      manager: { membershipId: memberId(s.manager), name: s.manager },
      sellingCount: s.reps.length,
      writtenCents: written,
      writtenCount: ords.length,
      deliveredCents: delivered,
      deliveredCount: ords.filter((o) => o.delivered).length,
      avgTicketCents: ords.length ? Math.round(written / ords.length) : 0,
      receivedCents: received,
      receivedCount: pays.length,
      refundsCents: s.refunds,
      cashTotalCents: cash.reduce((n, p) => n + p.amountCents, 0),
      cashPendingCents: cash.filter((p) => !p.pickedUp).reduce((n, p) => n + p.amountCents, 0),
      cashPaymentCount: cash.length,
      cashReceivedCount: cashReceived.length,
      salespeople: s.reps.map((r) => {
        const ro = ords.filter((o) => o.rep === r);
        const wr = ro.reduce((n, o) => n + o.amountCents, 0);
        const last = ro[0];
        return {
          membershipId: memberId(r),
          name: r,
          isManager: r === s.manager,
          writtenCents: wr,
          deliveredCents: ro.filter((o) => o.delivered).reduce((n, o) => n + o.amountCents, 0),
          orders: ro.length,
          avgTicketCents: ro.length ? Math.round(wr / ro.length) : 0,
          collectedCents: pays.filter((p) => p.rep === r).reduce((n, p) => n + p.amountCents, 0),
          lastWriteUpAt: last ? atHour(last.day, 10 + (ro.length % 7), 15) : null,
        };
      }),
      tenders: methods.map((m) => {
        const list = pays.filter((p) => p.method === m);
        return {
          method: m,
          cents: list.reduce((n, p) => n + p.amountCents, 0),
          count: list.length,
        };
      }),
      cashPayments: cash.map((p) => ({
        paymentId: p.paymentId,
        docKind: 'order',
        docId: p.orderId,
        docNumber: p.orderNumber,
        customerName: p.customer,
        soldAt: atHour(p.day, 11),
        paidAt: atHour(p.day, 11, 20),
        kind: 'deposit',
        salespersonName: p.rep,
        amountCents: p.amountCents,
        receipt: p.pickedUp
          ? {
              receivedAt: p.pickedUp.at,
              byMembershipId: 'm-alex',
              byName: p.pickedUp.by,
              byRole: 'Owner',
            }
          : null,
      })),
    };
  };

  const queueStore = (s: FxStore) => {
    const pending = payments.filter(
      (p) => p.storeId === s.id && p.method === 'cash' && !p.pickedUp,
    );
    const pendingCents = pending.reduce((n, p) => n + p.amountCents, 0);
    const oldest = pending.length ? Math.max(...pending.map((p) => dayAge(p.day))) : null;
    const last = payments
      .filter((p) => p.storeId === s.id && p.pickedUp)
      .sort((a, b) => (a.pickedUp!.at < b.pickedUp!.at ? 1 : -1))[0];
    const lastItems = last
      ? payments.filter((p) => p.storeId === s.id && p.pickedUp?.number === last.pickedUp!.number)
      : [];
    const lastPickup = last
      ? {
          id: `pu-${s.id}`,
          number: last.pickedUp!.number,
          recordedAt: last.pickedUp!.at,
          byName: last.pickedUp!.by,
          countedCents: lastItems.reduce((n, p) => n + p.amountCents, 0),
          expectedCents: lastItems.reduce((n, p) => n + p.amountCents, 0),
          varianceCents: 0,
          slip: last.pickedUp!.number === 'PU-0090' ? 'BB-2231' : null,
          note: null,
          paymentCount: lastItems.length,
        }
      : null;
    const status =
      pending.length === 0
        ? lastPickup
          ? 'collected'
          : 'none'
        : pendingCents > 150_000 || (oldest ?? 0) > 3
          ? 'due'
          : 'holding';
    return {
      locationId: s.id,
      name: s.name,
      timezone: 'America/Los_Angeles',
      status,
      pendingCents,
      pendingCount: pending.length,
      oldestDays: oldest,
      since: lastPickup ? lastPickup.recordedAt : atHour(monthStart, 0),
      lastPickup,
      payments: pending
        .sort((a, b) => (a.day < b.day ? -1 : 1))
        .map((p) => ({
          paymentId: p.paymentId,
          docKind: 'order',
          docId: p.orderId,
          docNumber: p.orderNumber,
          customerName: p.customer,
          salespersonName: p.rep,
          paidAt: atHour(p.day, 11, 20),
          ageDays: dayAge(p.day),
          amountCents: p.amountCents,
        })),
      canRecord: opts.role === 'owner' || s.id === 'gl',
    };
  };
  const queue = (ids: string[] | null) => {
    const stores = storesFor(ids).map(queueStore);
    return {
      date: today,
      rule: { dueCents: 150_000, dueDays: 3 },
      viewer: { membershipId: 'm1', canRecord: true },
      stores,
      totals: {
        storeCount: stores.length,
        pendingCents: stores.reduce((n, s) => n + s.pendingCents, 0),
        dueCount: stores.filter((s) => s.status === 'due').length,
        holdingCount: stores.filter((s) => s.status === 'holding').length,
      },
    };
  };

  const writtenOn = (day: string, storeId?: string) =>
    orders
      .filter((o) => o.day === day && (!storeId || o.storeId === storeId))
      .reduce((n, o) => n + o.amountCents, 0);
  const trend = Array.from({ length: 30 }, (_, i) => {
    const day = addDays(today, i - 29);
    const base = 900000 + ((i * 3271) % 900000) + (i % 7 === 5 ? 600000 : 0);
    return {
      day,
      orderCents: i === 29 ? writtenOn(day) : base,
      registerCents: Math.round(base * 0.12),
    };
  });

  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input as Request).url,
      location.origin,
    );
    const p = url.pathname;
    const q = url.searchParams;
    const method = init?.method ?? 'GET';
    const ids =
      q.get('locationIds')?.split(',').filter(Boolean) ??
      (q.get('locationId') ? [q.get('locationId')!] : null);

    if (p === '/v1/business/members/me')
      return json({
        membershipId: 'm1',
        roleName: opts.role === 'manager' ? 'Manager' : 'Owner',
        hiddenNav: [],
        sellingScope: 'all',
        scopeLocations: [],
        managerDashboard: opts.role === 'manager',
      });
    if (p === '/v1/business/locations' || p === '/v1/pos/locations')
      return json([
        ...STORES.map((s) => ({
          id: s.id,
          name: s.name,
          timezone: 'America/Los_Angeles',
          locationType: 'store',
        })),
        { id: 'wh', name: 'Warehouse', timezone: 'America/Los_Angeles', locationType: 'warehouse' },
      ]);
    if (p === '/v1/business/settings/pos') return json({ ops: null });
    if (p === '/v1/onboarding/checklist')
      return json({ businessId: 'b1', steps: [], complete: true });

    if (p === '/v1/dashboard/owner') {
      const todayWritten = writtenOn(today);
      const lastWeekDay = addDays(today, -7);
      const lastMonthDay = addDays(today, -30);
      return json({
        date: today,
        range: { start: addDays(today, -29), end: today },
        compare: 'prior',
        compareRange: { start: addDays(today, -59), end: addDays(today, -30) },
        kpis: {
          writtenCents: trend.reduce((n, t) => n + t.orderCents, 0),
          writtenCount: 412,
          registerCents: trend.reduce((n, t) => n + t.registerCents, 0),
          ticketCount: 96,
          refundsCents: 349800,
          refundCount: 3,
          openOrders: 41,
          openBalanceCents: 1422000,
          receivablesCents: 1422000,
          receivableAccounts: 38,
          trucksToday: {
            booked: 14,
            cap: 15,
            byStatus: { scheduled: 9, loaded: 3, out_for_delivery: 2 },
          },
        },
        previous: { writtenCents: 0, registerCents: 0, refundsCents: 0 },
        trend,
        compareTrend: trend.map((t) => ({ ...t, orderCents: Math.round(t.orderCents * 0.91) })),
        today: {
          date: today,
          writtenCents: todayWritten,
          ticketCount: orders.filter((o) => o.day === today).length,
          storeCount: 5,
          avgTicketCents: Math.round(
            todayWritten / Math.max(1, orders.filter((o) => o.day === today).length),
          ),
          lastWeek: { date: lastWeekDay, writtenCents: Math.round(todayWritten / 1.14) },
          lastMonth: { date: lastMonthDay, writtenCents: Math.round(todayWritten / 1.06) },
          collectedCents: payments
            .filter((p) => p.day === today)
            .reduce((n, p) => n + p.amountCents, 0),
          collectedLastWeekCents: Math.round(
            payments.filter((p) => p.day === today).reduce((n, p) => n + p.amountCents, 0) / 1.06,
          ),
          balanceDueCents: 1422000,
          refundsCents: 349800,
          refundsLastWeekCents: 219900,
          cancellations: 4,
          cancellationsLastWeek: 3,
          deliveries: { booked: 14, cap: 15 },
        },
        monthToDate: {
          range: { start: monthStart, end: today },
          writtenCents:
            orders.filter((o) => o.day >= monthStart).reduce((n, o) => n + o.amountCents, 0) +
            2_400_000,
          prior: { start: addDays(monthStart, -31), end: addDays(today, -31) },
          priorCents: Math.round(
            (orders.filter((o) => o.day >= monthStart).reduce((n, o) => n + o.amountCents, 0) +
              2_400_000) /
              1.09,
          ),
        },
        exceptions: { open: 5, critical: 2 },
      });
    }
    if (p === '/v1/dashboard/morning') {
      const y = addDays(today, -1);
      return json({
        date: y,
        today,
        salesByStore: STORES.map((s) => ({
          locationId: s.id,
          locationName: s.name,
          saleCount: 2,
          saleTotalCents: Math.round(120000 * s.weight),
          orderCount: 5,
          orderTotalCents: writtenOn(y, s.id) || Math.round(900000 * s.weight),
        })),
        salesByAssociate: [
          { userId: 'u1', name: 'Maya Torres', email: null, totalCents: 1896000 },
          { userId: 'u2', name: 'Devon Park', email: null, totalCents: 1240000 },
        ],
        deliveriesToday: {
          booked: 14,
          cap: 15,
          byStatus: { scheduled: 9, loaded: 3, out_for_delivery: 2 },
        },
        refundsCancellations: [{ id: 'r1' }, { id: 'r2' }],
        modifiedOrders: [
          { orderId: 'o-0-1', changeCount: 3 },
          { orderId: 'o-2-4', changeCount: 1 },
        ],
        openExceptions: { count: 5 },
      });
    }
    if (p === '/v1/dashboard/stores') {
      const period = q.get('period') ?? 'mtd';
      const cards = storesFor(ids).map((s) => storeCard(s, period));
      return json({
        date: today,
        period,
        range:
          period === 'today' ? { start: today, end: today } : { start: monthStart, end: today },
        viewer: { membershipId: 'm1', canConfirmCashPickup: opts.role === 'owner' },
        stores: cards,
        totals: cards.reduce(
          (t, c) => ({
            storeCount: t.storeCount + 1,
            writtenCents: t.writtenCents + c.writtenCents,
            writtenCount: t.writtenCount + c.writtenCount,
            deliveredCents: t.deliveredCents + c.deliveredCents,
            deliveredCount: t.deliveredCount + c.deliveredCount,
            receivedCents: t.receivedCents + c.receivedCents,
            receivedCount: t.receivedCount + c.receivedCount,
            cashPendingCents: t.cashPendingCents + c.cashPendingCents,
          }),
          {
            storeCount: 0,
            writtenCents: 0,
            writtenCount: 0,
            deliveredCents: 0,
            deliveredCount: 0,
            receivedCents: 0,
            receivedCount: 0,
            cashPendingCents: 0,
          },
        ),
      });
    }
    const pm = p.match(/^\/v1\/dashboard\/stores\/([^/]+)\/payments$/);
    if (pm) {
      const s = STORES.find((x) => x.id === pm[1])!;
      const period = q.get('period') ?? 'mtd';
      const m = q.get('method');
      const rows = payments
        .filter((x) => x.storeId === s.id && x.method === m && inPeriod(x.day, period))
        .map((x) => ({
          paymentId: x.paymentId,
          docKind: 'order',
          docId: x.orderId,
          docNumber: x.orderNumber,
          customerName: x.customer,
          soldAt: atHour(x.day, 11),
          paidAt: atHour(x.day, 11, 20),
          kind: 'deposit',
          salespersonName: x.rep,
          amountCents: x.amountCents,
          receipt: x.pickedUp
            ? {
                receivedAt: x.pickedUp.at,
                byMembershipId: 'm-alex',
                byName: x.pickedUp.by,
                byRole: 'Owner',
              }
            : null,
        }));
      return json({
        location: { id: s.id, name: s.name },
        method: m,
        range:
          period === 'today' ? { start: today, end: today } : { start: monthStart, end: today },
        rows,
        totalCents: rows.reduce((n, r) => n + r.amountCents, 0),
        count: rows.length,
      });
    }
    if (p === '/v1/dashboard/cash-pickups/queue') return json(queue(ids));
    if (p === '/v1/dashboard/cash-pickups' && method === 'POST') {
      const b = JSON.parse((init?.body as string) ?? '{}') as {
        locationId: string;
        paymentIds?: string[];
        countedCents: number;
        slip?: string;
      };
      const s = STORES.find((x) => x.id === b.locationId)!;
      const pending = payments.filter(
        (x) => x.storeId === s.id && x.method === 'cash' && !x.pickedUp,
      );
      const chosen = b.paymentIds?.length
        ? pending.filter((x) => b.paymentIds!.includes(x.paymentId))
        : pending;
      if (chosen.length === 0)
        return json({ message: 'No cash payments are waiting for pickup at this store' }, 400);
      pickupSeq += 1;
      const number = `PU-${String(pickupSeq).padStart(4, '0')}`;
      const at = new Date().toISOString();
      const expected = chosen.reduce((n, x) => n + x.amountCents, 0);
      for (const x of chosen) x.pickedUp = { at, by: actor, number };
      const store = queueStore(s);
      return json({
        pickup: {
          id: `pu-${pickupSeq}`,
          number,
          recordedAt: at,
          byName: actor,
          countedCents: b.countedCents,
          expectedCents: expected,
          varianceCents: b.countedCents - expected,
          slip: b.slip ?? null,
          note: null,
          paymentCount: chosen.length,
          locationId: s.id,
          paymentIds: chosen.map((x) => x.paymentId),
        },
        store: {
          ...store,
          lastPickup: {
            ...store.lastPickup!,
            slip: b.slip ?? null,
            countedCents: b.countedCents,
            varianceCents: b.countedCents - expected,
          },
        },
      });
    }
    if (p === '/v1/dashboard/changes') {
      const rows = [
        [
          'critical',
          'SO-10371',
          'Grace Kim',
          'wl',
          'West LA',
          'Refund issued',
          -219900,
          'no return scanned',
          'Sam Whitfield',
          0,
          16,
          2,
        ],
        [
          'warning',
          'SO-10441',
          'Paul Ng',
          'gl',
          'Glendale',
          'Discount 18%',
          -23382,
          'no note',
          'Arman Petrosyan',
          1,
          18,
          40,
        ],
        [
          'warning',
          'SO-10412',
          'Marco Silva',
          'gl',
          'Glendale',
          'Order cancelled',
          -50000,
          'customer changed mind · $500 to credit',
          'Priya Nair',
          5,
          16,
          2,
        ],
        [
          'info',
          'SO-10437',
          'Omar Haddad',
          'gl',
          'Glendale',
          'Delivery moved',
          null,
          'customer request · Sep 5 → Sep 6',
          'Dispatch',
          0,
          11,
          2,
        ],
        [
          'warning',
          'SO-10445',
          'Raj Patel',
          'kt',
          'Koreatown',
          'Price override',
          -64000,
          'match competitor',
          'Devon Park',
          2,
          14,
          15,
        ],
      ] as const;
      return json({
        rows: rows
          .filter(([, , , loc]) => !ids || ids.includes(loc))
          .map(([sev, n, c, loc, locName, label, impact, reason, by, ago, h, m], i) => ({
            id: `chg-${i}`,
            occurredAt: atHour(addDays(today, -ago), h, m),
            type: label.toLowerCase().replace(/ /g, '_'),
            label,
            tone: sev === 'critical' ? 'danger' : sev === 'warning' ? 'warn' : 'info',
            moneyRelated: impact != null,
            was: null,
            now: null,
            reason,
            impactCents: impact,
            orderId: `o-${i}`,
            orderNumber: n,
            customerName: c,
            locationId: loc,
            locationName: locName,
            authorName: by,
            approval: sev === 'critical' ? 'no approval' : 'self-approved',
            seenAt: i === 4 ? atHour(today, 9, 5) : null,
          })),
        counts: { all: 5, money: 4, unseen: 3 },
        viewer: { membershipId: 'm1' },
      });
    }
    if (p === '/v1/schedule') {
      const monday = (() => {
        const d = new Date(`${today}T12:00:00`);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return toDay(d);
      })();
      const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
      const people: [string, string, string][] =
        opts.role === 'manager'
          ? [
              ['Maya Torres', 'Manager', 'gl'],
              ['Arman Petrosyan', 'Salesperson', 'gl'],
              ['Priya Nair', 'Cashier', 'gl'],
            ]
          : [
              ['Maya Torres', 'Manager', 'gl'],
              ['Arman Petrosyan', 'Salesperson', 'gl'],
              ['Devon Park', 'Manager', 'kt'],
              ['Sam Whitfield', 'Manager', 'wl'],
              ['Nina Rossi', 'Manager', 'lb'],
            ];
      const shifts = [null, [540, 1050], [660, 1170], [720, 1200]];
      return json({
        today,
        timezone: 'America/Los_Angeles',
        week: {
          start: monday,
          end: days[6],
          days: days.map((d) => ({
            date: d,
            dow: new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' }),
            isToday: d === today,
          })),
        },
        locations: STORES.map((s) => ({ id: s.id, name: s.name, locationType: 'store' })),
        canEdit: opts.role === 'owner',
        people: people.map(([name, role, loc], pi) => ({
          membershipId: memberId(name),
          name,
          roleName: role,
          locationId: loc,
          locationName: STORES.find((s) => s.id === loc)!.name,
          isLead: role === 'Manager',
          shifts: days
            .map((d, di) => {
              const v = (pi + di) % 7 === 3 || (pi + di) % 7 === 6 ? 0 : 1 + ((pi + di) % 3);
              const sh = shifts[v];
              return sh
                ? { date: d, startMinutes: sh[0], endMinutes: sh[1], published: di < 5 }
                : null;
            })
            .filter(Boolean),
        })),
        unpublishedCount: opts.role === 'owner' ? 3 : 0,
        lastPublishedAt: atHour(addDays(today, -3), 18),
      });
    }
    if (p === '/v1/timeclock/me') {
      if (opts.role !== 'manager') return json({ message: 'forbidden' }, 403);
      return json({
        date: today,
        timezone: 'America/Los_Angeles',
        member: {
          membershipId: 'm1',
          name: 'Maya Torres',
          roleName: 'Manager',
          locationId: 'gl',
          locationName: 'Glendale',
        },
        status: 'in',
        since: atHour(today, 8, 52),
        punchesToday: [{ id: 'tp1', type: 'clock_in', at: atHour(today, 8, 52) }],
        hoursToday: 2.4,
        hoursWeek: 26.1,
        scheduledToday: { startMinutes: 540, endMinutes: 1050 },
        allowed: ['break_start', 'clock_out'],
      });
    }
    if (p === '/v1/dashboard/manager') {
      const s = STORES[0]!;
      const todayOrders = orders.filter((o) => o.storeId === s.id && o.day === today);
      const written = todayOrders.reduce((n, o) => n + o.amountCents, 0);
      const row = (o: FxOrder, extra: Partial<Record<string, unknown>> = {}) => ({
        id: o.id,
        number: o.number,
        status: 'open',
        deliveryStatus: null,
        requestedDate: addDays(today, 2),
        totalCents: o.amountCents,
        balanceDueCents: Math.round(o.amountCents * 0.5),
        customerId: `c-${o.id}`,
        customerName: o.customer,
        customerPhone: '(818) 555-0142',
        salespersonName: o.rep,
        salespersonMembershipId: memberId(o.rep),
        secondSalespersonMembershipId: null,
        createdAt: atHour(o.day, 10),
        shortUnits: 0,
        ...extra,
      });
      const mine = orders.filter((o) => o.storeId === s.id && o.rep === 'Maya Torres');
      const all = orders.filter((o) => o.storeId === s.id);
      return json({
        date: today,
        location: { id: s.id, name: s.name, timezone: 'America/Los_Angeles' },
        locations: STORES.map((x) => ({ id: x.id, name: x.name })),
        membershipId: memberId('Maya Torres'),
        kpis: {
          mine: {
            writtenCents: 0,
            writtenCount: 0,
            collectedCents: 0,
            openCount: 3,
            openBalanceCents: 0,
            closed7dCount: 3,
            closed7dCents: 0,
            monthWrittenCents: 0,
            monthlyGoalCents: null,
            commissionPeriodCents: 0,
          },
          store: {
            writtenCents: written,
            writtenCount: todayOrders.length,
            collectedCents: 1580000,
            tenderMix: [
              { method: 'card', cents: 712000 },
              { method: 'financing', cents: 540000 },
              { method: 'cash', cents: 238000 },
              { method: 'check', cents: 90000 },
            ],
          },
          exceptionsOpen: 5,
          pastDuePromises: 2,
          unpaidAging: 1,
        },
        drawer: { shiftOpen: true, closedToday: false, suspended: false },
        salesByDay: [],
        leaderboardWeek: [
          { name: 'Maya Torres', cents: 1896000 },
          { name: 'Arman Petrosyan', cents: 1420000 },
          { name: 'Priya Nair', cents: 610000 },
        ],
        pipeline: [
          { key: 'draft', count: 2, cents: 448100 },
          { key: 'open', count: 5, cents: 1240000 },
          { key: 'scheduled', count: 4, cents: 990000 },
        ],
        queues: {
          myOpen: mine.slice(0, 4).map((o, i) => row(o, { shortUnits: i === 1 ? 1 : 0 })),
          storeOpen: all.slice(0, 8).map((o, i) =>
            row(o, {
              shortUnits: i === 1 ? 1 : 0,
              requestedDate: i === 2 ? addDays(today, -1) : addDays(today, 2),
            }),
          ),
          recentlyClosed: all
            .slice(5, 8)
            .map((o) =>
              row(o, { status: 'completed', balanceDueCents: 0, deliveryStatus: 'delivered' }),
            ),
          todaysDeliveries: all.slice(0, 3).map((o, i) => ({
            ...row(o, { deliveryStatus: 'scheduled' }),
            deliveryId: `d-${o.id}`,
            deliveryState: 'scheduled',
            scheduledDate: i === 0 ? today : addDays(today, 1),
            windowStart: i === 0 ? '09:00' : '14:00',
            windowEnd: i === 0 ? '12:00' : '17:00',
            driverName: 'R. Mendoza',
            balanceDueCents: i === 0 ? 0 : i === 1 ? 124000 : 40000,
          })),
          backorders: all.slice(1, 2).map((o) => row(o, { shortUnits: 1 })),
          staleCarts: mine.slice(2, 4).map((o, i) =>
            row(o, {
              status: i ? 'quote' : 'draft',
              createdAt: atHour(addDays(today, -6 - i), 15),
            }),
          ),
        },
        returnsInFlight: [
          {
            id: 'rma1',
            rmaNumber: 'RMA-0218',
            status: 'awaiting_goods',
            createdAt: atHour(addDays(today, -3), 12),
            orderId: mine[0]!.id,
            orderNumber: mine[0]!.number,
            customerName: 'Grace Kim',
            salespersonMembershipId: memberId('Maya Torres'),
            salespersonName: 'Maya Torres',
          },
        ],
        incoming: [
          {
            kind: 'transfer',
            id: 't1',
            number: 'TR-0912',
            status: 'in_transit',
            expected: addDays(today, 1),
          },
          {
            kind: 'po',
            id: 'po1',
            number: 'PO-4471',
            status: 'ordered',
            expected: addDays(today, 2),
          },
          {
            kind: 'po',
            id: 'po2',
            number: 'PO-4468',
            status: 'partially_received',
            expected: today,
          },
        ],
        lowStock: [],
        creditHolders: [
          {
            customerId: 'c1',
            customerName: 'Karen Liu',
            phone: '(818) 555-0101',
            balanceCents: 24000,
            salespersonMembershipId: memberId('Maya Torres'),
            salespersonName: 'Maya Torres',
          },
          {
            customerId: 'c2',
            customerName: 'Omar Haddad',
            phone: '(818) 555-0102',
            balanceCents: 12000,
            salespersonMembershipId: memberId('Maya Torres'),
            salespersonName: 'Maya Torres',
          },
        ],
        activity: [
          {
            orderId: all[0]!.id,
            orderNumber: all[0]!.number,
            latestAt: atHour(today, 14, 14),
            events: [
              {
                action: 'order.payment',
                actorName: 'Maya Torres',
                createdAt: atHour(today, 14, 14),
              },
              {
                action: 'order.delivery_scheduled',
                actorName: 'Dispatch',
                createdAt: atHour(today, 12, 1),
              },
            ],
          },
          {
            orderId: all[1]!.id,
            orderNumber: all[1]!.number,
            latestAt: atHour(today, 12, 40),
            events: [
              {
                action: 'order.discount',
                actorName: 'Maya Torres',
                createdAt: atHour(today, 12, 40),
              },
            ],
          },
        ],
        headline: {
          writtenCents: written,
          ticketCount: todayOrders.length,
          avgTicketCents: todayOrders.length ? Math.round(written / todayOrders.length) : 0,
          lastWeek: { date: addDays(today, -7), writtenCents: Math.round(written / 1.12) },
          lastMonth: { date: addDays(today, -30), writtenCents: Math.round(written / 1.02) },
          topRep: { name: 'Arman Petrosyan', count: 3 },
        },
        needsCall: { total: 3, atRisk: 2, waitingOnStock: 1 },
        lastClose: {
          status: 'clean',
          varianceCents: 0,
          closedAt: atHour(addDays(today, -1), 21, 12),
          byName: 'Priya Nair',
          closeDay: addDays(today, -1),
        },
      });
    }
    if (p.startsWith('/v1/')) return json({ message: `stub: ${p}` }, 404);
    return real(input, init);
  };
}
