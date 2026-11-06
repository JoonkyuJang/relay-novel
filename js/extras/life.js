// Little signs of life, each behind its own 부가 기능 switch:
//   zoom_rects      dotted outlines zoom out of / into windows (open · close · 접어 두기 · 다시 펼치기)
//   shake_on_error  a refused action shakes its window "no" with a low bu-bup
//   press_buttons   buttons get a pixel shadow and press in while held      (css: body.fx-press)
//   pixel_cursor    pixel arrow · hand · I-beam · hourglass                (css: body.fx-cursor)
//   ticker          "방금 이어졌어요" slides along the menu bar when anyone, anywhere, adds a line
import * as api from '../api.js';
import { h } from '../ui.js';
import { isPhone } from '../wm.js';
import { on, bus, reduceMotion } from './extras.js';
import { play } from './sound.js';

// ------------------------------------------------------------ zoom outlines

// where the last click happened (a window opened from an icon zooms out of it)
let lastDown = null;
addEventListener('pointerdown', (e) => { lastDown = { x: e.clientX, y: e.clientY, at: Date.now(), el: e.target }; }, { capture: true, passive: true });

const rectOf = (x) => (x instanceof Element ? x.getBoundingClientRect() : x);
let zooming = 0;
function zoom(from, to, { frames = 6, ms = 34 } = {}) {
  if (!from || !to || zooming > 3) return;
  zooming++;
  const boxes = [];
  for (let i = 1; i <= frames; i++) {
    setTimeout(() => {
      const k = i / frames;
      const r = {
        left: from.left + (to.left - from.left) * k, top: from.top + (to.top - from.top) * k,
        width: from.width + (to.width - from.width) * k, height: from.height + (to.height - from.height) * k,
      };
      const b = h('div', { class: 'zoom-rect', 'aria-hidden': 'true' });
      Object.assign(b.style, { left: `${Math.round(r.left)}px`, top: `${Math.round(r.top)}px`, width: `${Math.round(r.width)}px`, height: `${Math.round(r.height)}px` });
      document.body.append(b);
      boxes.push(b);
      if (boxes.length > 2) boxes.shift().remove();             // a short trail of two outlines
    }, i * ms);
  }
  setTimeout(() => { boxes.forEach(b => b.remove()); zooming--; }, (frames + 2) * ms);
}
const point = (x, y) => ({ left: x - 8, top: y - 6, width: 16, height: 12 });
const centre = (r) => point(r.left + r.width / 2, r.top + r.height / 2);

addEventListener('rn-win', (e) => {
  if (!on('zoom_rects') || reduceMotion() || isPhone()) return;
  const { kind, from, to } = e.detail;
  if (kind === 'open') {
    // out of the icon (or menu item) that was just clicked, else out of the window's middle
    const rTo = rectOf(to);
    const src = lastDown && Date.now() - lastDown.at < 1500 && !to.contains(lastDown.el)
      ? (lastDown.el.closest?.('.icon, .ctx-item, .tray-btn, .drawer-row, .done-card, .menubar a, .menubar button')?.getBoundingClientRect() ?? point(lastDown.x, lastDown.y))
      : centre(rTo);
    to.classList.add('zoom-in');
    setTimeout(() => to.classList.remove('zoom-in'), 6 * 34 + 10);
    zoom(src, rTo);
  } else if (kind === 'close') {
    zoom(from, centre(from), { frames: 5 });
  } else if (kind === 'minimize') {
    requestAnimationFrame(() => zoom(from, rectOf(to)));         // the tray button exists after a frame
  } else if (kind === 'restore') {
    const rTo = rectOf(to);
    to.classList.add('zoom-in');
    setTimeout(() => to.classList.remove('zoom-in'), 6 * 34 + 10);
    zoom(from, rTo);
  }
});

// ------------------------------------------------------------ "no" shake

