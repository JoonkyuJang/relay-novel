// The only file that talks to the backend. The stage-2 UI can be rebuilt
// freely on top of these functions.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------------------------------------------------------------- errors

export class ApiError extends Error {
  constructor(code, detail = null, cause = null) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.cause = cause;
  }
}

function toApiError(error) {
  // Our functions raise SQLSTATE P0001 with message = code, details = JSON.
  if (error?.code === 'P0001') {
    let detail = null;
    try { detail = error.details ? JSON.parse(error.details) : null; } catch { /* ignore */ }
    return new ApiError(error.message, detail, error);
  }
  if (error?.code === '42501') return new ApiError('permission_denied', null, error);
  if (!error?.code) return new ApiError('network', null, error);
  return new ApiError('unknown', { message: error.message, code: error.code }, error);
}

async function call(fn, args = {}) {
  let res;
  try { res = await sb.rpc(fn, args); }
  catch (e) { throw new ApiError('network', null, e); }
  if (res.error) throw toApiError(res.error);
  return res.data;
}

// ---------------------------------------------------------------- local storage (best effort)

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function clientToken() {
  let t = store.get('rn.client');
  if (!t) {
    t = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store.set('rn.client', t);
  }
  return t;
}

export function getIdentity() {
  return { name: store.get('rn.name') ?? '', studentId: store.get('rn.sid') ?? '' };
}
export function setIdentity({ name, studentId }) {
  store.set('rn.name', name);
  store.set('rn.sid', studentId);
}

export function getDraft(storyId) { return store.get(`rn.draft.${storyId}`) ?? ''; }
export function setDraft(storyId, text) { store.set(`rn.draft.${storyId}`, text || null); }

// ---------------------------------------------------------------- text rules (mirror the server)

export function cleanLine(s) {
  return (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}
export function countChars(s) {
  return [...cleanLine(s)].length;           // code points, same as Postgres char_length
}

// ---------------------------------------------------------------- public API

export const getSettings = () => call('get_public_settings');
export const listStories = () => call('list_stories');
export const getStory = (storyId) => call('get_story', { p_story_id: storyId });
export const publicStats = () => call('public_stats');

export function createStory({ title, text, name, studentId }) {
  return call('create_story', {
    p_title: title ?? null, p_text: text, p_name: name, p_student_id: studentId,
    p_client: clientToken(),
  });
}

export function claimBaton(storyId, { name, studentId }) {
  return call('claim_baton', {
    p_story_id: storyId, p_name: name, p_student_id: studentId, p_client: clientToken(),
  });
}

export const releaseBaton = (storyId, token) =>
  call('release_baton', { p_story_id: storyId, p_token: token });

// Fire-and-forget release that survives page unload.
export function releaseBatonOnUnload(storyId, token) {
  try {
    fetch(`${SUPABASE_URL}/rest/v1/rpc/release_baton`, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify({ p_story_id: storyId, p_token: token }),
    });
  } catch { /* the baton simply expires */ }
}

// -> { result: 'accepted', line_id, position, story_status }
//  | { result: 'conflict', line_id, position, reason: 'stale_parent' | 'baton_taken' }
export function submitLine(storyId, { parentId, text, name, studentId, token }) {
  return call('submit_line', {
    p_story_id: storyId, p_parent_id: parentId, p_text: text,
    p_name: name, p_student_id: studentId, p_client: clientToken(), p_token: token ?? null,
  });
}

// ---------------------------------------------------------------- live updates

// Calls onChange() (debounced) whenever one of `keys` changes on the server,
// plus a slow poll and on tab focus as a safety net. Returns an unsubscribe fn.
export function watch(keys, onChange, { pollMs = 20000, onStatus } = {}) {
  let t = null;
  const fire = () => { clearTimeout(t); t = setTimeout(onChange, 250); };
  const ch = sb.channel(`signals-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'realtime_signals' },
      (p) => { if (keys.includes(p.new?.key)) fire(); })
    .subscribe((status) => onStatus?.(status));
  const timer = setInterval(fire, pollMs);
  const onVis = () => { if (!document.hidden) fire(); };
  document.addEventListener('visibilitychange', onVis);
  return () => {
    sb.removeChannel(ch); clearInterval(timer); clearTimeout(t);
    document.removeEventListener('visibilitychange', onVis);
  };
}

// ---------------------------------------------------------------- admin

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new ApiError('login_failed', { message: error.message }, error);
}
export const signOut = () => sb.auth.signOut();
export async function currentUser() {
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}
export const isAdmin = () => call('is_admin');

export const admin = {
  getSettings:       ()            => call('admin_get_settings'),
  updateSettings:    (patch)       => call('admin_update_settings', { p: patch }),
  listStories:       ()            => call('admin_list_stories'),
  getStory:          (id)          => call('admin_get_story', { p_story_id: id }),
  updateStory:       (id, patch)   => call('admin_update_story', { p_story_id: id, p: patch }),
  setStoryDeleted:   (id, deleted) => call('admin_set_story_deleted', { p_story_id: id, p_deleted: deleted }),
  releaseBaton:      (id)          => call('admin_release_baton', { p_story_id: id }),
  editLine:          (id, text)    => call('admin_edit_line', { p_line_id: id, p_text: text }),
  setLineDeleted:    (id, deleted) => call('admin_set_line_deleted', { p_line_id: id, p_deleted: deleted }),
  setHead:           (lineId)      => call('admin_set_head', { p_line_id: lineId }),
  replaceLine:       (lineId)      => call('admin_replace_line', { p_line_id: lineId }),
  setConflictStatus: (id, status)  => call('admin_set_conflict_status', { p_line_id: id, p_status: status }),
  listConflicts:     ()            => call('admin_list_conflicts'),
  stats:             ()            => call('admin_stats'),
  log:               (limit = 100) => call('admin_log_recent', { p_limit: limit }),
  exportAll:         ()            => call('admin_export'),
};
