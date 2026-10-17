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

---

## Part 4 — v11: the follow-up round

Every item below came from using v10 on a phone.

### 1. Garage

- Vehicle photos are rendered as 44 px rounded thumbnails (they were full-width). `views.js` builds an `<img class="veh-thumb">` with `loading="lazy"`, `decoding="async"`, and the row uses a fixed grid so a photo can never change the row height.
- The form grid was re-aligned: every field is a full-width label/input pair, the two-column rows only exist where the labels are the same height, and the type switcher no longer pushes the name field out of line.

### 2. Radar route panel

- The **+ Stop** control and the **Route** row are gone. `index.html` no longer contains the stop search input; `main.js` no longer binds a stop button. Multi-stop state remains in `journey.js` for existing saves, but nothing in the UI can add one.

### 3. Directions → Start

- The primary action now mirrors Google Maps. With a destination picked it reads **Start ride**; while the input holds text that has not been geocoded it still reads **Directions**, and pressing it resolves the text into the named place first.
- The first press opens the A→B preview sheet (distance, per-mode ETA, cost, tolls, steps). The second press starts navigation and hides the preview's own start button.

### 4. Car / Bike / Walk

- Three explicit modes with their own speed models and ETA chips: 13 min bike / 9 min car / 68 min walk on the smoke route. Walking disables fuel and toll lines ("No fuel or tolls").
- The chosen mode is persisted (`tripMode`, `tripModeSet`) and published to the ride room, so a joining rider inherits the captain's mode.

### 5. Trip cost and tolls

- **Bike/Car** route sheets show the measured-or-estimated km/L of the **active garage vehicle**, litres needed, the current ₹/L rate, and the resulting fuel cost.
- **Car** additionally shows toll plazas found along the corridor (`tolls.js`, Overpass `barrier=toll_booth` and `highway=toll_gantry`, 200 m corridor) at ₹95 per plaza, with the toll's share of the ETA. This is labelled an estimate, not an NHAI quote.

### 6. Voice mute that stays muted

- `state.navVoice` is written on every toggle and the boot sequence calls `setVoice(state.navVoice !== false)` before the first render, so the nav bar, the settings switch and the speech engine agree after reload, after re-login and after a ride ends.
- The root cause of the "mute does not stick" report was a double boot: two `DOMContentLoaded` sources ran `boot()` twice and bound the settings switch twice, so one tap toggled twice. `boot()` is now idempotent.

### 7. Fuel prices

- `prices.js` fetches today's district rate (The Core's India Fuel Watch JSON, sourced from Goodreturns) through a same-origin `/api/fuel-prices` route implemented in `worker.js` (30-minute edge cache), with a direct fallback when the route is absent. City aliases (Bengaluru/Bangalore, Mysuru/Mysore, …) make the match on the rider's district.
- The UI says **Today · <time>** only when today's data actually arrived, otherwise **Verified baseline · <date>**. Manual corrections win and are never overwritten; the fuel sheet can restore the live rate.
- There is no keyless pump-level API in India. Pump prices are set per outlet and are not published as open data; the daily district rate is the most precise public figure, and the app says so instead of implying otherwise.

### 8. Group ride

- Status now reads **Live** from the moment the room code is issued (it used to fall back to "Offline" until the first publish round-trip).
- The captain publishes destination and mode on the retained `state` topic; late joiners replay it, so the captain's choice appears on every screen.
- Quick messages are a one-tap row in the pack sheet and are appended to the shared log on every device. Messages are live-only by design — they are not retained on the public broker.
- Peers publish position/heading/speed every 3 s when they move more than 6 m, with a 12 s heartbeat, and are redrawn on every event, so movement is simultaneous rather than only on join.

### Verification

- ESLint: 0 errors, 0 warnings over `app/js`.
- esbuild bundle resolves all imports (238 KB).
- jsdom suite A (boot, auth, garage, refuel, route, modes, tolls, voice, nav start/stop): 27/27.
- jsdom suite B (two independent app instances on an in-memory broker: create, join, riders, markers, live movement, quick message, captain destination → follower route): 14/14.
- `worker.js` unit cases: 200 + edge cache headers, 405 on POST, asset passthrough, 502 on upstream failure.

Still not verified here: a physical iPhone/Android, real GPS, real broker reachability on a mobile network, and the live feed from inside India. Those remain the acceptance test.

---

## Part 5 — v11.1: full-screen guidance and an honest arrow

### Full screen, both orientations

