// Local-first persistence. Everything the rider owns lives on this device.
// One versioned key, a migration path from the original prototype, and a
// photos-stripped retry if we ever hit the storage quota.
import { bus } from './bus.js';

const KEY = 'apexmile.v11';
const PREV_KEY = 'apexmile.v10'; // imported once, then left untouched
const LEGACY_KEY = 'apexmile_map_radar_v9';

export const FUEL_REGION_DEFAULT = {
  key: 'bengaluru_ka',
  city: 'Bengaluru',
  state: 'Karnataka',
  lat: 12.9716,
  lng: 77.5946,
  prices: { 91: 111.68, 95: 118.4, 100: 160.0 },
  verified: '2026-10-17',
  custom: false,
  // True once a daily feed has replaced the baseline rates above.
  live: false,
  fetchedAt: '',
  source: '',
};

function fresh() {
  return {
    version: 11,
    user: { name: '', phone: '' },
    signedIn: false,
    theme: 'auto',
    motion: 'auto',
    // Persisted so a rider who mutes navigation stays muted after signing in
    // again. The nav bar toggle and the Garage switch share this one value.
    navVoice: true,
    // Optional custom MQTT WebSocket endpoint (advanced). Empty = auto failover.
    broker: '',
    // Free TomTom key for the live-traffic overlay. Stored locally, never in
    // the repo; empty means the layer stays unavailable until it is added.
    trafficKey: '',
    trafficOn: false,
    // Satellite is the only manual basemap choice left; remember it.
    mapSatellite: false,
    tripMode: 'bike',
    tripModeSet: false,
    vehicles: [],
    activeVehicleId: '',
    logs: [], // newest first
    region: { ...FUEL_REGION_DEFAULT },
    octane: 95,
    lastPos: null, // {lat,lng,acc,ts}
    altitude: null,
    createdAt: null,
    lastBackupAt: null,
  };
}

export const state = fresh();

/* ------------------------------------------------------------------ load */

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
    if (!raw) {
      const prev = localStorage.getItem(PREV_KEY);
      if (prev) {
        raw = prev;
        // Carry the old record forward so the rider never re-enters anything.
        localStorage.setItem(KEY, prev);
        localStorage.removeItem(PREV_KEY);
      }
    }
  } catch { /* private mode */ }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        Object.assign(state, fresh(), parsed);
        state.version = 11;
        state.region = { ...FUEL_REGION_DEFAULT, ...(parsed.region || {}) };
        state.region.prices = { ...FUEL_REGION_DEFAULT.prices, ...(parsed.region?.prices || {}) };
        state.navVoice = parsed.navVoice !== false;
        state.trafficKey = typeof parsed.trafficKey === 'string' ? parsed.trafficKey.trim() : '';
        state.trafficOn = Boolean(parsed.trafficOn && state.trafficKey);
        state.mapSatellite = Boolean(parsed.mapSatellite);
        state.tripMode = parsed.tripMode === 'car' || parsed.tripMode === 'walk' ? parsed.tripMode : 'bike';
        state.tripModeSet = Boolean(parsed.tripModeSet);
        state.vehicles = Array.isArray(parsed.vehicles) ? parsed.vehicles : [];
        state.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
        if (!state.activeVehicleId && state.vehicles[0]) state.activeVehicleId = state.vehicles[0].id;
      }
    } catch (err) {
      console.warn('[store] corrupt state, starting fresh', err);
    }
    return;
  }

  // One-time import from the v9 prototype (different storage shape).
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return;
    const old = JSON.parse(legacy);
    const imported = migrateLegacy(old);
    if (imported) {
      Object.assign(state, imported);
      console.info('[store] imported data from the v9 prototype');
    }
  } catch (err) {
    console.warn('[store] legacy import skipped', err);
  }
}

