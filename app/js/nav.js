// Turn-by-turn. Owns the active route, the banner, the bottom bar and the
// camera-follow loop. Everything is driven by the single GPS watcher in geo.js.
import { bus } from './bus.js';
import { geo, distanceM } from './geo.js';
import * as mapCtl from './map.js';
import {
  buildRouteMeta, nearestOnRoute, directions, formatDistance,
} from './routing.js';
import { toast, haptic } from './ui.js';

export const nav = {
  active: false,
  meta: null,
  route: null,
  mode: 'bike',
  voiceOn: true,
  startedAt: null,
  startOdo: 0,
  traveled: 0,
  avgSpeed: 0,
  _speedSamples: [],
  _lastIdx: 0,
  _offRouteSince: 0,
  _lastReroute: 0,
  _announced: new Set(),
  _lastUi: 0,
  _wakeLock: null,
  _to: null,
  _via: [],
  _label: '',
  _arriveAt: 0,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ voice */

export function setVoice(on) {
  nav.voiceOn = Boolean(on);
  const btn = $('navVoiceBtn');
  if (btn) {
    btn.textContent = nav.voiceOn ? '🔊' : '🔇';
    btn.setAttribute('aria-label', nav.voiceOn ? 'Mute voice guidance' : 'Unmute voice guidance');
  }
  if (!nav.voiceOn) stopSpeaking();
  return nav.voiceOn;
}

function speak(text) {
  if (!nav.voiceOn || !text || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    u.rate = 1.06;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch { /* voice is a nicety, never a failure */ }
}

function stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
}

/* ------------------------------------------------------------------ wake lock */

async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    nav._wakeLock = await navigator.wakeLock.request('screen');
    nav._wakeLock.addEventListener('release', () => { nav._wakeLock = null; });
  } catch { /* denied or unsupported */ }
}

function releaseWakeLock() {
  try { nav._wakeLock?.release(); } catch { /* noop */ }
  nav._wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && nav.active) acquireWakeLock();
});

/* ------------------------------------------------------------------ start / stop */

export function startNavigation(route, { to, via = [], label = '' } = {}) {
  if (!route?.coords?.length) return false;

  nav.route = route;
  nav.meta = buildRouteMeta(route);
  nav.mode = route.mode || 'bike';
  nav.active = true;
  nav.startedAt = Date.now();
  nav.traveled = 0;
  nav.avgSpeed = 0;
  nav._speedSamples = [];
  nav._lastIdx = 0;
  nav._offRouteSince = 0;
  nav._lastReroute = 0;
  nav._announced = new Set();
  nav._to = to || null;
  nav._via = via;
  nav._label = label;
  nav._arriveAt = 0;
  nav._lastUi = 0;
  nav._lastSpeakAt = 0;

  document.body.classList.add('navigating');
  document.body.classList.remove('has-sheet');
  $('navBanner').hidden = false;
  $('navBottom').hidden = false;
  $('routeSheet').hidden = true;
  $('groupBar').hidden = true;

  mapCtl.setNavigating(true);
  mapCtl.setFollow(true);
  mapCtl.drawRoute({
    coords: nav.meta.coords,
    alts: [],
    mode: nav.mode,
  });

  if (geo.pos) update(geo.pos);
  else toast('Waiting for a GPS fix…', { type: 'warn' });

  acquireWakeLock();
  setVoice(nav.voiceOn);
  speak('Starting navigation');
  haptic([12, 40, 12]);
  bus.emit('nav:start', nav.route);
  return true;
}

