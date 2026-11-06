-- =====================================================================
-- Flood guard (2026-11-06). Writing is honor-system (anyone can type any 이름 + 학번), so the per-person
-- limits can't stop a script that invents people. These caps stop such a flood without ever being
-- felt by a real program: at most 60 new stories, 60 방명록 notes and 300 lines (incl. conflicts)
-- a minute, for the whole site. Over the cap → 'rate_limited' ("잠시 후 다시").
-- =====================================================================

create function app.flood_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_cap int; v_n int;
begin
  v_cap := case tg_table_name when 'stories' then 60 when 'guestbook' then 60 else 300 end;
  execute format('select count(*) from app.%I where created_at > now() - interval ''1 minute''', tg_table_name) into v_n;
  if v_n >= v_cap then perform app.err('rate_limited'); end if;
  return new;
end $$;

create trigger stories_flood_guard before insert on app.stories for each row execute function app.flood_guard();
create trigger guestbook_flood_guard before insert on app.guestbook for each row execute function app.flood_guard();
create trigger lines_flood_guard before insert on app.lines for each row execute function app.flood_guard();

-- the counts above scan "the last minute" — keep them cheap
create index if not exists stories_created_idx on app.stories (created_at);
create index if not exists guestbook_created_idx on app.guestbook (created_at);
create index if not exists lines_created_idx on app.lines (created_at);

revoke all on function app.flood_guard() from public, anon, authenticated;
