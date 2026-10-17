# ApexMile — proposed changes, then what was built

This is the change proposal that preceded the rewrite, followed by the implementation that now lives in `app/`. It is written against `REVIEW.md` (the audit of the original single-file app) and the requirement that the result must install and behave like an app on both iPhone and Android after a Cloudflare deploy.

---

## Part 1 — The proposal

### A. What was holding the original back

The audit found five classes of problem, and they all hurt the “real map app” feel:

1. **The shell was broken in places.** 29 element ids referenced by JS did not exist, 7 modals were missing, `renderApp()` threw on load, and 7 navigation map functions were never declared. A single exception in a render path could leave the page half-dead.
2. **The map was not a map stack.** Tile and navigation helpers were stubs. There was no camera model, no route layer, no gesture tuning, no offline behaviour, and no fallback when tiles failed.
3. **The group ride was not safe or complete.** It used a public broker with retained `captain_state`, no stale cleanup, no explicit presence lifecycle, and it put names/phones into the UI without escaping. There was no usable join path, no pack-gap UX, no captain-destination sync.
4. **It was not installable.** No manifest, no service worker, no Apple touch icon, no safe-area handling, no standalone layout.
5. **The mileage claims were fuzzy.** Litres and distance were not tied to full-tank windows, so partial fills could produce a confident-looking km/L number that was simply wrong.

### B. The map: make it behave like Google Maps without using Google

1. **Replace the hand-rolled map with MapLibre GL** and free vector styles from OpenFreeMap (`liberty`, `positron`, `dark`, `fiord`). Vector tiles mean labels rotate with the map, zoom is crisp, and panning is GPU-composited.
2. **Add a real camera model.** During navigation: pitch 52°, bearing = heading, rider offset to the lower third, and speed-adaptive zoom (17.4 at a crawl down to 14.6 at highway speed) with ~700 ms eased transitions. Outside navigation: north-up, pitch 0, one-tap recenter.
3. **Keep every Google Maps gesture** — drag, pinch zoom, two-finger rotate, two-finger pitch, double-tap zoom — and make buttons secondary.
4. **Search like a map app.** Instant local index first (no network), Nominatim suggestions after typing stops, a route preview sheet with alternatives, stops, ETA, arrival time, fuel cost, and a turn list.
5. **Add the affordances people expect:** long-press to drop a pin, fuel/food/repair POIs from Overpass, tappable peer and POI markers, and a “Route here” action everywhere.
6. **Fail gracefully.** Raster Carto fallback if the vector style cannot load; a bounded tile cache so the last area viewed still renders offline; explicit offline/error messaging rather than a blank canvas.
7. **Satellite without a key.** Esri World Imagery as a raster style, with its attribution and CSP allowance. No Google tiles, no Google logo.

### C. Navigation

- Turn banner with icon, primary instruction, “then…” preview and distance.
- Voice prompts at 400 m / 150 m / now, throttled, with a mute button that persists.
- Off-route detection (>55 m for 7 s) with reroute and a 20 s cooldown.
- Arrival detection (<28 m, or within 90 m of the destination), progress split between “ridden” and “ahead” line layers.
- Screen wake lock while navigating; release on end/background.

### D. Group riding, inside Map Radar

1. **Rooms, not global broadcast.** Six-character code from an unambiguous alphabet, `apexmile/v10/ride/<CODE>/ev` for presence and `…/state` (retained) for captain state only.
2. **Three ways in:** QR code, share link, or typing the code. Invite links open a dedicated join screen (`?room=`), and the app also has *Join a ride* inside the radar.
3. **A visible pack.** Peer markers with initials, colour by rider, distance labels, stale state and SOS pulse. A group bar with avatars and distances; tap one for status, speed, last update, “Show on map” and “Where are you?”.
4. **Gap alerts in both directions.** “X is 885 m behind” when someone drops, and “You're 1.2 km behind the pack” when *you* are the one off the back.
5. **Captain destination sync.** When the captain starts navigation, everyone in the room receives the same destination (retained message, cleared when the ride ends). A follower can pick it up even if they join late.
6. **Status and SOS.** Riding normal, fuel stop, quick break, photo stop, tyre/chain, wildlife, and a breakdown SOS that turns the marker red and haptics the room.
7. **Safety defaults:** no phone numbers in telemetry; explicit hello/bye plus MQTT will; heartbeat 12 s, stale 38 s, drop 125 s; retained state ignored after 6 h; room codes treated as secrets and disclosed as unauthenticated.

