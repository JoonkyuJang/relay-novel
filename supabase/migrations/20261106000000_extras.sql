-- =====================================================================
-- 부가 기능 (extras): one jsonb of switches, stamps, shared counters
-- (cat pets, abandoned batons = 휴지통), story cards and 이 컴퓨터에 관하여.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings: every 부가 기능 switch lives in one jsonb so new switches
-- don't need a migration. Defaults live in app.extras_defaults().
-- ---------------------------------------------------------------------

alter table app.settings add column extras jsonb not null default '{}'::jsonb
  check (pg_column_size(extras) < 8000);

create function app.extras_defaults()
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
 "fun_catreads": true
}$json$::jsonb
$$;

create function app.extras()
returns jsonb language sql stable set search_path = '' as $$
  select app.extras_defaults() || coalesce((select extras from app.settings where id), '{}'::jsonb)
$$;

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
    'extras', app.extras(),
    'server_now', now())
  from app.settings where id
$$;

-- admin_update_settings: same as before plus p.extras (merged key by key).
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
-- Shared counters: cat pets, 휴지통 (batons let go without a line)
-- ---------------------------------------------------------------------

create table app.counters (
  key   text primary key,
  value bigint not null default 0
);
alter table app.counters enable row level security;
insert into app.counters(key) values ('cat_pets'), ('trash');

create function app.count_trash()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- a held baton went away (released, expired and taken over, cleared by
  -- admin) without a line being written in this transaction
  if old.baton_token is not null
     and new.baton_token is distinct from old.baton_token
     and (new.baton_token is null or old.baton_expires_at <= now())
     and new.line_count = old.line_count
     and not exists (select 1 from app.lines l where l.story_id = new.id and l.created_at = now()) then
    update app.counters set value = value + 1 where key = 'trash';
  end if;
  return new;
end $$;

create trigger stories_count_trash after update of baton_token on app.stories
  for each row execute function app.count_trash();

create function public.pet_cat()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  if not (app.extras()->>'cat')::boolean then perform app.err('feature_off'); end if;
  update app.counters set value = value + 1 where key = 'cat_pets' returning value into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Stamps (도장): three kinds, one of each per person per line.
-- Position inside the pad is fixed when stamped (fractions 0..1).
-- ---------------------------------------------------------------------

create table app.stamps (
  id          bigserial primary key,
  line_id     uuid not null references app.lines(id),
  story_id    uuid not null references app.stories(id),
  kind        text not null check (kind in ('sun', 'laugh', 'cur')),
  author_name text not null,
  student_id  text not null,
  client_token text,
  x           real not null,
  y           real not null,
  rot         smallint not null,
  created_at  timestamptz not null default now(),
  unique (line_id, kind, student_id)
);
alter table app.stamps enable row level security;
create index stamps_story_idx on app.stamps (story_id);

-- -> { stamped: bool, kind, counts: {sun, laugh, cur} }
create function public.toggle_stamp(
  p_line_id uuid, p_kind text, p_name text, p_student_id text, p_client text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  l app.lines; v_name text; v_sid text; v_on boolean; v_counts jsonb;
begin
  if not (app.extras()->>'stamps')::boolean then perform app.err('feature_off'); end if;
  if p_kind not in ('sun', 'laugh', 'cur') then perform app.err('invalid_kind'); end if;
  v_name := app.clean_name(p_name);
  v_sid  := app.clean_sid(p_student_id);

  select ln.* into l from app.lines ln join app.stories s on s.id = ln.story_id
   where ln.id = p_line_id and ln.kind = 'canonical' and ln.deleted_at is null and s.deleted_at is null;
  if not found then perform app.err('line_not_found'); end if;

  perform pg_advisory_xact_lock(hashtext('stamp:' || v_sid));
  delete from app.stamps where line_id = l.id and kind = p_kind and student_id = v_sid;
  v_on := not found;
  if v_on then
    insert into app.stamps(line_id, story_id, kind, author_name, student_id, client_token, x, y, rot)
    values (l.id, l.story_id, p_kind, v_name, v_sid, app.clean_client(p_client),
            random(), random(), (random() * 50 - 25)::smallint);
  end if;

  select jsonb_build_object(
           'sun',   count(*) filter (where kind = 'sun'),
           'laugh', count(*) filter (where kind = 'laugh'),
           'cur',   count(*) filter (where kind = 'cur'))
    into v_counts from app.stamps where line_id = l.id;

  perform app.bump(array[l.story_id::text]);
  return jsonb_build_object('stamped', v_on, 'kind', p_kind, 'counts', v_counts);
end $$;

-- All stamps of a story: { <line_id>: { marks: [{k,x,y,r}], counts: {...}, mine: [kinds] } }
create function public.get_story_stamps(p_story_id uuid, p_student_id text default null)
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
             where p_student_id is not null
               and st.student_id = upper(regexp_replace(normalize(p_student_id, nfkc), '[\s-]', '', 'g'))),
             '[]'::jsonb) as mine
    from app.stamps st
    join app.lines l on l.id = st.line_id
    where st.story_id = p_story_id and l.kind = 'canonical' and l.deleted_at is null
    group by st.line_id
  ) x
$$;

create function public.admin_line_stamps(p_line_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', kind, 'name', author_name, 'student_id', student_id, 'created_at', created_at)
           order by created_at), '[]'::jsonb)
    into v from app.stamps where line_id = p_line_id;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Cards for finished stories and the 이 컴퓨터에 관하여 window
-- ---------------------------------------------------------------------

-- Finished stories: characters, distinct writers, stamp totals.
create function public.story_cards()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(s.id, jsonb_build_object(
           'chars',   (select coalesce(sum(char_length(l.text)), 0) from app.lines l
                        where l.story_id = s.id and l.kind = 'canonical' and l.deleted_at is null),
           'writers', (select count(distinct l.student_id) from app.lines l
                        where l.story_id = s.id and l.kind = 'canonical' and l.deleted_at is null),
           'stamps',  (select jsonb_build_object(
                         'sun',   count(*) filter (where st.kind = 'sun'),
                         'laugh', count(*) filter (where st.kind = 'laugh'),
                         'cur',   count(*) filter (where st.kind = 'cur'))
                       from app.stamps st join app.lines l on l.id = st.line_id
                       where st.story_id = s.id and l.kind = 'canonical' and l.deleted_at is null))),
         '{}'::jsonb)
  from app.stories s
  where s.deleted_at is null and s.status = 'completed'
$$;

create function public.get_about()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'stories', (select count(*) from app.stories where deleted_at is null),
    'lines',   (select count(*) from app.lines l join app.stories s on s.id = l.story_id
                 where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null),
    'chars',   (select coalesce(sum(char_length(l.text)), 0) from app.lines l join app.stories s on s.id = l.story_id
                 where l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null),
    'stamps',  (select count(*) from app.stamps),
    'since',   (select min(created_at) from app.stories),
    'cat_pets', (select value from app.counters where key = 'cat_pets'),
    'trash',    (select value from app.counters where key = 'trash'),
    'server_now', now())
$$;

-- ---------------------------------------------------------------------
-- Privileges
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
      'get_public_settings', 'admin_update_settings', 'pet_cat', 'toggle_stamp',
      'get_story_stamps', 'admin_line_stamps', 'story_cards', 'get_about')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname like 'admin\_%' then
      execute format('grant execute on function %s to authenticated', f.sig);
    else
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
