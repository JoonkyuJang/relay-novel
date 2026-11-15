-- =====================================================================
-- 지우기 (2026-11-15)
--  * Within the same few minutes as 고치기 (self_edit_minutes) and on the same terms — my line is the
--    newest, and nobody else has started the next one — its writer may take it back altogether
--    (setting: self_delete). The story steps back one line (a finished story opens again) and the spot
--    is free for anyone, the writer included. The first line of a story can't be taken back.
--  * The line isn't erased from the database: it is set aside as 'archived' with lines.self_deleted_at,
--    so the admin still sees it in the story's 줄 목록 (and can bring it back by 되감기 onto it).
--    Stamps on it go.
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
 "notify_after_me": true,
 "self_delete": true
}$json$::jsonb
$$;

alter table app.lines add column self_deleted_at timestamptz;

-- the 지우기 window of a line (null: its writer can't take it back)
create function app.delete_until(l app.lines)
returns timestamptz language sql stable set search_path = '' as $$
  select case when coalesce((app.extras()->>'self_delete')::boolean, false)
                   and coalesce((app.extras()->>'self_edit_minutes')::int, 0) > 0
                   and l.deleted_at is null and l.kind = 'canonical' and l.depth > 1
              then l.created_at + make_interval(mins => (app.extras()->>'self_edit_minutes')::int) end
$$;

-- (from the line itself, or from the 고치기 box: my own edit hold doesn't stand in the way)
create function public.delete_own_line(p_story_id uuid, p_line_id uuid, p_name text, p_student_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare st app.settings; s app.stories; l app.lines; v_sid text; v_name text; v_until timestamptz;
begin
  if not coalesce((app.extras()->>'self_delete')::boolean, false) then perform app.err('feature_off'); end if;
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
  if l.depth <= 1 then perform app.err('first_line'); end if;
  if s.head_line_id <> l.id then perform app.err('edit_too_late', jsonb_build_object('why', 'continued')); end if;
  v_until := app.delete_until(l);
  if v_until is null or v_until <= now() then perform app.err('edit_too_late', jsonb_build_object('why', 'time')); end if;
  -- someone else's turn, or a hold that isn't my own 고치기, still running
  if s.baton_expires_at > now() and (s.baton_sid <> v_sid or not s.baton_edit) then
    perform app.err('edit_too_late', jsonb_build_object('why', 'held'));
  end if;

  update app.lines set kind = 'archived', self_deleted_at = now() where id = l.id;
  delete from app.stamps where line_id = l.id;
  update app.stories
     set head_line_id = l.parent_id, line_count = l.depth - 1,
         status = 'open', completed_at = null, updated_at = now(),
         baton_token = null, baton_name = null, baton_sid = null, baton_client = null, baton_expires_at = null
   where id = s.id;

  perform app.log('self_delete', s.id, jsonb_build_object('line_id', l.id, 'position', l.depth,
    'author', l.author_name, 'student_id', l.student_id, 'text', l.text));
  perform app.bump(array['list', 'admin', s.id::text]);
  return jsonb_build_object('ok', true, 'line_count', l.depth - 1, 'reopened', s.status = 'completed');
end $$;

-- write_check: the edit offer also says what I may do with the line
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
  -- 고치기 · 지우기: my line is the newest, still inside its window, and nobody else holds the next line
  select * into h from app.lines where id = s.head_line_id;
  if found and h.student_id = v_sid then
    v_until := coalesce(app.edit_until(h), app.delete_until(h));
    if v_until > now() and not (coalesce(s.baton_expires_at > now(), false) and (s.baton_sid <> v_sid or not s.baton_edit)) then
      v_count := v_count || jsonb_build_object('edit', jsonb_build_object('line_id', h.id, 'until', v_until, 'server_now', now(),
        'can_edit', app.edit_until(h) is not null, 'can_delete', app.delete_until(h) is not null));
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

-- admin's 줄 목록: which set-aside lines their writer took back (and which were fixed)
create or replace function public.admin_get_story(p_story_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare st app.settings; s app.stories; v_lines jsonb;
begin
  perform app.require_admin();
  select * into st from app.settings where id;
  select * into s from app.stories where id = p_story_id;
  if not found then perform app.err('story_not_found'); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'parent_id', l.parent_id, 'position', l.depth,
           'kind', l.kind, 'conflict_status', l.conflict_status,
           'text', l.text, 'original_text', l.original_text,
           'author_name', l.author_name, 'student_id', l.student_id,
           'client_token', l.client_token,
           'created_at', l.created_at, 'edited_at', l.edited_at, 'deleted_at', l.deleted_at,
           'self_edited_at', l.self_edited_at, 'self_deleted_at', l.self_deleted_at
         ) order by l.depth, l.created_at), '[]'::jsonb)
    into v_lines
    from app.lines l where l.story_id = s.id;

  return jsonb_build_object(
    'id', s.id, 'title', s.title, 'status', s.status, 'line_count', s.line_count,
    'max_lines_override', s.max_lines, 'max_chars_override', s.max_chars,
    'max_lines', coalesce(s.max_lines, st.max_lines),
    'max_chars', coalesce(s.max_chars, st.max_chars),
    'head_line_id', s.head_line_id,
    'created_at', s.created_at, 'updated_at', s.updated_at,
    'completed_at', s.completed_at, 'deleted_at', s.deleted_at,
    'baton', case when s.baton_expires_at > now() then jsonb_build_object(
               'name', s.baton_name, 'student_id', s.baton_sid,
               'client', s.baton_client, 'expires_at', s.baton_expires_at) end,
    'server_now', now(),
    'lines', v_lines);
end $$;

revoke all on function app.delete_until(app.lines) from public, anon, authenticated;
revoke all on function public.delete_own_line(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.delete_own_line(uuid, uuid, text, text) to anon, authenticated;
