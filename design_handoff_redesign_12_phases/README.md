# Handoff: LA Mattress ERP — dashboard & register redesign (12 phases)

**Repo:** `AlwayzLegit/LA-Mattress-ERP` · `apps/web/src` (Next.js app router, `(business)` route group, `@/components/ui` kit, Tailwind + CSS vars in `globals.css`)
**Design files:** the `.dc.html` files in this folder are **design references built in HTML** — live prototypes showing intended look and behaviour. Do **not** ship them. Recreate them in the existing Next.js/React codebase using its established patterns (`PageHeader`, `Card`, `TableWrap`, `StatusBadge`, `Toolbar`, `useCursorList`, `api()`), replacing the visual tokens with the new system below.
**Fidelity:** high. Colours, type, spacing, densities and copy are final. Match them.

Read `CLAUDE_CODE_PROMPT.md` for the phase-by-phase instructions. Read this README for the system and the screen specs. Open the `Redesign N *.dc.html` canvases in a browser for artboards and the team's design notes; open the `Proto *.dc.html` files for the working prototypes (each has a Scene/Role tweak; New Sale responds to F2 / F8 / Esc).

---

## 1. Design system (Phase 2 canvas: `Redesign 2 System.dc.html`)

### Type
- Text: **Public Sans** 400/500/600 (Google Fonts). Body 13px / register body 14px, line-height 1.5.
- Numbers & headings: **Archivo** 500/600/700, always `font-variant-numeric: tabular-nums`. display-xl 44–56px / −.02em, display-l 26–30px, heading 18px, title 15px.
- Mono (SKUs, order numbers, money, times): **JetBrains Mono** 400/500, 12–13px.
- Column labels: 11px / 600 / uppercase / .05em, colour `muted`.

### Colour (warm neutral ramp, one accent, six statuses)
| token | hex | use |
|---|---|---|
| bg | `#f6f5f2` | app background |
| surface | `#ffffff` | sheets, rows |
| surface-2 | `#efeeea` | hover, zebra, disabled, hairline rows |
| border | `#dcd9d2` | hairlines |
| border-strong | `#bdb9b0` | input hover, grips |
| text | `#1c1b18` | primary |
| text-2 | `#4a4843` | secondary |
| muted | `#6f6c65` | labels (5.1:1) |
| faint | `#9b978e` | decoration only, never text |
| accent | `#1e3a5f` | primary button, links, focus ring, own row |
| accent-soft | `#e7edf5` | selected row, today, store-context chip |
| accent-ink | `#16304f` | link hover |

Status chips — always glyph + word + colour, 1px border of the tint, 600 weight, 11.5px:
| status | glyph | fg | bg | border |
|---|---|---|---|---|
| Draft | ○ | `#6f6c65` | `#efeeea` | `#dcd9d2` |
| Waiting on stock | ◔ | `#8a5a00` | `#fbf1dc` | `#f0d9a6` |
| Scheduled | ◷ | `#1f5fa8` | `#e5eef9` | `#c9dcf2` |
| Fulfilled | ✓ | `#1a6e43` | `#e3f2e9` | `#bfe0cc` |
| Cancelled | ✕ (word struck) | `#6f6c65` | `#efeeea` | `#dcd9d2` |
| At risk | ▲ | `#b3261e` | `#fbe7e5` | `#f0c4c0` |

Destructive tier: outlined `#b3261e` on white, never filled, never adjacent to primary, never default focus.

### Spacing, radius, density
- Space 4 · 8 · 12 · 16 · 24 · 32 · 48. Radius 3 (chips, inputs) · 5 (buttons, cards) · 0 (tables, sheets). No card-in-card, no 9px radius.
- Management density: row 36px, text 13px, control 30px. Register density (New Sale, picker): row 44px, text 14px, control 38px, hit target ≥ 44px.
- Focus: `outline: 2px solid #1e3a5f; outline-offset: 2px` — never removed.
- Motion: 120ms ease-out for state changes only (line added, chip change, slide-over 160ms, drop settle); 0ms under `prefers-reduced-motion`; nothing loops except the skeleton shimmer (1.4s), which becomes a static two-tone bar under reduced motion.

### Components (all on `Redesign 2 System.dc.html` artboard 2e)
Button ×4 (primary / secondary / ghost / destructive, with optional `<kbd>` chip), Field with visible label + hint/error, table row (whole row clickable via the anchor in the first column; the anchor takes focus), status chip, dialog (`role=dialog aria-modal aria-labelledby`, focus trap, Esc closes, focus returns), slide-over (640px, right, same dialog semantics), toast (left rule in status colour, auto-dismiss 2.4s, hover pauses), empty state (dashed border, title + one action), skeleton (4s budget → error), error with retry (names the draft and what happens next), platform-aware shortcut chip (`⌘K` Mac / `Ctrl K` Windows).

