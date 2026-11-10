-- =====================================================================
-- 새로운 이야기 건의함 (2026-11-10).
-- Only admins start stories directly now. Everyone else proposes a title + first line; proposals wait
-- in the 건의함, where logged-in people can ♥ them (a guide, not a vote count that decides anything),
-- and an admin 채택s one (editing the title / first line first, if needed) or 반려s it.
-- An adopted proposal becomes an ordinary story whose first line stays in the proposer's name.
-- The master switch `proposals` (on) can turn all of this off: then everyone starts stories as before.
--
-- Also: the flood-guard caps become settings (0 = no cap), write_check also tells you how many lines
-- you've written in that story (내 줄 1/1), and 초기화 / 백업 know about the 건의함.
-- =====================================================================

-- ---------------------------------------------------------------------
-- switches and numbers
-- ---------------------------------------------------------------------
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
 "flood_guestbook": 60
}$json$::jsonb
$$;

-- ---------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------
create table app.proposals (
  id           uuid primary key default gen_random_uuid(),
  title        text,
  text         text not null,
  author_name  text not null,
  student_id   text not null,
  client_token text,
  status       text not null default 'waiting' check (status in ('waiting', 'adopted', 'rejected', 'withdrawn')),
  likes        int  not null default 0,
  story_id     uuid references app.stories(id) on delete set null,
  edited       boolean not null default false,          -- the admin changed the title or first line on 채택
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  seen_at      timestamptz                              -- the proposer has seen the "채택됐어요" note
);
create index proposals_status_idx  on app.proposals (status, created_at);
create index proposals_person_idx  on app.proposals (student_id);
create index proposals_created_idx on app.proposals (created_at);

create table app.proposal_votes (
  proposal_id  uuid not null references app.proposals(id) on delete cascade,
  student_id   text not null,
  author_name  text not null,
  client_token text,
  created_at   timestamptz not null default now(),
  primary key (proposal_id, student_id)
);

alter table app.proposals      enable row level security;
alter table app.proposal_votes enable row level security;

-- ---------------------------------------------------------------------
-- flood guard: caps from the settings (0 = no cap); 건의 share the 새 이야기 cap
-- ---------------------------------------------------------------------
create or replace function app.flood_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_cap int; v_n int; x jsonb := app.extras();
begin
  v_cap := case tg_table_name
             when 'stories'   then coalesce((x->>'flood_stories')::int, 60)
             when 'proposals' then coalesce((x->>'flood_stories')::int, 60)
             when 'guestbook' then coalesce((x->>'flood_guestbook')::int, 60)
             else coalesce((x->>'flood_lines')::int, 300) end;
  if v_cap <= 0 then return new; end if;
  execute format('select count(*) from app.%I where created_at > now() - interval ''1 minute''', tg_table_name) into v_n;
  if v_n >= v_cap then perform app.err('rate_limited'); end if;
  return new;
end $$;
create trigger proposals_flood_guard before insert on app.proposals for each row execute function app.flood_guard();

