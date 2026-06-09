---
name: tb-remember
description: Capture a memory to TeamBrain (the team's shared MCP memory) when the user explicitly asks to remember, save, or note a decision, convention, gotcha, or piece of context for this project. Do NOT trigger for general questions, code edits, or when the user only wants to recall existing memories (use tb-recall for that).
---

Capture a TeamBrain memory on the user's explicit request, using the connected
`teambrain` MCP server (see `AGENTS.md` → "How to connect"). If its tools aren't
available, say so and stop — don't write any other way.

The memory to capture is whatever the user asked to remember in their current request.

Steps:

1. Determine `project_slug`: run `git remote get-url origin` and convert the URL to
   `owner/repo` (strip the `git@github.com:` / `https://github.com/` prefix and the
   trailing `.git`). Pass it on every call. If it isn't a GitHub owner/repo, ask for the
   slug — a mis-routed thought can land in the wrong project.
2. Dedup — call `search_project_thoughts` (threshold ~0.3, limit 5, the slug). If a
   near-duplicate exists, show it and ask before writing; don't silently double-write.
3. Otherwise call `capture_project_thought` with: `project_slug`; `content` (the memory —
   describe the *why*, not a code dump); `type` ∈ decision|convention|gotcha|context|
   preference|runbook; `scope` `project` by default (`personal`/`project_private` only if
   the user said so); `tags` including `slash-capture`; `paths` if clear.
4. Report the new `id`, `type`, `scope`.

Capture conventions (`AGENTS.md`): keep decisions/conventions/gotchas/context; skip WIP
obvious from the diff, secrets/PII, and verbatim code. When unsure, ask rather than
over-capture.
