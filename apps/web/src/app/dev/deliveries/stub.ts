/**
 * Fixtures behind a fetch stub for the Deliveries previews (redesign
 * Phase 8): the week from the canvas (11 · 14 · 8 · 15 · 16 · 4 · 0),
 * a pickup on Tuesday, an over-cap note on Friday, plus five weeks of
 * roll-up data for Month. PATCH moves a stop and refuses over the cap
 * unless confirmed with a note, like the server.
 */

const NAMES: [string, string][] = [
  ['Elena Marquez', 'Glendale'],
  ['Omar Haddad', 'Koreatown'],
  ['Grace Kim', 'La Brea'],
  ['Tom Nguyen', 'Studio City'],
  ['Ana Silva', 'West LA'],
  ['Ben Carter', 'Burbank'],
  ['Dana Wu', 'Pasadena'],
  ['Luis Ortega', 'Glendale'],
  ['Priya Nair', 'Silver Lake'],
  ['Marcus Lee', 'Echo Park'],
  ['Sofia Rossi', 'Los Feliz'],
  ['Noah Bennett', 'Sherman Oaks'],
  ['Mia Chen', 'Culver City'],
  ['Jonah Park', 'Highland Park'],
  ['Ruth Adler', 'Eagle Rock'],
  ['Victor Cruz', 'Van Nuys'],
];
const WINDOWS: [string, string][] = [
  ['08:00', '11:00'],
  ['09:00', '12:00'],
  ['11:00', '14:00'],
  ['13:00', '16:00'],
  ['15:00', '18:00'],
];
const ITEMS = [
  'Cloud Comfort Mattress — Queen',
  'Adjustable base — Queen',
  'Sealy Posturepedic Plus — King',
  'Tempur-Pedic ProAdapt — Queen',
  'Mattress protector — Queen',
  'Purple Hybrid 3 — King',
];

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

export interface FxDelivery {
  id: string;
  orderId: string;
  kind: 'delivery' | 'return_pickup';
  rmaNumber: string | null;
  orderNumber: string;
  customerName: string;
  scheduledDate: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  route: string | null;
  routePosition: number;
  runId: string | null;
  notes: string | null;
  addressLine1: string;
  addressLine2: string | null;
  addressCity: string;
  addressRegion: string;
  addressPostalCode: string;
  addressPhone: string;
  balanceDueCents: number;
  lines: { id: string; description: string; quantity: number; lineType: string }[];
}

