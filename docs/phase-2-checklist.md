# Phase 2 Checklist

Concrete, ordered tasks for Phase 2 — port OB1's `shared-mcp` edge function pattern into a multi-tenant TeamBrain MCP server, and prove it works end-to-end from a real MCP client (Claude Code) against the scratch instance. Each item has an explicit **Done when** acceptance criterion.

Phase 2 entry preconditions (from `docs/phase-1-checklist.md` § G):

- ✅ `migrations/0001_init.sql` applied; tables/types/indexes verified.
- ✅ `migrations/0002_rls.sql` applied; RLS enabled; policies + helpers in `app` schema.
- ✅ `migrations/0003_disable_graphql.sql` applied; pg_graphql extension dropped.
- ✅ `migrations/seed.sql` applied; Michael seeded as admin of fabric-core-api.
- ✅ E3 RLS isolation matrix passes — non-member sees 0 rows, non-member insert raises `42501`.

If any are not green, finish Phase 1 first. Phase 2 assumes the schema + RLS surface is locked in and the edge function only needs to forward an authenticated request to PostgREST/SQL with the user's JWT.

---

## Architectural shape (the one-pager)

The TeamBrain MCP server is a single Supabase Edge Function (Deno runtime) deployed at `/functions/v1/teambrain-mcp`. It is **multi-tenant by being authentication-passthrough**:

1. The MCP client (Claude Code, Cursor, gemini-cli) sends each tool call with a GitHub-OAuth-derived JWT in the `Authorization: Bearer <jwt>` header.
2. The edge function instantiates a `supabase-js` client using the **anon key** as the API key and forwards the user's JWT in the `Authorization` header. Every query runs as the calling user.
3. Postgres RLS does the actual authorization. The edge function performs **zero application-layer access checks** — that is the design payoff of getting Phase 1 right.
4. Tool calls map roughly 1:1 to PostgREST queries or RPC calls. The edge function's job is request shape translation (MCP tool args → SQL/REST) and embedding generation, not business logic.

This is the divergence from OB1's `shared-mcp` pattern. OB1's shared server uses one fixed `service_role`-equivalent key and gates by URL path. TeamBrain uses a single per-request user JWT and gates by RLS. Same Hono/MCP-SDK skeleton, fundamentally different auth model.

---

## A — Decisions to lock before coding

### A1. Embedding provider & model

OpenAI `text-embedding-3-small` (1536 dims) — matches `thoughts.embedding vector(1536)` exactly. `OPENAI_API_KEY` was already set in `~/scratch/supabase-stack/.env` during Phase 0 D3 (the supabase-stack default mentions "consumed by Studio's AI Assistant"; we now repurpose it for our edge function).

Fallback alternatives if OpenAI access becomes a problem:
- **Local ollama / nomic-embed-text** (768 dims) — would require a schema migration to widen the column. Defer unless OpenAI is blocked.
- **Self-hosted bge-small-en** via FastAPI sidecar — same caveat.

**Done when:** `OPENAI_API_KEY` is confirmed valid (test via `curl https://api.openai.com/v1/embeddings ...`), and `text-embedding-3-small` is the locked Phase 2 model.

### A2. JWT verification path

Self-hosted Supabase Edge Runtime supports per-function JWT verification via `supabase/functions/<fn>/deno.json` and the `verify_jwt` flag on deploy. We **enable** JWT verification at the gateway (Edge Runtime auto-rejects unsigned/expired tokens before the function body runs), then **forward** the validated JWT through to `supabase-js` so RLS can use `auth.uid()`.

Two clients inside the function:
- `userClient` — anon key + forwarded `Authorization` header. Used for every data query. RLS filters as the caller.
- `adminClient` (rare) — service_role key. Only used for operations that genuinely need to bypass RLS (e.g. resolving GitHub handle → user_id during membership flows). **Not used in Phase 2 tools.**

**Done when:** decision documented in the function's index.ts header comment; `verify_jwt = true` set on deploy.

