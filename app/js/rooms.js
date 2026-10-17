// Group riding over MQTT (public demo broker) + BroadcastChannel for same-device
// previews. Design notes:
//   • Telemetry carries name, role, position and status — never the phone number.
//   • Room codes are 6 characters from a 32-char alphabet (~1e9 combinations).
//   • Presence is explicit: hello / pos heartbeat / bye, plus an MQTT will.
//   • Captain ride state is the ONLY retained message, so a late joiner can pick
//     up the destination. It is cleared when the ride ends.
import { bus } from './bus.js';
import { state } from './store.js';
import { geo, distanceM } from './geo.js';
import { toast, haptic } from './ui.js';

// Public MQTT-over-WebSocket brokers. Public brokers are islands: a rider on
// EMQX can never see a rider on HiveMQ, same room code or not. So the room
// code itself picks which broker the room meets on (see brokerCandidates) —
// everyone who types/scans the same code walks into the same room on the same
// broker, and the rest are only fallbacks for when that one is unreachable.
// (mqtt.eclipseprojects.io was removed: the Eclipse foundation shut it down.)
const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt', label: 'EMQX' },
  { url: 'wss://broker.hivemq.com:8884/mqtt', label: 'HiveMQ' },
  { url: 'wss://mqtt-dashboard.com:8884/mqtt', label: 'HiveMQ (alt host)' },
  { url: 'wss://test.mosquitto.org:8081/mqtt', label: 'Mosquitto' },
];
const PREFIX = 'apexmile/v10/ride/';
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const HEARTBEAT_MS = 12000;
const TICK_MS = 3000;
const STALE_MS = 38000;
const DROP_MS = 125000;

function makeSelfId() {
  let id = '';
  try { id = sessionStorage.getItem('apexmile.self') || ''; } catch { /* private mode */ }
  if (!/^r[a-z0-9]{5,12}$/.test(id)) {
    id = `r${Math.random().toString(36).slice(2, 9)}`;
    try { sessionStorage.setItem('apexmile.self', id); } catch { /* private mode */ }
  }
  return id;
}

export const SELF_ID = makeSelfId();

export const ride = {
  active: false,
  code: '',
  trip: 'Group ride',
  isCaptain: false,
  peers: new Map(),
  connected: false,
  status: 'idle', // idle | connecting | live | offline
  dest: null,
  navStarted: false,
  startedAt: 0,
  _client: null,
  _channel: null,
  _tick: null,
  _sweep: null,
  _lastPub: 0,
  _lastPos: null,
  _myStatus: 'Riding normal',
  _mySos: false,
  _demoTimer: null,
  _attempt: 0,
  _retry: null,
  broker: '',
  brokerLabel: '',
  lastError: '',
  mode: 'bike',
  messages: [],
  _unread: 0,
};

/* ------------------------------------------------------------------ helpers */

