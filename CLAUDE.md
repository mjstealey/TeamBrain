# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository State

**Phases 0 → 4 complete (as of 2026-05-28). Deployed and live on `pr.fabric-testbed.net`.** Working artifacts on `main`:

- `migrations/0001_init.sql` … `0011_project_registration.sql` + `seed.sql` — multi-tenant schema, RLS for `personal | project | project_private`, pgvector with model-tagged embeddings (1536-dim OpenAI default in production; optional 768-dim Ollama variant via `0005`), GitHub team mapping, soft-delete on `project_members`, `sync_runs` audit table, pg_cron membership sync, and the `0011` drop of the placeholder project-insert policy.
- `edge-functions/` — four Deno functions: `teambrain-mcp` (6 MCP tools: `ping` + `capture`/`search`/`list_recent`/`mark_stale`/`promote_to_docs`), `teambrain-membership-sync` (GitHub-App-driven `project_members` reconciliation, pg_cron-scheduled), `teambrain-register-project` (self-service registration gated on GitHub repo-admin), and `teambrain-rest` (plain HTTP/JSON mirror of the MCP tools). Pluggable embedding provider (OpenAI default, Ollama variant).
- `deploy/production/` — docker-compose overlays (nginx Path B) + env template + runbook README, plus the FABRIC-branded landing page and the OpenAPI 3.1 spec under `nginx/html/`.
- `examples/` — curl recipes, an OpenAI function-calling client, and an illustrative GitHub Actions capture-on-merge workflow.
- Per-phase checklists under `docs/phase-{0,1,2,3,4,5}-checklist.md`.

**Live at `https://pr.fabric-testbed.net`:** GitHub-OAuth sign-in + landing page, the MCP server (`/functions/v1/teambrain-mcp/mcp`), the REST surface (`/functions/v1/teambrain-rest/*`), self-service registration (`/functions/v1/teambrain-register-project/register`), and the published OpenAPI spec (`/openapi.yaml`). Multiple projects registered, including `fabric-testbed/TeamBrain` (dogfood), `fabric-testbed/publication-tracker-dev`, and the `fabric-testbed/fabric-core-api` Phase 7 pilot.

**Phase 5 § A — long-lived non-interactive API token — shipped 2026-05-29** on `pr.fabric-testbed.net`. Migration `0012` (capability fence on `public.thoughts` + `public.api_tokens` + bot/service-account columns), `edge-functions/teambrain-token/` (admin CRUD + opaque-token → 15-min HS256 JWT exchange), bot-exemption in `teambrain-membership-sync`, and a friendly capability guard in `teambrain-mcp`/`teambrain-rest`. End-to-end smoke green (commits `0b86f85` + `88bb3ce`). The runnable GitHub-Action half of Phase 5 (§ C) is unblocked; § B (Slack) and § D (slash commands) had no dependency on § A.

**Phase 5 § C — PR-merge capture (LLM-proposed, human-approved) — shipped 2026-05-30** on the `fabric-testbed/TeamBrain` dogfood repo. New edge function `edge-functions/teambrain-summarize/` (the 6th; `POST /propose` turns merged-PR metadata into 0–3 capture proposals via the FABRIC **ai-renci LiteLLM gateway** with `gpt-5.4-mini`); `examples/github-actions/capture-on-merge.yml` is now the **runnable** two-job flow (`propose → issue-based approval → capture`), mirrored into `.github/workflows/`; `teambrain-mcp/embedding.ts` gained an `OPENAI_BASE_URL` override so embeddings can ride the same FABRIC key. The human-approval gate uses `trstringer/manual-approval` because native GitHub Environment required-reviewers are unavailable on this private repo's plan (Team → 422; needs Enterprise/public). End-to-end smoke green: PR #1 → `gpt-5.4-mini` proposed 3 captures → approved → landed + re-run dedup verified (commits `b8fac12`, `faea62c`, `95c16b2`, `1f9e266`, `adef2fe`; milestone thought `8153d210`). **This opens the Phase 6 readiness gate.** See Phased Roadmap below.

**Phase 5 § D — slash commands (Claude Code + Codex committed, Cursor template) — shipped 2026-06-09.** One-keystroke `/tb-remember` / `/tb-recall` / `/tb-recent` shortcuts over the already-connected `teambrain` MCP — repo-committed *prompt templates*, **no server-side change**. Claude Code commands committed at `.claude/commands/`; Codex committed as **skills** at `.agents/skills/{tb-remember,tb-recall,tb-recent}/SKILL.md` (Codex custom prompts are deprecated → skills are repo-discovered from `$REPO_ROOT/.agents/skills/`, so no per-dev install — at parity with Claude Code); Cursor ships as a copy-anywhere template under `examples/slash-commands/cursor/` marked **untested** pending an account (the same gap that defers the AGENTS.md Cursor connect stanza). `project_slug` auto-derives from `git remote get-url origin`; `/tb-remember` searches-first for dedup; `mark_stale`/`promote_to_docs` deliberately excluded (low-frequency agent-judgment actions). Claude-driven tool-path smoke green; the in-Codex run is a Michael-driven confirmation. Adoption kit `examples/slash-commands/README.md`; detail + Done-when in `docs/phase-5-checklist.md` § D. **Next work: Phase 5 § B (Slack)**, then Phase 6.

