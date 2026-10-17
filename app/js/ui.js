// DOM helpers, toasts, the bottom-sheet engine, theme, and small platform bits.
// Everything here is framework-free and iOS/Android safe.
import { uiIcon } from './navicons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function haptic(pattern = 8) {
  try { navigator.vibrate?.(pattern); } catch { /* iOS ignores it */ }
}

/* ------------------------------------------------------------------ toasts */

const toastHost = () => document.getElementById('toasts');
const MAX_TOASTS = 3;

export function toast(message, { type = 'ok', icon = '', ms = 3400 } = {}) {
  const host = toastHost();
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  // Toast icons are drawn, never emoji: `icon` is a UI icon name from
  // navicons.js, and anything unknown falls back to the type's own glyph.
  const name = icon || (type === 'ok' ? 'check' : type === 'warn' ? 'warn' : type === 'err' ? 'close' : 'info');
  node.innerHTML = `<span class="t-ico" aria-hidden="true">${uiIcon(name)}</span><span>${esc(message)}</span>`;
  host.append(node);
  while (host.children.length > MAX_TOASTS) host.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, ms);
}

/* ------------------------------------------------------------------ sheets */

const sheetHost = () => document.getElementById('sheetHost');
const sheetEl = () => document.getElementById('sheet');
const sheetBodyEl = () => document.getElementById('sheetBody');
const sheetTitleEl = () => document.getElementById('sheetTitle');

let sheetOpen = false;
let historyPushed = false;
let pendingBack = 0;
let sheetSession = 0;
let closeCb = null;
let mountedCleanup = null;
let scrollLocked = false;
let savedScrollY = 0;

export function isSheetOpen() { return sheetOpen; }

export function openSheet({ title = '', html = '', mount = null, onClose = null, dismissible = true } = {}) {
  if (sheetOpen) {
    closeSheet({ instant: true, keepHistory: true });
  }
  sheetSession += 1;

  sheetTitleEl().textContent = title;
  const body = sheetBodyEl();
  body.innerHTML = html;
  body.scrollTop = 0;
  closeCb = onClose;

  const host = sheetHost();
  host.hidden = false;
  const el = sheetEl();
  el.dataset.dismissible = dismissible ? '1' : '0';
  el.style.transform = '';

  lockScroll();
  requestAnimationFrame(() => host.classList.add('show'));
  sheetOpen = true;

  if (!historyPushed) {
    try {
      history.pushState({ apexSheet: 1 }, '');
      historyPushed = true;
    } catch { /* history unavailable */ }
  }

  // Focus the first field after the entry animation. Avoids the iOS keyboard
  // jumping in while the sheet is still sliding.
  if (mount) {
    mountedCleanup = mount(body) || null;
    const firstField = body.querySelector('input:not([type="file"]), select, textarea');
    if (firstField && matchMedia('(pointer:fine)').matches) {
      setTimeout(() => firstField.focus({ preventScroll: true }), 380);
    }
  }
}

export function closeSheet({ instant = false, keepHistory = false } = {}) {
  if (!sheetOpen) return;
  sheetOpen = false;

  // Pop the history entry *now*, not after the animation. A delayed back()
  // would race with any sheet the rider opens next and close it too.
  if (!keepHistory && historyPushed) {
    historyPushed = false;
    pendingBack += 1;
    // If the popstate never arrives (older Safari, weird stack), stop waiting.
    setTimeout(() => { pendingBack = Math.max(0, pendingBack - 1); }, 1500);
    try { history.back(); } catch { pendingBack = Math.max(0, pendingBack - 1); }
  }

  const host = sheetHost();
  const closingSession = sheetSession;
  host.classList.remove('show');

  const finish = () => {
    // A newer sheet claimed the host while this one was animating out.
    if (closingSession !== sheetSession) return;
    host.hidden = true;
    sheetBodyEl().innerHTML = '';
    unlockScroll();
    if (typeof mountedCleanup === 'function') { try { mountedCleanup(); } catch { /* noop */ } }
    mountedCleanup = null;
  };

  if (instant) finish();
  else setTimeout(finish, 340);

  const cb = closeCb;
  closeCb = null;
  cb?.();
}