### A3. Project resolution: how does the client name a project?

Tool calls take a `project_slug` string parameter (e.g. `"fabric-testbed/fabric-core-api"`), not a UUID. The edge function resolves slug → id via a `select id from public.projects where repo_slug = $1` lookup. Reasons:

- Slugs are what humans (and AI agents) already know — they match the GitHub URL.
- UUIDs in tool calls force the LLM to remember and reproduce 36-char strings, which it does poorly.
- The lookup goes through RLS, so an unauthenticated user discovering a project's UUID via a tool error is impossible — they only see projects they're a member of.

For convenience: tools default `project_slug` to a server-side env var `TEAMBRAIN_DEFAULT_PROJECT_SLUG` if unset, so a single-pilot deployment doesn't need every call to specify it. Phase 3 (auto-membership sync) reconsiders this.

**Done when:** decision captured in tool zod schemas as `project_slug: z.string().optional()`.

### A4. MCP transport

`StreamableHTTPTransport` from `@hono/mcp` (per OB1 pattern). It handles both single-shot JSON-RPC and SSE streaming over a single `POST /mcp` endpoint. Compatible with Claude Code, Cursor, and gemini-cli MCP clients out of the box.

**Done when:** locked.

### A5. Edge function file layout

Self-hosted Supabase mounts `~/scratch/supabase-stack/volumes/functions/<name>/index.ts` into the Edge Runtime container. The path matters — function name in the URL = directory name on disk.

```
~/scratch/supabase-stack/volumes/functions/
  teambrain-mcp/
    index.ts           # entry point
    deno.json          # imports, deno tasks
    embedding.ts       # OpenAI wrapper
    tools/
      capture.ts
      search.ts
      list.ts
      mark_stale.ts
      promote.ts
```

Source-of-truth lives in the TeamBrain repo at `edge-functions/teambrain-mcp/` and is symlinked or rsynced into the scratch volume on deploy. The repo is the canonical version; the scratch path is generated artifact.

**Done when:** repo dir `edge-functions/teambrain-mcp/` exists; sync method to the scratch volume documented (rsync vs. symlink).

---

## B — `migrations/0004_match_thoughts.sql` — semantic search RPC

OB1's `match_thoughts(query_embedding, threshold, count, filter)` function is single-tenant. We need a project-scoped variant that respects RLS — meaning it runs as `security invoker` and lets the caller's policies on `public.thoughts` filter the result set, rather than using `security definer` to bypass.

The function takes: `query_embedding vector(1536)`, `match_count int default 10`, `match_threshold float default 0.5`, `filter_project_id uuid default null`, `filter_scopes thought_scope[] default null`. Returns a row set: `id, content, scope, type, project_id, similarity, created_at, last_verified_at`.

