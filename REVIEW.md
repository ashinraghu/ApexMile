# ApexMile — Code & Product Review

**File reviewed:** `biker_mileage_radar_ios_app.html` — 254 KB, 5,572 lines
**Composition:** ~1,300 lines CSS · ~765 lines markup · 3,484 lines of inline JavaScript (one `<script>`)
**Stack:** vanilla HTML/CSS/JS, Leaflet 1.9.4, MQTT.js over WebSocket, OSRM, Nominatim, Overpass, Google raster tiles
**Review date:** 17 Oct 2026
**Method:** full static read, `node --check` on the extracted script, a declared-vs-used symbol scan, a jsdom load to capture runtime errors, and spot checks against live fuel prices. No Safari/Chrome device test was possible in this sandbox — see *Caveats* at the end.

---

## 1. Verdict

This is an unusually ambitious and visually polished **single-file prototype**. It looks like a finished iPhone app, has a coherent design language, and contains a genuinely interesting product idea: a mileage/fuel tracker fused with a live group-ride radar, pack-gap warnings, and "Where are you?" pings.

But it is **not yet a working app**. The UI is several layers ahead of the wiring:

- **7 modals are referenced but do not exist** (`addVehicleModal`, `chainAlertModal`, `editOdoModal`, `editPricesModal`, `editVehicleModal`, `profileModal`, `riderModal`).
- **29 element IDs** used by JavaScript are absent from the HTML.
- **7 navigation/route functions are called but never defined**, including Start Navigation, Exit Navigation, and Clear Route.
- `renderApp()` **throws on every run** at the chain-lube status line, so the dashboard, garage list, history, insights, and group-ride UI never finish rendering.
- Invite links open the **wrong screen** (the signup overlay covers the "Join Ride" overlay).
- Real-time group riding broadcasts **name, phone number, and live GPS** over a **public, unauthenticated MQTT broker** with 4-digit room codes, and untrusted names are injected into `innerHTML`.

As a **UX prototype / product spec**, it is a strong 8/10. As a **working app**, roughly 4/10. As a **shippable iOS app**, not started — this is a web page, not a native app, and the "always-on background GPS" promise cannot be delivered by mobile Safari.

The good news: most of what's missing is wiring, not redesign. With a focused 1–2 days this becomes a credible clickable demo; with a proper rewrite it becomes a real product.

---

## 2. What is genuinely good

Credit where it's due — this is not a generic template.

- **Coherent visual system.** CSS variables, light/dark themes, glass cards, safe-area insets, floating tab bar, landscape full-screen map mode, and a consistent orange/blue ApexMile identity. It reads as designed, not generated.
- **India-first detail.** A 210+ place index covering Bengaluru neighbourhoods, Karnataka/Kerala/Tamil Nadu highways, ghats, and landmarks; regional fuel-rate presets; rupee formatting; highway and hill-route language that local riders actually use.
- **Genuine mileage-tracker depth.** Multi-vehicle garage, ODO tracking, tank/reserve range, cost per km, octane grades, fill-up history, mileage trend, CSV export, chain-lube interval.
- **A real group-riding concept.** Captain/member roles, room codes, invite links, live rider pins with initials and distance labels, automatic ≥500 m pack-gap banner, targeted "Where are you?" pings, SOS breakdown status, and a thoughtful rule that you can only edit *your own* status.
- **Route-planning features** that many paid apps lack: multi-stop routes, drag-free stop reordering (first/last/up/down), alternatives, turn-step list, POI search (fuel/food/repair/ATM), custom start point, and a search index that answers instantly before the network does.
- **Careful device touches.** Compass permission handling for iOS, GPS accuracy circle, directional pointer, camera lock/re-center logic, landscape map mode, offline toggle, and a black "pocket mode" overlay.
- **Code hygiene where it counts.** No duplicate IDs; the inline script parses cleanly (`node --check` passes); sections are labelled with comments; functions are mostly small and named clearly.

The fuel numbers are also better than I expected: the hard-coded Bengaluru ₹111.68/L and Thrissur ₹114.62/L are close to actual pump prices in mid-October 2026 (₹110.82–111.68 and ₹113.78–114.46 respectively). The problem is the **"Live"** label, not the numbers.

---

## 3. Blocking defects (fix before showing this to anyone)

### 3.1 Seven modals and 29 IDs are missing → tapping throws

