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
import { geo, startGeolocation, freshFix, distanceM, bearingDeg, speedKmph } from './geo.js';
import * as mapCtl from './map.js';
import {
  journey, plan, setDestination, setOrigin, setMode, clear as clearJourney,
  currentRoute, estimates, hasRoute, addStop,
} from './journey.js';
import {
  localSuggest, remoteSuggest, geocode, reverseDistrict, reversePlace, formatDistance,
} from './routing.js';
import { nav, startNavigation, stopNavigation, toggleVoice } from './nav.js';
import {
  ride, createRide, joinRide, leaveRide, pingPeer, peerList,
  setDestination as setRideDestination, requestNotifications, normalizeCode, publishNow,
  setMyStatus,
} from './rooms.js';
import {
  openTripSheet, openJoinSheet, openInviteSheet, openRiderSheet, openStatusSheet,
  openStopsSheet, openStepsSheet, openProfileSheet,
} from './sheets.js';
import {
  renderHome, renderRefuel, renderInsights, renderGarage, renderAll,
  initRefuel, initGarage,
} from './views.js';
import { FUEL_REGIONS, STATE_DEFAULT_PRICES, PRICES_VERIFIED } from './places.js';

const TABS = ['home', 'refuel', 'radar', 'insights', 'garage', 'privacy', 'safety'];
const TITLES = {
  home: 'ApexMile', refuel: 'Log a fill-up', radar: 'Ride radar',
  insights: 'Insights', garage: 'Garage', privacy: 'Privacy', safety: 'Riding safety',
};

let currentTab = 'home';
let mapInitialised = false;
let lastPeerSig = null;
let mapLayerPinned = false;
let lastGeoErrAt = 0;
let lastRideOfflineToast = 0;
let geoFixStamp = 0;
let suggestionsToken = 0;

/* ================================================================== boot */

function boot() {
  applyTheme(state.theme);
  applyMotion(state.motion);

  initSheets();
  initRefuel();
  initGarage();
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
    startGeolocation();
    detectRegion();
    toast(`Welcome, ${name.split(' ')[0]}`, { icon: '👋' });
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
  const mode = activeVehicle()?.type === 'Car' ? 'car' : 'bike';
  if (journey.mode !== mode) setMode(mode);
}

function enterApp() {
  $('#authScreen').hidden = true;
  $('#joinScreen').hidden = true;
  $('#app').hidden = false;
  $('#avatarInitial').textContent = (state.user.name || 'A').charAt(0).toUpperCase();
  syncTravelMode();
  renderAll();
  renderSync();
  startGeolocation();
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
    startGeolocation();
    renderAll();
    detectRegion();
    go('radar');
    toast('You are live on the radar', { icon: '📡' });
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

function go(tab, { replace = false, fromHistory = false } = {}) {
  if (!TABS.includes(tab)) tab = 'home';
  currentTab = tab;

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
    toast(`Theme: ${next}`, { icon: '🎨', ms: 1600 });
  });

  $('#syncBadge')?.addEventListener('click', () => {
    const label = ride.active
      ? `Room ${ride.code} · ${ride.status} · ${ride.peers.size} other rider${ride.peers.size === 1 ? '' : 's'}`
      : 'Solo. Start a group ride to appear on other riders’ maps.';
    toast(label, { icon: '📡', ms: 4200 });
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
  else { dot.classList.add('off'); label.textContent = 'Offline'; }
}

/* ------------------------------------------------------------------ radar */

function initRadarUi() {
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

  $('#routeBtn')?.addEventListener('click', () => submitDestination());
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
  $('#addStopBtn')?.addEventListener('click', openStopsSheet);
  $('#stopsStrip')?.addEventListener('click', openStopsSheet);
 $('#rsStepsBtn')?.addEventListener('click', openStepsSheet);
  $('#rsClearBtn')?.addEventListener('click', () => { clearJourney(); hideSuggestions(); $('#destInput').value = ''; });
  $('#rsStartBtn')?.addEventListener('click', startPlannedNavigation);

  $('#navExitBtn')?.addEventListener('click', confirmEndNavigation);
  $('#navEtaBtn')?.addEventListener('click', openStepsSheet);
  $('#navGroupBtn')?.addEventListener('click', () => {
    if (ride.active) openInviteSheet();
    else openTripSheet();
  });
  $('#navVoiceBtn')?.addEventListener('click', () => {
    const on = toggleVoice();
    toast(on ? 'Voice on' : 'Voice muted', { icon: on ? '🔊' : '🔇', ms: 1400 });
  });

  $('#gbShare')?.addEventListener('click', openInviteSheet);
  $('#gbMe')?.addEventListener('click', openStatusSheet);

  $$('.pill[data-layer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.pill[data-layer]').forEach((b) => b.classList.toggle('active', b === btn));
      mapLayerPinned = true;
      mapCtl.setStylePreset(btn.dataset.layer);
      haptic(5);
    });
  });

  $('#poiFuel')?.addEventListener('click', () => loadPois('fuel'));
  $('#poiFood')?.addEventListener('click', () => loadPois('food'));
  $('#poiRepair')?.addEventListener('click', () => loadPois('repair'));

  // Tapping empty map dismisses the keyboard and suggestions.
  $('#map')?.addEventListener('click', () => {
    hideSuggestions();
    $('#destInput')?.blur();
  });
}

