// 연문회 OS sound chip: every sound is synthesized with WebAudio (no files), in one retro palette.
// No imports, no globals: makeSynth(ac) works on a live AudioContext or an OfflineAudioContext,
// so the same code runs on the site, in tests (offline renders) and on the sound board.
//
// The palette (like an old computer / handheld sound chip):
//   pulse   square-ish wave with a duty cycle of 12.5 %, 25 % or 50 % (thin → hollow)
//   tri     triangle wave (bass, soft hums)
//   noise   15-bit LFSR noise ("long" hiss or "short" metallic buzz), pitched by its clock rate
// Pitch and volume move in 1/60 s frames (stepped, not smooth) and notes sit on semitones.
// A small speaker low-pass and a short echo are shared by everything. Two exceptions: the
// typewriter keys stay a physical "tick-tock" (they repeat so often), and the 낭독회 voice is a
// smooth formant voice (it reads whole lines, so it should sound like speech).

const FR = 1 / 60;                                   // one frame

export function makeSynth(ac, { volume = 0.55 } = {}) {
  // ---------------------------------------------------------- output chain
  const master = ac.createGain();
  master.gain.value = volume;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 3.5;
  comp.attack.value = 0.002; comp.release.value = 0.16;
  const speaker = ac.createBiquadFilter();           // little speaker: no fizz above ~7 kHz
  speaker.type = 'lowpass'; speaker.frequency.value = 7200; speaker.Q.value = 0.5;
  const bus = ac.createGain();
  bus.connect(speaker).connect(comp).connect(master).connect(ac.destination);

  // echo: 110 ms, two or three soft repeats, darker each time
  const echoIn = ac.createGain();
  const dl = ac.createDelay(1); dl.delayTime.value = 0.11;
  const fb = ac.createGain(); fb.gain.value = 0.32;
  const dark = ac.createBiquadFilter(); dark.type = 'lowpass'; dark.frequency.value = 2800;
  echoIn.connect(dl); dl.connect(dark).connect(fb).connect(dl); dark.connect(bus);

  function out(echo = 0) {
    const g = ac.createGain();
    g.gain.value = 0;
    g.connect(bus);
    if (echo > 0) { const s = ac.createGain(); s.gain.value = echo; g.connect(s).connect(echoIn); }
    return g;
  }

  // ---------------------------------------------------------- waves
  const pulses = {};
  function pulse(duty) {                              // band-limited pulse via a periodic wave
    if (pulses[duty]) return pulses[duty];
    const N = 48, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      re[n] = Math.sin(2 * Math.PI * n * duty) / (n * Math.PI);
      im[n] = (1 - Math.cos(2 * Math.PI * n * duty)) / (n * Math.PI);
    }
    return (pulses[duty] = ac.createPeriodicWave(re, im));
  }
  const lfsr = {};
  function noiseBuf(short) {                         // 1 LFSR step per sample; pitch = playbackRate
    const k = short ? 's' : 'l';
    if (lfsr[k]) return lfsr[k];
    const len = short ? 93 * 64 : 32767;
    const b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
    let r = 1;
    for (let i = 0; i < len; i++) {
      const bit = (r ^ (r >> (short ? 6 : 1))) & 1;
      r = (r >> 1) | (bit << 14);
      d[i] = r & 1 ? 1 : -1;
    }
    return (lfsr[k] = b);
  }

  const at = (arr, i) => Array.isArray(arr) ? arr[Math.min(i, arr.length - 1)] : arr;
  const hz = (base, semis) => base * Math.pow(2, semis / 12);

  // One chip voice. pitch: semitones per frame (relative to `base` Hz); vol: 0..1 per frame;
  // duty: per frame (0.125 / 0.25 / 0.5) or one value; wave: 'pulse' | 'tri'.
  function chip(t, { base, pitch = [0], vol = [1], duty = 0.5, wave = 'pulse', peak = 0.2, echo = 0, frame = FR, lp = 0 }) {
    const n = Math.max(pitch.length, vol.length, Array.isArray(duty) ? duty.length : 1);
    const end = t + n * frame;
    const g = out(echo);
    let tail = g;
    if (lp) { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.6; f.connect(g); tail = f; }
    const duties = wave === 'tri' ? ['tri'] : [...new Set(Array.isArray(duty) ? duty : [duty])];
    for (const dk of duties) {
      const o = ac.createOscillator();
      if (dk === 'tri') o.type = 'triangle'; else o.setPeriodicWave(pulse(dk));
      const dg = ac.createGain(); dg.gain.value = 0;
      for (let i = 0; i < n; i++) {
        const tt = t + i * frame;
        o.frequency.setValueAtTime(hz(base, at(pitch, i)), tt);
        const on = dk === 'tri' || at(duty, i) === dk;
        dg.gain.setValueAtTime(on ? at(vol, i) * peak : 0, tt);
      }
      dg.gain.setValueAtTime(0, end);
      o.connect(dg).connect(tail);
      o.start(t); o.stop(end + 0.02);
    }
    g.gain.setValueAtTime(1, t);
    return end;
  }
  // Noise channel. rate: LFSR clock in Hz per frame (high = hiss, low = rumble); vol per frame.
  function noise(t, { rate = 20000, vol = [1], short = false, peak = 0.2, echo = 0, frame = FR, lp = 0, hp = 0, smooth = false }) {
    const n = Math.max(Array.isArray(rate) ? rate.length : 1, vol.length);
    const end = t + n * frame;
    const s = ac.createBufferSource();
    s.buffer = noiseBuf(short); s.loop = true;
    const g = out(echo);
    let node = s;
    if (hp) { const f = ac.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; node = node.connect(f); }
    if (lp) { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node = node.connect(f); }
    node.connect(g);
    for (let i = 0; i < n; i++) {
      const tt = t + i * frame;
      s.playbackRate.setValueAtTime(Math.max(0.001, Math.min(1, at(rate, i) / ac.sampleRate)), tt);
      const v = at(rate, i) ? at(vol, i) * peak : 0;
      if (smooth) g.gain.linearRampToValueAtTime(v, tt); else g.gain.setValueAtTime(v, tt);
    }
    g.gain.setValueAtTime(0, end);
    s.start(t, Math.random() * 0.3); s.stop(end + 0.02);
    return end;
  }
  // stepped decay: n frames from `from` down to 0 in 1/15 steps (chip volume)
  const decay = (n, from = 1) => Array.from({ length: n }, (_, i) => Math.round(15 * from * (1 - i / n)) / 15);

  // ---------------------------------------------------------- the typewriter key (physical, steady)
  function hit(t, { type = 'bandpass', f = 2000, q = 1, d = 0.02, peak = 0.3 }) {
    const g = out(), fl = ac.createBiquadFilter();
    fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const s = ac.createBufferSource(); s.buffer = whiteBuf(); s.loop = true;
    s.connect(fl).connect(g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.0008 + d);
    s.start(t, Math.random() * 0.5); s.stop(t + d + 0.03);
  }
  let white = null;
  function whiteBuf() {
    if (white) return white;
    white = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = white.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return white;
  }
  function thump(t, { f = 150, to = 70, d = 0.06, peak = 0.3 }) {
    const g = out(), o = ac.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(to, t + d);
    o.connect(g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.start(t); o.stop(t + d + 0.03);
  }
  let keyN = 0;

  // ---------------------------------------------------------- the sounds
  const B = 523.25;                                   // C5: everything musical is in C major
  const C = (st) => hz(B, st);
  const P = {
    // typewriter key: tick + tock + small thump. Only tiny variation (three alternating tocks).
    key(t, { ch } = {}) {
      const space = ch === ' ', back = ch === '\b';
      const tock = space ? 950 : back ? 1350 : [2000, 2060, 1960][keyN++ % 3];
      hit(t, { type: 'highpass', f: 3800, d: 0.003, peak: 0.55 });
      hit(t + 0.0015, { f: tock, q: 14, d: space ? 0.05 : 0.032, peak: 0.62 });
      thump(t, { f: space ? 120 : 170, to: space ? 55 : 90, d: space ? 0.07 : 0.035, peak: space ? 0.3 : 0.15 });
      if (!back) hit(t + 0.065, { type: 'highpass', f: 3000, d: 0.002, peak: 0.07 });
    },
    // line accepted: a chip "ding" (A6 + E7), then the carriage ratchets back in noise clicks
    bell(t) {
      chip(t, { base: 1760, vol: decay(40), duty: 0.125, peak: 0.13, echo: 0.25 });
      chip(t, { base: 2637, vol: decay(14, 0.6), duty: 0.25, peak: 0.07 });
      let tt = t + 0.3;
      for (let i = 0; i < 8; i++) { noise(tt, { rate: 30000, vol: [1, 0.3], short: true, peak: 0.1, frame: FR / 3 }); tt += (2.6 - i * 0.15) * FR; }
      noise(tt + 0.02, { rate: [6000, 3000, 1500], vol: [1, 0.6, 0.3], peak: 0.2 });
      chip(tt + 0.02, { base: 110, pitch: [0, -5, -12], vol: [1, 0.6, 0.3], wave: 'tri', peak: 0.3 });
    },
    // a free spot: two-note chip doorbell E6 → C6
    ding(t) {
      chip(t, { base: C(16), vol: decay(14), duty: 0.25, peak: 0.16, echo: 0.3 });
      chip(t + 14 * FR, { base: C(12), vol: decay(36), duty: 0.25, peak: 0.16, echo: 0.3 });
    },
    // story completed: "stage clear" jingle. lead G5 C6 E6 G6 → C7 with vibrato, harmony, bass.
    chime(t) {
      const lead = [7, 12, 16, 19], f = 5;
      lead.forEach((s, i) => chip(t + i * f * FR, { base: B, pitch: [s], vol: [1, 1, 0.8, 0.7, 0.6], duty: 0.25, peak: 0.13, echo: 0.25 }));
      const hold = t + lead.length * f * FR;
      const vib = Array.from({ length: 48 }, (_, i) => 24 + (i > 10 ? [0, 0.3, 0, -0.3][i % 4] : 0));
      chip(hold, { base: B, pitch: vib, vol: [...Array(10).fill(1), ...decay(38)], duty: [0.25, 0.25, 0.25, 0.5], peak: 0.13, echo: 0.3 });
      chip(hold, { base: B, pitch: [19], vol: [...Array(8).fill(0.8), ...decay(30, 0.8)], duty: 0.125, peak: 0.08 });
      chip(t, { base: 130.81, pitch: [...Array(10).fill(0), ...Array(10).fill(7), ...Array(40).fill(12)], vol: [...Array(20).fill(1), ...decay(40)], wave: 'tri', peak: 0.28 });
    },
    // 호박색 단말기: relay click, a falling hum, then the terminal's ready beeps
    boot(t) {
      noise(t, { rate: [40000, 12000], vol: [1, 0.5], peak: 0.22 });
      chip(t + 2 * FR, { base: 220, pitch: [0, -2, -4, -6, -8, -10, -12, -12, -12, -12, -12, -12, -12, -12], vol: [1, 1, 0.9, 0.8, 0.8, 0.7, 0.6, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1], wave: 'tri', peak: 0.3 });
      chip(t + 20 * FR, { base: C(7), vol: [0, 1, 1, 1, 1, 1, 1, 0], duty: 0.5, peak: 0.1, echo: 0.15 });
      chip(t + 28 * FR, { base: C(12), vol: [1, 1, 1, 1, 1, 1, 1, 1, 0.6, 0.3], duty: 0.5, peak: 0.1, echo: 0.2 });
    },
    // rubber stamp: noise thud + triangle drop
    stamp(t) {
      noise(t, { rate: [9000, 5000, 3000, 2000, 1500, 1200], vol: decay(6), peak: 0.32 });
      chip(t, { base: 220, pitch: [0, -7, -12, -17, -21, -24, -24], vol: [1, 1, 0.9, 0.7, 0.5, 0.3, 0.15], wave: 'tri', peak: 0.42 });
    },
    // stamp taken back: a little rising blip
    unstamp(t) {
      chip(t, { base: C(7), pitch: [0, 5, 12], vol: [0.6, 0.6, 0.4], duty: 0.25, peak: 0.1 });
    },
    // the cat — cute, high, a bit robotic: pulse sweeps that change duty like vowels
    meow(t) {
      const base = C(9 + Math.floor(Math.random() * 3));                 // A5..B5
      if (Math.random() < 0.5) {                                         // "mew"
        chip(t, { base, pitch: [-2, 0, 2, 4, 5, 5.5, 5, 4, 2, 0, -2, -4], vol: [0.5, 0.8, 1, 1, 1, 1, 0.9, 0.8, 0.6, 0.45, 0.3, 0.15],
          duty: [0.125, 0.125, 0.125, 0.25, 0.25, 0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 0.25], peak: 0.17, echo: 0.12, lp: 5500 });
      } else {                                                           // "nya-o"
        const pitch = [-5, -3, 0, 3, 5, 7, 7, 7.5, 7, 7.5, 7, 6, 5, 4, 3, 2, 0, -2, -4, -6, -8];
        chip(t, { base, pitch, vol: [0.5, 0.8, 1, 1, 1, 1, 1, 1, 1, 1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
          duty: [0.125, 0.125, 0.25, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25], peak: 0.17, echo: 0.12, lp: 5500 });
      }
    },
    // jumping: "mrrp!" — a rolled trill that pops up
    mrrp(t) {
      chip(t, { base: C(4), pitch: [0, 0, 0, 0.5, 0.5, 1, 1, 1, 3, 7, 10, 12], vol: [1, 0.2, 1, 0.2, 1, 0.2, 1, 0.2, 1, 1, 0.7, 0.4],
        duty: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.125], peak: 0.17, echo: 0.1 });
    },
    // petting a napping cat: two breaths of a soft purr, gated ~24 Hz
    purr(t) {
      const fr = 1 / 48;                                               // on/off every frame = 24 Hz
      const gate = (n, lvl) => Array.from({ length: n }, (_, i) => (i % 2 ? 0.2 : 1) * lvl * Math.sin(Math.PI * (i + 1) / (n + 1)));
      noise(t, { rate: 1600, vol: gate(30, 0.8), peak: 0.16, frame: fr, lp: 600, smooth: true });
      noise(t + 0.7, { rate: 1800, vol: gate(36, 1), peak: 0.18, frame: fr, lp: 600, smooth: true });
      chip(t, { base: 55, vol: gate(30, 0.6), wave: 'tri', peak: 0.16, frame: fr });
      chip(t + 0.7, { base: 58, vol: gate(36, 0.8), wave: 'tri', peak: 0.16, frame: fr });
    },
    // "하악!": short chip hiss
    hiss(t) {
      noise(t, { rate: [12000, 30000, 30000], vol: [0.6, 1, 1], peak: 0.12, lp: 6000 });
      noise(t + 3 * FR, { rate: 26000, vol: decay(16), peak: 0.12, hp: 1500, lp: 6000 });
    },
    // "하암~": sleepy, slow slide down with a wobble
    yawn(t) {
      const pitch = Array.from({ length: 40 }, (_, i) => Math.round(i < 8 ? i * 0.5 : 4 - (i - 8) * 0.45) + (i % 6 < 3 ? 0.3 : -0.3));
      const vol = Array.from({ length: 40 }, (_, i) => i < 6 ? 0.3 + i * 0.12 : Math.max(0.1, 1 - (i - 6) / 38));
      const duty = pitch.map((_, i) => i < 14 ? 0.5 : 0.25);
      chip(t, { base: C(2), pitch, vol, duty, peak: 0.14, frame: FR * 1.2, echo: 0.1 });
      noise(t, { rate: 9000, vol: decay(20, 0.4), peak: 0.06 });
    },
    // 휴지통 와르르: the bin tips (clunk), paper balls tumble (crinkle blips) and land (soft taps)
    paper(t) {
      noise(t, { rate: [4000, 2500, 1500], vol: [1, 0.6, 0.3], peak: 0.24 });
      chip(t, { base: 196, pitch: [0, -3, -5], vol: [1, 0.6, 0.3], wave: 'tri', peak: 0.22 });
      for (let b = 0; b < 9; b++) {
        const t0 = t + 0.06 + b * 0.065;
        noise(t0, { rate: [24000 + b * 1500, 0, 30000, 0, 20000], vol: [1, 0, 0.7, 0, 0.5], short: b % 3 === 0, peak: 0.12, frame: FR / 2 });
        const land = t0 + 0.45 + ((b * 37) % 30) / 100;
        noise(land, { rate: [3500, 2000], vol: [1, 0.4], peak: 0.16 });
      }
    },
    // small UI pop (memo /정리, sound on): a stepped rising bloop
    pop(t) {
      chip(t, { base: B, pitch: [0, 4, 7, 12, 16], vol: [0.8, 1, 1, 0.7, 0.35], duty: 0.5, peak: 0.16, echo: 0.1 });
    },
    // ---- interface: short and quiet, so they never get in the way
    // window opens: a quick rising C–G–C "bwip"
    open(t) {
      chip(t, { base: B, pitch: [0, 0, 7, 7, 12, 12], vol: [0.6, 0.8, 0.9, 0.8, 0.6, 0.3], duty: 0.25, peak: 0.11, echo: 0.08 });
    },
    // window closes: the same, falling
    close(t) {
      chip(t, { base: B, pitch: [12, 12, 7, 7, 0, 0], vol: [0.6, 0.8, 0.8, 0.6, 0.4, 0.2], duty: 0.25, peak: 0.1 });
      noise(t + 6 * FR, { rate: [6000, 3000], vol: [0.6, 0.2], peak: 0.06 });                      // a soft "tk" as it shuts
    },
    // 접어 두기: a stepped slide down into the tray
    minimize(t) {
      chip(t, { base: B, pitch: [12, 9, 5, 2, -2, -5, -7], vol: [0.7, 0.8, 0.8, 0.7, 0.5, 0.35, 0.2], duty: 0.5, peak: 0.08, echo: 0.06 });
    },
    // 다시 펼치기: the slide back up
    restore(t) {
      chip(t, { base: B, pitch: [-7, -5, -2, 2, 5, 9, 12], vol: [0.3, 0.5, 0.7, 0.8, 0.8, 0.7, 0.4], duty: 0.5, peak: 0.08, echo: 0.06 });
    },
    // right-click menu appears: one tiny tick
    menu(t) {
      chip(t, { base: B, pitch: [19, 19], vol: [0.9, 0.5], duty: 0.25, peak: 0.12 });
    },
    // a menu item is chosen: a short two-step blip
    select(t) {
      chip(t, { base: B, pitch: [12, 12, 19, 19], vol: [0.7, 0.6, 0.8, 0.3], duty: 0.25, peak: 0.1 });
    },
    // an OS dialog asks something: the classic two-tone alert (A5, E5)
    alert(t) {
      chip(t, { base: B, pitch: [9, 9, 9, 9, 9], vol: [0.9, 1, 1, 0.8, 0.5], duty: 0.5, peak: 0.1, echo: 0.1 });
      chip(t + 7 * FR, { base: B, pitch: [4, 4, 4, 4, 4, 4], vol: [0.9, 1, 0.9, 0.7, 0.5, 0.25], duty: 0.5, peak: 0.1, echo: 0.1 });
    },
    // something can't be done: a low "bu-bup" (the window shakes its head with it)
    error(t) {
      chip(t, { base: B, pitch: [-17, -17, -17, -17], vol: [1, 1, 0.9, 0.4], duty: [0.5, 0.25, 0.5, 0.25], peak: 0.1 });
      chip(t + 6 * FR, { base: B, pitch: [-18, -18, -18, -18, -18, -18], vol: [1, 1, 0.9, 0.7, 0.4, 0.15], duty: [0.5, 0.25, 0.5, 0.25, 0.5, 0.25], peak: 0.1 });
    },
    // a writing box crumpled up: a handful of quick paper crinkles
    crumple(t) {
      const rates = [14000, 22000, 9000, 26000, 12000, 18000, 7000];
      rates.forEach((rate, i) => noise(t + i * 0.042 + (i % 2) * 0.008, { rate, vol: [1, 0.35], short: i % 3 === 0, peak: 0.08, frame: FR / 3 }));
      noise(t + 0.3, { rate: [5000, 3000], vol: [0.7, 0.25], peak: 0.07 });
    },
    // the bin lid tips open: one tiny tick
    lid(t) {
      chip(t, { base: B, pitch: [0, 5], vol: [0.5, 0.25], duty: 0.125, peak: 0.05 });
    },
    // the ball lands in the bin: a soft papery thud, then the lid clinks shut
    bin(t) {
      noise(t, { rate: [3200, 1800, 1200], vol: [1, 0.5, 0.2], peak: 0.15 });
      chip(t, { base: 147, pitch: [0, -5, -9], vol: [1, 0.5, 0.2], wave: 'tri', peak: 0.2 });
      chip(t + 0.32, { base: B, pitch: [7, 7], vol: [0.6, 0.25], duty: 0.125, peak: 0.06 });
      noise(t + 0.32, { rate: 22000, vol: [0.6, 0.1], short: true, peak: 0.05 });
    },
    // someone else's ball drops in from far away: the same thud, smaller
    binSoft(t) {
      noise(t, { rate: [3200, 1800], vol: [0.8, 0.3], peak: 0.08 });
      chip(t, { base: 165, pitch: [0, -5], vol: [0.8, 0.3], wave: 'tri', peak: 0.1 });
      chip(t + 0.32, { base: B, pitch: [7], vol: [0.4, 0.15], duty: 0.125, peak: 0.04 });
    },
    // a 방명록 note folds into a paper airplane and swooshes off
    plane(t) {
      noise(t, { rate: [3000, 3000], vol: [0.5, 0.3], short: true, peak: 0.05, frame: FR / 2 });
      noise(t + 0.05, { rate: [2500, 4000, 7000, 11000, 15000, 12000, 8000], vol: [0.15, 0.35, 0.55, 0.6, 0.5, 0.3, 0.12], peak: 0.07, frame: FR * 1.6, lp: 9000 });
      chip(t + 0.05, { base: B, pitch: [0, 2, 4, 7, 9, 12, 14, 16], vol: [0.3, 0.4, 0.45, 0.45, 0.4, 0.3, 0.2, 0.1], duty: 0.125, peak: 0.04, frame: FR * 1.4 });
    },
    // a firework over 학생회관: a rising whistle, a pop, then crackles
    firework(t) {
      chip(t, { base: B, pitch: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18], vol: [0.2, 0.3, 0.3, 0.35, 0.35, 0.35, 0.3, 0.3, 0.25, 0.2], duty: 0.125, peak: 0.04 });
      noise(t + 0.18, { rate: [6000, 3000, 1500, 900], vol: [1, 0.6, 0.3, 0.1], peak: 0.14 });
      for (let i = 0; i < 6; i++) noise(t + 0.3 + i * 0.06 + (i % 2) * 0.02, { rate: 24000 - i * 2000, vol: [0.7, 0.2], short: true, peak: 0.05, frame: FR / 3 });
    },
    // re-inking a stamp: two soft dabs on the pad
    dab(t) {
      noise(t, { rate: [2500, 1500], vol: [0.8, 0.3], peak: 0.1 });
      noise(t + 0.16, { rate: [2500, 1500], vol: [0.8, 0.3], peak: 0.1 });
    },
    // someone else's line finishes typing in: a small carriage return (ratchet + soft stop)
    ret(t) {
      let tt = t;
      for (let i = 0; i < 5; i++) { noise(tt, { rate: 30000, vol: [1, 0.3], short: true, peak: 0.06, frame: FR / 3 }); tt += (2.2 - i * 0.2) * FR; }
      noise(tt + 0.01, { rate: [5000, 2500], vol: [0.8, 0.3], peak: 0.1 });
      chip(tt + 0.01, { base: 110, pitch: [0, -7], vol: [0.7, 0.3], wave: 'tri', peak: 0.16 });
    },
  };

  // ---------------------------------------------------------- 낭독회 voice
  // The one non-chip voice on purpose: a buzzy wave through vowel filters (F1 lift, resonant F2
  // low-pass), sliding pitch and a small room, so lines sound spoken. Styles: VOICE_STYLES.
  const room = ac.createConvolver();
  {
    const len = Math.floor(ac.sampleRate * 0.9), ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) { lp += 0.35 * ((Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) - lp); d[i] = lp; }
    }
    room.buffer = ir;
  }
  const roomIn = ac.createGain(); roomIn.gain.value = 0.9;
  roomIn.connect(room).connect(bus);
  const FORMANT = { a: [850, 1350], e: [560, 1950], i: [320, 2350], o: [480, 900], u: [360, 820], eu: [380, 1500], eo: [620, 1150] };

  // n: { semi, glide (semitones over the syllable), dur, v, coda, last } from voicePlan
  function speak(t, n, voice, rate = 1, style = VOICE_STYLES[VOICE_STYLE]) {
    if (!n) return;
    const st = { ...VOICE_STYLES.orig, ...style };
    const dur = Math.min(n.dur * st.legato, 0.09 / rate + 0.01 + (st.legato - 1) * 0.03);
    const end = n.coda === 'stop' ? dur * 0.7 : dur;
    const f0 = hz(voice.base, n.semi), f1 = hz(voice.base, n.semi + n.glide);
    const g = ac.createGain(); g.gain.value = 0; g.connect(bus);
    if (st.room) { const sg = ac.createGain(); sg.gain.value = st.room; g.connect(sg).connect(roomIn); }
    const [F1, F2] = FORMANT[n.v] ?? FORMANT.eo;
    const pk = ac.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = F1 * voice.shift; pk.Q.value = 1.2; pk.gain.value = st.f1Db;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = F2 * voice.shift; lp.Q.value = st.q;
    const top = ac.createBiquadFilter(); top.type = 'lowpass'; top.frequency.value = st.top; top.Q.value = 0.5;
    pk.connect(lp).connect(top).connect(g);
    const waves = [[st.wave ?? voice.wave, 1 - st.tri], ['triangle', st.tri]];
    for (const [type, lvl] of waves) {
      if (lvl <= 0) continue;
      const o = ac.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      if (st.vib && n.last) {                                         // a little wobble on the last syllable
        const l = ac.createOscillator(), lg = ac.createGain();
        l.frequency.value = 5.5; lg.gain.value = f1 * (Math.pow(2, st.vib / 12) - 1);
        l.connect(lg).connect(o.frequency); l.start(t + dur * 0.3); l.stop(t + dur + 0.02);
      }
      const og = ac.createGain(); og.gain.value = lvl;
      o.connect(og).connect(pk);
      o.start(t); o.stop(t + dur + 0.03);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(voice.peak * st.gain, t + st.attack);
    g.gain.setValueAtTime(voice.peak * st.gain, t + end * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + end);
    if (n.coda === 'nasal') {                                         // ㄴ ㅁ ㅇ: a little hum
      const hg = ac.createGain(); hg.gain.value = 0; hg.connect(bus);
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f1;
      o.connect(hg);
      hg.gain.setValueAtTime(0.0001, t + end * 0.55);
      hg.gain.linearRampToValueAtTime(voice.peak * 0.5 * st.gain, t + end * 0.65);
      hg.gain.exponentialRampToValueAtTime(0.0001, t + end * 0.55 + 0.05);
      o.start(t + end * 0.55); o.stop(t + end * 0.55 + 0.07);
    }
  }

  return {
    ac,
    play(name, t = ac.currentTime + 0.01, opts) { P[name]?.(t, opts); },
    speak,
    names: Object.keys(P),
  };
}

