# ApexMile

A mobile-first **fuel-mileage tracker + live group-ride radar** for bikers, built as an installable PWA that runs in Chrome (Android) and Safari (iOS) and looks and feels like a native app once added to the Home Screen.

The deployable site lives entirely in [`app/`](app/). Open `app/index.html` through a local server, or deploy that folder to Cloudflare Pages.

---

## What is in the box

| Area | What it does |
|---|---|
| **Home** | Active-vehicle hero card, measured km/L, safe range, cost/km, altitude, district fuel rates, 91/95/100 octane pricing |
| **Refuel** | Odometer + amount entry with live litres calculation, full/partial tank honesty, ride-type tagging, editable history |
| **Ride radar** | MapLibre GL vector map (OpenFreeMap), two layer choices — **Live Traffic** (opt-in, own free TomTom key) and **Satellite** — long-press pin, live group riding |
| **Navigation** | Google-Maps flow — **Directions** → A→B preview → **Start** — in an immersive full-screen view (portrait and landscape), with a road-calibrated vector manoeuvre arrow, drawn turn symbols (no emoji), a heading-arrow puck, Car / Bike / Walk modes, per-mode ETAs, trip cost from the garage vehicle, toll estimate, turn-by-turn, arrival detection, off-route rerouting, voice prompts, screen wake lock |
| **Insights** | Full-tank mileage windows (partial fills never claim a km/L), mileage trend chart, cost/km by grade, range by ride type |
| **Garage** | Multiple bikes/cars, thumbnail photos, service interval, profile, CSV export |
| **Group ride** | 6-character rooms, QR/link/code invites, live rider markers and movement, quick messages, pack-gap alerts in both directions, statuses and SOS, captain destination and mode sync |
| **PWA** | Manifest, maskable icons, offline app shell, cached map tiles, safe-area layouts, standalone display |

### Mileage, honestly

A km/L figure is only produced from **full-tank to full-tank** windows. Partial fills are stored but excluded from the claim until the tank is full again. Implausible entries (outside 4–160 km/L) are saved but flagged and excluded. The hero card labels the number **measured** vs **estimate**.

### Navigation, without a misleading arrow

Starting guidance hides the app chrome and hands the whole viewport to the map (true fullscreen where the browser allows it, and a viewport-filling layout everywhere else, including iOS where element fullscreen does not exist). Both orientations are laid out with the safe-area insets: the instruction banner sits under the notch, the ETA card above the home indicator, and in landscape the card docks to the right while the floating controls move to the left.

The manoeuvre icon is a drawn arrow, not an emoji. The camera rotates so "up" is the direction of travel, so the arrow is rotated by *exit road heading − current map bearing*: it points where the rider must actually go on screen, including while the camera is easing through the turn. The location puck becomes a heading arrow during guidance and follows the road rather than jittery GPS bearing.

### Prices and tolls, honestly

The fuel card shows the **daily district rate** published by the oil marketing companies and republished by The Core's India Fuel Watch feed, fetched through a same-origin `/api/fuel-prices` route on the Cloudflare Worker and refreshed once a day. It is not a pump-level live feed — no open feed of individual outlet prices exists in India; the app says "today" only when today's district rate actually arrived and falls back to a dated baseline when the feed is unreachable. Manual corrections always win and are never overwritten.

Toll charges on the route sheet come from OpenStreetMap toll plazas and gantries along the corridor multiplied by a ₹95-per-plaza car rate. That is an estimate, labelled as one. It is not an NHAI or FASTag quote.

### Group riding, privately-ish

Ride telemetry carries your display name, role, mode, position, heading, speed and status — **never your phone number, vehicles, photos or fill-ups**. Transport is the public EMQX demo broker over WSS; rooms are six characters and unauthenticated, so treat the room code as the secret. The captain's destination is the only retained message, and ending a ride clears it. Location updates pause when the browser backgrounds the app; the last position is marked “not updating”, while a low-rate presence heartbeat keeps the room alive without coordinates.