Build/lint/test commands still do not exist as a unified suite. SQL migrations apply via Studio or `psql`; edge functions deploy via the Supabase CLI / docker exec. Do not invent commands; ask if uncertain.

## What TeamBrain Is

TeamBrain is a multi-tenant, project-scoped, AI-agnostic shared memory service for development teams. Memory is read/written from Claude Code, Cursor, ChatGPT, gemini-cli, Copilot, etc. via **MCP** as the primary transport, with a parallel **REST/OpenAPI** surface for non-MCP-native clients (GitHub Actions, OpenAI function calling, custom agents).

It ports two architectural patterns from [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1) — RLS scoping and the shared-MCP edge-function pattern — but is a **parallel repo, not a fork**. OB1 lives at `~/github/mjstealey/OB1/` as **read-only reference**. Acknowledge the source in `CREDITS.md`.

## Settled Decisions

All four major architectural decisions are locked in (see `docs/adr/0001-teambrain-architecture.md` for full rationale; rationale also captured to Open Brain — search `PROJECT: TeamBrain —`):

1. **Project name:** "TeamBrain" — kept. Directory: `~/GitHub/mjstealey/TeamBrain/`.
2. **Repo relationship to OB1:** parallel repo with `CREDITS.md` acknowledgement, not a fork. License remains TBD (the parallel-repo choice was made specifically to keep license selection open; OB1's FSL-1.1-MIT prohibits commercial derivative works).
3. **Stack & deploy target:** self-host the official **Supabase docker-compose** stack (Postgres+pgvector, GoTrue, PostgREST, Realtime, Storage, Edge Functions, Studio, Kong) on a FABRIC-team-owned VMware VM at `https://pr.fabric-testbed.net`.
4. **Auth (Phase 1):** GitHub OAuth via GoTrue. `project_members` rows hand-seeded for the pilot. Phase 3 automates the sync against GitHub collaborator/org-team APIs. CILogon support deferred — GoTrue can run both providers simultaneously, so adding CILogon later is non-breaking.
5. **Pilot repo (decided 2026-05-03):** `~/github/fabric/fabric-core-api` (remote `fabric-testbed/fabric-core-api`, branch `develop`). Phase 7 evaluation pilot — refactoring done solo by Michael with Claude Code; Komal Thareja is the primary reviewer. The team-coordination value being tested is **multi-developer commentary on a single-committer's changes**, not multi-committer coordination. Falsification target: track every review comment that triggers a "we already discussed this" response — each is a TeamBrain miss. Workflow-monitor remains an option as a low-stakes Phase 2 plumbing pilot before graduating to fabric-core-api for Phase 7. Full rationale + tradeoffs captured in Open Brain (`PROJECT: TeamBrain — Pilot repo decision`).

## Open Decisions / Active Blockers

Pre-pilot social-coordination blocker **resolved 2026-06-09**: Komal's buy-in is met. She is actively participating on `fabric-testbed/loomai-dev`, which runs TeamBrain in production via the Phase 5 § C capture-on-merge Action — a second developer engaging with TeamBrain on a live repo, which is exactly the signal B1 was gating on. Her GitHub handle is `kthare10` (seed commit `4d079e2`). The formal Phase 7 *evaluation* pilot repo remains `fabric-testbed/fabric-core-api` with Komal as primary reviewer; loomai-dev is the lower-stakes live proof that the buy-in is real. Full rationale captured in TeamBrain (`fabric-testbed/TeamBrain`, thought `518c0395`) and Open Brain (`PROJECT: TeamBrain —`). Sub-questions and detail in `docs/phase-0-checklist.md` B1.

Phase 5 § A (the long-lived non-interactive API token) shipped 2026-05-29; end-to-end smoke green on `pr.fabric-testbed.net`. The remaining halves — Slack bot (§ B), runnable GitHub Action (§ C, the token's first consumer), slash commands (§ D) — have no architectural blockers.

## Architecture Reference

### Stack (per `docs/adr/0001-teambrain-architecture.md` and `docs/deployment.md`)

- **Postgres + pgvector** — `thoughts` table, embeddings, RLS
- **GoTrue** — auth (GitHub OAuth Phase 1; CILogon deferred)
- **PostgREST** — auto-generated REST API from the schema
- **Edge Functions (Deno)** — MCP server (~200 lines TypeScript, ports OB1's `shared-mcp` pattern, generalized to multi-tenant)
- **Studio** — admin UI (gated behind vouch-proxy + CILogon, since admin-side fits FABRIC's existing CILogon SSO infra even though app-level auth is GitHub)
- **Kong** — API gateway (bundled)
- **Caddy or nginx** — TLS termination via Let's Encrypt for `pr.fabric-testbed.net`, fronts Kong

### Hybrid storage model

- *In repo (canonical, reviewed, versioned with code):* `AGENTS.md`, `.claude/CLAUDE.md`, `.cursor/rules/`, `docs/adr/`, `docs/context/`.
- *In TeamBrain (living, ephemeral, cross-developer):* in-flight debugging notes, gotchas, recent decisions still being validated, dev preferences, cross-repo context.
- *Promotion workflow:* memories that stabilize get promoted into the repo via PR. That is the governance loop.

### Data model additions vs OB1's `thoughts` table

- New columns on `thoughts`: `project_id`, `scope` (enum: `personal | project | project_private`), `type` (enum: `decision | convention | gotcha | context | preference | runbook`), provenance (`author_user_id`, `linked_commit_sha`, `linked_pr_url`, `linked_issue_url`), freshness (`last_verified_at`, optional `expires_at`), `paths text[]`, `confidence` (enum: `tentative | confirmed | deprecated`), `tags text[]`.
- New tables: `projects` (id, repo_slug, name, created_by), `project_members` (project_id, user_id, role: `admin | contributor | reader`).

### MCP tool surface (planned)

`search_project_thoughts`, `capture_project_thought`, `list_recent_project_thoughts`, `mark_stale`, `promote_to_docs`. REST endpoints mirror these over the same backend handlers.

## Local Reference Forks

Two upstream repos are forked into Michael's GitHub account and cloned locally as **read-only reference**. Both are kept current via `gh repo sync` (run on demand from any working dir):

```bash
gh repo sync mjstealey/OB1
gh repo sync mjstealey/supabase
```

**Do not edit files in either fork from this project.** They exist to read patterns and known-good configs from. If a TeamBrain change requires divergence from an upstream pattern, copy the relevant snippet *into* TeamBrain (with attribution) rather than modifying the fork.

### `~/github/mjstealey/OB1/` — fork of `NateBJones-Projects/OB1`

Source for the two architectural patterns TeamBrain ports (RLS scopes + shared-MCP edge-function). Read before writing schema or edge-function code. Files most relevant (read on demand, not eagerly):

- `~/github/mjstealey/OB1/docs/01-getting-started.md` — canonical Supabase + pgvector setup; the schema and pgvector indexing approach mirror this.
- `~/github/mjstealey/OB1/primitives/rls/README.md` — RLS patterns to extend for `personal | project | project_private` scopes.
- `~/github/mjstealey/OB1/primitives/shared-mcp/README.md` — pattern for scoped MCP servers; the multi-tenant TeamBrain MCP edge function generalizes this.
- `~/github/mjstealey/OB1/integrations/kubernetes-deployment/` — alternative self-host path with Postgres+pgvector only (no Supabase services). Worth knowing exists; not the chosen path.

### `~/github/mjstealey/supabase/` — fork of `supabase/supabase`

The official Supabase monorepo. Only the `docker/` subtree is load-bearing for TeamBrain — that is the docker-compose stack we self-host. Files most relevant:

- `~/github/mjstealey/supabase/docker/docker-compose.yml` — base stack (Postgres+pgvector via supabase/postgres, GoTrue, PostgREST, Realtime, Storage, Edge Runtime, Studio, Kong, Supavisor, imgproxy, Logflare, Vector, postgres-meta).
- `~/github/mjstealey/supabase/docker/docker-compose.caddy.yml` — **Caddy TLS overlay**; aligns with the Caddy plan in `docs/deployment.md` for `pr.fabric-testbed.net`.
- `~/github/mjstealey/supabase/docker/docker-compose.nginx.yml` — nginx alternative if the team standardizes on nginx instead.
- `~/github/mjstealey/supabase/docker/docker-compose.pg17.yml` — Postgres 17 variant; default base ships Postgres 15.
- `~/github/mjstealey/supabase/docker/.env.example` — authoritative list of env vars; mirrors what `docs/deployment.md` calls "env-var contract".
- `~/github/mjstealey/supabase/docker/versions.md` — pinned image-tag history; consult before bumping any service tag in our compose file.
- `~/github/mjstealey/supabase/docker/volumes/db/init/` — Postgres init scripts; the `vector` extension lives here.

For Phase 0 D1 (scratch stand-up), copy `docker/.env.example` → `.env` from this fork rather than re-cloning supabase/supabase.

## Open Brain Handoff Context (in MCP)

The full TeamBrain plan lives in Michael's personal Open Brain MCP as a 4-part captured thought plus a handoff thought and follow-up decision thoughts. To load full context, search the Open Brain MCP for `TeamBrain` — the 4 plan parts cover overview/decision, architecture/data model/auth/transports, capture workflows + staleness management, and phased implementation plan; the decision thoughts cover parallel-repo and self-host+GitHub-OAuth choices made on 2026-05-02.

Capture decisions and blockers back to Open Brain with the prefix `PROJECT: TeamBrain — ` so they index alongside the plan thoughts.

## Hard Boundaries

- **Do NOT touch Michael's existing personal OB1 Supabase project** (`ncldmtgyyikclljevpkm`, org `mjstealey`). TeamBrain stands up in its **own** self-hosted instance on `pr.fabric-testbed.net`. The personal OB1 stays clean.
- **MCP servers must be remote** (HTTP endpoints reachable by every developer's tool), never stdio-local. No `claude_desktop_config.json` with local Node servers. The TeamBrain MCP runs as an Edge Function inside the team Supabase instance.
- **No production deployment in the first working session.** Stand up the docker-compose stack on a scratch VM or developer Docker Desktop first; touch `pr.fabric-testbed.net` only after the schema and auth flow are validated.
- **No credentials, API keys, or secrets in any committed file.** Use `.env` (gitignored) and document required vars in `.env.template`.
- **No `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM`** in SQL files.

## Phase 4 — Delivered

REST + OpenAPI surface, complete and live (full detail + Done-when criteria in `docs/phase-4-checklist.md`):

1. `teambrain-rest` edge function — a **uniform custom** REST mirror of all six MCP tools. The PostgREST-hybrid option was considered and rejected (decision A1): the published surface is one coherent, LLM-friendly contract; PostgREST stays available underneath but undocumented.
2. `teambrain-register-project` — self-service project registration gated on GitHub repo-admin permission; migration `0011` closed the placeholder `authenticated`-insert policy so the gated function is the only path to create a project.
3. OpenAPI 3.1 spec published at `/openapi.yaml` (served static by nginx), validated lint-clean with `openapi-spec-validator`.
4. `examples/` — curl recipes, an OpenAI function-calling client, and an illustrative GitHub Actions capture-on-merge workflow (the runnable version waits on the deferred long-lived token).
5. Parity verified: every MCP tool reproduced through REST with the same GitHub-OAuth JWT.

## Phased Roadmap

- **Phase 0 — Prep (1 wk):** stand up Supabase docker-compose on scratch VM/Docker Desktop, create GitHub OAuth App under `fabric-testbed` GitHub org, ADR 0001 (done), pick pilot repo.
- **Phase 1 — Core multi-tenant schema (1–2 wks):** `projects` + `project_members` tables, `thoughts` column additions, RLS for the three scopes, manual member seeding, smoke-test on scratch instance.
- **Phase 2 — MCP server for team use (1 wk):** port OB1's `shared-mcp` edge function to multi-tenant; test from Claude Code, Cursor, gemini-cli; commit `AGENTS.md` + `.claude/CLAUDE.md` delegation pattern to pilot repo.
- **Phase 3 — Auto membership sync (1 wk):** edge function pulls GitHub collaborators / org-team members → upserts `project_members`, scheduled or webhook-driven; minimal admin dashboard.
- **Phase 4 — REST + OpenAPI (3–5 days):** thin REST handlers over same backend logic (PostgREST covers some; custom edge functions cover the rest), publish OpenAPI spec, example clients (OpenAI function calling, curl, GitHub Actions recipe).
- **Phase 5 — Capture integrations (1–2 wks):** Slack bot (channel → project_id), GitHub Action for PR-merge summarization with human-approval gate, slash commands for Claude Code and Cursor.
- **Phase 6 — Staleness & promotion (1 wk):** `last_verified_at` decay in search ranking, commit-triggered staleness flagging via GitHub webhook, `promote_to_docs` tool generating ADR/docs PRs.
- **Phase 7 — Pilot evaluation (2 wks):** 1 real repo, 2–3 devs, track capture rate, retrieval hit rate, false-positive stale flags, friction, "AI told me wrong" incidents.
- **Future — CILogon support:** add as second GoTrue OIDC provider when non-GitHub collaborators or research-compliance auditing requires it.

## Local Environment Conventions

- macOS Apple Silicon, `uv` for Python deps, VS Code, Claude Code CLI as primary dev workflow.
- Self-hosted Supabase target: VMware VM at `pr.fabric-testbed.net` (public IP). VM sizing target: 4 vCPU / 8 GB RAM / 50 GB disk for small-team workload.
