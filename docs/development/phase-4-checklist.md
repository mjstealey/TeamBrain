# Phase 4 Checklist

Concrete, ordered tasks for Phase 4 — publish a **REST + OpenAPI surface** that mirrors the MCP tool set 1:1 over the same backend (same Postgres, same RLS, same GitHub-OAuth JWT), so non-MCP-native clients (curl, OpenAI function calling, GitHub Actions) can read and write TeamBrain memory. Each item has an explicit **Done when** acceptance criterion.

Phase 4 entry preconditions (from `docs/development/phase-3-checklist.md` § I and the current state of `main`):

- ✅ Phases 0–3 complete on `main`; `migrations/0001`–`0010` + `seed.sql` applied to production (`pr.fabric-testbed.net`).
- ✅ MCP edge function deployed; 6 tools register and round-trip cleanly (`ping`, `capture_project_thought`, `search_project_thoughts`, `list_recent_project_thoughts`, `mark_stale`, `promote_to_docs`).
- ✅ `public.match_thoughts(...)` RPC exposed via PostgREST (`SECURITY INVOKER`, RLS filters every candidate row before ranking).
- ✅ Self-service project registration shipped — this is where Phase 4 actually started: `migrations/0011_project_registration.sql` (drops the placeholder open-insert policy) + `edge-functions/teambrain-register-project/` (org gate + repo-admin gate via the GitHub App). Live and smoke-tested in production (registered `fabric-testbed/publication-tracker-dev`).
- ✅ `AGENTS.md` committed to the `publication-tracker-dev` pilot repo; validated against both Claude Code and Codex.

If any are not green, finish Phase 3 first. Phase 4 assumes a working multi-tenant MCP surface and only adds a parallel REST transport over it.

---

## Architectural shape (the one-pager)

