-- =====================================================================
-- Before launch, round 2 (2026-11-05)
--  * Stamps belong to the same 이름 + 학번 on any device (phone and computer),
--    instead of the device that stamped. "mine" needs both too.
--  * write_check(): why this person can't write here right now (or null),
--    so 이어 쓰기 can explain itself before it's pressed.
--  * The deadline can close writing: extras.deadline_closes (default off).
--    After the deadline nobody can start a story or claim a line; whoever
--    already holds a reservation may still post it.
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
 "deadline_closes": false
}$json$::jsonb
$$;

create function app.deadline_passed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((app.extras()->>'deadline_closes')::boolean, false)
     and now() >= (app.extras()->>'deadline')::timestamptz
$$;

create or replace function public.claim_baton(
  p_story_id uuid, p_name text, p_student_id text, p_client text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st          app.settings;
  s           app.stories;
  v_name      text;
  v_sid       text;
  v_max_lines int;
  v_max_chars int;
  v_token     uuid;
  v_exp       timestamptz;
  v_freed     text[];
begin
  select * into st from app.settings where id;
  if not st.submissions_open then perform app.err('submissions_closed'); end if;
  if app.deadline_passed() then perform app.err('deadline_passed'); end if;

  v_name := app.clean_name(p_name);
  v_sid  := app.clean_sid(p_student_id);

  -- one claim at a time per person (also serializes the "one baton per person" rule below)
  perform pg_advisory_xact_lock(hashtextextended('baton:' || v_sid, 0));

  select * into s from app.stories
   where id = p_story_id and deleted_at is null for update;
  if not found then perform app.err('story_not_found'); end if;

  v_max_lines := coalesce(s.max_lines, st.max_lines);
  v_max_chars := coalesce(s.max_chars, st.max_chars);

  if s.status <> 'open' or s.line_count >= v_max_lines then
    perform app.err('story_closed');
  end if;

  if s.baton_expires_at > now() and s.baton_sid <> v_sid then
    perform app.err('baton_held', jsonb_build_object('expires_at', s.baton_expires_at));
  end if;

  if app.person_lines(s.id, v_sid) >= st.lines_per_person_per_story then
    perform app.err('person_limit', jsonb_build_object('max', st.lines_per_person_per_story));
  end if;

  if not st.allow_consecutive_lines and exists (
       select 1 from app.lines where id = s.head_line_id and student_id = v_sid) then
    perform app.err('consecutive');
  end if;

  if s.baton_sid = v_sid and s.baton_expires_at > now() then
    -- already mine: same token, same deadline (a double tap or a reload can't extend it)
    v_token := s.baton_token;
    v_exp   := s.baton_expires_at;
  else
    -- one baton per person: let go of any other story this person is holding
    with x as (
      update app.stories
         set baton_token = null, baton_name = null, baton_sid = null,
             baton_client = null, baton_expires_at = null
       where baton_sid = v_sid and id <> s.id and baton_expires_at > now()
      returning id)
    select array_agg(id::text) into v_freed from x;
    if v_freed is not null then perform app.bump(array['list'] || v_freed); end if;

    v_token := gen_random_uuid();
    v_exp   := now() + make_interval(secs => st.baton_seconds);

    update app.stories
       set baton_token = v_token, baton_name = v_name, baton_sid = v_sid,
           baton_client = app.clean_client(p_client), baton_expires_at = v_exp
     where id = s.id;

    perform app.bump(array['list', s.id::text]);
  end if;
  return jsonb_build_object(
    'token',      v_token,
    'expires_at', v_exp,
    'server_now', now(),
    'parent_id',  s.head_line_id,
    'position',   s.line_count + 1,
    'max_lines',  v_max_lines,
    'max_chars',  v_max_chars,
    'is_final',   s.line_count + 1 >= v_max_lines
  );
end $$;

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
  if app.deadline_passed() then perform app.err('deadline_passed'); end if;
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

-- ---------------------------------------------------------------------
-- Stamps: owned by 이름 + 학번
-- ---------------------------------------------------------------------

create or replace function public.toggle_stamp(
  p_line_id uuid, p_kind text, p_name text, p_student_id text, p_client text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  l app.lines; v_name text; v_sid text; v_client text; v_on boolean; v_counts jsonb; v_owner text;
begin
  if not (app.extras()->>'stamps')::boolean then perform app.err('feature_off'); end if;
  if p_kind not in ('sun', 'laugh', 'cur') then perform app.err('invalid_kind'); end if;
  v_name   := app.clean_name(p_name);
  v_sid    := app.clean_sid(p_student_id);
  v_client := app.clean_client(p_client);

  select ln.* into l from app.lines ln join app.stories s on s.id = ln.story_id
   where ln.id = p_line_id and ln.kind = 'canonical' and ln.deleted_at is null and s.deleted_at is null;
  if not found then perform app.err('line_not_found'); end if;

  perform pg_advisory_xact_lock(hashtext('stamp:' || v_sid));
  select author_name into v_owner from app.stamps
   where line_id = l.id and kind = p_kind and student_id = v_sid;
  if found then
    if v_owner is distinct from v_name then perform app.err('not_your_stamp'); end if;   -- same 이름 + 학번, any device
    delete from app.stamps where line_id = l.id and kind = p_kind and student_id = v_sid;
    v_on := false;
  else
    if (select count(*) from app.stamps where line_id = l.id) >= 300 then perform app.err('stamp_limit'); end if;
    insert into app.stamps(line_id, story_id, kind, author_name, student_id, client_token, x, y, rot)
    values (l.id, l.story_id, p_kind, v_name, v_sid, v_client,
            random(), random(), (random() * 50 - 25)::smallint);
    v_on := true;
  end if;

  select jsonb_build_object(
           'sun',   count(*) filter (where kind = 'sun'),
           'laugh', count(*) filter (where kind = 'laugh'),
           'cur',   count(*) filter (where kind = 'cur'))
    into v_counts from app.stamps where line_id = l.id;

  perform app.bump(array[l.story_id::text]);
  return jsonb_build_object('stamped', v_on, 'kind', p_kind, 'counts', v_counts);
end $$;

drop function public.get_story_stamps(uuid, text, text);
create function public.get_story_stamps(
  p_story_id uuid, p_student_id text default null, p_client text default null, p_name text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(x.line_id, jsonb_build_object(
           'marks', x.marks, 'counts', x.counts, 'mine', x.mine)), '{}'::jsonb)
  from (
    select st.line_id,
           jsonb_agg(jsonb_build_array(st.kind, round(st.x::numeric, 3), round(st.y::numeric, 3), st.rot)
                     order by st.created_at) as marks,
           jsonb_build_object(
             'sun',   count(*) filter (where st.kind = 'sun'),
             'laugh', count(*) filter (where st.kind = 'laugh'),
             'cur',   count(*) filter (where st.kind = 'cur')) as counts,
           coalesce(jsonb_agg(st.kind) filter (
             where p_student_id is not null and p_name is not null
               and st.student_id = upper(regexp_replace(normalize(p_student_id, nfkc), '[\s-]', '', 'g'))
               and st.author_name = app.clean_text(p_name)),
             '[]'::jsonb) as mine
    from app.stamps st
    join app.lines l on l.id = st.line_id
    join app.stories s on s.id = st.story_id
    where st.story_id = p_story_id and l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null
    group by st.line_id
  ) x
$$;

-- ---------------------------------------------------------------------
-- write_check: null = you may write here now; otherwise {code, detail}
-- (the same reasons claim_baton would give, without claiming anything)
-- ---------------------------------------------------------------------

create function public.write_check(p_story_id uuid, p_student_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  st app.settings; s app.stories; v_sid text;
begin
  select * into st from app.settings where id;
  if not st.submissions_open then return jsonb_build_object('code', 'submissions_closed'); end if;
  if app.deadline_passed() then return jsonb_build_object('code', 'deadline_passed'); end if;
  select * into s from app.stories where id = p_story_id and deleted_at is null;
  if not found then return jsonb_build_object('code', 'story_not_found'); end if;
  if s.status <> 'open' or s.line_count >= coalesce(s.max_lines, st.max_lines) then
    return jsonb_build_object('code', 'story_closed');
  end if;
  v_sid := upper(regexp_replace(normalize(coalesce(p_student_id, ''), nfkc), '[\s-]', '', 'g'));
  if v_sid = '' then return null; end if;
  if s.baton_expires_at > now() and s.baton_sid <> v_sid then
    return jsonb_build_object('code', 'baton_held', 'detail', jsonb_build_object('expires_at', s.baton_expires_at));
  end if;
  if app.person_lines(s.id, v_sid) >= st.lines_per_person_per_story then
    return jsonb_build_object('code', 'person_limit', 'detail', jsonb_build_object('max', st.lines_per_person_per_story));
  end if;
  if not st.allow_consecutive_lines and exists (
       select 1 from app.lines where id = s.head_line_id and student_id = v_sid) then
    return jsonb_build_object('code', 'consecutive');
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------

revoke all on function app.deadline_passed() from public, anon, authenticated;
revoke all on function public.get_story_stamps(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.get_story_stamps(uuid, text, text, text) to anon, authenticated;
revoke all on function public.write_check(uuid, text) from public, anon, authenticated;
grant execute on function public.write_check(uuid, text) to anon, authenticated;
