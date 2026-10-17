// Rendering for Home, Refuel, Insights and Garage. Plain functions that read the
// store and write specific nodes — no virtual DOM, no surprises.
import { bus } from './bus.js';
import {
  state, activeVehicle, setActiveVehicle, addLog, removeLog, removeVehicle,
  updateVehicle, setOctane, exportCsv, saveNow,
} from './store.js';
import {
  $, $$, esc, toast, money, rupees, km, dateShort, todayISO, haptic, openSheet,
} from './ui.js';
import { vehicleStats, scenarioRange, gradeCosts, formatKmpl } from './stats.js';
import { uiIcon } from './navicons.js';
import { openVehicleSheet, openOdometerSheet, openPricesSheet, openChainSheet } from './sheets.js';
import { PRICES_VERIFIED } from './places.js';
import { priceSourceLabel, refreshFuelPrices } from './prices.js';

/* ------------------------------------------------------------------ home */

export function renderHome() {
  const veh = activeVehicle();
  const stats = vehicleStats(veh);

  const strip = $('#vehStrip');
  if (strip) {
    strip.innerHTML = '';
    for (const v of state.vehicles) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `veh-chip ${v.id === state.activeVehicleId ? 'active' : ''}`;
      b.innerHTML = `<span>${uiIcon(v.type === 'Car' ? 'car' : 'bike')}</span><span>${esc(v.name)}</span>`;
      b.addEventListener('click', () => {
        setActiveVehicle(v.id);
        haptic(6);
        bus.emit('vehicles:changed');
      });
      strip.append(b);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'veh-chip';
    add.textContent = '＋ Add';
    add.addEventListener('click', () => openVehicleSheet());
    strip.append(add);
  }

  if (!veh) {
    $('#heroName').textContent = 'Add your first vehicle';
    $('#heroOdo').textContent = '0 km';
    $('#heroKmpl').textContent = '--';
    $('#heroRange').textContent = '-- km';
    $('#heroCost').textContent = '--';
    $('#heroOctane').textContent = `${state.octane} oct`;
    $('#heroAlt').textContent = state.altitude != null ? `${state.altitude} m` : '— m';
    $('#heroLogged').textContent = '0 km';
    $('#heroSpent').textContent = '₹0';
    $('#heroFills').textContent = '0';
    const chip = $('#heroKmplSource');
    if (chip) { chip.textContent = 'estimate'; chip.className = 'src-chip'; }
    $('#tileFuelSub').textContent = `₹${Math.round(state.region.prices[state.octane])}/L`;
    $('#tileChainSub').textContent = 'Set up';
    $('#tileRadarSub').textContent = 'Live map';
    return;
  }

  $('#heroThumb').innerHTML = veh.photo
    ? `<img src="${veh.photo}" alt="">`
    : uiIcon(veh.type === 'Car' ? 'car' : 'bike');
  $('#heroName').textContent = veh.name;
  $('#heroOdo').textContent = km(veh.odo);
  $('#heroKmpl').textContent = formatKmpl(stats.kmpl);
  $('#heroRange').textContent = `${Math.round(stats.range)} km`;
  $('#heroCost').textContent = `${rupees(stats.costPerKm)}/km`;
  $('#heroOctane').textContent = `${state.octane} oct`;
  $('#heroAlt').textContent = state.altitude != null ? `${state.altitude} m` : '— m';
  $('#heroLogged').textContent = km(stats.loggedKm);
  $('#heroSpent').textContent = money(stats.spent);
  $('#heroFills').textContent = String(stats.fills);

  const srcChip = $('#heroKmplSource');
  if (srcChip) {
    srcChip.textContent = stats.measured ? 'measured' : 'estimate';
    srcChip.className = `src-chip ${stats.measured ? 'good' : ''}`;
  }

  $('#tileFuelSub').textContent = `₹${Math.round(state.region.prices[state.octane])}/L`;
  $('#tileRadarSub').textContent = 'Live map';
  $('#tileChainSub').textContent = stats.lubeDue === 0 ? 'Service due' : `${stats.lubeDue} km`;

  renderOctaneGrid($('#octGrid'), (grade) => {
    setOctane(grade);
    renderHome();
    renderRefuel();
  });

  const foot = $('#priceFoot');
  if (foot) {
    const live = state.region.live && !state.region.custom;
    foot.innerHTML = `
      <div class="price-foot-row">
        <span>${esc(state.region.city)}, ${esc(state.region.state)} · ${esc(priceSourceLabel())}</span>
        <span class="price-foot-actions">
          <button class="link-btn" id="priceRefreshBtn" type="button">Refresh</button>
          <button class="link-btn" id="priceEditBtn" type="button">Correct rates</button>
        </span>
      </div>
      <div class="fine">${live
        ? 'Today\'s district rate, updated every morning. Individual pumps can differ by a few paise — correct it if your board disagrees.'
        : `Retail petrol is revised daily and varies by pump. Showing the verified baseline of ${esc(state.region.verified || PRICES_VERIFIED)}.`}</div>`;
    $('#priceEditBtn')?.addEventListener('click', openPricesSheet);
    $('#priceRefreshBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (state.region.custom) return toast('Custom rates in use — edit or reset them in Correct rates', { type: 'warn' });
      btn.disabled = true;
      btn.textContent = 'Checking…';
      const row = await refreshFuelPrices({ force: true });
      toast(row ? `Updated for ${row.name}` : 'Price feed unreachable — keeping current rates', {
        icon: row ? 'fuel' : 'dish',
        type: row ? 'ok' : 'warn',
      });
      renderRefuel();
    });
  }

  const regionLabel = $('#priceRegion');
  if (regionLabel) regionLabel.textContent = `${state.region.city}, ${state.region.state}`;
}

