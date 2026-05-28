-- 0011_project_registration.sql — Phase 4 prerequisite: close the direct
-- project-insert path now that a gated registration edge function exists.
--
-- Apply via Studio SQL editor (or docker exec psql as supabase_admin) on
-- the target instance, after 0001-0010.
--
-- Background:
--   0002 shipped `projects_insert_authenticated` as an explicit Phase 1
--   placeholder: any authenticated user could INSERT a `projects` row so
--   long as `created_by = auth.uid()`. Its own comment flagged the intent
--   to "gate this on org membership" in a later phase. That placeholder
--   was tolerable only because the design is self-limiting — creating a
--   project does NOT grant the creator membership (RLS denies
--   `authenticated` any write on `project_members`), so a self-inserted
--   project is invisible to its own creator until a service-role path
--   seeds membership.
--
--   Phase 4 introduces `teambrain-register-project`, a service-role edge
--   function that performs the real gate: it verifies the caller is the
--   GitHub repo's admin (via the org-scoped GitHub App installation token)
--   before inserting the project, seeding the creator as `admin`, and
--   running the membership sync. With that path in place, the open
--   `authenticated` insert policy is now a bypass — it lets a user create
--   a project for a repo they do not administer. We remove it.
--
-- What this migration does:
--   * Drops `projects_insert_authenticated`. After this, `authenticated`
--     has NO insert policy on `public.projects`, so RLS denies all
--     direct inserts. `service_role` bypasses RLS and remains the only
--     writer — exercised exclusively through the register edge function,
--     which applies the repo-admin gate in application code.
--
-- What this migration does NOT do:
--   * No change to `projects_select_member` (visibility stays
--     membership-scoped), to the `project_members` policies, or to any
--     grant. `authenticated` keeps SELECT on `public.projects`; it simply
--     can no longer INSERT.
--   * No update/delete policies added — administrative project changes
--     (rename, archive) continue to go through service_role, unchanged
--     from 0002.

begin;

drop policy if exists projects_insert_authenticated on public.projects;

commit;

-- Verification (read-only, safe to re-run):
--
--   select polname, polcmd
--   from pg_policy
--   where polrelid = 'public.projects'::regclass
--   order by polname;
--
-- Expected after apply: `projects_select_member` remains; no policy with
-- polcmd = 'a' (INSERT) is present. A direct
--
--   insert into public.projects (repo_slug, name, created_by)
--   values ('owner/repo', 'x', auth.uid());
--
-- run as the `authenticated` role now fails with a row-level-security
-- violation. The same insert via `service_role` (the register function)
-- still succeeds.
