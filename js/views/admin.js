// 관리자 콘솔 + 관리용 이야기 창. Only reachable after the hidden admin login.
import * as api from '../api.js';
import { h, fmtTime, relTime, errorText, osConfirm, osPrompt } from '../ui.js';
import { DEFAULTS, on } from '../extras/extras.js';

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
  ['allow_consecutive_lines', '같은 사람이 연달아 쓰기 허용', 'checkbox'],
  ['allow_new_stories', '새 이야기 허용', 'checkbox'],
  ['x:title_required', '새 이야기 제목 필수', 'checkbox'],
  ['guestbook_open', '방명록 열림', 'checkbox'],
  ['show_student_id', '속성 창에 학번 표시', 'checkbox'],
  ['stats_public', '출석부 공개', 'checkbox'],
];

// 부가 기능: grouped like the mockups. key 'col:x' = an existing settings column.
const EXTRA_TABS = [
  ['바탕화면', [
    ['crt_default', 'CRT 화면 효과를 기본으로', '처음 온 사람 기준 · 각자 메뉴에서 바꿀 수 있어요'],
    ['boot_screen', '부팅 화면', '로그인 전 연문회 OS 부팅 글자'],
    ['presence', '접속 중 n명', '메뉴 막대'],
    ['col:stats_public', '출석부 공개', ''],
    ['col:guestbook_open', '방명록 열림', ''],
    ['deadline_on', '마감 시계', '메뉴 막대에 남은 시간 · 휴대폰은 D-n'],
    ['deadline', '마감 일시 (서울)', '밤 12시는 다음 날 0:00으로 적어요', 'datetime'],
    ['deadline_closes', '마감이 지나면 글쓰기 닫기', '새 이야기 · 이어 쓰기 모두 · 이미 쓰던 사람은 마저 올릴 수 있어요'],
    ['context_menu', '오른쪽 클릭 메뉴', '휴대폰은 줄을 길게 누르기'],
    ['minimize', '창 접어 두기', '제목 막대의 _ 단추'],
    ['trash', '휴지통', '안 쓰고 놓은 바통 수 (숫자만) · 마우스를 올리면 설명'],
    ['trash_toss', '쓰던 줄 구겨 버리기', '취소하면 쓰기 칸이 종이처럼 구겨져 휴지통으로 · 고양이가 쳐다봐요'],
    ['trash_phone', '휴대폰에도 휴지통', '메뉴 막대 위 오른쪽, 고양이 옆 · 누르면 설명, 두 번 누르면 와르르'],
    ['memo', '메모장', '이 기기에만 저장 · 아무도 못 봐요'],
    ['first_sentence', '오늘의 첫 문장', '바탕화면 붙임쪽지'],
    ['typing_count', '누군가 쓰는 중 글자 수', '숫자만 실시간으로'],
    ['notify_free', '자리 나면 알려 주기', '바통이 풀리면 종 + 제목 깜빡임'],
    ['grid_box_default', '원고지 쓰기 칸을 기본으로', '각자 바꿀 수 있어요'],
    ['about', '이 컴퓨터에 관하여', '왼쪽 위 로고 · 오른쪽 클릭 메뉴'],
    ['my_lines', '내가 쓴 줄', '메뉴 막대의 내 이름을 누르면'],
    ['error_reports', '오류 보고', '브라우저 오류를 관리 · 기록에 모아요 (이름·학번 없이)'],
  ]],
  ['낮과 밤', [
    ['daynight', '낮과 밤 바탕화면', '서울 시간 · 아침 · 낮 · 노을 · 밤'],
    ['daynight_override', '각자 바꾸기 허용', '시계 옆 해·달 아이콘'],
    ['moon_phase', '실제 달 모양', ''],
    ['skyline', '학생회관', '바탕화면 아래 · 하늘을 따라 색이 바뀌고 밤엔 불 켜진 창 (동아리방은 늘)'],
    ['seasons', '낙엽 · 첫눈', '몇 분마다 은행잎 · 단풍잎이 날리고, 첫눈 날짜부터는 눈'],
    ['snow_from', '첫눈 날짜 (서울)', '이날부터 낙엽 대신 눈 · 학생회관 지붕에도 눈', 'datetime'],
  ]],
  ['움직임', [
    ['zoom_rects', '창 열고 닫을 때 점선 테두리', '옛 매킨토시처럼 · 접어 두면 아래 막대로'],
    ['shake_on_error', '안 될 때 도리도리', '잘못된 학번 · 쓰는 중인 이야기 · 꽉 찬 이야기에 창이 흔들리고 삑'],
    ['press_buttons', '눌리는 버튼', '누르는 동안 버튼이 쏙 들어가요'],
    ['pixel_cursor', '픽셀 마우스 커서', '화살표 · 손 · 글쓰기 · 불러오는 중 모래시계'],
    ['type_in_lines', '새 줄이 한 글자씩', '다른 사람이 올린 줄이 타자로 찍히듯 나타나요'],
    ['milestones', '절반 · 마지막 한 줄', '"절반 왔어요!" · 마지막 빈 줄이 은은하게 빛나요'],
    ['ticker', '방금 이어졌어요', '어디서든 새 줄 · 새 이야기 · 완결이 메뉴 막대에 지나가요'],
  ]],
  ['화면 보호기', [
    ['saver_typing', '이어 쓰는 화면', ''], ['saver_typing_min', '… 몇 분 뒤', '', 'number'],
    ['saver_stars', '별 헤는 밤', ''], ['saver_stars_min', '… 몇 분 뒤', '', 'number'],
    ['cat_sleep', '고양이 낮잠', ''], ['cat_sleep_min', '… 몇 분 뒤', '', 'number'],
    ['saver_completed_only', '완결된 이야기 줄만', '끄면 진행 중인 이야기 줄도'],
    ['saver_phone', '휴대폰에서도', ''],
    ['saver_typewriter', '타자기 소리', '소리를 켠 사람에게만'],
  ]],
  ['고양이', [
    ['cat', '고양이', '바탕화면에 한 마리'],
    ['cat_name', '이름', '마우스를 올리면 보여요', 'text'],
    ['cat_wander', '돌아다니기 · 창 위 낮잠', ''],
    ['cat_pet_count', '쓰다듬기 횟수', '야옹 아래 (모두의 합계)'],
    ['cat_reach', '쓰다듬어 줘 · 두리번', '커서가 가까이 오면'],
    ['cat_belly', '가끔 벌러덩', ''],
    ['cat_wink', '100번째마다 윙크', '희귀 동작'],
    ['cat_jump', '완결 점프', ''],
    ['cat_phone', '휴대폰 메뉴 위에', ''],
    ['cat_typing', '글 쓰는 걸 지켜보기', '창 아래로 와서 올려다보고, 줄을 올리면 귀를 쫑긋 · 빨리 치면 앞발로 툭'],
    ['cat_seal_nap', '완결 도장 위 낮잠', '가끔 이야기 서랍의 최근 완결 도장 위에서'],
  ]],
  ['도장', [
    ['stamps', '도장', '참 잘했어요 · 재밌어요 · 다음이 궁금해요'],
    ['stamp_size', '줄 옆 작은 도장 크기 (px)', '20 ~ 32', 'number'],
    ['stamp_ticks', '스크롤 막대 눈금', '도장 많은 줄을 빨간 눈금으로'],
    ['stamp_help', '도움말에 도장 설명', ''],
  ]],
  ['완결 이야기', [
    ['reading', '낭독회', '완결된 이야기에 ▶ 낭독회'],
    ['reading_voice', '삐삐 목소리', '글자마다 짧은 소리 · 줄마다 다른 높이'],
    ['manuscript', '원고지 매수', '200자 원고지 기준'],
    ['relay_record', '이어달리기 기록', '쓰인 시각 띠 + 빠른 바통 · 긴 기다림'],
    ['completion_fx', '완결 순간 효과', '창 흔들림 + 완결 도장 + 고양이 점프 + 종소리'],
    ['reading_credits', '낭독회 끝에 함께 쓴 사람', '이름만 가나다순 (학번 없이, 어느 줄인지 연결 없이)'],
    ['print_sheet', '원고지로 인쇄', '완결된 이야기를 200자 원고지에 · 이름만'],
  ]],
  ['소리', [
    ['sound', '소리 기능', '끄면 아무 소리도 나지 않아요'],
    ['sound_default', '처음 온 사람은 소리 켬', '끄면 각자 켜야 들려요 (권장)'],
  ]],
  ['숨은 재미', [
    ['fun', '숨은 재미 전체', '끄면 아래가 모두 꺼져요'],
    ['fun_full', '꽉 채웠어요', '글자 수 제한을 딱 맞춘 줄에 원고지 아이콘'],
    ['fun_amber', '호박색 단말기', '"호박"(ghqkr) 입력 · 휴대폰은 로고 다섯 번'],
    ['fun_meow', '방명록에 "야옹"', '고양이가 놀라 달려가요'],
    ['fun_trash', '휴지통 와르르', '두 번 누르면'],
    ['fun_clock', '시계 열 번', '원고지 시간으로'],
    ['fun_tidy', '메모장 "/정리"', '창들이 가지런히'],
    ['fun_seosi', '메모장 "서시" · "윤동주"', '별이 떨어져요'],
    ['fun_eagle', '"독수리"', '독수리가 날아가고 고양이가 하악'],
    ['fun_catreads', '낮잠 자던 고양이의 낭독', '고양이가 누운 창의 이야기가 끝나면 마지막 줄을 삐삐로'],
  ]],
];

