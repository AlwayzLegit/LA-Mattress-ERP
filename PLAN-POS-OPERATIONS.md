# PLAN — POS / Operations Modules (STORIS-modeled, owner-confirmed)

> **Locked plan doc** (same contract as `PLAN.md` / `PLAN-STORIS-CUTOVER.md`: change
> this doc first, then the code). Source: owner HANDOFF spec, 2026-08-25, plus the
> owner amendments in §0. Where this doc is silent, use the closest STORIS-style
> convention and flag it in the build summary. Do not "improve" a decision without
> asking. Extends the existing codebase — customers and products/inventory are
> already migrated; extend, don't recreate.

## 0. Owner amendments to the handoff (2026-08-25, final)

| #   | Amendment                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | **Batch delivery-ticket printing does NOT lock orders.** Only an individual delivery-ticket print locks (§7); the batch "Print all for date" prints without locking — the lock exists to freeze a specific order that is physically on the truck.                                                                                                                        |
| A2  | **La Brea keeps its name; prefix `LB`** (the handoff's "H — Hancock Park" is superseded). Store prefixes: WH=Warehouse, SC=Studio City, WL=West LA, K=Koreatown, LB=La Brea. Imported STORIS history/stock mapped to La Brea stays attached.                                                                                                                             |
| A3  | **Single-screen New Sale supersedes the checkpoint-7 three-step wizard.** All wizard fields/logic (fulfillment methods, fees, tenders, layaway, split tickets) carry into one screen with the pinned totals panel; the step chrome goes.                                                                                                                                 |
| A4  | **The legacy quick-sale register retires entirely**, including its offline mode (offline capability is dropped for v1; a future rebuild inside New Sale is a separate effort). Take-with flows through New Sale.                                                                                                                                                         |
| A6  | **Inventory Clerk is renamed Warehouse and gets its own home** (owner 2026-09-01). Same role, same permissions plus `warehouse.dashboard.view`; the sync renames existing tenants' system role in place (memberships untouched) and skips any business with its own "Warehouse" role. Dashboard spec in §12.2.                                                           |
| A5  | **Operations is a sixth role, with its own home** (owner 2026-08-31). It watches every store's selling and every dollar and unit that moves, and signs off on what it reads — read-and-clear, never approve, consistent with §13's "approval queues (dashboard visibility instead)". It sells occasionally: no quota, no commission. Detail in §12.                      |
| A7  | **Cashier gets its own home, "My Day"** (owner 2026-09-01). Permission `cashier.dashboard.view` on the Cashier role; ten cards about the signed-in seller's own day and the store they are standing in. Login still lands on New Sale (§4) — the dashboard serves selling, never replaces it. Customer address entry autofills city/state from the ZIP. Detail in §12.3. |
| A8  | **Orders carry a notes thread** (owner 2026-09-01). Anyone who can see an order (`orders.view`) can leave a note on it; each note keeps its author and time, is append-only, and lands in the order's change history. The order's `notes` / `internal_notes` fields stay the printed and customer-facing text.                                                           |

### Team workflow extension (owner request 2026-09-06)

Extend order notes with named recipients and add shared order tasks. Members with
`orders.view` can collaborate only on orders within their existing data scope.
Tasks have an owner, due date, priority and Open / In progress / Blocked / Done
status; updates stay in the order audit history. An assignment must name an active
member who can see that order. Reassigning provides coverage when someone is away.
The Team Tasks page offers My tasks, Team, Overdue, Blocked, Needs owner and
Completed queues.

A personal in-app inbox receives assignments, task changes, selected note updates
and relevant order changes. Read state is stored per member and business, across
devices. The existing owner order-change feed remains available separately.
Nightly overdue reminders are deduplicated per task deadline and recipient.
This collaboration slice uses internal notifications and audit events; it adds no
outbound webhook, email or SMS delivery. It does not change order money, stock or
fulfillment.

## 1. Locations & Order Numbering

Store prefixes (final, no duplicates): WH Warehouse · SC Studio City · WL West LA ·
K Koreatown · LB La Brea.

- Order numbers: `{PREFIX}-{sequence}` e.g. `SC-10234`. Sequential **per store** (each
  store has its own counter). Existing `SO-YYYY-######` numbers on already-created
  orders are preserved; new numbering applies from cutover of this feature.
- Prefixes/locations admin-manageable (add/edit stores without code changes).

## 2. Roles & Permissions

Roles: **Associate, Store Manager, Warehouse, Owner/Admin**.

- Permission system = a matrix editable by Owner/Admin: every permission a checkbox
  per role. Creating a user auto-populates permissions from role defaults; admin can
  adjust per user (per-user overrides).
- Store Managers are salespeople: they see their own sales + their store's sales
  only. Owner/Admin sees everything.
- Owner/Admin selects (settings) which roles may unlock a locked order (§7).

## 3. Order Types

- **Sales Order** (standard)
- **Sales Quote** — no deposit, no inventory reservation; convertible to Sales Order.
- **Layaway** — minimum deposit **$100 flat** to open. No fulfillment until paid in
  full, then proceeds as a normal order.
- **Exchange Order** — §10.
- **Service Order** — post-sale issues, always linked to the original sales order.

Fulfillment types (per order and per line): Delivery, Customer Pickup, Take-With,
Direct Ship, Split Ticket (mixed per-line fulfillment under one order).

## 4. New Sale Screen (the core screen)

Desktop-first. Left sidebar nav. Light mode only. Login lands directly on New Sale.
Branding neutral/white-label; per-tenant logo upload (admin setting).

Single-screen order entry — customer, products, payment all on one screen (no wizard):

- **Customer**: universal search box — name, phone, email, OR address matches
  against all stored fields, pulls the full record. Multiple matches → dropdown with
  phone + address preview. Inline "create new customer" if no match.
- **Ship To** defaults to billing with a one-click toggle for a different address.
- **Add Product popup filters** (owner 2026-09-01): Vendor, Size, Firmness and In stock,
  combinable with the search box. Size and firmness are read off the catalog — a
  variant's attributes first, then the product and variant names — so Shopify-shaped
  names classify without tagging. Vendor matches the variant's preferred vendor, the
  product's brand, or a name that starts with the vendor's name.
- **ZIP autofill** (A7): typing a complete ZIP (US 5-digit, ZIP+4 tolerated, or a
  Canadian postal code) fills city and state from the API's bundled table
  (`GET /v1/geo/zip/:zip`, offline, never rate-limited). It fills only where the
  field is empty or holds a previous autofill — a hand-typed city is never
  overwritten. Applies to the New Sale customer, billing and ship-to blocks and
  the customer edit page.
- **Add Product**: popup search window with filters (vendor, size, more), results
  show product details, sortable/filterable by in stock / not in stock. Selecting
  adds the line. **No barcode scanning.**
- **Out-of-stock line** → warning banner with ATP date, e.g. "Available ~Sept 4 via
  PO" (computed from open POs/transfers/reservations).
- **Price override**: click the price, type a new one. Any associate, no approval,
  no cap.
- **Discounts**: per line item AND on the order subtotal.
- **Fee lines** _(amended 2026-08-30: the Recycling Fee no longer auto-adds per
  qualifying unit — the owner wants it added by hand)_: a "+ Recycling" button next
  to "+ Removal" adds one untaxed Recycling Fee line (rate = admin setting, e.g.
  $10.50/unit); each further click counts one more unit on that line; removable by
  the salesperson. Installation = order-level fee (default $0). Mattress Removal =
  selectable $0 line item. Delivery fee entered manually per order.
- **Take-with hand-over** _(amendment 2026-08-31)_: completing a sale (New Sale, or
  Complete on the order page — the per-line hand-over button is gone) splits any
  take-with lines to a `-A` sibling order; money already collected covers that piece
  first, and the piece fulfills + completes itself when every unit is reserved and
  it is paid. A short or unpaid piece stays open with a waiting banner (a user with
  inventory access adjusts the stock in) and finishes with one click on the piece.
  The invoice prints the whole split family as ONE document under the base number
  with take-with lines marked; the delivery ticket never lists take-with lines.
- **Salespeople**: multiple per order; commission split defaults to equal, editable.
- **Totals panel pinned**: merchandise, discounts, installation, delivery,
  recycling, tax, total, amount paid, balance due.
- **Tax**: rate per store location (admin setting).
- **Payments**: a list — add payment lines (method + amount) until balance = $0 (or
  partial for deposits). Methods: credit card, cash, check, PayPal, Venmo, Zelle,
  Synchrony, Acima, Store Credit. Store credit auto-surfaces at checkout. Deposits
  tracked as liabilities tied to the order.
- **No signature at point of sale** (signature is on the printed delivery ticket).
- **Drafts**: "Save as Draft", visible store-wide; anyone can resume.
- **On complete**: success state with Print / Email invoice, then fresh New Sale.
- Orders fully editable until delivered/completed (unless locked, §7). Every
  post-creation change surfaces in the Owner dashboard notifications feed (§12) and
  the order's change-history timeline.

## 5. Inventory

- Perpetual, real-time, cross-store visibility from POS.
- Auto-reserve at save; explicit Unreserve action.
- SKU-level only — no per-unit serials.
- One universal price list across stores.
- Reorder points manual per SKU. No auto-PO; PO builder pre-loads (a) items at/below
  min due to sales/reservations and (b) sold-not-in-stock items for that vendor.
- Stock adjustments require a reason code (damage, theft, correction), logged with
  user + timestamp.
- Transfers between stores: any manager; workflow create → print transfer ticket →
  deliver → sign → complete (receiving side confirms); statuses visible like orders.
- As-Is inventory = distinct stock status (used by returns). No sale restrictions.

## 6. Purchasing & Receiving

- POs manual, builder pre-loads per §5. Output: print / PDF / emailed to vendor from
  the system (existing Resend infra); replies route per admin setting.
- Every PO line bought for a customer order carries that sales order # on the PO.
- Receiving: single screen; per line Received → Inspected → Accepted.
- Partial receipts: accepted lines flip linked sales-order lines to Reserved;
  remainder stays open with "X of Y remaining"; PO auto-completes only when full.
- Vendor invoices auto-match to the PO (by PO #) for approval.
- No landed cost/freight allocation in v1.

### 6.1 Deleting a draft PO (CR 2026-08-31)

A draft had no exit. Retiring one meant placing it — recording a vendor commitment
that never existed — and then cancelling, or stripping its lines and leaving a
$0.00 shell on the list forever. The reorder panel makes drafts one click at a
time, so the shells accumulate.

- **Draft only.** Everything past Draft has told the outside world something: a
  placed PO is a commitment and **cancels**; a received one has moved stock.
- **Soft delete.** `deleted_at` + `deleted_by_user_id`; the row stays. PO numbers
  are generated from a count of existing rows, so keeping the row is also what
  stops the next PO inheriting a deleted one's number. **Gaps in the sequence are
  expected and correct.**
- **Hidden by default;** `includeDeleted=1` ("Show deleted") brings them back
  greyed, with who deleted them and when, and a Restore action.
- **Confirm against the PO number** — the dialog shows vendor, line count and
  subtotal, and arms only once the number is typed.
- **Releases what it holds.** Linked special-order lines are un-sourced
  (`po_line_allocations` → `cancelled`) so they return to the buying queue. There
  is no stock to release: a draft PO holds none — stock moves only at
  receive/unreceive. Un-sourcing and the delete share the request's RLS
  transaction, so both happen or neither does.
- **Restore does NOT re-claim those lines.** They went back on the queue and may
  have been sourced elsewhere meanwhile; re-claiming could source one line twice.
- **Refusals**, each with its own message: not a draft ("Only drafts can be
  deleted. Cancel this PO instead."); any line with received/inspected/accepted/
  rejected units; a matched or approved vendor invoice; a linked sales-order line
  already fulfilled (names the SO).
- **Permission:** `purchase_orders.delete`, separate from `purchase_orders.create`
  — the Inventory Clerk who raises POs cannot delete them. Owner and Manager hold
  it; the shared POS account must not.
- **Audit:** `purchase_order.delete` / `.restore`, surfaced in a new **Change
  history** card on the PO page (the PO had none; sales orders already did).

### 6.2 The PO builder is a staging screen (CR 2026-08-31, root cause)

The reorder panel used to commit a numbered draft on the first click of "Draft
PO" — which is how the list filled with $0.00 shells that then had no exit. The
button now reads **Review & order** and opens
`/purchase-orders/new?vendorId=…&preload=reorder`, which stages every suggestion
as editable lines and **writes nothing**.

- The builder holds lines, quantities and costs in component state; backing out
  costs nothing, and a `beforeunload` guard stops a stray reload binning a staged
  basket (same guard the order writer got for BA-0001).
- Preload runs **once**: changing vendor afterwards means the buyer is
  hand-building, not re-seeding.
- Two exits, both a single write: **Save as draft** (`place: false`) parks it,
  **Place order** commits to the vendor. Before this the builder could only
  place, so the draft path existed nowhere but the eager button.

## 7. Delivery & Dispatch

- Dispatcher view: simple table (orders by date/route).
- Capacity: 15 stops/day soft cap; "15/15" state shown; booking beyond allowed with
  confirm + notification. During a sale, associate sees remaining capacity per day.
- Routes auto-suggested by zip/area; freely editable.
- Drivers work off printed tickets only; office closes out after the run.
- Delivery tickets: printable per order AND batch "Print all for date" for the day's
  fulfilled orders; unfulfilled orders for the day are clearly flagged (which + why).
  Ticket includes a customer signature line.
- **LOCK (amended by A1)**: an _individual_ delivery-ticket print locks the order —
  no edits while on the truck. Batch printing does NOT lock. Unlock restricted to
  owner-selected roles (§2); unlocking requires a typed reason logged to the owner
  dashboard.
- Partial deliveries split: delivered lines complete, rest stays open on its own
  schedule. Failed delivery stays open; manual reschedule.
- Customer-facing delivery tracking link per order (extend the existing feature).

## 8. Order Lifecycle & Statuses

Display statuses (exact wording): **Draft → Pending → On PO (show PO #) → Reserved →
Scheduled → Out for Delivery → Delivered**, plus Quote, Layaway, Cancelled,
Returned/Exchanged.

- Orders list columns: Order #, Customer, Status, Delivery Date, Balance Due,
  Salesperson.
- Row click opens the full order page. _(Amendment 2026-09-02, owner: the
  slide-over panel is retired — one click on an order row or its Order # lands
  on the order itself; the browser Back button returns to the list, which keeps
  its filters in the URL.)_
- Order detail shows a change-history timeline, every field change attributed.

**Amendment (2026-08-31, S01 browser-audit P-013/BA-0017):** the display ladder
above is the ONE status vocabulary everywhere an order status is shown or
filtered — the list badge, the order-detail badge, and the status filter all use
these exact words (plus Awaiting Return Pickup). The raw lifecycle statuses
(`open`, `partially_fulfilled`, …) are internal only and never surface in the UI.
The list filter filters BY display status (`display=` on `/v1/orders/list-view`);
the detail endpoint returns `displayStatus` derived from the same ladder.

**Amendment (2026-09-02, owner — order page overhaul):** the order detail page
is organised around "what happens next":

- A next-step banner under the header says the one thing to do now (collect the
  deposit, wait on the PO, release the short line, schedule the truck, collect
  the balance, complete) and links to the card that does it.
- A sticky balance strip in the sidebar carries total / paid / balance due with a
  Take payment jump; the Money card stays the place payments are recorded.
- Lines carry a **Stock** column: fulfilled / reserved / partial / not reserved,
  and for a line on a purchase order the PO # with its state — "on order · due
  <date>" while the PO is out, "accepted, reserved" once receiving flipped the
  allocation and reserved the line. Each reserved line has its own
  **Release** (`POST /v1/orders/:id/lines/:lineId/release`) so one item can be
  put back without releasing the whole order.
- A split family (take-with pieces written as `<number>-A`, …) shows as a
  **Split orders** card under Lines: each sibling with its number, type, status,
  lines and balance, so the delivery order and the take-with piece are read
  together. The detail endpoint returns each sibling's `lines`.
- **Returns** and **Exchanges** are separate cards; the detail endpoint lists
  `exchangeOrders` (orders whose `originalOrderId` is this order).
- Cards that do not apply yet (Deliveries with nothing to ship, Returns before
  delivery, Exchanges, Payment plan on a non-layaway order) collapse to one line
  with the action that opens them; the page renders a skeleton while the order
  and locations load in parallel.

## 9. Commissions

- Splits default equal across the order's salespeople; editable at entry.
- Calculated on completed orders only. Flat structure, rate configurable; no
  per-category variance in v1.
- Exchanges: return portion and new-sale portion can carry different salespeople —
  clawback on the returned portion, new commission to the exchange salesperson.

## 10. Returns, Exchanges & Service

- No restocking fee. Refunds to the original payment method (splits proportional).
- Partial refunds / price adjustments = distinct transaction type from full returns.
- Every returned item lands in As-Is and requires manager/warehouse review before
  returning to sellable stock; warranty/defect same path, with vendor disposition
  option.
- Exchange Orders: new document titled "Exchange Order", linked to the Original
  Invoice # (displayed prominently). Create exchange → deliver new → pick up old →
  old enters As-Is → review. Doc shows Total Exchange Order, payments, Credit Due.
- Service Orders link to the original sale.
- Store credit: on the customer record, never expires, auto-surfaces at checkout;
  issued from returns/refunds.
- No comfort-exchange policy enforcement in v1.

## 11. Printed / PDF Documents

Replicate the two LA Mattress sample invoices. All documents: neutral template +
tenant logo slot.

- **Invoice / Sales Order**: logo, store address block + phone, admin-editable
  header note line ("WE CALL 6-8PM NIGHT BEFORE DEL"), Sales Order # box, Scheduled
  Date / Document Date boxes; Sold To / Ship To; strip Customer Ph. | Terms |
  Salesperson (initials) | Customer # | Store; printed timestamp; fulfillment type
  row + free-text notes box; line grid Ln# | fulfillment code | Model | Brand |
  Description | Order qty | Price | Amount ($0.00 lines print); totals Merchandise,
  Installation, Tax, Total Sales Order, Amount Paid, payments listed by method +
  date + amount, Amount Due box; admin-editable footer.
- **Exchange Order**: same shell, titled "Exchange Order", + Original Invoice #;
  totals show Total Exchange Order, payments, Credit Due.
- **Delivery Ticket**: order + customer + address + phone, lines, delivery notes,
  route/date, signature line. Batch-printable per §7 (no lock on batch, A1).
- **Purchase Order**: vendor, ship-to, lines with linked sales order #s, expected
  date; print + PDF + system email.
- **Transfer Ticket**: from/to store, lines, signature line.

**Amendment (2026-08-31, S01 browser-audit batch 3, P-010/011/021):**

- Invoice strip prints the salesperson's **full name** (not initials) and drops
  the Customer # cell — there is no human-facing customer number, and a fragment
  of the internal id fails the audit's paste-into-search test (BA-0013/BA-0030).
- Sold To carries the customer's billing street address, ZIP included; Ship To
  falls back to printing the billing address instead of "Same as billing"
  (BA-0014).
- **One definition of Merchandise**: the invoice totals box shows Merchandise
  excluding the CA mattress recycling fee and breaks the fee out on its own
  "Recycling" line, matching the New Sale entry screen — CA requires the fee
  itemized on the receipt (BA-0015). Order totals are unchanged.
- Delivery ticket excludes fee lines (`lineType = custom`) from the load list,
  same rule as the pick list (BA-0028).
- Delivery ticket and pick list carry a Code 39 order-number barcode; the pick
  list adds a per-line SKU barcode (BA-0029). The §13 "barcode scanning"
  exclusion refers to POS scanning hardware, not printed barcodes.
- Documents print payment methods with the POS tender labels ("Cash", not
  "cash") (BA-0041).

## 12. Dashboards, Reporting & Close

- Owner/Admin morning dashboard tiles: yesterday's sales by store; sales by
  associate; today's deliveries (with 15-cap state); refunds/cancellations (with
  associate); modified orders (daily modification log with details).
- Notifications section: every post-creation order change, cap overrides, lock
  overrides (typed reasons), close-out exceptions.
- Store manager dashboard = same, scoped to own sales + own store.
- End-of-day close runs automatically 10:00 PM daily per store; never blocks —
  unbalanced payments / unprinted deliveries flag as exceptions to the owner
  dashboard.

### 12.1 Operations dashboard (amendment A5, owner 2026-08-31)

Every store, always — no store picker, and no goal or commission tile. The page
is exception-first: the feed leads, the numbers sit under it.

- **Needs you today** — one prioritized list across all stores, loudest first.
  Critical: negative on-hand (no threshold and no time bound — stock cannot be
  less than nothing); a take-with handed over on a **split ticket** whose order
  never completed; a suspended drawer; a security override. Warning: refunds and
  returns over the threshold, drawer variances, manual stock adjustments,
  cycle-count variances, receiving reversals, write-offs, gift-card adjustments
  and cancellations, waived restocking fees, and open exception-register rows.
  Info: every exchange entered, as-is restocks, transfers.
- **Sign-off, not approval.** Each row carries a checkbox and clears in bulk,
  stamped with who cleared it and when. Rows already in the exception register
  clear through `exception_events.acknowledged_at`; everything else is recorded
  in `ops_reviews`, one row per subject. Clearing is idempotent. The approval
  permissions (`pos.refund.approve`, `pos.cash.approve`, `orders.price_override`,
  `exchanges.approve`, `returns.override_window`) stay with the Manager, so the
  person who authorizes an exception is never the person who signs it off.
- **Money today, all stores** — in (by tender), out (refunds, returns,
  write-offs), net, and exchanges entered. Imported legacy documents excluded
  per cutover decision D8.
- **Selling** — a by-store row and a by-salesperson table (written, count,
  collected, refunded, discount %) so every store's sales and every
  salesperson's sales are on one page.
- **Flagged activity by person** — the same feed grouped by who did it. A flat
  stream hides a pattern; the roll-up makes an outlier show itself.
- **Open & close** — per store: drawer state, variance, whether the 22:00
  close-out ran and what it flagged.
- **Store activity** — recent order changes grouped by order.

Thresholds live in `businesses.ops_settings_json.opsReview` and are tri-state:
absent or null means the documented default, zero is a real setting. Defaults:
refunds ≥ $200 · discounts ≥ 20% · overrides and write-offs ≥ $100 · drawer
variance ≥ $5 · stock adjustments ≥ 5 units · take-with open 24h · 7-day
lookback.

Routing: `/dashboard` opens on this page for the **Operations** role. Owner and
Manager hold every business permission, `ops.dashboard.view` included, so gating
the home on the permission would replace theirs too — they reach the same page
at `/operations` from the nav. The permission governs access; the role governs
which home you land on.

### 12.2 Warehouse dashboard (amendment A6, owner 2026-09-01)

The renamed Inventory Clerk's home: a day in the building. **Defaults to
ALL locations combined** (owner 2026-09-01), with the picker narrowing to
any single location; warehouse-type locations lead both the picker and the
clock. In the combined view every row names its building, transfers read
"from → to" (both ends are inside the scope), and the truck's stop cap is
omitted — it is a per-location knob, so a combined cap would be a made-up
number. No money tiles, no selling — the receiving pipeline and every
"goods are here, close the loop" queue:

1. **Inbound** — open POs shipping here: due date, overdue flag (the
   call-the-vendor list), received/ordered units.
2. **Dock in progress** — units Received or Inspected but never
   Accepted/Rejected: goods physically in the building but not sellable,
   with idle time per PO.
3. **Today's truck** — stops vs the daily cap, pieces to pull, route and
   driver, and any order whose serial-tracked lines have unpicked serials;
   links to the printable day sheet.
4. **Pick list — tomorrow** — tomorrow's delivery lines aggregated per
   variant with bin location, flagged short when on-hand < pull quantity.
5. **Customer pickups waiting** — open pickup orders: ready to stage vs
   stock-short, age in days, 7+ days flagged.
6. **Arrived, unscheduled** — special-order allocations received where the
   customer's line is unfulfilled and no live delivery exists. The
   highest-value queue on the page; it leads when non-empty.
7. **Transfers in motion** — drafts awaiting their ticket, in-transit with
   days elapsed, and the 30-day closed-short count.
8. **As-is review** — pieces pending review, valued at cost, oldest first.
9. **Counts & stock health** — open counts, last posted count date, and
   negative on-hand at this location (count these first).

Routing mirrors §12.1: `/dashboard` opens here for the **Warehouse** role;
`/warehouse` in the nav for anyone with `warehouse.dashboard.view` (Owner
and Manager included). Card 10 (bins/floor-sample health) was considered
and cut by the owner.

### 12.4 View Customer Activity (amendment A8, owner 2026-09-02)

STORIS "View Customer Activity", rebuilt as `/customers/:id/activity` (lookup
screen at `/customers/activity`; linked from the customer record and the
Customers list). One read (`GET /v1/customers/:id/activity`) feeds eight views
down the left, every figure derived from the documents:

| #   | View                 | Shows                                                                                                                                                                                                |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | General Information  | Address, ship-from location (stock location of the latest order), credit remarks (customer notes), and Sales / Returns / Service totals with counts for this year, last year, lifetime.              |
| 2   | Open Orders          | Credit limit (unlimited), total orders, deposits, total A/R, unpaid balance; one row per open order: type, fulfillment, date, salesperson, merchandise, other, total, paid, balance, display status. |
| 3   | Order Line Details   | Pick an order: product, description, qty reserved / ordered / backorder, fulfillment date, qty received, PO # (link), PO delivery date, PO qty, fulfillment method, status.                          |
| 4   | Historical Purchases | Document filter (all / delivered orders / register sales / returns): number, type, invoice date, product, description, quantity (returns negative), price.                                           |
| 5   | Current Deposits     | Per open order: deposit held, order amount, type, date, deposit type (method of the latest payment), A/R credit (overpayment).                                                                       |
| 6   | Historical Deposits  | Total deposit liability (money held on undelivered orders); every payment and completed-return refund with its reason.                                                                               |
| 7   | Open A/R Items       | Earliest / latest date filter; unpaid layaway or plan installments and delivered orders still owing, with due date and memo.                                                                         |
| 8   | Open Service Orders  | Unfinished service tickets: number, date, warranty/service, coordinator (technician), status, product, issue, scheduled date.                                                                        |

The header carries customer code (short id), name, phones, email and store
credit balance (this ERP has no reward points). Read-only; every row links to
its document.

### 12.5 View Salesperson Activity (amendment A9, owner 2026-09-02)

STORIS "View Salesperson Activity", rebuilt as `/salespeople/:membershipId/activity`
(lookup at `/salespeople/activity`; linked from every row of the Salespeople
page). One read (`GET /v1/salespeople/:membershipId/activity?from&to&today`)
counts every order the member wrote or shares (primary or second salesperson):

| #   | View             | Shows                                                                                                                                                                            |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | General          | Open orders / layaways / quotes / carts totals with counts; written sales today and month-to-date (order date); delivered sales today and MTD (completion date).                 |
| 2   | Open Orders      | Order, customer, type, fulfillment type, fulfillment status (display ladder), order date, fulfillment date, merchandise, total, paid, balance, salespeople count; footer totals. |
| 3   | Completed Orders | Start / end date window (default: first of last month → end of this month); same columns keyed on completed date.                                                                |
| 4   | Canceled Orders  | Same window, keyed on cancel date.                                                                                                                                               |
| 5   | Layaways         | Open layaway orders.                                                                                                                                                             |
| 6   | Carts            | Draft orders.                                                                                                                                                                    |
| 7   | Quotes           | Quotes.                                                                                                                                                                          |
| 8   | Leads            | Customers on this member's quotes or carts who have no real order yet (this ERP has no separate leads table).                                                                    |

Header: initials code, name, email, membership status, selling locations
(approved list, else "All stores"). Read-only; rows link to the order and to
the customer's activity screen.

### 12.6 Signed-out experience and the form kit (amendment A10, owner 2026-09-02)

Owner: "password reset, login, signup, onboarding and data entry need better
UI/UX with modern libraries; notices, submit actions and notifications wired
properly." Decisions:

- **Form kit** (`apps/web/src/components/form/form.tsx`): react-hook-form +
  zod (v4) over the existing `.input` / `.btn` styles. `useZodForm`,
  `Form` (server errors land in the root error), `TextField`, `SelectField`,
  `PasswordField` (show/hide, strength meter), `SubmitButton` (pending
  spinner), `FormAlert`, `FormRootError`. Fields own their label (screen
  readers and `getByLabel` keep working), validate on blur then on change,
  and show one inline error each. New data-entry screens use this kit;
  existing ones move over as they are touched.
- **Signed-out shell** (`components/auth/auth-shell.tsx`): brand mark over a
  soft gradient, one card, footer. `AuthCard` (title, context line, links)
  and `AuthOutcome` (finished-state panel: check your email / done / that
  link failed) give every flow the same start and end.
- **Flows**: login (friendly error copy, unverified-email alert with Resend,
  2FA challenge with backup-code fallback, `?next=` / `?email=` /
  `?reset=1` / `?verified=1` handling); signup (strength meter, "Check your
  email" outcome with Resend, plus a Continue button when verification is
  off and the account is already signed in); reset (request → outcome with
  Send again; token → new + confirm password → outcome with Sign in;
  expired link → Request a new one); verify (success or `?error=` outcome);
  accept-invite (password + confirm, outcome linking to sign-in with the
  email prefilled); 2FA enrolment (copy secret, backup codes grid, outcome).
  Every success also toasts.
- **Onboarding** (`/welcome`): same shell; business picker as a choice
  list; create-business form on the kit with a 3-step stepper, live slug,
  409 → inline "slug is taken", toast + /dashboard on success.
- Error copy comes from `lib/auth-errors.ts` (better-auth codes → sentences;
  429 → "Too many attempts").

### 12.7 Date range picker everywhere (amendment A11, owner 2026-09-02)

One shared Shopify-style picker (`components/date-range-picker.tsx`,
`lib/date-range.ts`) on every screen that scopes data by date: a button
reading "Last 7 days · Aug 27 – Sep 2, 2026" opens presets (Today,
Yesterday, Last N days/weeks/months with "include today", period to date,
previous week/month/quarter/year, calendar quarters, custom) beside a
two-month calendar with drag-to-select, and Cancel / Apply. Ranges are
inclusive `YYYY-MM-DD` and live in the URL (`?range=last30` or
`?start&end`), so a view can be bookmarked and reloaded. A page may carry
several pickers, each keyed (`salespeople.range`, `digest.range`, …) so a
section keeps its own window ("individual time filters on certain data").

Wired: Reports (all range reports + CSV), Salespeople, salesperson activity
(completed / canceled window), customer activity (open A/R), Audit (since /
until, "All time"), home dashboard revenue trend, Operations (money + by
store, plus the salesperson card's own window), Exceptions digest, Orders
and Sales lists ("All time" default, created date). API: `start` / `end`
on `/v1/dashboard/operations`, `/operations/salespeople`,
`/v1/exceptions/digest`, `/v1/orders`, `/v1/orders/list-view`, `/v1/sales`
(`apps/api/src/common/date-range.ts`; a malformed window is ignored, never
a 400). Ops summary day bounds are store-local; lists use UTC days like the
reports.

## 13. Explicit v1 Exclusions (do not build)

Barcode scanning · bundle/kit pricing · MSRP display · coupon-code validation ·
product images/warranty docs at POS · serial tracking · auto-created POs · landed
cost · restocking fees · comfort-exchange enforcement · in-house financing · credit
holds · per-category commission rates · approval queues (dashboard visibility
instead) · automated customer email/SMS · driver mobile app · white-glove
itemization beyond the $0 Removal line · signature capture at POS · dark mode.

### 12.8 Report Cash Drawer Balancing Totals (amendment A12, owner 2026-09-02)

Owner ask (STORIS AR.317 parameter screen + sample output): "create this too".

- **Endpoint** `GET /v1/reports/cash-drawer-balancing` (`reports.sales.view`,
  selling scope): `start`/`end` (balance date, default today), `startTime`/
  `endTime` (HH:MM in the store's timezone, ending time inclusive to the
  minute, default 00:00–23:59), `balanceBy=drawer|operator|store` (default
  store), `locationId`, `operatorId` (user), `drawerId` (shift id or its
  8-character drawer number), `drawerState=all|balanced|unbalanced`,
  `format=csv|pdf|txt`.
- **Register** (the STORIS body): every succeeded payment in the window,
  grouped Balance-By group → pay class (1 CASH, 2 CHECK, 3 CREDIT, 4
  FINANCING, 5 GIFT CARD, 6 STORE CREDIT, 9 OTHER) → payment type (method,
  plus processor / financing provider), with customer code + name, reference
  (document number, linked), gift cert. / check no. / processor ref, amount,
  reference subtotal (all money on that document in the window), time,
  drawer number, operator initials; subtotals at each level, group total,
  grand total.
- **Cash Drawer Reconciliation** per group and grand: CASH, CHECK, Total
  Deposit (= cash + check).
- **Drawer counts** per group: the shifts under that heading (float,
  expected, counted, over/short, in-tolerance against
  `ops.cashBalancing.toleranceCents`).
- **Mapping decisions**: a drawer is a cash shift; a payment belongs to the
  shift open at its store when it was taken (the operator's own shift when
  several are open); operator = register-sale associate or order
  salesperson; "Balanced drawer reference" = closed (counted) drawers,
  "UnBalanced" = still open or no drawer. Imported legacy documents are
  excluded (D8). Refunds are not attributed to a tender and stay off this
  register (the Z-report carries them).
- **UI** `/reports/cash-drawer-balancing`, linked from Reports: the STORIS
  parameter card (date range picker, starting/ending time, Balance By,
  store, operator, drawer, drawer reference), Run, Print, PDF, Export CSV;
  URL carries the parameters.
- **Basic PDF / text output** (owner 2026-09-10, from the real AR.317
  spool `REPORT_CASH_DRAWER_BALANCING_TOTALS_OUTPUT_3.pdf`): `format=pdf`
  is the STORIS "S Basic PDF" — Courier 9pt landscape, 132 columns, the
  two-line page header (`Reference: AR.317.RPT`, the `-=- <business> -=-`
  banner, clock in the store's timezone; `As of Date`, title, `Page: n`)
  and two-line column header on every page, `Store 02 - NAME` / `Pay Class
3 - CREDIT` / `Payment Type …` headings, the tender line at the STORIS
  columns (code 0, name 13, reference 42, tender 59, amount →89, subtotal
  →100, time 101, drawer 109, init 120), `Total For Payment Type` / `Pay
Class` / `Store|Operator|Drawer` / `Grand Total  :` right-aligned at
  78/89, the Cash Drawer Reconciliation block at column 42, and a closing
  page echoing the parameters (`Balance By: S`, `Store: 02`, `Bal Drawer
Ref: All`, …). `format=txt` is the same pages form-feed separated. The
  writer (`apps/api/src/reports/text-pdf.ts`) is dependency-free and
  mirrors the STORIS file structure so the two spools diff during the
  parallel run. Mgr and Batch print blank (no manager override / deposit
  batch in Jetnine); card brand is not captured, so STORIS's AMEX / MC /
  VISA payment types collapse to `CARD - <processor>`.
- **Codes**: Customer Code is the STORIS customer number when the customer
  came over in the migration (`legacy_refs` entity `customer` whose import
  batch is STORIS-sourced — Shopify / WooCommerce / Wix connector refs are
  not STORIS numbers), else the first 8 characters of the Jetnine id; Store code is the location's order
  prefix (`02`); the JSON carries `group.code` and `filters.locationCode /
locationName / operatorName` for the echoes.
- Tests: `cash-drawer-balancing.int.spec.ts` (8),
  `cash-drawer-balancing.text.spec.ts` (5, byte-for-byte against the STORIS
  header and register lines), `text-pdf.spec.ts` (3).

### 12.9 Report Written Sales Dollars (amendment A13, owner 2026-09-02)

Owner ask (STORIS TE.320 parameter screen + sample output): "We also need
this built".

- **Endpoint** `GET /v1/reports/written-sales` (`reports.sales.view`,
  selling scope): `start`/`end` (written date in the store's timezone,
  default today), `locationId` (one, repeated, or comma-separated — the
  STORIS multi-store picker), `orderType=both|orders|adjustments`,
  `reportType=detail|summary`, `includeAuditComments` (default off),
  `includeAllSalespeople` (default on), `includeAddress` (default on),
  `format=csv`.
- **Body** (the STORIS layout): location → type → order → line. Lines carry
  qty, product number (variant SKU), description, merch amount, gross
  profit, profit %, entered-by initials; each order carries number, written
  date + time, customer code + name, salespeople initials, marketing code,
  ship-to address (order address, else the customer's first address) and
  the footer columns charges (delivery + install), customer discount
  (order-level), misc fee charge (other fee), sales tax, total order.
  Totals per order, type, location and grand (profit % recomputed at each
  level).
- **Types**: "New Transactions excluding Layaway" (sales orders),
  "Layaway" (order kind layaway), "Register Sales" (POS cash-and-carry
  sales — Jetnine's register has no STORIS equivalent, so it is its own
  type), "ADJUSTMENT".
- **Adjustments** = money that moved in the window on documents written
  before it: price adjustments granted in the window (audit
  `order.price_adjustment`, negative merch, reason shown), cancellations in
  the window of earlier orders (the whole order comes back out, cost
  included), and lines added in the window to earlier orders (a line
  stamped a minute or more after its order). Line edits and removals are
  not tracked as deltas today and stay off the register.
- **Gross profit** is cost-derived (variant cost × qty) and only present
  with `reports.financial.view`; otherwise every profit cell is null and
  the page says so. Quotes, drafts, cancelled-at-write and imported legacy
  documents are never written sales.
- **UI** `/reports/written-sales`, linked from Reports: the STORIS parameter
  card (date range picker, multi-select store, Order Type / Report Type
  radios, the three include checkboxes), Run, Print, Export CSV; URL
  carries the parameters.
- Tests: `written-sales.int.spec.ts` (6).

### 12.10 Advanced Vendor Settings (amendment A14, owner 2026-09-02)

Owner ask (STORIS Advanced Vendor Settings screenshots — General, Shipping,
PO Cutting Date, Auto PO Replen): "we also need an Advanced Vendor Settings".

- **Page** `/vendors/:id/settings` (vendor name and a Settings link on the
  Vendors list; `?tab=` deep links), four tabs that each save on their own.
- **General**: the vendor master (name, contact, email, phone, remit-to,
  notes, active) plus the purchasing defaults that already lived in the
  replenishment document — minimum stock days, lead days, default requested
  date on POs.
- **Shipping** (`vendors.landed_cost_json`, `PATCH /v1/vendors/:id/shipping`):
  five landed-cost lines exactly as STORIS lays them out — Landed Freight
  (percent | dollar), Import Fee, Misc. Fee and two custom lines (percent |
  dollar | calculate, custom lines carry a label). Active percent/dollar
  lines are summed into a new PO's freight when the caller does not send
  one (landed cost lean, Q1: one whole-PO amount spread per unit at
  receipt); "calculate" lines are entered from the vendor invoice. Applies
  to manual POs and to sales-rate replenishment POs.
- **PO Cutting Date** (new tenant table `vendor_po_cutting_dates`, unique
  per vendor + collection, `PUT /v1/vendors/:id/po-cutting-dates` replaces
  the list): the STORIS "Collection Exceptions" grid — collection code,
  description/notes, PO cutting date. Past the date (strictly before
  today), PO creation and placement refuse lines from that collection with
  a message naming it, and replenishment drops those lines (noted on the
  PO). Another vendor's POs are not affected.
- **Auto PO Replen** (the replenishment document, `PATCH
/v1/purchasing/replenishment/vendors/:id/settings`): the STORIS fields —
  Generate Automatic POs, Automatically Hold POs, Weekly Sales Rate
  Calculation, Include All Back Orders, Days For Replenishment, **First /
  Second Average Units Period** (new, 1–156 weeks, defaults 4 / 12), Variance
  Starting / Ending Date, Variance Percentage, Minimum Sales Rate, Build POs
  (weekday checkboxes), **Sort Criteria** (new: vendor model | product |
  category | group). Sort criteria orders the replenishment grid and the PO
  lines it writes; "group" sorts by category (Jetnine has no product
  groups). The average-units periods are stored and returned; the grid's
  average-units columns are follow-up work.
- Read model: `GET /v1/vendors/:id/advanced-settings` returns all four tabs
  plus the collection picker (the vendor's own collections first).
- Tests: `vendor-settings.int.spec.ts` (6); `purchasing.int.spec.ts` still
  green.

### 12.11 Layout contract — screen-by-screen design pass (amendment A15, owner 2026-09-02)

Owner ask: "run a workflow and focus on every screen and every element
individually. The heading placement in different sections isn't margined
properly either."

- **Contract** (`apps/web/src/app/globals.css` "Layout contract" block +
  `components/ui.tsx`): one spacing scale (4 / 8 / 12 / 16 / 24 / 32 as
  `--space-1..6`), and primitives that own every margin — `PageHeader`
  (eyebrow / title / meta / sub / actions, 24px below), `BackLink`,
  `Breadcrumbs`, `SectionHeading` (h2 15px, h3 13px, fixed rhythm),
  `Stack` (16 / 8 / 24 gaps), `Toolbar`, `FormGrid` / `FormActions`,
  `StatGrid` / `StatTile`, `TableWrap` / `TableEmpty`, `KeyValue`, `Alert`.
  Pages never write `marginTop` / `marginBottom` / `mt-*` / `mb-*` on cards,
  headings, toolbars or forms.
- **Pass**: 117 web files — every business, POS, auth, print, super-admin
  and public screen — rebuilt on the primitives: hand-rolled titles, back
  links and subtitle paragraphs folded into `PageHeader`; inline-styled
  `h2`/`h3` replaced by `SectionHeading`; card spacing via `Stack`; filter
  rows via `Toolbar`; forms via `FormGrid` / `FormActions`; bespoke stat
  tiles via `StatTile`; raw tables wrapped in `TableWrap`; inline colour /
  weight styles replaced by token classes. Data-testids, labels and
  behaviour unchanged.
- **Verification**: typecheck, lint, web unit tests; the full Playwright
  suite (auth, orders, operations, my-day, warehouse, sweep, PO specs) —
  one spec updated for a renamed link ("open the order" → "Open order").

### 12.12 Catalog replacement from the STORIS Active Inventory export (amendment A16, owner 2026-09-03)

Owner ask: "replace all of the current Products in the ERP with these
Products. Include the Group, SKU, Brands, Category, Replacement Cost,
Vendor, Product Description … Match the products that are on sales orders
with the new Products List." Decisions (owner answers, 2026-09-03):

- **Stores**: 01 = 201 Western, 02 = West LA, 03 = Hancock Park / La Brea,
  04 = Studio City, 88 = Warehouse. Codes 05, 06, 08, 09, 10, 11, 12 do not
  exist — their stock rows are dropped; their SKUs still become products.
- **Replace** = every product the file does not name is **deleted** when
  nothing outside the stock ledger references it, and **deactivated**
  (product + variants) when sales, purchasing, returns, as-is, write-off,
  serial, count or transfer history does. The foreign keys are discovered
  from `pg_catalog` at run time so a new history table can never be
  missed. Order and sale lines keep their variant links; their written
  description and price are untouched.
- **Stock**: ON_HAND = Stock + Quantity As-Is (Jetnine counts as-is pieces
  in on hand), AS_IS becomes that many import-sourced as-is pieces
  (reconciled on re-import while still pending review), MIN_STOCK is the
  store's reorder point (new `inventory_levels.reorder_point`, migration 0086) and rolls up into the variant's reorder point as the sum across
  stores (REPL-040 sums availability the same way).
- **No selling price**: existing SKUs keep their price, new SKUs land at $0
  (D12). **Vendors** are created under the STORIS codes. **Group** (QUEEN,
  CAKING, QUFND, …) is the variant's `group` attribute, not a category;
  **Catg** is the category; **Brand** is the brand (created on the fly).
- **Pipeline**: the existing import wizard (Settings → Import). Product
  spec gains `brand` and `group` columns (category headers are now
  CATEGORY / CAT / CATG — GROUP no longer maps to category); inventory spec
  gains `asIsQty` and `reorderPoint`; store names match tolerantly (exact,
  order prefix, unique contains-match on letters and digits). Commit takes
  `{ replaceCatalog: true }` (checkbox on the product entity) and returns
  `{ kept, deleted, deactivated }`.
- **Files**: `docs/scripts/convert-active-inventory.py` turns the export
  into `products.csv` (1,948 SKUs) and `inventory.csv` (3,246 SKU@store
  rows); both are committed under `docs/imports/2026-09-03/`.
- **Run order**: products.csv as entity _product_ with "Replace catalog"
  ticked, then inventory.csv as entity _inventory_. Both are idempotent.
- Tests: `import.int.spec.ts` gains three cases (brand / category / group /
  vendor / cost; tolerant stores, as-is pieces and per-store minimum
  stock; replace deletes vs deactivates and keeps order links).

### 12.13 Dashboard redesign — shell and role homes (amendment A17, owner 2026-09-04)

Owner hand-off: the Claude Design project "LA Mattress ERP dashboard
redesign" (`LA Mattress ERP.dc.html` + `support.js`; module files for
Sell / Deliveries / Aftersale / Catalog / Purchasing / Transfers / People /
Insights / Admin / Staff are follow-ups). Implemented as the primary file
specifies:

- **Tokens**: neutral grays with one green accent (oklch 155), Geist +
  Geist Mono, 13px base, 9px cards / 6px controls; light and dark
  (`html[data-theme]`) and Cozy / Compact density (`html[data-density]`),
  both per browser (`lib/ui-prefs.ts`, stamped before first paint). The
  pre-redesign token names stay as aliases so every existing screen picks
  up the palette; primary buttons are ink-on-paper.
- **Shell** (`components/app-shell.tsx` + `components/shell/*`): 220px
  paper sidebar with dot-marked nav groups, live counts (open orders,
  past-promise, open exceptions, today's trucks from
  `GET /v1/dashboard/nav-counts`) and a sync footer (online state + queued
  offline sales); 50px topbar with the ⌘K palette (orders, customers,
  receipts, pages, New sale), the dashboard's store scope / period /
  compare-to controls, the notifications bell + drawer (per-browser read
  marker over `/v1/notifications`), New sale (N) and the account menu
  (selling store, theme, density, sign out with "also my other devices").
  Shortcuts: ⌘K ? n t p [ ] g-o/d/i/c/r/h Esc. Owners get a role switch
  (Owner / Manager / Operations / Warehouse) to preview every home; other
  members keep their fixed home. `members/me` now returns `roleName`.
- **Owner home** (`dashboard/owner/*`): KPI strip (Written, Register,
  Refunds, Open orders, Receivables, Trucks today) and the stacked
  written-business chart with a dashed comparison line from
  `GET /v1/dashboard/owner?start&end&compare&locationIds`; morning brief
  from `/v1/dashboard/morning`; the orders table from
  `GET /v1/dashboard/owner/orders` (saved views, filter chips with counts,
  search, column toggles, sort, bulk select + CSV, paging); low stock;
  order changes; per-browser card order / hide ("Customize"); an order
  quick-view modal. "Written" = orders created in the window (not
  draft/quote/cancelled), "Register" = completed POS sales, imported
  history excluded (D8); receivables match the AR report.
- **Manager / Operations / Warehouse homes** restructured to the design's
  sections on the shared kit (`owner-kit.tsx`: KPI strip, panel, status
  pill, mono money) with their data and test ids unchanged; the ops feed
  "Clear selected" now confirms first.
- Tests: `owner-dashboard.int.spec.ts` (7, CI db `jetnine_owner_dashboard`);
  the Playwright suite runs against the new shell.
- Deferred (separate design files): the routed module screens, the Staff
  module (schedule / time clock / timesheets — see
  `docs/PROPOSAL-staff-schedule.md`), the sign-in previews.

### 12.14 Shopify listings cleanup (amendment A18, owner 2026-09-06)

Owner ask: "for the products I need to come up with a plan to remove the ones that
was imported from shopify. they are the products that have lowercase letters in them.
also need to see which sales used the wrong products when they added the items and
change them … give me a sheet with proposed change in the sales and i can confirm."

- **Identification rule (owner's):** a product is a Shopify listing when its name
  contains a lowercase letter (STORIS names are all upper-case) or its whole import
  history is a connector batch (`import_batches.source` in shopify / woocommerce /
  wix, read through `import_rows` — `legacy_refs.source` is last-writer and lies for
  shared SKUs). Both reasons are reported per row.
- **Crosswalk:** each Shopify listing is scored against the active STORIS listings
  of the same size (size from the variant `group` attribute or the name; a Queen is
  never proposed for a Cal King), by the share of its model words found in the
  STORIS name / SKU, with firmness agreement and brand as nudges. A case-insensitive
  SKU equality is certain. Top three alternates are shown; a proposal is pre-filled
  at ≥ 50%.
- **Surfaces:** `GET /v1/products/cleanup/shopify` (report), `…/shopify.csv?sheet=
lines|products` (review sheets with `confirm` / `override_sku` / `adjust_stock`
  columns), `POST …/shopify/apply` (`products.merge`, Owner + Manager; `dryRun`).
  Page `/products/cleanup` ("Shopify cleanup" on Products): confirm on the page or
  upload the filled sheet, preview (dry run), apply.
- **Relink semantics:** a sale or order line moves to the chosen variant and takes
  its description; price and totals never change. Refund / return lines on the
  line follow. An open order's reservation moves with it (delta-0 movements, as the
  order flow writes). "Move stock" (per line, pre-checked for register documents
  dated after the last committed inventory import) hands the sold units back to the
  Shopify SKU and takes them off the STORIS SKU as `adjustment` movements with
  `reference_type = 'listing_relink'` pointing at the line. Imported (D8) documents
  never move stock. Lines with picked serial units are refused until released.
  Every relink is an audit entry (`sale_line.relink` / `order_line.relink`,
  before/after with SKUs).
- **Retire semantics:** deactivate keeps every document; delete is refused while the
  listing is referenced by any line table (sale, order, refund, return, PO, transfer,
  as-is, write-off, serial, service, count) and removes the product's `legacy_refs`
  so a later import cannot resurrect it.
- **Stock on Shopify listings is never kept (owner 2026-09-06).** Retiring a listing
  either way first zeroes its `inventory_levels` (on hand and reserved) with an
  `adjustment` movement, `reference_type = 'listing_retire'` pointing at the product;
  stock never blocks a delete. The relink's "Move stock" takes the sold units off the
  STORIS SKU only — nothing goes back onto the Shopify SKU.
- **Prices the Shopify sync wrote are not kept (owner 2026-09-06; answers lockdown
  plan Q2).** STORIS listings that a connector batch also wrote (shared SKUs) carry
  Shopify's price. The report lists them (`shopifyPriced`); `apply { resetPrices }`
  sets those variants back to $0 (D12: priced at the register or on Set prices),
  audit `product_variant.price.reset`. Sale lines keep what was charged.
- **Not done here (still owner decisions, see `docs/HANDOFF-catalog-source-lockdown.md`):**
  turning the Shopify product sync off (B1) and the import-lookup hardening (B2).
  Until the connector is disconnected, "Sync now" recreates the listings.

### 12.15 Products absorbs Inventory — STORIS product screens (amendment A19, owner 2026-09-10)

Owner ask: "we can merge Products/Inventory into only Products. When you first enter
into products the rows must be displayed like [the STORIS product browser]. After
entering into a product the display must include what the rest of the images from
STORIS contain" — Advanced Product Settings (Descriptive, Purchase Status, Packing)
and View Product Activity (Inventory Quantities, Merchandising, Location Availability).

- **One section.** The Inventory nav entry goes; its screens live under Products as a
  tab strip: `/products` (browser), `/products/stock` (the former `/inventory` — stock
  by location, bins, reservations, adjust, floor samples), `/products/counts`,
  `/products/receive`. `/inventory*` redirects permanently. `g i` jumps to Stock by
  location. Products renders at the wide content width.
- **Browser columns (the STORIS strip):** Product · Vendor model · Vendor · Description
  · On hand · Available · Net on PO · Sales margin cost · As-Is on hand · As-Is
  available · Price · Status · As-Is non-sellable · Product group · Brand, with a
  Location picker (All locations, or one store — every stock column narrows to it).
  Rows open the product. `GET /v1/products` returns them (`locationId` query);
  the search branch carries the same columns. Cost is null without
  `products.cost.view`.
- **Inactive products are hidden by default (owner 2026-09-10).** `GET /v1/products`
  lists only `is_active` products unless `includeInactive=1`; the browser's "Show
  inactive" tick turns them back on, and the empty state says so. The catalog replace
  retired 733 listings and they crowded out the live ones. (The same call fixed a
  latent precedence bug: the search predicate's `… @@ tsq OR EXISTS (variant match)`
  was unparenthesised inside `and()`, so a variant match slipped a row past the
  vendor, category — and now active — filters.)
- **Definitions (the ones the register, replenishment and reports already use):**
  available = Σ max(0, on hand − reserved − floor sample) per level; net on PO =
  Σ (ordered − accepted − rejected) over live, non-direct-ship purchase orders in
  `ordered` / `partially_received` (drafts are not on order), total PO = Σ ordered on
  the same; as-is on hand = pieces still in review (`pending_review` — restocked ones
  are ordinary stock, vendor returns and scrap are gone), as-is non-sellable = those in
  condition `damaged` or `parts`, as-is available = the rest; layaway reserved =
  `qty_reserved` on open layaway order lines at the line's stock location. Code:
  `apps/api/src/catalog/product-stock.ts`.
- **Product page:** header shows Product number, second description, vendor and brand
  names, product status and (when not active) purchase status. Then: Inventory
  Quantities tiles (On hand, Net available with reserved / floor, As-Is, As-Is
  available with non-sellable, Net PO, Total PO); Merchandising (selling price, sales
  margin cost, purchase status, product status, layaway reserved); Descriptive
  (Description = `name`, Second description, Brand, Vendor model = variant
  `vendor_sku`, Vendor = preferred vendor, Group = variant `group` attribute,
  Category); Location availability — one row per active variant per active location,
  zeros included, with Adjust and Floor sample (the Stock by location endpoints) and
  the reserved count linking to the reservations drill-down; Purchase status &
  packing. The existing Tax class, Brand & collection, Variants, Reorder automation
  and Images cards stay below.
- **New product fields** (`products`, migration `0089_product_storis_fields`):
  `second_description`, `purchase_status` (`active` | `discontinued` |
  `special_order` | `closeout`, `PRODUCT_PURCHASE_STATUSES` in `@jetnine/shared`;
  independent of `is_active`, which stays the selling switch), `boxes_per_product`,
  `logistical_carton_qty`, `purchase_carton_qty` (whole numbers ≥ 1),
  `logistical_carton_transfers`. `GET /v1/products/:id` returns them plus
  `brandName`, `categoryName`, `vendorName`, `vendorModel`, `group`, `serialTracked`
  and `stock { totals, byLocation }`; `PATCH /v1/products/:id` (`products.update`)
  accepts them, validates, and audits before/after as `product.update`.
- **Not modelled (STORIS fields with no ERP counterpart yet):** Available-to-Promise
  date / quantity by desired quantity (no lead-time engine — Net PO and the PO's
  expected date on Purchasing stand in), Suggested retail price, inventory type,
  as-is reserved. Purchase status is informational for now: it does not yet block a
  purchase order line.
- Tests: `product-stock.int.spec.ts` (8, CI db `jetnine_product_stock`); the
  Playwright orders flow reaches the stock table through the `/inventory` redirect.

**Amendment (owner 2026-09-11) — browser columns the user arranges:** the
Products browser's header row is the control surface. Drag a column header
to put the columns in any order (kept per browser in localStorage under
`jetnine.products.columns`; "Reset columns" restores the STORIS order).
Click a header to sort the list by that column, click again to flip; the
sort lives in the URL (`?sort=&dir=`) like the orders list. Sorting is
server-side so every page follows it: `GET /v1/products?sort=<column>&dir=`
materialises the matching products (first 5,000 by name), sorts the
finished rows (text case-insensitively with blanks last, numbers
numerically, a hidden cost as blank) and pages by offset; unsorted browsing
keeps its keyset cursor.

### 12.16 Enter a Sales Order — every STORIS section and action (amendment A20, owner 2026-09-10)

Owner ask (four STORIS screenshots — the empty and filled "Enter a Sales
Order" screen with its Step 1–4 sidebar, and both Actions menus): "In orders
tab we need all of these."

**Where they live.** A3 stands: the order stays one screen. The STORIS step
names become the section order of the order page (Customer → Merchandise →
Fulfillment → Payment), and the two STORIS Actions menus become one
**Actions ▾** menu in the order-page header, grouped Order · Customer ·
Merchandise · Documents. A line-scoped action asks for the line inside its
dialog. Every item below is either mapped to something that exists, built,
or scheduled; nothing on the list is dropped.

**Step 1 — Customer (header card + Customer card)**

| STORIS                                                                                            | Jetnine                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order Number (search / +)                                                                         | Order number, `STORIS #` legacy number; the orders list is the search                                                                             |
| Order Type                                                                                        | Sales order / Layaway / Sales quote / Exchange (§3); quote → order on the page                                                                    |
| Date                                                                                              | Written date (`createdAt`); no backdating (deferred 2026-08-25)                                                                                   |
| Salesperson (+ 2nd, split)                                                                        | Editable on the page (was writer-only)                                                                                                            |
| Fulfillment Method                                                                                | Editable on the page                                                                                                                              |
| Store                                                                                             | Selling location (read-only after write); fulfill-from location editable                                                                          |
| Customer Number or Last Name or Email or Phone                                                    | Universal customer search (writer); Change customer on the page                                                                                   |
| Billing: Primary Name, Primary Email, Home / Cell / Work phone + Ext, Address 1/2, City State Zip | Customer record edit from the order (`Enter Customer Name`, `Update a Customer Address`); customers gain `work_phone` + `work_phone_ext`          |
| Marketing Code 1 / 2                                                                              | `marketing_code` (existing column, now on the page) + new `marketing_code_2`; both pick from the `ops.marketingCodes` list with free text allowed |

**Step 2 — Merchandise (Lines card)**: exists (add product with vendor / size /
firmness / stock filters, qty, price override, line discount, per-line
fulfillment incl. Direct Ship, per-line source, stock + PO state, split
orders, fee lines). Lines gain: `comment` (prints on documents), `room`,
`pieces`, `prep_codes[]` (from `ops.prepCodes`), `com_json` (Customer's Own
Material: flag + description), `direct_ship_json` (vendor, vendor order
ref, tracking, expected date), `needs_install`, description override.

**Step 3 — Fulfillment**: exists (Deliveries & fulfillment card: book,
reschedule, capacity, pickup hand-over; per-line delivery date; split
tickets).

**Step 4 — Payment**

| STORIS               | Jetnine                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Discounts            | Per-line discounts (exists) + **Enter a Discount on Multiple Lines**                                                                     |
| Additional Discounts | Order discount (exists, now editable on the page) + discount codes on orders (phase 2, D7)                                               |
| Protection Plans     | Phase 2 (D8)                                                                                                                             |
| Charges and Fees     | **Miscellaneous Fees** dialog: delivery, installation, other fee (label + amount); recycling / removal / declined-foundation lines exist |
| Payments             | Exists (nine tenders + store credit)                                                                                                     |
| Deposits             | Deposit required editable on the page; deposit payments exist                                                                            |
| Financing            | Payment form gains provider + reference (Synchrony / Acima; API already carried them). In-house financing stays excluded (§13)           |
| Signature            | Phase 3 (D9) — reverses the §13 / §4 "no signature at POS" exclusion by this ask; flagged for veto                                       |
| Totals               | Money card (exists)                                                                                                                      |
| Receivables          | New Receivables section: balance due, deposit required vs paid, plan installments due / overdue, days outstanding                        |

**Actions ▾ (both STORIS menus, merged)**

| STORIS action                                                                             | Jetnine                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additional Order Detail                                                                   | Order header dialog: order type, fulfillment, fulfill-from, salespeople + split, requested date, delivery status, pickup location, delivery instructions, marketing codes, order source, payment terminal, printed notes                                  |
| Additional Comments                                                                       | Internal notes editor (never printed)                                                                                                                                                                                                                     |
| Audit Comments Log                                                                        | Change history + Notes cards (anchor)                                                                                                                                                                                                                     |
| Miscellaneous Fees                                                                        | Fees dialog (above)                                                                                                                                                                                                                                       |
| Order Source Entry                                                                        | `order_source` from `ops.orderSources` (Walk-in, Phone, Web, Referral, …) with free text                                                                                                                                                                  |
| Order Tax Information                                                                     | Dialog: store rate, per-line tax class / rate / taxable amount / tax, order tax; the tax-exempt question stays an open [DECIDE]                                                                                                                           |
| Print Order / Print Cumulative Sales Order                                                | Invoice `?scope=order` (this piece alone) / `?scope=family` (the split family, today's default per the 2026-08-31 amendment)                                                                                                                              |
| Add / Edit / View Attachments                                                             | `order_attachments` (order- or line-scoped; PDF, images, office docs; ≤ 5 MB each; bytes stored in Postgres, served through the API with auth); paperclip count in the header                                                                             |
| Assign Payment Terminal                                                                   | `payment_terminal` label from `ops.paymentTerminals` (which reader took the card). Stripe Terminal readers stay the Day 1 Ops item                                                                                                                        |
| Custom Order Information                                                                  | `custom_info_json` — label / value rows (fabric, dimensions, monogram, …) printed on the invoice                                                                                                                                                          |
| Enter Customer Name · Update a Customer Address                                           | Customer edit dialog (name, email, phones, billing address) + order ship-to edit                                                                                                                                                                          |
| Trade / Designer Information                                                              | `trade_designer_json` — name, company, phone, email, note. Trade pricing tiers stay the open [DECIDE]                                                                                                                                                     |
| View Signature                                                                            | Phase 3 with D9                                                                                                                                                                                                                                           |
| Advanced Line Item Display · Toggle Line Display                                          | Compact ↔ advanced lines toggle (advanced adds SKU, source, tax rate, reserved, room, pieces, prep codes, comment, COM, install)                                                                                                                          |
| Additional Line Item Details                                                              | Line details dialog (description, comment, room, pieces, prep codes, COM, direct-ship details, installation)                                                                                                                                              |
| Assign Rooms to Order · Assign Pieces                                                     | Line details: room, pieces (pieces per unit — delivery capacity, day load and booking count `quantity × pieces`; §13 serial tracking still excluded)                                                                                                      |
| Convert Line to Direct Ship · Direct Ship Details                                         | Line type select (exists) + direct-ship details in the line dialog                                                                                                                                                                                        |
| Costed Line Item Display · Sales Margin Scratchpad                                        | Cost / margin / margin % columns and a target-margin → price calculator, gated by `products.cost.view`                                                                                                                                                    |
| Customer's Own Material (COM)                                                             | Line details: COM flag + description; a COM line is $0 merchandise the customer supplies                                                                                                                                                                  |
| Enter a Discount on Multiple Lines · Group Pricing                                        | One dialog: pick lines, $ per line or % of price; writes line discounts through the G6/A10 price monitor (logged against list, never blocked)                                                                                                             |
| Extended Warranty Detail · Protection Plan Selection                                      | Phase 2 (D8): `protection_plans` catalog (name, term, price or % of covered price) sold as a line linked to the covered line                                                                                                                              |
| Line Comments                                                                             | Line details: comment — prints under the line on the invoice, delivery ticket and pick list (room, pieces, prep codes, install and COM print on the truck's documents)                                                                                    |
| Line Item Linked Document Display                                                         | Per-line dialog: PO, deliveries, transfers, RMAs, exchange orders                                                                                                                                                                                         |
| Line Stock Availability                                                                   | Per-location on hand / reserved / available for the line's variant                                                                                                                                                                                        |
| Maintain Linked Installation Line                                                         | Installation stays the order-level fee; `needs_install` marks the lines it covers (prints on the delivery ticket)                                                                                                                                         |
| Prep Codes                                                                                | Line details: prep codes from `ops.prepCodes`                                                                                                                                                                                                             |
| Price / Spiff / Commission Table                                                          | Projected the way accrual works (§9): order total — minus catalog cost on a margin plan — split by share at the plan rate, spread over the merchandise lines; margin-plan figures need `products.cost.view`; spiffs are not modeled — the column prints — |
| Product Benefit Inquiry                                                                   | Product card dialog: brand, description, attributes, warranty text from the catalog                                                                                                                                                                       |
| Purchase Order                                                                            | Opens the line's PO; a special-order / direct-ship line without one opens the to-order queue (Generate PO lives there)                                                                                                                                    |
| Remove All Price Overrides and Discounts                                                  | Restores the catalog price on every variant line and zeroes every discount (order + lines); audited                                                                                                                                                       |
| Split Merchandise Lines                                                                   | Order split (exists) + split one line's quantity into two lines — refused while the line is allocated to a PO or on a scheduled delivery                                                                                                                  |
| View Discount Schedule Applied to this Order · Start / Suspend Automated Line Discounting | Phase 2 (D7): a discount code applied to the order is the schedule; Start / Suspend toggles it. Until then the actions open View Order Discounts                                                                                                          |
| View Linked Transfers                                                                     | Transfers whose `order_id` is this order (auto transfers for shortfalls)                                                                                                                                                                                  |
| View Order Discounts                                                                      | Dialog: order discount, every line discount, applied code                                                                                                                                                                                                 |
| View / Edit Exception Comments                                                            | `exception_notes` on the order; the exception register shows them on the order's rows                                                                                                                                                                     |

**Decisions**

- D1 Single screen + one Actions menu (above).
- D2 Settings lists (`ops.marketingCodes`, `ops.orderSources`,
  `ops.prepCodes`, `ops.rooms`, `ops.paymentTerminals`) are admin-edited
  string lists; the pickers accept free text so a missing entry never
  blocks a sale.
- D3 Attachments live in Postgres (no object store is provisioned); 5 MB
  per file, 25 files per order.
- D4 Costed display and the scratchpad are hidden without
  `products.cost.view`.
- D5 Phase 2 = protection plans + discount codes on orders. Phase 3 =
  signature capture (reverses a §13 exclusion — owner to confirm).
- D6 Nothing here changes order money rules: derived balances stay
  derived, price changes still pass the G6 variance controls.

Build order: schema + settings lists → order/line fields + attachments API →
Actions menu + dialogs → Step-1 header card, Receivables, financing fields
→ tests + docs; then phase 2, then phase 3.

Tests: `order-actions.int.spec.ts` (5 — header + line fields, attachments
within limits, multi-line discount + split + remove overrides, the six
reads, customer work phone).

### 12.3 Cashier dashboard — "My Day" (amendment A7, owner 2026-09-01)

Fixed by role, like Operations and Warehouse: `cashier.dashboard.view` is the
door (Owner/Manager inherit it and reach `/my-day` from the nav); the Cashier
role's `/dashboard` swaps to this home. Login still lands on New Sale, and the
page keeps New Sale one click away in its header. `GET /v1/dashboard/my-day`
(`?locationId=` picks the store; the first non-warehouse store leads).

"Mine" keys on the signed-in membership for orders (primary or second
salesperson, split-attributed) and on the user for register sales, returns,
exchanges and shifts. Store-level cards follow the picked store. Money rules as
everywhere: imported legacy rows excluded (D8), balance due computed from the
payment ledger, never stored.

| #   | Card                     | What it shows                                                                                                                                                           |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | My day                   | Written and collected today (any store), ticket count, average ticket, vs the same weekday last week.                                                                   |
| 2   | My drawer                | My open shift (any store): float, cash in since open (the close ritual's math), expected cash, suspended / open 12h+ flags; the picked store's last close and variance. |
| 3   | Call-backs               | My quotes and drafts, oldest first, with phone; 3d+ in red.                                                                                                             |
| 4   | My deliveries            | Deliveries today and tomorrow for orders I wrote: window, driver, status, phone.                                                                                        |
| 5   | Balance due              | My live orders still owing (total − succeeded payments), due-now flagged when the requested date has arrived; total open.                                               |
| 6   | Pickups waiting          | Pickup orders at this store, oldest first, readiness (every stock line reserved/fulfilled) and whether the order is mine.                                               |
| 7   | Commission               | Current period accrued, pending, approved, paid; last payout and its period.                                                                                            |
| 8   | What I can offer         | Live promo codes (active, in window, uses left) and the price-variance tiers from settings.                                                                             |
| 9   | My returns and exchanges | Returns and exchanges I started that are not completed or cancelled.                                                                                                    |
| 10  | Store today              | Store written today (every seller), my share, my rank this week among the store's sellers, and the leader's number.                                                     |

Layout: a five-tile strip (written, collected, drawer, balance due, commission)
then the queues two-up, then commission / offers / scoreboard three-up, then
returns. Read-only; every row links to its document.

### 12.17 View Product Activity — every STORIS tab (amendment A21, owner 2026-09-11)

Owner sent the twelve STORIS "View Product Activity" screens (Location
Availability ATP, Purchase Orders, Open Orders, Sales History, Inbound and
Outbound Transfers, General Information, Serial/Reference, As-Is, Summary, a
second product's ATP screen, and "Search for a Product") and asked "Do we
already have these?" — then "start". A19 covered the landing screen's three
blocks and the per-location grid; the rest existed as data with no per-product
view. The product page now carries the whole screen.

**Layout.** The product page keeps its header (product code, name, second
description, vendor, brand, vendor model) and grows the STORIS section list on
the left — the same pattern as View Customer Activity — with the picked
section in the URL (`?tab=`). Sections, in STORIS order: Availability,
Purchase orders, Open orders, Sales history, Inbound transfers, Outbound
transfers, General information, Serial / Reference, As-Is, Summary. Every
section that STORIS scopes to a location gets the same Location picker (All
locations, or one store); the header strip repeats the STORIS quantities (On
hand, As-Is, Net available, Net PO) for that location. Read endpoints live
under `GET /v1/products/:id/activity/<section>` (`products.view`; cost and
profit figures only with `products.cost.view`).

| STORIS tab / block                                                           | Jetnine                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location Availability ATP · Available to Promise                             | Availability: Desired quantity → ATP date + ATP quantity (D2); per-location grid gains On order reserved, Total PO, As-Is reserved, ATP date, ATP quantity (D3, D4) next to A19's columns.                                                                                                                                                                                                                                                                                 |
| Location Availability ATP · Inventory Quantities · Merchandising             | A19 tiles and Merchandising card; Merchandising gains Suggested retail price (D9).                                                                                                                                                                                                                                                                                                                                                                                         |
| Purchase Orders                                                              | Purchase orders: PO number, vendor, receiving location, quantity due, placed (STORIS acknowledged), expected (delivery date), created, line, status, type (D7).                                                                                                                                                                                                                                                                                                            |
| Open Orders                                                                  | Open orders: Location + "use fulfillment / selling location", Order type; order number, type, selling location, fulfillment date, order quantity, reserved, fulfillment type, fulfillment status, ship from, order date, customer (D6). Open Shopping Carts = order type Quotes.                                                                                                                                                                                           |
| Sales History                                                                | Sales history: period, sales amount, cost amount, profit %, shipped, returned, net — trailing 14 months, per location or all (D5).                                                                                                                                                                                                                                                                                                                                         |
| Inbound Transfers · Outbound Transfers                                       | Inbound / Outbound transfers: To/From location, inbound/outbound quantity; transfer number, other location, transfer date, quantity, reserved quantity, order number, scheduled date, customer, type (D8).                                                                                                                                                                                                                                                                 |
| General Information · Status · Price · Cost · Shipping                       | General information: Group, Category, Collection, Warranty category; Status (purchase, distribution); Price (selling, sale, markdown, sale end, suggested retail); Cost (average, PO replacement, average landed, freight per unit, freight %); Shipping (delivery volume, weight, shipping volume, height, width, depth) — D9. The A19 cards (Descriptive, Purchase status & packing, Tax class, Brand & collection, Variants, Reorder automation, Images) live here too. |
| Serial/Reference                                                             | Serial / Reference: serial, received, status, storage location, order number, customer, special-order line (D10).                                                                                                                                                                                                                                                                                                                                                          |
| As-Is                                                                        | As-Is: piece, received, status / condition, reason code, selling price, sellable, storage location, source, comments (D11).                                                                                                                                                                                                                                                                                                                                                |
| Summary · Inventory Quantities · Month To Date Regular · As-Is               | Summary: beginning-month balances, on hand, as-is, net PO; MTD received / adjustments / transferred in / out / sales; MTD as-is transferred in / out / added / removed (D12).                                                                                                                                                                                                                                                                                              |
| Search for a Product                                                         | Browser "Advanced search": Product, Description, Brand, Vendor model, Vendor, Collection, Category, Product group, Purchase status, As-Is reason code, Location (D13).                                                                                                                                                                                                                                                                                                     |
| Spiff/Commission · As-Is / Regular Inventory Detail · Special-Order Defaults | Not built: spiffs are a commission-plan matter (§12); the inventory detail screens are Stock by location (`/products/stock`); special-order defaults are the special-orders module. No screenshots were sent for them.                                                                                                                                                                                                                                                     |

Decisions:

- **D1 One page, one section list.** No new route: `/products/[id]?tab=…`. The
  header and the STORIS strip render once; sections load on demand.
- **D2 ATP stays reservation-basis + inbound dates (owner decision kept).**
  ATP quantity = net available (all locations or the picked one). ATP date =
  today when that covers the desired quantity; otherwise the expected date of
  the open purchase order at which cumulative undelivered units (ordered −
  accepted − rejected, expected date known, earliest first) cover the
  shortfall; blank when no PO covers it. No projection of open orders'
  promise dates.
- **D3 On order reserved** = units of the location's open PO lines allocated
  to order lines (`po_line_allocations`, live). Net PO stays A19's ordered −
  accepted − rejected; the free inbound is Net PO − On order reserved. STORIS's
  negative Net PO (over-allocated) is not reproduced.
- **D4 As-Is reserved is 0.** As-is pieces have no reservation state — they
  sell by restocking to a sellable SKU (§10). The column is kept for the
  STORIS shape and reads 0 until as-is reservations exist.
- **D5 Sales history** unions register sales (completed / partially refunded
  / refunded, by completion date) with completed orders (by completion date),
  imported STORIS history included — it is history, not accrual, so D8's
  exclusion does not apply. Cost amount = catalog cost × quantity (the Sales
  by product report's and A20 costed view's basis; FIFO consumption cost is a
  follow-up). Returned quantity = register refund lines + completed order
  returns, by their own dates. Net = shipped − returned. Cost and profit are
  null without `products.cost.view`. Fourteen periods: this month and the
  thirteen before it, newest first, zero rows kept.
- **D6 Open orders** = lines of the product on `open` / `partially_fulfilled`
  orders with units not yet fulfilled; quotes appear when the Order type
  picker says Quotes (STORIS Open Shopping Carts). Order type: Sales order /
  Layaway / Exchange / Quote. Fulfillment status: the line's scheduled
  delivery (scheduled / loaded / out for delivery) else the order's delivery
  status (will call reads CWC). Ship from = line source, else the order's stock
  location, else the selling location. Customer code is not modeled
  (customers have no code) and is omitted.
- **D7 Purchase orders** = draft and placed POs (not deleted) with units still
  due, direct ship included (type Direct ship). Acknowledged date reads the
  placed date; Requested date and Line ID are not tracked (the line's SKU
  stands in).
- **D8 Transfers** = open transfers (draft, in transit) touching the location.
  Transfer date = shipped, else created; quantity = shipped, else ordered.
  Reserved quantity = the transfer's units when it carries an order (customer
  transfers). Type: replenishment / customer / as-is / floor sample.
- **D9 General information adds two product fields:** `suggestedRetailCents`
  (STORIS Suggested Retail Price — Merchandising and Price information) and
  `shippingJson` (weight lb, height / width / depth in, shipping volume,
  delivery volume — the STORIS Shipping Information block; display and print
  only, no capacity math: delivery capacity stays pieces × capacity units).
  Both edit on the tab (`products.update`), migration `0093`. Not modeled:
  Sale / Markdown / Sale end date (A19 D12 — prices are set at the register or
  on Set prices), Warranty category (A20 phase 2 D8 protection plans),
  Distribution status (the product's active flag stands in). Cost
  information: Average = quantity-weighted average of the remaining FIFO cost
  layers; PO replacement = catalog cost (what a new PO line defaults to);
  Average landed = average + the preferred vendor's active landed-cost lines
  (percent of cost, or dollars per unit; "calculate" lines are skipped);
  Freight per unit / Freight % read the vendor's freight line.
- **D10 Serial / Reference** lists the product's serial units at the location
  (all statuses but sold): in stock reads Unassigned, committed reads Assigned
  with the order and customer; storage location = the variant's bin at that
  location. Products without serial tracking (D4 of the cutover plan: opt-in)
  get an empty state saying so. WMS tag and float id are not modeled.
- **D11 As-Is** lists pieces in review at the location; Sellable = condition
  not damaged / parts (A19); reason code from the piece's reason code row.
- **D12 Summary** derives beginning-of-month balances from the movement
  ledger (on hand − this month's deltas; as-is on hand − added + removed).
  MTD Regular buckets movement reasons: Received (receive, receive_po,
  unreceive_po), Adjustments (adjustment, physical_count, physical_variance,
  physical_commitment, import, as_is_restock), Transferred in / out
  (transfer_in / transfer_out), Sales (sale, order_fulfill, shown positive).
  Reservation movements carry delta 0 and count nowhere. MTD As-Is:
  Transferred in / out = as-is transfers received / shipped this month,
  Added = pieces entered this month, Removed = pieces reviewed out this month
  (restocked, vendor return, scrapped, written off). STORIS's as-is Sales line
  is not tracked separately (D4).
- **D13 Search for a Product.** `GET /v1/products` accepts `sku` (product or
  variant SKU contains), `name` (description contains), `brandId`,
  `vendorModel` (contains), `collectionId`, `group` (equals, case-insensitive),
  `purchaseStatus`, `asIsReasonCodeId` (products with an as-is piece in review
  under that reason); each narrows every browse mode (default, sorted,
  search). The browser shows them under an Advanced search disclosure next to
  the existing search box, vendor and location.

Build order: migration 0093 → `catalog/product-activity.controller.ts` (nine
reads) + browser criteria → product page section list + panels + browser
Advanced search → `product-activity.int.spec.ts`.

### 12.18 STORIS screen sweep #2 — 28 screens, gap map and build order (amendment A22, owner 2026-09-11)

Owner sent a folder of 28 STORIS screens ("take a look and see what we are
missing and incorporate accordingly"). Nine are View Product Activity views
(A21) with a few columns and two tabs we did not have; the rest span
transfers, logistical scheduling, replenishment, stock adjustments, returns
and exchanges, customers, purchasing and administration. Each screen was
checked against the code; the map below records what stands, what is
missing and where it lands. Build order is by slice; every slice is its own
PR.

| STORIS screen                                      | Today                                                                                                                                                                                                                                                   | Plan                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| View Product Activity (9 views)                    | A21 tabs                                                                                                                                                                                                                                                | **Slice 1 (built):** Open Orders gains Linked transfer / Linked transfer quantity / Linked PO (D15); Purchase Orders gains PO type + At dock (D16); Regular and As-Is Inventory Detail tabs (D17); Open Shopping Carts tab (D18); the ATP grid follows the STORIS column order.                                                                                                                                                      |
| Search for a Product (3 views)                     | Browser + Advanced search (A21 D13)                                                                                                                                                                                                                     | **Slice 1 (built):** Product category leads and Primary collection ends the column strip, both sortable (D14).                                                                                                                                                                                                                                                                                                                       |
| Enter a Transfer                                   | From / To / type / notes / ship-now / lines                                                                                                                                                                                                             | **Slice 2:** date (scheduled for), reason code, Complete transfer (receive on create), Print transfer ticket, several To locations with Distribute quantities (one transfer per store), Delivery information (route, ship direct, instructions for this fulfillment only), total volume.                                                                                                                                             |
| Report Transfers by Location (2 views)             | No transfer report                                                                                                                                                                                                                                      | **Slice 2:** `GET /v1/reports/transfers-by-location` (from / to / dates / reserve level / include instructions; csv, txt, Basic PDF via the AR.317 text writer) grouped by receiving store: transfer, date, sending location, transfer for, product, brand, order / reserved / held qty, manifest.                                                                                                                                   |
| Enter a Stock Adjustment                           | Adjust + floor sample via prompt(); bins; as-is intake, restock, scrap, vendor credit on the As-Is queue; no cost per unit, reason code, as-is quantity fix, serial rename or write-off from stock. `POST /v1/as-is` intake does not decrement on hand. | **Slice 3:** one Stock adjustment dialog on Stock by location and the product page with the STORIS tabs: Quantity (qty, cost per unit, reason code, notes), Bin to bin, Move to As-Is (fix: decrements stock), Move from As-Is, As-Is status, As-Is adjustment (quantity fix / void), Write-off (from stock, coded reason, register + `inventory.write_off`), Vendor chargeback, Change serial, SO info.                             |
| Reassign a Sales Reservation                       | Release a whole line on Stock by location; reserve the whole order on its page                                                                                                                                                                          | **Slice 3:** Reassign reservation dialog: location + product, On hand / Net available / Net PO, holders with Fill by / Type / Status / Order qty / Reserved; move N units from one line to another in one transaction, or back-order (release) N units.                                                                                                                                                                              |
| Replenish Inventory (Allocated order, Stock level) | Sales-rate replenishment (vendor + location required, one PO); legacy reorder suggestions; special-orders queue                                                                                                                                         | **Slice 4:** one Replenish screen with Replenishment type (Allocated order = open-order shortfall by variant; Stock level = below minimum (per-store min stock) or safety (variant reorder point)); Create PO by vendor across every vendor; product / group / category / vendor / location filters; fulfillment-status checkboxes; include floor samples / returns toggles; carton rounding with Carton and Total quantity columns. |
| Logistical Scheduling (2 views)                    | 35-day calendar + dispatch for sales orders; transfers on manifests; service orders unscheduled                                                                                                                                                         | **Slice 5:** Search for schedules (kind: sales orders / transfers / service orders; deliver from, route, truck, transfer to, date range, past dates) and Confirm schedule (delivery status + contact status filters; Stops / Units / Dollars / Volume; grid with zip, city, contact, T D F P OO flags). Contact status becomes a delivery field.                                                                                     |
| Enter a Return                                     | Returns with / without original; drop-off or pickup; refund method; RMA                                                                                                                                                                                 | **Slice 6:** pickup scheduled on the delivery calendar (deliveries carry a return), return salesperson, store, restocking / pickup fees, return ticket print, contact status.                                                                                                                                                                                                                                                        |
| Enter an Exchange                                  | Exchange binder (return + sale legs, settlement, restocking fee, return salesperson in the API)                                                                                                                                                         | **Slice 6:** return salesperson and fulfillment on the wizard, refund tender when the return exceeds the sale, exchange ticket print.                                                                                                                                                                                                                                                                                                |
| Update a Customer Address                          | First / last, phones, email, delivery + billing address, notes                                                                                                                                                                                          | **Slice 6:** customer number, Business + contact name, prefix / middle / suffix, alternate name + relationship, delivery instructions; the same fields on the order's customer panel.                                                                                                                                                                                                                                                |
| Access Time Clock                                  | Time clock strip on the dashboards, signed-in member only                                                                                                                                                                                               | **Slice 7:** `/timeclock` kiosk page: email + password re-auth per punch on a shared terminal (punch-on-behalf endpoint that verifies the credentials).                                                                                                                                                                                                                                                                              |
| Recover STORIS Licenses                            | Own sessions only (user menu)                                                                                                                                                                                                                           | **Slice 7:** Settings → Active sessions: every member's sessions (signed in, IP, device, last seen) with Sign out; `sessions.manage`.                                                                                                                                                                                                                                                                                                |
| Print a Purchase Order                             | Print from the PO page, one at a time                                                                                                                                                                                                                   | **Slice 7:** `/print/purchase-orders` batch print by PO / receiving location / vendor, include direct ships, reprint tracking.                                                                                                                                                                                                                                                                                                       |
| Receive a Purchase Order                           | Receiving + reverse (unreceive) on the PO page and Products → Receive                                                                                                                                                                                   | Covered.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Enter a Purchase Order (Merchandise tab)           | PO builder                                                                                                                                                                                                                                              | Covered; Volume / Weight / Pieces header from the shipping fields and per-line discounted cost are noted, not scheduled.                                                                                                                                                                                                                                                                                                             |
| Main Menu (Favorites, History, Program search)     | Global search (⌘K) is the program search                                                                                                                                                                                                                | Not built: favorites / history are a shell nicety, not a STORIS workflow.                                                                                                                                                                                                                                                                                                                                                            |

Decisions (slice 1):

- **D14 Browser columns.** Product category is the first column and Primary
  collection the last, both sortable (`categoryName`, `collectionName`).
  Saved column orders pick the new columns up at the end.
- **D15 Linked documents on Open Orders.** Linked transfer = the earliest
  live transfer carrying this product for the order (quantity = shipped,
  else ordered); Linked PO = the PO line allocated to the order line, with
  its allocated quantity.
- **D16 PO type and dock.** PO type reads Direct ship, Special order (a line
  allocated to a sales-order line) or Standard. STORIS "Dock scheduled" has
  no counterpart (no dock appointments); the column reads **At dock** — units
  received and not yet accepted or rejected.
- **D17 Inventory detail.** Regular = the movement ledger at the location
  between two dates (reservation rows carry delta 0 and are skipped); opening
  balance = on hand now − every movement since the start, ending balance = on
  hand now − every movement after the end, running balance per row.
  References resolve to the order, PO, transfer, register sale or RMA number.
  As-Is = pieces entered (+) and reviewed out (−) by their own dates, same
  arithmetic on the as-is count. Both default to month to date.
- **D18 Open Shopping Carts** = the Open Orders view opened on Quotes.

Decisions (slice 2 — transfers):

- **D19 Enter a Transfer fields.** A transfer carries a coded reason
  (usage class `transfer`, Settings → Reason codes), a delivery date
  (`scheduledFor`, until now auto-transfers only), a route name, a Ship
  direct flag and "instructions for this fulfillment only" (the ticket
  prints them). Migration `0094`. The document date stays the creation date.
- **D20 Complete transfer.** `complete: true` ships and receives on create
  — the stock already moved, so nothing is left to pick and the printed-
  ticket gate does not apply. Plain create + ship keeps the gate.
- **D21 Several To locations.** `toLocationIds` creates one transfer per
  destination; `distributeQuantities` splits each line evenly (remainder to
  the first stores) and refuses to leave a store with nothing, otherwise
  every store gets the full lines. Serial-picked lines never fan out. The
  response is the first transfer plus `createdTransfers`.
- **D22 Report Transfers by Location** (`GET /v1/reports/transfers-by-location`,
  `reports.inventory.view`; csv / txt / pdf need `reports.export`): every
  non-cancelled transfer line grouped by receiving store, filtered by sending
  and receiving location, transfer date (shipped, else created) and reserve
  level — partial = units still held (ordered − shipped), full = none.
  Columns follow TE.324: Order Qty = ordered else shipped, Res Qty = shipped,
  BOy Qty = held, Manifest Number; a Vendor Model sub-line when the variant
  has one; instructions and notes under the transfer when asked. The spool
  reuses the AR.317 text writer through the shared `text-layout` helpers.

Decisions (slice 3 — stock adjustment + reassign reservation):

- **D23 One Stock Adjustment dialog.** Stock by location and the product
  page open the same dialog (`components/stock-adjustment-dialog.tsx`) on a
  variant + location: a header strip from `GET /v1/inventory/stock-card`
  (on hand / reserved / floor / available / net on PO / as-is here / bin /
  cost, plus the pending as-is pieces, the serials in the building, the
  active bins and the `-AS` sibling variant) and the STORIS tabs: Quantity,
  Bin to bin, Move to As-Is, Move from As-Is, As-Is status, As-Is
  adjustment, Write-off, Change serial (serial-tracked products only), SO
  info. Vendor chargeback stays on the As-Is queue's vendor-return path.
  The `prompt()` adjust is gone.
- **D24 Quantity adjustment.** `POST /v1/inventory/adjust` takes a coded
  reason (`reasonCodeId`, class `inventory_adjustment`, validated when
  given — the legacy bucket + notes stay the floor so a business without
  codes is never blocked) and `unitCostCents` for an upward adjustment (the
  FIFO layer lands at that cost instead of the catalog cost). Migration
  `0095` adds `inventory_movements.reason_code_id` so the ledger and the
  shrink report can group by reason.
- **D25 Write-off from stock.** `POST /v1/inventory/write-off` mirrors the
  As-Is scrap: `inventory.write_off` (override-able through the Security
  Override dialog), a coded `write_off` reason, a write-off register row at
  catalog cost, an exception, and the ledger movement (`write_off`) that
  drops on hand. Only available units can go — reserved and floor-sample
  units must be released first.
- **D26 Move to / from As-Is.** `POST /v1/as-is` with `fromStock: true`
  (source `stock`) now decrements on hand (available units only), consumes
  FIFO layers and writes an `as_is_intake` movement — the double count the
  screen sweep found is closed. Move from As-Is is the existing restock
  review (this product or its `-AS` variant). As-Is adjustment is
  `POST /v1/as-is/:id/void` (status `voided`, reason required, optional
  return to sellable stock) for a piece taken in by mistake, plus the
  walk-in intake for pieces found on the floor. Change serial is
  `PATCH /v1/serials/:id` (`serials.manage`; sold / in-service units keep
  their serial; duplicates 409).
- **D27 Reassign a Sales Reservation.** `GET /v1/inventory/reservation-board`
  lists every live order line wanting the item at the location (order,
  customer, kind, order date, fill-by = line delivery date else requested
  date, qty / reserved / short); `POST /v1/inventory/reservations/move`
  (`orders.update`) back-orders N units off a line or reserves N onto a
  line — taking them from another order's line in the same request when
  nothing is free. Both orders pass the shared order-edit guards
  (`orders/order-guards.ts`: live, unlocked, off the truck) and the moves
  go through the order service's reserve / release primitives, so the
  `order_reserve` / `order_release` ledger rows are the same ones the order
  page writes. The Reserved count on Stock by location and the product page
  opens it; the release-only popup is gone.

Decisions (slice 4 — Replenish Inventory):

- **D28 One Replenish screen, three types.** `/replenishment` gains a
  Replenishment type switch: Allocated order and Stock level (new,
  `POST /v1/purchasing/replenish/run`, `purchase_orders.view`) run across
  every vendor at once; Sales rate is the per-vendor engine the nightly
  build uses, unchanged. Filters: location, vendor, category, collection
  (Jetnine's "group"), product / SKU text; options: include floor samples
  as stock, include returns (pending As-Is pieces) as stock, round up to
  purchase cartons, show positions with nothing to order.
- **D29 Allocated order.** Demand is every open (`open`,
  `partially_fulfilled`) sales-order line's uncovered units — quantity −
  fulfilled − reserved − units already allocated on an open PO — at the
  location the line draws from (line source, else the order's stock
  location, else its selling location). The STORIS fulfillment-status
  checkboxes filter on the order's delivery status (scheduled / estimated
  / ASAP / will call / not set; none ticked = all). Need = demand − free
  stock − unallocated open-PO units (negative stock counts as zero). The
  grid shows the orders behind each row, earliest fill-by first.
- **D30 Stock level.** Basis `minimum` = the store's Min Stock
  (`inventory_levels.reorder_point`), one row per store position; basis
  `safety` = the variant's reorder point, business-wide (one row per
  product, stock summed across locations; the run's location receives the
  POs). Need tops the position (free stock + open PO) back up to the
  threshold and is at least the variant's reorder quantity when one is
  set. Carton = the product's Purchase Carton Qty; Cartons and Total
  quantity columns follow STORIS (Total = cartons × carton when rounding
  is on).
- **D31 Create purchase orders by vendor.** A row's vendor is the
  variant's preferred vendor, else its collection's vendor, else the
  active vendor named like the product's brand; rows without one show
  under "No vendor" and never become a PO. `POST
/v1/purchasing/replenish/purchase-orders` (`purchase_orders.create`)
  recomputes the run, applies the buyer's Total quantity edits and the
  vendor tick-boxes, and writes one PO per vendor and receiving location
  (placed, or held as drafts): expected date from the vendor's lead days
  when it has replenishment settings, freight from its landed-cost lines,
  lines past a PO cutting date dropped and noted, and — for allocated
  orders — the special-order allocations (earliest fill-by first) so
  receiving commits the units to the customers waiting. PO numbers come
  from the shared `purchasing/po-number.ts`.

Decisions (slice 5 — Logistical Scheduling):

- **D32 Search for schedules** (`GET /v1/scheduling/search`,
  `deliveries.view`; page `/deliveries/search`): one list per kind —
  sales orders (deliveries), transfers, service orders — filtered by
  deliver-from location, route, truck, transfer-to location (transfers),
  status and a date range that defaults to today → +35 days;
  `includePast=1` drops the lower bound. Open schedules only unless a
  status is asked for. Every row carries the same columns (date, window,
  number, customer / manifest, from → to, route, truck, driver or
  technician, city, zip, phone, units, dollars, balance due, volume,
  status, contact status) so the grid is one table, and the strip totals
  Stops / Units / Dollars / Volume (volume = capacity units, G12).
- **D33 Where each kind's date, route and truck come from.** Deliveries:
  the scheduled date, the delivery's route else its run's, the run's
  truck and driver. Transfers: `scheduledFor` else the manifest date, the
  transfer's route else the manifest's route name, the manifest's route
  name as the truck; units = ordered else shipped. Service orders: the new
  `service_orders.scheduled_for` (migration 0096; set through
  `PATCH /v1/service-orders/:id`), the technician as crew; unbooked calls
  never list.
- **D34 Confirm schedule** (`GET /v1/scheduling/confirm`; page
  `/deliveries/confirm`): a day's (or range's) deliveries — open stops
  unless delivery statuses are ticked — with location, route and contact
  status filters, the totals strip plus a Confirmed count, zip / city /
  phone (the order's delivery phone else the customer's), and the flags:
  **T** delivery ticket printed, **D** dollars due at the door (balance
  owed), **F** fully reserved (every stock line reserved or fulfilled),
  **P** pick list printed, **OO** on an open purchase order (a
  special-order allocation still outstanding).
- **D35 Contact status is a delivery field.** `deliveries.contact_status`
  (`not_contacted` | `left_message` | `no_answer` | `confirmed` |
  `reschedule_requested`, null = never called) with `contacted_at`, set by
  `PATCH /v1/deliveries/:id/contact` (`deliveries.schedule`, audited with
  the call note) — inline on the Confirm schedule grid.

Decisions (slice 6 — returns, exchanges, customers):

- **D36 Enter a Return fields.** `POST /v1/orders/:id/return` takes the
  return salesperson (`salespersonMembershipId`), the store taking the
  return (`locationId`), a restocking fee and — for a truck pickup — a
  pickup fee; both fees come off the refund (never more than the lines
  are worth) and print on the ticket. Migration `0097`. The order page's
  Returns card carries the fields.
- **D37 Pickup on the delivery calendar.** A pickup return with a
  `pickupDate` (and window) writes a `return_pickup` delivery
  (`deliveries.kind`, `deliveries.return_id`) carrying the returned lines
  at the store taking the return, so it shows on the calendar, the day
  sheet, Search for schedules and Confirm schedule — with the delivery's
  contact status as the return's contact status. Completing that stop
  receives the return (qtyReturned, As-Is staging, the refund) instead of
  fulfilling the order; stock never drops. The return keeps
  `pickupDeliveryId`.
- **D38 Return and exchange tickets.** `GET /v1/order-returns/:id` is the
  return's print view (order, customer, store, salesperson, lines with
  reasons, fees, refund, pickup stop); `/print/returns/:id` prints it and
  `POST /v1/order-returns/:id/ticket-print` counts the print
  (`ticketPrintCount`). Exchanges get the same pair
  (`/print/exchanges/:id`, `POST /v1/exchanges/:id/ticket-print`) — both
  legs, the settlement and the refund tender on one page.
- **D39 Enter an Exchange fields.** The exchange records `fulfillment`
  (`drop_off` | `pickup`, from the wizard's goods-in-hand switch), the
  return salesperson (by name on the detail) and a `refundTender`
  (`store_credit` default | `original` | `cash` | `check`). When the
  return credit exceeds what the replacement absorbs, settlement pays the
  excess out by that tender — original tenders newest-first, or a cash /
  check refund on the original order — after redeeming it from the
  ledger; store credit leaves it spendable. Audited on `exchange.settle`.
- **D40 Update a Customer Address fields.** Customers gain a per-business
  customer number (`C-000001`, assigned at creation, existing customers
  numbered in creation order by the migration), business + contact name,
  prefix / middle name / suffix, an alternate contact + relationship, and
  standing delivery instructions. Search covers the number, the trade
  names, the middle name and the alternate contact. The order's customer
  panel and the invoice / ticket document payload carry the number, trade
  names, alternate contact and delivery instructions.

Decisions (slice 7 — kiosk, sessions, batch PO print):

- **D41 Time clock kiosk.** `/timeclock` is the shared-terminal screen:
  the terminal stays signed in as any member who may punch, and every
  punch carries the punching member's own email + password.
  `POST /v1/timeclock/kiosk-punch` (`timeclock.punch`) verifies the
  credentials against the credential account (never a session), finds
  that user's active membership in this business, checks their role may
  punch, and records the punch on THEIR membership (audit metadata
  `source: kiosk`). The terminal's session never changes; the form clears
  after every punch.
- **D42 Active sessions.** New permission `sessions.manage` (Owner,
  Manager, Operations). `GET /v1/business/sessions` lists every unexpired
  sign-in held by a member of this business (name, role, IP, device,
  signed in, last seen, expires, "this session"); `DELETE
/v1/business/sessions/:id` signs one out (audited `session.revoke`) —
  only sessions of this business's members. Page: Settings → Active
  sessions (`/settings/sessions`, also in the People nav). Sessions are
  now also persisted in the database (`storeSessionInDatabase`) so the
  listing sees them when Redis is the session store; revoking goes through
  better-auth's adapter so the Redis copy dies with the row.
- **D43 Batch PO print.** `/print/purchase-orders` prints every purchase
  order matching `ids`, or PO number / receiving location / vendor /
  status / direct ships in or out / not-yet-printed (new list filters on
  `GET /v1/purchase-orders`), one vendor document per page.
  `purchase_orders.print_count` + `last_printed_at` (migration `0098`)
  track prints: `POST /v1/purchase-orders/:id/print` bumps them (the
  single-PO Print button and the batch page both call it) and a second
  print is flagged REPRINT on paper and in the toolbar.

Build order: slice 1 (this amendment) → 2 transfers → 3 stock adjustment +
reassign reservation → 4 replenishment → 5 scheduling → 6 returns /
exchanges / customers → 7 kiosk, sessions, batch PO print.

### 12.19 Product categories — the tree behind the advanced search (amendment A22.1, owner 2026-09-11)

Owner ask: "in advanced search we need to categorize all of the products; use
the web if needed to figure out their categories." The catalog import had
created one category per STORIS `CATG` code (MATT, ADJUST, FOUND, FURN, PROT,
TOPBED, BED, SUPPLY, PILLOW, NONINV, RF), so the Product category criterion
could only narrow to a code. Mapping and sources:
`docs/imports/2026-09-11/product-categories.md` (+ `.csv`, regenerated by
`build-product-categories.py`).

- **D44 Two-level retail tree, applied by an ops run, not a migration.** Ten
  top-level categories (Mattresses, Adjustable Bases, Foundations & Box
  Springs, Bed Frames, Bedroom Furniture, Mattress Protection, Bedding,
  Pillows, Store Supplies & Equipment, Services & Fees) with 35
  subcategories; every one of the 1,948 SKUs is filed. Category data is
  tenant data: `apps/api/src/ops/categorize-products.ts` (workflow _Ops —
  categorize products_, validate → commit, idempotent) renames the code
  categories **in place** so existing references keep their ids, creates the
  subcategories, moves the products, drops the emptied `RF` code and writes a
  `products.categorize` audit row.
- **D45 Mattress construction follows the retailer's own storefront.**
  Innerspring / Hybrid / Memory Foam / Latex as mattressstoreslosangeles.com
  labels each line, then the maker's spec, then the STORIS description
  (HYBRID, LATEX). Memory Foam is the all-foam bucket; Latex holds natural
  latex builds even on coils (Harvest Green, Avalon, Scandinavian
  Collection). Every row's `SOURCE` says which; the 54 `inferred` rows are
  listed for review.
- **D46 Nested categories in the browser.** `GET /v1/products?categoryId=`
  includes every descendant (picking _Mattresses_ returns the hybrids); list
  and detail rows carry `categoryPath` ("Mattresses › Hybrid"), which the
  Product category column and the advanced-search picker show. A catalog
  re-import never coarsens a category: a `CATG` code resolves to the renamed
  root when no code category exists, and a product already in a subcategory
  of that root keeps it.

### 12.20 Size and firmness — first-class variant fields (amendment A22.2, owner 2026-09-12)

Owner ask: "when you search for a product and select size, if it's not in
the product name it will not show; make sure the remaining fields work with
industry standards." Until now the register popup read size and firmness
off the product name with a regex at query time, so a CKSHEE sheet set or a
QUPRO protector — whose STORIS description never says the size — matched no
size pick at all.

- **D47 One vocabulary.** `MATTRESS_SIZES` (Twin, Twin XL, Full, Full XL,
  Queen, Olympic Queen, King, Cal King, Split Queen, Split King, Split Cal
  King, Custom) and `FIRMNESS_LEVELS` (Plush, Medium, Medium Firm, Firm,
  Extra Firm) live in `@jetnine/shared` with the parsers every layer uses:
  `normalizeSize` (labels, long forms, STORIS / SKU abbreviations — "CA
  King", "California King", "CK" all land on Cal King), `sizeFromGroupCode`
  (QUEEN / QUFND / QUADJ / QUPRO / QUSHEE / QUPCAS…), `sizeFromText` (one
  size per name; a slash list such as T/F/Q/K/CK or QUEEN/FULL is a
  multi-size item and gets none) and `firmnessFromText` (STORIS shorthand
  included: X-FIRM, XFIRM, ULTR FM, FM, MED, SOFT).
- **D48 Stored on the variant, backfilled once.** `product_variants.size` and
  `.firmness` (migration `0099`, indexed by business + size). The migration
  fills them for every existing variant — its own attributes first, then
  the STORIS group code, then the product + variant name — with SQL that
  mirrors the shared parsers; the categorize spec proves the two agree on
  all 1,948 STORIS rows. The catalog import sets them the same way (an
  explicit SIZE / FIRMNESS column wins) and never clears a value a file
  says nothing about. Product create derives them from the names unless
  told; the product page edits them per variant; any spelling is accepted,
  an unknown value is refused. The variant search vector now carries both,
  so free text finds "cal king bamboo sheets".
- **D49 Every product search uses the columns.** The register's Add
  Product popup filters on the stored size / firmness (falling back to the
  names only for a variant nobody has filed) and matches every search word
  in any order across product name, variant name, SKU, size, firmness and
  brand. The product browser gains `size` and `firmness` criteria and
  sortable columns; `GET /v1/products/facets` feeds the pickers (group
  codes, sizes and firmness levels in use, with counts) so the Product
  group criterion offers the codes instead of asking for one.

## 14. Build Order

1. Schema: order types/statuses, store prefixes + per-store sequences, fee settings
   (tax per store exists; recycling rate), permission matrix + per-user overrides.
2. New Sale screen (single-screen; supersedes the checkpoint-7 wizard per A3).
3. Orders list + slide-over + change history + notifications feed.
4. Documents: invoice, delivery ticket (+ individual-print lock per A1), batch print.
5. Delivery scheduling table + capacity + routes.
6. Purchasing: PO builder w/ suggestions, PDF/email, receiving, partial receipts,
   invoice matching.
7. Transfers.
8. Returns/exchanges/service + As-Is review + store credit.
9. Commissions + dashboards + 10pm auto-close job.

At each phase: match existing conventions, keep everything tenant-scoped, and stop
to confirm before schema migrations that touch the already-migrated
customers/products data.
