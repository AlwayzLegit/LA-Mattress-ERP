# Owner dashboard website statistics

Requested September 14, 2026. The ERP owner home now includes a Website statistics area covering all eleven sections in the website's admin navigation.

## Coverage and behavior

Overview, Revenue, Customers, Conversion, Chat, Traffic, Attribution, Store actions, Calls, Catalog & search, and Site health use the existing website provider functions. Shopify, PostHog, Clarity, and Callcap credentials remain on the website server. The ERP receives projected metrics and tables through a read-only service endpoint; it does not scrape the admin HTML.

The website period selector supports 7, 30, and 90 days. Statistics are sitewide and deliberately independent of ERP store/sales filters. Provider windows are preserved: many source functions use rolling days, the purchase funnel and calls use Pacific calendar boundaries, entry pages always use seven days, Clarity uses three days with six-hour caching, and catalog/lifetime reports have their own snapshot/sample scope. These differences are disclosed in the UI. Phone coverage limitations are retained.

Money crosses the contract as integer cents. Ratio values (0–1) and percentage values (0–100) are separate formats. Missing data displays as unavailable or an em dash; actual zero remains zero. Website and ERP sales are displayed separately to avoid double-counting imported orders.

## Integration

- ERP: GET /v1/dashboard/website?section=overview&days=30
- Website: GET /api/erp/website-stats?section=overview&days=30
- Contract: version 1. Website projects only explicit metric/table fields; contact information, recovery URLs, raw call records, session identifiers, and provider diagnostics are excluded. Relevant customer display names remain available to the owner.
- ERP requires an authenticated human owner (or authorized super admin), all-store data scope, and reports.financial.view. API keys and ordinary members are denied.
- Both servers bind the connection to the same ERP business UUID. The website endpoint requires a dedicated server-side bearer credential and x-erp-business-id. Website admin passwords and chat credentials are not reused.
- ERP validates the response schema, business, section, period, and a 1 MB response limit. It rejects redirects, uses a 45-second request timeout, deduplicates requests, and caches successful reports for 60 seconds. Authorization is checked before cache access. Failures are not cached.
- Browser responses are private/no-store. Fixture and review storefront modes disable the real feed. There is no public fixture endpoint in production.

## Paired release configuration

No production configuration or deployment was performed during implementation.

Set a newly generated random secret of at least 32 characters in the hosting secret stores, using the same value on both sides:

| Host           | Variable                      | Value                                |
| -------------- | ----------------------------- | ------------------------------------ |
| Website Vercel | ERP_WEBSITE_STATS_TOKEN       | Dedicated read-only secret           |
| Website Vercel | ERP_WEBSITE_STATS_BUSINESS_ID | Actual LA Mattress ERP business UUID |
| ERP Render API | WEBSITE_STATS_TOKEN           | Same dedicated secret                |
| ERP Render API | WEBSITE_STATS_BUSINESS_ID     | Same business UUID                   |
| ERP Render API | WEBSITE_STATS_ORIGIN          | https://mattressstoreslosangeles.com |

Do not commit real values or expose the token through NEXT_PUBLIC variables. This integration does not require copying Shopify/PostHog/Clarity/Callcap credentials into ERP.

After approval, deploy the website feed and configuration, then the ERP API and frontend. The ERP frontend alone cannot make the feature live: it depends on the matching API and website feed. A preview against the old production API will show an unavailable state.

Verify the signed-in owner can open all sections, match selected source figures with website admin using the same period, and confirm a non-owner and a different business are denied. Remove/rotate the dedicated token to revoke the connection; the ERP cache lasts at most one minute. No schema migration is required.

## Validation

- Website feed boundary/projection/loader tests cover all eleven sections, allowed periods, provider failures, credential and business binding, fixed windows, coverage notes, and value units.
- ERP tests cover owner/tenant authorization before cache access, response validation, cache behavior, failure recovery, bounded responses, origin validation, and endpoint permission metadata.
- A local paired fixture harness runs the actual website loader with synthetic provider responses and validates all 33 section/period combinations with the ERP schema.
- Next.js builds and applicable type checks run in both repositories. Website builds use fixture/review mode with no production credentials.
- Browser checks use only the local synthetic reports. They do not establish live provider parity or physical-device behavior.

Source references: AlwayzLegit/LA-Mattress-Headless app/admin/\_dashboard.tsx, lib/dashboard/sections.ts, app/admin/{attribution,calls,store-actions}/page.tsx. The website admin UI is unchanged.

## Implementation verification — September 14, 2026

- Website: 11 focused tests passed; ERP API: 21 focused tests passed.
- All 33 section/period payloads from the actual website loader passed the ERP response schema with synthetic providers.
- ERP API, ERP web, and website type checks passed. ERP API/web and website production builds passed; website build used fixture/review mode without production credentials.
- ERP formatting passed with checkout line endings normalized to LF, matching Linux CI. Four existing chat files received formatting-only corrections for the current main CI failure.
- Local browser checks covered all eleven sections, 7/30-day selection, currency and rate formatting, desktop and 390/320px widths, source failures and retry. No browser console errors were observed.
- Live owner login and production metric parity still require the approved paired release and production configuration.
