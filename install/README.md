# Installing TeamBrain commands & skills into any repo

The TeamBrain slash commands (Claude Code), skills (Codex), and command templates
(Cursor) live in **this** repo, but you usually want them in a *different* repo —
the one you're actually working in. You don't need a TeamBrain checkout to get
them. They're credential-free prompt templates over the connected `teambrain` MCP
server, so **connect the MCP first** ([/help](https://pr.fabric-testbed.net/help))
or they have nothing to call.

There are three ways in, all sourced from this repo so there's nothing to keep in
sync:

## 1. Ask your agent (best)

If TeamBrain's MCP is connected, just say *"install the TeamBrain slash commands"*.
The **`get_client_commands`** MCP tool returns each file's destination path and
content; the agent writes them into the current repo. No URLs, no copying — this is
the path to reach for when an agent would otherwise go hunting through the TeamBrain
source.

```
get_client_commands(client: "claude-code" | "codex" | "cursor" | "all" = "all",
                    ref: string = "main")
```

## 2. One-liner installer

Run from your repo root:

```bash
curl -fsSL https://pr.fabric-testbed.net/install.sh | sh
# scope to one client / preview only:
curl -fsSL https://pr.fabric-testbed.net/install.sh | sh -s -- --client claude-code
curl -fsSL https://pr.fabric-testbed.net/install.sh | sh -s -- --list
```

`install.sh` 302-redirects to [`install-commands.sh`](install-commands.sh) in this
repo. It needs only `curl` and writes files to the git toplevel (override with
`--dest`).

## 3. Manifest (for tools / no-dependency fallback)

[`manifest.json`](manifest.json) is the machine-readable file list — `{ client,
src, dest }` per file — served at
[`/install/manifest.json`](https://pr.fabric-testbed.net/install/manifest.json).
Fetch it, then `curl` each `src` from the `raw_base` to its `dest`. This is also
what the `get_client_commands` tool reads.

## Where files land

| Client | Destination | Notes |
|---|---|---|
| Claude Code | `.claude/commands/tb-*.md` | Auto-discovered; `/tb-remember`, `/tb-recall`, `/tb-recent`. |
| Codex | `.agents/skills/tb-*/SKILL.md` | Repo-discovered; trigger with `/skills` or `$`-mention. |
| Cursor | `.cursor/commands/tb-*.md` | Community, untested — verify before relying on it. |

See [`examples/slash-commands/README.md`](../examples/slash-commands/README.md) for
what each command does and the per-client details.
