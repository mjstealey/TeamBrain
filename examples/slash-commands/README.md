# TeamBrain slash commands

One-keystroke shortcuts for capturing and recalling TeamBrain memories from inside your AI
coding tool. They are thin **prompt templates** over the already-connected `teambrain` MCP
server — they add no new transport and carry no credentials.

> **Prerequisite — connect the MCP server first.** See [`AGENTS.md`](../../AGENTS.md) →
> "How to connect" (remote HTTP MCP at
> `https://pr.fabric-testbed.net/functions/v1/teambrain-mcp` + a GitHub-OAuth bearer JWT
> from the landing page). If the MCP isn't connected, the commands have nothing to call.

These commands are **optional sugar** over that canonical MCP doorway — they don't replace
it, and they're offered at parity across clients so no single tool is privileged.

## The commands

| Command | Wraps | What it does |
|---|---|---|
| `/tb-remember <text>` | `capture_project_thought` | Search-first dedup, then capture `<text>` (type inferred, `scope: project` default, tagged `slash-capture`). |
| `/tb-recall <query>` | `search_project_thoughts` | Semantic search; summarizes hits — the "did we already settle this?" check. |
| `/tb-recent [N]` | `list_recent_project_thoughts` | Newest-first list of the last N (default 20) memories. |

All three auto-detect `project_slug` from `git remote get-url origin` (`owner/repo`), so the
same file works in any registered repo. `mark_stale` and `promote_to_docs` are intentionally
**not** commands — they're deliberate, low-frequency actions better triggered in prose than a
hotkey.

## Install

### Claude Code &nbsp;✅ tested

Project-committed and auto-discovered. The working copies live in this repo at
[`.claude/commands/`](../../.claude/commands/). To use them in another repo, copy them into
that repo's `.claude/commands/`:

```bash
cp path/to/TeamBrain/.claude/commands/tb-*.md  your-repo/.claude/commands/
```

Then `/tb-remember`, `/tb-recall`, `/tb-recent` appear in the `/` menu. (Claude Code
pre-resolves the repo slug via an inline `` !`git remote get-url origin` `` step.)

### Codex &nbsp;✅ tested

Codex reads custom prompts from your **home** directory (`~/.codex/prompts/`) — not the repo
— and only top-level `.md` files. Copy the Codex variants there:

```bash
cp codex/tb-*.md  ~/.codex/prompts/
```

Restart Codex (or open a new chat) and the `/tb-*` prompts load. (OpenAI now nudges toward
"skills" over custom prompts, but custom prompts still work.)

### Cursor &nbsp;⚠️ untested

Cursor reads project commands from `.cursor/commands/`. The variants under [`cursor/`](cursor/)
mirror the others, but **have not been smoke-tested** — there's no Cursor account to verify
them against yet (the same gap that defers the Cursor entry in `AGENTS.md` → "How to connect").
Treat them as a starting point and verify before relying on them:

```bash
cp cursor/tb-*.md  your-repo/.cursor/commands/
```

## Notes

- Command bodies follow the capture conventions in `AGENTS.md`: capture decisions,
  conventions, gotchas, and cross-cutting context; skip WIP obvious from the diff, secrets/
  PII, and verbatim code dumps.
- Passing `project_slug` explicitly matters: the server's global default points at a
  *different* project, so each command derives the slug from the origin remote on every call.
