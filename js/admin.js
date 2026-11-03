import * as api from './api.js';
import { h, $, fmtTime, errorText } from './ui.js';

const A = api.admin;
let tab = 'conflicts';
let detailId = null;
const watchKeys = ['admin', 'list', 'settings'];

const notice = (text, cls = 'bad') =>
  $('#notice').replaceChildren(...(text ? [h('div', { class: `box ${cls}` }, text)] : []));

// Run an admin action, show errors, re-render.
async function act(fn, okText) {
  try { await fn(); notice(okText ?? null, 'ok'); }
  catch (e) { notice(errorText(e)); }
  await render();
}

const short = (s, n = 8) => (s ? String(s).slice(0, n) : '');
const person = (name, sid) => `${name ?? ''} (${sid ?? ''})`;

// ------------------------------------------------------------ conflicts

async function viewConflicts() {
  const list = await A.listConflicts();
  if (!list.length) return h('p', { class: 'muted' }, 'No open conflicts.');
  return h('div', {}, list.map(c => {
    const same = c.official_student_id && c.official_student_id === c.student_id;
    return h('div', { class: 'box' },
      h('div', {}, h('b', {}, c.story_title || '(untitled)'), ` · position ${c.position} · `,
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); openStory(c.story_id); } }, 'open story')),
      c.parent_text ? h('div', { class: 'muted' }, `previous line: ${c.parent_text}`) : null,
      h('div', {}, '📗 official: ', c.official_text ?? h('i', {}, '(none — slot is free)'),
        c.official_id ? h('span', { class: 'muted' }, ` — ${person(c.official_author, c.official_student_id)} ${fmtTime(c.official_created_at)}`) : null),
      h('div', {}, '📙 conflict: ', c.text,
        h('span', { class: 'muted' }, ` — ${person(c.author_name, c.student_id)} ${fmtTime(c.created_at)} · device ${short(c.client_token)}`)),
      same ? h('div', { class: 'box warn' }, 'Same student ID as the official line.') : null,
      c.official_has_continuation ? h('div', { class: 'muted' }, 'The official line already has a continuation.') : null,
      h('div', { class: 'row' },
        h('button', { onclick: () => act(() => A.setConflictStatus(c.id, 'dismissed'), 'Dismissed.') }, 'Dismiss'),
        c.official_id && c.parent_on_path
          ? h('button', { onclick: () => confirm('Swap this line in and keep the lines that follow?') &&
              act(() => A.replaceLine(c.id), 'Swapped in (following lines kept).') }, 'Swap in, keep following')
          : null,
        h('button', { onclick: () => confirm(`Swap this line in and ARCHIVE every official line after position ${c.position}? The story reopens from here. (Undo: set the old last line as head again.)`) &&
            act(() => A.setHead(c.id), 'Swapped in, later lines archived.') },
          c.official_id ? 'Swap in + cut after' : 'Make official (set as head)')));
  }));
}

// ------------------------------------------------------------ stories

async function viewStories() {
  const list = await A.listStories();
  return h('table', {},
    h('tr', {}, ['Title / first line', 'Status', 'Lines', 'Overrides', 'Conflicts', 'Writing', 'Updated'].map(t => h('th', {}, t))),
    list.map(s => h('tr', { class: s.deleted_at ? 'deleted' : '' },
      h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openStory(s.id); } },
        s.title || s.first_line || '(empty)'), s.deleted_at ? ' [deleted]' : ''),
      h('td', {}, s.status),
      h('td', {}, `${s.line_count} / ${s.max_lines}`),
      h('td', {}, [s.max_lines_override && `lines ${s.max_lines_override}`, s.max_chars_override && `chars ${s.max_chars_override}`].filter(Boolean).join(', ')),
      h('td', {}, s.open_conflicts || ''),
      h('td', {}, s.baton_name ? `${s.baton_name} until ${fmtTime(s.baton_expires_at)}` : ''),
      h('td', {}, fmtTime(s.updated_at)))));
}

function openStory(id) {
  detailId = id;
  watchKeys.splice(3, watchKeys.length, id);
  tab = 'stories';
  render();
}

// Preview of admin_set_head on the client: which lines leave / join the official path.
function previewSetHead(story, target) {
  const byId = new Map(story.lines.map(l => [l.id, l]));
  const path = new Set();
  for (let l = target; l; l = byId.get(l.parent_id)) path.add(l.id);
  const archived = story.lines.filter(l => l.kind === 'canonical' && !path.has(l.id)).length;
  const promoted = story.lines.filter(l => path.has(l.id) && l.kind !== 'canonical').length;
  return { archived, promoted };
}