// ---------------------------------------------------------------- text → notes (pure)

// medial vowel (21) → vowel key
const MEDIAL = ['a', 'e', 'a', 'e', 'eo', 'e', 'eo', 'e', 'o', 'a', 'e', 'e', 'o', 'u', 'eo', 'e', 'i', 'u', 'eu', 'i', 'i'];
const VOWEL_ST = { i: 0.6, e: 0.3, a: 0.2, eo: 0, o: -0.2, u: -0.5, eu: -0.4 };
// final consonant (28, 0 = none) → coda kind
const CODA = [null, 'stop', 'stop', 'stop', 'nasal', 'nasal', 'nasal', 'stop', 'liquid', 'liquid', 'liquid', 'liquid', 'liquid', 'liquid', 'liquid', 'liquid', 'nasal', 'stop', 'stop', 'stop', 'stop', 'nasal', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop'];
// tense / aspirated onsets start a word high (H H L H) instead of low (L H L H)
const HIGH_ONSET = new Set([1, 4, 8, 9, 10, 13, 14, 15, 16, 17, 18]);   // ㄲ ㄸ ㅃ ㅅ ㅆ ㅉ ㅊ ㅋ ㅌ ㅍ ㅎ

function syllable(ch) {
  const c = ch.codePointAt(0) - 0xAC00;
  if (c >= 0 && c < 11172) {
    const onset = Math.floor(c / 588), medial = Math.floor((c % 588) / 28), fin = c % 28;
    return { v: MEDIAL[medial], coda: CODA[fin], high: HIGH_ONSET.has(onset) };
  }
  if (/[a-z]/i.test(ch)) return { v: { a: 'a', e: 'e', i: 'i', o: 'o', u: 'u' }[ch.toLowerCase()] ?? 'eo', coda: null, high: false };
  if (/[0-9]/.test(ch)) return { v: 'eo', coda: null, high: false };
  if (/[ㄱ-ㅎㅏ-ㅣ]/.test(ch)) return { v: 'eu', coda: null, high: false };
  return null;                                     // spaces, punctuation: silent
}

// A speaker from any seed (student id, name, 'cat'): base pitch, wave and vowel-filter shift.
export function speakerFor(seed = '', { pitch = 1 } = {}) {
  let h = 2166136261;
  for (const c of String(seed)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const base = [196, 208, 220, 233, 247, 262, 277, 294, 311, 330][h % 10] * pitch;
  return { base, wave: (h >> 4) % 3 === 0 ? 'sawtooth' : 'square', shift: 1 + ((h >> 8) % 5) * 0.06, peak: 0.08 };
}

// 낭독회 voice styles (the site uses VOICE_STYLE). range scales the pitch movement.
export const VOICE_STYLES = {
  orig:  { label: '원래',       range: 1,   room: 0.06, attack: 0.006, q: 4.5, f1Db: 6, top: 3800, tri: 0,    legato: 1,    vib: 0,   gain: 1 },
  calm:  { label: '차분하게',   range: 0.6 },
  clear: { label: '또렷하게',   range: 0.8, room: 0.03, attack: 0.004, q: 6,   f1Db: 8, top: 4800, wave: 'square', gain: 0.85 },
  calmclear: { label: '차분하고 또렷하게', range: 0.6, room: 0.03, attack: 0.004, q: 6, f1Db: 8, top: 4800, wave: 'square', gain: 0.85 },
  warm:  { label: '따뜻하게',   range: 0.8, room: 0.12, attack: 0.012, q: 3,   f1Db: 5, top: 3000, tri: 0.5, legato: 1.15, gain: 1.25 },
  sing:  { label: '노래하듯',   range: 1,   room: 0.08, legato: 1.2, vib: 0.35 },
};
export const VOICE_STYLE = 'calmclear';

// One note per character of `text` (null = silent): Korean phrase intonation.
// Sentence-final cues (. ? !) shrink less than the rest when the range is smaller.
export function voicePlan(text, speaker, { range = VOICE_STYLES[VOICE_STYLE].range ?? 1 } = {}) {
  void speaker;
  const fin = Math.sqrt(range);
  const chars = [...text];
  const syl = chars.map(syllable);
  const n = chars.length || 1;
  const word = []; let w = -1, pos = 0;
  chars.forEach((ch, i) => {
    if (!syl[i]) { pos = 0; word[i] = null; return; }
    if (pos === 0) w++;
    word[i] = { w, pos: pos++ };
  });
  const len = {}; word.forEach(x => { if (x) len[x.w] = Math.max(len[x.w] ?? 0, x.pos + 1); });
  // the punctuation between this syllable and the next sounding one decides how the word ends
  const endMark = (i) => {
    let k = i + 1;
    while (k < chars.length && !syl[k]) k++;
    const gap = chars.slice(i + 1, k).join('');
    if (/\?/.test(gap)) return '?';
    if (/!/.test(gap)) return '!';
    if (/~/.test(gap)) return '~';
    if (/[.。…]/.test(gap) || k >= chars.length) return '.';
    if (/[,，、]/.test(gap)) return ',';
    return null;                                                  // more words follow
  };
  return chars.map((ch, i) => {
    const s = syl[i]; if (!s) return null;
    const { w: wi, pos: p } = word[i], L = len[wi];
    const first = chars.findIndex((_, k) => word[k]?.w === wi);
    const high = syl[first]?.high;
    let tone;                                                     // accentual phrase L H … H
    if (L === 1) tone = 0.6;
    else if (p === 0) tone = high ? 0.9 : 0.1;
    else if (p === 1) tone = 1.0;
    else if (p === L - 1) tone = 0.8;
    else tone = 0.55 - 0.1 * (p - 1);
    let semis = (-1.5 + tone * 4.5) * range;                      // phrase: about a major third
    semis += (2 - 4 * (i / n)) * range;                           // declination over the line
    semis += (VOWEL_ST[s.v] ?? 0) * range;
    semis += (Math.random() - 0.5) * 0.5 * range;                 // a little life
    let glide = -0.5 * range, dur = s.coda === 'stop' ? 0.055 : 0.075;
    const mark = p === L - 1 ? endMark(i) : null;
    if (mark === '.') { semis -= 1.5 * fin; glide = -3.4 * fin; dur = 0.11; }
    else if (mark === '?') { semis += 1 * fin; glide = 5.2 * fin; dur = 0.12; }
    else if (mark === '!') { semis += 2.5 * fin; glide = -3.9 * fin; dur = 0.1; }
    else if (mark === '~') { semis += 1 * fin; glide = -5 * fin; dur = 0.16; }
    else if (mark === ',') { glide = 1.3 * fin; dur = 0.09; }
    return { semi: semis, glide, dur, v: s.v, coda: s.coda, last: !!mark && mark !== ',' };
  });
}