It is `language sql`, `stable`, `set search_path = ''`, fully qualified references inside, and **`security invoker`** (so RLS on `public.thoughts` filters during the function call — the entire point of Phase 1's RLS work).

Grant `execute` to `authenticated` only. The function lives in `public` because it is a legitimate API surface (callable via PostgREST `/rest/v1/rpc/match_thoughts`) — unlike the `app.is_project_*` helpers, which are pure RLS-policy plumbing.

**Done when:** `migrations/0004_match_thoughts.sql` is written, applied via Studio, and the verification call succeeds:

```sql
-- Should return 0 rows on a fresh DB (no embeddings written yet) but no error.
select * from public.match_thoughts(
  query_embedding := array_fill(0.0, array[1536])::extensions.vector(1536),
  match_count := 5,
  match_threshold := 0.5
);
```

---

## C — Edge function scaffold

### C1. Repo layout + deno.json

Create `edge-functions/teambrain-mcp/` with:

- `index.ts` — Hono app, `POST /mcp` handler, MCP server setup, tool registration.
- `deno.json` — import map for `hono`, `@hono/mcp`, `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `zod`.
- `embedding.ts` — `embed(text: string): Promise<number[]>` wrapper around the OpenAI embeddings endpoint. Cache-friendly: hash input → memoize within a request lifecycle (cross-request cache is overkill for Phase 2 traffic).
- `tools/<tool>.ts` — one file per tool. Each exports `register(server, getUserClient)` so `index.ts` stays thin.

**Done when:** `deno cache index.ts` succeeds (no missing imports); `deno fmt --check` passes.

### C2. JWT forwarding pattern

`index.ts` constructs `userClient` per-request, never module-scope (each request has a different JWT):

```ts
function getUserClient(authHeader: string | null) {
  if (!authHeader) throw new Error('Unauthorized: missing Authorization header');
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );
}
```

The `Authorization` header is the user's GoTrue-issued JWT, validated by Edge Runtime before our handler runs (`verify_jwt = true`). `supabase-js` forwards it to PostgREST, which sets `request.jwt.claims` for RLS evaluation. `auth.uid()` returns the right UUID; RLS filters; we return rows.

**Done when:** a "ping" tool that returns `{ uid: <auth.uid()> }` correctly returns the calling user's UUID when invoked from `curl -H "Authorization: Bearer <michael-jwt>" .../functions/v1/teambrain-mcp`. This is the ground-truth wiring test before any business-logic tools are added.

---

## D — Tool: `capture_project_thought`

**Args (zod):**
- `content: string` (required) — the memory text.
- `scope: 'personal' | 'project' | 'project_private'` (default: `'project'` — most TeamBrain captures are project-scoped).
- `type: 'decision' | 'convention' | 'gotcha' | 'context' | 'preference' | 'runbook'` (optional).
- `project_slug: string` (optional; defaults to `TEAMBRAIN_DEFAULT_PROJECT_SLUG`). Required when `scope` is `'project'` or `'project_private'`.
- `tags: string[]` (optional, default `[]`).
- `paths: string[]` (optional, default `[]`) — file paths the thought relates to.
- `linked_commit_sha`, `linked_pr_url`, `linked_issue_url` (optional, default null).

**Flow:**
1. Embed `content` via `embedding.ts` → `vector(1536)`.
2. Resolve `project_slug` → `project_id` (skip when scope is personal).
3. Insert into `public.thoughts` via `userClient`. RLS verifies the caller is permitted to write at the requested scope (`thoughts_insert_self` policy: writer-only for project/project_private).
4. Return the inserted row's `id`, `scope`, `created_at`.

**Done when:** capturing a project-scoped thought from Claude Code via this tool produces a row in `public.thoughts` with `author_user_id = auth.uid()` and a non-null embedding.

---

## E — Tool: `search_project_thoughts`

**Args (zod):**
- `query: string` (required).
- `project_slug: string` (optional; defaults to env).
- `scopes: ('personal' | 'project' | 'project_private')[]` (optional; defaults to all three the caller can read).
- `limit: number` (default 10, max 50).
- `threshold: number` (default 0.5).

**Flow:**
1. Embed `query`.
2. Resolve project_slug → project_id (or pass null for personal-only search).
3. RPC `public.match_thoughts(...)` via `userClient`. RLS on `thoughts` filters automatically — the function is `security invoker`.
4. Return ranked results (id, content snippet, similarity, scope, type, last_verified_at).

**Done when:** querying a known phrase from a captured project thought returns it as the top result; querying as a non-member returns zero results (RLS-enforced through the RPC).

---

## F — Tool: `list_recent_project_thoughts`

Plain recency listing — no embedding cost.

**Args:** `project_slug?`, `scopes?`, `limit (default 20, max 100)`, `since?: string` (ISO timestamp).

**Flow:** `userClient.from('thoughts').select(...).order('created_at', desc).limit(...)`. RLS filters.

**Done when:** returns the latest N thoughts the caller can see, ordered newest-first.

---

## G — Tool: `mark_stale`

**Args:** `thought_id: string (uuid)`, `reason?: string`, `confidence?: 'tentative' | 'deprecated'` (default `'deprecated'`).

**Flow:** `update public.thoughts set confidence = $1, last_verified_at = now() where id = $2`. RLS gates the update via `thoughts_update_self_or_writer`. If the caller can't update (not author, not writer), they get a zero-rows update — return `{ updated: false, reason: 'not authorized or not found' }` rather than leaking which.

**Done when:** marking a thought stale flips `confidence` and bumps `last_verified_at`; attempting to mark another user's personal thought stale returns `updated: false`.

---

## H — Tool: `promote_to_docs`

Phase 6 will fully implement promotion (generates an ADR/docs PR via GitHub API). For Phase 2, this tool is a **structured emit** placeholder: it takes a thought id, validates the caller can read it, and returns a payload shaped like the future PR-generation request — but does not call GitHub.

**Args:** `thought_id`, `target_path?: string` (e.g. `docs/adr/`), `target_branch?: string` (default `main`).

**Flow:** select the thought via userClient (RLS gates read), shape a payload `{ thought_id, content, scope, project_slug, target_path, target_branch, status: 'preview' }`, return it as the tool result. The MCP client surfaces it to the user as "here's what I would have promoted; not yet wired".

**Done when:** the tool returns the preview payload for any thought the caller can read, and a clear error for thoughts they can't.

---

## I — Smoke test (curl-based, transitive non-member proof)

The Phase 2 acceptance gate is the curl-based per-tool matrix that exercises the 5 tools end-to-end with Michael's real GoTrue-issued JWT. All five passed during build:

| # | Tool | Outcome |
|---|---|---|
| C2 | `ping` | returned `auth.uid() = 20fb97c9-…` matching Phase 1 Q1 |
| D  | `capture_project_thought` | inserted a row with embedding_dims=1536; Studio confirms `embedding is not null` |
| E  | `search_project_thoughts` | returned that row with similarity ≈ 0.71 |
| F  | `list_recent_project_thoughts` | count=3 in fabric-core-api (capture row + 2 B3 project rows; personal row correctly excluded) |
| G  | `mark_stale` | flipped `confidence` to `deprecated` and bumped `last_verified_at` |
| H  | `promote_to_docs` | returned a preview payload with ADR-style markdown; the markdown's "last verified" reflected G's update — proves chain consistency |

### Non-member isolation: transitively proven, not re-tested at MCP layer

The Phase 1 § E3 RLS isolation matrix proved that:

- A `set local request.jwt.claims to '{"sub":"<fake-uuid>"}'` impersonation returns 0 rows from `public.thoughts where 'b3-test' = any(tags)`.
- An insert as the same fake `sub` raises `42501: new row violates row-level security policy`.

The Phase 2 edge function adds **no application-layer access logic** — it forwards the validated JWT verbatim into supabase-js, which sets `Authorization` on PostgREST, which populates `request.jwt.claims`. Every tool reaches `public.thoughts` (or the `match_thoughts` RPC) through the same `userClient`, which means RLS evaluates against the caller's `auth.uid()` exactly as it did in E3.

The conjunction of E3's SQL-layer denial and the MCP layer's pure JWT-forward equals MCP-layer denial for non-members. Re-proving it directly would require either (a) a second GitHub OAuth account with no `project_members` row, or (b) a forged HS256 JWT with a fake `sub`. Both are mechanically equivalent to E3 with one additional transport hop and zero new failure modes; the test cost outweighs the marginal evidence. **Deferred unless a future change introduces application-layer authorization in the edge function** (none planned through Phase 6).

**Done:** the curl matrix in the table above passed during build. Phase 2 acceptance gate is met without re-running an MCP-layer non-member denial.

### Optional — register with Claude Code as a real MCP client

Not a Phase 2 gate, but a useful UX confirmation before Phase 3 work begins. Run when convenient:

```bash
claude mcp add --transport http teambrain https://127.0.0.1:8443/functions/v1/teambrain-mcp \
  --header "Authorization: Bearer <michael-jwt>"
