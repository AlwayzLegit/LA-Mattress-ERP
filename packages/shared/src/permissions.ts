export const PERMISSIONS = {
  'business.settings.view': 'View business settings',
  'business.settings.update': 'Update business settings',
  'business.billing.view': 'View billing',
  'business.billing.update': 'Update billing',
  /** A22 slice 7 (STORIS Recover Licenses): see every member's sign-ins and sign one out. */
  'sessions.manage': "See every member's active sessions and sign them out",

  'users.view': 'View users in business',
  'users.invite': 'Invite new users',
  'users.update': 'Update user details',
  'users.disable': 'Disable users',
  'users.delete': 'Remove members from the business (history is kept)',
  'roles.view': 'View roles',
  'roles.create': 'Create custom roles',
  'roles.update': 'Update roles',
  'roles.delete': 'Delete roles',

  'locations.view': 'View locations',
  'locations.create': 'Create locations',
  'locations.update': 'Update locations',
  'locations.delete': 'Delete locations',

  'products.view': 'View products',
  'products.create': 'Create products',
  'products.update': 'Update products',
  'products.delete': 'Delete products',
  'products.cost.view': 'View product cost',
  'products.merge': 'Relink sales to another product and retire listings',
  'categories.manage': 'Manage categories',

  'inventory.view': 'View inventory levels',
  'inventory.adjust': 'Adjust inventory',
  'inventory.receive': 'Receive inventory',
  'inventory.transfer': 'Transfer between locations',
  'inventory.write_off':
    'Write off (scrap) physical goods — valued at cost on the write-off register',
  'as_is.price.set': 'Set or change the as-is selling price on a piece',

  'vendors.view': 'View vendors',
  'vendors.manage': 'Create / update / delete vendors',
  'vendor_invoices.manage': 'Record vendor invoices, match them to POs, and approve them',

  'purchase_orders.view': 'View purchase orders',
  'purchase_orders.create': 'Create purchase orders',
  'purchase_orders.receive': 'Receive against purchase orders',
  'purchase_orders.cancel': 'Cancel a purchase order',
  'purchase_orders.delete':
    'Delete a draft purchase order (soft delete — the number is retired, never reused)',

  'customers.view': 'View customers',
  'customers.create': 'Create customers',
  'customers.update': 'Update customers',
  'customers.delete': 'Delete customers',

  'discounts.view': 'View discount codes',
  'discounts.manage': 'Create / update / delete discount codes',

  'webhooks.view': 'View webhook endpoints + delivery history',
  'webhooks.manage': 'Create / update / delete webhook endpoints',

  'api_keys.view': 'View API keys',
  'api_keys.manage': 'Create / revoke API keys',

  'gift_cards.view': 'View gift cards',
  'gift_cards.issue': 'Issue gift cards',
  'gift_cards.adjust': 'Adjust gift card balance / cancel a gift card',

  'orders.view': 'View sales orders',
  'orders.create': 'Write sales orders',
  'orders.update': 'Update sales orders and their lines',
  'orders.cancel': 'Cancel a sales order',
  'orders.deposit.take': 'Take a deposit or balance payment on an order',
  'orders.complete_with_balance': 'Complete an order that still has a balance due',
  'orders.unlock': 'Unlock an order locked by a delivery-ticket print (typed reason required)',
  'orders.price_override':
    'Approve deep price overrides — beyond the tier-2 variance threshold or below cost',

  'deliveries.view': 'View the delivery calendar and day sheets',
  'deliveries.schedule': 'Schedule / reschedule deliveries',
  'deliveries.complete': 'Mark deliveries delivered or failed',

  'special_orders.manage': 'Manage the to-order queue and PO allocations',

  'payment_plans.view': 'View layaway / in-house payment plans',
  'payment_plans.manage': 'Create plans and take installment payments',

  'commissions.view_own': 'View own commission entries',
  'commissions.view_all': 'View all commission entries',
  'commissions.manage': 'Manage commission plans, approve and mark entries paid',

  'service_orders.view': 'View service orders',
  'service_orders.create': 'Intake service orders',
  'service_orders.update': 'Update service orders, notes and charges',
  'service_orders.complete': 'Complete service orders',

  'serials.view': 'View serial units',
  'serials.manage': 'Create / update serial units',

  'crm.notes.manage': 'Create / update customer notes',
  'crm.tags.manage': 'Manage customer tags',
  'crm.campaigns.manage': 'Create and send email campaigns',
  'crm.automations.manage': 'Manage post-purchase automations',

  'import.run': 'Run the legacy data import (upload, validate, commit)',
  'integrations.manage':
    'Connect, sync, and disconnect external platforms (Shopify, WooCommerce, Wix)',

  'pos.access': 'Access the POS register',
  'pos.transaction.create': 'Create sales',
  'pos.transaction.discount': 'Apply line/order discounts',
  'pos.transaction.void': 'Void open transactions',
  'pos.refund.create': 'Process refunds',
  'pos.refund.approve': 'Approve refunds above limit',
  'returns.override_window': 'Approve a return outside the return window',
  'returns.no_original': 'Enter a return without the original order (no-original)',
  'exchanges.create': 'Enter a customer exchange (return + replacement in one settlement)',
  'exchanges.approve': 'Release an exchange held for approval at entry (E1 hold)',
  'exchanges.restocking_fee.override': 'Override the calculated restocking fee on an exchange',
  'pos.cash.open': 'Open cash drawer',
  'pos.cash.reconcile': 'Reconcile cash drawer',
  'pos.cash.approve': 'Approve an out-of-tolerance or suspended drawer count',
  'pos.cash.pickup_confirm':
    'Tick a cash payment as physically picked up from the store (dashboard store cards)',
  'sales.view': 'View completed sales and refund history',

  'reports.sales.view': 'View sales reports',
  'reports.inventory.view': 'View inventory reports',
  'reports.financial.view': 'View financial reports (incl. cost/margin)',
  'reports.export': 'Export reports',
  'reports.builder.run': 'Run self-service report-builder reports',
  'reports.builder.author': 'Create and edit report-builder reports and dictionaries',
  'gl.view': 'View the general ledger (accounts, periods, journal batches)',
  'gl.post': 'Create and post journal entries',
  'gl.manage': 'Manage the chart of accounts and fiscal periods',
  'reports.cost.view': 'See cost/margin data in report-builder output (field masking)',

  'audit.view': 'View audit log',

  'ops.dashboard.view':
    'See the operations dashboard — every store\u2019s sales, money in/out, and the audit feed',
  'ops.review.clear': 'Clear reviewed items off the operations feed (records who cleared them)',
  'warehouse.dashboard.view':
    'See the warehouse dashboard — inbound POs, the dock, load-out, pickups, transfers',
  'cashier.dashboard.view':
    'See the My Day dashboard — own sales, drawer, call-backs, balances due, commission',

  // Staff schedule + time clock (owner hand-off 2026-09-10, step 2).
  'schedule.view': 'See the staff schedule',
  'schedule.edit': 'Set shifts and publish the week (Owner and Operations)',
  'timeclock.punch': 'Clock in and out, take breaks, on the dashboard time clock',

  'reason_codes.manage': 'Manage the reason-code registry (add / deactivate / restrict codes)',
  'security_overrides.view': 'View the security-override register',

  // Super-admin only — platform surfaces, never granted to a business role.
  'platform.templates.manage': 'Create and apply business templates (snapshots)',
  'platform.agencies.manage': 'Manage agencies and their business assignments',
} as const;

