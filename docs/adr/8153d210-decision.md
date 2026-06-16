# decision: **Phase 5 § C — PR-merge capture (LLM-proposed, human-approved) — shipped 2026-0

> Promoted from TeamBrain thought `8153d210-b598-4633-9ec0-55165bfacb49` on 2026-06-16T10:58:32.649Z.

## Content

**Phase 5 § C — PR-merge capture (LLM-proposed, human-approved) — shipped 2026-05-30.**

Deployed and end-to-end smoke-verified on `pr.fabric-testbed.net` + the `fabric-testbed/TeamBrain` dogfood repo. **Closes the Phase 6 readiness gate** (one working end-to-end capture path). First real consumer of the § A API token.

**Flow:** PR merge → `propose` job (gathers PR METADATA only — title/body/commit messages/changed-file paths, never diffs) → server-side `teambrain-summarize` edge function returns 0–3 capture proposals → issue-based human-approval gate → on `approved`, `capture` job writes them via `teambrain-rest` under the project bot's short-lived JWT.

**Key decisions:**
- **AI backend (C-D3):** FABRIC's LiteLLM gateway `ai-renci.fabric-testbed.net` (Anthropic `/v1/messages`-compatible), model `gpt-5.4-mini`. `summarize.ts` reads `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (Bearer); the code default stays Anthropic-direct for portability. **Egress finding:** the ai-renci catalog is OpenAI-backed (gpt-5.x, no self-hosted option), so this is a GOVERNANCE win (FABRIC-owned key/billing), NOT egress elimination — OpenAI is already in TeamBrain's path via the embedding provider. `embedding.ts` also gained an `OPENAI_BASE_URL` override to ride the same key (keep a 1536-dim model to avoid a schema migration).
- **Approval gate (C-D5):** native GitHub Environment required-reviewers are UNAVAILABLE on this private repo — `fabric-testbed` is on the Team plan but the API returns `422` (that rule needs Enterprise, or a public repo). Swapped to issue-based approval via `trstringer/manual-approval` (SHA-pinned v1.12.0). Approver defaults to the PR merger; override via repo var `TEAMBRAIN_APPROVERS`. Proposals render inline in the approval issue.
- **JWT lifetime (C-D1):** each job exchanges its own fresh 15-min JWT — a single mint can't span the human-approval wait.
- **Dedup (C-D7):** deterministic `owner/repo#N` tag scanned over recent thoughts (the REST read surface doesn't return `linked_pr_url`); skips the whole capture if the tag already exists.

**Smoke (PR #1 — gitignore `deno.lock`):** `propose` → 3 well-typed proposals (convention/context/gotcha) → `approved` → 3 captures landed under the bot, retrievable (search similarity 0.70–0.79); re-run wrote 0 duplicates (verified from the data — still exactly three `fabric-testbed/TeamBrain#1`-tagged thoughts).

**Open follow-ups (not blocking the pilot):** a `linked_pr_url` filter on `teambrain-rest GET /thoughts` would make dedup exact + serve Phase 6 staleness-by-PR; dedup-before-gate to avoid a pointless approval prompt on re-runs; `gpt-5.4-mini` leaned to the 3-proposal cap on a tiny PR (watch for noise / prompt-tune); the 6 pre-existing strict-TS errors in `teambrain-mcp/index.ts` (Supabase `data as {…}` casts) remain latent since the Edge Runtime doesn't type-check.

Commits: `b8fac12` (build), `faea62c` (gateway), `95c16b2` (issue gate), `1f9e266` (workflow in dogfood repo). Phase 5 § B (Slack) and § D (slash commands) remain.

## Provenance

- scope: `project`
- captured: 2026-05-31T01:28:05.823922+00:00
- paths: `edge-functions/teambrain-summarize/`, `examples/github-actions/capture-on-merge.yml`, `.github/workflows/capture-on-merge.yml`, `deploy/production/docker-compose.override.yml`, `deploy/production/nginx/html/openapi.yaml`, `examples/curl.md`, `docs/phase-5-checklist.md`, `edge-functions/teambrain-mcp/embedding.ts`
- tags: `phase-5`, `milestone`, `shipped`, `teambrain-summarize`, `capture-on-merge`, `github-actions`, `ai-renci`, `litellm`
