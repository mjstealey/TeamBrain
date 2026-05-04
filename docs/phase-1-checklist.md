# Phase 1 Checklist

Concrete, ordered tasks for Phase 1 — multi-tenant schema, RLS for the three scopes, hand-seeded membership, and an end-to-end RLS isolation smoke test on the scratch Supabase. Each item has an explicit **Done when** acceptance criterion.

Phase 1 entry preconditions (from `docs/phase-0-checklist.md` Section E):

- A1–A4 complete (clean repo, Apache-2.0, initial commit, remotes configured) ✅
- B1 — pilot repo decided (`fabric-core-api`); Komal's buy-in not blocking schema work ✅
- C1–C2 complete (both OAuth apps registered) ✅
- D1–D8 — scratch Supabase up on `https://127.0.0.1:8443` with GitHub OAuth round-trip and `auth.uid()` working ✅

If any of those are not green, stop and finish Phase 0 first. Phase 1 work assumes the scratch stack is reachable, `extensions.vector` is installed, and at least one row exists in `auth.users` with `provider=github` (yours, from D7).

---

## A — Migration tooling & layout

### A1. Decide where migrations live and how they're applied

`migrations/` lives at the TeamBrain repo root (the CLAUDE.md "Phase 1 — Suggested First Deliverables" list names them there). Per the auto-memory `project_supabase_function_conventions.md`, all DDL during Phase 1 is **applied via Studio's SQL editor** on the scratch instance — the self-hosted `postgres` role is not a superuser and can't own functions in `public`, but `supabase_admin` (which Studio uses) can.

