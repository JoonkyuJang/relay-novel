// 연문회 OS: boot, login, menu bar, desktop icons / dock, and hash routing.
import * as api from './api.js';
import { h, $, icon, fmtClock } from './ui.js';
import { createWM, isPhone } from './wm.js';
import { storiesView } from './views/stories.js';
import { storyView } from './views/story.js';
import { newStoryView } from './views/newstory.js';
import { rosterView } from './views/roster.js';
import { guestbookView } from './views/guestbook.js';
import { loginView } from './views/login.js';
import { helpView } from './views/help.js';
import { readingView } from './views/reading.js';
import { mineView } from './views/mine.js';
import { recapView } from './views/recap.js';
import { proposalsView } from './views/proposals.js';
import { initReports } from './extras/report.js';
import { setExtras, on, X, bus, deadlineOver, iga } from './extras/extras.js';
import { initDayNight, phaseButton } from './extras/daynight.js';
import { initDesk, deadlineEl, soundButton, memoView, aboutView } from './extras/desk.js';
import { initCat } from './extras/cat.js';
import { initSaver } from './extras/saver.js';
import { initFun } from './extras/fun.js';
import { injectStampDefs } from './extras/stamps.js';
import { initTicker, initUpdateCheck, initTabIcon } from './extras/life.js';
import { initRings } from './extras/rings.js';

initReports();                                   // crash reports first, so startup errors are caught too

const desktop = $('#desktop');
const menubar = $('#menubar');
const iconsNav = $('#icons');
const dock = $('#dock');

const tray = h('nav', { class: 'tray', hidden: true, 'aria-label': '접어 둔 창' }, h('span', { class: 'tray-label' }, '접어 둔 창'));
desktop.append(tray);
const trayList = h('span', { class: 'tray-list' });
tray.append(trayList);

let pending = null;          // route to open after logging in
let presenceCount = null;

const app = {
  settings: null,
  crt: api.prefs.get('crt') == null ? true : api.prefs.get('crt') !== '0',
  identity: () => api.getIdentity(),
  setCrt(v) {
    app.crt = v;
    api.prefs.set('crt', v ? '1' : '0');
    document.body.classList.toggle('crt', v);
    renderMenubar();
  },
  go(route) {
    if (currentRoute() === route) openRoute(route);
    else location.hash = route;
  },
  close: (key) => wm.close(key),
  requireLogin(reason, returnRoute) { pending = returnRoute ?? null; showLogin(reason); },
  afterLogin() {
    api.prefs.set('visited', '1');
    wm.close('login');
    $('.bootlog')?.remove();
    renderMenubar();
    renderNav(); loadBadge(); checkAdopted();
    forEachView(v => v.onFocus?.());
    const target = pending ?? currentRoute();
    pending = null;
    openRoute('/stories', { silent: target !== '/stories' });
    if (target !== '/stories' && target !== '/login') openRoute(target);
    else updateNav('/stories');
  },
  admin: false,
  // 결산 opens after the deadline (admins can look early)
  recapOpen: () => on('recap') && (deadlineOver() || app.admin),
  afterAdminLogin() {
    app.admin = true;
    api.prefs.set('visited', '1');
    bus.emit('settings', {});                 // (admins see the 결산 icon early)
    if (!api.hasEntered()) api.setGuest();
    wm.close('login');
    $('.bootlog')?.remove();
    renderMenubar();
    renderNav(); loadBadge();
    forEachView(v => v.onFocus?.());
    openRoute('/stories', { silent: true });
    app.go('/admin');
  },
  adminLost() {
    app.admin = false;
    for (const k of wm.keys()) if (k === 'admin' || k.startsWith('admin-story:')) wm.close(k);
    renderMenubar();
    renderNav(); loadBadge();
    forEachView(v => v.onFocus?.());
  },
};

const wm = createWM(desktop, { onActiveChange, tray: trayList, canMinimize: () => on('minimize') });
const trayObserver = new MutationObserver(() => { tray.hidden = !trayList.children.length; });
trayObserver.observe(trayList, { childList: true });
app.refreshMenubar = () => renderMenubar();

function forEachView(fn) { for (const k of wm.keys()) fn(wm.get(k).view); }

// ------------------------------------------------------------ routing

