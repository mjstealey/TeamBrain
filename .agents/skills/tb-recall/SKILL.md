---
name: tb-recall
description: Search TeamBrain (the team's shared MCP memory) for existing memories relevant to the user's question, before answering something that may already have been decided. Trigger when the user asks to recall, search, or check what's been captured for this project. Do NOT trigger to write new memories (use tb-remember).
---

Search the connected `teambrain` MCP server (see `AGENTS.md`) for memories relevant to the
user's query. If its tools aren't available, say so and stop.

The query is the user's current request.

Steps:

1. Determine `project_slug`: run `git remote get-url origin` → `owner/repo` (strip the
   `git@github.com:` / `https://github.com/` prefix and the trailing `.git`). If it isn't a
   GitHub owner/repo, ask for the slug.
2. Call `search_project_thoughts` (the query, the slug, limit 10, threshold 0.3). If empty,
   retry once at threshold 0.2 before concluding there's no match.
3. Summarize hits: one-line gist + `type`/`scope`/`confidence`/`rank_score`/`id`, most
   relevant first; flag anything `deprecated` or with `stale_flagged_at` set.
4. If a hit answers the question, say so and cite its `id` — the "we already settled this"
   check.
