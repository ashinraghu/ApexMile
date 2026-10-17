// Every bottom sheet in the app. Sheets talk to the store and emit intent on the
// bus; they never reach into the map or the network directly. That keeps them
// testable and stops circular imports.
import { bus } from './bus.js';
import {
  state, activeVehicle, addVehicle, updateVehicle, setRegion,
} from './store.js';
import {
  openSheet, closeSheet, toast, km, todayISO,
  fileToPhoto, copyText, shareInvite, esc, haptic,
} from './ui.js';
import { vehicleStats } from './stats.js';
import {
  ride, inviteUrl, endRideForAll, leaveRide, joinRide, setMyStatus, pingPeer, peerList,
  startDemoPeer, normalizeCode, SELF_ID,
} from './rooms.js';
import { journey, removeStop, moveStop, clearStops, currentRoute, estimates } from './journey.js';
import { nav } from './nav.js';
import { PRICES_VERIFIED } from './places.js';
import { localSuggest, geocode } from './routing.js';
import { geo } from './geo.js';

const tpl = (id) => document.getElementById(id)?.innerHTML || '';

/* ------------------------------------------------------------------ vehicle */

export function openVehicleSheet(vehicleId = null) {
  const existing = vehicleId ? state.vehicles.find((v) => v.id === vehicleId) : null;
  let type = existing?.type || 'Bike';

  openSheet({
    title: existing ? 'Edit vehicle' : 'Add vehicle',
    html: tpl('tpl-vehicle'),
    mount(body) {
      const form = body.querySelector('#vehForm');
      const seg = body.querySelector('#vehTypeSeg');

      const syncTypeUi = () => {
        seg.querySelectorAll('.seg-b').forEach((b) => {
          b.classList.toggle('active', b.dataset.type === type);
        });
        const tank = form.elements.tank;
        const reserve = form.elements.reserve;
        const kmpl = form.elements.kmpl;
        if (!existing) {
          if (type === 'Car') { tank.value = '40'; reserve.value = '5'; kmpl.value = '13.5'; }
          else { tank.value = '13'; reserve.value = '2.5'; kmpl.value = '30'; }
        }
      };

      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-type]');
        if (!btn) return;
        type = btn.dataset.type;
        haptic(6);
        syncTypeUi();
      });

      if (existing) {
        form.elements.name.value = existing.name || '';
        form.elements.odo.value = existing.odo ?? 0;
        form.elements.kmpl.value = existing.kmplBaseline ?? 30;
        form.elements.tank.value = existing.tank ?? 13;
        form.elements.reserve.value = existing.reserve ?? 2.5;
        form.elements.octane.value = String(existing.octane || 95);
      }
      syncTypeUi();

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const name = String(fd.get('name') || '').trim();
        const odo = Number(fd.get('odo'));
        const kmplVal = Number(fd.get('kmpl'));
        const tank = Number(fd.get('tank'));
        const reserve = Number(fd.get('reserve'));
        const octane = Number(fd.get('octane')) || 95;

        if (!name) return toast('Give the vehicle a name', { type: 'warn' });
        if (!Number.isFinite(odo) || odo < 0) return toast('Odometer must be 0 or more', { type: 'warn' });
        if (!Number.isFinite(kmplVal) || kmplVal <= 0) return toast('Mileage must be greater than 0', { type: 'warn' });
        if (!Number.isFinite(tank) || tank <= 0) return toast('Tank size must be greater than 0', { type: 'warn' });
        if (reserve >= tank) return toast('Reserve must be smaller than the tank', { type: 'warn' });

        const submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        submit.textContent = 'Saving…';

        let photo = existing?.photo || null;
        const file = form.elements.photo.files?.[0];
        if (file) {
          try { photo = await fileToPhoto(file); } catch { toast('Could not use that photo', { type: 'warn' }); }
        }

        const payload = {
          type, name, odo, kmplBaseline: kmplVal, tank, reserve, octane, photo,
        };

        if (existing) updateVehicle(existing.id, payload);
        else addVehicle(payload);

        closeSheet();
        toast(existing ? 'Vehicle updated' : `${name} added`, { icon: '🏍️' });
        bus.emit('vehicles:changed');
        return true;
      });
    },
  });
}

