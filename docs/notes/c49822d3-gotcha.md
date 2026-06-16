# gotcha: # Incident: pg_cron membership sync silently failed for ~2 days (2026-05-27 → 20

> Promoted from TeamBrain thought `c49822d3-229f-4f7f-b815-8b509a58554d` on 2026-06-16T10:56:10.792Z.

## Content

# Incident: pg_cron membership sync silently failed for ~2 days (2026-05-27 → 2026-05-29)

## Observable symptom
A new user (`kthare10`, signed up 2026-05-29 18:48 UTC) never appeared in `project_members` for any project. From the user's side it looked like a permission/membership gap — search returned empty, capture failed under RLS. No alert fired.

## Exact cause
The `*/15` pg_cron job `teambrain-membership-sync` (defined in `migrations/0010_pg_cron_membership_sync.sql`) calls:

```
net.http_post(
  url     := current_setting('app.teambrain_sync_url'),
  headers := jsonb_build_object(
    'Authorization', 'Bearer ' || current_setting('app.teambrain_service_role_key'),
    ...))
```

Both `app.teambrain_sync_url` and `app.teambrain_service_role_key` are **operator-set database GUCs**, established once via `ALTER DATABASE postgres SET app.X = '...'` per runbook §12. They are **not captured in any migration, seed file, or pg_dump backup** — only in the running cluster's `pg_db_role_setting` for the `postgres` database.

Between 2026-05-27 21:00 UTC and 2026-05-29 21:00 UTC, both GUCs were absent from `pg_db_role_setting` (only the stack's own `app.settings.jwt_secret` / `app.settings.jwt_exp` remained — those are set by Supabase's docker init, not by an operator). The most plausible explanation is a db re-init / volume rebuild around 2026-05-27 21:00 UTC that reset per-database settings to the stack defaults.

Result: every `*/15` cron fire raised `unrecognized configuration parameter "app.teambrain_sync_url"` at `current_setting()` and exited before issuing `net.http_post`. **192 consecutive failures**, zero successful auto-syncs in the 2-day window. Migration `0010` warns about exactly this at its header line 79 ("If either GUC is unset, `current_setting()` raises and the cron job fails") — but the failure is silent from the application's perspective: no error, just empty results.

## Fix applied 2026-05-29 ~21:05 UTC
Re-ran the two `ALTER DATABASE postgres SET …` statements per runbook §12 (sourced `SERVICE_ROLE_KEY` from `~/supabase-stack/.env` on the box), then triggered a manual `POST /functions/v1/teambrain-membership-sync/sync-all` to catch up. All 4 projects reconciled cleanly (0 removals across the gap); `kthare10` and any other newly-signed-up users were added.

Verified `current_setting('app.teambrain_sync_url')` resolves in a fresh session — root cause definitively closed.

## Monitor we should add (Phase 6+ scope)
This outage was invisible for 2 days because nothing watches the sync's health. We want some form of alerting. Cheapest options, roughly in order of effort:

1. **In-DB healthcheck cron job** — a second pg_cron entry that every 30 min queries `cron.job_run_details` for the membership-sync `jobid` and writes a row to a new `health_events` table (or `notify`s) when the last 2 fires are not `status='succeeded'`. No external dependency; surfaces in Studio.
2. **`sync_runs` staleness check** — assert `max(started_at where project_id is null) > now() - interval '30 minutes'` from a healthcheck endpoint (a new `GET /functions/v1/teambrain-membership-sync/health`) that returns 200/503 accordingly. Pair with an external uptime ping (UptimeRobot / cron+curl) hitting it every few minutes.
3. **Startup self-test on the membership-sync function** — on every cold start, log a structured warning if either GUC is unset. Surfaces in `docker logs` but doesn't actively page.
4. **Migration-level guard** (preventive, not a monitor) — extend `0010` (or a new `0013`) so the GUCs themselves get re-set idempotently from a known location (e.g., a config row in a new `public.app_config` table, applied via a `BEFORE` trigger on cron job startup, or reseeded by an init function called from a migration). Would have prevented this incident entirely by making the GUCs survive db re-inits.

(1) + (4) together is probably the right shape: monitor for ongoing failures, plus make the failure mode impossible to recur silently.

## Open follow-up
Decide between Phase 6 timing (alongside the existing staleness/promotion work) and a hotfix migration. Tagged `monitoring-todo` so it surfaces when Phase 6 scope is finalized.

## Provenance

- scope: `project`
- captured: 2026-05-29T21:52:48.296283+00:00
- last verified: 2026-06-15T12:31:32.71+00:00
- paths: `migrations/0010_pg_cron_membership_sync.sql`, `deploy/production/README.md`, `edge-functions/teambrain-membership-sync/sync.ts`
- tags: `pg_cron`, `membership-sync`, `incident`, `monitoring-todo`, `phase-6`, `operations`