/**
 * Permissions that only ever belong to a platform super admin. They are
 * excluded from every seeded business role, Owner included — an Owner
 * runs their business, not the platform.
 */
export const SUPER_ADMIN_ONLY_PERMISSIONS = [
  'platform.templates.manage',
  'platform.agencies.manage',
] as const satisfies readonly (keyof typeof PERMISSIONS)[];

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * The permissions a business role or membership override may carry —
 * everything except the platform super-admin surface. Grant validation
 * (roles.controller, member overrides) and the web permission editors
 * both read this list, so a super-admin permission can never be granted
 * inside a business, whatever the request body says.
 */
export const BUSINESS_PERMISSIONS = ALL_PERMISSIONS.filter(
  (p) => !(SUPER_ADMIN_ONLY_PERMISSIONS as readonly string[]).includes(p),
);

export interface PermissionGroup {
  /** Stable key for React lists / collapse state. */
  key: string;
  /** Human heading shown in the permission editors. */
  label: string;
  permissions: Permission[];
}

/**
 * Display grouping for the permission editors (Shopify-style access
 * sections). Order here is presentation order. Membership is derived
 * from the key prefix so a new permission lands in its group (or the
 * trailing "Other" bucket) without touching this file — the unit test
 * asserts full, duplicate-free coverage of BUSINESS_PERMISSIONS.
 */
