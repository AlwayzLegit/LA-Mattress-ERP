'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, formatPhone } from '@jetnine/shared';
import { api } from '@/lib/api';
import { readRecent } from '@/lib/recent-records';
import { Kbd, useFocusTrap } from '@/components/ui';
import { GO_KEYS, HOME, MORE_PAGES, NAV } from './nav';

/**
 * Command palette (canvas 3c): one box for navigation and search. Orders
 * match by number and customer, customers by name and phone digits,
 * pages by name. Results are grouped Orders / Customers / Go to with the
 * top result preselected so Enter is always the fastest path. Traps
 * focus, restores it on close, dims the page.
 */
interface SearchResults {
  customers: { id: string; name: string; phone: string | null; email: string | null }[];
  orders: {
    id: string;
    number: string;
    legacyNumber: string | null;
    status: string;
    totalCents: number;
    customerName: string | null;
  }[];
  sales: { id: string; number: string; totalCents: number; customerName: string | null }[];
  products?: {
    productId: string;
    variantId: string;
    name: string;
    variantName: string | null;
    sku: string | null;
    priceCents: number;
    stock: { locationId: string; locationName: string; warehouse: boolean; available: number }[];
  }[];
  purchaseOrders?: {
    id: string;
    number: string;
    status: string;
    vendorName: string | null;
    totalCents: number;
  }[];
  vendors?: { id: string; name: string; phone: string | null; email: string | null }[];
  returns?: {
    id: string;
    rmaNumber: string;
    status: string;
    orderId: string | null;
    customerName: string | null;
    amountCents: number;
  }[];
  serviceOrders?: {
    id: string;
    number: string;
    status: string;
    itemDescription: string | null;
    customerName: string | null;
  }[];
  deliveries?: {
    id: string;
    scheduledDate: string;
    status: string;
    kind: string;
    orderNumber: string;
    customerName: string | null;
    city: string | null;
  }[];
}

interface RecentRecord {
  kind: string;
  id: string;
  code: string;
  title: string;
  sub: string;
  href: string;
}

const GROUPS = [
  'Recent',
  'Orders',
  'Customers',
  'Products',
  'Purchasing',
  'Returns & service',
  'Deliveries',
  'Go to',
] as const;
type Group = (typeof GROUPS)[number];

interface Hit {
  key: string;
  group: Group;
  /** Mono identifier in the first column: order number, phone, SKU, chord. */
  id: string;
  title: string;
  sub: string;
  meta: string;
  href: string;
}

/** "Main Warehouse 5 · Valley 2" — warehouse first, stores with stock only (owner). */
export function stockLine(
  stock: { locationName: string; available: number }[] | undefined,
): string {
  if (!stock || stock.length === 0) return 'no stock';
  return stock.map((s) => `${s.locationName} ${s.available}`).join(' · ');
}

export const PAGES: { label: string; href: string }[] = [
  HOME,
  ...NAV.flatMap((g) => g.items),
  ...MORE_PAGES,
];

const CHORD_FOR = new Map(Object.entries(GO_KEYS).map(([k, v]) => [v.href, `g ${k}`]));

function humanStatus(s: string): string {
  return s.replace(/_/g, ' ');
}

