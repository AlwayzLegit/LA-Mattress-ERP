/* eslint-disable no-restricted-globals */
/**
 * Jetnine POS service worker.
 *
 * Strategy:
 *   - Static Next.js chunks (/_next/static/*) — cache-first. Paths
 *     are content-hashed so they're safely immutable; the activate
 *     step prunes any cache that doesn't match the current SW
 *     version.
 *   - POS shell navigations (HTML for /pos and /pos/*) —
 *     stale-while-revalidate. Cached HTML loads instantly even
 *     offline; a fresh fetch updates the cache for next time.
 *   - Everything else (API calls, OAuth callbacks, sign-in pages,
 *     other routes) — passes through. We do NOT cache anything
 *     that returns auth-bearing or tenant-specific JSON; the
 *     offline lib handles its own queue + cache via IndexedDB.
 *
 * Cache versioning: bump SHELL_CACHE/STATIC_CACHE strings together
 * to force a clean slate. The activate step deletes any cache name
 * that doesn't match the current pair.
 */

const VERSION = 'v1';
const SHELL_CACHE = `jetnine-shell-${VERSION}`;
const STATIC_CACHE = `jetnine-static-${VERSION}`;
const KEEP = new Set([SHELL_CACHE, STATIC_CACHE]);

self.addEventListener('install', () => {
  // New SW activates immediately rather than waiting for all old
  // tabs to close. Combined with clientsClaim, this means a deploy
  // takes effect on the next page load.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KEEP.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  // Development chunk names are stable, so caching them serves stale application code.
  if (['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname)) return;
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't touch cross-origin (the API lives on a different origin).
  if (url.origin !== self.location.origin) return;

  // Don't cache auth flows — they need a fresh round-trip every time.
  if (url.pathname.startsWith('/api/auth/')) return;

  // Hashed Next.js static chunks: cache-first, write-through.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // POS shell + the pending tray. We deliberately scope the
  // navigation interceptor to /pos so the rest of the back office
  // (which expects fresh server-rendered HTML) isn't affected.
  if (req.mode === 'navigate' && url.pathname.startsWith('/pos')) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // Manifest + favicon — also static, cache-first.
  if (url.pathname === '/manifest.webmanifest' || url.pathname === '/favicon.ico') {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Otherwise: default fetch (no SW intervention).
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    // Ultimate fallback for static chunks if we have nothing — let
    // the browser see the failure so it can show its offline UI.
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      // Only persist successful HTML responses.
      if (res.ok && res.status < 400) {
        cache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => null);
  // Prefer cached for instant paint when offline; if no cache, wait
  // for the network and fall back to a synthesized minimal page.
  if (cached) return cached;
  const fresh = await network;
  if (fresh) return fresh;
  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Offline</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;padding:24px;color:#222}</style>
</head><body>
<h1>You're offline</h1>
<p>The register hasn't loaded this page yet, so there's nothing to show.
Reconnect once and the page will be cached for next time.</p>
</body></html>`;

// Chat push contains no transcript, customer details or cross-origin destinations.
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  if (data?.type !== 'chat') return;
  event.waitUntil(
    self.registration.showNotification('LA Mattress · New chat', {
      body: 'A website visitor is waiting. Open the inbox to reply.',
      tag: typeof data.tag === 'string' ? data.tag : 'la-chat',
      data: { url: '/chat' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  if (event.notification.data?.url !== '/chat') return;
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find(
        (client) =>
          new URL(client.url).origin === self.location.origin &&
          new URL(client.url).pathname === '/chat',
      );
      if (existing) return existing.focus();
      return self.clients.openWindow('/chat');
    })(),
  );
});