export function buildFixtures(today: string): FxDelivery[] {
  // Anchored on today so the interesting days (dispatched today, over-cap
  // tomorrow, pickup and near-cap after that, an empty target day) are always
  // ahead of the viewer regardless of the weekday the preview is opened.
  const FIRST = -14;
  const past = [9, 12, 10, 13, 11, 3, 0, 11, 14, 8, 15, 12, 4, 0];
  const ahead = [4, 16, 14, 8, 15, 11, 0];
  const later = [
    12, 15, 9, 14, 13, 5, 0, 8, 10, 14, 12, 16, 2, 0, 10, 11, 9, 13, 12, 4, 0, 9, 12, 10, 13, 11, 3,
    0,
  ];
  const counts = [...past, ...ahead, ...later];
  const out: FxDelivery[] = [];
  let n = 10400;
  counts.forEach((count, idx) => {
    {
      const offset = FIRST + idx;
      const date = addDays(today, offset);
      const dow = idx % 7;
      for (let i = 0; i < count; i++) {
        n += 1;
        const [name, city] = NAMES[(n + dow) % NAMES.length]!;
        const [ws, we] = WINDOWS[i % WINDOWS.length]!;
        const past = date < today;
        const isToday = date === today;
        const pickup = offset === 2 && i === 3;
        const status = past
          ? i % 9 === 8
            ? 'failed'
            : 'delivered'
          : isToday && i < 3
            ? 'out_for_delivery'
            : isToday && i < 6
              ? 'loaded'
              : 'scheduled';
        const item = ITEMS[(n + i) % ITEMS.length]!;
        out.push({
          id: `d${n}`,
          orderId: `o${n}`,
          kind: pickup ? 'return_pickup' : 'delivery',
          rmaNumber: pickup ? 'RMA-0218' : null,
          orderNumber: `SO-${n}`,
          customerName: name,
          scheduledDate: date,
          windowStart: ws,
          windowEnd: we,
          status,
          route: city,
          routePosition: i + 1,
          runId: null,
          notes:
            offset === 1 && i === 15
              ? `Over cap ${date}: Two Glendale reschedules from Thu; second truck requested. — R. Mendoza`
              : i % 5 === 2
                ? 'Call 30 min ahead'
                : null,
          addressLine1: `${400 + n} N ${city.split(' ')[0]} Blvd`,
          addressLine2: i % 4 === 1 ? 'Gate code 4471' : null,
          addressCity: city,
          addressRegion: 'CA',
          addressPostalCode: '9120' + (i % 9),
          addressPhone: `(818) 555-01${String(n % 100).padStart(2, '0')}`,
          balanceDueCents: pickup ? 0 : [124017, 0, 145456, 40000, 0][i % 5]!,
          lines: [
            { id: `l${n}a`, description: item, quantity: 1, lineType: 'stock' },
            ...(i % 3 === 0
              ? [
                  {
                    id: `l${n}b`,
                    description: 'Adjustable base — Queen',
                    quantity: 1,
                    lineType: 'stock',
                  },
                ]
              : []),
          ],
        });
      }
    }
  });
  return out;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function installDeliveriesStub() {
  const w = window as unknown as { __delStub?: boolean; __delRows?: FxDelivery[] };
  if (w.__delStub) return;
  w.__delStub = true;
  const today = toDay(new Date());
  const rows = buildFixtures(today);
  w.__delRows = rows;
  const CAP = 15;
  const live = (r: FxDelivery) => ['scheduled', 'loaded', 'out_for_delivery'].includes(r.status);
  const booked = (date: string) => rows.filter((r) => r.scheduledDate === date && live(r)).length;
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input as Request).url,
      location.origin,
    );
    const p = url.pathname;
    const q = url.searchParams;
    const method = init?.method ?? 'GET';
    if (p === '/v1/business/members/me')
      return json({
        membershipId: 'm1',
        roleName: 'Manager',
        hiddenNav: [],
        sellingScope: 'all',
        scopeLocations: [],
      });
    if (p === '/v1/business/members')
      return json([{ membershipId: 'm9', name: 'R. Mendoza', email: 'r@x', status: 'active' }]);
    if (p === '/v1/business/locations' || p === '/v1/pos/locations')
      return json([{ id: 'wh', name: 'Warehouse', locationType: 'warehouse' }]);
    if (p === '/v1/business/settings/pos') return json({ ops: null });
    if (p === '/v1/deliveries') {
      const from = q.get('from') ?? '0000';
      const to = q.get('to') ?? '9999';
      return json(rows.filter((r) => r.scheduledDate >= from && r.scheduledDate <= to));
    }
    if (p === '/v1/deliveries/capacity') {
      const from = q.get('from') ?? today;
      const to = q.get('to') ?? today;
      const days: {
        date: string;
        booked: number;
        remaining: number;
        pieces: number;
        capacityUnits: number;
      }[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const b = booked(d);
        days.push({
          date: d,
          booked: b,
          remaining: Math.max(0, CAP - b),
          pieces: b,
          capacityUnits: b,
        });
        if (days.length > 70) break;
      }
      return json({ cap: CAP, pieceCap: null, unitCap: null, days });
    }
    if (p === '/v1/delivery-runs') {
      const date = q.get('date');
      return json(
        date === today
          ? [
              {
                id: 'run1',
                route: 'Glendale → Studio City → West LA → back',
                truck: 'Truck A',
                driverMembershipId: 'm9',
                status: 'open',
                notes: null,
              },
            ]
          : [],
      );
    }
    const dm = p.match(/^\/v1\/deliveries\/([^/]+)$/);
    if (dm) {
      const r = rows.find((x) => x.id === dm[1]);
      if (!r) return json({ message: 'not found' }, 404);
      if (method === 'PATCH') {
        const b = JSON.parse(String(init?.body ?? '{}')) as {
          scheduledDate?: string;
          confirmOverCapacity?: boolean;
          overCapacityNote?: string;
        };
        if (b.scheduledDate && b.scheduledDate !== r.scheduledDate) {
          const target = booked(b.scheduledDate);
          if (target >= CAP && !b.confirmOverCapacity) {
            return json(
              {
                statusCode: 409,
                code: 'OVER_CAPACITY',
                dimensions: [`stops (${target}/${CAP})`],
                message: `${b.scheduledDate} is over capacity on stops (${target}/${CAP}). Confirm to book beyond the cap.`,
              },
              409,
            );
          }
          if (target >= CAP) {
            if (!b.overCapacityNote?.trim())
              return json(
                {
                  message:
                    'A one-line note is required to move a stop over the cap — it prints on the day sheet',
                },
                400,
              );
            r.notes = [
              r.notes,
              `Over cap ${b.scheduledDate}: ${b.overCapacityNote.trim()} — R. Mendoza`,
            ]
              .filter(Boolean)
              .join('\n');
          }
          r.scheduledDate = b.scheduledDate;
          r.routePosition = booked(b.scheduledDate);
        }
        return json(r);
      }
      return json(r);
    }
    if (p.startsWith('/v1/')) return json({ message: `stub: ${p}` }, 404);
    return real(input, init);
  };
}
