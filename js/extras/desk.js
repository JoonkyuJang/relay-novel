// 바탕화면 부가 기능: 마감 시계, 소리 단추, 오른쪽 클릭 메뉴, 메모장, 휴지통,
// 오늘의 첫 문장, 이 컴퓨터에 관하여.
import * as api from '../api.js';
import { h, icon } from '../ui.js';
import { on, fun, X, bus, kst, WEEKDAY, manuscript, deadlineHour } from './extras.js';
import { soundOn, setSound, play } from './sound.js';
import { isPhone } from '../wm.js';
import { binSvg, trashBadge, tipContent, hoverTip, initPhoneBin, refreshTrashCount } from './bin.js';
import { giftArt, myGifts, GIFT_NAMES } from './cat.js';
import { ringLabel } from './rings.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function pixel(path, size = 14, vb = 14) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', `0 0 ${vb} ${vb}`); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('shape-rendering', 'crispEdges'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = path;
  return s;
}
export const ICONS = {
  speakerOn: '<path d="M1 5h3l4-3v10l-4-3H1z" fill="currentColor"/><path d="M10 4.5c1 1 1 4 0 5M11.5 3c2 2 2 6 0 8" fill="none" stroke="currentColor"/>',
  speakerOff: '<path d="M1 5h3l4-3v10l-4-3H1z" fill="currentColor"/><path d="M10 5l3 4M13 5l-3 4" stroke="#D9774F" stroke-width="1.5"/>',
  recap: '<path data-fill d="M2.5 1.5h11v13h-11z" fill="#FFF9EF" stroke="currentColor"/><path d="M8 3h1v2h2v1h-1v1h1v2H9V8H7v1H5V7h1V6H5V5h2V3z" fill="#D9774F"/><path d="M4.5 11.5h7M4.5 13h5" stroke="currentColor"/>',
  memo: '<path data-fill d="M2.5 1.5h11v13h-11z" fill="#FFF3B8" stroke="currentColor"/><path d="M4 4.5h8M4 7.5h8M4 10.5h5" stroke="currentColor"/>',
};

// ---------------------------------------------------------------- 마감 시계

export function deadlineParts(now = Date.now()) {
  const end = Date.parse(X('deadline'));
  if (!on('deadline_on') || Number.isNaN(end)) return null;
  const left = Math.max(0, end - now);
  const s = Math.floor(left / 1000);
  return { left, d: Math.floor(s / 86400), hh: Math.floor(s / 3600) % 24, mm: Math.floor(s / 60) % 60, ss: s % 60, end };
}
// "11월 22일(일) 밤 12시" for a midnight deadline, otherwise "11월 22일(일) 18:00" (Seoul time)
export function deadlineText(end) {
  const at = kst(new Date(end));
  if (at.h === 0 && at.min === 0) {
    const e = kst(new Date(end - 1));
    return `마감: ${e.m}월 ${e.d}일(${WEEKDAY[e.wd]}) 밤 12시`;
  }
  return `마감: ${at.m}월 ${at.d}일(${WEEKDAY[at.wd]}) ${String(at.h).padStart(2, '0')}:${String(at.min).padStart(2, '0')}`;
}
export function deadlineEl() {
  const el = h('span', { class: 'deadline', role: 'timer', 'aria-live': 'off' });
  const p2 = (n) => String(n).padStart(2, '0');
  const draw = () => {
    const p = deadlineParts();
    el.hidden = !p;
    if (!p) return;
    el.title = deadlineText(p.end) + (on('deadline_closes') ? ' · 이 시간이 지나면 글쓰기가 닫혀요' : '');
    if (p.left === 0) el.textContent = '마감됐어요';
    else if (isPhone()) el.textContent = p.d ? `마감 D-${p.d}` : '마감 D-day';
    else el.textContent = `마감까지 ${p.d ? `${p.d}일 ` : ''}${p2(p.hh)}:${p2(p.mm)}:${p2(p.ss)}`;
    el.classList.toggle('final-hour', on('deadline_fireworks') && deadlineHour());   // the last hour: it blinks
  };
  draw();
  setInterval(draw, 1000);
  return el;
}