Only four `.modal-overlay` elements exist: `incomingPingModal`, `tripModal`, `stopsModal`, `stepsModal`. Yet `openModal()` is called with eleven targets. Missing:

| Missing modal | Triggered from | User-visible result |
|---|---|---|
| `profileModal` | Header avatar (L1407), Garage "Profile / Logout" (L1932) | `TypeError`, nothing opens |
| `addVehicleModal` | Home "＋ Vehicle" (L1439), "Add Bike" tile (L1528), Garage (L1918), `saveNewFuelLog` (L5091) | `TypeError` |
| `editOdoModal` | ODO badge (L1451), Refuel "Last ODO" (L1582) | `TypeError` |
| `editVehicleModal` | Hero mileage/tank blocks (L1458/L1465), `openEditVehicleModal` | `TypeError` |
| `editPricesModal` | "Edit" fuel rate (L1547), "Edit Pump Rate" (L1617) | `TypeError` |
| `chainAlertModal` | "Chain Alert" quick tile (L1520) | `TypeError` |
| `riderModal` | Tapping any rider pin, "My Status / Breakdown" (L1887/5343), `openRiderModal()` (L4722) | `TypeError` |

Because `openModal()` ends with `document.getElementById(id).classList.add('open')` and several openers assign to `.value` first, these are guaranteed `TypeError`s, not silent no-ops.

The missing IDs include every input in those modals (`addVehName`, `addVehOdo`, `addVehKmpl`, `modalOdoValue`, `modalPrice91/95/100`, `profNameInput`, `riderModalBody`, …), plus `btnOfflineHeader`, `compassHeadingText`, `compassRoseRing`, `compassStatusSub`, `voiceMicSearchBtn`, and `modalChainStatusSub`.

The practical effect: **Add Vehicle, Edit Vehicle, Edit ODO, Edit Prices, Profile/Logout, Chain Alert, and rider status are all dead.** Worse, the functions that implement them (`createNewVehicle`, `saveEditedVehicle`, `saveEditedPrices`, `saveEditedOdo`, `saveProfileInfo`, `logoutToSignUpScreen`, `resetChainLubeNow`, `setMyQuickStatus`) have **zero callers** anywhere else — they exist only to be called from modals that aren't there.

### 3.2 `renderApp()` crashes on every invocation

Verified in jsdom:

```
TypeError: Cannot set properties of null (setting 'textContent')
    at renderApp (<anonymous>:3175:66)   // file line 5261
```

The line is:

```js
document.getElementById('modalChainStatusSub').textContent = ...
```

`modalChainStatusSub` lives inside the missing `chainAlertModal`. Since `renderApp()` is called on load, after signup, after every fuel log, after every peer telemetry packet, and after most settings changes, **the app throws every time it tries to render** — after the hero card, garage switcher, stats, and thumbnail, but before fuel rates, log history, insights, garage list, and group-ride UI. The dashboard is permanently half-rendered, and the Garage tab stays empty even when vehicles exist.

I confirmed the causality by stubbing the 29 missing IDs: with the stub, `renderApp()` completes; without it, it fails. So a single missing `<div>` is currently taking down most of the app.

### 3.3 The flagship navigation feature is not implemented

These are called but have **no definition anywhere**:

| Missing function | Called from | Consequence |
|---|---|---|
| `captainOrSoloStartNavigation` | "Start" button (L1843), group ride start (L2974) | Start Navigation throws |
| `activateTurnByTurnNavigationUI` | Captain broadcast handler (L2828), join flow (L2947) | Members never enter nav mode; captain start throws |
| `stopTurnByTurnNavigation` | "Exit" button (L1876), captain pause (L2831) | Exit throws |
| `clearActiveRoute` | Route card ✕ (L1850) | Clear route throws |
| `renderStopTileBoxes` | `initMapRadar()` (L3089) | Radar initialization aborts mid-way |
| `ensureRouteTileBoxesInitialized` + `routeTileBoxes` | `startGroupRideSession()` (L2971–72) | Captain start with a destination throws |
| `updateActiveNavigationStepHud` | GPS watcher (L4324) | Dead code path |

Additionally:

- **`isNavigating` is never set to `true`.** It is declared once (`let isNavigating = false;`, L3051) and only ever read or set to false. Nothing can enter navigation mode.
- **The turn banner is static.** `navTurnPrimaryText`, `navTurnDistBig`, `navTurnIcon`, `navThenText` are only ever written in the HTML — no JavaScript updates them. "Continue straight / 250 m" is decoration.
- **Voice guidance never speaks.** `speakNavigationInstruction()` is defined but has **zero call sites**, so the 🔊 toggle only changes an icon.
- **`clearActiveRoute` has one call site and no definition.**

So the headline flow — search a destination, tap Start, get turn-by-turn with live group members — cannot be completed. Route preview, alternatives, and the steps modal do work; navigation does not.

### 3.4 Invite links show the signup screen, not the join screen

Both `#joinInviteScreen` (L1337) and `#authScreen` (L1367) are `.auth-screen` elements with `position: fixed; z-index: 2500`. `checkUrlForInviteLink()` adds `.active` to the join screen, but the signup screen is **later in the DOM** and already active. Equal z-index + later sibling = signup paints on top. There is no `#joinInviteScreen { z-index: … }` rule.

Result: a friend taps your invite link and sees "Welcome to ApexMile — enter your name and phone", not "Join Sunday Highway Ride". If they sign up, the generic screen closes and the **stale join form** is revealed underneath. They never auto-join, and the room link's destination/nav state is not applied until they submit. This kills the core acquisition loop.

### 3.5 Radar initialization aborts partway

`initMapRadar()` creates the Leaflet map, tile layer, accuracy circle, and click handler, then calls `renderStopTileBoxes()` — which does not exist. In a real browser (where `L` is defined), that line throws, so the remaining setup never runs:

- `gmap.on('dragstart'/'zoomstart')` camera-lock handlers
- `updateMapRiderMarkers()` — so no blue "me" arrow, no peer pins
- back in `switchTab()`, the `setTimeout` that calls `invalidateSize()`, re-centers, and refreshes markers

The map may still paint tiles, but the radar is effectively a static map with no riders. (jsdom didn't catch this one because Leaflet isn't loaded there and `initMapRadar` returns early.)

### 3.6 Half the visible surface is unreachable

Because the modals are missing, these are dead UI paths, not just bugs:

- Add/edit vehicle, edit ODO, edit fuel prices, profile/logout, chain-lube reset, rider status/SOS menu, offline mode (`btnOfflineHeader` missing), region preset switch (`modalRegionSelect` missing).
- The ₹19/month Pro "Auto-Debit" toggle changes a text label only. There is no billing integration of any kind.

What *is* usable today: signup (name + phone), the fuel-log form (except the missing edit-price modal), mileage/range/insights rendering (once the null crash is fixed), CSV export, theme cycling, route search/preview, multi-stop planning, POI search, and the group ride session if you start it **without** a destination.

---

## 4. Security & privacy — the most serious area

### 4.1 Live location, name, and phone over a public broker

```js
mqtt.connect('wss://broker.emqx.io:8084/mqtt', { clientId: 'apex_' + myClientId, ... })
```

- **No authentication, no authorization, no ACL.** Anyone can connect.
- **Topics are predictable and enumerable:** `apexmile/v7/ride/<ROOM>/telemetry`, `.../captain_state`, `.../ping`.
- **Room codes are 4 characters** (`RIDE` + 3 digits ≈ 900 possibilities), and invite links put the code in the URL.
- Every telemetry packet includes **rider name, phone number, GPS, heading, status, SOS flag, and travel mode** (L2699–2700).
- `captain_state` is published with **`retain: true`**, so the trip name, destination, and captain identity persist on the broker and are delivered to anyone who subscribes to that topic later — even after the ride ends.
- There is **no presence expiry**: `lastSeen` is written but never read, so riders who close the tab remain on the map forever.

A single wildcard subscription (`apexmile/v7/ride/+/telemetry`) gives a global, real-time map of every ApexMile user, including their phone numbers. With 900 room codes, targeted tracking is trivial. This is a stalking/doxxing vector and, in India, a DPDP Act 2023 problem: personal data is shared without consent, notice, purpose limitation, or reasonable security safeguards.

### 4.2 DOM XSS from untrusted data

Untrusted values are interpolated directly into `innerHTML`:

- Peer names from MQTT → marker labels (`L3237`), group overlay (`L3379`), rider modal (`L4674`/`L4698`), convoy strip (`L5345`).
- Invite-link `dname` parameter → destination pin label (`L4107`), route text.
- Nominatim/OSRM place and stop names → suggestions, stops list, destination pins.
- Inline `onclick` strings escape only `'` via `.replace(/'/g, "\\'")` — not `</script>`, backslashes, or HTML.

Consequences: a malicious peer — or a crafted invite link — can execute JavaScript in the app's origin, read `localStorage` (name, phone, full log history, vehicle photos), and exfiltrate the rider's live location. Combined with an unauthenticated broker, this is remotely exploitable without any account.

### 4.3 No real authentication

"Sign up / log in" collects a name and phone number, stores them locally, and never verifies either. There is no OTP, password, token, or backend identity. Captain status is entirely client-asserted: any client can publish a `CAPTAIN_RIDE_STATE` packet and redirect every member in the room, or send a fake SOS. Logout only hides the screen.

### 4.4 Data handling

- Everything is in **one `localStorage` key** (`apexmile_map_radar_v9`), unencrypted, with no expiry.
- Vehicle photos are stored as base64 data URLs in the same record; two or three photos can consume the 5 MB quota, and `saveState()` swallows quota errors silently.
- No privacy policy, consent screen, data-deletion path, or export/import beyond CSV.
- Safari can evict script-writable storage, so years of mileage logs can vanish.

### 4.5 Spoofing and abuse

No rate limits on pings; no ack/delivery semantics; no verification that a `CAPTAIN_RIDE_STATE` came from the actual captain; no way to block or report a rider; no room password. The "Fast & Secure" line on the signup screen is not supported by the implementation.

---

## 5. Correctness, data quality, and product claims

### 5.1 Fuel and mileage math

- **Assumes every fill-up is tank-to-tank.** Litres are derived from `amount ÷ selected octane price` (`L5111`), not entered directly. If the price is wrong, the litres and km/L are wrong. There is no "partial fill" or "filled to full?" option, which is the single most important input for accurate mileage.
- **Editing ODO backwards is allowed** (`saveEditedOdo` accepts any value ≥ 0), which corrupts every subsequent distance and km/L calculation; no reconciliation with existing logs.
- **No sanity bounds** on km/L (a typo of 2,000 km can produce a 200 km/L bike) or on ODO jumps.
- **Mileage smoothing is a magic 60/40 blend** (`L5135`), and the first log replaces the user's entered mileage entirely.
- **Date defaults to a hard-coded `2026-10-14`** (`L1648`), not today, and has no `max`.
- **100 Octane is flat ₹160.00 in every city** — a placeholder, and not available at most pumps. 95 is also not universally sold.
- **Prices are hard-coded**, yet the UI says "Live Regional Fuel Rates" and "Live GPS". `syncLiveRegionalFuelPrices()` only picks the nearest hard-coded city and optionally reverse-geocodes the label. Spot-checking confirms the values are plausible for Oct 2026, but they will silently rot. Add "last verified" timestamps and a manual refresh path.

### 5.2 Route estimates are presented as facts

- Toll is `₹1.75/km` rounded to ₹25 for cars over 40 km (`L3918–3920`), displayed as `Toll ₹175` with no "estimate" qualifier.
- Alternative durations are fabricated multipliers (`×1.08`, `×1.15`, `×1.18`), and walking duration is forced to 4.8 km/h.
- Alternatives labelled "Lower tolls" / "No tolls" may reuse the same geometry as the base route when OSRM returns fewer than three routes (`rData.routes[1] || baseRoute`).
- Bike mode requests the **driving** profile; the public OSRM demo instance generally serves the car profile only, so the `foot` request for walking is likely to fail (worth testing explicitly).
- The "Live Traffic" toggle is just a Google tile layer, not traffic-aware routing. No ETA is adjusted for traffic.
- Arrival time uses the device clock; a wrong phone clock gives a wrong arrival time.

### 5.3 Group-ride logic

- Pack-gap is **straight-line distance** and always described as "X is behind you" — if you are the one at the back, it is still wrong. It does not use route progress or heading.
- **No hysteresis**: around 500 m the banner will flicker on/off with GPS noise.
- **No peer timeout**; stale riders accumulate.
- Leaving the group publishes `navStarted:false` but leaves the retained `captain_state` (trip name, destination) on the broker.
- `sessionActive` and `roomCode` persist across reloads without reconnecting, producing a "ghost session" that publishes nothing and shows incomplete state.
- `loadState()` deliberately wipes the planned route on every reload, so a refresh loses your destination and stops.