function renderOctaneGrid(host, onPick) {
  if (!host) return;
  host.innerHTML = '';
  const labels = { 91: 'Regular', 95: 'Premium', 100: 'Pro' };
  for (const grade of [91, 95, 100]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `oct ${state.octane === grade ? 'active' : ''}`;
    b.innerHTML = `<b>${grade}</b><small>${labels[grade]}</small><span>₹${(state.region.prices[grade] || 0).toFixed(2)}</span>`;
    b.addEventListener('click', () => {
      haptic(6);
      onPick(grade);
    });
    host.append(b);
  }
}

/* ------------------------------------------------------------------ refuel */

export function initRefuel() {
  const odo = $('#refuelOdo');
  const amount = $('#refuelAmount');
  const full = $('#refuelFull');
  const scenario = $('#refuelScenario');
  const date = $('#refuelDate');

  if (date && !date.value) date.value = todayISO();

  odo?.addEventListener('input', recalcRefuel);
  amount?.addEventListener('input', recalcRefuel);
  full?.addEventListener('change', recalcRefuel);
  scenario?.addEventListener('change', recalcRefuel);

  $$('.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.preset').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.amt === 'custom') {
        amount.value = '';
        amount.focus();
      } else {
        amount.value = btn.dataset.amt;
      }
      recalcRefuel();
    });
  });

  $('#refuelVehSelect')?.addEventListener('change', (e) => {
    setActiveVehicle(e.target.value);
    bus.emit('vehicles:changed');
  });

  $('#refuelSaveBtn')?.addEventListener('click', saveRefuel);
}

export function renderRefuel() {
  const veh = activeVehicle();
  if (!veh) return;
  const select = $('#refuelVehSelect');
  if (select) {
    select.innerHTML = state.vehicles.map((v) => (
      `<option value="${esc(v.id)}" ${v.id === state.activeVehicleId ? 'selected' : ''}>${v.type} · ${esc(v.name)}</option>`
    )).join('');
  }

  const stats = vehicleStats(veh);
  $('#refuelLastOdo').textContent = km(veh.odo);
  $('#refuelKmpl').textContent = `${formatKmpl(stats.kmpl)} km/L`;
  $('#refuelCount').textContent = `${stats.fills} log${stats.fills === 1 ? '' : 's'}`;

  renderOctaneGrid($('#refuelOctGrid'), (grade) => {
    setOctane(grade);
    renderHome();
    renderRefuel();
  });

  const list = $('#refuelHistory');
  if (!list) return;
  const logs = state.logs
    .filter((l) => l.vehicleId === veh.id)
    .sort((a, b) => b.odo - a.odo);

  if (!logs.length) {
    list.innerHTML = `<div class="empty">No fill-ups for ${esc(veh.name)} yet.<br>Log one above — your real mileage starts with the second full tank.</div>`;
    return;
  }

  list.innerHTML = '';
  for (const log of logs) {
    const lit = log.litres || 0;
    const kmpl = lit > 0 && log.fullTank ? log.dist / lit : null;
    const row = document.createElement('div');
    row.className = 'row-item';
    row.innerHTML = `
      <div class="li-main">
        <div class="li-t">${money(log.amount)} · ${log.octane} oct · ${lit.toFixed(2)} L</div>
        <div class="li-s">${dateShort(log.date)} · ODO ${km(log.odo)} · +${km(log.dist)}${log.fullTank ? '' : ' · partial'}</div>
      </div>
      <div class="li-v ${kmpl && kmpl >= 10 ? 'green' : ''}">
        ${kmpl ? `${kmpl.toFixed(1)}<small> km/L</small>` : '<small class="muted">partial</small>'}
      </div>
      <button class="li-del" type="button" aria-label="Delete fill-up">✕</button>`;

    row.querySelector('.li-del').addEventListener('click', () => {
      removeLog(log.id);
      toast('Fill-up removed');
      bus.emit('logs:changed');
      renderAll();
    });
    list.append(row);
  }

  recalcRefuel();
}