---

## 2. Shell (Phase 3: `Redesign 3 Shell.dc.html`)
- Sidebar 220px (200px at 1280). Brand block, Dashboard link, then **five collapsible groups**: Sell (New sale, Orders, Customers, Deliveries, At risk, My day) · After sale (Returns, Exchanges, Service, Special orders) · Stock (Products, Purchasing, Transfers, As-Is review, Gift cards) · Money (Sales, Shifts, Reports, Commissions, General ledger) · People & setup (Salespeople, Team tasks, Members & roles, Time clock, Settings). Only the current group open; collapse state per user. Role-trimmed: cashier default = New sale, Orders, Customers, Deliveries, My day, Products, Sales, My drawer, Time clock. Counts (Orders, Deliveries, At risk, Team tasks) in mono 11px at the right.
- Topbar 50px: **"Acting for {Store}"** chip (accent-soft fill, first control) → role switcher (owner only) → search trigger with platform kbd → inbox (badge) → primary New sale (kbd N) → account. Period controls belong to dashboard/reports, not the shell.
- Command palette: one input; groups Orders / Customers / Go to; phone digits match customers; footer shows `↑↓ ↵ esc` and the `g o / g d / g p` chords; dims the page, traps focus.
- Loading: skeletons in final positions, elapsed seconds in header, 4s budget. Error: the component in §1, with the draft named, auto-retry countdown + manual Retry, sidebar sync dot red.

---

## 3. Screens

### 3.1 New Sale (`Proto New Sale.dc.html`, Phase 4)
Layout: content grid `minmax(0,1fr) 316px`, gap 16. Items section full width with `table-layout: fixed`; column widths (border-box) Item auto · Qty 62 · Price 100 · Disc 80 · Fulfillment 148 · Inventory from 172 · Amount 104. Right rail: Customer · Order details (Store, Fulfillment, Promised, Salesperson in a 2×2 grid) · Totals (Merchandise, Discounts, Delivery, Tax 9.5%, **Total** in Archivo 26px, payments as negative lines, Due/Balance band) · action block.
Line row (44px): name + SKU/size/remove link + add-on chips (**Removal $0 · Recycling $18 · Declined foundation $0** — toggles, Recycling adds to the line amount) + inline warning; qty/price/disc inputs (mono, right-aligned; $0 price → amber border + row tint); Fulfillment select (`Same as order · {order fulfillment}` first); Inventory from select with **auto** badge while derived; availability note under it.
Sourcing rules (from `HANDOFF_inventory_source_defaults`): picker "From" and untouched lines default to **Warehouse — warehouse**; a line whose effective fulfillment is take-with follows the order's Store; recompute untouched lines on line fulfillment / order fulfillment / order store / product added; touched lines are never moved (inline note instead); take-with with 0 at source shows "Take-with: N available at {Store}. Change the source location or the fulfillment type." Reservations use `line.source_location_id`.
Add Product dialog: 1080px; Search (all words, any order), Vendor, Size, Firmness, **From** (accent-filled select), In stock first; columns Product/vendor·model, SKU, Size, Firmness, Price, **At {From}** (green >0 / red 0), All stores, ATP (`<abbr title="Available to promise: on hand minus reserved, plus units on open purchase orders">`), Add; footer "Showing N of 1,948", where lines will source from and why, `↵` adds first row, `esc` closes.
Payments: Take payment (F8, 44px) opens a rail panel: Method, Amount, Card last 4 (card only), Pay in full / 50% deposit, Record, Done; repeat to $0. $0 line blocks payment until "$0.00 is intentional" is ticked. Complete: locks everything, chip → Scheduled, green sentence (lines reserved at which sources, balance due at door), Print receipt (P), New sale (N). Drafts: "Resume a draft" list, store-wide. Keys: F2 add product, F8 take payment, Esc closes picker.
States: empty, mid-sale, picker, payment, completed, $0 warning, shell error/loading.

