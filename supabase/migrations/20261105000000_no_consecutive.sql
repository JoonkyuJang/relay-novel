-- =====================================================================
-- No two lines in a row by the same person (when a person may write
-- more than one line per story). Switchable: settings.allow_consecutive_lines.
-- claim_baton / submit_line / get_public_settings / admin_update_settings
-- are re-created unchanged apart from the new check / key.
-- =====================================================================

alter table app.settings
  add column allow_consecutive_lines boolean not null default false;

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
begin
  select * into st from app.settings where id;
  if not st.submissions_open then perform app.err('submissions_closed'); end if;

  v_name := app.clean_name(p_name);
  v_sid  := app.clean_sid(p_student_id);

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

  v_token := gen_random_uuid();
  v_exp   := now() + make_interval(secs => st.baton_seconds);

  update app.stories
     set baton_token = v_token, baton_name = v_name, baton_sid = v_sid,
         baton_client = app.clean_client(p_client), baton_expires_at = v_exp
   where id = s.id;

  perform app.bump(array['list', s.id::text]);
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

create or replace function public.submit_line(
  p_story_id uuid, p_parent_id uuid, p_text text,
  p_name text, p_student_id text, p_client text, p_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st            app.settings;
  s             app.stories;
  v_parent      app.lines;
  v_text        text;
  v_name        text;
  v_sid         text;
  v_client      text;
  v_max_lines   int;
  v_max_chars   int;
  v_other_baton boolean;
  v_line        uuid;
  v_count       int;
  v_done        boolean;
  v_open_confl  int;
begin
  select * into st from app.settings where id;
  if not st.submissions_open then perform app.err('submissions_closed'); end if;

  v_name   := app.clean_name(p_name);
  v_sid    := app.clean_sid(p_student_id);
  v_client := app.clean_client(p_client);
  v_text   := app.clean_text(p_text);
  if v_text = '' then perform app.err('empty_text'); end if;

  select * into s from app.stories
   where id = p_story_id and deleted_at is null for update;
  if not found then perform app.err('story_not_found'); end if;

  v_max_lines := coalesce(s.max_lines, st.max_lines);
  v_max_chars := coalesce(s.max_chars, st.max_chars);

  if char_length(v_text) > v_max_chars then
    perform app.err('too_long', jsonb_build_object('max', v_max_chars));
  end if;

  select * into v_parent from app.lines
   where id = p_parent_id and story_id = s.id;
  if not found or v_parent.kind <> 'canonical' then
    perform app.err('invalid_parent');
  end if;

  v_other_baton := coalesce(s.baton_expires_at > now(), false)
                   and s.baton_sid <> v_sid
                   and s.baton_token is distinct from p_token;

  if p_parent_id = s.head_line_id then
    if s.status <> 'open' or s.line_count >= v_max_lines then
      perform app.err('story_closed');
    end if;

    if not v_other_baton then
      -- ---------- ACCEPT ----------
      if app.person_lines(s.id, v_sid) >= st.lines_per_person_per_story then
        perform app.err('person_limit', jsonb_build_object('max', st.lines_per_person_per_story));
      end if;
      if not st.allow_consecutive_lines and v_parent.student_id = v_sid then
        perform app.err('consecutive');
      end if;

      insert into app.lines (story_id, parent_id, depth, text, author_name, student_id, client_token, kind)
      values (s.id, v_parent.id, v_parent.depth + 1, v_text, v_name, v_sid, v_client, 'canonical')
      returning id into v_line;

      v_count := s.line_count + 1;
      v_done  := v_count >= v_max_lines;

      update app.stories
         set head_line_id = v_line, line_count = v_count,
             status       = case when v_done then 'completed' else 'open' end,
             completed_at = case when v_done then now() else completed_at end,
             updated_at   = now(),
             baton_token = null, baton_name = null, baton_sid = null,
             baton_client = null, baton_expires_at = null
       where id = s.id;

      perform app.bump(array['list', s.id::text]);
      return jsonb_build_object(
        'result', 'accepted', 'line_id', v_line, 'position', v_count,
        'story_status', case when v_done then 'completed' else 'open' end);
    end if;
  end if;

  -- ---------- CONFLICT: saved, hidden, flagged for the admin ----------
  select count(*) into v_open_confl from app.lines
   where story_id = s.id and student_id = v_sid
     and kind = 'conflict' and conflict_status = 'open';
  if v_open_confl >= 3 then perform app.err('too_many_conflicts'); end if;

  insert into app.lines (story_id, parent_id, depth, text, author_name, student_id,
                         client_token, kind, conflict_status)
  values (s.id, v_parent.id, v_parent.depth + 1, v_text, v_name, v_sid,
          v_client, 'conflict', 'open')
  returning id into v_line;

  if s.baton_token = p_token then
    update app.stories
       set baton_token = null, baton_name = null, baton_sid = null,
           baton_client = null, baton_expires_at = null
     where id = s.id;
  end if;

  perform app.bump(array['list', 'admin', s.id::text]);
  return jsonb_build_object(
    'result',   'conflict',
    'line_id',  v_line,
    'position', v_parent.depth + 1,
    'reason',   case when p_parent_id = s.head_line_id then 'baton_taken' else 'stale_parent' end);
end $$;

create or replace function public.get_public_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'max_lines', max_lines, 'max_chars', max_chars, 'max_title_chars', max_title_chars,
    'lines_per_person_per_story', lines_per_person_per_story,
    'stories_started_per_person', stories_started_per_person,
    'baton_seconds', baton_seconds, 'show_student_id', show_student_id,
    'stats_public', stats_public, 'likes_enabled', likes_enabled,
    'submissions_open', submissions_open, 'allow_new_stories', allow_new_stories,
    'guestbook_open', guestbook_open, 'guestbook_max_chars', guestbook_max_chars,
    'guestbook_cooldown_seconds', guestbook_cooldown_seconds,
    'allow_consecutive_lines', allow_consecutive_lines,
    'server_now', now())
  from app.settings where id
$$;

create or replace function public.admin_update_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare before jsonb; after jsonb; st app.settings;
begin
  perform app.require_admin();
  select to_jsonb(s) - 'id' into before from app.settings s where id;

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
  return after;
end $$;
