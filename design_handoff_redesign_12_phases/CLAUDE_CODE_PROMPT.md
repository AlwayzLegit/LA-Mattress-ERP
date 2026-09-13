# Claude Code prompt — implement the LA Mattress ERP redesign in 12 phases

Paste this into Claude Code from the repo root (`AlwayzLegit/LA-Mattress-ERP`). Work on a branch per phase (`redesign/01-tokens` …). Each phase ends with a PR that builds, passes lint/tests, and includes a short `PHASE_NOTES.md` diff entry listing what changed and any open question you had to assume. Do not start a phase until the previous PR is merged or explicitly approved.

The design references live in `design_handoff_redesign_12_phases/`. `README.md` there is the spec; the `.dc.html` files are HTML prototypes to **recreate**, not to ship. Open `Redesign Index.dc.html` in a browser first. Match the spec's hex values, type sizes, densities and copy exactly; use the app's existing components (`apps/web/src/components/ui`) and data hooks, extending them rather than forking.

Ground rules for every phase
- Light mode only. Desktop 1440 primary, 1280 must not wrap or hide.
- No colour carries state alone — glyph + word + colour on every status.
- Every row is a real link; every dialog is `role=dialog aria-modal` with focus trap, Esc, and focus return; every input has a visible label or `aria-label`; focus ring never removed.
- No bare "Loading…": skeleton with a 4s budget, then the error component with Retry.
- Motion only for state changes, 120–280ms, zero under `prefers-reduced-motion`.
- Copy is from the salesperson's side of the counter. Never system vocabulary.
- If a locked decision in the README conflicts with a better idea, keep the decision and note the idea in `PHASE_NOTES.md` under "Later".

---

## Phase 1 — Tokens and fonts
Add Public Sans, Archivo, JetBrains Mono (self-host or next/font). Replace the CSS variables in `globals.css` with the README §1 ramp (`--bg #f6f5f2`, `--surface`, `--surface-2`, `--border`, `--border-strong`, `--text`, `--text-2`, `--muted`, `--faint`, `--accent #1e3a5f`, `--accent-soft`, `--accent-ink`) and the six status triplets. Radius 3/5/0. Two density presets (management 36/13/30, register 44/14/38) as data attributes. Global focus ring. Remove purple, gradients, 9px radii. Ship a `/dev/tokens` page that renders the token sheet from `Redesign 2 System.dc.html` (2d).

## Phase 2 — Component kit
Rebuild `components/ui` to the 2e artboard: Button (primary/secondary/ghost/destructive, optional `<Kbd>`), Field (label, hint, error), Table primitives (row-as-link pattern, sortable header button with `aria-sort`, sticky head), StatusChip (six statuses), Dialog and SlideOver (shared focus-trap hook), Toast, EmptyState, Skeleton (with the 4s → Error handoff), ErrorState (title, sentence, Retry, optional countdown), Kbd (platform-aware). Storybook or a `/dev/components` page showing every state. Delete unused legacy variants.

## Phase 3 — Shell, navigation, store context, palette, global states
`app-shell.tsx`: five collapsible groups from README §2, role-trimming via the existing `hiddenNav`/roles, counts in mono. Topbar order: Acting-for chip (accent-soft; drives selling store, drawer and reports; audited on change), role switcher (owner only), search trigger with platform `Kbd`, inbox, New sale (N), account. Move period controls out of the shell into dashboard/reports. Command palette per README §2 (`g o / g d / g p` chords). Global loading (skeleton, elapsed seconds) and global error (auto-retry countdown, manual Retry, red sync dot, names the draft). Verify at 1440 and 1280.

## Phase 4 — New Sale: layout, lines, sourcing
`/pos`: grid `minmax(0,1fr) 316px`; fixed-layout items table with the README §3.1 widths; rail sections Customer / Order details / Totals. Implement the sourcing rules from `HANDOFF_inventory_source_defaults` (location_kind + default_source_location_id migration, resolution order, `sourceTouched`, auto badge, take-with warning copy, reservations on `line.source_location_id`). Line add-ons: Removal $0, Recycling $18, Declined foundation $0 as toggles on mattress/base lines; Recycling flows into the line amount and totals. $0 price guard. Status chip in the title computed from lines. Drafts list, store-wide. Keys F2 / F8 / Esc / P / N. Error/loading via shell components.

## Phase 5 — New Sale: Add Product dialog and payments
Add Product as a true Dialog (README §3.1): search all-words-any-order, Vendor/Size/Firmness, accent-filled **From** select defaulting per resolution order, In stock first, columns incl. `At {From}` / All stores / ATP with `<abbr>` definition, footer "Showing N of 1,948" + sourcing sentence, `↵` adds first row. Payments panel in the rail: Method, Amount, card last-4, Pay in full / 50% deposit, Record repeatedly to $0, Done; Complete locks the sale, reserves per line source, prints. Completed and $0 states per the canvas (4e, 4f).

