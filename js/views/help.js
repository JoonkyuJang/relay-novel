// 도움말: the rules, filled in from the live settings.
import { h } from '../ui.js';
import { on, X, yeyo } from '../extras/extras.js';
import { helpSection } from '../extras/stamps.js';
import { deadlineText } from '../extras/desk.js';

function perPerson(s) {
  const n = s.lines_per_person_per_story ?? 1;
  const start = `새 이야기는 한 사람이 ${s.stories_started_per_person ?? 2}개까지 시작할 수 있어요.`;
  if (n <= 1) return `한 사람은 한 이야기에 한 줄만 쓸 수 있어요. ${start}`;
  return s.allow_consecutive_lines
    ? `한 사람은 한 이야기에 ${n}줄까지 쓸 수 있고, 연달아 써도 괜찮아요. ${start}`
    : `한 사람은 한 이야기에 ${n}줄까지 쓸 수 있지만, 연달아 두 줄을 쓸 수는 없어요. 다른 사람이 한 줄 이은 뒤에 다시 쓸 수 있어요. ${start}`;
}

export function helpView(app) {
  const scroll = h('div', { class: 'win-scroll', style: 'padding:16px 20px' });
  const body = document.createDocumentFragment();
  body.append(scroll);

  function render() {
    const s = app.settings ?? {};
    const min = Math.round((s.baton_seconds ?? 300) / 60);
    scroll.replaceChildren(
      h('h3', { style: 'margin:0 0 10px;font-size:13px' }, '연문회 릴레이 소설은 이렇게 써요'),
      h('ol', { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;line-height:18px' },
        h('li', {}, `이야기 서랍에서 이야기를 열고 '이어 쓰기'를 누르면 ${min}분 동안 그 자리가 내 자리로 맡아져요. 그동안 다른 사람은 기다려요.`),
        h('li', {}, 'Enter를 누르면 줄이 바로 올라가요.'),
        h('li', {}, `한 줄은 최대 ${s.max_chars ?? 100}자, 이야기는 ${s.max_lines ?? 20}줄이 되면 자동으로 완결돼요. 마지막 줄을 쓸 땐 미리 알려 드려요.`),
        h('li', {}, perPerson(s)),
        h('li', {}, '누가 썼는지는 줄 옆 사람 모양 아이콘을 누르면 볼 수 있어요.'),
        h('li', {}, '두 사람이 같은 자리에 동시에 올리면 먼저 도착한 줄이 올라가고, 나머지는 관리자가 확인해요.'),
        h('li', {}, '올린 줄은 직접 고칠 수 없어요. 고칠 게 있으면 관리자에게 말해 주세요.'),
        h('li', {}, `방명록에는 한 번에 ${s.guestbook_max_chars ?? 200}자까지, ${s.guestbook_cooldown_seconds ?? 30}초에 한 번 남길 수 있어요.`),
        on('deadline_on') && !Number.isNaN(Date.parse(X('deadline')))
          ? h('li', {}, on('deadline_closes')
            ? `${deadlineText(Date.parse(X('deadline')))}. 그 뒤로는 새 이야기와 이어 쓰기가 닫혀요 (이미 쓰고 있던 줄은 마저 올릴 수 있어요).`
            : `${deadlineText(Date.parse(X('deadline')))}. 메뉴 막대의 시계가 남은 시간을 보여 줘요.`)
          : null),
      helpSection(),
      on('cat') ? h('p', { style: 'margin:14px 0 0;line-height:18px' }, `바탕화면의 고양이 이름은 ${yeyo(X('cat_name'))}. 쓰다듬어 주세요.`) : null,
      h('p', { class: 'muted', style: 'margin:14px 0 0' }, '화면 효과는 메뉴의 CRT 버튼으로, 소리는 스피커 버튼으로 켜고 끌 수 있어요.'));
  }

  return {
    type: 'help', route: '/help', title: '도움말', body,
    size: { w: 480, h: 520 }, minSize: { w: 360, h: 260 }, origin: { x: 260, y: 60 },
    mount: render, onSettings: render,
  };
}
