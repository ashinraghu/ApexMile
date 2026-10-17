// Daily fuel prices.
//
// Pump-level "live" prices are not published as open data in India. What is
// published — and what this app uses — is the daily district rate that the oil
// marketing companies set each morning. The Core's India Fuel Watch republishes
// that as one JSON feed (source: Goodreturns, updated daily).
//
// The same-origin /api/fuel-prices route is served by the tiny Cloudflare
// Worker in worker.js, which also avoids any CORS question. If that route is
// not deployed (for example on Cloudflare Pages), we try the feed directly and
// keep the verified baseline when both fail.
import { bus } from './bus.js';
import { state, setRegion } from './store.js';

const FEEDS = [
  '/api/fuel-prices',
  'https://energy.thecore.in/api/india-state-prices',
];
const FRESH_MS = 18 * 60 * 60 * 1000;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// The feed publishes the older English spellings for several cities; riders
// type the current ones. One table, both directions.
const ALIASES = {
  bengaluru: 'bangalore', bangalore: 'bengaluru',
  mysuru: 'mysore', mysore: 'mysuru',
  mangaluru: 'mangalore', mangalore: 'mangaluru',
  hubballi: 'hubli', hubli: 'hubballi',
  belagavi: 'belgaum', belgaum: 'belagavi',
  kalaburagi: 'gulbarga', gulbarga: 'kalaburagi',
  shivamogga: 'shimoga', shimoga: 'shivamogga',
  tumakuru: 'tumkur', tumkur: 'tumakuru',
  vijayapura: 'bijapur', bijapur: 'vijayapura',
  ballari: 'bellary', bellary: 'ballari',
  gurugram: 'gurgaon', gurgaon: 'gurugram',
  kochi: 'cochin', cochin: 'kochi',
  thiruvananthapuram: 'trivandrum', trivandrum: 'thiruvananthapuram',
  vadodara: 'baroda', baroda: 'vadodara',
  varanasi: 'banaras', banaras: 'varanasi',
  prayagraj: 'allahabad', allahabad: 'prayagraj',
  mumbai: 'bombay', bombay: 'mumbai',
  kolkata: 'calcutta', calcutta: 'kolkata',
  chennai: 'madras', madras: 'chennai',
};

const sameCity = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  if (ALIASES[a] === b || ALIASES[b] === a) return true;
  return a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a));
};

export function pricesAreFresh() {
  if (!state.region.live) return false;
  const t = Date.parse(state.region.fetchedAt || '');
  return Number.isFinite(t) && Date.now() - t < FRESH_MS;
}

function pickRow(data, city, stateName) {
  if (!data || typeof data !== 'object') return null;
  const wantedCity = norm(city);
  const wantedState = norm(stateName);
  const cities = Array.isArray(data.allCities) ? data.allCities
    : Array.isArray(data.cities) ? data.cities : [];

  let row = null;
  if (wantedCity) {
    row = cities.find((r) => sameCity(norm(r.name), wantedCity));
  }
  if (!row) {
    // No district match: the state figure is the honest fallback (it is what
    // the feed publishes for the whole state, not a random district).
    const states = data.states && typeof data.states === 'object' ? Object.values(data.states) : [];
    row = states.find((r) => norm(r.name) === wantedState);
  }
  if (!row && wantedState) {
    row = cities.find((r) => norm(r.state) === wantedState);
  }
  if (!row) return null;

  const petrol = Number(row.petrol);
  if (!(petrol > 40 && petrol < 250)) return null;

  return {
    petrol,
    diesel: Number(row.diesel) || null,
    name: row.name || city || stateName,
    state: row.state || stateName || '',
    source: data.source ? String(data.source).split('(')[0].trim() : 'daily district feed',
    updatedAt: data.fetchedAt || new Date().toISOString(),
  };
}

function applyPrices(row) {
  const current = state.region.prices || {};
  const base91 = Number(current[91]) || row.petrol;
  // Keep the grade spread the rider already sees (95 and 100 carry a premium
  // over 91); only the base rate is replaced by the fresh district price.
  const off95 = Number.isFinite(Number(current[95])) ? Number(current[95]) - base91 : 6.72;
  const off100 = Number.isFinite(Number(current[100])) ? Number(current[100]) - base91 : 48.32;

  setRegion({
    prices: {
      91: row.petrol,
      95: Number((row.petrol + off95).toFixed(2)),
      100: Number((row.petrol + off100).toFixed(2)),
    },
    verified: String(row.updatedAt).slice(0, 10),
    fetchedAt: row.updatedAt,
    source: row.source,
    live: true,
    custom: false,
  });
  bus.emit('prices:changed');
}

/**
 * Fetch today's district rate. Returns the applied row, or null when every
 * source is unreachable (the UI then keeps the verified baseline).
 */
export async function refreshFuelPrices({ force = false } = {}) {
  if (!force && pricesAreFresh()) return null;
  // Manual rates always win: a rider who corrected the pump board should not
  // have that correction overwritten on the next launch.
  if (state.region.custom) return null;

  const city = state.region.city || '';
  const stateName = state.region.state || '';

  for (const url of FEEDS) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const data = await res.json();
      const row = pickRow(data, city, stateName);
      if (!row) continue;
      applyPrices(row);
      return row;
    } catch {
      // Try the next source; the baseline stays in place meanwhile.
    }
  }
  return null;
}

export function priceSourceLabel() {
  const r = state.region;
  if (r.custom) return 'Custom rates';
  if (r.live && r.fetchedAt) {
    const when = new Date(r.fetchedAt);
    const today = new Date().toDateString() === when.toDateString();
    // The feed is a daily district rate, not a pump-level ticker. Say "today",
    // never "live", so the label matches what actually arrived.
    return today
      ? `Today · ${when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
      : `Rate · ${when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  }
  return 'Verified baseline';
}