async function openRadar() {
  if (!mapInitialised) {
    mapInitialised = true;
    const center = geo.pos || state.lastPos || undefined;
    mapCtl.initMap({
      center,
      preset: document.documentElement.dataset.theme === 'dark' ? 'night' : 'streets',
    });
    syncLayerPills();
    $('#fabLocate')?.classList.add('on');
    mapCtl.mapCtl.map?.on('load', () => {
      $('#fabPitch')?.classList.toggle('on', false);
    });
  }
  mapCtl.resize();
  if (!hasRoute() && geo.pos && !nav.active) {
    setTimeout(() => mapCtl.recenter(geo.pos, { zoom: 15.8, duration: 400 }), 260);
  }
}

function syncLayerPills() {
  $$('.pill[data-layer]').forEach((b) => {
    b.classList.toggle('active', b.dataset.layer === (mapCtl.mapState().preset || 'streets'));
  });
}

/** Keep the basemap in step with the app theme, without fighting a manual layer choice. */
function syncMapTheme() {
  if (!mapInitialised || mapLayerPinned) return;
  const preset = mapCtl.mapState().preset;
  if (preset !== 'streets' && preset !== 'night') return;
  const target = document.documentElement.dataset.theme === 'dark' ? 'night' : 'streets';
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
  if (q.length < 2) { hideSuggestions(); return; }

  const local = localSuggest(q, geo.pos, 6);
  renderSuggestions(local, q, false);
  if (!navigator.onLine) return;

  const token = ++suggestionsToken;
  clearTimeout(onDestTyped._timer);
  onDestTyped._timer = setTimeout(async () => {
    try {
      const remote = await remoteSuggest(q, 5);
      if (token !== suggestionsToken) return;
      const merged = [...local];
      for (const r of remote) {
        if (!merged.some((m) => Math.abs(m.lat - r.lat) < 0.002 && Math.abs(m.lng - r.lng) < 0.002)) merged.push(r);
      }
      renderSuggestions(merged.slice(0, 7), q, true);
    } catch { /* suggestions are best-effort */ }
  }, 320);
}

function renderSuggestions(items, query, merged) {
  const box = $('#acList');
  if (!box) return;
  if (!items.length) {
    if (merged) box.innerHTML = `<div class="ac-item"><span class="ac-ico">🔎</span><span class="ac-mid"><span class="ac-t">No match for “${esc(query)}”</span><span class="ac-s">Try a landmark or town name</span></span></div>`;
    box.hidden = !merged;
    return;
  }
  box.innerHTML = '';
  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ac-item';
    btn.innerHTML = `
      <span class="ac-ico">${item.source === 'local' ? '📍' : '🧭'}</span>
      <span class="ac-mid">
        <span class="ac-t">${esc(item.name)}</span>
        <span class="ac-s">${esc(item.sub || '')}</span>
      </span>
      <span class="ac-d">${item.dist != null ? `${(item.dist / 1000).toFixed(1)} km` : ''}</span>`;
    btn.addEventListener('click', () => {
      $('#destInput').value = item.name;
      $('#destClear').hidden = false;
      hideSuggestions();
      $('#destInput').blur();
      setDestination(item);
    });
    box.append(btn);
  });
  box.hidden = false;
}

function hideSuggestions() {
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
  btn.textContent = '🔴';
  toast('Listening…', { icon: '🎙', ms: 1800 });
  rec.onresult = (ev) => {
    const text = ev.results?.[0]?.[0]?.transcript?.trim();
    if (!text) return;
    $('#destInput').value = text;
    submitDestination();
  };
  rec.onerror = () => toast('Did not catch that', { type: 'warn' });
  rec.onend = () => { btn.textContent = '🎙'; };
  try { rec.start(); } catch { btn.textContent = '🎙'; }
}

/* ------------------------------------------------------------------ journey events */