function migrateLegacy(old) {
  if (!old || typeof old !== 'object') return null;
  const vehicles = (Array.isArray(old.vehicles) ? old.vehicles : []).map((v, i) => ({
    id: v.id || `v_${Date.now()}_${i}`,
    type: v.type === 'Car' ? 'Car' : 'Bike',
    name: v.name || 'My vehicle',
    odo: Number(v.lastOdo) || 0,
    kmplBaseline: Number(v.kmpl) || (v.type === 'Car' ? 13.5 : 30),
    tank: Number(v.tank) || 13,
    reserve: Number(v.reserve) || 2.5,
    octane: Number(v.prefOctane) || 95,
    photo: v.photo || null,
    lubeOdo: Number(v.lastLubeOdo) || Number(v.lastOdo) || 0,
    createdAt: Date.now(),
  }));

  const logs = (Array.isArray(old.logs) ? old.logs : []).map((l, i) => ({
    id: l.id || `l_mig_${i}`,
    vehicleId: l.vehicleId || vehicles[0]?.id || '',
    date: l.date || new Date().toISOString().slice(0, 10),
    odo: Number(l.odo) || 0,
    dist: Number(l.dist) || 0,
    amount: Number(l.amount) || 0,
    litres: Number(l.litres) || 0,
    pricePerL: l.litres ? Number(l.amount) / Number(l.litres) : 0,
    octane: Number(l.octane) || 95,
    scenario: l.scenario || 'Highway cruise',
    fullTank: true,
    imported: true,
    createdAt: Date.now() - i * 1000,
  }));

  if (!vehicles.length) return null;

  return {
    version: 11,
    user: {
      name: (old.user?.name || '').slice(0, 40),
      phone: (old.user?.contact || old.user?.phone || '').slice(0, 24),
    },
    signedIn: Boolean(old.isLoggedIn && old.user?.name),
    theme: old.themeMode === 'dark' ? 'dark' : old.themeMode === 'light' ? 'light' : 'auto',
    vehicles,
    activeVehicleId: old.activeVehicleId && vehicles.some((v) => v.id === old.activeVehicleId)
      ? old.activeVehicleId
      : vehicles[0].id,
    logs: logs.sort((a, b) => b.odo - a.odo),
    region: old.customPriceOverride && old.prices
      ? { ...FUEL_REGION_DEFAULT, prices: { ...FUEL_REGION_DEFAULT.prices, ...old.prices }, custom: true }
      : { ...FUEL_REGION_DEFAULT },
    octane: Number(old.selectedOctane) || 95,
    createdAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ save */

let saveTimer = null;
let warnedQuota = false;

export function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}

export function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const payload = JSON.stringify(state);
  try {
    localStorage.setItem(KEY, payload);
  } catch {
    // Almost always the quota. Photos are the only large thing we keep, so drop
    // them (the vehicle stays, only the picture is lost) and try once more.
    try {
      const slim = {
        ...state,
        vehicles: state.vehicles.map((v) => (v.photo ? { ...v, photo: null } : v)),
        logs: state.logs.map((l) => (l.photo ? { ...l, photo: null } : l)),
      };
      localStorage.setItem(KEY, JSON.stringify(slim));
      if (!warnedQuota) {
        warnedQuota = true;
        bus.emit('store:quota', {
          message: 'Storage is full — vehicle photos were cleared to keep your logs safe.',
        });
      }
    } catch (err2) {
      console.error('[store] save failed', err2);
      if (!warnedQuota) {
        warnedQuota = true;
        bus.emit('store:quota', {
          message: 'This browser will not let ApexMile save. Data will be lost when you close the tab.',
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ api */

export function setUser(patch) {
  state.user = { ...state.user, ...patch };
  save();
}

export function activeVehicle() {
  if (!state.vehicles.length) return null;
  return state.vehicles.find((v) => v.id === state.activeVehicleId) || state.vehicles[0];
}

export function setActiveVehicle(id) {
  if (!state.vehicles.some((v) => v.id === id)) return null;
  state.activeVehicleId = id;
  const veh = activeVehicle();
  if (veh?.octane) state.octane = veh.octane;
  save();
  return veh;
}

export function addVehicle(veh) {
  const record = {
    id: `v_${Date.now().toString(36)}`,
    type: 'Bike',
    name: 'My vehicle',
    odo: 0,
    kmplBaseline: 30,
    tank: 13,
    reserve: 2.5,
    octane: 95,
    photo: null,
    lubeOdo: 0,
    createdAt: Date.now(),
    ...veh,
  };
  // A fresh vehicle starts its service interval today, not at zero kilometres.
  if (veh?.lubeOdo == null) record.lubeOdo = Number(record.odo) || 0;
  state.vehicles.push(record);
  state.activeVehicleId = record.id;
  state.octane = record.octane || 95;
  save();
  return record;
}

export function updateVehicle(id, patch) {
  const veh = state.vehicles.find((v) => v.id === id);
  if (!veh) return null;
  Object.assign(veh, patch);
  if (id === state.activeVehicleId && patch.octane) state.octane = patch.octane;
  save();
  return veh;
}

export function removeVehicle(id) {
  if (state.vehicles.length <= 1) return false;
  state.vehicles = state.vehicles.filter((v) => v.id !== id);
  state.logs = state.logs.filter((l) => l.vehicleId !== id);
  if (state.activeVehicleId === id) state.activeVehicleId = state.vehicles[0].id;
  save();
  return true;
}

export function logsFor(vehicleId, limit = Infinity) {
  return state.logs
    .filter((l) => !vehicleId || l.vehicleId === vehicleId)
    .sort((a, b) => b.odo - a.odo || b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function addLog(log) {
  state.logs.unshift(log);
  save();
}

export function removeLog(id) {
  state.logs = state.logs.filter((l) => l.id !== id);
  save();
}

export function setRegion(region) {
  state.region = {
    ...state.region,
    ...region,
    prices: { ...state.region.prices, ...(region.prices || {}) },
  };
  save();
}

export function setOctane(grade) {
  state.octane = Number(grade) || 95;
  const veh = activeVehicle();
  if (veh) veh.octane = state.octane;
  save();
}

export function exportCsv() {
  const head = 'date,vehicle,odometer_km,distance_km,amount_inr,litres,price_per_l,octane,kmpl,ride_type,full_tank';
  const rows = state.logs
    .slice()
    .sort((a, b) => a.odo - b.odo)
    .map((l) => {
      const veh = state.vehicles.find((v) => v.id === l.vehicleId);
      return [
        l.date,
        csvCell(veh?.name || ''),
        l.odo,
        l.dist,
        l.amount,
        l.litres?.toFixed(2),
        l.pricePerL?.toFixed(2),
        l.octane,
        l.fullTank && l.dist && l.litres ? (l.dist / l.litres).toFixed(2) : '',
        csvCell(l.scenario || ''),
        l.fullTank ? 'yes' : 'no',
      ].join(',');
    });
  return [head, ...rows].join('\n');
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

load();
