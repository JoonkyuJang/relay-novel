// 부가 기능: switches (from settings.extras, mirrored defaults) and a tiny event bus.
//
// Events (bus.emit / bus.on):
//   'line-added'      { storyId, line }          a new line appeared in a story window
//   'story-completed' { storyId, title, lastLine, el }   a story finished while open here
//   'activity'        {}                         user input (keys, pointer, touch)
//   'settings'        {}                         extras changed
//   'theme'           {}                         amber / day-night changed
//   'my-line'         { storyId }                this tab just posted a line (the ticker skips it)
//   'carriage'        {}                         a carriage return sounded (the cat's ears twitch)

export const DEFAULTS = {
  crt_default: true, boot_screen: true, presence: true,
  deadline_on: true, deadline: '2026-11-23T00:00:00+09:00', deadline_closes: false,
  print_sheet: true, my_lines: true, error_reports: true,
  context_menu: true, minimize: true, trash: true, memo: true,
  first_sentence: true, typing_count: true, notify_free: true,
  grid_box_default: false, about: true,
  daynight: true, daynight_override: true, moon_phase: true,
  saver_typing: true, saver_typing_min: 3, saver_stars: true, saver_stars_min: 6,
  cat_sleep: true, cat_sleep_min: 10, saver_completed_only: true, saver_phone: true, saver_typewriter: false,
  cat: true, cat_name: '문냥이', cat_wander: true, cat_pet_count: true,
  cat_reach: true, cat_belly: true, cat_wink: true, cat_jump: true, cat_phone: true,
  stamps: true, stamp_size: 24, stamp_ticks: true, stamp_help: true,
  reading: true, reading_voice: true, manuscript: true, relay_record: true,
  completion_fx: true, reading_credits: true,
  sound: true, sound_default: false,
  fun: true, fun_full: true, fun_amber: true, fun_meow: true, fun_trash: true,
  fun_clock: true, fun_tidy: true, fun_seosi: true, fun_eagle: true, fun_catreads: true,
  title_required: true,
  zoom_rects: true, shake_on_error: true, press_buttons: true, pixel_cursor: true,
  type_in_lines: true, milestones: true, ticker: true, cat_typing: true, cat_seal_nap: true,
  skyline: true, seasons: true, snow_from: '2026-12-01T00:00:00+09:00',
  trash_toss: true, trash_phone: true,
};

let current = { ...DEFAULTS };

export function setExtras(x) {
  current = { ...DEFAULTS, ...(x ?? {}) };
  bus.emit('settings', {});
}
export const X = (key) => current[key];
export const on = (key) => !!current[key];
// hidden surprises need both the master switch and their own
export const fun = (key) => !!current.fun && !!current[key];
export const all = () => ({ ...current });

const target = new EventTarget();
export const bus = {
  on(type, fn) { const f = (e) => fn(e.detail); target.addEventListener(type, f); return () => target.removeEventListener(type, f); },
  emit(type, detail) { target.dispatchEvent(new CustomEvent(type, { detail })); },
};

// Seoul wall-clock parts for any instant (the club lives on KST).
export function kst(d = new Date()) {
  const t = new Date(d.getTime() + 9 * 3600e3);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), min: t.getUTCMinutes(), s: t.getUTCSeconds(), wd: t.getUTCDay() };
}
export const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

// 원고지 매수 (200자 원고지, spaces count).
export const manuscript = (chars) => Math.round((chars / 200) * 10) / 10;

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// 받침에 맞는 '예요/이에요' (고양이 이름이 바뀌어도 자연스럽게).
export function yeyo(word) {
  const c = (word ?? '').codePointAt(word.length - 1) - 0xAC00;
  return c >= 0 && c < 11172 && c % 28 ? `${word}이에요` : `${word}예요`;
}

// The admin can let the deadline close writing (the server enforces it too).
export const deadlinePassed = (now = Date.now()) =>
  !!current.deadline_closes && !Number.isNaN(Date.parse(current.deadline)) && now >= Date.parse(current.deadline);

// 첫눈: after the admin's date (KST), the leaves give way to snow.
export const winter = (now = Date.now()) => !Number.isNaN(Date.parse(current.snow_from)) && now >= Date.parse(current.snow_from);
