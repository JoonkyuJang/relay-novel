// 낭독회: a finished story read back one line at a time, one character at a time,
// in a little beep voice (a different pitch per writer, never their name).
import * as api from '../api.js';
import { h, errorText } from '../ui.js';
import { on, reduceMotion } from '../extras/extras.js';
import { voice as lineVoice, play } from '../extras/sound.js';
import { seal } from '../extras/stamps.js';

export function readingView(app, storyId) {
  let story = null, lines = [];
  let idx = 0, playing = false, timer = null;
  let speed = 1, gap = 2000;
  let voice = on('reading_voice');
  const route = `/read/${storyId}`;

  const prev = h('div', { class: 'read-prev' });
  const num = h('div', { class: 'read-no' });
  const cur = h('div', { class: 'read-cur', 'aria-hidden': 'true' });
  const said = h('div', { class: 'sr-only', 'aria-live': 'polite' });      // the whole line, once
  const end = h('div', { class: 'read-end', hidden: true });
  const stage = h('div', { class: 'read-stage' }, prev, h('div', { class: 'read-row' }, num, cur), said, end);
  const segs = h('div', { class: 'read-segs', 'aria-hidden': 'true' });
  const playBtn = h('button', { type: 'button', class: 'btn read-play', onclick: toggle, 'aria-label': '재생' }, '▶');
  const prevBtn = h('button', { type: 'button', class: 'btn', onclick: () => go(idx - 1), 'aria-label': '이전 줄' }, '⏮');
  const nextBtn = h('button', { type: 'button', class: 'btn', onclick: () => go(idx + 1), 'aria-label': '다음 줄' }, '⏭');
  const bars = h('span', { class: 'read-bars', 'aria-hidden': 'true' }, Array.from({ length: 6 }, () => h('i')));
  const voiceBtn = on('reading_voice')
    ? h('button', { type: 'button', class: 'btn-link', 'aria-pressed': 'true', onclick: () => { voice = !voice; voiceBtn.textContent = voice ? '목소리 켬' : '목소리 끔'; voiceBtn.setAttribute('aria-pressed', String(voice)); } }, '목소리 켬')
    : null;
  const speedSel = h('select', { class: 'field sm', 'aria-label': '빠르기', onchange: (e) => { speed = Number(e.target.value); } },
    [1, 1.5, 2].map(v => h('option', { value: v }, `빠르기 ×${v}`)));
  const gapSel = h('select', { class: 'field sm', 'aria-label': '줄 사이', onchange: (e) => { gap = Number(e.target.value); } },
    [1000, 2000, 3000].map(v => h('option', { value: v, selected: v === 2000 }, `줄 사이 ${v / 1000}초`)));
  const ctrl = h('div', { class: 'read-ctrl' }, prevBtn, playBtn, nextBtn, bars, voiceBtn, h('span', { style: 'flex:1' }), speedSel, gapSel);
  const msg = h('div');
  const body = document.createDocumentFragment();
  body.append(msg, stage, segs, ctrl);

  function drawSegs() {
    segs.replaceChildren(...lines.map((_, i) => h('span', { class: i < idx ? 'done' : i === idx ? 'now' : '' })));
  }
  function stopTyping() { clearTimeout(timer); timer = null; bars.classList.remove('on'); }

  function show(i, { type = true } = {}) {
    stopTyping();
    idx = Math.max(0, Math.min(i, lines.length));
    drawSegs();
    end.hidden = idx < lines.length;
    stage.classList.toggle('ended', idx >= lines.length);
    if (idx >= lines.length) { finish(); return; }
    const l = lines[idx];
    prev.textContent = idx ? lines[idx - 1].text : '';
    num.textContent = String(l.position).padStart(2, '0');
    said.textContent = `${l.position}번째 줄. ${l.text}`;
    if (!type || reduceMotion()) { cur.textContent = l.text; return afterLine(); }
    cur.textContent = '';
    const chars = [...l.text];
    const v = lineVoice(l.text, l.student_id || l.author_name || String(l.position));
    let k = 0;
    bars.classList.add('on');
    const step = () => {
      if (k >= chars.length) { bars.classList.remove('on'); return afterLine(); }
      const ch = chars[k++];
      cur.textContent += ch;
      if (voice) v.say(k - 1, { force: true, rate: speed });
      const pause = /[,，、]/.test(ch) ? 260 : /[.!?。…]/.test(ch) ? 520 : 0;
      timer = setTimeout(step, (85 + pause) / speed);
    };
    step();
  }
  function afterLine() {
    if (!playing) return;
    timer = setTimeout(() => show(idx + 1), gap / speed);
  }
  function finish() {
    playing = false;
    playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', '처음부터 다시');
    prev.textContent = lines.at(-1)?.text ?? '';
    num.textContent = '';
    cur.textContent = '끝.';
    const names = [...new Set(lines.map(l => l.author_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    end.replaceChildren(seal(170, -8),
      on('reading_credits') && names.length ? h('div', { class: 'read-credits' }, h('b', {}, '함께 쓴 사람'), h('span', {}, names.join(' · '))) : null);
    if (on('completion_fx')) play('chime', { force: voice });
  }
  function toggle() {
    if (!lines.length) return;
    if (idx >= lines.length) { playing = true; show(0); }
    else if (playing) { playing = false; stopTyping(); cur.textContent = lines[idx].text; }
    else { playing = true; show(idx); }
    playBtn.textContent = playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', playing ? '멈춤' : '재생');
  }
  function go(i) {
    if (!lines.length) return;
    show(Math.max(0, Math.min(i, lines.length - 1)), { type: playing });
  }
  function onKey(e) {
    if (!body.isConnected && !stage.isConnected) return;
    if (!stage.closest('.win')?.classList.contains('is-active')) return;
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === ' ' && e.target.closest('button, a')) return;     // Space on a focused button presses that button
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') go(idx - 1);
    else if (e.key === 'ArrowRight') go(idx + 1);
  }

  return {
    type: 'reading', route, title: '낭독회', body,
    size: { w: 680, h: 520 }, minSize: { w: 420, h: 380 }, origin: { x: 300, y: 70 },
    async mount() {
      addEventListener('keydown', onKey);
      try {
        story = await api.getStory(storyId);
        lines = story.lines.filter(l => !l.removed);
        this.setTitle?.(`낭독회 · ${story.title || '제목 없는 이야기'}`);
        if (story.status !== 'completed') msg.replaceChildren(h('div', { class: 'notice warn', style: 'margin:10px 14px 0' }, '아직 진행 중인 이야기예요. 지금까지 쓴 줄을 읽어요.'));
        idx = 0; drawSegs();
        prev.textContent = '';
        num.textContent = '';
        cur.textContent = lines.length ? '▶를 누르면 시작해요' : '아직 줄이 없어요.';
      } catch (e) {
        msg.replaceChildren(h('div', { class: 'notice bad', style: 'margin:10px 14px 0' }, errorText(e)));
      }
    },
    unmount() { stopTyping(); playing = false; removeEventListener('keydown', onKey); },
  };
}
