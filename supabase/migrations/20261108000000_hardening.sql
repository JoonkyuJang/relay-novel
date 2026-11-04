-- =====================================================================
-- Hardening before launch (audit, 2026-11-05)
--  * claim_baton: one baton per person (claiming another story lets go of
--    the old one); re-claiming your own baton returns the same token and
--    deadline, so a double tap or a script can't extend it forever.
--  * export_stories: student ids only when show_student_id is on.
--  * stamps: only the device that stamped can take a stamp back; "mine"
--    needs the same device too (no looking up who stamped what by 학번);
--    at most 300 stamps per line.
--  * get_counters(): the 휴지통 badge no longer runs get_about's scans.
--  * get_about: counts ignore deleted stories / hidden lines.
--  * admin_update_settings: range checks for number / name / date extras.
-- =====================================================================

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
                      'student_id',  case when st.export_credits = 'name_sid' and st.show_student_id then l.student_id end
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

-- ---------------------------------------------------------------------
-- Stamps
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
  select client_token into v_owner from app.stamps
   where line_id = l.id and kind = p_kind and student_id = v_sid;
  if found then
    if v_owner is not null and v_owner is distinct from v_client then perform app.err('not_your_stamp'); end if;
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

-- "mine" now needs the 학번 *and* this device's client token.
drop function public.get_story_stamps(uuid, text);
create function public.get_story_stamps(p_story_id uuid, p_student_id text default null, p_client text default null)
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
             where p_student_id is not null and p_client is not null
               and st.student_id = upper(regexp_replace(normalize(p_student_id, nfkc), '[\s-]', '', 'g'))
               and st.client_token = app.clean_client(p_client)),
             '[]'::jsonb) as mine
    from app.stamps st
    join app.lines l on l.id = st.line_id
    join app.stories s on s.id = st.story_id
    where st.story_id = p_story_id and l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null
    group by st.line_id
  ) x
$$;

-- ---------------------------------------------------------------------
-- Counters and the about window
-- ---------------------------------------------------------------------

create function public.get_counters()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from app.counters
$$;

create or replace function public.get_about()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'stories', (select count(*) from app.stories where deleted_at is null),
    'lines',   (select count(*) from app.lines l join app.stories s on s.id = l.story_id
                 where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null),
    'chars',   (select coalesce(sum(char_length(l.text)), 0) from app.lines l join app.stories s on s.id = l.story_id
                 where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null),
    'stamps',  (select count(*) from app.stamps st join app.lines l on l.id = st.line_id
                  join app.stories s on s.id = st.story_id
                 where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null),
    'since',   (select min(created_at) from app.stories where deleted_at is null),
    'cat_pets', (select value from app.counters where key = 'cat_pets'),
    'trash',    (select value from app.counters where key = 'trash'),
    'server_now', now())
$$;

-- ---------------------------------------------------------------------
-- Settings: range checks
-- ---------------------------------------------------------------------

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
    if v_extras ? 'deadline' then
      begin
        perform (v_extras->>'deadline')::timestamptz;
      exception when others then
        perform app.err('invalid_settings');
      end;
    end if;
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

-- ---------------------------------------------------------------------
-- Privileges for the new / re-created signatures
-- ---------------------------------------------------------------------

revoke all on function public.get_story_stamps(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_story_stamps(uuid, text, text) to anon, authenticated;
revoke all on function public.get_counters() from public, anon, authenticated;
grant execute on function public.get_counters() to anon, authenticated;
