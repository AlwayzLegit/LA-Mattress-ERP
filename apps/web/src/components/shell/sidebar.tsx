'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useBusinessBranding, useBusinessName } from '@/lib/business-settings';
import { Kbd } from '@/components/ui';
import { HOME, isActiveHref, type NavGroup } from './nav';
import { SyncStatus } from './sync-status';

/**
 * Sidebar (canvas 3a/3b): brand block, Dashboard, the five groups with
 * every item showing, counts in mono at the right, sync status and the
 * shortcuts link at the foot. 220px; 200px at 1280.
 *
 * Owner 2026-09-12: the groups no longer collapse — every link is on
 * screen all the time (README §2 amendment). The sidebar scrolls when a
 * role's list runs past the viewport.
 */
export function Sidebar({
  groups,
  counts,
  onNavigate,
  onShortcuts,
}: {
  groups: NavGroup[];
  counts: (href: string) => number | null;
  onNavigate?: () => void;
  onShortcuts: () => void;
}) {
  const pathname = usePathname() ?? '';

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
          const id = `nav-group-${g.label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
          return (
            <div key={g.label} className="nav-group" role="group" aria-labelledby={id}>
              <div id={id} className="nav-group-head">
                {g.label}
              </div>
              <div className="nav-group-items">
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
