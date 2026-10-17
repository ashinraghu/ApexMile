// App bootstrap and the wiring between modules. If you are looking for where
// "everything meets", it is this file.
import { bus } from './bus.js';
import {
  state, save, saveNow, activeVehicle, setRegion, setUser,
} from './store.js';
import {
  $, $$, toast, haptic, applyTheme, applyMotion, initSheets, isStandalone, isIOS,
  onSystemThemeChange, clockTime, esc, openSheet, closeSheet,
} from './ui.js';
import { geo, startGeolocation, stopGeolocation, freshFix, distanceM, bearingDeg, speedKmph } from './geo.js';
import * as mapCtl from './map.js';
import {
  journey, plan, setDestination, setOrigin, setMode, clear as clearJourney,
  refresh as refreshJourney,
  currentRoute, estimates, hasRoute, MODES, MODE_META, modeRoute,
} from './journey.js';
import {
  localSuggest, remoteSuggest, rankSuggestions, geocode, reverseDistrict, reversePlace, formatDistance,
  setTomTomRoutingKey,
} from './routing.js';
import { uiIcon } from './navicons.js';
import {
  nav, startNavigation, stopNavigation, toggleVoice, setVoice, enterImmersive, exitImmersive,
} from './nav.js';
import {
  ride, createRide, joinRide, leaveRide, pingPeer, peerList,
  setDestination as setRideDestination, requestNotifications, normalizeCode, publishNow,
  setMyStatus, markMessagesRead, connectionInfo, reconnectRide,
  setMode as setRideMode,
} from './rooms.js';
import {
  openTripSheet, openJoinSheet, openInviteSheet, openRiderSheet, openStatusSheet,
  openStepsSheet, openProfileSheet, openPackSheet,
} from './sheets.js';
import {
  renderHome, renderRefuel, renderInsights, renderGarage, renderAll,
  initRefuel, initGarage,
} from './views.js';
import { FUEL_REGIONS, STATE_DEFAULT_PRICES, PRICES_VERIFIED } from './places.js';
import { tollPlazasFor } from './tolls.js';
import { refreshFuelPrices } from './prices.js';

const TABS = ['home', 'refuel', 'radar', 'insights', 'garage', 'privacy', 'safety'];
const TITLES = {
  home: 'ApexMile', refuel: 'Log a fill-up', radar: 'Ride radar',
  insights: 'Insights', garage: 'Garage', privacy: 'Privacy', safety: 'Riding safety',
};

let booted = false;
let currentTab = 'home';
let mapInitialised = false;
let lastPeerSig = null;
let lastGeoErrAt = 0;
let lastRideOfflineToast = 0;
let offlineCycles = 0;
let offlineGuided = false;
let geoFixStamp = 0;
let suggestionsToken = 0;
// Google-Maps flow: picking a place opens its card with a Bike/Car/Walk
// comparison, but Start stays hidden until the rider explicitly taps a mode
// for THIS destination. Reset whenever the destination changes.
let modeChosen = false;
let chosenDestKey = null;

/* ================================================================== boot */

function boot() {
  if (booted) return;
  booted = true;
  applyTheme(state.theme);
  applyMotion(state.motion);
  // The traffic key is a rider setting; hand it to the map before the radar is
  // opened so a restored overlay is live from the first frame. The same key
  // unlocks traffic-aware routing when it carries the Routing products.
  mapCtl.setTrafficKey(state.trafficKey);
  mapCtl.setTraffic(Boolean(state.trafficOn && state.trafficKey));
  setTomTomRoutingKey(state.trafficKey);

  initSheets();
  initRefuel();
  initGarage();
  initSettings();
  setVoice(state.navVoice !== false);
  refreshModeUi();
  initTabs();
  initHeader();
  initRadarUi();
  initAuth();
  initInstallHint();
  wireBus();
  wireNetwork();

  onSystemThemeChange(() => {
    if (state.theme === 'auto') {
      applyTheme('auto');
      syncMapTheme();
    }
  });

  const invited = readInviteFromUrl();
  if (invited) {
    showJoinScreen(invited);
  } else if (state.signedIn) {
    enterApp();
  } else {
    showAuth();
  }

  renderAll();
  renderSync();
  registerServiceWorker();
  // Today's district rate, fetched once the shell is on screen. If the feed is
  // unreachable the verified baseline above simply stays in place.
  refreshFuelPrices().catch(() => {});

  $('#boot')?.classList.add('hide');
  setTimeout(() => { const b = $('#boot'); if (b) b.remove(); }, 600);
}

/* ------------------------------------------------------------------ auth */

function initAuth() {
  $('#authStartBtn')?.addEventListener('click', () => {
    const name = ($('#authName')?.value || '').trim();
    if (name.length < 2) {
      toast('Tell us what to call you', { type: 'warn' });
      $('#authName')?.focus();
      return;
    }
    setUser({ name: name.slice(0, 32), phone: ($('#authContact')?.value || '').trim().slice(0, 24) });
    state.signedIn = true;
    state.createdAt = state.createdAt || Date.now();
    saveNow();
    enterApp();
    toast(`Welcome, ${name.split(' ')[0]}`, { icon: 'check' });
  });

  $('#authName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#authContact')?.focus();
  });
  $('#authContact')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#authStartBtn')?.click();
  });

  $('#avatarBtn')?.addEventListener('click', openProfileSheet);
}

function showAuth() {
  $('#authScreen').hidden = false;
  $('#joinScreen').hidden = true;
  $('#app').hidden = true;
}

function syncTravelMode() {
  if (!journey.userMode) {
    const mode = activeVehicle()?.type === 'Car' ? 'car' : 'bike';
    if (journey.mode !== mode) setMode(mode, { explicit: false });
  }
  refreshModeUi();
}

function enterApp() {
  $('#authScreen').hidden = true;
  $('#joinScreen').hidden = true;
  $('#app').hidden = false;
  $('#avatarInitial').textContent = (state.user.name || 'A').charAt(0).toUpperCase();
  syncTravelMode();
  renderAll();
  renderSync();
  detectRegion();
  go(hashTab() || 'home', { replace: true });
}

/* ------------------------------------------------------------------ invite */

function readInviteFromUrl() {
  const params = new URLSearchParams(location.search);
  const hashMatch = location.hash.match(/^#\/join\/([A-Z0-9]{4,8})/i);
  const room = normalizeCode(params.get('room') || (hashMatch ? hashMatch[1] : ''));
  if (!room) return null;
  if (room.length < 4) return null;
  return { room, trip: params.get('trip') || 'Group ride' };
}

function showJoinScreen(invite) {
  $('#authScreen').hidden = true;
  $('#app').hidden = true;
  const screen = $('#joinScreen');
  screen.hidden = false;
  $('#joinRoomCode').textContent = invite.room;
  $('#joinTitle').textContent = invite.trip ? `Join “${invite.trip}”` : 'Join the ride';
  const nameInput = $('#joinName');
  if (!nameInput.value) nameInput.value = state.user.name || '';

  $('#joinBtn').onclick = async () => {
    const name = (nameInput.value || '').trim();
    if (name.length < 2) return toast('Tell the pack your name', { type: 'warn' });
    setUser({ name: name.slice(0, 32) });
    state.signedIn = true;
    saveNow();
    $('#joinScreen').hidden = true;
    $('#app').hidden = false;
    $('#avatarInitial').textContent = (state.user.name || 'A').charAt(0).toUpperCase();
    await requestNotifications();
    joinRide(invite.room);
    if (invite.trip) ride.trip = invite.trip;
    renderAll();
    detectRegion();
    go('radar');
    toast('You are live on the radar', { icon: 'dish' });
    return true;
  };

  $('#joinCancelBtn').onclick = () => {
    $('#joinScreen').hidden = true;
    if (state.signedIn) enterApp();
    else showAuth();
    // Drop the invite parameters so a refresh does not re-prompt.
    try { history.replaceState({}, '', location.pathname); } catch { /* noop */ }
  };
}

/* ------------------------------------------------------------------ tabs */

function initTabs() {
  $$('.tb').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      haptic(5);
      go(tab);
    });
  });
  $$('[data-go]').forEach((el) => {
    el.addEventListener('click', () => go(el.dataset.go));
  });

  window.addEventListener('popstate', () => {
    const tab = hashTab();
    if (tab) go(tab, { fromHistory: true });
  });
  window.addEventListener('hashchange', () => {
    const tab = hashTab();
    if (tab && tab !== currentTab) go(tab, { fromHistory: true });
  });
}

