// Search, geocoding and routing.
//  • Instant local index first (no network, no rate limit)
//  • Nominatim only after typing stops, one request at a time (usage policy)
//  • TomTom for traffic-aware geometry + ETAs when the rider's key has
//    routing access; Valhalla/OSRM free-flow with clear "standard estimate"
//    labelling when it does not
import { PLACES } from './places.js';
import { distanceM, geo } from './geo.js';
import { maneuverKey } from './navicons.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org';
// Valhalla's public demo instance is the free way to get actual bicycle and
// pedestrian routing (OSRM's demo only runs the car profile). If it is down we
// fall back to OSRM geometry with a realistic speed for the mode.
const VALHALLA = 'https://valhalla1.openstreetmap.de';
// ApexMile's "bike" is a motorcycle, so cost it as one. Costing these routes as
// a push-bike was the reason a bike ETA could read *slower* than a car in the
// city: 15–20 km/h bicycle speeds against free-flow car speeds.
const VALHALLA_COSTING = { car: 'auto', bike: 'motorcycle', walk: 'pedestrian' };

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

/** The routing key situation, shared by the whole app. */
const tomtom = { key: '', status: 'idle' }; // idle | ok | rejected | quota

/**
 * Point routing at the rider's TomTom key (the same key that powers the
 * traffic overlay). A *different* key always gets a fresh chance; the same
 * key keeps its verdict so a rejected key is never re-tried in a loop.
 */
export function setTomTomRoutingKey(key) {
  const k = String(key || '').trim();
  if (k === tomtom.key) return;
  tomtom.key = k;
  tomtom.status = 'idle';
}

/** For labels and tests: is traffic-aware routing available right now? */
export function tomtomRoutingState() {
  return {
    keyed: Boolean(tomtom.key),
    status: tomtom.status,
    usable: tomtom.status === 'ok' || (tomtom.key && tomtom.status === 'idle'),
  };
}

const TOMTOM_ROUTE = 'https://api.tomtom.com/routing/1/calculateRoute';
const TOMTOM_TRAVEL_MODE = { bike: 'motorcycle', car: 'car', walk: 'pedestrian' };

// TomTom manoeuvre codes → the shared vector glyph keys (see navicons.js).
const TT_MANEUVER = {
  ARRIVE: 'arrive', ARRIVE_LEFT: 'arrive', ARRIVE_RIGHT: 'arrive', ARRIVE_AHEAD: 'arrive',
  WAYPOINT_REACHED: 'arrive', WAYPOINT_LEFT: 'arrive', WAYPOINT_RIGHT: 'arrive',
  DEPART: 'straight', STRAIGHT: 'straight', FOLLOW: 'straight', TOLLGATE: 'straight',
  CROSS_BORDER: 'straight', SWITCH_PARALLEL_ROAD: 'straight', SWITCH_MAIN_ROAD: 'straight',
  KEEP_LEFT: 'slight-left', BEAR_LEFT: 'slight-left', SLIGHT_LEFT: 'slight-left',
  ROUNDABOUT_SLIGHT_LEFT: 'slight-left',
  KEEP_RIGHT: 'slight-right', BEAR_RIGHT: 'slight-right', SLIGHT_RIGHT: 'slight-right',
  ROUNDABOUT_SLIGHT_RIGHT: 'slight-right',
  TURN_LEFT: 'left', ROUNDABOUT_LEFT: 'left',
  TURN_RIGHT: 'right', ROUNDABOUT_RIGHT: 'right',
  SHARP_LEFT: 'sharp-left', ROUNDABOUT_SHARP_LEFT: 'sharp-left',
  SHARP_RIGHT: 'sharp-right', ROUNDABOUT_SHARP_RIGHT: 'sharp-right',
  MAKE_UTURN: 'uturn', TRY_MAKE_UTURN: 'uturn', ROUNDABOUT_BACK: 'uturn',
  ROUNDABOUT_CROSS: 'roundabout', ROUNDABOUT_STRAIGHT: 'roundabout', EXIT_ROUNDABOUT: 'roundabout',
  ENTER_MOTORWAY: 'merge', ENTER_FREEWAY: 'merge', ENTER_HIGHWAY: 'merge',
  TAKE_EXIT: 'merge', MOTORWAY_EXIT_LEFT: 'merge', MOTORWAY_EXIT_RIGHT: 'merge',
  ENTRANCE_RAMP: 'merge', MERGE_LEFT_LANE: 'merge', MERGE_RIGHT_LANE: 'merge',
  SWITCH_MOTORWAY_LEFT: 'merge', SWITCH_MOTORWAY_RIGHT: 'merge',
  ENTER_CARPOOL_LANE_LEFT: 'merge', ENTER_CARPOOL_LANE_RIGHT: 'merge',
  EXIT_CARPOOL_LANE_LEFT: 'merge', EXIT_CARPOOL_LANE_RIGHT: 'merge',
  TAKE_FERRY: 'ferry', TAKE_SHIP_FERRY: 'ferry', LEAVE_SHIP_FERRY: 'ferry',
  TAKE_CAR_TRAIN: 'ferry', LEAVE_CAR_TRAIN: 'ferry',
};

