// Search, geocoding and routing.
//  • Instant local index first (no network, no rate limit)
//  • Nominatim only after typing stops, one request at a time (usage policy)
//  • OSRM for geometry + turn-by-turn steps
import { PLACES } from './places.js';
import { distanceM, geo } from './geo.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org';

/* ------------------------------------------------------------------ search */

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

function scorePlace(place, q) {
  const name = norm(place.name);
  const sub = norm(place.sub);
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (sub.includes(q)) return 4;
  return 99;
}

export function localSuggest(query, origin = geo.pos, limit = 6) {
  const q = norm(query).trim();
  const ref = origin || { lat: 12.97, lng: 77.59 };
  const scored = [];
  for (const place of PLACES) {
    const s = q ? scorePlace(place, q) : 5;
    if (s >= 99) continue;
    scored.push({ ...place, score: s, dist: distanceM(ref, place) });
  }
  scored.sort((a, b) => a.score - b.score || a.dist - b.dist);
  return scored.slice(0, limit).map((p) => ({
    name: p.name,
    sub: p.sub,
    lat: p.lat,
    lng: p.lng,
    dist: p.dist,
    source: 'local',
  }));
}

// Nominatim asks for at most one call per second. Keep a tiny queue so a fast
// typist cannot get us blocked.
let lastRemoteAt = 0;
let remoteTimer = null;
let remoteController = null;

function throttleRemote(fn) {
  return new Promise((resolve, reject) => {
    const wait = Math.max(0, 1100 - (Date.now() - lastRemoteAt));
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(async () => {
      lastRemoteAt = Date.now();
      try { resolve(await fn()); } catch (e) { reject(e); }
    }, wait);
  });
}

export async function remoteSuggest(query, limit = 6) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  remoteController?.abort();
  const controller = new AbortController();
  remoteController = controller;

  return throttleRemote(async () => {
    const url = `${NOMINATIM}/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=${limit}&countrycodes=in&addressdetails=0&accept-language=en`;
    const timer = setTimeout(() => controller.abort(), 12000);
    let rows;
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      rows = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const ref = geo.pos || { lat: 12.97, lng: 77.59 };
    return rows.map((r) => {
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      const parts = String(r.display_name || '').split(',');
      return {
        name: (r.name || parts[0] || q).trim(),
        sub: parts.slice(1, 3).join(',').trim() || 'India',
        lat,
        lng,
        dist: distanceM(ref, { lat, lng }),
        source: 'remote',
      };
    }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  });
}

export async function geocode(text) {
  const q = String(text || '').trim();
  if (!q) return null;
  const local = localSuggest(q, geo.pos, 1)[0];
  if (local && norm(local.name) === norm(q)) return local;

  try {
    const remote = await remoteSuggest(q, 1);
    if (remote.length) return remote[0];
  } catch (err) {
    console.warn('[routing] geocode', err);
  }
  return local || null;
}

/** Reverse geocode to a district name. Cached by ~1 km bucket. */
const reverseCache = new Map();

