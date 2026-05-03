# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository State

This repo is in **pre-Phase-1 bootstrap state**: scaffolding only (`CLAUDE.md`, `README.md`, `CREDITS.md`, `.gitignore`, `docs/adr/0001-teambrain-architecture.md`, `docs/deployment.md`, `docs/phase-0-checklist.md`, `.claude/settings.local.json`). No application code, migrations, or edge functions yet. Build/lint/test commands do not exist yet — they will be added as Phase 1 lands. Do not invent commands; if something is asked for that doesn't exist yet, say so.

**Next session entry point:** read [`docs/phase-0-checklist.md`](docs/phase-0-checklist.md). It contains the ordered, concrete tasks to complete Phase 0 (repo housekeeping → pilot decision → GitHub OAuth App → scratch Supabase spike), each with a "Done when" acceptance criterion.

## What TeamBrain Is

TeamBrain is a multi-tenant, project-scoped, AI-agnostic shared memory service for development teams. Memory is read/written from Claude Code, Cursor, ChatGPT, gemini-cli, Copilot, etc. via **MCP** as the primary transport, with a parallel **REST/OpenAPI** surface for non-MCP-native clients (GitHub Actions, OpenAI function calling, custom agents).

It ports two architectural patterns from [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1) — RLS scoping and the shared-MCP edge-function pattern — but is a **parallel repo, not a fork**. OB1 lives at `~/github/mjstealey/OB1/` as **read-only reference**. Acknowledge the source in `CREDITS.md`.

## Settled Decisions

All four major architectural decisions are locked in (see `docs/adr/0001-teambrain-architecture.md` for full rationale; rationale also captured to Open Brain — search `PROJECT: TeamBrain —`):

1. **Project name:** "TeamBrain" — kept. Directory: `~/GitHub/mjstealey/TeamBrain/`.
2. **Repo relationship to OB1:** parallel repo with `CREDITS.md` acknowledgement, not a fork. License remains TBD (the parallel-repo choice was made specifically to keep license selection open; OB1's FSL-1.1-MIT prohibits commercial derivative works).
3. **Stack & deploy target:** self-host the official **Supabase docker-compose** stack (Postgres+pgvector, GoTrue, PostgREST, Realtime, Storage, Edge Functions, Studio, Kong) on a FABRIC-team-owned VMware VM at `https://pr.fabric-testbed.net`.
4. **Auth (Phase 1):** GitHub OAuth via GoTrue. `project_members` rows hand-seeded for the pilot. Phase 3 automates the sync against GitHub collaborator/org-team APIs. CILogon support deferred — GoTrue can run both providers simultaneously, so adding CILogon later is non-breaking.

## Open Decisions Required Before Phase 1 Coding

1. **Pilot repo.** Candidates: HotGlass (cleaner, solo-ish — validates plumbing but not the team part), workflow-visualizer (real multi-contributor pain, mid-blocker on anywidget MIME-type issue), or `~/github/fabric/fabric-core-api` (real multi-dev Python codebase, but undergoing restructuring soon — high-signal/high-noise pilot). Sub-questions for fabric-core-api: when does the restructuring start, and are 2+ developers actively committing during the pilot window?

The schema migration itself can land in TeamBrain without the pilot repo decision (it is database-side). The pilot only matters for `AGENTS.md` / `.claude/CLAUDE.md` / slash-command integration in Phase 2.

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

## OB1 — Upstream Reference

A local clone lives at `~/github/mjstealey/OB1/`. Read it before writing schema or edge-function code. Files most relevant to TeamBrain (read on demand, not eagerly):

- `~/github/mjstealey/OB1/docs/01-getting-started.md` — canonical Supabase + pgvector setup; the schema and pgvector indexing approach mirror this.
- `~/github/mjstealey/OB1/primitives/rls/README.md` — RLS patterns to extend for `personal | project | project_private` scopes.
- `~/github/mjstealey/OB1/primitives/shared-mcp/README.md` — pattern for scoped MCP servers; the multi-tenant TeamBrain MCP edge function generalizes this.
- `~/github/mjstealey/OB1/integrations/kubernetes-deployment/` — alternative self-host path with Postgres+pgvector only (no Supabase services). Worth knowing exists; not the chosen path.

Treat OB1 as **read-only**. Do not edit files there from this project.

## Open Brain Handoff Context (in MCP)

The full TeamBrain plan lives in Michael's personal Open Brain MCP as a 4-part captured thought plus a handoff thought and follow-up decision thoughts. To load full context, search the Open Brain MCP for `TeamBrain` — the 4 plan parts cover overview/decision, architecture/data model/auth/transports, capture workflows + staleness management, and phased implementation plan; the decision thoughts cover parallel-repo and self-host+GitHub-OAuth choices made on 2026-05-02.

Capture decisions and blockers back to Open Brain with the prefix `PROJECT: TeamBrain — ` so they index alongside the plan thoughts.

## Hard Boundaries

- **Do NOT touch Michael's existing personal OB1 Supabase project** (`ncldmtgyyikclljevpkm`, org `mjstealey`). TeamBrain stands up in its **own** self-hosted instance on `pr.fabric-testbed.net`. The personal OB1 stays clean.
- **MCP servers must be remote** (HTTP endpoints reachable by every developer's tool), never stdio-local. No `claude_desktop_config.json` with local Node servers. The TeamBrain MCP runs as an Edge Function inside the team Supabase instance.
- **No production deployment in the first working session.** Stand up the docker-compose stack on a scratch VM or developer Docker Desktop first; touch `pr.fabric-testbed.net` only after the schema and auth flow are validated.
- **No credentials, API keys, or secrets in any committed file.** Use `.env` (gitignored) and document required vars in `.env.template`.
- **No `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM`** in SQL files.

## Phase 1 — Suggested First Deliverables

When the pilot repo decision unblocks (or if pursuing schema-only work that is independent of it):

1. `migrations/0001_init.sql` — `projects` + `project_members` tables, the `thoughts` table extended with the columns listed above, pgvector index, `updated_at` trigger.
2. `migrations/0002_rls.sql` — RLS policies for `personal | project | project_private` scopes with **inline comments explaining each policy's intent**.
3. `migrations/seed.sql` — manual `project_members` seed rows for the pilot devs.
4. Local docker-compose stand-up instructions in `docs/deployment.md` (already scaffolded).
5. End-to-end smoke test: GitHub OAuth login → seeded user can read/write their own and project-scoped thoughts → user not in `project_members` cannot.

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
