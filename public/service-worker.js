/**
 * RePro service worker
 *
 * Two-tier cache strategy:
 *   - App shell (HTML/CSS/JS/icons): cache-first. Fast loads, works offline.
 *   - API calls (/api/*): network-first with cache fallback. Always
 *     try the network for fresh data, but fall back to last-known
 *     cached response if the device is offline so the app still loads
 *     instead of breaking.
 *
 * Cache version is bumped on every release that changes any cached file
 * — the activate handler then deletes any older caches so users always
 * get fresh code on first load after a deploy.
 */
const CACHE_VERSION = 'repro-v3';

// Files to pre-cache so the app shell loads even on a cold offline start
const APP_SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/jobs.html',
  '/candidates.html',
  '/learn.html',
  '/training.html',
  '/publishing.html',
  '/profile.html',
  '/team.html',
  '/admin.html',
  '/css/styles.css',
  '/js/api.js',
  '/js/i18n.js',
  '/manifest.json',
  '/assets/logo.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) =>
        // Catch-all so a single 404 (for an icon that doesn't exist yet
        // during initial deploy) doesn't fail the entire install.
        Promise.all(APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('SW pre-cache miss:', url, err.message))
        ))
      )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET — POST/PUT/etc go straight through
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Skip cross-origin requests (CDN scripts etc.)
  if (url.origin !== self.location.origin) return;

  // API requests: COMPLETELY transparent. We don't cache, intercept,
  // or even observe them. The server is always source of truth and
  // we don't want to risk serving stale auth-bound data.
  if (url.pathname.startsWith('/api/')) return;

  // Uploaded images served from the volume — also let through directly.
  if (url.pathname.startsWith('/uploads/')) return;

  // App shell + static assets: cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cache successful fetches of in-origin assets we didn't pre-cache
        if (res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() =>
        // Last-resort offline fallback for navigation: return the cached homepage
        req.mode === 'navigate' ? caches.match('/index.html') : Response.error()
      );
    })
  );
});

// Listen for "skipWaiting" message from a new tab so the user can force
// a refresh after a deploy without closing all tabs.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
