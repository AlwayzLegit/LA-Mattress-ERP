/**
 * Sidebar navigation (redesign Phase 3, README §2): Dashboard, then five
 * collapsible groups named for what the business does — Sell, After
 * sale, Stock, Money, People & setup. Only the current group stays open.
 * Cashiers get the eight-link default set; the owner can still hide
 * tabs per member (`hiddenNav`, keyed by href).
 */

export interface NavItem {
  href: string;
  label: string;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const HOME: NavItem = { href: '/dashboard', label: 'Dashboard' };

export const NAV: NavGroup[] = [
  {
    label: 'Sell',
    items: [
      { href: '/pos', label: 'New sale' },
      { href: '/orders', label: 'Orders' },
      { href: '/customers', label: 'Customers' },
      { href: '/deliveries', label: 'Deliveries' },
      { href: '/jeopardy', label: 'At risk' },
      { href: '/my-day', label: 'My day' },
    ],
  },
  {
    label: 'After sale',
    items: [
      { href: '/returns', label: 'Returns' },
      { href: '/exchanges', label: 'Exchanges' },
      { href: '/service', label: 'Service' },
      { href: '/special-orders', label: 'Special orders' },
    ],
  },
  {
    label: 'Stock',
    items: [
      { href: '/products', label: 'Products' },
      { href: '/purchase-orders', label: 'Purchasing' },
      { href: '/transfers', label: 'Transfers' },
      { href: '/as-is', label: 'As-Is review' },
      { href: '/gift-cards', label: 'Gift cards' },
    ],
  },
  {
    label: 'Money',
    items: [
      { href: '/sales', label: 'Sales' },
      { href: '/shifts', label: 'Shifts' },
      { href: '/reports', label: 'Reports' },
      { href: '/commissions', label: 'Commissions' },
      { href: '/gl', label: 'General ledger' },
    ],
  },
  {
    label: 'People & setup',
    items: [
      { href: '/salespeople', label: 'Salespeople' },
      { href: '/tasks', label: 'Team tasks' },
      { href: '/members', label: 'Members & roles' },
      { href: '/timeclock', label: 'Time clock' },
      { href: '/settings', label: 'Settings' },
    ],
  },
];

/**
 * Pages that left the sidebar in the redesign but still exist. They stay
 * reachable from the command palette ("Go to") and from their parent
 * screens (Roles under Members, Locations under Settings, …).
 */
export const MORE_PAGES: NavItem[] = [
  { href: '/categories', label: 'Categories' },
  { href: '/warehouse', label: 'Warehouse' },
  { href: '/vendors', label: 'Vendors' },
  { href: '/replenishment', label: 'Replenishment' },
  { href: '/marketing', label: 'Marketing' },
  { href: '/roles', label: 'Roles' },
  { href: '/settings/sessions', label: 'Active sessions' },
  { href: '/reports/builder', label: 'Report builder' },
  { href: '/operations', label: 'Operations' },
  { href: '/exceptions', label: 'Exceptions' },
  { href: '/jobs', label: 'Nightly jobs' },
  { href: '/audit', label: 'Audit log' },
  { href: '/locations', label: 'Locations' },
  { href: '/deliveries/dispatch', label: 'Dispatch' },
  { href: '/products/stock', label: 'Stock by location' },
];

/** The cashier default (README §2): eight links, "My drawer" for Shifts. */
export const CASHIER_NAV: NavGroup[] = [
  {
    label: 'Sell',
    items: [
      { href: '/pos', label: 'New sale' },
      { href: '/orders', label: 'Orders' },
      { href: '/customers', label: 'Customers' },
      { href: '/deliveries', label: 'Deliveries' },
      { href: '/my-day', label: 'My day' },
    ],
  },
  { label: 'Stock', items: [{ href: '/products', label: 'Products' }] },
  {
    label: 'Money',
    items: [
      { href: '/sales', label: 'Sales' },
      { href: '/shifts', label: 'My drawer' },
    ],
  },
  { label: 'Me', items: [{ href: '/timeclock', label: 'Time clock' }] },
];

/** `g` then one of these jumps (README §2: g o / g d / g p, plus the older c / r / h / i). */
export const GO_KEYS: Record<string, { href: string; label: string }> = {
  o: { href: '/orders', label: 'Orders' },
  d: { href: '/deliveries', label: 'Deliveries' },
  p: { href: '/products', label: 'Products' },
  c: { href: '/customers', label: 'Customers' },
  r: { href: '/reports', label: 'Reports' },
  i: { href: '/products/stock', label: 'Stock by location' },
  h: { href: '/dashboard', label: 'Dashboard' },
};

/** The groups a member sees: role-trimmed, then minus the owner's hidden tabs. */
export function navFor(roleName: string | null | undefined, hiddenNav: string[]): NavGroup[] {
  const hidden = new Set(hiddenNav);
  const base = roleName === 'Cashier' ? CASHIER_NAV : NAV;
  return base
    .map((g) => ({ ...g, items: g.items.filter((i) => !hidden.has(i.href)) }))
    .filter((g) => g.items.length > 0);
}

export function isActiveHref(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
