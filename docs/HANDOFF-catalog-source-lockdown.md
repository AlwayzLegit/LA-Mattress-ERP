# HANDOFF — Catalog source lockdown + wrong-SKU sales remap

Status: **PLAN — awaiting owner approval (2026-09-03).** Update 2026-09-06: B3/B4 shipped
in a self-serve form as PLAN-POS-OPERATIONS §12.14 (A18) — `GET /v1/products/cleanup/shopify`
(candidates + lines + scored crosswalk, CSV sheets) and `POST …/apply` (relink lines with
reservation / stock moves, retire listings), page `/products/cleanup`. B0 (D11/D12 amendments),
B1 (sync off), B2 (import hardening), B5, B6 and Phase C remain as written.

Owner ask (2026-09-03): "the only inventory and products we have in ERP are coming from
our import, not synced from Shopify or any other sources, because that's conflicting
with SKUs; and the existing sales with these wrong SKUs need to be resolved and replaced
with the right listing."

This document is the hand-off for a Claude Code session **with egress access** to
`jetnine-api.onrender.com`. Read `CLAUDE.md`, `HANDOFF.md`, `SPRINT-STATUS.md` first.
Everything here was fact-checked against `origin/main` @ `72ac3ae` by a research
workflow (5 readers + synthesis + 2 adversarial verifiers); citations are `path:line`.

---

## 1. Fact-check of the owner's claims

| #   | Claim                                                                                        | Verdict                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Products/inventory are synced from Shopify or other sources, not only from the STORIS import | **Partly holds.** Products: yes, on demand. Inventory: no. | `POST /v1/integrations/:provider/sync` (`apps/api/src/integrations/integrations.controller.ts:136-183`) pulls one product row per Shopify variant (`connectors.ts:153-166`) and lands it through the same import pipeline as STORIS, **without** replace-catalog (`:241-248`). It is button-only ("Sync now"); there is no scheduled or webhook-driven sync. Connectors never emit an inventory entity (`connectors.ts:25-28`), so stock is never synced. Docs record real Shopify syncs into the QA tenant on 2026-08-24/25 (`SPRINT-STATUS.md:1240-1251`, 1,805 products). Other non-STORIS product paths exist: manual `POST /v1/products` (web "New product"), API-only `POST /v1/products/:id/variants`, API-only legacy `POST /v1/products/import/commit`, super-admin templates.                   |
| C2  | The sync conflicts with SKUs                                                                 | **Holds.**                                                 | Product identity for import IS the SKU (`import-spec.ts:75`); `legacy_refs` is unique on (business, entity, `legacy_id`) with no source in the key. So a Shopify row with the same SKU as a STORIS product **overwrites** name, category, price, barcode, forces `is_active=true`, and nulls cost (`import.service.ts:813-855, 886`). Shopify rows with empty SKU become `shp-<id>` products (`connectors.ts:156`). SKU uniqueness is case-sensitive (`catalog.ts:111`) and the variant SKU index is non-unique (`:166`), so case-variant duplicates can coexist. The duplicates page groups by name only and `keep-imported` only deactivates; nothing re-links documents.                                                                                                                               |
| C3  | Existing sales are bound to wrong SKUs and must be re-pointed                                | **Partly holds; must be sized in production.**             | Lines reference `variant_id` (nullable, ON DELETE SET NULL) and snapshot `description`, never the SKU (`sales.ts:66-67`, `orders.ts:216,226`). POS accepts any variant id with no active check (`sales.controller.ts:689-712`; `orders.controller.ts:4501-4518`). STORIS `sale_line` import binds by `lower(sku)` against **every** variant incl. Shopify-created and inactive ones, last-wins (`import.service.ts:394-413, 1265-1273`); unknown SKU → `variant_id NULL`. A connector sync never writes lines (sale rows are header-only). `replaceCatalog` deactivates referenced products but never re-points lines (`import.service.ts:582-591`). **No remap tool exists** in the codebase. Lines left on a deactivated Shopify variant keep reserving/consuming stock and report under the wrong SKU. |

