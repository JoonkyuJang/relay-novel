// 휴지통: the bin itself (a lid that opens), its count and hover box, the phone bin on the dock
// beside the cat, and the toss — when someone lets go of a line they were writing, the writing box
// crumples into a paper ball that arcs into the bin (lid opens, bin gives a little bump, lid shuts).
import * as api from '../api.js';
import { h } from '../ui.js';
import { isPhone } from '../wm.js';
import { on, fun, bus, reduceMotion } from './extras.js';
import { play } from './sound.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const LID = '<path d="M2 3.5h12" stroke="currentColor"/><path d="M6 1.5h4v2H6z" fill="none" stroke="currentColor"/>';
const BODY = '<path data-fill d="M3.5 4.5h9l-1 10h-7z" fill="#FFF9EF" stroke="currentColor"/><path d="M6.5 6.5v6M9.5 6.5v6" stroke="currentColor"/>';

// the bin picture: the lid is its own group so it can open
export function binSvg(size) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('shape-rendering', 'crispEdges'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<g class="bin-lid">${LID}</g>${BODY}`;
  return s;
}

// ---------------------------------------------------------------- the count + its explanation

let count = 0;
const badges = new Set();
const labelled = new Set();
export function setTrashCount(n) {
  count = Number(n) || 0;
  for (const b of badges) { b.textContent = count.toLocaleString('ko-KR'); b.hidden = !count; }
  for (const el of labelled) el.setAttribute('aria-label', `휴지통: 안 쓰고 놓은 바통 ${count}번`);
}
export function trashBadge(owner) {
  const b = h('span', { class: 'badge', hidden: true });
  badges.add(b); labelled.add(owner);
  return b;
}
export const tipContent = () => [
  h('b', {}, `휴지통 · ${count.toLocaleString('ko-KR')}`),
  h('span', {}, "'이어 쓰기'로 줄을 맡았다가 끝내 올리지 않고 놓은 횟수예요. 쓰던 중에 취소했든, 시간이 다 되어 자리가 넘어갔든 올리지 않았으면 여기 모여요."),
  h('span', { class: 'faint' }, '누가 놓았는지는 남기지 않아요.'),
];

// A small pixel balloon beside an icon (or above it, on a phone).
let openTip = null;
export function showTip(el, content, { above = false } = {}) {
  hideTip();
  const tip = h('div', { class: `hover-tip${above ? ' above' : ''}`, 'aria-hidden': 'true' }, content());
  document.body.append(tip);
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, ht = tip.offsetHeight;
  if (above) {
    tip.style.left = `${Math.round(Math.max(8, Math.min(r.left + r.width / 2 - w + 24, innerWidth - w - 8)))}px`;
    tip.style.top = `${Math.round(r.top - ht - 10)}px`;
    tip.style.setProperty('--arrow-x', `${Math.round(r.left + r.width / 2 - parseFloat(tip.style.left) - 5)}px`);
  } else {
    const left = r.left - w - 10 > 8 ? r.left - w - 10 : r.right + 10;
    tip.classList.toggle('right', left > r.left);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(Math.min(Math.max(36, r.top + r.height / 2 - ht / 2), innerHeight - ht - 8))}px`;
  }
  openTip = tip;
  return tip;
}
export function hideTip() { openTip?.remove(); openTip = null; }
addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

export function hoverTip(el, content) {
  let t = null;
  const show = () => { clearTimeout(t); t = setTimeout(() => showTip(el, content), 350); };
  const hide = () => { clearTimeout(t); hideTip(); };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', () => { if (el.matches(':focus-visible')) show(); });
  el.addEventListener('blur', hide);
  el.addEventListener('pointerdown', hide);
}

// ---------------------------------------------------------------- the phone bin

// On a phone the bin sits on the dock at the right, next to the cat. Tap: what the number means.
// Two quick taps: 와르르 (when 숨은 재미 allows it).
export function initPhoneBin(app, desktop) {
  const bin = h('button', { type: 'button', class: 'phone-bin', 'aria-label': '휴지통' });
  bin.append(trashBadge(bin), binSvg(30));
  desktop.append(bin);
  let lastTap = 0, tipT = null;
  bin.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 350 && fun('fun_trash')) {
      lastTap = 0; clearTimeout(tipT); hideTip();
      bus.emit('trash-dblclick', { el: bin });
      return;
    }
    lastTap = now;
    if (openTip) { hideTip(); return; }
    showTip(bin, tipContent, { above: true });
    clearTimeout(tipT);
    tipT = setTimeout(hideTip, 5000);
  });
  addEventListener('pointerdown', (e) => { if (openTip && !bin.contains(e.target)) hideTip(); }, { capture: true });
  const apply = () => document.body.classList.toggle('bin-phone', isPhone() && on('trash') && on('trash_phone'));
  apply();
  bus.on('settings', apply);
  matchMedia('(max-width: 767px)').addEventListener('change', apply);
  return bin;
}

// ---------------------------------------------------------------- the toss

// the bin someone can see right now: the desktop icon, or the phone bin on the dock
function binTarget() {
  const el = isPhone() ? document.querySelector('.phone-bin') : document.querySelector('#icons .icon.trash');
  if (!el || !el.offsetParent) return null;
  return el;
}
function lid(bin, open) {
  bin.classList.toggle('lid-open', open);
  if (open) play('lid');
}

