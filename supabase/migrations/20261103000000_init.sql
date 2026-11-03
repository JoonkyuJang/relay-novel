-- =====================================================================
-- Relay Novel — initial schema
--
-- Design:
--  * All data lives in the private `app` schema (not exposed by the API).
--  * The browser can only call the functions in `public` below.
--  * Lines form a tree (parent_id). A story's official text is the chain of
--    kind='canonical' lines from the root to stories.head_line_id.
--    A unique index guarantees at most one canonical line per position.
--  * Every write locks the story row (SELECT ... FOR UPDATE), so writes to
--    the same story are serialized.
--  * public.realtime_signals is a tiny, private-data-free table that clients
--    subscribe to; any change means "re-fetch".
-- =====================================================================

create schema if not exists app;
revoke all on schema app from public;
revoke all on schema app from anon, authenticated;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table app.settings (
  id                          boolean primary key default true check (id),
  max_lines                   int     not null default 20  check (max_lines between 1 and 1000),
  max_chars                   int     not null default 100 check (max_chars between 1 and 2000),
  max_title_chars             int     not null default 40  check (max_title_chars between 1 and 200),
  lines_per_person_per_story  int     not null default 1   check (lines_per_person_per_story >= 1),
  stories_started_per_person  int     not null default 2   check (stories_started_per_person >= 0),
  baton_seconds               int     not null default 300 check (baton_seconds between 30 and 3600),
  show_student_id             boolean not null default true,
  stats_public                boolean not null default false,
  likes_enabled               boolean not null default false,
  submissions_open            boolean not null default true,
  allow_new_stories           boolean not null default true,
  updated_at                  timestamptz not null default now()
);
insert into app.settings default values;

create table app.admins (
  user_id    uuid primary key,
  created_at timestamptz not null default now()
);

create table app.stories (
  id               uuid primary key default gen_random_uuid(),
  title            text,
  status           text not null default 'open' check (status in ('open', 'completed')),
  max_lines        int  check (max_lines between 1 and 1000),   -- null = site default
  max_chars        int  check (max_chars between 1 and 2000),   -- null = site default
  head_line_id     uuid,
  line_count       int  not null default 0,
  baton_token      uuid,
  baton_name       text,
  baton_sid        text,
  baton_client     text,
  baton_expires_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  deleted_at       timestamptz
);

create table app.lines (
  id              uuid primary key default gen_random_uuid(),
  story_id        uuid not null references app.stories(id),
  parent_id       uuid references app.lines(id),
  depth           int  not null check (depth >= 1),             -- 1-based position
  text            text not null,
  author_name     text not null,
  student_id      text not null,
  client_token    text,
  kind            text not null check (kind in ('canonical', 'conflict', 'archived', 'branch')),
  conflict_status text check (conflict_status in ('open', 'dismissed', 'promoted')),
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  original_text   text,
  deleted_at      timestamptz
);

alter table app.stories
  add constraint stories_head_fk foreign key (head_line_id)
  references app.lines(id) deferrable initially deferred;

create unique index lines_one_canonical_per_position
  on app.lines (story_id, depth) where kind = 'canonical';
create index lines_story_idx   on app.lines (story_id);
create index lines_student_idx on app.lines (student_id);
create index lines_parent_idx  on app.lines (parent_id);

create table app.admin_log (
  id         bigserial primary key,
  admin_id   uuid,
  action     text not null,
  target_id  uuid,
  details    jsonb,
  created_at timestamptz not null default now()
);

alter table app.settings  enable row level security;
alter table app.admins    enable row level security;
alter table app.stories   enable row level security;
alter table app.lines     enable row level security;
alter table app.admin_log enable row level security;

