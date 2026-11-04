// 새 이야기: title (optional) + first line.
import * as api from '../api.js';
import { h, errorText } from '../ui.js';

export function newStoryView(app) {
  const st = () => app.settings ?? { max_chars: 100, max_title_chars: 40 };
  const title = h('input', { type: 'text', class: 'field', id: 'ns-title', autocomplete: 'off', maxlength: 80, value: api.getDraft('new-title') });
  const text = h('textarea', { class: 'field', id: 'ns-text', rows: 3, value: api.getDraft('new') });
  const counter = h('span', { class: 'counter' });
  const msg = h('div', { role: 'alert' });
  const who = h('span', { class: 'muted', style: 'margin-right:auto' });
  const go = h('button', { type: 'submit', class: 'btn btn-primary' }, '시작하기');

  function update() {
    const n = api.countChars(text.value), max = st().max_chars;
    counter.textContent = `${n} / ${max}`;
    counter.classList.toggle('over', n > max);
    api.setDraft('new', text.value); api.setDraft('new-title', title.value);
  }
  function updateWho() {
    const ident = app.identity();
    who.textContent = ident ? `${ident.name} 님으로 시작해요` : '시작하려면 로그인이 필요해요';
    go.textContent = ident ? '시작하기' : '로그인하고 시작하기';
    const s = st();
    go.disabled = s.submissions_open === false || s.allow_new_stories === false;
    if (go.disabled) msg.replaceChildren(h('div', { class: 'notice warn' }, errorText({ code: s.submissions_open === false ? 'submissions_closed' : 'new_stories_closed' })));
  }
  text.addEventListener('input', update);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });

  const form = h('form', { class: 'win-scroll', style: 'padding:16px 18px;display:flex;flex-direction:column;gap:14px', novalidate: true },
    h('p', { style: 'margin:0', class: 'muted' }, `첫 줄을 쓰면 이야기가 시작돼요. 다른 사람들이 이어서 ${st().max_lines ?? 20}줄까지 함께 써요.`),
    h('div', { class: 'label' }, h('label', { for: 'ns-title' }, '제목 (선택)'), title),
    h('div', { class: 'label' }, h('span', { class: 'label-row' }, h('label', { for: 'ns-text' }, '첫 줄'), counter), text),
    msg,
    h('div', { class: 'actions', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      who, h('button', { type: 'button', class: 'btn', onclick: () => app.close('new') }, '닫기'), go));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ident = app.identity();
    if (!ident) { app.requireLogin('이야기를 시작하려면 로그인해 주세요.', '/new'); return; }
    const n = api.countChars(text.value);
    if (!n) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'empty_text' }))); text.focus(); return; }
    if (n > st().max_chars) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'too_long', detail: { max: st().max_chars } }))); return; }
    go.disabled = true; msg.replaceChildren();
    try {
      const r = await api.createStory({ title: title.value, text: text.value, ...ident });
      api.setDraft('new', ''); api.setDraft('new-title', '');
      title.value = ''; text.value = '';
      app.close('new');
      app.go(`/story/${r.story_id}`);
    } catch (err) {
      msg.replaceChildren(h('div', { class: 'notice bad' }, errorText(err)));
    } finally {
      updateWho();
    }
  });

  const body = document.createDocumentFragment();
  body.append(form);
  return {
    type: 'new', route: '/new', title: '새 이야기', body,
    size: { w: 460, h: 400 }, minSize: { w: 380, h: 340 }, origin: { x: 300, y: 90 },
    mount() { update(); updateWho(); setTimeout(() => text.focus({ preventScroll: true })); },
    onFocus: updateWho,
    onSettings() { update(); updateWho(); },
  };
}
