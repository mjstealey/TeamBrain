# TeamBrain

Multi-tenant, project-scoped, AI-agnostic shared memory for development teams.

TeamBrain gives a team of developers the same persistent context for a codebase across whichever AI tools each developer uses (Claude Code, Cursor, Codex, ChatGPT, gemini-cli, Copilot). The primary transport is **MCP**; a parallel **REST/OpenAPI** surface covers non-MCP-native clients (GitHub Actions, OpenAI function calling, custom agents).

**New here?** → [**Getting Started**](docs/getting-started.md) — connect your AI tool and make your first capture in ~5 minutes.

## Status

**Phases 0–6 shipped and live on `https://pr.fabric-testbed.net` (since 2026-05-27).** Phase 5 (capture integrations): § A (API tokens) + § C (PR-merge capture) shipped and prod-verified; § D (slash commands) shipped for Claude Code + Codex; § B (Slack `/tb` bot) is server-side shipped & deployed, awaiting the FABRIC Slack-app install for live in-channel verification. Phase 6 (staleness & promotion): § A–§ D all shipped + smoke-verified — sync-health paydown (§ A), search-ranking decay (§ B), commit-triggered staleness flagging (§ C, `pg_cron` poller live), and `promote_to_docs` → real ADR/docs PR (§ D); only § E (migration-baseline consolidation) remains, deferred to production cutover. A post-Phase-6 **`/repos` management dashboard** (the `teambrain-console` edge function + `repo_status_*` RPCs, `migrations/0024`) adds self-service repo onboarding and per-repo feature status. Multiple projects registered, including the `fabric-testbed/TeamBrain` dogfood and the `fabric-testbed/fabric-core-api` Phase 7 pilot (readiness gate cleared).

Per-phase artifacts (each with a `Done when` acceptance criterion):

| Phase | Checklist | Key deliverables |
|-------|-----------|------------------|
| 0 | [phase-0-checklist.md](docs/phase-0-checklist.md) | Scratch Supabase stand-up, GitHub OAuth App, ADR 0001, pilot repo choice |
| 1 | [phase-1-checklist.md](docs/phase-1-checklist.md) | Multi-tenant schema + RLS (`personal / project / project_private`) |
| 2 | [phase-2-checklist.md](docs/phase-2-checklist.md) | MCP edge function (`teambrain-mcp`) — 6 tools |
| 3 | [phase-3-checklist.md](docs/phase-3-checklist.md) | GitHub-App-driven `project_members` sync (`teambrain-membership-sync`, pg_cron) |
| 4 | [phase-4-checklist.md](docs/phase-4-checklist.md) | REST mirror (`teambrain-rest`) + OpenAPI 3.1 spec + self-service registration (`teambrain-register-project`) |
| 5 | [phase-5-checklist.md](docs/phase-5-checklist.md) | Capture integrations: API tokens (§ A ✅), PR-merge Action (§ C ✅), slash commands (§ D ✅ — Claude Code + Codex), Slack `/tb` bot (§ B — server-side shipped; Slack-app install pending) |
| 6 | [phase-6-checklist.md](docs/phase-6-checklist.md) | Staleness & promotion: sync-health paydown (§ A ✅), search-ranking decay (§ B ✅), commit-triggered staleness flagging (§ C ✅), `promote_to_docs` → real ADR/docs PR (§ D ✅); migration-baseline consolidation (§ E, deferred to cutover) |

See [`CLAUDE.md`](CLAUDE.md) for the current implementation state, [`docs/adr/0001-teambrain-architecture.md`](docs/adr/0001-teambrain-architecture.md) for the locked-in decisions, and [`docs/deployment.md`](docs/deployment.md) + [`deploy/production/`](deploy/production/) for the deploy topology.

## Live surface (on `pr.fabric-testbed.net`)

