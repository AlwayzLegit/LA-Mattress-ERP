# Sprint Status — STORIS Cutover

> **Living tracker for `PLAN-STORIS-CUTOVER.md`.** Protocol: pick the first unchecked
> **Build** item, ship it as a vertical slice, check it off with a dated note, commit the
> tracker with the work. **Ops** items are the human's — surface them, don't do them.
> Slip policy and never-cut list live in the plan §8.

**Sprint state:** Build track COMPLETE through Day 9 + UI overhaul + integrations + five post-checkpoint batches — checkpoint 5 merged to main 2026-08-25 (PR #29, squash `138ba82`) and live on staging (`596b8d4`). Remaining build items (rehearsal #2 = sales history + customers from the STORIS invoice register, Day 10 final import) are blocked on that export; all other unchecked items are **Ops**. Old stores 06/08/09 are out of migration scope (final). · **Rehearsal imports done:** 1/2 (products + inventory, real data, PASS) · **Recon gates passed:** gates 1–2 on the real product/inventory export; 3–5 need the invoice/customer export

---

## Day 1 — Order spine + extraction kickoff

- [x] **Build:** Schema batch 1: `orders`, `order_lines`, `deliveries`, `delivery_lines`,
      payments generalization (nullable `sale_id`, add `order_id`, `kind`, financing fields,
      CHECK exactly-one), `legacy_refs`, staging tables — with RLS + generated migration
      — _2026-08-22: `packages/db/src/schema/orders.ts` + `migration.ts`, migration
      `0018_storis_order_spine`, 7 new tables in `TENANT_SCOPED_TABLES` + `rls.sql`._
- [x] **Build:** `orders` NestJS module: CRUD, lines, totals (reuse `sales/totals.ts` pattern),
      deposit/balance payments, stock reserve/release via `inventory_levels.reserved` +
      movements (`order_reserve`/`order_release`), cancel; unit tests for totals + reserve math
      — _2026-08-22: `apps/api/src/orders/` (controller + service + `order-math.ts`);
      34 unit tests, 22 integration tests._
- [x] **Build:** Permission catalog additions (plan §5) seeded into system roles
      — _2026-08-22: 27 permissions added; `SUPER_ADMIN_ONLY_PERMISSIONS` keeps the two
      platform perms out of every business role, Owner included._
- [ ] **Ops:** Kick off every STORIS export (checklist: `docs/STORIS-EXPORTS.md`) — subscription still active
- [ ] **Ops:** Order Stripe Terminal readers / confirm interim standalone terminal

_Acceptance: migration applies cleanly from empty DB; API can create an order, take a
deposit, and reserved stock shows in inventory; drift check green._ **✅ met** — verified
against a scratch Postgres 16: reset → migrate applies `0018` from empty, the integration
suite writes an order, takes a deposit, and asserts `inventory_levels.reserved` moved while
`on_hand` did not; `drizzle-kit generate` reports no drift.

## Day 2 — Order writer

- [x] **Build:** `(business)/orders` — pipeline board (quote→open→partially*fulfilled→fulfilled→completed), order writer screen (share cart components with POS), order detail with payments + timeline
      — \_2026-08-22: board + writer + detail under `(business)/orders/`; CustomerPicker
      extracted to `components/customer-picker.tsx` and shared with POS; audit-logs API
      gained targetType/targetId filters to feed the order timeline.*
- [x] **Build:** POS: "Save as order / take deposit" flow
      — _2026-08-22: SaveAsOrderDialog on the register — confirms the order (committing
      stock) and posts the deposit as an order payment in one step._
- [x] **Build:** Committed-stock visibility in inventory views
      — _2026-08-22: already satisfied — inventory levels API + page carried
      on-hand/reserved/available since Phase 2; Day 1 reservations feed `reserved`.
      Verified in `e2e/orders.spec.ts`._
- [ ] **Ops:** Chase exports; write the STORIS daily-routine script (becomes the QA script)

_Acceptance: write an order with deposit end-to-end in the browser; committed qty visible._
**✅ met** — `apps/web/e2e/orders.spec.ts`: writer → confirm → cash deposit →
reserved=1/available=99 in inventory → order on the board; plus the POS
save-as-order path with the suggested 25% deposit. 2 e2e tests green.

## Day 3 — Delivery & fulfillment

- [x] **Build:** `deliveries` module + calendar UI (week/day), drag-to-schedule, driver day-sheet (print)
      — _2026-08-23: `apps/api/src/deliveries/` + `(business)/deliveries` (week board with
      drag-to-reschedule, delivery page with driver verbs, printable day-sheet at
      `/deliveries/day/[date]`)._
- [x] **Build:** Fulfillment flow: decrement stock, serial pick (stub until Day 4), collect balance, order receipt print; completion requires balance = 0 or `orders.complete_with_balance`
      — _2026-08-23: `planFulfillment`/`applyFulfillment` (`order_fulfill` movements,
      negative delta, reservation consumed), pickup path `POST /orders/:id/fulfill`,
      `POST /orders/:id/complete` gated on balance/permission. Serial pick + receipt
      print carried to the serials slice._
- [x] **Build:** Reports union `sales` + `orders` (revenue, drawer picks up order payments)
      — _2026-08-23: shift close and the daily report count order deposits/balances by the
      payment's own timestamp (imported excluded per D8); tender mix merges both;
      `orderPaymentsByDay` added to the daily report. Int test proves a mid-shift deposit
      lands in `expectedCashCents`._
- [ ] **Ops:** First export files land — joint sanity read; freeze SKU/category cleanup decisions

_Acceptance: schedule → deliver → collect balance → order completed; day's drawer includes deposits._
**✅ met** — `deliveries.int.spec.ts` (12 tests) walks the whole cycle API-side including the
drawer; `e2e/orders.spec.ts` drives it in the browser: schedule from the order page →
calendar card → delivered → fulfilled → collect → completed.

## Day 4 — Special orders & serials

- [x] **Build:** `po_line_allocations`; to-order queue; generate/link POs by vendor; receiving auto-allocates, marks lines arrived, emails customer (Resend)
      — _2026-08-23: migration `0019_special_orders_serials`; `special-orders` module
      (queue API + UI at `(business)/special-orders`, generate-PO with cost fallback);
      PO receive walks allocations, reserves arrived units for the waiting customer,
      splits partial receipts, and sends the arrival email (memory transport until a
      Resend key is configured; imported orders stay silent per D8)._
- [x] **Build:** `serial_units` + `products.serial_tracked`; serial picker in fulfillment
      — _2026-08-23: register at the dock (`POST /v1/serials/register`), pick per line
      (`POST /v1/serials/assign/:orderLineId`, over-pick guarded), fulfillment marks
      committed serials sold with the customer stamped. API-level for now; picker UI
      rides with the UI overhaul._
- [ ] **Ops:** Verify sample POs/special orders against STORIS screens

_Acceptance: sell not-in-stock item → PO generated → receive → arrival email → deliverable._
**✅ met** — `special-orders.int.spec.ts` (5 tests): special-order line reserves nothing →
queue shows it with the customer → generate-PO allocates all units at recorded cost →
receive commits stock to the customer (on-hand 2 / reserved 2) and the captured arrival
email names the order → serials register/assign/sold with customer stamped.

## Day 5 — Money features

- [x] **Build:** Financing tender (`method='financing'`, provider + ref) in POS + order payments
      — _2026-08-23: POS tender set widened to financing/external_card/check with
      provider+ref recorded on the payment row; order payments carried these since Day 1._
- [x] **Build:** `payment_plans` + installments; pay-installment flow; nightly overdue job + reminder emails; overdue report
      — _2026-08-23: migration `0020_money_plans_commissions`; plans generate installments
      that sum to the balance exactly (remainder on the last); paying one posts an order
      payment `kind='installment'` so drawer/balance math just works; overdue sweep
      (`POST /v1/payment-plans/run-overdue`, idempotent, reminder emails) + overdue
      report. Nightly scheduling wired in the deploy-hardening slice._
- [x] **Build:** Commissions (plans, accrual at sale/order completion, refund reversal, report, approve/mark-paid)
      — _2026-08-23: `commission_plans` (percent_of_sale | percent_of_margin, bps) assigned
      per membership; accrual at POS-sale completion and order completion (split via
      `split_bps`); refunds write proportional negative entries; period report
      (view_own vs view_all) + approve→paid payroll actions. Imported docs never accrue
      (D8; `sales.imported_at` added in 0021)._
- [ ] **Ops:** Provide real commission rules + financing provider list; validate 5 historical examples

_Acceptance: layaway order pays off across installments; commission entries match hand math._

## Day 6 — Service & CRM

- [x] **Build:** Service orders: intake form, status board, ticket detail + charges + notes, complete; ticket print
      — _2026-08-23 (API-level): migration `0022_service_crm` — `service_orders`
      (SV-YYYY-NNNNNN, warranty flag, imported_at/legacy_number for D7/D8),
      `service_order_lines` (part-from-variant or free-text labor; warranty prices
      lines at 0), `service_order_notes`. `payments.service_order_id` added and the
      one-tender CHECK widened to `num_nonnulls(sale_id, order_id, service_order_id) = 1`
      (D2 holds: one payments table behind every tender). Lifecycle
      intake ↔ awaiting_parts ↔ in_service → ready → completed with auto status notes,
      customer "ready for pickup" email at ready, over-collect guard, complete requires
      zero balance, attached serial units walk in_service → sold. 8-test int spec
      (`jetnine_service` DB) green; UI pages ride the QA/design pass with the other screens._
- [x] **Build:** CRM: `customer_notes`, tags, customer timeline page (merged feed)
      — _2026-08-23: notes CRUD, tags (unique per business, attach/detach), and
      `GET /v1/customers/:id/timeline` — a read-model merge of sales, orders,
      deliveries, order payments, service tickets, and notes, newest first. No event
      table; the documents are the history._
- [x] **Build:** Receivables/AR report + customer statement print
      — _2026-08-23: `GET /v1/reports/ar` (permission `reports.financial.view`) —
      confirmed+ orders with balance due, aged 0-30/31-60/61-90/90+ by order date,
      rolled up per customer. Statement print rides the UI pass._
- [ ] **Ops:** Walk the service workflow; list any STORIS report not yet covered

## Day 7 — Migration rehearsal #1

- [x] **Build:** Import pipeline: upload → staging → mapping config → validation report → commit via `legacy_refs` upserts → recon report (gates 1–5, plan §7)
      — _2026-08-23: `/v1/import/*` — 7 entity importers (customers, vendors,
      products+variants+categories, inventory on-hand w/ audit movements, open-order
      headers + deposit payments, order lines, closed-sales history), STORIS-shaped
      auto-mapping (editable per batch), RFC-4180 CSV parser, money/date/bool coercion,
      validation report (missing FKs, bad money, dup legacy ids, unknown SKUs — first
      200 rows + message rollup), commit as `legacy_refs` upserts (D7 — every re-run
      updates in place; inventory re-runs write no ledger noise), everything imported
      flagged `imported_at` (D8). Recon gates 1–4 computed source-vs-DB to the cent at
      `GET /v1/import/recon`; gate 5 stays human. Wizard UI at
      `(business)/settings/import` (upload → map → validate → commit → recon panel).
      9-test int spec (`jetnine_import` DB) wired into CI; JSON body limit raised to
      25 MB for CSV upload._
- [x] **Build:** Full rehearsal import into throwaway `migration-rehearsal` tenant
      — _2026-08-23: the synthetic rehearsal (fixtures shaped like STORIS report-writer
      exports) runs end-to-end in `apps/api/test/import.int.spec.ts` with all recon
      gates matching. **2026-08-25: done on real data** —
      `apps/api/test/rehearsal.storis.int.spec.ts` drove the real inventory export
      (products 6,909 · inventory 1,505 · 3,738 units) through the full pipeline on a
      throwaway DB, all gates + idempotent re-run PASS (see Log); the owner then ran the
      same two CSVs through the staging wizard (server-side verification pending the
      Render connector). Scope so far: products + inventory; customers/invoices ride
      rehearsal #2. **Export files stay out of the repo.**_
- [ ] **Ops:** Review recon report line-by-line vs STORIS reports; log every mismatch

## Day 8 — Rehearsal #2 + platform layer

- [ ] **Build:** Fix import mismatches → rehearsal #2
      — _2026-08-25: rehearsal #1 surfaced no mismatches to fix. #2's scope is the
      remaining entities: sales history + customers derived from the STORIS invoice
      register (blocked on the export — CSV/Excel preferred, oversized PDF still
      undelivered). Location question CLOSED: owner ruled codes 06/08/09 are old
      stores — their stock (135 rows / 308 units, all at code 8; 06/09 held nothing)
      is dropped from the migration, holdout file discarded. Side effect: ~25 `-AS`
      clearance products whose as-is units existed only at code 8 are now stockless
      in the catalog — harmless, they simply never get counts._
- [x] **Build:** `business_templates` (snapshot/apply + super-admin UI); `agencies` tier (D9, additive) + agency console basics; white-label branding + subdomain middleware
      — _2026-08-23: templates shipped (0023; snapshot captures custom roles,
      category tree, tax classes, settings, opt-in catalog; apply is additive and
      idempotent; create-business accepts templateId; super-admin UI at
      /admin/templates). **Agencies + white-label deliberately cut** per the slip
      policy (P2/P3) — single-tenant cutover needs neither; revisit post-go-live._
- [x] **Build:** Deploy hardening (D10): always-on API instance, DB backups/PITR, Sentry alerts verified
      — _2026-08-23 (build side): nightly overdue sweep scheduler in-process
      (OVERDUE_SWEEP_UTC_HOUR); SUPER_ADMIN_EMAILS startup bootstrap so the
      platform console needs no manual DB pokes; CORS/auth accept wildcard
      Vercel preview origins; Sentry wired since Phase 2 (instrument.ts).
      **Always-on instance + DB plan upgrade remain Ops** (free Postgres expires
      2026-09-21 — flagged)._
- [ ] **Ops:** Recon #2 sign-off; choose hosting plan; DNS if subdomains now

## Day 9 — QA + parallel run

- [x] **Build:** Playwright e2e: POS sale · order+deposit+delivery+balance · special-order→PO→receive · layaway installment · service ticket · refund
      — _2026-08-23: `apps/web/e2e/sweep.spec.ts` covers POS cash sale + refund,
      layaway plan + installment, service ticket end-to-end, and special-order →
      PO → receive → arrival email; order+deposit+delivery+balance already lived
      in `orders.spec.ts`. Full Playwright suite green locally. Service and
      payment-plan UI built as part of this pass (service board + ticket detail,
      layaway card on order detail)._
- [x] **Build:** Bug burn-down; marketing basics (campaign send, one automation) only if green
      — _2026-08-23: the sweep flushed out three real bugs, all fixed:
      (1) **cross-tenant read leak** — handlers queried the root pool so RLS
      never applied; DRIZZLE is now a per-request proxy onto the RLS
      transaction, with a regression test; (2) onboarding checklist double-sent
      its response, 500-ing conditional requests and looping the dashboard;
      (3) sign-in rate limiting tripped the growing e2e suite (explicit opt-out
      env for test servers). Marketing basics not started (cuttable)._
- [ ] **Ops:** Parallel run — replay today's real STORIS transactions; compare Z-report, drawer, commissions

## Day 10 — Cutover

- [ ] **Build:** Final delta import into production tenant; recon gates 1–5 to the cent; fix-forward only
- [ ] **Ops:** Staff dry-run on real hardware; full STORIS archive to cold storage (R2); go/no-go
- [ ] **Ops:** Cancel STORIS 🎉 (only after the gate passes — never before)

---

## Log

_(newest first — sessions append: date · day · what shipped · open flags)_

- 2026-08-23 · Beyond-plan · **One-click platform integrations.** `integrations`
  table (0024) + connector framework: Shopify (Admin API token), WooCommerce
  (REST key/secret), Wix Stores (API key) — connect verifies credentials against
  the platform before storing; "Sync now" pulls customers/products/paid order
  history and lands it through the D7 import pipeline (per-provider legacy-id
  prefixes keep identity spaces separate; re-sync updates in place; synced sales
  are D8 imported history). UI at /settings/integrations with the STORIS CSV
  wizard as a sibling card. `integrations.manage` permission + a boot-time
  system-role permission sync so pre-existing businesses pick up new catalog
  permissions automatically. 6-test int spec against a fake Shopify
  (`jetnine_integrations` DB, in CI). Suite: 374 tests.
- 2026-08-23 · Days 3–9 in sequence · **Whole remaining build track shipped on PR #26.**
  Deliveries/fulfillment · special orders + serials · financing/layaway/commissions ·
  service/CRM/AR · import pipeline + wizard + recon gates · business templates +
  nightly scheduler + super-admin bootstrap · service & layaway UI · Day-9 e2e sweep.
  Critical fix: **cross-tenant RLS enforcement** (handlers ran on the root pool; now
  proxied onto the request's RLS transaction) + checklist double-send 500 + e2e rate
  limiting. Staging: Render API deploys the PR branch merge (migrations 0019–0023 run
  on boot); trusted origins accept Vercel previews (wildcard); SUPER_ADMIN_EMAILS
  grants the owner the /admin console. Open flags: real STORIS exports (rehearsals),
  commission rules + financing providers, paid Render plan before 2026-09-21,
  agencies/white-label + marketing cut per slip policy. UI/UX design-system overhaul
  in flight (sidebar shell + tokens landed; page conversion following).

- 2026-08-22 · Day 1 · **Build track shipped.** Schema batch 1 (7 tables + payments
  generalization per D2) with RLS and migration `0018_storis_order_spine`; the `orders`
  module (write → price → commit stock → take money → cancel) with `order-math.ts` as the
  pure, tested core; 27 new permissions seeded into system roles.
  · **Open flags:** (1) both **Ops** items are untouched and are the sprint's critical
  path — the STORIS exports (plan §7) and the Stripe Terminal readers both need to start
  today; the export especially, since the subscription is still live and every day it
  slips, the whole sprint slips. (2) Cash drawer and tender-mix reports still join
  `payments → sales`, so order deposits do not reach them — noted on the Day 3 item.
  (3) `orders/:id/complete` is deliberately **not** built: completion is a fulfillment
  event and lands with `deliveries` on Day 3. The `orders.complete_with_balance`
  permission is seeded and waiting for it. (4) Two plan clarifications made and written
  back into `PLAN-STORIS-CUTOVER.md` §4.1/§4.7: `split_bps` instead of `split_pct` plus a
  separate `order_discount_cents`, and importer staging as public-schema
  `import_batches`/`import_rows` rather than a `staging` Postgres schema.
  · **Env note:** every `*.int.spec.ts` fails in the sandbox on a Node/vitest interaction
  with the `Function('return import(s)')` ESM shim (`apps/api/src/utils/import-esm.ts`) —
  pre-existing and unrelated to this work; reproduced on a bare test with no repo code.
  The orders suite was verified 22/22 by bypassing that shim locally; the shim itself is
  unchanged in the commit.
- 2026-08-22 · pre-sprint · Plan + handoff docs written (`PLAN-STORIS-CUTOVER.md`, `CLAUDE.md`, this tracker). Sprint not started.

- **2026-08-24 — Post-checkpoint slice 1 (reports parity):** `/v1/reports/z` (daily
  close-out: gross/refunds/net, tender mix across sale+order+service money, drawer
  variances; D8-excluded), `/v1/reports/sales/by-category`, `/v1/reports/inventory/valuation`
  (financial-gated, cost+retail), `/v1/reports/tax/summary` (net-sales caveat documented) —
  all with CSV export; reports hub UI gained Z-report, category, tax, valuation cards.
  reports.int.spec.ts 9→14 tests incl. refund-day Z math.
- **2026-08-24 — Post-checkpoint slice 2 (printing):** dependency-free Code 128B SVG
  encoder (`apps/web/src/lib/code128.ts`, 5 unit tests incl. checksum math); barcode
  label sheets at `(business)/products/labels` (Avery 5160 30-up + 2.25×1.25" roll,
  copy counts, print-only CSS grid); receipts now print a scannable document-number
  barcode for returns.
- **2026-08-24 — Post-checkpoint slice 3 (white-label + agency):** `businesses.branding_json`
  (migration `0025_business_branding`: accentColor/logoUrl/publicName, merge-PATCH with
  validation) re-themes the whole app per tenant (`--brand` override + shell logo/name +
  receipt display name); `GET /v1/agency/overview` (auth/me pattern, membership-scoped,
  money nulled where the caller's role lacks reports.sales.view) + `(business)/agency`
  roll-up cards; topbar badge became a one-click business switcher. business.int.spec.ts
  14→20 tests.
- **2026-08-24 — Post-checkpoint slice 4 (marketing):** `customer_segments` + `campaigns`
  (migration `0026_marketing`, RLS'd); `/v1/marketing/*` behind existing
  `crm.campaigns.manage` — segments are stored filters over CRM tags resolved at
  preview/send (email-holders only; imported customers included — D8 covers money flows,
  not outreach), campaigns are one-shot (marked sent before the send loop so a crash
  can't double-blast), `campaign.sent` webhook event; Marketing page in the People nav.
  marketing.int.spec.ts (8 tests) + MARKETING_TEST_DATABASE_URL in CI.
- **2026-08-24 — Post-checkpoint slice 5 (dashboard analytics):** `/dashboard` moved into
  the (business) shell (same URL) and rebuilt as the analytics home — today's KPI row
  from the Z-report, 30-day revenue trend (inline SVG line, crosshair tooltip, sr-only
  table; palette validated), receivables + open orders + low-stock cards, each hiding
  itself when the role lacks the report permission. Also fixed the auth.spec CI flake:
  a business-less user's /dashboard → /welcome redirect detached the Sign out button
  mid-click; /welcome now carries its own Sign out and the test waits for the redirect.
  Full local e2e 9/9 green.
- **2026-08-24 — Post-checkpoint slice 6 (reorder automation):** `product_variants` gained
  `reorder_point`/`reorder_qty`/`preferred_vendor_id` (migration `0027_reorder_points`);
  `GET /v1/purchase-orders/reorder-suggestions` groups shortfalls (available ≤ point,
  all-location sum) by preferred vendor with suggested qty (explicit qty, else top-up to
  2× point); one-click "Draft PO" per vendor group on the Purchasing page; per-variant
  Reorder automation card on product detail. purchasing.int.spec.ts 11→16 tests.
- **2026-08-24 — Post-checkpoint slice 7 (customer status link):** `orders.public_token`
  (migration `0028_order_public_token`, unique); `POST /v1/orders/:id/share` (idempotent,
  audited) + public no-auth `GET /v1/public/orders/:token` serving a narrow projection
  (journey status, lines, paid/balance, branding accent — no address/notes/ids); branded
  customer page at `/track/[token]` with a 4-stage journey rail; "Share status link"
  button on order detail copies the URL. orders.int.spec.ts 22→25 tests.
- **2026-08-24 — Post-checkpoint slice 8 (commission statements):** `GET
/v1/commissions/statement?period&membershipId` (own by default; others behind
  `commissions.view_all`; entries carry source document numbers; totals split
  accruals/reversals and pending/approved/paid) + the first Commissions page
  (Insights nav): monthly by-associate summary, printable per-associate statement,
  approve/mark-paid payroll actions. money.int.spec.ts 9→12 tests.
- **2026-08-24 — Post-checkpoint review fixes (self code-review of PR #27, 10 findings):**
  campaign sent-flip moved to the root pool so it commits before the mail loop (the RLS
  tx would have rolled it back on a crash → double-blast); Z-report tender mix now joins
  service_orders (location filter dropped every service payment; D8 exclusion now applies);
  public tracking shows only the next ACTIVE delivery; share-token write is race-guarded
  (WHERE public_token IS NULL); statement totals aggregate in SQL over all entries (not a
  truncated page) + entriesTruncated flag; segment tag filter is a subquery (no 65k-param
  blowup) and sinceDays capped at 3650; valuation rows/CSV/UI carry the location; dashboard
  reuses readActiveBusinessId; agency dead code removed.
- **2026-08-24 — Browser-agent QA triage (14-flow staging run: 12 pass / 1 fail / 1 skip):**
  fixes pushed to PR #27 for every finding. CSV exports no longer use `<a href>`
  navigations (they 503'd through the proxy and failed silently) — all six report
  export buttons download via in-page fetch → blob (`lib/download.ts`) with busy state
  and an error toast. Vendors page existed but was unreachable: added Vendors to the
  Catalog nav plus create-vendor links from the New PO empty dropdown and the reorder
  "no preferred vendor" hint. POS now surfaces cash change: the payment forms pass
  `changeDueCents` up, the Sale complete screen shows a "Change due" banner + totals
  row, and the printed receipt gets a Change line (server still stores applied cash
  only — change exists client-side by design). Campaign send confirm is an inline
  arm/confirm step instead of a native `confirm()`. Public tracking advances to
  "Ready / scheduled" as soon as a delivery/pickup date is booked. Z-report tenders
  table shows a negative "refunds (all tenders)" row + reconciliation note — refunds
  carry no tender method column, so per-method attribution is deferred (design
  decision if drawer-level attribution is ever needed). Delivery calendar chips show
  the customer's city. Logged-out shell flash fixed earlier the same day (AuthGate,
  fail-open for offline POS). Earlier: Shopify/Woo/Wix connect dialog defaults its
  landing location to a Warehouse-named location and explains the choice. Remaining
  from the run: flow 14 (permissions) untested — needs a second non-owner login.
- **2026-08-24 — Vendor SKU mapping (post-QA batch 2):** `product_variants.vendor_sku`
  (migration `0029_variant_vendor_sku`) holds the vendor's part number when it differs
  from our selling SKU (the exact discrepancy Shopify-synced catalogs create). PATCH
  `variants/:id/reorder` accepts/validates/audits it; reorder suggestions and PO detail
  lines return it; purchasing UIs print the vendor SKU with an "ours: …" hint when the
  two differ; Reorder automation card gains a Vendor SKU field. Shopify sync keeps
  filling the selling SKU only — vendor part numbers stay merchant-entered.
  purchasing.int.spec.ts 16→17 tests. Also verified in Render logs: the first real
  Shopify sync succeeded server-side (201 in ~7.3 min) — the browser toast errors
  because proxies cut the response at ~100s. Follow-up queued: make provider sync a
  background job with progress polling.
- **2026-08-24 — Real STORIS inventory export received + import-pipeline enrichment:**
  first real export analyzed (14,247 rows / 6,357 SKUs / 12 locations, clean — no dupes
  or cost conflicts; file kept OUT of the repo). Product import now understands the
  STORIS columns directly: `REPLACE_COST` as cost, `VENDOR_MODEL_NUMBER` → variant
  vendor_sku, `VENDOR` → find-or-create vendor + preferred vendor, `MIN_STOCK` →
  reorder point (all only-when-present, so re-imports never wipe merchant edits).
  import.int.spec.ts 9→10 tests. Pipeline-ready CSVs staged outside the repo.
  **Blocked on (Ops):** (1) a retail-price export (SKU → selling price) — the inventory
  report has cost only and product import requires price; (2) the location code → store
  name mapping (codes 1–12 and 88); (3) decision on 1,180 as-is units (import as
  on-hand, separate as-is SKUs, or skip).

- **2026-08-25 — Browser QA pass 3 (checkpoint 5): triage + fixes.** Agent ran 7 flows on the
  Vercel **branch preview** (not the canonical host — note for next pass) against the staging
  tenant. Flows 1–2 (CSV upload + mapping guard) PASS; flow 6 (background Shopify sync) PASS
  end-to-end (~8 min, 12,042 customers / 1,805 products / 2,652 sales, live progress line,
  no false timeout — the checkpoint-4 fix holding). **Headline finding: the owner's staging
  INVENTORY import evidently never committed.** The tenant's locations are
  "Glendale Store / Koreatown Store ×4 / La Brea Store / Studio City Store / West LA Store" —
  no `Warehouse`, and none matching the CSV's STORIS names — so inventory validation fails
  `unknown location` (QA reproduced it: 0 valid / 1 invalid on a Warehouse row; substituting
  an existing location name → 1 valid, committed, stock visible). STORIS products DID land
  (SAM-18002 family, 254 reorder rows across 14 vendor groups) but stock is zero at every
  location. The owner-reported "1,505/1,505 · 3,738 units" recon is therefore **contradicted**
  for inventory — likely staged-row counts read as committed. Flow 5 (vendor PO print)
  reclassified from "API not live" to **data gap**: checkpoint-4 API was live before the test
  (18:12Z), and the template renders vendor contact / ship-to / `ref` sub-line conditionally —
  all 50 auto-created vendors have no contact data, the PO has no location, and that line's
  variant has no vendorSku. Toast-never-dismisses finding is most likely a harness artifact
  (sonner pauses its dismiss timer while the page is hidden/unfocused, which CDP-driven
  browsers often are) — re-verify by hand.
- **2026-08-25 — QA pass-3 fixes shipped:** (1) Commit now disabled when validation yields
  0 valid rows (CsvImport + wizard), with a hint that commit imports valid rows only —
  closes the missing-guard finding; (2) inactive locations filtered out of the Inventory and
  Receive pickers (`/v1/pos/locations` consumers were already active-only); (3) location
  timezone is validated as a real IANA name on create/update (the literal `\` timezone can
  no longer be saved) and defaults are now `America/Los_Angeles` (form + seed);
  business.int.spec 21/22 → +1 test; (4) contrast sweep: `--text-muted` #9ca3af → #6b7280
  (AA on white/#f9fafb/green tint — fixes table headers, KPI labels, helper text, empty
  states, checklist), placeholders split to `--text-faint`, sidebar section headers
  white/35 → white/60, disabled buttons opacity 0.5 → 0.6 (exempt but kinder), sonner
  success-toast vars overridden to AA, PO print sub-line #777/10px → #555/10.5px. Lint,
  typecheck, web unit, business int green.
- **Ops (from QA pass 3, in order):** (1) **Fix staging locations, then re-run the
  inventory import** — rename/create so the five STORIS names exist exactly
  (`Warehouse`, `Koreatown`, `West LA`, `La Brea`, `Studio City`), deactivate the three
  dead Koreatown duplicates (after the fix they disappear from pickers), fix the `\`
  timezone via edit (now validated), then re-run the same inventory CSV through the wizard
  (idempotent, D7) and read the recon report — that closes the 3,738-unit verification for
  real. (2) Decide whether Shopify's "Glendale Store" mapping and STORIS's location set
  should be reconciled into one list before cutover (D11 makes production a fresh start
  either way). (3) Point the next QA pass at the canonical web host, not the branch
  preview. (4) Vendor contact/email/phone are empty for all 50 auto-created vendors —
  fill in the ones that receive POs so the printable PO's vendor block populates.

- **2026-08-25 — Staging location fix EXECUTED + inventory import LANDED + recon VERIFIED
  server-side (owner-authorized API session).** With the owner's credentials (supplied for
  this run), the fix ran against staging over HTTPS: active `* Store` locations renamed to
  the STORIS names (`Koreatown`, `West LA`, `La Brea`, `Studio City`), `Warehouse` created,
  every timezone set to `America/Los_Angeles` (including the literal `\` one), the three
  duplicate Koreatown records left inactive, `Glendale Store` untouched (Shopify's
  location). The batch list confirmed the diagnosis exactly: `storis_inventory.csv` sat
  `validated` at **0 valid / 1,505 invalid / 0 committed** (products were committed
  6,909/6,909). Re-validate of the same staged batch after the fix: **1,505 valid /
  0 invalid**; commit: **1,505/1,505** (32s). `GET /v1/import/recon`: gate 1 all entities
  match (product 8,684 = STORIS ∪ Shopify ∪ QA, inventory 1,506 = 1,505 + QA row); gate 2
  units **3,743/3,743** (= 3,738 STORIS + 5 QA test units) and valuation
  **$577,513.12 to the cent**; gates 3–4 trivially 0/0 (no order/AR imports yet). Per-store
  spot check ties the file exactly: Warehouse 2,074 · West LA 527 · La Brea 448 ·
  Koreatown 387 · Studio City 302 = 3,738. **The "owner-reported, not independently
  confirmed" caveat above is closed — rehearsal-scope recon gates 1–2 now pass
  server-side on staging with real data.** Ops: rotate the owner password shared for this
  session; vendor contact fill-in and canonical-host QA remain from the pass-3 list.

- **2026-08-25 — Location hard-delete for mistake records (owner request).** There was no
  delete button because there was no DELETE endpoint — deactivate-only by design. Now:
  `DELETE /v1/business/locations/:id` (permission `locations.delete`, already in every
  Owner/Manager role) with two guards — the location must already be inactive, and an
  explicit reference probe across all 12 location-FK tables must come back empty (explicit
  rather than FK-error-driven because inventory levels/movements, tax rates and staff
  scopes cascade — a bare DELETE would silently take that data along). 409 names what
  references it; deletes are audit-logged. Locations page shows a Delete button on
  inactive rows with a confirm. business.int.spec 22→23 (active→400, referenced→409 with
  cascade rows surviving, clean inactive→deleted). The three duplicate "Koreatown Store"
  records qualify (inactive, referenced by nothing) — deletable in the UI once this
  checkpoint deploys.

## Checkpoint 6 merged + deployed (2026-08-25)

PR #30 squash-merged to main as `28b1248` (QA pass-3 fixes, location hard-delete,
migration-naming boot log, Cowork invoice-register runbook, server-verified recon).
Deploy branch merged (`ff654aa`) and deployed to Render via API trigger
(`dep-da6va4s9v7es739km770`, live 20:05Z): `/health` + `/ready` 200 on the fresh
instance, and the boot log now prints the instrumented line —
`Schema migrations: 31/31 applied, head=0030_integration_sync_state; this run applied
none (already up to date).` (no schema changes in this batch, no pending warning).
Vercel production READY on main `28b1248`; canonical host confirmed
`lamattress-erp.vercel.app`. Sprint branch restarted from main. Browser-QA pass 4
brief handed to the owner (regression on the pass-3 fixes, Koreatown-dupe deletion as
live cleanup, STORIS stock spot checks per store, toast recheck with a focused tab).

- **2026-08-25 — Production-domain login fixed (owner-reported, root-caused, verified).**
  `lamattress-erp.vercel.app` couldn't sign in: `CORS_ORIGIN`/`AUTH_TRUSTED_ORIGINS` on the
  Render service allowed localhost + the `*-alwayzlegits-projects.vercel.app` preview
  wildcard but not the production domain, and better-auth validates the proxied `Origin`
  header against that list before checking credentials. Added the domain to both vars
  (merge update via Render API, `dep-da6vjk8ae00c7385a95g`); verified live — preflight
  from the prod origin now 204 with the domain echoed, and a dummy-cred POST through the
  prod proxy returns 401 INVALID_EMAIL_OR_PASSWORD (credential layer reached).
  Ops still open: repoint the Render dashboard repo URL to LA-Mattress-ERP (deploys
  remain manual-trigger until then), rotate the owner password shared for the location
  fix, vendor contact fill-in.

## Rehearsal #2 executed on staging (2026-08-25) — customers + sales history

The invoice-register PDF became moot: the owner produced real exports
(`CUSTOMERBASE_*.xlsx`, 51,298 rows; `ALL_CUSTOMER_PRODUCTS_SALES_*.xlsx`, 220,278
line rows). Both processed in-session (data never touched the repo) and imported
through the D7 pipeline via owner-authorized API session.

- **Customers: 51,117/51,117 committed, 0 invalid.** Cleaning: 168 blank-account rows
  and 13 store/house accounts (ids 01–12, 88 — exactly the STORIS store codes) dropped;
  0 dupes after that; 43,273 placeholder emails blanked (`no@gmail.com` family + any
  address shared by 50+ accounts — would have poisoned campaign sends), 7,799 real
  emails kept; single-field names split (54 business names kept whole); combined
  City/State/Zip split. Addresses land in `customers.addresses_json` (verified live) —
  the customer detail UI does not render them yet (UI backlog).
- **Sales: 71,246/71,246 committed, 0 invalid** — header-level invoices derived by
  grouping the line rows per ticket `Number` (proven single-date single-customer;
  48,211 tickets double as the customer's account# with 2000/2000 phone agreement on
  sample — STORIS mints account# from first ticket). Customer linkage: 48,211 by
  account + 20,366 by phone + 2,669 walk-ins (blank). **Store ruling (owner, final):**
  ticket prefix = store code; 01→Koreatown, 02→West LA, 03→La Brea, 04→Studio City;
  ALL other codes (05/06/08/09/10/11/12, Glendale-as-closed) → `Warehouse` so no
  history is dropped. Grand total **$61,552,851.98** across 2015-12-14 → 2026-08-23,
  444 refund invoices with negative totals preserved. Commits ride out the proxy's
  300s cap via poll-after-disconnect (server finishes on its own; one re-fire needed
  after a container restart — D7 idempotency made that safe).
- **Recon after both:** gate 1 all entities match (customer 63,159 = 12,042 Shopify +
  51,117 STORIS; sale 73,899 = 2,652 Shopify + 71,246 STORIS + 1 QA; inventory 1,507);
  gate 2 units 3,748/3,748 match; gate 2 valuation off by exactly $50.00
  (5,769,563.12 vs 5,769,... — source 57,751,312¢ vs db 57,756,312¢): the QA pass-4
  `warehouse-test.csv` imported 5 TEST-CSVUI-1 units with no UNIT_COST column, so the
  source side carries no cost for them while the db side prices them at the variant's
  $10 cost — a test-data artifact, not a pipeline defect. Gates 3–4 0/0 (no order/AR
  imports). **Rehearsal imports: 2/2 done on real data.**
- **QA pass 4 (canonical host): flows 1/2/4/5 PASS** — per-store stock ties to the
  unit; commit guard verified incl. exact hint copy; contrast 5/5 (pass-3's sidebar
  "1.16" was the agent's oklab()-parsing artifact — corrected tool measures 6.36);
  toast auto-dismiss 4.25s with a visible tab (pass-3 finding was the hidden-tab
  timer pause). Flow 3: timezone guard PASS; the three inactive "Koreatown Store"
  dupes deleted server-side by the build agent (agent declines hard deletes) — 6
  locations remain. Flow 6 "print template binding bug": **disproven server-side** —
  the served production chunk renders the vendor block conditionally with correct
  field names and cannot emit the bare `<br>`s reported; suspected stale
  service-worker bundle or void-element `textContent` serializer artifact; agent to
  re-check with SW unregistered + `innerText`. QA extra findings adopted into the UI
  backlog below.
- **UI/UX backlog (owner + QA pass 4, next build slices):** (1) list-page controls —
  pagination/search/sort/filters on Customers, Sales, Products, Inventory first (51k
  customers + 74k sales make naked tables a P0); (2) vendor edit UI (PATCH endpoint
  already exists); (3) render + edit customer addresses on the detail page; (4)
  replace every image-URL field with real file upload (storage decision needed:
  S3-compatible or Vercel Blob — Render disk is ephemeral); (5) UI/UX audit pass 5
  dispatched (dedicated brief) to inventory the rest.
- **Email/invites: currently STUB.** Invite/arrival/reminder/campaign emails go to the
  in-memory transport — Resend account has no domain and zero sends ever. To go live:
  verify a sending domain, create an API key, set `RESEND_API_KEY` +
  `RESEND_FROM_EMAIL` on the Render service (offer standing; needs owner's domain
  choice + DNS access). **Ops:** rotate the shared owner password; repoint the Render
  repo URL (auto-deploy still broken).

## "Enter a Sales Order" — POS replaced by the STORIS 3-step flow (2026-08-25)

Owner decision (D1 amended in the plan doc): order entry becomes the STORIS-style
three-step program and is the default POS surface.

- **Schema (0031_order_entry_storis_parity):** orders gain `order_kind`
  (sales_order|layaway), fulfillment widened to take_with/direct_ship,
  `delivery_status` (scheduled|estimated|asap|will_call), `delivery_instructions`,
  `pickup_location_id`, `billing_address_json`, `marketing_code`, and three Step-3 fee
  buckets (delivery/install/other + label) folded into `total_cents` after tax;
  order_lines gain per-line `fulfillment_method` + `delivery_date` (split tickets).
- **API:** create/update validate the new enums + fees; detail echoes everything;
  `recomputeTotals` includes fees. orders.int.spec 25→27 (fee math asserted to the cent,
  bad enums rejected).
- **UI:** new `components/order-entry.tsx` — Step 1 Customer (order type, selling
  location, salesperson + split % from members, fulfillment, dates/status/instructions,
  pickup location, customer picker with create-on-the-fly, shipping + optional separate
  billing address), Step 2 Merchandise (scan/search, qty, register-side price entry per
  D12, line discounts, special-order lines, per-line fulfillment/date), Step 3 Payment
  (order discount, fees, marketing code, deposit with suggested 25%, tender incl.
  financing provider/ref). Submit routing: Quote → unconfirmed order; Sales order /
  Layaway → confirm + deposit payment (layaway CTA points at the payment-plan flow);
  **take-with fast lane** — all-stock cart, fully tendered → posts a plain `/v1/sales`
  register sale (drawer/Z/commissions intact per amended D1). `/pos` now defaults to
  this flow with the legacy register one tab away (retires after its offline queue +
  drawer flows are ported); `/orders/new` renders the same component. e2e specs updated
  to drive the stepper and the register tab. Deferred by owner: warranty/prep codes,
  configurator, manual numbers, backdating, Multi-Ship Master.
- Web typecheck/lint/unit green; api 27/27 orders int tests green. Full e2e runs in CI.

## Checkpoint 7 merged + deployed (2026-08-25)

PR #31 squash-merged to main as `2d3f799` (CI 4/4 green first try, incl. Playwright on
the new stepper choreography). Deploy branch rolled (`3e34867`), Render deploy
`dep-da72lkqjnfac73aifv6g` **live 23:54Z** — boot log:
`Schema migrations: 32/32 applied, head=0031_order_entry_storis_parity; this run
applied 0031_order_entry_storis_parity.` `/health` + `/ready` 200 on the fresh
instance. Vercel production READY on main `2d3f799`. Sprint branch restarted from
main. **"Enter a Sales Order" is live on `lamattress-erp.vercel.app` → POS.**
Ops unchanged: repoint Render repo URL (deploys still manual-trigger), rotate the
shared owner password, Resend domain when ready.

## POS / Operations build (PLAN-POS-OPERATIONS.md) — phase tracker

Owner handoff spec committed as `PLAN-POS-OPERATIONS.md` with amendments A1–A4
(batch print doesn't lock; LB=La Brea keeps its name+history; single-screen New Sale
supersedes the checkpoint-7 wizard; legacy register + its offline mode retire).

- [x] **Build P1 (schema+API core):** migration `0032_pos_ops_phase1` — `locations.order_prefix`
      (validated 1–4 letters, unique per business, admin-editable via locations API),
      `order_sequences` per-store atomic counters (orders at a prefixed location number
      `{PREFIX}-{seq}` from 10001; unprefixed locations keep the legacy SO-YYYY sequence),
      `businesses.ops_settings_json` (recycling rate / doc notes / unlock roles / delivery
      cap / PO reply-to — editors ride with their consuming phases),
      `orders.original_order_id` (exchange link), `membership_permission_overrides`
      (per-user grant/revoke applied in the tenancy guard on top of role defaults). RLS
      registered; verified from empty DB (33/33). business.int.spec +2 (WL-10001/WL-10002/
      K-10001 numbering, duplicate-prefix rejection; override grant→200 / revoke→403);
      orders suite 27/27 unaffected. — _2026-08-25. Remaining P1 surface (permission-matrix
      UI, ops-settings editor, new role set, store-scoped visibility) rides with P2/P3._
- [x] **Build P2:** New Sale screen — single-screen order entry live at `/pos` (and
      `/orders/new`), login lands there. Universal customer search (name/phone/email/
      address via the widened tsvector, migration 0033) with disambiguating dropdown +
      inline create; Ship-To toggle defaulting to billing; Add Product popup
      (`/v1/pos/product-search`: text/vendor/in-stock filters, here/all availability,
      ATP date from open POs) with out-of-stock ATP banners on lines; click-to-edit
      price override + per-line & order discounts; auto Recycling Fee line per
      qualifying unit (rate from ops settings, removable) + "+ Removal ($0)" +
      installation/delivery fee fields; up to two salespeople with equal split;
      pinned totals rail (merchandise/discounts/install/delivery/recycling/tax/total/
      paid/balance); payments list over nine tenders; layaway enforces the \$100
      minimum deposit; take-with fully-paid fast lane posts a register sale;
      store-wide drafts (chips to resume; completing supersedes the draft). Wizard
      (`order-entry.tsx`), legacy register, `/pos/pending` offline tray and the
      offline e2e spec all retired per A3/A4; auth/sweep/orders e2e rewritten for the
      new flow; fresh-signup welcome bounce ported to `/pos`.
      — _2026-08-25/26. v1 conventions flagged: recycling detection is a name-keyword
      match (mattress/foundation/adjustable base/box spring) pending a category flag;
      salespeople capped at two by the split schema; store-credit tender records
      without a balance check until P8's ledger._
- [x] **Build P3:** Orders list + slide-over + change-history timeline + notifications feed.
      `/v1/orders/list-view` returns the spec table page (Order #, Customer, derived
      display Status w/ PO #, Delivery Date, Balance Due, Salesperson) — display status
      computed per row from real state (draft/quote/cancelled/completed → Draft/Quote/
      Cancelled/Delivered; layaway w/ balance → Layaway; undelivered trip → Scheduled/
      Out for Delivery; open PO allocation w/ unreceived qty → On PO (#); under-reserved
      stock line → Pending; else Reserved), never stored. `/orders` page rebuilt as that
      table (search over order #/customer, raw-status filter, cursor "Load more"); row
      click opens a read-only slide-over (lines/totals/payments/balance) with an
      "Open full page" link, Esc/backdrop closes. Order-detail Timeline card upgraded to
      the spec change history: actor email per entry + field-level before → after values
      from the audit diff (cents fields rendered as dollars). `/v1/notifications`
      (audit.view-gated) derives the owner feed from audit rows (order.update/line.add/
      line.remove/cancel/payment.take — order.create excluded as not post-creation),
      joined to actor + live order number; dashboard gained a "Notifications — order
      changes" card that hides on 403. orders.int.spec +3 (display statuses + balance,
      q filter, feed contents/attribution/gating) → 33/33; orders e2e board assertions
      → table + slide-over. — _2026-08-26. Cap/lock overrides and close-out exceptions
      join the same feed when P5/P9 land (they'll be audit actions too)._
- [x] **Build P4:** Documents — invoice, delivery ticket + individual-print lock, batch
      print. `GET /v1/orders/:id/document` bundles everything §11 needs (business name/
      logo + admin header/footer notes from ops settings, store block from the location,
      Sold To/Ship To, salesperson names, scheduled date from the earliest undelivered
      trip, per-line Model = variant SKU / Brand = preferred vendor). Print views live in
      a chrome-free `(print)` route group: `/print/orders/:id/invoice` (§11 layout: header
      note box, SO#/date boxes, info strip w/ salesperson initials, Ln#/F-code/Model/Brand
      line grid printing $0 lines, payments-by-method table, Merchandise→Amount Due totals
      rail, footer), `/print/orders/:id/delivery-ticket` (signature + date lines, collect-
      on-delivery amount), and `/print/deliveries?date=` batch — one ticket per undelivered
      trip, page-broken, not-ready trips printed WITH a bold flag (failed attempt / stock
      not fully reserved) per §7. **A1 lock**: `orders.locked_at` (migration 0034);
      individual print posts `/delivery-ticket-print` → locks; PATCH/line-add/line-remove/
      cancel all 409 while locked; batch never locks. `POST :id/unlock` requires the new
      `orders.unlock` permission (Owner+Manager via catalog, backfilled by the boot-time
      system-role sync; owner narrows via the §2 matrix/per-user overrides) + a typed
      reason → audit `order.unlock` → notifications feed. Order detail: locked banner w/
      unlock prompt + Print invoice/ticket buttons; day-sheet gained "All tickets (no
      lock)". Settings page gained the Store operations card (recycling fee $, delivery
      cap, invoice header/footer notes, PO reply-to). orders.int.spec +2 → 35/35.
      — _2026-08-26. Conventions flagged: Brand column = preferred vendor (catalog has no
      brand field); Terms prints "Balance due"/"Paid in full"; ops.unlockRoleIds is
      superseded by the `orders.unlock` permission and ignored; payments on the order
      stay allowed while locked (the office collects at delivery close-out)._
- [x] **Build P5:** Delivery dispatch table + 15-stop capacity + zip routes.
      `deliveries.route` (migration 0035) auto-suggested from the ship-to zip at
      scheduling ("91205" → "912xx"), free-text editable via PATCH. `GET
/v1/deliveries/capacity?from&to` returns per-day booked/remaining against
      ops.deliveryDailyCap (default 15; counted business-wide — one fleet, flagged as v1
      convention). Booking a full day now 409s unless `confirmOverCapacity: true`; the
      override writes audit `delivery.cap_override` (targeting the order) → owner
      notifications feed ("Delivery booked over capacity"). Web: `/deliveries/dispatch` —
      the §7 dispatcher table for a date (stop # + route inline-editable, order link,
      customer, address+phone, window, items, collect amount, status) with the "12/15
      stops" chip (amber near cap, red at cap) and All-tickets/Calendar links; calendar
      header gained Dispatch. Order detail's schedule box shows the day's booked/cap and
      turns the 409 into a confirm that retries with the override flag; New Sale shows
      "N of 15 stops left that day" under the delivery date (red "Full — booking will
      need a capacity override" at cap). deliveries.int.spec +2 → 14/14; orders 35/35.
      — _2026-08-26. Conventions flagged: cap counts stops business-wide, not per store;
      route suggestion is zip-prefix ("912xx") pending real route areas._
- [x] **Build P6:** Purchasing — builder pre-load, PO email, staged receiving, invoice
      matching. **Receiving** (migration 0036): purchase*order_lines gained
      quantity_inspected/quantity_accepted; new `POST :id/receiving` takes per-line stage
      increments with the invariant ordered ≥ received ≥ inspected ≥ accepted — stock and
      the special-order allocation flip (customer line → Reserved + arrival email) happen
      at ACCEPT, not dock receipt; PO auto-completes only when every unit is accepted;
      legacy `POST :id/receive` is now the "receive+inspect+accept in one" fast path over
      the same core, so nothing downstream changed. PO detail rebuilt as the single
      receiving screen (Ordered/Rcvd/Insp/Acc columns, three increment inputs per line,
      "X of Y accepted — N remaining", linked-SO chips, "Receive & accept all remaining").
      **Builder pre-load (§5/§6)**: /purchase-orders/new shows "Suggested for this vendor"
      — (a) at/below reorder point (existing endpoint, filtered to vendor) and (b)
      sold-not-in-stock queue rows (queue now exposes preferredVendorId + cost); queue
      adds carry `orderLineId`, which PO create now accepts to write the po_line_allocation
      so the SO # rides the PO (printed doc + emailed doc + detail chips all show it).
      **Email**: `POST :id/email` sends the PO to the vendor via the existing Resend/memory
      transport with Reply-To = ops.poReplyTo (SendEmailInput grew replyTo). **Invoices**
      (vendor_invoices table, RLS'd, unique per vendor+number): `POST /v1/vendor-invoices`
      auto-matches by PO # (or vendor+amount fallback), surfaces varianceCents vs the PO
      subtotal, `POST :id/approve` one-click (no queue per §13); new `vendor_invoices.manage`
      permission (Owner/Manager + Bookkeeper via role sync); PO page gained the invoice
      card (record & match, variance badge, approve). purchasing.int.spec +7 → 24/24,
      special-orders +1 → 6/6, orders 35/35; sweep e2e receiving flow updated.
      — \_2026-08-26. Conventions flagged: no-PO-number auto-match falls back to newest
      same-vendor PO with an equal subtotal; inspection is bookkeeping only (no damaged/
      reject disposition until P8's As-Is flow).*
- [x] **Build P7:** Transfers with ticket + sign + receive-confirm workflow. The spine
      already existed (draft → ship deducts origin → partial receives increment the
      destination → received; drafts cancellable); P7 added the §11 **Transfer Ticket**:
      `/print/transfers/:id` in the chrome-free print group — from/to store blocks with
      addresses, letterhead, lines with a blank hand-tally "Received" column, driver +
      received-by signature lines and a "confirm in the system to complete" footer;
      detail hydrate now carries fromLocationAddressJson/toLocationAddressJson/
      businessName; transfer detail page gained the Transfer ticket print button.
      Printing never changes state — the §5 workflow is create → print → deliver → sign
      on paper → receiving side confirms via the existing receive endpoint (actor
      recorded in the audit trail). transfers.int.spec +1 → 13/13.
      — _2026-08-26. Convention: signatures live on paper only (drivers work off printed
      tickets, §7); the system records who confirmed receipt, not a captured signature._
- [x] **Build P8:** Returns/exchanges, As-Is review flow, store credit. Migration 0037:
      `as_is_items` (review queue), `store_credit_entries` (ledger; balance = SUM, never
      stored), `order_lines.qty_returned`. **As-Is (§10/§5)**: every refunded/returned
      unit now lands in the pending-review queue instead of sellable stock (sales refund
      flow rerouted; existing tests updated to the new rule); `/v1/as-is` + `:id/review`
      (restock — optionally into the `-AS` variant via targetVariantId — / vendor*return /
      scrap; only restock touches inventory, one-shot, inventory.adjust-gated); web page
      `/as-is` in the Catalog nav with per-row Restock/Vendor/Scrap. **Store credit**:
      issue on refunds (`refundMethod: 'store_credit'` on sale refunds and order returns),
      redeem on order `store_credit` tenders with a hard balance check inside the request
      transaction; `GET /v1/customers/:id/store-credit`; New Sale shows the "Store credit
      available" chip when a customer is picked; customer page gained the ledger card.
      **Order returns**: `POST /v1/orders/:id/return` — per-line qty capped at delivered−
      returned, refund = line total + tax share per unit, reversed as negative payment
      rows (kind 'refund') walking original tenders newest-first, goods → As-Is; no
      restocking fee. `POST :id/price-adjustment` = the §10 distinct money-only type
      (kind 'adjustment', reason required). Both feed the owner notifications.
      **Exchanges**: `POST :id/exchange` writes an orderKind 'exchange' order linked via
      original_order_id; invoice doc prints "Exchange Order" + Original Invoice # box +
      Credit Due row; New Sale takes `?exchangeOf=` (banner, pinned customer, no take-with
      fast lane); order detail gained the Returns & exchange card (return qtys, refund
      method, adjustment, Write exchange order). List-view display statuses gained
      **Returned** (all delivered units returned) and **Exchanged** (a live exchange
      references the original). orders.int.spec +4 → 39/39; sales 11/11 + reports 14/14
      re-baselined to the As-Is rule; business 24/24.
      — \_2026-08-26. Conventions flagged: order-return tender reversal is newest-tender-
      first rather than strictly proportional (matches the sales-refund allocation);
      no Stripe reversal on order returns in v1 (office terminal); selling As-Is at a
      discount = restock then adjust onto the `-AS` SKU; service orders already link to
      sales (existing G6 module).*
- [x] **Build P9:** Commissions (equal-split default, exchange clawback), owner +
      manager dashboards, 22:00 auto-close job — _shipped in checkpoint 9 (PR #33,
      `5930f90`); box was left unchecked at the time._
- [ ] **Ops:** Provide the two sample invoices into `docs/` for the document templates
      (P4); confirm PO reply-to address; pick unlock-capable roles in settings once P1 ships

## Checkpoint 8 merged + deployed (2026-08-26)

PR #32 (P3–P8: orders list-view + notifications, print/lock/unlock + documents,
dispatch + capacity, staged receiving + PO email + vendor invoices, transfer tickets,
returns/As-Is/store credit/exchanges) squash-merged to main as `db89ef8`. CI needed one
fix first: the Playwright run — the FIRST ever CI pass over the P2 New Sale e2e (the web
build OOM'd locally back then) — failed 4 tests at the create-customer click; trace
forensics showed the Create button shoved under the sticky totals rail (grid/flex
`min-width: auto` overflow), a latent P2 layout bug, not a P3–P8 regression. Fixed with
`min-width: 0` on the form cells (`62d15e8`), all 4 verified green locally, then CI 4/4
green. Deploy branch rolled (`5bafced`), Render deploy `dep-da79h515efls73cj0g4g`
**live 07:43Z** — boot log: `Schema migrations: 38/38 applied,
head=0037_returns_as_is_store_credit; this run applied 0032_pos_ops_phase1,
0033_customer_search_addresses, 0034_order_print_lock, 0035_delivery_routes,
0036_receiving_stages_vendor_invoices, 0037_returns_as_is_store_credit.` `/health` 200.
Vercel production READY on main `db89ef8`; new endpoints (`/v1/orders/list-view`,
`/v1/as-is`) answer 401 through the prod proxy — routed and auth-gated. New permissions
`orders.unlock` + `vendor_invoices.manage` backfilled into system roles by the boot-time
role sync. Sprint branch restarted from main. **The whole POS-operations surface P1–P8
is live on `lamattress-erp.vercel.app`.** P9 (commissions, dashboards, auto-close)
remains. Ops unchanged: repoint Render repo URL (deploys still manual-trigger), rotate
the shared owner password, Resend domain when ready, sample invoices into `docs/`.

## Checkpoint 11 merged + deployed — invite link fallback (2026-08-26)

PR #35 squash-merged to main as `41577bd`; CI 4/4 green first try. Render deploy
`dep-da7ja5bm6pss73fudmr0` **live 18:50:37Z** — boot log `Schema migrations: 49/49
applied, head=0048_sale_line_order_discount_share; this run applied none (already up to
date).` Vercel production READY on main `41577bd`.

**Ops done this checkpoint:** `WEB_BASE_URL` on Render corrected from the stale
deploy-branch preview alias to `https://lamattress-erp.vercel.app` (deploy
`dep-da7ivn5g1s2s7381pql0`, live 18:28:13Z). Sending domain `mail.a-prompt.ai` created in
Resend (`fbebebe1-3a0a-4e91-a82a-b333cd6769b3`, us-east-1, `not_started`) — the root
`a-prompt.ai` was refused, 403 "domain has been registered already", i.e. claimed in a
different Resend account. Owner is adding the three DKIM/SPF records at GoDaddy; verify +
sending-scoped key + env vars follow. **Do not set `RESEND_API_KEY` before the domain
verifies** — a key with an unverified domain makes `ResendTransport` throw instead of
falling back, breaking the copy-link path.

`HANDOFF.md` added at the repo root and wired in as step 0 of the CLAUDE.md read order,
so a fresh session starts from current state rather than reconstructing it. The stale P9
checkbox (shipped in checkpoint 9) was corrected.

## Invite email — root-caused and unblocked (2026-08-26)

The owner reported an invite that never arrived. Two independent faults, both visible in
one Render log line for `POST /v1/business/members/:id/resend-invite` at 17:53:21Z:

1. **Nothing was ever sent.** `RESEND_API_KEY` is unset on the Render service, so
   `createEmailTransport` fell back to `MemoryTransport` (`"email captured (no Resend key
configured)"`) while the endpoint still returned 201 and the UI said "Invitation
   re-sent." Confirmed at the source: the Resend account has **no API keys and no
   verified domains** — production email has never worked.
2. **The link pointed at a stale preview.** `WEB_BASE_URL` was the deploy-branch Vercel
   preview alias, so even with working mail every invite would land on the wrong build.

**Fixed (bde4d23) — the dead end, not just the symptom.** `EmailTransport` now declares
`delivers`. When it is false, `POST /members/invite` and `/resend-invite` return
`inviteLink`, and the members page renders it with a Copy button instead of claiming the
mail was sent. The caller already holds `users.invite`, so handing them the link they
were about to email grants nothing extra; when a real transport is configured the field
is omitted entirely. `business.int` asserts the returned link carries the same token the
email does. 24/24 + admin 11/11 green, all gates verified by exit code.

**Ops done:** `WEB_BASE_URL` set to `https://lamattress-erp.vercel.app` on
`srv-da4tua3m8hqs73apsflg`; deploy `dep-da7ivn5g1s2s7381pql0` live 18:28:13Z.

**Ops still open — Resend sending domain.** Owner is deciding; `lamattress-erp.vercel.app`
is _not_ a candidate (Vercel owns that zone, so the DKIM/SPF records can't be added).
Domains the owner controls, from DNS: `lamattress.com` (GoDaddy DNS, Zoho Mail),
`lamattressstores.com` (GoDaddy, GoDaddy mail), `jetnine.com` (Cloudflare, Google
Workspace). A dedicated subdomain is the safe shape — it keeps Resend's SPF/DKIM off the
zone that already carries live mail. Until then, account creation runs on the copy-link
path above.

## QA steps 6 + 3 completed against the deployed build (2026-08-26)

Driven through the staging API (browser tools were unavailable), so these exercise the
same deployed code the browser QA was hitting.

**Step 6 — delivery runs, on run `2c0da72d` (2026-08-26, 2 stops, COD due $1,810.50):**

- D5 verified live: `GET /v1/orders/:id` now returns
  `onOpenRun {runId, runDate}`, and `PATCH` on a run member is refused 409 ("Remove it
  from the run (with a reason) before editing"). Previously enforced but invisible.
- Pull-off-run: refused 400 without a reason, accepted with one; registered
  `manifest_removal` (warning) attributed to the actor; the pulled order's `onOpenRun`
  went null and it became editable again. No `manifest_removal` codes exist in the tenant
  yet, so free text is the A9 fallback — **add codes for that class** to make it coded.
- Close-out refusals both hold: an unaccounted stop → 400 naming the stop id; a `failed`
  outcome with no reason → 400 "A reason is required".
- Close-out with one stop delivered and a COD mismatch → run `completed`, and
  `cod_variance` registered: _"Run 2026-08-26: COD due $800.00, collected $1700.00"_ with
  `{codDueCents, codCollectedCents, receivedBy}` in metadata. Note COD due had recomputed
  from $1,810.50 to $800.00 when the second stop was pulled — correct, and worth knowing
  when reading the variance.

**Step 3 — return split (SO-2026-000005 pickup, SO-2026-000010 drop-off):**

- Coded return reason enforced (tenant has CHGMIND), and the original-tender cap fires:
  a $1,000 return against $200 collected → 400 "use store credit for the difference".
- **Pickup**: authorization moved nothing — `paidCents` unchanged, `qtyReturned` 0, no
  As-Is row, RMA `RMA-SO-2026-000005-1` `authorized`, list view "Awaiting Return Pickup".
  On `POST /order-returns/:id/receive`: store credit $0 → $1,000, `qtyReturned` 1, one
  As-Is piece `pending_review`, RMA `completed`, status "Returned". A7 holds end to end.
- **Drop-off**: one request → `completed`, refund row `cash -100000`, `paidCents` 0,
  goods to As-Is. Immediate, as specified.

**D1 verified on the live system.** Rebuilt the exact case: register sale INV-2026-000006,
$1,000 list less a 30% cart discount, $700 collected. Refund paid out **$700.00** (it
would have paid $1,000 before the fix). D2 also confirmed live — the same sale was first
refused `REASON_REQUIRED` with no reason, which is the hole that let the original
INV-2026-000005 through.

**D9 resolved — not a defect.** `GET /v1/products/9786c836…` returns Q-MOS10 with
`priceCents: 0` and `costCents: 125500`. Both the API and the variants table map the
columns correctly; the $1,255.00 on screen _is_ the Cost column, and the Price cell is an
editable input reading `0.00`. **But the underlying observation is real and is a cutover
blocker:** the STORIS catalog imported with no retail prices (D12, by design), so every
imported variant is $0.00 and lands on an order at zero. Spot-checked across the catalog —
`pos/product-search` returns `price=0` for every imported SKU. A price source is needed
before go-live: import a price file, or set prices in-app.

**Test-data ledger additions (D11):** INV-2026-000006 ($700 discounted register sale, fully
refunded); SO-2026-000010 (paid, fulfilled, drop-off returned); a $1,000 store-credit
balance on customer ELICIA JOHN (4364a598) from RMA-SO-2026-000005-1; two As-Is pieces
pending review; run 2c0da72d closed with a COD variance; SO-2026-000008 pulled off that run.

## Checkpoint 10 merged + deployed — QA pass fixes (2026-08-26)

First browser QA pass over the deployed gap-closure surface produced 15 findings.
PR #34 squash-merged to main as `f72a3db`, CI 4/4 green first try. Render deploy
`dep-da7i1u7avr4c73fub8o0` **live 17:24Z** — boot log: `Schema migrations: 49/49 applied,
head=0048_sale_line_order_discount_share; this run applied
0048_sale_line_order_discount_share.` `/health` + `/ready` 200; Vercel production READY on
main `f72a3db`; `/v1/audit-logs` answers 401 through the prod proxy (the D8 proof).

**D1 — refunds overpaid by the whole discount (real money).** `sale_lines.discount_cents`
holds only a line's _own_ discount; a cart-level discount lives on the sale header and the
refund never consulted it, so a $1,000 line sold for $700 under a 30% cart discount
refunded $1,000 — true of **every** refund against a discounted sale, not one invoice.
Fix: the line's share of the sale discount is computed at sale time and **persisted**
(`order_discount_share_cents`, migration 0048) rather than re-derived — the pro-rata
rounding residue cannot be reconstructed afterwards because line order was never stored,
and pennies of ambiguity do not belong in a refund. Legacy rows fall back to
`reconstructOrderDiscountShares` (exact in total). Second half of the same bug: sale
refunds returned **pre-tax** amounts while the order-return path returned tax; both now
return what was collected.

**D2 — the register bypassed the price-variance gate.** `POST /v1/sales` never called it,
and New Sale's fully-paid take-with fast lane posts a register sale, so the hole was
reachable from the order screen too — that is how the D1 invoice was written. The gate
moved out of `OrdersController` into a shared `PriceVarianceService` both doors call.
**Discount codes are exempt**: a coupon is a pre-authorized instrument created by someone
holding `discounts.manage`; demanding a reason per redemption would only teach staff to
type junk. (Exempting them also fixed the 3 discount-code specs the gate first broke.)

**D4** all five `window.prompt` calls (pull-off-run, cancel-return, as-is price, vendor
R/A, vendor credit) replaced with the in-app dialog, which gained typed `fields` — a
native prompt can carry neither a coded reason nor a manager challenge, and it froze the
QA browser. **D6** the over-capacity confirm matched the substring `'at capacity'`; the
G12 multi-dimension rewrite changed the message and silently disabled the documented
override — now a structured `OVER_CAPACITY` code. **D7** commission plans had API support
since G5 but no UI, so nobody was ever on a plan, `planFor()` returned null for everyone
and nothing accrued; added a Plans card. **D8** `/audit` hand-rolled `fetch` against its
own `NEXT_PUBLIC_API_URL` default and so called `http://localhost:4000` in production;
switched to the shared `api()` helper.

**Three QA findings corrected rather than fixed:** (a) _D5 — the run lock does work_;
`assertNotOnOpenRun` was already enforced on every edit path. What was missing is that the
order detail never reported run membership, so the page showed no banner and left controls
live — enforced but invisible. Detail now returns `onOpenRun`. (I first "fixed" this by
duplicating the existing guard, then reverted.) (b) _Tier 3 collapsing to "needs a reason"
is by design_ — the QA tested as owner, who holds `orders.price_override`, so no second
signature is demanded; the below-cost CRITICAL never appeared only because the exception
records _after_ a reason is supplied. (c) _D10 two-`/pos`-screens is deployment skew, not
code_ — no `order-entry` file, no "Enter a Sales Order" string, one `/pos` route, sidebar
label hardcoded to "New Sale"; a stale cached build was being served.

**Not fixed:** D9 (variants Price/Cost) is not reproducible from code — both the API
projection and the table map the fields correctly, and the two symptoms conflict ($1,255
under Price cannot land on an order at $0.00). Needs the raw `GET /v1/products/<id>`
payload for Q-MOS10; suspect the STORIS import wrote cost into `price_cents`. A real
adjacent ambiguity was confirmed: the Cost column renders "hidden" both when the viewer
lacks `products.cost.view` and when cost is genuinely null.

API suite 489→**500 passing** (+11 covering the D1 numbers and all three D2 tiers); e2e
8/8 run locally before the push and green in CI. Ops unchanged, plus: **the cashier and
manager accounts still need creating** (Settings → Users → Invite) — the QA agent cannot
type passwords, and step 2's override flow needs a second, non-owner identity.

## Checkpoint 9 merged + deployed (2026-08-26)

PR #33 (the whole STORIS gap closure G1–G15 + §2 append-only audit + P9) squash-merged to
main as `5930f90`. CI took three passes, each a real defect in the sprint's own work, none
a flake:

1. `next lint` rejected a bare apostrophe in the new morning-brief heading
   (`react/no-unescaped-entities`). **Root cause of the miss:** the local verification
   grepped for lowercase `"error "`, and `next lint` prints `Error:` — so a red lint read
   as green. Every gate is now verified on its **exit code**, not on grepped output.
2. Both new suites died on `FATAL: database "jetnine_controls"/"jetnine_closeout" does not
exist` — CI provisions each spec's database explicitly and the two new ones were never
   added. Fixed by diffing every `jetnine_*` name the specs reference against the
   `createdb` list (only `jetnine_rehearsal` is legitimately absent — that spec self-skips
   without `STORIS_REHEARSAL_DIR`); added the two `createdb` lines plus their
   `*_TEST_DATABASE_URL` env vars.
3. Green 4/4 — and Playwright ran for the first time on this PR (it had been `skipped`
   both prior rounds because it `needs: verify`). Before the third push the e2e suite was
   also run **locally** (8/8) against a fresh `jetnine_e2e` using the temp
   `playwright.local.config.ts` recipe pointing at `/opt/pw-browsers/chromium` — deleted
   before committing, never committed.

Deploy branch rolled (`8126b48`), Render deploy `dep-da7cpuu1egvs73e7vk50` **live 11:26Z** —
boot log: `Schema migrations: 48/48 applied, head=0047_daily_closeouts; this run applied
0038_reason_codes_security_overrides, 0039_order_returns, 0040_write_offs_exceptions,
0041_delivery_runs, 0042_transfer_variance, 0043_print_preconditions, 0044_as_is_pieces,
0045_purchasing_controls, 0046_capacity_units, 0047_daily_closeouts.` — all ten applied in
one run, clean. `/health` ok + `/ready` 200 on the fresh instance; `CloseoutService` logged
`Daily close-out scheduled at 22:00 store-local time`; the overdue sweep still arms at
09:00 UTC. Every new endpoint (`/v1/exceptions`, `/v1/closeouts`, `/v1/dashboard/morning`,
`/v1/write-offs`, `/v1/reason-codes`, `/v1/order-returns`, `/v1/delivery-runs`) answers 401
on staging **and** through the prod proxy — routed and auth-gated. Vercel production READY
on main `5930f90`; `lamattress-erp.vercel.app` serving 200. New permissions
(`reason_codes.manage`, `security_overrides.view`, `inventory.write_off`, and the rest)
backfilled into system roles by the boot-time role sync. Sprint branch restarted from main.

**The 9-phase POS-operations build and the 15-item gap closure are both complete and live.**
Ops unchanged: repoint the Render repo URL (deploys still manual-trigger), rotate the shared
owner password, Resend domain when ready, sample invoices into `docs/`.

## STORIS gap-closure build (PLAN-STORIS-GAP.md) — ranked tracker

Owner delivered a full STORIS gap analysis 2026-08-26 ("we need to add all which is
missing"); committed verbatim as `PLAN-STORIS-GAP.md` with amendments A5–A9 (soft print
lock / run hard-lock, 3-tier price variance, refund gated on goods receipt, as-is piece
ids, coded reasons everywhere). Build in the doc's ranked order; each item is a vertical
slice. P9 (commissions/dashboards/auto-close) stays queued and will absorb the gap doc's
commission-clawback + digest requirements.

- [x] **G1 — Security Override primitive:** migration `0038_reason_codes_security_overrides`;
      `SecurityOverrideService.require()` gates at the point of action — actor with the
      permission passes, actor without gets 403 `code:OVERRIDE_REQUIRED` (names the action +
      permission), retry with a _different_ authorized user's email+password verifies the
      credential (root connection — the accounts owner-only RLS policy rightly blocks the
      request tx), checks the authorizer's effective permissions (role + per-user overrides),
      refuses self-authorization, and stamps `security_overrides` with both identities +
      before/after. `GET /v1/security-overrides` register (new `security_overrides.view`
      perm; Owner/Manager/Bookkeeper). Reusable `<SecurityOverrideDialog>` (reason select →
      manager-credentials section appears on 403; used by order unlock). Pilot consumer:
      order unlock — `orders.unlock` holders proceed as before, others via override; the
      `ApiError` class now carries structured bodies so the client can react to codes.
      controls.int.spec 13/13; orders 39/39, business 24/24, RLS 14/14 unaffected.
      — _2026-08-26._
- [x] **G2 — Reason Code registry:** `reason_codes` (usage classes from shared
      `REASON_USAGE_CLASSES`, restricted flag, active flag; unique per business+class+code;
      deactivate-not-delete). CRUD API (`reason_codes.manage`; listing open to any member —
      every prompt reads it), Settings → "Reason codes" card. Consumers wired: unlock
      (class `exception`) + price adjustment (class `adjustment`) — once a class has active
      codes, free text is refused and the resolved code lands in audit metadata; while a
      class is empty, free text is the transitional fallback (amendment A9). — _2026-08-26.
      Conventions flagged: restricted-code enforcement (manager auth to *use* a restricted
      code) lands with its first consumer (as-is flows, G4/G10); return-line coded reasons
      ride with G3._
- [x] **G3 — Return lifecycle:** migration `0039_order_returns` — `order_returns`
      (RMA `RMA-{order#}-{n}`, status authorized/completed/cancelled, fulfillment
      drop*off/pickup, refund method + amount captured at authorization) +
      `order_return_lines` (per-line qty, per-unit cents, coded reason class `return`).
      `POST /orders/:id/return` now *authorizes* (no money, no inventory; open
      authorizations count against returnable qty; list-view shows "Awaiting Return
      Pickup"); `POST /order-returns/:id/receive` (inventory.receive — warehouse-side)
      fires the whole physical+financial event: qtyReturned, As-Is intake, tender
      reversal / store credit, status completed; drop-off (default — goods in hand)
      authorizes + receives in one request, flagged. `:id/cancel` voids an authorization
      (reason; override-gated on pos.refund.create). UI: fulfillment select, coded
      return-reason select, per-order returns table w/ "Goods received"/Cancel.
      Notifications feed += return_authorized / cancel / security.override labels.
      orders.int.spec 39→42. — \_2026-08-26. Conventions flagged: one reason code applies
      to all lines of a return (per-line selects when a real need shows); As-Is rows
      keep referencing the order (P8 contract); original-tender cap re-checked at
      receipt — a shortfall blocks with "re-authorize as store credit"; SoD: writer
      needs pos.refund.create, receiver needs inventory.receive.*
- [x] **G4 — Scrap/write-off control:** migration `0040_write_offs_exceptions`. Scrap in
      As-Is review is now a write-off: gated on new `inventory.write_off` (Owner/Manager;
      a clerk goes through the manager-override dialog), coded reason (class `write_off`),
      valued at variant cost onto the `write_offs` register (`GET /v1/write-offs` w/
      rolling total, reports.inventory.view). Vendor returns REQUIRE an R/A number and
      open a credit to chase (`vendorCreditStatus` open → received / written-off via
      `POST /v1/as-is/:id/vendor-credit`, vendor*invoices.manage; giving up on a credit is
      itself an exception). — \_2026-08-26.*
- [x] **G5 — Exception register + ranked digest:** `exception_events` (type, severity,
      actor, ack state) + `ExceptionsService.record()` wired into the control points:
      security overrides, order unlocks, over-capacity bookings, write-offs, vendor-credit
      write-offs. `GET /v1/exceptions` (filters: open/severity/type/actor, audit.view),
      `POST :id/ack` (one-shot, stamps who), `GET /v1/exceptions/digest?days=` — the §2
      per-associate ranked digest. New `/exceptions` page (register table + ack + 7-day
      ranked digest card) in the Insights nav. controls.int.spec 13→19; orders 42/42,
      deliveries 14/14, RLS 14/14. — _2026-08-26. Convention flagged: the override stamp
      accepts the action's own reason code (any class) — class enforcement stays with the
      consuming prompt, so the dialog never asks for two reasons; G6 adds the threshold
      writers (price variance) to the same register._
- [x] **G6 — Price variance 3-tier + §5 gates:** server-side variance gate on order
      create / draft-confirm / discount raise / line add, against catalog list prices
      (line overrides + line discounts + order discount): tier 1 (≤5% OR ≤$50) logged
      only; tier 2 (≤15%) → 400 `code:REASON_REQUIRED`, coded reason (class exception) + exception-register entry; tier 3 (>15% or below variant cost) → manager
      security override on new `orders.price_override`, below-cost registers as
      **critical**. Thresholds per business in ops settings `priceVariance` (editable
      in Settings → Store operations). New Sale catches REASON*REQUIRED/
      OVERRIDE_REQUIRED and runs the approval dialog, then retries. Also: layaway $100
      minimum deposit enforced at save (override on orders.complete_with_balance +
      registered), and qualifying orders written without a recycling-fee line register
      a `recycling_fee_removed` exception automatically (server-side keyword check —
      can't be bypassed by the UI). orders.int.spec 42→48. — \_2026-08-26. Conventions
      flagged: margin floor = variant cost (no separate floor setting yet); drafts skip
      the gate but re-run it at completion; exchange passes control fields through;
      tax-exempt gate deferred — no tax-exempt field exists on orders yet; daily cash
      refund cap deferred to the §8 refund-controls slice.*
- [x] **G7 — Delivery run object + close-out reconciliation:** migration
      `0041_delivery_runs` — `delivery_runs` (date/route/truck label/driver, COD due vs
      collected + received-by, status open→out→completed) + `deliveries.run_id` +
      `deliveries.failure_reason_code_id`. Build a run from a day's scheduled stops
      (`POST /v1/delivery-runs`); **run membership is the A5 hard lock** — orders on an
      open/out run refuse edits AND unlock with 409 until pulled off the run (coded
      `manifest_removal` reason, exception registered — STORIS S$TE*MAINIF_RMV). Depart
      flips stops out-for-delivery. **Close-out is mandatory reconciliation**: every open
      stop needs an outcome — delivered (existing completion path: stock leaves,
      reservations consume, order advances) or failed (coded `delivery_failure` reason →
      exception + optional auto-reschedule cloning the stop's lines to a new date); COD
      due (delivered stops' balances) vs collected compared, variance → `cod_variance`
      exception with who received the cash. Manifest print page
      (`/print/delivery-runs/:id`): stops in order, per-stop collect + signature +
      outcome checkboxes, driver + office-received signature lines. Dispatch page: run
      cards (Depart / Pull-off / Close-out form / Print manifest) + "Build run" from
      unassigned stops. deliveries.int.spec 14→16; orders 48/48, RLS 14/14. — \_2026-08-26.
      Conventions flagged: A5 applied as print-lock stays hard (per A1, now
      override-able) with the run lock layered stronger on top; truck is a free label
      until a truck entity exists; COD due counts delivered stops only; postponement
      counter rides with G13's auto stock release.*
- [x] **G8 — Transfer variance + aging + types:** migration `0042_transfer_variance`.
      (In-transit was already a real bucket — ship deducts origin, receive credits
      destination, so road goods are sellable nowhere; kept.) New: **`POST
/v1/stock-transfers/:id/close-short`** — a short transfer can't be dismissed, only
      resolved: needs `inventory.write_off` (clerk → manager-override dialog), a coded
      reason (class `transfer_variance`), values the missing units at cost onto the
      write-off register (attributed to origin), registers a `transfer_variance`
      exception, status → `closed_short`. `GET /v1/stock-transfers/aging?days=3` — the
      in-transit-too-long standing alert, surfaced as a red banner on the transfers page.
      Transfer types (`replenishment`/`floor_sample`/`customer`/`as_is`) on create + a
      type select in the UI. transfers.int.spec 13→15. — _2026-08-26. Conventions
      flagged: floor-sample type is recorded but doesn't yet gate sellability at the
      destination; the request workflow (store asks → warehouse approves) and a
      coded creation reason are deferred; receiving identity already captured in
      movements/audit._
- [x] **G9 — Print preconditions + reprint counter + unlock window** + **G15 pick
      list:** migration `0043_print_preconditions` (`orders.ticket_print_count`,
      `orders.relock_at`). Delivery-ticket print now checks server-side and answers a
      pass/fail checklist (409 `code:PRINT_BLOCKED`): stock lines reserved; a scheduled
      trip (delivery orders) / promised date (pickups); balance ≤ new ops setting
      `maxBalanceForTicketPrintCents` — the balance cap alone is override-able
      (orders.complete*with_balance, manager dialog). Every print bumps the copy
      counter; copy 2+ registers a `ticket_reprint` exception and the print page shows
      "REPRINT — copy #n". **Unlock is a 15-minute window** (relock re-engages lazily,
      no cron; fresh unlock re-opens it) and the **3rd unlock on one order escalates to
      a critical exception**. Locked-state allowlist per §3: delivery instructions /
      notes / address fixes pass through the lock so unlocking never becomes routine.
      **G15**: `/print/orders/:id/pick-list` — warehouse pull sheet with qty, item,
      model/SKU, pulled checkbox, pulled-by/checked-by lines and **no prices**; button
      on the order page; never locks. orders.int.spec 48→52 (P4 suite adapted: pickup
      fixture satisfies preconditions; notes edits now pass the lock by design). —
      \_2026-08-26. Conventions flagged: reserved/date failures are hard blocks (fix the
      data), only the balance cap has an override path; credit-hold check waits for a
      credit-hold field to exist; document id/revision on invoices deferred.*
- [x] **G10 — As-is piece identity:** migration `0044_as_is_pieces` — `as_is_items` +=
      piece*number, condition, as_is_price_cents, storage_location, reason_code_id.
      Intakes and return receipts now explode into **one row per unit** with a piece
      reference (`AS-XXXXXXXX`, id-derived — no sequence race); legacy qty>1 rows stay
      valid. Coded intake reason (class `as_is`) mandatory once codes exist; a
      **restricted** code (STORIS "As-Is Restricted") needs `inventory.write_off` or a
      manager override. `PATCH /v1/as-is/:id` — condition + storage location free,
      as-is price gated on new `as_is.price.set` (Owner/Manager; override dialog for
      others). `GET /v1/as-is/aging?days=60` — pieces stuck in review. UI: piece #,
      condition, storage, as-is price shown per row + "price…" action. controls.int.spec
      19→22; orders/sales/reports 77/77 unaffected. — \_2026-08-26. Conventions flagged:
      photos deferred (needs the storage decision already on the backlog); max discount
      off original not enforced yet (price is manager-gated instead).*
- [x] **G11 — Purchasing controls:** migration `0045_purchasing_controls`
      (`purchase_order_lines.quantity_rejected`, `vendor_invoices.created_by_user_id`,
      `vendors.remit_to`). **Third bucket**: staged receiving takes `rejected` —
      invariant ordered ≥ received ≥ inspected ≥ accepted+rejected; rejects become
      As-Is pieces (never silently sellable, reviewer disposes → vendor return w/ R/A
      or valued scrap), register a `po_reject` exception, and count as dispositioned so
      the PO still completes (no pressure to accept damage). **SoD on invoice
      approval**: the recorder cannot self-approve — a _different_ holder of
      vendor*invoices.manage signs (override dialog; `force` mode added to the
      override primitive). **Tolerance auto-clear**: matched invoices within ops
      `invoiceVarianceToleranceCents` approve themselves — reviewers only see
      exceptions. **Remit-to alert**: `vendors.remit_to` changes register a CRITICAL
      `vendor_remit_change` exception (vendor-master fraud). **Blind receiving**: ops
      toggle hides Ordered/expected/cost columns on the receiving grid (PO detail
      carries the flag). Settings knobs for tolerance + blind mode. purchasing.int.spec
      24→27 (P6 approve updated: manager signs per SoD). — \_2026-08-26. Conventions
      flagged: PO hold/release deferred (POs here are buyer-created, not auto-created
      from order entry — the hold's driver); landed cost, receiving-error reversal as a
      distinct transaction, R/A field on POs, email-PO ack capture deferred; remit-to
      is API-level until the vendor edit UI lands (existing backlog item).*
- [x] **G12 — Multi-dimensional capacity + zip→route mapping:** migration
      `0046_capacity_units` (`product_variants.capacity_units`, default 1 — a king set
      is not a twin). Capacity is now stops + optional per-day piece budget
      (`deliveryDailyPieceCap`) + optional capacity-unit budget
      (`deliveryDailyCapacityUnits`); scheduling refuses 409 **naming the over
      dimension** ("over capacity on capacity units (4 + 3 > 4)"), override still
      deliberate+registered; `/deliveries/capacity` reports pieces + units per day.
      `ops.zipRoutes` ("912" → "Glendale AM") wins route suggestion by longest prefix,
      falling back to the zip-prefix label. Settings knobs for both budgets.
      deliveries.int.spec 16→17. — _2026-08-26. Conventions: zipRoutes edited via API/
      settings JSON for now (no dedicated editor); stop times/windows already exist on
      deliveries; truck lanes wait for a truck entity (G7 note)._
- [x] **G13 — Line roll-up + Past Due + Auto Stock Release + drift:** list-view rows
      carry `lineSummary` (units/reserved/fulfilled/special-order, rendered "2 of 3
      reserved · 1 SO" under the status chip) and `?view=past_due` — undelivered orders
      past their promised date, one chip on /orders. `POST /v1/orders/auto-stock-release`
      (inventory.adjust; {days, dryRun}) frees reservations on open orders promised >N
      days ago with nothing on a truck and no lock — each release audited + registered
      (`auto_stock_release`); P9's nightly job will call it. `GET
/v1/orders/reservation-drift` (reports.inventory.view): SUM(line reserved) vs
      level reserved per variant+location, drift rows only. orders.int.spec 52→56. —
      _2026-08-26. Conventions: past-due keyed on requestedDate (scheduled-trip lateness
      shows via Scheduled status + date already); per-line Hold, credit hold, EST-vs-SCH
      date distinction, and manual reservation re-assignment still open (rolled into the
      backlog); postponement counter still deferred to P9._
- [x] **G14 — Duplicate-order prompt + ATP-vs-promise warning:** `GET
/v1/customers/:id/open-orders` (open orders w/ promised + next-trip dates); New
      Sale shows a warning banner when the picked customer already has open orders
      ("consider one truck"), and completing with a promised date EARLIER than any
      line's ATP date demands an explicit confirm naming the late lines. —
      _2026-08-26. Conventions: the consolidate prompt is advisory (banner), not a
      blocking dialog; credit-application gate for Synchrony/Acima still open (needs a
      credit-app entity)._
- [x] **§2 audit coverage:** `audit_logs`, `security_overrides`, and `write_offs` are
      now **append-only at the DB level** (UPDATE/DELETE revoked from app*user in
      rls.sql; exception_events keeps UPDATE for acknowledge). Field-level coverage
      audit: line add/remove/qty ✓ (endpoint audits), price + discount changes ✓ (G6
      exceptions + order.update diffs), delivery date changes ✓ (order.update /
      delivery PATCH diffs), salesperson change ✓ (order.update diff), recycling-fee
      removal ✓ (G6 exception), route/date-after-print ✓ (G7 run lock + audits),
      customer-swap N/A (no endpoint can change an order's customer), tax-exempt /
      tender-void / deposit-transfer N/A (those routines don't exist yet — each gets
      its control when built). — \_2026-08-26.*
- [x] **Build P9:** commissions clawback + morning dashboards + 22:00 auto-close.
      Migration `0047_daily_closeouts`. **Commissions:** accrual at completion (split per
      split*bps) already existed; `reverseForOrderReturn` now claws back the returned
      fraction as negative entries when a return's goods are received (rides the A7
      lifecycle — an exchange nets out: clawback on the return, fresh accrual on the
      exchange order's own completion). **Morning dashboard:** `GET /v1/dashboard/morning`
      (reports.sales.view; `?date=` + `?locationId=` for the store-manager scope) —
      yesterday by store (orders written + register sales), by associate (order totals
      split-weighted + sale totals), today's deliveries vs the cap, refunds/cancellations
      with the actor, the daily modification log, and the open-exception count; rendered
      as the dashboard "Morning brief" card (hides on 403). **22:00 auto-close:**
      `CloseoutService` in-process scheduler (OverdueScheduler pattern: 10-min tick, fires
      once per store-local day after CLOSEOUT_LOCAL_HOUR=22, store timezone-aware,
      NODE_ENV=test/CLOSEOUT_ENABLED=false guards) — never blocks, flags: open cash
      drawers, today's undelivered trips, delivery runs never closed (critical),
      delivered-with-balance orders (critical, the §1 standing alert); findings land on
      the exception register; the nightly G13 Auto Stock Release rides along once per
      business. Idempotent via unique (location, close_date) `daily_closeouts` row;
      `POST /v1/closeouts/run` manual trigger + `GET /v1/closeouts` history.
      closeout.int.spec 4/4; full API suite 39 files / 489 tests green. — \_2026-08-26.
      Conventions flagged: dashboard day boundaries are UTC calendar dates (matches the
      Z-report); commission clawback fires on returns only (price adjustments do not
      recalc commission in v1); close-out balance/deliveries scoped per location, stock
      release per business; close hour env-configurable, not per-store yet.*

## Test-data ledger (D11 — what lives in the QA tenant and never reaches production)

Production cutover creates a **fresh business**; everything below stays behind in the
current staging business. Keep this list current whenever a test session creates data.

- Browser-agent run 1 (2026-08-24): product "Cloud Comfort Mattress — Queen" ($899.99);
  sale INV-2026-000001 + full refund; customer "Maria Testerson" (fake email + "gate
  code" note); order SO-2026-000001 with $200 cash deposit + public share token +
  delivery scheduled 8/25; segment "Test VIPs"; campaign "Browser test" (sent to 2 test
  recipients via the memory outbox); branding round-trip (reverted); reorder settings
  (cleared).
- Browser-agent run 2 (2026-08-24, retest): more of the same shapes — additional POS
  sale(s) + refund, an order + track link + delivery, a vendor + draft PO, a campaign,
  vendor-SKU entries; whatever its report lists.
- Shopify sync (2026-08-24, ~19:59Z): the REAL store catalog/customers/orders landed in
  the QA tenant mapped to location "Glendale". This is real data but in the test tenant —
  the sync will be re-run into the production business at cutover (with the proper
  location mapping), not migrated.
- STORIS staging imports (2026-08-25, run by the owner via the wizard): the real product
  catalog (6,909 rows incl. 552 `-AS`) and inventory counts (1,505 rows / 3,738 units)
  now live in the QA tenant too. Same treatment as the Shopify sync — re-imported fresh
  into the production business at cutover (D7 makes that a clean final run), never
  migrated across.
- At cutover into the fresh production business: recreate locations (real store list),
  staff invitations + roles, business settings (tax, receipts, branding), re-run the
  Shopify connector, then run the final STORIS import (D7 pipeline). The QA tenant keeps
  serving as the safe playground for future testing and demos.
- Browser-agent run 3 (2026-08-25, checkpoint-5 QA): products `TEST-CSVUI-1` ("QA CSV
  Upload Widget A", $10 cost) and `TEST-CSVUI-2` ("QA CSV Upload Widget B", $20 cost);
  vendor `QA VENDOR` (auto-created by the products import); inventory level 5 on hand of
  `TEST-CSVUI-1` at "Glendale Store" (Warehouse substitution); one full Shopify re-sync
  (12,042 customers / 1,805 products / 2,652 sales). No `TEST-CSVUI-3` (mapping-guard file
  never committed); no stock at "Warehouse" (location absent).
- **2026-08-24 — D12 (no retail-price import) + QA run-2 triage:** priceCents is now
  optional on product import — absent means new variants land at $0 and existing
  variants keep their price (Shopify prices survive the STORIS import); POS cart lines
  gained a register-side unit-price input (negotiated pricing) plus live type-to-search
  (350ms debounce; scanner Enter flow unchanged); vendor-create form no longer throws
  on success (React currentTarget-after-await bug); Shopify sync falls back to the
  email local part when a customer has no name. import.int.spec.ts 10→11. STORIS CSVs
  regenerated with real location names (88=Warehouse, 1=Koreatown, 2=West LA,
  3=La Brea, 4=Studio City) and 552 as-is companion SKUs (`-AS`, 1,180 units);
  location code 8 (186+122 units) held out pending its store name. QA run-2 "vendor
  SKU FAIL" was a deploy lag — the live API is still 80ad9bd and the 18:23 auto
  redeploy from the instance upgrade FAILED; Ops: Manual Deploy latest on jetnine-api.
- **2026-08-24 — QA run-2 final: 10 PASS / 1 FAIL (vendor SKU = the deploy gap, since
  closed by the 20:43Z manual deploy of 1bbd354; migrations incl. 0029 applied clean).**
  Z-report refunds row verified live (−$968.99 ties out), Avery 5160 geometry confirmed
  from print DOM, dashboard KPIs agree with the Z. Adopted the agent's hardening
  suggestion: the reorder card now asserts the PATCH response echoes vendorSku before
  showing success — a stale backend now produces an explicit error instead of a false
  "saved". Flow-8 incognito caveat closed by server-side evidence: /v1/public/orders/:token
  is @Public and answers unauthenticated (verified by curl on staging). Test-data ledger
  additions from run 2: INV-2026-000002 ($1,949 Aviada, change $151), INV-2026-000003
  ($69 protector + refund), vendor "Bedrock Bedding Supply", PO-2026-000001 (draft),
  campaign send to 4,575 recipients (memory outbox), order + delivery + track link.
- **2026-08-24 — Sidebar blue-on-navy fix (user-reported):** the Tailwind v4 pass left
  `a { color: var(--brand) }` UNLAYERED in globals.css; unlayered CSS outranks every
  layered utility, so `text-[var(--sidebar-text)]`/`text-white` on nav links lost and
  the whole sidebar rendered brand-blue on navy. The anchor default now lives in
  `@layer base`, restoring utility overrides (bare content links keep the brand color).
  Watch for the same pattern if other element defaults ever fight a utility. e2e 9/9.
- **2026-08-25 — STORIS import REHEARSAL #1 (real data): PASS, all gates.** New committed
  runner `apps/api/test/rehearsal.storis.int.spec.ts` (self-skips unless
  STORIS_REHEARSAL_DIR points at the local CSVs — no data in the repo) drove the real
  export through stage→map→validate→commit→recon on a throwaway DB seeded with the five
  mapped stores. Results: products 6,909/6,909 committed with 0 invalid rows (incl. 552
  as-is companions); inventory 1,505/1,505 → 3,738 units on hand, tying the file to the
  unit; 48 vendors auto-created; 4,255 vendor SKUs and 252 reorder points landed; all
  variants at $0 per D12. Full re-run of both batches: zero duplicates, counts identical
  (D7). End-to-end runtime ~105s. One harness finding: the default 100kb json body limit
  413s a real catalog CSV — main.ts already runs 25mb, the test harness now matches.
  Remaining rehearsal scope: location-8 inventory (pending store name), customers /
  invoices / open-orders entities (pending exports).
- **2026-08-25 — Background provider sync (post-QA batch):** POST
  `/v1/integrations/:provider/sync` now runs detached — job state on the integrations
  row (`sync_status`/`sync_progress_json`/`sync_started_at`, migration
  `0030_integration_sync_state`), page-by-page progress notes from the connectors,
  stale-job takeover after 30 min, 409 while running, `?wait=1` preserves the
  synchronous contract for tests/scripts. Page cap raised 20→400 (100k rows/resource,
  matching MAX_ROWS) — the old cap truncated the real store at exactly 5,000 customers
  and cascaded into 1,829 skipped sales. UI polls every 2s with a live progress line
  and disables the button while running; no more false timeout toasts on 7-minute
  pulls. Detached runs write state via ROOT_DRIZZLE and audit with explicit tenant.
  integrations.int.spec.ts 6→7 tests (adds detached-mode completion + idempotency).

## Checkpoint 3 merged (2026-08-25)

PR #27 squash-merged to main as 5b0f522 (eight post-cutover slices, three browser-QA
rounds, D11/D12, vendor SKU mapping, STORIS import enrichment + rehearsal #1, background
provider sync; migrations 0025–0030). Branch restarted from main for the next batch.
Empty invoices-takeout-storis.pdf removed from main (0a4c619). Blocked on Ops: Render
instance type (still spinning down), Manual Deploy of the merged head, customers +
invoices exports, location-8 store name, pass-3 QA report.

- **2026-08-25 — Printable vendor purchase order (batch 4 slice 1):** PO detail gained a
  "Print for vendor" document — clean one-pager (business header, vendor + attn/email/
  phone, ship-to location, line items led by the VENDOR's part number with our SKU as
  "ref", subtotal, notes, PO-reference footer) using the receipt print mechanics
  (hidden on screen, sole visible element in print). API PO detail now returns
  locationName + vendor contact fields (leftJoin locations). purchasing.int.spec 17/17.
  Ops note: Render service confirmed still on plan "free" (instance upgrade reverted
  after its failed deploy) and live deploy still 1bbd354 — deploy of 847f310 queued
  behind the Render connector reconnect (auto-retry armed); repoint the Render repo URL
  to LA-Mattress-ERP to restore auto-deploy permanently.
- **2026-08-25 — File-upload CSV import everywhere (batch 5 slice 1):** the Phase-1
  paste-box importer on Products is gone; a reusable `CsvImport` component (file picker
  → staged batch → editable column mapping → validate with per-row error preview →
  commit, all over the D7 wizard endpoints) now lives on Products (product entity) and
  Inventory (inventory entity, new — with a products-first hint). Settings → Import
  remains the full multi-entity wizard on the same pipeline. e2e 9/9.
- **2026-08-25 — Owner ran the staging imports; Render instance fixed:** the owner
  pushed the two prepared STORIS CSVs through the staging wizard themselves (products
  then inventory — the first real end-user run of the D7 pipeline). Verification
  criteria on record: products 6,909/6,909 · inventory 1,505/1,505 · recon product
  6,909 / inventory 1,505 / units 3,738; server-side confirmation queued behind the
  Render connector reconnect. Render instance re-upgraded and CONFIRMED on Starter
  (no more spin-downs); API deploy of the merged head still queued (auto-retry armed);
  Ops: repoint the Render repo URL to LA-Mattress-ERP for auto-deploy. PR #29
  (batch 5) opened, CI fully green, awaiting merge word.

## Checkpoint 5 merged (2026-08-25)

PR #28 (printable vendor PO) squash-merged to main as `e860ec2`; PR #29 (file-upload CSV
import on Products + Inventory) squash-merged as `138ba82` — the "awaiting merge word" note
above is settled. Deploy branch `claude/fix-latent-int-spec-failures` carries `596b8d4`
(merge of checkpoint 5 into the deploy branch).

- **2026-08-25 — Staging deploy of checkpoint 5 is LIVE and verified.** Manual deploy
  triggered on `srv-da4tua3m8hqs73apsflg` (jetnine-api) via the Render API →
  `dep-da6u86jl550s73fepsn0`, commit `596b8d4`, build 18:51Z → **live 18:52:49Z**, no
  build or update failures. Post-deploy checks against `https://jetnine-api.onrender.com`:
  `GET /health` → `200 {"status":"ok"}` on a fresh instance (uptime 44s), `GET /ready` →
  `200 {"status":"ok"}`. Boot log shows `pnpm --filter @jetnine/db migrate` completing with
  only idempotent NOTICEs (citext / drizzle schema / `__drizzle_migrations` already exist)
  then `Migrations applied (schema + RLS).`, followed by a clean Nest boot (all modules
  initialized, routes mapped, Stripe in STUB mode as expected on staging). **Caveat on the
  0029/0030 check:** the old migrate script never named the migrations it applied, so the
  boot log proves "schema is at journal head, nothing pending" rather than naming
  `0029_variant_vendor_sku` / `0030_integration_sync_state` — both of which were in fact
  already applied by the 18:10Z deploy of `fe34e0a` (checkpoint 4) and are no-ops now.
  Fixed for every future deploy by the next item.
- **2026-08-25 — Deploy-log migration visibility (ops tooling):** `packages/db/src/migrate.ts`
  now counts `drizzle.__drizzle_migrations` rows before and after `migrate()` and maps the
  count into `drizzle/meta/_journal.json` tags, so each boot prints
  `Schema migrations: 31/31 applied, head=0030_integration_sync_state; this run applied
none (already up to date).` — or the explicit list of tags on a run that applies work —
  plus a `WARNING: N migration(s) still pending: …` line if the folder is ever ahead of the
  database. Verified against a throwaway Postgres 16 both ways (empty DB → all 31 named;
  re-run → "already up to date"); `packages/db` lint + typecheck + 14 RLS tests green.
- **2026-08-25 — Render service posture confirmed:** plan `starter` (`buildPlan: starter`,
  `numInstances: 1`, region oregon) — the spin-down problem stays fixed; `autoDeploy: yes`
  on branch `claude/fix-latent-int-spec-failures`. **Ops (unchanged, now the only reason
  deploys need a manual trigger):** the dashboard repo URL is still
  `https://github.com/AlwayzLegit/JetnineERP` — clones still resolve through GitHub's
  rename redirect (this deploy proves it), but the push webhook does not, so auto-deploy
  is dead until the URL is repointed to `AlwayzLegit/LA-Mattress-ERP` in
  Settings → Build & Deploy → Repository.
- **2026-08-25 — Old-store scope decision carried into the plan doc.** The Day 8 note above
  (codes 06/08/09 are closed stores; their 135 rows / 308 units are dropped, holdout file
  discarded) was tracker-only; D12 in `PLAN-STORIS-CUTOVER.md` still read "code 8 pending".
  D12 now records the exclusion as final, including that dropped-store rows are filtered
  during CSV prep and anything that slips through fails validation as `unknown location`
  rather than landing on a placeholder location.
- **2026-08-25 — Rehearsal #2 unblocking: Cowork runbook for the invoice register.** The
  sales-history export turns out to be a ~4 GB print-to-PDF invoice register. Since the
  wizard's `sale` entity is header-level (one row per invoice — no line items), the PDF is
  parseable locally: `docs/COWORK-INVOICE-REGISTER.md` is a complete runbook for a Cowork
  session with folder access to the PDF — text-layer probe, streamed `pdftotext` extraction,
  deterministic parser → `customers.csv` + `sales.csv` (exact wizard headers, store-code →
  name mapping, 06/08/09 dropped and counted), and five pass/fail verification gates anchored
  on the register's own printed grand totals. Data never leaves the local folder (D11/D8
  restated in the doc). **Ops:** put the PDF in a folder, point Cowork at it + this runbook.
- **Ops / blocked — server-side verification of the owner's two staging imports is NOT
  done, and the blocker is now root-caused.** The Render MCP connector itself is fine;
  `query_render_postgres` executes from the Claude remote session's sandbox, whose egress
  policy allows HTTPS:443 through the agent proxy only — raw-TCP database connections are
  explicitly unsupported (proxy docs: "Not supported through the proxy … raw-TCP
  databases"). Hence the signature: the TLS attempt's handshake is killed (`unexpected
EOF`) and the plaintext fallback reaches Postgres and is refused (`FATAL: SSL/TLS
required`). A raw-TCP probe to `dpg-da4ttsm417fc73di57eg-a.oregon-postgres.render.com:5432`
  from the sandbox confirms the block. The API-login fallback (seeded staging admin +
  `GET /v1/import/recon` over HTTPS) was denied by the session's permission classifier, so
  it needs an explicit user go-ahead. The recon numbers on record (product 6,909 ·
  inventory 1,505 · units 3,738) remain **owner-reported, not independently confirmed**.
  Fastest paths: (a) run `query_render_postgres` from a local Claude session (raw TCP
  works there), (b) paste the recon report JSON from Settings → Import during the QA
  pass, or (c) approve the staging-login curl in this session.

## Cutover session — Resend chain + bulk price entry (2026-08-26)

Two owner decisions taken this session (AskUserQuestion, on record):

1. **Resend sending domain is now the ROOT `a-prompt.ai`** — the owner deleted the
   `mail.a-prompt.ai` subdomain from HANDOFF §4a and created the root domain instead
   (id `e3b4a9d3-170d-4cc2-b082-6e7505b08ead`, us-east-1; the earlier "claimed in
   another account" 403 evidently resolved). Owner confirmed the root-name records
   (`resend._domainkey` TXT / `send` MX prio 10 / `send` SPF TXT — no `.mail` suffix)
   were saved at GoDaddy. Verification triggered and the domain reached **verified**
   (all three records) within ~20 min. Then, in order: sending-scoped API key
   `jetnine-api-render-sending` created restricted to that domain; `RESEND_API_KEY` +
   `RESEND_FROM_EMAIL` (`LA Mattress ERP <notifications@a-prompt.ai>`) set on
   `srv-da4tua3m8hqs73apsflg` (env update auto-triggered deploy
   `dep-da7kc6fqj5pc73835nvg`). The key was set **only after** the domain verified,
   per the HANDOFF §4a trap. Proof-of-delivery invite: see the note below once sent.

2. **Catalog prices will be set in-app** (not imported) — D12 register-side pricing
   stands; the owner chose manual entry over a retail-price file. To make 6,909
   zero-price variants feasible, this session shipped a **bulk price entry** slice:
   - API: `GET /v1/products/variants/pricing` (`products.view`; flat variant
     work-list joined to products, cursor-paginated by SKU, `unpricedOnly=1` filter,
     tsvector search, `unpricedCount` remaining-work counter, cost gated on
     `products.cost.view`) and `POST /v1/products/variants/bulk-price`
     (`products.update`; ≤200 `{id, priceCents}` per request, non-negative-integer
     validation, unknown-id 404, per-variant `product.variant.price.update` audit
     rows identical to the single-price PATCH, unchanged rows skipped, all on the
     request's RLS transaction).
   - Web: `/products/pricing` — "Unpriced only" on by default, search, inline
     new-price column with invalid-amount highlighting, batched save, remaining
     counter, Load more; "Set prices" button added to the Products page header.
   - Tests: catalog.int.spec.ts 10→16 (work-list shape + count, cashier cost
     redaction, permission gate, malformed/unknown rejects, bulk write + audit row +
     count drop). Gates by exit code: typecheck 0 · lint 0 · catalog spec 16/16 ·
     prettier 0.

## Owner-scoped build from the STORIS sysadmin handoff (2026-08-27)

The owner supplied a STORIS System Administration corpus digest (599-article index).
Direction confirmed by owner: **still migrating OFF STORIS** (the doc's conversion
machinery is inverted for us — treated as a feature inventory only); **no STORIS API
licensing** (§8 dropped). Build mandate picked by owner: **Brand/Collection and
warehouse bin locations only** (protection plans/warranty, credit hold stay backlog).
Both shipped as vertical slices:

- **Brands + Collections (migration `0049_brands_collections`):** `brands` and
  `collections` tables (RLS'd, unique name per business, deactivate-not-delete;
  collections optionally reference a vendor), `products.brand_id`/`collection_id`
  (set-null FKs). `/v1/brands` + `/v1/collections` CRUD in the catalog module —
  convention: list under `products.view`, mutations under `products.update` (no new
  permission; STORIS files these under Product Settings). Products create/PATCH/detail
  carry both ids. **P4 invoice Brand column now prints the real brand**, falling back
  to the variant's preferred vendor (the old v1 convention) for unbranded rows.
  Product detail page gained a Brand & collection card (selects + create-on-the-fly).
  catalog.int.spec 16→20.
- **Storage bins (migration `0050_storage_bins`):** `storage_bins` per location
  (unique code per location, uppercased, deactivate-not-delete) +
  `inventory_levels.storage_bin_id`. `/v1/inventory/bins` list/create/patch and
  `/v1/inventory/levels/assign-bin` (level must exist; bin must be an active bin of
  the same location) — mutations under `inventory.adjust`, all audited. Levels API +
  Inventory page carry the bin (per-row select + a bins management section);
  **the G15 pick list prints a Bin column** (stock location at the order's own store).
  inventory.int.spec 9→13; RLS suite green with both tables registered.

Gates by exit code: typecheck 0 · lint 0 (one `react/no-unescaped-entities` caught and
fixed pre-push — the checkpoint-9 lesson holding) · catalog+inventory+orders+RLS suites
all pass · prettier 0.

**Also received, pending owner direction:** a STORIS-style documentation-system handoff
(P0 scaffold prompt) — owner dismissed the kickoff question, holding until instructed;
and a reverse-engineered **Sales Processing behavioral spec** (docs/erp 00–13 +
SOURCES) whose fulfillment-centric order model diverges from the shipped order/delivery
model — flagged as a [DECIDE] for the owner before any rework. More handoffs incoming
per owner.

## Spec packs committed + Phase-0 parity mapping (2026-08-27)

Owner delivered two reverse-engineered STORIS behavioral spec packs (more announced):
**Sales Processing** (docs/erp/00–13 + SOURCES, from two identical zips) and
**Inventory Management** (docs/erp-inventory/00 + 05–08; its five big `sections/`
files and 99-source-index are still outstanding — the parity checklist is keyed to
their rule IDs and is blocked until they arrive). Both committed verbatim into the
repo as directed. Per both packs' own Phase-0 rule, `docs/erp/PARITY-NOTES.md` now
maps every pack entity to the shipped system and lists the conflicts as owner
decisions (C1 fulfillment-centric money · C2 costing layers · C3 bucket ledger ·
C4 piece identity · C5 physical inventory · C6 fractional qty · C7 vocabulary),
notes the pack questions the shipped system already answers, and recommends treating
the packs as post-cutover hardening backlog rather than a pre-cutover rebuild.
No code changed for this. The STORIS-docs documentation-system handoff remains on
hold (owner dismissed the kickoff question).

## Email is LIVE — invite delivered end to end (2026-08-27)

The HANDOFF §4a thread is closed. Chain executed in order: root `a-prompt.ai`
verified in Resend (owner's GoDaddy records, all three green) → sending-scoped API
key `jetnine-api-render-sending` (domain-restricted; token lives only in the Render
env) → `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (`LA Mattress ERP
<notifications@a-prompt.ai>`) set on `srv-da4tua3m8hqs73apsflg` → deploy
`dep-da7kc6fqj5pc73835nvg` live 20:03Z, boot log `Schema migrations: 49/49 applied…
this run applied none`. **Proof:** owner clicked Resend invite for
`me.lamattress@gmail.com` at 04:51:29Z — Render logged the POST 201 (595ms, real
API call, no inviteLink fallback in the response), Resend shows the message
**delivered** via SES on the verified domain. The key was set only after
verification, so the copy-link path was never broken. Production email works for
the first time. Ops next: accept that invite to create the manager/second account
(expires 2026-08-29 17:53Z), which unblocks browser-QA step 2.

## Accounting corpus received + invite-in-spam note (2026-08-27)

The full STORIS Accounting bundle landed and verified complete against its own
manifest — 307 verbatim articles (00-accounting 10 · views-and-reports 100 · GL 10 ·
payables 63 · receivables 124) + 5 digests + INDEX + manifest — committed at
`docs/erp-accounting/storis-docs/` and exempted from prettier so the verbatim
captures stay byte-faithful. Its HANDOFF is direction-agnostic enough to be useful
both ways; its §2 decision list and §6 risk register mostly concern loading INTO
STORIS and are moot for us, but the AR/in-house-financing articles (04-receivables)
are the reference if financing parity is ever scoped. Still missing from the
inventory pack: the five `sections/` files + `99-source-index.md`.

**Email deliverability:** the delivered invite landed in Gmail's SPAM folder —
expected for a domain with zero sending history. Owner should mark it "Not spam"
(trains Gmail for future invites); adding a DMARC record at GoDaddy
(`_dmarc.a-prompt.ai` TXT `v=DMARC1; p=none;`) would further help reputation — Ops,
optional.

## Improvement slice 1 — invoice lookup + daily-ops search (2026-08-27)

The owner green-lit ERP improvement work; slice 1 closes the top three findings
from the daily-ops audit (the "no way to find one sale among 73,899" hole):

- **Invoice lookup:** `GET /v1/sales` gains `q` — case-insensitive substring on
  the document number (a scanned receipt barcode types the full number and hits
  exactly, closing the print-only half of the G-era barcode feature) OR customer
  tsvector match — composing with the existing timestamp cursor. Rows now carry
  `customerName` (left-joined). Sales page rebuilt: autofocused scanner-friendly
  search box, Customer column (named / — / Walk-in), Load more.
- **Inventory search:** `levels` gains `q` over the variant+product tsvectors
  (name/SKU/barcode); Inventory page gains the search form.
- **Customers pagination:** the page finally uses the `nextCursor` the API always
  returned — Load more past the first 50 of 63k customers.

Tests: sales.int.spec +5 (full-number/scan path, fragment + customerName,
customer-name search, empty non-match), inventory.int.spec +1. Gates by exit
code: typecheck 0 · lint 0 · sales+inventory suites pass · prettier 0.

## Checkpoint 12 merged + deployed (2026-08-27)

PR #37 (bulk price entry · brands/collections · storage bins · invoice lookup +
inventory search + customers pagination · full spec-pack corpus + PARITY-NOTES)
squash-merged to main as `5422d99`, **CI 4/4 green first try**. Deploy branch
rolled (`66d3a95`), Render deploy `dep-da7t5llg1s2s73fassf0` **live 06:03Z** —
boot log: `Schema migrations: 51/51 applied, head=0050_storage_bins; this run
applied 0049_brands_collections, 0050_storage_bins.` + clean Nest start. Vercel
**production READY** on main `5422d99` (canonical host). Sprint branch restarted
from main.

**Live for staff now on `lamattress-erp.vercel.app`:** /products/pricing bulk
price entry (the 6,909-SKU pricing job can start), scan-to-find invoice lookup
on /sales, inventory search, brands/collections, warehouse bins on Inventory +
pick lists. Ops unchanged: repoint the Render repo URL (deploys still manual),
rotate the shared owner password, accept the manager invite (expires
2026-08-29 17:53Z), optional DMARC record.

## B14 shipped + FAQ-audit decisions recorded (2026-08-27)

Owner ruled on the three audit decisions: **B3 district pricing — skip entirely**
(D12 + G6 are the pricing model, final); **I2 restocking fee — none, P8 stands**;
**B14 — build the delivery-date reservation basis.** B14 shipped as a slice, and it
fixes the real hole behind the FAQ row: stock only ever reserved at order confirm,
so a "Pending" line stayed pending forever even when stock arrived.

- `ops_settings_json.reserveBasis` (`delivery_date` owner-default | `order_date`),
  validated in settings PATCH, editable in Settings → Store operations.
- `OrdersService.allocatePending`: fills under-reserved stock lines of open,
  unlocked orders from FREE stock only (never steals an existing reservation —
  flagged convention), priority = earliest `coalesce(line.delivery_date,
order.requested_date)` nulls-last under delivery_date, `created_at` under
  order_date; level rows locked FOR UPDATE; 500-line cap per run.
- `POST /v1/orders/allocate-pending` (`inventory.adjust`, dryRun supported,
  audited per order as `order.allocate_pending`).
- **Auto-run after PO receiving** (both fast and staged paths) for the variants
  just accepted — special-order allocations still take their linked units first.
  Transfer-receive/as-is-restock triggers + a nightly ride are follow-ups.
- Tests: orders.int.spec 56→61 (pending confirm, dry-run ranking, delivery-date
  fill, order_date flip via settings, PO-receive auto-backfill); business 24/24 +
  purchasing 27/27 re-run green. Gates by exit code: typecheck 0 · lint 0 ·
  prettier 0. Coverage matrix updated (B3/I2 intentionally-not-implemented, B14
  DONE).

## Checkpoint 13 — B14 merged + deployed; physical inventory shipped (2026-08-27)

PR #38 (B14) squash-merged on green CI (4/4), deploy branch rolled
(644e546), manual Render deploy triggered (dep-da7tpm9srm7s73dhr3h0) — no new
migration in B14, boot log verified below. Sprint branch restarted from main.

**Physical inventory (FAQ pack C1/B16, backlog #1) — built as a full slice.**
Soft-freeze counting: the store keeps selling during the count; posting nets the
post-freeze ledger delta out of every variance so a mid-count sale is neither
shrink nor double-deducted.

- Schema `0051_physical_inventory`: `physical_counts` (open→counting→
  posted/cancelled, one live count per location) + `physical_count_lines`
  (frozen snapshot, bin, counted qty, reason code, posted variance); RLS in
  both registries.
- API `/v1/inventory/counts`: list · create+freeze (snapshots non-empty levels
  with their bins; 409 on a concurrent count) · detail (variance = counted −
  (frozen + post-freeze delta), bin-ordered) · batch count entry ≤500 (found
  stock gets a zero-frozen line) · post (uncounted lines block unless
  `skipUncounted`; A9 coded-reason enforcement via new `physical_variance`
  class; writes `physical_count` movements + level upserts; a shortage that
  undercuts reservations records a **critical `physical_commitment` exception
  and never touches the reservation**; warning summary exception per posting)
  · cancel. Audits create/post/cancel.
- Web: `/inventory/counts` list + start-count, `/inventory/counts/[id]` entry
  grid with live variance, reason select, skip-uncounted post, cancel; "Count
  stock" from Inventory; blind bin-ordered count sheet at `/print/counts/[id]`
  with found-stock lines and signature blocks.
- Tests: inventory.int.spec 15→21 (permissions, freeze/409/empty-location,
  mid-count sale netting, A9 reason enforcement, found stock + skip, commitment
  exception with reservations intact, cancel). Gates by exit code: typecheck 0 ·
  lint 0 · test 0 · build 0 · prettier 0.

Ops unchanged: repoint the Render repo URL, rotate the shared owner password,
accept the manager invite (expires 2026-08-29 17:53Z), optional DMARC record.
Next backlog item: PO lifecycle corrections (no PO edit after order, no
un-receive) per the coverage-matrix ranking.

## PO lifecycle corrections shipped (2026-08-27)

Backlog #2 from the FAQ coverage audit: a draft PO was a dead end (no place
endpoint — could only be canceled), nothing on a PO could be edited after
creation, and a mis-keyed receipt was permanent.

- `POST /v1/purchase-orders/:id/place` — draft → ordered (403 otherwise),
  audited `purchase_order.place`.
- `PATCH /v1/purchase-orders/:id` (`purchase_orders.create`) — edit expected
  date, notes, line qty/cost; remove untouched, unlinked lines; add lines.
  Guards: immutable once received/canceled; qty never below received or below
  sales-order-committed units; removal blocked for received/linked lines; at
  least one line must remain; subtotal recomputed. Audited with before/after.
- `POST /v1/purchase-orders/:id/unreceive` (`purchase_orders.receive`) —
  backs N accepted units per line out of stock: `unreceive_po` ledger
  movement (never a silent edit), level decrement, received/inspected/
  accepted rolled back together, PO reopens (received → partially_received →
  ordered as counters allow, closedAt cleared). Refuses to cut into units
  committed to sales orders or reserved stock (free-stock-only, same
  convention as physical counts). Info exception `po_unreceive` + audit.
- Web (PO detail): Place order button on drafts; Edit order card (qty/cost
  inline, remove with guard disables, add item via POS lookup, expected date,
  notes); Correct-a-receipt card with per-line undo and notes.
- Tests: purchasing.int.spec 27→34 (draft dead-end fixed, place-once, edit +
  subtotal recompute, cashier 403, shrink-below-received / remove-received
  guards, immutability after receive, un-receive stock + ledger + reopen,
  over-accepted and reserved-stock guards). Gates by exit code: typecheck 0 ·
  lint 0 · test 0 · build 0 · prettier 0. No migration.

Next backlog item: return windows + no-original-invoice controls.

## Return windows + no-original returns shipped (2026-08-27)

Backlog #3 (FAQ I4 P0-MISSING, I1/I8 P0-PARTIAL).

- **Return window (I4, RTN-040):** `ops.returnWindowDays` (blank = no limit),
  Settings → Store operations. A return whose order is older (completedAt,
  else createdAt) hits the G11 security-override primitive on the new
  `returns.override_window` permission: Owner/Manager pass untouched, anyone
  else retries the same request under a manager's credentials and the
  override lands in the register. Web refund card catches OVERRIDE_REQUIRED
  and opens the standard override dialog.
- **No-original return (I1/I8, RTN-010/011, SEC-RTN-NOORIG):**
  `POST /v1/order-returns/no-original`, gated at point of action on the new
  `returns.no_original` permission (Owner/Manager; boot-time role sync
  backfills existing tenants). Controls, since it bypasses the original
  document: store-credit refund ONLY, goods staged in As-Is review (G10 —
  never silently sellable), the customer's claimed order number recorded
  verbatim, warning exception `no_original_return` per event + full audit.
  Numbered RMA-NOORIG-n, written completed in one step.
- Migration `0052_no_original_returns`: order_returns.order_id nullable +
  customer_id + referenced_order_number; order_return_lines.order_line_id
  nullable + variant_id + description. Null-guards added to the RMA receive
  path (no-original docs never sit authorized).
- Web: new **Returns** page (nav → Sell) — return-document register + the
  no-original entry form (customer pick-or-create, POS lookup line entry,
  live credit total, override dialog). Points staff at Sales invoice lookup
  first: all 71,246 imported STORIS invoices are refundable normally.
- Tests: orders.int.spec 61→65 (settings validation, in-window cashier pass,
  out-of-window OVERRIDE_REQUIRED → manager-credential retry → register row,
  owner silent pass, no-original gate + credit/as-is/exception/stock-
  untouched + register listing + validation); business 24/24 re-run. Gates
  by exit code: typecheck 0 · lint 0 · test 0 · build 0 · prettier 0.

Next backlog item: automatic replenishment transfers (FAQ J4/J5).

## Auto replenishment transfers shipped (2026-08-27)

Backlog #4 (FAQ J4/J5 — XFR-051/052/053, both P0-MISSING).

- **Trigger (XFR-051):** confirming a sales order (or re-running Reserve)
  whose stock lines are short at the order's own location now writes a
  **draft** transfer (`transferType='auto'`) from the sister location with
  the most free stock, linked to the order and capped at what's actually
  free. Generation is automatic, release stays manual — a person reviews
  and ships it, exactly the STORIS behavior. Dedupes against open auto
  transfers for the same order, so re-confirming never doubles up.
- **Gate (XFR-052):** `ops.autoScheduleDays` — blank = feature off, 0 is
  valid (= next day). Settings → Store operations.
- **Schedule (XFR-053):** `transfer_date = autoScheduleDays + today + 1`,
  rolled to the destination's next allowed weekday from the new
  per-location **replenishment days** (Locations page, clickable weekday
  badges; null = every day). An explicitly empty day set skips generation
  with a warning exception (`auto_transfer_skipped`) instead of looping.
  The STORIS worked example (created 4/6, days=2, Tuesdays-only → Tue
  4/14) is a verbatim unit test in `auto-schedule.spec.ts`.
- Migration `0053_auto_transfers`: `locations.replenishment_days_json`,
  `stock_transfers.scheduled_for` + `order_id` FK. Transfers list/detail
  carry type/scheduled/order; the Transfers page shows the auto badge,
  schedule date, and a link to the generating order (XFR-054 lean queue).
- Tests: auto-schedule.spec 4 unit tests (worked example verbatim, zero
  vs blank, no-roll case, empty-set null); transfers.int.spec 15→19
  (generation + schedule date + dedupe, blank-disables, empty-days skip +
  exception); orders 65/65 + business 24/24 re-run. Gates by exit code:
  typecheck 0 · lint 0 · test 0 · build 0 · prettier 0.

Next backlog item: costing program (PARITY-NOTES C2) — last of the ranked
five; needs an owner decision on costing method before build.

## Checkpoint 14 — ranked backlog complete through #4 (2026-08-27)

PR #42 (auto transfers) squash-merged on green CI, deploy branch rolled
(f628c04), Render deploy dep-da7vgsdg1s2s73fi5620 live — boot log verified
`54/54 applied, head=0053_auto_transfers; this run applied 0053`. Earlier
today: PR #38 (B14), PR #39 (physical inventory, 0051), PR #40 (PO
corrections), PR #41 (returns, 0052) all merged + deployed + boot-verified
the same way. Sprint branch restarted from main after each merge.

The FAQ-audit ranked backlog now stands: 1 physical inventory ✓ · 2 PO
lifecycle corrections ✓ · 3 return windows + no-original returns ✓ ·
4 auto transfers ✓ · 5 costing program — **blocked on an owner decision**
(FIFO cost layers for STORIS parity vs. weighted-average; asked 2026-08-27).

Ops unchanged: accept the manager invite (expires 2026-08-29 17:53Z),
repoint the Render dashboard repo URL, rotate the shared owner password,
optional DMARC record, missing inventory-pack sections/ files, docs-system
handoff still on hold.

## Sysadmin spec pack committed (2026-08-27)

`docs/erp-sysadmin/` — STORIS System Administration handoff, all 599 articles
(131 settings screens, 355 permission flags, the 48-step EOD batch), 44 files
verbatim (added to .prettierignore). The three loose uploads were byte-identical
to the zip. Corrections banner added to docs/erp-inventory-faq/README.md: this
pack **corrects the FAQ pack in 13 places** (C1–C13), six touching P0 rows.

Reconciliation against what's already built/decided:

- **C2/D6 price resolution order** — moot for us unless the owner wants STORIS
  pricing parity: owner locked D12+G6 as THE pricing model and ruled B3 (skip
  district pricing) on 2026-08-27. Our simpler model is a deliberate divergence,
  not an oversight. Confirming with owner.
- **C10/D13 reservation** — pack recommends Order Date + Immediate; owner
  explicitly chose delivery_date basis (B14, shipped). Owner ruling stands.
- **C13 permissions** — pack's live-evaluation/most-specific-wins model: our
  catalog + per-user overrides + security-override primitive already work that
  way (SEC-\* row was DONE ✓ in the FAQ audit); the 355-flag granularity is
  reference, not a rebuild mandate.
- **D14 auth** — better-auth already in place (their recommendation satisfied).
- **D3 multi-company** — the platform is multi-tenant by design; LA Mattress is
  one business. No COMPANY scope needed.
- **D5** — service module, delivery routing (G12 zipRoutes), shifts already
  exist in-app.
- **D8/D9 privacy/consent** — flagged to owner as needs-counsel (TCPA, erasure
  vs warranty retention). Ops item, not buildable by us.
- **Open with owner:** D1 (in-house credit vs third-party only — biggest
  descope), D10 costing method (already pending), D2 multi-currency,
  D4 region/district adoption.

Per the pack's own protocol, no code is being written against it until the
Tier 1/2 decisions are answered.

## FIFO costing program shipped (2026-08-27)

Backlog #5, unblocked by four owner decisions today: **third-party financing
only** (D1 — the pack's biggest descope), **FIFO costing** (D10), **keep our
pricing model** (C2/D6 moot — recorded as deliberate divergence), **no
multi-currency, no region/district scopes** (D2/D4).

- Migration `0054_fifo_costing`: `cost_layers` (variant+location, source,
  unit cost, received/remaining with check constraints) + `cost_consumptions`
  (one row per outflow×layer — the COGS audit trail); RLS in both registries;
  `stock_transfer_lines.unit_cost_cents` carries cost across transfers.
- `CostingService` (new costing module): `addLayer` (C9 — a $0 layer is never
  silent, every one records a `zero_cost_layer` exception), `consume` (FIFO
  oldest-first, `preferReferenceId` so a PO un-receive backs out its own
  receipt), `valuation`. **Pre-costing stock needs no backfill**: when
  consumption outruns the layers, the shortfall synthesizes a fully-consumed
  `opening` layer at the variant's catalog cost — correct going forward.
- Hooks at every stock boundary: PO accept (layer at PO line cost) ·
  PO un-receive (same-PO layers first) · order fulfillment (COGS) · POS
  walk-out sale · manual receive/adjust (catalog cost / FIFO by sign) ·
  physical-count overage/shrink · transfer ship (consumes origin, stamps
  weighted cost on the line) / receive (layers destination at that cost) ·
  as-is restock. Catalog `cost_cents` remains the replacement-cost fallback.
- Inventory valuation report is now FIFO: layered stock at actual layer
  costs, pre-costing remainder at catalog cost.
- Tests: purchasing 34→36 (receipt layer, un-receive backs out own layer +
  consumption row), orders 65→68 (opening-layer synthesis at catalog cost,
  FIFO before synthesis, C9 zero-cost exception); transfers 19, inventory 21,
  sales 21, reports 14 re-run green. Gates by exit code: typecheck 0 ·
  lint 0 · test 0 · build 0 · prettier 0.

**The five-item ranked backlog from the FAQ audit is now complete.**

## Checkpoint 15 — FIFO costing live; ranked backlog COMPLETE (2026-08-27)

PR #43 squash-merged on green CI, deploy branch rolled (c4d2f8f), Render
deploy dep-da806bhsrm7s73dnroug live — boot log verified `55/55 applied,
head=0054_fifo_costing; this run applied 0054`. Sprint branch restarted
from main.

All five FAQ-audit backlog items are now shipped, deployed, and
boot-verified in one day: physical inventory (0051) · PO lifecycle
corrections · return windows + no-original returns (0052) · auto
replenishment transfers (0053) · FIFO costing (0054). Owner decisions
D1/D2/D4/D10 + pricing-parity divergence recorded above.

Open threads: sysadmin-pack follow-ups beyond the descopes (settings
registry, audit-stream and batch-runner substrate designs in
docs/erp-sysadmin/03–05 — unscheduled, awaiting owner priorities); the two
needs-counsel items (TCPA consent, erasure vs warranty retention); standing
ops items (manager invite expires 2026-08-29 17:53Z, Render repo URL,
owner password rotation, DMARC). To make costing accurate on day one:
keep variant catalog costs current — they price the opening layers.

## EOD batch runner shipped (2026-08-27)

EOD-001 (P0 cross-cutting rollup) built to the sysadmin pack's JOB-002 spec —
deliberately the opposite of STORIS's Generate Daily Reports:

- **Declared step registry** the operator can see (`GET /v1/jobs`), each step
  with explicit order, dependencies, and a destructive flag (none are).
- **`job_runs` log (migration 0055):** one row per (business, job, business
  date) — status, duration, records affected, detail, error. The unique key
  IS the idempotency: re-running a date never repeats a succeeded step.
- **Explicit business dates:** the hourly scheduler fires after 2am
  business-local (JOB-003: never at the date boundary), and catch-up runs
  ONE PASS PER MISSED DATE (7-day window) — days are never collapsed.
- **First registered jobs:** `po_overdue_sweep` (open POs past expected date
  → warning exceptions, deduped) · `auto_replenishment` (REPL-040: drafts one
  PO per preferred vendor for variants at/below reorder point, netting out
  quantities already on open POs; gated on new `ops.autoReplenishmentEnabled`,
  off by default; drafts only — a buyer reviews and places, same convention
  as auto transfers) · `transfer_aging` (in-transit > 3 days → exceptions).
- Shared `computeReorderSuggestions` extracted from the PO controller so the
  interactive endpoint and the nightly job can't drift.
- Web: **Nightly jobs** page (nav → Insights) — the registry, the morning run
  report, and a safe "Run now" for any business date. Settings gains the
  auto-replenishment checkbox.
- Tests: purchasing.int.spec 36→39 (registry shape, run drafts the netted
  replenishment PO + flags the overdue PO + writes the run report, per-date
  idempotency with no duplicate drafts, gate-off no-op). Gates by exit code:
  typecheck 0 · lint 0 · test 0 · build 0 · prettier 0.

## Floor samples + serial transfer pieces shipped (2026-08-27)

FAQ J2 (P1-PARTIAL) and J3 (P1-MISSING), the last flagged transfer gaps.

- **J2 (XFR-030/STK-020):** `inventory_levels.floor_sample` (migration 0056)
  — units physically on hand but never sellable as new. Receiving a
  `floor_sample`-type transfer nails the received units down automatically;
  a manual hold (`POST /v1/inventory/levels/floor-sample`, clamped to
  on-hand, audited) covers the walk-up case. **Available stock is now
  `on_hand − reserved − floor_sample` in all eight places that compute
  it**: reservation planning (stockLevels nets it once for planReservations
  - allocatePending), POS lookup, levels endpoint, stock report, auto
    transfers, reorder suggestions/auto-replenishment, and PO un-receive's
    free-stock guard. Inventory page shows a Floor column with click-to-set.
- **J3 (XFR-040):** `stock_transfer_lines.serial_ids_json` — named pieces
  ride the transfer. Create validates each piece (real, in stock at the
  origin, right variant, no repeats, ≤ quantity); ship flags them
  `in_transit`; receive re-homes them at the destination in listed order up
  to the received quantity — as `floor_sample` when the transfer is one.
  Serial status vocabulary gains `in_transit` + `floor_sample`.
- Tests: transfers.int.spec 19→24 (ride-along lifecycle, wrong-location and
  duplicate-pick refusals, floor-sample nailing with availability math
  asserted through the levels endpoint, manual-hold clamp + reversal);
  inventory 21, orders 68, sales 21, purchasing 39 re-run green. Gates by
  exit code: typecheck 0 · lint 0 · test 0 · build 0 · prettier 0.
  Follow-up noted: serial picker UI on the transfer form (API-complete).

## Checkpoint 16 — J2/J3 live; ALL TRACKED TASKS COMPLETE (2026-08-27)

PR #45 squash-merged on green CI (one e2e fix along the way: the new Floor
column shifted the inventory table's column indexes — orders.spec.ts
updated), deploy branch rolled (cdf3023), Render deploy
dep-da815b1srm7s73dqassg live — boot log verified `57/57 applied,
head=0056_floor_samples_serials; this run applied 0056`. The serial-piece
picker UI shipped in the same PR, so J3 is API- and UI-complete.

Today's full run, every one merged + deployed + boot-verified: B14 (#38) ·
physical inventory (#39, 0051) · PO corrections (#40) · returns (#41, 0052)
· auto transfers (#42, 0053) · FIFO costing (#43, 0054) · nightly batch
runner (#44, 0055) · floor samples + serial transfers (#45, 0056).

Remaining candidate work is genuinely optional and needs owner priorities:
H2 wrong-vendor RTV guidance (P2) · I7 direct-ship vendor PO with customer
ship-to (P2) · as_is-type transfer receiving into As-Is review · sysadmin
substrate designs (settings registry, RPT-AUDIT stream, report builder) ·
needs-counsel privacy items (TCPA consent, erasure policy). Ops items
unchanged — the manager invite expires 2026-08-29 17:53Z.

## As-Is transfer intake + H2 RTV unwind (2026-08-27)

- **as_is consolidation transfers now stage in review, not stock** (§10
  invariant: damage never silently becomes sellable). Receiving an
  `as_is`-type transfer writes no `transfer_in` movement, no level bump,
  and no cost layer; instead each unit becomes an As-Is review piece
  (`source: 'transfer'`, `referenceType: 'stock_transfer'`, piece number
  `AS-XXXXXXXX`) at the destination, waiting in the pending_review queue.
  Named serial pieces land as `returned`. Stock and valuation re-enter
  only through a review disposition (restock / vendor return / scrap) —
  the restock path already carries its own movement + FIFO layer. No
  migration: `source`/`referenceType` are doc-typed text columns.
- **H2 (RTV-020/021): wrong-vendor RTV unwind** — `POST
/v1/as-is/:id/reopen` (inventory.adjust) flips a `vendor_return` piece
  back to `pending_review`, voids the R/A + credit chase, clears the
  reviewer stamp, audits (`as_is.reopen`), and records an `rtv_reopened`
  info exception. Guarded: only a vendor_return piece reopens, and a
  credit already `received` blocks the unwind (reverse it with the vendor
  first — money is involved).
- Tests: transfers.int.spec 24→29 (as_is receive stages pieces + leaves
  sellable stock and the movement ledger untouched, staged piece restocks
  through normal review, RTV unwind round-trip + both refusal guards).
  Gates by exit code: typecheck 0 · lint 0 · test 0 · build 0 · prettier 0.

## I7 / PO-060 — direct-ship vendor POs (2026-08-27)

- **Migration 0057_direct_ship**: `purchase_orders.direct_ship` boolean +
  `ship_to_json` (customer ship-to snapshot). `order_lines.line_type`
  gains `direct_ship` (doc-typed text — no constraint change).
- **Order side**: direct_ship lines never reserve (order-math skips them
  like special_order); the manual fulfill endpoint and delivery
  scheduling exclude them (they ride the vendor's truck). New
  `PATCH /v1/orders/:id/lines/:lineId {lineType}` flips a line between
  stock / special_order / direct_ship on a live order — releasing or
  re-reserving stock — refused once fulfilled or carried by a PO.
- **Queue → PO**: the to-order queue includes direct_ship lines (flagged);
  generate-PO refuses to mix them with stock-bound lines or span two
  orders, and stamps the PO `directShip` with a ship-to snapshot (name,
  phone, address from the customer file + our SO number). The printed
  vendor document's Ship-to block becomes the customer's address.
- **Receipt = fulfillment**: receiving a direct-ship PO writes NO
  movement/level; a cost layer at PO cost is consumed on the spot
  (`direct_ship` consumption → COGS posted, valuation net zero); the
  allocation flips received, the order line's qty_fulfilled rises, order
  status recomputes via deriveFulfillmentStatus, and the customer gets
  "your order is on its way". Dock rejects and un-receive are refused on
  direct-ship POs (problems are customer returns).
- Tests: special-orders.int.spec 7→13 (flip releases reservation; queue +
  ship-to snapshot; mixing refusal; zero-stock receipt with COGS
  assertion on layers/consumptions; unreceive + reject + relock guards;
  fulfilled-line guard); orders 68, purchasing 39, deliveries 17 re-run
  green. Gates by exit code: typecheck 0 · lint 0 · test 0 · build 0 ·
  prettier 0.

## Checkpoint 17 — direct ship live; UPLOADED-PACK BACKLOG COMPLETE (2026-08-27)

PR #46 (as-is transfer intake + H2 RTV unwind) and PR #47 (PO-060/I7
direct-ship vendor POs, migration 0057) both squash-merged on green CI,
deploy branch rolled (02d681f), Render deploys dep-da81tapsrm7s73ds6k20 and
dep-da827j8ae00c73agve80 live — final boot log verified `58/58 applied,
head=0057_direct_ship; this run applied 0057_direct_ship`.

**Every buildable item from the uploaded packs (55-row inventory FAQ +
599-article sysadmin pack) is now built, merged, deployed, and verified.**
Tracked tasks #1–#16 all complete.

Not buildable / owner-gated leftovers:

- Optional substrate extras the sysadmin pack marks nice-to-have (settings
  registry admin UI, report builder) — build on owner request.
- Needs-counsel privacy items (TCPA consent wording, erasure/retention
  policy) — owner + lawyer, not code.

## Enter an Exchange — container over two documents (2026-08-27)

Owner uploaded the STORIS "Enter an Exchange" pack (committed verbatim at
`docs/erp-exchange/`, 8 files). Built per its build plan, as a composition
over the existing returns + order machinery (the pack's own instruction):

- **Model (migration 0058_exchanges)**: `exchanges` container — number
  EX-YYYY-NNNNNN, returnId + saleOrderId (both unique), originalOrderId /
  referencedOrderNumber, status on_hold|open|completed|split|cancelled,
  evenExchange, restocking fee (+sticky overridden flag), per-leg return
  salesperson, approval stamps. Split Exchange = container dissolve; the
  legs are already first-class documents. RLS + tenant registration.
- **Settlement rides the store-credit ledger**: receiving the exchange's
  return issues the credit (minus restocking fee) and immediately redeems
  it against the replacement order's balance — every cent reconciles
  through existing ledgers; excess stays as visible store credit. The
  plain-refund path in OrderReturnsService diverts only while a live
  container exists; split/cancel restores it. Commission clawback and
  As-Is staging unchanged (shared path).
- **API**: POST /v1/exchanges (bind; validates same-customer, financed-
  original ⇒ even-exchange-only per D1, like-for-like check, fee compute/
  override, E1 hold via ops.exchangeHoldAtEntry) · :id/approve ·
  :id/split · :id/cancel · list/detail with settlement math. New
  permissions exchanges.create / exchanges.approve /
  exchanges.restocking_fee.override (Owner+Manager via catalog).
- **Ops settings**: restockingFeePercent, exchangeHoldAtEntry (+ Settings
  page inputs). Orders list gains ?number= exact recall.
- **Web**: /exchanges list, /exchanges/new writer (find original → pick
  return pieces → replacement w/ even-exchange copy → settle-now toggle),
  /exchanges/[id] detail (settlement block, approve/split/cancel/receive),
  nav entry, order-detail "Write exchange" now routes here.
- **Deliberate divergences from STORIS** (recorded per pack conventions):
  exchange refund excess settles as store credit (not cash-back); both
  legs must bill the same customer; no-original exchanges carry no
  restocking fee (already loss-prevention flagged + store-credit-only);
  protection-plan transfer rules N/A (no plan object — plans are ordinary
  product lines here); revolving financing/C6 holds not built (owner D1:
  third-party only); vendor imports (2020 Spaces/Flexsteel/Pro Kitchen)
  skipped — furniture-configurator integrations.
- Tests: NEW exchanges.int.spec (8) — uneven happy path with ledger-net
  assertions, restocking fee + sticky override + audit, E1 hold blocks
  settlement until approve, financed-original even-only + like-for-like,
  split restores plain refund, cancel voids both, no-original banked
  credit at bind, same-customer guard. orders 68 · business 24 · sales 21
  re-run green. Gates by exit code: typecheck 0 · lint 0 · test 0 ·
  build 0 · prettier 0.

## Sysadmin substrate — RPT-AUDIT + settings registry (2026-08-27)

The "after" half of the owner's instruction (exchange pack, then sysadmin
pack). Built the buildable substrate items from docs/erp-sysadmin:

- **AUD-004 — denials are events**: PermissionGuard now writes every 403
  to the audit stream (`permission.denied`, route + missing permissions,
  explicit businessId through the root handle since guards run before the
  RLS request context). Denial patterns are the pack's loss-prevention
  signal.
- **AUD-006 + AUD-003 — queryable, exportable, and reads leave traces**:
  `GET /v1/audit-logs/export.csv` (same filters as the list, 10k cap,
  newest-first) and the export itself is audited (`audit.export`). Export
  button on the Audit page.
- **SET-007 + SET-002 — registry as data**: `GET /v1/business/settings/
registry` serves the declared registry (key, label, type, explicit
  `nullMeans` for every setting — no implicit tri-state — class tags,
  read-by). The Settings page renders a reference table from it.
- Deliberate scale-down (recorded): no multi-scope resolver (SET-001) —
  our settings model is deliberately flat per the owner-approved triage;
  SET-004 already holds (no kill-switch exists); settings writes were
  already audited (SET-006).
- Tests: audit.int.spec 4→7 (denial event, CSV export + its audit trace,
  registry completeness incl. TRISTATE tags); business 24, tenancy 8
  re-run green. Gates by exit code: typecheck 0 · lint 0 · test 0 ·
  build 0 · prettier 0.

## Checkpoint 18 — Enter an Exchange + sysadmin substrate LIVE (2026-08-27)

PR #48 squash-merged on green CI (one CI-infra fix along the way: the
workflow never provisioned the new jetnine_exchanges test database — env
var + createdb added; 576/589 tests had passed around it). Deploy branch
rolled (65319a5), Render deploy dep-da83425g1s2s73fs1qtg live — boot log
verified `59/59 applied, head=0058_exchanges; this run applied
0058_exchanges`.

The owner's exchange pack (docs/erp-exchange, 8 files) is fully built:
container model, ledger settlement, restocking fee, E1 hold,
financed-original even-exchange rule, split, cancel, no-original path,
writer/detail/list UI. The sysadmin pack's buildable substrate is done:
AUD-004 denial events, AUD-006 CSV export (AUD-003 audited), SET-007
registry endpoint + reference UI. Tasks #17 and #18 complete — the
uploaded-pack backlog is again at zero.

Remaining non-build items (unchanged): needs-counsel privacy items (TCPA
consent wording, erasure/retention policy) — owner + lawyer; a full
report-builder surface remains deliberately unbuilt (the pack's own
recommendation is the RPT-\* registry consolidation we already follow).

## Hardening — self code-review of PR #48, 10 findings fixed (2026-08-27)

Ran a high-effort code review over the exchange + audit-substrate merge;
all 10 findings fixed and regression-locked:

1. **Money (P0): exchange credit capped at collected.** The settlement
   branch bypassed the plain path's refund-exceeds-collected guard — a
   delivered-but-half-paid original minted full-face credit. Now
   `min(returnAmount, paidCents(original))`, with an
   `exchange.credit_capped` audit row when the cap bites. Exchange legs
   authorize as store_credit (writer + tests), so a later split falls
   back to credit, never cash out.
2. **Re-bind after mistake (migration 0059)**: the unique return/order
   indexes became partial (`status NOT IN ('split','cancelled')`) and the
   taken-check is status-aware — a cancelled or split container releases
   its legs for a corrected exchange.
3. **E1-hold UX**: the writer skips settle-now on an on_hold exchange and
   always lands on the exchange page; a receive hiccup no longer strands
   the cashier on the form.
4. **No duplicate documents**: the writer remembers the created
   replacement + RMA and reuses them when a failed bind is retried.
5. **CSV formula injection**: audit export prefixes leading =+-@/tab/CR
   with an apostrophe.
6. **AUD-004 attribution**: API-key denials record actorType 'api_key' +
   the key id; impersonator carried.
7. **Number race**: exchange insert retries with a fresh number on
   23505; random fallback zero-padded.
8. **Webhooks (CLAUDE.md convention)**: five new catalogued events —
   exchange.created/approved/settled/split/cancelled — fired from bind,
   approve, split, cancel, and both settlement paths.
9. **Status freshness**: lazy-completion runs on the list too, and
   hydrate no longer double-fetches (notes/salesperson folded into the
   base select).
10. **Credit preview accuracy**: the writer previews per-unit credit as
    (line total + tax)/qty — the server's exact formula — instead of the
    list price.

Tests: exchanges.int.spec 8→10 (credit-cap with audit assertion; cancel →
re-bind same order), audit.int.spec 7→8 (CSV injection guard). orders 68 ·
webhooks 13 re-run green. Gates by exit code: typecheck 0 · lint 0 ·
test 0 · build 0 · prettier 0.

## Checkpoint 19 — hardening live; queue empty (2026-08-27)

PR #49 squash-merged on green CI, deploy branch rolled (06033c6), Render
deploy dep-da86n8id0e5s739r1ieg live — boot log verified `60/60 applied,
head=0059_exchange_partial_unique`. Vercel production picked up main.
All 19 tracked tasks complete: both uploaded packs built, the sysadmin
substrate live, and the post-merge self-review's 10 findings (incl. the
exchange credit-cap money bug) fixed and regression-locked in production.

Nothing buildable remains queued. Owner-side only: needs-counsel privacy
items (TCPA consent wording, erasure/retention policy).

## Pagination sweep — owner report → 2 workflows → system-wide fix (2026-08-27)

Owner reported Products showing only one page. Ran a 10-agent audit
workflow over every list surface (81 findings: 15 high / 19 medium / 47
confirmed fine), then a 10-agent fix workflow, gated centrally:

- **Shared client primitives**: `useCursorList` hook (generation-guarded
  against stale responses) + `LoadMore` control; the house pattern from
  the customers page, now reusable everywhere.
- **Pages that dropped the cursor, fixed**: Products, Gift cards, Audit
  log, inventory-receive picker.
- **Eight capped-array endpoints converted to the PageResponse cursor
  contract** (+ their pages wired with Load more, + every test/consumer
  updated): /v1/as-is (was 200) · /v1/exchanges (200) · /v1/order-returns
  (200) · /v1/cash-shifts (50) · /v1/purchase-orders (50) ·
  /v1/stock-transfers (50) · /v1/service-orders (300) · /v1/exceptions
  (200) · /v1/inventory/counts (100).
- **Picker caps de-silenced**: POS Add-Product browse 30→100 with a
  refine hint; label/transfer/exchange/return lookups request limit=200
  with truncation cues; customer typeaheads 8→20 with "keep typing";
  draft chips 10→30; webhook delivery history 50→200.
- Confirmed fine (deliberate): reports fetch complete data; bounded sets
  (locations, roles, tax classes, categories, bins) stay unpaginated.
  Deferred with notes: /v1/inventory/levels full-location fetch,
  deliveries week view (500), commissions report caps (period-filtered),
  admin templates (100), marketing tags ordering.
- One straggler the agents missed (an /v1/exceptions read in orders spec)
  caught by the central gate run and fixed.
- Tests: exchanges 10 · orders 68 · transfers 29 · purchasing 39 ·
  sales 21 · controls 22 · closeout 4 · service-crm 8 · inventory 21 all
  green. Gates by exit code: typecheck 0 · lint 0 · test 0 · build 0 ·
  prettier 0.

## Checkpoint 20 — pagination sweep LIVE; all 20 tasks complete (2026-08-27)

PR #50 squash-merged on green CI (main 84eb3af), deploy branch rolled
(3361981), Render deploy dep-da87ke2jnfac73d27fng live — boot log
verified `Schema migrations: 60/60 applied,
head=0059_exchange_partial_unique; this run applied none` (correct: no
migration in this PR). Vercel production READY on main 84eb3af
(dpl_8bD1fdMSqnWHafhydxAwRuTEzyW9), so the web side (Products,
Inventory, and every converted list page) is serving the Load-more UI.

All 20 tracked tasks complete. Queue holds nothing buildable. Remaining
items are owner-side only:

- Policy values awaiting owner: restocking fee %, E1 hold-at-entry,
  return window, delivery auto-schedule days, auto-replenishment.
- Needs-counsel privacy items: TCPA consent wording, retention/erasure.
- Deferred pagination mediums (noted in the sweep section above):
  /v1/inventory/levels full-location fetch, deliveries week view,
  commissions report caps, admin templates, marketing tag ordering.

## Users & Security docs domain — §10 kickoff (2026-08-27)

Owner uploaded `HANDOFF-users-and-security.md` (STORIS Users, Roles &
Security — first content domain for the STORIS docs system). Executed its
§10 kickoff exactly (5 deliverables, then stop):

- `docs/HANDOFF-users-and-security.md` — handoff committed verbatim
  (prettier-ignored like the other packs).
- `docs/settings/general-system-control-settings.md` — security-relevant
  fields from §2/§3; every value TBD — unverified, status: draft.
- `docs/processes/user-access-model.md` (the eight layers) +
  `docs/processes/login-chain.md`, both ending with the required
  "Settings that control this process" section.
- `docs/erp/system-administration/user-settings/create-a-user.md` —
  field-per-entry across all four tabs in screen order (37 entries), each
  carrying a Documented / "Unverified — needs test in Learn" status.
- `docs/decisions/d1…d10` — ten ADR stubs, status: proposed, each with
  decision, recommended default, and verify-first list.
- `docs/open-questions.md` — the five source contradictions, each with the
  exact test and environment.

**Divergence, flagged:** the paired spec `docs/STORIS-DOCS-HANDOFF.md`
(authoring rules, P0 scaffold, six scripts) was never uploaded to this
repo. Conventions were inferred from the handoff itself and enforced by an
interim validator, `docs/scripts/validate-user-security-docs.mjs`
(frontmatter, required sections, ADR count/status, per-field status lines,
link integrity — exit 0). **Ops:** owner to upload STORIS-DOCS-HANDOFF.md
so frontmatter/scripts can be retrofitted to the real spec before Phase 2.
Per the handoff: run the five §7 Learn tests before authoring more
articles; remaining screen articles and the role matrix are deliberately
NOT started.

## Sales Views & Reports pack — partial upload committed (2026-08-27)

Owner uploaded 5 of the 7 files of the STORIS "Sales Views and Reports"
handoff (139 articles: reporting platform, 18-picker shared components,
customer 360 inquiries, operational inquiries). Committed verbatim to
`docs/erp-sales-views/` (prettier-ignored). **Ops:** per the pack's own
read-order, `05-report-catalog.md`, `06-cross-cutting-rules.md`, and
`07-build-plan.md` (phasing, acceptance criteria, what to cut) were not
uploaded — build does not start until they arrive.

## Sales Views & Reports — pack complete + Phase 0 triage (2026-08-27)

Owner uploaded 05-report-catalog, 06-cross-cutting-rules, 07-build-plan (zip
verified byte-identical for 00–04). Pack complete at `docs/erp-sales-views/`.
Authored `PHASE0-TRIAGE.md` answering the build plan's seven Phase 0
decisions: one surface not two (decided by architecture); no Regional
Processing port (RLS + permission catalog); fixed layouts, no panel registry
in v1; reports stay pure reads (EOD never mutates via reports); contradictions
mostly moot; ATP partial (reservation basis + PO dates, no full projection).
63-report triage: ~13 keep (merged into fewer surfaces), 3 already covered
(exceptions queue, physical inventory, void integrity), rest dropped per
locked decisions (no in-house financing, no protection plans, no leads/CRM).
**Ops — owner confirms before Phase 5:** the keep/drop table; per-user
location/data scoping (self/store/all axis); marketing attribution wanted?;
lightweight AP (vendor bill/credit) in scope for received-not-billed /
RTV-not-credited queues?; ATP projection scope.

## Phase 0 locked + Delivery Ticket Reprints pack committed (2026-08-27)

Owner answered all five Phase 0 questions on the Sales Views pack (recorded
in `docs/erp-sales-views/PHASE0-TRIAGE.md`): keep/drop table confirmed;
salespeople scoped to **their store's** numbers; marketing attribution
wanted (capture code on orders); no mini-AP (received-not-billed /
RTV-not-credited queues dropped); ATP stays partial. Build starts at
Phase 1 (data-scope substrate) — note `membership_location_scopes` already
exists in schema, currently read only by locations.controller.

Owner also uploaded the **Delivery Ticket Print & Reprint** pack (9 files,
zip verified against loose uploads) — committed verbatim to
`docs/erp-delivery-reprints/` (prettier-ignored). Its 02 state machine is
normative with STORIS-published acceptance tests in 07 to port first.
Queued after the Sales Views build.

## Sales-Rate PO Replenishment pack committed (2026-08-27)

Owner uploaded the sales-rate replenishment handoff (STORIS "Replenish
Stock Inventory Based on Sales Rate") — committed verbatim to
`docs/HANDOFF-po-replenishment-sales-rate.md`. One pure calculation engine
for EOD/on-demand/scheduled (T-31 identical-numbers is the key test), 32
acceptance tests, 11 open questions (several self-decidable, e.g. sold −
returned; the rest flagged when built). Supersedes/extends the existing
min-based auto-replenishment PO drafts. Queued after delivery reprints.

## Sales Views Phase 1 — store-level data scope (2026-08-27)

Owner-confirmed decision 2 built as substrate before any report work:

- `memberships.data_scope` ('all' | 'store', migration
  0060_membership_data_scope); a 'store' member's visible locations come
  from the previously-dormant `membership_location_scopes` table, loaded
  once per request into the tenant context by the tenancy guard.
- `salesScopeCond()` (`apps/api/src/common/sales-scope.ts`) — one WHERE
  fragment ANDed into every sales-dollar surface: orders list, POS sales
  list, cash-shifts list, reports sales/daily + by-product + by-category,
  the Z-report (all five sub-queries incl. the tender COALESCE), and the
  morning dashboard. Empty scope list = FALSE (fail closed, never open);
  a caller-requested locationId outside scope intersects to zero rows.
- Members page: per-member "Sales data" control (All locations / Their
  store only + store checkboxes, warning when none selected); PATCH
  /v1/business/members/:id accepts dataScope + scopeLocationIds
  (validated against the business, audited before/after).
- reports.int.spec +7 tests (owner-vs-scoped diff = exactly the other
  store's dollars; out-of-scope Z request → zero; empty scope → nothing;
  scope restore round-trip). 21/21.

Also committed the **STORIS Selling Location pack** (8 files,
`docs/erp-selling-location/` — 4 independent tracks + a shared lookup
control per its README; queued). Note: container restart had wiped 17
per-suite test DBs (jetnine_admin …) — recreated; full `pnpm test` green.
Gates by exit code: typecheck 0 · lint 0 · test 0 · build 0 · prettier 0.

## Checkpoint 21 — store data scope LIVE (2026-08-27)

PR #52 squash-merged on green CI (main 102b6ed), deploy branch rolled
(8c90245), Render deploy dep-da88tm0n74is739t3i2g live — boot log
verified `Schema migrations: 61/61 applied,
head=0060_membership_data_scope; this run applied
0060_membership_data_scope.` Vercel production READY on main 102b6ed.
Store-scoped members now see only their store's sales data end to end.
Cleanup commit 940532e relocated the selling-location pack + tracker
note that a cwd slip had put under apps/api/. Next slice: unified
written/delivered sales report (Phase 1 dimension + catalog section A
merge).

## Unified sales summary — written vs delivered (2026-08-27)

Catalog section A's four sales-dollar reports merged into one surface
with written/delivered as a first-class dimension (pack 01/06):

- `GET /v1/reports/sales/summary?basis=written|delivered&groupBy=day|
location|salesperson&start&end&format=csv` — POS sales + sales orders
  in one result; imported excluded (D8); store data scope applies; CSV
  embeds provenance (`# basis=… generated=…`, pack's run-time-options
  echo). Average merchandise counts documents, never
  document-salesperson pairs (Report Average Value rule).
- Written = documents dated by entry time, orders in any non-draft/
  quote/cancelled status; Delivered = completed documents by completion
  time. **Deliberate divergence:** written uses the document's CURRENT
  totals — no at-entry snapshot exists, so later edits fold into the
  written figure instead of listing as separate adjustment records
  (STORIS's Written Business/BTA adjustment ledger is not ported).
- Reports page gains the "Sales summary — written vs delivered" card:
  basis + group-by selectors, shared date range, stat row, CSV.
- reports.int.spec 21→25 (written−delivered == exactly the open orders;
  location labels + per-location totals; scope diff == Annex dollars;
  avg + CSV provenance). Gates: typecheck 0 · lint 0 · test 0 (full) ·
  build 0 · prettier 0.

## Delivery Dates in Jeopardy — the call list (2026-08-27)

Catalog 85, the pack's top-value operational screen, built as a live
queue over what we have (owner-confirmed ATP decision — reservations +
inbound supply dates, no full ATP projection):

- `GET /v1/reports/delivery-jeopardy?horizonDays=N` — open order lines
  with unreserved shortfall, promised date resolved line.deliveryDate →
  earliest live scheduled delivery → order.requestedDate (lines with no
  date anywhere are excluded, the ASAP/CWC rule). Inbound supply per
  variant+location = earliest of open POs (expected date) and
  draft/in-transit transfers (scheduled date). **Explicit risk states —
  `no_supply` vs `late` (+days) — never the 999 sentinel.** Covered
  lines drop out. Store scope applies; CSV embeds provenance.
- New "At risk" page (`/jeopardy`, Sell nav): promised date, order link,
  customer, shortfall, risk badge, inbound supply reference.
- reports.int.spec 25→27 (no-supply vs late-by-8-days vs covered
  fixtures; horizon bound). Gates: typecheck 0 · lint 0 · test 0 (full)
  · build 0 · prettier 0.

## Transfers pack committed (2026-08-27)

Owner uploaded the STORIS Transfers handoff (16 files — all 22 section
articles: domain model, settings, permissions, entry + variants,
distributed + multi-leg transfers, manifests, receiving, replenishment,
scheduling, inquiries, acceptance tests, phased build plan). Committed
verbatim to `docs/erp-transfers/` (prettier-ignored). Note: Jetnine
already has a transfers module (entry, ship/receive, serials, as-is +
floor-sample variants, auto replenishment) — the build task starts with
a gap reconciliation of the pack against shipped work, then its
[DECISION] items batched to the owner per the pack's own instruction.
Queued after the Sales Views program.

## Sales Order Maintenance (SOM) mega-pack committed (2026-08-27)

Owner uploaded the full Sales Processing specification — 27 files, two
layers: module-level 00–13 (domain model, state machines, order entry,
pricing/discounts/tax, payments/cards, financing, settlement/cash,
salesperson/UP/CRM, views, security, cutover, acceptance tests, open
questions) and screen-level 20–31 covering **all 172 SOM screens** field
by field (index, 8 area files, cross-cutting corrections, 131 more
acceptance tests, open questions #29–#58). Committed verbatim to
`docs/erp/` (top-level \*.md prettier-ignored), alongside the existing
`docs/erp/system-administration/` domain — this directory is now the
unified spec tree, as the pack's own layout intends. Loose uploads
(20-index, 29-cross-cutting) verified byte-identical to the zip.

Key protocol from its 00-HANDOFF: read 29 before trusting 01–13 (the
screen layer wins); [DECIDE] items are stop-and-ask; enum gaps are
ask-not-guess; quantities become decimal(12,4). Much overlaps work
already shipped (orders, returns, exchanges, POS, deliveries) — like the
transfers pack, the build task starts with a reconciliation pass, then
batches the [DECIDE]/open-question asks to the owner. Queued behind the
Sales Views program and the other queued packs.

## Checkpoint 22 — jeopardy queue merged; liability + date-change views (2026-08-27)

PR #54 squash-merged on green CI (main 32dee00): Delivery Dates in
Jeopardy live queue + /jeopardy page, plus the transfers pack (16 files)
and the SOM mega-pack (27 files) committed. Deploy branch rolled
(4f1eb8e), Render deploy dep-da89k2favr4c73ersb6g triggered (no
migration — boot log verify pending).

Next slice in the same sweep, gates green before push:

- `GET /v1/reports/gift-cards/liability` (catalog 76) — every card still
  carrying a balance + total owed; reports.financial.view; CSV with
  provenance. Reports page card in the financial section.
- `GET /v1/reports/delivery-date-changes?days=N` (catalog 86) — the
  delivery-commitment change log read from the audit trail
  (schedule/update/cancel, before→after dates from the diff), actor
  attribution; deliveries.view; Reports page card.
- reports.int.spec 27→29 (liability counts only balance-carrying cards +
  403 for non-financial; audit-sourced before→after surfaces). Gates:
  typecheck 0 · lint 0 · test 0 (full) · build 0 · prettier 0.

## Checkpoint 23 — #55 live; receipts + tax-by-location built (2026-08-27)

PR #55 (gift-card liability + delivery date-change log) deployed:
dep-da89ouvavr4c73es75dg live, boot log `61/61 applied,
head=0060_membership_data_scope; this run applied none`. Next slice
gated green:

- `GET /v1/reports/receipts` (catalog 92) — every succeeded payment by
  method × taking location (sale/order/service COALESCE), imported
  excluded, store scope applies, CSV provenance; Reports page card.
- Tax summary gains the **by-location jurisdiction block** (catalog 87
  — LA Mattress jurisdictions map to locations): completed POS sales +
  completed orders, documents/total/tax per location; the per-class
  table (and now the whole endpoint) is store-scoped too.
- reports.int.spec 29→31. Gates: typecheck 0 · lint 0 · test 0 (full) ·
  build 0 · prettier 0.

## Cash Balancing pack committed (2026-08-27)

Owner uploaded the Cash Balancing & Cash-Position Reporting handoff
(10 files: domain model, control settings, the three reports — drawer
balancing totals, daily receipts register, cash requirements — shared
report primitives, adjacent screens, acceptance criteria, open
questions). Committed verbatim to `docs/handoffs/cash-balancing/` (the
zip's own layout; prettier-ignored). Jetnine already has cash shifts
with blind-count close + variance and the new receipts report — the
build task starts by reconciling the pack's loop (system-date drawers,
tolerance/retries, register vs balancing distinction) against that.
Queued after the Sales Views program and the other packs.

## Merchandising activity — the buyer's report (2026-08-27)

Catalog 67 built over Jetnine's own model (no regional cost overlays —
one cost, one price):

- `GET /v1/reports/merchandising?vendorId&categoryId&brandId&
includeNoActivity` — per variant: on hand / reserved / floor / net
  available (all locations), as-is holdings (pending_review pieces), on
  order (open PO remainder), sold MTD/YTD units (completed POS sales +
  completed orders; FILTER params cast ::timestamptz — untyped Date
  params 500'd), replacement cost, price, markup %. No-activity rows
  drop unless asked (the catalog's detail-line rule); top-2000 cap is
  announced, never silent. reports.financial.view (cost-bearing).
- New page `/reports/merchandising` (linked from Reports): vendor/
  category/brand filters, include-all toggle, CSV with provenance.
- reports.int.spec 31→32 (widget stock 18 after the POS sale, 150%
  markup, gadget on-order 5 from the jeopardy PO fixture, 403 for
  non-financial). Gates: typecheck 0 · lint 0 · test 0 (full) · build 0
  · prettier 0.

## Inventory adjustments view + customer purchase export (2026-08-27)

The last two report-catalog keeps:

- `GET /v1/reports/inventory-adjustments?start&end&reason` (catalog 40)
  — the movements ledger over a window, grouped by reason (units in /
  out) with a labeled detail list (product, location, actor, reference,
  notes); pure read, nothing EOD-coupled or self-deleting; store scope
  applies; announced 1000-row cap; CSV provenance. Reports page card.
- `GET /v1/reports/customer-purchases?customerId&start&end` (catalog 42) — completed POS sale lines + completed order lines, one customer
  or all, announced 5000 cap, CSV; store scope applies. "Export purchase
  history CSV" button on the customer page.
- reports.int.spec 32→34. Gates: typecheck 0 · lint 0 · test 0 (full) ·
  build 0 · prettier 0.

**Report-catalog phase COMPLETE.** Every keep-table row is now built or
covered: unified sales summary, avg/document, receipts, tax (class +
jurisdiction), open-orders surfaces + jeopardy queue, date-change log,
gift-card liability, merchandising activity, inventory adjustments,
customer purchases; exceptions/physical-count/void-integrity covered by
existing modules. Remaining in the Sales Views program: Phase 4 record
pages (customer 360 panels, product activity, salesperson page) — the
existing customer/product/orders pages already carry much of this;
scoped as the next slice(s).

## Phase 4 record-page slice + Report Builder pack (2026-08-27)

Sales Views Phase 4 gap-fill, gates green:

- `GET /v1/customers/:id/summary` — customer-360 totals (lifetime + YTD
  documents/dollars over POS sales + orders) and open orders with
  computed Balance = Total − Amount Paid (derived, never stored).
  Customer page gains "Activity totals" + "Open orders" cards.
- Orders list gains `salespersonMembershipId` filter; sales list gains
  `associateUserId` — the parameterized "salesperson's documents" grid.
- New **Salespeople** page (People nav): written activity per
  salesperson over a window (via the sales summary), drill-in to the
  person's orders + POS sales. reports.int.spec 34→36.

Owner re-sent the cash-balancing zip (verified byte-identical to the
committed pack — no changes) and uploaded the **STORIS Report Builder
handoff** (13 files: report definitions, dictionaries/joins, run/output/
viewer, security, scheduling, menu integration, acceptance tests, open
questions) — committed verbatim to `docs/handoffs/storis-report-builder/`.
Queued last: it layers on the reporting engine this sprint just built.

## Checkpoint 24 — SALES VIEWS PROGRAM COMPLETE (2026-08-27)

PR #59 squash-merged on green CI (main 9abbb43); deploy branch rolled
(3577d68), Render deploy dep-da8as0btqb8s739lkepg triggered (no
migration — verify on next check). #57 and #58 deploys verified live
earlier (boot logs 21:05 and 21:21, `61/61 applied … none`).

The 139-article Sales Views & Reports program (task #22) is COMPLETE
across all five phases on the owner-locked Phase 0: substrate (store
data scope, migration 0060), shared primitives (already in place from
the pagination sweep), operational queues (jeopardy + existing
exceptions), record pages (customer 360 totals/open-orders, salespeople
page, buyer's report), and the full report catalog (sales summary,
receipts, tax class+jurisdiction, date changes, gift-card liability,
merchandising, adjustments, customer purchases). Deferred by triage:
leads/CRM, protection plans, in-house financing reports, mini-AP queues,
full ATP projection.

Next: task #23 — Delivery Ticket Print & Reprint (port the pack's
acceptance tests first, per its own instruction).

## Delivery Ticket Print & Reprint — flag state machine (2026-08-27)

Task #23 built per the pack's own protocol: 07's acceptance tests ported
FIRST (S1–S9, T1–T7, T9, T10, R10 — 21 pure unit tests), then the
normative 02 state machine as a pure function:

- `apps/api/src/deliveries/ticket-flags.ts` — applyTicketEdit (R1–R8,
  R11), canPrintSecondDate (R10), recordTicketPrint (print → P +
  assignment); every transition returns the rule that fired. Pick-list
  invariant (R7) enforced centrally; line slots outside the header's
  first two dates are never ticketable.
- Migration 0061_ticket_flags: ticket_flag/pick_list_flag on deliveries
  (header slots) + delivery_lines (line slots).
- TicketFlagsService persists snapshots and writes the transition log to
  audit (`delivery.ticket_flags`) — "why did this reprint?" is always
  answerable. Wired: delivery schedule/cancel (R8 next-delivery-date),
  delivery date move (R8), order payments (R8 deposit), and the
  delivery-ticket-print endpoint (sets P; optional deliveryId; R10 409
  `SECOND_DATE_NOT_PRINTABLE` for premature second-date prints).
- deliveries.int.spec 17→19 (print→P, date-move→R with R8 in the audit
  log, reprint→P; R10 refusal then first-date print).

**Owner items from the pack's open questions (08), decisions taken —
say the word to change any:**

- Q2/S3: the published S3 header-second-slot result rests on a
  parenthetical the pack itself calls a source error; implemented S7's
  quantity-conditional rule instead (S3 test documents the divergence).
  Verify against live STORIS when convenient.
- Q3: two ticketable slots only (dates roll forward) — pack's best guess.
- Q8: destroyed print history IS retained (audit transition log).
- Q9: `R` stays advisory (never blocks) — confirm the warehouse wants it
  advisory rather than gating manifest creation.
- Q6 (line deletion) and per-line reschedule UI: machine supports them
  (line_reschedule/line_inventory_change) but no UI path exercises them
  yet; whole-delivery date moves map to R8.
  Gates: typecheck 0 · lint 0 · test 0 (full) · build 0 · prettier 0.

## Sales-rate PO replenishment — engine slice (2026-08-27)

Task #24 slice 1 (docs/HANDOFF-po-replenishment-sales-rate): the ONE
pure calculation engine, tests first per the pack.

- `apps/api/src/purchasing/replenishment-engine.ts` — QuantityToOrder =
  Required + Additional − Available − NetPO. Required always ÷7;
  Additional ÷5/÷7 per Exclude Weekends; per-COLUMN rounding (on =
  half-up, off = truncate); NetPO never clamped (branch A subtracts
  uncommitted + layaway-per-control; branch B subtracts due-soon
  demand, adds inbound transfers); strict `<` Minimum Sales Rate drops
  the row; category-exception hierarchy for stock/lead days;
  validateCriteria (products×model, IncludeAllBackOrders×DaysForRepl),
  salesWindow (this-year-prior / last-year-subsequent, injected clock),
  vendorRunsToday (GenerateAutomaticPOs + Build POs weekday gate).
- `replenishment-engine.spec.ts` — 18 tests: T-01…T-09, T-10/11,
  T-12/13, T-15, T-16, T-17, T-20, T-25/26 + category exception +
  returns-subtract. All passing.
- Migration `0062_vendor_replenishment`: `vendors.replenishment_json`
  (jsonb) — per-vendor settings (§4 field list) live here.

**§9 self-decisions (flag to owner):** §9.1 sales rate = sold −
returned (source "=" read as typo) · §9.2 rounding off = truncate
toward zero · §9.10 minimum-sales-rate filter is strict `<` · Jetnine
divergences: no product groups (category exceptions only), no PO types
(every open PO is supply), no PO-from-order-entry flag (§3.4 n/a).

Remaining slices: data layer (build engine inputs from sales/inventory/
POs/transfers), vendor-settings endpoint + UI, criteria screen +
Items-for-Replenishment grid (session overrides, Rebuild List T-32),
PO creation (qty>0 only, auto-hold T-28), delivery dates T-29/T-30,
EOD mode via jobs runner (T-25/26) + T-31 identical-modes test.
Gates: typecheck 0 · lint 0 · test 0 · build 0 · prettier 0.

## Sales-rate replenishment — data layer, run modes, UI (2026-08-27)

Task #24 slice 2: the engine now runs against live data in all modes.
PR #61 (engine) merged; deploy verified `63/63, head=0062` at 22:24.

- `replenishment-data.ts` — the ONE data path (T-31 rests here too):
  builds every engine input per vendor × warehouse. Jetnine mappings,
  recorded in the file: warehouse = the run's chosen location, all
  other locations are "store stock"; written basis = order + POS write
  dates, delivered = delivered deliveries + POS completions (imports
  excluded — timestamps are import-time); returns = refund lines;
  branch-B fill window = criteria ?? vendor daysForReplenishment ??
  lead days; layaway demand kept out of uncommitted (no
  double-subtract); dateless transfers excluded; direct-ship POs are
  never supply; held PO = draft (still supply, per pack); unitVolume =
  capacityUnits; as-is qty from pending-review as-is items.
- `replenishment.controller.ts` — ReplenishmentRunService (shared by
  endpoint + EOD; only the db handle differs) and endpoints:
  GET/PATCH `/v1/purchasing/replenishment/vendors/:id/settings`
  (validated, audited; PATCH null or enabled:false clears), POST
  `…/run` (criteria → grid rows with product meta), POST
  `…/purchase-order` (T-32 session overrides in the body; only qty>0
  written; T-28 hold = draft, else placed; §5.1/T-29/T-30 header
  expected date = furthest lead-day date or today).
- EOD: `sales_rate_replenishment` job (order 35) — per vendor:
  Generate Automatic POs + Build POs weekday gate (T-25/26), then the
  identical run path; info exception lists created PO numbers.
- Ops block `salesRateReplenishment` (settings registry + validation):
  written/delivered basis, exclude-weekends divisor, standard rounding,
  store-stock availability, layaway-in-NetPO.
- Web `/replenishment` (nav: Catalog → Replenishment): criteria screen,
  vendor-settings editor (incl. Build POs weekdays), Items-for-
  Replenishment grid with session-only Order Qty edits, Rebuild List,
  Create Purchase Order.
- purchasing.int.spec 39→43: settings round-trip + refusals, §8
  baseline from live data (80 sold/8wk, 45 on hand/15 committed →
  20/30/30/0 → order 20), EOD writes the identical qty held+dated
  (T-31/T-28/T-29), supply feedback zeroes the next run, override
  creates qty>0 only (T-32).

Deferred within the pack (flagged): GMROI/turns/average-units detail
panel, vendor ship-from + buying groups + volume-limit cap (no Jetnine
equivalents yet), print report. Criteria filters shipped: products,
category; group/collection/model n/a.
Gates: typecheck 0 · lint 0 · test 0 (full) · build 0 · format 0.

## Checkpoint 25 — replenishment SHIPPED · transfers pack reconciled (2026-08-27)

PR #62 squash-merged on green CI (main 39a9f07); deploy branch rolled
(7ad4b21), deploy dep-da8bqpon74is73dfrbmg live, boot log verified
`63/63 applied, head=0062_vendor_replenishment` (22:44). Task #24
(sales-rate PO replenishment) is COMPLETE: engine (#61) + data layer,
endpoints, EOD job, ops block, /replenishment UI (#62), 18 unit + 4
int acceptance scenarios (T-31 identity proven). Earlier this window:
#60's deploy verified `62/62, head=0061_ticket_flags` (22:05).

Task #25 kickoff per the pack's own protocol (00-README step 5:
collect [DECISION]s, never guess): authored
`docs/erp-transfers/GAP-RECONCILE.md` — discovery-pass answers, the
full shipped/partial/missing map (five transfer types, lifecycle,
serials, auto transfers, FIFO carry = shipped; hold quantities,
store↔store gate, numbering suffixes = partial; security tables,
cartons, route capacity, distributed, one-time-buy, multi-leg,
manifests, RF/phantom, reschedule screen, EDI 214 = missing and
scope-gated), acceptance-map, and **ten batched owner questions**
(§4) — manifests/RF, location_type, completion gates, distributed
transfers + rounding, security tables, skip-list confirmations, plus
the pack's four [DECISION] markers (§10's stock-level model recorded
as already answered by the shipped replenishment programs).

**Owner: answer GAP-RECONCILE.md §4 (10 numbered questions) to unlock
the transfers build phases.** Next while that waits: decision-free
quick wins (hold/scheduled qty D18–19, transfer-comment audit, excess-
quantity inquiry), then task #26 (SOM pack reconcile).

## Checkpoints 26–28 kickoff — remaining packs reconciled (2026-08-27)

Same protocol as the transfers reconcile, one doc per pack, all
questions batched:

- **Task #26 (SOM)**: `docs/erp/GAP-RECONCILE.md` — shipped-stack map
  across all module phases; open-question register #1–#58 triaged
  (~35 answered by shipped code or locked decisions — Stripe
  tokenization, one return window, snapshot-at-write, permission
  precedence, cash-shift opening, all ten documented bypasses never
  built; financing quartet moot under third-party-only); **twelve
  owner questions** incl. the headline `decimal(12,4)` quantity
  decision (recommendation: keep integers), commission plan values +
  the #54 date-attribution conflict, deposit policy, discount-model
  parity, provider set, merge tooling, COM/rooms/loyalty scope.
- **Task #27 (cash balancing)**:
  `docs/handoffs/cash-balancing/GAP-RECONCILE.md` — the loop exists
  lean (shifts with float, counted close, variance, receipts report,
  Z-report); pack Q1–Q10 triaged (7 answered by shipped design);
  owner: fiscal calendar, cash-only tolerance confirm, retention, and
  the scope pick for blind-count/tolerance/retries/suspension +
  balance-by-cashier.
- **Task #28 (report builder)**:
  `docs/handoffs/storis-report-builder/GAP-RECONCILE.md` — one gating
  question: fixed catalog (recommended), full self-service builder, or
  BI-on-replica; `12`'s twenty semantic edges adopted as written only
  if the builder is chosen.

**Owner: the four GAP-RECONCILE docs are the complete ask backlog —
answer §4 of each (transfers 10, SOM 12, cash 4, report-builder 1) and
the corresponding builds unlock.** Until answers land the sprint holds
no unchecked decision-free build items.

## Transfers quick wins + Run-01 accounting pack landed (2026-08-28)

Task #25's decision-free quick wins (the GAP-RECONCILE §4 tail),
built while the owner scope answers are pending:

- **Hold / scheduled quantity (pack D18/D19)** — migration
  `0063_transfer_hold` adds `stock_transfer_lines.quantity_ordered`
  (null = no hold). Create accepts `lines[].quantityOrdered ≥
quantity`; only the scheduled quantity ever ships or leaves origin
  stock; detail exposes `quantityOrdered`/`quantityHeld`. On FULL
  receipt the held remainder rolls into a fresh draft transfer on the
  same lane ("Held quantity rolled over from ST-… (D19)"), audited as
  `stock_transfer.hold_rollover` — Jetnine idiom for "hold is cleared
  and the remainder becomes schedulable"; divergence from STORIS's
  reserve-at-origin hold is documented in the schema comment.
- **Excess inquiry (pack 12)** — `GET /v1/stock-transfers/excess`:
  variants whose total available stock exceeds their largest single
  transfer line. Informational only. (Route registered before `:id` —
  the literal-after-param 500 was caught by the new test.)
- Web: transfer detail gains a Held column; the create form gains an
  optional "Ordered (hold)" input per line.
- transfers.int.spec 29→32 (D18 validation + partial ship, D19
  rollover draft, excess incl. the 100-unit-line exclusion case).

**Run-01 Accounting pack** uploaded by owner (~00:40) and committed
verbatim: `docs/handoffs/run01-accounting/` — 30 batch returns over
307 STORIS Accounting articles (GL 10, Payables 63, Receivables 124,
Views/Reports 100) + coverage queue + run summary + assignment card.
Queued as **task #29**; kickoff will reconcile against shipped Jetnine
(no GL/AP/AR modules today; the receivables layer must be read against
the locked third-party-financing-only decision) and batch the owner
asks like the other four packs.
Gates: typecheck 0 · lint 0 · test 0 (full) · build 0 · format 0.

## Report builder — slice 1 SHIPPED · Run-02 pack landed (2026-08-28)

**Owner decision (~01:00): "self-service builder"** — option (b) of the
report-builder GAP-RECONCILE. The pack's 20 `12-open-questions`
recommendations are adopted as written, per that doc's own terms.

Task #28 slice 1 (pack build order 1–3 + runner + security), tests
ported first (`11-acceptance-tests` #1–31 pure/stack subset + 54–58,
62 — 34 tests green):

- Migration `0064_report_builder`: `report_dictionaries` (user formula
  - joined dictionaries) and `report_definitions` (jsonb doc), both
    tenant tables (RLS lists updated).
- `report-sources.ts` — the code-owned source catalog (orders, sales,
  customers, products, purchase_orders) with system dictionaries,
  per-source permission gates (pack 07 layer 2 mapped to Jetnine
  permissions), relation graph, pk tiebreakers, and the shipped Cost
  masking code (`reports.cost.view`) on cost-bearing dictionaries.
- `formula.ts` — closed-set expression language (arith, comparison,
  CONCAT/IF/ROUND/ABS/UPPER/LOWER), parse-time rejection of anything
  else, unknown-ref hard errors; evaluated in-process, never SQL.
- `definition.ts` — the pack-02 validation checklist (break⇒sort,
  newPage⇒break, period-prompt ban, token↔prompt match, reserved S$
  prefix at creation, width-132 warning, TR/FL valueless, derived
  Summary Only).
- Controller: sources catalog, dictionary create/delete (join
  assistant honours the relation graph; deletion reports affected
  definitions), definition CRUD + clone (system-owned runnable/
  cloneable, never editable), and the runner — AND-only filters with
  the `""` blank idiom, prompts (simple/range/multi include-exclude),
  date codes TDAY/YDAY/CPTD/LPTD resolved at execution, break/total
  groups + Summary Only, field masking as a render rule (header stays,
  cells empty, no WHERE), 5000-row announced cap, provenance in every
  output, CSV with house injection guards.
- Permissions: `reports.builder.run` / `reports.builder.author` /
  `reports.cost.view` (Owner/Manager inherit; Bookkeeper granted).
- Web `/reports/builder` (nav under Insights): list/clone/run +
  editor (headings, columns with break/total, filters, prompts,
  sorts) + runner with prompt answers, Summary Only, grid with group
  and grand totals.

Deferred to later slices (flagged): PDF/archive destinations, viewer
saved views, scheduling via the jobs runner, USER-DEFINED menus,
WorkingDataSet sources. CPTD/LPTD use calendar months pending the
fiscal-calendar answer (cash pack Q1).

**Run-02 Merchandising pack** uploaded (~01:15) and committed verbatim:
`docs/handoffs/run02-merchandising/` — 11 batches, 129 articles, 145
findings over the purchasing/inventory domain. Queued as **task #30**
(reconcile vs the already-shipped PO/costing/replenishment/transfers/
physical-inventory stack).
Gates: typecheck 0 · lint 0 · test 0 (694) · build 0 · format 0.

## Run-02 merchandising reconciled (2026-08-28)

Task #30: `docs/handoffs/run02-merchandising/GAP-RECONCILE.md` — the
run's ten headline findings adjudicated against shipped code (eight
are STORIS traps Jetnine avoided by construction: one cost, one
availability definition, one PO lifecycle with guards, audited holds,
membership-derived access, declared EOD, quantity-link PO↔SO parity,
inventory_movements as the one Kardex); §G cautions adopted into the
cutover runbook notes; **three owner questions**: landed cost into
FIFO layers (lean freight field vs per-component vs no), PO types as
policy bundles (answer with transfers Q4/Q6), and Open To Buy scope
(default skip). No code changes until answers land.

## Report builder — slice 2: archives + scheduling (2026-08-28)

Task #28 slice 2 (pack 05 archive destination + pack 08 scheduling),
acceptance #36–38, #42, #61, #63–64 ported:

- The run pipeline extracted to `report-runner.ts` — the ONE execution
  path now shared by the interactive endpoint, the archive
  destination, and the EOD scheduler (same one-engine discipline as
  replenishment). Masking became `applyMasking(result, can)`: archives
  store the UNMASKED result + definition snapshot; masking re-applies
  per viewer at read time, and entitlements are re-checked at view
  time (#61) — a revoked user loses archives generated before the
  revocation.
- Migration `0065_report_archives`: `report_archives` (snapshot +
  structured result + runSource regular|eod), tenant table.
- Endpoints: run gains `format:'archive'` (no render, one record);
  GET/DELETE `/v1/report-builder/archives[/:id]` with per-viewer
  masking + CSV re-render (#37).
- EOD job `report_builder_schedule` (order 60): every definition with
  Add-to-Schedule runs inside `withDrizzleTenantContext` (RLS applied
  on the root db) through the same pipeline; output is archive-only
  with runSource 'eod' and runBy 'scheduler' (#63/#64); reports whose
  required prompts lack answers are skipped with the error recorded.
- Web: "Send to archive" on the runner + an Archived-runs card with
  per-viewer CSV download.
- report-builder.int.spec 17→22; purchasing jobs-list assertions
  updated (5 steps).

Still deferred: PDF output, viewer saved views, USER-DEFINED menus,
WorkingDataSet sources, retention windows (owner said keep-everything
stands unless Accounting answers cash Q3 differently).
Gates: typecheck 0 · lint 0 · test 0 (704) · build 0 · format 0.

## Checkpoint — 2026-08-28 (STORIS parity audit complete: runs 03–06 landed + 8 owner decisions)

- Landed the remaining parity-audit packs under `docs/handoffs/` (canonical
  copies from the complete-audit zip): `run03-sales-processing/` (18 files,
  405-article Sales Processing dissection), `run04-logistics-delivery/` (13),
  `run05-customer-service/` (4), `run06-getting-started/` (4), and
  `AUDIT-CLOSEOUT.md`. All six runs (~1500 articles) are now in-repo.
- Recorded the owner's 8 locked decisions (2026-08-28, AskUserQuestion
  rounds 1+2) as "Decisions received" appendices in the five GAP-RECONCILE
  docs: keep integer quantities · **in-house full GL** (run-01 batches
  1/18/24 are the spec; journal-event derivation first) · manifests only,
  no scanning · add store/warehouse location types · skip distributed
  inventory · require print-before-ship on transfers · blind count +
  cash-only $ tolerance (per-location) · landed cost lean.
- Owner authorized build start ("go ahead and start"). Build queue order:
  location_type migration → transfer print-before-ship gate → landed cost
  lean → blind-count cash discipline → manifests (run-04 feeds this) →
  in-house GL program (largest, phased).
- Still-open owner questions carried in the GAP-RECONCILE docs (fiscal
  calendar, cash tolerance $, PO types, OTB, discount-model parity,
  financing providers/commission values, customer merge tooling, cutover
  pilot-vs-full). None block the first slices; configurable settings +
  recorded defaults where needed.

## Checkpoint — 2026-08-28 (Q2+Q3: location types, store↔store gate, print-before-ship)

- Migration `0066_location_types_transfer_ticket`:
  `locations.location_type` ('store'|'warehouse', default store) +
  `stock_transfers.ticket_printed_at` / `ticket_print_count`.
- Ops block `transfers` in SET-007 registry: `storeToStore` (null/true =
  allowed; false rejects store→store at create, E20) and
  `requireTicketBeforeShip` (null/true = **required**, per the owner's Q3
  decision — the default gate is ON in production).
- `POST /v1/stock-transfers/:id/ticket-printed` records the print (audit
  `stock_transfer.ticket_print`); the web print page calls it before
  `window.print()`. Ship (and create-with-ship) are blocked until a
  ticket has printed. Drafts are immutable in Jetnine, so no P/R
  staleness machinery is needed — printedAt is sufficient.
- Locations API/UI expose the type (create select + click-to-toggle
  badge); replenishment picker sorts warehouses first; both EOD location
  picks (auto-replenishment ship-to, sales-rate warehouse) now prefer
  warehouse-typed locations via `ORDER BY (location_type='warehouse')
DESC, created_at` — fallback path (no warehouse) is what every
  existing EOD test exercises, so no second vendor fixture was added.
- transfers.int.spec 32→36 (gate suite: block/print/unlock/reprint,
  ship:true rejection, E20 store→store, canceled-print refusal);
  business.int.spec +1 (type CRUD + validation). Legacy transfer suites
  run with the gate off via fixture ops, mirroring pre-Q3 behavior.
  Gates: typecheck 0 · lint 0 · test 0 · build 0 · format 0.

## Checkpoint — 2026-08-28 (run-02 Q1: landed cost lean)

- Migration `0067_po_freight`: `purchase_orders.freight_cents` (null =
  none). One freight amount per PO, per the owner's "yes, lean".
- Allocation at receipt: per-unit share = round(freight / total units
  ORDERED) — the divisor is the ordered total so partial receipts layer
  identically whenever they arrive; sub-cent remainders round away
  (documented lean trade-off). Share is added to the PO line's unit
  cost in BOTH `po_receive` layer paths (stock and direct-ship), so
  FIFO consumption and margin pick up landed cost automatically.
- Freight is frozen once any unit has been received (earlier layers
  would disagree with a new amount) — un-receive first; validated
  non-negative integer at create and PATCH.
- Web: freight input on the new-PO page (dollars), display row on the
  PO detail totals card.
- purchasing.int.spec 43→45: two-line spread with partial receipt
  (200¢/unit on both layers), create validation, frozen-after-receipt +
  draft-edit pass.
  Gates: typecheck 0 · lint 0 · test 0 · build 0 · format 0.

## Checkpoint — 2026-08-28 (cash pack scope (a): blind-count balancing)

- Migration `0068_cash_blind_count`: `cash_shifts.close_attempts` /
  `suspended_at` / `approved_by_user_id`.
- Ops block `cashBalancing` (SET-007 registered): `toleranceCents`
  (AC-5/6; cash-only by construction — shift closes count cash only,
  AC-7) + `maxAttempts` (AC-8). Null = discipline off (legacy close).
  **Ops: the tolerance $ value is Accounting's to set** — flagged, ships
  off by default.
- Close flow: within tolerance closes normally; out of tolerance burns
  a blind attempt (the 400 never reveals expected cash or variance,
  AC-10); attempt exhaustion suspends the drawer + exception
  `cash_drawer_suspended`; a suspended (or explicitly `approve`d) close
  routes through SecurityOverrideService on new permission
  `pos.cash.approve` (Owner/Manager) — manager credentials in the
  standard override dialog force-balance and stamp `approvedByUserId`.
- Trap found: the per-request RLS transaction rolls back on a thrown
  4xx, so failed-attempt counters/suspension/exception rows are written
  through ROOT_DRIZZLE to survive the throw (documented in the
  controller).
- Web: shifts/[id] shows attempt/suspension banners and opens the
  security-override dialog on OVERRIDE_REQUIRED; blind count holds by
  construction (expected cash renders only after close).
- reports.int.spec 36→39 (AC-5, AC-6/8/10 chain, discipline-off).
  Gates: typecheck 0 · lint 0 · test 0 · build 0 · format 0.

## Checkpoint — 2026-08-28 (Run 07 System Administration landed, batches 1–13)

- New seventh audit run under `docs/handoffs/run07-sysadmin/` (15 files,
  canonical from the partial zip): the System Administration section
  (599 articles) that all six prior runs kept pointing at. Findings
  337–460+: POS Control Settings enumerated (nine pages, ~250 fields),
  the complete reservation model (three orthogonal axes), the
  ~360-permission catalog across ten records, licensing = site counts,
  costing = 3 methods + freight + four labelled add-on slots (our
  "lean" freight-only build is the deliberate subset), blind-count's
  cashier-mode interplay, manifest reason codes ×3, `Track Settings
Activity`, PII-encryption categories, UniData platform.
- **Ops action (owner)**: run-07 §F says the highest-value next step is
  photographing the LIVE config screens — General System Control
  Settings (4 tabs), Point of Sale Control Settings (9 pages),
  Inventory Control Settings, Costing Control Settings, plus `Report on
User Security` and `Review Settings Activity` extracts. "A morning's
  work worth more than another 500 articles."
- PRs #69 (location types + print gate, deployed, 67/67 head=0066) and
  #70 (landed cost + blind count) merged; #70 deploy in flight.

## Checkpoint — 2026-08-28 (Q1 manifests without scanning)

- Migration `0069_stock_manifests`: new tenant table `stock_manifests`
  (lane + truck date + free-text route, MAN-YYYY-NNNN numbering, open→
  completed/canceled) + `stock_transfers.manifest_id`/`load_number`.
  All three tenant-table wirings done (TENANT_SCOPED_TABLES, rls.sql).
- **One ship path**: extracted `TransferShipService` — the `/ship`
  endpoint, create-with-`ship:true`, and manifest Complete all move
  inventory through it (Q3 print gate, negative-stock refusal, FIFO
  consume, serial flagging can never diverge).
- STORIS 08-manifests semantics kept lean: build against the same open
  (to-location, route, date) key APPENDS; load numbers 0–99 (explicit
  wins, else the manifest's last-used); per-transfer validation errors
  name the transfer and reason; F177-lite — a manifested transfer can't
  ship or cancel directly (remove first); F178 — removal from an
  existing manifest records the reason in the audit register
  (`stock_manifest.remove_transfer`).
- Complete = the truck leaves: ships every draft in load order through
  the one path (print gate enforced per transfer), marks the manifest
  completed; receiving stays tap-based per transfer. Cancel detaches
  drafts.
- Web: /transfers/manifests (build UI on a lane with eligible-draft
  picker), detail page (loads, ticket state, complete/cancel/remove),
  and a printable truck load sheet at /print/manifests/:id. Transfers
  list gains Manifests button; transfer detail shows its manifest.
- transfers.int.spec 36→40 (build/append/load numbers, ship+cancel
  blocks, audited removal, gate-blocked completion then full ship with
  inventory assertion).
  Gates: typecheck 0 · lint 0 · test 0 · build 0 · format 0.

## Checkpoint — 2026-08-28 (in-house GL slice 1: chart, periods, journal)

- Owner's locked (b) full-GL program begins. Migration
  `0070_general_ledger`: four tenant tables — `gl_accounts` (code
  immutable, per-business unique, `system_key` marks derivation
  targets), `gl_periods` (1–12 calendar months + period 13, lazy
  per-year materialization), `gl_journal_batches` (draft→posted,
  GL-YYYY-NNNNNN, typed `source_type`/`source_id` MANDATORY on derived
  batches — F17's conventional-reference flaw fixed structurally),
  `gl_journal_lines` (DB CHECK: debit XOR credit, strictly positive).
- STORIS semantics kept: cascade close (F4: closing N closes all
  earlier open), cascade reopen (F5), period-13 year latch (F6: the
  year closes only when 13 does, after 1–12). STORIS flaws NOT copied:
  no silent default account (F1 — unmapped/inactive is refused), F9
  hardened (drafts in the closing range BLOCK the close instead of a
  notify), posted batches append-only (corrections are new batches).
- Endpoints under /v1/gl: accounts CRUD + `seed-defaults` (20-account
  retail chart with system keys for the coming derivation), periods
  close/reopen, journal batches (draft/edit/post with balance + open-
  period gates), trial balance. New permissions `gl.view`/`gl.post`/
  `gl.manage` — Bookkeeper explicit, Owner/Manager inherited, Cashier
  none.
- Web: /gl (chart + period grid + trial balance) and /gl/journal
  (multi-line entry with live balance indicator, draft/post).
- New per-suite DB `jetnine_gl` wired in ci.yml; gl.int.spec.ts (6
  tests: seed-once, account validation chain, lopsided-draft→balance→
  post→append-only, cascade close with draft guard + year latch +
  cascade reopen, trial balance, permission gate).
- Slice 2 next: journal-event derivation (EOD job posting the day's
  operational events through GlService via the system keys) + the
  period-12 retained-earnings roll (F7).
  Gates: typecheck 0 · lint 0 · test 0 · build 0 · format 0.

## Checkpoint — 2026-08-28 (GL slice 2: journal-event derivation)

- New EOD job `gl_derivation` (order 70, last): derives the business
  date into POSTED `derived` batches through GlService inside the
  tenant RLS context — one batch per family per date, idempotent by
  (`eod_<family>`, business_date). Spec: docs/erp-gl/DERIVATION-SPEC.md.
- Eight families live: POS sales (tender split by method → revenue+tax),
  order money in (→ deposit liability), order revenue at FULL
  completion (deposit release → revenue/tax/delivery/fees), COGS at
  actual FIFO cents, receipts (→ Received Not Recorded, un-receives
  reversed), vendor bills (RNR → AP at approval), cash over/short,
  inventory adjustments (shrink/count/as-is recovery both directions).
- Tender map: cash→drawer · card/external_card/check→bank ·
  gift_card→gift-card liability · store_credit→deposit liability ·
  financing→AR. D8 imported records excluded everywhere.
- Anti-F1 enforced: a family with unmapped system keys is SKIPPED with
  the reason in the job report — nothing defaults; a closed period
  skips the whole run with reason; defensive imbalance skip.
- **Refunds/exchanges not yet derived** — visible note in every job
  outcome; manual batches until that slice.
- GlService refactored to take explicit db handles so the EOD path and
  request path share the same gates. Jobs registry now 6 steps.
- gl.int.spec 6→9 (8-family fixture day with exact cents, POS batch
  line-level spot check, pipeline idempotency, anti-F1 skip via the
  job_runs report); purchasing jobs-list assertions updated (6 ids).
- Production verified through slice 1: 71/71, head=0070_general_ledger.
  Gates: typecheck 0 · lint 0 · test 0 · build 0 · format 0.

## Checkpoint — 2026-08-28 (GL slice 3: year-end roll, refunds, account inquiry)

- **F7 retained-earnings roll**: closing period 13 now posts a
  `year_end` batch zeroing every P&L account's net for the year into
  `retained_earnings` (per-account closing legs + one RE leg), BEFORE
  the latch closes so the roll lands in period 13 — adjustments
  included (better than STORIS's 12th-close timing). Naturally
  idempotent: a re-close after a reopen only rolls activity since the
  last roll. Refuses when 'retained_earnings' is unmapped (anti-F1).
- **Family 9 refunds** joins the derivation: proportional tax split
  per refund (amount × saleTax/saleTotal, rounded), revenue + tax
  debited, drawer credited. Exchanges settle through orders/returns —
  their money already surfaces in families 1–3 (spec note updated).
- **F277-lean account inquiry**: GET /v1/gl/accounts/:id/activity —
  per-period totals for the year + the posted lines behind them with
  batch drill-through.
- Filed `docs/HANDOFF-sales-security.md` (owner upload): the 120-
  permission STORIS Sales Security dissection. Note: its §2.3
  tri-state recommendation (inherit/grant/deny) is ALREADY Jetnine's
  model — `membership_permission_overrides.allowed` with no-row =
  inherit; recorded as parity confirmation, not new work.
- gl.int.spec 9→12 (roll balance + RE credit 50100 assertion, refund
  batch line math 9500/950/10450, activity per-period totals).
  Gates: typecheck 0 · lint 0 · test 0 · build 0 · format 0.

## Checkpoint — 2026-08-28 (GL polish: account drill-down UI; program core complete)

- Web /gl/accounts/[id]: the F277-lean drill-down — per-period totals
  (click filters), posted lines with batch provenance, year picker;
  chart rows on /gl now link through. PRs #73/#74 deployed and
  verified (71/71, head=0070).
- **The in-house GL core is complete**: chart + periods + journal
  (slice 1) · nine-family nightly derivation (slice 2) · year-end
  retained-earnings roll + refunds + inquiry (slice 3). Remaining GL
  scope is OWNER-GATED: AP payment operations (run-01 Q2 — check runs
  /EFT/positive pay), layaway statements (Q5), fiscal calendar
  confirmation (Q4, calendar months presumed).
- Run 07 continues arriving (17 batches filed); its batch-17
  integration registry (23 external systems) + the payment-gateway
  question (Shift4 legacy vs "the new gateway"; tokens not portable)
  flagged to the owner for the cutover plan.
  Gates: typecheck 0 · lint 0 · test 0 · build 0 · format 0.

## Checkpoint — 2026-08-28 (run-03 SOM reconcile: 164 findings adjudicated, 5-question owner batch)

- `docs/handoffs/run03-sales-processing/GAP-RECONCILE.md`: the Sales
  Processing audit reconciled against the shipped stack. The run's
  three "obviously correct breaks parity" timing traps (EOD hold
  release F153, cost restatement F144, returns-at-completion F64) are
  all **deliberate anti-parity** in Jetnine — event-time release, FIFO
  actual cost, refund-date GL derivation. Blind cash balancing
  (F99–F101) and manifest route-freeze (F30) adjudicate as parity
  shipped THIS sprint; the two exception semantics (F130/F154 vs the
  cost queue) already sit on the correct sides by design.
- Seven migration cautions adopted for the cutover runbook — headline:
  never drive a STORIS extract by date range (ASAP/CWC invisibility,
  F127); import approved-pre-EOD holds as released.
- **[DECIDE] owner batch (§4, five questions)**: trade/customer
  pricing tiers · out-the-door total entry · tax-exempt customers ·
  customer merge tool (recommended yes — cutover dedupe) · membership
  rewards run/convert/drop (mechanics now known via run-07 F568).
  Docs-only PR; no code changes until §4 lands.

## Checkpoint — 2026-08-28 (runs 04–06 reconciled: audit reconcile set complete)

- GAP-RECONCILE.md written for run04-logistics-delivery,
  run05-customer-service, and run06-getting-started — every audit run
  now carries a reconcile. Standout adjudications: the F316 security
  override is **shipped parity** (SecurityOverrideService is the
  in-line second signature verbatim); as-is-as-disposition-hub (F280)
  and late piece binding (F218) are parity by construction; the F330
  reprint-pollutes-exceptions defect cannot occur here; printing is
  rendering + explicit recorded events, never a hidden transaction.
- **[DECIDE] asks batched**: run-04 §4 (licence/3PL/EDI inventory ·
  warehouse SOP walkthrough · crew-sheet prices) and run-05 §4
  (service payer axis + problem codes — recommended yes · in-home/COG
  service · call-reminder tickles + envelope-icon habit). Run 06 needs
  no batch — its one item folds into the config-photos Ops ask.
- Migration cautions adopted: resolve all open credit holds before
  extract (no hold field to carry them); establish which
  `Assign Specific Pieces At` value is live before the parallel run;
  extract STORIS service status-duration history (the one recoverable
  cycle-time record) and the live Problem Code list.

## Checkpoint — 2026-08-28 (decision queue consolidated)

- `docs/DECISION-QUEUE.md`: every open owner item in one sheet — A
  critical path (exports kickoff, config photos + licence list,
  gateway identity, terminals, commission rules, sample invoices) · B
  quick enables (cash tolerance $, fiscal calendar, crew-sheet
  prices) · C sales decisions · D service decisions · E odds and ends
  (transfer security tables, PO types, OTB, AP ops, layaway, multi-leg,
  UniData) · F Ops sessions. Defaults stated; silence keeps defaults.
  Answers get recorded doc-first in the owning reconcile.

## Checkpoint — 2026-08-28 (run-07 batches 18–26 filed; audit closeout v2 lands: 7 runs, 724 findings)

- Filed BATCH-18…26 under docs/handoffs/run07-sysadmin/ and installed
  **AUDIT-CLOSEOUT.md v2** (seven runs, 1,776 articles, 724 findings;
  v1 preserved as AUDIT-CLOSEOUT-v1-six-runs.md). Run 07 produced 54%
  of all findings from 34% of the articles — "the wiring lives in the
  configuration."
- Decision queue updated with the new critical-path asks: **A7 is TPA
  active?** (changes the PO state machine + disables banking) · **A8
  the four cheap captures** (three access reports, the STORIS data
  dictionary, audit opt-in lists, six config answers) · **A9 alternate
  tax calculation codes + twilight reason code + card platform**.
- Cutover runbook adoptions from these batches: STOP ALL PHANTOMS
  before any STORIS shutdown (F660); `REWARDS` is a hidden payment
  type that will look orphaned in extracts (F588); imported gift cards
  store numbers with alpha prefixes stripped (F703); regional zip
  records carry MEANING-BEARING BLANKS — ETL must treat them tri-state
  (F620); extract survey responses before EOM purge (F676); never
  reproduce blank-means-purge-everything (F655).
- Jetnine design validations from run-07: STORIS itself ships the
  merge-then-erase model (F713/F714 pseudonymization with 9 financial
  blockers — matches the C4 merge-tool recommendation and gives the
  erasure spec); decryption auditing with requester+grantor incl.
  denials (F710) ≈ our security_overrides/audit model; "select, then
  review, then execute" as the destructive-op house rule = our
  build-list patterns. D2's save-time re-evaluation (F700) is STORIS
  discovering event-time hold release — Jetnine's default everywhere.

## Checkpoint — 2026-08-28 (members & roles UX rebuild + per-member access, owner request)

- **Shared**: `PERMISSION_GROUPS` (19 friendly domain groups over the
  105 business permissions) + `BUSINESS_PERMISSIONS`; unit tests assert
  duplicate-free full coverage and that the super-admin platform
  surface is excluded from business grants.
- **API**: `GET/PUT /v1/business/members/:id/permissions` — the access
  sheet (role perms, overrides, effective) and a replace-set writer
  that stores only real diffs vs the role (no-ops normalized away),
  validates against BUSINESS_PERMISSIONS, rejects duplicates, audits
  before/after. Role grant validation hardened to BUSINESS_PERMISSIONS
  (platform perms were previously grantable to custom roles by API).
- **Web** (Shopify-style): /roles list (badges, permission meter,
  member counts, duplicate/delete) → /roles/new + /roles/[id] full-page
  editor with accordion permission groups, select-all-per-group
  tri-state checkboxes, human descriptions; system roles read-only with
  "Duplicate to customize". /members list decluttered (invite behind a
  header button, row→detail) → /members/[id] with profile, role picker,
  disable/reactivate/resend, store data scope, and the effective-access
  editor: checkboxes stage overrides (extra-allow/revoked chips,
  override counts, Save/Discard, Reset-to-role-defaults). Works for
  invited members pre-acceptance. New `Accordion` ui primitive +
  `PermissionGroupsEditor` shared component.
- Gates: typecheck 0 · lint 0 · build 0 · format 0 · shared unit 0 ·
  business int suite 26/26 (incl. new access-sheet tests). Full
  `pnpm test` running locally at commit time; green confirmed before
  merge (plus CI).

## Checkpoint — 2026-08-28 (New Sale UX + fulfill-from stock location + My orders)

- **Fulfill-from (owner ask: "select where the inventory is coming
  from")**: `orders.stock_location_id` (migration 0071, null = selling
  store) threaded through every reservation, release, fulfillment,
  auto-transfer, quote-expiry sweep, pending-allocation backfill, and
  delivery-completion consumption path — one coalesce, eleven call
  sites. Immovable while units are reserved (release first, by
  design); create/PATCH validated; exposed on list + detail.
- **New Sale**: "Inventory from" select (warehouse-first, "Same as
  store" default) with the product search, availability column, and
  out-of-stock banner all reading the SOURCE location; take-with fast
  path stays a register sale only when stock comes from the register's
  own store; step-numbered cards (1 Customer · 2 Items · 3 Details);
  "Exact balance" quick-fill on payments. All e2e testids preserved.
- **My orders (owner ask: every member sees their orders)**: `mine=1`
  on both list endpoints (salesperson OR second salesperson = caller;
  salesperson already defaults to the writer at create); dashboard "My
  orders" card (8 latest, status/promised/total, links to the order,
  New Sale button) for every role with orders.view; /orders gains a
  "My orders" chip + ?mine=1 deep link.
- Tests: orders suite 68→72 (warehouse-only reservation, blocked move
  while reserved + release/re-point, warehouse consumption on fulfill,
  mine on both endpoints). pos/locations now returns locationType.

## Checkpoint — 2026-08-29 (mixed fulfillment split + PER-LINE inventory source)

- **Mixed orders (owner Q: delivery + take-with on one sale)**:
  scheduling now books only delivery-bound lines (line override, else
  order type; direct-ship already excluded); an all-counter remainder
  refuses with directions. Order page: per-line method chips, a
  counter-lines hint, and "Hand over counter items (N)" on delivery
  orders — take-with lines hand over at the register on any order
  type.
- **Per-line inventory source (owner follow-up: choose each item's
  source in step 2)**: `order_lines.source_location_id` (migration
  0072, null = order default). reserveOrder/releaseOrder/
  applyFulfillment group lines by effective source (levels locked per
  location); allocatePending groups per (order, location); single-line
  releases and FIFO consumption follow the line. New Sale: order-level
  "Inventory from" replaced by a **From selector inside Add Product**
  (availability follows it, stamped on the added line) + an
  "Inventory from" select on every line row (warehouse-first); order
  page shows "from X" chips per line. Sources equal to the selling
  store normalize to null; order-level stockLocationId stays as the
  API-level default.
- Tests: orders suite 72→75 (mixed schedule/hand-over split,
  all-counter refusal message, per-line reserve/consume at two
  locations with normalization).

## Checkpoint — 2026-08-29 (order-page line editing: the phone-call model swap)

- Order detail (owner Q: customer calls to change their mattress
  model): the Lines card gains **Add product** (the shared
  ProductSearchDialog, now extracted to
  components/product-search-dialog.tsx and reused by New Sale — same
  testids; "From" selector sets the new line's inventory source) and a
  per-line **remove ✕** on unfulfilled lines with a confirm that
  explains the stock release. Both hidden while the order is locked
  (ticket printed) or closed; guard errors (lock, open run) surface as
  toasts. Add posts at list price so no discount gate fires; remove
  releases at the LINE's source and recomputes totals; both audited
  and in the order-changes feed.
- Tests: orders suite 75→76 (model swap end to end: warehouse-sourced
  line removed → warehouse reservation freed; replacement line
  reserves at the order default).

## Checkpoint — 2026-08-29 (New Exchange stress test + reason-code fix)

- Owner hit the raw error `A coded reason (class "return") is required —
pass reasonCodeId` writing an exchange in production: the New Exchange
  page never collected a reason code even though the return endpoint
  requires one the moment any active class-`return` code exists. Fixed:
  the page now loads `/v1/reason-codes?usageClass=return`, renders a
  required **Return reason** select in the Return card when codes exist
  (`data-testid="return-reason-code"`, optional free-text note when the
  registry is empty), validates before submit, and sends `reasonCodeId`
  on every return line. Second bug in the same card: **Unit credit**
  showed the list price (`unitPriceCents`) instead of what the customer
  actually paid (`perUnitCredit` = (total + tax) / qty) — the number the
  server refunds; now consistent.
- Stress test: exchanges suite 10→22 — twelve scenarios (S1–S12): the
  production repro incl. the retry-binds-the-same-documents promise (no
  duplicate order/RMA), the picker's code list, wrong-class code
  rejected, over-quantity and unfulfilled-original guards, cancelled
  original refused, the owner's 1-cent fee override netting to the
  penny, fee > return amount refused, downgrade leaves store credit,
  multi-qty partial return keeps the rest returnable, goods-not-in-hand
  deferred settle, double receive cannot double the credit. All pass.

## Checkpoint — 2026-08-29 (exchange: pay the difference + goods routing)

- Owner: exchanges where the customer owes more must collect that money
  in the flow, and the cashier must choose where the return goes back
  into stock and where the replacement comes from. Built three ways:
  - **Pay the difference**: Settlement card shows a live estimate
    (replacement total, return credit, fee, estimated balance due or
    credit kept) and a **Collect the remaining balance now** checkbox +
    tender select (`collect-balance-now`, `exchange-pay-method`). After
    settlement the page reads the exchange's exact
    `saleBalanceDueCents` and posts that payment on the replacement —
    never a client-computed number, so tax and fee are always right. A
    payment hiccup doesn't strand the flow (the order page collects).
  - **Return goods to**: `receiveGoods` gains a validated
    `receiveLocationId` (As-Is pieces stage there instead of the
    order's location; audited); exposed on
    `POST /v1/order-returns/:id/receive` body `{locationId}` and as
    `returnToLocationId` on the drop-off return path. Page select
    `return-to-location` (warehouse-marked).
  - **Replacement inventory from**: per-line source select on the
    replacement table (`exchange-line-source`) riding the existing
    per-line `sourceLocationId` — reservation and consumption land at
    the chosen location.
- Tests: exchanges suite 22→27 (exact-balance collection, warehouse
  receive staging, bogus receive location 400 + return stays
  authorized, warehouse-sourced replacement reserves there, drop-off
  returnToLocationId).

## Checkpoint — 2026-08-29 (exchange replacement lines: editable unit price)

- Owner report: a replacement line showed a $0.00 unit price (an
  even-exchange copy inherits the original line's charged price, which
  can be zero) with no way to fix it. The Unit price column on New
  Exchange is now an editable input (`exchange-line-price`, New Sale's
  line-price pattern), and the exchange create sends each line's
  `unitPriceCents` — the price on screen IS the price billed, so the
  settlement's balance-due (and the in-flow collection) charge the
  difference off the edited price. Below-list edits hit the same
  discount gates as New Sale.
- Tests: exchanges suite 27→28 ($650 edited price on a $600-list
  replacement → order bills 65,000¢, $500 credit nets, $150 collected,
  balance 0).

## Checkpoint — 2026-08-29 (customer file: detailed purchase history)

- Owner ask: the customer page must show what they bought in detail.
  New `GET /v1/customers/:customerId/order-history` — the customer's
  orders newest-first with per-order paid/balance and full line detail
  (description, qty, unit price, line total incl. tax, delivered /
  returned counts, take-with marker) in one call. The customer page's
  "Recent purchases" card became **Purchase history**: one block per
  order (number link, status, exchange/imported markers, date, promised
  date, total + owes/paid) with the items table visible beneath — no
  click-through needed; CSV export kept; legacy POS receipts moved to a
  "Sales receipts" card shown only when present.
- Tests: orders suite 76→77 (fresh customer, two orders: newest-first
  ordering, paid/balance math, line description/price/state fields).

## Checkpoint — 2026-08-29 (purchase history: legacy receipts included)

- Owner report (PAT WEAVER): 2 lifetime documents / $932.93 but
  Purchase history said "No orders yet" — the documents are imported
  STORIS sales receipts, which live in `sales`, not `orders`.
  `/order-history` now merges both: orders and sales newest-first with
  a `docType` marker, sale lines from `sale_lines` (settled: paid in
  full, goods handed over). The customer page shows receipts in the
  same Purchase history blocks (linked to /sales/:id, "receipt" chip)
  and the separate Sales receipts card is gone.
- Tests: the history test now also inserts a 2024 STORIS receipt and
  asserts merged ordering, docType, and receipt line detail (77/77).

## Checkpoint — 2026-08-29 (POS customer capture + warehouse default source)

- Owner (New Sale): the inline new-customer form now captures the
  delivery address, a billing address when "Billing address is
  different" is checked, and "How did they hear about us?" (datalist
  suggestions) in the SAME Create — no create-then-edit round trip.
  Addresses write the established `addressesJson` array convention
  (entry 0 labeled `delivery` — the delivery flow reads it — billing
  second); the lead source is a real column — migration
  **0073_customer_referral_source** (`customers.referral_source`) —
  carried through create/patch/list/detail and editable on the customer
  page's Details form (which also gained delivery/billing address
  fields).
- Add Product default: the search dialog's "From" location — and
  therefore each added line's inventory source — now defaults to the
  warehouse when one exists (also after "next sale" reset); the cashier
  flips From to the store for floor stock.
- Tests: customers suite 10→11 (create with both addresses + referral,
  detail echo, patch updates the source without clobbering addresses).

## Checkpoint — 2026-08-29 (New Sale tax: effective rate wiring)

- Owner: business default tax set to 9.75% but New Sale showed 0.00%.
  The written order was always taxed correctly (4-level resolution ends
  at `businesses.default_tax_rate_bps`), but `/v1/pos/locations`
  returned the location's RAW `taxRateBps` — null when the location
  inherits the default — and the register rendered that as 0.00% with
  wrong on-screen totals. The endpoint now returns the effective rate
  (`location.taxRateBps ?? business default`), so the screen matches
  what the server charges.
- Tests: taxes suite 13→14 (a location with no rate of its own reports
  the business default through pos/locations).

## Checkpoint — 2026-08-29 (order page payments: New Sale parity)

- Owner (SO-2026-000016): taking a payment on the order's full page now
  mirrors the New Sale register — the same labeled tender list (Credit
  card / Cash / Check / PayPal / Venmo / Zelle / Synchrony / Acima /
  Store credit), a "Reference / last 4 / approval #" input on non-cash
  tenders (sent as `processorRef` — the API already stored it), an
  "Exact balance" quick-fill, and the payments table shows the tender
  label plus a Reference column.

## Checkpoint — 2026-08-29 (order page: confirm a draft into a live sale)

- Owner: a saved draft (SO-2026-000016) had no way to become a real
  sale from the order page. New primary button **"Confirm order — make
  it a live sale"** on draft orders (`data-testid="confirm-draft"`),
  calling `PATCH /orders/:id {status:'open'}` — the sanctioned path that
  reserves stock AND re-runs the G6 price-variance gate for parked
  drafts (the bare /reserve does not). Also hid "Release reserved
  stock" on drafts (nothing is reserved yet). API path was already
  fully tested (draft → open + qtyReserved), so this is web-only.

## Checkpoint — 2026-08-29 (per-member nav visibility + selling-store scope)

- Owner: (1) any left-nav tab can be hidden per member; (2) the owner
  picks which stores each member can sell out of.
- **Nav**: migration **0074_member_hidden_nav**
  (`memberships.hidden_nav_json`), `hiddenNav` on members list/PATCH
  (validated hrefs, deduped, audited), new `GET /v1/business/members/me`
  (the caller's own hiddenNav/dataScope/scopeLocationIds — no permission
  needed). The app shell fetches /me and drops hidden tabs (empty groups
  vanish); the member page gains a **Navigation** card — grouped
  checkboxes mirroring the sidebar, immediate save, "Show all" reset.
  Visibility only: the API stays permission-gated.
- **Selling stores**: rides the existing data-scope +
  membership_location_scopes rows (the member page's scope card,
  retitled "Store access"). NEW enforcement: `assertSellingScope` 403s
  order/sale creation at out-of-scope locations ("You are not set up to
  sell at this location…"), and `pos/locations` filters a store-scoped
  member's list to their stores (warehouses always pass — they are
  inventory sources, not selling locations).
- Tests: orders suite 77→80 (scoped cashier blocked off-scope + allowed
  in-scope + filtered pos/locations + owner unrestricted; hiddenNav
  dedupe/roundtrip via /me; malformed hrefs 400; cleanup restores).

## Amendment — 2026-08-29 (selling scope decoupled from data scope)

- Owner amendment (supersedes the morning's coupling): members should
  **see all stores' data** but **sell only at approved stores**, pick
  the store at login, and have the money tendered count toward that
  store. Migration **0075_member_selling_scope**
  (`memberships.selling_scope` 'all'|'approved'); tenant context carries
  `sellingScope` (scope rows load when either scope is restricted);
  `assertSellingScope` + the pos/locations filter now key off
  sellingScope, leaving dataScope purely about visibility. Member page
  "Store access": two switches (Where can they sell? / Whose data can
  they see?) over one Approved-stores list.
- **Login store choice**: `/members/me` returns sellingScope + the
  approved stores WITH names; the app shell shows a "Which store are
  you selling at today?" picker on first load of a login session
  (auto-picks a single store), stores the choice in sessionStorage, and
  shows a topbar "Selling at X" chip (click to change). New Sale opens
  at the session store, so sales/orders — and every tender on them —
  post to that store's drawer, shift, and closeout.
- Tests reworked: approved-only cashier blocked off-scope, allowed
  in-scope, pos/locations filtered, **data still visible everywhere**
  (owner's off-scope order listed), /me carries the picker payload.

## Checkpoint — 2026-08-29 (At Risk: approved-store filter + by-salesperson)

- Owner: members' At Risk queue shows only orders from stores they are
  approved for, worked by salesperson. New `sellingScopeCond` (read
  filter twin of assertSellingScope) ANDed into delivery-jeopardy — an
  approved-only member's call list covers exactly their stores (fail
  closed at zero); owners/unrestricted see everything. Rows now carry
  `salespersonMembershipId`/`salespersonName` (memberships→users, email
  fallback) and the CSV gains the column. The jeopardy page groups rows
  into per-salesperson sections (name header + line count, unassigned
  last as "No salesperson").
- Tests: reports suite 39→40 (annex at-risk order carries its
  salesperson; approved-only cashier's report drops the annex row,
  keeps main-store rows; owner unrestricted; cleanup restores).

## Checkpoint — 2026-08-30 (backorder order split)

- Owner: multiple delivery dates from a backorder → select the product
  and split the order. New `POST /v1/orders/:id/split`
  ({lines:[{lineId, quantity?}], requestedDate}): the picked lines (or
  partial quantities) move to a NEW order copying customer/store/
  salespeople/addresses with its own promised date; moved units'
  reservations release at their per-line source and re-reserve on the
  new order; discounts travel proportionally; payments STAY on the
  original (each order then shows its own balance). Guards: unlocked,
  not on an open run, delivered units stay, moving everything is
  refused ("change the promised date instead"). `order.split` webhook +
  audit on both orders (timeline shows the link).
- Order page: **Split order…** mode in the Lines card — checkboxes on
  movable lines, a "New promised date" input, one confirm
  (`split-order`/`split-line`/`split-date`/`split-confirm` testids).
- Tests: orders suite 80→83 (partial-qty split moves reservation and
  money math checks out — source+target totals equal the original,
  deposit stays; moving everything 400; over-quantity 400).

## Checkpoint — 2026-08-30 (split-at-sale -A/-B, login-store view, reserved drill-down, untaxed fee)

- **Split at New Sale + family numbering**: order create gains
  `splitByDeliveryDate` (New Sale always sends it) — lines promised on a
  different date than the order peel off at write time into sibling
  orders, one per distinct date. Split numbering everywhere (endpoint
  included) is now the family scheme: the base number stays and pieces
  get **-A, -B, …** (`nextSplitNumber`, strips an existing letter so a
  re-split continues the family). Create returns `splitOrders`; New
  Sale's done screen links the siblings ("payments stay on …").
- **Login-store view + all-location sourcing** (owner amendment):
  `pos/locations` returns EVERY location again with a `canSellHere`
  flag — members see and source inventory from anywhere; the register's
  selling-location picker filters to canSellHere (server still enforces
  at write). Orders list + list-view gain `locationId`; the orders page
  defaults an **"At {login store}"** chip from the session store
  (clearable — data scope already permits more).
- **Reserved drill-down**: new `GET /v1/inventory/reservations`
  (variant+location → the order lines holding the units, by effective
  source) and `POST /orders/:id/lines/:lineId/release` (frees one
  line's reservation; audited). The inventory page's Reserved count is
  now a button → dialog listing the holding orders with per-row
  Release; the freed stock is sellable immediately and can be
  re-reserved on any order from its page.
- **Recycling fee never taxed** (owner): pinned by test — custom
  Recycling Fee lines carry 0% while merchandise taxes at the business
  rate; and the take-with fast path no longer swallows the fee line
  (carts with custom fees write an order, where the fee is a
  first-class untaxed line, instead of the variant-only plain sale).
- Tests: orders suite 83→88 (BASE-A at write time, manual re-split -B,
  drill-down + release + re-release 400, locationId filter, untaxed
  fee); pos/locations scope test moved to the canSellHere flag model.

### Checkpoint — 2026-08-30 (split money integrity: payments follow the goods)

Owner handoff (SO-2026-000018 / -A, Vladimir B.): a fully-paid order was
split and the child demanded $273.28 again while the parent silently held
a $271.52 credit. Three bugs, fixed as one slice:

- **Payments reallocate on split** (`executeSplit`): after both totals
  recompute, whatever was collected past the parent's new total moves to
  the child (newest payment rows first; a straddling row splits in two,
  both halves keeping method/kind/processorRef so the one real charge is
  traceable from either order). Invariant enforced in code: parent +
  child totals always equal the pre-split total (rounding drift is
  pinned onto the child). Both pieces also get their OWN policy
  deposit-required — no more "$73.26 deposit" on an $18 fee order.
  `order.split` audits carry `movedPaymentsCents`.
- **One register tender covers a split family** (`takePayment`): the
  over-collect guard now allocates across the family (base + -A/-B
  siblings, this order first) before refusing — split-at-sale carts
  paid in full at New Sale land each sibling as paid; past the family's
  combined balance is still a 400. Per-order rows/audits/webhooks.
- **Credit is visible + movable**: order detail/list expose
  `creditDueCents` (list rows show "Credit $X" in the balance column;
  the Money card shows "Overpaid — credit" with per-sibling **Move
  credit to …** buttons) and detail gains `family` (linked split
  siblings). New `POST /v1/orders/:id/move-credit {toOrderId}` moves
  min(credit, target balance) between one customer's orders (audited
  both sides).
- **Data repair — migration 0076_split_money_repair** (data-only,
  custom migration; drift check clean): untaxes recycling-fee lines on
  in-flight orders + rebuilds those headers/deposits, then finds split
  pairs (`notes LIKE 'Split from %'`) with an overpaid parent and an
  owing child and reallocates, writing audit rows. Idempotent. On
  deploy this fixes SO-2026-000018/-A in place — do NOT take payment on
  -A before this deploys; after it, both show $0 due.
- Note: current code already preserved per-line tax through a split (the
  live pair's $1.76 came from the fee line being taxed at creation under
  an older build — repro proved it; the repair untaxes it).
- Tests: new `split-payments.int.spec.ts` (7) — full-pay split → both
  paid; deposit-only stays put; partial excess moves exactly; family
  tender + refusal past family balance; move-credit + wrong-customer
  400; the 0076 repair run twice against a fabricated copy of the prod
  breakage. Orders suite still 88/88.

### Checkpoint — 2026-08-30 (manager dashboard, slice 1)

Owner handoff (manager-dashboard UX audit) + 6 owner answers: per-member
toggle decides who gets it; the dashboard carries its OWN store picker
over the member's approved stores; manager dashboard ships first;
written-sales leads with collected alongside; dedupe/merge and nav work
deferred to later slices; the owner keeps the company-wide dashboard.

- **Migration 0077_member_manager_dashboard**: `memberships.manager_dashboard`
  boolean. Member page "Store access" card gains the Store manager
  dashboard checkbox (`manager-dashboard-{id}`); members PATCH + /me
  carry `managerDashboard`.
- **`GET /v1/dashboard/manager?locationId=`** (orders.view + the toggle,
  403 otherwise): ONE aggregate call returning KPIs (mine/store written
  - collected today, my open book + balance, my closed 7d, open
    exceptions + past-due promises), a 14-day mine-vs-store series, the
    week's associate leaderboard (order splits + register sales folded
    per person), an open-pipeline breakdown, and four queues (my open /
    store open / recently closed / today's deliveries) with customer
    name + PHONE + balance due + salesperson on every row. **"Today" is
    the STORE's local calendar day** (`AT TIME ZONE location.timezone`) —
    fixes audit D3; pinned by a test that writes an order at 23:00 store
    time (tomorrow in UTC) and sees it count today. Store picker list =
    approved stores for selling-restricted members (403 past it), every
    active store otherwise.
- **Web**: /dashboard reads /me — flagged members get the new
  `manager-dashboard` view (store picker defaulting to the login store,
  clickable KPI tiles, mine-vs-store day chart, leaderboard bars,
  pipeline bar, Mine/Whole-store queue tabs, today's deliveries with
  windows); everyone else keeps the existing page untouched.
- Tests: reports suite 40→42 (toggle gate + /me roundtrip; approved-store
  403, store-local tz delta, queue columns, leaderboard, past-due).
- Later slices from the handoff: global omnibox + customer-call flow,
  customer dedupe (warn-on-create + merge, owner-picked), existing
  dashboard D2–D10 fixes.

### Checkpoint — 2026-08-30 (global omnibox, handoff slice 2)

The audit's one **Critical** finding (G1): no way to reach a calling
customer from wherever you are.

- **`GET /v1/search?q=`** (orders.view): one call matching customers by
  name, email, and PHONE — compared digits-to-digits, so "(818)
  555-0142", "818.555.0142" and "8185550142" all hit — plus orders by
  current OR legacy STORIS number and register receipts by number, each
  respecting the caller's data scope. Queries under 2 chars return
  nothing.
- **Omnibox in the topbar** (every page): ⌘K / Ctrl-K focuses it,
  results group Customers / Orders / Receipts with arrow-key + Enter
  navigation, click-outside/Escape dismiss; a hit deep-links to the
  customer page (with its full purchase history), the order, or the
  receipt. Phone → customer page = two interactions, per the handoff's
  acceptance bar.
- Tests: orders suite 88→92 (auth gate + clerk allowed, three phone
  formats + name, partial current number, legacy ST- number, imported
  receipt flag, short-query empty).
- Still queued from the handoff: customer dedupe (warn-on-create +
  merge — owner-picked), then D2–D10 on the standard dashboard.

### Checkpoint — 2026-08-30 (customer dedupe: warn + merge, handoff slice 3)

Owner-picked "warn on create + merge tool" (G4 — the same caller existed
4–6×, breaking the phone-call flow):

- **`GET /v1/customers/:id/duplicates`**: same phone digits (any
  formatting), same email, or the same exact name — each row marked with
  what matched and how many documents it owns; never lists the customer
  themselves.
- **`POST /v1/customers/:id/merge {sourceCustomerId}`**
  (customers.update): re-homes EVERYTHING the duplicate owns — orders,
  sales, store credit, returns, discount redemptions, service tickets,
  notes, tag links (deduped), gift cards, serialized units — onto the
  keeper, backfills the keeper's blank contact fields from the
  duplicate, deletes the duplicate, audits (`customer.merge`) and fires
  the new `customer.merged` webhook. Self-merge 400, unknown source 404.
- **Customer page**: "Possible duplicates" card with per-row
  "Merge into this record" (confirm dialog spells out the move).
- **POS warn-on-create**: typing 7+ phone digits on the New Sale
  new-customer form checks for an existing match and offers
  "Looks like {name} already exists — use them instead?" with a
  one-click "Use existing" that attaches them (create never blocked).
- Tests: customers suite 11→14 (three phone formats + email + name-only
  matches; merge moves orders/sale/credit + backfill + duplicate gone +
  history shows moved docs; self-merge/unknown guards).

### Checkpoint — 2026-08-30 (dashboard daily-ops pack, handoff slice 4)

Owner-approved 20-item list ("make the dashboard helpful for daily
operations") — all on the manager dashboard, one aggregate call:

- **Migration 0078_member_monthly_goal**: `memberships.monthly_goal_cents`;
  member page gains a "Monthly sales goal" field.
- **Store-wide (10)**: sales-today tiles now carry ▲/▼ vs the same
  weekday last week (from the existing 14-day series); the deliveries
  board covers today AND tomorrow with driver, window, and
  balance-to-collect; Needs attention adds unpaid-14d+ to past-due
  promises + exceptions; a Backorder watch (open orders with unreserved
  stock units, soonest promise first); Aging carts (drafts/quotes oldest
  first with age); Returns & exchanges in flight; Incoming stock
  (in-transit transfers + ordered/partially-received POs by expected
  date); Drawer & tenders (today's tender mix bars + open/closed/
  suspended shift state); store-scoped Low stock (severity-sorted,
  stocked variants only); the activity feed grouped one row per order
  with expandable events.
- **Per-member (10)**: My sales today + delta; My month vs goal
  (progress bar, any store); My commission accrued this period
  (commission_entries by payroll period); My open sales worklist with
  next-action chips (N short / confirm / collect & schedule / collect);
  My call-backs (my aging drafts/quotes); My deliveries today+tomorrow;
  my at-risk rides the backorder/past-due data; My wins (closed 7d,
  mine); My follow-up money (store-credit holders whose latest order is
  mine + my returns in flight); Open-sales Mine/Whole-store tabs kept.
- Endpoint stays ONE call: ~10 added queries, all store-scoped and
  capped; queue rows now carry membership ids, createdAt, and shortUnits
  so "mine" filtering happens client-side.
- Tests: reports suite 43 (new daily-ops test seeds a short-stocked
  order, week-old draft, live return, tomorrow's delivery, in-transit
  transfer, ordered PO, thin stock, credit holder + goal PATCH, and
  pins each block; tender mix pins today's cash).

### Checkpoint — 2026-08-30 (deliveries calendar: a month on screen)

Owner: "deliveries shows only 7 days then you hit next — I want 30 days
on screen, same style." The board now renders FIVE week-rows (35 days,
aligned Sunday–Saturday) in the identical day-column style, one fetch
for the whole range (the API's 62-day cap already allowed it), drag-to-
reschedule works across every visible day, per-cell min-height trimmed
so five rows scan well. Buttons relabeled Prev week / Today / Next week.
Web-only — ships via Vercel from main, no API deploy.

### Checkpoint — 2026-08-30 (POS sourcing defaults, order add-item price+payment, reason codes optional on returns)

Owner batch of four:

- **Add Product defaults to the warehouse for everyone** — New Sale and
  the order page both; warehouse matched by location type OR name
  (locations created before location types existed).
- **Take-with pulls from the login store**: New Sale lines added under
  take-with default their source to the selling location (per-line
  "From" select still changes it); switching fulfillment re-defaults
  every stock line (take-with → store, delivery → warehouse).
- **Order page add-item works like New Sale**: picking a product now
  opens a price step (unit price defaulting to list + quantity,
  `add-line-price`/`add-line-qty`/`add-line-confirm`); on add, the
  payment form pre-fills with exactly what the new item added to the
  balance so the money is one click away. API already accepted
  `unitPriceCents`; G6 variance gate still applies to discounts.
- **Coded return reason no longer required** (owner: "we already have a
  reason field to type in"): `resolveReason` gains `codeOptional`, set on
  both return paths — free text is accepted even while return codes
  exist; a code still binds when passed, wrong-class codes still 400.
  The pickers are gone from the exchange writer and the order-page
  return dialog; the typed reason field stays. Other reason classes
  (exceptions, adjustments, counts, delivery failures) unchanged.
- Tests: exchanges S1 rewritten to pin the amendment (free text 201 with
  active codes + code-binding path); orders suite 92→93 (add-line at a
  set price: line price, balance delta = charge+tax, payment lands).

### Hotfix — 2026-08-30 (manager dashboard 500: int32 overflow in month-written SQL)

Owner screenshot: a member's dashboard showed "Internal server error".
Render logs pinned it to the month-written aggregate: `total_cents *
10000` in int32 overflows for any order past $2,147.48 — i.e. every
real mattress order; tests used small totals so it passed. Fix:
`total_cents::bigint` in both CASE branches. The daily-ops test's
big-ticket fixture is now $50,000 so the overflow path is exercised
(the assertion floor rose to $50.4k written).

### Checkpoint — 2026-08-30 (New Sale: repeat product = new line at its own price)

Owner: adding the same product again must land as an additional line so
a second unit can sell at a different price. Add Product no longer
merges into an existing line — every add pushes a fresh line with its
own editable price box (quantity per line still editable when one price
covers several units). Client-only; the API already handled duplicate-
variant lines (reservation pooling + split-at-sale tests pin it).

### Checkpoint — 2026-08-30 (discount-approval popup removed — G6 demoted to log-only, amendment A10)

Owner: "remove the discounts need approval popup for all users. Its a
distraction and all users can approve discounts without a reason."
Recorded as PLAN-STORIS-GAP amendment A10 (supersedes A6, restores the
original PLAN-POS-OPERATIONS "no approval, no cap" decision). The
price-variance service no longer throws REASON_REQUIRED or demands the
orders.price_override security override at any tier — it only records
the exception (tier 2 info, tier 3 warning, below-cost critical), with
any volunteered reason stamped on. New Sale's "Discount needs approval"
dialog and its retry plumbing are deleted; the order page needed no
change (its remaining override dialog is the return-window gate, which
stays). Settings keep the tier thresholds since they still grade the
exception register. G6 specs rewritten to pin the log-only behavior;
layaway-minimum, return-window, and all other override gates untouched.

### Checkpoint — 2026-08-30 (product deactivate button + full product delete)

Owner hit an "INP Issue" box deactivating the recycling fee — that box
is the Vercel toolbar's performance monitor flagging the blocking
`confirm()` dialog, not an app error. Real gaps fixed instead: the
product page only had per-variant Deactivate, so the header now carries
product-level Deactivate/Reactivate (PATCH isActive — search and New
Sale already exclude inactive products at both product and variant
level) and a "Delete product…" button. New `DELETE /v1/products/:id`
(products.delete, already seeded to Owner/Manager): hard-deletes the
product and variants only when stock is zero everywhere and no
order/sale/PO/transfer/as-is/write-off row references any variant —
otherwise 400 naming the exact blockers and steering to Deactivate.
Catalog cascades (levels, cost layers, serials, physical-inventory
rows, images) ride the FKs; order/sale lines would keep their text but
a documented product is refused anyway. 4 new catalog spec tests.

### Checkpoint — 2026-08-30 (recycling fee: manual "+ Recycling" button, no auto-add)

Owner: the fee must stop auto-adding with every mattress/foundation/
adjustable base — it now sits next to "+ Removal ($0)" and works the
same way. New Sale's Items header gains "+ Recycling ($10.50)" (label
follows the admin rate): first click adds the single untaxed fee line,
each further click counts one more unit on it; the associate removes it
like any line. The per-product auto-add block and the RECYCLING_RE
matcher are gone; totals/tax math untouched (fee stays untaxed via the
custom-line path). PLAN-POS-OPERATIONS §4 fee bullet amended in the
same commit. Web-only — Vercel ships it on merge.

### Checkpoint — 2026-08-31 (order lines edit in place — New Sale parity)

Owner: "in orders for Line needs to look and function similarly to how
it does in New Sale." The order page's Lines table now carries New
Sale's columns — Item / Type / Qty / Price $ / Disc $ / Fulfillment /
Inventory from / Amount — with in-place inputs (commit on blur, snap
back on error) while the order is live and unlocked; reserved/fulfilled
counts sit under the item name and a stock line short at its source
shows the amber "not reserved" strip. Server: PATCH
/v1/orders/:id/lines/:lineId grew from the PO-060 type flip into a full
line editor (quantity, unitPriceCents, lineDiscountCents,
fulfillmentMethod, sourceLocationId, deliveryDate). Reservations follow
the edit — shrink releases the excess, growth tops up, and a source
move releases at the old location and re-reserves at the new one; money
edits reprice the order and run the A10 log-only price monitor;
quantity can never drop below what's fulfilled. 4 new orders-spec
tests. API change — deploy rolled after merge.

### Checkpoint — 2026-08-31 (take-with hand-over + family invoice + recycling on orders)

Owner batch, six answers locked. (1) The order page's Lines card gains
the same "+ Recycling ($x)" button as New Sale (one untaxed fee line,
each click counts a unit). (2) Take-with hand-over: Complete on a live
order (New Sale calls it after payments; the order page's "Complete
take-with items" button; the per-line hand-over button is REMOVED)
splits take-with lines to a -A sibling — executeSplit gained
payChildFirst (collected money covers the walking goods first) and a
fulfillmentType override — then tryCompleteTakeWith tops up the
reservation and, when every unit is covered and the money is in,
fulfills and completes the piece. Short or unpaid pieces stay open
(never an error): the response says why, the order page shows the amber
waiting banner, and one click on the piece finishes it after a user
with inventory access adjusts the stock in. (3) The invoice document
now carries familyInvoice — every piece's lines under the base number
with take-with lines marked "TAKEN WITH", family-combined money —
rendered by InvoiceDoc from either piece. (4) DeliveryTicketDoc never
prints take-with lines. PLAN-POS-OPERATIONS §4 amended. 3 new
take-with int tests (100 orders tests green), full e2e green.

### Checkpoint — 2026-08-31 (secondary phone + delete-draft chips)

Owner: optional secondary phone in the New Sale customer capture, and
a delete option on open drafts. Migration 0079_customer_phone2 adds
`customers.phone2` (nullable). API: create/PATCH/read carry it, the
dedupe check matches on either of a record's two numbers, customer
merge backfills a lone phone2, and the omnibox phone-digit search hits
phone2 too. Web: New Sale's capture row gains "2nd phone (optional)"
(grid now 5 columns) and the customer page gets the matching edit
field; each draft chip gains an ✕ that cancels the draft after a
confirm ("draft deleted at the register" — same cancel the
supersede-on-complete path uses). 2 new customers-spec tests.

### Checkpoint — 2026-08-31 (declined-foundation $0 line button)

Owner: next to Recycling, a one-click way to document that the client
declined a new foundation. "+ Declined foundation ($0)" now sits in the
Items header on New Sale and in the order page's Lines card — each
click adds a "Client Declined New Foundation" custom line at $0 (no
price, untaxed, removable like any line), so the declination prints on
the invoice. Web-only; the server already accepts $0 custom lines.

### Checkpoint — 2026-08-31 (delete product from the Products list)

Owner: delete without opening the product. Each Products row gains a
red Delete action next to Open — same DELETE /v1/products/:id as the
product page (server still refuses anything with stock or document
history, with the exact reason as a toast), confirm first, list
refreshes. Web-only.

### Checkpoint — 2026-08-31 (sale_line import entity — receipts get their items back)

Owner: imported sales show only money — product info missing. Root
cause: the STORIS closed-sales import was header-per-invoice only;
there was NO sale_line entity, so commitSale wrote the receipt + one
payment and zero sale_lines. New import entity `sale_line` ("Closed
sales history lines (per item)"): INVOICE#/TICKET# + LINE# + SKU/MODEL#

- DESCRIPTION + QTY + UNIT_PRICE + EXT_PRICE, validated against
  committed sale headers ("commit sale headers first"), catalog SKUs bind
  the variant, unknown/blank SKUs still import with their description
  (legacy models need not exist in the catalog), D7-idempotent upserts by
  invoice#line, recon gate 1 counts it. The wizard picks it up
  automatically (spec-driven). OPS: the owner must export the per-item
  closed-sales file from STORIS and run Settings → Import → sale_line;
  the header receipts already imported stay put and the lines attach by
  invoice number. 1 new import spec test (12 pass).

### Checkpoint — 2026-08-31 (New Sale delivery date books the truck)

Owner: the New Sale delivery date only set the promised date, leaving a
second manual trip to the order page to schedule the real delivery.
Completing a delivery sale now BOOKS it: after payments (and the
take-with hand-over), New Sale posts the existing
/orders/:id/deliveries endpoint for the order at its date and for each
split-at-sale sibling at its own date (confirmOverCapacity — the
capacity hint next to the date already warned the writer; over-cap
bookings log the standard exception). All server guards apply
unchanged: take-with/pickup/direct-ship lines never board, quotes and
drafts don't book. The done screen names the booked dates; a booking
failure toasts "schedule it from the order page" and never loses the
sale. Order page: each scheduled/loaded delivery in the Deliveries card
gains an inline date input (PATCH reschedule) so date changes happen
from the order, per the owner. Web-only; e2e suite green.

### Ops note — 2026-08-31 (STORIS sale-lines file converted, handed back)

The owner's "all_invoices_Storis.txt" is the TE.326.RPT Written Sales
Summary report (not a CSV): per-order blocks, item segments jammed on
one physical line, page headers, CRLF. Converted offline (scratchpad —
export data is never committed) into the sale_line import CSV: 1,078
lines / 382 invoices (251 base + 131 \*-suffix pieces). Parser handles
page breaks, As-Is/EXCHANGE/TAKE WITH types, letter-suffixed backorder
quantities ("1P"), and duplicate invoice blocks. Known data limits, by
the report's own semantics: the report prices the package on the first
line ($0 on the rest); exchange lines show the full item price while
the header bills the difference; the report's final order 0111854
($1,000, 03/07/16) is cut off mid-block — its items are not in the
export and need a re-export or manual entry. CSV delivered via chat;
owner runs Settings → Import → "Closed sales history lines (per item)"
→ Validate → Commit. Validation names any invoice numbers that don't
match the previously imported receipts.

### Ops note — 2026-08-31 (password-reset links pointed at a dead Vercel preview)

Owner's reset email linked to
la-mattress-erp-git-claude-fix-latent-…-alwayzlegits-projects.vercel.app
(NXDOMAIN). Root cause: BETTER_AUTH_URL on the Render API service was
set to that stale branch-preview URL, and better-auth stamps its
baseURL into every reset/verification link — sign-in never used it,
which is why only these links were broken. Fixed: BETTER_AUTH_URL →
https://jetnine-api.onrender.com (env merge via Render MCP; redeploy
dep-daake1oae00c73a5cvfg live 09:20 UTC, boot 80/80). Old emailed links
stay dead by nature — a fresh "forgot password" email carries the
right host and lands on lamattress-erp.vercel.app/reset.

### Checkpoint — 2026-08-31 (S01 browser-audit batch 1: money safety + audit-records repair)

The owner's Claude-in-Chrome audit of Sales Order Entry (41 findings,
BA-0001…BA-0041, now committed under docs/browser-audit/) opened four
decisions, all answered: warn on nav-away (not autosave); keep the
draft-cancel mechanics but fix the display; owner will set list prices
himself (picker label fixed meanwhile); audit test records repaired by
migration. This batch ships the S1s + money-safety S2s:

- 0080_s01_audit_cleanup — deletes the ZZTEST customer, the three test
  orders, and the phantom $1,254.50 cash payment; hands reserved units
  back to stock; audited; idempotent (verified twice on a scratch DB).
- BA-0002: money typed in the payment box blocks Complete with the
  reason instead of silently posting the order unpaid.
- BA-0027: an empty amount box no longer records the placeholder — the
  first click commits the balance INTO the field, visible before it
  becomes money.
- BA-0003: the reference field renders for every tender and the error
  slot reserves its height, so Complete never moves under the cursor.
- BA-0004/0006: qty 0/negative keeps the line (✕ is the only removal);
  quantity capped at 999 with a toast.
- BA-0005: past delivery dates refused at submit + min= on the field
  (they book real trucks since yesterday).
- BA-0026: the order-discount box says when it was capped.
- BA-0001: dirty-sale guard — beforeunload + confirm on in-app nav.
- BA-0019 (partial): unpriced items say "price at register", not $0.00.
- BA-0016 (display): cancelled orders show — in Balance due.
  Remaining batches: print/copy (P-010/011/021/022), keyboard (P-007/008),
  lists (P-013/014/018/019/024), build identifier.

### Checkpoint — 2026-08-31 (S01 browser-audit batch 3: print/copy — P-010/011/021/022 + build id)

Batch 1 deployed (dep-daau6ooae00c73anrh5g, boot 81/81
head=0080_s01_audit_cleanup — the ZZTEST records and the phantom
$1,254.50 are gone from production). This batch fixes every print/copy
finding; §11 of PLAN-POS-OPERATIONS.md amended first (doc-first).

- BA-0013: invoice prints the salesperson's full name, not initials.
- BA-0014: Sold To carries the billing street address with ZIP (new
  `customer.address` on the document payload, billing entry preferred);
  Ship To falls back to printing the billing address instead of the
  bare "Same as billing".
- BA-0030: Customer # dropped from the invoice strip — no human-facing
  customer number exists, and an id fragment fails the paste-into-search
  test.
- BA-0015: one definition of Merchandise — the invoice totals box now
  excludes the recycling fee from Merchandise and breaks it out on its
  own Recycling line (CA itemization), matching New Sale. Totals
  unchanged; works for combined family invoices too.
- BA-0028: delivery ticket drops fee lines (lineType custom) from the
  load list — same rule the pick list already used.
- BA-0029: Code 39 barcodes, no library — order-number barcode on the
  delivery ticket and pick list, per-line SKU barcode on the pick list.
- BA-0041: documents print tender labels ("Cash", "Credit card"), not
  raw enum values.
- BA-0031: stale roadmap copy deleted — the New Sale done screen and
  the order page cancel card now describe what exists.
- BA-0040: toasts moved bottom-right so they never cover Open register.
- Audit hygiene: sidebar shows "Build <sha7>" from
  NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA (Vercel system env, default-on;
  shows "dev" locally).
  Remaining batches: keyboard (P-007/008), lists (P-013/014/018/019/024),
  plus BA-0017/0021/0038-copy stragglers.

### Checkpoint — 2026-08-31 (S01 browser-audit batch 4: keyboard + labels — P-007/P-008)

Batch 3 deployed (dep-daaule6k1f9s73euop80 live, 81/81; web via Vercel
on the main merge). This batch makes order entry keyboard-completable
and names every control.

- BA-0010: Add Product results are keyboard-operable — ArrowUp/Down
  move a visible highlight, Enter (from the search box) adds the
  highlighted product, highlight follows the mouse too.
- BA-0011: the popup is a real dialog — role=dialog + aria-modal,
  focus trap (Tab wraps), Escape closes, and focus returns to whatever
  opened it.
- BA-0036: the drafts strip renders DOM-last with CSS order keeping it
  visually on top — tab from the top of the page reaches the customer
  search first, and the entry path owns the early tab stops. Draft
  dismiss buttons were already named per draft.
- BA-0009: every previously unnamed control on New Sale has a
  programmatic name — placeholder-only inputs got matching aria-labels
  (23 by sweep + customer search, tender method, payment amount,
  reference, and per-line qty/price/discount/fulfillment named for
  their item). Field-wrapped controls were already named via the
  wrapping <label>. Visible-label-above-every-field remains a design
  call for the S17 redesign pass — the audit's measurable (non-empty
  accessible name on every control) now passes.
  Remaining: lists batch (P-013/014/018/019/024), BA-0017/0021 stragglers.

### Checkpoint — 2026-08-31 (S01 browser-audit batch 5: lists — P-014/016/017/018/019/024)

Batch 4 merged (PR #116; web-only, ships via Vercel). This batch is the
lists pass plus the two small stragglers.

- BA-0018 (P-014): Orders list columns Order # / Customer / Delivery
  Date / Balance Due are sortable with direction toggle and aria-sort.
  Derived columns sort server-side via scalar subqueries (min undelivered
  trip date coalesced to requested date; total minus succeeded payments);
  sorted views paginate by offset cursor ("o:<n>"), unsorted keeps the
  created-at cursor.
- BA-0024 (P-014): q/status/view/mine/sort/dir mirror into the URL
  (router.replace) and initialize from it — reload, bookmark, share.
- BA-0023/0033/0034 (P-018): one dense table pattern — .table-dense +
  .table-sticky utilities; Orders and Sales lists both scroll inside a
  max-height card with a sticky header; the Orders line summary rides
  inline so rows drop to ~41px; Sales rows open on click like Orders;
  Sales dates print "Aug 31, 2026 9:14 PM" (no seconds); the duplicate
  Open register button left the Sales header (global top bar has it).
- BA-0025/0039 (P-019): the Orders empty state names the active filters
  and offers Clear filters; a bad order URL renders a titled "Order not
  found" card inside the normal frame with a back link.
- BA-0035 (P-024): order-detail header now has ONE primary control — a
  Documents ▾ menu (Invoice / Delivery ticket / Pick list, same
  testids), Share stays secondary, and "← All orders" became an
  Orders / <number> breadcrumb.
- BA-0020 (P-016): members with empty-string names fall back to email in
  the salesperson dropdowns and on printed documents.
- BA-0021 (P-017): reopening a draft re-checks availability for its
  variants (product-search gained variantIds=) so the amber
  stock/special-order warning survives the round trip.
  Remaining from S01: P-013 status-vocabulary unification (one display
  status across list/detail/filter — needs the detail endpoint to carry
  displayStatus; next slice), BA-0017 rides with it.

### Checkpoint — 2026-08-31 (S01 browser-audit batch 6: one status vocabulary — P-013, the last S01 fix)

Batch 5 deployed (dep-daavadad0e5s73bnb9rg live, 81/81). This closes
BA-0017 and with it the whole actionable S01 queue. Doc-first: §8 of
PLAN-POS-OPERATIONS.md amended — the display ladder is the ONE status
vocabulary; raw lifecycle statuses never surface in the UI.

- The ladder (Draft → Pending → On PO → Reserved → Scheduled → Out for
  Delivery → Delivered + Quote/Layaway/Cancelled/Returned/Exchanged/
  Awaiting Return Pickup) is extracted to one deriveDisplayStatus()
  used by the list AND the detail endpoint — no second copy to drift.
- GET /v1/orders/:id now returns displayStatus (+ displayPoNumber);
  the order page badge shows it, so an order reads identically in the
  list and on its page. Shared DisplayStatusBadge in components/ui.
- The list filter speaks display words: /v1/orders/list-view takes
  display= (1:1 states narrow in SQL; derived states narrow to their
  possible lifecycle statuses and post-filter on the computed value —
  a page may under-fill while nextCursor keeps paging). Every filter
  option is a badge you can see; every badge is a filter you can pick.
- e2e updated to the new vocabulary (reserved/delivered).

S01 status: every S1/S2/S3/S4 finding is now fixed, by design
(BA-0019 D12 pricing, BA-0038 draft-cancel kept per owner), ops-owned
(owner setting list prices), or deferred to the S17 design pass
(visible labels above every field). BA-0032 (Vercel prefetch 503s) is
infra-level and monitored.

### Checkpoint — 2026-08-31 (owner ask: remove Get started from the dashboard)

The onboarding "Get started" checklist card is gone from the dashboard
for every user. The /v1/onboarding/checklist fetch stays — it still
powers the fresh-signup redirect to /welcome and the businessActive
gate — only the card and its component were removed.

### Checkpoint — 2026-08-31 (Operations role + dashboard, owner amendment A5)

New owner request, not a carried sprint item: a member who watches every
store's selling, every dollar in and out, and every hand-made change to
money or stock — and signs off on what they read. `PLAN-POS-OPERATIONS.md`
amended first (§0 A5 + new §12.1), doc-first as the protocol requires.

- **Role:** `Operations` added to the catalog — read-everything across
  sales, orders, inventory, cash, audit and the override register, plus
  the two new permissions `ops.dashboard.view` and `ops.review.clear`.
  Deliberately without the approval permissions, so the person who
  authorizes an exception is never the person who clears it. Sells
  occasionally: register and order-writing verbs, no commission.
- **Rollout to existing tenants:** `SystemRoleSyncService` previously only
  backfilled permissions onto roles that already existed, which would have
  left Operations invisible in every tenant created before today —
  including production. It now also creates a missing catalog role, and
  skips any business that already has a role of that name so a hand-built
  "Operations" is never shadowed.
- **Schema:** `ops_reviews` (`0081_ops_reviews`) — the sign-off ledger, one
  row per cleared subject, unique on (business, subjectType, subjectId),
  with RLS. Exception-register rows clear through the existing
  `exception_events.acknowledged_at` instead, so nothing is recorded twice.
- **API:** `apps/api/src/ops/` — `GET /v1/dashboard/operations` (summary:
  money in/out/net by tender, 14-day written business, by-store, open/close
  ritual, feed counts), `/feed`, `/digest`, `/salespeople`, `/activity`, and
  `POST /v1/ops-reviews/bulk`. Split rather than one call so a slow card
  never holds up the page and a 403 hides one card, not the dashboard.
- **Thresholds:** `ops_settings_json.opsReview`, tri-state — null means the
  documented default, zero is a real value ("show me every refund").
- **UI:** `/operations`, and `/dashboard` opens there for the Operations
  role. Feed first with bulk clear; money tiles, by-store and
  by-salesperson tables, flagged-activity-by-person, open/close, and store
  activity underneath.
- **Tests:** 21 unit (thresholds, ranking, digest), 18 integration (every
  signal class from real rows, thresholds honoured, sign-off idempotent and
  routed to the right table, permission boundary, role rollout), 1 e2e
  (write-down → feed → clear → still gone after reload). Migration applies
  clean from empty; drift check green.

**Owner decisions still open:** the six thresholds ship on the defaults above
— confirm or set them under Settings → Operations. Also worth a look: whether
transfers should stay at info severity on the feed (they have their own paper
trail and are high-volume) or be raised to warning.

### Checkpoint — 2026-08-31 (CR: delete draft purchase orders)

Change request from Jet, `deletedraftpos.md`. A draft PO had no exit —
the only way to retire one was to place it (recording a vendor
commitment that never existed) and cancel, or leave a $0.00 shell on the
list forever. `PLAN-POS-OPERATIONS.md` §6.1 written first, doc-first.

- **Schema:** `purchase_orders.deleted_at` + `deleted_by_user_id`
  (`0082_po_soft_delete`), plus the live-row index the default list
  reads. Soft, so the number stays spoken for — PO numbers come from a
  count of existing rows, so keeping the row is exactly what stops the
  next PO inheriting a deleted one's number.
- **API:** `DELETE /v1/purchase-orders/:id` and
  `POST /:id/restore`, gated on a new `purchase_orders.delete`
  permission; `?includeDeleted=1` on the list. The four refusals live in
  `po-delete-guard.ts` as a pure function so each message is unit-tested
  without a database.
- **Release:** linked special-order lines are un-sourced back onto the
  buying queue in the request's own RLS transaction. There is **no stock
  to release** — a draft PO holds none; stock moves only at
  receive/unreceive — so the CR's "release reserved/committed stock" step
  needed no code, and inventing a no-op would have implied otherwise.
  Restore deliberately does not re-claim those lines: they may have been
  sourced elsewhere meanwhile.
- **UI:** destructive "Delete draft" pushed to the far end of the PO
  header (never beside Place order); confirm dialog showing vendor, line
  count and subtotal, armed only once the number is typed; deleted banner
  with Restore on the detail page; "Show deleted" filter with greyed rows
  and Restore on the list. New **Change history** card on the PO page —
  it had none, sales orders already did.
- **Tests:** 11 unit (every refusal + restore guard), 12 integration
  (delete/hide/restore, number never reused, all four refusals with their
  exact messages, SO line returns to the queue, restore does not
  re-claim, permission boundary, audit entries), 2 e2e (delete → hidden →
  Show deleted → restore; button absent once placed). Migration applies
  clean from empty; drift check green.

**Ops, and the open decisions from the CR:**

- **The shared POS account.** `purchase_orders.delete` is manager-and-
  above by construction: Owner and Manager hold every business permission.
  If `pos.lamattress@gmail.com` is on Owner or Manager it CAN delete POs —
  move it to a narrower role or add a per-member override. Cashier and
  Inventory Clerk cannot, as the CR asked.
- **The four existing drafts** (PO-2026-000001/000002, the $0.00 Bedrock
  shells, plus two others) are production data — delete them from the UI
  once this ships.
- **Should the reorder panel stop creating drafts eagerly?** Not built.
  The CR names it as the root cause and it is the better fix: an unsaved
  staging screen would stop most of these drafts existing. Worth deciding
  before the shells come back.
- **Canceled POs hideable from the list?** Out of scope per the CR; the
  `includeDeleted` plumbing would extend to it cheaply if wanted.

### Checkpoint — 2026-08-31 (CR follow-up: the reorder panel stops creating drafts eagerly)

The root cause the CR named, and the better half of the fix: "Draft PO"
committed a numbered record on the first click, so the drafts existed
before anyone decided they should. Deleting them was the cure; not
creating them is the prevention. `PLAN-POS-OPERATIONS.md` §6.2 first.

- The reorder panel's button is now **Review & order**, a link to
  `/purchase-orders/new?vendorId=…&preload=reorder`. No POST — the eager
  `draftPo()` handler is gone.
- The builder at `/purchase-orders/new` was already a staging screen
  (lines in component state, one write on submit); it just needed to
  accept the preload and offer the draft exit. It now stages every
  suggestion for the vendor on arrival, once, and carries **Save as
  draft** alongside **Place order** — before this it could only place,
  which is why the draft path lived only in the eager button.
- A `beforeunload` guard protects a staged basket from a stray reload,
  matching the order writer's BA-0001 guard. Losing 40 staged lines and
  losing a half-written sale are the same mistake.
- **Tests:** 1 e2e that asserts the property that matters — the PO count
  stays at zero through opening the builder and walking away, and only
  becomes 1 when Save as draft is pressed. Existing PO-delete and order
  e2e re-run green.

No schema or API change: `place: false` was already supported by
`POST /v1/purchase-orders`; nothing on the server needed to move.

### Checkpoint — 2026-09-01 (pre-merge review pass over the branch)

Full-diff review before merging to main; ten findings, all fixed, each
with a test where one could hold it:

- **A deleted draft PO could still be placed** (or edited, or cancelled)
  — it keeps status `draft`, and the status checks were the only gate.
  Placing one would have minted a vendor commitment invisible in the
  list and unrestorable after. Deleted rows now accept exactly one verb:
  restore.
- **Store scoping was inconsistent on the ops surfaces**: write-offs,
  returns and exchanges skipped `salesScopeCond` on the feed and in the
  money block while their sibling signals applied it, so a store-scoped
  member saw (and had netted against them) other stores' money out.
  Every out-flow now carries the same scope as the in-flow.
- **A sign-off now has a time**: the feed hides a subject only while its
  review is newer than its `occurredAt`, so negative stock that recurs
  after being reviewed resurfaces instead of hiding behind a month-old
  sign-off — and re-clearing upserts the stamp so the recurrence can be
  cleared too.
- **Take-with exposure is the balance due**, computed from the payment
  ledger, not the order's face value (the money convention: derived
  money is computed, never stored).
- **The discountPct threshold now has a signal reading it** — a
  documents-discounted-past-threshold feed row; it was advertised in
  the settings registry with nothing behind it.
- **Refund-only associates get a row** in the salespeople table — the
  refund used to require prior written business to be counted at all.
- Drawer variances window on when the count happened, not when the
  shift opened; the summary no longer builds the whole feed just for a
  count (thresholds ride the /feed response); ritual() is three fixed
  queries instead of 3×stores.

### Checkpoint — 2026-09-01 (Warehouse role + dashboard, amendment A6)

Owner ask: rename Inventory Clerk to Warehouse and give it a home —
cards 1–9 of the proposed ten (bins health cut). `PLAN-POS-OPERATIONS.md`
amended first (§0 A6 + §12.2).

- **Rename, not replace:** `SystemRoleSyncService` gained a rename pass
  (`RENAMED_SYSTEM_ROLES`) that renames a tenant's system "Inventory
  Clerk" row in place — same id, memberships untouched — and skips any
  business that already has a role named Warehouse. Runs before the
  create pass, or create would mint the new name beside the old role.
- **Role:** same permissions plus `warehouse.dashboard.view`;
  `/dashboard` opens on the Warehouse home for the role (same
  role-name gate as Operations), `/warehouse` in the nav for anyone
  with the permission.
- **API:** `apps/api/src/warehouse/` — summary (inbound, dock, pickups,
  arrived-unscheduled, transfers, as-is, counts+negative), `/loadout`
  (today's truck vs the delivery cap, unpicked-serial flags) and
  `/picklist` (tomorrow per variant with bin + shortfall), all pinned
  to one location, warehouse-type first.
- **The queue that matters:** arrived-but-unscheduled — received
  `po_line_allocations` whose customer line is unfulfilled with no live
  delivery. It leads the page when non-empty.
- **Tests:** 15 integration (every card from real rows, the in-place
  rename with membership intact, the hand-built-Warehouse conflict
  skip, permission boundary, malformed-date refusal) + 1 e2e (overdue
  inbound PO reaches the page). All 306 tests in the eight suites that
  referenced the old role name re-run green.
- No schema change — the dashboard reads existing tables only.

### Checkpoint — 2026-09-01 (warehouse dashboard: combined all-locations default)

Owner follow-up on §12.2: the Warehouse home now **defaults to all
locations combined**, with the picker narrowing to any one.

- One scope model: every card query takes a list of location ids — all
  of them by default, one when picked — so both modes run identical SQL
  (`inArray` throughout). `locationId=all` is the sentinel and the
  default.
- Combined-view semantics decided honestly rather than averaged:
  each row names its building; transfers show "from → to" (direction is
  meaningless when both ends are in scope — `internal`); the truck's
  stop cap is per-location config, so the combined load-out reports
  stops without a cap instead of inventing one; the pick list stays
  grouped per variant PER building, because a bin only means something
  inside its own walls.
- Tests updated and extended: combined view includes the store-bound PO
  the single view excludes, cap null in combined vs 15 single, transfer
  direction relative vs internal. 15 integration + 1 e2e green.

### Checkpoint — 2026-09-01 (cashier "My Day" home + ZIP autofill)

Owner ask: the Cashier role gets its own dashboard (all ten suggested
cards), and customer address entry fills city/state from the ZIP.

- Amendment A7 / §12.3 in PLAN-POS-OPERATIONS. New permission
  `cashier.dashboard.view` on the Cashier role (backfilled by the boot
  sync); `/v1/business/members/me` reports `cashierDashboard`; the
  Cashier's `/dashboard` swaps to My Day and `/my-day` is the nav door
  for anyone else holding the permission. Login landing unchanged.
- `GET /v1/dashboard/my-day` (`apps/api/src/cashier`): one bundle, ten
  sections, store picker like the manager home. "Mine" is the
  membership (orders, split-attributed) or the user (register sales,
  shifts, returns, exchanges); drawer math mirrors the close ritual;
  balance due is ledger-derived; imported rows excluded.
- ZIP autofill: `GET /v1/geo/zip/:zip` (bundled US/CA table via
  `zipcodes`, `customers.view`, 400/404 honest), `apps/web/src/lib/zip-lookup.ts`
  with one never-overwrite rule shared by the New Sale customer, billing
  and ship-to blocks and the customer edit page.
- Tests: `apps/api/test/cashier.int.spec.ts` (18: role/permission,
  every card from real rows, the picker, the ZIP endpoint) and
  `apps/web/e2e/my-day.spec.ts`. CI gets `jetnine_cashier`.

### Checkpoint — 2026-09-01 (Helix mattress names)

Owner ask: shorten every Helix mattress to "<size> <mattress> <firmness>",
e.g. `Twin Helix Twilight 11.5" Firm Hybrid Mattress`.

- The names came from the Shopify sync as one product per Shopify
  variant, `"<title> — <size> / <cover> / <support>"`, all in
  `products.name`. Data migration `0083_helix_mattress_names` rewrites
  them in place (idempotent; non-mattress Helix items and already-short
  names untouched; SKUs, prices, stock and historical line descriptions
  unchanged; `search_tsv` is generated and follows).
- The Shopify connector applies the same rule (`helixMattressName`) so a
  re-sync never writes the long names back. Unit-tested.

### Checkpoint — 2026-09-01 (order notes)

Owner ask: a section on every order where all users can leave notes.

- Amendment A8. `order_notes` (0084): order, author membership, body,
  time; RLS like every tenant table.
- `GET/POST /v1/orders/:id/notes` gated on `orders.view` (every system
  role holds it), store-scoped members fenced by `salesScopeCond`;
  append-only; each add is an `order.note.add` audit entry so it shows
  in the order's change history.
- Notes card on the order page above Change history: textarea +
  Add note (Ctrl/⌘+Enter), newest first with "You" / author name and
  time. `apps/api/test/order-notes.int.spec.ts` (7). CI gets
  `jetnine_order_notes`.

### Checkpoint — 2026-09-01 (Add Product filters: vendor, size, firmness, in stock)

Owner ask on New Sale's Add Product popup.

- `/v1/pos/product-search` takes `size` and `firmness` (canonical lists
  `MATTRESS_SIZES` / `FIRMNESS_LEVELS`), returns both per row, and the
  vendor filter now also matches the product's brand or a name starting
  with the vendor's name — imported catalogs rarely carry a preferred
  vendor on the variant. Classification is a SQL CASE over attributes +
  product + variant names ("Twin XL" before "Twin", "Cal King" before
  "King", "Medium Firm" before "Medium"/"Firm").
- Dialog gains Size and Firmness selects beside Vendor and Stock.
- `apps/api/test/product-filters.int.spec.ts` (6). CI gets
  `jetnine_product_filters`.

### Checkpoint — 2026-09-02 (duplicate products)

Owner spotted the same Helix mattress two and three times in the Add
Product popup: two imports (a `helix-…` SKU family and a
`HELIX-SLEEP-…-<hash>` family) plus Shopify cover/support variants that
now share one name after A7's shortening.

- `GET /v1/products/duplicates` (`products.view`): active products
  grouped by name, each with min price, variants, on hand, reserved,
  document count and `deletable`.
- `/products/duplicates` page ("Find duplicates" on Products): per row
  Open / Deactivate (hides from selling, keeps history) / Delete (only
  when nothing references it — the existing guard).
- Covered in `product-filters.int.spec.ts` (+2).
- Owner decision: **use the one from the import.** Each duplicate row
  now shows its source (import batch: `storis` / CSV vs a connector sync
  `shopify` / `woocommerce` / `wix`, or built in the app), and
  `POST /v1/products/duplicates/keep-imported` (`products.update`,
  optional `names[]`) deactivates the non-import copies in every group
  that has an imported one — deactivate only, audit-logged, groups with
  no imported copy skipped. Page: "Keep imported copy" per group and
  "Keep imported copies everywhere".
- Owner 2026-09-02: Orders (`/orders/**`) and New Sale (`/pos`) render
  25% wider — the shell's content cap is 1500px on those routes, 1200px
  elsewhere — so a product line fits without a sideways scroll.

### Checkpoint — 2026-09-02 (As-Is review provenance)

Owner ask: the As-Is review must say where each mattress came from and
which invoice, with the invoice clickable.

- `/v1/as-is` (and `/aging`) rows carry `origin`, resolved in one query
  per reference type: register refund → the sale (invoice) + customer;
  order return → the RMA + the order + customer; consolidation transfer
  → the transfer + the store it left; receiving defect → the PO +
  vendor; manual intake → none.
- Page column "Came from": source, RMA, a link to the invoice / order /
  transfer / PO with its date, the customer (linked), and "from <store
  or vendor>". `apps/api/test/as-is-origin.int.spec.ts` (2). CI gets
  `jetnine_as_is`.

### Checkpoint — 2026-09-02 (Warehouse/Cashier could not open Inventory)

Owner report: a member could not see or adjust inventory. Production
request logs showed repeated 403s on `GET /v1/business/locations`, the
first call the Inventory page makes (also Receive, Counts, Returns,
Exchanges, Replenishment, the order page). That endpoint needs
`locations.view`, which only Owner/Manager/Operations held — so a
Warehouse member with `inventory.adjust` still hit "Missing required
permission: locations.view" before anything loaded.

- `locations.view` added to the Cashier, Warehouse and Bookkeeper
  system roles (read-only store list; create/update/delete unchanged).
  The boot sync backfills existing tenants' roles on deploy.

### Checkpoint — 2026-09-02 (vendor counts with doors)

Owner ask: each vendor row shows how many of their products we carry,
how many are in inventory, how many are on PO — and each number opens
the page filtered to that vendor.

- `common/vendor-match.ts`: the one rule for "this vendor's products"
  (preferred vendor, brand name, or the vendor's name as a whole word in
  the product name), shared by the Add Product popup, the products list
  (`?vendorId`), the inventory levels (`?vendorId`, any/all locations)
  and the vendor stats.
- `GET /v1/vendors` rows carry `stats` (products carried, in-stock
  products + units, on-PO units + open POs) from one SQL pass.
- Vendors page: three count columns linking to `/products?vendorId`,
  `/inventory?vendorId&locationId=all` (new "All locations" option) and
  `/purchase-orders?vendorId`; each destination shows a vendor chip with
  clear. `product-filters.int.spec.ts` +2.

### Checkpoint — 2026-09-02 (delete member)

Owner ask: the Owner needs a Delete button on Members.

- New permission `users.delete` (Owner only among system roles — the
  Manager exclusion list carries it beside `users.disable`).
- `DELETE /v1/business/members/:id`: a seat nothing refers to is
  deleted outright; one with history (orders written, deliveries driven,
  commission, notes, returns, register sales) is archived — status
  `removed`, store scopes dropped, locked out by the tenancy guard — so
  every document keeps its name. Never yourself, never the last active
  Owner. Both paths audit-logged; removed members leave the roster.
- Members list and member page: Delete (danger) for holders of the
  permission, never on their own row. `business.int.spec.ts` +3.

### Checkpoint — 2026-09-02 (order page overhaul)

Owner ask after the UI/UX audit: per-line release of reserved stock; Returns
and Exchanges as their own cards; a stock-status column; sticky balance
summary; a next-step banner; collapse cards that do not apply; skeleton +
parallel load; the split take-with order shown under Lines; and each line
on a PO shows the PO # — "on order" until received, then "accepted,
reserved".

- `GET /v1/orders/:id` now returns `lines[].po` (`poNumber`, `poStatus`,
  `ordered`, `received`, `expectedAt` from `po_line_allocations`),
  `exchangeOrders`, and `family[].lines` + `fulfillmentType` +
  `requestedDate` for split siblings. `order-detail-extras.int.spec.ts` (4).
- Order page: `NextStepBanner`, `BalanceStrip` (sticky, jumps to Payments),
  `StockCell` (badges + PO link + per-line Release), `SplitOrdersCard`
  under Lines, `ReturnsCard` / `ExchangesCard` split, `CollapsedCard` for
  Deliveries / Returns / Exchanges / Payment plan when they do not apply,
  `OrderSkeleton` while loading; locations fetch runs beside the order
  fetch. E2E `orders.spec.ts` (3) + sweep layaway pass unchanged.
- Declined by owner: per-line edit popover (3), timeline (9), keyboard
  shortcuts (10), customer history (11), print preview (12).

### Checkpoint — 2026-09-02 (orders list opens the order directly)

Owner ask: clicking an Order # on the Orders page must open the full
order page, not the side panel.

- Orders list: row click navigates to `/orders/:id`; the Order # cell is
  a real link (`order-number-link`) so middle-click / new tab work. The
  slide-over component and its detail fetch are removed. §8 amended.
- E2E `orders.spec.ts` updated (row click → full page). 3/3 pass locally.

### Checkpoint — 2026-09-02 (View Customer Activity)

Owner ask (nine STORIS screenshots): a View Customer Activity section with
General Information, Open Orders, Order Line Details, Historical
Purchases, Current Deposits, Historical Deposits, Open A/R Items and Open
Service Orders.

- `GET /v1/customers/:id/activity` (`customer-activity.controller.ts`):
  one derived payload for all eight views — yearly totals, open orders
  with display status + money split, per-order line details with PO
  linkage, purchase history across orders / register sales / returns,
  deposits current + historical, receivables (open installments,
  delivered balances), open service orders. `customer-activity.int.spec.ts`
  (8) wired into CI.
- Web: `/customers/:id/activity` (left nav, `?tab=` deep link, sticky
  header with code / phones / email / store credit), `/customers/activity`
  lookup screen, links from the customer record and the Customers list.
  PLAN §12.4 (A8).

### Checkpoint — 2026-09-02 (View Salesperson Activity)

Owner ask (three STORIS screenshots): the same activity screen for
salespeople — General, Open Orders, Completed Orders, Canceled Orders,
Layaways, Carts, Quotes, Leads.

- `GET /v1/salespeople/:membershipId/activity` (money module,
  `salesperson-activity.controller.ts`, `reports.sales.view`): open /
  completed / canceled / layaway / cart / quote rows with customer, type,
  fulfillment, display status, money split and salespeople count; general
  totals incl. written and delivered today / MTD (client sends its local
  `today`); leads = quote/cart customers without a real order.
  `salesperson-activity.int.spec.ts` wired into CI.
- Web: `/salespeople/:id/activity` (left nav, `?tab=`, date window on
  completed / canceled), `/salespeople/activity` lookup, "View activity"
  per row and a header button on Salespeople. PLAN §12.5 (A9).

### Checkpoint — 2026-09-02 (exception register links to the order)

Owner ask: an order-number column on the Exception register that opens
the order.

- `GET /v1/exceptions` rows carry `orderId` / `orderNumber`, resolved
  from the event's entity: orders directly, returns through their order,
  exchanges through the exchange order written. `controls.int.spec.ts`
  asserts it on the unlock event.
- Exceptions page: new **Order** column between Who and What, linking to
  `/orders/:id`.

### Checkpoint — 2026-09-02 (Operations: by-store orders with cost and profit)

Owner ask: under Selling → "By store — today", each store expands to the
actual orders with written amount, cost and profit.

- `GET /v1/dashboard/operations` `byStore[]` rows carry `costCents`,
  `profitCents` and `documents[]` (orders + register sales written today:
  number, customer, written, merchandise, cost, profit). Cost is the
  standard cost of the lines (variant cost × qty); profit is merchandise
  (subtotal − discounts) − cost — tax, delivery and fees excluded.
  `ops.int.spec.ts` checks the pieces add up to the row.
- Operations dashboard: store rows are collapsible; the sub-rows link to
  the order or sale. Store row gains Cost and Profit columns.

### Checkpoint — 2026-09-02 (signed-out UX + form kit)

Owner ask: login / signup / password reset / onboarding and data entry
need modern, friendly UI with properly wired notices and notifications.

- New form kit on react-hook-form + zod: `components/form/form.tsx`
  (fields with labels + inline errors, password show/hide + strength,
  pending submit, alerts). New signed-out shell + outcome panels
  (`components/auth/auth-shell.tsx`). `lib/auth-errors.ts` maps
  better-auth codes to plain sentences.
- Rebuilt: /login (unverified → Resend, 2FA + backup code, `?next=`),
  /signup ("Check your email" + Resend / Continue), /reset (both halves,
  expired-link path, confirm password), /verify (`?error=` aware),
  /accept-invite (confirm password, prefilled sign-in), /2fa (copy
  secret, outcome), /welcome (stepper, live slug, 409 inline). Old
  `AuthForm` removed.
- `auth.spec.ts` e2e (signup → verify → 2FA → reset → login) passes
  unchanged: labels, button names and `auth-success` / `auth-error`
  test ids preserved. PLAN §12.6 (A10).
- Next: move existing data-entry pages (customers, products, POs,
  settings) onto the kit as they are touched.

### Checkpoint — 2026-09-02 (POS favicon = LA Mattress logo)

Owner ask: give the POS a favicon using the LA Mattress logo.

- `app/icon.svg` + `app/apple-icon.png` + `public/icons/icon-192/512.png`:
  a bundled "LA" mattress mark (indigo) as the default tab / home-screen
  icon; `manifest.webmanifest` lists them so an installed POS has an icon.
- `DynamicFavicon` (mounted in the app shell): once branding loads, the
  favicon and apple-touch-icon point at `branding.logoUrl` — the LA
  Mattress logo the business already set under Settings → Branding. If
  no logo is set, the bundled mark stays. lamattress.com is not reachable
  from the build environment, so the real logo file is not bundled; the
  runtime swap uses the configured one.

### Checkpoint — 2026-09-02 (Shopify-style date range picker)

Owner ask: a dynamic time picker like Shopify everywhere relevant, to
check past data; one shared picker, with per-section instances where
one page needs individual windows.

- `lib/date-range.ts` (presets incl. rolling last-N units, quarters,
  all-time; URL round-trip, keyed; 5 unit tests) +
  `components/date-range-picker.tsx` (react-day-picker two-month
  calendar, preset rail, Cancel / Apply, compact mode).
- API `start` / `end` (`common/date-range.ts`) on ops summary +
  salespeople, exceptions digest, orders list / list-view, sales list;
  `ops.int.spec.ts` (22) and `orders.int.spec.ts` (101) cover it.
- Pages: Reports, Salespeople, salesperson activity, customer A/R,
  Audit, dashboard trend, Operations (page + salesperson card),
  Exceptions digest, Orders, Sales. E2E orders / operations / my-day
  pass. PLAN §12.7 (A11).

### Checkpoint — 2026-09-02 (Report Cash Drawer Balancing Totals)

Owner ask: the STORIS "Report Cash Drawer Balancing Totals" (parameter
screen + sample PDF) — "create this too".

- API `GET /v1/reports/cash-drawer-balancing` (balance date + start/end
  time in store tz, Balance By drawer/operator/store, store / operator /
  drawer filters, balanced/unbalanced drawer reference, CSV): group →
  pay class → payment type register with the STORIS columns, subtotals,
  grand total, Cash Drawer Reconciliation (cash + check = deposit) and
  drawer counts. `cash-drawer-balancing.int.spec.ts` (6 tests, new CI db
  `jetnine_cash_drawer`).
- Web `/reports/cash-drawer-balancing` with the STORIS parameter card,
  linked from Reports. PLAN §12.8 (A12).

### Checkpoint — 2026-09-02 (Report Written Sales Dollars)

Owner ask: the STORIS "Report Written Sales Dollars" (parameter screen +
sample PDF) — "We also need this built".

- API `GET /v1/reports/written-sales`: location → type (new transactions
  excl. layaway / layaway / register sales / ADJUSTMENT) → order → line
  with merch, gross profit, profit %, charges, customer discount, misc
  fee, sales tax, total order; totals at every level; Order Type both /
  orders / adjustments, Report Type detail / summary, include audit
  comments / all salespeople / customer address, multi-store filter, CSV;
  profit masked without `reports.financial.view`.
  `written-sales.int.spec.ts` (6 tests, new CI db `jetnine_written_sales`).
- Web `/reports/written-sales` with the STORIS parameter card, linked
  from Reports. PLAN §12.9 (A13).

### Checkpoint — 2026-09-02 (Advanced Vendor Settings)

Owner ask: STORIS Advanced Vendor Settings (General / Shipping / PO
Cutting Date / Auto PO Replen).

- Schema: `vendors.landed_cost_json`, new `vendor_po_cutting_dates`
  (RLS), migration 0085.
- API: `GET /v1/vendors/:id/advanced-settings`, `PATCH
/v1/vendors/:id/shipping`, `PUT /v1/vendors/:id/po-cutting-dates`;
  replenishment settings gain first/second average units period and sort
  criteria (grid + PO line order). Landed-cost lines default PO freight;
  cutting dates block PO create/place and drop replenishment lines.
  `vendor-settings.int.spec.ts` (6, CI db `jetnine_vendor_settings`).
- Web `/vendors/[id]/settings` with the four STORIS tabs; Vendors list
  links to it; replenishment page links to the Auto PO Replen tab.
  PLAN §12.10 (A14).

### Checkpoint — 2026-09-02 (design pass: layout contract on every screen)

Owner ask: a screen-by-screen design pass with proper heading placement
and margins.

- Layout contract (spacing scale + margin-owning primitives in
  `ui.tsx` / `globals.css`) and a workflow pass over 117 web files: page
  headers, section headings, stacks, toolbars, forms, stat tiles, table
  wraps, token classes. PLAN §12.11 (A15).
- Typecheck, lint, unit tests and the full Playwright suite pass (one
  spec updated for a renamed link).

### Checkpoint — 2026-09-03 (catalog replacement from STORIS Active Inventory)

Owner ask: replace the product catalog with the ACTIVE_INVENTORY export
(group, SKU, brand, category, replacement cost, vendor, description), load
stock / as-is / minimum stock per store, delete non-matching products,
keep order lines matched.

- Import pipeline: product spec + brand / group, inventory spec + as-is /
  min stock (new `inventory_levels.reorder_point`, migration 0086),
  tolerant store-name matching, commit `replaceCatalog` (delete vs
  deactivate by live FK scan). `import.int.spec.ts` 15 tests.
- Converter `docs/scripts/convert-active-inventory.py`; CSVs under
  `docs/imports/2026-09-03/`. PLAN §12.12 (A16).
- **Ops (owner)**: after deploy, Settings → Import: upload products.csv
  (entity product, tick Replace catalog, validate, commit), then
  inventory.csv (entity inventory). Validation lists any store name that
  did not match an ERP location.

### Checkpoint — 2026-09-04 (dashboard redesign hand-off: shell + role homes)

Owner hand-off from Claude Design (`LA Mattress ERP.dc.html`): implemented
the app shell and the four role homes; the module screens in the other
design files are follow-ups. PLAN §12.13 (A17).

- Tokens (Geist, gray + green accent, dark theme, density), shell
  (sidebar counts + sync footer, ⌘K palette, store scope / period /
  compare controls, notifications drawer, account menu, shortcuts, Owner
  role switch), owner home on new `GET /v1/dashboard/owner`,
  `/owner/orders`, `/nav-counts` (`owner-dashboard.int.spec.ts`, 7 tests,
  CI db `jetnine_owner_dashboard`), manager / operations / warehouse homes
  restyled on the shared kit with their test ids intact.
- Typecheck, lint, format and the reports suite pass; Playwright suite
  run against the new shell (operations spec updated for the new
  clear-selected confirmation).
- Geist / Geist Mono are self-hosted under `apps/web/public/fonts`
  (variable fonts, latin subsets) — no third-party stylesheet, works
  offline. Theme / density live per browser under the avatar menu.
- Open: the catalog-source lockdown plan (`docs/HANDOFF-catalog-source-lockdown.md`)
  and the staff schedule proposal await owner approval.

### Checkpoint — 2026-09-06 (trial expiry lockout: super-admin plan activation)

The LA Mattress business's 14-day trial lapsed on 2026-09-05; from 6:32 PM
Pacific every POS write from a non-super-admin session (Julio) returned
402 "Subscription required" from `SubscriptionGuard`. The Billing page
has no subscribe control (self-serve is paused) and the super-admin
status toggle only wrote `businesses.status`, while the guard reads the
`subscriptions` row first — so there was no working way to unblock.

- `PATCH /v1/admin/businesses/:id/subscription` `{ plan }` puts a
  business on Starter/Pro as `active` with `trial_ends_at`,
  `current_period_end` and `cancel_at_period_end` cleared — no end date —
  and mirrors `businesses.status/plan`. `GET …/subscription` returns the
  guard's view (`readOnly`). Audit action `business.subscription.activate`.
- `PATCH …/status` now mirrors onto `subscriptions.status`
  (active/trial/suspended→past_due/cancelled→canceled) so Suspend /
  Unsuspend on the admin list actually take effect.
- Super-admin business page gained a Subscription card (state, read-only
  warning, plan select, "Activate plan (no end date)").
- `admin.int.spec.ts` +5 tests (16 total): expired trial → 402 for the
  owner, activation → 201 again, invalid plan → 400, non-super-admin → 403.
- **Ops:** after deploy, open Admin → Businesses → LA Mattress and click
  Activate plan; Julio's POS resumes immediately, no re-login needed.

### Checkpoint — 2026-09-06 (PLAN §15: agency vs SaaS account model + owner console)

Owner decision: LA Mattress stores are the owner's own operation (an
**agency** account — never billed, never read-only); every other business
is a **SaaS** account on the trial → plan lifecycle. The super-admin console
becomes the place to manage those sub-accounts. Spec in `PLAN.md` §15.

- Schema: `businesses.account_kind` ('agency' | 'saas', default saas) and
  `subscription_payments` (platform-billing ledger, RLS) — migration
  `0087_account_kind_subscription_payments`.
- `SubscriptionGuard` passes agency accounts unconditionally;
  `GET /v1/billing/subscription` reports `accountKind` and `readOnly=false`
  for them.
- `/v1/admin/accounts`: list (kind filter, subscription state, `readOnly`,
  MRR, users, locations, last activity / payment), detail (subscription,
  resource usage, payments summary), `PATCH :id/kind`, `GET :id/members`,
  `GET|POST :id/payments` (a paid entry reactivates the subscription and
  stamps the covered period). `/v1/admin/metrics` adds account counts by
  kind, subscription state counts, MRR, trials ending within 7 days.
- Console: nav "Accounts"; list with kind filter + MRR; account page with
  Account kind (toggle), Resources, Subscription (activate plan), Users
  (impersonate), Payments (ledger + record form); metrics home tiles.
- `admin.int.spec.ts` +6 tests (22 total): list/detail/members, agency
  immune to a lapsed trial (and 409 on payments), SaaS payment reactivates,
  non-super-admin 403. `billing.int.spec.ts` still green (10).
- **Ops:** after deploy, open Admin → Accounts → LA Mattress and click
  **Mark as agency**. That alone lifts Julio's 402 permanently.
- Follow-ups (PLAN §15.4): Stripe Billing → ledger, plan limits, self-serve
  plan changes, resource quotas.

### Checkpoint — 2026-09-06 (Render auto-deploy from `main`)

Render's GitHub auto-deploy died with the repo rename (dashboard still points at
`AlwayzLegit/JetnineERP` @ `claude/fix-latent-int-spec-failures`), and the old
`deploy-api.yml` still targeted Fly.io and had failed on all 96 pushes to `main`.
Replaced it with a Render deploy workflow: on API-touching pushes to `main` it
repoints the service at this repo's `main` (via the Render API), starts a deploy,
and fails the run unless Render reports `live`. **Ops:** add the `RENDER_API_KEY`
repository secret; the first run after that fixes the dashboard drift for good.
Fallback `RENDER_DEPLOY_HOOK_URL` is supported but cannot repoint or await.
HANDOFF §2/§3 and README updated.

### Checkpoint — 2026-09-06 (set-account-kind CLI + production one-off job)

The API and DB hosts are unreachable from a Claude sandbox, so account-kind
changes had no path from a session. `packages/db/src/set-account-kind.ts`
mirrors the console's "Mark as agency" (businesses + subscriptions + audit row,
`--list` to see slugs). `ops-set-account-kind.yml` (manual dispatch with
validated `action` / `slug` / `kind` inputs — no free-form commands) runs it as
a Render one-off job inside the API service and prints the log. First use:
mark LA Mattress as an agency account. HANDOFF §2 updated.

### Checkpoint — 2026-09-06 (PLAN §15.5: Stripe Billing for SaaS accounts)

- `PlatformBillingService` (platform Stripe account; stub mode without
  `STRIPE_SECRET_KEY`; `configured` needs both per-location Price ids).
- `POST /v1/billing/checkout { plan }` → Checkout Session (quantity = locations),
  `POST /v1/billing/portal` → Customer Portal; agency accounts 409; inline
  `POST /v1/billing/subscribe` refuses once real Stripe Billing is live.
- `POST /v1/billing/stripe/webhook` (Public, raw body, `STRIPE_BILLING_WEBHOOK_SECRET`,
  idempotent via `stripe_webhook_events`): checkout completed, subscription
  created/updated/deleted, invoice paid/succeeded/failed → `subscriptions` +
  `businesses` mirror + one `subscription_payments` row per invoice
  (`method='stripe'`) + `billing.stripe.sync` audit rows. Agency accounts are
  never driven by Stripe state.
- `GET /v1/billing/subscription` gains `stripeBilling { configured, stubMode,
customerId, subscriptionId }`; tenant Billing page: plan picker + "Subscribe
  with Stripe", "Manage billing" (portal), checkout outcome banners.
- `billing.int.spec.ts` +8 (18 total): checkout/portal in stub mode, permission,
  full webhook lifecycle incl. redelivery dedupe and the agency guard.
- **Ops (before flipping a real SaaS tenant to Stripe):** in the Stripe
  dashboard create the product + two monthly per-location Prices; set
  `STRIPE_PRICE_STARTER_PER_LOCATION`, `STRIPE_PRICE_PRO_PER_LOCATION`,
  `STRIPE_BILLING_WEBHOOK_SECRET` on Render; register
  `https://jetnine-api.onrender.com/v1/billing/stripe/webhook` for
  `checkout.session.completed`, `customer.subscription.created|updated|deleted`,
  `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`.

### Checkpoint — 2026-09-06 (POS could not read the recycling fee: 403 for non-owners)

Owner set the recycling fee to $18.00 but every register still showed $10.50.
`GET /v1/business/settings` needs `business.settings.view` (Owner/Manager);
New Sale, the order page, the sale page and the currency/branding provider all
read it, got 403 for cashiers/salespeople, swallowed it, and kept the hard-coded
default. New `GET /v1/business/settings/pos` (any active member) returns the
register-facing subset — name, currency, tax, receipt header/footer, branding
and the non-sensitive ops keys (fee, invoice notes, delivery caps, returns,
price-variance) — and those four consumers now use it. `business.int.spec.ts`
+1: owner sets 1800 → cashier gets 403 on full settings, 200 + 1800 on `/pos`.

### Checkpoint — 2026-09-06 (Shopify listings cleanup — A18)

Owner ask: a plan to remove the Shopify-imported products (the ones with
lowercase letters in the name), find the sales rung on them, and a sheet of
proposed corrections to confirm. Built as a self-serve slice because the
production database is unreachable from a sandbox — the owner generates,
confirms and applies the sheet in the app (PLAN-POS-OPERATIONS §12.14).

- `apps/api/src/catalog/listing-match.ts`: size / firmness / model-word
  crosswalk between Shopify names and STORIS listings (unit-tested).
- `catalog-cleanup.controller.ts`: report, two CSV sheets, `apply` with dry
  run; relinks sale / order lines (reservation + optional stock move, audit),
  deactivates or deletes listings (full reference guard, legacy_refs
  removed). New permission `products.merge` (Owner + Manager).
- `/products/cleanup`: confirm on the page or upload the filled sheet →
  preview → apply. `apps/api/test/catalog-cleanup.int.spec.ts` (10). CI
  gets `jetnine_catalog_cleanup`.
- Owner decisions (same day): Shopify prices on shared STORIS SKUs are not
  kept — the page lists them and resets them to $0 (`resetPrices`); stock
  on Shopify listings is not kept — retiring a listing clears it
  (`listing_retire` movements) and stock never blocks a delete; the relink
  takes sold units off the STORIS SKU only.
- **Ops (owner):** open Products → Shopify cleanup, download the sales
  sheet, confirm rows (or confirm on the page), preview, apply; then retire
  the listings and reset the Shopify prices. Disconnect the Shopify integration (or leave "Sync now"
  alone) — the sync would recreate the listings; B1/B2 of the lockdown plan
  are still open.

### Checkpoint — 2026-09-06 (ERP workflow reliability — review branch)

Owner requested implementation after a live workflow review. First patch:

- Delivery-risk reporting excludes custom charges and direct shipments, keeps
  descriptions for unlinked stock items, and matches inbound supply against the
  line/order stock source while retaining selling-store access controls.
- Order next-step guidance handles returned orders, pickup, take-with and vendor
  shipment workflows. It no longer calls every fulfilled order delivered or
  claims stock/payment readiness from a scheduled delivery alone.
- Nightly jobs expose disabled, blocked and partial results with action links
  and expandable details. Legacy GL successes with unresolved groups can resume;
  already-derived groups count as completed. Failed scheduled reports require
  individual runs so archived reports are not repeated.
- Deleted PO drafts no longer suppress automatic replenishment.
- Verification: 287 API tests (all source unit suites plus purchasing/reporting
  integration suites), 25 web tests, API/web typechecks and production builds,
  API lint and web build lint. Existing lint warnings remain. Integration tests
  used isolated PostgreSQL 16 and Node 22; the two test launchers now invoke Node
  directly so Windows does not require executing a pnpm shell script.
- No schema migration or live data changes. Full CI and deployment are pending
  review. Remaining work is recorded in `docs/erp-workflow-reliability.md`,
  including explicit fee-item classification and shared member tasks/updates.

### Checkpoint — 2026-09-06 (shared order tasks and personal inbox — review branch)

- Added Team Tasks in the navigation and on every order: named owners, local-time
  deadlines, priority, descriptions and Open / In progress / Blocked / Done status.
  Queues expose personal, team, overdue, blocked, unassigned and completed work.
- Order notes can notify named members. Open-task owners and creators receive
  related notes and order/delivery changes; actors do not receive their own alerts.
  The personal inbox stores read state per membership across devices. The existing
  owner order-change feed remains a separate view.
- Nightly overdue reminders deduplicate by task deadline and recipient. Repeated
  saves without changes do not notify again; version checks reject stale edits.
- Migration `0088_team_workflows` adds tasks, notifications and note recipients.
  Both new tenant tables have RLS; API reads additionally enforce order/store
  access and assignments check active membership and effective permissions.
- Validation: 399 backend tests across 22 suites, API/web typechecks, API lint,
  API/web production builds and migration generation without drift. Browser QA on
  isolated data covers task creation, native deadline entry, blocked/completed
  queues and inbox read persistence. Added a full two-member browser regression
  for CI. Full CI remains the publication gate.
- PR #145's earlier reliability fixes are now merged (`6cd3983`) and deployed.
  This new collaboration slice is for review and is not deployed. Deployment must
  apply the API migration before the new web features are considered available.
  Explicit fee classification and readiness/customer-message automation remain
  subsequent slices; no live data or external messages changed during this work.

### Checkpoint — 2026-09-07 (untaxed services: "Power base installation needs to be non taxed")

Owner screenshot: New Sale taxing POWER BASE INSTALLATION. The written
order already honours the product's tax class (a 0% class → the line
carries `tax_rate_bps 0`), but the register preview taxed every product
line at the store rate and the Add Product search never said what a
product's own rate was.

- `/v1/pos/product-search` rows gain `taxRateBps`: the tax-class override
  for the selling store, else the class fallback, else null (store rate).
- New Sale keeps `taxRateBps` per line (from the search row; a reopened
  draft takes the written line's rate, refreshed by the availability
  re-check), and its tax preview mirrors `sales/totals.ts`: per-line rate
  on net less the line's pro-rata share of the order discount. The Tax
  row says how many lines are untaxed.
- `product-filters.int.spec.ts` +1 (0% class, store override, no class).
- **Ops (owner):** Settings → Tax classes → add "Non-taxable" at 0.00%,
  then on each service product (Power base installation, …) set Tax
  class to it. Nothing else to configure.
