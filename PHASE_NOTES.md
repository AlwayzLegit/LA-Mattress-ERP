# PHASE_NOTES — dashboard & register redesign

Running log for the 12-phase redesign in `design_handoff_redesign_12_phases/`
(`README.md` there is the spec, `CLAUDE_CODE_PROMPT.md` the phase plan). One entry per
phase: what changed, what was assumed, and a **Later** list for ideas that lost to a
locked decision. The consolidated Later list and the answers to README §5 land in the
Phase 12 entry.

---

## Phase 1 — Tokens and fonts (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** `apps/web` only, no schema, no API.

### What changed

- **Fonts.** Public Sans (400–600), Archivo (500–700) and JetBrains Mono (400–500) are
  self-hosted variable woff2 files under `apps/web/public/fonts/` (latin + latin-ext,
  Google Fonts v21 / v25 / v24 slices), declared with `@font-face` in `globals.css`. Geist
  and Geist Mono are removed. Self-hosting rather than `next/font` keeps the existing
  pattern (no third-party stylesheet, register still has its type when the store is
  offline). Body is Public Sans 13px / 1.5; `h1`–`h4` are Archivo with tabular figures;
  `--font-mono` is JetBrains Mono. Type-scale classes `t-display-xl`, `t-display-l`,
  `t-heading`, `t-title`, `t-body`, `t-body-register`, `t-label`, `t-mono`, `t-mono-sm`
  mirror canvas 2d.
- **Colour.** `:root` now carries the README §1 ramp verbatim (`--bg #f6f5f2`,
  `--surface`, `--surface-2`, `--border`, `--border-strong`, `--text`, `--text-2`,
  `--muted`, `--faint`, `--accent #1e3a5f`, `--accent-soft`, `--accent-ink`) and the six
  status triplets as `--status-{draft|waiting|scheduled|fulfilled|cancelled|risk}-{fg|bg|border}`.
  `--destructive` aliases the risk red for the outlined destructive tier. Every legacy name
  (`--brand`, `--danger`, `--warn`, `--info`, `--success`, `--surface2`, `--text2`,
  `--border2`, `--neutral-soft`, …) is an alias onto the new ramp so the ~1,000 existing
  call sites pick it up unchanged. The Tailwind `@theme` block maps both the new names
  (`bg-surface-2`, `text-text-2`, `text-muted`, `border-border-strong`, `bg-accent-soft`,
  `text-status-risk`, `font-display`) and the legacy utilities still in the tree.
  The green oklch accent, the dark theme block and every hard-coded Tailwind hex in
  `globals.css` (alerts, password-strength bar, sonner override, auth radial gradients)
  are gone; those now read status tokens.
- **Radius.** `--radius-chip 3`, `--radius-input 3`, `--radius-control 3`,
  `--radius-button 5`, `--radius-card 5`, `--radius-sheet 0`; legacy `--radius` → 5 and
  `--radius-sm` → 3. Every `border-radius` in `globals.css` reads one of these (tables,
  table wraps and header corners are now square; pills/badges/kbd/count chips are 3;
  buttons, menus, dialogs, panels, KPI strips and the auth card are 5). Only bars (2px
  meters) and true circles (dots, avatars) keep literal values. No 9px remains.
- **Density.** Two presets as data attributes: `:root` / `[data-density="management"]`
  (row 36 · text 13 · control 30) and `[data-density="register"]` (row 44 · text 14 ·
  control 38 · hit target 44), exposed as `--row-h`, `--text-size`, `--control-h`,
  `--hit-target`; the legacy `--rowy` / `--pad` / `--kpi` derive from the preset. The
  register opts in on its root in Phase 4.
- **Focus.** Global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`
  with no radius; the four `outline: none` rules in `globals.css` and the two inline ones
  (command palette input, global search input) are removed. Inputs show the accent border
  on focus and `--border-strong` on hover instead of a box-shadow halo.
- **Motion.** `--motion 120ms ease-out`, `--motion-slide 160ms`. Under
  `prefers-reduced-motion: reduce` every animation and transition is 0 and the skeleton
  shimmer becomes a static two-tone bar.
- **Light mode only.** The per-user theme (light/dark) and density (cozy/compact)
  preferences are removed: `lib/ui-prefs.ts`, the root-layout bootstrap script, the
  Theme / Density segment in the account menu, and the `T` shortcut (and its row in the
  shortcuts dialog). Stored `jetnine.theme` / `jetnine.density` localStorage keys are
  simply ignored.
- **Primary and destructive buttons** now match the tier rule: primary is accent-filled
  (was ink-on-paper), destructive is outlined risk red on white (was grey-bordered).
  Active filter pills are accent-filled.
- **`/dev/tokens`** renders artboard 2d from the live CSS variables: type scale, neutral
  ramp, accent, destructive tier, six status chips with contrast ratios, spacing / radius /
  density / focus / motion, both density presets on a real row + control, and the skeleton.
  `apps/web/src/lib/design-tokens.ts` holds the same literals for code that has to name a
  token (Phase 2 StatusChip, print documents).
- The hand-off folder is checked in at `design_handoff_redesign_12_phases/` (excluded from
  prettier). The `.dc.html` files are references, not shipped routes.

### Assumptions

- "Self-host or next/font": self-hosted, for the offline register.
- Public Sans latin + latin-ext only (as Geist was); Vietnamese / Cyrillic / Greek slices
  are not bundled.
- The user-level density preference is retired in favour of the two surface presets;
  nothing in the spec keeps a per-user compact mode.
- `/dev/tokens` is a plain public route with `robots: noindex` — it has no data and no
  shell. Gate it behind an env flag if the owner prefers.

### Later

- Licensed grotesk (Söhne or similar) replacing Public Sans if the owner buys one (canvas
  2a note); the scale would not change.
- Once Phase 12 deletes the legacy aliases, the `@theme` block shrinks to the new names.
- Tailwind `rounded-*` utilities with off-scale radii still exist in ~13 TSX files (dashboard
  cards, team tasks, agency page); they are restyled with their screens in Phases 3–10.

---

## Phase 2 — Component kit (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` (restarted from `main` after the Phase 1 squash) ·
**Scope:** `apps/web` only. Every existing import of `@/components/ui` keeps working; the
single `ui.tsx` is now a `components/ui/` directory.

### What changed

- **Button** — four tiers to canvas 2e: primary (accent fill, 600), secondary (hairline),
  ghost (accent text), destructive (outlined risk red, 600, never filled). Height follows
  the density preset (`--control-h`), radius 5. `kbd="F8"` / `kbd="mod+k"` appends a
  shortcut chip. `variant="danger"` still works as the old name for destructive. `Button`,
  `Input` and `Select` forward refs so dialogs can name their initial focus.
- **Kbd** — platform-aware shortcut chip: `mod` renders ⌘ on a Mac and `Ctrl` on the
  Windows registers (`usePlatform`, `formatKeys`; server renders the Windows form and the
  client corrects after hydration). Chords (`g o`) keep their space; ⌘K does not.
- **Field** — label always visible, 12px / 500 / text-2; an error turns the label red and
  shows the message; hint is muted. `.input-mono` and `.input-num` for phone numbers, SKUs
  and money (mono, tabular, right-aligned).
- **Table** — `RowLink` (anchor in the first cell with an `::after` overlay so the whole
  row is clickable while the anchor takes focus; other controls in the row sit above it
  via `.row-action`) and `SortHeader` (`<th aria-sort>` around a button that inherits the
  header type; the indicator is drawn from `aria-sort`). Rows are `--row-h` tall with a
  `surface-2` hairline, hover `bg`, selected `accent-soft`; headers are 11px / 600 /
  uppercase / .05em.
- **StatusChip** — the six statuses from `design-tokens.ts`, glyph + word + colour with a
  1px border of the tint; Cancelled is struck. `StatusBadge` / `DisplayStatusBadge` keep
  their APIs and vocabularies but render the same anatomy: `.badge` now carries a glyph
  from its tone class (○ neutral · ◔ warning · ◷ info · ✓ success · ▲ danger · ◑ brand)
  and cancelled / refunded strings are struck on the neutral tint. The word is still the
  only text, so existing e2e text matchers hold.
- **Dialog** / **SlideOver** on a shared `useFocusTrap`: `role=dialog` (or `alertdialog`)
  with `aria-modal` and `aria-labelledby`, focus moves in on open (to `initialFocus`, else
  the first control), Tab and Shift+Tab cycle, Esc closes, focus returns to the opener.
  Dialog sizes 420 / 560 / 880 / 1080; title is Archivo 16px, description wired to
  `aria-describedby`. SlideOver is 640px from the right, 160ms, mono title option for
  document numbers. `ModalDialog` (3 callers) and `ConfirmDialog` (3 callers) are rebuilt on
  it — ConfirmDialog is now an `alertdialog` whose safe button has default focus and whose
  destructive action is outlined.
- **Toast** — sonner stays the API; the Toaster now runs 2.4s with hover-pause, and the
  CSS renders a white sheet with a hairline and a left rule in the status colour (no more
  `richColors`).