```

`claude mcp list` should show `teambrain` connected; `/mcp` inside a Claude Code session should list the 5 tools. Capture one real thought from natural-language prompts to confirm the LLM can drive the surface as intended.

---

## J — `AGENTS.md` template for pilot repos

Phase 2 closes by producing a `docs/AGENTS.md.template` in the TeamBrain repo — a reference file that any pilot repo (starting with fabric-core-api) can copy as-is, then fill in the project-specific bits. The template contains:

1. **Server discovery:** `MCP_SERVER_URL: https://pr.fabric-testbed.net/functions/v1/teambrain-mcp` (or the scratch URL for pilot warm-up).
2. **Tool list with one-line descriptions** — same five from Phase 2.
3. **Capture conventions:** when to capture (decisions, gotchas, conventions), when to *not* (in-flight WIP debugging that will be obvious by review time).
4. **Promotion workflow:** memories that stabilize get promoted to repo docs via `promote_to_docs` → PR.
5. **Stale-flagging cadence:** mark contradicted memories stale immediately; never delete (loses provenance trail).

The actual commit of `AGENTS.md` and `.claude/CLAUDE.md` deltas into `~/github/fabric/fabric-core-api` is a separate task that lands during Phase 7 pilot kickoff — out of scope for this checklist.

**Done when:** `docs/AGENTS.md.template` exists in TeamBrain repo with the five sections above filled in.

