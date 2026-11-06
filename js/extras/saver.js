// 화면 보호기: 3분 이어 쓰는 화면 → 6분 별 헤는 밤 → 10분 고양이 낮잠 (minutes set by the admin).
// Never while someone here holds a baton, a dialog is open or the admin window is in front.
import * as api from '../api.js';
import { h, fmtClock } from '../ui.js';
import { isPhone } from '../wm.js';
import { on, X, bus, reduceMotion } from './extras.js';
import { catImg } from './cat.js';
import { play, soundOn } from './sound.js';

const POEM = ['별 하나에 추억과', '별 하나에 사랑과', '별 하나에 쓸쓸함과', '별 하나에 동경과', '별 하나에 시와', '별 하나에 어머니, 어머니,'];
const rand = (a, b) => a + Math.random() * (b - a);

export function initSaver(app, wm, cat) {
  let last = Date.now();
  let overlay = null, stage = null;          // stage: 'typing' | 'stars'
  let catSleeping = false;
  let loops = [];
  let pool = null, poolAt = 0;

  const stop = () => { loops.forEach(t => { clearTimeout(t); clearInterval(t); }); loops = []; };
  // one-shot timers forget themselves when they fire, so a screen saver left on all night keeps no backlog
  const after = (fn, ms) => { const t = setTimeout(() => { loops = loops.filter(x => x !== t); fn(); }, ms); loops.push(t); };

  function blocked() {
    if (document.hidden || !api.hasEntered()) return true;
    if (api.prefs.get('saver') === '0') return true;
    if (isPhone() && !on('saver_phone')) return true;
    if (document.querySelector('.modal, [data-countdown="mine"]')) return true;
    const t = wm.active?.view.type ?? '';
    if (t.startsWith('admin') || t === 'login' || t === 'reading') return true;
    return false;
  }

  function activity(e) {
    last = Date.now();
    if (!overlay) return;
    // the key / click that wakes the screen is swallowed so nothing gets pressed by accident
    if (e && (e.type === 'pointerdown' || e.type === 'keydown' || e.type === 'touchstart')) {
      e.preventDefault(); e.stopPropagation();
      const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, { capture: true }), 400);
    }
    wake();
  }
  // Only a click / tap or a key press wakes the screen; moving the mouse or scrolling over it
  // doesn't, so people can sit and watch it. (Without a saver, any of them counts as activity.)
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, activity, { capture: true });
  const stir = () => { if (!overlay) last = Date.now(); };
  // scrolling must stay passive (no scroll jank on phones)
  for (const ev of ['wheel', 'touchstart']) addEventListener(ev, stir, { capture: true, passive: true });
  addEventListener('pointermove', (e) => { if (e.movementX || e.movementY) stir(); }, { capture: true, passive: true });
  bus.on('activity', () => { last = Date.now(); });
  bus.on('saver-now', () => { last = Date.now() - (X('saver_typing_min') ?? 3) * 60e3; setTimeout(check, 50); });

  function check() {
    if (blocked()) { if (!overlay) last = Math.max(last, Date.now() - 1000); return; }
    const idle = (Date.now() - last) / 60e3;
    const tMin = on('saver_typing') ? X('saver_typing_min') : Infinity;
    const sMin = on('saver_stars') ? X('saver_stars_min') : Infinity;
    const cMin = on('cat_sleep') && on('cat') ? X('cat_sleep_min') : Infinity;
    const want = idle >= sMin ? 'stars' : idle >= tMin ? 'typing' : null;
    if (want && want !== stage) show(want);
    if (idle >= cMin && !catSleeping) sleepCat();
  }
  setInterval(check, 5000);

  function frame() {
    if (!overlay) {
      overlay = h('div', { class: 'saver', role: 'presentation' });
      document.body.append(overlay);
      cat?.hide();
      const o = overlay;                       // (woken within the same frame: overlay is already gone)
      requestAnimationFrame(() => o.classList.add('on'));
    }
    return overlay;
  }

  function show(kind) {
    stop();
    stage = kind;
    const o = frame();
    const clock = h('div', { class: 'saver-clock' }, fmtClock());
    loops.push(setInterval(() => { clock.textContent = fmtClock(); }, 20e3));
    const hint = h('div', { class: 'saver-hint' }, isPhone() ? '화면을 누르면 돌아가요' : '클릭하거나 아무 키나 누르면 돌아가요');
    o.dataset.kind = kind;
    o.replaceChildren(clock, hint);
    if (kind === 'typing') typing(o); else stars(o);
    if (catSleeping) { catSleeping = false; sleepCat(); }
  }

  // ---------------------------------------------------------- A · 이어 쓰는 화면
  async function pickLine() {
    if (!pool || Date.now() - poolAt > 5 * 60e3) {
      try {
        const list = await api.listStories();
        pool = list.filter(s => (on('saver_completed_only') ? s.status === 'completed' : true) && s.line_count > 0);
        poolAt = Date.now();
      } catch { pool = []; }
    }
    if (!pool.length) return null;
    const s = pool[Math.floor(Math.random() * pool.length)];
    try {
      const full = await api.getStory(s.id);
      const lines = full.lines.filter(l => !l.removed);
      const l = lines[Math.floor(Math.random() * lines.length)];
      return l ? { text: l.text, meta: `— 「${full.title || '제목 없는 이야기'}」 ${l.position}번째 줄` } : null;
    } catch { return null; }
  }
  function typing(o) {
    const box = h('div', { class: 'saver-type' });
    o.append(box);
    const next = async () => {
      if (stage !== 'typing') return;
      const pick = await pickLine() ?? { text: '이야기가 완결되면 여기에 한 줄씩 나타나요.', meta: '— 연문회 OS' };
      if (stage !== 'typing') return;
      const text = h('span', { class: 'saver-text' });
      const caret = h('span', { class: 'saver-caret' });
      const meta = h('div', { class: 'saver-meta', hidden: true }, pick.meta);
      box.replaceChildren(h('div', {}, text, caret), meta);
      box.style.left = `${rand(6, 42)}%`; box.style.top = `${rand(14, 66)}%`;
      box.classList.remove('fade');
      const chars = [...pick.text];
      let i = 0;
      const t = setInterval(() => {
        if (i >= chars.length) {
          clearInterval(t); loops = loops.filter(x => x !== t); meta.hidden = false;
          after(() => { box.classList.add('fade'); after(next, 900); }, 4500);
          return;
        }
        text.textContent += chars[i++];
        if (on('saver_typewriter') && soundOn()) play('key', { ch: chars[i - 1] });
      }, reduceMotion() ? 20 : 95);
      loops.push(t);
    };
    next();
  }

  // ---------------------------------------------------------- B · 별 헤는 밤
  function hillPath() {
    let d = 'M0 30';
    for (let x = 0; x < 180; x += 3) {
      const hh = 14 + Math.round(7 * Math.sin(x / 34) + 4 * Math.sin(x / 11 + 1.3));
      d += ` V${30 - hh} H${x + 3}`;
    }
    return d + ' V30 Z';
  }
  function stars(o) {
    const sky = h('div', { class: 'saver-sky' });
    const n = isPhone() ? 40 : 110;
    for (let i = 0; i < n; i++) {
      const big = Math.random() < 0.22;
      sky.append(h('i', { class: `st${big ? ' big' : ''}${Math.random() < 0.2 ? ' warm' : ''}`,
        style: `left:${rand(0, 100)}%;top:${rand(0, 70)}%;animation-duration:${rand(2, 5).toFixed(1)}s;animation-delay:${rand(0, 3).toFixed(1)}s` }));
    }
    const poem = h('div', { class: 'saver-poem' });
    const hill = h('div', { class: 'saver-hill' });
    hill.innerHTML = `<svg viewBox="0 0 180 30" preserveAspectRatio="none" shape-rendering="crispEdges" width="100%" height="100%"><path d="${hillPath()}" fill="#2B3A5C"/></svg>`;
    const credit = h('div', { class: 'saver-credit' }, '윤동주, 「별 헤는 밤」에서');
    const perch = h('div', { class: 'saver-cat' });
    if (on('cat')) perch.append(catImg('sit', { pal: 'night' }));
    o.append(sky, poem, hill, perch, credit);
    let i = 0;
    const line = () => {
      if (stage !== 'stars') return;
      poem.replaceChildren(h('span', {}, POEM[i % POEM.length]));
      sky.append(h('i', { class: 'st big new', style: `left:${rand(8, 92)}%;top:${rand(6, 55)}%` }));
      const big = sky.querySelectorAll('.st.big');                       // keep the sky from filling up overnight
      for (let k = 0; k < big.length - 24; k++) big[k].remove();
      i++;
    };
    line();
    loops.push(setInterval(line, 3000));
  }

  // ---------------------------------------------------------- 고양이 낮잠
  function sleepCat() {
    if (!overlay || !on('cat')) { catSleeping = true; return; }
    catSleeping = true;
    const perch = overlay.querySelector('.saver-cat');
    const nap = h('div', { class: 'saver-nap' }, catImg('sleep', { pal: 'night' }), h('span', { class: 'zz' }, 'z'), h('span', { class: 'zz z2' }, 'z'));
    if (perch) { perch.replaceChildren(nap); return; }
    const walker = h('div', { class: 'saver-cat walk-in' }, nap);
    overlay.append(walker);
  }

  function wake() {
    if (!overlay) return;
    stop();
    const o = overlay;
    overlay = null; stage = null;
    o.classList.remove('on');
    setTimeout(() => o.remove(), 250);
    const slept = catSleeping;
    catSleeping = false;
    cat?.show();
    if (slept) setTimeout(() => cat?.el && cat.el.dispatchEvent(new CustomEvent('yawn')), 300);
  }

  return { wake, check };
}
