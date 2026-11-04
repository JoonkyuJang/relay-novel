-- 새 이야기 제목 필수 (toggle: extras.title_required, default on; 관리 · 설정).
-- Adds the key to app.extras_defaults() and checks it in create_story.

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
 "title_required": true
}$json$::jsonb
$$;

create or replace function public.create_story(
  p_title text, p_text text, p_name text, p_student_id text, p_client text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st      app.settings;
  v_title text;
  v_text  text;
  v_name  text;
  v_sid   text;
  v_story uuid;
  v_line  uuid;
  v_count int;
  v_done  boolean;
begin
  select * into st from app.settings where id;
  if not st.submissions_open  then perform app.err('submissions_closed'); end if;
  if not st.allow_new_stories then perform app.err('new_stories_closed'); end if;

  v_name  := app.clean_name(p_name);
  v_sid   := app.clean_sid(p_student_id);
  v_text  := app.clean_text(p_text);
  v_title := nullif(app.clean_text(p_title), '');

  if v_text = '' then perform app.err('empty_text'); end if;
  if char_length(v_text) > st.max_chars then
    perform app.err('too_long', jsonb_build_object('max', st.max_chars));
  end if;
  if v_title is null and (app.extras()->>'title_required')::boolean then
    perform app.err('title_required');
  end if;
  if v_title is not null and char_length(v_title) > st.max_title_chars then
    perform app.err('title_too_long', jsonb_build_object('max', st.max_title_chars));
  end if;

  -- serialize story creation per person so the cap can't be raced
  perform pg_advisory_xact_lock(hashtextextended('starter:' || v_sid, 0));

  select count(*) into v_count
  from app.lines l join app.stories s on s.id = l.story_id
  where l.depth = 1 and l.kind = 'canonical' and l.student_id = v_sid
    and l.deleted_at is null and s.deleted_at is null;
  if v_count >= st.stories_started_per_person then
    perform app.err('story_limit', jsonb_build_object('max', st.stories_started_per_person));
  end if;

  v_done := st.max_lines <= 1;

  insert into app.stories (title) values (v_title) returning id into v_story;
  insert into app.lines (story_id, parent_id, depth, text, author_name, student_id, client_token, kind)
  values (v_story, null, 1, v_text, v_name, v_sid, app.clean_client(p_client), 'canonical')
  returning id into v_line;

  update app.stories
     set head_line_id = v_line, line_count = 1,
         status = case when v_done then 'completed' else 'open' end,
         completed_at = case when v_done then now() end
   where id = v_story;

  perform app.bump(array['list', v_story::text]);
  return jsonb_build_object('story_id', v_story, 'line_id', v_line);
end $$;