function hashTab() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  return m && TABS.includes(m[1]) ? m[1] : null;
}

function syncGeolocationTracking() {
  const visible = document.visibilityState !== 'hidden';
  const needed = currentTab === 'radar' || nav.active || ride.active;
  if (visible && (state.signedIn || ride.active) && needed) startGeolocation();
  else stopGeolocation();
}

function go(tab, { replace = false, fromHistory = false } = {}) {
  if (!TABS.includes(tab)) tab = 'home';
  // Claim the tab before ending guidance: the nav:end handler needs to know
  // whether the rider is still looking at the map (restore the Directions
  // preview) or has moved on (leave it until they come back).
  const leavingRadar = nav.active && tab !== 'radar';
  currentTab = tab;
  // The map is the whole screen during guidance, so leaving it would leave the
  // rider staring at a blank page. Treat it like closing navigation.
  if (leavingRadar) stopNavigation({ reason: 'Navigation ended' });
  syncGeolocationTracking();

  for (const el of $$('.tab')) el.hidden = el.dataset.tab !== tab;
  for (const btn of $$('.tb')) btn.classList.toggle('active', btn.dataset.tab === tab);
  $('#topTitle').textContent = TITLES[tab] || 'ApexMile';
  document.body.dataset.tab = tab;
  const showBack = tab === 'privacy' || tab === 'safety';
  const back = $('#backBtn');
  if (back) back.hidden = !showBack;
  window.scrollTo({ top: 0, behavior: fromHistory ? 'auto' : 'smooth' });

  if (!fromHistory) {
    const want = `#/${tab}`;
    if (location.hash !== want) {
      try {
        if (replace) history.replaceState({}, '', want);
        else history.pushState({}, '', want);
      } catch { /* noop */ }
    }
  }

  if (tab === 'radar') {
    openRadar();
  } else if (tab === 'insights') {
    renderInsights();
  } else if (tab === 'garage') {
    renderGarage();
  } else if (tab === 'refuel') {
    renderRefuel();
  } else if (tab === 'home') {
    renderHome();
  }
}

/* ------------------------------------------------------------------ header */

function initHeader() {
  $('#backBtn')?.addEventListener('click', () => {
    if (TABS.indexOf(currentTab) > 4) go('garage');
    else history.back();
  });

  $('#themeBtn')?.addEventListener('click', () => {
    const next = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
    state.theme = next;
    save();
    applyTheme(next);
    syncMapTheme();
    toast(`Theme: ${next}`, { icon: 'info', ms: 1600 });
  });

  $('#syncBadge')?.addEventListener('click', () => {
    const label = ride.active
      ? `Room ${ride.code} · ${ride.status} · ${ride.peers.size} other rider${ride.peers.size === 1 ? '' : 's'}`
      : 'Solo. Start a group ride to appear on other riders’ maps.';
    toast(label, { icon: 'dish', ms: 4200 });
  });

  window.addEventListener('scroll', () => {
    $('#topbar')?.classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });
}

function renderSync() {
  const dot = $('#syncDot');
  const label = $('#syncLabel');
  if (!dot || !label) return;
  dot.className = 'dot';
  if (!navigator.onLine) { dot.classList.add('off'); label.textContent = 'Offline'; return; }
  if (!ride.active) { label.textContent = 'Solo'; return; }
  if (ride.status === 'live') { dot.classList.add('live'); label.textContent = 'Live'; }
  else if (ride.status === 'connecting') { dot.classList.add('warn'); label.textContent = 'Linking'; }
  else { dot.classList.add('warn'); label.textContent = 'Retrying'; }
}

/* ------------------------------------------------------------------ settings */

function syncVoiceUi() {
  const toggle = $('#voiceToggle');
  if (!toggle) return;
  toggle.setAttribute('aria-checked', nav.voiceOn ? 'true' : 'false');
  toggle.setAttribute('aria-label', nav.voiceOn ? 'Voice navigation on' : 'Voice navigation muted');
}

function renderSyncTransport() {
  const el = $('#syncTransportSub');
  if (!el) return;
  if (!ride.active) {
    el.textContent = 'Public brokers · automatic failover';
    return;
  }
  const info = connectionInfo();
  const link = ride.connected ? 'connected' : ride.status === 'connecting' ? 'linking…' : 'retrying…';
  el.textContent = `${info.brokerLabel || 'Auto'} · ${link}`;
}

function updateChatBadge(unread) {
  const badge = $('#gbChatBadge');
  if (!badge) return;
  const n = Number(unread) || 0;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.hidden = n <= 0;
}

function openSyncSheet() {
  const info = connectionInfo();
  const linkText = !ride.active
    ? 'No ride is open.'
    : ride.connected
      ? 'Connected — positions and messages are flowing.'
      : ride.status === 'connecting'
        ? 'Linking to a broker…'
        : 'No broker answered yet. Retrying automatically every 15 seconds.';

  openSheet({
    title: 'Ride sync',
    html: `
      <div class="prose">
        <p><b>${ride.active ? `Room ${esc(ride.code)}` : 'Not in a ride'}</b></p>
        <p>${linkText}</p>
        <p class="hint">${info.broker ? `Broker: ${esc(info.brokerLabel || info.broker)}` : 'Broker: choosing the best of four public relays'}</p>
        <p class="hint">${info.lastError ? `Last socket error: ${esc(info.lastError)}` : 'No socket error recorded.'}</p>
        <p class="hint">Public brokers are unauthenticated demos. Use them with people you trust.</p>
      </div>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" data-close>Close</button>
        <button class="btn primary" type="button" id="syncRetry">${ride.active ? 'Reconnect now' : 'Start a ride'}</button>
      </div>`,
    mount(body) {
      body.querySelector('#syncRetry').addEventListener('click', () => {
        closeSheet();
        if (!ride.active) { openTripSheet(); return; }
        reconnectRide();
        toast('Reconnecting to the ride room…', { icon: 'dish' });
      });
    },
  });
}

function initSettings() {
  syncVoiceUi();
  renderSyncTransport();
  updateChatBadge(ride._unread);

  $('#voiceToggle')?.addEventListener('click', () => {
    const on = setVoice(!nav.voiceOn);
    state.navVoice = on;
    saveNow();
    syncVoiceUi();
    haptic(8);
    toast(on ? 'Voice navigation on' : 'Voice navigation muted — saved', {
      icon: on ? 'voice-on' : 'voice-off',
      ms: 2000,
    });
  });

  $('#syncTestBtn')?.addEventListener('click', openSyncSheet);

  const trafficSetup = $('#trafficSetupBtn');
  if (trafficSetup) trafficSetup.textContent = state.trafficKey ? 'Change key' : 'Set up';
}

/* ------------------------------------------------------------------ live traffic */

/**
 * TomTom is the only traffic provider with a free flow-tile tier that does not
 * require a credit card (50,000 tiles/day). A key cannot be shipped in the
 * bundle — it is public the moment it is committed — so the rider pastes their
 * own, it is stored in this browser, and the overlay is optional.
 */
/**
 * Prove a TomTom key before turning the pill on: exactly one tile request.
 * Returns 'ok' | 'rejected' | 'quota' | 'unreachable'. A "rejected" verdict
 * is almost always a key created in TomTom's new portal without the Traffic
 * products enabled on it — until now the app accepted it silently and the
 * overlay simply never appeared.
 */
async function probeTrafficKey(key) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    let res;
    try { res = await fetch(mapCtl.trafficProbeUrl(key), { signal: ctl.signal, cache: 'no-store' }); }
    finally { clearTimeout(timer); }
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    if (res.status === 429) return 'quota';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

