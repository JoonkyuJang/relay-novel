// The only file that talks to the backend (plus small local-storage helpers).
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// Every request gives up after 20 s (a phone on shaky campus wifi could otherwise leave a request —
// and the button waiting on it — hanging forever); it then fails like any network error.
const patientFetch = (url, opts = {}) =>
  (!opts.signal && typeof AbortSignal.timeout === 'function') ? fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }) : fetch(url, opts);
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  global: { fetch: patientFetch },
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

// Requests the person is waiting on (made within a second of a click or key) mark the page busy,
// so the pixel cursor can show its hourglass; background refreshes never do.
let lastGesture = 0, waiting = 0, busyT = null;
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { lastGesture = Date.now(); }, { capture: true, passive: true });
// …and whether anyone has been around lately at all (see the sweep below)
let lastSeen = Date.now();
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, () => { lastSeen = Date.now(); }, { capture: true, passive: true });
function busy(d) {
  waiting += d;
  clearTimeout(busyT);
  if (waiting > 0) busyT = setTimeout(() => document.documentElement.classList.add('rn-busy'), 300);
  else document.documentElement.classList.remove('rn-busy');
}

async function call(fn, args = {}) {
  const felt = Date.now() - lastGesture < 1000;
  if (felt) busy(1);
  let res;
  try { res = await sb.rpc(fn, args); }
  catch (e) { throw new ApiError('network', null, e); }
  finally { if (felt) busy(-1); }
  if (res.error) throw toApiError(res.error);
  return res.data;
}

// ---------------------------------------------------------------- local storage (best effort)

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};
export const prefs = {
  get: (k, d = null) => { const v = store.get(`rn.${k}`); return v == null ? d : v; },
  set: (k, v) => store.set(`rn.${k}`, v == null ? null : String(v)),
  getJSON: (k) => { try { return JSON.parse(store.get(`rn.${k}`)); } catch { return null; } },
  setJSON: (k, v) => store.set(`rn.${k}`, v == null ? null : JSON.stringify(v)),
};

export function clientToken() {
  let t = store.get('rn.client');
  if (!t) {
    t = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store.set('rn.client', t);
  }
  return t;
}

// Honor-system identity, kept on this device only.
export function getIdentity() {
  const name = store.get('rn.name'); const studentId = store.get('rn.sid');
  return name && studentId ? { name, studentId } : null;
}
export function setIdentity({ name, studentId }) {
  store.set('rn.name', name); store.set('rn.sid', studentId); store.set('rn.guest', null);
}
export function logout() { store.set('rn.name', null); store.set('rn.sid', null); store.set('rn.guest', null); }
export const isGuest = () => store.get('rn.guest') === '1';
export const setGuest = () => store.set('rn.guest', '1');
export const hasEntered = () => !!getIdentity() || isGuest();

export function getDraft(key) { return store.get(`rn.draft.${key}`) ?? ''; }
export function setDraft(key, text) { store.set(`rn.draft.${key}`, text || null); }

// ---------------------------------------------------------------- text rules (mirror the server)

