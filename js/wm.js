// Window manager: draggable 1-bit windows on desktop, one full-screen window on phones.
//
// A "view" is { title, type, body: HTMLElement, size: {w, h}, mount?(), unmount?(), route }.
import { h, closeProps } from './ui.js';
import { prefs } from './api.js';

// interface sounds (sound.js listens; wm.js stays free of the audio code)
const sound = (name) => dispatchEvent(new CustomEvent('rn-sound', { detail: name }));
// …and window moments for the zoom outlines (life.js): { kind, el?, from?, to? } — elements or rects
const moment = (kind, detail) => dispatchEvent(new CustomEvent('rn-win', { detail: { kind, ...detail } }));

const phoneQuery = window.matchMedia('(max-width: 767px)');
const CORNER = { w: 210, h: 70 };                 // the host's badge in the bottom-right corner (Netlify: ~202×64)
export const isPhone = () => phoneQuery.matches;

export function createWM(layer, { onActiveChange, tray = null, canMinimize = () => true } = {}) {
  const wins = new Map();          // key -> { key, view, el, z }
  let z = 10;
  let active = null;
  let cascade = 0;

  function bounds() { return { w: layer.clientWidth, h: layer.clientHeight }; }
  const MIN = { w: 340, h: 240 };
  const minOf = (view) => ({ w: view.minSize?.w ?? MIN.w, h: view.minSize?.h ?? MIN.h });

  function save(win) {
    if (win.view.remember === false || isPhone()) return;
    const el = win.el;
    prefs.setJSON(`win.${win.view.type}`, {
      x: parseInt(el.style.left), y: parseInt(el.style.top), w: el.offsetWidth, h: win.shaded ? (parseInt(win.shadeH) || el.offsetHeight) : el.offsetHeight });
  }

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
    const saved = view.remember !== false ? prefs.getJSON(`win.${view.type}`) : null;
    const min = minOf(view);
    const w = Math.max(Math.min(saved?.w ?? view.size?.w ?? 560, b.w - 40), Math.min(min.w, b.w - 20));
    const ht = Math.max(Math.min(saved?.h ?? view.size?.h ?? 520, b.h - 30), Math.min(min.h, b.h - 20));
    el.style.width = `${w}px`; el.style.height = `${ht}px`;
    let x, y;
    if (saved) { x = saved.x; y = saved.y; }
    else if (view.position === 'center') { x = (b.w - w) / 2; y = Math.max(20, (b.h - ht) / 2 - 20); }
    else {
      const base = view.origin ?? { x: 40, y: 20 };
      x = base.x + (cascade % 6) * 26; y = base.y + (cascade % 6) * 22; cascade++;
    }
    el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
    clamp(el);
    fitBottom(el);
  }
  // a new window (or one on a desktop that just got shorter) keeps its bottom — where the buttons are —
  // on screen: move it up, and shrink it only if it is taller than the desktop
  function fitBottom(el) {
    if (isPhone()) return;
    const b = bounds(), top = parseInt(el.style.top) || 0, left = parseInt(el.style.left) || 0;
    if (el.offsetHeight > b.h - 8) el.style.height = `${Math.max(160, b.h - 8)}px`;
    if (top + el.offsetHeight > b.h - 4) el.style.top = `${Math.max(0, b.h - el.offsetHeight - 4)}px`;
    // …and its right edge (where 이어 쓰기 / 올리기 sit) on a narrow screen
    if (el.offsetWidth > b.w - 8) el.style.width = `${Math.max(280, b.w - 8)}px`;
    if (left + el.offsetWidth > b.w - 4) el.style.left = `${Math.max(0, b.w - el.offsetWidth - 4)}px`;
    // …and out of the bottom-right corner, where the host puts its badge (Netlify): up if there's room, else left
    const t = parseInt(el.style.top) || 0, l = parseInt(el.style.left) || 0;
    if (l + el.offsetWidth > b.w - CORNER.w && t + el.offsetHeight > b.h - CORNER.h) {
      if (b.h - CORNER.h - el.offsetHeight >= 0) el.style.top = `${b.h - CORNER.h - el.offsetHeight}px`;
      else if (b.w - CORNER.w - el.offsetWidth >= 0) el.style.left = `${b.w - CORNER.w - el.offsetWidth}px`;
    }
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
        if (parseInt(el.style.left) !== ox || parseInt(el.style.top) !== oy) { win.restore = null; save(win); }
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    // double-click the title bar: zoom to fill the desktop / restore (like the old Mac zoom box)
    bar.addEventListener('dblclick', (e) => {
      if (isPhone() || win.view.resizable === false || e.target.closest('button')) return;
      const el = win.el, b = bounds();
      if (win.restore) {
        Object.assign(el.style, win.restore); win.restore = null;
      } else {
        win.restore = { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
        Object.assign(el.style, { left: '12px', top: '12px', width: `${Math.max(minOf(win.view).w, b.w - 160)}px`, height: `${b.h - 24}px` });
      }
      clamp(el); save(win);
    });
  }

  function makeResizable(win) {
    if (win.view.resizable === false) return;
    const grip = h('span', { class: 'win-grip', 'aria-hidden': 'true', title: '크기 조절' });
    win.el.append(grip);
    grip.addEventListener('pointerdown', (e) => {
      if (isPhone() || e.button !== 0) return;
      e.preventDefault();
      const el = win.el, b = bounds(), min = minOf(win.view);
      const sx = e.clientX, sy = e.clientY, ow = el.offsetWidth, oh = el.offsetHeight;
      const left = parseInt(el.style.left) || 0, top = parseInt(el.style.top) || 0;
      grip.setPointerCapture(e.pointerId);
      el.classList.add('resizing');
      const move = (ev) => {
        el.style.width = `${Math.round(Math.min(Math.max(min.w, ow + ev.clientX - sx), b.w - left - 4))}px`;
        el.style.height = `${Math.round(Math.min(Math.max(min.h, oh + ev.clientY - sy), b.h - top - 4))}px`;
      };
      const up = () => {
        el.classList.remove('resizing');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        win.restore = null;
        save(win);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  function focus(key, { silent = false, keep = false } = {}) {
    const win = wins.get(key);
    if (!win) return;
    if (win.minimized) restore(key, { silent: true });
    if (active !== key) {
      if (active && wins.get(active)) wins.get(active).el.classList.remove('is-active');
      active = key;
      win.el.classList.add('is-active');
      closeProps();
    }
    win.el.style.zIndex = String(++z);
    if (!keep) win.view.onFocus?.();            // keep: raised by keyboard focus — don't re-render under it
    if (!silent) onActiveChange?.(win);
  }

  function open(key, factory, { silent = false } = {}) {
    if (wins.has(key)) { focus(key, { silent }); return wins.get(key); }
    const view = factory();
    const titleEl = h('h2', { id: `wt-${key.replace(/[^a-z0-9]/gi, '')}` }, view.title);
    const el = h('section', { class: 'win', 'aria-labelledby': titleEl.id, tabindex: '-1', dataset: { key } },
      h('div', { class: 'win-title' },
        view.closable === false ? h('span', { class: 'win-title-pad' })
          : h('button', { type: 'button', class: 'win-close', 'aria-label': `${view.title} 닫기`, onclick: () => close(key) }),
        titleEl,
        view.closable === false || view.minimizable === false || !canMinimize()
          ? h('span', { class: 'win-title-pad' })
          : h('button', { type: 'button', class: 'win-min', 'aria-label': `${view.title} 접어 두기`, title: '접어 두기', onclick: () => minimize(key) })),
      h('div', { class: 'win-body' }, view.body));
    if (view.className) el.classList.add(...view.className.split(' '));
    const win = { key, view, el, titleEl };
    view.setTitle = (t) => {
      titleEl.textContent = t;
      if (win.trayBtn) win.trayBtn.lastChild.textContent = t;
      win.el.querySelector('.win-min')?.setAttribute('aria-label', `${t} 접어 두기`);
      win.el.querySelector('.win-close')?.setAttribute('aria-label', `${t} 닫기`);
    };
    wins.set(key, win);
    layer.append(el);
    place(win);
    makeDraggable(win);
    makeResizable(win);
    el.addEventListener('pointerdown', () => { if (active !== key) focus(key); }, true);
    el.addEventListener('focusin', () => { if (active !== key && wins.has(key)) focus(key, { keep: true }); });   // keyboard users raise windows too
    view.mount?.();
    focus(key, { silent });
    if (!silent) { sound('open'); moment('open', { to: el }); }
    // move keyboard focus into the new window (views that focus a field do so a tick later)
    if (!silent && (document.activeElement === document.body || document.activeElement?.closest?.('.win'))) el.focus({ preventScroll: true });
    return win;
  }

  // 접어 두기: hide the window and park a button in the tray.
  function minimize(key) {
    const win = wins.get(key);
    if (!win || win.minimized || !tray || isPhone()) return;
    closeProps();
    const from = win.el.getBoundingClientRect();
    win.minimized = true;
    win.el.hidden = true;
    sound('minimize');
    win.trayBtn = h('button', { type: 'button', class: 'tray-btn', title: '다시 펼치기', onclick: () => focus(key) },
      h('span', { class: 'tray-ico', 'aria-hidden': 'true' }), h('span', {}, win.titleEl.textContent));
    tray.append(win.trayBtn);
    tray.hidden = false;
    moment('minimize', { from, to: win.trayBtn });
    if (active === key) {
      win.el.classList.remove('is-active');
      active = null;
      const next = [...wins.values()].filter(w => !w.minimized).sort((a, b) => (+b.el.style.zIndex) - (+a.el.style.zIndex))[0];
      if (next) focus(next.key); else onActiveChange?.(null);
    }
  }
  function restore(key) {
    const win = wins.get(key);
    if (!win?.minimized) return;
    win.minimized = false;
    win.el.hidden = false;
    sound('restore');
    const from = win.trayBtn?.getBoundingClientRect();
    win.trayBtn?.remove(); win.trayBtn = null;
    if (tray && !tray.children.length) tray.hidden = true;
    clamp(win.el);
    if (from?.width) moment('restore', { from, to: win.el });
  }
  // 말아 올리기 (window shade): roll a window up to its title bar, or back down.
  function shade(key) {
    const win = wins.get(key);
    if (!win || isPhone()) return;
    const el = win.el;
    if (win.shaded) {
      win.shaded = false;
      el.classList.remove('shaded');
      el.style.height = win.shadeH;
      sound('restore');
    } else {
      win.shaded = true;
      win.shadeH = el.style.height;
      el.classList.add('shaded');
      el.style.height = 'auto';
      sound('minimize');
    }
    clamp(el);
  }
  // 창 정리하기: cascade every visible window from the top-left.
  function tidy() {
    const list = [...wins.values()].filter(w => !w.minimized).sort((a, b) => (+a.el.style.zIndex) - (+b.el.style.zIndex));
    list.forEach((w, i) => {
      w.el.style.left = `${40 + i * 28}px`; w.el.style.top = `${20 + i * 24}px`;
      w.restore = null; clamp(w.el); save(w);
    });
    if (list.length) focus(list.at(-1).key);
  }

  function close(key) {
    const win = wins.get(key);
    if (!win) return;
    closeProps();
    win.trayBtn?.remove();
    if (tray && !tray.children.length) tray.hidden = true;
    const hadFocus = win.el.contains(document.activeElement);
    sound('close');
    if (!win.minimized) moment('close', { from: win.el.getBoundingClientRect() });
    win.view.unmount?.();
    win.el.remove();
    wins.delete(key);
    if (active === key) {
      active = null;
      const next = [...wins.values()].filter(w => !w.minimized).sort((a, b) => (+b.el.style.zIndex) - (+a.el.style.zIndex))[0];
      if (next) { focus(next.key); if (hadFocus) next.el.focus({ preventScroll: true }); } else onActiveChange?.(null);
    }
  }

  window.addEventListener('resize', () => { for (const w of wins.values()) { clamp(w.el); if (!w.minimized && !w.shaded) fitBottom(w.el); } });

  return {
    open, close, focus, minimize, restore, tidy, shade,
    isShaded: (key) => !!wins.get(key)?.shaded,
    minimizeAll: () => { for (const k of [...wins.keys()]) minimize(k); },
    has: (key) => wins.has(key),
    get: (key) => wins.get(key),
    get active() { return active ? wins.get(active) : null; },
    keys: () => [...wins.keys()],
    wins: () => [...wins.values()],
  };
}