- **EmptyState** — dashed border, title, one action, no fill.
- **Skeleton → ErrorState** — `LoadingRows` keeps its 93 call sites unchanged and gains the
  4-second budget: past it the rows become `ErrorState` ("{what} is taking longer than it
  should", "Nothing you typed is lost…", Retry). `useLoadBudget` exposes the timer;
  `ErrorState` takes a title, a sentence, `onRetry`, and an optional `retryIn` countdown
  that auto-retries at zero.
- **Bare "Loading…" removed** where it was a state rather than a busy button label: the
  auth gate (now a shell-shaped skeleton with an `sr-only` status), the business switcher,
  four order read-dialogs, the attachments dialog, the warehouse home subtitle, and the two
  print documents.
- **`/dev/components`** shows every part in every state, including the register-density
  block, the dialog / alertdialog / slide-over, the four toast tones, and the live
  skeleton → error handoff with a Restart control.
- **Deleted legacy kit:** `.input-lg`, `.input-adorned`, `.modal-backdrop`, `.modal-panel`,
  `.modal-panel-lg`, `.subnav*` (no consumers). `vitest.config.ts` gained the `@/` alias so
  component tests resolve the kit.

### Assumptions

- Storybook is not added; `/dev/components` is the living gallery (the prompt allowed
  either).
- `LoadingRows` without `onRetry` still hands off to the error component at 4s (with the
  copy but no button) rather than shimmering forever; call sites gain a Retry as their
  screens are rebuilt in Phases 3–10.
- The legacy `.badge` tone → glyph mapping is mine (the spec defines glyphs only for the six
  order statuses); `brand` uses ◑ for "partly" states.

### Later

- The 13 remaining hand-rolled `role="dialog"` implementations (command palette, product
  search, notifications drawer, payment list, shift editor, order quick view, …) move onto
  `Dialog` / `SlideOver` with their screens (Phases 3, 5, 6, 9).
- `SortHeader` replaces the local `SortTh` in Orders and the header buttons in Products in
  Phases 6 and 7.

---

## Phase 3 — Shell, navigation, store context, palette, global states (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** `apps/web` shell plus one small audited
API endpoint. No schema change.

### What changed

- **Sidebar** (`components/shell/sidebar.tsx`, `nav.ts`) — brand block, Dashboard, then the
  five collapsible groups from README §2 with the exact items: Sell (New sale, Orders,
  Customers, Deliveries, At risk, My day) · After sale (Returns, Exchanges, Service, Special
  orders) · Stock (Products, Purchasing, Transfers, As-Is review, Gift cards) · Money (Sales,
  Shifts, Reports, Commissions, General ledger) · People & setup (Salespeople, Team tasks,
  Members & roles, Time clock, Settings). Only the current group is open; the group holding
  the current page opens on navigation and a manual choice is remembered per user in
  localStorage. Cashiers get the eight-link default (Sell / Stock / Money with "My drawer" /
  Me) and the owner's per-member `hiddenNav` still applies on top. Counts for Orders,
  Deliveries, At risk (nav-counts) and Team tasks (unread inbox) sit at the right in mono
  11px. 220px, 200px at ≤1280 via a media query on `--sidebar-width`. Footer: sync status
  (green "Synced · 9:41 AM", amber "Connecting…", red "Offline · retrying") and the
  shortcuts link with a `?` chip. The 15 pages that left the sidebar (Categories, Vendors,
  Roles, Locations, Audit log, …) remain in the palette's Go to list (`MORE_PAGES`).
- **Topbar** — order per README §2: **Acting for {Store}** chip (accent-soft, first control)
  → role switcher (owner only; a preview tool that lands on `/dashboard`) → search trigger
  with platform `Kbd` (⌘K / Ctrl K) → inbox with badge → New sale (primary, `N` chip) →
  account. The period picker, compare-to segment and store-scope dropdown left the shell:
  `DashboardControls` renders them at the top of every role home except My Day.
- **Store context** (`lib/acting-store.tsx`) — one provider for the store every sale, drawer
  and report belongs to. Selling-restricted members choose among their approved stores (a
  first-login picker when there is more than one, on `Dialog`); everyone else can switch
  among all locations, stores first. The choice persists under the existing
  `jetnine.sellingStore` session key so the register, the Orders list and the manager home
  follow it unchanged, and a `erp:acting-store` window event fires for screens that want to
  react live. Every switch calls `POST /v1/business/members/me/acting-store`, which validates
  the location (and the selling scope) and writes `membership.acting_store` to the audit log.
- **Command palette** — one input, groups Orders (orders + receipts) / Customers / Go to;
  first column is the mono identifier (order number, phone, chord); the search API already
  matches phone digits; footer `↑↓ ↵ esc` plus the `g o / g d / g p` chords. Built on the
  shared focus trap (`role=dialog`, Esc, focus return). `g p` now goes to Products; the older
  `g c / g r / g h / g i` chords still work and the shortcuts dialog lists them.
- **Global error** (`lib/api-status.ts`, `shell/shell-error.tsx`) — `api()` reports every
  network failure and 502/503/504; the shell then turns the sync dot red and renders the
  canvas-3d error above the page: names the draft (`setDraftSummary`, for the register in
  Phase 4) or the number of queued offline sales, says nothing is lost, auto-retries `/ready`
  with backoff (2s → 30s) and a visible "retrying in Ns · attempt N", and offers Retry now /
  Keep writing offline. Any successful call clears it.
- **Global loading** — the auth gate already renders a shell-shaped skeleton (Phase 2);
  `SyncStatus` shows "Connecting…" until the membership answers, and `/dev/shell` shows the
  canvas-3e layout (skeleton rows in final positions, elapsed seconds in the header).
- **Inbox drawers** (`personal-inbox.tsx`, `notifications-drawer.tsx`) moved onto `SlideOver`
  (focus trap, Esc, focus return) and the inbox's bare "Loading your inbox…" became skeleton
  rows with Retry. The legacy `.drawer` class is deleted.
- **`/dev/shell`** renders the frame with the real sidebar, topbar classes and error
  component on mock data, with Owner / Cashier and normal / loading / error toggles, so the
  chrome can be checked at 1440 and 1280 without a session.
- The theme-toggle shortcut row and the topbar business badge stayed where Phase 1 left them
  (the badge is the multi-business switcher; it now sits last, after the account).

### Assumptions

- "Team tasks" count = unread items in the member's inbox (tasks and notes for them); the
  nav-counts endpoint has no tasks figure and I did not widen it.
- Non-restricted members default to the first store alphabetically (warehouse last) when
  nothing is saved for the session; a manager writing for another store switches the chip.
- The dashboard keeps its own store-scope dropdown (now in the page, not the shell) until
  Phase 9 decides how the owner home relates to "Acting for". Removing it would leave the
  owner home unable to show the company.
- `/dev/shell` is a static preview; the live shell cannot render without a session in this
  environment, so 1440 / 1280 verification was done against the preview.

### Later

- Below 1280 the sidebar would collapse to icons (canvas 3b note); no register runs that
  narrow, so the existing mobile slide-over stays.
- The register publishes its draft summary to `setDraftSummary` in Phase 4 so the error
  names "SO-10441 (2 lines, $2,598.00)".
- Fold the business switcher into the account menu.

---

## Phase 4 — New Sale: layout, lines, sourcing (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** the register (`components/new-sale.tsx`,
rewritten), a pure sourcing module, one ops setting, and server-side source resolution on
order create. No schema migration: the durable location designation the handoff asked for
already exists as `locations.location_type` (`store` | `warehouse`), and the business default
lives in the ops settings registry like every other operational knob.

### What changed

- **Layout** (README §3.1, canvas 4a–4f) — content grid `minmax(0,1fr) 316px`, register
  density on the root. Header: eyebrow "Sell · {Store}", title, order number once a draft
  exists, computed status chip (Draft · Waiting on stock · Scheduled), save note, "Resume a
  draft (N)" toggling a store-wide list. Items section spans the content width with a
  `table-layout: fixed` table and the spec widths (Item auto · Qty 62 · Price 100 · Disc 80 ·
  Fulfillment 148 · Inventory from 172 · Amount 104). Rail: Customer · Order details (Store,
  Fulfillment, Promised, Salesperson in a 2×2 grid; type, second salesperson, fees, discount,
  instructions and notes behind "More") · Totals (Merchandise, Discounts, Delivery, Tax,
  **Total** in Archivo 26px, payments as negative lines, Due band that turns green when paid)
  · one action block.
- **Line row (44px)** — name + SKU/size/remove link; add-on chips **Removal $0 · Recycling
  · Declined foundation $0** on mattress and base lines (Recycling flows into the line amount
  and totals; on submit the toggles become the custom fee lines the invoice already prints);
  qty/price/disc as mono, right-aligned inputs; `$0` price → amber border + row tint;
  Fulfillment select with "Same as order · {order fulfillment}" first; Inventory from select
  with the **auto** badge while derived; availability note under it; one inline warning per
  line.
