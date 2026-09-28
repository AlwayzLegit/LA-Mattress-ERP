/**
 * Options for the jetnine.active_business_id cookie, shared by
 * POST /v1/auth/active-business and the TenancyGuard's single-business
 * fallback.
 *
 * Deliberately readable from JavaScript. The offline POS layer reads this
 * cookie directly — `readActiveBusinessId()` in `apps/web/src/lib/offline.ts`
 * — to partition the IndexedDB sale queue and variant cache by tenant.
 * Marked `httpOnly` it was invisible to `document.cookie`, so `businessId`
 * was always null in the browser and every Phase 2.16 path silently died.
 *
 * Safe to expose: the value is a business id the caller was already proven
 * a member of, and it grants nothing on its own — TenancyGuard re-resolves
 * membership from the session on every request, and RLS enforces the
 * boundary in the database besides. The session cookie stays httpOnly;
 * this one is a UI hint.
 */
export function activeBusinessCookieOptions(production: boolean) {
  return {
    httpOnly: false,
    sameSite: 'lax' as const,
    secure: production,
    path: '/',
    // 30 days. It used to be the only record of the choice, so on day 31 a
    // still-signed-in user got "No active business selected" on every
    // screen (owner 2026-09-28). The guard now re-creates it for anyone
    // who belongs to exactly one business.
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}
