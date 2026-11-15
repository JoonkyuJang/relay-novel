-- =====================================================================
-- 고치기 · 학번 가리기 · 사용 설명서 (2026-11-15)
--  * 고치기: the writer of a story's newest line may fix it for a few minutes (settings: self_edit,
--    self_edit_minutes) as long as nobody has written after it or holds the next line. Pressing 고치기
--    holds the next line for them (others see "앞 줄을 고치는 중"), up to the end of the window + 1 min.
--    The first version of the line is kept (lines.original_text, as for admin edits); the line shows "(고침)".
--  * 학번: besides on / off (show_student_id), the admin can show it masked (2026••••01): extras.sid_mask.
--    Every place that shows 학번 to participants goes through app.public_sid().
--  * my_lines also tells how far each story has gone (내 줄 뒤로 n줄 이어졌어요).
--  * new switches: confirm_post (원고 검토), guide (사용 설명서), notify_after_me.
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
 "tab_icon": true,
 "proposals": true,
 "proposals_per_person": 2,
 "proposal_likes": true,
 "proposal_likes_public": true,
 "proposal_sort": "likes",
 "proposal_badge": "admin",
 "proposal_withdraw": true,
 "proposals_close_at_deadline": false,
 "proposal_notice": true,
 "stamp_adopted": true,
 "flood_lines": 300,
 "flood_stories": 60,
 "flood_guestbook": 60,
 "self_edit": true,
 "self_edit_minutes": 5,
 "confirm_post": true,
 "sid_mask": false,
 "guide": true,
 "notify_after_me": true
}$json$::jsonb
$$;

alter table app.stories add column baton_edit boolean not null default false;
alter table app.lines   add column self_edited_at timestamptz;      -- (lines.original_text already keeps the first version)

-- A held turn is an edit hold only when begin_edit says so (in its own transaction); any other change of
-- the token (이어 쓰기, release, expiry take-over, admin) makes it an ordinary turn again.
create function app.baton_kind()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.baton_token is distinct from old.baton_token then
    new.baton_edit := new.baton_token is not null and coalesce(current_setting('app.edit_hold', true), '') = '1';
  end if;
  return new;
end $$;
create trigger stories_baton_kind before update of baton_token on app.stories
  for each row execute function app.baton_kind();

-- 휴지통 counts turns let go without a line — an edit hold going away isn't one
create or replace function app.count_trash()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.baton_token is not null and not old.baton_edit
     and new.baton_token is distinct from old.baton_token
     and (new.baton_token is null or old.baton_expires_at <= now())
     and new.line_count = old.line_count
     and not exists (select 1 from app.lines l where l.story_id = new.id and l.created_at = now()) then
    update app.counters set value = value + 1 where key = 'trash';
  end if;
  return new;
end $$;

-- 학번 as participants may see it: as is, masked (2026••••01), or not at all
create function app.public_sid(p_sid text)
returns text language plpgsql stable set search_path = '' as $$
declare st app.settings;
begin
  if p_sid is null then return null; end if;
  select * into st from app.settings where id;
  if not st.show_student_id then return null; end if;
  if not coalesce((app.extras()->>'sid_mask')::boolean, false) then return p_sid; end if;
  if char_length(p_sid) >= 7 then return left(p_sid, 4) || '••••' || right(p_sid, 2); end if;
  return left(p_sid, 1) || repeat('•', greatest(char_length(p_sid) - 1, 1));
end $$;

-- the edit window of a line (null: it can't be edited by its writer any more)
create function app.edit_until(l app.lines)
returns timestamptz language sql stable set search_path = '' as $$
  select case when coalesce((app.extras()->>'self_edit')::boolean, false)
                   and coalesce((app.extras()->>'self_edit_minutes')::int, 0) > 0
                   and l.deleted_at is null and l.kind = 'canonical'
              then l.created_at + make_interval(mins => (app.extras()->>'self_edit_minutes')::int) end
$$;

-- ---------------------------------------------------------------------
-- reads that show 학번 → app.public_sid; get_story also says who is editing and which lines were fixed
-- ---------------------------------------------------------------------
create or replace function public.get_story(p_story_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  st app.settings;
  s  app.stories;
  v_lines jsonb;
begin
  select * into st from app.settings where id;
  select * into s from app.stories where id = p_story_id and deleted_at is null;
  if not found then perform app.err('story_not_found'); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',          l.id,
           'position',    l.depth,
           'removed',     l.deleted_at is not null,
           'text',        case when l.deleted_at is null then l.text end,
           'author_name', case when l.deleted_at is null then l.author_name end,
           'student_id',  case when l.deleted_at is null then app.public_sid(l.student_id) end,
           'created_at',  l.created_at,
           'edited',      l.edited_at is not null,
           'self_edited', l.self_edited_at is not null and l.deleted_at is null
         ) order by l.depth), '[]'::jsonb)
    into v_lines
    from app.lines l
   where l.story_id = s.id and l.kind = 'canonical';

  return jsonb_build_object(
    'id', s.id, 'title', s.title, 'status', s.status,
    'line_count', s.line_count,
    'max_lines', coalesce(s.max_lines, st.max_lines),
    'max_chars', coalesce(s.max_chars, st.max_chars),
    'head_line_id', s.head_line_id,
    'created_at', s.created_at, 'updated_at', s.updated_at, 'completed_at', s.completed_at,
    'writing', coalesce(s.baton_expires_at > now(), false),
    'editing', coalesce(s.baton_expires_at > now(), false) and s.baton_edit,
    'baton_expires_at', case when s.baton_expires_at > now() then s.baton_expires_at end,
    'server_now', now(),
    'lines', v_lines);