- Starting navigation adds `.navigating` to `<body>` and asks for the real Fullscreen API while the tap is still a gesture. If the browser refuses (iOS Safari has no element fullscreen; some embedded webviews refuse), the stylesheet still takes the whole viewport, so nothing changes visually except the system status bar.
- `body.navigating .tab-map` is `position:fixed` on all four edges at `100vw × 100dvh`; the topbar, tabbar and install hint are hidden, the stage padding is removed and page scrolling is locked.
- Safe areas are applied to the controls, never to the map: the banner gets `safe-t`, the ETA card `safe-b`, and the landscape card/fabs/attribution get `safe-l`/`safe-r`.
- Landscape: the ETA card docks bottom-right at `min(380px, 44vw)`, the banner is capped to the free width, the floating controls move to the left, and attribution moves bottom-left (still visible, as the licences require) instead of being hidden.
- Short landscape phones (`max-height:430px`) drop the secondary line and tighten the card.
- `resize`, `orientationchange` and `fullscreenchange` all re-run `map.resize()` (immediately and again after the transition), so the canvas is never left at the old aspect ratio.
- Ending guidance removes the classes, releases fullscreen and resizes the map back into the tab layout.

### The arrow

- The emoji manoeuvre glyph is gone. The banner icon is one SVG arrow that is rotated by `exit road heading − current map bearing`, measured just *after* the upcoming manoeuvre. Ahead is 0°, a right turn is +90°, a left turn is −90°, and the value updates while the camera eases.
- The camera now follows the **road** heading (from the route geometry) rather than the raw GPS bearing, so the map is aligned to the road from the first frame even when standing still, and no longer twitches at walking pace.
- Rotation is normalised to the short arc with a half-degree tolerance, so ±180° floating-point noise cannot spin the arrow a full turn.
- On the last leg the router's "You have arrived" instruction is replaced with "Continue to <destination>", the distance shown is the distance remaining rather than the distance to a turn that does not exist, voice guidance for that leg is suppressed, and the arrow follows the road to the destination. Arrival wording appears only within 35 m.
- The location puck becomes a heading arrow during guidance (dot + cone outside guidance) and points along the road.

### Verification

- jsdom suite: navigating state, html flag, banner vector arrow, fixed/full-viewport map tab, hidden chrome, scroll lock, puck arrow visible and dot hidden, right-turn arrow at +90°, camera road-aligned at start, camera facing east after the corner with the arrow still +90° on screen, last-leg guidance wording and arrow, orientation change keeping guidance and resizing the map, clean exit — **all pass**.
- Static CSS audit (css-tree): fixed/full-viewport nav surface, `100dvh`, safe-area insets on banner/card, landscape card/controls/attribution placement, arrow transform origin and transition, puck pivot origin, vector icon in markup, SW cache bumped to `apexmile-v11.1.0` — **all pass**.
- ESLint 0 errors / 0 warnings; esbuild resolves all imports.

---

## Part 6 — v11.2: two map layers, drawn symbols, and a way back to Directions

### The layer strip is two choices, not seven

- The map now offers **Live Traffic** and **Satellite** only. Streets, Night and Terrain were basemaps the app already chose by theme; the three POI shortcuts (⛽ Fuel, 🍽 Food, 🔧 Repair) and the Overpass pin path behind them are gone, so nothing competes with the route line.
- Satellite is a plain toggle: on it switches to Esri World Imagery, off it returns to the theme's basemap. A theme change no longer yanks the rider out of satellite.
- **Live traffic** is TomTom's raster flow layer (`relative0`, 256 px tiles). TomTom is the one provider with a free tile tier (50,000 tiles/day, no card), but it needs a key, so the layer is opt-in: tapping the pill with no key opens a setup sheet, and the key is stored in this browser only — never in the bundle or the repository. The key can also be set from Garage → Ride settings.
- The overlay re-adds itself after a style swap, sits underneath the accuracy and route layers, carries `Traffic © TomTom` attribution, and is deliberately excluded from the service-worker tile cache so flow colours stay current. `api.tomtom.com` is allowed in the CSP's `connect-src` and `img-src`. A 401/403 on the tiles (invalid, expired or wrongly restricted key) turns the overlay off once, says so, and keeps the key in settings.

### Every navigation glyph is drawn

- The turn list no longer uses emoji. One 24×24 grid and one 2 px stroke cover straight, slight/sharp/90° turns, U-turn, roundabout, merge, fork, ferry and arrival, rendered from `js/navicons.js` in the green banner's turn sheet.
- The group and voice buttons in the navigation bar are drawn too, along with the radar's group FAB and the pack-gap warning; `setVoice` swaps the speaker-with-waves for a slashed speaker instead of writing 🔊/🔇, and keeps `aria-pressed` honest.
- The banner arrow itself is a navigation-chevron silhouette (concave base, rounded shoulders) rather than a blocky arrow, still rotated by `exit road heading − map bearing`.

