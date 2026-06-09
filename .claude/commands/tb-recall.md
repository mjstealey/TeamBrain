---
description: Search TeamBrain for relevant memories (search_project_thoughts)
argument-hint: [what to look for]
allowed-tools: Bash(git remote get-url:*), mcp__teambrain__search_project_thoughts
---

Search the deployed TeamBrain for memories relevant to the human's query. Requires the
`teambrain` MCP server to be connected (see `AGENTS.md`); if its tools are unavailable,
say so and stop.

## Project scope

This repo's origin remote: !`git remote get-url origin`

Derive `project_slug` as `owner/repo` (strip the `git@github.com:` or
`https://github.com/` prefix and the trailing `.git`). If it isn't a GitHub `owner/repo`,
ask the human for the slug.

## Query

$ARGUMENTS

## Steps

1. Call `search_project_thoughts` with the query above, the derived `project_slug`,
   `limit` 10, `threshold` 0.3. If nothing comes back, retry once at `threshold` 0.2
   (the default is tight for the embedding model in use) before concluding there's no
   match.
2. Summarize the hits: for each, a one-line gist plus its `type`, `scope`, `confidence`,
   `rank_score`/`similarity`, and `id`. Lead with the most relevant. Call out anything
   `deprecated` or with `stale_flagged_at` set.
3. If a hit answers the human's question, say so plainly and cite its `id` — that's the
   "we already settled this" check before re-deciding something.
