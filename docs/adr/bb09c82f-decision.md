# decision: **Phase 5 § D — slash commands — shipped 2026-06-09.**

> Promoted from TeamBrain thought `bb09c82f-5968-4548-be15-675b8e54b346` on 2026-06-16T10:56:53.651Z.

## Content

**Phase 5 § D — slash commands — shipped 2026-06-09.**

One-keystroke interactive shortcuts over the **already-connected** `teambrain` MCP server. **No server-side change** — these are repo-committed *prompt templates* that drive the existing MCP tools; the MCP connection (per `AGENTS.md`) is the prerequisite.

**Commands (3 namespaced primitives):** `/tb-remember` (capture, search-first dedup), `/tb-recall` (search), `/tb-recent` (list recent). `mark_stale`/`promote_to_docs` deliberately excluded — low-frequency agent-judgment actions, better in prose than a hotkey (capture-discipline lesson from § C).

**Client scope (D‑D4, honoring "don't ship untested instructions"):**
- **Claude Code** — committed at `.claude/commands/{tb-remember,tb-recall,tb-recent}.md` (frontmatter `allowed-tools` + inline `` !`git remote get-url origin` `` slug injection). Tested.
- **Codex** — templates at `examples/slash-commands/codex/` → user copies to `~/.codex/prompts/` (home dir, NOT repo-auto-discovered; top-level `.md` only). Tested via copy-and-run.
- **Cursor** — templates at `examples/slash-commands/cursor/` (→ `.cursor/commands/`), **marked UNTESTED** pending a Cursor account (same gap that defers the AGENTS.md Cursor connect stanza, thought `5fc671cf`).

**`project_slug` (D‑D2):** auto-derived from `git remote get-url origin` → `owner/repo`, so the same file is copy-anywhere ("config, not code").

**Gotcha found + fixed:** the repo's `.gitignore` ignored all of `.claude/` (and `.codex/`) as machine-specific state, which would have silently dropped the committed Claude Code commands. Fixed by narrowing to `.claude/*` + `!.claude/commands/` — tracks shared commands, keeps `settings.local.json` local. (gitignore can't re-include a path under a fully-excluded *directory*; you must exclude the dir's *contents* with `/*` then negate the subdir.)

**Smoke:** this capture is itself the § D5 Claude-driven tool-path smoke — derived the slug from the origin remote, ran `search_project_thoughts` (dedup, no prior § D-shipped memory), then this `capture_project_thought` — the exact sequence `/tb-remember` drives. The `/`-keystroke confirmation in Claude Code + the Codex copy-and-run remain Michael-driven.

Adoption kit + per-client install: `examples/slash-commands/README.md`. Detail + Done-when: `docs/phase-5-checklist.md` § D. **Remaining in Phase 5: § B (Slack).**

## Provenance

- scope: `project`
- captured: 2026-06-09T16:28:08.533232+00:00
- paths: `.claude/commands/tb-remember.md`, `.claude/commands/tb-recall.md`, `.claude/commands/tb-recent.md`, `examples/slash-commands/README.md`, `docs/phase-5-checklist.md`, `.gitignore`
- tags: `phase-5`, `milestone`, `shipped`, `slash-commands`, `tb-remember`, `claude-code`, `codex`, `cursor`
