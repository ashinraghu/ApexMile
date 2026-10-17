// MapLibre GL. Vector styles from OpenFreeMap (no API key, ODbL data, proper
// attribution). Raster "traffic" and satellite tiles are deliberately not used:
// they need a licensed provider. Drop a MapTiler/Mapbox key in STYLES when you
// have one and both become a one-line change.
import { bus } from './bus.js';
import { distanceM } from './geo.js';

const maplibregl = window.maplibregl;

export const STYLES = {
  streets: 'https://tiles.openfreemap.org/styles/liberty',
  clean: 'https://tiles.openfreemap.org/styles/positron',
  night: 'https://tiles.openfreemap.org/styles/dark',
  terrain: 'https://tiles.openfreemap.org/styles/fiord',
  satellite: satelliteStyle(),
};

// Satellite is a raster layer: Esri World Imagery is the only no-key global
// source that is stable enough to ship. Everything else stays vector.
function satelliteStyle() {
  return {
    version: 8,
    sources: {
      'esri-sat': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
      'esri-labels': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 19,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0B1220' } },
      { id: 'sat', type: 'raster', source: 'esri-sat', paint: { 'raster-opacity': 1 } },
      { id: 'labels', type: 'raster', source: 'esri-labels', paint: { 'raster-opacity': 0.85 } },
    ],
  };
}

const ROUTE_COLOR = { bike: '#0A6CFF', car: '#FF5500', walk: '#0E9F6E' };
const ROUTE_CASE = { bike: '#062B66', car: '#6B2100', walk: '#043D2B' };

const mapCtl = {
  map: null,
  ready: false,
  preset: 'streets',
  follow: true,
  navigating: false,
  _meMarker: null,
  _meEl: null,
  _accuracySourceReady: false,
  _lastAccDraw: 0,
  _peerMarkers: new Map(),
  _destMarker: null,
  _stopMarkers: [],
  _poiMarkers: [],
  _route: null,
  _alts: null,
  _routeVisible: false,
};

// Last-resort raster style if the vector service is down or blocked. Carto's
// public basemap has no key and is already allowed by our CSP.
const CARTO_TILES = 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png';

function cartoStyle() {
  return {
    version: 8,
    sources: {
      carto: {
        type: 'raster',
        tiles: [CARTO_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors © CARTO',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#EEF2F7' } },
      { id: 'carto', type: 'raster', source: 'carto', paint: { 'raster-opacity': 1 } },
    ],
  };
}

/* ------------------------------------------------------------------ init */

export function initMap({ center, preset, interactive = true } = {}) {
  if (mapCtl.map) return mapCtl.map;

  if (!maplibregl) {
    console.error('[map] MapLibre failed to load');
    bus.emit('map:error', { message: 'Map engine did not load. Check your connection and reload.' });
    return null;
  }

  const start = center || { lat: 12.9716, lng: 77.5946 };
  const chosen = preset && STYLES[preset] ? preset : mapCtl.preset;
  mapCtl.preset = chosen;

  const map = new maplibregl.Map({
    container: 'map',
    style: STYLES[chosen],
    center: [start.lng, start.lat],
    zoom: 15.2,
    pitch: 0,
    bearing: 0,
    maxZoom: 19.5,
    minZoom: 3,
    attributionControl: false,
    maplibreLogo: false,
    dragRotate: true,
    pitchWithRotate: true,
    touchZoomRotate: true,
    touchPitch: true,
    cooperativeGestures: false,
    fadeDuration: 120,
  });

  mapCtl.map = map;

  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '© OpenFreeMap · © OpenStreetMap contributors',
  }), 'bottom-right');

  map.on('load', () => {
    mapCtl.ready = true;
    ensureLayers();
    if (mapCtl._pendingMe) setMe(mapCtl._pendingMe);
    bus.emit('map:ready');
  });

  const styleGuard = setTimeout(() => {
    if (!mapCtl.ready) useFallbackStyle(map, 'timeout');
  }, 11000);
  map.once('load', () => clearTimeout(styleGuard));

  map.on('error', (e) => {
    // Tile 404s and offline blips are noise; a style failure is worth handling once.
    if (e?.error?.status && e.error.status >= 400 && e.error.status < 500) return;
    if (!mapCtl.ready && /style|sprite|glyph|fetch/i.test(String(e?.error?.message || ''))) {
      useFallbackStyle(map, 'error');
    } else if (!mapCtl._warnedStyle) {
      mapCtl._warnedStyle = true;
      console.warn('[map]', e.error);
    }
  });

  // Long-press (contextmenu on touch) drops a pin, like any map app.
  map.on('contextmenu', (e) => {
    try { e.preventDefault(); } catch { /* noop */ }
    bus.emit('map:longpress', { lat: e.lngLat.lat, lng: e.lngLat.lng });
  });

  map.on('dragstart', () => {
    mapCtl.follow = false;
    bus.emit('map:userpan');
  });
  map.on('rotatestart', (e) => {
    if (e.originalEvent && mapCtl.navigating) {
      mapCtl.follow = false;
      bus.emit('map:userpan');
    }
  });
  map.on('zoomstart', (e) => {
    if (e.originalEvent && mapCtl.navigating) {
      mapCtl.follow = false;
      bus.emit('map:userpan');
    }
  });
  map.on('rotate', scheduleBeam);
  map.on('click', (e) => bus.emit('map:click', { lngLat: e.lngLat }));

  return map;
}

