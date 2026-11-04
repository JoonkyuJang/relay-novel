-- =====================================================================
-- 관리 · 초기화: put the site back to a clean state before the program starts.
--  * admin_reset_counts(): what there is to clear (shown next to each button)
--  * admin_reset(p_what text[]): clears the chosen parts, permanently.
--      cat_pets      고양이 쓰다듬기 횟수 → 0
--      trash         휴지통 (안 쓰고 놓은 바통) → 0
--      client_errors 브라우저 오류 기록
--      stamps        모든 도장
--      guestbook     방명록 (번호도 #001부터 다시)
--      test_stories  제목이 "[TEST]"로 시작하는 이야기 (와 그 줄 · 도장)
--      stories       모든 이야기 · 줄 · 충돌 · 도장 (출석부도 비게 돼요)
--      log           관리 기록 (초기화했다는 기록 한 줄은 남아요)
--    Settings, 부가 기능 switches and admin accounts are never touched.
-- =====================================================================

create function public.admin_reset_counts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'cat_pets',      (select value from app.counters where key = 'cat_pets'),
    'trash',         (select value from app.counters where key = 'trash'),
    'client_errors', (select count(*) from app.client_errors),
    'stamps',        (select count(*) from app.stamps),
    'guestbook',     (select count(*) from app.guestbook),
    'test_stories',  (select count(*) from app.stories where title like '[TEST]%'),
    'stories',       (select count(*) from app.stories),
    'lines',         (select count(*) from app.lines),
    'conflicts',     (select count(*) from app.lines where kind <> 'canonical'),
    'log',           (select count(*) from app.admin_log));
end $$;

-- delete these stories with everything hanging off them
create function app.purge_stories(p_ids uuid[])
returns int language plpgsql set search_path = '' as $$
declare n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  update app.stories set head_line_id = null where id = any(p_ids);
  delete from app.stamps where story_id = any(p_ids);
  delete from app.lines where story_id = any(p_ids);
  delete from app.stories where id = any(p_ids);
  get diagnostics n = row_count;
  delete from public.realtime_signals where key = any(p_ids::text[]);
  return n;
end $$;

create function public.admin_reset(p_what text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  known constant text[] := array['cat_pets', 'trash', 'client_errors', 'stamps', 'guestbook', 'test_stories', 'stories', 'log'];
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
  perform app.bump(array['list', 'admin', 'guestbook', 'settings']);
  return public.admin_reset_counts();
end $$;

-- the backup now also carries stamps, counters and browser errors (so a reset can be undone by hand)
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
    'counters',  (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from app.counters),
    'client_errors', (select coalesce(jsonb_agg(to_jsonb(e) - 'client_token' order by e.id), '[]'::jsonb) from app.client_errors e),
    'admin_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from app.admin_log a));
end $$;

revoke all on function app.purge_stories(uuid[]) from public, anon, authenticated;
revoke all on function public.admin_reset_counts() from public, anon, authenticated;
grant execute on function public.admin_reset_counts() to authenticated;
revoke all on function public.admin_reset(text[]) from public, anon, authenticated;
grant execute on function public.admin_reset(text[]) to authenticated;
