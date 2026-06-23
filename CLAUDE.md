# TeamBrain

## What this is
Multi-tenant, project-scoped, AI-agnostic shared memory for dev teams. Read/write via **MCP** (primary) and a parallel **REST/OpenAPI** surface. Live at `https://pr.fabric-testbed.net`. Phases 0–6 shipped (only Phase 6 § E, migration-baseline consolidation, deferred to cutover). Detailed history & provenance: `docs/development/` (phased build record + per-phase `phase-*-checklist.md`).

## Pilot / evaluation
Phase 7 evaluation pilot repo is `fabric-testbed/fabric-core-api` (refactor done solo by Michael with Claude Code; **Komal Thareja — GitHub `kthare10` — is primary reviewer**). The value under test is **multi-developer commentary on a single-committer's changes**, not multi-committer coordination. Falsification target: every review comment that triggers a "we already discussed this" response is a TeamBrain miss. A live second-developer proof already exists on `fabric-testbed/loomai-dev` (Komal's repo, running capture-on-merge in production); adoption guide `docs/capture-on-merge-adoption.md`.

## Stack
Self-hosted Supabase docker-compose: Postgres 17 + pgvector, GoTrue (GitHub OAuth), PostgREST, Edge Functions (Deno), Studio, Kong. Nine edge functions under `edge-functions/`: `teambrain-{mcp,rest,membership-sync,register-project,token,summarize,slack,staleness,console}`. Deploy target: team VMware VM, nginx TLS (Path B in `deploy/production/`). Embeddings: OpenAI `text-embedding-3-small` (1536d), model-tagged; 768d Ollama variant via `migrations/0005`. Web UI (static, nginx-served `deploy/production/nginx/html/`): `/` landing, `/dashboard` activity, `/repos` per-repo onboarding+status console (backed by `repo_status_*` RPCs in `migrations/0024` + `teambrain-console`), `/help` public usage docs (connect/slash/Slack, personalized snippets — no auth gate).

## Conventions
- Parallel repo to OB1, **not a fork** — the parallel-repo choice kept licensing open (OB1 is FSL-1.1-MIT, which bars commercial derivatives), so TeamBrain ships under **Apache-2.0** (`LICENSE`); ports RLS + shared-MCP patterns only. Attribution in `CREDITS.md`.
- Two read-only reference forks, kept current via `gh repo sync mjstealey/{OB1,supabase}`. Never edit them — copy snippets in with attribution.
- Hybrid storage: stable knowledge → repo (`AGENTS.md`, `.claude/`, `docs/adr/`) via `promote_to_docs` PR; in-flight notes → TeamBrain.
- Capture cross-project decisions to personal Open Brain MCP with prefix `PROJECT: TeamBrain — `.
- Slash commands committed per-tool: `.claude/commands/`, Codex skills `.agents/skills/tb-*/`.

## Commands
- Type-check edge functions before any deploy: `scripts/deno-check.sh [fn...]` (throwaway Deno container; no local install).
- Apply migrations via **Studio SQL editor** — runs as `supabase_admin`. `psql -U postgres` is NOT superuser and DDL fails confusingly; or `psql -U supabase_admin`.
- nginx config: edit repo conf → `git pull` on box → `docker exec supabase-nginx nginx -t && docker exec supabase-nginx nginx -s reload`.
- OpenAPI spec lint: `openapi-spec-validator` (served at `/openapi.yaml`).
- No unified build/test suite. Don't invent commands — ask if uncertain.

## Gotchas
- TLS cert is the institutional **InCommon/UNC SAN cert** renewed out-of-band, NOT Let's Encrypt; cert lives at `/etc/nginx/cert/` in the nginx container.
- `pr.fabric-testbed.net` box expects sibling layout `~/supabase-stack/` + `~/TeamBrain/`; nginx overlay bind-mounts `../TeamBrain/deploy/production/nginx/conf.d`.
- Edge Runtime ships `volumes/functions/` with NO type-check — a TS error reaches prod silently. Hence `deno-check.sh`.
- GitHub Action capture-on-merge gate is **event-driven** (no blocking runner, no timer): the merge opens a `teambrain-capture` approval issue and exits; an approver's `/approve` comment triggers a separate `issue_comment` job that writes the captures. Replaced the old `trstringer/manual-approval` blocking gate, which idled runners for up to 6 h. See `examples/github-actions/capture-on-merge.yml`.
- Slack app: signing-secret-only (no bot token); webhook JWT injected by nginx on that path. Migration `0023` maps channels→projects.

## Don't
- Touch Michael's personal OB1 Supabase project (`ncldmtgyyikclljevpkm`).
- Run MCP as stdio-local — must be remote HTTP edge function.
- Commit secrets — use `.env` (gitignored), document in `.env.template`.
- Write `DROP TABLE/DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM` in SQL.
