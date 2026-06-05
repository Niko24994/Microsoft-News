// Service Worker – Microsoft Roadmaps & Releases
// Strategy: network-first for JSON data, cache-first for static shell assets.

const CACHE   = 'ms-news-v2';
const SHELL   = [
  './',
  './index.html',
  './app.js',
  './style.css',
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

  // News JSON files → network-first (fresh data is important)
  if (url.pathname.includes('/public/news/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else → cache-first (shell, icons, fonts)
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
