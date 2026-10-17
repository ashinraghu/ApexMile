// Vector manoeuvre symbols.
//
// The navigation surface must not use emoji: the platform font decides what a
// 🏁 or 🔊 looks like, and on Android those glyphs are colourful cartoons that
// fight the green instruction card. Everything here is drawn on one 24×24 grid
// with the same 2 px stroke, rounded caps and a single accent colour inherited
// from `currentColor`, so the turn list and the two round buttons in the
// navigation bar share one visual language.

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
