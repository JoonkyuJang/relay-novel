// 원고지로 인쇄: a finished story laid out on 200자 원고지 (20 × 10 cells), two sheets per A4
// page, ready to print or save as PDF for the webzine. Names only in the credits.
//
// Layout (simplified 원고지 rules): title centred on the first row, "연세문학회 릴레이 소설" on the
// second, a blank row, then one paragraph per line of the story (first cell left empty);
// a space never starts a row; digits and Latin letters go two to a cell.
import { h } from '../ui.js';
import { kst } from './extras.js';
import { seal } from './stamps.js';

const COLS = 20, ROWS = 10;

// text -> cell contents (strings; '' = empty cell), following the rules above
function cellsFor(text) {
  const out = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/[0-9A-Za-z]/.test(c) && /[0-9A-Za-z]/.test(chars[i + 1] ?? '')) { out.push(c + chars[i + 1]); i++; continue; }
    out.push(c);
  }
  return out;
}

function layout(story, names) {
  const rows = [];
  const row = () => { rows.push(Array(COLS).fill('')); return rows.at(-1); };
  const put = (cells, { indent = 0 } = {}) => {
    let r = row(), col = indent;
    for (const c of cells) {
      if (col >= COLS) { r = row(); col = 0; if (c === ' ') continue; }   // a space never starts a row
      r[col++] = c === ' ' ? '' : c;
    }
  };
  const title = cellsFor(story.title || '제목 없는 이야기').slice(0, COLS - 2);
  const t = row(); title.forEach((c, i) => { t[Math.floor((COLS - title.length) / 2) + i] = c === ' ' ? '' : c; });
  const by = cellsFor('연세문학회 릴레이 소설'); const b = row(); by.forEach((c, i) => { b[COLS - 1 - by.length + i] = c === ' ' ? '' : c; });
  row();
  for (const l of story.lines) if (!l.removed) put(cellsFor(l.text.trim()), { indent: 1 });
  if (names.length) { row(); put(cellsFor(`함께 쓴 사람: ${names.join(', ')}`), { indent: 1 }); }
  // the 완결 seal sits on the last three rows of the last sheet: start a new sheet only if they're taken
  const used = rows.length % ROWS;
  if (used === 0 || ROWS - used < 3) { while (rows.length % ROWS !== 0) row(); row(); }
  const sheets = [];
  for (let i = 0; i < rows.length; i += ROWS) {
    const s = rows.slice(i, i + ROWS);
    while (s.length < ROWS) s.push(Array(COLS).fill(''));
    sheets.push(s);
  }
  return sheets;
}

export function printSheets(story) {
  const names = [...new Set(story.lines.filter(l => !l.removed).map(l => l.author_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  const sheets = layout(story, names);
  const done = story.completed_at ? kst(new Date(story.completed_at)) : null;
  const wrap = h('div', { class: 'print-sheets', 'aria-hidden': 'true' },
    sheets.map((rows, i) => h('section', { class: 'ms-sheet' },
      h('div', { class: 'ms-grid' }, rows.map(r => h('div', { class: 'ms-row' }, r.map(c => h('span', { class: c.length > 1 ? 'ms-cell two' : 'ms-cell' }, c))))),
      h('div', { class: 'ms-foot' },
        h('span', {}, `200자 원고지 · ${i + 1} / ${sheets.length}`),
        h('span', {}, done ? `${done.y}. ${done.m}. ${done.d}. 완결 · 연문회 OS` : '연문회 OS')),
      i === sheets.length - 1 ? h('div', { class: 'ms-seal' }, seal(120, -8)) : null)));
  document.querySelector('.print-sheets')?.remove();
  document.body.append(wrap);
  document.body.classList.add('printing');
  const title = document.title;
  document.title = `${story.title || '제목 없는 이야기'} — 연세문학회 릴레이 소설`;   // the PDF's file name
  const cleanup = () => {
    document.body.classList.remove('printing');
    wrap.remove();
    document.title = title;
    removeEventListener('afterprint', cleanup);
  };
  addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 50);
  return { sheets: sheets.length, cleanup };
}