function recalcRefuel() {
  const veh = activeVehicle();
  if (!veh) return;
  const odoEl = $('#refuelOdo');
  const amountEl = $('#refuelAmount');
  const fullEl = $('#refuelFull');
  const deltaEl = $('#refuelDelta');
  const litresEl = $('#refuelLitres');

  const rate = state.region.prices[state.octane] || 0;
  const amount = Number(amountEl?.value) || 0;
  const litres = rate > 0 ? amount / rate : 0;

  if (litresEl) litresEl.textContent = `${litres.toFixed(2)} L at ₹${rate.toFixed(2)}/L`;

  const raw = (odoEl?.value || '').trim();
  if (!raw) {
    if (deltaEl) { deltaEl.textContent = `Last ODO ${km(veh.odo)}`; deltaEl.style.color = ''; }
    return;
  }
  const next = Number(raw);
  const dist = next - veh.odo;

  if (!Number.isFinite(next) || dist <= 0) {
    if (deltaEl) { deltaEl.textContent = `Must be more than ${km(veh.odo)}`; deltaEl.style.color = 'var(--amber)'; }
    return;
  }
  if (deltaEl) { deltaEl.textContent = `+${km(dist)} ridden`; deltaEl.style.color = 'var(--accent)'; }

  if (fullEl?.value === 'partial') return;
  if (litres > 0.1) {
    const kmpl = dist / litres;
    if (kmpl > 120 || kmpl < 6) {
      if (deltaEl) {
        deltaEl.textContent = `${kmpl.toFixed(0)} km/L looks implausible — check the amount or odometer`;
        deltaEl.style.color = 'var(--amber)';
      }
    }
  }
}

function saveRefuel() {
  const veh = activeVehicle();
  if (!veh) return openVehicleSheet();

  const odo = Number($('#refuelOdo')?.value);
  const amount = Number($('#refuelAmount')?.value);
  const fullTank = $('#refuelFull')?.value !== 'partial';
  const scenario = $('#refuelScenario')?.value || 'City commute';
  const date = $('#refuelDate')?.value || todayISO();

  if (!Number.isFinite(odo) || odo <= veh.odo) {
    toast(`Odometer must be more than ${km(veh.odo)}`, { type: 'warn' });
    $('#refuelOdo')?.focus();
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    toast('Enter how much you paid', { type: 'warn' });
    $('#refuelAmount')?.focus();
    return;
  }

  const price = state.region.prices[state.octane] || 0;
  if (!price) {
    toast('Set a fuel rate first', { type: 'warn' });
    return openPricesSheet();
  }

  const litres = amount / price;
  const dist = odo - veh.odo;
  const kmpl = litres > 0 ? dist / litres : 0;
  const suspect = kmpl > 150 || kmpl < 3;

  addLog({
    id: `l_${Date.now().toString(36)}`,
    vehicleId: veh.id,
    date,
    odo,
    dist,
    amount,
    litres,
    pricePerL: price,
    octane: state.octane,
    scenario,
    fullTank,
    alt: state.altitude,
    suspect,
    createdAt: Date.now(),
  });

  updateVehicle(veh.id, { odo });

  if ($('#refuelOdo')) $('#refuelOdo').value = '';
  if ($('#refuelDate')) $('#refuelDate').value = todayISO();

  if (suspect) {
    toast('Saved, but that mileage looks off — it is excluded from your average', { type: 'warn', icon: 'warn', ms: 5000 });
  } else if (fullTank && kmpl > 0) {
    toast(`Saved · ${kmpl.toFixed(1)} km/L on this tank`, { icon: 'fuel' });
  } else {
    toast('Saved · mileage will be measured at your next full tank', { icon: 'fuel' });
  }

  haptic([8, 30, 8]);
  bus.emit('logs:changed');
  renderAll();
}