// While the 건의함 is on, 새 이야기 is an admin's icon (on a phone admins start one from the 서랍 / 건의함)
function navItems() {
  const prop = on('proposals');
  return [
    { route: '/stories',   label: '이야기 서랍', short: '서랍',     icon: 'folder' },
    !prop || app.admin ? { route: '/new', label: '새 이야기', short: '새 이야기', icon: 'newdoc', deskOnly: prop } : null,
    prop ? { route: '/proposals', label: '건의함', short: '건의함', icon: 'suggest' } : null,
    { route: '/roster',    label: '출석부',      short: '출석부',   icon: 'roster' },
    { route: '/guestbook', label: '방명록',      short: '방명록',   icon: 'book' },
  ].filter(Boolean);
}

function currentRoute() {
  try { return decodeURIComponent(location.hash.replace(/^#/, '')) || '/stories'; }
  catch { return '/stories'; }               // a cut-off link like #/story/%E
}

function resolve(route) {
  const m = route.match(/^\/story\/([0-9a-f-]{36})$/i);
  if (m) return [`story:${m[1].toLowerCase()}`, () => storyView(app, m[1].toLowerCase())];
  const r = route.match(/^\/read\/([0-9a-f-]{36})$/i);
  if (r && on('reading')) return [`read:${r[1].toLowerCase()}`, () => readingView(app, r[1].toLowerCase())];
  if (route === '/memo' && on('memo')) return ['memo', () => memoView(app)];
  if (route === '/about' && on('about')) return ['about', () => aboutView(app)];
  if (route === '/mine' && on('my_lines')) return ['mine', () => mineView(app)];
  if (route === '/recap' && app.recapOpen()) return ['recap', () => recapView(app)];
  if (route === '/proposals' && on('proposals')) return ['proposals', () => proposalsView(app)];
  const a = route.match(/^\/admin\/story\/([0-9a-f-]{36})$/i);
  if (a && app.admin) return [`admin-story:${a[1].toLowerCase()}`, () => lazyView(
    { type: 'admin-story', route, title: '관리 · 이야기', size: { w: 960, h: 600 }, minSize: { w: 720, h: 400 }, origin: { x: 120, y: 60 } },
    () => import('./views/admin.js').then(m => m.adminStoryView(app, a[1].toLowerCase())))];
  if (route === '/admin' && app.admin) return ['admin', () => lazyView(
    { type: 'admin', route: '/admin', title: '관리자 콘솔', size: { w: 920, h: 620 }, minSize: { w: 640, h: 400 }, origin: { x: 60, y: 30 } },
    () => import('./views/admin.js').then(m => m.adminView(app)))];
  switch (route) {
    case '/new':       return ['new', () => newStoryView(app)];
    case '/roster':    return ['roster', () => rosterView(app)];
    case '/guestbook': return ['guestbook', () => guestbookView(app)];
    case '/help':      return ['help', () => helpView(app)];
    default:           return ['stories', () => storiesView(app)];
  }
}

// A window whose code loads on first open (the admin console: only admins ever need it).
function lazyView(meta, make) {
  const holder = h('div', { class: 'win-scroll' }, h('p', { class: 'muted', style: 'padding:16px;margin:0' }, '불러오는 중…'));
  const body = document.createDocumentFragment();
  body.append(holder);
  let real = null, closed = false;
  const view = {
    ...meta, body,
    mount() {
      make().then((r) => {
        if (closed) return;
        real = r;
        real.setTitle = view.setTitle;
        holder.replaceWith(r.body);
        r.mount?.();
      }).catch(() => { holder.firstChild.textContent = '불러오지 못했어요. 새로고침해 주세요.'; });
    },
    unmount() { closed = true; real?.unmount?.(); },
    onFocus() { real?.onFocus?.(); },
    onSettings() { real?.onSettings?.(); },
  };
  return view;
}

function openRoute(route, opts) {
  if (route === '/login') { showLogin(); return; }
  if (!api.hasEntered()) { pending = route; showLogin(); return; }
  const [key, factory] = resolve(route);
  wm.open(key, factory, opts);
}

function onActiveChange(win) {
  if (!win) {
    updateNav(null);
    if (isPhone() && api.hasEntered()) openRoute('/stories');
    else history.replaceState(null, '', location.pathname + location.search);
    return;
  }
  const route = win.view.route;
  updateNav(route);
  if (route !== '/login' && currentRoute() !== route) history.replaceState(null, '', `#${route}`);
}

function updateNav(route) {
  const navRoute = route?.startsWith('/story/') || route?.startsWith('/read/') ? '/stories' : route;
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === navRoute) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

addEventListener('hashchange', () => openRoute(currentRoute()));

// ------------------------------------------------------------ login + boot

function showLogin(reason = '') {
  if (wm.has('login')) wm.close('login');
  const win = wm.open('login', () => loginView(app, { reason }));
  if ($('.bootlog')) win.el.classList.add('has-bootlog');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBoot() {
  const data = Promise.all([api.getSettings().catch(() => null), api.listStories().catch(() => null)]);
  const early = await Promise.race([data.then(([st]) => st), sleep(1200).then(() => null)]);
  if (early?.extras && early.extras.boot_screen === false) return;
  const log = h('div', { class: 'bootlog', 'aria-hidden': 'true' });
  desktop.append(log);
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const line = async (text, hi = false) => { log.append(h('div', { class: hi ? 'hi' : '' }, text || ' ')); if (!quick) await sleep(140); };
  const phone = isPhone();
  await line('연문회 OS 1.0', true);
  if (!phone) { await line('(C) 연세문학회 · 2026'); await line(''); }
  const [st, stories] = await Promise.race([data, sleep(2500).then(() => [null, null])]);
  const dots = phone ? '......' : '..........';
  await line(`원고지 검사 ${dots} ${st?.max_chars ?? 100}칸 OK`);
  await line(`이야기 서랍 ${dots} ${stories ? `${stories.length}편` : '…'}`);
  if (!phone) await line(`접속자 확인 .......... ${presenceCount ?? 1}명`);
  await line('> 로그인 대기 _', true);
}

// ------------------------------------------------------------ menu bar, icons, dock

const presenceEl = h('span', { class: 'desk-only muted', hidden: true });
const clockText = h('span', {}, fmtClock());
const clockEl = h('span', { class: 'desk-only clock', id: 'clock' }, clockText);
setInterval(() => { clockText.textContent = fmtClock(); }, 20000);
const deadline = deadlineEl();
let logoEl = null;

function renderMenubar() {
  const ident = api.getIdentity();
  document.body.classList.toggle('not-entered', !api.hasEntered());
  const about = on('about');                  // the logo is the "apple menu": 이 컴퓨터에 관하여…
  logoEl = h('a', { class: 'logo', href: about ? '#/about' : '#/stories', 'aria-label': about ? '연문회 OS — 이 컴퓨터에 관하여' : '연문회 OS — 이야기 서랍' },
    icon('logo', 16), h('span', {}, '연문회 OS'));
  presenceEl.hidden = !on('presence') || presenceCount == null;
  menubar.replaceChildren(...[
    logoEl,
    h('button', { type: 'button', onclick: () => app.go('/help') }, '도움말'),
    app.admin ? h('button', { type: 'button', onclick: () => app.go('/admin') }, '관리') : null,
    h('span', { class: 'spacer' }),
    deadline,
    presenceEl,
    api.hasEntered()
      ? ident
        ? [on('my_lines') ? h('button', { type: 'button', class: 'menu-name', title: '내가 쓴 줄', onclick: () => app.go('/mine') }, `${ident.name} 님`) : h('span', { class: 'menu-name' }, `${ident.name} 님`), h('button', { type: 'button', onclick: logout }, '로그아웃')]
        : h('button', { type: 'button', class: 'guest-login', title: '둘러보는 중이에요 · 로그인하면 이어 쓰고 도장 · ♥도 남길 수 있어요', onclick: () => app.requireLogin('', currentRoute()) },
            h('span', { class: 'desk-only' }, '손님 · '), '로그인하기')
      : null,
    soundButton(renderMenubar),
    h('button', { type: 'button', class: 'desk-only', 'aria-pressed': String(app.crt), title: '화면 효과', onclick: () => app.setCrt(!app.crt) }, `CRT ${app.crt ? '켬' : '끔'}`),
    h('span', { class: 'desk-only clock-wrap' }, phaseButton(renderMenubar), clockEl)].flat().filter(Boolean));
  drawFloor();
}

function logout() {
  api.logout();
  if (app.admin) { app.admin = false; api.signOut().catch(() => {}); }   // one 로그아웃 ends everything
  pending = null;
  adoptChecked = false; hadWaiting = false;     // (the next person gets their own 채택 note)
  document.querySelector('.adopt-note')?.remove();
  loadBadge();
  for (const k of wm.keys()) wm.close(k);      // also releases any reserved turn
  history.replaceState(null, '', location.pathname + location.search);
  renderMenubar();
  showLogin();
}

async function adminLogout() {
  await api.signOut().catch(() => {});
  app.adminLost();
}
app.adminLogout = adminLogout;

let navSig = null;
function renderNav() {
  const items = navItems();
  const sig = items.map(n => n.route).join();
  if (sig === navSig) return;
  navSig = sig;
  const extras = [...iconsNav.querySelectorAll('.extra')];          // 결산 · 메모장 · 휴지통 (desk.js) stay
  iconsNav.replaceChildren(...items.map(n =>
    h('a', { class: 'icon', href: `#${n.route}`, dataset: { route: n.route } }, icon(n.icon, 40), h('span', {}, n.label))), ...extras);
  dock.replaceChildren(...items.filter(n => !n.deskOnly).map(n =>
    h('a', { href: `#${n.route}`, dataset: { route: n.route } }, icon(n.icon, 22), h('span', {}, n.short))));
  updateNav(wm.active?.view.route ?? null);
  drawBadge();
}

// the number of waiting proposals on the 건의함 icon (for admins, or everyone, as the admin chose)
let waiting = null;
const badgeShown = () => on('proposals') && api.hasEntered()
  && (X('proposal_badge') === 'all' || (X('proposal_badge') === 'admin' && app.admin));
async function loadBadge() {
  if (!badgeShown()) { waiting = null; drawBadge(); return; }
  try { waiting = (await api.listProposals(null)).items.length; } catch { /* keep the last number */ }
  drawBadge();
}
function drawBadge() {
  for (const a of document.querySelectorAll('[data-route="/proposals"]')) {
    a.querySelector('.nav-badge')?.remove();
    if (waiting && badgeShown()) a.append(h('i', { class: 'nav-badge', title: `기다리는 건의 ${waiting}개` }, String(waiting)));
  }
}

// once, the first time the proposer comes back after an admin 채택s their story — or right away, if they're
// here when it happens (only people with a waiting proposal look again on a 건의함 change)
let adoptChecked = false, hadWaiting = false;
async function checkAdopted() {
  const ident = api.getIdentity();
  if (adoptChecked || !ident || !on('proposals') || !on('proposal_notice')) return;
  adoptChecked = true;
  try {
    const mine = await api.myProposals(ident);
    hadWaiting = mine.some(p => p.status === 'waiting');
    const fresh = mine.filter(p => p.status === 'adopted' && !p.seen && p.story_id);
    if (!fresh.length) return;
    document.querySelector('.adopt-note')?.remove();
    const p = fresh[0];
    const close = () => note.remove();
    const note = h('div', { class: 'adopt-note notice ok', role: 'status' },
      h('span', {}, `건의한 「${p.title || '제목 없는 이야기'}」${fresh.length > 1 ? ` 외 ${fresh.length - 1}편이` : iga(p.title || '이야기')} 채택되어 이야기 서랍에 올라갔어요. 다른 사람들이 이어 써요. `),
      h('a', { href: `#/story/${p.story_id}`, onclick: close }, '서랍에서 보기 ▸'),
      h('button', { type: 'button', class: 'adopt-x', 'aria-label': '닫기', onclick: close }, '×'));
    document.body.append(note);
    setTimeout(close, 30000);
    api.ackProposals(ident).catch(() => {});
  } catch { adoptChecked = false; }
}

// phones: a slim strip under the dock (the host's badge sits on its right end); a status line on the left,
// and the 방금 이어졌어요 ticker passes here
const floor = h('div', { class: 'floor', 'aria-hidden': 'true' }, h('span', { class: 'floor-text' }));
document.body.append(floor);
let floorStories = null;
function drawFloor() {
  const t = floor.firstChild;
  if (!api.hasEntered() || !floorStories) { t.textContent = '연세문학회 릴레이 소설'; return; }
  const open = floorStories.filter(s => s.status === 'open').length;
  t.textContent = [`진행 중 ${open}편`, `완결 ${floorStories.length - open}편`, on('presence') && presenceCount != null ? `접속 ${presenceCount}명` : null].filter(Boolean).join(' · ');
}
api.onStories((list) => { floorStories = list; drawFloor(); });

// ------------------------------------------------------------ settings + presence

let settingsSig = null;
async function loadSettings() {
  try {
    const next = await api.getSettings();
    const { server_now: _now, ...rest } = next;
    const sig = JSON.stringify(rest);
    if (sig === settingsSig) return;          // nothing changed: don't re-render every window
    settingsSig = sig;
    app.settings = next;
    setExtras(app.settings.extras);
    // first visit: CRT follows the admin's default until the person picks
    if (api.prefs.get('crt') == null) { app.crt = on('crt_default'); document.body.classList.toggle('crt', app.crt); }
    renderMenubar();
    renderNav(); loadBadge(); drawFloor();
    if (booted) checkAdopted();
    forEachView(v => v.onSettings?.());
    // a link to a window that depends on the settings (#/recap after the deadline, #/mine, #/about…) may have
    // been opened before they arrived and fallen back to the 서랍: open what it really asked for
    if (!settingsSeen && booted && api.hasEntered()) {
      const route = bootRoute, [key] = resolve(route);
      if (route !== '/stories' && route !== '/login' && !wm.has(key)) openRoute(route);
    }
    settingsSeen = true;
  } catch { /* views fall back to defaults */ }
}
let settingsSeen = false, booted = false;      // (booted: the first windows have been opened)
const bootRoute = currentRoute();                 // (the address may be rewritten before the settings arrive)

api.presence((n) => {
  presenceCount = n;
  presenceEl.hidden = !on('presence');
  presenceEl.textContent = `접속 중 ${n}명`;
  drawFloor();
});

// ------------------------------------------------------------ start

document.body.classList.toggle('crt', app.crt);
renderMenubar();
renderNav();
injectStampDefs();
initDayNight(desktop);
initDesk(app, wm, { desktop, iconsNav });
initRings(desktop);
const cat = initCat(app, wm, desktop);
if (api.prefs.get('debugSounds') === '1') window.__rnCat = cat;     // (tests)
initSaver(app, wm, cat);
initFun(app, wm, { cat, clockEl });
initTicker();
initTabIcon(wm);
const updates = initUpdateCheck();
window.__rnCheckUpdate = () => updates?.check();    // (tests)
bus.on('theme', () => renderMenubar());
// switches that change windows already open: 창 접어 두기 / 창 말아 올리기 off → bring folded windows back
bus.on('settings', () => {
  document.body.classList.toggle('no-minimize', !on('minimize'));
  for (const w of wm.wins()) {
    if (!on('minimize') && w.minimized) wm.restore(w.key);
    if (!on('window_shade') && wm.isShaded(w.key)) wm.shade(w.key);
  }
});
// the deadline passing while the page is open (결산 icon and link, writing closing) acts like a settings change
let wasOver = deadlineOver();
setInterval(() => {
  if (deadlineOver() === wasOver) return;
  wasOver = !wasOver;
  bus.emit('settings', {});
  renderMenubar(); renderNav();
  forEachView(v => v.onSettings?.());
}, 20e3);
bus.on('sound', () => renderMenubar());          // e.g. sound turned itself off after a long time away
api.watch(['proposals'], () => { loadBadge(); if (hadWaiting) { adoptChecked = false; checkAdopted(); } });
loadSettings();
api.watch(['settings'], loadSettings);

// An admin session (from the hidden login) survives reloads; check it before routing.
async function checkAdmin() {
  try {
    if (!(await api.currentUser())) return;
    app.admin = await Promise.race([api.isAdmin(), sleep(4000).then(() => false)]);
  } catch { app.admin = false; }
  if (app.admin) renderMenubar();
}

await checkAdmin();
// a guest from an earlier visit (or before this refresh) is asked again: log in, or 둘러보기 once more —
// and lands back on the same window either way (admins stay in: their session is the login)
if (api.isGuest() && !api.getIdentity() && !app.admin) { api.endGuest(); renderMenubar(); }
if (api.hasEntered()) api.prefs.set('visited', '1');
if (!api.hasEntered()) {
  const route = currentRoute();
  if (route !== '/stories' && route !== '/login') pending = route;
  // the boot text is for the very first visit; after that the login window comes straight up
  if (api.prefs.get('visited') === '1') {
    if (!isPhone()) wm.open('stories', () => storiesView(app), { silent: true });   // (the 서랍 waits behind it)
    showLogin();
  } else runBoot().then(() => showLogin());
} else {
  const route = currentRoute();
  openRoute('/stories', { silent: route !== '/stories' });
  if (route !== '/stories' && route !== '/login') openRoute(route);
  else updateNav('/stories');
}
booted = true;
if (settingsSeen) checkAdopted();
