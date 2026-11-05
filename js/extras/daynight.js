// 낮과 밤: the desktop sky follows Seoul time (아침 · 낮 · 노을 · 밤), with a sun or
// the real moon phase. Windows stay cream (N1). Each device can pin 늘 낮 / 늘 밤.
import { h } from '../ui.js';
import { prefs } from '../api.js';
import { on, kst, bus } from './extras.js';
import { initSkyline } from './skyline.js';

export const PHASES = ['morning', 'day', 'dusk', 'night'];
const NAMES = { morning: '아침', day: '낮', dusk: '저녁 노을', night: '밤' };
const SVGNS = 'http://www.w3.org/2000/svg';

export function phaseAt(d = new Date()) {
  const { h: hr } = kst(d);
  if (hr >= 6 && hr < 11) return 'morning';
  if (hr >= 11 && hr < 17) return 'day';
  if (hr >= 17 && hr < 20) return 'dusk';
  return 'night';
}

const mode = () => prefs.get('daynight', 'auto');          // auto | day | night
export function currentPhase() {
  if (!on('daynight') || document.body.classList.contains('amber')) return 'day';
  const m = on('daynight_override') ? mode() : 'auto';
  if (m === 'day') return 'day';
  if (m === 'night') return 'night';
  return phaseAt();
}

// 12x12 pixel paths
function px(rows) { let d = ''; rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') d += `M${x} ${y}h1v1h-1z`; })); return d; }
const SUN = px(['.....#......', '..#.....#...', '.....##.....', '...######...', '#..######..#', '..########..', '..########..', '#..######..#', '...######...', '.....##.....', '..#.....#...', '.....#......']);
const MINI = {
  sun:  px(['.....#......', '.#.......#..', '....###.....', '...#####....', '..#######...', '#.#######.#.', '..#######...', '...#####....', '....###.....', '.#.......#..', '.....#......', '............']),
  dusk: px(['............', '............', '............', '....###.....', '...#####....', '..#######...', '############', '............', '..########..', '............', '...######...', '............']),
  moon: px(['............', '....###.....', '...##.......', '..##........', '..##........', '..##........', '..##........', '...##.......', '....###.....', '............', '............', '............']),
};

// Moon age 0..1 (0 = new, .5 = full), from a known new moon.
export function moonAge(d = new Date()) {
  const syn = 29.530588853 * 86400e3;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  return (((d - ref) % syn) + syn) % syn / syn;
}
function moonPath(age) {
  // pixel disc; lit side grows from the right (waxing) then shrinks to the left (waning)
  let d = '';
  const k = Math.cos(age * 2 * Math.PI);           // 1 new, -1 full
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const nx = (x + 0.5 - 6) / 5.6, ny = (y + 0.5 - 6) / 5.6;
    if (nx * nx + ny * ny > 1) continue;
    const half = Math.sqrt(1 - ny * ny), edge = k * half;
    const lit = age < 0.5 ? nx > edge : nx < -edge;
    if (lit) d += `M${x} ${y}h1v1h-1z`;
  }
  return d || MINI.moon;
}

function svgIcon(path, size, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('shape-rendering', 'crispEdges'); s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', path); p.setAttribute('fill', 'currentColor');
  s.append(p);
  return s;
}

let sky = null, orb = null, applied = null;

function orbPlace(phase) {
  // a rough arc across the sky by time of day (percent of the desktop)
  const { h: hr, min } = kst();
  const t = hr + min / 60;
  if (phase === 'night') {
    const n = ((t >= 20 ? t - 20 : t + 4)) / 10;          // 20:00 → 06:00
    return { x: 12 + n * 76, y: 26 - Math.sin(n * Math.PI) * 18 };
  }
  const n = Math.min(1, Math.max(0, (t - 6) / 14));       // 06:00 → 20:00
  return { x: 8 + n * 84, y: 70 - Math.sin(n * Math.PI) * 62 };
}

export function applySky() {
  const phase = currentPhase();
  for (const p of PHASES) document.body.classList.toggle(`phase-${p}`, p === phase && on('daynight'));
  if (!sky) return;
  for (const layer of sky.querySelectorAll('.sky-layer')) layer.classList.toggle('on', layer.dataset.phase === phase);
  const where = orbPlace(phase);
  orb.replaceChildren(svgIcon(phase === 'night' ? (on('moon_phase') ? moonPath(moonAge()) : MINI.moon) : SUN, 36));
  orb.dataset.kind = phase === 'night' ? 'moon' : phase;
  orb.style.left = `${where.x}%`; orb.style.top = `${Math.max(6, where.y)}%`;
  orb.hidden = !on('daynight') || document.body.classList.contains('amber');
  if (applied !== phase) { applied = phase; bus.emit('theme', { phase }); }
}

export function initDayNight(desktop) {
  sky = h('div', { class: 'desk-sky', 'aria-hidden': 'true' },
    PHASES.map(p => h('div', { class: 'sky-layer', dataset: { phase: p } })),
    h('div', { class: 'sky-stars' }));
  orb = h('div', { class: 'sky-orb' });
  sky.append(orb);
  desktop.before(sky);
  applySky();                                   // (before the skyline reads styles: the first sky must not fade in)
  const skyline = initSkyline(sky, currentPhase);
  setInterval(applySky, 60e3);
  bus.on('settings', applySky);
  return { skyline };
}

// Little sun / moon before the clock; clicking cycles 자동 → 늘 낮 → 늘 밤 (this device).
export function phaseButton(onChange) {
  const phase = currentPhase();
  const icon = svgIcon(phase === 'night' ? MINI.moon : phase === 'dusk' ? MINI.dusk : MINI.sun, 12);
  const m = mode();
  const label = { auto: '자동', day: '늘 낮', night: '늘 밤' }[m];
  if (!on('daynight') || !on('daynight_override')) return h('span', { class: 'phase-ico', title: NAMES[phase] }, icon);
  return h('button', {
    type: 'button', class: 'phase-ico', title: `${NAMES[phase]} · ${label} (누르면 바꾸기)`, 'aria-label': `하늘: ${label}`,
    onclick: () => {
      const next = { auto: 'day', day: 'night', night: 'auto' }[mode()];
      prefs.set('daynight', next === 'auto' ? null : next);
      applySky(); onChange?.();
    },
  }, icon);
}