-- ---------------------------------------------------------------------
-- create_story: admins only while the 건의함 is on (admins skip 새 이야기 허용 and the per-person cap)
-- ---------------------------------------------------------------------
create or replace function public.create_story(
  p_title text, p_text text, p_name text, p_student_id text, p_client text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st      app.settings;
  v_admin boolean := app.is_admin();
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
  if coalesce((app.extras()->>'proposals')::boolean, false) and not v_admin then perform app.err('admin_only'); end if;
  if not st.submissions_open  then perform app.err('submissions_closed'); end if;
  if app.deadline_passed() then perform app.err('deadline_passed'); end if;
  if not st.allow_new_stories and not v_admin then perform app.err('new_stories_closed'); end if;

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

  if not v_admin then
    select count(*) into v_count
    from app.lines l join app.stories s on s.id = l.story_id
    where l.depth = 1 and l.kind = 'canonical' and l.student_id = v_sid
      and l.deleted_at is null and s.deleted_at is null;
    if v_count >= st.stories_started_per_person then
      perform app.err('story_limit', jsonb_build_object('max', st.stories_started_per_person));
    end if;
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
-- proposing, liking, withdrawing
-- ---------------------------------------------------------------------
create function app.proposals_closed_code()
returns text language plpgsql stable set search_path = '' as $$
declare st app.settings; x jsonb := app.extras();
begin
  select * into st from app.settings where id;
  if not coalesce((x->>'proposals')::boolean, false) then return 'feature_off'; end if;
  if not st.submissions_open then return 'submissions_closed'; end if;
  if app.deadline_passed() then return 'deadline_passed'; end if;
  if coalesce((x->>'proposals_close_at_deadline')::boolean, false) and now() >= (x->>'deadline')::timestamptz then
    return 'deadline_passed';
  end if;
  if not st.allow_new_stories then return 'proposals_closed'; end if;
  return null;
end $$;

create function public.propose_story(
  p_title text, p_text text, p_name text, p_student_id text, p_client text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st app.settings; v_code text; v_title text; v_text text; v_name text; v_sid text;
  v_max int; v_n int; v_id uuid;
begin
  v_code := app.proposals_closed_code();
  if v_code is not null then perform app.err(v_code); end if;
  select * into st from app.settings where id;

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

  perform pg_advisory_xact_lock(hashtextextended('proposer:' || v_sid, 0));
  v_max := coalesce((app.extras()->>'proposals_per_person')::int, 2);
  select count(*) into v_n from app.proposals where student_id = v_sid and status = 'waiting';
  if v_n >= v_max then perform app.err('proposal_limit', jsonb_build_object('max', v_max)); end if;

  insert into app.proposals (title, text, author_name, student_id, client_token)
  values (v_title, v_text, v_name, v_sid, app.clean_client(p_client))
  returning id into v_id;

  perform app.bump(array['proposals']);
  return jsonb_build_object('proposal_id', v_id, 'waiting', v_n + 1, 'max', v_max);
end $$;

create function public.vote_proposal(p_id uuid, p_name text, p_student_id text, p_client text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p app.proposals; v_name text; v_sid text; v_on boolean; v_owner text;
begin
  if not coalesce((app.extras()->>'proposals')::boolean, false)
     or not coalesce((app.extras()->>'proposal_likes')::boolean, true) then
    perform app.err('feature_off');
  end if;
  v_name := app.clean_name(p_name);
  v_sid  := app.clean_sid(p_student_id);
  select * into p from app.proposals where id = p_id for update;
  if not found or p.status <> 'waiting' then perform app.err('proposal_not_found'); end if;
  if p.student_id = v_sid then perform app.err('own_proposal'); end if;

  select author_name into v_owner from app.proposal_votes where proposal_id = p.id and student_id = v_sid;
  if found then
    if v_owner is distinct from v_name then perform app.err('not_your_stamp'); end if;   -- same 이름 + 학번, any device
    delete from app.proposal_votes where proposal_id = p.id and student_id = v_sid;
    v_on := false;
  else
    insert into app.proposal_votes (proposal_id, student_id, author_name, client_token)
    values (p.id, v_sid, v_name, app.clean_client(p_client));
    v_on := true;
  end if;
  update app.proposals set likes = (select count(*) from app.proposal_votes where proposal_id = p.id)
   where id = p.id returning * into p;

  perform app.bump(array['proposals']);
  return jsonb_build_object('liked', v_on, 'likes', p.likes);
end $$;

create function public.withdraw_proposal(p_id uuid, p_name text, p_student_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p app.proposals;
begin
  if not coalesce((app.extras()->>'proposal_withdraw')::boolean, true) then perform app.err('feature_off'); end if;
  select * into p from app.proposals where id = p_id for update;
  if not found or p.status <> 'waiting'
     or p.student_id <> app.clean_sid(p_student_id) or p.author_name <> app.clean_name(p_name) then
    perform app.err('proposal_not_found');
  end if;
  update app.proposals set status = 'withdrawn', decided_at = now() where id = p.id;
  perform app.bump(array['proposals']);
  return jsonb_build_object('ok', true);
end $$;

-- the 건의함 everyone sees: waiting proposals, no 학번; ♥ counts unless the admin hid them
create function public.list_proposals(p_student_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sid text; v_show boolean; v_admin boolean := app.is_admin(); v jsonb; v_mine int := 0;
begin
  if not coalesce((app.extras()->>'proposals')::boolean, false) then perform app.err('feature_off'); end if;
  v_sid  := nullif(upper(regexp_replace(normalize(coalesce(p_student_id, ''), nfkc), '[\s-]', '', 'g')), '');
  v_show := coalesce((app.extras()->>'proposal_likes_public')::boolean, true) or v_admin;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'title', p.title, 'text', p.text, 'author_name', p.author_name,
           'created_at', p.created_at,
           'likes', case when v_show then p.likes end,
           'liked', v_sid is not null and exists (select 1 from app.proposal_votes v where v.proposal_id = p.id and v.student_id = v_sid),
           'mine', v_sid is not null and p.student_id = v_sid)
           order by p.created_at desc), '[]'::jsonb)
    into v from app.proposals p where p.status = 'waiting';
  if v_sid is not null then
    select count(*) into v_mine from app.proposals where student_id = v_sid and status = 'waiting';
  end if;
  return jsonb_build_object('items', v, 'my_waiting', v_mine, 'closed', app.proposals_closed_code());
end $$;

-- 내 건의 (in 내가 쓴 줄), every status; and the one-time "채택됐어요" note
create function public.my_proposals(p_student_id text, p_name text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'title', p.title, 'text', p.text, 'status', p.status, 'likes', p.likes,
           'story_id', p.story_id, 'created_at', p.created_at, 'decided_at', p.decided_at,
           'seen', p.seen_at is not null)
           order by p.created_at desc), '[]'::jsonb)
    from app.proposals p
   where p.student_id = app.clean_sid(p_student_id) and p.author_name = app.clean_name(p_name)
     and p.status <> 'withdrawn'
