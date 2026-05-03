# TeamBrain

Multi-tenant, project-scoped, AI-agnostic shared memory for development teams.

TeamBrain gives a team of developers the same persistent context for a codebase across whichever AI tools each developer uses (Claude Code, Cursor, Codex, ChatGPT, gemini-cli, Copilot). The primary transport is **MCP**; a parallel **REST/OpenAPI** surface covers non-MCP-native clients (GitHub Actions, OpenAI function calling, custom agents).

## Status

**Pre-Phase-1 bootstrap.** No runnable code yet. See [`CLAUDE.md`](CLAUDE.md) for the current state, [`docs/adr/0001-teambrain-architecture.md`](docs/adr/0001-teambrain-architecture.md) for the locked-in architectural decisions, and [`docs/deployment.md`](docs/deployment.md) for the target deploy topology.

## Architecture (planned)

- **Stack:** self-hosted [Supabase docker-compose](https://github.com/supabase/supabase/tree/master/docker) — Postgres+pgvector, GoTrue, PostgREST, Realtime, Storage, Edge Functions (Deno), Studio, Kong.
- **Deploy target:** team-owned VMware VM at `https://pr.fabric-testbed.net` (public IP), TLS via Caddy or nginx + Let's Encrypt.
- **Auth (Phase 1):** GitHub OAuth via GoTrue. Project membership hand-seeded for the pilot; Phase 3 automates the sync against GitHub collaborator and org-team APIs. CILogon OIDC supported by GoTrue and reserved for a later phase.
- **Storage model — hybrid:**
  - *In repo (canonical, reviewed, versioned with code):* `AGENTS.md`, `.claude/CLAUDE.md`, `.cursor/rules/`, `docs/adr/`, `docs/context/`.
  - *In TeamBrain (living, ephemeral, cross-developer):* in-flight debugging notes, gotchas not yet promoted to docs, recent decisions still being validated, dev preferences, cross-repo context.
  - *Promotion workflow:* memories that stabilize get promoted into the repo via PR. That is the governance loop.
- **Transport:** single backend → two thin transport layers (MCP edge function + REST/PostgREST handlers). Adding a new AI client = config entry, not adapter code.

## Phased Roadmap

| Phase | Scope | Duration |
|-------|-------|----------|
| 0 | Prep — Supabase docker-compose on scratch host, GitHub OAuth App in `fabric-testbed` org, ADR 0001, pick pilot repo | 1 wk |
| 1 | Core multi-tenant schema — `projects`, `project_members`, extended `thoughts` columns, RLS for `personal / project / project_private`, manual member seeding | 1–2 wks |
| 2 | MCP server with project-aware tool surface — test from Claude Code, Cursor, gemini-cli; commit `AGENTS.md` + `.claude/CLAUDE.md` to pilot repo | 1 wk |
| 3 | Automated membership sync — GitHub collaborators / org-teams → `project_members`; minimal admin dashboard | 1 wk |
| 4 | REST handlers + OpenAPI spec; example clients (OpenAI function calling, curl, GitHub Actions) | 3–5 days |
| 5 | Capture integrations — Slack bot, GitHub Action for PR-merge summarization with human-approval gate, slash commands | 1–2 wks |
| 6 | Staleness + promotion — `last_verified_at` decay, commit-triggered staleness flagging via webhook, `promote_to_docs` tool | 1 wk |
| 7 | Pilot evaluation on 1 real repo, 2–3 devs | 2 wks |
| Future | CILogon as second GoTrue OIDC provider when non-GitHub collaborators or research-compliance auditing requires it | — |

## Operational responsibilities (since we self-host)

- **Backups:** `pg_dump` cron + offsite copy for v1; pgBackRest or Barman if PITR becomes a requirement.
- **TLS:** Caddy or nginx + Let's Encrypt for `pr.fabric-testbed.net`. Caddy preferred (simpler, auto-renewing).
- **Studio access:** restricted to internal-only or fronted by vouch-proxy + CILogon (reuses the FABRIC team's existing pattern from `cilogon-vouch-proxy-example`).
- **Upgrades:** track Supabase docker-compose releases; the upstream team ships coordinated version bumps.

See [`docs/deployment.md`](docs/deployment.md) for VM sizing, env-var contract, GitHub OAuth App configuration, and TLS specifics.

## Relationship to OB1

TeamBrain ports two architectural patterns from [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1) — the RLS scope policies and the shared-MCP edge-function pattern — but is a **parallel repo, not a fork**. See [`CREDITS.md`](CREDITS.md) for the acknowledgement and [`docs/adr/0001-teambrain-architecture.md`](docs/adr/0001-teambrain-architecture.md) for the architectural rationale.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Permissive with an explicit patent grant; the parallel-repo decision (rather than forking OB1's FSL-1.1-MIT) was made specifically to keep this choice open.
