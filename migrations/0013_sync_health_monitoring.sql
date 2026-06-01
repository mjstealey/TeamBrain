-- 0013_sync_health_monitoring.sql — Phase 6 (deferred-paydown): make the
-- membership-sync's health observable, and make its config survive the
-- failure mode that took it down silently for ~2 days.
--
-- Apply via Studio SQL editor on the **production** instance, after 0010-0012.
-- Optional on a developer's local stack (the on-demand POST /sync path needs
-- none of this).
--
-- Background — the incident this migration closes:
--   Between 2026-05-27 and 2026-05-29 the `*/15` membership-sync cron failed
--   192 consecutive times and nobody noticed. Root cause: the two operator-set
--   GUCs the cron read (`app.teambrain_sync_url`, `app.teambrain_service_role_key`)
--   vanished from `pg_db_role_setting` on a per-database settings reset, so
--   every fire raised `unrecognized configuration parameter` and exited before
--   issuing the HTTP POST. A new user (kthare10) signed up during the gap and
--   silently never landed in `project_members`. The failure was loud in
--   `cron.job_run_details` but invisible to the application — nothing watched it.
--
-- Two complementary fixes, in one migration:
--
--   A. PREVENT recurrence. Move the sync config out of per-database GUCs into a
--      `public.app_config` table. The incident reset `pg_db_role_setting` but
--      left ordinary table data intact (thoughts survived, 0 member removals
--      across the gap) — so a table is strictly more durable than a GUC against
--      this exact failure. The cron is rescheduled to read the table. The
--      non-secret URL is seeded here; the service-role key row is seeded once by
--      the operator via Studio (never committed — see runbook §12).
--
--   B. DETECT future failures. A `public.membership_sync_health()` function reads
--      `public.sync_runs` (written only on actual function execution — the robust
--      signal; `cron.job_run_details` would show success for the async pg_net
--      *enqueue* even when the POST never happened) and classifies ok/stale/
--      failing. A second `*/30` cron logs a `public.health_events` row only when
--      the status is not ok, so the table is an exception log. The
--      teambrain-membership-sync function also exposes GET /health over the same
--      function for an external uptime ping.
--
-- What this migration does NOT do:
--   * Seed the secret service-role key (operator-side, Studio, runbook §12).
--   * Remove the old GUCs — harmless once unused; left in place.
--   * Add retention to health_events (it only grows on incidents; hand-prune).

begin;

-- ============================================================================
-- A. Durable sync config (replaces the two GUCs)
-- ============================================================================

create table if not exists public.app_config (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default pg_catalog.now()
);

comment on table public.app_config is
  'Operator-set service configuration that must survive a pg_db_role_setting '
  'reset (which silently broke membership-sync, 2026-05-27..29). service_role-only.';

alter table public.app_config enable row level security;

-- Off the PostgREST-exposed surface for non-privileged roles: no policies +
-- no grants to anon/authenticated means only service_role (and superuser/
-- the cron worker) can read it — same secrecy posture as the GUC it replaces.
revoke all on public.app_config from anon;
revoke all on public.app_config from authenticated;
grant select, insert, update, delete on public.app_config to service_role;

-- Seed the NON-SECRET URL row. Idempotent. The service-role key row is seeded
-- once by the operator via Studio (runbook §12) and is intentionally absent
-- here — secrets never live in a committed file.
insert into public.app_config (key, value)
values (
  'teambrain_sync_url',
  'http://kong:8000/functions/v1/teambrain-membership-sync/sync-all'
)
on conflict (key) do update
  set value = excluded.value, updated_at = pg_catalog.now();

-- ============================================================================
-- A'. Reschedule the membership-sync cron to read app_config (not GUCs)
-- ============================================================================
--
-- Same `*/15` schedule and the same pg_net POST as 0010 — only the source of
-- the URL + bearer changes. app_config is now PRIMARY, with a coalesce()
-- FALLBACK to the legacy GUC so applying this migration can't open a sync gap:
-- in production the GUCs are currently set, so the cron keeps working
-- immediately, and the operator can seed the app_config rows at leisure (once
-- seeded, app_config wins). `current_setting(…, true)` passes missing_ok so an
-- unset GUC yields NULL instead of raising. The cron worker runs as a
-- superuser, so it bypasses app_config's RLS. If BOTH sources are missing the
-- POST fails loudly in cron.job_run_details — which the §B healthcheck turns
-- into a visible health_events row + a 503 from GET /health.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

do $$ begin
  perform cron.unschedule('teambrain-membership-sync');
exception when others then null; end $$;

