# TeamBrain REST — curl recipes

Copy-paste recipes for every endpoint of the TeamBrain REST surface
(`teambrain-rest` + project registration). The canonical contract is the
OpenAPI spec at **https://pr.fabric-testbed.net/openapi.yaml**.

## Setup

Every request needs a **GitHub-OAuth JWT**. Get one by signing in at
<https://pr.fabric-testbed.net/> and copying the access token. Export it in
your shell (it lasts 24h — re-grab or use the page's **Renew** button when
it expires):

```bash
export TEAMBRAIN_JWT='<access_token from the landing page>'
export BASE=https://pr.fabric-testbed.net/functions/v1
AUTH=(-H "Authorization: Bearer $TEAMBRAIN_JWT" -H "Content-Type: application/json")
```

> The `/functions/*` routes authenticate on the bearer JWT alone — no
> `apikey` header is required (unlike the raw PostgREST `/rest/*` routes).
> All access control is enforced by Row-Level Security against your
> `auth.uid()`; you only ever see or write what your project membership
> permits.

Most endpoints take a `project_slug` (`owner/repo`). When omitted, the
server falls back to its configured default — pass it explicitly when
working against a specific project.

---

## 1. Health — `GET /teambrain-rest/health`

```bash
curl -sS "${AUTH[@]}" "$BASE/teambrain-rest/health" | jq .
```

```json
{
  "service": "teambrain-rest",
  "version": "0.1.0",
  "uid": "e8a3c935-cfae-452c-8c84-9eea89a246bd",
  "visible_thought_rows": 5,
  "checked_at": "2026-05-28T21:01:43.203Z"
}
```

---

## 2. Capture — `POST /teambrain-rest/thoughts`

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts" -d '{
  "content": "We standardized on UTC for all stored timestamps; convert at the edges only.",
  "scope": "project",
  "type": "convention",
  "project_slug": "fabric-testbed/TeamBrain",
  "tags": ["timestamps", "convention"],
  "paths": ["migrations/0001_init.sql"]
}' | jq .
```

Returns `201`:

```json
{
  "id": "d5dfab3a-1ad6-49ac-a91c-de5f4b13afe1",
  "scope": "project",
  "type": "convention",
  "project_slug": "fabric-testbed/TeamBrain",
  "project_id": "bb30f8c5-d611-4735-89bf-8b79ad511f04",
  "created_at": "2026-05-28T21:02:10.904289+00:00",
  "content_chars": 76,
  "embedding_dims": 1536,
  "embedding_model": "openai:text-embedding-3-small"
}
```

Notes:
- `scope: "personal"` must omit `project_slug` (personal thoughts carry no project).
- `project` / `project_private` require you to be a writer on the project;
  RLS denial returns `403`.
- `type` is optional but recommended: `decision | convention | gotcha | context | preference | runbook`.

---

## 3. Search — `POST /teambrain-rest/thoughts/search`

Semantic (vector) search, ranked by cosine similarity, RLS-filtered.

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts/search" -d '{
  "query": "how do we handle timestamps?",
  "project_slug": "fabric-testbed/TeamBrain",
  "limit": 5,
  "threshold": 0.3
}' | jq .
```

```json
{
  "query": "how do we handle timestamps?",
  "project_slug": "fabric-testbed/TeamBrain",
  "cross_project": false,
  "threshold": 0.3,
  "count": 1,
  "results": [
    { "id": "d5dfab3a-...", "similarity": 0.71, "scope": "project",
      "type": "convention", "content": "We standardized on UTC ...", "tags": ["timestamps","convention"] }
  ]
}
```

- `threshold` defaults to `0.3` (tuned for `text-embedding-3-small`; relevant
  matches cluster 0.4–0.6).
- `cross_project: true` searches everything you can see and ignores `project_slug`.
- `scopes: ["project","project_private"]` restricts which scopes to return.

---

