# HANDOFF — Jetnine ERP / LA Mattress STORIS cutover

**Written 2026-08-26.** Read this first, then `SPRINT-STATUS.md`. Everything below was
verified against the live systems on the date above; re-check anything you are about to
depend on rather than trusting this file's freshness.

---

## 1. Where the build actually stands

**All build work is merged to `main` and deployed.** There is no unmerged work and no
open PR. `main` head is `41577bd`.

| Programme                               | State                                          |
| --------------------------------------- | ---------------------------------------------- |
| `PLAN-STORIS-CUTOVER.md` D1–D12         | Locked; implemented                            |
| `PLAN-POS-OPERATIONS.md` P1–P9          | **All nine phases built**                      |
| `PLAN-STORIS-GAP.md` G1–G15 + A5–A9     | **All fifteen closed**                         |
| Browser QA pass 1 (15 findings, D1–D15) | Fixed or dispositioned — see §5                |
| Migrations                              | 49, head `0048_sale_line_order_discount_share` |
| API test suite                          | 500 passing · e2e 8/8                          |

What remains is **not build work**. It is cutover work: data, accounts, DNS, and the
owner-side Ops list in §3.

---

## 2. Deployment topology (and the one trap in it)

| Piece             | Where                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (production)  | Vercel `prj_mG574V0ULR7QgDPMjbruqQfqvH1e`, team `team_di6oiEhCIT17lNXsonHt3mSc` → `https://lamattress-erp.vercel.app`. Auto-deploys `main`. |
| API (staging)     | Render `srv-da4tua3m8hqs73apsflg`, workspace `tea-da4l4hgjo6nc73db7i10` → `https://jetnine-api.onrender.com`                                |
| API deploy branch | `claude/fix-latent-int-spec-failures`                                                                                                       |
| Sprint branch     | `claude/la-mattress-erp-storis-cutover-z9xj2t`                                                                                              |

**The trap (closed 2026-09-06):** the Render service used to point at the _old_ repo
(`AlwayzLegit/JetnineERP`) on `claude/fix-latent-int-spec-failures`, so Render's own
auto-deploy never fired. `.github/workflows/deploy-api.yml` is now the auto-deploy:
on every push to `main` that touches the API it repoints the service at
`AlwayzLegit/LA-Mattress-ERP@main` if it has drifted (repo and branch as _separate_
Render API updates — Render drops `branch` when both arrive in one PATCH), starts a
deploy, refuses to continue if Render picks a commit other than the run's own, and
fails the run unless Render reaches `live`. The `RENDER_API_KEY` repository secret is
set (verified by run 98). The service reads `LA-Mattress-ERP @ main`.

### The deploy sequence

1. PR the sprint branch → `main`; wait for all four checks green.
2. Squash-merge. Vercel production deploys `main` on its own; the **Deploy API to
   Render** workflow run on `main` is the API deploy.
3. Verify the boot log line: `Schema migrations: N/N applied, head=…`. **Do not skip
   this** — it is the only proof migrations ran. (`mcp__Render__list_logs` on the
   service, text filter `igration`.)

The old fallback still works if the workflow is ever red: merge `main` into the
branch Render tracks and `mcp__Render__trigger_deploy`.

### One-off commands in production

The API host and the database are unreachable from a Claude sandbox, so anything that
must touch production data goes through `.github/workflows/ops-set-account-kind.yml`
(manual dispatch; inputs `action` = list | set, `slug`, `kind`; validated, no free-form
commands). It runs `packages/db/src/set-account-kind.ts` as a Render one-off job inside
the API service — same build and env, so `DATABASE_URL` is there — waits, and prints
the job log. The script mirrors the console's "Mark as agency" (businesses +
subscriptions rows, audit row with `actor_type = 'system'`). Add further admin scripts
the same way: a script under `packages/db/src/` and a workflow with validated inputs.

