# HANDOFF — POS line inventory source defaults

**Repo:** `AlwayzLegit/LA-Mattress-ERP` · **Surface:** web app, New Sale screen (`/pos`)
**Behavior observed:** https://lamattress-erp.vercel.app/pos on 2026-08-30, signed in as Arman @ Glendale Store
**Reconciled with main through:** PR #161 (deployed to production 2026-09-11). None of #134 to #161 touch the
line source-location default, so the mechanics below should still hold, but re-confirm the two "Current behavior"
observations in the browser before writing code. Naming that changed since Aug 30 is called out inline.

Two related changes to where a sale line pulls stock from. Both are about *defaults* — the
salesperson must always be able to override.

---

## 1. Current behavior (verified in the live app)

**Add Product modal** has a source selector rendered as `From {Location} — this store` for the
signed-in location and `From {Location}` for the rest. It initialises to **the signed-in store**
(Glendale Store). Helper text under it reads:

> Availability and the added line's inventory source follow the "From" location — each line can
> still be changed on the order afterwards.

The availability column header follows that selection (`AT GLENDALE STORE`), alongside `ALL` and `ATP`.

**Items table** on New Sale has per-line columns: `ITEM · QTY · PRICE $ · DISC $ · FULFILLMENT ·
INVENTORY FROM · AMOUNT`.
- `FULFILLMENT` per line: `Same as order` | Delivery | Customer pickup | Take-with | Direct ship
  (the inherited option was labelled `order default` on Aug 30; PR #136 renamed it on Sept 5)
- `INVENTORY FROM` per line: every location, seeded from whatever the modal's "From" was.

**Confirmed gap:** setting a line's fulfillment to **Take-with** does *not* touch `INVENTORY FROM`.
It only looks correct today because the modal already defaults to the signed-in store. The moment
change #1 lands, take-with lines would default to the warehouse — the wrong outcome.

Location IDs on this tenant (resolve by designation in code, not by these literals):
`Glendale Store 8faf6068…`, `Koreatown 6fe34eb8…`, `La Brea 580f5ea0…`, `Studio City dd378c63…`,
`Warehouse 2717490d-ed51-4b64-8cb9-7f608e2d37a1`, `West LA f2bf921b…`.

**Grep anchors** (exact strings in the UI, fastest way to find the components):
`"— this store"`, `"Availability and the added line's inventory source follow"`,
`"INVENTORY FROM"`, `"Same as order"`, `"Showing first 100"`.
The Add Product popup gained Size and Firmness filters in PR #161 and now matches every search word in any
order; the "From" location select and its helper text were not part of that change.
Relevant endpoints observed: `GET /v1/pos/locations`, `/v1/auth/me`, `/v1/business/members/me`,
`/v1/business/settings`, `POST /v1/orders`.

---

## 2. Change A — Add Product defaults to the warehouse

**Desired:** opening Add Product initialises "From" to the warehouse for everyone, at every store.

### Do not match on the name "Warehouse"

Locations are admin-managed and renameable. Introduce a durable designation instead:

1. Add `location_kind` enum to the locations table — `'store' | 'warehouse'` (default `'store'`).
2. Add `default_source_location_id` (nullable FK to locations) to business settings, exposed in
   admin location settings as "Default stock source for new sale lines".
3. Migration: set `location_kind = 'warehouse'` for the location currently named `Warehouse`
   (case-insensitive, per tenant); leave everything else `'store'`. Backfill
   `default_source_location_id` to that location where exactly one warehouse exists.

### Resolution order for the modal's initial "From"

```
1. order.fulfillment == 'take_with'        -> order.location_id        (see Change B)
2. business.default_source_location_id     -> that location
3. exactly one location_kind == 'warehouse'-> that location
4. fallback                                -> signed-in member's store
```

Never throw or render a blank select if the warehouse is deleted or unset — step 4 must always work.

### Labeling

Keep the `— this store` suffix and add a `— warehouse` suffix so the default reads
`From Warehouse — warehouse`. The default must be legible at a glance; the whole risk of this change
is a salesperson not noticing the source moved off their own floor.

**Optional (call it out in the PR, don't ship silently):** remember an explicit "From" change for the
rest of that draft order, so a salesperson working a stack of Koreatown items doesn't reset every time.

---

## 3. Change B — Take-with pulls from the selling store

**Rule:** a line whose *effective* fulfillment is `take_with` sources from **the order's Store field**
(the `Store` select in Order details, which itself defaults to the signed-in member's store), unless
the salesperson has explicitly overridden that line's source.

Decision confirmed with the product owner: follow the order's `Store`, not the member's home store —
one source of truth, and it does the right thing when a manager writes an order for another location.

### Mechanics

- `effectiveFulfillment(line) = line.fulfillment ?? order.fulfillment`
- Track `sourceTouched` per line (client state; set `true` when the user edits that line's
  `INVENTORY FROM` select by hand — not when code sets it).
- Recompute the source of **untouched lines only**, on every one of:
  - line fulfillment change
  - order fulfillment change (affects lines still on `Same as order`)
  - order `Store` change
  - product added
- Recompute rule for an untouched line:
  - `take_with` → `order.location_id`
  - anything else → the Change A resolution order (warehouse default)
- A line on `Same as order` inherits the order's fulfillment for this rule, so switching the order to
  Take-with re-sources every untouched inherited line.
- A touched line is **never** moved silently. If a touched line's source conflicts with take-with,
  show an inline note on the line rather than reassigning it.
- Show a small `auto` badge (or muted "follows fulfillment" hint) beside `INVENTORY FROM` while the
  value is derived; drop it once the user edits. This is what makes the override discoverable.

### Warning copy

Today a zero-stock line shows:

> Not in stock at the selected source location. No open PO — will special-order.

That is wrong guidance for take-with — the customer is standing there expecting to carry it out.
For `take_with` lines with 0 available at the source, show instead:

> Take-with: 0 available at {Store}. Change the source location or the fulfillment type.

### Reservation path

Verify reserve/unreserve uses `line.source_location_id`, **not** `order.location_id`. With the
warehouse default this becomes load-bearing — a delivery line reserved against the store instead of
the warehouse will silently corrupt availability at both.

---

## 4. Server side

- Ensure the order create/update payload carries `source_location_id` per line and that the API
  applies the same resolution order, so drafts created outside the New Sale screen behave identically.
- Validation: `take_with` line where `source_location_id != order.location_id` is **allowed** (managers
  do this legitimately) but should write an audit-log entry — that log already exists for the change
  history timeline on order detail.
- Do **not** migrate `source_location_id` on historical orders.

---

## 5. Test matrix

| # | Setup | Expected |
|---|---|---|
| 1 | Order fulfillment = Delivery, Add Product | line source = Warehouse |
| 2 | Then set line fulfillment = Take-with | source flips to order's Store, `auto` badge shown |
| 3 | Then set it back to Delivery | source returns to Warehouse |
| 4 | Manually set source = Koreatown, then set fulfillment = Take-with | stays Koreatown, badge gone, inline note shown |
| 5 | Untouched take-with line, change order Store Glendale → West LA | line follows to West LA |
| 6 | Order fulfillment = Take-with, then open Add Product | modal "From" = order's Store, not Warehouse |
| 7 | Order fulfillment = Take-with, line set to `Same as order` | line sources from order's Store |
| 8 | Warehouse designation unset / location deleted | falls back to signed-in store, no crash, no blank select |
| 9 | Take-with line, 0 available at Store | take-with warning copy, not the special-order copy |
| 10 | Complete an order with mixed delivery + take-with lines | reservations land on the correct per-line location |

---

## 6. Adjacent issues found while testing (not part of this fix)

- Hard loads of `/pos` intermittently return **503**; several RSC prefetches (`/orders`, `/service`,
  `/sales`, `/returns`, `/vendors`, `/transfers`, `/customers`) also returned 503 in one page load.
  The failed state renders a bare unstyled `Loading…` with no retry. Likely the Render free-tier API
  cold start. Worth an error boundary regardless.
- On Aug 30 every product in the Add Product picker showed `$0.00`; that was the pre-import test catalog.
  The STORIS catalog (1,948 SKUs) loaded on Sept 3 (#134, #147 to #149), so prices should be real now.
  The $0-line guard is still worth adding: the register accepted a 0.00 price with no warning.
- Salesperson dropdowns contain one option with an empty name and a junk record (`Armaaaaaa`).
  Filter out members without a display name; a blank option is selectable and would attribute
  commission to a nameless record.
- Order detail still shipped the dev note *"Delivery scheduling and fulfillment arrive with the Day 3 build."*
  on Aug 30; the A20 order-page work (#154) may have removed it. Check.

Full UI/UX audit is separate.
