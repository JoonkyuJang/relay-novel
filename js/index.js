import * as api from './api.js';
import { h, $, fmtTime, errorText } from './ui.js';

let settings = null;
const form = $('#create');

function storyItem(s) {
  const label = s.title || s.first_line || '(제목 없음)';
  return h('li', {},
    h('a', { href: `story.html?id=${s.id}` }, label), ' ',
    h('span', { class: 'muted' }, `${s.line_count} / ${s.max_lines}줄`),
    s.writing ? h('span', { class: 'muted' }, ' · ✍️ 누군가 쓰는 중') : null,
    s.last_line && s.line_count > 1 ? h('div', { class: 'muted' }, `… ${s.last_line}`) : null,
    h('div', { class: 'muted' }, s.status === 'completed' ? `완결 ${fmtTime(s.completed_at)}` : `최근 ${fmtTime(s.updated_at)}`),
  );
}

function renderList(stories) {
  const ongoing = stories.filter(s => s.status === 'open');
  const done = stories.filter(s => s.status === 'completed');
  $('#ongoing').replaceChildren(...(ongoing.length ? ongoing.map(storyItem) : [h('li', { class: 'muted' }, '아직 없어요.')]));
  $('#completed').replaceChildren(...(done.length ? done.map(storyItem) : [h('li', { class: 'muted' }, '아직 없어요.')]));
}

function updateCounter() {
  const n = api.countChars(form.text.value);
  const max = settings?.max_chars ?? '?';
  const c = $('#counter');
  c.textContent = `${n} / ${max}`;
  c.classList.toggle('over', settings && n > settings.max_chars);
}

async function refresh() {
  try {
    const [st, stories] = await Promise.all([api.getSettings(), api.listStories()]);
    settings = st;
    renderList(stories);
    updateCounter();
    const notes = [];
    if (!st.submissions_open) notes.push('지금은 글쓰기가 닫혀 있어요.');
    else if (!st.allow_new_stories) notes.push('지금은 새 이야기를 시작할 수 없어요.');
    $('#notice').replaceChildren(...notes.map(n => h('div', { class: 'box warn' }, n)));
    form.querySelector('button').disabled = !st.submissions_open || !st.allow_new_stories;
  } catch (e) {
    $('#notice').replaceChildren(h('div', { class: 'box bad' }, errorText(e)));
  }
}

const id = api.getIdentity();
form.name.value = id.name; form.sid.value = id.studentId;
form.text.addEventListener('input', updateCounter);
form.text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button');
  btn.disabled = true; $('#createMsg').textContent = '';
  const ident = { name: form.name.value.trim(), studentId: form.sid.value.trim() };
  try {
    const r = await api.createStory({ title: form.title.value, text: form.text.value, ...ident });
    api.setIdentity(ident);
    location.href = `story.html?id=${r.story_id}`;
  } catch (err) {
    $('#createMsg').textContent = errorText(err);
    btn.disabled = false;
  }
});

refresh();
api.watch(['list', 'settings'], refresh);
