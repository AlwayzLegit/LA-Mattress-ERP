'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';

interface SearchResults {
  customers: { id: string; name: string; phone: string | null; email: string | null }[];
  orders: {
    id: string;
    number: string;
    legacyNumber: string | null;
    status: string;
    totalCents: number;
    requestedDate: string | null;
    customerName: string | null;
  }[];
  sales: {
    id: string;
    number: string;
    totalCents: number;
    customerName: string | null;
    imported: boolean;
  }[];
}

interface Hit {
  key: string;
  href: string;
  primary: string;
  secondary: string;
  section: 'Customers' | 'Orders' | 'Receipts';
}

function flatten(r: SearchResults): Hit[] {
  const hits: Hit[] = [];
  for (const c of r.customers) {
    hits.push({
      key: `c-${c.id}`,
      href: `/customers/${c.id}`,
      primary: c.name || c.email || c.phone || 'customer',
      secondary: [c.phone, c.email].filter(Boolean).join(' · '),
      section: 'Customers',
    });
  }
  for (const o of r.orders) {
    hits.push({
      key: `o-${o.id}`,
      href: `/orders/${o.id}`,
      primary: o.number,
      secondary: [o.customerName, o.status, o.legacyNumber ? `was ${o.legacyNumber}` : null]
        .filter(Boolean)
        .join(' · '),
      section: 'Orders',
    });
  }
  for (const s of r.sales) {
    hits.push({
      key: `s-${s.id}`,
      href: `/sales/${s.id}`,
      primary: s.number,
      secondary: [s.customerName, s.imported ? 'imported from STORIS' : 'receipt']
        .filter(Boolean)
        .join(' · '),
      section: 'Receipts',
    });
  }
  return hits;
}

/**
 * The omnibox (handoff G1): from any page, typing a caller's phone
 * number, name, or a document number reaches the record in two
 * interactions. ⌘K / Ctrl-K focuses it; arrows + Enter navigate.
 */
export function GlobalSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close when clicking anywhere else.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      void api<SearchResults>(`/v1/search?q=${encodeURIComponent(query)}`)
        .then((r) => {
          setHits(flatten(r));
          setActive(0);
          setOpen(true);
        })
        .catch(() => setHits(null));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const go = useCallback(
    (hit: Hit) => {
      setOpen(false);
      setQ('');
      setHits(null);
      router.push(hit.href);
    },
    [router],
  );

  const onInputKey = (e: React.KeyboardEvent) => {
    if (!open || !hits || hits.length === 0) {
      if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[active];
      if (hit) go(hit);
    } else if (e.key === 'Escape') {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
    }
  };

  let lastSection: string | null = null;
  return (
    <div ref={boxRef} className="relative min-w-0 max-w-[420px] flex-[1_1_220px]">
      <div className="relative">
        <Search
          size={14}
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          ref={inputRef}
          data-testid="global-search"
          type="search"
          placeholder="Search customer, phone, or order #…  (⌘K)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => hits && setOpen(true)}
          onKeyDown={onInputKey}
          aria-label="Search customers and orders"
          aria-expanded={open && hits != null}
          aria-controls="global-search-results"
          className="w-full rounded-[3px] border border-border bg-surface py-1.5 pl-[30px] pr-2.5 text-[13px] text-text placeholder:text-[var(--faint)] hover:border-border-strong focus:border-accent"
        />
      </div>
      {open && hits && (
        <div
          id="global-search-results"
          data-testid="search-results"
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-[60] max-h-[420px] overflow-y-auto rounded-card border border-border bg-surface p-1 shadow-[var(--shadow-md)]"
        >
          {hits.length === 0 ? (
            <div className="px-3 py-2.5 text-[13px] text-secondary">
              Nothing matches — check the spelling, or try the phone number digits only.
            </div>
          ) : (
            hits.map((hit, i) => {
              const header = hit.section !== lastSection ? hit.section : null;
              lastSection = hit.section;
              return (
                <div key={hit.key}>
                  {header && (
                    <div className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">
                      {header}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-testid={`search-hit-${hit.key}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(hit)}
                    className={`block w-full cursor-pointer rounded-control border-0 px-2.5 py-[7px] text-left text-[13px] text-text ${
                      i === active ? 'bg-brand-soft' : 'bg-transparent'
                    }`}
                  >
                    <strong>{hit.primary}</strong>
                    {hit.secondary && <span className="text-secondary"> — {hit.secondary}</span>}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
