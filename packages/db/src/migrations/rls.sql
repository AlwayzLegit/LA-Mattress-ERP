-- Post-migration: RLS policies, helper functions, and the application role.
-- Idempotent: safe to run on every deploy.
--
-- Source of truth for tenant isolation. Application connections must:
--   1. SET LOCAL ROLE app_user
--   2. SET LOCAL app.current_business_id = '<uuid>'
--   3. (Optional) SET LOCAL app.is_super_admin = 'true' for super-admin paths
-- All inside a single transaction so the settings are scoped to the request.

-- ============================================================================
-- Application role
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;

-- The connecting role must be able to SET LOCAL ROLE app_user, which
-- requires membership. Superusers can SET ROLE to anything, so this never
-- mattered locally — but on managed Postgres the app connects as a plain
-- owner role and every tenant request dies here without the grant.
-- (pg_has_role is always true for superusers, making this a no-op locally.)
-- The guard must test the SET privilege specifically, not MEMBER: on PG16
-- the role that CREATEs app_user gets an admin-option row (SET FALSE) that
-- makes MEMBER read true while SET ROLE still fails — which is exactly the
-- state a fresh managed cluster ends up in after the first migration run.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'app_user', 'SET') THEN
    EXECUTE format('GRANT app_user TO %I WITH SET TRUE', current_user);
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- PLAN-STORIS-GAP §2: the audit trail and the override register are
-- append-only for the app role — otherwise the audit is worth exactly
-- as much as the admin's self-restraint. (exception_events keeps UPDATE
-- for acknowledge; write_offs is append-only too.)
REVOKE UPDATE, DELETE ON audit_logs FROM app_user;
REVOKE UPDATE, DELETE ON security_overrides FROM app_user;
REVOKE UPDATE, DELETE ON write_offs FROM app_user;
REVOKE DELETE ON exception_events FROM app_user;

-- ============================================================================
-- Context helpers
-- ============================================================================

CREATE OR REPLACE FUNCTION current_business_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_business_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_super_admin', true), '')::boolean, false)
$$;

GRANT EXECUTE ON FUNCTION current_business_id() TO app_user;
GRANT EXECUTE ON FUNCTION is_super_admin() TO app_user;

-- ============================================================================
-- RLS on tenant-scoped tables (the ones with a `business_id` column)
-- ============================================================================

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
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
    'order_notes',
    'order_tasks',
    'member_notifications',
    'cash_pickup_receipts',
    'order_change_acks',
    'staff_shifts',
    'time_punches',
    'delivery_runs',
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
    'report_dictionaries',
    'report_definitions',
    'report_archives',
    'vendor_po_cutting_dates'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (business_id = current_business_id() OR is_super_admin())
         WITH CHECK (business_id = current_business_id() OR is_super_admin())',
      t
    );
  END LOOP;
END
$$;

-- audit_logs has a nullable business_id (platform-level events). Allow super
-- admins to insert/select rows with NULL business_id; everyone else is bound
-- to their tenant.
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING (
    is_super_admin()
    OR (business_id IS NOT NULL AND business_id = current_business_id())
  )
  WITH CHECK (
    is_super_admin()
    OR (business_id IS NOT NULL AND business_id = current_business_id())
  );

-- role_permissions has no business_id; isolation is enforced via the parent
-- role row.
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON role_permissions;
CREATE POLICY tenant_isolation ON role_permissions
  USING (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.business_id = current_business_id()
    )
  )
  WITH CHECK (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.business_id = current_business_id()
    )
  );

-- ============================================================================
-- Platform tables: not tenant-scoped, but app_user must not list every user
-- ============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self_or_member ON users;
-- An app_user query can see itself, or users who share a membership with the
-- current business. Super admins see everyone.
CREATE POLICY users_self_or_member ON users
  USING (
    is_super_admin()
    OR id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.business_id = current_business_id()
    )
  )
  WITH CHECK (
    is_super_admin()
    OR id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sessions_owner_only ON sessions;
CREATE POLICY sessions_owner_only ON sessions
  USING (
    is_super_admin()
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    is_super_admin()
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS businesses_member_only ON businesses;
CREATE POLICY businesses_member_only ON businesses
  USING (
    is_super_admin()
    OR id = current_business_id()
  )
  WITH CHECK (
    is_super_admin()
    OR id = current_business_id()
  );

-- ============================================================================
-- Auth tables (better-auth managed)
-- ============================================================================

-- accounts: a user can only see their own credentials. better-auth's queries
-- run as the postgres superuser (bypassing RLS) when handling sign-up and
-- login; this policy protects against any code that drops to app_user and
-- tries to read someone else's password hash.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounts_owner_only ON accounts;
CREATE POLICY accounts_owner_only ON accounts
  USING (
    is_super_admin()
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    is_super_admin()
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

-- two_factors: same shape as accounts.
ALTER TABLE two_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE two_factors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS two_factors_owner_only ON two_factors;
CREATE POLICY two_factors_owner_only ON two_factors
  USING (
    is_super_admin()
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    is_super_admin()
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

-- verifications: short-lived random tokens never exposed to clients. Only
-- ever read/written server-side by better-auth (which runs as superuser).
-- Block all access from app_user; the table stays reachable to postgres.
ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS verifications_super_admin_only ON verifications;
CREATE POLICY verifications_super_admin_only ON verifications
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

-- business_templates: platform-level config snapshots, super-admin
-- surface only.
ALTER TABLE business_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_templates_super_admin_only ON business_templates;
CREATE POLICY business_templates_super_admin_only ON business_templates
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

-- stripe_webhook_events: platform-internal log; the webhook handler runs
-- as the postgres role (RLS bypassed there) and tenant code never needs
-- to read this table.
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stripe_webhook_events_super_admin_only ON stripe_webhook_events;
CREATE POLICY stripe_webhook_events_super_admin_only ON stripe_webhook_events
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

-- ============================================================================
-- Root-connection bypass (managed Postgres)
-- ============================================================================
-- Everything above assumes the API's root connection — the role that runs
-- migrations and serves better-auth / audit / admin queries — bypasses row
-- security. That holds locally and in CI, where the connection role is the
-- `postgres` superuser. It does NOT hold on managed Postgres (Render, RDS,
-- Neon): there the app's role merely owns the tables, and FORCE ROW LEVEL
-- SECURITY subjects owners to policies too. First symptom in production was
-- sign-up dying on the users INSERT policy before tenant code ever ran.
--
-- So: give the role running this script an explicit allow-all policy on
-- every RLS-enabled table. Tenant isolation is untouched — policies are
-- per-role, and request transactions demoted via SET LOCAL ROLE app_user
-- can never match a policy scoped to the root role. Superuser environments
-- are unaffected (they bypass RLS regardless). The loop reads pg_tables so
-- new RLS'd tables are covered without maintaining a second list.

DO $$
DECLARE
  t text;
BEGIN
  IF current_user = 'app_user' THEN
    RAISE EXCEPTION 'rls.sql must run as the root/owner role, not app_user';
  END IF;
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND rowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS root_bypass ON %I', t);
    EXECUTE format(
      'CREATE POLICY root_bypass ON %I TO %I USING (true) WITH CHECK (true)',
      t, current_user
    );
  END LOOP;
END
$$;