### 5.4 Insights can mislead

- Octane ROI assumes 91 gives 95% of your mileage and 100 gives 106%. Higher octane does not inherently improve fuel economy; presenting this as a comparison can push riders to buy premium fuel for no benefit.
- Scenario multipliers (highway 1.08, city 0.88, hills 0.84, pillion 0.90, aggressive 0.79) are arbitrary and presented as specific predictions.
- The trend chart plots the last five logs regardless of scenario, weather, or load, and has no axis values or context. Label these as rough estimates with methodology, or remove them.

### 5.5 Smaller issues

- `state.hasRealGpsFix` is read in `loadState()` and GPS handlers but never initialised in the state object.
- `recenterNavigationToMe` is **defined twice** (L3286 and L4356); the second silently wins, and the first (which calls `calibrateDeviceGps(true, true)`) is dead.
- `toggleOfflineMode` has no caller because `btnOfflineHeader` is missing.
- `voiceMicSearchBtn` is missing from the markup, so the listening/recording visual state never appears.
- `renderApp()` calls `saveState()` on every render, and peer telemetry triggers a full re-render every 2.5 s per rider — repeatedly stringifying all logs and photos to `localStorage` on the main thread.
- `deleteVehicle` leaves orphaned logs behind; CSV export includes all vehicles and has no `vehicleId` column.
- The chatty "Live GPS Always On" language is not matched by any mechanism that can keep GPS alive when the phone locks.

---

## 6. "iOS app" reality check

The filename says iOS app, but this is a **mobile web page**. It contains Apple web-app meta tags but no native code, no manifest, no service worker, and no icons.

### 6.1 Background location is not possible here

The entire group-ride concept depends on "your live location stays on for the pack", including when the phone is in a pocket with the screen off. On iOS Safari (and on home-screen web apps), **JavaScript is suspended when the screen locks or the app is backgrounded**; `watchPosition` stops, the WebSocket closes, and pings cannot be received. There is no web API for background location, and no wake lock is requested. "Pocket mode" is just a black overlay; it does not stop the phone from auto-locking and it does not reduce GPS power draw.

So the promise that differentiates the product — always-on group tracking — **cannot be delivered by this implementation**, and cannot be delivered by any web app on iPhone. That requires a native app with Core Location background updates (`allowsBackgroundLocationUpdates`, "Always" permission, blue status indicator) and push notifications.

### 6.2 PWA gaps

- No `manifest.json`, no `theme-color`, no `apple-touch-icon`, no service worker.
- "Offline mode" only suppresses network lookups; tiles, map, and fonts are not cached, and the app is unusable offline.
- CDN dependencies (`unpkg`) mean a first load without network fails completely.
- `maximum-scale=1, user-scalable=no` (L5) blocks pinch-zoom, an accessibility failure (WCAG 1.4.4).

### 6.3 App Store implications

If the plan is to wrap this in a WKWebView and submit it:

- **Guideline 4.2 (Minimum Functionality)** — repackaged websites are commonly rejected.
- **Guideline 3.1.1** — a ₹19 "auto-debit via UPI Autopay / Apple ID" with no StoreKit is not a real subscription and is misleading.
- **Guidelines 5.1.1 / 5.1.2** — location and personal data require purpose strings, consent, and a privacy policy; background location needs a strong justification.
- **Guideline 1.4.1 (Safety)** — a navigation UI used while riding needs explicit safety warnings and must not encourage interaction at speed.
- Google raster tiles are not licensed for this use, and neither OSM nor Google attribution is displayed.

A native rebuild is not a nice-to-have for the group feature; it is the only honest way to deliver it.

---

## 7. Third-party services and licensing

| Service | Used for | Risk |
|---|---|---|
| `mt1.google.com/vt/lyrs=...` | Base, satellite, terrain, "traffic" tiles | **Violates Google Maps Platform ToS** (direct tile access, no API key, no attribution). Can break without notice. |
| `nominatim.openstreetmap.org` | Autocomplete + geocoding + reverse geocoding | Usage policy: **max 1 req/s, no autocomplete**, requires identifiable referrer and attribution. This app fires per keystroke (90 ms debounce), which will get it blocked. |
| `router.project-osrm.org` | Route geometry, steps, alternatives | Demo server, **no SLA**, car profile only; not for production traffic. |
| `overpass-api.de` | Nearby fuel/food/repair POIs | Fair-use service; can be slow or rate-limited; no caching. |
| `unpkg.com/mqtt` (unversioned) | MQTT client | Unpinned dependency; a breaking release can take the app down. No SRI. |
| `broker.emqx.io` | Group sync | Public broker, no auth/ACL/privacy. Demo-only. |

