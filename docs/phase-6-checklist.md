# Phase 6 Checklist

Concrete, ordered tasks for Phase 6 — **staleness & promotion**: make memory
*decay* (so stale thoughts sink in search), *flag itself* when the code it
describes changes, and *graduate* into reviewed repo docs via PR. Phase 6 also
absorbed a **deferred-debt paydown** track (§ A) — operational and type-safety
debt surfaced from the live TeamBrain dogfood corpus + `deno check` — done first
to harden the foundation the staleness/promotion work builds on. Each item has
an explicit **Done when** acceptance criterion.

> **Status legend:** ☐ not started · 🟡 in progress / code-complete, deploy pending · ✅ done.

Phase 6 entry preconditions (from `docs/phase-5-checklist.md` § "Phase 6 readiness gate"):

- ✅ Phase 5 § A (long-lived API token) shipped + smoke-green on `pr.fabric-testbed.net`.
- ✅ Phase 5 § C (PR-merge capture, LLM-proposed/human-approved) shipped end-to-end on the `fabric-testbed/TeamBrain` dogfood repo — **the readiness gate** (≥1 working capture path).
- 🟡 § B (Slack) / § D (slash commands) remain open in Phase 5; they do **not** gate Phase 6 and proceed in parallel.

Provenance note: the § A items were surfaced from the live TeamBrain MCP (dogfood `fabric-testbed/TeamBrain`) — chiefly the silent-sync-outage incident (`monitoring-todo`, thought `c49822d3`) and the milestone follow-ups on `8153d210`. This checklist is the durable home for that plan (adapted from the plan-mode artifact, 2026-06-01).

---

## A — Deferred-debt paydown (foundation hardening) — 🟡 *code-complete on `chore/paydown-sync-health-pr-filter-ts`; production deploy + smoke pending*

All of § A is **written and locally verified** (`scripts/deno-check.sh` green on all six functions, `actionlint` clean on both workflow copies, `openapi-spec-validator` OK, both new migrations tail-verified). Production apply + smoke is operator-driven (Michael), per the Phase-5 pattern.

### A1. Sync-health monitoring — detect **and** prevent recurrence

Closes the 2026-05-27→29 incident: the `*/15` membership-sync cron failed 192× silently when two operator-set GUCs (`app.teambrain_sync_url`, `app.teambrain_service_role_key`) vanished from `pg_db_role_setting`; a new user (`kthare10`) signed up during the gap and never landed in `project_members`. Nothing watched the sync's health.

- **Prevent** (`migrations/0013_sync_health_monitoring.sql`): `public.app_config` (service_role-only) replaces the two GUCs — a table survives the per-database-settings reset that took down the GUCs (ordinary table data persisted through the incident). The `*/15` cron is rescheduled to read it, with a `coalesce()` fallback to the legacy GUC so applying 0013 in production can't open a sync gap. The non-secret URL row is seeded in-migration; the secret key row is operator-seeded once via Studio (runbook §12) — never committed.
- **Detect** (same migration): `public.membership_sync_health(staleness_minutes int default 30)` classifies `ok/stale/failing` from `sync_runs` aggregate rows (the robust signal — `cron.job_run_details` shows success for the async `pg_net` *enqueue* even when the POST never fires). A `*/30` healthcheck cron writes a `public.health_events` row **only when not-ok** (exception log).
- **Surface** (`edge-functions/teambrain-membership-sync/index.ts`): `GET /health` (not service-role-gated, so an external uptime monitor can ping it with the public anon key) → **200** when healthy, **503** when stale/failing.

**Done when:** 0013 applies clean via Studio; the secret `app_config` row is seeded; both crons are scheduled; a `sync_runs` aggregate row lands within 15 min; `GET …/teambrain-membership-sync/health` returns **200 `ok`**; blanking the `app_config` URL row flips `GET /health` to **503** and writes a `health_events` row within 30 min; restoring it returns to **200**.

### A2. `linked_pr_url` filter — exact dedup + Phase 6 staleness-by-PR enabler

The Phase 5 § C dedup scanned recent thoughts for a `owner/repo#N` tag (C-D7) and missed re-runs once the original scrolled out of the window.