// ---------------------------------------------------------------- 소리 단추

export function soundButton(onChange) {
  if (!on('sound')) return null;
  const v = soundOn();
  return h('button', {
    type: 'button', class: 'sound-btn', 'aria-pressed': String(v), title: v ? '소리 끄기' : '소리 켜기', 'aria-label': v ? '소리 켬' : '소리 끔',
    onclick: () => { setSound(!v); if (!v) play('pop'); onChange?.(); },
  }, pixel(v ? ICONS.speakerOn : ICONS.speakerOff, 14), h('span', { class: 'desk-only' }, v ? '켬' : '끔'));
}

// ---------------------------------------------------------------- 메모장 (this device only)

export function memoView(app) {
  const ta = h('textarea', { class: 'memo-text', placeholder: '여기 적은 건 이 기기에만 저장돼요. 아무도 못 봐요.', 'aria-label': '메모' });
  ta.value = api.prefs.get('memo', '');
  ta.addEventListener('input', () => api.prefs.set('memo', ta.value || null));
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const lines = ta.value.slice(0, ta.selectionStart).split('\n');
    const cmd = lines.at(-1).trim();
    if (cmd.startsWith('/')) {
      e.preventDefault();
      bus.emit('memo-command', { cmd });
      ta.value = ta.value.slice(0, ta.selectionStart - lines.at(-1).length) + ta.value.slice(ta.selectionStart);
      api.prefs.set('memo', ta.value || null);
    }
  });
  ta.addEventListener('input', () => {
    const tail = ta.value.slice(-6);
    if (/서시|윤동주/.test(tail)) bus.emit('memo-word', { word: tail });
  });
  const body = document.createDocumentFragment();
  body.append(h('div', { class: 'memo' }, ta));
  return {
    type: 'memo', route: '/memo', title: '메모장 — 나만 보여요', body,
    size: { w: 360, h: 300 }, minSize: { w: 280, h: 200 }, origin: { x: 160, y: 380 },
    mount() { setTimeout(() => ta.focus({ preventScroll: true })); },
    append(text) { ta.value = `${ta.value}${ta.value && !ta.value.endsWith('\n') ? '\n' : ''}${text}\n`; api.prefs.set('memo', ta.value); },
  };
}

// ---------------------------------------------------------------- 이 컴퓨터에 관하여

export function aboutView(app) {
  const box = h('div', { class: 'about' }, h('p', { class: 'muted' }, '불러오는 중…'));
  const body = document.createDocumentFragment();
  body.append(h('div', { class: 'win-scroll' }, box));
  async function render() {
    let a = null;
    try { a = await api.getAbout(); } catch { /* show what we can */ }
    const since = a?.since ? Date.parse(a.since) : null;
    const up = since ? Date.now() - since : 0;
    const sheets = a ? manuscript(a.chars) : 0;
    const pct = Math.min(100, Math.round(sheets / 10));      // 1,000매 = one "disk"
    const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
    box.replaceChildren(
      h('div', { class: 'about-head' }, icon('logo', 56),
        h('div', {}, h('div', { class: 'about-name' }, '연문회 OS'), h('div', { class: 'muted' }, '버전 1.0 · 2026 가을 · 연세문학회'))),
      h('dl', {},
        row('기억 장치', a ? `이야기 ${a.stories}편 · 줄 ${a.lines}개` : '—'),
        row('원고지', a ? `${sheets.toLocaleString('ko-KR')}매 사용` : '—'),
        on('stamps') ? row('찍힌 도장', a ? `${a.stamps.toLocaleString('ko-KR')}개` : '—') : null,
        row('가동 시간', since ? `${Math.floor(up / 86400e3)}일 ${Math.floor(up / 3600e3) % 24}시간` : '—'),
        on('cat') ? row('고양이', a ? `${X('cat_name')} 1마리 · 쓰다듬은 횟수 ${Number(a.cat_pets).toLocaleString('ko-KR')}` : X('cat_name')) : null,
        on('trash') ? row('휴지통', a ? `안 쓰고 놓은 바통 ${a.trash}번` : '—') : null,
        on('coffee_rings') ? row('커피 자국', `${ringLabel()} (늦은 밤에 쓴 줄마다)`) : null,
        on('cat_gifts') && Object.keys(myGifts()).length ? row('선물함', h('span', { class: 'gift-shelf' },
          Object.entries(myGifts()).map(([k, n]) => h('span', { class: 'gift-item', title: GIFT_NAMES[k] ?? k }, giftArt(k, 16), h('span', {}, `×${n}`))))) : null),
      h('div', { class: 'about-disk' }, h('span', { style: `width:${pct}%` })),
      h('div', { class: 'about-legend faint' }, h('span', {}, `■ 쓴 원고지 ${sheets}매 (${pct}%)`), h('span', {}, `□ 남은 ${Math.max(0, 1000 - sheets).toFixed(0)}매`)),
      h('p', { class: 'faint about-credits' },
        '글꼴: Neo둥근모, 갈무리11, 배민 주아(도장 글씨) — SIL OFL', h('br'),
        '만든 사람들: 연세문학회 · 함께 쓴 사람 모두', h('br'),
        '© 2026 연세문학회. 이야기의 권리는 쓴 사람들에게.'),
      h('p', { class: 'about-made' }, 'made by 장준규'));
  }
  return {
    type: 'about', route: '/about', title: '이 컴퓨터에 관하여', body, remember: false, resizable: false,
    size: { w: 380, h: 500 }, position: 'center', minimizable: false,
    mount: render,
  };
}