For Phase 1 we don't need a migration runner. The files in `migrations/` are the canonical definition; applying them to scratch is "open Studio → SQL editor → New query → paste file contents → Run". When we move to `pr.fabric-testbed.net` in a later phase we'll layer on a runner (`supabase db push` against the local fork's CLI, or a thin shell wrapper around `psql`); deciding now is premature.

**Done when:** `migrations/` exists at repo root with `.gitkeep` (or the first migration file from B1). No runner installed yet.

### A2. Decide what scope each migration file covers

Four files for Phase 1 (extends the `CLAUDE.md` list with one transport-lockdown migration that emerged from advisor cleanup):

| File | Scope | Why split |
|---|---|---|
| `migrations/0001_init.sql` | Tables, types, indexes, trigger, grants. **No RLS.** | DDL-only; if 0002 needs to be reverted (drop/recreate policies), 0001 doesn't need to be touched. |
| `migrations/0002_rls.sql` | `alter table ... enable row level security` + all `create policy` statements + `app` schema with the SECURITY DEFINER helpers + `revoke all from anon`. Inline comments per policy. | RLS is the part most likely to need iteration during smoke testing — keeping it isolated lets you re-run just this file. |
| `migrations/0003_disable_graphql.sql` | `drop extension pg_graphql`. | TeamBrain's transports are MCP + REST per the ADR; pg_graphql ships enabled by default and trips lint 0027 on every authenticated-readable table. Dropping it is on-architecture and removes the only remaining advisor warnings after 0002. |
| `migrations/seed.sql` | Hand-seeded `projects` + `project_members` rows for the pilot. **No `auth.users` inserts** — those come from real GitHub OAuth round-trips. | Data, not schema. Re-runnable via `on conflict do nothing`. Not a numbered migration (it's not part of the schema timeline). |

**Done when:** the three filenames are agreed on and an empty `migrations/` directory exists.

---

## B — `migrations/0001_init.sql` — core schema

### B1. Write the migration

Schema surface (per `CLAUDE.md` "Architecture Reference → Data model additions" and `docs/adr/0001-teambrain-architecture.md`):

**Types (ENUMs in `public`):**
- `thought_scope`: `personal | project | project_private`
- `thought_type`: `decision | convention | gotcha | context | preference | runbook`
- `thought_confidence`: `tentative | confirmed | deprecated`
- `member_role`: `admin | contributor | reader`

**Tables:**
- `public.projects` — `id uuid pk`, `repo_slug text unique not null`, `name text not null`, `created_by uuid references auth.users`, `created_at`, `updated_at`.
- `public.project_members` — composite pk `(project_id, user_id)`, `role member_role not null default 'contributor'`, `created_at`. FKs to `projects(id)` and `auth.users(id)`, both `on delete cascade`.
- `public.thoughts` — OB1's columns (`id`, `content`, `embedding vector(1536)`, `metadata jsonb`, `created_at`, `updated_at`) **plus** TeamBrain additions: `project_id uuid references projects on delete cascade` (nullable — required for project/project_private; null for personal), `scope thought_scope not null default 'personal'`, `type thought_type`, `author_user_id uuid references auth.users on delete set null`, `linked_commit_sha text`, `linked_pr_url text`, `linked_issue_url text`, `last_verified_at timestamptz`, `expires_at timestamptz`, `paths text[] default '{}'`, `confidence thought_confidence not null default 'tentative'`, `tags text[] default '{}'`.
- **CHECK constraint** on `thoughts`: `(scope = 'personal' and project_id is null) or (scope in ('project','project_private') and project_id is not null)`. This is the structural invariant — RLS policies in 0002 lean on it.

**Indexes:**
- `thoughts (project_id, scope)` — primary access pattern (members listing project thoughts).
- `thoughts (author_user_id)` — RLS lookups for personal scope.
- HNSW on `thoughts.embedding vector_cosine_ops` — semantic search (Phase 2 MCP).
- GIN on `thoughts.metadata` — JSONB filtering.
- GIN on `thoughts.tags` and `thoughts.paths` — tag / file-path filtering.
- `thoughts (created_at desc)` — recency listing.
- `project_members (user_id)` — reverse lookup ("which projects is this user in").

**Trigger:** `update_updated_at()` function (`security invoker`, `set search_path = ''`, fully qualified `pg_catalog.now()` per `feedback`/auto-memory conventions). One trigger on `projects`, one on `thoughts`.

**Grants:** mirror OB1's pattern — `grant select, insert, update, delete on public.{projects,project_members,thoughts} to service_role`. `authenticated` and `anon` get nothing here; their access flows entirely through the RLS policies in 0002 (which themselves grant nothing — they just *permit* operations the role-level grant already authorizes). For `authenticated` to actually read/write through PostgREST, we'll also need table-level grants gated by RLS — added in 0002 alongside the policies that make them safe.

**Conventions enforced (from auto-memory):**
- `vector(1536)` referenced unqualified — `extensions` schema is on `search_path`, no `extensions.vector` needed.
- `gen_random_uuid()` lives in `pgcrypto` (in `extensions`), referenced unqualified.
- `update_updated_at()` defined with `set search_path = ''` and `pg_catalog.now()`.
- ENUM creation wrapped in `do $$ begin ... exception when duplicate_object then null; end $$` for idempotency — `create type` has no `if not exists`.
- No `drop table`, no `truncate`, no unqualified `delete` (per CLAUDE.md hard boundaries).

**Done when:** `migrations/0001_init.sql` exists and lints clean (`pg_dump --schema-only` against the scratch DB after applying it produces what the file describes).

### B2. Apply 0001 to the scratch instance

Studio → SQL editor → New query → paste the entire file → Run.

If anything fails, fix the file (not the DB), drop the partially-created objects manually via Studio, re-run. Do not let scratch drift from the file.

**Done when:**

```sql
-- In Studio SQL editor:
select table_name from information_schema.tables
  where table_schema = 'public' and table_name in ('projects','project_members','thoughts')
  order by table_name;
-- Expect 3 rows.

select typname from pg_type
  where typname in ('thought_scope','thought_type','thought_confidence','member_role')
  order by typname;
-- Expect 4 rows.

-- Studio → Database → Advisors → Security Advisor: zero issues
-- (no "Function Search Path Mutable" on update_updated_at;
--  no "Extension in Public" on vector or pgcrypto).
```

### B3. Sanity-insert as `service_role` (RLS not yet enabled)

In Studio's SQL editor (which runs as `supabase_admin`, bypassing RLS — equivalent to service_role for write tests), insert a `projects` row, a `project_members` row pointing at your `auth.users.id` from D7, and three `thoughts` rows covering all three scopes. Confirm the CHECK constraint rejects `(scope='project', project_id=null)`.

**Done when:** the three thoughts insert successfully (one per scope); the deliberate-violation insert returns `new row for relation "thoughts" violates check constraint`.

---

## C — `migrations/0002_rls.sql` — row-level security

### C1. Write the RLS migration

The three scopes map to three orthogonal "select" predicates, joined with `or`:

| Scope | Read predicate (informal) |
|---|---|
| `personal` | `author_user_id = auth.uid()` — only the author sees it. |
| `project` | row's `project_id` is in the set of projects where `auth.uid()` has a `project_members` row (any role). All members read. |
| `project_private` | same as `project` but only `role in ('admin','contributor')` — readers excluded. The "read-only collaborator can't see in-flight debugging" case. |

Write policies (insert/update/delete) follow the same shape, with one tightening: a user can only insert a `thought` with `author_user_id = auth.uid()` (no impersonation), and `personal` thoughts can only be written by their author. `project` and `project_private` writes require `role in ('admin','contributor')` (readers are read-only by name).

**Policies to author** (each gets an inline `comment on policy ... is '...'` so Studio's policy browser shows intent):

1. `thoughts_select` — single permissive policy, OR-branches by scope: personal (author only), project (any member), project_private (admin/contributor only). Merged into one because three separate select policies trip the "Multiple Permissive Policies" lint.
2. `thoughts_insert_self` — `with check (author_user_id = auth.uid() and (scope = 'personal' or app.is_project_writer(project_id)))`.
3. `thoughts_update_self_or_writer` — author can edit own; project writers can edit any project-scoped row in their project. WITH CHECK mirrors USING.
4. `thoughts_delete_own_or_admin` — author can delete own; project *admins* (not contributors) can delete project-scoped rows. The asymmetry vs. update is intentional.
5. `projects_select_member` — `using (app.is_project_member(id))`.
6. `projects_insert_authenticated` — `with check (created_by = auth.uid())`. Phase 1 placeholder; Phase 3 will gate on org membership.
7. `project_members_select_self_or_admin` — own membership rows + all rows for projects where caller is admin.

No explicit `service_role` policies — `service_role` has BYPASSRLS at the role level on self-hosted Supabase, so adding `for all using (...)` policies is cargo-culted noise.

Three helper functions in the `app` schema (not `public`) so they're not exposed via PostgREST's `/rest/v1/rpc/`. All `security definer`, `set search_path = ''`, `stable`. Grantable to `authenticated` only:

- `app.is_project_member(p uuid) returns boolean` — caller has any role in project p.
- `app.is_project_writer(p uuid) returns boolean` — caller is admin or contributor in project p.
- `app.is_project_admin(p uuid) returns boolean`  — caller is admin in project p.

These functions exist purely so the policy bodies stay one-liners (`is_project_member(project_id)`) and are easier to audit. Postgres inlines `stable` SQL functions into the planner so there's no perf penalty.

**Table-level grants** (the part 0001 deferred):

```sql
grant select, insert, update, delete on public.thoughts to authenticated;
grant select, insert on public.projects to authenticated;        -- update/delete admin-only via Phase 3
grant select on public.project_members to authenticated;          -- writes via service_role only in Phase 1
```

These grants are necessary but not sufficient: RLS adds the row-level filter on top. With grants but no policies, every `authenticated` query returns zero rows — that's the "deny by default" guarantee Supabase RLS provides.

**Done when:** `migrations/0002_rls.sql` exists, applies cleanly via Studio, and Studio's Authentication → Policies tab shows all 10+ policies with their comments.

### C2. Verify RLS is on for all three tables

```sql
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('thoughts','projects','project_members') and relnamespace = 'public'::regnamespace;
-- All three should show relrowsecurity=t.
```

**Done when:** all three rows show `relrowsecurity = true`.

---

### C3. Apply `0003_disable_graphql.sql`

After 0002 lands clean, paste 0003 into Studio SQL editor → Run. Single transactional `drop extension if exists pg_graphql`. Reversible at any time via `create extension pg_graphql with schema graphql`.

**Done when:**

```sql
select extname from pg_extension where extname = 'pg_graphql';
-- expect 0 rows

-- Hitting /graphql/v1 should now return a 404 (not a GraphQL error).
-- PostgREST (https://127.0.0.1:8443/rest/v1/...) and MCP paths unaffected.
```

Security Advisor should now show **0 errors, 0 warnings**. If anything else surfaces (especially anything not on lints 0026/0027/0028/0029), capture and triage before moving to D.

---

## D — `migrations/seed.sql` — pilot data

### D1. Write the seed file

Two responsibilities:

1. Insert one `projects` row for `fabric-testbed/fabric-core-api`. Use a deterministic UUID (e.g. `'00000000-0000-0000-0000-00000000c0a1'::uuid`) so the seed is re-runnable and so test fixtures elsewhere can hard-reference it.
2. Insert `project_members` rows for the pilot devs. **Phase 1 caveat:** we can only seed members whose `auth.users` row already exists — i.e., who have completed at least one GitHub OAuth login on scratch. For the smoke test that's just Michael (D7). Komal's row is added after she completes her first login (Phase 0 B1 deliverable).

The seed uses `insert ... on conflict do nothing` everywhere, so it's safe to re-run after each new pilot dev signs in.

Looking up `auth.users.id` from a GitHub username is awkward (the GitHub handle lives inside `raw_user_meta_data->>'user_name'`). The seed file uses a CTE to resolve handles → ids:

```sql
with pilot_users as (
  select id, raw_user_meta_data->>'user_name' as gh_handle
  from auth.users
  where raw_user_meta_data->>'user_name' in ('mjstealey','kthare10')
)
insert into public.project_members (project_id, user_id, role)
select '00000000-0000-0000-0000-00000000c0a1'::uuid, id,
       case when gh_handle = 'mjstealey' then 'admin' else 'contributor' end::member_role
from pilot_users
on conflict (project_id, user_id) do update set role = excluded.role;
```

(Komal's GitHub handle will need confirmation in B1 of Phase 0 — `kthare10` is a placeholder that needs to be checked against `https://github.com/kthare10` before this file is applied.)

**Done when:** `migrations/seed.sql` exists; applies cleanly; `select gh_handle, role from public.project_members pm join auth.users u on u.id = pm.user_id ...` returns at least Michael's row.

---

## E — End-to-end RLS isolation smoke test

This is the Phase 1 acceptance gate. The test proves that the schema + RLS combination actually enforces the three-scope model from the perspective of a real signed-in browser session.

### E1. Add a "thoughts CRUD" widget to the OAuth-test page

Reuse the D7 page at `~/scratch/supabase-stack/oauth-test/index.html`. Add four buttons backed by the supabase-js client (already loaded, already authenticated):

- **Insert personal thought** — `supabase.from('thoughts').insert({ content: 'personal test', scope: 'personal', author_user_id: <self> })`. Should succeed.
- **Insert project thought** — same, with `scope: 'project', project_id: <fabric-core-api-uuid>`. Should succeed for Michael (admin), fail for a non-member.
- **List my thoughts** — `supabase.from('thoughts').select('id, scope, content, project_id').order('created_at', { ascending: false }).limit(20)`. Should return only rows the current user is permitted to see.
- **Try to read someone else's personal thought by id** — `supabase.from('thoughts').select('*').eq('id', '<id-from-Studio-of-a-row-belonging-to-another-user>')`. Should return zero rows (RLS filters it out — no error, just empty).

The page already has the ANON_KEY templated in from D7; no new wiring needed beyond the four button handlers.

### E2. Run the matrix

| As | Operation | Expected | Why |
|---|---|---|---|
| Michael (admin in fabric-core-api) | Insert personal | OK | `thoughts_insert_self` |
| Michael | Insert project (fabric-core-api) | OK | `is_project_writer` true |
| Michael | List | sees own personal + own project | `thoughts_select` OR-branches |
| Michael | Read another user's personal by id | 0 rows | personal branch of `thoughts_select` filters |
| Michael | Try to insert with `author_user_id` ≠ self | denied | `with check (author_user_id = auth.uid())` |
| Non-member (a second GitHub account, sign in fresh) | Insert project (fabric-core-api) | denied | `is_project_writer` false, no member row |
| Non-member | List | 0 rows from project, only their own personals | RLS isolation |

**The non-member step is the load-bearing test.** If Michael's project thoughts show up to the non-member, RLS is broken and Phase 1 is not done.

A second GitHub account isn't strictly required if you accept lower confidence — you can simulate by manually deleting your `project_members` row in Studio, refreshing the OAuth-test page (still signed in, no re-auth needed), and confirming list now returns 0 project rows. Re-insert the row when done.

### E3. Confirm via SQL too

In Studio's SQL editor, run **as `authenticated` impersonating yourself** (Studio → "Run as" or the `set role authenticated; set request.jwt.claims = ...` pattern). The CRUD pattern over the same RLS surface should match the browser results row-for-row.

**Done when:** every row in the E2 matrix passes; the non-member denial is verified at least once with either a real second account or a manual `project_members` row deletion.

---

## F — Docs + commit

### F1. Update `docs/deployment.md` with the migration apply procedure

Add a "Phase 1 — Applying migrations on scratch" section: copy file contents into Studio SQL editor, run, verify via the queries in B2/C2/D1. Mention that `psql -U postgres` is **not** the right path on self-hosted Supabase (postgres role isn't superuser; use Studio which runs as `supabase_admin`).

**Done when:** `docs/deployment.md` has the Phase 1 apply section.

### F2. Update this checklist with applied migration hashes (optional)

After applying, record the SHA256 of each migration file at the top of this file (or in a small `migrations/applied.md`) so we know exactly what version of each file is on scratch. This becomes load-bearing the moment we have two environments (scratch + prod) and need to confirm they match.

### F3. Commit

```bash
git add migrations/ docs/phase-1-checklist.md docs/deployment.md
git commit -m "Phase 1: multi-tenant schema + RLS + pilot seed"
git push personal main
git push origin main   # if syncing canonical
```

**Done when:** commit pushed to chosen remote(s); `git status` clean.

---

## G — Phase 2 readiness gate

Before moving to Phase 2 (MCP edge function), confirm:

- [ ] `migrations/0001_init.sql` applied; B2/B3 checks pass
- [ ] `migrations/0002_rls.sql` applied; C2 confirms RLS on for all three tables; Studio Security Advisor zero issues
- [ ] `migrations/seed.sql` applied; at least Michael's `project_members` row exists for fabric-core-api
- [ ] E1–E3 RLS isolation matrix passes — non-member is verified to see zero project rows

If all four are checked, Phase 2 (port OB1's `shared-mcp` edge function to multi-tenant TeamBrain) can begin. The MCP server's job becomes: take an authenticated request, derive `auth.uid()` from the JWT, and let RLS do the rest. No application-layer authorization code needed — this is the payoff for getting Phase 1 right.

---

## Notes for the next session

- Read order on session start: `CLAUDE.md` → `docs/adr/0001-teambrain-architecture.md` → `docs/phase-0-checklist.md` (for environment context) → this file.
- All DDL is applied via Studio SQL editor on scratch (`http://127.0.0.1:3000`), not via `psql -U postgres`. The `postgres` role is not a superuser on self-hosted Supabase.
- Functions defined in this phase use `set search_path = ''` and fully qualified references (`pg_catalog.now()`, `public.is_project_member`, etc.). Studio Security Advisor will flag any that don't.
- Decisions and blockers go to Open Brain with prefix `PROJECT: TeamBrain — `.
- Do **not** apply migrations to `pr.fabric-testbed.net` until E2 passes on scratch.
