// Small DOM + text helpers shared by every page.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && !k.includes('-')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------ pixel icons (static, trusted markup)

const ICONS = {
  logo:   '<path fill-rule="evenodd" d="M8 1l7 7-7 7-7-7zM8 5l-3 3 3 3 3-3z" fill="currentColor"/>',
  folder: '<path data-fill d="M1.5 4.5h5l1 1h7v9h-13z" fill="#FFF9EF" stroke="currentColor"/><path d="M1.5 6.5h13" stroke="currentColor"/>',
  newdoc: '<path data-fill d="M3.5 1.5h7l3 3v10h-10z" fill="#FFF9EF" stroke="currentColor"/><path d="M10.5 1.5v3h3" fill="none" stroke="currentColor"/><path d="M5 12l1-3 4-4 2 2-4 4z" fill="currentColor"/>',
  roster: '<path data-fill d="M2.5 2.5h11v12h-11z" fill="#FFF9EF" stroke="currentColor"/><path d="M6 1h4v3H6z" fill="currentColor"/><path d="M4 6.5h2M7 6.5h5M4 9.5h2M7 9.5h5M4 12.5h2M7 12.5h5" stroke="currentColor"/>',
  book:   '<path data-fill d="M1.5 3.5h6v10h-6zM8.5 3.5h6v10h-6z" fill="#FFF9EF" stroke="currentColor"/><path d="M3 6.5h3M3 8.5h3M3 10.5h2M10 6.5h3M10 8.5h3" stroke="currentColor"/><path d="M7.5 14.5h1" stroke="currentColor"/>',
  person: '<path d="M5.5 1.5h5v5h-5z"/><path d="M2.5 14.5v-4l2-2h7l2 2v4z"/>',
  hourglass: '<path d="M3 1.5h10M3 14.5h10" stroke="currentColor"/><path d="M4.5 1.5h7L8 8l3.5 6.5h-7L8 8z" fill="#FFF9EF" stroke="currentColor"/><path d="M6 13.5h4L8 10.5z" fill="currentColor"/>',
  warn:   '<path d="M8 1.5l6.5 12.5h-13z" fill="#FFF9EF" stroke="currentColor"/><path d="M7.5 6h1v4h-1zM7.5 11h1v1h-1z" fill="currentColor" stroke="currentColor"/>',
  disk:   '<path d="M2.5 2.5h8l3 3v8h-11z" fill="#FFF9EF" stroke="currentColor"/><path d="M5 5h5v3H5z" fill="currentColor"/><path d="M4.5 10.5h7" stroke="currentColor"/>',
  // media buttons (phones would turn ▶ ⏮ ⏭ into colour emoji)
  play:   '<path d="M3 2h2v1h2v1h2v1h2v1h2v4h-2v1h-2v1H7v1H5v1H3z" fill="currentColor"/>',
  pause:  '<path d="M3 2h4v12H3zM9 2h4v12H9z" fill="currentColor"/>',
  prev:   '<path d="M2 2h2v12H2zM14 2h-2v1h-2v1H8v1H6v1H5v4h1v1h2v1h2v1h2v1h2z" fill="currentColor"/>',
  next:   '<path d="M12 2h2v12h-2zM2 2h2v1h2v1h2v1h2v1h1v4h-1v1H8v1H6v1H4v1H2z" fill="currentColor"/>',
};
export function icon(name, size = 16) {
  const t = document.createElement('template');
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}

// ------------------------------------------------------------ time

export function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtClock(d = new Date()) {
  return `${d.toLocaleDateString('ko-KR', { weekday: 'short' })} ${d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}`;
}
export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function relTime(ts, now = Date.now()) {
  if (!ts) return '';
  const diff = (now - Date.parse(ts)) / 1000;
  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 172800) return '어제';
  const d = new Date(ts);
  return `${d.getMonth() + 1}.${d.getDate()}`;
}

// ------------------------------------------------------------ properties popup (desktop) / sheet (phone)

let openProps = null;        // { el, anchor, onClose, pinned }
let hoverTimer = null;
const isPhone = () => window.matchMedia('(max-width: 767px)').matches;
const canHover = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches && !isPhone();

export function closeProps() {
  clearTimeout(hoverTimer);
  if (!openProps) return;
  const { el, anchor, onClose } = openProps;
  openProps = null;
  el.remove();
  anchor?.setAttribute('aria-expanded', 'false');
  onClose?.();
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', onEsc, true);
}
function outside(e) {
  if (!openProps) return;
  if (openProps.el.contains(e.target) || openProps.anchor?.contains(e.target)) return;
  closeProps();
}
function onEsc(e) { if (e.key === 'Escape') { const a = openProps?.anchor; closeProps(); a?.focus(); } }