- `migrations/0014_thoughts_linked_pr_url_index.sql` — partial index `thoughts(linked_pr_url) where linked_pr_url is not null`.
- `edge-functions/teambrain-rest/index.ts` + `teambrain-mcp/index.ts` — `linked_pr_url` query param/arg on `GET /thoughts` / `list_recent_project_thoughts`: returned in results + exact-match filter.
- `.github/workflows/capture-on-merge.yml` (mirrored to `examples/`) — dedup is now exact **and moved before the gate**: a re-run of an already-captured PR skips the LLM call *and* never opens an approval issue (`already_captured` output gates the `capture` job).
- `deploy/production/nginx/html/openapi.yaml` + `examples/curl.md` — documented (param + `Thought.linked_pr_url` + a dedup-by-PR recipe).

**Done when:** spec re-validates lint-clean; `GET …/teambrain-rest/thoughts?linked_pr_url=<PR1 url>` returns the PR #1 auto-captures; re-running capture-on-merge on PR #1 skips **before** the approval gate (no issue opened).

### A3. Edge-function TS debt → `deno check` green + an executable gate

The Edge Runtime ships JS without type-checking, so latent strict-TS errors hid real ones. `scripts/deno-check.sh` revealed **5 of 6** functions were red (not the 2 the memory named): `mcp` (6), `rest` (5 — root cause: the `parse<T>` helper erased every zod `.default()`), `membership-sync` (2), `token` (1), `register-project` (2). `summarize` was already clean.

- All fixed; `args` typed via `z.infer<typeof schema>` (zod kept as source of truth), `HttpError.status` typed as Hono's `ContentfulStatusCode`, `parse<S extends z.ZodTypeAny>` returns `z.infer<S>`.
- `scripts/deno-check.sh` (throwaway `denoland/deno` container) + a `check` task in each `deno.json` make the captured "validate before deploy" convention runnable.

**Done when:** ✅ (local) `scripts/deno-check.sh` reports 0 errors across all six functions; the `check` task runs per-function. (Deploy of the type-only `token`/`register-project` changes is a no-op for runtime behavior — bundle with the next functional redeploy.)

### A4. Deploy + commit

**Done when:** `main` (both remotes) contains 0013, 0014, the function patches, the workflow + examples, the spec/curl updates, `scripts/deno-check.sh`, and this checklist; production has the three functional functions (`membership-sync`, `rest`, `mcp`) redeployed and the § A1/A2 smoke green. Capture a milestone thought to the dogfood TeamBrain closing the `monitoring-todo` follow-up on `c49822d3`.

---

## B — Staleness decay in search ranking — ✅ *shipped + smoke-verified on `pr.fabric-testbed.net` (2026-06-07)*

`match_thoughts` now ranks on a **freshness-aware score** instead of raw cosine alone, so a confidently-stale memory loses to a fresh one. Inputs (all already on the schema): `last_verified_at`, `expires_at`, `confidence` (`tentative|confirmed|deprecated`).

**Decisions (resolved 2026-06-07, confirmed with Michael):**
- **Decay shape:** *exponential, 90-day half-life* on `coalesce(last_verified_at, created_at)`, bounded below by a `decay_floor` (0.5) so freshness breaks near-ties but cannot override a much stronger cosine match. `half_life_days` / `decay_floor` are RPC parameters (defaulted) — tunable later **without** a schema change.
- **Confidence / expiry weighting:** multiplicative factors on similarity — `confirmed ×1.15`, `tentative ×1.00`, `deprecated ×0.40`; a past `expires_at` applies an additional `×0.40`.
- **Where applied:** *in the RPC* (a new migration), not post-ranked in the edge function — both MCP + REST call the one RPC and preserve its ordering, so the change reaches both for free.
- **Deprecated rows:** *sink but stay returned*; a new `include_deprecated` param (default `true`) lets a caller filter them out entirely.

**Score** (`migrations/0017_match_thoughts_staleness_decay.sql`):
`rank_score = similarity × confidence_factor × expiry_factor × (decay_floor + (1−decay_floor)·freshness)`, where `freshness = exp(−ln2 · age_days / half_life_days) ∈ (0,1]`. The cosine `match_threshold` cutoff is **unchanged** (still on raw `similarity`), so freshness re-ranks within the relevant set and never resurrects an irrelevant row. An inner `candidates` CTE keeps the HNSW index doing the ANN step and over-fetches a bounded pool before the outer re-rank, so index acceleration is preserved and a weakly-relevant fresh row outside the pool can't jump in.