function openTrafficSheet() {
  const current = state.trafficKey || '';
  openSheet({
    title: 'Live traffic',
    html: `
      <p class="hint">Live traffic paints colour-coded flow over the map, and the same key unlocks
        traffic-aware routes and ETAs when it has routing access. It needs a free TomTom key —
        TomTom includes 50,000 tile requests a day and does not ask for a card.</p>
      <label class="field"><span>TomTom API key</span>
        <input id="trafficKeyInput" type="text" autocomplete="off" autocapitalize="off"
          spellcheck="false" placeholder="Paste your key" value="${esc(current)}" />
      </label>
      <p class="hint" id="trafficKeyStatus" role="status" hidden></p>
      <p class="hint">Create one at <b>developer.tomtom.com</b> → API &amp; SDK Keys, and on that key
        enable the <b>Traffic</b> and <b>Routing</b> products (simplest: select all available products).
        Without routing access, routes and ETAs fall back to the standard (no live traffic) estimates —
        clearly labelled. If you set a domain restriction, include this app's domain. The key is
        verified against TomTom before it is saved, and it never leaves this device.</p>
      <div class="sheet-actions">
        ${current
          ? '<button class="btn ghost" type="button" id="trafficRemove">Remove key</button>'
          : '<button class="btn ghost" type="button" data-close>Cancel</button>'}
        <button class="btn primary" type="button" id="trafficSave">${current ? 'Save & show traffic' : 'Enable live traffic'}</button>
      </div>`,
    mount(body) {
      const input = body.querySelector('#trafficKeyInput');
      const saveBtn = body.querySelector('#trafficSave');
      const statusEl = body.querySelector('#trafficKeyStatus');
      saveBtn?.addEventListener('click', async () => {
        const key = (input?.value || '').trim();
        if (key.length < 16) return toast('That key looks too short — paste the whole key', { type: 'warn' });
        saveBtn.disabled = true;
        if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'Checking the key with TomTom…'; }
        const verdict = await probeTrafficKey(key);
        saveBtn.disabled = false;
        if (verdict === 'rejected') {
          if (statusEl) {
            statusEl.textContent = 'TomTom refused this key (401/403). Open the key at developer.tomtom.com '
              + 'and enable the Traffic products on it — or select all available products — then try again. '
              + 'Also check that any domain restriction includes this app.';
          }
          return false;
        }
        state.trafficKey = key;
        state.trafficOn = true;
        saveNow();
        mapCtl.setTrafficKey(key);
        mapCtl.setTraffic(true);
        setTomTomRoutingKey(key); // a new key gets a fresh chance at routing access
        syncLayerPills();
        closeSheet();
        toast(verdict === 'quota' || verdict === 'unreachable'
          ? 'Saved — traffic will draw as soon as TomTom answers'
          : 'Key verified — live traffic on', { ms: 2600 });
        return true;
      });
      body.querySelector('#trafficRemove')?.addEventListener('click', () => {
        state.trafficKey = '';
        state.trafficOn = false;
        saveNow();
        mapCtl.setTrafficKey('');
        mapCtl.setTraffic(false);
        setTomTomRoutingKey('');
        syncLayerPills();
        closeSheet();
        toast('Live traffic key removed');
      });
    },
  });
}

/* ------------------------------------------------------------------ radar */

/** One search bar at rest; tapping it expands the origin/destination fields. */
function expandSearch(focus = true) {
  const box = $('#searchBox');
  if (!box) return;
  box.classList.add('expanded');
  if (focus) $('#destInput')?.focus();
}

function collapseSearch() {
  $('#searchBox')?.classList.remove('expanded');
}

/* ------------------------------------------------------------------ Google Maps handoff */

function openExternal(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Directions handoff: Google's own turn-by-turn for the current plan. */
function gmapsDirectionsUrl() {
  const to = journey.dest;
  if (!to) return null;
  const from = journey.origin
    || (geo.pos ? { lat: geo.pos.lat, lng: geo.pos.lng } : null)
    || (currentRoute()?.coords?.[0] ? { lat: currentRoute().coords[0][1], lng: currentRoute().coords[0][0] } : null);
  const travelmode = journey.mode === 'walk' ? 'walking' : 'driving';
  const origin = from ? `&origin=${from.lat},${from.lng}` : '';
  return `https://www.google.com/maps/dir/?api=1${origin}`
    + `&destination=${to.lat},${to.lng}&travelmode=${travelmode}`;
}

/**
 * The route sheet is a bottom card whose height follows its content. Publish
 * the measured height so the FABs and the attribution can sit exactly above
 * it instead of guessing a fixed offset and landing on top of the card.
 */
function syncSheetHeight() {
  const sheet = $('#routeSheet');
  if (!sheet || sheet.hidden) {
    document.body.style.removeProperty('--sheet-h');
    return;
  }
  requestAnimationFrame(() => {
    const h = Math.max(120, sheet.offsetHeight || 0);
    document.body.style.setProperty('--sheet-h', `${h + 12}px`);
  });
}

function initRadarUi() {
  $('#searchBox')?.addEventListener('click', () => expandSearch(false));
  $('#rsStartBtn')?.addEventListener('click', startPlannedNavigation);
  $('#rsGmapsBtn')?.addEventListener('click', () => {
    const url = gmapsDirectionsUrl();
    if (url) openExternal(url);
  });
  window.addEventListener('resize', syncSheetHeight);
  $('#fabZoomIn')?.addEventListener('click', () => mapCtl.mapCtl.map?.zoomIn());
  $('#fabZoomOut')?.addEventListener('click', () => mapCtl.mapCtl.map?.zoomOut());
  $('#fabPitch')?.addEventListener('click', () => {
    const pitch = mapCtl.togglePitch();
    $('#fabPitch').classList.toggle('on', pitch > 10);
  });
  $('#fabLocate')?.addEventListener('click', async () => {
    mapCtl.setFollow(true);
    try {
      const pos = await freshFix({ timeout: 9000 });
      if (pos) mapCtl.recenter(pos, { zoom: nav.active ? 17.2 : 16.4, pitch: nav.active ? 50 : 0 });
    } catch {
      toast('No GPS fix yet — move into the open', { type: 'warn' });
    }
  });
  $('#fabGroup')?.addEventListener('click', () => {
    if (!ride.active) openTripSheet();
    else openInviteSheet();
  });

  // Delegated because the trip sheet is cloned from a <template>.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('#joinRideLink');
    if (!link) return;
    closeSheet();
    setTimeout(() => openJoinSheet(), 360);
  });

  $('#destInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitDestination(); }
  });
  $('#destInput')?.addEventListener('input', onDestTyped);
  $('#destInput')?.addEventListener('focus', () => { if ($('#destInput').value) onDestTyped(); });
  $('#destClear')?.addEventListener('click', () => {
    $('#destInput').value = '';
    hideSuggestions();
    clearJourney();
    $('#destClear').hidden = true;
    $('#destInput').focus();
  });

  $('#originInput')?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.target.blur();
    const value = e.target.value.trim();
    if (!value || /^your location/i.test(value)) {
      setOrigin(null);
      toast('Starting from your location');
      return;
    }
    const place = await geocode(value);
    if (!place) return toast(`Could not find “${value}”`, { type: 'err' });
    setOrigin(place);
    toast(`Starting from ${place.name}`);
  });

  $('#swapBtn')?.addEventListener('click', swapEnds);
  $('#micBtn')?.addEventListener('click', startVoiceSearch);
  $('#rsStepsBtn')?.addEventListener('click', openStepsSheet);
  $('#rsClearBtn')?.addEventListener('click', () => { clearJourney(); hideSuggestions(); $('#destInput').value = ''; });
  $('#navExitBtn')?.addEventListener('click', confirmEndNavigation);
  $('#navEtaBtn')?.addEventListener('click', openStepsSheet);
  $('#navGroupBtn')?.addEventListener('click', () => {
    if (ride.active) openInviteSheet();
    else openTripSheet();
  });
  $('#navVoiceBtn')?.addEventListener('click', () => {
    const on = toggleVoice();
    state.navVoice = on;
    saveNow();
    syncVoiceUi();
    toast(on ? 'Voice on' : 'Voice muted', { icon: on ? 'voice-on' : 'voice-off', ms: 1400 });
  });

  $('#gbShare')?.addEventListener('click', openInviteSheet);
  $('#gbMe')?.addEventListener('click', openStatusSheet);
  $('#gbChat')?.addEventListener('click', () => {
    openPackSheet();
    markMessagesRead();
  });

  // Satellite is a toggle; the theme still owns streets/night underneath it.
  $('#satellitePill')?.addEventListener('click', () => {
    const on = mapCtl.mapState().preset !== 'satellite';
    mapCtl.setStylePreset(on ? 'satellite' : basePreset());
    state.mapSatellite = on;
    saveNow();
    syncLayerPills();
    haptic(5);
  });

  $('#trafficPill')?.addEventListener('click', () => {
    if (!state.trafficKey) {
      openTrafficSheet();
      return;
    }
    const on = !mapCtl.mapState().traffic;
    mapCtl.setTraffic(on);
    state.trafficOn = on;
    saveNow();
    syncLayerPills();
    haptic(5);
    toast(on ? 'Live traffic on' : 'Live traffic off', { ms: 1400 });
  });

  $('#trafficSetupBtn')?.addEventListener('click', openTrafficSheet);

  // Tapping empty map dismisses the keyboard and suggestions, and folds an
  // empty search panel back to the single bar.
  $('#map')?.addEventListener('click', () => {
    hideSuggestions();
    $('#destInput')?.blur();
    const empty = !($('#destInput')?.value || '').trim() && !($('#originInput')?.value || '').trim() && !journey.dest;
    if (empty) collapseSearch();
  });
}

