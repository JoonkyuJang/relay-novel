// 관리자 콘솔 + 관리용 이야기 창. Only reachable after the hidden admin login.
import * as api from '../api.js';
import { h, fmtTime, relTime, errorText, osConfirm, osPrompt } from '../ui.js';

const A = api.admin;
const short = (s, n = 8) => (s ? String(s).slice(0, n) : '');
const person = (name, sid) => `${name ?? ''} (${sid ?? ''})`;
const pad2 = (n) => String(n).padStart(2, '0');
const KIND = { canonical: '정식', conflict: '충돌', archived: '보관', branch: '갈래' };
const btn = (label, onclick, extra = '') => h('button', { type: 'button', class: `btn btn-sm ${extra}`, onclick }, label);

function noticeBox(slot) {
  return (text, cls = 'bad') => slot.replaceChildren(...(text ? [h('div', { class: `notice ${cls}`, role: cls === 'bad' ? 'alert' : 'status' }, text)] : []));
}

// ============================================================ console

const SETTINGS = [
  ['max_lines', '이야기 길이 (N줄)', 'number'],
  ['max_chars', '한 줄 글자 수 (C)', 'number'],
  ['max_title_chars', '제목 글자 수', 'number'],
  ['lines_per_person_per_story', '한 사람이 한 이야기에 쓰는 줄', 'number'],
  ['stories_started_per_person', '한 사람이 시작하는 이야기', 'number'],
  ['baton_seconds', '이어 쓰기 예약 시간 (초)', 'number'],
  ['guestbook_max_chars', '방명록 글자 수', 'number'],
  ['guestbook_cooldown_seconds', '방명록 간격 (초)', 'number'],
  ['submissions_open', '글쓰기 열림', 'checkbox'],
  ['allow_new_stories', '새 이야기 허용', 'checkbox'],
  ['guestbook_open', '방명록 열림', 'checkbox'],
  ['show_student_id', '속성 창에 학번 표시', 'checkbox'],
  ['stats_public', '출석부 공개', 'checkbox'],
];

