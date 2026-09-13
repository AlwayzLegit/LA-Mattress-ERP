# Live chat development

Started September 11, 2026, from ERP `bb212b547f64c985ffedbaf65b1c4515fc298798`.
The owner's live chat plan authorizes an additive human-operated chat module.
Existing sales, customer, order and approval workflows are unchanged.

## Slice 1: persistence foundation

This branch now implements the database, HTTP service, worker and initial ERP inbox.
It is not deployed. ChatModule is registered but endpoints fail closed unless chat
is explicitly enabled with its environment and Redis configuration. A service
method's return confirms its database transaction committed; it does not confirm
delivery to the recipient. The storefront repository has not yet been changed.

- Migration `0099_live_chat_foundation` adds integrations, sessions, conversations,
  messages and an outbox. New tables are registered in both RLS registries.
  Composite foreign keys prevent cross-business chat relationships. The generated
  migration moves three unique indexes before their referencing foreign keys;
  the schema snapshot is unchanged and generation reports no drift.
- Shared `chat.ts` defines version `1.0.0`, strict message validation, bounded
  history cursors and a visitor-safe message shape. This is the initial service
  contract; `/v1/chat/openapi.json` exposes initial versioned endpoint documentation
  and generated request schemas. Complete response schemas and storefront type
  generation remain to implement.
- Integration and guest credentials are random 256-bit values with SHA-256 hashes
  stored in Postgres. Business is derived from the integration credential.
  Each visitor operation revalidates integration, environment, expiry and revocation
  inside its RLS transaction and checks conversation ownership.
- Creation and message retries use stable client UUIDs. Conflicting reuse is rejected.
  Conversation locks serialize sequence allocation and the message/outbox commit.
  Public messages generate separate staff and visitor change events; private notes
  generate only staff events. Outbox rows have no message text or contact fields.
- Staff writes require an active membership, team-view and reply permission and
  unrestricted location scope. Permissions and per-member overrides are rechecked
  in the transaction. Store-scoped and assigned-only access currently fail closed;
  they require the routing/assignment slice. Staff audit rows contain message IDs
  and sequences only. Controllers must suppress the generic body-copying audit fallback.
- Chat permissions enter the existing catalog and therefore the Owner/Manager
  system defaults through existing role seeding. Other roles are not enabled by
  default; final pilot membership is undecided.

`ChatService` must receive the root database connection, not an already-scoped
request transaction. Its staff context must come from the existing authenticated
tenant pipeline. It is not a substitute for HTTP authentication, CSRF checks,
subscription checks, distributed abuse limits or transport authorization.

## Validation

- 11 Postgres integration tests cover persistence, safe history, concurrent creates
  and sends, retry conflict/deduplication, private notes, audit metadata, expired and
  revoked sessions, disabled integrations, staff permissions/revocation, tenant RLS,
  composite foreign keys, and rollback when outbox insertion fails.
- CI provisions the dedicated `jetnine_chat` database. The integration suite accepts
  only a local database with this name, migrates it and removes its own fixtures.
  It does not reset or truncate an existing database.
- Local database: disposable PostgreSQL 16.14, UTF-8. No production credentials or
  database connections were used. Migration applied from an empty database.
- Shared suite: 23 tests. Existing database RLS suite: 14 tests. Shared, database and API typechecks pass. Chat API/test
  lint passes. Schema generation after the migration reports no drift.

## Slice 2: HTTP, delivery worker and ERP inbox

- Visitor session/create/message/history endpoints authenticate integration plus
  guest credentials. Staff endpoints use real ERP session authentication, tenancy,
  subscription and permission guards, followed by service-level permission checks.
- `ChatHttpGuard` uses shared Redis counters and fails closed when absent, errored
  or malformed. Staff mutations require an exact configured Origin plus
  `X-Chat-Request: 1`; message operations have JSON/body limits and no-store responses.
- Explicit chat exception handling avoids logging database parameter values.
  Pino redacts guest headers and response cookies. Chat Sentry errors are reduced
  to generic metadata and chat transaction traces are withheld pending review.
- Worker uses committed leases, SKIP LOCKED, attempt counts, bounded exponential
  retry, failed-work retention, stale-lease completion checks and separate
  environment/audience channels. Ably REST requests carry stable event IDs and
  metadata only. See https://ably.com/docs/api/rest-api for the provider contract.
- Launch worker with `pnpm --filter @jetnine/api start:chat-worker` after build;
  requires CHAT_ENABLED, CHAT_ENVIRONMENT, CHAT_BUSINESS_ID, DATABASE_URL and
  ABLY_API_KEY. It runs separately from the API and needs a supervisor in staging.
