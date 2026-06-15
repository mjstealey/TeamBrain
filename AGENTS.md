# AGENTS.md — TeamBrain

Lightweight orientation for any AI agent (Claude Code, Cursor, gemini-cli,
Copilot, ChatGPT) working in **this** repo. Read once before your first
commit or comment.

> **This repo *is* TeamBrain** — the multi-tenant shared-memory service.
> We dogfood it: the running instance at **https://pr.fabric-testbed.net**
> stores the ephemeral, cross-session memory *about developing TeamBrain*.
> Deep project architecture, settled decisions, and hard boundaries live
> in `CLAUDE.md` (canonical, reviewed). This file is just the agent's
> orientation + how to reach the deployed instance.

## What goes where (storage model)

| Lives in the repo (canonical, reviewed, versioned) | Lives in TeamBrain (ephemeral, cross-session) |
|---|---|
| `CLAUDE.md`, `docs/adr/`, `docs/phase-*-checklist.md`, this file | In-flight decisions still being validated, gotchas, debugging notes, "why did we do X" context between sessions |

Promotion is the governance loop: a TeamBrain memory that stabilizes gets
promoted into the repo via PR. Don't paper over a wrong repo doc with a
TeamBrain memory — fix the doc.

**Open Brain split (deliberate):** Michael's *personal* Open Brain MCP
holds personal + cross-project planning. The *deployed TeamBrain* holds
team-relevant, project-scoped TeamBrain dev memory. Capture to the one
that fits; **do not double-write** the same memory to both.

## How to connect

The TeamBrain MCP server is a **remote HTTP MCP server** (no stdio, no
local Node):

```
URL:           https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp
Authorization: Bearer <your-github-oauth-jwt>
```

Get a JWT by signing in with GitHub at **https://pr.fabric-testbed.net/**
and copying the access token from the landing page. Tokens last 30 days; use
the **Renew** button there or sign in again when one expires.

### Claude Code

Positional `name` and `url` must come *before* the `--header` flag (it's
variadic and will otherwise swallow them):

```bash
claude mcp add --transport http teambrain \
  https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp \
  --header "Authorization: Bearer <jwt>"
```

### Codex

Codex registers remote MCP servers in `~/.codex/config.toml` (or a
project-scoped `.codex/config.toml`) as a streamable-HTTP server. The
bearer token is sourced from an environment variable *by name* — put the
variable's name in the config, never the token value itself:

```toml
# ~/.codex/config.toml
[mcp_servers.teambrain]
url = "https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp"
bearer_token_env_var = "TEAMBRAIN_JWT"
```

Then export your JWT in the shell before launching Codex (re-export when
the 30-day token expires):

```bash
export TEAMBRAIN_JWT='<jwt>'
codex
```

## Which `project_slug` to use

Every TeamBrain tool call is scoped by `project_slug`. For this repo:

```
fabric-testbed/TeamBrain
```

That's the repo's `owner/repo` — derive it from `git remote get-url origin`
if unsure. **Always pass it explicitly.** The server's global default
points at a *different* project (`fabric-testbed/fabric-core-api`), so
omitting `project_slug` here would read/write the wrong project. RLS still
prevents touching any project you're not a member of, but it can't stop a
mis-routed thought from landing in another project you *do* belong to.

## The tools at a glance

`ping` is a health check (no args). The five working tools:

| Tool | When to call it |
|---|---|
| `capture_project_thought` | You learned something about developing TeamBrain that the next session/agent should know. Decisions, conventions, gotchas, runbooks, context. |
| `search_project_thoughts` | Before answering a question that *could* have been decided before. Check for a "we already settled this" memory. |
| `list_recent_project_thoughts` | "What's been happening on TeamBrain lately?" Skim before planning. |
| `mark_stale` | A memory contradicted by current code or a recent decision. Flag it (don't delete — provenance matters). |
| `promote_to_docs` | A memory has stabilized and belongs in reviewed repo docs. **Opens a PR** adding a generated doc (type-aware default path — decisions→`docs/adr/`, runbooks→`docs/runbooks/`, context→`docs/context/`, else `docs/notes/`; override with `target_path`); review & merge to land it. Marks the memory `confirmed`. |

## Slash commands (optional)

Once the MCP server is connected, optional one-keystroke shortcuts wrap the capture/recall
tools: `/tb-remember <text>`, `/tb-recall <query>`, `/tb-recent [N]`. They're sugar over the
same MCP doorway, not a separate path. Claude Code commands are committed at
[`.claude/commands/`](.claude/commands/) and Codex skills at
[`.agents/skills/`](.agents/skills/) — both repo-discovered, no install. A copy-anywhere
Cursor template lives under [`examples/slash-commands/`](examples/slash-commands/); see its
[README](examples/slash-commands/README.md) for per-client install notes.

## Capture conventions

**Capture:** architecture/design decisions made on a branch; conventions
adopted; gotchas (deploy footguns, quoting traps, schema quirks);
cross-cutting context ("X depends on Y"); reviewer corrections that
generalize.

**Don't capture:** WIP obvious from the diff; secrets or PII; verbatim
code dumps (link the file/PR, describe the *why*).

**Scope:** `personal` (your notes only) · `project` (any member can read —
most captures) · `project_private` (sensitive in-flight work).

**Type taxonomy:** `decision | convention | gotcha | context | preference | runbook`

## Hard rules

- **Never bypass `auth.uid()`.** Don't paste service-role keys into a
  client. The MCP server is the only path that should write to TeamBrain.
- **No agent-on-agent recursion.** If a tool call fails, surface the error
  to the human; don't try to "fix it" by calling more tools.
- **Defer to `CLAUDE.md`** for architecture, settled decisions, and the
  hard boundaries (e.g. do not touch the personal OB1 Supabase project).

---

*This file is owned by humans. AI agents may suggest edits via PR but
should not silently rewrite it.*
