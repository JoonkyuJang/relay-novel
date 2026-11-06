// 학생회관 (207) + 낙엽 · 첫눈. A pixel picture of the Student Union Building along the bottom of the
// desktop, behind the icons. Colours follow the sky (css: body.phase-*); at dusk and at night
// some windows are lit — always the club room. Trees follow the season (가을 은행잎 / 첫눈).
// Drawn once into a colour grid, painted into a small canvas (css scales it up, pixelated).

import { h } from '../ui.js';
import { isPhone } from '../wm.js';
import { on, bus, kst, winter, reduceMotion, X, deadlineDay } from './extras.js';
import { play } from './sound.js';

const W = 640, H = 110, GY = 100;          // grid size; plaza starts at GY
const SVGNS = 'http://www.w3.org/2000/svg';

// colour codes → css class (colours live in extras.css)
const C = { b: 1, l: 2, w: 3, g: 4, d: 5, p: 6, s: 7, st: 8, t: 9, t2: 10, k: 11, f: 12, fw: 13, gr: 14, pv: 15, sr: 16, fl: 17, gl: 18, m: 19, sn: 20 };
const NAMES = Object.fromEntries(Object.entries(C).map(([k, v]) => [v, k]));

// tiny deterministic random (same picture every load)
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

const DIGITS = {
  2: ['###', '..#', '###', '#..', '###'],
  0: ['###', '#.#', '#.#', '#.#', '###'],
  7: ['###', '..#', '..#', '.#.', '.#.'],
};

// facade geometry (shared with the lit-window layer)
const PITCH = 6, BAYS = 40, FX0 = 199, FX1 = FX0 + BAYS * PITCH + 1;   // 199..439
const ROWS = [27, 41, 55];                                           // tops of the three window storeys
const winX = (i) => FX0 + 2 + i * PITCH;                             // 3 wide
// one bay of the tracery, 6 × 14: pointed arches over the windows, joining in a Y over each pier
const TILE = [
  '...l..',
  '..l.l.',
  '.l.w.l',
  '.lwwwl',
  '.lwwwl',
  '.lwwwl',
  '.lllll',
  '.lwwwl',
  '.lwwwl',
  '.lwwwl',
  '.lwwwl',
  'l.lll.',
  'l.....',
  'l.....',
];
export const CLUB = { row: 1, bay: 9 };                              // 연문회 동아리방 (a window that's always lit at night)