function useFallbackStyle(map, reason) {
  if (mapCtl._fallbackApplied) return;
  mapCtl._fallbackApplied = true;
  console.warn('[map] switching to raster fallback:', reason);
  try {
    map.setStyle(cartoStyle(), { diff: false });
    map.once('style.load', () => {
      mapCtl.ready = true;
      ensureLayers();
      if (mapCtl._route) { drawRouteGeometry(); drawAlternatives(); }
      if (mapCtl._lastAcc) setAccuracy(mapCtl._lastAcc);
      bus.emit('map:fallback');
    });
  } catch (err) {
    console.warn('[map] fallback failed', err);
  }
}

/* ------------------------------------------------------------------ styles */

export function setStylePreset(preset) {
  if (!STYLES[preset] || preset === mapCtl.preset) {
    mapCtl.preset = preset in STYLES ? preset : mapCtl.preset;
    return;
  }
  mapCtl.preset = preset;
  const map = mapCtl.map;
  if (!map) return;
  map.setStyle(STYLES[preset], { diff: false });
  map.once('style.load', () => {
    ensureLayers();
    if (mapCtl._route) {
      drawRouteGeometry();
      if (mapCtl._progress) setRouteProgress(mapCtl._progress);
    }
    if (mapCtl._alts) drawAlternatives();
    if (mapCtl._lastAcc) setAccuracy(mapCtl._lastAcc);
  });
}

function ensureLayers() {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready) return;

  if (!map.getSource('apex-acc')) {
    map.addSource('apex-acc', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'apex-acc-fill',
      type: 'fill',
      source: 'apex-acc',
      paint: { 'fill-color': '#0A6CFF', 'fill-opacity': 0.10 },
    });
    map.addLayer({
      id: 'apex-acc-line',
      type: 'line',
      source: 'apex-acc',
      paint: { 'line-color': '#0A6CFF', 'line-opacity': 0.35, 'line-width': 1.2 },
    });
    mapCtl._accuracySourceReady = true;
  }

  if (!map.getSource('apex-alts')) {
    map.addSource('apex-alts', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'apex-alts-line',
      type: 'line',
      source: 'apex-alts',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#7A8699',
        'line-width': 4.5,
        'line-opacity': 0.55,
        'line-dasharray': [1.4, 1.4],
      },
    });
  }

  if (!map.getSource('apex-route')) {
    map.addSource('apex-route', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'apex-route-case',
      type: 'line',
      source: 'apex-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0B1F3A', 'line-width': 10, 'line-opacity': 0.55 },
    });
    map.addLayer({
      id: 'apex-route-line',
      type: 'line',
      source: 'apex-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ROUTE_COLOR.bike, 'line-width': 6, 'line-opacity': 1 },
    });
  }

  if (!map.getSource('apex-route-done')) {
    map.addSource('apex-route-done', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'apex-route-done-line',
      type: 'line',
      source: 'apex-route-done',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#8A97A8', 'line-width': 6, 'line-opacity': 0.85 },
    });
  }

  // Keep our overlays above whatever the style ships.
  for (const id of ['apex-acc-fill', 'apex-acc-line', 'apex-alts-line', 'apex-route-case', 'apex-route-line', 'apex-route-done-line']) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

