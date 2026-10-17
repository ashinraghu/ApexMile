// The route you are planning: origin, destination, ordered stops, alternatives.
// Owns the map drawing for a planned route; navigation owns it once started.
import { bus } from './bus.js';
import { geo, distanceM } from './geo.js';
import { state, activeVehicle, save } from './store.js';
import * as mapCtl from './map.js';
import { directions, buildRouteMeta } from './routing.js';
import { vehicleStats } from './stats.js';
import { toast } from './ui.js';

const FALLBACK = { lat: 12.9716, lng: 77.5946 };

export const journey = {
  origin: null,   // null = "my current location"
  dest: null,
  stops: [],
  routes: [],
  selected: 0,
  mode: state.tripModeSet ? (state.tripMode || 'bike') : 'bike',
  userMode: Boolean(state.tripModeSet), // true once the rider picks a mode explicitly
  loading: false,
  error: null,
  // Real per-mode routes for the current destination, filled by
  // planComparison(). This is what powers the Bike / Car / Walk comparison:
  // every ETA in it comes from an actual routing-engine call for that mode —
  // never from dividing another mode's distance by an assumed speed (the
  // v11.3.1 bug that v11.3.2 removed rather than fixed).
  modeRoutes: {}, // mode -> routes[] (same shape as journey.routes)
  modeErrors: {}, // mode -> message, for modes with no route
  comparing: false,
};

export const MODES = ['bike', 'car', 'walk'];
export const MODE_META = {
  bike: { label: 'Bike', icon: 'bike' },
  car: { label: 'Car', icon: 'car' },
  walk: { label: 'Walk', icon: 'walk' },
};

/** The best (first) real route we hold for a mode, or null. */
export function modeRoute(mode) {
  return journey.modeRoutes?.[mode]?.[0] || null;
}

/**
 * Minutes for a mode — ONLY from a real route planned for that mode.
 * Returns null when we have not planned that mode, so callers can show
 * "checking…" / "no route" instead of a guessed number.
 */
export function modeMinutes(mode, route = currentRoute()) {
  const own = modeRoute(mode);
  if (own?.duration) return Math.max(1, Math.round(own.duration / 60));
  if (route && route.mode === mode && route.duration) return Math.max(1, Math.round(route.duration / 60));
  return null;
}

export function startPoint() {
  if (journey.origin) return journey.origin;
  if (geo.pos) return { name: 'Your location', lat: geo.pos.lat, lng: geo.pos.lng, current: true };
  return { name: 'Bengaluru', ...FALLBACK, current: true };
}

export function setOrigin(place) {
  journey.origin = place || null;
  if (journey.dest) plan({ fit: false });
  else emit();
}

export function setMode(mode, { explicit = true } = {}) {
  if (!MODES.includes(mode)) return;
  if (explicit) {
    journey.userMode = true;
    state.tripModeSet = true;
  }
  state.tripMode = mode;
  save();
  if (journey.mode === mode && journey.routes.length) { emit(); return; }
  journey.mode = mode;
  // Google-Maps behaviour: switching mode in the comparison is instant when
  // we already planned that mode (we did, in parallel, on destination pick).
  const cached = journey.modeRoutes?.[mode];
  if (journey.dest && cached?.length) {
    journey.routes = cached;
    journey.selected = 0;
    journey.error = null;
    draw();
    emit();
    return;
  }
  if (journey.dest) plan({ fit: false });
  else emit();
}

export async function setDestination(place) {
  if (!place) return;
  journey.dest = place;
  await plan();
}

export function select(index) {
  if (!journey.routes[index]) return;
  journey.selected = index;
  draw();
  emit();
}

let planSeq = 0;

/**
 * Plan every travel mode for the destination in parallel, so the place card
 * can show a Bike / Car / Walk comparison with a real, differentiated ETA
 * for each — like Google Maps. The currently chosen mode's routes become
 * journey.routes; switching mode afterwards is a cache hit, not a re-plan.
 */
export async function planComparison({ fit = true, silent = false } = {}) {
  if (!journey.dest) return null;
  const seq = ++planSeq;
  const from = startPoint();
  const to = journey.dest;
  const via = journey.stops;
  journey.loading = true;
  journey.comparing = true;
  journey.error = null;
  journey.modeRoutes = {};
  journey.modeErrors = {};
  emit();

  const settled = await Promise.allSettled(MODES.map(async (mode) => {
    const { routes } = await directions({ from, to, via, mode });
    return routes.map((r) => ({ ...r, meta: buildRouteMeta(r) }));
  }));
  if (seq !== planSeq) return null; // a newer plan superseded this one

  settled.forEach((res, i) => {
    const mode = MODES[i];
    if (res.status === 'fulfilled' && res.value.length) journey.modeRoutes[mode] = res.value;
    else journey.modeErrors[mode] = res.reason?.message || 'No route for this mode';
  });

  // Keep the chosen mode if it has a route; otherwise fall back to the
  // first mode that does, so the map is never left routeless when at
  // least one way of travelling works.
  if (!journey.modeRoutes[journey.mode]?.length) {
    const fallback = MODES.find((m) => journey.modeRoutes[m]?.length);
    if (fallback) journey.mode = fallback;
  }
  journey.routes = journey.modeRoutes[journey.mode] || [];
  journey.selected = 0;
  journey.loading = false;
  journey.comparing = false;

  if (!journey.routes.length) {
    journey.error = 'Could not plan that route';
    emit();
    if (!silent) {
      toast('No route found between those points for Bike, Car or Walk. Check your connection or the places.', { type: 'err' });
    }
    return null;
  }
  draw();
  if (fit) mapCtl.fitRoute(journey.routes[0].meta.coords, { paddingBottom: 250 });
  emit();
  return journey.routes[0];
}

