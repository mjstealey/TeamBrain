-- 0021_dashboard_activity.sql — per-day, per-project thought activity RPC
-- backing the logged-in user dashboard at /dashboard.
--
-- Apply via Studio SQL editor after 0001-0020. Adds a single function:
-- `public.dashboard_activity(...)`, called by the dashboard page directly
-- via PostgREST RPC (/rest/v1/rpc/dashboard_activity) with the user's
-- GitHub-OAuth JWT. Per the Phase 4 A1 decision this is deliberately NOT
-- part of the published teambrain-rest/OpenAPI contract — PostgREST stays
-- available underneath for first-party use, undocumented.
--
-- Why SECURITY INVOKER (same reasoning as 0004 match_thoughts):
--   * The body reads `public.thoughts` as the calling role, so the
--     `thoughts_select` policy (0002 form + 0012 token fence) filters rows
--     BEFORE aggregation. The returned counts are therefore exactly the
--     caller's visible surface: personal → author-only, project → member,
--     project_private → writer, tombstoned memberships excluded (0008).
--   * For a human GitHub-OAuth JWT the 0012 fence clause short-circuits to
--     true. If an API-token JWT ever calls this, RLS still clamps it to
--     its `teambrain_allowed_scopes` — fail-safe, no extra guard needed.
--
-- Shape: one flat rowset {project_id, repo_slug, name, day, total_count,
-- authored_count}. The caller's personal-scope bucket appears as
-- project_id IS NULL (and NULL repo_slug/name — the left join cannot
-- produce a NULL slug for a project thought, since thought visibility
-- implies membership implies the projects SELECT policy passes). Both
-- counts ride every row so the dashboard's mine/all toggle is client-side.
--
-- Day bucketing happens in the caller-supplied IANA zone `p_tz` so "today"
-- matches the user's calendar; an invalid zone raises an error and the
-- client retries with 'UTC'. The WHERE clause keeps raw `created_at`
-- comparisons (bounds converted once to timestamptz) so
-- `thoughts_created_at_idx` stays usable.
--
-- The range is hard-capped server-side at 371 days (53 ISO weeks): the
-- `greatest(...)` floor means a hostile or buggy client can never force a
-- wider scan, whatever p_since it sends.

begin;

create or replace function public.dashboard_activity(
  p_since date default null,   -- first bucketed day (in p_tz); floored at p_until - 370
  p_until date default null,   -- last bucketed day; default: "today" in p_tz
  p_tz    text default 'UTC'   -- IANA zone used for day bucketing
)
returns table (
  project_id     uuid,    -- NULL = the caller's personal-scope bucket
  repo_slug      text,    -- NULL for the personal bucket
  name           text,
  day            date,
  total_count    bigint,  -- all thoughts visible to the caller that day
  authored_count bigint   -- the subset with author_user_id = caller
)
language sql
security invoker
stable
set search_path = ''
as $$
  with bounds as (
    select
      d_until,
      greatest(coalesce(p_since, d_until - 370), d_until - 370) as d_since
    from (
      select coalesce(p_until, (now() at time zone p_tz)::date) as d_until
    ) u
  )
  select
    t.project_id,
    p.repo_slug,
    p.name,
    (t.created_at at time zone p_tz)::date as day,
    count(*)                                                       as total_count,
    count(*) filter (where t.author_user_id = (select auth.uid())) as authored_count
  from public.thoughts t
  left join public.projects p on p.id = t.project_id
  cross join bounds b
  where t.created_at >= (b.d_since::timestamp at time zone p_tz)
    and t.created_at <  ((b.d_until + 1)::timestamp at time zone p_tz)
  group by t.project_id, p.repo_slug, p.name, (t.created_at at time zone p_tz)::date
  order by day, repo_slug nulls first;
$$;

comment on function public.dashboard_activity(date, date, text) is
  'Dashboard heatmap aggregation: per-project (NULL = personal) per-day visible/authored thought counts for the caller. SECURITY INVOKER — RLS does all access control. Range hard-capped at 371 days.';

-- Anon gets nothing — the dashboard is authenticated-only. Functions are
-- executable by PUBLIC by default, so revoke that explicitly.
revoke execute on function public.dashboard_activity(date, date, text) from public, anon;
grant  execute on function public.dashboard_activity(date, date, text) to authenticated;

commit;
