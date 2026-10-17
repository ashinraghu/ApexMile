# ApexMile

A mobile-first **fuel-mileage tracker + live group-ride radar** for bikers, built as an installable PWA that runs in Chrome (Android) and Safari (iOS) and looks and feels like a native app once added to the Home Screen.

The deployable site lives entirely in [`app/`](app/). Open `app/index.html` through a local server, or deploy that folder to Cloudflare Pages.

---

## What is in the box

| Area | What it does |
|---|---|
| **Home** | Active-vehicle hero card, measured km/L, safe range, cost/km, altitude, district fuel rates, 91/95/100 octane pricing |
| **Refuel** | Odometer + amount entry with live litres calculation, full/partial tank honesty, ride-type tagging, editable history |
| **Ride radar** | MapLibre GL vector map (OpenFreeMap), satellite layer, long-press pin, fuel/food/repair POIs, live group riding |
| **Navigation** | OSRM turn-by-turn with alternatives, stops, ETA, arrival detection, off-route rerouting, voice prompts, screen wake lock |
| **Insights** | Full-tank mileage windows (partial fills never claim a km/L), mileage trend chart, cost/km by grade, range by ride type |
| **Garage** | Multiple bikes/cars, photos, service interval, profile, CSV export |
| **Group ride** | 6-character rooms, QR/link/code invites, live rider markers, pack-gap alerts in both directions, statuses and SOS, captain destination sync |
| **PWA** | Manifest, maskable icons, offline app shell, cached map tiles, safe-area layouts, standalone display |

### Mileage, honestly

A km/L figure is only produced from **full-tank to full-tank** windows. Partial fills are stored but excluded from the claim until the tank is full again. Implausible entries (outside 4–160 km/L) are saved but flagged and excluded. The hero card labels the number **measured** vs **estimate**.

### Group riding, privately-ish

Ride telemetry carries your display name, role, mode, position, heading, speed and status — **never your phone number, vehicles, photos or fill-ups**. Transport is the public EMQX demo broker over WSS; rooms are six characters and unauthenticated, so treat the room code as the secret. The captain's destination is the only retained message, and ending a ride clears it. Location updates pause when the browser backgrounds the app; riders then show as “not updating”.

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
  "compatibility_date": "2026-10-17",
  "assets": { "directory": "./app" }
}
```

This is an **assets-only Worker** (no server script, no build step). In the
Worker's build settings keep:

- **Build command:** none
- **Deploy command:** `npx wrangler deploy`
- **Root directory:** `/`

`_headers`, `sw.js` and the manifest are served from `app/` exactly as they are
on Pages. The URL is `https://<worker-name>.<account>.workers.dev`; attach a
custom domain under **Settings → Domains & Routes**.

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
- jsdom smoke suites for boot/auth, vehicles, fill-ups, map + routing, group rides, invite links, sheets, long-press pins and POIs
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
    store.js          versioned localStorage (apexmile.v10) + legacy import
    stats.js          full-tank windows, measured km/L, cost/range models
    bus.js            tiny event bus
    ui.js             DOM helpers, toasts, sheets, theme, install helpers
    geo.js            single GPS watcher, altitude smoothing
    map.js            MapLibre styles, markers, route layers, camera
    routing.js        local place index + Nominatim + OSRM
    journey.js        planned route state, stops, alternatives
    nav.js            turn-by-turn, announcements, reroute, progress
    rooms.js          MQTT rooms, peers, statuses, captain state
    sheets.js         every bottom sheet
    views.js          home/refuel/insights/garage rendering
    places.js         generated place + district price index
```

**Data** lives under one key, `apexmile.v10`; the original prototype's key (`apexmile_map_radar_v9`) is imported once. Photos are downscaled and, if storage is full, dropped before any log is lost.

**Services** (all public, no API key): OpenFreeMap vector styles, Esri World Imagery for satellite, Carto raster fallback, OSRM demo routing, Nominatim search, Overpass POIs, EMQX public MQTT broker. Each is rate-limited or best-effort; the UI degrades with a message instead of failing silently.

## Known limits

- The public routing/search/broker services have no SLA. A busy day can mean slower suggestions or a failed reroute.
- Browsers suspend GPS in the background; the radar is a foreground aid, not a satellite tracker or emergency service. SOS is a status flag, not a call for help.
- There is no backend, account system or push notification server. Everything personal stays on the device.
- Turn-by-turn times are OSRM estimates without live traffic.
- iOS opens shared invite links in Safari rather than inside the installed PWA; the room code and in-app *Join a ride* screen cover that gap.

## Licence / attribution

Map data © OpenStreetMap contributors (ODbL). OpenFreeMap, Esri, CARTO, OSRM and Nominatim attributions are shown on the map or in the privacy screen. Do not remove them. `app/` is the maintained implementation; the original single-file prototype was used only as the source for the audit (`REVIEW.md`) and the place/price index.
