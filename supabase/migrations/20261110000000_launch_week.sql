-- =====================================================================
-- Launch week (2026-11-05)
--  * 내가 쓴 줄: my_lines() — every line written as this 이름 + 학번, with stamps.
--  * Crash reports: browsers send uncaught errors to app.client_errors
--    (message / where / browser only — no names, no 학번); admins read them
--    in 관리 · 기록. Throttled per device and overall; kept 30 days.
--  * New switches: print_sheet (원고지 인쇄), my_lines, error_reports.
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
 "error_reports": true
}$json$::jsonb
$$;

-- ---------------------------------------------------------------------
-- 내가 쓴 줄
-- ---------------------------------------------------------------------

create function public.my_lines(p_student_id text, p_name text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sid text; v_name text; v jsonb;
begin
  if not coalesce((app.extras()->>'my_lines')::boolean, true) then perform app.err('feature_off'); end if;
  v_sid  := app.clean_sid(p_student_id);
  v_name := app.clean_name(p_name);
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_id', l.id, 'story_id', s.id, 'title', s.title, 'status', s.status,
           'position', l.depth, 'text', l.text, 'created_at', l.created_at,
           'stamps', (select jsonb_build_object(
                        'sun',   count(*) filter (where st.kind = 'sun'),
                        'laugh', count(*) filter (where st.kind = 'laugh'),
                        'cur',   count(*) filter (where st.kind = 'cur'))
                      from app.stamps st where st.line_id = l.id))
           order by l.created_at desc), '[]'::jsonb)
    into v
    from app.lines l join app.stories s on s.id = l.story_id
   where l.student_id = v_sid and l.author_name = v_name
     and l.kind = 'canonical' and l.deleted_at is null and s.deleted_at is null;
  return v;
end $$;

create index if not exists lines_student_idx on app.lines (student_id);

-- ---------------------------------------------------------------------
-- Crash reports
-- ---------------------------------------------------------------------

create table app.client_errors (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  message    text not null,
  source     text,
  stack      text,
  version    text,
  agent      text,
  client_token text
);
alter table app.client_errors enable row level security;
create index client_errors_at_idx on app.client_errors (at desc);
create index client_errors_client_idx on app.client_errors (client_token, at);

-- Fire-and-forget from the browser. Never raises: a broken reporter must not cause more errors.
create function public.log_client_error(
  p_message text, p_source text default null, p_stack text default null,
  p_version text default null, p_agent text default null, p_client text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_client text := left(coalesce(p_client, ''), 64);
begin
  if not coalesce((app.extras()->>'error_reports')::boolean, true) then return; end if;
  if coalesce(btrim(p_message), '') = '' then return; end if;
  -- at most 20 per device per hour, 300 per minute overall
  if (select count(*) from app.client_errors where client_token = v_client and at > now() - interval '1 hour') >= 20 then return; end if;
  if (select count(*) from app.client_errors where at > now() - interval '1 minute') >= 300 then return; end if;
  insert into app.client_errors (message, source, stack, version, agent, client_token)
  values (left(p_message, 500), left(p_source, 300), left(p_stack, 2000), left(p_version, 40), left(p_agent, 200), v_client);
  if random() < 0.02 then delete from app.client_errors where at < now() - interval '30 days'; end if;
exception when others then
  return;
end $$;

create function public.admin_client_errors(p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  select coalesce(jsonb_agg(to_jsonb(x) - 'client_token' order by x.at desc), '[]'::jsonb) into v
    from (select *, left(client_token, 6) as device from app.client_errors
           order by at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------

revoke all on table app.client_errors from public, anon, authenticated;
revoke all on sequence app.client_errors_id_seq from public, anon, authenticated;
revoke all on function public.my_lines(text, text) from public, anon, authenticated;
grant execute on function public.my_lines(text, text) to anon, authenticated;
revoke all on function public.log_client_error(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.log_client_error(text, text, text, text, text, text) to anon, authenticated;
revoke all on function public.admin_client_errors(int) from public, anon, authenticated;
grant execute on function public.admin_client_errors(int) to authenticated;
