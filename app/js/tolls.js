// Toll estimation from OpenStreetMap.
//
// There is no free, authoritative live toll API for India: NHAI publishes rate
// tables as PDFs and commercial providers (TollGuru, Google) require keys. What
// we can do honestly is find the toll plazas that are actually mapped on the
// road you are taking and multiply by a typical car rate. The UI labels this as
// an estimate and shows how many plazas were counted.
//
// Two-wheelers are exempt from tolls on national highways in India, so bikes
// always return zero — that is a rule, not an estimate.
import { distanceM } from './geo.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const CACHE = new Map();
const CACHE_MS = 30 * 60 * 1000;
const CORRIDOR_M = 200;
const DEDUPE_M = 700;

/** Typical Indian national-highway car rate per plaza. */
export const TOLL_RATE_CAR = 95;

export function tollEstimate(count) {
  return Math.max(0, count) * TOLL_RATE_CAR;
}

function bboxFor(coords, pad = 0.012) {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const [lng, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return [minLat - pad, minLng - pad, maxLat + pad, maxLng + pad];
}

function distanceToLineM(point, coords) {
  let best = Infinity;
  for (let i = 1; i < coords.length; i += 1) {
    const a = { lng: coords[i - 1][0], lat: coords[i - 1][1] };
    const b = { lng: coords[i][0], lat: coords[i][1] };
    const scale = 111320 * Math.cos((point.lat * Math.PI) / 180);
    const px = (point.lng - a.lng) * scale;
    const py = (point.lat - a.lat) * 110540;
    const dx = (b.lng - a.lng) * scale;
    const dy = (b.lat - a.lat) * 110540;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
    const d = Math.hypot(px - t * dx, py - t * dy);
    if (d < best) best = d;
    if (best < 5) break;
  }
  return best;
}

function cacheKey(coords, mode) {
  const first = coords[0];
  const last = coords[coords.length - 1];
  return `${mode}|${coords.length}|${first[0].toFixed(3)},${first[1].toFixed(3)}|${last[0].toFixed(3)},${last[1].toFixed(3)}`;
}

/**
 * @returns {Promise<{count:number, rate:number, total:number, plazas:Array<{lat:number,lng:number}>}>}
 */
export async function tollPlazasFor(coords, mode = 'car') {
  if (mode !== 'car') return { count: 0, rate: 0, total: 0, plazas: [], exempt: true };
  if (!Array.isArray(coords) || coords.length < 2) {
    return { count: 0, rate: TOLL_RATE_CAR, total: 0, plazas: [] };
  }

  const key = cacheKey(coords, mode);
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const [south, west, north, east] = bboxFor(coords);
  // A cross-country bbox would be irresponsible to send to a public Overpass
  // instance. Skip and let the UI say the estimate is unavailable.
  if ((north - south) * (east - west) > 40) {
    const value = { count: 0, rate: TOLL_RATE_CAR, total: 0, plazas: [], unavailable: true };
    CACHE.set(key, { at: Date.now(), value });
    return value;
  }

  const query = `[out:json][timeout:20];(`
    + `nwr["barrier"="toll_booth"](${south},${west},${north},${east});`
    + `nwr["highway"="toll_gantry"](${south},${west},${north},${east});`
    + `);out center 120;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let data;
  try {
    const res = await fetch(`${OVERPASS}?data=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const raw = (data.elements || [])
    .map((el) => ({
      lat: Number.isFinite(el.lat) ? el.lat : el.center?.lat,
      lng: Number.isFinite(el.lon) ? el.lon : el.center?.lon,
      name: el.tags?.name || el.tags?.operator || '',
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  const onRoute = raw.filter((p) => distanceToLineM(p, coords) <= CORRIDOR_M);

  const plazas = [];
  for (const plaza of onRoute) {
    if (plazas.some((p) => distanceM(p, plaza) < DEDUPE_M)) continue;
    plazas.push(plaza);
  }

  const value = {
    count: plazas.length,
    rate: TOLL_RATE_CAR,
    total: tollEstimate(plazas.length),
    plazas,
  };
  CACHE.set(key, { at: Date.now(), value });
  return value;
}