export function newCode() {
  let out = '';
  const bytes = new Uint32Array(6);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(Math.random() * 1e9);
  for (let i = 0; i < 6; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function normalizeCode(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.slice(0, 8);
}

export function inviteUrl(code, trip) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  if (trip) url.searchParams.set('trip', trip);
  return url.toString();
}

function myName() {
  return (state.user.name || 'Rider').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Rider';
}

function hashHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function colorFor(id) {
  return `hsl(${hashHue(id)} 68% 44%)`;
}

function setStatus(status) {
  if (ride.status === status) return;
  ride.status = status;
  bus.emit('ride:status', { status, connected: ride.connected });
}

/* ------------------------------------------------------------------ transport */

function connect(code) {
  if (!window.mqtt) {
    setStatus('offline');
    ride.lastError = 'sync library missing';
    toast('Group sync library did not load — riders on this device only', { type: 'warn' });
    return;
  }
  stopClient();
  ride._code = code;
  ride._attempt = 0;
  setStatus('connecting');
  tryNextBroker(code);
}

function brokerHash(code) {
  let h = 0;
  for (let i = 0; i < code.length; i += 1) h = (h * 33 + code.charCodeAt(i)) >>> 0;
  return h;
}

function brokerCandidates(code) {
  const custom = String(state.broker || '').trim();
  if (custom) return [{ url: custom, label: 'Custom' }];
  const list = BROKERS.map((b) => ({ ...b }));
  if (code) {
    // Co-location rule: the room code deterministically names the meeting
    // broker, so every rider in this room tries the same endpoint first. A
    // per-device "sticky broker" (the old behaviour) scattered room members
    // across different brokers, which is exactly the "we joined but can't see
    // each other" bug — public brokers do not share messages.
    const primary = brokerHash(code) % list.length;
    list.unshift(list.splice(primary, 1)[0]);
  }
  return list;
}

function tryNextBroker(code) {
  if (!ride.active || ride.code !== code) return;
  const list = brokerCandidates(code);

  if (ride._attempt >= list.length) {
    ride.connected = false;
    setStatus('offline');
    scheduleBrokerRetry(code);
    return;
  }

  const broker = list[ride._attempt];
  ride._attempt += 1;
  ride.broker = broker.url;
  ride.brokerLabel = broker.label;
  setStatus('connecting');

  let client = null;
  let settled = false;
  let timer = null;

  const teardown = () => {
    clearTimeout(timer);
    try { client?.removeAllListeners?.(); } catch { /* noop */ }
    try { client?.end(true); } catch { /* noop */ }
    if (ride._client === client) ride._client = null;
  };

  const failed = (reason) => {
    if (settled) return;
    settled = true;
    ride.lastError = reason || 'no connection';
    teardown();
    if (ride.active && ride.code === code) tryNextBroker(code);
  };

  try {
    client = window.mqtt.connect(broker.url, {
      clientId: `apex_${SELF_ID}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0, // failover is ours, not mqtt.js's
      connectTimeout: 7000,
      will: {
        topic: `${PREFIX}${code}/ev`,
        payload: JSON.stringify({ t: 'bye', id: SELF_ID }),
        qos: 0,
        retain: false,
      },
    });
  } catch (err) {
    ride.lastError = err?.message || 'connect failed';
    tryNextBroker(code);
    return;
  }

  ride._client = client;
  timer = setTimeout(() => failed('timed out'), 9000);

  const evTopic = `${PREFIX}${code}/ev`;
  const stateTopic = `${PREFIX}${code}/state`;

  client.on('connect', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ride.connected = true;
    ride._attempt = 0;
    setStatus('live');

    // Announce presence only after the subscription is registered. Firing the
    // hello straight at the broker raced the SUBACK: the room answered before
    // we could listen, and the fresh joiner sat there seeing nobody for a full
    // heartbeat (or forever, when the others were standing still).
    let announced = false;
    const announce = () => {
      if (announced || !ride.active || ride.code !== code) return;
      announced = true;
      publish({ t: 'hello', lat: geo.pos?.lat, lng: geo.pos?.lng });
      publishPosition(geo.pos, true);
      if (ride.isCaptain) publishCaptainState();
    };
    client.subscribe([evTopic, stateTopic], { qos: 0 }, (err) => {
      if (err) console.warn('[ride] subscribe', err);
      announce();
    });
    // A broker that never answers SUBACK must not silence us either.
    setTimeout(announce, 1500);
    bus.emit('ride:transport', connectionInfo());
  });

  client.on('reconnect', () => setStatus('connecting'));

  client.on('close', () => {
    if (!settled) { failed('closed before connect'); return; }
    if (!ride.active || ride.code !== code) return;
    if (!ride.connected) return;
    ride.connected = false;
    setStatus('offline');
    scheduleBrokerRetry(code);
    bus.emit('ride:transport', connectionInfo());
  });

  client.on('error', (err) => {
    ride.lastError = err?.message || 'socket error';
    if (!settled) failed(ride.lastError);
  });

  client.on('message', (topic, payload) => {
    let pkt = null;
    try { pkt = JSON.parse(payload.toString()); } catch { return; }
    if (topic.endsWith('/state')) handleCaptainState(pkt);
    else handlePacket(pkt);
  });
}

function scheduleBrokerRetry(code) {
  clearTimeout(ride._retry);
  ride._retry = setTimeout(() => {
    if (!ride.active || ride.code !== code) return;
    ride._attempt = 0;
    setStatus('connecting');
    tryNextBroker(code);
  }, 15000);
}

function stopClient() {
  clearTimeout(ride._retry);
  ride._retry = null;
  const client = ride._client;
  ride._client = null;
  ride.connected = false;
  try { client?.removeAllListeners?.(); } catch { /* noop */ }
  try { client?.end(true); } catch { /* noop */ }
}

export function reconnectRide() {
  if (!ride.active) return false;
  clearTimeout(ride._retry);
  ride._retry = null;
  ride._attempt = 0;
  stopClient();
  setStatus('connecting');
  tryNextBroker(ride.code);
  bus.emit('ride:transport', connectionInfo());
  return true;
}

export function connectionInfo() {
  return {
    status: ride.status,
    broker: ride.broker,
    brokerLabel: ride.brokerLabel,
    connected: ride.connected,
    lastError: ride.lastError,
    peers: ride.peers.size,
  };
}

function publish(packet) {
  const full = {
    id: SELF_ID,
    name: myName(),
    role: ride.isCaptain ? 'Captain' : 'Member',
    mode: currentMode(),
    ts: Date.now(),
    ...packet,
  };
  if (ride._client?.connected) {
    try {
      ride._client.publish(`${PREFIX}${ride.code}/ev`, JSON.stringify(full), { qos: 0 });
    } catch { /* noop */ }
  }
  if (ride._channel) {
    try { ride._channel.postMessage(full); } catch { /* noop */ }
  }
  return full;
}

function publishPosition(pos, force = false) {
  if (!ride.active || !ride.code) return;
  if (!pos) return;
  publish({
    t: 'pos',
    lat: Number(pos.lat.toFixed(6)),
    lng: Number(pos.lng.toFixed(6)),
    heading: Math.round(pos.heading || 0),
    speed: Math.round((pos.speed || 0) * 3.6),
    acc: Math.round(pos.acc || 0),
    status: ride._myStatus,
    sos: ride._mySos,
  });
  ride._lastPub = Date.now();
  if (force) ride._lastPos = { lat: pos.lat, lng: pos.lng };
}

function currentMode() {
  const veh = state.vehicles?.find((v) => v.id === state.activeVehicleId);
  return veh?.type === 'Car' ? 'car' : 'bike';
}

/* ------------------------------------------------------------------ inbound */

function handlePacket(pkt) {
  if (!pkt || pkt.id === SELF_ID) return;

  if (pkt.t === 'ping') {
    if (pkt.to && pkt.to !== SELF_ID) return;
    haptic([40, 70, 40]);
    bus.emit('ride:ping', { fromName: pkt.name || 'A rider', fromId: pkt.id });
    notify(`${pkt.name || 'A rider'} asks: where are you?`, 'Open ApexMile to reply with your live location.');
    return;
  }

  if (pkt.t === 'msg') {
    appendMessage({
      id: pkt.id,
      name: pkt.name || 'Rider',
      text: String(pkt.text || '').slice(0, 160),
      kind: pkt.kind || 'chat',
      at: pkt.ts || Date.now(),
      mine: false,
    });
    haptic([14, 26, 14]);
    toast(`${pkt.name || 'Rider'}: ${pkt.text}`, { icon: '💬', ms: 4200 });
    notify(`${pkt.name || 'Rider'}`, pkt.text || 'New pack message');
    return;
  }

  if (pkt.t === 'bye') {
    if (ride.peers.has(pkt.id)) {
      ride.peers.delete(pkt.id);
      bus.emit('ride:left', { id: pkt.id, name: pkt.name });
      emitPeers();
    }
    return;
  }

  if (pkt.t === 'hello') {
    const isNew = !ride.peers.has(pkt.id);
    upsertPeer(pkt);
    if (isNew) {
      toast(`${pkt.name || 'A rider'} joined the ride`, { icon: '🎉' });
      // Help them see us immediately instead of waiting for the next heartbeat.
      publishPosition(geo.pos, true);
    }
    emitPeers();
    return;
  }

  if (pkt.t === 'pos' || pkt.t === 'status') {
    const isNew = !ride.peers.has(pkt.id);
    upsertPeer(pkt);
    if (pkt.sos && andNotified(pkt)) {
      haptic([60, 40, 60, 40, 60]);
      toast(`SOS · ${pkt.name || 'A rider'} needs help`, { type: 'err', icon: '🚨', ms: 6000 });
      notify(`SOS from ${pkt.name || 'a rider'}`, 'They have marked a breakdown. Open ApexMile.');
    }
    if (isNew) bus.emit('ride:peer-joined', { peer: pkt });
    emitPeers();
  }
}

const sosNotified = new Set();
function andNotified(pkt) {
  if (!pkt.sos) return false;
  if (sosNotified.has(pkt.id)) return false;
  sosNotified.add(pkt.id);
  setTimeout(() => sosNotified.delete(pkt.id), 60000);
  return true;
}

function upsertPeer(pkt) {
  if (!pkt || !pkt.id) return;
  const prev = ride.peers.get(pkt.id) || {};
  const lat = Number(pkt.lat);
  const lng = Number(pkt.lng);
  ride.peers.set(pkt.id, {
    id: pkt.id,
    name: String(pkt.name || 'Rider').slice(0, 24),
    role: pkt.role || 'Member',
    mode: pkt.mode || 'bike',
    lat: Number.isFinite(lat) ? lat : prev.lat,
    lng: Number.isFinite(lng) ? lng : prev.lng,
    heading: Number(pkt.heading) || 0,
    speed: Number(pkt.speed) || 0,
    status: String(pkt.status || prev.status || 'Riding normal').slice(0, 40),
    sos: Boolean(pkt.sos ?? prev.sos),
    color: prev.color || colorFor(pkt.id),
    seenAt: Date.now(),
    stale: false,
  });
}

function emitPeers() {
  bus.emit('ride:peers', { peers: peerList() });
}

/* ------------------------------------------------------------------ captain state */

function publishCaptainState() {
  if (!ride.active || !ride.isCaptain || !ride._client?.connected) return;
  const payload = {
    v: 1,
    captain: SELF_ID,
    captainName: myName(),
    trip: ride.trip,
    dest: ride.dest,
    navStarted: ride.navStarted,
    mode: ride.mode,
    updatedAt: Date.now(),
  };
  try {
    // Retained so a rider who joins late still gets the destination.
    ride._client.publish(`${PREFIX}${ride.code}/state`, JSON.stringify(payload), { qos: 0, retain: true });
  } catch { /* noop */ }
}

function handleCaptainState(pkt) {
  if (!pkt || pkt.captain === SELF_ID) return;
  // A retained message can outlive the ride on a public broker. Ignore stale ones.
  if (pkt.updatedAt && Date.now() - Number(pkt.updatedAt) > 6 * 60 * 60 * 1000) return;
  if (pkt.ended) {
    toast(`The captain ended “${pkt.trip || ride.trip}”`, { icon: '🏁' });
    leaveRide({ broadcast: false });
    return;
  }
  ride.trip = pkt.trip || ride.trip;
  ride.dest = pkt.dest || null;
  ride.navStarted = Boolean(pkt.navStarted);
  if (pkt.mode) ride.mode = pkt.mode;
  bus.emit('ride:captain-state', pkt);
}

export function setMode(mode) {
  if (!['bike', 'car', 'walk'].includes(mode)) return;
  ride.mode = mode;
  publishCaptainState();
}

export function setDestination(dest, navStarted = false) {
  ride.dest = dest || null;
  ride.navStarted = Boolean(navStarted);
  publishCaptainState();
}

/* ------------------------------------------------------------------ lifecycle */

export function createRide({ trip = 'Group ride', dest = null, code } = {}) {
  leaveRide({ broadcast: false, silent: true });
  ride.active = true;
  ride.code = code || newCode();
  ride.trip = trip;
  ride.dest = dest;
  ride.isCaptain = true;
  ride.navStarted = false;
  ride.startedAt = Date.now();
  ride.peers.clear();
  ride._myStatus = 'Riding normal';
  ride._mySos = false;
  ride.messages = [];
  ride._unread = 0;
  ride.mode = state.tripMode || 'bike';

  openChannel(ride.code);
  connect(ride.code);
  startLoops();
  bus.emit('ride:changed', { active: true, code: ride.code, captain: true });
  return ride.code;
}

export function joinRide(code, { asCaptain = false } = {}) {
  const clean = normalizeCode(code);
  if (clean.length < 4) {
    toast('That room code looks too short', { type: 'err' });
    return null;
  }
  leaveRide({ broadcast: false, silent: true });
  ride.active = true;
  ride.code = clean;
  ride.isCaptain = asCaptain;
  ride.trip = 'Group ride';
  ride.startedAt = Date.now();
  ride.peers.clear();
  ride.messages = [];
  ride._unread = 0;

  openChannel(clean);
  connect(clean);
  startLoops();
  bus.emit('ride:changed', { active: true, code: clean, captain: asCaptain });
  return clean;
}

function openChannel(code) {
  try {
    ride._channel = new BroadcastChannel(`apexmile-${code}`);
    ride._channel.onmessage = (ev) => handlePacket(ev.data);
  } catch { ride._channel = null; }
}

function startLoops() {
  clearInterval(ride._tick);
  clearInterval(ride._sweep);
  ride._tick = setInterval(() => {
    if (!ride.active) return;
    // No skip for a hidden screen: riders lock their phones mid-ride. GPS may
    // freeze, but the heartbeat must not — otherwise every phone-in-pocket
    // rider goes stale in 38 s and is dropped from the pack in two minutes.
    const pos = geo.pos;
    if (!pos) return;
    const moved = ride._lastPos ? distanceM(ride._lastPos, pos) : Infinity;
    const due = Date.now() - ride._lastPub > HEARTBEAT_MS;
    if (moved > 6 || due) {
      publishPosition(pos, moved > 6);
      ride._lastPos = { lat: pos.lat, lng: pos.lng };
      ride._lastPub = Date.now();
    }
  }, TICK_MS);

  ride._sweep = setInterval(() => {
    if (!ride.active) return;
    let changed = false;
    const now = Date.now();
    for (const [id, peer] of ride.peers) {
      const age = now - peer.seenAt;
      const stale = age > STALE_MS;
      if (stale !== peer.stale) { peer.stale = stale; changed = true; }
      if (age > DROP_MS) { ride.peers.delete(id); changed = true; }
    }
    if (changed) emitPeers();
  }, 4000);
}

export function leaveRide({ broadcast = true, silent = false } = {}) {
  if (!ride.active) return;
  if (broadcast) publish({ t: 'bye' });

  clearInterval(ride._tick);
  clearInterval(ride._sweep);
  clearInterval(ride._demoTimer);
  ride._tick = null;
  ride._sweep = null;
  ride._demoTimer = null;

  stopClient();
  try { ride._channel?.close(); } catch { /* noop */ }
  ride._channel = null;

  ride.active = false;
  ride.connected = false;
  ride.code = '';
  ride.peers.clear();
  ride.dest = null;
  ride.navStarted = false;
  ride.isCaptain = false;
  ride.messages = [];
  ride._unread = 0;
  ride.broker = '';
  ride.brokerLabel = '';
  ride.lastError = '';
  setStatus('idle');

  bus.emit('ride:peers', { peers: [] });
  bus.emit('ride:changed', { active: false });
  if (!silent) toast('You left the ride · location sharing stopped', { icon: '🔒' });
}

export function endRideForAll() {
  if (!ride.active) return;
  const code = ride.code;
  const trip = ride.trip;
  if (ride._client?.connected) {
    try {
      ride._client.publish(`${PREFIX}${code}/state`, JSON.stringify({
        v: 1, captain: SELF_ID, ended: true, trip, updatedAt: Date.now(),
      }), { qos: 0, retain: true });
      // Remove the retained record entirely so nothing lingers on the broker.
      setTimeout(() => {
        try { ride._client?.publish(`${PREFIX}${code}/state`, '', { qos: 0, retain: true }); } catch { /* noop */ }
      }, 400);
    } catch { /* noop */ }
  }
  publish({ t: 'bye' });
  setTimeout(() => leaveRide({ broadcast: false }), 450);
  toast('Ride ended for everyone', { icon: '🏁' });
}

/* ------------------------------------------------------------------ api */

export const QUICK_MESSAGES = [
  'Stopping for fuel',
  'Water break',
  'Wait for me',
  'All good',
  'Photo stop',
  'Catch up when you can',
];

function appendMessage(msg) {
  const clean = {
    ...msg,
    text: String(msg.text || '').slice(0, 160),
    at: Number(msg.at) || Date.now(),
  };
  ride.messages.push(clean);
  if (ride.messages.length > 80) ride.messages.shift();
  if (!clean.mine) ride._unread = Math.min(99, (ride._unread || 0) + 1);
  bus.emit('ride:message', { message: clean, unread: ride._unread });
}

export function sendMessage(text, { kind = 'chat' } = {}) {
  const body = String(text || '').trim().slice(0, 160);
  if (!body) return false;
  if (!ride.active) {
    toast('Start a group ride first', { type: 'warn' });
    return false;
  }
  const full = publish({ t: 'msg', text: body, kind });
  appendMessage({ ...full, text: body, kind, at: full.ts, mine: true });
  return true;
}

export function markMessagesRead() {
  if (!ride._unread) return;
  ride._unread = 0;
  bus.emit('ride:message', { message: null, unread: 0 });
}

export function publishNow() {
  publishPosition(geo.pos, true);
}

export function setMyStatus(text, { sos = false } = {}) {
  ride._myStatus = String(text || 'Riding normal').slice(0, 40);
  ride._mySos = Boolean(sos);
  publish({ t: 'status', status: ride._myStatus, sos: ride._mySos });
  publishPosition(geo.pos, true);
  bus.emit('ride:status-self', { status: ride._myStatus, sos: ride._mySos });
}

export function pingPeer(id) {
  if (!ride.active) {
    toast('Start a group ride first', { type: 'warn' });
    return;
  }
  publish({ t: 'ping', to: id });
  toast('Ping sent · they will see your request', { icon: '📍' });
}

export function peerList() {
  const me = geo.pos;
  return [...ride.peers.values()]
    .map((p) => ({
      ...p,
      distance: me && p.lat != null ? distanceM(me, p) : null,
    }))
    .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}

export async function requestNotifications() {
  try {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    const result = await Notification.requestPermission();
    return result;
  } catch { return 'unsupported'; }
}

function notify(title, body) {
  try {
    if (document.visibilityState === 'visible') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(title, { body, icon: 'assets/icons/icon-192.png', tag: 'apexmile-ping' });
  } catch { /* noop */ }
}

/* ------------------------------------------------------------------ demo rider */

/**
 * A simulated rider for trying out the radar alone. Enable with ?demo=1.
 * Kept deliberately obvious so nobody mistakes it for a real person.
 */
export function startDemoPeer() {
  if (!ride.active) return false;
  if (ride._demoTimer) return true;
  const base = geo.pos || { lat: 12.9716, lng: 77.5946 };
  let t = 0;
  const push = () => {
    t += 0.11;
    const radius = 0.0042 + (Math.sin(t * 0.7) + 1) * 0.0035; // 450 m – 850 m away
    const lat = base.lat + Math.cos(t) * radius;
    const lng = base.lng + Math.sin(t) * radius * 1.06;
    const pkt = {
      t: 'pos',
      id: 'demo_rider',
      name: 'Demo rider',
      role: 'Member',
      mode: 'bike',
      lat,
      lng,
      heading: Math.round((t * 57) % 360),
      speed: 32,
      status: t % 2 > 1 ? 'Fuel stop' : 'Riding normal',
      sos: false,
    };
    handlePacket({ ...pkt, id: 'demo_rider' });
  };
  push();
  ride._demoTimer = setInterval(push, 3200);
  return true;
}

export function stopDemoPeer() {
  clearInterval(ride._demoTimer);
  ride._demoTimer = null;
  ride.peers.delete('demo_rider');
  emitPeers();
}