- `/chat` provides paginated team conversations, public messages, private notes,
  failed-send draft preservation and retry IDs, bounded polling and manual refresh.
  Navigation is gated by NEXT_PUBLIC_LIVE_CHAT_ENABLED=true. This first inbox does
  not yet implement assignment, capacity, customer context or realtime subscriptions.

### Slice 2 verification

15 Postgres/API integration tests pass, including real ERP sign-in and HTTP
visitor-to-staff conversation, note isolation, origin rejection, disabled chat,
limiter outage/429 behavior, worker lease recovery, backoff and Ably request shape.
The Redis dependency is simulated in HTTP tests; the actual shared Redis/Lua path
and live Ably delivery still need staging verification. API build, API/web typechecks
and changed API/web lint pass. The full web production build has not been run.

Browser-verified locally: sign in, select the synthetic test business, open a
conversation, view its differentiated private note, and send a public reply. An
independent visitor HTTP history read confirmed that exact reply persisted and
the private note remained absent. The dev server displayed existing Sentry/OpenTelemetry
bundling warnings. Physical mobile and screen-reader checks remain outstanding.

The local preview at http://localhost:3000/chat uses only synthetic data, disposable
Postgres, and a test-only in-memory limiter injected by a harness outside the repo.
The application itself has no in-memory fallback. No paid services were provisioned.

## Next slices

1. Add worker health, authorized replay controls, operational metrics and complete
   OpenAPI response schemas/generated storefront types.
2. Add transactional claims, location/team scope, assignment/capacity, read state,
   presence, deadlines and customer context. Persist staff drafts across selection changes.
3. Add short-lived provider tokens, revocation, subscriptions and recovery.
4. Integrate the headless storefront in its own feature branch: first-party HttpOnly
   cookie, narrow adapter, persistent provider, reconnect/history reconciliation and
   offline fallback. Never use the retired `/api/chat` route.
5. Provision isolated staging, test accounts and provider credentials; prove the
   browser-to-ERP-to-browser flow before enabling any production integration.

## Staging dependencies

The owner confirmed there are no test accounts or staging environments yet.
Local development uses synthetic test identities. No purchase or service creation
has been performed. Before the staffed pilot we need:

- Separate test ERP API and worker, database, Redis and storefront preview config.
- A separate Ably application/key and explicit staging channel scope.
- Named staff testers, configured hours and a retention decision.
- Confirmation of paid service choices/costs before provisioning, and a secure
  environment-variable setup rather than credentials pasted into chat.

Seven-day guest session expiry is an initial development default, not an approved
transcript-retention schedule. Credential rotation, visitor identities independent
of sessions, location/team scope, assignments, exports/deletion, attachments,
provider tokens and operational monitoring remain unfinished. Stored outbox events
are delivered only when a configured worker runs; no Ably credentials exist yet.

## Slice 3: live inbox and browser alerts (September 11, 2026)

The local ERP inbox now uses `/v1/chat/conversations/live`, a same-origin SSE
stream. The pilot server queries committed Postgres metadata once per second,
including the latest public visitor sequence. It rechecks tenant membership and
permissions on each snapshot, includes a scoped public visitor preview (up to 160 characters), and renews connections
at 30 seconds to rerun session/subscription guards. Errors emit generic events;
access revocation clears the visible inbox. The client reconnects with bounded
backoff, keeps its watermark across reconnects, and reconciles persisted history.
History also retries every 15 seconds to recover a failed fetch.

This replaces slice 2's bounded inbox polling and pagination in the pilot UI.
It covers all team conversations, including new ones outside a previously loaded
page. It is a pilot transport: full metadata snapshots and per-client database
queries must be replaced/scaled with the planned Ably subscriptions before a
large deployment. No Ably account or keys have been provisioned.

Visible features: live/connecting/reconnecting/access-required state, unread
conversation badges and tab count, arrival announcement, visitor/team bubbles,
private-note styling, saved-reply acknowledgement, and a scrollable transcript
with a visible composer. New messages follow the scroll only when the reader is
near the bottom; otherwise a jump control appears. No typing, presence, delivery,
or read receipt is fabricated. Saved means database acknowledgement only.

Sound is opt-in through a browser gesture and can be muted. Desktop alerts request
notification permission explicitly and omit visitor/message content. They fire
when the inbox is in the background. Initial history, duplicate snapshots, team
replies and internal notes remain silent. A versioned localStorage sequence gives
best-effort deduplication across alert-enabled tabs; in-tab deduplication survives
reconnects. Unread state and alert preferences are local to the mounted inbox,
not durable team read receipts. These are open-tab browser notifications, not
closed-browser Web Push. Closed-tab delivery needs push subscriptions, a service
worker notification handler and server-side Web Push delivery; not implemented.