export function openOdometerSheet() {
  const veh = activeVehicle();
  if (!veh) return openVehicleSheet();

  openSheet({
    title: 'Odometer',
    html: tpl('tpl-odometer'),
    mount(body) {
      const form = body.querySelector('#odoForm');
      form.elements.odo.value = veh.odo ?? 0;
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const next = Number(form.elements.odo.value);
        if (!Number.isFinite(next) || next < 0) return toast('Enter a valid reading', { type: 'warn' });
        if (next < veh.odo) {
          toast('Odometer moved backwards — logs may look odd', { type: 'warn', icon: '⚠' });
        }
        updateVehicle(veh.id, { odo: next });
        closeSheet();
        toast(`Odometer set to ${km(next)}`);
        bus.emit('vehicles:changed');
        return true;
      });
    },
  });
}

/* ------------------------------------------------------------------ prices */

export function openPricesSheet() {
  openSheet({
    title: 'Fuel rates',
    html: tpl('tpl-prices'),
    mount(body) {
      const form = body.querySelector('#priceForm');
      const hint = body.querySelector('#priceHint');
      hint.textContent = `Rates for ${state.region.city}, ${state.region.state}. Captured ${state.region.verified || PRICES_VERIFIED} — check the pump board and correct anything that has drifted.`;
      form.elements.p91.value = state.region.prices[91].toFixed(2);
      form.elements.p95.value = state.region.prices[95].toFixed(2);
      form.elements.p100.value = state.region.prices[100].toFixed(2);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const p91 = Number(form.elements.p91.value);
        const p95 = Number(form.elements.p95.value);
        const p100 = Number(form.elements.p100.value);
        if (![p91, p95, p100].every((p) => Number.isFinite(p) && p > 20 && p < 400)) {
          return toast('Rates should be between ₹20 and ₹400', { type: 'warn' });
        }
        setRegion({
          prices: { 91: p91, 95: p95, 100: p100 },
          verified: todayISO(),
          custom: true,
        });
        closeSheet();
        toast('Fuel rates updated');
        bus.emit('prices:changed');
        return true;
      });
    },
  });
}

/* ------------------------------------------------------------------ chain */

export function openChainSheet() {
  const veh = activeVehicle();
  if (!veh) return openVehicleSheet();
  const stats = vehicleStats(veh);
  const pct = Math.min(100, Math.round((stats.lubeKm / stats.lubeInterval) * 100));

  openSheet({
    title: 'Chain & drivetrain',
    html: tpl('tpl-chain'),
    mount(body) {
      body.querySelector('#chainBody').textContent = stats.lubeDue === 0
        ? `${veh.name} is due for a clean and lube (${stats.lubeKm} km since the last service).`
        : `${veh.name} has done ${stats.lubeKm} km since the last service. Next clean and lube in ${stats.lubeDue} km.`;
      body.querySelector('#chainMeter').style.width = `${pct}%`;
      body.querySelector('#chainReset').addEventListener('click', () => {
        updateVehicle(veh.id, { lubeOdo: veh.odo });
        closeSheet();
        toast('Chain counter reset');
        bus.emit('vehicles:changed');
      });
    },
  });
}

/* ------------------------------------------------------------------ group ride */

export function openTripSheet() {
  openSheet({
    title: 'Start a group ride',
    html: tpl('tpl-trip'),
    mount(body) {
      const form = body.querySelector('#tripForm');
      const destField = form.elements.dest;
      if (journey.dest) destField.value = journey.dest.name;

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const trip = String(form.elements.trip.value || '').trim() || 'Group ride';
        const dest = String(destField.value || '').trim();
        closeSheet();
        bus.emit('ride:start-request', { trip, dest });
        return true;
      });
    },
  });
}

export function openJoinSheet(prefill = '') {
  openSheet({
    title: 'Join a ride',
    html: `
      <form class="form" id="joinRideForm">
        <label class="field">
          <span>Room code</span>
          <input name="code" id="joinCode" type="text" inputmode="text" autocapitalize="characters"
                 autocomplete="off" spellcheck="false" maxlength="8" placeholder="e.g. K4T9RM"
                 value="${esc(prefill)}" />
        </label>
        <p class="hint">The code is six characters. Everyone in the room sees each other's live position until they leave.</p>
        <div class="sheet-actions">
          <button type="button" class="btn ghost" data-close>Cancel</button>
          <button type="submit" class="btn primary">Join</button>
        </div>
      </form>`,
    mount(body) {
      const form = body.querySelector('#joinRideForm');
      const input = form.elements.code;
      input.addEventListener('input', () => {
        input.value = normalizeCode(input.value);
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const code = normalizeCode(input.value);
        if (code.length < 4) return toast('Enter the room code from the invite', { type: 'warn' });
        const joined = joinRide(code);
        if (!joined) return;
        closeSheet();
        toast(`Joined room ${joined}`, { icon: '📡' });
        bus.emit('ride:joined', { code: joined });
        return true;
      });
      setTimeout(() => input.focus(), 380);
    },
  });
}

