import * as api from './api.js';
import { h, $, fmtTime, fmtCountdown, errorText } from './ui.js';

const storyId = new URLSearchParams(location.search).get('id');
let story = null;
let clockOffset = 0;                 // serverNow - Date.now()
let baton = null;                    // my claim while writing
let mode = 'idle';                   // idle | writing | conflict | done
let lastResult = null;
const revealed = new Set();

const serverNow = () => Date.now() + clockOffset;

// ------------------------------------------------------------ lines

function lineItem(l) {
  if (l.removed) {
    return h('li', {}, h('span', { class: 'pos' }, l.position),
      h('span', { class: 'text muted' }, '(관리자가 숨긴 줄)'));
  }
  const who = l.student_id ? `${l.author_name} (${l.student_id})` : l.author_name;
  const open = revealed.has(l.id);
  const btn = h('button', {
    class: 'who', title: who, 'aria-label': '작성자 보기', 'aria-expanded': String(open),
    onclick: () => { open ? revealed.delete(l.id) : revealed.add(l.id); renderLines(); },
  }, '👤');
  return h('li', {},
    h('span', { class: 'pos' }, l.position),
    h('span', { class: 'text' }, l.text, l.edited ? h('span', { class: 'muted' }, ' (수정됨)') : null,
      open ? h('span', { class: 'reveal' }, `${who} · ${fmtTime(l.created_at)}`) : null),
    btn);
}

function renderLines() {
  $('#lines').replaceChildren(...story.lines.map(lineItem));
}

function renderStatus() {
  document.title = `${story.title || '릴레이 소설'} · 릴레이 소설`;
  $('#title').textContent = story.title || '제목 없는 이야기';
  const left = story.max_lines - story.line_count;
  let s = story.status === 'completed'
    ? `완결 · ${story.line_count}줄`
    : `${story.line_count} / ${story.max_lines}줄 · ${left}줄 남음 · 한 줄 최대 ${story.max_chars}자`;
  if (story.writing && mode !== 'writing') {
    s += ` · ✍️ 누군가 쓰는 중 (${fmtCountdown(Date.parse(story.baton_expires_at) - serverNow())})`;
  }
  $('#status').textContent = s;
}

// ------------------------------------------------------------ composer

function identityFields() {
  const id = api.getIdentity();
  return h('div', { class: 'row' },
    h('label', {}, '이름 ', h('input', { type: 'text', id: 'name', maxlength: 20, value: id.name })),
    h('label', {}, '학번 ', h('input', { type: 'text', id: 'sid', maxlength: 20, inputmode: 'numeric', value: id.studentId })));
}

function readIdentity() {
  const ident = { name: $('#name')?.value.trim() ?? '', studentId: $('#sid')?.value.trim() ?? '' };
  if (!ident.name || !ident.studentId) {
    const saved = api.getIdentity();
    if (saved.name && saved.studentId) return saved;
  }
  return ident;
}

async function claim() {
  const msg = $('#composerMsg');
  const ident = readIdentity();
  try {
    baton = await api.claimBaton(storyId, ident);
    baton.ident = ident;
    clockOffset = Date.parse(baton.server_now) - Date.now();
    api.setIdentity(ident);
    mode = 'writing';
    renderComposer();
    await refresh();
  } catch (e) {
    if (msg) msg.textContent = errorText(e);
  }
}