Validation: 16 Postgres/API tests and 3 alert-state tests pass, including actual
HTTP SSE snapshots, incoming changes and kill-switch termination. API build,
web typecheck and changed-file lint pass. Browser-verified queue unread badges,
open-conversation arrivals without refresh, sound enable/mute controls, and API
restart recovery without losing the selected conversation. The in-app browser
returned notification permission denied; its blocked-permission feedback was
verified. An actual OS notification and audible hardware output were not verified.
Preview remains local at http://localhost:3000/chat with synthetic data only.

## Slice 4: customer widget integration (September 12, 2026)

Added a visitor SSE endpoint at `/v1/chat/visitor/conversations/:id/live` using
existing guest authentication and public-history filtering on every read. It
expires connections after 25 seconds, rechecks CHAT_ENABLED on every tick, and
emits generic expired/unavailable events. The storefront adapter holds the guest
credential in a first-party HttpOnly cookie and forwards only narrow visitor
operations. Public-only stream and new staff reply delivery are covered in the
16 passing database/API tests, including kill-switch termination. API build and
changed-file lint pass. Browser-tested customer send -> ERP reply -> customer
arrival, reload/draft recovery and failed-send retry using synthetic data.

Storefront changes are in the adjacent LA-Mattress-Headless isolated snapshot;
its docs/live-chat-implementation.md records source provenance and remaining
checks. No production changes or Ably provisioning occurred. This is a working
local end-to-end slice, not a completed production rollout.

## Local workflow and notifications — September 12, 2026

This section supersedes the earlier slice-specific lists of missing features.

Implemented locally: optimistic-version claim/release/resolve/reopen/spam/snooze,
capacity limits, 45-second staff availability with heartbeats, six-second typing
cues, explicit public read acknowledgements, saved staff drafts/retry keys, queue
filters, editable quick replies, public-only audited exports, consented callback
requests marked unverified, audited callback completion, and visitor end-chat.
Callback requests are persisted for staff action; they do not send email or make calls.

Background Web Push now has tenant-isolated subscriptions and durable delivery jobs,
VAPID encryption through web-push, lease protection, exponential retries, expired
subscription cleanup, permission rechecks and integration-disable checks. Notifications
contain generic text and a fixed /chat destination. Existing POS service-worker caching
is preserved; chat API responses are not cached. The manager delivery controls expose
backlogs and retry failures. CHAT_PUSH_ENABLED and VAPID variables remain opt-in.
The dedicated worker is `pnpm --filter @jetnine/api start:chat-push-worker` after build;
configure DATABASE_URL, CHAT_ENABLED, CHAT_ENVIRONMENT, CHAT_BUSINESS_ID,
CHAT_PUSH_ENABLED and CHAT_VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT. Never commit private keys.

Generated migrations 0100–0103 are applied to the disposable local database. In 0101,
the generated tenant/id unique index is ordered before the dependent composite FK,
which PostgreSQL requires. Drizzle reports no remaining schema drift. The new agent,
push-subscription and push-delivery tables are included in tenant RLS.

Validation: 24 Postgres/API integration tests, 3 alert-state tests, 2 service-worker
notification tests and 5 storefront adapter tests pass. Shared/database/API builds,
both web type checks and changed-file lint pass. Browser checks cover claim, availability,
visitor-to-staff and staff-to-visitor arrival, read cues, draft recovery after reload,
saved callback requests, completion, end-chat, and blocked notification permission.
Actual OS notification delivery and hardware audio output are not verified: the in-app
browser denies notification permission. Responsive CSS is present; physical mobile and
full production builds still require verification. No production database, real customer,
Shopify mutation, deployment, or paid service was used.

The workspace launcher starts or reuses Postgres 55439, API 4000, ERP 3000 and customer
preview 3100, and supervises the push worker. It uses synthetic fixture credentials and
local VAPID keys outside either repository. The local API harness substitutes an in-memory
rate limiter; application code still requires shared Redis. The local transport is bounded
SSE polling committed records, not an Ably-connected deployment. Ably outbox events remain
pending until an Ably worker is configured; these do not prevent local SSE delivery.

