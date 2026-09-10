'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Products absorbs Inventory (amendment A19, owner 2026-09-10): one
 * section, four screens. The strip sits under the page title on each.
 */
const TABS = [
  { href: '/products', label: 'Products', exact: true },
  { href: '/products/stock', label: 'Stock by location' },
  { href: '/products/counts', label: 'Counts' },
  { href: '/products/receive', label: 'Receive' },
];

export function ProductsNav() {
  const pathname = usePathname() ?? '';
  return (
    <nav
      aria-label="Products section"
      className="mb-4 flex flex-wrap gap-1 border-b border-[var(--border)]"
      data-testid="products-nav"
    >
      {TABS.map((t) => {
        const active = t.exact
          ? pathname === t.href || /^\/products\/(?!stock|counts|receive)[^/]+/.test(pathname)
          : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? '-mb-px border-b-2 border-[var(--accent,currentColor)] px-3 py-2 text-sm font-semibold'
                : 'px-3 py-2 text-sm text-[var(--muted-fg,inherit)] hover:underline'
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
