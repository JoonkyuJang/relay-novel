// 방명록: free messages, writer hidden behind the same 속성 window.
import * as api from '../api.js';
import { h, icon, fmtTime, errorText, toggleProps } from '../ui.js';

const pad3 = (n) => String(n).padStart(3, '0');

export function guestbookView(app) {
  let items = [];
  let total = 0;
  let hasMore = false;
  let unwatch = null;
  let cooldownUntil = 0, cdTimer = null;
  let revealedId = null;

  const st = () => app.settings ?? { guestbook_max_chars: 200, guestbook_cooldown_seconds: 30 };
  const bar = h('div', { class: 'win-bar' }, h('span', { class: 'muted' }, '불러오는 중…'));
  const notes = h('div', { class: 'notes' });
  const more = h('div', { class: 'more' });
  const scroll = h('div', { class: 'win-scroll' }, notes, more);
  const ta = h('textarea', { class: 'field', id: 'gb-text', rows: 2, value: api.getDraft('guestbook'), placeholder: '아무 이야기나 한마디' });
  const counter = h('span', { class: 'counter' });
  const who = h('span', {});
  const msg = h('div', { role: 'alert' });
  const send = h('button', { type: 'button', class: 'btn btn-primary', onclick: post }, '남기기');
  const foot = h('div', { class: 'win-foot' },
    h('label', { class: 'label-row', for: 'gb-text' }, who, counter), ta, msg,
    h('div', { class: 'actions' }, send));
  const body = document.createDocumentFragment();
  body.append(bar, scroll, foot);

  function update() {
    const n = api.countChars(ta.value), max = st().guestbook_max_chars;
    counter.textContent = `${n} / ${max}`;
    counter.classList.toggle('over', n > max);
    api.setDraft('guestbook', ta.value);
  }
  function updateWho() {
    const ident = app.identity();
    who.textContent = ident ? `${ident.name} 님으로 남겨요 · 이름은 숨겨져요` : '이름은 숨겨져요';
    if (Date.now() >= cooldownUntil) {
      send.textContent = ident ? '남기기' : '로그인하고 남기기';
      send.disabled = st().guestbook_open === false;
    }
    if (st().guestbook_open === false) msg.replaceChildren(h('div', { class: 'notice warn' }, errorText({ code: 'guestbook_closed' })));
  }
  ta.addEventListener('input', update);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
  });

  function card(g) {
    const el = h('article', { class: `note${revealedId === g.id ? ' is-revealed' : ''}` });
    const btn = h('button', {
      type: 'button', class: 'who', 'aria-label': `#${pad3(g.no)} 남긴 사람 보기`, 'aria-expanded': 'false',
      onclick: () => {
        toggleProps(btn, `#${pad3(g.no)} 속성`, [
          ['작성자', g.author_name], ['학번', g.student_id], ['남긴 시각', fmtTime(g.created_at)],
        ], () => { revealedId = null; notes.querySelector('.is-revealed')?.classList.remove('is-revealed'); });
        if (btn.getAttribute('aria-expanded') === 'true') { revealedId = g.id; el.classList.add('is-revealed'); }
      },
    }, icon('person', 16));
    el.append(
      h('div', { class: 'note-meta' }, h('span', {}, `#${pad3(g.no)}`), h('span', {}, fmtTime(g.created_at)), h('span', { class: 'spacer' }), btn),
      h('div', { class: 'note-text' }, g.text));
    return el;
  }

  function render() {
    bar.replaceChildren(h('span', {}, `남긴 말 ${total}개`),
      h('span', { class: 'muted' }, `아무 이야기나 자유롭게 · 한 번에 ${st().guestbook_max_chars}자까지`));
    notes.replaceChildren(...(items.length ? items.map(card) : [h('div', { class: 'empty' }, '아직 아무도 남기지 않았어요. 첫 마디를 남겨 주세요.')]));
    more.replaceChildren(...(hasMore ? [h('button', { type: 'button', class: 'btn', onclick: loadMore }, '더 보기')] : []));
  }

  async function refresh() {
    try {
      const r = await api.listGuestbook({ limit: Math.min(100, Math.max(30, items.length)) });
      const older = items.filter(i => i.no < (r.items.at(-1)?.no ?? 0));
      items = [...r.items, ...older];
      total = r.total;
      hasMore = older.length ? hasMore : r.has_more;
      render();
    } catch (e) {
      if (!items.length) notes.replaceChildren(h('div', { class: 'empty' }, errorText(e)));
    }
  }

  async function loadMore() {
    try {
      const r = await api.listGuestbook({ before: items.at(-1)?.no ?? null, limit: 30 });
      items = [...items, ...r.items]; hasMore = r.has_more; total = r.total;
      render();
    } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText(e))); }
  }

  function startCooldown(sec) {
    cooldownUntil = Date.now() + sec * 1000;
    clearInterval(cdTimer);
    const step = () => {
      const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (left <= 0) { clearInterval(cdTimer); send.disabled = false; updateWho(); return; }
      send.disabled = true; send.textContent = `${left}초 후 다시`;
    };
    step(); cdTimer = setInterval(step, 1000);
  }

  let busy = false;
  async function post() {
    if (busy || send.disabled) return;
    const ident = app.identity();
    if (!ident) { app.requireLogin('방명록을 남기려면 로그인해 주세요.', '/guestbook'); return; }
    const n = api.countChars(ta.value), max = st().guestbook_max_chars;
    if (!n) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'empty_text' }))); return; }
    if (n > max) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'too_long', detail: { max } }))); return; }
    busy = true; send.disabled = true; msg.replaceChildren();
    try {
      await api.postGuestbook(ta.value, ident);
      ta.value = ''; update();
      await refresh();
      scroll.scrollTop = 0;
      startCooldown(st().guestbook_cooldown_seconds ?? 30);
    } catch (e) {
      msg.replaceChildren(h('div', { class: 'notice bad' }, errorText(e)));
      if (e.code === 'cooldown') startCooldown(e.detail?.wait ?? 30);
      else send.disabled = false;
    } finally {
      busy = false;
    }
  }

  return {
    type: 'guestbook', route: '/guestbook', title: '방명록', body,
    size: { w: 760, h: 620 }, origin: { x: 140, y: 34 },
    mount() { update(); updateWho(); refresh(); unwatch = api.watch(['guestbook'], refresh); },
    unmount() { unwatch?.(); clearInterval(cdTimer); },
    onFocus: updateWho,
    onSettings() { update(); updateWho(); render(); },
  };
}
