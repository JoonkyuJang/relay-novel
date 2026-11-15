// 사용 설명서: the participant's whole path in a few pages — browsing, logging in, 이어 쓰기 (with 원고 검토
// and 고치기), proposing a story, 도장 · 내가 쓴 줄, and the small things around the desktop. The numbers
// come from the live settings; pages for switched-off features are left out.
import { h, icon } from '../ui.js';
import { on, X } from '../extras/extras.js';
import { play } from '../extras/sound.js';
import { stampSvg, KINDS, NAMES } from '../extras/stamps.js';
import { deadlineText } from '../extras/desk.js';
import { isPhone } from '../wm.js';

// a tiny stand-in for a piece of the real screen
const mock = (...kids) => h('div', { class: 'guide-mock', 'aria-hidden': 'true' }, ...kids);
const fakeBtn = (t, primary = false) => h('span', { class: `btn btn-sm${primary ? ' btn-primary' : ''}` }, t);
const item = (b, t) => h('li', {}, h('b', {}, b), ' — ', t);

export function guideView(app) {
  let page = 0, pages = [];
  const stage = h('div', { class: 'recap-stage guide-stage', 'aria-live': 'polite' });
  const dots = h('div', { class: 'recap-dots', 'aria-hidden': 'true' });
  const prev = h('button', { type: 'button', class: 'btn', 'aria-label': '이전', onclick: () => go(page - 1) }, icon('prev', 14));
  const next = h('button', { type: 'button', class: 'btn btn-primary', 'aria-label': '다음', onclick: () => go(page + 1) }, icon('next', 14));
  const count = h('span', { class: 'faint guide-count' });
  const foot = h('div', { class: 'recap-foot' }, prev, h('span', { style: 'display:flex;gap:10px;align-items:center' }, dots, count), next);
  const body = document.createDocumentFragment();
  body.append(stage, foot);

  function build() {
    const st = app.settings ?? {};
    const N = st.max_lines ?? 20, C = st.max_chars ?? 100, per = st.lines_per_person_per_story ?? 1;
    const min = Math.max(1, Math.round((st.baton_seconds ?? 300) / 60));
    const editMin = X('self_edit_minutes');
    const list = [
      () => [h('p', { class: 'recap-kicker' }, '연세문학회 릴레이 소설'), h('h2', {}, '연문회 OS 사용 설명서'),
        mock(icon('logo', 40)),
        h('p', {}, `한 사람이 한 줄씩 이어 써서, ${N}줄이 모이면 이야기 한 편이 완성돼요.`),
        h('p', { class: 'muted' }, '두 분이면 다 볼 수 있어요. 오른쪽 아래 ▶ 로 넘겨 보세요.')],
      () => [h('h3', {}, '둘러보기와 로그인'),
        mock(h('span', { class: 'guide-pill' }, '손님 · 로그인하기')),
        h('ul', { class: 'recap-list guide-list' },
          item('둘러보기', '로그인하지 않아도 모든 이야기를 읽을 수 있어요.'),
          item('로그인', '이름과 학번만 적으면 돼요. 이 기기에만 기억되고, 메뉴 막대에서 언제든 로그아웃해요.'),
          item('다시 로그인하려면', '메뉴 막대의 "로그인하기"를 눌러요.'))],
      () => [h('h3', {}, '이야기 서랍'),
        mock(h('span', { class: 'guide-row' }, h('span', {}, '막차 다음 버스'), h('span', {}, `12/${N}`), h('span', { class: 'chip sky' }, '진행 중'))),
        h('ul', { class: 'recap-list guide-list' },
          item('진행 중', '아직 이어 쓸 수 있는 이야기예요. 눌러서 열어요.'),
          item('완결', `${N}줄을 다 채운 이야기예요.${on('reading') ? ' ▶ 낭독회로 처음부터 들어 볼 수 있어요.' : ''}`),
          on('ticker') ? item('방금 이어졌어요', '어디서든 새 줄이 올라오면 메뉴 막대(휴대폰은 아래 띠)로 지나가요.') : null)],
      () => [h('h3', {}, '이어 쓰기'),
        mock(fakeBtn('이어 쓰기', true), h('span', { class: 'chip sky' }, `내 줄 0/${per}`)),
        h('ol', { class: 'recap-list guide-list guide-steps' },
          h('li', {}, `이야기를 열고 '이어 쓰기'를 누르면 ${min}분 동안 그 자리가 내 자리예요. 그동안 다른 사람은 기다려요.`),
          h('li', {}, `한 줄은 ${C}자까지예요.${!isPhone() || on('grid_box_phone') ? " '원고지 칸으로'를 누르면 원고지에 쓰듯 써져요." : ''}`),
          h('li', {}, on('confirm_post') ? 'Enter를 누르면 원고 검토 창이 떠요. 앞 줄과 함께 한 번 더 보고 올려요.' : 'Enter를 누르면 바로 올라가요.'),
          h('li', {}, per <= 1 ? '한 이야기에는 한 줄만 쓸 수 있어요. 창 위의 "내 줄 0/1"이 알려 줘요.'
            : `한 이야기에 ${per}줄까지 쓸 수 있어요${st.allow_consecutive_lines ? '' : '. 바로 앞 줄을 쓴 사람은 연달아 쓸 수 없어요'}.`))],
      (on('self_edit') || on('self_delete')) && editMin > 0 ? () => {
        const ed = on('self_edit'), del = on('self_delete');
        return [h('h3', {}, ed && del ? '올린 줄 고치기 · 지우기' : ed ? '올린 줄 고치기' : '올린 줄 지우기'),
          mock(h('span', { class: 'text' }, '내가 방금 올린 줄'), ed ? h('span', { class: 'edit-own' }, '고치기 4:12') : null,
            del ? h('span', { class: 'edit-own del' }, ed ? '지우기' : '지우기 4:12') : null),
          h('ul', { class: 'recap-list guide-list' },
            ed ? item(`${editMin}분 동안`, '방금 올린 내 줄 옆에 "고치기"가 떠요. 오타를 바로 고칠 수 있어요.') : null,
            del ? item(ed ? '지우기' : `${editMin}분 동안`, '아예 거둬들이고 싶으면 "지우기"를 눌러요. 그 자리는 다시 비어서 누구나 (나도) 이어 써요. 첫 줄은 지울 수 없어요.') : null,
            item('다음 줄이 이어지기 전까지만', `누가 다음 줄을 쓰기 시작하면 ${ed && del ? '고치거나 지울' : ed ? '고칠' : '지울'} 수 없어요.${ed ? ' 고치는 동안엔 다음 줄을 잠깐 맡아 둬요.' : ''}`),
            ed ? item('(고침)', '고친 줄에는 작은 표시가 남아요.') : null)];
      } : null,
      () => on('proposals') ? [h('h3', {}, '새 이야기는 건의함으로'),
        mock(icon('suggest', 32), h('span', { class: 'like', 'aria-pressed': 'true' }, icon('heart', 14), '3')),
        h('ul', { class: 'recap-list guide-list' },
          item('건의하기', `제목과 첫 줄을 건의함에 올려요. 한 사람이 ${X('proposals_per_person')}개까지 기다리게 할 수 있어요.`),
          on('proposal_likes') ? item('♥', '로그인하면 마음에 드는 건의에 ♥를 누를 수 있어요.') : null,
          item('채택', '관리자가 채택하면 이야기 서랍에 올라가요. 첫 줄은 건의한 사람 이름으로 남아요.'),
          item('내 건의', '메뉴 막대의 내 이름 → 내가 쓴 줄에서 기다리는 중 · 채택 · 반려를 볼 수 있어요.'))]
        : [h('h3', {}, '새 이야기 시작하기'), mock(fakeBtn('새 이야기 시작', true)),
          h('p', {}, `제목과 첫 줄을 쓰면 새 이야기가 시작돼요. 한 사람이 ${st.stories_started_per_person ?? 2}개까지 시작할 수 있어요.`)],
      on('stamps') || on('my_lines') ? () => [h('h3', {}, '도장과 내가 쓴 줄'),
        on('stamps') ? mock(...KINDS.map(k => stampSvg(k, { size: 30 }))) : null,
        h('ul', { class: 'recap-list guide-list' },
          item('누가 썼을까', '줄 옆의 사람 모양을 누르면 쓴 사람이 보여요.'),
          on('stamps') ? item('도장', `그 창에서 ${KINDS.map(k => NAMES[k]).join(' · ')} 도장을 찍을 수 있어요.`) : null,
          on('my_lines') ? item('내가 쓴 줄', `메뉴 막대의 내 이름을 누르면 내가 쓴 줄을 모아 봐요${on('stamp_card') ? '. 도장 수첩도 거기 있어요' : ''}.`) : null,
          on('notify_after_me') ? item('내 줄 뒤로', '내 줄 다음이 이어지면 알려 줘요.') : null)] : null,
      () => [h('h3', {}, '방명록과 소소한 것들'),
        h('ul', { class: 'recap-list guide-list' },
          item('방명록', '아무 이야기나 자유롭게 남겨요.'),
          on('cat') ? item(`고양이 ${X('cat_name')}`, '바탕화면의 고양이를 쓰다듬어 보세요.') : null,
          on('trash') ? item('휴지통', "'이어 쓰기'로 맡았다가 올리지 않고 놓은 횟수예요.") : null,
          on('coffee_rings') ? item('커피 자국', '밤 12시부터 새벽 6시 사이에 쓰인 줄마다 하나씩 남아요.') : null,
          on('daynight') && on('daynight_override') ? item('낮과 밤', '시계 옆 해 · 달을 누르면 늘 낮 / 늘 밤으로 바꿔요.') : null,
          on('memo') ? item('메모장', '이 기기에만 저장되는 나만의 메모예요.') : null,
          item('화면 효과 · 소리', '메뉴 막대의 CRT · 스피커 버튼으로 켜고 꺼요.'),
          on('context_menu') ? item('오른쪽 클릭', '바탕화면이나 줄을 오른쪽 클릭(휴대폰은 길게 누르기)하면 메뉴가 떠요.') : null)],
      () => [h('h2', {}, '이제 써 볼까요?'),
        on('deadline_on') && !Number.isNaN(Date.parse(X('deadline'))) ? h('p', {}, deadlineText(Date.parse(X('deadline'))) + (on('recap') ? ' · 마감 뒤엔 결산이 열려요.' : '')) : null,
        h('p', { class: 'muted' }, '이 설명서는 도움말에서 언제든 다시 열 수 있어요.'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { app.close('guide'); app.go('/stories'); } }, '이야기 서랍 열기')],
    ];
    return list.filter(Boolean);
  }

  function go(i) {
    if (!pages.length) return;
    page = Math.max(0, Math.min(pages.length - 1, i));
    stage.replaceChildren(h('div', { class: 'recap-page guide-page' }, pages[page]()));
    dots.replaceChildren(...pages.map((_, k) => h('i', { class: k === page ? 'on' : '' })));
    count.textContent = `${page + 1} / ${pages.length}`;
    prev.disabled = page === 0;
    next.disabled = page === pages.length - 1;
    play('select');
  }
  function onKey(e) {
    if (!stage.closest('.win')?.classList.contains('is-active')) return;
    if (e.target.closest?.('input, textarea')) return;
    if (e.key === 'ArrowRight') go(page + 1);
    else if (e.key === 'ArrowLeft') go(page - 1);
  }

  return {
    type: 'guide', route: '/guide', title: '사용 설명서', body,
    size: { w: 520, h: 500 }, minSize: { w: 340, h: 380 }, position: 'center',
    mount() { addEventListener('keydown', onKey); pages = build(); go(0); },
    onSettings() { pages = build(); go(Math.min(page, pages.length - 1)); },
    unmount() { removeEventListener('keydown', onKey); },
  };
}