-- Realtime "something changed" pings. key = 'list' | 'admin' | <story id>
create table public.realtime_signals (
  key        text primary key,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.realtime_signals enable row level security;
create policy "signals are readable" on public.realtime_signals
  for select to anon, authenticated using (true);
revoke all on public.realtime_signals from anon, authenticated;
grant select on public.realtime_signals to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.realtime_signals;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Internal helpers (app schema, not callable from the API)
-- ---------------------------------------------------------------------

-- Raise an error the client can recognise by its message code.
create function app.err(p_code text, p_detail jsonb default null)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code,
    detail = coalesce(p_detail::text, '');
end $$;

-- NFC-normalise, turn any whitespace run (incl. newlines) into one space, trim.
create function app.clean_text(p text)
returns text language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(normalize(coalesce(p, ''), NFC), '\s+', ' ', 'g'))
$$;

create function app.clean_name(p text)
returns text language plpgsql set search_path = '' as $$
declare v text := app.clean_text(p);
begin
  if char_length(v) < 1 or char_length(v) > 20 then
    perform app.err('invalid_name');
  end if;
  return v;
end $$;

create function app.clean_sid(p text)
returns text language plpgsql set search_path = '' as $$
declare v text := upper(regexp_replace(normalize(coalesce(p, ''), NFKC), '[\s-]', '', 'g'));
begin
  if v !~ '^[0-9A-Z]{1,20}$' then
    perform app.err('invalid_student_id');
  end if;
  return v;
end $$;

create function app.clean_client(p text)
returns text language sql immutable set search_path = '' as $$
  select left(nullif(btrim(coalesce(p, '')), ''), 64)
$$;

create function app.bump(p_keys text[])
returns void language sql set search_path = '' as $$
  insert into public.realtime_signals (key, version, updated_at)
  select k, 1, now() from unnest(p_keys) as k
  on conflict (key) do update
    set version = public.realtime_signals.version + 1, updated_at = now();
$$;

create function app.is_admin()
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from app.admins where user_id = auth.uid())
$$;

create function app.require_admin()
returns void language plpgsql set search_path = '' as $$
begin
  if not app.is_admin() then perform app.err('not_admin'); end if;
end $$;

create function app.log(p_action text, p_target uuid, p_details jsonb)
returns void language sql set search_path = '' as $$
  insert into app.admin_log (admin_id, action, target_id, details)
  values (auth.uid(), p_action, p_target, p_details);
$$;

-- Number of live canonical lines this person has in a story.
create function app.person_lines(p_story uuid, p_sid text)
returns int language sql stable set search_path = '' as $$
  select count(*)::int from app.lines
  where story_id = p_story and student_id = p_sid
    and kind = 'canonical' and deleted_at is null
$$;

-- ---------------------------------------------------------------------
-- Public write functions
-- ---------------------------------------------------------------------

create function public.create_story(
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


create function public.claim_baton(
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


create function public.release_baton(p_story_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update app.stories
     set baton_token = null, baton_name = null, baton_sid = null,
         baton_client = null, baton_expires_at = null
   where id = p_story_id and baton_token = p_token;
  if found then
    perform app.bump(array['list', p_story_id::text]);
    return true;
  end if;
  return false;
end $$;


-- Result is 'accepted' or 'conflict'; anything else is raised as an error.
create function public.submit_line(
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

-- ---------------------------------------------------------------------
-- Public read functions
-- ---------------------------------------------------------------------

create function public.get_public_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'max_lines', max_lines, 'max_chars', max_chars, 'max_title_chars', max_title_chars,
    'lines_per_person_per_story', lines_per_person_per_story,
    'stories_started_per_person', stories_started_per_person,
    'baton_seconds', baton_seconds, 'show_student_id', show_student_id,
    'stats_public', stats_public, 'likes_enabled', likes_enabled,
    'submissions_open', submissions_open, 'allow_new_stories', allow_new_stories,
    'server_now', now())
  from app.settings where id
$$;


create function public.list_stories()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]'::jsonb)
  from (
    select s.id, s.title, s.status, s.line_count,
           coalesce(s.max_lines, st.max_lines) as max_lines,
           s.created_at, s.updated_at, s.completed_at,
           coalesce(s.baton_expires_at > now(), false) as writing,
           (select case when l.deleted_at is null then l.text end from app.lines l
             where l.story_id = s.id and l.kind = 'canonical' and l.depth = 1) as first_line,
           (select case when l.deleted_at is null then l.text end from app.lines l
             where l.id = s.head_line_id) as last_line
    from app.stories s cross join app.settings st
    where s.deleted_at is null and st.id
  ) x
$$;


create function public.get_story(p_story_id uuid)
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
           'student_id',  case when l.deleted_at is null and st.show_student_id then l.student_id end,
           'created_at',  l.created_at,
           'edited',      l.edited_at is not null
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
    'baton_expires_at', case when s.baton_expires_at > now() then s.baton_expires_at end,
    'server_now', now(),
    'lines', v_lines);
end $$;


create function public.public_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare st app.settings; v jsonb;
begin
  select * into st from app.settings where id;
  if not st.stats_public then perform app.err('stats_hidden'); end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.lines desc, x.name), '[]'::jsonb) into v
  from (
    select (array_agg(l.author_name order by l.created_at desc))[1] as name,
           case when st.show_student_id then l.student_id end as student_id,
           count(*) as lines,
           count(distinct l.story_id) as stories
    from app.lines l join app.stories s on s.id = l.story_id
    where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null
    group by l.student_id
  ) x;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Admin functions (require a logged-in user listed in app.admins)
