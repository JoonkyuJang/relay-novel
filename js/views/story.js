// One story: its lines, the writer reveal, and the baton/composer state machine.
// 부가 기능 here: stamp pads + buttons, 꽉 채웠어요 mark, live "누군가 쓰는 중 (n자)",
// 자리 나면 알려 주기, 원고지 writing box, finished-story header / 이야기 기록, completion effects.
import * as api from '../api.js';
import { h, icon, fmtTime, fmtCountdown, errorText, attachReveal } from '../ui.js';
import { on, fun, bus, X, manuscript, reduceMotion, deadlinePassed } from '../extras/extras.js';
import { fillPad, stampButtons, updateTicks, seal } from '../extras/stamps.js';
import { relayRecord, recordView, gridIcon } from '../extras/record.js';
import { play } from '../extras/sound.js';

const pad2 = (n) => String(n).padStart(2, '0');
const STATUS_CHIP = {
  open: () => h('span', { class: 'chip sky' }, '진행 중'),
  completed: () => h('span', { class: 'chip grass' }, '완결'),
  mine: () => h('span', { class: 'chip pink' }, '내가 쓰는 중'),
  others: () => h('span', { class: 'chip pink' }, '누군가 쓰는 중'),
};

export function storyView(app, storyId) {
  const route = `/story/${storyId}`;
  let story = null;
  let stamps = {};             // line_id -> { marks, counts, mine }
  let baton = null;            // my claim while writing
  let mode = 'idle';           // idle | writing | conflict | done
  let lastResult = null;
  let message = '';
  let clockOffset = 0;
  let known = null;            // line ids already shown (to mark new ones)
  let revealedId = null;       // line whose 속성 window is open
  let othersTyping = null;     // live character count of whoever holds the baton
  let notifyFree = false;
  let unwatch = null, ticker = null, typing = null, ro = null;
  let closed = false, claiming = false, linesSig = null;
  let blocker = null, lastBlockerSig = 'null';          // why I can't write here (write_check), shown before pressing 이어 쓰기
  let gridMode = api.prefs.get('gridbox') == null ? !!X('grid_box_default') : api.prefs.get('gridbox') === '1';
  const serverNow = () => Date.now() + clockOffset;

  const bar = h('div', { class: 'win-bar' });
  const head = h('div', { class: 'story-head', hidden: true });
  const list = h('ol', { class: 'lines' });
  const record = h('div', { class: 'story-record', hidden: true });
  const scroll = h('div', { class: 'win-scroll' }, head, list, record);
  const ticks = h('div', { class: 'stamp-ticks', hidden: true, 'aria-hidden': 'true' });
  const foot = h('div', { class: 'win-foot' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const body = document.createDocumentFragment();
  body.append(bar, scroll, ticks, foot, live);

  const view = {
    type: 'story', route, title: '불러오는 중…', body,
    size: { w: 720, h: 600 }, minSize: { w: 460, h: 380 }, origin: { x: 380, y: 50 },
    storyId,
    get storyData() { return story; },
    mount() {
      refresh();
      unwatch = api.watch([storyId], refresh);
      ticker = setInterval(tick, 1000);
      addEventListener('pagehide', onPageHide);
      if (on('typing_count')) typing = api.typingChannel(storyId, (n) => { othersTyping = n; showTyping(); });
      ro = new ResizeObserver(() => placeTicks());
      ro.observe(scroll);
    },
    onFocus() { if (story && mode === 'idle') renderFoot(); },
    // never rebuild the writing box (it would drop the IME composition and close the phone keyboard)
    onSettings() { if (!story) return; linesSig = null; if (mode === 'writing') { renderBar(); renderLines(); } else renderAll(); },
    unmount() {
      closed = true;
      unwatch?.(); clearInterval(ticker); typing?.close(); ro?.disconnect();
      removeEventListener('pagehide', onPageHide);
      if (baton) api.releaseBaton(storyId, baton.token).catch(() => {});
    },
  };

  function onPageHide() { if (baton) api.releaseBatonOnUnload(storyId, baton.token); }

  // ---------------------------------------------------------- rendering

  function renderBar() {
    const left = story.max_lines - story.line_count;
    const chip = story.status === 'completed' ? STATUS_CHIP.completed()
      : mode === 'writing' ? STATUS_CHIP.mine()
      : story.writing ? STATUS_CHIP.others() : STATUS_CHIP.open();
    bar.replaceChildren(...[
      chip,
      h('span', {}, `${story.line_count} / ${story.max_lines}줄`),
      story.status === 'open' ? h('span', { class: 'muted' }, `${left}줄 남음 · 한 줄 최대 ${story.max_chars}자`) : null,
    ].filter(Boolean));
  }

  const isFull = (l) => fun('fun_full') && !l.removed && api.countChars(l.text) === story.max_chars;

  function lineItem(l, isNew) {
    const pads = on('stamps');
    if (l.removed) {
      return h('li', { class: `line removed${pads ? ' has-pad' : ''}` },
        h('span', { class: 'line-no' }, pad2(l.position)),
        h('span', { class: 'line-text' }, '(관리자가 숨긴 줄)'), pads ? h('span', { class: 'stamp-pad' }) : null, h('span', { class: 'who-slot' }));
    }
    const full = isFull(l);
    const li = h('li', { class: `line${pads ? ' has-pad' : ''}${isNew ? ' is-new' : ''}${revealedId === l.id ? ' is-revealed' : ''}`, dataset: { id: l.id } });
    const who = h('button', {
      type: 'button', class: 'who', 'aria-label': on('stamps') ? `${l.position}번 줄 속성 · 도장 찍기` : `${l.position}번 줄 쓴 사람 보기`, 'aria-expanded': 'false',
    }, icon('person', 16));
    attachReveal(who, () => {
      const n = api.countChars(l.text);
      const st = stamps[l.id] ?? { counts: { sun: 0, laugh: 0, cur: 0 }, mine: [] };
      stamps[l.id] = { marks: [], ...st };
      return {
        title: `${pad2(l.position)}번 줄 속성`,
        rows: [['작성자', l.author_name], ['학번', l.student_id], ['쓴 시각', fmtTime(l.created_at)],
               ['글자', full ? h('span', { class: 'full-note' }, gridIcon(14), ` ${n} / ${story.max_chars}자 꽉!`) : `${n} / ${story.max_chars}자`]],
        extra: pads ? () => stampButtons(app, l, stamps[l.id], { onChange: refreshStamps }) : null,
        onOpen: () => { revealedId = l.id; li.classList.add('is-revealed'); },
        onClose: () => { revealedId = null; list.querySelector('.is-revealed')?.classList.remove('is-revealed'); },
      };
    });
    const pad = pads ? h('span', { class: 'stamp-pad' }) : null;
    if (pad) fillPad(pad, stamps[l.id]?.marks);
    li.append(
      h('span', { class: 'line-no' }, pad2(l.position),
        full ? h('span', { class: 'full-mark', title: `딱 ${story.max_chars}자로 꽉 채운 줄`, 'aria-label': '꽉 채웠어요' }, gridIcon(16)) : null),
      h('span', { class: 'line-text' }, l.text, l.edited ? h('span', { class: 'edited' }, ' (수정됨)') : null),
      pad, who);
    return li;
  }

  function pendingText() {
    return othersTyping != null && on('typing_count') ? `누군가 쓰는 중 (${othersTyping}자)` : '누군가 쓰는 중';
  }

  function renderLines() {
    // nothing visible changed (the 20 s safety refresh, a bump for someone else's baton…): keep the DOM,
    // so text selection and an open 속성 window survive
    const sig = JSON.stringify([story.status, story.writing, mode, revealedId, othersTyping != null,
      story.lines.map(l => [l.id, l.text, l.edited, l.removed]), stamps]);
    if (sig === linesSig) return;
    linesSig = sig;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    const first = known === null;
    const ids = new Set(story.lines.map(l => l.id));
    const items = story.lines.map(l => lineItem(l, !first && !known.has(l.id)));
    if (story.status === 'open' && story.writing && mode !== 'writing') {
      items.push(h('li', { class: 'line pending' },
        h('span', { class: 'line-no' }, pad2(story.line_count + 1)),
        h('span', { class: 'line-text' }, h('span', { 'aria-hidden': 'true' }, '▒▒▒▒▒▒ '), h('span', { 'data-typing': '' }, pendingText()), h('span', { class: 'dots', 'aria-hidden': 'true' }, '…')), h('span')));
    }
    if (!first) {
      const added = story.lines.filter(l => !known.has(l.id));
      if (added.length) {
        live.textContent = `새 줄: ${added.map(l => l.text).join(' ')}`;
        added.forEach(line => bus.emit('line-added', { storyId, line }));
      }
    }
    known = ids;
    list.replaceChildren(...items);
    renderHead();
    if (first || nearBottom) scroll.scrollTop = story.status === 'completed' && first ? 0 : scroll.scrollHeight;
    placeTicks();
  }

  function renderHead() {
    const done = story.status === 'completed';
    head.hidden = !done;
    record.hidden = !done || !(on('relay_record') || on('manuscript'));
    if (!done) return;
    const d = (ts) => { const x = new Date(ts); return `${x.getMonth() + 1}.${pad2(x.getDate())}`; };
    head.replaceChildren(
      h('div', { class: 'story-head-text' },
        h('h3', {}, story.title || '제목 없는 이야기'),
        h('span', { class: 'muted' }, `${d(story.created_at)} 시작 · ${fmtTime(story.completed_at)} 완결`)),
      seal(132, -8));
    if (!record.hidden) record.replaceChildren(recordView(relayRecord(story)));
  }

  function placeTicks() {
    if (!on('stamps')) { ticks.hidden = true; return; }
    ticks.style.top = `${scroll.offsetTop}px`;
    ticks.style.height = `${scroll.clientHeight}px`;
    const items = [...list.children].filter(li => li.dataset.id)
      .map(li => ({ el: li, n: stamps[li.dataset.id]?.marks?.length ?? 0 })).filter(i => i.n);
    updateTicks(scroll, ticks, items);
  }

  function showTyping() {
    for (const el of scroll.querySelectorAll('[data-typing]')) el.textContent = pendingText();
    for (const el of foot.querySelectorAll('[data-typing-foot]')) el.textContent = othersTyping != null ? ` (${othersTyping}자)` : '';
  }

  function doneFoot() {
    const finishedByMe = lastResult?.result === 'accepted' && lastResult.story_status === 'completed';
    return [
      h('p', { style: 'margin:0' }, finishedByMe
        ? '마지막 줄을 썼어요. 이야기가 완결됐어요!'
        : `${story.line_count}줄로 완결된 이야기예요. 함께 써 주셔서 고마워요.`),
      h('div', { class: 'actions', style: 'justify-content:flex-start' },
        on('reading') ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => app.go(`/read/${storyId}`) }, '▶ 낭독회 열기') : null,
        h('button', { type: 'button', class: 'btn', onclick: copyLink }, '링크 복사')),
    ];
  }

  async function copyLink(e) {
    const url = `${location.origin}${location.pathname}#/story/${storyId}`;
    try { await navigator.clipboard.writeText(url); e.target.textContent = '복사했어요'; }
    catch { e.target.textContent = url; }
    setTimeout(() => { e.target.textContent = '링크 복사'; }, 2000);
  }

  function conflictFoot() {
    return h('div', { class: 'notice warn', role: 'alert', style: 'display:flex;gap:12px' },
      icon('disk', 28),
      h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:6px' },
        h('b', {}, '저장 충돌'),
        h('span', {}, lastResult.reason === 'baton_taken'
          ? '예약 시간이 지나 다른 사람이 이 자리를 쓰는 중이었어요.'
          : '같은 자리에 다른 줄이 먼저 올라왔어요.'),
        h('span', {}, '쓰신 줄은 버리지 않고 관리자에게 보냈어요:'),
        h('span', { class: 'text' }, lastResult.text),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => { api.setDraft(storyId, ''); mode = 'idle'; lastResult = null; renderAll(); } }, '그만두기'),
          story.status === 'open'
            ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { mode = 'idle'; claim(); } }, '새 줄에 다시 쓰기')
            : null)));
  }

  function idleFoot() {
    const ident = app.identity();
    const status = h('div', { class: 'status-line' });
    if (story.writing) {
      status.append(icon('hourglass', 18), h('span', {}, `${story.line_count + 1}번째 줄 — 다른 사람이 쓰는 중이에요`),
        h('span', { 'data-typing-foot': '' }, othersTyping != null && on('typing_count') ? ` (${othersTyping}자)` : ''),
        h('span', {}, ' · '), h('span', { 'data-countdown': 'story' }, ''), h('span', {}, ' 남음'));
    } else if (lastResult?.result === 'accepted') {
      status.append(h('span', {}, '줄이 올라갔어요. 고마워요!'));
    } else {
      const min = Math.max(1, Math.round((app.settings?.baton_seconds ?? 300) / 60));
      status.append(h('span', { class: 'muted' }, `${story.line_count + 1}번째 줄이 비어 있어요. '이어 쓰기'를 누르면 ${min}분 동안 내 자리로 맡아 둬요.`));
    }
    // a reason to show up front: writing closed / deadline, or my own limits in this story
    // (someone else's reservation is already shown above and ends by itself)
    const reason = app.settings?.submissions_open === false ? { code: 'submissions_closed' }
      : deadlinePassed() ? { code: 'deadline_passed' }
      : ident && blocker && ['person_limit', 'consecutive', 'submissions_closed', 'deadline_passed'].includes(blocker.code) ? blocker : null;
    const notifyBtn = story.writing && on('notify_free')
      ? h('button', { type: 'button', class: 'btn', 'aria-pressed': String(notifyFree), onclick: () => { notifyFree = !notifyFree; renderFoot(); } },
          notifyFree ? '✓ 자리 나면 알려 드려요' : '자리 나면 알려 주기')
      : null;
    return [
      status,
      message ? h('div', { class: 'notice bad', role: 'alert' }, message)
        : reason ? h('div', { class: 'notice warn' }, errorText(reason)) : null,
      h('div', { class: 'actions', style: 'align-items:center' },
        ident
          ? [h('span', { class: 'muted', style: 'margin-right:auto' }, `${ident.name} 님으로 써요`), notifyBtn,
             h('button', { type: 'button', class: 'btn btn-primary', onclick: claim, disabled: !!reason }, '이어 쓰기')]
          : [notifyBtn, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => app.requireLogin('글을 쓰려면 로그인해 주세요.', route) }, '로그인하고 이어 쓰기')]),
    ];
  }

  // 원고지 writing box: a grid mirror over an invisible textarea (IME, selection, keys keep working).
  function gridBox(ta, max) {
    const cells = h('div', { class: 'grid-cells', 'aria-hidden': 'true' });
    const box = h('div', { class: 'grid-box' }, cells, ta);
    ta.classList.add('grid-input');
    const draw = () => {
      const chars = [...ta.value.replace(/\n/g, ' ')];
      const caret = [...ta.value.slice(0, ta.selectionStart ?? 0)].length;
      const n = Math.max(max, chars.length + 1);
      const focused = document.activeElement === ta;
      cells.replaceChildren(...Array.from({ length: n }, (_, i) => h('span', {
        class: `${i === caret && focused ? 'caret' : ''}${i >= max ? ' over' : ''}`, dataset: { i },
      }, chars[i] ?? '')));
    };
    cells.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const i = Number(e.target.dataset?.i ?? NaN);
      ta.focus();
      if (!Number.isNaN(i)) { const off = [...ta.value].slice(0, i).join('').length; ta.setSelectionRange(off, off); }
      draw();
    });
    for (const ev of ['input', 'keyup', 'select', 'focus', 'blur', 'compositionupdate']) ta.addEventListener(ev, () => requestAnimationFrame(draw));
    draw();
    return box;
  }

  function writingFoot() {
    const ta = h('textarea', { class: 'field', rows: 2, id: `ta-${storyId}`, value: api.getDraft(storyId), maxlength: baton.max_chars * 2, enterkeyhint: 'send', 'aria-describedby': `hint-${storyId}` });
    const counter = h('span', { class: 'counter' });
    const submitBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: submit }, '올리기');
    let lastKey = 0;
    const update = () => {
      const n = api.countChars(ta.value);
      const full = n === baton.max_chars && fun('fun_full');
      counter.replaceChildren(...(full ? [gridIcon(14), ` ${n} / ${baton.max_chars}자 꽉!`] : [`${n} / ${baton.max_chars}`]));
      counter.classList.toggle('over', n > baton.max_chars);
      counter.classList.toggle('full', full);
      api.setDraft(storyId, ta.value);
      typing?.send(n);
    };
    ta.addEventListener('input', (e) => {
      update();
      if (Date.now() - lastKey > 40) { lastKey = Date.now(); play('key', { ch: e.inputType?.startsWith('delete') ? '\b' : e.data?.slice(-1) }); }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
      else if (e.key === 'Enter') e.preventDefault();      // one line only
    });
    update();
    setTimeout(() => ta.focus({ preventScroll: true }));
    const toggleGrid = h('button', { type: 'button', class: 'btn-link', onclick: () => { gridMode = !gridMode; api.prefs.set('gridbox', gridMode ? '1' : '0'); renderFoot(); } },
      gridMode ? '보통 칸으로' : '원고지 칸으로');
    return [
      baton.is_final ? h('div', { class: 'notice warn', style: 'display:flex;gap:10px;align-items:center' }, icon('warn', 20),
        h('span', {}, `이 줄이 이야기의 마지막 줄이에요. ${story.max_lines}줄의 끝을 맺어 주세요.`)) : null,
      h('div', { class: 'status-line' }, icon('hourglass', 18), h('b', {}, `${baton.position}번째 줄`),
        h('span', { style: 'flex:1' }), h('span', {}, '남은 시간 '), h('b', { 'data-countdown': 'mine' }, '')),
      h('div', { 'data-warnings': '', role: 'status' }),
      h('div', { class: 'label' }, h('span', { class: 'label-row' }, h('span', {}, h('label', { for: ta.id }, '내 줄'), ' ', toggleGrid),
        counter)),
      gridMode ? gridBox(ta, baton.max_chars) : ta,
      h('span', { class: 'faint compose-hint', id: `hint-${storyId}` }, 'Enter를 누르면 바로 올라가요. 올린 뒤에는 고칠 수 없어요.'),
      message ? h('div', { class: 'notice bad', role: 'alert' }, message) : null,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: cancel }, '취소'), submitBtn),
    ];
  }

  function renderFoot() {
    if (story.status === 'completed' && mode !== 'conflict') mode = 'done';
    const parts = mode === 'done' ? doneFoot()
      : mode === 'conflict' ? conflictFoot()
      : mode === 'writing' ? writingFoot() : idleFoot();
    foot.replaceChildren(...[parts].flat(Infinity).filter(Boolean));
    tick();
  }

  function renderAll() { renderBar(); renderLines(); renderFoot(); }

  function tick() {
    if (!story) return;
    const mine = foot.querySelector('[data-countdown="mine"]');
    if (mine && baton) {
      const left = Date.parse(baton.expires_at) - serverNow();
      mine.textContent = left > 0 ? fmtCountdown(left) : '만료됨';
      const warn = foot.querySelector('[data-warnings]');
      const notes = [];
      if (left <= 0) notes.push('예약 시간이 지났어요. 그래도 올릴 수 있지만, 그 사이 다른 사람이 먼저 쓰면 충돌로 처리돼요.');
      if (story.head_line_id !== baton.parent_id) notes.push('그 사이 이야기가 바뀌었어요. 올리면 충돌로 처리되어 관리자에게 전달돼요.');
      if (warn && warn.dataset.sig !== notes.join('|')) {
        warn.dataset.sig = notes.join('|');
        warn.replaceChildren(...notes.map(n => h('div', { class: 'notice warn' }, n)));
      }
    }
    const theirs = foot.querySelector('[data-countdown="story"]');
    if (theirs && story.baton_expires_at) {
      const left = Date.parse(story.baton_expires_at) - serverNow();
      theirs.textContent = fmtCountdown(left);
      if (left <= 0 && story.writing) { story.writing = false; onFreed(); renderAll(); }
    }
  }

  // ---------------------------------------------------------- effects

  function onFreed() {
    othersTyping = null;
    if (!notifyFree || story.status !== 'open') return;
    notifyFree = false;
    play('ding', { force: true });
    const win = foot.closest('.win');
    win?.classList.add('flash');
    setTimeout(() => win?.classList.remove('flash'), 2400);
    if (document.hidden) {
      const t = document.title;
      document.title = `● 자리 났어요 — ${t}`;
      document.addEventListener('visibilitychange', () => { document.title = t; }, { once: true });
    }
  }

  function celebrate() {
    if (!on('completion_fx')) return;
    const win = foot.closest('.win');
    play('chime');
    if (!reduceMotion()) {
      win?.classList.add('shake');
      setTimeout(() => win?.classList.remove('shake'), 500);
      const big = seal(180, -8);
      big.classList.add('seal-drop');
      win?.append(big);
      setTimeout(() => big.remove(), 2600);
    }
    const last = story.lines.at(-1);
    bus.emit('story-completed', { storyId, title: story.title, lastLine: last?.text ?? '', el: win });
  }

  // ---------------------------------------------------------- data + actions

  async function refreshStamps() {
    if (!on('stamps')) return;
    try {
      stamps = await api.getStoryStamps(storyId, app.identity());
      if (closed) return;
      for (const li of list.querySelectorAll('.line[data-id]')) {
        const pad = li.querySelector('.stamp-pad');
        if (pad) fillPad(pad, stamps[li.dataset.id]?.marks);
      }
      placeTicks();
    } catch { /* stamps are decoration */ }
  }

  async function refresh() {
    try {
      const ident = app.identity();
      const [s] = await Promise.all([api.getStory(storyId), on('stamps')
        ? api.getStoryStamps(storyId, ident).then(x => { stamps = x; }).catch(() => {})
        : null,
        ident && mode !== 'writing' && story?.status !== 'completed'
          ? api.writeCheck(storyId, ident.studentId).then(x => { blocker = x; }).catch(() => {})
          : null]);
      if (closed) return;
      const blockerSig = JSON.stringify(blocker);
      const prevMode = mode, prevWriting = story?.writing, prevStatus = story?.status;
      story = s;
      clockOffset = Date.parse(s.server_now) - Date.now();
      view.setTitle?.(s.title || '제목 없는 이야기');
      if (prevWriting && !s.writing) onFreed();
      renderBar();
      renderLines();
      const blockerChanged = blockerSig !== lastBlockerSig;
      lastBlockerSig = blockerSig;
      if (mode !== 'writing' && (prevMode !== mode || prevWriting !== s.writing || prevStatus !== s.status || blockerChanged || !foot.hasChildNodes())) renderFoot();
      else tick();
      if (prevStatus === 'open' && s.status === 'completed') celebrate();
    } catch (e) {
      if (e.code === 'story_not_found') {
        view.setTitle?.('찾을 수 없음');
        bar.replaceChildren(); foot.replaceChildren();
        list.replaceChildren(h('li', { class: 'empty' }, '이야기를 찾을 수 없어요. 삭제되었거나 주소가 잘못되었어요.'));
      } else if (!story) {
        list.replaceChildren(h('li', { class: 'empty' }, errorText(e)));
      }
    }
  }

  async function claim() {
    const ident = app.identity();
    if (!ident) { app.requireLogin('글을 쓰려면 로그인해 주세요.', route); return; }
    if (claiming) return;
    claiming = true;
    message = '';
    foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const b = await api.claimBaton(storyId, ident);
      if (closed) { api.releaseBaton(storyId, b.token).catch(() => {}); return; }   // window closed meanwhile
      baton = b;
      clockOffset = Date.parse(baton.server_now) - Date.now();
      mode = 'writing';
      lastResult = null;
      notifyFree = false;
      renderBar(); renderFoot();
      refresh();
    } catch (e) {
      message = errorText(e);
      if (e.code === 'story_closed') mode = 'done';
      renderFoot();
      if (e.code === 'baton_held' || e.code === 'story_closed') refresh();
    } finally { claiming = false; }
  }

  let submitting = false;
  async function submit() {
    if (submitting || !baton) return;
    const ta = foot.querySelector('textarea');
    const text = ta.value;
    const n = api.countChars(text);
    if (!n) { message = errorText({ code: 'empty_text' }); renderFoot(); return; }
    if (n > baton.max_chars) { message = errorText({ code: 'too_long', detail: { max: baton.max_chars } }); renderFoot(); return; }
    submitting = true;
    foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const r = await api.submitLine(storyId, {
        parentId: baton.parent_id, text, token: baton.token, ...app.identity() });
      lastResult = { ...r, text: api.cleanLine(text) };
      baton = null; message = '';
      typing?.send(null);
      if (r.result === 'accepted') {
        api.setDraft(storyId, '');
        play('bell');
        mode = r.story_status === 'completed' ? 'done' : 'idle';
      } else {
        mode = 'conflict';
      }
      await refresh();
      renderFoot();
    } catch (e) {
      message = errorText(e);
      if (e.code === 'story_closed') { baton = null; mode = 'done'; await refresh(); }
      renderFoot();
    } finally {
      submitting = false;
    }
  }

  async function cancel() {
    const b = baton;
    baton = null; mode = 'idle'; lastResult = null; message = '';
    typing?.send(null);
    renderAll();
    if (b) { try { await api.releaseBaton(storyId, b.token); } catch { /* expires anyway */ } }
    refresh();
  }

  return view;
}
