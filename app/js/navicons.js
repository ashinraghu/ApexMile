// Vector manoeuvre symbols.
//
// The navigation surface must not use emoji: the platform font decides what a
// finish-flag or speaker glyph looks like, and on Android those glyphs are
// colourful cartoons that fight the green instruction card. Everything here is
// drawn on one 24×24 grid with the same 2 px stroke, rounded caps and a single
// accent colour inherited from `currentColor`, so the turn list and the two
// round buttons in the navigation bar share one visual language.

const OPEN = '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
  + 'aria-hidden="true" focusable="false">';
const CLOSE = '</svg>';

/** Road-following shapes: a shaft for the road, an L-shaped head for the arrow. */
const GLYPHS = {
  straight: '<path d="M12 20V5.5"/><path d="m7 10.5 5-5 5 5"/>',

  'slight-right': '<path d="M12 20v-6a5 5 0 0 1 1.5-3.5L19 5"/><path d="M14 5h5v5"/>',
  'slight-left': '<path d="M12 20v-6a5 5 0 0 0-1.5-3.5L5 5"/><path d="M10 5H5v5"/>',

  right: '<path d="M7 20v-8a4 4 0 0 1 4-4h7"/><path d="m14 4 4 4-4 4"/>',
  left: '<path d="M17 20v-8a4 4 0 0 0-4-4H6"/><path d="m10 4-4 4 4 4"/>',

  'sharp-right': '<path d="M10 20v-5.5a3 3 0 0 1 1.2-2.4L20 5.5"/><path d="m15.5 4.5 4.5 1-1 4.5"/>',
  'sharp-left': '<path d="M14 20v-5.5a3 3 0 0 0-1.2-2.4L4 5.5"/><path d="m8.5 4.5-4.5 1 1 4.5"/>',

  uturn: '<path d="M7.5 20v-9a4.5 4.5 0 0 1 9 0v5"/><path d="m12.5 12 4 4 4-4"/>',

  roundabout: '<circle cx="12" cy="12" r="4.5"/><path d="M12 20v-3.5"/>'
    + '<path d="M16.5 12H20"/><path d="m17.5 9.5 2.5 2.5-2.5 2.5"/>',

  merge: '<path d="M8 20v-6a4 4 0 0 1 1.3-3L18 5"/><path d="M14 4h5v5"/>',

  fork: '<path d="M12 20v-6"/><path d="M12 14 7 8V3.5"/>'
    + '<path d="M4.5 6 7 3.5 9.5 6"/><path d="M12 14l5-6V3.5"/>',

  arrive: '<path d="M6 21V4"/><path d="M6 4h12l-2.6 4L18 12H6Z"/>',

  ferry: '<path d="m4 15 1.6 4.5h12.8L20 15"/><path d="M7 15V9l5-4 5 4v6"/>'
    + '<path d="M12 15v-5"/>',
};

/** Map an OSRM/Valhalla manoeuvre onto one of the glyph keys. */
export function maneuverKey(maneuver = {}) {
  const m = maneuver || {};
  const mod = String(m.modifier || '').toLowerCase();
  const type = String(m.type || '').toLowerCase();

  if (type.includes('arrive')) return 'arrive';
  if (type.includes('roundabout') || type.includes('rotary')) return 'roundabout';
  if (type.includes('ferry')) return 'ferry';
  if (type.includes('fork')) return 'fork';
  if (type.includes('ramp') || type.includes('merge')) return 'merge';

  if (mod.includes('uturn') || mod.includes('u-turn')) return 'uturn';
  if (mod.includes('sharp left')) return 'sharp-left';
  if (mod.includes('sharp right')) return 'sharp-right';
  if (mod.includes('slight left')) return 'slight-left';
  if (mod.includes('slight right')) return 'slight-right';
  if (mod.includes('left')) return 'left';
  if (mod.includes('right')) return 'right';
  return 'straight';
}

/** The SVG markup for a glyph key, safe to drop into innerHTML. */
export function maneuverSvg(key) {
  return OPEN + (GLYPHS[key] || GLYPHS.straight) + CLOSE;
}

/* ------------------------------------------------------------------ buttons */

export const GROUP_SVG = `${OPEN}<circle cx="9" cy="8" r="3.2"/>`
  + '<path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.9"/>'
  + '<path d="M17 14.6a5.5 5.5 0 0 1 3.5 4.4"/>' + CLOSE;

/** A speaker with waves when guidance is audible, a slash when it is muted. */
export function voiceSvg(on) {
  const speaker = '<path d="M4 9.5v5h3.6L12 19V5L7.6 9.5Z"/>';
  const tail = on
    ? '<path d="M15.4 8.6a5 5 0 0 1 0 6.8"/><path d="M18 6a8.6 8.6 0 0 1 0 12"/>'
    : '<path d="m15.5 9.5 5 5"/><path d="m20.5 9.5-5 5"/>';
  return OPEN + speaker + tail + CLOSE;
}

/** Small leading icons for the two map-layer pills. */
export const TRAFFIC_SVG = `${OPEN}<rect x="7" y="2.6" width="10" height="18.8" rx="3.2"/>`
  + '<circle cx="12" cy="7" r="1.15" fill="currentColor" stroke="none"/>'
  + '<circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/>'
  + '<circle cx="12" cy="17" r="1.15" fill="currentColor" stroke="none"/>' + CLOSE;