export function adminView(app) {
  let tab = 'conflicts';
  let unwatch = null;
  let conflictCount = 0;
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': '관리 메뉴' });
  const status = h('div');
  const notice = noticeBox(status);
  const pane = h('div', { class: 'admin-pane' });
  const scroll = h('div', { class: 'win-scroll' }, h('div', { style: 'padding:10px 14px 0' }, status), pane);
  const bar = h('div', { class: 'win-bar' }, tabs, h('span', { style: 'flex:1' }),
    btn('백업 (JSON)', backup), btn('관리자 나가기', () => app.adminLogout()));
  const body = document.createDocumentFragment();
  body.append(bar, scroll);

  const TABS = [
    ['conflicts', '충돌'], ['stories', '이야기'], ['settings', '설정'],
    ['guestbook', '방명록'], ['people', '참여자'], ['log', '기록'],
  ];
  function renderTabs() {
    tabs.replaceChildren(...TABS.map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': String(tab === k),
      onclick: () => { tab = k; notice(null); render(); },
    }, label, k === 'conflicts' && conflictCount ? h('span', { class: 'count' }, conflictCount) : null)));
  }

  async function act(fn, ok) {
    try { await fn(); notice(ok ?? null, 'ok'); }
    catch (e) { notice(errorText(e)); }
    await render();
  }

  // ---------------------------------------------------------- tabs

  async function viewConflicts() {
    const list = await A.listConflicts();
    conflictCount = list.length;
    if (!list.length) return h('p', { class: 'muted', style: 'margin:0' }, '확인할 충돌이 없어요.');
    return list.map(c => {
      const same = c.official_student_id && c.official_student_id === c.student_id;
      return h('div', { class: 'card' },
        h('div', { class: 'btn-row', style: 'align-items:center' },
          h('b', {}, c.story_title || '(제목 없음)'), h('span', { class: 'muted' }, `${pad2(c.position)}번째 자리`),
          h('span', { style: 'flex:1' }),
          btn('이야기 열기', () => app.go(`/admin/story/${c.story_id}`))),
        c.parent_text ? h('div', { class: 'muted' }, `앞 줄: ${c.parent_text}`) : null,
        h('div', {}, h('span', { class: 'chip sky' }, '정식'), ' ',
          c.official_text ? h('span', { class: 'text' }, c.official_text) : h('i', { class: 'muted' }, '(비어 있는 자리)'),
          c.official_id ? h('div', { class: 'muted' }, `${person(c.official_author, c.official_student_id)} · ${fmtTime(c.official_created_at)}`) : null),
        h('div', {}, h('span', { class: 'chip pink' }, '충돌'), ' ', h('span', { class: 'text' }, c.text),
          h('div', { class: 'muted' }, `${person(c.author_name, c.student_id)} · ${fmtTime(c.created_at)} · 기기 ${short(c.client_token)}`)),
        same ? h('div', { class: 'notice warn' }, '정식 줄과 같은 학번이에요.') : null,
        c.official_has_continuation ? h('div', { class: 'muted' }, '정식 줄 뒤에 이미 다음 줄이 있어요.') : null,
        h('div', { class: 'btn-row' },
          btn('무시', () => act(() => A.setConflictStatus(c.id, 'dismissed'), '무시했어요.')),
          c.official_id && c.parent_on_path
            ? btn('바꿔 넣기 (뒤 줄 유지)', async () => {
                if (await osConfirm('이 줄을 정식 줄 자리에 넣고, 뒤에 이어진 줄은 그대로 둘까요?', { title: '바꿔 넣기' }))
                  act(() => A.replaceLine(c.id), '바꿔 넣었어요.');
              })
            : null,
          btn(c.official_id ? '바꿔 넣고 뒤 자르기' : '정식 줄로 만들기', async () => {
            if (await osConfirm(`${pad2(c.position)}번째 뒤의 정식 줄을 모두 보관함으로 옮기고, 이 자리부터 이야기를 다시 열까요?\n(되돌리려면 예전 마지막 줄을 다시 끝으로 지정하면 돼요.)`, { title: '뒤 자르기', danger: true, ok: '자르기' }))
              act(() => A.setHead(c.id), '바꿔 넣고 뒤를 보관했어요.');
          })));
    });
  }

  async function viewStories() {
    const list = await A.listStories();
    if (!list.length) return h('p', { class: 'muted', style: 'margin:0' }, '아직 이야기가 없어요.');
    return h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['제목 / 첫 줄', '상태', '줄', '개별 한도', '충돌', '쓰는 중', '최근'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, list.map(s => h('tr', { class: s.deleted_at ? 'dim' : '' },
        h('td', {}, h('a', { class: 'rowlink', href: `#/admin/story/${s.id}` }, s.title || s.first_line || '(비어 있음)'), s.deleted_at ? ' [삭제됨]' : ''),
        h('td', {}, s.status === 'completed' ? h('span', { class: 'chip grass' }, '완결') : h('span', { class: 'chip sky' }, '진행 중')),
        h('td', {}, `${s.line_count} / ${s.max_lines}`),
        h('td', {}, [s.max_lines_override && `${s.max_lines_override}줄`, s.max_chars_override && `${s.max_chars_override}자`].filter(Boolean).join(' · ')),
        h('td', {}, s.open_conflicts ? h('span', { class: 'chip pink' }, s.open_conflicts) : ''),
        h('td', {}, s.baton_name ? `${s.baton_name} (~${fmtTime(s.baton_expires_at)})` : ''),
        h('td', { class: 'muted' }, relTime(s.updated_at))))));
  }

  async function viewSettings() {
    const st = await A.getSettings();
    const form = h('form', { novalidate: true, style: 'display:flex;flex-direction:column;gap:14px' },
      h('div', { class: 'settings-grid' }, SETTINGS.map(([k, label, type]) => type === 'checkbox'
        ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: k, checked: st[k] }), label)
        : h('label', {}, h('span', {}, label), h('input', { type: 'number', class: 'field sm', name: k, value: st[k], min: 0 })))),
      h('p', { class: 'muted', style: 'margin:0;line-height:18px' },
        'N을 줄이면 이미 그 길이에 도달한 진행 중 이야기는 바로 완결돼요. N을 늘려도 완결된 이야기가 다시 열리지는 않아요 (이야기 창에서 하나씩 다시 열 수 있어요).'),
      h('div', { class: 'btn-row', style: 'justify-content:space-between;align-items:center' },
        h('span', { class: 'muted' }, `마지막 저장 ${fmtTime(st.updated_at)}`),
        h('button', { type: 'submit', class: 'btn btn-primary' }, '저장')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const patch = {};
      for (const [k, , type] of SETTINGS) {
        const v = type === 'checkbox' ? form[k].checked : Number(form[k].value);
        if (v !== st[k]) patch[k] = v;
      }
      if (!Object.keys(patch).length) return notice('바뀐 게 없어요.', 'ok');
      act(() => A.updateSettings(patch), '설정을 저장했어요.');
    });
    return form;
  }

  async function viewGuestbook() {
    const rows = await A.listGuestbook();
    if (!rows.length) return h('p', { class: 'muted', style: 'margin:0' }, '아직 남긴 말이 없어요.');
    return h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['#', '내용', '작성자', '기기', '시각', ''].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map(g => h('tr', { class: g.deleted_at ? 'dim' : '' },
        h('td', {}, String(g.no).padStart(3, '0')),
        h('td', {}, g.text, g.deleted_at ? h('div', { class: 'muted' }, '[숨김]') : null),
        h('td', {}, person(g.author_name, g.student_id)),
        h('td', { class: 'muted' }, short(g.client_token)),
        h('td', { class: 'muted' }, fmtTime(g.created_at)),
        h('td', { class: 'acts' }, btn(g.deleted_at ? '다시 보이기' : '숨기기',
          () => act(() => A.setGuestbookDeleted(g.id, !g.deleted_at), g.deleted_at ? '다시 보이게 했어요.' : '숨겼어요.')))))));
  }

  async function viewPeople() {
    const rows = await A.stats();
    if (!rows.length) return h('p', { class: 'muted', style: 'margin:0' }, '아직 참여자가 없어요.');
    return h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['학번', '쓴 이름', '줄', '이야기', '시작', '충돌', '기기', '처음', '마지막'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map(r => h('tr', { class: r.names.length > 1 ? 'is-conflict' : '' },
        h('td', {}, r.student_id), h('td', {}, r.names.join(', ')),
        h('td', { class: 'num' }, r.lines), h('td', { class: 'num' }, r.stories), h('td', { class: 'num' }, r.started),
        h('td', { class: 'num' }, r.conflicts), h('td', { class: 'num' }, r.devices),
        h('td', { class: 'muted' }, fmtTime(r.first_at)), h('td', { class: 'muted' }, fmtTime(r.last_at))))));
  }

  async function viewLog() {
    const rows = await A.log(200);
    if (!rows.length) return h('p', { class: 'muted', style: 'margin:0' }, '기록이 없어요.');
    return h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['시각', '동작', '대상', '내용'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', { class: 'muted' }, fmtTime(r.created_at)), h('td', {}, r.action), h('td', { class: 'muted' }, short(r.target_id)),
        h('td', { class: 'muted' }, h('code', { style: 'word-break:break-all' }, r.details ? JSON.stringify(r.details).slice(0, 240) : ''))))));
  }

  const VIEWS = { conflicts: viewConflicts, stories: viewStories, settings: viewSettings, guestbook: viewGuestbook, people: viewPeople, log: viewLog };

  async function render() {
    try {
      if (tab !== 'conflicts') A.listConflicts().then(l => { conflictCount = l.length; renderTabs(); }).catch(() => {});
      const content = await VIEWS[tab]();
      renderTabs();
      pane.replaceChildren(...[content].flat().filter(Boolean));
    } catch (e) {
      renderTabs();
      pane.replaceChildren(h('div', { class: 'notice bad' }, errorText(e)));
      if (e.code === 'not_admin' || e.code === 'permission_denied') app.adminLost?.();
    }
  }

  async function backup() {
    try {
      const data = await A.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `relay-novel-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      notice('백업 파일을 내려받았어요.', 'ok');
    } catch (e) { notice(errorText(e)); }
  }

  return {
    type: 'admin', route: '/admin', title: '관리자 콘솔', body,
    size: { w: 920, h: 620 }, origin: { x: 60, y: 30 },
    mount() { render(); unwatch = api.watch(['admin', 'list', 'settings', 'guestbook'], () => { if (tab !== 'settings') render(); }); },
    unmount() { unwatch?.(); },
  };
}

// ============================================================ one story, every line

export function adminStoryView(app, storyId) {
  let unwatch = null;
  const status = h('div');
  const notice = noticeBox(status);
  const bar = h('div', { class: 'win-bar' });
  const actions = h('div', { class: 'btn-row', style: 'padding:10px 14px 0' });
  const table = h('div');
  const scroll = h('div', { class: 'win-scroll' }, actions, h('div', { style: 'padding:10px 14px 0' }, status), h('div', { style: 'padding:10px 0 16px' }, table));
  const body = document.createDocumentFragment();
  body.append(bar, scroll);
  const view = {
    type: 'admin-story', route: `/admin/story/${storyId}`, title: '관리 · 이야기', body,
    size: { w: 960, h: 600 }, origin: { x: 120, y: 60 },
    mount() { render(); unwatch = api.watch(['admin', storyId], render); },
    unmount() { unwatch?.(); },
  };

  async function act(fn, ok) {
    try { await fn(); notice(ok ?? null, 'ok'); }
    catch (e) { notice(errorText(e)); }
    await render();
  }

  // Which lines would leave / join the official path if `target` became the head.
  function previewSetHead(s, target) {
    const byId = new Map(s.lines.map(l => [l.id, l]));
    const path = new Set();
    for (let l = target; l; l = byId.get(l.parent_id)) path.add(l.id);
    return {
      archived: s.lines.filter(l => l.kind === 'canonical' && !path.has(l.id)).length,
      promoted: s.lines.filter(l => path.has(l.id) && l.kind !== 'canonical').length,
    };
  }

  async function render() {
    let s;
    try { s = await A.getStory(storyId); }
    catch (e) { notice(errorText(e)); return; }
    view.setTitle?.(`관리 · ${s.title || '제목 없는 이야기'}`);
    const byId = new Map(s.lines.map(l => [l.id, l]));
    const lines = [...s.lines].sort((a, b) => a.position - b.position ||
      (a.kind === 'canonical' ? -1 : b.kind === 'canonical' ? 1 : 0) || a.created_at.localeCompare(b.created_at));

    bar.replaceChildren(...[
      s.deleted_at ? h('span', { class: 'chip stone' }, '삭제됨') : s.status === 'completed' ? h('span', { class: 'chip grass' }, '완결') : h('span', { class: 'chip sky' }, '진행 중'),
      h('span', {}, `${s.line_count} / ${s.max_lines}줄 · 한 줄 ${s.max_chars}자`),
      (s.max_lines_override || s.max_chars_override) ? h('span', { class: 'muted' }, '(개별 한도)') : null,
      s.baton ? h('span', { class: 'chip pink' }, `쓰는 중: ${person(s.baton.name, s.baton.student_id)} ~${fmtTime(s.baton.expires_at)}`) : null,
      h('span', { style: 'flex:1' }),
      h('a', { href: `#/story/${s.id}`, class: 'btn-link' }, '공개 화면 ▸')].filter(Boolean));

    actions.replaceChildren(...[
      btn('제목 바꾸기', async () => {
        const t = await osPrompt('새 제목 (비우면 제목 없음)', s.title ?? '', { title: '제목 바꾸기' });
        if (t !== null) act(() => A.updateStory(s.id, { title: t }), '제목을 바꿨어요.');
      }),
      btn('한도 설정', async () => {
        const ml = await osPrompt(`이 이야기의 줄 수 (비우면 사이트 기본값)\n지금: ${s.max_lines_override ?? '기본값'}`, s.max_lines_override ?? '', { title: '한도 설정', input: { type: 'number' } });
        if (ml === null) return;
        const mc = await osPrompt(`이 이야기의 한 줄 글자 수 (비우면 사이트 기본값)\n지금: ${s.max_chars_override ?? '기본값'}`, s.max_chars_override ?? '', { title: '한도 설정', input: { type: 'number' } });
        if (mc === null) return;
        act(() => A.updateStory(s.id, { max_lines: String(ml).trim() ? Number(ml) : null, max_chars: String(mc).trim() ? Number(mc) : null }), '한도를 바꿨어요.');
      }),
      s.status === 'open'
        ? btn('지금 완결하기', async () => { if (await osConfirm('이 이야기를 지금 완결할까요?', { title: '완결하기' })) act(() => A.updateStory(s.id, { status: 'completed' }), '완결했어요.'); })
        : btn('다시 열기', () => act(() => A.updateStory(s.id, { status: 'open' }), '다시 열었어요.')),
      s.baton ? btn('예약 풀기', () => act(() => A.releaseBaton(s.id), '예약을 풀었어요.')) : null,
      s.deleted_at
        ? btn('이야기 복구', () => act(() => A.setStoryDeleted(s.id, false), '복구했어요.'))
        : btn('이야기 삭제', async () => { if (await osConfirm('이 이야기를 통째로 숨길까요? (나중에 복구할 수 있어요)', { title: '이야기 삭제', danger: true, ok: '삭제' })) act(() => A.setStoryDeleted(s.id, true), '삭제(숨김)했어요.'); }),
    ].filter(Boolean));

    const lineActions = (l) => {
      const parentCanonical = !l.parent_id || byId.get(l.parent_id)?.kind === 'canonical';
      const out = [
        btn('수정', async () => {
          const t = await osPrompt('줄 내용 고치기 (원래 내용은 기록에 남아요)', l.text, { title: `${pad2(l.position)}번 줄 수정`, input: { multiline: true } });
          if (t !== null) act(() => A.editLine(l.id, t), '고쳤어요.');
        }),
        btn(l.deleted_at ? '보이기' : '숨기기', () => act(() => A.setLineDeleted(l.id, !l.deleted_at), l.deleted_at ? '다시 보이게 했어요.' : '숨겼어요.')),
      ];
      if (l.kind === 'canonical' && l.id !== s.head_line_id) {
        const p = previewSetHead(s, l);
        out.push(btn('여기까지 되감기', async () => {
          if (await osConfirm(`${pad2(l.position)}번 줄까지 되감을까요?\n뒤의 ${p.archived}줄은 지워지지 않고 보관함으로 가요. 이야기는 다시 열려요.`, { title: '되감기', danger: true, ok: '되감기' }))
            act(() => A.setHead(l.id), '되감았어요.');
        }));
      }
      if (l.kind !== 'canonical') {
        if (parentCanonical && lines.some(x => x.kind === 'canonical' && x.position === l.position)) {
          out.push(btn('바꿔 넣기', async () => {
            if (await osConfirm('이 줄을 같은 자리의 정식 줄과 바꾸고, 뒤 줄은 그대로 둘까요?', { title: '바꿔 넣기' }))
              act(() => A.replaceLine(l.id), '바꿔 넣었어요.');
          }));
        }
        const p = previewSetHead(s, l);
        out.push(btn('여기를 끝으로', async () => {
          if (await osConfirm(`이 줄을 마지막 정식 줄로 만들까요?\n${p.archived}줄은 보관되고, ${p.promoted}줄이 정식으로 돌아와요.`, { title: '여기를 끝으로', danger: true, ok: '진행' }))
            act(() => A.setHead(l.id), '바꿨어요.');
        }));
        if (l.kind === 'conflict') {
          out.push(btn(l.conflict_status === 'open' ? '무시' : '다시 확인', () => act(() => A.setConflictStatus(l.id, l.conflict_status === 'open' ? 'dismissed' : 'open'))));
        }
      }
      return h('div', { class: 'btn-row' }, out);
    };

    table.replaceChildren(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['#', '종류', '내용', '작성자', '기기', '시각', ''].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, lines.map(l => h('tr', { class: [l.kind === 'conflict' && l.conflict_status === 'open' ? 'is-conflict' : '', l.kind === 'canonical' ? 'is-canonical' : '', (l.kind === 'archived' || l.deleted_at) ? 'dim' : ''].join(' ') },
        h('td', {}, pad2(l.position), l.id === s.head_line_id ? ' ◀' : ''),
        h('td', { class: 'kind' }, KIND[l.kind] ?? l.kind, l.conflict_status && l.conflict_status !== 'open' ? ` (${l.conflict_status === 'promoted' ? '승격' : '무시'})` : '', l.deleted_at ? ' [숨김]' : ''),
        h('td', {}, h('span', { class: 'text', style: 'font-size:15px;line-height:22px' }, l.text), l.original_text ? h('div', { class: 'muted' }, `원래: ${l.original_text}`) : null),
        h('td', {}, person(l.author_name, l.student_id)),
        h('td', { class: 'muted' }, short(l.client_token)),
        h('td', { class: 'muted' }, fmtTime(l.created_at)),
        h('td', { class: 'acts' }, lineActions(l)))))));
  }

  return view;
}
