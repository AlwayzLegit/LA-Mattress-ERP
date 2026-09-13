# Live chat rollout checklist

Prepared September 13, 2026. **ERP release update:** use `codex/chat-erp-release` and its consolidated `0105_live_chat` migration after upstream 0104. The original local 0099–0109 sequence must not be deployed. See [ERP release candidate](erp-chat-release.md). Local implementation is verified; staging and production have not been deployed.

## Verified locally

- Visitor chat, shared incoming queue, first-person acceptance, specialist help, private discussions, and team channels are implemented.
- The consolidated migration 0105 includes background push for help invitations and unread internal messages. Existing visitor push remains supported.
- 37 API integration tests and 8 service-worker tests pass, including privacy, read suppression, revoked access, store scopes, stale ownership, retries, and subscription cleanup.
- Database/API builds and both Next.js production builds pass. Builds used isolated source copies; storefront data was fixtures and tracking was disabled.
- Existing warnings remain outside this chat change: ERP Sentry/OpenTelemetry bundling and unrelated lint; storefront edge/static configuration and local inventory fixture counts.

## 1. Prepare the actual release branches

Fetch and reconcile each current upstream project before merging the local chat commits. The ERP release branch is `codex/chat-erp-release` (reconciled through `f884801`); the storefront release branch is `codex/chat-storefront-release` (reconciled through `2dadf08`, with widget phases 1 and 2 included). Review only the intended chat changes against the current projects. Do not deploy the entire historical storefront snapshot over newer upstream work.

The authenticated ERP design was compared with the release shell during preparation. Local chat uses the upstream design tokens/fonts. Re-run builds and scoped tests after any further upstream reconciliation.

## 2. Create an isolated staging pilot

Provision separate staging database, Redis, API, ERP frontend, storefront preview, and supervised worker processes. Use staging-only integration credentials, origins and VAPID keys; store secrets in the deployment platform. Do not copy the local harness, synthetic accounts, in-memory limiter, or files containing local credentials into production.

ERP API configuration includes `DATABASE_URL`, `REDIS_URL`, `CHAT_ENABLED`, `CHAT_ENVIRONMENT=staging`, and `CHAT_STAFF_ORIGINS` with the exact HTTPS ERP origin. Preserve existing authentication/session configuration. ERP frontend requires `NEXT_PUBLIC_LIVE_CHAT_ENABLED=true` and its build-time `API_PROXY_TARGET` pointing to that API.

Create a chat integration for the staging business with its staging environment, exact storefront origin, and separately stored credential. Configure the storefront with:

- `NEXT_PUBLIC_LIVE_CHAT_ENABLED=true`
- `LIVE_CHAT_ENABLED=true`
- `LIVE_CHAT_SITE_ORIGIN` = staging storefront HTTPS origin
- `LIVE_CHAT_ERP_URL` = staging API URL
- `LIVE_CHAT_INTEGRATION_ID` and server-only `LIVE_CHAT_INTEGRATION_SECRET`

Use the normal staging storefront catalog configuration. The fixture build is not evidence of a working live catalog integration. Ordinary Vercel Preview deployments are read-only in this storefront; a connected pilot requires an isolated staging application environment with staging services. Preserve the fixture/review guards and do not connect a writable pilot to production data.

For background push, API and push worker need `CHAT_PUSH_ENABLED=true`, `CHAT_VAPID_PUBLIC_KEY`, `CHAT_VAPID_PRIVATE_KEY`, and `CHAT_VAPID_SUBJECT`. Workers also need the correct `CHAT_BUSINESS_ID`, database and environment. Keep the VAPID private key server-side and stable across releases.

Configure Ably and its server-side `ABLY_API_KEY` for the existing public-message outbox worker. The local preview uses SSE against committed records; it has not verified Ably delivery. Team rooms use authenticated polling. Check hosting proxy timeouts/reconnection for the existing SSE endpoints.

## 3. Release in order

1. Keep chat gated off while preparing the first staging release. Back up the database and review generated migrations through 0105_live_chat against the staging schema.
2. Pause existing chat workers during a chat upgrade. Build shared/database/API packages, then apply migrations using the repository's database migration command (`pnpm --filter @jetnine/db migrate`). Verify tenant RLS is applied by that migration flow.
3. Deploy the matching API and ERP frontend, including the new `/sw.js`. Refresh pilot browsers so the updated service worker is active before testing internal notifications.
4. Start supervised processes from the matching API build: `start:chat-maintenance`, `start:chat-push-worker`, and `start:chat-worker` using `pnpm --filter @jetnine/api`. Each worker is configured for one business/environment. Monitor process exits and queue backlog.
5. Deploy the matching storefront preview with its staging integration credentials. Enable the chat gates and business settings for the pilot.
6. Assign test staff intentionally: Chat Agent for specialists, Chat Receptionist for coverage, and a manager only where administration is needed. Set current store scopes. Enable shared inbox assignment so every eligible store can accept new visitor chats without a showroom selector.

Background push is an explicit per-browser opt-in. Web Push can reach a service worker when the web app is not loaded, subject to browser support, permission and OS behavior; actual device tests are required. See [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).

## 4. Run the staging acceptance test

- Two specialists at different stores receive a new visitor chat. Simultaneous acceptance assigns exactly one owner; the other UI updates.
- Public messages, reconnects, unread indicators, available/away state, and ERP-wide alerts work across navigation.
- Request specialist help, accept it, exchange private messages and a suggestion, then finish it. The visitor receives none of the internal content.
- Test help desk questions/claim/resolve, store scope denial, direct-message privacy, and saved-answer reuse.
- On each supported staff device, explicitly enable push. Close all ERP tabs, send a visitor message, help request, and direct message from another account. Verify generic notification text and click-through into the correct authenticated business inbox. Read a message before its delayed push and confirm suppression.
- Disable/revoke notification permission; test expired subscription cleanup. Revoke staff access and store scope and confirm subsequent delivery is suppressed.
- Verify maintenance and delivery worker health, retry controls, database/Redis connectivity, origin restrictions, and integration revocation. Test the kill switches and recover without losing chat history.

Record device/browser results and operational ownership. The owner does not need to staff the inbox; designate receptionist coverage and a technical owner for worker failures.

## Production gate and rollback

Only after staging passes, repeat the setup with production-specific URLs, credentials, database backup, staff scopes and worker supervision. Deploy ERP/API/workers before exposing the storefront widget. Enable for a limited staffed pilot, monitor unassigned wait time and delivery failures, then expand.

If problems occur, turn off the storefront widget and disable chat API/push gates as appropriate; stop affected workers. Preserve data and diagnose before replaying failed work. Do not downgrade to a worker that assumes every delivery has a visitor conversation after internal push jobs exist. Prefer a forward fix or the matching compatible release; schema rollback requires a separately reviewed data plan.

The paired release test loads the actual storefront adapter and calls this release's visitor HTTP controller against the isolated release database. It verifies session isolation, start retry, concurrent acceptance, ownership, private-note exclusion, streamed replies, recommendation variant links, consented follow-up capture, rating, and the storefront kill switch. Set `CHAT_STOREFRONT_ROOT` to the absolute storefront release checkout to include it in `test/chat.int.spec.ts`; otherwise it skips. Staff actions use the real service; Redis is stubbed for this test.

Outstanding: refreshing upstream before merge, staging resources/credentials and staff, real catalog and hosted streaming checks, physical push/provider verification, backup/restore validation, and production rollout approval. No staging or production deployment was performed by the local readiness work.
