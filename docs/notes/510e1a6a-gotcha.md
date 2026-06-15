# gotcha: **Workflow gotcha — Claude's `Write` tool can leak `</content>` literals into la

> Promoted from TeamBrain thought `510e1a6a-e174-4f6b-a707-7254ad1f8d36` on 2026-06-15T12:32:09.470Z.

## Content

**Workflow gotcha — Claude's `Write` tool can leak `</content>` literals into large SQL files; tail-verify before applying.**

While building Phase 5 § A I wrote `migrations/0012_api_tokens.sql` (~330 lines) via Claude's `Write` tool. A literal `</content>` got appended at EOF — the tool's own `<parameter name="content">…</parameter>` wrapper bled through into the file content for that one call. Only that file out of several `Write` calls was affected; the cause was at the tool/LLM layer, not in the source SQL.

It was **invisible during `Read`-based review** (looks like a normal trailing line in the verification block). It only surfaced when `psql` parsed the file end-to-end on the production box:

```
ERROR:  syntax error at or near "</"
LINE 1: </content>
```

By then the rest of the transaction had already errored (cascaded `current transaction is aborted` messages) and rolled back. Embarrassing, but recoverable — nothing landed.

**Recommended habit when Claude (or any LLM-tool) writes a long-form file in this repo:**

```bash
tail -3 <path>                   # eyeball the EOF
grep -nE "</?content>" <path>    # scan for stray parameter-wrapper tags
```

Doing this immediately after `Write` (or as a pre-apply step for migrations) catches the case in seconds and would have avoided the round-trip to production. For SQL specifically, a local DB isn't required — a syntax scan is enough.

**Where this matters most:** migrations (transactional, applied via `docker exec psql` or Studio — both surface the same EOF error), edge-function source (won't break Deno runtime but pollutes the file), OpenAPI specs (would fail `openapi-spec-validator` with a YAML parse error similar to the case at line 926 of `openapi.yaml`, also caught during this session).

Both gotchas from this session — this one and [[postgres-any-subselect-array]] — are now also saved to Claude's auto-memory so they apply across sessions.

Fix landed in commit `88bb3ce`.

## Provenance

- scope: `project`
- captured: 2026-05-30T00:17:42.895756+00:00
- linked commit: `88bb3ce`
- paths: `migrations/`
- tags: `claude-code`, `migrations`, `workflow`, `gotcha`, `phase-5`