function onJourneyUpdate({ cleared } = {}) {
  const sheet = $('#routeSheet');
  if (cleared || !journey.dest) {
    sheet.hidden = true;
    document.body.classList.remove('has-sheet');
    if (!nav.active) {
      $('#destInput').value = '';
      $('#destClear').hidden = true;
    }
    const originInput = $('#originInput');
    if (originInput) originInput.value = '';
    $('#stopsStrip').hidden = true;
    return;
  }

  if (journey.stops.length) {
    const strip = $('#stopsStrip');
    strip.hidden = false;
    strip.innerHTML = journey.stops
      .map((s, i) => `<span class="stop-chip">${i + 1}. ${esc(s.name)}</span>`)
      .join('');
  } else {
    $('#stopsStrip').hidden = true;
  }

  if (journey.loading) {
    $('#rsEta').textContent = 'Planning…';
    $('#rsDist').textContent = '';
  }

  const route = currentRoute();
  if (!route) {
    if (journey.error) {
      sheet.hidden = false;
      $('#rsEta').textContent = 'No route';
      $('#rsDist').textContent = '';
      $('#rsSub').textContent = journey.error;
      $('#rsNote').textContent = 'Check the start and destination, or try again when you are online.';
      $('#alts').hidden = true;
    }
    return;
  }

  const est = estimates(route);
  sheet.hidden = false;
  document.body.classList.add('has-sheet');

  const mins = Math.max(1, Math.round(route.duration / 60));
  $('#rsEta').textContent = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} hr ${mins % 60} min`;
  $('#rsDist').textContent = `${est.km >= 10 ? est.km.toFixed(1) : est.km.toFixed(2)} km`;
  $('#rsSub').textContent = `${route.summary.split('·').slice(-1)[0].trim()} · ${clockTime(est.arrival)} arrival`;
  $('#rsNote').textContent = `≈ ₹${Math.round(est.fuel)} fuel${journey.mode === 'car' ? ' · tolls not included' : ' · no tolls for bikes'}`;

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
}

async function startPlannedNavigation() {
  if (!journey.dest) return;
  if (journey.loading) return toast('Still planning…', { ms: 1200 });

  const btn = $('#rsStartBtn');
  btn.disabled = true;
  btn.textContent = '…';

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
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start';
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
  // Never block the ride on a permission dialog.
  requestNotifications().catch(() => {});
  toast(`Room ${ride.code} is live`, { icon: '📡', ms: 3000 });

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

/* ------------------------------------------------------------------ POI */

let poiToken = 0;

async function loadPois(category) {
  const pos = geo.pos;
  if (!pos) return toast('Wait for a GPS fix first', { type: 'warn' });
  const token = ++poiToken;
  const filters = {
    fuel: { q: '["amenity"="fuel"]', emoji: '⛽', label: 'Fuel pumps' },
    food: { q: '["amenity"~"restaurant|cafe|fast_food"]', emoji: '🍽', label: 'Food' },
    repair: { q: '["shop"~"car_repair|motorcycle|tyres"]', emoji: '🔧', label: 'Repair' },
  }[category];
  if (!filters) return;

  toast(`Finding ${filters.label.toLowerCase()} within 5 km…`, { icon: '🔎', ms: 2200 });

  const query = `[out:json][timeout:20];nwr${filters.q}(around:5000,${pos.lat.toFixed(5)},${pos.lng.toFixed(5)});out center 24;`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (token !== poiToken) return;
    const nodes = (data.elements || [])
      .map((n) => ({
        ...n,
        lat: Number.isFinite(n.lat) ? n.lat : n.center?.lat,
        lon: Number.isFinite(n.lon) ? n.lon : n.center?.lon,
      }))
      .filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lon));
    if (!nodes.length) return toast(`No ${filters.label.toLowerCase()} found within 5 km`, { type: 'warn' });

    const items = nodes.slice(0, 20).map((n) => ({
      lat: n.lat,
      lng: n.lon,
      emoji: filters.emoji,
      label: n.tags?.name || n.tags?.brand || filters.label.replace(/s$/, ''),
      sub: n.tags?.name ? filters.label : '',
    }));
    mapCtl.setPois(items);
    toast(`${items.length} ${filters.label.toLowerCase()} — tap a pin to route`, { icon: '📍' });
  } catch {
    toast('Place search is busy — try again in a moment', { type: 'warn' });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ region */

let regionBusy = false;

async function detectRegion(force = false) {
  if (regionBusy) return;
  if (state.region.custom && !force) return;
  regionBusy = true;
  try {
    let pos = geo.pos;
    if (!pos) pos = await freshFix({ timeout: 9000 }).catch(() => null);
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
      });
    } else if (place?.state) {
      const statePrices = STATE_DEFAULT_PRICES[place.state.toLowerCase()]?.prices;
      setRegion({
        city: place.city || place.district || 'Your district',
        state: place.state,
        prices: { ...(statePrices || state.region.prices) },
        verified: PRICES_VERIFIED,
        custom: false,
      });
    }
    if (force) toast(`Rates for ${state.region.city}, ${state.region.state}`, { icon: '⛽' });
    renderAll();
  } finally {
    regionBusy = false;
  }
}

/* ------------------------------------------------------------------ profile */

function handleSignOut() {
  state.signedIn = false;
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
    mapCtl.setMe(pos);
    const now = Date.now();
    if (now - geoFixStamp > 1500) {
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
      syncPeersToMap();
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
    toast(message, { type: 'warn', icon: '📍', ms: 5200 });
  });

  bus.on('journey:update', onJourneyUpdate);

  bus.on('journey:add-stop', async ({ place, position }) => {
    await addStop(place, position);
  });

  bus.on('ride:changed', () => {
    updateGroupUi();
    renderSync();
  });

  bus.on('ride:peers', () => {
    syncPeersToMap();
    renderSync();
  });

  bus.on('ride:status', ({ status } = {}) => {
    renderSync();
    if (status === 'offline' && ride.active && Date.now() - lastRideOfflineToast > 20000) {
      lastRideOfflineToast = Date.now();
      toast('Ride sync is offline — position sharing will resume when the connection returns', { type: 'warn', icon: '📡', ms: 4500 });
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
          toast('Location shared', { icon: '📍' });
        });
      },
    });
  });

  bus.on('ride:captain-state', async (pkt) => {
    if (!pkt?.dest) return;
    if (nav.active) {
      toast(`${pkt.captainName || 'Captain'} set a new pack destination — end this route to pick it up`, { icon: '📡', ms: 5000 });
      return;
    }
    toast(`${pkt.captainName || 'Captain'} set the destination: ${pkt.dest.name}`, { icon: '📡', ms: 5000 });
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
    toast('Map service is slow — switched to a lighter basemap', { icon: '🗺', ms: 4200 });
  });

  bus.on('map:longpress', async ({ lat, lng }) => {
    const place = await reversePlace(lat, lng);
    openSheet({
      title: 'Dropped pin',
      html: `
        <div class="field"><span>${esc(place.name)}</span>
          <small>${esc(place.sub || `${lat.toFixed(5)}, ${lng.toFixed(5)}`)}</small></div>
        <div class="sheet-actions">
          <button class="btn ghost" type="button" id="pinStop">Add as stop</button>
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
        body.querySelector('#pinStop').addEventListener('click', async () => {
          closeSheet();
          await addStop(place);
          toast('Stop added');
        });
        body.querySelector('#pinShare')?.addEventListener('click', () => {
          setRideDestination(place, false);
          closeSheet();
          toast('Pack destination updated', { icon: '📡' });
        });
      },
    });
  });

  bus.on('map:focus-peer', ({ lat, lng }) => {
    if (!lat || !lng) return;
    mapCtl.recenter({ lat, lng }, { zoom: 16, duration: 600 });
  });

  bus.on('poi:pick', async (item) => {
    const place = { name: item.label || 'Selected place', lat: item.lat, lng: item.lng };
    $('#destInput').value = place.name;
    $('#destClear').hidden = false;
    await setDestination(place);
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
    $('#fabLocate')?.classList.add('on');
    mapCtl.resize();
  });
  bus.on('nav:end', () => {
    const route = document.querySelector('.route-sheet');
    if (route) route.hidden = true;
    document.body.classList.remove('has-sheet');
    clearJourney({ keepView: true });
    updateGroupUi();
  });
  bus.on('nav:arrived', () => {
    clearJourney({ keepView: true });
    setTimeout(() => { if (geo.pos) mapCtl.recenter(geo.pos, { zoom: 16.2 }); }, 300);
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

  navStateBinding();
}

function navStateBinding() {
  const map = () => mapCtl.mapCtl;
  // Keep the FAB state honest when the map pans itself during nav.
  setInterval(() => {
    if (!map().ready) return;
    if (!nav.active) return;
    $('#fabLocate')?.classList.toggle('on', mapCtl.isFollowing());
  }, 1200);
}

/* ------------------------------------------------------------------ network */

function wireNetwork() {
  const update = () => {
    renderSync();
    if (!navigator.onLine) toast('You are offline. Saved data still works; maps need a connection.', { type: 'warn', icon: '📴', ms: 4200 });
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ride.active) {
      import('./rooms.js').then((m) => m.publishNow());
    }
  });
}

/* ------------------------------------------------------------------ start */

document.addEventListener('DOMContentLoaded', boot);