function draw() {
  const g = new Uint8Array(W * H);
  const set = (x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < H) g[y * W + x] = c; };
  const rect = (x, y, w, hgt, c) => { for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c); };
  const disc = (cx, cy, r, c, rnd = null) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const d = (x * x + y * y) / (r * r);
      if (d <= 1 && (!rnd || d < 0.8 || rnd() > 0.5)) set(cx + x, cy + y, c);
    }
  };
  const R = rng(207);

  // ---- back: a hill of old trees on the left (behind 207-A), shaded canopy
  for (let i = 0; i < 26; i++) {
    const cx = 20 + R() * 190, cy = 52 + R() * 30, r = 9 + Math.round(R() * 9);
    disc(Math.round(cx), Math.round(cy), r, C.t, R);
  }
  for (let i = 0; i < 40; i++) {                       // darker leaf clumps for texture
    const cx = 20 + R() * 190, cy = 58 + R() * 32;
    disc(Math.round(cx), Math.round(cy), 2 + Math.round(R() * 3), C.t2, R);
  }
  rect(0, 86, 215, 14, C.t);                            // canopy meets the ground

  // ---- right: Severance tower (curved crown) + an office block + a glass box
  const tx0 = 474, tx1 = 532;
  rect(tx0, 6, tx1 - tx0, GY - 6, C.f);
  for (let y = 6; y < 22; y++) {                        // the rounded corner of the crown
    const bulge = Math.round(Math.sqrt(Math.max(0, 1 - ((y - 14) / 8) ** 2)) * 6);
    rect(tx1, y, bulge, 1, C.f);
  }
  rect(tx0 + 6, 2, 10, 4, C.f); rect(tx0 + 9, 0, 3, 2, C.f);   // roof plant + mast
  for (let y = 9; y < GY - 4; y += 4) for (let x = tx0 + 4; x < tx1 - 2; x += 4) rect(x, y, 2, 2, C.fw);
  for (let y = 9; y < 20; y += 3) rect(tx1 - 1, y, 5, 1, C.fw);   // crown bands
  const ox0 = 532, ox1 = 590;
  rect(ox0, 38, ox1 - ox0, GY - 38, C.f);
  rect(ox1 - 8, 32, 6, 6, C.f);
  for (let y = 42; y < GY - 4; y += 5) for (let x = ox0 + 3; x < ox1 - 3; x += 5) rect(x, y, 3, 3, C.fw);
  rect(448, 66, 42, GY - 66, C.gl);                     // the glass box in front
  for (let x = 448; x < 490; x += 6) rect(x, 66, 1, GY - 66, C.l);
  rect(448, 66, 42, 1, C.l); rect(448, 78, 42, 1, C.l);

  // ---- 학생회관: penthouse + antennas
  const px0 = 262, px1 = 380;
  rect(px0, 12, px1 - px0, 12, C.p);
  rect(px0, 12, px1 - px0, 1, C.l);
  // sign plate "207"
  rect(311, 14, 17, 8, C.s);
  [2, 0, 7].forEach((d, k) => DIGITS[d].forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') set(313 + k * 5 + x, 15 + y, C.st); })));
  // lattice mast + speaker horns + small aerials
  for (let y = 0; y < 12; y++) { set(268, y, C.m); set(271, y, C.m); if (y % 2 === 0) { set(269, y, C.m); set(270, y + 1, C.m); } }
  for (const [x, top] of [[300, 4], [318, 2], [336, 4]]) {
    rect(x, top + 3, 1, 12 - top - 3, C.m);
    rect(x - 2, top, 5, 3, C.m); rect(x - 3, top + 1, 1, 1, C.m); rect(x + 3, top + 1, 1, 1, C.m);
  }
  for (const x of [283, 289, 352, 360, 370]) rect(x, 7 + (x % 3), 1, 5 - (x % 3), C.m);
  rect(286, 8, 6, 4, C.m); rect(356, 9, 8, 3, C.m);

  // ---- facade
  rect(FX0, 24, FX1 - FX0, 66, C.b);                    // body from the parapet to the entrance level
  for (let x = FX0; x < FX1; x += 2) set(x, 24, 0);     // scalloped roof edge
  for (let x = FX0 + 1; x < FX1; x += 3) set(x, 26, C.l);
  rect(FX0, 27, FX1 - FX0, 1, C.l);
  for (const top of ROWS) {
    for (let i = 0; i < BAYS; i++) {
      TILE.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch !== '.') set(FX0 + i * PITCH + x, top + y, ch === 'w' ? C.w : C.l);
      }));
    }
    for (let y = 11; y < 14; y++) set(FX1 - 1, top + y, C.l);
  }
  // the arcade fringe under the top floors: little pointed arches opening downward
  rect(FX0, 69, FX1 - FX0, 1, C.l);
  for (let i = 0; i < BAYS; i++) {
    const x = winX(i);
    set(x + 1, 71, C.g);
    rect(x, 72, 3, 2, C.g);
    rect(x - 1, 74, 5, 2, C.g);
  }
  // ground floor: dark glass between pillars, the entrance in the middle
  rect(FX0 + 2, 76, FX1 - FX0 - 4, 14, C.g);
  for (let x = FX0 + 2; x < FX1; x += 30) rect(x, 76, 3, 14, C.b);
  for (let x = FX0 + 6; x < FX1 - 4; x += 6) rect(x, 79, 1, 10, C.l);
  rect(FX0 + 2, 82, FX1 - FX0 - 4, 1, C.l);
  rect(309, 77, 22, 13, C.d);                           // the doors
  rect(309, 77, 22, 1, C.l); rect(319, 78, 1, 12, C.l);
  rect(298, 80, 8, 6, C.gl); rect(334, 80, 8, 6, C.gl);  // notice boards by the door

  // ---- 207-A, the annex on the left: a slab roof over two tall glass arches
  rect(118, 64, 80, 3, C.p);
  rect(116, 67, 84, 1, C.l);
  rect(124, 68, 70, 22, C.b);
  for (const ax of [130, 160]) {
    rect(ax + 4, 70, 14, 1, C.g); rect(ax + 2, 71, 18, 1, C.g); rect(ax + 1, 72, 20, 1, C.g);
    rect(ax, 73, 22, 17, C.g);
    rect(ax + 10, 70, 2, 20, C.l); rect(ax, 80, 22, 1, C.l);
  }
  for (let i = 0; i < 6; i++) rect(194 + i, 84 - i * 2, 4, 1, C.l);   // the outside stair rail

  // ---- street trees, the crape myrtle, lamp posts
  const tree = (x, r, c = C.t) => { rect(x, 82, 1, GY - 82, C.k); disc(x, 76, r, c, R); disc(x - 2, 78, r - 3, C.t2, R); };
  tree(110, 7); tree(150, 6); tree(232, 6); tree(462, 6); tree(600, 8);
  rect(388, 80, 1, GY - 80, C.k); disc(388, 74, 8, C.fl, R); disc(386, 76, 4, C.t2, R);
  for (const x of [244, 400, 548]) { rect(x, 58, 1, GY - 58, C.m); rect(x - 1, 57, 3, 1, C.m); }

  // ---- podium, stairs, plaza
  rect(60, 90, 520, GY - 90, C.p);
  rect(60, 90, 520, 1, C.l);
  rect(80, 93, 110, 4, C.g);                            // the bank's strip windows
  for (let x = 80; x < 190; x += 10) rect(x, 93, 1, 4, C.l);
  rect(468, 93, 100, 4, C.gl);                          // the co-op store glass
  for (let y = 88; y < GY; y++) {
    const half = 12 + Math.round((y - 88) * 0.9);
    rect(320 - half, y, half * 2, 1, (y % 2) ? C.sr : C.l);
  }
  rect(0, GY, W, H - GY, C.gr);
  for (let y = GY; y < H; y++) {                        // the path to the stairs, widening toward us
    const half = 14 + (y - GY) * 2;
    rect(320 - half, y, half * 2, 1, C.pv);
  }
  rect(0, GY, W, 1, C.l);
  rect(319, GY + 1, 2, H - GY - 1, C.l);                // the tactile strip down the middle

  return g;
}