/**
 * Traffic-aware routing from TomTom. `travelTimeInSeconds` already includes
 * live traffic when `traffic=true`, and `computeTravelTimeFor=all` adds the
 * no-traffic baseline so the sheet can say what traffic is costing.
 */
async function tomtomRoute(points, mode, key) {
  const coordStr = points
    .map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`)
    .join(':');
  const url = `${TOMTOM_ROUTE}/${coordStr}/json?key=${encodeURIComponent(key)}`
    + `&travelMode=${TOMTOM_TRAVEL_MODE[mode] || 'car'}&traffic=true`
    + '&computeTravelTimeFor=all&routeType=fastest&instructionsType=text&language=en-IN'
    + (points.length <= 2 ? '&maxAlternatives=2' : '');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 14000);
  let res;
  try {
    res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`TomTom routing returned ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  const data = await res.json();
  const routes = (data?.routes || []).map((raw, index) => normalizeTomTomRoute(raw, index, mode));
  if (!routes.length) throw new Error('No route found for those points');
  return routes;
}

function normalizeTomTomRoute(raw, index, mode) {
  const coords = [];
  for (const leg of raw.legs || []) {
    for (const p of leg.points || []) {
      const pair = [Number(p.longitude), Number(p.latitude)];
      const last = coords[coords.length - 1];
      if (!last || Math.abs(last[0] - pair[0]) > 1e-7 || Math.abs(last[1] - pair[1]) > 1e-7) {
        coords.push(pair);
      }
    }
  }
  if (coords.length < 2) throw new Error('Empty route geometry');

  // Guidance offsets are cumulative: turn them into per-step lengths.
  const steps = [];
  let begin = 0;
  let beginTime = 0;
  for (const ins of raw.guidance?.instructions || []) {
    const offset = Math.max(begin, Number(ins.routeOffsetInMeters) || 0);
    const at = Math.max(beginTime, Number(ins.travelTimeInSeconds) || 0);
    steps.push({
      instruction: String(ins.message || 'Continue').replace(/<[^>]+>/g, ''),
      icon: TT_MANEUVER[String(ins.maneuver || '').toUpperCase()] || 'straight',
      name: ins.street || (ins.roadNumbers || [])[0] || '',
      distance: offset - begin,
      duration: at - beginTime,
      beginDist: begin,
      endDist: offset,
      maneuver: { type: ins.instructionType === 'LOCATION_ARRIVAL' ? 'arrive' : 'turn', modifier: '' },
    });
    begin = offset;
    beginTime = at;
  }

  const summary = raw.summary || {};
  const distance = Number(summary.lengthInMeters) || 0;
  const duration = Number(summary.travelTimeInSeconds) || 0;
  const km = distance / 1000;
  const kmLabel = km >= 100 ? km.toFixed(0) : km.toFixed(1);
  const mins = Math.round(duration / 60);

  return {
    id: index,
    distance,
    duration,
    coords,
    steps,
    mode,
    etaSource: 'tomtom',
    trafficDelay: Number(summary.trafficDelayInSeconds) || 0,
    noTrafficDuration: Number(summary.noTrafficTravelTimeInSeconds) || null,
    summary: `${kmLabel} km · ${mins} min · traffic-aware`,
  };
}

