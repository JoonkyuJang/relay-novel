// 문냥이: the desktop cat. Pixel sprites drawn to tiny canvases, simple wandering,
// title-bar naps, petting (shared counter), rare wink, belly-up, reach, hiss, jump.
import * as api from '../api.js';
import { h } from '../ui.js';
import { isPhone } from '../wm.js';
import { SPRITES } from './cat-sprites.js';
import { on, X, bus, reduceMotion } from './extras.js';
import { play, voice, soundOn } from './sound.js';
import { currentPhase } from './daynight.js';

export const PALETTES = {
  day:   { o: '#1D2A44', e: '#1D2A44', w: '#FFFBF4', c: '#D9774F', k: '#6B7591', p: '#E58AA6' },
  night: { o: '#9AA6C6', e: '#1D2A44', w: '#FFFBF4', c: '#D9774F', k: '#6B7591', p: '#E58AA6' },
  amber: { o: '#FFB000', e: '#FFB000', w: '#2A1D08', c: '#C98A00', k: '#6E4A00', p: '#FFD266' },
};
const cache = new Map();
export function catFrame(name, pal = 'day') {
  const key = `${name}|${pal}`;
  if (cache.has(key)) return cache.get(key);
  const rows = SPRITES[name], colors = PALETTES[pal];
  const c = document.createElement('canvas');
  c.width = rows[0].length; c.height = rows.length;
  const g = c.getContext('2d');
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { g.fillStyle = colors[ch]; g.fillRect(x, y, 1, 1); } }));
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}
export function catImg(name, { scale = 2, pal = 'day', cls = '' } = {}) {
  const rows = SPRITES[name];
  return h('img', { class: `cat-img ${cls}`, src: catFrame(name, pal), width: rows[0].length * scale, height: rows.length * scale, alt: '', draggable: false });
}

const rand = (a, b) => a + Math.random() * (b - a);
const SCALE = 2;
const W = 26 * SCALE, H = 22 * SCALE;

