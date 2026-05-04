/* sw.js — Service Worker for Driver PWA */
const CACHE = 'gas-driver-v1';
const STATIC_ASSETS = [
  '/driver',
  '/static/driver.css',
  '/static/driver.js',
  '/static/manifest.json',
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API calls, cache-first for static
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for driver API calls
  if (url.pathname.startsWith('/driver/orders') || url.pathname.startsWith('/driver/cash')) {
    event.respondWith(
      fetch(event.request)
        .then(res => res)
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static files
  if (STATIC_ASSETS.some(a => url.pathname === a || url.pathname.startsWith('/static/'))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Default: network
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