- **Sourcing** (`lib/pos-sourcing.ts`, 11 unit tests covering the handoff's matrix rows 1–9)
  — Add Product's From and untouched lines default to the business default source, else the
  single warehouse, else the store; a line whose effective fulfillment is take-with follows
  the order's Store; untouched lines recompute on line fulfillment, order fulfillment, order
  Store and product added; a touched line is never moved (inline note instead); take-with
  with too little stock shows "Take-with: N available at {Store}. Change the source location
  or the fulfillment type." Availability is fetched per (source, variant) pair and cached, so
  moving a line re-checks stock at the new source.
- **Server side** — `ops.defaultSourceLocationId` (registry entry, validated against the
  business's locations, visible to the register through `/settings/pos`, editable under
  Settings → Store operations as "Default stock source for new sale lines"). Order create
  applies the configured default to lines that name no source (take-with lines stay on the
  order's store; without a configured default a bare line keeps reserving at the order's
  stock location, which the order page, exchanges and auto transfers depend on — the
  implicit single-warehouse step stays client-side), and the `order.create`
  audit row carries `takeWithOffStore` when a take-with line is sourced from another store
  (allowed, on the record). Reservations already use `line.source_location_id`.
- **Guards and states** — `$0.00 is intentional` checkbox blocks Record and Complete until
  ticked; Complete says "Complete sale" / "Complete with balance" with the hint naming what
  is collected at the door; completion locks every control, flips the chip to Scheduled,
  states in one sentence what was reserved where and what is due, and offers Print receipt
  (P), Open order, New sale (N). Loading uses skeleton rows; the load error names what
  failed with a Retry.
- **Keys** — F2 Add product, F8 focuses the payment amount, Esc closes the picker (Dialog),
  P prints and N clears once complete. The register publishes its draft summary to the
  shell's outage banner (`setDraftSummary`).
- **Store context** — the order's Store defaults to the topbar's "Acting for" store and
  follows a switch while the ticket is empty.
- **`/dev/register`** — the register on the prototype's fixtures behind a fetch stub, for
  checking the screen without a session.
- Salesperson pickers now drop members without a display name (handoff §6).

### Assumptions

- Recycling add-on price = the business `recyclingFeeCents` setting (the canvas shows $18;
  the tenant default is $10.50). The chip label prints the live amount.
- Add-on chips show on lines whose description reads as a mattress or base (keyword match);
  the catalog has no explicit "needs recycling" flag.
- "Inventory from" lists every location; take-with follows the order's Store per the
  product-owner decision in the handoff.
- Payments stay a compact rail block (Method, Amount, reference, Pay in full / 50% deposit,
  Record); the F8 slide-in panel and the rebuilt Add Product dialog are Phase 5.

### Later

- Remember an explicit picker "From" for the rest of the draft (done: `pickerFrom` persists
  until the order fulfillment changes) — call out in the PR per the handoff.
- Mattress/base detection from the product's category instead of the name once the picker
  returns it (Phase 5).

## Phase 5 — New Sale: Add Product dialog and payments (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** the picker (`components/product-search-dialog.tsx`,
rewritten on the kit `Dialog`), the payments panel in the register rail, one read-only
endpoint for the footer count. No schema change.

### What changed

- **Add Product dialog** (README §3.1, canvas 4c) — a true dialog: `role=dialog`,
  `aria-modal`, focus trap, Esc closes, focus returns to the Add product button; 1080px
  and `min(800px, 90vh)` tall so the toolbar and footer stay put while the list scrolls.
  Title "Add product" with the one-line explanation beside it. Toolbar: Search (every word,
  any order — the API already matches this way across name, variant, SKU, size, firmness
  and brand), Vendor, Size, Firmness, **From** (accent-filled select, defaulting per the
  Phase 4 resolution order, labelled "From {Location} — warehouse / — this store"), and
  "In stock first" (client sort of the fetched page). Columns: Product with vendor · model
  under it, SKU (mono), Size, Firmness, Price, **At {From}** in green when > 0 and red at 0
  with the header in accent, All stores, ATP behind `<abbr title="Available to promise: on
hand minus reserved, plus units on open purchase orders">`, Add. ↑/↓ move the highlight,
  Enter from the search box adds the highlighted (first) row, a click anywhere on the row
  adds too. Empty: "Nothing matches “…”. Try fewer words, or clear the vendor, size and
  firmness filters." Footer: "Showing N of 1,948 products" (the total comes from
  `GET /v1/pos/catalog-count`, active variants of active products), "Added lines source
  from **{From}** {why}" where _why_ is "(your choice for this draft)", "because the order is
  take-with", "— the default; take-with lines switch to the store", and `↵ adds the first
