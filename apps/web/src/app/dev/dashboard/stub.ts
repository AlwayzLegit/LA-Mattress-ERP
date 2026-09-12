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

export type PreviewRole = 'owner' | 'manager' | 'ops' | 'warehouse';

interface StubLead {
  id: string;
  name: string;
  phone: string;
  wanted: string;
  wantedSize: string | null;
  wantedCategory: string | null;
  note: string | null;
  status: string;
  loggedAt: string;
  expiresAt: string;
  daysLeft: number;
  followUpAt: string | null;
  convertedOrderId: string | null;
  convertedOrderNumber: string | null;
  conversion: string | null;
  salesperson: string;
  salespersonMembershipId: string;
  locationId: string;
}

export function installDashboardStub(opts: { role: PreviewRole } = { role: 'owner' }) {
  const w = window as unknown as { __dashStub?: boolean };
  if (w.__dashStub) return;
  w.__dashStub = true;
  const today = toDay(new Date());
  const { orders, payments } = buildFixtures(today);
  let pickupSeq = 90;
  // Sales competitions (Phase 11): the leads the viewer logs in the preview.
  let cLeads: StubLead[] = [];
  // Close-out sheet state (Phase 10): the flagged drawer's verbs and the sign-off.
  let zRecount: { by: string; at: string } | null = null;
  let zReason: { text: string; by: string; at: string } | null = null;
  let zSign: { name: string; at: string; openExceptionCount: number; note: string | null } | null =
    null;
  const zFixtureDay = toDay(new Date(Date.now() - 86_400_000));
  let zLastDate = zFixtureDay;
  const actor =
    opts.role === 'manager'
      ? 'Maya Torres'
      : opts.role === 'ops'
        ? 'Dana Whitmore'
        : opts.role === 'warehouse'
          ? 'Rafael Mendoza'
          : 'Alex Rivera';
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
      canRecord: opts.role === 'owner' || opts.role === 'ops' || s.id === 'gl',
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
        roleName:
          opts.role === 'manager'
            ? 'Manager'
            : opts.role === 'ops'
              ? 'Operations'
              : opts.role === 'warehouse'
                ? 'Warehouse'
                : 'Owner',
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
        viewer: { membershipId: 'm1', canConfirmCashPickup: opts.role !== 'manager' },
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
        opts.role === 'warehouse'
          ? [
              ['Rafael Mendoza', 'Warehouse', 'wh'],
              ['Tomas Nguyen', 'Driver', 'wh'],
              ['Chris Okafor', 'Driver', 'wh'],
              ['Luis Vega', 'Picker', 'wh'],
            ]
          : opts.role === 'manager'
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
        canEdit: opts.role === 'owner' || opts.role === 'ops',
        people: people.map(([name, role, loc], pi) => ({
          membershipId: memberId(name),
          name,
          roleName: role,
          locationId: loc,
          locationName: STORES.find((s) => s.id === loc)?.name ?? 'Warehouse',
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
        unpublishedCount: opts.role === 'owner' || opts.role === 'ops' ? 3 : 0,
        lastPublishedAt: atHour(addDays(today, -3), 18),
      });
    }
    if (p === '/v1/timeclock/me') {
      if (opts.role === 'owner') return json({ message: 'forbidden' }, 403);
      return json({
        date: today,
        timezone: 'America/Los_Angeles',
        member: {
          membershipId: 'm1',
          name: actor,
          roleName:
            opts.role === 'ops'
              ? 'Operations'
              : opts.role === 'warehouse'
                ? 'Warehouse'
                : 'Manager',
          locationId: opts.role === 'warehouse' ? 'wh' : 'gl',
          locationName: opts.role === 'warehouse' ? 'Warehouse' : 'Glendale',
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
    // ---- Operations home ----
    if (p === '/v1/dashboard/operations') {
      const methods = ['card', 'financing', 'cash', 'external_card', 'check', 'gift_card'];
      return json({
        date: today,
        range: { start: q.get('start') ?? today, end: q.get('end') ?? today },
        stores: STORES.map((x) => ({ id: x.id, name: x.name, timezone: 'America/Los_Angeles' })),
        money: {
          inCents: 3321000,
          outCents: 349800,
          netCents: 2971200,
          byTender: methods.map((m) => {
            const list = payments.filter((x) => x.method === m && x.day === today);
            return {
              method: m,
              cents: list.reduce((n, x) => n + x.amountCents, 0),
              count: list.length,
            };
          }),
          out: { refundsCents: 349800, returnsCents: 0, writeOffsCents: 0 },
          exchanges: { count: 1, restockingFeeCents: 0 },
        },
        salesByDay: Array.from({ length: 14 }, (_, i) => {
          const day = addDays(today, i - 13);
          return {
            day,
            writtenCents: i === 13 ? writtenOn(day) : 1800000 + ((i * 3271) % 1400000),
          };
        }),
        byStore: [],
        ritual: [],
      });
    }
    if (p === '/v1/dashboard/operations/feed') {
      const rows = [
        [
          'critical',
          'refund',
          'r1',
          'Refund over threshold',
          'no return scanned on SO-10371',
          -219900,
          'Sam Whitfield',
          'wl',
          'West LA',
          4,
          '/orders/o-2-0',
        ],
        [
          'critical',
          'drawer',
          'd1',
          'Drawer variance · short',
          'La Brea drawer 1 closed short, no recount',
          -8450,
          'Nina Rossi',
          'lb',
          'La Brea',
          11,
          '/shifts',
        ],
        [
          'warning',
          'closeout',
          'c1',
          'Close-out not run',
          'Koreatown opened 9:58 PM; the 10pm close found the drawer open',
          null,
          'Devon Park',
          'kt',
          'Koreatown',
          11,
          '/shifts',
        ],
        [
          'warning',
          'discount_note',
          'dn1',
          'Discount 18% without note',
          'SO-10441 · Paul Ng',
          -23382,
          'Arman Petrosyan',
          'gl',
          'Glendale',
          15,
          '/orders/o-0-1',
        ],
        [
          'warning',
          'override',
          'ov1',
          'Price override ×2',
          'SO-10445 · match competitor',
          -64000,
          'Ivan Kaplan',
          'sc',
          'Studio City',
          26,
          '/orders/o-3-2',
        ],
      ] as const;
      return json({
        rows: rows.map(
          ([
            severity,
            subjectType,
            subjectId,
            kind,
            summary,
            amountCents,
            actorName,
            locationId,
            locationName,
            hoursAgo,
            href,
          ]) => ({
            subjectType,
            subjectId,
            severity,
            kind,
            summary,
            amountCents,
            actorUserId: `u-${actorName}`,
            actorName,
            locationId,
            locationName,
            href,
            occurredAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
            clearVia: 'review',
          }),
        ),
        total: 5,
        thresholds: {
          refundCents: 50000,
          discountPct: 15,
          overrideCents: 20000,
          drawerVarianceCents: 2000,
          inventoryAdjustUnits: 5,
          takeWithOpenHours: 2,
          lookbackDays: 7,
        },
      });
    }
    if (p === '/v1/ops-reviews/bulk' && method === 'POST') return json({ cleared: 1 });
    if (p === '/v1/dashboard/operations/salespeople') {
      return json(
        STORES.flatMap((st) =>
          st.reps.map((r) => {
            const ro = orders.filter((o) => o.rep === r);
            const w = ro.reduce((n, o) => n + o.amountCents, 0);
            const disc = 3 + (r.length % 10);
            return {
              key: memberId(r),
              name: `${r} · ${st.name}`,
              writtenCents: w,
              writtenCount: ro.length,
              collectedCents: payments
                .filter((x) => x.rep === r)
                .reduce((n, x) => n + x.amountCents, 0),
              refundedCents: r === st.manager ? st.refunds : 0,
              discountCents: Math.round((w * disc) / 100),
              discountPct: disc,
            };
          }),
        ).sort((a, b) => b.writtenCents - a.writtenCents),
      );
    }
    if (p === '/v1/dashboard/operations/digest') {
      return json([
        {
          actorUserId: 'u1',
          actorName: 'Sam Whitfield',
          total: 3,
          amountCents: 349800,
          byKind: { 'Refund over threshold': 2, 'Drawer variance': 1 },
          worstSeverity: 'critical',
        },
        {
          actorUserId: 'u2',
          actorName: 'Devon Park',
          total: 1,
          amountCents: 64000,
          byKind: { 'Price override': 1 },
          worstSeverity: 'warning',
        },
        {
          actorUserId: null,
          actorName: null,
          total: 3,
          amountCents: 0,
          byKind: { 'Inventory adjustment': 3 },
          worstSeverity: 'info',
        },
      ]);
    }
    if (p === '/v1/dashboard/operations/activity') {
      return json([
        {
          orderId: 'o-0-0',
          orderNumber: 'SO-10437',
          latestAt: new Date(Date.now() - 9 * 60_000).toISOString(),
          events: [
            { action: 'payment recorded', actorName: 'Maya', createdAt: today },
            { action: 'delivery scheduled', actorName: 'Dispatch', createdAt: today },
            { action: 'written', actorName: 'Priya', createdAt: today },
          ],
        },
        {
          orderId: 'o-0-1',
          orderNumber: 'SO-10412',
          latestAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          events: [
            { action: 'discount applied', actorName: 'Maya', createdAt: today },
            { action: 'written', actorName: 'Tara', createdAt: today },
          ],
        },
        {
          orderId: 'o-1-3',
          orderNumber: 'SO-10398',
          latestAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
          events: [{ action: 'balance collected', actorName: 'Priya', createdAt: today }],
        },
        {
          orderId: 'o-2-0',
          orderNumber: 'SO-10371',
          latestAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
          events: [
            { action: 'refund issued', actorName: 'Sam', createdAt: today },
            { action: 'return opened', actorName: 'Sam', createdAt: today },
          ],
        },
      ]);
    }
    // ---- Warehouse home ----
    if (p === '/v1/dashboard/warehouse') {
      return json({
        date: today,
        location: { id: 'wh', name: 'Warehouse', timezone: 'America/Los_Angeles' },
        locations: [
          { id: 'wh', name: 'Warehouse', locationType: 'warehouse' },
          ...STORES.map((x) => ({ id: x.id, name: x.name, locationType: 'store' })),
        ],
        inbound: [
          {
            id: 'po1',
            number: 'PO-4471',
            vendorName: 'Tempur Sealy',
            locationName: 'Warehouse',
            expectedAt: atHour(today, 9),
            orderedUnits: 48,
            receivedUnits: 0,
            overdue: false,
          },
          {
            id: 'po2',
            number: 'PO-4468',
            vendorName: 'Purple',
            locationName: 'Warehouse',
            expectedAt: atHour(today, 9),
            orderedUnits: 38,
            receivedUnits: 20,
            overdue: false,
          },
          {
            id: 'po3',
            number: 'PO-4462',
            vendorName: 'Brooklyn Bedding',
            locationName: 'Warehouse',
            expectedAt: atHour(addDays(today, -5), 9),
            orderedUnits: 24,
            receivedUnits: 0,
            overdue: true,
          },
          {
            id: 'po4',
            number: 'PO-4475',
            vendorName: 'Serta Simmons',
            locationName: 'Warehouse',
            expectedAt: atHour(addDays(today, 2), 9),
            orderedUnits: 60,
            receivedUnits: 0,
            overdue: false,
          },
        ],
        dock: [
          {
            id: 'po2',
            number: 'PO-4468',
            vendorName: 'Purple',
            locationName: 'Warehouse',
            unitsInProgress: 20,
            lastActivityAt: atHour(addDays(today, -2), 14),
          },
          {
            id: 'po5',
            number: 'PO-4459',
            vendorName: 'Malouf',
            locationName: 'Warehouse',
            unitsInProgress: 18,
            lastActivityAt: atHour(addDays(today, -5), 11),
          },
        ],
        pickups: [
          {
            orderId: 'o-1-1',
            number: 'SO-10402',
            customerName: 'Dana Wu',
            locationName: 'Warehouse',
            ageDays: 2,
            ready: true,
          },
          {
            orderId: 'o-1-2',
            number: 'SO-10419',
            customerName: 'Felix Moreno',
            locationName: 'Warehouse',
            ageDays: 5,
            ready: false,
          },
          {
            orderId: 'o-1-3',
            number: 'SO-10388',
            customerName: 'Grace Kim',
            locationName: 'Warehouse',
            ageDays: 9,
            ready: true,
          },
          {
            orderId: 'o-1-4',
            number: 'SO-10377',
            customerName: 'Ivan Petrov',
            locationName: 'Warehouse',
            ageDays: 1,
            ready: true,
          },
          {
            orderId: 'o-1-5',
            number: 'SO-10366',
            customerName: 'Lena Fischer',
            locationName: 'Warehouse',
            ageDays: 3,
            ready: false,
          },
        ],
        arrived: [
          {
            orderId: 'o-2-1',
            orderNumber: 'SO-10391',
            customerName: 'Helen Park',
            locationName: 'Glendale',
            description: 'Tempur-Pedic ProAdapt King',
            quantity: 1,
            arrivedAt: atHour(addDays(today, -2), 10),
          },
          {
            orderId: 'o-2-2',
            orderNumber: 'SO-10405',
            customerName: 'Marco Silva',
            locationName: 'Koreatown',
            description: 'Purple Hybrid Queen',
            quantity: 2,
            arrivedAt: atHour(today, 8),
          },
        ],
        transfers: {
          rows: [
            {
              id: 't1',
              number: 'TR-0912',
              direction: 'outbound',
              fromName: 'Warehouse',
              toName: 'Glendale',
              status: 'in_transit',
              units: 6,
              days: 1,
              awaitingTicket: false,
            },
            {
              id: 't2',
              number: 'TR-0915',
              direction: 'outbound',
              fromName: 'Warehouse',
              toName: 'Koreatown',
              status: 'in_transit',
              units: 4,
              days: 0,
              awaitingTicket: true,
            },
            {
              id: 't3',
              number: 'TR-0908',
              direction: 'outbound',
              fromName: 'Warehouse',
              toName: 'West LA',
              status: 'in_transit',
              units: 3,
              days: 4,
              awaitingTicket: false,
            },
          ],
          closedShort30d: 1,
        },
        asIs: {
          count: 4,
          costCents: 184000,
          oldestAt: atHour(addDays(today, -6), 9),
          rows: [
            {
              id: 'a1',
              productName: 'Sealy Posturepedic Queen',
              locationName: 'Warehouse',
              quantity: 1,
              condition: 'floor model · scuffed',
              createdAt: atHour(addDays(today, -6), 9),
            },
            {
              id: 'a2',
              productName: 'Casper Original Full',
              locationName: 'Warehouse',
              quantity: 1,
              condition: 'returned · open box',
              createdAt: atHour(addDays(today, -2), 9),
            },
            {
              id: 'a3',
              productName: 'Malouf pillow',
              locationName: 'Warehouse',
              quantity: 2,
              condition: 'damaged packaging',
              createdAt: atHour(addDays(today, -1), 9),
            },
          ],
        },
        counts: {
          open: [{ id: 'c1', countDate: today, status: 'in_progress', locationName: 'Zone C' }],
          lastPostedDate: atHour(addDays(today, -15), 18),
          negative: [
            {
              variantId: 'v1',
              productName: 'Purple Hybrid Queen',
              sku: 'PH-Q-01',
              locationName: 'Warehouse',
              onHand: -1,
            },
            {
              variantId: 'v2',
              productName: 'Malouf Z pillow',
              sku: 'MZ-STD',
              locationName: 'Warehouse',
              onHand: -2,
            },
          ],
        },
      });
    }
    if (p === '/v1/dashboard/warehouse/loadout') {
      const mk = (i: number, route: string, driver: string, status: string) => ({
        deliveryId: `d${i}`,
        orderId: `o-0-${i % 9}`,
        orderNumber: `SO-${10430 + i}`,
        customerName: CUSTOMERS[i % CUSTOMERS.length],
        locationName: 'Glendale',
        windowStart: `${String(8 + (i % 4) * 2).padStart(2, '0')}:00`,
        windowEnd: `${String(11 + (i % 4) * 2).padStart(2, '0')}:00`,
        route,
        driverName: driver,
        status,
        pieces: 1 + (i % 3),
        serialShort: i === 7,
      });
      const rows = [
        ...Array.from({ length: 6 }, (_, i) =>
          mk(
            i,
            'Truck A',
            'R. Mendoza',
            i < 3 ? 'delivered' : i < 5 ? 'out_for_delivery' : 'loaded',
          ),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          mk(6 + i, 'Truck B', 'T. Nguyen', i < 2 ? 'delivered' : 'out_for_delivery'),
        ),
        ...Array.from({ length: 3 }, (_, i) => mk(11 + i, 'Truck C', 'C. Okafor', 'scheduled')),
      ];
      return json({
        date: today,
        cap: 15,
        stops: rows.length,
        pieces: rows.reduce((n, r) => n + r.pieces, 0),
        rows,
      });
    }
    if (p === '/v1/dashboard/warehouse/picklist') {
      const rows = [
        ['A-12', 'Tempur-Pedic ProAdapt', 'Queen', 'TP-PA-Q', 2, 4, false],
        ['B-04', 'Sealy Posturepedic Plus', 'Queen', 'SP-PL-Q', 1, 3, false],
        ['B-09', 'Adjustable base', 'Queen', 'AB-Q', 2, 1, true],
        ['C-01', 'Cloud Comfort Mattress', 'Queen', 'CC-Q', 1, 6, false],
        ['C-07', 'Purple Hybrid 3', 'King', 'PH3-K', 2, 2, false],
      ] as const;
      return json({
        date: addDays(today, 1),
        rows: rows.map(([bin, productName, variantName, sku, quantity, onHand, short], i) => ({
          variantId: `pv${i}`,
          locationId: 'wh',
          locationName: 'Warehouse',
          productName,
          variantName,
          sku,
          bin,
          quantity,
          onHand,
          short,
          serialShort: false,
        })),
      });
    }
    // ---- Close-out sheet (Z-report, Phase 10) ----
    if (
      p === '/v1/closeouts/report' ||
      p === '/v1/closeouts/sign-off' ||
      p.startsWith('/v1/closeouts/drawers/')
    ) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
      let zDate = q.get('date') ?? body.date ?? today;
      const zLoc = q.get('locationId') ?? body.locationId ?? 'gl';
      if (p === '/v1/closeouts/sign-off') {
        zSign = {
          name: actor,
          at: new Date().toISOString(),
          openExceptionCount: zReason ? 0 : 1,
          note: body.note || null,
        };
      }
      if (p.endsWith('/recount')) zRecount = { by: actor, at: new Date().toISOString() };
      if (p.endsWith('/reason'))
        zReason = { text: body.reason ?? '', by: actor, at: new Date().toISOString() };
      if (p.startsWith('/v1/closeouts/drawers/')) zDate = zLastDate;
      zLastDate = zDate;
      const at = (d: string, hm: string) => new Date(`${d}T${hm}:00`).toISOString();
      const store = STORES.find((s) => s.id === zLoc) ?? STORES[0]!;
      const isFixtureDay = zDate === zFixtureDay;
      const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
        new Date(`${zDate}T00:00:00`).getDay()
      ];
      const short = zReason ? 'reason recorded' : zRecount ? 'recount requested' : 'no recount';
      const did = isFixtureDay
        ? [
            { tone: 'ok', text: 'Posted 9 sales and 3 order payments to the ledger' },
            { tone: 'ok', text: 'Checked 2 drawers — every one closed' },
            { tone: 'ok', text: 'Every delivery scheduled today was completed' },
            {
              tone: zReason ? 'ok' : zRecount ? 'hold' : 'risk',
              text: zReason
                ? `Drawer 2 short $84.50 — reason recorded by ${actor}`
                : `Flagged Drawer 2 short $84.50 — ${short}`,
            },
            {
              tone: 'hold',
              text: 'Released stock on 1 stale order — promised over 30 days ago, no truck booked',
            },
            { tone: 'info', text: '1 of 1 exception still open on the register' },
          ]
        : zDate >= today
          ? [{ tone: 'hold', text: 'Runs at 10:00 PM store time — nothing posted yet' }]
          : [
              { tone: 'ok', text: 'Posted 6 sales and 2 order payments to the ledger' },
              { tone: 'ok', text: 'Checked 1 drawer — every one closed' },
              { tone: 'ok', text: 'Every delivery scheduled today was completed' },
            ];
      return json({
        date: zDate,
        today,
        location: {
          id: store.id,
          name: store.name,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        locations: STORES.map((s) => ({ id: s.id, name: s.name })),
        baseline: { date: zDate, label: `last ${wd}` },
        tiles: isFixtureDay
          ? {
              sales: { count: 9, baseline: 8 },
              gross: { cents: 1_896_000, baseline: 1_690_000 },
              tax: { cents: 180_120, ratePct: 9.5 },
              refunds: { cents: 129_900, count: 1, baseline: 0 },
              net: { cents: 1_766_100, baseline: 1_690_000 },
              orderMoney: { cents: 412_000, orderCount: 3 },
            }
          : {
              sales: { count: 6, baseline: 7 },
              gross: { cents: 1_242_000, baseline: 1_318_000 },
              tax: { cents: 117_990, ratePct: 9.5 },
              refunds: { cents: 0, count: 0, baseline: 24_900 },
              net: { cents: 1_242_000, baseline: 1_293_100 },
              orderMoney: { cents: 260_000, orderCount: 2 },
            },
        tenders: isFixtureDay
          ? [
              { method: 'card', count: 5, amountCents: 1_124_000 },
              { method: 'financing', count: 2, amountCents: 630_000 },
              { method: 'cash', count: 3, amountCents: 188_450 },
              { method: 'check', count: 1, amountCents: 79_800 },
            ]
          : [
              { method: 'card', count: 4, amountCents: 812_000 },
              { method: 'cash', count: 2, amountCents: 130_000 },
            ],
        refundLine: isFixtureDay
          ? { count: 1, amountCents: 129_900 }
          : { count: 0, amountCents: 0 },
        drawers: isFixtureDay
          ? [
              {
                id: 'sh1',
                number: 1,
                openedAt: at(zDate, '09:58'),
                closedAt: at(zDate, '18:02'),
                openedBy: 'Maya Torres',
                closedBy: 'Maya Torres',
                openingFloatCents: 20_000,
                expectedCashCents: 61_250,
                countedCashCents: 61_250,
                varianceCents: 0,
                status: 'clean',
                closeAttempts: 0,
                recount: null,
                reason: null,
              },
              {
                id: 'sh2',
                number: 2,
                openedAt: at(zDate, '12:00'),
                closedAt: at(zDate, '20:45'),
                openedBy: 'Sam Whitfield',
                closedBy: 'Sam Whitfield',
                openingFloatCents: 20_000,
                expectedCashCents: 100_800,
                countedCashCents: 92_350,
                varianceCents: -8_450,
                status: 'short',
                closeAttempts: 1,
                recount: zRecount,
                reason: zReason,
              },
            ]
          : zDate >= today
            ? []
            : [
                {
                  id: 'sh0',
                  number: 1,
                  openedAt: at(zDate, '10:02'),
                  closedAt: at(zDate, '19:10'),
                  openedBy: 'Maya Torres',
                  closedBy: 'Maya Torres',
                  openingFloatCents: 20_000,
                  expectedCashCents: 150_000,
                  countedCashCents: 150_000,
                  varianceCents: 0,
                  status: 'clean',
                  closeAttempts: 0,
                  recount: null,
                  reason: null,
                },
              ],
        close:
          zDate >= today
            ? null
            : {
                id: 'co1',
                ranAt: at(zDate, '22:00'),
                trigger: 'scheduler',
                exceptionCount: isFixtureDay ? 1 : 0,
                stockReleasedCount: isFixtureDay ? 1 : 0,
                findings: {
                  openCashShifts: 0,
                  undeliveredToday: 0,
                  openRuns: 0,
                  deliveredWithBalance: 0,
                },
              },
        closeHour: 22,
        did,
        exceptions: isFixtureDay ? { open: 1, total: 1 } : { open: 0, total: 0 },
        events: isFixtureDay
          ? [
              {
                kind: 'refund',
                number: 'SO-10371',
                href: '/orders/o-10371',
                who: 'Sam Whitfield',
                note: 'refund, no return scanned',
                amountCents: -129_900,
                at: at(zDate, '15:12'),
              },
              {
                kind: 'cancellation',
                number: 'SO-10412',
                href: '/orders/o-10412',
                who: 'Priya Natarajan',
                note: 'cancelled, $500.00 paid still on the order',
                amountCents: 50_000,
                at: at(zDate, '17:40'),
              },
            ]
          : [],
        signoff: isFixtureDay ? zSign : null,
        viewer: { canSignOff: true, signable: zDate < today },
      });
    }
    // ---- Sales competitions (Phase 11) ----
    if (p.startsWith('/v1/competitions/')) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
      const scope = q.get('scope') === 'stores' ? 'stores' : 'people';
      const dim = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
      const dom = Number(today.slice(8, 10));
      const daysLeft = Math.max(0, dim - dom);
      const monthName = new Date(`${today}T12:00:00`).toLocaleDateString('en-US', {
        month: 'long',
      });
      const PEOPLE = [
        ['p-ronnie', 'Ronnie Alvarez', 'wl'],
        ['p-elyse', 'Elyse Nakamura', 'sc'],
        ['p-julio', 'Julio Reyes', 'gl'],
        ['m1', opts.role === 'manager' ? 'Maya Torres' : 'Arman Petrosyan', 'gl'],
        ['p-geoff', 'Geoff Lam', 'kt'],
        ['p-wayne', 'Wayne Brooks', 'lb'],
        ['p-brandon', 'Brandon Cole', 'sc'],
      ] as const;
      const STAT: Record<
        string,
        {
          leads: [number, number];
          sales: number;
          net: number;
          high: number;
          beds: number;
          ex: number;
        }
      > = {
        'p-ronnie': { leads: [9, 15], sales: 19, net: 3_872_000, high: 624_000, beds: 4, ex: 2 },
        'p-elyse': { leads: [6, 11], sales: 17, net: 4_126_000, high: 1_140_000, beds: 7, ex: 0 },
        'p-julio': { leads: [5, 7], sales: 11, net: 2_310_000, high: 480_000, beds: 6, ex: 1 },
        m1: { leads: [4, 9], sales: 14, net: 2_984_000, high: 598_000, beds: 5, ex: 1 },
        'p-geoff': { leads: [3, 8], sales: 9, net: 1_720_000, high: 410_000, beds: 2, ex: 1 },
        'p-wayne': { leads: [2, 4], sales: 6, net: 1_160_000, high: 390_000, beds: 1, ex: 0 },
        'p-brandon': { leads: [1, 6], sales: 8, net: 1_984_000, high: 736_000, beds: 3, ex: 0 },
      };
      const CODE: Record<string, string> = { gl: 'GL', wl: 'WL', sc: 'SC', kt: 'KT', lb: 'LB' };
      const usd = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
      const first = (n: string) => n.split(' ')[0]!;
      type Subj = {
        id: string;
        name: string;
        storeId: string;
        storeName: string;
        leads: [number, number];
        sales: number;
        net: number;
        high: number;
        beds: number;
        ex: number;
      };
      let subjects: Subj[] = PEOPLE.map(([id, name, st]) => ({
        id,
        name,
        storeId: st,
        storeName: STORES.find((s) => s.id === st)!.name,
        ...STAT[id]!,
      }));
      if (scope === 'stores') {
        const byStore = new Map<string, Subj>();
        for (const s of subjects) {
          const cur = byStore.get(s.storeId) ?? {
            id: s.storeId,
            name: s.storeName,
            storeId: s.storeId,
            storeName: s.storeName,
            leads: [0, 0] as [number, number],
            sales: 0,
            net: 0,
            high: 0,
            beds: 0,
            ex: 0,
          };
          cur.leads = [cur.leads[0] + s.leads[0], cur.leads[1] + s.leads[1]];
          cur.sales += s.sales;
          cur.net += s.net;
          cur.high = Math.max(cur.high, s.high);
          cur.beds += s.beds;
          cur.ex += s.ex;
          byStore.set(s.storeId, cur);
        }
        subjects = [...byStore.values()];
      }
      const meId = scope === 'people' ? 'm1' : 'gl';
      const defs = [
        {
          key: 'leads',
          title: 'Lead Conversion',
          sub: 'converted leads',
          metricLabel: 'Converted',
          detailLabel: 'Logged',
          unit: 'leads',
          rule: 'Lead converts when a completed order matches the phone within 30 days.',
          empty: 'No leads logged yet. Log the next customer who walks out without buying.',
        },
        {
          key: 'avg',
          title: 'Average Ticket',
          sub: 'net ÷ completed orders',
          metricLabel: 'Average',
          detailLabel: 'Orders',
          unit: '$',
          rule: 'No minimum order count — a one-sale average is fragile and says so.',
          empty: 'First completed sale sets the bar.',
        },
        {
          key: 'high',
          title: 'Highest Ticket',
          sub: 'one order',
          metricLabel: 'Order',
          detailLabel: 'Customer',
          unit: '$',
          rule: 'The single largest completed order this month.',
          empty: 'The first order of the month is the biggest — for now.',
        },
        {
          key: 'sales',
          title: 'Most Sales',
          sub: 'completed orders',
          metricLabel: 'Orders',
          detailLabel: 'Net',
          unit: 'sales',
          rule: 'Count of completed orders; net dollars shown small.',
          empty: 'Zero across the board. Every store starts even.',
        },
        {
          key: 'beds',
          title: 'Most Adjustable Beds',
          sub: 'units on completed orders',
          metricLabel: 'Beds',
          detailLabel: '',
          unit: 'beds',
          rule: 'Adjustable base units on completed orders.',
          empty: 'No bases sold yet.',
        },
        {
          key: 'ex',
          title: 'Least Exchanges',
          sub: 'fewest, as a fraction of sales',
          metricLabel: 'Exchanges',
          detailLabel: 'Sales',
          unit: 'exchanges',
          rule: 'Ties break by most sales. Zero sales is not ranked.',
          empty: 'Nobody has sold, so nobody is ranked. Sell first.',
        },
      ] as const;
      const metric = (s: Subj, k: string) =>
        k === 'leads'
          ? s.leads[0]
          : k === 'avg'
            ? Math.round(s.net / s.sales)
            : k === 'high'
              ? s.high
              : k === 'sales'
                ? s.sales
                : k === 'beds'
                  ? s.beds
                  : s.ex;
      const fmt = (v: number, k: string) => (k === 'avg' || k === 'high' ? usd(v) : String(v));
      const detail = (s: Subj, k: string) =>
        k === 'leads'
          ? `of ${s.leads[1]}`
          : k === 'avg'
            ? `${s.sales} sales`
            : k === 'high'
              ? `${CODE[s.storeId]}-${10230 + s.sales} · ${['Priya', 'Helen', 'Dana', 'Omar', 'Karen', 'Felix', 'Nadia'][s.sales % 7]}`
              : k === 'sales'
                ? usd(s.net)
                : k === 'beds'
                  ? ''
                  : `of ${s.sales}`;
      const gap = (k: string, lv: number, mv: number, ln: string) => {
        const d = k === 'ex' ? mv - lv : lv - mv;
        return k === 'leads'
          ? `${d} lead${d === 1 ? '' : 's'} behind ${first(ln)}`
          : k === 'sales'
            ? `${d} sale${d === 1 ? '' : 's'} behind ${first(ln)}`
            : k === 'beds'
              ? `${d} bed${d === 1 ? '' : 's'} behind ${first(ln)}`
              : k === 'ex'
                ? `${d} more exchange${d === 1 ? '' : 's'} than ${first(ln)}`
                : `${usd(d)} behind ${first(ln)}`;
      };
      const leadCount = new Map<string, number>();
      const cards = defs.map((d) => {
        const ranked = subjects
          .map((s) => ({ s, v: metric(s, d.key) }))
          .sort((a, b) => (d.key === 'ex' ? a.v - b.v : b.v - a.v) || b.s.net - a.s.net);
        const rows = ranked.map((r, i) => ({
          id: r.s.id,
          name: r.s.name,
          storeId: r.s.storeId,
          storeCode: CODE[r.s.storeId] ?? null,
          storeName: r.s.storeName,
          rank: i + 1,
          value: r.v,
          valueLabel: fmt(r.v, d.key),
          detail: detail(r.s, d.key),
          netCents: r.s.net,
          sales: r.s.sales,
          spark: Array.from({ length: 10 }, (_, j) =>
            Math.max(0, Math.round(((r.v || 1) / 10) * (1 + Math.sin(j + i)))),
          ),
          orders: Array.from({ length: Math.min(4, r.s.sales) }, (_, j) => ({
            id: `o-0-${j}`,
            number: `${CODE[r.s.storeId]}-${10430 + j * 3}`,
            who: ['Omar H.', 'Karen L.', 'Dana W.', 'Felix M.'][j]!,
            amountCents: [129_900, 203_900, 277_900, 351_900][j]!,
            at: `${today}T1${j}:00:00`,
          })),
          isYou: r.s.id === meId,
        }));
        const leader = rows[0]!;
        const mine = rows.find((r) => r.isYou) ?? null;
        leadCount.set(leader.id, (leadCount.get(leader.id) ?? 0) + 1);
        const paceV =
          d.key === 'avg' || d.key === 'high' || d.key === 'ex'
            ? leader.value
            : Math.round((leader.value / Math.max(dom, 1)) * dim);
        const max = Math.max(leader.value, paceV, 1);
        return {
          ...d,
          on: true,
          prizeCents: 10_000,
          rows,
          top: rows.slice(0, 3),
          you: mine
            ? {
                rank: mine.rank,
                value: mine.value,
                valueLabel: mine.valueLabel,
                gap:
                  mine.rank === 1 ? 'you lead' : gap(d.key, leader.value, mine.value, leader.name),
              }
            : null,
          unranked: null,
          leader: { name: leader.name, value: leader.value },
          pace: {
            leaderPct: Math.round((leader.value / max) * 100),
            youPct: mine ? Math.round((mine.value / max) * 100) : 0,
            pacePct: Math.round((paceV / max) * 100),
            label: fmt(paceV, d.key),
          },
        };
      });
      const sweepEntry = [...leadCount.entries()].sort((a, b) => b[1] - a[1])[0]!;
      const sweepName = subjects.find((s) => s.id === sweepEntry[0])!.name;
      if (p === '/v1/competitions/current') {
        return json({
          month: today.slice(0, 7),
          monthLabel: monthName,
          today,
          dayOfMonth: dom,
          daysInMonth: dim,
          daysLeft,
          endsAt: `${new Date(`${today.slice(0, 7)}-${dim}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, 11:59 PM`,
          last48: daysLeft <= 2 && daysLeft > 0,
          isDayOne: false,
          scope,
          scopes: ['people', 'stores'],
          config: {
            prizeCents: 10_000,
            sweep: { four: 100_000, five: 150_000, six: 200_000 },
            payoutDay: 5,
            payoutLabel: `${new Date(`${today.slice(0, 7)}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short' }) === 'Dec' ? 'Jan' : new Date(new Date(`${today}T12:00:00`).setMonth(new Date(`${today}T12:00:00`).getMonth() + 1)).toLocaleDateString('en-US', { month: 'short' })} 5`,
            returnWindowDays: 30,
          },
          viewer: {
            membershipId: 'm1',
            name: actor,
            storeId: 'gl',
            storeName: 'Glendale',
            canLog: opts.role !== 'warehouse' && opts.role !== 'ops',
            defaultScope: opts.role === 'owner' ? 'stores' : 'people',
          },
          cards,
          sweep:
            sweepEntry[1] >= 3
              ? {
                  name: sweepEntry[0] === meId ? 'You' : sweepName,
                  n: sweepEntry[1],
                  bonus:
                    sweepEntry[1] >= 4
                      ? usd(sweepEntry[1] >= 6 ? 200_000 : sweepEntry[1] >= 5 ? 150_000 : 100_000)
                      : 'one more for $1,000',
                  isYou: sweepEntry[0] === meId,
                }
              : null,
          banner:
            dom <= 3
              ? {
                  month: 'prev',
                  label: 'Last month’s winners',
                  winners: [
                    {
                      race: 'leads',
                      title: 'Lead Conversion',
                      name: 'Ronnie Alvarez',
                      store: 'West LA',
                      story: '9 leads converted of 14 logged',
                      short: '9 converted',
                      value: '9',
                      prizeCents: 10_000,
                    },
                  ],
                  until: `${today.slice(0, 7)}-03`,
                  storesLine: 'Stores race: Studio City took 3 of 6. Store prize to the manager.',
                }
              : null,
        });
      }
      if (p === '/v1/competitions/history') {
        return json(
          defs.flatMap((d, i) => [
            {
              month: '2026-08',
              label: 'August 2026',
              race: d.key,
              title: d.title,
              winner: [
                'Ronnie Alvarez',
                'Brandon Cole',
                'Elyse Nakamura',
                'Ronnie Alvarez',
                'Elyse Nakamura',
                'Wayne Brooks',
              ][i],
              winnerStore: [
                'West LA',
                'Studio City',
                'Studio City',
                'West LA',
                'Studio City',
                'La Brea',
              ][i],
              result: ['9 converted', '$2,480 avg', '$11,400', '21 sales', '8 beds', '0 of 9'][i],
              storeWinner: 'Studio City',
              yourRank: [4, 3, 5, 3, 3, 4][i],
              paid: 'paid Sep 5',
            },
            {
              month: '2026-07',
              label: 'July 2026',
              race: d.key,
              title: d.title,
              winner: 'Elyse Nakamura',
              winnerStore: 'Studio City',
              result: ['7 converted', '$2,310 avg', '$9,800', '18 sales', '6 beds', '0 of 12'][i],
              storeWinner: 'Glendale',
              yourRank: 2,
              paid: 'paid Aug 5',
            },
          ]),
        );
      }
      if (p === '/v1/competitions/sheet') {
        return json({
          month: '2026-08',
          label: 'August 2026',
          payoutLabel: 'September 5',
          prizeCents: 10_000,
          storesLine: 'Stores race: Studio City took 3 of 6. Store prize to the manager.',
          stores: [],
          winners: [
            {
              race: 'leads',
              title: 'Lead Conversion',
              name: 'Ronnie',
              store: 'West LA',
              story: '9 leads converted of 14 logged',
              short: '9 converted',
              value: '9',
              prizeCents: 10_000,
            },
            {
              race: 'avg',
              title: 'Average Ticket',
              name: 'Brandon',
              store: 'Studio City',
              story: '$2,480 across 6 sales',
              short: '$2,480 avg',
              value: '$2,480',
              prizeCents: 10_000,
            },
            {
              race: 'high',
              title: 'Highest Ticket',
              name: 'Elyse',
              store: 'Studio City',
              story: 'SC-10198, Nadia, a King ProAdapt with two bases',
              short: '$11,400',
              value: '$11,400',
              prizeCents: 10_000,
            },
            {
              race: 'sales',
              title: 'Most Sales',
              name: 'Ronnie',
              store: 'West LA',
              story: '21 completed orders, $44,120 net',
              short: '21 sales',
              value: '21',
              prizeCents: 10_000,
            },
            {
              race: 'beds',
              title: 'Most Adjustable Beds',
              name: 'Elyse',
              store: 'Studio City',
              story: '8 bases on completed orders',
              short: '8 beds',
              value: '8',
              prizeCents: 10_000,
            },
            {
              race: 'ex',
              title: 'Least Exchanges',
              name: 'Wayne',
              store: 'La Brea',
              story: '0 exchanges on 9 sales',
              short: '0 of 9',
              value: '0 / 9',
              prizeCents: 10_000,
            },
          ],
        });
      }
      // Leads
      const mkLead = (
        i: number,
        name: string,
        phone: string,
        wanted: string,
        dayAgo: number,
        status: string,
        order?: string,
      ): StubLead => ({
        id: `lead-${i}`,
        name,
        phone,
        wanted,
        wantedSize: null,
        wantedCategory: null,
        note: null,
        status,
        loggedAt: new Date(Date.now() - dayAgo * 86_400_000).toISOString(),
        expiresAt: new Date(Date.now() + (30 - dayAgo) * 86_400_000).toISOString(),
        daysLeft: 30 - dayAgo,
        followUpAt: null,
        convertedOrderId: order ? 'o-0-1' : null,
        convertedOrderNumber: order ?? null,
        conversion: order ? (i === 1 ? 'manual' : 'auto') : null,
        salesperson: actor,
        salespersonMembershipId: 'm1',
        locationId: 'gl',
      });
      if (p === '/v1/competitions/leads' && method === 'GET') {
        return json(
          cLeads.length
            ? cLeads
            : (cLeads = [
                mkLead(
                  0,
                  'Marisol',
                  '(818) 555-0142',
                  'Queen, Hybrid, wants to see the ProAdapt again',
                  2,
                  'open',
                ),
                mkLead(
                  1,
                  'Dev',
                  '(323) 555-0199',
                  'King, Adjustable base',
                  5,
                  'converted',
                  'GL-10441',
                ),
                mkLead(2, 'Walk-in', '(818) 555-0117', 'Full, Memory foam', 9, 'open'),
                mkLead(
                  3,
                  'Tanya',
                  '(310) 555-0155',
                  'Cal King, Specific product, Purple 4',
                  14,
                  'converted',
                  'GL-10422',
                ),
                mkLead(
                  4,
                  'Ken',
                  '(818) 555-0170',
                  'Twin, Innerspring, for the guest room',
                  21,
                  'lost',
                ),
              ]),
        );
      }
      if (p === '/v1/competitions/leads' && method === 'POST') {
        const digits = (body.phone ?? '').replace(/\D/g, '');
        const dup = cLeads.find(
          (x) => x.status === 'open' && x.phone.replace(/\D/g, '') === digits,
        );
        if (dup) return json(dup);
        const l = mkLead(
          100 + cLeads.length,
          body.name || 'Walk-in',
          body.phone ?? '',
          [body.wantedSize, body.wantedCategory, body.note].filter(Boolean).join(', ') || '—',
          0,
          'open',
        );
        cLeads = [l, ...cLeads];
        return json(l);
      }
      const verb = /\/v1\/competitions\/leads\/([^/]+)\/(follow-up|attach|lost)$/.exec(p);
      if (verb) {
        const l = cLeads.find((x) => x.id === verb[1]);
        if (!l) return json({ message: 'Lead not found' }, 404);
        if (verb[2] === 'follow-up') l.followUpAt = new Date(Date.now() + 86_400_000).toISOString();
        if (verb[2] === 'lost') l.status = 'lost';
        if (verb[2] === 'attach') {
          l.status = 'converted';
          l.convertedOrderId = 'o-0-2';
          l.convertedOrderNumber = (body.orderNumber || 'GL-10452').toUpperCase();
          l.conversion = 'manual';
        }
        return json(l);
      }
    }
    if (p === '/v1/business/settings' && method === 'PATCH') {
      const patch = init?.body ? (JSON.parse(String(init.body)) as { ops?: unknown }) : {};
      return json({ id: 'b1', name: 'LA Mattress', ops: patch.ops ?? null });
    }
    if (p.startsWith('/v1/')) return json({ message: `stub: ${p}` }, 404);
    return real(input, init);
  };
}
