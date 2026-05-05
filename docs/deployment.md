# Deployment

This document describes the target deployment topology for TeamBrain. It is a **skeleton** — concrete versions, exact env var values, and tested commands will be filled in as Phase 0 lands.

## Target

- **Host:** `pr.fabric-testbed.net` (FABRIC team-owned VMware VM, public IPv4)
- **VM sizing target:** 4 vCPU / 8 GB RAM / 50 GB disk (small-team workload). Bump RAM if loading large embedding sets.
- **OS:** Linux (distro TBD — Ubuntu LTS or Rocky Linux are both fine)
- **Container runtime:** Docker + Compose v2 plugin

## Stack

The official Supabase docker-compose stack from [`github.com/supabase/supabase/tree/master/docker`](https://github.com/supabase/supabase/tree/master/docker). A local fork is kept at `~/github/mjstealey/supabase/` (refresh with `gh repo sync mjstealey/supabase`); the `docker/` subtree is the canonical source for compose files, `.env.example`, and `versions.md`. See `CLAUDE.md` "Local Reference Forks" for the read-only-fork policy.

| Service | Role | Notes |
|---------|------|-------|
| Postgres + pgvector | Database, embeddings | Enable `vector` extension via the `db/init/` scripts |
| GoTrue | Auth | GitHub OAuth Phase 1; CILogon as second OIDC provider deferred |
| PostgREST | Auto-generated REST API | Used as one of the two transport layers |
| Realtime | WebSocket pub/sub | Not used in Phase 1; leave running |
| Storage | S3-compatible blob store | Not used in Phase 1; leave running |
| Edge Functions | Deno runtime | Hosts the TeamBrain MCP server (~200 lines TS) |
| Studio | Admin UI | Restrict access — see "Studio access" below |
| Kong | API gateway | Bundled; sits behind our reverse proxy |
| pg-meta | Postgres introspection API | Used by Studio |

## Reverse proxy + TLS

Caddy is preferred for simplicity (single-line TLS auto-config and renewal). Nginx is acceptable if the team already standardizes on it.

Caddyfile sketch:

```
pr.fabric-testbed.net {
    reverse_proxy localhost:8000   # Kong gateway
}
```

If admin UI (Studio) is exposed at a separate hostname, front it with vouch-proxy + CILogon (reuse the FABRIC team's existing pattern in `~/github/fabric/cilogon-vouch-proxy-example`):

```
admin.pr.fabric-testbed.net {
    forward_auth localhost:9090 {   # vouch-proxy
        uri /validate
        copy_headers X-Vouch-User
    }
    reverse_proxy localhost:3000   # Studio
}
```

## GitHub OAuth App

Create the app under the **`fabric-testbed`** GitHub org account (not a personal account — survives developer turnover):

- **App name:** `TeamBrain`
- **Homepage URL:** `https://pr.fabric-testbed.net`
- **Authorization callback URL:** `https://pr.fabric-testbed.net/auth/v1/callback`
- **Scopes requested at login:** `read:user`, `user:email`, `read:org` (add `repo` only if pilot includes private repos; otherwise `public_repo` or no repo scope is enough)

Save Client ID and Client Secret to the docker-compose `.env` file (gitignored):

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOTRUE_EXTERNAL_GITHUB_ENABLED=true
GOTRUE_EXTERNAL_GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
GOTRUE_EXTERNAL_GITHUB_SECRET=${GITHUB_CLIENT_SECRET}
GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI=https://pr.fabric-testbed.net/auth/v1/callback
```

Set `SITE_URL=https://pr.fabric-testbed.net` and add any developer dashboards to `ADDITIONAL_REDIRECT_URLS`.

## Environment variables (high-level contract)

A complete `.env.template` will be committed once the docker-compose stack is in place. Categories to expect:

- **Postgres** — `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`
- **JWT** — `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` (generated at install)
- **Site** — `SITE_URL`, `API_EXTERNAL_URL`, `SUPABASE_PUBLIC_URL`
- **Auth** — `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOTRUE_EXTERNAL_GITHUB_*`
- **Studio** — `STUDIO_DEFAULT_ORGANIZATION`, `STUDIO_DEFAULT_PROJECT`
- **SMTP** (for password reset emails, even though we use OAuth) — `SMTP_HOST`, `SMTP_USER`, etc., or omit if not used

## Backups

- **v1:** nightly `pg_dump` cron, encrypted, copied offsite (S3-compatible bucket or FABRIC-owned NFS).
- **If PITR is required later:** pgBackRest or Barman against the Postgres container — both well-documented for self-hosted Supabase.

## Studio access

Studio is a powerful admin UI — it can browse/edit any row, run arbitrary SQL, and view secrets. **Do not expose it on the public hostname without auth.** Two acceptable patterns:

1. **VPN-only / private network only** — bind Studio to `127.0.0.1` and require SSH tunnel for admin access.
2. **Vouch-proxy + CILogon** — reuse the FABRIC pattern. App auth stays GitHub OAuth; admin auth uses CILogon. This is the recommended path because the FABRIC team already operates it.

## Upgrade discipline

- Track upstream Supabase docker-compose releases (pin versions in `docker-compose.yml`, do not float `:latest`).
- Test upgrades against a scratch instance (Docker Desktop or a second VM) before applying to `pr.fabric-testbed.net`.
- Keep `pg_dump` snapshots immediately before any version bump.

## Phase 0 spike (before Phase 1 schema work)

Stand up the docker-compose stack on **a scratch host** (developer Docker Desktop or a throwaway VM) and verify:

1. Stack comes up healthy (`docker compose ps` all green).
2. Studio loads and is reachable.
3. GitHub OAuth login completes round-trip and creates a row in `auth.users`.
4. The user's JWT exposes `auth.uid()` correctly to Postgres in a sample SQL query.

Only after this spike succeeds do we touch `pr.fabric-testbed.net`.

## Phase 1 — applying migrations

Phase 1 ships four files in `migrations/`:

| File | Role |
|---|---|
| `0001_init.sql` | Tables, ENUMs, indexes, `updated_at` trigger, base grants. RLS deliberately not enabled here. |
| `0002_rls.sql` | Enables RLS on all 3 tables; revokes `anon`; defines 3 SECURITY DEFINER helpers in the `app` schema; creates 8 policies (4 on `thoughts`, 2 on `projects`, 1 on `project_members`). |
| `0003_disable_graphql.sql` | `drop extension pg_graphql`. TeamBrain transports are MCP + REST; GraphQL is not in the architecture and its introspection trips lints we cannot otherwise clear without revoking `authenticated` SELECT. |
| `seed.sql` | Hand-seeded pilot project + `project_members` rows. Resolved by GitHub handle from `auth.users.raw_user_meta_data`; gracefully skips users not yet logged in. Re-runnable. |

### How to apply (scratch instance)

The self-hosted `postgres` role is **not a superuser** on the supabase docker stack — it cannot own functions in `public` and DDL applied via `psql -U postgres` will fail in confusing ways. **Apply migrations through Studio's SQL editor** (Studio runs as `supabase_admin`, which is the correct DDL identity).

1. Open Studio at `http://127.0.0.1:3000`, click **SQL Editor → New query**.
2. For each file in order — `0001`, `0002`, `0003`, `seed` — paste the entire file contents, click **Run**.
3. Studio will warn for `0001` ("New tables will not have RLS enabled") — click **"Run without RLS"**. RLS is enabled in `0002`.
4. Studio will warn for `0002` ("Query has destructive operations") because of the `drop policy if exists` re-runnability lines — expected, click through.
5. After each file, run the verification queries in `docs/phase-1-checklist.md` (sections B2, C2, C3, D1).

### Acceptance gate (Phase 1 → Phase 2)

After all four files apply cleanly:

- **Database → Advisors → Security Advisor:** 0 errors, 0 warnings.
- **Database → Advisors → Performance Advisor:** 0 issues.
- **RLS isolation matrix** (E3 in the Phase 1 checklist) — five SQL queries impersonating `authenticated` via `set local request.jwt.claims`. The two load-bearing checks: a non-member sees zero rows (`select count(*) from public.thoughts where ...` returns 0) and a non-member's insert raises `42501: new row violates row-level security policy for table "thoughts"`.

If all three are green, Phase 2 (porting OB1's `shared-mcp` edge function to multi-tenant TeamBrain) can begin. If anything else surfaces, capture and triage before proceeding.

### Applying to `pr.fabric-testbed.net`

Same procedure as scratch — open the production Studio, paste each file in order. The `seed.sql` file is environment-agnostic (uses GitHub handles, not UUIDs, so it resolves correctly against whichever `auth.users` exists in the target instance). **Do not apply to production until the scratch acceptance gate above is fully green for the same migration set.**

## Phase 2 — applying the MCP edge function migration + deploying the edge function

Phase 2 adds the multi-tenant MCP edge function under `edge-functions/teambrain-mcp/` plus three migrations:

- `0004_match_thoughts.sql` — SECURITY INVOKER semantic-search RPC.
- `0005_resize_embedding_768.sql` — **optional**, only for deployments choosing a 768-dim embedding provider (see "Choose an embedding provider" below).
- `0006_embedding_model.sql` — adds `thoughts.embedding_model` column. Apply on every deployment regardless of variant; the column is the operational complement to the pluggable embedding provider (see ADR 0001 § Decision 5).

### Apply the migration (Studio)

Apply `0004_match_thoughts.sql` the same way as the Phase 1 migrations — paste into Studio SQL editor, run. Verify:

```sql
select pg_get_function_identity_arguments('public.match_thoughts'::regproc);
-- expect: query_embedding vector, match_count integer, match_threshold double precision,
--         filter_project_id uuid, filter_scopes thought_scope[]
```

### Deploy the edge function to scratch

Source-of-truth lives in `edge-functions/teambrain-mcp/` in this repo. The Edge Runtime container reads from `~/scratch/supabase-stack/volumes/functions/teambrain-mcp/` (the supabase docker convention: function directory name = URL function name). Sync source → runtime mount with `rsync`:

```bash
rsync -av --delete \
  ~/GitHub/mjstealey/TeamBrain/edge-functions/teambrain-mcp/ \
  ~/scratch/supabase-stack/volumes/functions/teambrain-mcp/
```

### Choose an embedding provider (deploy-time)

ADR 0001 § Decision 5 makes the embedding provider pluggable. Each deployment picks one of two shipped variants and applies the matching schema. The choice is fixed for the life of the deployment — switching post-data requires re-embedding every thought.

| Variant | Use for | Schema | Provider config |
|---|---|---|---|
| **OpenAI** (`vector(1536)`) | scratch / dev / teams choosing OpenAI | apply `0001_init.sql` only | `EMBEDDING_PROVIDER=openai`, `OPENAI_API_KEY=...` |
| **ollama / self-host** (`vector(768)`) | `pr.fabric-testbed.net` production; teams preferring zero third-party data egress | apply `0001_init.sql` **then** `0005_resize_embedding_768.sql` | `EMBEDDING_PROVIDER=ollama`, `OLLAMA_URL=http://ollama:11434`, plus an ollama sidecar in compose |

Other dim variants (Cohere 1024, Voyage 512, etc.) are supported by writing a new dispatch arm in `embedding.ts` and a copy-and-edit of `0005_resize_embedding_768.sql` for the new dim — TeamBrain does not ship every variant in-repo.

Reference fragments for both shipped variants live in `edge-functions/teambrain-mcp/docker-compose.override.yml.example` — copy the relevant block into your scratch or production `docker-compose.override.yml`.

### Required env in the functions container

The stock supabase `docker-compose.yml` `functions:` service forwards only its hard-coded list of env vars. TeamBrain needs additional env passthrough; the exact set depends on the variant. Add to your scratch-local `docker-compose.override.yml` (gitignored, never copied into this repo):

**OpenAI variant:**

```yaml
services:
  functions:
    environment:
      EMBEDDING_PROVIDER:             openai
      EMBEDDING_DIMS:                 "1536"
      OPENAI_API_KEY:                 ${OPENAI_API_KEY}
      OPENAI_EMBEDDING_MODEL:         text-embedding-3-small
      TEAMBRAIN_DEFAULT_PROJECT_SLUG: ${TEAMBRAIN_DEFAULT_PROJECT_SLUG:-fabric-testbed/fabric-core-api}
```

`OPENAI_API_KEY` must be a real key with billing enabled — `text-embedding-3-small` is consumed on every capture and search; cost is ~$0.02 per 1M tokens (effectively free for pilot scale).

**ollama variant** (see the override.yml.example file for the full ollama service definition; healthcheck blocks the functions container from booting until the model is pulled):

```yaml
services:
  functions:
    environment:
      EMBEDDING_PROVIDER:             ollama
      EMBEDDING_DIMS:                 "768"
      OLLAMA_URL:                     http://ollama:11434
      OLLAMA_EMBEDDING_MODEL:         nomic-embed-text
      TEAMBRAIN_DEFAULT_PROJECT_SLUG: ${TEAMBRAIN_DEFAULT_PROJECT_SLUG:-fabric-testbed/fabric-core-api}
    depends_on:
      ollama:
        condition: service_healthy
```

`TEAMBRAIN_DEFAULT_PROJECT_SLUG` is optional in either variant; tools accept `project_slug` directly in args. Setting it lets a single-pilot deployment omit the param.

After editing the override, recreate the container so the new env lands:

```bash
cd ~/scratch/supabase-stack
docker compose up -d functions   # plus `ollama` if running the self-host variant
docker compose exec functions env \
  | grep -E 'EMBEDDING_PROVIDER|EMBEDDING_DIMS|OPENAI_API_KEY|OLLAMA_URL|TEAMBRAIN_DEFAULT_PROJECT_SLUG' \
  | sed 's/=.*/=<set>/'
# expect a line per variable that's set; values masked
```

### Diagnostic — confirm embedding model tagging

After capturing at least one thought via the MCP edge function, verify the model tag is being recorded:

```sql
select embedding_model, count(*) as n
from public.thoughts
where embedding is not null
group by embedding_model
order by n desc;
```

Expected: a single non-null tag (`openai:text-embedding-3-small` or `ollama:nomic-embed-text` depending on variant) for newly-captured rows. NULL rows are pre-`0006` captures or rows captured against an older edge function version; re-embed them when convenient. **More than one non-null tag is a signal that the provider config drifted mid-deployment** — investigate before further captures.

### Acceptance gate (Phase 2 → Phase 3)

The Phase 2 checklist's curl matrix passing is sufficient — see `docs/phase-2-checklist.md` § I. The 5 tools (`ping`, `capture_project_thought`, `search_project_thoughts`, `list_recent_project_thoughts`, `mark_stale`, `promote_to_docs`) each return well-formed responses for a real GoTrue-issued JWT, and Phase 1 § E3 transitively proves non-member denial at the MCP layer.

### Applying to `pr.fabric-testbed.net`

Production deploys the **ollama / self-host variant** per ADR 0001 § Decision 5. Procedure:

1. Apply `0001_init.sql` through `0004_match_thoughts.sql` (Studio SQL editor) — same as scratch.
2. Apply `0005_resize_embedding_768.sql` **before** any thoughts are captured.
3. rsync `edge-functions/teambrain-mcp/` from this repo into the production stack's `volumes/functions/` mount.
4. Wire production `docker-compose.override.yml` with the ollama variant fragment (see `docker-compose.override.yml.example`).
5. `docker compose up -d ollama functions` — ollama's healthcheck blocks the functions container until `nomic-embed-text` is pulled and ready.
6. Run the Phase 2 curl matrix against the production URL. All five tools should pass identically to scratch; the only observable difference is `embedding_dims=768` in capture responses (vs. 1536 on the OpenAI scratch variant).

**Do not deploy to production until scratch passes the Phase 2 curl matrix on the same source** *and* a separate scratch run validates the ollama variant end-to-end (recommended: spin up a second scratch instance for the ollama smoke test before going to `pr.fabric-testbed.net`).