---

## K — Docs + commit

### K1. Update `docs/deployment.md`

Add a "Phase 2 — Edge function deployment" section: how to sync `edge-functions/teambrain-mcp/` to `~/scratch/supabase-stack/volumes/functions/teambrain-mcp/`, how to set `OPENAI_API_KEY` and `TEAMBRAIN_DEFAULT_PROJECT_SLUG` in the docker stack's env, restart command (`docker compose restart functions`).

### K2. Commit

```bash
git add migrations/0004_match_thoughts.sql edge-functions/ docs/phase-2-checklist.md docs/AGENTS.md.template docs/deployment.md
git commit -m "Phase 2: multi-tenant MCP edge function + 5 tools + smoke-tested from Claude Code"
git push personal main
git push origin main   # if syncing canonical
```

**Done when:** commit pushed; `git status` clean.

---

## L — Phase 3 readiness gate

Before moving to Phase 3 (automated GitHub-collaborator membership sync):

- [x] B — `0004_match_thoughts.sql` applied; verification RPC call returns 0 rows without error.
- [x] C — `userClient` JWT forwarding verified end-to-end via the "ping" tool returning `auth.uid()`.
- [x] D–H — all 5 tools implemented and registered; curl-driven smoke test passes for each.
- [x] I — curl matrix passes; non-member isolation transitively established via Phase 1 § E3.
- [x] J — `docs/AGENTS.md.template` exists.
- [x] K — committed.

If green, Phase 3 (membership sync edge function: poll GitHub collaborator/team API → upsert `project_members` via `service_role`) can begin. The MCP server is then "complete from a transport perspective"; Phase 3+ is operational automation, not new transport surface.

---

## Notes for the next session

- Read order: `CLAUDE.md` → `docs/adr/0001-teambrain-architecture.md` → `docs/phase-1-checklist.md` (for schema context) → this file.
- The edge function is mounted from `~/scratch/supabase-stack/volumes/functions/teambrain-mcp/` — that path is local to scratch and not under git. Source of truth is `edge-functions/teambrain-mcp/` in this repo.
- All MCP tool calls go through PostgREST/SQL via the user's JWT — no `service_role` shortcuts in Phase 2 tools. If a tool needs admin escalation, pause and reconsider whether the schema is wrong.
- Decisions and blockers go to Open Brain with prefix `PROJECT: TeamBrain — `.
