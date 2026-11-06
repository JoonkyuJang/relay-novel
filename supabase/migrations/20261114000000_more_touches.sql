-- =====================================================================
-- More touches (2026-11-06): new 부가 기능 switches, all on by default, and two read-only RPCs.
--   coffee_rings        늦은 밤(0~6시)에 쓴 줄마다 바탕화면에 커피 자국 (오래된 건 옅어져요)
--   cat_mischief        고양이가 가끔 장난: 붙임쪽지 밀기 · 휴지통 쓰러뜨리기
--   cat_gifts           고양이가 가끔 선물을 두고 가요 (이 기기의 선물함)
--   guestbook_plane     방명록 글이 종이비행기로 접혀 날아가요
--   stamp_ink           도장을 연달아 찍으면 인주가 옅어지고, 다시 묻혀요
--   stamp_card          내가 쓴 줄에 도장 수첩 (작은 업적)
--   recap               마감 뒤 "2026 가을 결산" 창
--   deadline_fireworks  마지막 날 완결마다 학생회관 위로 불꽃 · 마지막 한 시간
--   desk_patterns       각자 바탕 무늬 고르기
--   window_shade        제목 막대 오른쪽 클릭 → 말아 올리기
--   tab_icon            다른 탭에 있을 때, 열어 둔 이야기에서 누가 쓰기 시작하면 탭 아이콘이 깜빡여요
-- RPCs: night_rings() (late-night lines: id + time only), season_recap() (totals, no names);
-- my_lines() now also says whether a line ended its story and filled every 칸.
-- =====================================================================

create or replace function app.extras_defaults()
returns jsonb language sql immutable set search_path = '' as $$
  select $json${
 "crt_default": true,
 "boot_screen": true,
 "presence": true,
 "deadline_on": true,
 "deadline": "2026-11-23T00:00:00+09:00",
 "context_menu": true,
 "minimize": true,
 "trash": true,
 "memo": true,
 "first_sentence": true,
 "typing_count": true,
 "notify_free": true,
 "grid_box_default": false,
 "about": true,
 "daynight": true,
 "daynight_override": true,
 "moon_phase": true,
 "saver_typing": true,
 "saver_typing_min": 3,
 "saver_stars": true,
 "saver_stars_min": 6,
 "cat_sleep": true,
 "cat_sleep_min": 10,
 "saver_completed_only": true,
 "saver_phone": true,
 "saver_typewriter": false,
 "cat": true,
 "cat_name": "문냥이",
 "cat_wander": true,
 "cat_pet_count": true,
 "cat_reach": true,
 "cat_belly": true,
 "cat_wink": true,
 "cat_jump": true,
 "cat_phone": true,
 "stamps": true,
 "stamp_size": 24,
 "stamp_ticks": true,
 "stamp_help": true,
 "reading": true,
 "reading_voice": true,
 "manuscript": true,
 "relay_record": true,
 "completion_fx": true,
 "reading_credits": true,
 "sound": true,
 "sound_default": false,
 "fun": true,
 "fun_full": true,
 "fun_amber": true,
 "fun_meow": true,
 "fun_trash": true,
 "fun_clock": true,
 "fun_tidy": true,
 "fun_seosi": true,
 "fun_eagle": true,
 "fun_catreads": true,
 "title_required": true,
 "deadline_closes": false,
 "print_sheet": true,
 "my_lines": true,
 "error_reports": true,
 "zoom_rects": true,
 "shake_on_error": true,
 "press_buttons": true,
 "pixel_cursor": true,
 "type_in_lines": true,
 "milestones": true,
 "ticker": true,
 "cat_typing": true,
 "cat_seal_nap": true,
 "skyline": true,
 "seasons": true,
 "snow_from": "2026-12-01T00:00:00+09:00",
 "trash_toss": true,
 "trash_phone": true,
 "coffee_rings": true,
 "cat_mischief": true,
 "cat_gifts": true,
 "guestbook_plane": true,
 "stamp_ink": true,
 "stamp_card": true,
 "recap": true,
 "deadline_fireworks": true,
 "desk_patterns": true,
 "window_shade": true,
 "tab_icon": true
}$json$::jsonb
$$;

