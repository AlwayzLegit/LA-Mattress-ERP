# Live chat development

Started September 11, 2026, from ERP `bb212b547f64c985ffedbaf65b1c4515fc298798`.
The owner's live chat plan authorizes an additive human-operated chat module.
Existing sales, customer, order and approval workflows are unchanged.

## Slice 1: persistence foundation

This branch implements the database and service layer, not a deployed chat feature.
`ChatService` is intentionally not registered in `AppModule`. No chat HTTP endpoints,
staff inbox or storefront changes are included. A service method's return confirms
its database transaction committed; it does not confirm delivery to the recipient.

- Migration `0099_live_chat_foundation` adds integrations, sessions, conversations,
  messages and an outbox. New tables are registered in both RLS registries.
  Composite foreign keys prevent cross-business chat relationships. The generated
  migration moves three unique indexes before their referencing foreign keys;
  the schema snapshot is unchanged and generation reports no drift.
- Shared `chat.ts` defines version `1.0.0`, strict message validation, bounded
  history cursors and a visitor-safe message shape. This is the initial service
  contract; versioned OpenAPI and storefront type generation remain to implement.
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

## Next slices

1. Add dedicated worker leasing, backoff, replay and Ably change-event publishing;
   test restart after commit, lease expiry, duplicate delivery and stale lease completion.
2. Register disabled-by-default visitor/staff HTTP routes with guest authentication,
   fail-closed Redis limits, request redaction, metadata-only audit, origin policy,
   versioned OpenAPI and contract tests. Use explicit authorized history projections.
3. Add staff queues, conversation history, replies/notes and transactional claims,
   then assignment/capacity, read state, presence and deadlines.
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
are not yet delivered because there is no worker/transport in this slice.
