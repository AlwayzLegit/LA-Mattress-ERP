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