| Resource | URL |
|---|---|
| Landing / MCP setup (GitHub OAuth sign-in + JWT) | `https://pr.fabric-testbed.net/` |
| Activity dashboard (your thought heatmap) | `https://pr.fabric-testbed.net/dashboard` |
| Repository console (onboarding + per-repo status) | `https://pr.fabric-testbed.net/repos` |
| OpenAPI 3.1 spec | `https://pr.fabric-testbed.net/openapi.yaml` |
| MCP endpoint | `https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp` |
| REST surface | `https://pr.fabric-testbed.net/functions/v1/teambrain-rest/*` |
| Self-service project registration | `https://pr.fabric-testbed.net/functions/v1/teambrain-register-project/register` |
| API token issue / list / revoke / exchange | `https://pr.fabric-testbed.net/functions/v1/teambrain-token/*` |
| PR-merge capture summarizer (LLM proposals) | `https://pr.fabric-testbed.net/functions/v1/teambrain-summarize/propose` |
| Slack `/tb` slash command + channel links | `https://pr.fabric-testbed.net/functions/v1/teambrain-slack/*` |
| Commit-triggered staleness scan + health | `https://pr.fabric-testbed.net/functions/v1/teambrain-staleness/*` |
| Repo console API (discover / setup-pr / sync-now / AGENTS.md) | `https://pr.fabric-testbed.net/functions/v1/teambrain-console/*` |

Example clients live under [`examples/`](examples/) — curl recipes ([`curl.md`](examples/curl.md)), an OpenAI function-calling Python client, and a runnable PR-merge GitHub Action. To add the PR-merge capture Action to your own `fabric-testbed` repo, see the step-by-step [capture-on-merge adoption guide](docs/capture-on-merge-adoption.md).

## Architecture