row · esc closes`.
- **Payments** (canvas 4d) — the action block is now **Take payment** (44px, accent, `F8`
  badge; disabled with no lines, a $0 block, or nothing left to collect) over Complete /
  Save draft and the hint. Take payment or F8 swaps the button for the "Take a payment"
  panel (accent border): Method, Amount (mono, right-aligned, Enter records), **Card last 4**
  for card only (a reference field for the other non-cash tenders, nothing for cash), Pay
  in full / 50% deposit, **Record $X** (the button names the amount), Done. Record repeats
  to $0: after a partial the cursor returns to Amount; once the balance reaches $0 the
  panel closes on its own. Payments remain negative lines under Total with `remove`; the
  Due band turns green at $0.
- **Complete** — unchanged semantics (locks everything, reserves per line source, chip →
  Scheduled, green sentence, Print receipt P, New sale N); now the secondary 36px button
  beside Save draft as on the canvas, since Take payment is the primary.
- e2e: the register flows click `take-payment` before filling the tender.
- `/dev/register` stubs the catalog count (1,948) so the footer reads as on the canvas.

### Assumptions

- While the panel is open, Complete and Save draft stay visible under it (the prototype
  hides them until Done). One click fewer to complete after a deposit; Done is still there.
- "In stock first" sorts the fetched page (100 rows) client-side rather than adding a sort
  parameter to the search endpoint; the endpoint still orders by relevance.
- The vendor filter lists the first 100 vendors from `/v1/vendors`.
- ATP shows the all-stores available count when there is stock, else an approximate date
  from the earliest open PO (`~Sep 20`) — the endpoint does not yet return an on-order
  quantity.

### Later

- ATP as a number (on hand − reserved + on open POs) once the search endpoint returns
  open-PO units per variant.
- Server-side "in stock first" ordering and paging past 100 rows.
- Mattress/base detection from the category for the add-on chips (carried from Phase 4).

## Phase 6 — Orders book and order slide-over (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** `/orders` rebuilt as the book
(`components/orders/orders-book.tsx`), `/orders/[id]` as a 640px slide-over over it
(`components/orders/order-sheet.tsx`, `cancel-order-dialog.tsx`), the existing full order
workspace moved to `/orders/[id]/full`, and the list endpoint extended. No schema change.

### What changed

- **Routes** — `app/(business)/orders/(book)/layout.tsx` mounts the book once; `/orders` renders
  nothing inside it and `/orders/[id]` renders the sheet, so the URL names the order and the
  list never remounts behind it (filters, scroll and highlight survive open/close). The 3,300-line
  order page with its line editor, payment plans, returns, exchanges, notes and tasks is
  unchanged at **`/orders/[id]/full`**; the sheet's _Edit lines_ and _More ▾ → Open full order
  page_ lead there. Every existing link to `/orders/{id}` (dashboard, customer activity,
  deliveries, New Sale's _Open order_) now lands on the quick answer first.
- **Book** (README §3.2, canvas 5a) — toolbar Store (default = the signed-in "Acting for"
  store; "— your store" marked in the list), Status (the display ladder plus _Past due_),
  Written (7 / 30 / 90 / all, default 30), Salesperson, Find (number, customer or phone),
  Balance due only, Clear filters; active filters as removable chips under the toolbar. Title
  line "N of M · $X balance due" from the server summary. Columns Order (anchor, mono, a ◷ when
  locked) · Customer + phone · Store · Status chip · Reserved (6px bar + `done/total`, green full
  / amber partial / red none) · Promised · Salesperson · Total · Balance (bold when > 0,
  "Credit $x" in red, — when cancelled). Every header is a button with `aria-sort`; sticky
  header; footer "{count} orders · sorted by … · {Store} is your store, so it is the default
  filter" and the key hints. ↑↓ move the highlight (also from the Find box), ↵ opens, Esc
  closes the sheet. Empty: "No orders match. Widen the date range or clear a filter."
- **Status chips** — the server's owner-facing vocabulary (P-013) stays the word; the six
  Phase 2 tones carry the state (`chipFor`, unit-tested): Draft/Quote → draft, Pending / On PO /
  Layaway / Awaiting return pickup → waiting, Reserved / Scheduled / Out for delivery →
  scheduled, Delivered / Returned / Exchanged → fulfilled, Cancelled → cancelled, and an
  undelivered order whose promised date has passed → **risk "Past due"**.
- **Slide-over** (canvas 5b/5c) — title = number in mono + chip + "{customer} · {store} ·
  written 2d ago by {rep}". **Lock banner** (accent-soft) "Locked — delivery ticket printed
  {when}. Lines, prices and addresses cannot change. Unlock (owner and store manager only;
  written to history)" — Unlock opens the existing security-override dialog (`orders.unlock`
  or an authorising login, typed reason, audited); a separate red banner when the order is on
  an open delivery run. Action row: **Take payment** (primary; opens an inline panel — Method,
  Amount, Card last 4 / Reference, Pay in full, Record $X, Done; closes itself at $0), Edit
  lines (disabled when locked), Schedule / Reschedule delivery (inline date, over-capacity
  confirm), Print, More ▾ (Open full order page, Invoice this order only, Delivery ticket,
  Pick list, Share status link), **Cancel order** alone at the right in the destructive tier.
  3-col summary Customer / Fulfillment / Money (total in Archivo 22px, balance line amber or
  green); Lines (item, fulfillment · from, reserved fraction coloured, amount); Payments
  (method ••last4 · kind · when); Change history as a timeline from the order's audit rows,
  dot colour by kind (payment green, lock/schedule blue, short amber, cancel grey, written
  navy), actor on every entry.
- **Cancel** (canvas 5d) — `role=alertdialog` "Cancel {number}?" whose sentence names the
  deposit destination ("The $500.00 already paid becomes store credit for {customer}" / "is
  refunded to the original tender" / "Nothing has been paid."), the reserved lines returning to
  stock at their source, the delivery leaving the board, and that it is written to history.
  Reason select **required**; Deposit select (store credit default / refund) when money was
  taken; **Keep order** is the default focus.
- **Server** — `GET /v1/orders/list-view` now returns `customerPhone`, `locationId`/`locationName`,
  `salespersonMembershipId`, `lockedAt`, `creditDueCents` per row plus `summary { count,
balanceDueCents }` for the whole filtered set; accepts `salespersonMembershipId` and
  `balanceDue=1`; sorts `store`, `status`, `salesperson`, `total`, `reserved`, `written`.
  `POST /v1/orders/:id/cancel` takes `depositTo: 'store_credit' | 'original'` — with money on
  the order it books negative adjustment rows against each tender (and issues store credit for
  the store-credit choice) instead of refusing, cancels the order's scheduled/loaded
  deliveries, and the `order.cancel` audit row carries `depositCents`, `depositTo`,
  `deliveriesCancelled`. Without `depositTo` a paid order still refuses, as before.
- e2e: the flows that edit an order (`orders.spec`, `sweep.spec`, `team-workflows.spec`) step
  through `openFullOrder()` / `/orders/{id}/full`; the list test now expects the sheet.

### Assumptions

- The redesign supersedes the 2026-09-02 "no slide-over — one click lands on the order"
  decision; the full page is one more click away (Edit lines / More ▾), never gone.
- "Past due" is a chip state and a Status option (the existing `view=past_due` saved view),
  not a new stored status.
- The summary count follows the SQL filters; for display states the server narrows in JS
  (Pending / On PO / Reserved / Scheduled / Out for delivery) the count is the wider
  open-order set.
- Reschedule from the sheet moves the live trip in place (`PATCH /v1/deliveries/:id`); with no
  live trip it books one. Cancel refuses while a stop is out for delivery.

### Later

- Per-store order prefix (GL-10437) — kept `SO-` per the owner; the Store column carries it.
- Server-side "reserved" sort counts units, not lines; the bar shows units too.
- A first-class order history endpoint with actor names (the timeline shows the audit e-mail).

## Phase 7 — Products browser, product page, adjust, receive (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** `/products` rebuilt, `/products/[id]` led by
"Where it is", a new Adjust stock dialog, `/products/receive` rebuilt around the PO, and the
list / stock / receiving endpoints extended. No schema change.

### What changed

- **Browser** (README §3.3, canvas 6a) — one row per SKU, **one column per store**: the
  active locations (warehouse first) become ordinary draggable columns right after
  Description, showing _available_ (on hand − reserved − floor) with the tone rules stated in
  the footer — red = 0 with open demand (units on open order lines waiting there), amber =
  below the store's own minimum (`inventory_levels.reorder_point`), grey = a plain zero. Then
  On hand · company, Net on PO, Available · ATP, Sales margin cost (only when the role gets
  cost back), As-Is on hand / available, Price, Status, As-Is non-sellable, Product group,
  Brand, Size, Firmness, Primary collection. Toolbar: Search, Category (nested), Size,
  **Stock** (any / in stock anywhere / short somewhere / out everywhere), Show inactive,
  Advanced search disclosure (Vendor model, Brand, Collection, Product group, Purchase status,
  As-Is reason, Price from/to, Cost from/to), Reset columns only when the order differs.
  Drag-to-reorder + click-to-sort with `aria-sort` kept; order persisted in
  `localStorage['jetnine.products.columns']` (store columns included, keyed by location id).
  Table `min-width: 2600px` scrolling inside the sheet. Header actions Receive · Count ·
  Transfer · Print labels · + Create product. The per-row Delete is gone (canvas 6a — delete
  lives on the product page).
- **Product page** (canvas 6b) — identity header (breadcrumb, name, SKU, Active chip,
  vendor · model · category · size · firmness · price) with **Adjust stock · Transfer · Print
  label · Edit product** (Edit opens the existing General tab), Deactivate / Delete as ghost
  actions. **"Where it is"** first: one row per location with On hand, Reserved, Floor,
  Available (toned), On PO, ATP, **Min**, **Next promise** (Today / `Sep 15 · PO-4471` /
  `Transfer from Warehouse · 2 days` / `Special order · ~3 weeks` / Discontinued / Order from
  vendor) and a per-row Adjust; company totals in the section header. The STORIS activity
  views follow as a horizontal tab strip **with counts** (open orders, POs, transfers in/out,
  As-Is, serials fetched once); every existing panel and test id is unchanged, the old
  18-column Location availability card is the "Availability detail" tab.
- **Adjust stock** (canvas 6c, `components/adjust-stock-dialog.tsx`) — Location, **coded
  Reason** (`reason-codes?usageClass=inventory_adjustment`, the server's adjustment type read
  off the code), the **On hand now → Change → After** strip, Note (required for count
  corrections over 2 units). Guards: After < 0 disables and names the largest allowed change;
  After < reserved shows the red "reassign the reservation first" and disables; posts
  `POST /v1/inventory/adjust` (audited). "More stock actions…" opens the existing wide dialog
  (bins, As-Is, write-off, serials) for the same location.
- **Receive** (canvas 6d) — PO select (open + partly received, due/overdue in the label),
  Into, Packing slip #, Blind count (defaults from the PO's `blindReceiving`); lines with
  Ordered · Already in · **Received now** · **Damaged** · Bin · Still open and the waiting
  sales orders from `linkedOrders`; the rail totals Units received, Damaged → As-Is (reason
  DMG/MFG/PKG + note, required when damaged > 0), Still open on PO, **Orders unblocked**
  (estimated from the linked orders before posting, exact from the server after). Post →
  `POST /v1/purchase-orders/:id/receiving` with received = inspected = now + damaged,
  accepted = now, rejected = damaged (rejected units already become As-Is pieces server-side);
  chosen bins are assigned after. Over-receiving is refused in the rail; short lines stay open.
  **Receive without PO** is the secondary mode and requires a reason (posts the existing
  `POST /v1/inventory/receive` with the reason in the notes).
- **Server** — `GET /v1/products`: rows gain `reserved` and `stockByLocation`
  (`{ onHand, reserved, floorSample, available, min, demand }` per location id); new params
  `stock=anywhere|short|out` (SQL, so every browse mode pages correctly), `priceMin/Max`,
  `costMin/Max` (cents; cost needs `products.cost.view`), and `sort=available:<locationId>`.
  `GET /v1/products/:id` location rows carry `reorderPoint`. `POST /v1/purchase-orders/:id/receive`
  and `/receiving` return `unblockedOrders: [{ orderId, number, units }]` from the pending
  allocation the receipt triggered.
- `/dev/products`, `/dev/products/p1`, `/dev/products/receive` preview the four screens on
  fixtures.

### Assumptions

- "Open demand" for the red tone = units on open, unlocked order lines sourced at that
  location still waiting for stock; the product page uses reserved > 0 at zero available.
- Next promise reads PO expected dates from the product's PO activity by receiving location;
  transfer lead time is a fixed "2 days" and special-order "~3 weeks" until lead times are
  modelled.
- The cost column's visibility follows whether the API returned a cost on the loaded rows
  (the server already nulls it without `products.cost.view`).
- The quick Adjust acts on the product's primary variant (the one carrying the product SKU);
  other variants adjust from the Availability detail rows as before.
- Damage reasons on receipt are fixed codes in the receipt note; the server's `rejected`
  path already creates the As-Is pieces and the `po_reject` exception.

### Later

- A sticky first column past 1440 and a Cost column for financial roles by permission
  rather than by returned data.
- Modelled transfer / special-order lead times behind Next promise.
- A dedicated `/v1/reason-codes` class for receiving damage.

## Phase 8 — Deliveries board and day sheet (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** `/deliveries` rebuilt as the Week | Month board,
`/deliveries/day/[date]` rebuilt as the print day sheet, over-capacity enforcement on reschedule.
`/deliveries/search`, `/deliveries/confirm`, `/deliveries/dispatch` and the delivery page are
unchanged. No schema change.

### What changed

- **Board** (README §3.4, canvas 7a–7d) — header `Deliveries · Mon Sep 8 – Sun Sep 14`, then
  controls that match the view: **Week | Month** segmented, ‹ Today ›, a divider, Confirm calls,
  Dispatch, Print day sheet (and Search). Week: 7 Monday-first columns; every day header carries
  **`n / cap`** in mono and a 4px bar — green under, amber at cap − 2 … cap, red over (the day
  also takes a red border). Cards are real links (`delivery-card`, click → `/deliveries/[id]`)
  with a ⋮⋮ grab handle, order number · window, customer · city, status chip (Scheduled /
  Loaded / Out for delivery / Delivered / Failed; return pickups get the Waiting tint and read
  **Pickup** with the RMA), and `$1,240.17 due` in amber. Empty day = dashed "No stops ·
  Schedule here" linking to the orders waiting for a date. Month: the same grid for 35 days,
  fraction + bar, a status roll-up per day and **Due at door**, no cards.
- **Drag** — Scheduled and Loaded cards drag by the handle: the origin goes dashed at 45%, the
  target column gets a navy dashed outline and previews **"Drop here · 8 → 9 / 15"**, drop
  settles in 120ms (none under reduced motion), a toast offers **Undo**. **Keyboard**: focus a
  card, press **M**, pick a day from a 14-day menu that shows each day's fraction. The audit
  log gets the `delivery.update` row with the date change as before.
- **Over cap** — allowed, never silent. A move onto a full day comes back `409 OVER_CAPACITY`;
  the board asks for a one-line note ("Move anyway" stays disabled until it is written), the
  day turns red, the note sits under that day's cards, and a banner at the top names each
  over-cap day with its note ("Move a stop or confirm the note before printing the day sheet").
- **Day sheet** (canvas 7e) — an 816px paper on screen, letter in print: header `{business} ·
{truck}` / `Day sheet — Friday, September 12` / stops · pieces / driver / printed; meta strip
  with Route, **COD to collect** (sum of what is owed on live delivery stops), the dispatch
  instruction; the day's over-cap notes; per stop the number at 26pt, order · customer · phone,
  address, **one tick box per piece**, notes in italics, window, "Collect at door" with the
  amount bold when owed (or "Paid in full" / "Return pickup"), a signature line; the failed-stop
  instruction is a fixed footer so it prints on every page. `@page { size: letter }`, 14pt,
  black on white, no chrome. "All tickets (no lock)" is kept beside Print.
- **Server** — `PATCH /v1/deliveries/:id` now runs the same soft-cap check as scheduling when
  the date changes (stops, and pieces / capacity units when ops sets budgets): `409