**The catalog import runs the same way** (2026-09-10):
`.github/workflows/ops-catalog-import.yml` dispatches
`node apps/api/dist/ops/catalog-import.js` as a Render one-off job. Inputs: `business`
slug, `entity` product | inventory, `file` (one of the two CSVs under
`docs/imports/2026-09-03/`), `mode` validate | commit, `expect_rows` (must equal the
file's data-row count on the ref), `replace_catalog`. The script stages, validates and
commits through `ImportService` with the Phase C gates of
`docs/HANDOFF-catalog-source-lockdown.md` §3 enforced (0 invalid, valid = committed =
rowCount, replace kept = rowCount) and exits non-zero otherwise, leaving the batch for
inspection. The job runs the **deployed** build, so the script must be on `main` and
live before the first dispatch. Note the live service is Render's **native Node
runtime** (dashboard build/start commands, repo checkout on disk — verified via the
Render API 2026-09-10), not the Docker blueprint in `render.yaml`; the job command
handles both layouts and the Dockerfile now copies `docs/imports` in. Run order: products validate → products commit with
`replace_catalog` → inventory validate → inventory commit; the job log carries the
deleted / deactivated SKU lists. The whole sequence is rehearsed on the real files in
`apps/api/test/catalog-import.int.spec.ts`.

---

## 3. Open Ops items (owner's, not yours — flag, never silently block on)

1. **Resend DNS — in flight, see §4.** The one item with a concrete next action.
2. ~~Add the `RENDER_API_KEY` repository secret~~ — done 2026-09-06; the API deploys
   from `main` automatically (§2).
3. **Stripe Billing go-live (PLAN §15.5).** Create the product + two monthly
   per-location Prices in the Stripe dashboard; set
   `STRIPE_PRICE_STARTER_PER_LOCATION`, `STRIPE_PRICE_PRO_PER_LOCATION` and
   `STRIPE_BILLING_WEBHOOK_SECRET` on Render; register
   `/v1/billing/stripe/webhook` for the six event types listed in PLAN §15.5.
   Until then the API runs Stripe Billing in stub mode and the inline subscribe
   endpoint still activates plans without payment.
4. **Rotate the shared owner password.** Credentials for `pos.lamattress@gmail.com` were
   shared into an earlier session for API testing. They were used in-session only and
   never written to the repo. Rotation is still advised and still outstanding.
5. **Two sample invoices into `docs/`** for the P4 document templates; confirm the PO
   reply-to address.
6. **Cashier + manager accounts still do not exist.** No longer blocked — see §4.
7. **Shopify listings cleanup (A18, 2026-09-06).** Products → Shopify cleanup: download
   the sales sheet, confirm the proposed STORIS listing per line (or confirm on the
   page), preview, apply, then retire the listings. Do not press "Sync now" on the
   Shopify integration — it recreates them; disconnecting it is still an owner call
   (`docs/HANDOFF-catalog-source-lockdown.md` B1).

---

## 4. The two live threads you are picking up mid-flight

### 4a. Email / Resend — one step from done

Invitation email has never worked in production. Root cause, confirmed at source:
`RESEND_API_KEY` is unset on Render, so `createEmailTransport` falls back to
`MemoryTransport`, which logs the message and drops it while the endpoint still returns 201. The Resend account has no API keys and, until today, no domains.

**Already done:**

- `WEB_BASE_URL` on Render corrected to `https://lamattress-erp.vercel.app` (it had been
  pointing at a stale deploy-branch Vercel preview alias, so every invite link was broken
  regardless of mail).
- Sending domain **`mail.a-prompt.ai`** created in Resend, id
  `fbebebe1-3a0a-4e91-a82a-b333cd6769b3`, region `us-east-1`, status `not_started`.
- The dead end itself removed in code (`41577bd`): `EmailTransport` now declares
  `delivers`; when false, `POST /v1/business/members/invite` and `/:id/resend-invite`
  return `inviteLink`, and the members page shows it with a Copy button instead of
  claiming a delivery that never happened. **Account creation is unblocked today via
  copy-link, with or without Resend.**

**Note:** the _root_ `a-prompt.ai` was refused by Resend — `403: The a-prompt.ai domain
has been registered already` — meaning it is claimed in a **different Resend account**.
The subdomain sidesteps this, but somebody should find out whose account holds the root.

**Waiting on the owner:** three DNS records at GoDaddy (zone `a-prompt.ai`). Nothing
touches the apex, so no existing service can break.

| Type | Name                     | Value                                          | Priority |
| ---- | ------------------------ | ---------------------------------------------- | -------- |
| TXT  | `resend._domainkey.mail` | the DKIM `p=…` value from the Resend dashboard | —        |
| MX   | `send.mail`              | `feedback-smtp.us-east-1.amazonses.com`        | 10       |
| TXT  | `send.mail`              | `v=spf1 include:amazonses.com ~all`            | —        |

**Your next action once the owner says the records are saved:** `verify-domain` → create
a **sending-scoped** API key restricted to that domain → set `RESEND_API_KEY` and
`RESEND_FROM_EMAIL` on Render → trigger a deploy → send one real invite and confirm
arrival.

**Do not set `RESEND_API_KEY` before the domain verifies.** With a key present and the
domain unverified, `ResendTransport` throws instead of falling back, which breaks the
copy-link path that is currently the only working way to create accounts.

### 4b. A pending invite

A valid invite exists for `me.lamattress@gmail.com`, issued 2026-08-26 17:53 UTC,
**expiring 2026-08-29 17:53 UTC**. If it lapses before accounts are made, just re-send
from the members page and use the copy-link.

---

## 5. Known-real problems that are NOT fixed

**The 2026-09-03 catalog is loaded (2026-09-10).** Products commit + replace: 1,948
kept, 6,013 deleted, 733 deactivated; inventory: 3,246 levels, 3,118 units, gates
matched. Batch ids and the SKU lists are in `SPRINT-STATUS.md` (2026-09-10 checkpoint)
and `docs/imports/2026-09-03/prod-run/`. Open from that run: 908 levels from earlier
imports at combos the file does not carry still hold 1,493 units (owner decision), every
reorder point is 0 (`MIN_STOCK = 0`), and the Shopify connector is still connected.

**The cutover blocker: every STORIS-imported variant has `priceCents: 0`.** This is D12
behaving as designed (register-side price entry), but it means the catalog cannot sell
itself. A price source is required before go-live — either import a retail-price file
(SKU → selling price) or set prices in-app. Confirmed on live data: Q-MOS10 is genuinely
`priceCents: 0` / `costCents: 125500`; both the API projection and the table map the
fields correctly, so **this is data, not a bug** (the original D9 report was closed on
that basis).

**A cosmetic ambiguity worth fixing sometime:** the Cost column renders "hidden" both
when the viewer lacks `products.cost.view` and when cost is genuinely null. Two very
different states, one label.

**`manifest_removal` has no reason codes** in the tenant, so pull-off-run falls back to
free text under amendment A9. Add codes for that usage class to make it coded.

**Browser QA is incomplete.** The owner drives it manually in Chrome; steps 3, 5, 6 and
10 are done. **Step 2 (the security-override flow) is blocked** until a second,
non-owner identity exists — it needs a manager account to authorize against, which is
exactly what §4a unblocks. There are no browser tools in this session type; QA is either
the owner's to run or must be driven through the API.

---

## 6. Conventions that will bite you if you skip them

Read `CLAUDE.md` for the full set. The ones that have actually caused failures here:

- **Verify every gate by exit code, never by grepping output.** A `next lint` failure
  prints `Error:`; a grep for lowercase `"error "` read a red lint as green and shipped a
  broken build. This cost a CI cycle.
- **CI provisions each spec's database explicitly.** A new `*.int.spec.ts` pointing at a
  new `jetnine_*` database needs both a `createdb` line and a `*_TEST_DATABASE_URL` env
  var in `.github/workflows/ci.yml`, or it fails with `database does not exist`.
  (`jetnine_rehearsal` is the one legitimate absence — it self-skips.)
- **New tenant tables need RLS registered in two places:** the `tenant_tables` array in
  `packages/db/src/migrations/rls.sql` _and_ `TENANT_SCOPED_TABLES` in
  `packages/db/src/schema/index.ts`. `rls.test.ts` verifies this.
- **Commit generated migrations with schema changes** — CI runs a drift check.
- **Money is integer cents.** Derived money (balance due) is computed, never stored.
- **Never commit STORIS export files or secrets.** `.env.example` only.
- **The temp `apps/web/playwright.local.config.ts`** used for local e2e must never be
  committed and must be deleted after use. Never run `playwright install` — Chromium is
  at `/opt/pw-browsers/chromium`.
- Local test Postgres dies between long gaps. Restart:
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pgtest/pgdata -l /var/tmp/pgtest/pg.log -o '-p 5432 -k /var/tmp/pgtest/run -c listen_addresses=127.0.0.1' start"`

---

## 7. Judgement notes from this sprint

Three things worth inheriting, because each cost real time:

**Investigate before you "fix".** Of the 15 QA findings, three were not defects: the
delivery-run lock was already enforced server-side (only the UI was silent), tier-3 price
variance collapsing to "needs a reason" is correct when the actor holds
`orders.price_override`, and the duplicate-`/pos`-screens report was a stale cached build.
One of these was made worse by a reflexive fix — a duplicated guard that broke the
typecheck and had to be reverted. Read the code path before changing it.

**Fix the dead end, not just the symptom.** The invite bug's real defect was not the
missing API key; it was that the UI reported success for mail that went nowhere and gave
the admin no recovery path. Configuring Resend would have hidden that, not fixed it.

**Decisions in the plan docs are locked.** `PLAN-STORIS-CUTOVER.md` D1–D12,
`PLAN-POS-OPERATIONS.md` A1–A4, `PLAN-STORIS-GAP.md` A5–A9 are all owner-confirmed.
Change the doc first, in the same PR, then the code. Where a doc is silent, use the
closest STORIS convention and flag it in your summary rather than inventing one.

---

## 8. Suggested first moves

1. Read `SPRINT-STATUS.md` — it is the running log and the source of truth for what
   happened when.
2. Ask the owner whether the GoDaddy records in §4a are saved. If yes, finish the Resend
   chain and prove it with a real invite.
3. Ask about the `priceCents: 0` catalog (§5). Nothing else on the critical path matters
   until the catalog can quote a price.
4. Once a manager account exists, get the owner to run QA step 2.
