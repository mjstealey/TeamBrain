<!-- UNTESTED — pending a Cursor account to smoke-test. Mirrors the Claude Code / Codex
     commands; the prose is client-neutral but has NOT been run in Cursor yet. Verify
     before relying on it. See ../README.md. -->

# /tb-remember — capture a memory to TeamBrain

Capture a TeamBrain memory on the human's explicit request, using the connected
`teambrain` MCP server (see AGENTS.md → "How to connect"). If its tools aren't available,
say so and stop — don't write any other way.

Determine `project_slug` first: run `git remote get-url origin` and convert the URL to
`owner/repo` (strip the `git@github.com:` / `https://github.com/` prefix and the trailing
`.git`). Pass that slug on every call. If it isn't a GitHub owner/repo, ask for the slug.

Memory to capture: the text the human passed with this command.

Then:
1. Dedup — call `search_project_thoughts` (threshold ~0.3, limit 5, the slug). If a
   near-duplicate exists, show it and ask before writing; don't silently double-write.
2. Otherwise call `capture_project_thought` with: `project_slug`; `content` (describe the
   *why*, not a code dump); `type` ∈ decision|convention|gotcha|context|preference|runbook;
   `scope` `project` by default (`personal`/`project_private` only if the human said so);
   `tags` including `slash-capture`; `paths` if clear.
3. Report the new `id`, `type`, `scope`.

Capture conventions (AGENTS.md): keep decisions/conventions/gotchas/context; skip WIP
obvious from the diff, secrets/PII, and verbatim code. When unsure, ask rather than
over-capture.
