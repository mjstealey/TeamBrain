---
name: tb-recent
description: List the most recent TeamBrain memories for this project (the team's shared MCP memory), newest first, to skim recent activity before planning or review. Trigger when the user asks what's been captured or what's been happening lately. Do NOT trigger for semantic search (use tb-recall) or to write memories (use tb-remember).
---

Show recent activity from the connected `teambrain` MCP server (see `AGENTS.md`). If its
tools aren't available, say so and stop.

Steps:

1. Determine `project_slug`: run `git remote get-url origin` → `owner/repo` (strip the
   `git@github.com:` / `https://github.com/` prefix and the trailing `.git`). If it isn't a
   GitHub owner/repo, ask for the slug.
2. If the user gave a number, use it as the row limit (cap 100); otherwise default to 20.
3. Call `list_recent_project_thoughts` (the slug, the limit; newest first — no semantic
   ranking; pair with tb-recall for relevance).
4. Present newest-first: `created_at` (date), `type`, `scope`, a one-line gist, and `id`.
   Flag any row with `stale_flagged_at` set as needing re-verification.