/** How an ETA was produced, in the rider's words. */
export function etaBasisLabel(route) {
  if (route?.etaSource === 'tomtom') return 'Traffic-aware ETA · TomTom';
  return 'Standard estimate · no live traffic';
}

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

  // Traffic-aware first, whenever the rider's TomTom key has routing access.
  if (tomtom.key && tomtom.status !== 'rejected' && tomtom.status !== 'quota') {
    try {
      const routes = await tomtomRoute(points, mode, tomtom.key);
      tomtom.status = 'ok';
      return { routes, mode };
    } catch (err) {
      if (err?.httpStatus === 401 || err?.httpStatus === 403) {
        // The key is refused (usually a Traffic-only key without the Routing
        // products). Record the verdict and stop: every later plan or reroute
        // skips TomTom entirely, so a rejected key is never retried in a loop.
        tomtom.status = 'rejected';
        console.warn('[routing] TomTom routing rejected — standard estimates from here on');
      } else if (err?.httpStatus === 429) {
        tomtom.status = 'quota';
        console.warn('[routing] TomTom routing quota used — standard estimates until it resets');
      } else {
        console.warn('[routing] TomTom routing unavailable, using standard estimates', err?.message);
      }
    }
  }

  // Bicycle and pedestrian get a real network from Valhalla. Car keeps OSRM
  // because it returns alternatives, which Valhalla's demo does not.
  if (mode === 'bike' || mode === 'walk') {
    try {
      const route = await valhallaRoute(points, mode);
      return { routes: [route], mode };
    } catch (err) {
      console.warn('[routing] valhalla unavailable, using OSRM', err?.message);
    }
  }

  const buildUrl = (p, alts) => `${OSRM}/route/v1/${p}/${coordStr}`
    + `?alternatives=${alts ? 'true' : 'false'}&overview=full&geometries=geojson&steps=true&annotations=false`;

  const data = await fetchJson(buildUrl('driving', allowAlternatives));
  if (!data || data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data?.message || 'No route found for those points');
  }

  const routes = data.routes.map((r, index) => normalizeRoute(r, index, mode));
  for (const route of routes) {
    route.duration = adjustedDuration(route, mode);
    route.etaSource = 'osrm';
  }
  if (!routes.length) throw new Error('No route found');
  return { routes, mode };
}

/**
 * Car ETAs from OSRM assume free-flowing traffic. Apply a modest urban factor
 * instead of pretending it is live traffic. Bike and walk use a realistic
 * moving average when Valhalla could not answer.
 *
 * The bike numbers are motorcycle numbers, and deliberately sit a little above
 * the congested-car model: in city traffic a bike filters past queues, so a
 * bike ETA should never read worse than the same trip in a car. On the open
 * highway both converge — nobody filters at 90 km/h.
 */
/**
 * The ApexMile mode model. One shared free-flow baseline per route, two honest
 * views of it:
 *
 *   band            car (×free-flow)   bike (×free-flow)   why
 *   city  < 12 km        1.18              0.82   a bike filters past queues a car waits in
 *   intercity 12–45      1.10              0.95   signals/barriers bind cars harder
 *   open road > 45       1.05              0.98   a big bike cruises at least at car pace
 *
 * The bike factors sit below the car factors in every band ON PURPOSE:
 * ApexMile "bike" is a large-capacity motorcycle (100–1000 cc class) — through
 * traffic it filters, on the open road it holds 120+ km/h like any car, so a
 * bike ETA must never read worse than the same trip by car. Valhalla's
 * motorcycle costing (with a 160 km/h top speed, not the scooter-class
 * default) supplies bike-legal geometry and the baseline; the factors model
 * congestion reality on top. These are modeled estimates, not live traffic.
 */
function carFactor(km) {
  return km < 12 ? 1.18 : km < 60 ? 1.1 : 1.05;
}

export function adjustedDuration(route, mode) {
  const km = route.distance / 1000;
  if (mode === 'walk') return (km / 4.8) * 3600;
  if (mode === 'bike') {
    // OSRM's duration is a free-flow *car* estimate over this exact geometry:
    // the honest shared baseline for a like-for-like bike-vs-car comparison.
    return modeledBikeSeconds(route.duration, km);
  }
  return route.duration * carFactor(km);
}

/**
 * Bike seconds from a free-flow baseline. `Math.max` with the plausibility
 * floor stops the urban trim from claiming impossible moving averages —
 * but `Math.min` with the band's own car model guarantees the ordering that
 * matters: on the same baseline a bike never displays slower than a car.
 */
export function modeledBikeSeconds(seconds, km) {
  const trim = km < 12 ? 0.82 : km < 45 ? 0.95 : 0.98;
  const floor = km < 12 ? (km / 40) * 3600 : km < 45 ? (km / 55) * 3600 : 0;
  return Math.min(Math.max(Math.round(seconds * trim), Math.round(floor)), seconds * carFactor(km));
}

