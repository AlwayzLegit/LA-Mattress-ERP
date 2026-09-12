export * from './platform';
export * from './auth';
export * from './tenancy';
export * from './audit';
export * from './catalog';
export * from './inventory';
export * from './customers';
export * from './orders';
export * from './sales';
export * from './money-plans';
export * from './service';
export * from './cash';
export * from './billing';
export * from './stripe';
export * from './purchasing';
export * from './transfers';
export * from './gl';
export * from './taxes';
export * from './discounts';
export * from './webhooks';
export * from './api-keys';
export * from './idempotency';
export * from './gift-cards';
export * from './migration';
export * from './templates';
export * from './integrations';
export * from './marketing';
export * from './returns';
export * from './controls';
export * from './physical-inventory';
export * from './costing';
export * from './jobs';
export * from './exchanges';
export * from './reporting';
export * from './collaboration';
export * from './store-dashboard';
export * from './schedule';

// List of tables that carry a `business_id` and need RLS. Kept in sync with
// the migration script in src/migrations/rls.sql — when you add a new
// tenant-scoped table, append it both here and in that file.
export const TENANT_SCOPED_TABLES = [
  'order_attachments',
  'cash_pickup_receipts',
  'cash_pickups',
  'cash_pickup_items',
  'order_change_acks',
  'staff_shifts',
  'time_punches',
  'order_tasks',
  'member_notifications',
  'order_notes',
  'locations',
  'memberships',
  'roles',
  'membership_location_scopes',
  'audit_logs',
  'products',
  'product_variants',
  'product_images',
  'categories',
  'brands',
  'collections',
  'storage_bins',
  'inventory_levels',
  'inventory_movements',
  'customers',
  'sales',
  'sale_lines',
  'orders',
  'order_lines',
  'deliveries',
  'delivery_lines',
  'payments',
  'refunds',
  'refund_lines',
  'cash_shifts',
  'gl_accounts',
  'gl_periods',
  'gl_journal_batches',
  'gl_journal_lines',
  'subscriptions',
  'subscription_payments',
  'merchant_stripe_accounts',
  'stripe_oauth_states',
  'vendors',
  'purchase_orders',
  'purchase_order_lines',
  'stock_transfers',
  'stock_transfer_lines',
  'stock_manifests',
  'tax_classes',
  'tax_class_rates',
  'discount_codes',
  'discount_redemptions',
  'webhook_endpoints',
  'webhook_deliveries',
  'api_keys',
  'idempotency_keys',
  'gift_cards',
  'gift_card_transactions',
  'legacy_refs',
  'import_batches',
  'import_rows',
  'integrations',
  'po_line_allocations',
  'serial_units',
  'payment_plans',
  'payment_plan_installments',
  'commission_plans',
  'commission_entries',
  'service_orders',
  'service_order_lines',
  'service_order_notes',
  'customer_notes',
  'customer_tags',
  'customer_tag_links',
  'customer_segments',
  'campaigns',
  'order_sequences',
  'membership_permission_overrides',
  'vendor_invoices',
  'as_is_items',
  'store_credit_entries',
  'reason_codes',
  'security_overrides',
  'order_returns',
  'order_return_lines',
  'exception_events',
  'write_offs',
  'physical_counts',
  'physical_count_lines',
  'cost_layers',
  'cost_consumptions',
  'job_runs',
  'exchanges',
  'daily_closeouts',
  'ops_reviews',
  'delivery_runs',
  'report_dictionaries',
  'report_definitions',
  'report_archives',
] as const;
