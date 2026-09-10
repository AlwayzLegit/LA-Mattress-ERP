import { ALL_PERMISSIONS, SUPER_ADMIN_ONLY_PERMISSIONS, type Permission } from './permissions.js';

export type SystemRoleName =
  | 'Owner'
  | 'Manager'
  | 'Operations'
  | 'Cashier'
  | 'Warehouse'
  | 'Bookkeeper';

export interface SystemRoleDefinition {
  name: SystemRoleName;
  description: string;
  permissions: Permission[];
}

// Platform surfaces (templates, agencies) belong to the super admin, not
// to any business role — not even Owner.
const superAdminOnly = new Set<Permission>(SUPER_ADMIN_ONLY_PERMISSIONS);

const businessPermissions: Permission[] = ALL_PERMISSIONS.filter((p) => !superAdminOnly.has(p));

const ownerPermissions: Permission[] = [...businessPermissions];

const managerExclusions = new Set<Permission>([
  'business.billing.view',
  'business.billing.update',
  'roles.delete',
  'users.disable',
  // Owner 2026-09-02: removing a member is the owner's call.
  'users.delete',
  // Owner 2026-09-10: confirming a cash pickup is the owner's or
  // Operations' tick, never the store's own manager's; likewise the
  // schedule is set by the owner and Operations — the manager reads it.
  'pos.cash.pickup_confirm',
  'schedule.edit',
]);

const managerPermissions: Permission[] = businessPermissions.filter(
  (p) => !managerExclusions.has(p),
);

/**
 * Operations (owner 2026-08-31): the member who watches every store's
 * selling, every dollar in and out, and every inventory movement, then
 * signs off on what they've read. Deliberately read-and-clear, never
 * approve — the approval permissions (`pos.refund.approve`,
 * `pos.cash.approve`, `orders.price_override`, `exchanges.approve`,
 * `returns.override_window`) stay with the Manager so the person who
 * authorizes an exception is never the person who clears it. They sell
 * occasionally, so they carry the register and order-writing verbs, but
 * no quota and no commission permission.
 */
const operationsPermissions: Permission[] = [
  // The dashboard and its sign-off verbs.
  'ops.dashboard.view',
  'ops.review.clear',
  // Owner 2026-09-10: the tick that says the cash was physically handed
  // over, stamped with the member who confirmed it.
  'pos.cash.pickup_confirm',
  // Step 2 (2026-09-10): sets and publishes the staff schedule; punches
  // their own clock like everyone else.
  'schedule.view',
  'schedule.edit',
  'timeclock.punch',

  // The audit surfaces the feed links into.
  'audit.view',
  'security_overrides.view',

  // Every store's sales, and every dollar in or out.
  'sales.view',
  'orders.view',
  'deliveries.view',
  'payment_plans.view',
  'gift_cards.view',
  'service_orders.view',

  // The reports behind the money tiles.
  'reports.sales.view',
  'reports.inventory.view',
  'reports.financial.view',
  'reports.export',

  // Inventory movement is audited, not performed — adjusting, receiving
  // and transferring stay with the Warehouse role.
  'products.view',
  'inventory.view',
  'serials.view',
  'purchase_orders.view',
  'vendors.view',

  // So a flagged row opens onto a real customer and a named store.
  'customers.view',
  'locations.view',
  'users.view',
  'discounts.view',

  // Occasional selling.
  'pos.access',
  'pos.transaction.create',
  'customers.create',
  'orders.create',
  'orders.update',
  'orders.deposit.take',
];

