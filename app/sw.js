// ApexMile High-Performance Offline PWA Service Worker (100MB Tile Cache)
const CACHE_NAME = 'apexmile-v11.7.0';
const TILE_CACHE = 'apexmile-tiles-v11.7.0';
const MAX_CACHED_TILES = 2200; // ~100MB storage ceiling

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/mqtt/dist/mqtt.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== TILE_CACHE) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Map Tile Caching (Google & OpenStreetMap Tiles)
  if (url.hostname.includes('google.com') || url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const networkRes = await fetch(event.request);
          if (networkRes.status === 200) {
            cache.put(event.request, networkRes.clone());
            // Enforce 100MB bound
            cache.keys().then((keys) => {
              if (keys.length > MAX_CACHED_TILES) cache.delete(keys[0]);
            });
          }
          return networkRes;
        } catch (e) {
          return cached || new Response('', { status: 408 });
        }
      })
    );
    return;
  }

  // App Shell & API Cache-First / Network-Fallback
  event.respondWith(
    caches.match(event.request).then((res) => res || fetch(event.request))
  );
});