### 3.2 Orders + slide-over (`Proto Orders.dc.html`, Phase 5)
Toolbar: Store (default = signed-in store), Status, Written (7/30/90/all), Salesperson, Find (number/customer/phone digits), Balance due only, Clear filters; active filters as removable chips. Title line: "N of M · $X balance due". Columns (all sortable buttons with `aria-sort`): Order (anchor), Customer + phone, Store, Status chip, Reserved (6px bar + `done/total`), Promised, Salesperson, Total, Balance (bold when >0). Sticky header, footer with count and sort and the store-default note. Empty: "No orders match. Widen the date range or clear a filter."
Slide-over 640px: title = order number mono 17px + status chip + meta line; optional **lock banner** (accent-soft) "Locked — delivery ticket printed {when}. Lines, prices and addresses cannot change. Unlock (owner and store manager only; written to history)"; action row Take payment (primary), Edit lines (disabled when locked), Schedule delivery, Print, More ▾, **Cancel order** (destructive, `margin-left:auto`); 3-col summary Customer / Fulfillment / Money; Lines table (item, fulfillment · from, reserved fraction coloured, amount); Payments; Change history timeline (dot colour by kind, actor on every entry).
Cancel: `role=alertdialog`, title "Cancel {number}?", sentence names deposit destination (store credit default / refund to tender), reserved lines returning to stock, delivery removed, audited; Reason select required; **Keep order** is default focus.

### 3.3 Products (`Proto Products.dc.html`, Phase 6)
Tabs: Products · Stock by location · Counts · Receive. Browser toolbar: Search, Category, Size, Stock (in stock anywhere / short somewhere / out everywhere), Show inactive, Advanced search (disclosure, 10 fields), Reset columns (only when order differs). Columns (draggable header with grip ⋮, click-to-sort with `aria-sort`, order saved in localStorage per browser), default order: Product category, Product (SKU), Vendor model, Vendor, Description (link), **Warehouse, Glendale, Koreatown, La Brea, Studio City, West LA** (available = on hand − reserved; red = 0 with demand, amber = below store minimum, grey = 0), On hand · company, Net on PO, Available · ATP, Sales margin cost, As-Is on hand, As-Is available, Price, Status, As-Is non-sellable, Product group, Brand, Size, Firmness, Primary collection. Table `min-width: 2600px`, horizontal scroll inside the sheet; footer states the colour semantics in words.
Product page: identity header + actions (Adjust stock, Transfer, Print label, Edit product); **"Where it is"** grid first: Location, On hand, Reserved, Floor, Available, On PO, ATP, Min, Next promise (Today / Sep 5 · PO-4471 / Transfer from Warehouse · 2 days / Special order · ~3 weeks); company totals in the header; activity tabs with counts (Open orders, Purchase orders, Sales history, Transfers, As-Is, Serials, Adjustments).
Adjust stock dialog: Location, coded Reason, **now → change → after** strip, note required for count corrections > 2, guard: after < 0 disables; after < reserved shows red note "reassign the reservation first"; posts audited.
Receive: PO select, Into, Packing slip #, Blind count toggle; lines with Ordered / Already in / Received now / Damaged / Bin / Still open and the waiting SOs; rail totals units, damaged → As-Is (reason + note), still open, **orders unblocked**; Post receipt.

### 3.4 Deliveries (Phase 7 canvas, static artboards)
Header controls: Week | Month segmented, ‹ Today ›, Confirm calls, Dispatch, Print day sheet. Week: 7 columns, header `n / 15` + 4px bar (green <13, amber 13–15, red >15 with red border), cards = links with grab handle ⋮⋮, order, window, customer · city, status chip, `$due` in amber; empty day = dashed "No stops · Schedule here"; Pickup (return) cards use the Waiting tint. Drag: lifted card shadow + −1° tilt, origin ghost dashed 45%, target column navy dashed with preview "8 → 9 / 15"; drop 120ms; audit row written; keyboard: focus card, M, pick day. Over cap: allowed, day red, one-line note required and printed on the day sheet, banner at top. Month: same grid, 35 days, fraction + status roll-up + due-at-door, no cards. Day sheet print: letter, black on white, 14pt, stop number 26px, customer/phone/address, tick box per piece, window + due + signature line, COD total in header, failed-stop instruction every page.

