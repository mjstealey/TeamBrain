-- 0024_repo_status_rpcs.sql — per-repo onboarding/feature status for the
-- /repos management dashboard.
--
-- Apply via Studio SQL editor (runs as supabase_admin), after 0001-0023.
--
-- WHAT this adds:
--   * public.repo_status_overview()        -> one row per project the caller
--     is a member of, with the per-feature status the /repos overview renders
--     (member count, last sync, memory/stale counts, last capture, staleness
--     poll recency, and — admin-only — token / Slack-link counts).
--   * public.repo_status_detail(text)      -> a jsonb document for one repo's
--     drill-down (members-by-role, memories-by-type, fresh-vs-stale, a weekly
--     capture series for the sparkline, staleness + last-sync detail).
--
-- WHY the app-core + public-wrapper split (the key design decision):
--   The status surface must read tables that are SERVICE-ROLE-ONLY by design:
--   api_tokens (0012), slack_channels (0023), staleness_poll_state (0018),
--   plus sync_runs (admin-only RLS, 0009) and the full project_members roster
--   (self+admin-only RLS, 0008). `authenticated` cannot see these through RLS,
--   so the aggregation MUST run SECURITY DEFINER.
--
--   But this repo deliberately keeps SECURITY DEFINER functions OUT of the
--   PostgREST-exposed `public` schema (0002 header; 0012 §1): a definer fn in
--   an exposed schema becomes a `/rest/v1/rpc/<fn>` surface the linter flags.
--   So we keep the definer logic in `app` (PGRST_DB_SCHEMAS = public, so `app`
--   is never RPC-reachable) and expose a thin SECURITY INVOKER wrapper in
--   `public`. authenticated reaches the wrapper over REST; the wrapper calls
--   the app core (it already has USAGE on `app` + the explicit grant below);
--   the core elevates to read the locked tables. This mirrors exactly how RLS
--   policies call app.is_project_member (0002/0008): invoker surface, definer
--   core, off the REST schema.
--
--   Because the core is SECURITY DEFINER it BYPASSES RLS, so it must
--   RE-IMPLEMENT visibility itself, reusing the same helpers RLS uses:
--     * every row gated on app.is_project_member()  (caller must be a member);
--     * project_private memory counts only when app.is_project_writer();
--     * token_count / slack_link_count only when app.is_project_admin().
--   auth.uid() inside a definer fn still returns the CALLER's uid (it reads
--   request.jwt.claims, not the owner), so the gating is the caller's, not the
--   owner's — definer bypasses RLS, it does not impersonate.
--
-- Conventions (0001/0002/0012/0018 + project memory): set search_path = '';
-- fully-qualify catalog functions (pg_catalog.*); COALESCE/CASE/ANY are SQL
-- constructs and need no qualification. No DROP TABLE / TRUNCATE / unqualified
-- DELETE. Single transaction.

begin;

-- ---------------------------------------------------------------------------
-- 1. Overview core (app schema, SECURITY DEFINER)
-- ---------------------------------------------------------------------------