const toLocalKST = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t + 9 * 3600e3).toISOString().slice(0, 16);
};
const fromLocalKST = (v) => (v ? `${v}:00+09:00` : null);

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
    ['guestbook', '방명록'], ['people', '참여자'], ['log', '기록'], ['extras', '부가 기능'], ['reset', '초기화'],
  ];
  let extraTab = EXTRA_TABS[0][0];
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
    const x = { ...DEFAULTS, ...(st.extras ?? {}) };                // 'x:key' rows live in settings.extras
    const val = (k) => k.startsWith('x:') ? x[k.slice(2)] : st[k];
    const form = h('form', { novalidate: true, style: 'display:flex;flex-direction:column;gap:14px' },
      h('div', { class: 'settings-grid' }, SETTINGS.map(([k, label, type]) => type === 'checkbox'
        ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: k, checked: !!val(k) }), label)
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
        if (v === val(k)) continue;
        if (k.startsWith('x:')) (patch.extras ??= {})[k.slice(2)] = v; else patch[k] = v;
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
    const [rows, errs] = await Promise.all([A.log(200), A.clientErrors(100).catch(() => [])]);
    const browser = (ua = '') => (/iPhone|iPad/.test(ua) ? 'iOS ' : /Android/.test(ua) ? 'Android ' : /Mac OS/.test(ua) ? 'Mac ' : /Windows/.test(ua) ? 'Windows ' : '')
      + (/CriOS|Chrome\//.test(ua) && !/Edg\//.test(ua) ? 'Chrome' : /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '?');
    const errors = h('section', { style: 'margin:0 0 18px' },
      h('h3', { style: 'margin:0 0 8px;font-size:13px' }, `브라우저 오류 ${errs.length ? `(최근 ${errs.length}개)` : ''}`),
      !errs.length ? h('p', { class: 'muted', style: 'margin:0' }, on('error_reports') ? '아직 보고된 오류가 없어요.' : '오류 보고가 꺼져 있어요 (부가 기능 · 바탕화면).')
        : h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ['시각', '내용', '위치', '브라우저', '기기'].map(t => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, errs.map(e => h('tr', {},
            h('td', { class: 'muted' }, fmtTime(e.at)),
            h('td', {}, h('code', { style: 'word-break:break-all', title: e.stack ?? '' }, e.message)),
            h('td', { class: 'muted' }, h('code', { style: 'word-break:break-all' }, e.source ?? '')),
            h('td', { class: 'muted', title: e.agent ?? '' }, browser(e.agent)),
            h('td', { class: 'muted' }, e.device ?? ''))))));
    if (!rows.length) return [errors, h('p', { class: 'muted', style: 'margin:0' }, '기록이 없어요.')];
    return [errors, h('h3', { style: 'margin:0 0 8px;font-size:13px' }, '관리 기록'), h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['시각', '동작', '대상', '내용'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', { class: 'muted' }, fmtTime(r.created_at)), h('td', {}, r.action), h('td', { class: 'muted' }, short(r.target_id)),
        h('td', { class: 'muted' }, h('code', { style: 'word-break:break-all' }, r.details ? JSON.stringify(r.details).slice(0, 240) : '')))))) ];
  }

  async function viewExtras() {
    const st = await A.getSettings();
    const x = { ...DEFAULTS, ...(st.extras ?? {}) };
    const inner = h('div', { class: 'extra-tabs', role: 'group', 'aria-label': '부가 기능 묶음' },
      EXTRA_TABS.map(([name]) => h('button', { type: 'button', 'aria-pressed': String(extraTab === name),
        onclick: () => { extraTab = name; render(); } }, name)));
    const save = async (patch, label) => {
      try { await A.updateSettings(patch); notice(`${label} 저장했어요.`, 'ok'); }
      catch (e) { notice(errorText(e)); }
    };
    const rows = EXTRA_TABS.find(t => t[0] === extraTab)[1].map(([key, label, hint, type]) => {
      const col = key.startsWith('col:') ? key.slice(4) : null;
      const value = col ? st[col] : x[key];
      const patchOf = (v) => (col ? { [col]: v } : { extras: { [key]: v } });
      const note = hint ? h('span', { class: 'faint' }, hint) : null;
      if (type === 'number') {
        const inp = h('input', { type: 'number', class: 'field sm', value, min: 1, style: 'width:90px', onchange: () => save(patchOf(Number(inp.value)), label) });
        return h('label', { class: 'extra-row' }, h('span', { class: 'extra-label' }, label, note), inp);
      }
      if (type === 'text') {
        const inp = h('input', { type: 'text', class: 'field sm', value, maxlength: 12, style: 'width:140px', onchange: () => inp.value.trim() && save(patchOf(inp.value.trim()), label) });
        return h('label', { class: 'extra-row' }, h('span', { class: 'extra-label' }, label, note), inp);
      }
      if (type === 'datetime') {
        const inp = h('input', { type: 'datetime-local', class: 'field sm', value: toLocalKST(value), style: 'width:200px', onchange: () => inp.value && save(patchOf(fromLocalKST(inp.value)), label) });
        return h('label', { class: 'extra-row' }, h('span', { class: 'extra-label' }, label, note), inp);
      }
      const cb = h('input', { type: 'checkbox', checked: !!value, onchange: () => save(patchOf(cb.checked), label) });
      return h('label', { class: 'extra-row check' }, cb, h('span', { class: 'extra-label' }, label, note));
    });
    return [inner, h('div', { class: 'extra-list' }, rows),
      h('p', { class: 'muted', style: 'margin:0' }, '바꾸면 바로 저장되고, 열려 있는 모든 화면에 곧 반영돼요.')];
  }

  // 초기화: wipe practice data before the program starts. Settings and switches stay as they are.
  async function viewReset() {
    const c = await A.resetCounts();
    const ITEMS = [
      ['test_stories', '테스트 이야기만 지우기', `제목이 "[TEST]"로 시작하는 이야기 ${c.test_stories}편 (동시성 테스트가 남긴 것)`, c.test_stories, false],
      ['cat_pets', '고양이 쓰다듬기 횟수 0으로', `지금 ${c.cat_pets}번`, c.cat_pets, false],
      ['trash', '휴지통 0으로', `안 쓰고 놓은 바통 ${c.trash}번`, c.trash, false],
      ['client_errors', '브라우저 오류 기록 비우기', `${c.client_errors}개`, c.client_errors, false],
      ['stamps', '도장 모두 지우기', `${c.stamps}개`, c.stamps, true],
      ['guestbook', '방명록 비우기', `${c.guestbook}개 · 번호도 #001부터 다시`, c.guestbook, true],
      ['stories', '이야기 모두 지우기', `이야기 ${c.stories}편 · 줄 ${c.lines}개 (충돌 ${c.conflicts}개 포함) · 그 도장까지 · 출석부도 비어요`, c.stories, true],
      ['log', '관리 기록 비우기', `${c.log}줄 (초기화했다는 기록 한 줄은 남아요)`, c.log, false],
    ];
    const run = async (what, label, danger) => {
      if (danger) {
        const typed = await osPrompt(`${label}: 되돌릴 수 없어요. 지우기 전에 백업 파일을 자동으로 내려받아요.\n계속하려면 '지우기'라고 적어 주세요.`, '',
          { title: '초기화', ok: '지우기', danger: true });
        if (typed == null) return;
        if (typed.trim() !== '지우기') { notice("'지우기'라고 적어야 지워져요."); return; }
        await backup();
      } else if (!(await osConfirm(`${label}?`, { title: '초기화', ok: '확인' }))) return;
      act(() => A.reset(what), `${label} — 끝났어요.`);
    };
    const all = ITEMS.map(i => i[0]).filter(k => k !== 'test_stories');
    return [
      h('p', { style: 'margin:0 0 12px;line-height:20px' },
        '프로그램을 시작하기 전에 연습한 흔적을 지워요. 설정 · 부가 기능 스위치 · 관리자 계정은 그대로예요. ',
        h('b', {}, '지우는 건 되돌릴 수 없어요'), ' — 도장 · 방명록 · 이야기를 지울 땐 백업 파일을 먼저 자동으로 내려받아요. 각자 기기의 메모장 · 소리 설정은 그 기기에만 있어서 여기서 지워지지 않아요.'),
      h('div', { class: 'reset-list' }, ITEMS.map(([k, label, hint, n, danger]) => h('div', { class: 'reset-row' },
        h('span', { class: 'extra-label' }, h('span', {}, label), h('span', { class: 'faint' }, hint)),
        h('button', { type: 'button', class: `btn btn-sm${danger ? ' danger' : ''}`, disabled: !Number(n), onclick: () => run([k], label, danger) },
          Number(n) ? (danger ? '지우기' : '초기화') : '비어 있음')))),
      h('div', { class: 'reset-all' },
        h('span', { class: 'extra-label' }, h('b', {}, '전부 초기화'), h('span', { class: 'faint' }, '위의 모든 것을 한 번에 — 프로그램 시작 직전에')),
        h('button', { type: 'button', class: 'btn btn-primary danger', onclick: () => run(all, '전부 초기화', true) }, '전부 초기화')),
    ];
  }

  const VIEWS = { reset: viewReset, extras: viewExtras, conflicts: viewConflicts, stories: viewStories, settings: viewSettings, guestbook: viewGuestbook, people: viewPeople, log: viewLog };

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
    size: { w: 920, h: 620 }, minSize: { w: 640, h: 400 }, origin: { x: 60, y: 30 },
    mount() { render(); unwatch = api.watch(['admin', 'list', 'settings', 'guestbook'], () => { if (tab !== 'settings' && tab !== 'extras' && tab !== 'reset') render(); }); },
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
    size: { w: 960, h: 600 }, minSize: { w: 720, h: 400 }, origin: { x: 120, y: 60 },
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
        l.kind === 'canonical' ? btn('도장', async () => {
          try {
            const list = await A.lineStamps(l.id);
            const NAME = { sun: '참 잘했어요', laugh: '재밌어요', cur: '다음이 궁금해요' };
            await osConfirm(list.length ? list.map(x => `${NAME[x.kind]} — ${person(x.name, x.student_id)} · ${fmtTime(x.created_at)}`).join('\n') : '아직 찍힌 도장이 없어요.',
              { title: `${pad2(l.position)}번 줄 도장`, cancel: '닫기', ok: '확인' });
          } catch (e) { notice(errorText(e)); }
        }) : null,
      ].filter(Boolean);
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
        h('td', {}, pad2(l.position), l.id === s.head_line_id ? ' ◀\uFE0E' : ''),
        h('td', { class: 'kind' }, KIND[l.kind] ?? l.kind, l.conflict_status && l.conflict_status !== 'open' ? ` (${l.conflict_status === 'promoted' ? '승격' : '무시'})` : '', l.deleted_at ? ' [숨김]' : ''),
        h('td', {}, h('span', { class: 'text', style: 'font-size:15px;line-height:22px' }, l.text), l.original_text ? h('div', { class: 'muted' }, `원래: ${l.original_text}`) : null),
        h('td', {}, person(l.author_name, l.student_id)),
        h('td', { class: 'muted' }, short(l.client_token)),
        h('td', { class: 'muted' }, fmtTime(l.created_at)),
        h('td', { class: 'acts' }, lineActions(l)))))));
  }

  return view;
}