export function openInviteSheet() {
  if (!ride.active) {
    openTripSheet();
    return;
  }
  const url = inviteUrl(ride.code, ride.trip);

  openSheet({
    title: ride.isCaptain ? 'Invite riders' : 'Ride room',
    html: tpl('tpl-invite'),
    mount(body) {
      const codeEl = body.querySelector('#inviteCode');
      codeEl.textContent = ride.code;
      codeEl.style.cursor = 'pointer';
      codeEl.title = 'Tap to copy the room code';
      codeEl.addEventListener('click', async () => {
        const ok = await copyText(ride.code);
        toast(ok ? `Room code ${ride.code} copied` : `Room code: ${ride.code}`, { icon: '📋' });
      });
      body.querySelector('#inviteUrl').textContent = url.replace(/^https?:\/\//, '');

      const canvas = body.querySelector('#qrCanvas');
      drawQr(canvas, url);

      body.querySelector('#copyInvite').addEventListener('click', async () => {
        const ok = await copyText(url);
        toast(ok ? 'Invite link copied' : 'Could not copy — long-press the link', { type: ok ? 'ok' : 'warn' });
      });

      body.querySelector('#shareInvite').addEventListener('click', async () => {
        const result = await shareInvite({
          title: `Join my ApexMile ride · ${ride.trip}`,
          text: `Room ${ride.code} — tap to follow us live.`,
          url,
        });
        if (result === 'copied') toast('Link copied to clipboard');
        if (result === 'failed') toast('Sharing is not available here', { type: 'warn' });
      });

      const endBtn = body.querySelector('#endRideBtn');
      endBtn.textContent = ride.isCaptain ? 'End ride for everyone' : 'Leave this ride';
      endBtn.addEventListener('click', () => {
        if (ride.isCaptain) endRideForAll();
        else leaveRide();
        closeSheet();
      });

      if (new URLSearchParams(location.search).get('demo') === '1') {
        const demo = document.createElement('button');
        demo.type = 'button';
        demo.className = 'btn ghost wide';
        demo.textContent = 'Add a demo rider (simulated)';
        demo.addEventListener('click', () => {
          startDemoPeer();
          toast('Demo rider added — not a real person', { icon: '👥' });
          closeSheet();
        });
        endBtn.before(demo);
      }
    },
  });
}

function drawQr(canvas, text) {
  if (!canvas || !window.qrcode) return;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const display = 200;
    canvas.width = display * dpr;
    canvas.height = display * dpr;
    canvas.style.width = `${display}px`;
    canvas.style.height = `${display}px`;
    const ctx = canvas.getContext('2d');
    const cell = canvas.width / count;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0B1220';
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.isDark(r, c)) ctx.fillRect(Math.floor(c * cell), Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
  } catch (err) {
    console.warn('[qr]', err);
  }
}