**Surfaced:** `match_thoughts` returns three new columns — `expires_at`, `confidence`, `rank_score` — exposed through `teambrain-mcp` / `teambrain-rest` search results (`results[]` now carries `rank_score` + `confidence` + `expires_at`; `similarity` stays the raw cosine). Both search surfaces accept the new `include_deprecated` flag. OpenAPI (`SearchRequest` + `SearchHit`) and `examples/curl.md` § 3 updated; `openapi-spec-validator` green.

**Files:** `migrations/0017_match_thoughts_staleness_decay.sql` (new), `edge-functions/teambrain-mcp/index.ts`, `edge-functions/teambrain-rest/index.ts`, `deploy/production/nginx/html/openapi.yaml`, `examples/curl.md`, `scripts/smoke-staleness-decay.md` (new). 768-dim deployments apply the same `0017` edit with `vector(768)` swapped in (header note, mirroring how `0005` is the 768 rewrite of `0004`).

**Done when:** ✅ **MET 2026-06-07.** `0017` applied (+ `NOTIFY pgrst, 'reload schema'`), `teambrain-mcp` / `teambrain-rest` redeployed, and `scripts/smoke-staleness-decay.md` run on `pr.fabric-testbed.net`: two near-identical thoughts captured, one aged 400 days + `deprecated`, the other re-verified + `confirmed`. Search (`threshold 0.5` to isolate the pair) returned the **confirmed** thought first (`rank_score 1.0327` = sim `0.898` × 1.15) and the **deprecated** one second (`rank_score 0.189` = sim `0.9036` × 0.40 × recency `0.523`) — i.e. the deprecated row sank **below** the fresh one *despite a higher raw cosine similarity*; raw-cosine ranking would have inverted them. `include_deprecated:false` dropped the deprecated row entirely. Returned scores matched the formula to 4 dp.

## C — Commit-triggered staleness flagging — ✅ *core shipped + smoke-verified on `pr.fabric-testbed.net` (2026-06-07); scheduled poller awaits `0019` + GitHub App `Contents: read`*

When a commit touches a path a thought is pinned to (`thoughts.paths`), flag that thought for re-verification. The **staleness-signal interface is pluggable** so `commit_touched_path` / `expires_at_hit` (both shipping now) and `pr_merged` / `issue_closed` (future) are one signal kind — preserves the issue-tracker option without committing to it (deliberate non-deliverable, thought `47551466`; ADR 0001 Consequences).

**Decisions (resolved 2026-06-07, confirmed with Michael):**
- **Transport:** *pg_cron poll*, not a webhook. A new `teambrain-staleness` function polls each registered repo's new commits (GitHub compare API, reusing `getInstallationToken()` from `teambrain-membership-sync/github.ts`) and matches changed paths against `thoughts.paths`. Reuses all existing infra (cron, pg_net, `app_config`, service_role) and auto-covers every self-service-registered repo with zero per-repo setup; no webhook receiver, secret, or HMAC. ~15-min lag is irrelevant for a "re-check me" signal. A webhook can drop in later as another producer calling the same core.
- **Flag action:** *dedicated flag + pluggable signal log.* New `thoughts.stale_flagged_at` (null = not flagged) + `public.staleness_signals` (the interface every producer writes to). `last_verified_at` / `confidence` stay pure human-judgment signals (the § B decay reads `last_verified_at`, so overloading it would corrupt ranking). **Ranking is untouched** — the flag is an orthogonal badge + a `flagged_only` filter, not a score change.
- **Path-match granularity:** exact full-path overlap (GIN-indexed `thoughts_paths_gin_idx`) + directory-prefix match only for pins ending `/`. Favors low false-positives. Globs deferred.

**Core:** `public.flag_thoughts_for_paths(project_id, changed_paths, signal_kind, detail)` (SECURITY DEFINER, service_role-only) is the one matcher every producer calls — it logs a `staleness_signals` row per match and stamps `stale_flagged_at` (first-flag-wins; the log records every event). `public.flag_expired_thoughts()` is a second producer (`expires_at_hit`) proving the interface is pluggable. A `before update` trigger clears `stale_flagged_at` whenever `last_verified_at` advances (any re-verify, incl. `mark_stale`).

**Surfaced:** `match_thoughts` (recreated, carrying the 0017 decay body) + the list/search outputs return `stale_flagged_at`; `list_recent_project_thoughts` / `GET /thoughts` gain a `flagged_only` filter (the "what needs re-checking?" view). OpenAPI + `examples/curl.md` updated; `openapi-spec-validator` green; `deno check` clean on the new + edited functions.