end $$;

create or replace function public.public_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare st app.settings; v jsonb;
begin
  select * into st from app.settings where id;
  if not st.stats_public then perform app.err('stats_hidden'); end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.lines desc, x.name), '[]'::jsonb) into v
  from (
    select (array_agg(l.author_name order by l.created_at desc))[1] as name,
           app.public_sid(l.student_id) as student_id,
           count(*) as lines,
           count(distinct l.story_id) as stories
    from app.lines l join app.stories s on s.id = l.story_id
    where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null
    group by l.student_id
  ) x;
  return v;
end $$;

create or replace function public.list_guestbook(p_before bigint default null, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_items jsonb;
  v_more  boolean;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'no', g.no, 'text', g.text,
           'author_name', g.author_name,
           'student_id', app.public_sid(g.student_id),
           'created_at', g.created_at) order by g.no desc), '[]'::jsonb)
    into v_items
    from (select * from app.guestbook
           where deleted_at is null and (p_before is null or no < p_before)
           order by no desc limit v_limit) g;

  select exists (select 1 from app.guestbook
                  where deleted_at is null
                    and no < coalesce((select min((x->>'no')::bigint) from jsonb_array_elements(v_items) x), -1))
    into v_more;

  return jsonb_build_object(
    'total', (select count(*) from app.guestbook where deleted_at is null),
    'items', v_items,
    'has_more', v_more);
end $$;

create or replace function public.export_stories(p_story_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  st app.settings;
  v_stories jsonb;
begin
  select * into st from app.settings where id;

  if p_story_id is not null then
    perform 1 from app.stories where id = p_story_id and deleted_at is null;
    if not found then perform app.err('story_not_found'); end if;
    perform 1 from app.stories where id = p_story_id and status = 'completed';
    if not found then perform app.err('story_not_completed'); end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'title', s.title,
           'created_at', s.created_at, 'completed_at', s.completed_at,
           'lines', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'position',    l.depth,
                      'text',        l.text,
                      'author_name', case when st.export_credits <> 'none' then l.author_name end,
                      'student_id',  case when st.export_credits = 'name_sid' then app.public_sid(l.student_id) end
                    ) order by l.depth), '[]'::jsonb)
             from app.lines l
             where l.story_id = s.id and l.kind = 'canonical' and l.deleted_at is null)
         ) order by s.completed_at, s.created_at), '[]'::jsonb)
    into v_stories
    from app.stories s
   where s.deleted_at is null and s.status = 'completed'
     and (p_story_id is null or s.id = p_story_id);

  return jsonb_build_object(
    'exported_at', now(),
    'credits', st.export_credits,
    'stories', v_stories);
end $$;

-- 내가 쓴 줄: + how far each story has gone, and which of my lines I fixed
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
           'line_count', s.line_count,
           'position', l.depth, 'text', l.text, 'created_at', l.created_at,
           'self_edited', l.self_edited_at is not null,
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

