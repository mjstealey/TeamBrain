# TeamBrain — Development History & Provenance

> **What this is.** The build record for TeamBrain: the phased roadmap, what
> each phase delivered, its `Done when` acceptance checklist, and the git/PR
> provenance for each phase. This was migrated out of the top-level project
> README on 2026-06-23 once core development (Phases 0–6) was complete and the
> project had active users — the README is now a conventional project README
> (what it is, how to deploy, how to use). **For usage and deployment, start at
> the [project README](../../README.md).**

Phases 0–6 are **shipped and live** on `https://pr.fabric-testbed.net` (since
2026-05-27). Only Phase 6 § E (migration-baseline consolidation) is deferred,
to the production cutover. Phase 7 is the evaluation pilot on
`fabric-testbed/fabric-core-api`. Each phase has a detailed checklist in this
folder with a `Done when` acceptance criterion.

## Phased roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Prep — Supabase docker-compose on a scratch host, GitHub OAuth App in the `fabric-testbed` org, ADR 0001, pick pilot repo | ✅ complete |
| 1 | Core multi-tenant schema — `projects`, `project_members`, extended `thoughts`, RLS for `personal / project / project_private`, manual member seeding | ✅ complete |
| 2 | MCP server with a project-aware tool surface — `capture / search / list_recent / mark_stale / promote_to_docs` (+ `ping`); validated from Claude Code, Cursor, Codex | ✅ complete |
| 3 | Automated membership sync — GitHub collaborators + org-team members → `project_members`, pg_cron + manual trigger, `sync_runs` audit | ✅ complete |
| 4 | REST handlers + OpenAPI 3.1 spec; example clients (OpenAI function calling, curl, GitHub Action); self-service project registration | ✅ complete |
| 5 | Capture integrations — long-lived API tokens (§ A), Slack `/tb` bot (§ B), PR-merge GitHub Action (§ C), slash commands (§ D) | § A ✅, § C ✅, § D ✅ (Claude Code + Codex); § B server-side ✅ (Slack-app install pending) |
| 6 | Staleness + promotion — sync-health paydown (§ A), `last_verified_at` ranking decay (§ B), commit-triggered staleness flagging (§ C), `promote_to_docs` → ADR/docs PR (§ D) | ✅ § A–D shipped + smoke-verified; § E (migration baseline) deferred to cutover |
| 7 | Pilot evaluation on one real repo (`fabric-testbed/fabric-core-api`), 2–3 devs — capture / retrieval / staleness / friction metrics | readiness gate cleared (2026-06-09); kickoff ready |
| Future | CILogon as a second GoTrue OIDC provider when non-GitHub collaborators or research-compliance auditing requires it | deferred |

## How to read the provenance

Each phase below lists its **deliverables**, its **checklist** (the `Done when`
acceptance record), and its **provenance** (the commits / merged PRs that built
it). PR links resolve at `github.com/fabric-testbed/TeamBrain` (a private repo —
visible to org members).

> **PR-workflow boundary.** The GitHub PR workflow only began at **PR #1
> (2026-05-30), mid-Phase-5**. Phases 0–4 and the early part of Phase 5 (§ A
> token mechanism, § C summarizer build) were delivered as **direct commits to
> `main`** and are recorded below as commit ranges/SHAs. From PR #1 onward,
> work landed via PRs.

---

### Phase 0 — Environment bootstrap
**Deliverables:** scratch Supabase docker-compose, GitHub OAuth App in `fabric-testbed`, [ADR 0001](../adr/0001-teambrain-architecture.md), pilot-repo decision. **Checklist:** [phase-0-checklist.md](phase-0-checklist.md).
**Provenance** (direct commits, 2026-05-03):
- `b6429ff` initial scaffold: docs, ADR 0001, deployment target
- `964f0d3` capture pilot decision (`fabric-core-api`), local reference forks
- `b6ca136` D1–D8: scratch Supabase + Caddy/mkcert TLS + GitHub OAuth flow verified
- `f4ba2d4` polish: PG17 native arm64, function `search_path` lockdown

### Phase 1 — Multi-tenant schema + RLS
**Deliverables:** `migrations/0001_init.sql`, `0002_rls.sql`, `0003_disable_graphql.sql`, `seed.sql`; RLS for `personal / project / project_private`. **Checklist:** [phase-1-checklist.md](phase-1-checklist.md).
**Provenance** (direct commit, 2026-05-03): `7cc7a92` multi-tenant schema + RLS + pilot seed.

