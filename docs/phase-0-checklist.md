# Phase 0 Checklist

Concrete, ordered tasks to complete before Phase 1 (multi-tenant schema + RLS) begins. Each item has an explicit **Done when** acceptance criterion.

Phase 0 stands up everything needed for Phase 1 to land safely: a working scratch Supabase instance, a working GitHub OAuth round-trip, the pilot repo decision, and a clean git history.

---

## A — Repo housekeeping (do first; ~15 min)

### A1. Clean up the rename leftover symlink

The `team-brain → TeamBrain` symlink exists only to keep an old shell session alive. New session starts in `TeamBrain/`, so the symlink is no longer needed.

```bash
rm /Users/stealey/GitHub/mjstealey/team-brain
ls -la /Users/stealey/GitHub/mjstealey/ | grep -i -E "team|brain"
```

**Done when:** only `TeamBrain/` is listed; no `team-brain` entry remains.

### A2. Pick a license

Decision is open. Options to consider:
- **Apache-2.0** — permissive, patent grant, common in research/infrastructure. Recommended unless you have a reason otherwise.
- **MIT** — minimal, permissive, no patent clause.
- **No license / proprietary** — defaults to "all rights reserved"; only collaborators with explicit written permission can use it.

Add `LICENSE` file at repo root and add a `## License` line to `README.md` with the chosen identifier.

**Done when:** `LICENSE` file exists at repo root; `README.md` license section names it.

### A3. Initialize git and make the first commit

```bash
cd /Users/stealey/GitHub/mjstealey/TeamBrain
git init
git add CLAUDE.md README.md CREDITS.md LICENSE .gitignore docs/
git commit -m "Initial scaffold: docs, ADR 0001, deployment target"
```

Do **not** commit `.claude/settings.local.json` — it's already gitignored.

**Done when:** `git log` shows one commit; `git status` is clean.

### A4. Decide whether to push to a remote

Options:
- Create a private repo at `github.com/fabric-testbed/TeamBrain` (recommended — survives developer turnover).
- Keep local-only until Phase 1 is real.

**Done when:** decision made; if pushing, remote configured and initial commit pushed.

---

## B — Pilot repo decision (can run in parallel with C and D)

### B1. Resolve the open pilot question

Three candidates from `CLAUDE.md`:
- **HotGlass** — solo-ish; validates plumbing but not the "team" part.
- **workflow-visualizer** — real multi-contributor, but mid-blocker on anywidget MIME issue.
- **`~/github/fabric/fabric-core-api`** — real multi-dev Python codebase, but undergoing restructuring soon.

For fabric-core-api specifically, sub-questions to answer:
- When does the restructuring start? Pilot during it (high signal/high noise) or after (clean baseline)?
- Are 2+ developers actively committing during the pilot window?

**Done when:** pilot repo chosen; decision recorded as a follow-up `PROJECT: TeamBrain — ` thought in Open Brain so the next session sees it.

---

## C — GitHub OAuth App (no scratch instance required; ~20 min)

### C1. Create the OAuth App under the `fabric-testbed` GitHub org

Path: GitHub → `fabric-testbed` org → Settings → Developer settings → OAuth Apps → New OAuth App.

| Field | Value |
|-------|-------|
| Application name | `TeamBrain` |
| Homepage URL | `https://pr.fabric-testbed.net` |
| Authorization callback URL | `https://pr.fabric-testbed.net/auth/v1/callback` |

For the **scratch instance** spike, also create a second callback or add a second OAuth App pointing at `http://localhost:8000/auth/v1/callback` so local Docker Desktop testing works.

**Done when:** Client ID + Client Secret saved to a password manager (do not commit). Both prod and scratch callback URLs are functional or both apps exist.

### C2. Confirm minimum scopes for membership sync

Phase 3 sync needs at minimum: `read:user`, `user:email`, `read:org`. Add `repo` only if the pilot repo is private (`public_repo` or no repo scope is enough for public repos).

