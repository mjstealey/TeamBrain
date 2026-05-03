# Phase 0 Checklist

Concrete, ordered tasks to complete before Phase 1 (multi-tenant schema + RLS) begins. Each item has an explicit **Done when** acceptance criterion.

Phase 0 stands up everything needed for Phase 1 to land safely: a working scratch Supabase instance, a working GitHub OAuth round-trip, the pilot repo decision, and a clean git history.

---

## A — Repo housekeeping (status: complete)

### A1. Symlink cleanup ✅

`team-brain → TeamBrain` symlink removed. Working dir is `~/GitHub/mjstealey/TeamBrain/`.

### A2. License chosen: Apache-2.0 ✅

`LICENSE` (Apache 2.0 with 2026 copyright) committed at repo root; `README.md` license section names it. Patent grant + permissive terms — appropriate for research/infrastructure and keeps commercial-derivative options open (the original reason for going parallel-repo over forking OB1's FSL-1.1-MIT).

### A3. Git initialized + initial commit ✅

```
git init
git branch -m main           # rename master → main
# stage + commit handled manually by user
```

Default branch is `main`. Initial commit covers `CLAUDE.md`, `README.md`, `CREDITS.md`, `LICENSE`, `.gitignore`, `docs/` (incl. `docs/adr/0001-teambrain-architecture.md`, `docs/deployment.md`, this file). `.claude/settings.local.json` correctly excluded by `.gitignore`.

All commits are GPG-signed (global `commit.gpgsign=true`).

### A4. Remotes configured ✅

Two named remotes per the "two named remotes" pattern (each independent; explicit push target per remote — no surprise mirroring):

| Remote | URL | Role |
|---|---|---|
| `origin` | `git@github.com:fabric-testbed/TeamBrain.git` | **Canonical** (private, org-owned — survives developer turnover) |
| `personal` | `git@github.com:mjstealey/TeamBrain.git` | Personal mirror / WIP push target |

Current branch tracks `personal/main`. To also push to the canonical org remote: `git push origin main` (one-time `-u origin main` if you want to switch the tracking branch).

### A5. Stage and commit Section A doc updates (next action)

Three doc edits sit unstaged in the working tree from Section A → B decision-capture work:

- `CLAUDE.md` — added "Local Reference Forks" section (OB1 + supabase forks at `~/github/mjstealey/`); promoted pilot-repo decision (`fabric-core-api`) into Settled Decisions; cleared Open Decisions.
- `docs/deployment.md` — Stack section now points at the local supabase fork as the canonical source for `docker/` artifacts.
- `docs/phase-0-checklist.md` — D1 rewritten to copy from the local fork; B1 rewritten as "Pilot reviewer buy-in" with five sub-questions for Komal Thareja; Section A rewritten as "status: complete".

Suggested commit (run manually — git operations stay user-driven per the A3 convention):

```bash
git add CLAUDE.md docs/deployment.md docs/phase-0-checklist.md
git commit -m "Phase 0: capture pilot decision (fabric-core-api), local reference forks, Section A status"
git push personal main
git push origin main           # only if you also want the canonical org remote updated now
```

**Done when:** `git status` is clean; the chosen remote(s) reflect the new commit.

---

## B — Pilot reviewer buy-in (can run in parallel with C and D)

### B1. Confirm Komal Thareja's participation in the fabric-core-api pilot

Pilot repo decided 2026-05-03: **`~/github/fabric/fabric-core-api`** (remote `fabric-testbed/fabric-core-api`). Refactoring will be done solo by Michael with Claude Code; Komal is the primary reviewer. The team-coordination signal being tested is multi-developer **commentary** on a single committer's changes, not multi-committer coordination. (Workflow-monitor remains an optional Phase 2 plumbing pilot before graduating to fabric-core-api for Phase 7.)

Sub-questions to ask Komal (covers social coordination + compliance + reviewer-pool sizing — the four things that can still derail the pilot now that the repo is chosen):

1. **OAuth login willingness.** Are you willing to sign in once with GitHub OAuth at `https://pr.fabric-testbed.net` so I can hand-seed your `project_members` row for the pilot? It's the same GitHub account you already use to push to `fabric-testbed/fabric-core-api`; no new credential.
2. **Review cadence during the pilot window.** Roughly how many fabric-core-api PRs do you expect to review per week over the next 4–6 weeks (the pilot evaluation window), and at what depth — quick approvals, or substantive line-level commentary? The pilot's value test depends on review *commentary* volume, not just approvals, so a rough number helps me calibrate whether the dataset will be statistically meaningful.
3. **Compliance / org concerns.** Any objections from FABRIC ops or compliance to a self-hosted Supabase on `pr.fabric-testbed.net` (FABRIC team-owned VM, GitHub OAuth, no third-party AI vendors in the data path) holding code-adjacent notes — review comments, debugging gotchas, decision rationale tied to fabric-core-api PRs/commits? Studio admin UI is gated behind vouch-proxy + CILogon (reuses our existing pattern); app-level auth is GitHub OAuth.
4. **Other reviewers worth inviting.** Anyone else on the FABRIC side who reviews fabric-core-api PRs regularly (or who *should*) and would benefit from being seeded as a `project_members` row at pilot start? Larger reviewer pool = stronger signal on the "we already discussed this" miss-rate metric.
5. **AGENTS.md surface.** Would you be willing to read a single `AGENTS.md` file at the repo root once before the pilot starts? It's the contract that tells Claude (and any other AI tool any reviewer uses) how to query / capture against TeamBrain. No ongoing reading burden — just the one-time orientation.

Optional follow-ups if Komal agrees:
- Any existing tribal knowledge about fabric-core-api that should be **seeded as initial memories** before the pilot opens (so Claude has the v1.9 → v1.10 migration context, COU semantics, role-removal history loaded from day one rather than discovering it via repeated reviewer corrections)?
- Preferred review-comment format for capture-friendliness — does she want to keep commenting in GitHub PR threads as usual (TeamBrain pulls them via webhook in Phase 5), or is she open to a `/capture` slash command in her AI tool of choice?

**Done when:** Komal answers questions 1–5; if any answer is "no", revisit (workflow-monitor as Phase 2 plumbing pilot is the obvious fallback). Update this checklist with the answers and capture them as a follow-up `PROJECT: TeamBrain — ` thought in Open Brain.

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

### D1. Use the local supabase fork

A fork is already cloned at `~/github/mjstealey/supabase/` (read-only reference — see `CLAUDE.md` "Local Reference Forks"). Refresh it first, then copy the docker stack to a scratch working dir so the fork stays untouched:

```bash
gh repo sync mjstealey/supabase
cp -R ~/github/mjstealey/supabase/docker ~/scratch/supabase-stack   # or any path outside TeamBrain
cd ~/scratch/supabase-stack
cp .env.example .env
```

**Done when:** the fork is synced, `~/scratch/supabase-stack/.env` exists, and the original fork directory is unmodified (`cd ~/github/mjstealey/supabase && git status` is clean).

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
