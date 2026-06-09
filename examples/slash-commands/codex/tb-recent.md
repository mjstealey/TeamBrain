---
description: List the most recent TeamBrain memories for this project
argument-hint: [optional max count, default 20]
---

Show recent activity from the connected `teambrain` MCP server (see AGENTS.md). If its
tools aren't available, say so and stop.

Determine `project_slug`: run `git remote get-url origin` → `owner/repo` (strip the
`git@github.com:` / `https://github.com/` prefix and the trailing `.git`). If it isn't a
GitHub owner/repo, ask for the slug.

Then:
1. Treat `$ARGUMENTS` as an optional row limit — a bare integer sets `limit` (cap 100);
   otherwise use the default 20.
2. Call `list_recent_project_thoughts` (slug, limit; newest first — no semantic ranking).
3. Present newest-first: `created_at` (date), `type`, `scope`, a one-line gist, and `id`.
   Flag any row with `stale_flagged_at` set as needing re-verification.
