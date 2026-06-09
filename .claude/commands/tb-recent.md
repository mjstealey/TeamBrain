---
description: List the most recent TeamBrain memories for this project (list_recent_project_thoughts)
argument-hint: [optional max count, default 20]
allowed-tools: Bash(git remote get-url:*), mcp__teambrain__list_recent_project_thoughts
---

Show what's been happening in this project's TeamBrain lately. Requires the `teambrain`
MCP server to be connected (see `AGENTS.md`); if its tools are unavailable, say so and
stop.

## Project scope

This repo's origin remote: !`git remote get-url origin`

Derive `project_slug` as `owner/repo` (strip the `git@github.com:` or
`https://github.com/` prefix and the trailing `.git`). If it isn't a GitHub `owner/repo`,
ask the human for the slug.

## Steps

1. Treat `$ARGUMENTS` as an optional row limit — a bare integer sets `limit` (cap 100);
   anything else, ignore it and use the default 20.
2. Call `list_recent_project_thoughts` with the derived `project_slug` and that limit
   (newest first; no semantic ranking — pair with `/tb-recall` when you want relevance).
3. Present a compact, newest-first list: `created_at` (date), `type`, `scope`, a one-line
   gist, and `id`. Flag any row with `stale_flagged_at` set as needing re-verification.
