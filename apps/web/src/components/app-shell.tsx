'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { ActiveBusinessBadge } from '@/components/active-business-badge';
import { DynamicFavicon } from '@/components/dynamic-favicon';
import { Kbd } from '@/components/ui';
import { api } from '@/lib/api';
import { useActingStore } from '@/lib/acting-store';
import { useSession } from '@/lib/auth-client';
import { ActingStoreChip } from '@/components/shell/acting-store-chip';
import { CommandPalette } from '@/components/shell/command-palette';
import { RoleSwitcher } from '@/components/shell/dashboard-controls';
import { GO_KEYS, NAV, navFor } from '@/components/shell/nav';
import { useNotifications } from '@/components/shell/notifications-drawer';
import { PersonalInbox, useTeamInbox } from '@/components/shell/personal-inbox';
import { ShellError } from '@/components/shell/shell-error';
import { ShortcutsDialog } from '@/components/shell/shortcuts-dialog';
import { Sidebar } from '@/components/shell/sidebar';
import { UserMenu } from '@/components/shell/user-menu';

/** The member editor reads the nav to let the owner hide tabs per member. */
export { NAV };

/**
 * The (business) application shell (redesign Phase 3, README §2 and
 * canvas 3a–3e): 220px sidebar (200px at 1280) with Dashboard and five
 * collapsible groups, role-trimmed; a 50px topbar whose first control is
 * the "Acting for {Store}" chip, then the owner's role switcher, the
 * search trigger with a platform shortcut chip, the inbox, New sale and
 * the account menu. Period and store-scope controls belong to the
 * dashboard and reports, not the shell. Global loading and error states
 * render inside the frame so the sidebar never disappears.
 */

interface NavCounts {
  openOrders: number;
  atRisk: number;
  exceptions: number;
  deliveriesToday: number;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const session = useSession();
  const acting = useActingStore();
  const me = acting.me;
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
  const [counts, setCounts] = useState<NavCounts | null>(null);
  const [cmd, setCmd] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);
  const gPending = useRef<number | null>(null);

  const inbox = useTeamInbox(session.data?.user.id);
  const notifications = useNotifications(
    !!session.data,
    `${session.data?.user.id ?? ''}:${inbox.data?.businessId ?? ''}`,
  );

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
        if (dest) router.push(dest.href);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeAll, isDashboard, router]);

  const groups = useMemo(() => navFor(me?.roleName, me?.hiddenNav ?? []), [me]);
  const countFor = useCallback(
    (href: string): number | null => {
      if (href === '/tasks') return inbox.unread || null;
      if (!counts) return null;
      if (href === '/orders') return counts.openOrders || null;
      if (href === '/jeopardy') return counts.atRisk || null;
      if (href === '/deliveries') return counts.deliveriesToday || null;
      return null;
    },
    [counts, inbox.unread],
  );
  const user = session.data?.user;
  const isOwner = me?.roleName === 'Owner';

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
        className={`app-sidebar fixed inset-y-0 left-0 z-40 flex w-[var(--sidebar-width)] flex-col overflow-y-auto transition-transform duration-150 ${
          open ? 'translate-x-0' : '-translate-x-full'
        } md:translate-x-0`}
      >
        <Sidebar
          groups={groups}
          counts={countFor}
          userKey={user?.id ?? 'anon'}
          onNavigate={() => setOpen(false)}
          onShortcuts={() => setHelp(true)}
        />
      </aside>

      <div className="app-main md:ml-[var(--sidebar-width)]">
        <header className="app-topbar">
          <button
            type="button"
            className="btn btn-ghost btn-sm md:hidden"
            aria-label="Toggle navigation"
            onClick={() => setOpen((v) => !v)}
          >
            <Menu size={18} aria-hidden />
          </button>
          <ActingStoreChip />
          {isOwner && <RoleSwitcher />}
          <button
            type="button"
            onClick={() => setCmd(true)}
            data-testid="global-search"
            className="topbar-search"
          >
            <span aria-hidden className="topbar-search-glyph">
              ⌕
            </span>
            <span className="topbar-search-text">Search orders, customers, SKUs…</span>
            <Kbd keys="mod+k" className="hidden sm:inline-block" />
          </button>
          <div className="topbar-end">
            <button
              type="button"
              className="topbar-icon"
              aria-label={inbox.unread > 0 ? `Inbox, ${inbox.unread} unread` : 'Inbox'}
              title="Inbox"
              data-testid="notifications-bell"
              onClick={() => setDrawer(true)}
            >
              <span aria-hidden>◔</span>
              {inbox.unread > 0 && <span className="unread-badge">{inbox.unread}</span>}
            </button>
            <Link href="/pos" className="btn btn-primary no-underline" data-testid="new-sale">
              <span className="hidden sm:inline">New sale</span>
              <span className="sm:hidden">POS</span>
              <Kbd keys="n" className="hidden sm:inline-block" />
            </Link>
            {user && (
              <UserMenu
                user={{
                  name: user.name ?? null,
                  email: user.email,
                  roleName: me?.roleName ?? null,
                }}
                sellingStore={acting.store?.name ?? null}
                canChangeStore={false}
                onChangeStore={() => undefined}
                onShortcuts={() => setHelp(true)}
              />
            )}
            <ActiveBusinessBadge />
          </div>
        </header>

        <main
          className={`mx-auto w-full px-4 pb-12 pt-5 md:px-[22px] md:pt-[22px] ${wideContent ? 'max-w-[1560px]' : 'max-w-[1440px]'}`}
        >
          <ShellError />
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
