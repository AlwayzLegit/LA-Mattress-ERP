/**
 * Fixtures behind a fetch stub for the Products previews (redesign
 * Phase 7): browser, product page, adjust and receive on the prototype's
 * data, for checking the screens without a session.
 */

export const LOCS = [
  { id: 'wh', name: 'Warehouse', locationType: 'warehouse', isActive: true },
  { id: 'gl', name: 'Glendale', locationType: 'store', isActive: true },
  { id: 'kt', name: 'Koreatown', locationType: 'store', isActive: true },
  { id: 'lb', name: 'La Brea', locationType: 'store', isActive: true },
  { id: 'sc', name: 'Studio City', locationType: 'store', isActive: true },
  { id: 'wl', name: 'West LA', locationType: 'store', isActive: true },
];
const CATS = [
  { id: 'c-matt', parentId: null, name: 'Mattresses', position: 0 },
  { id: 'c-hyb', parentId: 'c-matt', name: 'Hybrid', position: 0 },
  { id: 'c-mf', parentId: 'c-matt', name: 'Memory foam', position: 1 },
  { id: 'c-inn', parentId: 'c-matt', name: 'Innerspring', position: 2 },
  { id: 'c-base', parentId: null, name: 'Bases', position: 1 },
  { id: 'c-acc', parentId: null, name: 'Accessories', position: 2 },
];
interface Fx {
  id: string;
  sku: string;
  name: string;
  cat: string;
  catPath: string;
  vendor: string;
  model: string;
  brand: string;
  size: string | null;
  firm: string | null;
  price: number;
  cost: number;
  group: string;
  status: string;
  active: boolean;
  avail: Record<string, number>;
  reserved: Record<string, number>;
  min: Record<string, number>;
  demand: Record<string, number>;
  po: number;
  asIs: number;
  collection: string;
}
const cells = (a: number[]) => Object.fromEntries(LOCS.map((l, i) => [l.id, a[i] ?? 0]));
export const PRODUCTS: Fx[] = [
  {
    id: 'p1',
    sku: 'CCM-Q',
    name: 'Cloud Comfort Mattress — Queen',
    cat: 'c-hyb',
    catPath: 'Mattresses › Hybrid',
    vendor: 'Cloud Comfort',
    model: 'CC-1200-Q',
    brand: 'Cloud Comfort',
    size: 'Queen',
    firm: 'Medium',
    price: 129900,
    cost: 61000,
    group: 'QUEEN',
    status: 'active',
    active: true,
    avail: cells([6, 1, 0, 2, 0, 1]),
    reserved: cells([2, 1, 1, 0, 0, 0]),
    min: cells([0, 2, 1, 1, 1, 1]),
    demand: cells([0, 0, 2, 0, 0, 0]),
    po: 12,
    asIs: 1,
    collection: 'Cloud',
  },
  {
    id: 'p2',
    sku: 'SLY-PP-Q',
    name: 'Sealy Posturepedic Plus — Queen',
    cat: 'c-inn',
    catPath: 'Mattresses › Innerspring',
    vendor: 'Tempur Sealy',
    model: 'SLY-PP-Q',
    brand: 'Sealy',
    size: 'Queen',
    firm: 'Firm',
    price: 89900,
    cost: 41000,
    group: 'QUEEN',
    status: 'active',
    active: true,
    avail: cells([11, 2, 3, 1, 0, 1]),
    reserved: cells([0, 0, 0, 0, 1, 0]),
    min: cells([0, 2, 2, 1, 1, 1]),
    demand: cells([0, 0, 0, 0, 1, 0]),
    po: 18,
    asIs: 0,
    collection: 'Posturepedic',
  },
  {
    id: 'p3',
    sku: 'TP-PA-Q',
    name: 'Tempur-Pedic ProAdapt — Queen',
    cat: 'c-mf',
    catPath: 'Mattresses › Memory foam',
    vendor: 'Tempur Sealy',
    model: 'TP-PA-Q',
    brand: 'Tempur-Pedic',
    size: 'Queen',
    firm: 'Medium firm',
    price: 269900,
    cost: 132000,
    group: 'QUEEN',
    status: 'active',
    active: true,
    avail: cells([5, 1, 1, 0, 1, 0]),
    reserved: cells([1, 0, 0, 0, 0, 0]),
    min: cells([0, 1, 1, 1, 1, 1]),
    demand: cells([0, 0, 0, 0, 0, 0]),
    po: 12,
    asIs: 0,
    collection: 'ProAdapt',
  },
  {
    id: 'p4',
    sku: 'PUR-H3-K',
    name: 'Purple Hybrid 3 — King',
    cat: 'c-hyb',
    catPath: 'Mattresses › Hybrid',
    vendor: 'Purple',
    model: 'PH3-K',
    brand: 'Purple',
    size: 'King',
    firm: 'Plush',
    price: 269900,
    cost: 141000,
    group: 'KING',
    status: 'special_order',
    active: true,
    avail: cells([0, 0, 0, 0, 0, 0]),
    reserved: cells([0, 0, 0, 0, 0, 0]),
    min: cells([0, 0, 0, 0, 0, 0]),
    demand: cells([1, 0, 0, 0, 0, 0]),
    po: 4,
    asIs: 0,
    collection: 'Hybrid',
  },
  {
    id: 'p5',
    sku: 'ADJ-B-Q',
    name: 'Adjustable base — Queen',
    cat: 'c-base',
    catPath: 'Bases',
    vendor: 'Leggett & Platt',
    model: 'S-Cape-Q',
    brand: 'Leggett & Platt',
    size: 'Queen',
    firm: null,
    price: 69900,
    cost: 32000,
    group: 'QUEEN',
    status: 'active',
    active: true,
    avail: cells([8, 1, 2, 1, 0, 1]),
    reserved: cells([0, 0, 0, 0, 0, 0]),
    min: cells([0, 1, 1, 1, 1, 1]),
    demand: cells([0, 0, 0, 0, 0, 0]),
    po: 0,
    asIs: 2,
    collection: 'S-Cape',
  },
  {
    id: 'p6',
    sku: 'PRO-Q',
    name: 'Mattress protector — Queen',
    cat: 'c-acc',
    catPath: 'Accessories',
    vendor: 'Malouf',
    model: 'PR-Q',
    brand: 'Malouf',
    size: 'Queen',
    firm: null,
    price: 6900,
    cost: 2100,
    group: 'QUEEN',
    status: 'active',
    active: true,
    avail: cells([40, 8, 6, 5, 7, 6]),
    reserved: cells([0, 0, 0, 0, 0, 0]),
    min: cells([0, 4, 4, 4, 4, 4]),
    demand: cells([0, 0, 0, 0, 0, 0]),
    po: 0,
    asIs: 0,
    collection: 'Sleep Tite',
  },
  {
    id: 'p7',
    sku: 'BRK-SIG-Q',
    name: 'Brooklyn Signature — Queen',
    cat: 'c-hyb',
    catPath: 'Mattresses › Hybrid',
    vendor: 'Brooklyn Bedding',
    model: 'BB-SIG-Q',
    brand: 'Brooklyn Bedding',
    size: 'Queen',
    firm: 'Medium',
    price: 119900,
    cost: 52000,
    group: 'QUEEN',
    status: 'discontinued',
    active: false,
    avail: cells([0, 0, 0, 0, 0, 0]),
    reserved: cells([0, 0, 0, 0, 0, 0]),
    min: cells([0, 0, 0, 0, 0, 0]),
    demand: cells([0, 0, 0, 0, 0, 0]),
    po: 0,
    asIs: 0,
    collection: 'Signature',
  },
];