Also: Leaflet's attribution control is disabled (`attributionControl: false`) and no OSM credit appears anywhere. Nominatim/OSRM/Overpass data requires attribution. This is both a legal and an App Review issue.

For an India-first product, MapMyIndia/Mappls, Mapbox, or self-hosted MapLibre + OSM/MapTiler are realistic replacements; self-hosted OSRM or a commercial directions API is needed for production routing.

---

## 8. UX, visual design, accessibility

**Strengths:** clear hierarchy, strong brand color, useful empty states in places, sensible quick tiles, and a map layout that anticipates real riding use (landscape full-screen, camera lock, recenter).

**Concerns:**

- **Density on a phone.** The top stack on Map Radar contains pack-gap banner + turn signboard + "then" pill + mode bar + group button + origin/destination box + layer pills + group pack bar. On a 390 × 844 screen this can cover most of the map. It needs progressive disclosure and a "navigation mode" that hides non-essential chrome (the CSS hooks exist, but the missing nav functions are what would toggle them).
- **Touch targets and type sizes.** Many labels are 9–10 px; the swap button is 26 × 24 px; several pills are ~28 px tall. For gloved riders in sunlight this is not usable. Aim for ≥44 px targets and ≥14 px text in primary controls.
- **Accessibility.** No `<label>` elements, no ARIA, 30 clickable `<div>`/`<span>` elements, no keyboard focus states, color-only octane selection, and zoom disabled. Toasts are not announced (`aria-live` missing). `prefers-reduced-motion` is not respected despite heavy animation.
- **Safety.** The app encourages live map interaction while riding. Add a speed gate (disable UI above ~15 km/h), voice-first mode, and a prominent "pull over to interact" warning. Do not ship an SOS/breakdown feature that implies rescue reliability over a public broker.
- **Google Maps mimicry.** The green signboard, bottom navigation bar, and re-center pill are close to Google's trade dress, while also using Google tiles without a license. Build a distinct ApexMile navigation language instead.
- **First-run trust.** Asking for a phone number immediately, then broadcasting it, with a "Fast & Secure" claim and no privacy explanation, is a poor first impression. Make phone optional; explain exactly who sees location; default to approximate location for non-group users.
- **Error/loading states.** Everything is a toast. Route failures, geolocation denial, MQTT disconnects, and quota errors need persistent, actionable states.
- **Dark mode default.** `<body class="dark-mode">` plus an `auto` theme recalculated at load can flash; set the class before first paint from the same logic.

---

## 9. Architecture & maintainability

- **One 3,484-line script with ~140 global functions and a 35-field global `state`.** No modules, no build step, no types, no linting, no tests.
- **124 inline `onclick` attributes**, 249 inline `style` attributes, 46 `!important`. Styling and behavior are interleaved in the markup; CSP is impossible without a rewrite.
- **`renderApp()` is a god function** that reads ~25 elements, writes ~30, and calls `saveState()`. A single missing node takes down all rendering (as it does today).
- **Templating via `innerHTML`** for markers, lists, and modals — convenient, but the XSS surface and re-creation cost are significant.
- **No data migrations.** `STORAGE_KEY` is versioned (`v9`), but `loadState()` has no schema migration; adding or renaming a field will break returning users.
- **No tests.** A handful of Playwright tests with mocked MQTT/OSRM would have caught every P0 in this review.
- **Renderer thrash.** Every peer packet calls `updateMapRiderMarkers()`, `renderApp()`, and `saveState()`; with five riders that is multiple full DOM + localStorage passes per second.
- **Dead code and duplication** (`recenterNavigationToMe`, unused nav functions, unused helper functions, two auth screens) make the file harder to reason about than its size suggests.

A pragmatic split: `state.js`, `storage.js`, `mqtt.js`, `geo.js`, `routing.js`, `map.js`, `render/*.js`, `ui.js`, plus a small component layer. TypeScript + Vite would pay for itself within a week.