## 4. List recent — `GET /teambrain-rest/thoughts`

Newest-first, no semantic ranking. Filters are query params; `scopes` is
comma-separated.

```bash
curl -sS "${AUTH[@]}" \
  "$BASE/teambrain-rest/thoughts?project_slug=fabric-testbed/TeamBrain&limit=10&scopes=project,project_private" | jq .

# only rows created after a timestamp:
curl -sS "${AUTH[@]}" \
  "$BASE/teambrain-rest/thoughts?project_slug=fabric-testbed/TeamBrain&since=2026-05-01T00:00:00Z" | jq '.count'
```

---

## 5. Mark stale — `PATCH /teambrain-rest/thoughts/{id}/stale`

```bash
ID=d5dfab3a-1ad6-49ac-a91c-de5f4b13afe1
curl -sS "${AUTH[@]}" -X PATCH "$BASE/teambrain-rest/thoughts/$ID/stale" -d '{
  "confidence": "deprecated",
  "reason": "superseded by PR #1234"
}' | jq .
```

```json
{ "updated": true, "id": "d5dfab3a-...", "new_confidence": "deprecated",
  "last_verified_at": "2026-05-28T21:02:42.137+00:00", "reason_received": "superseded by PR #1234" }
```

If the thought doesn't exist *or* you lack permission, the response is
`{ "updated": false, ... }` — the two cases are intentionally not
distinguished (that would leak existence). `confidence` defaults to
`deprecated`; the body is optional.

---

## 6. Promote (preview) — `POST /teambrain-rest/thoughts/{id}/promote`

Returns a preview of the docs PR that promotion *would* create. It does not
open a PR yet (Phase 6).

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts/$ID/promote" -d '{
  "target_path": "docs/adr/",
  "target_branch": "main"
}' | jq '{ok, file: .request.proposed_filename, branch: .request.proposed_branch}'
```

---

## 7. Register a project — `POST /teambrain-register-project/register`

Self-service registration, gated on GitHub repo-admin permission. You must
be an **admin** of the repo, and the owner must be the configured org.

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-register-project/register" -d '{
  "repo_slug": "fabric-testbed/some-repo",
  "github_team_slugs": []
}' | jq .
```

Returns `201` with the created `project` and a membership `sync` report.
Common rejections: `403` (not repo admin / wrong org), `404` (repo not
visible to the TeamBrain GitHub App), `409` (already registered).

---

## 8. Non-interactive API tokens — `teambrain-token`

For server-to-server callers (GitHub Actions, cron, CI) that can't do the
interactive GitHub-OAuth flow. A project **admin** issues a long-lived opaque
token; the caller exchanges it for a short-lived JWT, then calls the REST/MCP
surface with that JWT. Default capability: capture + read on
`project`/`personal` (no `project_private`, no `mark_stale`/`promote_to_docs`).

### Issue a token (admin only — uses your user JWT)

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-token/token" -d '{
  "project_slug": "fabric-testbed/fabric-core-api",
  "name": "PR-merge capture action"
}' | jq .
```

Returns `201`. The plaintext `token` is shown **once** — store it now:

```json
{
  "token": "tbk_xq3…",
  "note": "Store this now — it is shown ONLY once and cannot be retrieved later.",
  "id": "…", "token_prefix": "tbk_xq3F1a8b",
  "project_slug": "fabric-testbed/fabric-core-api",
  "allowed_tools": ["capture_project_thought","search_project_thoughts","list_recent_project_thoughts"],
  "allowed_scopes": ["project","personal"], "expires_at": "2026-11-25T…Z"
}
```

### Exchange the opaque token for a short-lived JWT (no user JWT)

The exchange takes **two headers**: the opaque token in `X-TeamBrain-Token`,
and the *public* anon key as the bearer (the gateway requires some valid JWT;
the exchange endpoint ignores it). The anon key is the same one the landing
page ships to browsers — it is not a secret.

```bash
export TBK='tbk_xq3…'              # the opaque token (keep this secret)
export ANON='<public anon key>'    # gateway pass-through only
ACCESS=$(curl -sS -X POST "$BASE/teambrain-token/token/exchange" \
  -H "Authorization: Bearer $ANON" \
  -H "X-TeamBrain-Token: $TBK" | jq -r .access_token)

