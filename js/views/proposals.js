// 새로운 이야기 건의함: proposed stories (a title + first line) wait here. Everyone can read them,
// logged-in people can ♥ them (a guide for the admins, nothing more), and admins 채택 one (editing it
// first if needed: it then goes to the 서랍 as an ordinary story, the first line in the proposer's name)
// or 반려 it (it leaves the public list; the proposer sees 반려 in 내가 쓴 줄).
import * as api from '../api.js';
import { h, icon, relTime, errorText, osDialog } from '../ui.js';
import { on, X, iga } from '../extras/extras.js';
import { play } from '../extras/sound.js';

const n = (v) => Number(v ?? 0).toLocaleString('ko-KR');

export function proposalsView(app) {
  let unwatch = null, items = [], myWaiting = 0, closed = null, loaded = false;
  let sort = api.prefs.get('proposalSort') || null;           // this viewer's pick, else the admin's default
  let confirming = null;                                        // the card asking "반려할까요?"
  let note = null;                                              // { kind, text, href } shown on top until the window closes
  let wasAdmin = app.admin;

  const countEl = h('span', { class: 'muted' }, '불러오는 중…');
  const byLikes = h('button', { type: 'button', onclick: () => pick('likes') }, '좋아요 순');
  const byNew = h('button', { type: 'button', onclick: () => pick('new') }, '최신 순');
  const seg = h('div', { class: 'seg seg-sm', role: 'group', 'aria-label': '정렬' }, byLikes, byNew);
  const bar = h('div', { class: 'win-bar' }, countEl, h('span', { style: 'flex:1' }), seg);
  const scroll = h('div', { class: 'win-scroll' });
  const footText = h('span', { class: 'muted', style: 'margin-right:auto' });
  const footBtn = h('a', { href: '#/new', class: 'btn btn-primary' });
  const foot = h('div', { class: 'win-foot' }, h('div', { class: 'actions', style: 'align-items:center' }, footText, footBtn));
  const body = document.createDocumentFragment();
  body.append(bar, scroll, foot);

  const likesOn = () => on('proposal_likes');
  const sortNow = () => {
    const s = sort ?? (X('proposal_sort') === 'new' ? 'new' : 'likes');
    return s === 'likes' && likesOn() && items.some(p => p.likes != null) ? 'likes' : 'new';
  };
  function pick(s) { sort = s; api.prefs.set('proposalSort', s); draw(); }

  async function refresh() {
    const ident = app.identity();
    try {
      const r = await api.listProposals(ident?.studentId ?? null);
      closed = r.closed; myWaiting = r.my_waiting;
      items = r.items;
      if (app.admin) {
        // admins also see how many stories each proposer already has (a warning on 채택, never a block)
        const all = await api.admin.listProposals().catch(() => null);
        if (all) { const by = new Map(all.map(p => [p.id, p])); items = items.map(p => ({ ...p, author_stories: by.get(p.id)?.author_stories ?? 0 })); }
      }
      loaded = true;
      draw();
    } catch (e) {
      countEl.textContent = '새로운 이야기 건의함';
      scroll.replaceChildren(h('div', { class: 'empty' }, errorText(e)));
    }
  }

  function likeBtn(p) {
    if (!likesOn()) return null;
    const label = p.mine ? '내 건의에는 ♥를 누를 수 없어요' : p.liked ? '♥ 취소하기' : '♥ 누르기';
    return h('button', {
      type: 'button', class: 'like', 'aria-pressed': String(!!p.liked), disabled: p.mine, title: label,
      'aria-label': `${label}${p.likes != null ? ` · 지금 ${p.likes}개` : ''}`,
      onclick: async (e) => {
        const ident = app.identity();
        if (!ident) { app.requireLogin('♥를 누르려면 로그인해 주세요.', '/proposals'); return; }
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const r = await api.voteProposal(p.id, ident);
          p.liked = r.liked; if (p.likes != null) p.likes = r.likes;
          if (note?.kind === 'bad') note = null;                         // (an old error goes once something works)
          play(r.liked ? 'stamp' : 'select');
          draw();
        } catch (err) { btn.disabled = false; flash(errorText(err)); }
      },
    }, icon('heart', 14), p.likes != null ? h('span', {}, n(p.likes)) : null);
  }

  function adminBtns(p) {
    if (!app.admin) return null;
    return [
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { confirming = p.id; draw(); } }, '반려'),
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => adopt(p) }, '채택…'),
    ];
  }

  function card(p) {
    const who = app.identity();
    return h('article', { class: `prop-card${p.mine ? ' mine' : ''}${note?.id === p.id ? ' fresh' : ''}`, dataset: { id: p.id } },
      h('div', { class: 'prop-top' },
        h('b', {}, p.title || '제목 없는 이야기'),
        p.mine ? h('span', { class: 'chip pink' }, '내 건의') : null),
      h('p', { class: 'prop-first' }, p.text),
      h('div', { class: 'prop-meta' },
        h('span', {}, `${p.author_name} · ${relTime(p.created_at)}`),
        h('span', { style: 'flex:1' }),
        p.mine && who && on('proposal_withdraw') && !app.admin
          ? h('button', { type: 'button', class: 'btn-link', onclick: () => withdraw(p) }, '거둬들이기') : null,
        likeBtn(p), adminBtns(p)),
      confirming === p.id ? h('div', { class: 'notice warn prop-confirm', role: 'alert' },
        h('span', {}, `반려할까요? 건의함에서 내려가고, ${p.author_name} 님의 '내 건의'에는 반려로 보여요. (관리자 콘솔의 건의함에서 되돌릴 수 있어요)`),
        h('div', { class: 'btn-row', style: 'justify-content:flex-end' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { confirming = null; draw(); } }, '취소'),
          h('button', { type: 'button', class: 'btn btn-sm btn-primary danger', onclick: () => reject(p) }, '반려하기'))) : null);
  }

  function draw() {
    if (!loaded) return;
    const ident = app.identity();
    const order = sortNow();
    byLikes.setAttribute('aria-pressed', String(order === 'likes'));
    byNew.setAttribute('aria-pressed', String(order === 'new'));
    seg.hidden = !likesOn() || !items.some(p => p.likes != null);
    const list = [...items].sort(order === 'likes'
      ? (a, b) => (b.likes ?? 0) - (a.likes ?? 0) || Date.parse(b.created_at) - Date.parse(a.created_at)
      : (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    countEl.textContent = `기다리는 건의 ${n(items.length)}개${app.admin ? ' · 관리자로 보는 중' : ''}`;
    const intro = app.admin
      ? '채택하면 제목과 첫 줄을 고친 뒤 이야기 서랍에 올릴 수 있어요. 아무것도 하지 않으면 그대로 건의함에 남아요.'
      : likesOn() ? '로그인하면 마음에 드는 건의에 ♥를 누를 수 있어요. 관리자가 채택하면 이야기 서랍에 올라가요.'
      : '관리자가 채택하면 이야기 서랍에 올라가요.';
    scroll.replaceChildren(...[
      note ? h('div', { class: `notice ${note.kind}`, role: 'status', style: 'margin:12px 14px 0' }, note.text, note.href ? [' ', h('a', { href: note.href }, '서랍에서 보기 ▸')] : null) : null,
      closed && !app.admin ? h('div', { class: 'notice warn', style: 'margin:12px 14px 0' }, errorText({ code: closed })) : null,
      h('p', { class: 'muted prop-intro' }, intro),
      list.length
        ? h('div', { class: 'prop-list' }, list.map(card))
        : h('div', { class: 'empty' }, '아직 기다리는 건의가 없어요. 첫 건의를 남겨 보세요.'),
    ].filter(Boolean));
    if (app.admin) {
      footText.textContent = '건의 없이 바로 올리려면';
      footText.className = 'muted admin-foot-note';
      footBtn.textContent = '새 이야기 바로 시작';
      footBtn.className = 'btn';
    } else {
      const max = X('proposals_per_person');
      footText.textContent = ident ? `내 건의 ${myWaiting}/${max} 기다리는 중` : '건의하려면 로그인이 필요해요';
      footText.className = 'muted';
      footBtn.textContent = '새 이야기 건의하기';
      footBtn.className = 'btn btn-primary';
    }
    // (bring my new proposal into view once — later refreshes, e.g. someone's ♥, leave the scroll alone)
    if (note?.id && !note.scrolled) { note.scrolled = true; requestAnimationFrame(() => scroll.querySelector(`[data-id="${note.id}"]`)?.scrollIntoView({ block: 'nearest' })); }
  }

  function flash(text) {
    note = { kind: 'bad', text };
    draw();
  }

  async function withdraw(p) {
    const ok = await osDialog({ title: '거둬들이기', message: `「${p.title || '제목 없는 이야기'}」 건의를 거둬들일까요?\n건의함에서 내려가고, 그 자리에 다른 이야기를 건의할 수 있어요.`, ok: '거둬들이기', danger: true });
    if (!ok) return;
    try { await api.withdrawProposal(p.id, app.identity()); note = { kind: 'ok', text: '건의를 거둬들였어요.' }; refresh(); }
    catch (e) { flash(errorText(e)); }
  }

  async function reject(p) {
    try {
      await api.admin.rejectProposal(p.id);
      confirming = null;
      note = { kind: 'ok', text: `「${p.title || '제목 없는 이야기'}」 건의를 반려했어요.` };
      refresh();
    } catch (e) { confirming = null; flash(errorText(e)); }
  }

  function adopt(p) {
    adoptDialog(app, p, (r) => {
      note = { kind: 'ok', text: `「${r.title || '제목 없는 이야기'}」${iga(r.title || '이야기') === '이' ? '을' : '를'} 채택했어요.${r.over_limit ? ` (${p.author_name} 님의 이야기가 한 사람 최대 수를 넘었어요)` : ''}`, href: `#/story/${r.story_id}` };
      play('chime');
      refresh();
    });
  }

  return {
    type: 'proposals', route: '/proposals', title: '새로운 이야기 건의함', body,
    size: { w: 540, h: 600 }, minSize: { w: 360, h: 320 }, origin: { x: 580, y: 40 },
    mount() {
      if (app.justProposed) { note = { kind: 'ok', text: '건의했어요. 관리자가 채택하면 이야기 서랍에 올라가요.', id: app.justProposed }; app.justProposed = null; }
      refresh();
      unwatch = api.watch(['proposals'], refresh);
    },
    onFocus() {
      if (app.justProposed) { note = { kind: 'ok', text: '건의했어요. 관리자가 채택하면 이야기 서랍에 올라가요.', id: app.justProposed }; app.justProposed = null; }
      if (wasAdmin !== app.admin) { wasAdmin = app.admin; confirming = null; }
      refresh();
    },
    onSettings() { if (!on('proposals')) app.close('proposals'); else refresh(); },
    unmount() { unwatch?.(); },
  };
}

// 채택하기: edit the title and first line, then publish (admins only)
export function adoptDialog(app, p, done) {
  const st = app.settings ?? {};
  const maxChars = st.max_chars ?? 100, maxTitle = st.max_title_chars ?? 40;
  const prevFocus = document.activeElement;
  const title = h('input', { type: 'text', class: 'field', id: 'ad-title', value: p.title ?? '', maxlength: maxTitle, autocomplete: 'off' });
  const text = h('textarea', { class: 'field', id: 'ad-text', rows: 3, value: p.text });
  const counter = h('span', { class: 'counter' });
  const changes = h('p', { class: 'muted', style: 'margin:0' });
  const msg = h('div', { role: 'alert' });
  const go = h('button', { type: 'button', class: 'btn btn-primary' }, '채택하고 서랍에 올리기');
  const cancel = h('button', { type: 'button', class: 'btn', onclick: () => close() }, '취소');
  const over = (p.author_stories ?? 0) >= (st.stories_started_per_person ?? Infinity);

  function update() {
    const c = api.countChars(text.value);
    counter.textContent = `${c} / ${maxChars}`;
    counter.classList.toggle('over', c > maxChars);
    const edits = [];
    if (api.cleanLine(title.value) !== (p.title ?? '')) edits.push('제목');
    if (api.cleanLine(text.value) !== p.text) edits.push('첫 줄');
    changes.textContent = edits.length ? `고친 곳: ${edits.join(' · ')} — ${p.author_name} 님의 '내 건의'에는 채택으로 보여요.` : '';
  }
  text.addEventListener('input', update);
  title.addEventListener('input', update);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });

  const titleId = `adopt-${p.id}`;
  const box = h('div', { class: 'win is-active dialog adopt', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'win-title' }, h('span', { class: 'win-title-pad' }), h('h2', { id: titleId }, '채택하기'), h('span', { class: 'win-title-pad' })),
    h('div', { class: 'dialog-body' },
      h('p', { class: 'muted' }, `${p.author_name} 님의 건의${p.likes != null ? ` · ♥ ${n(p.likes)}` : ''} · ${relTime(p.created_at)}`),
      h('div', { class: 'label' }, h('label', { for: 'ad-title' }, X('title_required') !== false ? '제목' : '제목 (선택)'), title),
      h('div', { class: 'label' }, h('span', { class: 'label-row' }, h('label', { for: 'ad-text' }, '첫 줄'), counter), text),
      h('details', { class: 'orig' }, h('summary', {}, '원래 건의 보기'),
        h('p', {}, h('b', {}, p.title || '(제목 없음)')), h('p', { class: 'text' }, p.text)),
      changes,
      over ? h('div', { class: 'notice warn' }, `${p.author_name} 님의 이야기가 이미 ${p.author_stories}편이에요 (한 사람 최대 ${st.stories_started_per_person}편). 그래도 채택할 수 있어요.`) : null,
      h('p', { class: 'muted' }, `이야기 서랍에 새 이야기로 올라가고, 첫 줄은 ${p.author_name} 님 이름으로 남아요.`),
      msg,
      h('div', { class: 'actions', style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap' }, cancel, go)));
  const modal = h('div', { class: 'modal' }, box);
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() { modal.remove(); document.removeEventListener('keydown', onKey, true); prevFocus?.focus?.(); }
  go.addEventListener('click', async () => {
    const c = api.countChars(text.value);
    if (!c) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'empty_text' }))); text.focus(); return; }
    if (c > maxChars) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'too_long', detail: { max: maxChars } }))); return; }
    go.disabled = true; msg.replaceChildren();
    try {
      const r = await api.admin.adoptProposal(p.id, title.value, text.value);
      close();
      done?.({ ...r, title: api.cleanLine(title.value) });
    } catch (e) {
      go.disabled = false;
      msg.replaceChildren(h('div', { class: 'notice bad' }, errorText(e)));
    }
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(modal);
  update();
  setTimeout(() => title.focus());
  return close;
}
