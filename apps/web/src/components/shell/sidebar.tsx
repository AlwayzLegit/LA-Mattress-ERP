'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useBusinessBranding, useBusinessName } from '@/lib/business-settings';
import { Kbd } from '@/components/ui';
import { HOME, groupForPath, isActiveHref, type NavGroup } from './nav';
import { SyncStatus } from './sync-status';

const OPEN_KEY = 'jetnine.nav.open';

/**
 * Sidebar (canvas 3a/3b): brand block, Dashboard, five collapsible
 * groups with only the current one open, counts in mono at the right,
 * sync status and the shortcuts link at the foot. 220px; 200px at 1280.
 */
export function Sidebar({
  groups,
  counts,
  userKey,
  onNavigate,
  onShortcuts,
}: {
  groups: NavGroup[];
  counts: (href: string) => number | null;
  /** Per-user key for the remembered open group. */
  userKey: string;
  onNavigate?: () => void;
  onShortcuts: () => void;
}) {
  const pathname = usePathname() ?? '';
  const current = groupForPath(groups, pathname);
  const [open, setOpen] = useState<string | null>(null);

  // The group holding the current page opens on every navigation; the
  // user's last manual choice fills in when the page belongs to none.
  useEffect(() => {
    if (current) {
      setOpen(current);
      return;
    }
    try {
      const saved = localStorage.getItem(`${OPEN_KEY}:${userKey}`);
      setOpen(saved && groups.some((g) => g.label === saved) ? saved : (groups[0]?.label ?? null));
    } catch {
      setOpen(groups[0]?.label ?? null);
    }
  }, [current, groups, userKey]);

  const toggle = (label: string) => {
    const next = open === label ? null : label;
    setOpen(next);
    try {
      if (next) localStorage.setItem(`${OPEN_KEY}:${userKey}`, next);
      else localStorage.removeItem(`${OPEN_KEY}:${userKey}`);
    } catch {
      // ignore
    }
  };

  return (
    <>
      <BrandHeader />
      <nav className="nav" aria-label="Main">
        <Link
          href={HOME.href}
          onClick={onNavigate}
          className={`nav-item${isActiveHref(pathname, HOME.href) ? ' is-active' : ''}`}
          aria-current={isActiveHref(pathname, HOME.href) ? 'page' : undefined}
        >
          <span className="nav-dot" aria-hidden />
          <span className="nav-label">{HOME.label}</span>
        </Link>
        {groups.map((g) => {
          const isOpen = open === g.label;
          const id = `nav-group-${g.label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
          return (
            <div key={g.label} className="nav-group">
              <button
                type="button"
                className="nav-group-btn"
                aria-expanded={isOpen}
                aria-controls={id}
                onClick={() => toggle(g.label)}
              >
                <span className="nav-chev" aria-hidden>
                  {isOpen ? '▾' : '▸'}
                </span>
                {g.label}
              </button>
              {isOpen && (
                <div id={id} className="nav-group-items">
                  {g.items.map((item) => {
                    const active = isActiveHref(pathname, item.href);
                    const n = counts(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={onNavigate}
                        className={`nav-item${active ? ' is-active' : ''}`}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span className="nav-dot" aria-hidden />
                        <span className="nav-label">{item.label}</span>
                        {n != null && n > 0 && <span className="nav-count">{n}</span>}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="nav-foot">
        <SyncStatus />
        <button type="button" onClick={onShortcuts} className="nav-item nav-item-btn">
          <span className="nav-dot" aria-hidden />
          <span className="nav-label">Keyboard shortcuts</span>
          <Kbd keys="?" />
        </button>
      </div>
    </>
  );
}

/**
 * Brand block. White-label aware: a business with branding shows its own
 * logo/name; otherwise the platform default. The build identifier keeps
 * findings pinnable to a deploy.
 */
function BrandHeader() {
  const branding = useBusinessBranding();
  const name = useBusinessName() ?? 'LA Mattress';
  const monogram = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const build = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';
  return (
    <Link href="/dashboard" className="brand">
      {branding?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tenant-supplied remote URL; next/image needs domain allow-listing per tenant
        <img src={branding.logoUrl} alt="" className="brand-mark" />
      ) : (
        <span aria-hidden className="brand-mark brand-mark-mono">
          {monogram || 'ERP'}
        </span>
      )}
      <span className="brand-text">
        <span className="brand-name">{name}</span>
        <span className="brand-build">build {build}</span>
      </span>
    </Link>
  );
}