// ---------------------------------------------------------------- 오늘의 첫 문장

// Public-domain Korean prose (authors died long ago) alternating with club first lines.
const CLASSICS = [
  ['새침하게 흐린 품이 눈이 올 듯하더니 눈은 아니 오고 얼다가 만 비가 추적추적 내리는 날이었다.', '현진건, 「운수 좋은 날」'],
  ['‘박제가 되어 버린 천재’를 아시오?', '이상, 「날개」'],
  ['오늘도 또 우리 수탉이 막 쫓기었다.', '김유정, 「동백꽃」'],
  ['“장인님! 인제 저……”', '김유정, 「봄·봄」'],
  ['내가 열 살이 될락말락한 때이니까 지금으로부터 십사오 년 전 일이다.', '나도향, 「벙어리 삼룡이」'],
  ['경성학교 영어 교사 이형식은 오후 두 시 사년급 영어 시간을 마치고 내리쬐는 유월 볕에 땀을 흘리면서 안동 김장로의 집으로 간다.', '이광수, 「무정」'],
];
export function firstSentence(stories) {
  const { y, m, d } = kst();
  const day = Math.floor(Date.UTC(y, m - 1, d) / 86400e3);
  const club = (stories ?? []).filter(s => s.first_line);
  if (day % 2 === 0 || !club.length) {
    const [text, src] = CLASSICS[Math.floor(day / 2) % CLASSICS.length];
    return { text, src, date: `${m}.${String(d).padStart(2, '0')}` };
  }
  const s = club[Math.floor(day / 2) % club.length];
  return { text: s.first_line, src: `「${s.title || '제목 없는 이야기'}」 첫 줄`, date: `${m}.${String(d).padStart(2, '0')}`, id: s.id };
}

// ---------------------------------------------------------------- 바탕 무늬 (this device)

const PATTERNS = ['dots', 'grid', 'ginkgo', 'plain'];
const PATTERN_NAMES = { dots: '점', grid: '원고지', ginkgo: '은행잎', plain: '무늬 없음' };
const pattern = () => (on('desk_patterns') && PATTERNS.includes(api.prefs.get('pattern')) ? api.prefs.get('pattern') : 'dots');
function applyPattern() { for (const p of PATTERNS) document.body.classList.toggle(`pattern-${p}`, p === pattern() && p !== 'dots'); }
function setPattern(p) { api.prefs.set('pattern', p === 'dots' ? null : p); applyPattern(); }

// ---------------------------------------------------------------- the desktop itself

