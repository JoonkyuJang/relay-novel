-- =====================================================================
-- Little touches (2026-11-05): new 부가 기능 switches, all on by default.
--   zoom_rects      창이 열리고 닫힐 때 점선 테두리가 확대 · 축소
--   shake_on_error  안 되는 일(잘못된 학번, 쓰는 중인 줄…)에 창이 도리도리 + 삑
--   press_buttons   버튼이 눌리는 느낌
--   pixel_cursor    픽셀 마우스 커서 (화살표 · 손 · 모래시계)
--   type_in_lines   다른 사람의 새 줄이 한 글자씩 타자로 찍혀요
--   milestones      절반 · 마지막 한 줄 알림
--   ticker          메뉴 막대에 "방금 이어졌어요"
--   cat_typing      글을 쓰면 고양이가 창 아래에서 지켜봐요
--   cat_seal_nap    고양이가 가끔 완결 도장 위에서 낮잠
--   skyline         바탕화면 아래 학생회관 (낮 · 노을 · 밤)
--   seasons         가을 낙엽, snow_from 이후 첫눈
--   snow_from       첫눈 날짜
-- admin_update_settings: snow_from must be a date, like deadline.
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
 "snow_from": "2026-12-01T00:00:00+09:00"
}$json$::jsonb
$$;

create or replace function public.admin_update_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare before jsonb; after jsonb; st app.settings; v_extras jsonb;
begin
  perform app.require_admin();
  select to_jsonb(s) - 'id' into before from app.settings s where id;

  v_extras := p->'extras';
  if v_extras is not null and jsonb_typeof(v_extras) <> 'object' then
    perform app.err('invalid_settings');
  end if;
  -- only known keys, with the same json type as the default
  if v_extras is not null and exists (
    select 1 from jsonb_each(v_extras) e
    where not (app.extras_defaults() ? e.key)
       or jsonb_typeof(e.value) <> jsonb_typeof(app.extras_defaults()->e.key)) then
    perform app.err('invalid_settings');
  end if;
  -- sane values for the few free-form extras
  if v_extras is not null then
    if exists (select 1 from jsonb_each(v_extras) e
               where jsonb_typeof(e.value) = 'number'
                 and ((e.value)::numeric < 0 or (e.value)::numeric > 1440)) then
      perform app.err('invalid_settings');
    end if;
    if v_extras ? 'stamp_size' and (v_extras->>'stamp_size')::numeric not between 12 and 48 then
      perform app.err('invalid_settings');
    end if;
    if v_extras ? 'cat_name' and char_length(btrim(v_extras->>'cat_name')) not between 1 and 20 then
      perform app.err('invalid_settings');
    end if;
    -- the date extras must be real dates
    begin
      perform (v_extras->>'deadline')::timestamptz, (v_extras->>'snow_from')::timestamptz;
    exception when others then
      perform app.err('invalid_settings');
    end;
  end if;

  update app.settings set
    max_lines                  = coalesce((p->>'max_lines')::int,                  max_lines),
    max_chars                  = coalesce((p->>'max_chars')::int,                  max_chars),
    max_title_chars            = coalesce((p->>'max_title_chars')::int,            max_title_chars),
    lines_per_person_per_story = coalesce((p->>'lines_per_person_per_story')::int, lines_per_person_per_story),
    stories_started_per_person = coalesce((p->>'stories_started_per_person')::int, stories_started_per_person),
    baton_seconds              = coalesce((p->>'baton_seconds')::int,              baton_seconds),
    show_student_id            = coalesce((p->>'show_student_id')::boolean,        show_student_id),
    stats_public               = coalesce((p->>'stats_public')::boolean,           stats_public),
    likes_enabled              = coalesce((p->>'likes_enabled')::boolean,          likes_enabled),
    submissions_open           = coalesce((p->>'submissions_open')::boolean,       submissions_open),
    allow_new_stories          = coalesce((p->>'allow_new_stories')::boolean,      allow_new_stories),
    export_credits             = coalesce(p->>'export_credits',                    export_credits),
    guestbook_open             = coalesce((p->>'guestbook_open')::boolean,         guestbook_open),
    guestbook_max_chars        = coalesce((p->>'guestbook_max_chars')::int,        guestbook_max_chars),
    guestbook_cooldown_seconds = coalesce((p->>'guestbook_cooldown_seconds')::int, guestbook_cooldown_seconds),
    allow_consecutive_lines    = coalesce((p->>'allow_consecutive_lines')::boolean, allow_consecutive_lines),
    extras                     = extras || coalesce(v_extras, '{}'::jsonb),
    updated_at                 = now()
  where id
  returning * into st;

  update app.stories s
     set status = 'completed', completed_at = now(),
         baton_token = null, baton_name = null, baton_sid = null,
         baton_client = null, baton_expires_at = null
   where s.status = 'open' and s.deleted_at is null
     and s.line_count >= coalesce(s.max_lines, st.max_lines);

  select to_jsonb(s) - 'id' into after from app.settings s where id;
  perform app.log('update_settings', null, jsonb_build_object('before', before, 'after', after));
  perform app.bump(array['list', 'admin', 'settings', 'guestbook']);
  return after || jsonb_build_object('extras', app.extras());
end $$;