### 3.5 Dashboards (`Proto Dashboard.dc.html`, Phase 8) — every shipped card kept
Common: header Today | Month to date; "Acting for" scope; time-clock strip (Manager, Ops, Warehouse) with clock in/out.
Owner: headline **Company written today** 56px with **vs same day last week** and **vs same day last month**; side tiles Month to date / Open exceptions; six small figures (Collected, Balance due, Refunds, Cancellations, Avg ticket, Deliveries today) with deltas; **Cash pickups** queue; **Stores** (one card per store: Written/Delivered/Received/Refunds, Salespeople table, Money received by method → payment list dialog, Cash on hand panel); Written business (30d bars), Morning brief, Changes (severity filter), Staff schedule (editable + Publish).
Cash pickups (rebuilt): per store, cash on hand since last pickup with chip Collected / Holding / **Pickup due** (> $1,500 or any cash payment > 3 days old); tick payments (none = all), **Record pickup** → Counted, Slip #, variance shown → **Post pickup** stamps every payment with who/when, issues `PU-nnnn`, flags variance to 10pm exceptions. Owner and Ops get a cross-store queue at the top (due first, "Record pickup" jumps into the form). Manager may record their own store.
Manager: time clock, store headline, side tiles Needs a call today / Last night's close, My store card, Incoming stock, Drawer & tenders, Store activity, My call-backs, My deliveries, My wins, My follow-up money, read-only schedule.
Operations: time clock, Cash pickups queue, all store cards, Flagged activity, Money in by tender + Written business 14d, By salesperson, Flagged activity by person + Store activity, editable schedule.
Warehouse: time clock, six KPIs (Receiving, On the dock, Trucks out, To pick, Pickups waiting, Arrived unscheduled), Receiving + Pick list (Print tickets), Arrived — book the delivery, Dock in progress, Customer pickups, Transfers in motion, As-Is review, Counts & stock health (negative on-hand call-out), schedule.
Z-report (`/shifts/close/:date`): six tiles with same-weekday baseline, Tenders (refund line red), Cash drawers (Over/short bold, inline exception with Request recount / Record with reason), "What the 10pm close did" list, Refunds & cancellations, Sign off close-out.

### 3.6 Sales competitions (`Proto Competition.dc.html`, canvas 10)
Strip above every role home. Header: "{Month} competition · 6 races · $100 each · win 4 → $1,000 · 5 → $1,500 · all 6 → $2,000", People | Stores toggle (People default; Stores for owner), days-left chip (22px & navy in last 48h), sweep chip once anyone leads ≥3 cards, + Log lead, Collapse. Six cards (links to leaderboard): title, $100, top three (rank, name, store code, value, secondary small), pace line (grey leader, navy you, tick = leader at today's rate; expanded only), **pinned own row** (accent-soft) with gap in metric units ("$349 behind Brandon"), one-line rule. Footer: completed orders only · returns within 30 days come off · ties by net sales · bonus tiers replace the $100s · prizes pay on the 5th · History.
Metrics: Lead Conversion (converted, "of N logged"), Average Ticket (net ÷ orders, "N sales"), Highest Ticket (order · first name on a second line), Most Sales (count, net small), Most Adjustable Beds, Least Exchanges ("N of M", zero sales unranked, tie → most sales). Motion: rank change = 280ms row slide + 800ms card flash, once. Overtaken → inbox notice, max 1/card/day.
Leaderboard dialog 900px: full ranking with sparkline and secondary, orders behind the focused number, History tab (month, winner, result, store winner, your rank, paid). Lead: form (Name, **Phone** required, Wanted = size + category + free line), from strip and from New Sale customer step; list on salesperson home with Open / Converted / Lost chips, Follow up, Attach order (audit-logged), Lost; auto-convert on phone match under same salesperson within 30 days. Month states: day 1 empty copy + winner banner (3 days) + printable winners sheet; last 48h; TV mode 1920×1080 dark, one card 30px rows, others as leaders, 6s cycle. Settings: per card on/off, People/Stores/Both, prizes, month, payout date, return window, banner days, visibility.

### 3.7 Also in the canvases
Team Tasks, Time clock kiosk, Active sessions, Deliveries search/confirm (see the live ERP design `LA Mattress ERP.dc.html` and `Tasks.dc.html`, `Staff.dc.html`, `Admin.dc.html`, `Deliveries.dc.html` for shipped-parity versions — restyle, do not redesign).

---

## 4. Accessibility & states (Phase 9: `Redesign 9 Handoff.dc.html`)
Focus orders for New Sale and Orders are drawn on 9a/9b. Every row is a link; every header sort is a button with `aria-sort`; dialogs trap and return focus; every input has a visible label or `aria-label`; contrast table on 9c (all text ≥ 4.5:1); state matrix (loading/empty/error copy per screen) on 9c; handoff sheets with open questions on 9d–9k.

## 5. Open questions (answer before or during build)
Delivery fee rule (flat $99 assumed) · cancel deposit default (store credit assumed) · who may unlock a printed order (owner + manager assumed) · store minimums per location exist? · cost column visibility rule · cap per truck or per day · "same day last month" = calendar day (assumed) · second approver for sign-off with open exception · sweep bonus replaces per-card $100s (assumed) · cash pickup thresholds $1,500 / 3 days · managers may record own pickup (assumed yes).

## 6. Files in this folder
`Redesign Index.dc.html`, `Redesign 1…10 *.dc.html` (canvases with notes), `Proto New Sale.dc.html`, `Proto Orders.dc.html`, `Proto Products.dc.html`, `Proto Dashboard.dc.html`, `Proto Competition.dc.html`, `support.js` (runtime for viewing the prototypes), `CLAUDE_CODE_PROMPT.md`.