-- 커피 자국: the most recent lines written between midnight and 6 a.m. (Seoul) — no text, no names
create function public.night_rings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'at', r.created_at) order by r.created_at), '[]'::jsonb)
    from (select l.id, l.created_at
            from app.lines l join app.stories s on s.id = l.story_id
           where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null
             and extract(hour from l.created_at at time zone 'Asia/Seoul') < 6
           order by l.created_at desc
           limit 400) r;
$$;

-- 결산: the season in numbers (lines and titles, never names or 학번)
create function public.season_recap()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  with ls as (
    select l.*, s.title, s.status, (l.created_at at time zone 'Asia/Seoul') as kst
      from app.lines l join app.stories s on s.id = l.story_id
     where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null)
  select jsonb_build_object(
    'stories',   (select count(*) from app.stories where deleted_at is null),
    'completed', (select count(*) from app.stories where deleted_at is null and status = 'completed'),
    'lines',     (select count(*) from ls),
    'chars',     (select coalesce(sum(char_length(text)), 0) from ls),
    'writers',   (select count(distinct student_id) from ls),
    'stamps',    (select count(*) from app.stamps st join ls on ls.id = st.line_id),
    'guestbook', (select count(*) from app.guestbook where deleted_at is null),
    'trash',     (select value from app.counters where key = 'trash'),
    'cat_pets',  (select value from app.counters where key = 'cat_pets'),
    'night_lines', (select count(*) from ls where extract(hour from kst) < 6),
    'latest_night', (select to_char(max(kst::time) filter (where extract(hour from kst) < 6), 'HH24:MI') from ls),
    'busiest_hour', (select jsonb_build_object('hour', h, 'lines', n) from (
        select extract(hour from kst)::int h, count(*) n from ls group by 1 order by 2 desc, 1 limit 1) x),
    'busiest_day', (select jsonb_build_object('day', to_char(d, 'MM.DD'), 'lines', n) from (
        select kst::date d, count(*) n from ls group by 1 order by 2 desc, 1 limit 1) x),
    'first_line', (select jsonb_build_object('text', text, 'title', title) from ls order by created_at limit 1),
    'most_stamped', (select jsonb_build_object('text', ls.text, 'title', ls.title, 'position', ls.depth, 'stamps', count(*))
        from ls join app.stamps st on st.line_id = ls.id group by ls.id, ls.text, ls.title, ls.depth, ls.created_at order by count(*) desc, ls.created_at limit 1),
    'fastest', (select jsonb_build_object('title', title, 'minutes', round(extract(epoch from completed_at - created_at) / 60))
        from app.stories where deleted_at is null and status = 'completed' and completed_at is not null
        order by completed_at - created_at limit 1),
    'most_writers', (select jsonb_build_object('title', title, 'writers', count(distinct student_id))
        from ls group by story_id, title order by count(distinct student_id) desc, min(created_at) limit 1)
  ) into v;
  return v;
end $$;

-- 도장 수첩 needs two more facts per line: did it end its story, did it fill every 칸
create or replace function public.my_lines(p_student_id text, p_name text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sid text; v_name text; v jsonb; st app.settings;
begin
  if not coalesce((app.extras()->>'my_lines')::boolean, true) then perform app.err('feature_off'); end if;
  v_sid  := app.clean_sid(p_student_id);
  v_name := app.clean_name(p_name);
  select * into st from app.settings where id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_id', l.id, 'story_id', s.id, 'title', s.title, 'status', s.status,
           'position', l.depth, 'text', l.text, 'created_at', l.created_at,
           'last', s.status = 'completed' and l.depth = coalesce(s.max_lines, st.max_lines),
           'full', char_length(l.text) = coalesce(s.max_chars, st.max_chars),
           'stamps', (select jsonb_build_object(
                        'sun',   count(*) filter (where st2.kind = 'sun'),
                        'laugh', count(*) filter (where st2.kind = 'laugh'),
                        'cur',   count(*) filter (where st2.kind = 'cur'))
                      from app.stamps st2 where st2.line_id = l.id))
           order by l.created_at desc), '[]'::jsonb)
    into v
    from app.lines l join app.stories s on s.id = l.story_id
   where l.student_id = v_sid and l.author_name = v_name
     and l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null;
  return v;
end $$;

revoke all on function public.night_rings() from public, anon, authenticated;
grant execute on function public.night_rings() to anon, authenticated;
revoke all on function public.season_recap() from public, anon, authenticated;
grant execute on function public.season_recap() to anon, authenticated;