-- ---------------------------------------------------------------------
-- write_check: + whether I can still fix my line here ({ edit: { line_id, until } })
-- ---------------------------------------------------------------------
create or replace function public.write_check(p_story_id uuid, p_student_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  st app.settings; s app.stories; h app.lines; v_sid text; v_mine int; v_max int; v_count jsonb; v_until timestamptz;
begin
  select * into st from app.settings where id;
  if not st.submissions_open then return jsonb_build_object('code', 'submissions_closed'); end if;
  if app.deadline_passed() then return jsonb_build_object('code', 'deadline_passed'); end if;
  select * into s from app.stories where id = p_story_id and deleted_at is null;
  if not found then return jsonb_build_object('code', 'story_not_found'); end if;
  v_sid := upper(regexp_replace(normalize(coalesce(p_student_id, ''), nfkc), '[\s-]', '', 'g'));
  if v_sid = '' then return null; end if;
  v_mine  := app.person_lines(s.id, v_sid);
  v_max   := st.lines_per_person_per_story;
  v_count := jsonb_build_object('mine', v_mine, 'max', v_max);
  -- 고치기: my line is the newest, still inside its window, and nobody else holds the next line
  select * into h from app.lines where id = s.head_line_id;
  if found and h.student_id = v_sid then
    v_until := app.edit_until(h);
    if v_until > now() and not (coalesce(s.baton_expires_at > now(), false) and (s.baton_sid <> v_sid or not s.baton_edit)) then
      v_count := v_count || jsonb_build_object('edit', jsonb_build_object('line_id', h.id, 'until', v_until, 'server_now', now()));
    end if;
  end if;
  if s.status <> 'open' or s.line_count >= coalesce(s.max_lines, st.max_lines) then
    return v_count || jsonb_build_object('code', 'story_closed');
  end if;
  if s.baton_expires_at > now() and s.baton_sid <> v_sid then
    return v_count || jsonb_build_object('code', 'baton_held', 'detail', jsonb_build_object('expires_at', s.baton_expires_at, 'editing', s.baton_edit));
  end if;
  if v_mine >= v_max then
    return v_count || jsonb_build_object('code', 'person_limit', 'detail', jsonb_build_object('max', v_max));
  end if;
  if not st.allow_consecutive_lines and h.student_id = v_sid then
    return v_count || jsonb_build_object('code', 'consecutive');
  end if;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- 고치기: begin (holds the next line) → save, or let go with release_baton(story, token)
-- ---------------------------------------------------------------------
create function public.begin_edit(p_story_id uuid, p_line_id uuid, p_name text, p_student_id text, p_client text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare st app.settings; s app.stories; l app.lines; v_sid text; v_name text; v_until timestamptz; v_token uuid := gen_random_uuid();
begin
  if not coalesce((app.extras()->>'self_edit')::boolean, false) then perform app.err('feature_off'); end if;
  select * into st from app.settings where id;
  if not st.submissions_open then perform app.err('submissions_closed'); end if;
  if app.deadline_passed() then perform app.err('deadline_passed'); end if;
  v_name := app.clean_name(p_name);
  v_sid  := app.clean_sid(p_student_id);
  select * into s from app.stories where id = p_story_id and deleted_at is null for update;
  if not found then perform app.err('story_not_found'); end if;
  select * into l from app.lines where id = p_line_id and story_id = s.id;
  if not found or l.kind <> 'canonical' or l.deleted_at is not null then perform app.err('line_not_found'); end if;
  if l.student_id <> v_sid or l.author_name <> v_name then perform app.err('not_your_line'); end if;
  if s.head_line_id <> l.id then perform app.err('edit_too_late', jsonb_build_object('why', 'continued')); end if;
  v_until := app.edit_until(l);
  if v_until is null or v_until <= now() then perform app.err('edit_too_late', jsonb_build_object('why', 'time')); end if;
  if s.baton_expires_at > now() and (s.baton_sid <> v_sid or not s.baton_edit) then
    perform app.err('edit_too_late', jsonb_build_object('why', 'held'));
  end if;

  perform set_config('app.edit_hold', '1', true);
  update app.stories
     set baton_token = v_token, baton_name = v_name, baton_sid = v_sid,
         baton_client = app.clean_client(p_client), baton_expires_at = v_until + interval '1 minute'
   where id = s.id;
  perform set_config('app.edit_hold', '', true);

  perform app.bump(array['list', s.id::text]);
  return jsonb_build_object('token', v_token, 'line_id', l.id, 'position', l.depth, 'text', l.text,
    'max_chars', coalesce(s.max_chars, st.max_chars), 'until', v_until,
    'expires_at', v_until + interval '1 minute', 'server_now', now());
end $$;

create function public.save_edit(p_story_id uuid, p_line_id uuid, p_text text, p_token uuid, p_name text, p_student_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare st app.settings; s app.stories; l app.lines; v_text text;
begin
  select * into st from app.settings where id;
  select * into s from app.stories where id = p_story_id and deleted_at is null for update;
  if not found then perform app.err('story_not_found'); end if;
  if s.baton_token is distinct from p_token or not s.baton_edit or not (s.baton_expires_at > now()) then
    perform app.err('edit_too_late', jsonb_build_object('why', 'time'));
  end if;
  select * into l from app.lines where id = p_line_id and story_id = s.id;
  if not found or l.id <> s.head_line_id or l.deleted_at is not null then perform app.err('edit_too_late', jsonb_build_object('why', 'continued')); end if;
  if l.student_id <> app.clean_sid(p_student_id) or l.author_name <> app.clean_name(p_name) then perform app.err('not_your_line'); end if;

  v_text := app.clean_text(p_text);
  if v_text = '' then perform app.err('empty_text'); end if;
  if char_length(v_text) > coalesce(s.max_chars, st.max_chars) then
    perform app.err('too_long', jsonb_build_object('max', coalesce(s.max_chars, st.max_chars)));
  end if;

  if v_text <> l.text then
    update app.lines set original_text = coalesce(original_text, text), text = v_text, self_edited_at = now()
     where id = l.id;
  end if;
  update app.stories
     set baton_token = null, baton_name = null, baton_sid = null, baton_client = null, baton_expires_at = null
   where id = s.id;
  perform app.bump(array['list', s.id::text]);
  return jsonb_build_object('ok', true, 'changed', v_text <> l.text, 'text', v_text);
end $$;

revoke all on function app.baton_kind() from public, anon, authenticated;
revoke all on function app.public_sid(text) from public, anon, authenticated;
revoke all on function app.edit_until(app.lines) from public, anon, authenticated;
revoke all on function public.begin_edit(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_edit(uuid, uuid, text, text, text) to anon, authenticated;
revoke all on function public.save_edit(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.save_edit(uuid, uuid, text, uuid, text, text) to anon, authenticated;