select cron.schedule(
  'teambrain-membership-sync',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url     := coalesce(
                   (select value from public.app_config where key = 'teambrain_sync_url'),
                   current_setting('app.teambrain_sync_url', true)
                 ),
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || coalesce(
                     (select value from public.app_config where key = 'teambrain_service_role_key'),
                     current_setting('app.teambrain_service_role_key', true)
                   )
                 ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- ============================================================================
-- B. Health classification function
-- ============================================================================
--
-- Reads the /sync-all aggregate rows (project_id IS NULL) from sync_runs.
-- SECURITY DEFINER so a future authenticated dashboard can call it without a
-- read grant on sync_runs (the function exposes only status + timestamps +
-- a failure count, never membership data). search_path = '' per the repo
-- convention; every reference fully qualified.

create or replace function public.membership_sync_health(
  staleness_minutes int default 30
)
returns table (
  status          text,
  last_ok_at      timestamptz,
  last_run_at     timestamptz,
  recent_failures int
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    case
      when (select pg_catalog.max(started_at) from public.sync_runs
              where project_id is null and ok) is null
        then 'failing'                                   -- no successful run ever observed
      when (select pg_catalog.max(started_at) from public.sync_runs
              where project_id is null and ok)
           < pg_catalog.now() - pg_catalog.make_interval(mins => staleness_minutes)
        then 'stale'                                     -- last success too old
      when (select pg_catalog.count(*) from public.sync_runs
              where project_id is null
                and started_at > pg_catalog.now() - pg_catalog.make_interval(hours => 1)
                and ok is not true) > 0
        then 'failing'                                   -- a recent run failed
      else 'ok'
    end                                                                       as status,
    (select pg_catalog.max(started_at) from public.sync_runs
       where project_id is null and ok)                                       as last_ok_at,
    (select pg_catalog.max(started_at) from public.sync_runs
       where project_id is null)                                             as last_run_at,
    (select pg_catalog.count(*)::int from public.sync_runs
       where project_id is null
         and started_at > pg_catalog.now() - pg_catalog.make_interval(hours => 1)
         and ok is not true)                                                 as recent_failures;
$$;

comment on function public.membership_sync_health(int) is
  'Classifies membership-sync health (ok/stale/failing) from sync_runs aggregate '
  'rows. Backs the */30 healthcheck cron and the GET /health endpoint.';

-- service_role (the edge function's GET /health) + authenticated (future
-- dashboard) may call it; anon may not.
grant execute on function public.membership_sync_health(int) to authenticated;
grant execute on function public.membership_sync_health(int) to service_role;

-- ============================================================================
-- B'. Exception log + healthcheck cron
-- ============================================================================

create table if not exists public.health_events (
  id         uuid        primary key default gen_random_uuid(),
  check_name text        not null,
  status     text        not null,
  detail     jsonb,
  created_at timestamptz not null default pg_catalog.now()
);

comment on table public.health_events is
  'Append-only exception log: one row each time a healthcheck observes a '
  'not-ok status. Empty in steady state.';

create index if not exists health_events_check_created_idx
  on public.health_events (check_name, created_at desc);

alter table public.health_events enable row level security;

revoke all on public.health_events from anon;
grant select on public.health_events to authenticated;          -- non-sensitive operational signal
grant select, insert, update, delete on public.health_events to service_role;

-- Readable by any authenticated caller (status + timestamps only; no secrets,
-- no membership data). Writes are service_role / superuser-cron only.
drop policy if exists health_events_select_authenticated on public.health_events;
create policy health_events_select_authenticated
  on public.health_events
  for select
  to authenticated
  using (true);
comment on policy health_events_select_authenticated on public.health_events is
  'Select: any authenticated caller. Health status is non-sensitive; writes stay service_role-only.';

-- The watcher: every 30 min, record a row ONLY when the sync is not ok.
do $$ begin
  perform cron.unschedule('teambrain-sync-healthcheck');
exception when others then null; end $$;

select cron.schedule(
  'teambrain-sync-healthcheck',
  '*/30 * * * *',
  $cron$
    insert into public.health_events (check_name, status, detail)
    select
      'membership_sync',
      h.status,
      jsonb_build_object(
        'last_ok_at',      h.last_ok_at,
        'last_run_at',     h.last_run_at,
        'recent_failures', h.recent_failures
      )
    from public.membership_sync_health() h
    where h.status <> 'ok';
  $cron$
);

commit;

-- Operator setup (run ONCE per database, separately from this migration):
--
--   -- Seed the SECRET service-role key row (the URL row is seeded above):
--   insert into public.app_config (key, value)
--   values ('teambrain_service_role_key', '<paste SERVICE_ROLE_KEY from .env>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- Verification:
--
--   select key, length(value) as value_len, updated_at from public.app_config;
--   select * from public.membership_sync_health();          -- expect status='ok'
--   select jobname, schedule from cron.job
--     where jobname in ('teambrain-membership-sync', 'teambrain-sync-healthcheck');
--
--   -- After the next */15 boundary, confirm a fresh aggregate sync_runs row:
--   select started_at, ok from public.sync_runs
--     where project_id is null order by started_at desc limit 3;
--
--   -- health_events stays empty while healthy:
--   select count(*) from public.health_events;              -- expect 0 in steady state