### Ending guidance goes back to Directions

- `stopNavigation` no longer clears the journey. `nav:end` re-renders the route preview: the Directions sheet reappears with the destination text, ETA, distance, alternatives, mode cards and cost still populated, the route is re-drawn with its alternatives, and the camera fits the whole route — north-up and flat again, because a plan should not read like a moving camera.
- From that preview the rider can press **Start ride** again (a fresh plan is fetched if they have moved more than ~220 m) or tap ✕ to close the whole search result. Arrival takes the same path: the preview returns, then the camera settles on the arrival point.
- Leaving the radar tab mid-guidance still ends guidance and keeps the plan, but the preview stays out of the way on the other tab; returning to the radar brings it back with the destination and `Start ride` intact.

### Verification

- jsdom suite v11.2 (new, 60 checks): two-pill strip with the right labels and vectors, POI IDs gone, traffic setup sheet, `apex-traffic` added with the TomTom flow URL, local persistence of the key and toggle, overlay surviving a satellite style swap and returning to streets, four turn-list steps all with SVG glyphs and no emoji, drawn voice/group buttons, speaker swap and `aria-pressed`, end-navigation returning to Directions with destination/ETA/distance/`Start ride` preserved, restart from the preview, ✕ clearing the result, the preview's north-up/flat reset, a tab-change exit that keeps the plan off-screen and restores it on return, and a simulated 403 turning the overlay off while keeping the key for editing — **all pass**.
- v11.1 navigation suite still passes end to end (arrow at +90° before and after the corner, immersive layout, orientation change, tab-change exit, voice persistence, group ride).
- Static CSS audit extended with the two-pill markup, the drawn FAB and gap icons, 14 px pill icons, 19 px step/nav-bar glyphs, TomTom CSP entries and SW `apexmile-v11.2.0` + `navicons.js` precache — **all pass**.
- ESLint 0 errors / 0 warnings; esbuild resolves all imports; `node --check` on every touched module.

Still not verified here: a physical iPhone/Android, real GPS, a real TomTom key, and mobile-network broker reachability.

---

## Part 7 — v11.2.1: bike ETAs that beat cars, one broker per room, and a traffic key that proves itself

Three field reports from the first v11.2 rides, all reproduced from the code.

### 1. A bike ETA must never read worse than the same trip by car

- **Root cause.** "Bike" routes were sent to Valhalla's *bicycle* costing: 15–20 km/h push-bike speeds against the car card's free-flow OSRM times. The fallback model made it worse (25/33/44 km/h fixed speeds with no reference to the car estimate at all).
- **Fix.** Bike now costs as Valhalla's **motorcycle** profile — bike-legal roads at motorcycle speeds. Both engines only understand free-flow, so `modeledBikeSeconds()` applies an urban trim over the same free-flow baseline (a motorcycle filters through queues cars sit in: ×0.82 under 12 km, ×0.95 under 45 km, untouched beyond), with a plausibility floor (never faster than 40/55 km/h moving average) that binds only on trimmed legs — open-road times pass through. The OSRM fallback derives the bike number *from* OSRM's own free-flow car seconds, so the bike card and the car card can never contradict each other.
- Verified in Node: city 10 km → bike 15.0 min vs car 17.7 min; highway 60 km → 45.0 vs 47.3; trim floor holds.

### 2. Group ride: joined riders were invisible to each other

- **Root cause A (the big one).** The fail-over broker list plus a per-device "sticky broker" scattered room members across *different public brokers*. Public brokers are islands — same room code or not, a rider on EMQX and a rider on HiveMQ never see each other. Exactly matches "joins by code/QR/link don't reflect on either app."
- **Fix A.** The room code deterministically picks the broker (`hash(code) % brokers`) — the code names the room, so the code also names where the room meets. Everyone who types or scans the same code tries the same endpoint first; fallbacks remain for when that one is blocked. The sticky-broker heuristic is gone, the defunct Eclipse broker was removed (the Eclipse Foundation shut it down), and HiveMQ's alternate hostname was added as another path for hostile networks.
- **Root cause B.** Presence was announced the instant TCP connected, *before* the subscription landed: the room's reply to our own hello could arrive before we could hear it.
- **Fix B.** Hello + first position now publish on SUBACK (with a 1.5 s bailout for brokers that never answer it).
- **Root cause C.** Heartbeats stopped while the screen was hidden. Riders pocket their phones; pockets go stale at 38 s and are dropped at 125 s — the whole pack vanishes mid-ride.
- **Fix C.** The 12 s heartbeat now keeps flowing in the background (movement publishes still need real motion).

