// Sound on the site: gating (admin switch + per-device choice) around the synth in synth.js.
// Off by default per device; the admin can disable sound for everyone.
import { prefs } from '../api.js';
import { on, X, bus } from './extras.js';
import { h } from '../ui.js';
import { makeSynth, speakerFor, voicePlan } from './synth.js';

let synth = null;
const DEBUG = prefs.get('debugSounds') === '1';
function engine() {
  if (synth) return synth;
  // browsers refuse to start audio before the first click / key on the page: don't even try
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { synth = makeSynth(new AC()); } catch { return null; }
  return synth;
}
// Browsers only start audio after a user gesture.
// (Only matters before the first sound has played; after that wake() resumes on demand.)
let unlocked = false;
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'touchend', 'click']) {   // (iOS only trusts some of them)
  addEventListener(ev, () => {
    if (unlocked || !synth) return;
    if (synth.ac.state === 'running') { unlocked = true; return; }
    synth.ac.resume().then(() => { unlocked = true; wake(); }).catch(() => {});
  }, { capture: true, passive: true });
}

export function soundOn() {
  if (!on('sound')) return false;
  const p = prefs.get('sound');
  return p == null ? !!X('sound_default') : p === '1';
}
export function setSound(v) { prefs.set('sound', v ? '1' : '0'); bus.emit('sound', { on: v }); }

// Left alone for a long time (5 minutes past the last screen saver), the site turns its sound off,
// so a tab forgotten overnight never chatters on. Coming back shows a small note to turn it on again.
let dozing = false, lastHere = Date.now(), dozedOff = false;
const here = () => {
  lastHere = Date.now();
  if (!dozing) return;
  dozing = false;
  if (dozedOff) { dozedOff = false; dozeNote(); }
};
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, here, { capture: true, passive: true });
addEventListener('pointermove', (e) => { if (e.movementX || e.movementY) here(); }, { capture: true, passive: true });
export function quietAfterMin() {
  const savers = [on('saver_typing') && X('saver_typing_min'), on('saver_stars') && X('saver_stars_min'),
    on('cat_sleep') && on('cat') && X('cat_sleep_min')].filter(m => Number(m) > 0).map(Number);
  return (savers.length ? Math.max(...savers) : 10) + 5;
}
setInterval(() => {
  if (dozing || Date.now() - lastHere < quietAfterMin() * 60e3) return;
  dozing = true;                                   // even forced sounds (낭독회) stop
  if (soundOn()) { dozedOff = true; setSound(false); }
  if (synth?.ac.state === 'running') synth.ac.suspend().catch(() => {});
}, 20e3);
function dozeNote() {
  document.querySelector('.doze-note')?.remove();
  const note = h('div', { class: 'doze-note', role: 'status' },
    h('span', {}, '오래 자리를 비워서 소리를 껐어요.'),
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { setSound(true); play('pop'); note.remove(); } }, '다시 켜기'),
    h('button', { type: 'button', class: 'btn-link', 'aria-label': '닫기', onclick: () => note.remove() }, '닫기'));
  document.body.append(note);
  setTimeout(() => note.remove(), 12e3);
}

// play('key', { ch: 'a' }), play('chime', { force: true }) …
const lastAt = {};
export function play(name, { force = false, ...opts } = {}) {
  // dozing silences everything except 자리 났어요, which someone asked for and is waiting on
  if ((dozing && name !== 'ding') || (!force && !soundOn())) return;
  if (document.hidden && name !== 'ding') return;            // a background tab stays quiet (except 자리 났어요)
  // the same interface sound twice within 90 ms (closing every window at log-out…) plays once
  if (UI.has(name)) { if (performance.now() - (lastAt[name] ?? -1e9) < 90) return; lastAt[name] = performance.now(); }
  if (DEBUG) (window.__rnSounds ??= []).push(name);           // tests: which sounds were asked for
  const s = wake();
  if (!s) return;
  try { s.play(name, s.ac.currentTime + 0.01, opts); } catch { /* ignore */ }
}

// Park the audio engine (reverb, echo, compressor) a few seconds after the last sound,
// so an idle tab costs nothing; wake it for the next one.
let idleT = null;
function wake() {
  const s = engine();
  if (!s || s.ac.state === 'closed') return null;
  if (s.ac.state === 'suspended') s.ac.resume().catch(() => {});
  clearTimeout(idleT);
  idleT = setTimeout(() => { if (s.ac.state === 'running') s.ac.suspend().catch(() => {}); }, 4000);
  return s;
}
document.addEventListener('visibilitychange', () => { if (document.hidden && synth?.ac.state === 'running') synth.ac.suspend().catch(() => {}); });

// The 낭독회 voice for one line: voice(text, seed).say(i) sounds the i-th character
// (spaces and punctuation are silent; the whole line carries Korean phrase intonation).
export function voice(text, seed, { pitch = 1 } = {}) {
  const sp = speakerFor(seed, { pitch });
  const plan = voicePlan(text, sp);
  return {
    say(i, { force = false, rate = 1 } = {}) {
      if (!plan[i] || dozing || document.hidden || (!force && !soundOn())) return false;
      const s = wake();
      if (!s) return false;
      try { s.speak(s.ac.currentTime + 0.005, plan[i], sp, rate); } catch { /* ignore */ }
      return true;
    },
  };
}

// Interface sounds from modules that shouldn't import this one (wm.js, ui.js):
//   dispatchEvent(new CustomEvent('rn-sound', { detail: 'open' }))
const UI = new Set(['open', 'close', 'minimize', 'restore', 'menu', 'select', 'alert', 'error']);
addEventListener('rn-sound', (e) => { if (UI.has(e.detail)) play(e.detail); });

// The typewriter key for every text field on the site (stories, 방명록, 메모장, 새 이야기, …).
// Never for passwords.
let lastKey = 0;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t?.matches?.('textarea, input:not([type]), input[type="text"], input[type="search"]')) return;
  if (Date.now() - lastKey < 40) return;
  lastKey = Date.now();
  play('key', { ch: e.inputType?.startsWith('delete') ? '\b' : e.data?.slice(-1) });
}, true);