// crumple steps: the sheet's outline gets more and more jagged
const JAG = [
  'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
  'polygon(4% 8%, 30% 0%, 55% 6%, 82% 0%, 100% 12%, 94% 46%, 100% 88%, 70% 100%, 42% 92%, 12% 100%, 0% 70%, 6% 38%)',
  'polygon(14% 16%, 36% 4%, 58% 14%, 84% 6%, 92% 30%, 82% 52%, 96% 78%, 66% 92%, 44% 82%, 18% 96%, 8% 68%, 16% 44%)',
  'polygon(28% 10%, 50% 0%, 72% 10%, 92% 28%, 100% 50%, 90% 74%, 72% 92%, 50% 100%, 26% 90%, 8% 72%, 0% 50%, 10% 26%)',
];

// Throw the writing box `src` (holding `text`) into the bin. Returns false when there's nothing to animate.
export function tossToBin(src, text = '') {
  if (!on('trash') || !on('trash_toss') || reduceMotion() || !src?.isConnected) return false;
  // on a phone the keyboard (and the focused box) hides the dock and the bin: put the keyboard away first
  // (reading the layout below re-lays the page at once, so the bin and the box are where they'll be)
  if (isPhone() && (src === document.activeElement || src.contains(document.activeElement))) document.activeElement.blur();
  const bin = binTarget();
  const r = src.getBoundingClientRect();
  if (!bin || !r.width || !r.height) return false;
  const svg = bin.querySelector('svg').getBoundingClientRect();
  const before = count;
  const to = { x: svg.left + svg.width / 2, y: svg.top + svg.height * 0.3 };

  // 1 · the sheet crumples in four pixel steps
  const paper = h('div', { class: 'crumple-paper' }, h('span', {}, text));
  const sheet = h('div', { class: 'crumple-sheet', 'aria-hidden': 'true' }, paper);
  Object.assign(sheet.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.append(sheet);
  play('crumple');
  // sizes per step (px): a long writing box first folds toward a sheet, then balls up
  const B = 24, W = r.width, H = r.height;
  const sizes = [[W, H], [W * 0.55, H * 0.9], [Math.min(W, 70), Math.min(H, 56)], [B * 1.5, B * 1.4], [B * 1.15, B * 1.1]];
  const rot = [0, -3, 6, -9, 12];
  // real sizes (not a scale), so the pixel border stays crisp; the middle stays put
  const cx = r.left + W / 2, cy = r.top + H / 2;
  const box = (w, ht) => ({ left: `${Math.round(cx - w / 2)}px`, top: `${Math.round(cy - ht / 2)}px`, width: `${Math.round(w)}px`, height: `${Math.round(ht)}px` });
  // (the outline is a drop-shadow on the outer box, so it follows the jagged edge clipped inside)
  const step = (i) => ({ offset: i / sizes.length, easing: 'steps(1, end)' });
  const frames = sizes.map(([w, ht], i) => ({ ...box(w, ht), transform: `rotate(${rot[i]}deg)`, ...step(i) }));
  frames.push({ ...box(B, B), transform: 'rotate(16deg)', offset: 1 });
  paper.animate([...sizes.map((_, i) => ({ clipPath: JAG[Math.min(i, JAG.length - 1)], ...step(i) })), { clipPath: JAG[3], offset: 1 }],
    { duration: 520, fill: 'forwards' });
  const crumple = sheet.animate(frames, { duration: 520, fill: 'forwards' });
  paper.firstChild.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'steps(2, end)', fill: 'forwards' });

  bus.emit('paper-toss', { to });
  crumple.finished.then(() => {
    // 2 · the ball arcs over to the bin in stepped frames, spinning
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    sheet.remove();
    const ball = h('i', { class: 'toss-ball', 'aria-hidden': 'true' });
    Object.assign(ball.style, { left: `${x0 - 8}px`, top: `${y0 - 8}px` });
    document.body.append(ball);
    const dist = Math.hypot(to.x - x0, to.y - y0);
    const peak = Math.min(y0, to.y) - Math.max(50, Math.min(180, dist * 0.35));
    const N = 14, ms = Math.max(420, Math.min(720, dist * 0.9));
    const path = Array.from({ length: N + 1 }, (_, i) => {
      const t = i / N, u = 1 - t;
      const x = (to.x - x0) * t, y = u * u * y0 + 2 * u * t * peak + t * t * to.y - y0;
      return { transform: `translate(${Math.round(x)}px, ${Math.round(y)}px) rotate(${i * 45}deg) scale(${(1 - t * 0.25).toFixed(2)})`, offset: t, easing: 'steps(1, end)' };
    });
    setTimeout(() => lid(bin, true), Math.max(0, ms - 260));
    ball.animate(path, { duration: ms, fill: 'forwards' }).finished.then(() => {
      // 3 · in it goes: the bin gives a little bump, the lid shuts, the count goes up
      ball.remove();
      bin.classList.remove('bump'); void bin.offsetWidth; bin.classList.add('bump');
      play('bin');
      setTrashCount(Math.max(count, before + 1));          // (the server may have counted it already)
      bus.emit('paper-landed', { x: to.x, y: to.y, bin });
      setTimeout(() => lid(bin, false), 320);
      setTimeout(() => bin.classList.remove('bump'), 500);
    });
  });
  return true;
}

// keep the count fresh (desk.js asks after list changes)
export async function refreshTrashCount() {
  if (!on('trash')) return;
  try { setTrashCount((await api.getCounters()).trash); } catch { /* ignore */ }
}
