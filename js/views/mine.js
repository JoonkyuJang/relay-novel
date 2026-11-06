// 내가 쓴 줄: every line I wrote (as this 이름 + 학번, on any device), grouped by story,
// with the stamps each line got. Opened from my name in the menu bar.
import * as api from '../api.js';
import { h, errorText } from '../ui.js';
import { on, manuscript, kst } from '../extras/extras.js';
import { play } from '../extras/sound.js';
import { stampSvg, KINDS, NAMES } from '../extras/stamps.js';

// 도장 수첩: small achievements worked out from my own lines (nothing new is stored on the server)
const BADGES = [
  ['first',  '첫',  '첫 줄',       '아무 이야기에나 첫 줄을 이어 쓰면', (L) => L.length > 0],
  ['opener', '문',  '첫 문장',     '새 이야기를 시작하면', (L) => L.some(l => l.position === 1)],
  ['closer', '끝',  '마지막 줄',   '이야기의 마지막 줄을 쓰면', (L) => L.some(l => l.last)],
  ['full',   '꽉',  '꽉 채운 줄',  '글자 수를 딱 맞춰 꽉 채우면', (L) => L.some(l => l.full)],
  ['owl',    '밤',  '올빼미',      '밤 12시부터 새벽 6시 사이에 쓰면', (L) => L.some(l => kst(new Date(l.created_at)).h < 6)],
  ['early',  '해',  '아침 글쓴이', '아침 6시부터 9시 사이에 쓰면', (L) => L.some(l => { const hr = kst(new Date(l.created_at)).h; return hr >= 6 && hr < 9; })],
  ['five',   '다섯', '다섯 이야기', '서로 다른 이야기 다섯 편에 쓰면', (L) => new Set(L.map(l => l.story_id)).size >= 5],
  ['ten',    '열',  '열 줄',       '줄을 열 개 쓰면', (L) => L.length >= 10],
  ['done',   '완',  '완결 동료',   '내가 쓴 이야기가 완결되면', (L) => L.some(l => l.status === 'completed')],
  ['rich',   '부',  '도장 부자',   '받은 도장이 모두 10개가 되면', (L) => L.reduce((n, l) => n + KINDS.reduce((m, k) => m + (l.stamps?.[k] ?? 0), 0), 0) >= 10],
  ['triple', '셋',  '세 가지 도장', '한 줄에 도장 세 가지를 다 받으면', (L) => L.some(l => KINDS.every(k => (l.stamps?.[k] ?? 0) > 0))],
  ['hit',    '인',  '인기 줄',     '한 줄에 도장을 다섯 개 받으면', (L) => L.some(l => KINDS.reduce((m, k) => m + (l.stamps?.[k] ?? 0), 0) >= 5)],
];
function stampCard(rows) {
  const seen = new Set(api.prefs.getJSON('badgesSeen') ?? []);
  const got = BADGES.filter(b => b[4](rows)).map(b => b[0]);
  const fresh = got.filter(id => !seen.has(id));
  api.prefs.setJSON('badgesSeen', [...new Set([...seen, ...got])]);
  if (fresh.length) setTimeout(() => play('stamp'), 300);
  return h('section', { class: 'stamp-card', 'aria-label': `도장 수첩 ${got.length} / ${BADGES.length}` },
    h('h3', {}, '도장 수첩', h('span', { class: 'muted' }, ` ${got.length} / ${BADGES.length}`)),
    h('ul', {}, BADGES.map(([id, glyph, name, how]) => {
      const has = got.includes(id);
      return h('li', { class: `badge-cell${has ? ' got' : ''}${fresh.includes(id) ? ' fresh' : ''}`, title: has ? `${name} — ${how}` : `아직: ${how}` },
        h('span', { class: 'badge-seal', 'aria-hidden': 'true' }, has ? glyph : '?'),
        h('span', { class: 'badge-name' }, name),
        h('span', { class: 'sr-only' }, has ? '받았어요' : `아직 · ${how}`));
    })));
}

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
        scroll.replaceChildren(on('stamp_card') ? stampCard(rows) : '', h('div', { class: 'empty' }, '아직 쓴 줄이 없어요. 이야기 서랍에서 이어 써 보세요.'));
        return;
      }
      scroll.replaceChildren(on('stamp_card') ? stampCard(rows) : '', ...[...stories.values()].map(s => h('section', { class: 'mine-story' },
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
