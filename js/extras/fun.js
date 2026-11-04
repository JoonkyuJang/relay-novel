// 숨은 재미 (not in 도움말 on purpose). Each one has its own switch in 관리 · 부가 기능.
import { h } from '../ui.js';
import { prefs } from '../api.js';
import { isPhone } from '../wm.js';
import { fun, bus, kst, reduceMotion } from './extras.js';
import { play } from './sound.js';
import { applySky } from './daynight.js';

const EAGLE = '<svg viewBox="0 0 14 7" width="84" height="42" shape-rendering="crispEdges" aria-hidden="true"><path fill="#1D2A44" d="M0 0h1v1H0zM13 0h1v1h-1zM1 1h2v1H1zM11 1h2v1h-2zM2 2h3v1H2zM9 2h3v1H9zM4 3h6v1H4zM5 4h4v1H5zM6 5h2v1H6z"/><path fill="#D9774F" d="M10 3h1v1h-1z"/></svg>';

export function initFun(app, wm, { cat, clockEl }) {
  // ---------------------------------------------------------- 호박색 단말기
  const AMBER = ['KeyG', 'KeyH', 'KeyQ', 'KeyK', 'KeyR'];        // ㅎ ㅗ ㅂ ㅏ ㄱ on a 두벌식 keyboard
  let seq = [];
  function setAmber(v, { toast = true } = {}) {
    document.body.classList.toggle('amber', v);
    prefs.set('amber', v ? '1' : null);
    applySky();
    bus.emit('theme', {});
    if (toast && v) amberToast();
    else document.querySelector('.amber-toast')?.remove();
  }
  function amberToast() {
    document.querySelector('.amber-toast')?.remove();
    const t = h('div', { class: 'amber-toast win is-active', role: 'status' },
      h('div', { class: 'win-title' }, h('span', { class: 'win-title-pad' }), h('h2', {}, '알림'), h('span', { class: 'win-title-pad' })),
      h('div', { class: 'amber-toast-body' },
        h('span', {}, '호박색 단말기 모드', h('span', { class: 'blink-caret' }, '_')),
        h('span', { class: 'muted' }, isPhone() ? '로고를 다섯 번 누르면 돌아가요' : '다시 "호박"을 치면 돌아가요'),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => setAmber(false) }, '돌아가기')));
    document.body.append(t);
    setTimeout(() => t.remove(), 9000);
  }
  if (prefs.get('amber') === '1' && fun('fun_amber')) setAmber(true, { toast: false });
  addEventListener('keydown', (e) => {
    if (!fun('fun_amber') || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    seq = [...seq, e.code].slice(-AMBER.length);
    if (seq.join() === AMBER.join()) { seq = []; play('boot'); setAmber(!document.body.classList.contains('amber')); }
  });
  let taps = [];
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('.menubar .logo') || !fun('fun_amber') || !isPhone()) return;
    taps = [...taps.filter(t => Date.now() - t < 2500), Date.now()];
    if (taps.length >= 5) { e.preventDefault(); taps = []; setAmber(!document.body.classList.contains('amber')); }
  });
  bus.on('settings', () => { if (!fun('fun_amber') && document.body.classList.contains('amber')) setAmber(false, { toast: false }); });

  // ---------------------------------------------------------- 방명록에 "야옹" / "독수리"
  bus.on('guestbook-posted', ({ text }) => {
    if (/야옹/.test(text) && fun('fun_meow')) cat?.run();
    if (/독수리/.test(text)) eagle();
  });
  bus.on('line-added', ({ line }) => { if (/독수리/.test(line?.text ?? '')) eagle(); });

  // ---------------------------------------------------------- 독수리: an eagle flies over, the cat hisses
  let eagleAt = 0;
  function eagle() {
    if (!fun('fun_eagle') || Date.now() - eagleAt < 20e3) return;
    eagleAt = Date.now();
    const bird = h('div', { class: 'eagle' });
    bird.innerHTML = EAGLE;
    document.body.append(bird);
    setTimeout(() => cat?.hiss(), 700);
    setTimeout(() => bird.remove(), 4200);
  }
  bus.on('memo-word', ({ word }) => { if (/독수리/.test(word)) eagle(); });

  // ---------------------------------------------------------- 휴지통 와르르
  bus.on('trash-dblclick', ({ el }) => {
    if (!fun('fun_trash')) return;
    play('paper');
    el.classList.remove('tipping'); void el.offsetWidth; el.classList.add('tipping');
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 9; i++) {
      const b = h('i', { class: 'paper-ball', style: `left:${r.left + r.width / 2}px;top:${r.top + 18}px;--dx:${-40 - Math.random() * 220}px;--dy:${60 + Math.random() * 90}px;--r:${Math.round(Math.random() * 360)}deg;animation-delay:${i * 40}ms` });
      document.body.append(b);
      setTimeout(() => b.remove(), 3200);
    }
    setTimeout(() => el.classList.remove('tipping'), 1600);
  });

  // ---------------------------------------------------------- 시계 열 번: 원고지 시간
  let clicks = [];
  clockEl?.addEventListener('click', () => {
    if (!fun('fun_clock')) return;
    clicks = [...clicks.filter(t => Date.now() - t < 4000), Date.now()];
    if (clicks.length < 10) return;
    clicks = [];
    const { h: hr, min } = kst();
    const txt = `${hr < 12 ? '오전' : '오후'}${hr % 12 || 12}시${String(min).padStart(2, '0')}분`;
    const grid = h('span', { class: 'clock-grid', 'aria-label': txt }, [...txt].map(c => h('i', {}, c)));
    const keep = [...clockEl.childNodes];
    clockEl.replaceChildren(grid);
    play('ding');
    setTimeout(() => { if (clockEl.contains(grid)) clockEl.replaceChildren(...keep); }, 6000);
  });

  // ---------------------------------------------------------- 메모장: "/정리", "서시"
  bus.on('memo-command', ({ cmd }) => {
    if (cmd === '/정리' && fun('fun_tidy')) { wm.tidy(); play('pop'); }
  });
  let starsAt = 0;
  bus.on('memo-word', ({ word }) => {
    if (!/서시|윤동주/.test(word) || !fun('fun_seosi') || Date.now() - starsAt < 30e3) return;
    starsAt = Date.now();
    const sky = h('div', { class: 'star-fall', 'aria-hidden': 'true' },
      h('div', { class: 'star-fall-text' }, '죽는 날까지 하늘을 우러러', h('br'), '한 점 부끄럼이 없기를,'));
    for (let i = 0; i < (reduceMotion() ? 0 : 36); i++) {
      sky.append(h('i', { style: `left:${Math.random() * 100}%;animation-delay:${(Math.random() * 2.5).toFixed(2)}s;animation-duration:${(2 + Math.random() * 2).toFixed(2)}s` }));
    }
    document.body.append(sky);
    play('chime');
    setTimeout(() => sky.remove(), 6500);
  });

  // ---------------------------------------------------------- 낮잠 자던 고양이의 낭독
  bus.on('story-completed', ({ el, lastLine }) => {
    if (!fun('fun_catreads') || !cat || !lastLine) return;
    if (cat.napWin?.el === el) setTimeout(() => cat.readLine(lastLine), 1300);
  });
}
