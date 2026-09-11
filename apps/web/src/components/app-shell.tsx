'use client';

import Link from 'next/link';
import { DynamicFavicon } from '@/components/dynamic-favicon';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Clock,
  Landmark,
  MonitorSmartphone,
  BadgeDollarSign,
  AlertTriangle,
  ArrowLeftRight,
  BadgePercent,
  ClipboardList,
  CreditCard,
  Factory,
  Gift,
  LayoutDashboard,
  MapPin,
  Megaphone,
  Menu,
  Monitor,
  Package,
  PackageSearch,
  Receipt,
  ScrollText,
  TriangleAlert,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Tags,
  Truck,
  UserCog,
  Users,
  Wrench,
  Recycle,
  Repeat,
  MoonStar,
  type LucideIcon,
  Undo2,
  Warehouse,
  Sunrise,
} from 'lucide-react';
import { ActiveBusinessBadge } from '@/components/active-business-badge';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useBusinessBranding, useBusinessName } from '@/lib/business-settings';
import { useDashboardFilters } from '@/lib/dashboard-filters';
import { useUiPrefs } from '@/lib/ui-prefs';
import { CommandPalette } from '@/components/shell/command-palette';
import { PeriodControls, RoleSwitcher, StoreScope } from '@/components/shell/dashboard-controls';
import { useNotifications } from '@/components/shell/notifications-drawer';
import { PersonalInbox, useTeamInbox } from '@/components/shell/personal-inbox';
import { ShortcutsDialog } from '@/components/shell/shortcuts-dialog';
import { SyncStatus } from '@/components/shell/sync-status';
import { UserMenu } from '@/components/shell/user-menu';

/**
 * The (business) application shell (Claude Design hand-off, 2026-09-04):
 * a 220px paper sidebar with dot-marked nav groups and a sync footer, a
 * 50px topbar with the ⌘K palette, the dashboard's scope / period
 * controls, notifications, New sale and the account menu. Below `md`
 * the sidebar slides over the content behind a hamburger.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Exported for the member editor: the owner picks which of these tabs a member sees. */