---

## Deploy to Cloudflare Pages

The site root is **`app/`** — not the repository root.

### Option A — dashboard

1. Push this repository to GitHub.
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Pick the repo. Set:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `app`
4. Deploy. Cloudflare gives you `https://<project>.pages.dev`.

### Option B — Wrangler

```bash
npx wrangler pages deploy app --project-name apexmile
```

### Option C — Workers Builds (static assets)

The Cloudflare dashboard now creates **Workers** projects, and `npx wrangler deploy`
is the default deploy command there. A Pages-style “build output directory” does
not apply to a Worker, so the repo contains a root `wrangler.jsonc`:

```jsonc
{
  "name": "apexmile",
  "main": "./worker.js",
  "compatibility_date": "2026-10-17",
  "assets": { "directory": "./app", "binding": "ASSETS", "run_worker_first": true }
}
```

The Worker also serves `/api/places`, a five-minute edge-cached Photon
(OpenStreetMap) search proxy, and `/api/fuel-prices`, the daily fuel-feed proxy.
Every other request goes to the static assets. If deployed as Pages without the
Worker, place search falls back to Photon directly and fuel prices use their
public feed. In the Worker's build settings keep:

- **Build command:** none
- **Deploy command:** `npx wrangler deploy`
- **Root directory:** `/`

`_headers`, `sw.js` and the manifest are served from `app/` exactly as they are
on Pages. If you deploy `app/` as **Pages** instead, the app detects missing
Worker API routes: place search calls Photon directly and fuel prices use the
public feed.

The URL is `https://<worker-name>.<account>.workers.dev`; attach a custom domain
under **Settings → Domains & Routes**.

> A first build from a branch that does not contain `app/` (for example `main`
> before the app was merged) fails with *“Could not detect a directory containing
> static files”*. Merge the app first, or point the build at the branch that has it.

### After deploying

1. Open the HTTPS URL in **Safari (iPhone)** or **Chrome (Android)**.
2. **iPhone:** Share → *Add to Home Screen*. **Android:** ⋮ → *Install app* / *Add to Home screen*.
3. Launch from the home-screen icon. It opens full screen (no browser chrome), respects the notch and home indicator, and works offline for the app shell and previously viewed map areas.

Requirements for installability, already satisfied in this folder:

- HTTPS (Cloudflare provides it)
- `manifest.webmanifest` with 192/512 + maskable icons and `display: standalone`
- a service worker with a fetch handler (`sw.js`)
- `apple-touch-icon`, `apple-mobile-web-app-capable`, `viewport-fit=cover`
- `_headers` forces `application/manifest+json` for the manifest (some static hosts get this wrong)

> When you change any shell file, bump `VERSION` at the top of `app/sw.js`. The worker precaches by version and cleans old caches on activate.

---

## Local development

```bash
cd app
python3 -m http.server 8080
# open http://localhost:8080
```

`localhost` is treated as a secure context, so geolocation and the service worker work. A plain `file://` open will not register the worker and may block location.

No build step. The app is plain ES modules; vendor libraries are checked in under `app/assets/vendor/`.

### Tests used during development

- `node --input-type=module --check` on every module
- esbuild bundle (catches missing exports)
- jsdom smoke suites for boot/auth, vehicles, fill-ups, map + routing, group rides, invite links, sheets, long-press pins, map layers/traffic, vector turn symbols and end-of-guidance behaviour
- a pure mileage unit test for full-tank windows

There is no real browser or phone in the build sandbox, so Safari/Chrome rendering and device GPS were not physically exercised. The layout targets iOS 15.4+ / Chrome 111+.

---

## Architecture

