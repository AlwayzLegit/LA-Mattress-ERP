'use client';

import Link from 'next/link';
import { Building2, Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { readActiveBusinessId } from '@/lib/offline';
import { useBusinessName } from '@/lib/business-settings';
import { LoadingRows } from '@/components/ui';

interface MembershipSummary {
  businessId: string;
  businessName: string;
  roleName: string;
  status: string;
}

/**
 * Shows which business the back office is operating on, right in the
 * header — and for people who belong to several businesses, switches
 * between them in one click instead of a round-trip through /welcome.
 * Memberships load lazily on first open so single-business users never
 * pay for the fetch.
 */
export function ActiveBusinessBadge() {
  const name = useBusinessName();
  const [open, setOpen] = useState(false);
  const [memberships, setMemberships] = useState<MembershipSummary[] | null>(null);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeId = useRef<string | null>(null);
  if (activeId.current === null && typeof document !== 'undefined') {
    activeId.current = readActiveBusinessId();
  }

  useEffect(() => {
    if (!open || memberships != null) return;
    void (async () => {
      try {
        const me = await api<{ memberships: MembershipSummary[] }>('/v1/auth/me');
        setMemberships(me.memberships.filter((m) => m.status === 'active'));
      } catch {
        setMemberships([]);
      }
    })();
  }, [open, memberships]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function switchTo(businessId: string) {
    if (businessId === activeId.current) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      await api('/v1/auth/active-business', {
        method: 'POST',
        body: JSON.stringify({ businessId }),
      });
      // Full reload: every provider, cache, and offline queue partition
      // keys off the active business — a soft navigation would leave
      // stale tenant state mounted.
      window.location.href = '/dashboard';
    } catch {
      setSwitching(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="active-business"
        className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-border bg-[var(--neutral-soft)] px-3 py-[3px] text-[12px] font-semibold text-secondary hover:border-brand hover:text-brand"
      >
        {name ?? 'No business selected'}
        <ChevronDown size={13} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-[240px] rounded-card border border-border bg-surface p-1.5 shadow-[var(--shadow-lg)]"
          data-testid="business-switcher"
        >
          {memberships == null && (
            <div className="px-2 py-1.5">
              <LoadingRows rows={3} height={20} what="Your businesses" />
            </div>
          )}
          {memberships?.length === 0 && (
            <p className="muted m-0 px-2 py-1.5 text-[12px]">No businesses to show.</p>
          )}
          {memberships?.map((m) => (
            <button
              key={m.businessId}
              type="button"
              role="menuitem"
              disabled={switching}
              onClick={() => void switchTo(m.businessId)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-2 py-[7px] text-left text-[13px] text-text hover:bg-brand-soft disabled:cursor-default disabled:opacity-60"
            >
              <span className="flex-1">
                {m.businessName}
                <span className="muted block text-[11px]">{m.roleName}</span>
              </span>
              {m.businessId === activeId.current && (
                <Check size={14} className="text-success" aria-hidden />
              )}
            </button>
          ))}
          {(memberships?.length ?? 0) > 1 && (
            <Link
              href="/agency"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="mt-1 flex items-center gap-2 border-t border-border px-2 py-[7px] text-[12.5px] font-semibold text-brand no-underline"
            >
              <Building2 size={14} aria-hidden /> All businesses overview
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