### 3. Live Traffic stayed dark even with a "successful" TomTom key

- **Root cause.** Since TomTom's new portal (2025→), keys are created with *per-product* access; a key without the Traffic products answers 401/403 on the flow tiles. The app accepted any 16+ character string, called it "Live traffic on", and painted nothing; the runtime handler then wiped the saved toggle and blamed the key. A 429 (daily quota used) wasn't recognised at all.
- **Fix.** Saving a key now **proves it first**: one real tile fetch over Bengaluru before anything is saved (`trafficProbeUrl`). A 401/403 keeps the sheet open and says exactly what to do in the portal (enable the Traffic products, check domain restrictions); unreachable/quota still saves (off-grid is a bad time to be strict). A runtime 401/403/429 detaches the overlay for the session and explains itself — but no longer deletes the key or the saved preference, so a fixed key or a midnight quota reset just starts working again. Sheet copy updated for the new portal (API & SDK Keys → select the Traffic products).
- SW cache bumped to `apexmile-v11.2.1` so installed PWAs pick up all of this.

### Verification

- Node smoke run against the built modules: five ETA assertions + probe-URL assertions — **all pass**; `node --check` on every touched module (`routing`, `rooms`, `map`, `main`, `sw`) — clean.

Still not verified here: real TomTom key with the products enabled, real multi-phone MQTT room across carriers, and physical iPhone/Android GPS — these need devices, not a sandbox.

---

## Part 8 — v11.2.2: a mode model built for real motorcycles, and the CSP that silenced Ride Sync

Two follow-ups from the field after v11.2.1.

### 1. Bike/car logic redefined around what a bike actually is

- **The spec, now explicit in the code:** ApexMile "bike" is a large-capacity motorcycle (100–1000 cc class): it filters through city congestion (the reason bike commuting exists in Indian cities), and on the open road it sustains 120–165 km/h — at least the pace of any regular car. Therefore no band of the model may ever show a bike slower than the same trip by car.
- **One shared baseline, two honest views.** Both modes are timed off the route's free-flow seconds: car ×(1.18 / 1.10 / 1.05 by band), bike ×(0.82 / 0.95 / 0.98). The bike factors sit strictly below the car factors in every band — filtering advantage in the city, open-road parity-plus beyond.
- **Provable ordering.** `modeledBikeSeconds` ends with `Math.min(·, carFactor(km))`: at worst, on physically implausible inputs, the bike settles for a tie — it can never display worse. Verified exhaustively: 96 distance×speed combinations, zero display-level inversions. Showcases: city 10 km → 15 vs 18 min; highway 60 km → 44 vs 47 min; 130 km/h free-flow 80 km → 36 vs 39 min.
- **Valhalla now knows the machine.** The motorcycle costing goes out with `costing_options.motorcycle.top_speed = 160` — the stock ~120 km/h scooter-class default undersold open-road legs. (Bicycle costing was already ejected in v11.2.1; this round redefines the whole comparison model, not just the engine.)
- These remain modeled estimates, labelled as such — honest congestion modelling, not a fake "live traffic" claim.

### 2. Ride Sync "continuously trying, never connecting even once" — the app's own CSP blocked every broker

- **Root cause.** The content security policy listed broker hosts *without ports* (`wss://broker.emqx.io`). Per the CSP matching rules, a host-source with no port-part only matches the scheme's default port — **443** — so every broker WebSocket URL the app uses (`:8084`, `:8884`, `:8081`) was refused at the browser, before any network traffic. The MQTT client then failed over through all four brokers, every 15 s, forever. The only CSP-legal broker in earlier builds was Eclipse's `:443` — which no longer exists. This is why it never succeeded even once, on any network.
- **Fix.** `connect-src` now names each broker with its exact port: `wss://broker.emqx.io:8084`, `wss://broker.hivemq.com:8884`, `wss://mqtt-dashboard.com:8884`, `wss://test.mosquitto.org:8081`.
- **And when a network really does block relays** (some corporate/carrier networks block all public MQTT): after three full broker cycles the app says so plainly and points to the escape hatches (mobile data, or a custom broker in Ride settings) instead of looping silently.
- v11.2.1's co-location, SUBACK-announce and background-heartbeat fixes all stand: once connected — which is now possible — the whole room meets on the same broker.
- SW bumped to `apexmile-v11.2.2`.

### Verification

