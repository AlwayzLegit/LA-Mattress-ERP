/**
 * Synthetic history for local performance and QA work.
 *
 * Fills a business that already holds a catalog (the STORIS import under
 * docs/imports) with the records a real store accumulates in a year —
 * staff, customers, written orders with lines, tenders, deliveries and
 * purchase orders — so page loads, searches and reports can be measured at
 * production-like volume. Deterministic (seeded PRNG), pure Drizzle inserts,
 * never touches audit, webhooks or production paths.
 *
 *   DATABASE_URL=postgres://… tsx src/seed-synthetic.ts \
 *     [--business acme-furniture] [--customers 3000] [--orders 5000]
 *
 * Refuses to run twice against the same business (looks for its own
 * customer numbers). Not wired into `pnpm db:seed`; it is a dev tool.
 */
import { hashPassword } from 'better-auth/crypto';
import { eq, sql } from 'drizzle-orm';
import { createClient } from './client';
import {
  accounts,
  businesses,
  categories,
  customers,
  deliveries,
  deliveryLines,
  inventoryLevels,
  locations,
  membershipLocationScopes,
  memberships,
  orderLines,
  orderSequences,
  orders,
  payments,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  roles,
  users,
  vendors,
} from './schema';

// ---------------------------------------------------------------- helpers

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** mulberry32 — small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20261018);
const ri = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
function weighted<T>(xs: readonly { v: T; w: number }[]): T {
  const total = xs.reduce((s, x) => s + x.w, 0);
  let r = rand() * total;
  for (const x of xs) {
    r -= x.w;
    if (r <= 0) return x.v;
  }
  return xs[xs.length - 1]!.v;
}

