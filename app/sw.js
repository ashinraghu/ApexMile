/* ApexMile service worker.
 * Shell-first cache so the app opens instantly and works offline; map tiles get
 * their own bounded cache; routing and search stay network-only by design.
 */
const VERSION = 'apexmile-v11.2.2';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-tiles`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './assets/vendor/maplibre-gl.css',
  './assets/vendor/maplibre-gl.js',
  './assets/vendor/mqtt.min.js',
  './assets/vendor/qrcode.js',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png',
  './js/bus.js',
  './js/store.js',
  './js/stats.js',
  './js/ui.js',
  './js/geo.js',
  './js/map.js',
  './js/routing.js',
  './js/tolls.js',
  './js/nav.js',
  './js/navicons.js',
  './js/rooms.js',
  './js/journey.js',
  './js/places.js',
  './js/prices.js',
  './js/sheets.js',
  './js/views.js',
  './js/main.js',
];

const TILE_HOSTS = [
  'tiles.openfreemap.org',
  'basemaps.cartocdn.com',
  'tile.openstreetmap.org',
  'server.arcgisonline.com',
];
const TILE_LIMIT = 700;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll is atomic; one typo would throw away the whole install. Add one by
    // one so a missing icon can never block the update.
    await Promise.all(SHELL_FILES.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch { /* optional */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => !k.startsWith(VERSION))
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never let the broker or auth flows enter a cache.
  if (url.protocol === 'wss:' || url.hostname === 'broker.emqx.io') return;

  // Fuel prices are live data: always go to the network, never the shell cache.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Navigation: network first, then the cached shell. This is what makes
  // "added to home screen" survive a dead connection.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  if (TILE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    event.respondWith(tileStrategy(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(assetStrategy(request));
  }
});

async function assetStrategy(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    // Revalidate quietly for the next launch.
    event_fetch_update(cache, request);
    return cached;
  }
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    return cached || Response.error();
  }
}

function event_fetch_update(cache, request) {
  fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone()).catch(() => {});
  }).catch(() => {});
}

async function tileStrategy(request) {
  const cache = await caches.open(TILES);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      cache.put(request, fresh.clone()).catch(() => {});
      trimTiles(cache);
    }
    return fresh;
  } catch {
    return cached || Response.error();
  }
}

let trimScheduled = false;
function trimTiles(cache) {
  if (trimScheduled) return;
  trimScheduled = true;
  setTimeout(async () => {
    trimScheduled = false;
    try {
      const keys = await cache.keys();
      const excess = keys.length - TILE_LIMIT;
      for (let i = 0; i < excess; i += 1) await cache.delete(keys[i]);
    } catch { /* cache may be evicted */ }
  }, 4000);
}