export function stopNavigation({ silent = false, reason = '' } = {}) {
  if (!nav.active) return;
  const elapsed = nav.startedAt ? (Date.now() - nav.startedAt) / 1000 : 0;
  const km = nav.traveled / 1000;

  nav.active = false;
  document.body.classList.remove('navigating');
  $('navBanner').hidden = true;
  $('navBottom').hidden = true;
  mapCtl.setNavigating(false);
  releaseWakeLock();
  stopSpeaking();

  if (!silent) {
    speak('Navigation ended');
    if (km > 0.2) {
      toast(`Ride ended · ${km.toFixed(1)} km · ${Math.round(elapsed / 60)} min`, {
        icon: '🏁',
        ms: 5000,
      });
    } else if (reason) {
      toast(reason);
    } else {
      toast('Navigation ended', { icon: '🏁' });
    }
  }

  nav.meta = null;
  nav.route = null;
  bus.emit('nav:end', { km, seconds: elapsed });
}

/* ------------------------------------------------------------------ follow the fix */

bus.on('geo:fix', (pos) => {
  if (!nav.active || !nav.meta) return;
  update(pos);
});

function update(pos) {
  const meta = nav.meta;
  const near = nearestOnRoute(pos, meta, nav._lastIdx, 80);
  if (!near) return;

  // GPS jitter at standstill can push the index backwards; ignore it.
  if (near.along >= nav.traveled - 40) {
    nav._lastIdx = near.idx;
    nav.traveled = near.along;
  }

  const remaining = near.remaining;

  // Average moving speed over ~40 s, ignoring red lights and GPS noise.
  const speed = pos.speed || 0;
  if (speed > 0.8) {
    nav._speedSamples.push(speed);
    if (nav._speedSamples.length > 20) nav._speedSamples.shift();
    nav.avgSpeed = nav._speedSamples.reduce((a, b) => a + b, 0) / nav._speedSamples.length;
  }
  const cruise = nav.avgSpeed > 2
    ? nav.avgSpeed
    : nav.mode === 'walk' ? 1.35 : 7.5;

  const etaSec = remaining / cruise;
  updateUi(near, etaSec, pos);
  announce(near);
  if (checkArrival(remaining, pos)) return;
  checkOffRoute(near, pos);

  if (mapCtl.isFollowing()) {
    mapCtl.cameraFollow(pos, { heading: pos.heading, speed: speed * 3.6, mode: nav.mode });
  }
  mapCtl.setRouteProgress(near.progress);
  mapCtl.setMe(pos);
}