export function openRiderSheet(id) {
  const isMe = !id || id === 'me' || id === SELF_ID;
  const peers = peerList();
  const peer = peers.find((p) => p.id === id);

  if (isMe) {
    openStatusSheet();
    return;
  }
  if (!peer) {
    toast('That rider is no longer in the room', { type: 'warn' });
    return;
  }

  const dist = peer.distance == null ? '' : peer.distance > 995
    ? `${(peer.distance / 1000).toFixed(1)} km away`
    : `${peer.distance} m away`;

  const html = `
    <div class="rider-head">
      <div class="rider-avatar" style="background:${peer.sos ? '#E02D2D' : peer.color}">${esc(peer.name.charAt(0).toUpperCase())}</div>
      <div>
        <div class="rider-name">${esc(peer.name)}</div>
        <div class="rider-role">${esc(peer.role)} · ${esc(peer.mode === 'car' ? 'Car' : 'Bike')}</div>
      </div>
      <span class="live-pill ${peer.stale ? 'stale' : ''}">${peer.stale ? 'Not updating' : 'Live'}</span>
    </div>
    <div class="rider-grid">
      <div><span class="caps">Status</span><b>${esc(peer.status)}</b></div>
      <div><span class="caps">Distance</span><b>${esc(dist || '—')}</b></div>
      <div><span class="caps">Speed</span><b>${peer.speed ? `${peer.speed} km/h` : 'Stopped'}</b></div>
      <div><span class="caps">Updated</span><b>${Math.round((Date.now() - peer.seenAt) / 1000)}s ago</b></div>
    </div>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" id="riderShowMap">Show on map</button>
      <button class="btn primary" type="button" id="riderPing">Where are you?</button>
    </div>
    ${peer.stale ? '<p class="hint">This rider has stopped sending updates. They may be in a tunnel or have closed the app.</p>' : ''}
  `;

  openSheet({
    title: 'Rider',
    html,
    mount(body) {
      body.querySelector('#riderPing').addEventListener('click', () => {
        pingPeer(peer.id);
        closeSheet();
      });
      body.querySelector('#riderShowMap').addEventListener('click', () => {
        closeSheet();
        bus.emit('map:focus-peer', { lat: peer.lat, lng: peer.lng });
      });
    },
  });
}

const STATUSES = [
  { text: 'Riding normal', icon: '✅', sos: false },
  { text: 'Fuel stop', icon: '⛽', sos: false },
  { text: 'Quick break', icon: '☕', sos: false },
  { text: 'Photo stop', icon: '📸', sos: false },
  { text: 'Tyre / chain check', icon: '🔧', sos: false },
  { text: 'Wildlife on road', icon: '🐘', sos: false },
];

export function openStatusSheet() {
  const current = ride._myStatus;
  const html = tpl('tpl-status');

  openSheet({
    title: 'Your status',
    html,
    mount(body) {
      const grid = body.querySelector('#statusGrid');
      const paint = () => {
        grid.innerHTML = '';
        grid.append(buttonFor('🚨 Vehicle breakdown — send SOS', true, true));
        for (const s of STATUSES) grid.append(buttonFor(`${s.icon} ${s.text}`, s.text, false));
      };
      const buttonFor = (label, value, sos) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `status-b ${sos ? 'sos' : ''} ${!sos && current === value ? 'on' : ''}`;
        b.textContent = label;
        b.addEventListener('click', () => {
          setMyStatus(sos ? '🚨 Vehicle breakdown' : value, { sos });
          haptic(sos ? [40, 60, 40] : 8);
          closeSheet();
          toast(sos ? 'SOS sent to your room' : `Status: ${value}`, {
            type: sos ? 'err' : 'ok',
            icon: sos ? '🚨' : '✓',
          });
        });
        return b;
      };
      paint();
    },
  });
}

/* ------------------------------------------------------------------ stops */