function sum(m: Record<string, number>) {
  return Object.values(m).reduce((a, b) => a + b, 0);
}
function listRow(f: Fx) {
  return {
    id: f.id,
    sku: f.sku,
    name: f.name,
    isActive: f.active,
    purchaseStatus: f.status,
    brandName: f.brand,
    categoryName: f.catPath.split(' › ').pop(),
    categoryPath: f.catPath,
    collectionName: f.collection,
    vendorName: f.vendor,
    vendorModel: f.model,
    group: f.group,
    size: f.size,
    firmness: f.firm,
    priceCents: f.price,
    costCents: f.cost,
    onHand: sum(f.avail) + sum(f.reserved),
    reserved: sum(f.reserved),
    available: sum(f.avail),
    netOnPo: f.po,
    asIsOnHand: f.asIs,
    asIsAvailable: f.asIs,
    asIsNonSellable: 0,
    stockByLocation: Object.fromEntries(
      LOCS.map((l) => [
        l.id,
        {
          onHand: (f.avail[l.id] ?? 0) + (f.reserved[l.id] ?? 0),
          reserved: f.reserved[l.id] ?? 0,
          floorSample: 0,
          available: f.avail[l.id] ?? 0,
          min: f.min[l.id] || null,
          demand: f.demand[l.id] ?? 0,
        },
      ]),
    ),
  };
}
const EMPTY = {
  onHand: 0,
  reserved: 0,
  floorSample: 0,
  available: 0,
  netOnPo: 0,
  totalPo: 0,
  asIsOnHand: 0,
  asIsAvailable: 0,
  asIsNonSellable: 0,
  layawayReserved: 0,
  onOrderReserved: 0,
};
function detail(f: Fx) {
  const byLocation = LOCS.map((l) => ({
    ...EMPTY,
    variantId: `${f.id}-v`,
    variantSku: f.sku,
    variantActive: true,
    locationId: l.id,
    locationName: l.name,
    locationActive: true,
    storageBinId: null,
    storageBinCode: l.id === 'wh' ? 'A-12' : null,
    reorderPoint: f.min[l.id] || null,
    onHand: (f.avail[l.id] ?? 0) + (f.reserved[l.id] ?? 0),
    reserved: f.reserved[l.id] ?? 0,
    available: f.avail[l.id] ?? 0,
    netOnPo: l.id === 'wh' ? f.po : 0,
    totalPo: l.id === 'wh' ? f.po : 0,
    asIsOnHand: l.id === 'wh' ? f.asIs : 0,
    asIsAvailable: l.id === 'wh' ? f.asIs : 0,
  }));
  const totals = byLocation.reduce(
    (t, r) => ({
      ...t,
      onHand: t.onHand + r.onHand,
      reserved: t.reserved + r.reserved,
      available: t.available + r.available,
      netOnPo: t.netOnPo + r.netOnPo,
      totalPo: t.totalPo + r.totalPo,
      asIsOnHand: t.asIsOnHand + r.asIsOnHand,
      asIsAvailable: t.asIsAvailable + r.asIsAvailable,
    }),
    { ...EMPTY },
  );
  return {
    id: f.id,
    sku: f.sku,
    name: f.name,
    description: null,
    categoryId: f.cat,
    taxClassId: null,
    brandId: 'b1',
    collectionId: 'col1',
    isActive: f.active,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    serialTracked: false,
    secondDescription: null,
    purchaseStatus: f.status,
    boxesPerProduct: 1,
    logisticalCartonQty: null,
    purchaseCartonQty: null,
    logisticalCartonTransfers: false,
    suggestedRetailCents: f.price,
    shipping: {
      weightLb: null,
      heightIn: null,
      widthIn: null,
      depthIn: null,
      shippingVolume: null,
      deliveryVolume: null,
    },
    brandName: f.brand,
    categoryName: f.catPath.split(' › ').pop(),
    categoryPath: f.catPath,
    collectionName: f.collection,
    vendorName: f.vendor,
    vendorModel: f.model,
    group: f.group,
    size: f.size,
    firmness: f.firm,
    variants: [
      {
        id: `${f.id}-v`,
        sku: f.sku,
        name: f.size,
        barcode: '0123456789012',
        priceCents: f.price,
        costCents: f.cost,
        attributesJson: { group: f.group },
        size: f.size,
        firmness: f.firm,
        isActive: true,
        reorderPoint: null,
        reorderQty: null,
        preferredVendorId: null,
        vendorSku: f.model,
      },
    ],
    images: [],
    stock: { totals, byLocation },
  };
}
const PO_ROWS = (f: Fx) =>
  f.po > 0
    ? [
        {
          purchaseOrderId: 'po1',
          number: 'PO-4471',
          vendorId: 'v1',
          vendorName: f.vendor,
          receivingLocationId: 'wh',
          receivingLocationName: 'Warehouse',
          sku: f.sku,
          quantityOrdered: f.po,
          quantityDue: f.po,
          placedAt: '2026-09-01',
          expectedAt: '2026-09-15',
          createdAt: '2026-09-01',
          status: 'ordered',
          transactionType: 'merchandise',
          purchaseOrderType: 'standard',
          atDock: false,
          quantityAtDock: 0,
        },
      ]
    : [];