function updateUi(near, etaSec, pos) {
  const now = Date.now();
  if (now - nav._lastUi < 350 && nav._lastUi !== 0) return;
  nav._lastUi = now;

  const steps = nav.meta.steps;
  let idx = steps.findIndex((s) => s.beginDist > near.along + 4);
  if (idx < 0) idx = steps.length - 1;
  const step = steps[idx];
  const next = steps[idx + 1];
  if (!step) return;

  const distToTurn = Math.max(0, step.beginDist - near.along);
  const isFinal = step.maneuver?.type === 'arrive' || idx === steps.length - 1;

  $('navIcon').textContent = isFinal ? '🏁' : step.icon;
  $('navPrimary').textContent = step.instruction;
  $('navSub').textContent = isFinal
    ? 'You have arrived'
    : next ? `Then ${next.instruction.toLowerCase()}` : (step.name || '');
  $('navDist').textContent = isFinal ? '' : formatDistance(distToTurn);

  const mins = Math.max(0, Math.round(etaSec / 60));
  $('navEta').textContent = mins < 60
    ? `${mins} min`
    : new Date(Date.now() + etaSec * 1000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const arrival = new Date(Date.now() + etaSec * 1000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  $('navMeta').textContent = `${formatDistance(near.remaining)} · ${arrival}`;
  $('navProgressBar').style.width = `${Math.round(near.progress * 100)}%`;

  // Safety: if the phone is moving fast, keep the banner readable and don't flash.
  void pos;
}

function announce(near) {
  const steps = nav.meta.steps;
  let idx = steps.findIndex((s) => s.beginDist > near.along + 4);
  if (idx < 0) idx = steps.length - 1;
  const step = steps[idx];
  if (!step) return;
  const dist = step.beginDist - near.along;

  // One prompt per distance band, never repeated for the same manoeuvre.
  let band = null;
  if (dist <= 45) band = 'now';
  else if (dist <= 140) band = '150m';
  else if (dist <= 400) band = '400m';
  if (!band) return;

  const key = `${idx}:${band}`;
  if (nav._announced.has(key)) return;
  nav._announced.add(key);

  // Do not stack prompts back to back on a fast road.
  if (Date.now() - (nav._lastSpeakAt || 0) < 5000) return;
  nav._lastSpeakAt = Date.now();

  const lead = band === '400m' ? 'In 400 metres' : band === '150m' ? 'In 150 metres' : 'Now';
  speak(`${lead}, ${step.instruction}`);
}

function checkArrival(remaining, pos) {
  const nearEnd = nav._to ? distanceM(pos, nav._to) < 35 : false;
  if ((remaining < 28 || (nearEnd && remaining < 90)) && !nav._arriveAt) {
    nav._arriveAt = Date.now();
    haptic([30, 60, 30]);
    const label = nav._label;
    speak('You have arrived');
    stopNavigation({ silent: true });
    toast('You have arrived', { icon: '🏁', ms: 4200 });
    bus.emit('nav:arrived', { label });
    return true;
  }
  return false;
}

async function checkOffRoute(near, pos) {
  const now = Date.now();
  const moving = (pos.speed || 0) > 2.5;
  if (near.dist > 55 && moving) {
    if (!nav._offRouteSince) nav._offRouteSince = now;
    if (now - nav._offRouteSince > 7000 && now - nav._lastReroute > 20000) {
      nav._lastReroute = now;
      nav._offRouteSince = 0;
      await reroute();
    }
  } else if (near.dist < 40) {
    nav._offRouteSince = 0;
  }
}

/* ------------------------------------------------------------------ reroute */

export async function reroute({ silent = false } = {}) {
  if (!nav.active || !nav._to) return;
  if (!silent) toast('Off route — finding a new way', { type: 'warn', icon: '↻' });
  try {
    const { routes } = await directions({
      from: geo.pos,
      to: nav._to,
      via: nav._via,
      mode: nav.mode,
    });
    const best = routes[0];
    nav.route = best;
    nav.meta = buildRouteMeta(best);
    nav._lastIdx = 0;
    nav._announced = new Set();
    nav.traveled = 0;
    mapCtl.drawRoute({ coords: nav.meta.coords, alts: [], mode: nav.mode });
    if (!silent) toast('Route updated');
  } catch {
    if (!silent) toast('Could not recalculate — check your connection', { type: 'err' });
  }
}

/** Rebuild the route after the rider adds or reorders stops mid-ride. */
export async function rebuildRoute({ from, to, via, label }) {
  try {
    const { routes } = await directions({ from: from || geo.pos, to, via, mode: nav.mode });
    const best = routes[0];
    nav._to = to;
    nav._via = via;
    nav._label = label || nav._label;
    nav.route = best;
    nav.meta = buildRouteMeta(best);
    nav._lastIdx = 0;
    nav._announced = new Set();
    nav.traveled = 0;
    mapCtl.drawRoute({ coords: nav.meta.coords, alts: [], mode: nav.mode });
    return best;
  } catch (err) {
    toast('Could not rebuild the route', { type: 'err' });
    throw err;
  }
}

/* ------------------------------------------------------------------ extras */

export function navigationSnapshot() {
  if (!nav.active || !nav.meta) return null;
  return {
    active: true,
    remaining: Math.max(0, nav.meta.total - nav.traveled),
    total: nav.meta.total,
    progress: nav.meta.total ? nav.traveled / nav.meta.total : 0,
    startedAt: nav.startedAt,
    mode: nav.mode,
  };
}

export function toggleVoice() {
  return setVoice(!nav.voiceOn);
}