const cashierPermissions: Permission[] = [
  // My Day (owner 2026-09-01, §12.3): the register's own home.
  'cashier.dashboard.view',
  // Reads the schedule, punches the clock (2026-09-10).
  'schedule.view',
  'timeclock.punch',
  // Store list (owner report 2026-09-02): Inventory, Receive, Counts,
  // Returns, Exchanges, Replenishment and the order page all load
  // /v1/business/locations first — without this the page dies on a 403
  // before the role's own permissions ever matter.
  'locations.view',
  'pos.access',
  'pos.transaction.create',
  'pos.transaction.discount',
  'pos.cash.open',
  'pos.cash.reconcile',
  'sales.view',
  'customers.view',
  'customers.create',
  'products.view',
  'inventory.view',
  'discounts.view',
  'gift_cards.view',
  // Cutover: a cashier writes orders and takes money on them, but does
  // not reschedule deliveries or cancel someone else's order.
  'orders.view',
  'orders.create',
  'orders.update',
  'orders.deposit.take',
  'deliveries.view',
  'commissions.view_own',
  'service_orders.view',
  'service_orders.create',
];

/**
 * Warehouse (owner 2026-09-01) — the renamed Inventory Clerk, now with a
 * home of its own: the receiving dock, the trucks, the transfer lanes,
 * and everything §12.2's dashboard shows. SystemRoleSyncService renames
 * an existing tenant's "Inventory Clerk" system role in place, so
 * memberships never move.
 */
const warehousePermissions: Permission[] = [
  'warehouse.dashboard.view',
  // Reads the schedule, punches the clock (2026-09-10).
  'schedule.view',
  'timeclock.punch',
  // Store list (owner report 2026-09-02): Inventory, Receive, Counts,
  // Returns, Exchanges, Replenishment and the order page all load
  // /v1/business/locations first — without this the page dies on a 403
  // before the role's own permissions ever matter.
  'locations.view',

  'products.view',
  'inventory.view',
  'inventory.adjust',
  'inventory.receive',
  'inventory.transfer',
  'vendors.view',
  'vendors.manage',
  'purchase_orders.view',
  'purchase_orders.create',
  'purchase_orders.receive',
  // Cutover: the clerk works the special-order queue, the serial book,
  // and loads the trucks.
  'orders.view',
  'special_orders.manage',
  'serials.view',
  'serials.manage',
  'deliveries.view',
  'deliveries.schedule',
  'deliveries.complete',
];

const bookkeeperPermissions: Permission[] = [
  // Store list — see the cashier note; the books read per-store too.
  'locations.view',
  'schedule.view',
  // In-house GL (owner 2026-08-28): the books own the ledger.
  'gl.view',
  'gl.post',
  'gl.manage',
  'reports.sales.view',
  'reports.inventory.view',
  'reports.financial.view',
  'reports.export',
  'reports.builder.run',
  'reports.builder.author',
  'reports.cost.view',
  'sales.view',
  'audit.view',
  // Gap sprint §0.3: the books read the override/exception register.
  'security_overrides.view',
  // §6: the books record and approve vendor invoices against POs.
  'vendor_invoices.manage',
  'purchase_orders.view',
  // Cutover: the books need order revenue, receivables, and the
  // commission run — read-only.
  'orders.view',
  'deliveries.view',
  'payment_plans.view',
  'commissions.view_all',
  'service_orders.view',
];

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  { name: 'Owner', description: 'Full control of the business', permissions: ownerPermissions },
  {
    name: 'Manager',
    description: 'Manages day-to-day operations except billing and destructive role/user actions',
    permissions: managerPermissions,
  },
  {
    name: 'Operations',
    description:
      "Watches every store's sales, money in and out, and inventory movement, and signs off on what they review",
    permissions: operationsPermissions,
  },
  {
    name: 'Cashier',
    description: 'Operates the POS register and serves customers',
    permissions: cashierPermissions,
  },
  {
    name: 'Warehouse',
    description:
      'Runs the dock, the trucks and the stockroom — receiving, transfers, counts, serials',
    permissions: warehousePermissions,
  },
  {
    name: 'Bookkeeper',
    description: 'Read-only access to reports and audit trails',
    permissions: bookkeeperPermissions,
  },
];
