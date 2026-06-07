-- 0019_pg_cron_staleness_scan.sql — Phase 6 § C: schedule the staleness
-- producers. Production-only — splits the cron from the always-apply schema in
-- 0018, mirroring how 0010 (cron) splits from 0009 (sync_runs). A developer's
-- local stack drives /scan on demand (POST) and runs flag_expired_thoughts()
-- by hand; it needs none of this.
--
-- Apply via Studio SQL editor on the **production** instance, after 0018.
--
-- Two producers, both writing through the pluggable core in 0018:
--   1. teambrain-staleness-scan  (*/15, offset) — HTTP POST to the
--      teambrain-staleness /scan endpoint, which diffs each registered repo's
--      new commits and calls flag_thoughts_for_paths('commit_touched_path').
--   2. teambrain-staleness-expiry (*/30) — calls flag_expired_thoughts()
--      directly in SQL (no HTTP); flags thoughts whose expires_at has passed.
--
-- Config reuse: the bearer is the same app_config 'teambrain_service_role_key'
-- row membership-sync already uses (0013); only a new 'teambrain_staleness_url'
-- row is added here. Same coalesce(app_config, GUC-fallback) shape as 0013, so
-- this can't open a gap. The cron worker runs as postgres (owns the objects),
-- so it bypasses RLS and may execute the service_role-only functions.

begin;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- 1. Seed the non-secret scan URL (the service-role key row is already seeded
--    for membership-sync; do NOT re-seed secrets here).
insert into public.app_config (key, value)
values (
  'teambrain_staleness_url',
  'http://kong:8000/functions/v1/teambrain-staleness/scan'
)
on conflict (key) do update
  set value = excluded.value, updated_at = pg_catalog.now();

-- 2. Commit-scan cron. Offset to 5,20,35,50 so it never fires in the same
--    minute as the */15 membership-sync (0,15,30,45) or the */30 healthcheck.
do $$ begin
  perform cron.unschedule('teambrain-staleness-scan');
exception when others then null; end $$;

select cron.schedule(
  'teambrain-staleness-scan',
  '5,20,35,50 * * * *',
  $cron$
    select net.http_post(
      url     := coalesce(
                   (select value from public.app_config where key = 'teambrain_staleness_url'),
                   current_setting('app.teambrain_staleness_url', true)
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

-- 3. Expiry-flag cron. Pure SQL — no HTTP. Offset to 10,40.
do $$ begin
  perform cron.unschedule('teambrain-staleness-expiry');
exception when others then null; end $$;

select cron.schedule(
  'teambrain-staleness-expiry',
  '10,40 * * * *',
  $cron$
    select public.flag_expired_thoughts();
  $cron$
);

commit;

-- Verification (read-only):
--
--   select jobname, schedule, active from cron.job
--   where jobname like 'teambrain-staleness-%';
--   select value from public.app_config where key = 'teambrain_staleness_url';
--
-- Manual trigger (operator, bypasses the wait): POST the /scan endpoint with the
-- service-role bearer, or `select public.flag_expired_thoughts();` in Studio.