async function openRadar() {
  if (!mapInitialised) {
    mapInitialised = true;
    const center = geo.pos || state.lastPos || undefined;
    mapCtl.initMap({
      center,
      preset: state.mapSatellite ? 'satellite' : basePreset(),
    });
    syncLayerPills();
    $('#fabLocate')?.classList.add('on');
    mapCtl.mapCtl.map?.on('load', () => {
      $('#fabPitch')?.classList.toggle('on', false);
    });
  }
  mapCtl.resize();
  if (geo.pos) mapCtl.setMe(geo.pos);
  if (ride.active) syncPeersToMap();
  if (!hasRoute() && geo.pos && !nav.active) {
    setTimeout(() => mapCtl.recenter(geo.pos, { zoom: 15.8, duration: 400 }), 260);
  }
  // A plan survives leaving the radar; bring its preview back rather than
  // stranding the rider with a route on the map and no card.
  if (hasRoute() && !nav.active && !journey.loading && $('#routeSheet')?.hidden) {
    refreshJourney();
  }
}

function basePreset() {
  return document.documentElement.dataset.theme === 'dark' ? 'night' : 'streets';
}

function syncLayerPills() {
  const st = mapCtl.mapState();

  const satellite = $('#satellitePill');
  const satOn = st.preset === 'satellite';
  satellite?.classList.toggle('active', satOn);
  satellite?.setAttribute('aria-pressed', satOn ? 'true' : 'false');

  const traffic = $('#trafficPill');
  const trafficOn = Boolean(st.traffic);
  traffic?.classList.toggle('active', trafficOn);
  traffic?.classList.toggle('needs-key', !state.trafficKey);
  traffic?.setAttribute('aria-pressed', trafficOn ? 'true' : 'false');
  traffic?.setAttribute('aria-label', state.trafficKey
    ? (trafficOn ? 'Turn live traffic off' : 'Turn live traffic on')
    : 'Set up live traffic');

  const setup = $('#trafficSetupBtn');
  if (setup) setup.textContent = state.trafficKey ? 'Change key' : 'Set up';
}

/** Keep the basemap in step with the app theme, without fighting satellite. */
function syncMapTheme() {
  if (!mapInitialised) return;
  const preset = mapCtl.mapState().preset;
  if (preset === 'satellite') return; // an explicit rider choice wins
  const target = basePreset();
  if (target !== preset) {
    mapCtl.setStylePreset(target);
    syncLayerPills();
  }
}

/* ------------------------------------------------------------------ destination search */

function onDestTyped() {
  const input = $('#destInput');
  const q = input.value.trim();
  $('#destClear').hidden = !q;
  const token = ++suggestionsToken;
  clearTimeout(onDestTyped._timer);
  if (q.length < 2) { hideSuggestions(); return; }

  const local = localSuggest(q, geo.pos, 6);
  renderSuggestions(local, q, false);
  if (!navigator.onLine) {
    renderSuggestions(local, q, true);
    return;
  }

  // Photon is designed for interactive OSM search. Nominatim is deliberately
  // reserved for explicit submissions so typing cannot hammer its public API.
  onDestTyped._timer = setTimeout(async () => {
    try {
      const remote = await remoteSuggest(q, 10);
      if (token !== suggestionsToken) return;
      renderSuggestions(rankSuggestions([...local, ...remote], q, 7), q, true);
    } catch {
      if (token !== suggestionsToken) return;
      renderSuggestions(local, q, true);
    }
  }, 380);
}

function renderSuggestions(items, query, settled) {
  const box = $('#acList');
  if (!box) return;
  box.innerHTML = '';

  if (!items.length && !settled) {
    const pending = document.createElement('div');
    pending.className = 'ac-message';
    pending.textContent = 'Searching map places…';
    box.append(pending);
    box.hidden = false;
    return;
  }

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'ac-message';
    empty.textContent = 'No matching listings found yet.';
    box.append(empty);
  }

  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ac-item';
    btn.innerHTML = `
      <span class="ac-ico">${uiIcon(item.source === 'local' ? 'pin' : 'compass')}</span>
      <span class="ac-mid">
        <span class="ac-t">${esc(item.name)}</span>
        <span class="ac-s">${esc(item.sub || item.category || '')}</span>
      </span>
      <span class="ac-d">${Number.isFinite(item.dist) ? `${(item.dist / 1000).toFixed(1)} km` : ''}</span>`;
    btn.addEventListener('click', () => {
      $('#destInput').value = item.name;
      $('#destClear').hidden = false;
      hideSuggestions();
      $('#destInput').blur();
      setDestination(item);
    });
    box.append(btn);
  });

  if (settled && query.trim()) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ac-item ac-more';
    more.innerHTML = `<span class="ac-ico">${uiIcon('search')}</span><span class="ac-mid"><span class="ac-t">Try extended search for “${esc(query)}”</span><span class="ac-s">Checks a second map index; coverage still depends on map data</span></span>`;
    more.addEventListener('click', () => submitDestination());
    box.append(more);
  }

  const attribution = document.createElement('div');
  attribution.className = 'ac-footer';
  attribution.textContent = 'OpenStreetMap contributors · Photon';
  box.append(attribution);
  box.hidden = false;
}

function hideSuggestions() {
  suggestionsToken += 1;
  clearTimeout(onDestTyped._timer);
  const box = $('#acList');
  if (box) box.hidden = true;
}

async function submitDestination() {
  const value = ($('#destInput')?.value || '').trim();
  if (!value) return;
  hideSuggestions();
  $('#destInput')?.blur();
  if (journey.dest && journey.dest.name.toLowerCase() === value.toLowerCase()) {
    if (!journey.routes.length) plan();
    return;
  }
  const place = await geocode(value);
  if (!place) return toast(`Could not find “${value}”`, { type: 'err' });
  $('#destInput').value = place.name;
  $('#destClear').hidden = false;
  await setDestination(place);
}

function swapEnds() {
  if (!journey.dest) return toast('Pick a destination first', { type: 'warn' });
  const dest = journey.dest;
  const origin = journey.origin || (geo.pos ? { name: 'Your location', lat: geo.pos.lat, lng: geo.pos.lng } : null);
  journey.dest = origin ? { name: origin.name, lat: origin.lat, lng: origin.lng } : null;
  journey.origin = { name: dest.name, lat: dest.lat, lng: dest.lng };
  $('#destInput').value = journey.dest?.name || '';
  $('#originInput').value = journey.origin?.name || 'Your location';
  if (journey.dest) plan(); else clearJourney();
  toast('Start and destination swapped');
}

/* ------------------------------------------------------------------ voice search */

function startVoiceSearch() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) {
    toast('Voice search needs Chrome or a device keyboard with dictation', { type: 'warn' });
    $('#destInput')?.focus();
    return;
  }
  const rec = new Rec();
  rec.lang = 'en-IN';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  const btn = $('#micBtn');
  btn?.classList.add('rec');
  toast('Listening…', { icon: 'mic', ms: 1800 });
  rec.onresult = (ev) => {
    const text = ev.results?.[0]?.[0]?.transcript?.trim();
    if (!text) return;
    $('#destInput').value = text;
    submitDestination();
  };
  rec.onerror = () => toast('Did not catch that', { type: 'warn' });
  rec.onend = () => { btn?.classList.remove('rec'); };
  try { rec.start(); } catch { btn?.classList.remove('rec'); }
}

/* ------------------------------------------------------------------ journey events */

