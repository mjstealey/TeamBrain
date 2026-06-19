# TeamBrain slash commands

One-keystroke shortcuts for capturing and recalling TeamBrain memories from inside your AI
coding tool. They are thin **prompt templates** over the already-connected `teambrain` MCP
server — they add no new transport and carry no credentials.

> **Prerequisite — connect the MCP server first.** See [`AGENTS.md`](../../AGENTS.md) →
> "How to connect" (remote HTTP MCP at
> `https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp` + a GitHub-OAuth bearer JWT
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

### From the deployment &nbsp;✅ no TeamBrain checkout needed

The fastest path when you've cloned a *registered* repo (not this one). The files are
pulled from this repo on `pr.fabric-testbed.net`, so there's nothing to clone or sync.

- **Ask your agent** (best): with the `teambrain` MCP connected, say *"install the
  TeamBrain slash commands"* — the **`get_client_commands`** MCP tool returns each
  file's destination path and content and the agent writes them in place.
- **One-liner**, from your repo root:
  ```bash
  curl -fsSL https://pr.fabric-testbed.net/install.sh | sh
  # scope / preview:
  curl -fsSL https://pr.fabric-testbed.net/install.sh | sh -s -- --client claude-code
  curl -fsSL https://pr.fabric-testbed.net/install.sh | sh -s -- --list
  ```
- **Manifest** for tooling: [`/install/manifest.json`](https://pr.fabric-testbed.net/install/manifest.json)
  (`{ client, src, dest }` per file). See [`install/README.md`](../../install/README.md).

The per-client sections below cover the layout and what each command does.

### Claude Code &nbsp;✅ tested

Project-committed and auto-discovered. The working copies live in this repo at
[`.claude/commands/`](../../.claude/commands/). To use them in another repo, copy them into
that repo's `.claude/commands/`:

```bash
cp path/to/TeamBrain/.claude/commands/tb-*.md  your-repo/.claude/commands/
```

Then `/tb-remember`, `/tb-recall`, `/tb-recent` appear in the `/` menu. (Claude Code
pre-resolves the repo slug via an inline `` !`git remote get-url origin` `` step.)

### Codex &nbsp;✅ committed as skills

Codex [**custom prompts are deprecated**](https://developers.openai.com/codex/custom-prompts)
in favor of [**skills**](https://developers.openai.com/codex/skills), which — unlike the old
`~/.codex/prompts/` files — are **discovered from the repo** (`$REPO_ROOT/.agents/skills/`),
so they're committed and shared like the Claude Code commands, with no per-developer install.

The skills live in this repo at [`.agents/skills/`](../../.agents/skills/) —
`tb-remember/`, `tb-recall/`, `tb-recent/`, each a directory with a `SKILL.md`. Open Codex
in this repo and invoke them with `/skills` (or by `$`-mentioning the name); Codex can also
trigger them implicitly from their `description`.

To use them in another repo, copy the skill directories into that repo's `.agents/skills/`
(or into `~/.agents/skills/` to make them available across all your repos):

```bash
cp -r path/to/TeamBrain/.agents/skills/tb-*  your-repo/.agents/skills/
```

Codex skills don't take a `$ARGUMENTS` placeholder the way custom prompts did — the skill is
instructions, and your surrounding message supplies the specifics (the text to remember, the
query to search). The bodies derive `project_slug` from `git remote get-url origin` in prose.

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