- Node smoke model suite: band showcases + 96-combination ordering sweep — **all pass**; `node --check` on every touched module — clean.

Still not verifiable from a sandbox: the actual WebSocket handshake through a real browser on real networks (the CSP change is the kind you verify on a phone, so test it there first), multi-device rooms, and a real TomTom key.

---

## Part 9 — v11.3.0: one search bar that opens, traffic-aware ETAs, drawn icons everywhere

### 1. Radar search starts as one bar

- The radar opens with a **single search bar** over the map. Tapping it expands the panel to the origin and destination fields (with swap), the mode row, the suggestion list and the Start action; the current-location map stays visible around it. A finished plan folds the panel back to one bar showing the destination, and a cleared result collapses it again.
- Suggestions stay compact and stacked under the fields. The **Start** action is now a small pill parked at the bottom of the expanded panel instead of a full-width slab across it.
- Voice listening is a drawn mic that turns into a red dot (`rec` class) instead of swapping the button's content for emoji.

### 2. No emoji in the interface

- Every pictographic emoji is gone from the app: home tiles, vehicle thumbnails, mode buttons and chips, suggestion rows, the searchbox (swap, mic, locate), the chat button, toasts, ride-status chips, the destination marker and the SOS/status buttons all render from the same 24×24 drawn-glyph set (`uiIcon` in `js/navicons.js`) that the navigation surface already used.
- The result survives a scan of `app/index.html`, `app/css/app.css` and every non-vendor JS module: **zero emoji code points**, including the VS16 sequences that forced colourful rendering. Typographic characters (dashes, quotes, arrows in prose, ✕/✓/＋/－ button notation) are unchanged.

### 3. Traffic-aware routes and ETAs from TomTom

- When the rider's TomTom key carries the **Routing** products, `directions()` plans through TomTom's Calculate Route API with `traffic=true` and `computeTravelTimeFor=all`, `travelMode` mapped from the app's modes (motorcycle/car/pedestrian). The ETA is TomTom's traffic-aware `travelTimeInSeconds`; the sheet says **Traffic-aware ETA · TomTom** and names the traffic delay ("traffic adds about N min on this route"); the step list comes from TomTom guidance (manoeuvre codes mapped onto the drawn glyph set).
- When routing access is **not** available — no key, a Traffic-only key, or anything else — the plan falls back to the existing Valhalla/OSRM engines and says so plainly: **Standard estimate — planned without live traffic**, in the route sheet and the steps sheet.
- **A rejected key is never retried in a loop.** A 401/403 from the Routing API records the verdict on that key: every later plan and every off-route reroute (which re-plans every ~20 s while guidance is on) skips TomTom entirely until the rider saves a *different* key. A 429 (quota) pauses TomTom the same way. Transient network failures stay retryable.
- The traffic setup sheet now explains that the one key powers both the flow overlay and traffic-aware routing, and asks for the Traffic **and** Routing products.

### 4. Google Maps handoff, MapLibre stays

- The route preview carries an **Open in Google Maps** action (Maps URLs deep link with origin, destination and travel mode) and the layer strip has a **Google traffic** pill that opens Google Maps centred on the current view with its traffic layer. The in-app MapLibre map, the TomTom flow overlay and everything else stay exactly where they were — this is a handoff, not a replacement.

### Verification

- Mocked TomTom suite (Node, stubbed fetch): 36 checks — traffic-aware success (mode mapping, `traffic=true`, alternatives, guidance steps with cumulative offsets, delay surfaced, labels), 403 → clear fallback to standard estimates with **zero** TomTom requests on the follow-up plan (the no-periodic-retries rule), new key gets a fresh chance, 429 pauses retries, no key never touches TomTom, transient outage stays retryable — **all pass**.
- jsdom smoke suite (27 checks): collapsed single bar → tap expands → stacked suggestions with drawn icons → plan folds the panel back with the destination and **Start ride**; standard-estimate labelling without a key; traffic-aware labelling with a good key (delay surfaced); 403 falling back with the label intact and no TomTom retries across a mode-switch re-plan; both Google Maps handoffs opening the right URLs; zero emoji in the fully rendered page — **all pass**.
- `node --check` on every module (module-syntax aware), esbuild bundle resolves the whole import graph, `git diff --check` clean, HTML parses with 193 unique ids and every JS-referenced id present, emoji scan of HTML/CSS/non-vendor JS clean.

Still not verified here: a real TomTom key with the Routing products enabled, a physical iPhone/Android, and the Google Maps handoff on a real device. No browser executable exists in this environment, so this is not a visual browser review.