-- ---------------------------------------------------------------------

create function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select app.is_admin()
$$;


create function public.admin_get_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  select to_jsonb(s) - 'id' into v from app.settings s where id;
  return v;
end $$;


create function public.admin_update_settings(p jsonb)
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
    updated_at                 = now()
  where id
  returning * into st;

  -- open stories that are now at/over their limit become completed
  update app.stories s
     set status = 'completed', completed_at = now(),
         baton_token = null, baton_name = null, baton_sid = null,
         baton_client = null, baton_expires_at = null
   where s.status = 'open' and s.deleted_at is null
     and s.line_count >= coalesce(s.max_lines, st.max_lines);

  select to_jsonb(s) - 'id' into after from app.settings s where id;
  perform app.log('update_settings', null, jsonb_build_object('before', before, 'after', after));
  perform app.bump(array['list', 'admin', 'settings']);
  return after;
end $$;


create function public.admin_list_stories()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]'::jsonb) into v
  from (
    select s.id, s.title, s.status, s.line_count, s.max_lines as max_lines_override,
           s.max_chars as max_chars_override,
           coalesce(s.max_lines, st.max_lines) as max_lines,
           s.created_at, s.updated_at, s.completed_at, s.deleted_at,
           case when s.baton_expires_at > now() then s.baton_name end as baton_name,
           case when s.baton_expires_at > now() then s.baton_expires_at end as baton_expires_at,
           (select count(*) from app.lines l where l.story_id = s.id
              and l.kind = 'conflict' and l.conflict_status = 'open') as open_conflicts,
           (select l.text from app.lines l where l.story_id = s.id
              and l.kind = 'canonical' and l.depth = 1) as first_line
    from app.stories s cross join app.settings st where st.id
  ) x;
  return v;
end $$;


-- Full tree of a story, every line of every kind, with identities.
create function public.admin_get_story(p_story_id uuid)
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
           'created_at', l.created_at, 'edited_at', l.edited_at, 'deleted_at', l.deleted_at
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