/* ------------------------------------------------------------------ insights */

export function renderInsights() {
  const veh = activeVehicle();
  if (!veh) return;
  const stats = vehicleStats(veh);

  // --- trend -------------------------------------------------------------
  const host = $('#trendChart');
  if (host) {
    const series = stats.windows.slice(-6);
    if (series.length < 2) {
      host.innerHTML = `<div class="empty">Two full tanks are enough to draw this curve.<br>You have ${series.length}. Keep logging.</div>`;
    } else {
      host.innerHTML = buildChart(series, stats.kmpl);
    }
  }

  // --- cost per km -------------------------------------------------------
  const costHost = $('#costList');
  if (costHost) {
    const costs = gradeCosts(veh);
    costHost.innerHTML = '';
    for (const c of costs) {
      const row = document.createElement('div');
      row.className = `cost-row ${c.grade === state.octane ? 'active' : ''}`;
      row.innerHTML = `
        <div><b>${c.grade} octane</b><div class="li-s">${rupees(c.price)}/L${c.available ? '' : ' · rare'}</div></div>
        <div class="right"><b>${rupees(c.costPerKm)}</b>/km</div>`;
      costHost.append(row);
    }
    const note = document.createElement('p');
    note.className = 'fine';
    note.textContent = `Uses your measured ${formatKmpl(stats.kmpl)} km/L for every grade. Higher octane does not add mileage on its own — only buy it if your bike's manual asks for it.`;
    costHost.append(note);
  }

  // --- range by ride type -------------------------------------------------
  const rangeHost = $('#rangeList');
  if (rangeHost) {
    const rows = scenarioRange(veh);
    rangeHost.innerHTML = '';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'cost-row';
      row.innerHTML = `
        <div><b>${esc(r.name)}</b><div class="li-s">${formatKmpl(r.kmpl)} km/L ${r.measured ? `· from ${r.samples} of your logs` : '· typical estimate'}</div></div>
        <div class="right"><b>${r.range} km</b></div>`;
      rangeHost.append(row);
    }
    const note = document.createElement('p');
    note.className = 'fine';
    note.textContent = 'Tag each fill-up with the ride type and these become your own measurements instead of a model.';
    rangeHost.append(note);
  }
}

