/* sw.js — Service Worker for Driver PWA — network-first */
const CACHE = 'gas-driver-v2';
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

// Activate: clean old caches + take control immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: NETWORK-FIRST for everything — cache only as offline fallback
// Previously was cache-first which served stale code after deploys
self.addEventListener('fetch', event => {
  // Don't intercept POST/PUT/DELETE
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(res => {
        // Update cache in background for static assets
        if (res.ok && event.request.url.includes('/static/')) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => {
        // Network failed (offline) — try cache as fallback
        return caches.match(event.request);
      })
  );
});