async function viewStoryDetail() {
  const s = await A.getStory(detailId);
  const lines = [...s.lines].sort((a, b) => a.position - b.position ||
    (a.kind === 'canonical' ? -1 : b.kind === 'canonical' ? 1 : 0) || a.created_at.localeCompare(b.created_at));
  const byId = new Map(s.lines.map(l => [l.id, l]));

  const setLimits = () => {
    const ml = prompt(`Max lines for this story (blank = site default). Current override: ${s.max_lines_override ?? 'none'}`, s.max_lines_override ?? '');
    if (ml === null) return;
    const mc = prompt(`Max chars per line for this story (blank = site default). Current override: ${s.max_chars_override ?? 'none'}`, s.max_chars_override ?? '');
    if (mc === null) return;
    act(() => A.updateStory(s.id, { max_lines: ml.trim() ? Number(ml) : null, max_chars: mc.trim() ? Number(mc) : null }), 'Limits updated.');
  };

  const lineActions = (l) => {
    const parentCanonical = !l.parent_id || byId.get(l.parent_id)?.kind === 'canonical';
    const btns = [
      h('button', { onclick: () => { const t = prompt('Edit line text:', l.text); if (t !== null) act(() => A.editLine(l.id, t), 'Line edited.'); } }, 'Edit'),
      h('button', { onclick: () => act(() => A.setLineDeleted(l.id, !l.deleted_at)) }, l.deleted_at ? 'Unhide' : 'Hide'),
    ];
    if (l.kind === 'canonical' && l.id !== s.head_line_id) {
      const p = previewSetHead(s, l);
      btns.push(h('button', { onclick: () => confirm(`Rewind to line ${l.position}? ${p.archived} later line(s) will be archived (not deleted) and the story reopens.`) &&
        act(() => A.setHead(l.id), 'Rewound.') }, 'Rewind to here'));
    }
    if (l.kind !== 'canonical') {
      if (parentCanonical && lines.some(x => x.kind === 'canonical' && x.position === l.position)) {
        btns.push(h('button', { onclick: () => confirm('Swap this line in at its position and keep the lines that follow?') &&
          act(() => A.replaceLine(l.id), 'Swapped in.') }, 'Swap in, keep following'));
      }
      const p = previewSetHead(s, l);
      btns.push(h('button', { onclick: () => confirm(`Make this the last official line? ${p.archived} line(s) archived, ${p.promoted} line(s) restored to the official path.`) &&
        act(() => A.setHead(l.id), 'Head moved.') }, 'Set as head (cut after)'));
      if (l.kind === 'conflict') {
        btns.push(h('button', { onclick: () => act(() => A.setConflictStatus(l.id, l.conflict_status === 'open' ? 'dismissed' : 'open')) },
          l.conflict_status === 'open' ? 'Dismiss' : 'Re-open'));
      }
    }
    return h('div', { class: 'row' }, btns);
  };

  return h('div', {},
    h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); detailId = null; render(); } }, '← all stories'),
      ' · ', h('a', { href: `story.html?id=${s.id}`, target: '_blank' }, 'public page')),
    h('h2', {}, s.title || '(untitled)', s.deleted_at ? ' [deleted]' : ''),
    h('p', {}, `${s.status} · ${s.line_count} / ${s.max_lines} lines · max ${s.max_chars} chars`,
      s.baton ? ` · ✍️ ${person(s.baton.name, s.baton.student_id)} until ${fmtTime(s.baton.expires_at)}` : ''),
    h('div', { class: 'row' },
      h('button', { onclick: () => { const t = prompt('Title:', s.title ?? ''); if (t !== null) act(() => A.updateStory(s.id, { title: t })); } }, 'Rename'),
      h('button', { onclick: setLimits }, 'Set limits'),
      s.status === 'open'
        ? h('button', { onclick: () => act(() => A.updateStory(s.id, { status: 'completed' }), 'Closed.') }, 'Close now')
        : h('button', { onclick: () => act(() => A.updateStory(s.id, { status: 'open' }), 'Reopened.') }, 'Reopen'),
      s.baton ? h('button', { onclick: () => act(() => A.releaseBaton(s.id), 'Baton released.') }, 'Release baton') : null,
      h('button', { onclick: () => (s.deleted_at || confirm('Delete (hide) this whole story?')) &&
        act(() => A.setStoryDeleted(s.id, !s.deleted_at)) }, s.deleted_at ? 'Restore story' : 'Delete story')),
    h('table', {},
      h('tr', {}, ['#', 'Kind', 'Text', 'Author', 'Device', 'Time', ''].map(t => h('th', {}, t))),
      lines.map(l => h('tr', { class: `kind-${l.kind} ${l.deleted_at ? 'deleted' : ''}` },
        h('td', {}, l.position, l.id === s.head_line_id ? ' ◀' : ''),
        h('td', {}, l.kind, l.conflict_status ? ` (${l.conflict_status})` : '', l.deleted_at ? ' [hidden]' : ''),
        h('td', {}, l.text, l.original_text ? h('div', { class: 'muted' }, `original: ${l.original_text}`) : null),
        h('td', {}, person(l.author_name, l.student_id)),
        h('td', { class: 'muted' }, short(l.client_token)),
        h('td', { class: 'muted' }, fmtTime(l.created_at)),
        h('td', {}, lineActions(l))))));
}