/* ------------------------------------------------------------------ me */

function buildMeElement() {
  const el = document.createElement('div');
  el.className = 'mk-me';
  el.setAttribute('aria-label', 'Your location');
  const beam = document.createElement('div');
  beam.className = 'beam';
  const core = document.createElement('div');
  core.className = 'core';
  el.append(beam, core);
  return el;
}

export function setMe(pos) {
  if (!pos) return;
  const map = mapCtl.map;
  if (!map || !mapCtl.ready) { mapCtl._pendingMe = pos; return; }

  if (!mapCtl._meMarker) {
    mapCtl._meEl = buildMeElement();
    mapCtl._meMarker = new maplibregl.Marker({ element: mapCtl._meEl, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' })
      .setLngLat([pos.lng, pos.lat])
      .addTo(map);
  } else {
    mapCtl._meMarker.setLngLat([pos.lng, pos.lat]);
  }
  mapCtl._mePos = pos;
  applyBeamRotation(pos.heading || 0);
  if (Date.now() - mapCtl._lastAccDraw > 1800) setAccuracy(pos);
}

function scheduleBeam() {
  if (mapCtl._raf) return;
  mapCtl._raf = requestAnimationFrame(() => {
    mapCtl._raf = null;
    applyBeamRotation(mapCtl._meHeading || 0);
  });
}

function applyBeamRotation(heading) {
  mapCtl._meHeading = heading;
  const beam = mapCtl._meEl?.querySelector('.beam');
  if (!beam || !mapCtl.map) return;
  const mapBearing = mapCtl.map.getBearing();
  // The beam always points where the rider is actually heading on screen.
  beam.style.transform = `translateX(-50%) rotate(${heading - mapBearing}deg)`;
}

function setAccuracy(pos) {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready || !map.getSource('apex-acc')) return;
  mapCtl._lastAccDraw = Date.now();
  mapCtl._lastAcc = pos;
  const r = Math.min(Math.max(pos.acc || 10, 4), 250);
  const points = 48;
  const coords = [];
  const latRad = (pos.lat * Math.PI) / 180;
  const dLat = (r / 111320);
  const dLng = r / (111320 * Math.cos(latRad));
  for (let i = 0; i <= points; i += 1) {
    const a = (i / points) * Math.PI * 2;
    coords.push([pos.lng + Math.cos(a) * dLng, pos.lat + Math.sin(a) * dLat]);
  }
  map.getSource('apex-acc').setData({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: {},
  });
}

/* ------------------------------------------------------------------ peers */

export function upsertPeer(peer, mePos) {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready || !peer) return;
  let entry = mapCtl._peerMarkers.get(peer.id);

  if (!entry) {
    const el = document.createElement('div');
    el.className = 'mk-peer';
    const pin = document.createElement('div');
    pin.className = 'pin';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    el.append(pin, lbl);
    const marker = new maplibregl.Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' })
      .setLngLat([peer.lng, peer.lat])
      .addTo(map);
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      bus.emit('peer:click', { id: peer.id });
    });
    entry = { marker, el, pin, lbl };
    mapCtl._peerMarkers.set(peer.id, entry);
  }

  const { marker, el, pin, lbl } = entry;
  marker.setLngLat([peer.lng, peer.lat]);
  pin.textContent = (peer.name || '?').trim().charAt(0).toUpperCase() || '?';
  pin.style.background = peer.sos ? '#E02D2D' : peer.color || '#0A6CFF';
  const dist = mePos ? distanceM(mePos, peer) : null;
  const distLabel = dist == null ? '' : dist > 995 ? `${(dist / 1000).toFixed(1)} km` : `${dist} m`;
  lbl.textContent = `${peer.name}${distLabel ? ` · ${distLabel}` : ''}`;
  el.classList.toggle('stale', Boolean(peer.stale));
  el.classList.toggle('sos', Boolean(peer.sos));
  el.dataset.peerId = peer.id;
}

export function removePeer(id) {
  const entry = mapCtl._peerMarkers.get(id);
  if (!entry) return;
  entry.marker.remove();
  mapCtl._peerMarkers.delete(id);
}

export function clearPeers() {
  for (const id of [...mapCtl._peerMarkers.keys()]) removePeer(id);
}

/* ------------------------------------------------------------------ route */