## Phase 6 — Orders list and slide-over
`/orders` per README §3.2: filter toolbar with store default = signed-in store and removable filter chips, sortable columns with `aria-sort`, order anchor per row, StatusChip, reserved bar + fraction, sticky header, footer. `/orders/[id]` becomes a 640px SlideOver over the list (URL-addressable): lock banner when a delivery ticket has printed (Unlock permission: owner + store manager, audited), action row with destructive Cancel alone at the right, summary, lines, payments, change-history timeline. Cancel is an `alertdialog` whose sentence states deposit destination, stock return and board removal; Reason required; Keep order is default focus.

## Phase 7 — Products browser, product page, adjust, receive
`/products` per README §3.3: keep drag-to-reorder + click-to-sort (persist order in localStorage), add the six per-location available columns + company total, stock filter (anywhere / short / out), colour semantics in the footer, full STORIS column set, `min-width` table with horizontal scroll. `/products/[id]`: "Where it is" grid first (on hand, reserved, floor, available, on PO, ATP, min, next promise), then activity tabs with counts. Adjust-stock dialog with now→change→after, guards and coded reasons. `/products/receive` per spec with damaged → As-Is and "orders unblocked". Cost column hidden without `reports.financial`.

## Phase 8 — Deliveries board and day sheet
`/deliveries` per README §3.4: Week | Month modes with matching controls; `n / 15` + bar on every day; card with grab handle, status chip, due amount; empty-day target; return-pickup cards; drag with ghost, target preview and 120ms settle; keyboard reschedule (M); over-cap allowed with red state, required note, and banner; month roll-up. `/deliveries/day/[date]` print CSS to the day-sheet spec (letter, 14pt, tick boxes, signature, COD total). Keep `/deliveries/search` and `/deliveries/confirm`, restyled.

## Phase 9 — Dashboards: owner and manager, cash pickups
`dashboard/owner-home.tsx` and `manager-dashboard.tsx` per README §3.5 with **every shipped card kept**: headline with both baselines, side tiles, small-figures row, store cards (salespeople, money by method + payment list dialog, cash on hand), Written business, Morning brief, Changes (severity filter), Staff schedule. Build the **cash pickups** model: `cash_pickups` table (id, store, by, at, counted_cents, expected_cents, slip, variance_cents) and `cash_pickup_items` (payment_id, pickup_id); status rule (> $1,500 or > 3 days = due); Record → Post flow stamping payments and flagging variance to exceptions; owner/ops cross-store queue; manager may record own store. Time-clock strip on Manager (uses `/v1/timeclock`).

## Phase 10 — Dashboards: operations, warehouse, Z-report
`operations-dashboard.tsx` and `warehouse-dashboard.tsx` per §3.5 (cards as listed, cash-pickups queue on Ops, no store cards/cash on Warehouse, Print tickets on the pick list). New `/shifts/close/[date]` Z-report screen: six tiles with same-weekday baseline, tenders (refund line), cash drawers with inline exception (Request recount / Record with reason), "What the 10pm close did", refunds & cancellations, Sign off (records name/time; exception stays open). Editable schedule + Publish for Owner/Ops; read-only elsewhere.

## Phase 11 — Sales competitions
Per README §3.6. Data: `leads` table (id, salesperson_membership_id, store_id, name, phone_normalised, wanted_size, wanted_category, note, status open|converted|lost, converted_order_id, created_at) with auto-conversion job on order completion (phone match, same salesperson, ≤ 30 days) and manual attach (audited). `competition_settings` (per card on/off, races, prize_people, prize_store; month, payout_day, return_window_days, banner_days, visibility). Metrics endpoint computing the six races for People and Stores from completed, non-returned orders with tie-break by net; sweep tiers 4→$1,000, 5→$1,500, 6→$2,000 replacing per-card $100s. UI: strip on every role home (collapsed state persisted), cards, pinned own row with gap text, pace line, days-left states, leaderboard dialog with sparkline/orders/History, lead form (strip + New Sale "Log as lead instead"), lead list, conversion moment, winner banner (3 days) + printable sheet, overtaken inbox notices (max 1/card/day), TV mode route `/tv/competition` (1920×1080, 6s cycle), owner settings page.

## Phase 12 — Accessibility pass, states, polish, cleanup
Walk `Redesign 9 Handoff.dc.html`: verify focus order on New Sale and Orders (9a/9b), every dialog's trap/return, `aria-sort` on every sortable header, labels on every control, contrast of every fg/bg pair (9c), every screen's loading/empty/error copy from the state matrix, reduced-motion behaviour. Remove dead legacy kit, old dashboard components, Inventory routes (now under Products), and any remaining `⌘K` hard-codes. Update `PHASE_NOTES.md` with the consolidated "Later" list and the answers to README §5 open questions. Final visual diff of every screen against its canvas at 1440 and 1280.
