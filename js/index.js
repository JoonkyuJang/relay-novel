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
import { initReports } from './extras/report.js';
import { setExtras, on, bus } from './extras/extras.js';
import { initDayNight, phaseButton } from './extras/daynight.js';
import { initDesk, deadlineEl, soundButton, memoView, aboutView } from './extras/desk.js';
import { initCat } from './extras/cat.js';
import { initSaver } from './extras/saver.js';
import { initFun } from './extras/fun.js';
import { injectStampDefs } from './extras/stamps.js';

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
    wm.close('login');
    $('.bootlog')?.remove();
    renderMenubar();
    forEachView(v => v.onFocus?.());
    const target = pending ?? currentRoute();
    pending = null;
    openRoute('/stories', { silent: target !== '/stories' });
    if (target !== '/stories' && target !== '/login') openRoute(target);
    else updateNav('/stories');
  },
  admin: false,
  afterAdminLogin() {
    app.admin = true;
    if (!api.hasEntered()) api.setGuest();
    wm.close('login');
    $('.bootlog')?.remove();
    renderMenubar();
    openRoute('/stories', { silent: true });
    app.go('/admin');
  },
  adminLost() {
    app.admin = false;
    for (const k of wm.keys()) if (k === 'admin' || k.startsWith('admin-story:')) wm.close(k);
    renderMenubar();
  },
};

const wm = createWM(desktop, { onActiveChange, tray: trayList, canMinimize: () => on('minimize') });
const trayObserver = new MutationObserver(() => { tray.hidden = !trayList.children.length; });
trayObserver.observe(trayList, { childList: true });
app.refreshMenubar = () => renderMenubar();

function forEachView(fn) { for (const k of wm.keys()) fn(wm.get(k).view); }

// ------------------------------------------------------------ routing

const NAV = [
  { route: '/stories',   label: '이야기 서랍', short: '서랍',     icon: 'folder' },
  { route: '/new',       label: '새 이야기',   short: '새 이야기', icon: 'newdoc' },
  { route: '/roster',    label: '출석부',      short: '출석부',   icon: 'roster' },
  { route: '/guestbook', label: '방명록',      short: '방명록',   icon: 'book' },
];

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
        : [h('span', { class: 'muted' }, '손님'), h('button', { type: 'button', onclick: () => app.requireLogin('', currentRoute()) }, '로그인')]
      : null,
    soundButton(renderMenubar),
    h('button', { type: 'button', class: 'desk-only', 'aria-pressed': String(app.crt), title: '화면 효과', onclick: () => app.setCrt(!app.crt) }, `CRT ${app.crt ? '켬' : '끔'}`),
    h('span', { class: 'desk-only clock-wrap' }, phaseButton(renderMenubar), clockEl)].flat().filter(Boolean));
}

function logout() {
  api.logout();
  if (app.admin) { app.admin = false; api.signOut().catch(() => {}); }   // one 로그아웃 ends everything
  pending = null;
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

function renderNav() {
  iconsNav.replaceChildren(...NAV.map(n =>
    h('a', { class: 'icon', href: `#${n.route}`, dataset: { route: n.route } }, icon(n.icon, 40), h('span', {}, n.label))));
  dock.replaceChildren(...NAV.map(n =>
    h('a', { href: `#${n.route}`, dataset: { route: n.route } }, icon(n.icon, 22), h('span', {}, n.short))));
}

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
    forEachView(v => v.onSettings?.());
  } catch { /* views fall back to defaults */ }
}

api.presence((n) => {
  presenceCount = n;
  presenceEl.hidden = !on('presence');
  presenceEl.textContent = `접속 중 ${n}명`;
});

// ------------------------------------------------------------ start

document.body.classList.toggle('crt', app.crt);
renderMenubar();
renderNav();
injectStampDefs();
initDayNight(desktop);
initDesk(app, wm, { desktop, iconsNav });
const cat = initCat(app, wm, desktop);
initSaver(app, wm, cat);
initFun(app, wm, { cat, clockEl });
bus.on('theme', () => renderMenubar());
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
if (!api.hasEntered()) {
  const route = currentRoute();
  if (route !== '/stories' && route !== '/login') pending = route;
  runBoot().then(() => showLogin());
} else {
  const route = currentRoute();
  openRoute('/stories', { silent: route !== '/stories' });
  if (route !== '/stories' && route !== '/login') openRoute(route);
  else updateNav('/stories');
}
