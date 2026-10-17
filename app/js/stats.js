// Mileage maths, done the way a rider actually checks it: full-tank to full-tank.
// Partial fills are recorded but never used to claim a km/L figure.
import { state, logsFor, activeVehicle } from './store.js';

const MIN_KM = 20;         // a window this short is not a measurement
const MIN_L = 0.8;
const PLAUSIBLE = [4, 160]; // km/L outside this is a data-entry problem, not a bike

/** Ascending-by-odometer logs for one vehicle. */
export function ascendingLogs(vehicleId) {
  return logsFor(vehicleId).slice().sort((a, b) => a.odo - b.odo);
}

/**
 * Full-tank windows: distance ridden between two full fills, divided by the
 * litres added at the *second* full fill. This is the only method that is not
 * fooled by partial fills.
 */
export function windows(vehicleId) {
  const logs = ascendingLogs(vehicleId);
  const out = [];
  let distAcc = 0;
  let litresAcc = 0;
  let lastOdo = null;

  for (const log of logs) {
    if (lastOdo != null) distAcc += log.odo - lastOdo;
    lastOdo = log.odo;
    if (log.fullTank) {
      // The litres that mattered are the ones in this fill (they refill the tank).
      litresAcc += log.litres || 0;
      const kmpl = litresAcc > 0 ? distAcc / litresAcc : 0;
      if (distAcc >= MIN_KM && litresAcc >= MIN_L && !log.suspect && plausible(kmpl)) {
        out.push({
          km: distAcc,
          litres: litresAcc,
          kmpl,
          date: log.date,
          odo: log.odo,
          scenario: log.scenario || 'City commute',
          octane: log.octane,
          logId: log.id,
        });
      }
      distAcc = 0;
      litresAcc = 0;
    } else {
      // Partial fill: its litres still count toward the next window.
      litresAcc += log.litres || 0;
    }
  }
  return out;
}

function plausible(kmpl) {
  return kmpl >= PLAUSIBLE[0] && kmpl <= PLAUSIBLE[1];
}

/** Weighted by distance, newest first, last five windows. */
export function measuredKmpl(vehicleId) {
  const w = windows(vehicleId).slice(-5);
  if (!w.length) return null;
  const km = w.reduce((s, x) => s + x.km, 0);
  const l = w.reduce((s, x) => s + x.litres, 0);
  if (!l) return null;
  return km / l;
}

export function vehicleStats(vehicle) {
  const veh = vehicle || activeVehicle();
  if (!veh) {
    return {
      kmpl: 0, measured: false, windows: [], loggedKm: 0, spent: 0, fills: 0,
      range: 0, costPerKm: 0, lubeKm: 0, lubeDue: 0,
    };
  }
  const logs = logsFor(veh.id);
  const w = windows(veh.id);
  const measured = measuredKmpl(veh.id);
  const kmpl = measured || Number(veh.kmplBaseline) || 30;

  const loggedKm = logs.reduce((s, l) => s + (Number(l.dist) || 0), 0);
  const spent = logs.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const usable = Math.max(0.5, Number(veh.tank || 13) - Number(veh.reserve || 2.5));
  const price = state.region.prices[state.octane] || state.region.prices[95] || 110;
  const lubeInterval = veh.type === 'Car' ? 5000 : 500;
  const lubeKm = Math.max(0, Number(veh.odo || 0) - Number(veh.lubeOdo || 0));

  return {
    kmpl,
    measured: measured != null,
    baseline: Number(veh.kmplBaseline) || 30,
    windows: w,
    loggedKm,
    spent,
    fills: logs.length,
    range: usable * kmpl,
    usable,
    price,
    costPerKm: kmpl > 0 ? price / kmpl : 0,
    realCostPerKm: loggedKm > 0 ? spent / loggedKm : null,
    lubeKm,
    lubeInterval,
    lubeDue: Math.max(0, lubeInterval - lubeKm),
  };
}

/**
 * Range under different riding conditions. If the rider has tagged full-tank
 * windows with a scenario we use their own measured number; otherwise we fall
 * back to a clearly-labelled typical factor on their baseline.
 */
const SCENARIO_FACTOR = {
  'City commute': 0.9,
  'Highway cruise': 1.08,
  'Hills / ghats': 0.85,
  'Pillion + luggage': 0.9,
  'Aggressive pace': 0.8,
};

export function scenarioRange(veh) {
  const stats = vehicleStats(veh);
  const w = stats.windows;
  const out = Object.keys(SCENARIO_FACTOR).map((name) => {
    const rel = w.filter((x) => (x.scenario || 'City commute') === name);
    const km = rel.reduce((s, x) => s + x.km, 0);
    const litres = rel.reduce((s, x) => s + x.litres, 0);
    if (km > 30 && litres > 1) {
      const kmpl = km / litres;
      return { name, kmpl, range: Math.round(stats.usable * kmpl), measured: true, samples: rel.length };
    }
    const kmpl = stats.kmpl * (SCENARIO_FACTOR[name] || 1);
    return { name, kmpl, range: Math.round(stats.usable * kmpl), measured: false, samples: 0 };
  });
  return out;
}

/** Cost per km for each grade at today's district price, using measured mileage. */
export function gradeCosts(veh) {
  const stats = vehicleStats(veh);
  const grades = [91, 95, 100];
  return grades
    .map((g) => {
      const price = state.region.prices[g] || 0;
      return {
        grade: g,
        price,
        costPerKm: stats.kmpl > 0 ? price / stats.kmpl : 0,
        available: g !== 100,
      };
    })
    .sort((a, b) => a.costPerKm - b.costPerKm);
}

export function formatKmpl(n) {
  return n == null || !Number.isFinite(n) ? '--' : n.toFixed(1);
}

export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '--';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}