Corrections found by the verifiers (do not repeat these mistakes):

- The Helix duplicate groups seen 2026-09-02 came from **two file imports** plus Shopify cover/support variants (`SPRINT-STATUS.md:4382-4385`); which Shopify SKUs collide with STORIS `HEX…`/`HEBS…` SKUs is a production-data question.
- `products.description` is null for STORIS rows anyway (the file's DESCRIPTION column maps to `name`); what a sync destroys is name/category/price/barcode/cost/active flag.
- `SUM(inventory_movements.delta) = on_hand` is **not** an invariant today (POS clamps with `GREATEST(0, …)`, `sales.controller.ts:1104-1114`); use before/after diffs, not absolute checks.
- The Render Postgres `jetnine-db` (`dpg-da4ttsm417fc73di57eg-a`) is on plan `basic_256mb` (paid), region oregon, **ipAllowList empty** → no external connection is possible until the owner adds a rule. The "free Postgres expires 2026-09-21" note in SPRINT-STATUS is stale.

Two more facts that change the plan:

- `docs/imports/2026-09-03/inventory.csv` has **MIN_STOCK = 0 on all 3,246 rows** (verified). Loading it sets every reorder point to 0. With `ops.autoReplenishmentEnabled` on, the hourly job could draft POs for out-of-stock SKUs. Owner decision needed (see §6 Q3).
- Which business (tenant) the owner uses is unknown to the code. D11 says production is a fresh tenant; the docs only record the QA/staging tenant. Query Q1 below answers it and every later step is scoped to that `business_id`.

## 2. What must change in code (Phase B — one PR, feature branch, squash-merge)

Conventions: zod DTOs in `packages/shared`, permissions in `packages/shared/src/permissions.ts`
seeded into system roles (`roles.ts`), `@TenantScoped()` + `@RequirePermission`, audit-log
writes, outbound webhook on significant mutations, tests in `apps/api/test/*.int.spec.ts`,
migrations committed (CI drift check).

B0. **Docs first (CLAUDE.md rule).** Amend `PLAN-STORIS-CUTOVER.md` D11 (drop "re-run the
Shopify connector") and D12 (Shopify-synced prices no longer wanted → owner decides in Q2),
add A17 to `PLAN-POS-OPERATIONS.md` §12.12 ("catalog and inventory come only from the file
import; connector product sync is off; wrong-listing lines are remapped"), fix
`SPRINT-STATUS.md:1249-1251`.

B1. **Connector product sync off by default.** Per-tenant ops setting
`ops.connectorProductSync` (boolean, `nullMeans` = products are NOT synced) in
`apps/api/src/business/settings.controller.ts` (registry + `validateOps`, pattern of
`autoReplenishmentEnabled`), stored in `businesses.ops_settings_json` (no migration).
`runSyncJob` reads it via `rootDb`, skips `pull.entity === 'product'` and records
`skippedReason` in results + audit; `ConnectorContext.entities` so the product pages are not
even fetched. Also refuse `sync` when `status === 'error'` (today only `'disconnected'` is
refused). Web: note on the integrations card + toggle in Settings. Tests:
`apps/api/test/integrations.int.spec.ts` flips to `committed: 0` for products; new case
proves a pre-existing SKU keeps name/price/cost/active after a sync.

B2. **Import hardening (required before the production run).**

- `loadLookups` variant map: prefer **active** variants of active products, deterministic
  tie-break (active → STORIS-ref'd → newest), and report ambiguous `lower(sku)` groups in
  validation (`import.service.ts:394-413`). Without this the inventory and sale-line imports
  can bind to a deactivated Shopify variant.
- `commitProduct`: only touch `cost_cents`, `barcode`, `category_id` when the row carries
  them (same rule already used for price/vendor/reorder); do not force `is_active=true`
  when `batch.source` is a connector.
- `commit(replaceCatalog)`: refuse when `failed > 0` or `committed !== batch.rowCount`;
  **deactivate instead of hard-delete** any unreferenced product that still holds stock
  (`on_hand`, `reserved` or `floor_sample` ≠ 0) so no ledger history is cascaded away;
  persist `deletedSkus` / `deactivatedSkus` in the `import.commit` audit metadata.
- `physical_counts` guard: refuse replace/remap while any count is `open` or `counting`.

B3. **Variant remap endpoint** (`apps/api/src/catalog/`):
`POST /v1/products/variants/remap` body `{ pairs: [{fromVariantId, toVariantId}], dryRun?,
deactivateSource? }`, zod `variantRemapSchema` in `packages/shared`, new permission
`products.merge` (Owner + Manager). One RLS transaction. For each pair, re-point
`variant_id` in: `order_lines`, `sale_lines`, `refund_lines`, `order_return_lines`,
`service_order_lines` (no FK — must be listed by hand), `purchase_order_lines`,
`stock_transfer_lines`, `as_is_items.variant_id` + `restocked_variant_id`, `write_offs`,
`serial_units`, `physical_count_lines`, `cost_layers`, `inventory_movements`. Merge
`inventory_levels` into the target (unique `(variant_id, location_id)`,
`inventory.ts:81-84`): `reserved +=`, `floor_sample +=`; `on_hand` policy = STORIS file is
truth → write a correcting `inventory_movements` row (`reason 'adjustment'`,
`reference_type 'variant_remap'`) rather than adding. Delete the source level and its
`legacy_refs(entity='inventory')`, delete `legacy_refs(entity='product')` of the source
product (so no later import resurrects it), deactivate source variant/product. Guards:
same business, target active + STORIS-ref'd, no chains, abort on `serial_units
(business_id, variant_id, serial)` or `physical_count_lines (count_id, variant_id)`
collisions. Audit `product_variant.remap` per pair (before/after) + summary; webhook
`product.variant.remapped`. `dryRun` returns per-table counts and the before/after
reservation-drift delta. Tests: `apps/api/test/catalog-remap.int.spec.ts` (order line with
reservation, sale line, serial collision abort, dry-run no-op, idempotent re-run).

B4. **Crosswalk candidates** `GET /v1/products/remap-candidates`: inactive or non-file-import
products (provenance from `import_rows` + `import_batches.source`, not last-writer
`legacy_refs`) that still have document refs, paired with active STORIS products by
`lower(sku)` equality, then by brand + size token + model token. Review list only; the
owner signs off pairs (kept as `docs/imports/2026-09-03/remap.csv`).

B5. Small fixes: duplicates `documents` count includes `as_is_items`/`write_offs`; remove the
dead second `@Delete(':id')` in `products.controller.ts:729`; fix the `source` comment
("last writer", not "created it").

B6. Optional `mode: 'bindByLegacySku'` on the remap for imported sale lines with
`variant_id NULL` (legacy id `<invoice>#<sku>`), or simply re-run the `sale_line` CSV
**after** the remap and the second replace (owner decision Q4).

## 3. Production run order (Phase C — the egress session)

**Update 2026-09-10 — no API key and no egress session needed.** C4 and C5 now run as
Render one-off jobs dispatched by `.github/workflows/ops-catalog-import.yml`, which runs
`apps/api/src/ops/catalog-import.ts` inside the API service (DATABASE_URL is already
there). The script enforces the C4/C5 gates itself (0 invalid, valid = committed =
rowCount = `expect_rows`, replace kept = rowCount, connector sync not running) and
fails the run otherwise, leaving the batch for `GET /v1/import/batches/:id?rows=invalid`.
B2's commit-side hardening shipped with it: replace refuses while a physical count is
open or counting, is skipped when any row failed, retires (never deletes) a product that
still holds stock, and records `deletedSkus` / `deactivatedSkus` in the `import.commit`
audit row. The sequence is rehearsed on the real files in
`apps/api/test/catalog-import.int.spec.ts`. The original API-key procedure is kept below
for reference only.

Auth: create an API key in Settings → API keys (or `POST /v1/business/api-keys
{name, scopes:['import.run','integrations.manage','products.update','products.merge',
'products.view'], livemode:'live'}`, needs `api_keys.manage`). Send
`Authorization: Bearer jet_live_…` (`auth.guard.ts:52-74`; the tenant comes from the key).
Revoke it at the end. Do **not** run the production import through the browser wizard: the
Vercel → Render proxy times out before a 1,948-row replace commits; use direct calls with a
≥10-minute client timeout, and on a dropped connection re-read
`GET /v1/import/batches/:id?rows=none` before retrying.

Prerequisite **Ops (owner):**

- Add an IP allow rule on `jetnine-db` (Render dashboard → Access control) for the machine
  that will take the backup, and share the external connection string with that session
  only. Confirm Render backups are enabled on the `basic_256mb` plan; if not, take
  `pg_dump --format=custom` from an allow-listed machine before C4. Rollback = new DB →
  `pnpm --filter @jetnine/db migrate` (creates `app_user` + policies) → `pg_restore` →
  repoint `DATABASE_URL` → verify the boot line.
- Drain/clear the offline queue on every register before C4 (the POS caches variants in
  IndexedDB and replays queued sales with old variant ids).
- No physical count in `open`/`counting` at any location between C4 and C7.

| Step | Action                                                                                                                                                                                                                                                                                                                                                               | Gate                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| C0   | Confirm deploy: `GET /health`; Render boot line `Schema migrations: … head=0086_inventory_level_reorder_point` (+ Phase B migration if any); service plan not downgraded (`render.yaml` still says `plan: free`). Render auto-deploy is broken → `mcp__Render__trigger_deploy`.                                                                                      | boot line matches main                    |
| C1   | Size the problem: run Q1–Q12 (read-only) via the SQL runner the owner provides (allow-listed machine) or via the Phase B `remap-candidates` endpoint. Save outputs under `docs/imports/2026-09-03/prod-baseline/`. Stop if `integrations.sync_status = 'running'`.                                                                                                   | outputs saved                             |
| C2   | Backup (Ops, above).                                                                                                                                                                                                                                                                                                                                                 | backup verified                           |
| C3   | Disconnect connectors: `DELETE /v1/integrations/shopify` (+ any other row from Q2). After this, sync throws "not connected". Re-check `sync_status` after.                                                                                                                                                                                                           | `GET /v1/integrations` shows disconnected |
| C4   | Catalog: `POST /v1/import/batches {entity:'product', filename:'products.csv', csv}` → assert `unmappedRequired: []` → `POST …/validate {}` → **gate: `invalidRowCount = 0` and `validRowCount = rowCount = 1948`** → `POST …/commit {replaceCatalog:true}` → assert `failed 0`, `replaced.kept 1948`; record `replaced.deleted/deactivated` and the audit SKU lists. | counts match                              |
| C5   | Inventory: same sequence with `inventory.csv` as `inventory`; before commit read `validationJson.byMessage` for `unknown location` / ambiguous SKU; commit `{}`; `GET /v1/import/recon`. Then Q13.                                                                                                                                                                   | Q13 matches file                          |
| C6   | Crosswalk: `GET /v1/products/remap-candidates` + Q6/Q7 output → owner approves the pairs.                                                                                                                                                                                                                                                                            | signed `remap.csv`                        |
| C7   | `POST /v1/products/variants/remap {pairs, dryRun:true}` → review counts → real run → Q14 as a **before/after diff** vs C1 (no new reservation-drift rows, no document rows on old variants).                                                                                                                                                                         | diff clean                                |
| C8   | Optional (Q4): re-run `sale_line` CSVs to bind NULL-variant lines; re-run `products.csv` with `replaceCatalog:true` so the now-unreferenced Shopify products are removed (only after C7 — before it, the cascade would destroy their movement/cost history).                                                                                                         |                                           |
| C9   | Revoke the API key; dated note in `SPRINT-STATUS.md`; flag remaining Ops items.                                                                                                                                                                                                                                                                                      |                                           |

## 4. Production queries (read-only unless stated; `:biz` = the owner's business id)

Load the STORIS SKU list first: `CREATE TEMP TABLE storis_skus(sku text);` + `\copy` of
column SKU from `docs/imports/2026-09-03/products.csv`.

```sql
-- Q1 tenants (D11: production should be a fresh business; docs only record the QA tenant)
SELECT id, slug, name, status, created_at FROM businesses ORDER BY created_at;

-- Q2 connector state + every import batch that ever committed
SELECT provider, status, sync_status, sync_started_at, last_sync_at, config_json, last_result_json
FROM integrations WHERE business_id = :biz;
SELECT id, entity, source, filename, status, row_count, committed_row_count, committed_at
FROM import_batches WHERE business_id = :biz ORDER BY created_at;

-- Q3 product provenance from import_rows history (run BEFORE the replace; last-writer legacy_refs lie)
WITH hist AS (
  SELECT p.id, p.sku, p.name, p.is_active,
         bool_and(b.source IS NULL) AS app_only,
         bool_or(b.source IN ('shopify','woocommerce','wix')) AS ever_connector,
         bool_and(b.source IN ('shopify','woocommerce','wix')) AS connector_only
  FROM products p
  LEFT JOIN import_rows r ON r.jetnine_id = p.id AND r.status = 'committed' AND r.business_id = p.business_id
  LEFT JOIN import_batches b ON b.id = r.batch_id AND b.entity = 'product'
  WHERE p.business_id = :biz GROUP BY p.id)
SELECT CASE WHEN app_only THEN 'app/template/legacy-csv' WHEN connector_only THEN 'connector_only'
            WHEN ever_connector THEN 'connector+file' ELSE 'file_only' END AS provenance,
       is_active, count(*) FROM hist GROUP BY 1,2 ORDER BY 1,2;

-- Q4 empty-SKU fallback products created by connectors
SELECT id, sku, name, is_active, created_at FROM products
WHERE business_id = :biz AND sku ~ '^(shp|woo|wix)-' ORDER BY created_at;

-- Q5 STORIS SKUs a connector batch touched (overwrite set) with their current state
SELECT p.sku, p.name, v.price_cents, v.cost_cents, v.barcode, p.is_active
FROM products p JOIN product_variants v ON v.product_id = p.id AND v.sku = p.sku
WHERE p.business_id = :biz AND p.sku IN (SELECT sku FROM storis_skus)
  AND EXISTS (SELECT 1 FROM import_rows r JOIN import_batches b ON b.id = r.batch_id
              WHERE r.jetnine_id = p.id AND r.status = 'committed' AND b.entity = 'product'
                AND b.source IN ('shopify','woocommerce','wix'))
ORDER BY p.sku;

-- Q6 non-STORIS products: document load + stock (replace preview; crosswalk source list).
--    Rows with stock and zero document refs would be HARD-DELETED with their ledger by today's code.
SELECT p.id, p.sku, p.name, p.is_active,
  (SELECT count(*) FROM order_lines x JOIN product_variants v ON v.id = x.variant_id WHERE v.product_id = p.id) AS order_lines,
  (SELECT count(*) FROM sale_lines x JOIN product_variants v ON v.id = x.variant_id WHERE v.product_id = p.id) AS sale_lines,
  (SELECT count(*) FROM purchase_order_lines x JOIN product_variants v ON v.id = x.variant_id WHERE v.product_id = p.id) AS po_lines,
  (SELECT count(*) FROM stock_transfer_lines x JOIN product_variants v ON v.id = x.variant_id WHERE v.product_id = p.id) AS transfer_lines,
  (SELECT count(*) FROM as_is_items x JOIN product_variants v ON v.id = x.variant_id OR v.id = x.restocked_variant_id WHERE v.product_id = p.id) AS as_is,
  (SELECT count(*) FROM write_offs x JOIN product_variants v ON v.id = x.variant_id WHERE v.product_id = p.id) AS write_offs,
  (SELECT count(*) FROM serial_units x JOIN product_variants v ON v.id = x.variant_id WHERE v.product_id = p.id) AS serials,
  (SELECT count(*) FROM service_order_lines x JOIN product_variants v ON v.id = x.variant_id WHERE v.product_id = p.id) AS service_lines,
  (SELECT coalesce(sum(il.on_hand),0) FROM inventory_levels il JOIN product_variants v ON v.id = il.variant_id WHERE v.product_id = p.id) AS on_hand,
  (SELECT coalesce(sum(il.reserved),0) FROM inventory_levels il JOIN product_variants v ON v.id = il.variant_id WHERE v.product_id = p.id) AS reserved,
  (SELECT coalesce(sum(il.floor_sample),0) FROM inventory_levels il JOIN product_variants v ON v.id = il.variant_id WHERE v.product_id = p.id) AS floor_sample
FROM products p
WHERE p.business_id = :biz AND (p.sku IS NULL OR p.sku NOT IN (SELECT sku FROM storis_skus))
ORDER BY order_lines + sale_lines DESC, p.name;

-- Q7 crosswalk by case-insensitive SKU, and ambiguous lower(sku) groups (run BEFORE C4 too)
SELECT o.id AS old_variant_id, o.sku AS old_sku, n.id AS new_variant_id, n.sku AS new_sku
FROM product_variants o JOIN products op ON op.id = o.product_id
LEFT JOIN product_variants n ON n.business_id = o.business_id AND lower(n.sku) = lower(o.sku)
     AND n.id <> o.id AND n.sku IN (SELECT sku FROM storis_skus)
WHERE o.business_id = :biz AND (op.sku IS NULL OR op.sku NOT IN (SELECT sku FROM storis_skus));
SELECT lower(sku) AS k, count(*), array_agg(id) FROM product_variants
WHERE business_id = :biz AND sku IS NOT NULL GROUP BY 1 HAVING count(*) > 1;

-- Q8 sale/order lines bound to non-STORIS variants (the lines to re-point)
SELECT 'sale' AS doc, s.number, s.status, s.imported_at IS NOT NULL AS imported, sl.id AS line_id, sl.description, v.sku, p.name, p.is_active
FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
JOIN product_variants v ON v.id = sl.variant_id JOIN products p ON p.id = v.product_id
WHERE sl.business_id = :biz AND (p.sku IS NULL OR p.sku NOT IN (SELECT sku FROM storis_skus))
UNION ALL
SELECT 'order', o.number, o.status, o.imported_at IS NOT NULL, ol.id, ol.description, v.sku, p.name, p.is_active
FROM order_lines ol JOIN orders o ON o.id = ol.order_id
JOIN product_variants v ON v.id = ol.variant_id JOIN products p ON p.id = v.product_id
WHERE ol.business_id = :biz AND (p.sku IS NULL OR p.sku NOT IN (SELECT sku FROM storis_skus))
ORDER BY 1, 2;

-- Q9 imported sale lines with no variant, and how many would bind now
SELECT count(*) AS unbound,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM product_variants v WHERE v.business_id = sl.business_id
                        AND v.is_active AND lower(v.sku) = lower(split_part(r.legacy_id, '#', 2)))) AS now_resolvable
FROM sale_lines sl
LEFT JOIN legacy_refs r ON r.business_id = sl.business_id AND r.entity = 'sale_line' AND r.jetnine_id = sl.id
WHERE sl.business_id = :biz AND sl.variant_id IS NULL;

-- Q10 stock/reservations/cost layers held on non-STORIS variants (what the remap must merge)
SELECT v.sku, l.name AS location, il.on_hand, il.reserved, il.floor_sample,
  (SELECT coalesce(sum(k.quantity_remaining),0) FROM cost_layers k WHERE k.variant_id = il.variant_id AND k.location_id = il.location_id) AS layers_remaining
FROM inventory_levels il JOIN product_variants v ON v.id = il.variant_id JOIN products p ON p.id = v.product_id
JOIN locations l ON l.id = il.location_id
WHERE il.business_id = :biz AND (p.sku IS NULL OR p.sku NOT IN (SELECT sku FROM storis_skus))
  AND (il.on_hand <> 0 OR il.reserved <> 0 OR il.floor_sample <> 0) ORDER BY 1, 2;

-- Q11 remap collisions: duplicate serials across pairs; live physical counts holding non-STORIS variants
SELECT s.serial, s.variant_id AS old_variant, t.variant_id AS new_variant
FROM serial_units s JOIN product_variants o ON o.id = s.variant_id
JOIN product_variants n ON n.business_id = o.business_id AND lower(n.sku) = lower(o.sku) AND n.id <> o.id
JOIN serial_units t ON t.business_id = s.business_id AND t.variant_id = n.id AND t.serial = s.serial
WHERE s.business_id = :biz;
SELECT pc.id, pc.status, count(*) FROM physical_count_lines pl JOIN physical_counts pc ON pc.id = pl.count_id
JOIN product_variants v ON v.id = pl.variant_id JOIN products p ON p.id = v.product_id
WHERE pl.business_id = :biz AND pc.status IN ('open','counting')
  AND (p.sku IS NULL OR p.sku NOT IN (SELECT sku FROM storis_skus)) GROUP BY 1, 2;

-- Q12 baseline: locations (resolveLocation is fuzzy), catalog counts, stock per store, keep-imported history, ops settings
SELECT id, name, order_prefix, is_active FROM locations WHERE business_id = :biz ORDER BY name;
SELECT count(*) FILTER (WHERE is_active) AS active, count(*) AS total FROM products WHERE business_id = :biz;
SELECT l.name, count(*) AS levels, sum(il.on_hand) AS on_hand, sum(il.reserved) AS reserved
FROM inventory_levels il JOIN locations l ON l.id = il.location_id WHERE il.business_id = :biz GROUP BY 1 ORDER BY 1;
SELECT target_id, changes_json->'after'->>'keptSkus' AS kept, created_at FROM audit_logs
WHERE business_id = :biz AND action = 'product.update'
  AND changes_json->'after'->>'reason' = 'duplicate — kept the imported copy' ORDER BY created_at;
SELECT ops_settings_json FROM businesses WHERE id = :biz;
-- ledger vs on_hand baseline (NOT an invariant today; diff it after C7)
SELECT variant_id, location_id, sum(delta) - il.on_hand AS mismatch
FROM inventory_movements m JOIN inventory_levels il USING (variant_id, location_id)
WHERE m.business_id = :biz GROUP BY 1, 2, il.on_hand HAVING sum(delta) <> il.on_hand;

-- Q13 post-replace: active catalog = 1948, every active product has a legacy ref, stock per store, batch outcomes
SELECT count(*) FILTER (WHERE is_active) AS active, count(*) AS total FROM products WHERE business_id = :biz;
SELECT count(*) FROM products p WHERE p.business_id = :biz AND p.is_active
  AND NOT EXISTS (SELECT 1 FROM legacy_refs r WHERE r.entity = 'product' AND r.jetnine_id = p.id);
SELECT l.name, count(*) AS levels, sum(il.on_hand) AS on_hand, sum(il.reserved) AS reserved
FROM inventory_levels il JOIN locations l ON l.id = il.location_id JOIN product_variants v ON v.id = il.variant_id
WHERE il.business_id = :biz AND v.is_active GROUP BY 1 ORDER BY 1;
SELECT id, entity, status, row_count, valid_row_count, invalid_row_count, committed_row_count,
       validation_json->'byMessage' AS by_message, committed_at
FROM import_batches WHERE business_id = :biz ORDER BY created_at DESC LIMIT 2;

-- Q14 post-remap: no document/ledger row still on a remapped variant; drift diff vs Q12
WITH old AS (SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
             WHERE v.business_id = :biz AND NOT v.is_active AND (p.sku IS NULL OR p.sku NOT IN (SELECT sku FROM storis_skus)))
SELECT 'order_lines' t, count(*) FROM order_lines WHERE variant_id IN (SELECT id FROM old)
UNION ALL SELECT 'sale_lines', count(*) FROM sale_lines WHERE variant_id IN (SELECT id FROM old)
UNION ALL SELECT 'service_order_lines', count(*) FROM service_order_lines WHERE variant_id IN (SELECT id FROM old)
UNION ALL SELECT 'inventory_levels', count(*) FROM inventory_levels WHERE variant_id IN (SELECT id FROM old)
UNION ALL SELECT 'inventory_movements', count(*) FROM inventory_movements WHERE variant_id IN (SELECT id FROM old)
UNION ALL SELECT 'cost_layers', count(*) FROM cost_layers WHERE variant_id IN (SELECT id FROM old);
```

Expected file facts: `products.csv` 1,948 SKUs; `inventory.csv` 3,246 rows (Warehouse 1,875 ·
201 Western 405 · West LA 386 · Hancock Park 326 · Studio City 254), 570 rows with AS_IS > 0,
MIN_STOCK = 0 everywhere.

## 5. Risks the plan already accounts for

- Any future "Sync now" on a connected Shopify re-creates Shopify products and overwrites
  shared SKUs → C3 disconnect + B1 setting. Disconnect does not stop a running detached
  job; check `sync_status` before and after.
- Today's `replaceCatalog` hard-deletes unreferenced products **with their stock ledger**
  (no stock check, no per-product audit) → B2 deactivate-when-stocked + audit SKU lists,
  and Q6 preview before C4.
- `service_order_lines.variant_id` has no FK → invisible to the replace scan; the remap lists
  it by hand.
- Import lookups are last-wins over all variants incl. inactive → B2 active-first lookup
  must ship before C5.
- `POST /v1/dev/e2e-seed` is public but only registered when `NODE_ENV !== 'production'`;
  Render sets `NODE_ENV=production` — keep it that way. `pnpm db:seed` must never run
  against `DATABASE_URL`.
- API-only creation paths (`/v1/products/:id/variants`, `/v1/products/import/commit`) stay
  live for any key with `products.update/create`; keep API-key scopes minimal.
- Shopify-set prices survive the replace (D12) — Q2 decision.

## 6. Owner decisions needed before execution

- **Q1 Tenant.** Which business is the live one (name/slug from Q1)? If it is the QA tenant
  from the docs, say so; the plan then runs there.
- ~~**Q2 Prices.**~~ Answered 2026-09-06: **do not keep them** — reset to $0 (shipped as the
  cleanup page's "Reset prices"; D12 pricing at the register / `/products/pricing`). Same
  day: **do not keep stock on Shopify listings** — cleared when a listing retires.
- **Q3 Min stock.** The export has MIN_STOCK 0 for every SKU. Load zeros (reorder points
  cleared; keep auto-replenishment off until you set them), or leave existing reorder
  points untouched (I drop the column from the file)?
- **Q4 Unbound imported sale lines.** Bind them now by re-running the STORIS sale-line CSVs
  after the remap, or leave history as description-only lines?
- **Q5 Crosswalk.** You sign off the Shopify → STORIS pairs the candidates endpoint
  proposes (a CSV you can edit) before the remap runs.
- **Q6 Backup.** Who takes the backup and adds the DB allow-list rule (Ops), or do we rely
  on Render's plan backups?

## 7. Session plan once approved

1. This session: Phase B PR (B0–B5, tests, migration if any), CI green, squash-merge,
   deploy to Render (`trigger_deploy`), verify boot line.
2. Egress session: Phase C in the order above, pausing at C6 for the crosswalk sign-off.
3. Both: dated notes in `SPRINT-STATUS.md`, Ops items flagged.
