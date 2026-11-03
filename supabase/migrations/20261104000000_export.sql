-- =====================================================================
-- Story export (single completed story, or all completed stories)
--  * export_credits setting: how each line is credited in exports
--      'name_sid' (default) | 'name' | 'none'
--  * public.export_stories(p_story_id): completed stories only, official
--    lines only, admin-hidden lines omitted, ordered by completion date.
-- =====================================================================

alter table app.settings
  add column export_credits text not null default 'name_sid'
  check (export_credits in ('none', 'name', 'name_sid'));


create function public.export_stories(p_story_id uuid default null)
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
                      'student_id',  case when st.export_credits = 'name_sid' then l.student_id end
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

revoke all on function public.export_stories(uuid) from public, anon, authenticated;
grant execute on function public.export_stories(uuid) to anon, authenticated;


-- admin_update_settings: same as before, plus export_credits.
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
