# `migrations/` — TeamBrain schema evolution

Numbered SQL files that, applied in order via Studio's SQL editor, produce a working TeamBrain schema. Each file is forward-only and idempotent (safe to re-run); none drop data. See `docs/deployment.md` for the procedural detail (where to paste them, which advisor warnings are expected, how to verify each).

## The set

| # | File | Phase | Concern | Conditional? |
|---|---|---|---|---|
| 0001 | `0001_init.sql`              | 1   | Tables (`projects`, `project_members`, `thoughts`), ENUMs, indexes, `updated_at` trigger, `service_role` grants. **No RLS.** | always |
| 0002 | `0002_rls.sql`               | 1   | RLS on all 3 tables; `app.is_project_*` SECURITY DEFINER helpers; 8 policies (4 on `thoughts`, 2 on `projects`, 1 on `project_members`); `authenticated` table grants; `anon` revokes. | always |
| 0003 | `0003_disable_graphql.sql`   | 1   | `drop extension pg_graphql`. Transport surface lockdown — TeamBrain uses MCP + REST per ADR 0001. | always |
| 0004 | `0004_match_thoughts.sql`    | 2   | SECURITY INVOKER semantic-search RPC (`public.match_thoughts(...)`). RLS-aware (filters during the call rather than bypassing). | always |
| 0005 | `0005_resize_embedding_768.sql` | 2.5 | **Optional.** Resizes `thoughts.embedding` from `vector(1536)` to `vector(768)` for deployments choosing a self-hosted 768-dim provider (e.g. ollama + nomic-embed-text). Drops + recreates the HNSW index and `match_thoughts` for the new dim. | **Only for non-1536 providers** |
| 0006 | `0006_embedding_model.sql`   | 2.5 | Adds `thoughts.embedding_model text` + partial index. Operational complement to ADR 0001 § Decision 5: makes embedding-pipeline provenance observable so future provider/model swaps can scope re-embed passes. | always |
| 0007 | `0007_projects_github_teams.sql`        | 3   | Adds `projects.github_team_slugs text[]` so the Phase 3 sync function can UNION direct collaborators with org-team members. Empty default = "direct collaborators only". | always |
| 0008 | `0008_project_members_soft_delete.sql`  | 3   | Adds `project_members.removed_at timestamptz`; patches the three `app.is_project_*` helpers to filter tombstones; tightens select policy. RLS surface unchanged (helpers absorb the filter). | always |
| 0009 | `0009_sync_runs.sql`                    | 3   | `public.sync_runs` audit log for every membership-sync invocation (jsonb `report`). RLS scoped to project admins; service_role writes. Required for the scheduled sync to be observable. | always |
| 0010 | `0010_pg_cron_membership_sync.sql`      | 3   | `pg_cron` schedule (`*/15 * * * *`) calling `/sync-all` via `pg_net`. Reads service-role bearer + URL from GUCs (`alter database … set app.X = …`) so secrets stay out of `cron.job`. **Superseded by 0013**, which moves the bearer + URL into `public.app_config`. | **Production only** (scratch can use on-demand `POST /sync`) |
| 0011 | `0011_project_registration.sql`         | 4   | Drops the placeholder `authenticated`-insert policy on `projects` so the gated `teambrain-register-project` function is the only create path. | always |
| 0012 | `0012_api_tokens.sql`                   | 5A  | `app.api_tokens` (hashed-at-rest opaque tokens) + `projects.bot_user_id` + `project_members.is_service_account` + `app.is_token_call()`/`token_allowed_scopes()` helpers; amends `thoughts` policies with the capability fence. | always |
| 0013 | `0013_sync_health_monitoring.sql`       | 6   | `public.app_config` (durable sync config, replaces the 0010 GUCs) + reschedules the sync cron to read it; `public.membership_sync_health()` + `public.health_events` + a `*/30` healthcheck cron. Closes the silent-sync-outage incident. | **Production only** |
| 0014 | `0014_thoughts_linked_pr_url_index.sql` | 6   | Partial index on `thoughts(linked_pr_url) where not null` — exact PR-merge dedup + Phase 6 staleness-by-PR. | always |
| 0015 | `0015_membership_sync_health_lockdown.sql` | 6   | Revokes `PUBLIC`/`anon`/`authenticated` EXECUTE on `public.membership_sync_health(int)`, leaving `service_role` only — clears Security Advisor lints 0028/0029. The `GET /health` edge endpoint (service_role client) is unaffected. | **Production only** (operates on the 0013 function) |
| 0016 | `0016_advisor_info_deny_all_policies.sql` | 6   | Explicit deny-all `using(false)` RLS policies on `public.api_tokens` + `public.app_config` so the service_role-only lockdown is a visible schema object — clears Security Advisor lint 0008 (INFO). Behavior-identical (service_role bypasses RLS); the `app_config` half self-skips if 0013 wasn't applied. | always (app_config half no-ops pre-0013) |
| 0017 | `0017_match_thoughts_staleness_decay.sql` | 6   | Drops + recreates `public.match_thoughts(...)` with **freshness-aware ranking** (Phase 6 § B): orders on a `rank_score` = similarity × confidence × expiry × exp-decay(`last_verified_at`, 90-day half-life), adds params (`half_life_days`, `decay_floor`, `include_deprecated`) + return columns (`expires_at`, `confidence`, `rank_score`). Cosine `match_threshold` cutoff unchanged. | always (768-dim deploys swap `vector(768)` in, per the file header) |
| 0018 | `0018_staleness_signals.sql`            | 6   | **Commit-triggered staleness flagging** (Phase 6 § C): `thoughts.stale_flagged_at` column, `public.staleness_signals` (pluggable signal log) + `public.staleness_poll_state` (commit cursor) tables, `flag_thoughts_for_paths()` + `flag_expired_thoughts()` producers, a clear-on-reverify trigger, and recreates `match_thoughts` to return `stale_flagged_at`. | always (768-dim deploys swap `vector(768)` in the match_thoughts half, per the file header) |
| 0019 | `0019_pg_cron_staleness_scan.sql`       | 6   | `pg_cron` for the § C producers: `teambrain-staleness-scan` (`5,20,35,50` → POST `/teambrain-staleness/scan` via pg_net) + `teambrain-staleness-expiry` (`10,40` → `flag_expired_thoughts()`). Adds the `teambrain_staleness_url` app_config row. | **Production only** (scratch drives `/scan` on demand) |
| 0020 | `0020_thoughts_promoted_pr_url.sql`      | 6   | Adds `thoughts.promoted_pr_url` — back-link to the docs/ADR PR a thought was promoted into (Phase 6 § D); enables promote idempotency + surfacing. | always |
| 0021 | `0021_dashboard_activity.sql`           | 6   | `public.dashboard_activity(...)` SECURITY INVOKER RPC (per-project per-day visible/authored thought counts) backing the `/dashboard` activity heatmap; revokes `anon` by name. | always |
| 0022 | `0022_staleness_functions_lockdown.sql` | 6   | Revokes `anon`/`authenticated` EXECUTE on the two SECURITY DEFINER staleness producers (`flag_thoughts_for_paths`, `flag_expired_thoughts`), leaving `service_role` only — closes the same per-role-grant exposure as 0015/0021 (Security Advisor 0028/0029). | **Production only** (operates on the 0018 functions) |
| 0023 | `0023_slack_channels.sql`               | 5B  | `public.slack_channels` — (workspace, channel) → project mapping backing the Slack `/tb` slash command; service_role-only + explicit deny-all policy. | always |
| 0024 | `0024_repo_status_rpcs.sql`             | console | `public.repo_status_overview()` / `repo_status_detail(text)` — per-repo onboarding/feature status for the `/repos` dashboard. SECURITY DEFINER cores in `app` (read the service_role-only `api_tokens`/`slack_channels`/`staleness_poll_state` tables) behind SECURITY INVOKER `public` wrappers. | always |
| 0025 | `0025_repo_status_detail_slack_linked.sql` | console | Adds a member-visible `slack_linked` boolean to `app.repo_status_detail` (un-gated `exists` over `slack_channels`) so the `/repos` step-6 "Slack channel linked" check shows for every project member; the channel inventory + count stay admin-only. `CREATE OR REPLACE` keeps 0024's owner/grants/wrapper. | always |
| —   | `seed.sql`                   | 1   | Hand-seeded pilot project + `project_members` rows. Resolved by GitHub handle from `auth.users.raw_user_meta_data`; gracefully skips users not yet logged in. Re-runnable. Phase 3's sync function takes over once deployed; `seed.sql` remains useful for fresh deploys before the first sync. | always (apply last) |