The MCP edge function (`edge-functions/teambrain-mcp/`) already encapsulates every operation: it embeds text via `embedding.ts`, resolves a human-friendly `project_slug` to a UUID through RLS, and reads/writes `public.thoughts` with a per-request `userClient` (ANON_KEY + the caller's forwarded JWT) so RLS does **all** access control. Phase 4 exposes the same operations over plain HTTP/JSON.

The surface is a **single uniform edge function**, `teambrain-rest`, that mirrors the MCP tools 1:1 — *not* a PostgREST-hybrid.

**Why uniform-custom over PostgREST-hybrid (decision A1):** PostgREST *could* serve `list` (a select) and `mark_stale` (a patch) for free, and `match_thoughts` is already exposed as an RPC. But Phase 4's deliverable is a *published contract for LLM tool-callers and CI*, and PostgREST's auto-generated OpenAPI documents every table, column, and filter operator in its own query idiom (`?col=eq.val&select=…`, `Prefer:` headers). Mixing that with three hand-written endpoints (capture/search/promote, which need the OpenAI embedding call PostgREST can't make) yields two auth conventions, two error shapes, and a Frankenstein spec. A uniform `teambrain-rest` costs a little extra code for the list/mark_stale handlers but buys one coherent, slug-friendly, hand-authored OpenAPI. PostgREST stays available under the hood for admin/power use — it just isn't the *documented* surface.

`teambrain-rest` reuses `embedding.ts` from `teambrain-mcp` via a relative import (the same cross-function pattern `teambrain-register-project` uses to reuse `teambrain-membership-sync`). All functions are mounted under one Edge Runtime root, so the import resolves at runtime.

---

## A — Decisions to lock before coding

### A1. Surface architecture — *resolved: uniform custom `teambrain-rest` (not PostgREST-hybrid)*

Rationale in the one-pager above. PostgREST remains exposed (`PGRST_DB_SCHEMAS=public`) for ad-hoc/admin use but is omitted from the published OpenAPI.

**Done when:** this decision is recorded in the `teambrain-rest/index.ts` header and reflected in the OpenAPI (§C) describing only the custom endpoints + `register_project`.

### A2. `register_project` placement — *resolved: keep as its own function, document in the shared spec*

`teambrain-register-project` already ships and is deployed. Folding it into `teambrain-rest` would churn working, validated code for no functional gain. It stays its own function; the OpenAPI (§C) documents its endpoint alongside the `teambrain-rest` ones so clients see one surface.

**Done when:** `POST /functions/v1/teambrain-register-project/register` appears in `openapi.yaml` with request/response schemas; no code in `teambrain-register-project/` is moved.

### A3. GitHub Actions example auth — *resolved: illustrative only*

A GitHub Action has no interactive OAuth flow, so a real PR-merge capture needs a non-interactive credential (a long-lived PAT-style token). That mechanism is deferred (see § J). The Actions example references a `TEAMBRAIN_TOKEN` repo secret and carries a note that issuance is a future phase — it is not expected to run end-to-end in Phase 4.

**Done when:** `examples/github-actions/capture-on-merge.yml` exists, references `secrets.TEAMBRAIN_TOKEN`, and a comment block states the token mechanism is out of scope for Phase 4.

### A4. OpenAPI hosting — *resolved: static file via nginx*

The spec is served as a static file by the compose-managed nginx (Path B), at the same location block that already serves the landing page. No edge route, no auth on the spec itself (it's a public contract; it contains no secrets).

**Done when:** `https://pr.fabric-testbed.net/openapi.yaml` returns the spec with `200` and `content-type: application/yaml` (or `text/yaml`).

### A5. Code reuse — *resolved: import `embedding.ts`; duplicate the tiny auth helpers*

`teambrain-rest` imports `embed`, `vectorLiteral`, `currentEmbeddingModelTag` from `../teambrain-mcp/embedding.ts`. The ~10-line `jwtSub` and `resolveProjectId` helpers are duplicated rather than extracted to a `_shared/` module — consistent with the current codebase, where each function carries its own JWT decode (`teambrain-mcp`, `teambrain-membership-sync`, `teambrain-register-project` each have their own).

**Done when:** `teambrain-rest/index.ts` imports `embedding.ts` relatively and defines its own `jwtSub` / `resolveProjectId`; no new shared module is introduced.

### A6. Endpoint shape — *resolved*

| Method + path (under `/functions/v1/teambrain-rest`) | Mirrors MCP tool | Body / params |
|---|---|---|
| `GET /health` | `ping` | none → `{uid, visible_thought_rows}` |
| `POST /thoughts` | `capture_project_thought` | `content, scope, type?, project_slug?, tags?, paths?, linked_*?` → `201` |
| `POST /thoughts/search` | `search_project_thoughts` | `query, project_slug?, scopes?, limit?, threshold?, cross_project?` |
| `GET /thoughts` | `list_recent_project_thoughts` | query: `project_slug, scopes, limit, since, cross_project` |
| `PATCH /thoughts/{id}/stale` | `mark_stale` | `confidence?, reason?` |
| `POST /thoughts/{id}/promote` | `promote_to_docs` | `target_path?, target_branch?` (preview only) |

`POST` (not `GET`) for search so the natural-language query travels in the body. Auth on every route: `authenticated` user JWT; the per-request `userClient` carries the forwarded `Authorization`, so RLS gates reads/writes exactly as in MCP.

**Done when:** the table above is implemented in §B and each row has a passing smoke step in §F.

---

## B — Edge function: `edge-functions/teambrain-rest/`

Author the Hono app (`basePath('/teambrain-rest')`) with the six routes from A6, plus `deno.json` (mirroring `teambrain-mcp`'s import map). Each handler:

1. Resolves auth context (`jwtSub` + per-request `userClient` with ANON_KEY and forwarded `Authorization`); rejects missing/non-`authenticated` JWTs with `401`/`403`.
2. For capture/search: calls `embed()`; surfaces `EmbeddingError` as a `502`-class JSON error.
3. For project-scoped ops: `resolveProjectId(userClient, slug)`; an unresolvable/invisible slug returns `404` (RLS-consistent — never leaks existence).
4. Returns clean JSON (not the MCP `content[].text` envelope) with appropriate status codes.
5. A catch-all returns `404 {error: "no route: …"}`.

**Done when:** all six endpoints return correct JSON for the happy path and structured errors for the unhappy paths, verified by §F against production with a real user JWT.

---

## C — `openapi.yaml` (OpenAPI 3.1)

Hand-author the spec at repo root (or `deploy/production/nginx/html/openapi.yaml` for direct serving — see §D). Cover all six `teambrain-rest` endpoints + `register_project`. Include:

- `servers:` → `https://pr.fabric-testbed.net/functions/v1`
- `securitySchemes.bearerAuth` (HTTP bearer, JWT) applied globally.
- Component schemas: `Thought`, `CaptureRequest`, `SearchRequest`, `SearchResult`, `ListQuery`, `StaleRequest`, `StaleResult`, `PromoteRequest`, `PromotePreview`, `RegisterRequest`, `RegisterResult`, `Error`.
- Per-operation `summary`/`description` written for LLM function-calling consumers (concise, imperative; the `description` is what an OpenAI tool definition surfaces to the model).

**Done when:** the spec validates against an OpenAPI 3.1 linter, and the operation/schema names match the §B implementation exactly.

---

## D — nginx: serve `/openapi.yaml`

Add a `location = /openapi.yaml` to `deploy/production/nginx/templates/pr.fabric-testbed.net.conf.template` serving the file from the html root (place the spec in `deploy/production/nginx/html/`). Redeploy the nginx config + html into `~/supabase-stack/` (remember: the stack copies are **not** symlinks to the repo — see the deploy gotcha) and reload nginx.

**Done when:** `curl -sS https://pr.fabric-testbed.net/openapi.yaml | head` returns the spec; the landing page at `/` still works.

---

## E — `examples/`

- `examples/curl.md` — a recipe per endpoint (health, capture, search, list, stale, promote, register), each showing the `Authorization: Bearer <jwt>` header and a sample body/response.
- `examples/openai_function_calling.py` — derive OpenAI tool definitions from the OpenAPI for at least `search_project_thoughts` and `capture_project_thought`; show the round-trip (model emits a tool call → script calls the REST endpoint → result fed back).
- `examples/github-actions/capture-on-merge.yml` — on PR merge, POST a `capture` (`type: decision`, `linked_pr_url` set) using `secrets.TEAMBRAIN_TOKEN`. Illustrative per A3.

**Done when:** the curl recipes run against production with a real JWT; the Python example executes end-to-end with an `OPENAI_API_KEY` + JWT; the Actions YAML is syntactically valid (`actionlint` clean) even though it won't run without the deferred token mechanism.

---

## F — Parity smoke test

A script (curl-based, in `deploy/production/README.md` or `examples/curl.md`) that exercises each REST endpoint with a user JWT and asserts behavior matches the corresponding MCP tool: capture a thought via REST, find it via REST search, see it via REST list, mark it stale via REST, preview promotion via REST. Confirm the same row is visible/invisible under RLS exactly as MCP shows it.

**Done when:** every MCP tool's behavior is reproduced through REST with the same GitHub-OAuth JWT (roadmap deliverable #5); a non-member JWT gets the same `404`/empty results it gets through MCP.

---

## G — Deploy + docs

- Add `teambrain-rest` to the README §8 deploy loops (both VM-side and laptop-push) — it joins `teambrain-mcp`, `teambrain-membership-sync`, `teambrain-register-project`.
- Document the new REST surface + OpenAPI link in a new README section.
- No new env vars expected (reuses `EMBEDDING_*`, `OPENAI_*`, `TEAMBRAIN_DEFAULT_PROJECT_SLUG` already passed through to the functions container).

**Done when:** a clean deploy from `main` brings up `teambrain-rest`, `/openapi.yaml` resolves, and the README reflects the surface.

---

## H — Commit

Signed commits (`-S`), pushed to both remotes (`personal` = `mjstealey/TeamBrain`, `origin` = `fabric-testbed/TeamBrain`). Suggested grouping: (1) `teambrain-rest` function, (2) `openapi.yaml` + nginx serving, (3) `examples/`, (4) docs/deploy.

**Done when:** `main` on both remotes contains the function, spec, examples, and docs; production is deployed and §F passes.

---

## I — Phase 5 readiness gate

Phase 5 (capture integrations: Slack bot, GitHub Action PR-merge summarization, slash commands) can begin when:

- ✅ REST surface live and at parity with MCP (§F green).
- ✅ `openapi.yaml` published and lint-clean — Phase 5's Slack/Action integrations consume it.
- ⏳ A non-interactive credential exists for server-to-server callers (the deferred long-lived token, § J) — **this is the gating item** for the GitHub Action half of Phase 5, and is why the Phase 4 Actions example is illustrative only.

---

## J — Open follow-ups not blocking Phase 4

- **Long-lived PAT-style API tokens** — for non-interactive callers (GitHub Actions, cron jobs, CI). Needs an issuance/verification path, storage, and revocation. Gates the runnable Actions example and part of Phase 5.
- **Local JWT-refresh daemon** (`teambrain-auth`) — a developer-side helper that keeps a fresh 24h JWT on disk so CLI clients don't manually re-paste. Convenience, not blocking.
- **Fold `register_project` into `teambrain-rest`** — only if a single-function surface later proves simpler to operate. No functional reason to do it now.

---

## Notes for the next session

- The production GitHub App now has **all-repositories** access (changed during the registration smoke test), so any `fabric-testbed` repo can be registered/synced without per-repo install changes.
- Default project slug on the server is `fabric-testbed/fabric-core-api`; REST clients working against any other project (e.g. `publication-tracker-dev`) must pass `project_slug` explicitly, same as MCP.
- JWT lifetime is 24h (`GOTRUE_JWT_EXP=86400`). The landing page at `/` is where users grab/renew tokens for all REST/MCP testing.