# Use $ACCESS like any user JWT (lasts 15 min):
curl -sS -H "Authorization: Bearer $ACCESS" -H "Content-Type: application/json" \
  -X POST "$BASE/teambrain-rest/thoughts" -d '{
    "content": "Merged PR #42: switch to UTC everywhere",
    "scope": "project", "type": "decision",
    "project_slug": "fabric-testbed/fabric-core-api"
  }' | jq .
```

A token call to a disallowed tool returns `403` (`not permitted for this API
token`); a `project_private` scope is likewise refused. RLS enforces the same
limits at the database.

### List / revoke (admin only — your user JWT)

```bash
curl -sS "${AUTH[@]}" "$BASE/teambrain-token/token?project=fabric-testbed/fabric-core-api" | jq .

TOKEN_ID=…   # from the list (the plaintext is never retrievable)
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-token/token/$TOKEN_ID/revoke" | jq .
```

Revocation takes effect within the 15-minute access-token TTL.

---

## 9. Propose captures from a merged PR — `teambrain-summarize`

`POST /teambrain-summarize/propose` turns a merged PR's **metadata** (title,
body, commit messages, changed-file *paths* — never diff contents) into 0–3
candidate captures. It **writes nothing** — it only proposes. The
`capture-on-merge` GitHub Action (`examples/github-actions/capture-on-merge.yml`)
calls this, renders the proposals for human approval, then writes the approved
set via § 2. Authenticate with any JWT — here the bot JWT from the § 8 exchange
(`$ACCESS`):

```bash
curl -sS -H "Authorization: Bearer $ACCESS" -H "Content-Type: application/json" \
  -X POST "$BASE/teambrain-summarize/propose" -d '{
    "project_slug": "fabric-testbed/TeamBrain",
    "title": "Switch all stored timestamps to UTC",
    "body": "Normalizes every stored timestamp to UTC; the display tier converts to local. Closes the DST off-by-one in the scheduler.",
    "commits": ["fix(time): store UTC everywhere", "test: DST boundary cases"],
    "changed_paths": ["src/time.ts", "tests/time_test.ts"]
  }' | jq .
```

Returns `200` with 0–3 proposals (`scope` is always `project`; `type` is one of
`decision | convention | gotcha | context`):

```json
{
  "project_slug": "fabric-testbed/TeamBrain",
  "count": 1,
  "proposals": [
    {
      "content": "All stored timestamps are UTC; convert to local only at the display tier. Prevents DST off-by-one bugs.",
      "type": "convention",
      "scope": "project",
      "tags": ["time", "utc", "timezones"]
    }
  ]
}
```

A trivial PR (typo, formatting, routine bump) returns `{"count": 0, "proposals": []}`.
A provider failure returns `502` with a `kind` of `upstream` or `parse`; a
missing server-side AI key returns `500` (`kind: config`).

---

## Error shape

All errors return a JSON body:

```json
{ "error": "validation failed: content: String must contain at least 1 character(s)" }
```

| Status | Meaning |
|---|---|
| `400` | Request validation failed (bad/missing field). |
| `401` | Missing or malformed JWT. |
| `403` | RLS denied the write, or a registration gate failed. |
| `404` | Project/repo not found or not accessible to you. |
| `409` | Project already registered. |
| `413` | Request payload too large (`teambrain-summarize` PR metadata). |
| `500` | Server misconfigured (e.g. an unset AI key) or an internal error. |
| `502` | An upstream dependency (DB, embedding/LLM provider, GitHub) failed. |
