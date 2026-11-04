-- =====================================================================
-- 방명록 (guestbook)
--  * Free-form messages, author hidden in the UI (revealed per message,
--    student id only when settings.show_student_id is on).
--  * guestbook_max_chars (200) per message, one message per
--    guestbook_cooldown_seconds (30) per student id AND per device.
--  * Admin can hide / restore messages (soft delete).
-- =====================================================================

alter table app.settings
  add column guestbook_open             boolean not null default true,
  add column guestbook_max_chars        int     not null default 200 check (guestbook_max_chars between 1 and 2000),
  add column guestbook_cooldown_seconds int     not null default 30  check (guestbook_cooldown_seconds between 0 and 3600);

create table app.guestbook (
  id           uuid primary key default gen_random_uuid(),
  no           bigint generated always as identity unique,   -- shown as #027
  text         text not null,
  author_name  text not null,
  student_id   text not null,
  client_token text,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index guestbook_live_idx    on app.guestbook (no desc) where deleted_at is null;
create index guestbook_student_idx on app.guestbook (student_id, created_at desc);
create index guestbook_client_idx  on app.guestbook (client_token, created_at desc);
alter table app.guestbook enable row level security;
revoke all on app.guestbook from public, anon, authenticated;


create function public.post_guestbook(p_text text, p_name text, p_student_id text, p_client text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st     app.settings;
  v_text text;
  v_name text;
  v_sid  text;
  v_cli  text;
  v_last timestamptz;
  v_row  app.guestbook;
begin
  select * into st from app.settings where id;
  if not st.guestbook_open then perform app.err('guestbook_closed'); end if;

  v_name := app.clean_name(p_name);
  v_sid  := app.clean_sid(p_student_id);
  v_cli  := app.clean_client(p_client);
  v_text := app.clean_text(p_text);
  if v_text = '' then perform app.err('empty_text'); end if;
  if char_length(v_text) > st.guestbook_max_chars then
    perform app.err('too_long', jsonb_build_object('max', st.guestbook_max_chars));
  end if;

  -- serialize per person so the cooldown can't be raced
  perform pg_advisory_xact_lock(hashtextextended('guestbook:' || v_sid, 0));

  select max(created_at) into v_last from app.guestbook
   where student_id = v_sid or (v_cli is not null and client_token = v_cli);
  if v_last is not null and v_last + make_interval(secs => st.guestbook_cooldown_seconds) > now() then
    perform app.err('cooldown', jsonb_build_object('wait',
      ceil(extract(epoch from (v_last + make_interval(secs => st.guestbook_cooldown_seconds) - now())))::int));
  end if;

  insert into app.guestbook (text, author_name, student_id, client_token)
  values (v_text, v_name, v_sid, v_cli)
  returning * into v_row;

  perform app.bump(array['guestbook']);
  return jsonb_build_object('id', v_row.id, 'no', v_row.no, 'created_at', v_row.created_at);
end $$;


-- Newest first. p_before = a message number to page from (exclusive).
create function public.list_guestbook(p_before bigint default null, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  st      app.settings;
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_items jsonb;
  v_more  boolean;
begin
  select * into st from app.settings where id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'no', g.no, 'text', g.text,
           'author_name', g.author_name,
           'student_id', case when st.show_student_id then g.student_id end,
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


create function public.admin_list_guestbook(p_limit int default 300)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  select coalesce(jsonb_agg(to_jsonb(g) order by g.no desc), '[]'::jsonb) into v
    from (select * from app.guestbook order by no desc
           limit least(greatest(coalesce(p_limit, 300), 1), 2000)) g;
  return v;
end $$;


create function public.admin_set_guestbook_deleted(p_id uuid, p_deleted boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g app.guestbook;
begin
  perform app.require_admin();
  update app.guestbook set deleted_at = case when p_deleted then now() end
   where id = p_id returning * into g;
  if not found then perform app.err('not_found'); end if;
  perform app.log(case when p_deleted then 'hide_guestbook' else 'restore_guestbook' end, g.id,
                  jsonb_build_object('no', g.no, 'text', g.text));
  perform app.bump(array['guestbook', 'admin']);
  return jsonb_build_object('ok', true);
end $$;


-- get_public_settings: + guestbook settings
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
    'server_now', now())
  from app.settings where id
$$;


-- admin_update_settings: + guestbook settings
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


-- admin_export: + guestbook
create or replace function public.admin_export()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'exported_at', now(),
    'settings',  (select to_jsonb(s) - 'id' from app.settings s where id),
    'stories',   (select coalesce(jsonb_agg(to_jsonb(s) - 'baton_token' order by s.created_at), '[]'::jsonb) from app.stories s),
    'lines',     (select coalesce(jsonb_agg(to_jsonb(l) order by l.story_id, l.depth, l.created_at), '[]'::jsonb) from app.lines l),
    'guestbook', (select coalesce(jsonb_agg(to_jsonb(g) order by g.no), '[]'::jsonb) from app.guestbook g),
    'admin_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from app.admin_log a));
end $$;


do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('post_guestbook', 'list_guestbook', 'admin_list_guestbook', 'admin_set_guestbook_deleted')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname like 'admin\_%' then
      execute format('grant execute on function %s to authenticated', f.sig);
    else
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