function fmtEta(durationSec) {
  const mins = Math.max(1, Math.round(durationSec / 60));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

function onJourneyUpdate({ cleared } = {}) {
  const sheet = $('#routeSheet');
  // A new destination restarts the Google-Maps flow: compare modes first,
  // only then ETA + Start for the tapped mode.
  if (journey.dest) {
    const key = `${journey.dest.lat},${journey.dest.lng}`;
    if (key !== chosenDestKey) { chosenDestKey = key; modeChosen = false; }
  }
  if (cleared || !journey.dest) {
    modeChosen = false;
    chosenDestKey = null;
    sheet.hidden = true;
    document.body.classList.remove('has-sheet');
    if (!nav.active) {
      $('#destInput').value = '';
      $('#destClear').hidden = true;
    }
    const originInput = $('#originInput');
    if (originInput) originInput.value = '';
    const cost = $('#rsCost');
    if (cost) cost.hidden = true;
    const modeHost = $('#rsMode');
    if (modeHost) modeHost.innerHTML = '';
    collapseSearch();
    syncSheetHeight();
    refreshModeUi();
    return;
  }

  if (journey.loading) {
    sheet.hidden = false;
    document.body.classList.add('has-sheet');
    $('#rsDest').textContent = journey.dest.name;
    $('#rsEta').textContent = 'Planning…';
    $('#rsDist').textContent = '';
    $('#rsSub').textContent = 'Checking Bike, Car and Walk routes…';
    $('#rsNote').textContent = 'Checking roads, turns and traffic for each mode.';
    const cost = $('#rsCost');
    if (cost) cost.hidden = true;
    const altsEl = $('#alts');
    if (altsEl) altsEl.hidden = true;
    renderModeCompare();
    refreshModeUi();
    syncSheetHeight();
    return;
  }

  const route = currentRoute();
  if (!route) {
    if (journey.error) {
      sheet.hidden = false;
      $('#rsDest').textContent = journey.dest.name;
      $('#rsEta').textContent = 'No route';
      $('#rsDist').textContent = '';
      $('#rsSub').textContent = journey.error;
      $('#rsNote').textContent = 'Check the start and destination, or try again when you are online.';
      $('#alts').hidden = true;
      const cost = $('#rsCost');
      if (cost) cost.hidden = true;
      renderModeCompare();
      syncSheetHeight();
    }
    refreshModeUi();
    return;
  }

  const est = estimates(route);
  sheet.hidden = false;
  document.body.classList.add('has-sheet');
  $('#rsDest').textContent = journey.dest.name;

  if (!modeChosen) {
    // Place picked, routes compared — but the rider has not chosen how to
    // travel yet. Show the comparison only: no headline ETA, no Start.
    $('#rsEta').textContent = 'Choose a mode';
    $('#rsDist').textContent = '';
    $('#rsSub').textContent = 'Tap Bike, Car or Walk — its ETA and Start will appear here.';
    $('#rsNote').textContent = 'Every ETA above is planned for that mode, not guessed from another mode\u2019s route.';
    const cost = $('#rsCost');
    if (cost) cost.hidden = true;
    const altsEl = $('#alts');
    if (altsEl) altsEl.hidden = true;
    if (!nav.active) {
      $('#destInput').value = journey.dest.name;
      $('#destClear').hidden = false;
      collapseSearch();
    }
    renderModeCompare();
    refreshModeUi();
    syncCaptainDestination();
    syncSheetHeight();
    return;
  }

  $('#rsEta').textContent = fmtEta(route.duration);
  $('#rsDist').textContent = `${est.km >= 10 ? est.km.toFixed(1) : est.km.toFixed(2)} km`;
  const basis = route.etaSource === 'tomtom' ? 'traffic-aware ETA' : 'standard estimate';
  $('#rsSub').textContent = `${MODE_META[journey.mode]?.label || 'Route'} · ${clockTime(est.arrival)} arrival · ${basis}`;
  // A finished plan folds the search panel back to one bar showing the place.
  if (!nav.active) {
    $('#destInput').value = journey.dest.name;
    $('#destClear').hidden = false;
    collapseSearch();
  }

  const alts = $('#alts');
  if (journey.routes.length > 1) {
    alts.hidden = false;
    alts.innerHTML = '';
    journey.routes.forEach((r, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `alt ${i === journey.selected ? 'active' : ''}`;
      const m = Math.round(r.duration / 60);
      b.innerHTML = `${m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`}<small>${(r.distance / 1000).toFixed(1)} km</small>`;
      b.addEventListener('click', () => journey.select(i));
      alts.append(b);
    });
  } else {
    alts.hidden = true;
  }

  renderModeCompare();
  renderRouteCost(route);
  refreshModeUi();
  syncCaptainDestination();
  syncSheetHeight();

  if (est.mode === 'car') ensureTolls(route);
}

/**
 * No Directions button any more (Google-Maps flow): picking a suggestion
 * opens the place card directly. Start is revealed only after the rider
 * taps a mode in the comparison for this destination, and its ETA is that
 * mode's real routed ETA.
 */
function refreshModeUi() {
  const ready = Boolean(journey.dest && currentRoute()) && modeChosen && !journey.loading;
  const start = $('#rsStartBtn');
  if (start) {
    start.disabled = !ready;
    start.hidden = !ready;
  }
}

/**
 * The switchable Bike / Car / Walk comparison. Each card shows that mode's
 * real routed ETA + distance (planned in parallel by planComparison), the
 * fastest mode is tagged, and tapping a card selects it — revealing the
 * headline ETA + Start for exactly that mode.
 */
function renderModeCompare() {
  const host = $('#rsMode');
  if (!host) return;
  host.innerHTML = '';
  const durations = MODES.map((m) => modeRoute(m)?.duration).filter((d) => Number.isFinite(d));
  const fastest = durations.length ? Math.min(...durations) : null;
  for (const mode of MODES) {
    const route = modeRoute(mode);
    const b = document.createElement('button');
    b.type = 'button';
    const selected = modeChosen && journey.mode === mode;
    b.className = `mode-card ${selected ? 'active' : ''}`;
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    let eta;
    let dist = '';
    let tag = '';
    if (route) {
      eta = fmtEta(route.duration);
      const km = route.distance / 1000;
      dist = `${km >= 10 ? km.toFixed(1) : km.toFixed(2)} km`;
      if (fastest != null && route.duration === fastest && durations.length > 1) tag = '<span class="mc-tag">Fastest</span>';
    } else if (journey.loading || journey.comparing) {
      eta = 'Checking…';
      b.disabled = true;
    } else {
      eta = 'No route';
      b.disabled = true;
    }
    b.innerHTML = `${uiIcon(MODE_META[mode].icon)}<span class="mc-label">${MODE_META[mode].label}</span><span class="mc-eta">${eta}</span><span class="mc-dist">${dist}</span>${tag}`;
    b.addEventListener('click', () => {
      if (!modeRoute(mode)) return;
      modeChosen = true;
      haptic(6);
      setMode(mode); // instant: this mode was already planned for comparison
      refreshModeUi();
      if (ride.active && ride.isCaptain) setRideMode(mode);
      // setMode emits journey:update when the mode actually switches; when
      // re-tapping the current mode it may not, so re-render explicitly.
      onJourneyUpdate();
    });
    host.append(b);
  }
}

/** The honest sentence about where this ETA came from, plus what traffic costs. */
function etaBasisSentence(route) {
  if (route?.etaSource === 'tomtom') {
    const delay = Math.round((route.trafficDelay || 0) / 60);
    return `Traffic-aware ETA from TomTom${delay >= 1 ? ` — traffic adds about ${delay} min on this route` : ''}.`;
  }
  return 'Standard estimate — planned without live traffic.';
}

function renderRouteCost(route) {
  const host = $('#rsCost');
  if (!host) return;
  const est = estimates(route);
  if (!est) { host.hidden = true; return; }
  host.hidden = false;

  const basis = etaBasisSentence(route);

  if (est.mode === 'walk') {
    host.innerHTML = '<div class="rs-cost-row"><span>Walking</span><b>No fuel or tolls</b></div>';
    $('#rsNote').textContent = `${basis} Pedestrian route. No fuel or toll cost.`;
    return;
  }

  const fuel = Math.round(est.fuel);
  const tolls = Math.round(est.tolls);
  const total = Math.round(est.total);
  const info = route.tollInfo;

  let tollCell = '<b>Free for bikes</b>';
  let tollLabel = 'Tolls';
  if (est.mode === 'car') {
    if (!info) {
      tollCell = '<b>Checking…</b>';
    } else if (info.unavailable) {
      tollCell = '<b>Not available</b>';
      tollLabel = 'Tolls';
    } else {
      tollCell = `<b>₹${tolls}</b>`;
      tollLabel = `Tolls · ${info.count} plaza${info.count === 1 ? '' : 's'}`;
    }
  }

  host.innerHTML = `
    <div class="rs-cost-row"><span>Fuel${est.litres ? ` · ${est.litres.toFixed(1)} L` : ''}</span><b>₹${fuel}</b></div>
    <div class="rs-cost-row"><span>${tollLabel}</span>${tollCell}</div>
    <div class="rs-cost-row total"><span>Estimated total · ${esc(est.vehicleName)}${est.vehicleType && est.mode !== 'walk' && est.vehicleType.toLowerCase() !== est.mode ? ` · ${esc(est.vehicleType.toLowerCase())}` : ''}</span><b>₹${total}</b></div>
    <div class="rs-cost-row"><span class="fine">${est.measured ? `At your measured ${est.kmpl.toFixed(1)} km/L` : `At an estimated ${est.kmpl.toFixed(1)} km/L`} · ₹${(state.region.prices[state.octane] || 0).toFixed(2)}/L</span></div>`;

  if (est.mode === 'bike') {
    $('#rsNote').textContent = `${basis} Bikes are toll-free on national highways. Fuel uses your own mileage.`;
  } else if (!info) {
    $('#rsNote').textContent = `${basis} Looking for toll plazas along this route…`;
  } else if (info.unavailable) {
    $('#rsNote').textContent = `${basis} Toll estimate unavailable for a route this long. Fuel cost is still included.`;
  } else {
    const noCar = est.vehicleType && est.vehicleType !== 'Car'
      ? `No car in the garage — fuel uses ${est.vehicleName}'s mileage. `
      : '';
    $('#rsNote').textContent = `${basis} ${noCar}Tolls estimated from ${info.count} mapped plaza${info.count === 1 ? '' : 's'} at ₹${info.rate}/plaza. Actual FASTag rates vary.`;
  }
}

async function ensureTolls(route) {
  if (!route || route.tollInfo || route._tollsBusy || !route.coords?.length) return;
  route._tollsBusy = true;
  try {
    const info = await tollPlazasFor(route.coords, 'car');
    route.tollInfo = info;
    route.tolls = info.total;
  } catch {
    route.tollInfo = { count: 0, rate: 0, total: 0, plazas: [], unavailable: true };
  } finally {
    route._tollsBusy = false;
    if (currentRoute() === route && journey.mode === 'car') renderRouteCost(route);
  }
}

/** The captain's destination is the pack's destination. Publish it as soon as
 *  it is chosen, not only when navigation starts. */
function syncCaptainDestination() {
  if (!ride.active || !ride.isCaptain || !journey.dest) return;
  const current = ride.dest;
  const same = current
    && Math.abs(Number(current.lat) - Number(journey.dest.lat)) < 1e-6
    && Math.abs(Number(current.lng) - Number(journey.dest.lng)) < 1e-6;
  if (!same) setRideDestination(journey.dest, false);
}

async function startPlannedNavigation() {
  if (!journey.dest) return;
  if (journey.loading) return toast('Still planning…', { ms: 1200 });

  // Ask for the system fullscreen while the tap is still a user gesture. A
  // re-plan below can await the network, and browsers only honour the request
  // while it is still tied to the gesture.
  enterImmersive();

  const rsStart = $('#rsStartBtn');
  if (rsStart) rsStart.disabled = true;

  try {
    // If we planned from "my location" a while ago, re-plan from where we are now.
    if (!journey.origin) {
      const stale = !journey.routes.length || distanceM(
        { lat: journey.routes[0].coords[0][1], lng: journey.routes[0].coords[0][0] },
        geo.pos || { lat: 0, lng: 0 },
      ) > 220;
      if (stale) await plan({ fit: false, silent: true });
    }
    const route = currentRoute();
    if (!route) throw new Error('no route');
    const ok = startNavigation(route, {
      to: journey.dest,
      via: journey.stops,
      label: journey.dest.name,
    });
    if (ok && ride.active && ride.isCaptain) {
      setRideDestination(journey.dest, true);
    }
  } catch {
    toast('Could not start navigation', { type: 'err' });
    exitImmersive();
  } finally {
    if (!nav.active) exitImmersive();
    refreshModeUi();
  }
}

function confirmEndNavigation() {
  openSheet({
    title: 'End navigation?',
    html: `<p class="hint">Your live location keeps sharing while you stay in the ride room. End the ride separately to stop sharing.</p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" data-close>Keep going</button>
        <button class="btn danger" type="button" id="endNavConfirm">End</button>
      </div>`,
    mount(body) {
      body.querySelector('#endNavConfirm').addEventListener('click', () => {
        closeSheet();
        stopNavigation();
      });
    },
  });
}

/* ------------------------------------------------------------------ group ride */

async function startRideFromModal({ trip, dest }) {
  createRide({ trip: trip || 'Group ride' });
  if (ride.isCaptain) setRideMode(journey.mode);
  // Never block the ride on a permission dialog.
  requestNotifications().catch(() => {});
  toast(`Room ${ride.code} is live`, { icon: 'dish', ms: 3000 });

  if (dest) {
    const place = await geocode(dest);
    if (place) {
      $('#destInput').value = place.name;
      $('#destClear').hidden = false;
      await setDestination(place);
      if (ride.isCaptain) setRideDestination(place, false);
    }
  }
  setTimeout(() => openInviteSheet(), 500);
}

function updateGroupUi() {
  const peers = peerList();
  const active = ride.active;
  const total = peers.length + (active ? 1 : 0);

  $('#fabGroup').hidden = false;
  $('#fabGroup').setAttribute('aria-label', active ? 'Ride group' : 'Start a group ride');
  const badge = $('#fabGroupBadge');
  if (badge) {
    badge.textContent = String(total);
    badge.hidden = total < 2;
  }

  const navBadge = $('#navGroupBadge');
  if (navBadge) {
    navBadge.textContent = String(total);
    navBadge.hidden = total < 2;
  }

  const bar = $('#groupBar');
  bar.hidden = !active;
  bar.style.display = active ? '' : 'none';
  document.body.classList.toggle('in-ride', active);

  const sig = `${active ? 'live' : 'idle'}|${peers.map((p) => `${p.id}:${Math.round((p.distance || 0) / 50)}:${p.stale ? 1 : 0}:${p.sos ? 1 : 0}`).join('|')}`;
  const rebuild = sig !== lastPeerSig;
  lastPeerSig = sig;

  if (active && rebuild) {
    const host = $('#gbRiders');
    host.innerHTML = '';
    if (!peers.length) {
      const invite = document.createElement('button');
      invite.type = 'button';
      invite.className = 'gb-empty';
      invite.textContent = 'Waiting for riders — tap Invite';
      invite.addEventListener('click', openInviteSheet);
      host.append(invite);
    }
    for (const p of peers.slice(0, 8)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `gb-avatar ${p.sos ? 'sos' : ''} ${p.stale ? 'stale' : ''}`;
      b.style.background = p.sos ? '#E02D2D' : p.color;
      b.innerHTML = `${esc(p.name.charAt(0).toUpperCase())}<span class="dist">${p.distance == null ? '' : p.distance > 995 ? `${(p.distance / 1000).toFixed(1)}k` : `${p.distance}m`}</span>`;
      b.addEventListener('click', () => openRiderSheet(p.id));
      host.append(b);
    }
  }

  updateGapBanner(peers);
  renderSync();
}

function updateGapBanner(peers) {
  const banner = $('#gapBanner');
  if (!banner) return;
  const live = peers.filter((p) => !p.stale && p.distance != null);
  const me = geo.pos;
  if (!live.length || !ride.active || !me) {
    banner.hidden = true;
    return;
  }

  // `distance` is unsigned, so use the rider's heading to tell who is actually
  // behind us. Without a heading (new fix, standing still) stay neutral.
  const signed = live.map((p) => {
    const rel = me.heading == null
      ? null
      : ((bearingDeg(me, p) - me.heading + 540) % 360) - 180;
    return { ...p, rel };
  });

  const behind = signed
    .filter((p) => p.rel != null && p.rel < -80 && p.distance > 500)
    .sort((a, b) => b.distance - a.distance)[0];
  if (behind) {
    banner.hidden = false;
    $('#gapTitle').textContent = `${behind.name} is ${formatDistance(behind.distance)} behind`;
    $('#gapSub').textContent = `${behind.status || 'Riding'} · tap to ask them to catch up`;
    $('#gapPingBtn').textContent = 'Where are you?';
    $('#gapPingBtn').onclick = () => pingPeer(behind.id);
    return;
  }

  const ahead = signed
    .filter((p) => p.rel != null && p.rel > 80 && p.distance > 500)
    .sort((a, b) => b.distance - a.distance)[0];
  if (ahead) {
    banner.hidden = false;
    $('#gapTitle').textContent = `${ahead.name} is ${formatDistance(ahead.distance)} ahead`;
    $('#gapSub').textContent = `${ahead.status || 'Riding'} · you are behind the pack`;
    $('#gapPingBtn').textContent = 'Ping pack';
    $('#gapPingBtn').onclick = () => pingPeer(ahead.id);
    return;
  }

  // Heading unknown: report the nearest rider without guessing direction.
  const nearest = signed[0];
  if (nearest && nearest.distance > 500) {
    banner.hidden = false;
    $('#gapTitle').textContent = `${nearest.name} is ${formatDistance(nearest.distance)} away`;
    $('#gapSub').textContent = `${nearest.name} · ${nearest.status || 'Riding'}`;
    $('#gapPingBtn').textContent = 'Ping';
    $('#gapPingBtn').onclick = () => pingPeer(nearest.id);
    return;
  }

  banner.hidden = true;
}

function syncPeersToMap() {
  const peers = peerList();
  const ids = new Set(peers.map((p) => p.id));
  for (const id of mapCtl.mapCtl._peerMarkers.keys()) {
    if (!ids.has(id)) mapCtl.removePeer(id);
  }
  for (const p of peers) {
    if (p.lat != null && p.lng != null) mapCtl.upsertPeer(p, geo.pos);
  }
  updateGroupUi();
}

/* ------------------------------------------------------------------ region */

let regionBusy = false;

async function detectRegion(force = false) {
  if (regionBusy) return;
  if (state.region.custom && !force) return;
  regionBusy = true;
  try {
    let pos = geo.pos;
    if (!pos) pos = await freshFix({ timeout: 9000, highAccuracy: false, maximumAge: 20000 }).catch(() => null);
    if (!pos) return;

    const nearest = FUEL_REGIONS
      .map((r) => ({ r, d: distanceM(pos, r) }))
      .sort((a, b) => a.d - b.d)[0];

    let place = null;
    try { place = await reverseDistrict(pos.lat, pos.lng); } catch { /* offline is fine */ }

    if (nearest && nearest.d < 120000) {
      setRegion({
        ...nearest.r,
        city: place?.city || nearest.r.city,
        state: place?.state || nearest.r.state,
        verified: PRICES_VERIFIED,
        custom: false,
        live: false,
        fetchedAt: '',
        source: '',
      });
    } else if (place?.state) {
      const statePrices = STATE_DEFAULT_PRICES[place.state.toLowerCase()]?.prices;
      setRegion({
        city: place.city || place.district || 'Your district',
        state: place.state,
        prices: { ...(statePrices || state.region.prices) },
        verified: PRICES_VERIFIED,
        custom: false,
        live: false,
        fetchedAt: '',
        source: '',
      });
    }
    if (force) toast(`Rates for ${state.region.city}, ${state.region.state}`, { icon: 'fuel' });
    renderAll();
    refreshFuelPrices({ force: true }).catch(() => {});
  } finally {
    regionBusy = false;
  }
}

/* ------------------------------------------------------------------ profile */

function handleSignOut() {
  state.signedIn = false;
  stopGeolocation();
  saveNow();
  leaveRide({ silent: true });
  $('#app').hidden = true;
  showAuth();
  toast('Signed out on this device');
}

/* ------------------------------------------------------------------ install */

function initInstallHint() {
  const hint = $('#installHint');
  if (!hint) return;
  const dismissed = localStorage.getItem('apexmile.install.dismissed') === '1';
  if (isStandalone() || dismissed) { hint.hidden = true; return; }

  if (isIOS()) {
    hint.hidden = false;
    $('#installHintText').textContent = 'Tap the Share button, then “Add to Home Screen” for the full-screen app experience.';
  } else {
    hint.hidden = false;
    $('#installHintText').textContent = 'Open the browser menu and choose “Install app” to run ApexMile full screen.';
  }

  $('#installHintClose')?.addEventListener('click', () => {
    hint.hidden = true;
    localStorage.setItem('apexmile.install.dismissed', '1');
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__apexInstall = e;
    hint.hidden = false;
    $('#installHintText').textContent = 'Install ApexMile for full-screen maps and faster launches.';
    hint.style.cursor = 'pointer';
    hint.addEventListener('click', async (ev) => {
      if (ev.target.closest('#installHintClose')) return;
      const prompt = window.__apexInstall;
      if (!prompt) return;
      prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') hint.hidden = true;
      window.__apexInstall = null;
    }, { once: true });
  });
}

/* ------------------------------------------------------------------ service worker */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw]', err));
  });
}

