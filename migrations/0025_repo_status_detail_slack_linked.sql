-- 0025_repo_status_detail_slack_linked.sql
--
-- Expose a MEMBER-VISIBLE `slack_linked` boolean from repo_status_detail so the
-- /repos drill-down can show step 6 ("Slack channel linked") as done for every
-- project member, not just admins.
--
-- Why a boolean (not the count): the channel inventory + counts stay admin-only
-- (the teambrain-slack /links route and overview.slack_link_count are
-- project-admin-gated because they expose workspace/channel identifiers). Link
-- *presence* is not sensitive, so any member may see it. The SECURITY DEFINER
-- core already reads slack_channels for the admin count in repo_status_overview;
-- this adds an un-gated EXISTS for the detail document.
--
-- CREATE OR REPLACE preserves the function's owner, grants, and the public
-- invoker wrapper from 0024 — only app.repo_status_detail's body changes. The
-- public.repo_status_detail(text) wrapper is unchanged (it just selects this).
--
-- Apply via the Studio SQL editor (runs as supabase_admin), like every
-- migration. Conventions per 0024: set search_path = ''; fully-qualified names;
-- RLS visibility re-implemented via app.is_project_member/writer/admin.

create or replace function app.repo_status_detail(p_slug text)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with proj as (
    select p.id, p.repo_slug, p.name
      from public.projects p
     where p.repo_slug = p_slug
       and app.is_project_member(p.id)
     limit 1
  )
  select case when not exists (select 1 from proj) then null else (
    select pg_catalog.jsonb_build_object(
      'project', pg_catalog.jsonb_build_object(
        'id',          pr.id,
        'repo_slug',   pr.repo_slug,
        'name',        pr.name,
        'caller_role', (select pm.role::text
                          from public.project_members pm
                         where pm.project_id = pr.id
                           and pm.user_id    = (select auth.uid())
                           and pm.removed_at is null
                         limit 1),
        'is_admin',    app.is_project_admin(pr.id),
        'is_writer',   app.is_project_writer(pr.id)
      ),
      -- Member-visible link PRESENCE (not the admin-only count/inventory).
      'slack_linked', exists (
        select 1 from public.slack_channels s where s.project_id = pr.id
      ),
      'members_by_role', (
        select coalesce(pg_catalog.jsonb_object_agg(role, cnt), '{}'::jsonb)
        from (
          select pm.role::text as role, pg_catalog.count(*) as cnt
            from public.project_members pm
           where pm.project_id = pr.id
             and pm.removed_at is null
             and pm.is_service_account = false
           group by pm.role
        ) m
      ),
      'memories_by_type', (
        select coalesce(pg_catalog.jsonb_object_agg(typ, cnt), '{}'::jsonb)
        from (
          select coalesce(t.type::text, 'untyped') as typ, pg_catalog.count(*) as cnt
            from public.thoughts t
           where t.project_id = pr.id
             and (t.scope = 'project'::public.thought_scope
                  or (t.scope = 'project_private'::public.thought_scope
                      and app.is_project_writer(pr.id)))
           group by coalesce(t.type::text, 'untyped')
        ) ty
      ),
      'fresh_vs_stale', (
        select pg_catalog.jsonb_build_object(
          'total', pg_catalog.count(*),
          'stale', pg_catalog.count(*) filter (where t.stale_flagged_at is not null)
        )
        from public.thoughts t
        where t.project_id = pr.id
          and (t.scope = 'project'::public.thought_scope
               or (t.scope = 'project_private'::public.thought_scope
                   and app.is_project_writer(pr.id)))
      ),
      'capture_weeks', (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object('week', wk, 'count', cnt) order by wk
          ), '[]'::jsonb)
        from (
          select (pg_catalog.date_trunc('week', t.created_at))::date as wk,
                 pg_catalog.count(*) as cnt
            from public.thoughts t
           where t.project_id = pr.id
             and t.created_at >= pg_catalog.now() - '112 days'::interval
             and (t.scope = 'project'::public.thought_scope
                  or (t.scope = 'project_private'::public.thought_scope
                      and app.is_project_writer(pr.id)))
           group by 1
        ) w
      ),
      'staleness', (
        select pg_catalog.jsonb_build_object(
          'last_polled_at', sps.last_polled_at,
          'last_sha',       sps.last_sha,
          'default_branch', sps.default_branch)
        from public.staleness_poll_state sps
        where sps.project_id = pr.id
      ),
      'last_sync', (
        select pg_catalog.jsonb_build_object(
          'at', sr.started_at, 'ok', sr.ok, 'error', sr.error)
        from public.sync_runs sr
        where sr.project_id = pr.id
        order by sr.started_at desc
        limit 1
      )
    )
    from proj pr
  ) end;
$$;

comment on function app.repo_status_detail(text) is
  'SECURITY DEFINER core for the /repos drill-down: jsonb status detail for one repo (members-by-role, memories-by-type, fresh-vs-stale, weekly capture series, staleness, last-sync, slack_linked). slack_linked is member-visible link presence; the channel inventory + count stay admin-only. Returns NULL when the caller is not a member. Reached only through public.repo_status_detail(text).';

-- Grants persist across CREATE OR REPLACE; re-affirm for safety (idempotent).
revoke execute on function app.repo_status_detail(text) from public;
grant  execute on function app.repo_status_detail(text) to authenticated;

-- Verify (as a real member JWT, not the postgres role):
--   select public.repo_status_detail('fabric-testbed/TeamBrain') -> 'slack_linked';
--   -- expect: true for a project with a linked channel, false otherwise.