OVER_CAPACITY` with the dimensions, or, with `confirmOverCapacity: true`, a **required
  `overCapacityNote`** that is appended to the stop's notes as `Over cap {date}: {note} — {who}`
  (that line is what the board and the day sheet read), plus the `delivery.cap_override` audit
  row and the `delivery_cap_override` exception the create path already writes.
- Day sheet review follow-ups: stops print **grouped by run** (one strip per truck with its
  driver, route, departed state, stops · pieces · COD; stops on no run come last as "Not on a
  truck yet"), so a second truck's stops never sit under the first driver's header. Tick boxes
  and the pieces count use the line's physical pieces (`quantity × pieces per unit`, now on
  every delivery line as `pieces`). COD is counted once per order. The driver's name rides on
  the run (`driverName`) so a Warehouse or Cashier login with `deliveries.view` sees it without
  `users.view`. The board reads `?view` / `?d` through `useSearchParams` under Suspense so the
  server and first client render agree.
- The day header's `n / cap` counts every stop that used or will use the truck (delivered and
  failed included, cancelled excluded); the capacity endpoint's live-only figure is a floor.
  The board asks the list endpoint for `limit=2000` so a 35-day month is never truncated
  (the endpoint now takes `limit`, capped at 2000, default 500).
- `/dev/deliveries` (`?view=month`) and `/dev/deliveries/day/{today}` preview the board and the
  sheet; fixtures are anchored on today (4 dispatched today, 16 over cap tomorrow with a note,
  the pickup and a near-cap day after that, an empty day, a full day) so the interesting days
  are always ahead of the viewer whatever the weekday.

### Assumptions

- The cap is the business's `ops.deliveryDailyCap` (default 15), business-wide — per-truck or
  per-store caps are still an open question in the handoff (README §5).
- The over-cap note lives on the moved stop's notes (no new column); a stop moved twice keeps
  both lines. Booking a _new_ delivery over the cap from an order still uses the existing
  confirm without a note.
- "Waiting on stock" / "At risk" cards need the order's reservation state on the delivery row;
  until the list carries it, cards show the delivery's own status.
- Month view is a rolling five weeks from the anchor week, as the shipped calendar was.
- Depart time and helper are not modelled; the sheet shows the run's route, truck and driver
  when a run exists for the day.

### Later

- Reservation state on `GET /v1/deliveries` rows so Waiting / At risk chips appear on the board.
- Per-store or per-truck capacity once decided.
- Restyle `/deliveries/search` and `/deliveries/confirm` onto the kit headers.

## Phase 9 — Dashboards: owner and manager, cash pickups (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** the owner home and the manager home rebuilt
per README §3.5 / canvas 8 with every shipped card kept, and the cash pickups model built:
`cash_pickups` + `cash_pickup_items` (migration `0100_phase9_cash_pickups`), the queue and the
Record → Post flow. Operations, Warehouse and the Z-report are Phase 10.

### What changed

- **Owner home** (`dashboard/owner/owner-home.tsx`, `.dh-*`) — one headline, **Company written
  today** at 56px with **vs same day last week** (same weekday) and **vs same day last month**
  (same calendar day, clamped) beside it; side tiles **Month to date** (vs the same days last
  month) and **Open exceptions** (with the critical count, "from the 10pm close"); six small
  figures each with a baseline — Collected (vs last week), Balance due (open orders), Refunds
  (± vs last week), Cancellations (± vs last week), Avg ticket, Deliveries today (/ cap). Then
  the **Cash pickups** queue, the **Stores** cards, Written business and the Morning brief side
  by side, **Changes** with a severity filter (All · Critical · Warning · Unseen), and the
  editable **Staff schedule** with Publish. Customize (reorder / hide per browser) and Print
  stay; the layout key moved to `jetnine.dashboard.layout.v2` so old layouts do not hide the
  new cards.
- **Store card** (`shared/store-card.tsx`, `.sc-*`) — header: store, manager · n salespeople,
  **Written · Delivered · Received · Refunds**, Show/Hide detail. Body: **Salespeople** (Name,
  Written, Orders, Avg, Collected, Last sale) · **Money received · by method** (swatch, count,
  amount; a row opens the payment list dialog) · **Cash on hand** (below).
- **Cash pickups** (`shared/cash-pickups.tsx`, `.cq-*` / `.coh-*`) — per store: cash on hand
  since the last pickup with a chip **Collected / Holding / Pickup due / No cash**; due when the
  store holds more than $1,500 or any cash payment is older than 3 days. One tick row per
  waiting payment (order · customer · date · "in drawer" / "4d old"), **Record pickup** (·
  N ticked) and **Tick all**; the recording form shows "Picking up $X from N payments · by
  {actor}", **Counted** (pre-filled with the expected total), **Slip #**, the variance line
  ("▲ Variance −$84.50 — will be flagged to the 10pm exceptions with your name"), **Post
  pickup** / Cancel. Posting refreshes the store, clears the ticks and toasts
  `PU-0091 · $3,973.60 picked up from Glendale by Alex Rivera · variance −$84.50 flagged`.
  Owner and Operations get the **cross-store queue** above the stores (Store, Cash on hand,
  Payments, Oldest, Last pickup, Status; due rows first and tinted; "Record pickup" opens the
  card, starts the form and scrolls to it); the Manager records inside their own store card.
- **Server** — `GET /v1/dashboard/cash-pickups/queue` (per store: status, pending cents /
  count, oldest age, the last pickup, the waiting payments, `canRecord`), `POST