// windows that can light up (the club room's is always lit after dark)
export const WINDOWS = ROWS.flatMap((top, row) => Array.from({ length: BAYS }, (_, bay) => ({ row, bay, x: winX(bay), y: top + 2 })));
const isClub = (w) => w.row === CLUB.row && w.bay === CLUB.bay;
function windowCells(w) {                     // the glass of one window (not the transom)
  const out = [[w.x + 1, w.y]];
  for (const dy of [1, 2, 3, 5, 6, 7, 8]) for (let dx = 0; dx < 3; dx++) out.push([w.x + dx, w.y + dy]);
  return out;
}

// snow caps for 첫눈: the top cell of every roof, ledge and tree
function snowCells(g) {
  const out = [];
  for (let x = 0; x < W; x++) {
    for (let y = 1; y < GY; y++) {
      const c = g[y * W + x];
      if (!c || c === C.w || c === C.g || c === C.fw || c === C.m || c === C.k) continue;
      if (!g[(y - 1) * W + x]) out.push([x, y]);
      break;
    }
  }
  return out;
}

let grid = null, snow = null;
const rgb = (hex) => { const v = parseInt(hex.replace('#', ''), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; };

// Paint the picture into a 640 × 110 canvas (css scales it up pixelated). Colours come from the
// --sk-* custom properties, so the sky phase and the season restyle it.
function paint(canvas, styleOf, { lit, night, winter: snowy }) {
  if (!grid) { grid = draw(); snow = snowCells(grid); }
  const cs = getComputedStyle(styleOf);
  const pal = {};
  for (const [name, code] of Object.entries(C)) { const v = cs.getPropertyValue(`--sk-${name}`).trim(); if (v) pal[code] = rgb(v); }
  const litC = rgb(cs.getPropertyValue('--sk-lit').trim() || '#F3D58A');
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H), d = img.data;
  const put = (x, y, c) => { const i = (y * W + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; };
  for (let i = 0; i < grid.length; i++) { const c = grid[i]; if (c && pal[c]) put(i % W, (i / W) | 0, pal[c]); }
  if (snowy && pal[C.sn]) for (const [x, y] of snow) put(x, y, pal[C.sn]);
  if (night) for (const w of WINDOWS) if (isClub(w) || lit.has(w)) for (const [x, y] of windowCells(w)) put(x, y, litC);
  ctx.putImageData(img, 0, 0);
}

// ------------------------------------------------------------ on the desktop

// which windows are lit: a fixed pick per evening (same for everyone), fewer after 1 a.m.
function litBase(phase) {
  if (phase !== 'dusk' && phase !== 'night') return { key: 'off', set: new Set() };
  const t = kst();
  const late = phase === 'night' && t.h >= 1 && t.h < 6;
  const share = phase === 'dusk' ? 0.1 : late ? 0.04 : 0.16;
  const key = `${t.y}-${t.m}-${t.d}-${phase}-${late}`;
  const R = rng(t.y * 512 + t.m * 32 + t.d + (late ? 7 : 0));
  const set = new Set();
  WINDOWS.forEach((w, i) => { if (!(w.row === CLUB.row && w.bay === CLUB.bay) && R() < share) set.add(i); });
  return { key, set };
}

// pixel leaves and flakes (8 × 7 cells)
const SPRITE = {
  ginkgo: ['.#####..', '#######.', '#######.', '.#####..', '..###...', '...#....', '...#....'],
  maple:  ['...#...', '.#.#.#.', '#######', '.#####.', '..###..', '.#.#.#.', '...#...'],
  flake:  ['.#.', '#w#', '.#.'],
};
function sprite(name, size) {
  const rows = SPRITE[name];
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
  svg.setAttribute('width', rows[0].length * size); svg.setAttribute('height', rows.length * size);
  svg.setAttribute('shape-rendering', 'crispEdges');
  for (const ch of ['#', 'w']) {
    let d = '';
    rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === ch) d += `M${x} ${y}h1v1h-1z`; }));
    if (!d) continue;
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d); p.setAttribute('class', ch === '#' ? 'pt-a' : 'pt-b');
    svg.append(p);
  }
  return svg;
}

