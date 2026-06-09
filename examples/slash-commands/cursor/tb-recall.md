<!-- UNTESTED — pending a Cursor account to smoke-test. Mirrors the Claude Code / Codex
     commands; the prose is client-neutral but has NOT been run in Cursor yet. Verify
     before relying on it. See ../README.md. -->

# /tb-recall — search TeamBrain

Search the connected `teambrain` MCP server (see AGENTS.md) for memories relevant to the
human's query. If its tools aren't available, say so and stop.

Determine `project_slug`: run `git remote get-url origin` → `owner/repo` (strip the
`git@github.com:` / `https://github.com/` prefix and the trailing `.git`). If it isn't a
GitHub owner/repo, ask for the slug.

Query: the text the human passed with this command.

Then:
1. Call `search_project_thoughts` (query, slug, limit 10, threshold 0.3). If empty, retry
   once at threshold 0.2 before concluding there's no match.
2. Summarize hits: one-line gist + `type`/`scope`/`confidence`/`rank_score`/`id`, most
   relevant first; flag anything `deprecated` or with `stale_flagged_at` set.
3. If a hit answers the question, say so and cite its `id`.
