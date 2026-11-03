// Small DOM + text helpers shared by the barebones pages.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const MESSAGES = {
  network:             () => '서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.',
  submissions_closed:  () => '지금은 글쓰기가 닫혀 있어요.',
  new_stories_closed:  () => '지금은 새 이야기를 시작할 수 없어요.',
  invalid_name:        () => '이름을 1~20자로 입력해 주세요.',
  invalid_student_id:  () => '학번을 확인해 주세요. (숫자/영문, 20자 이내)',
  empty_text:          () => '내용을 입력해 주세요.',
  too_long:            (d) => `한 줄은 최대 ${d?.max}자까지 쓸 수 있어요.`,
  title_too_long:      (d) => `제목은 최대 ${d?.max}자까지 쓸 수 있어요.`,
  story_limit:         (d) => `이야기는 한 사람당 ${d?.max}개까지 시작할 수 있어요.`,
  story_not_found:     () => '이야기를 찾을 수 없어요.',
  story_closed:        () => '이미 완결된 이야기예요.',
  baton_held:          () => '다른 사람이 이어 쓰는 중이에요. 잠시 후 다시 시도해 주세요.',
  person_limit:        (d) => `이 이야기에는 한 사람당 ${d?.max}줄까지 쓸 수 있어요.`,
  invalid_parent:      () => '이야기가 바뀌었어요. 새로고침해 주세요.',
  too_many_conflicts:  () => '관리자 확인을 기다리는 줄이 너무 많아요.',
  stats_hidden:        () => '통계는 아직 공개되지 않았어요.',
  not_admin:           () => 'This account is not an admin.',
  permission_denied:   () => 'Permission denied.',
  login_failed:        (d) => `Login failed: ${d?.message ?? ''}`,
  raise_max_lines_first: () => 'This story is at its line limit. Raise its max lines first.',
  use_set_head:        () => 'No official line at that position. Use "set as head" instead.',
  parent_not_canonical:() => "This line's parent is not on the official path.",
};

export function errorText(err) {
  const f = MESSAGES[err?.code];
  if (f) return f(err.detail);
  console.error(err);
  return `오류가 발생했어요 (${err?.code ?? err?.message ?? 'unknown'})`;
}
