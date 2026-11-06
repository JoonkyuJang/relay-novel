// 문냥이: the desktop cat. Pixel sprites drawn to tiny canvases, simple wandering,
// title-bar naps, petting (shared counter), rare wink, belly-up, reach, hiss, jump,
// watching you type (ears twitch at the carriage return), naps on the newest 완결 seal.
import * as api from '../api.js';
import { h } from '../ui.js';
import { isPhone } from '../wm.js';
import { SPRITES } from './cat-sprites.js';
import { on, X, fun, bus, reduceMotion, deadlineHour } from './extras.js';
import { play, voice, soundOn } from './sound.js';
import { currentPhase } from './daynight.js';
import { getTrashCount, pullBallOut } from './bin.js';
import { stampSvg } from './stamps.js';

// ---------------------------------------------------------------- 고양이 선물 (kept on this device)

const GIFT_ART = {
  ginkgo:  { name: '은행잎', color: '#E8B931', rows: ['.#####..', '#######.', '#######.', '.#####..', '..###...', '...#....', '...#....'] },
  maple:   { name: '단풍잎', color: '#D9774F', rows: ['...#...', '.#.#.#.', '#######', '.#####.', '..###..', '.#.#.#.', '...#...'] },
  feather: { name: '깃털', color: '#9AA6C6', rows: ['....##', '...###', '..###.', '.###..', '###...', '#.....'] },
  button:  { name: '단추', color: '#C8553D', rows: ['.####.', '#....#', '#.##.#', '#.##.#', '#....#', '.####.'] },
  pencil:  { name: '몽당연필', color: '#E9A04A', rows: ['......##', '.....###', '....###.', '...###..', '..###...', '.###....', '##......'] },
};
const STAMP_GIFTS = ['sun', 'laugh', 'cur'];
export const GIFT_NAMES = { ...Object.fromEntries(Object.entries(GIFT_ART).map(([k, v]) => [k, v.name])), sun: '참 잘했어요 도장', laugh: '재밌어요 도장', cur: '다음이 궁금해요 도장', ball: '종이 공' };
export function giftArt(kind, size = 20) {
  if (STAMP_GIFTS.includes(kind)) return stampSvg(kind, { size });
  if (kind === 'ball') return h('i', { class: 'floor-ball', style: 'position:static;display:inline-block;width:14px;height:13px' });
  const { rows, color } = GIFT_ART[kind];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
  svg.setAttribute('width', size); svg.setAttribute('height', Math.round(size * rows.length / rows[0].length));
  svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('aria-hidden', 'true');
  let d = ''; rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') d += `M${x} ${y}h1v1h-1z`; }));
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); path.setAttribute('fill', color);
  svg.append(path);
  return svg;
}
export const myGifts = () => api.prefs.getJSON('gifts') ?? {};

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

