// 2026 가을 결산: after the deadline, the season in a few pages — numbers, firsts, the latest night,
// the most stamped line, the fastest story, and what piled up on the desktop. No names anywhere.
import * as api from '../api.js';
import { h, icon, errorText } from '../ui.js';
import { manuscript, reduceMotion } from '../extras/extras.js';
import { play } from '../extras/sound.js';
import { seal } from '../extras/stamps.js';

const n = (v) => Number(v ?? 0).toLocaleString('ko-KR');

export function recapView() {
  let data = null, page = 0, pages = [];
  const stage = h('div', { class: 'recap-stage', 'aria-live': 'polite' });
  const dots = h('div', { class: 'recap-dots', 'aria-hidden': 'true' });
  const prev = h('button', { type: 'button', class: 'btn', 'aria-label': '이전', onclick: () => go(page - 1) }, icon('prev', 14));
  const next = h('button', { type: 'button', class: 'btn btn-primary', 'aria-label': '다음', onclick: () => go(page + 1) }, icon('next', 14));
  const foot = h('div', { class: 'recap-foot' }, prev, dots, next);
  const body = document.createDocumentFragment();
  body.append(stage, foot);

  // big numbers count up in a few pixel steps
  function count(el) {
    const to = Number(el.dataset.to);
    if (reduceMotion() || !to) { el.textContent = n(to); return; }
    let i = 0;
    const t = setInterval(() => { i++; el.textContent = n(Math.round(to * Math.min(1, i / 8))); if (i >= 8) clearInterval(t); }, 70);
  }
  const big = (v, unit) => h('span', { class: 'recap-big' }, h('b', { dataset: { to: Number(v ?? 0) } }, '0'), unit);
  const quote = (q) => q?.text ? h('blockquote', {}, h('p', {}, q.text), h('cite', {}, `「${q.title || '제목 없는 이야기'}」${q.position ? ` ${q.position}번째 줄` : ''}`)) : h('p', { class: 'muted' }, '아직 없어요.');
  const hour = (x) => (x == null ? '—' : `${x < 12 ? '오전' : '오후'} ${x % 12 || 12}시`);

  function build(d) {
    return [
      () => [h('p', { class: 'recap-kicker' }, '연세문학회 릴레이 소설'), h('h2', {}, '2026 가을 결산'), seal(120, -8), h('p', { class: 'muted' }, '한 사람이 한 줄씩 이어 쓴 한 계절')],
      () => [h('h3', {}, '이만큼 썼어요'),
        h('div', { class: 'recap-grid' },
          h('div', {}, big(d.stories, '편'), h('span', {}, `이야기 (완결 ${n(d.completed)}편)`)),
          h('div', {}, big(d.lines, '줄'), h('span', {}, '이어 쓴 줄')),
          h('div', {}, big(manuscript(d.chars), '매'), h('span', {}, '200자 원고지')),
          h('div', {}, big(d.writers, '명'), h('span', {}, '함께 쓴 사람')))],
      () => [h('h3', {}, '모든 건 이 한 줄에서'), quote(d.first_line)],
      () => [h('h3', {}, '언제 썼을까'),
        h('ul', { class: 'recap-list' },
          h('li', {}, '가장 붐빈 시간 ', h('b', {}, hour(d.busiest_hour?.hour)), d.busiest_hour ? ` · ${n(d.busiest_hour.lines)}줄` : ''),
          h('li', {}, '가장 바빴던 날 ', h('b', {}, d.busiest_day?.day ?? '—'), d.busiest_day ? ` · ${n(d.busiest_day.lines)}줄` : ''),
          h('li', {}, '밤 12시 넘어 쓴 줄 ', h('b', {}, `${n(d.night_lines)}줄`)),
          d.latest_night ? h('li', {}, '가장 늦게까지 깨어 있던 시각 ', h('b', {}, `새벽 ${d.latest_night}`)) : null)],
      () => [h('h3', {}, '도장을 가장 많이 받은 줄'), big(d.most_stamped?.stamps, '개'), quote(d.most_stamped), h('p', { class: 'muted' }, `찍힌 도장 모두 ${n(d.stamps)}개`)],
      () => [h('h3', {}, '이야기들'),
        h('ul', { class: 'recap-list' },
          d.fastest ? h('li', {}, '가장 빨리 완결된 이야기 ', h('b', {}, `「${d.fastest.title || '제목 없는 이야기'}」`), ` · ${n(d.fastest.minutes)}분`) : null,
          d.most_writers ? h('li', {}, '가장 많은 사람이 이어 쓴 이야기 ', h('b', {}, `「${d.most_writers.title || '제목 없는 이야기'}」`), ` · ${n(d.most_writers.writers)}명`) : null)],
      () => [h('h3', {}, '바탕화면에 쌓인 것들'),
        h('div', { class: 'recap-grid' },
          h('div', {}, big(d.trash, '번'), h('span', {}, '휴지통에 간 줄')),
          h('div', {}, big(d.night_lines, '개'), h('span', {}, '커피 자국')),
          h('div', {}, big(d.cat_pets, '번'), h('span', {}, '고양이 쓰다듬기')),
          h('div', {}, big(d.guestbook, '개'), h('span', {}, '방명록')))],
      () => [h('h2', {}, '함께 써 줘서 고마워요'), h('p', {}, '이야기는 이야기 서랍에 그대로 있어요.', h('br'), '낭독회로 다시 들어 보세요.'), h('p', { class: 'muted' }, '연세문학회 · 2026 가을')],
    ];
  }
  function go(i) {
    if (!pages.length) return;
    page = Math.max(0, Math.min(pages.length - 1, i));
    stage.replaceChildren(h('div', { class: 'recap-page' }, pages[page]()));
    stage.querySelectorAll('[data-to]').forEach(count);
    dots.replaceChildren(...pages.map((_, k) => h('i', { class: k === page ? 'on' : '' })));
    prev.disabled = page === 0;
    next.disabled = page === pages.length - 1;
    play(page === pages.length - 1 ? 'chime' : 'select');
  }
  function onKey(e) {
    if (!stage.closest('.win')?.classList.contains('is-active')) return;
    if (e.key === 'ArrowRight') go(page + 1);
    else if (e.key === 'ArrowLeft') go(page - 1);
  }

  return {
    type: 'recap', route: '/recap', title: '2026 가을 결산', body,
    size: { w: 520, h: 480 }, minSize: { w: 360, h: 380 }, position: 'center',
    async mount() {
      addEventListener('keydown', onKey);
      stage.replaceChildren(h('p', { class: 'muted', style: 'padding:20px' }, '세어 보는 중…'));
      try { data = await api.seasonRecap(); pages = build(data); page = 0; go(0); }
      catch (e) { stage.replaceChildren(h('div', { class: 'notice bad', style: 'margin:16px' }, errorText(e))); }
    },
    unmount() { removeEventListener('keydown', onKey); },
  };
}
