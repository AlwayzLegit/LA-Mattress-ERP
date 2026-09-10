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
  `format=csv`.
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
  store, operator, drawer, drawer reference), Run, Print, Export CSV; URL
  carries the parameters.
- Tests: `cash-drawer-balancing.int.spec.ts` (6).

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