export async function reverseDistrict(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (reverseCache.has(key)) return reverseCache.get(key);
  const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1&accept-language=en`;
  const data = await fetchJson(url, 12000);
  const a = data.address || {};
  const city = a.city || a.town || a.county || a.state_district || a.village || '';
  const district = a.state_district || a.county || city;
  const answer = {
    city: city || district || '',
    district: district || '',
    state: a.state || '',
    country: a.country || 'India',
  };
  reverseCache.set(key, answer);
  return answer;
}

/** Reverse geocode a dropped pin into something a human can read. */
export async function reversePlace(lat, lng) {
  const fallback = { name: 'Dropped pin', sub: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
  try {
    const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=en`;
    const data = await fetchJson(url, 12000);
    const a = data.address || {};
    const name = data.name
      || a.road || a.pedestrian || a.neighbourhood || a.suburb
      || a.village || a.town || a.city || 'Dropped pin';
    const subParts = [a.suburb, a.city || a.town || a.village, a.state].filter(Boolean);
    return {
      name: String(name).slice(0, 80),
      sub: [...new Set(subParts)].join(', ').slice(0, 120),
      lat,
      lng,
    };
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ routing */

async function fetchJson(url, ms = 14000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Service returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{from:{lat,lng}, to:{lat,lng}, via?:Array, mode?:'bike'|'car'|'walk'}} opts
 * @returns {Promise<{routes:Array, mode:string}>}
 */
export async function directions({ from, to, via = [], mode = 'bike' }) {
  if (!from || !to) throw new Error('A start and a destination are needed');

  const points = [from, ...via.filter((p) => p && Number.isFinite(p.lat)), to];
  const coordStr = points.map((p) => `${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)}`).join(';');
  const allowAlternatives = points.length <= 2;
  const profile = mode === 'walk' ? 'foot' : 'driving';

  const buildUrl = (p, alts) => `${OSRM}/route/v1/${p}/${coordStr}`
    + `?alternatives=${alts ? 'true' : 'false'}&overview=full&geometries=geojson&steps=true&annotations=false`;

  let data = null;
  let usedMode = mode;

  try {
    data = await fetchJson(buildUrl(profile, allowAlternatives));
  } catch (err) {
    // The public OSRM demo sometimes has no foot profile. Fall back to driving
    // and stretch the duration to a walking pace rather than failing outright.
    if (profile === 'foot') {
      data = await fetchJson(buildUrl('driving', allowAlternatives));
      usedMode = 'walk';
    } else {
      throw err;
    }
  }

  if (!data || data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data?.message || 'No route found for those points');
  }

  const routes = data.routes.map((r, index) => normalizeRoute(r, index, usedMode));
  if (!routes.length) throw new Error('No route found');
  return { routes, mode: usedMode };
}

function normalizeRoute(raw, index, mode) {
  const coords = raw.geometry.coordinates.map(([lng, lat]) => [lng, lat]);
  const steps = [];
  let begin = 0;
  for (const leg of raw.legs || []) {
    for (const step of leg.steps || []) {
      const distance = Number(step.distance) || 0;
      steps.push({
        instruction: buildInstruction(step),
        icon: buildIcon(step),
        name: step.name || '',
        distance,
        duration: Number(step.duration) || 0,
        beginDist: begin,
        endDist: begin + distance,
        maneuver: step.maneuver || {},
      });
      begin += distance;
    }
  }

  let duration = Number(raw.duration) || 0;
  if (mode === 'walk') {
    // 4.8 km/h, which is what a person with a backpack actually walks.
    duration = (Number(raw.distance) / 1000 / 4.8) * 3600;
  }

  return {
    id: index,
    distance: Number(raw.distance) || 0,
    duration,
    coords,
    steps,
    mode,
    summary: describeRoute(raw, index),
  };
}

function describeRoute(raw, index) {
  const km = (Number(raw.distance) || 0) / 1000;
  const mins = Math.round((Number(raw.duration) || 0) / 60);
  if (index === 0) return `${km >= 100 ? km.toFixed(0) : km.toFixed(1)} km · ${mins} min · fastest`;
  return `${km >= 100 ? km.toFixed(0) : km.toFixed(1)} km · ${mins} min · alternative`;
}

/* ------------------------------------------------------------------ language */

const MODIFIER = {
  left: 'left',
  'slight left': 'slightly left',
  'sharp left': 'sharp left',
  right: 'right',
  'slight right': 'slightly right',
  'sharp right': 'sharp right',
  straight: 'straight',
  uturn: 'around',
  'uturn left': 'around to the left',
  'uturn right': 'around to the right',
};

const modWord = (m) => MODIFIER[m] || 'ahead';