/v1/dashboard/cash-pickups` (`locationId`, optional `paymentIds` — none = all, `countedCents`,
  `slip`, `note`) and `GET …/history`. Posting inserts the pickup with the next `PU-nnnn` for
  the business, one item per payment, and a `cash_pickup_receipts` stamp per payment (so the
  older per-payment tick agrees), writes the `cash_pickup.post` audit row, fires
  `cash_pickup.posted`, and records a `cash_pickup_variance` exception (warning; critical from
  $50) when counted ≠ expected. New permission **`pos.cash.pickup_record`**: Owner and
  Operations everywhere, **Manager for the stores their membership is scoped to** (the same
  "store manager" rule the cards use); `pos.cash.pickup_confirm` stays as it was.
- **Owner API** — `/v1/dashboard/owner` gains `today` (written, tickets, avg, same-day-last-week
  and same-day-last-month baselines, collected, balance due, refunds incl. negative payment
  rows, cancellations by `cancelled_at`, deliveries vs cap), `monthToDate` (vs the same days
  last month) and `exceptions` (open / critical).
- **Manager home** (`manager-dashboard.tsx`) — the time-clock strip, "Acting for {store}"
  header with the store picker and New Sale, the **store headline** with both baselines and
  "n tickets · 3 by Arman · avg", side tiles **Needs a call today** (past-due promises + orders
  short on stock → the at-risk queue) and **Last night's close** (the last closed drawer:
  Clean / Short / Over / Suspended, variance, who), **My store**, then the kept board, open
  sales queue, **Incoming stock · Drawer & tenders · Store activity** (3-up), Deliveries /
  Backorders / Aging carts / Returns, **My call-backs · My deliveries · My wins · My follow-up
  money**, and the read-only schedule last. `/v1/dashboard/manager` gains `headline`,
  `needsCall` and `lastClose`.
- `/dev/dashboard` (owner) and `/dev/dashboard/manager` preview both homes on the canvas's
  five stores, with a postable cash-pickup stub.

### Assumptions

- **Cash on hand** counts every cash payment with no pickup receipt taken in the last 60 days
  (`PICKUP_LOOKBACK_DAYS`). A payment left unticked by a partial pickup stays in the drawer
  until it is posted; the lookback only keeps a tenant with years of never-ticked history from
  waking up with every store "due". The older per-payment untick refuses a payment that a
  posted pickup carried out (409), so the slip and the drawer always agree.
- "Same day last month" is the same calendar day (README §5), clamped to the shorter month;
  "same day last week" is the same weekday. Month to date compares to the same day-range of
  the prior month.
- A Manager's "own store" = the stores their membership is scoped to (`membership_location_
scopes`), which is also what makes them the store's manager on the cards. A manager scoped
  to no store cannot post.
- Variance severity: any variance is a warning exception; $50 or more is critical. The exact
  threshold is the owner's call (README §5 lists the pickup thresholds as open).
- The severity filter on Changes maps the row tone: danger → Critical, warn → Warning. The
  per-viewer Unseen tick stays as the fourth option.
- The Z-report link on the manager's Last night's close tile points at `/shifts` until Phase
  10 ships `/shifts/close/[date]`.

### Later

- Phase 10 puts the cash pickups queue on the Operations home and adds the Z-report.
- The manager's time-clock strip is still the member's own clock, not the canvas's
  everyone-on-shift strip; that needs a `/v1/timeclock/store` read (Phase 10 with the
  Operations / Warehouse homes).
- A pickups history page / report (the `history` endpoint exists) and reprinting a slip.

## Phase 10 — Dashboards: operations, warehouse, Z-report (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** the Operations home and the Warehouse home
restructured per README §3.5 / canvas 8 with every shipped card kept, and the close-out sheet
(Z-report) built at `/shifts/close/[date]` with its own API, sign-off ledger
(`close_out_signoffs`, migration `0101_phase10_close_out_signoffs`) and the two drawer verbs.
Sales competitions are Phase 11.

### What changed

- **Operations home** (`dashboard/operations-dashboard.tsx`) — the time-clock strip and header
  stay; then the **cash pickups queue** and the **Stores** cards for every store (the Phase 9
  `StoresSection` with `showQueue`), **Flagged activity** (exception-first, every store, the
  feed's window; the panel border turns risk-red while a critical row is unseen; link →
  Exceptions), **Money in by tender** beside **Written business** (14 days, today's bar in
  accent), **By salesperson** (link → Salespeople), **Flagged activity by person** beside
  **Store activity**, and the editable **Staff schedule** with Publish last.
- **Warehouse home** (`warehouse-dashboard.tsx`, `.wh-figs`) — "Acting for {location}" header
  with Day sheet / Print; six figures **Receiving · On the dock · Trucks out · To pick ·
  Pickups waiting · Arrived, unscheduled** each with a red delta ("1 overdue", "38 not
  accepted", "1 short for promise", "1 waiting 7d+") and a sub-line; the truck cards; then
  **Receiving** beside the **Pick list** (tomorrow, by bin, **Print tickets** → the day-sheet
  print); **Arrived — book the delivery or call the customer** always rendered; **Dock in
  progress · Customer pickups**, **Transfers in motion · As-is review**; **Counts & stock
  health** as a glyph list (open count, negative on-hand first, last post); the read-only
  schedule. No store cards and no cash on the Warehouse home. Delivery windows are Postgres
  `time` values — the truck cards now format them as clock times instead of "Invalid Date".
- **Close-out sheet / Z-report** (`shifts/close/[date]`, `close-out-sheet.tsx`, `.zr-*`) —
  eyebrow MONEY · {store} (a store picker when more than one is in scope), **Close-out —
  {weekday, Month D}** with the chip **Auto-closed 10:00 PM · n exceptions** (Closed manually /
  Closes at 10:00 PM for today / Close never ran), ‹ date › nav (next disabled on today). Six
  tiles against the **same weekday last week**: Sales (count), Gross, Tax (effective rate),
  Refunds (red when > 0; count · baseline), Net (accent; ± vs last {weekday}), Order money
  (deposits on n orders). Then **Tenders** (swatch, count, amount; the **Refunds** line in
  red; the "tender rows are money taken in…" note), **Cash drawers** (Drawer n + who,
  Open → close, Expected, Counted, **Over / short** bold: red short, amber over, green $0.00)
  with the **inline exception** for each short/over/suspended drawer that has no reason yet —
  "Drawer 2 is short $84.50. Sam Whitfield closed at 8:45 PM without a recount. Ask for a
  recount or record the variance with a reason; either way it goes to the owner's exceptions."
  with **Request recount** (primary) and **Record with reason** (dialog) — a recorded reason
  drops the box and lists under the table with the name and time; **What the 10pm close did**
  (glyph list: posted n sales and n order payments, drawers checked / flagged, deliveries,
  open runs, delivered-with-balance, flagged drawers with their recount state, stock released,
  exceptions still open), **Refunds & cancellations** (document · rep · note · amount), and
  **Sign off close-out** (dialog with net / drawers / open exceptions and an optional note) →
  the green **Signed off · Name · time** box. Copy: "Signing records your name and time; the
  exception stays open until resolved."
- **Server** — `GET /v1/closeouts/report?date&locationId` (guard `reports.sales.view`; store
  scope respected; store-local day boundaries; baselines the same weekday last week;
  drawers = every `cash_shifts` row open at any point of the day, with the closer's name and
  the recount / reason state read back from the exception register; the day's
  `daily_closeouts` row and its findings; the sheet's exceptions = the close's own plus the
  drawers' non-info events, open vs total). `POST /v1/closeouts/sign-off` (`locationId`,
  `date`, `note?`) inserts the `close_out_signoffs` row (one per store per date; name
  denormalised; open exception count at signing), audits `closeout.sign_off` and fires
  `close_out.signed_off`. `POST /v1/closeouts/drawers/:shiftId/recount` records a
  `cash_recount_requested` warning once per drawer; `POST …/reason` (`reason`, 3–240 chars)
  records a `cash_variance_reason` info event. Both need a closed drawer with a variance or a
  suspension. New permission **`reports.closeout.sign_off`**: Owner, Operations, Manager.
- The manager's **Last night's close** tile now opens `/shifts/close/{closeDay}` for their
  store.
- `/dev/dashboard/operations`, `/dev/dashboard/warehouse` and `/dev/dashboard/close` (Glendale,
  yesterday, with the recount / reason / sign-off verbs working against the stub) preview the
  three screens on the canvas's fixtures.

### Assumptions

- **Sales / Gross / Tax** on the sheet are register sales completed **plus orders written**
  that store-day (STORIS's Z counted only the register; this business writes most of its
  money as orders, and the owner's headline already adds both). **Refunds** = negative
  payments on orders + register refunds; **Net** = Gross − Refunds; **Order money** = positive
  payments taken on orders that day (deposits and balances). The older `/v1/reports/z`
  (register-only, UTC day) is untouched.
- The baseline is the **same weekday last week** for every tile ("last Wed $16,900"); the tax
  tile shows the effective rate instead.
- "What the 10pm close did" is assembled from the day's `daily_closeouts` findings plus the
  sheet's own drawer facts; the close does not record "reserved stock" or "printed the day
  sheet", so those canvas lines are not shown.
- **Request recount** is a register event, not a notification to the cashier — the owner's
  exceptions and the sheet both show who asked and when. **Record with reason** keeps the
  drawer's numbers as counted; the reason is the info event's text.
- Signing never acknowledges an exception (README §3.5: "the exception stays open until
  resolved"); the sign-off row remembers how many were open when the manager signed.
  Signing waits for the day's close to have run (409 before that; the button says when it
  opens) — the sheet is a snapshot of a finished day and the sign-off is one per day.
- Operations keeps the time-clock strip as the member's own clock (as on the manager home).

### Later

- A cashier-facing recount flow (reopen the drawer for a second blind count) and a
  notification when a recount is requested.
- A "sign-offs" report across stores and the owner's view of unsigned days.
- Phase 11: sales competitions.

## Phase 11 — Sales competitions (2026-09-12)

> **Amendment 2026-09-13 (owner):** _people only, everyone listed._ The Stores race is
> retired: no People | Stores toggle, no store prizes, no store winner column in History, no
> stores line on the banner or the printable sheet; `?scope` is gone from
> `GET /v1/competitions/current` and `races` / `prizeStoreCents` are no longer settings (a
> stored value is ignored). Every active member whose role can log a lead
> (`competitions.leads.log` — Manager, Cashier by default; never the Owner role, who is off
> the board entirely, pinned row and ledger included) is on every card from day
> one, sales or not: the ranked rows come first, then the people the race cannot rank yet
> (no sales for a $ race or Least Exchanges; neither a lead nor a sale for a count race) in
> name order with `rank: null`, "—" for a $ value and "no sales yet" as the secondary. The
> strip lists everyone when expanded and the top three when collapsed; the leaderboard
> lists everyone; day one keeps the empty copy. `competition_results.scope` and
> `competition_ranks.scope` keep the value `people`.

**Branch:** `claude/new-session-q4kc7l` · **Scope:** README §3.6 / canvas 10 (`Proto Competition`,
`Redesign 10 Competitions`): the strip above every role home, six races for People and Stores,
the leaderboard, leads (form, list, auto-conversion, attach by hand), the winner banner and
printable sheet, overtaken notices, TV mode and the owner's settings. Migration
`0102_phase11_competitions`.

### What changed

- **Data** (`packages/db/src/schema/competitions.ts`) — `sales_leads` (salesperson, store, name,
  phone + normalised digits, wanted size / category / note, status open · converted · lost,
  converted order, conversion auto · manual, follow-up, expiry), `competition_ranks` (the last
  rank each person held per race this month, so an overtake is noticed once), and
  `competition_results` (a closed month's winners, frozen on first read, with the ranking for
  History). `member_notifications.order_id` is now nullable so a competition notice can sit in
  the inbox without an order; the inbox list left-joins and keeps the store scope on order
  notices. New shared helper `phoneDigits / phonesMatch / formatPhone`
  (`packages/shared/src/phone.ts`). Permissions **`competitions.view`** (every role) and
  **`competitions.leads.log`** (Owner, Manager, Cashier), grouped as "Sales competitions".
- **API** (`apps/api/src/competitions/`) — `GET /v1/competitions/current?scope&month` computes
  the board from the order ledger every call: completed orders in the store-local month, minus
  any with a completed return inside the return window, imported documents excluded (D8);
  attributed to the primary salesperson / the order's store. Races: Lead Conversion (converted
  this month, "of N logged"), Average Ticket (net ÷ orders), Highest Ticket (one order · first
  name), Most Sales (count, net small), Most Adjustable Beds (line units whose category or
  description says "adjustable"), Least Exchanges (exchanges on the person's orders ÷ sales;
  zero sales unranked; ties by most sales). Ties elsewhere break by net, then sales. Per card:
  full ranking with a ten-bucket sparkline and the orders behind each number, the top three,
  your pinned row with the gap in the metric's units ("$349 behind Brandon", "sell one to be
  ranked"), the pace line (leader at today's rate for count races), the sweep chip once anyone
  leads ≥ 3 cards, the winner banner for the first `bannerDays` of a month. `GET