// Any refusal shown in a window (.notice.bad; .seen = an old one drawn again) — wrong 학번, the line is taken, the story is full,
// too long… — or an explicit dispatchEvent(new CustomEvent('rn-refuse', { detail: el })).
const lastNo = new WeakMap();
function refuse(el) {
  if (!on('shake_on_error') || !el?.isConnected) return;
  const target = el.closest('.win, .props, .modal-box') ?? el;
  const sig = el.textContent;
  const prev = lastNo.get(target);
  if (prev && prev.sig === sig && Date.now() - prev.at < 1500) return;    // the same message re-rendered
  lastNo.set(target, { sig, at: Date.now() });
  play('error');
  if (reduceMotion()) return;
  target.classList.remove('no'); void target.offsetWidth; target.classList.add('no');
  setTimeout(() => target.classList.remove('no'), 420);
}
addEventListener('rn-refuse', (e) => refuse(e.detail));
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) {
    if (n.nodeType !== 1) continue;
    const bad = n.matches('.notice.bad:not(.seen)') ? n : n.querySelector?.('.notice.bad:not(.seen)');
    if (bad && bad.closest('.win')) { refuse(bad); return; }
  }
}).observe(document.body, { childList: true, subtree: true });

// ------------------------------------------------------------ switches that are only css

function applyClasses() {
  document.body.classList.toggle('fx-press', on('press_buttons'));
  document.body.classList.toggle('fx-cursor', on('pixel_cursor'));
}
bus.on('settings', applyClasses);
applyClasses();

// ------------------------------------------------------------ 방금 이어졌어요

export function initTicker() {
  const box = h('div', { class: 'ticker', hidden: true, 'aria-live': 'polite' });
  document.body.append(box);
  let prev = null;                         // story id -> { line_count, status }
  const mine = new Map();                  // story id -> when this tab posted there
  const queue = [];
  let showing = false;
  bus.on('my-line', ({ storyId }) => mine.set(storyId, Date.now()));

  function show() {
    if (showing || !queue.length) return;
    const menubar = document.getElementById('menubar');
    const spacer = menubar?.querySelector('.spacer')?.getBoundingClientRect();
    if (!spacer || spacer.width < 220 || isPhone() || document.hidden) { queue.length = 0; return; }
    showing = true;
    const { text, href } = queue.shift();
    const a = h('a', { class: 'ticker-text', href }, text);
    box.replaceChildren(a);
    Object.assign(box.style, { left: `${Math.round(spacer.left + 12)}px`, width: `${Math.round(spacer.width - 24)}px` });
    box.hidden = false;
    box.classList.remove('out');
    const travel = box.clientWidth + a.offsetWidth;
    const ms = reduceMotion() ? 0 : Math.max(5000, travel * 14);
    if (ms) {
      a.style.setProperty('--from', `${box.clientWidth}px`);
      a.style.setProperty('--to', `${Math.max(0, Math.round((box.clientWidth - a.offsetWidth) / 2))}px`);
      a.style.animation = `ticker-in ${Math.round(ms * 0.45)}ms steps(${Math.round(travel / 6)}) 1 forwards`;
    }
    setTimeout(() => {                     // hold in the middle, then fade in pixel steps
      box.classList.add('out');
      setTimeout(() => { box.hidden = true; box.classList.remove('out'); showing = false; show(); }, 700);
    }, Math.round(ms * 0.45) + 3200);
  }

  // (completions anywhere are also announced on the bus — the last day's fireworks listen for them)
  const wanted = () => api.hasEntered() && (on('ticker') || on('deadline_fireworks'));
  api.onStories((list) => {
    if (!wanted()) { prev = null; return; }
    const next = new Map(list.map(s => [s.id, { line_count: s.line_count, status: s.status }]));
    if (prev) {
      for (const s of list) {
        const was = prev.get(s.id);
        const name = `「${s.title || s.first_line || '제목 없는 이야기'}」`;
        const href = `#/story/${s.id}`;
        const self = Date.now() - (mine.get(s.id) ?? 0) < 60e3;
        if (was && s.status === 'completed' && was.status !== 'completed') bus.emit('any-completed', { storyId: s.id });
        if (!on('ticker')) continue;
        if (!was) { if (!self) queue.push({ text: `새 이야기 · ${name}`, href }); continue; }
        if (s.line_count > was.line_count && !self) {
          queue.push(s.status === 'completed' && was.status !== 'completed'
            ? { text: `완결 · ${name} ${s.line_count}줄을 다 채웠어요`, href }
            : { text: `방금 이어졌어요 · ${name} ${s.line_count}번째 줄`, href });
        }
        if (self && s.line_count > was.line_count) mine.delete(s.id);
      }
      queue.splice(0, Math.max(0, queue.length - 3));      // never a backlog
      show();
    }
    prev = next;
  });
  // keep hearing about the list even when the 서랍 is closed
  const refresh = () => { if (wanted() && !isPhone()) api.listStories().catch(() => {}); };
  api.watch(['list'], refresh);
  setTimeout(refresh, 1500);
}