export const NAV: NavGroup[] = [
  {
    label: 'Sell',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/pos', label: 'New sale', icon: Monitor },
      { href: '/my-day', label: 'My Day', icon: Sunrise },
      { href: '/tasks', label: 'Team Tasks', icon: ClipboardList },
      { href: '/orders', label: 'Orders', icon: ShoppingCart },
      { href: '/deliveries', label: 'Deliveries', icon: Truck },
      { href: '/jeopardy', label: 'At risk', icon: AlertTriangle },
      { href: '/service', label: 'Service', icon: Wrench },
      { href: '/special-orders', label: 'Special orders', icon: PackageSearch },
      { href: '/sales', label: 'Sales', icon: Receipt },
      { href: '/returns', label: 'Returns', icon: Undo2 },
      { href: '/exchanges', label: 'Exchanges', icon: Repeat },
      { href: '/shifts', label: 'Shifts', icon: CreditCard },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { href: '/products', label: 'Products', icon: Package },
      { href: '/categories', label: 'Categories', icon: Tags },
      { href: '/warehouse', label: 'Warehouse', icon: Warehouse },
      { href: '/purchase-orders', label: 'Purchasing', icon: ClipboardList },
      { href: '/vendors', label: 'Vendors', icon: Factory },
      { href: '/replenishment', label: 'Replenishment', icon: PackageSearch },
      { href: '/transfers', label: 'Transfers', icon: ArrowLeftRight },
      { href: '/as-is', label: 'As-Is review', icon: Recycle },
      { href: '/gift-cards', label: 'Gift cards', icon: Gift },
    ],
  },
  {
    label: 'People',
    items: [
      { href: '/customers', label: 'Customers', icon: Users },
      { href: '/salespeople', label: 'Salespeople', icon: BadgeDollarSign },
      { href: '/marketing', label: 'Marketing', icon: Megaphone },
      { href: '/members', label: 'Members', icon: UserCog },
      { href: '/roles', label: 'Roles', icon: ShieldCheck },
      { href: '/timeclock', label: 'Time clock', icon: Clock },
      { href: '/settings/sessions', label: 'Active sessions', icon: MonitorSmartphone },
    ],
  },
  {
    label: 'Insights',
    items: [
      { href: '/reports', label: 'Reports', icon: BadgePercent },
      { href: '/reports/builder', label: 'Report builder', icon: ScrollText },
      { href: '/gl', label: 'General ledger', icon: Landmark },
      { href: '/commissions', label: 'Commissions', icon: CreditCard },
      { href: '/operations', label: 'Operations', icon: ShieldCheck },
      { href: '/exceptions', label: 'Exceptions', icon: TriangleAlert },
      { href: '/jobs', label: 'Nightly jobs', icon: MoonStar },
      { href: '/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
  {
    label: 'Configure',
    items: [
      { href: '/settings', label: 'Settings', icon: Settings },
      { href: '/locations', label: 'Locations', icon: MapPin },
    ],
  },
];

/** `g` then one of these jumps (the design's G-O / G-D / G-I / G-C / G-R / G-H). */
const GO_KEYS: Record<string, string> = {
  o: '/orders',
  d: '/deliveries',
  i: '/products/stock',
  c: '/customers',
  r: '/reports',
  h: '/dashboard',
};

interface NavCounts {
  openOrders: number;
  atRisk: number;
  exceptions: number;
  deliveriesToday: number;
}

interface Me {
  roleName: string | null;
  hiddenNav: string[];
  sellingScope: 'all' | 'approved';
  scopeLocations: { id: string; name: string }[];
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const session = useSession();
  const filters = useDashboardFilters();
  const prefs = useUiPrefs();
  const isDashboard = pathname === '/dashboard';
  // Owner 2026-09-02: Orders and New Sale get more room so an added
  // product's whole line shows without a sideways scroll.
  const wideContent =
    pathname.startsWith('/orders') ||
    pathname.startsWith('/products') ||
    pathname.startsWith('/pos') ||
    pathname.startsWith('/deliveries') ||
    pathname.startsWith('/reports');
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [counts, setCounts] = useState<NavCounts | null>(null);
  const [cmd, setCmd] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);
  // Selling-restricted members pick THE store they are working at for
  // this login (browser session); New Sale rings at it, so the money
  // tendered counts toward that store's drawer and closeout.
  const [sellingStore, setSellingStore] = useState<{ id: string; name: string } | null>(null);
  const [storeChoices, setStoreChoices] = useState<{ id: string; name: string }[]>([]);
  const [pickStore, setPickStore] = useState(false);
  const gPending = useRef<number | null>(null);

  const inbox = useTeamInbox(session.data?.user.id);
  const notifications = useNotifications(
    !!session.data,
    `${session.data?.user.id ?? ''}:${inbox.data?.businessId ?? ''}`,
  );

  const chooseStore = useCallback((loc: { id: string; name: string }) => {
    try {
      sessionStorage.setItem('jetnine.sellingStore', JSON.stringify(loc));
    } catch {
      // Session storage unavailable — the choice just won't stick.
    }
    setSellingStore(loc);
    setPickStore(false);
  }, []);

  useEffect(() => {
    api<Me>('/v1/business/members/me')
      .then((m) => {
        setMe(m);
        if (m.sellingScope !== 'approved') return;
        const stores = m.scopeLocations ?? [];
        setStoreChoices(stores);
        let saved: { id: string; name: string } | null = null;
        try {
          const raw = sessionStorage.getItem('jetnine.sellingStore');
          if (raw) saved = JSON.parse(raw) as { id: string; name: string };
        } catch {
          saved = null;
        }
        const valid = saved ? stores.find((l) => l.id === saved!.id) : undefined;
        if (valid) setSellingStore(valid);
        else if (stores.length === 1) chooseStore(stores[0]!);
        else if (stores.length > 1) setPickStore(true);
      })
      .catch(() =>
        setMe({ roleName: null, hiddenNav: [], sellingScope: 'all', scopeLocations: [] }),
      );
  }, [chooseStore]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<NavCounts>('/v1/dashboard/nav-counts')
        .then((c) => alive && setCounts(c))
        .catch(() => alive && setCounts(null));
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pathname]);

  const closeAll = useCallback(() => {
    setCmd(false);
    setDrawer(false);
    setHelp(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmd((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        closeAll();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === '?') setHelp((v) => !v);
      else if (k === 'n') router.push('/pos');
      else if (k === 't') prefs.toggleTheme();
      else if (k === 'p' && isDashboard) {
        (
          document.querySelector('[data-testid="trend-range"] button') as HTMLElement | null
        )?.click();
      } else if (k === 'g') {
        if (gPending.current) window.clearTimeout(gPending.current);
        gPending.current = window.setTimeout(() => {
          gPending.current = null;
        }, 800);
      } else if (gPending.current) {
        window.clearTimeout(gPending.current);
        gPending.current = null;
        const dest = GO_KEYS[k];
        if (dest) router.push(dest);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeAll, isDashboard, prefs, router]);

  const hiddenNav = new Set(me?.hiddenNav ?? []);
  const isActive = (href: string) =>
    href === '/dashboard'
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);
  const countFor = (href: string): number | null => {
    if (!counts) return null;
    if (href === '/orders') return counts.openOrders || null;
    if (href === '/jeopardy') return counts.atRisk || null;
    if (href === '/exceptions') return counts.exceptions || null;
    if (href === '/deliveries') return counts.deliveriesToday || null;
    return null;
  };
  const user = session.data?.user;
  const canSwitchRole = me?.roleName === 'Owner';

  return (
    <div className="min-h-screen">
      <DynamicFavicon />
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}

      <aside
        className={`app-sidebar fixed inset-y-0 left-0 z-40 flex w-[var(--sidebar-width)] flex-col overflow-y-auto px-2.5 pb-4 pt-3.5 transition-transform duration-150 ${
          open ? 'translate-x-0' : '-translate-x-full'
        } md:translate-x-0`}
      >
        <BrandHeader />
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 4 }}>
          {NAV.map((group) => {
            const items = group.items.filter((i) => !hiddenNav.has(i.href));
            if (items.length === 0) return null;
            return (
              <div key={group.label}>
                <div className="nav-group-label">{group.label}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {items.map((item) => {
                    const active = isActive(item.href);
                    const n = countFor(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className={`nav-item${active ? ' is-active' : ''}`}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span className="nav-dot" aria-hidden />
                        <span style={{ flex: 1 }}>{item.label}</span>
                        {n != null && <span className="nav-count">{n}</span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
        <div
          style={{
            marginTop: 'auto',
            paddingTop: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <SyncStatus />
          <button
            type="button"
            onClick={() => setHelp(true)}
            className="nav-item"
            style={{
              border: 0,
              background: 'transparent',
              fontSize: 12.5,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            <span className="nav-dot" aria-hidden />
            <span style={{ flex: 1, textAlign: 'left' }}>Keyboard shortcuts</span>
            <kbd className="key">?</kbd>
          </button>
        </div>
      </aside>

      <div className="app-main md:ml-[var(--sidebar-width)]">
        <header className="app-topbar sticky top-0 z-20 flex h-[var(--topbar-height)] items-center gap-2.5 border-b border-border bg-surface px-4 md:px-[22px]">
          <button
            type="button"
            className="btn btn-ghost btn-sm md:hidden"
            aria-label="Toggle navigation"
            onClick={() => setOpen((v) => !v)}
          >
            <Menu size={18} aria-hidden />
          </button>
          <ActiveBusinessBadge />
          {isDashboard && canSwitchRole && <RoleSwitcher />}
          <button
            type="button"
            onClick={() => setCmd(true)}
            data-testid="global-search"
            className="topbar-btn"
            style={{
              flex: '1 1 0',
              minWidth: 0,
              maxWidth: 300,
              marginLeft: 8,
              padding: '6px 10px',
              background: 'var(--surface2)',
              color: 'var(--muted)',
              fontWeight: 400,
              justifyContent: 'flex-start',
              overflow: 'hidden',
            }}
          >
            <span style={{ fontSize: 12 }}>⌕</span>
            <span
              style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}
            >
              Search orders, customers, SKUs…
            </span>
            <kbd className="key hidden sm:inline">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-2" style={{ flexShrink: 0 }}>
            {isDashboard && (
              <>
                <StoreScope />
                <PeriodControls />
              </>
            )}
            {sellingStore && !isDashboard && (
              <button
                type="button"
                className="topbar-btn"
                title={
                  storeChoices.length > 1
                    ? 'Change the store you are selling at'
                    : 'The store you are selling at'
                }
                onClick={() => storeChoices.length > 1 && setPickStore(true)}
                data-testid="selling-store-chip"
              >
                <span style={{ color: 'var(--muted)' }}>⌂</span>
                {sellingStore.name}
              </button>
            )}
            <button
              type="button"
              className="topbar-icon"
              title="Notifications"
              aria-label="Notifications"
              data-testid="notifications-bell"
              onClick={() => setDrawer(true)}
            >
              ◔{inbox.unread > 0 && <span className="unread-badge">{inbox.unread}</span>}
            </button>
            <Link
              href="/pos"
              className="btn btn-primary btn-sm no-underline"
              data-testid="new-sale"
            >
              <span className="hidden sm:inline">New sale</span>
              <span className="sm:hidden">POS</span>
              <kbd
                className="key hidden sm:inline"
                style={{
                  border: 0,
                  background: 'transparent',
                  color: 'inherit',
                  opacity: 0.6,
                  padding: 0,
                }}
              >
                N
              </kbd>
            </Link>
            {user && (
              <UserMenu
                user={{
                  name: user.name ?? null,
                  email: user.email,
                  roleName: me?.roleName ?? null,
                }}
                sellingStore={sellingStore?.name ?? null}
                canChangeStore={storeChoices.length > 1}
                onChangeStore={() => setPickStore(true)}
                onShortcuts={() => setHelp(true)}
              />
            )}
          </div>
        </header>

        {pickStore && storeChoices.length > 0 && (
          <div className="overlay overlay-center" style={{ zIndex: 70 }} data-testid="store-picker">
            <div
              role="dialog"
              aria-modal
              aria-label="Which store are you selling at today?"
              className="dialog"
              style={{ width: 420 }}
            >
              <div style={{ padding: '18px 20px 6px' }}>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>
                  Which store are you selling at today?
                </h3>
                <p style={{ margin: 0, color: 'var(--text2)', fontSize: 12.5 }}>
                  Everything you ring this session, including money tendered, counts toward the
                  store you pick.
                </p>
              </div>
              <div
                style={{
                  padding: '10px 12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                {storeChoices.map((loc) => {
                  const current = sellingStore?.id === loc.id;
                  return (
                    <button
                      key={loc.id}
                      type="button"
                      onClick={() => chooseStore(loc)}
                      data-testid={`pick-store-${loc.id}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '9px 12px',
                        border: `1px solid ${current ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 7,
                        background: current ? 'var(--accent-soft)' : 'var(--surface)',
                        textAlign: 'left',
                        fontSize: 13,
                        cursor: 'pointer',
                        color: 'inherit',
                      }}
                    >
                      <span style={{ color: 'var(--muted)' }}>⌂</span>
                      <span style={{ flex: 1, fontWeight: 500 }}>{loc.name}</span>
                      {current && (
                        <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                          current
                        </span>
                      )}
                    </button>
                  );
                })}
                {sellingStore && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ alignSelf: 'flex-end', marginTop: 6 }}
                    onClick={() => setPickStore(false)}
                  >
                    Keep {sellingStore.name}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <main
          className={`mx-auto w-full px-4 pb-12 pt-5 md:px-[22px] md:pt-[22px] ${wideContent ? 'max-w-[1560px]' : 'max-w-[1440px]'}`}
        >
          {children}
        </main>
      </div>

      {cmd && <CommandPalette onClose={() => setCmd(false)} />}
      {drawer && (
        <PersonalInbox
          inbox={inbox}
          ownerRows={notifications.rows}
          onClose={() => setDrawer(false)}
          onOwnerRead={notifications.markRead}
        />
      )}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </div>
  );
}

/**
 * Sidebar brand block. White-label aware: a business with branding
 * shows its own logo/name; otherwise the platform default. The
 * two-letter monogram falls back to the first letters of the name.
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
    <Link
      href="/dashboard"
      className="no-underline"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '4px 8px 14px',
        color: 'inherit',
      }}
    >
      {branding?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tenant-supplied remote URL; next/image needs domain allow-listing per tenant
        <img
          src={branding.logoUrl}
          alt=""
          style={{ width: 26, height: 26, borderRadius: 7, objectFit: 'contain' }}
        />
      ) : (
        <span
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: 'var(--text)',
            color: 'var(--surface)',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: '-0.02em',
            flex: 'none',
          }}
        >
          {monogram || 'ERP'}
        </span>
      )}
      <span style={{ lineHeight: 1.15, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontWeight: 600,
            fontSize: 13,
            letterSpacing: '-0.01em',
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        {/* Audit hygiene: a visible build identifier so findings can be
            pinned to a deploy (Vercel injects the commit SHA at build). */}
        <span className="mono" style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)' }}>
          ERP · build {build}
        </span>
      </span>
    </Link>
  );
}