### E. PWA / install

- `manifest.webmanifest` with `display: standalone`, `start_url: "."`, 192/512 `any` icons and a separate maskable 512, theme `#FF5500`, shortcuts to Refuel and Radar.
- `sw.js`: versioned shell precache, network-first navigations with offline shell fallback, stale-while-revalidate same-origin assets, cache-first tiles with a 700-entry bound, never caching the broker.
- iOS meta (`apple-mobile-web-app-capable`, status bar style, title, 180 px apple-touch icon), `viewport-fit=cover`, `env(safe-area-inset-*)` on the topbar, tab bar, sheets, map overlays and nav bars.
- Install guidance for both platforms (Share → Add to Home Screen on iOS, browser menu on Android) plus `beforeinstallprompt` handling.
- `_headers` to force the manifest MIME type and keep `sw.js` uncached.

### F. Correctness and honesty

- Full-tank windows only; partial fills accumulate but never produce a km/L claim; implausible values flagged and excluded.
- District rates clearly labelled “captured on <date>”, editable, with a “Use my district” action; no “live price” claim.
- CSV export, legacy data import, quota fallback that drops photos before logs.

---

## Part 2 — What was implemented

Everything above is in `app/`:

| Proposal | Implementation |
|---|---|
| MapLibre + OpenFreeMap + Esri satellite + Carto fallback | `js/map.js` (`STYLES`, `satelliteStyle()`, `cartoStyle()`, `useFallbackStyle()`) |
| Camera model / gestures | `js/map.js` `cameraFollow()`, `recenter()`, `fitRoute()`, `togglePitch()` |
| Long-press pin, POI pins, peer taps | `map.js` `contextmenu`, `setPois()`, peer marker click → `peer:click` |
| Search + route preview | `js/routing.js`, `js/journey.js`, `js/main.js`, `js/sheets.js` |
| Turn-by-turn + reroute + voice | `js/nav.js` |
| Group rooms, peers, gap alerts, captain state | `js/rooms.js`, `js/main.js`, `js/sheets.js` |
| PWA shell | `index.html`, `manifest.webmanifest`, `sw.js`, `css/app.css`, `assets/icons/*`, `_headers` |
| Mileage maths | `js/stats.js`, `js/store.js`, `js/views.js` |

### Verification performed

- Syntax check of every module.
- esbuild bundle to prove every import/export resolves.
- Three jsdom suites: app boot + auth + vehicle + refuel + route + group ride + invite; group-ride demo/gap/join/long-press/POI; invite deep-link join.
- Pure mileage test: two full-tank windows → 38.46 and 50 km/L, weighted 43.48 km/L.
- Static checks: every `#id` used in JS exists in HTML or is created by a sheet; CSS parses (343 rules); every asset referenced by `index.html` and by the SW precache exists.

### Not verified here

No physical iPhone/Android device or real browser exists in this environment. Safari/Chrome rendering, actual GPS accuracy, broker reachability on a mobile network and Lighthouse installability were not exercised. The code targets iOS 15.4+ and Chrome 111+, but the first real-device pass should be the acceptance test.

---

## Part 3 — How to deploy and try it

```bash
# from the repository root
npx wrangler pages deploy app --project-name apexmile
```

Or Cloudflare dashboard → Pages → connect the repo → **output directory `app`**, no build command.

Then: open the HTTPS URL → install/add to Home Screen → allow location → log a full tank → open **Ride radar** → tap the 👥 button → *Start a group ride* → share the QR/link/code. A second phone opens the invite link, enters a name, and appears on the map.

For a solo demo of the pack UI, open `…/?demo=1`, start a ride, then tap *Add a demo rider* in the invite sheet.