function showProps(anchor, spec, pinned) {
  closeProps();
  const phone = isPhone();
  const el = h('div', { class: `props${phone ? ' sheet' : ''}${spec.extra ? ' wide' : ''}`, role: 'dialog', 'aria-label': spec.title },
    h('div', { class: 'props-title stripes' }, h('span', {}, spec.title)),
    h('dl', {}, spec.rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    spec.extra?.() ?? null);
  document.body.append(el);
  if (!phone) {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, ht = el.offsetHeight;
    let left = r.right + 10, top = r.top - 6;
    if (left + w > innerWidth - 8) left = Math.max(8, r.left - w - 10);
    if (top + ht > innerHeight - 8) top = Math.max(36, innerHeight - ht - 8);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  }
  el.addEventListener('pointerenter', () => clearTimeout(hoverTimer));
  el.addEventListener('pointerleave', () => scheduleClose());
  anchor.setAttribute('aria-expanded', 'true');
  openProps = { el, anchor, onClose: spec.onClose, pinned };
  spec.onOpen?.();
  document.addEventListener('keydown', onEsc, true);
  setTimeout(() => document.addEventListener('pointerdown', outside, true));   // not the opening click
}
function scheduleClose() {
  clearTimeout(hoverTimer);
  if (openProps && !openProps.pinned) hoverTimer = setTimeout(closeProps, 180);
}

// Writer reveal for `anchor`: hover shows it on desktop (click pins it); tap/click/Enter
// toggles it everywhere. getSpec() -> { title, rows: [[label, value]], onOpen?, onClose? }
export function attachReveal(anchor, getSpec) {
  anchor.addEventListener('click', (e) => {
    clearTimeout(hoverTimer);
    if (openProps?.anchor === anchor) {
      if (!openProps.pinned && canHover()) { openProps.pinned = true; return; }   // hovered -> pin
      closeProps(); return;
    }
    showProps(anchor, getSpec(), true);
    // opened from the keyboard (Enter/Space): move focus in, so the stamp buttons are reachable
    if (e.detail === 0) openProps?.el.querySelector('button')?.focus();
  });
  anchor.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || !canHover()) return;
    clearTimeout(hoverTimer);
    if (openProps?.anchor === anchor) return;
    if (openProps?.pinned) return;               // don't replace a pinned window on fly-over
    hoverTimer = setTimeout(() => { if (openProps?.anchor !== anchor) showProps(anchor, getSpec(), false); }, 60);
  });
  anchor.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (openProps?.anchor === anchor) scheduleClose(); else clearTimeout(hoverTimer);
  });
}

// ------------------------------------------------------------ messages

