---
description: Capture a memory to TeamBrain (search-first dedup, then capture_project_thought)
argument-hint: [what to remember — a decision, gotcha, convention, or context note]
allowed-tools: Bash(git remote get-url:*), mcp__teambrain__search_project_thoughts, mcp__teambrain__capture_project_thought
---

You are capturing a TeamBrain memory on the human's explicit request. The deployed
TeamBrain MCP server must already be connected as `teambrain` (see `AGENTS.md` →
"How to connect"); if its tools are unavailable, say so and stop — do not try to
write any other way.

## Project scope

This repo's origin remote: !`git remote get-url origin`

Derive `project_slug` as `owner/repo` from that URL (strip any `git@github.com:` or
`https://github.com/` prefix and the trailing `.git`). Pass that `project_slug` on
every tool call below. If the remote is missing or isn't a GitHub `owner/repo`, ask
the human for the slug instead of guessing — a mis-routed thought can land in the
wrong project.

## What to capture

$ARGUMENTS

## Steps

1. **Dedup first.** Call `search_project_thoughts` with a concise query built from the
   text above (`threshold` ~0.3, `limit` 5, the derived `project_slug`). If a result
   looks like the same memory (high similarity, same subject), show it to the human and
   ask whether to (a) skip, (b) capture anyway, or (c) treat it as an update — do not
   silently double-write.
2. **Otherwise capture.** Call `capture_project_thought` with:
   - `project_slug`: the derived slug
   - `content`: the memory, lightly cleaned up — keep the human's meaning; describe the
     *why*, not a code dump
   - `type`: infer one of `decision | convention | gotcha | context | preference | runbook`
   - `scope`: `project` by default; use `personal` only if the human said it's just their
     own note, `project_private` only if they said it's sensitive in-flight work
   - `tags`: include `slash-capture`, plus any obvious topical tags
   - `paths`: any repo file paths the memory is about, if clear
3. **Confirm.** Report the new thought's `id`, `type`, and `scope` in one line.

Follow the capture conventions in `AGENTS.md`: capture decisions, conventions, gotchas,
and cross-cutting context the next session should know; do **not** capture WIP that's
obvious from the diff, secrets/PII, or verbatim code. When unsure whether something is
worth keeping, ask rather than over-capturing.
