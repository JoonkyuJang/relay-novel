// One story: its lines, the writer reveal, and the baton/composer state machine.
import * as api from '../api.js';
import { h, icon, fmtTime, fmtCountdown, errorText, attachReveal } from '../ui.js';

const pad2 = (n) => String(n).padStart(2, '0');
const STATUS_CHIP = {
  open: () => h('span', { class: 'chip sky' }, '진행 중'),
  completed: () => h('span', { class: 'chip grass' }, '완결'),
  mine: () => h('span', { class: 'chip pink' }, '내가 쓰는 중'),
  others: () => h('span', { class: 'chip pink' }, '누군가 쓰는 중'),
};

export function storyView(app, storyId) {
  const route = `/story/${storyId}`;
  let story = null;
  let baton = null;            // my claim while writing
  let mode = 'idle';           // idle | writing | conflict | done
  let lastResult = null;
  let message = '';
  let clockOffset = 0;
  let known = null;            // line ids already shown (to mark new ones)
  let revealedId = null;       // line whose 속성 window is open
  let unwatch = null, ticker = null;
  const serverNow = () => Date.now() + clockOffset;

  const bar = h('div', { class: 'win-bar' });
  const list = h('ol', { class: 'lines' });
  const scroll = h('div', { class: 'win-scroll' }, list);
  const foot = h('div', { class: 'win-foot' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const body = document.createDocumentFragment();
  body.append(bar, scroll, foot, live);

  const view = {
    type: 'story', route, title: '불러오는 중…', body,
    size: { w: 680, h: 600 }, origin: { x: 380, y: 50 },
    mount() {
      refresh();
      unwatch = api.watch([storyId], refresh);
      ticker = setInterval(tick, 1000);
      addEventListener('pagehide', onPageHide);
    },
    onFocus() { if (story && mode === 'idle') renderFoot(); },
    unmount() {
      unwatch?.(); clearInterval(ticker);
      removeEventListener('pagehide', onPageHide);
      if (baton) api.releaseBaton(storyId, baton.token).catch(() => {});
    },
  };

  function onPageHide() { if (baton) api.releaseBatonOnUnload(storyId, baton.token); }

  // ---------------------------------------------------------- rendering

  function renderBar() {
    const left = story.max_lines - story.line_count;
    const chip = story.status === 'completed' ? STATUS_CHIP.completed()
      : mode === 'writing' ? STATUS_CHIP.mine()
      : story.writing ? STATUS_CHIP.others() : STATUS_CHIP.open();
    bar.replaceChildren(...[
      chip,
      h('span', {}, `${story.line_count} / ${story.max_lines}줄`),
      story.status === 'open' ? h('span', { class: 'muted' }, `${left}줄 남음 · 한 줄 최대 ${story.max_chars}자`) : null,
      h('span', { style: 'flex:1' }),
      h('span', { class: 'faint' }, `RN-${storyId.slice(0, 4).toUpperCase()}`)].filter(Boolean));
  }

  function lineItem(l, isNew) {
    if (l.removed) {
      return h('li', { class: 'line removed' },
        h('span', { class: 'line-no' }, pad2(l.position)),
        h('span', { class: 'line-text' }, '(관리자가 숨긴 줄)'), h('span'));
    }
    const li = h('li', { class: `line${isNew ? ' is-new' : ''}${revealedId === l.id ? ' is-revealed' : ''}` });
    const who = h('button', {
      type: 'button', class: 'who', 'aria-label': `${l.position}번 줄 쓴 사람 보기`, 'aria-expanded': 'false',
    }, icon('person', 16));
    attachReveal(who, () => ({
      title: `${pad2(l.position)}번 줄 속성`,
      rows: [['작성자', l.author_name], ['학번', l.student_id], ['쓴 시각', fmtTime(l.created_at)]],
      onOpen: () => { revealedId = l.id; li.classList.add('is-revealed'); },
      onClose: () => { revealedId = null; list.querySelector('.is-revealed')?.classList.remove('is-revealed'); },
    }));
    li.append(
      h('span', { class: 'line-no' }, pad2(l.position)),
      h('span', { class: 'line-text' }, l.text, l.edited ? h('span', { class: 'edited' }, ' (수정됨)') : null),
      who);
    return li;
  }

  function renderLines() {
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    const first = known === null;
    const ids = new Set(story.lines.map(l => l.id));
    const items = story.lines.map(l => lineItem(l, !first && !known.has(l.id)));
    if (story.status === 'open' && story.writing && mode !== 'writing') {
      items.push(h('li', { class: 'line pending' },
        h('span', { class: 'line-no' }, pad2(story.line_count + 1)),
        h('span', { class: 'line-text' }, '▒▒▒▒▒▒▒▒▒▒ (누군가 쓰는 중)'), h('span')));
    }
    if (!first) {
      const added = story.lines.filter(l => !known.has(l.id));
      if (added.length) live.textContent = `새 줄: ${added.map(l => l.text).join(' ')}`;
    }
    known = ids;
    list.replaceChildren(...items);
    if (first || nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  function doneFoot() {
    const finishedByMe = lastResult?.result === 'accepted' && lastResult.story_status === 'completed';
    const d = story.completed_at ? new Date(story.completed_at) : new Date();
    return h('div', { class: 'done-row' },
      h('span', { class: 'stamp', 'aria-hidden': 'true' },
        h('b', {}, '완결'), h('small', {}, `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`)),
      h('p', { style: 'margin:0' }, finishedByMe
        ? '마지막 줄을 썼어요. 이야기가 완결되었습니다!'
        : `${story.line_count}줄로 완결된 이야기예요. 함께 써 주셔서 고마워요.`));
  }

  function conflictFoot() {
    return h('div', { class: 'notice warn', role: 'alert', style: 'display:flex;gap:12px' },
      icon('disk', 28),
      h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:6px' },
        h('b', {}, '저장 충돌'),
        h('span', {}, lastResult.reason === 'baton_taken'
          ? '예약 시간이 지나 다른 사람이 이 자리를 쓰는 중이었어요.'
          : '같은 자리에 다른 줄이 먼저 올라왔어요.'),
        h('span', {}, '쓰신 줄은 관리자 확인함에 보관했어요:'),
        h('span', { class: 'text' }, lastResult.text),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => { api.setDraft(storyId, ''); mode = 'idle'; lastResult = null; renderAll(); } }, '그만두기'),
          story.status === 'open'
            ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { mode = 'idle'; claim(); } }, '새 줄에 다시 쓰기')
            : null)));
  }

  function idleFoot() {
    const ident = app.identity();
    const status = h('div', { class: 'status-line' });
    if (story.writing) {
      status.append(icon('hourglass', 18), h('span', {}, `${story.line_count + 1}번째 줄 — 다른 사람이 쓰는 중이에요 · `),
        h('span', { 'data-countdown': 'story' }, ''), h('span', {}, ' 남음'));
    } else if (lastResult?.result === 'accepted') {
      status.append(h('span', {}, '줄이 올라갔어요. 고마워요!'));
    } else {
      status.append(h('span', { class: 'muted' }, `${story.line_count + 1}번째 줄을 이어 쓸 차례예요.`));
    }
    return [
      status,
      message ? h('div', { class: 'notice bad', role: 'alert' }, message) : null,
      h('div', { class: 'actions', style: 'align-items:center' },
        ident
          ? [h('span', { class: 'muted', style: 'margin-right:auto' }, `${ident.name} 님으로 써요`),
             h('button', { type: 'button', class: 'btn btn-primary', onclick: claim }, '이어 쓰기')]
          : h('button', { type: 'button', class: 'btn btn-primary', onclick: () => app.requireLogin('글을 쓰려면 로그인해 주세요.', route) }, '로그인하고 이어 쓰기')),
    ];
  }

  function writingFoot() {
    const ta = h('textarea', { class: 'field', rows: 2, id: `ta-${storyId}`, value: api.getDraft(storyId), maxlength: baton.max_chars * 2 });
    const counter = h('span', { class: 'counter' });
    const submitBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: submit }, '올리기');
    const update = () => {
      const n = api.countChars(ta.value);
      counter.textContent = `${n} / ${baton.max_chars}`;
      counter.classList.toggle('over', n > baton.max_chars);
      api.setDraft(storyId, ta.value);
    };
    ta.addEventListener('input', update);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
      else if (e.key === 'Enter') e.preventDefault();      // one line only
    });
    update();
    setTimeout(() => ta.focus({ preventScroll: true }));
    return [
      baton.is_final ? h('div', { class: 'notice warn', style: 'display:flex;gap:10px;align-items:center' }, icon('warn', 20),
        h('span', {}, `이 줄이 이야기의 마지막 줄이에요. ${story.max_lines}줄의 끝을 맺어 주세요.`)) : null,
      h('div', { class: 'status-line' }, icon('hourglass', 18), h('b', {}, `${baton.position}번째 줄`),
        h('span', { style: 'flex:1' }), h('span', {}, '남은 시간 '), h('b', { 'data-countdown': 'mine' }, '')),
      h('div', { 'data-warnings': '' }),
      h('label', { class: 'label', for: ta.id }, h('span', { class: 'label-row' }, h('span', {}, '내 줄'), counter)),
      ta,
      message ? h('div', { class: 'notice bad', role: 'alert' }, message) : null,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: cancel }, '취소'), submitBtn),
    ];
  }

  function renderFoot() {
    if (story.status === 'completed' && mode !== 'conflict') mode = 'done';
    const parts = mode === 'done' ? doneFoot()
      : mode === 'conflict' ? conflictFoot()
      : mode === 'writing' ? writingFoot() : idleFoot();
    foot.replaceChildren(...[parts].flat().filter(Boolean));
    tick();
  }

  function renderAll() { renderBar(); renderLines(); renderFoot(); }

  function tick() {
    if (!story) return;
    const mine = foot.querySelector('[data-countdown="mine"]');
    if (mine && baton) {
      const left = Date.parse(baton.expires_at) - serverNow();
      mine.textContent = left > 0 ? fmtCountdown(left) : '만료됨';
      const warn = foot.querySelector('[data-warnings]');
      const notes = [];
      if (left <= 0) notes.push('예약 시간이 지났어요. 그래도 올릴 수 있지만, 그 사이 다른 사람이 먼저 쓰면 충돌로 처리돼요.');
      if (story.head_line_id !== baton.parent_id) notes.push('그 사이 이야기가 바뀌었어요. 올리면 충돌로 처리되어 관리자에게 전달돼요.');
      if (warn && warn.dataset.sig !== notes.join('|')) {
        warn.dataset.sig = notes.join('|');
        warn.replaceChildren(...notes.map(n => h('div', { class: 'notice warn' }, n)));
      }
    }
    const theirs = foot.querySelector('[data-countdown="story"]');
    if (theirs && story.baton_expires_at) {
      const left = Date.parse(story.baton_expires_at) - serverNow();
      theirs.textContent = fmtCountdown(left);
      if (left <= 0 && story.writing) { story.writing = false; renderAll(); }
    }
  }

  // ---------------------------------------------------------- data + actions

  async function refresh() {
    try {
      const s = await api.getStory(storyId);
      const prevMode = mode, prevWriting = story?.writing, prevStatus = story?.status;
      story = s;
      clockOffset = Date.parse(s.server_now) - Date.now();
      view.setTitle?.(s.title || '제목 없는 이야기');
      renderBar();
      renderLines();
      if (mode !== 'writing' && (prevMode !== mode || prevWriting !== s.writing || prevStatus !== s.status || !foot.hasChildNodes())) renderFoot();
      else tick();
    } catch (e) {
      if (e.code === 'story_not_found') {
        view.setTitle?.('찾을 수 없음');
        bar.replaceChildren(); foot.replaceChildren();
        list.replaceChildren(h('li', { class: 'empty' }, '이야기를 찾을 수 없어요. 삭제되었거나 주소가 잘못되었어요.'));
      } else if (!story) {
        list.replaceChildren(h('li', { class: 'empty' }, errorText(e)));
      }
    }
  }

  async function claim() {
    const ident = app.identity();
    if (!ident) { app.requireLogin('글을 쓰려면 로그인해 주세요.', route); return; }
    message = '';
    try {
      baton = await api.claimBaton(storyId, ident);
      clockOffset = Date.parse(baton.server_now) - Date.now();
      mode = 'writing';
      lastResult = null;
      renderBar(); renderFoot();
      refresh();
    } catch (e) {
      message = errorText(e);
      if (e.code === 'story_closed') mode = 'done';
      renderFoot();
      if (e.code === 'baton_held' || e.code === 'story_closed') refresh();
    }
  }

  let submitting = false;
  async function submit() {
    if (submitting || !baton) return;
    const ta = foot.querySelector('textarea');
    const text = ta.value;
    const n = api.countChars(text);
    if (!n) { message = errorText({ code: 'empty_text' }); renderFoot(); return; }
    if (n > baton.max_chars) { message = errorText({ code: 'too_long', detail: { max: baton.max_chars } }); renderFoot(); return; }
    submitting = true;
    foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const r = await api.submitLine(storyId, {
        parentId: baton.parent_id, text, token: baton.token, ...app.identity() });
      lastResult = { ...r, text: api.cleanLine(text) };
      baton = null; message = '';
      if (r.result === 'accepted') {
        api.setDraft(storyId, '');
        mode = r.story_status === 'completed' ? 'done' : 'idle';
      } else {
        mode = 'conflict';
      }
      await refresh();
      renderFoot();
    } catch (e) {
      message = errorText(e);
      if (e.code === 'story_closed') { baton = null; mode = 'done'; await refresh(); }
      renderFoot();
    } finally {
      submitting = false;
    }
  }

  async function cancel() {
    const b = baton;
    baton = null; mode = 'idle'; lastResult = null; message = '';
    renderAll();
    if (b) { try { await api.releaseBaton(storyId, b.token); } catch { /* expires anyway */ } }
    refresh();
  }

  return view;
}
