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
};

export const MODES = ['bike', 'car', 'walk'];
export const MODE_META = {
  bike: { label: 'Bike', icon: 'bike', kmh: 33 },
  car: { label: 'Car', icon: 'car', kmh: 38 },
  walk: { label: 'Walk', icon: 'walk', kmh: 4.8 },
};

/** Minutes for any mode, using this route's own duration when it matches. */
export function modeMinutes(mode, route = currentRoute()) {
  if (!route) return null;
  if (route.mode === mode && route.duration) return Math.max(1, Math.round(route.duration / 60));
  const km = route.distance / 1000;
  const kmh = MODE_META[mode]?.kmh || 33;
  return Math.max(1, Math.round((km / kmh) * 60));
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
  if (journey.mode === mode) { emit(); return; }
  journey.mode = mode;
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

export async function plan({ fit = true, silent = false } = {}) {
  if (!journey.dest) return null;

  const from = startPoint();
  journey.loading = true;
  journey.error = null;
  emit();

  try {
    const { routes, mode } = await directions({
      from,
      to: journey.dest,
      via: journey.stops,
      mode: journey.mode,
    });
    journey.routes = routes.map((r) => {
      const meta = buildRouteMeta(r);
      return { ...r, meta };
    });
    journey.selected = 0;
    journey.mode = mode;
    draw();
    if (fit) mapCtl.fitRoute(journey.routes[0].meta.coords, { paddingBottom: 250 });
    journey.loading = false;
    emit();
    return journey.routes[0];
  } catch (err) {
    journey.loading = false;
    journey.error = err?.message || 'Could not plan that route';
    emit();
    if (!silent) {
      toast(
        /fetch|network|abort/i.test(String(err?.message))
          ? 'Routing service did not answer. Check your connection.'
          : 'No drivable route found between those points.',
        { type: 'err' },
      );
    }
    return null;
  }
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