/* ------------------------------------------------------------------ bus wiring */

function wireBus() {
  bus.on('geo:fix', (pos) => {
    // Navigation supplies the route-aligned puck itself; do not update it twice
    // for every GPS callback.
    if (!nav.active && currentTab === 'radar') mapCtl.setMe(pos);
    const now = Date.now();
    if (now - geoFixStamp > 4000) {
      geoFixStamp = now;
      const sub = $('#topSub');
      if (sub) {
        const speed = speedKmph();
        sub.textContent = speed > 3
          ? `${state.region.city || 'Live'} · ${speed} km/h`
          : `${state.region.city || 'Bengaluru'} · ${state.altitude != null ? `${state.altitude} m` : 'live'}`;
      }
      const alt = $('#heroAlt');
      if (alt) alt.textContent = state.altitude != null ? `${state.altitude} m` : '— m';
      if (ride.active) {
        if (currentTab === 'radar') syncPeersToMap();
        else updateGroupUi();
      }
    }
    if (!hasRoute() && mapInitialised && currentTab === 'radar' && !nav.active && mapCtl.mapCtl._meMarker && !mapCtl.isFollowing()) {
      // First fix after opening the radar: bring the rider into view.
      if (!window.__apexCenteredOnce) {
        window.__apexCenteredOnce = true;
        mapCtl.recenter(pos, { zoom: 16, duration: 600 });
      }
    }
  });

  bus.on('geo:error', ({ message }) => {
    const now = Date.now();
    if (now - lastGeoErrAt < 15000) return;
    lastGeoErrAt = now;
    toast(message, { type: 'warn', icon: 'pin', ms: 5200 });
  });

  bus.on('journey:update', onJourneyUpdate);

  bus.on('ride:changed', () => {
    syncGeolocationTracking();
    updateGroupUi();
    renderSync();
    renderSyncTransport();
    refreshModeUi();
  });

  bus.on('ride:transport', () => renderSyncTransport());

  bus.on('ride:message', ({ unread } = {}) => {
    updateChatBadge(unread);
  });

  bus.on('ride:peers', () => {
    if (currentTab === 'radar') syncPeersToMap();
    else updateGroupUi();
    renderSync();
  });

  bus.on('ride:status', ({ status } = {}) => {
    renderSync();
    renderSyncTransport();
    updateChatBadge(ride._unread);
    if (status === 'live') offlineCycles = 0;
    if (status === 'offline' && ride.active) {
      offlineCycles += 1;
      if (offlineCycles >= 3 && !offlineGuided) {
        // Every broker in the list failed repeatedly: that's not congestion,
        // it's a network that blocks public relays — say so and offer the out.
        offlineGuided = true;
        toast('No ride broker reachable on this network — some networks block them. Try mobile data, or set a custom broker in Ride settings', { type: 'err', icon: 'dish', ms: 7000 });
      } else if (!offlineGuided && Date.now() - lastRideOfflineToast > 20000) {
        lastRideOfflineToast = Date.now();
        toast('Ride sync is offline — position sharing will resume when the connection returns', { type: 'warn', icon: 'dish', ms: 4500 });
      }
    }
  });

  bus.on('ride:ping', ({ fromName }) => {
    openSheet({
      title: `${fromName} is asking`,
      html: `<p class="hint">They want to know where you are. Replying sends your live position and a status to the room.</p>
        <div class="sheet-actions">
          <button class="btn ghost" type="button" data-close>Later</button>
          <button class="btn primary" type="button" id="pingReply">Share my location</button>
        </div>`,
      mount(body) {
        body.querySelector('#pingReply').addEventListener('click', () => {
          setMyStatus('On my way', { sos: false });
          publishNow();
          closeSheet();
          toast('Location shared', { icon: 'pin' });
        });
      },
    });
  });

  bus.on('ride:captain-state', async (pkt) => {
    if (!pkt?.dest) return;
    if (nav.active) {
      toast(`${pkt.captainName || 'Captain'} set a new pack destination — end this route to pick it up`, { icon: 'dish', ms: 5000 });
      return;
    }
    toast(`${pkt.captainName || 'Captain'} set the destination: ${pkt.dest.name}`, { icon: 'dish', ms: 5000 });
    if (pkt.mode && pkt.mode !== journey.mode) {
      setMode(pkt.mode, { explicit: false });
      refreshModeUi();
    }
    const place = { name: pkt.dest.name, lat: pkt.dest.lat, lng: pkt.dest.lng };
    $('#destInput').value = place.name;
    $('#destClear').hidden = false;
    await setDestination(place);
    const recent = !pkt.updatedAt || Date.now() - Number(pkt.updatedAt) < 10 * 60 * 1000;
    if (pkt.navStarted && recent) {
      // The whole point of a pack ride: everyone starts together.
      startPlannedNavigation();
    } else if (pkt.navStarted) {
      toast('That captain route is from earlier — check the destination before starting', { type: 'warn', ms: 5000 });
    }
  });

  bus.on('ride:start-request', (payload) => startRideFromModal(payload));

  bus.on('map:userpan', () => {
    $('#fabLocate')?.classList.remove('on');
  });
  bus.on('map:follow', (on) => {
    $('#fabLocate')?.classList.toggle('on', Boolean(on));
  });
  bus.on('map:click', hideSuggestions);

  bus.on('peer:click', ({ id }) => openRiderSheet(id));

  bus.on('ride:joined', () => {
    go('radar');
    updateGroupUi();
  });

  bus.on('map:error', ({ message }) => {
    toast(message || 'Map engine did not load', { type: 'err', ms: 6000 });
  });

  bus.on('map:fallback', () => {
    toast('Map service is slow — switched to a lighter basemap', { icon: 'info', ms: 4200 });
  });

  bus.on('map:longpress', async ({ lat, lng }) => {
    const place = await reversePlace(lat, lng);
    openSheet({
      title: 'Dropped pin',
      html: `
        <div class="field"><span>${esc(place.name)}</span>
          <small>${esc(place.sub || `${lat.toFixed(5)}, ${lng.toFixed(5)}`)}</small></div>
        <div class="sheet-actions">
          <button class="btn primary" type="button" id="pinRoute">Route here</button>
        </div>
        ${ride.active && ride.isCaptain ? '<button class="btn ghost wide" type="button" id="pinShare">Send as the pack destination</button>' : ''}`,
      mount(body) {
        body.querySelector('#pinRoute').addEventListener('click', () => {
          closeSheet();
          $('#destInput').value = place.name;
          $('#destClear').hidden = false;
          setDestination(place);
        });
        body.querySelector('#pinShare')?.addEventListener('click', () => {
          setRideDestination(place, false);
          closeSheet();
          toast('Pack destination updated', { icon: 'dish' });
        });
      },
    });
  });

  bus.on('map:focus-peer', ({ lat, lng }) => {
    if (!lat || !lng) return;
    mapCtl.recenter({ lat, lng }, { zoom: 16, duration: 600 });
  });

  bus.on('traffic:error', ({ status } = {}) => {
    // map.js has already detached the overlay for this session. Do NOT wipe
    // the saved toggle: a midnight quota reset or a fixed key should quietly
    // start working again on the next launch.
    syncLayerPills();
    toast(status === 429
      ? 'TomTom\'s daily tile quota is used up — traffic returns when it resets'
      : 'TomTom refused the traffic key — enable the Traffic products on the key, then save it again in Ride settings', { type: 'err', ms: 6500 });
  });

  bus.on('region:detect', () => detectRegion(true));

  bus.on('profile:signout', handleSignOut);
  bus.on('motion:changed', (pref) => applyMotion(pref));
  bus.on('prices:changed', renderAll);
  bus.on('vehicles:changed', () => {
    syncTravelMode();
    renderAll();
  });
  bus.on('logs:changed', renderAll);

  bus.on('profile:save', ({ name, phone, theme }) => {
    if (name !== undefined) setUser({ name, phone });
    if (theme) { state.theme = theme; applyTheme(theme); }
    saveNow();
    $('#avatarInitial').textContent = (state.user.name || 'A').charAt(0).toUpperCase();
    if (ride.active) import('./rooms.js').then((m) => m.publishNow());
  });

  bus.on('store:quota', ({ message }) => toast(message, { type: 'warn', ms: 6000 }));

  bus.on('nav:start', () => {
    // A captain can start guidance for the pack while a follower is on another
    // tab; the immersive layout only works on the radar screen.
    if (currentTab !== 'radar') go('radar', { replace: true });
    $('#fabLocate')?.classList.add('on');
    mapCtl.resize();
  });
  bus.on('nav:end', () => {
    // Ending guidance goes back to Directions — never to an empty search box.
    // The destination, stops, alternatives and cost stay exactly as they were
    // entered; the sheet's ✕ closes the whole result and Start ride begins
    // guidance again. The route stays drawn so the preview is immediately
    // recognisable.
    const routeSheet = document.querySelector('.route-sheet');
    // Leaving the radar for another tab hides the map, so the preview waits for
    // the rider's return rather than floating over the Home screen.
    if (journey.dest && currentRoute() && currentTab === 'radar') {
      refreshJourney();
      if (routeSheet) routeSheet.hidden = false;
      document.body.classList.add('has-sheet');
      $('#destInput').value = journey.dest.name;
      const clear = $('#destClear');
      if (clear) clear.hidden = false;
      const coords = currentRoute().meta?.coords;
      if (coords) mapCtl.fitRoute(coords, { paddingBottom: 270, bearing: 0, pitch: 0 });
      syncSheetHeight();
    } else {
      if (routeSheet) routeSheet.hidden = true;
      document.body.classList.remove('has-sheet');
      syncSheetHeight();
    }
    updateGroupUi();
  });
  bus.on('nav:arrived', () => {
    // nav:end has already rebuilt the Directions preview and framed the whole
    // route. Do not pull the camera back to the arrival point on top of that —
    // two competing camera moves in half a second look like a glitch.
    updateGroupUi();
  });

  bus.on('map:ready', () => {
    if (state.lastPos) mapCtl.setMe(state.lastPos);
    syncPeersToMap();
    if (hasRoute()) mapCtl.drawRoute({
      coords: currentRoute().coords,
      alts: journey.routes.filter((_, i) => i !== journey.selected).map((r, i) => ({ id: i, coords: r.coords })),
      mode: journey.mode,
    });
  });

}

/* ------------------------------------------------------------------ network */

function wireNetwork() {
  const update = () => {
    renderSync();
    if (!navigator.onLine) toast('You are offline. Saved data still works; maps need a connection.', { type: 'warn', icon: 'offline', ms: 4200 });
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  window.addEventListener('pagehide', () => {
    saveNow();
    stopGeolocation();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      // Background GPS is unreliable in mobile browsers and needlessly warms
      // the device. Resume the selected profile when the rider returns.
      stopGeolocation();
      return;
    }
    syncGeolocationTracking();
    if (ride.active && geo.pos && Date.now() - geo.pos.ts < 30000) {
      import('./rooms.js').then((m) => m.publishNow());
    }
  });
  window.addEventListener('pageshow', syncGeolocationTracking);
}

/* ------------------------------------------------------------------ start */

document.addEventListener('DOMContentLoaded', boot);