### Phase 2 — MCP edge function
**Deliverables:** `edge-functions/teambrain-mcp/` (6 tools), `migrations/0004_match_thoughts.sql`. **Checklist:** [phase-2-checklist.md](phase-2-checklist.md).
**Provenance** (direct commits, 2026-05-05):
- `6d97e59` multi-tenant MCP edge function + tools, smoke-tested via curl
- *Phase 2.5 (pluggable embeddings):* `21d2653` OpenAI default + Ollama self-host variant; `74485bc` tag every embedding with its producing model (`migrations/0005`, `0006`)

### Phase 3 — Automated membership sync
**Deliverables:** `edge-functions/teambrain-membership-sync/`, `migrations/0007`–`0010`, pg_cron schedule, `sync_runs` audit. **Checklist:** [phase-3-checklist.md](phase-3-checklist.md).
**Provenance** (direct commits, 2026-05-05 → 2026-05-10): `9354231`, `ad29709`, `4d079e2` (confirm Komal's handle `kthare10`), `a22edf4` automated GitHub-collaborator membership sync (C-plus policy).

### Phase 4 — REST + OpenAPI surface
**Deliverables:** `edge-functions/teambrain-rest/`, OpenAPI 3.1 spec at `/openapi.yaml`, `edge-functions/teambrain-register-project/` (`migrations/0011`, repo-admin-gated). **Checklist:** [phase-4-checklist.md](phase-4-checklist.md).
**Provenance** (direct commits, 2026-05-11 → 2026-05-28): `d3041b6` self-service project registration · `ae54051` `teambrain-rest` REST mirror · `2dcf0cc` publish + serve OpenAPI 3.1 · `4385f51` REST example clients. (Production cutover hardening ran in the same window: `c9c56b4`…`f03aed2`, `b068e47` FABRIC landing page, `e7c89ac` pilot friction fixes.)

### Phase 5 — Capture integrations
**Deliverables:** API tokens (§ A, `migrations/0012`, `teambrain-token/`), Slack `/tb` bot (§ B, `migrations/0023`, `teambrain-slack/`), PR-merge Action (§ C, `teambrain-summarize/`), slash commands (§ D). **Checklist:** [phase-5-checklist.md](phase-5-checklist.md).
**Provenance:**
- § A — long-lived API tokens (direct commits, 2026-05-29): `0b86f85` issuance + exchange · `88bb3ce` 0012 type-mismatch fix
- § C — PR-merge summarize + capture (direct commits, 2026-05-30): `b8fac12` `teambrain-summarize` + two-job action · `faea62c` route via FABRIC LiteLLM gateway · `1f9e266` land the workflow in the dogfood repo. [#1](https://github.com/fabric-testbed/TeamBrain/pull/1) (first merged PR) smoke-verified § C end-to-end.
- § D — slash commands (Claude Code + Codex, + Cursor template): [#23](https://github.com/fabric-testbed/TeamBrain/pull/23)
- § B — Slack `/tb` surface: [#30](https://github.com/fabric-testbed/TeamBrain/pull/30) (`migrations/0023` + `teambrain-slack/`); detection/recovery in [#70](https://github.com/fabric-testbed/TeamBrain/pull/70) / [#73](https://github.com/fabric-testbed/TeamBrain/pull/73); close-out [#69](https://github.com/fabric-testbed/TeamBrain/pull/69). Server-side shipped + deployed; awaiting the FABRIC Slack-app install for live in-channel verification.

### Phase 6 — Staleness & promotion
**Deliverables:** sync-health paydown (§ A), ranking decay (§ B), commit-triggered staleness flagging (§ C), `promote_to_docs` → ADR/docs PR (§ D); migration-baseline consolidation (§ E, deferred). **Checklist:** [phase-6-checklist.md](phase-6-checklist.md).
**Provenance** (merged PRs, 2026-06-01 → 2026-06-10):
- § A deferred-debt paydown: [#4](https://github.com/fabric-testbed/TeamBrain/pull/4), [#6](https://github.com/fabric-testbed/TeamBrain/pull/6), [#8](https://github.com/fabric-testbed/TeamBrain/pull/8), [#10](https://github.com/fabric-testbed/TeamBrain/pull/10) (`migrations/0013`–`0016`, `scripts/deno-check.sh`)
- § B ranking decay: [#12](https://github.com/fabric-testbed/TeamBrain/pull/12) (`migrations/0017`)
- § C staleness flagging: [#14](https://github.com/fabric-testbed/TeamBrain/pull/14) (`migrations/0018`, `0019`, `teambrain-staleness/`)
- § D promote-to-docs PR: [#17](https://github.com/fabric-testbed/TeamBrain/pull/17) (`migrations/0020`, `teambrain-mcp/promote.ts`); RPC lockdown follow-up [#29](https://github.com/fabric-testbed/TeamBrain/pull/29)
- § E — deferred to cutover; no commit (consistent with [`migrations/README.md`](../../migrations/README.md) § baseline consolidation).

### Phase 7 — Pilot evaluation
**Status:** readiness gate cleared 2026-06-09 (Komal's buy-in met via active `fabric-testbed/loomai-dev` participation); kickoff ready. No discrete code-delivery tranche — the only commit explicitly tagged for Phase 7 is the onboarding prerequisite, [#19](https://github.com/fabric-testbed/TeamBrain/pull/19) (Getting Started guide). The operational surfaces below were built in the run-up to the pilot.

---

## Post-Phase-6 — operational surfaces

Built after the core roadmap to support onboarding and the pilot. All via merged PRs (2026-06-08 → 2026-06-22).

- **Activity dashboard** (`/dashboard`): [#27](https://github.com/fabric-testbed/TeamBrain/pull/27) per-user heatmap with drill-down.
- **`/repos` onboarding + status console** (`migrations/0024`, `teambrain-console`): [#35](https://github.com/fabric-testbed/TeamBrain/pull/35) introduces the console; [#41](https://github.com/fabric-testbed/TeamBrain/pull/41) non-clobbering setup PRs; [#47](https://github.com/fabric-testbed/TeamBrain/pull/47) inline "Flagged for re-verification" panel; [#98](https://github.com/fabric-testbed/TeamBrain/pull/98) expandable flagged memories.
- **Public `/help` guide + uniform nav + 30-day JWT:** [#56](https://github.com/fabric-testbed/TeamBrain/pull/56), [#58](https://github.com/fabric-testbed/TeamBrain/pull/58), [#63](https://github.com/fabric-testbed/TeamBrain/pull/63), [#64](https://github.com/fabric-testbed/TeamBrain/pull/64), [#85](https://github.com/fabric-testbed/TeamBrain/pull/85), [#89](https://github.com/fabric-testbed/TeamBrain/pull/89).
- **Capture-on-merge operations** (`migrations/0026` toggle): [#91](https://github.com/fabric-testbed/TeamBrain/pull/91) central enable/disable toggle; [#93](https://github.com/fabric-testbed/TeamBrain/pull/93) event-driven approval (no idle runner/timer); [#95](https://github.com/fabric-testbed/TeamBrain/pull/95) workflow-drift detection; [#96](https://github.com/fabric-testbed/TeamBrain/pull/96) AGENTS.md template versioning.
- **Client-command install into any repo:** [#94](https://github.com/fabric-testbed/TeamBrain/pull/94) (see [`install/README.md`](../../install/README.md)).
- **Self-service project re-home (rename):** [#99](https://github.com/fabric-testbed/TeamBrain/pull/99). Follow-up — rename-proof identity via the immutable GitHub repo id — tracked as [issue #100](https://github.com/fabric-testbed/TeamBrain/issues/100).

## Promoted-memory artifacts

The governance loop (`promote_to_docs`, Phase 6 § D) turns stabilized TeamBrain
memories into repo docs via PR. Those promoted records live alongside this
history and are part of the provenance:

- [`docs/adr/`](../adr/) — architecture & decision records (ADR 0001 plus promoted decisions).
- [`docs/context/`](../context/) — promoted status/progress checkpoints.
- [`docs/notes/`](../notes/) — promoted gotchas and incident records.

Doc-promotion PRs ([#75](https://github.com/fabric-testbed/TeamBrain/pull/75)–[#84](https://github.com/fabric-testbed/TeamBrain/pull/84), auto-generated by `promote_to_docs`) are content/governance changes, not phase deliverables.
