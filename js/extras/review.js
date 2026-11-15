// 원고 검토: one last look before a line goes up — the line before it, this line on a strip of 원고지,
// its length, and a couple of gentle hints (an unclosed 「 or ", a word typed twice). Enter posts,
// Esc (or 다시 고치기) goes back to the box. Spelling itself is left to the browser's own underline.
import { h } from '../ui.js';
import { cleanLine, countChars } from '../api.js';
import { isPhone } from '../wm.js';
import { play } from './sound.js';

const PAIRS = [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['(', ')'], ['[', ']']];

export function lineHints(text) {
  const t = cleanLine(text);
  const hints = [];
  const count = (c) => t.split(c).length - 1;
  for (const [a, b] of PAIRS) if (count(a) !== count(b)) hints.push(`${a} ${b} 짝이 맞지 않아요.`);
  if (count('"') % 2) hints.push('큰따옴표(")가 하나만 있어요.');
  // the same word twice in a row (quotes and punctuation around it don't count)
  const words = t.split(' ').map(w => w.replace(/[^\p{L}\p{N}]/gu, ''));
  const k = words.findIndex((w, i) => w && w === words[i + 1]);
  if (k >= 0) hints.push(`"${words[k]} ${words[k]}" — 같은 낱말이 두 번 이어져요.`);
  return hints;
}

// -> Promise<boolean> (true: post it)
export function reviewLine({ text, prevText = null, position, maxChars, isFinal = false, edit = false }) {
  return new Promise((resolve) => {
    const t = cleanLine(text);
    const n = countChars(t);
    const opened = Date.now();
    const prevFocus = document.activeElement;
    const hints = lineHints(t);
    const done = (v) => {
      modal.remove();
      document.removeEventListener('keydown', onKey, true);
      if (!v) prevFocus?.focus?.({ preventScroll: true });
      resolve(v);
    };
    const ok = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => done(true) }, edit ? '고친 줄로 바꾸기' : '올리기');
    const back = h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, '다시 고치기');
    const cells = [...t];
    const strip = h('div', { class: 'grid-cells review-strip', 'aria-hidden': 'true' },
      Array.from({ length: Math.max(cells.length, Math.min(maxChars, 20)) }, (_, i) => h('span', { class: i >= maxChars ? 'over' : '' }, cells[i] ?? '')));
    const titleId = `review-${opened}`;
    const box = h('div', { class: 'win is-active dialog review', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'win-title' }, h('span', { class: 'win-title-pad' }), h('h2', { id: titleId }, edit ? '고친 줄 검토' : '원고 검토'), h('span', { class: 'win-title-pad' })),
      h('div', { class: 'dialog-body' },
        h('p', { class: 'muted' }, `${position}번째 줄${isFinal ? ' · 이야기의 마지막 줄' : ''} · ${n} / ${maxChars}자`),
        prevText ? h('div', { class: 'review-prev' }, h('span', { class: 'faint' }, '앞 줄'), h('span', { class: 'text' }, prevText)) : null,
        strip,
        h('p', { class: 'sr-only' }, t),
        hints.length ? h('div', { class: 'notice warn review-hints' },
          h('ul', {}, hints.map(x => h('li', {}, x))), h('span', {}, '일부러 그렇게 쓴 거라면 그대로 올려도 괜찮아요.')) : null,
        h('p', { class: 'muted' }, `맞춤법과 띄어쓰기를 한 번 더 봐 주세요.${isPhone() ? '' : ' Enter = 올리기 · Esc = 다시 고치기'}`),
        h('div', { class: 'actions', style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap' }, back, ok)));
    const modal = h('div', { class: 'modal' }, box);
    // (the Enter that opened this, or a held-down one, must not post straight away)
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (e.repeat || e.isComposing || Date.now() - opened < 400) return;
        if (document.activeElement === back) done(false); else done(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(modal);
    play('select');
    ok.focus({ preventScroll: true });
  });
}
