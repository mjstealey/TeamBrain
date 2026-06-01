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

## B — Staleness decay in search ranking — ☐ *not started*

Make `match_thoughts` ranking factor freshness, not just cosine similarity, so a confidently-stale memory loses to a fresh one. Inputs already on the schema: `last_verified_at`, `expires_at`, `confidence` (`tentative|confirmed|deprecated`).

**Decisions to make:** the decay shape (linear vs exponential half-life on `last_verified_at`); how `confidence` and a passed `expires_at` weight the score; whether decay is applied in the RPC (`0004_match_thoughts.sql` → a new migration) or post-ranked in the edge function; whether deprecated rows are filtered out or just sink.

**Done when:** a `deprecated` / long-unverified thought ranks below a fresh `confirmed` one for the same query; the behavior is covered by a repeatable smoke (capture two near-identical thoughts, age/deprecate one, confirm ordering).

## C — Commit-triggered staleness flagging (GitHub webhook) — ☐ *not started*

When a commit touches paths a thought is pinned to (`thoughts.paths`), flag that thought for re-verification. Keep the **staleness-signal interface pluggable** so `commit-touched-path` / `PR-merged` / `expires_at-hit` / (future) `issue-closed` are all one signal kind — preserves the issue-tracker option without committing to it (deliberate non-deliverable, thought `47551466`; ADR 0001 Consequences).

**Decisions to make:** webhook vs the existing pg_cron poll; what "flag" does (bump nothing / set `last_verified_at = null` / write a `health_events`-style row / notify); path-match granularity.

**Done when:** a push touching a pinned path surfaces the affected thought(s) as needing re-verification, through the pluggable signal path; no false-positive flag on an unrelated path.

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