const OPEN_ORDERS = (f: Fx) =>
  Array.from({ length: sum(f.reserved) + sum(f.demand) }, (_, i) => ({
    orderId: `o${i}`,
    orderNumber: `SO-1044${i}`,
    orderType: 'sales_order',
    sellingLocationId: 'gl',
    sellingLocationName: 'Glendale',
    fulfillmentDate: '2026-09-14',
    orderQuantity: 1,
    reservedQuantity: i < sum(f.reserved) ? 1 : 0,
    fulfillmentType: 'delivery',
    fulfillmentStatus: null,
    shipFromLocationId: 'wh',
    shipFromLocationName: 'Warehouse',
    orderDate: '2026-09-09',
    customerId: 'c1',
    customerName: 'Elena Marquez',
    lineId: `l${i}`,
    lineDescription: f.name,
    lineType: 'stock',
    linkedTransferId: null,
    linkedTransferNumber: null,
    linkedTransferQuantity: 0,
    linkedPurchaseOrderId: null,
    linkedPurchaseOrderNumber: null,
    linkedPurchaseOrderQuantity: 0,
  }));
const STRIP = {
  onHand: 0,
  reserved: 0,
  available: 0,
  netOnPo: 0,
  totalPo: 0,
  asIsOnHand: 0,
  asIsAvailable: 0,
  asIsNonSellable: 0,
  floorSample: 0,
  layawayReserved: 0,
  onOrderReserved: 0,
};

