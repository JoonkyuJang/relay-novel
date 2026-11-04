// 이야기 기록 for a finished story: numbers, 원고지 매수, and the 이어달리기 strip.
import { h } from '../ui.js';
import { prefs, countChars } from '../api.js';
import { on, kst, WEEKDAY, manuscript } from './extras.js';

const SVGNS = 'http://www.w3.org/2000/svg';

// Tiny 원고지 icon with every cell filled (the 꽉 채웠어요 mark).
export function gridIcon(size = 16, color = 'var(--stamp)') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', Math.round(size * 0.75));
  svg.setAttribute('viewBox', '0 0 16 12'); svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<path d="M0.5 0.5h15v11h-15z" fill="none" stroke="${color}"/><path d="M5.5 0.5v11M10.5 0.5v11M0.5 6h15" stroke="${color}"/>`
    + `<path d="M2 2h2v3H2zM7 2h2v3H7zM12 2h2v3h-2zM2 7h2v3H2zM7 7h2v3H7zM12 7h2v3h-2z" fill="${color}"/>`;
  svg.classList.add('grid-icon');
  return svg;
}

export function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${Math.max(1, m)}분`;
  const hrs = Math.floor(m / 60), d = Math.floor(hrs / 24);
  if (d >= 1) return `${d}일${hrs % 24 ? ` ${hrs % 24}시간` : ''}`;
  return `${hrs}시간${m % 60 ? ` ${m % 60}분` : ''}`;
}
function shortDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}`;
  return duration(ms);
}
const hourName = (h24) => `${h24 < 12 ? (h24 < 6 ? '새벽' : '오전') : (h24 < 18 ? '오후' : '밤')} ${h24 % 12 || 12}시`;

export function relayRecord(story) {
  const lines = story.lines.filter(l => !l.removed);
  const chars = lines.reduce((a, l) => a + countChars(l.text), 0);
  const writers = new Set(lines.map(l => `${l.author_name}|${l.student_id ?? ''}`)).size;
  const times = story.lines.map(l => Date.parse(l.created_at));
  const start = Date.parse(story.created_at), end = Date.parse(story.completed_at ?? story.lines.at(-1)?.created_at ?? story.created_at);
  let fastest = null, longest = null;
  for (let i = 1; i < times.length; i++) {
    const gap = { ms: times[i] - times[i - 1], from: story.lines[i - 1].position, to: story.lines[i].position };
    if (!fastest || gap.ms < fastest.ms) fastest = gap;
    if (!longest || gap.ms > longest.ms) longest = gap;
  }
  const hours = new Array(24).fill(0);
  times.forEach(t => hours[kst(new Date(t)).h]++);
  const busiest = times.length ? hours.indexOf(Math.max(...hours)) : null;
  return { lines: story.lines.length, chars, writers, start, end, times, fastest, longest, busiest };
}

export function recordView(rec) {
  const stat = (label, value) => h('div', { class: 'rec-stat' }, h('span', {}, label), h('b', {}, value));
  const summary = [`${rec.lines}줄`, on('manuscript') ? `원고지 ${manuscript(rec.chars)}매` : null, `${rec.writers}명`, duration(rec.end - rec.start)].filter(Boolean).join(' · ');
  const det = h('details', { class: 'record', open: prefs.get('rec.open') === '1' },
    h('summary', {}, h('span', { class: 'arr', 'aria-hidden': 'true' }, '>'), h('b', {}, '이야기 기록'), h('span', { class: 'sum' }, summary)),
    h('div', { class: 'rec-body' },
      h('div', { class: 'rec-stats' },
        stat('줄', `${rec.lines}줄`), stat('글자', `${rec.chars.toLocaleString('ko-KR')}자`),
        on('manuscript') ? stat('원고지', `${manuscript(rec.chars)}매`) : null,
        stat('함께 쓴 사람', `${rec.writers}명`), stat('걸린 시간', duration(rec.end - rec.start))),
      on('relay_record') && rec.times.length > 1 ? relayStrip(rec) : null));
  det.addEventListener('toggle', () => prefs.set('rec.open', det.open ? '1' : '0'));
  return det;
}

function relayStrip(rec) {
  const span = Math.max(1, rec.end - rec.start);
  const s = kst(new Date(rec.start)), e = kst(new Date(rec.end));
  const dayStart = Date.UTC(s.y, s.m - 1, s.d) - 9 * 3600e3;          // KST midnight of the first day
  const days = [];
  for (let t = dayStart; t < rec.end; t += 86400e3) days.push(t);
  const strip = h('div', { class: 'relay-strip' },
    days.length > 1 ? days.map((t, i) => {
      const left = Math.max(0, (t - rec.start) / span), right = Math.min(1, (t + 86400e3 - rec.start) / span);
      return h('div', { class: `relay-day${i % 2 ? ' alt' : ''}`, style: `left:${(left * 100).toFixed(2)}%;width:${((right - left) * 100).toFixed(2)}%` },
        h('span', {}, WEEKDAY[kst(new Date(t + 3600e3)).wd]));
    }) : null,
    rec.times.map((t, i) => h('i', {
      class: i === rec.times.length - 1 ? 'last' : '', title: `${i + 1}번째 줄`,
      style: `left:calc(${(((t - rec.start) / span) * 100).toFixed(2)}% - 2px)`,
    })));
  const label = `${s.m}.${String(s.d).padStart(2, '0')} ${WEEKDAY[s.wd]} → ${e.m}.${String(e.d).padStart(2, '0')} ${WEEKDAY[e.wd]}`;
  return h('div', { class: 'relay' },
    h('span', { class: 'faint' }, `이어달리기 기록 — 줄이 쓰인 때 (${label})`),
    strip,
    h('div', { class: 'relay-facts' },
      rec.fastest ? h('span', {}, '⚡ 가장 빠른 바통 ', h('b', {}, shortDuration(rec.fastest.ms)), h('span', { class: 'faint' }, ` (${rec.fastest.from}→${rec.fastest.to}줄)`)) : null,
      rec.longest ? h('span', {}, '⏳ 가장 긴 기다림 ', h('b', {}, shortDuration(rec.longest.ms)), h('span', { class: 'faint' }, ` (${rec.longest.from}→${rec.longest.to}줄)`)) : null,
      rec.busiest != null ? h('span', {}, '☾ 가장 많이 쓴 때 ', h('b', {}, hourName(rec.busiest))) : null));
}