export function openStopsSheet() {
  openSheet({
    title: 'Stops & order',
    html: tpl('tpl-stops'),
    mount(body) {
      const form = body.querySelector('#stopsForm');
      const list = body.querySelector('#stopList');
      const input = form.elements.stop;

      const render = () => {
        list.innerHTML = '';
        if (journey.origin) {
          list.append(stopRow({ name: journey.origin.name, index: -2, kind: 'Start' }));
        }
        journey.stops.forEach((s, i) => {
          list.append(stopRow({ ...s, index: i, kind: `Stop ${i + 1}` }));
        });
        if (journey.dest) {
          list.append(stopRow({ name: journey.dest.name, index: -1, kind: 'Destination' }));
        }
        if (!journey.dest && !journey.stops.length) {
          const empty = document.createElement('p');
          empty.className = 'hint';
          empty.textContent = 'Pick a destination first, then add stops along the way.';
          list.append(empty);
        }
      };

      const stopRow = ({ name, index, kind }) => {
        const row = document.createElement('div');
        row.className = 'stop-row';
        row.innerHTML = `<span class="stop-num">${index === -2 ? 'A' : index === -1 ? 'B' : index + 1}</span>
          <span class="stop-name">${esc(kind)}: ${esc(name)}</span>`;
        if (index >= 0) {
          const mv = document.createElement('div');
          mv.className = 'stop-mv';
          const mk = (label, action, disabled) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.disabled = disabled;
            b.title = action;
            b.addEventListener('click', async () => {
              if (action === 'remove') removeStop(index);
              else moveStop(index, action);
              setTimeout(render, 60);
            });
            return b;
          };
          mv.append(
            mk('↑', 'up', index === 0),
            mk('↓', 'down', index === journey.stops.length - 1),
            mk('✕', 'remove', false),
          );
          row.append(mv);
        }
        return row;
      };

      // Lightweight local suggestions; tapping one fills the input.
      const suggestBox = document.createElement('div');
      suggestBox.className = 'ac';
      suggestBox.hidden = true;
      input.closest('.row')?.after(suggestBox);

      input.addEventListener('input', () => {
        const matches = localSuggest(input.value, geo.pos, 4);
        suggestBox.innerHTML = '';
        if (!input.value.trim() || !matches.length) { suggestBox.hidden = true; return; }
        for (const m of matches) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ac-item';
          b.innerHTML = `<span class="ac-ico">📍</span><span class="ac-mid"><span class="ac-t">${esc(m.name)}</span><span class="ac-s">${esc(m.sub)}</span></span><span class="ac-d">${(m.dist / 1000).toFixed(1)} km</span>`;
          b.addEventListener('click', () => {
            input.value = m.name;
            input.dataset.lat = m.lat;
            input.dataset.lng = m.lng;
            suggestBox.hidden = true;
          });
          suggestBox.append(b);
        }
        suggestBox.hidden = false;
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        const lat = Number(input.dataset.lat);
        const lng = Number(input.dataset.lng);
        const place = Number.isFinite(lat) && Number.isFinite(lng)
          ? { name: q, lat, lng }
          : await geocode(q);
        if (!place) return toast(`Could not find “${q}”`, { type: 'err' });
        input.value = '';
        delete input.dataset.lat;
        delete input.dataset.lng;
        suggestBox.hidden = true;
        bus.emit('journey:add-stop', { place, position: form.elements.pos.value });
        setTimeout(render, 700);
      });

      body.querySelector('#clearStopsBtn').addEventListener('click', () => {
        clearStops();
        setTimeout(render, 700);
      });
      body.querySelector('#stopsDoneBtn').addEventListener('click', () => closeSheet());

      render();
    },
  });
}

/* ------------------------------------------------------------------ steps */

export function openStepsSheet() {
  const route = nav.route || currentRoute();
  if (!route) return toast('Plan a route to see directions', { type: 'warn' });
  openSheet({
    title: 'Directions',
    html: tpl('tpl-steps'),
    mount(body) {
      const list = body.querySelector('#stepsList');
      for (const step of route.steps) {
        const row = document.createElement('div');
        row.className = 'step';
        row.innerHTML = `<span class="step-ico">${step.icon}</span>
          <span class="step-t">${esc(step.instruction)}</span>
          <span class="step-d">${step.distance > 900 ? `${(step.distance / 1000).toFixed(1)} km` : `${Math.round(step.distance)} m`}</span>`;
        list.append(row);
      }
      if (!route.steps.length) {
        list.innerHTML = '<p class="hint">No turn list for this route.</p>';
      }
      const est = estimates(route);
      if (est) {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = `About ${Math.round(est.minutes)} min and ${est.litres.toFixed(2)} L of fuel (₹${Math.round(est.fuel)}) on ${est.vehicleName}.`;
        list.prepend(note);
      }
    },
  });
}

/* ------------------------------------------------------------------ profile */

export function openProfileSheet() {
  openSheet({
    title: 'Profile',
    html: tpl('tpl-profile'),
    mount(body) {
      const form = body.querySelector('#profileForm');
      form.elements.name.value = state.user.name || '';
      form.elements.phone.value = state.user.phone || '';
      form.elements.theme.value = state.theme || 'auto';

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        bus.emit('profile:save', {
          name: String(form.elements.name.value || '').trim(),
          phone: String(form.elements.phone.value || '').trim(),
          theme: form.elements.theme.value,
        });
        closeSheet();
        toast('Profile saved');
        return true;
      });

      body.querySelector('#profSignOut').addEventListener('click', () => {
        closeSheet();
        bus.emit('profile:signout');
      });
    },
  });
}