const POS = [
  {
    id: 'po1',
    number: 'PO-4471',
    status: 'ordered',
    vendorId: 'v1',
    vendorName: 'Tempur Sealy',
    locationId: 'wh',
    expectedAt: new Date().toISOString().slice(0, 10),
    placedAt: '2026-09-01',
    closedAt: null,
    subtotalCents: 0,
    freightCents: null,
    createdAt: '2026-09-01',
    directShip: false,
    printCount: 1,
    deletedAt: null,
    deletedByEmail: null,
    blindReceiving: false,
    locationName: 'Warehouse',
    notes: null,
    lines: [
      {
        id: 'pl1',
        variantId: 'p3-v',
        productName: 'Tempur-Pedic ProAdapt',
        variantName: 'Queen',
        sku: 'TP-PA-Q',
        vendorSku: null,
        quantityOrdered: 12,
        quantityReceived: 0,
        quantityInspected: 0,
        quantityAccepted: 0,
        quantityRejected: 0,
        unitCostCents: 132000,
        lineTotalCents: 0,
        linkedOrders: [{ orderId: 'o1', orderNumber: 'SO-10436', quantity: 1 }],
      },
      {
        id: 'pl2',
        variantId: 'p2-v',
        productName: 'Sealy Posturepedic Plus',
        variantName: 'Queen',
        sku: 'SLY-PP-Q',
        vendorSku: null,
        quantityOrdered: 24,
        quantityReceived: 0,
        quantityInspected: 0,
        quantityAccepted: 0,
        quantityRejected: 0,
        unitCostCents: 41000,
        lineTotalCents: 0,
        linkedOrders: [
          { orderId: 'o2', orderNumber: 'SO-10440', quantity: 1 },
          { orderId: 'o3', orderNumber: 'SO-10425', quantity: 2 },
        ],
      },
      {
        id: 'pl3',
        variantId: 'p1-v',
        productName: 'Cloud Comfort Mattress',
        variantName: 'Queen',
        sku: 'CCM-Q',
        vendorSku: null,
        quantityOrdered: 12,
        quantityReceived: 0,
        quantityInspected: 0,
        quantityAccepted: 0,
        quantityRejected: 0,
        unitCostCents: 61000,
        lineTotalCents: 0,
        linkedOrders: [],
      },
    ],
  },
  {
    id: 'po2',
    number: 'PO-4468',
    status: 'partially_received',
    vendorId: 'v2',
    vendorName: 'Purple',
    locationId: 'wh',
    expectedAt: '2026-09-20',
    placedAt: '2026-08-28',
    closedAt: null,
    subtotalCents: 0,
    freightCents: null,
    createdAt: '2026-08-28',
    directShip: false,
    printCount: 1,
    deletedAt: null,
    deletedByEmail: null,
    blindReceiving: false,
    locationName: 'Warehouse',
    notes: null,
    lines: [
      {
        id: 'pl4',
        variantId: 'p4-v',
        productName: 'Purple Hybrid 3',
        variantName: 'King',
        sku: 'PUR-H3-K',
        vendorSku: null,
        quantityOrdered: 38,
        quantityReceived: 20,
        quantityInspected: 20,
        quantityAccepted: 20,
        quantityRejected: 0,
        unitCostCents: 141000,
        lineTotalCents: 0,
        linkedOrders: [{ orderId: 'o4', orderNumber: 'SO-10441', quantity: 1 }],
      },
    ],
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function installProductsStub() {
  const w = window as unknown as { __prodStub?: boolean };
  if (w.__prodStub) return;
  w.__prodStub = true;
  const real = window.fetch.bind(window);
  const local = new Map(PRODUCTS.map((f) => [f.id, { ...f, avail: { ...f.avail } }]));
  const pos = new Map(
    POS.map((p) => [p.id, JSON.parse(JSON.stringify(p)) as (typeof POS)[number]]),
  );
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
        scopeLocations: LOCS,
        canSeeCost: true,
      });
    if (p === '/v1/business/members/me/acting-store') return json({ ok: true });
    if (p === '/v1/business/locations' || p === '/v1/pos/locations') return json(LOCS);
    if (p === '/v1/categories') return json({ flat: CATS, tree: [] });
    if (p === '/v1/brands')
      return json([
        { id: 'b1', name: 'Sealy' },
        { id: 'b2', name: 'Purple' },
      ]);
    if (p === '/v1/collections') return json([{ id: 'col1', name: 'Posturepedic' }]);
    if (p === '/v1/vendors')
      return json([
        { id: 'v1', name: 'Tempur Sealy' },
        { id: 'v2', name: 'Purple' },
      ]);
    if (p === '/v1/business/tax-classes') return json([]);
    if (p === '/v1/business/settings/pos') return json({ ops: null });
    if (p === '/v1/reason-codes') {
      const cls = q.get('usageClass');
      if (cls === 'inventory_adjustment')
        return json([
          { id: 'r1', code: 'CNT', description: 'Count correction', active: true },
          { id: 'r2', code: 'DMG', description: 'Damaged, to As-Is', active: true },
          { id: 'r3', code: 'FLR', description: 'To floor sample', active: true },
          { id: 'r4', code: 'RTV', description: 'Return to vendor', active: true },
          { id: 'r5', code: 'FND', description: 'Found', active: true },
        ]);
      return json([]);
    }
    if (p === '/v1/products/facets') return json({ groups: [], sizes: [], firmness: [] });
    if (p === '/v1/products') {
      let rows = [...local.values()];
      if (q.get('includeInactive') !== '1') rows = rows.filter((f) => f.active);
      const s = (q.get('q') ?? '').toLowerCase();
      if (s)
        rows = rows.filter((f) =>
          `${f.name} ${f.sku} ${f.model} ${f.vendor}`.toLowerCase().includes(s),
        );
      const cat = q.get('categoryId');
      if (cat)
        rows = rows.filter(
          (f) => f.cat === cat || CATS.find((c) => c.id === f.cat)?.parentId === cat,
        );
      const size = q.get('size');
      if (size) rows = rows.filter((f) => f.size === size);
      const st = q.get('stock');
      if (st === 'anywhere') rows = rows.filter((f) => sum(f.avail) > 0);
      if (st === 'out') rows = rows.filter((f) => sum(f.avail) === 0);
      if (st === 'short')
        rows = rows.filter((f) =>
          LOCS.some(
            (l) =>
              ((f.avail[l.id] ?? 0) === 0 && (f.demand[l.id] ?? 0) > 0) ||
              (f.min[l.id] && (f.avail[l.id] ?? 0) < f.min[l.id]!),
          ),
        );
      const sort = q.get('sort');
      const dir = q.get('dir') === 'desc' ? -1 : 1;
      if (sort) {
        const m = /^available:(.+)$/.exec(sort);
        rows.sort((a, b) => {
          const ka = m
            ? (a.avail[m[1]!] ?? 0)
            : sort === 'priceCents'
              ? a.price
              : sort === 'available'
                ? sum(a.avail)
                : a.name;
          const kb = m
            ? (b.avail[m[1]!] ?? 0)
            : sort === 'priceCents'
              ? b.price
              : sort === 'available'
                ? sum(b.avail)
                : b.name;
          return ka > kb ? dir : ka < kb ? -dir : 0;
        });
      }
      return json({ data: rows.map(listRow), nextCursor: null });
    }
    const pm = p.match(/^\/v1\/products\/([^/]+)(\/activity\/([^/]+))?$/);
    if (pm) {
      const f = local.get(pm[1]!);
      if (!f) return json({ message: 'not found' }, 404);
      const act = pm[3];
      if (!act) return json(detail(f));
      if (act === 'purchase-orders') return json({ strip: STRIP, rows: PO_ROWS(f) });
      if (act === 'open-orders') return json({ strip: STRIP, rows: OPEN_ORDERS(f) });
      if (act === 'transfers')
        return json({
          strip: STRIP,
          rows:
            q.get('direction') === 'in'
              ? [
                  {
                    transferId: 't1',
                    number: 'TR-2210',
                    status: 'in_transit',
                    transferType: 'standard',
                    fromLocationId: 'wh',
                    fromLocationName: 'Warehouse',
                    toLocationId: 'gl',
                    toLocationName: 'Glendale',
                    transferDate: '2026-09-11',
                    quantity: 1,
                    reservedQuantity: 0,
                    orderId: null,
                    orderNumber: null,
                    scheduledFor: null,
                    customerName: null,
                  },
                ]
              : [],
        });
      if (act === 'as-is')
        return json({
          strip: STRIP,
          rows: f.asIs
            ? [
                {
                  id: 'a1',
                  pieceNumber: 'AS-118',
                  sku: f.sku,
                  locationId: 'wh',
                  locationName: 'Warehouse',
                  quantity: 1,
                  receivedAt: '2026-09-03',
                  status: 'pending_review',
                  condition: 'light_wear',
                  sellable: true,
                  reasonCode: { code: 'DMG', description: 'Damaged' },
                  asIsPriceCents: null,
                  storageLocation: null,
                  source: 'defect',
                  notes: null,
                },
              ]
            : [],
        });
      if (act === 'serials') return json({ strip: STRIP, rows: [] });
      if (act === 'atp') {
        const byLocation = LOCS.map((l) => ({
          locationId: l.id,
          locationName: l.name,
          atpQuantity: (f.avail[l.id] ?? 0) + (l.id === 'wh' ? f.po : 0),
          atpDate:
            (f.avail[l.id] ?? 0) > 0
              ? new Date().toISOString().slice(0, 10)
              : l.id === 'wh' && f.po > 0
                ? '2026-09-15'
                : null,
        }));
        return json({
          desiredQuantity: Number(q.get('quantity') ?? 1),
          asOf: new Date().toISOString(),
          total: {
            atpQuantity: sum(f.avail) + f.po,
            atpDate: new Date().toISOString().slice(0, 10),
          },
          byLocation,
        });
      }
      return json({ strip: STRIP, rows: [] });
    }
    if (p === '/v1/inventory/adjust' && method === 'POST') {
      const b = JSON.parse(String(init?.body ?? '{}')) as {
        variantId: string;
        locationId: string;
        delta: number;
      };
      const f = local.get(b.variantId.replace(/-v$/, ''));
      if (f) f.avail[b.locationId] = Math.max(0, (f.avail[b.locationId] ?? 0) + b.delta);
      return json({ onHand: f?.avail[b.locationId] ?? 0, movementId: 'm1' });
    }
    if (p === '/v1/inventory/bins')
      return json(
        q.get('locationId') === 'wh'
          ? [
              { id: 'bin1', code: 'A-12', locationId: 'wh' },
              { id: 'bin2', code: 'B-04', locationId: 'wh' },
            ]
          : [],
      );
    if (p === '/v1/inventory/levels/assign-bin') return json({ ok: true });
    if (p === '/v1/purchase-orders') {
      const st = q.get('status');
      return json({
        data: [...pos.values()].filter((x) => !st || x.status === st),
        nextCursor: null,
      });
    }
    const pom = p.match(/^\/v1\/purchase-orders\/([^/]+)(\/receiving)?$/);
    if (pom) {
      const po = pos.get(pom[1]!);
      if (!po) return json({ message: 'not found' }, 404);
      if (pom[2] && method === 'POST') {
        const b = JSON.parse(String(init?.body ?? '{}')) as {
          lines: { lineId: string; accepted: number; rejected: number }[];
        };
        const unblocked: { orderId: string; number: string; units: number }[] = [];
        for (const l of b.lines) {
          const line = po.lines.find((x) => x.id === l.lineId);
          if (!line) continue;
          line.quantityReceived += l.accepted + l.rejected;
          line.quantityInspected += l.accepted + l.rejected;
          line.quantityAccepted += l.accepted;
          line.quantityRejected += l.rejected;
          if (l.accepted > 0)
            for (const o of line.linkedOrders)
              unblocked.push({ orderId: o.orderId, number: o.orderNumber, units: o.quantity });
        }
        po.status = po.lines.every(
          (x) => x.quantityAccepted + x.quantityRejected >= x.quantityOrdered,
        )
          ? 'received'
          : 'partially_received';
        return json({ ...po, unblockedOrders: unblocked });
      }
      return json(po);
    }
    if (p.startsWith('/v1/')) return json({ message: `stub: ${p}` }, 404);
    return real(input, init);
  };
}