// Android back button / swipe-back closes the sheet instead of leaving the app.
window.addEventListener('popstate', () => {
  // This is the back() we asked for in closeSheet(). If the rider already
  // opened another sheet, keep it instead of closing it from under them.
  if (pendingBack > 0) { pendingBack -= 1; return; }
  if (!sheetOpen) return;
  sheetOpen = false;
  historyPushed = false;
  sheetSession += 1;
  const closingSession = sheetSession;
  const host = sheetHost();
  host.classList.remove('show');
  setTimeout(() => {
    if (closingSession !== sheetSession) return;
    host.hidden = true;
    sheetBodyEl().innerHTML = '';
    unlockScroll();
    if (typeof mountedCleanup === 'function') { try { mountedCleanup(); } catch { /* noop */ } }
    mountedCleanup = null;
  }, 340);
  const cb = closeCb;
  closeCb = null;
  cb?.();
});

function lockScroll() {
  if (scrollLocked) return;
  scrollLocked = true;
  savedScrollY = window.scrollY || 0;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${savedScrollY}px`;
  document.body.style.width = '100%';
}

function unlockScroll() {
  if (!scrollLocked) return;
  scrollLocked = false;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo(0, savedScrollY);
}

/** Wire sheet dismissal: backdrop, ✕, drag handle. Called once from main. */
export function initSheets() {
  document.getElementById('sheetBackdrop')?.addEventListener('click', () => {
    if (sheetEl().dataset.dismissible === '1') closeSheet();
  });
  document.getElementById('sheetClose')?.addEventListener('click', () => closeSheet());

  // Delegated: any [data-close] inside a sheet closes it.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeSheet();
  });

  document.addEventListener('keydown', (e) => {
    if (!sheetOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSheet();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = [...sheetEl().querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  const el = sheetEl();
  const dragTarget = document.querySelector('.sheet-head');
  const grip = document.getElementById('sheetGrip');
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let pointerId = null;

  const down = (e) => {
    if (sheetEl().dataset.dismissible !== '1') return;
    dragging = true;
    pointerId = e.pointerId;
    startY = e.clientY;
    dy = 0;
    el.classList.add('dragging');
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    el.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    el.style.transform = '';
    if (dy > 110) closeSheet();
    else if (dy > 0) el.style.transform = '';
    dy = 0;
    if (pointerId != null) { try { el.releasePointerCapture?.(pointerId); } catch { /* noop */ } pointerId = null; }
  };

  for (const target of [dragTarget, grip]) {
    if (!target) continue;
    target.addEventListener('pointerdown', down);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
}

/* ------------------------------------------------------------------ theme */

const mqlDark = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  return mqlDark().matches ? 'dark' : 'light';
}

export function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0A0F1A' : '#FFFFFF');
  // Keep the browser chrome in step with the in-app theme, not just the OS.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const isDarkTag = /dark/.test(m.getAttribute('media') || '');
    if (isDarkTag) m.setAttribute('content', '#0A0F1A');
    else if (/light/.test(m.getAttribute('media') || '')) m.setAttribute('content', '#FFFFFF');
  });
  return resolved;
}

export function onSystemThemeChange(fn) {
  const mq = mqlDark();
  const handler = () => fn(mq.matches ? 'dark' : 'light');
  mq.addEventListener?.('change', handler);
  return () => mq.removeEventListener?.('change', handler);
}

export function applyMotion(pref) {
  if (pref === 'reduce') document.documentElement.dataset.motion = 'reduce';
  else document.documentElement.dataset.motion = '';
}

/* ------------------------------------------------------------------ format */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function money(n) {
  if (!Number.isFinite(n)) return '₹—';
  return `₹${Math.abs(n) >= 100 ? inr0.format(Math.round(n)) : inr.format(n)}`;
}

export function rupees(n, digits = 2) {
  if (!Number.isFinite(n)) return '₹—';
  return `₹${n.toFixed(digits)}`;
}

export function km(n, digits = 0) {
  if (!Number.isFinite(n)) return '— km';
  return `${digits ? n.toFixed(digits) : inr0.format(Math.round(n))} km`;
}

export function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export function dateShort(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function clockTime(date = new Date()) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export function durationClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h) return `${h} hr ${m} min`;
  return `${m || 1} min`;
}

/* ------------------------------------------------------------------ platform */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // iOS sometimes refuses clipboard outside a direct gesture — fall back.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

export async function shareInvite({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  const ok = await copyText(url);
  return ok ? 'copied' : 'failed';
}

/** Downscale an image file to a small JPEG data URL (keeps localStorage sane). */
export function fileToPhoto(file, max = 320, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode that image'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}
