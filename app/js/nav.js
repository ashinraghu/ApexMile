// Turn-by-turn. Owns the active route, the banner, the bottom bar and the
// camera-follow loop. Everything is driven by the single GPS watcher in geo.js.
import { bus } from './bus.js';
import { geo, distanceM, bearingDeg, setTrackingProfile } from './geo.js';
import * as mapCtl from './map.js';
import {
  buildRouteMeta, nearestOnRoute, directions, formatDistance,
} from './routing.js';
import { toast, haptic } from './ui.js';
import { voiceSvg } from './navicons.js';

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
  _exitHeading: null,
  _arrowApplied: null,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ voice */

export function setVoice(on) {
  nav.voiceOn = Boolean(on);
  const btn = $('navVoiceBtn');
  if (btn) {
    // A drawn speaker, not an emoji: Android's emoji font coloured the old one
    // and it did not match the rest of the navigation bar.
    btn.innerHTML = voiceSvg(nav.voiceOn);
    btn.setAttribute('aria-label', nav.voiceOn ? 'Mute voice guidance' : 'Unmute voice guidance');
    btn.setAttribute('aria-pressed', nav.voiceOn ? 'true' : 'false');
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

/* ------------------------------------------------------------------ immersive */

let immersiveRequested = false;

function scheduleResize(force = false) {
  mapCtl.resize();
  setTimeout(() => { if (nav.active || force) mapCtl.resize(); }, 220);
  setTimeout(() => { if (nav.active || force) mapCtl.resize(); }, 700);
}

/**
 * Ask the browser for true fullscreen. Installed PWAs and iOS Safari may say
 * no (iPhone has no element fullscreen at all) — that is fine, because the
 * `.navigating` stylesheet already takes over the whole viewport.
 */
export function enterImmersive() {
  scheduleResize();
  if (document.fullscreenElement || document.webkitFullscreenElement) return;
  const el = document.documentElement;
  const standard = Boolean(el.requestFullscreen);
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request) return;
  try {
    // WebKit's prefixed call takes no options; passing one throws there.
    const result = standard ? request.call(el, { navigationUI: 'hide' }) : request.call(el);
    if (result && typeof result.then === 'function') {
      result.then(() => { immersiveRequested = true; scheduleResize(); }).catch(() => {});
    } else {
      immersiveRequested = true;
    }
  } catch { /* not allowed — the CSS layout still fills the screen */ }
}

export function exitImmersive() {
  if (!immersiveRequested) return;
  immersiveRequested = false;
  try {
    if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
  } catch { /* noop */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { if (nav.active) scheduleResize(); });
  window.addEventListener('orientationchange', () => {
    if (nav.active) setTimeout(scheduleResize, 260);
  });
  document.addEventListener('fullscreenchange', () => { if (nav.active) scheduleResize(); });
  document.addEventListener('webkitfullscreenchange', () => { if (nav.active) scheduleResize(); });
}

/* ------------------------------------------------------------------ geometry */

/** Point `distance` metres along the route, interpolated between vertices. */
function coordAtDistance(meta, distance) {
  const { coords, cum } = meta;
  if (!coords?.length) return null;
  if (coords.length === 1) return { lat: coords[0][1], lng: coords[0][0] };
  const d = Math.max(0, Math.min(meta.total, distance));
  let lo = 1;
  let hi = coords.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const a = coords[i - 1];
  const b = coords[i];
  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? Math.max(0, Math.min(1, (d - cum[i - 1]) / span)) : 0;
  return { lat: a[1] + (b[1] - a[1]) * t, lng: a[0] + (b[0] - a[0]) * t };
}

/** Compass heading of the road itself, not of the phone. */
function routeHeadingAt(meta, along) {
  if (!meta) return null;
  const a = coordAtDistance(meta, along);
  const b = coordAtDistance(meta, along + 30);
  if (!a || !b) return null;
  if (Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9) return null;
  return bearingDeg(a, b);
}

/** Shortest signed difference between two compass bearings, in degrees. */
function headingDelta(target, current) {
  return ((target - current + 540) % 360) - 180;
}

/* ------------------------------------------------------------------ start / stop */

export function startNavigation(route, { to, via = [], label = '' } = {}) {
  if (!route?.coords?.length) return false;

  nav.route = route;
  nav.meta = buildRouteMeta(route);
  nav.mode = route.mode || 'bike';
  nav.active = true;
  setTrackingProfile('navigation');
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
  nav._exitHeading = null;
  nav._arrowApplied = null;
  nav._lastUi = 0;
  nav._lastSpeakAt = 0;

  document.body.classList.add('navigating');
  document.body.classList.remove('has-sheet');
  document.documentElement.classList.add('navigating');
  enterImmersive();
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

  if (geo.pos) {
    // Point the map down the road immediately, even while standing still.
    const heading = routeHeadingAt(nav.meta, 0) ?? geo.pos.heading;
    mapCtl.cameraFollow(geo.pos, {
      heading,
      speed: (geo.pos.speed || 0) * 3.6,
      mode: nav.mode,
      forceBearing: true,
    });
    update(geo.pos);
  } else {
    toast('Waiting for a GPS fix…', { type: 'warn' });
  }

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
  setTrackingProfile('passive');
  document.body.classList.remove('navigating');
  document.documentElement.classList.remove('navigating');
  exitImmersive();
  // The layout changes back to the tabbed shell, and leaving fullscreen changes
  // the viewport again a moment later: resize both now and after the dust.
  scheduleResize(true);
  $('navBanner').hidden = true;
  $('navBottom').hidden = true;
  mapCtl.setNavigating(false);
  releaseWakeLock();
  stopSpeaking();

  if (!silent) {
    speak('Navigation ended');
    if (km > 0.2) {
      toast(`Ride ended · ${km.toFixed(1)} km · ${Math.round(elapsed / 60)} min`, {
        icon: 'flag',
        ms: 5000,
      });
    } else if (reason) {
      toast(reason);
    } else {
      toast('Navigation ended', { icon: 'flag' });
    }
  }

  nav._exitHeading = null;
  nav._arrowApplied = null;
  const icon = $('navIcon');
  if (icon) icon.style.transform = 'rotate(0deg)';
  nav.meta = null;
  nav.route = null;
  bus.emit('nav:end', { km, seconds: elapsed });
}

/* ------------------------------------------------------------------ follow the fix */

bus.on('geo:fix', (pos) => {
  if (!nav.active || !nav.meta) return;
  update(pos);
});

bus.on('map:rotate', () => {
  if (nav.active) applyArrow();
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

  const roadHeading = routeHeadingAt(meta, near.along);
  const facing = roadHeading ?? pos.heading;
  if (mapCtl.isFollowing()) {
    mapCtl.cameraFollow(pos, {
      heading: facing,
      speed: speed * 3.6,
      mode: nav.mode,
      forceBearing: true,
    });
  }
  mapCtl.setRouteProgress(near.progress);
  mapCtl.setMe({ ...pos, heading: facing });
}

function upcomingStep(near) {
  const steps = nav.meta.steps;
  let idx = steps.findIndex((s) => s.beginDist > near.along + 4);
  if (idx < 0) idx = steps.length - 1;
  return { step: steps[idx], idx, next: steps[idx + 1] || null };
}

function updateUi(near, etaSec, pos) {
  const now = Date.now();
  if (now - nav._lastUi < 350 && nav._lastUi !== 0) return;
  nav._lastUi = now;

  const steps = nav.meta.steps;
  const { step, idx, next } = upcomingStep(near);
  if (!step) return;

  const lastStep = idx >= steps.length - 1 || step.maneuver?.type === 'arrive';
  const arrived = lastStep && near.remaining < 35;
  const distToTurn = lastStep ? near.remaining : Math.max(0, step.beginDist - near.along);
  const label = nav._label || 'destination';

  updateNavArrow(step, lastStep, arrived, near);

  if (arrived) {
    $('navPrimary').textContent = 'You have arrived';
    $('navSub').textContent = label;
    $('navDist').textContent = '';
  } else if (lastStep) {
    // Route engines label the final leg "You have arrived" from the moment it
    // begins. Saying that three kilometres early is exactly the kind of
    // contradiction that makes guidance feel wrong, so reword it.
    $('navPrimary').textContent = `Continue to ${label}`;
    $('navSub').textContent = step.name ? `via ${step.name}` : 'Follow the road ahead';
    $('navDist').textContent = formatDistance(near.remaining);
  } else {
    $('navPrimary').textContent = step.instruction;
    const nextIsFinal = !next || next.maneuver?.type === 'arrive';
    // Lower-case only the leading verb so street names keep their capitals
    // ("Then turn right onto East Road", not "…east road").
    const thenText = next ? next.instruction.replace(/^(\w)/, (c) => c.toLowerCase()) : '';
    $('navSub').textContent = next
      ? (nextIsFinal ? `Then arrive at ${label}` : `Then ${thenText}`)
      : (step.name || '');
    $('navDist').textContent = formatDistance(distToTurn);
  }

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

/**
 * The manoeuvre arrow points at the direction the rider must take.
 *
 * The map rotates so the rider's direction is always up the screen, which is
 * exactly why a fixed "left turn" glyph creates confusion: on a road that is
 * itself turning, the glyph and the road disagree. One arrow is drawn, and it
 * is rotated by (exit road heading − current map bearing). Up the screen reads
 * 0°, a left turn sits near −90°, and the number only changes when the route
 * or the camera does.
 *
 * On the last leg there is no turn left to take, so the arrow follows the road
 * itself: it keeps pointing at the destination rather than freezing on a
 * manoeuvre that no longer exists.
 */
function updateNavArrow(step, lastStep, arrived, near) {
  const icon = $('navIcon');
  if (!icon) return;

  if (arrived) {
    nav._exitHeading = null;
    icon.classList.add('arriving');
    applyArrow();
    return;
  }
  icon.classList.remove('arriving');

  if (lastStep) {
    const heading = routeHeadingAt(nav.meta, near.along + 15);
    if (heading != null) nav._exitHeading = heading;
    applyArrow();
    return;
  }

  const length = Math.max(1, step.endDist - step.beginDist);
  const look = Math.min(length, Math.max(14, length * 0.55), 80);
  const exitHeading = routeHeadingAt(nav.meta, step.beginDist + look);
  if (exitHeading != null) nav._exitHeading = exitHeading;
  applyArrow();
}

function applyArrow() {
  const icon = $('navIcon');
  if (!icon) return;
  if (nav._exitHeading == null) {
    nav._arrowApplied = null;
    icon.style.transform = 'rotate(0deg)';
    icon.classList.remove('straight');
    return;
  }
  // Canonicalise to [-180, 180) before comparing with the previous angle, so a
  // hair of floating-point noise at ±180 cannot flip the arrow by a full turn.
  let deg = ((headingDelta(nav._exitHeading, mapCtl.currentBearing()) + 540) % 360) - 180;
  if (nav._arrowApplied != null) {
    const diff = deg - nav._arrowApplied;
    // Half a degree of slack: a floating-point ±180 is not a real reversal.
    if (diff > 180.5) deg -= 360;
    else if (diff < -180.5) deg += 360;
  }
  nav._arrowApplied = deg;
  icon.style.transform = `rotate(${deg.toFixed(1)}deg)`;
  icon.classList.toggle('straight', Math.abs(deg) < 12);
}

function announce(near) {
  const steps = nav.meta.steps;
  const { step, idx } = upcomingStep(near);
  if (!step) return;
  // Arrival has its own prompt in checkArrival; speaking it when the last leg
  // merely begins would tell the rider they have arrived kilometres early.
  if (idx >= steps.length - 1 || step.maneuver?.type === 'arrive') return;
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
    toast('You have arrived', { icon: 'flag', ms: 4200 });
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
  if (!silent) toast('Off route — finding a new way', { type: 'warn', icon: 'reroute' });
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
