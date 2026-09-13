-- Custom SQL migration file, put your code below! --

-- Add Product "From" defaults to the warehouse for everyone
-- (HANDOFF_inventory_source_defaults §2). Migration 0066 added
-- locations.location_type but never marked the location the business
-- calls "Warehouse", and no business had a default stock source set, so
-- the register's rule fell through to the signed-in store. The handoff's
-- step 3: mark the location named Warehouse (case-insensitive, per
-- tenant) and, where a business then has exactly one active warehouse and
-- no default of its own, make it the default stock source for new sale
-- lines (ops_settings_json.defaultSourceLocationId, the same key Settings
-- writes). Idempotent; a configured default is never overwritten.
-- backfill:start
UPDATE locations
SET location_type = 'warehouse'
WHERE location_type = 'store'
  AND lower(btrim(name)) = 'warehouse';
--> statement-breakpoint
WITH one_warehouse AS (
  SELECT business_id, min(id::text)::uuid AS location_id
  FROM locations
  WHERE location_type = 'warehouse' AND is_active = true
  GROUP BY business_id
  HAVING count(*) = 1
)
UPDATE businesses b
SET ops_settings_json = jsonb_set(
  coalesce(b.ops_settings_json, '{}'::jsonb),
  '{defaultSourceLocationId}',
  to_jsonb(w.location_id::text),
  true
)
FROM one_warehouse w
WHERE w.business_id = b.id
  AND coalesce(b.ops_settings_json ->> 'defaultSourceLocationId', '') = '';
-- backfill:end