export function initCat(app, wm, desktop) {
  const layer = h('div', { class: 'cat-layer' });
  const img = h('img', { class: 'cat-img', alt: '', width: W, height: H, draggable: false });
  const bubble = h('div', { class: 'cat-say', hidden: true, 'aria-live': 'polite' });
  const el = h('button', { type: 'button', class: 'cat', 'aria-label': '고양이 쓰다듬기' }, img, bubble);
  layer.append(el);
  desktop.append(layer);

  let x = 0, y = 0;                 // centre x, bottom y (px inside the desktop)
  let flip = false;                 // true = facing left (sprites face right)
  let state = 'sit';                // sit | walk | nap | belly | pet | busy | look | reach | away
  let frameName = 'sit';
  let napWin = null, napAt = null;
  let timers = [];
  let anim = null;
  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; clearInterval(anim); anim = null; };

  const floorY = () => desktop.clientHeight - 2;
  const palette = () => document.body.classList.contains('amber') ? 'amber'
    : (state === 'nap' || currentPhase() !== 'night') ? 'day' : 'night';

  function setFrame(name) {
    frameName = name;
    const rows = SPRITES[name];
    img.src = catFrame(name, palette());
    img.width = rows[0].length * SCALE; img.height = rows.length * SCALE;
  }
  function place(nx, ny, { animate = 0 } = {}) {
    x = nx; y = ny;
    el.style.transition = animate ? `left ${animate}ms linear, top ${animate}ms linear` : 'none';
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y - H)}px`;
    img.style.transform = flip ? 'scaleX(-1)' : '';
  }
  function say(text, ms = 2200, cls = '') {
    bubble.className = `cat-say ${cls}`;
    bubble.replaceChildren(...[text].flat());
    bubble.hidden = false;
    clearTimeout(say.t);
    say.t = setTimeout(() => { bubble.hidden = true; }, ms);
  }
  function float(text, cls = 'heart') {
    const f = h('span', { class: `cat-float ${cls}`, 'aria-hidden': 'true' }, text);
    el.append(f);
    setTimeout(() => f.remove(), 1600);
  }

  // ---------------------------------------------------------- behaviours

  function sit() {
    clearTimers();
    state = 'sit';
    setFrame('sit');
    let t = 0;
    anim = setInterval(() => {
      t++;
      if (state !== 'sit') return;
      if (t % 7 === 0) { setFrame('blink'); setTimeout(() => state === 'sit' && setFrame('sit'), 160); }
      else setFrame(t % 2 ? 'sitT' : 'sit');
    }, 1100);
    later(decide, rand(5000, 11000));
  }

  function decide() {
    if (state !== 'sit' || document.hidden || isPhone()) { later(decide, 8000); return; }
    const r = Math.random();
    const wins = wm.wins().filter(w => !w.minimized && w.el.offsetWidth > 200 && w.view.type !== 'login');
    if (on('cat_wander') && r < 0.45) walkTo(rand(60, desktop.clientWidth - 160));
    else if (on('cat_wander') && r < 0.7 && wins.length) napOn(wins[Math.floor(Math.random() * wins.length)]);
    else if (on('cat_belly') && r < 0.8) belly();
    else sit();
  }

  function walkTo(tx, { speed = 45, then = sit } = {}) {
    clearTimers();
    state = 'walk';
    flip = tx < x;
    const dist = Math.abs(tx - x);
    const ms = (dist / speed) * 1000;
    let f = 0;
    setFrame('walk1');
    anim = setInterval(() => { f++; setFrame(f % 2 ? 'walk2' : 'walk1'); }, speed > 60 ? 120 : 200);
    place(tx, floorY(), { animate: ms });
    later(() => { clearInterval(anim); anim = null; place(tx, floorY()); then(); }, ms + 30);
  }

  function napOn(win) {
    // walk under it, hop up onto the title bar
    const r = win.el;
    const left = parseInt(r.style.left) || 0, top = parseInt(r.style.top) || 0, width = r.offsetWidth;
    const tx = left + rand(Math.min(80, width / 3), width - 60);
    if (top < H + 6) { sit(); return; }
    walkTo(tx, { then: () => hopTo(tx, top + 2, () => {
      clearTimers();
      state = 'nap'; napWin = win; napAt = { left, top };
      setFrame('sleep');
      el.classList.add('napping');
      anim = setInterval(watchNap, 500);
      later(wake, rand(60e3, 150e3));
    }) });
  }
  function watchNap() {
    if (state !== 'nap') return;
    const w = napWin, gone = !w || !w.el.isConnected || w.minimized;
    if (gone || parseInt(w.el.style.left) !== napAt.left || parseInt(w.el.style.top) !== napAt.top) wake();
  }
  function wake() {
    if (state !== 'nap') return;
    el.classList.remove('napping');
    napWin = null;
    hopTo(x + (flip ? -30 : 30), floorY(), sit);
  }
  function hopTo(tx, ty, done) {
    clearTimers();
    state = 'busy';
    setFrame('jump');
    flip = tx < x;
    el.classList.add('hop');
    place(tx, ty, { animate: 380 });
    later(() => { el.classList.remove('hop'); setFrame('sit'); done(); }, 420);
  }

  function belly() {
    clearTimers();
    state = 'belly';
    let f = 0;
    setFrame('belly1');
    el.classList.add('wiggle');
    anim = setInterval(() => { f++; setFrame(f % 2 ? 'belly2' : 'belly1'); }, 500);
    later(() => { el.classList.remove('wiggle'); sit(); }, rand(4500, 7000));
  }

  let lastPet = 0;
  async function pet() {
    if (Date.now() - lastPet < 650 || state === 'away') return;
    lastPet = Date.now();
    const wasNap = state === 'nap';
    clearTimers();
    el.classList.remove('wiggle', 'napping');
    state = 'pet';
    setFrame('happy');
    if (!reduceMotion()) { el.classList.remove('squish'); void el.offsetWidth; el.classList.add('squish'); }
    play(wasNap ? 'purr' : 'meow');
    float('♥');
    let n = null;
    try { n = Number(await api.petCat()); } catch { /* still a happy cat */ }
    const counted = n && on('cat_pet_count');
    if (n && on('cat_wink') && n % 100 === 0) {
      setFrame('wink');
      play('chime');
      say(['야옹~', h('br'), h('small', {}, `(${n.toLocaleString('ko-KR')}번째!)`)], 3200, 'rare');
      float('✦', 'spark'); later(() => float('✦', 'spark'), 300); later(() => float('♥'), 600);
    } else {
      say(counted ? ['야옹!', h('br'), h('small', {}, `(${n.toLocaleString('ko-KR')})`)] : '야옹!', 2000);
    }
    later(() => { el.classList.remove('squish'); if (wasNap && napWin?.el?.isConnected) { state = 'nap'; setFrame('sleep'); anim = setInterval(watchNap, 500); } else sit(); }, n && n % 100 === 0 ? 3200 : 1800);
  }

  // ---------------------------------------------------------- reactions (also used by surprises)

  const api_ = {
    el,
    get state() { return state; },
    get napWin() { return napWin; },
    jump() {
      if (!on('cat_jump') || state === 'away') return;
      clearTimers(); state = 'busy';
      setFrame('jump');
      el.classList.remove('jumping'); void el.offsetWidth; el.classList.add('jumping');
      play('mrrp');
      later(() => { el.classList.remove('jumping'); state === 'busy' && (napWin ? (state = 'nap', setFrame('sleep'), anim = setInterval(watchNap, 500)) : sit()); }, 1100);
    },
    hiss() {
      if (state === 'away') return;
      clearTimers(); state = 'busy';
      el.classList.remove('napping');
      setFrame('hiss');
      el.classList.add('shake');
      play('hiss');
      say('하악!', 2400, 'hiss');
      later(() => { el.classList.remove('shake'); napWin = null; place(x, floorY()); sit(); }, 2600);
    },
    run() {                                        // 방명록 "야옹": dash to the other side
      if (state === 'away' || isPhone()) return;
      el.classList.remove('napping'); napWin = null;
      say('!', 1200);
      place(x, floorY());
      const tx = x < desktop.clientWidth / 2 ? desktop.clientWidth - 140 : 80;
      walkTo(tx, { speed: 260 });
    },
    readLine(text) {                               // napping cat reads the last line in beeps
      const chars = [...text];
      const shown = h('span', {});
      say([shown], 99999, 'reading');
      let i = 0;
      const v = voice(text, 'cat', { pitch: 1.9 });
      const t = setInterval(() => {
        if (i >= chars.length) { clearInterval(t); setTimeout(() => { bubble.hidden = true; }, 2500); return; }
        shown.textContent += chars[i];
        v.say(i);
        i++;
      }, soundOn() ? 85 : 55);
    },
    hide() { reset(); state = 'away'; el.hidden = true; },
    show() { state = 'sit'; home(); },
    look(dir) { if (state === 'sit') { flip = dir < 0; setFrame('look'); img.style.transform = flip ? 'scaleX(-1)' : ''; } },
    refresh() { setFrame(frameName); },
  };

  // cursor: look at it when near, stretch up when it hovers over the head
  let lookT = null;
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !on('cat') || el.hidden) return;
    if (!['sit', 'look', 'reach'].includes(state)) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const near = Math.hypot(dx, dy) < 170;
    const over = e.clientX > r.left - 8 && e.clientX < r.right + 8 && e.clientY > r.top - 30 && e.clientY < r.top + r.height * 0.55;
    if (over && on('cat_reach')) {
      if (state !== 'reach') { clearInterval(anim); anim = null; state = 'reach'; setFrame('reach'); el.classList.add('reaching'); }
    } else if (near) {
      if (state === 'reach') el.classList.remove('reaching');
      if (state !== 'look') { clearInterval(anim); anim = null; state = 'look'; }
      flip = dx < 0; setFrame('look'); img.style.transform = flip ? 'scaleX(-1)' : '';
    } else if (state === 'look' || state === 'reach') {
      el.classList.remove('reaching');
      clearTimeout(lookT);
      lookT = setTimeout(() => { if (state === 'look' || state === 'reach') sit(); }, 300);
    }
  }, { passive: true });

  el.addEventListener('click', (e) => { e.stopPropagation(); pet(); });
  el.addEventListener('yawn', () => { if (!el.hidden) { say('하암~', 1800); play('yawn'); } });

  // stop whatever the cat was doing (nap on a window, walk, hop…)
  function reset() {
    clearTimers();
    el.classList.remove('napping', 'hop', 'wiggle', 'reaching', 'shake', 'jumping', 'squish');
    napWin = null;
  }
  // place on the floor (desktop) or on the dock (phone)
  function home() {
    el.hidden = !on('cat') || (isPhone() && !on('cat_phone'));
    el.title = X('cat_name');
    el.setAttribute('aria-label', `${X('cat_name')} 쓰다듬기`);
    document.body.classList.toggle('cat-phone', isPhone() && !el.hidden);   // phone windows leave it a gap above the dock
    if (el.hidden) { reset(); state = 'sit'; return; }
    const fx = isPhone() ? desktop.clientWidth - W - 10 : Math.min(desktop.clientWidth - 150, Math.max(80, x || desktop.clientWidth * 0.6));
    if (state === 'nap' && !isPhone() && anim) return;     // still napping on a window: leave it be
    reset();
    place(fx, floorY());
    flip = isPhone();
    sit();
  }
  addEventListener('resize', () => { if (state !== 'nap') home(); });
  bus.on('settings', home);
  bus.on('theme', () => api_.refresh());
  bus.on('story-completed', () => api_.jump());
  home();
  return api_;
}