// ear twitch frames, derived from the generated ones (the right ear flicks flat)
function twitch(rows) {
  const r = rows.slice();
  const put = (y, x, str) => { r[y] = r[y].slice(0, x) + str + r[y].slice(x + str.length); };
  put(2, 17, '.'); put(3, 16, '.ooo'); put(4, 16, 'wpp');
  return r;
}
SPRITES.sitEar = twitch(SPRITES.sit);
SPRITES.lookEar = twitch(SPRITES.look);

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
  let state = 'sit';                // sit | walk | nap | belly | pet | busy | look | reach | watch | away
  let frameName = 'sit';
  let napWin = null, napAt = null, napSeal = null;
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
    // the deadline's last hour: the cat paces back and forth
    const pace = on('deadline_fireworks') && deadlineHour();
    if (on('cat_wander') && r < (pace ? 0.8 : 0.42)) walkTo(rand(60, desktop.clientWidth - 160), pace ? { speed: 70 } : undefined);
    else if (on('cat_wander') && r < 0.64 && wins.length) napOn(wins[Math.floor(Math.random() * wins.length)]);
    else if (on('cat_seal_nap') && r < 0.76 && sealSpot()) napOnSeal();
    else if (on('cat_belly') && r < 0.84) belly();
    else if (on('cat_wander') && on('trash') && r < 0.88 && getTrashCount() > 0 && document.querySelector('#icons .icon.trash')?.offsetParent) digTrash();
    else if (on('cat_mischief') && r < 0.92) mischief();
    else sit();
  }

  // ---------------------------------------------------------- 장난: nudge the sticky note, knock the bin over, bat the tray
  function mischief() {
    const d = desktop.getBoundingClientRect();
    const trash = document.querySelector('#icons .icon.trash');
    const sticky = document.querySelector('.sticky:not([hidden])');
    const tray = document.querySelector('.tray:not([hidden]) .tray-btn');
    const options = [
      sticky && ['sticky', sticky], sticky && ['sticky', sticky],
      tray && ['tray', tray], tray && ['tray', tray],
      on('trash') && trash?.offsetParent && ['trash', trash],
    ].filter(Boolean);
    if (!options.length) { sit(); return; }
    const [kind, target] = options[Math.floor(Math.random() * options.length)];
    const r = (kind === 'trash' ? target.querySelector('svg') : target).getBoundingClientRect();
    const right = kind === 'trash';                                // the bin is at the right edge: come from its left
    const tx = Math.min(desktop.clientWidth - 40, Math.max(40, (right ? r.left - 30 : r.right + 26) - d.left));
    walkTo(tx, { then: () => {
      clearTimers(); state = 'busy';
      flip = !right; img.style.transform = flip ? 'scaleX(-1)' : '';
      setFrame('reach'); el.classList.add('reaching');
      later(() => {
        el.classList.remove('reaching');
        if (kind === 'sticky') {                                  // a little shove, and it stays shoved (this visit)
          const [dx, rot] = [(Number(target.dataset.dx) || 0) + 10 + Math.round(Math.random() * 14), (Math.random() * 6 - 3).toFixed(1)];
          target.dataset.dx = Math.min(dx, 160);
          target.style.translate = `${target.dataset.dx}px 0`;
          target.style.rotate = `${rot}deg`;
          play('lid');
          setFrame('happy'); later(sit, 1400);
        } else if (kind === 'tray') {
          target.classList.remove('batted'); void target.offsetWidth; target.classList.add('batted');
          play('select');
          setFrame('happy'); later(sit, 1400);
        } else {                                                  // over it goes — and the cat bolts
          bus.emit('trash-knock', { el: target });
          say('!', 900);
          later(() => { state = 'sit'; api_.run(); }, 200);
        }
      }, 600);
    } });
  }

  // ---------------------------------------------------------- 선물: now and then something is left on the floor
  function dropGift() {
    const kinds = [...Object.keys(GIFT_ART), ...STAMP_GIFTS, 'ball', 'ginkgo', 'ginkgo', 'maple'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const gx = Math.max(16, Math.min(desktop.clientWidth - 30, isPhone() ? x - W / 2 - 24 : x + (flip ? 30 : -46)));
    const gift = h('button', { type: 'button', class: 'cat-gift', 'aria-label': `${X('cat_name')}의 선물: ${GIFT_NAMES[kind]} (누르면 줍기)`, title: `${GIFT_NAMES[kind]} · 누르면 주워요` }, giftArt(kind, 18));
    Object.assign(gift.style, { left: `${Math.round(gx)}px`, top: `${Math.round(floorY() - 20)}px` });
    layer.append(gift);
    api.prefs.set('giftAt', String(Date.now()));
    play('pop');
    say('♪', 1200);
    gift.addEventListener('click', (e) => {
      e.stopPropagation();
      const g = myGifts(); g[kind] = (g[kind] ?? 0) + 1; api.prefs.setJSON('gifts', g);
      const f = h('span', { class: 'gift-got', 'aria-hidden': 'true' }, `+1 ${GIFT_NAMES[kind]}`);
      f.style.left = gift.style.left; f.style.top = `${parseInt(gift.style.top) - 18}px`;
      layer.append(f); setTimeout(() => f.remove(), 1500);
      play('select');
      gift.remove();
    });
  }
  // every minute or so, a small chance — at most one gift every 20 minutes on this device
  setInterval(() => {
    if (!on('cat') || !on('cat_gifts') || el.hidden || document.hidden || !api.hasEntered()) return;
    if (!['sit', 'look'].includes(state) || layer.querySelector('.cat-gift')) return;
    if (Date.now() - Number(api.prefs.get('giftAt') ?? 0) < 20 * 60e3) return;
    if (Math.random() < 1 / 25) dropGift();
  }, 60e3);

  // 휴지통 뒤지기: walk to the bin, fish a paper ball out and bat it along the floor a few times
  function digTrash() {
    const bin = document.querySelector('#icons .icon.trash svg');
    if (!bin) { sit(); return; }
    const d = desktop.getBoundingClientRect(), br = bin.getBoundingClientRect();
    const tx = Math.min(desktop.clientWidth - 40, Math.max(60, br.left - d.left + br.width / 2 - 30));
    walkTo(tx, { then: () => {
      clearTimers(); state = 'busy';
      flip = false; img.style.transform = '';
      setFrame('reach'); el.classList.add('reaching');
      later(() => {
        el.classList.remove('reaching');
        const m = pullBallOut();
        if (!m) { sit(); return; }
        const ball = h('i', { class: 'floor-ball', 'aria-hidden': 'true' });
        layer.append(ball);
        setTimeout(() => ball.remove(), 14000);                   // (whatever happens to the cat)
        const fy = floorY() - 15;
        let bx = x - 34;
        const sx = m.x - d.left, sy = m.y - d.top;
        Object.assign(ball.style, { left: `${Math.round(sx - 8)}px`, top: `${Math.round(sy - 8)}px` });
        // it pops out over the rim and drops to the floor in front of the cat
        const N = 8;
        ball.animate(Array.from({ length: N + 1 }, (_, i) => {
          const t = i / N, u = 1 - t, peak = Math.min(sy, fy) - 40;
          return { transform: `translate(${Math.round((bx - sx) * t)}px, ${Math.round(u * u * sy + 2 * u * t * peak + t * t * fy - sy)}px) rotate(${i * 50}deg)`, offset: t, easing: 'steps(1, end)' };
        }), { duration: 480, fill: 'forwards' });
        setFrame('look'); flip = true; img.style.transform = 'scaleX(-1)';
        let hits = 2 + Math.floor(Math.random() * 2);
        const bat = () => {
          if (state !== 'busy' || !hits--) { if (state === 'busy') sit(); return; }
          setFrame('reach');
          play('pop');
          const to = Math.max(30, bx - 50 - Math.random() * 60);
          const from = bx;
          ball.getAnimations().forEach(a => a.cancel());
          Object.assign(ball.style, { left: `${Math.round(from - 8)}px`, top: `${fy}px` });
          ball.animate(Array.from({ length: 7 }, (_, i) => ({ transform: `translate(${Math.round((to - from) * i / 6)}px, ${i % 2 ? -4 : 0}px) rotate(${-i * 60}deg)`, offset: i / 6, easing: 'steps(1, end)' })),
            { duration: 420, fill: 'forwards' });
          bx = to;
          later(() => { if (state === 'busy') walkTo(bx + 30, { speed: 90, then: () => { clearTimers(); state = 'busy'; flip = true; img.style.transform = 'scaleX(-1)'; setFrame('look'); later(bat, 700); } }); }, 450);
        };
        later(bat, 900);
      }, 650);
    } });
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
  // the newest 완결 seal in the 이야기 서랍, if it's in view and nothing covers it
  function sealSpot() {
    const win = wm.get('stories');
    if (!win || win.minimized || isPhone()) return null;
    const seal = win.el.querySelector('.done-card-seal');
    const scroller = win.el.querySelector('.win-scroll');
    if (!seal || !scroller) return null;
    const r = seal.getBoundingClientRect(), sc = scroller.getBoundingClientRect(), d = desktop.getBoundingClientRect();
    if (!r.width) return null;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (r.top < sc.top || r.bottom > sc.bottom) return null;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !seal.contains(hit)) return null;
    return { win, x: Math.round(cx - d.left), y: Math.round(r.top - d.top + r.height * 0.8) };
  }
  function napOnSeal() {
    const spot = sealSpot();
    if (!spot || spot.y < H + 6) { sit(); return; }
    walkTo(spot.x, { then: () => {
      const again = sealSpot();
      if (!again) { sit(); return; }
      hopTo(again.x, again.y, () => {
        clearTimers();
        state = 'nap'; napWin = again.win; napSeal = again;
        napAt = { left: parseInt(again.win.el.style.left) || 0, top: parseInt(again.win.el.style.top) || 0 };
        setFrame('sleep');
        el.classList.add('napping');
        anim = setInterval(watchNap, 500);
        later(wake, rand(40e3, 100e3));
      });
    } });
  }
  function watchNap() {
    if (state !== 'nap') return;
    if (napSeal) {                                   // the drawer re-draws its cards: follow the spot, not the element
      const s2 = sealSpot();
      if (!s2 || Math.abs(s2.x - napSeal.x) > 3 || Math.abs(s2.y - napSeal.y) > 3) wake();
      return;
    }
    const w = napWin, gone = !w || !w.el.isConnected || w.minimized;
    if (gone || parseInt(w.el.style.left) !== napAt.left || parseInt(w.el.style.top) !== napAt.top) wake();
  }
  function wake() {
    if (state !== 'nap') return;
    el.classList.remove('napping');
    napWin = null; napSeal = null;
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
    float('♥\uFE0E');
    let n = null;
    try { n = Number(await api.petCat()); } catch { /* still a happy cat */ }
    const counted = n && on('cat_pet_count');
    if (n && on('cat_wink') && n % 100 === 0) {
      setFrame('wink');
      play('chime');
      say(['야옹~', h('br'), h('small', {}, `(${n.toLocaleString('ko-KR')}번째!)`)], 3200, 'rare');
      float('✦', 'spark'); later(() => float('✦', 'spark'), 300); later(() => float('♥\uFE0E'), 600);
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
      later(() => { el.classList.remove('shake'); napWin = null; napSeal = null; place(x, floorY()); sit(); }, 2600);
    },
    run() {                                        // 방명록 "야옹": dash to the other side
      if (state === 'away' || isPhone()) return;
      el.classList.remove('napping'); napWin = null; napSeal = null;
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
    // (for tests: make these happen now)
    gift: () => dropGift(),
    mischief: () => mischief(),
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

  // ---------------------------------------------------------- watching you write

  let typedAt = 0, keyTimes = [], lastBat = 0;
  function watchTyping(field) {
    const d = desktop.getBoundingClientRect(), r = field.getBoundingClientRect();
    const tx = Math.min(desktop.clientWidth - 60, Math.max(40, r.left - d.left + r.width * rand(0.25, 0.75)));
    const settle = () => {
      clearTimers();
      state = 'watch';
      flip = (r.left + r.width / 2 - d.left) < x;
      setFrame('look');
      img.style.transform = flip ? 'scaleX(-1)' : '';
      anim = setInterval(() => { if (state === 'watch' && Date.now() - typedAt > 8000) sit(); }, 700);
    };
    if (Math.abs(tx - x) < 40) settle(); else walkTo(tx, { speed: 70, then: settle });
  }
  function bat() {
    if (state !== 'watch' || Date.now() - lastBat < 2500 || !on('cat_reach')) return;
    lastBat = Date.now();
    setFrame('reach');
    el.classList.add('reaching');
    later(() => { el.classList.remove('reaching'); if (state === 'watch') { setFrame('look'); img.style.transform = flip ? 'scaleX(-1)' : ''; } }, 650);
  }
  document.addEventListener('input', (e) => {
    if (!on('cat') || !on('cat_typing') || isPhone() || el.hidden || document.hidden) return;
    const t = e.target;
    if (!t?.matches?.('textarea, input:not([type]), input[type="text"]') || !t.closest('.win')) return;
    const now = Date.now();
    typedAt = now;
    keyTimes = keyTimes.filter(k => now - k < 1500); keyTimes.push(now);
    if (state === 'watch') { if (keyTimes.length >= 10) bat(); return; }
    if (state === 'sit' || state === 'look') watchTyping(t);
  }, true);
  // the carriage return: ears twitch
  bus.on('carriage', () => {
    if (el.hidden || !['sit', 'look', 'watch'].includes(state)) return;
    const base = state === 'sit' ? 'sit' : 'look', ear = base === 'sit' ? 'sitEar' : 'lookEar';
    [[0, ear], [140, base], [260, ear], [400, base]].forEach(([ms, f]) => setTimeout(() => {
      if (['sit', 'look', 'watch'].includes(state)) { setFrame(f); img.style.transform = flip ? 'scaleX(-1)' : ''; }
    }, ms + 250));
  });

  // ---------------------------------------------------------- the 휴지통

  const idle = () => ['sit', 'look', 'watch'].includes(state) && !el.hidden;
  const faceX = (px) => { flip = (px - desktop.getBoundingClientRect().left) < x; img.style.transform = flip ? 'scaleX(-1)' : ''; };
  // a paper ball flies: follow it with the eyes
  bus.on('paper-toss', ({ to }) => {
    if (!idle()) return;
    if (state !== 'watch') { clearTimers(); state = 'look'; later(sit, 3200); }
    setFrame('look'); faceX(to.x);
  });
  // it lands: a startled "!" — on the desktop, sometimes a walk over to look into the bin
  bus.on('paper-landed', ({ x: bx }) => {
    if (!idle()) return;
    faceX(bx);
    if (isPhone()) {
      el.classList.remove('startle'); void el.offsetWidth; el.classList.add('startle');
      say('!', 900);
      setTimeout(() => el.classList.remove('startle'), 500);
      return;
    }
    if (state !== 'watch' && on('cat_wander') && Math.random() < 0.4) {
      const tx = Math.min(desktop.clientWidth - 60, Math.max(40, bx - desktop.getBoundingClientRect().left - 30));
      walkTo(tx, { speed: 80, then: () => {
        clearTimers(); state = 'look'; setFrame('look'); faceX(bx);
        say('?', 1400);
        later(sit, 4000);
      } });
    } else {
      say('!', 900);
    }
  });
  // 와르르: the bin tips over — the cat bolts (desktop) or jumps (phone, it's right next to it)
  bus.on('trash-dblclick', () => {
    if (!fun('fun_trash') || el.hidden || state === 'away') return;
    if (isPhone()) api_.jump(); else setTimeout(() => api_.run(), 250);
  });

  el.addEventListener('click', (e) => { e.stopPropagation(); pet(); });
  el.addEventListener('yawn', () => { if (!el.hidden) { say('하암~', 1800); play('yawn'); } });

  // stop whatever the cat was doing (nap on a window, walk, hop…)
  function reset() {
    clearTimers();
    el.classList.remove('napping', 'hop', 'wiggle', 'reaching', 'shake', 'jumping', 'squish');
    napWin = null; napSeal = null;
  }
  // place on the floor (desktop) or on the dock (phone)
  function home() {
    el.hidden = !on('cat') || (isPhone() && !on('cat_phone'));
    el.title = X('cat_name');
    el.setAttribute('aria-label', `${X('cat_name')} 쓰다듬기`);
    document.body.classList.toggle('cat-phone', isPhone() && !el.hidden);   // phone windows leave it a gap above the dock
    if (el.hidden) { reset(); state = 'sit'; return; }
    // (on a phone it sits at the right of the dock — or just left of the 휴지통 when that's there too)
    const fx = isPhone() ? desktop.clientWidth - W - 10 - (document.body.classList.contains('bin-phone') ? 44 : 0) : Math.min(desktop.clientWidth - 150, Math.max(80, x || desktop.clientWidth * 0.6));
    if (state === 'nap' && !isPhone() && anim) return;     // still napping on a window: leave it be
    reset();
    place(fx, floorY());
    flip = isPhone();
    sit();
  }
  // the desktop changes size without a window resize too: entering the site on a phone (the dock
  // appears), the keyboard, the admin hiding the dock… — re-home the cat whenever it does
  let lastSize = '', homeT = null;
  new ResizeObserver(() => {
    const size = `${desktop.clientWidth}x${desktop.clientHeight}`;
    if (size === lastSize) return;
    lastSize = size;
    clearTimeout(homeT);
    homeT = setTimeout(() => { if (state !== 'nap' && state !== 'away') home(); }, 120);
  }).observe(desktop);
  bus.on('settings', home);
  bus.on('theme', () => api_.refresh());
  bus.on('story-completed', () => api_.jump());
  home();
  return api_;
}