## Apply order

```
0001  →  0002  →  0003  →  0004  →  [0005 if non-1536 dim]  →  0006  →  seed.sql  →  0007  →  0008  →  0009  →  [0010 in production]  →  0011  →  0012  →  [0013 in production]  →  0014  →  [0015 in production]  →  0016  →  0017  →  0018  →  [0019 in production]  →  0020  →  0021  →  [0022 in production]  →  0023  →  0024
```

`0005` and `0006` can be reordered between themselves (both apply on top of 0004) but the canonical order is `0005` first so anyone tracing the file numbers reads them in the same sequence they apply in.

`seed.sql` is sandwiched between Phase 1 and Phase 3 schema migrations on purpose: 0007/0008 only **add** columns to `projects` / `project_members` with safe defaults, so seeding before or after them is equivalent. Apply seed before 0007/0008 so a fresh pilot deploy reaches "membership exists" sooner; the Phase 3 sync then takes over write authority once its edge function is deployed.

## Conventions enforced across all files

These come from `~/.claude/projects/.../memory/project_supabase_function_conventions.md` and Studio's Security Advisor:

- **Apply via Studio's SQL editor**, not `psql -U postgres`. The self-hosted `postgres` role is not a superuser and cannot own functions in `public`. Studio runs as `supabase_admin`, which is the correct DDL identity.
- **Extensions live in `extensions` schema**, never `public`. References in this directory's SQL use `extensions.vector`, `extensions.<=>`, etc.
- **Functions use `set search_path = ''`** with fully qualified references (e.g., `pg_catalog.now()` instead of bare `now()`). Required by Studio's "Function Search Path Mutable" check.
- **No `DROP TABLE`, `TRUNCATE`, or unqualified `DELETE`.** The CLAUDE.md hard boundary. `DROP POLICY IF EXISTS`, `DROP FUNCTION IF EXISTS`, and `DROP EXTENSION IF EXISTS` are allowed where re-runnability requires them.