```
app/
  index.html          app shell, screens, templates, CSP
  manifest.webmanifest
  sw.js               versioned shell + bounded tile cache
  _headers            Cloudflare Pages headers (manifest MIME, SW no-cache)
  css/app.css         tokens (light/dark), safe areas, map overlays, sheets
  assets/
    vendor/           maplibre-gl 5.24, mqtt.js, qrcode-generator
    icons/            SVG + PNG icons, maskable, apple-touch
  js/
    main.js           boot, auth/join, tabs, wiring
    store.js          versioned localStorage (apexmile.v11) + legacy import
    stats.js          full-tank windows, measured km/L, cost/range models
    bus.js            tiny event bus
    ui.js             DOM helpers, toasts, sheets, theme, install helpers
    geo.js            single GPS watcher, altitude smoothing
    map.js            MapLibre styles, markers, route layers, camera
    routing.js        curated local index + Photon search + submitted Nominatim fallback + routing
    journey.js        planned route state, stops, alternatives
    nav.js            turn-by-turn, announcements, reroute, progress
    navicons.js       vector manoeuvre/voice/group symbols
    rooms.js          MQTT rooms, peers, statuses, captain state
    sheets.js         every bottom sheet
    views.js          home/refuel/insights/garage rendering
    prices.js         daily fuel feed, freshness, manual override
    places.js         generated place + district price index
  worker.js (repo root)  cached /api/places + /api/fuel-prices + static assets binding
```

**Data** lives under one key, `apexmile.v11`; the v10 key (`apexmile.v10`) is migrated once, and the original prototype's key (`apexmile_map_radar_v9`) is imported once. Photos are downscaled and, if storage is full, dropped before any log is lost.

**Services**: OpenFreeMap vector styles, Esri World Imagery for satellite, Carto raster fallback, Photon interactive search, Nominatim explicit-search fallback, OSRM/Valhalla routing, Overpass toll plazas, The Core's daily fuel-price JSON and Photon queries through the Worker, and the public EMQX/HiveMQ/Mosquitto MQTT brokers are keyless. **Live traffic** is the one opt-in exception: paste a TomTom key in Ride settings. Public search/routing services are best-effort; no OSM-based index guarantees the coverage of Google's proprietary Places directory.

## Known limits

- The public routing/search/broker services have no SLA. Photon and Nominatim use OpenStreetMap data; a small private apartment or enclave may be unmapped. Try the extended-search submission, add the place to OSM, or use a map pin. Google-level completeness requires a licensed provider and API key/billing.
- The continuous GPS watch runs only while Radar is open or a group ride is active; other tabs use no continuous watch. Outside guidance, Radar uses the browser's lower-power passive profile. High-accuracy GPS is enabled only during guidance, and all tracking pauses while the app is hidden. The radar is a foreground aid, not a satellite tracker or emergency service. SOS is a status flag, not a call for help.
- The screen, cellular radio, GPS and GPU are still substantial power/heat sources during long navigation. The app throttles camera/route redraw work and avoids idle high-accuracy tracking, but cannot control screen brightness, device thermal limits or background policy.
- There is no ApexMile account/data backend or push-notification service. The Worker only proxies/caches public place and fuel responses; local records stay on-device, while the group-ride and search requests described above go to their third-party services.
- Turn-by-turn times are OSRM estimates without live traffic. The Live Traffic layer is a visual flow overlay: it does not re-time the route or the ETA.
- Fuel prices are the daily district rate, not the price at a specific pump; tolls are an OSM-based estimate, not a FASTag/NHAI quote.
- iOS opens shared invite links in Safari rather than inside the installed PWA; the room code and in-app *Join a ride* screen cover that gap.

## Licence / attribution

Map data © OpenStreetMap contributors (ODbL). OpenFreeMap, Esri, CARTO, OSRM, Photon and Nominatim attributions are shown on the map, in the search list or in the privacy screen. Do not remove them. `app/` is the maintained implementation; the original single-file prototype was used only as the source for the audit (`REVIEW.md`) and the place/price index.