- **Stack:** self-hosted [Supabase docker-compose](https://github.com/supabase/supabase/tree/master/docker) — Postgres 17 + pgvector, GoTrue, PostgREST, Realtime, Storage, Edge Functions (Deno), Studio, Kong.
- **Deploy target:** team-owned VMware VM at `https://pr.fabric-testbed.net` (public IP). TLS terminated by nginx (Path B in [`deploy/production/`](deploy/production/)) using the institutional **InCommon/UNC SAN cert** — *not* Let's Encrypt; the cert is renewed out-of-band and TeamBrain consumes it.
- **Auth:** GitHub OAuth via GoTrue. `project_members` rows reconciled against GitHub collaborators / org-teams by an org-scoped GitHub App on a 15-min `pg_cron` schedule. Self-service project registration is gated on the caller's GitHub repo-admin permission. Non-interactive callers (CI, GitHub Actions) use a long-lived opaque API token (Phase 5 § A) exchanged at `/teambrain-token/token/exchange` for a short-lived (15 min) JWT. The same org-scoped App also carries **Contents + Pull requests + Workflows** write (plus Metadata/Members read); the write scopes back `promote_to_docs`' ADR/docs PRs and the `teambrain-console` capture-on-merge setup PRs — committing a `.github/workflows/` file requires the separate Workflows scope. CILogon OIDC is supported by GoTrue and reserved for a later phase.
- **Embedding:** OpenAI `text-embedding-3-small` (1536 dim) in production by default; a 768-dim Ollama variant is in-tree via `migrations/0005_resize_embedding_768.sql` for the no-third-party-vendor research-infra posture. Embeddings are model-tagged so a provider/model swap can be scoped at re-embed time.
- **Storage model — hybrid:**
  - *In repo (canonical, reviewed, versioned with code):* `AGENTS.md`, `.claude/CLAUDE.md`, `.cursor/rules/`, `docs/adr/`, `docs/context/`.
  - *In TeamBrain (living, ephemeral, cross-developer):* in-flight debugging notes, gotchas not yet promoted to docs, recent decisions still being validated, dev preferences, cross-repo context.
  - *Promotion workflow:* memories that stabilize get promoted into the repo via PR. That is the governance loop — `promote_to_docs` opens a real ADR/docs PR via the GitHub App (Phase 6 § D).
- **Transport:** single backend → two thin **custom** edge functions: `teambrain-mcp` (MCP/JSON-RPC, 6 tools) and `teambrain-rest` (HTTP/JSON mirror of the same tools). PostgREST remains available under the hood but is intentionally not the documented surface — see Phase 4 § A1 for the uniform-custom-vs-PostgREST-hybrid decision. Adding a new AI client = config entry, not adapter code. Seven further edge functions support the system: `teambrain-membership-sync`, `teambrain-register-project`, `teambrain-token`, `teambrain-summarize`, `teambrain-slack`, `teambrain-staleness`, and `teambrain-console` (the `/repos` dashboard backend) — nine in total.
- **Web UI (static, nginx-served):** a landing / MCP-setup page (`/`), an activity dashboard (`/dashboard`, the caller's RLS-scoped thought heatmap), and a repository console (`/repos`, per-repo onboarding + feature status + one-click setup PRs). All three share one GitHub-OAuth session and have the public `ANON_KEY` injected via nginx `sub_filter`.

## Phased Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Prep — Supabase docker-compose on scratch host, GitHub OAuth App in `fabric-testbed` org, ADR 0001, pick pilot repo | ✅ complete |
| 1 | Core multi-tenant schema — `projects`, `project_members`, extended `thoughts` columns, RLS for `personal / project / project_private`, manual member seeding | ✅ complete |
| 2 | MCP server with project-aware tool surface — `capture / search / list_recent / mark_stale / promote_to_docs` (+ `ping`); validated from Claude Code, Cursor, Codex | ✅ complete |
| 3 | Automated membership sync — GitHub collaborators + org-team members → `project_members`, pg_cron + manual trigger, `sync_runs` audit | ✅ complete |
| 4 | REST handlers + OpenAPI 3.1 spec; example clients (OpenAI function calling, curl, illustrative GitHub Action); self-service project registration | ✅ complete |
| 5 | Capture integrations — long-lived API token mechanism (§ A ✅), Slack bot (§ B), runnable PR-merge GitHub Action (§ C ✅, consumes § A), slash commands (§ D) | § A ✅, § C ✅, § D ✅ (Claude Code + Codex); § B server-side ✅ (Slack-app install pending) |
| 6 | Staleness + promotion — sync-health paydown (§ A), `last_verified_at` decay in ranking (§ B), commit-triggered staleness flagging via `pg_cron` poll (§ C), `promote_to_docs` generating ADR/docs PRs (§ D) | ✅ § A–D shipped + smoke-verified; § E (migration baseline) deferred to cutover |
| 7 | Pilot evaluation on 1 real repo (`fabric-testbed/fabric-core-api`), 2–3 devs — capture / retrieval / staleness / friction metrics | readiness gate cleared (Komal buy-in met 2026-06-09); kickoff ready |
| Future | CILogon as second GoTrue OIDC provider when non-GitHub collaborators or research-compliance auditing requires it | deferred |

## Operational responsibilities (since we self-host)

- **Backups:** `pg_dump` cron + offsite copy for v1; pgBackRest or Barman if PITR becomes a requirement.
- **TLS:** institutional InCommon/UNC SAN cert under `/root/cert`, bind-mounted into the nginx container. Renewed out-of-band; no Let's Encrypt path is wired (deliberately, to match FABRIC's existing cert posture).
- **Studio access:** SSH tunnel only — `ssh -L 3000:127.0.0.1:8000 fabric-pr` → `http://localhost:3000`. Kong is loopback-bound at `127.0.0.1:8000`. A vouch-proxy + CILogon admin-side path is the future plan, not yet wired.
- **Upgrades:** track Supabase docker-compose releases; the upstream team ships coordinated version bumps. See `~/supabase-stack-sha.txt` on the production box for the pinned upstream SHA.

See [`docs/deployment.md`](docs/deployment.md) for VM sizing, env-var contract, GitHub OAuth App configuration, and TLS specifics, and [`deploy/production/`](deploy/production/) for the production overlays (Path B nginx + `docker-compose.override.yml`).

## Relationship to OB1

TeamBrain ports two architectural patterns from [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1) — the RLS scope policies and the shared-MCP edge-function pattern — but is a **parallel repo, not a fork**. See [`CREDITS.md`](CREDITS.md) for the acknowledgement and [`docs/adr/0001-teambrain-architecture.md`](docs/adr/0001-teambrain-architecture.md) for the architectural rationale.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Permissive with an explicit patent grant; the parallel-repo decision (rather than forking OB1's FSL-1.1-MIT) was made specifically to keep this choice open.
