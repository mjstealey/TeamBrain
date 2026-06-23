# decision: **Decision (2026-06-09): stay with the OpenAI embedding provider; retain ollama 

> Promoted from TeamBrain thought `63041f3c-94db-4b2f-87cf-969b3626163c` on 2026-06-15T02:01:00.279Z.

## Content

**Decision (2026-06-09): stay with the OpenAI embedding provider; retain ollama as the documented future zero-egress option.** Resolves the "open" framing of `49b669c5`.

**Decision:** production keeps `EMBEDDING_PROVIDER=openai` / `text-embedding-3-small` / `vector(1536)` — the live config (every captured row tags `openai:text-embedding-3-small`). No switch to the ollama 768-dim path now.

**Tradeoff consciously accepted:** thought content embeds via OpenAI (egress to a third-party AI vendor), at odds with FABRIC's "no third-party AI vendor in the data path" aspiration. Accepted for the pilot phase. (Note: § C summarization already rides the FABRIC ai-renci gateway, which is itself OpenAI-backed — governance, not egress elimination.)

**Retained for future use (explicit ask from Michael):** the ollama / self-host 768-dim variant stays a documented, ready-to-use option — migration `0005`, `embedding.ts`'s ollama arm, and the compose override fragment are kept current and must survive the `v1_baseline` consolidation (Phase 6 § E). Two future paths:
- (a) **Lighter governance step, no re-embed:** point `OPENAI_BASE_URL` at the FABRIC ai-renci gateway so the key/billing is FABRIC-owned — only if it serves a 1536-dim model (else the `vector(1536)` column won't match). Stays OpenAI-backed.
- (b) **Full zero-egress self-host:** switch to ollama — apply `0005` (1536→768 nulls all embeddings) then re-embed every existing thought. For a fresh deployment, apply `0005` before the first capture (no re-embed).

**Doc reconciliation (PR #25):** `docs/deployment.md` + the override example had described production as the ollama 768 variant (the original ADR-0001 § Decision 5 plan); corrected to OpenAI 1536 as the default with ollama as the retained option. `docs/development/phase-6-checklist.md` § E + `migrations/README.md` now state `v1_baseline.sql` encodes the 1536 path and `0005` stays a standalone optional overlay (not folded in; the byte-identical baseline check excludes it). `CLAUDE.md` already correctly says "1536-dim OpenAI default in production; optional 768-dim Ollama variant via 0005."

## Provenance

- scope: `project`
- captured: 2026-06-09T17:24:46.738489+00:00
- paths: `docs/deployment.md`, `edge-functions/teambrain-mcp/embedding.ts`, `migrations/0005_resize_embedding_768.sql`, `docs/development/phase-6-checklist.md`, `edge-functions/teambrain-mcp/docker-compose.override.yml.example`
- tags: `decision`, `embedding-provider`, `openai`, `ollama`, `data-path`, `retained-option`, `phase-7`, `v1-baseline`