function renderComposer() {
  const c = $('#composer');
  if (story.status === 'completed' && mode !== 'conflict') mode = 'done';

  if (mode === 'done') {
    c.replaceChildren(h('div', { class: 'box ok' },
      lastResult?.result === 'accepted' && lastResult.story_status === 'completed'
        ? '마지막 줄을 썼어요. 이야기가 완결되었습니다! 🎉' : '완결된 이야기입니다.'));
    return;
  }

  if (mode === 'conflict') {
    c.replaceChildren(h('div', { class: 'box warn' },
      h('p', {}, lastResult.reason === 'baton_taken'
        ? '예약 시간이 지나 다른 사람이 이어 쓰는 중이었어요.'
        : '다른 사람이 먼저 이 자리에 줄을 올렸어요.'),
      h('p', {}, '쓰신 줄은 저장되어 관리자에게 전달되었어요:'),
      h('blockquote', {}, lastResult.text),
      story.status === 'open'
        ? h('div', { class: 'row' },
            h('button', { onclick: () => { mode = 'idle'; renderComposer(); claim(); } }, '새 줄에 이어서 다시 쓰기'),
            h('button', { onclick: () => { api.setDraft(storyId, ''); mode = 'idle'; renderComposer(); } }, '그만두기'))
        : h('p', {}, '이야기가 이미 완결되었어요.'),
      h('div', { id: 'composerMsg', class: 'muted' })));
    return;
  }

  if (mode === 'idle') {
    c.replaceChildren(h('div', { class: 'box' },
      lastResult?.result === 'accepted' ? h('p', {}, '줄이 올라갔어요. 고마워요!') : null,
      identityFields(),
      h('div', { class: 'row' },
        h('button', { onclick: claim }, '이어 쓰기'),
        h('span', { id: 'composerMsg', class: 'muted' }))));
    return;
  }

  // mode === 'writing'
  const ta = h('textarea', { id: 'text', rows: 3, value: api.getDraft(storyId) });
  const counter = h('span', { class: 'counter muted' });
  const update = () => {
    const n = api.countChars(ta.value);
    counter.textContent = `${n} / ${baton.max_chars}`;
    counter.classList.toggle('over', n > baton.max_chars);
    api.setDraft(storyId, ta.value);
  };
  ta.addEventListener('input', update);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });

  c.replaceChildren(h('div', { class: 'box' },
    baton.is_final ? h('div', { class: 'box warn' }, '⚠️ 이 줄이 이야기의 마지막 줄이에요. 이야기를 마무리해 주세요.') : null,
    h('p', {}, `${baton.position}번째 줄을 쓰고 있어요 · 남은 예약 시간 `, h('b', { id: 'countdown' })),
    h('div', { id: 'composerWarn' }),
    h('label', {}, '내 줄 ', counter, ta),
    h('div', { class: 'row' },
      h('button', { id: 'submitBtn', onclick: submit }, '올리기'),
      h('button', { onclick: cancel }, '취소'),
      h('span', { id: 'composerMsg', class: 'muted' }))));
  update();
  ta.focus();
  tick();
}

async function submit() {
  const btn = $('#submitBtn'); const msg = $('#composerMsg');
  const text = $('#text').value;
  btn.disabled = true; msg.textContent = '';
  try {
    const r = await api.submitLine(storyId, {
      parentId: baton.parent_id, text, token: baton.token, ...baton.ident });
    lastResult = { ...r, text: api.cleanLine(text) };
    baton = null;
    if (r.result === 'accepted') {
      api.setDraft(storyId, '');
      mode = r.story_status === 'completed' ? 'done' : 'idle';
    } else {
      mode = 'conflict';
    }
    await refresh();
    renderComposer();
  } catch (e) {
    msg.textContent = errorText(e);
    btn.disabled = false;
    if (e.code === 'story_closed') { baton = null; mode = 'done'; await refresh(); renderComposer(); }
  }
}

async function cancel() {
  const b = baton; baton = null; mode = 'idle'; lastResult = null;
  renderComposer();
  if (b) { try { await api.releaseBaton(storyId, b.token); } catch { /* expires anyway */ } }
  refresh();
}

function tick() {
  if (mode === 'writing' && baton) {
    const left = Date.parse(baton.expires_at) - serverNow();
    const el = $('#countdown');
    if (el) el.textContent = left > 0 ? fmtCountdown(left) : '만료됨';
    const warn = $('#composerWarn');
    if (warn) {
      const notes = [];
      if (left <= 0) notes.push('예약 시간이 지났어요. 그래도 올릴 수 있지만, 그 사이 다른 사람이 먼저 쓰면 충돌로 처리돼요.');
      if (story && story.head_line_id !== baton.parent_id) notes.push('그 사이 이야기가 바뀌었어요. 올리면 충돌로 처리되어 관리자에게 전달돼요.');
      warn.replaceChildren(...notes.map(n => h('div', { class: 'box warn' }, n)));
    }
  }
  if (story) renderStatus();
}

// ------------------------------------------------------------ data

async function refresh() {
  try {
    story = await api.getStory(storyId);
    clockOffset = Date.parse(story.server_now) - Date.now();
    $('#notice').replaceChildren();
    renderStatus();
    renderLines();
    if (!$('#composer').hasChildNodes() || (story.status === 'completed' && mode === 'idle')) renderComposer();
    tick();
  } catch (e) {
    $('#notice').replaceChildren(h('div', { class: 'box bad' }, errorText(e)));
    if (e.code === 'story_not_found') { $('#title').textContent = ''; $('#composer').replaceChildren(); }
  }
}

if (!storyId) {
  $('#title').textContent = '이야기를 찾을 수 없어요.';
} else {
  refresh();
  api.watch([storyId], refresh);
  setInterval(tick, 1000);
  addEventListener('pagehide', () => { if (baton) api.releaseBatonOnUnload(storyId, baton.token); });
}