const DAY = 86_400_000;
/** Local-day arithmetic (America/Los_Angeles ≈ UTC-7 is close enough for seed data). */
const LA_OFFSET_MS = 7 * 3_600_000;
const isoDay = (d: Date) => new Date(d.getTime() - LA_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
/** A timestamp on the given local day at a store-hours clock time. */
function atStoreHours(day: Date, hourLo = 10, hourHi = 19): Date {
  const local = day.getTime() - LA_OFFSET_MS;
  const midnight = local - (local % DAY) + LA_OFFSET_MS;
  return new Date(midnight + ri(hourLo, hourHi) * 3_600_000 + ri(0, 59) * 60_000);
}

async function chunked<T>(rows: T[], size: number, fn: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

const FIRST = [
  'James',
  'Maria',
  'David',
  'Jennifer',
  'Michael',
  'Linda',
  'Robert',
  'Patricia',
  'Jose',
  'Elizabeth',
  'Daniel',
  'Susan',
  'Carlos',
  'Jessica',
  'Kevin',
  'Sarah',
  'Brian',
  'Karen',
  'Andrew',
  'Nancy',
  'Luis',
  'Lisa',
  'Juan',
  'Sandra',
  'Anthony',
  'Ashley',
  'Mark',
  'Kimberly',
  'Steven',
  'Emily',
  'Paul',
  'Donna',
  'Jorge',
  'Michelle',
  'Kenneth',
  'Carol',
  'Min',
  'Amanda',
  'Young',
  'Melissa',
  'Hiroshi',
  'Deborah',
  'Ahmed',
  'Stephanie',
  'Omar',
  'Rebecca',
  'Sergey',
  'Laura',
  'Diego',
  'Sharon',
  'Ana',
  'Cynthia',
  'Grace',
  'Angela',
  'Ethan',
  'Olivia',
  'Noah',
  'Sophia',
  'Liam',
  'Isabella',
];
const LAST = [
  'Garcia',
  'Smith',
  'Rodriguez',
  'Johnson',
  'Hernandez',
  'Kim',
  'Lopez',
  'Lee',
  'Martinez',
  'Williams',
  'Gonzalez',
  'Brown',
  'Nguyen',
  'Jones',
  'Perez',
  'Davis',
  'Sanchez',
  'Miller',
  'Rivera',
  'Wilson',
  'Torres',
  'Anderson',
  'Park',
  'Thomas',
  'Flores',
  'Taylor',
  'Ramirez',
  'Moore',
  'Chen',
  'Jackson',
  'Cruz',
  'White',
  'Wang',
  'Harris',
  'Reyes',
  'Martin',
  'Gomez',
  'Thompson',
  'Diaz',
  'Robinson',
  'Tran',
  'Clark',
  'Morales',
  'Lewis',
  'Patel',
  'Walker',
  'Choi',
  'Hall',
  'Gutierrez',
  'Young',
  'Castillo',
  'Allen',
  'Jimenez',
  'King',
  'Cohen',
  'Wright',
  'Ortiz',
  'Scott',
  'Singh',
  'Green',
];
const STREETS = [
  'Wilshire Blvd',
  'Sunset Blvd',
  'Pico Blvd',
  'Olympic Blvd',
  'Vermont Ave',
  'Western Ave',
  'La Brea Ave',
  'Fairfax Ave',
  'Ventura Blvd',
  'Melrose Ave',
  'Beverly Blvd',
  '3rd St',
  'Santa Monica Blvd',
  'Sepulveda Blvd',
  'Figueroa St',
  'Crenshaw Blvd',
  'Laurel Canyon Blvd',
];
const CITIES: { city: string; zips: string[] }[] = [
  {
    city: 'Los Angeles',
    zips: [
      '90004',
      '90005',
      '90006',
      '90010',
      '90019',
      '90020',
      '90036',
      '90048',
      '90064',
      '90025',
      '90034',
      '90035',
    ],
  },
  { city: 'Studio City', zips: ['91604'] },
  { city: 'Sherman Oaks', zips: ['91403', '91423'] },
  { city: 'Glendale', zips: ['91201', '91205'] },
  { city: 'Culver City', zips: ['90230', '90232'] },
  { city: 'Santa Monica', zips: ['90401', '90405'] },
  { city: 'Pasadena', zips: ['91101', '91106'] },
  { city: 'Burbank', zips: ['91502', '91505'] },
  { city: 'Beverly Hills', zips: ['90210', '90211'] },
  { city: 'Torrance', zips: ['90501', '90503'] },
];
const AREA_CODES = ['213', '310', '323', '424', '818', '747', '626', '562'];
const EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'icloud.com', 'hotmail.com'];
const CARD_BRANDS = [
  { v: 'visa', w: 50 },
  { v: 'mastercard', w: 30 },
  { v: 'amex', w: 12 },
  { v: 'discover', w: 8 },
];
const FINANCING = [
  { v: 'Synchrony', w: 70 },
  { v: 'Acima', w: 30 },
];
const FINANCING_MONTHS = [6, 12, 18, 24, 36];

type OrderInsert = typeof orders.$inferInsert;
type LineInsert = typeof orderLines.$inferInsert;
type PaymentInsert = typeof payments.$inferInsert;
type DeliveryInsert = typeof deliveries.$inferInsert;
type DeliveryDraft = { row: DeliveryInsert; lineIdx: number[] };
type OrderDraft = OrderInsert & {
  _lines: LineInsert[];
  _pay: PaymentInsert[];
  _deliv: DeliveryDraft[];
};

// --------------------------------------------------------------- the seed

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const slug = arg('--business', 'acme-furniture');
  const onlyPos = process.argv.includes('--only-pos');
  const customerCount = onlyPos ? 0 : Number(arg('--customers', '3000'));
  const orderCount = onlyPos ? 0 : Number(arg('--orders', '5000'));
  const startedAt = Date.now();
  const { db, sql: pg } = createClient({ url, max: 4 });
  const log = (m: string) =>
    console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${m}`);

  try {
    const [biz] = await db.select().from(businesses).where(eq(businesses.slug, slug)).limit(1);
    if (!biz) throw new Error(`No business with slug "${slug}"`);
    const businessId = biz.id;

    const [already] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        sql`${customers.businessId} = ${businessId} AND ${customers.customerNumber} LIKE 'SYN-%'`,
      )
      .limit(1);
    if (already && !onlyPos) {
      throw new Error('Synthetic data already present for this business; aborting.');
    }

    const locs = await db
      .select()
      .from(locations)
      .where(sql`${locations.businessId} = ${businessId} AND ${locations.isActive} = true`);
    const stores = locs.filter((l) => l.locationType === 'store');
    const warehouse = locs.find((l) => l.locationType === 'warehouse');
    if (stores.length === 0 || !warehouse) {
      throw new Error('Need at least one active store and one warehouse location.');
    }
    const storeWeights = stores.map((s, i) => ({ v: s, w: [30, 25, 25, 20, 15, 10][i] ?? 10 }));

    const roleRows = await db.select().from(roles).where(eq(roles.businessId, businessId));
    const roleId = (name: string) => {
      const r = roleRows.find((x) => x.name === name);
      if (!r) throw new Error(`Role ${name} missing — run the base seed first`);
      return r.id;
    };
    const [ownerMembership] = await db
      .select({ id: memberships.id, userId: memberships.userId })
      .from(memberships)
      .where(
        sql`${memberships.businessId} = ${businessId} AND ${memberships.roleId} = ${roleId('Owner')}`,
      )
      .limit(1);
    if (!ownerMembership) throw new Error('Owner membership missing');

    // ---- 1. Prices. STORIS exports carry cost only (decision D12); the
    //         register cannot sell a $0 variant, so price the catalog.
    const variantRows = await db
      .select({
        id: productVariants.id,
        priceCents: productVariants.priceCents,
        costCents: productVariants.costCents,
        name: products.name,
        category: categories.name,
        vendorId: productVariants.preferredVendorId,
        active: productVariants.isActive,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(sql`${productVariants.businessId} = ${businessId} AND ${products.isActive} = true`);
    const priceIds: string[] = [];
    const prices: number[] = [];
    for (const v of variantRows) {
      if (v.priceCents !== 0 || !v.active) continue;
      let price: number;
      if (v.costCents && v.costCents > 0) {
        const markup = 1.8 + rand() * 0.8;
        price = Math.ceil((v.costCents * markup) / 1000) * 1000 - 1; // ends in .99
      } else {
        price = pick([2999, 4999, 7999, 9999, 14999, 19999]);
      }
      v.priceCents = price;
      priceIds.push(v.id);
      prices.push(price);
    }
    if (priceIds.length > 0) {
      await pg`UPDATE product_variants AS v SET price_cents = d.price
        FROM unnest(${priceIds}::uuid[], ${prices}::int[]) AS d(id, price) WHERE v.id = d.id`;
    }
    log(`Priced ${priceIds.length} variants (of ${variantRows.length}).`);
    const sellable = variantRows.filter((v) => v.active && v.priceCents > 0);
    const byCat = (re: RegExp) => sellable.filter((v) => re.test(v.category ?? ''));
    const pools = [
      { v: byCat(/^MATT/i), w: 50 },
      { v: byCat(/^FOUND/i), w: 14 },
      { v: byCat(/^ADJUST/i), w: 8 },
      { v: byCat(/^BED|^FURN/i), w: 9 },
      { v: byCat(/^PROT|^PILLOW|^TOPBED|^SUPPLY/i), w: 19 },
    ].filter((p) => p.v.length > 0);
    const recyclable = (v: { category: string | null }) =>
      /^(MATT|FOUND|ADJUST)/i.test(v.category ?? '');

    // ---- 2. Staff: a manager and a salesperson per store, plus back office.
    const passwordHash = await hashPassword('ChangeMe!2024');
    type Seller = { membershipId: string; userId: string; storeId: string | null };
    const sellers: Seller[] = [
      { membershipId: ownerMembership.id, userId: ownerMembership.userId, storeId: null },
    ];
    type Store = (typeof stores)[number];
    const staff: {
      email: string;
      name: string;
      role: string;
      store: Store | null;
      goal: number | null;
      managerDashboard: boolean;
    }[] = [];
    for (const s of stores) {
      const key = s.name.toLowerCase().replace(/[^a-z]/g, '');
      staff.push({
        email: `manager.${key}@lamattress.local`,
        name: `${pick(FIRST)} ${pick(LAST)}`,
        role: 'Manager',
        store: s,
        goal: 6_000_000,
        managerDashboard: true,
      });
      staff.push({
        email: `sales.${key}@lamattress.local`,
        name: `${pick(FIRST)} ${pick(LAST)}`,
        role: 'Cashier',
        store: s,
        goal: 3_500_000,
        managerDashboard: false,
      });
    }
    staff.push({
      email: 'operations@lamattress.local',
      name: 'Dana Operations',
      role: 'Operations',
      store: null,
      goal: null,
      managerDashboard: false,
    });
    staff.push({
      email: 'warehouse@lamattress.local',
      name: 'Will Warehouse',
      role: 'Warehouse',
      store: null,
      goal: null,
      managerDashboard: false,
    });
    staff.push({
      email: 'books@lamattress.local',
      name: 'Bea Books',
      role: 'Bookkeeper',
      store: null,
      goal: null,
      managerDashboard: false,
    });

    const existingUsers = await db.select({ id: users.id, email: users.email }).from(users);
    for (const m of onlyPos ? [] : staff) {
      let userId = existingUsers.find((u) => u.email.toLowerCase() === m.email)?.id;
      if (!userId) {
        const [u] = await db
          .insert(users)
          .values({ email: m.email, emailVerified: true, name: m.name })
          .returning({ id: users.id });
        userId = u!.id;
        await db
          .insert(accounts)
          .values({ accountId: userId, providerId: 'credential', userId, password: passwordHash });
      }
      const [mem] = await db
        .insert(memberships)
        .values({
          businessId,
          userId,
          roleId: roleId(m.role),
          status: 'active',
          acceptedAt: addDays(new Date(), -400),
          dataScope: 'all',
          sellingScope: m.store ? 'approved' : 'all',
          managerDashboard: m.managerDashboard,
          monthlyGoalCents: m.goal,
        })
        .returning({ id: memberships.id });
      if (m.store) {
        await db
          .insert(membershipLocationScopes)
          .values({ membershipId: mem!.id, locationId: m.store.id, businessId });
        sellers.push({ membershipId: mem!.id, userId, storeId: m.store.id });
      }
    }
    log(`Staff: ${staff.length} members (password ChangeMe!2024).`);

    // ---- 3. Customers.
    const now = new Date();
    const usedPhones = new Set<string>();
    const customerRows: (typeof customers.$inferInsert)[] = [];
    for (let i = 0; i < customerCount; i++) {
      const first = pick(FIRST);
      const last = pick(LAST);
      let phone = '';
      do {
        phone = `${pick(AREA_CODES)}-555-${String(ri(0, 9999)).padStart(4, '0')}`;
      } while (usedPhones.has(phone));
      usedPhones.add(phone);
      const place = pick(CITIES);
      const createdAt = addDays(now, -Math.floor(Math.pow(rand(), 1.4) * 540));
      customerRows.push({
        businessId,
        customerNumber: `SYN-${String(i + 1).padStart(6, '0')}`,
        firstName: first,
        lastName: last,
        phone,
        email:
          rand() < 0.72
            ? `${first}.${last}${ri(1, 999)}@${pick(EMAIL_DOMAINS)}`.toLowerCase()
            : null,
        addressesJson: [
          {
            line1: `${ri(100, 9999)} ${pick(STREETS)}`,
            line2: rand() < 0.3 ? `Apt ${ri(1, 40)}` : '',
            city: place.city,
            region: 'CA',
            postalCode: pick(place.zips),
          },
        ],
        referralSource: pick([
          'Google',
          'Walk-in',
          'Referral',
          'Yelp',
          'Repeat',
          'Instagram',
          null,
          null,
        ]),
        createdAt,
        updatedAt: createdAt,
      });
    }
    type Cust = { id: string; addr: Record<string, string>; phone: string };
    const customerIds: Cust[] = [];
    await chunked(customerRows, 500, async (part) => {
      const inserted = await db.insert(customers).values(part).returning({
        id: customers.id,
        addressesJson: customers.addressesJson,
        phone: customers.phone,
      });
      for (const r of inserted) {
        customerIds.push({
          id: r.id,
          addr: (r.addressesJson as Record<string, string>[])[0]!,
          phone: r.phone ?? '',
        });
      }
    });
    log(`Customers: ${customerIds.length}.`);

    // ---- 4. Orders. Drawn newest-heavy over the last year; numbered per
    //         store from 10001 in creation order like the register does.
    const levelRows = await db
      .select({
        variantId: inventoryLevels.variantId,
        locationId: inventoryLevels.locationId,
        onHand: inventoryLevels.onHand,
        reserved: inventoryLevels.reserved,
      })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.businessId, businessId));
    const levelKey = (v: string, l: string) => `${v}:${l}`;
    const available = new Map<string, number>();
    for (const l of levelRows)
      available.set(levelKey(l.variantId, l.locationId), l.onHand - l.reserved);
    const reserveDelta = new Map<string, number>();

    type Draft = { createdAt: Date; store: Store };
    const drafts: Draft[] = [];
    for (let i = 0; i < orderCount; i++) {
      const ageDays = Math.floor(Math.pow(rand(), 1.3) * 365);
      let day = addDays(now, -ageDays);
      // Weekends sell more: nudge ~20% of weekday picks onto the coming Saturday.
      const dow = new Date(day.getTime() - LA_OFFSET_MS).getUTCDay();
      if (dow >= 1 && dow <= 5 && rand() < 0.2) day = addDays(day, 6 - dow);
      if (day > now) day = now;
      drafts.push({ createdAt: atStoreHours(day), store: weighted(storeWeights) });
    }
    drafts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const counters = new Map<string, number>(stores.map((s) => [s.id, 10001]));
    const orderRows: OrderDraft[] = [];
    const taxBps = biz.defaultTaxRateBps || 950;
    const opsSettings = biz.opsSettingsJson as { recyclingFeeCents?: number } | null;
    const recyclingFee = opsSettings?.recyclingFeeCents ?? 1800;
    const todayStr = isoDay(now);

    const stats = {
      completed: 0,
      open: 0,
      quote: 0,
      cancelled: 0,
      deliveries: 0,
      payments: 0,
      lines: 0,
    };
    for (const d of drafts) {
      const store = d.store;
      const seq = counters.get(store.id)!;
      counters.set(store.id, seq + 1);
      const number = store.orderPrefix
        ? `${store.orderPrefix}-${seq}`
        : `SO-${d.createdAt.getUTCFullYear()}-${String(seq).padStart(6, '0')}`;
      const storeSellers = sellers.filter((s) => s.storeId === store.id);
      const seller = rand() < 0.08 || storeSellers.length === 0 ? sellers[0]! : pick(storeSellers);
      // Repeat customers: 30% of orders go to the first 400 customers.
      const cust =
        rand() < 0.3
          ? customerIds[ri(0, Math.min(399, customerIds.length - 1))]!
          : pick(customerIds);
      const fulfillment = rand() < 0.65 ? 'delivery' : 'take_with';
      const stockLoc = fulfillment === 'delivery' ? warehouse : store;
      const ageDays = (now.getTime() - d.createdAt.getTime()) / DAY;

      // Lifecycle.
      let status = 'completed';
      let deliveryOutcome: 'delivered' | 'scheduled' | 'failed' | 'cancelled' | null = null;
      let scheduled: Date | null = null;
      if (fulfillment === 'delivery') {
        scheduled = atStoreHours(addDays(d.createdAt, ri(2, 12)), 9, 16);
        if (isoDay(scheduled) < todayStr) {
          const r = rand();
          deliveryOutcome = r < 0.92 ? 'delivered' : r < 0.96 ? 'failed' : 'cancelled';
        } else {
          deliveryOutcome = 'scheduled';
        }
        status =
          deliveryOutcome === 'delivered'
            ? 'completed'
            : deliveryOutcome === 'cancelled'
              ? 'cancelled'
              : 'open';
      }
      if (ageDays < 60 && rand() < 0.04) {
        status = 'quote';
        deliveryOutcome = null;
      }

      // Lines.
      const lineCount = weighted([
        { v: 1, w: 55 },
        { v: 2, w: 30 },
        { v: 3, w: 12 },
        { v: 4, w: 3 },
      ]);
      const lines: LineInsert[] = [];
      let subtotal = 0;
      let discount = 0;
      let tax = 0;
      const stockLineIdx: number[] = [];
      for (let li = 0; li < lineCount; li++) {
        const v = pick(weighted(pools));
        const qty = rand() < 0.85 ? 1 : 2;
        const gross = qty * v.priceCents;
        const lineDisc = rand() < 0.12 ? Math.round((gross * ri(5, 15)) / 100) : 0;
        const net = gross - lineDisc;
        const lineTax = Math.round((net * taxBps) / 10000);
        subtotal += gross;
        discount += lineDisc;
        tax += lineTax;
        const fulfilled = status === 'completed';
        const key = levelKey(v.id, stockLoc.id);
        let reserved = 0;
        if (status === 'open' && (available.get(key) ?? 0) >= qty) {
          reserved = qty;
          available.set(key, available.get(key)! - qty);
          reserveDelta.set(key, (reserveDelta.get(key) ?? 0) + qty);
        }
        stockLineIdx.push(lines.length);
        lines.push({
          businessId,
          orderId: '',
          variantId: v.id,
          sourceLocationId: stockLoc.id,
          description: v.name,
          quantity: qty,
          qtyReserved: reserved,
          qtyFulfilled: fulfilled ? qty : 0,
          lineType: 'stock',
          unitPriceCents: v.priceCents,
          discountCents: lineDisc,
          taxCents: lineTax,
          totalCents: net,
          taxRateBps: taxBps,
          fulfillmentMethod: fulfillment,
          deliveryDate: scheduled ? isoDay(scheduled) : null,
          createdAt: d.createdAt,
        });
        if (recyclable(v)) {
          const feeGross = qty * recyclingFee;
          subtotal += feeGross;
          lines.push({
            businessId,
            orderId: '',
            variantId: null,
            sourceLocationId: null,
            description: 'Recycling Fee',
            quantity: qty,
            qtyReserved: 0,
            qtyFulfilled: fulfilled ? qty : 0,
            lineType: 'custom',
            unitPriceCents: recyclingFee,
            discountCents: 0,
            taxCents: 0,
            totalCents: feeGross,
            taxRateBps: 0,
            fulfillmentMethod: fulfillment,
            deliveryDate: scheduled ? isoDay(scheduled) : null,
            createdAt: d.createdAt,
            // Resolved to parent_line_id once the parent row has an id.
            comment: `__parent:${lines.length - 1}`,
          });
        }
      }
      const deliveryFee =
        fulfillment === 'delivery'
          ? weighted([
              { v: 0, w: 55 },
              { v: 9900, w: 30 },
              { v: 14900, w: 15 },
            ])
          : 0;
      const total = subtotal - discount + tax + deliveryFee;
      const depositRequired = Math.min(total, Math.ceil(total * 0.25));

      // Tenders.
      const pay: PaymentInsert[] = [];
      const tender = (amount: number, at: Date, kind: string) => {
        if (amount <= 0) return;
        const method = weighted([
          { v: 'card', w: 55 },
          { v: 'cash', w: 20 },
          { v: 'financing', w: 17 },
          { v: 'check', w: 5 },
          { v: 'shop_pay', w: 3 },
        ]);
        pay.push({
          businessId,
          orderId: '',
          kind,
          method,
          amountCents: amount,
          status: 'succeeded',
          cardBrand: method === 'card' ? weighted(CARD_BRANDS) : null,
          financingProvider: method === 'financing' ? weighted(FINANCING) : null,
          financingMonths: method === 'financing' ? pick(FINANCING_MONTHS) : null,
          processor: method === 'card' ? 'manual' : null,
          locationId: store.id,
          takenByMembershipId: seller.membershipId,
          createdAt: at,
        });
      };
      if (status === 'completed' || status === 'cancelled') {
        if (fulfillment === 'take_with') tender(total, d.createdAt, 'deposit');
        else {
          const dep = Math.min(total, Math.round(total * (0.3 + rand() * 0.4)));
          tender(dep, d.createdAt, 'deposit');
          if (status === 'completed') tender(total - dep, scheduled ?? d.createdAt, 'balance');
        }
      } else if (status === 'open') {
        if (rand() < 0.3) tender(total, d.createdAt, 'deposit');
        else
          tender(
            Math.min(total, Math.max(depositRequired, Math.round(total * (0.25 + rand() * 0.3)))),
            d.createdAt,
            'deposit',
          );
      }

      const completedAt =
        status === 'completed' ? (fulfillment === 'delivery' ? scheduled! : d.createdAt) : null;
      const deliv: DeliveryDraft[] = [];
      if (scheduled && deliveryOutcome) {
        deliv.push({
          row: {
            businessId,
            locationId: store.id,
            orderId: '',
            kind: 'delivery',
            scheduledDate: isoDay(scheduled),
            windowStart: pick(['08:00', '10:00', '12:00', '14:00']),
            windowEnd: pick(['12:00', '14:00', '16:00', '18:00']),
            status: deliveryOutcome,
            completedAt: deliveryOutcome === 'delivered' ? scheduled : null,
            createdAt: d.createdAt,
            updatedAt: scheduled,
            notes:
              rand() < 0.15
                ? pick([
                    'Call 30 min before',
                    'Gate code 4471',
                    'Second floor, no elevator',
                    'Leave with doorman',
                  ])
                : null,
          },
          lineIdx: stockLineIdx,
        });
        if (deliveryOutcome === 'failed') {
          const again = atStoreHours(addDays(now, ri(1, 10)), 9, 16);
          deliv.push({
            row: {
              businessId,
              locationId: store.id,
              orderId: '',
              kind: 'delivery',
              scheduledDate: isoDay(again),
              status: 'scheduled',
              createdAt: scheduled,
              updatedAt: scheduled,
              notes: 'Rescheduled after failed attempt',
            },
            lineIdx: stockLineIdx,
          });
        }
      }

      stats.lines += lines.length;
      stats.payments += pay.length;
      stats.deliveries += deliv.length;
      if (status === 'completed') stats.completed++;
      else if (status === 'open') stats.open++;
      else if (status === 'quote') stats.quote++;
      else stats.cancelled++;

      orderRows.push({
        businessId,
        locationId: store.id,
        stockLocationId: stockLoc.id,
        number,
        status,
        customerId: cust.id,
        salespersonMembershipId: seller.membershipId,
        subtotalCents: subtotal,
        discountCents: discount,
        taxCents: tax,
        totalCents: total,
        depositRequiredCents: depositRequired,
        orderKind: 'sales_order',
        fulfillmentType: fulfillment,
        deliveryStatus: fulfillment === 'delivery' ? 'scheduled' : null,
        deliveryFeeCents: deliveryFee,
        addressLine1: cust.addr.line1,
        addressLine2: cust.addr.line2 || null,
        addressCity: cust.addr.city,
        addressRegion: cust.addr.region,
        addressPostalCode: cust.addr.postalCode,
        addressPhone: cust.phone,
        requestedDate: scheduled ? isoDay(scheduled) : null,
        completedAt,
        cancelledAt: status === 'cancelled' ? scheduled : null,
        createdAt: d.createdAt,
        updatedAt: completedAt ?? d.createdAt,
        _lines: lines,
        _pay: pay,
        _deliv: deliv,
      });
    }

    await chunked(orderRows, 250, async (part) => {
      const inserted = await db
        .insert(orders)
        .values(part.map(({ _lines, _pay, _deliv, ...o }) => o))
        .returning({ id: orders.id });
      const lineBatch: LineInsert[] = [];
      const lineOwner: { orderIdx: number; localIdx: number }[] = [];
      part.forEach((o, oi) => {
        const id = inserted[oi]!.id;
        o._lines.forEach((l, li) => {
          lineBatch.push({ ...l, orderId: id });
          lineOwner.push({ orderIdx: oi, localIdx: li });
        });
        o._pay.forEach((p) => (p.orderId = id));
        o._deliv.forEach((dv) => (dv.row.orderId = id));
      });
      const lineIds = await db
        .insert(orderLines)
        .values(
          lineBatch.map((l) => ({
            ...l,
            comment: l.comment?.startsWith('__parent:') ? null : l.comment,
          })),
        )
        .returning({ id: orderLines.id });
      // Fee lines point at their parent product line.
      const idFor = new Map<string, string>();
      lineOwner.forEach((o, i) => idFor.set(`${o.orderIdx}:${o.localIdx}`, lineIds[i]!.id));
      const parentUpdates: { id: string; parent: string }[] = [];
      lineBatch.forEach((l, i) => {
        const m = /^__parent:(\d+)$/.exec(l.comment ?? '');
        if (m) {
          parentUpdates.push({
            id: lineIds[i]!.id,
            parent: idFor.get(`${lineOwner[i]!.orderIdx}:${m[1]}`)!,
          });
        }
      });
      if (parentUpdates.length) {
        await pg`UPDATE order_lines AS l SET parent_line_id = d.parent
          FROM unnest(${parentUpdates.map((p) => p.id)}::uuid[], ${parentUpdates.map((p) => p.parent)}::uuid[]) AS d(id, parent)
          WHERE l.id = d.id`;
      }
      const payBatch = part.flatMap((o) => o._pay);
      if (payBatch.length) await db.insert(payments).values(payBatch);
      const delivBatch = part.flatMap((o, oi) => o._deliv.map((dv) => ({ ...dv, oi })));
      if (delivBatch.length) {
        const dIds = await db
          .insert(deliveries)
          .values(delivBatch.map((dv) => dv.row))
          .returning({ id: deliveries.id });
        const dl: (typeof deliveryLines.$inferInsert)[] = [];
        delivBatch.forEach((dv, di) => {
          for (const li of dv.lineIdx) {
            const line = part[dv.oi]!._lines[li]!;
            dl.push({
              businessId,
              deliveryId: dIds[di]!.id,
              orderLineId: idFor.get(`${dv.oi}:${li}`)!,
              quantity: line.quantity,
            });
          }
        });
        if (dl.length) await db.insert(deliveryLines).values(dl);
      }
    });
    log(
      `Orders: ${orderRows.length} (${stats.completed} completed, ${stats.open} open, ${stats.quote} quotes, ${stats.cancelled} cancelled); ${stats.lines} lines, ${stats.payments} payments, ${stats.deliveries} deliveries.`,
    );

    // Reservations on open orders, and the per-store counters the register continues from.
    if (reserveDelta.size) {
      const keys = [...reserveDelta.keys()];
      await pg`UPDATE inventory_levels AS il SET reserved = il.reserved + d.delta
        FROM unnest(${keys.map((k) => k.split(':')[0]!)}::uuid[], ${keys.map((k) => k.split(':')[1]!)}::uuid[], ${keys.map((k) => reserveDelta.get(k)!)}::int[]) AS d(variant_id, location_id, delta)
        WHERE il.variant_id = d.variant_id AND il.location_id = d.location_id`;
    }
    for (const s of orderRows.length ? stores : []) {
      await db
        .insert(orderSequences)
        .values({ businessId, locationId: s.id, nextValue: counters.get(s.id)! })
        .onConflictDoUpdate({
          target: orderSequences.locationId,
          set: { nextValue: counters.get(s.id)! },
        });
    }

    // ---- 5. Purchase orders: a dozen on order, a few drafts, a few received.
    const vendorRows = await db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(eq(vendors.businessId, businessId));
    const [poCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.businessId, businessId));
    let poSeq = (poCount?.n ?? 0) + 1;
    const poKinds: string[] = [
      ...Array<string>(12).fill('ordered'),
      ...Array<string>(4).fill('draft'),
      ...Array<string>(6).fill('received'),
    ];
    for (const poStatus of poKinds) {
      const vendor = pick(vendorRows);
      const vv = sellable.filter((v) => v.vendorId === vendor.id);
      if (vv.length === 0) continue;
      const received = poStatus === 'received';
      const created = addDays(now, -ri(received ? 20 : 1, received ? 90 : 30));
      const n = ri(Math.min(3, vv.length), Math.min(8, vv.length));
      const chosen = new Set<string>();
      const poLinesRows: (typeof purchaseOrderLines.$inferInsert)[] = [];
      let sub = 0;
      while (chosen.size < n) {
        const v = pick(vv);
        if (chosen.has(v.id)) continue;
        chosen.add(v.id);
        const qty = ri(2, 12);
        const cost = v.costCents ?? Math.round(v.priceCents / 2);
        sub += qty * cost;
        poLinesRows.push({
          businessId,
          purchaseOrderId: '',
          variantId: v.id,
          quantityOrdered: qty,
          quantityReceived: received ? qty : 0,
          quantityAccepted: received ? qty : 0,
          unitCostCents: cost,
          lineTotalCents: qty * cost,
        });
      }
      const [po] = await db
        .insert(purchaseOrders)
        .values({
          businessId,
          vendorId: vendor.id,
          locationId: warehouse.id,
          number: `PO-${now.getUTCFullYear()}-${String(poSeq++).padStart(6, '0')}`,
          status: poStatus,
          subtotalCents: sub,
          placedAt: poStatus === 'draft' ? null : created,
          expectedAt: poStatus === 'draft' ? null : addDays(created, 14),
          closedAt: received ? addDays(created, 12) : null,
          createdByUserId: ownerMembership.userId,
          createdAt: created,
          updatedAt: created,
        })
        .returning({ id: purchaseOrders.id });
      await db
        .insert(purchaseOrderLines)
        .values(poLinesRows.map((l) => ({ ...l, purchaseOrderId: po!.id })));
    }
    log(`Purchase orders: ${poSeq - 1}.`);
    log('Synthetic seed complete.');
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
