import { withSentryConfig } from '@sentry/nextjs';

/**
 * Where API traffic goes. The client fetches relative URLs (`/v1/...`,
 * `/api/auth/...`); Next rewrites proxy them to the NestJS service on
 * Render so the browser only ever talks to one origin. Same-origin keeps
 * better-auth's session cookie and the offline-POS `document.cookie` read
 * first-party — no CORS preflights, no SameSite=None, no Safari/ITP
 * blocking — at the cost of a proxy hop per API call.
 *
 * Override per environment with API_PROXY_TARGET (build-time env).
 * Setting NEXT_PUBLIC_API_URL back to an absolute origin bypasses the
 * proxy entirely, which restores the split-origin behavior of PR #21.
 */
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'https://jetnine-api.onrender.com';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@jetnine/shared', '@jetnine/ui'],
  /**
   * Inventory folded into Products (amendment A19, owner 2026-09-10): the
   * old section's URLs keep working for bookmarks, saved nav and tests.
   */
  async redirects() {
    return [
      { source: '/inventory', destination: '/products/stock', permanent: true },
      { source: '/inventory/counts', destination: '/products/counts', permanent: true },
      { source: '/inventory/counts/:id', destination: '/products/counts/:id', permanent: true },
      { source: '/inventory/receive', destination: '/products/receive', permanent: true },
    ];
  },
  async rewrites() {
    return [
      { source: '/v1/:path*', destination: `${apiProxyTarget}/v1/:path*` },
      { source: '/api/auth/:path*', destination: `${apiProxyTarget}/api/auth/:path*` },
      { source: '/health', destination: `${apiProxyTarget}/health` },
      { source: '/ready', destination: `${apiProxyTarget}/ready` },
    ];
  },
  /**
   * Service-worker headers. The browser refuses to register a worker
   * with a wider scope than the script's path unless the response
   * carries `Service-Worker-Allowed: /`. We also force a no-cache
   * policy on `/sw.js` itself so a deploy of a new worker isn't
   * shadowed by a stale cached copy at the edge — the worker's own
   * named caches (Phase 2.15) handle long-lived chunk caching.
   */
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Service-Worker-Allowed', value: '/' },
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
      {
        source: '/manifest.webmanifest',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=300, must-revalidate' }],
      },
    ];
  },
};

const sentryWebpackPluginOptions = {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  tunnelRoute: '/monitoring',
  hideSourceMaps: true,
  disableLogger: true,
};

const shouldWrapWithSentry =
  Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN) || Boolean(process.env.SENTRY_DSN);

export default shouldWrapWithSentry
  ? withSentryConfig(nextConfig, sentryWebpackPluginOptions)
  : nextConfig;