## Performance advisor — accepted INFOs

Supabase's **performance** advisor surfaces a few INFO-level items that are deliberately left as-is. (The *security* advisor is kept clean via 0015/0016/0021/0022; these *performance* INFOs are accepted, not actioned.)

- **`unused_index` on `thoughts_embedding_hnsw_idx` and `thoughts_paths_gin_idx` — keep.** Load-bearing at production scale: the HNSW index powers semantic search (`match_thoughts` orders by `embedding <=> query`) and the `paths` GIN index powers staleness flagging (`flag_thoughts_for_paths` does `paths && changed_paths`). They read as "unused" only because the dogfood dataset is small enough that the planner seq-scans; dropping them would regress prod once data grows.
- **`unused_index` on `thoughts_metadata_gin_idx`, `thoughts_tags_gin_idx`, `thoughts_embedding_model_idx`, `staleness_signals_project_created_idx`, `health_events_check_created_idx` — keep.** Cheap, forward-looking indexes for metadata/tag filtering, re-embed-pass scoping (the model tag), the staleness audit drill-in, and the ops exception log. Dropping them frees ~nothing and they'd likely be re-added.
- **`unindexed_foreign_keys` on `api_tokens.{created_by, principal_user_id}`, `projects.{created_by, bot_user_id}`, `slack_channels.linked_by` — accepted.** All are FKs to `auth.users` on small, bounded operational tables; a covering index only helps the parent-delete/join path, which is negligible at any realistic scale here. Adding them would mostly convert these INFOs into future `unused_index` INFOs, so they're left unindexed by choice.

Re-evaluate if a table's row count grows by orders of magnitude, or if `auth.users` deletions become frequent.

## Adding a new migration

1. Pick the next number after the highest existing file (`0007`, `0008`, …).
2. Write a header comment block explaining: what phase the migration belongs to, why this concern is its own file (rather than folded into 0001-0006), and any conditional-apply rules.
3. Wrap the body in `begin; ... commit;` so failures don't leave a half-applied state.
4. Update this README's table.
5. Update `docs/deployment.md` if the new migration changes the apply procedure or adds env vars to the edge function.

## Baseline consolidation (deferred)

Pre-pilot iteration produced six numbered files that each represent the final state of their phase's concern (no fix-up migrations, no orphaned columns). At production cutover (Phase 6 / Phase 7 prep), the plan is to **freeze these as a `v1_baseline.sql` consolidation** and start a new migration lineage from `v1_001_*.sql`. Doing it now would force scratch to drift from a fresh deploy with no clean reconciliation; doing it at cutover lets the production-era migrations have a clean starting point while the per-phase set stays as the historical record.

`v1_baseline.sql` encodes the **OpenAI `vector(1536)`** production path (the 2026-06-09 standing decision in `docs/deployment.md`); the **optional `0005_resize_embedding_768.sql` is NOT folded in** — it is retained as a standalone optional overlay (the ollama / zero-egress future path), re-expressed against the new lineage if needed. See `docs/phase-6-checklist.md` § E.

This is recorded in `docs/phase-6-checklist.md` § E as a Phase 6 deliverable.