export function initDesk(app, wm, { desktop, iconsNav }) {
  // extra desktop icons: 메모장 + 휴지통 (the phone gets its own bin on the dock: bin.js)
  const memoIcon = h('a', { class: 'icon extra', href: '#/memo' }, pixel(ICONS.memo, 40, 16), h('span', {}, '메모장'));
  const trashIcon = h('button', { type: 'button', class: 'icon extra trash', 'aria-label': '휴지통' });
  trashIcon.append(trashBadge(trashIcon), binSvg(40), h('span', {}, '휴지통'));
  hoverTip(trashIcon, tipContent);
  trashIcon.addEventListener('dblclick', () => bus.emit('trash-dblclick', { el: trashIcon }));
  trashIcon.addEventListener('click', (e) => { if (!fun('fun_trash') || e.detail === 0) app.go('/about'); });   // keyboard Enter always opens it
  initPhoneBin(app, desktop);

  const sticky = h('aside', { class: 'sticky', hidden: true, 'aria-label': '오늘의 첫 문장' });

  const recapIcon = h('a', { class: 'icon extra', href: '#/recap' }, pixel(ICONS.recap, 40, 16), h('span', {}, '2026 가을 결산'));
  function placeIcons() {
    iconsNav.querySelectorAll('.extra').forEach(e => e.remove());
    if (app.recapOpen?.()) iconsNav.append(recapIcon);
    if (on('memo')) iconsNav.append(memoIcon);
    if (on('trash')) iconsNav.append(trashIcon);
  }
  const refreshTrash = refreshTrashCount;
  async function refreshSticky() {
    if (!on('first_sentence') || isPhone()) { sticky.hidden = true; return; }
    let stories = [];
    try { stories = await api.listStories(); } catch { /* classics only */ }
    const f = firstSentence(stories);
    sticky.replaceChildren(
      h('div', { class: 'sticky-head' }, h('b', {}, '오늘의 첫 문장'), h('span', {}, ` · ${f.date}`),
        h('button', { type: 'button', class: 'sticky-x', 'aria-label': '오늘은 그만 보기', onclick: () => { api.prefs.set('sticky.hide', f.date); sticky.hidden = true; } }, '×')),
      h('p', { class: 'sticky-text' }, f.text),
      f.id ? h('a', { href: `#/story/${f.id}`, class: 'sticky-src' }, `— ${f.src}`) : h('span', { class: 'sticky-src' }, `— ${f.src}`));
    sticky.hidden = api.prefs.get('sticky.hide') === f.date;
  }
  desktop.append(sticky);

  // 오른쪽 클릭 메뉴 (desktop) / 길게 누르기 (lines)
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  function openMenu(x, y, items) {
    closeMenu();
    menu = h('div', { class: 'ctx', role: 'menu' }, items.map(it => it === '-'
      ? h('div', { class: 'ctx-sep', role: 'separator' })
      : h('button', { type: 'button', role: 'menuitem', class: 'ctx-item', onclick: () => { closeMenu(); play('select'); it[1](); } },
          h('span', {}, it[0]), it[2] ? h('span', { class: 'faint' }, it[2]) : null)));
    document.body.append(menu);
    play('menu');
    const w = menu.offsetWidth, ht = menu.offsetHeight;
    menu.style.left = `${Math.min(x, innerWidth - w - 6)}px`;
    menu.style.top = `${Math.min(y, innerHeight - ht - 6)}px`;
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  function deskItems() {
    const saverOff = api.prefs.get('saver') === '0';
    return [
      ['새 이야기', () => app.go('/new')],
      on('my_lines') && app.identity() ? ['내가 쓴 줄', () => app.go('/mine')] : null,
      on('minimize') ? ['창 정리하기', () => wm.tidy()] : null,
      on('minimize') ? ['모두 접어 두기', () => wm.minimizeAll()] : null,
      '-',
      ['화면 보호기 지금 켜기', () => bus.emit('saver-now', {})],
      [saverOff ? '이 기기에서 화면 보호기 켜기' : '이 기기에서 화면 보호기 끄기', () => api.prefs.set('saver', saverOff ? null : '0')],
      on('sound') ? [soundOn() ? '소리 끄기' : '소리 켜기', () => { setSound(!soundOn()); app.refreshMenubar?.(); }] : null,
      on('desk_patterns') ? ['바탕 무늬 바꾸기', () => { setPattern(PATTERNS[(PATTERNS.indexOf(pattern()) + 1) % PATTERNS.length]); }, PATTERN_NAMES[pattern()]] : null,
      on('daynight') && on('daynight_override') ? ['낮 · 밤 바꾸기', () => document.querySelector('.phase-ico')?.click(), { auto: '자동', day: '늘 낮', night: '늘 밤' }[api.prefs.get('daynight', 'auto')]] : null,
      '-',
      on('about') ? ['이 컴퓨터에 관하여…', () => app.go('/about')] : null,
    ].filter(Boolean).filter((x, i, a) => !(x === '-' && (i === 0 || a[i - 1] === '-' || i === a.length - 1)));
  }
  function lineItems(li) {
    const id = li.dataset.id;
    const win = li.closest('.win');
    const storyId = win?.dataset.key?.replace(/^story:/, '');
    const text = li.querySelector('.line-text')?.firstChild?.textContent ?? '';
    return [
      ['속성 보기', () => li.querySelector('.who')?.click()],
      on('stamps') ? ['도장 찍기', () => li.querySelector('.who')?.click(), '›'] : null,
      ['이야기 링크 복사', () => navigator.clipboard?.writeText(`${location.origin}${location.pathname}#/story/${storyId}`).catch(() => {})],
      on('memo') ? '-' : null,
      on('memo') ? ['메모장에 옮겨 적기', () => { app.go('/memo'); setTimeout(() => wm.get('memo')?.view.append?.(`“${text}”`), 50); }] : null,
    ].filter(Boolean);
    void id;
  }
  function titleItems(win) {
    const key = win.dataset.key, w = wm.get(key);
    return [
      [wm.isShaded(key) ? '펼치기' : '말아 올리기', () => wm.shade(key)],
      on('minimize') && w?.view.minimizable !== false && w?.view.closable !== false ? ['접어 두기', () => wm.minimize(key)] : null,
      w?.view.closable !== false ? ['닫기', () => wm.close(key)] : null,
    ].filter(Boolean);
  }
  desktop.addEventListener('contextmenu', (e) => {
    if (!on('context_menu')) return;
    const title = e.target.closest('.win-title');
    if (title && on('window_shade') && !isPhone() && !e.target.closest('button')) { e.preventDefault(); openMenu(e.clientX, e.clientY, titleItems(title.closest('.win'))); return; }
    const li = e.target.closest('.line[data-id]');
    if (li) { e.preventDefault(); openMenu(e.clientX, e.clientY, lineItems(li)); return; }
    if (e.target.closest('.win, input, textarea, a, button')) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, deskItems());
  });
  // long press on a line (phones)
  let press = null;
  desktop.addEventListener('touchstart', (e) => {
    const li = e.target.closest('.line[data-id]');
    if (!li || !on('context_menu')) return;
    const t = e.touches[0];
    press = setTimeout(() => { press = null; openMenu(t.clientX, t.clientY, lineItems(li)); navigator.vibrate?.(10); }, 550);
  }, { passive: true });
  for (const ev of ['touchend', 'touchmove', 'touchcancel']) desktop.addEventListener(ev, () => { clearTimeout(press); press = null; }, { passive: true });

  const refreshAll = () => { placeIcons(); refreshTrash(); refreshSticky(); applyPattern(); };
  // the 결산 icon appears by itself when the deadline passes with the page open
  const untilEnd = Date.parse(X('deadline')) - Date.now();
  if (untilEnd > 0 && untilEnd < 2 ** 31 - 1) setTimeout(() => { placeIcons(); bus.emit('settings', {}); }, untilEnd + 1000);
  bus.on('settings', refreshAll);
  api.watch(['list'], () => { refreshTrash(); });
  refreshAll();
  return { trashIcon, sticky, closeMenu };
}
