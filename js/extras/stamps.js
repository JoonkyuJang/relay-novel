// 도장: SVG symbols, the per-line stamp pad, the buttons in the 속성 window,
// the scroll-bar heat ticks and the 도움말 section.
import * as api from '../api.js';
import { h, errorText } from '../ui.js';
import { STAMP_DEFS } from './stamp-art.js';
import { X, on } from './extras.js';
import { play } from './sound.js';

export const KINDS = ['sun', 'laugh', 'cur'];
export const NAMES = { sun: '참 잘했어요', laugh: '재밌어요', cur: '다음이 궁금해요' };
export const SHORT = { sun: '잘했어요', laugh: '재밌어요', cur: '궁금해요' };
const ROT = { sun: -8, laugh: 6, cur: -4 };
const SVGNS = 'http://www.w3.org/2000/svg';

let injected = false;
export function injectStampDefs() {
  if (injected) return;
  injected = true;
  const t = document.createElement('template');
  t.innerHTML = STAMP_DEFS;
  const svg = t.content.firstChild;
  svg.setAttribute('class', 'stamp-defs');           // kept when printing (the seal uses it)
  document.body.prepend(svg);
}

// <svg><use href="#rn-m-sun"/></svg>
export function stampSvg(kind, { mini = true, size = 24, rot = ROT[kind], label = null } = {}) {
  injectStampDefs();
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', kind === 'seal' ? '0 0 200 112' : '0 0 200 200');
  svg.setAttribute('width', size);
  svg.setAttribute('height', kind === 'seal' ? Math.round(size * 0.56) : size);
  svg.style.transform = `rotate(${rot ?? 0}deg)`;
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVGNS, 'use');
  use.setAttribute('href', kind === 'seal' ? '#rn-seal' : `#rn-${mini ? 'm' : 's'}-${kind}`);
  svg.append(use);
  return svg;
}
export const seal = (size = 150, rot = -8) => stampSvg('seal', { size, rot, label: '완결 도장' });

// Fill a pad element with stamps. marks: [[kind, x 0..1, y 0..1, rot], ...]
export function fillPad(pad, marks = []) {
  const size = X('stamp_size') || 24;
  pad.replaceChildren(...marks.map(([k, x, y, r], i) => {
    const s = Math.round(size * (0.9 + ((i * 37) % 21) / 100));
    const el = stampSvg(k, { size: s, rot: r });
    el.classList.add('stamp-mark');
    el.style.left = `calc(${(x * 100).toFixed(1)}% - ${(x * s).toFixed(1)}px)`;
    el.style.top = `calc(${(y * 100).toFixed(1)}% - ${(y * s).toFixed(1)}px)`;
    el.style.opacity = (0.8 + ((i * 53) % 19) / 100).toFixed(2);
    return el;
  }));
  if (marks.length) { pad.setAttribute('role', 'img'); pad.setAttribute('aria-label', `도장 ${marks.length}개`); }
  else { pad.removeAttribute('role'); pad.removeAttribute('aria-label'); }
}

// The stamp row inside a line's 속성 window. state: { counts, mine } (mutated on toggle).
export function stampButtons(app, line, state, { onChange } = {}) {
  const ident = app.identity();
  const row = h('div', { class: 'stamp-buttons', role: 'group', 'aria-label': '도장 찍기' });
  const msg = h('div', { class: 'stamp-msg', 'aria-live': 'polite' });
  const draw = () => {
    row.replaceChildren(...KINDS.map(k => {
      const mine = state.mine.includes(k);
      const b = h('button', {
        type: 'button', class: `stamp-btn${mine ? ' is-mine' : ''}`, 'aria-pressed': String(mine),
        title: ident ? (mine ? '다시 누르면 취소' : '눌러서 찍기') : '로그인하면 찍을 수 있어요',
        onclick: () => toggle(k, b),
      }, stampSvg(k, { size: 30 }), h('span', {}, SHORT[k], ' ', h('b', {}, state.counts?.[k] ?? 0)));
      return b;
    }));
  };
  let busy = false;
  async function toggle(kind, btn) {
    if (!ident) { msg.textContent = '도장은 로그인한 사람만 찍을 수 있어요.'; return; }
    if (busy) return;
    busy = true;
    try {
      const r = await api.toggleStamp(line.id, kind, ident);
      state.counts = r.counts;
      state.mine = r.stamped ? [...state.mine, kind] : state.mine.filter(k => k !== kind);
      draw();
      play(r.stamped ? 'stamp' : 'unstamp');
      if (r.stamped) {
        row.querySelector(`.stamp-btn:nth-child(${KINDS.indexOf(kind) + 1}) svg`)?.classList.add('thunk');
      }
      msg.textContent = '';
      onChange?.();
    } catch (e) { msg.textContent = errorText(e); }
    finally { busy = false; }
  }
  draw();
  return h('div', { class: 'stamp-box' }, row, msg);
}

// Red ticks on the right edge of a scroll area for lines with many stamps.
export function updateTicks(scroll, ticksEl, items) {
  if (!on('stamp_ticks')) { ticksEl.hidden = true; return; }
  const total = scroll.scrollHeight;
  if (total <= scroll.clientHeight + 4 || !items.length) { ticksEl.hidden = true; return; }
  const max = Math.max(...items.map(i => i.n));
  const min = Math.max(3, Math.ceil(max * 0.5));
  ticksEl.hidden = false;
  ticksEl.replaceChildren(...items.filter(i => i.n >= min).map(i => h('span', {
    style: `top:${((i.el.offsetTop + i.el.offsetHeight / 2) / total * 100).toFixed(2)}%;height:${i.n >= max * 0.85 ? 3 : 2}px`,
  })));
}

// 도움말 section with the big stamps.
export function helpSection() {
  if (!on('stamps') || !on('stamp_help')) return null;
  const meaning = { sun: '잘 이어 썼다!', laugh: '웃음이 났다!', cur: '다음 줄이 기다려진다!' };
  return h('section', { class: 'help-stamps' },
    h('h3', {}, '도장'),
    h('p', {}, '마음에 드는 줄에 도장을 찍어 주세요. 줄 옆 사람 아이콘을 누르면(컴퓨터에선 마우스를 올리면) 속성 창에 도장이 있어요.'),
    h('div', { class: 'help-stamp-row' }, KINDS.map(k => h('div', {},
      stampSvg(k, { mini: false, size: 96, label: NAMES[k] }), h('b', {}, NAMES[k]), h('span', { class: 'muted' }, meaning[k])))),
    h('ul', {},
      h('li', {}, '한 줄에 종류마다 한 번씩 찍을 수 있어요. 다시 누르면 취소돼요.'),
      h('li', {}, '줄 옆에는 그림만, 숫자는 속성 창에서만 보여요.'),
      h('li', {}, '손님(둘러보기)은 볼 수만 있어요.')));
}