const GROUP_DEFS: { key: string; label: string; prefixes: string[] }[] = [
  {
    key: 'pos',
    label: 'Point of sale',
    prefixes: ['pos', 'returns', 'exchanges', 'sales', 'cashier'],
  },
  { key: 'orders', label: 'Sales orders', prefixes: ['orders'] },
  { key: 'deliveries', label: 'Deliveries', prefixes: ['deliveries'] },
  { key: 'customers', label: 'Customers', prefixes: ['customers'] },
  { key: 'crm', label: 'CRM & marketing', prefixes: ['crm'] },
  { key: 'products', label: 'Products & catalog', prefixes: ['products', 'categories'] },
  { key: 'inventory', label: 'Inventory', prefixes: ['inventory', 'as_is', 'serials'] },
  { key: 'purchasing', label: 'Purchasing', prefixes: ['purchase_orders', 'special_orders'] },
  { key: 'vendors', label: 'Vendors & payables', prefixes: ['vendors', 'vendor_invoices'] },
  { key: 'pricing', label: 'Discounts & gift cards', prefixes: ['discounts', 'gift_cards'] },
  { key: 'plans', label: 'Payment plans', prefixes: ['payment_plans'] },
  { key: 'commissions', label: 'Commissions', prefixes: ['commissions'] },
  { key: 'service', label: 'Service', prefixes: ['service_orders'] },
  { key: 'reports', label: 'Reports', prefixes: ['reports'] },
  { key: 'gl', label: 'General ledger', prefixes: ['gl'] },
  { key: 'team', label: 'Team & roles', prefixes: ['users', 'roles'] },
  { key: 'business', label: 'Business settings', prefixes: ['business', 'locations'] },
  { key: 'schedule', label: 'Schedule & time clock', prefixes: ['schedule', 'timeclock'] },
  {
    key: 'security',
    label: 'Audit & security',
    prefixes: ['audit', 'ops', 'reason_codes', 'security_overrides', 'warehouse'],
  },
  {
    key: 'integrations',
    label: 'Integrations & data',
    prefixes: ['webhooks', 'api_keys', 'integrations', 'import'],
  },
];

export const PERMISSION_GROUPS: PermissionGroup[] = (() => {
  const groups = GROUP_DEFS.map((g) => ({
    key: g.key,
    label: g.label,
    permissions: [] as Permission[],
  }));
  const other: Permission[] = [];
  for (const p of BUSINESS_PERMISSIONS) {
    const prefix = p.split('.')[0] ?? '';
    const idx = GROUP_DEFS.findIndex((g) => g.prefixes.includes(prefix));
    if (idx >= 0) groups[idx]!.permissions.push(p);
    else other.push(p);
  }
  if (other.length > 0) groups.push({ key: 'other', label: 'Other', permissions: other });
  return groups.filter((g) => g.permissions.length > 0);
})();