/** Back-compat name: every re-plan is now a full mode comparison. */
export async function plan(opts = {}) {
  return planComparison(opts);
}

function draw() {
  const chosen = journey.routes[journey.selected];
  if (!chosen) return;
  const alts = journey.routes
    .filter((_, i) => i !== journey.selected)
    .map((r, i) => ({ id: i + 1, coords: r.meta.coords }));

  mapCtl.drawRoute({
    coords: chosen.meta.coords,
    alts,
    mode: journey.mode,
  });
  mapCtl.setDest(journey.dest.lat, journey.dest.lng, journey.dest.name);
  mapCtl.setStops(journey.stops);
}

export function clear({ keepView = false } = {}) {
  journey.dest = null;
  journey.origin = null;
  journey.routes = [];
  journey.stops = [];
  journey.selected = 0;
  journey.error = null;
  journey.modeRoutes = {};
  journey.modeErrors = {};
  journey.comparing = false;
  journey.loading = false;
  planSeq += 1; // ignore any comparison still in flight for the old place
  mapCtl.clearRoute();
  emit({ cleared: true });
  if (!keepView && geo.pos) mapCtl.recenter(geo.pos, { zoom: 15.6, duration: 500 });
}

/* ------------------------------------------------------------------ stops */

export async function addStop(place, position = 'before_dest') {
  if (!place) return;
  const stop = {
    id: `s_${Date.now().toString(36)}`,
    name: place.name,
    lat: place.lat,
    lng: place.lng,
  };

  if (position === 'first_start') {
    journey.origin = { name: stop.name, lat: stop.lat, lng: stop.lng };
  } else if (position === 'last_dest') {
    if (journey.dest) journey.stops.push(journey.dest);
    journey.dest = { name: stop.name, lat: stop.lat, lng: stop.lng };
  } else {
    journey.stops.push(stop);
  }

  if (journey.dest) await plan({ fit: false });
  else emit();
}

export function moveStop(index, action) {
  const stops = journey.stops;
  if (index < 0 || index >= stops.length) return;
  const [item] = stops.splice(index, 1);
  if (action === 'up') stops.splice(Math.max(0, index - 1), 0, item);
  else if (action === 'down') stops.splice(Math.min(stops.length, index + 1), 0, item);
  else if (action === 'first') {
    const oldOrigin = journey.origin;
    journey.origin = { name: item.name, lat: item.lat, lng: item.lng };
    if (oldOrigin) stops.unshift({ id: `s_${Date.now().toString(36)}`, ...oldOrigin });
  } else if (action === 'last') {
    if (journey.dest) stops.push(journey.dest);
    journey.dest = { name: item.name, lat: item.lat, lng: item.lng };
  }
  plan({ fit: false });
}

export function removeStop(index) {
  if (index < 0 || index >= journey.stops.length) return;
  journey.stops.splice(index, 1);
  plan({ fit: false });
}

export function clearStops() {
  journey.stops = [];
  plan({ fit: false });
}

/* ------------------------------------------------------------------ estimates */

/** Car trips use the garage's car, bike trips its bike, rather than whichever
 *  vehicle happens to be selected on the Home tab. */
function vehicleForMode(mode) {
  if (mode === 'walk') return null;
  const wanted = mode === 'car' ? 'Car' : 'Bike';
  const active = activeVehicle();
  if (active?.type === wanted) return active;
  const match = state.vehicles.find((v) => v.type === wanted);
  return match || active || null;
}

export function estimates(route = journey.routes[journey.selected]) {
  if (!route) return null;
  const mode = route.mode || journey.mode;
  const veh = vehicleForMode(mode);
  const stats = vehicleStats(veh);
  const km = route.distance / 1000;
  const onFoot = mode === 'walk' || !veh;
  const litres = onFoot || !(stats.kmpl > 0) ? 0 : km / stats.kmpl;
  const fuel = litres * (state.region.prices[state.octane] || 0);
  const tolls = mode === 'car' ? Number(route.tolls) || 0 : 0;
  const arrival = new Date(Date.now() + route.duration * 1000);
  return {
    km,
    minutes: route.duration / 60,
    litres,
    fuel,
    tolls,
    total: fuel + tolls,
    tollInfo: route.tollInfo || null,
    arrival,
    kmpl: stats.kmpl,
    measured: stats.measured,
    vehicleName: veh?.name || 'your vehicle',
    vehicleType: veh?.type || '',
    mode,
  };
}

function emit(extra = {}) {
  bus.emit('journey:update', { journey, ...extra });
}

/** Re-emit the current plan without touching the network. Used when guidance
 *  ends: the rider goes back to the Directions preview with the destination,
 *  stops, alternatives and cost all still populated. */
export function refresh() {
  if (hasRoute()) draw();
  emit();
}

export function hasRoute() {
  return Boolean(journey.dest && journey.routes.length);
}

export function currentRoute() {
  return journey.routes[journey.selected] || null;
}

/** Distance from where the rider is now to where the planned route starts. */
export function driftFromOrigin() {
  const from = startPoint();
  if (!geo.pos) return 0;
  return distanceM(geo.pos, from);
}