Remaining from the broader proposal: scoped location/team and assigned-only access,
automatic routing/transfer and assignment deadlines, configured hours/holidays and response
targets, a full customer/context panel with verified linking, reporting/satisfaction,
retention/deletion policy and tooling, provider token/subscription integration and capacity
proof, fresh upstream reconciliation, full build/mobile checks, and isolated staging rollout.
Attachments were explicitly later-phase. These are not represented as completed by this local
pilot. Seven-day guest expiry is not a transcript retention policy.

## Local completion — September 12, 2026

This section supersedes the earlier local feature and build gap lists.

Implemented automatic capacity-aware assignment, acceptance deadlines, explicit transfer,
assigned-only and location-scoped access with fresh permission checks, business settings,
Los Angeles opening hours/holidays, overdue response cues, saved replies, visitor topic
and showroom context, verified customer linking, response/resolution and satisfaction
reports, and explicit previewed retention deletion. Pending callbacks and active chats
are excluded from retention deletion. Customer links never grant visitor access to ERP
records. Migrations 0104–0105 and tenant RLS are applied locally.

The dedicated maintenance worker runs assignment expiry, snooze recovery and automatic
routing every three seconds. Start with `pnpm --filter @jetnine/api start:chat-maintenance`
after building; it uses DATABASE_URL, CHAT_ENABLED, CHAT_ENVIRONMENT and CHAT_BUSINESS_ID.
The prepared workspace launcher supervises both maintenance and push workers.

Validation: 31 Postgres/API integration tests, 3 alert-state tests, 3 service-worker tests
and 6 storefront adapter tests pass (43 focused tests). API build, both web TypeScript
checks and changed-file lint pass. Full production builds of both web applications pass
in isolated local copies with fixture-backed storefront data. Existing Sentry bundler
and storefront fixture warnings remain. Browser checks additionally confirmed settings
save, automatic assignment, owner acceptance, customer search, reply, end-chat and a
persisted satisfaction rating. Local development bypasses POS static caching to prevent
stale development chunks; production POS caching remains intact.

Local transport decision: bounded SSE refreshes committed Postgres records approximately
once per second and reconnects with sequence catch-up. Local use needs no Ably account.
The optional Ably publisher remains an external rollout option, not an activated managed
realtime client. Its outbox backlog does not block SSE. The local harness uses a test
in-memory rate limiter; deployment requires shared Redis and isolated credentials.

External verification limits: the embedded browser denies notification permission, so
actual OS push delivery and hardware audio output are unverified. Physical mobile device
and production traffic/load checks remain release validation. No staging or production
services were provisioned. Reconcile the storefront feature patches with actual upstream
history before rollout; never push its snapshot baseline. Attachments remain the
proposal's explicitly later phase. These limits do not prevent the local application
from running and being tested now.

## Shared incoming queue — September 13, 2026

Visitor start now asks only for a message; no showroom or topic selection. The local
business has sharedInbox=true and autoAssign=false. All chat-enabled staff can see
unassigned, location-free open/queued chats across stores. The first successful Accept
chat owns it; transaction locking and version checks prevent two winners. Store-scoped
owners retain access to their shared conversation. Existing location-tagged conversations
retain store restrictions. Public replies to shared chats require ownership.

New Chat Agent role: chat.view_assigned, chat.reply, chat.assign. Assign it (or equivalent
permissions) to participating store staff; no real member assignments were made. Chat
Receptionist remains available for team supervision. Keep the inbox open and enable sound
on each workstation for the browser chime. This does not add alerts to every other ERP page.
Background push remains opt-in and requires browser permission.

Verified: 33 API/database tests including different-user simultaneous accepts, shared
store visibility, ownership and rejection before acceptance; six adapter tests; API/shared
builds, both web type checks and changed-file lint. Browser confirmed the simple visitor
start and successful acceptance. No production deployment.

## Queue clarity and ERP-wide alerts - September 13, 2026

The business layout now owns the live chat provider. Chat sound, unread tracking,
desktop alerts and available-staff heartbeats continue across ERP page navigation.
A persistent alert outside the inbox shows unread/waiting counts and opens the
relevant conversation. Sound still requires an explicit browser gesture after a
full reload; browser notification permission remains optional.

Queue cards show the latest public visitor message, visitor-provided name when
available, reply waiting time, assignment name and an inline Accept action.
Unassigned open/queued chats sort oldest first. Accept retains the server's
version check and atomic first-accept protection, prevents repeated local clicks,
and reports a competing acceptance clearly. Private notes and staff replies never
appear in the queue preview. Global alerts contain counts only.

Validation: API build, ERP web typecheck, changed-file web/API lint and all 33
Postgres chat integration tests pass. Local browser verification covers persistent
sound and a new unread alert on the dashboard, then navigation to the matching chat.