export function cleanLine(s) {
  return (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}
export function countChars(s) {
  return [...cleanLine(s)].length;           // code points, same as Postgres char_length
}
export function cleanName(s) { return cleanLine(s); }
export function cleanStudentId(s) {
  return (s ?? '').normalize('NFKC').replace(/[\s-]/g, '').toUpperCase();
}
export function identityProblem({ name, studentId }) {
  const n = [...cleanName(name)].length;
  if (n < 1 || n > 20) return 'invalid_name';
  if (!/^[0-9A-Z]{1,20}$/.test(cleanStudentId(studentId))) return 'invalid_student_id';
  return null;
}

// ---------------------------------------------------------------- public API

export const getSettings = () => call('get_public_settings');
// Several windows (서랍, the ticker, the screen saver…) refetch the list on the same signal:
// they share one request per 'list' change. onStories(fn) hears every fresh list.
let listing = null, listGen = 0;
const listHearers = new Set();
export function listStories() {
  if (listing && listing.gen === listGen && Date.now() - listing.at < 5000) return listing.p;
  const p = call('list_stories');
  listing = { p, gen: listGen, at: Date.now() };
  p.then(list => listHearers.forEach(fn => { try { fn(list); } catch { /* a hearer's own problem */ } }), () => { listing = null; });
  return p;
}
export function onStories(fn) { listHearers.add(fn); return () => listHearers.delete(fn); }
export const getStory = (storyId) => call('get_story', { p_story_id: storyId });
export const publicStats = () => call('public_stats');

export async function createStory({ title, text, name, studentId }) {
  const r = await call('create_story', {
    p_title: title ?? null, p_text: text, p_name: name, p_student_id: studentId,
    p_client: clientToken(),
  });
  poke(['list']);
  return r;
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
export async function submitLine(storyId, { parentId, text, name, studentId, token }) {
  const r = await call('submit_line', {
    p_story_id: storyId, p_parent_id: parentId, p_text: text,
    p_name: name, p_student_id: studentId, p_client: clientToken(), p_token: token ?? null,
  });
  poke(['list']);
  return r;
}

// 방명록 -> { total, items: [{ id, no, text, author_name, student_id, created_at }], has_more }
export const listGuestbook = ({ before = null, limit = 30 } = {}) =>
  call('list_guestbook', { p_before: before, p_limit: limit });
export function postGuestbook(text, { name, studentId }) {
  return call('post_guestbook', { p_text: text, p_name: name, p_student_id: studentId, p_client: clientToken() });
}

// ---------------------------------------------------------------- 부가 기능

export function toggleStamp(lineId, kind, { name, studentId }) {
  return call('toggle_stamp', { p_line_id: lineId, p_kind: kind, p_name: name, p_student_id: studentId, p_client: clientToken() });
}
// -> { <line_id>: { marks: [[kind, x, y, rot]], counts: {sun, laugh, cur}, mine: [kind] } }
// "mine" = stamps by this 이름 + 학번 (from any device)
export const getStoryStamps = (storyId, ident = null) =>
  call('get_story_stamps', { p_story_id: storyId, p_student_id: ident?.studentId ?? null, p_name: ident?.name ?? null });
// Why this person can't write in this story right now: null, or { code, detail }
export const writeCheck = (storyId, studentId) => call('write_check', { p_story_id: storyId, p_student_id: studentId });
export const petCat = () => call('pet_cat');
export const storyCards = () => call('story_cards');
export const getAbout = () => call('get_about');
export const getCounters = () => call('get_counters');
export const nightRings = () => call('night_rings');
export const seasonRecap = () => call('season_recap');
// 내가 쓴 줄: every line written as this 이름 + 학번 (any device)
export const myLines = ({ name, studentId }) => call('my_lines', { p_student_id: studentId, p_name: name });
// Crash report (fire and forget; never throws)
export function logClientError({ message, source = null, stack = null, version = null }) {
  try {
    sb.rpc('log_client_error', { p_message: message, p_source: source, p_stack: stack, p_version: version,
      p_agent: navigator.userAgent.slice(0, 200), p_client: clientToken() }).then(() => {}, () => {});
  } catch { /* ignore */ }
}

// Live "누군가 쓰는 중 (23자)": a Realtime broadcast per story, numbers only.
export function typingChannel(storyId, onCount) {
  let ch = null, joined = false;
  try {
    ch = sb.channel(`typing:${storyId}`, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'n' }, ({ payload }) => onCount?.(payload?.n ?? null))
      .subscribe((status) => { joined = status === 'SUBSCRIBED'; });
  } catch { ch = null; }
  let last = 0, timer = null, pending = null;
  return {
    send(n) {                                  // throttled to ~3 per second
      pending = n;
      if (timer) return;
      const wait = Math.max(0, 350 - (Date.now() - last));
      timer = setTimeout(() => {
        timer = null; last = Date.now();
        // only over the live connection: without it supabase-js would POST every count over HTTP
        if (joined) ch?.send({ type: 'broadcast', event: 'n', payload: { n: pending } }).catch?.(() => {});
      }, wait);
    },
    close() { clearTimeout(timer); try { ch && sb.removeChannel(ch); } catch { /* ignore */ } },
  };
}

// Refresh this tab's own windows right after its own writes (no need to wait for Realtime).
export function poke(keys) {
  if (keys.includes('list')) listGen++;
  for (const s of subscribers) if (s.keys.some(k => keys.includes(k))) notify(s);
}

// ---------------------------------------------------------------- live updates (one shared channel)

const subscribers = new Set();
let channel = null;
let live = false;                         // realtime channel subscribed
const POLL_MS = 20000;                    // version check (one tiny request)
const SWEEP_MS = 120000;                  // full refresh, for time-based changes (expired batons)
const versions = new Map();               // signal key -> last seen version
const seenEmpty = new Set();              // watched keys the server had no row for
let bgWatch = false;                      // keep the tiny version check going in a background tab
export const watchInBackground = (v) => { bgWatch = !!v; };

function notify(sub, jitter = 0) {
  clearTimeout(sub.t);
  sub.t = setTimeout(() => sub.fn(), 250 + Math.random() * jitter);
}
function notifyKey(key) {
  if (key === 'list') listGen++;
  // 'list' is watched by many windows on every client: spread those refetches out a little
  for (const s of subscribers) if (s.keys.includes(key)) notify(s, key === 'list' ? 1500 : 0);
}
// Ask only "which watched keys changed?" and notify just those subscribers.
let checking = false;
async function checkVersions() {
  if (checking || !subscribers.size) return;
  checking = true;
  try {
    const keys = [...new Set([...subscribers].flatMap(s => s.keys))];
    const { data, error } = await sb.from('realtime_signals').select('key,version,updated_at').in('key', keys);
    if (error || !data) return;
    for (const { key, version, updated_at: at } of data) {
      const prev = versions.get(key);
      versions.set(key, version);
      if (prev !== undefined ? prev !== version : seenEmpty.has(key)) { notifyKey(key); continue; }
      // First sighting of a key: a window that just opened fetched its data a moment before this check.
      // If the key changed around or after that moment, that fetch may have missed it: fetch once more.
      // (3 s of slack for clock differences between the phone and the server.)
      if (prev === undefined && at) {
        const changed = Date.parse(at);
        for (const s of subscribers) if (s.keys.includes(key) && changed >= s.since - 3000) notify(s);
      }
    }
    // keys with no row yet (nothing has happened there so far, e.g. a fresh 방명록 after 초기화):
    // when their first row shows up, that is a change too
    // (and a row that vanished — a story removed by 관리 · 초기화 — is a change for its windows)
    const got = new Set(data.map(r => r.key));
    for (const k of keys) {
      if (got.has(k)) { seenEmpty.delete(k); continue; }
      seenEmpty.add(k);
      if (versions.has(k)) { versions.delete(k); notifyKey(k); }
    }
  } catch { /* next round */ } finally { checking = false; }
}
function ensureChannel() {
  if (channel) return;
  channel = sb.channel('signals')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'realtime_signals' }, (p) => {
      const key = p.new?.key ?? p.old?.key;          // (a deleted row only carries its key in old)
      if (!key) return;
      if (p.new?.version != null) versions.set(key, p.new.version); else versions.delete(key);
      notifyKey(key);
    })
    .subscribe((status) => { live = status === 'SUBSCRIBED'; });
  // Safety nets: a cheap version check (every 20 s, or 60 s while realtime is up) and a slow
  // full sweep; on returning to the tab, check right away.
  let n = 0;
  setInterval(() => {
    if (document.hidden && !bgWatch) return;
    n++;
    // the full sweep only while someone is around (a tab left open overnight keeps just the tiny version check)
    if (n % (SWEEP_MS / POLL_MS) === 0) { if (Date.now() - lastSeen < 15 * 60e3) subscribers.forEach(s => notify(s, 3000)); return; }
    if (!live || n % 3 === 0) checkVersions();
  }, POLL_MS);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > SWEEP_MS) subscribers.forEach(s => notify(s, 1000));
    else checkVersions();
  });
}