**Done when:** scope list confirmed and noted in `docs/deployment.md` (already drafted there — verify it matches the pilot repo's visibility).

---

## D — Scratch Supabase instance (Docker Desktop or throwaway VM; ~45–60 min)

Do **not** touch `pr.fabric-testbed.net` until everything in this section passes.

### D1. Clone the Supabase docker-compose

```bash
cd ~/scratch   # or anywhere outside the TeamBrain repo
git clone --depth 1 https://github.com/supabase/supabase.git supabase-stack
cd supabase-stack/docker
cp .env.example .env
```

**Done when:** working copy of `supabase/supabase` exists locally; `.env` exists.

### D2. Configure scratch `.env`

Generate JWT secret and the anon/service-role keys per [Supabase self-host docs](https://supabase.com/docs/guides/self-hosting/docker). Set:

```
POSTGRES_PASSWORD=<strong-random>
JWT_SECRET=<generated>
ANON_KEY=<generated>
SERVICE_ROLE_KEY=<generated>
SITE_URL=http://localhost:3000
API_EXTERNAL_URL=http://localhost:8000
SUPABASE_PUBLIC_URL=http://localhost:8000

GOTRUE_EXTERNAL_GITHUB_ENABLED=true
GOTRUE_EXTERNAL_GITHUB_CLIENT_ID=<from C1>
GOTRUE_EXTERNAL_GITHUB_SECRET=<from C1>
GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI=http://localhost:8000/auth/v1/callback
```

**Done when:** all env vars set; no placeholder strings remain.

### D3. Bring the stack up

```bash
docker compose up -d
docker compose ps
```

**Done when:** every service shows `running (healthy)` (allow ~60s for first start). If any service is unhealthy, check `docker compose logs <service>` before continuing.

### D4. Verify pgvector is available

```bash
docker compose exec db psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

**Done when:** the row for `vector` is returned.

### D5. Verify Studio loads

Open `http://localhost:3000` in a browser. Default login is from `.env` (`STUDIO_DEFAULT_*` or basic auth depending on config).

**Done when:** Studio dashboard renders, can browse `auth.users` (empty), can run a SQL query (`SELECT now();`) successfully.

### D6. Verify GitHub OAuth round-trip

The simplest harness: use a tiny static HTML page that calls `supabase.auth.signInWithOAuth({ provider: 'github' })` via the JS client, served from `localhost:3000` or any local port whose origin is in `ADDITIONAL_REDIRECT_URLS`.

Walk through:
1. Click "Sign in with GitHub" in the harness.
2. Redirect to GitHub → authorize the OAuth App.
3. Redirect back → Studio's `auth.users` table should now have one row with the GitHub identity.
4. The session JWT should decode (use jwt.io) to show `sub` matching the new `auth.users.id`.

**Done when:** a row exists in `auth.users` with `provider=github`; the JWT contains the correct `sub`.

### D7. Verify `auth.uid()` works in SQL with that user's JWT

In Studio's SQL editor, switch the role to `authenticated` and set the JWT:

```sql
SET request.jwt.claims = '<paste decoded JSON or use the raw JWT via Supabase client>';
SELECT auth.uid();
```

(Easier alternative: use the JS client with the session and run `supabase.rpc('whoami')` against a stored function `create function whoami() returns uuid language sql as $$ select auth.uid(); $$;`.)

**Done when:** `auth.uid()` returns the same UUID as `auth.users.id` for the GitHub-authenticated user.

---

## E — Phase 1 readiness gate

Before moving to Phase 1, confirm:

- [ ] A1–A3 complete (clean repo, license, initial commit)
- [ ] B1 complete (pilot repo chosen, captured to Open Brain)
- [ ] C1 complete (OAuth App created in `fabric-testbed` org)
- [ ] D3–D7 all green on scratch instance

If all five are checked, Phase 1 schema work can begin against the scratch Supabase. The first Phase 1 deliverables (per `CLAUDE.md`) are:

1. `migrations/0001_init.sql`
2. `migrations/0002_rls.sql`
3. `migrations/seed.sql` (manual `project_members` for pilot devs)
4. End-to-end smoke test confirming RLS isolation

---

## Notes for the next session

- Read order on session start: `CLAUDE.md` → `docs/adr/0001-teambrain-architecture.md` → this file.
- Decisions and blockers go to Open Brain with prefix `PROJECT: TeamBrain — `.
- Do **not** touch Michael's personal OB1 Supabase project (`ncldmtgyyikclljevpkm`).
- Do **not** deploy to `pr.fabric-testbed.net` until D7 passes on a scratch instance.