export function drawRoute({ coords, alts = [], mode = 'bike', dimDone = false }) {
  if (!coords?.length) return;
  mapCtl._route = { coords, mode };
  mapCtl._alts = alts;
  mapCtl._routeVisible = true;
  drawRouteGeometry();
  drawAlternatives();
  if (dimDone) setRouteProgress(0);
}

function drawRouteGeometry() {
  const map = mapCtl.map;
  const r = mapCtl._route;
  if (!map || !mapCtl.ready || !r || !map.getSource('apex-route')) return;
  map.getSource('apex-route').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: r.coords },
    properties: {},
  });
  const color = ROUTE_COLOR[r.mode] || ROUTE_COLOR.bike;
  const casing = ROUTE_CASE[r.mode] || ROUTE_CASE.bike;
  try {
    map.setPaintProperty('apex-route-line', 'line-color', color);
    map.setPaintProperty('apex-route-case', 'line-color', casing);
    map.setPaintProperty('apex-route-line', 'line-dasharray', r.mode === 'walk' ? [0.4, 1.6] : null);
    map.setPaintProperty('apex-route-line', 'line-width', r.mode === 'walk' ? 4.5 : 6);
  } catch { /* style still loading */ }
}

function drawAlternatives() {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready || !map.getSource('apex-alts')) return;
  const features = (mapCtl._alts || [])
    .filter((a) => a && a.coords?.length)
    .map((a) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: a.coords },
      properties: { id: a.id ?? 0 },
    }));
  map.getSource('apex-alts').setData({ type: 'FeatureCollection', features });
}

/**
 * Split the line so the ridden part is grey and the road ahead stays blue.
 * `cut` is derived from progress along the polyline (0..1).
 */
export function setRouteProgress(progress) {
  const map = mapCtl.map;
  const r = mapCtl._route;
  if (!map || !mapCtl.ready || !r) return;
  const p = Math.max(0, Math.min(1, progress));
  mapCtl._progress = p;
  const total = r.coords.length;
  const cut = Math.min(total - 1, Math.max(0, Math.round(p * (total - 1))));

  const ahead = { type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords.slice(cut) }, properties: {} };
  const doneCoords = r.coords.slice(0, cut + 1);
  const done = doneCoords.length > 1
    ? { type: 'Feature', geometry: { type: 'LineString', coordinates: doneCoords }, properties: {} }
    : { type: 'FeatureCollection', features: [] };

  try {
    map.getSource('apex-route')?.setData(ahead);
    map.getSource('apex-route-done')?.setData(done);
  } catch { /* style loading */ }
}

export function clearRoute() {
  mapCtl._route = null;
  mapCtl._alts = null;
  mapCtl._progress = 0;
  mapCtl._routeVisible = false;
  const map = mapCtl.map;
  if (map && mapCtl.ready) {
    try {
      map.getSource('apex-route')?.setData({ type: 'FeatureCollection', features: [] });
      map.getSource('apex-route-done')?.setData({ type: 'FeatureCollection', features: [] });
      map.getSource('apex-alts')?.setData({ type: 'FeatureCollection', features: [] });
    } catch { /* style loading */ }
  }
  clearDest();
  clearStops();
}

/* ------------------------------------------------------------------ markers */

export function setDest(lat, lng, label = 'Destination') {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready) return;
  if (!mapCtl._destMarker) {
    const el = document.createElement('div');
    el.className = 'mk-dest';
    el.innerHTML = '<span>🏁</span>';
    mapCtl._destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([lng, lat])
      .addTo(map);
  } else {
    mapCtl._destMarker.setLngLat([lng, lat]);
  }
  mapCtl._destMarker.getElement().setAttribute('aria-label', label);
}

export function clearDest() {
  mapCtl._destMarker?.remove();
  mapCtl._destMarker = null;
}

export function setStops(stops = []) {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready) return;
  clearStops();
  stops.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'mk-stop';
    el.textContent = String(i + 1);
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([s.lng, s.lat])
      .addTo(map);
    mapCtl._stopMarkers.push(marker);
  });
}

export function clearStops() {
  mapCtl._stopMarkers.forEach((m) => m.remove());
  mapCtl._stopMarkers = [];
}

