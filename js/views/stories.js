// 이야기 서랍: every story, ongoing first.
import * as api from '../api.js';
import { h, relTime, errorText } from '../ui.js';

function chip(s) {
  if (s.status === 'completed') return h('span', { class: 'chip grass' }, '완결');
  if (s.writing) return h('span', { class: 'chip pink' }, '쓰는 중…');
  return h('span', { class: 'chip sky' }, '진행 중');
}

export function storiesView(app) {
  let unwatch = null;
  const bar = h('div', { class: 'win-bar' }, h('span', { class: 'muted' }, '불러오는 중…'));
  const head = h('div', { class: 'drawer-head', 'aria-hidden': 'true' },
    h('span', {}, '이름'), h('span', {}, '줄'), h('span', {}, '상태'), h('span', { class: 'when' }, '최근'));
  const rows = h('div', { class: 'win-scroll' });
  const foot = h('div', { class: 'win-foot' },
    h('div', { class: 'actions', style: 'justify-content:space-between;align-items:center' },
      h('a', { href: '#/guestbook', class: 'btn-link' }, '방명록 ▸'),
      h('a', { href: '#/new', class: 'btn btn-primary' }, '새 이야기 시작')));
  const body = document.createDocumentFragment();
  body.append(bar, head, rows, foot);

  function row(s) {
    const name = s.title || s.first_line || '(제목 없음)';
    return h('a', { href: `#/story/${s.id}`, class: 'drawer-row', 'aria-label': `${name}, ${s.line_count}/${s.max_lines}줄, ${s.status === 'completed' ? '완결' : '진행 중'}` },
      h('span', { class: 'name' }, name),
      h('span', {}, `${s.line_count}/${s.max_lines}`),
      h('span', {}, chip(s)),
      h('span', { class: 'when' }, relTime(s.status === 'completed' ? s.completed_at : s.updated_at)));
  }

  async function refresh() {
    try {
      const list = await api.listStories();
      const open = list.filter(s => s.status === 'open');
      const done = list.filter(s => s.status === 'completed')
        .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
      bar.replaceChildren(
        h('span', {}, `이야기 ${list.length}개`),
        h('span', { class: 'muted' }, `진행 중 ${open.length}`),
        h('span', { class: 'muted' }, `완결 ${done.length}`));
      if (!list.length) {
        rows.replaceChildren(h('div', { class: 'empty' }, '아직 이야기가 없어요. 첫 줄을 써서 시작해 보세요.'));
        return;
      }
      rows.replaceChildren(...[
        open.length ? h('div', { class: 'drawer-sep' }, '진행 중') : null,
        ...open.map(row),
        done.length ? h('div', { class: 'drawer-sep' }, '완결') : null,
        ...done.map(row)].filter(Boolean));
    } catch (e) {
      rows.replaceChildren(h('div', { class: 'empty' }, errorText(e)));
    }
  }

  return {
    type: 'stories', route: '/stories', title: '이야기 서랍', body,
    size: { w: 480, h: 470 }, origin: { x: 36, y: 24 },
    mount() { refresh(); unwatch = api.watch(['list'], refresh); },
    unmount() { unwatch?.(); },
  };
}
