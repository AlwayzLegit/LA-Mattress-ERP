'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { formatMoney } from '@jetnine/shared';

/**
 * ⌘K palette (redesign 2026-09-04): orders, customers and receipts from
 * /v1/search, plus page jumps and the New sale action. Arrow keys move,
 * Enter opens, Esc closes.
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
  kind: 'Order' | 'Customer' | 'Receipt' | 'Page' | 'Action';
  title: string;
  sub: string;
  meta: string;
  href: string;
}

export const PAGES: { label: string; href: string }[] = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Orders', href: '/orders' },
  { label: 'Team Tasks', href: '/tasks' },
  { label: 'Deliveries', href: '/deliveries' },
  { label: 'Dispatch', href: '/deliveries/dispatch' },
  { label: 'At risk', href: '/jeopardy' },
  { label: 'Stock by location', href: '/products/stock' },
  { label: 'Products', href: '/products' },
  { label: 'Customers', href: '/customers' },
  { label: 'Salespeople', href: '/salespeople' },
  { label: 'Reports', href: '/reports' },
  { label: 'Exceptions', href: '/exceptions' },
  { label: 'Purchasing', href: '/purchase-orders' },
  { label: 'Transfers', href: '/transfers' },
  { label: 'Returns', href: '/returns' },
  { label: 'Shifts', href: '/shifts' },
  { label: 'Members', href: '/members' },
  { label: 'Settings', href: '/settings' },
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
          kind: 'Order',
          title: o.number,
          sub: [o.customerName, o.status, o.legacyNumber ? `was ${o.legacyNumber}` : null]
            .filter(Boolean)
            .join(' · '),
          meta: formatMoney(o.totalCents),
          href: `/orders/${o.id}`,
        });
      }
      for (const c of results.customers.slice(0, 5)) {
        out.push({
          key: `c-${c.id}`,
          kind: 'Customer',
          title: c.name || c.email || c.phone || 'customer',
          sub: [c.phone, c.email].filter(Boolean).join(' · '),
          meta: '',
          href: `/customers/${c.id}`,
        });
      }
      for (const s of results.sales.slice(0, 4)) {
        out.push({
          key: `s-${s.id}`,
          kind: 'Receipt',
          title: s.number,
          sub: s.customerName ?? '',
          meta: formatMoney(s.totalCents),
          href: `/sales/${s.id}`,
        });
      }
    }
    const pages = PAGES.filter((p) => !cq || p.label.toLowerCase().includes(cq)).slice(
      0,
      cq ? 3 : 6,
    );
    for (const p of pages) {
      out.push({
        key: `p-${p.href}`,
        kind: 'Page',
        title: p.label,
        sub: '',
        meta: '↵',
        href: p.href,
      });
    }
    if (!cq || 'new sale'.includes(cq)) {
      out.push({
        key: 'a-pos',
        kind: 'Action',
        title: 'New sale',
        sub: 'open the register',
        meta: 'N',
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

  return (
    <div
      className="overlay"
      style={{ zIndex: 60, display: 'flex', justifyContent: 'center', paddingTop: '14vh' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        aria-label="Search"
        data-testid="command-palette"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: 'calc(100% - 32px)',
          maxHeight: '60vh',
          alignSelf: 'flex-start',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideUp .15s ease',
        }}
      >
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
          aria-label="Search"
          style={{
            padding: '14px 16px',
            border: 0,
            borderBottom: '1px solid var(--border)',
            background: 'transparent',
            fontSize: 14,
            outline: 'none',
            width: '100%',
            color: 'var(--text)',
          }}
        />
        <div style={{ overflow: 'auto', padding: 6 }}>
          {hits.map((h, i) => (
            <button
              key={h.key}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h)}
              style={{
                display: 'grid',
                gridTemplateColumns: '64px 1fr auto',
                gap: 12,
                alignItems: 'center',
                width: '100%',
                padding: '8px 10px',
                border: 0,
                borderRadius: 6,
                background: i === active ? 'var(--surface2)' : 'transparent',
                textAlign: 'left',
                fontSize: 13,
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              <span className="eyebrow" style={{ fontSize: 10.5 }}>
                {h.kind}
              </span>
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ fontWeight: 500 }}>{h.title}</span>{' '}
                <span style={{ color: 'var(--muted)' }}>{h.sub}</span>
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                {h.meta}
              </span>
            </button>
          ))}
          {q.trim().length >= 2 &&
            results &&
            hits.every((h) => h.kind === 'Page' || h.kind === 'Action') && (
              <div style={{ padding: '10px 10px', fontSize: 12.5, color: 'var(--muted)' }}>
                No orders, customers or receipts match “{q.trim()}”.
              </div>
            )}
        </div>
        <div
          style={{
            padding: '8px 14px',
            borderTop: '1px solid var(--border)',
            fontSize: 11.5,
            color: 'var(--muted)',
            display: 'flex',
            gap: 14,
            background: 'var(--surface2)',
          }}
        >
          <span>
            <kbd className="key">↵</kbd> open
          </span>
          <span>
            <kbd className="key">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