// ------------------------------------------------------------ a newer version is out

// A tab left open across a deploy keeps running the old code. Every so often (and on coming back to
// the tab) look at index.html: if its versioned files (?v=…) differ from the ones this page loaded,
// offer to reload — never force it, someone may be in the middle of a line.
const assetSig = (html) => {
  const block = html.split('assets:start')[1]?.split('assets:end')[0] ?? '';
  return (block.match(/\?v=[0-9a-f]+/g) ?? []).join(',');
};
export function initUpdateCheck() {
  const running = assetSig(document.head.innerHTML);
  if (!running) return null;
  let lastCheck = Date.now(), shown = false;
  async function check() {
    if (shown || document.hidden || Date.now() - lastCheck < 60e3) return;
    lastCheck = Date.now();
    try {
      const r = await fetch(`./?_=${Date.now()}`, { cache: 'no-store' });
      const live = assetSig(await r.text());
      if (!live || live === running) return;
      shown = true;
      const note = h('div', { class: 'doze-note update-note', role: 'status' },
        h('span', {}, '연문회 OS가 새로워졌어요.'),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => location.reload() }, '새로고침'),
        h('button', { type: 'button', class: 'btn-link', onclick: () => note.remove() }, '나중에'));
      document.body.append(note);
    } catch { /* offline: next time */ }
  }
  setInterval(check, 10 * 60e3);
  document.addEventListener('visibilitychange', check);
  return { check: () => { lastCheck = 0; return check(); } };
}

// ------------------------------------------------------------ the tab icon

// In another tab, a story you have open here gets a writer: the tab's icon turns into the cat, blinking.
const CAT_ROWS = (eyes) => [
  '................', '..#.........#...', '..##.......##...', '..#w#.....#w#...', '.#wwW#####Www#..', '.#wwwwwwwwwww#..',
  '.#wwwwwwwwwww#..', eyes, '.#wwwwwwwwwww#..', '.#wwwwwppwwww#..', '.#wwwww##wwww#..', '.#wwwwwwwwwww#..',
  '..#wwwwwwwww#...', '...#########....', '................', '................',
];
function catIcon(eyes) {
  let ink = '', fill = '', pink = '';
  CAT_ROWS(eyes).forEach((r, y) => [...r].forEach((c, x) => {
    const px = `M${x} ${y}h1v1h-1z`;
    if (c === '#') ink += px; else if (c === 'w' || c === 'W') fill += px; else if (c === 'p') pink += px;
  }));
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' shape-rendering='crispEdges'><path d='${fill}' fill='#FFF9EF'/><path d='${pink}' fill='#E58AA6'/><path d='${ink}' fill='#1D2A44'/></svg>`;
  return `data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}`;
}
export function initTabIcon(wm) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  const plain = link.href;
  const frames = [catIcon('.#ww#wwwww#ww#..'), catIcon('.#wwwwwwwwwww#..')];          // eyes open · a blink
  let i = 0, showing = false;
  setInterval(() => {
    const stories = wm.wins().filter(w => w.view.type === 'story');
    api.watchInBackground(on('tab_icon') && stories.length > 0);
    const someone = on('tab_icon') && document.hidden && stories.some(w => w.view.storyData?.status === 'open' && w.view.storyData?.writing);
    if (someone) { link.href = frames[i++ % 2]; showing = true; }
    else if (showing) { link.href = plain; showing = false; }
  }, 800);
}