**Files:** `migrations/0018_staleness_signals.sql` (always), `migrations/0019_pg_cron_staleness_scan.sql` (prod-only cron), `edge-functions/teambrain-staleness/{index.ts,commits.ts,deno.json}` (new), `edge-functions/teambrain-mcp/index.ts`, `edge-functions/teambrain-rest/index.ts`, `deploy/production/nginx/html/openapi.yaml`, `examples/curl.md`, `scripts/smoke-staleness-flagging.md` (new).

**Done when:** ✅ **MET 2026-06-07.** `0018` applied (+ `NOTIFY pgrst`) and all three functions deployed on `pr.fabric-testbed.net`; `scripts/smoke-staleness-flagging.md` steps 1–4 run green. Two thoughts pinned to different paths (`README.md` vs `LICENSE`); `flag_thoughts_for_paths('README.md')` flagged **only** the README thought (`stale_flagged_at` set, one `commit_touched_path` signal row, surfaced via `flagged_only=true`), while the LICENSE control stayed `stale_flagged_at: null` with zero signals — **no false positive**. `mark_stale` on the flagged thought returned `stale_flagged_at: null` (the clear-on-reverify trigger) and `flagged_only` then returned `[]`. The pluggable core + surfacing + clear loop are verified end-to-end.

☐ **Live automation follow-ups (operator, do not gate the § C core):** apply prod `0019` (the `5,20,35,50` scan + `10,40` expiry crons) and grant the GitHub App **`Contents: read`** so the scheduled `/scan` can diff commits. Until then the flag mechanism works on demand (`flag_thoughts_for_paths` / `flag_expired_thoughts` / a manual `/scan`); only the *automatic* commit polling waits on these two.

## D — `promote_to_docs` → real ADR/docs PR — ☐ *not started*

`promote_to_docs` is currently a **preview-only** stub in `teambrain-mcp` / `teambrain-rest` (returns the proposed branch/filename/markdown, opens no PR). Phase 6 wires the GitHub App to create the branch, commit the generated markdown, and open the PR — the governance loop that graduates a stabilized memory into reviewed repo docs.

**Decisions to make:** reuse the membership-sync GitHub App installation token vs a separate app; target path/branch conventions (the stub already proposes `docs/adr/<id8>-<type>.md`); whether promotion also marks the source thought (e.g., `confidence: confirmed` + a `promoted_pr_url`).

**Done when:** calling `promote_to_docs` on a real thought opens a docs PR in the target repo containing the generated markdown + provenance; the preview path remains available; RLS still gates who can promote.

## E — Migration baseline consolidation (`v1_baseline.sql`) — ☐ *deferred to cutover*

Per `migrations/README.md` § "Baseline consolidation": freeze `0001`–`0014` as a single `v1_baseline.sql` and start a fresh `v1_001_*` lineage. Doing it now would force scratch to drift from a clean deploy with no reconciliation; do it at production cutover (Phase 6 / Phase 7 prep).

**Done when:** a fresh deploy from `v1_baseline.sql` produces a schema byte-identical (modulo comments) to applying `0001`–`0014` in order; the per-phase files are retained as the historical record; the README apply-order points at the new lineage.

---

## Phase 7 readiness gate

Phase 7 (pilot evaluation) can begin when § A is deployed (the sync a pilot depends on is now self-watching), the **Getting Started** doc exists (`docs/documentation-plan.md` § 1 — a hard onboarding prerequisite), and Komal's buy-in is secured (`docs/phase-0-checklist.md` B1). Staleness/promotion (§ B–D) deepen the pilot but do not block its start.

---

## Open follow-ups / cross-references

- **Monitoring follow-up** — `c49822d3` (the incident) is closed by § A1; capture a milestone thought back to the dogfood TeamBrain when § A4 deploys.
- **Issue-tracker integration** — explicitly **not** a Phase 6 deliverable (`47551466`); § C's pluggable signal interface preserves the option for post-pilot.
- **Auto-capture noise** — `gpt-5.4-mini` leaned to the 3-proposal cap on a 1-line PR (`8153d210`); prompt-tuning belongs with § B/§ D and pilot evidence, not § A.
- **Embedding provider** — production still runs OpenAI on a personal key; § C of Phase 5 added an `OPENAI_BASE_URL` override so embeddings can ride the FABRIC key. The governance cutover decision (`49b669c5`) is "revisit before broadening the pilot" — adjacent to Phase 7, not gated by Phase 6.
