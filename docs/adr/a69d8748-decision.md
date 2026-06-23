# decision: **Phase 6 § A — deferred-debt paydown — shipped 2026-06-01 (PR #4, merge c2e5330

> Promoted from TeamBrain thought `a69d8748-3311-4614-ad56-0294351e20a6` on 2026-06-16T10:58:15.549Z.

## Content

**Phase 6 § A — deferred-debt paydown — shipped 2026-06-01 (PR #4, merge c2e5330).**

Three items surfaced from this dogfood corpus + `deno check`, hardening the foundation before adding new surfaces. Deployed and validated in production on pr.fabric-testbed.net.

**A1 — Sync health monitoring (detect + prevent), migration 0013.**
- `public.app_config` (service_role-only) replaces the two operator GUCs that vanished in the 2026-05-27→29 silent-sync outage — a table survives the `pg_db_role_setting` reset that took down the GUCs. The */15 cron now reads it, with a `coalesce(app_config, current_setting(GUC, true))` fallback so applying 0013 can't open a sync gap.
- `public.membership_sync_health(staleness_minutes int default 30)` classifies ok/stale/failing from `sync_runs` aggregate rows (project_id IS NULL) — the robust signal, since `cron.job_run_details` shows success for the async pg_net *enqueue* even when the POST never fires. A */30 healthcheck cron logs to `public.health_events` only when not-ok (exception log).
- `GET /functions/v1/teambrain-membership-sync/health` (anon-key pingable; not service-role-gated) → 200/503 for external uptime monitoring.

**A2 — linked_pr_url filter, migration 0014 + rest/mcp + workflow.** Partial index `thoughts(linked_pr_url) where not null`; a `linked_pr_url` param + returned column on `GET /thoughts` / `list_recent_project_thoughts`. capture-on-merge dedup is now exact AND moved before the approval gate (`already_captured` gates the capture job — a re-run never opens a pointless approval issue). Closes the C-D7 follow-up on milestone thought 8153d210 and serves Phase 6 staleness-by-PR.

**A3 — edge-function TS cleanup.** `deno check` is now green on all 6 functions — `scripts/deno-check.sh` revealed 5 were red, not the 2 originally noted: args typed via `z.infer`, `HttpError.status` as Hono `ContentfulStatusCode`, and a root-cause fix to teambrain-rest's `parse<S>` helper (it erased zod `.default()` output types). New `scripts/deno-check.sh` + a `check` task per `deno.json` make "validate before deploy" runnable.

**Validated in prod, including a live fire-drill of the 2026-05 outage:** a mis-paste of the service_role key into app_config caused a real auth gap (14:15–14:45 cron fires rejected) that the new healthcheck detected, logged a `health_events` stale row, and recovered from at 15:00 once corrected — the best validation A1 could get. MCP + REST both confirmed the linked_pr_url filter (count 3, all PR #1 captures).

Provenance + the still-open Phase 6 deliverables (B staleness decay in ranking, C commit-triggered staleness webhook, D promote_to_docs → real PR, E v1_baseline consolidation) are in `docs/development/phase-6-checklist.md`. Closes the monitoring-todo on incident thought c49822d3. Phase 5 § B (Slack) / § D (slash commands) remain the next new surfaces.

## Provenance

- scope: `project`
- captured: 2026-06-01T15:26:15.23477+00:00
- linked commit: `c2e53309a9e7ee3a04c05ca4c9882b961b7e720d`
- linked PR: https://github.com/fabric-testbed/TeamBrain/pull/4
- paths: `migrations/0013_sync_health_monitoring.sql`, `migrations/0014_thoughts_linked_pr_url_index.sql`, `edge-functions/teambrain-membership-sync/index.ts`, `edge-functions/teambrain-rest/index.ts`, `edge-functions/teambrain-mcp/index.ts`, `docs/development/phase-6-checklist.md`, `scripts/deno-check.sh`, `.github/workflows/capture-on-merge.yml`
- tags: `phase-6`, `milestone`, `shipped`, `sync-health-monitoring`, `app-config`, `linked-pr-url`, `deno-check`, `deferred-paydown`