// Calls fn() (debounced) whenever one of `keys` changes on the server. Returns unsubscribe.
export function watch(keys, fn) {
  ensureChannel();
  const sub = { keys, fn, t: null, since: Date.now() };
  subscribers.add(sub);
  setTimeout(checkVersions, 1000);        // learn the starting versions
  return () => { clearTimeout(sub.t); subscribers.delete(sub); };
}

// Number of people with the site open right now (Realtime presence). Calls onCount(n).
export function presence(onCount) {
  try {
    const ch = sb.channel('lobby', { config: { presence: { key: clientToken() } } });
    ch.on('presence', { event: 'sync' }, () => onCount(Object.keys(ch.presenceState()).length))
      .subscribe((status) => { if (status === 'SUBSCRIBED') ch.track({ at: Date.now() }).catch(() => {}); });
  } catch { /* optional */ }
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
  listGuestbook:     ()            => call('admin_list_guestbook', {}),
  setGuestbookDeleted: (id, deleted) => call('admin_set_guestbook_deleted', { p_id: id, p_deleted: deleted }),
  lineStamps:        (lineId)      => call('admin_line_stamps', { p_line_id: lineId }),
  clientErrors:      (limit = 200) => call('admin_client_errors', { p_limit: limit }),
  resetCounts:       ()            => call('admin_reset_counts'),
  reset:             (what)        => call('admin_reset', { p_what: what }),
};
