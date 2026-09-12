'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
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
}

interface Hit {
  key: string;
  group: 'Orders' | 'Customers' | 'Go to';
  /** Mono identifier in the first column: order number, phone, chord. */
  id: string;
  title: string;
  sub: string;
  meta: string;
  href: string;
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

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, { onClose, initialFocus: inputRef });

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
          id: c.phone ?? '—',
          title: c.name || c.email || 'customer',
          sub: c.email ?? '',
          meta: 'open',
          href: `/customers/${c.id}`,
        });
      }
    }
    const pages = PAGES.filter((p) => !cq || p.label.toLowerCase().includes(cq)).slice(
      0,
      cq ? 4 : 8,
    );
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
    if (!cq || 'new sale'.includes(cq)) {
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
  }, [q, results]);

  useEffect(() => {
    setActive(0);
  }, [hits.length, q]);

  const go = (h: Hit) => {
    onClose();
    router.push(h.href);
  };

  const groups = (['Orders', 'Customers', 'Go to'] as const)
    .map((g) => ({ label: g, items: hits.filter((h) => h.group === g) }))
    .filter((g) => g.items.length > 0);
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
            placeholder="Search orders, customers, phone numbers, SKUs, or a page name…"
            aria-label="Search orders, customers and pages"
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
                    <span className="palette-main">
                      <span className="palette-title">{h.title}</span>
                      {h.sub && <span className="palette-sub"> · {h.sub}</span>}
                    </span>
                    <span className="palette-meta">{h.meta}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {nothing && (
            <div className="palette-empty">
              No orders or customers match “{q.trim()}”. Try a phone number or an order number.
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd>↑↓</Kbd> move
          </span>
          <span>
            <Kbd keys="enter" /> open
          </span>
          <span>
            <Kbd>g o</Kbd> orders · <Kbd>g d</Kbd> deliveries · <Kbd>g p</Kbd> products
          </span>
          <span className="palette-foot-note">phone digits match customers</span>
        </div>
      </div>
    </div>
  );
}
