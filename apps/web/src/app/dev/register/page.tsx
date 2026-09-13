'use client';

import { useEffect, useState } from 'react';
import { NewSale } from '@/components/new-sale';
import { BusinessSettingsProvider } from '@/lib/business-settings';

/**
 * `/dev/register` — the Phase 4 register on fixtures: the catalog and
 * stores from `Proto New Sale.dc.html`, served by a fetch stub so the
 * screen can be exercised without a session or an API. Never shipped
 * behind the shell; the real register is `/pos`.
 */

const LOCS = [
  { id: 'wh', name: 'Warehouse', taxRateBps: 950, locationType: 'warehouse', canSellHere: true },
  { id: 'gl', name: 'Glendale', taxRateBps: 950, locationType: 'store', canSellHere: true },
  { id: 'kt', name: 'Koreatown', taxRateBps: 950, locationType: 'store', canSellHere: true },
  { id: 'lb', name: 'La Brea', taxRateBps: 950, locationType: 'store', canSellHere: true },
  { id: 'sc', name: 'Studio City', taxRateBps: 950, locationType: 'store', canSellHere: true },
  { id: 'wl', name: 'West LA', taxRateBps: 950, locationType: 'store', canSellHere: true },
];
const IDS = ['wh', 'gl', 'kt', 'lb', 'sc', 'wl'];
const CAT: [string, string, string, string, number, string, string, number[], number][] = [
  [
    'Cloud Comfort Mattress',
    'CCM-Q',
    'Queen',
    'Medium',
    1299,
    'Cloud Comfort',
    'CC-1200-Q',
    [6, 1, 2, 0, 1, 2],
    4,
  ],
  [
    'Cloud Comfort Mattress',
    'CCM-K',
    'King',
    'Medium',
    1599,
    'Cloud Comfort',
    'CC-1200-K',
    [3, 0, 1, 1, 0, 1],
    2,
  ],
  [
    'Sealy Posturepedic Plus',
    'SLY-PP-Q',
    'Queen',
    'Firm',
    899,
    'Tempur Sealy',
    'PP-52140-Q',
    [11, 2, 1, 1, 2, 1],
    6,
  ],
  [
    'Tempur-Pedic ProAdapt',
    'TP-PA-Q',
    'Queen',
    'Medium firm',
    2699,
    'Tempur Sealy',
    'PA-10741-Q',
    [5, 1, 0, 1, 0, 1],
    0,
  ],
  ['Purple Hybrid 3', 'PUR-H3-K', 'King', 'Plush', 2699, 'Purple', 'PH3-K', [0, 0, 0, 0, 0, 0], 4],
  [
    'Adjustable base',
    'ADJ-B-Q',
    'Queen',
    '—',
    699,
    'Leggett & Platt',
    'S-CAPE-Q',
    [8, 1, 1, 0, 1, 2],
    0,
  ],
  [
    'Memory foam pillow',
    'PIL-MF',
    'Standard',
    '—',
    129,
    'Tempur Sealy',
    'CLOUD-STD',
    [24, 6, 4, 3, 5, 4],
    0,
  ],
  ['Mattress protector', 'PRO-Q', 'Queen', '—', 69, 'Malouf', 'ST-PRO-Q', [40, 8, 5, 6, 7, 6], 0],
];
const PRODUCTS = CAT.map(([name, sku, size, firm, price, vendor, model, avail, po], i) => ({
  variantId: `v${i + 1}`,
  productId: `p${i + 1}`,
  productName: name,
  variantName: size,
  sku,
  priceCents: price * 100,
  vendorId: vendor,
  vendorName: vendor,
  size,
  firmness: firm,
  categoryPath:
    /mattress|hybrid|adapt/i.test(name) && !/protector/i.test(name)
      ? 'Mattresses › Hybrid'
      : /adjustable/i.test(name)
        ? 'Adjustable Bases › Adjustable Bed Bases'
        : /protector/i.test(name)
          ? 'Mattress Protection › Mattress Protectors'
          : /pillow/i.test(name)
            ? 'Pillows'
            : null,
  model,
  avail: Object.fromEntries(IDS.map((id, j) => [id, avail[j]])) as Record<string, number>,
  po,
  taxRateBps: null as number | null,
}));
const CUSTOMERS = [
  {
    id: 'c1',
    firstName: 'Omar',
    lastName: 'Haddad',
    email: 'omar@example.com',
    phone: '(818) 555-0142',
    addressesJson: [{ line1: '410 N Brand Blvd', city: 'Glendale', region: 'CA' }],
  },
  {
    id: 'c2',
    firstName: 'Karen',
    lastName: 'Liu',
    email: null,
    phone: '(213) 555-0177',
    addressesJson: [{ line1: '3250 Wilshire Blvd', city: 'Los Angeles', region: 'CA' }],
  },
  {
    id: 'c3',
    firstName: 'Dana',
    lastName: 'Wu',
    email: 'dana@example.com',
    phone: '(310) 555-0199',
    addressesJson: null,
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installStub() {
  const w = window as unknown as { __regStub?: boolean };
  if (w.__regStub) return;
  w.__regStub = true;
  const real = window.fetch.bind(window);
  let orderSeq = 10441;
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input as Request).url,
      location.origin,
    );
    const p = url.pathname;
    const q = url.searchParams;
    if (!p.startsWith('/v1/')) return real(input, init);
    if (p === '/v1/pos/locations') return json(LOCS);
    if (p === '/v1/business/members')
      return json([
        {
          membershipId: 'm1',
          name: 'Arman Petrosyan',
          email: 'arman@lamattress.com',
          status: 'active',
        },
        { membershipId: 'm2', name: 'Maya Torres', email: 'maya@lamattress.com', status: 'active' },
        { membershipId: 'm3', name: 'Priya Nair', email: 'priya@lamattress.com', status: 'active' },
      ]);
    if (p === '/v1/business/settings/pos')
      return json({
        currencyCode: 'USD',
        ops: { recyclingFeeCents: 1800, defaultSourceLocationId: null },
      });
    if (p === '/v1/orders' && (init?.method ?? 'GET') === 'GET')
      return json({
        data: [
          {
            id: 'd1',
            number: 'SO-10438',
            customerId: 'c2',
            totalCents: 259800,
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
          },
          {
            id: 'd2',
            number: 'SO-10436',
            customerId: 'c3',
            totalCents: 89900,
            createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          },
        ],
      });
    if (p === '/v1/orders' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        lines?: { quantity: number; unitPriceCents: number }[];
      };
      const total = (body.lines ?? []).reduce((a, l) => a + l.quantity * l.unitPriceCents, 0);
      return json({
        id: `o${orderSeq}`,
        number: `SO-${orderSeq++}`,
        totalCents: Math.round(total * 1.095),
      });
    }
    if (/^\/v1\/orders\/[^/]+\/(payments|deliveries|complete|cancel)$/.test(p))
      return json({ ok: true });
    if (p === '/v1/customers' && (init?.method ?? 'GET') === 'GET') {
      const s = (q.get('q') ?? '').toLowerCase();
      const digits = s.replace(/\D/g, '');
      return json({
        data: CUSTOMERS.filter(
          (c) =>
            `${c.firstName} ${c.lastName}`.toLowerCase().includes(s) ||
            (digits.length >= 3 && (c.phone ?? '').replace(/\D/g, '').includes(digits)),
        ),
        nextCursor: null,
      });
    }
    if (p === '/v1/customers' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      return json({ id: `c${Date.now()}`, addressesJson: null, ...b });
    }
    const cm = p.match(/^\/v1\/customers\/([^/]+)(\/(open-orders|store-credit))?$/);
    if (cm) {
      if (cm[3] === 'open-orders') return json([]);
      if (cm[3] === 'store-credit') return json({ balanceCents: cm[1] === 'c1' ? 5000 : 0 });
      return json(CUSTOMERS.find((c) => c.id === cm[1]) ?? CUSTOMERS[0]);
    }
    if (p === '/v1/deliveries/capacity') return json({ cap: 15, days: [{ booked: 8 }] });
    if (p === '/v1/pos/catalog-count') return json({ total: 1948 });
    if (p === '/v1/vendors')
      return json([...new Set(PRODUCTS.map((x) => x.vendorName))].map((n) => ({ id: n, name: n })));
    if (p === '/v1/pos/product-search') {
      const loc = q.get('locationId') ?? 'wh';
      const ids = q.get('variantIds')?.split(',') ?? null;
      const words = (q.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = PRODUCTS.filter((x) => (ids ? ids.includes(x.variantId) : true))
        .filter((x) =>
          words.every((w) =>
            `${x.productName} ${x.sku} ${x.vendorName} ${x.model} ${x.size} ${x.firmness}`
              .toLowerCase()
              .includes(w),
          ),
        )
        .map((x) => ({
          variantId: x.variantId,
          productId: x.productId,
          productName: x.productName,
          variantName: x.variantName,
          sku: x.sku,
          priceCents: x.priceCents,
          vendorId: x.vendorId,
          vendorName: x.vendorName,
          size: x.size,
          firmness: x.firmness,
          availableHere: x.avail[loc] ?? 0,
          availableTotal: Object.values(x.avail).reduce((a, b) => a + b, 0),
          atpDate: x.po > 0 && (x.avail[loc] ?? 0) === 0 ? '2026-09-20' : null,
          taxRateBps: x.taxRateBps,
        }));
      return json(rows);
    }
    if (p === '/v1/search') {
      const digits = (q.get('q') ?? '').replace(/\D/g, '');
      const hit = CUSTOMERS.find(
        (c) => digits.length >= 7 && (c.phone ?? '').replace(/\D/g, '').includes(digits),
      );
      return json({
        customers: hit
          ? [{ id: hit.id, name: `${hit.firstName} ${hit.lastName}`, phone: hit.phone }]
          : [],
        orders: [],
        sales: [],
      });
    }
    return json({}, 404);
  };
}

export default function RegisterPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installStub();
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <BusinessSettingsProvider>
      <div
        className="mx-auto w-full max-w-[1560px] px-[22px] pb-12 pt-[22px]"
        style={{ background: 'var(--bg)', minHeight: '100vh' }}
      >
        <div className="t-mono-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
          PREVIEW · FIXTURES FROM THE PROTOTYPE · NOTHING IS SAVED
        </div>
        <NewSale />
      </div>
    </BusinessSettingsProvider>
  );
}
