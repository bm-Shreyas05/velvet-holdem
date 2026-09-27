/*
 * Velvet service worker: makes the game playable offline and installable.
 *
 * The whole game is one HTML file, so the strategy is simple: precache it and the app assets
 * under a cache named after the build, serve from that cache first, and delete older caches when
 * a new build activates. The build stamps in the version (a content hash) and asset list, so any
 * change to the game produces a byte-different worker and the browser installs the update.
 */
const VERSION = '__VERSION__';
const CACHE = `velvet-${VERSION}`;
const ASSETS = __ASSETS__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('velvet-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // Any page load inside the scope is the game itself (query strings and #dev included).
    event.respondWith(caches.match('./', { cacheName: CACHE }).then((hit) => hit ?? fetch(request)));
    return;
  }
  event.respondWith(
    caches.match(request, { cacheName: CACHE, ignoreSearch: true }).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