export function setPois(items = []) {
  clearPois();
  const map = mapCtl.map;
  if (!map || !mapCtl.ready) return;
  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'mk-poi';
    el.textContent = item.emoji || '📍';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', item.label || 'Place');
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([item.lng, item.lat])
      .addTo(map);

    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const popup = new maplibregl.Popup({ offset: 16, closeButton: false, className: 'apex-popup' })
        .setLngLat([item.lng, item.lat])
        .setDOMContent(buildPopup(item))
        .addTo(map);
      const btn = popup.getElement().querySelector('[data-route-here]');
      btn?.addEventListener('click', () => {
        popup.remove();
        bus.emit('poi:pick', item);
      });
    });

    mapCtl._poiMarkers.push(marker);
  });
}

function buildPopup(item) {
  const wrap = document.createElement('div');
  wrap.className = 'pop';
  const title = document.createElement('b');
  title.textContent = item.label || 'Place';
  const sub = document.createElement('span');
  sub.textContent = item.sub || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.routeHere = '1';
  btn.className = 'pop-btn';
  btn.textContent = 'Route here';
  wrap.append(title);
  if (item.sub) wrap.append(sub);
  wrap.append(btn);
  return wrap;
}

export function clearPois() {
  mapCtl._poiMarkers.forEach((m) => m.remove());
  mapCtl._poiMarkers = [];
}

/* ------------------------------------------------------------------ camera */

export function setFollow(on) {
  mapCtl.follow = Boolean(on);
  bus.emit('map:follow', mapCtl.follow);
}

export function isFollowing() {
  return mapCtl.follow;
}

export function setNavigating(on) {
  mapCtl.navigating = Boolean(on);
  if (on) setFollow(true);
}

/**
 * The heart of the "Google Maps" feel: keep the rider slightly below centre,
 * rotate the world so they always travel up-screen, and zoom out as speed rises.
 */
export function cameraFollow(pos, { heading = null, speed = 0, mode = 'bike' } = {}) {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready || !mapCtl.follow) return;

  const kmh = Math.max(0, speed || 0);
  const walking = mode === 'walk';
  let zoom = walking ? 17.6 : 17.4;
  if (!walking) {
    if (kmh > 75) zoom = 14.6;
    else if (kmh > 50) zoom = 15.4;
    else if (kmh > 28) zoom = 16.2;
    else if (kmh > 10) zoom = 17.0;
  }

  const duration = Math.min(1000, Math.max(450, 700 - kmh * 3));
  const opts = {
    center: [pos.lng, pos.lat],
    zoom,
    duration,
    essential: false,
  };

  if (!walking) {
    opts.pitch = 52;
    if (heading != null && kmh > 4) opts.bearing = heading;
  } else {
    opts.pitch = 0;
    opts.bearing = 0;
    opts.zoom = 17.6;
  }

  // Keep the rider in the upper third so the bottom bar does not cover them.
  opts.offset = [0, -Math.round(window.innerHeight * 0.10)];
  map.easeTo(opts);
}

export function recenter(pos, { zoom = 17.2, pitch = 0, bearing = 0, duration = 500 } = {}) {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready || !pos) return;
  map.easeTo({
    center: [pos.lng, pos.lat],
    zoom,
    pitch,
    bearing,
    duration,
    offset: [0, -30],
  });
  setFollow(true);
}

export function fitRoute(coords, { paddingBottom = 240 } = {}) {
  const map = mapCtl.map;
  if (!map || !mapCtl.ready || !coords?.length) return;
  const bounds = coords.reduce(
    (b, c) => b.extend(c),
    new maplibregl.LngLatBounds(coords[0], coords[0]),
  );
  map.fitBounds(bounds, {
    padding: { top: 130, bottom: paddingBottom, left: 44, right: 44 },
    duration: 700,
    maxZoom: 16,
  });
  setFollow(false);
}

export function togglePitch() {
  const map = mapCtl.map;
  if (!map) return;
  const next = map.getPitch() > 10 ? 0 : 50;
  map.easeTo({ pitch: next, duration: 420 });
  return next;
}

export function flyToMe(pos, zoom = 16.6) {
  if (!pos) return;
  recenter(pos, { zoom, duration: 600 });
}

export function resize() {
  requestAnimationFrame(() => {
    try { mapCtl.map?.resize(); } catch { /* not ready */ }
  });
}

export function mapState() {
  return {
    ready: mapCtl.ready,
    preset: mapCtl.preset,
    follow: mapCtl.follow,
  };
}

export { mapCtl };
