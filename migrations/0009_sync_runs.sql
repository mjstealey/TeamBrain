-- 0009_sync_runs.sql — Phase 3 observability: audit log for the
-- membership-sync edge function.
--
-- Apply via Studio SQL editor on the scratch instance, after 0008.
--
-- Background:
--   Phase 3 introduces the first scheduled background work in
--   TeamBrain (pg_cron → /sync-all every 15 min). Without an audit
--   log, "did the sync run?" / "did it succeed?" / "what did it
--   actually do?" are unanswerable. This file adds a small log table
--   that the edge function writes one row to per invocation.
--
-- What this migration does:
--   * Creates `public.sync_runs` with a jsonb report column. Sync
--     produces structured output (added/updated/removed/skipped per
--     project), which is awkward as a wide column set and clean as
--     jsonb. Indexed for the two queries we expect to run: "recent
--     runs" and "runs for project X".
--   * Enables RLS. service_role writes; project admins can read runs
--     scoped to their projects; everyone else is denied.
--   * Grants service_role full DML; grants authenticated SELECT
--     (RLS does the per-row filtering).
--
-- What this migration does NOT do:
--   * No retention policy. Hand-prune via service_role for now;
--     revisit if the table grows past a few thousand rows.
--   * No surfacing via PostgREST RPC — admins query the table
--     directly through PostgREST's auto-generated `/rest/v1/sync_runs`
--     endpoint.

begin;

-- 1. Table --------------------------------------------------------------------

create table if not exists public.sync_runs (
  id           uuid        primary key default gen_random_uuid(),
  project_id   uuid        references public.projects(id) on delete set null,
  started_at   timestamptz not null default pg_catalog.now(),
  finished_at  timestamptz,
  ok           boolean,
  report       jsonb,
  error        text
);

comment on table public.sync_runs is
  'One row per membership-sync edge function invocation. Written by service_role; readable by project admins via RLS.';

-- 2. Indexes ------------------------------------------------------------------
--
-- Recent-runs listing is the dominant query (admin dashboard / curl
-- from a debugging session): `order by started_at desc limit N`.
create index if not exists sync_runs_started_at_idx
  on public.sync_runs (started_at desc);

-- Per-project drill-in: `where project_id = $1 order by started_at desc`.
-- Composite over (project_id, started_at desc) so the planner can
-- range-scan one project's runs in time order.
create index if not exists sync_runs_project_started_idx
  on public.sync_runs (project_id, started_at desc);

-- 3. RLS ----------------------------------------------------------------------

alter table public.sync_runs enable row level security;

revoke all on public.sync_runs from anon;

-- service_role bypasses RLS, but still needs the table-level grant on
-- self-hosted Supabase (same pattern as 0001).
grant select, insert, update, delete on public.sync_runs to service_role;

-- authenticated reads via PostgREST. RLS filters by project admin
-- membership; the table grant just opens the door so RLS can run.
grant select on public.sync_runs to authenticated;

-- An admin sees runs for projects where they are admin. `project_id IS
-- NULL` covers the `/sync-all` aggregate row case (a single run that
-- spans all projects has no single project_id) — hide those from
-- non-superusers; they are visible only to service_role.
drop policy if exists sync_runs_select_admin on public.sync_runs;
create policy sync_runs_select_admin
  on public.sync_runs
  for select
  to authenticated
  using (
    project_id is not null
    and app.is_project_admin(project_id)
  );
comment on policy sync_runs_select_admin on public.sync_runs is
  'Select: project admins see runs scoped to their projects. Aggregate (project_id NULL) runs are service_role-only.';

-- No insert/update/delete policies — writes are service_role-only.

commit;

-- Verification (read-only):
--
--   select count(*) from public.sync_runs;            -- expect 0 on fresh apply
--   select tablename, rowsecurity from pg_tables where tablename = 'sync_runs';
--   select polname, polcmd from pg_policies where tablename = 'sync_runs';