/v1/competitions/history` (last 12 closed months, every race, your rank, paid / pays date),
  `GET /v1/competitions/sheet?month` (the printable winners), `GET/POST /v1/competitions/leads`
  and `POST …/leads/:id/follow-up | attach | lost` (own leads only; attach checks the order is
  written under the same salesperson and audits `lead.convert` as manual). On **order
  completion** `CompetitionsService.onOrderCompleted` converts the newest open lead of the same
  salesperson whose phone digits match the customer (or the order's address phone) inside the
  lead's window, then recomputes People ranks, compares with `competition_ranks`, and writes
  one inbox notice per race per day to anyone who slipped (`competition.overtaken`, event key
  carries the day). Settings live in `opsSettingsJson.competitions` (validated field by field,
  registered in the settings registry); webhooks `lead.logged`, `lead.converted`.
- **Strip** (`components/competition/competition-strip.tsx`, `.cs-*`) — on every `/dashboard`
  view and `/my-day`, above the home: "{Month} competition · 6 races · $100 each · win 4 →
  $1,000 · 5 → $1,500 · all 6 → $2,000", People | Stores (owner lands on Stores), days-left chip
  (22px and navy in the last 48h, the strip border picks up the accent), the sweep chip, + Log
  lead, Collapse (remembered per browser; collapsed keeps the top three and your row). Six
  cards → the leaderboard; each with title, prize, top three (rank, name, store code, value,
  secondary small), pace line (grey leader, navy you, tick at today's rate; expanded only),
  pinned own row (accent-soft) with the gap, one-line rule; day one shows each card's empty
  copy instead of zeros. Footer: the four rules, the sweep tiers, "Prizes pay Oct 5, once
  returns settle · History". Motion: when your rank changes between polls the row slides once
  (280ms) and the card flashes once (800ms); a new leader flashes the card. Hidden on 403/404
  so no home breaks. Polls every minute and on `erp:competition-update` / `erp:team-update`.
- **Leaderboard dialog** (`leaderboard-dialog.tsx`, `.lb-*`) — 880px: This month (# ·
  Salesperson/Store · Month sparkline · secondary · metric; your row tinted; "The orders behind
  you / {leader}" on the right; the rule) and History (Month · Winner · people · Result ·
  Winner · store · Your rank · Paid) with the printable sheet link.
- **Leads** (`lead-dialog.tsx`, `leads-panel.tsx`) — the form: Name ("First name is enough"),
  **Phone** required ("This is what matches the sale."), Wanted = Size + Category selects and
  one free line, "Logged under {you}", Save lead → toast "Lead saved · Marisol · converts if
  they buy from you by Oct 12". Opens from the strip and from **New Sale's customer card**
  ("Log as lead instead", pre-filled with what was typed). **My leads** under the strip on the
  cashier / My Day and manager homes: Customer · Wanted · Logged (days left, follow-up) ·
  Status chip Open / Converted (order link, "by hand") / Lost · Follow up · Attach order (order
  number dialog) · Lost; attaching turns the row green once, flashes the Lead Conversion card
  and toasts "+1".
- **Winner banner + sheet** — navy banner above the strip for the first 3 days of a month with
  one line per race, "Print for the break room" → `/print/competition-winners?month=` (letter,
  black on white: six races, winner · store, one-line story, the number, the stores line), and
  "Shows until Sep 3 ×".
- **TV mode** (`/tv/competition`, route group `(tv)`, no shell) — 1920×1080 dark frame: one race
  in focus at 30px+ rows with the leader tinted, the other five as one-line leaders, the cycle
  dots, the rules footer, six-second cycle, the clock. People race, no pinned row.
- **Settings** (`settings/competitions-card.tsx`, `.cset-*`) — per card on/off, People / Stores
  / Both, prize per race for people and stores, the sweep tiers, competitions on/off, month
  (calendar, resets 12:01 AM on the 1st — fixed), payout date, return window, banner days, who
  sees it (salespeople and cashiers, store managers, warehouse and dispatch) and overtaken
  notices; the footer totals the monthly payout; Save · applies {next month 1}.
- `/dev/dashboard/competition` previews the strip + My leads on fixtures with the verbs
  working; the other dashboard previews now carry the strip too.

### Assumptions

- **Completed** means `orders.status = 'completed'` with `completed_at` in the store-local
  month (the rule copy says "Only completed orders count"); fulfilled-but-not-completed
  orders are not on the board. An order with a completed return inside the return window
  comes off entirely.
- Split orders count for the **primary** salesperson only — the canvas never mentions splits
  and half a sale on a "Most Sales" card reads wrong. Net = total − tax.
- "Adjustable bed" units = order lines whose product category or description contains
  "adjustable" (the catalog has no flag; the categorised names are "Adjustable Bases").
- Exchanges are attributed to the original order's salesperson / store, counted when opened
  (not cancelled) in the month.
- Lead Conversion's denominator is leads logged this month; a lead logged late last month that
  converts this month counts in the numerator. A lead matches on the last ten digits of the
  customer's phone, phone 2 or the order's address phone, same salesperson, logged before the
  order completed and inside its 30-day window; the newest such lead converts.
- There is no Salesperson role: "salesperson home" is the Cashier / My Day view, where My leads
  renders; the owner and Operations get the strip without the leads panel.
- An overtaken notice is one inbox row per race per day (the event key is
  `competition:{month}:{race}:{day}`), sent only when the setting allows and never to the person
  whose order caused the move.
- Closed months are frozen the first time anyone reads them (History, banner, sheet) — after
  the month ends, not after the return window; the payout line still reads "pays Oct 5" until
  that date.

### Later

- A recount of ranks on return completion (a return today only takes effect on the next read;
  ranks / notices only recompute on order completion).
- Store-manager notices for the Stores race; a "who won" push at month end.
- The leads list for managers across their store (the API supports `?all=1`; the panel shows
  the viewer's own).

---

## Phase 12 — Accessibility pass, states, polish, cleanup (2026-09-12)

Canvas: `Redesign 9 Handoff.dc.html` (9a focus order, 9b dialogs, 9c contrast, 9d–9k
handoff sheets, the state matrix and the motion spec). No new screens; every change is
to what Phases 1–11 shipped.

### What changed

- **Dialogs.** Every remaining hand-rolled dialog now runs the shared `useFocusTrap`
  (Tab / Shift+Tab cycle inside, Escape closes, focus returns to the opener): the security
  override PIN prompt (`active` follows `open`, since it stays mounted), the customer picker,
  order action dialogs (`aria-labelledby` from a generated id), the PO delete-draft dialog,
  the payment-list and shift-editor dialogs. Their private window Escape listeners are gone.
  The account menu and the store / date controls close on Escape.
- **Tables.** Every clickable `<tr onClick>` (product search, customer picker, GL account,
  Sales, customer and salesperson activity, Members, Roles, Products, Counts, the manager
  home's two tables, payment list, changes card) spreads `rowKeys` from `components/ui/table`
  — `role="link"`, `tabIndex=0`, Enter / Space activates. `aria-sort` on Orders and Products
  headers was already correct.
- **Labels.** `aria-label` on the three unlabeled controls found (cleanup list, stock search,
  sales search). Shortcut hints render through `Kbd` / `formatKeys` everywhere — the order
  notes hint and the palette footer (chords from `GO_KEYS`) were the last literals; no `⌘K`
  string remains outside the `Kbd` source and its test.
- **Loading / error states.** `LoadingRows` and `ShimmerRows` expose `aria-busy` (`ShimmerRows`
  is a `role="status"` "Loading"). Every error `Alert` on a role home or list screen carries a
  **Retry** (manager, operations, warehouse, My Day, Products, Deliveries board, day sheet).
  State-matrix copy: "No stops scheduled for this day — nothing to print." (day sheet), "No
  drawer opened at {store} on this day." (Z-report), "Nothing to call about today." (manager),
  "No serials recorded for this product.", the month cap reads "No truck" at zero, and the
  owner headline empty line is "Nothing written yet today. Yesterday: $N." (the owner endpoint
  now returns `yesterdayWrittenCents`).
- **Contrast (9c).** All token pairs on the sheet measure ≥ 4.5:1 with the live values
  (lowest: muted on surface-2 at 4.51:1). `--faint` (2.9:1) is decoration only, so the text
  that still used it moved to `--muted`: `.eyebrow`, `.nav-group-label`, schedule dates and
  cells, `.dh-email`, `.tender-count`, and the dashboard "· name", "no money", empty-amount
  and impact-kind spans. Arrows, chevrons and disabled buttons keep faint. Focus rings on
  inset controls (`.seg-btn`, `.kpi-cell`, `.wh-fig`, stores footer cells) use a −2px offset
  so they are never clipped.
- **Reduced motion.** One global rule: every duration collapses, the skeleton is a static
  two-tone bar, the spinner hides, and the deliveries drag lift is a border change only
  (`transform: none`). The duplicate `@keyframes shimmer` and the deliveries-only
  reduced-motion block are gone.
- **Cleanup.** Deleted the dead `revenue-trend`, `order-quick-view` and `global-search`
  components, `StatLink` / `usdShort`, the unused `.dt th.is-sortable` rules and the ui
  barrel's unused exports. Dropped the six legacy aliases nothing reads (`--brand-hover`,
  `--brand-soft-text`, `--accent-line`, `--warning-soft`, `--warning-soft-text`,
  `--neutral-soft-text`). The `/inventory/*` routes are redirects only (`next.config.mjs`);
  the print counts sheet links back to `/products/counts`. The e2e CI job is "Playwright E2E".

### Assumptions

- The remaining legacy aliases (`--surface2`, `--text2`, `--danger`, `--warn`, `--brand`, …)
  still have roughly 300 call sites on screens outside the twelve phases (agency, team tasks,
  GL, settings). They stay until those screens are restyled; deleting them now would recolour
  nothing and break nothing, but the migration is not a Phase 12 change.
- `--faint` on `.btn:disabled` is intentional (disabled controls are exempt from the 4.5:1
  rule) and the eyebrow / nav-group labels at `--muted` read the same weight at 4.6:1.
- No axe spec: the checks were done by hand against 9a/9b (focus order on New Sale and the
  Orders book, trap/return on every dialog). A Playwright + axe pass belongs in Later.
- The kiosk time clock has no loading state on purpose (it renders the keypad immediately).

### README §5 answers (as built)

| Question                                            | Answer in the build                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery fee rule                                   | Per order: New Sale's "More" row takes a dollar fee (`deliveryFeeCents`), blank means none. No flat-$99 default is coded; the store types it.                                    |
| Cancel deposit default                              | Store credit — the cancel dialog defaults `depositTo` to `store_credit`, refund to the original tender is the other choice.                                                      |
| Who may unlock a printed order                      | Owner and Manager (`orders.unlock`, typed reason required); Operations, Cashier and Warehouse do not have it.                                                                    |
| Store minimums per location                         | Yes — `location_inventory.reorder_point` (STORIS "Min Stock" per store); below it shows amber in the Products browser and the variant's reorder point is the sum across stores.  |
| Cost column visibility                              | By permission: `products.cost.view` (Owner and Manager among the system roles) — the API omits cost otherwise and the column never renders.                                      |
| Cap per truck or per day                            | Per day, business-wide (`ops.deliveryDailyCap`, default 15 stops; one fleet, not one per store); an optional per-day capacity-unit budget sits beside it. Per-truck stays Later. |
| "Same day last month"                               | Calendar day (`sameDayLastMonth`), clamped to the previous month's last day.                                                                                                     |
| Second approver for sign-off with an open exception | Not required — one signer; the open-exception count is stored on the sign-off row and printed on the Z-report.                                                                   |
| Sweep bonus                                         | Replaces the per-card $100s: 4 / 5 / 6 of 6 pay $1,000 / $1,500 / $2,000 by default, editable in Settings › Competitions.                                                        |
| Cash pickup thresholds                              | $1,500 on hand or a cash payment older than 3 days (`PICKUP_DUE_CENTS` / `PICKUP_DUE_DAYS`, constants, not yet settings).                                                        |
| Managers record their own pickup                    | Yes — `pos.cash.pickup_record` for their own store; confirming the pickup stays with the Owner / Operations (`pos.cash.pickup_confirm`).                                         |

### Consolidated Later (all phases)

- **Type and tokens.** A licensed grotesk if the owner buys one; the `@theme` block shrinks to
  the new names once the ~300 legacy-alias call sites outside the redesign are restyled.
- **Kit.** `SortHeader` / `RowLink` are only used by `/dev/components`; Orders and Products
  keep their hand-rolled (correct) headers until one of them changes again. A Playwright + axe
  spec over the dev previews.
- **Shell.** Sidebar collapses to icons below 1280; the business switcher folds into the
  account menu.
- **New Sale.** ATP as a number (on hand − reserved + open POs) once search returns open-PO
  units; server-side "in stock first" ordering and paging past 100 rows; mattress / base
  detection from the category instead of the name.
- **Orders.** Per-store order prefix; the reserved sort and bar in units; a first-class order
  history endpoint with actor names.
- **Products.** Sticky first column past 1440 and a Cost column by permission rather than by
  returned data; modelled transfer / special-order lead times behind Next promise; a
  `/v1/reason-codes` class for receiving damage.
- **Deliveries.** Reservation state on the board rows (Waiting / At risk chips); per-truck
  capacity; restyle `/deliveries/search` and `/deliveries/confirm`.
- **Dashboards.** The manager's everyone-on-shift time-clock strip (`/v1/timeclock/store`);
  a pickups history page and slip reprint; a cashier-facing recount flow with a notice; a
  sign-offs report across stores and the owner's unsigned-days view.
- **Competitions.** Rank recount on return completion; store-manager notices for the Stores
  race and a month-end "who won" push; the managers' store-wide leads list (API supports
  `?all=1`).

## Amendment — 2026-09-12 (Phase 3 sidebar: groups always open)

Owner: "make the sidebar all open not collapsible." README §2 amended in the same
change. `components/shell/sidebar.tsx` renders the five groups as static uppercase
headings (`.nav-group-head`, `role="group"` + `aria-labelledby`) with every item
showing; the toggle button, chevron, `aria-expanded`, the `jetnine.nav.open`
localStorage key and the `userKey` prop are gone (`app-shell.tsx`, `/dev/shell`).
`groupForPath` in `nav.ts` had no other caller and is removed. The `.app-sidebar` column already
scrolls (`overflow-y: auto`), so the owner's 26 links fit at 1440 and scroll below.

## Amendment — 2026-09-13 (Every list gets Products-style columns)

Owner: "similar to how we have it inside of Products — do the same for the remaining
that have a list." README §3.3 amended. One implementation now, `components/ui/columns.tsx`:
`useListColumns(key, columns, rows, { server? })` keeps the order per browser under
`jetnine.columns.<key>` (unknown ids drop, new ids append), `ColumnHeadRow` renders the
grip-to-drag / click-to-sort `aria-sort` headers (fixed columns such as Actions never move),
`ColumnCells` renders a row in the header's order, `ResetColumns` shows once the order
differs. Drop semantics: dragging right lands after the target, left lands before it, so
every slot is reachable. Sorting is client-side over the rows on screen (numbers and dates
numerically, text with numeric awareness, blanks last both ways) unless the screen sorts
through the API (Products, Orders), where the column carries the server `sortKey`. Products
migrated onto the primitive; its saved order carries across from the old key. Tests:
`columns.test.ts` (4). Verified in Chromium on the Orders and Products previews.

### Later

- Keyboard column reordering (a Move-left / Move-right menu on the header) — drag only for now.
- Client-side sort covers the loaded pages of a cursor list, not the whole result set; a
  server sort per list needs API `sort`/`dir` support the way Orders and Products have.