---

## 10. What I would do next

### Option A — Make the prototype honest and demoable (1–2 days)

1. Add the seven missing modals (or delete every reference and hide those controls). Write them as real drawers with the IDs the JS expects.
2. Guard `renderApp()` element access (`const el = ...; if (!el) return;`) or, better, add the missing modal so the crash disappears.
3. Decide on navigation: either implement `captainOrSoloStartNavigation`, `activateTurnByTurnNavigationUI`, `stopTurnByTurnNavigation`, `clearActiveRoute`, `renderStopTileBoxes`, and the step HUD — or **remove the Start/Exit/turn-banner UI** until it exists. A demo that says "route preview" is better than one that throws.
4. Fix the invite screen stacking (`#joinInviteScreen { z-index: 2600 }` and hide `#authScreen` when it is active).
5. Escape every interpolated value; validate `dname`/`trip`; add a CSP meta tag.
6. Replace "Live" fuel pricing with "Updated Oct 2026" and remove the fake auto-debit toggle, or label it "Demo".
7. Add attribution and swap Google tiles for MapLibre + a licensed tile source.
8. Put a loud "DEMO — do not use while riding; location is public" banner on the group screen if you keep the public broker.

Acceptance: every button on every screen either works or is hidden; no console errors; fresh login renders garage, history, insights, and group UI; an invite link shows the join form and joins in one tap.

### Option B — Production PWA (4–6 weeks)

- Vite + TypeScript modules, componentized rendering, lint + unit tests + Playwright.
- Firebase Auth (phone/OTP) + Firestore/RTDB (or Supabase) for rooms and presence; **never** a public broker. Room codes 6–8 characters, authenticated membership, per-room security rules, no phone in telemetry.
- MapLibre GL + MapTiler/MapMyIndia/self-hosted tiles; self-hosted OSRM or a commercial routing API; Photon/MapTiler for autocomplete with caching and a 300 ms debounce.
- Consent screen, privacy policy, data export/import, account deletion, retention limits, peer TTL, rate limits, and SOS disclaimers.
- PWA manifest, service worker, cached app shell and last-viewed tiles, offline queue for telemetry, wake lock while the map is open.
- Be explicit: **no background location**; the app pauses when the phone locks. Use Web Push (installed PWA) for pings, and tell users the phone must stay awake.

### Option C — Native iOS (recommended for the real vision; 6–10 weeks for an MVP)

- SwiftUI + MapKit or Mapbox/MapMyIndia; Core Location with background updates and the blue indicator; APNs for pings and pack-gap alerts; CloudKit/Firebase for rooms; Sign in with Apple; StoreKit 2 for Pro.
- Background geofencing/region monitoring for battery efficiency; motion activity to pause when stationary; local notifications when a rider falls behind.
- Privacy manifest, purpose strings, App Store review prep, crash/analytics.
- This is the only route that makes "always-on group radar" and "SOS ping" credible.

### Product advice

- **Pick one wedge for v1.** Mileage tracking is crowded and utilitarian; live group riding is differentiated but operationally hard. If you keep both, make the group radar the hero and treat mileage as the retention layer.
- **Reduce invite friction.** A guest join should take two taps: name (optional) + "Join". No phone number, no signup, no app install. The 4-digit code + hidden join screen is the opposite.
- **Safety is a feature, not a disclaimer.** SOS over a public broker is dangerous. If you keep it, make it "share my live location with my emergency contact via WhatsApp link" with an explicit expiry, not an implied rescue service.
- **Monetization.** ₹19/month via UPI Autopay is plausible for India, but a web page can't implement it and iOS requires StoreKit. Consider free group rides + Pro for history/analytics/vehicle count, or ₹99/year; don't fake an auto-debit.
- **Brand.** ApexMile has a strong name and palette. Lean into it; the Google Maps pastiche weakens it and creates legal exposure.

---

## 11. Prioritized fix list

### P0 — blocks any demo

1. Add/remove the seven missing modals; every `openModal` target must exist.
2. Fix `renderApp()` crash at `modalChainStatusSub`; verify fresh login renders all sections.
3. Implement or hide Start/Exit/Clear navigation, `isNavigating`, turn banner, and voice calls.
4. Fix invite-screen stacking so `?room=...` shows Join Ride.
5. Escape all dynamic HTML; validate URL params; add CSP.
6. Remove the public broker from any real-user flow, or gate it as an explicit demo with a warning.

