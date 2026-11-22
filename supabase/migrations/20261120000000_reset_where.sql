-- =====================================================================
-- 초기화 on Supabase (2026-11-23)
--  * Supabase's API runs every request with pg-safeupdate, which refuses a DELETE (or UPDATE) that has
--    no WHERE clause — even inside a function. admin_reset emptied some tables with a bare
--    "delete from …;", so 방명록 · 건의함 · 도장 · 브라우저 오류 · 관리 기록 비우기 (and 전부 초기화)
--    failed there ("DELETE requires a WHERE clause"). Same function, with "where true".
--    (Locally the tests now also refuse any bare DELETE / UPDATE in a function body.)
-- =====================================================================

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
  if 'client_errors' = any(p_what) then delete from app.client_errors where true; end if;
  if 'stamps' = any(p_what) then delete from app.stamps where true; end if;
  if 'guestbook' = any(p_what) then
    delete from app.guestbook where true;
    alter table app.guestbook alter column no restart with 1;
  end if;
  if 'proposals' = any(p_what) then delete from app.proposal_votes where true; delete from app.proposals where true; end if;
  if 'stories' = any(p_what) then
    select array_agg(id) into v_ids from app.stories;
    perform app.purge_stories(v_ids);
  elsif 'test_stories' = any(p_what) then
    select array_agg(id) into v_ids from app.stories where title like '[TEST]%';
    perform app.purge_stories(v_ids);
  end if;
  -- after the stories: letting go of batons above must not count as 휴지통
  if 'trash' = any(p_what) then update app.counters set value = 0 where key = 'trash'; end if;
  if 'log' = any(p_what) then delete from app.admin_log where true; end if;

  perform app.log('reset', null, jsonb_build_object('what', to_jsonb(p_what), 'before', v_before));
  perform app.bump(array['list', 'admin', 'guestbook', 'settings', 'proposals']);
  return public.admin_reset_counts();
end $$;
