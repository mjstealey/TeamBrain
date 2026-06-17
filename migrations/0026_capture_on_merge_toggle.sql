-- 0026_capture_on_merge_toggle.sql — server-side enable/disable switch for the
-- capture-on-merge GitHub Action, keyed by repo slug.
--
-- WHY: the capture-on-merge workflow fires on every PR merge in every registered
-- repo, and its human-approval job idles a runner while it waits for a reviewer
-- — the dominant GitHub Actions-minute consumer. This adds a CENTRAL kill switch
-- so a project admin can disable capture for a noisy repo from the /repos
-- dashboard WITHOUT editing or removing the committed workflow file. The
-- workflow reads this flag early (right after its token exchange, via
-- GET /teambrain-rest/project) and clean-skips when it is false — no LLM call,
-- no approval issue, so the costly capture job never starts.
--
-- (The repo VARIABLE TEAMBRAIN_CAPTURE=off in the workflow's job `if:` is the
-- complementary ZERO-minute hard off; this column is the central, slug-keyed one
-- that needs no repo-side change.)
--
-- Apply via the Studio SQL editor (runs as supabase_admin), after 0001-0025.
--
-- Conventions (0024/0025): set search_path = ''; fully-qualify catalog functions
-- (pg_catalog.*); RLS visibility re-implemented via app.is_project_member. No
-- DROP TABLE / TRUNCATE / unqualified DELETE. Single transaction.

begin;

-- ---------------------------------------------------------------------------
-- 1. The flag. Default true ⇒ capture stays ON for existing + future projects
--    (no behavior change until an admin flips it off).
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists capture_on_merge_enabled boolean not null default true;

comment on column public.projects.capture_on_merge_enabled is
  'Server-side enable/disable for the capture-on-merge GitHub Action. The workflow reads this (GET /teambrain-rest/project) after its token exchange and clean-skips when false, so the costly human-approval job never runs. Toggled by a project admin from the /repos dashboard (POST /teambrain-console/capture-toggle). Default true. Members may SELECT projects (0002), so the workflow''s project bot can read it; there is no UPDATE grant to authenticated, so the service-role console function is the only write path.';

-- ---------------------------------------------------------------------------
-- 2. Surface it member-visibly in the /repos drill-down detail document, exactly
--    like 0025 added slack_linked. CREATE OR REPLACE preserves the function's
--    owner, grants, and the public invoker wrapper from 0024 — only the body
--    changes (the proj CTE now also selects capture_on_merge_enabled, and a new
--    top-level key surfaces it). The public.repo_status_detail(text) wrapper is
--    unchanged (it just selects this).
-- ---------------------------------------------------------------------------

create or replace function app.repo_status_detail(p_slug text)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with proj as (
    select p.id, p.repo_slug, p.name, p.capture_on_merge_enabled
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
      -- Member-visible server-side capture switch (this migration). Whether
      -- merged-PR capture is currently enabled for the repo — distinct from
      -- whether the workflow FILE is installed (a GitHub fact the console
      -- reports separately). Any member may see it; only admins can toggle it.
      'capture_on_merge_enabled', pr.capture_on_merge_enabled,
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
  'SECURITY DEFINER core for the /repos drill-down: jsonb status detail for one repo (members-by-role, memories-by-type, fresh-vs-stale, weekly capture series, staleness, last-sync, slack_linked, capture_on_merge_enabled). slack_linked + capture_on_merge_enabled are member-visible; the channel inventory/count and the toggle action stay admin-only. Returns NULL when the caller is not a member. Reached only through public.repo_status_detail(text).';

-- Grants persist across CREATE OR REPLACE; re-affirm for safety (idempotent).
revoke execute on function app.repo_status_detail(text) from public;
grant  execute on function app.repo_status_detail(text) to authenticated;

commit;

-- Verification (run from the Studio SQL editor):
--
--   -- A. Column landed, default true on every existing project.
--   select repo_slug, capture_on_merge_enabled from public.projects order by repo_slug;
--
--   -- B. Detail surfaces the flag (as a real member JWT, not the postgres role):
--   --   select public.repo_status_detail('fabric-testbed/TeamBrain') -> 'capture_on_merge_enabled';
--   --   -- expect: true (or false once toggled off).
--
--   -- C. Flip it off for a repo, confirm the workflow's read path sees it:
--   --   update public.projects set capture_on_merge_enabled = false
--   --     where repo_slug = 'fabric-testbed/TeamBrain';
--   --   -- then GET /functions/v1/teambrain-rest/project?project_slug=fabric-testbed/TeamBrain
--   --   --   (with a member JWT) returns {"capture_on_merge_enabled": false}.
