// Tiny event bus. Modules stay decoupled: geo emits fixes, ride emits presence,
// nav listens, views re-render.
const listeners = new Map();

export const bus = {
  on(name, fn) {
    let set = listeners.get(name);
    if (!set) { set = new Set(); listeners.set(name, set); }
    set.add(fn);
    return () => set.delete(fn);
  },
  off(name, fn) { listeners.get(name)?.delete(fn); },
  emit(name, detail) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(detail); } catch (err) { console.error(`[bus:${name}]`, err); }
    }
  },
};
