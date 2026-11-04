// Tiny synthesizer (WebAudio, no files): typewriter keys, bell, chime, meow, beep voice.
// Off by default per device; the admin can disable sound for everyone.
import { prefs } from '../api.js';
import { on, X, bus } from './extras.js';

let ctx = null;
let master = null;

function audio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);
  return ctx;
}
// Browsers only start audio after a user gesture.
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  addEventListener(ev, () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); }, { capture: true, passive: true });
}

export function soundOn() {
  if (!on('sound')) return false;
  const p = prefs.get('sound');
  return p == null ? !!X('sound_default') : p === '1';
}
export function setSound(v) { prefs.set('sound', v ? '1' : '0'); bus.emit('sound', { on: v }); }

function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function tone(freq, t, { type = 'square', a = 0.004, d = 0.08, peak = 0.3, glide = null, dest = master } = {}) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + a + d);
  env(g, t, a, peak, d);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + a + d + 0.02);
}
let noiseBuf = null;
function noise(t, { d = 0.03, f = 2200, q = 1.2, peak = 0.4, type = 'bandpass' } = {}) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; fl.type = type; fl.frequency.value = f; fl.Q.value = q;
  env(g, t, 0.002, peak, d);
  s.connect(fl).connect(g).connect(master);
  s.start(t, Math.random() * 0.4); s.stop(t + d + 0.03);
}

// Hangul vowel → pitch ratio (ㅏ·ㅑ·ㅣ high, ㅜ·ㅠ·ㅡ low): makes the "베베베세" robot voice.
const VOWEL = [1.25, 1.18, 1.3, 1.2, 1.0, 1.08, 1.05, 1.1, 0.9, 1.0, 1.02, 0.98, 0.95, 0.78, 0.85, 0.9, 1.15, 0.8, 0.86, 0.92, 1.35];
export function charRatio(ch) {
  const c = ch.codePointAt(0) - 0xAC00;
  if (c >= 0 && c < 11172) return VOWEL[Math.floor((c % 588) / 28)];
  if (/[a-z0-9]/i.test(ch)) return 1.1;
  return 0;     // spaces / punctuation: silent
}
export function voiceBase(seed = '') {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return 260 + (h % 9) * 22;              // a few distinct voices
}

const PLAYERS = {
  key(t) { noise(t, { d: 0.025, f: 1800 + Math.random() * 900, peak: 0.35 }); tone(140, t, { type: 'triangle', d: 0.02, peak: 0.08 }); },
  bell(t) { tone(1568, t, { type: 'sine', a: 0.002, d: 0.9, peak: 0.25 }); tone(2093, t, { type: 'sine', a: 0.002, d: 0.6, peak: 0.12 }); },
  boot(t) { [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.09, { d: 0.12, peak: 0.12 })); },
  chime(t) { [784, 988, 1175, 1568].forEach((f, i) => tone(f, t + i * 0.11, { type: 'triangle', d: 0.35, peak: 0.18 })); },
  stamp(t) { tone(110, t, { type: 'sine', a: 0.002, d: 0.12, peak: 0.5, glide: 60 }); noise(t, { d: 0.04, f: 900, peak: 0.25 }); },
  meow(t) {                                  // "야-옹" in beeps
    tone(620, t, { d: 0.09, peak: 0.16, glide: 760 });
    tone(760, t + 0.11, { d: 0.18, peak: 0.16, glide: 480 });
  },
  purr(t) { for (let i = 0; i < 6; i++) tone(70 + (i % 2) * 8, t + i * 0.07, { type: 'sawtooth', d: 0.06, peak: 0.05 }); },
  hiss(t) { noise(t, { d: 0.45, f: 5200, q: 0.6, peak: 0.3, type: 'highpass' }); },
  paper(t) { for (let i = 0; i < 7; i++) noise(t + i * 0.035 + Math.random() * 0.02, { d: 0.02, f: 3000 + Math.random() * 2000, peak: 0.25 }); },
  pop(t) { tone(880, t, { type: 'sine', d: 0.06, peak: 0.15, glide: 1320 }); },
  ding(t) { tone(1320, t, { type: 'sine', a: 0.002, d: 0.4, peak: 0.2 }); tone(1760, t + 0.12, { type: 'sine', a: 0.002, d: 0.5, peak: 0.15 }); },
};

export function play(name, { force = false } = {}) {
  if (!force && !soundOn()) return;
  if (!audio() || ctx.state !== 'running' && ctx.state !== 'suspended') return;
  try { PLAYERS[name]?.(ctx.currentTime + 0.01); } catch { /* ignore */ }
}

// One beep for one character of the 낭독회 voice. Returns true if it made a sound.
export function blip(ch, base, { force = false } = {}) {
  if (!force && !soundOn()) return false;
  const r = charRatio(ch);
  if (!r || !audio()) return false;
  tone(base * r, ctx.currentTime + 0.005, { d: 0.05, peak: 0.13 });
  return true;
}