export function buildInstruction(step) {
  const m = step.maneuver || {};
  const road = step.name ? ` onto ${step.name}` : '';
  const onRoad = step.name ? ` on ${step.name}` : '';

  switch (m.type) {
    case 'depart':
      return `Head ${modWord(m.modifier)}${onRoad}`;
    case 'arrive':
      return 'Arrive at your destination';
    case 'turn':
      return `Turn ${modWord(m.modifier)}${road}`;
    case 'new name':
    case 'continue':
      return `Continue${onRoad}`;
    case 'merge':
      return `Merge ${modWord(m.modifier)}${road}`;
    case 'fork':
      return `Keep ${modWord(m.modifier)}${road}`;
    case 'end of road':
      return `Turn ${modWord(m.modifier)} at the end of the road`;
    case 'roundabout':
    case 'rotary':
      return `Take exit ${m.exit || 1} at the roundabout${road}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${road}`;
    case 'on ramp':
      return `Take the ramp ${modWord(m.modifier)}`;
    case 'off ramp':
      return `Take the exit ${modWord(m.modifier)}`;
    case 'notification':
      return step.name ? `Continue on ${step.name}` : 'Continue';
    default:
      return step.name ? `Continue on ${step.name}` : `Continue ${modWord(m.modifier)}`;
  }
}

export function buildIcon(step) {
  const m = step.maneuver || {};
  const mod = m.modifier || '';
  if (m.type === 'arrive') return '🏁';
  if (m.type === 'roundabout' || m.type === 'rotary' || m.type === 'exit roundabout') return '🔄';
  if (m.type === 'on ramp' || m.type === 'off ramp' || m.type === 'merge') return '🛣️';
  if (mod.includes('uturn')) return '↩️';
  if (mod.includes('sharp left')) return '⬅️';
  if (mod.includes('slight left')) return '↖️';
  if (mod.includes('left')) return '⬅️';
  if (mod.includes('sharp right')) return '➡️';
  if (mod.includes('slight right')) return '↗️';
  if (mod.includes('right')) return '➡️';
  if (m.type === 'fork') return '⤴️';
  return '⬆️';
}

export function speakInstruction(step) {
  return step?.instruction || '';
}

/* ------------------------------------------------------------------ geo maths */

const M_PER_DEG_LAT = 111320;

export function buildRouteMeta(route) {
  const coords = route.coords;
  const cum = new Float64Array(coords.length);
  let total = 0;
  const latRef = coords[0]?.[1] || 0;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((latRef * Math.PI) / 180);

  for (let i = 1; i < coords.length; i += 1) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    const dx = (lng2 - lng1) * mPerDegLng;
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    total += Math.hypot(dx, dy);
    cum[i] = total;
  }

  return {
    coords,
    cum,
    total,
    steps: route.steps,
    duration: route.duration,
    mode: route.mode,
    latRef,
    mPerDegLng,
  };
}

/**
 * Project a position onto the route. Searches a window around the last known
 * index so this stays cheap on long routes.
 */
export function nearestOnRoute(pos, meta, hintIdx = null, window = 60) {
  const { coords, cum } = meta;
  if (!coords?.length) return null;
  const from = hintIdx == null ? 0 : Math.max(0, hintIdx - window);
  const to = hintIdx == null ? coords.length - 2 : Math.min(coords.length - 2, hintIdx + window);

  let best = { dist: Infinity, idx: from, t: 0, along: 0 };
  for (let i = from; i <= to; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    if (!a || !b) continue;
    const ax = a[0] * meta.mPerDegLng;
    const ay = a[1] * M_PER_DEG_LAT;
    const bx = b[0] * meta.mPerDegLng;
    const by = b[1] * M_PER_DEG_LAT;
    const px = pos.lng * meta.mPerDegLng;
    const py = pos.lat * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best.dist) {
      best = {
        dist: d,
        idx: i,
        t,
        along: cum[i] + t * (cum[i + 1] - cum[i]),
      };
    }
  }

  return {
    ...best,
    remaining: Math.max(0, meta.total - best.along),
    progress: meta.total > 0 ? best.along / meta.total : 0,
  };
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.max(5, Math.round(meters / 5) * 5)} m`;
  const kmv = meters / 1000;
  return `${kmv >= 10 ? kmv.toFixed(0) : kmv.toFixed(1)} km`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const d = new Date(Date.now() + seconds * 1000);
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}
