// 내가 쓴 줄: every line I wrote (as this 이름 + 학번, on any device), grouped by story,
// with the stamps each line got. Opened from my name in the menu bar.
import * as api from '../api.js';
import { h, errorText } from '../ui.js';
import { on, manuscript } from '../extras/extras.js';
import { stampSvg, KINDS, NAMES } from '../extras/stamps.js';

export function mineView(app) {
  let unwatch = null;
  const bar = h('div', { class: 'win-bar' }, h('span', { class: 'muted' }, '불러오는 중…'));
  const scroll = h('div', { class: 'win-scroll mine' });
  const body = document.createDocumentFragment();
  body.append(bar, scroll);

  const d = (ts) => { const x = new Date(ts); return `${x.getMonth() + 1}.${String(x.getDate()).padStart(2, '0')}`; };

  async function refresh() {
    const ident = app.identity();
    if (!ident) {
      bar.replaceChildren(h('span', { class: 'muted' }, '로그인하면 내가 쓴 줄을 모아 볼 수 있어요.'));
      scroll.replaceChildren();
      return;
    }
    try {
      const rows = await api.myLines(ident);
      const stories = new Map();
      for (const r of rows) {
        if (!stories.has(r.story_id)) stories.set(r.story_id, { ...r, lines: [] });
        stories.get(r.story_id).lines.push(r);
      }
      const chars = rows.reduce((n, r) => n + api.countChars(r.text), 0);
      const got = rows.reduce((n, r) => n + KINDS.reduce((m, k) => m + (r.stamps?.[k] ?? 0), 0), 0);
      bar.replaceChildren(
        h('span', {}, `${ident.name} 님`),
        h('span', { class: 'muted' }, `줄 ${rows.length}개 · 이야기 ${stories.size}편 · ${on('manuscript') ? `원고지 ${manuscript(chars)}매` : `${chars}자`}${on('stamps') ? ` · 받은 도장 ${got}개` : ''}`));
      if (!rows.length) {
        scroll.replaceChildren(h('div', { class: 'empty' }, '아직 쓴 줄이 없어요. 이야기 서랍에서 이어 써 보세요.'));
        return;
      }
      scroll.replaceChildren(...[...stories.values()].map(s => h('section', { class: 'mine-story' },
        h('h3', {}, h('a', { href: `#/story/${s.story_id}` }, s.title || '제목 없는 이야기'),
          h('span', { class: `chip ${s.status === 'completed' ? 'grass' : 'sky'}` }, s.status === 'completed' ? '완결' : '진행 중')),
        h('ol', { class: 'mine-lines' }, s.lines.sort((a, b) => a.position - b.position).map(l => h('li', {},
          h('span', { class: 'line-no' }, String(l.position).padStart(2, '0')),
          h('span', { class: 'line-text' }, l.text),
          h('span', { class: 'mine-meta' },
            on('stamps') ? KINDS.filter(k => l.stamps?.[k]).map(k => h('span', { class: 'tot', role: 'img', title: NAMES[k], 'aria-label': `${NAMES[k]} ${l.stamps[k]}개` },
              stampSvg(k, { size: 16 }), h('span', { 'aria-hidden': 'true' }, l.stamps[k]))) : null,
            h('span', { class: 'faint' }, d(l.created_at)))))))));
    } catch (e) {
      bar.replaceChildren(h('span', { class: 'muted' }, '내가 쓴 줄'));
      scroll.replaceChildren(h('div', { class: 'empty' }, errorText(e)));
    }
  }

  return {
    type: 'mine', route: '/mine', title: '내가 쓴 줄', body,
    size: { w: 560, h: 520 }, minSize: { w: 380, h: 300 }, origin: { x: 200, y: 70 },
    mount() { refresh(); unwatch = api.watch(['list'], refresh); },
    onFocus: refresh,
    unmount() { unwatch?.(); },
  };
}