create or replace function app.repo_status_overview()
returns table (
  project_id               uuid,
  repo_slug                text,
  name                     text,
  caller_role              text,
  member_count             bigint,
  last_sync_at             timestamptz,
  last_sync_ok             boolean,
  memory_count             bigint,
  stale_count              bigint,
  last_capture_at          timestamptz,
  staleness_last_polled_at timestamptz,
  token_count              bigint,   -- NULL unless caller is a project admin
  slack_link_count         bigint    -- NULL unless caller is a project admin
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    p.id,
    p.repo_slug,
    p.name,
    (select pm.role::text
       from public.project_members pm
      where pm.project_id = p.id
        and pm.user_id    = (select auth.uid())
        and pm.removed_at is null
      limit 1) as caller_role,
    (select pg_catalog.count(*)
       from public.project_members pm
      where pm.project_id = p.id
        and pm.removed_at is null
        and pm.is_service_account = false) as member_count,
    sr.started_at as last_sync_at,
    sr.ok         as last_sync_ok,
    (select pg_catalog.count(*)
       from public.thoughts t
      where t.project_id = p.id
        and (t.scope = 'project'::public.thought_scope
             or (t.scope = 'project_private'::public.thought_scope
                 and app.is_project_writer(p.id)))) as memory_count,
    (select pg_catalog.count(*)
       from public.thoughts t
      where t.project_id = p.id
        and t.stale_flagged_at is not null
        and (t.scope = 'project'::public.thought_scope
             or (t.scope = 'project_private'::public.thought_scope
                 and app.is_project_writer(p.id)))) as stale_count,
    (select pg_catalog.max(t.created_at)
       from public.thoughts t
      where t.project_id = p.id
        and (t.scope = 'project'::public.thought_scope
             or (t.scope = 'project_private'::public.thought_scope
                 and app.is_project_writer(p.id)))) as last_capture_at,
    sps.last_polled_at as staleness_last_polled_at,
    case when app.is_project_admin(p.id) then (
      select pg_catalog.count(*)
        from public.api_tokens a
       where a.project_id = p.id
         and a.revoked_at is null
         and (a.expires_at is null or a.expires_at > pg_catalog.now())
    ) else null end as token_count,
    case when app.is_project_admin(p.id) then (
      select pg_catalog.count(*)
        from public.slack_channels s
       where s.project_id = p.id
    ) else null end as slack_link_count
  from public.projects p
  left join lateral (
    select sr2.started_at, sr2.ok
      from public.sync_runs sr2
     where sr2.project_id = p.id
     order by sr2.started_at desc
     limit 1
  ) sr on true
  left join public.staleness_poll_state sps on sps.project_id = p.id
  where app.is_project_member(p.id)
  order by p.repo_slug;
$$;

comment on function app.repo_status_overview() is
  'SECURITY DEFINER core for the /repos overview: per-feature status for every project the caller is a member of. Re-implements RLS visibility via app.is_project_member/writer/admin. Reached only through the public.repo_status_overview() invoker wrapper.';

-- ---------------------------------------------------------------------------
-- 2. Detail core (app schema, SECURITY DEFINER) — jsonb for one repo
-- ---------------------------------------------------------------------------

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
  'SECURITY DEFINER core for the /repos drill-down: jsonb status detail for one repo (members-by-role, memories-by-type, fresh-vs-stale, weekly capture series, staleness, last-sync). Returns NULL when the caller is not a member. Reached only through public.repo_status_detail(text).';

-- ---------------------------------------------------------------------------
-- 3. Public invoker wrappers (the PostgREST RPC surface)
-- ---------------------------------------------------------------------------

create or replace function public.repo_status_overview()
returns table (
  project_id               uuid,
  repo_slug                text,
  name                     text,
  caller_role              text,
  member_count             bigint,
  last_sync_at             timestamptz,
  last_sync_ok             boolean,
  memory_count             bigint,
  stale_count              bigint,
  last_capture_at          timestamptz,
  staleness_last_polled_at timestamptz,
  token_count              bigint,
  slack_link_count         bigint
)
language sql
security invoker
stable
set search_path = ''
as $$
  select * from app.repo_status_overview();
$$;

comment on function public.repo_status_overview() is
  'PostgREST RPC for the /repos overview. SECURITY INVOKER wrapper over the app definer core (keeps the definer logic off the REST-exposed schema, per the 0002/0012 convention).';

create or replace function public.repo_status_detail(p_slug text)
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  select app.repo_status_detail(p_slug);
$$;

comment on function public.repo_status_detail(text) is
  'PostgREST RPC for the /repos drill-down. SECURITY INVOKER wrapper over the app definer core. Returns NULL when the caller is not a member of p_slug.';

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
-- The app cores are reachable only from the public wrappers (PostgREST does
-- not expose `app`); authenticated needs EXECUTE on them so the invoker
-- wrapper can call through. anon gets nothing — /repos is authenticated-only.

revoke execute on function app.repo_status_overview()      from public;
revoke execute on function app.repo_status_detail(text)    from public;
grant  execute on function app.repo_status_overview()      to authenticated;
grant  execute on function app.repo_status_detail(text)    to authenticated;

revoke execute on function public.repo_status_overview()   from public, anon;
revoke execute on function public.repo_status_detail(text) from public, anon;
grant  execute on function public.repo_status_overview()   to authenticated;
grant  execute on function public.repo_status_detail(text) to authenticated;

commit;

-- Verification (read-only — run from Studio SQL editor):
--
--   -- A. Functions landed.
--   select n.nspname, p.proname, p.prosecdef
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where p.proname in ('repo_status_overview', 'repo_status_detail')
--   order by n.nspname, p.proname;
--   -- expect: app.* prosecdef = t (definer); public.* prosecdef = f (invoker).
--
--   -- B. As a member (impersonate), the overview lists their projects and the
--   --    detail returns jsonb; token/slack counts are NULL unless admin.
--   --   set local role authenticated;
--   --   set local "request.jwt.claims" = '{"sub":"<member-uuid>","role":"authenticated"}';
--   --   select repo_slug, member_count, token_count from public.repo_status_overview();
--   --   select public.repo_status_detail('fabric-testbed/TeamBrain');
--   --   reset role;
