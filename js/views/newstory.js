// 새 이야기: title (required unless the admin turns it off) + first line.
// While the 건의함 is on, only admins start a story here; everyone else proposes one (새 이야기 건의),
// and it waits in the 건의함 until an admin 채택s it.
import * as api from '../api.js';
import { h, errorText } from '../ui.js';
import { X, on, bus, deadlinePassed } from '../extras/extras.js';

export function newStoryView(app) {
  const st = () => app.settings ?? { max_chars: 100, max_title_chars: 40, max_lines: 20 };
  const proposing = () => on('proposals') && !app.admin;
  const title = h('input', { type: 'text', class: 'field', id: 'ns-title', autocomplete: 'off', maxlength: 80, value: api.getDraft('new-title') });
  const text = h('textarea', { class: 'field', id: 'ns-text', rows: 3, value: api.getDraft('new') });
  const counter = h('span', { class: 'counter' });
  const titleLabel = h('label', { for: 'ns-title' });
  const needTitle = () => X('title_required') !== false;
  const msg = h('div', { role: 'alert' });
  const intro = h('p', { style: 'margin:0', class: 'muted' });
  const how = h('div', { class: 'how', 'aria-label': '건의가 올라가는 길' });
  const slots = h('p', { class: 'muted', style: 'margin:0' });
  const who = h('span', { class: 'muted', style: 'margin-right:auto' });
  const go = h('button', { type: 'submit', class: 'btn btn-primary' }, '시작하기');
  let myWaiting = null, closedCode = null, view = null;

  function update() {
    const n = api.countChars(text.value), max = st().max_chars;
    counter.textContent = `${n} / ${max}`;
    counter.classList.toggle('over', n > max);
    api.setDraft('new', text.value); api.setDraft('new-title', title.value);
    titleLabel.textContent = needTitle() ? '제목' : '제목 (선택)';
    title.required = needTitle();
    title.maxLength = st().max_title_chars ?? 80;
  }
  function updateWho() {
    const ident = app.identity();
    const p = proposing();
    view?.setTitle?.(p ? '새 이야기 건의' : '새 이야기');
    intro.textContent = p
      ? `제목과 첫 줄을 건의함에 올려요. 관리자가 채택하면 이야기 서랍에 올라가고, 다른 사람들이 이어서 ${st().max_lines ?? 20}줄까지 함께 써요.`
      : `첫 줄을 쓰면 이야기가 시작돼요. 다른 사람들이 이어서 ${st().max_lines ?? 20}줄까지 함께 써요.`;
    how.hidden = !p;
    how.replaceChildren(...(p ? [h('i', {}, '건의'), '→', on('proposal_likes') ? [h('i', {}, '건의함에서 ♥'), '→'] : null, h('i', {}, '관리자 채택'), '→', h('i', {}, '서랍')].flat().filter(Boolean) : []));
    slots.hidden = !p || !ident || myWaiting == null;
    slots.textContent = `내 건의 ${myWaiting ?? 0}/${X('proposals_per_person')} 기다리는 중`;
    who.textContent = ident ? `${ident.name} 님으로 ${p ? '건의해요' : '시작해요'}` : `${p ? '건의하려면' : '시작하려면'} 로그인이 필요해요`;
    go.textContent = ident ? (p ? '건의하기' : '시작하기') : (p ? '로그인하고 건의하기' : '로그인하고 시작하기');
    const s = st();
    const why = s.submissions_open === false ? 'submissions_closed' : deadlinePassed() ? 'deadline_passed'
      : p ? closedCode
      : s.allow_new_stories === false && !app.admin ? 'new_stories_closed' : null;
    go.disabled = !!why;
    if (why) msg.replaceChildren(h('div', { class: 'notice warn', dataset: { closed: '1' } }, errorText({ code: why })));
    else if (msg.querySelector('[data-closed]')) msg.replaceChildren();
  }
  // how many of my proposals are waiting, and whether the 건의함 takes new ones (deadline etc.)
  async function loadSlots() {
    if (!proposing()) { myWaiting = null; closedCode = null; updateWho(); return; }
    try {
      const r = await api.listProposals(app.identity()?.studentId ?? null);
      myWaiting = r.my_waiting; closedCode = r.closed;
    } catch { /* the server says no when it matters */ }
    updateWho();
  }
  text.addEventListener('input', update);
  title.addEventListener('input', update);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });

  const form = h('form', { class: 'win-scroll', style: 'padding:16px 18px;display:flex;flex-direction:column;gap:14px', novalidate: true },
    intro, how,
    h('div', { class: 'label' }, titleLabel, title),
    h('div', { class: 'label' }, h('span', { class: 'label-row' }, h('label', { for: 'ns-text' }, '첫 줄'), counter), text),
    slots,
    msg,
    h('div', { class: 'actions', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      who, h('button', { type: 'button', class: 'btn', onclick: () => app.close('new') }, '닫기'), go));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ident = app.identity();
    const p = proposing();
    if (!ident) { app.requireLogin(p ? '건의하려면 로그인해 주세요.' : '이야기를 시작하려면 로그인해 주세요.', '/new'); return; }
    if (needTitle() && !title.value.trim()) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'title_required' }))); title.focus(); return; }
    const n = api.countChars(text.value);
    if (!n) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'empty_text' }))); text.focus(); return; }
    if (n > st().max_chars) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'too_long', detail: { max: st().max_chars } }))); return; }
    go.disabled = true; msg.replaceChildren();
    try {
      if (p) {
        const r = await api.proposeStory({ title: title.value, text: text.value, ...ident });
        app.justProposed = r.proposal_id;
      } else {
        const r = await api.createStory({ title: title.value, text: text.value, ...ident });
        bus.emit('my-line', { storyId: r.story_id });
        app.justStarted = r.story_id;
      }
      api.setDraft('new', ''); api.setDraft('new-title', '');
      title.value = ''; text.value = '';
      app.close('new');
      app.go(p ? '/proposals' : `/story/${app.justStarted}`);
    } catch (err) {
      msg.replaceChildren(h('div', { class: 'notice bad' }, errorText(err)));
      if (err.code === 'proposal_limit') loadSlots();
    } finally {
      updateWho();
    }
  });

  const body = document.createDocumentFragment();
  body.append(form);
  view = {
    type: 'new', route: '/new', title: proposing() ? '새 이야기 건의' : '새 이야기', body,
    size: { w: 460, h: 440 }, minSize: { w: 380, h: 360 }, origin: { x: 300, y: 90 },
    mount() { update(); updateWho(); loadSlots(); setTimeout(() => text.focus({ preventScroll: true })); },
    onFocus() { updateWho(); loadSlots(); },
    onSettings() { update(); updateWho(); loadSlots(); },
  };
  return view;
}
