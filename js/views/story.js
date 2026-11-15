// One story: its lines, the writer reveal, and the baton/composer state machine.
// 부가 기능 here: stamp pads + buttons, 꽉 채웠어요 mark, live "누군가 쓰는 중 (n자)",
// 자리 나면 알려 주기, 원고지 writing box, finished-story header / 이야기 기록, completion effects,
// others' new lines typing themselves in, 절반 · 마지막 한 줄 milestones.
import * as api from '../api.js';
import { h, icon, fmtTime, fmtCountdown, errorText, attachReveal, osConfirm } from '../ui.js';
import { on, fun, bus, X, reduceMotion, deadlinePassed } from '../extras/extras.js';
import { fillPad, stampButtons, updateTicks, seal } from '../extras/stamps.js';
import { relayRecord, recordView, gridIcon } from '../extras/record.js';
import { play } from '../extras/sound.js';
import { printSheets } from '../extras/print.js';
import { tossToBin, iDropped } from '../extras/bin.js';
import { reviewLine } from '../extras/review.js';
import { isPhone } from '../wm.js';

const pad2 = (n) => String(n).padStart(2, '0');
const STATUS_CHIP = {
  open: () => h('span', { class: 'chip sky' }, '진행 중'),
  completed: () => h('span', { class: 'chip grass' }, '완결'),
  mine: () => h('span', { class: 'chip pink' }, '내가 쓰는 중'),
  others: () => h('span', { class: 'chip pink' }, '누군가 쓰는 중'),
  editing: () => h('span', { class: 'chip pink' }, '앞 줄 고치는 중'),
  myEdit: () => h('span', { class: 'chip pink' }, '내 줄 고치는 중'),
};