const MESSAGES = {
  network:             () => '서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.',
  rate_limited:        () => '지금 너무 많은 글이 한꺼번에 올라오고 있어요. 잠시 후 다시 시도해 주세요.',
  submissions_closed:  () => '지금은 글쓰기가 닫혀 있어요.',
  new_stories_closed:  () => '지금은 새 이야기를 시작할 수 없어요.',
  invalid_name:        () => '이름을 1~20자로 입력해 주세요.',
  invalid_student_id:  () => '학번을 확인해 주세요. (숫자/영문, 20자 이내)',
  empty_text:          () => '내용을 입력해 주세요.',
  too_long:            (d) => `최대 ${d?.max}자까지 쓸 수 있어요.`,
  title_required:      () => '제목을 붙여 주세요.',
  title_too_long:      (d) => `제목은 최대 ${d?.max}자까지 쓸 수 있어요.`,
  story_limit:         (d) => `이야기는 한 사람당 ${d?.max}개까지 시작할 수 있어요.`,
  story_not_found:     () => '이야기를 찾을 수 없어요.',
  story_closed:        () => '이미 완결된 이야기예요.',
  baton_held:          (d) => {
    const min = d?.expires_at ? Math.max(1, Math.ceil((Date.parse(d.expires_at) - Date.now()) / 60000)) : null;
    return `다른 사람이 이어 쓰는 중이에요.${min ? ` 늦어도 ${min}분 안에 자리가 나요.` : ' 잠시 후 다시 해 주세요.'}`;
  },
  person_limit:        (d) => `이 이야기에는 한 사람당 ${d?.max}줄까지 쓸 수 있어요. 다른 이야기를 이어 써 주세요.`,
  consecutive:         () => '바로 앞 줄을 쓴 사람은 연달아 쓸 수 없어요. 다른 사람이 한 줄 이은 뒤에 다시 써 주세요.',
  invalid_parent:      () => '이야기가 바뀌었어요. 새로고침해 주세요.',
  too_many_conflicts:  () => '관리자 확인을 기다리는 줄이 너무 많아요.',
  stats_hidden:        () => '출석부는 아직 공개되지 않았어요.',
  guestbook_closed:    () => '지금은 방명록이 닫혀 있어요.',
  cooldown:            (d) => `${d?.wait ?? 30}초 뒤에 다시 남길 수 있어요.`,
  not_found:           () => '찾을 수 없어요.',
  not_admin:           () => '관리자 권한이 없어요.',
  permission_denied:   () => '권한이 없어요. 다시 로그인해 주세요.',
  login_failed:        () => '로그인 정보를 확인해 주세요.',
  raise_max_lines_first: () => '이 이야기는 줄 수 한도에 도달했어요. 먼저 한도를 늘려 주세요.',
  use_set_head:        () => '그 자리에 정식 줄이 없어요. "여기를 끝으로"를 써 주세요.',
  parent_not_canonical:() => '이 줄의 앞 줄이 정식 줄이 아니에요.',
  already_canonical:   () => '이미 정식 줄이에요.',
  broken_tree:         () => '줄 연결이 끊겨 있어요.',
  invalid_status:      () => '잘못된 상태예요.',
  line_not_found:      () => '줄을 찾을 수 없어요.',
  feature_off:         () => '지금은 꺼져 있는 기능이에요.',
  invalid_kind:        () => '알 수 없는 도장이에요.',
  invalid_settings:    () => '설정 값을 확인해 주세요.',
  not_your_stamp:      () => '다른 이름으로 찍힌 도장이에요. 찍을 때와 같은 이름과 학번으로 로그인해야 지울 수 있어요.',
  deadline_passed:     () => '마감 시간이 지나 이제 새로 쓸 수 없어요. 함께 써 주셔서 고마워요!',
  stamp_limit:         () => '이 줄에는 도장을 더 찍을 수 없어요.',
  invalid_reset:       () => '무엇을 초기화할지 골라 주세요.',
  unknown:             () => '알 수 없는 오류가 생겼어요. 잠시 후 다시 해 주세요.',
};

export function errorText(err) {
  const f = MESSAGES[err?.code];
  if (f) return f(err.detail);
  console.error(err);
  return MESSAGES.unknown();
}

// ------------------------------------------------------------ 연문회 OS dialogs (confirm / prompt)

// osDialog({ title, message, input: { value, label, multiline } | null, ok, cancel, danger })
// -> Promise<true | false> for confirm, Promise<string | null> for prompt.
export function osDialog({ title = '연문회 OS', message = '', input = null, ok = '확인', cancel = '취소', danger = false } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    let field = null;
    if (input) {
      field = input.multiline
        ? h('textarea', { class: 'field', rows: 3, value: input.value ?? '', 'aria-label': input.label ?? title })
        : h('input', { type: input.type ?? 'text', class: 'field', value: input.value ?? '', 'aria-label': input.label ?? title });
    }
    const done = (v) => { modal.remove(); document.removeEventListener('keydown', onKey, true); prevFocus?.focus?.(); resolve(v); };
    const okBtn = h('button', { type: 'button', class: `btn btn-primary${danger ? ' danger' : ''}`, onclick: () => done(field ? field.value : true) }, ok);
    const cancelBtn = h('button', { type: 'button', class: 'btn', onclick: () => done(field ? null : false) }, cancel);
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    const box = h('div', { class: 'win is-active dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'win-title' }, h('span', { class: 'win-title-pad' }), h('h2', { id: titleId }, title), h('span', { class: 'win-title-pad' })),
      h('div', { class: 'dialog-body' },
        message ? h('p', {}, message) : null,
        field,
        h('div', { class: 'btn-row', style: 'justify-content:flex-end' }, cancelBtn, okBtn)));
    const modal = h('div', { class: 'modal', onclick: (e) => { if (e.target === modal) done(field ? null : false); } }, box);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done(field ? null : false); }
      else if (e.key === 'Enter' && !e.isComposing && e.target === field && field.tagName !== 'TEXTAREA') { e.preventDefault(); okBtn.click(); }
      else if (e.key === 'Tab') {                          // keep focus inside the dialog
        const f = [...box.querySelectorAll('button, input, textarea')];
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(modal);
    dispatchEvent(new CustomEvent('rn-sound', { detail: 'alert' }));
    (field ?? okBtn).focus();
    if (field?.select) field.select();
  });
}
export const osConfirm = (message, opts = {}) => osDialog({ message, ...opts });
export const osPrompt = (message, value = '', opts = {}) => osDialog({ ...opts, message, input: { value, ...(opts.input ?? {}) } });