$$;

create function public.ack_proposals(p_student_id text, p_name text)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update app.proposals set seen_at = now()
   where student_id = app.clean_sid(p_student_id) and author_name = app.clean_name(p_name)
     and status = 'adopted' and seen_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- admin: list everything, 채택 (with edits), 반려, 되돌리기
-- ---------------------------------------------------------------------
create function public.admin_list_proposals()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'title', p.title, 'text', p.text, 'author_name', p.author_name, 'student_id', p.student_id,
           'status', p.status, 'likes', p.likes, 'story_id', p.story_id, 'edited', p.edited,
           'created_at', p.created_at, 'decided_at', p.decided_at,
           'author_stories', (select count(*) from app.lines l join app.stories s on s.id = l.story_id
                               where l.depth = 1 and l.kind = 'canonical' and l.student_id = p.student_id
                                 and l.deleted_at is null and s.deleted_at is null))
           order by p.created_at desc), '[]'::jsonb)
    from app.proposals p);
end $$;

create function public.admin_adopt_proposal(p_id uuid, p_title text, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  st app.settings; p app.proposals; v_title text; v_text text; v_story uuid; v_line uuid; v_count int;
begin
  perform app.require_admin();
  select * into st from app.settings where id;
  select * into p from app.proposals where id = p_id for update;
  if not found or p.status <> 'waiting' then perform app.err('proposal_not_found'); end if;

  v_text  := app.clean_text(coalesce(p_text, p.text));
  v_title := nullif(app.clean_text(coalesce(p_title, p.title)), '');
  if v_text = '' then perform app.err('empty_text'); end if;
  if char_length(v_text) > st.max_chars then perform app.err('too_long', jsonb_build_object('max', st.max_chars)); end if;
  if v_title is null and (app.extras()->>'title_required')::boolean then perform app.err('title_required'); end if;
  if v_title is not null and char_length(v_title) > st.max_title_chars then
    perform app.err('title_too_long', jsonb_build_object('max', st.max_title_chars));
  end if;

  select count(*) into v_count
    from app.lines l join app.stories s on s.id = l.story_id
   where l.depth = 1 and l.kind = 'canonical' and l.student_id = p.student_id
     and l.deleted_at is null and s.deleted_at is null;

  insert into app.stories (title) values (v_title) returning id into v_story;
  insert into app.lines (story_id, parent_id, depth, text, author_name, student_id, client_token, kind)
  values (v_story, null, 1, v_text, p.author_name, p.student_id, p.client_token, 'canonical')
  returning id into v_line;
  update app.stories
     set head_line_id = v_line, line_count = 1,
         status = case when st.max_lines <= 1 then 'completed' else 'open' end,
         completed_at = case when st.max_lines <= 1 then now() end
   where id = v_story;

  update app.proposals
     set status = 'adopted', story_id = v_story, decided_at = now(),
         edited = (v_title is distinct from p.title or v_text is distinct from p.text)
   where id = p.id;

  perform app.log('adopt_proposal', v_story, jsonb_build_object('proposal', p.id, 'title', v_title,
                  'edited', v_title is distinct from p.title or v_text is distinct from p.text));
  perform app.bump(array['list', 'proposals', 'admin', v_story::text]);
  return jsonb_build_object('story_id', v_story, 'line_id', v_line,
                            'over_limit', v_count >= st.stories_started_per_person);
end $$;

create function public.admin_reject_proposal(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p app.proposals;
begin
  perform app.require_admin();
  select * into p from app.proposals where id = p_id for update;
  if not found or p.status <> 'waiting' then perform app.err('proposal_not_found'); end if;
  update app.proposals set status = 'rejected', decided_at = now() where id = p.id;
  perform app.log('reject_proposal', null, jsonb_build_object('proposal', p.id, 'title', p.title));
  perform app.bump(array['proposals', 'admin']);
  return jsonb_build_object('ok', true);
end $$;

create function public.admin_restore_proposal(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p app.proposals;
begin
  perform app.require_admin();
  select * into p from app.proposals where id = p_id for update;
  if not found or p.status not in ('rejected', 'withdrawn') then perform app.err('proposal_not_found'); end if;
  update app.proposals set status = 'waiting', decided_at = null where id = p.id;
  perform app.log('restore_proposal', null, jsonb_build_object('proposal', p.id, 'title', p.title));
  perform app.bump(array['proposals', 'admin']);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- write_check: also how many lines I have in this story (shown as "내 줄 1/1")
-- ---------------------------------------------------------------------
create or replace function public.write_check(p_story_id uuid, p_student_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  st app.settings; s app.stories; v_sid text; v_mine int; v_max int; v_count jsonb;
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
  if s.status <> 'open' or s.line_count >= coalesce(s.max_lines, st.max_lines) then
    return v_count || jsonb_build_object('code', 'story_closed');
  end if;
  if s.baton_expires_at > now() and s.baton_sid <> v_sid then
    return v_count || jsonb_build_object('code', 'baton_held', 'detail', jsonb_build_object('expires_at', s.baton_expires_at));
  end if;
  if v_mine >= v_max then
    return v_count || jsonb_build_object('code', 'person_limit', 'detail', jsonb_build_object('max', v_max));
  end if;
  if not st.allow_consecutive_lines and exists (
       select 1 from app.lines where id = s.head_line_id and student_id = v_sid) then
    return v_count || jsonb_build_object('code', 'consecutive');
  end if;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- 초기화 + 백업 know the 건의함
-- ---------------------------------------------------------------------
create or replace function public.admin_reset_counts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'cat_pets',      (select value from app.counters where key = 'cat_pets'),
    'trash',         (select value from app.counters where key = 'trash'),
    'client_errors', (select count(*) from app.client_errors),
    'stamps',        (select count(*) from app.stamps),
    'guestbook',     (select count(*) from app.guestbook),
    'proposals',     (select count(*) from app.proposals),
    'test_stories',  (select count(*) from app.stories where title like '[TEST]%'),
    'stories',       (select count(*) from app.stories),
    'lines',         (select count(*) from app.lines),
    'conflicts',     (select count(*) from app.lines where kind <> 'canonical'),
    'log',           (select count(*) from app.admin_log));
end $$;

create or replace function public.admin_reset(p_what text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  known constant text[] := array['cat_pets', 'trash', 'client_errors', 'stamps', 'guestbook', 'proposals', 'test_stories', 'stories', 'log'];
  v_before jsonb;
  v_ids uuid[];
begin
  perform app.require_admin();
  if p_what is null or cardinality(p_what) = 0 or exists (select 1 from unnest(p_what) w where w <> all(known)) then
    perform app.err('invalid_reset');
  end if;
  v_before := public.admin_reset_counts();

  if 'cat_pets' = any(p_what) then update app.counters set value = 0 where key = 'cat_pets'; end if;
  if 'client_errors' = any(p_what) then delete from app.client_errors; end if;
  if 'stamps' = any(p_what) then delete from app.stamps; end if;
  if 'guestbook' = any(p_what) then
    delete from app.guestbook;
    alter table app.guestbook alter column no restart with 1;
  end if;
  if 'proposals' = any(p_what) then delete from app.proposal_votes; delete from app.proposals; end if;
  if 'stories' = any(p_what) then
    select array_agg(id) into v_ids from app.stories;
    perform app.purge_stories(v_ids);
  elsif 'test_stories' = any(p_what) then
    select array_agg(id) into v_ids from app.stories where title like '[TEST]%';
    perform app.purge_stories(v_ids);
  end if;
  -- after the stories: letting go of batons above must not count as 휴지통
  if 'trash' = any(p_what) then update app.counters set value = 0 where key = 'trash'; end if;
  if 'log' = any(p_what) then delete from app.admin_log; end if;

  perform app.log('reset', null, jsonb_build_object('what', to_jsonb(p_what), 'before', v_before));
  perform app.bump(array['list', 'admin', 'guestbook', 'settings', 'proposals']);
  return public.admin_reset_counts();
end $$;

create or replace function public.admin_export()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'exported_at', now(),
    'settings',  (select to_jsonb(s) - 'id' from app.settings s where id),
    'stories',   (select coalesce(jsonb_agg(to_jsonb(s) - 'baton_token' order by s.created_at), '[]'::jsonb) from app.stories s),
    'lines',     (select coalesce(jsonb_agg(to_jsonb(l) order by l.story_id, l.depth, l.created_at), '[]'::jsonb) from app.lines l),
    'stamps',    (select coalesce(jsonb_agg(to_jsonb(st) order by st.id), '[]'::jsonb) from app.stamps st),
    'guestbook', (select coalesce(jsonb_agg(to_jsonb(g) order by g.no), '[]'::jsonb) from app.guestbook g),
    'proposals', (select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at), '[]'::jsonb) from app.proposals p),
    'proposal_votes', (select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at), '[]'::jsonb) from app.proposal_votes v),
    'counters',  (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from app.counters),
    'client_errors', (select coalesce(jsonb_agg(to_jsonb(e) - 'client_token' order by e.id), '[]'::jsonb) from app.client_errors e),
    'admin_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from app.admin_log a));