export function CommandPalette({
  onClose,
  userId,
}: {
  onClose: () => void;
  /** Whose recently opened records to show before anything is typed. */
  userId?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [recent, setRecent] = useState<RecentRecord[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, { onClose, initialFocus: inputRef });

  useEffect(() => {
    const refs = readRecent(userId);
    if (refs.length === 0) return;
    void api<RecentRecord[]>(`/v1/search/recent?refs=${encodeURIComponent(refs.join(','))}`)
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [userId]);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }
    const handle = window.setTimeout(() => {
      void api<SearchResults>(`/v1/search?q=${encodeURIComponent(query)}`)
        .then(setResults)
        .catch(() => setResults(null));
    }, 180);
    return () => window.clearTimeout(handle);
  }, [q]);

  const hits = useMemo<Hit[]>(() => {
    const cq = q.trim().toLowerCase();
    const out: Hit[] = [];
    if (!cq) {
      for (const r of recent) {
        out.push({
          key: `r-${r.kind}-${r.id}`,
          group: 'Recent',
          id: r.kind === 'customer' && r.code ? formatPhone(r.code) : r.code,
          title: r.title,
          sub: r.sub,
          meta: r.kind === 'po' ? 'PO' : r.kind,
          href: r.href,
        });
      }
    }
    if (results) {
      for (const o of results.orders.slice(0, 5)) {
        out.push({
          key: `o-${o.id}`,
          group: 'Orders',
          id: o.number,
          title: o.customerName ?? '—',
          sub: [humanStatus(o.status), o.legacyNumber ? `was ${o.legacyNumber}` : null]
            .filter(Boolean)
            .join(' · '),
          meta: formatMoney(o.totalCents),
          href: `/orders/${o.id}`,
        });
      }
      for (const s of results.sales.slice(0, 3)) {
        out.push({
          key: `s-${s.id}`,
          group: 'Orders',
          id: s.number,
          title: s.customerName ?? '—',
          sub: 'receipt',
          meta: formatMoney(s.totalCents),
          href: `/sales/${s.id}`,
        });
      }
      for (const c of results.customers.slice(0, 5)) {
        out.push({
          key: `c-${c.id}`,
          group: 'Customers',
          id: c.phone ? formatPhone(c.phone) : '—',
          title: c.name || c.email || 'customer',
          sub: c.email ?? '',
          meta: 'open',
          href: `/customers/${c.id}`,
        });
      }
      for (const p of results.products ?? []) {
        out.push({
          key: `pr-${p.variantId}`,
          group: 'Products',
          id: p.sku ?? '—',
          title: [p.name, p.variantName].filter(Boolean).join(' — '),
          sub: stockLine(p.stock),
          meta: formatMoney(p.priceCents),
          href: `/products/${p.productId}`,
        });
      }
      for (const po of (results.purchaseOrders ?? []).slice(0, 3)) {
        out.push({
          key: `po-${po.id}`,
          group: 'Purchasing',
          id: po.number,
          title: po.vendorName ?? 'purchase order',
          sub: humanStatus(po.status),
          meta: formatMoney(po.totalCents),
          href: `/purchase-orders/${po.id}`,
        });
      }
      for (const v of (results.vendors ?? []).slice(0, 3)) {
        out.push({
          key: `v-${v.id}`,
          group: 'Purchasing',
          id: v.phone ? formatPhone(v.phone) : '—',
          title: v.name,
          sub: v.email ?? 'vendor',
          meta: 'vendor',
          href: `/vendors/${v.id}`,
        });
      }
      for (const r of (results.returns ?? []).slice(0, 3)) {
        out.push({
          key: `rt-${r.id}`,
          group: 'Returns & service',
          id: r.rmaNumber,
          title: r.customerName ?? '—',
          sub: `return · ${humanStatus(r.status)}`,
          meta: formatMoney(r.amountCents),
          href: r.orderId ? `/orders/${r.orderId}/full#returns` : '/returns',
        });
      }
      for (const t of (results.serviceOrders ?? []).slice(0, 3)) {
        out.push({
          key: `sv-${t.id}`,
          group: 'Returns & service',
          id: t.number,
          title: t.customerName ?? '—',
          sub: ['service', humanStatus(t.status), t.itemDescription].filter(Boolean).join(' · '),
          meta: 'open',
          href: `/service/${t.id}`,
        });
      }
      for (const d of (results.deliveries ?? []).slice(0, 3)) {
        out.push({
          key: `d-${d.id}`,
          group: 'Deliveries',
          id: d.orderNumber,
          title: d.customerName ?? '—',
          sub: [d.kind === 'return_pickup' ? 'pickup' : 'delivery', humanStatus(d.status), d.city]
            .filter(Boolean)
            .join(' · '),
          meta: d.scheduledDate,
          href: `/deliveries/${d.id}`,
        });
      }
    }
    // Before anything is typed the window opens on recent records; the
    // page list fills in only when there are none yet.
    const pages =
      cq || recent.length === 0
        ? PAGES.filter((p) => !cq || p.label.toLowerCase().includes(cq)).slice(0, cq ? 4 : 8)
        : [];
    for (const p of pages) {
      out.push({
        key: `p-${p.href}`,
        group: 'Go to',
        id: CHORD_FOR.get(p.href) ?? '',
        title: p.label,
        sub: '',
        meta: '',
        href: p.href,
      });
    }
    if (cq ? 'new sale'.includes(cq) : recent.length === 0) {
      out.push({
        key: 'a-pos',
        group: 'Go to',
        id: 'n',
        title: 'New sale',
        sub: 'open the register',
        meta: '',
        href: '/pos',
      });
    }
    return out;
  }, [q, results, recent]);

  useEffect(() => {
    setActive(0);
  }, [hits.length, q]);

  const go = (h: Hit) => {
    onClose();
    router.push(h.href);
  };

  const groups = GROUPS.map((g) => ({ label: g, items: hits.filter((h) => h.group === g) })).filter(
    (g) => g.items.length > 0,
  );
  const nothing = q.trim().length >= 2 && results && hits.every((h) => h.group === 'Go to');

  return (
    <div className="overlay palette-overlay" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Search and go to"
        data-testid="command-palette"
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input-row">
          <span aria-hidden className="palette-glyph">
            ⌕
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(hits.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                const h = hits[active];
                if (h) go(h);
              }
            }}
            placeholder="Name, phone, address, invoice, SKU, PO, RMA… or a page name"
            aria-label="Search everything"
            aria-activedescendant={hits[active] ? `palette-${hits[active].key}` : undefined}
            aria-controls="palette-results"
            role="combobox"
            aria-expanded
            autoComplete="off"
            className="palette-input"
          />
          <Kbd keys="esc" />
        </div>
        <div id="palette-results" role="listbox" className="palette-results">
          {groups.map((g) => (
            <div key={g.label} className="palette-group">
              <div className="palette-group-label">{g.label}</div>
              {g.items.map((h) => {
                const i = hits.indexOf(h);
                return (
                  <div
                    key={h.key}
                    id={`palette-${h.key}`}
                    role="option"
                    aria-selected={i === active}
                    className={`palette-row${i === active ? ' is-active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(h)}
                  >
                    <span className="palette-id">{h.id}</span>
                    {h.group === 'Products' ? (
                      // Stock by store gets its own line so no store is cut off.
                      <span className="palette-main palette-main-wrap">
                        <span className="palette-title">{h.title}</span>
                        <span className="palette-stock" data-testid="palette-stock">
                          {h.sub}
                        </span>
                      </span>
                    ) : (
                      <span className="palette-main">
                        <span className="palette-title">{h.title}</span>
                        {h.sub && <span className="palette-sub"> · {h.sub}</span>}
                      </span>
                    )}
                    <span className="palette-meta">{h.meta}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {nothing && (
            <div className="palette-empty">
              Nothing matches “{q.trim()}”. Try fewer letters — part of a name, the last 4 of a
              phone, a zip, or part of an invoice number.
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd keys="up" />
            <Kbd keys="down" /> move
          </span>
          <span>
            <Kbd keys="enter" /> open
          </span>
          <span>
            {(['o', 'd', 'p'] as const).map((k, i) => (
              <span key={k}>
                {i > 0 && ' · '}
                <Kbd keys={`g ${k}`} /> {GO_KEYS[k]!.label.toLowerCase()}
              </span>
            ))}
          </span>
          <span className="palette-foot-note">every word must match · phone digits work</span>
        </div>
      </div>
    </div>
  );
}
