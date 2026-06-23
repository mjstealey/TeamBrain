# AGENTS.md — fabric-testbed/TeamBrain

Lightweight orientation for any AI agent (Claude Code, Cursor, gemini-cli,
Copilot, ChatGPT) working in this repo. Read once before your first commit
or comment.

## What TeamBrain is, in this repo's context

TeamBrain is a multi-tenant, project-scoped, AI-agnostic shared memory
service. It lives at **https://pr.fabric-testbed.net** and stores team knowledge that
isn't worth committing to the repo (yet) but is worth not losing:
in-flight debugging notes, recent decisions still being validated,
conventions, gotchas, cross-developer context.

This repo (`fabric-testbed/TeamBrain`) is registered as a TeamBrain project.
Any agent with a valid GitHub-OAuth-derived JWT for a member of this
project can read and write thoughts scoped to it.

## How to connect

The TeamBrain MCP server is reachable as a **remote HTTP MCP server**
(no stdio, no local Node, no per-developer config files):

```
URL:           https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp
Authorization: Bearer <your-github-oauth-jwt>
```

Each AI tool has its own way of registering remote MCP servers — see
that tool's docs. For **Claude Code**, the equivalent of:

```bash
claude mcp add --transport http teambrain https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp \
  --header "Authorization: Bearer <jwt>"
```

JWTs expire after 30 days. Re-grab from the OAuth round-trip when prompted.

## Slash commands & skills (optional)

One-keystroke shortcuts over the connected MCP — `/tb-remember <text>`,
`/tb-recall <query>`, `/tb-recent [N]` — committed as Claude Code commands
(`.claude/commands/`) and Codex skills (`.agents/skills/`): repo-discovered,
no install. They carry no credentials; they're sugar over the same MCP doorway.

If this repo doesn't have them yet, you don't need a TeamBrain checkout. Ask
your connected agent to *"install the TeamBrain slash commands"* — it calls the
`get_client_commands` MCP tool and writes the files into this repo — or run from
the repo root:

```bash
curl -fsSL https://pr.fabric-testbed.net/install.sh | sh
```

See **https://pr.fabric-testbed.net/help** → "Install into any repo" for per-client details.

## The 5 tools at a glance

| Tool | When to call it |
|---|---|
| `capture_project_thought` | You learned something about this repo that the next agent (or human) would benefit from knowing. Decisions, conventions, gotchas, runbooks, context. Embed it; future searches will find it. |
| `search_project_thoughts` | Before answering a question that *could* have been discussed before. Check for a "we already decided this" memory. Reduces "didn't we just talk about this?" reviewer comments. |
| `list_recent_project_thoughts` | "What's the team been thinking about lately?" Helpful to skim before a code review or planning session. |
| `mark_stale` | A memory you find is contradicted by current code or a recent decision. Don't delete (loses provenance) — flag it. The next searcher sees the deprecation. |
| `promote_to_docs` | A memory has stabilized and belongs in reviewed repo docs. **Opens a PR** adding a generated doc (type-aware default path — decisions→`docs/adr/`, else `docs/…`; override with `target_path`); review & merge to land it. Marks the memory `confirmed`. |

## Capture conventions

**Capture:**

- Architectural or design decisions made on this PR / branch.
- Conventions adopted (naming, error-handling style, layering rules).
- Gotchas: things that bit you that aren't yet documented here.
- Cross-cutting context: "X depends on Y; if Y changes, look at Z".
- Reviewer corrections that feel general (not just "fix this typo").

**Don't capture:**

- In-flight WIP debugging that will be obvious by review time. The PR
  diff already explains it.
- Anything secret or PII. RLS is enforced, but minimize blast radius.
- Verbatim code dumps. Paste a link to the file/PR; describe the *why*.

**Scope choice:**

| Scope | Use for |
|---|---|
| `personal`     | Notes only useful to you (your dev preferences, your TODOs). Default to this if unsure. |
| `project`      | Anything any project member should be able to read. Most captures land here. |
| `project_private` | Sensitive in-flight debugging, security workarounds, or in-progress decisions where readers (non-writers) shouldn't see yet. |

**Type taxonomy** (set whenever non-obvious):

`decision | convention | gotcha | context | preference | runbook`

## Promotion workflow

A memory that has been:

1. Validated by at least one reviewer comment ("yes, that's right"),
2. Stable across at least two PRs (no contradiction surfaced), and
3. General enough to be useful outside the immediate PR context

…should be **promoted** to repo docs via `promote_to_docs`. It opens a
PR adding a generated doc (type-aware default path — decisions→`docs/adr/`,
else `docs/…`; override with `target_path`) and marks the memory
`confirmed`; review and merge the PR to land it.

The promotion loop is the governance contract: TeamBrain holds
ephemeral, fast-moving knowledge; the repo holds curated, reviewed
canonical truth. Memories migrate from one to the other as confidence
grows.

## Stale-flagging cadence

When you encounter a memory that is contradicted by current code or
recent reviewer feedback:

1. **Mark it stale** with `mark_stale`, supplying a `reason` that
   names the contradicting source (PR number, commit SHA, reviewer name).
2. **Do not delete it.** The provenance trail matters — future agents
   should be able to see "this was once believed, then deprecated when
   X happened".
3. If the contradicting truth is itself stable, **capture a new memory**
   stating the new convention. Cross-link by including the deprecated
   memory's ID in the new memory's content.

## Hard rules

- **Never bypass `auth.uid()`.** Don't paste service-role keys into a
  client. The MCP server is the only path that should write to TeamBrain.
- **No agent-on-agent recursion.** If a tool call fails, surface the
  error to the human user. Don't try to "fix it" by calling more tools.
- **Capture before claiming.** If you tell the user "the convention is
  X", you should also have captured "X is the convention" — or be ready
  to capture a counter-claim if you're wrong.

## Pilot ownership

- **Project lead (commits + reviews):** mjstealey
- **Pilot reviewers:** paul-ruth, kthare10
- **TeamBrain ops:** report tool errors by opening an issue on the
  TeamBrain repo; https://pr.fabric-testbed.net/help has connection & usage docs.

---

*This file is owned by humans. AI agents may suggest edits via PR but
should not silently rewrite it.*

<!-- teambrain:agents-md-template v4 — bump on each meaningful template change; the /repos console flags repos whose committed AGENTS.md carries an older (or absent) version. Survives rendering (renderAgentsMd strips only the leading comment). -->

