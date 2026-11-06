// 늦은 밤 커피 자국: every line written between midnight and 6 a.m. (Seoul) leaves a coffee ring on
// the desktop. Nobody wipes them: older rings fade a little day by day, so fresh and old stains overlap.
// Where a ring sits, its size and shape come from the line's id, so everyone sees the same desk.
// Hovering a ring explains it. (The rings know only a line id and a time — no text, no names.)
import * as api from '../api.js';
import { h } from '../ui.js';
import { isPhone } from '../wm.js';
import { on, bus, kst } from './extras.js';
import { hoverTip } from './bin.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_DRAWN = 260;
let count = 0;
export const ringCount = () => count;

function hash(str) { let x = 2166136261; for (const c of str) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; }
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// a pixel ring: a 2-cell-wide ellipse with a few gaps, sometimes a second partial ring, sometimes a drip
function ringSvg(id) {
  const R = rng(hash(id));
  const r = 11 + Math.floor(R() * 5), sq = 0.86 + R() * 0.12, n = Math.ceil(r * 2 + 6);
  const gapAt = R() * Math.PI * 2, gapLen = 0.3 + R() * 0.7, inner = R() < 0.35, drip = R() < 0.3;
  let d = '';
  const c = n / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (x + 0.5 - c), dy = (y + 0.5 - c) / sq, dist = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) + Math.PI;
    const onRing = dist <= r && dist > r - 1.7 && Math.abs(((ang - gapAt + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) > gapLen / 2;
    const onInner = inner && dist <= r - 3 && dist > r - 4 && ang > gapAt && ang < gapAt + 2.4;
    if ((onRing && R() > 0.06) || onInner) d += `M${x} ${y}h1v1h-1z`;
  }
  if (drip) { const x = Math.round(c + r * Math.cos(gapAt + 2)), y0 = Math.round(c + r * sq * Math.abs(Math.sin(gapAt + 2))); d += `M${x} ${y0}h1v3h-1zM${x} ${y0 + 4}h1v1h-1z`; }
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`); svg.setAttribute('width', n * 3); svg.setAttribute('height', n * 3);
  svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d);
  svg.append(p);
  return { svg, size: n * 3, R };
}

// fresh rings are dark; they fade over a couple of weeks but never quite disappear
const strength = (at) => { const days = Math.max(0, (Date.now() - Date.parse(at)) / 86400e3); return 0.14 + 0.5 * Math.exp(-days / 4); };
const when = (at) => { const t = kst(new Date(at)); return `${t.m}월 ${t.d}일 새벽 ${t.h}:${String(t.min).padStart(2, '0')}`; };

export function initRings(desktop) {
  const layer = h('div', { class: 'ring-layer', 'aria-hidden': 'true' });
  desktop.prepend(layer);
  let rows = [], drawnSig = '';
  function draw() {
    const show = on('coffee_rings') && !isPhone();
    layer.hidden = !show;
    if (!show) return;
    const W = desktop.clientWidth, H = desktop.clientHeight;
    const sig = `${rows.length}|${rows.at(-1)?.id}|${W}x${H}|${Math.floor(Date.now() / 3600e3)}`;
    if (sig === drawnSig) return;
    drawnSig = sig;
    const list = rows.slice(-MAX_DRAWN);
    layer.replaceChildren(...list.map((row) => {
      const { svg, size, R } = ringSvg(row.id);
      // anywhere on the desk except the icon column on the right and the ground at the bottom
      const x = Math.round(R() * Math.max(0, W - 170 - size)) + 10, y = Math.round(R() * Math.max(0, H * 0.62 - size)) + 8;
      const el = h('span', { class: 'ring', style: `left:${x}px;top:${y}px;width:${size}px;height:${size}px;opacity:${strength(row.at).toFixed(2)};transform:rotate(${Math.round(R() * 360)}deg)` }, svg);
      hoverTip(el, () => [
        h('b', {}, '늦은 밤의 커피 자국'),
        h('span', {}, '밤 12시부터 새벽 6시 사이에 누군가 줄을 쓸 때마다 하나씩 남아요. 오래된 자국일수록 조금씩 옅어져요.'),
        h('span', { class: 'faint' }, `이 자국: ${when(row.at)} · 지금까지 ${rows.length.toLocaleString('ko-KR')}개`),
      ], { delay: 700 });                             // (a mouse just passing over the desk shouldn't pop boxes)
      return el;
    }));
  }
  // (every new line anywhere bumps 'list': ask at most once a minute, with one catch-up call after)
  let busy = false, lastAsk = 0, again = null;
  async function refresh() {
    if (!on('coffee_rings')) { draw(); return; }
    const wait = 60e3 - (Date.now() - lastAsk);
    if (busy || wait > 0) { draw(); if (!again) again = setTimeout(() => { again = null; refresh(); }, Math.max(wait, 1000)); return; }
    busy = true; lastAsk = Date.now();
    try { rows = await api.nightRings(); count = rows.length; } catch { /* keep what we have */ } finally { busy = false; }
    draw();
  }
  refresh();
  api.watch(['list'], refresh);
  bus.on('settings', refresh);
  addEventListener('resize', () => { clearTimeout(draw.t); draw.t = setTimeout(draw, 200); });
  setInterval(draw, 3600e3);                        // fading follows the clock
  return { refresh };
}
