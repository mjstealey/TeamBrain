# context: **TeamBrain status — 2026-06-09 (EOD). Supersedes the next-steps guidance in `b7

> Promoted from TeamBrain thought `a3d977b4-2982-446d-bd15-3d96d53f2222` on 2026-06-16T10:56:46.169Z.

## Content

**TeamBrain status — 2026-06-09 (EOD). Supersedes the next-steps guidance in `b793bb17` (2026-06-08, now stale-flagged) and consolidates `518c0395`.**

Phases 0–4 live on `pr.fabric-testbed.net`.

**Phase 5 (capture integrations):**
- § A (API token) — shipped 2026-05-29.
- § C (PR-merge capture, LLM-proposed + human-approved) — shipped 2026-05-30; verified still live: the capture-on-merge Action fired on the § D PR #23 merge and auto-captured `2136eee9`.
- § D (slash commands) — **shipped today** (PR #23, `main` @ `9f8aa2f`). `/tb-remember` / `/tb-recall` / `/tb-recent` over the connected MCP. Claude Code commands at `.claude/commands/`; Codex **skills** at `.agents/skills/` (custom prompts deprecated → skills, repo-discovered, no install); Cursor copy-anywhere template (untested, no account). Smoke confirmed in the wild: Codex `$tb-remember` (search-first dedup paused correctly on a near-dup), Claude Code `/tb-recall` + `/tb-recent`.
- **§ B (Slack bot, channel → project_id) — the only un-started Phase 5 item.** This is the next code work.

**Phase 6 (staleness & promotion):** § A–§ D shipped + prod-verified 2026-06-07. Only § E (migration-baseline consolidation into `v1_baseline.sql`) remains — deferred to production cutover, not a now-task.

**Phase 7 (pilot):** readiness gate **CLEARED** (`518c0395` / `7ad9c2ee` — Komal's buy-in met via active `fabric-testbed/loomai-dev` participation; reconciled into CLAUDE.md + `docs/phase-0-checklist.md` B1 on `main`). **No remaining hard prerequisites** — the pilot can begin whenever Michael chooses. Remaining roadmap work (§ B, Phase 6 § E) is additive, not gating.

**Open non-roadmap decision worth resolving before broadening the pilot — embedding provider (`49b669c5`):** production embeds with OpenAI `text-embedding-3-small` on Michael's *personal* key, egressing thought content to OpenAI — at odds with FABRIC's "no third-party AI vendor in the data path" posture. (Note: § C summarization already routes through the FABRIC ai-renci gateway, but that catalog is OpenAI-backed too — governance win, not egress elimination.) Options to weigh: FABRIC-owned key/gateway for embeddings vs. a self-hosted model (ollama/bge); a dim change would need a re-embed pass (embeddings are model-tagged, so scoping is possible). This is a real pre-Phase-7 decision, not a numbered roadmap item.

**Bottom line — next steps:** Phase 5 § B (Slack) is the only un-started code item; everything else is shipped, deferred to cutover (§ E), or unblocked-and-ready (Phase 7). The embedding-provider data-path question is the one open decision to settle before widening the pilot.

## Provenance

- scope: `project`
- captured: 2026-06-09T17:14:12.449426+00:00
- last verified: 2026-06-15T12:30:37.723+00:00
- paths: `docs/phase-5-checklist.md`, `CLAUDE.md`, `docs/phase-0-checklist.md`
- tags: `status`, `milestone`, `next-steps`, `phase-5`, `phase-6`, `phase-7`, `slash-commands`, `embedding-provider`
