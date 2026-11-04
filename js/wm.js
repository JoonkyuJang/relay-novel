// Window manager: draggable 1-bit windows on desktop, one full-screen window on phones.
//
// A "view" is { title, type, body: HTMLElement, size: {w, h}, mount?(), unmount?(), route }.
import { h, closeProps } from './ui.js';
import { prefs } from './api.js';

const phoneQuery = window.matchMedia('(max-width: 767px)');
export const isPhone = () => phoneQuery.matches;

export function createWM(layer, { onActiveChange } = {}) {
  const wins = new Map();          // key -> { key, view, el, z }
  let z = 10;
  let active = null;
  let cascade = 0;

  function bounds() { return { w: layer.clientWidth, h: layer.clientHeight }; }

  function clamp(el) {
    if (isPhone()) return;
    const b = bounds();
    const x = Math.min(Math.max(parseInt(el.style.left) || 0, -el.offsetWidth + 120), b.w - 120);
    const y = Math.min(Math.max(parseInt(el.style.top) || 0, 0), b.h - 40);
    el.style.left = `${x}px`; el.style.top = `${y}px`;
  }

  function place(win) {
    const { view, el } = win;
    const b = bounds();
    const w = Math.min(view.size?.w ?? 560, b.w - 40);
    const ht = Math.min(view.size?.h ?? 520, b.h - 30);
    el.style.width = `${w}px`; el.style.height = `${ht}px`;
    const saved = view.remember !== false ? prefs.getJSON(`win.${view.type}`) : null;
    let x, y;
    if (saved) { x = saved.x; y = saved.y; }
    else if (view.position === 'center') { x = (b.w - w) / 2; y = Math.max(20, (b.h - ht) / 2 - 20); }
    else {
      const base = view.origin ?? { x: 40, y: 20 };
      x = base.x + (cascade % 6) * 26; y = base.y + (cascade % 6) * 22; cascade++;
    }
    el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
    clamp(el);
  }

  function makeDraggable(win) {
    const bar = win.el.querySelector('.win-title');
    bar.addEventListener('pointerdown', (e) => {
      if (isPhone() || e.button !== 0 || e.target.closest('button')) return;
      const el = win.el;
      const sx = e.clientX, sy = e.clientY;
      const ox = parseInt(el.style.left) || 0, oy = parseInt(el.style.top) || 0;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      const move = (ev) => {
        el.style.left = `${ox + ev.clientX - sx}px`;
        el.style.top = `${oy + ev.clientY - sy}px`;
      };
      const up = () => {
        bar.classList.remove('dragging');
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        clamp(el);
        if (win.view.remember !== false) {
          prefs.setJSON(`win.${win.view.type}`, { x: parseInt(el.style.left), y: parseInt(el.style.top) });
        }
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
  }

  function focus(key, { silent = false } = {}) {
    const win = wins.get(key);
    if (!win) return;
    if (active !== key) {
      if (active && wins.get(active)) wins.get(active).el.classList.remove('is-active');
      active = key;
      win.el.classList.add('is-active');
      closeProps();
    }
    win.el.style.zIndex = String(++z);
    win.view.onFocus?.();
    if (!silent) onActiveChange?.(win);
  }

  function open(key, factory, { silent = false } = {}) {
    if (wins.has(key)) { focus(key, { silent }); return wins.get(key); }
    const view = factory();
    const titleEl = h('h2', { id: `wt-${key.replace(/[^a-z0-9]/gi, '')}` }, view.title);
    const el = h('section', { class: 'win', 'aria-labelledby': titleEl.id, dataset: { key } },
      h('div', { class: 'win-title' },
        view.closable === false ? h('span', { class: 'win-title-pad' })
          : h('button', { type: 'button', class: 'win-close', 'aria-label': `${view.title} 닫기`, onclick: () => close(key) }),
        titleEl,
        h('span', { class: 'win-title-pad' })),
      h('div', { class: 'win-body' }, view.body));
    if (view.className) el.classList.add(...view.className.split(' '));
    const win = { key, view, el, titleEl };
    view.setTitle = (t) => { titleEl.textContent = t; };
    wins.set(key, win);
    layer.append(el);
    place(win);
    makeDraggable(win);
    el.addEventListener('pointerdown', () => { if (active !== key) focus(key); }, true);
    view.mount?.();
    focus(key, { silent });
    return win;
  }

  function close(key) {
    const win = wins.get(key);
    if (!win) return;
    closeProps();
    win.view.unmount?.();
    win.el.remove();
    wins.delete(key);
    if (active === key) {
      active = null;
      const next = [...wins.values()].sort((a, b) => (+b.el.style.zIndex) - (+a.el.style.zIndex))[0];
      if (next) focus(next.key); else onActiveChange?.(null);
    }
  }

  window.addEventListener('resize', () => { for (const w of wins.values()) clamp(w.el); });

  return {
    open, close, focus,
    has: (key) => wins.has(key),
    get: (key) => wins.get(key),
    get active() { return active ? wins.get(active) : null; },
    keys: () => [...wins.keys()],
  };
}
