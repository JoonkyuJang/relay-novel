// 출석부: public contributor stats (only when the admin turns them on).
import * as api from '../api.js';
import { h, errorText } from '../ui.js';

export function rosterView() {
  let unwatch = null;
  const bar = h('div', { class: 'win-bar' }, h('span', { class: 'muted' }, '불러오는 중…'));
  const scroll = h('div', { class: 'win-scroll' });
  const body = document.createDocumentFragment();
  body.append(bar, scroll);

  async function refresh() {
    try {
      const rows = await api.publicStats();
      const withSid = rows.some(r => r.student_id);
      bar.replaceChildren(h('span', {}, `참여 ${rows.length}명`), h('span', { class: 'muted' }, '줄을 많이 쓴 순서'));
      if (!rows.length) { scroll.replaceChildren(h('div', { class: 'empty' }, '아직 아무도 쓰지 않았어요.')); return; }
      scroll.replaceChildren(h('table', { class: 'table' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, '이름'), withSid ? h('th', { scope: 'col' }, '학번') : null,
          h('th', { scope: 'col', class: 'num' }, '줄'), h('th', { scope: 'col', class: 'num' }, '이야기'))),
        h('tbody', {}, rows.map(r => h('tr', {},
          h('td', {}, r.name), withSid ? h('td', {}, r.student_id) : null,
          h('td', { class: 'num' }, r.lines), h('td', { class: 'num' }, r.stories))))));
    } catch (e) {
      bar.replaceChildren(h('span', { class: 'muted' }, '출석부'));
      scroll.replaceChildren(h('div', { class: 'empty' }, errorText(e)));
    }
  }

  return {
    type: 'roster', route: '/roster', title: '출석부', body,
    size: { w: 420, h: 440 }, minSize: { w: 340, h: 260 }, origin: { x: 220, y: 70 },
    mount() { refresh(); unwatch = api.watch(['list', 'settings'], refresh); },
    unmount() { unwatch?.(); },
  };
}