export const SATELLITE_SVG = `${OPEN}<circle cx="12" cy="12" r="4"/>`
  + '<ellipse cx="12" cy="12" rx="9.4" ry="4.1" transform="rotate(-28 12 12)"/>' + CLOSE;

/* ------------------------------------------------------------------ UI icons */

// One drawn vocabulary for the rest of the app too: home tiles, vehicle
// thumbnails, mode chips, search suggestions, toasts, status chips and map
// markers. No emoji anywhere in the interface — the platform font turns them
// into mismatched cartoons — just this same 24×24 grid and 2 px stroke.
const UI = {
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="m6 6 12 12"/><path d="m18 6-12 12"/>',
  warn: '<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.2"/>'
    + '<circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/>'
    + '<circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none"/>',

  bike: '<circle cx="5.4" cy="16.6" r="3.4"/><circle cx="18.6" cy="16.6" r="3.4"/>'
    + '<path d="M5.4 16.6 10 8.6h3.4l2.6 4.6"/><path d="M8.6 8.6h4.8"/><path d="m13.4 13.2 1.8 3.4"/>',
  car: '<path d="M3.8 15.6v-2.8l2-4.6h12.4l2 4.6v2.8"/><path d="M3.8 15.6h16.4"/>'
    + '<path d="M6 12.8h12"/><circle cx="7.6" cy="15.8" r="1.9"/><circle cx="16.4" cy="15.8" r="1.9"/>',
  walk: '<circle cx="13.2" cy="4.6" r="2.1"/><path d="m10.2 21 2.2-6.4-2.2-2.6.8-4.2 3.4 2.2 2.8.8"/>'
    + '<path d="m12.4 14.6 2.8 6.4"/><path d="m10.2 12 -2.2 3.6L5.8 17"/>',

  fuel: '<rect x="4" y="3.6" width="9.4" height="16.8" rx="1.6"/><path d="M4 9.6h9.4"/>'
    + '<path d="M13.4 7h2.8a1.6 1.6 0 0 1 1.6 1.6v8.2a1.6 1.6 0 0 0 1.6 1.6"/><path d="M16 20.4v-6.2"/>',
  dish: '<circle cx="12" cy="12" r="2"/><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20"/>'
    + '<path d="M12 6a6 6 0 1 1 0 12"/>',
  chain: '<rect x="3.2" y="9" width="10.4" height="6" rx="3"/><rect x="10.4" y="9" width="10.4" height="6" rx="3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/>'
    + '<path d="M12 18v3"/>',
  chat: '<path d="M21 12a8 8 0 0 1-8 8H4.5l2.1-2.6A8 8 0 1 1 21 12Z"/><path d="M8.5 10.5h7"/><path d="M8.5 13.5h4.5"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4h12l-2.6 4L18 12H6Z"/>',
  locate: '<path d="M12 3 5 21l7-4 7 4Z"/>',
  swap: '<path d="M8 4.5v13"/><path d="m4.8 14.2 3.2 3.3 3.2-3.3"/><path d="M16 19.5v-13"/>'
    + '<path d="m12.8 9.8 3.2-3.3 3.2 3.3"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.4"/>'
    + '<path d="M8.2 7 9.6 4h4.8L15.8 7"/>',
  wrench: '<path d="M20.4 5.6a4.6 4.6 0 0 1-6 6L6 20a2.1 2.1 0 0 1-3-3l8.4-8.4a4.6 4.6 0 0 1 6-6l-3.1 3.1 1.5 1.5 1.6 1.6Z"/>',
  cup: '<path d="M5 8h11v6.2a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5Z"/><path d="M16 9.6h1.8a2.5 2.5 0 0 1 0 5H16"/>'
    + '<path d="M6.5 4.6v1.6M10.2 3.4v2.8"/>',
  wildlife: '<circle cx="7" cy="8.4" r="2"/><circle cx="12" cy="6.4" r="2"/><circle cx="17" cy="8.4" r="2"/>'
    + '<path d="M12 11.4c-3 0-5.2 2.3-5.2 4.6S9 20.4 12 20.4s5.2-2.1 5.2-4.4-2.2-4.6-5.2-4.6Z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  sos: '<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.2"/>'
    + '<circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
  offline: '<path d="M5 12.4a10 10 0 0 1 4.2-2.5"/><path d="M2 8.8a16 16 0 0 1 5.4-3.1"/>'
    + '<path d="M8.6 16.2a5 5 0 0 1 6.8 0"/><path d="M12 20h.01"/><path d="m3 3 18 18"/>',
  reroute: '<path d="M20 11a8 8 0 1 0-2.4 5.8"/><path d="M20 5v6h-6"/>',
  external: '<path d="M14 4h6v6"/><path d="m20 4-9 9"/>'
    + '<path d="M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5"/>',
  'voice-on': '<path d="M4 9.5v5h3.6L12 19V5L7.6 9.5Z"/>'
    + '<path d="M15.4 8.6a5 5 0 0 1 0 6.8"/><path d="M18 6a8.6 8.6 0 0 1 0 12"/>',
  'voice-off': '<path d="M4 9.5v5h3.6L12 19V5L7.6 9.5Z"/>'
    + '<path d="m15.5 9.5 5 5"/><path d="m20.5 9.5-5 5"/>',
};

/** The SVG markup for a UI icon name, safe to drop into innerHTML. */
export function uiIcon(name) {
  return OPEN + (UI[name] || UI.info) + CLOSE;
}