function buildChart(series, avg) {
  const w = 340;
  const h = 160;
  const padL = 30;
  const padR = 10;
  const padT = 14;
  const padB = 26;
  const values = series.map((s) => s.kmpl);
  const min = Math.max(0, Math.min(...values) * 0.85);
  const max = Math.max(...values) * 1.1;
  const span = Math.max(1, max - min);
  const x = (i) => padL + (i * (w - padL - padR)) / Math.max(1, series.length - 1);
  const y = (v) => padT + (1 - (v - min) / span) * (h - padT - padB);

  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.kmpl).toFixed(1)}`).join(' ');
  const area = `${padL},${h - padB} ${pts} ${x(series.length - 1).toFixed(1)},${h - padB}`;
  const avgY = y(avg);

  const dots = series.map((s, i) => `
    <circle cx="${x(i).toFixed(1)}" cy="${y(s.kmpl).toFixed(1)}" r="4" fill="var(--bg-elev)" stroke="var(--accent)" stroke-width="2.5"/>
    <text x="${x(i).toFixed(1)}" y="${(y(s.kmpl) - 9).toFixed(1)}" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="800">${s.kmpl.toFixed(1)}</text>
    <text x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="middle" fill="var(--text-3)" font-size="9">${dateShort(s.date)}</text>
  `).join('');

  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Mileage trend">
    <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--line)" stroke-width="1"/>
    <line x1="${padL}" y1="${avgY.toFixed(1)}" x2="${w - padR}" y2="${avgY.toFixed(1)}" stroke="var(--text-3)" stroke-dasharray="3 4" stroke-width="1" opacity="0.6"/>
    <text x="${padL + 3}" y="${(avgY - 5).toFixed(1)}" fill="var(--text-3)" font-size="9" font-weight="700">avg ${avg.toFixed(1)}</text>
    <polygon points="${area}" fill="url(#ag)"/>
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

/* ------------------------------------------------------------------ garage */

export function renderGarage() {
  const list = $('#garageList');
  if (!list) return;
  list.innerHTML = '';

  if (!state.vehicles.length) {
    list.innerHTML = '<div class="empty">No vehicles yet.</div>';
  }

  for (const v of state.vehicles) {
    const stats = vehicleStats(v);
    const active = v.id === state.activeVehicleId;
    const row = document.createElement('div');
    row.className = `row-item veh-row ${active ? 'active' : ''}`;
    row.innerHTML = `
      <div class="veh-avatar">${v.photo ? `<img src="${v.photo}" alt="" loading="lazy" decoding="async">` : uiIcon(v.type === 'Car' ? 'car' : 'bike')}</div>
      <div class="li-main">
        <div class="li-t">${esc(v.name)} ${active ? '<span class="tag">active</span>' : ''}</div>
        <div class="li-s">${v.type} · ${formatKmpl(stats.kmpl)} km/L ${stats.measured ? '(measured)' : '(estimate)'} · ODO ${km(v.odo)}</div>
      </div>
      <div class="row gap6">
        <button class="icon-btn sm" type="button" data-act="edit" aria-label="Edit">✎</button>
        <button class="icon-btn sm" type="button" data-act="select" aria-label="Select">${active ? '✓' : '○'}</button>
        <button class="icon-btn sm danger" type="button" data-act="delete" aria-label="Delete">✕</button>
      </div>`;

    row.querySelector('[data-act="edit"]').addEventListener('click', () => openVehicleSheet(v.id));
    row.querySelector('[data-act="select"]').addEventListener('click', () => {
      setActiveVehicle(v.id);
      bus.emit('vehicles:changed');
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', () => {
      if (state.vehicles.length <= 1) return toast('Keep at least one vehicle', { type: 'warn' });
      openSheet({
        title: `Delete ${v.name}?`,
        html: `<p class="hint">This removes the vehicle and all ${state.logs.filter((l) => l.vehicleId === v.id).length} fill-ups attached to it. It cannot be undone.</p>
          <div class="sheet-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn danger" type="button" id="confirmDel">Delete</button></div>`,
        mount(body) {
          body.querySelector('#confirmDel').addEventListener('click', () => {
            removeVehicle(v.id);
            $('#sheetClose')?.click();
            toast('Vehicle deleted');
            renderAll();
          });
        },
      });
    });
    list.append(row);
  }

  const nameInput = $('#profName');
  const phoneInput = $('#profPhone');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = state.user.name || '';
  if (phoneInput && document.activeElement !== phoneInput) phoneInput.value = state.user.phone || '';

  const motionSelect = $('#profMotion');
  if (motionSelect) motionSelect.value = state.motion || 'auto';

  const buildTag = $('#buildTag');
  if (buildTag) buildTag.textContent = `v${state.version} · ${new Date().getFullYear()}`;
}

/* ------------------------------------------------------------------ misc */

export function initGarage() {
  $('#addVehBtn')?.addEventListener('click', () => openVehicleSheet());
  $('#tileAddVeh')?.addEventListener('click', () => openVehicleSheet());
  $('#tileChain')?.addEventListener('click', () => openChainSheet());
  $('#heroVehBtn')?.addEventListener('click', () => openVehicleSheet(activeVehicle()?.id));
  $('#heroOdoBtn')?.addEventListener('click', openOdometerSheet);

  $('#profSaveBtn')?.addEventListener('click', () => {
    bus.emit('profile:save', {
      name: ($('#profName')?.value || '').trim(),
      phone: ($('#profPhone')?.value || '').trim(),
      theme: undefined,
    });
    saveNow();
    toast('Profile saved');
    renderGarage();
  });

  $('#logoutBtn')?.addEventListener('click', () => {
    openSheet({
      title: 'Sign out?',
      html: '<p class="hint">Your vehicles and fill-ups stay on this device. Signing out only hides your profile name.</p><div class="sheet-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn danger" type="button" id="confirmOut">Sign out</button></div>',
      mount(body) {
        body.querySelector('#confirmOut').addEventListener('click', () => {
          $('#sheetClose')?.click();
          bus.emit('profile:signout');
        });
      },
    });
  });

  $('#exportBtn')?.addEventListener('click', () => {
    const csv = exportCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `apexmile-log-${todayISO()}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('CSV exported');
  });

  $('#profMotion')?.addEventListener('change', (e) => {
    state.motion = e.target.value;
    saveNow();
    bus.emit('motion:changed', state.motion);
  });

  $('#priceAutoBtn')?.addEventListener('click', () => bus.emit('region:detect'));
}

export function renderAll() {
  renderHome();
  renderRefuel();
  renderGarage();
  renderInsights();
}