### P1 — needed before real users

7. Replace Google tiles and add attribution.
8. Replace Nominatim autocomplete with a policy-compliant provider; debounce, cache, and handle failures.
9. Replace the OSRM demo; add a walking profile or remove walk mode.
10. Fix fuel math: full-tank/partial-fill, litres entry, ODO sanity, realistic km/L bounds, today's date, last-updated pricing.
11. Label tolls, fuel cost, and arrival as estimates; remove fake alternative tags; remove or caveat octane ROI.
12. Peer TTL, presence events, ping rate limits, no retained captain state, battery-aware publishing.
13. PWA basics or a native shell; background-location honesty.

### P2 — quality

14. Split the monolith; add TypeScript, lint, tests, CI.
15. Accessibility: zoom, labels, ARIA, 44 px targets, contrast, reduced motion.
16. Privacy policy, consent, account deletion, export/import, encryption at rest.
17. Replace the fake Pro toggle with StoreKit (iOS) or remove it.
18. Error monitoring, loading states, offline queue, analytics.

---

## 12. Appendix

### A. Missing DOM IDs referenced by JS (29)

`addVehKmpl`, `addVehName`, `addVehOctane`, `addVehOdo`, `addVehPhoto`, `addVehType`, `btnOfflineHeader`, `compassHeadingText`, `compassRoseRing`, `compassStatusSub`, `editModalHeaderTitle`, `editVehKmplInput`, `editVehNameInput`, `editVehOctaneSelect`, `editVehOdoInput`, `editVehPhotoInput`, `editVehResInput`, `editVehTankInput`, `editVehTypeSelect`, `modalChainStatusSub`, `modalOdoValue`, `modalPrice100`, `modalPrice91`, `modalPrice95`, `modalRegionSelect`, `profContactInput`, `profNameInput`, `riderModalBody`, `voiceMicSearchBtn`.

### B. Called but not defined

`activateTurnByTurnNavigationUI`, `captainOrSoloStartNavigation`, `clearActiveRoute`, `ensureRouteTileBoxesInitialized`, `renderStopTileBoxes`, `stopTurnByTurnNavigation`, `updateActiveNavigationStepHud`; plus the variable `routeTileBoxes`. `recenterNavigationToMe` is declared twice.

### C. Runtime check

- `node --check` on the extracted 3,484-line script: **passes** (so these are semantic errors, not syntax errors).
- jsdom load: `Uncaught TypeError: Cannot set properties of null (setting 'textContent')` at `renderApp` (file line 5261, `modalChainStatusSub`).
- With the 29 missing IDs stubbed, `renderApp()` completes, `switchTab('radar')` runs, and `openModal('profileModal')`/`openModal('addVehicleModal')` still fail because the modal containers themselves are absent.
- `startGroupRideSession(false)` with a destination throws `ReferenceError: ensureRouteTileBoxesInitialized is not defined`.
- No real browser was available; Google tile loading, Leaflet rendering, and OSRM/Nominatim responses were not exercised live.

### D. Fuel-price spot check (Oct 2026)

- Bengaluru petrol: ₹110.82–111.68/L (Goodreturns, India Today, Times of India, 15–16 Oct 2026).
- Thrissur petrol: ₹113.78–114.46/L (Goodreturns, Business Today, 8–14 Oct 2026).
- The app's ₹111.68 and ₹114.62 are therefore credible — the issue is static data presented as live, plus the flat ₹160 for 100 octane.

### E. Caveats

This review is based on static analysis, a Node/jsdom harness, and public documentation. jsdom does not implement Leaflet rendering, iOS Safari behavior, or network calls to Google/OSRM/Nominatim. Claims about Safari background suspension, App Store guidelines, and provider policies are based on platform documentation and well-known constraints, not on a live device test. The invite-screen stacking conclusion follows from equal `z-index` and DOM order and should be confirmed on device.

---

**Bottom line:** this is a strong product concept and an impressive piece of front-end craft wrapped around a half-connected skeleton. Fix the missing modals and the render crash, decide whether navigation is real or a mock, close the privacy holes, and then rebuild the group layer on an authenticated backend. Do that, and ApexMile has a genuinely differentiated idea worth pursuing.