export function initSkyline(sky, currentPhase) {
  const box = h('div', { class: 'desk-skyline', 'aria-hidden': 'true' });
  const fall = h('div', { class: 'season-layer', 'aria-hidden': 'true' });
  sky.append(box, fall);
  let canvas = null, lit = new Set(), litKey = null;

  function repaint() {
    if (!canvas) return;
    const phase = currentPhase(), night = phase === 'dusk' || phase === 'night';
    paint(canvas, box, { lit, night, winter: document.body.classList.contains('season-winter') });
    box.dataset.lit = night ? lit.size + 1 : 0;                  // + the club room
  }
  function relight() {
    const base = litBase(currentPhase());
    if (base.key !== litKey) { litKey = base.key; lit = new Set([...base.set].map(i => WINDOWS[i])); return; }
    if (base.key === 'off' || document.hidden) return;
    // now and then someone switches a light on or off
    const w = WINDOWS[Math.floor(Math.random() * WINDOWS.length)];
    if (isClub(w)) return;
    if (lit.has(w)) lit.delete(w); else if (lit.size < WINDOWS.length * 0.25) lit.add(w);
  }
  function apply() {
    const show = on('skyline');
    if (show && !canvas) { canvas = h('canvas', { width: W, height: H, class: 'sk' }); box.replaceChildren(canvas); litKey = null; }
    if (!show && canvas) { canvas = null; box.replaceChildren(); }
    box.hidden = !show;
    const season = on('seasons') ? (winter() ? 'winter' : 'autumn') : null;
    document.body.classList.toggle('season-autumn', season === 'autumn');
    document.body.classList.toggle('season-winter', season === 'winter');
    if (canvas) { relight(); repaint(); }
  }
  apply();
  bus.on('settings', apply);
  bus.on('theme', apply);
  setInterval(() => { if (canvas && !document.hidden) { relight(); repaint(); } }, 40e3);
  setInterval(() => { if (on('seasons') && winter() !== document.body.classList.contains('season-winter')) apply(); }, 5 * 60e3);
  // ---- 낙엽 / 첫눈: a gust every few minutes (never with reduced motion, never on phones)
  function drift(kind, { x, delay = 0, dur, size = 2 }) {
    const el = h('div', { class: `drift ${kind}` }, h('div', { class: 'drift-sway' }, sprite(kind, size)));
    el.style.left = `${x}px`;
    el.style.setProperty('--dur', `${dur}ms`);
    el.style.setProperty('--sway', `${Math.round(dur / 3)}ms`);
    el.style.setProperty('--dx', `${Math.round((Math.random() - 0.3) * 160)}px`);
    el.style.animationDelay = `${delay}ms`;
    el.firstChild.style.animationDelay = `${-Math.round(Math.random() * 2000)}ms`;
    fall.append(el);
    setTimeout(() => el.remove(), delay + dur + 100);
  }
  function gust() {
    if (!on('seasons') || reduceMotion() || isPhone() || document.hidden || document.body.classList.contains('amber')) return;
    const w = sky.clientWidth;
    if (winter()) {
      for (let i = 0; i < 40; i++) drift('flake', { x: Math.random() * w, delay: i * 900 + Math.random() * 600, dur: 9000 + Math.random() * 5000, size: Math.random() < 0.3 ? 3 : 2 });
    } else {
      const n = 4 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) drift(Math.random() < 0.65 ? 'ginkgo' : 'maple', { x: Math.random() * w * 0.9, delay: i * 700 + Math.random() * 900, dur: 8000 + Math.random() * 4000 });
    }
  }
  // ---- the last day: a firework over 학생회관 for every story completed anywhere, and a finale at the deadline
  const COLORS = ['#FFF9EF', '#E9A04A', '#E58AA6', '#D9774F', '#F3D58A', '#9EC5E8'];
  function burst(count = 1) {
    if (reduceMotion() || isPhone() || document.hidden || document.body.classList.contains('amber')) return;
    const w = sky.clientWidth, ht = sky.clientHeight;
    for (let k = 0; k < count; k++) {
      setTimeout(() => {
        const x = w * (0.3 + Math.random() * 0.4), y = ht * (0.12 + Math.random() * 0.3), color = COLORS[Math.floor(Math.random() * COLORS.length)];
        const fw = h('div', { class: 'firework', style: `left:${Math.round(x)}px;top:${Math.round(y)}px;--c:${color};--rise:${Math.round(ht * 0.72 - y)}px` });
        const N = 14 + Math.floor(Math.random() * 8);
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2, r = 46 + Math.random() * 26;
          fw.append(h('i', { style: `--dx:${Math.round(Math.cos(a) * r)}px;--dy:${Math.round(Math.sin(a) * r)}px` }));
        }
        fall.append(fw);
        play('firework');
        setTimeout(() => fw.remove(), 2200);
      }, k * 520 + Math.random() * 200);
    }
  }
  const lastDayBurst = () => { if (on('deadline_fireworks') && deadlineDay()) burst(3); };
  bus.on('any-completed', lastDayBurst);
  bus.on('story-completed', lastDayBurst);
  function scheduleFinale() {
    const left = Date.parse(X('deadline')) - Date.now();
    if (left > 0 && left < 24 * 3600e3) setTimeout(() => { if (on('deadline_fireworks')) burst(12); }, left);
  }
  scheduleFinale();

  const next = () => setTimeout(() => { gust(); next(); }, 150e3 + Math.random() * 150e3);
  setTimeout(gust, 20e3);
  next();
  return { gust, burst };
}
