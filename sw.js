// Service Worker – Microsoft Roadmaps & Releases
// Strategy: network-first for the HTML/JS/CSS shell + news data (so every
// visit gets the latest deploy while online — a cache-first shell was
// causing index.html/app.js/style.css to never refresh from the network
// at all once installed); cache-first only for rarely-changing assets
// (icons, manifest).

const CACHE   = 'ms-news-v3';
const SHELL   = [
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install: pre-cache the app shell ─────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

// ── Activate: remove stale caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests on the same origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // HTML page loads + app.js/style.css + news JSON → network-first, so a
  // new deploy is picked up on the very next visit instead of being stuck
  // behind a stale cached shell indefinitely.
  const isCoreAsset = request.mode === 'navigate' ||
    url.pathname.endsWith('/app.js') || url.pathname.endsWith('/style.css');
  if (isCoreAsset || url.pathname.includes('/public/news/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else (icons, manifest) → cache-first, rarely changes
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return caches.match(request) || Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}
