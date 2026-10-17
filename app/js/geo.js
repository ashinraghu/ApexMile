// Location. One watcher for the whole app, so we never run two GPS loops
// (which is how phones get hot and batteries die).
import { bus } from './bus.js';
import { state, save } from './store.js';

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function distanceM(a, b) {
  if (!a || !b) return Infinity;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

export function bearingDeg(a, b) {
  if (!a || !b) return 0;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat))
    - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const ALT_SAMPLES = 7;

export const geo = {
  pos: null,
  status: 'idle', // idle | prompting | watching | denied | error | unsupported
  error: null,
  _watchId: null,
  _altBuf: [],
  _lastFixAt: 0,
  _lastSaveAt: 0,
};

function smoothAltitude(meters) {
  if (!Number.isFinite(meters)) return;
  geo._altBuf.push(meters);
  if (geo._altBuf.length > ALT_SAMPLES) geo._altBuf.shift();
  const sorted = [...geo._altBuf].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  state.altitude = Math.round(median);
}

function handlePosition(p) {
  const now = Date.now();
  const c = p.coords;
  const prev = geo.pos;
  const next = {
    lat: c.latitude,
    lng: c.longitude,
    acc: Math.max(1, c.accuracy || 10),
    alt: Number.isFinite(c.altitude) ? c.altitude : null,
    speed: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null, // m/s
    heading: Number.isFinite(c.heading) && c.heading >= 0 ? c.heading : null,
    ts: now,
  };

  if (next.speed == null && prev) {
    const dt = (now - prev.ts) / 1000;
    const d = distanceM(prev, next);
    if (dt > 0.4 && d > 2) next.speed = d / dt;
    else next.speed = 0;
  }
  if (next.heading == null) {
    if (prev && distanceM(prev, next) > 4) next.heading = bearingDeg(prev, next);
    else next.heading = prev?.heading ?? 0;
  }

  // Reject teleports: a fix that jumps >400 m in under a second is noise.
  if (prev && now - prev.ts < 1200 && distanceM(prev, next) > 400) return;

  next.speed = Math.min(next.speed ?? 0, 70); // 250 km/h cap, for sanity
  geo.pos = next;
  geo.status = 'watching';
  geo.error = null;
  geo._lastFixAt = now;

  smoothAltitude(next.alt);
  state.lastPos = { lat: next.lat, lng: next.lng, acc: next.acc, ts: now };
  // Persist the last fix at most every 20 s; one localStorage write per GPS
  // tick is wasteful and hurts battery.
  if (!geo._lastSaveAt || now - geo._lastSaveAt > 20000) {
    geo._lastSaveAt = now;
    save();
  }

  bus.emit('geo:fix', next);
}

function handleError(err) {
  const code = err?.code;
  geo.error = err;
  geo.status = code === 1 ? 'denied' : 'error';
  bus.emit('geo:error', {
    code,
    message: code === 1
      ? 'Location permission is off. Enable it for ApexMile in your browser settings to use the radar and mileage-by-distance.'
      : code === 2
        ? 'No GPS fix yet. Move into the open and try again.'
        : 'Location timed out. Check that Location Services are on for your browser.',
  });
}

export function startGeolocation() {
  if (!('geolocation' in navigator)) {
    geo.status = 'unsupported';
    bus.emit('geo:error', { code: -1, message: 'This browser does not expose location.' });
    return false;
  }
  if (geo._watchId != null) return true;

  geo.status = geo.pos ? 'watching' : 'prompting';
  bus.emit('geo:status', geo.status);

  geo._watchId = navigator.geolocation.watchPosition(handlePosition, handleError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 25000,
  });
  return true;
}

export function stopGeolocation() {
  if (geo._watchId != null) {
    navigator.geolocation.clearWatch(geo._watchId);
    geo._watchId = null;
    geo.status = 'idle';
  }
}

/** One-shot high-accuracy fix (used by the recalibrate button). */
export function freshFix({ timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      (p) => { handlePosition(p); resolve(geo.pos); },
      (e) => { handleError(e); reject(e); },
      { enableHighAccuracy: true, maximumAge: 0, timeout },
    );
  });
}

export async function permissionState() {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    return status?.state || 'unknown';
  } catch { return 'unknown'; }
}

export function speedKmph() {
  return Math.round((geo.pos?.speed || 0) * 3.6);
}

/** Human label for the header. */
export function locationLabel() {
  return state.region?.city || 'Locating…';
}
