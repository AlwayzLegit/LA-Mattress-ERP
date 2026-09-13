# ERP chat release candidate

September 13, 2026. Branch: `codex/chat-erp-release`. Reconciled with upstream `f884801387131ce6db82f8de9a25e2b938852d67`.

## Release contents

The ERP API, inbox, shared first-person acceptance, specialist help, team channels, ERP-wide alerts, and background push are included. The website project is a separate release. Chat remains opt-in through API and frontend flags.

The current ERP shell, acting-store provider, design tokens, fonts, and component kit are preserved. Chat now inherits the global design tokens rather than carrying a second copy. The Live chat navigation entry is feature-gated and available in both normal and cashier navigation, subject to hidden tabs; server permissions continue to control access.

The shared cause-aware logger now explicitly serializes requests and responses. Otherwise `wrapSerializers: false` exposed raw headers through nested Node request objects outside the redaction paths. A regression test verifies chat session credentials are redacted while the existing Postgres cause/SQLSTATE tests still pass.

## Migration identity — use this branch for release

Production upstream already owns migration numbers 0099–0104. The original chat branch's 0099–0109 migrations were local-only and collided with that history. This release preserves every upstream migration and replaces the undeployed chat sequence with **0105_live_chat**, containing the final 14 chat tables. Composite unique keys are created before their foreign keys. No existing ERP data tables are changed by 0105.

Do not run this release's migrations against the original local preview database, which already has the old chat migration history. Release tests use a separate UTF-8 `jetnine_chat_release` database. Any environment that has received the old local chat migrations needs a separately reviewed history/data conversion before using this release.

## Verification

- Shared, database, and API builds passed.
- Full ERP Next.js production build passed with existing unrelated Sentry/OpenTelemetry and page lint warnings.
- All 36 chat API integration tests passed against the complete reconciled migration history in the isolated database.
- Three shared-logger tests and ten navigation/service-worker tests passed.
- Migration generation reports no schema drift; chat diff whitespace check passes against upstream.
- Authenticated live ERP reviewed at `/dashboard`, visible build `1b60b5a`: Public Sans, warm background, navy accent, five sidebar groups, acting-store control. Its older open POS tab still showed an older build and was left untouched.
- Production-build local preview at `http://localhost:3002/chat`: current ERP shell and local chat queue render, connected indicator is Live, team workspace opens. This visual preview proxies the original synthetic API on port 4000; new release API behavior is covered by the isolated integration suite, not a deployed staging pilot.

## Before merging or enabling production

Wait for remote CI and review the final diff against current main. Reconcile again if upstream acquires migration 0105 before merge. Confirm target API migration history from deployment logs, backup and restore procedures, Redis, supervised maintenance/push/Ably workers, environment-specific integration credentials and VAPID keys. Configure and test staff roles and store scopes intentionally; no real account permissions have been changed.

The Vercel project and deployment history were read through the connector. No hosting configuration was modified. Render service configuration, secrets, backups and worker provisioning have not been verified live. Next step is the isolated ERP staging pilot described in [live-chat-deployment.md](live-chat-deployment.md), using **0105_live_chat** from this release branch. Physical push delivery remains a real-device acceptance test.
