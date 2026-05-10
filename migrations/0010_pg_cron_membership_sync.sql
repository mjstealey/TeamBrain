-- 0010_pg_cron_membership_sync.sql — Phase 3 production deploy:
-- schedule the membership-sync edge function via pg_cron.
--
-- Apply via Studio SQL editor on the **production** scratch instance,
-- after 0007–0009 and after the membership-sync edge function is
-- deployed and reachable. Optional on a developer's local stack: the
-- on-demand `POST /sync` endpoint is enough for ad-hoc testing.
--
-- Background:
--   We need a recurring background task that hits `/sync-all` on the
--   membership-sync edge function every 15 minutes (per Phase 3 § A6).
--   The choices considered:
--
--     * Host-side cron / systemd timer — works, but lives outside the
--       supabase docker stack and breaks the "stack is one
--       docker-compose up" deploy story.
--     * GitHub Action on a schedule — works, but ties production to
--       GitHub-side scheduling and adds an external secret store.
--     * pg_cron (Supabase ships it, runs inside Postgres, survives
--       container restarts cleanly) + pg_net (HTTP from inside
--       Postgres) — chosen.
--
-- Why secrets via GUC, not the cron.job table:
--   `cron.job` is queryable by anyone with read access to the cron
--   schema. Putting the service-role bearer token directly in the
--   schedule body would expose it. Instead we read it from
--   `current_setting('app.teambrain_service_role_key')`, populated
--   once per deploy via `alter database ... set app.X = '...'`. The
--   GUC is per-database, persists across restarts, and is invisible
--   to non-superuser SELECT queries (it is in `pg_db_role_setting`,
--   not `cron.job`).
--
-- What this migration does:
--   1. Ensures `pg_cron` and `pg_net` extensions exist in the
--      `extensions` schema.
--   2. Unschedules any prior `teambrain-membership-sync` job
--      (idempotent re-apply).
--   3. Schedules the new job: `*/15 * * * *` — every 15 minutes on
--      the wall clock (00, 15, 30, 45 past the hour).
--
-- What this migration does NOT do:
--   * Set the GUC values — those are operator-side, deploy-once,
--     captured in `docs/deployment.md` Phase 3 section. Re-applying
--     this file does not require re-setting them.
--   * Create the `sync_runs` table or the edge function. The cron
--     schedule simply triggers an HTTP POST; the edge function on
--     the receiving end writes the audit row and reconciles
--     membership.

begin;

-- 1. Required extensions ------------------------------------------------------

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- pg_cron's bookkeeping tables live in `cron`. Grant nothing to
-- authenticated/anon — only superuser/service_role manage schedules.

-- 2. Unschedule any prior version of this job --------------------------------
--
-- `cron.unschedule(jobname)` raises if the job doesn't exist. Wrap in
-- a DO block to make this idempotent on first apply.

do $$ begin
  perform cron.unschedule('teambrain-membership-sync');
exception when others then null; end $$;

-- 3. Schedule ----------------------------------------------------------------
--
-- Reads two GUCs that the operator sets at deploy time:
--   * app.teambrain_sync_url            — fully-qualified URL of the
--                                          /sync-all endpoint, e.g.
--                                          'http://kong:8000/functions/v1/teambrain-membership-sync/sync-all'
--   * app.teambrain_service_role_key    — service-role JWT used as
--                                          Bearer auth. Same value as
--                                          SERVICE_ROLE_KEY in .env.
--
-- If either GUC is unset, `current_setting()` raises and the cron job
-- logs an error to `cron.job_run_details` — which is the right
-- failure mode (loud, observable, doesn't silently no-op).

select cron.schedule(
  'teambrain-membership-sync',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url     := current_setting('app.teambrain_sync_url'),
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || current_setting('app.teambrain_service_role_key')
                 ),
      body    := '{}'::jsonb
    );
  $cron$
);

commit;

-- Operator setup (run ONCE per database, separately from this migration):
--
--   alter database postgres set app.teambrain_sync_url =
--     'http://kong:8000/functions/v1/teambrain-membership-sync/sync-all';
--
--   alter database postgres set app.teambrain_service_role_key =
--     '<paste SERVICE_ROLE_KEY from .env>';
--
--   -- restart pg_cron worker so it picks up the new GUCs (or wait
--   -- for the next reconnect; pg_cron re-reads on each schedule fire).
--
-- Verification:
--
--   select jobid, schedule, command, jobname
--   from cron.job
--   where jobname = 'teambrain-membership-sync';
--
--   -- After the next quarter-hour boundary:
--   select start_time, end_time, status, return_message
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'teambrain-membership-sync')
--   order by start_time desc
--   limit 5;
--
--   -- And — load-bearing — the sync_runs row produced by the function:
--   select started_at, finished_at, ok, error
--   from public.sync_runs
--   order by started_at desc
--   limit 5;