/* ------------------------------------------------------------------ Valhalla */

function decodePolyline6(encoded) {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 1e6;
  const out = [];
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    out.push([lng / factor, lat / factor]);
  }
  return out;
}

function shapeCoords(shape) {
  if (!shape) return [];
  if (typeof shape === 'string') return decodePolyline6(shape);
  if (Array.isArray(shape?.coordinates)) return shape.coordinates;
  return [];
}

// Valhalla manoeuvre types → the shared vector glyph keys (see navicons.js).
const VALHALLA_ICONS = {
  1: 'straight', 2: 'slight-right', 3: 'slight-left', 4: 'arrive', 5: 'slight-right', 6: 'slight-left',
  7: 'straight', 8: 'straight', 9: 'slight-right', 10: 'right', 11: 'sharp-right', 12: 'uturn', 13: 'uturn',
  14: 'sharp-left', 15: 'left', 16: 'slight-left', 17: 'merge', 18: 'merge', 19: 'merge',
  20: 'slight-right', 21: 'slight-left', 22: 'straight', 23: 'slight-right', 24: 'slight-left', 25: 'merge',
  26: 'roundabout', 27: 'roundabout', 28: 'ferry', 29: 'ferry', 37: 'merge',
};

async function valhallaRoute(points, mode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let data;
  try {
    const res = await fetch(`${VALHALLA}/route`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        locations: points.map((p) => ({ lat: Number(p.lat), lon: Number(p.lng), type: 'break' })),
        costing: VALHALLA_COSTING[mode],
        // A large-capacity motorcycle, not Valhalla's scooter-class default:
        // its stock ~120 km/h top speed would undersell open-road legs.
        ...(mode === 'bike' ? { costing_options: { motorcycle: { top_speed: 160 } } } : {}),
        units: 'kilometers',
        language: 'en-IN',
        shape_format: 'geojson',
        directions_options: { units: 'kilometers', language: 'en-IN' },
      }),
    });
    if (!res.ok) throw new Error(`Valhalla returned ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const legs = data?.trip?.legs;
  if (!Array.isArray(legs) || !legs.length) throw new Error('No route found');

  const coords = [];
  const steps = [];
  let begin = 0;

  legs.forEach((leg, legIndex) => {
    const legCoords = shapeCoords(leg.shape);
    if (legIndex > 0 && coords.length && legCoords.length) {
      const [lng, lat] = legCoords[0];
      const [plng, plat] = coords[coords.length - 1];
      if (Math.abs(lng - plng) < 1e-7 && Math.abs(lat - plat) < 1e-7) legCoords.shift();
    }
    coords.push(...legCoords);

    const maneuvers = Array.isArray(leg.maneuvers) ? leg.maneuvers : [];
    maneuvers.forEach((maneuver, i) => {
      const distance = Math.max(0, Number(maneuver.length) || 0) * 1000;
      const isLast = i === maneuvers.length - 1;
      steps.push({
        instruction: String(maneuver.instruction || (isLast ? 'You have arrived' : 'Continue')).replace(/<[^>]+>/g, ''),
        icon: isLast ? 'arrive' : (VALHALLA_ICONS[Number(maneuver.type)] || 'straight'),
        name: (maneuver.street_names || [])[0] || '',
        distance,
        duration: Number(maneuver.time) || 0,
        beginDist: begin,
        endDist: begin + distance,
        maneuver: { type: isLast ? 'arrive' : 'turn', modifier: '' },
      });
      begin += distance;
    });
  });

  if (coords.length < 2) throw new Error('Empty route geometry');

  const km = (Number(data.trip.summary?.length) || 0);
  const freeFlowSeconds = Number(data.trip.summary?.time) || 0;
  const seconds = mode === 'bike' ? modeledBikeSeconds(freeFlowSeconds, km) : freeFlowSeconds;
  const kmLabel = km >= 100 ? km.toFixed(0) : km.toFixed(1);
  const mins = Math.round(seconds / 60);
  const modeLabel = mode === 'walk' ? 'walking' : 'bike';

  return {
    id: 0,
    distance: km * 1000,
    duration: seconds,
    coords,
    steps,
    mode,
    etaSource: 'valhalla',
    summary: `${kmLabel} km · ${mins} min · ${modeLabel}`,
  };
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

  const duration = Number(raw.duration) || 0;

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
  return maneuverKey(step.maneuver);
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
