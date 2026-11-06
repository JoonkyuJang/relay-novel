// 방명록 종이비행기: a posted note folds itself into a paper airplane and loops off to the 방명록
// icon (the dock button on a phone), which gives a little bump when it arrives.
import { h } from '../ui.js';
import { isPhone } from '../wm.js';
import { on, reduceMotion } from './extras.js';
import { play } from './sound.js';

const FOLD = [
  'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
  'polygon(0% 18%, 50% 0%, 100% 18%, 100% 100%, 0% 100%)',                 // corners folded in
  'polygon(0% 40%, 50% 0%, 100% 40%, 80% 100%, 20% 100%)',
  'polygon(50% 0%, 100% 100%, 50% 78%, 0% 100%)',                          // a dart
];

function planeSvg() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 18 12'); s.setAttribute('width', 36); s.setAttribute('height', 24);
  s.setAttribute('shape-rendering', 'crispEdges'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M1 1L17 6L1 11L5 6Z" fill="#FFFDF8" stroke="#1D2A44"/><path d="M5 6H17M5 6L8 9" fill="none" stroke="#1D2A44"/>';
  return s;
}

function target() {
  const el = isPhone() ? document.querySelector('.dock a[data-route="/guestbook"]') : document.querySelector('#icons .icon[data-route="/guestbook"]');
  return el?.offsetParent ? el : null;
}

export function flyPlane(src, text = '') {
  if (!on('guestbook_plane') || reduceMotion() || !src?.isConnected) return false;
  if (isPhone() && document.activeElement === src) src.blur();          // (the keyboard hides the dock)
  const to = target();
  const r = src.getBoundingClientRect();
  if (!to || !r.width) return false;
  const tr = (to.querySelector('svg') ?? to).getBoundingClientRect();
  const end = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };

  // 1 · the note folds up (outline follows the folds, like the crumpled sheet)
  const paper = h('div', { class: 'crumple-paper' }, h('span', {}, text));
  const sheet = h('div', { class: 'crumple-sheet', 'aria-hidden': 'true' }, paper);
  const W = Math.min(r.width, 280), H = Math.min(r.height, 90);
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const box = (w, ht) => ({ left: `${Math.round(cx - w / 2)}px`, top: `${Math.round(cy - ht / 2)}px`, width: `${Math.round(w)}px`, height: `${Math.round(ht)}px` });
  Object.assign(sheet.style, box(W, H));
  document.body.append(sheet);
  play('plane');
  const sizes = [[W, H], [W * 0.7, H * 0.9], [W * 0.4, H * 0.8], [44, 30]];
  const step = (i) => ({ offset: i / sizes.length, easing: 'steps(1, end)' });
  paper.animate([...sizes.map((_, i) => ({ clipPath: FOLD[i], ...step(i) })), { clipPath: FOLD[3], offset: 1 }], { duration: 480, fill: 'forwards' });
  paper.firstChild.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'steps(2, end)', fill: 'forwards' });
  sheet.animate([...sizes.map(([w, ht], i) => ({ ...box(w, ht), transform: `rotate(${[0, 0, -90, -90][i]}deg)`, ...step(i) })),
    { ...box(44, 30), transform: 'rotate(-90deg)', offset: 1 }], { duration: 480, fill: 'forwards' }).finished.then(() => {
    // 2 · off it goes: up, a little loop, then a glide down to the icon
    sheet.remove();
    const plane = h('i', { class: 'paper-plane', 'aria-hidden': 'true' }, planeSvg());
    Object.assign(plane.style, { left: `${Math.round(cx - 18)}px`, top: `${Math.round(cy - 12)}px` });
    document.body.append(plane);
    const N = 20, dx = end.x - cx, dy = end.y - cy;
    const pts = Array.from({ length: N + 1 }, (_, i) => {
      const t = i / N;
      const loop = t > 0.25 && t < 0.6 ? (t - 0.25) / 0.35 : null;              // a loop-the-loop in the middle
      let x = dx * t, y = dy * t - Math.sin(t * Math.PI) * 120;
      if (loop != null) { x += Math.sin(loop * Math.PI * 2) * 40; y -= (1 - Math.cos(loop * Math.PI * 2)) * 30; }
      return [x, y];
    });
    const frames = pts.map(([x, y], i) => {
      const [nx, ny] = pts[Math.min(i + 1, N)], [px, py] = pts[Math.max(i - 1, 0)];
      const ang = Math.round(Math.atan2(ny - py, nx - px) * 180 / Math.PI / 15) * 15;  // heading, in 15° pixel steps
      return { transform: `translate(${Math.round(x)}px, ${Math.round(y)}px) rotate(${ang}deg)`, offset: i / N, easing: 'steps(1, end)' };
    });
    plane.animate(frames, { duration: 1300, fill: 'forwards' }).finished.then(() => {
      plane.remove();
      to.classList.remove('bump'); void to.offsetWidth; to.classList.add('bump');
      play('select');
      setTimeout(() => to.classList.remove('bump'), 500);
    });
  });
  return true;
}