// ------------------------------------------------------------ settings

const SETTINGS = [
  ['max_lines', 'Lines per story (N)', 'number'],
  ['max_chars', 'Characters per line (C)', 'number'],
  ['max_title_chars', 'Characters per title', 'number'],
  ['lines_per_person_per_story', 'Lines per person per story', 'number'],
  ['stories_started_per_person', 'Stories a person can start', 'number'],
  ['baton_seconds', 'Baton reservation (seconds)', 'number'],
  ['submissions_open', 'Accepting submissions', 'checkbox'],
  ['allow_new_stories', 'Allow new stories', 'checkbox'],
  ['show_student_id', 'Show student IDs in writer reveal', 'checkbox'],
  ['stats_public', 'Contributor stats public', 'checkbox'],
  ['likes_enabled', 'Likes enabled (stage 2)', 'checkbox'],
];

async function viewSettings() {
  const st = await A.getSettings();
  const form = h('form', { class: 'box' },
    SETTINGS.map(([k, label, type]) => h('label', {},
      type === 'checkbox'
        ? [h('input', { type, name: k, checked: st[k] }), ' ', label]
        : [label, h('input', { type, name: k, value: st[k], min: 0 })])),
    h('p', { class: 'muted' }, 'Lowering N completes any open story that is already at or over the new limit. Raising N does not reopen completed stories (reopen them one by one).'),
    h('button', { type: 'submit' }, 'Save'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = {};
    for (const [k, , type] of SETTINGS) {
      const v = type === 'checkbox' ? form[k].checked : Number(form[k].value);
      if (v !== st[k]) patch[k] = v;
    }
    if (!Object.keys(patch).length) return notice('Nothing changed.', 'ok');
    act(() => A.updateSettings(patch), 'Settings saved.');
  });
  return h('div', {}, h('p', { class: 'muted' }, `Last updated ${fmtTime(st.updated_at)}`), form);
}

// ------------------------------------------------------------ stats & log

async function viewStats() {
  const rows = await A.stats();
  return h('table', {},
    h('tr', {}, ['Student ID', 'Names used', 'Lines', 'Stories', 'Started', 'Conflicts', 'Devices', 'First', 'Last'].map(t => h('th', {}, t))),
    rows.map(r => h('tr', {},
      h('td', {}, r.student_id),
      h('td', { class: r.names.length > 1 ? 'kind-conflict' : '' }, r.names.join(', ')),
      h('td', {}, r.lines), h('td', {}, r.stories), h('td', {}, r.started), h('td', {}, r.conflicts),
      h('td', {}, r.devices), h('td', {}, fmtTime(r.first_at)), h('td', {}, fmtTime(r.last_at)))));
}

async function viewLog() {
  const rows = await A.log(200);
  return h('table', {},
    h('tr', {}, ['Time', 'Action', 'Target', 'Details'].map(t => h('th', {}, t))),
    rows.map(r => h('tr', {},
      h('td', {}, fmtTime(r.created_at)), h('td', {}, r.action), h('td', { class: 'muted' }, short(r.target_id)),
      h('td', { class: 'muted' }, h('code', {}, r.details ? JSON.stringify(r.details).slice(0, 300) : '')))));
}

// ------------------------------------------------------------ shell

const VIEWS = { conflicts: viewConflicts, stories: viewStories, settings: viewSettings, stats: viewStats, log: viewLog };

async function render() {
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  try {
    const view = tab === 'stories' && detailId ? await viewStoryDetail() : await VIEWS[tab]();
    $('#view').replaceChildren(view);
  } catch (e) {
    $('#view').replaceChildren(h('div', { class: 'box bad' }, errorText(e)));
  }
}

async function start() {
  const user = await api.currentUser();
  if (!user) { $('#login').hidden = false; $('#app').hidden = true; return; }
  let ok = false;
  try { ok = await api.isAdmin(); } catch (e) { notice(errorText(e)); }
  if (!ok) {
    notice(`Logged in as ${user.email}, but this account is not an admin yet.`);
    $('#app').hidden = false; $('#view').replaceChildren(); return;
  }
  $('#login').hidden = true; $('#app').hidden = false;
  $('#who').textContent = `Logged in as ${user.email}`;
  render();
  api.watch(watchKeys, () => { if (tab !== 'settings') render(); });
}

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try { await api.signIn(f.email.value, f.password.value); $('#loginMsg').textContent = ''; start(); }
  catch (err) { $('#loginMsg').textContent = errorText(err); }
});
$('#logout').addEventListener('click', async () => { await api.signOut(); location.reload(); });
$('#export').addEventListener('click', async () => {
  try {
    const data = await A.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `relay-novel-export-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json` });
    document.body.append(a); a.click(); a.remove();
  } catch (err) { notice(errorText(err)); }
});
document.querySelectorAll('nav.tabs button').forEach(b =>
  b.addEventListener('click', () => { tab = b.dataset.tab; detailId = null; notice(null); render(); }));

start();