-- p keys (all optional): title, max_lines (null clears), max_chars (null clears), status
create function public.admin_update_story(p_story_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare st app.settings; s app.stories; before jsonb; v_eff int;
begin
  perform app.require_admin();
  select * into st from app.settings where id;
  select * into s from app.stories where id = p_story_id for update;
  if not found then perform app.err('story_not_found'); end if;
  before := jsonb_build_object('title', s.title, 'max_lines', s.max_lines,
                               'max_chars', s.max_chars, 'status', s.status);

  if p ? 'title'     then s.title     := nullif(app.clean_text(p->>'title'), ''); end if;
  if p ? 'max_lines' then s.max_lines := (p->>'max_lines')::int; end if;
  if p ? 'max_chars' then s.max_chars := (p->>'max_chars')::int; end if;
  v_eff := coalesce(s.max_lines, st.max_lines);

  if p ? 'status' then
    if p->>'status' = 'open' then
      if s.line_count >= v_eff then perform app.err('raise_max_lines_first'); end if;
      s.status := 'open'; s.completed_at := null;
    elsif p->>'status' = 'completed' then
      if s.status <> 'completed' then s.completed_at := now(); end if;
      s.status := 'completed';
    else
      perform app.err('invalid_status');
    end if;
  elsif s.status = 'open' and s.line_count >= v_eff then
    s.status := 'completed'; s.completed_at := now();
  end if;

  update app.stories set
    title = s.title, max_lines = s.max_lines, max_chars = s.max_chars,
    status = s.status, completed_at = s.completed_at, updated_at = now(),
    baton_token      = case when s.status = 'open' then baton_token end,
    baton_name       = case when s.status = 'open' then baton_name end,
    baton_sid        = case when s.status = 'open' then baton_sid end,
    baton_client     = case when s.status = 'open' then baton_client end,
    baton_expires_at = case when s.status = 'open' then baton_expires_at end
  where id = s.id;

  perform app.log('update_story', s.id, jsonb_build_object('before', before, 'patch', p));
  perform app.bump(array['list', 'admin', s.id::text]);
  return public.admin_get_story(s.id);
end $$;


create function public.admin_set_story_deleted(p_story_id uuid, p_deleted boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_admin();
  update app.stories
     set deleted_at = case when p_deleted then now() end, updated_at = now(),
         baton_token = null, baton_name = null, baton_sid = null,
         baton_client = null, baton_expires_at = null
   where id = p_story_id;
  if not found then perform app.err('story_not_found'); end if;
  perform app.log(case when p_deleted then 'delete_story' else 'restore_story' end, p_story_id, null);
  perform app.bump(array['list', 'admin', p_story_id::text]);
  return jsonb_build_object('ok', true);
end $$;


create function public.admin_release_baton(p_story_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_admin();
  update app.stories
     set baton_token = null, baton_name = null, baton_sid = null,
         baton_client = null, baton_expires_at = null
   where id = p_story_id;
  perform app.log('release_baton', p_story_id, null);
  perform app.bump(array['list', 'admin', p_story_id::text]);
  return jsonb_build_object('ok', true);
end $$;


create function public.admin_edit_line(p_line_id uuid, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l app.lines; v_text text;
begin
  perform app.require_admin();
  v_text := app.clean_text(p_text);
  if v_text = '' then perform app.err('empty_text'); end if;
  if char_length(v_text) > 2000 then perform app.err('too_long', '{"max":2000}'); end if;

  select * into l from app.lines where id = p_line_id;
  if not found then perform app.err('line_not_found'); end if;
  perform 1 from app.stories where id = l.story_id for update;

  update app.lines
     set original_text = coalesce(original_text, text), text = v_text, edited_at = now()
   where id = l.id;

  perform app.log('edit_line', l.id, jsonb_build_object('before', l.text, 'after', v_text));
  perform app.bump(array['list', 'admin', l.story_id::text]);
  return jsonb_build_object('ok', true);
end $$;


-- Soft delete / restore. Hides the line in place; the chain is unchanged.
-- (To actually free the slot after the latest line, use admin_set_head = rewind.)
create function public.admin_set_line_deleted(p_line_id uuid, p_deleted boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l app.lines;
begin
  perform app.require_admin();
  select * into l from app.lines where id = p_line_id;
  if not found then perform app.err('line_not_found'); end if;
  update app.lines set deleted_at = case when p_deleted then now() end where id = l.id;
  perform app.log(case when p_deleted then 'delete_line' else 'restore_line' end, l.id,
                  jsonb_build_object('story_id', l.story_id, 'position', l.depth));
  perform app.bump(array['list', 'admin', l.story_id::text]);
  return jsonb_build_object('ok', true);
end $$;


-- Make p_line_id the new head: the official text becomes root -> p_line_id.
-- Covers: "Rewind to line k", "Swap in + cut after", and undoing either.
-- Nothing is deleted; lines that leave the official path become 'archived'.
create function public.admin_set_head(p_line_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st         app.settings;
  t          app.lines;
  s          app.stories;
  v_path     uuid[];
  v_archived int;
  v_promoted int;
  v_eff      int;
  v_done     boolean;
begin
  perform app.require_admin();
  select * into st from app.settings where id;
  select * into t from app.lines where id = p_line_id;
  if not found then perform app.err('line_not_found'); end if;
  select * into s from app.stories where id = t.story_id for update;

  with recursive path as (
    select id, parent_id from app.lines where id = t.id
    union all
    select l.id, l.parent_id from app.lines l join path p on l.id = p.parent_id
  )
  select array_agg(id) into v_path from path;

  if cardinality(v_path) <> t.depth then perform app.err('broken_tree'); end if;

  update app.lines set kind = 'archived'
   where story_id = s.id and kind = 'canonical' and not (id = any(v_path));
  get diagnostics v_archived = row_count;

  update app.lines
     set conflict_status = case when kind = 'conflict' then 'promoted' else conflict_status end,
         kind = 'canonical'
   where id = any(v_path) and kind <> 'canonical';
  get diagnostics v_promoted = row_count;

  v_eff  := coalesce(s.max_lines, st.max_lines);
  v_done := t.depth >= v_eff;

  update app.stories
     set head_line_id = t.id, line_count = t.depth,
         status       = case when v_done then 'completed' else 'open' end,
         completed_at = case when v_done then coalesce(completed_at, now()) end,
         updated_at   = now(),
         baton_token = null, baton_name = null, baton_sid = null,
         baton_client = null, baton_expires_at = null
   where id = s.id;

  perform app.log('set_head', s.id, jsonb_build_object(
    'from_head', s.head_line_id, 'from_count', s.line_count,
    'to_head', t.id, 'to_count', t.depth,
    'archived', v_archived, 'promoted', v_promoted));
  perform app.bump(array['list', 'admin', s.id::text]);
  return jsonb_build_object('head_line_id', t.id, 'line_count', t.depth,
    'status', case when v_done then 'completed' else 'open' end,
    'archived', v_archived, 'promoted', v_promoted);
end $$;


-- "Swap in, keep following lines": p_line_id (a conflict/archived line whose
-- parent is on the official path) replaces the official line at its position;
-- the official line's continuation is re-attached to it. Undo = call this on
-- the line that was replaced.
create function public.admin_replace_line(p_line_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  l       app.lines;
  o       app.lines;
  k       app.lines;
  s       app.stories;
begin
  perform app.require_admin();
  select * into l from app.lines where id = p_line_id;
  if not found then perform app.err('line_not_found'); end if;
  if l.kind = 'canonical' then perform app.err('already_canonical'); end if;
  select * into s from app.stories where id = l.story_id for update;

  if l.parent_id is not null and not exists (
       select 1 from app.lines where id = l.parent_id and kind = 'canonical') then
    perform app.err('parent_not_canonical');
  end if;

  select * into o from app.lines
   where story_id = s.id and kind = 'canonical' and depth = l.depth;
  if not found then perform app.err('use_set_head'); end if;

  select * into k from app.lines
   where story_id = s.id and kind = 'canonical' and depth = l.depth + 1;

  update app.lines set kind = 'archived' where id = o.id;
  update app.lines
     set conflict_status = case when kind = 'conflict' then 'promoted' else conflict_status end,
         kind = 'canonical'
   where id = l.id;
  if k.id is not null then
    update app.lines set parent_id = l.id where id = k.id;
  end if;

  update app.stories
     set head_line_id = case when head_line_id = o.id then l.id else head_line_id end,
         updated_at = now()
   where id = s.id;

  perform app.log('replace_line', s.id, jsonb_build_object(
    'position', l.depth, 'new_line', l.id, 'replaced_line', o.id,
    'reattached_line', k.id));
  perform app.bump(array['list', 'admin', s.id::text]);
  return jsonb_build_object('ok', true, 'replaced_line', o.id, 'reattached_line', k.id);
end $$;


create function public.admin_set_conflict_status(p_line_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l app.lines;
begin
  perform app.require_admin();
  if p_status not in ('open', 'dismissed') then perform app.err('invalid_status'); end if;
  select * into l from app.lines where id = p_line_id and kind = 'conflict';
  if not found then perform app.err('line_not_found'); end if;
  update app.lines set conflict_status = p_status where id = l.id;
  perform app.log('conflict_' || p_status, l.id, jsonb_build_object('story_id', l.story_id));
  perform app.bump(array['admin', l.story_id::text]);
  return jsonb_build_object('ok', true);
end $$;


create function public.admin_list_conflicts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb) into v
  from (
    select c.id, c.story_id, s.title as story_title, c.depth as position,
           c.text, c.author_name, c.student_id, c.client_token, c.created_at,
           p.text as parent_text,
           o.id as official_id, o.text as official_text,
           o.author_name as official_author, o.student_id as official_student_id,
           o.created_at as official_created_at,
           (p.kind = 'canonical') as parent_on_path,
           exists (select 1 from app.lines k where k.story_id = c.story_id
                     and k.kind = 'canonical' and k.depth = c.depth + 1) as official_has_continuation
    from app.lines c
    join app.stories s on s.id = c.story_id
    left join app.lines p on p.id = c.parent_id
    left join app.lines o on o.story_id = c.story_id and o.kind = 'canonical' and o.depth = c.depth
    where c.kind = 'conflict' and c.conflict_status = 'open' and s.deleted_at is null
  ) x;
  return v;
end $$;


create function public.admin_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.lines desc, x.student_id), '[]'::jsonb) into v
  from (
    select l.student_id,
           array_agg(distinct l.author_name) as names,
           count(*) filter (where l.kind = 'canonical' and l.deleted_at is null) as lines,
           count(distinct l.story_id) filter (where l.kind = 'canonical' and l.deleted_at is null) as stories,
           count(*) filter (where l.kind = 'canonical' and l.depth = 1 and l.deleted_at is null) as started,
           count(*) filter (where l.kind = 'conflict') as conflicts,
           count(distinct l.client_token) as devices,
           min(l.created_at) as first_at, max(l.created_at) as last_at
    from app.lines l join app.stories s on s.id = l.story_id
    where s.deleted_at is null
    group by l.student_id
  ) x;
  return v;
end $$;


create function public.admin_log_recent(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc), '[]'::jsonb) into v
  from (select * from app.admin_log order by id desc limit least(greatest(p_limit, 1), 1000)) x;
  return v;
end $$;


create function public.admin_export()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'exported_at', now(),
    'settings',  (select to_jsonb(s) - 'id' from app.settings s where id),
    'stories',   (select coalesce(jsonb_agg(to_jsonb(s) - 'baton_token' order by s.created_at), '[]'::jsonb) from app.stories s),
    'lines',     (select coalesce(jsonb_agg(to_jsonb(l) order by l.story_id, l.depth, l.created_at), '[]'::jsonb) from app.lines l),
    'admin_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from app.admin_log a));
end $$;

-- ---------------------------------------------------------------------
-- Privileges: nothing is callable unless granted here.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema app from public, anon, authenticated;
revoke all on all sequences in schema app from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'create_story', 'claim_baton', 'release_baton', 'submit_line',
      'get_public_settings', 'list_stories', 'get_story', 'public_stats', 'is_admin',
      'admin_get_settings', 'admin_update_settings', 'admin_list_stories',
      'admin_get_story', 'admin_update_story', 'admin_set_story_deleted',
      'admin_release_baton', 'admin_edit_line', 'admin_set_line_deleted',
      'admin_set_head', 'admin_replace_line', 'admin_set_conflict_status',
      'admin_list_conflicts', 'admin_stats', 'admin_log_recent', 'admin_export')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname like 'admin\_%' then
      execute format('grant execute on function %s to authenticated', f.sig);
    else
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
