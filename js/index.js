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

const desktop = $('#desktop');
const menubar = $('#menubar');
const iconsNav = $('#icons');
const dock = $('#dock');

let pending = null;          // route to open after logging in
let presenceCount = null;

const app = {
  settings: null,
  crt: api.prefs.get('crt', '1') !== '0',
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
};

const wm = createWM(desktop, { onActiveChange });

function forEachView(fn) { for (const k of wm.keys()) fn(wm.get(k).view); }

// ------------------------------------------------------------ routing

const NAV = [
  { route: '/stories',   label: '이야기 서랍', short: '서랍',     icon: 'folder' },
  { route: '/new',       label: '새 이야기',   short: '새 이야기', icon: 'newdoc' },
  { route: '/roster',    label: '출석부',      short: '출석부',   icon: 'roster' },
  { route: '/guestbook', label: '방명록',      short: '방명록',   icon: 'book' },
];

function currentRoute() { return decodeURIComponent(location.hash.replace(/^#/, '')) || '/stories'; }

function resolve(route) {
  const m = route.match(/^\/story\/([0-9a-f-]{36})$/i);
  if (m) return [`story:${m[1].toLowerCase()}`, () => storyView(app, m[1].toLowerCase())];
  switch (route) {
    case '/new':       return ['new', () => newStoryView(app)];
    case '/roster':    return ['roster', () => rosterView(app)];
    case '/guestbook': return ['guestbook', () => guestbookView(app)];
    case '/help':      return ['help', () => helpView(app)];
    default:           return ['stories', () => storiesView(app)];
  }
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
  const navRoute = route?.startsWith('/story/') ? '/stories' : route;
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
  const log = h('div', { class: 'bootlog', 'aria-hidden': 'true' });
  desktop.append(log);
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const data = Promise.all([api.getSettings().catch(() => null), api.listStories().catch(() => null)]);
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
const clockEl = h('span', { class: 'desk-only' }, fmtClock());
setInterval(() => { clockEl.textContent = fmtClock(); }, 20000);

function renderMenubar() {
  const ident = api.getIdentity();
  document.body.classList.toggle('not-entered', !api.hasEntered());
  menubar.replaceChildren(...[
    h('a', { class: 'logo', href: '#/stories', 'aria-label': '연문회 OS — 이야기 서랍' }, icon('logo', 16), h('span', {}, '연문회 OS')),
    h('button', { type: 'button', onclick: () => app.go('/help') }, '도움말'),
    h('span', { class: 'spacer' }),
    presenceEl,
    api.hasEntered()
      ? ident
        ? [h('span', {}, `${ident.name} 님`), h('button', { type: 'button', onclick: logout }, '로그아웃')]
        : [h('span', { class: 'muted' }, '손님'), h('button', { type: 'button', onclick: () => app.requireLogin('', currentRoute()) }, '로그인')]
      : null,
    h('button', { type: 'button', 'aria-pressed': String(app.crt), title: '화면 효과', onclick: () => app.setCrt(!app.crt) }, `CRT ${app.crt ? '켬' : '끔'}`),
    clockEl].flat().filter(Boolean));
}

function logout() {
  api.logout();
  renderMenubar();
  forEachView(v => v.onFocus?.());
  showLogin();
}

function renderNav() {
  iconsNav.replaceChildren(...NAV.map(n =>
    h('a', { class: 'icon', href: `#${n.route}`, dataset: { route: n.route } }, icon(n.icon, 40), h('span', {}, n.label))));
  dock.replaceChildren(...NAV.map(n =>
    h('a', { href: `#${n.route}`, dataset: { route: n.route } }, icon(n.icon, 22), h('span', {}, n.short))));
}

// ------------------------------------------------------------ settings + presence

async function loadSettings() {
  try {
    app.settings = await api.getSettings();
    forEachView(v => v.onSettings?.());
  } catch { /* views fall back to defaults */ }
}

api.presence((n) => {
  presenceCount = n;
  presenceEl.hidden = false;
  presenceEl.textContent = `접속 중 ${n}명`;
});

// ------------------------------------------------------------ start

document.body.classList.toggle('crt', app.crt);
renderMenubar();
renderNav();
loadSettings();
api.watch(['settings'], loadSettings);

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
