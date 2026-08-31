// Spec §11 M6 / §3's "known trade-off": a minimal, hand-written service
// worker — deliberately not vite-plugin-pwa/Workbox, so there is no
// build-time precache manifest or library structure for a future
// maintainer to lean on. This comment block IS that missing structure —
// read it in full before changing anything below.
//
// What gets cached, and what never does:
//
//  CACHED (network-first, falling back to the cache when the network
//  fails): a same-origin GET for anything that is NOT under `/api/`.
//  That's the app shell — index.html, the built JS/CSS bundles, and
//  static files under public/ — which is what lets the SPA boot at all
//  on a reload while offline. Every successful response is written back
//  into the cache as it's served, so the cache is always the *last
//  successfully loaded* shell, never a stale build baked in ahead of
//  time.
//
//  NEVER CACHED — these requests are left completely untouched (no
//  `event.respondWith` call at all, so the browser handles them exactly
//  as if this service worker didn't exist):
//    - Anything under `/api/*`. Every live data read/write goes through
//      apps/web/src/lib/api.ts, which already has its own offline
//      fallback for the one screen spec calls out for a read-only
//      offline view (Command Center) — see lib/dashboardCache.ts, a
//      localStorage snapshot taken after each successful load. A
//      SW-cached API response would (a) silently break "read-only" the
//      instant it served a GET whose underlying data had since changed
//      elsewhere, and (b) need real cache-invalidation logic this file
//      does not have. Do not route /api/* through this cache without
//      solving that first.
//    - Any cross-origin request (Supabase realtime, etc.) — this worker
//      has no business caching another origin's responses.
//    - Any non-GET request (POST/PATCH/PUT/DELETE) — caching a write is
//      never correct, full stop.
//
// Cache invalidation: CACHE_NAME is versioned. The network-first
// strategy already means a new deploy wins over whatever's cached the
// instant the device is online — the normal case — with no version bump
// needed for that. Bump the version suffix only when this file's
// *caching behavior itself* changes; `activate` below deletes every
// cache that doesn't match the current CACHE_NAME, which is what
// actually clears out anything cached under old logic.
const CACHE_NAME = 'lwwbr-shell-v1';

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every existing tab
  // to close — the cached shell is only ever a fallback for when the
  // network fails, so there's no correctness reason to delay activation.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

// The one place that decides cacheable vs. bypassed — see the file-level
// comment above for exactly why each branch exists. Keep every criterion
// here, not scattered into the fetch handler, so this stays the single
// place a future change to scope has to touch.
function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  if (!isCacheableRequest(event.request)) {
    return; // No respondWith — falls through to normal browser handling.
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only cache a genuinely successful response. Caching a 404/500
        // (or an opaque cross-origin response, which reads as ok:false
        // here as a same-origin check has already excluded those) would
        // mean serving a broken shell the next time the network fails.
        if (response.ok) {
          const responseCopy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseCopy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then((cached) => cached || caches.match('/index.html')),
      ),
  );
});