export function storyView(app, storyId) {
  const route = `/story/${storyId}`;
  let story = null;
  let stamps = {};             // line_id -> { marks, counts, mine }
  let baton = null;            // my claim while writing (or my edit hold: baton.edit)
  let mode = 'idle';           // idle | writing | conflict | done
  let lastResult = null;
  let message = '';
  let messageNew = false;      // a refusal just now (shakes the window once; re-renders of it don't)
  let clockOffset = 0;
  let known = null;            // line ids already shown (to mark new ones)
  let revealedId = null;       // line whose 속성 window is open
  let othersTyping = null;     // live character count of whoever holds the baton
  let notifyFree = false;
  let unwatch = null, ticker = null, typing = null, ro = null;
  let closed = false, claiming = false, linesSig = null;
  let blocker = null, lastBlockerSig = 'null';          // why I can't write here (write_check), shown before pressing 이어 쓰기
  // (read when the box is drawn: the admin's default may arrive, or change, after this window opened)
  let gridPick = api.prefs.get('gridbox');
  // (the admin can keep phones to the ordinary box: then there's no choice to make there)
  const gridOffered = () => !isPhone() || on('grid_box_phone');
  const gridMode = () => gridOffered() && (gridPick == null ? !!X('grid_box_default') : gridPick === '1');
  const serverNow = () => Date.now() + clockOffset;

  const bar = h('div', { class: 'win-bar' });
  const head = h('div', { class: 'story-head', hidden: true });
  const list = h('ol', { class: 'lines' });
  const record = h('div', { class: 'story-record', hidden: true });
  const scroll = h('div', { class: 'win-scroll' }, head, list, record);
  const ticks = h('div', { class: 'stamp-ticks', hidden: true, 'aria-hidden': 'true' });
  const foot = h('div', { class: 'win-foot' });
  // Pressing 취소 / 올리기 must not take the focus from the writing box first: on a phone that
  // drops the keyboard, the page re-lays itself mid-tap and the tap lands somewhere else.
  foot.addEventListener('pointerdown', (e) => {
    const ta = foot.querySelector('textarea');
    if (ta && document.activeElement === ta && e.target.closest('button')) e.preventDefault();
  });
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
      addEventListener('pageshow', onPageShow);
      if (on('typing_count')) typing = api.typingChannel(storyId, (n) => { othersTyping = n; showTyping(); });
      ro = new ResizeObserver(() => placeTicks());
      ro.observe(scroll);
    },
    onFocus() { if (story && mode === 'idle') renderFoot(); },
    // never rebuild the writing box (it would drop the IME composition and close the phone keyboard)
    onSettings() {
      // 누군가 쓰는 중 (n자): join or leave the live count when the switch flips
      if (on('typing_count') && !typing && !closed) typing = api.typingChannel(storyId, (n) => { othersTyping = n; showTyping(); });
      else if (!on('typing_count') && typing) { typing.close(); typing = null; othersTyping = null; }
      if (!story) return; linesSig = null; if (mode === 'writing') { renderBar(); renderLines(); } else renderAll(); },
    unmount() {
      closed = true;
      unwatch?.(); clearInterval(ticker); typing?.close(); ro?.disconnect();
      removeEventListener('pagehide', onPageHide);
      removeEventListener('pageshow', onPageShow);
      if (baton) {
        // closing the window mid-line lets the line go too: the box still gets crumpled into the bin
        iDropped();
        tossToBin(foot.querySelector('.grid-box') ?? foot.querySelector('textarea'), foot.querySelector('textarea')?.value ?? '');
        api.releaseBaton(storyId, baton.token).catch(() => {});
      }
    },
  };

  function onPageHide() { if (baton) api.releaseBatonOnUnload(storyId, baton.token); }
  // back from the browser's page cache (the back button, a phone browser restoring the tab): leaving let
  // the reserved turn go — take it again if it's still free, else say so (the draft is kept either way)
  async function onPageShow(e) {
    if (!e.persisted || !baton || submitting) return;
    try {
      const b = baton.edit ? { ...(await api.beginEdit(storyId, baton.line_id, app.identity())), edit: true, can_delete: baton.can_delete } : await api.claimBaton(storyId, app.identity());
      if (closed || !baton) { api.releaseBaton(storyId, b.token).catch(() => {}); return; }
      baton = b;
      clockOffset = Date.parse(b.server_now) - Date.now();
      tick();
    } catch (err) {
      baton = null; mode = 'idle'; lastResult = null;
      refused(errorText(err));
      renderAll();
    }
    refresh();
  }

  // ---------------------------------------------------------- rendering

  function renderBar() {
    const left = story.max_lines - story.line_count;
    const chip = story.status === 'completed' && !(mode === 'writing' && baton?.edit) ? STATUS_CHIP.completed()
      : mode === 'writing' ? (baton?.edit ? STATUS_CHIP.myEdit() : STATUS_CHIP.mine())
      : story.writing ? (story.editing ? STATUS_CHIP.editing() : STATUS_CHIP.others()) : STATUS_CHIP.open();
    bar.replaceChildren(...[
      chip,
      h('span', {}, `${story.line_count} / ${story.max_lines}줄`),
      story.status === 'open' ? h('span', { class: 'muted' }, `${left}줄 남음 · 한 줄 최대 ${story.max_chars}자`) : null,
      // how many of this story's lines are mine, out of what one person may write here
      app.identity() && blocker?.max != null && story.status === 'open'
        ? h('span', { class: `chip ${blocker.mine >= blocker.max ? 'stone' : 'sky'} my-count`, title: '이 이야기에 내가 쓴 줄 / 한 사람이 쓸 수 있는 줄' }, `내 줄 ${blocker.mine}/${blocker.max}`)
        : null,
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
      h('span', { class: 'line-text' }, l.text,
        l.edited ? h('span', { class: 'edited' }, ' (수정됨)') : l.self_edited ? h('span', { class: 'edited', title: '쓴 사람이 올린 뒤 바로 고친 줄' }, ' (고침)') : null,
        ownTools(l)),
      pad, who);
    return li;
  }

  // 고치기 · 지우기: my newest line, while its few minutes last and nobody has gone on from it
  const editLeft = () => (blocker?.edit ? Date.parse(blocker.edit.until) - serverNow() : 0);
  const ownLine = (l) => (mode === 'idle' || mode === 'done') && !!app.identity() && blocker?.edit?.line_id === l.id && editLeft() > 0;
  const canEdit = (l) => on('self_edit') && blocker?.edit?.can_edit !== false && ownLine(l);
  const canDelete = (l) => on('self_delete') && !!blocker?.edit?.can_delete && ownLine(l);
  function ownTools(l) {
    const ed = canEdit(l), del = canDelete(l);
    if (!ed && !del) return null;
    const left = h('span', { 'data-edit-left': '' }, '');
    return [
      ed ? h('button', { type: 'button', class: 'edit-own', onclick: startEdit, title: '다음 줄이 이어지기 전, 잠깐 동안 고칠 수 있어요' }, '고치기 ', left) : null,
      del ? h('button', { type: 'button', class: 'edit-own del', onclick: () => deleteOwn(l), title: '다음 줄이 이어지기 전, 잠깐 동안 내 줄을 거둬들일 수 있어요' },
        '지우기', ed ? null : [' ', left]) : null,
    ];
  }

  function pendingText() {
    return othersTyping != null && on('typing_count') ? `누군가 쓰는 중 (${othersTyping}자)` : '누군가 쓰는 중';
  }

  function renderLines() {
    // nothing visible changed (the 20 s safety refresh, a bump for someone else's baton…): keep the DOM,
    // so text selection and an open 속성 window survive
    const sig = JSON.stringify([story.status, story.writing, story.editing, mode, revealedId, othersTyping != null, blocker?.edit?.line_id ?? null,
      story.lines.map(l => [l.id, l.text, l.edited, l.self_edited, l.removed]), stamps]);
    if (sig === linesSig) return;
    linesSig = sig;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    const first = known === null;
    const ids = new Set(story.lines.map(l => l.id));
    const items = story.lines.map(l => lineItem(l, !first && !known.has(l.id)));
    if (story.status === 'open' && story.writing && !story.editing && mode !== 'writing') {
      items.push(h('li', { class: 'line pending' },
        h('span', { class: 'line-no' }, pad2(story.line_count + 1)),
        h('span', { class: 'line-text' }, h('span', { 'aria-hidden': 'true' }, '▒▒▒▒▒▒ '), h('span', { 'data-typing': '' }, pendingText()), h('span', { class: 'dots', 'aria-hidden': 'true' }, '…')), h('span')));
    } else if (on('milestones') && story.status === 'open' && story.max_lines - story.line_count === 1 && mode !== 'writing') {
      // the empty last line glows softly until someone takes it
      items.push(h('li', { class: 'line last-slot' },
        h('span', { class: 'line-no' }, pad2(story.max_lines)),
        h('span', { class: 'line-text' }, '마지막 한 줄이 남았어요'), h('span')));
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
    if (!first) typeIn(story.lines.filter((l, i) => items[i]?.classList.contains('is-new')), items);
    renderHead();
    if (first || nearBottom) scroll.scrollTop = story.status === 'completed' && first ? 0 : scroll.scrollHeight;
    placeTicks();
  }

  // new lines type themselves in, letter by letter: someone else's end with a carriage return,
  // my own with the bell (it waits for the typing instead of ringing the moment I press Enter)
  let myLine = null, typingUntil = 0;
  const typingIn = () => on('type_in_lines') && !reduceMotion();
  function typeIn(fresh, items) {
    if (!typingIn()) return;
    for (const l of fresh) {
      if (l.removed) continue;
      const mine = l.id === myLine;
      const li = items[story.lines.indexOf(l)];
      const node = li?.querySelector('.line-text')?.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const chars = [...l.text];
      const step = Math.min(70, Math.max(28, 2200 / chars.length));
      typingUntil = Math.max(typingUntil, Date.now() + chars.length * step);
      let i = 0;
      node.data = '';
      li.classList.add('typing-in');
      const t = setInterval(() => {
        if (closed || !li.isConnected) { clearInterval(t); return; }
        i++;
        node.data = chars.slice(0, i).join('');
        if (i % 2 === 0 && chars[i - 1] !== ' ') play('key', { ch: chars[i - 1] });
        if (i >= chars.length) {
          clearInterval(t);
          li.classList.remove('typing-in');
          if (mine) { myLine = null; play('bell'); } else play('ret');
          bus.emit('carriage', {});
        }
      }, step);
    }
  }

  // 절반 왔어요!: a small note in the window when a story crosses its middle while it's open here
  function milestone(prevCount) {
    if (!on('milestones') || prevCount == null || story.status !== 'open') return;
    const half = Math.ceil(story.max_lines / 2);
    if (!(prevCount < half && story.line_count >= half)) return;
    const win = foot.closest('.win');
    if (!win) return;
    win.querySelector('.milestone')?.remove();
    const note = h('div', { class: 'milestone', role: 'status' },
      h('b', {}, '절반 왔어요!'), h('span', {}, ` ${story.line_count} / ${story.max_lines}줄 · 이제 반환점을 돌아요`));
    win.append(note);
    play('pop');
    setTimeout(() => note.remove(), 4200);
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
        on('reading') ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => app.go(`/read/${storyId}`) }, icon('play', 12), '낭독회 열기') : null,
        h('button', { type: 'button', class: 'btn', onclick: copyLink }, '링크 복사'),
        on('print_sheet') ? h('button', { type: 'button', class: 'btn', onclick: () => printSheets(story) }, '원고지로 인쇄') : null),
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
    if (story.writing && story.editing) {
      status.append(icon('hourglass', 18), h('span', {}, '앞 줄을 쓴 사람이 잠깐 고치는 중이에요'),
        h('span', {}, ' · '), h('span', { 'data-countdown': 'story' }, ''), h('span', {}, ' 남음'));
    } else if (story.writing) {
      status.append(icon('hourglass', 18), h('span', {}, `${story.line_count + 1}번째 줄 — 다른 사람이 쓰는 중이에요`),
        h('span', { 'data-typing-foot': '' }, othersTyping != null && on('typing_count') ? ` (${othersTyping}자)` : ''),
        h('span', {}, ' · '), h('span', { 'data-countdown': 'story' }, ''), h('span', {}, ' 남음'));
    } else if (lastResult?.result === 'accepted') {
      status.append(h('span', {}, '줄이 올라갔어요. 고마워요!'));
    } else if (lastResult?.result === 'edited') {
      status.append(h('span', {}, lastResult.changed ? '줄을 고쳤어요.' : '바뀐 곳이 없어서 그대로 두었어요.'));
    } else if (lastResult?.result === 'deleted') {
      status.append(h('span', {}, `내 줄을 지웠어요. ${lastResult.position}번째 줄이 다시 비었어요.`));
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
      message ? noticeBad()
        : reason ? h('div', { class: 'notice warn' }, errorText(reason)) : null,
      h('div', { class: 'actions', style: 'align-items:center' },
        ident
          ? [h('span', { class: 'muted', style: 'margin-right:auto' }, `${ident.name} 님으로 써요`), notifyBtn,
             h('button', { type: 'button', class: 'btn btn-primary', onclick: claim, disabled: !!reason }, '이어 쓰기')]
          : [notifyBtn, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => app.requireLogin('글을 쓰려면 로그인해 주세요.', route) }, '로그인하고 이어 쓰기')]),
    ];
  }

  // 원고지 writing box: a grid mirror over an invisible textarea (IME, selection, keys keep working).
  // 원고지 칸: the squares are drawn from a real (invisible) textarea that keeps the text, the caret and
  // the IME. On a computer the box lies under the squares and lets every click through to them: a click
  // puts the caret before that square (past the text: at its end), a drag selects, ↑ ↓ move a row and
  // Home / End go to the row's ends, all by the squares on screen rather than the hidden box's own layout.
  function gridBox(ta, max) {
    const cells = h('div', { class: 'grid-cells', 'aria-hidden': 'true' });
    // phones: the hidden-field trick takes away the cursor, the selection handles and the magnifier —
    // there you type in an ordinary box, and the 원고지 above it fills in as you go (a tap on a square
    // still puts the caret there)
    const preview = isPhone();
    const box = h('div', { class: `grid-box${preview ? ' preview' : ''}` }, cells, ta);
    if (!preview) ta.classList.add('grid-input');
    // squares are counted in characters, the textarea in UTF-16 units
    const chars = () => [...ta.value.replace(/\n/g, ' ')];
    const toOff = (i) => [...ta.value].slice(0, i).join('').length;
    const toIdx = (off) => [...ta.value.slice(0, off)].length;
    let queued = false;
    const draw = () => {
      queued = false;
      const cs = chars();
      const focused = document.activeElement === ta;
      const a = toIdx(ta.selectionStart ?? 0), b = toIdx(ta.selectionEnd ?? 0);
      const caret = ta.selectionDirection === 'backward' ? a : b;
      // (the phone preview shows just the rows in use, a row of ten at a time; the desktop box the whole sheet)
      const n = preview ? Math.min(Math.max(max, cs.length + 1), Math.max(10, Math.ceil((cs.length + 1) / 10) * 10)) : Math.max(max, cs.length + 1);
      cells.classList.toggle('is-focused', focused);
      // (the squares are kept and only what changed is touched: no flicker, and a square stays the same
      // element while the mouse is on it)
      while (cells.children.length > n) cells.lastChild.remove();
      while (cells.children.length < n) cells.append(h('span', { dataset: { i: cells.children.length } }));
      for (let i = 0; i < n; i++) {
        const el = cells.children[i];
        const cls = [focused && a === b && i === caret ? 'caret' : '', focused && i >= a && i < b ? 'sel' : '', i >= max ? 'over' : ''].filter(Boolean).join(' ');
        if (el.className !== cls) el.className = cls;
        if (el.textContent !== (cs[i] ?? '')) el.textContent = cs[i] ?? '';
      }
    };
    const redraw = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };

    // which square a point is on: the one under it, else the nearest in that row, else the end
    function indexAt(x, y) {
      const spans = [...cells.children];
      let row = null;
      for (const el of spans) {
        const r = el.getBoundingClientRect();
        if (y < r.top || y >= r.bottom) continue;
        if (x >= r.left && x < r.right) return Number(el.dataset.i);
        row = !row || Math.abs(r.left + r.width / 2 - x) < Math.abs(row.r.left + row.r.width / 2 - x) ? { el, r } : row;
      }
      if (row) return Number(row.el.dataset.i);
      const first = spans[0]?.getBoundingClientRect();
      return first && y < first.top ? 0 : spans.length;
    }
    const clampIdx = (i) => Math.max(0, Math.min(i, chars().length));
    function select(anchor, focus) {
      const [a, b] = anchor <= focus ? [anchor, focus] : [focus, anchor];
      ta.setSelectionRange(toOff(a), toOff(b), focus < anchor ? 'backward' : 'forward');
      redraw();
    }
    function focusBox() { if (document.activeElement !== ta) ta.focus({ preventScroll: true }); }

    if (preview) {
      // (focusing in the click itself is what brings a phone's keyboard up)
      cells.addEventListener('click', (e) => {
        focusBox();
        const i = clampIdx(indexAt(e.clientX, e.clientY));
        select(i, i);
      });
    } else {
      let anchor = null;
      cells.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        focusBox();
        const i = clampIdx(indexAt(e.clientX, e.clientY));
        anchor = e.shiftKey ? toIdx(ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart) : i;
        select(anchor, i);
        cells.setPointerCapture?.(e.pointerId);
      });
      cells.addEventListener('pointermove', (e) => {
        if (anchor == null || !(e.buttons & 1)) return;
        select(anchor, clampIdx(indexAt(e.clientX, e.clientY)));
      });
      const end = () => { anchor = null; };
      cells.addEventListener('pointerup', end);
      cells.addEventListener('pointercancel', end);
      // a double click takes the word under it
      cells.addEventListener('dblclick', (e) => {
        const cs = chars(), i = clampIdx(indexAt(e.clientX, e.clientY));
        if (i >= cs.length || cs[i] === ' ') return;
        let a = i, b = i;
        while (a > 0 && cs[a - 1] !== ' ') a--;
        while (b < cs.length && cs[b] !== ' ') b++;
        select(a, b);
      });
      // ↑ ↓ and Home / End by the rows of squares on screen (the hidden box wraps its own way)
      ta.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229 || e.altKey || e.metaKey || e.ctrlKey) return;
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
        const spans = [...cells.children];
        const top0 = spans[0]?.offsetTop;
        const cols = Math.max(1, spans.findIndex(el => el.offsetTop !== top0) === -1 ? spans.length : spans.findIndex(el => el.offsetTop !== top0));
        const backward = ta.selectionDirection === 'backward';
        const at = toIdx(backward ? ta.selectionStart : ta.selectionEnd);
        const from = toIdx(backward ? ta.selectionEnd : ta.selectionStart);
        const len = chars().length;
        const to = e.key === 'ArrowUp' ? (at - cols < 0 ? 0 : at - cols)
          : e.key === 'ArrowDown' ? Math.min(len, at + cols)
          : e.key === 'Home' ? at - (at % cols)
          : Math.min(len, at - (at % cols) + cols);
        e.preventDefault();
        select(e.shiftKey ? from : to, to);
      });
    }
    for (const ev of ['input', 'keydown', 'keyup', 'select', 'focus', 'blur', 'compositionstart', 'compositionupdate', 'compositionend']) ta.addEventListener(ev, redraw);
    // (a caret moved any other way — the arrow keys, the browser's own select-all — shows up right away too)
    const onSel = () => { if (document.activeElement === ta) redraw(); };
    document.addEventListener('selectionchange', onSel);
    new MutationObserver((_, mo) => { if (!box.isConnected) { document.removeEventListener('selectionchange', onSel); mo.disconnect(); } })
      .observe(foot, { childList: true });
    draw();
    return box;
  }

  function writingFoot() {
    const edit = !!baton.edit;
    const ta = h('textarea', { class: 'field', rows: 2, id: `ta-${storyId}`, value: edit ? baton.text : api.getDraft(storyId), maxlength: baton.max_chars * 2, enterkeyhint: 'send',
      spellcheck: 'true', lang: 'ko', 'aria-describedby': `hint-${storyId}` });
    const counter = h('span', { class: 'counter' });
    const submitBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: submit }, baton.edit ? '고친 줄로 바꾸기' : '올리기');
    const update = () => {
      const n = api.countChars(ta.value);
      const full = n === baton.max_chars && fun('fun_full');
      counter.replaceChildren(...(full ? [gridIcon(14), ` ${n} / ${baton.max_chars}자 꽉!`] : [`${n} / ${baton.max_chars}`]));
      counter.classList.toggle('over', n > baton.max_chars);
      counter.classList.toggle('full', full);
      if (!edit) { api.setDraft(storyId, ta.value); typing?.send(n); }     // (an edit keeps the story's draft, and isn't "someone typing")
    };
    ta.addEventListener('input', update);          // (the key sound is global: js/extras/sound.js)
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
      else if (e.key === 'Enter') e.preventDefault();      // one line only
    });
    update();
    setTimeout(() => ta.focus({ preventScroll: true }));
    const toggleGrid = gridOffered() && h('button', { type: 'button', class: 'btn-link', onclick: () => { gridPick = gridMode() ? '0' : '1'; api.prefs.set('gridbox', gridPick); renderFoot(); } },
      gridMode() ? '보통 칸으로' : '원고지 칸으로');
    return [
      baton.is_final && !edit ? h('div', { class: 'notice warn', style: 'display:flex;gap:10px;align-items:center' }, icon('warn', 20),
        h('span', {}, `이 줄이 이야기의 마지막 줄이에요. ${story.max_lines}줄의 끝을 맺어 주세요.`)) : null,
      h('div', { class: 'status-line' }, icon('hourglass', 18), h('b', {}, edit ? `${baton.position}번째 줄 고치기` : `${baton.position}번째 줄`),
        h('span', { style: 'flex:1' }), h('span', {}, '남은 시간 '), h('b', { 'data-countdown': 'mine' }, '')),
      h('div', { 'data-warnings': '', role: 'status' }),
      h('div', { class: 'label' }, h('span', { class: 'label-row' }, h('span', {}, h('label', { for: ta.id }, edit ? '고칠 줄' : '내 줄'), ' ', toggleGrid),
        counter)),
      gridMode() ? gridBox(ta, baton.max_chars) : ta,
      h('span', { class: 'faint compose-hint', id: `hint-${storyId}` }, composeHint(edit)),
      message ? noticeBad() : null,
      h('div', { class: 'actions' },
        edit && baton.can_delete && on('self_delete')
          ? h('button', { type: 'button', class: 'btn danger own-delete', style: 'margin-right:auto',
              onclick: () => deleteOwn({ id: baton.line_id, position: baton.position, text: baton.text }) }, '이 줄 지우기')
          : null,
        h('button', { type: 'button', class: 'btn', onclick: cancel }, '취소'), submitBtn),
    ];
  }

  function composeHint(edit) {
    const review = on('confirm_post') ? 'Enter를 누르면 원고 검토 창이 떠요.' : 'Enter를 누르면 바로 올라가요.';
    if (edit) return `${review} 시간 안에 바꾸지 않으면 원래 줄 그대로예요.`;
    const ed = on('self_edit'), del = on('self_delete');
    return `${review} ${(ed || del) && X('self_edit_minutes') > 0
      ? `올린 뒤 ${X('self_edit_minutes')}분 동안은, 다음 줄이 이어지기 전까지 ${ed && del ? '고치거나 지울' : ed ? '고칠' : '지울'} 수 있어요.`
      : '올린 뒤에는 고칠 수 없어요.'}`;
  }

  function noticeBad() {
    const n = h('div', { class: `notice bad${messageNew ? '' : ' seen'}`, role: 'alert' }, message);
    messageNew = false;
    return n;
  }
  const refused = (text) => { message = text; messageNew = true; };

  function renderFoot() {
    if (story.status === 'completed' && mode !== 'conflict' && !(mode === 'writing' && baton?.edit)) mode = 'done';
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
      if (baton.edit) { if (left <= 0) notes.push('고칠 수 있는 시간이 지났어요. 취소하면 원래 줄 그대로 남아요.'); }
      else {
        if (left <= 0) notes.push('예약 시간이 지났어요. 그래도 올릴 수 있지만, 그 사이 다른 사람이 먼저 쓰면 충돌로 처리돼요.');
        if (story.head_line_id !== baton.parent_id) notes.push('그 사이 이야기가 바뀌었어요. 올리면 충돌로 처리되어 관리자에게 전달돼요.');
      }
      if (warn && warn.dataset.sig !== notes.join('|')) {
        warn.dataset.sig = notes.join('|');
        warn.replaceChildren(...notes.map(n => h('div', { class: 'notice warn' }, n)));
      }
    }
    const ed = list.querySelector('[data-edit-left]');
    if (ed) {
      const left = editLeft();
      if (left > 0) ed.textContent = fmtCountdown(left);
      else { blocker = blocker ? { ...blocker, edit: null } : blocker; linesSig = null; renderLines(); }
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
        // (a finished story is checked too while its last line can still be fixed)
        ident && mode !== 'writing' && (story?.status !== 'completed'
          || Date.now() - Date.parse(story.completed_at) < (X('self_edit_minutes') + 1) * 60e3)
          ? api.writeCheck(storyId, ident.studentId).then(x => { blocker = x; }).catch(() => {})
          : null]);
      if (closed) return;
      const blockerSig = JSON.stringify(blocker);
      const prevMode = mode, prevWriting = story?.writing, prevStatus = story?.status, prevCount = story?.line_count;
      story = s;
      clockOffset = Date.parse(s.server_now) - Date.now();
      view.setTitle?.(s.title || '제목 없는 이야기');
      if (prevWriting && !s.writing) onFreed();
      renderBar();
      renderLines();
      const blockerChanged = blockerSig !== lastBlockerSig;
      lastBlockerSig = blockerSig;
      if (mode !== 'writing' && (prevMode !== mode || prevWriting !== s.writing || prevStatus !== s.status || prevCount !== s.line_count || blockerChanged || !foot.hasChildNodes())) renderFoot();
      else tick();
      // (a story's last line types itself in first, then the completion)
      if (prevStatus === 'open' && s.status === 'completed') setTimeout(() => { if (!closed) celebrate(); }, Math.max(0, typingUntil - Date.now()) + (typingUntil > Date.now() ? 400 : 0));
      else milestone(prevCount);
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
      refused(errorText(e));
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
    if (!n) { refused(errorText({ code: 'empty_text' })); renderFoot(); return; }
    if (n > baton.max_chars) { refused(errorText({ code: 'too_long', detail: { max: baton.max_chars } })); renderFoot(); return; }
    // 원고 검토: one last look (the line before, this one on 원고지, a hint or two)
    if (on('confirm_post')) {
      submitting = true;
      const before = baton.edit ? story.lines.find(l => l.position === baton.position - 1) : story.lines.at(-1);
      const ok = await reviewLine({ text, prevText: before && !before.removed ? before.text : null, position: baton.position,
        maxChars: baton.max_chars, isFinal: !!baton.is_final && !baton.edit, edit: !!baton.edit });
      submitting = false;
      if (!ok || !baton || closed) { foot.querySelector('textarea')?.focus({ preventScroll: true }); return; }
    }
    if (baton.edit) { await saveEdit(text); return; }
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
        if (typingIn() && r.line_id) myLine = r.line_id;       // the bell rings when it has typed itself in
        else { play('bell'); bus.emit('carriage', {}); }
        bus.emit('my-line', { storyId });
        mode = r.story_status === 'completed' ? 'done' : 'idle';
      } else {
        mode = 'conflict';
      }
      await refresh();
      renderFoot();
    } catch (e) {
      refused(errorText(e));
      if (e.code === 'story_closed') { baton = null; mode = 'done'; await refresh(); }
      renderFoot();
    } finally {
      submitting = false;
    }
  }

  async function saveEdit(text) {
    submitting = true;
    foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const r = await api.saveEdit(storyId, baton.line_id, text, baton.token, app.identity());
      baton = null; mode = 'idle'; message = '';
      lastResult = { result: 'edited', changed: r.changed };
      play(r.changed ? 'stamp' : 'select');
      await refresh();
      renderFoot();
    } catch (e) {
      refused(errorText(e));
      if (e.code === 'edit_too_late' || e.code === 'not_your_line') { baton = null; mode = 'idle'; await refresh(); }
      renderFoot();
    } finally { submitting = false; }
  }

  // 고치기 → the writing box, filled with my line; the next line is held for me meanwhile
  async function startEdit() {
    const ident = app.identity();
    if (!ident || claiming || !blocker?.edit) return;
    claiming = true;
    try {
      const e = await api.beginEdit(storyId, blocker.edit.line_id, ident);
      if (closed) { api.releaseBaton(storyId, e.token).catch(() => {}); return; }
      baton = { ...e, edit: true, can_delete: !!blocker?.edit?.can_delete };
      clockOffset = Date.parse(e.server_now) - Date.now();
      mode = 'writing'; lastResult = null; message = '';
      play('select');
      renderAll();
    } catch (err) {
      refused(errorText(err));
      blocker = blocker ? { ...blocker, edit: null } : blocker;
      renderAll();
      refresh();
    } finally { claiming = false; }
  }

  // 지우기: take my newest line back altogether (from the line, or from the 고치기 box); the story steps
  // back one line and the spot is free again. The line crumples into the 휴지통 (which doesn't count it).
  async function deleteOwn(l) {
    const ident = app.identity();
    if (!ident || claiming || submitting) return;
    const ok = await osConfirm(`${l.position}번째 줄을 지울까요?\n\n「${l.text}」\n\n지운 줄은 되돌릴 수 없어요. 이 자리는 다시 비어서 누구나 (나도) 이어 쓸 수 있어요.`,
      { title: '내 줄 지우기', danger: true, ok: '지우기' });
    if (!ok || closed) return;
    claiming = true;
    try {
      await api.deleteOwnLine(storyId, l.id, ident);
      const li = list.querySelector(`.line[data-id="${l.id}"]`);
      if (!tossToBin(li?.querySelector('.line-text') ?? li, l.text, { count: false })) play('select');
      baton = null; mode = 'idle'; message = '';
      lastResult = { result: 'deleted', position: l.position };
      blocker = blocker ? { ...blocker, edit: null } : blocker;
      bus.emit('my-line', { storyId });
      await refresh();
      renderAll();
    } catch (e) {
      refused(errorText(e));
      if (['edit_too_late', 'not_your_line', 'first_line', 'line_not_found'].includes(e.code)) {
        if (baton?.edit) { const b = baton; baton = null; api.releaseBaton(storyId, b.token).catch(() => {}); }
        mode = 'idle';
        blocker = blocker ? { ...blocker, edit: null } : blocker;
        await refresh();
      }
      renderAll();
    } finally { claiming = false; }
  }

  async function cancel() {
    if (baton?.edit) {                              // (letting go of an edit is no 휴지통 moment: the line stays as it was)
      const b = baton;
      baton = null; mode = 'idle'; lastResult = null; message = '';
      renderAll();
      try { await api.releaseBaton(storyId, b.token); } catch { /* expires anyway */ }
      refresh();
      return;
    }
    // the writing box crumples up and lands in the 휴지통 (just a picture: the draft is kept)
    if (baton) iDropped();
    tossToBin(foot.querySelector('.grid-box') ?? foot.querySelector('textarea'), foot.querySelector('textarea')?.value ?? '');
    const b = baton;
    baton = null; mode = 'idle'; lastResult = null; message = '';
    typing?.send(null);
    renderAll();
    if (b) { try { await api.releaseBaton(storyId, b.token); } catch { /* expires anyway */ } }
    refresh();
  }

  return view;
}