end $$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke all on function app.proposals_closed_code() from public, anon, authenticated;
revoke all on function public.propose_story(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.propose_story(text, text, text, text, text) to anon, authenticated;
revoke all on function public.vote_proposal(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.vote_proposal(uuid, text, text, text) to anon, authenticated;
revoke all on function public.withdraw_proposal(uuid, text, text) from public, anon, authenticated;
grant execute on function public.withdraw_proposal(uuid, text, text) to anon, authenticated;
revoke all on function public.list_proposals(text) from public, anon, authenticated;
grant execute on function public.list_proposals(text) to anon, authenticated;
revoke all on function public.my_proposals(text, text) from public, anon, authenticated;
grant execute on function public.my_proposals(text, text) to anon, authenticated;
revoke all on function public.ack_proposals(text, text) from public, anon, authenticated;
grant execute on function public.ack_proposals(text, text) to anon, authenticated;
revoke all on function public.admin_list_proposals() from public, anon, authenticated;
grant execute on function public.admin_list_proposals() to authenticated;
revoke all on function public.admin_adopt_proposal(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_adopt_proposal(uuid, text, text) to authenticated;
revoke all on function public.admin_reject_proposal(uuid) from public, anon, authenticated;
grant execute on function public.admin_reject_proposal(uuid) to authenticated;
revoke all on function public.admin_restore_proposal(uuid) from public, anon, authenticated;
grant execute on function public.admin_restore_proposal(uuid) to authenticated;
