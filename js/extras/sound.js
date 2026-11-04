// Sound on the site: gating (admin switch + per-device choice) around the synth in synth.js.
// Off by default per device; the admin can disable sound for everyone.
import { prefs } from '../api.js';
import { on, X, bus } from './extras.js';
import { makeSynth, speakerFor, voicePlan } from './synth.js';

let synth = null;
function engine() {
  if (synth) return synth;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { synth = makeSynth(new AC()); } catch { return null; }
  return synth;
}
// Browsers only start audio after a user gesture.
// (Only matters before the first sound has played; after that wake() resumes on demand.)
let unlocked = false;
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
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

// play('key', { ch: 'a' }), play('chime', { force: true }) …
export function play(name, { force = false, ...opts } = {}) {
  if (!force && !soundOn()) return;
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
      if (!plan[i] || (!force && !soundOn())) return false;
      const s = wake();
      if (!s) return false;
      try { s.speak(s.ac.currentTime + 0.005, plan[i], sp, rate); } catch { /* ignore */ }
      return true;
    },
  };
}
