# TeamBrain

**Multi-tenant, project-scoped, AI-agnostic shared memory for development teams.**

TeamBrain gives everyone working on a repo the same persistent context —
decisions, conventions, gotchas, in-flight debugging notes — regardless of which
AI tool each developer uses (Claude Code, Cursor, Codex, ChatGPT, gemini-cli,
Copilot). The primary transport is **MCP**; a parallel **REST/OpenAPI** surface
covers anything that isn't MCP-native (GitHub Actions, OpenAI function calling,
custom agents). Both talk to one backend and enforce the same row-level access
rules.

Live at **`https://pr.fabric-testbed.net`**. Phases 0–6 are shipped and in
production (since 2026-05-27); a Phase 7 evaluation pilot runs on
`fabric-testbed/fabric-core-api`. The full build record — phased roadmap, what
each phase delivered, and the git/PR provenance — lives in
[**docs/development/**](docs/development/README.md).

> **New here?** → [**Getting Started**](docs/getting-started.md) connects your AI
> tool and walks your first capture in ~5 minutes. The live, signed-in-aware
> version is at [`/help`](https://pr.fabric-testbed.net/help).

## Live surface (`pr.fabric-testbed.net`)

| Resource | URL |
|---|---|
| Landing / MCP setup (GitHub OAuth sign-in + JWT) | `https://pr.fabric-testbed.net/` |
| Activity dashboard (your thought heatmap) | `https://pr.fabric-testbed.net/dashboard` |
| Repository console (onboarding + per-repo status) | `https://pr.fabric-testbed.net/repos` |
| Public usage guide (connect / slash / Slack / capture-on-merge) | `https://pr.fabric-testbed.net/help` |
| OpenAPI 3.1 spec | `https://pr.fabric-testbed.net/openapi.yaml` |
| MCP endpoint | `https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp` |
| REST surface | `https://pr.fabric-testbed.net/functions/v1/teambrain-rest/*` |

## Usage

End users connect their own AI tool — there is nothing to install server-side.
Full walkthrough in [`docs/getting-started.md`](docs/getting-started.md); the
in-app guide (with your token pre-filled when signed in) is at
[`/help`](https://pr.fabric-testbed.net/help).

- **Connect via MCP** — one endpoint for every client
  (`…/functions/v1/teambrain-mcp/mcp`), authenticated with `Authorization:
  Bearer <JWT>`. It exposes six tools: `capture_project_thought`,
  `search_project_thoughts`, `list_recent_project_thoughts`, `mark_stale`,
  `promote_to_docs`, and `ping`. Per-client config (Claude Code, Cursor,
  gemini-cli, Copilot/VS Code) → [`docs/getting-started.md`](docs/getting-started.md).
- **REST / OpenAPI alternative** — same backend, same access rules, same JWT,
  under `…/functions/v1/teambrain-rest`. For non-MCP clients (ChatGPT/OpenAI
  function calling, CI, custom agents). Spec at
  [`/openapi.yaml`](https://pr.fabric-testbed.net/openapi.yaml); copy-paste
  recipes in [`examples/curl.md`](examples/curl.md); worked client
  [`examples/openai_function_calling.py`](examples/openai_function_calling.py).
- **Capture surfaces:**
  - **Slash commands** (Claude Code + Codex): `/tb-remember`, `/tb-recall`,
    `/tb-recent` — thin prompt templates over the connected MCP. Install via the
    `get_client_commands` MCP tool, `install.sh`, or the manifest →
    [`examples/slash-commands/README.md`](examples/slash-commands/README.md),
    [`install/README.md`](install/README.md).
  - **Slack `/tb` bot** (shipped server-side; awaiting the FABRIC Slack-app
    install): `remember` / `recall` / `recent` / `status` / `link` / `help`, one
    channel ↔ one project → [`examples/slack/README.md`](examples/slack/README.md).
  - **Capture-on-merge GitHub Action** — a merged PR proposes 0–3 memories via a
    server-side LLM behind an event-driven, human-`/approve` issue gate (no idle
    runner, no timer; PR metadata only, never diffs) →
    [`docs/capture-on-merge-adoption.md`](docs/capture-on-merge-adoption.md),
    [`examples/github-actions/capture-on-merge.yml`](examples/github-actions/capture-on-merge.yml).
  - **Non-interactive API tokens** — opaque long-lived `tbk_` tokens
    (capability-fenced to capture + read) exchanged for short-lived JWTs, for
    CI/automation that can't do an interactive login →
    [`examples/curl.md`](examples/curl.md).

**Where memory lives — the hybrid model.** TeamBrain holds *living*,
cross-developer notes (in-flight gotchas, decisions still being validated);
*settled* knowledge belongs in the repo (`AGENTS.md`, `.claude/`, `docs/adr/`).
The governance loop is `promote_to_docs`, which opens a real ADR/docs PR from a
stabilized memory — so TeamBrain never becomes a second competing source of
truth.

## Deployment

Self-hosted on a team-owned VM. The conceptual topology reference is
[`docs/deployment.md`](docs/deployment.md); the step-by-step operational runbook
(with verification at each step) is
[`deploy/production/README.md`](deploy/production/README.md).

- **Stack** — self-hosted [Supabase docker-compose](https://github.com/supabase/supabase/tree/master/docker)
  (pinned, not `:latest`): Postgres 17 + pgvector, GoTrue (GitHub OAuth),
  PostgREST, Edge Functions (Deno), Studio, Kong. → [`docs/deployment.md`](docs/deployment.md)
- **Deploy target** — a FABRIC team-owned VMware VM at `pr.fabric-testbed.net`,
  running as the `nrig-service` service account with sibling layout
  `~/supabase-stack/` + `~/TeamBrain/`. → [`deploy/production/README.md`](deploy/production/README.md)
- **TLS — "Path B"**: compose-managed nginx terminating with the institutional
  **InCommon/UNC SAN cert**, renewed out-of-band — **not** Let's Encrypt. →
  [`deploy/production/README.md`](deploy/production/README.md)
- **Nine edge functions** (`edge-functions/`), deployed by rsync into
  `volumes/functions/<name>/`:

  | Function | Purpose |
  |---|---|
  | `teambrain-mcp` | MCP/JSON-RPC server — the six primary tools (primary transport) |
  | `teambrain-rest` | HTTP/JSON mirror of the same tools (OpenAPI surface) |
  | `teambrain-membership-sync` | Reconcile `project_members` against GitHub collaborators/teams |
  | `teambrain-register-project` | Self-service repo→project registration (repo-admin gated) |
  | `teambrain-token` | Long-lived `tbk_` API token issue / list / revoke + JWT exchange |
  | `teambrain-summarize` | Server-side LLM that proposes memories from PR metadata |
  | `teambrain-slack` | `/tb` Slack slash command, channel↔project scoped |
  | `teambrain-staleness` | Commit-triggered staleness scan + health |
  | `teambrain-console` | `/repos` dashboard backend (onboarding, status, setup PRs, capture toggle) |

- **Migrations** applied via the **Studio SQL editor** (runs as `supabase_admin`,
  the correct DDL identity — `psql -U postgres` is *not* superuser and DDL fails
  confusingly). Apply order `0001`→`0026`. → [`migrations/README.md`](migrations/README.md)
- **Environment / secrets** — `.env` (gitignored); must-edit values documented in
  [`deploy/production/env.template`](deploy/production/env.template); TeamBrain
  env passthrough lives in `docker-compose.override.yml`.
- **Type-check before every deploy** — the Edge Runtime does **no** type-check, so
  a TS error reaches prod silently; run `scripts/deno-check.sh [fn...]` first.

## Architecture

- **Auth** — GitHub OAuth via GoTrue. `project_members` is reconciled against
  GitHub collaborators / org-teams by an org-scoped GitHub App on a 15-min
  `pg_cron` schedule; project registration is gated on the caller's GitHub
  repo-admin permission. Non-interactive callers exchange a long-lived opaque API
  token for a short-lived JWT. The same App carries Contents + Pull-requests +
  Workflows write, backing `promote_to_docs`' ADR/docs PRs and the console's
  setup PRs. (CILogon OIDC is supported by GoTrue and reserved for a later phase.)
- **Embeddings** — OpenAI `text-embedding-3-small` (1536-dim) in production,
  model-tagged per row so a provider swap is scoped at re-embed; a 768-dim
  Ollama/self-host variant is retained ready-to-use (`migrations/0005`).
- **Transport** — one backend, two thin custom edge functions (`teambrain-mcp`
  and `teambrain-rest`) exposing the same tools. PostgREST stays available under
  the hood but is intentionally not the documented surface. Adding a new AI
  client is a config entry, not adapter code.
- **Web UI** (static, nginx-served): `/` (landing + MCP setup), `/dashboard`
  (your RLS-scoped activity heatmap), `/repos` (onboarding + per-repo status +
  one-click setup PRs), `/help` (public usage guide). All have the public
  `ANON_KEY` injected via nginx `sub_filter`.

The locked-in decisions and rationale are in
[`docs/adr/0001-teambrain-architecture.md`](docs/adr/0001-teambrain-architecture.md).

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/getting-started.md`](docs/getting-started.md) | End-user onboarding: connect a tool, first capture |
| [`/help`](https://pr.fabric-testbed.net/help) | Live public usage guide, personalized when signed in |
| [`docs/deployment.md`](docs/deployment.md) | Deploy topology, stack, env, embedding-provider reference |
| [`deploy/production/README.md`](deploy/production/README.md) | Step-by-step production deploy runbook |
| [`migrations/README.md`](migrations/README.md) | Migration apply order + production-only gating |
| [`docs/capture-on-merge-adoption.md`](docs/capture-on-merge-adoption.md) | Add PR-merge auto-capture to your repo |
| [`examples/`](examples/) | curl recipes, OpenAI client, Slack/slash-command/Action setup |
| [`docs/development/README.md`](docs/development/README.md) | **Development history & provenance** (phased build record) |
| [`docs/adr/0001-teambrain-architecture.md`](docs/adr/0001-teambrain-architecture.md) | Locked-in architecture decisions |
| [`CLAUDE.md`](CLAUDE.md) | Current implementation state, conventions, gotchas |

## Relationship to OB1

TeamBrain ports two architectural patterns from [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1)
— the RLS scope policies and the shared-MCP edge-function pattern — but is a
**parallel repo, not a fork**. The parallel-repo choice (rather than forking
OB1's FSL-1.1-MIT) kept the license open. See [`CREDITS.md`](CREDITS.md) for the
acknowledgement and [`docs/adr/0001-teambrain-architecture.md`](docs/adr/0001-teambrain-architecture.md)
for the rationale.

## License

[Apache License 2.0](LICENSE) — permissive, with an explicit patent grant.
